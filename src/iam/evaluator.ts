import type { IamState, PolicyDocument, PolicyStatement } from "../types.js";
import type { PrincipalContext } from "../auth/sigv4.js";
import { parseConditionOperator } from "./condition-operators.js";
import { policyDocumentValidationError } from "./policy-validation.js";
import { decodeBase64Strict } from "../core/base64.js";
import { cidrMatches } from "../core/ip.js";

export interface AuthorizationContext { [key: string]: unknown }
export type ResourceGrantBasis = "directUser" | "role" | "directSession" | "account" | "wildcard";
export interface AuthorizationLayerResult { decision: AuthorizationResult["decision"]; matchedStatements: string[] }
export interface AuthorizationLayers { identity: AuthorizationLayerResult; session?: AuthorizationLayerResult; boundary?: AuthorizationLayerResult }
export interface AuthorizationResult {
  decision: "allowed" | "implicitDeny" | "explicitDeny";
  reason: string;
  matchedStatements: string[];
  /** The principal form in the resource-policy Allow that granted access. */
  grantBasis?: ResourceGrantBasis;
  /** Kept separate until identity/resource composition applies AWS's principal matrix. */
  layers?: AuthorizationLayers;
}

/**
 * Global request context exposed by calls made with an assumed role session.
 * Internal service integrations use this instead of minting durable credentials
 * solely to evaluate the role's identity policies.
 */
export function roleSessionAuthorizationContext(roleArn: string, region: string, now: number, context: AuthorizationContext = {}): AuthorizationContext {
  const accountId = roleArn.match(/^arn:[a-z0-9-]+:iam::(\d{12}):role\//i)?.[1];
  return {
    "aws:PrincipalArn": roleArn,
    ...(accountId ? { "aws:PrincipalAccount": accountId } : {}),
    "aws:RequestedRegion": region,
    "aws:CurrentTime": new Date(now).toISOString(),
    ...context,
  };
}
export type ResourcePolicyRelationship = "sameAccount" | "crossAccount" | "service";

/** Combines already-evaluated identity and resource policies using IAM's account boundary rules. */
export function combineIdentityAndResourceAuthorization(
  identity: AuthorizationResult | undefined,
  resource: AuthorizationResult,
  relationship: ResourcePolicyRelationship,
): AuthorizationResult {
  if (identity?.decision === "explicitDeny") return identity;
  if (resource.decision === "explicitDeny") return resource;
  const matchedStatements = [...(identity?.matchedStatements ?? []), ...resource.matchedStatements];
  if (relationship === "service") return resource.decision === "allowed"
    ? { decision: "allowed", reason: "The resource policy allows the AWS service principal", matchedStatements }
    : { decision: "implicitDeny", reason: "The resource policy does not allow the AWS service principal", matchedStatements };
  if (relationship === "sameAccount") {
    if (identity?.decision === "allowed") return { decision: "allowed", reason: "A same-account identity policy allows the action", matchedStatements };
    if (resource.decision !== "allowed") return { decision: "implicitDeny", reason: identity?.reason ?? "No same-account identity or resource policy allows the action", matchedStatements };
    if (resource.grantBasis === "directUser" || resource.grantBasis === "directSession") {
      return { decision: "allowed", reason: `A same-account resource policy directly allows the ${resource.grantBasis === "directUser" ? "IAM user" : "role session"}`, matchedStatements };
    }
    if (resource.grantBasis === "role") {
      const limitingLayers = [identity?.layers?.session, identity?.layers?.boundary].filter(Boolean);
      if (identity?.layers && limitingLayers.every(layer => layer?.decision === "allowed")) {
        return { decision: "allowed", reason: "A same-account resource policy allows the role and all limiting policies allow the action", matchedStatements };
      }
      return { decision: "implicitDeny", reason: identity?.reason ?? "A role-principal resource grant remains constrained by session policies and permissions boundaries", matchedStatements };
    }
    return { decision: "implicitDeny", reason: "Account and wildcard resource grants require an identity-policy Allow", matchedStatements };
  }
  return identity?.decision === "allowed" && resource.decision === "allowed"
    ? { decision: "allowed", reason: "Both identity and cross-account resource policies allow the action", matchedStatements }
    : { decision: "implicitDeny", reason: "Cross-account access requires both identity and resource policy allows", matchedStatements };
}

function values(value: unknown): unknown[] { return Array.isArray(value) ? value : [value]; }
function wildcard(pattern: string, candidate: string, insensitive = false): boolean { const expression = `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`; return new RegExp(expression, insensitive ? "i" : "").test(candidate); }
function variable(value: string, context: AuthorizationContext): string { return value.replace(/\$\{([^}]+)\}/g, (_match, key) => String(contextValue(context, key) ?? "")); }
function contextValue(context: AuthorizationContext, key: string): unknown { const found = Object.keys(context).find(item => item.toLowerCase() === key.toLowerCase()); return found ? context[found] : undefined; }
function matchesList(patterns: unknown, value: string, insensitive = false): boolean { return values(patterns).some(pattern => typeof pattern === "string" && wildcard(pattern, value, insensitive)); }

