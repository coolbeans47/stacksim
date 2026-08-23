import type { IncomingMessage } from "node:http";
import type { PrincipalContext } from "./sigv4.js";
import { partiqlAuthorizationTarget } from "./partiql.js";
import { parseAwsQuery } from "../protocols/query-xml.js";
import { readBody } from "../util.js";
import { ssmParameterArn } from "../ssm.js";
import { secretsManagerArn } from "../secrets-manager.js";
import { resolveSesV2Operation } from "../ses/protocol-v2.js";
import type { IamState } from "../types.js";
import { resolveIamAuthorizationTarget } from "./iam-target.js";
import { xrayOperation } from "../xray/action-inventory.js";
import { AwsError } from "../errors.js";

export interface AuthorizationTarget { action: string; resource: string; operation: string; input: any; context: Record<string, unknown>; additionalTargets?: AuthorizationTarget[] }

function eventBusTarget(value: unknown, region: string, accountId: string): { name: string; arn: string } {
  const supplied = typeof value === "string" && value ? value : "default";
  if (supplied.startsWith("arn:")) {
    const match = supplied.match(/^arn:[^:]+:events:[^:]+:\d{12}:event-bus\/(.+)$/);
    return { name: match?.[1] ?? supplied, arn: supplied };
  }
  return { name: supplied, arn: `arn:aws:events:${region}:${accountId}:event-bus/${supplied}` };
}

function eventRuleArn(ruleName: unknown, eventBusName: unknown, region: string, accountId: string): string {
  const rule = typeof ruleName === "string" && ruleName ? ruleName : "*";
  const bus = eventBusTarget(eventBusName, region, accountId).name;
  return `arn:aws:events:${region}:${accountId}:rule/${bus === "default" ? "" : `${bus}/`}${rule}`;
}

function eventRequestTags(input: any): Record<string, string> {
  const supplied = input?.Tags;
  if (!Array.isArray(supplied)) return {};
  return Object.fromEntries(supplied.filter((tag: any) => typeof tag?.Key === "string").map((tag: any) => [String(tag.Key), String(tag.Value ?? "")]));
}

function eventPatternContext(value: unknown): Record<string, unknown> {
  let pattern: any;
  try { pattern = typeof value === "string" ? JSON.parse(value) : value; }
  catch { return {}; }
  if (!pattern || typeof pattern !== "object" || Array.isArray(pattern)) return {};
  const literals = (candidate: unknown): string[] => (Array.isArray(candidate) ? candidate : [candidate]).filter((item): item is string => typeof item === "string");
  const context: Record<string, unknown> = {};
  const source = literals(pattern.source); if (source.length) context["events:source"] = source;
  const detailType = literals(pattern["detail-type"]); if (detailType.length) context["events:detail-type"] = detailType;
  const detail = pattern.detail && typeof pattern.detail === "object" && !Array.isArray(pattern.detail) ? pattern.detail : {};
  const service = literals(detail.service); if (service.length) context["events:detail.service"] = service;
  const eventTypeCode = literals(detail.eventTypeCode); if (eventTypeCode.length) context["events:detail.eventTypeCode"] = eventTypeCode;
  const userIdentity = detail.userIdentity && typeof detail.userIdentity === "object" && !Array.isArray(detail.userIdentity) ? detail.userIdentity : {};
  const principalId = literals(userIdentity.principalId); if (principalId.length) context["events:detail.userIdentity.principalId"] = principalId;
  return context;
}

function putEventContext(entry: any): Record<string, unknown> {
  const context: Record<string, unknown> = { "events:eventBusInvocation": "false" };
  if (typeof entry?.Source === "string") context["events:source"] = entry.Source;
  if (typeof entry?.DetailType === "string") context["events:detail-type"] = entry.DetailType;
  if (Array.isArray(entry?.Resources) && entry.Resources.length) context["events:ResourceArn"] = entry.Resources.map(String);
  return context;
}

function cloudFrontRequestTags(source: string): Record<string, string> {
  const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity]!);
  return Object.fromEntries([...source.matchAll(/<Tag(?:\s[^>]*)?>([\s\S]*?)<\/Tag>/gi)].flatMap(match => {
    const key = match[1].match(/<Key(?:\s[^>]*)?>([\s\S]*?)<\/Key>/i)?.[1];
    const value = match[1].match(/<Value(?:\s[^>]*)?>([\s\S]*?)<\/Value>/i)?.[1];
    return key === undefined || value === undefined ? [] : [[decode(key.trim()), decode(value.trim())]];
  }));
}

function cloudFrontTagKeys(source: string): string[] {
  const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity]!);
  const container = source.match(/<TagKeys(?:\s[^>]*)?>([\s\S]*?)<\/TagKeys>/i)?.[1] ?? "";
  return [...container.matchAll(/<Key(?:\s[^>]*)?>([\s\S]*?)<\/Key>/gi)].map(match => decode(match[1].trim()));
}

function decodeCloudFrontPathPart(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new AwsError("InvalidArgument", "The CloudFront resource path is not valid percent-encoding", 400); }
}

function cloudFrontAuthorizationTarget(req: IncomingMessage, url: URL, accountId: string, body: Buffer): AuthorizationTarget {
  const method = req.method ?? "GET";
  const path = url.pathname;
  const arn = (kind: string, id: string) => `arn:aws:cloudfront::${accountId}:${kind}/${id}`;
  let operation: string | undefined;
  let resource = "*";

  const collection = [
    [/^\/2020-05-31\/origin-access-control$/, "CreateOriginAccessControl", "ListOriginAccessControls"],
    [/^\/2020-05-31\/response-headers-policy$/, "CreateResponseHeadersPolicy", "ListResponseHeadersPolicies"],
    [/^\/2020-05-31\/function$/, "CreateFunction", "ListFunctions"],
    [/^\/2020-05-31\/distribution$/, "CreateDistribution", "ListDistributions"],
  ] as const;
  for (const [pattern, create, list] of collection) if (pattern.test(path)) operation = method === "POST" ? create : method === "GET" ? list : undefined;

  let match = path.match(/^\/2020-05-31\/origin-access-control\/([^/]+)(\/config)?$/);
  if (match) { resource = arn("origin-access-control", match[1]); operation = method === "DELETE" && !match[2] ? "DeleteOriginAccessControl" : method === "GET" ? (match[2] ? "GetOriginAccessControlConfig" : "GetOriginAccessControl") : method === "PUT" && match[2] ? "UpdateOriginAccessControl" : undefined; }
  match = path.match(/^\/2020-05-31\/response-headers-policy\/([^/]+)(\/config)?$/);
  if (match) { resource = arn("response-headers-policy", match[1]); operation = method === "DELETE" && !match[2] ? "DeleteResponseHeadersPolicy" : method === "GET" ? (match[2] ? "GetResponseHeadersPolicyConfig" : "GetResponseHeadersPolicy") : method === "PUT" && match[2] ? "UpdateResponseHeadersPolicy" : undefined; }
  match = path.match(/^\/2020-05-31\/function\/([^/]+)(?:\/(describe|publish|test))?$/);
  if (match) {
    const name = decodeCloudFrontPathPart(match[1]); resource = arn("function", name);
    operation = method === "DELETE" && !match[2] ? "DeleteFunction" : method === "PUT" && !match[2] ? "UpdateFunction" : method === "GET" && !match[2] ? "GetFunction" : method === "GET" && match[2] === "describe" ? "DescribeFunction" : method === "POST" && match[2] === "publish" ? "PublishFunction" : method === "POST" && match[2] === "test" ? "TestFunction" : undefined;
  }
  match = path.match(/^\/2020-05-31\/distribution\/([^/]+)(\/config)?$/);
  if (match) { resource = arn("distribution", match[1]); operation = method === "DELETE" && !match[2] ? "DeleteDistribution" : method === "GET" ? (match[2] ? "GetDistributionConfig" : "GetDistribution") : method === "PUT" && match[2] ? "UpdateDistribution" : undefined; }
  match = path.match(/^\/2020-05-31\/distribution\/([^/]+)\/invalidation(?:\/([^/]+))?$/);
  if (match) { resource = arn("distribution", match[1]); operation = method === "POST" && !match[2] ? "CreateInvalidation" : method === "GET" ? (match[2] ? "GetInvalidation" : "ListInvalidations") : undefined; }
  match = path.match(/^\/2020-05-31\/cache-policy(?:\/([^/]+)(\/config)?)?$/);
  if (match && method === "GET") { operation = match[1] ? (match[2] ? "GetCachePolicyConfig" : "GetCachePolicy") : "ListCachePolicies"; resource = match[1] ? `arn:aws:cloudfront::aws:cache-policy/${match[1]}` : "*"; }
  if (path === "/2020-05-31/tagging") { resource = url.searchParams.get("Resource") ?? "*"; operation = method === "GET" ? "ListTagsForResource" : method === "POST" && url.searchParams.get("Operation") === "Tag" ? "TagResource" : method === "POST" && url.searchParams.get("Operation") === "Untag" ? "UntagResource" : undefined; }
  if (!operation) throw new AwsError("UnsupportedOperation", `Unsupported CloudFront method/path: ${method} ${path}`, 400);

  const requestedTags = cloudFrontRequestTags(body.toString("utf8"));
  const tagKeys = operation === "UntagResource" ? cloudFrontTagKeys(body.toString("utf8")) : Object.keys(requestedTags);
  const context: Record<string, unknown> = { "aws:TagKeys": tagKeys };
  for (const [key, value] of Object.entries(requestedTags)) context[`aws:RequestTag/${key}`] = value;
  const additionalTargets = operation === "CreateDistribution" && Object.keys(requestedTags).length
    ? [{ action: "cloudfront:TagResource", resource: "*", operation: "TagResource", input: {}, context }]
    : undefined;
  return { action: `cloudfront:${operation}`, resource, operation, input: {}, context, ...(additionalTargets ? { additionalTargets } : {}) };
}

