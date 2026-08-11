import { BlockList, isIP } from "node:net";
import type { AuthorizationContext, AuthorizationResult } from "../iam/evaluator.js";
import type { PolicyDocument, PolicyStatement } from "../types.js";

export const SQS_POLICY_LIMITS = Object.freeze({
  bytes: 8_192,
  statements: 20,
  principals: 50,
  conditions: 10,
  actionsPerStatement: 7,
});

const DOCUMENT_KEYS = new Set(["Version", "Id", "Statement"]);
const STATEMENT_KEYS = new Set(["Sid", "Effect", "Principal", "NotPrincipal", "Action", "NotAction", "Resource", "NotResource", "Condition"]);
const STATEMENT_KEY_ORDER = ["Sid", "Effect", "Principal", "NotPrincipal", "Action", "NotAction", "Resource", "NotResource", "Condition"];
const SUPPORTED_VERSIONS = new Set(["2008-10-17", "2012-10-17"]);

/** IAM actions currently exposed by SQS. Batch APIs authorize against their parent actions. */
export const SQS_POLICY_ACTIONS = Object.freeze([
  "AddPermission",
  "CancelMessageMoveTask",
  "ChangeMessageVisibility",
  "CreateQueue",
  "DeleteMessage",
  "DeleteQueue",
  "GetQueueAttributes",
  "GetQueueUrl",
  "ListDeadLetterSourceQueues",
  "ListMessageMoveTasks",
  "ListQueueTags",
  "ListQueues",
  "PurgeQueue",
  "ReceiveMessage",
  "RemovePermission",
  "SendMessage",
  "SetQueueAttributes",
  "StartMessageMoveTask",
  "TagQueue",
  "UntagQueue",
] as const);

const ACTION_NAMES = new Map(SQS_POLICY_ACTIONS.map(action => [action.toLowerCase(), action]));
const ADD_PERMISSION_ACTION_NAMES = new Map([
  "ChangeMessageVisibility",
  "DeleteMessage",
  "GetQueueAttributes",
  "GetQueueUrl",
  "ReceiveMessage",
  "SendMessage",
].map(action => [action.toLowerCase(), action]));
const BATCH_PARENT_ACTIONS = new Map([
  ["sendmessagebatch", "SendMessage"],
  ["deletemessagebatch", "DeleteMessage"],
  ["changemessagevisibilitybatch", "ChangeMessageVisibility"],
]);

const CONDITION_OPERATORS = new Set([
  "ArnEquals", "ArnLike", "ArnNotEquals", "ArnNotLike",
  "BinaryEquals",
  "Bool",
  "DateEquals", "DateNotEquals", "DateLessThan", "DateLessThanEquals", "DateGreaterThan", "DateGreaterThanEquals",
  "IpAddress", "NotIpAddress",
  "Null",
  "NumericEquals", "NumericNotEquals", "NumericLessThan", "NumericLessThanEquals", "NumericGreaterThan", "NumericGreaterThanEquals",
  "StringEquals", "StringNotEquals", "StringEqualsIgnoreCase", "StringNotEqualsIgnoreCase", "StringLike", "StringNotLike",
]);

const GLOBAL_CONDITION_KEYS = new Set([
  "aws:calledvia", "aws:calledviafirst", "aws:calledvialast", "aws:chatbotsourcearn", "aws:currenttime",
  "aws:ec2instancesourceprivateipv4", "aws:ec2instancesourcevpc", "aws:federatedprovider", "aws:multifactorauthage",
  "aws:multifactorauthpresent", "aws:principalaccount", "aws:principalarn", "aws:principalisawsservice",
  "aws:principalorgid", "aws:principalorgpaths", "aws:principalservicename", "aws:principalservicenameslist",
  "aws:principaltype", "aws:referer", "aws:requestedregion", "aws:resourceaccount", "aws:resourceorgid",
  "aws:resourceorgpaths", "aws:securetransport", "aws:sourceaccount", "aws:sourcearn", "aws:sourceidentity",
  "aws:sourceip", "aws:sourceorgid", "aws:sourceorgpaths", "aws:sourcevpc", "aws:sourcevpce", "aws:tagkeys",
  "aws:tokenissuetime", "aws:useragent", "aws:userid", "aws:username", "aws:viaawsservice", "aws:vpcsourceip",
  "aws:vpceaccount", "aws:vpceorgid", "aws:vpceorgpaths",
]);

