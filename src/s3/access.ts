import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { AwsError } from "../errors.js";
import type { PolicyDocument, PolicyStatement, S3AccessControlGrantState, S3AccessControlListState, S3BucketState } from "../types.js";
import type { S3ObjectVersionState } from "./storage.js";

export const ALL_USERS = "http://acs.amazonaws.com/groups/global/AllUsers";
export const AUTHENTICATED_USERS = "http://acs.amazonaws.com/groups/global/AuthenticatedUsers";
export const LOG_DELIVERY = "http://acs.amazonaws.com/groups/s3/LogDelivery";
export const LOCAL_OWNER_DISPLAY_NAME = "Local AWS account";
const SUPPORTED_GROUPS = new Set([ALL_USERS, AUTHENTICATED_USERS, LOG_DELIVERY]);
const PERMISSIONS = new Set(["FULL_CONTROL", "READ", "WRITE", "READ_ACP", "WRITE_ACP"]);

export interface S3PublicAccessBlockState {
  blockPublicAcls: boolean;
  ignorePublicAcls: boolean;
  blockPublicPolicy: boolean;
  restrictPublicBuckets: boolean;
}

export function canonicalOwnerId(accountId: string): string {
  // Persisted owner-ID input. Keep the legacy value so existing ACL ownership remains stable.
  return createHash("sha256").update(`stacksim-s3-owner:${accountId}`).digest("hex");
}

export function privateAcl(accountId: string): S3AccessControlListState {
  const id = canonicalOwnerId(accountId);
  return {
    ownerId: id,
    ownerDisplayName: LOCAL_OWNER_DISPLAY_NAME,
    grants: [{ grantee: { type: "CanonicalUser", id, displayName: LOCAL_OWNER_DISPLAY_NAME }, permission: "FULL_CONTROL" }],
  };
}

export function effectivePublicAccessBlock(bucket: S3BucketState, account?: Partial<S3PublicAccessBlockState>): S3PublicAccessBlockState {
  const local = bucket.publicAccessBlock;
  return {
    blockPublicAcls: local?.blockPublicAcls === true || account?.blockPublicAcls === true,
    ignorePublicAcls: local?.ignorePublicAcls === true || account?.ignorePublicAcls === true,
    blockPublicPolicy: local?.blockPublicPolicy === true || account?.blockPublicPolicy === true,
    restrictPublicBuckets: local?.restrictPublicBuckets === true || account?.restrictPublicBuckets === true,
  };
}

