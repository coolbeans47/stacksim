import type { IamState, PolicyDocument, PolicyStatement } from "../types.js";
import { AwsError } from "../errors.js";

const POLICY_BYTES = 20 * 1024;
const STATEMENT_KEYS = new Set(["Sid", "Effect", "Principal", "Action", "Resource", "Condition"]);

function malformed(message: string): never {
  throw new AwsError("MalformedPolicyDocumentException", message, 400);
}

function list(value: unknown, label: string): string[] {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.some(item => typeof item !== "string" || !item)) malformed(`${label} must contain non-empty strings.`);
  return values as string[];
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** JSON.parse accepts duplicate object keys; IAM policy documents do not. */
function rejectDuplicateKeys(text: string): void {
  let offset = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? "")) offset++; };
  const string = (): string => {
    whitespace();
    if (text[offset] !== '"') malformed("The resource policy is not valid JSON.");
    const start = offset++;
    let escaped = false;
    while (offset < text.length) {
      const character = text[offset++];
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === '"') {
        try { return JSON.parse(text.slice(start, offset)); } catch { malformed("The resource policy is not valid JSON."); }
      }
    }
    malformed("The resource policy is not valid JSON.");
  };
  const value = (): void => {
    whitespace();
    if (text[offset] === "{") {
      offset++; whitespace(); const keys = new Set<string>();
      if (text[offset] === "}") { offset++; return; }
      while (offset < text.length) {
        const key = string();
        if (keys.has(key)) malformed(`The resource policy contains a duplicate key: ${key}.`);
        keys.add(key); whitespace();
        if (text[offset++] !== ":") malformed("The resource policy is not valid JSON.");
        value(); whitespace();
        if (text[offset] === "}") { offset++; return; }
        if (text[offset++] !== ",") malformed("The resource policy is not valid JSON.");
      }
      malformed("The resource policy is not valid JSON.");
    }
    if (text[offset] === "[") {
      offset++; whitespace();
      if (text[offset] === "]") { offset++; return; }
      while (offset < text.length) {
        value(); whitespace();
        if (text[offset] === "]") { offset++; return; }
        if (text[offset++] !== ",") malformed("The resource policy is not valid JSON.");
      }
      malformed("The resource policy is not valid JSON.");
    }
    if (text[offset] === '"') { string(); return; }
    const match = text.slice(offset).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) malformed("The resource policy is not valid JSON.");
    offset += match[0].length;
  };
  value(); whitespace();
  if (offset !== text.length) malformed("The resource policy is not valid JSON.");
}

function validCondition(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) return false;
  return Object.values(value).every(entries => entries && typeof entries === "object" && !Array.isArray(entries) && Object.keys(entries).length
    && Object.values(entries).every(expected => {
      const values = Array.isArray(expected) ? expected : [expected];
      return values.length > 0 && values.every(item => ["string", "number", "boolean"].includes(typeof item));
    }));
}

function configuredIdentity(principal: string, accountId: string, iam: IamState): boolean {
  if (principal === `arn:aws:iam::${accountId}:root` || principal === accountId) return true;
  return Object.values(iam.users).some(user => user.arn === principal)
    || Object.values(iam.roles).some(role => role.arn === principal);
}

export interface ParsedSecretResourcePolicy {
  document: PolicyDocument;
  publicPolicy: boolean;
}

export function parseSecretResourcePolicy(input: unknown, secretArn: string, accountId: string, iam: IamState): ParsedSecretResourcePolicy {
  if (typeof input !== "string" || !input.length) malformed("ResourcePolicy must be a non-empty JSON string.");
  if (Buffer.byteLength(input, "utf8") > POLICY_BYTES) throw new AwsError("LimitExceededException", "The resource policy exceeds 20 KB.", 400);
  rejectDuplicateKeys(input);
  let raw: any;
  try { raw = JSON.parse(input); } catch { malformed("The resource policy is not valid JSON."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) malformed("The resource policy must be a JSON object.");
  if (raw.Version !== undefined && raw.Version !== "2012-10-17") malformed("The resource policy Version must be 2012-10-17.");
  if (Object.keys(raw).some(key => !["Version", "Id", "Statement"].includes(key))) malformed("The resource policy contains an unsupported top-level field.");
  const statements = Array.isArray(raw.Statement) ? raw.Statement : [raw.Statement];
  if (!statements.length || statements.some((statement: unknown) => !statement || typeof statement !== "object" || Array.isArray(statement))) malformed("The resource policy must contain at least one statement.");
  let publicPolicy = false;
  const normalizedStatements = structuredClone(statements) as any[];
  for (const [index, statement] of (statements as any[]).entries()) {
    if (Object.keys(statement).some(key => !STATEMENT_KEYS.has(key))) malformed("A resource-policy statement contains an unsupported field.");
    if (!['Allow', 'Deny'].includes(statement.Effect)) malformed("Every statement requires Effect Allow or Deny.");
    if (statement.Principal === undefined || statement.Action === undefined || statement.Resource === undefined) malformed("Every statement requires Principal, Action, and Resource.");
    const principalMap = typeof statement.Principal === "string" ? { AWS: statement.Principal } : statement.Principal;
    if (!principalMap || typeof principalMap !== "object" || Array.isArray(principalMap) || Object.keys(principalMap).length !== 1 || !Object.hasOwn(principalMap, "AWS")) {
      malformed("Only configured-account AWS identity principals are supported.");
    }
    const principals = list(principalMap.AWS, "Principal.AWS");
    for (const principal of principals) {
      if (principal === "*") {
        if (statement.Effect === "Allow") publicPolicy = true;
        else continue;
      } else if (/^arn:[^:]+:iam::\d{12}:saml-provider\//.test(principal) || /^arn:[^:]+:iam::\d{12}:oidc-provider\//.test(principal)) {
        malformed("Federated principals are not supported.");
      } else if (!configuredIdentity(principal, accountId, iam)) {
        malformed("The policy principal must be an existing identity in the configured account.");
      }
    }
    const normalizedPrincipals = principals.map(principal => principal === accountId ? `arn:aws:iam::${accountId}:root` : principal);
    normalizedStatements[index].Principal = { AWS: normalizedPrincipals.length === 1 ? normalizedPrincipals[0] : normalizedPrincipals };
    for (const action of list(statement.Action, "Action")) if (!/^secretsmanager:(?:[A-Za-z*?]+)$/.test(action)) malformed(`Unsupported resource-policy action: ${action}.`);
    for (const resource of list(statement.Resource, "Resource")) if (resource !== secretArn && resource !== "*") malformed("Resource must be this secret ARN or *.");
    if (statement.Condition !== undefined && !validCondition(statement.Condition)) malformed("Condition must be a non-empty IAM condition map.");
  }
  const normalized = canonical({ ...(raw.Version ? { Version: raw.Version } : {}), ...(raw.Id ? { Id: raw.Id } : {}), Statement: normalizedStatements }) as PolicyDocument;
  return { document: normalized, publicPolicy };
}

export function policyStatements(document: PolicyDocument): PolicyStatement[] {
  return (Array.isArray(document.Statement) ? document.Statement : [document.Statement]) as PolicyStatement[];
}