export type SqsPolicyErrorKind = "validation" | "limit";

export class SqsPolicyValidationError extends Error {
  constructor(message: string, readonly kind: SqsPolicyErrorKind = "validation") {
    super(message);
    this.name = "SqsPolicyValidationError";
  }
}

export interface ParsedSqsQueuePolicy {
  document: PolicyDocument;
  normalized: string;
}

export interface SqsAwsPolicyPrincipal {
  type: "AWS";
  arn: string;
  accountId?: string;
}

export interface SqsServicePolicyPrincipal {
  type: "Service";
  service: string;
}

export type SqsPolicyPrincipal = SqsAwsPolicyPrincipal | SqsServicePolicyPrincipal;

export interface SqsPermissionInput {
  queueArn: string;
  label: string;
  accountIds: readonly string[];
  actions: readonly string[];
}

export interface SqsQueuePolicyOptions {
  /** When provided, every statement must be capable of applying to this attached queue. */
  queueArn?: string;
}

function fail(message: string): never {
  throw new SqsPolicyValidationError(message);
}

function limit(message: string): never {
  throw new SqsPolicyValidationError(message, "limit");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown, label: string): string[] {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.some(item => typeof item !== "string" || item.length === 0)) fail(`${label} must contain one or more non-empty strings`);
  return values as string[];
}

function wildcardRegex(pattern: string, insensitive = false): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, insensitive ? "i" : "");
}

function wildcardMatches(pattern: string, value: string, insensitive = false): boolean {
  return wildcardRegex(pattern, insensitive).test(value);
}

function supportedAction(value: string): boolean {
  if (value === "*") return true;
  const match = value.match(/^sqs:(.+)$/i);
  if (!match) return false;
  if (!match[1].includes("*") && !match[1].includes("?")) return ACTION_NAMES.has(match[1].toLowerCase());
  return SQS_POLICY_ACTIONS.some(action => wildcardMatches(match[1], action, true));
}

function supportedResource(value: string): boolean {
  if (value === "*") return true;
  return /^arn:[a-z0-9-]+:sqs:[a-z0-9*?-]+:(?:\d{12}|[*?]+):[^:/\s]+$/i.test(value);
}

function accountFromArn(value: string): string | undefined {
  return value.match(/^arn:[a-z0-9-]+:(?:iam|sts)::(\d{12}):/i)?.[1];
}

function validAwsPrincipal(value: string): boolean {
  if (value === "*" || /^\d{12}$/.test(value)) return true;
  const match = value.match(/^arn:([a-z0-9-]+):(iam|sts)::(\d{12}):(.+)$/i);
  if (!match) return false;
  if (match[2].toLowerCase() === "iam") return match[4] === "root" || /^(?:user|role)\/[\x21-\x7e]+$/.test(match[4]);
  return /^(?:assumed-role\/[\x21-\x7e]+\/[\x21-\x7e]+|federated-user\/[\x21-\x7e]+)$/.test(match[4]);
}

function validServicePrincipal(value: string): boolean {
  return value === "*" || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.amazonaws\.com(?:\.cn)?$/i.test(value);
}

