import { createHash } from "node:crypto";
import { AwsError } from "../../errors.js";
import {
  ProviderReferenceError,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderSchema,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
} from "./contract.js";

export type Cfn10Object = Record<string, unknown>;
export interface Cfn10Tag { readonly Key: string; readonly Value: string }

export const CFN10_OWNER_TAG = "stacksim:cloudformation:owner";
export const CFN10_RETENTION = Object.freeze({
  deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  snapshotSupported: false,
});
export const CFN10_NO_TAGS = Object.freeze({ behavior: "NONE" as const, propagatesCloudFormationTags: false });
export const CFN10_STACK_TAGS = Object.freeze({ behavior: "STACK_AND_RESOURCE" as const, propertyName: "Tags", propagatesCloudFormationTags: true });

export function cfn10Record(value: unknown): value is Cfn10Object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function cfn10Stable<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cfn10Stable) as T;
  if (cfn10Record(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, cfn10Stable(item)])) as T;
  }
  return value;
}

export function cfn10Same(left: unknown, right: unknown): boolean {
  return JSON.stringify(cfn10Stable(left)) === JSON.stringify(cfn10Stable(right));
}

export function cfn10Issue(issues: ProviderValidationIssue[], path: string, message: string, code: ProviderValidationIssue["code"] = "InvalidProperty"): void {
  issues.push({ code, path, message });
}

export function cfn10ExactKeys(value: Cfn10Object, allowed: readonly string[], path: string, issues: ProviderValidationIssue[]): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value).sort()) {
    if (!accepted.has(key)) cfn10Issue(issues, `${path}.${key}`, `${key} is not supported in ${path}`);
  }
}

export function cfn10ThrowIssues(issues: readonly ProviderValidationIssue[]): void {
  if (issues.length) throw new TypeError(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
}

export function cfn10GeneratedName(context: ProviderContext, prefix: string, maximum: number, allowed = /[^A-Za-z0-9_.\-/#]/g): string {
  const stack = context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack";
  const suffix = createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex").slice(0, 12);
  const base = `${prefix}${stack}-${context.logicalId}`.replace(allowed, "-");
  return `${base.slice(0, Math.max(1, maximum - suffix.length - 1))}-${suffix}`;
}

export function cfn10Owner(context: ProviderContext): string {
  return createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex");
}

export function cfn10Tags(value: unknown, maximum = 49): readonly Cfn10Tag[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError("Tags must be an array");
  const result = value.map((item, index) => {
    if (!cfn10Record(item) || typeof item.Key !== "string" || typeof item.Value !== "string") throw new TypeError(`Tags[${index}] must contain string Key and Value`);
    if (!item.Key || item.Key.length > 128 || item.Value.length > 256 || item.Key.toLowerCase().startsWith("aws:") || item.Key.startsWith("stacksim:cloudformation:")) throw new TypeError(`Tags[${index}] has an invalid or reserved key/value`);
    return Object.freeze({ Key: item.Key, Value: item.Value });
  }).sort((left, right) => left.Key.localeCompare(right.Key));
  if (result.length > maximum || new Set(result.map(item => item.Key)).size !== result.length) throw new TypeError(`Tags must contain at most ${maximum} unique entries`);
  return Object.freeze(result);
}

export function cfn10TagMap(value: readonly Cfn10Tag[], context: ProviderContext): Record<string, string> {
  return { ...Object.fromEntries(value.map(tag => [tag.Key, tag.Value])), [CFN10_OWNER_TAG]: cfn10Owner(context) };
}

export function cfn10ServiceTags(value: readonly Cfn10Tag[], context: ProviderContext): Array<{ Key: string; Value: string }> {
  return Object.entries(cfn10TagMap(value, context)).sort(([left], [right]) => left.localeCompare(right)).map(([Key, Value]) => ({ Key, Value }));
}

export function cfn10UserTags(value: Record<string, string> | readonly { Key?: unknown; Value?: unknown }[] | undefined): readonly Cfn10Tag[] {
  const entries = Array.isArray(value)
    ? value.map(item => [String(item.Key ?? ""), String(item.Value ?? "")] as const)
    : Object.entries(value ?? {});
  return Object.freeze(entries.filter(([key]) => key !== CFN10_OWNER_TAG).map(([Key, Value]) => Object.freeze({ Key, Value })).sort((left, right) => left.Key.localeCompare(right.Key)));
}

export function cfn10Owned(value: Record<string, string> | readonly { Key?: unknown; Value?: unknown }[] | undefined, context: ProviderContext): boolean {
  const entries = Array.isArray(value) ? value.map(item => [String(item.Key ?? ""), String(item.Value ?? "")] as const) : Object.entries(value ?? {});
  return Object.fromEntries(entries)[CFN10_OWNER_TAG] === cfn10Owner(context);
}

export function cfn10Physical(kind: string, parts: readonly string[]): string {
  return `${kind}:${Buffer.from(JSON.stringify(parts)).toString("base64url")}`;
}

export function cfn10ParsePhysical(physicalId: string, kind: string, count: number): string[] {
  if (!physicalId.startsWith(`${kind}:`)) throw new AwsError("InvalidPhysicalResourceId", `Physical resource ID does not identify a ${kind} resource`);
  try {
    const values = JSON.parse(Buffer.from(physicalId.slice(kind.length + 1), "base64url").toString("utf8"));
    if (!Array.isArray(values) || values.length !== count || values.some(value => typeof value !== "string" || !value)) throw new Error();
    return values;
  } catch (error) {
    if (error instanceof AwsError) throw error;
    throw new AwsError("InvalidPhysicalResourceId", `Physical resource ID does not identify a ${kind} resource`);
  }
}

export function cfn10Plan<Model extends Cfn10Object>(previous: Model | undefined, desired: Model, schema: ProviderSchema): ProviderPlan<Model> {
  if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
  const keys = [...new Set([...Object.keys(previous), ...Object.keys(desired)])].sort();
  const changed = keys.filter(key => !cfn10Same(previous[key], desired[key]));
  if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
  const replacements = changed.filter(key => schema.properties[key]?.updateBehavior === "REPLACEMENT");
  return replacements.length
    ? { action: "REPLACE", desired, changedProperties: changed, replacementProperties: replacements, replacementOrder: schema.replacement.defaultOrder }
    : { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
}

export function cfn10Failure<Model = unknown>(error: unknown): ProviderUpdateResult<Model> {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}

export function cfn10Missing(error: unknown): boolean {
  return error instanceof AwsError && ["ResourceNotFound", "ResourceNotFoundException"].includes(error.code);
}

export function cfn10GetAtt<Model>(typeName: string, schema: ProviderSchema, model: ProviderReadModel<Model>, attribute: string): unknown {
  if (!Object.hasOwn(schema.attributes, attribute)) throw new ProviderReferenceError(typeName, `Fn::GetAtt ${attribute}`);
  return model.attributes[attribute];
}

export function cfn10DeleteFailure(error: unknown): ProviderDeleteResult {
  return cfn10Failure(error) as ProviderDeleteResult;
}
