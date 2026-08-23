import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import type { Clock } from "./core/clock.js";
import type { Scheduler } from "./core/scheduler.js";
import type { TelemetryBus } from "./core/telemetry.js";
import type { LambdaService } from "./lambda.js";
import type { SqsService } from "./sqs.js";
import type { EventBridgeService } from "./eventbridge.js";
import { PaginationTokens } from "./core/pagination.js";
import { AwsError } from "./errors.js";
import type { PrincipalContext } from "./auth/sigv4.js";
import { restXml, sendS3Error, xmlDecode, xmlEscape, xmlValue } from "./protocols/rest-xml.js";
import type { StateStore } from "./state.js";
import type { PolicyDocument, S3BucketState } from "./types.js";
import { combineIdentityAndResourceAuthorization, evaluateResourcePolicy, type AuthorizationContext, type AuthorizationResult } from "./iam/evaluator.js";
import { readBody } from "./util.js";
import { checksumHeaderName, providedChecksumAlgorithms, requestedChecksumAlgorithm, S3_CHECKSUM_ALGORITHMS, S3Checksums, type S3ChecksumAlgorithm, type S3ChecksumValues, validateProvidedChecksums } from "./s3/checksums.js";
import { S3Storage, type S3BucketIndex, type S3MultipartUploadState, type S3ObjectPartState, type S3ObjectVersionState, type StagedS3Object } from "./s3/storage.js";
import { aclAllows, aclFromRequest, aclIsPublic, aclXml, canonicalOwnerId, effectivePublicAccessBlock, LOCAL_OWNER_DISPLAY_NAME, objectAcl, policyIsPublic, privateAcl, type S3PublicAccessBlockState } from "./s3/access.js";
import { DYNAMODB_S3_SERVICE_PRINCIPAL, type S3AdmittedBucket, type S3PinnedObject, type S3TransferCaller, type S3TransferPort, type S3TransferWriteOptions } from "./s3/transfer-port.js";
import { CLOUDFRONT_S3_SERVICE_PRINCIPAL, type CloudFrontS3OriginPort, type CloudFrontS3OriginRequest, type CloudFrontS3OriginResponse } from "./s3/cloudfront-origin-port.js";

const S3_NAMESPACE = "http://s3.amazonaws.com/doc/2006-03-01/";
const MIN_MULTIPART_PART_SIZE = 5 * 1024 * 1024;
const namespaceLocksByStore = new WeakMap<StateStore, Map<string, Promise<unknown>>>();

export interface S3Options {
  maximumObjectBytes?: number;
  maximumBucketObjects?: number;
  maximumBuckets?: number;
  maximumTotalBytes?: number;
  /** Base URL used for simulator-hosted S3 website URLs. */
  websiteBaseUrl?: () => string;
  scheduler?: Scheduler;
  telemetry?: TelemetryBus;
  lambda?: LambdaService;
  sqs?: SqsService;
  eventbridge?: EventBridgeService;
  /** Test-only deterministic at-least-once duplicate injection. */
  notificationDuplicateEvery?: number;
  notificationMaximumAgeMs?: number;
}

export interface S3BucketPublicAccessBlock {
  blockPublicAcls: boolean;
  ignorePublicAcls: boolean;
  blockPublicPolicy: boolean;
  restrictPublicBuckets: boolean;
}

export interface S3BucketWebsiteConfiguration {
  indexDocument: string;
  errorDocument?: string;
}

export interface S3BucketCorsRule {
  allowedHeaders: string[];
  allowedMethods: Array<"GET" | "HEAD">;
  allowedOrigins: string[];
}

export interface S3BucketConfigurationInput {
  name: string;
  versioning: "unversioned" | "enabled" | "suspended";
  encryption: "AES256" | "aws:kms" | "aws:kms:dsse";
  objectOwnership?: "BucketOwnerEnforced";
  tags?: Record<string, string>;
  publicAccessBlock?: Partial<S3BucketPublicAccessBlock>;
  website?: S3BucketWebsiteConfiguration;
  cors?: S3BucketCorsRule[];
}

export type S3BucketConfigurationUpdate = Omit<S3BucketConfigurationInput, "name">;

export interface S3InternalPutObjectOptions {
  contentType?: string;
  contentEncoding?: string;
  contentDisposition?: string;
  contentLanguage?: string;
  cacheControl?: string;
  expires?: string;
  metadata?: Record<string, string>;
  tags?: Record<string, string>;
  /** When true, refuse to overwrite an existing current object. */
  failIfExists?: boolean;
  /** When true, enforce object-lock retention/legal-hold as if deleting the current version. */
  enforceObjectLock?: boolean;
}

/**
 * Internal, read-only S3 object view used by other simulated AWS services.
 * Callers still have to authorize the corresponding S3 action before using
 * this facade; keeping the read here avoids loopback HTTP and any chance of a
 * service following an external URL.
 */
export interface S3InternalObject {
  body: Buffer;
  bucket: string;
  ownerAccountId?: string;
  key: string;
  versionId: string;
  etag: string;
  size: number;
  sha256: string;
  contentType?: string;
  contentEncoding?: string;
  contentDisposition?: string;
  contentLanguage?: string;
  cacheControl?: string;
  expires?: string;
  metadata: Record<string, string>;
  tags: Record<string, string>;
  storageClass: string;
  encryption: "AES256" | "aws:kms" | "aws:kms:dsse";
}

/** Current, non-delete-marker object metadata exposed without its bytes. */
export interface S3InternalCurrentObject extends Omit<S3InternalObject, "body"> {}

/** Bounded metadata view used by simulator-owned lifecycle managers. */
export interface S3InternalObjectVersion {
  key: string;
  versionId: string;
  lastModified: number;
  size: number;
  deleteMarker: boolean;
}

interface Address { bucket?: string; key?: string; resource: string }
interface LocatedBucket { accountId: string; region: string; bucket: S3BucketState }
interface SelectedObject { version: S3ObjectVersionState; versions: S3ObjectVersionState[]; index: number }

function queryFlag(url: URL, name: string): boolean { return url.searchParams.has(name); }
function quotedEtag(value: string): string { return `"${value.replace(/^"|"$/g, "")}"`; }
function cleanEtag(value: string): string { return value.trim().replace(/^"|"$/g, ""); }
function iso(value: number): string { return new Date(value).toISOString(); }
function httpDate(value: number): string { return new Date(value).toUTCString(); }
function utf8Compare(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function encodeKey(value: string, encodingType: string | null): string { return encodingType === "url" ? encodeURIComponent(value).replace(/%2F/gi, "/") : xmlEscape(value); }
function ownerId(accountId: string): string { return canonicalOwnerId(accountId); }
function bucketArn(name: string): string { return `arn:aws:s3:::${name}`; }
function objectArn(bucket: string, key: string): string { return `arn:aws:s3:::${bucket}/${key}`; }

function canonicalPublicAccessBlock(value?: Partial<S3BucketPublicAccessBlock>): S3BucketPublicAccessBlock {
  return {
    blockPublicAcls: value?.blockPublicAcls === true,
    ignorePublicAcls: value?.ignorePublicAcls === true,
    blockPublicPolicy: value?.blockPublicPolicy === true,
    restrictPublicBuckets: value?.restrictPublicBuckets === true,
  };
}

function validateTags(value: Record<string, string> | undefined): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const key of Object.keys(value ?? {}).sort(utf8Compare)) {
    const tagValue = value![key];
    if (!key || typeof tagValue !== "string" || [...key].length > 128 || [...tagValue].length > 256 || /[\u0000-\u001f\u007f]/.test(key) || /[\u0000-\u001f\u007f]/.test(tagValue)) {
      throw new AwsError("InvalidTag", "The TagKey or TagValue you have provided is invalid", 400);
    }
    tags[key] = tagValue;
  }
  if (Object.keys(tags).length > 50) throw new AwsError("TooManyTags", "You cannot have more than 50 tags on a bucket", 400);
  return tags;
}

function validateObjectTags(value: Record<string, string>): Record<string, string> {
  const result = validateTags(value);
  if (Object.keys(result).length > 10) throw new AwsError("BadRequest", "Object tags cannot be greater than 10", 400);
  return result;
}

const S3_STORAGE_CLASSES = new Set([
  "STANDARD", "REDUCED_REDUNDANCY", "STANDARD_IA", "ONEZONE_IA", "INTELLIGENT_TIERING",
  "GLACIER_IR", "GLACIER", "DEEP_ARCHIVE",
]);
const S3_ARCHIVE_CLASSES = new Set(["GLACIER", "DEEP_ARCHIVE"]);
const S3_LIFECYCLE_TRANSITION_CLASSES = new Set([
  "STANDARD_IA", "ONEZONE_IA", "INTELLIGENT_TIERING", "GLACIER_IR", "GLACIER", "DEEP_ARCHIVE",
]);

function validateStorageClass(value: string): string {
  if (!S3_STORAGE_CLASSES.has(value)) throw new AwsError("InvalidStorageClass", "The storage class you specified is not valid.", 400);
  return value;
}

function eventBridgeS3Event(eventName: string): { detailType: string; reason: string; deletionType?: string } {
  const name = eventName.replace(/^s3:/, "");
  const exact: Record<string, { detailType: string; reason: string; deletionType?: string }> = {
    "ObjectCreated:Put": { detailType: "Object Created", reason: "PutObject" },
    "ObjectCreated:Copy": { detailType: "Object Created", reason: "CopyObject" },
    "ObjectCreated:CompleteMultipartUpload": { detailType: "Object Created", reason: "CompleteMultipartUpload" },
    "ObjectRemoved:Delete": { detailType: "Object Deleted", reason: "DeleteObject", deletionType: "Permanently Deleted" },
    "ObjectRemoved:DeleteMarkerCreated": { detailType: "Object Deleted", reason: "DeleteObject", deletionType: "Delete Marker Created" },
    "LifecycleExpiration:Delete": { detailType: "Object Deleted", reason: "Lifecycle Expiration", deletionType: "Permanently Deleted" },
    "LifecycleExpiration:DeleteMarkerCreated": { detailType: "Object Deleted", reason: "Lifecycle Expiration", deletionType: "Delete Marker Created" },
    "LifecycleExpiration:DeleteMarkerDeleted": { detailType: "Object Deleted", reason: "Lifecycle Expiration", deletionType: "Permanently Deleted" },
    "LifecycleTransition": { detailType: "Object Storage Class Changed", reason: "Lifecycle Transition" },
    "ObjectRestore:Post": { detailType: "Object Restore Initiated", reason: "RestoreObject" },
    "ObjectRestore:Completed": { detailType: "Object Restore Completed", reason: "RestoreObject" },
    "ObjectRestore:Delete": { detailType: "Object Restore Expired", reason: "RestoreObject" },
    "ObjectTagging:Put": { detailType: "Object Tags Added", reason: "PutObjectTagging" },
    "ObjectTagging:Delete": { detailType: "Object Tags Deleted", reason: "DeleteObjectTagging" },
    "ObjectAcl:Put": { detailType: "Object ACL Updated", reason: "PutObjectAcl" },
    "ObjectAnnotation:Put": { detailType: "Object Annotation Added", reason: "PutObjectAnnotation" },
    "ObjectAnnotation:Delete": { detailType: "Object Annotation Deleted", reason: "DeleteObjectAnnotation" },
  };
  return exact[name] ?? { detailType: name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/:/g, " "), reason: name };
}

function parseTaggingXml(xml: string, maximum: number): Record<string, string> {
  if (!/<Tagging(?:\s|>)/i.test(xml) || !/<TagSet(?:\s|>)/i.test(xml)) throw new AwsError("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema", 400);
  const tags: Record<string, string> = {};
  for (const match of xml.matchAll(/<Tag(?:\s[^>]*)?>([\s\S]*?)<\/Tag>/gi)) {
    const key = xmlValue(match[1], "Key"); const value = xmlValue(match[1], "Value");
    if (key === undefined || value === undefined || Object.hasOwn(tags, key)) throw new AwsError("InvalidTag", "The TagKey or TagValue you have provided is invalid", 400);
    tags[key] = value;
  }
  const validated = validateTags(tags);
  if (Object.keys(validated).length > maximum) throw new AwsError(maximum === 10 ? "BadRequest" : "TooManyTags", `TagSet may contain at most ${maximum} tags`, 400);
  return validated;
}

function taggingXml(tags: Record<string, string>): string {
  return restXml(`<TagSet>${Object.entries(tags).sort(([a], [b]) => utf8Compare(a, b)).map(([key, value]) => `<Tag><Key>${xmlEscape(key)}</Key><Value>${xmlEscape(value)}</Value></Tag>`).join("")}</TagSet>`, "Tagging");
}

function validateWebsiteConfiguration(value: S3BucketWebsiteConfiguration | undefined): S3BucketWebsiteConfiguration | undefined {
  if (value === undefined) return undefined;
  const indexDocument = value.indexDocument;
  const errorDocument = value.errorDocument;
  if (typeof indexDocument !== "string" || !indexDocument || indexDocument.startsWith("/") || Buffer.byteLength(indexDocument) > 1_024 || /[\u0000-\u001f\u007f]/.test(indexDocument)) throw new AwsError("InvalidArgument", "Website IndexDocument must be a nonempty relative key suffix no longer than 1024 bytes", 400);
  if (errorDocument !== undefined && (typeof errorDocument !== "string" || !errorDocument || errorDocument.startsWith("/") || Buffer.byteLength(errorDocument) > 1_024 || /[\u0000-\u001f\u007f]/.test(errorDocument))) throw new AwsError("InvalidArgument", "Website ErrorDocument must be a nonempty relative key no longer than 1024 bytes", 400);
  return { indexDocument, ...(errorDocument === undefined ? {} : { errorDocument }) };
}

function validateCorsConfiguration(value: S3BucketCorsRule[] | undefined): S3BucketCorsRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 1) throw new AwsError("InvalidRequest", "AMX-04 requires exactly one generated CORS rule", 400);
  return value.map(rule => {
    if (!rule || !Array.isArray(rule.allowedHeaders) || !Array.isArray(rule.allowedMethods) || !Array.isArray(rule.allowedOrigins)
      || rule.allowedHeaders.length !== 1 || rule.allowedHeaders[0] !== "*"
      || JSON.stringify(rule.allowedMethods) !== JSON.stringify(["GET", "HEAD"])
      || rule.allowedOrigins.length !== 1 || typeof rule.allowedOrigins[0] !== "string" || !/^https:\/\/[a-z0-9-]+\.console\.aws\.amazon\.com\/amplify$/.test(rule.allowedOrigins[0])) {
      throw new AwsError("InvalidRequest", "The CORS rule is outside the frozen AMX-04 generated shape", 400);
    }
    return { allowedHeaders: ["*"], allowedMethods: ["GET", "HEAD"] as Array<"GET" | "HEAD">, allowedOrigins: [rule.allowedOrigins[0]] };
  });
}

function canonicalBucketState(bucket: S3BucketState): S3BucketState {
  return {
    ...structuredClone(bucket),
    encryption: bucket.encryption ?? "AES256",
    encryptionConfiguration: structuredClone(bucket.encryptionConfiguration ?? { algorithm: "AES256", bucketKeyEnabled: false }),
    tags: validateTags(bucket.tags),
    publicAccessBlock: canonicalPublicAccessBlock(bucket.publicAccessBlock),
    website: validateWebsiteConfiguration(bucket.website),
    corsConfiguration: validateCorsConfiguration(bucket.corsConfiguration),
    objectOwnership: bucket.objectOwnership ?? "BucketOwnerEnforced",
    acl: structuredClone(bucket.acl ?? privateAcl(bucket.ownerAccountId)),
    requestPayment: bucket.requestPayment ?? "BucketOwner",
    abacStatus: bucket.abacStatus ?? "Disabled",
  };
}

function validatePolicyDocument(value: unknown): PolicyDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("MalformedPolicy", "The policy document must be a JSON object", 400);
  const document = value as Record<string, unknown>;
  if (Object.keys(document).some(key => !["Version", "Id", "Statement"].includes(key)) || (document.Version !== undefined && typeof document.Version !== "string") || (document.Id !== undefined && typeof document.Id !== "string")) throw new AwsError("MalformedPolicy", "The policy document contains unsupported fields", 400);
  const rawStatements = Array.isArray(document.Statement) ? document.Statement : document.Statement === undefined ? [] : [document.Statement];
  if (!rawStatements.length) throw new AwsError("MalformedPolicy", "The policy document must contain at least one statement", 400);
  const allowed = new Set(["Sid", "Effect", "Action", "NotAction", "Resource", "NotResource", "Principal", "NotPrincipal", "Condition"]);
  for (const raw of rawStatements) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.has(key))) throw new AwsError("MalformedPolicy", "The policy contains an invalid statement", 400);
    const statement = raw as Record<string, unknown>;
    if (!new Set(["Allow", "Deny"]).has(String(statement.Effect)) || (statement.Action === undefined) === (statement.NotAction === undefined) || (statement.Resource === undefined) === (statement.NotResource === undefined) || (statement.Principal === undefined) === (statement.NotPrincipal === undefined)) throw new AwsError("MalformedPolicy", "Each statement must contain Effect and exactly one of Action/NotAction, Resource/NotResource, and Principal/NotPrincipal", 400);
    for (const key of ["Action", "NotAction", "Resource", "NotResource"] as const) if (statement[key] !== undefined && !(typeof statement[key] === "string" || Array.isArray(statement[key]) && statement[key].every(item => typeof item === "string"))) throw new AwsError("MalformedPolicy", `${key} must be a string or string array`, 400);
    if (statement.Condition !== undefined && (!statement.Condition || typeof statement.Condition !== "object" || Array.isArray(statement.Condition))) throw new AwsError("MalformedPolicy", "Condition must be an object", 400);
  }
  return structuredClone(value) as PolicyDocument;
}

function publicGetAllowed(bucket: S3BucketState, key: string): boolean {
  if (!bucket.policyDocument || canonicalPublicAccessBlock(bucket.publicAccessBlock).restrictPublicBuckets) return false;
  return evaluateResourcePolicy(bucket.policyDocument, "*", "s3:GetObject", objectArn(bucket.name, key), { "aws:PrincipalArn": "*", "aws:SecureTransport": false }).decision === "allowed";
}

function parseXmlBoolean(xml: string, name: string): boolean {
  const value = xmlValue(xml, name)?.toLowerCase();
  if (value !== "true" && value !== "false") throw new AwsError("MalformedXML", `${name} must be true or false`, 400);
  return value === "true";
}

interface CanonicalBucketConfiguration {
  versioning: "unversioned" | "enabled" | "suspended";
  encryption: "AES256";
  objectOwnership: "BucketOwnerEnforced";
  cloudFormationConfiguration: {
    ownershipControls: boolean;
    publicAccessBlock: boolean;
  };
  tags: Record<string, string>;
  publicAccessBlock: S3BucketPublicAccessBlock;
  website?: S3BucketWebsiteConfiguration;
  corsConfiguration?: S3BucketCorsRule[];
}

function canonicalBucketConfiguration(input: S3BucketConfigurationUpdate): CanonicalBucketConfiguration {
  if (!new Set(["unversioned", "enabled", "suspended"]).has(input.versioning)) throw new AwsError("InvalidArgument", "Unsupported bucket versioning state", 400);
  if (input.encryption !== "AES256") throw new AwsError("InvalidEncryptionAlgorithmError", "Only SSE-S3 AES256 encryption is supported", 400);
  if (input.objectOwnership !== undefined && input.objectOwnership !== "BucketOwnerEnforced") throw new AwsError("InvalidRequest", "The bounded CloudFormation bucket profile supports only BucketOwnerEnforced ownership", 400);
  return {
    versioning: input.versioning,
    encryption: "AES256",
    objectOwnership: "BucketOwnerEnforced",
    cloudFormationConfiguration: {
      ownershipControls: input.objectOwnership !== undefined,
      publicAccessBlock: input.publicAccessBlock !== undefined,
    },
    tags: validateTags(input.tags),
    publicAccessBlock: canonicalPublicAccessBlock(input.publicAccessBlock),
    website: validateWebsiteConfiguration(input.website),
    corsConfiguration: validateCorsConfiguration(input.cors),
  };
}

function sameBucketConfiguration(bucket: S3BucketState, desired: CanonicalBucketConfiguration): boolean {
  const current = canonicalBucketState(bucket);
  const canonical = desired;
  return current.versioning === canonical.versioning
    && current.encryption === canonical.encryption
    && current.objectOwnership === canonical.objectOwnership
    && JSON.stringify(current.cloudFormationConfiguration ?? { ownershipControls: false, publicAccessBlock: false }) === JSON.stringify(canonical.cloudFormationConfiguration)
    && JSON.stringify(current.tags) === JSON.stringify(canonical.tags)
    && JSON.stringify(current.publicAccessBlock) === JSON.stringify(canonical.publicAccessBlock)
    && JSON.stringify(current.website) === JSON.stringify(canonical.website)
    && JSON.stringify(current.corsConfiguration) === JSON.stringify(canonical.corsConfiguration);
}

function internalHeaderValue(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Buffer.byteLength(value) > 8 * 1024 || /[\u0000\r\n]/.test(value)) throw new AwsError("InvalidArgument", `${name} contains an invalid header value`, 400);
  return value;
}

function validateBucketName(name: string): void {
  const reservedSuffixes = ["-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3"];
  if (name.length < 3 || name.length > 63 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name) || name.includes("..") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name) || name.startsWith("xn--") || name.startsWith("sthree-") || name.startsWith("amzn-s3-demo-") || reservedSuffixes.some(suffix => name.endsWith(suffix))) {
    throw new AwsError("InvalidBucketName", "The specified bucket is not valid.", 400);
  }
}

function decodePathComponent(value: string): string {
  try { return decodeURIComponent(value); } catch { throw new AwsError("InvalidURI", "Couldn't parse the specified URI.", 400); }
}

function parseAddress(req: IncomingMessage): Address {
  const rawPath = String(req.url ?? "/").split("?", 1)[0] || "/"; const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
  let virtualBucket: string | undefined;
  const virtualMatch = host.match(/^(.+)\.(?:s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com|localhost|127\.0\.0\.1)$/i);
  if (virtualMatch) virtualBucket = virtualMatch[1];
  if (virtualBucket) {
    const rawKey = rawPath.replace(/^\//, ""); return { bucket: decodePathComponent(virtualBucket), key: rawKey ? decodePathComponent(rawKey) : undefined, resource: rawPath };
  }
  const withoutSlash = rawPath.replace(/^\//, ""); if (!withoutSlash) return { resource: rawPath };
  const separator = withoutSlash.indexOf("/"); const rawBucket = separator < 0 ? withoutSlash : withoutSlash.slice(0, separator); const rawKey = separator < 0 ? "" : withoutSlash.slice(separator + 1);
  return { bucket: decodePathComponent(rawBucket), key: rawKey ? decodePathComponent(rawKey) : undefined, resource: rawPath };
}

function metadataFromHeaders(req: IncomingMessage): Record<string, string> {
  const metadata: Record<string, string> = {}; let bytes = 0;
  for (const [name, raw] of Object.entries(req.headers)) {
    if (!name.startsWith("x-amz-meta-") || raw === undefined) continue; const key = name.slice("x-amz-meta-".length); const value = Array.isArray(raw) ? raw.join(",") : String(raw); metadata[key] = value; bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
  }
  if (bytes > 2 * 1024) throw new AwsError("MetadataTooLarge", "Your metadata headers exceed the maximum allowed metadata size.", 400);
  return metadata;
}

function tagsFromHeader(value: string | string[] | undefined): Record<string, string> {
  if (value === undefined) return {};
  const tags: Record<string, string> = {};
  for (const [key, tagValue] of new URLSearchParams(Array.isArray(value) ? value.join("&") : value)) {
    if (!key || Object.hasOwn(tags, key) || [...key].length > 128 || [...tagValue].length > 256) throw new AwsError("InvalidTag", "The TagKey or TagValue you have provided is invalid", 400);
    tags[key] = tagValue;
  }
  if (Object.keys(tags).length > 10) throw new AwsError("BadRequest", "Object tags cannot be greater than 10", 400);
  return tags;
}

function checksumAlgorithmFor(req: IncomingMessage, inherited?: S3ObjectVersionState, trailers: Record<string, string> = {}): S3ChecksumAlgorithm {
  const declared = requestedChecksumAlgorithm(req.headers["x-amz-checksum-algorithm"] ?? req.headers["x-amz-sdk-checksum-algorithm"]);
  const provided = providedChecksumAlgorithms(req.headers, trailers);
  if (provided.length > 1 || (declared && provided.length && provided[0] !== declared)) throw new AwsError("InvalidRequest", "Only one checksum algorithm may be specified and it must match the supplied checksum", 400);
  return declared ?? provided[0] ?? inherited?.checksumAlgorithm ?? (Object.keys(inherited?.checksums ?? {})[0] as S3ChecksumAlgorithm | undefined) ?? "CRC64NVME";
}

function activeChecksum(object: S3ObjectVersionState): S3ChecksumAlgorithm | undefined {
  return object.checksumAlgorithm ?? Object.keys(object.checksums)[0] as S3ChecksumAlgorithm | undefined;
}

function requestDetails(req: IncomingMessage, inherited?: S3ObjectVersionState) {
  const directive = String(req.headers["x-amz-metadata-directive"] ?? "COPY").toUpperCase(); const replace = !inherited || directive === "REPLACE";
  if (inherited && !["COPY", "REPLACE"].includes(directive)) throw new AwsError("InvalidArgument", "Unknown metadata directive.", 400);
  const taggingDirective = String(req.headers["x-amz-tagging-directive"] ?? "COPY").toUpperCase(); const replaceTags = !inherited || taggingDirective === "REPLACE";
  if (inherited && !["COPY", "REPLACE"].includes(taggingDirective)) throw new AwsError("InvalidArgument", "Unknown tagging directive.", 400);
  const storageClass = validateStorageClass(String(req.headers["x-amz-storage-class"] ?? inherited?.storageClass ?? "STANDARD"));
  return {
    metadata: replace ? metadataFromHeaders(req) : structuredClone(inherited!.metadata),
    tags: replaceTags ? tagsFromHeader(req.headers["x-amz-tagging"]) : structuredClone(inherited?.tags ?? {}),
    contentType: replace ? req.headers["content-type"]?.toString() : inherited?.contentType,
    contentEncoding: replace ? req.headers["content-encoding"]?.toString().split(",").map(value => value.trim()).filter(value => value.toLowerCase() !== "aws-chunked").join(", ") || undefined : inherited?.contentEncoding,
    contentDisposition: replace ? req.headers["content-disposition"]?.toString() : inherited?.contentDisposition,
    contentLanguage: replace ? req.headers["content-language"]?.toString() : inherited?.contentLanguage,
    cacheControl: replace ? req.headers["cache-control"]?.toString() : inherited?.cacheControl,
    expires: replace ? req.headers.expires?.toString() : inherited?.expires,
    websiteRedirectLocation: replace ? req.headers["x-amz-website-redirect-location"]?.toString() : inherited?.websiteRedirectLocation,
    storageClass,
  };
}

function currentObject(index: S3BucketIndex, key: string): S3ObjectVersionState | undefined { return index.objects[key]?.[0]; }

function internalObjectView(bucket: string, key: string, object: S3ObjectVersionState): S3InternalCurrentObject {
  if (!object.blobId || object.deleteMarker) throw new AwsError("InvalidObjectState", `Object ${bucket}/${key} is not a readable current object`, 500);
  return {
    bucket,
    key,
    versionId: object.versionId,
    etag: object.etag,
    size: object.size,
    sha256: object.blobId,
    contentType: object.contentType,
    contentEncoding: object.contentEncoding,
    contentDisposition: object.contentDisposition,
    contentLanguage: object.contentLanguage,
    cacheControl: object.cacheControl,
    expires: object.expires,
    metadata: structuredClone(object.metadata),
    tags: structuredClone(object.tags ?? {}),
    storageClass: object.storageClass,
    encryption: object.encryption,
  };
}

interface ObjectEncryption {
  encryption: "AES256" | "aws:kms" | "aws:kms:dsse";
  kmsKeyId?: string;
  bucketKeyEnabled?: boolean;
  sseCustomerKeyMd5?: string;
}

function customerEncryption(req: IncomingMessage, copySource = false): { md5: string } | undefined {
  const prefix = copySource ? "x-amz-copy-source-server-side-encryption-customer-" : "x-amz-server-side-encryption-customer-";
  const algorithm = req.headers[`${prefix}algorithm`];
  const keyValue = req.headers[`${prefix}key`];
  const suppliedMd5 = req.headers[`${prefix}key-md5`];
  if (algorithm === undefined && keyValue === undefined && suppliedMd5 === undefined) return undefined;
  if (String(algorithm ?? "") !== "AES256" || keyValue === undefined || suppliedMd5 === undefined) throw new AwsError("InvalidRequest", "SSE-C requires AES256, a customer key, and the customer key MD5", 400);
  let key: Buffer;
  try { key = Buffer.from(String(keyValue), "base64"); } catch { throw new AwsError("InvalidArgument", "The provided SSE-C key is not valid base64", 400); }
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== String(keyValue).replace(/=+$/, "")) throw new AwsError("InvalidArgument", "The secret key was invalid for the specified algorithm", 400);
  const md5 = createHash("md5").update(key).digest("base64");
  if (md5 !== String(suppliedMd5)) throw new AwsError("InvalidDigest", "The SSE-C key MD5 does not match the provided key", 400);
  return { md5 };
}

function validateKmsKeyId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Buffer.byteLength(value) > 2_048 || !/^(?:arn:aws:kms:[a-z0-9-]+:\d{12}:(?:key|alias)\/[A-Za-z0-9/_+=,.@:-]+|alias\/[A-Za-z0-9/_+=,.@:-]+|[0-9a-f]{8}-[0-9a-f-]{27,})$/i.test(value)) throw new AwsError("InvalidArgument", "The KMS key identifier is invalid", 400);
  return value;
}