function validatePrincipal(value: unknown, label: string): number {
  if (typeof value === "string") {
    if (!validAwsPrincipal(value) && !validServicePrincipal(value)) fail(`${label} contains an unsupported principal: ${value}`);
    return 1;
  }
  if (!isObject(value) || !Object.keys(value).length) fail(`${label} must be a principal string or a non-empty AWS/Service principal map`);
  let count = 0;
  for (const [kind, raw] of Object.entries(value)) {
    if (kind !== "AWS" && kind !== "Service") fail(`${label} contains unsupported principal type ${kind}`);
    const entries = list(raw, `${label}.${kind}`);
    for (const entry of entries) {
      const valid = kind === "AWS" ? validAwsPrincipal(entry) : validServicePrincipal(entry);
      if (!valid) fail(`${label}.${kind} contains an unsupported principal: ${entry}`);
    }
    count += entries.length;
  }
  return count;
}

function validConditionKey(value: string): boolean {
  const lower = value.toLowerCase();
  if (GLOBAL_CONDITION_KEYS.has(lower)) return true;
  return /^(?:aws:(?:principal|request|resource)tag|sqs:resourcetag)\/[\x21-\x7e]{1,128}$/i.test(value);
}

interface ParsedConditionOperator {
  base: string;
  qualifier?: "ForAllValues" | "ForAnyValue";
  ifExists: boolean;
}

function parseConditionOperator(raw: string): ParsedConditionOperator {
  let operator = raw;
  let qualifier: ParsedConditionOperator["qualifier"];
  if (operator.startsWith("ForAllValues:")) { qualifier = "ForAllValues"; operator = operator.slice("ForAllValues:".length); }
  else if (operator.startsWith("ForAnyValue:")) { qualifier = "ForAnyValue"; operator = operator.slice("ForAnyValue:".length); }
  let ifExists = false;
  if (operator.endsWith("IfExists")) { ifExists = true; operator = operator.slice(0, -"IfExists".length); }
  if (!CONDITION_OPERATORS.has(operator)) fail(`Unsupported condition operator: ${raw}`);
  if (operator === "Null" && (qualifier || ifExists)) fail(`Condition operator ${raw} cannot use a set qualifier or IfExists`);
  return { base: operator, qualifier, ifExists };
}

function conditionValues(value: unknown, label: string): Array<string | number | boolean> {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.some(item => !["string", "number", "boolean"].includes(typeof item) || typeof item === "number" && !Number.isFinite(item))) {
    fail(`${label} must contain one or more string, number, or boolean values`);
  }
  return values as Array<string | number | boolean>;
}

