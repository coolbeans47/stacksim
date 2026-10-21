import { AWS_MANAGED_POLICY_NAMES } from "../../iam/model.js";
import { AWS_MANAGED_POLICY_PATHS } from "./generated/managed-policies.js";
import { SAM_POLICY_TEMPLATES, SAM_UNAVAILABLE_POLICY_TEMPLATES } from "./generated/policy-templates.js";
import { SamCause, cfnResource, isIntrinsic, isIntrinsicIf, isNoValue, isObject, resourceError, type JsonObject } from "./common.js";

export function awsManagedPolicyArn(name: string, partition: string): string {
  const path = AWS_MANAGED_POLICY_PATHS[name] ?? "/";
  return `arn:${partition}:iam::aws:policy${path}${name}`;
}

type PolicyType = "managed" | "statement" | "template" | "unknown";

function policyType(policy: unknown, logicalId: string): PolicyType {
  if (typeof policy === "string") return "managed";
  if (isIntrinsicIf(policy)) {
    const items = policy["Fn::If"];
    if (items.length !== 3) throw new SamCause("Structure of the SAM template is invalid. Fn::If requires 3 arguments.");
    const [, whenTrue, whenFalse] = items;
    const trueType = policyType(whenTrue, logicalId);
    const falseType = policyType(whenFalse, logicalId);
    if (trueType === falseType) return trueType;
    if (isNoValue(whenTrue)) return falseType;
    if (isNoValue(whenFalse)) return trueType;
    throw new SamCause("Structure of the SAM template is invalid. Different policy types within the same Fn::If statement is unsupported. Separate different policy types into different Fn::If statements");
  }
  if (isIntrinsic(policy)) return "managed";
  if (isObject(policy) && "Statement" in policy) return "statement";
  if (isObject(policy) && Object.keys(policy).length === 1) {
    const name = Object.keys(policy)[0];
    if (Object.hasOwn(SAM_POLICY_TEMPLATES, name)) return "template";
    if (SAM_UNAVAILABLE_POLICY_TEMPLATES.includes(name)) throw resourceError(logicalId, `Policy template '${name}' is not supported by StackSim because it targets a service StackSim does not implement.`);
  }
  return "unknown";
}

function disambiguate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(disambiguate);
  if (!isObject(value)) return value;
  const copy: JsonObject = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, disambiguate(item)]));
  if (typeof copy.Ref === "string") copy.Ref = `___SAM_POLICY_PARAMETER_${copy.Ref}`;
  return copy;
}

function substitute(value: unknown, parameters: Readonly<Record<string, unknown>>): unknown {
  if (Array.isArray(value)) return value.map(item => substitute(item, parameters));
  if (!isObject(value)) return value;
  if (Object.keys(value).length === 1 && typeof value.Ref === "string" && Object.hasOwn(parameters, value.Ref)) return parameters[value.Ref];
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, parameters)]));
}

function convertTemplate(logicalId: string, policy: JsonObject): JsonObject {
  const [name, values] = Object.entries(policy)[0];
  const template = SAM_POLICY_TEMPLATES[name];
  if (!isObject(values)) throw resourceError(logicalId, `Must specify valid parameter values for policy template '${name}'`);
  const missing = template.Parameters.filter(parameter => !Object.hasOwn(values, parameter));
  if (missing.length) throw resourceError(logicalId, `Following required parameters of template '${name}' don't have values: [${missing.map(item => `'${item}'`).join(", ")}]`);
  const prefixed = Object.fromEntries(template.Parameters.map(parameter => [`___SAM_POLICY_PARAMETER_${parameter}`, values[parameter]]));
  return substitute(disambiguate(template.Definition), prefixed) as JsonObject;
}