function values(value: unknown): unknown[] { return Array.isArray(value) ? value : value === undefined ? [] : [value]; }
function xmlEscape(value: string): string { return value.replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" })[character]!); }
function xmlDecode(value: string): string { return value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity]!); }
function xmlValue(xml: string, name: string): string | undefined { const value = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"))?.[1]; return value === undefined ? undefined : xmlDecode(value.trim()); }

function conditionMakesPrincipalNonPublic(statement: PolicyStatement): boolean {
  if (!statement.Condition) return false;
  const trusted = new Set(["aws:principalaccount", "aws:principalorgid", "aws:sourceaccount", "aws:sourcearn", "aws:sourceorgid"]);
  return Object.values(statement.Condition).some(entries => Object.entries(entries).some(([key, expected]) =>
    trusted.has(key.toLowerCase()) && values(expected).some(item => typeof item === "string" && item.length > 0 && !item.includes("*"))));
}

export function policyIsPublic(document?: PolicyDocument): boolean {
  if (!document) return false;
  return values(document.Statement).some(raw => {
    const statement = raw as PolicyStatement;
    if (statement.Effect !== "Allow" || conditionMakesPrincipalNonPublic(statement)) return false;
    if (statement.NotPrincipal !== undefined) return true;
    const principals = typeof statement.Principal === "object" && !Array.isArray(statement.Principal)
      ? Object.values(statement.Principal).flatMap(values)
      : values(statement.Principal);
    return principals.some(value => value === "*" || typeof value === "string" && value.includes("*"));
  });
}

function normalizeGrant(grant: S3AccessControlGrantState): S3AccessControlGrantState {
  if (!PERMISSIONS.has(grant.permission)) throw new AwsError("InvalidArgument", `Unsupported ACL permission ${grant.permission}`, 400);
  if (grant.grantee.type === "CanonicalUser") {
    if (!grant.grantee.id || !/^[a-f0-9]{64}$/i.test(grant.grantee.id)) throw new AwsError("InvalidArgument", "CanonicalUser grants require a valid canonical ID", 400);
    return { grantee: { type: "CanonicalUser", id: grant.grantee.id.toLowerCase(), ...(grant.grantee.displayName ? { displayName: grant.grantee.displayName } : {}) }, permission: grant.permission };
  }
  if (!grant.grantee.uri || !SUPPORTED_GROUPS.has(grant.grantee.uri)) throw new AwsError("InvalidArgument", "The specified ACL group is not supported", 400);
  return { grantee: { type: "Group", uri: grant.grantee.uri }, permission: grant.permission };
}

function deduplicate(acl: S3AccessControlListState): S3AccessControlListState {
  const grants = new Map<string, S3AccessControlGrantState>();
  for (const grant of acl.grants.map(normalizeGrant)) {
    const key = `${grant.grantee.type}:${grant.grantee.id ?? grant.grantee.uri}:${grant.permission}`;
    grants.set(key, grant);
  }
  if (grants.size > 100) throw new AwsError("InvalidArgument", "An ACL can contain at most 100 grants", 400);
  return { ownerId: acl.ownerId, ownerDisplayName: acl.ownerDisplayName, grants: [...grants.values()] };
}

function canonicalGrant(accountId: string, permission: S3AccessControlGrantState["permission"]): S3AccessControlGrantState {
  return { grantee: { type: "CanonicalUser", id: canonicalOwnerId(accountId), displayName: LOCAL_OWNER_DISPLAY_NAME }, permission };
}
function groupGrant(uri: string, permission: S3AccessControlGrantState["permission"]): S3AccessControlGrantState {
  return { grantee: { type: "Group", uri }, permission };
}

export function cannedAcl(name: string, ownerAccountId: string, writerAccountId: string, object: boolean): S3AccessControlListState {
  const ownerId = canonicalOwnerId(object ? writerAccountId : ownerAccountId);
  const ownerAccount = object ? writerAccountId : ownerAccountId;
  const grants: S3AccessControlGrantState[] = [canonicalGrant(ownerAccount, "FULL_CONTROL")];
  if (name === "private") return { ownerId, ownerDisplayName: LOCAL_OWNER_DISPLAY_NAME, grants };
  if (name === "public-read") grants.push(groupGrant(ALL_USERS, "READ"));
  else if (name === "public-read-write" && !object) grants.push(groupGrant(ALL_USERS, "READ"), groupGrant(ALL_USERS, "WRITE"));
  else if (name === "authenticated-read") grants.push(groupGrant(AUTHENTICATED_USERS, "READ"));
  else if (name === "bucket-owner-read" && object) grants.push(canonicalGrant(ownerAccountId, "READ"));
  else if (name === "bucket-owner-full-control" && object) grants.push(canonicalGrant(ownerAccountId, "FULL_CONTROL"));
  else if (name === "log-delivery-write" && !object) grants.push(groupGrant(LOG_DELIVERY, "WRITE"), groupGrant(LOG_DELIVERY, "READ_ACP"));
  else if (name === "aws-exec-read" && object) grants.push(groupGrant(AUTHENTICATED_USERS, "READ"));
  else throw new AwsError("InvalidArgument", `Unsupported canned ACL ${name}`, 400);
  return deduplicate({ ownerId, ownerDisplayName: LOCAL_OWNER_DISPLAY_NAME, grants });
}

function quotedGrantees(value: string): Array<{ key: string; value: string }> {
  const output: Array<{ key: string; value: string }> = [];
  for (const item of value.split(/,\s*(?=[a-zA-Z]+=)/)) {
    const match = item.trim().match(/^(id|uri|emailAddress)="([^"]+)"$/);
    if (!match || match[1] === "emailAddress") throw new AwsError("InvalidArgument", "Email-address ACL grantees are not supported by this local account model", 400);
    output.push({ key: match[1], value: match[2] });
  }
  return output;
}