function validateCidr(value: string): boolean {
  const [address, prefixText, extra] = value.split("/");
  const family = isIP(address);
  if (!family || extra !== undefined) return false;
  if (prefixText === undefined) return true;
  if (!/^\d+$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  return prefix >= 0 && prefix <= (family === 4 ? 32 : 128);
}

function validateConditionValue(operator: string, values: Array<string | number | boolean>, label: string): void {
  if (operator === "Bool" || operator === "Null") {
    if (values.length !== 1 || ![true, false, "true", "false"].includes(values[0] as never)) fail(`${label} must contain exactly one boolean value`);
  } else if (operator.startsWith("Numeric")) {
    if (values.some(value => value === "" || !Number.isFinite(Number(value)))) fail(`${label} must contain numeric values`);
  } else if (operator.startsWith("Date")) {
    if (values.some(value => typeof value === "boolean" || !Number.isFinite(Date.parse(String(value))))) fail(`${label} must contain valid date values`);
  } else if (operator.includes("IpAddress")) {
    if (values.some(value => typeof value !== "string" || !validateCidr(value))) fail(`${label} must contain valid IP addresses or CIDR ranges`);
  } else if (operator.startsWith("Arn")) {
    if (values.some(value => typeof value !== "string" || !value.startsWith("arn:"))) fail(`${label} must contain ARN values`);
  }
}

function validateCondition(value: unknown): number {
  if (!isObject(value) || !Object.keys(value).length) fail("Condition must be a non-empty object");
  let count = 0;
  for (const [operatorName, rawEntries] of Object.entries(value)) {
    const operator = parseConditionOperator(operatorName);
    if (!isObject(rawEntries) || !Object.keys(rawEntries).length) fail(`${operatorName} must contain a non-empty condition-key map`);
    for (const [key, rawExpected] of Object.entries(rawEntries)) {
      if (!validConditionKey(key)) fail(`Unsupported SQS queue-policy condition key: ${key}`);
      const expected = conditionValues(rawExpected, `${operatorName}.${key}`);
      validateConditionValue(operator.base, expected, `${operatorName}.${key}`);
      count++;
    }
  }
  return count;
}

function validatePolicyObject(value: unknown): PolicyDocument {
  if (!isObject(value)) fail("Policy must be a JSON object");
  for (const key of Object.keys(value)) if (!DOCUMENT_KEYS.has(key)) fail(`Policy contains unsupported element ${key}`);
  if (value.Version !== undefined && (typeof value.Version !== "string" || !SUPPORTED_VERSIONS.has(value.Version))) fail("Policy Version must be 2008-10-17 or 2012-10-17");
  if (value.Id !== undefined && (typeof value.Id !== "string" || !value.Id.length)) fail("Policy Id must be a non-empty string");
  if (value.Statement === undefined) fail("Policy must contain Statement");
  const statements = Array.isArray(value.Statement) ? value.Statement : [value.Statement];
  if (!statements.length) fail("Policy must contain at least one statement");
  if (statements.length > SQS_POLICY_LIMITS.statements) limit(`Policy contains more than ${SQS_POLICY_LIMITS.statements} statements`);
  let principalCount = 0;
  let conditionCount = 0;
  const sids = new Set<string>();
  for (const [index, rawStatement] of statements.entries()) {
    const label = `Statement[${index}]`;
    if (!isObject(rawStatement)) fail(`${label} must be an object`);
    for (const key of Object.keys(rawStatement)) if (!STATEMENT_KEYS.has(key)) fail(`${label} contains unsupported element ${key}`);
    if (rawStatement.Sid !== undefined) {
      if (typeof rawStatement.Sid !== "string" || !rawStatement.Sid.length || /[^\x20-\x7e]/.test(rawStatement.Sid)) fail(`${label}.Sid must be a non-empty printable string`);
      if (sids.has(rawStatement.Sid)) fail(`Policy contains duplicate Sid ${rawStatement.Sid}`);
      sids.add(rawStatement.Sid);
    }
    if (rawStatement.Effect !== "Allow" && rawStatement.Effect !== "Deny") fail(`${label}.Effect must be Allow or Deny`);
    if ((rawStatement.Action === undefined) === (rawStatement.NotAction === undefined)) fail(`${label} must contain exactly one of Action or NotAction`);
    if ((rawStatement.Resource === undefined) === (rawStatement.NotResource === undefined)) fail(`${label} must contain exactly one of Resource or NotResource`);
    if ((rawStatement.Principal === undefined) === (rawStatement.NotPrincipal === undefined)) fail(`${label} must contain exactly one of Principal or NotPrincipal`);
    const actions = list(rawStatement.Action ?? rawStatement.NotAction, `${label}.Action`);
    if (actions.length > SQS_POLICY_LIMITS.actionsPerStatement) limit(`${label} contains more than ${SQS_POLICY_LIMITS.actionsPerStatement} actions`);
    for (const action of actions) if (!supportedAction(action)) fail(`${label} contains unsupported SQS action ${action}`);
    for (const resource of list(rawStatement.Resource ?? rawStatement.NotResource, `${label}.Resource`)) if (!supportedResource(resource)) fail(`${label} contains unsupported SQS resource ${resource}`);
    principalCount += validatePrincipal(rawStatement.Principal ?? rawStatement.NotPrincipal, `${label}.Principal`);
    if (rawStatement.Condition !== undefined) conditionCount += validateCondition(rawStatement.Condition);
  }
  if (principalCount > SQS_POLICY_LIMITS.principals) limit(`Policy contains more than ${SQS_POLICY_LIMITS.principals} principals`);
  if (conditionCount > SQS_POLICY_LIMITS.conditions) limit(`Policy contains more than ${SQS_POLICY_LIMITS.conditions} conditions`);
  return structuredClone(value) as unknown as PolicyDocument;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sorted(item)]));
}

