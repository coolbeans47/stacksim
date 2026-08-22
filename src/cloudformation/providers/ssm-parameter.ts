import { providerValidationPathSegments } from "./contract.js";
import { createHash } from "node:crypto";
import { AwsError } from "../../errors.js";
import type { SsmService } from "../../ssm.js";
import type { ParameterState } from "../../types.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderOperation,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";

export const SSM_PARAMETER_TYPE = "AWS::SSM::Parameter";

export const SSM_PARAMETER_CLOUDFORMATION_AUTHORIZATION_MATRIX: Readonly<Record<ProviderOperation, readonly string[]>> = Object.freeze({
  CREATE: Object.freeze(["ssm:PutParameter", "ssm:AddTagsToResource", "ssm:GetParameter", "ssm:ListTagsForResource"]),
  READ: Object.freeze(["ssm:GetParameter", "ssm:ListTagsForResource"]),
  UPDATE: Object.freeze(["ssm:PutParameter", "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource", "ssm:GetParameter", "ssm:ListTagsForResource"]),
  DELETE: Object.freeze(["ssm:GetParameter", "ssm:DeleteParameter"]),
});

export interface SsmParameterModel {
  readonly Name: string;
  readonly Type: "String" | "StringList";
  readonly Value: string;
  readonly DataType: "text";
  readonly Tier: "Standard" | "Advanced";
  readonly Policies?: string;
  readonly Description?: string;
  readonly AllowedPattern?: string;
  readonly Tags: Readonly<Record<string, string>>;
}

export const SSM_PARAMETER_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SSM_PARAMETER_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    AllowedPattern: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    DataType: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Name: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    Policies: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    Tier: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Type: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    Value: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE", sensitive: true }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Parameter name" }),
  attributes: Object.freeze({
    Arn: Object.freeze({ valueType: "string" }),
    Type: Object.freeze({ valueType: "string" }),
    Value: Object.freeze({ valueType: "string", sensitive: true }),
  }),
  replacement: Object.freeze({ defaultOrder: "DELETE_BEFORE_CREATE", deleteBeforeCreateReason: "Named SSM parameters have a unique physical name" }),
  retention: Object.freeze({
    deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    snapshotSupported: false,
  }),
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function owner(context: ProviderContext): string { return `${context.stackId}/${context.logicalId}`; }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function stackName(context: ProviderContext): string { return context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack"; }
function generatedName(context: ProviderContext): string {
  const suffix = createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex").slice(0, 12);
  const prefix = `${stackName(context)}-${context.logicalId}`.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "parameter";
  return `${prefix.slice(0, 240 - suffix.length - 1)}-${suffix}`;
}
function tags(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value) ? value : {}).map(([key, item]) => [key, String(item)]).sort(([a], [b]) => a.localeCompare(b)));
}
function model(state: ParameterState): SsmParameterModel {
  const current = state.versions[String(state.currentVersion)];
  return {
    Name: state.name,
    Type: state.type as "String" | "StringList",
    Value: current?.storageKind === "PLAIN" ? current.value ?? "" : "",
    DataType: "text",
    Tier: state.tier,
    ...(state.policies.length ? { Policies: JSON.stringify(state.policies.map(policy => ({ Type: policy.type, Version: policy.version, Attributes: policy.attributes }))) } : {}),
    ...(state.description === undefined ? {} : { Description: state.description }),
    ...(state.allowedPattern === undefined ? {} : { AllowedPattern: state.allowedPattern }),
    Tags: tags(state.tags),
  };
}
function result(state: ParameterState) {
  const properties = model(state);
  return { status: "SUCCESS" as const, physicalId: state.name, model: { physicalId: state.name, properties, attributes: { Arn: state.arn, Type: properties.Type, Value: properties.Value } } };
}
function failure(error: unknown): ProviderUpdateResult<SsmParameterModel> {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}
function issue(issues: ProviderValidationIssue[], path: string, message: string): void { issues.push({ code: "InvalidProperty", path, pathSegments: providerValidationPathSegments(path), message }); }