export async function authorizationTarget(req: IncomingMessage, url: URL, service: string, region: string, accountId: string, principal: PrincipalContext, now: number, iam?: IamState): Promise<AuthorizationTarget> {
  let input: any = {};
  let requestBody: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const additionalTargets: Array<{ action: string; resource: string; operation: string; context?: Record<string, unknown> }> = [];
  if (service !== "s3") { requestBody = await readBody(req); if (service === "cloudfront" && requestBody.length > 1024 * 1024) throw new AwsError("InvalidArgument", "The CloudFront request body exceeds the 1 MiB authorization limit", 413); if (requestBody.length) { if (String(req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) input = parseAwsQuery(requestBody.toString("utf8"), { coerceTimestamps: service !== "cloudformation" }); else { try { input = JSON.parse(requestBody.toString("utf8")); } catch {} } } }
  if (service === "cloudfront") {
    const resolved = cloudFrontAuthorizationTarget(req, url, accountId, requestBody);
    const common = { "aws:PrincipalArn": principal.principalArn, "aws:PrincipalAccount": principal.accountId, "aws:RequestedRegion": region, "aws:CurrentTime": new Date(now).toISOString(), "aws:SecureTransport": Boolean((req.socket as any).encrypted) };
    resolved.context = { ...common, ...resolved.context };
    for (const additional of resolved.additionalTargets ?? []) additional.context = { ...common, ...(additional.context ?? {}) };
    return resolved;
  }
  const target = String(req.headers["x-amz-target"] ?? "").split(".").pop(); let operation = target ?? String(input.Action ?? req.method ?? "Unknown"); let action = `${service}:${operation}`; let resource = "*"; let operationContext: Record<string, unknown> = {};
  if (service === "xray") {
    operation = xrayOperation(url.pathname, req.method) ?? "Unknown";
    action = `xray:${operation}`;
    resource = "*";
  }
  else if (service === "states") {
    action = `states:${operation}`;
    resource = input.stateMachineArn ?? input.executionArn ?? input.activityArn ?? input.resourceArn
      ?? (operation === "CreateStateMachine" && input.name ? `arn:aws:states:${region}:${accountId}:stateMachine:${input.name}`
        : operation === "CreateActivity" && input.name ? `arn:aws:states:${region}:${accountId}:activity:${input.name}` : "*");
    const suppliedTags = Array.isArray(input.tags) ? input.tags : [];
    operationContext["aws:TagKeys"] = operation === "UntagResource"
      ? (Array.isArray(input.tagKeys) ? input.tagKeys.map(String) : [])
      : suppliedTags.map((tag: any) => tag?.key).filter(Boolean);
    for (const tag of suppliedTags) if (tag?.key) operationContext[`aws:RequestTag/${tag.key}`] = tag.value;
    if (typeof input.roleArn === "string" && ["CreateStateMachine", "UpdateStateMachine"].includes(operation)) additionalTargets.push({
      action: "iam:PassRole",
      resource: input.roleArn,
      operation: "PassRole",
      context: { "iam:PassedToService": "states.amazonaws.com", "iam:AssociatedResourceArn": resource },
    });
  }
  else if (service === "s3") {
    const rawPath = String(req.url ?? "/").split("?", 1)[0].replace(/^\//, ""); const host = String(req.headers.host ?? "").replace(/:\d+$/, ""); const virtual = host.match(/^(.+)\.(?:s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com|localhost|127\.0\.0\.1)$/i)?.[1]; const separator = rawPath.indexOf("/"); const bucket = decodeURIComponent(virtual ?? (separator < 0 ? rawPath : rawPath.slice(0, separator))); const key = virtual ? decodeURIComponent(rawPath) : separator < 0 ? undefined : decodeURIComponent(rawPath.slice(separator + 1));
    const uploadId = url.searchParams.has("uploadId"); const partNumber = url.searchParams.has("partNumber");
    if (!bucket) operation = "ListAllMyBuckets";
    else if (!key) operation = url.searchParams.has("acl") ? req.method === "PUT" ? "PutBucketAcl" : "GetBucketAcl"
      : url.searchParams.has("ownershipControls") ? req.method === "PUT" ? "PutBucketOwnershipControls" : req.method === "DELETE" ? "DeleteBucketOwnershipControls" : "GetBucketOwnershipControls"
      : url.searchParams.has("abac") ? req.method === "PUT" ? "PutBucketAbac" : "GetBucketAbac"
      : url.searchParams.has("requestPayment") ? req.method === "PUT" ? "PutBucketRequestPayment" : "GetBucketRequestPayment"
      : url.searchParams.has("policyStatus") ? "GetBucketPolicyStatus"
      : url.searchParams.has("versioning") ? req.method === "PUT" ? "PutBucketVersioning" : "GetBucketVersioning"
      : url.searchParams.has("encryption") ? req.method === "PUT" ? "PutBucketEncryption" : req.method === "DELETE" ? "DeleteBucketEncryption" : "GetEncryptionConfiguration"
      : url.searchParams.has("object-lock") ? req.method === "PUT" ? "PutObjectLockConfiguration" : "GetObjectLockConfiguration"
      : url.searchParams.has("lifecycle") ? req.method === "PUT" ? "PutLifecycleConfiguration" : req.method === "DELETE" ? "PutLifecycleConfiguration" : "GetLifecycleConfiguration"
      : url.searchParams.has("notification") ? req.method === "PUT" ? "PutBucketNotification" : "GetBucketNotification"
      : url.searchParams.has("notification-diagnostics") ? "GetBucketNotification"
      : url.searchParams.has("tagging") ? req.method === "PUT" ? "PutBucketTagging" : req.method === "DELETE" ? "DeleteBucketTagging" : "GetBucketTagging"
      : url.searchParams.has("publicAccessBlock") ? req.method === "PUT" ? "PutBucketPublicAccessBlock" : req.method === "DELETE" ? "PutBucketPublicAccessBlock" : "GetBucketPublicAccessBlock"
      : url.searchParams.has("website") ? req.method === "PUT" ? "PutBucketWebsite" : req.method === "DELETE" ? "DeleteBucketWebsite" : "GetBucketWebsite"
      : url.searchParams.has("cors") ? req.method === "PUT" ? "PutBucketCORS" : req.method === "DELETE" ? "DeleteBucketCORS" : "GetBucketCORS"
      : url.searchParams.has("policy") ? req.method === "PUT" ? "PutBucketPolicy" : req.method === "DELETE" ? "DeleteBucketPolicy" : "GetBucketPolicy"
      : req.method === "PUT" ? "CreateBucket" : req.method === "DELETE" ? "DeleteBucket" : req.method === "HEAD" ? "HeadBucket" : req.method === "POST" && url.searchParams.has("delete") ? "DeleteObjects" : url.searchParams.has("location") ? "GetBucketLocation" : url.searchParams.has("versions") ? "ListBucketVersions" : url.searchParams.has("uploads") ? "ListBucketMultipartUploads" : "ListBucket";
    else operation = url.searchParams.has("encryption") && req.method === "PUT" ? "UpdateObjectEncryption"
      : url.searchParams.has("tagging") ? req.method === "PUT" ? (url.searchParams.has("versionId") ? "PutObjectVersionTagging" : "PutObjectTagging") : req.method === "DELETE" ? (url.searchParams.has("versionId") ? "DeleteObjectVersionTagging" : "DeleteObjectTagging") : (url.searchParams.has("versionId") ? "GetObjectVersionTagging" : "GetObjectTagging")
      : url.searchParams.has("retention") ? req.method === "PUT" ? "PutObjectRetention" : "GetObjectRetention"
      : url.searchParams.has("legal-hold") ? req.method === "PUT" ? "PutObjectLegalHold" : "GetObjectLegalHold"
      : url.searchParams.has("annotation") ? req.method === "PUT" ? "PutObjectAnnotation" : req.method === "DELETE" ? "DeleteObjectAnnotation" : url.searchParams.has("annotationName") ? "GetObjectAnnotation" : "ListObjectAnnotations"
      : req.method === "POST" && url.searchParams.has("restore") ? "RestoreObject"
      : url.searchParams.has("acl") ? req.method === "PUT" ? (url.searchParams.has("versionId") ? "PutObjectVersionAcl" : "PutObjectAcl") : (url.searchParams.has("versionId") ? "GetObjectVersionAcl" : "GetObjectAcl") : req.method === "POST" && url.searchParams.has("uploads") ? "CreateMultipartUpload" : req.method === "PUT" && uploadId && partNumber && req.headers["x-amz-copy-source"] ? "UploadPartCopy" : req.method === "PUT" && uploadId && partNumber ? "UploadPart" : req.method === "GET" && uploadId ? "ListMultipartUploadParts" : req.method === "POST" && uploadId ? "CompleteMultipartUpload" : req.method === "DELETE" && uploadId ? "AbortMultipartUpload" : req.method === "GET" && url.searchParams.has("attributes") ? "GetObjectAttributes" : req.method === "GET" && url.searchParams.has("torrent") ? "GetObjectTorrent" : req.method === "PUT" && req.headers["x-amz-copy-source"] ? "CopyObject" : req.method === "PUT" ? "PutObject" : req.method === "HEAD" ? "HeadObject" : req.method === "DELETE" ? "DeleteObject" : "GetObject";
    const versioned = url.searchParams.has("versionId");
    const actionNames: Record<string, string> = {
      HeadBucket: "ListBucket",
      HeadObject: versioned ? "GetObjectVersion" : "GetObject",
      GetObject: versioned ? "GetObjectVersion" : "GetObject",
      DeleteObject: versioned ? "DeleteObjectVersion" : "DeleteObject",
      CreateMultipartUpload: "PutObject",
      CompleteMultipartUpload: "PutObject",
      UploadPart: "PutObject",
      CopyObject: "PutObject",
      UploadPartCopy: "PutObject",
      DeleteBucketOwnershipControls: "PutBucketOwnershipControls",
      PutBucketEncryption: "PutEncryptionConfiguration",
      DeleteBucketEncryption: "PutEncryptionConfiguration",
      GetEncryptionConfiguration: "GetEncryptionConfiguration",
      GetObjectLockConfiguration: "GetBucketObjectLockConfiguration",
      PutObjectLockConfiguration: "PutBucketObjectLockConfiguration",
      PutLifecycleConfiguration: "PutLifecycleConfiguration",
      GetLifecycleConfiguration: "GetLifecycleConfiguration",
    };
    action = `s3:${actionNames[operation] ?? operation}`;
    resource = !bucket ? "*" : key ? `arn:aws:s3:::${bucket}/${key}` : `arn:aws:s3:::${bucket}`;
    if (operation === "DeleteObjects") {
      const xml = (await readBody(req)).toString("utf8");
      const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity]!);
      const objects = [...xml.matchAll(/<Object(?:\s[^>]*)?>([\s\S]*?)<\/Object>/gi)].map(match => {
        const body = match[1];
        const rawKey = body.match(/<Key(?:\s[^>]*)?>([\s\S]*?)<\/Key>/i)?.[1];
        const rawVersion = body.match(/<VersionId(?:\s[^>]*)?>([\s\S]*?)<\/VersionId>/i)?.[1];
        return rawKey === undefined ? undefined : { key: decode(rawKey.trim()), versionId: rawVersion === undefined ? undefined : decode(rawVersion.trim()) };
      }).filter((item): item is { key: string; versionId: string | undefined } => item !== undefined);
      action = `s3:${objects[0]?.versionId === undefined ? "DeleteObject" : "DeleteObjectVersion"}`;
      resource = objects[0] ? `arn:aws:s3:::${bucket}/${objects[0].key}` : `arn:aws:s3:::${bucket}/*`;
      if (objects[0]?.versionId !== undefined) operationContext["s3:VersionId"] = objects[0].versionId;
      for (const item of objects.slice(1)) additionalTargets.push({
        action: `s3:${item.versionId === undefined ? "DeleteObject" : "DeleteObjectVersion"}`,
        resource: `arn:aws:s3:::${bucket}/${item.key}`,
        operation: "DeleteObjects",
        ...(item.versionId === undefined ? {} : { context: { "s3:VersionId": item.versionId } }),
      });
    }
    if (new Set(["PutBucketTagging", "PutObjectTagging", "PutObjectVersionTagging"]).has(operation)) {
      const xml = (await readBody(req)).toString("utf8");
      const requestedTags = [...xml.matchAll(/<Tag(?:\s[^>]*)?>([\s\S]*?)<\/Tag>/gi)].map(match => {
        const key = match[1].match(/<Key(?:\s[^>]*)?>([\s\S]*?)<\/Key>/i)?.[1];
        const value = match[1].match(/<Value(?:\s[^>]*)?>([\s\S]*?)<\/Value>/i)?.[1];
        const decode = (candidate: string) => candidate.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity]!);
        return key === undefined || value === undefined ? undefined : { key: decode(key.trim()), value: decode(value.trim()) };
      }).filter((tag): tag is { key: string; value: string } => tag !== undefined);
      operationContext["aws:TagKeys"] = requestedTags.map(tag => tag.key);
      for (const tag of requestedTags) {
        operationContext[`aws:RequestTag/${tag.key}`] = tag.value;
        if (operation !== "PutBucketTagging") operationContext[`s3:RequestObjectTag/${tag.key}`] = tag.value;
      }
      if (operation !== "PutBucketTagging") operationContext["s3:RequestObjectTagKeys"] = requestedTags.map(tag => tag.key);
    }
    if (url.searchParams.has("prefix")) operationContext["s3:prefix"] = url.searchParams.get("prefix") ?? "";
    if (url.searchParams.has("delimiter")) operationContext["s3:delimiter"] = url.searchParams.get("delimiter") ?? "";
    if (url.searchParams.has("max-keys")) operationContext["s3:max-keys"] = Number(url.searchParams.get("max-keys"));
    if (url.searchParams.has("versionId")) operationContext["s3:VersionId"] = url.searchParams.get("versionId");
    if (req.headers["x-amz-request-payer"]) operationContext["s3:x-amz-request-payer"] = req.headers["x-amz-request-payer"];
    if (req.headers["x-amz-acl"] !== undefined) operationContext["s3:x-amz-acl"] = String(req.headers["x-amz-acl"]);
    for (const [header, condition] of [
      ["x-amz-grant-read", "s3:x-amz-grant-read"],
      ["x-amz-grant-write", "s3:x-amz-grant-write"],
      ["x-amz-grant-read-acp", "s3:x-amz-grant-read-acp"],
      ["x-amz-grant-write-acp", "s3:x-amz-grant-write-acp"],
      ["x-amz-grant-full-control", "s3:x-amz-grant-full-control"],
    ] as const) if (req.headers[header] !== undefined) operationContext[condition] = String(req.headers[header]);
    const encodedTags = req.headers["x-amz-tagging"];
    if (encodedTags) {
      const tags = new URLSearchParams(String(encodedTags)); operationContext["aws:TagKeys"] = [...tags.keys()]; operationContext["s3:RequestObjectTagKeys"] = [...tags.keys()];
      for (const [tagKey, tagValue] of tags) operationContext[`s3:RequestObjectTag/${tagKey}`] = tagValue;
    }
    for (const [header, condition] of [
      ["x-amz-object-lock-mode", "s3:object-lock-mode"],
      ["x-amz-object-lock-retain-until-date", "s3:object-lock-retain-until-date"],
      ["x-amz-object-lock-legal-hold", "s3:object-lock-legal-hold"],
    ] as const) if (req.headers[header] !== undefined) operationContext[condition] = req.headers[header];
    if (String(req.headers["x-amz-bypass-governance-retention"] ?? "").toLowerCase() === "true" && key) additionalTargets.push({ action: "s3:BypassGovernanceRetention", resource: `arn:aws:s3:::${bucket}/${key}`, operation: "BypassGovernanceRetention" });
    if (operation === "CreateBucket" && String(req.headers["x-amz-bucket-object-lock-enabled"] ?? "").toLowerCase() === "true") {
      additionalTargets.push({ action: "s3:PutBucketVersioning", resource: `arn:aws:s3:::${bucket}`, operation: "PutBucketVersioning" });
      additionalTargets.push({ action: "s3:PutBucketObjectLockConfiguration", resource: `arn:aws:s3:::${bucket}`, operation: "PutBucketObjectLockConfiguration" });
    }
    if ((operation === "CopyObject" || operation === "UploadPartCopy") && req.headers["x-amz-copy-source"]) {
      const supplied = String(req.headers["x-amz-copy-source"]).replace(/^\//, ""); const question = supplied.indexOf("?"); const sourcePath = question < 0 ? supplied : supplied.slice(0, question); const sourceQuery = new URLSearchParams(question < 0 ? "" : supplied.slice(question + 1)); const slash = sourcePath.indexOf("/");
      if (slash > 0) { try { const sourceBucket = decodeURIComponent(sourcePath.slice(0, slash)); const sourceKey = decodeURIComponent(sourcePath.slice(slash + 1)); const versioned = sourceQuery.has("versionId"); additionalTargets.push({ action: `s3:${versioned ? "GetObjectVersion" : "GetObject"}`, resource: `arn:aws:s3:::${sourceBucket}/${sourceKey}`, operation: versioned ? "GetObjectVersion" : "GetObject" }); } catch { /* The S3 protocol handler returns the modeled invalid-copy-source error. */ } }
    }
  } else if (service === "s3-control") {
    operation = req.method === "PUT" ? "PutAccountPublicAccessBlock" : req.method === "DELETE" ? "PutAccountPublicAccessBlock" : "GetAccountPublicAccessBlock";
    action = `s3:${operation}`;
    resource = "*";
  }
  else if (service === "dynamodb") {
    action = `dynamodb:${operation}`; const requested = input.ExportArn ?? input.ImportArn ?? input.StreamArn ?? input.BackupArn ?? input.ResourceArn ?? input.TableArn ?? input.SourceTableArn ?? input.SourceTableName ?? input.TableName ?? input.GlobalTableName;
    if (requested) { resource = String(requested).startsWith("arn:") ? String(requested) : `arn:aws:dynamodb:${region}:${accountId}:table/${requested}`; if (input.IndexName && new Set(["Query", "Scan", "DescribeContributorInsights", "UpdateContributorInsights"]).has(operation) && !resource.includes("/index/")) resource += `/index/${input.IndexName}`; }
    const transactionItems = new Set<string>();
    if (new Set(["TransactWriteItems", "TransactGetItems"]).has(operation) && Array.isArray(input.TransactItems)) {
      for (const item of input.TransactItems) {
        const operationInput = item?.ConditionCheck ?? item?.Put ?? item?.Delete ?? item?.Update ?? item?.Get;
        if (typeof operationInput?.TableName === "string" && operationInput.TableName) transactionItems.add(operationInput.TableName);
      }
    }
    if (transactionItems.size) {
      const resources = [...transactionItems].map(name => name.startsWith("arn:") ? name : `arn:aws:dynamodb:${region}:${accountId}:table/${name}`);
      resource = resources[0];
      for (const transactionResource of resources.slice(1)) additionalTargets.push({ action, resource: transactionResource, operation });
    }
    const entries = operation === "ExecuteStatement" ? [input] : operation === "BatchExecuteStatement" && Array.isArray(input.Statements) ? input.Statements : operation === "ExecuteTransaction" && Array.isArray(input.TransactStatements) ? input.TransactStatements : [];
    if (entries.length) {
      const targets = entries.map((entry: any) => partiqlAuthorizationTarget(entry?.Statement, region, accountId) ?? { action: `dynamodb:${operation}`, resource: "*" });
      action = targets[0].action; resource = targets[0].resource;
      for (const statementTarget of targets.slice(1)) additionalTargets.push({ ...statementTarget, operation });
    }
  }
  else if (service === "rds") {
    operation = String(input.Action ?? operation); action = `rds:${operation}`;
    const identifier = input.DBInstanceIdentifier ? String(input.DBInstanceIdentifier).toLowerCase() : undefined;
    const parameterGroup = input.DBParameterGroupName ? String(input.DBParameterGroupName).toLowerCase() : undefined;
    const snapshotIdentifier = input.DBSnapshotIdentifier ? String(input.DBSnapshotIdentifier).toLowerCase() : input.TargetDBSnapshotIdentifier ? String(input.TargetDBSnapshotIdentifier).toLowerCase() : undefined;
    const sourceSnapshot = input.SourceDBSnapshotIdentifier ? String(input.SourceDBSnapshotIdentifier) : undefined;
    const snapshotResource = snapshotIdentifier ? snapshotIdentifier.startsWith("arn:") ? snapshotIdentifier : `arn:aws:rds:${region}:${accountId}:snapshot:${snapshotIdentifier}` : undefined;
    if (input.ResourceName) resource = String(input.ResourceName);
    else if (identifier) resource = `arn:aws:rds:${region}:${accountId}:db:${identifier}`;
    else if (snapshotResource) resource = snapshotResource;
    else if (parameterGroup) resource = `arn:aws:rds:${region}:${accountId}:pg:${parameterGroup}`;
    if (operation === "CreateDBSnapshot" && snapshotResource) additionalTargets.push({ action, resource: snapshotResource, operation });
    if (sourceSnapshot) additionalTargets.push({ action, resource: sourceSnapshot.startsWith("arn:") ? sourceSnapshot : `arn:aws:rds:${region}:${accountId}:snapshot:${sourceSnapshot.toLowerCase()}`, operation });
    if (operation === "RestoreDBInstanceFromDBSnapshot" && input.DBSnapshotIdentifier) {
      const source = String(input.DBSnapshotIdentifier); additionalTargets.push({ action, resource: source.startsWith("arn:") ? source : `arn:aws:rds:${region}:${accountId}:snapshot:${source.toLowerCase()}`, operation });
    }
    const tagContainer = input.Tags?.Tag ?? input.Tags;
    const tags = Array.isArray(tagContainer) ? tagContainer : tagContainer ? [tagContainer] : [];
    if (new Set(["CreateDBInstance", "CreateDBParameterGroup", "CreateDBSnapshot", "CopyDBSnapshot", "RestoreDBInstanceFromDBSnapshot"]).has(operation) && tags.length) additionalTargets.push({ action: "rds:AddTagsToResource", resource: operation === "CreateDBSnapshot" && snapshotResource ? snapshotResource : resource, operation: "AddTagsToResource" });
  }
  else if (service === "sqs") {
    // Legacy SQS Query requests may carry Action and operation inputs on a GET
    // query string. Merge those fields before deriving the IAM target so the
    // JSON and Query transports authorize the same action and queue ARN.
    if (url.searchParams.size) input = { ...parseAwsQuery(url.searchParams), ...input };
    operation = String(input.Action ?? operation);
    const parentActions: Record<string, string> = { SendMessageBatch: "SendMessage", DeleteMessageBatch: "DeleteMessage", ChangeMessageVisibilityBatch: "ChangeMessageVisibility" };
    action = `sqs:${parentActions[operation] ?? operation}`;
    const queueIdentity = (value: unknown): { owner?: string; name?: string } => {
      if (typeof value !== "string" || !value) return {};
      try {
        const parts = new URL(value).pathname.split("/").filter(Boolean).map(decodeURIComponent);
        return { owner: parts.length >= 2 ? parts.at(-2) : undefined, name: parts.at(-1) };
      } catch {
        const parts = value.split("/").filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { return part; } });
        return { owner: parts.length >= 2 ? parts.at(-2) : undefined, name: parts.at(-1) };
      }
    };
    const pathIdentity = url.pathname === "/" ? {} : queueIdentity(url.pathname);
    const supplied = queueIdentity(input.QueueUrl);
    const queueName = operation === "CreateQueue" || operation === "GetQueueUrl" ? input.QueueName : supplied.name ?? pathIdentity.name;
    const owner = String(input.QueueOwnerAWSAccountId ?? supplied.owner ?? pathIdentity.owner ?? accountId);
    if (queueName && operation !== "ListQueues") resource = `arn:aws:sqs:${region}:${owner}:${queueName}`;
    if (operation === "CreateQueue") {
      const createTags = input.tags ?? input.Tags ?? input.Tag;
      const hasTags = Array.isArray(createTags) ? createTags.length > 0 : Boolean(createTags && typeof createTags === "object" && Object.keys(createTags).length);
      if (hasTags) additionalTargets.push({ action: "sqs:TagQueue", resource, operation: "TagQueue" });
    }
  }
  else if (service === "scheduler") {
    const schedule = url.pathname.match(/^\/schedules\/([^/]+)$/);
    const group = url.pathname.match(/^\/schedule-groups\/([^/]+)$/);
    const tagResource = url.pathname.match(/^\/tags\/(.+)$/);
    const decoded = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
    operation = url.pathname === "/schedules" ? "ListSchedules"
      : schedule ? req.method === "POST" ? "CreateSchedule" : req.method === "PUT" ? "UpdateSchedule" : req.method === "DELETE" ? "DeleteSchedule" : "GetSchedule"
      : url.pathname === "/schedule-groups" ? "ListScheduleGroups"
      : group ? req.method === "POST" ? "CreateScheduleGroup" : req.method === "DELETE" ? "DeleteScheduleGroup" : "GetScheduleGroup"
      : tagResource ? req.method === "POST" ? "TagResource" : req.method === "DELETE" ? "UntagResource" : "ListTagsForResource"
      : "Unknown";
    action = `scheduler:${operation}`;
    const groupName = String(input.GroupName ?? url.searchParams.get("scheduleGroup") ?? url.searchParams.get("groupName") ?? "default");
    if (schedule) resource = `arn:aws:scheduler:${region}:${accountId}:schedule/${groupName}/${decoded(schedule[1])}`;
    else if (group) resource = `arn:aws:scheduler:${region}:${accountId}:schedule-group/${decoded(group[1])}`;
    else if (tagResource) resource = decoded(tagResource[1]);
    if (new Set(["CreateSchedule", "UpdateSchedule"]).has(operation) && typeof input.Target?.RoleArn === "string") additionalTargets.push({ action: "iam:PassRole", resource: input.Target.RoleArn, operation: "PassRole", context: { "iam:PassedToService": "scheduler.amazonaws.com", "iam:AssociatedResourceArn": resource } });
    if (operation === "CreateScheduleGroup" && Array.isArray(input.Tags) && input.Tags.length) additionalTargets.push({ action: "scheduler:TagResource", resource, operation: "TagResource" });
  }
  else if (service === "events") {
    action = `events:${operation}`;
    const ruleActions = new Set(["PutRule", "DescribeRule", "DeleteRule", "EnableRule", "DisableRule", "PutTargets", "ListTargetsByRule", "RemoveTargets"]);
    if (operation === "CreateEventBus" || operation === "DescribeEventBus" || operation === "DeleteEventBus") {
      resource = eventBusTarget(input.Name, region, accountId).arn;
    } else if (operation === "PutEvents") {
      const entries = Array.isArray(input.Entries) ? input.Entries : [];
      if (entries.length) {
        resource = eventBusTarget(entries[0]?.EventBusName, region, accountId).arn;
        operationContext = putEventContext(entries[0]);
        for (const entry of entries.slice(1)) additionalTargets.push({ action, operation, resource: eventBusTarget(entry?.EventBusName, region, accountId).arn, context: putEventContext(entry) });
      }
    } else if (ruleActions.has(operation)) {
      resource = eventRuleArn(input.Name ?? input.Rule, input.EventBusName, region, accountId);
      operationContext["events:creatorAccount"] = accountId;
      if (operation === "PutRule") Object.assign(operationContext, eventPatternContext(input.EventPattern));
      if (operation === "PutRule" && Array.isArray(input.Tags) && input.Tags.length) additionalTargets.push({ action: "events:TagResource", resource, operation: "TagResource" });
      if (operation === "PutTargets" && Array.isArray(input.Targets)) {
        const roles = new Set<string>(input.Targets.map((candidate: any) => candidate?.RoleArn).filter((arn: unknown): arn is string => typeof arn === "string" && arn.length > 0));
        for (const roleArn of roles) additionalTargets.push({ action: "iam:PassRole", resource: roleArn, operation: "PassRole", context: { "iam:PassedToService": "events.amazonaws.com" } });
      }
      if (operation === "PutTargets") operationContext["events:TargetArn"] = Array.isArray(input.Targets) ? input.Targets.map((candidate: any) => candidate?.Arn).filter((arn: unknown): arn is string => typeof arn === "string") : [];
    } else if (new Set(["CreateArchive", "DescribeArchive", "UpdateArchive", "DeleteArchive"]).has(operation) && typeof input.ArchiveName === "string") {
      resource = `arn:aws:events:${region}:${accountId}:archive/${input.ArchiveName}`;
    } else if (operation === "StartReplay" && typeof input.EventSourceArn === "string") {
      resource = input.EventSourceArn;
    } else if (new Set(["DescribeReplay", "CancelReplay"]).has(operation) && typeof input.ReplayName === "string") {
      resource = `arn:aws:events:${region}:${accountId}:replay/${input.ReplayName}`;
    } else if (operation === "TagResource" || operation === "UntagResource" || operation === "ListTagsForResource") {
      resource = typeof input.ResourceARN === "string" ? input.ResourceARN : "*";
      if (resource.includes(":rule/")) operationContext["events:creatorAccount"] = accountId;
    }
  }
  else if (service === "cognito-idp") {
    action = `cognito-idp:${operation}`;
    const resourceArn = input.ResourceArn;
    const userPoolId = input.UserPoolId;
    const partition = region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
    resource = typeof resourceArn === "string"
      ? resourceArn
      : typeof userPoolId === "string"
        ? `arn:${partition}:cognito-idp:${region}:${accountId}:userpool/${userPoolId}`
        : "*";
  }
  else if (service === "logs") { action = `logs:${operation}`; if (input.logGroupName) resource = `arn:aws:logs:${region}:${accountId}:log-group:${input.logGroupName}${input.logStreamName ? `:log-stream:${input.logStreamName}` : ":*"}`; else if (input.resourceArn) resource = input.resourceArn; else if (input.destinationName) resource = `arn:aws:logs:${region}:${accountId}:destination:${input.destinationName}`; }
  else if (service === "lambda") {
    const tagArn = url.pathname.match(/^\/2017-03-31\/tags\/(.+)$/)?.[1]; const accountSettings = url.pathname === "/2016-08-19/account-settings"; const layerMatch = url.pathname.match(/^\/2018-10-31\/layers(?:\/([^/]+)\/versions(?:\/(\d+)(?:\/policy(?:\/([^/]+))?)?)?)?$/); const codeSigningMatch = url.pathname.match(/^\/2020-04-22\/code-signing-configs(?:\/(.+?)(\/functions)?)?$/); const capacityMatch = url.pathname.match(/^\/2025-11-30\/capacity-providers(?:\/([^/]+)(\/function-versions)?)?$/); const durableExecutionMatch = url.pathname.match(/^\/2025-12-01\/durable-executions\/([^/]+)(?:\/(history|state|checkpoint|stop))?$/); const durableListMatch = url.pathname.match(/^\/2025-12-01\/functions\/([^/]+)\/durable-executions$/); const durableCallbackMatch = url.pathname.match(/^\/2025-12-01\/durable-execution-callbacks\/([^/]+)\/(succeed|fail|heartbeat)$/); const functionMatch = url.pathname.match(/^\/(?:2014-11-13|2015-03-31|2017-10-31|2019-09-25|2019-09-30|2020-06-30|2021-07-20|2021-10-31|2021-11-15|2024-08-31|2025-11-30)\/functions\/([^/]+)/); const name = functionMatch?.[1]; const suffix = name ? url.pathname.slice(url.pathname.indexOf(`/${name}`) + name.length + 1) : "";
    const eventMapping = url.pathname.match(/^\/2015-03-31\/event-source-mappings(?:\/([^/]+))?$/); const eventConfig = suffix.startsWith("/event-invoke-config"); const functionConcurrency = suffix === "/concurrency"; const provisionedConcurrency = suffix === "/provisioned-concurrency"; const functionUrl = suffix === "/url" || suffix === "/urls"; const responseStream = suffix === "/response-streaming-invocations"; const functionCodeSigning = suffix === "/code-signing-config"; const runtimeManagement = suffix === "/runtime-management-config"; const recursionConfig = suffix === "/recursion-config";
    operation = codeSigningMatch ? !codeSigningMatch[1] ? req.method === "POST" ? "CreateCodeSigningConfig" : "ListCodeSigningConfigs" : codeSigningMatch[2] ? "ListFunctionsByCodeSigningConfig" : req.method === "PUT" ? "UpdateCodeSigningConfig" : req.method === "DELETE" ? "DeleteCodeSigningConfig" : "GetCodeSigningConfig" : layerMatch ? !layerMatch[1] ? url.searchParams.get("find") === "LayerVersion" ? "GetLayerVersionByArn" : "ListLayers" : !layerMatch[2] ? req.method === "POST" ? "PublishLayerVersion" : "ListLayerVersions" : url.pathname.includes("/policy/") ? "RemoveLayerVersionPermission" : url.pathname.endsWith("/policy") ? req.method === "POST" ? "AddLayerVersionPermission" : "GetLayerVersionPolicy" : req.method === "DELETE" ? "DeleteLayerVersion" : "GetLayerVersion" : accountSettings ? "GetAccountSettings" : eventMapping ? !eventMapping[1] ? req.method === "POST" ? "CreateEventSourceMapping" : "ListEventSourceMappings" : req.method === "PUT" ? "UpdateEventSourceMapping" : req.method === "DELETE" ? "DeleteEventSourceMapping" : "GetEventSourceMapping" : tagArn ? req.method === "GET" ? "ListTags" : req.method === "POST" ? "TagResource" : "UntagResource" : !name && req.method === "POST" ? "CreateFunction" : !name ? "ListFunctions" : functionCodeSigning ? req.method === "PUT" ? "PutFunctionCodeSigningConfig" : req.method === "DELETE" ? "DeleteFunctionCodeSigningConfig" : "GetFunctionCodeSigningConfig" : runtimeManagement ? req.method === "PUT" ? "PutRuntimeManagementConfig" : "GetRuntimeManagementConfig" : recursionConfig ? req.method === "PUT" ? "PutFunctionRecursionConfig" : "GetFunctionRecursionConfig" : responseStream ? "InvokeWithResponseStream" : functionUrl ? suffix === "/urls" ? "ListFunctionUrlConfigs" : req.method === "POST" ? "CreateFunctionUrlConfig" : req.method === "PUT" ? "UpdateFunctionUrlConfig" : req.method === "DELETE" ? "DeleteFunctionUrlConfig" : "GetFunctionUrlConfig" : suffix.startsWith("/invocations") || suffix === "/invoke-async" ? "InvokeFunction" : functionConcurrency ? req.method === "PUT" ? "PutFunctionConcurrency" : req.method === "DELETE" ? "DeleteFunctionConcurrency" : "GetFunctionConcurrency" : provisionedConcurrency ? req.method === "PUT" ? "PutProvisionedConcurrencyConfig" : req.method === "DELETE" ? "DeleteProvisionedConcurrencyConfig" : url.searchParams.get("List") === "ALL" ? "ListProvisionedConcurrencyConfigs" : "GetProvisionedConcurrencyConfig" : eventConfig ? suffix.endsWith("/list") ? "ListFunctionEventInvokeConfigs" : req.method === "PUT" ? "PutFunctionEventInvokeConfig" : req.method === "POST" ? "UpdateFunctionEventInvokeConfig" : req.method === "DELETE" ? "DeleteFunctionEventInvokeConfig" : "GetFunctionEventInvokeConfig" : suffix === "/code" ? "UpdateFunctionCode" : suffix === "/configuration" && req.method === "PUT" ? "UpdateFunctionConfiguration" : suffix === "/configuration" ? "GetFunctionConfiguration" : suffix === "/versions" ? req.method === "POST" ? "PublishVersion" : "ListVersionsByFunction" : suffix === "/aliases" ? req.method === "POST" ? "CreateAlias" : "ListAliases" : suffix.startsWith("/aliases/") ? req.method === "PUT" ? "UpdateAlias" : req.method === "DELETE" ? "DeleteAlias" : "GetAlias" : suffix === "/policy" ? req.method === "POST" ? "AddPermission" : "GetPolicy" : suffix.startsWith("/policy/") ? "RemovePermission" : req.method === "DELETE" ? "DeleteFunction" : "GetFunction";
    action = `lambda:${responseStream ? "InvokeFunction" : operation}`; if (codeSigningMatch?.[1]) resource = decodeURIComponent(codeSigningMatch[1]); else if (layerMatch) { if (url.searchParams.get("find") === "LayerVersion") resource = url.searchParams.get("Arn") ?? "*"; else if (layerMatch[1]) { const decoded = decodeURIComponent(layerMatch[1]); resource = decoded.startsWith("arn:") ? decoded : `arn:aws:lambda:${region}:${accountId}:layer:${decoded}`; if (layerMatch[2]) resource += `:${layerMatch[2]}`; } } else if (tagArn) resource = decodeURIComponent(tagArn); else if (eventMapping && input.FunctionName) { const target = String(input.FunctionName); resource = target.startsWith("arn:") ? target : `arn:aws:lambda:${region}:${accountId}:function:${target}`; } else if (name) { const decoded = decodeURIComponent(name); resource = decoded.startsWith("arn:") ? decoded : `arn:aws:lambda:${region}:${accountId}:function:${decoded}`; if ((provisionedConcurrency || functionUrl || responseStream || runtimeManagement || suffix === "/function-scaling-config") && url.searchParams.get("Qualifier")) resource += `:${url.searchParams.get("Qualifier")}`; }
    if (durableExecutionMatch) {
      const suffixOperation: Record<string, string> = { history: "GetDurableExecutionHistory", state: "GetDurableExecutionState", checkpoint: "CheckpointDurableExecution", stop: "StopDurableExecution" }; operation = durableExecutionMatch[2] ? suffixOperation[durableExecutionMatch[2]] : "GetDurableExecution"; action = `lambda:${operation}`; resource = decodeURIComponent(durableExecutionMatch[1]);
    } else if (durableListMatch) {
      operation = "ListDurableExecutionsByFunction"; action = `lambda:${operation}`; const decoded = decodeURIComponent(durableListMatch[1]); resource = decoded.startsWith("arn:") ? decoded : `arn:aws:lambda:${region}:${accountId}:function:${decoded}`; const qualifier = url.searchParams.get("Qualifier"); if (qualifier && !resource.endsWith(`:${qualifier}`)) resource += `:${qualifier}`;
    } else if (durableCallbackMatch) {
      operation = durableCallbackMatch[2] === "succeed" ? "SendDurableExecutionCallbackSuccess" : durableCallbackMatch[2] === "fail" ? "SendDurableExecutionCallbackFailure" : "SendDurableExecutionCallbackHeartbeat"; action = `lambda:${operation}`; resource = "*";
    } else if (capacityMatch) {
      operation = !capacityMatch[1] ? req.method === "POST" ? "CreateCapacityProvider" : "ListCapacityProviders" : capacityMatch[2] ? "ListFunctionVersionsByCapacityProvider" : req.method === "PUT" ? "UpdateCapacityProvider" : req.method === "DELETE" ? "DeleteCapacityProvider" : "GetCapacityProvider";
      action = `lambda:${operation}`; resource = capacityMatch[1] ? `arn:aws:lambda:${region}:${accountId}:capacity-provider:${decodeURIComponent(capacityMatch[1])}` : "*";
    } else if (suffix === "/function-scaling-config") { operation = req.method === "PUT" ? "PutFunctionScalingConfig" : "GetFunctionScalingConfig"; action = `lambda:${operation}`; }
  } else if (service === "ses") {
    if (url.searchParams.size) input = { ...parseAwsQuery(url.searchParams), ...input };
    const v2Operation = url.pathname.startsWith("/v2/email/") ? resolveSesV2Operation(req.method, url.pathname) : undefined;
    operation = String(v2Operation ?? input.Action ?? operation);
    action = `ses:${operation}`;
    const decode = (value: string | undefined) => {
      if (!value) return undefined;
      try { return decodeURIComponent(value); } catch { return value; }
    };
    const identityPath = url.pathname.match(/^\/v2\/email\/identities\/([^/]+)/)?.[1];
    const templatePath = url.pathname.match(/^\/v2\/email\/templates\/([^/]+)/)?.[1];
    const configurationPath = url.pathname.match(/^\/v2\/email\/configuration-sets\/([^/]+)/)?.[1];
    const customVerificationPath = url.pathname.match(/^\/v2\/email\/custom-verification-email-templates\/([^/]+)/)?.[1];
    const contactListPath = url.pathname.match(/^\/v2\/email\/contact-lists\/([^/]+)/)?.[1];
    const tagArn = input.ResourceArn ?? input.ResourceARN;
    const source = input.FromEmailAddress ?? input.Source;
    const sourceAddress = typeof source === "string" ? source.match(/<([^<>]+)>/)?.[1] ?? source.trim() : undefined;
    const identityName = decode(identityPath) ?? input.EmailIdentity ?? (typeof sourceAddress === "string" ? sourceAddress : undefined);
    const templateName = decode(templatePath) ?? input.TemplateName ?? input.Template?.TemplateName ?? (operation === "SendTemplatedEmail" ? input.Template : undefined);
    const configurationName = decode(configurationPath) ?? input.ConfigurationSetName ?? input.ConfigurationSet?.Name;
    if (typeof tagArn === "string") resource = tagArn;
    else if (typeof input.FromEmailAddressIdentityArn === "string") resource = input.FromEmailAddressIdentityArn;
    else if (typeof input.SourceArn === "string") resource = input.SourceArn;
    else if (identityName && new Set(["CreateEmailIdentity", "GetEmailIdentity", "DeleteEmailIdentity", "PutEmailIdentityConfigurationSetAttributes", "PutEmailIdentityDkimAttributes", "PutEmailIdentityDkimSigningAttributes", "PutEmailIdentityFeedbackAttributes", "PutEmailIdentityMailFromAttributes", "CreateEmailIdentityPolicy", "UpdateEmailIdentityPolicy", "GetEmailIdentityPolicies", "DeleteEmailIdentityPolicy", "VerifyEmailIdentity", "VerifyEmailAddress", "DeleteIdentity", "DeleteVerifiedEmailAddress", "PutIdentityPolicy", "GetIdentityPolicies", "ListIdentityPolicies", "DeleteIdentityPolicy", "SetIdentityDkimEnabled", "SetIdentityMailFromDomain", "SetIdentityFeedbackForwardingEnabled", "SetIdentityHeadersInNotificationsEnabled", "SetIdentityNotificationTopic", "SendEmail", "SendRawEmail", "SendTemplatedEmail", "SendBulkTemplatedEmail", "SendBulkEmail"]).has(operation)) resource = `arn:aws:ses:${region}:${accountId}:identity/${identityName}`;
    else if (customVerificationPath || operation.includes("CustomVerificationEmailTemplate")) resource = `arn:aws:ses:${region}:${accountId}:custom-verification-email-template/${decode(customVerificationPath) ?? input.TemplateName ?? "*"}`;
    else if (contactListPath || /Contact(List)?$|Contacts$/.test(operation)) resource = `arn:aws:ses:${region}:${accountId}:contact-list/${decode(contactListPath) ?? input.ContactListName ?? "*"}`;
    else if (templateName && /Template/.test(operation)) resource = `arn:aws:ses:${region}:${accountId}:template/${templateName}`;
    else if (configurationName && /ConfigurationSet/.test(operation)) resource = `arn:aws:ses:${region}:${accountId}:configuration-set/${configurationName}`;
    const destination = input.Destination ?? {};
    const recipients = [
      ...(Array.isArray(destination.ToAddresses) ? destination.ToAddresses : []),
      ...(Array.isArray(destination.CcAddresses) ? destination.CcAddresses : []),
      ...(Array.isArray(destination.BccAddresses) ? destination.BccAddresses : []),
      ...(Array.isArray(input.Destinations) ? input.Destinations : []),
    ].map(String);
    if (recipients.length) operationContext["ses:Recipients"] = recipients;
    if (sourceAddress) {
      operationContext["ses:FromAddress"] = sourceAddress;
      const display = typeof source === "string" ? source.match(/^\s*(.*?)\s*</)?.[1]?.replace(/^"|"$/g, "") : undefined;
      if (display) operationContext["ses:FromDisplayName"] = display;
    }
    const feedback = input.FeedbackForwardingEmailAddress ?? input.ReturnPath;
    if (feedback) operationContext["ses:FeedbackAddress"] = feedback;
    operationContext["ses:ApiVersion"] = v2Operation ? "2019-09-27" : "2010-12-01";
  } else if (service === "apigateway") { action = `apigateway:${req.method}`; resource = `arn:aws:apigateway:${region}::${url.pathname}`; operation = `${req.method} ${url.pathname}`; }
  else if (service === "cloudformation") {
    if (url.searchParams.size) input = { ...parseAwsQuery(url.searchParams, { coerceTimestamps: false }), ...input };
    operation = String(input.Action ?? operation); action = `cloudformation:${operation}`;
    const stackName = input.StackName ?? input.StackId;
    if (typeof stackName === "string" && stackName.startsWith("arn:aws:cloudformation:")) resource = stackName;
    else if (stackName) resource = `arn:aws:cloudformation:${region}:${accountId}:stack/${stackName}/*`;
    const roleArn = input.RoleARN ?? input.RoleArn;
    if (typeof roleArn === "string" && roleArn) additionalTargets.push({ action: "iam:PassRole", resource: roleArn, operation: "PassRole", context: { "iam:PassedToService": "cloudformation.amazonaws.com" } });
    const requestTags = Array.isArray(input.Tags) ? input.Tags : [];
    if (requestTags.length) operationContext["aws:TagKeys"] = requestTags.map((tag: any) => tag?.Key).filter(Boolean);
    for (const tag of requestTags) if (tag?.Key) operationContext[`aws:RequestTag/${tag.Key}`] = tag.Value;
  }
  else if (service === "ssm") {
    action = `ssm:${operation}`;
    const suppliedTags = Array.isArray(input.Tags) ? input.Tags : [];
    const names = new Set(["GetParameters", "DeleteParameters"]).has(operation) && Array.isArray(input.Names)
      ? input.Names.filter((name: unknown): name is string => typeof name === "string" && name.length > 0)
      : typeof (input.Name ?? input.ResourceId ?? input.Path) === "string" && (input.Name ?? input.ResourceId ?? input.Path) ? [input.Name ?? input.ResourceId ?? input.Path] : [];
    if (names.length) {
      resource = ssmParameterArn(region, accountId, names[0]);
      for (const name of names.slice(1)) additionalTargets.push({ action, resource: ssmParameterArn(region, accountId, name), operation });
    }
    if (operation === "DescribeParameters") resource = "*";
    if (operation === "GetParametersByPath") operationContext["ssm:Recursive"] = String(input.Recursive === true);
    if (operation === "PutParameter") {
      operationContext["ssm:Overwrite"] = String(input.Overwrite === true);
      operationContext["ssm:Policies"] = input.Policies ?? "";
      if (suppliedTags.length) {
        const tagContext: Record<string, unknown> = { "aws:TagKeys": suppliedTags.map((tag: any) => tag?.Key).filter(Boolean) };
        for (const tag of suppliedTags) if (tag?.Key) tagContext[`aws:RequestTag/${tag.Key}`] = tag.Value;
        additionalTargets.push({ action: "ssm:AddTagsToResource", resource, operation: "AddTagsToResource", context: tagContext });
      }
    }
    operationContext["aws:TagKeys"] = operation === "RemoveTagsFromResource" ? (input.TagKeys ?? []) : suppliedTags.map((tag: any) => tag?.Key).filter(Boolean);
    for (const tag of suppliedTags) if (tag?.Key) operationContext[`aws:RequestTag/${tag.Key}`] = tag.Value;
  }
  else if (service === "secretsmanager") {
    action = `secretsmanager:${operation}`;
    const listOperation = operation === "ListSecrets" || operation === "GetRandomPassword" || operation === "BatchGetSecretValue";
    resource = listOperation ? "*" : secretsManagerArn(region, accountId, operation === "CreateSecret" ? input.Name : input.SecretId);
    const suppliedTags = Array.isArray(input.Tags) ? input.Tags : [];
    const tagKeys = operation === "UntagResource"
      ? (Array.isArray(input.TagKeys) ? input.TagKeys.map(String) : [])
      : suppliedTags.map((tag: any) => tag?.Key).filter(Boolean);
    operationContext["aws:TagKeys"] = tagKeys;
    for (const tag of suppliedTags) if (tag?.Key) operationContext[`aws:RequestTag/${tag.Key}`] = tag.Value;
    if (input.VersionId !== undefined) operationContext["secretsmanager:VersionId"] = input.VersionId;
    if (input.VersionStage !== undefined) operationContext["secretsmanager:VersionStage"] = input.VersionStage;
    else if (operation === "GetSecretValue") operationContext["secretsmanager:VersionStage"] = "AWSCURRENT";
    if (operation === "DeleteSecret") {
      operationContext["secretsmanager:ForceDeleteWithoutRecovery"] = String(input.ForceDeleteWithoutRecovery === true);
      if (input.RecoveryWindowInDays !== undefined) operationContext["secretsmanager:RecoveryWindowInDays"] = input.RecoveryWindowInDays;
    }
    if (operation === "CreateSecret" && suppliedTags.length) {
      const tagContext: Record<string, unknown> = { "aws:TagKeys": tagKeys };
      for (const tag of suppliedTags) if (tag?.Key) tagContext[`aws:RequestTag/${tag.Key}`] = tag.Value;
      additionalTargets.push({ action: "secretsmanager:TagResource", resource, operation: "TagResource", context: tagContext });
    }
    if (operation === "BatchGetSecretValue" && input.Filters !== undefined) additionalTargets.push({ action: "secretsmanager:ListSecrets", resource: "*", operation: "ListSecrets" });
    if (operation === "ValidateResourcePolicy") additionalTargets.push({ action: "secretsmanager:PutResourcePolicy", resource, operation: "PutResourcePolicy" });
  }
  else if (service === "iam") {
    operation = String(input.Action); action = `iam:${operation}`;
    const resolved = resolveIamAuthorizationTarget(operation, input, accountId, principal, iam);
    resource = resolved.resource;
    Object.assign(operationContext, resolved.context);
  }
  else if (service === "sts") {
    operation = String(input.Action); action = `sts:${operation}`; resource = input.RoleArn ?? "*";
    if (operation === "AssumeRole") {
      const suppliedTags = Array.isArray(input.Tags) ? input.Tags : input.Tags === undefined ? [] : [input.Tags];
      const requestTags = Object.fromEntries(suppliedTags.filter((tag: any) => tag?.Key !== undefined).map((tag: any) => [String(tag.Key), String(tag.Value ?? "")]));
      const tagKeys = Object.keys(requestTags);
      const transitiveTagKeys = Array.isArray(input.TransitiveTagKeys) ? input.TransitiveTagKeys.map(String) : input.TransitiveTagKeys === undefined ? [] : [String(input.TransitiveTagKeys)];
      if (tagKeys.length) operationContext["aws:TagKeys"] = tagKeys;
      if (transitiveTagKeys.length) operationContext["sts:TransitiveTagKeys"] = transitiveTagKeys;
      for (const [key, value] of Object.entries(requestTags)) operationContext[`aws:RequestTag/${key}`] = value;
      const inherited = (principal.transitiveTagKeys ?? []).some(key => Object.keys(principal.sessionTags ?? {}).some(tag => tag.toLowerCase() === key.toLowerCase()));
      if (tagKeys.length || transitiveTagKeys.length || inherited) additionalTargets.push({ action: "sts:TagSession", resource, operation: "TagSession", context: { ...operationContext } });
      const sourceIdentity = input.SourceIdentity === undefined ? principal.sourceIdentity : String(input.SourceIdentity);
      if (sourceIdentity !== undefined) {
        operationContext["sts:SourceIdentity"] = sourceIdentity;
        additionalTargets.push({ action: "sts:SetSourceIdentity", resource, operation: "SetSourceIdentity", context: { ...operationContext } });
      }
    }
  }
  else if (service === "sns") {
    operation = String(input.Action);
    action = `sns:${operation === "PublishBatch" ? "Publish" : operation}`;
    resource = input.TopicArn ?? input.ResourceArn ?? (typeof input.SubscriptionArn === "string" ? input.SubscriptionArn.replace(/:[^:]+$/, "") : "*");
    const suppliedTags = Array.isArray(input.Tags) ? input.Tags : [];
    operationContext["aws:TagKeys"] = operation === "UntagResource"
      ? (Array.isArray(input.TagKeys) ? input.TagKeys.map(String) : input.TagKeys === undefined ? [] : [String(input.TagKeys)])
      : suppliedTags.map((tag: any) => tag?.Key).filter(Boolean);
    for (const tag of suppliedTags) if (tag?.Key) operationContext[`aws:RequestTag/${tag.Key}`] = tag.Value;
    operationContext["sns:Protocol"] = input.Protocol;
    operationContext["sns:Endpoint"] = input.Endpoint;
    const topicAttributes = input.Attributes && typeof input.Attributes === "object" && !Array.isArray(input.Attributes)
      ? input.Attributes as Record<string, unknown>
      : {};
    const roleArns = [
      ...(operation === "SetTopicAttributes" && /FeedbackRoleArn$/.test(String(input.AttributeName ?? "")) ? [input.AttributeValue] : []),
      ...Object.entries(topicAttributes).filter(([name]) => /FeedbackRoleArn$/.test(name)).map(([, value]) => value),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const roleArn of roleArns) additionalTargets.push({
      action: "iam:PassRole",
      resource: roleArn,
      operation: "PassRole",
      context: { "iam:PassedToService": "sns.amazonaws.com", "aws:RequestedRegion": region },
    });
  }
  else if (service === "monitoring") { operation = target ?? String(input.Action); action = `cloudwatch:${operation}`; const alarmName = input.AlarmName ?? (Array.isArray(input.AlarmNames) && input.AlarmNames.length === 1 ? input.AlarmNames[0] : undefined); const muteRuleName = operation === "PutAlarmMuteRule" ? input.Name : input.AlarmMuteRuleName; const dashboardName = input.DashboardName ?? (Array.isArray(input.DashboardNames) && input.DashboardNames.length === 1 ? input.DashboardNames[0] : undefined); const dataset = input.DatasetIdentifier ? `arn:aws:cloudwatch:${region}:${accountId}:dataset/default` : undefined; const metricStreamName = input.Name ?? (Array.isArray(input.Names) && input.Names.length === 1 ? input.Names[0] : undefined); const insightRuleName = input.RuleName ?? (Array.isArray(input.RuleNames) && input.RuleNames.length === 1 ? input.RuleNames[0] : undefined); resource = input.ResourceARN ?? (alarmName ? `arn:aws:cloudwatch:${region}:${accountId}:alarm:${alarmName}` : muteRuleName ? `arn:aws:cloudwatch:${region}:${accountId}:alarm-mute-rule:${muteRuleName}` : dashboardName ? `arn:aws:cloudwatch::${accountId}:dashboard/${dashboardName}` : dataset ?? (insightRuleName ? `arn:aws:cloudwatch:${region}:${accountId}:insight-rule/${insightRuleName}` : metricStreamName ? `arn:aws:cloudwatch:${region}:${accountId}:metric-stream/${metricStreamName}` : "*")); }
  else if (service === "appsync") {
    const decode = (value: string | undefined): string | undefined => {
      if (value === undefined) return undefined;
      try { return decodeURIComponent(value); } catch { return value; }
    };
    const tagsMatch = url.pathname.match(/^\/v1\/tags\/([^/]+)$/);
    const apiMatch = url.pathname.match(/^\/v1\/apis\/([^/]+)/);
    const apiId = decode(apiMatch?.[1]);
    const apiArn = apiId ? `arn:aws:appsync:${region}:${accountId}:apis/${apiId}` : "*";
    resource = tagsMatch ? decode(tagsMatch[1]) ?? "*" : apiArn;
    const keyItem = url.pathname.match(/^\/v1\/apis\/[^/]+\/apikeys\/[^/]+$/);
    const dataSourceItem = url.pathname.match(/^\/v1\/apis\/[^/]+\/datasources\/([^/]+)$/);
    const dataSources = url.pathname.match(/^\/v1\/apis\/[^/]+\/datasources$/);
    const functionResolvers = url.pathname.match(/^\/v1\/apis\/[^/]+\/functions\/[^/]+\/resolvers$/);
    const functionItem = url.pathname.match(/^\/v1\/apis\/[^/]+\/functions\/[^/]+$/);
    const functions = url.pathname.match(/^\/v1\/apis\/[^/]+\/functions$/);
    const resolverItem = url.pathname.match(/^\/v1\/apis\/[^/]+\/types\/([^/]+)\/resolvers\/([^/]+)$/);
    const resolvers = url.pathname.match(/^\/v1\/apis\/[^/]+\/types\/([^/]+)\/resolvers$/);
    if (url.pathname === "/v1/dataplane-evaluatetemplate") {
      operation = "EvaluateMappingTemplate";
      resource = "*";
    }
    else if (tagsMatch) operation = req.method === "POST" ? "TagResource" : req.method === "DELETE" ? "UntagResource" : "ListTagsForResource";
    else if (url.pathname === "/v1/apis") operation = req.method === "POST" ? "CreateGraphqlApi" : "ListGraphqlApis";
    else if (/\/schemacreation$/.test(url.pathname)) {
      operation = req.method === "POST" ? "StartSchemaCreation" : "GetSchemaCreationStatus";
      resource = "*";
    } else if (/\/schema$/.test(url.pathname)) {
      operation = "GetIntrospectionSchema";
      resource = "*";
    } else if (keyItem) {
      operation = req.method === "POST" ? "UpdateApiKey" : "DeleteApiKey";
      resource = "*";
    } else if (/\/apikeys$/.test(url.pathname)) {
      operation = req.method === "POST" ? "CreateApiKey" : "ListApiKeys";
      resource = "*";
    }
    else if (dataSourceItem) {
      operation = req.method === "POST" ? "UpdateDataSource" : req.method === "DELETE" ? "DeleteDataSource" : "GetDataSource";
      resource = "*";
    } else if (dataSources) {
      operation = req.method === "POST" ? "CreateDataSource" : "ListDataSources";
      resource = "*";
    } else if (functionResolvers) {
      operation = "ListResolversByFunction";
      resource = "*";
    } else if (functionItem) {
      operation = req.method === "POST" ? "UpdateFunction" : req.method === "DELETE" ? "DeleteFunction" : "GetFunction";
      resource = "*";
    } else if (functions) {
      operation = req.method === "POST" ? "CreateFunction" : "ListFunctions";
      resource = "*";
    } else if (resolverItem) {
      operation = req.method === "POST" ? "UpdateResolver" : req.method === "DELETE" ? "DeleteResolver" : "GetResolver";
      resource = "*";
    } else if (resolvers) {
      operation = req.method === "POST" ? "CreateResolver" : "ListResolvers";
      resource = "*";
    } else if (apiId) operation = req.method === "POST" ? "UpdateGraphqlApi" : req.method === "DELETE" ? "DeleteGraphqlApi" : "GetGraphqlApi";
    else operation = "Unknown";
    action = `appsync:${operation}`;
    const requestTags = operation === "CreateGraphqlApi" || operation === "TagResource" ? input.tags : undefined;
    if (requestTags && typeof requestTags === "object" && !Array.isArray(requestTags)) {
      operationContext["aws:TagKeys"] = Object.keys(requestTags);
      for (const [key, value] of Object.entries(requestTags)) operationContext[`aws:RequestTag/${key}`] = value;
    }
    if ((operation === "CreateDataSource" || operation === "UpdateDataSource")
      && typeof input.serviceRoleArn === "string") {
      additionalTargets.push({
        action: "iam:PassRole",
        resource: input.serviceRoleArn,
        operation: "PassRole",
        context: {
          "iam:PassedToService": "appsync.amazonaws.com",
          "aws:RequestedRegion": region,
        },
      });
    }
  }
  const context: Record<string, unknown> = { "aws:PrincipalArn": principal.principalArn, "aws:PrincipalAccount": principal.accountId, "aws:RequestedRegion": region, "aws:CurrentTime": new Date(now).toISOString(), "aws:SourceIp": req.socket.remoteAddress?.replace(/^::ffff:/, ""), "aws:UserAgent": req.headers["user-agent"] ?? "", "aws:SecureTransport": Boolean((req.socket as any).encrypted), "aws:TokenIssueTime": principal.issuedAt === undefined ? undefined : new Date(principal.issuedAt).toISOString(), "aws:SourceIdentity": principal.sourceIdentity, "aws:SourceArn": req.headers["x-aws-source-arn"], "aws:SourceAccount": req.headers["x-aws-source-account"], "aws:CalledVia": req.headers["x-aws-called-via"], ...operationContext };
  if (service === "s3") {
    context["s3:authType"] = url.searchParams.has("X-Amz-Signature") ? "REST-QUERY-STRING" : req.headers.authorization ? "REST-HEADER" : "ANONYMOUS";
    context["s3:signatureversion"] = req.headers.authorization || url.searchParams.has("X-Amz-Signature") ? "AWS4-HMAC-SHA256" : undefined;
    const date = String(req.headers["x-amz-date"] ?? url.searchParams.get("X-Amz-Date") ?? "");
    const match = date.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (match) context["s3:signatureAge"] = Math.max(0, now - Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]));
  }
  if (service === "dynamodb") { const tags = Array.isArray(input.Tags) ? input.Tags : []; context["aws:TagKeys"] = operation === "UntagResource" ? input.TagKeys : tags.map((tag: any) => tag?.Key).filter(Boolean); for (const tag of tags) if (tag?.Key) context[`aws:RequestTag/${tag.Key}`] = tag.Value; if (new Set(["ExecuteStatement", "BatchExecuteStatement", "ExecuteTransaction"]).has(operation)) context["dynamodb:EnclosingOperation"] = operation; }
  if (service === "rds") { const tagContainer = input.Tags?.Tag ?? input.Tags; const tags = Array.isArray(tagContainer) ? tagContainer : tagContainer ? [tagContainer] : []; const removed = input.TagKeys?.member ?? input.TagKeys; context["aws:TagKeys"] = operation === "RemoveTagsFromResource" ? (Array.isArray(removed) ? removed.map(String) : removed === undefined ? [] : [String(removed)]) : tags.map((tag: any) => tag?.Key).filter(Boolean); for (const tag of tags) if (tag?.Key) context[`aws:RequestTag/${tag.Key}`] = tag.Value; }
  if (service === "sqs") {
    const rawTags = input.tags ?? input.Tags ?? input.Tag;
    const tags: Record<string, string> = Array.isArray(rawTags) ? Object.fromEntries(rawTags.filter((tag: any) => tag?.Key).map((tag: any) => [String(tag.Key), String(tag.Value ?? "")])) : rawTags && typeof rawTags === "object" ? rawTags : {};
    const rawTagKeys = input.TagKeys ?? input.TagKey;
    const tagKeys = operation === "UntagQueue" ? (Array.isArray(rawTagKeys) ? rawTagKeys.map(String) : rawTagKeys === undefined ? [] : [String(rawTagKeys)]) : Object.keys(tags);
    context["aws:TagKeys"] = tagKeys;
    for (const [key, value] of Object.entries(tags)) context[`aws:RequestTag/${key}`] = value;
  }
  if (service === "events") {
    const tags = eventRequestTags(input);
    const rawTagKeys = input.TagKeys;
    const tagKeys = operation === "UntagResource" ? (Array.isArray(rawTagKeys) ? rawTagKeys.map(String) : []) : Object.keys(tags);
    if (tagKeys.length) context["aws:TagKeys"] = tagKeys;
    for (const [key, value] of Object.entries(tags)) context[`aws:RequestTag/${key}`] = value;
  }
  if (service === "scheduler") {
    const supplied = Array.isArray(input.Tags) ? input.Tags : [];
    const tagKeys = operation === "UntagResource" ? (Array.isArray(input.TagKeys) ? input.TagKeys.map(String) : []) : supplied.map((tag: any) => tag?.Key).filter(Boolean);
    if (tagKeys.length) context["aws:TagKeys"] = tagKeys;
    for (const tag of supplied) if (tag?.Key) context[`aws:RequestTag/${tag.Key}`] = String(tag.Value ?? "");
  }
  if (service === "ses") {
    const supplied = input.Tags?.member ?? input.Tags;
    const tags = Array.isArray(supplied) ? supplied : supplied ? [supplied] : [];
    const rawTagKeys = input.TagKeys?.member ?? input.TagKeys;
    const tagKeys = operation === "UntagResource" ? (Array.isArray(rawTagKeys) ? rawTagKeys.map(String) : rawTagKeys === undefined ? [] : [String(rawTagKeys)]) : tags.map((tag: any) => tag?.Key).filter(Boolean);
    if (tagKeys.length) context["aws:TagKeys"] = tagKeys;
    for (const tag of tags) if (tag?.Key) context[`aws:RequestTag/${tag.Key}`] = String(tag.Value ?? "");
    if (tags.length && resource.startsWith("arn:") && new Set(["CreateEmailIdentity", "CreateEmailTemplate", "CreateConfigurationSet", "CreateCustomVerificationEmailTemplate", "CreateContactList"]).has(operation)) {
      additionalTargets.push({ action: "ses:TagResource", resource, operation: "TagResource" });
    }
  }
  if (
    service === "cognito-idp"
    && new Set(["CreateUserPool", "TagResource", "UntagResource"]).has(operation)
  ) {
    const suppliedTags = operation === "CreateUserPool" ? input.UserPoolTags : input.Tags;
    const requestTags = suppliedTags && typeof suppliedTags === "object" && !Array.isArray(suppliedTags)
      ? suppliedTags as Record<string, unknown>
      : {};
    const tagKeys = operation === "UntagResource"
      ? Array.isArray(input.TagKeys) ? input.TagKeys.map(String) : []
      : Object.keys(requestTags);
    context["aws:TagKeys"] = tagKeys;
    for (const [key, value] of Object.entries(requestTags)) {
      context[`aws:RequestTag/${key}`] = String(value);
    }
  }
  for (const [key, value] of Object.entries(principal.principalTags ?? principal.sessionTags ?? {})) context[`aws:PrincipalTag/${key}`] = value;
  const tableResource = (value: string) => value.match(/^(arn:[^:]+:dynamodb:[^:]+:\d{12}:table\/[^/]+)/)?.[1]; const primaryTable = tableResource(resource);
  return {
    action, resource, operation, input, context,
    additionalTargets: additionalTargets.map(target => {
      let additionalContext = service === "dynamodb" && tableResource(target.resource) !== primaryTable ? { ...context } : context;
      if (target.context) {
        additionalContext = { ...context };
        for (const key of Object.keys(operationContext)) delete additionalContext[key];
        Object.assign(additionalContext, target.context);
      }
      return { action: target.action, resource: target.resource, operation: target.operation, input: {}, context: additionalContext };
    }),
  };
}

export function executeApiTarget(req: IncomingMessage, pathname: string, region: string, accountId: string, principal: PrincipalContext, now: number): AuthorizationTarget {
  const [, apiId = "*", stage = "*", ...path] = pathname.split("/"); const method = req.method ?? "GET"; return { action: "execute-api:Invoke", resource: `arn:aws:execute-api:${region}:${accountId}:${apiId}/${stage}/${method}/${path.join("/")}`, operation: "Invoke", input: {}, context: { "aws:PrincipalArn": principal.principalArn, "aws:PrincipalAccount": accountId, "aws:RequestedRegion": region, "aws:CurrentTime": new Date(now).toISOString(), "aws:TokenIssueTime": principal.issuedAt === undefined ? undefined : new Date(principal.issuedAt).toISOString(), "aws:SourceIdentity": principal.sourceIdentity, "aws:SourceIp": req.socket.remoteAddress?.replace(/^::ffff:/, ""), "aws:UserAgent": req.headers["user-agent"] ?? "", "aws:SecureTransport": Boolean((req.socket as any).encrypted) } };
}
