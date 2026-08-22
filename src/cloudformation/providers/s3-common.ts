import { providerValidationPathSegments } from "./contract.js";
import { createHash } from "node:crypto";
import type { ProviderContext, ProviderValidationIssue } from "./contract.js";

export const S3_CLOUDFORMATION_OWNER_TAG = "stacksim:cloudformation:owner";

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
  issues.push({ code, path, pathSegments: providerValidationPathSegments(path), message });
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The prefix identifies the owning stack so a separately modelled bucket
 * policy can prove that its target belongs to the same stack. The suffix
 * keeps ownership specific to the bucket logical resource.
 */
export function s3OwnerValue(context: ProviderContext): string {
  return `${hash(context.stackId)}:${hash(`${context.stackId}\0${context.logicalId}`)}`;
}

export function s3StackOwnerPrefix(context: ProviderContext): string {
  return `${hash(context.stackId)}:`;
}

export function isS3ResourceOwner(tags: Readonly<Record<string, string>>, context: ProviderContext): boolean {
  return tags[S3_CLOUDFORMATION_OWNER_TAG] === s3OwnerValue(context);
}

export function isS3StackOwner(tags: Readonly<Record<string, string>>, context: ProviderContext): boolean {
  return tags[S3_CLOUDFORMATION_OWNER_TAG]?.startsWith(s3StackOwnerPrefix(context)) === true;
}

export function stackName(context: ProviderContext): string {
  return context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack";
}

export function generatedS3BucketName(context: ProviderContext): string {
  const suffix = hash(`${context.stackId}\0${context.logicalId}`).slice(0, 12);
  const rawPrefix = `${stackName(context)}-${context.logicalId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const prefix = (rawPrefix || "stacksim-bucket").slice(0, 63 - suffix.length - 1).replace(/-$/g, "") || "stacksim";
  return `${prefix}-${suffix}`;
}

export function validS3BucketName(name: string): boolean {
  const reservedSuffixes = ["-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3"];
  return name.length >= 3
    && name.length <= 63
    && /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)
    && !name.includes("..")
    && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)
    && !name.startsWith("xn--")
    && !name.startsWith("sthree-")
    && !name.startsWith("amzn-s3-demo-")
    && !reservedSuffixes.some(suffix => name.endsWith(suffix));
}