function normalizedDocument(value: PolicyDocument): PolicyDocument {
  const document = value as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (document.Version !== undefined) result.Version = document.Version;
  if (document.Id !== undefined) result.Id = document.Id;
  const statements = Array.isArray(document.Statement) ? document.Statement : [document.Statement];
  result.Statement = statements.map(raw => {
    const statement = raw as unknown as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of STATEMENT_KEY_ORDER) if (statement[key] !== undefined) ordered[key] = sorted(statement[key]);
    return ordered;
  });
  return result as unknown as PolicyDocument;
}

/** Validates and canonicalizes a parsed policy document. */
export function normalizeSqsQueuePolicy(document: PolicyDocument, options: SqsQueuePolicyOptions = {}): ParsedSqsQueuePolicy {
  const validated = validatePolicyObject(document);
  if (options.queueArn !== undefined) validateSqsQueuePolicyTarget(validated, options.queueArn);
  const canonical = normalizedDocument(validated);
  const normalized = JSON.stringify(canonical);
  if (Buffer.byteLength(normalized, "utf8") > SQS_POLICY_LIMITS.bytes) limit(`Policy exceeds the maximum size of ${SQS_POLICY_LIMITS.bytes} bytes`);
  return { document: canonical, normalized };
}

/** Parses a Policy queue attribute. The empty string removes the policy. */
export function parseSqsQueuePolicy(input: unknown, options: SqsQueuePolicyOptions = {}): ParsedSqsQueuePolicy | undefined {
  if (typeof input !== "string") fail("Policy must be a JSON string");
  if (input === "") return undefined;
  if (Buffer.byteLength(input, "utf8") > SQS_POLICY_LIMITS.bytes) limit(`Policy exceeds the maximum size of ${SQS_POLICY_LIMITS.bytes} bytes`);
  let value: unknown;
  try { value = JSON.parse(input); }
  catch { fail("Policy contains invalid JSON"); }
  return normalizeSqsQueuePolicy(value as PolicyDocument, options);
}

/** Ensures an attached policy cannot name a scope which makes a statement irrelevant to its queue. */
export function validateSqsQueuePolicyTarget(document: PolicyDocument, queueArn: string): void {
  if (!supportedResource(queueArn) || queueArn === "*" || /[*?]/.test(queueArn)) fail("Queue ARN must identify one concrete SQS queue");
  for (const [index, statement] of (Array.isArray(document.Statement) ? document.Statement : [document.Statement]).entries()) {
    const resources = list(statement.Resource ?? statement.NotResource, `Statement[${index}].Resource`);
    const matches = resources.some(resource => wildcardMatches(resource, queueArn));
    const applies = statement.Resource !== undefined ? matches : !matches;
    if (!applies) fail(`Statement[${index}] resource scope does not apply to queue ${queueArn}`);
  }
}

function asDocument(policy: string | PolicyDocument | undefined): PolicyDocument | undefined {
  if (policy === undefined || policy === "") return undefined;
  return typeof policy === "string" ? parseSqsQueuePolicy(policy)?.document : normalizeSqsQueuePolicy(policy).document;
}

function permissionLabel(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) fail("Permission label must contain 1-80 letters, numbers, hyphens, or underscores");
  return value;
}

