import { createHash } from "node:crypto";
import { CloudFrontService, type CloudFrontInternalOwner } from "../../cloudfront.js";
import { CACHING_DISABLED_ID, CACHING_OPTIMIZED_ID, canonical } from "../../cloudfront/model.js";
import { CloudFrontError } from "../../cloudfront/protocol.js";
import type {
  CloudFrontDistributionState,
  CloudFrontFunctionState,
  CloudFrontOriginAccessControlState,
  CloudFrontResourceOwnerState,
  CloudFrontResponseHeadersPolicyState,
} from "../../types.js";
import {
  ProviderReferenceError,
  providerValidationIssue,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";

export const CLOUDFRONT_DISTRIBUTION_TYPE = "AWS::CloudFront::Distribution";
export const CLOUDFRONT_FUNCTION_TYPE = "AWS::CloudFront::Function";
export const CLOUDFRONT_ORIGIN_ACCESS_CONTROL_TYPE = "AWS::CloudFront::OriginAccessControl";
export const CLOUDFRONT_RESPONSE_HEADERS_POLICY_TYPE = "AWS::CloudFront::ResponseHeadersPolicy";

export const CLOUDFRONT_CLOUDFORMATION_RESOURCE_TYPES = Object.freeze([
  CLOUDFRONT_DISTRIBUTION_TYPE,
  CLOUDFRONT_FUNCTION_TYPE,
  CLOUDFRONT_ORIGIN_ACCESS_CONTROL_TYPE,
  CLOUDFRONT_RESPONSE_HEADERS_POLICY_TYPE,
] as const);

const RETENTION = Object.freeze({
  deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  snapshotSupported: false,
});

export const CLOUDFRONT_DISTRIBUTION_SCHEMA: ProviderSchema = Object.freeze({
  typeName: CLOUDFRONT_DISTRIBUTION_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    DistributionConfig: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Distribution ID" }),
  attributes: Object.freeze({
    Id: Object.freeze({ valueType: "string" }),
    DomainName: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

export const CLOUDFRONT_FUNCTION_SCHEMA: ProviderSchema = Object.freeze({
  typeName: CLOUDFRONT_FUNCTION_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    AutoPublish: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
    FunctionCode: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE", sensitive: true }),
    FunctionConfig: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    Name: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Function ARN" }),
  attributes: Object.freeze({
    FunctionARN: Object.freeze({ valueType: "string" }),
    "FunctionMetadata.FunctionARN": Object.freeze({ valueType: "string" }),
    Stage: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

export const CLOUDFRONT_ORIGIN_ACCESS_CONTROL_SCHEMA: ProviderSchema = Object.freeze({
  typeName: CLOUDFRONT_ORIGIN_ACCESS_CONTROL_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    OriginAccessControlConfig: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Origin access control ID" }),
  attributes: Object.freeze({ Id: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

export const CLOUDFRONT_RESPONSE_HEADERS_POLICY_SCHEMA: ProviderSchema = Object.freeze({
  typeName: CLOUDFRONT_RESPONSE_HEADERS_POLICY_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ResponseHeadersPolicyConfig: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Response headers policy ID" }),
  attributes: Object.freeze({
    Id: Object.freeze({ valueType: "string" }),
    LastModifiedTime: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

type JsonObject = Record<string, any>;
export interface CloudFrontDistributionModel { readonly DistributionConfig: JsonObject; readonly Tags: readonly CloudFrontTag[] }
export interface CloudFrontFunctionModel { readonly Name: string; readonly FunctionCode: string; readonly FunctionConfig: { readonly Comment: string; readonly Runtime: "cloudfront-js-1.0" }; readonly AutoPublish: boolean; readonly Tags: readonly CloudFrontTag[] }
export interface CloudFrontOriginAccessControlModel { readonly OriginAccessControlConfig: { readonly Name: string; readonly Description: string; readonly OriginAccessControlOriginType: "s3"; readonly SigningBehavior: "always"; readonly SigningProtocol: "sigv4" } }
export interface CloudFrontResponseHeadersPolicyModel { readonly ResponseHeadersPolicyConfig: { readonly Name: string; readonly Comment: string; readonly SecurityHeadersConfig: JsonObject } }
interface CloudFrontTag { readonly Key: string; readonly Value: string }

function record(value: unknown): value is JsonObject { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function stable<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stable) as T;
  if (record(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) as T;
  return value;
}
function owner(context: ProviderContext): CloudFrontInternalOwner { return { stackId: context.stackId, logicalId: context.logicalId, resourceOperationId: context.resourceOperationId }; }
function owned(value: CloudFrontResourceOwnerState | undefined, context: ProviderContext): boolean { return value?.stackId === context.stackId && value.logicalId === context.logicalId; }
function issue(issues: ProviderValidationIssue[], code: ProviderValidationIssue["code"], path: string, message: string): void {
  issues.push(providerValidationIssue(code, path, path.replace(/\[(\d+)\]/g, ".$1").split("."), message));
}
function rejectUnknown(issues: ProviderValidationIssue[], value: JsonObject, path: string, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value).sort()) if (!accepted.has(key)) issue(issues, "UnsupportedProperty", `${path}.${key}`, `${key} is not supported in ${path}`);
}
function required(issues: ProviderValidationIssue[], value: JsonObject, path: string, names: readonly string[]): void {
  for (const name of names) if (!Object.hasOwn(value, name)) issue(issues, "MissingRequiredProperty", `${path}.${name}`, `${path} requires property ${name}`);
}
function objectValue(issues: ProviderValidationIssue[], value: unknown, path: string): JsonObject | undefined {
  if (record(value)) return value;
  issue(issues, "InvalidType", path, `${path} must be an object`);
  return undefined;
}
function arrayValue(issues: ProviderValidationIssue[], value: unknown, path: string): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  issue(issues, "InvalidType", path, `${path} must be an array`);
  return undefined;
}
function canonicalTags(value: unknown, issues?: ProviderValidationIssue[], path = "Properties.Tags"): readonly CloudFrontTag[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { if (issues) issue(issues, "InvalidType", path, "Tags must be an array"); return []; }
  const result: CloudFrontTag[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!record(entry)) { if (issues) issue(issues, "InvalidType", entryPath, "Each tag must be an object"); return; }
    if (issues) rejectUnknown(issues, entry, entryPath, ["Key", "Value"]);
    if (typeof entry.Key !== "string" || !entry.Key || entry.Key.length > 128 || entry.Key.toLowerCase().startsWith("aws:")) { if (issues) issue(issues, "InvalidProperty", `${entryPath}.Key`, "Tag Key must be a non-reserved string of at most 128 characters"); return; }
    if (typeof entry.Value !== "string" || entry.Value.length > 256) { if (issues) issue(issues, "InvalidProperty", `${entryPath}.Value`, "Tag Value must be a string of at most 256 characters"); return; }
    result.push({ Key: entry.Key, Value: entry.Value });
  });
  if (issues && result.length > 50) issue(issues, "InvalidProperty", path, "CloudFront accepts at most 50 tags");
  if (issues && new Set(result.map(tag => tag.Key)).size !== result.length) issue(issues, "InvalidProperty", path, "CloudFront tag keys must be unique");
  return result.sort((a, b) => a.Key.localeCompare(b.Key));
}
function tagMap(value: readonly CloudFrontTag[]): Record<string, string> { return Object.fromEntries(value.map(tag => [tag.Key, tag.Value])); }
function tagsFromMap(value: Record<string, string>): readonly CloudFrontTag[] { return Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([Key, Value]) => ({ Key, Value })); }

function validation(properties: unknown, schema: ProviderSchema, nested: (value: JsonObject, issues: ProviderValidationIssue[]) => void): readonly ProviderValidationIssue[] {
  const issues = [...validateDeclaredProperties(properties ?? {}, schema)];
  if (record(properties)) nested(properties, issues);
  return issues;
}
function throwIssues(issues: readonly ProviderValidationIssue[]): void { if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; ")); }
function plan<Model extends object>(previous: Model | undefined, desired: Model, replacements: readonly string[] = []): ProviderPlan<Model> {
  if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
  const changed = [...new Set([...Object.keys(previous), ...Object.keys(desired)])].filter(key => !same((previous as any)[key], (desired as any)[key])).sort();
  if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
  const replaced = changed.filter(key => replacements.includes(key));
  return replaced.length
    ? { action: "REPLACE", desired, changedProperties: changed, replacementProperties: replaced, replacementOrder: "CREATE_BEFORE_DELETE" }
    : { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
}
function failure(error: unknown, physicalId?: string): ProviderUpdateResult<any> {
  const modeled = error instanceof CloudFrontError ? error : new CloudFrontError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: modeled.code, message: modeled.message, retryable: modeled.status >= 500, ...(physicalId ? { physicalId } : {}) };
}
function notFound(error: unknown, codes: readonly string[]): boolean { return error instanceof CloudFrontError && codes.includes(error.code); }
function ownershipFailure(kind: string, id: string) { return { status: "FAILED" as const, errorCode: "OwnershipConflict", message: `${kind} ${id} is not owned by this stack resource` }; }
function apiDate(value: number): string { return new Date(value).toISOString(); }

function functionIssues(properties: JsonObject, issues: ProviderValidationIssue[]): void {
  if (typeof properties.Name === "string" && !/^[A-Za-z0-9_-]{1,64}$/.test(properties.Name)) issue(issues, "InvalidProperty", "Properties.Name", "Name must match [A-Za-z0-9_-] and contain at most 64 characters");
  if (typeof properties.FunctionCode === "string" && Buffer.byteLength(properties.FunctionCode) > 10 * 1024) issue(issues, "InvalidProperty", "Properties.FunctionCode", "FunctionCode cannot exceed 10 KiB as UTF-8");
  const config = properties.FunctionConfig === undefined ? undefined : objectValue(issues, properties.FunctionConfig, "Properties.FunctionConfig");
  if (config) {
    rejectUnknown(issues, config, "Properties.FunctionConfig", ["Comment", "Runtime"]); required(issues, config, "Properties.FunctionConfig", ["Runtime"]);
    if (config.Runtime !== "cloudfront-js-1.0") issue(issues, "InvalidProperty", "Properties.FunctionConfig.Runtime", "CFR-01 supports only cloudfront-js-1.0");
    if (config.Comment !== undefined && (typeof config.Comment !== "string" || config.Comment.length > 128)) issue(issues, "InvalidProperty", "Properties.FunctionConfig.Comment", "Comment must be a string of at most 128 characters");
  }
  canonicalTags(properties.Tags, issues);
}

function oacIssues(properties: JsonObject, issues: ProviderValidationIssue[]): void {
  const config = properties.OriginAccessControlConfig === undefined ? undefined : objectValue(issues, properties.OriginAccessControlConfig, "Properties.OriginAccessControlConfig");
  if (!config) return;
  rejectUnknown(issues, config, "Properties.OriginAccessControlConfig", ["Description", "Name", "OriginAccessControlOriginType", "SigningBehavior", "SigningProtocol"]);
  required(issues, config, "Properties.OriginAccessControlConfig", ["Name", "OriginAccessControlOriginType", "SigningBehavior", "SigningProtocol"]);
  if (typeof config.Name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(config.Name)) issue(issues, "InvalidProperty", "Properties.OriginAccessControlConfig.Name", "Name must match [A-Za-z0-9_-] and contain at most 64 characters");
  if (config.Description !== undefined && (typeof config.Description !== "string" || config.Description.length > 256)) issue(issues, "InvalidProperty", "Properties.OriginAccessControlConfig.Description", "Description must be a string of at most 256 characters");
  if (config.OriginAccessControlOriginType !== "s3") issue(issues, "InvalidProperty", "Properties.OriginAccessControlConfig.OriginAccessControlOriginType", "CFR-01 requires s3");
  if (config.SigningBehavior !== "always") issue(issues, "InvalidProperty", "Properties.OriginAccessControlConfig.SigningBehavior", "CFR-01 requires always");
  if (config.SigningProtocol !== "sigv4") issue(issues, "InvalidProperty", "Properties.OriginAccessControlConfig.SigningProtocol", "CFR-01 requires sigv4");
}

function responsePolicyIssues(properties: JsonObject, issues: ProviderValidationIssue[]): void {
  const config = properties.ResponseHeadersPolicyConfig === undefined ? undefined : objectValue(issues, properties.ResponseHeadersPolicyConfig, "Properties.ResponseHeadersPolicyConfig");
  if (!config) return;
  const root = "Properties.ResponseHeadersPolicyConfig";
  rejectUnknown(issues, config, root, ["Comment", "Name", "SecurityHeadersConfig"]); required(issues, config, root, ["Name", "SecurityHeadersConfig"]);
  if (typeof config.Name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(config.Name)) issue(issues, "InvalidProperty", `${root}.Name`, "Name must match [A-Za-z0-9_-] and contain at most 128 characters");
  if (config.Comment !== undefined && (typeof config.Comment !== "string" || config.Comment.length > 128)) issue(issues, "InvalidProperty", `${root}.Comment`, "Comment must be a string of at most 128 characters");
  const security = objectValue(issues, config.SecurityHeadersConfig, `${root}.SecurityHeadersConfig`); if (!security) return;
  const securityPath = `${root}.SecurityHeadersConfig`;
  const headers = ["ContentSecurityPolicy", "ContentTypeOptions", "FrameOptions", "ReferrerPolicy", "StrictTransportSecurity"];
  rejectUnknown(issues, security, securityPath, headers); required(issues, security, securityPath, headers);
  const shapes: Array<[string, readonly string[], readonly string[]]> = [
    ["ContentSecurityPolicy", ["ContentSecurityPolicy", "Override"], ["ContentSecurityPolicy", "Override"]],
    ["ContentTypeOptions", ["Override"], ["Override"]],
    ["FrameOptions", ["FrameOption", "Override"], ["FrameOption", "Override"]],
    ["ReferrerPolicy", ["Override", "ReferrerPolicy"], ["Override", "ReferrerPolicy"]],
    ["StrictTransportSecurity", ["AccessControlMaxAgeSec", "IncludeSubdomains", "Override", "Preload"], ["AccessControlMaxAgeSec", "IncludeSubdomains", "Override", "Preload"]],
  ];
  for (const [name, allowed, needed] of shapes) {
    if (security[name] === undefined) continue;
    const item = objectValue(issues, security[name], `${securityPath}.${name}`); if (!item) continue;
    rejectUnknown(issues, item, `${securityPath}.${name}`, allowed); required(issues, item, `${securityPath}.${name}`, needed);
    if (item.Override !== true) issue(issues, "InvalidProperty", `${securityPath}.${name}.Override`, "CFR-01 requires Override=true");
  }
  if (record(security.ContentSecurityPolicy) && (typeof security.ContentSecurityPolicy.ContentSecurityPolicy !== "string" || !security.ContentSecurityPolicy.ContentSecurityPolicy)) issue(issues, "InvalidProperty", `${securityPath}.ContentSecurityPolicy.ContentSecurityPolicy`, "ContentSecurityPolicy must be a nonempty string");
  if (record(security.FrameOptions) && security.FrameOptions.FrameOption !== "DENY") issue(issues, "InvalidProperty", `${securityPath}.FrameOptions.FrameOption`, "CFR-01 requires DENY");
  if (record(security.ReferrerPolicy) && security.ReferrerPolicy.ReferrerPolicy !== "strict-origin-when-cross-origin") issue(issues, "InvalidProperty", `${securityPath}.ReferrerPolicy.ReferrerPolicy`, "CFR-01 requires strict-origin-when-cross-origin");
  if (record(security.StrictTransportSecurity)) {
    const hsts = security.StrictTransportSecurity;
    if (hsts.AccessControlMaxAgeSec !== 31_536_000) issue(issues, "InvalidProperty", `${securityPath}.StrictTransportSecurity.AccessControlMaxAgeSec`, "CFR-01 requires 31536000 seconds");
    if (hsts.IncludeSubdomains !== true || hsts.Preload !== true) issue(issues, "InvalidProperty", `${securityPath}.StrictTransportSecurity`, "CFR-01 requires IncludeSubdomains=true and Preload=true");
  }
}

const BEHAVIOR_KEYS = ["AllowedMethods", "CachePolicyId", "Compress", "FunctionAssociations", "PathPattern", "ResponseHeadersPolicyId", "TargetOriginId", "ViewerProtocolPolicy"] as const;
function behaviorIssues(value: unknown, path: string, issues: ProviderValidationIssue[], kind: "default" | "ordered", context: ProviderContext): void {
  const behavior = objectValue(issues, value, path); if (!behavior) return;
  const allowed = kind === "default" ? BEHAVIOR_KEYS.filter(key => key !== "PathPattern") : BEHAVIOR_KEYS.filter(key => key !== "FunctionAssociations");
  rejectUnknown(issues, behavior, path, allowed); required(issues, behavior, path, kind === "default"
    ? ["CachePolicyId", "Compress", "FunctionAssociations", "ResponseHeadersPolicyId", "TargetOriginId", "ViewerProtocolPolicy"]
    : ["CachePolicyId", "Compress", "PathPattern", "ResponseHeadersPolicyId", "TargetOriginId", "ViewerProtocolPolicy"]);
  if (![CACHING_DISABLED_ID, CACHING_OPTIMIZED_ID].includes(String(behavior.CachePolicyId))) issue(issues, "InvalidProperty", `${path}.CachePolicyId`, "Only the CFR-01 managed cache policy IDs are supported");
  if (behavior.Compress !== true) issue(issues, "InvalidProperty", `${path}.Compress`, "CFR-01 requires Compress=true");
  if (behavior.ViewerProtocolPolicy !== "redirect-to-https") issue(issues, "InvalidProperty", `${path}.ViewerProtocolPolicy`, "CFR-01 requires redirect-to-https");
  if (typeof behavior.TargetOriginId !== "string" || !behavior.TargetOriginId) issue(issues, "InvalidProperty", `${path}.TargetOriginId`, "TargetOriginId must be a nonempty string");
  if (typeof behavior.ResponseHeadersPolicyId !== "string" || !behavior.ResponseHeadersPolicyId) issue(issues, "InvalidProperty", `${path}.ResponseHeadersPolicyId`, "ResponseHeadersPolicyId must be a nonempty string");
  if (behavior.AllowedMethods !== undefined) {
    const methods = arrayValue(issues, behavior.AllowedMethods, `${path}.AllowedMethods`);
    if (methods && (!same(methods, ["GET", "HEAD"]) && !same(methods, ["GET", "HEAD", "OPTIONS"]))) issue(issues, "InvalidProperty", `${path}.AllowedMethods`, "AllowedMethods must be GET/HEAD or GET/HEAD/OPTIONS in order");
  }
  if (kind === "default") {
    const associations = arrayValue(issues, behavior.FunctionAssociations, `${path}.FunctionAssociations`);
    if (associations && associations.length !== 1) issue(issues, "InvalidProperty", `${path}.FunctionAssociations`, "CFR-01 requires exactly one viewer-request Function association");
    associations?.forEach((entry, index) => {
      const association = objectValue(issues, entry, `${path}.FunctionAssociations[${index}]`); if (!association) return;
      rejectUnknown(issues, association, `${path}.FunctionAssociations[${index}]`, ["EventType", "FunctionARN"]); required(issues, association, `${path}.FunctionAssociations[${index}]`, ["EventType", "FunctionARN"]);
      if (association.EventType !== "viewer-request") issue(issues, "InvalidProperty", `${path}.FunctionAssociations[${index}].EventType`, "CFR-01 supports only viewer-request");
      const arn = typeof association.FunctionARN === "string" ? association.FunctionARN.match(/^arn:([^:]+):cloudfront::(\d{12}):function\/.+$/) : undefined;
      if (!arn || arn[1] !== context.partition || arn[2] !== context.accountId) issue(issues, "InvalidProperty", `${path}.FunctionAssociations[${index}].FunctionARN`, "FunctionARN must identify a Function in the stack account");
    });
  }
}

function distributionIssues(properties: JsonObject, issues: ProviderValidationIssue[], context: ProviderContext): void {
  canonicalTags(properties.Tags, issues);
  const config = properties.DistributionConfig === undefined ? undefined : objectValue(issues, properties.DistributionConfig, "Properties.DistributionConfig"); if (!config) return;
  const path = "Properties.DistributionConfig";
  const keys = ["CacheBehaviors", "DefaultCacheBehavior", "DefaultRootObject", "Enabled", "HttpVersion", "IPV6Enabled", "Origins"];
  rejectUnknown(issues, config, path, keys); required(issues, config, path, keys);
  if (config.DefaultRootObject !== "index.html") issue(issues, "InvalidProperty", `${path}.DefaultRootObject`, "CFR-01 requires index.html");
  if (config.Enabled !== true && config.Enabled !== false) issue(issues, "InvalidProperty", `${path}.Enabled`, "Enabled must be boolean");
  if (config.HttpVersion !== "http2and3") issue(issues, "InvalidProperty", `${path}.HttpVersion`, "CFR-01 requires http2and3");
  if (config.IPV6Enabled !== true) issue(issues, "InvalidProperty", `${path}.IPV6Enabled`, "CFR-01 requires IPV6Enabled=true");
  const origins = arrayValue(issues, config.Origins, `${path}.Origins`);
  if (origins && origins.length !== 1) issue(issues, "InvalidProperty", `${path}.Origins`, "CFR-01 requires exactly one S3 origin");
  origins?.forEach((entry, index) => {
    const originPath = `${path}.Origins[${index}]`; const origin = objectValue(issues, entry, originPath); if (!origin) return;
    rejectUnknown(issues, origin, originPath, ["DomainName", "Id", "OriginAccessControlId", "S3OriginConfig"]); required(issues, origin, originPath, ["DomainName", "Id", "OriginAccessControlId", "S3OriginConfig"]);
    if (typeof origin.DomainName !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\.s3[.-][a-z]{2}(?:-gov)?-[a-z]+-\d\.amazonaws\.com$/i.test(origin.DomainName)) issue(issues, "InvalidProperty", `${originPath}.DomainName`, "DomainName must be a regional S3 domain");
    if (typeof origin.Id !== "string" || !origin.Id) issue(issues, "InvalidProperty", `${originPath}.Id`, "Id must be a nonempty string");
    if (typeof origin.OriginAccessControlId !== "string" || !origin.OriginAccessControlId) issue(issues, "InvalidProperty", `${originPath}.OriginAccessControlId`, "OriginAccessControlId must be a nonempty string");
    const s3 = objectValue(issues, origin.S3OriginConfig, `${originPath}.S3OriginConfig`); if (s3) { rejectUnknown(issues, s3, `${originPath}.S3OriginConfig`, ["OriginAccessIdentity"]); required(issues, s3, `${originPath}.S3OriginConfig`, ["OriginAccessIdentity"]); if (s3.OriginAccessIdentity !== "") issue(issues, "InvalidProperty", `${originPath}.S3OriginConfig.OriginAccessIdentity`, "OAC requires an empty OriginAccessIdentity"); }
  });
  behaviorIssues(config.DefaultCacheBehavior, `${path}.DefaultCacheBehavior`, issues, "default", context);
  const behaviors = arrayValue(issues, config.CacheBehaviors, `${path}.CacheBehaviors`);
  if (behaviors && (behaviors.length !== 2 || !record(behaviors[0]) || behaviors[0].PathPattern !== "assets/*" || !record(behaviors[1]) || behaviors[1].PathPattern !== "runtime-config.json")) issue(issues, "InvalidProperty", `${path}.CacheBehaviors`, "CFR-01 requires ordered assets/* and runtime-config.json behaviors");
  behaviors?.forEach((entry, index) => behaviorIssues(entry, `${path}.CacheBehaviors[${index}]`, issues, "ordered", context));
  const defaultBehavior = record(config.DefaultCacheBehavior) ? config.DefaultCacheBehavior : undefined;
  const assetsBehavior = behaviors && record(behaviors[0]) ? behaviors[0] : undefined;
  const runtimeBehavior = behaviors && record(behaviors[1]) ? behaviors[1] : undefined;
  if (defaultBehavior && defaultBehavior.CachePolicyId !== CACHING_DISABLED_ID) issue(issues, "InvalidProperty", `${path}.DefaultCacheBehavior.CachePolicyId`, "The CFR-01 default behavior requires CachingDisabled");
  if (assetsBehavior && assetsBehavior.CachePolicyId !== CACHING_OPTIMIZED_ID) issue(issues, "InvalidProperty", `${path}.CacheBehaviors[0].CachePolicyId`, "The assets/* behavior requires CachingOptimized");
  if (runtimeBehavior && runtimeBehavior.CachePolicyId !== CACHING_DISABLED_ID) issue(issues, "InvalidProperty", `${path}.CacheBehaviors[1].CachePolicyId`, "The runtime-config.json behavior requires CachingDisabled");
  if (defaultBehavior && !same(defaultBehavior.AllowedMethods ?? ["GET", "HEAD"], ["GET", "HEAD", "OPTIONS"])) issue(issues, "InvalidProperty", `${path}.DefaultCacheBehavior.AllowedMethods`, "The CFR-01 default behavior requires GET/HEAD/OPTIONS");
  if (assetsBehavior && !same(assetsBehavior.AllowedMethods ?? ["GET", "HEAD"], ["GET", "HEAD", "OPTIONS"])) issue(issues, "InvalidProperty", `${path}.CacheBehaviors[0].AllowedMethods`, "The assets/* behavior requires GET/HEAD/OPTIONS");
  if (runtimeBehavior && !same(runtimeBehavior.AllowedMethods ?? ["GET", "HEAD"], ["GET", "HEAD"])) issue(issues, "InvalidProperty", `${path}.CacheBehaviors[1].AllowedMethods`, "The runtime-config.json behavior requires GET/HEAD");
  if (defaultBehavior && assetsBehavior && runtimeBehavior && (defaultBehavior.ResponseHeadersPolicyId !== assetsBehavior.ResponseHeadersPolicyId || defaultBehavior.ResponseHeadersPolicyId !== runtimeBehavior.ResponseHeadersPolicyId)) issue(issues, "InvalidProperty", `${path}.CacheBehaviors`, "All CFR-01 behaviors must reference the same response headers policy");
  if (origins?.length === 1 && record(origins[0])) {
    const originId = origins[0].Id;
    const all = [config.DefaultCacheBehavior, ...(behaviors ?? [])];
    all.forEach((behavior, index) => { if (record(behavior) && behavior.TargetOriginId !== originId) issue(issues, "InvalidProperty", index === 0 ? `${path}.DefaultCacheBehavior.TargetOriginId` : `${path}.CacheBehaviors[${index - 1}].TargetOriginId`, "TargetOriginId must match the sole origin Id"); });
  }
}

function list(value: readonly unknown[], member: string): JsonObject { return { Quantity: value.length, ...(value.length ? { Items: { [member]: [...value] } } : {}) }; }
function apiItems(value: unknown, member: string): any[] {
  if (Array.isArray(value)) return value;
  if (!record(value)) return [];
  const nested = record(value.Items) ? value.Items[member] : undefined;
  if (Array.isArray(nested)) return nested;
  if (nested !== undefined) return [nested];
  const direct = value[member];
  return Array.isArray(direct) ? direct : direct === undefined ? [] : [direct];
}
function apiBehavior(value: JsonObject): JsonObject {
  const methods = value.AllowedMethods as string[];
  const associations = (value.FunctionAssociations ?? []) as JsonObject[];
  return {
    TargetOriginId: value.TargetOriginId,
    ViewerProtocolPolicy: value.ViewerProtocolPolicy,
    AllowedMethods: { ...list(methods, "Method"), CachedMethods: list(methods.filter(method => method === "GET" || method === "HEAD"), "Method") },
    SmoothStreaming: false,
    Compress: value.Compress,
    LambdaFunctionAssociations: list([], "LambdaFunctionAssociation"),
    FunctionAssociations: list(associations, "FunctionAssociation"),
    FieldLevelEncryptionId: "",
    CachePolicyId: value.CachePolicyId,
    ResponseHeadersPolicyId: value.ResponseHeadersPolicyId,
    TrustedSigners: { Enabled: false, ...list([], "AwsAccountNumber") },
    TrustedKeyGroups: { Enabled: false, ...list([], "KeyGroup") },
    ...(value.PathPattern === undefined ? {} : { PathPattern: value.PathPattern }),
  };
}
function cfnBehavior(value: JsonObject, ordered: boolean): JsonObject {
  const methods = apiItems(value.AllowedMethods, "Method").map(String);
  const associations = apiItems(value.FunctionAssociations, "FunctionAssociation").map(entry => ({ EventType: entry.EventType, FunctionARN: entry.FunctionARN }));
  return {
    AllowedMethods: methods.length ? methods : ["GET", "HEAD"],
    CachePolicyId: String(value.CachePolicyId),
    Compress: value.Compress === true,
    ...(ordered ? { PathPattern: String(value.PathPattern) } : { FunctionAssociations: associations }),
    ResponseHeadersPolicyId: String(value.ResponseHeadersPolicyId),
    TargetOriginId: String(value.TargetOriginId),
    ViewerProtocolPolicy: String(value.ViewerProtocolPolicy),
  };
}
function callerReference(context: ProviderContext): string { return `stacksim-cfn-${createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex")}`; }
function toApiDistribution(model: CloudFrontDistributionModel, context?: ProviderContext, existingCallerReference?: string): JsonObject {
  const value = model.DistributionConfig; const origins = value.Origins as JsonObject[]; const behaviors = value.CacheBehaviors as JsonObject[];
  return {
    CallerReference: existingCallerReference ?? callerReference(context!),
    Aliases: list([], "CNAME"),
    DefaultRootObject: value.DefaultRootObject,
    Origins: list(origins.map(origin => canonical(origin)), "Origin"),
    OriginGroups: list([], "OriginGroup"),
    DefaultCacheBehavior: apiBehavior(value.DefaultCacheBehavior),
    CacheBehaviors: list(behaviors.map(apiBehavior), "CacheBehavior"),
    CustomErrorResponses: list([], "CustomErrorResponse"),
    Comment: "",
    Logging: { Enabled: false, IncludeCookies: false, Bucket: "", Prefix: "" },
    PriceClass: "PriceClass_All",
    Enabled: value.Enabled,
    ViewerCertificate: { CloudFrontDefaultCertificate: true, MinimumProtocolVersion: "TLSv1", CertificateSource: "cloudfront" },
    Restrictions: { GeoRestriction: { RestrictionType: "none", Quantity: 0 } },
    WebACLId: "",
    HttpVersion: value.HttpVersion,
    IsIPV6Enabled: value.IPV6Enabled,
    ContinuousDeploymentPolicyId: "",
    Staging: false,
  };
}
function fromApiDistribution(value: JsonObject): JsonObject {
  const origins = apiItems(value.Origins, "Origin").map(origin => ({ DomainName: String(origin.DomainName), Id: String(origin.Id), OriginAccessControlId: String(origin.OriginAccessControlId), S3OriginConfig: { OriginAccessIdentity: String(origin.S3OriginConfig?.OriginAccessIdentity ?? "") } }));
  return stable({
    CacheBehaviors: apiItems(value.CacheBehaviors, "CacheBehavior").map(behavior => cfnBehavior(behavior, true)),
    DefaultCacheBehavior: cfnBehavior(value.DefaultCacheBehavior ?? {}, false),
    DefaultRootObject: String(value.DefaultRootObject), Enabled: value.Enabled === true, HttpVersion: String(value.HttpVersion), IPV6Enabled: value.IsIPV6Enabled === true, Origins: origins,
  });
}
function canonicalDistribution(properties: JsonObject): CloudFrontDistributionModel {
  const input = canonical(properties.DistributionConfig) as JsonObject;
  const normalizeBehavior = (behavior: JsonObject) => stable({ ...behavior, AllowedMethods: [...(behavior.AllowedMethods ?? ["GET", "HEAD"])] });
  return stable({ DistributionConfig: { ...input, DefaultCacheBehavior: normalizeBehavior(input.DefaultCacheBehavior), CacheBehaviors: input.CacheBehaviors.map(normalizeBehavior) }, Tags: canonicalTags(properties.Tags) });
}
function distributionResult(state: CloudFrontDistributionState) {
  const properties: CloudFrontDistributionModel = { DistributionConfig: fromApiDistribution(state.config), Tags: tagsFromMap(state.tags) };
  return { status: "SUCCESS" as const, physicalId: state.id, model: { physicalId: state.id, properties, attributes: { Id: state.id, DomainName: state.domainName } } };
}
function functionResult(state: CloudFrontFunctionState) {
  const live = state.live?.etag === state.development.etag;
  const properties: CloudFrontFunctionModel = { Name: state.name, FunctionCode: state.development.code, FunctionConfig: { Comment: state.development.comment, Runtime: state.development.runtime }, AutoPublish: live, Tags: tagsFromMap(state.tags) };
  return { status: "SUCCESS" as const, physicalId: state.name, model: { physicalId: state.name, properties, attributes: { FunctionARN: state.arn, "FunctionMetadata.FunctionARN": state.arn, Stage: live ? "LIVE" : "DEVELOPMENT" } } };
}
function oacResult(state: CloudFrontOriginAccessControlState) {
  const properties: CloudFrontOriginAccessControlModel = { OriginAccessControlConfig: { Name: state.name, Description: state.description, OriginAccessControlOriginType: state.originType, SigningBehavior: state.signingBehavior, SigningProtocol: state.signingProtocol } };
  return { status: "SUCCESS" as const, physicalId: state.id, model: { physicalId: state.id, properties, attributes: { Id: state.id } } };
}
function responsePolicyResult(state: CloudFrontResponseHeadersPolicyState) {
  const properties: CloudFrontResponseHeadersPolicyModel = { ResponseHeadersPolicyConfig: { Name: state.name, Comment: state.comment, SecurityHeadersConfig: stable(canonical(state.securityHeadersConfig)) } };
  return { status: "SUCCESS" as const, physicalId: state.id, model: { physicalId: state.id, properties, attributes: { Id: state.id, LastModifiedTime: apiDate(state.lastModifiedAt) } } };
}
async function reconcileTags(service: CloudFrontService, arn: string, desired: readonly CloudFrontTag[]): Promise<void> {
  const actual = service.listTags(arn); const wanted = tagMap(desired);
  const remove = Object.keys(actual).filter(key => !Object.hasOwn(wanted, key));
  const add = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => actual[key] !== value));
  if (remove.length || Object.keys(add).length) await service.tagResource(arn, { remove, add });
}

export function createCloudFrontDistributionProvider(service: CloudFrontService): ProductionResourceProvider<CloudFrontDistributionModel> {
  return {
    typeName: CLOUDFRONT_DISTRIBUTION_TYPE, providerVersion: 1, visibility: "production", schema: CLOUDFRONT_DISTRIBUTION_SCHEMA,
    validate(properties, context) { return validation(properties, CLOUDFRONT_DISTRIBUTION_SCHEMA, (value, issues) => distributionIssues(value, issues, context)); },
    canonicalize(properties, context) { if (!record(properties)) throw new TypeError(`${CLOUDFRONT_DISTRIBUTION_TYPE} Properties must be an object`); throwIssues(this.validate(properties, context)); return canonicalDistribution(properties); },
    plan(previous, desired) { return plan(previous, desired); },
    async create(desired, context) { try { return distributionResult(await service.createDistribution(toApiDistribution(desired, context), tagMap(desired.Tags), owner(context))); } catch (error) { return failure(error); } },
    async read(physicalId, context): Promise<ProviderReadResult<CloudFrontDistributionModel>> { try { const state = service.getDistribution(physicalId); return owned(state.cloudFormationOwner, context) ? distributionResult(state) : ownershipFailure("Distribution", physicalId); } catch (error) { return notFound(error, ["NoSuchDistribution"]) ? { status: "NOT_FOUND", physicalId } : failure(error) as ProviderReadResult<CloudFrontDistributionModel>; } },
    async update(physicalId, _previous, desired, context) { try { const current = service.getDistribution(physicalId); if (!owned(current.cloudFormationOwner, context)) return ownershipFailure("Distribution", physicalId); const updated = await service.updateDistribution(physicalId, toApiDistribution(desired, undefined, current.callerReference), current.etag); await reconcileTags(service, updated.arn, desired.Tags); return distributionResult(service.getDistribution(physicalId)); } catch (error) { return failure(error); } },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> { try { const current = service.getDistribution(physicalId); if (!owned(current.cloudFormationOwner, context)) return ownershipFailure("Distribution", physicalId); if (current.config.Enabled === true) { await service.updateDistribution(physicalId, { ...current.config, Enabled: false }, current.etag); return { status: "IN_PROGRESS", callbackAfterMs: 1, checkpoint: { schemaVersion: 1, physicalId, callbackContext: { phase: "wait-disabled" } }, message: "Waiting for the disabled distribution to deploy" }; } if (current.status !== "Deployed") return { status: "IN_PROGRESS", callbackAfterMs: 100, checkpoint: { schemaVersion: 1, physicalId, callbackContext: { phase: "wait-disabled" } } }; await service.deleteDistribution(physicalId, current.etag); return { status: "SUCCESS", physicalId }; } catch (error) { return notFound(error, ["NoSuchDistribution"]) ? { status: "NOT_FOUND", physicalId } : failure(error) as ProviderDeleteResult; } },
    async retain(physicalId, _previous, context) { await service.releaseCloudFormationOwnership("distribution", physicalId, context); },
    ref(read) { return read.physicalId; },
    getAtt(read, attribute) { if (attribute === "Id" || attribute === "DomainName") return read.attributes[attribute]; throw new ProviderReferenceError(CLOUDFRONT_DISTRIBUTION_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

export function createCloudFrontFunctionProvider(service: CloudFrontService): ProductionResourceProvider<CloudFrontFunctionModel> {
  return {
    typeName: CLOUDFRONT_FUNCTION_TYPE, providerVersion: 1, visibility: "production", schema: CLOUDFRONT_FUNCTION_SCHEMA,
    validate(properties) { return validation(properties, CLOUDFRONT_FUNCTION_SCHEMA, functionIssues); },
    canonicalize(properties, context) { if (!record(properties)) throw new TypeError(`${CLOUDFRONT_FUNCTION_TYPE} Properties must be an object`); throwIssues(this.validate(properties, context)); const config = properties.FunctionConfig as JsonObject; return stable({ Name: String(properties.Name), FunctionCode: String(properties.FunctionCode), FunctionConfig: { Comment: String(config.Comment ?? ""), Runtime: "cloudfront-js-1.0" as const }, AutoPublish: properties.AutoPublish === true, Tags: canonicalTags(properties.Tags) }); },
    plan(previous, desired) { return plan(previous, desired, ["Name"]); },
    async create(desired, context) {
      let state: CloudFrontFunctionState;
      try { state = await service.createFunction(desired.Name, desired.FunctionConfig, desired.FunctionCode, tagMap(desired.Tags), owner(context)); }
      catch (error) { return failure(error); }
      try { if (desired.AutoPublish && state.live?.etag !== state.development.etag) state = await service.publishFunction(state.name, state.development.etag); return functionResult(state); }
      catch (error) { return failure(error, state.name); }
    },
    async read(physicalId, context): Promise<ProviderReadResult<CloudFrontFunctionModel>> { try { const state = service.getFunction(physicalId); return owned(state.cloudFormationOwner, context) ? functionResult(state) : ownershipFailure("Function", physicalId); } catch (error) { return notFound(error, ["NoSuchFunctionExists"]) ? { status: "NOT_FOUND", physicalId } : failure(error) as ProviderReadResult<CloudFrontFunctionModel>; } },
    async update(physicalId, _previous, desired, context) { if (physicalId !== desired.Name) return { status: "FAILED", errorCode: "RequiresReplacement", message: "Name changes require replacement" }; try { const current = service.getFunction(physicalId); if (!owned(current.cloudFormationOwner, context)) return ownershipFailure("Function", physicalId); let updated = await service.updateFunction(physicalId, desired.FunctionConfig, desired.FunctionCode, current.development.etag); await reconcileTags(service, updated.arn, desired.Tags); updated = service.getFunction(physicalId); if (desired.AutoPublish && updated.live?.etag !== updated.development.etag) updated = await service.publishFunction(physicalId, updated.development.etag); return functionResult(updated); } catch (error) { return failure(error); } },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> { try { const current = service.getFunction(physicalId); if (!owned(current.cloudFormationOwner, context)) return ownershipFailure("Function", physicalId); await service.deleteFunction(physicalId, current.development.etag); return { status: "SUCCESS", physicalId }; } catch (error) { return notFound(error, ["NoSuchFunctionExists"]) ? { status: "NOT_FOUND", physicalId } : failure(error) as ProviderDeleteResult; } },
    async retain(physicalId, _previous, context) { await service.releaseCloudFormationOwnership("function", physicalId, context); },
    ref(read) { return read.attributes.FunctionARN; },
    getAtt(read, attribute) { if (Object.hasOwn(read.attributes, attribute)) return read.attributes[attribute]; throw new ProviderReferenceError(CLOUDFRONT_FUNCTION_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

export function createCloudFrontOriginAccessControlProvider(service: CloudFrontService): ProductionResourceProvider<CloudFrontOriginAccessControlModel> {
  return {
    typeName: CLOUDFRONT_ORIGIN_ACCESS_CONTROL_TYPE, providerVersion: 1, visibility: "production", schema: CLOUDFRONT_ORIGIN_ACCESS_CONTROL_SCHEMA,
    validate(properties) { return validation(properties, CLOUDFRONT_ORIGIN_ACCESS_CONTROL_SCHEMA, oacIssues); },
    canonicalize(properties, context) { if (!record(properties)) throw new TypeError(`${CLOUDFRONT_ORIGIN_ACCESS_CONTROL_TYPE} Properties must be an object`); throwIssues(this.validate(properties, context)); const config = properties.OriginAccessControlConfig as JsonObject; return { OriginAccessControlConfig: { Name: String(config.Name), Description: String(config.Description ?? ""), OriginAccessControlOriginType: "s3", SigningBehavior: "always", SigningProtocol: "sigv4" } }; },
    plan(previous, desired) { return plan(previous, desired); },
    async create(desired, context) { try { return oacResult(await service.createOriginAccessControl(desired.OriginAccessControlConfig, owner(context))); } catch (error) { return failure(error); } },
    async read(physicalId, context): Promise<ProviderReadResult<CloudFrontOriginAccessControlModel>> { try { const state = service.getOriginAccessControl(physicalId); return owned(state.cloudFormationOwner, context) ? oacResult(state) : ownershipFailure("Origin access control", physicalId); } catch (error) { return notFound(error, ["NoSuchOriginAccessControl"]) ? { status: "NOT_FOUND", physicalId } : failure(error) as ProviderReadResult<CloudFrontOriginAccessControlModel>; } },
    async update(physicalId, _previous, desired, context) { try { const current = service.getOriginAccessControl(physicalId); if (!owned(current.cloudFormationOwner, context)) return ownershipFailure("Origin access control", physicalId); return oacResult(await service.updateOriginAccessControl(physicalId, desired.OriginAccessControlConfig, current.etag)); } catch (error) { return failure(error); } },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> { try { const current = service.getOriginAccessControl(physicalId); if (!owned(current.cloudFormationOwner, context)) return ownershipFailure("Origin access control", physicalId); await service.deleteOriginAccessControl(physicalId, current.etag); return { status: "SUCCESS", physicalId }; } catch (error) { return notFound(error, ["NoSuchOriginAccessControl"]) ? { status: "NOT_FOUND", physicalId } : failure(error) as ProviderDeleteResult; } },
    async retain(physicalId, _previous, context) { await service.releaseCloudFormationOwnership("origin-access-control", physicalId, context); },
    ref(read) { return read.physicalId; },
    getAtt(read, attribute) { if (attribute === "Id") return read.attributes.Id; throw new ProviderReferenceError(CLOUDFRONT_ORIGIN_ACCESS_CONTROL_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

export function createCloudFrontResponseHeadersPolicyProvider(service: CloudFrontService): ProductionResourceProvider<CloudFrontResponseHeadersPolicyModel> {
  return {
    typeName: CLOUDFRONT_RESPONSE_HEADERS_POLICY_TYPE, providerVersion: 1, visibility: "production", schema: CLOUDFRONT_RESPONSE_HEADERS_POLICY_SCHEMA,
    validate(properties) { return validation(properties, CLOUDFRONT_RESPONSE_HEADERS_POLICY_SCHEMA, responsePolicyIssues); },
    canonicalize(properties, context) { if (!record(properties)) throw new TypeError(`${CLOUDFRONT_RESPONSE_HEADERS_POLICY_TYPE} Properties must be an object`); throwIssues(this.validate(properties, context)); const config = properties.ResponseHeadersPolicyConfig as JsonObject; return stable({ ResponseHeadersPolicyConfig: { Name: String(config.Name), Comment: String(config.Comment ?? ""), SecurityHeadersConfig: canonical(config.SecurityHeadersConfig) } }); },
    plan(previous, desired) { return plan(previous, desired); },
    async create(desired, context) { try { return responsePolicyResult(await service.createResponseHeadersPolicy(desired.ResponseHeadersPolicyConfig, owner(context))); } catch (error) { return failure(error); } },
    async read(physicalId, context): Promise<ProviderReadResult<CloudFrontResponseHeadersPolicyModel>> { try { const state = service.getResponseHeadersPolicy(physicalId); return owned(state.cloudFormationOwner, context) ? responsePolicyResult(state) : ownershipFailure("Response headers policy", physicalId); } catch (error) { return notFound(error, ["NoSuchResponseHeadersPolicy"]) ? { status: "NOT_FOUND", physicalId } : failure(error) as ProviderReadResult<CloudFrontResponseHeadersPolicyModel>; } },
    async update(physicalId, _previous, desired, context) { try { const current = service.getResponseHeadersPolicy(physicalId); if (!owned(current.cloudFormationOwner, context)) return ownershipFailure("Response headers policy", physicalId); return responsePolicyResult(await service.updateResponseHeadersPolicy(physicalId, desired.ResponseHeadersPolicyConfig, current.etag)); } catch (error) { return failure(error); } },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> { try { const current = service.getResponseHeadersPolicy(physicalId); if (!owned(current.cloudFormationOwner, context)) return ownershipFailure("Response headers policy", physicalId); await service.deleteResponseHeadersPolicy(physicalId, current.etag); return { status: "SUCCESS", physicalId }; } catch (error) { return notFound(error, ["NoSuchResponseHeadersPolicy"]) ? { status: "NOT_FOUND", physicalId } : failure(error) as ProviderDeleteResult; } },
    async retain(physicalId, _previous, context) { await service.releaseCloudFormationOwnership("response-headers-policy", physicalId, context); },
    ref(read) { return read.physicalId; },
    getAtt(read, attribute) { if (attribute === "Id" || attribute === "LastModifiedTime") return read.attributes[attribute]; throw new ProviderReferenceError(CLOUDFRONT_RESPONSE_HEADERS_POLICY_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

export function createCloudFrontCloudFormationProviders(service: CloudFrontService): readonly ProductionResourceProvider<any>[] {
  return [
    createCloudFrontDistributionProvider(service),
    createCloudFrontFunctionProvider(service),
    createCloudFrontOriginAccessControlProvider(service),
    createCloudFrontResponseHeadersPolicyProvider(service),
  ];
}