export function createSsmParameterProvider(ssm: SsmService): ProductionResourceProvider<SsmParameterModel> {
  return {
    typeName: SSM_PARAMETER_TYPE,
    providerVersion: 2,
    visibility: "production",
    schema: SSM_PARAMETER_SCHEMA,
    validate(properties: unknown): readonly ProviderValidationIssue[] {
      const issues = [...validateDeclaredProperties(properties ?? {}, SSM_PARAMETER_SCHEMA)];
      if (!record(properties)) return issues;
      if (!new Set(["String", "StringList"]).has(String(properties.Type))) issue(issues, "Properties.Type", "Type must be String or StringList; CloudFormation cannot create SecureString parameters");
      if (properties.DataType !== undefined && properties.DataType !== "text") issue(issues, "Properties.DataType", "Only DataType=text is supported");
      if (properties.Tier !== undefined && !new Set(["Standard", "Advanced"]).has(String(properties.Tier))) issue(issues, "Properties.Tier", "Tier must be Standard or Advanced; Intelligent-Tiering remains unsupported");
      if (properties.Policies !== undefined && properties.Tier !== "Advanced") issue(issues, "Properties.Policies", "Parameter policies require Tier=Advanced");
      if (typeof properties.Description === "string" && properties.Description.length > 1024) issue(issues, "Properties.Description", "Description cannot exceed 1024 characters");
      if (typeof properties.AllowedPattern === "string") {
        if (properties.AllowedPattern.length > 1024) issue(issues, "Properties.AllowedPattern", "AllowedPattern cannot exceed 1024 characters");
        else try { new RegExp(properties.AllowedPattern); } catch { issue(issues, "Properties.AllowedPattern", "AllowedPattern must be a valid regular expression"); }
      }
      if (record(properties.Tags)) for (const [key, value] of Object.entries(properties.Tags)) {
        if (!key || key.length > 128 || key.toLowerCase().startsWith("aws:") || typeof value !== "string" || value.length > 256) issue(issues, `Properties.Tags.${key}`, "Tags require non-reserved keys and string values within service limits");
      }
      return issues;
    },
    canonicalize(properties: unknown, context): SsmParameterModel {
      if (!record(properties)) throw new TypeError("AWS::SSM::Parameter Properties must be an object");
      const issues = this.validate(properties, context); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return {
        Name: properties.Name === undefined ? generatedName(context) : String(properties.Name),
        Type: properties.Type as "String" | "StringList",
        Value: String(properties.Value),
        DataType: "text",
        Tier: String(properties.Tier ?? "Standard") as "Standard" | "Advanced",
        ...(properties.Policies === undefined ? {} : { Policies: String(properties.Policies) }),
        ...(properties.Description === undefined ? {} : { Description: String(properties.Description) }),
        ...(properties.AllowedPattern === undefined ? {} : { AllowedPattern: String(properties.AllowedPattern) }),
        Tags: tags(properties.Tags),
      };
    },
    plan(previous, desired): ProviderPlan<SsmParameterModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const keys = [...new Set([...Object.keys(previous), ...Object.keys(desired)])] as Array<keyof SsmParameterModel>;
      const changed = keys.filter(key => !same(previous[key], desired[key])).map(String).sort();
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      if (changed.includes("Name")) return { action: "REPLACE", desired, changedProperties: changed, replacementProperties: ["Name"], replacementOrder: "DELETE_BEFORE_CREATE" };
      return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
    },
    async create(desired, context) {
      try {
        await ssm.PutParameterCloudFormation(desired, owner(context), context.principal.identity.principalArn);
        return result(ssm.readParameterCloudFormation(desired.Name)!);
      } catch (error) { return failure(error); }
    },
    async read(physicalId, context): Promise<ProviderReadResult<SsmParameterModel>> {
      try {
        const state = ssm.readParameterCloudFormation(physicalId);
        if (!state) return { status: "NOT_FOUND", physicalId };
        if (state.cloudFormationOwner !== owner(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Parameter ${physicalId} is not owned by this stack resource` };
        if (state.type === "SecureString") return { status: "FAILED", errorCode: "InvalidResourceState", message: "CloudFormation cannot own a SecureString parameter" };
        return result(state);
      } catch (error) { return failure(error) as ProviderReadResult<SsmParameterModel>; }
    },
    async update(physicalId, _previous, desired, context) {
      if (physicalId !== desired.Name) return { status: "FAILED", errorCode: "RequiresReplacement", message: "Name changes require replacement" };
      try {
        await ssm.PutParameterCloudFormation(desired, owner(context), context.principal.identity.principalArn);
        return result(ssm.readParameterCloudFormation(physicalId)!);
      } catch (error) { return failure(error); }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try { await ssm.DeleteParameterCloudFormation(physicalId, owner(context)); return { status: "SUCCESS", physicalId }; }
      catch (error) { return failure(error) as ProviderDeleteResult; }
    },
    async retain(physicalId, _previous, context): Promise<void> {
      await ssm.ReleaseParameterCloudFormation(physicalId, owner(context));
    },
    ref(read: ProviderReadModel<SsmParameterModel>): unknown { return read.physicalId; },
    getAtt(read, attribute): unknown {
      if (Object.hasOwn(read.attributes, attribute)) return read.attributes[attribute];
      throw new ProviderReferenceError(SSM_PARAMETER_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}