/** Creates or replaces the one labeled statement generated by AddPermission. */
export function upsertSqsPermission(policy: string | PolicyDocument | undefined, input: SqsPermissionInput): ParsedSqsQueuePolicy {
  const label = permissionLabel(input.label);
  if (!supportedResource(input.queueArn) || input.queueArn === "*" || /[*?]/.test(input.queueArn)) fail("Queue ARN must identify one concrete SQS queue");
  const accountIds = [...new Set(input.accountIds)];
  if (!accountIds.length || accountIds.some(accountId => !/^\d{12}$/.test(accountId))) fail("AWSAccountIds must contain one or more 12-digit account IDs");
  const requestedActions = [...new Set(input.actions.map(action => action.toLowerCase()))];
  if (!requestedActions.length) fail("Actions must contain at least one action");
  if (requestedActions.length > SQS_POLICY_LIMITS.actionsPerStatement) limit(`AddPermission accepts at most ${SQS_POLICY_LIMITS.actionsPerStatement} actions`);
  const actions = requestedActions.map(action => {
    if (action === "*") return "sqs:*";
    const canonical = ADD_PERMISSION_ACTION_NAMES.get(action.replace(/^sqs:/i, ""));
    if (!canonical) fail(`AddPermission does not support action ${action}`);
    return `sqs:${canonical}`;
  });
  const current = asDocument(policy);
  const statements = current ? (Array.isArray(current.Statement) ? [...current.Statement] : [current.Statement]) : [];
  const generated: PolicyStatement = {
    Sid: label,
    Effect: "Allow",
    Principal: { AWS: accountIds.length === 1 ? accountIds[0] : accountIds },
    Action: actions.length === 1 ? actions[0] : actions,
    Resource: input.queueArn,
  };
  const existing = statements.findIndex(statement => statement.Sid === label);
  if (existing >= 0) statements[existing] = generated;
  else statements.push(generated);
  return normalizeSqsQueuePolicy({ Version: current?.Version ?? "2012-10-17", ...(current?.Id ? { Id: current.Id } : {}), Statement: statements });
}

/** Removes only the exact labeled statement generated by AddPermission. */
export function removeSqsPermission(policy: string | PolicyDocument | undefined, labelValue: string): ParsedSqsQueuePolicy | undefined {
  const label = permissionLabel(labelValue);
  const current = asDocument(policy);
  if (!current) return undefined;
  const statements = (Array.isArray(current.Statement) ? current.Statement : [current.Statement]).filter(statement => statement.Sid !== label);
  if (!statements.length) return undefined;
  return normalizeSqsQueuePolicy({ ...(current.Version ? { Version: current.Version } : {}), ...(current.Id ? { Id: current.Id } : {}), Statement: statements });
}

/** Maps batch request operations to the single-message IAM action AWS documents for them. */
export function sqsAuthorizationAction(action: string): string {
  const match = action.match(/^(?:sqs:)?(.+)$/i);
  const raw = match?.[1] ?? action;
  const canonical = BATCH_PARENT_ACTIONS.get(raw.toLowerCase()) ?? ACTION_NAMES.get(raw.toLowerCase()) ?? raw;
  return `sqs:${canonical}`;
}

function contextValue(context: AuthorizationContext, key: string): unknown {
  const found = Object.keys(context).find(candidate => candidate.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : context[found];
}

function policyVariable(value: string, context: AuthorizationContext): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => String(contextValue(context, key) ?? ""));
}

function principalValues(value: PolicyStatement["Principal"]): Array<{ kind: "AWS" | "Service" | "Any"; value: string }> {
  if (typeof value === "string") return [{ kind: value === "*" ? "Any" : validServicePrincipal(value) && !validAwsPrincipal(value) ? "Service" : "AWS", value }];
  if (!value || Array.isArray(value)) return [];
  const result: Array<{ kind: "AWS" | "Service" | "Any"; value: string }> = [];
  for (const [kind, raw] of Object.entries(value)) for (const entry of Array.isArray(raw) ? raw : [raw]) result.push({ kind: kind as "AWS" | "Service", value: entry });
  return result;
}