function baseOperator(operator: string, actual: unknown, expected: unknown): boolean {
  const a = String(actual); const candidates = values(expected).map(String); const lower = operator.toLowerCase();
  if (lower === "null") return (actual === undefined || actual === null) === (candidates[0].toLowerCase() === "true");
  if (lower === "bool") return String(Boolean(actual)).toLowerCase() === candidates[0].toLowerCase() || a.toLowerCase() === candidates[0].toLowerCase();
  if (lower === "binaryequals") {
    const actualBytes = Buffer.isBuffer(actual) || actual instanceof Uint8Array ? Buffer.from(actual) : decodeBase64Strict(a);
    return actualBytes !== undefined && candidates.some(value => { const expectedBytes = decodeBase64Strict(value); return expectedBytes !== undefined && actualBytes.equals(expectedBytes); });
  }
  if (lower === "ipaddress") return candidates.some(value => cidrMatches(a, value));
  if (lower === "notipaddress") return candidates.every(value => !cidrMatches(a, value));
  if (lower.startsWith("numeric")) { const left = Number(a); return candidates.some(value => { const right = Number(value); return lower === "numericequals" ? left === right : lower === "numericnotequals" ? left !== right : lower === "numericlessthan" ? left < right : lower === "numericlessthanequals" ? left <= right : lower === "numericgreaterthan" ? left > right : lower === "numericgreaterthanequals" ? left >= right : false; }); }
  if (lower.startsWith("date")) { const left = Date.parse(a); return candidates.some(value => { const right = Date.parse(value); return lower === "dateequals" ? left === right : lower === "datenotequals" ? left !== right : lower === "datelessthan" ? left < right : lower === "datelessthanequals" ? left <= right : lower === "dategreaterthan" ? left > right : lower === "dategreaterthanequals" ? left >= right : false; }); }
  const insensitive = lower.includes("ignorecase"); const like = lower.includes("like"); const negative = lower.includes("notequals") || lower.includes("notlike"); const matched = candidates.some(value => like ? wildcard(value, a, insensitive) : insensitive ? a.toLowerCase() === value.toLowerCase() : a === value); return negative ? !matched : matched;
}

function conditionMatches(condition: PolicyStatement["Condition"], context: AuthorizationContext): boolean {
  if (!condition) return true;
  for (const [rawOperator, entries] of Object.entries(condition)) for (const [key, expected] of Object.entries(entries)) {
    const parsed = parseConditionOperator(rawOperator); if (!parsed) return false;
    const actual = contextValue(context, key);
    if (parsed.base === "Null") { if (!baseOperator(parsed.base, actual, expected)) return false; continue; }
    if (actual === undefined) {
      if (parsed.ifExists || parsed.forAll || parsed.negated) continue;
      return false;
    }
    const actualValues = values(actual);
    if (!actualValues.length) { if (parsed.forAll || parsed.ifExists) continue; return false; }
    const checks = actualValues.map(value => baseOperator(parsed.base, value, expected)); if (parsed.forAll ? !checks.every(Boolean) : !checks.some(Boolean)) return false;
  }
  return true;
}

function statementMatches(statement: PolicyStatement, action: string, resource: string, context: AuthorizationContext): boolean {
  const actionMatch = statement.Action !== undefined ? matchesList(statement.Action, action, true) : !matchesList(statement.NotAction, action, true); if (!actionMatch) return false;
  const expanded = (input: unknown): unknown => values(input).map(value => typeof value === "string" ? variable(value, context) : value);
  const resourceMatch = statement.Resource !== undefined ? matchesList(expanded(statement.Resource), resource) : statement.NotResource !== undefined ? !matchesList(expanded(statement.NotResource), resource) : true;
  return resourceMatch && conditionMatches(statement.Condition, context);
}

