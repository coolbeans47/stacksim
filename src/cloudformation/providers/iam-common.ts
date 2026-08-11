import { createHash } from "node:crypto";
import type { ProviderContext, ProviderFailed, ProviderValidationIssue } from "./contract.js";
import { AwsError } from "../../errors.js";
import { validatePolicyDocument } from "../../iam.js";
import type { IamService } from "../../iam.js";
import type { PolicyDocument } from "../../types.js";

export const IAM_NAME = /^[A-Za-z0-9_+=,.@-]+$/;
export const IAM_PATH = /^\/$|^\/[\x21-\x29\x2B-\x7E]*\/$/;
export const OWNERSHIP_STACK_TAG = "aws:cloudformation:stack-id";
export const OWNERSHIP_LOGICAL_TAG = "aws:cloudformation:logical-id";
export const OWNERSHIP_OPERATION_TAG = "aws:cloudformation:operation-id";
const OWNERSHIP_TAGS = new Set([OWNERSHIP_STACK_TAG, OWNERSHIP_LOGICAL_TAG, OWNERSHIP_OPERATION_TAG]);

export interface IamTagModel { readonly Key: string; readonly Value: string }
export interface IamInlinePolicyModel { readonly PolicyName: string; readonly PolicyDocument: PolicyDocument }

export function values<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

export function canonicalJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => canonicalJson(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonicalJson(nested)])) as T;
  }
  return value;
}

export function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

export function canonicalPolicy(value: unknown, kind: "identity" | "trust" = "identity"): PolicyDocument {
  return canonicalJson(validatePolicyDocument(value, kind));
}

export function decodePolicy(value: unknown): PolicyDocument {
  if (value && typeof value === "object") return canonicalPolicy(value);
  return canonicalPolicy(JSON.parse(decodeURIComponent(String(value))));
}

export function decodeTrust(value: unknown): PolicyDocument {
  if (value && typeof value === "object") return canonicalPolicy(value, "trust");
  return canonicalPolicy(JSON.parse(decodeURIComponent(String(value))), "trust");
}

export function canonicalStrings(value: unknown): string[] {
  return [...values<any>(value).map(String)].sort((left, right) => left.localeCompare(right));
}

export function canonicalTags(value: unknown): IamTagModel[] {
  return values<any>(value).map(tag => ({ Key: String(tag.Key), Value: String(tag.Value) })).sort((left, right) => left.Key.localeCompare(right.Key));
}

export function canonicalInlinePolicies(value: unknown): IamInlinePolicyModel[] {
  return values<any>(value).map(policy => ({ PolicyName: String(policy.PolicyName), PolicyDocument: canonicalPolicy(policy.PolicyDocument) })).sort((left, right) => left.PolicyName.localeCompare(right.PolicyName));
}

export function tagMap(value: unknown): Record<string, string> {
  return Object.fromEntries(values<any>(value).map(tag => [String(tag.Key), String(tag.Value)]));
}

export function userTags(value: unknown): IamTagModel[] {
  return canonicalTags(values<any>(value).filter(tag => !OWNERSHIP_TAGS.has(String(tag.Key))));
}

export function ownershipTags(context: ProviderContext, operation = false): IamTagModel[] {
  return [
    { Key: OWNERSHIP_STACK_TAG, Value: context.stackId },
    { Key: OWNERSHIP_LOGICAL_TAG, Value: context.logicalId },
    ...(operation ? [{ Key: OWNERSHIP_OPERATION_TAG, Value: context.idempotencyKey }] : []),
  ];
}

export function isOwned(tags: unknown, context: ProviderContext): boolean {
  const mapped = tagMap(tags);
  return mapped[OWNERSHIP_STACK_TAG] === context.stackId && mapped[OWNERSHIP_LOGICAL_TAG] === context.logicalId;
}

export function isIncompleteOperation(tags: unknown, context: ProviderContext): boolean {
  return tagMap(tags)[OWNERSHIP_OPERATION_TAG] === context.idempotencyKey;
}

export function generatedIamName(context: ProviderContext, maximumLength: number): string {
  const stack = context.stackId.match(/:stack\/([^/]+)/)?.[1] ?? "stack";
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_+=,.@-]+/g, "-").replace(/^-+|-+$/g, "") || "resource";
  const digest = createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex").slice(0, 12);
  const suffix = `-${digest}`;
  return `${clean(stack)}-${clean(context.logicalId)}`.slice(0, maximumLength - suffix.length) + suffix;
}

export function issue(code: ProviderValidationIssue["code"], path: string, message: string): ProviderValidationIssue {
  return { code, path, message };
}

export function validateName(value: unknown, path: string, maximumLength: number, issues: ProviderValidationIssue[]): void {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength || !IAM_NAME.test(value)) issues.push(issue("InvalidProperty", path, `${path} must be a valid IAM name of at most ${maximumLength} characters`));
}

export function validatePath(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (typeof value !== "string" || value.length > 512 || !IAM_PATH.test(value)) issues.push(issue("InvalidProperty", path, `${path} must be / or a printable IAM path beginning and ending with / and containing no *`));
}

