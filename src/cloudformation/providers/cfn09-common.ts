import { createHash } from "node:crypto";
import { AwsError } from "../../errors.js";
import type {
  ProviderContext,
  ProviderFailed,
  ProviderRetentionDeclaration,
  ProviderValidationIssue,
} from "./contract.js";

export const CFN09_OWNER_TAG = "stacksim:cloudformation:owner";
export const CFN09_OWNER_PREFIX = "stacksim:cloudformation:";

export const CFN09_RETENTION: ProviderRetentionDeclaration = Object.freeze({
  deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  snapshotSupported: false,
});

export interface Cfn09Tag {
  readonly Key: string;
  readonly Value: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stable<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stable) as T;
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    ) as T;
  }
  return value;
}

export function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function issue(
  issues: ProviderValidationIssue[],
  path: string,
  message: string,
  code: ProviderValidationIssue["code"] = "InvalidProperty",
): void {
  issues.push({ code, path, message });
}

export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ProviderValidationIssue[],
): void {
  const supported = new Set(allowed);
  for (const key of Object.keys(value).sort()) {
    if (!supported.has(key)) issue(issues, `${path}.${key}`, `${key} is not supported in ${path}`);
  }
}

export function stackName(context: ProviderContext): string {
  return context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack";
}

export function stableName(
  context: ProviderContext,
  maximum: number,
  pattern: RegExp,
  fallback: string,
): string {
  const suffix = createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex").slice(0, 12);
  const raw = `${stackName(context)}-${context.logicalId}`;
  const prefix = [...raw].map(character => pattern.test(character) ? character : "-").join("").replace(/-+/g, "-").replace(/^-|-$/g, "") || fallback;
  return `${prefix.slice(0, Math.max(1, maximum - suffix.length - 1)).replace(/-$/g, "") || fallback}-${suffix}`.slice(0, maximum);
}

export function ownerValue(context: ProviderContext): string {
  return createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex");
}

export function owns(tags: Readonly<Record<string, string>>, context: ProviderContext): boolean {
  return tags[CFN09_OWNER_TAG] === ownerValue(context);
}

export function validateTags(value: unknown, path: string, issues: ProviderValidationIssue[], maximum = 49): void {
  if (!Array.isArray(value)) return;
  if (value.length > maximum) issue(issues, path, `At most ${maximum} tags are supported because one private ownership tag is required for retry safety`);
  const keys = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const itemPath = `${path}.${index}`;
    if (!isRecord(raw)) {
      issue(issues, itemPath, "Each tag must be an object with string Key and Value");
      continue;
    }
    exactKeys(raw, ["Key", "Value"], itemPath, issues);
    if (typeof raw.Key !== "string" || typeof raw.Value !== "string") {
      issue(issues, itemPath, "Each tag requires string Key and Value");
      continue;
    }
    if (!raw.Key || [...raw.Key].length > 128 || [...raw.Value].length > 256) issue(issues, itemPath, "Tag keys must contain 1-128 characters and values at most 256 characters");
    if (raw.Key.toLowerCase().startsWith("aws:") || raw.Key.startsWith(CFN09_OWNER_PREFIX)) issue(issues, `${itemPath}.Key`, "The tag key uses a reserved prefix or CloudFormation ownership key");
    if (keys.has(raw.Key)) issue(issues, `${itemPath}.Key`, "Tag keys must be unique");
    keys.add(raw.Key);
  }
}

export function canonicalTags(value: unknown): readonly Cfn09Tag[] {
  return (Array.isArray(value) ? value : [])
    .map(item => ({ Key: String((item as Record<string, unknown>).Key), Value: String((item as Record<string, unknown>).Value) }))
    .sort((left, right) => left.Key.localeCompare(right.Key));
}

export function tagMap(tags: readonly Cfn09Tag[], context: ProviderContext): Record<string, string> {
  return {
    ...Object.fromEntries(tags.map(tag => [tag.Key, tag.Value])),
    [CFN09_OWNER_TAG]: ownerValue(context),
  };
}

export function visibleTags(tags: Readonly<Record<string, unknown>>): readonly Cfn09Tag[] {
  return Object.entries(tags)
    .filter(([key]) => key !== CFN09_OWNER_TAG)
    .map(([Key, Value]) => ({ Key, Value: String(Value) }))
    .sort((left, right) => left.Key.localeCompare(right.Key));
}

export function providerFailure(error: unknown): ProviderFailed {
  const aws = error instanceof AwsError
    ? error
    : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}

export function isNotFound(error: unknown, codes: readonly string[]): boolean {
  return error instanceof AwsError && codes.includes(error.code);
}

export function changedProperties<Model extends object>(previous: Model, desired: Model): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(desired)])]
    .filter(key => !same((previous as Record<string, unknown>)[key], (desired as Record<string, unknown>)[key]))
    .sort();
}