/** SAM's policy-templates plugin: replace templates with their statements. */
export function expandPolicyTemplates(logicalId: string, policies: unknown): unknown {
  if (policies === undefined || policies === null || policies === "" || (Array.isArray(policies) && policies.length === 0)) return policies;
  const list = Array.isArray(policies) ? policies : [policies];
  if (!list.some(policy => policyType(policy, logicalId) === "template")) return policies;
  return list.map(policy => {
    if (policyType(policy, logicalId) !== "template") return policy;
    if (isIntrinsicIf(policy)) {
      const [condition, whenTrue, whenFalse] = policy["Fn::If"];
      return { "Fn::If": [condition, isNoValue(whenTrue) ? whenTrue : convertTemplate(logicalId, whenTrue as JsonObject), isNoValue(whenFalse) ? whenFalse : convertTemplate(logicalId, whenFalse as JsonObject)] };
    }
    return convertTemplate(logicalId, policy as JsonObject);
  });
}

function managedPolicyArn(logicalId: string, name: string, partition: string): string {
  if (Object.hasOwn(AWS_MANAGED_POLICY_PATHS, name)) {
    if (!AWS_MANAGED_POLICY_NAMES.has(name)) throw resourceError(logicalId, `Managed policy '${name}' is not available in StackSim. Use a policy template, an inline policy statement, or a customer managed policy ARN instead.`);
    return awsManagedPolicyArn(name, partition);
  }
  if (name.startsWith("arn:")) return name;
  throw resourceError(logicalId, `Managed policy '${name}' is not an AWS managed policy name known to SAM and is not an ARN.`);
}

export interface RoleOptions {
  readonly logicalId: string;
  readonly roleLogicalId: string;
  readonly attributes: JsonObject;
  readonly partition: string;
  readonly assumeRolePolicyDocument: unknown;
  readonly managedPolicyArns: unknown[];
  readonly policyDocuments: unknown[];
  readonly policies: unknown;
  readonly rolePath?: unknown;
  readonly permissionsBoundary?: unknown;
  readonly tags?: unknown;
}

/** SAM's construct_role_for_resource. */
export function constructRole(options: RoleOptions): JsonObject {
  const managed = [...options.managedPolicyArns];
  const documents = [...options.policyDocuments];
  const policies = options.policies === undefined || options.policies === null ? [] : Array.isArray(options.policies) ? options.policies : [options.policies];
  policies.forEach((policy, index) => {
    const type = policyType(policy, options.logicalId);
    const policyName = `${options.roleLogicalId}Policy${index}`;
    if (type === "statement") {
      if (isIntrinsicIf(policy)) {
        const [condition, whenTrue, whenFalse] = policy["Fn::If"];
        const wrap = (value: unknown) => isNoValue(value) ? value : { PolicyName: policyName, PolicyDocument: value };
        documents.push({ "Fn::If": [condition, wrap(whenTrue), wrap(whenFalse)] });
      } else documents.push({ PolicyName: policyName, PolicyDocument: policy });
    } else if (type === "managed") {
      let arn: unknown = policy;
      if (typeof policy === "string") arn = managedPolicyArn(options.logicalId, policy, options.partition);
      else if (isIntrinsicIf(policy)) {
        const [condition, whenTrue, whenFalse] = policy["Fn::If"];
        const convert = (value: unknown) => typeof value === "string" ? managedPolicyArn(options.logicalId, value, options.partition) : value;
        arn = { "Fn::If": [condition, convert(whenTrue), convert(whenFalse)] };
      }
      if (!managed.some(existing => JSON.stringify(existing) === JSON.stringify(arn))) managed.push(arn);
    } else {
      throw resourceError(options.logicalId, `Policy at index ${index} in the 'Policies' property is not valid`);
    }
  });
  return cfnResource("AWS::IAM::Role", {
    AssumeRolePolicyDocument: options.assumeRolePolicyDocument,
    ManagedPolicyArns: managed,
    Policies: documents.length ? documents : undefined,
    Path: options.rolePath,
    PermissionsBoundary: options.permissionsBoundary,
    Tags: options.tags,
  }, options.attributes);
}

export const LAMBDA_ASSUME_ROLE_POLICY = (): JsonObject => ({
  Version: "2012-10-17",
  Statement: [{ Action: ["sts:AssumeRole"], Effect: "Allow", Principal: { Service: ["lambda.amazonaws.com"] } }],
});
