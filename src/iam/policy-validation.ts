import type { PolicyDocument, PolicyStatement } from "../types.js";
import { parseConditionOperator } from "./condition-operators.js";
import { decodeBase64Strict } from "../core/base64.js";
import { validIpOrCidr } from "../core/ip.js";

export type PolicyKind = "identity" | "session" | "trust" | "resource";
export interface PolicyPermissionSummary { effect: "Allow" | "Deny"; service: string; actions: string[]; resources: string[]; conditions: string[] }
export interface PolicyValidationReport { valid: boolean; errors: string[]; warnings: string[]; summary: PolicyPermissionSummary[] }

function stringElement(value: unknown): boolean {
  return typeof value === "string" ? value.length > 0 : Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string" && item.length > 0);
}

function principalElement(value: unknown): boolean {
  if (stringElement(value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) return false;
  return Object.values(value).every(stringElement);
}

function conditionError(condition: unknown): string | undefined {
  if (condition === undefined) return undefined;
  if (!condition || typeof condition !== "object" || Array.isArray(condition) || !Object.keys(condition).length) return "Condition must be a non-empty object";
  for (const [operator, entries] of Object.entries(condition)) {
    const parsed = parseConditionOperator(operator);
    if (!parsed) return `Unsupported condition operator ${operator}`;
    if (!entries || typeof entries !== "object" || Array.isArray(entries) || !Object.keys(entries).length) return `Condition operator ${operator} must contain condition keys`;
    for (const [key, expected] of Object.entries(entries)) {
      if (!key || expected === undefined || (Array.isArray(expected) && !expected.length)) return `Condition operator ${operator} contains an empty condition`;
      const values = Array.isArray(expected) ? expected : [expected];
      if (parsed.base === "BinaryEquals" && values.some(value => typeof value !== "string" || decodeBase64Strict(value) === undefined)) return `Condition operator ${operator} requires valid Base64 values`;
      if ((parsed.base === "IpAddress" || parsed.base === "NotIpAddress") && values.some(value => typeof value !== "string" || !validIpOrCidr(value))) return `Condition operator ${operator} requires valid IP addresses or CIDR ranges`;
    }
  }
  return undefined;
}

export function policyDocumentValidationError(document: unknown, kind: PolicyKind): string | undefined {
  if (!document || typeof document !== "object" || Array.isArray(document)) return "Policy document must be an object";
  const candidate = document as Partial<PolicyDocument>;
  if (candidate.Version !== undefined && !["2008-10-17", "2012-10-17"].includes(candidate.Version)) return "Policy document has an unsupported Version";
  if (candidate.Statement === undefined) return "Policy document must contain Statement";
  const statements = Array.isArray(candidate.Statement) ? candidate.Statement : [candidate.Statement];
  if (!statements.length) return "Policy must contain at least one statement";
  for (const raw of statements) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Each statement must be an object";
    const statement = raw as PolicyStatement;
    if (!new Set(["Allow", "Deny"]).has(statement.Effect)) return "Each statement needs a valid Effect";
    const hasAction = statement.Action !== undefined; const hasNotAction = statement.NotAction !== undefined;
    if (hasAction === hasNotAction || !stringElement(hasAction ? statement.Action : statement.NotAction)) return "Each statement needs exactly one non-empty Action or NotAction";
    const hasResource = statement.Resource !== undefined; const hasNotResource = statement.NotResource !== undefined;
    if (hasResource && hasNotResource) return "A statement cannot contain both Resource and NotResource";
    if ((hasResource && !stringElement(statement.Resource)) || (hasNotResource && !stringElement(statement.NotResource))) return "Resource and NotResource must be non-empty strings or lists";
    const hasPrincipal = statement.Principal !== undefined; const hasNotPrincipal = statement.NotPrincipal !== undefined;
    if (hasPrincipal && hasNotPrincipal) return "A statement cannot contain both Principal and NotPrincipal";
    if ((hasPrincipal && !principalElement(statement.Principal)) || (hasNotPrincipal && !principalElement(statement.NotPrincipal))) return "Principal and NotPrincipal must be non-empty";
    if (kind === "identity" || kind === "session") {
      if (!hasResource && !hasNotResource) return "Identity policy statements require Resource or NotResource";
      if (hasPrincipal || hasNotPrincipal) return "Identity policies cannot contain Principal or NotPrincipal";
    } else if (kind === "trust") {
      if (!hasPrincipal || hasNotPrincipal) return "Trust policy statements require Principal and do not support NotPrincipal";
      if (hasResource || hasNotResource) return "Trust policy statements cannot contain Resource or NotResource";
    } else if (hasPrincipal === hasNotPrincipal) {
      return "Resource policy statements require exactly one Principal or NotPrincipal";
    }
    const invalidCondition = conditionError(statement.Condition);
    if (invalidCondition) return invalidCondition;
  }
  return undefined;
}

export function policyValidationReport(document: unknown, kind: Exclude<PolicyKind, "resource">): PolicyValidationReport {
  const error = policyDocumentValidationError(document, kind);
  if (error) return { valid: false, errors: [error], warnings: [], summary: [] };
  const candidate = document as PolicyDocument; const warnings = new Set<string>(); const summary: PolicyPermissionSummary[] = [];
  const statements = Array.isArray(candidate.Statement) ? candidate.Statement : [candidate.Statement];
  for (const statement of statements) {
    const rawActions = statement.Action ?? statement.NotAction; const actions = (Array.isArray(rawActions) ? rawActions : [rawActions]).map(String).sort();
    const rawResources = kind === "trust" ? ["(trust principal)"] : statement.Resource ?? statement.NotResource; const resources = (Array.isArray(rawResources) ? rawResources : [rawResources]).map(String).sort();
    if (actions.some(action => action === "*" || action.endsWith(":*"))) warnings.add("Policy contains wildcard actions.");
    if (kind !== "trust" && resources.some(resource => resource === "*" || resource.includes("*"))) warnings.add("Policy contains wildcard resources.");
    const conditions = Object.entries(statement.Condition ?? {}).flatMap(([operator, entries]) => Object.keys(entries).sort().map(key => `${operator}:${key}`)).sort();
    const byService = new Map<string, string[]>(); for (const action of actions) { const service = action.includes(":") ? action.split(":", 1)[0].toLowerCase() : "*"; const existing = byService.get(service) ?? []; existing.push(action); byService.set(service, existing); }
    for (const [service, groupedActions] of [...byService].sort(([left], [right]) => left.localeCompare(right))) summary.push({ effect: statement.Effect, service, actions: groupedActions, resources, conditions });
  }
  return { valid: true, errors: [], warnings: [...warnings].sort(), summary };
}