function validateKmsContext(value: string | string[] | undefined): void {
  if (value === undefined) return;
  let decoded: Buffer;
  try { decoded = Buffer.from(String(value), "base64"); JSON.parse(decoded.toString("utf8")); } catch { throw new AwsError("InvalidArgument", "x-amz-server-side-encryption-context must be base64-encoded JSON", 400); }
  if (decoded.length > 8 * 1024) throw new AwsError("InvalidArgument", "The KMS encryption context is too large", 400);
}

function objectEncryption(req: IncomingMessage, bucket: S3BucketState, inherited?: S3ObjectVersionState): ObjectEncryption {
  const customer = customerEncryption(req);
  if (customer) return { encryption: "AES256", sseCustomerKeyMd5: customer.md5 };
  const configured = bucket.encryptionConfiguration ?? { algorithm: "AES256" as const, bucketKeyEnabled: false };
  const algorithm = String(req.headers["x-amz-server-side-encryption"] ?? inherited?.encryption ?? configured.algorithm);
  if (!["AES256", "aws:kms", "aws:kms:dsse"].includes(algorithm)) throw new AwsError("InvalidEncryptionAlgorithmError", "The encryption method specified is not supported", 400);
  if (algorithm !== "AES256") {
    const kmsKeyId = validateKmsKeyId(req.headers["x-amz-server-side-encryption-aws-kms-key-id"]?.toString() ?? inherited?.kmsKeyId ?? configured.kmsKeyId);
    validateKmsContext(req.headers["x-amz-server-side-encryption-context"]);
    // The descriptor is valid, but no KMS service exists. Failing before staging
    // keeps prior object versions and bytes atomic and never labels local AES-GCM
    // blobs as KMS-encrypted.
    throw new AwsError("KMS.NotFoundException", `KMS key ${kmsKeyId ?? "(default)"} is unavailable because the KMS service is not implemented`, 400);
  }
  return { encryption: "AES256", bucketKeyEnabled: false };
}

function requireCustomerKey(req: IncomingMessage, object: S3ObjectVersionState, copySource = false): void {
  if (!object.sseCustomerKeyMd5) {
    if (customerEncryption(req, copySource)) throw new AwsError("InvalidRequest", "SSE-C headers were provided for an object that is not encrypted with SSE-C", 400);
    return;
  }
  const supplied = customerEncryption(req, copySource);
  if (!supplied || supplied.md5 !== object.sseCustomerKeyMd5) throw new AwsError("InvalidRequest", "The object was stored using SSE-C; the correct customer key is required", 400);
}

function selectObject(index: S3BucketIndex, key: string, versionId?: string | null): SelectedObject {
  const versions = index.objects[key] ?? []; const position = versionId === undefined || versionId === null ? 0 : versions.findIndex(version => version.versionId === versionId);
  if (position < 0 || !versions[position]) throw new AwsError("NoSuchKey", "The specified key does not exist.", 404);
  const version = versions[position];
  if (version.deleteMarker) {
    if (versionId !== undefined && versionId !== null) throw new AwsError("MethodNotAllowed", "The specified method is not allowed against this resource.", 405, { deleteMarker: true, versionId: version.versionId });
    throw new AwsError("NoSuchKey", "The specified key does not exist.", 404, { deleteMarker: true, versionId: version.versionId });
  }
  return { version, versions, index: position };
}

function versionIdForWrite(bucket: S3BucketState): string { return bucket.versioning === "enabled" ? randomUUID() : "null"; }

function publishVersion(bucket: S3BucketState, index: S3BucketIndex, key: string, version: S3ObjectVersionState): void {
  const existing = index.objects[key] ?? [];
  if (bucket.versioning !== "unversioned" && existing[0]) existing[0].noncurrentSince ??= version.lastModified;
  index.objects[key] = bucket.versioning === "enabled" ? [version, ...existing] : bucket.versioning === "suspended" ? [version, ...existing.filter(item => item.versionId !== "null")] : [version];
}

function parseHttpDate(value: string | string[] | undefined): number | undefined { if (value === undefined) return undefined; const parsed = Date.parse(String(Array.isArray(value) ? value[0] : value)); return Number.isFinite(parsed) ? parsed : undefined; }

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false; const value = Array.isArray(header) ? header.join(",") : header; return value.trim() === "*" || value.split(",").some(candidate => cleanEtag(candidate) === etag);
}

function enforceReadConditions(req: IncomingMessage, object: S3ObjectVersionState): "not-modified" | undefined {
  const ifMatch = req.headers["if-match"]; if (ifMatch !== undefined && !etagMatches(ifMatch, object.etag)) throw new AwsError("PreconditionFailed", "At least one of the pre-conditions you specified did not hold", 412);
  if (ifMatch === undefined) { const unmodified = parseHttpDate(req.headers["if-unmodified-since"]); if (unmodified !== undefined && object.lastModified > unmodified + 999) throw new AwsError("PreconditionFailed", "At least one of the pre-conditions you specified did not hold", 412); }
  const ifNone = req.headers["if-none-match"]; if (ifNone !== undefined && etagMatches(ifNone, object.etag)) return "not-modified";
  if (ifNone === undefined) { const modified = parseHttpDate(req.headers["if-modified-since"]); if (modified !== undefined && object.lastModified <= modified + 999) return "not-modified"; }
  return undefined;
}

function enforceWriteConditions(req: IncomingMessage, existing?: S3ObjectVersionState): void {
  const ifMatch = req.headers["if-match"]; if (ifMatch !== undefined && (!existing || existing.deleteMarker || !etagMatches(ifMatch, existing.etag))) throw new AwsError("PreconditionFailed", "At least one of the pre-conditions you specified did not hold", 412);
  const ifNone = req.headers["if-none-match"]; if (ifNone !== undefined && existing && !existing.deleteMarker && etagMatches(ifNone, existing.etag)) throw new AwsError("PreconditionFailed", "At least one of the pre-conditions you specified did not hold", 412);
}

function setObjectHeaders(res: ServerResponse, object: S3ObjectVersionState, checksumMode = false): void {
  res.setHeader("etag", quotedEtag(object.etag)); res.setHeader("last-modified", httpDate(object.lastModified)); res.setHeader("accept-ranges", "bytes"); if (object.sseCustomerKeyMd5) { res.setHeader("x-amz-server-side-encryption-customer-algorithm", "AES256"); res.setHeader("x-amz-server-side-encryption-customer-key-md5", object.sseCustomerKeyMd5); } else res.setHeader("x-amz-server-side-encryption", object.encryption); res.setHeader("x-amz-storage-class", object.storageClass);
  if (object.kmsKeyId) res.setHeader("x-amz-server-side-encryption-aws-kms-key-id", object.kmsKeyId);
  if (object.bucketKeyEnabled !== undefined) res.setHeader("x-amz-server-side-encryption-bucket-key-enabled", String(object.bucketKeyEnabled));
  if (object.retention) { res.setHeader("x-amz-object-lock-mode", object.retention.mode); res.setHeader("x-amz-object-lock-retain-until-date", iso(object.retention.retainUntil)); }
  if (object.legalHold) res.setHeader("x-amz-object-lock-legal-hold", object.legalHold);
  if (S3_ARCHIVE_CLASSES.has(object.storageClass)) {
    const restore = object.restore;
    if (restore) res.setHeader("x-amz-restore", restore.completesAt > 0 ? `ongoing-request="true"` : `ongoing-request="false", expiry-date="${httpDate(restore.expiryAt)}"`);
  }
  if (object.versionId !== "null") res.setHeader("x-amz-version-id", object.versionId);
  if (object.contentType) res.setHeader("content-type", object.contentType); if (object.contentEncoding) res.setHeader("content-encoding", object.contentEncoding); if (object.contentDisposition) res.setHeader("content-disposition", object.contentDisposition); if (object.contentLanguage) res.setHeader("content-language", object.contentLanguage); if (object.cacheControl) res.setHeader("cache-control", object.cacheControl); if (object.expires) res.setHeader("expires", object.expires); if (object.websiteRedirectLocation) res.setHeader("x-amz-website-redirect-location", object.websiteRedirectLocation);
  for (const [name, value] of Object.entries(object.metadata)) res.setHeader(`x-amz-meta-${name}`, value);
  const tagCount = Object.keys(object.tags ?? {}).length; if (tagCount) res.setHeader("x-amz-tagging-count", String(tagCount));
  if (checksumMode) { const algorithm = activeChecksum(object); if (algorithm && object.checksums[algorithm]) res.setHeader(checksumHeaderName(algorithm), object.checksums[algorithm]!); if (object.checksumType) res.setHeader("x-amz-checksum-type", object.checksumType); }
}

function rangeFor(header: string | string[] | undefined, size: number): { start: number; end: number } | undefined {
  if (header === undefined) return undefined; const value = String(Array.isArray(header) ? header[0] : header);
  if (!value.startsWith("bytes=") || value.includes(",")) throw new AwsError("InvalidRange", "The requested range is not satisfiable", 416);
  const match = value.match(/^bytes=(\d*)-(\d*)$/); if (!match || (!match[1] && !match[2])) throw new AwsError("InvalidRange", "The requested range is not satisfiable", 416);
  let start: number; let end: number;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isInteger(suffix) || suffix <= 0) throw new AwsError("InvalidRange", "The requested range is not satisfiable", 416); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; end = Math.min(end, size - 1); }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new AwsError("InvalidRange", "The requested range is not satisfiable", 416);
  return { start, end };
}

async function compositeChecksum(algorithm: S3ChecksumAlgorithm, parts: S3ObjectPartState[]): Promise<string> {
  const checksums = new S3Checksums();
  for (const part of parts) {
    const value = part.checksums[algorithm]; if (!value) throw new AwsError("InvalidPart", `Part ${part.partNumber} does not have the required ${algorithm} checksum`, 400);
    await checksums.update(Buffer.from(value, "base64"));
  }
  const combined = await checksums.digest(); return `${combined.values[algorithm]}-${parts.length}`;
}

export class S3Service {
  readonly storage: S3Storage;
  private readonly pagination: PaginationTokens;
  private readonly indexes = new Map<string, S3BucketIndex>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly namespaceLocks: Map<string, Promise<unknown>>;
  private readonly maximumObjectBytes: number;
  private readonly maximumBucketObjects: number;
  private readonly maximumBuckets: number;
  private readonly maximumTotalBytes: number;
  private readonly websiteBaseUrl: () => string;
  private readonly scheduler?: Scheduler;
  private readonly telemetry?: TelemetryBus;
  private readonly lambda?: LambdaService;
  private readonly sqs?: SqsService;
  private readonly eventbridge?: EventBridgeService;
  private readonly notificationDuplicateEvery: number;
  private readonly notificationMaximumAgeMs: number;
  private maintenanceCancel?: () => void;
  private deliveryRunning = false;
  private initialized?: Promise<void>;

  constructor(private readonly store: StateStore, readonly region: string, private readonly clock: Clock, options: S3Options = {}) {
    this.storage = new S3Storage(store); this.pagination = new PaginationTokens(store.state.installation.paginationSecret);
    this.namespaceLocks = namespaceLocksByStore.get(store) ?? new Map<string, Promise<unknown>>(); namespaceLocksByStore.set(store, this.namespaceLocks);
    this.maximumObjectBytes = options.maximumObjectBytes ?? Number(process.env.STACKSIM_S3_MAX_OBJECT_BYTES ?? 5 * 1024 * 1024 * 1024);
    this.maximumBucketObjects = options.maximumBucketObjects ?? Number(process.env.STACKSIM_S3_MAX_BUCKET_OBJECTS ?? 1_000_000);
    this.maximumBuckets = options.maximumBuckets ?? Number(process.env.STACKSIM_S3_MAX_BUCKETS ?? 10_000);
    this.maximumTotalBytes = options.maximumTotalBytes ?? Number(process.env.STACKSIM_S3_MAX_TOTAL_BYTES ?? 50 * 1024 * 1024 * 1024);
    this.websiteBaseUrl = options.websiteBaseUrl ?? (() => process.env.AWS_ENDPOINT_URL ?? "http://127.0.0.1:4566");
    this.scheduler = options.scheduler; this.telemetry = options.telemetry; this.lambda = options.lambda; this.sqs = options.sqs; this.eventbridge = options.eventbridge;
    this.notificationDuplicateEvery = options.notificationDuplicateEvery ?? Number(process.env.STACKSIM_S3_NOTIFICATION_DUPLICATE_EVERY ?? 0);
    this.notificationMaximumAgeMs = options.notificationMaximumAgeMs ?? Number(process.env.STACKSIM_S3_NOTIFICATION_MAXIMUM_AGE_MS ?? 24 * 60 * 60 * 1000);
    if ([this.maximumObjectBytes, this.maximumBucketObjects, this.maximumBuckets, this.maximumTotalBytes].some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("S3 limits must be non-negative safe integers");
  }

  start(): Promise<void> {
    return this.initialized ??= (async () => {
      await this.storage.initialize();
      await this.runLifecycleNow();
      await this.runNotificationDeliveries();
      this.scheduleMaintenance();
    })();
  }

  private scheduleMaintenance(delayMs = 1_000): void {
    if (!this.scheduler || this.maintenanceCancel) return;
    this.maintenanceCancel = this.scheduler.schedule(async () => {
      this.maintenanceCancel = undefined;
      await this.runLifecycleNow().catch(() => undefined);
      await this.runNotificationDeliveries().catch(() => undefined);
      this.scheduleMaintenance(1_000);
    }, delayMs);
  }

  websiteUrl(bucketName: string): string {
    validateBucketName(bucketName);
    return `${this.websiteBaseUrl().replace(/\/+$/, "")}/_stacksim/s3-website/${encodeURIComponent(bucketName)}/`;
  }

  /** Read the service-backed bucket model used by CloudFormation providers. */
  async readBucketInternal(name: string): Promise<S3BucketState | undefined> {
    await this.start();
    const located = this.findBucket(name);
    if (!located) return undefined;
    if (located.accountId !== this.store.accountId) throw new AwsError("AccessDenied", "Access Denied", 403);
    if (located.region !== this.region) throw new AwsError("PermanentRedirect", "The bucket you are attempting to access must be addressed using the specified endpoint.", 301, { region: located.region });
    await this.bucketIndex(located);
    return canonicalBucketState(located.bucket);
  }

  /** Atomically materialize an application bucket, with replay-safe exact-match adoption. */
  async createBucketInternal(input: S3BucketConfigurationInput): Promise<S3BucketState> {
    await this.start();
    validateBucketName(input.name);
    const desired = canonicalBucketConfiguration(input);
    return this.namespaceLocked(input.name, async () => {
      const existing = this.findBucket(input.name);
      if (existing) {
        if (existing.accountId === this.store.accountId && existing.region === this.region && existing.bucket.managedBy === undefined && sameBucketConfiguration(existing.bucket, desired)) {
          const index = await this.bucketIndex(existing);
          // A crash can persist the namespace record before the initial empty
          // index. Re-persist the successfully decoded/default-empty index on
          // exact owned replay; corrupt indexes still fail in loadBucket.
          await this.saveBucket(existing, index);
          return canonicalBucketState(existing.bucket);
        }
        throw existing.accountId === this.store.accountId
          ? new AwsError("BucketAlreadyOwnedByYou", "Your previous request to create the named bucket succeeded and you already own it.", 409)
          : new AwsError("BucketAlreadyExists", "The requested bucket name is not available.", 409);
      }
      if (this.allOwnedBuckets().length >= this.maximumBuckets) throw new AwsError("TooManyBuckets", "You have attempted to create more buckets than allowed.", 400);
      const bucket: S3BucketState = {
        name: input.name,
        arn: bucketArn(input.name),
        region: this.region,
        ownerAccountId: this.store.accountId,
        ownerId: ownerId(this.store.accountId),
        createdAt: this.clock.now(),
        ...desired,
        acl: privateAcl(this.store.accountId),
        requestPayment: "BucketOwner",
        abacStatus: "Disabled",
      };
      this.store.regionState(this.region).s3Buckets[input.name] = bucket;
      this.store.state.installation.s3BucketNames[input.name] = { accountId: this.store.accountId, region: this.region };
      await Promise.all([
        this.store.save(),
        this.storage.saveBucket(this.store.accountId, this.region, input.name, { schemaVersion: 1, objects: {}, multipartUploads: {} }),
      ]);
      return canonicalBucketState(bucket);
    });
  }

  /** Replace the bounded bucket configuration supported by this implementation slice. */
  async updateBucketInternal(name: string, input: S3BucketConfigurationUpdate): Promise<S3BucketState> {
    await this.start();
    const desired = canonicalBucketConfiguration(input);
    const located = this.requireBucket(name);
    if (located.bucket.managedBy) throw new AwsError("AccessDenied", "Simulator-managed bootstrap buckets cannot be configured as application buckets", 403);
    if (located.bucket.versioning !== "unversioned" && desired.versioning === "unversioned") throw new AwsError("InvalidBucketState", "Bucket versioning cannot return to the unversioned state after it has been enabled", 409);
    if (!sameBucketConfiguration(located.bucket, desired)) {
      located.bucket.versioning = desired.versioning;
      located.bucket.encryption = desired.encryption;
      located.bucket.objectOwnership = desired.objectOwnership;
      located.bucket.cloudFormationConfiguration = desired.cloudFormationConfiguration;
      located.bucket.tags = desired.tags;
      located.bucket.publicAccessBlock = desired.publicAccessBlock;
      located.bucket.website = desired.website;
      located.bucket.corsConfiguration = desired.corsConfiguration;
      await this.store.save();
    }
    return canonicalBucketState(located.bucket);
  }

  /** Replace a bucket's direct notification destinations for CloudFormation. */
  async putBucketNotificationInternal(name: string, configuration: NonNullable<S3BucketState["notificationConfiguration"]>): Promise<S3BucketState> {
    await this.start();
    const located = this.requireBucket(name);
    if (located.bucket.managedBy) throw new AwsError("AccessDenied", "Simulator-managed bootstrap buckets cannot have application notifications", 403);
    // Reuse the S3 REST model parser so CloudFormation and PutBucketNotification
    // enforce the same event names, destination permissions, and overlap rules.
    const validated = this.parseNotification(this.notificationXml(configuration), located.bucket);
    await this.applyNotificationConfiguration(located, validated);
    return canonicalBucketState(located.bucket);
  }

  /** Delete an empty application bucket; versions and uploads truthfully conflict. */
  async deleteBucketInternal(name: string): Promise<void> {
    await this.start();
    const located = this.requireBucket(name);
    if (located.bucket.managedBy) throw new AwsError("AccessDenied", "Simulator-managed bootstrap buckets cannot be deleted through the application bucket lifecycle", 403);
    await this.namespaceLocked(name, async () => this.locked(located, async () => {
      const index = await this.bucketIndex(located);
      if (Object.keys(index.objects).length || Object.keys(index.multipartUploads).length || Object.keys(index.transferPins ?? {}).length) throw new AwsError("BucketNotEmpty", "The bucket you tried to delete is not empty", 409);
      delete this.store.regionState(located.region, located.accountId).s3Buckets[name];
      delete this.store.state.installation.s3BucketNames[name];
      this.indexes.delete(this.cacheKey(located));
      await Promise.all([this.store.save(), this.storage.deleteBucket(located.accountId, located.region, name)]);
    }));
  }

  async putBucketPolicyInternal(name: string, value: PolicyDocument): Promise<void> {
    await this.start();
    const document = validatePolicyDocument(value);
    const located = this.requireBucket(name);
    if (located.bucket.managedBy) throw new AwsError("AccessDenied", "Simulator-managed bootstrap buckets cannot have application bucket policies", 403);
    if (this.effectiveBlock(located).blockPublicPolicy && policyIsPublic(document)) throw new AwsError("AccessDenied", "The effective public-access-block configuration rejects public bucket policies", 403);
    if (JSON.stringify(located.bucket.policyDocument) !== JSON.stringify(document)) {
      located.bucket.policyDocument = document;
      await this.store.save();
    }
  }

  async readBucketPolicyInternal(name: string): Promise<PolicyDocument | undefined> {
    await this.start();
    const located = this.requireBucket(name);
    return located.bucket.policyDocument ? structuredClone(located.bucket.policyDocument) : undefined;
  }

  async deleteBucketPolicyInternal(name: string): Promise<void> {
    await this.start();
    const located = this.requireBucket(name);
    if (located.bucket.managedBy) throw new AwsError("AccessDenied", "Simulator-managed bootstrap buckets cannot have application bucket policies", 403);
    if (located.bucket.policyDocument !== undefined) {
      delete located.bucket.policyDocument;
      await this.store.save();
    }
  }

  /**
   * Materialize the real S3 bucket used by the reduced local CDK bootstrap.
   * This deliberately goes through S3's namespace lock and storage layer so
   * bootstrap assets are ordinary, durable S3 objects. An application-owned
   * bucket with the deterministic CDK name is never adopted implicitly.
   */
  async ensureManagedBucket(name: string, managedRevision: number): Promise<S3BucketState> {
    if (!Number.isSafeInteger(managedRevision) || managedRevision < 1) throw new RangeError("managedRevision must be a positive safe integer");
    await this.start();
    return this.namespaceLocked(name, async () => {
      validateBucketName(name);
      const existing = this.findBucket(name);
      if (existing) {
        if (existing.accountId !== this.store.accountId || existing.region !== this.region || existing.bucket.managedBy !== "stacksim-cdk-bootstrap") {
          throw new AwsError("BucketAlreadyExists", `CDK bootstrap bucket ${name} already exists but is not owned by the stacksim bootstrap manager; reset the local environment or choose a fresh data directory`, 409);
        }
        if ((existing.bucket.managedRevision ?? 0) > managedRevision) throw new AwsError("InvalidBucketState", `CDK bootstrap bucket ${name} was created by newer policy revision ${existing.bucket.managedRevision}`, 409);
        if (existing.bucket.managedRevision === managedRevision && existing.bucket.versioning !== "enabled") {
          throw new AwsError("InvalidBucketState", `CDK bootstrap bucket ${name} was locally edited; expected versioning to remain enabled. Reset the local environment to repair it`, 409);
        }
        if (existing.bucket.managedRevision !== managedRevision || existing.bucket.versioning !== "enabled") {
          existing.bucket.versioning = "enabled";
          existing.bucket.managedRevision = managedRevision;
          await this.store.save();
        }
        // Loading the index here makes an interrupted first-time creation
        // recover by either validating the durable index or failing loudly.
        await this.bucketIndex(existing);
        return structuredClone(existing.bucket);
      }
      if (this.allOwnedBuckets().length >= this.maximumBuckets) throw new AwsError("TooManyBuckets", "You have attempted to create more buckets than allowed.", 400);
      const bucket: S3BucketState = {
        name,
        arn: bucketArn(name),
        region: this.region,
        ownerAccountId: this.store.accountId,
        ownerId: ownerId(this.store.accountId),
        createdAt: this.clock.now(),
        versioning: "enabled",
        encryption: "AES256",
        tags: {},
        publicAccessBlock: canonicalPublicAccessBlock(),
        objectOwnership: "BucketOwnerEnforced",
        acl: privateAcl(this.store.accountId),
        requestPayment: "BucketOwner",
        abacStatus: "Disabled",
        managedBy: "stacksim-cdk-bootstrap",
        managedRevision,
      };
      this.store.regionState(this.region).s3Buckets[name] = bucket;
      this.store.state.installation.s3BucketNames[name] = { accountId: this.store.accountId, region: this.region };
      await Promise.all([
        this.store.save(),
        this.storage.saveBucket(this.store.accountId, this.region, name, { schemaVersion: 1, objects: {}, multipartUploads: {} }),
      ]);
      return structuredClone(bucket);
    });
  }

  async readObjectBytes(bucketName: string, key: string, versionId?: string, maximumBytes = this.maximumObjectBytes): Promise<S3InternalObject> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new RangeError("maximumBytes must be a non-negative safe integer");
    await this.start();
    const located = this.requireBucket(bucketName);
    const index = await this.bucketIndex(located);
    const object = selectObject(index, key, versionId).version;
    if (object.size > maximumBytes) throw new AwsError("EntityTooLarge", `Object ${bucketName}/${key} exceeds the ${maximumBytes} byte internal read limit`, 400);
    const chunks: Buffer[] = [];
    let size = 0;
    const digest = createHash("sha256");
    for await (const chunk of this.storage.readBlob(object.blobId!)) {
      size += chunk.length;
      if (size > maximumBytes || size > object.size) throw new AwsError("InvalidObjectState", `Object ${bucketName}/${key} has invalid stored size metadata`, 500);
      digest.update(chunk);
      chunks.push(Buffer.from(chunk));
    }
    if (size !== object.size) throw new AwsError("InvalidObjectState", `Object ${bucketName}/${key} is incomplete in local storage`, 500);
    const view = internalObjectView(bucketName, key, object);
    return { ...view, ownerAccountId: located.accountId, body: Buffer.concat(chunks, size), sha256: digest.digest("hex") };
  }

  /** Simulator-owned admission check; never exposed through the S3 HTTP API. */
  bucketOwnerAccountIdInternal(bucketName: string): string {
    const located = this.findBucket(bucketName);
    if (!located) throw new AwsError("NoSuchBucket", "The specified bucket does not exist", 404);
    return located.accountId;
  }

  async listCurrentObjectsInternal(bucketName: string, prefix = ""): Promise<S3InternalCurrentObject[]> {
    await this.start();
    const located = this.requireBucket(bucketName);
    const index = await this.bucketIndex(located);
    return this.visibleObjects(index)
      .filter(entry => entry.key.startsWith(prefix))
      .map(entry => internalObjectView(bucketName, entry.key, entry.object));
  }

  async putObjectBytesInternal(bucketName: string, key: string, body: Uint8Array, options: S3InternalPutObjectOptions = {}): Promise<{ object: S3InternalCurrentObject; changed: boolean }> {
    const bytes = Buffer.from(body);
    return this.putObjectIterableInternal(bucketName, key, (async function* () { yield bytes; })(), options);
  }