function awsPrincipalMatches(expected: string, actual: SqsAwsPolicyPrincipal): boolean {
  if (expected === "*") return true;
  const actualAccount = actual.accountId ?? accountFromArn(actual.arn);
  if (/^\d{12}$/.test(expected)) return expected === actualAccount;
  const rootAccount = expected.match(/^arn:[a-z0-9-]+:iam::(\d{12}):root$/i)?.[1];
  if (rootAccount) return rootAccount === actualAccount;
  if (wildcardMatches(expected, actual.arn)) return true;
  const role = expected.match(/^arn:([a-z0-9-]+):iam::(\d{12}):role\/(.+)$/i);
  const session = actual.arn.match(/^arn:([a-z0-9-]+):sts::(\d{12}):assumed-role\/(.+)\/[^/]+$/i);
  if (!role || !session || role[1] !== session[1] || role[2] !== session[2]) return false;
  return role[3] === session[3] || role[3].split("/").at(-1) === session[3];
}

function principalMatches(expected: ReturnType<typeof principalValues>[number], actual: SqsPolicyPrincipal): boolean {
  if (expected.kind === "Any") return true;
  if (expected.kind === "Service") return actual.type === "Service" && wildcardMatches(expected.value, actual.service, true);
  return actual.type === "AWS" && awsPrincipalMatches(expected.value, actual);
}

function cidrMatches(actual: string, expected: string): boolean {
  const [network, prefixText] = expected.split("/");
  if (prefixText === undefined) return actual === network;
  const family = isIP(network);
  if (!family || isIP(actual) !== family) return false;
  try {
    const block = new BlockList();
    block.addSubnet(network, Number(prefixText), family === 4 ? "ipv4" : "ipv6");
    return block.check(actual, family === 4 ? "ipv4" : "ipv6");
  } catch { return false; }
}

function compareCondition(base: string, actualValue: unknown, expectedValues: Array<string | number | boolean>, context: AuthorizationContext): boolean {
  const actual = String(actualValue);
  const expected = expectedValues.map(value => typeof value === "string" ? policyVariable(value, context) : value);
  switch (base) {
    case "Null": return (actualValue === undefined || actualValue === null) === (String(expected[0]).toLowerCase() === "true");
    case "Bool": return actual.toLowerCase() === String(expected[0]).toLowerCase();
    case "BinaryEquals": return expected.some(value => Buffer.from(actual, "base64").equals(Buffer.from(String(value), "base64")));
    case "IpAddress": return expected.some(value => cidrMatches(actual, String(value)));
    case "NotIpAddress": return expected.every(value => !cidrMatches(actual, String(value)));
  }
  if (base.startsWith("Numeric")) {
    const left = Number(actual);
    if (!Number.isFinite(left)) return false;
    return expected.some(value => {
      const right = Number(value);
      if (base === "NumericEquals") return left === right;
      if (base === "NumericNotEquals") return left !== right;
      if (base === "NumericLessThan") return left < right;
      if (base === "NumericLessThanEquals") return left <= right;
      if (base === "NumericGreaterThan") return left > right;
      return left >= right;
    });
  }
  if (base.startsWith("Date")) {
    const left = Date.parse(actual);
    if (!Number.isFinite(left)) return false;
    return expected.some(value => {
      const right = Date.parse(String(value));
      if (base === "DateEquals") return left === right;
      if (base === "DateNotEquals") return left !== right;
      if (base === "DateLessThan") return left < right;
      if (base === "DateLessThanEquals") return left <= right;
      if (base === "DateGreaterThan") return left > right;
      return left >= right;
    });
  }
  const insensitive = base.includes("IgnoreCase");
  const like = base.includes("Like");
  const negative = base.includes("Not");
  const matches = (value: string): boolean => like ? wildcardMatches(value, actual, insensitive) : insensitive ? value.toLowerCase() === actual.toLowerCase() : value === actual;
  return negative ? expected.every(value => !matches(String(value))) : expected.some(value => matches(String(value)));
}