export function aclFromRequest(xml: string, headers: IncomingHttpHeaders, ownerAccountId: string, writerAccountId: string, object: boolean): S3AccessControlListState {
  const canned = String(headers["x-amz-acl"] ?? "").trim();
  const grantHeaders: Array<[string, S3AccessControlGrantState["permission"]]> = [
    ["x-amz-grant-full-control", "FULL_CONTROL"], ["x-amz-grant-read", "READ"], ["x-amz-grant-write", "WRITE"],
    ["x-amz-grant-read-acp", "READ_ACP"], ["x-amz-grant-write-acp", "WRITE_ACP"],
  ];
  const suppliedGrantHeaders = grantHeaders.filter(([name]) => headers[name] !== undefined);
  if (canned && suppliedGrantHeaders.length) throw new AwsError("InvalidRequest", "A canned ACL cannot be combined with grant headers", 400);
  if (canned) return cannedAcl(canned, ownerAccountId, writerAccountId, object);
  if (suppliedGrantHeaders.length) {
    const ownerId = canonicalOwnerId(object ? writerAccountId : ownerAccountId);
    const grants = [canonicalGrant(object ? writerAccountId : ownerAccountId, "FULL_CONTROL")];
    for (const [name, permission] of suppliedGrantHeaders) for (const grantee of quotedGrantees(String(headers[name]))) grants.push(grantee.key === "id"
      ? { grantee: { type: "CanonicalUser", id: grantee.value }, permission }
      : { grantee: { type: "Group", uri: grantee.value }, permission });
    return deduplicate({ ownerId, ownerDisplayName: LOCAL_OWNER_DISPLAY_NAME, grants });
  }
  if (!xml.trim()) return privateAcl(object ? writerAccountId : ownerAccountId);
  if (!/<AccessControlPolicy(?:\s|>)/i.test(xml)) throw new AwsError("MalformedACLError", "The XML you provided was not well-formed or did not validate against our published schema", 400);
  const ownerId = xmlValue(xml.match(/<Owner(?:\s[^>]*)?>([\s\S]*?)<\/Owner>/i)?.[1] ?? "", "ID") ?? canonicalOwnerId(object ? writerAccountId : ownerAccountId);
  const grants: S3AccessControlGrantState[] = [];
  for (const match of xml.matchAll(/<Grant(?:\s[^>]*)?>([\s\S]*?)<\/Grant>/gi)) {
    const body = match[1]; const granteeBody = body.match(/<Grantee(?:\s[^>]*)?>([\s\S]*?)<\/Grantee>/i)?.[1] ?? "";
    const permission = xmlValue(body, "Permission") as S3AccessControlGrantState["permission"] | undefined;
    const id = xmlValue(granteeBody, "ID"); const uri = xmlValue(granteeBody, "URI"); const email = xmlValue(granteeBody, "EmailAddress");
    if (!permission || email || Boolean(id) === Boolean(uri)) throw new AwsError("MalformedACLError", "Each ACL grant requires one supported grantee and a permission", 400);
    grants.push(id ? { grantee: { type: "CanonicalUser", id, ...(xmlValue(granteeBody, "DisplayName") ? { displayName: xmlValue(granteeBody, "DisplayName") } : {}) }, permission } : { grantee: { type: "Group", uri: uri! }, permission });
  }
  return deduplicate({ ownerId, ownerDisplayName: LOCAL_OWNER_DISPLAY_NAME, grants });
}

export function aclIsPublic(acl?: S3AccessControlListState): boolean {
  return Boolean(acl?.grants.some(grant => grant.grantee.type === "Group" && (grant.grantee.uri === ALL_USERS || grant.grantee.uri === AUTHENTICATED_USERS)));
}

export function aclAllows(acl: S3AccessControlListState | undefined, principalAccountId: string | undefined, authenticated: boolean, action: string, ignorePublic: boolean): boolean {
  if (!acl) return false;
  const required = action.endsWith("GetBucketAcl") || action.endsWith("GetObjectAcl") ? new Set(["READ_ACP", "FULL_CONTROL"])
    : action.endsWith("PutBucketAcl") || action.endsWith("PutObjectAcl") ? new Set(["WRITE_ACP", "FULL_CONTROL"])
      : action.endsWith("ListBucket") || action.endsWith("ListBucketVersions") || action.endsWith("GetObject") || action.endsWith("GetObjectVersion") || action.endsWith("HeadObject") ? new Set(["READ", "FULL_CONTROL"])
        : action.endsWith("PutObject") || action.endsWith("DeleteObject") ? new Set(["WRITE", "FULL_CONTROL"]) : new Set<string>();
  if (!required.size) return false;
  const principalId = principalAccountId ? canonicalOwnerId(principalAccountId) : undefined;
  if (principalId && principalId === acl.ownerId) return true;
  return acl.grants.some(grant => {
    if (!required.has(grant.permission)) return false;
    if (grant.grantee.type === "CanonicalUser") return Boolean(principalId && grant.grantee.id === principalId);
    if (ignorePublic) return false;
    return grant.grantee.uri === ALL_USERS || grant.grantee.uri === AUTHENTICATED_USERS && authenticated;
  });
}

export function aclXml(acl: S3AccessControlListState): string {
  const grants = acl.grants.map(grant => {
    const grantee = grant.grantee.type === "CanonicalUser"
      ? `<Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>${xmlEscape(grant.grantee.id!)}</ID>${grant.grantee.displayName ? `<DisplayName>${xmlEscape(grant.grantee.displayName)}</DisplayName>` : ""}</Grantee>`
      : `<Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group"><URI>${xmlEscape(grant.grantee.uri!)}</URI></Grantee>`;
    return `<Grant>${grantee}<Permission>${grant.permission}</Permission></Grant>`;
  }).join("");
  const ownerDisplayName = acl.ownerDisplayName === "local-developer" ? LOCAL_OWNER_DISPLAY_NAME : acl.ownerDisplayName;
  return `<Owner><ID>${xmlEscape(acl.ownerId)}</ID><DisplayName>${xmlEscape(ownerDisplayName)}</DisplayName></Owner><AccessControlList>${grants}</AccessControlList>`;
}

export function objectAcl(object: S3ObjectVersionState, bucket: S3BucketState): S3AccessControlListState {
  return object.acl ?? privateAcl(object.ownerAccountId ?? bucket.ownerAccountId);
}