function evaluateDocuments(documents: PolicyDocument[], action: string, resource: string, context: AuthorizationContext): AuthorizationResult {
  let allowed = false; const matchedStatements: string[] = [];
  for (const document of documents) {
    if (policyDocumentValidationError(document, "identity")) continue;
    for (const statement of values(document.Statement) as PolicyStatement[]) if (statementMatches(statement, action, resource, context)) { matchedStatements.push(statement.Sid ?? `${statement.Effect}:${matchedStatements.length + 1}`); if (statement.Effect === "Deny") return { decision: "explicitDeny", reason: "An applicable policy statement explicitly denies the action", matchedStatements }; if (statement.Effect === "Allow") allowed = true; }
  }
  return allowed ? { decision: "allowed", reason: "An applicable policy statement allows the action", matchedStatements } : { decision: "implicitDeny", reason: "No applicable Allow statement was found", matchedStatements };
}

export function evaluateRoleAuthorization(iam: IamState, roleArn: string, action: string, resource: string, context: AuthorizationContext = {}): AuthorizationResult {
  const role = Object.values(iam.roles).find(candidate => candidate.arn === roleArn);
  if (!role) return { decision: "implicitDeny", reason: "The execution role does not exist", matchedStatements: [] };
  const documents = [...Object.values(role.inlinePolicies), ...role.attachedPolicyArns.map(arn => iam.policies[arn]?.versions[iam.policies[arn]?.defaultVersionId]?.document).filter(Boolean)];
  const identity = evaluateDocuments(documents, action, resource, context);
  const boundaryPolicy = role.permissionsBoundaryArn ? iam.policies[role.permissionsBoundaryArn] : undefined;
  const boundary = role.permissionsBoundaryArn ? boundaryPolicy ? evaluateDocuments([boundaryPolicy.versions[boundaryPolicy.defaultVersionId].document], action, resource, context) : { decision: "implicitDeny" as const, reason: "Permissions boundary was not found", matchedStatements: [] } : undefined;
  const layers: AuthorizationLayers = { identity, ...(boundary ? { boundary } : {}) };
  if (identity.decision === "explicitDeny") return { ...identity, layers };
  if (boundary?.decision === "explicitDeny") return { ...boundary, reason: `Permissions boundary: ${boundary.reason}`, layers };
  if (identity.decision !== "allowed") return { ...identity, layers };
  if (boundary?.decision !== undefined && boundary.decision !== "allowed") return { ...boundary, reason: `Permissions boundary: ${boundary.reason}`, layers };
  return { ...identity, layers };
}

/** Evaluates a standalone identity-shaped policy, such as an API Gateway authorizer result. */
export function evaluateIdentityPolicy(document: PolicyDocument, action: string, resource: string, context: AuthorizationContext = {}): AuthorizationResult {
  return evaluateDocuments([document], action, resource, context);
}

export interface PrincipalIdentity { principalArn: string; roleArn?: string }