function conditionMatches(condition: PolicyStatement["Condition"], context: AuthorizationContext): boolean {
  if (!condition) return true;
  for (const [rawOperator, entries] of Object.entries(condition)) {
    const operator = parseConditionOperator(rawOperator);
    for (const [key, rawExpected] of Object.entries(entries)) {
      const actual = contextValue(context, key);
      if (actual === undefined && operator.base !== "Null") {
        if (operator.ifExists) continue;
        return false;
      }
      const actualValues = Array.isArray(actual) ? actual : [actual];
      const expected = conditionValues(rawExpected, `${rawOperator}.${key}`);
      const checks = actualValues.map(value => compareCondition(operator.base, value, expected, context));
      const matches = operator.qualifier === "ForAllValues" ? checks.every(Boolean) : checks.some(Boolean);
      if (!matches) return false;
    }
  }
  return true;
}

function statementMatches(statement: PolicyStatement, principal: SqsPolicyPrincipal, action: string, resource: string, context: AuthorizationContext): boolean {
  const requestedAction = sqsAuthorizationAction(action);
  const actionValues = list(statement.Action ?? statement.NotAction, "Action");
  const actionMatched = actionValues.some(value => wildcardMatches(value === "*" ? value : sqsAuthorizationAction(value), requestedAction, true));
  if (statement.Action !== undefined ? !actionMatched : actionMatched) return false;
  const resources = list(statement.Resource ?? statement.NotResource, "Resource");
  const resourceMatched = resources.some(value => wildcardMatches(policyVariable(value, context), resource));
  if (statement.Resource !== undefined ? !resourceMatched : resourceMatched) return false;
  const expectedPrincipals = principalValues(statement.Principal ?? statement.NotPrincipal);
  const matchedPrincipal = expectedPrincipals.some(value => principalMatches(value, principal));
  if (statement.Principal !== undefined ? !matchedPrincipal : matchedPrincipal) return false;
  return conditionMatches(statement.Condition, context);
}

function evaluationContext(principal: SqsPolicyPrincipal, context: AuthorizationContext): AuthorizationContext {
  if (principal.type === "Service") return {
    "aws:PrincipalIsAWSService": true,
    "aws:PrincipalServiceName": principal.service,
    ...context,
  };
  const accountId = principal.accountId ?? accountFromArn(principal.arn);
  return {
    "aws:PrincipalArn": principal.arn,
    ...(accountId ? { "aws:PrincipalAccount": accountId } : {}),
    ...context,
  };
}

/** Evaluates only the queue resource policy. Identity/resource-policy composition remains in the shared IAM layer. */
export function evaluateSqsQueuePolicy(
  policy: string | PolicyDocument | undefined,
  principal: SqsPolicyPrincipal,
  action: string,
  resource: string,
  context: AuthorizationContext = {},
): AuthorizationResult {
  const document = asDocument(policy);
  if (!document) return { decision: "implicitDeny", reason: "The queue has no resource policy", matchedStatements: [] };
  const evaluatedContext = evaluationContext(principal, context);
  let allowed = false;
  const matchedStatements: string[] = [];
  for (const [index, statement] of (Array.isArray(document.Statement) ? document.Statement : [document.Statement]).entries()) {
    if (!statementMatches(statement, principal, action, resource, evaluatedContext)) continue;
    matchedStatements.push(statement.Sid ?? `${statement.Effect}:${index + 1}`);
    if (statement.Effect === "Deny") return { decision: "explicitDeny", reason: "An applicable SQS queue-policy statement explicitly denies the action", matchedStatements };
    allowed = true;
  }
  return allowed
    ? { decision: "allowed", reason: "An applicable SQS queue-policy statement allows the action", matchedStatements }
    : { decision: "implicitDeny", reason: "No applicable SQS queue-policy Allow statement was found", matchedStatements };
}