export function validateStringList(value: unknown, path: string, maximumItems: number, issues: ProviderValidationIssue[], requireNonEmpty = false): void {
  if (!Array.isArray(value)) return;
  if ((requireNonEmpty && value.length === 0) || value.length > maximumItems) issues.push(issue("InvalidProperty", path, `${path} must contain ${requireNonEmpty ? "between 1 and" : "at most"} ${maximumItems} values`));
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const name = value[index];
    if (typeof name !== "string" || !IAM_NAME.test(name) || name.length > 64) issues.push(issue("InvalidProperty", `${path}[${index}]`, `${path}[${index}] must be a valid IAM role name`));
    else if (seen.has(name)) issues.push(issue("InvalidProperty", `${path}[${index}]`, `${path} contains duplicate role ${name}`));
    else seen.add(name);
  }
}

export function validateTags(value: unknown, path: string, maximumItems: number, issues: ProviderValidationIssue[]): void {
  if (!Array.isArray(value)) return;
  if (value.length > maximumItems) issues.push(issue("InvalidProperty", path, `${path} supports at most ${maximumItems} user tags`));
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const tag = value[index] as any;
    if (!tag || typeof tag !== "object" || Array.isArray(tag) || typeof tag.Key !== "string" || typeof tag.Value !== "string" || tag.Key.length < 1 || tag.Key.length > 128 || tag.Value.length > 256) {
      issues.push(issue("InvalidProperty", `${path}[${index}]`, `${path}[${index}] must contain string Key and Value within IAM tag limits`));
      continue;
    }
    if (tag.Key.toLowerCase().startsWith("aws:")) issues.push(issue("InvalidProperty", `${path}[${index}].Key`, `${path}[${index}].Key uses the reserved aws: prefix`));
    else if (seen.has(tag.Key)) issues.push(issue("InvalidProperty", `${path}[${index}].Key`, `${path} contains duplicate key ${tag.Key}`));
    else seen.add(tag.Key);
  }
}

export function validateInlinePolicies(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!Array.isArray(value)) return;
  if (value.length > 10) issues.push(issue("InvalidProperty", path, `${path} supports at most 10 inline policies`));
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const policy = value[index] as any; const itemPath = `${path}[${index}]`;
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) { issues.push(issue("InvalidProperty", itemPath, `${itemPath} must be an inline policy object`)); continue; }
    validateName(policy.PolicyName, `${itemPath}.PolicyName`, 128, issues);
    if (typeof policy.PolicyName === "string" && seen.has(policy.PolicyName)) issues.push(issue("InvalidProperty", `${itemPath}.PolicyName`, `${path} contains duplicate policy ${policy.PolicyName}`));
    else if (typeof policy.PolicyName === "string") seen.add(policy.PolicyName);
    try { canonicalPolicy(policy.PolicyDocument); }
    catch (error) { issues.push(issue("InvalidProperty", `${itemPath}.PolicyDocument`, error instanceof Error ? error.message : String(error))); }
  }
}

export function validateDocument(value: unknown, path: string, issues: ProviderValidationIssue[], kind: "identity" | "trust" = "identity"): void {
  try { canonicalPolicy(value, kind); }
  catch (error) { issues.push(issue("InvalidProperty", path, error instanceof Error ? error.message : String(error))); }
}

export function providerFailure(error: unknown): ProviderFailed {
  if (error instanceof AwsError) return { status: "FAILED", errorCode: error.code, message: error.message, ...(error.status >= 500 ? { retryable: true } : {}) };
  return { status: "FAILED", errorCode: "InternalFailure", message: error instanceof Error ? error.message : String(error), retryable: true };
}

export function isMissing(error: unknown): boolean {
  return error instanceof AwsError && error.code === "NoSuchEntity";
}

export async function allRoles(iam: IamService): Promise<any[]> {
  const roles: any[] = []; let marker: string | undefined;
  do { const page = await iam.ListRoles({ MaxItems: 1000, ...(marker ? { Marker: marker } : {}) }); roles.push(...values(page.Roles)); marker = page.IsTruncated ? page.Marker : undefined; } while (marker);
  return roles;
}

export async function allRolePolicyNames(iam: IamService, roleName: string): Promise<string[]> {
  const names: string[] = []; let marker: string | undefined;
  do { const page = await iam.ListRolePolicies({ RoleName: roleName, MaxItems: 1000, ...(marker ? { Marker: marker } : {}) }); names.push(...values<string>(page.PolicyNames)); marker = page.IsTruncated ? page.Marker : undefined; } while (marker);
  return names.sort((left, right) => left.localeCompare(right));
}

export async function allAttachedPolicyArns(iam: IamService, roleName: string): Promise<string[]> {
  const arns: string[] = []; let marker: string | undefined;
  do { const page = await iam.ListAttachedRolePolicies({ RoleName: roleName, MaxItems: 1000, ...(marker ? { Marker: marker } : {}) }); arns.push(...values<any>(page.AttachedPolicies).map(policy => String(policy.PolicyArn))); marker = page.IsTruncated ? page.Marker : undefined; } while (marker);
  return arns.sort((left, right) => left.localeCompare(right));
}

export async function allPolicyVersions(iam: IamService, policyArn: string): Promise<any[]> {
  return values((await iam.ListPolicyVersions({ PolicyArn: policyArn })).Versions);
}

export async function allLocalManagedPolicies(iam: IamService): Promise<any[]> {
  const policies: any[] = []; let marker: string | undefined;
  do { const page = await iam.ListPolicies({ Scope: "Local", MaxItems: 1000, ...(marker ? { Marker: marker } : {}) }); policies.push(...values(page.Policies)); marker = page.IsTruncated ? page.Marker : undefined; } while (marker);
  return policies;
}

export function isoDate(value: unknown): string {
  return new Date(value as any).toISOString();
}