  private async putObjectIterableInternal(bucketName: string, key: string, body: AsyncIterable<Uint8Array>, options: S3InternalPutObjectOptions = {}): Promise<{ object: S3InternalCurrentObject; changed: boolean }> {
    await this.start();
    if (Buffer.byteLength(key) > 1_024) throw new AwsError("KeyTooLongError", "Your key is too long", 400);
    const metadata: Record<string, string> = {};
    for (const suppliedName of Object.keys(options.metadata ?? {}).sort(utf8Compare)) {
      const name = suppliedName.toLowerCase();
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || Object.hasOwn(metadata, name)) throw new AwsError("InvalidArgument", "Object metadata contains an invalid or duplicate field name", 400);
      const value = options.metadata![suppliedName];
      if (typeof value !== "string") throw new AwsError("InvalidArgument", "Object metadata values must be strings", 400);
      metadata[name] = internalHeaderValue(`x-amz-meta-${name}`, value)!;
    }
    if (Object.entries(metadata).reduce((bytes, [name, value]) => bytes + Buffer.byteLength(`x-amz-meta-${name}`) + Buffer.byteLength(value), 0) > 2 * 1024) throw new AwsError("MetadataTooLarge", "Your metadata headers exceed the maximum allowed metadata size.", 400);
    const tags = validateTags(options.tags);
    const normalized: S3InternalPutObjectOptions = {
      contentType: internalHeaderValue("content-type", options.contentType),
      contentEncoding: internalHeaderValue("content-encoding", options.contentEncoding),
      contentDisposition: internalHeaderValue("content-disposition", options.contentDisposition),
      contentLanguage: internalHeaderValue("content-language", options.contentLanguage),
      cacheControl: internalHeaderValue("cache-control", options.cacheControl),
      expires: internalHeaderValue("expires", options.expires),
      metadata,
      tags,
    };
    const located = this.requireBucket(bucketName);
    if (located.bucket.managedBy) throw new AwsError("AccessDenied", "The deployment helper cannot write application objects into the simulator-managed bootstrap bucket", 403);
    const staged = await this.storage.stageIterable(body, this.maximumObjectBytes);
    try {
      return await this.locked(located, async () => {
      const index = await this.bucketIndex(located);
      const current = currentObject(index, key);
      if (current && !current.deleteMarker && current.blobId === staged.digest.sha256Hex
        && current.contentType === normalized.contentType
        && current.contentEncoding === normalized.contentEncoding
        && current.contentDisposition === normalized.contentDisposition
        && current.contentLanguage === normalized.contentLanguage
        && current.cacheControl === normalized.cacheControl
        && current.expires === normalized.expires
        && JSON.stringify(current.metadata) === JSON.stringify(metadata)
        && JSON.stringify(current.tags ?? {}) === JSON.stringify(tags)) {
        await this.storage.discardStaged(staged);
        return { object: internalObjectView(bucketName, key, current), changed: false };
      }
      if (options.failIfExists && current && !current.deleteMarker) throw new AwsError("PreconditionFailed", `Destination object s3://${bucketName}/${key} already exists`, 412);
      if (options.enforceObjectLock && current && !current.deleteMarker) this.enforceDeletionLock({ headers: {} } as IncomingMessage, current);
        await this.ensureCapacity(located, index, key, staged.size);
        const blobId = await this.storage.publish(staged);
        const checksumAlgorithm: S3ChecksumAlgorithm = "CRC64NVME";
        const object: S3ObjectVersionState = {
          versionId: versionIdForWrite(located.bucket),
          blobId,
          size: staged.size,
          etag: staged.digest.etag,
          lastModified: this.clock.now(),
          ...normalized,
          metadata,
          tags,
          checksums: { [checksumAlgorithm]: staged.digest.values[checksumAlgorithm] },
          checksumAlgorithm,
          checksumType: "FULL_OBJECT",
          storageClass: "STANDARD",
          encryption: "AES256",
          ownerAccountId: located.accountId,
          ownerId: ownerId(located.accountId),
          acl: privateAcl(located.accountId),
        };
        publishVersion(located.bucket, index, key, object);
        await this.saveBucket(located, index);
        return { object: internalObjectView(bucketName, key, object), changed: true };
      });
    } catch (error) {
      await this.storage.discardStaged(staged);
      throw error;
    }
  }

  /** Idempotent current-key deletion used by prune; a replay never adds a second marker. */
  async deleteObjectInternal(bucketName: string, key: string): Promise<{ deleted: boolean; versionId?: string }> {
    await this.start();
    const located = this.requireBucket(bucketName);
    if (located.bucket.managedBy) throw new AwsError("AccessDenied", "The deployment helper cannot prune simulator-managed bootstrap assets", 403);
    return this.locked(located, async () => {
      const index = await this.bucketIndex(located);
      const current = currentObject(index, key);
      if (!current || current.deleteMarker) return { deleted: false };
      const result = this.deleteFromIndex({ headers: {} } as IncomingMessage, located.bucket, index, key);
      await this.saveBucket(located, index);
      return { deleted: true, versionId: result.versionId };
    });
  }

  /**
   * Narrow S3-owned transfer port for DynamoDB import/export.
   * Authorization, region/ownership, archive/SSE-C protections, and version pins live here.
   */
  createTransferPort(): S3TransferPort {
    const service = this;
    return {
      async admitBucket(bucket, caller) { return service.admitTransferBucket(bucket, caller); },
      async pinCurrentObject(bucket, key, caller) { return service.pinTransferObject(bucket, key, caller); },
      async listAndPinPrefix(bucket, prefix, caller) { return service.listAndPinTransferPrefix(bucket, prefix, caller); },
      readPinned(pin, caller, maximumBytes) { return service.readPinnedTransferObject(pin, caller, maximumBytes); },
      async writeObject(bucket, key, body, caller, options) { return service.writeTransferObject(bucket, key, body, caller, options); },
      async releasePins(pins, caller) { return service.releaseTransferPins(pins, caller); },
    };
  }

  /**
   * CloudFront's private origin path. S3 remains the sole owner of bucket
   * lookup, Region/account checks, resource-policy evaluation, CORS and bytes.
   */
  createCloudFrontOriginPort(): CloudFrontS3OriginPort {
    return { request: input => this.requestCloudFrontOrigin(input) };
  }

  private async requestCloudFrontOrigin(input: CloudFrontS3OriginRequest): Promise<CloudFrontS3OriginResponse> {
    await this.start();
    if (input.accountId !== this.store.accountId || input.bucketRegion !== this.region) throw new AwsError("AccessDenied", "Access Denied", 403);
    if (input.maximumBytes < 0 || !Number.isSafeInteger(input.maximumBytes)) throw new AwsError("InvalidArgument", "The origin response limit is invalid", 400);
    const located = this.findBucket(input.bucketName);
    if (!located) throw new AwsError("NoSuchBucket", "The specified bucket does not exist", 404);
    if (located.accountId !== input.accountId) throw new AwsError("AccessDenied", "Access Denied", 403);
    if (located.region !== input.bucketRegion) throw new AwsError("PermanentRedirect", "The bucket must be addressed using its regional endpoint", 301, { region: located.region });
    const distribution = input.distributionArn.match(/^arn:aws:cloudfront::(\d{12}):distribution\/([A-Z0-9]+)$/);
    if (!distribution || distribution[1] !== input.accountId) throw new AwsError("AccessDenied", "Access Denied", 403);

    if (input.method === "OPTIONS") {
      const origin = input.headers.origin ?? "";
      const requestedMethod = input.headers["access-control-request-method"] ?? "";
      const rule = this.matchingCorsRule(located.bucket, origin, requestedMethod);
      if (!origin || !requestedMethod || !rule) throw new AwsError("AccessForbidden", "CORSResponse: This CORS request is not allowed", 403);
      const maxAgeSeconds = (rule as S3BucketCorsRule & { maxAgeSeconds?: number }).maxAgeSeconds;
      return { status: 200, headers: { "access-control-allow-origin": origin, "access-control-allow-methods": rule.allowedMethods.join(", "), ...(maxAgeSeconds === undefined ? {} : { "access-control-max-age": String(maxAgeSeconds) }) }, body: Buffer.alloc(0) };
    }

    const resource = objectArn(input.bucketName, input.key);
    const context: AuthorizationContext = {
      "aws:PrincipalArn": CLOUDFRONT_S3_SERVICE_PRINCIPAL,
      "aws:PrincipalAccount": input.accountId,
      "aws:PrincipalServiceName": CLOUDFRONT_S3_SERVICE_PRINCIPAL,
      "aws:SourceArn": input.distributionArn,
      "aws:SourceAccount": input.accountId,
      "aws:RequestedRegion": input.bucketRegion,
      "aws:SecureTransport": true,
      "aws:CurrentTime": new Date(this.clock.now()).toISOString(),
    };
    const policy = located.bucket.policyDocument
      ? evaluateResourcePolicy(located.bucket.policyDocument, CLOUDFRONT_S3_SERVICE_PRINCIPAL, "s3:GetObject", resource, context)
      : { decision: "implicitDeny" as const, reason: "The bucket has no policy authorizing CloudFront", matchedStatements: [] };
    const authorization = combineIdentityAndResourceAuthorization(undefined, policy, "service");
    if (authorization.decision !== "allowed") throw new AwsError("AccessDenied", "Access Denied", 403);

    const index = await this.bucketIndex(located);
    const selected = selectObject(index, input.key).version;
    if (selected.size > input.maximumBytes) throw new AwsError("EntityTooLarge", "The origin object exceeds the local CloudFront response limit", 400);
    const headers: Record<string, string> = {
      etag: quotedEtag(selected.etag),
      "last-modified": httpDate(selected.lastModified),
      "content-length": String(selected.size),
      "content-type": selected.contentType ?? "application/octet-stream",
      ...(selected.cacheControl ? { "cache-control": selected.cacheControl } : {}),
      ...(selected.contentEncoding ? { "content-encoding": selected.contentEncoding } : {}),
    };
    if (input.method === "HEAD") return { status: 200, headers, body: Buffer.alloc(0), etag: selected.etag, lastModified: selected.lastModified };
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of this.storage.readBlob(selected.blobId!)) { size += chunk.length; if (size > input.maximumBytes || size > selected.size) throw new AwsError("InvalidObjectState", "Origin object size is inconsistent", 500); chunks.push(Buffer.from(chunk)); }
    if (size !== selected.size) throw new AwsError("InvalidObjectState", "Origin object is incomplete", 500);
    return { status: 200, headers, body: Buffer.concat(chunks, size), etag: selected.etag, lastModified: selected.lastModified };
  }

  private transferCallerContext(caller: S3TransferCaller): AuthorizationContext {
    return {
      "aws:PrincipalArn": caller.servicePrincipal,
      "aws:PrincipalAccount": caller.sourceAccount,
      "aws:PrincipalServiceName": caller.servicePrincipal,
      "aws:SourceAccount": caller.sourceAccount,
      "aws:SourceArn": caller.sourceArn,
      "aws:RequestedRegion": this.region,
      "aws:CurrentTime": new Date(this.clock.now()).toISOString(),
    };
  }

  private async locateTransferBucket(bucketName: string, caller: S3TransferCaller): Promise<LocatedBucket> {
    await this.start();
    validateBucketName(bucketName);
    const located = this.findBucket(bucketName);
    if (!located) throw new AwsError("NoSuchBucket", "The specified bucket does not exist", 404);
    if (located.region !== this.region) {
      throw new AwsError("PermanentRedirect", "The bucket you are attempting to access must be addressed using the specified endpoint.", 301, { region: located.region });
    }
    const expectedOwner = caller.expectedBucketOwner;
    if (expectedOwner !== undefined && expectedOwner !== located.accountId) {
      throw new AwsError("AccessDenied", "The bucket is owned by a different account than S3BucketOwner", 403);
    }
    if (expectedOwner === undefined && located.accountId !== caller.sourceAccount) {
      throw new AwsError("AccessDenied", "Cross-account DynamoDB S3 transfers require S3BucketOwner to match the bucket owner", 403);
    }
    if (located.bucket.managedBy) throw new AwsError("AccessDenied", "Simulator-managed bootstrap buckets cannot be used for DynamoDB import/export", 403);
    return located;
  }

  private async admitTransferBucket(bucketName: string, caller: S3TransferCaller): Promise<S3AdmittedBucket> {
    if (caller.servicePrincipal !== DYNAMODB_S3_SERVICE_PRINCIPAL) {
      throw new AwsError("AccessDenied", "Only the DynamoDB service principal may use this transfer port", 403);
    }
    const located = await this.locateTransferBucket(bucketName, caller);
    return { name: located.bucket.name, ownerAccountId: located.accountId, region: located.region };
  }

  private async authorizeTransfer(caller: S3TransferCaller, action: string, resource: string): Promise<AuthorizationResult> {
    const match = resource.match(/^arn:aws:s3:::([^/]+)(?:\/(.*))?$/);
    if (!match) return { decision: "implicitDeny", reason: "Transfer resources must be S3 ARNs", matchedStatements: [] };
    const located = await this.locateTransferBucket(match[1], caller);
    const context = this.transferCallerContext(caller);
    const policy = located.bucket.policyDocument
      ? evaluateResourcePolicy(located.bucket.policyDocument, caller.servicePrincipal, action, resource, context)
      : { decision: "implicitDeny" as const, reason: "The bucket has no resource policy authorizing DynamoDB", matchedStatements: [] };
    return combineIdentityAndResourceAuthorization(undefined, policy, "service");
  }

  private transferGeneration(caller: S3TransferCaller, bucket: string, key: string, object: S3ObjectVersionState): string {
    return createHash("sha256").update(`${caller.sourceArn}\0${bucket}\0${key}\0${object.versionId}\0${object.etag}\0${object.blobId ?? ""}`).digest("hex");
  }

  private pinFromVersion(bucket: string, key: string, generation: string, object: S3ObjectVersionState): S3PinnedObject {
    if (!object.blobId || object.deleteMarker) throw new AwsError("NoSuchKey", "The specified key does not exist.", 404);
    if (object.sseCustomerKeyMd5) throw new AwsError("InvalidRequest", "SSE-C objects cannot be used for DynamoDB import/export", 400);
    this.refreshRestore(object);
    this.ensureArchiveReadable(object);
    return {
      bucket,
      key,
      generation,
      versionId: object.versionId,
      etag: object.etag,
      size: object.size,
      storageClass: object.storageClass,
    };
  }

  private async pinTransferObject(bucketName: string, key: string, caller: S3TransferCaller): Promise<S3PinnedObject> {
    const located = await this.locateTransferBucket(bucketName, caller);
    await this.requireAuthorizedTransfer(caller, "s3:GetObject", objectArn(bucketName, key));
    return this.locked(located, async () => {
      const index = await this.bucketIndex(located);
      const object = selectObject(index, key, undefined).version;
      const generation = this.transferGeneration(caller, bucketName, key, object);
      (index.transferPins ??= {})[generation] = { key, sourceArn: caller.sourceArn, object: structuredClone(object) };
      await this.saveBucket(located, index);
      return this.pinFromVersion(bucketName, key, generation, object);
    });
  }

  private async listAndPinTransferPrefix(bucketName: string, prefix: string, caller: S3TransferCaller): Promise<S3PinnedObject[]> {
    const located = await this.locateTransferBucket(bucketName, caller);
    await this.requireAuthorizedTransfer(caller, "s3:ListBucket", bucketArn(bucketName));
    return this.locked(located, async () => {
      const index = await this.bucketIndex(located);
      // An ADMITTED import may stop after S3 pinned its candidates but before
      // DynamoDB persisted the selected generations. A retry owns this exact
      // SourceArn, so replace those unreachable admission pins before repinning.
      for (const [generation, retained] of Object.entries(index.transferPins ?? {})) {
        if (retained.sourceArn === caller.sourceArn) delete index.transferPins![generation];
      }
      const entries = this.visibleObjects(index).filter(item => item.key.startsWith(prefix));
      for (const entry of entries) await this.requireAuthorizedTransfer(caller, "s3:GetObject", objectArn(bucketName, entry.key));
      const pins = entries.map(entry => {
        const generation = this.transferGeneration(caller, bucketName, entry.key, entry.object);
        return { pin: this.pinFromVersion(bucketName, entry.key, generation, entry.object), generation, entry };
      });
      for (const { generation, entry } of pins) (index.transferPins ??= {})[generation] = { key: entry.key, sourceArn: caller.sourceArn, object: structuredClone(entry.object) };
      await this.saveBucket(located, index);
      return pins.map(item => item.pin);
    });
  }

  private async requireAuthorizedTransfer(caller: S3TransferCaller, action: string, resource: string): Promise<void> {
    const decision = await this.authorizeTransfer(caller, action, resource);
    if (decision.decision !== "allowed") throw new AwsError("AccessDenied", `${caller.servicePrincipal} is not authorized to perform ${action} on ${resource}`, 403);
  }

  private async *readPinnedTransferObject(pin: S3PinnedObject, caller: S3TransferCaller, maximumBytes = this.maximumObjectBytes): AsyncGenerator<Buffer> {
    const located = await this.locateTransferBucket(pin.bucket, caller);
    await this.requireAuthorizedTransfer(caller, "s3:GetObject", objectArn(pin.bucket, pin.key));
    const index = await this.bucketIndex(located);
    const retained = index.transferPins?.[pin.generation];
    if (!retained || retained.key !== pin.key || retained.sourceArn !== caller.sourceArn) throw new AwsError("NoSuchKey", "The admitted DynamoDB transfer generation is no longer retained", 404);
    const object = retained.object;
    if (object.versionId !== pin.versionId || object.etag !== pin.etag || object.size !== pin.size) {
      throw new AwsError("InvalidObjectState", "The pinned object generation no longer matches the admitted DynamoDB transfer pin", 409);
    }
    this.refreshRestore(object);
    this.ensureArchiveReadable(object);
    if (object.sseCustomerKeyMd5) throw new AwsError("InvalidRequest", "SSE-C objects cannot be used for DynamoDB import/export", 400);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new RangeError("maximumBytes must be a non-negative safe integer");
    if (object.size > maximumBytes) throw new AwsError("EntityTooLarge", `Object ${pin.bucket}/${pin.key} exceeds the ${maximumBytes} byte transfer read limit`, 400);
    let size = 0;
    try {
      for await (const chunk of this.storage.readBlob(object.blobId!)) {
        size += chunk.length;
        if (size > maximumBytes || size > object.size) throw new AwsError("InvalidObjectState", `Object ${pin.bucket}/${pin.key} has invalid stored size metadata`, 500);
        yield chunk;
      }
    } catch (error) {
      if (error instanceof AwsError) throw error;
      throw new AwsError("InvalidObjectState", `Object ${pin.bucket}/${pin.key} failed its local at-rest integrity check`, 500);
    }
    if (size !== object.size) throw new AwsError("InvalidObjectState", `Object ${pin.bucket}/${pin.key} is incomplete in local storage`, 500);
  }

  private async writeTransferObject(bucketName: string, key: string, body: AsyncIterable<Uint8Array>, caller: S3TransferCaller, options: S3TransferWriteOptions = {}): Promise<S3PinnedObject> {
    await this.locateTransferBucket(bucketName, caller);
    await this.requireAuthorizedTransfer(caller, "s3:PutObject", objectArn(bucketName, key));
    const written = await this.putObjectIterableInternal(bucketName, key, body, {
      contentType: options.contentType,
      contentEncoding: options.contentEncoding,
      metadata: options.metadata,
      failIfExists: options.failIfExists,
      enforceObjectLock: true,
    });
    return {
      bucket: bucketName,
      key,
      generation: createHash("sha256").update(`${caller.sourceArn}\0${bucketName}\0${key}\0${written.object.versionId}\0${written.object.etag}`).digest("hex"),
      versionId: written.object.versionId,
      etag: written.object.etag,
      size: written.object.size,
      storageClass: written.object.storageClass,
    };
  }

  private async releaseTransferPins(pins: S3PinnedObject[], caller: S3TransferCaller): Promise<void> {
    for (const bucketName of [...new Set(pins.map(pin => pin.bucket))]) {
      const located = await this.locateTransferBucket(bucketName, caller);
      await this.locked(located, async () => {
        const index = await this.bucketIndex(located);
        let changed = false;
        for (const pin of pins.filter(candidate => candidate.bucket === bucketName)) {
          const retained = index.transferPins?.[pin.generation];
          if (retained?.sourceArn !== caller.sourceArn) continue;
          delete index.transferPins![pin.generation];
          changed = true;
        }
        if (changed) await this.saveBucket(located, index);
      });
    }
  }

  async listObjectVersionsInternal(bucketName: string): Promise<S3InternalObjectVersion[]> {
    await this.start();
    const located = this.requireBucket(bucketName);
    const index = await this.bucketIndex(located);
    return Object.entries(index.objects).flatMap(([key, versions]) => versions.map(version => ({
      key,
      versionId: version.versionId,
      lastModified: version.lastModified,
      size: version.size,
      deleteMarker: Boolean(version.deleteMarker),
    }))).sort((left, right) => utf8Compare(left.key, right.key) || right.lastModified - left.lastModified || utf8Compare(left.versionId, right.versionId));
  }

  async deleteObjectVersionInternal(bucketName: string, key: string, versionId: string): Promise<void> {
    await this.start();
    const located = this.requireBucket(bucketName);
    await this.locked(located, async () => {
      const index = await this.bucketIndex(located);
      this.deleteFromIndex({ headers: {} } as IncomingMessage, located.bucket, index, key, versionId);
      await this.saveBucket(located, index);
    });
  }

  /** Anonymous local S3 website endpoint. Authorization is exclusively resource-policy based. */
  async handleWebsite(req: IncomingMessage, res: ServerResponse, url: URL, requestId: string): Promise<void> {
    const route = "/_stacksim/s3-website/";
    const resource = url.pathname;
    const hostId = createHash("sha256").update(`${this.store.state.installation.id}:${requestId}:website`).digest("base64");
    res.setHeader("x-amz-id-2", hostId);
    try {
      await this.start();
      if (req.method !== "GET" && req.method !== "HEAD") throw new AwsError("MethodNotAllowed", "The specified method is not allowed against this resource.", 405);
      if (!url.pathname.startsWith(route)) throw new AwsError("NoSuchWebsiteConfiguration", "The specified bucket does not have a website configuration", 404);
      const remainder = url.pathname.slice(route.length);
      const separator = remainder.indexOf("/");
      const rawBucket = separator < 0 ? remainder : remainder.slice(0, separator);
      if (!rawBucket) throw new AwsError("NoSuchBucket", "The specified bucket does not exist", 404);
      const bucketName = decodePathComponent(rawBucket);
      const located = this.requireBucket(bucketName);
      const website = validateWebsiteConfiguration(located.bucket.website);
      if (!website) throw new AwsError("NoSuchWebsiteConfiguration", "The specified bucket does not have a website configuration", 404);
      const rawKey = separator < 0 ? "" : remainder.slice(separator + 1);
      let key = rawKey ? decodePathComponent(rawKey) : "";
      if (!key || key.endsWith("/")) key += website.indexDocument;
      if (this.effectiveBlock(located).restrictPublicBuckets || !publicGetAllowed(located.bucket, key)) throw new AwsError("AccessDenied", "Access Denied", 403);
      const index = await this.bucketIndex(located);
      let object = currentObject(index, key);
      let status = 200;
      if (!object || object.deleteMarker) {
        if (!website.errorDocument || !publicGetAllowed(located.bucket, website.errorDocument)) throw new AwsError("NoSuchKey", "The specified key does not exist.", 404);
        object = currentObject(index, website.errorDocument);
        if (!object || object.deleteMarker) throw new AwsError("NoSuchKey", "The specified key does not exist.", 404);
        status = 404;
      }
      setObjectHeaders(res, object);
      res.statusCode = status;
      res.setHeader("content-length", String(object.size));
      if (req.method === "HEAD" || object.size === 0) { res.end(); return; }
      await this.streamBlob(res, object.blobId!, 0, object.size - 1);
    } catch (error) {
      return sendS3Error(res, error, resource, requestId, hostId);
    }
  }

  async handleControl(req: IncomingMessage, res: ServerResponse, url: URL, requestId: string, principal: PrincipalContext): Promise<void> {
    const hostId = createHash("sha256").update(`${this.store.state.installation.id}:${requestId}:s3-control`).digest("base64");
    res.setHeader("x-amz-id-2", hostId);
    try {
      if (url.pathname !== "/v20180820/configuration/publicAccessBlock") throw new AwsError("NotFound", "The requested S3 Control resource was not found", 404);
      const accountId = String(req.headers["x-amz-account-id"] ?? "");
      if (!/^\d{12}$/.test(accountId)) throw new AwsError("InvalidRequest", "x-amz-account-id is required", 400);
      if (accountId !== principal.accountId || accountId !== this.store.accountId) throw new AwsError("AccessDenied", "Access Denied", 403);
      const account = this.store.ensureAccount(accountId);
      if (req.method === "GET") {
        if (!account.s3PublicAccessBlock) throw new AwsError("NoSuchPublicAccessBlockConfiguration", "The public access block configuration was not found", 404);
        const value = account.s3PublicAccessBlock;
        res.statusCode = 200; res.setHeader("content-type", "application/xml");
        res.end(`<?xml version="1.0" encoding="UTF-8"?><PublicAccessBlockConfiguration xmlns="http://awss3control.amazonaws.com/doc/2018-08-20/"><BlockPublicAcls>${value.blockPublicAcls}</BlockPublicAcls><IgnorePublicAcls>${value.ignorePublicAcls}</IgnorePublicAcls><BlockPublicPolicy>${value.blockPublicPolicy}</BlockPublicPolicy><RestrictPublicBuckets>${value.restrictPublicBuckets}</RestrictPublicBuckets></PublicAccessBlockConfiguration>`);
        return;
      }
      if (req.method === "PUT") {
        const xml = (await readBody(req)).toString("utf8");
        if (!/<PublicAccessBlockConfiguration(?:\s|>)/i.test(xml)) throw new AwsError("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema", 400);
        account.s3PublicAccessBlock = {
          blockPublicAcls: parseXmlBoolean(xml, "BlockPublicAcls"),
          ignorePublicAcls: parseXmlBoolean(xml, "IgnorePublicAcls"),
          blockPublicPolicy: parseXmlBoolean(xml, "BlockPublicPolicy"),
          restrictPublicBuckets: parseXmlBoolean(xml, "RestrictPublicBuckets"),
        };
        await this.store.save(); res.statusCode = 200; res.end(); return;
      }
      if (req.method === "DELETE") {
        delete account.s3PublicAccessBlock; await this.store.save(); res.statusCode = 204; res.end(); return;
      }
      throw new AwsError("MethodNotAllowed", "The specified method is not allowed against this resource.", 405);
    } catch (error) {
      sendS3Error(res, error, url.pathname, requestId, hostId);
    }
  }

  async enrichAuthorizationContext(resource: string, context: AuthorizationContext): Promise<void> {
    const match = resource.match(/^arn:aws:s3:::([^/]+)(?:\/(.*))?$/);
    if (!match) return;
    const located = this.findBucket(match[1]); if (!located) return;
    if (located.bucket.abacStatus === "Enabled") {
      for (const [key, value] of Object.entries(located.bucket.tags ?? {})) {
        context[`aws:ResourceTag/${key}`] = value;
        context[`s3:ResourceTag/${key}`] = value;
      }
    }
    if (match[2] !== undefined) {
      const index = await this.bucketIndex(located);
      try {
        const version = selectObject(index, match[2], typeof context["s3:VersionId"] === "string" ? context["s3:VersionId"] : undefined).version;
        for (const [key, value] of Object.entries(version.tags ?? {})) context[`s3:ExistingObjectTag/${key}`] = value;
      } catch { /* The protocol handler returns the modeled missing-key response. */ }
    }
  }

  async resourceAuthorization(principal: PrincipalContext, action: string, resource: string, context: AuthorizationContext): Promise<{ result: AuthorizationResult; ownerAccountId: string } | undefined> {
    const match = resource.match(/^arn:aws:s3:::([^/]+)(?:\/(.*))?$/); if (!match) return undefined;
    const located = this.findBucket(match[1]); if (!located) return undefined;
    let policy: AuthorizationResult = located.bucket.policyDocument
      ? evaluateResourcePolicy(located.bucket.policyDocument, principal, action, resource, context)
      : { decision: "implicitDeny", reason: "The bucket has no resource policy", matchedStatements: [] };
    const block = this.effectiveBlock(located);
    if (block.restrictPublicBuckets && policyIsPublic(located.bucket.policyDocument) && principal.accountId !== located.accountId && policy.decision === "allowed") policy = { decision: "implicitDeny", reason: "RestrictPublicBuckets blocks public cross-account access", matchedStatements: policy.matchedStatements };
    let acl = located.bucket.acl ?? privateAcl(located.accountId);
    if (match[2] !== undefined && !action.endsWith("PutObject") && !action.endsWith("DeleteObject")) {
      try { acl = objectAcl(selectObject(await this.bucketIndex(located), match[2], typeof context["s3:VersionId"] === "string" ? context["s3:VersionId"] : undefined).version, located.bucket); } catch {}
    }
    const aclAllowed = located.bucket.objectOwnership !== "BucketOwnerEnforced" && aclAllows(acl, principal.accountId || undefined, principal.principalArn !== "*", action, block.ignorePublicAcls);
    if (policy.decision === "explicitDeny") return { result: policy, ownerAccountId: located.accountId };
    if (aclAllowed) return { result: { decision: "allowed", reason: "An applicable S3 ACL grant allows the action", matchedStatements: policy.matchedStatements }, ownerAccountId: located.accountId };
    return { result: policy, ownerAccountId: located.accountId };
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, requestId: string, principal: PrincipalContext): Promise<void> {
    const address = parseAddress(req); const hostId = createHash("sha256").update(`${this.store.state.installation.id}:${requestId}`).digest("base64"); res.setHeader("x-amz-id-2", hostId);
    const startedAt = this.clock.now();
    res.once("finish", () => {
      if (!address.bucket) return;
      const duration = Math.max(0, this.clock.now() - startedAt); const requestBytes = Number(req.headers["x-amz-decoded-content-length"] ?? req.headers["content-length"] ?? 0); const responseBytes = Number(res.getHeader("content-length") ?? 0);
      const metrics = [this.metric(address.bucket, "AllRequests", 1, "Count"), this.metric(address.bucket, "TotalRequestLatency", duration, "Milliseconds")];
      if (requestBytes > 0 && new Set(["PUT", "POST"]).has(req.method ?? "")) metrics.push(this.metric(address.bucket, "BytesUploaded", requestBytes, "Bytes"));
      if (responseBytes > 0 && req.method === "GET") metrics.push(this.metric(address.bucket, "BytesDownloaded", responseBytes, "Bytes"));
      if (res.statusCode >= 400 && res.statusCode < 500) metrics.push(this.metric(address.bucket, "4xxErrors", 1, "Count"));
      if (res.statusCode >= 500) metrics.push(this.metric(address.bucket, "5xxErrors", 1, "Count"));
      void Promise.all(metrics);
    });
    try {
      await this.start();
      for (const name of ["x-amz-checksum-algorithm", "x-amz-sdk-checksum-algorithm", ...S3_CHECKSUM_ALGORITHMS.map(checksumHeaderName)]) if (req.headers[name] === undefined && url.searchParams.has(name)) req.headers[name] = url.searchParams.get(name)!;
      if (!address.bucket) { if (req.method === "GET") return await this.listBuckets(res, url); throw new AwsError("MethodNotAllowed", "The specified method is not allowed against this resource.", 405); }
      const addressed = this.findBucket(address.bucket);
      const expectedOwner = req.headers["x-amz-expected-bucket-owner"];
      if (addressed && expectedOwner !== undefined && String(expectedOwner) !== addressed.accountId) throw new AwsError("AccessDenied", "The bucket is owned by a different account than x-amz-expected-bucket-owner", 403);
      if (addressed && address.key && req.method === "OPTIONS") return this.corsPreflight(req, res, addressed.bucket);
      if (addressed && address.key && (req.method === "GET" || req.method === "HEAD")) this.applyCorsHeaders(req, res, addressed.bucket, req.method);
      const bucketControl = ["acl", "abac", "cors", "encryption", "lifecycle", "location", "notification", "notification-diagnostics", "object-lock", "ownershipControls", "policy", "policyStatus", "publicAccessBlock", "requestPayment", "tagging", "versioning", "website"].some(name => queryFlag(url, name));
      if (addressed?.bucket.requestPayment === "Requester" && principal.accountId !== addressed.accountId && (address.key || !bucketControl)) {
        if (String(req.headers["x-amz-request-payer"] ?? "") !== "requester") throw new AwsError("AccessDenied", "Requester Pays buckets require x-amz-request-payer: requester", 403);
        res.setHeader("x-amz-request-charged", "requester");
      }
      if (!address.key) {
        if (queryFlag(url, "acl")) {
          if (req.method === "GET") return await this.getBucketAcl(res, address.bucket);
          if (req.method === "PUT") return await this.putBucketAcl(req, res, address.bucket);
        }
        if (queryFlag(url, "ownershipControls")) {
          if (req.method === "GET") return await this.getBucketOwnershipControls(res, address.bucket);
          if (req.method === "PUT") return await this.putBucketOwnershipControls(req, res, address.bucket);
          if (req.method === "DELETE") return await this.deleteBucketOwnershipControls(res, address.bucket);
        }
        if (queryFlag(url, "abac")) {
          if (req.method === "GET") return await this.getBucketAbac(res, address.bucket);
          if (req.method === "PUT") return await this.putBucketAbac(req, res, address.bucket);
        }
        if (queryFlag(url, "requestPayment")) {
          if (req.method === "GET") return await this.getBucketRequestPayment(res, address.bucket);
          if (req.method === "PUT") return await this.putBucketRequestPayment(req, res, address.bucket);
        }
        if (queryFlag(url, "tagging")) {
          if (req.method === "GET") return await this.getBucketTagging(res, address.bucket);
          if (req.method === "PUT") return await this.putBucketTagging(req, res, address.bucket);
          if (req.method === "DELETE") return await this.deleteBucketTagging(res, address.bucket);
        }
        if (queryFlag(url, "publicAccessBlock")) {
          if (req.method === "GET") return await this.getBucketPublicAccessBlock(res, address.bucket);
          if (req.method === "PUT") return await this.putBucketPublicAccessBlock(req, res, address.bucket);
          if (req.method === "DELETE") return await this.deleteBucketPublicAccessBlock(res, address.bucket);
        }
        if (queryFlag(url, "website")) {
          if (req.method === "GET") return await this.getBucketWebsite(res, address.bucket);
          if (req.method === "PUT") return await this.putBucketWebsite(req, res, address.bucket);
          if (req.method === "DELETE") return await this.deleteBucketWebsite(res, address.bucket);
        }
        if (queryFlag(url, "cors")) {
          if (req.method === "GET") return await this.getBucketCors(res, address.bucket);
          if (req.method === "PUT") return await this.putBucketCors(req, res, address.bucket);
          if (req.method === "DELETE") return await this.deleteBucketCors(res, address.bucket);
        }
        if (queryFlag(url, "policy")) {
          if (req.method === "GET") return await this.getBucketPolicy(res, address.bucket);
          if (req.method === "PUT") return await this.putBucketPolicy(req, res, address.bucket);
          if (req.method === "DELETE") return await this.deleteBucketPolicy(res, address.bucket);
        }
        if (req.method === "GET" && queryFlag(url, "policyStatus")) return await this.getBucketPolicyStatus(res, address.bucket);
        if (req.method === "PUT" && queryFlag(url, "versioning")) return await this.putBucketVersioning(req, res, address.bucket);
        if (req.method === "GET" && queryFlag(url, "versioning")) return await this.getBucketVersioning(res, address.bucket);
        if (queryFlag(url, "encryption")) {
          if (req.method === "GET") return await this.getBucketEncryption(res, address.bucket);
          if (req.method === "PUT") return await this.putBucketEncryption(req, res, address.bucket);
          if (req.method === "DELETE") return await this.deleteBucketEncryption(res, address.bucket);
        }
        if (queryFlag(url, "object-lock")) {
          if (req.method === "GET") return await this.getObjectLockConfiguration(res, address.bucket);
          if (req.method === "PUT") return await this.putObjectLockConfiguration(req, res, address.bucket);
        }
        if (queryFlag(url, "lifecycle")) {
          if (req.method === "GET") return await this.getBucketLifecycle(res, address.bucket);
          if (req.method === "PUT") return await this.putBucketLifecycle(req, res, address.bucket);
          if (req.method === "DELETE") return await this.deleteBucketLifecycle(res, address.bucket);
        }
        if (queryFlag(url, "notification")) {
          if (req.method === "GET") return await this.getBucketNotification(res, address.bucket);
          if (req.method === "PUT") return await this.putBucketNotification(req, res, address.bucket);
        }
        if (req.method === "GET" && queryFlag(url, "notification-diagnostics")) return await this.getNotificationDiagnostics(res, address.bucket);
        if (req.method === "GET" && queryFlag(url, "location")) return await this.getBucketLocation(res, address.bucket);
        if (req.method === "GET" && queryFlag(url, "versions")) return await this.listObjectVersions(res, url, address.bucket);
        if (req.method === "GET" && queryFlag(url, "uploads")) return await this.listMultipartUploads(res, url, address.bucket);
        if (req.method === "POST" && queryFlag(url, "delete")) return await this.deleteObjects(req, res, address.bucket);
        if (req.method === "PUT") return await this.createBucket(req, res, address.bucket);
        if (req.method === "DELETE") return await this.deleteBucket(res, address.bucket);
        if (req.method === "HEAD") return await this.headBucket(res, address.bucket);
        if (req.method === "GET") return await this.listObjects(res, url, address.bucket);
      } else {
        if (req.method === "PUT" && queryFlag(url, "encryption")) return await this.updateObjectEncryption(req, res, url, address.bucket, address.key);
        if (queryFlag(url, "tagging")) {
          if (req.method === "GET") return await this.getObjectTagging(res, url, address.bucket, address.key);
          if (req.method === "PUT") return await this.putObjectTagging(req, res, url, address.bucket, address.key);
          if (req.method === "DELETE") return await this.deleteObjectTagging(req, res, url, address.bucket, address.key);
        }
        if (queryFlag(url, "retention")) {
          if (req.method === "GET") return await this.getObjectRetention(res, url, address.bucket, address.key);
          if (req.method === "PUT") return await this.putObjectRetention(req, res, url, address.bucket, address.key);
        }
        if (queryFlag(url, "legal-hold")) {
          if (req.method === "GET") return await this.getObjectLegalHold(res, url, address.bucket, address.key);
          if (req.method === "PUT") return await this.putObjectLegalHold(req, res, url, address.bucket, address.key);
        }
        if (queryFlag(url, "annotation")) {
          if (req.method === "GET" && url.searchParams.has("annotationName")) return await this.getObjectAnnotation(req, res, url, address.bucket, address.key);
          if (req.method === "GET") return await this.listObjectAnnotations(res, url, address.bucket, address.key);
          if (req.method === "PUT") return await this.putObjectAnnotation(req, res, url, address.bucket, address.key);
          if (req.method === "DELETE") return await this.deleteObjectAnnotation(req, res, url, address.bucket, address.key);
        }
        if (req.method === "POST" && queryFlag(url, "restore")) return await this.restoreObject(req, res, url, address.bucket, address.key);
        if (queryFlag(url, "acl")) {
          if (req.method === "GET") return await this.getObjectAcl(res, url, address.bucket, address.key);
          if (req.method === "PUT") return await this.putObjectAcl(req, res, url, address.bucket, address.key);
        }
        const uploadId = url.searchParams.get("uploadId"); const partNumber = url.searchParams.get("partNumber");
        if (req.method === "POST" && queryFlag(url, "uploads")) return await this.createMultipartUpload(req, res, address.bucket, address.key);
        if (req.method === "PUT" && uploadId && partNumber) return await this.uploadPart(req, res, address.bucket, address.key, uploadId, partNumber);
        if (req.method === "GET" && uploadId) return await this.listParts(req, res, url, address.bucket, address.key, uploadId);
        if (req.method === "POST" && uploadId) return await this.completeMultipartUpload(req, res, address.bucket, address.key, uploadId);
        if (req.method === "DELETE" && uploadId) return await this.abortMultipartUpload(res, address.bucket, address.key, uploadId);
        if (req.method === "GET" && queryFlag(url, "attributes")) return await this.getObjectAttributes(req, res, url, address.bucket, address.key);
        if (req.method === "GET" && queryFlag(url, "torrent")) return await this.getObjectTorrent(req, res, url, address.bucket, address.key);
        if (req.method === "PUT") return await this.putObject(req, res, url, address.bucket, address.key);
        if (req.method === "GET" || req.method === "HEAD") return await this.getObject(req, res, url, address.bucket, address.key, req.method === "HEAD");
        if (req.method === "DELETE") return await this.deleteObject(req, res, url, address.bucket, address.key);
      }
      throw new AwsError("MethodNotAllowed", "The specified method is not allowed against this resource.", 405);
    } catch (error) {
      if (error instanceof AwsError && error.code === "InvalidRange" && address.bucket && address.key) { const located = this.findBucket(address.bucket); if (located) { const index = await this.bucketIndex(located); const object = currentObject(index, address.key); if (object && !object.deleteMarker) res.setHeader("content-range", `bytes */${object.size}`); } }
      return sendS3Error(res, error, address.resource, requestId, hostId);
    }
  }

  private findBucket(name: string): LocatedBucket | undefined {
    const registered = this.store.state.installation.s3BucketNames[name]; if (registered) { const bucket = this.store.state.accounts[registered.accountId]?.regions[registered.region]?.s3Buckets[name]; if (bucket) return { ...registered, bucket }; }
    for (const [accountId, account] of Object.entries(this.store.state.accounts)) for (const [region, state] of Object.entries(account.regions)) if (state.s3Buckets[name]) return { accountId, region, bucket: state.s3Buckets[name] };
    return undefined;
  }

  private requireBucket(name: string): LocatedBucket {
    const located = this.findBucket(name); if (!located) throw new AwsError("NoSuchBucket", "The specified bucket does not exist", 404);
    if (located.accountId !== this.store.accountId) throw new AwsError("AccessDenied", "Access Denied", 403);
    if (located.region !== this.region) throw new AwsError("PermanentRedirect", "The bucket you are attempting to access must be addressed using the specified endpoint.", 301, { region: located.region });
    return located;
  }

  private cacheKey(located: LocatedBucket): string { return `${located.accountId}:${located.region}:${located.bucket.name}`; }

  private async bucketIndex(located: LocatedBucket): Promise<S3BucketIndex> {
    const key = this.cacheKey(located); let index = this.indexes.get(key); if (!index) { index = await this.storage.loadBucket(located.accountId, located.region, located.bucket.name); this.indexes.set(key, index); } return index;
  }

  private async saveBucket(located: LocatedBucket, index: S3BucketIndex): Promise<void> { await this.storage.saveBucket(located.accountId, located.region, located.bucket.name, index); }

  private async locked<T>(located: LocatedBucket, operation: () => Promise<T>): Promise<T> {
    const key = this.cacheKey(located); const previous = this.locks.get(key) ?? Promise.resolve(); const next = previous.catch(() => undefined).then(operation); this.locks.set(key, next); try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }

  private async namespaceLocked<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.namespaceLocks.get(name) ?? Promise.resolve(); const next = previous.catch(() => undefined).then(operation); this.namespaceLocks.set(name, next); try { return await next; } finally { if (this.namespaceLocks.get(name) === next) this.namespaceLocks.delete(name); }
  }

  private allOwnedBuckets(): LocatedBucket[] {
    const account = this.store.ensureAccount(); return Object.entries(account.regions).flatMap(([region, state]) => Object.values(state.s3Buckets).map(bucket => ({ accountId: this.store.accountId, region, bucket }))).sort((left, right) => utf8Compare(left.bucket.name, right.bucket.name));
  }

  private async createBucket(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const body = (await readBody(req)).toString("utf8"); await this.namespaceLocked(name, async () => { validateBucketName(name); const existing = this.findBucket(name); if (existing) throw existing.accountId === this.store.accountId ? new AwsError("BucketAlreadyOwnedByYou", "Your previous request to create the named bucket succeeded and you already own it.", 409) : new AwsError("BucketAlreadyExists", "The requested bucket name is not available.", 409);
      if (this.allOwnedBuckets().length >= this.maximumBuckets) throw new AwsError("TooManyBuckets", "You have attempted to create more buckets than allowed.", 400);
      const constraint = body ? xmlValue(body, "LocationConstraint") : undefined; if (this.region === "us-east-1" ? Boolean(constraint && constraint !== "us-east-1") : constraint !== this.region) throw new AwsError("IllegalLocationConstraintException", "The unspecified location constraint is incompatible for the region specific endpoint this request was sent to.", 400);
      const ownership = String(req.headers["x-amz-object-ownership"] ?? "BucketOwnerEnforced");
      if (!["BucketOwnerEnforced", "BucketOwnerPreferred", "ObjectWriter"].includes(ownership)) throw new AwsError("InvalidArgument", "Invalid x-amz-object-ownership value", 400);
      const requestedAcl = aclFromRequest("", req.headers, this.store.accountId, this.store.accountId, false);
      const explicitlyNonPrivateAcl = req.headers["x-amz-acl"] !== undefined && String(req.headers["x-amz-acl"]) !== "private"
        || ["x-amz-grant-full-control", "x-amz-grant-read", "x-amz-grant-write", "x-amz-grant-read-acp", "x-amz-grant-write-acp"].some(header => req.headers[header] !== undefined);
      if (ownership === "BucketOwnerEnforced" && explicitlyNonPrivateAcl) throw new AwsError("InvalidBucketAclWithObjectOwnership", "Bucket cannot have ACLs set with ObjectOwnership's BucketOwnerEnforced setting", 400);
      const accountBlock = this.store.ensureAccount().s3PublicAccessBlock;
      if (accountBlock?.blockPublicAcls && aclIsPublic(requestedAcl)) throw new AwsError("AccessDenied", "Account Block Public Access rejects public bucket ACLs", 403);
      const lockRequested = String(req.headers["x-amz-bucket-object-lock-enabled"] ?? "false").toLowerCase() === "true";
      const bucket: S3BucketState = { name, arn: bucketArn(name), region: this.region, ownerAccountId: this.store.accountId, ownerId: ownerId(this.store.accountId), createdAt: this.clock.now(), versioning: lockRequested ? "enabled" : "unversioned", encryption: "AES256", encryptionConfiguration: { algorithm: "AES256", bucketKeyEnabled: false }, ...(lockRequested ? { objectLockConfiguration: { enabled: true as const } } : {}), tags: {}, publicAccessBlock: canonicalPublicAccessBlock(), objectOwnership: ownership as S3BucketState["objectOwnership"], acl: requestedAcl, requestPayment: "BucketOwner", abacStatus: "Disabled" }; this.store.regionState(this.region).s3Buckets[name] = bucket; this.store.state.installation.s3BucketNames[name] = { accountId: this.store.accountId, region: this.region }; await Promise.all([this.store.save(), this.storage.saveBucket(this.store.accountId, this.region, name, { schemaVersion: 1, objects: {}, multipartUploads: {}, notificationDeliveries: {}, notificationDiagnostics: [] })]);
    });
    res.statusCode = 200; res.setHeader("location", `/${name}`); res.end();
  }

  private async deleteBucket(res: ServerResponse, name: string): Promise<void> {
    await this.deleteBucketInternal(name);
    res.statusCode = 204; res.end();
  }

  private async headBucket(res: ServerResponse, name: string): Promise<void> { const located = this.requireBucket(name); res.statusCode = 200; res.setHeader("x-amz-bucket-region", located.region); res.setHeader("x-amz-bucket-arn", located.bucket.arn); res.end(); }

  private async getBucketLocation(res: ServerResponse, name: string): Promise<void> { const located = this.requireBucket(name); res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(`<LocationConstraint xmlns="${S3_NAMESPACE}">${located.region === "us-east-1" ? "" : xmlEscape(located.region)}</LocationConstraint>`)); }

  private async getBucketEncryption(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name);
    const config = located.bucket.encryptionConfiguration ?? { algorithm: "AES256", bucketKeyEnabled: false };
    res.statusCode = 200;
    res.setHeader("content-type", "application/xml");
    res.end(restXml(`<Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>${config.algorithm}</SSEAlgorithm>${config.kmsKeyId ? `<KMSMasterKeyID>${xmlEscape(config.kmsKeyId)}</KMSMasterKeyID>` : ""}</ApplyServerSideEncryptionByDefault><BucketKeyEnabled>${config.bucketKeyEnabled}</BucketKeyEnabled></Rule>`, "ServerSideEncryptionConfiguration"));
  }

  private async putBucketEncryption(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const xml = (await readBody(req)).toString("utf8");
    const rules = [...xml.matchAll(/<Rule(?:\s[^>]*)?>([\s\S]*?)<\/Rule>/gi)];
    if (rules.length !== 1) throw new AwsError("MalformedXML", "Exactly one server-side encryption rule is required", 400);
    const algorithm = xmlValue(rules[0][1], "SSEAlgorithm");
    if (!algorithm || !["AES256", "aws:kms", "aws:kms:dsse"].includes(algorithm)) throw new AwsError("InvalidEncryptionAlgorithmError", "The encryption algorithm is invalid", 400);
    const kmsKeyId = validateKmsKeyId(xmlValue(rules[0][1], "KMSMasterKeyID"));
    if (algorithm === "AES256" && kmsKeyId) throw new AwsError("InvalidArgument", "KMSMasterKeyID is valid only for KMS encryption", 400);
    const bucketKeyText = xmlValue(rules[0][1], "BucketKeyEnabled");
    const bucketKeyEnabled = bucketKeyText === undefined ? false : bucketKeyText.toLowerCase() === "true";
    if (bucketKeyText !== undefined && !["true", "false"].includes(bucketKeyText.toLowerCase())) throw new AwsError("MalformedXML", "BucketKeyEnabled must be true or false", 400);
    if (algorithm === "aws:kms:dsse" && bucketKeyEnabled) throw new AwsError("InvalidArgument", "S3 Bucket Keys are not supported with DSSE-KMS", 400);
    located.bucket.encryptionConfiguration = { algorithm: algorithm as any, ...(kmsKeyId ? { kmsKeyId } : {}), bucketKeyEnabled };
    await this.store.save(); res.statusCode = 200; res.end();
  }

  private async deleteBucketEncryption(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name);
    located.bucket.encryptionConfiguration = { algorithm: "AES256", bucketKeyEnabled: false };
    await this.store.save(); res.statusCode = 204; res.end();
  }

  private async getBucketTagging(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name);
    const tags = validateTags(located.bucket.tags);
    if (!Object.keys(tags).length) throw new AwsError("NoSuchTagSet", "The TagSet does not exist", 404);
    const rows = Object.entries(tags).map(([key, value]) => `<Tag><Key>${xmlEscape(key)}</Key><Value>${xmlEscape(value)}</Value></Tag>`).join("");
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(`<TagSet>${rows}</TagSet>`, "Tagging"));
  }

  private async putBucketTagging(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name);
    const body = await readBody(req);
    if (body.length > 256 * 1024) throw new AwsError("MalformedXML", "The XML document exceeds the maximum allowed size", 400);
    const xml = body.toString("utf8");
    if (!/<Tagging(?:\s|>)/i.test(xml) || !/<TagSet(?:\s|>)/i.test(xml)) throw new AwsError("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema", 400);
    located.bucket.tags = parseTaggingXml(xml, 50);
    await this.store.save(); res.statusCode = 200; res.end();
  }

  private async deleteBucketTagging(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); located.bucket.tags = {}; await this.store.save(); res.statusCode = 204; res.end();
  }

  private selectedVersion(index: S3BucketIndex, key: string, url: URL): S3ObjectVersionState {
    return selectObject(index, key, url.searchParams.get("versionId")).version;
  }

  private async getObjectTagging(res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const located = this.requireBucket(bucketName); const object = this.selectedVersion(await this.bucketIndex(located), key, url);
    if (object.versionId !== "null") res.setHeader("x-amz-version-id", object.versionId);
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(taggingXml(object.tags ?? {}));
  }

  private async putObjectTagging(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const body = await readBody(req); if (body.length > 256 * 1024) throw new AwsError("MalformedXML", "The XML document exceeds the maximum allowed size", 400);
    const tags = validateObjectTags(parseTaggingXml(body.toString("utf8"), 10)); const located = this.requireBucket(bucketName);
    await this.locked(located, async () => {
      const index = await this.bucketIndex(located); const object = this.selectedVersion(index, key, url); object.tags = tags;
      await this.saveBucket(located, index); if (object.versionId !== "null") res.setHeader("x-amz-version-id", object.versionId);
      await this.enqueueObjectEvent(located, index, key, object, "s3:ObjectTagging:Put", {}, this.notificationCaller(req));
    });
    res.statusCode = 200; res.end();
  }

  private async deleteObjectTagging(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const located = this.requireBucket(bucketName);
    await this.locked(located, async () => {
      const index = await this.bucketIndex(located); const object = this.selectedVersion(index, key, url); object.tags = {};
      await this.saveBucket(located, index); if (object.versionId !== "null") res.setHeader("x-amz-version-id", object.versionId);
      await this.enqueueObjectEvent(located, index, key, object, "s3:ObjectTagging:Delete", {}, this.notificationCaller(req));
    });
    res.statusCode = 204; res.end();
  }

  private async updateObjectEncryption(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const body = await readBody(req); if (!body.length || body.length > 64 * 1024) throw new AwsError("MalformedXML", "ObjectEncryption must be a non-empty XML document no larger than 64 KiB", 400);
    const checksums = new S3Checksums(); await checksums.update(body); validateProvidedChecksums(req.headers, {}, await checksums.digest());
    const xml = body.toString("utf8"); const sseS3 = /<(?:SSE-S3|SSES3)(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/(?:SSE-S3|SSES3)>)/i.test(xml); const sseKms = /<(?:SSE-KMS|SSEKMS)(?:\s|>)/i.test(xml);
    if (!/<ObjectEncryption(?:\s|>)/i.test(xml) || sseS3 === sseKms) throw new AwsError("MalformedXML", "ObjectEncryption requires exactly one SSE-S3 or SSE-KMS member", 400);
    if (sseKms) {
      const kmsKeyArn = xmlValue(xml, "KMSKeyArn");
      if (!kmsKeyArn || !/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9/_+=,.@:-]+$/i.test(kmsKeyArn)) throw new AwsError("InvalidArgument", "SSE-KMS object updates require a full KMS key ARN", 400);
      throw new AwsError("KMS.NotFoundException", `KMS key ${kmsKeyArn} is unavailable because the KMS service is not implemented`, 400);
    }
    const located = this.requireBucket(bucketName);
    await this.locked(located, async () => {
      const index = await this.bucketIndex(located); const object = this.selectedVersion(index, key, url);
      object.encryption = "AES256"; delete object.kmsKeyId; delete object.bucketKeyEnabled; delete object.sseCustomerKeyMd5;
      await this.saveBucket(located, index);
    });
    res.statusCode = 200; res.end();
  }

  private activeLock(object: S3ObjectVersionState): boolean {
    return object.legalHold === "ON" || Boolean(object.retention && object.retention.retainUntil > this.clock.now());
  }

  private enforceDeletionLock(req: IncomingMessage, object: S3ObjectVersionState): void {
    if (object.deleteMarker) return;
    if (object.legalHold === "ON") throw new AwsError("AccessDenied", "The object version is protected by a legal hold", 403);
    if (!object.retention || object.retention.retainUntil <= this.clock.now()) return;
    const bypass = String(req.headers["x-amz-bypass-governance-retention"] ?? "").toLowerCase() === "true";
    if (object.retention.mode === "COMPLIANCE" || !bypass) throw new AwsError("AccessDenied", object.retention.mode === "COMPLIANCE" ? "The object version is protected by COMPLIANCE retention" : "BypassGovernanceRetention is required", 403);
  }

  private async getObjectLockConfiguration(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const value = located.bucket.objectLockConfiguration;
    if (!value) throw new AwsError("ObjectLockConfigurationNotFoundError", "Object Lock configuration does not exist for this bucket", 404);
    const retention = value.defaultRetention;
    const rule = retention ? `<Rule><DefaultRetention><Mode>${retention.mode}</Mode>${retention.days !== undefined ? `<Days>${retention.days}</Days>` : `<Years>${retention.years}</Years>`}</DefaultRetention></Rule>` : "";
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(`<ObjectLockEnabled>Enabled</ObjectLockEnabled>${rule}`, "ObjectLockConfiguration"));
  }

  private async putObjectLockConfiguration(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const xml = (await readBody(req)).toString("utf8");
    if (xmlValue(xml, "ObjectLockEnabled") !== "Enabled") throw new AwsError("InvalidRequest", "ObjectLockEnabled must be Enabled and cannot subsequently be disabled", 400);
    if (located.bucket.versioning !== "enabled") throw new AwsError("InvalidBucketState", "Versioning must be Enabled to configure Object Lock", 409);
    const mode = xmlValue(xml, "Mode"); const daysText = xmlValue(xml, "Days"); const yearsText = xmlValue(xml, "Years");
    if (mode !== undefined && !["GOVERNANCE", "COMPLIANCE"].includes(mode) || daysText !== undefined && yearsText !== undefined) throw new AwsError("MalformedXML", "Default retention requires a valid mode and exactly one of Days or Years", 400);
    let defaultRetention: NonNullable<S3BucketState["objectLockConfiguration"]>["defaultRetention"];
    if (mode !== undefined || daysText !== undefined || yearsText !== undefined) {
      const value = Number(daysText ?? yearsText); if (!mode || !Number.isInteger(value) || value < 1) throw new AwsError("MalformedXML", "Default retention duration must be a positive integer", 400);
      defaultRetention = { mode: mode as any, ...(daysText !== undefined ? { days: value } : { years: value }) };
    }
    located.bucket.objectLockConfiguration = { enabled: true, ...(defaultRetention ? { defaultRetention } : {}) };
    await this.store.save(); res.statusCode = 200; res.end();
  }

  private async getObjectRetention(res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const located = this.requireBucket(bucketName); const object = this.selectedVersion(await this.bucketIndex(located), key, url);
    if (!object.retention) throw new AwsError("NoSuchObjectLockConfiguration", "The object does not have a retention configuration", 404);
    if (object.versionId !== "null") res.setHeader("x-amz-version-id", object.versionId);
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(`<Mode>${object.retention.mode}</Mode><RetainUntilDate>${iso(object.retention.retainUntil)}</RetainUntilDate>`, "Retention"));
  }

  private async putObjectRetention(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const located = this.requireBucket(bucketName); if (!located.bucket.objectLockConfiguration) throw new AwsError("InvalidRequest", "Bucket is missing Object Lock configuration", 400);
    const xml = (await readBody(req)).toString("utf8"); const mode = xmlValue(xml, "Mode"); const date = Date.parse(xmlValue(xml, "RetainUntilDate") ?? "");
    if (!["GOVERNANCE", "COMPLIANCE"].includes(mode ?? "") || !Number.isFinite(date) || date <= this.clock.now()) throw new AwsError("InvalidRequest", "Retention requires a future RetainUntilDate and valid Mode", 400);
    await this.locked(located, async () => {
      const index = await this.bucketIndex(located); const object = this.selectedVersion(index, key, url); const prior = object.retention;
      const bypass = String(req.headers["x-amz-bypass-governance-retention"] ?? "").toLowerCase() === "true";
      if (prior?.mode === "COMPLIANCE" && (mode !== "COMPLIANCE" || date < prior.retainUntil)) throw new AwsError("AccessDenied", "COMPLIANCE retention cannot be shortened or changed", 403);
      if (prior?.mode === "GOVERNANCE" && date < prior.retainUntil && !bypass) throw new AwsError("AccessDenied", "BypassGovernanceRetention is required to shorten GOVERNANCE retention", 403);
      object.retention = { mode: mode as any, retainUntil: date }; await this.saveBucket(located, index);
      if (object.versionId !== "null") res.setHeader("x-amz-version-id", object.versionId);
    });
    res.statusCode = 200; res.end();
  }

  private async getObjectLegalHold(res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const located = this.requireBucket(bucketName); const object = this.selectedVersion(await this.bucketIndex(located), key, url);
    if (!located.bucket.objectLockConfiguration) throw new AwsError("InvalidRequest", "Bucket is missing Object Lock configuration", 400);
    if (object.versionId !== "null") res.setHeader("x-amz-version-id", object.versionId);
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(`<Status>${object.legalHold ?? "OFF"}</Status>`, "LegalHold"));
  }

  private async putObjectLegalHold(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const located = this.requireBucket(bucketName); if (!located.bucket.objectLockConfiguration) throw new AwsError("InvalidRequest", "Bucket is missing Object Lock configuration", 400);
    const status = xmlValue((await readBody(req)).toString("utf8"), "Status"); if (!["ON", "OFF"].includes(status ?? "")) throw new AwsError("MalformedXML", "Legal hold Status must be ON or OFF", 400);
    await this.locked(located, async () => { const index = await this.bucketIndex(located); const object = this.selectedVersion(index, key, url); object.legalHold = status as any; await this.saveBucket(located, index); if (object.versionId !== "null") res.setHeader("x-amz-version-id", object.versionId); });
    res.statusCode = 200; res.end();
  }

  private annotationName(url: URL): string {
    const name = url.searchParams.get("annotationName");
    if (name !== null && Buffer.byteLength(name) > 512) throw new AwsError("AnnotationNameTooLong", "The annotation name exceeds 512 bytes", 400);
    if (!name || /^(?:aws|s3):/i.test(name) || /[\u0000-\u001f\u007f]/.test(name)) throw new AwsError("InvalidAnnotationName", "The annotation name is invalid", 400);
    return name;
  }

  private async putObjectAnnotation(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const name = this.annotationName(url); const body = await readBody(req);
    if (!body.length || body.length > 1024 * 1024) throw new AwsError("InvalidRequest", "Annotation payload must contain between 1 byte and 1 MiB", 400);
    try { new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { throw new AwsError("UnsupportedMediaType", "Annotation payload must be valid UTF-8", 415); }
    const checksums = new S3Checksums(); await checksums.update(body); const digest = await checksums.digest(); validateProvidedChecksums(req.headers, {}, digest);
    const algorithm = requestedChecksumAlgorithm(req.headers["x-amz-checksum-algorithm"] ?? req.headers["x-amz-sdk-checksum-algorithm"]) ?? "CRC64NVME";
    const located = this.requireBucket(bucketName);
    await this.locked(located, async () => {
      const index = await this.bucketIndex(located); const object = this.selectedVersion(index, key, url);
      if (this.activeLock(object)) throw new AwsError("AccessDenied", "Annotations cannot be modified while the object version is retained or under legal hold", 403);
      const ifMatch = req.headers["x-amz-object-if-match"]; if (ifMatch && cleanEtag(String(ifMatch)) !== object.etag) throw new AwsError("PreconditionFailed", "The object ETag did not match", 412);
      object.annotations ??= {}; if (!Object.hasOwn(object.annotations, name) && Object.keys(object.annotations).length >= 100) throw new AwsError("AnnotationLimitExceeded", "The request would exceed the maximum number of annotations allowed per object", 400);
      object.annotations[name] = { payloadBase64: body.toString("base64"), size: body.length, etag: digest.etag, lastModified: this.clock.now(), checksums: digest.values, checksumAlgorithm: algorithm };
      await this.saveBucket(located, index); await this.enqueueObjectEvent(located, index, key, object, "s3:ObjectAnnotation:Put", { annotationName: name }, this.notificationCaller(req));
      res.setHeader("etag", quotedEtag(digest.etag)); res.setHeader(checksumHeaderName(algorithm), digest.values[algorithm]!); res.setHeader("x-amz-server-side-encryption", "AES256"); if (object.versionId !== "null") res.setHeader("x-amz-object-version-id", object.versionId);
    });
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(`<Key>${xmlEscape(key)}</Key><AnnotationName>${xmlEscape(name)}</AnnotationName>`, "PutObjectAnnotationResult"));
  }

  private async getObjectAnnotation(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const name = this.annotationName(url); const located = this.requireBucket(bucketName); const object = this.selectedVersion(await this.bucketIndex(located), key, url); const annotation = object.annotations?.[name];
    if (!annotation) throw new AwsError("NoSuchAnnotation", "The specified annotation does not exist", 404);
    const body = Buffer.from(annotation.payloadBase64, "base64"); res.statusCode = 200; res.setHeader("content-length", String(body.length)); res.setHeader("last-modified", httpDate(annotation.lastModified)); res.setHeader("etag", quotedEtag(annotation.etag)); res.setHeader(checksumHeaderName(annotation.checksumAlgorithm), annotation.checksums[annotation.checksumAlgorithm]!); res.setHeader("x-amz-checksum-type", "FULL_OBJECT"); res.setHeader("x-amz-server-side-encryption", "AES256"); if (object.versionId !== "null") res.setHeader("x-amz-object-version-id", object.versionId); res.end(body);
  }

  private async listObjectAnnotations(res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const located = this.requireBucket(bucketName); const object = this.selectedVersion(await this.bucketIndex(located), key, url); const prefix = url.searchParams.get("annotation-prefix") ?? ""; const maximum = Number(url.searchParams.get("max-annotation-results") ?? 1000);
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1000) throw new AwsError("InvalidArgument", "MaxAnnotationResults must be between 1 and 1000", 400);
    const all = Object.entries(object.annotations ?? {}).filter(([name]) => name.startsWith(prefix)).sort(([a], [b]) => utf8Compare(a, b)); let offset = 0; const token = url.searchParams.get("continuation-token");
    if (token) { try { const cursor = this.pagination.decode<{ bucket: string; key: string; versionId: string; prefix: string; offset: number }>("s3:ListObjectAnnotations", token); if (cursor.bucket !== bucketName || cursor.key !== key || cursor.versionId !== object.versionId || cursor.prefix !== prefix) throw new Error(); offset = cursor.offset; } catch { throw new AwsError("InvalidArgument", "The continuation token is invalid", 400); } }
    const page = all.slice(offset, offset + maximum); const next = offset + page.length < all.length ? this.pagination.encode("s3:ListObjectAnnotations", { bucket: bucketName, key, versionId: object.versionId, prefix, offset: offset + page.length }) : undefined;
    const rows = page.map(([name, value]) => `<AnnotationEntry><AnnotationName>${xmlEscape(name)}</AnnotationName><LastModified>${iso(value.lastModified)}</LastModified><ETag>${xmlEscape(quotedEtag(value.etag))}</ETag><ChecksumAlgorithm>${value.checksumAlgorithm}</ChecksumAlgorithm><Size>${value.size}</Size></AnnotationEntry>`).join("");
    if (object.versionId !== "null") res.setHeader("x-amz-object-version-id", object.versionId); res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(`<Annotations>${rows}</Annotations><Bucket>${xmlEscape(bucketName)}</Bucket><Key>${xmlEscape(key)}</Key><ObjectVersionId>${xmlEscape(object.versionId)}</ObjectVersionId><AnnotationPrefix>${xmlEscape(prefix)}</AnnotationPrefix><MaxAnnotationResults>${maximum}</MaxAnnotationResults><AnnotationCount>${page.length}</AnnotationCount>${token ? `<ContinuationToken>${xmlEscape(token)}</ContinuationToken>` : ""}${next ? `<NextContinuationToken>${xmlEscape(next)}</NextContinuationToken>` : ""}`, "ListObjectAnnotationsResult"));
  }

  private async deleteObjectAnnotation(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const name = this.annotationName(url); const located = this.requireBucket(bucketName);
    await this.locked(located, async () => { const index = await this.bucketIndex(located); const object = this.selectedVersion(index, key, url); if (this.activeLock(object)) throw new AwsError("AccessDenied", "Annotations cannot be modified while the object version is retained or under legal hold", 403); if (!object.annotations?.[name]) throw new AwsError("NoSuchAnnotation", "The specified annotation does not exist", 404); delete object.annotations[name]; await this.saveBucket(located, index); await this.enqueueObjectEvent(located, index, key, object, "s3:ObjectAnnotation:Delete", { annotationName: name }, this.notificationCaller(req)); if (object.versionId !== "null") res.setHeader("x-amz-object-version-id", object.versionId); });
    res.statusCode = 204; res.end();
  }

  private parseLifecycle(xml: string): NonNullable<S3BucketState["lifecycleConfiguration"]> {
    if (!/<LifecycleConfiguration(?:\s|>)/i.test(xml)) throw new AwsError("MalformedXML", "LifecycleConfiguration is required", 400);
    const blocks = [...xml.matchAll(/<Rule(?:\s[^>]*)?>([\s\S]*?)<\/Rule>/gi)].map(match => match[1]);
    if (!blocks.length || blocks.length > 1_000) throw new AwsError("MalformedXML", "Lifecycle configuration must contain between 1 and 1000 rules", 400);
    const ids = new Set<string>();
    const positive = (value: string | undefined, field: string, allowZero = false): number | undefined => { if (value === undefined) return undefined; const number = Number(value); if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) throw new AwsError("InvalidArgument", `${field} must be a ${allowZero ? "non-negative" : "positive"} integer`, 400); return number; };
    const newerNoncurrent = (value: string | undefined): number | undefined => {
      if (value === undefined) return undefined;
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1 || number > 100) throw new AwsError("InvalidArgument", "NewerNoncurrentVersions must be an integer from 1 through 100", 400);
      return number;
    };
    const storage = (value: string | undefined): string => {
      if (!value) throw new AwsError("MalformedXML", "A lifecycle transition requires StorageClass", 400);
      const storageClass = validateStorageClass(value);
      if (!S3_LIFECYCLE_TRANSITION_CLASSES.has(storageClass)) throw new AwsError("InvalidArgument", `${storageClass} is not a legal lifecycle transition destination`, 400);
      return storageClass;
    };
    const minimumStorageDays: Record<string, number> = { STANDARD_IA: 30, ONEZONE_IA: 30, GLACIER_IR: 90, GLACIER: 90, DEEP_ARCHIVE: 180 };
    const validateTransitionSpacing = (transitions: Array<{ days?: number; date?: number; storageClass: string }>, label: string): void => {
      const dated = transitions.filter(item => item.days !== undefined || item.date !== undefined);
      if (dated.length < 2) return;
      const ordered = [...dated].sort((left, right) => (left.days ?? left.date ?? 0) - (right.days ?? right.date ?? 0));
      for (let index = 0; index < ordered.length - 1; index++) {
        const current = ordered[index]; const next = ordered[index + 1];
        const minimum = minimumStorageDays[current.storageClass] ?? 0;
        if (!minimum) continue;
        if (current.days !== undefined && next.days !== undefined) {
          if (next.days < current.days + minimum) throw new AwsError("InvalidArgument", `${label} to ${next.storageClass} must respect the ${minimum}-day minimum storage duration of ${current.storageClass}`, 400);
        } else if (current.date !== undefined && next.date !== undefined) {
          if (next.date < current.date + minimum * 86_400_000) throw new AwsError("InvalidArgument", `${label} to ${next.storageClass} must respect the ${minimum}-day minimum storage duration of ${current.storageClass}`, 400);
        }
      }
    };
    const rules = blocks.map(body => {
      const id = xmlValue(body, "ID"); if (id !== undefined && (!id || Buffer.byteLength(id) > 255 || ids.has(id))) throw new AwsError("InvalidArgument", "Lifecycle rule IDs must be unique and at most 255 bytes", 400); if (id) ids.add(id);
      const status = xmlValue(body, "Status"); if (!["Enabled", "Disabled"].includes(status ?? "")) throw new AwsError("MalformedXML", "Lifecycle rule Status must be Enabled or Disabled", 400);
      const filterMatch = body.match(/<Filter(?:\s[^>]*)?>([\s\S]*?)<\/Filter>/i); const filterBody = filterMatch?.[1]; const hasExplicitFilter = Boolean(filterMatch);
      const prefix = xmlValue(filterBody ?? body, "Prefix") ?? "";
      const tags: Record<string, string> = {};
      for (const match of (filterBody ?? "").matchAll(/<Tag(?:\s[^>]*)?>([\s\S]*?)<\/Tag>/gi)) { const key = xmlValue(match[1], "Key"); const value = xmlValue(match[1], "Value"); if (!key || value === undefined || Object.hasOwn(tags, key)) throw new AwsError("InvalidArgument", "Lifecycle tag filters must have unique keys", 400); tags[key] = value; }
      const greater = positive(xmlValue(filterBody ?? "", "ObjectSizeGreaterThan"), "ObjectSizeGreaterThan", true); const less = positive(xmlValue(filterBody ?? "", "ObjectSizeLessThan"), "ObjectSizeLessThan", true);
      if (greater !== undefined && less !== undefined && greater >= less) throw new AwsError("InvalidArgument", "ObjectSizeGreaterThan must be less than ObjectSizeLessThan", 400);
      const expirationBody = body.match(/<Expiration(?:\s[^>]*)?>([\s\S]*?)<\/Expiration>/i)?.[1]; const expirationDays = positive(xmlValue(expirationBody ?? "", "Days"), "Expiration Days"); const dateText = xmlValue(expirationBody ?? "", "Date"); const expirationDate = dateText === undefined ? undefined : Date.parse(dateText); if (dateText !== undefined && !Number.isFinite(expirationDate)) throw new AwsError("InvalidArgument", "Lifecycle expiration Date is invalid", 400);
      const markerText = xmlValue(expirationBody ?? "", "ExpiredObjectDeleteMarker"); const expiredObjectDeleteMarker = markerText === undefined ? undefined : markerText.toLowerCase() === "true"; if (markerText !== undefined && !["true", "false"].includes(markerText.toLowerCase())) throw new AwsError("MalformedXML", "ExpiredObjectDeleteMarker must be a boolean", 400);
      const transitions = [...body.matchAll(/<Transition(?:\s[^>]*)?>([\s\S]*?)<\/Transition>/gi)].map(match => { const days = positive(xmlValue(match[1], "Days"), "Transition Days", true); const date = xmlValue(match[1], "Date"); const parsed = date === undefined ? undefined : Date.parse(date); if ((days === undefined) === (parsed === undefined) || parsed !== undefined && !Number.isFinite(parsed)) throw new AwsError("InvalidArgument", "A transition requires exactly one valid Days or Date value", 400); return { ...(days !== undefined ? { days } : { date: parsed }), storageClass: storage(xmlValue(match[1], "StorageClass")) }; });
      validateTransitionSpacing(transitions, "Transition");
      const noncurrentExpiration = body.match(/<NoncurrentVersionExpiration(?:\s[^>]*)?>([\s\S]*?)<\/NoncurrentVersionExpiration>/i)?.[1];
      const noncurrentExpirationNewer = newerNoncurrent(xmlValue(noncurrentExpiration ?? "", "NewerNoncurrentVersions"));
      const noncurrentTransitions = [...body.matchAll(/<NoncurrentVersionTransition(?:\s[^>]*)?>([\s\S]*?)<\/NoncurrentVersionTransition>/gi)].map(match => {
        const newer = newerNoncurrent(xmlValue(match[1], "NewerNoncurrentVersions"));
        return { days: positive(xmlValue(match[1], "NoncurrentDays"), "NoncurrentDays")!, storageClass: storage(xmlValue(match[1], "StorageClass")), ...(newer !== undefined ? { newerNoncurrentVersions: newer } : {}) };
      });
      validateTransitionSpacing(noncurrentTransitions.map(item => ({ days: item.days, storageClass: item.storageClass })), "NoncurrentVersionTransition");
      if ((noncurrentExpirationNewer !== undefined || noncurrentTransitions.some(item => item.newerNoncurrentVersions !== undefined)) && !hasExplicitFilter) {
        throw new AwsError("InvalidRequest", "A Filter must be specified when NewerNoncurrentVersions is present", 400);
      }
      const abortBody = body.match(/<AbortIncompleteMultipartUpload(?:\s[^>]*)?>([\s\S]*?)<\/AbortIncompleteMultipartUpload>/i)?.[1];
      if (!expirationBody && !transitions.length && !noncurrentExpiration && !noncurrentTransitions.length && !abortBody) throw new AwsError("MalformedXML", "A lifecycle rule must contain at least one action", 400);
      return {
        ...(id ? { id } : {}), status: status as "Enabled" | "Disabled", prefix, tags: validateObjectTags(tags),
        ...(greater !== undefined ? { objectSizeGreaterThan: greater } : {}), ...(less !== undefined ? { objectSizeLessThan: less } : {}),
        ...(expirationDays !== undefined ? { expirationDays } : {}), ...(expirationDate !== undefined ? { expirationDate } : {}),
        ...(expiredObjectDeleteMarker !== undefined ? { expiredObjectDeleteMarker } : {}), transitions,
        ...(noncurrentExpiration ? { noncurrentExpirationDays: positive(xmlValue(noncurrentExpiration, "NoncurrentDays"), "NoncurrentDays"), ...(noncurrentExpirationNewer !== undefined ? { newerNoncurrentVersions: noncurrentExpirationNewer } : {}) } : {}),
        noncurrentTransitions,
        ...(abortBody ? { abortIncompleteMultipartUploadDays: positive(xmlValue(abortBody, "DaysAfterInitiation"), "DaysAfterInitiation") } : {}),
      };
    });
    return { xml, rules };
  }

  private async getBucketLifecycle(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); if (!located.bucket.lifecycleConfiguration) throw new AwsError("NoSuchLifecycleConfiguration", "The lifecycle configuration does not exist", 404);
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(located.bucket.lifecycleConfiguration.xml);
  }

  private async putBucketLifecycle(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const body = await readBody(req); if (body.length > 1024 * 1024) throw new AwsError("MalformedXML", "The lifecycle document is too large", 400);
    located.bucket.lifecycleConfiguration = this.parseLifecycle(body.toString("utf8")); await this.store.save(); await this.runLifecycleBucket(located); res.statusCode = 200; res.end();
  }

  private async deleteBucketLifecycle(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); delete located.bucket.lifecycleConfiguration; await this.store.save(); res.statusCode = 204; res.end();
  }

  private lifecycleMatches(rule: NonNullable<S3BucketState["lifecycleConfiguration"]>["rules"][number], key: string, object: S3ObjectVersionState): boolean {
    return key.startsWith(rule.prefix) && Object.entries(rule.tags).every(([name, value]) => object.tags?.[name] === value) && (rule.objectSizeGreaterThan === undefined || object.size > rule.objectSizeGreaterThan) && (rule.objectSizeLessThan === undefined || object.size < rule.objectSizeLessThan);
  }

  async runLifecycleNow(): Promise<void> {
    for (const located of this.allOwnedBuckets()) await this.runLifecycleBucket(located);
  }

  private async runLifecycleBucket(located: LocatedBucket): Promise<void> {
    await this.locked(located, async () => {
      const index = await this.bucketIndex(located); const now = this.clock.now(); let changed = false; const events: Array<{ key: string; object?: S3ObjectVersionState; name: string; extra?: Record<string, unknown> }> = [];
      for (const [key, versions] of Object.entries(index.objects)) for (const object of versions) {
        if (!object.restore) continue;
        if (object.restore.expiryAt <= now) { const restore = structuredClone(object.restore); delete object.restore; changed = true; events.push({ key, object, name: "s3:ObjectRestore:Delete", extra: { restore } }); }
        else if (object.restore.completesAt <= now) { object.restore.completesAt = 0; if (!object.restore.completionEventSent) { object.restore.completionEventSent = true; changed = true; events.push({ key, object, name: "s3:ObjectRestore:Completed" }); } }
      }
      for (const rule of located.bucket.lifecycleConfiguration?.rules ?? []) {
        if (rule.status !== "Enabled") continue;
        for (const upload of Object.values(index.multipartUploads)) {
          const size = Object.values(upload.parts).reduce((sum, part) => sum + part.size, 0);
          const candidate: S3ObjectVersionState = { versionId: "multipart", size, etag: "", lastModified: upload.initiatedAt, metadata: upload.metadata, tags: upload.tags, checksums: {}, storageClass: upload.storageClass, encryption: upload.encryption ?? "AES256" };
          if (rule.abortIncompleteMultipartUploadDays !== undefined && this.lifecycleMatches(rule, upload.key, candidate) && now >= upload.initiatedAt + rule.abortIncompleteMultipartUploadDays * 86_400_000) { delete index.multipartUploads[upload.uploadId]; changed = true; }
        }
        for (const [key, versions] of Object.entries(index.objects)) {
          const current = versions[0]; if (!current || !this.lifecycleMatches(rule, key, current)) continue;
          if (current.deleteMarker && rule.expiredObjectDeleteMarker && versions.length === 1) { versions.shift(); delete index.objects[key]; changed = true; events.push({ key, object: current, name: "s3:LifecycleExpiration:DeleteMarkerDeleted" }); continue; }
          if (!current.deleteMarker) {
            for (const transition of rule.transitions) {
              const due = transition.days !== undefined ? current.lastModified + transition.days * 86_400_000 : transition.date!;
              if (now >= due && current.storageClass !== transition.storageClass) { const from = current.storageClass; current.storageClass = transition.storageClass; (current.transitionHistory ??= []).push({ at: now, from, to: transition.storageClass, ruleId: rule.id }); changed = true; events.push({ key, object: current, name: "s3:LifecycleTransition", extra: { storageClass: transition.storageClass } }); }
            }
            const expirationDue = rule.expirationDays !== undefined ? current.lastModified + rule.expirationDays * 86_400_000 : rule.expirationDate;
            if (expirationDue !== undefined && now >= expirationDue && !this.activeLock(current)) {
              if (located.bucket.versioning === "enabled") { current.noncurrentSince ??= now; const marker: S3ObjectVersionState = { versionId: randomUUID(), deleteMarker: true, size: 0, etag: "", lastModified: now, metadata: {}, checksums: {}, storageClass: "STANDARD", encryption: "AES256" }; versions.unshift(marker); events.push({ key, object: marker, name: "s3:LifecycleExpiration:DeleteMarkerCreated" }); }
              else { versions.shift(); if (!versions.length) delete index.objects[key]; events.push({ key, object: current, name: "s3:LifecycleExpiration:Delete" }); }
              changed = true; continue;
            }
          }
          for (let position = versions.length - 1; position >= 1; position--) {
            const version = versions[position]; if (version.deleteMarker || !this.lifecycleMatches(rule, key, version)) continue;
            const noncurrentSince = version.noncurrentSince ?? version.lastModified;
            const newerCount = position - 1;
            for (const transition of rule.noncurrentTransitions) {
              if (transition.newerNoncurrentVersions !== undefined && newerCount < transition.newerNoncurrentVersions) continue;
              if (now >= noncurrentSince + transition.days * 86_400_000 && version.storageClass !== transition.storageClass) { const from = version.storageClass; version.storageClass = transition.storageClass; (version.transitionHistory ??= []).push({ at: now, from, to: transition.storageClass, ruleId: rule.id }); changed = true; events.push({ key, object: version, name: "s3:LifecycleTransition", extra: { storageClass: transition.storageClass } }); }
            }
            if (rule.noncurrentExpirationDays !== undefined && (rule.newerNoncurrentVersions === undefined || newerCount >= rule.newerNoncurrentVersions) && now >= noncurrentSince + rule.noncurrentExpirationDays * 86_400_000 && !this.activeLock(version)) { versions.splice(position, 1); changed = true; events.push({ key, object: version, name: "s3:LifecycleExpiration:Delete" }); }
          }
        }
      }
      if (changed) await this.saveBucket(located, index);
      for (const event of events) await this.enqueueObjectEvent(located, index, event.key, event.object, event.name, event.extra);
    });
  }

  private refreshRestore(object: S3ObjectVersionState): void {
    if (!object.restore) return;
    if (object.restore.expiryAt <= this.clock.now()) delete object.restore;
    else if (object.restore.completesAt <= this.clock.now()) object.restore.completesAt = 0;
  }

  private ensureArchiveReadable(object: S3ObjectVersionState): void {
    if (!S3_ARCHIVE_CLASSES.has(object.storageClass)) return;
    if (!object.restore || object.restore.completesAt > 0 || object.restore.expiryAt <= this.clock.now()) throw new AwsError("InvalidObjectState", "The operation is not valid for the object's storage class", 403);
  }

  private async restoreObject(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const located = this.requireBucket(bucketName); const xml = (await readBody(req)).toString("utf8"); const days = Number(xmlValue(xml, "Days")); const tier = xmlValue(xml, "Tier") ?? "Standard";
    if (!Number.isInteger(days) || days < 1 || !["Expedited", "Standard", "Bulk"].includes(tier)) throw new AwsError("MalformedXML", "Restore request requires positive Days and a valid Tier", 400);
    let statusCode = 202;
    await this.locked(located, async () => {
      const index = await this.bucketIndex(located); const object = this.selectedVersion(index, key, url); if (!S3_ARCHIVE_CLASSES.has(object.storageClass)) throw new AwsError("InvalidObjectState", "RestoreObject is valid only for archived storage classes", 403); this.refreshRestore(object);
      if (object.restore?.completesAt && object.restore.completesAt > this.clock.now()) throw new AwsError("RestoreAlreadyInProgress", "Object restore is already in progress", 409);
      if (object.restore && object.restore.completesAt === 0 && object.restore.expiryAt > this.clock.now()) { object.restore.expiryAt = this.clock.now() + days * 86_400_000; await this.saveBucket(located, index); statusCode = 200; return; }
      const delay = tier === "Expedited" ? 100 : tier === "Standard" ? 1_000 : 5_000; const completesAt = this.clock.now() + delay; object.restore = { requestedAt: this.clock.now(), completesAt, expiryAt: completesAt + days * 86_400_000, tier: tier as any }; await this.saveBucket(located, index); await this.enqueueObjectEvent(located, index, key, object, "s3:ObjectRestore:Post", {}, this.notificationCaller(req)); if (object.versionId !== "null") res.setHeader("x-amz-version-id", object.versionId);
    });
    res.statusCode = statusCode; res.end();
  }

  private parseNotification(xml: string, bucket: S3BucketState): NonNullable<S3BucketState["notificationConfiguration"]> {
    if (!/<NotificationConfiguration(?:\s|>)/i.test(xml)) throw new AwsError("MalformedXML", "NotificationConfiguration is required", 400);
    const supported = /^(?:s3:)?(?:(?:ObjectCreated|ObjectRemoved):(?:\*|Put|Copy|CompleteMultipartUpload|Delete|DeleteMarkerCreated)|ObjectRestore:(?:\*|Post|Completed|Delete)|ObjectTagging:(?:\*|Put|Delete)|ObjectAcl:Put|ObjectAnnotation:(?:\*|Put|Delete)|LifecycleExpiration:(?:\*|Delete|DeleteMarkerCreated|DeleteMarkerDeleted)|LifecycleTransition)$/;
    const parse = (tag: "LambdaFunctionConfiguration" | "QueueConfiguration", destinationTag: "LambdaFunctionArn" | "Queue", acceptedTags: string[] = [tag], acceptedDestinationTags: string[] = [destinationTag]) => [...xml.matchAll(new RegExp(`<(${acceptedTags.join("|")})(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>`, "gi"))].map((match, position) => {
      const body = match[2]; const arn = acceptedDestinationTags.map(candidate => xmlValue(body, candidate)).find(Boolean); const id = xmlValue(body, "Id") ?? `${tag}-${position + 1}`; const events = [...body.matchAll(/<Event(?:\s[^>]*)?>([\s\S]*?)<\/Event>/gi)].map(candidate => xmlDecode(candidate[1].trim()));
      if (!arn || !id || Buffer.byteLength(id) > 255 || !events.length || events.some(event => !supported.test(event))) throw new AwsError("InvalidArgument", "Notification configuration contains an invalid ID, destination, or event name", 400);
      const rules = [...body.matchAll(/<FilterRule(?:\s[^>]*)?>([\s\S]*?)<\/FilterRule>/gi)].map(candidate => ({ name: xmlValue(candidate[1], "Name")?.toLowerCase(), value: xmlValue(candidate[1], "Value") ?? "" }));
      if (rules.some(rule => !["prefix", "suffix"].includes(rule.name ?? "")) || new Set(rules.map(rule => rule.name)).size !== rules.length) throw new AwsError("InvalidArgument", "Notification filters support at most one prefix and one suffix", 400);
      const prefix = rules.find(rule => rule.name === "prefix")?.value; const suffix = rules.find(rule => rule.name === "suffix")?.value;
      if (Buffer.byteLength(prefix ?? "") + Buffer.byteLength(suffix ?? "") > 1_024) throw new AwsError("InvalidArgument", "Notification filter is too long", 400);
      return { id, arn, events: events.map(event => event.startsWith("s3:") ? event : `s3:${event}`), ...(prefix !== undefined ? { prefix } : {}), ...(suffix !== undefined ? { suffix } : {}) };
    });
    // The official S3 REST-XML wire name is CloudFunctionConfiguration even
    // though SDK models call it LambdaFunctionConfiguration. Accept the older
    // descriptive spelling too for compatibility with saved local clients.
    const lambda = parse("LambdaFunctionConfiguration", "LambdaFunctionArn", ["CloudFunctionConfiguration", "LambdaFunctionConfiguration"], ["CloudFunction", "LambdaFunctionArn"]); const queue = parse("QueueConfiguration", "Queue"); const ids = [...lambda, ...queue].map(value => value.id);
    if (new Set(ids).size !== ids.length || ids.length > 100) throw new AwsError("InvalidArgument", "Notification configuration IDs must be unique and at most 100 destinations are supported", 400);
    const all = [...lambda, ...queue];
    for (let left = 0; left < all.length; left++) for (let right = left + 1; right < all.length; right++) {
      const commonEvent = all[left].events.some(event => all[right].events.includes(event) || event.endsWith(":*") && all[right].events.some(candidate => candidate.startsWith(event.slice(0, -1))) || all[right].events.some(candidate => candidate.endsWith(":*") && event.startsWith(candidate.slice(0, -1))));
      const prefixOverlap = (all[left].prefix ?? "").startsWith(all[right].prefix ?? "") || (all[right].prefix ?? "").startsWith(all[left].prefix ?? "");
      const suffixOverlap = (all[left].suffix ?? "").endsWith(all[right].suffix ?? "") || (all[right].suffix ?? "").endsWith(all[left].suffix ?? "");
      if (commonEvent && prefixOverlap && suffixOverlap) throw new AwsError("InvalidArgument", "Configuration is ambiguously defined because notification filters overlap for the same event", 400);
    }
    const eventBridge = /<EventBridgeConfiguration(?:\s[^>]*)?\/>|<EventBridgeConfiguration(?:\s[^>]*)?>\s*<\/EventBridgeConfiguration>/i.test(xml);
    if (eventBridge && !this.eventbridge) throw new AwsError("InvalidArgument", "The EventBridge notification dependency is unavailable", 400);
    for (const item of lambda) {
      const match = item.arn.match(/^arn:aws:lambda:([^:]+):(\d{12}):function:([^:]+)(?::[^:]+)?$/); if (!match || match[1] !== bucket.region || match[2] !== bucket.ownerAccountId) throw new AwsError("InvalidArgument", "Lambda notification destinations must be in the bucket Region and account", 400);
      if (!this.lambda) throw new AwsError("InvalidArgument", "The Lambda notification dependency is unavailable", 400);
      this.lambda.assertResourcePermission(item.arn, "s3.amazonaws.com", bucket.arn, bucket.ownerAccountId);
    }
    for (const item of queue) {
      const match = item.arn.match(/^arn:aws:sqs:([^:]+):(\d{12}):([^:]+)$/); if (!match || match[1] !== bucket.region) throw new AwsError("InvalidArgument", "SQS notification destinations must be in the bucket Region", 400);
      if (!this.sqs) throw new AwsError("InvalidArgument", "The SQS notification dependency is unavailable", 400);
    }
    if (/<TopicConfiguration(?:\s|>)/i.test(xml)) throw new AwsError("InvalidArgument", "SNS notification destinations require the planned S3/SNS integration", 400);
    return { lambda, queue, eventBridge };
  }

  private notificationXml(value: NonNullable<S3BucketState["notificationConfiguration"]>): string {
    const filter = (item: { prefix?: string; suffix?: string }) => item.prefix === undefined && item.suffix === undefined ? "" : `<Filter><S3Key>${item.prefix !== undefined ? `<FilterRule><Name>prefix</Name><Value>${xmlEscape(item.prefix)}</Value></FilterRule>` : ""}${item.suffix !== undefined ? `<FilterRule><Name>suffix</Name><Value>${xmlEscape(item.suffix)}</Value></FilterRule>` : ""}</S3Key></Filter>`;
    const lambda = value.lambda.map(item => `<CloudFunctionConfiguration><Id>${xmlEscape(item.id)}</Id><CloudFunction>${xmlEscape(item.arn)}</CloudFunction>${item.events.map(event => `<Event>${xmlEscape(event)}</Event>`).join("")}${filter(item)}</CloudFunctionConfiguration>`).join("");
    const queue = value.queue.map(item => `<QueueConfiguration><Id>${xmlEscape(item.id)}</Id><Queue>${xmlEscape(item.arn)}</Queue>${item.events.map(event => `<Event>${xmlEscape(event)}</Event>`).join("")}${filter(item)}</QueueConfiguration>`).join("");
    return restXml(`${lambda}${queue}${value.eventBridge ? "<EventBridgeConfiguration/>" : ""}`, "NotificationConfiguration");
  }

  private async getBucketNotification(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const value = located.bucket.notificationConfiguration ?? { lambda: [], queue: [], eventBridge: false };
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(this.notificationXml(value));
  }

  private async getNotificationDiagnostics(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const index = await this.bucketIndex(located); const pending = Object.values(index.notificationDeliveries ?? {});
    const rows = [...(index.notificationDiagnostics ?? [])].reverse().slice(0, 100).map(item => `<Delivery><Time>${iso(item.at)}</Time><DeliveryId>${xmlEscape(item.deliveryId)}</DeliveryId><Destination>${xmlEscape(item.destination)}</Destination><EventName>${xmlEscape(item.eventName)}</EventName><Status>${item.status}</Status><Attempts>${item.attempts}</Attempts>${item.error ? `<Error>${xmlEscape(item.error)}</Error>` : ""}</Delivery>`).join("");
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(`<Pending>${pending.length}</Pending><OldestPendingAgeMilliseconds>${pending.length ? Math.max(0, this.clock.now() - Math.min(...pending.map(item => item.enqueuedAt))) : 0}</OldestPendingAgeMilliseconds><Deliveries>${rows}</Deliveries>`, "NotificationDiagnostics"));
  }

  private async putBucketNotification(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const body = await readBody(req); if (body.length > 1024 * 1024) throw new AwsError("MalformedXML", "Notification configuration is too large", 400);
    const value = this.parseNotification(body.toString("utf8"), located.bucket);
    await this.applyNotificationConfiguration(located, value); res.statusCode = 200; res.end();
  }

  private async applyNotificationConfiguration(located: LocatedBucket, value: NonNullable<S3BucketState["notificationConfiguration"]>): Promise<void> {
    for (const item of value.queue) await this.sqs!.assertAuthorizedMessageDestination(item.arn, { kind: "service", principal: "s3.amazonaws.com", sourceArn: located.bucket.arn, sourceAccount: located.accountId });
    located.bucket.notificationConfiguration = value; await this.store.save();
    const index = await this.bucketIndex(located); const testPayload = JSON.stringify({ Service: "Amazon S3", Event: "s3:TestEvent", Time: iso(this.clock.now()), Bucket: located.bucket.name, RequestId: randomUUID(), HostId: createHash("sha256").update(located.bucket.arn).digest("base64") });
    for (const item of value.lambda) await this.addNotificationDelivery(located, index, "lambda", item.arn, item.id, "s3:TestEvent", testPayload, []);
    for (const item of value.queue) await this.addNotificationDelivery(located, index, "queue", item.arn, item.id, "s3:TestEvent", testPayload, []);
    await this.saveBucket(located, index); void this.runNotificationDeliveries();
  }

  private eventMatches(configured: string[], eventName: string): boolean {
    return configured.some(value => value === eventName || value.endsWith(":*") && eventName.startsWith(value.slice(0, -1)));
  }

  private notificationCaller(req?: IncomingMessage): { lineage: string[]; principal?: PrincipalContext; sourceIPAddress?: string } {
    if (!req) return { lineage: [] };
    const principal = (req as any).awsPrincipal as PrincipalContext | undefined;
    const remote = req.socket?.remoteAddress?.replace(/^::ffff:/, "");
    return { lineage: principal?.lambdaLineage ?? [], principal, ...(remote ? { sourceIPAddress: remote } : {}) };
  }

  private async enqueueObjectEvent(located: LocatedBucket, index: S3BucketIndex, key: string, object: S3ObjectVersionState | undefined, eventName: string, extra: Record<string, unknown> = {}, context: { lineage?: string[]; principal?: PrincipalContext; sourceIPAddress?: string } = {}): Promise<void> {
    const config = located.bucket.notificationConfiguration; if (!config) return;
    const encodedKey = encodeURIComponent(key).replace(/%20/g, "+"); const requestId = randomUUID(); const sequencer = createHash("sha256").update(`${located.bucket.name}\0${key}\0${object?.versionId ?? ""}\0${object?.lastModified ?? this.clock.now()}`).digest("hex").slice(0, 32).toUpperCase();
    const restore = object?.restore ?? (extra.restore as S3ObjectVersionState["restore"] | undefined);
    const serviceGenerated = !context.principal && /^(?:s3:)?(?:Lifecycle(?:Expiration|Transition)|ObjectRestore:(?:Completed|Delete))/.test(eventName);
    const principalId = context.principal?.principalId ?? (serviceGenerated ? "s3.amazonaws.com" : (object?.ownerId ?? located.bucket.ownerId));
    const requester = context.principal?.accountId || (serviceGenerated ? "s3.amazonaws.com" : (object?.ownerAccountId ?? located.accountId));
    const sourceIPAddress = context.sourceIPAddress ?? "127.0.0.1";
    const incomingLineage = context.lineage ?? [];
    const record: any = {
      eventVersion: "2.3", eventSource: "aws:s3", awsRegion: located.region, eventTime: iso(this.clock.now()), eventName: eventName.replace(/^s3:/, ""),
      userIdentity: { principalId },
      requestParameters: { sourceIPAddress }, responseElements: { "x-amz-request-id": requestId, "x-amz-id-2": createHash("sha256").update(requestId).digest("base64") },
      s3: { s3SchemaVersion: "1.0", configurationId: "", bucket: { name: located.bucket.name, ownerIdentity: { principalId: located.bucket.ownerId }, arn: located.bucket.arn }, object: { key: encodedKey, size: object?.size ?? 0, eTag: object?.etag || undefined, versionId: object?.versionId === "null" ? undefined : object?.versionId, sequencer, ...(object?.deleteMarker ? { deleteMarker: true } : {}), ...extra } },
    };
    delete record.s3.object.restore;
    if (eventName.startsWith("s3:ObjectRestore:") && restore) record.glacierEventData = { restoreEventData: { lifecycleRestorationExpiryTime: iso(restore.expiryAt), lifecycleRestoreStorageClass: "STANDARD" } };
    const candidates = [
      ...config.lambda.map(value => ({ ...value, type: "lambda" as const })),
      ...config.queue.map(value => ({ ...value, type: "queue" as const })),
    ].filter(item => this.eventMatches(item.events, eventName) && key.startsWith(item.prefix ?? "") && key.endsWith(item.suffix ?? ""));
    for (const item of candidates) {
      const payloadRecord = structuredClone(record); payloadRecord.s3.configurationId = item.id;
      await this.addNotificationDelivery(located, index, item.type, item.arn, item.id, eventName, JSON.stringify({ Records: [payloadRecord] }), [...incomingLineage, located.bucket.arn]);
    }
    if (config.eventBridge) {
      const descriptor = eventBridgeS3Event(eventName);
      const detail = { version: "0", bucket: { name: located.bucket.name }, object: { key, size: object?.size ?? 0, etag: object?.etag, "version-id": object?.versionId === "null" ? undefined : object?.versionId, sequencer }, "request-id": requestId, requester, "source-ip-address": sourceIPAddress, reason: descriptor.reason, ...(descriptor.deletionType ? { "deletion-type": descriptor.deletionType } : {}), ...(eventName === "s3:LifecycleTransition" ? { "destination-storage-class": String(extra.storageClass ?? object?.storageClass ?? "") } : {}), ...(eventName.startsWith("s3:ObjectRestore:") ? { "source-storage-class": object?.storageClass, ...(eventName === "s3:ObjectRestore:Completed" && restore ? { "restore-expiry-time": iso(restore.expiryAt) } : {}) } : {}) };
      await this.addNotificationDelivery(located, index, "eventbridge", undefined, "EventBridge", eventName, JSON.stringify(detail), [...incomingLineage, located.bucket.arn]);
    }
    await this.saveBucket(located, index); void this.runNotificationDeliveries();
  }

  private async addNotificationDelivery(located: LocatedBucket, index: S3BucketIndex, type: "lambda" | "queue" | "eventbridge", arn: string | undefined, configurationId: string, eventName: string, payload: string, lineage: string[]): Promise<void> {
    const deliveries = index.notificationDeliveries ??= {}; const make = () => {
      const id = randomUUID(); deliveries[id] = { id, destinationType: type, ...(arn ? { destinationArn: arn } : {}), configurationId, payload, eventName, enqueuedAt: this.clock.now(), nextAttemptAt: this.clock.now(), attempts: 0, lineage: [...lineage] };
    };
    make(); const count = Object.keys(deliveries).length; if (this.notificationDuplicateEvery > 0 && count % this.notificationDuplicateEvery === 0) make();
    await this.metric(located.bucket.name, "NotificationEventsQueued", 1, "Count");
  }

  private async runNotificationDeliveries(): Promise<void> {
    if (this.deliveryRunning) return; this.deliveryRunning = true;
    try {
      for (const located of this.allOwnedBuckets()) {
        await this.locked(located, async () => {
          const index = await this.bucketIndex(located); const deliveries = index.notificationDeliveries ??= {};
          for (const job of Object.values(deliveries).sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.id.localeCompare(b.id))) {
            const now = this.clock.now(); if (job.nextAttemptAt > now || job.leaseUntil && job.leaseUntil > now) continue;
            if (now - job.enqueuedAt > this.notificationMaximumAgeMs) { delete deliveries[job.id]; this.notificationDiagnostic(index, job, "EXPIRED", "Maximum event age exceeded"); await this.saveBucket(located, index); await this.metric(located.bucket.name, "NumberOfNotificationsFailed", 1, "Count"); continue; }
            job.leaseId = randomUUID(); job.leaseUntil = now + 30_000; job.attempts++; await this.saveBucket(located, index);
            try {
              if (job.destinationType === "lambda") await this.lambda!.enqueueServiceInvocation(job.destinationArn!, Buffer.from(job.payload), "s3.amazonaws.com", located.bucket.arn, located.accountId, job.lineage);
              else if (job.destinationType === "queue") await this.sqs!.sendAuthorizedMessageToArn(job.destinationArn!, { MessageBody: job.payload }, { kind: "service", principal: "s3.amazonaws.com", sourceArn: located.bucket.arn, sourceAccount: located.accountId, deliveryLineage: job.lineage });
              else await this.eventbridge!.publishServiceEvent({ source: "aws.s3", detailType: eventBridgeS3Event(job.eventName).detailType, detail: JSON.parse(job.payload), resources: [located.bucket.arn], time: now, eventBusName: "default", deliveryLineage: job.lineage });
              delete deliveries[job.id]; this.notificationDiagnostic(index, job, "SUCCESS"); await this.metric(located.bucket.name, "NumberOfNotificationsDelivered", 1, "Count");
            } catch (error) {
              delete job.leaseId; delete job.leaseUntil; job.nextAttemptAt = now + Math.min(60_000, 1_000 * 2 ** Math.min(job.attempts - 1, 6)); this.notificationDiagnostic(index, job, "FAILED", error instanceof Error ? error.message : String(error)); await this.metric(located.bucket.name, "NumberOfNotificationsFailed", 1, "Count");
            }
            await this.saveBucket(located, index);
          }
        });
      }
    } finally { this.deliveryRunning = false; }
  }

  private notificationDiagnostic(index: S3BucketIndex, job: NonNullable<S3BucketIndex["notificationDeliveries"]>[string], status: "SUCCESS" | "FAILED" | "EXPIRED", error?: string): void {
    const values = index.notificationDiagnostics ??= []; values.push({ at: this.clock.now(), deliveryId: job.id, destination: job.destinationArn ?? "default-event-bus", eventName: job.eventName, status, attempts: job.attempts, ...(error ? { error: error.slice(0, 512) } : {}) }); if (values.length > 500) values.splice(0, values.length - 500);
  }

  private async metric(bucketName: string, metricName: string, value: number, unit: string): Promise<void> {
    await this.telemetry?.publish({ namespace: "AWS/S3", metricName, dimensions: { BucketName: bucketName, FilterId: "EntireBucket" }, value, unit, timestamp: this.clock.now() }).catch(() => undefined);
  }

  private effectiveBlock(located: LocatedBucket): S3PublicAccessBlockState {
    return effectivePublicAccessBlock(located.bucket, this.store.ensureAccount(located.accountId).s3PublicAccessBlock);
  }

  private async getBucketAcl(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name);
    const acl = located.bucket.objectOwnership === "BucketOwnerEnforced" ? privateAcl(located.accountId) : located.bucket.acl ?? privateAcl(located.accountId);
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(aclXml(acl), "AccessControlPolicy"));
  }

  private async putBucketAcl(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name);
    if ((located.bucket.objectOwnership ?? "ObjectWriter") === "BucketOwnerEnforced") throw new AwsError("AccessControlListNotSupported", "The bucket does not allow ACLs", 400);
    const xml = (await readBody(req)).toString("utf8");
    const acl = aclFromRequest(xml, req.headers, located.accountId, located.accountId, false);
    if (this.effectiveBlock(located).blockPublicAcls && aclIsPublic(acl)) throw new AwsError("AccessDenied", "Block Public Access rejects this public bucket ACL", 403);
    await this.locked(located, async () => { located.bucket.acl = acl; await this.store.save(); });
    res.statusCode = 200; res.end();
  }

  private async getObjectAcl(res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const located = this.requireBucket(bucketName); const index = await this.bucketIndex(located); const selected = selectObject(index, key, url.searchParams.get("versionId"));
    const acl = located.bucket.objectOwnership === "BucketOwnerEnforced" ? privateAcl(located.accountId) : objectAcl(selected.version, located.bucket);
    if (selected.version.versionId !== "null") res.setHeader("x-amz-version-id", selected.version.versionId);
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(aclXml(acl), "AccessControlPolicy"));
  }

  private async putObjectAcl(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const located = this.requireBucket(bucketName);
    if ((located.bucket.objectOwnership ?? "ObjectWriter") === "BucketOwnerEnforced") throw new AwsError("AccessControlListNotSupported", "The bucket does not allow ACLs", 400);
    const xml = (await readBody(req)).toString("utf8");
    await this.locked(located, async () => {
      const index = await this.bucketIndex(located); const selected = selectObject(index, key, url.searchParams.get("versionId"));
      const writerAccountId = selected.version.ownerAccountId ?? located.accountId;
      const acl = aclFromRequest(xml, req.headers, located.accountId, writerAccountId, true);
      if (this.effectiveBlock(located).blockPublicAcls && aclIsPublic(acl)) throw new AwsError("AccessDenied", "Block Public Access rejects this public object ACL", 403);
      selected.version.acl = acl; await this.saveBucket(located, index); await this.enqueueObjectEvent(located, index, key, selected.version, "s3:ObjectAcl:Put", {}, this.notificationCaller(req));
      if (selected.version.versionId !== "null") res.setHeader("x-amz-version-id", selected.version.versionId);
    });
    res.statusCode = 200; res.end();
  }

  private async getBucketOwnershipControls(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name);
    if (located.bucket.objectOwnership === undefined) throw new AwsError("OwnershipControlsNotFoundError", "The bucket ownership controls were not found", 404);
    res.statusCode = 200; res.setHeader("content-type", "application/xml");
    res.end(restXml(`<Rule><ObjectOwnership>${located.bucket.objectOwnership}</ObjectOwnership></Rule>`, "OwnershipControls"));
  }

  private async putBucketOwnershipControls(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const xml = (await readBody(req)).toString("utf8");
    const rules = [...xml.matchAll(/<Rule(?:\s[^>]*)?>([\s\S]*?)<\/Rule>/gi)];
    const ownership = rules.length === 1 ? xmlValue(rules[0][1], "ObjectOwnership") : undefined;
    if (!ownership || !["BucketOwnerEnforced", "BucketOwnerPreferred", "ObjectWriter"].includes(ownership)) throw new AwsError("MalformedXML", "OwnershipControls requires exactly one valid ObjectOwnership rule", 400);
    if (ownership === "BucketOwnerEnforced" && (located.bucket.acl ?? privateAcl(located.accountId)).grants.some(grant => !(grant.permission === "FULL_CONTROL" && grant.grantee.type === "CanonicalUser" && grant.grantee.id === ownerId(located.accountId)))) {
      throw new AwsError("InvalidBucketAclWithObjectOwnership", "Bucket cannot have ACLs set with ObjectOwnership's BucketOwnerEnforced setting", 400);
    }
    located.bucket.objectOwnership = ownership as S3BucketState["objectOwnership"];
    if (located.bucket.cloudFormationConfiguration) located.bucket.cloudFormationConfiguration.ownershipControls = true;
    await this.store.save(); res.statusCode = 200; res.end();
  }

  private async deleteBucketOwnershipControls(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); delete located.bucket.objectOwnership;
    if (located.bucket.cloudFormationConfiguration) located.bucket.cloudFormationConfiguration.ownershipControls = false;
    await this.store.save(); res.statusCode = 204; res.end();
  }

  private async getBucketAbac(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); res.statusCode = 200; res.setHeader("content-type", "application/xml");
    res.end(restXml(`<Status>${located.bucket.abacStatus ?? "Disabled"}</Status>`, "AbacStatus"));
  }

  private async putBucketAbac(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const xml = (await readBody(req)).toString("utf8"); const status = xmlValue(xml, "Status");
    if (!status || !["Enabled", "Disabled"].includes(status)) throw new AwsError("MalformedXML", "AbacStatus requires Enabled or Disabled", 400);
    located.bucket.abacStatus = status as "Enabled" | "Disabled"; await this.store.save(); res.statusCode = 200; res.end();
  }

  private async getBucketRequestPayment(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); res.statusCode = 200; res.setHeader("content-type", "application/xml");
    res.end(restXml(`<Payer>${located.bucket.requestPayment ?? "BucketOwner"}</Payer>`, "RequestPaymentConfiguration"));
  }

  private async putBucketRequestPayment(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const xml = (await readBody(req)).toString("utf8"); const payer = xmlValue(xml, "Payer");
    if (!payer || !["BucketOwner", "Requester"].includes(payer)) throw new AwsError("MalformedXML", "Payer must be BucketOwner or Requester", 400);
    located.bucket.requestPayment = payer as "BucketOwner" | "Requester"; await this.store.save(); res.statusCode = 200; res.end();
  }

  private async getBucketPublicAccessBlock(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name);
    if (located.bucket.publicAccessBlock === undefined) throw new AwsError("NoSuchPublicAccessBlockConfiguration", "The public access block configuration was not found", 404);
    const value = canonicalPublicAccessBlock(located.bucket.publicAccessBlock);
    const body = `<BlockPublicAcls>${value.blockPublicAcls}</BlockPublicAcls><IgnorePublicAcls>${value.ignorePublicAcls}</IgnorePublicAcls><BlockPublicPolicy>${value.blockPublicPolicy}</BlockPublicPolicy><RestrictPublicBuckets>${value.restrictPublicBuckets}</RestrictPublicBuckets>`;
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(body, "PublicAccessBlockConfiguration"));
  }

  private async putBucketPublicAccessBlock(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name);
    if (located.bucket.managedBy) throw new AwsError("AccessDenied", "Simulator-managed bootstrap buckets cannot be configured as public application buckets", 403);
    const body = await readBody(req);
    if (body.length > 64 * 1024) throw new AwsError("MalformedXML", "The XML document exceeds the maximum allowed size", 400);
    const xml = body.toString("utf8");
    if (!/<PublicAccessBlockConfiguration(?:\s|>)/i.test(xml)) throw new AwsError("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema", 400);
    const value: S3BucketPublicAccessBlock = {
      blockPublicAcls: parseXmlBoolean(xml, "BlockPublicAcls"),
      ignorePublicAcls: parseXmlBoolean(xml, "IgnorePublicAcls"),
      blockPublicPolicy: parseXmlBoolean(xml, "BlockPublicPolicy"),
      restrictPublicBuckets: parseXmlBoolean(xml, "RestrictPublicBuckets"),
    };
    located.bucket.publicAccessBlock = value;
    if (located.bucket.cloudFormationConfiguration) located.bucket.cloudFormationConfiguration.publicAccessBlock = true;
    await this.store.save(); res.statusCode = 200; res.end();
  }

  private async deleteBucketPublicAccessBlock(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name);
    if (located.bucket.managedBy) throw new AwsError("AccessDenied", "Simulator-managed bootstrap buckets cannot be configured as public application buckets", 403);
    delete located.bucket.publicAccessBlock;
    if (located.bucket.cloudFormationConfiguration) located.bucket.cloudFormationConfiguration.publicAccessBlock = false;
    await this.store.save(); res.statusCode = 204; res.end();
  }

  private async getBucketWebsite(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const website = validateWebsiteConfiguration(located.bucket.website);
    if (!website) throw new AwsError("NoSuchWebsiteConfiguration", "The specified bucket does not have a website configuration", 404);
    const body = `<IndexDocument><Suffix>${xmlEscape(website.indexDocument)}</Suffix></IndexDocument>${website.errorDocument ? `<ErrorDocument><Key>${xmlEscape(website.errorDocument)}</Key></ErrorDocument>` : ""}`;
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(body, "WebsiteConfiguration"));
  }

  private async putBucketWebsite(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name);
    if (located.bucket.managedBy) throw new AwsError("AccessDenied", "Simulator-managed bootstrap buckets cannot be configured as public application buckets", 403);
    const body = await readBody(req);
    if (body.length > 64 * 1024) throw new AwsError("MalformedXML", "The XML document exceeds the maximum allowed size", 400);
    const xml = body.toString("utf8"); const indexBody = xml.match(/<IndexDocument(?:\s[^>]*)?>([\s\S]*?)<\/IndexDocument>/i)?.[1]; const errorBody = xml.match(/<ErrorDocument(?:\s[^>]*)?>([\s\S]*?)<\/ErrorDocument>/i)?.[1];
    if (!/<WebsiteConfiguration(?:\s|>)/i.test(xml) || !indexBody) throw new AwsError("MalformedXML", "Only IndexDocument and optional ErrorDocument website configuration are supported", 400);
    const website = validateWebsiteConfiguration({ indexDocument: xmlValue(indexBody, "Suffix") ?? "", ...(errorBody ? { errorDocument: xmlValue(errorBody, "Key") ?? "" } : {}) });
    located.bucket.website = website; await this.store.save(); res.statusCode = 200; res.end();
  }

  private async deleteBucketWebsite(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name);
    if (located.bucket.managedBy) throw new AwsError("AccessDenied", "Simulator-managed bootstrap buckets cannot be configured as public application buckets", 403);
    delete located.bucket.website; await this.store.save(); res.statusCode = 204; res.end();
  }

  private async getBucketCors(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const rules = validateCorsConfiguration(located.bucket.corsConfiguration);
    if (!rules) throw new AwsError("NoSuchCORSConfiguration", "The CORS configuration does not exist", 404);
    const body = rules.map(rule => `<CORSRule>${rule.allowedOrigins.map(value => `<AllowedOrigin>${xmlEscape(value)}</AllowedOrigin>`).join("")}${rule.allowedMethods.map(value => `<AllowedMethod>${value}</AllowedMethod>`).join("")}${rule.allowedHeaders.map(value => `<AllowedHeader>${xmlEscape(value)}</AllowedHeader>`).join("")}</CORSRule>`).join("");
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(body, "CORSConfiguration"));
  }

  private async putBucketCors(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const xml = (await readBody(req)).toString("utf8");
    const blocks = [...xml.matchAll(/<CORSRule(?:\s[^>]*)?>([\s\S]*?)<\/CORSRule>/gi)].map(match => match[1]);
    const values = (body: string, key: string) => [...body.matchAll(new RegExp(`<${key}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${key}>`, "gi"))].map(match => xmlDecode(match[1]));
    const rules = blocks.map(body => ({ allowedHeaders: values(body, "AllowedHeader"), allowedMethods: values(body, "AllowedMethod") as Array<"GET" | "HEAD">, allowedOrigins: values(body, "AllowedOrigin") }));
    located.bucket.corsConfiguration = validateCorsConfiguration(rules); await this.store.save(); res.statusCode = 200; res.end();
  }

  private async deleteBucketCors(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); delete located.bucket.corsConfiguration; await this.store.save(); res.statusCode = 204; res.end();
  }

  private matchingCorsRule(bucket: S3BucketState, origin: string, method: string): S3BucketCorsRule | undefined {
    return bucket.corsConfiguration?.find(rule => rule.allowedOrigins.includes(origin) && rule.allowedMethods.includes(method as "GET" | "HEAD"));
  }

  private applyCorsHeaders(req: IncomingMessage, res: ServerResponse, bucket: S3BucketState, method: string): void {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!origin || !this.matchingCorsRule(bucket, origin, method)) return;
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
  }

  private corsPreflight(req: IncomingMessage, res: ServerResponse, bucket: S3BucketState): void {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    const method = typeof req.headers["access-control-request-method"] === "string" ? req.headers["access-control-request-method"].toUpperCase() : "";
    const rule = this.matchingCorsRule(bucket, origin, method);
    if (!rule) throw new AwsError("AccessForbidden", "CORSResponse: This CORS request is not allowed.", 403);
    res.statusCode = 200;
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", rule.allowedMethods.join(", "));
    res.setHeader("access-control-allow-headers", rule.allowedHeaders.join(", "));
    res.setHeader("vary", "Origin, Access-Control-Request-Headers, Access-Control-Request-Method");
    res.end();
  }

  private async getBucketPolicy(res: ServerResponse, name: string): Promise<void> {
    const policy = await this.readBucketPolicyInternal(name);
    if (!policy) throw new AwsError("NoSuchBucketPolicy", "The bucket policy does not exist", 404);
    res.statusCode = 200; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(policy));
  }

  private async putBucketPolicy(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const body = await readBody(req);
    if (body.length > 20 * 1024) throw new AwsError("PolicyTooLarge", "The bucket policy exceeds the maximum supported size", 400);
    let value: unknown; try { value = JSON.parse(body.toString("utf8")); } catch { throw new AwsError("MalformedPolicy", "The policy document is not valid JSON", 400); }
    const document = validatePolicyDocument(value);
    const located = this.requireBucket(name);
    this.validatePolicyPrincipals(document, located);
    const rootArn = `arn:aws:iam::${located.accountId}:root`;
    const ownerDecision = evaluateResourcePolicy(document, rootArn, "s3:PutBucketPolicy", located.bucket.arn, { "aws:PrincipalArn": rootArn, "aws:PrincipalAccount": located.accountId });
    if (ownerDecision.decision === "explicitDeny" && String(req.headers["x-amz-confirm-remove-self-bucket-access"] ?? "").toLowerCase() !== "true") throw new AwsError("AccessDenied", "Set x-amz-confirm-remove-self-bucket-access to acknowledge a policy that removes owner policy access", 403);
    await this.putBucketPolicyInternal(name, document); res.statusCode = 204; res.end();
  }

  private async deleteBucketPolicy(res: ServerResponse, name: string): Promise<void> {
    await this.deleteBucketPolicyInternal(name); res.statusCode = 204; res.end();
  }

  private validatePolicyPrincipals(document: PolicyDocument, located: LocatedBucket): void {
    const values = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined ? [] : [value];
    for (const statement of values(document.Statement) as any[]) {
      for (const field of ["Principal", "NotPrincipal"] as const) {
        const principal = statement[field];
        const entries = principal && typeof principal === "object" && !Array.isArray(principal)
          ? Object.entries(principal).flatMap(([kind, item]) => values(item).map(value => ({ kind, value: String(value) })))
          : values(principal).map(value => ({ kind: "AWS", value: String(value) }));
        for (const entry of entries) {
          if (entry.value === "*") continue;
          if (entry.kind === "Service") {
            if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.amazonaws\.com(?:\.cn)?$/i.test(entry.value)) throw new AwsError("MalformedPolicy", `Invalid service principal ${entry.value}`, 400);
            continue;
          }
          if (entry.kind === "CanonicalUser") {
            if (entry.value !== located.bucket.ownerId && entry.value !== canonicalOwnerId(located.accountId)) throw new AwsError("InvalidPrincipal", "Invalid principal in policy", 400);
            continue;
          }
          const accountId = entry.value.match(/^\d{12}$/)?.[0] ?? entry.value.match(/^arn:aws:iam::(\d{12}):root$/)?.[1];
          if (accountId) { if (!this.store.state.accounts[accountId]) throw new AwsError("InvalidPrincipal", "Invalid principal in policy", 400); continue; }
          const role = entry.value.match(/^arn:aws:iam::(\d{12}):role\/(.+)$/);
          if (role && Object.values(this.store.state.accounts[role[1]]?.iam.roles ?? {}).some(candidate => candidate.arn === entry.value)) continue;
          const user = entry.value.match(/^arn:aws:iam::(\d{12}):user\/(.+)$/);
          if (user && Object.values(this.store.state.accounts[user[1]]?.iam.users ?? {}).some(candidate => candidate.arn === entry.value)) continue;
          const session = entry.value.match(/^arn:aws:sts::(\d{12}):assumed-role\/(.+)\/[^/]+$/);
          if (session && Object.values(this.store.state.accounts[session[1]]?.iam.sessions ?? {}).some(candidate => candidate.principalArn === entry.value)) continue;
          throw new AwsError("InvalidPrincipal", "Invalid principal in policy", 400);
        }
      }
    }
  }

  private async getBucketPolicyStatus(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); res.statusCode = 200; res.setHeader("content-type", "application/xml");
    res.end(restXml(`<IsPublic>${policyIsPublic(located.bucket.policyDocument)}</IsPublic>`, "PolicyStatus"));
  }

  private async listBuckets(res: ServerResponse, url: URL): Promise<void> {
    const prefix = url.searchParams.get("prefix") ?? ""; const region = url.searchParams.get("bucket-region"); const maximum = url.searchParams.has("max-buckets") ? Number(url.searchParams.get("max-buckets")) : 10_000;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10_000) throw new AwsError("InvalidArgument", "Invalid max-buckets value", 400);
    const filtered = this.allOwnedBuckets().filter(item => item.bucket.name.startsWith(prefix) && (!region || item.region === region)); let offset = 0; const suppliedToken = url.searchParams.get("continuation-token");
    if (suppliedToken) { try { const cursor = this.pagination.decode<{ prefix: string; region: string | null; offset: number }>("s3:ListBuckets", suppliedToken); if (cursor.prefix !== prefix || cursor.region !== region) throw new Error(); offset = cursor.offset; } catch { throw new AwsError("InvalidArgument", "The continuation token provided is incorrect", 400); } }
    const page = filtered.slice(offset, offset + maximum); const nextOffset = offset + page.length; const next = nextOffset < filtered.length ? this.pagination.encode("s3:ListBuckets", { prefix, region, offset: nextOffset }) : undefined;
    const buckets = page.map(item => {
      const tags = Object.entries(item.bucket.tags ?? {}).map(([key, value]) => `<Tag><Key>${xmlEscape(key)}</Key><Value>${xmlEscape(value)}</Value></Tag>`).join("");
      return `<Bucket><Name>${xmlEscape(item.bucket.name)}</Name><CreationDate>${iso(item.bucket.createdAt)}</CreationDate><BucketRegion>${xmlEscape(item.region)}</BucketRegion><BucketArn>${xmlEscape(item.bucket.arn)}</BucketArn><ObjectLockEnabled>${item.bucket.objectLockConfiguration ? "Enabled" : "Disabled"}</ObjectLockEnabled><LifecycleConfigured>${Boolean(item.bucket.lifecycleConfiguration)}</LifecycleConfigured><BucketTags>${tags}</BucketTags></Bucket>`;
    }).join("");
    const body = `<Owner><ID>${ownerId(this.store.accountId)}</ID><DisplayName>${LOCAL_OWNER_DISPLAY_NAME}</DisplayName></Owner><Buckets>${buckets}</Buckets><Prefix>${xmlEscape(prefix)}</Prefix>${next ? `<ContinuationToken>${xmlEscape(next)}</ContinuationToken>` : ""}`;
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(body, "ListAllMyBucketsResult"));
  }

  private async getBucketVersioning(res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const status = located.bucket.versioning === "enabled" ? "Enabled" : located.bucket.versioning === "suspended" ? "Suspended" : undefined;
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(status ? `<Status>${status}</Status>` : "", "VersioningConfiguration"));
  }

  private async putBucketVersioning(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const located = this.requireBucket(name); const body = (await readBody(req)).toString("utf8"); const status = xmlValue(body, "Status"); if (!status || !["Enabled", "Suspended"].includes(status)) throw new AwsError("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema", 400); if (xmlValue(body, "MfaDelete") !== undefined || xmlValue(body, "MFADelete") !== undefined) throw new AwsError("InvalidRequest", "MFA Delete requires the IAM MFA context planned for IAM-08", 400);
    if (status === "Suspended" && located.bucket.objectLockConfiguration) throw new AwsError("InvalidBucketState", "Versioning cannot be suspended on an Object Lock enabled bucket", 409);
    located.bucket.versioning = status === "Enabled" ? "enabled" : "suspended"; await this.store.save(); res.statusCode = 200; res.end();
  }

  private visibleObjects(index: S3BucketIndex): Array<{ key: string; object: S3ObjectVersionState }> {
    return Object.entries(index.objects).flatMap(([key, versions]) => versions[0] && !versions[0].deleteMarker ? [{ key, object: versions[0] }] : []).sort((left, right) => utf8Compare(left.key, right.key));
  }

  private async listObjects(res: ServerResponse, url: URL, name: string): Promise<void> {
    const located = this.requireBucket(name); const index = await this.bucketIndex(located); const versionTwo = url.searchParams.get("list-type") === "2"; const prefix = url.searchParams.get("prefix") ?? ""; const delimiter = url.searchParams.get("delimiter") ?? ""; const encodingType = url.searchParams.get("encoding-type"); const maximum = url.searchParams.has("max-keys") ? Number(url.searchParams.get("max-keys")) : 1_000;
    if (!Number.isInteger(maximum) || maximum < 0 || maximum > 1_000) throw new AwsError("InvalidArgument", "Invalid max-keys value", 400);
    const all = this.visibleObjects(index).filter(entry => entry.key.startsWith(prefix)); const entries: Array<{ type: "object" | "prefix"; key: string; object?: S3ObjectVersionState }> = []; const common = new Set<string>();
    for (const entry of all) {
      const remainder = entry.key.slice(prefix.length); const boundary = delimiter ? remainder.indexOf(delimiter) : -1;
      if (boundary >= 0) { const value = `${prefix}${remainder.slice(0, boundary + delimiter.length)}`; if (!common.has(value)) { common.add(value); entries.push({ type: "prefix", key: value }); } }
      else entries.push({ type: "object", key: entry.key, object: entry.object });
    }
    entries.sort((left, right) => utf8Compare(left.key, right.key) || left.type.localeCompare(right.type));
    let offset = 0; const marker = versionTwo ? url.searchParams.get("start-after") : url.searchParams.get("marker"); if (marker) offset = entries.findIndex(entry => utf8Compare(entry.key, marker) > 0); if (offset < 0) offset = entries.length;
    const token = versionTwo ? url.searchParams.get("continuation-token") : undefined;
    if (token) { try { const cursor = this.pagination.decode<{ bucket: string; prefix: string; delimiter: string; offset: number }>("s3:ListObjectsV2", token); if (cursor.bucket !== name || cursor.prefix !== prefix || cursor.delimiter !== delimiter) throw new Error(); offset = cursor.offset; } catch { throw new AwsError("InvalidArgument", "The continuation token provided is incorrect", 400); } }
    const page = entries.slice(offset, offset + maximum); const nextOffset = offset + page.length; const truncated = nextOffset < entries.length; const nextToken = truncated && versionTwo ? this.pagination.encode("s3:ListObjectsV2", { bucket: name, prefix, delimiter, offset: nextOffset }) : undefined;
    const owner = `<Owner><ID>${ownerId(located.accountId)}</ID><DisplayName>${LOCAL_OWNER_DISPLAY_NAME}</DisplayName></Owner>`; const fetchOwner = url.searchParams.get("fetch-owner") === "true";
    const content = page.map(entry => entry.type === "prefix" ? `<CommonPrefixes><Prefix>${encodeKey(entry.key, encodingType)}</Prefix></CommonPrefixes>` : `<Contents><Key>${encodeKey(entry.key, encodingType)}</Key><LastModified>${iso(entry.object!.lastModified)}</LastModified><ETag>${xmlEscape(quotedEtag(entry.object!.etag))}</ETag>${activeChecksum(entry.object!) ? `<ChecksumAlgorithm>${activeChecksum(entry.object!)}</ChecksumAlgorithm><ChecksumType>${entry.object!.checksumType ?? "FULL_OBJECT"}</ChecksumType>` : ""}<Size>${entry.object!.size}</Size><StorageClass>${entry.object!.storageClass}</StorageClass>${!versionTwo || fetchOwner ? owner : ""}</Contents>`).join("");
    const body = `<Name>${xmlEscape(name)}</Name><Prefix>${encodeKey(prefix, encodingType)}</Prefix>${delimiter ? `<Delimiter>${encodeKey(delimiter, encodingType)}</Delimiter>` : ""}<MaxKeys>${maximum}</MaxKeys>${encodingType ? `<EncodingType>${xmlEscape(encodingType)}</EncodingType>` : ""}<IsTruncated>${truncated}</IsTruncated>${versionTwo ? `<KeyCount>${page.length}</KeyCount>${token ? `<ContinuationToken>${xmlEscape(token)}</ContinuationToken>` : ""}${url.searchParams.get("start-after") ? `<StartAfter>${encodeKey(url.searchParams.get("start-after")!, encodingType)}</StartAfter>` : ""}${nextToken ? `<NextContinuationToken>${xmlEscape(nextToken)}</NextContinuationToken>` : ""}` : `${marker ? `<Marker>${encodeKey(marker, encodingType)}</Marker>` : ""}${truncated && page.length && delimiter ? `<NextMarker>${encodeKey(page.at(-1)!.key, encodingType)}</NextMarker>` : ""}`}${content}`;
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(body, versionTwo ? "ListBucketResult" : "ListBucketResult"));
  }

  private async ensureCapacity(located: LocatedBucket, index: S3BucketIndex, key: string, newSize: number, releasedMultipartBytes = 0): Promise<void> {
    const existing = currentObject(index, key); const objectCount = this.visibleObjects(index).length + (!existing || existing.deleteMarker ? 1 : 0); if (objectCount > this.maximumBucketObjects) throw new AwsError("ServiceUnavailable", "The local bucket object limit has been reached.", 503);
    let total = 0;
    for (const bucket of this.allOwnedBuckets()) { const candidate = this.cacheKey(bucket) === this.cacheKey(located) ? index : await this.bucketIndex(bucket); for (const versions of Object.values(candidate.objects)) for (const version of versions) if (!version.deleteMarker) total += version.size; for (const upload of Object.values(candidate.multipartUploads)) for (const part of Object.values(upload.parts)) total += part.size; }
    const replacedBytes = located.bucket.versioning === "enabled" ? 0 : (index.objects[key] ?? []).filter(version => !version.deleteMarker && (located.bucket.versioning === "unversioned" || version.versionId === "null")).reduce((sum, version) => sum + version.size, 0);
    if (total - releasedMultipartBytes - replacedBytes + newSize > this.maximumTotalBytes) throw new AwsError("ServiceUnavailable", "The local S3 total-storage limit has been reached.", 503);
  }

  private writeAccess(req: IncomingMessage, bucket: S3BucketState): { ownerAccountId: string; ownerId: string; acl: ReturnType<typeof privateAcl> } {
    const principal = (req as any).awsPrincipal as PrincipalContext | undefined;
    const writerAccountId = principal?.accountId || bucket.ownerAccountId;
    const ownership = bucket.objectOwnership ?? "ObjectWriter";
    const suppliedAcl = String(req.headers["x-amz-acl"] ?? "");
    const grantHeaders = ["x-amz-grant-full-control", "x-amz-grant-read", "x-amz-grant-write", "x-amz-grant-read-acp", "x-amz-grant-write-acp"].some(name => req.headers[name] !== undefined);
    if (ownership === "BucketOwnerEnforced") {
      if (grantHeaders || suppliedAcl && suppliedAcl !== "bucket-owner-full-control") throw new AwsError("AccessControlListNotSupported", "The bucket does not allow ACLs", 400);
      return { ownerAccountId: bucket.ownerAccountId, ownerId: ownerId(bucket.ownerAccountId), acl: privateAcl(bucket.ownerAccountId) };
    }
    let acl = aclFromRequest("", req.headers, bucket.ownerAccountId, writerAccountId, true);
    const located = this.findBucket(bucket.name)!;
    if (this.effectiveBlock(located).blockPublicAcls && aclIsPublic(acl)) throw new AwsError("AccessDenied", "Block Public Access rejects this public object ACL", 403);
    const preferred = ownership === "BucketOwnerPreferred" && suppliedAcl === "bucket-owner-full-control";
    const ownerAccountId = preferred ? bucket.ownerAccountId : writerAccountId;
    if (preferred) acl = privateAcl(bucket.ownerAccountId);
    return { ownerAccountId, ownerId: ownerId(ownerAccountId), acl };
  }

  private writeLock(req: IncomingMessage, bucket: S3BucketState): Pick<S3ObjectVersionState, "retention" | "legalHold"> {
    const mode = req.headers["x-amz-object-lock-mode"]?.toString(); const retainText = req.headers["x-amz-object-lock-retain-until-date"]?.toString(); const legalHoldText = req.headers["x-amz-object-lock-legal-hold"]?.toString();
    if ((mode || retainText || legalHoldText) && !bucket.objectLockConfiguration) throw new AwsError("InvalidRequest", "Object Lock headers require Object Lock to be enabled on the bucket", 400);
    let retention: S3ObjectVersionState["retention"];
    if (mode || retainText) { const retainUntil = Date.parse(retainText ?? ""); if (!["GOVERNANCE", "COMPLIANCE"].includes(mode ?? "") || !Number.isFinite(retainUntil) || retainUntil <= this.clock.now()) throw new AwsError("InvalidRequest", "Object Lock retention requires a valid mode and future date", 400); retention = { mode: mode as any, retainUntil }; }
    else if (bucket.objectLockConfiguration?.defaultRetention) { const value = bucket.objectLockConfiguration.defaultRetention; const duration = value.days !== undefined ? value.days * 86_400_000 : value.years! * 365 * 86_400_000; retention = { mode: value.mode, retainUntil: this.clock.now() + duration }; }
    if (legalHoldText !== undefined && !["ON", "OFF"].includes(legalHoldText)) throw new AwsError("InvalidArgument", "x-amz-object-lock-legal-hold must be ON or OFF", 400);
    return { ...(retention ? { retention } : {}), ...(legalHoldText ? { legalHold: legalHoldText as any } : {}) };
  }

  private objectState(req: IncomingMessage, bucket: S3BucketState, staged: StagedS3Object, blobId: string, inherited?: S3ObjectVersionState, etag = staged.digest.etag, parts?: S3ObjectPartState[]): S3ObjectVersionState {
    const details = requestDetails(req, inherited); const checksumAlgorithm = checksumAlgorithmFor(req, inherited, staged.trailers); const access = this.writeAccess(req, bucket); const encryption = objectEncryption(req, bucket, inherited);
    return { versionId: versionIdForWrite(bucket), blobId, size: staged.size, etag, lastModified: this.clock.now(), ...details, ...access, ...encryption, ...this.writeLock(req, bucket), checksums: { [checksumAlgorithm]: staged.digest.values[checksumAlgorithm] }, checksumAlgorithm, checksumType: parts ? "COMPOSITE" : "FULL_OBJECT", storageClass: details.storageClass, parts };
  }

  private async putObject(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    if (Buffer.byteLength(key) > 1_024) throw new AwsError("KeyTooLongError", "Your key is too long", 400); const located = this.requireBucket(bucketName);
    await this.locked(located, async () => {
      const index = await this.bucketIndex(located); enforceWriteConditions(req, currentObject(index, key));
      if (req.headers["x-amz-copy-source"]) return await this.copyObject(req, res, url, located, index, key);
      objectEncryption(req, located.bucket);
      const staged = await this.storage.stageRequest(req, this.maximumObjectBytes);
      try { await this.ensureCapacity(located, index, key, staged.size); const blobId = await this.storage.publish(staged); const object = this.objectState(req, located.bucket, staged, blobId); publishVersion(located.bucket, index, key, object); await this.saveBucket(located, index); await this.enqueueObjectEvent(located, index, key, object, "s3:ObjectCreated:Put", {}, this.notificationCaller(req)); res.statusCode = 200; setObjectHeaders(res, object); if (object.versionId !== "null") res.setHeader("x-amz-version-id", object.versionId); const algorithm = activeChecksum(object); if (algorithm && (req.headers["x-amz-checksum-algorithm"] !== undefined || req.headers["x-amz-sdk-checksum-algorithm"] !== undefined || providedChecksumAlgorithms(req.headers, staged.trailers).length)) res.setHeader(checksumHeaderName(algorithm), object.checksums[algorithm]!); res.end(); }
      catch (error) { await this.storage.discardStaged(staged); throw error; }
    });
  }

  private parseCopySource(req: IncomingMessage): { located: LocatedBucket; key: string; versionId?: string } {
    const supplied = String(req.headers["x-amz-copy-source"] ?? ""); if (!supplied) throw new AwsError("InvalidArgument", "Copy source must be specified", 400); const withoutSlash = supplied.replace(/^\//, ""); const question = withoutSlash.indexOf("?"); const rawPath = question < 0 ? withoutSlash : withoutSlash.slice(0, question); const query = new URLSearchParams(question < 0 ? "" : withoutSlash.slice(question + 1)); const slash = rawPath.indexOf("/"); if (slash < 1) throw new AwsError("InvalidArgument", "Invalid copy source", 400);
    const bucket = decodePathComponent(rawPath.slice(0, slash)); const key = decodePathComponent(rawPath.slice(slash + 1)); const located = this.findBucket(bucket); if (!located) throw new AwsError("NoSuchBucket", "The specified bucket does not exist", 404); if (located.accountId !== this.store.accountId) throw new AwsError("AccessDenied", "Access Denied", 403); return { located, key, versionId: query.get("versionId") ?? undefined };
  }

  private enforceCopyConditions(req: IncomingMessage, source: S3ObjectVersionState): void {
    const match = req.headers["x-amz-copy-source-if-match"]; if (match !== undefined && !etagMatches(match, source.etag)) throw new AwsError("PreconditionFailed", "At least one of the pre-conditions you specified did not hold", 412);
    const none = req.headers["x-amz-copy-source-if-none-match"]; if (none !== undefined && etagMatches(none, source.etag)) throw new AwsError("PreconditionFailed", "At least one of the pre-conditions you specified did not hold", 412);
    const modified = parseHttpDate(req.headers["x-amz-copy-source-if-modified-since"]); if (none === undefined && modified !== undefined && source.lastModified <= modified + 999) throw new AwsError("PreconditionFailed", "At least one of the pre-conditions you specified did not hold", 412);
    const unmodified = parseHttpDate(req.headers["x-amz-copy-source-if-unmodified-since"]); if (match === undefined && unmodified !== undefined && source.lastModified > unmodified + 999) throw new AwsError("PreconditionFailed", "At least one of the pre-conditions you specified did not hold", 412);
  }

  private async copyObject(req: IncomingMessage, res: ServerResponse, _url: URL, destination: LocatedBucket, destinationIndex: S3BucketIndex, destinationKey: string): Promise<void> {
    const source = this.parseCopySource(req); const sourceIndex = await this.bucketIndex(source.located); const selected = selectObject(sourceIndex, source.key, source.versionId); this.enforceCopyConditions(req, selected.version); requireCustomerKey(req, selected.version, true); this.ensureArchiveReadable(selected.version);
    if (!source.versionId && source.located.bucket.name === destination.bucket.name && source.key === destinationKey && String(req.headers["x-amz-metadata-directive"] ?? "COPY").toUpperCase() !== "REPLACE" && String(req.headers["x-amz-tagging-directive"] ?? "COPY").toUpperCase() !== "REPLACE" && !req.headers["x-amz-storage-class"] && !req.headers["x-amz-checksum-algorithm"]) throw new AwsError("InvalidRequest", "This copy request is illegal because it is trying to copy an object to itself without changing metadata, tags, storage class, or encryption attributes.", 400);
    const staged = await this.storage.stageFromBlobs([selected.version.blobId!], this.maximumObjectBytes);
    try { await this.ensureCapacity(destination, destinationIndex, destinationKey, staged.size); const blobId = await this.storage.publish(staged); const object = this.objectState(req, destination.bucket, staged, blobId, selected.version); publishVersion(destination.bucket, destinationIndex, destinationKey, object); await this.saveBucket(destination, destinationIndex); await this.enqueueObjectEvent(destination, destinationIndex, destinationKey, object, "s3:ObjectCreated:Copy", {}, this.notificationCaller(req)); res.statusCode = 200; res.setHeader("content-type", "application/xml"); setObjectHeaders(res, object); if (selected.version.versionId !== "null") res.setHeader("x-amz-copy-source-version-id", selected.version.versionId); if (object.versionId !== "null") res.setHeader("x-amz-version-id", object.versionId); const algorithm = activeChecksum(object)!; res.end(restXml(`<LastModified>${iso(object.lastModified)}</LastModified><ETag>${xmlEscape(quotedEtag(object.etag))}</ETag><Checksum${algorithm}>${xmlEscape(object.checksums[algorithm]!)}</Checksum${algorithm}><ChecksumType>FULL_OBJECT</ChecksumType>`, "CopyObjectResult")); }
    catch (error) { await this.storage.discardStaged(staged); throw error; }
  }

  private async streamBlob(res: ServerResponse, blobId: string, start: number, end: number): Promise<void> {
    let offset = 0;
    for await (const chunk of this.storage.readBlob(blobId)) {
      if (res.destroyed) return; const chunkStart = offset; const chunkEnd = offset + chunk.length - 1; offset += chunk.length; if (chunkEnd < start) continue; if (chunkStart > end) break; const from = Math.max(0, start - chunkStart); const to = Math.min(chunk.length, end - chunkStart + 1); if (to > from && !res.write(chunk.subarray(from, to))) await once(res, "drain");
    }
    res.end();
  }

  private async getObject(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string, head: boolean): Promise<void> {
    const located = this.requireBucket(bucketName); const index = await this.bucketIndex(located); const selected = selectObject(index, key, url.searchParams.get("versionId")); const object = selected.version; requireCustomerKey(req, object); this.refreshRestore(object); if (!head) this.ensureArchiveReadable(object); if (enforceReadConditions(req, object) === "not-modified") { res.statusCode = 304; setObjectHeaders(res, object); res.end(); return; }
    let selectedRange: { start: number; end: number } | undefined; const partNumberValue = url.searchParams.get("partNumber");
    if (partNumberValue !== null) {
      const partNumber = Number(partNumberValue); if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw new AwsError("InvalidArgument", "Part number must be an integer between 1 and 10000", 400); if (req.headers.range) throw new AwsError("InvalidRequest", "Cannot specify both Range and partNumber", 400);
      const parts = object.parts ?? [{ partNumber: 1, size: object.size } as S3ObjectPartState]; const partIndex = parts.findIndex(part => part.partNumber === partNumber); if (partIndex < 0) throw new AwsError("InvalidPartNumber", "The requested partnumber is not satisfiable", 416); const start = parts.slice(0, partIndex).reduce((sum, part) => sum + part.size, 0); selectedRange = { start, end: start + parts[partIndex].size - 1 }; res.setHeader("x-amz-mp-parts-count", String(parts.length));
    } else selectedRange = rangeFor(req.headers.range, object.size);
    const start = selectedRange?.start ?? 0; const end = selectedRange?.end ?? Math.max(0, object.size - 1); const length = object.size === 0 ? 0 : end - start + 1; setObjectHeaders(res, object, !selectedRange && String(req.headers["x-amz-checksum-mode"] ?? "").toUpperCase() === "ENABLED");
    const overrides: Record<string, string> = { "response-content-type": "content-type", "response-content-language": "content-language", "response-expires": "expires", "response-cache-control": "cache-control", "response-content-disposition": "content-disposition", "response-content-encoding": "content-encoding" }; for (const [query, header] of Object.entries(overrides)) if (url.searchParams.has(query)) res.setHeader(header, url.searchParams.get(query)!);
    res.statusCode = selectedRange ? 206 : 200; res.setHeader("content-length", String(length)); if (selectedRange) res.setHeader("content-range", `bytes ${start}-${end}/${object.size}`); if (head || object.size === 0) { res.end(); return; } await this.streamBlob(res, object.blobId!, start, end);
  }

  private async deleteObject(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const located = this.requireBucket(bucketName); await this.locked(located, async () => { const index = await this.bucketIndex(located); const versionId = url.searchParams.get("versionId"); const versions = index.objects[key] ?? [];
      const conditionalTarget = versionId === null ? versions[0] : versions.find(version => version.versionId === versionId); if (req.headers["if-match"] !== undefined) enforceWriteConditions(req, conditionalTarget);
      let eventObject: S3ObjectVersionState | undefined;
      if (versionId !== null) { const position = versions.findIndex(version => version.versionId === versionId); if (position < 0) throw new AwsError("NoSuchVersion", "The specified version does not exist.", 404); const target = versions[position]; this.enforceDeletionLock(req, target); const [removed] = versions.splice(position, 1); eventObject = removed; if (!versions.length) delete index.objects[key]; if (removed.deleteMarker) res.setHeader("x-amz-delete-marker", "true"); res.setHeader("x-amz-version-id", removed.versionId); }
      else if (located.bucket.versioning === "enabled") { const now = this.clock.now(); if (versions[0]) versions[0].noncurrentSince ??= now; const marker: S3ObjectVersionState = { versionId: randomUUID(), deleteMarker: true, size: 0, etag: "", lastModified: now, metadata: {}, checksums: {}, storageClass: "STANDARD", encryption: "AES256", ownerAccountId: located.accountId, ownerId: ownerId(located.accountId), acl: privateAcl(located.accountId) }; eventObject = marker; index.objects[key] = [marker, ...versions]; res.setHeader("x-amz-delete-marker", "true"); res.setHeader("x-amz-version-id", marker.versionId); }
      else if (located.bucket.versioning === "suspended") { const now = this.clock.now(); if (versions[0] && versions[0].versionId !== "null") versions[0].noncurrentSince ??= now; const marker: S3ObjectVersionState = { versionId: "null", deleteMarker: true, size: 0, etag: "", lastModified: now, metadata: {}, checksums: {}, storageClass: "STANDARD", encryption: "AES256", ownerAccountId: located.accountId, ownerId: ownerId(located.accountId), acl: privateAcl(located.accountId) }; eventObject = marker; index.objects[key] = [marker, ...versions.filter(version => version.versionId !== "null")]; res.setHeader("x-amz-delete-marker", "true"); res.setHeader("x-amz-version-id", "null"); }
      else { const target = versions[0]; if (target) this.enforceDeletionLock(req, target); eventObject = target; delete index.objects[key]; } await this.saveBucket(located, index); await this.enqueueObjectEvent(located, index, key, eventObject, eventObject?.deleteMarker ? "s3:ObjectRemoved:DeleteMarkerCreated" : "s3:ObjectRemoved:Delete", {}, this.notificationCaller(req));
    }); res.statusCode = 204; res.end();
  }

  private async listObjectVersions(res: ServerResponse, url: URL, bucketName: string): Promise<void> {
    const located = this.requireBucket(bucketName); const index = await this.bucketIndex(located); const prefix = url.searchParams.get("prefix") ?? ""; const delimiter = url.searchParams.get("delimiter") ?? ""; const encodingType = url.searchParams.get("encoding-type"); const maximum = url.searchParams.has("max-keys") ? Number(url.searchParams.get("max-keys")) : 1_000;
    if (!Number.isInteger(maximum) || maximum < 0 || maximum > 1_000) throw new AwsError("InvalidArgument", "Invalid max-keys value", 400);
    const entries: Array<{ type: "version" | "prefix"; key: string; version?: S3ObjectVersionState; isLatest?: boolean }> = []; const common = new Set<string>();
    for (const key of Object.keys(index.objects).filter(key => key.startsWith(prefix)).sort(utf8Compare)) {
      const remainder = key.slice(prefix.length); const boundary = delimiter ? remainder.indexOf(delimiter) : -1;
      if (boundary >= 0) { const value = `${prefix}${remainder.slice(0, boundary + delimiter.length)}`; if (!common.has(value)) { common.add(value); entries.push({ type: "prefix", key: value }); } continue; }
      index.objects[key].forEach((version, position) => entries.push({ type: "version", key, version, isLatest: position === 0 }));
    }
    const keyMarker = url.searchParams.get("key-marker"); const versionMarker = url.searchParams.get("version-id-marker"); let offset = 0;
    if (versionMarker && !keyMarker) throw new AwsError("InvalidArgument", "A version-id marker cannot be specified without a key marker.", 400);
    if (versionMarker) { try { const cursor = this.pagination.decode<{ bucket: string; prefix: string; delimiter: string; key: string; versionId: string; offset: number }>("s3:ListObjectVersions", versionMarker); if (cursor.bucket !== bucketName || cursor.prefix !== prefix || cursor.delimiter !== delimiter || cursor.key !== keyMarker || !Number.isInteger(cursor.offset) || cursor.offset < 0) throw new Error(); offset = cursor.offset; } catch { throw new AwsError("InvalidArgument", "The version-id marker provided is incorrect", 400); } }
    else if (keyMarker) { offset = entries.findIndex(entry => utf8Compare(entry.key, keyMarker) > 0); if (offset < 0) offset = entries.length; }
    const page = entries.slice(offset, offset + maximum); const truncated = offset + page.length < entries.length; const last = page.at(-1); const owner = `<Owner><ID>${ownerId(located.accountId)}</ID><DisplayName>${LOCAL_OWNER_DISPLAY_NAME}</DisplayName></Owner>`;
    const rows = page.map(entry => {
      if (entry.type === "prefix") return `<CommonPrefixes><Prefix>${encodeKey(entry.key, encodingType)}</Prefix></CommonPrefixes>`;
      const version = entry.version!; if (version.deleteMarker) return `<DeleteMarker><Key>${encodeKey(entry.key, encodingType)}</Key><VersionId>${xmlEscape(version.versionId)}</VersionId><IsLatest>${entry.isLatest}</IsLatest><LastModified>${iso(version.lastModified)}</LastModified>${owner}</DeleteMarker>`;
      return `<Version><Key>${encodeKey(entry.key, encodingType)}</Key><VersionId>${xmlEscape(version.versionId)}</VersionId><IsLatest>${entry.isLatest}</IsLatest><LastModified>${iso(version.lastModified)}</LastModified><ETag>${xmlEscape(quotedEtag(version.etag))}</ETag>${activeChecksum(version) ? `<ChecksumAlgorithm>${activeChecksum(version)}</ChecksumAlgorithm><ChecksumType>${version.checksumType ?? "FULL_OBJECT"}</ChecksumType>` : ""}<Size>${version.size}</Size><StorageClass>${version.storageClass}</StorageClass>${owner}</Version>`;
    }).join("");
    const nextVersionMarker = truncated && last?.version ? this.pagination.encode("s3:ListObjectVersions", { bucket: bucketName, prefix, delimiter, key: last.key, versionId: last.version.versionId, offset: offset + page.length }) : undefined; const body = `<Name>${xmlEscape(bucketName)}</Name><Prefix>${encodeKey(prefix, encodingType)}</Prefix>${keyMarker ? `<KeyMarker>${encodeKey(keyMarker, encodingType)}</KeyMarker>` : ""}${versionMarker ? `<VersionIdMarker>${xmlEscape(versionMarker)}</VersionIdMarker>` : ""}${truncated && last ? `<NextKeyMarker>${encodeKey(last.key, encodingType)}</NextKeyMarker>${nextVersionMarker ? `<NextVersionIdMarker>${xmlEscape(nextVersionMarker)}</NextVersionIdMarker>` : ""}` : ""}${delimiter ? `<Delimiter>${encodeKey(delimiter, encodingType)}</Delimiter>` : ""}<MaxKeys>${maximum}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${encodingType ? `<EncodingType>${xmlEscape(encodingType)}</EncodingType>` : ""}${rows}`;
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(body, "ListVersionsResult"));
  }

  private deleteFromIndex(req: IncomingMessage, bucket: S3BucketState, index: S3BucketIndex, key: string, versionId?: string): { deleteMarker?: boolean; versionId?: string; object?: S3ObjectVersionState } {
    const versions = index.objects[key] ?? [];
    if (versionId !== undefined) { const position = versions.findIndex(version => version.versionId === versionId); if (position < 0) throw new AwsError("NoSuchVersion", "The specified version does not exist.", 404); this.enforceDeletionLock(req, versions[position]); const [removed] = versions.splice(position, 1); if (!versions.length) delete index.objects[key]; return { deleteMarker: removed.deleteMarker, versionId: removed.versionId, object: removed }; }
    if (bucket.versioning === "enabled") { const now = this.clock.now(); if (versions[0]) versions[0].noncurrentSince ??= now; const marker: S3ObjectVersionState = { versionId: randomUUID(), deleteMarker: true, size: 0, etag: "", lastModified: now, metadata: {}, checksums: {}, storageClass: "STANDARD", encryption: "AES256", ownerAccountId: bucket.ownerAccountId, ownerId: ownerId(bucket.ownerAccountId), acl: privateAcl(bucket.ownerAccountId) }; index.objects[key] = [marker, ...versions]; return { deleteMarker: true, versionId: marker.versionId, object: marker }; }
    if (bucket.versioning === "suspended") { const now = this.clock.now(); if (versions[0] && versions[0].versionId !== "null") versions[0].noncurrentSince ??= now; const marker: S3ObjectVersionState = { versionId: "null", deleteMarker: true, size: 0, etag: "", lastModified: now, metadata: {}, checksums: {}, storageClass: "STANDARD", encryption: "AES256", ownerAccountId: bucket.ownerAccountId, ownerId: ownerId(bucket.ownerAccountId), acl: privateAcl(bucket.ownerAccountId) }; index.objects[key] = [marker, ...versions.filter(version => version.versionId !== "null")]; return { deleteMarker: true, versionId: "null", object: marker }; }
    if (versions[0]) this.enforceDeletionLock(req, versions[0]); const object = versions[0]; delete index.objects[key]; return { object };
  }

  private async deleteObjects(req: IncomingMessage, res: ServerResponse, bucketName: string): Promise<void> {
    const located = this.requireBucket(bucketName); const body = await readBody(req); if (body.length > 1024 * 1024) throw new AwsError("MalformedXML", "The XML document exceeds the maximum allowed size", 400); if (req.headers["content-md5"] === undefined && !providedChecksumAlgorithms(req.headers).length) throw new AwsError("InvalidRequest", "Content-MD5 or a supported checksum header is required for DeleteObjects", 400); const checksums = new S3Checksums(); await checksums.update(body); const digest = await checksums.digest(); validateProvidedChecksums(req.headers, {}, digest);
    const xml = body.toString("utf8"); const quiet = xmlValue(xml, "Quiet")?.toLowerCase() === "true"; const requested = [...xml.matchAll(/<Object(?:\s[^>]*)?>([\s\S]*?)<\/Object>/gi)].map(match => ({ key: xmlValue(match[1], "Key"), versionId: xmlValue(match[1], "VersionId") })); if (!requested.length && !/<Delete(?:\s|>)/i.test(xml)) throw new AwsError("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema", 400); if (requested.length > 1_000) throw new AwsError("MalformedXML", "You may delete at most 1000 keys per request", 400); if (requested.some(item => item.key === undefined)) throw new AwsError("MalformedXML", "Every delete entry must contain a Key", 400);
    const deleted: string[] = []; const errors: string[] = [];
    await this.locked(located, async () => { const index = await this.bucketIndex(located); const events: Array<{ key: string; result: ReturnType<S3Service["deleteFromIndex"]> }> = []; for (const item of requested) { try { const result = this.deleteFromIndex(req, located.bucket, index, item.key!, item.versionId); events.push({ key: item.key!, result }); if (!quiet) deleted.push(`<Deleted><Key>${xmlEscape(item.key)}</Key>${result.versionId ? `<VersionId>${xmlEscape(result.versionId)}</VersionId>` : ""}${result.deleteMarker ? `<DeleteMarker>true</DeleteMarker><DeleteMarkerVersionId>${xmlEscape(result.versionId)}</DeleteMarkerVersionId>` : ""}</Deleted>`); } catch (error) { const aws = error instanceof AwsError ? error : new AwsError("InternalError", String(error), 500); errors.push(`<Error><Key>${xmlEscape(item.key)}</Key>${item.versionId ? `<VersionId>${xmlEscape(item.versionId)}</VersionId>` : ""}<Code>${xmlEscape(aws.code)}</Code><Message>${xmlEscape(aws.message)}</Message></Error>`); } } await this.saveBucket(located, index); for (const event of events) await this.enqueueObjectEvent(located, index, event.key, event.result.object, event.result.deleteMarker ? "s3:ObjectRemoved:DeleteMarkerCreated" : "s3:ObjectRemoved:Delete", {}, this.notificationCaller(req)); });
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(`${deleted.join("")}${errors.join("")}`, "DeleteResult"));
  }

  private requireUpload(index: S3BucketIndex, key: string, uploadId: string): S3MultipartUploadState { const upload = index.multipartUploads[uploadId]; if (!upload || upload.key !== key) throw new AwsError("NoSuchUpload", "The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.", 404); return upload; }

  private requireUploadCustomerKey(req: IncomingMessage, upload: S3MultipartUploadState): void {
    if (!upload.sseCustomerKeyMd5) return;
    const supplied = customerEncryption(req);
    if (!supplied || supplied.md5 !== upload.sseCustomerKeyMd5) throw new AwsError("InvalidRequest", "The multipart upload requires the original SSE-C customer key", 400);
  }

  private async createMultipartUpload(req: IncomingMessage, res: ServerResponse, bucketName: string, key: string): Promise<void> {
    const located = this.requireBucket(bucketName); await this.locked(located, async () => { const index = await this.bucketIndex(located); const details = requestDetails(req); const access = this.writeAccess(req, located.bucket); const encryption = objectEncryption(req, located.bucket); const lock = this.writeLock(req, located.bucket); const uploadId = randomUUID(); const requestedAlgorithm = requestedChecksumAlgorithm(req.headers["x-amz-checksum-algorithm"] ?? req.headers["x-amz-sdk-checksum-algorithm"]); const algorithm = requestedAlgorithm ?? "CRC32"; const checksumType = String(req.headers["x-amz-checksum-type"] ?? (!requestedAlgorithm || algorithm === "CRC64NVME" ? "FULL_OBJECT" : "COMPOSITE")).toUpperCase(); if (!["COMPOSITE", "FULL_OBJECT"].includes(checksumType)) throw new AwsError("InvalidRequest", "Invalid checksum type", 400); if (checksumType === "FULL_OBJECT" && !["CRC32", "CRC32C", "CRC64NVME"].includes(algorithm)) throw new AwsError("InvalidRequest", `${algorithm} does not support full-object multipart checksums`, 400); if (checksumType === "COMPOSITE" && algorithm === "CRC64NVME") throw new AwsError("InvalidRequest", "CRC64NVME does not support composite multipart checksums", 400); index.multipartUploads[uploadId] = { uploadId, key, initiatedAt: this.clock.now(), ...details, ...access, ...encryption, ...lock, checksumAlgorithm: algorithm, checksumType: checksumType as "COMPOSITE" | "FULL_OBJECT", parts: {} }; await this.saveBucket(located, index); res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.setHeader("x-amz-server-side-encryption", encryption.encryption); res.end(restXml(`<Bucket>${xmlEscape(bucketName)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${xmlEscape(uploadId)}</UploadId><ChecksumAlgorithm>${algorithm}</ChecksumAlgorithm><ChecksumType>${checksumType}</ChecksumType>`, "InitiateMultipartUploadResult")); });
  }

  private async *blobSlice(blobId: string, start: number, end: number): AsyncGenerator<Buffer> {
    let offset = 0; for await (const chunk of this.storage.readBlob(blobId)) { const chunkStart = offset; const chunkEnd = offset + chunk.length - 1; offset += chunk.length; if (chunkEnd < start) continue; if (chunkStart > end) return; const from = Math.max(0, start - chunkStart); const to = Math.min(chunk.length, end - chunkStart + 1); if (to > from) yield chunk.subarray(from, to); }
  }

  private async uploadPart(req: IncomingMessage, res: ServerResponse, bucketName: string, key: string, uploadId: string, partNumberText: string): Promise<void> {
    const partNumber = Number(partNumberText); if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw new AwsError("InvalidArgument", "Part number must be an integer between 1 and 10000", 400); const located = this.requireBucket(bucketName);
    await this.locked(located, async () => { const index = await this.bucketIndex(located); const upload = this.requireUpload(index, key, uploadId); let staged: StagedS3Object; let copySource: SelectedObject | undefined; let copySourceMetadata: S3ObjectPartState["copySource"];
      this.requireUploadCustomerKey(req, upload);
      if (req.headers["x-amz-copy-source"]) { const source = this.parseCopySource(req); const sourceIndex = await this.bucketIndex(source.located); copySource = selectObject(sourceIndex, source.key, source.versionId); this.enforceCopyConditions(req, copySource.version); requireCustomerKey(req, copySource.version, true); this.ensureArchiveReadable(copySource.version); const range = rangeFor(req.headers["x-amz-copy-source-range"], copySource.version.size) ?? { start: 0, end: Math.max(0, copySource.version.size - 1) }; copySourceMetadata = { bucket: source.located.bucket.name, key: source.key, versionId: copySource.version.versionId, range: req.headers["x-amz-copy-source-range"]?.toString() }; staged = await this.storage.stageIterable(this.blobSlice(copySource.version.blobId!, range.start, range.end), Math.min(this.maximumObjectBytes, 5 * 1024 * 1024 * 1024)); }
      else staged = await this.storage.stageRequest(req, Math.min(this.maximumObjectBytes, 5 * 1024 * 1024 * 1024));
      try { const declared = requestedChecksumAlgorithm(req.headers["x-amz-checksum-algorithm"] ?? req.headers["x-amz-sdk-checksum-algorithm"]); const provided = providedChecksumAlgorithms(req.headers, staged.trailers); if (declared && declared !== upload.checksumAlgorithm || provided.some(algorithm => algorithm !== upload.checksumAlgorithm)) throw new AwsError("InvalidRequest", "The checksum algorithm must match the algorithm specified when the multipart upload was initiated", 400); if (!copySource && upload.checksumType === "COMPOSITE" && !provided.includes(upload.checksumAlgorithm!)) throw new AwsError("InvalidRequest", `A ${upload.checksumAlgorithm} part checksum is required for this multipart upload`, 400); const blobId = await this.storage.publish(staged); const part: S3ObjectPartState = { partNumber, size: staged.size, etag: staged.digest.etag, blobId, lastModified: this.clock.now(), checksums: staged.digest.values, copySource: copySourceMetadata }; upload.parts[String(partNumber)] = part; await this.saveBucket(located, index); res.statusCode = 200; res.setHeader("etag", quotedEtag(part.etag)); if (upload.checksumAlgorithm) res.setHeader(checksumHeaderName(upload.checksumAlgorithm), part.checksums[upload.checksumAlgorithm]!); if (copySource) { if (copySource.version.versionId !== "null") res.setHeader("x-amz-copy-source-version-id", copySource.version.versionId); res.setHeader("content-type", "application/xml"); res.end(restXml(`<LastModified>${iso(part.lastModified)}</LastModified><ETag>${xmlEscape(quotedEtag(part.etag))}</ETag>${upload.checksumAlgorithm ? `<Checksum${upload.checksumAlgorithm}>${xmlEscape(part.checksums[upload.checksumAlgorithm])}</Checksum${upload.checksumAlgorithm}>` : ""}`, "CopyPartResult")); } else res.end(); }
      catch (error) { await this.storage.discardStaged(staged); throw error; }
    });
  }

  private async listParts(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string, uploadId: string): Promise<void> {
    const located = this.requireBucket(bucketName); const index = await this.bucketIndex(located); const upload = this.requireUpload(index, key, uploadId); this.requireUploadCustomerKey(req, upload); const marker = Number(url.searchParams.get("part-number-marker") ?? 0); const maximum = Number(url.searchParams.get("max-parts") ?? 1_000); if (!Number.isInteger(marker) || marker < 0 || !Number.isInteger(maximum) || maximum < 0 || maximum > 1_000) throw new AwsError("InvalidArgument", "Invalid part listing marker or maximum", 400); const all = Object.values(upload.parts).sort((left, right) => left.partNumber - right.partNumber).filter(part => part.partNumber > marker); const parts = all.slice(0, maximum); const truncated = parts.length < all.length;
    const rows = parts.map(part => `<Part><PartNumber>${part.partNumber}</PartNumber><LastModified>${iso(part.lastModified)}</LastModified><ETag>${xmlEscape(quotedEtag(part.etag))}</ETag>${upload.checksumAlgorithm ? `<Checksum${upload.checksumAlgorithm}>${xmlEscape(part.checksums[upload.checksumAlgorithm])}</Checksum${upload.checksumAlgorithm}>` : ""}<Size>${part.size}</Size></Part>`).join(""); const owner = `<ID>${ownerId(located.accountId)}</ID><DisplayName>${LOCAL_OWNER_DISPLAY_NAME}</DisplayName>`;
    const body = `<Bucket>${xmlEscape(bucketName)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${xmlEscape(uploadId)}</UploadId><Initiator>${owner}</Initiator><Owner>${owner}</Owner><StorageClass>${upload.storageClass}</StorageClass><PartNumberMarker>${marker}</PartNumberMarker>${truncated ? `<NextPartNumberMarker>${parts.at(-1)!.partNumber}</NextPartNumberMarker>` : ""}<MaxParts>${maximum}</MaxParts><IsTruncated>${truncated}</IsTruncated>${upload.checksumAlgorithm ? `<ChecksumAlgorithm>${upload.checksumAlgorithm}</ChecksumAlgorithm><ChecksumType>${upload.checksumType}</ChecksumType>` : ""}${rows}`;
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(body, "ListPartsResult"));
  }

  private async listMultipartUploads(res: ServerResponse, url: URL, bucketName: string): Promise<void> {
    const located = this.requireBucket(bucketName); const index = await this.bucketIndex(located); const prefix = url.searchParams.get("prefix") ?? ""; const delimiter = url.searchParams.get("delimiter") ?? ""; const encodingType = url.searchParams.get("encoding-type"); const maximum = Number(url.searchParams.get("max-uploads") ?? 1_000); if (!Number.isInteger(maximum) || maximum < 0 || maximum > 1_000) throw new AwsError("InvalidArgument", "Invalid max-uploads value", 400);
    const entries: Array<{ type: "upload" | "prefix"; key: string; upload?: S3MultipartUploadState }> = []; const common = new Set<string>(); for (const upload of Object.values(index.multipartUploads).filter(upload => upload.key.startsWith(prefix)).sort((left, right) => utf8Compare(left.key, right.key) || left.uploadId.localeCompare(right.uploadId))) { const remainder = upload.key.slice(prefix.length); const boundary = delimiter ? remainder.indexOf(delimiter) : -1; if (boundary >= 0) { const value = `${prefix}${remainder.slice(0, boundary + delimiter.length)}`; if (!common.has(value)) { common.add(value); entries.push({ type: "prefix", key: value }); } } else entries.push({ type: "upload", key: upload.key, upload }); }
    const keyMarker = url.searchParams.get("key-marker"); const uploadMarker = url.searchParams.get("upload-id-marker"); let offset = 0; if (keyMarker) { const exact = entries.findIndex(entry => entry.key === keyMarker && (!uploadMarker || entry.upload?.uploadId === uploadMarker)); offset = exact >= 0 ? exact + 1 : entries.findIndex(entry => utf8Compare(entry.key, keyMarker) > 0); if (offset < 0) offset = entries.length; } const page = entries.slice(offset, offset + maximum); const truncated = offset + page.length < entries.length; const last = page.at(-1); const owner = `<ID>${ownerId(located.accountId)}</ID><DisplayName>${LOCAL_OWNER_DISPLAY_NAME}</DisplayName>`;
    const rows = page.map(entry => entry.type === "prefix" ? `<CommonPrefixes><Prefix>${encodeKey(entry.key, encodingType)}</Prefix></CommonPrefixes>` : `<Upload><Key>${encodeKey(entry.key, encodingType)}</Key><UploadId>${xmlEscape(entry.upload!.uploadId)}</UploadId><Initiator>${owner}</Initiator><Owner>${owner}</Owner><StorageClass>${entry.upload!.storageClass}</StorageClass><Initiated>${iso(entry.upload!.initiatedAt)}</Initiated>${entry.upload!.checksumAlgorithm ? `<ChecksumAlgorithm>${entry.upload!.checksumAlgorithm}</ChecksumAlgorithm><ChecksumType>${entry.upload!.checksumType}</ChecksumType>` : ""}</Upload>`).join("");
    const body = `<Bucket>${xmlEscape(bucketName)}</Bucket>${keyMarker ? `<KeyMarker>${encodeKey(keyMarker, encodingType)}</KeyMarker>` : ""}${uploadMarker ? `<UploadIdMarker>${xmlEscape(uploadMarker)}</UploadIdMarker>` : ""}${truncated && last ? `<NextKeyMarker>${encodeKey(last.key, encodingType)}</NextKeyMarker>${last.upload ? `<NextUploadIdMarker>${xmlEscape(last.upload.uploadId)}</NextUploadIdMarker>` : ""}` : ""}${delimiter ? `<Delimiter>${encodeKey(delimiter, encodingType)}</Delimiter>` : ""}<Prefix>${encodeKey(prefix, encodingType)}</Prefix>${encodingType ? `<EncodingType>${xmlEscape(encodingType)}</EncodingType>` : ""}<MaxUploads>${maximum}</MaxUploads><IsTruncated>${truncated}</IsTruncated>${rows}`;
    res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(body, "ListMultipartUploadsResult"));
  }

  private async completeMultipartUpload(req: IncomingMessage, res: ServerResponse, bucketName: string, key: string, uploadId: string): Promise<void> {
    const located = this.requireBucket(bucketName); await this.locked(located, async () => { const index = await this.bucketIndex(located); const upload = this.requireUpload(index, key, uploadId); this.requireUploadCustomerKey(req, upload); const xml = (await readBody(req)).toString("utf8"); const requested = [...xml.matchAll(/<Part(?:\s[^>]*)?>([\s\S]*?)<\/Part>/gi)].map(match => ({ partNumber: Number(xmlValue(match[1], "PartNumber")), etag: cleanEtag(xmlValue(match[1], "ETag") ?? ""), body: match[1] })); if (!requested.length || requested.length > 10_000 || requested.some((part, index) => !Number.isInteger(part.partNumber) || part.partNumber !== index + 1)) throw new AwsError("InvalidPartOrder", "The list of parts was not in ascending order. Parts must be ordered by part number.", 400); const parts = requested.map(requestedPart => { const stored = upload.parts[String(requestedPart.partNumber)]; if (!stored || stored.etag !== requestedPart.etag) throw new AwsError("InvalidPart", "One or more of the specified parts could not be found.", 400); if (upload.checksumAlgorithm) { const supplied = xmlValue(requestedPart.body, `Checksum${upload.checksumAlgorithm}`); if (upload.checksumType === "COMPOSITE" && !supplied) throw new AwsError("InvalidPart", `Part ${requestedPart.partNumber} is missing its ${upload.checksumAlgorithm} checksum`, 400); if (supplied && supplied !== stored.checksums[upload.checksumAlgorithm]) throw new AwsError("BadDigest", "A multipart part checksum did not match the uploaded part.", 400); } return stored; }); if (parts.slice(0, -1).some(part => part.size < MIN_MULTIPART_PART_SIZE)) throw new AwsError("EntityTooSmall", "Your proposed upload is smaller than the minimum allowed object size.", 400);
      const suppliedType = req.headers["x-amz-checksum-type"]?.toString().toUpperCase(); if (suppliedType && suppliedType !== upload.checksumType) throw new AwsError("BadDigest", "The checksum type does not match the multipart upload", 400); const suppliedAlgorithm = requestedChecksumAlgorithm(req.headers["x-amz-checksum-algorithm"]); if (suppliedAlgorithm && suppliedAlgorithm !== upload.checksumAlgorithm) throw new AwsError("BadDigest", "The checksum algorithm does not match the multipart upload", 400); const expectedSize = req.headers["x-amz-mp-object-size"] === undefined ? undefined : Number(req.headers["x-amz-mp-object-size"]); const actualSize = parts.reduce((sum, part) => sum + part.size, 0); if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize !== actualSize)) throw new AwsError("InvalidRequest", "The expected multipart object size does not match the completed object", 400);
      const staged = await this.storage.stageFromBlobs(parts.map(part => part.blobId), this.maximumObjectBytes); try { const algorithm = upload.checksumAlgorithm!; const checksum = upload.checksumType === "COMPOSITE" ? await compositeChecksum(algorithm, parts) : staged.digest.values[algorithm]!; const suppliedObjectChecksum = req.headers[checksumHeaderName(algorithm)]?.toString(); if (suppliedObjectChecksum && suppliedObjectChecksum !== checksum) throw new AwsError("BadDigest", `The ${algorithm} checksum you specified did not match the completed object`, 400); const released = Object.values(upload.parts).reduce((sum, part) => sum + part.size, 0); await this.ensureCapacity(located, index, key, staged.size, released); const blobId = await this.storage.publish(staged); const multipartEtag = `${createHash("md5").update(Buffer.concat(parts.map(part => Buffer.from(part.etag, "hex")))).digest("hex")}-${parts.length}`; const object: S3ObjectVersionState = { versionId: versionIdForWrite(located.bucket), blobId, size: staged.size, etag: multipartEtag, lastModified: this.clock.now(), metadata: structuredClone(upload.metadata), tags: structuredClone(upload.tags ?? {}), contentType: upload.contentType, contentEncoding: upload.contentEncoding, contentDisposition: upload.contentDisposition, contentLanguage: upload.contentLanguage, cacheControl: upload.cacheControl, expires: upload.expires, websiteRedirectLocation: upload.websiteRedirectLocation, checksums: { [algorithm]: checksum }, checksumAlgorithm: algorithm, checksumType: upload.checksumType ?? "COMPOSITE", storageClass: upload.storageClass, encryption: upload.encryption ?? "AES256", kmsKeyId: upload.kmsKeyId, bucketKeyEnabled: upload.bucketKeyEnabled, sseCustomerKeyMd5: upload.sseCustomerKeyMd5, retention: upload.retention, legalHold: upload.legalHold, ownerAccountId: upload.ownerAccountId ?? located.accountId, ownerId: upload.ownerId ?? ownerId(located.accountId), acl: upload.acl ?? privateAcl(upload.ownerAccountId ?? located.accountId), parts }; publishVersion(located.bucket, index, key, object); delete index.multipartUploads[uploadId]; await this.saveBucket(located, index); await this.enqueueObjectEvent(located, index, key, object, "s3:ObjectCreated:CompleteMultipartUpload", {}, this.notificationCaller(req)); res.statusCode = 200; res.setHeader("content-type", "application/xml"); setObjectHeaders(res, object); if (object.versionId !== "null") res.setHeader("x-amz-version-id", object.versionId); res.setHeader(checksumHeaderName(algorithm), checksum); res.end(restXml(`<Location>http://localhost/${xmlEscape(bucketName)}/${xmlEscape(key)}</Location><Bucket>${xmlEscape(bucketName)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(quotedEtag(object.etag))}</ETag><Checksum${algorithm}>${xmlEscape(object.checksums[algorithm]!)}</Checksum${algorithm}><ChecksumType>${object.checksumType}</ChecksumType>`, "CompleteMultipartUploadResult")); }
      catch (error) { await this.storage.discardStaged(staged); throw error; }
    });
  }

  private async abortMultipartUpload(res: ServerResponse, bucketName: string, key: string, uploadId: string): Promise<void> { const located = this.requireBucket(bucketName); await this.locked(located, async () => { const index = await this.bucketIndex(located); this.requireUpload(index, key, uploadId); delete index.multipartUploads[uploadId]; await this.saveBucket(located, index); }); res.statusCode = 204; res.end(); }

  private async getObjectAttributes(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const located = this.requireBucket(bucketName); const index = await this.bucketIndex(located); const object = selectObject(index, key, url.searchParams.get("versionId")).version; requireCustomerKey(req, object); setObjectHeaders(res, object, true); const requested = new Set(String(req.headers["x-amz-object-attributes"] ?? "ETag,Checksum,ObjectParts,StorageClass,ObjectSize").split(",").map(value => value.trim())); const parts = object.parts ?? []; const marker = Number(req.headers["x-amz-part-number-marker"] ?? url.searchParams.get("part-number-marker") ?? 0); const maximum = Number(req.headers["x-amz-max-parts"] ?? url.searchParams.get("max-parts") ?? 1_000); if (!Number.isInteger(marker) || marker < 0 || !Number.isInteger(maximum) || maximum < 0 || maximum > 1_000) throw new AwsError("InvalidArgument", "Invalid object-parts marker or maximum", 400); const remaining = parts.filter(part => part.partNumber > marker); const page = remaining.slice(0, maximum); const truncated = remaining.length > page.length; const algorithm = activeChecksum(object); const checksum = algorithm ? `<Checksum${algorithm}>${xmlEscape(object.checksums[algorithm]!)}</Checksum${algorithm}><ChecksumType>${object.checksumType ?? "FULL_OBJECT"}</ChecksumType>` : ""; const partRows = page.map(part => `<Part><PartNumber>${part.partNumber}</PartNumber><Size>${part.size}</Size>${algorithm && part.checksums[algorithm] ? `<Checksum${algorithm}>${xmlEscape(part.checksums[algorithm]!)}</Checksum${algorithm}>` : ""}</Part>`).join("");
    const body = `${requested.has("ETag") ? `<ETag>${xmlEscape(quotedEtag(object.etag))}</ETag>` : ""}${requested.has("Checksum") ? `<Checksum>${checksum}</Checksum>` : ""}${requested.has("ObjectParts") ? `<ObjectParts><PartsCount>${parts.length}</PartsCount><PartNumberMarker>${marker}</PartNumberMarker>${truncated ? `<NextPartNumberMarker>${page.at(-1)!.partNumber}</NextPartNumberMarker>` : ""}<MaxParts>${maximum}</MaxParts><IsTruncated>${truncated}</IsTruncated>${partRows}</ObjectParts>` : ""}${requested.has("StorageClass") ? `<StorageClass>${object.storageClass}</StorageClass>` : ""}${requested.has("ObjectSize") ? `<ObjectSize>${object.size}</ObjectSize>` : ""}`; res.statusCode = 200; res.setHeader("content-type", "application/xml"); res.end(restXml(body, "GetObjectAttributesOutput"));
  }

  private bencodeString(value: string | Buffer): Buffer { const body = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([Buffer.from(`${body.length}:`), body]); }

  private async getObjectTorrent(req: IncomingMessage, res: ServerResponse, url: URL, bucketName: string, key: string): Promise<void> {
    const located = this.requireBucket(bucketName); const index = await this.bucketIndex(located); const object = selectObject(index, key, url.searchParams.get("versionId")).version; requireCustomerKey(req, object); this.ensureArchiveReadable(object); const pieceLength = 256 * 1024; const hashes: Buffer[] = []; let pending = Buffer.alloc(0);
    for await (const chunk of this.storage.readBlob(object.blobId!)) { pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk); while (pending.length >= pieceLength) { hashes.push(createHash("sha1").update(pending.subarray(0, pieceLength)).digest()); pending = Buffer.from(pending.subarray(pieceLength)); } } if (pending.length || object.size === 0) hashes.push(createHash("sha1").update(pending).digest());
    const info = Buffer.concat([Buffer.from("d6:length"), Buffer.from(`i${object.size}e`), Buffer.from("4:name"), this.bencodeString(key), Buffer.from("12:piece length"), Buffer.from(`i${pieceLength}e`), Buffer.from("6:pieces"), this.bencodeString(Buffer.concat(hashes)), Buffer.from("e")]); const torrent = Buffer.concat([Buffer.from("d8:announce0:4:info"), info, Buffer.from("e")]); res.statusCode = 200; res.setHeader("content-type", "application/x-bittorrent"); res.setHeader("content-length", String(torrent.length)); res.end(torrent);
  }
}