export function classifyResourceGrant(expected: string, principal: PrincipalIdentity): ResourceGrantBasis {
  if (expected === "*" || expected.includes("*") || expected.includes("?")) return "wildcard";
  if (/^\d{12}$/.test(expected) || /^arn:[a-z0-9-]+:iam::\d{12}:root$/i.test(expected)) return "account";
  if (principal.roleArn && expected === principal.roleArn) return "role";
  if (expected === principal.principalArn) {
    if (/^arn:[a-z0-9-]+:iam::\d{12}:user\//i.test(expected)) return "directUser";
    if (/^arn:[a-z0-9-]+:sts::\d{12}:assumed-role\//i.test(expected)) return "directSession";
    if (/^arn:[a-z0-9-]+:iam::\d{12}:role\//i.test(expected)) return "role";
  }
  return "wildcard";
}

const grantRank: Record<ResourceGrantBasis, number> = { wildcard: 0, account: 1, role: 2, directUser: 3, directSession: 3 };

export function evaluateResourcePolicy(document: PolicyDocument, principal: string | PrincipalIdentity, action: string, resource: string, context: AuthorizationContext = {}): AuthorizationResult {
  const identity = typeof principal === "string" ? { principalArn: principal } : principal;
  let allowed = false; let basis: ResourceGrantBasis | undefined; const matchedStatements: string[] = [];
  if (policyDocumentValidationError(document, "resource")) return { decision: "implicitDeny", reason: "Resource policy is malformed", matchedStatements };
  for (const statement of values(document.Statement) as PolicyStatement[]) {
    if (!statementMatches(statement, action, resource, context)) continue;
    const principals = principalValues(statement.Principal); const notPrincipals = principalValues(statement.NotPrincipal);
    const matches = principals.filter(value => resourcePrincipalMatches(value, identity.principalArn, identity.roleArn));
    const principalMatches = statement.Principal === undefined ? !notPrincipals.some(value => resourcePrincipalMatches(value, identity.principalArn, identity.roleArn)) : matches.length > 0;
    if (!principalMatches) continue;
    matchedStatements.push(statement.Sid ?? `${statement.Effect}:${matchedStatements.length + 1}`); if (statement.Effect === "Deny") return { decision: "explicitDeny", reason: "A resource policy explicitly denies the action", matchedStatements }; if (statement.Effect === "Allow") { allowed = true; for (const match of matches) { const candidate = classifyResourceGrant(match, identity); if (!basis || grantRank[candidate] > grantRank[basis]) basis = candidate; } }
  }
  return allowed ? { decision: "allowed", reason: "A resource policy allows the action", matchedStatements, grantBasis: basis ?? "wildcard" } : { decision: "implicitDeny", reason: "No applicable resource policy Allow statement was found", matchedStatements };
}

export function evaluateAuthorization(iam: IamState, principal: PrincipalContext, action: string, resource: string, context: AuthorizationContext): AuthorizationResult {
  if (principal.principalType === "user") {
    const user = principal.userId
      ? Object.values(iam.users).find(candidate => candidate.userId === principal.userId)
      : principal.userName ? iam.users[principal.userName] : undefined;
    if (!user) return { decision: "implicitDeny", reason: "The IAM user no longer exists", matchedStatements: [] };
    const groups = Object.values(iam.groups).filter(group => group.userNames.includes(user.userName));
    const managed = [...user.attachedPolicyArns, ...groups.flatMap(group => group.attachedPolicyArns)]
      .map(arn => iam.policies[arn]?.versions[iam.policies[arn]?.defaultVersionId]?.document)
      .filter(Boolean);
    const documents = [...Object.values(user.inlinePolicies), ...groups.flatMap(group => Object.values(group.inlinePolicies)), ...managed];
    const identity = evaluateDocuments(documents, action, resource, {
      "aws:PrincipalArn": user.arn,
      "aws:PrincipalAccount": principal.accountId,
      "aws:PrincipalType": "User",
      "aws:userid": user.userId,
      "aws:username": user.userName,
      ...Object.fromEntries(Object.entries(user.tags).map(([key, value]) => [`aws:PrincipalTag/${key}`, value])),
      ...context,
    });
    const policy = user.permissionsBoundaryArn ? iam.policies[user.permissionsBoundaryArn] : undefined;
    const boundary = user.permissionsBoundaryArn ? policy
      ? evaluateDocuments([policy.versions[policy.defaultVersionId].document], action, resource, context)
      : { decision: "implicitDeny" as const, reason: "Permissions boundary was not found", matchedStatements: [] } : undefined;
    const layers: AuthorizationLayers = { identity, ...(boundary ? { boundary } : {}) };
    if (identity.decision === "explicitDeny") return { ...identity, layers };
    if (boundary?.decision === "explicitDeny") return { ...boundary, reason: `Permissions boundary: ${boundary.reason}`, layers };
    if (identity.decision !== "allowed") return { ...identity, layers };
    if (boundary && boundary.decision !== "allowed") return { ...boundary, reason: `Permissions boundary: ${boundary.reason}`, layers };
    return { ...identity, layers };
  }
  const session = iam.sessions[principal.accessKeyId]; if (!session) return { decision: "implicitDeny", reason: "The principal has no identity policies", matchedStatements: [] };
  const role = iam.roles[session.roleName]; if (!role) return { decision: "implicitDeny", reason: "The session role no longer exists", matchedStatements: [] };
  const documents = [...Object.values(role.inlinePolicies), ...role.attachedPolicyArns.map(arn => iam.policies[arn]?.versions[iam.policies[arn]?.defaultVersionId]?.document).filter(Boolean)]; const identity = evaluateDocuments(documents, action, resource, context);
  const limited = session.sessionPolicy ? evaluateDocuments([session.sessionPolicy], action, resource, context) : undefined;
  const policy = role.permissionsBoundaryArn ? iam.policies[role.permissionsBoundaryArn] : undefined;
  const boundary = role.permissionsBoundaryArn ? policy ? evaluateDocuments([policy.versions[policy.defaultVersionId].document], action, resource, context) : { decision: "implicitDeny" as const, reason: "Permissions boundary was not found", matchedStatements: [] } : undefined;
  const layers: AuthorizationLayers = { identity, ...(limited ? { session: limited } : {}), ...(boundary ? { boundary } : {}) };
  if (identity.decision === "explicitDeny") return { ...identity, layers };
  if (limited?.decision === "explicitDeny") return { ...limited, reason: `Session policy: ${limited.reason}`, layers };
  if (boundary?.decision === "explicitDeny") return { ...boundary, reason: `Permissions boundary: ${boundary.reason}`, layers };
  if (identity.decision !== "allowed") return { ...identity, layers };
  if (limited && limited.decision !== "allowed") return { ...limited, reason: `Session policy: ${limited.reason}`, layers };
  if (boundary && boundary.decision !== "allowed") return { ...boundary, reason: `Permissions boundary: ${boundary.reason}`, layers };
  return { ...identity, layers };
}

function principalValues(principal: PolicyStatement["Principal"]): string[] { if (typeof principal === "string") return [principal]; if (Array.isArray(principal)) return principal; if (!principal) return []; return Object.values(principal).flatMap(values).map(String); }
function resourcePrincipalMatches(expected: string, actual: string, issuerRoleArn?: string): boolean {
  if (expected === "*" || wildcard(expected, actual)) return true;
  if (/^\d{12}$/.test(expected) && (actual.includes(`::${expected}:`) || actual === expected)) return true;
  const account = expected.match(/^arn:aws:iam::(\d{12}):root$/)?.[1]; if (account && (actual.includes(`::${account}:`) || actual === account)) return true;
  if (issuerRoleArn && wildcard(expected, issuerRoleArn)) return true;
  const role = expected.match(/^arn:aws:iam::(\d{12}):role\/(.+)$/); const session = actual.match(/^arn:aws:sts::(\d{12}):assumed-role\/(.+)\/[^/]+$/); return Boolean(role && session && role[1] === session[1] && role[2] === session[2]);
}
export function evaluateTrust(document: PolicyDocument, principal: string | PrincipalIdentity, action: string, context: AuthorizationContext): AuthorizationResult {
  const principalArn = typeof principal === "string" ? principal : principal.principalArn;
  const issuerRoleArn = typeof principal === "string" ? undefined : principal.roleArn;
  let allowed = false; const matchedStatements: string[] = [];
  if (policyDocumentValidationError(document, "trust")) return { decision: "implicitDeny", reason: "Trust policy is malformed", matchedStatements };
  for (const statement of values(document.Statement) as PolicyStatement[]) {
    if (statement.Action !== undefined && !matchesList(statement.Action, action, true)) continue; const principals = principalValues(statement.Principal); const notPrincipals = principalValues(statement.NotPrincipal); const matches = statement.Principal !== undefined ? principals.some(value => resourcePrincipalMatches(value, principalArn, issuerRoleArn)) : !notPrincipals.some(value => resourcePrincipalMatches(value, principalArn, issuerRoleArn)); if (!matches || !conditionMatches(statement.Condition, context)) continue;
    matchedStatements.push(statement.Sid ?? `${statement.Effect}:${matchedStatements.length + 1}`); if (statement.Effect === "Deny") return { decision: "explicitDeny", reason: "Trust policy explicitly denies AssumeRole", matchedStatements }; if (statement.Effect === "Allow") allowed = true;
  }
  return allowed ? { decision: "allowed", reason: "Trust policy allows the principal", matchedStatements } : { decision: "implicitDeny", reason: "Trust policy does not allow the principal", matchedStatements };
}
