import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import {
  buildSchema,
  defaultFieldResolver,
  execute,
  getArgumentValues,
  getIntrospectionQuery,
  getOperationAST,
  getVariableValues,
  GraphQLError,
  graphql,
  isObjectType,
  isScalarType,
  Kind,
  NoSchemaIntrospectionCustomRule,
  parse,
  printSchema,
  specifiedRules,
  validate,
  validateSchema,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLFieldResolver,
  type GraphQLObjectType,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from "graphql";
import WebSocket, { WebSocketServer } from "ws";
import { EncryptedMaterialStore, type MaterialBinding } from "./configuration-secrets/encrypted-material-store.js";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import type { TelemetryBus } from "./core/telemetry.js";
import type { DynamoDbService } from "./dynamodb.js";
import { AwsError } from "./errors.js";
import type { PrincipalContext } from "./auth/sigv4.js";
import { evaluateTrust } from "./iam/evaluator.js";
import { executeDynamoResolver, validateDynamoResolverTemplates } from "./appsync/dynamodb-resolver.js";
import { executeNoneResolver, validateNoneResolverTemplates } from "./appsync/none-resolver.js";
import {
  AppSyncVtlError,
  evaluateAppSyncVtl,
  validateAppSyncVtl,
  type AppSyncVtlErrorShape,
} from "./appsync/vtl.js";
import type { StateStore } from "./state.js";
import type {
  AppSyncApiKeyState,
  AppSyncDataSourceState,
  AppSyncFunctionState,
  AppSyncGraphqlApiState,
  AppSyncResolverState,
} from "./types.js";
import { readBody } from "./util.js";
import {
  appSyncApiKeyOwnershipKey,
  appSyncFunctionOwnershipKey,
  appSyncResolverOwnershipKey,
  appSyncSchemaOwnershipKey,
  beginHotswapDrift,
  completeHotswapDrift,
  failHotswapDrift,
  hotswapCheckpoint,
  isPinnedCdkHotswapRequest,
  uniqueCompletedOwner,
} from "./cloudformation/hotswap.js";

const CONTROL_BODY_LIMIT = 1024 * 1024;
const SCHEMA_LIMIT = 1024 * 1024;
const GRAPHQL_BODY_LIMIT = 1024 * 1024;
const GRAPHQL_QUERY_LIMIT = 256 * 1024;
const GRAPHQL_VARIABLES_LIMIT = 256 * 1024;
const GRAPHQL_RESPONSE_LIMIT = 1024 * 1024;
const GRAPHQL_DEPTH_LIMIT = 75;
const GRAPHQL_RESOLVER_COUNT_LIMIT = 1000;
const GRAPHQL_CONCURRENCY_LIMIT = 50;
const API_LIMIT = 100;
const API_KEY_LIMIT = 50;
const DATA_SOURCE_LIMIT = 50;
const RESOLVER_LIMIT = 1000;
const FUNCTION_LIMIT = 100;
const MAX_TAGS = 50;
const APPSYNC_SCALARS = [
  "AWSDate", "AWSTime", "AWSDateTime", "AWSTimestamp", "AWSEmail",
  "AWSJSON", "AWSURL", "AWSPhone", "AWSIPAddress",
] as const;
const APPSYNC_SCALAR_SDL = APPSYNC_SCALARS.map(name => `scalar ${name}`).join("\n");
const APPSYNC_AUTH_DIRECTIVE_SDL = [
  "directive @aws_api_key on OBJECT | FIELD_DEFINITION",
  "directive @aws_iam on OBJECT | FIELD_DEFINITION",
  "directive @aws_subscribe(mutations: [String!]!) on FIELD_DEFINITION",
].join("\n");

export interface AppSyncIamAuthorizationResult {
  decision: "allowed" | "implicitDeny" | "explicitDeny";
  reason: string;
}

export interface AppSyncIamHooks {
  authenticate(req: IncomingMessage, url: URL): Promise<PrincipalContext>;
  authenticateRealtime(
    headers: Record<string, string>,
    url: URL,
    body: Buffer,
  ): Promise<PrincipalContext>;
  identityValid(principal: PrincipalContext): boolean;
  authorize(
    principal: PrincipalContext,
    resource: string,
    context: Record<string, unknown>,
    requestId: string,
  ): Promise<AppSyncIamAuthorizationResult>;
}

type GraphqlAuthorizationMode = "API_KEY" | "AWS_IAM";

export const APPSYNC_REALTIME_LIMITS = Object.freeze({
  connectionsPerRegion: 100,
  connectionsPerApi: 50,
  registrationsPerConnection: 100,
  registrationsPerApi: 1000,
  incomingMessageBytes: 256 * 1024,
  outgoingMessageBytes: 1024 * 1024,
  authorizationHeaderBytes: 16 * 1024,
  queryBytes: GRAPHQL_QUERY_LIMIT,
  variablesBytes: GRAPHQL_VARIABLES_LIMIT,
  documentDepth: GRAPHQL_DEPTH_LIMIT,
  documentFields: GRAPHQL_RESOLVER_COUNT_LIMIT,
  registrationQueueMessages: 16,
  registrationQueueBytes: 1024 * 1024,
  connectionQueueMessages: 64,
  connectionQueueBytes: 4 * 1024 * 1024,
  fanoutPerMutation: 1000,
  initializationMs: 15_000,
  keepAliveMs: 60_000,
  idleMs: 5 * 60_000,
  lifetimeMs: 2 * 60 * 60_000,
});

type RealtimeAuth =
  | { mode: "API_KEY"; keyId: string; identityKey: string }
  | { mode: "AWS_IAM"; principal: PrincipalContext; identityKey: string };

interface RealtimeRegistration {
  id: string;
  apiId: string;
  apiGeneration: string;
  schemaGeneration: string;
  authorizationGeneration: string;
  resolverGeneration: string;
  connectionId: string;
  operationName?: string;
  document: DocumentNode;
  variables: Record<string, unknown>;
  fieldName: string;
  responseKey: string;
  mutationLinks: string[];
  filter?: Record<string, unknown>;
  auth: RealtimeAuth;
  queuedMessages: number;
  queuedBytes: number;
  registeredAt: number;
}

interface RealtimeQueuedMessage {
  bytes: Buffer;
  registrationId?: string;
}

interface RealtimeMutationCompletion {
  api: AppSyncGraphqlApiState;
  fieldName: string;
  value: unknown;
  candidates: Array<{ connection: RealtimeConnection; registration: RealtimeRegistration }>;
}

interface RealtimeConnection {
  id: string;
  apiId: string;
  apiGeneration: string;
  auth: RealtimeAuth;
  socket: WebSocket;
  initialized: boolean;
  openedAt: number;
  lastActivityAt: number;
  registrations: Map<string, RealtimeRegistration>;
  queue: RealtimeQueuedMessage[];
  queuedBytes: number;
  sending: boolean;
  initTimer: ReturnType<typeof setTimeout>;
  keepAliveTimer?: ReturnType<typeof setTimeout>;
  lifecycleTimer?: ReturnType<typeof setTimeout>;
}

export interface AppSyncRealtimeDiagnostic {
  time: number;
  signal: "connection-admit" | "connection-close" | "registration-admit" | "registration-reject"
    | "registration-stop" | "mutation-complete" | "authorization-admit" | "filter-admit"
    | "filter-reject" | "queue-drop" | "socket-delivery" | "socket-delivery-failure";
  apiId: string;
  connectionId?: string;
  registrationId?: string;
  authenticationType?: GraphqlAuthorizationMode;
  reason?: string;
}

export type AppSyncRealtimeFailureStage = "registration-admission" | "mutation-completion" | "queueing" | "socket-send";
export type AppSyncRealtimeFaultInjector = (stage: AppSyncRealtimeFailureStage, context: {
  apiId: string;
  connectionId?: string;
  authenticationType?: GraphqlAuthorizationMode;
}) => boolean | "stall";

function directiveBoolean(node: FieldNode | FragmentDefinitionNode, name: "skip" | "include", variables: Record<string, unknown>): boolean | undefined {
  const directive = node.directives?.find(candidate => candidate.name.value === name);
  const value = directive?.arguments?.find(argument => argument.name.value === "if")?.value;
  if (!value) return undefined;
  if (value.kind === Kind.BOOLEAN) return value.value;
  if (value.kind === Kind.VARIABLE) return variables[value.name.value] as boolean | undefined;
  return undefined;
}

function included(node: FieldNode | FragmentDefinitionNode, variables: Record<string, unknown>): boolean {
  return directiveBoolean(node, "skip", variables) !== true && directiveBoolean(node, "include", variables) !== false;
}

function selectedRootFieldNames(
  document: DocumentNode,
  operation: OperationDefinitionNode,
  variables: Record<string, unknown>,
): string[] {
  const fragments = new Map(document.definitions
    .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
    .map(fragment => [fragment.name.value, fragment]));
  const fields = new Set<string>();
  const visited = new Set<string>();
  const collect = (selectionSet: SelectionSetNode): void => {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        if (included(selection, variables)) fields.add(selection.name.value);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        if (included(selection as any, variables)) collect(selection.selectionSet);
      } else {
        const fragment = fragments.get(selection.name.value);
        if (!fragment || visited.has(fragment.name.value) || !included(selection as any, variables)
          || !included(fragment, variables)) continue;
        visited.add(fragment.name.value);
        collect(fragment.selectionSet);
      }
    }
  };
  collect(operation.selectionSet);
  return [...fields];
}

function selectedRootFields(
  document: DocumentNode,
  operation: OperationDefinitionNode,
  variables: Record<string, unknown>,
): Array<{ field: FieldNode; fieldName: string; responseKey: string }> {
  const fragments = new Map(document.definitions
    .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
    .map(fragment => [fragment.name.value, fragment]));
  const result = new Map<string, { field: FieldNode; fieldName: string; responseKey: string }>();
  const visiting = new Set<string>();
  const collect = (selectionSet: SelectionSetNode): void => {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        if (!included(selection, variables)) continue;
        const responseKey = selection.alias?.value ?? selection.name.value;
        result.set(responseKey, { field: selection, fieldName: selection.name.value, responseKey });
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        if (included(selection as any, variables)) collect(selection.selectionSet);
      } else {
        const fragment = fragments.get(selection.name.value);
        if (!fragment || visiting.has(fragment.name.value) || !included(selection as any, variables)
          || !included(fragment, variables)) continue;
        visiting.add(fragment.name.value);
        collect(fragment.selectionSet);
        visiting.delete(fragment.name.value);
      }
    }
  };
  collect(operation.selectionSet);
  return [...result.values()];
}

function realtimeError(message: string, errorType = "BadRequestException"): { errors: Array<{ errorType: string; message: string }> } {
  return { errors: [{ errorType, message }] };
}

function normalizeRealtimeHeaders(value: Record<string, unknown>): Record<string, string> {
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 16) throw new Error();
  const headers: Record<string, string> = {};
  for (const [name, raw] of entries) {
    const normalized = name.toLowerCase();
    if (!/^[a-z0-9-]+$/i.test(name) || typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 8192
      || Object.hasOwn(headers, normalized)) throw new Error();
    headers[normalized] = raw;
  }
  if (Buffer.byteLength(JSON.stringify(headers), "utf8") > APPSYNC_REALTIME_LIMITS.authorizationHeaderBytes) throw new Error();
  return headers;
}

function decodeRealtimeHeader(value: string): Record<string, string> {
  if (!value || Buffer.byteLength(value, "utf8") > APPSYNC_REALTIME_LIMITS.authorizationHeaderBytes) {
    throw new AwsError("BadRequestException", "The realtime authorization header is invalid.", 400);
  }
  try {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new Error();
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - normalized.length % 4) % 4);
    const bytes = Buffer.from(`${normalized}${padding}`, "base64");
    if (bytes.toString("base64url") !== value.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")) throw new Error();
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!validObject(parsed)) throw new Error();
    return normalizeRealtimeHeaders(parsed);
  } catch {
    throw new AwsError("BadRequestException", "The realtime authorization header is invalid.", 400);
  }
}

function realtimeFilterMatches(filter: Record<string, unknown> | undefined, value: unknown): boolean {
  if (!filter || !Object.keys(filter).length) return true;
  if (!validObject(value)) return false;
  const compare = (actual: unknown, condition: Record<string, unknown>): boolean => Object.entries(condition).every(([operator, expected]) => {
    const candidates = Array.isArray(expected) ? expected : [expected];
    if (operator === "eq") return actual === expected;
    if (operator === "ne") return actual !== expected;
    if (operator === "lt") return typeof actual === typeof expected && (actual as any) < (expected as any);
    if (operator === "le") return typeof actual === typeof expected && (actual as any) <= (expected as any);
    if (operator === "gt") return typeof actual === typeof expected && (actual as any) > (expected as any);
    if (operator === "ge") return typeof actual === typeof expected && (actual as any) >= (expected as any);
    if (operator === "contains") return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    if (operator === "notContains") return typeof actual === "string" && typeof expected === "string" && !actual.includes(expected);
    if (operator === "beginsWith") return typeof actual === "string" && typeof expected === "string" && actual.startsWith(expected);
    if (operator === "between") return candidates.length === 2 && typeof actual === typeof candidates[0]
      && (actual as any) >= candidates[0] && (actual as any) <= candidates[1];
    if (operator === "in") return candidates.some(candidate => actual === candidate);
    if (operator === "notIn") return candidates.every(candidate => actual !== candidate);
    return false;
  });
  for (const [field, condition] of Object.entries(filter)) {
    if (field === "and") {
      if (!Array.isArray(condition) || !condition.every(candidate => validObject(candidate) && realtimeFilterMatches(candidate, value))) return false;
    } else if (field === "or") {
      if (!Array.isArray(condition) || !condition.some(candidate => validObject(candidate) && realtimeFilterMatches(candidate, value))) return false;
    } else if (!validObject(condition) || !compare(value[field], condition)) return false;
  }
  return true;
}

function authDirectiveNames(type: GraphQLObjectType, fieldName: string): Set<string> {
  const field = type.getFields()[fieldName];
  const fieldNames = field?.astNode?.directives?.map(directive => directive.name.value) ?? [];
  if (fieldNames.some(name => name === "aws_api_key" || name === "aws_iam")) return new Set(fieldNames);
  const typeNames = [type.astNode, ...(type.extensionASTNodes ?? [])]
    .flatMap(node => node?.directives?.map(directive => directive.name.value) ?? []);
  return new Set(typeNames);
}

function schemaAllowsMode(type: GraphQLObjectType, fieldName: string, mode: GraphqlAuthorizationMode): boolean {
  if (fieldName.startsWith("__")) return true;
  const directives = authDirectiveNames(type, fieldName);
  if (mode === "AWS_IAM") return directives.has("aws_iam");
  return directives.size === 0 || directives.has("aws_api_key");
}

function controlJson(res: ServerResponse, value: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(value));
}

function sendControlError(res: ServerResponse, error: unknown): void {
  const aws = error instanceof AwsError
    ? error
    : new AwsError("InternalFailureException", "The AppSync request failed internally.", 500);
  controlJson(res, { message: aws.message, __type: aws.code }, aws.status);
}

function graphqlError(res: ServerResponse, status: number, errorType: string, message: string): void {
  controlJson(res, { errors: [{ errorType, message }] }, status);
}

function validObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function graphqlPath(path: { key: string | number; prev?: any } | undefined): Array<string | number> {
  const result: Array<string | number> = [];
  for (let current = path; current; current = current.prev) result.push(current.key);
  return result.reverse();
}

function lexicalQueryDepth(source: string): number {
  let depth = 0;
  let maximum = 0;
  let quote: '"' | "'" | undefined;
  let blockString = false;
  let escaped = false;
  let comment = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (comment) {
      if (character === "\n" || character === "\r") comment = false;
      continue;
    }
    if (blockString) {
      if (source.slice(index, index + 3) === '"""') {
        blockString = false;
        index += 2;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (source.slice(index, index + 3) === '"""') {
      blockString = true;
      index += 2;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") {
      comment = true;
      continue;
    }
    if (character === "{") {
      depth++;
      maximum = Math.max(maximum, depth);
    } else if (character === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  return maximum;
}

function selectedOperation(document: DocumentNode, operationName: string | undefined) {
  const operations = document.definitions.filter(definition => definition.kind === Kind.OPERATION_DEFINITION);
  if (operationName) return operations.find(operation => operation.name?.value === operationName);
  return operations.length === 1 ? operations[0] : undefined;
}

function operationLimitError(source: string, operationName: string | undefined): string | undefined {
  let document: DocumentNode;
  try { document = parse(source); }
  catch {
    return lexicalQueryDepth(source) > GRAPHQL_DEPTH_LIMIT
      ? `The GraphQL operation exceeds the local depth limit of ${GRAPHQL_DEPTH_LIMIT}.`
      : undefined;
  }
  const operation = selectedOperation(document, operationName);
  if (!operation) return undefined;
  const fragments = new Map(document.definitions
    .filter(definition => definition.kind === Kind.FRAGMENT_DEFINITION)
    .map(fragment => [fragment.name.value, fragment]));
  let fields = 0;
  let maximumDepth = 0;
  const walk = (selectionSet: SelectionSetNode, depth: number, stack: Set<string>): void => {
    maximumDepth = Math.max(maximumDepth, depth);
    if (maximumDepth > GRAPHQL_DEPTH_LIMIT || fields > GRAPHQL_RESOLVER_COUNT_LIMIT) return;
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        fields++;
        if (selection.selectionSet) walk(selection.selectionSet, depth + 1, stack);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        walk(selection.selectionSet, depth, stack);
      } else {
        const fragment = fragments.get(selection.name.value);
        if (!fragment || stack.has(fragment.name.value)) continue;
        const next = new Set(stack);
        next.add(fragment.name.value);
        walk(fragment.selectionSet, depth, next);
      }
      if (maximumDepth > GRAPHQL_DEPTH_LIMIT || fields > GRAPHQL_RESOLVER_COUNT_LIMIT) return;
    }
  };
  walk(operation.selectionSet, 1, new Set());
  if (maximumDepth > GRAPHQL_DEPTH_LIMIT) {
    return `The GraphQL operation exceeds the local depth limit of ${GRAPHQL_DEPTH_LIMIT}.`;
  }
  if (fields > GRAPHQL_RESOLVER_COUNT_LIMIT) {
    return `The GraphQL operation exceeds the local resolver-count limit of ${GRAPHQL_RESOLVER_COUNT_LIMIT}.`;
  }
  return undefined;
}

function resolverHeaders(req: IncomingMessage): Record<string, string> {
  const blocked = new Set([
    "authorization", "cookie", "set-cookie", "x-api-key", "x-amz-security-token",
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
  ]);
  return Object.fromEntries(Object.entries(req.headers)
    .filter(([name, value]) => !blocked.has(name.toLowerCase()) && value !== undefined)
    .map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(",") : String(value)]));
}

function requireString(value: unknown, name: string, maximum = 65_536): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new AwsError("BadRequestException", `${name} must be a non-empty string no longer than ${maximum} characters.`, 400);
  }
  return value;
}

function requireGraphqlName(value: unknown, name: string): string {
  const result = requireString(value, name, 64);
  if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(result)) {
    throw new AwsError("BadRequestException", `${name} must be a valid GraphQL name.`, 400);
  }
  return result;
}

function decodePathPart(value: string, name: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || encodeURIComponent(decoded) !== value) throw new Error();
    return decoded;
  } catch {
    throw new AwsError("BadRequestException", `Invalid ${name}.`, 400);
  }
}

function rejectUnknown(input: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(input).filter(key => !accepted.has(key));
  if (unknown.length) {
    throw new AwsError("BadRequestException", `Unsupported request member: ${unknown.sort()[0]}.`, 400);
  }
}

function validateTags(value: unknown): Record<string, string> {
  if (!validObject(value)) throw new AwsError("BadRequestException", "tags must be a string map.", 400);
  const tags: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!key || key.length > 128 || key.toLowerCase().startsWith("aws:")
      || typeof candidate !== "string" || candidate.length > 256) {
      throw new AwsError("BadRequestException", "Tag keys and values are invalid.", 400);
    }
    tags[key] = candidate;
  }
  if (Object.keys(tags).length > MAX_TAGS) {
    throw new AwsError("LimitExceededException", `A GraphQL API can have at most ${MAX_TAGS} tags.`, 400);
  }
  return tags;
}

function maxResults(url: URL): number {
  const value = url.searchParams.has("maxResults") ? Number(url.searchParams.get("maxResults")) : 25;
  if (!Number.isInteger(value) || value < 1 || value > 25) {
    throw new AwsError("BadRequestException", "maxResults must be an integer from 1 through 25.", 400);
  }
  return value;
}

function scalarError(name: string): never {
  throw new GraphQLError(`Value is not a valid ${name}.`);
}

function validDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function coerceAppSyncScalar(name: typeof APPSYNC_SCALARS[number], value: unknown): unknown {
  if (name === "AWSTimestamp") {
    if (!Number.isSafeInteger(value)) scalarError(name);
    return value;
  }
  if (name === "AWSJSON") {
    if (typeof value === "string") {
      try { return JSON.parse(value); } catch { scalarError(name); }
    }
    try {
      if (JSON.stringify(value) === undefined) scalarError(name);
      return value;
    } catch {
      scalarError(name);
    }
  }
  if (typeof value !== "string") scalarError(name);
  if (name === "AWSDate" && !validDate(value)) scalarError(name);
  if (name === "AWSTime" && !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) scalarError(name);
  if (name === "AWSDateTime"
    && (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
      || !validDate(value.slice(0, 10)))) scalarError(name);
  if (name === "AWSEmail" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) scalarError(name);
  if (name === "AWSURL") {
    try {
      const parsed = new URL(value);
      if (!parsed.protocol || !parsed.hostname) scalarError(name);
    } catch {
      scalarError(name);
    }
  }
  if (name === "AWSPhone" && !/^\+?[0-9 ()-]{7,30}$/.test(value)) scalarError(name);
  if (name === "AWSIPAddress") {
    const address = value.split("/", 1)[0];
    const suffix = value.includes("/") ? Number(value.slice(value.indexOf("/") + 1)) : undefined;
    const version = isIP(address);
    if (!version || (suffix !== undefined && (!Number.isInteger(suffix) || suffix < 0 || suffix > (version === 4 ? 32 : 128)))) scalarError(name);
  }
  return value;
}

function configureAppSyncScalars(schema: GraphQLSchema): void {
  for (const name of APPSYNC_SCALARS) {
    const scalar = schema.getType(name);
    if (!scalar || !isScalarType(scalar)) continue;
    const output = (value: unknown) => coerceAppSyncScalar(name, value);
    const input = (value: unknown) => coerceAppSyncScalar(name, value);
    const literal = (node: any) => {
      if (name === "AWSTimestamp") {
        if (node.kind !== Kind.INT) scalarError(name);
        return coerceAppSyncScalar(name, Number(node.value));
      }
      if (node.kind !== Kind.STRING) scalarError(name);
      return coerceAppSyncScalar(name, node.value);
    };
    scalar.serialize = output;
    scalar.coerceOutputValue = output;
    scalar.parseValue = input;
    scalar.coerceInputValue = input;
    scalar.parseLiteral = literal;
    scalar.coerceInputLiteral = literal;
  }
}

export class AppSyncService {
  private readonly materials: EncryptedMaterialStore;
  private readonly schemas = new Map<string, { definition: string; schema: GraphQLSchema }>();
  private readonly realtimeServer: WebSocketServer;
  private readonly realtimeConnections = new Map<string, RealtimeConnection>();
  private readonly realtimeSignals: AppSyncRealtimeDiagnostic[] = [];
  private realtimeFaultInjector?: AppSyncRealtimeFaultInjector;
  private activeGraphqlRequests = 0;

  private get tokens(): PaginationTokens {
    return new PaginationTokens(this.store.state.installation.paginationSecret);
  }

  constructor(
    private readonly store: StateStore,
    readonly region: string,
    private readonly clock: Clock,
    private readonly endpoint: () => string,
    private readonly dynamodb?: DynamoDbService,
    private readonly assumeServiceRole?: (
      roleArn: string,
      sessionName: string,
      servicePrincipal: string,
    ) => Promise<PrincipalContext>,
    private readonly telemetry?: TelemetryBus,
    private readonly iamHooks?: AppSyncIamHooks,
  ) {
    this.materials = new EncryptedMaterialStore(store.root, "appsync");
    this.realtimeServer = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      handleProtocols: protocols => protocols.has("graphql-ws") ? "graphql-ws" : false,
    });
  }

  private realtimeSignal(event: Omit<AppSyncRealtimeDiagnostic, "time">): void {
    this.realtimeSignals.push({
      time: this.clock.now(),
      ...event,
      ...(event.registrationId === undefined ? {} : {
        registrationId: createHash("sha256").update(`${event.apiId}\0${event.registrationId}`).digest("hex").slice(0, 16),
      }),
    });
    if (this.realtimeSignals.length > 256) this.realtimeSignals.splice(0, this.realtimeSignals.length - 256);
  }

  realtimeDiagnostics(): {
    limits: typeof APPSYNC_REALTIME_LIMITS;
    connections: number;
    registrations: number;
    byApi: Array<{ apiId: string; connections: number; registrations: number }>;
    signals: AppSyncRealtimeDiagnostic[];
    durability: "process-local-no-replay";
  } {
    const byApi = new Map<string, { apiId: string; connections: number; registrations: number }>();
    let registrations = 0;
    for (const connection of this.realtimeConnections.values()) {
      const entry = byApi.get(connection.apiId) ?? { apiId: connection.apiId, connections: 0, registrations: 0 };
      entry.connections++;
      entry.registrations += connection.registrations.size;
      registrations += connection.registrations.size;
      byApi.set(connection.apiId, entry);
    }
    return {
      limits: APPSYNC_REALTIME_LIMITS,
      connections: this.realtimeConnections.size,
      registrations,
      byApi: [...byApi.values()].sort((left, right) => left.apiId.localeCompare(right.apiId)),
      signals: this.realtimeSignals.map(signal => ({ ...signal })),
      durability: "process-local-no-replay",
    };
  }

  /** Test-only, process-local failure boundary. The callback receives no documents, variables, credentials, or payloads. */
  setRealtimeFaultInjector(injector?: AppSyncRealtimeFaultInjector): void {
    this.realtimeFaultInjector = injector;
  }

  private authorizationGeneration(api: AppSyncGraphqlApiState): string {
    return createHash("sha256").update(JSON.stringify({
      apiGeneration: api.generation,
      authenticationType: api.authenticationType,
      additional: api.additionalAuthenticationProviders.map(provider => provider.authenticationType).sort(),
    })).digest("hex");
  }

  private realtimeResolverGeneration(api: AppSyncGraphqlApiState): string {
    const dataSources = Object.values(api.dataSources).map(value => [value.name, value.generation, value.revision]).sort();
    const functions = Object.values(api.functions).map(value => [value.functionId, value.generation, value.revision]).sort();
    const resolvers = Object.values(api.resolvers).map(value => [
      value.typeName, value.fieldName, value.generation, value.revision,
      ...(value.pipelineConfig?.functions ?? []),
    ]).sort();
    return createHash("sha256").update(JSON.stringify({ dataSources, functions, resolvers })).digest("hex");
  }

  private apiConnectionCount(apiId: string): number {
    let count = 0;
    for (const connection of this.realtimeConnections.values()) if (connection.apiId === apiId) count++;
    return count;
  }

  private apiRegistrationCount(apiId: string): number {
    let count = 0;
    for (const connection of this.realtimeConnections.values()) if (connection.apiId === apiId) count += connection.registrations.size;
    return count;
  }

  private async realtimeAuth(
    api: AppSyncGraphqlApiState,
    headers: Record<string, string>,
    body: Buffer,
    connect: boolean,
  ): Promise<RealtimeAuth> {
    const expectedHost = new URL(api.uris.GRAPHQL).host;
    if (headers.host !== expectedHost) throw new AwsError("UnauthorizedException", "The realtime authorization host is invalid.", 401);
    const hasKey = typeof headers["x-api-key"] === "string";
    const hasIam = typeof headers.authorization === "string";
    if (hasKey === hasIam) throw new AwsError("UnauthorizedException", "Specify exactly one realtime authorization mode.", 401);
    if (hasKey) {
      const allowed = new Set(["host", "x-amz-date", "x-api-key", "x-amz-user-agent"]);
      if (Object.keys(headers).some(name => !allowed.has(name))) throw new AwsError("UnauthorizedException", "The API-key realtime authorization header is invalid.", 401);
      const date = headers["x-amz-date"];
      const match = date?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      const requestTime = match ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) : NaN;
      if (!Number.isFinite(requestTime) || Math.abs(this.clock.now() - requestTime) > 5 * 60_000) {
        throw new AwsError("RequestExpired", "The realtime authorization request has expired.", 401);
      }
      const key = await this.findKey(api, headers["x-api-key"]);
      if (!key || key.expires <= Math.floor(this.clock.now() / 1000)) {
        throw new AwsError("UnauthorizedException", "You are not authorized to make this call.", 401);
      }
      return {
        mode: "API_KEY",
        keyId: key.keyId,
        identityKey: createHash("sha256").update(`API_KEY\0${api.apiId}\0${key.keyId}`).digest("hex"),
      };
    }
    if (!api.additionalAuthenticationProviders.some(provider => provider.authenticationType === "AWS_IAM")
      || !this.iamHooks) throw new AwsError("UnauthorizedException", "AWS_IAM is not active for this API.", 401);
    const allowed = new Set([
      "accept", "accept-encoding", "amz-sdk-invocation-id", "amz-sdk-request", "authorization",
      "content-encoding", "content-type", "host", "user-agent", "x-amz-content-sha256", "x-amz-date",
      "x-amz-security-token", "x-amz-user-agent",
    ]);
    if (Object.keys(headers).some(name => !allowed.has(name))) throw new AwsError("UnauthorizedException", "The IAM realtime authorization header is invalid.", 401);
    const signedUrl = new URL(connect ? `${api.uris.GRAPHQL}/connect` : api.uris.GRAPHQL);
    const principal = await this.iamHooks.authenticateRealtime(headers, signedUrl, body);
    if (principal.accountId !== api.owner) throw new AwsError("AccessDeniedException", "Cross-account AppSync realtime access is not supported.", 403);
    return {
      mode: "AWS_IAM",
      principal,
      identityKey: createHash("sha256").update(`AWS_IAM\0${api.apiId}\0${principal.principalArn}\0${principal.accessKeyId}`).digest("hex"),
    };
  }

  private realtimeAuthMatches(left: RealtimeAuth, right: RealtimeAuth): boolean {
    return left.mode === right.mode && left.identityKey === right.identityKey;
  }

  private rejectRealtimeUpgrade(socket: Socket, status: number, message: string): void {
    const body = Buffer.from(JSON.stringify(realtimeError(message)), "utf8");
    socket.end(`HTTP/1.1 ${status} ${status === 429 ? "Too Many Requests" : status === 404 ? "Not Found" : "Unauthorized"}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
  }

  async upgradeRealtime(req: IncomingMessage, socket: Socket, head: Buffer, apiId: string, url: URL): Promise<void> {
    try {
      const api = this.requireApi(apiId);
      if (!api.schema || url.pathname !== `/graphql/${encodeURIComponent(this.region)}/${encodeURIComponent(apiId)}/realtime`) {
        throw new AwsError("NotFoundException", "The AppSync realtime endpoint was not found.", 404);
      }
      const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim()).filter(Boolean);
      if (!protocols.includes("graphql-ws")) throw new AwsError("BadRequestException", "The graphql-ws subprotocol is required.", 400);
      const protocolHeaders = protocols.filter(value => value.startsWith("header-")).map(value => decodeRealtimeHeader(value.slice(7)));
      if (protocolHeaders.length > 1) throw new AwsError("BadRequestException", "Specify one realtime authorization header.", 400);
      const queryHeader = url.searchParams.get("header");
      const queryHeaders = queryHeader === null ? undefined : decodeRealtimeHeader(queryHeader);
      if (url.searchParams.has("header")) {
        const payload = url.searchParams.get("payload");
        if (payload === null || payload.length > 128 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(payload)
          || url.searchParams.getAll("header").length !== 1 || url.searchParams.getAll("payload").length !== 1) {
          throw new AwsError("BadRequestException", "The realtime payload encoding is required.", 400);
        }
        const bytes = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64");
        if (bytes.toString("base64url") !== payload.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")) {
          throw new AwsError("BadRequestException", "The realtime payload encoding is invalid.", 400);
        }
        const decoded = bytes.toString("utf8");
        const parsed = JSON.parse(decoded);
        if (!validObject(parsed) || Object.keys(parsed).length) throw new AwsError("BadRequestException", "The realtime payload encoding is invalid.", 400);
      } else if (url.searchParams.has("payload")) throw new AwsError("BadRequestException", "The realtime header encoding is required.", 400);
      if ([...url.searchParams.keys()].some(name => name !== "header" && name !== "payload")) {
        throw new AwsError("BadRequestException", "Unsupported realtime query parameters were supplied.", 400);
      }
      if (queryHeaders && protocolHeaders[0] && JSON.stringify(queryHeaders) !== JSON.stringify(protocolHeaders[0])) {
        throw new AwsError("UnauthorizedException", "Realtime authorization encodings do not match.", 401);
      }
      const encodedHeaders = queryHeaders ?? protocolHeaders[0];
      if (!encodedHeaders) throw new AwsError("UnauthorizedException", "Realtime authorization is required.", 401);
      if (this.realtimeConnections.size >= APPSYNC_REALTIME_LIMITS.connectionsPerRegion
        || this.apiConnectionCount(apiId) >= APPSYNC_REALTIME_LIMITS.connectionsPerApi) {
        throw new AwsError("LimitExceededException", "The local AppSync realtime connection limit was exceeded.", 429);
      }
      const auth = await this.realtimeAuth(api, encodedHeaders, Buffer.from("{}", "utf8"), true);
      this.realtimeServer.handleUpgrade(req, socket, head, websocket => this.acceptRealtime(websocket, api, auth));
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("BadRequestException", "The AppSync realtime upgrade was rejected.", 400);
      this.rejectRealtimeUpgrade(socket, aws.status, aws.message);
    }
  }

  private acceptRealtime(socket: WebSocket, api: AppSyncGraphqlApiState, auth: RealtimeAuth): void {
    const connection: RealtimeConnection = {
      id: randomUUID(), apiId: api.apiId, apiGeneration: api.generation, auth, socket,
      initialized: false, openedAt: this.clock.now(), lastActivityAt: this.clock.now(),
      registrations: new Map(), queue: [], queuedBytes: 0, sending: false,
      initTimer: this.clock.setTimeout(() => this.closeRealtimeConnection(connection, 4408, "Connection initialisation timeout"), APPSYNC_REALTIME_LIMITS.initializationMs),
    };
    (connection.initTimer as NodeJS.Timeout).unref?.();
    this.realtimeConnections.set(connection.id, connection);
    this.realtimeSignal({ signal: "connection-admit", apiId: api.apiId, connectionId: connection.id, authenticationType: auth.mode });
    void this.publishMetric(api.apiId, "RealtimeConnectionAdmission", 1, "Count", { AuthenticationType: auth.mode });
    socket.on("message", (data, binary) => void this.handleRealtimeMessage(connection, data, binary));
    socket.on("close", () => this.removeRealtimeConnection(connection, "peer-close"));
    socket.on("error", () => this.removeRealtimeConnection(connection, "socket-error"));
  }

  private sendRealtimeDirect(connection: RealtimeConnection, value: unknown): boolean {
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    if (bytes.length > APPSYNC_REALTIME_LIMITS.outgoingMessageBytes || connection.socket.readyState !== WebSocket.OPEN) return false;
    try { connection.socket.send(bytes, { binary: false }); return true; } catch { return false; }
  }

  private async handleRealtimeMessage(connection: RealtimeConnection, raw: WebSocket.RawData, binary: boolean): Promise<void> {
    const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    if (binary || bytes.length > APPSYNC_REALTIME_LIMITS.incomingMessageBytes) {
      this.closeRealtimeConnection(connection, 4400, "Invalid realtime message");
      return;
    }
    connection.lastActivityAt = this.clock.now();
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(bytes.toString("utf8"));
      if (!validObject(parsed) || typeof parsed.type !== "string") throw new Error();
      message = parsed;
    } catch {
      this.closeRealtimeConnection(connection, 4400, "Invalid realtime message");
      return;
    }
    if (!connection.initialized) {
      if (message.type !== "connection_init" || Object.keys(message).some(name => name !== "type" && name !== "payload")
        || (message.payload !== undefined && (!validObject(message.payload) || Object.keys(message.payload).length))) {
        this.sendRealtimeDirect(connection, { type: "connection_error", payload: realtimeError("A valid connection_init message is required.") });
        this.closeRealtimeConnection(connection, 4400, "Connection initialisation failed");
        return;
      }
      connection.initialized = true;
      this.clock.clearTimeout(connection.initTimer);
      this.sendRealtimeDirect(connection, { type: "connection_ack", payload: { connectionTimeoutMs: APPSYNC_REALTIME_LIMITS.idleMs } });
      this.sendRealtimeDirect(connection, { type: "ka" });
      this.scheduleRealtimeKeepAlive(connection);
      this.scheduleRealtimeLifecycle(connection);
      return;
    }
    if (message.type === "connection_init") {
      this.sendRealtimeDirect(connection, { type: "connection_error", payload: realtimeError("connection_init was already received.") });
      this.closeRealtimeConnection(connection, 4429, "Too many initialisation requests");
      return;
    }
    if (message.type === "start") {
      await this.startRealtimeRegistration(connection, message);
      return;
    }
    if (message.type === "stop") {
      const id = typeof message.id === "string" ? message.id : "";
      const registration = connection.registrations.get(id);
      if (registration) {
        this.removeRealtimeRegistration(connection, registration);
        this.sendRealtimeDirect(connection, { id, type: "complete" });
        this.realtimeSignal({ signal: "registration-stop", apiId: connection.apiId, connectionId: connection.id, registrationId: id, authenticationType: registration.auth.mode });
        void this.publishMetric(connection.apiId, "RealtimeSubscriptionStop", 1, "Count", { AuthenticationType: registration.auth.mode });
      }
      return;
    }
    this.sendRealtimeDirect(connection, { type: "connection_error", payload: realtimeError("The realtime message type is not supported.", "UnsupportedOperation") });
    this.closeRealtimeConnection(connection, 4400, "Unsupported realtime message");
  }

  private realtimeIdentityValid(apiId: string, auth: RealtimeAuth): boolean {
    const api = this.state.graphqlApis[apiId];
    if (!api) return false;
    if (auth.mode === "API_KEY") {
      const key = api.apiKeys[auth.keyId];
      return Boolean(key && key.expires > Math.floor(this.clock.now() / 1000));
    }
    return Boolean(this.iamHooks?.identityValid(auth.principal));
  }

  private scheduleRealtimeKeepAlive(connection: RealtimeConnection): void {
    connection.keepAliveTimer = this.clock.setTimeout(() => {
      if (!this.realtimeConnections.has(connection.id)) return;
      if (!this.realtimeIdentityValid(connection.apiId, connection.auth)) {
        this.invalidateRealtimeIdentity(connection);
        return;
      }
      this.sendRealtimeDirect(connection, { type: "ka" });
      this.scheduleRealtimeKeepAlive(connection);
    }, APPSYNC_REALTIME_LIMITS.keepAliveMs);
    (connection.keepAliveTimer as NodeJS.Timeout).unref?.();
  }

  private scheduleRealtimeLifecycle(connection: RealtimeConnection): void {
    connection.lifecycleTimer = this.clock.setTimeout(() => {
      if (!this.realtimeConnections.has(connection.id)) return;
      this.checkRealtimeLifecycle(connection);
      if (this.realtimeConnections.has(connection.id)) this.scheduleRealtimeLifecycle(connection);
    }, Math.min(APPSYNC_REALTIME_LIMITS.keepAliveMs, 60_000));
    (connection.lifecycleTimer as NodeJS.Timeout).unref?.();
  }

  private checkRealtimeLifecycle(connection: RealtimeConnection): void {
    const now = this.clock.now();
    const api = this.state.graphqlApis[connection.apiId];
    if (!api || api.generation !== connection.apiGeneration) {
      this.closeRealtimeConnection(connection, 1012, "AppSync API changed");
    } else if (!this.realtimeIdentityValid(connection.apiId, connection.auth)) {
      this.invalidateRealtimeIdentity(connection);
    } else if (now - connection.openedAt >= APPSYNC_REALTIME_LIMITS.lifetimeMs) {
      this.closeRealtimeConnection(connection, 1001, "Connection lifetime exceeded");
    } else if (now - connection.lastActivityAt >= APPSYNC_REALTIME_LIMITS.idleMs) {
      this.closeRealtimeConnection(connection, 1001, "Connection idle timeout");
    }
  }

  private invalidateRealtimeIdentity(connection: RealtimeConnection): void {
    for (const registration of [...connection.registrations.values()]) {
      this.sendRealtimeDirect(connection, { id: registration.id, type: "error", payload: realtimeError("The realtime identity is no longer valid.", "UnauthorizedException") });
      this.sendRealtimeDirect(connection, { id: registration.id, type: "complete" });
      this.removeRealtimeRegistration(connection, registration);
    }
    this.closeRealtimeConnection(connection, 4401, "Realtime authorization expired");
  }

  private async startRealtimeRegistration(connection: RealtimeConnection, message: Record<string, unknown>): Promise<void> {
    const id = typeof message.id === "string" ? message.id : "";
    const reject = (reason: string, errorType = "BadRequestException"): void => {
      if (id) this.sendRealtimeDirect(connection, { id, type: "error", payload: realtimeError(reason, errorType) });
      else this.sendRealtimeDirect(connection, { type: "error", payload: realtimeError(reason, errorType) });
      this.realtimeSignal({ signal: "registration-reject", apiId: connection.apiId, connectionId: connection.id, ...(id ? { registrationId: id } : {}), authenticationType: connection.auth.mode, reason: errorType });
      void this.publishMetric(connection.apiId, "RealtimeSubscriptionRegistrationRejected", 1, "Count", { AuthenticationType: connection.auth.mode, Reason: errorType });
    };
    try {
      if (!id || Buffer.byteLength(id, "utf8") > 128 || Object.keys(message).some(name => !["id", "type", "payload"].includes(name))) {
        throw new AwsError("BadRequestException", "A bounded subscription id is required.", 400);
      }
      if (connection.registrations.has(id)) throw new AwsError("ConflictException", "The subscription id is already registered on this connection.", 409);
      if (connection.registrations.size >= APPSYNC_REALTIME_LIMITS.registrationsPerConnection
        || this.apiRegistrationCount(connection.apiId) >= APPSYNC_REALTIME_LIMITS.registrationsPerApi) {
        throw new AwsError("LimitExceededException", "The local AppSync realtime registration limit was exceeded.", 429);
      }
      if (!validObject(message.payload) || typeof message.payload.data !== "string" || !validObject(message.payload.extensions)
        || !validObject(message.payload.extensions.authorization)
        || Object.keys(message.payload).some(name => !["data", "extensions"].includes(name))
        || Object.keys(message.payload.extensions).some(name => name !== "authorization")) {
        throw new AwsError("BadRequestException", "The subscription start payload is invalid.", 400);
      }
      let authorization: Record<string, string>;
      try { authorization = normalizeRealtimeHeaders(message.payload.extensions.authorization); }
      catch { throw new AwsError("BadRequestException", "The subscription authorization header is invalid.", 400); }
      const api = structuredClone(this.requireApi(connection.apiId));
      if (!api.schema || api.generation !== connection.apiGeneration) throw new AwsError("ConflictException", "The AppSync API generation changed.", 409);
      const auth = await this.realtimeAuth(api, authorization, Buffer.from(message.payload.data, "utf8"), false);
      if (!this.realtimeAuthMatches(auth, connection.auth)) throw new AwsError("UnauthorizedException", "A realtime connection cannot switch authorization identities.", 401);
      const input = JSON.parse(message.payload.data);
      if (!validObject(input) || typeof input.query !== "string" || !input.query
        || Object.keys(input).some(name => !["query", "variables", "operationName"].includes(name))) {
        throw new AwsError("BadRequestException", "The subscription data payload is invalid.", 400);
      }
      if (Buffer.byteLength(input.query, "utf8") > APPSYNC_REALTIME_LIMITS.queryBytes) throw new AwsError("RequestTooLarge", "The subscription document is too large.", 413);
      if (input.variables !== undefined && (!validObject(input.variables)
        || Buffer.byteLength(JSON.stringify(input.variables), "utf8") > APPSYNC_REALTIME_LIMITS.variablesBytes)) {
        throw new AwsError("BadRequestException", "Subscription variables must be a bounded JSON object.", 400);
      }
      if (input.operationName !== undefined && typeof input.operationName !== "string") throw new AwsError("BadRequestException", "operationName must be a string.", 400);
      const limitError = operationLimitError(input.query, input.operationName as string | undefined);
      if (limitError) throw new AwsError("QueryLimitExceeded", limitError, 400);
      const schema = this.compiledSchema(api);
      const document = parse(input.query);
      const validationErrors = validate(schema, document, specifiedRules);
      if (validationErrors.length) throw new AwsError("GraphQLValidationException", validationErrors[0].message, 400);
      const operation = getOperationAST(document, input.operationName as string | undefined);
      if (!operation || operation.operation !== "subscription") throw new AwsError("UnsupportedOperation", "Exactly one selected subscription operation is required.", 400);
      const coerced = getVariableValues(schema, operation.variableDefinitions ?? [], input.variables as Record<string, unknown> | undefined ?? {});
      if (coerced.errors?.length) throw new AwsError("GraphQLValidationException", coerced.errors[0].message, 400);
      const variableValues = coerced.variableValues!;
      const variables = { ...variableValues.coerced };
      const roots = selectedRootFields(document, operation, variables);
      if (roots.length !== 1) throw new AwsError("GraphQLValidationException", "A subscription must select exactly one root field.", 400);
      const root = roots[0];
      const subscriptionType = schema.getSubscriptionType();
      if (!subscriptionType) throw new AwsError("UnsupportedOperation", "The schema has no subscription type.", 400);
      const frozenLinks: Record<string, string> = { onCreateTodo: "createTodo", onUpdateTodo: "updateTodo", onDeleteTodo: "deleteTodo" };
      const expectedLink = frozenLinks[root.fieldName];
      const fieldDefinition = subscriptionType.getFields()[root.fieldName];
      if (!fieldDefinition || !expectedLink || fieldDefinition.args.some(argument => argument.name !== "filter")) {
        throw new AwsError("UnsupportedOperation", "The subscription field or arguments are outside the frozen AMX-08 surface.", 400);
      }
      const subscribeDirective = fieldDefinition.astNode?.directives?.find(directive => directive.name.value === "aws_subscribe");
      const mutationValue = subscribeDirective?.arguments?.find(argument => argument.name.value === "mutations")?.value;
      const mutationLinks = mutationValue?.kind === Kind.LIST
        ? mutationValue.values.filter(value => value.kind === Kind.STRING).map(value => value.value)
        : [];
      if (mutationLinks.length !== 1 || mutationLinks[0] !== expectedLink) {
        throw new AwsError("UnsupportedOperation", "The subscription mutation link is outside the frozen AMX-08 surface.", 400);
      }
      if (!schemaAllowsMode(subscriptionType, root.fieldName, auth.mode)) throw new AwsError("UnauthorizedException", "Not Authorized to access this subscription field.", 401);
      if (auth.mode === "AWS_IAM") await this.authorizeRealtimeField(api, subscriptionType.name, root.fieldName, auth.principal, connection.id);
      let args: Record<string, unknown>;
      try { args = getArgumentValues(fieldDefinition, root.field, variableValues) as Record<string, unknown>; }
      catch (error) { throw new AwsError("GraphQLValidationException", error instanceof Error ? error.message : "Subscription arguments are invalid.", 400); }
      if (Object.keys(args).some(name => name !== "filter")) throw new AwsError("UnsupportedOperation", "The subscription argument is not supported.", 400);
      const resolver = api.resolvers[this.resolverKey(subscriptionType.name, root.fieldName)];
      if (!resolver || resolver.kind !== "PIPELINE") throw new AwsError("ResolverNotFound", "The generated subscription pipeline resolver is required.", 400);
      const evaluation = await this.executePipelineResolver(api, resolver, {
        arguments: structuredClone(args), source: null,
        identity: auth.mode === "AWS_IAM" ? {
          accountId: auth.principal.accountId, sourceIp: [], username: auth.principal.userName ?? auth.principal.principalId,
          userArn: auth.principal.principalArn,
        } : null,
        stash: {}, request: { headers: {} },
        info: { fieldName: root.fieldName, parentTypeName: subscriptionType.name, variables: structuredClone(input.variables ?? {}) },
        authType: auth.mode === "AWS_IAM" ? "IAM Authorization" : "API Key Authorization",
        authorizationScope: auth.identityKey,
      });
      if (evaluation.appendedErrors.length) throw new AwsError("MappingTemplate", evaluation.appendedErrors[0].message, 400);
      const filter = evaluation.subscriptionFilter === undefined ? undefined : evaluation.subscriptionFilter;
      if (filter !== undefined && !validObject(filter)) throw new AwsError("UnsupportedOperation", "The generated subscription filter is invalid.", 400);
      const registration: RealtimeRegistration = {
        id, apiId: api.apiId, apiGeneration: api.generation, schemaGeneration: api.schema.generation,
        authorizationGeneration: this.authorizationGeneration(api), resolverGeneration: this.realtimeResolverGeneration(api),
        connectionId: connection.id, ...(input.operationName === undefined ? {} : { operationName: input.operationName }),
        document, variables, fieldName: root.fieldName, responseKey: root.responseKey, mutationLinks,
        ...(filter === undefined ? {} : { filter: structuredClone(filter) }), auth,
        queuedMessages: 0, queuedBytes: 0, registeredAt: this.clock.now(),
      };
      if (this.realtimeFaultInjector?.("registration-admission", { apiId: api.apiId, connectionId: connection.id, authenticationType: auth.mode })) {
        throw new AwsError("InternalFailure", "The subscription registration failed internally.", 500);
      }
      connection.registrations.set(id, registration);
      this.sendRealtimeDirect(connection, { id, type: "start_ack" });
      this.realtimeSignal({ signal: "registration-admit", apiId: api.apiId, connectionId: connection.id, registrationId: id, authenticationType: auth.mode });
      void this.publishMetric(api.apiId, "RealtimeSubscriptionRegistrationAdmission", 1, "Count", { AuthenticationType: auth.mode });
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("BadRequestException", error instanceof Error ? error.message : "The subscription registration failed.", 400);
      reject(aws.message, aws.code);
    }
  }

  private async authorizeRealtimeField(
    api: AppSyncGraphqlApiState,
    typeName: string,
    fieldName: string,
    principal: PrincipalContext,
    connectionId: string,
  ): Promise<void> {
    const resource = `${api.arn}/types/${typeName}/fields/${fieldName}`;
    const result = await this.iamHooks!.authorize(principal, resource, {
      "aws:PrincipalArn": principal.principalArn,
      "aws:PrincipalAccount": principal.accountId,
      "aws:RequestedRegion": this.region,
      "aws:CurrentTime": new Date(this.clock.now()).toISOString(),
      "aws:SourceIp": "",
      "aws:UserAgent": "",
      "aws:SecureTransport": false,
      "appsync:GraphQLApiId": api.apiId,
      "appsync:TypeName": typeName,
      "appsync:FieldName": fieldName,
    }, connectionId);
    if (result.decision !== "allowed") throw new AwsError("AccessDeniedException", "Not Authorized to access this subscription field.", 403);
  }

  private removeRealtimeRegistration(connection: RealtimeConnection, registration: RealtimeRegistration): void {
    connection.registrations.delete(registration.id);
    const retained: RealtimeQueuedMessage[] = [];
    for (const queued of connection.queue) {
      if (queued.registrationId === registration.id) {
        connection.queuedBytes -= queued.bytes.length;
        registration.queuedMessages = Math.max(0, registration.queuedMessages - 1);
        registration.queuedBytes = Math.max(0, registration.queuedBytes - queued.bytes.length);
      } else retained.push(queued);
    }
    connection.queue = retained;
  }

  private dropRealtimeRegistration(connection: RealtimeConnection, registration: RealtimeRegistration, reason: string, errorType: string): void {
    this.removeRealtimeRegistration(connection, registration);
    this.sendRealtimeDirect(connection, { id: registration.id, type: "error", payload: realtimeError(reason, errorType) });
    this.sendRealtimeDirect(connection, { id: registration.id, type: "complete" });
    const queueFailure = errorType === "LimitExceededException" || errorType === "ResponseTooLarge";
    this.realtimeSignal({ signal: queueFailure ? "queue-drop" : "registration-reject", apiId: connection.apiId, connectionId: connection.id, registrationId: registration.id, authenticationType: registration.auth.mode, reason: errorType });
    void this.publishMetric(connection.apiId, queueFailure ? "RealtimeSubscriptionQueueDrop" : "RealtimeSubscriptionRegistrationRejected", 1, "Count", { AuthenticationType: registration.auth.mode, Reason: errorType });
  }

  private enqueueRealtimeData(connection: RealtimeConnection, registration: RealtimeRegistration, value: unknown): void {
    if (this.realtimeFaultInjector?.("queueing", { apiId: connection.apiId, connectionId: connection.id, authenticationType: registration.auth.mode })) {
      this.dropRealtimeRegistration(connection, registration, "The subscription event could not be queued.", "InternalFailure");
      return;
    }
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    if (bytes.length > APPSYNC_REALTIME_LIMITS.outgoingMessageBytes) {
      this.dropRealtimeRegistration(connection, registration, "The subscription event is too large.", "ResponseTooLarge");
      return;
    }
    if (registration.queuedMessages >= APPSYNC_REALTIME_LIMITS.registrationQueueMessages
      || registration.queuedBytes + bytes.length > APPSYNC_REALTIME_LIMITS.registrationQueueBytes) {
      this.dropRealtimeRegistration(connection, registration, "The subscription queue limit was exceeded.", "LimitExceededException");
      return;
    }
    if (connection.queue.length >= APPSYNC_REALTIME_LIMITS.connectionQueueMessages
      || connection.queuedBytes + bytes.length > APPSYNC_REALTIME_LIMITS.connectionQueueBytes) {
      this.closeRealtimeConnection(connection, 1013, "Realtime connection queue limit exceeded");
      return;
    }
    registration.queuedMessages++;
    registration.queuedBytes += bytes.length;
    connection.queuedBytes += bytes.length;
    connection.queue.push({ bytes, registrationId: registration.id });
    this.pumpRealtimeQueue(connection);
  }

  private pumpRealtimeQueue(connection: RealtimeConnection): void {
    if (connection.sending || connection.socket.readyState !== WebSocket.OPEN) return;
    const queued = connection.queue.shift();
    if (!queued) return;
    connection.sending = true;
    connection.queuedBytes = Math.max(0, connection.queuedBytes - queued.bytes.length);
    const registration = queued.registrationId ? connection.registrations.get(queued.registrationId) : undefined;
    if (registration) {
      registration.queuedMessages = Math.max(0, registration.queuedMessages - 1);
      registration.queuedBytes = Math.max(0, registration.queuedBytes - queued.bytes.length);
    }
    try {
      const socketFault = this.realtimeFaultInjector?.("socket-send", { apiId: connection.apiId, connectionId: connection.id, ...(registration ? { authenticationType: registration.auth.mode } : {}) });
      if (socketFault === "stall") return;
      if (socketFault) {
        throw new Error("Injected realtime socket-send failure");
      }
      connection.socket.send(queued.bytes, { binary: false }, error => {
        connection.sending = false;
        if (error) {
          this.realtimeSignal({ signal: "socket-delivery-failure", apiId: connection.apiId, connectionId: connection.id, ...(queued.registrationId ? { registrationId: queued.registrationId } : {}), ...(registration ? { authenticationType: registration.auth.mode } : {}), reason: "socket-send" });
          void this.publishMetric(connection.apiId, "RealtimeSocketDeliveryFailure", 1, "Count", registration ? { AuthenticationType: registration.auth.mode } : {});
          if (registration) this.removeRealtimeRegistration(connection, registration);
        } else {
          this.realtimeSignal({ signal: "socket-delivery", apiId: connection.apiId, connectionId: connection.id, ...(queued.registrationId ? { registrationId: queued.registrationId } : {}), ...(registration ? { authenticationType: registration.auth.mode } : {}) });
          void this.publishMetric(connection.apiId, "RealtimeSocketDelivery", 1, "Count", registration ? { AuthenticationType: registration.auth.mode } : {});
        }
        this.pumpRealtimeQueue(connection);
      });
    } catch {
      connection.sending = false;
      this.realtimeSignal({ signal: "socket-delivery-failure", apiId: connection.apiId, connectionId: connection.id, ...(queued.registrationId ? { registrationId: queued.registrationId } : {}), ...(registration ? { authenticationType: registration.auth.mode } : {}), reason: "socket-send" });
      void this.publishMetric(connection.apiId, "RealtimeSocketDeliveryFailure", 1, "Count", registration ? { AuthenticationType: registration.auth.mode } : {});
      if (registration) this.removeRealtimeRegistration(connection, registration);
      this.pumpRealtimeQueue(connection);
    }
  }

  private removeRealtimeConnection(connection: RealtimeConnection, reason: string): void {
    if (!this.realtimeConnections.delete(connection.id)) return;
    this.clock.clearTimeout(connection.initTimer);
    if (connection.keepAliveTimer) this.clock.clearTimeout(connection.keepAliveTimer);
    if (connection.lifecycleTimer) this.clock.clearTimeout(connection.lifecycleTimer);
    connection.registrations.clear();
    connection.queue = [];
    connection.queuedBytes = 0;
    this.realtimeSignal({ signal: "connection-close", apiId: connection.apiId, connectionId: connection.id, authenticationType: connection.auth.mode, reason: reason.slice(0, 64) });
    void this.publishMetric(connection.apiId, "RealtimeConnectionClose", 1, "Count", { AuthenticationType: connection.auth.mode });
  }

  private closeRealtimeConnection(connection: RealtimeConnection, code: number, reason: string): void {
    if (connection.socket.readyState === WebSocket.OPEN || connection.socket.readyState === WebSocket.CONNECTING) {
      try { connection.socket.close(code, reason.slice(0, 123)); } catch { try { connection.socket.terminate(); } catch {} }
    }
    this.removeRealtimeConnection(connection, reason);
  }

  private closeRealtimeApi(apiId: string, reason = "AppSync configuration changed"): void {
    for (const connection of [...this.realtimeConnections.values()]) {
      if (connection.apiId === apiId) this.closeRealtimeConnection(connection, 1012, reason);
    }
  }

  private closeRealtimeApiKey(apiId: string, keyId: string, reason: string): void {
    for (const connection of [...this.realtimeConnections.values()]) {
      if (connection.apiId === apiId && connection.auth.mode === "API_KEY" && connection.auth.keyId === keyId) {
        this.closeRealtimeConnection(connection, 1012, reason);
      }
    }
  }

  async shutdownRealtime(): Promise<void> {
    for (const connection of [...this.realtimeConnections.values()]) this.closeRealtimeConnection(connection, 1012, "Service restart");
  }

  private realtimeMutationCandidates(api: AppSyncGraphqlApiState, fieldName: string): Array<{ connection: RealtimeConnection; registration: RealtimeRegistration }> {
    return [...this.realtimeConnections.values()]
      .filter(connection => connection.apiId === api.apiId && connection.apiGeneration === api.generation)
      .flatMap(connection => [...connection.registrations.values()].map(registration => ({ connection, registration })))
      .filter(({ registration }) => registration.mutationLinks.includes(fieldName))
      .slice(0, APPSYNC_REALTIME_LIMITS.fanoutPerMutation);
  }

  private async publishRealtimeMutation(completion: RealtimeMutationCompletion): Promise<void> {
    const { api, candidates, value } = completion;
    if (!api.schema) return;
    this.realtimeSignal({ signal: "mutation-complete", apiId: api.apiId });
    await this.publishMetric(api.apiId, "RealtimeMutationCompletion", 1, "Count");
    if (this.realtimeFaultInjector?.("mutation-completion", { apiId: api.apiId })) return;
    const authorizationGeneration = this.authorizationGeneration(api);
    const resolverGeneration = this.realtimeResolverGeneration(api);
    for (const { connection, registration } of candidates) {
      try {
        if (this.realtimeConnections.get(connection.id) !== connection || connection.registrations.get(registration.id) !== registration) continue;
        if (registration.apiGeneration !== api.generation || registration.schemaGeneration !== api.schema.generation
          || registration.authorizationGeneration !== authorizationGeneration || registration.resolverGeneration !== resolverGeneration) continue;
        if (!this.realtimeIdentityValid(registration.apiId, registration.auth)) {
          this.invalidateRealtimeIdentity(connection);
          continue;
        }
        const schema = this.compiledSchema(api);
        const subscriptionType = schema.getSubscriptionType();
        if (!subscriptionType || !schemaAllowsMode(subscriptionType, registration.fieldName, registration.auth.mode)) {
          this.dropRealtimeRegistration(connection, registration, "The subscription is no longer authorized.", "UnauthorizedException");
          continue;
        }
        if (registration.auth.mode === "AWS_IAM") {
          try { await this.authorizeRealtimeField(api, subscriptionType.name, registration.fieldName, registration.auth.principal, connection.id); }
          catch {
            this.dropRealtimeRegistration(connection, registration, "The subscription is no longer authorized.", "UnauthorizedException");
            continue;
          }
        }
        this.realtimeSignal({ signal: "authorization-admit", apiId: api.apiId, connectionId: connection.id, registrationId: registration.id, authenticationType: registration.auth.mode });
        void this.publishMetric(api.apiId, "RealtimeSubscriptionAuthorizationAdmission", 1, "Count", { AuthenticationType: registration.auth.mode });
        if (!realtimeFilterMatches(registration.filter, value)) {
          this.realtimeSignal({ signal: "filter-reject", apiId: api.apiId, connectionId: connection.id, registrationId: registration.id, authenticationType: registration.auth.mode });
          void this.publishMetric(api.apiId, "RealtimeSubscriptionFilterRejection", 1, "Count", { AuthenticationType: registration.auth.mode });
          continue;
        }
        this.realtimeSignal({ signal: "filter-admit", apiId: api.apiId, connectionId: connection.id, registrationId: registration.id, authenticationType: registration.auth.mode });
        void this.publishMetric(api.apiId, "RealtimeSubscriptionFilterAdmission", 1, "Count", { AuthenticationType: registration.auth.mode });
        const result = await execute({
          schema,
          document: registration.document,
          operationName: registration.operationName,
          variableValues: registration.variables,
          rootValue: { [registration.fieldName]: structuredClone(value) },
        });
        this.enqueueRealtimeData(connection, registration, {
          id: registration.id,
          type: "data",
          payload: {
            ...(result.data === undefined ? {} : { data: result.data }),
            ...(result.errors?.length ? { errors: result.errors } : {}),
          },
        });
      } catch {
        this.dropRealtimeRegistration(connection, registration, "The subscription event could not be completed.", "GraphQLExecutionError");
      }
    }
  }

  private async publishMetric(
    apiId: string,
    metricName: string,
    value: number,
    unit: "Count" | "Milliseconds",
    dimensions: Record<string, string> = {},
  ): Promise<void> {
    await this.telemetry?.publish({
      namespace: "AWS/AppSync",
      metricName,
      dimensions: { GraphQLAPIId: apiId, ...dimensions },
      value,
      unit,
      timestamp: this.clock.now(),
    }).catch(() => undefined);
  }

  private async graphqlFailure(
    res: ServerResponse,
    apiId: string,
    startedAt: number,
    status: number,
    errorType: string,
    message: string,
    authorizationMode?: GraphqlAuthorizationMode,
  ): Promise<void> {
    await Promise.all([
      this.publishMetric(apiId, "GraphQLRequestCount", 1, "Count"),
      this.publishMetric(apiId, status >= 500 ? "5XXError" : "4XXError", 1, "Count"),
      this.publishMetric(apiId, "Latency", Math.max(0, this.clock.now() - startedAt), "Milliseconds"),
      ...(authorizationMode
        ? [
          this.publishMetric(apiId, "GraphQLRequestCount", 1, "Count", { AuthenticationType: authorizationMode }),
          this.publishMetric(apiId, status >= 500 ? "5XXError" : "4XXError", 1, "Count", { AuthenticationType: authorizationMode }),
          this.publishMetric(apiId, "Latency", Math.max(0, this.clock.now() - startedAt), "Milliseconds", { AuthenticationType: authorizationMode }),
        ]
        : []),
    ]);
    graphqlError(res, status, errorType, message);
  }

  async start(): Promise<void> {
    const references = new Set<string>();
    for (const account of Object.values(this.store.state.accounts)) {
      for (const regional of Object.values(account.regions)) {
        for (const api of Object.values(regional.appsync?.graphqlApis ?? {})) {
          api.functions ??= {};
          api.additionalAuthenticationProviders ??= [];
          for (const key of Object.values(api.apiKeys)) references.add(key.materialId);
        }
      }
    }
    await this.materials.start(references);
    for (const api of Object.values(this.state.graphqlApis)) {
      if (api.pendingSchema?.status === "PROCESSING") await this.completeSchemaCreation(api.apiId);
    }
  }

  async refreshEndpoints(): Promise<boolean> {
    let changed = false;
    for (const api of Object.values(this.state.graphqlApis)) {
      const uris = this.apiUris(api.apiId);
      if (api.uris.GRAPHQL !== uris.GRAPHQL || api.uris.REALTIME !== uris.REALTIME) {
        api.uris = uris;
        changed = true;
      }
    }
    return changed;
  }

  resourceTags(resourceArn: string): Record<string, string> {
    return Object.values(this.state.graphqlApis).find(api => api.arn === resourceArn)?.tags ?? {};
  }

  /**
   * Narrow in-process control-plane contract used by CloudFormation providers.
   * It deliberately dispatches to the same validated operations as the public
   * REST-JSON routes instead of exposing AppSync persistence to providers.
   */
  async executeCloudFormationControl(
    action: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const required = (name: string): string => requireString(input[name], name, 2048);
    const without = (...names: string[]): Record<string, unknown> => Object.fromEntries(
      Object.entries(input).filter(([name]) => !names.includes(name)),
    );
    switch (action) {
      case "CreateGraphqlApi":
        return { graphqlApi: await this.createGraphqlApi(input) };
      case "GetGraphqlApi":
        return { graphqlApi: this.publicApi(this.requireApi(required("apiId"))) };
      case "UpdateGraphqlApi":
        return { graphqlApi: await this.updateGraphqlApi(required("apiId"), without("apiId")) };
      case "DeleteGraphqlApi":
        await this.deleteGraphqlApi(required("apiId")); return {};
      case "TagResource":
        await this.tagResource(required("resourceArn"), without("resourceArn")); return {};
      case "UntagResource": {
        const keys = input.tagKeys;
        if (!Array.isArray(keys) || keys.some(key => typeof key !== "string")) {
          throw new AwsError("BadRequestException", "tagKeys must be an array of strings.", 400);
        }
        await this.untagResource(required("resourceArn"), keys as string[]); return {};
      }
      case "StartSchemaCreation":
        return { status: await this.startSchemaCreation(required("apiId"), without("apiId")) };
      case "GetSchemaCreationStatus":
        return this.schemaCreationStatus(required("apiId"));
      case "GetSchemaDefinition": {
        const api = this.requireApi(required("apiId"));
        if (!api.schema) throw new AwsError("NotFoundException", "The GraphQL API has no active schema.", 404);
        return { definition: api.schema.definition, status: api.schemaStatus };
      }
      case "GetIntrospectionSchema":
        return { schema: await this.introspectionSchema(required("apiId"), String(input.format ?? "SDL")) };
      case "CreateApiKey":
        return { apiKey: await this.createApiKey(required("apiId"), without("apiId")) };
      case "ListApiKeys": {
        const url = new URL("http://appsync.local/v1");
        url.searchParams.set("maxResults", String(input.maxResults ?? 50));
        if (typeof input.nextToken === "string") url.searchParams.set("nextToken", input.nextToken);
        return this.listApiKeys(required("apiId"), url);
      }
      case "UpdateApiKey":
        return { apiKey: await this.updateApiKey(required("apiId"), required("id"), without("apiId", "id")) };
      case "DeleteApiKey":
        await this.deleteApiKey(required("apiId"), required("id")); return {};
      case "CreateDataSource":
        return { dataSource: await this.createDataSource(required("apiId"), without("apiId")) };
      case "GetDataSource":
        return { dataSource: this.publicDataSource(this.requireDataSource(this.requireApi(required("apiId")), required("name"))) };
      case "UpdateDataSource":
        return { dataSource: await this.updateDataSource(required("apiId"), required("name"), without("apiId", "name")) };
      case "DeleteDataSource":
        await this.deleteDataSource(required("apiId"), required("name")); return {};
      case "CreateFunction":
        return { functionConfiguration: await this.createFunction(required("apiId"), without("apiId")) };
      case "GetFunction":
        return { functionConfiguration: this.publicFunction(this.requireFunction(this.requireApi(required("apiId")), required("functionId"))) };
      case "ListFunctions": {
        const url = new URL("http://appsync.local/v1"); url.searchParams.set("maxResults", String(input.maxResults ?? 25));
        if (typeof input.nextToken === "string") url.searchParams.set("nextToken", input.nextToken);
        return this.listFunctions(required("apiId"), url);
      }
      case "UpdateFunction":
        return { functionConfiguration: await this.updateFunction(required("apiId"), required("functionId"), without("apiId", "functionId")) };
      case "DeleteFunction":
        await this.deleteFunction(required("apiId"), required("functionId")); return {};
      case "CreateResolver":
        return { resolver: await this.createResolver(required("apiId"), required("typeName"), without("apiId", "typeName")) };
      case "GetResolver":
        return { resolver: this.publicResolver(this.requireResolver(this.requireApi(required("apiId")), required("typeName"), required("fieldName"))) };
      case "UpdateResolver":
        return { resolver: await this.updateResolver(required("apiId"), required("typeName"), required("fieldName"), without("apiId", "typeName", "fieldName")) };
      case "DeleteResolver":
        await this.deleteResolver(required("apiId"), required("typeName"), required("fieldName")); return {};
      default:
        throw new AwsError("UnsupportedOperationException", `AppSync control action ${action} is not available to CloudFormation.`, 400);
    }
  }

  async handleControl(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    try {
      const method = req.method ?? "GET";
      const apiPath = url.pathname.match(/^\/v1\/apis\/([^/]+)$/);
      const schemaPath = url.pathname.match(/^\/v1\/apis\/([^/]+)\/schemacreation$/);
      const introspectionPath = url.pathname.match(/^\/v1\/apis\/([^/]+)\/schema$/);
      const keysPath = url.pathname.match(/^\/v1\/apis\/([^/]+)\/apikeys$/);
      const keyPath = url.pathname.match(/^\/v1\/apis\/([^/]+)\/apikeys\/([^/]+)$/);
      const dataSourcesPath = url.pathname.match(/^\/v1\/apis\/([^/]+)\/datasources$/);
      const dataSourcePath = url.pathname.match(/^\/v1\/apis\/([^/]+)\/datasources\/([^/]+)$/);
      const functionsPath = url.pathname.match(/^\/v1\/apis\/([^/]+)\/functions$/);
      const functionPath = url.pathname.match(/^\/v1\/apis\/([^/]+)\/functions\/([^/]+)$/);
      const functionResolversPath = url.pathname.match(/^\/v1\/apis\/([^/]+)\/functions\/([^/]+)\/resolvers$/);
      const resolversPath = url.pathname.match(/^\/v1\/apis\/([^/]+)\/types\/([^/]+)\/resolvers$/);
      const resolverPath = url.pathname.match(/^\/v1\/apis\/([^/]+)\/types\/([^/]+)\/resolvers\/([^/]+)$/);
      const tagsPath = url.pathname.match(/^\/v1\/tags\/([^/]+)$/);

      if (url.pathname === "/v1/dataplane-evaluatetemplate" && method === "POST") {
        return controlJson(res, this.evaluateMappingTemplate(await this.input(req)));
      }
      if (url.pathname === "/v1/apis" && method === "POST") {
        return controlJson(res, { graphqlApi: await this.createGraphqlApi(await this.input(req)) });
      }
      if (url.pathname === "/v1/apis" && method === "GET") {
        return controlJson(res, this.listGraphqlApis(url));
      }
      if (apiPath && method === "GET") {
        return controlJson(res, { graphqlApi: this.publicApi(this.requireApi(decodePathPart(apiPath[1], "API ID"))) });
      }
      if (apiPath && method === "POST") {
        return controlJson(res, { graphqlApi: await this.updateGraphqlApi(
          decodePathPart(apiPath[1], "API ID"),
          await this.input(req),
        ) });
      }
      if (apiPath && method === "DELETE") {
        await this.deleteGraphqlApi(decodePathPart(apiPath[1], "API ID"));
        return controlJson(res, {});
      }
      if (schemaPath && method === "POST") {
        const apiId = decodePathPart(schemaPath[1], "API ID");
        const parsed = await this.inputWithPayload(req);
        if (!isPinnedCdkHotswapRequest(req, "appsync")) return controlJson(res, { status: await this.startSchemaCreation(apiId, parsed.input) });
        const api = this.requireApi(apiId);
        const record = beginHotswapDrift(this.store.regionState(this.region).cloudformation, uniqueCompletedOwner(this.store.regionState(this.region).cloudformation, appSyncSchemaOwnershipKey(apiId)), "appsync", "StartSchemaCreation", parsed.payload, `${api.revision}:${api.schema?.generation ?? "none"}:${api.schema?.digest ?? "none"}`, this.clock.now());
        try { await hotswapCheckpoint(this.store.regionState(this.region).cloudformation, "before-direct-call", record); const status = await this.startSchemaCreation(apiId, parsed.input); await hotswapCheckpoint(this.store.regionState(this.region).cloudformation, "after-direct-call", record); return controlJson(res, { status }); }
        catch (error) { failHotswapDrift(record, error, this.clock.now()); await this.store.save(); throw error; }
      }
      if (schemaPath && method === "GET") {
        const apiId = decodePathPart(schemaPath[1], "API ID");
        const status = await this.schemaCreationStatus(apiId);
        if (status.status === "SUCCESS" || status.status === "FAILED") {
          const owner = (this.store.regionState(this.region).cloudformation.resourceOwnership ?? {})[appSyncSchemaOwnershipKey(apiId)]?.[0];
          const pending = [...(this.store.regionState(this.region).cloudformation.hotswapOperations ?? [])].reverse().find(candidate => candidate.status === "PENDING" && candidate.action === "StartSchemaCreation" && candidate.stackId === owner?.stackId && candidate.logicalResourceId === owner?.logicalResourceId);
          if (pending) { const api = this.requireApi(apiId); if (status.status === "SUCCESS") completeHotswapDrift(this.store.regionState(this.region).cloudformation, pending, `${api.revision}:${api.schema?.generation ?? "none"}:${api.schema?.digest ?? "none"}`, this.clock.now()); else failHotswapDrift(pending, status.details ?? "Schema creation failed", this.clock.now()); await this.store.save(); }
        }
        return controlJson(res, status);
      }
      if (introspectionPath && method === "GET") {
        const schema = await this.introspectionSchema(
          decodePathPart(introspectionPath[1], "API ID"),
          url.searchParams.get("format"),
        );
        res.statusCode = 200;
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("cache-control", "no-store");
        res.end(schema);
        return;
      }
      if (keysPath && method === "POST") {
        return controlJson(res, { apiKey: await this.createApiKey(
          decodePathPart(keysPath[1], "API ID"),
          await this.input(req),
        ) });
      }
      if (keysPath && method === "GET") {
        return controlJson(res, await this.listApiKeys(decodePathPart(keysPath[1], "API ID"), url));
      }
      if (keyPath && method === "POST") {
        const apiId = decodePathPart(keyPath[1], "API ID"); const keyId = decodePathPart(keyPath[2], "API key"); const parsed = await this.inputWithPayload(req);
        if (!isPinnedCdkHotswapRequest(req, "appsync")) return controlJson(res, { apiKey: await this.updateApiKey(apiId, keyId, parsed.input) });
        const api = this.requireApi(apiId);
        const record = beginHotswapDrift(this.store.regionState(this.region).cloudformation, uniqueCompletedOwner(this.store.regionState(this.region).cloudformation, appSyncApiKeyOwnershipKey(apiId, keyId)), "appsync", "UpdateApiKey", parsed.payload, String(api.revision), this.clock.now());
        try { await hotswapCheckpoint(this.store.regionState(this.region).cloudformation, "before-direct-call", record); const value = await this.updateApiKey(apiId, keyId, parsed.input); completeHotswapDrift(this.store.regionState(this.region).cloudformation, record, String(api.revision), this.clock.now()); await hotswapCheckpoint(this.store.regionState(this.region).cloudformation, "after-direct-call", record); await this.store.save(); return controlJson(res, { apiKey: value }); }
        catch (error) { if (record.status === "PENDING") failHotswapDrift(record, error, this.clock.now()); await this.store.save(); throw error; }
      }
      if (keyPath && method === "DELETE") {
        await this.deleteApiKey(
          decodePathPart(keyPath[1], "API ID"),
          decodePathPart(keyPath[2], "API key"),
        );
        return controlJson(res, {});
      }
      if (dataSourcesPath && method === "POST") {
        return controlJson(res, { dataSource: await this.createDataSource(
          decodePathPart(dataSourcesPath[1], "API ID"),
          await this.input(req),
        ) });
      }
      if (dataSourcesPath && method === "GET") {
        return controlJson(res, this.listDataSources(decodePathPart(dataSourcesPath[1], "API ID"), url));
      }
      if (dataSourcePath && method === "GET") {
        return controlJson(res, { dataSource: this.publicDataSource(this.requireDataSource(
          this.requireApi(decodePathPart(dataSourcePath[1], "API ID")),
          decodePathPart(dataSourcePath[2], "data source name"),
        )) });
      }
      if (dataSourcePath && method === "POST") {
        return controlJson(res, { dataSource: await this.updateDataSource(
          decodePathPart(dataSourcePath[1], "API ID"),
          decodePathPart(dataSourcePath[2], "data source name"),
          await this.input(req),
        ) });
      }
      if (dataSourcePath && method === "DELETE") {
        await this.deleteDataSource(
          decodePathPart(dataSourcePath[1], "API ID"),
          decodePathPart(dataSourcePath[2], "data source name"),
        );
        return controlJson(res, {});
      }
      if (functionsPath && method === "POST") {
        return controlJson(res, { functionConfiguration: await this.createFunction(
          decodePathPart(functionsPath[1], "API ID"), await this.input(req),
        ) });
      }
      if (functionsPath && method === "GET") {
        return controlJson(res, this.listFunctions(decodePathPart(functionsPath[1], "API ID"), url));
      }
      if (functionResolversPath && method === "GET") {
        return controlJson(res, this.listResolversByFunction(
          decodePathPart(functionResolversPath[1], "API ID"),
          decodePathPart(functionResolversPath[2], "function ID"), url,
        ));
      }
      if (functionPath && method === "GET") {
        const api = this.requireApi(decodePathPart(functionPath[1], "API ID"));
        return controlJson(res, { functionConfiguration: this.publicFunction(this.requireFunction(
          api, decodePathPart(functionPath[2], "function ID"),
        )) });
      }
      if (functionPath && method === "POST") {
        const apiId = decodePathPart(functionPath[1], "API ID"); const functionId = decodePathPart(functionPath[2], "function ID"); const parsed = await this.inputWithPayload(req);
        if (!isPinnedCdkHotswapRequest(req, "appsync")) return controlJson(res, { functionConfiguration: await this.updateFunction(apiId, functionId, parsed.input) });
        const api = this.requireApi(apiId); const fn = this.requireFunction(api, functionId);
        const record = beginHotswapDrift(this.store.regionState(this.region).cloudformation, uniqueCompletedOwner(this.store.regionState(this.region).cloudformation, appSyncFunctionOwnershipKey(apiId, functionId)), "appsync", "UpdateFunction", parsed.payload, `${api.revision}:${fn.revision}`, this.clock.now());
        try { await hotswapCheckpoint(this.store.regionState(this.region).cloudformation, "before-direct-call", record); const value = await this.updateFunction(apiId, functionId, parsed.input); completeHotswapDrift(this.store.regionState(this.region).cloudformation, record, `${api.revision}:${value.revision}`, this.clock.now()); await hotswapCheckpoint(this.store.regionState(this.region).cloudformation, "after-direct-call", record); await this.store.save(); return controlJson(res, { functionConfiguration: value }); }
        catch (error) { if (record.status === "PENDING") failHotswapDrift(record, error, this.clock.now()); await this.store.save(); throw error; }
      }
      if (functionPath && method === "DELETE") {
        await this.deleteFunction(decodePathPart(functionPath[1], "API ID"), decodePathPart(functionPath[2], "function ID"));
        return controlJson(res, {});
      }
      if (resolversPath && method === "POST") {
        return controlJson(res, { resolver: await this.createResolver(
          decodePathPart(resolversPath[1], "API ID"),
          decodePathPart(resolversPath[2], "type name"),
          await this.input(req),
        ) });
      }
      if (resolversPath && method === "GET") {
        return controlJson(res, this.listResolvers(
          decodePathPart(resolversPath[1], "API ID"),
          decodePathPart(resolversPath[2], "type name"),
          url,
        ));
      }
      if (resolverPath && method === "GET") {
        const api = this.requireApi(decodePathPart(resolverPath[1], "API ID"));
        return controlJson(res, { resolver: this.publicResolver(this.requireResolver(
          api,
          decodePathPart(resolverPath[2], "type name"),
          decodePathPart(resolverPath[3], "field name"),
        )) });
      }
      if (resolverPath && method === "POST") {
        const apiId = decodePathPart(resolverPath[1], "API ID"); const typeName = decodePathPart(resolverPath[2], "type name"); const fieldName = decodePathPart(resolverPath[3], "field name"); const parsed = await this.inputWithPayload(req);
        if (!isPinnedCdkHotswapRequest(req, "appsync")) return controlJson(res, { resolver: await this.updateResolver(apiId, typeName, fieldName, parsed.input) });
        const api = this.requireApi(apiId); const resolver = this.requireResolver(api, typeName, fieldName);
        const record = beginHotswapDrift(this.store.regionState(this.region).cloudformation, uniqueCompletedOwner(this.store.regionState(this.region).cloudformation, appSyncResolverOwnershipKey(apiId, typeName, fieldName)), "appsync", "UpdateResolver", parsed.payload, `${api.revision}:${resolver.revision}`, this.clock.now());
        try { await hotswapCheckpoint(this.store.regionState(this.region).cloudformation, "before-direct-call", record); const value = await this.updateResolver(apiId, typeName, fieldName, parsed.input); completeHotswapDrift(this.store.regionState(this.region).cloudformation, record, `${api.revision}:${value.revision}`, this.clock.now()); await hotswapCheckpoint(this.store.regionState(this.region).cloudformation, "after-direct-call", record); await this.store.save(); return controlJson(res, { resolver: value }); }
        catch (error) { if (record.status === "PENDING") failHotswapDrift(record, error, this.clock.now()); await this.store.save(); throw error; }
      }
      if (resolverPath && method === "DELETE") {
        await this.deleteResolver(
          decodePathPart(resolverPath[1], "API ID"),
          decodePathPart(resolverPath[2], "type name"),
          decodePathPart(resolverPath[3], "field name"),
        );
        return controlJson(res, {});
      }
      if (tagsPath && method === "GET") {
        return controlJson(res, { tags: { ...this.apiByArn(decodePathPart(tagsPath[1], "resource ARN")).tags } });
      }
      if (tagsPath && method === "POST") {
        await this.tagResource(decodePathPart(tagsPath[1], "resource ARN"), await this.input(req));
        return controlJson(res, {});
      }
      if (tagsPath && method === "DELETE") {
        await this.untagResource(decodePathPart(tagsPath[1], "resource ARN"), url.searchParams.getAll("tagKeys"));
        return controlJson(res, {});
      }
      if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/v2/")) {
        throw new AwsError(
          "UnsupportedOperationException",
          "This AppSync operation is outside the frozen 32-action boundary through AMX-05.",
          400,
        );
      }
      throw new AwsError("NotFoundException", "The AppSync resource was not found.", 404);
    } catch (error) {
      sendControlError(res, error);
    }
  }

  async handleGraphql(req: IncomingMessage, res: ServerResponse, apiId: string, url?: URL, requestId = "appsync-graphql"): Promise<void> {
    const startedAt = this.clock.now();
    res.setHeader("cache-control", "no-store");
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-expose-headers", "x-amzn-errortype,x-amzn-requestid,x-amz-request-id");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("access-control-allow-methods", "POST,OPTIONS");
      res.setHeader("access-control-allow-headers", "authorization,content-type,x-api-key,x-amz-date,x-amz-security-token,x-amz-user-agent");
      res.setHeader("access-control-max-age", "600");
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return this.graphqlFailure(res, apiId, startedAt, 405, "MethodNotAllowed", "Only POST is supported.");
    }
    const liveApi = this.state.graphqlApis[apiId];
    if (!liveApi) return this.graphqlFailure(res, apiId, startedAt, 404, "NotFoundException", "The GraphQL API was not found.");

    const suppliedKey = Array.isArray(req.headers["x-api-key"]) ? undefined : req.headers["x-api-key"];
    const hasIamAuthorization = (typeof req.headers.authorization === "string"
      && /^AWS4-HMAC-SHA256\s/i.test(req.headers.authorization))
      || url?.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256";
    if (suppliedKey !== undefined && hasIamAuthorization) {
      return this.graphqlFailure(res, apiId, startedAt, 401, "UnauthorizedException", "Specify exactly one authorization mode.");
    }
    let authorizationMode: GraphqlAuthorizationMode;
    let principal: PrincipalContext | undefined;
    if (typeof suppliedKey === "string") {
      if (!(await this.validApiKey(liveApi, suppliedKey))) {
        return this.graphqlFailure(res, apiId, startedAt, 401, "UnauthorizedException", "You are not authorized to make this call.", "API_KEY");
      }
      authorizationMode = "API_KEY";
    } else if (hasIamAuthorization
      && liveApi.additionalAuthenticationProviders.some(provider => provider.authenticationType === "AWS_IAM")
      && this.iamHooks && url) {
      try {
        principal = await this.iamHooks.authenticate(req, url);
      } catch (error) {
        const aws = error instanceof AwsError ? error : undefined;
        return this.graphqlFailure(
          res,
          apiId,
          startedAt,
          aws?.status === 403 ? 403 : 401,
          aws?.code ?? "UnauthorizedException",
          aws?.message ?? "You are not authorized to make this call.",
          "AWS_IAM",
        );
      }
      if (principal.accountId !== liveApi.owner) {
        return this.graphqlFailure(res, apiId, startedAt, 403, "AccessDeniedException", "Cross-account AppSync GraphQL access is not supported.", "AWS_IAM");
      }
      authorizationMode = "AWS_IAM";
    } else {
      return this.graphqlFailure(res, apiId, startedAt, 401, "UnauthorizedException", "You are not authorized to make this call.", hasIamAuthorization ? "AWS_IAM" : undefined);
    }

    let input: Record<string, unknown>;
    try {
      const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        return this.graphqlFailure(res, apiId, startedAt, 400, "BadRequestException", "The request content type must be application/json.", authorizationMode);
      }
      const body = await readBody(req);
      if (body.length > GRAPHQL_BODY_LIMIT) return this.graphqlFailure(res, apiId, startedAt, 413, "RequestTooLarge", "The GraphQL request is too large.", authorizationMode);
      const parsed = JSON.parse(body.toString("utf8"));
      if (!validObject(parsed)) throw new Error();
      input = parsed;
    } catch {
      return this.graphqlFailure(res, apiId, startedAt, 400, "MalformedHttpRequestException", "The GraphQL request body is not valid JSON.", authorizationMode);
    }

    if (typeof input.query !== "string" || !input.query) {
      return this.graphqlFailure(res, apiId, startedAt, 400, "BadRequestException", "The GraphQL request must contain a query string.", authorizationMode);
    }
    if (Buffer.byteLength(input.query, "utf8") > GRAPHQL_QUERY_LIMIT) {
      return this.graphqlFailure(res, apiId, startedAt, 413, "RequestTooLarge", "The GraphQL query is too large.", authorizationMode);
    }
    if (input.variables !== undefined && (!validObject(input.variables)
      || Buffer.byteLength(JSON.stringify(input.variables), "utf8") > GRAPHQL_VARIABLES_LIMIT)) {
      return this.graphqlFailure(res, apiId, startedAt, 400, "BadRequestException", "GraphQL variables must be a bounded JSON object.", authorizationMode);
    }
    if (input.operationName !== undefined && typeof input.operationName !== "string") {
      return this.graphqlFailure(res, apiId, startedAt, 400, "BadRequestException", "operationName must be a string.", authorizationMode);
    }
    const limitError = operationLimitError(input.query, input.operationName as string | undefined);
    if (limitError) {
      return this.graphqlFailure(res, apiId, startedAt, 400, "QueryLimitExceeded", limitError, authorizationMode);
    }

    const api = structuredClone(liveApi);
    if (!api.schema) return this.graphqlFailure(res, apiId, startedAt, 400, "BadRequestException", "The GraphQL API has no active schema.", authorizationMode);
    if (this.activeGraphqlRequests >= GRAPHQL_CONCURRENCY_LIMIT) {
      return this.graphqlFailure(
        res,
        apiId,
        startedAt,
        429,
        "ThrottlingException",
        `The local AppSync concurrency limit of ${GRAPHQL_CONCURRENCY_LIMIT} was exceeded.`,
        authorizationMode,
      );
    }
    this.activeGraphqlRequests++;

    try {
      const schema = this.compiledSchema(api);
      const completedMutationFields: Array<{ fieldName: string; responseKey: string }> = [];
      const finish = async (response: { data?: unknown; errors?: readonly GraphQLError[] }): Promise<void> => {
        const encoded = Buffer.from(JSON.stringify(response), "utf8");
        if (encoded.length > GRAPHQL_RESPONSE_LIMIT) {
          return this.graphqlFailure(res, apiId, startedAt, 413, "ResponseTooLarge", "The GraphQL response is too large.", authorizationMode);
        }
        await Promise.all([
          this.publishMetric(apiId, "GraphQLRequestCount", 1, "Count"),
          this.publishMetric(apiId, "GraphQLRequestCount", 1, "Count", { AuthenticationType: authorizationMode }),
          this.publishMetric(apiId, "Latency", Math.max(0, this.clock.now() - startedAt), "Milliseconds"),
          this.publishMetric(apiId, "Latency", Math.max(0, this.clock.now() - startedAt), "Milliseconds", { AuthenticationType: authorizationMode }),
          ...((response.errors?.length ?? 0) > 0
            ? [
              this.publishMetric(apiId, "GraphQLErrorCount", response.errors!.length, "Count"),
              this.publishMetric(apiId, "GraphQLErrorCount", response.errors!.length, "Count", { AuthenticationType: authorizationMode }),
            ]
            : []),
        ]);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(encoded);
        if (validObject(response.data)) {
          for (const candidate of completedMutationFields) {
            const failed = response.errors?.some(error => error.path?.[0] === candidate.responseKey);
            const value = response.data[candidate.responseKey];
            if (failed || value === null || value === undefined) continue;
            const completion: RealtimeMutationCompletion = {
              api,
              fieldName: candidate.fieldName,
              value: structuredClone(value),
              candidates: this.realtimeMutationCandidates(api, candidate.fieldName),
            };
            queueMicrotask(() => void this.publishRealtimeMutation(completion));
          }
        }
      };
      let document: DocumentNode;
      try {
        document = parse(input.query);
      } catch (error) {
        await finish({ errors: [error instanceof GraphQLError ? error : new GraphQLError("The GraphQL document is invalid.")] });
        return;
      }
      const rules = api.introspectionConfig === "DISABLED"
        ? [...specifiedRules, NoSchemaIntrospectionCustomRule]
        : specifiedRules;
      const validationErrors = validate(schema, document, rules);
      if (validationErrors.length) {
        await finish({ errors: validationErrors });
        return;
      }
      const operation = getOperationAST(document, input.operationName as string | undefined);
      if (!operation) {
        const result = await graphql({
          schema,
          source: input.query,
          operationName: input.operationName as string | undefined,
          variableValues: input.variables as Record<string, unknown> | undefined,
        });
        await finish(result);
        return;
      }
      if (operation.operation === "subscription") {
        await finish({ errors: [new GraphQLError("GraphQL subscriptions must be registered through this API's AppSync realtime endpoint.", {
          extensions: { errorType: "UnsupportedOperation" },
        })] });
        return;
      }
      const coerced = getVariableValues(
        schema,
        operation.variableDefinitions ?? [],
        input.variables as Record<string, unknown> | undefined ?? {},
      );
      if (coerced.errors) {
        await finish({ errors: coerced.errors });
        return;
      }
      const variables = { ...coerced.variableValues.coerced };
      const rootType = operation.operation === "mutation" ? schema.getMutationType() : schema.getQueryType();
      if (!rootType) {
        await finish({ errors: [new GraphQLError(`Schema is not configured to execute ${operation.operation} operations.`)] });
        return;
      }
      const deniedRootFields = new Set<string>();
      const selectedFields = selectedRootFieldNames(document, operation, variables);
      for (const fieldName of selectedFields) {
        if (!schemaAllowsMode(rootType, fieldName, authorizationMode)) {
          deniedRootFields.add(`${rootType.name}.${fieldName}`);
          continue;
        }
        if (authorizationMode !== "AWS_IAM" || !principal) continue;
        const resource = `${api.arn}/types/${rootType.name}/fields/${fieldName}`;
        const sourceIp = req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "";
        const result = await this.iamHooks!.authorize(principal, resource, {
          "aws:PrincipalArn": principal.principalArn,
          "aws:PrincipalAccount": principal.accountId,
          "aws:RequestedRegion": this.region,
          "aws:CurrentTime": new Date(this.clock.now()).toISOString(),
          "aws:SourceIp": sourceIp,
          "aws:UserAgent": req.headers["user-agent"] ?? "",
          "aws:SecureTransport": Boolean((req.socket as any).encrypted),
          "appsync:GraphQLApiId": api.apiId,
          "appsync:TypeName": rootType.name,
          "appsync:FieldName": fieldName,
        }, requestId);
        if (result.decision !== "allowed") deniedRootFields.add(`${rootType.name}.${fieldName}`);
      }
      if (selectedFields.some(fieldName => fieldName.startsWith("__")
        && deniedRootFields.has(`${rootType.name}.${fieldName}`))) {
        await finish({ errors: [new GraphQLError("Not Authorized to access introspection on this API", {
          extensions: { errorType: "Unauthorized" },
        })] });
        return;
      }
      const appendedErrors: Array<{ error: AppSyncVtlErrorShape; path: Array<string | number> }> = [];
      const rootTypes = new Set([
        schema.getQueryType()?.name,
        schema.getMutationType()?.name,
      ].filter((value): value is string => Boolean(value)));
      const fieldResolver: GraphQLFieldResolver<unknown, Record<string, never>> = async (source, args, _context, info) => {
        if (!schemaAllowsMode(info.parentType, info.fieldName, authorizationMode)
          || deniedRootFields.has(`${info.parentType.name}.${info.fieldName}`)) {
          throw new GraphQLError(`Not Authorized to access ${info.fieldName} on type ${info.parentType.name}`, {
            extensions: { errorType: "Unauthorized" },
          });
        }
        const resolverStartedAt = this.clock.now();
        const resolver = api.resolvers[this.resolverKey(info.parentType.name, info.fieldName)];
        if (!resolver) {
          if (rootTypes.has(info.parentType.name)) {
            throw new GraphQLError(`No resolver is configured for ${info.parentType.name}.${info.fieldName}.`, {
              extensions: { errorType: "ResolverNotFound" },
            });
          }
          return defaultFieldResolver(source, args, _context, info);
        }
        const dataSource = resolver.dataSourceName === undefined ? undefined : api.dataSources[resolver.dataSourceName];
        if (resolver.kind === "UNIT" && !dataSource) {
          throw new GraphQLError("The resolver data source is missing or stale.", {
            extensions: { errorType: "DataSourceNotFound" },
          });
        }
        const path = graphqlPath(info.path);
        const resolverContext = {
          arguments: structuredClone(args),
          source: source === undefined ? null : structuredClone(source),
          identity: authorizationMode === "AWS_IAM" && principal ? {
            accountId: principal.accountId,
            sourceIp: [req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? ""],
            username: principal.userName ?? principal.principalId,
            userArn: principal.principalArn,
          } : null,
          stash: {},
          request: { headers: resolverHeaders(req) },
          info: {
            fieldName: info.fieldName,
            parentTypeName: info.parentType.name,
            variables: input.variables === undefined ? {} : structuredClone(input.variables),
          },
          authType: authorizationMode === "AWS_IAM" ? "IAM Authorization" : "API Key Authorization",
          authorizationScope: createHash("sha256").update(
            authorizationMode === "AWS_IAM"
              ? `AWS_IAM\0${principal?.principalArn ?? ""}`
              : `API_KEY\0${suppliedKey ?? ""}`,
          ).digest("hex"),
        };
        try {
          const evaluation = resolver.kind === "PIPELINE"
            ? await this.executePipelineResolver(api, resolver, resolverContext)
            : dataSource!.type === "NONE"
            ? executeNoneResolver(
              resolver.requestMappingTemplate,
              resolver.responseMappingTemplate,
              resolverContext,
              this.clock.now(),
            )
            : this.dynamodb && this.assumeServiceRole && dataSource!.type === "AMAZON_DYNAMODB"
                && dataSource!.serviceRoleArn && dataSource!.dynamodbConfig
              ? await executeDynamoResolver(
                {
                  store: this.store,
                  region: this.region,
                  clock: this.clock,
                  dynamodb: this.dynamodb,
                  assumeServiceRole: this.assumeServiceRole,
                },
                api,
                resolver,
                dataSource as AppSyncDataSourceState & {
                  type: "AMAZON_DYNAMODB";
                  serviceRoleArn: string;
                  dynamodbConfig: { tableName: string; awsRegion: string };
                },
                resolverContext,
              )
              : undefined;
          if (!evaluation) {
            throw new AppSyncVtlError("The resolver data source is missing or stale.", "DataSourceNotFound");
          }
          for (const error of evaluation.appendedErrors) appendedErrors.push({ error, path });
          await Promise.all([
            this.publishMetric(apiId, "ResolverRequestCount", 1, "Count"),
            this.publishMetric(apiId, "ResolverLatency", Math.max(0, this.clock.now() - resolverStartedAt), "Milliseconds"),
            this.publishMetric(apiId, "DataSourceLatency", Math.max(0, this.clock.now() - resolverStartedAt), "Milliseconds"),
            this.publishMetric(apiId, "ResolverRequestCount", 1, "Count", { TypeName: info.parentType.name, FieldName: info.fieldName }),
            this.publishMetric(apiId, "ResolverLatency", Math.max(0, this.clock.now() - resolverStartedAt), "Milliseconds", { TypeName: info.parentType.name, FieldName: info.fieldName }),
            this.publishMetric(apiId, "ResolverRequestCount", 1, "Count", { AuthenticationType: authorizationMode, TypeName: info.parentType.name, FieldName: info.fieldName }),
            this.publishMetric(apiId, "ResolverLatency", Math.max(0, this.clock.now() - resolverStartedAt), "Milliseconds", { AuthenticationType: authorizationMode, TypeName: info.parentType.name, FieldName: info.fieldName }),
            this.publishMetric(apiId, "DataSourceLatency", Math.max(0, this.clock.now() - resolverStartedAt), "Milliseconds", { AuthenticationType: authorizationMode, TypeName: info.parentType.name, FieldName: info.fieldName }),
          ]);
          if (info.parentType.name === schema.getMutationType()?.name && evaluation.value !== null && evaluation.value !== undefined) {
            completedMutationFields.push({ fieldName: info.fieldName, responseKey: String(path[0] ?? info.fieldName) });
          }
          return evaluation.value;
        } catch (error) {
          await Promise.all([
            this.publishMetric(apiId, "ResolverRequestCount", 1, "Count"),
            this.publishMetric(apiId, "ResolverErrorCount", 1, "Count"),
            this.publishMetric(apiId, "ResolverLatency", Math.max(0, this.clock.now() - resolverStartedAt), "Milliseconds"),
            this.publishMetric(apiId, "ResolverErrorCount", 1, "Count", { TypeName: info.parentType.name, FieldName: info.fieldName }),
            this.publishMetric(apiId, "ResolverRequestCount", 1, "Count", { AuthenticationType: authorizationMode, TypeName: info.parentType.name, FieldName: info.fieldName }),
            this.publishMetric(apiId, "ResolverErrorCount", 1, "Count", { AuthenticationType: authorizationMode, TypeName: info.parentType.name, FieldName: info.fieldName }),
            this.publishMetric(apiId, "ResolverLatency", Math.max(0, this.clock.now() - resolverStartedAt), "Milliseconds", { AuthenticationType: authorizationMode, TypeName: info.parentType.name, FieldName: info.fieldName }),
          ]);
          const vtl = error instanceof AppSyncVtlError
            ? error
            : new AppSyncVtlError("The resolver mapping failed.");
          throw new GraphQLError(vtl.message, {
            extensions: {
              errorType: vtl.errorType,
              ...(vtl.data === undefined ? {} : { data: vtl.data }),
              ...(vtl.errorInfo === undefined ? {} : { errorInfo: vtl.errorInfo }),
            },
          });
        }
      };
      const result = await graphql({
        schema,
        source: input.query,
        operationName: input.operationName as string | undefined,
        variableValues: input.variables as Record<string, unknown> | undefined,
        fieldResolver,
        ...(api.introspectionConfig === "DISABLED"
          ? { rules: [...specifiedRules, NoSchemaIntrospectionCustomRule] }
          : {}),
      });
      const response = appendedErrors.length
        ? {
          ...result,
          errors: [
            ...(result.errors ?? []),
            ...appendedErrors.map(({ error, path }) => new GraphQLError(error.message, {
              path,
              extensions: {
                errorType: error.errorType ?? "CustomTemplateException",
                ...(error.data === undefined ? {} : { data: error.data }),
                ...(error.errorInfo === undefined ? {} : { errorInfo: error.errorInfo }),
              },
            })),
          ],
        }
        : result;
      await finish(response);
    } catch {
      await this.graphqlFailure(res, apiId, startedAt, 500, "InternalFailure", "The GraphQL request failed internally.", authorizationMode);
    } finally {
      this.activeGraphqlRequests--;
    }
  }

  private get state() {
    return this.store.regionState(this.region).appsync;
  }

  private async input(req: IncomingMessage): Promise<Record<string, unknown>> {
    return (await this.inputWithPayload(req)).input;
  }

  private async inputWithPayload(req: IncomingMessage): Promise<{ input: Record<string, unknown>; payload: Buffer }> {
    const body = await readBody(req);
    if (body.length > CONTROL_BODY_LIMIT) throw new AwsError("PayloadTooLargeException", "The AppSync request is too large.", 413);
    if (!body.length) return { input: {}, payload: body };
    try {
      const value = JSON.parse(body.toString("utf8"));
      if (!validObject(value)) throw new Error();
      return { input: value, payload: body };
    } catch {
      throw new AwsError("BadRequestException", "The AppSync request body is not valid JSON.", 400);
    }
  }

  private evaluateMappingTemplate(input: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(input, ["template", "context"]);
    const template = requireString(input.template, "template", 64 * 1024);
    const contextText = requireString(input.context, "context", 256 * 1024);
    let supplied: Record<string, unknown>;
    try {
      const parsed = JSON.parse(contextText);
      if (!validObject(parsed)) throw new Error();
      supplied = parsed;
    } catch {
      throw new AwsError("BadRequestException", "context must encode one JSON object.", 400);
    }
    const stash = validObject(supplied.stash) ? structuredClone(supplied.stash) : {};
    try {
      const evaluation = evaluateAppSyncVtl(template, {
        arguments: validObject(supplied.arguments)
          ? structuredClone(supplied.arguments)
          : validObject(supplied.args) ? structuredClone(supplied.args) : {},
        source: supplied.source === undefined ? null : structuredClone(supplied.source),
        result: supplied.result === undefined ? null : structuredClone(supplied.result),
        error: validObject(supplied.error)
          ? {
            message: String(supplied.error.message ?? ""),
            ...(supplied.error.type === undefined ? {} : { type: String(supplied.error.type) }),
            ...(supplied.error.data === undefined ? {} : { data: structuredClone(supplied.error.data) }),
          }
          : null,
        identity: supplied.identity === undefined ? null : structuredClone(supplied.identity),
        stash,
        prev: validObject(supplied.prev)
          ? { result: structuredClone(supplied.prev.result) }
          : { result: null },
        request: validObject(supplied.request)
          ? structuredClone(supplied.request) as { headers?: Record<string, string> }
          : { headers: {} },
        info: validObject(supplied.info) ? structuredClone(supplied.info) : {},
      }, this.clock.now());
      return {
        evaluationResult: JSON.stringify(evaluation.value),
        logs: evaluation.logs,
        stash: JSON.stringify(evaluation.stash),
        outErrors: JSON.stringify(evaluation.appendedErrors),
      };
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : "The mapping template evaluation failed.",
        },
        logs: [],
        stash: JSON.stringify(stash),
        outErrors: "[]",
      };
    }
  }

  private apiUris(apiId: string): Record<"GRAPHQL" | "REALTIME", string> {
    const base = this.endpoint().replace(/\/$/, "");
    const realtimeBase = base.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    return {
      GRAPHQL: `${base}/graphql/${this.region}/${apiId}`,
      REALTIME: `${realtimeBase}/graphql/${this.region}/${apiId}/realtime`,
    };
  }

  private publicApi(api: AppSyncGraphqlApiState): Record<string, unknown> {
    return {
      name: api.name,
      apiId: api.apiId,
      authenticationType: api.authenticationType,
      ...(api.additionalAuthenticationProviders.length
        ? { additionalAuthenticationProviders: api.additionalAuthenticationProviders.map(provider => ({ ...provider })) }
        : {}),
      arn: api.arn,
      uris: { ...api.uris },
      tags: { ...api.tags },
      xrayEnabled: api.xrayEnabled,
      visibility: api.visibility,
      apiType: api.apiType,
      owner: api.owner,
      ...(api.ownerContact === undefined ? {} : { ownerContact: api.ownerContact }),
      introspectionConfig: api.introspectionConfig,
      queryDepthLimit: api.queryDepthLimit,
      resolverCountLimit: api.resolverCountLimit,
    };
  }

  private validateApiConfiguration(input: Record<string, unknown>, create: boolean): {
    name: string;
    ownerContact?: string;
    introspectionConfig: "ENABLED" | "DISABLED";
    queryDepthLimit: 0;
    resolverCountLimit: 0;
    additionalAuthenticationProviders: Array<{ authenticationType: "AWS_IAM" }>;
  } {
    rejectUnknown(input, create
      ? [
        "name", "authenticationType", "logConfig", "userPoolConfig", "openIDConnectConfig",
        "tags", "additionalAuthenticationProviders", "xrayEnabled", "lambdaAuthorizerConfig",
        "apiType", "mergedApiExecutionRoleArn", "visibility", "ownerContact",
        "introspectionConfig", "queryDepthLimit", "resolverCountLimit", "enhancedMetricsConfig",
      ]
      : [
        "name", "authenticationType", "logConfig", "userPoolConfig", "openIDConnectConfig",
        "additionalAuthenticationProviders", "xrayEnabled", "lambdaAuthorizerConfig",
        "mergedApiExecutionRoleArn", "ownerContact", "introspectionConfig", "queryDepthLimit",
        "resolverCountLimit", "enhancedMetricsConfig",
      ]);
    const name = requireString(input.name, "name", 65_536);
    if (input.authenticationType !== "API_KEY") {
      throw new AwsError("BadRequestException", "APS-P0-006 supports only API_KEY authorization.", 400);
    }
    let additionalAuthenticationProviders: Array<{ authenticationType: "AWS_IAM" }> = [];
    if (input.additionalAuthenticationProviders !== undefined) {
      if (!Array.isArray(input.additionalAuthenticationProviders)
        || input.additionalAuthenticationProviders.length > 1
        || (input.additionalAuthenticationProviders.length === 1
          && (!validObject(input.additionalAuthenticationProviders[0])
            || Object.keys(input.additionalAuthenticationProviders[0]).length !== 1
            || input.additionalAuthenticationProviders[0].authenticationType !== "AWS_IAM"))) {
        throw new AwsError(
          "BadRequestException",
          "AMX-06 supports an empty list or exactly one additional AWS_IAM authorization provider.",
          400,
        );
      }
      additionalAuthenticationProviders = input.additionalAuthenticationProviders.length
        ? [{ authenticationType: "AWS_IAM" }]
        : [];
    }
    if (input.userPoolConfig !== undefined
      || input.openIDConnectConfig !== undefined
      || input.lambdaAuthorizerConfig !== undefined) {
      throw new AwsError("BadRequestException", "Cognito, OIDC, and Lambda authorization modes are not implemented.", 400);
    }
    if (input.logConfig !== undefined || input.enhancedMetricsConfig !== undefined || input.xrayEnabled === true) {
      throw new AwsError("BadRequestException", "AppSync logging, enhanced metrics, and X-Ray are not implemented.", 400);
    }
    if (input.xrayEnabled !== undefined && input.xrayEnabled !== false) {
      throw new AwsError("BadRequestException", "xrayEnabled must remain false.", 400);
    }
    if (input.mergedApiExecutionRoleArn !== undefined) {
      throw new AwsError("BadRequestException", "Merged APIs are not implemented.", 400);
    }
    if (create && input.apiType !== undefined && input.apiType !== "GRAPHQL") {
      throw new AwsError("BadRequestException", "Only standard GRAPHQL APIs are implemented.", 400);
    }
    if (create && input.visibility !== undefined && input.visibility !== "GLOBAL") {
      throw new AwsError("BadRequestException", "Private GraphQL APIs are not implemented.", 400);
    }
    if (input.introspectionConfig !== undefined && input.introspectionConfig !== "ENABLED" && input.introspectionConfig !== "DISABLED") {
      throw new AwsError("BadRequestException", "introspectionConfig must be ENABLED or DISABLED.", 400);
    }
    const queryDepthLimit = input.queryDepthLimit === undefined ? 0 : Number(input.queryDepthLimit);
    const resolverCountLimit = input.resolverCountLimit === undefined ? 0 : Number(input.resolverCountLimit);
    if (!Number.isInteger(queryDepthLimit) || queryDepthLimit !== 0) {
      throw new AwsError("BadRequestException", "Nonzero queryDepthLimit is not implemented yet.", 400);
    }
    if (!Number.isInteger(resolverCountLimit) || resolverCountLimit !== 0) {
      throw new AwsError("BadRequestException", "Nonzero resolverCountLimit is not implemented yet.", 400);
    }
    const ownerContact = input.ownerContact === undefined ? undefined : requireString(input.ownerContact, "ownerContact", 256);
    return {
      name,
      ...(ownerContact === undefined ? {} : { ownerContact }),
      introspectionConfig: input.introspectionConfig === "DISABLED" ? "DISABLED" : "ENABLED",
      queryDepthLimit: 0,
      resolverCountLimit: 0,
      additionalAuthenticationProviders,
    };
  }

  private async createGraphqlApi(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const configuration = this.validateApiConfiguration(input, true);
    const tags = input.tags === undefined ? {} : validateTags(input.tags);
    return this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}`, async () => {
      if (Object.keys(this.state.graphqlApis).length >= API_LIMIT) {
        throw new AwsError("LimitExceededException", "The regional GraphQL API limit was exceeded.", 400);
      }
      let apiId: string;
      do apiId = randomBytes(13).toString("hex"); while (this.state.graphqlApis[apiId]);
      const now = this.clock.now();
      const api: AppSyncGraphqlApiState = {
        apiId,
        generation: randomUUID(),
        arn: `arn:aws:appsync:${this.region}:${this.store.accountId}:apis/${apiId}`,
        name: configuration.name,
        authenticationType: "API_KEY",
        additionalAuthenticationProviders: configuration.additionalAuthenticationProviders,
        uris: this.apiUris(apiId),
        tags,
        xrayEnabled: false,
        visibility: "GLOBAL",
        apiType: "GRAPHQL",
        owner: this.store.accountId,
        ...(configuration.ownerContact === undefined ? {} : { ownerContact: configuration.ownerContact }),
        introspectionConfig: configuration.introspectionConfig,
        queryDepthLimit: configuration.queryDepthLimit,
        resolverCountLimit: configuration.resolverCountLimit,
        createdAt: now,
        updatedAt: now,
        revision: 1,
        schemaStatus: "NOT_APPLICABLE",
        apiKeys: {},
        dataSources: {},
        functions: {},
        resolvers: {},
      };
      this.state.graphqlApis[apiId] = api;
      this.state.revision++;
      await this.store.save();
      return this.publicApi(api);
    });
  }

  private async updateGraphqlApi(apiId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const configuration = this.validateApiConfiguration(input, false);
    return this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId);
      api.name = configuration.name;
      api.additionalAuthenticationProviders = configuration.additionalAuthenticationProviders;
      api.introspectionConfig = configuration.introspectionConfig;
      api.queryDepthLimit = configuration.queryDepthLimit;
      api.resolverCountLimit = configuration.resolverCountLimit;
      if (configuration.ownerContact === undefined) delete api.ownerContact;
      else api.ownerContact = configuration.ownerContact;
      api.updatedAt = this.clock.now();
      api.revision++;
      this.state.revision++;
      await this.store.save();
      this.closeRealtimeApi(apiId);
      return this.publicApi(api);
    });
  }

  private async deleteGraphqlApi(apiId: string): Promise<void> {
    const materialIds = await this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId);
      const references = Object.values(api.apiKeys).map(key => key.materialId);
      delete this.state.graphqlApis[apiId];
      this.state.revision++;
      await this.store.save();
      this.schemas.delete(apiId);
      this.closeRealtimeApi(apiId, "AppSync API deleted");
      return references;
    });
    for (const materialId of materialIds) await this.materials.remove(materialId);
  }

  private listGraphqlApis(url: URL): Record<string, unknown> {
    const apiType = url.searchParams.get("apiType");
    if (apiType !== null && apiType !== "GRAPHQL") return { graphqlApis: [] };
    const owner = url.searchParams.get("owner");
    if (owner !== null && owner !== "CURRENT_ACCOUNT") return { graphqlApis: [] };
    const limit = maxResults(url);
    const nextToken = url.searchParams.get("nextToken");
    let offset = 0;
    if (nextToken !== null) {
      try {
        const cursor = this.tokens.decode<{
          offset: number;
          revision: number;
          region: string;
          apiType: string | null;
          owner: string | null;
        }>("AppSync.ListGraphqlApis", nextToken);
        if (!Number.isInteger(cursor.offset) || cursor.offset < 0
          || cursor.revision !== this.state.revision || cursor.region !== this.region
          || cursor.apiType !== apiType || cursor.owner !== owner) throw new Error();
        offset = cursor.offset;
      } catch {
        throw new AwsError("BadRequestException", "nextToken is invalid.", 400);
      }
    }
    const all = Object.values(this.state.graphqlApis).sort((left, right) =>
      left.createdAt - right.createdAt || left.apiId.localeCompare(right.apiId));
    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      graphqlApis: page.map(api => this.publicApi(api)),
      ...(nextOffset < all.length
        ? { nextToken: this.tokens.encode("AppSync.ListGraphqlApis", {
          offset: nextOffset,
          revision: this.state.revision,
          region: this.region,
          apiType,
          owner,
        }) }
        : {}),
    };
  }

  private requireApi(apiId: string): AppSyncGraphqlApiState {
    const api = this.state.graphqlApis[apiId];
    if (!api) throw new AwsError("NotFoundException", "The GraphQL API was not found.", 404);
    return api;
  }

  private apiByArn(arn: string): AppSyncGraphqlApiState {
    const expectedPrefix = `arn:aws:appsync:${this.region}:${this.store.accountId}:apis/`;
    if (!arn.startsWith(expectedPrefix)) throw new AwsError("NotFoundException", "The AppSync resource was not found.", 404);
    const api = Object.values(this.state.graphqlApis).find(candidate => candidate.arn === arn);
    if (!api) throw new AwsError("NotFoundException", "The AppSync resource was not found.", 404);
    return api;
  }

  private async tagResource(arn: string, input: Record<string, unknown>): Promise<void> {
    rejectUnknown(input, ["tags"]);
    const additions = validateTags(input.tags);
    await this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:tags`, async () => {
      const api = this.apiByArn(arn);
      const tags = { ...api.tags, ...additions };
      if (Object.keys(tags).length > MAX_TAGS) throw new AwsError("LimitExceededException", `A GraphQL API can have at most ${MAX_TAGS} tags.`, 400);
      api.tags = tags;
      api.updatedAt = this.clock.now();
      api.revision++;
      this.state.revision++;
      await this.store.save();
    });
  }

  private async untagResource(arn: string, tagKeys: string[]): Promise<void> {
    if (!tagKeys.length || tagKeys.some(key => !key || key.length > 128)) {
      throw new AwsError("BadRequestException", "tagKeys must contain at least one valid tag key.", 400);
    }
    await this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:tags`, async () => {
      const api = this.apiByArn(arn);
      for (const key of tagKeys) delete api.tags[key];
      api.updatedAt = this.clock.now();
      api.revision++;
      this.state.revision++;
      await this.store.save();
    });
  }

  private decodeSchemaDefinition(input: Record<string, unknown>): string {
    rejectUnknown(input, ["definition"]);
    const encoded = requireString(input.definition, "definition", Math.ceil(SCHEMA_LIMIT * 4 / 3) + 8);
    try {
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length > SCHEMA_LIMIT || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) throw new Error();
      const definition = bytes.toString("utf8");
      if (!definition || Buffer.from(definition, "utf8").length !== bytes.length) throw new Error();
      return definition;
    } catch {
      throw new AwsError("BadRequestException", "The schema definition blob is invalid.", 400);
    }
  }

  private validateSchemaDefinition(api: AppSyncGraphqlApiState, definition: string): GraphQLSchema {
    if (/@aws_(?:cognito_user_pools|lambda|oidc|auth)\b/.test(definition)) {
      throw new Error("The schema references an authorization mode that is not implemented.");
    }
    if (/@aws_iam\b/.test(definition)
      && !api.additionalAuthenticationProviders.some(provider => provider.authenticationType === "AWS_IAM")) {
      throw new Error("The schema references AWS_IAM but the API does not activate that additional authorization mode.");
    }
    const schema = buildSchema(`${APPSYNC_SCALAR_SDL}\n${APPSYNC_AUTH_DIRECTIVE_SDL}\n${definition}`);
    configureAppSyncScalars(schema);
    const errors = validateSchema(schema);
    if (errors.length) throw new Error(errors[0].message);
    for (const resolver of Object.values(api.resolvers)) {
      const type = schema.getType(resolver.typeName);
      if (!type || !isObjectType(type) || !type.getFields()[resolver.fieldName]) {
        throw new Error(`The active resolver ${resolver.typeName}.${resolver.fieldName} is not present in the schema.`);
      }
    }
    return schema;
  }

  private async startSchemaCreation(apiId: string, input: Record<string, unknown>): Promise<"PROCESSING"> {
    const definition = this.decodeSchemaDefinition(input);
    const digest = createHash("sha256").update(definition, "utf8").digest("hex");
    await this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId);
      if (api.pendingSchema?.status === "PROCESSING") {
        throw new AwsError("ConcurrentModificationException", "A schema creation is already in progress.", 409);
      }
      api.pendingSchema = {
        generation: randomUUID(),
        digest,
        definition,
        status: "PROCESSING",
        createdAt: this.clock.now(),
      };
      api.schemaStatus = "PROCESSING";
      delete api.schemaStatusDetails;
      api.updatedAt = this.clock.now();
      api.revision++;
      this.state.revision++;
      await this.store.save();
    });
    return "PROCESSING";
  }

  private async completeSchemaCreation(apiId: string): Promise<void> {
    await this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId);
      const pending = api.pendingSchema;
      if (!pending || pending.status !== "PROCESSING") return;
      let schema: GraphQLSchema | undefined;
      let details: string | undefined;
      try {
        schema = this.validateSchemaDefinition(api, pending.definition);
      } catch (error) {
        details = (error instanceof Error ? error.message : "The schema is invalid.").slice(0, 1024);
      }
      const now = this.clock.now();
      if (schema) {
        api.schema = {
          generation: pending.generation,
          digest: pending.digest,
          definition: pending.definition,
          status: "SUCCESS",
          activatedAt: now,
        };
        delete api.pendingSchema;
        api.schemaStatus = "SUCCESS";
        delete api.schemaStatusDetails;
        this.schemas.set(apiId, { definition: pending.definition, schema });
      } else {
        pending.status = "FAILED";
        pending.completedAt = now;
        pending.details = details;
        api.schemaStatus = "FAILED";
        api.schemaStatusDetails = details;
      }
      api.updatedAt = now;
      api.revision++;
      this.state.revision++;
      await this.store.save();
      if (schema) this.closeRealtimeApi(apiId, "AppSync schema changed");
    });
  }

  private async schemaCreationStatus(apiId: string): Promise<Record<string, unknown>> {
    await this.completeSchemaCreation(apiId);
    const api = this.requireApi(apiId);
    return {
      status: api.schemaStatus,
      ...(api.schemaStatusDetails ? { details: api.schemaStatusDetails } : {}),
    };
  }

  private compiledSchema(api: AppSyncGraphqlApiState): GraphQLSchema {
    if (!api.schema) throw new AwsError("BadRequestException", "The GraphQL API has no active schema.", 400);
    const cached = this.schemas.get(api.apiId);
    if (cached?.definition === api.schema.definition) return cached.schema;
    const schema = this.validateSchemaDefinition(api, api.schema.definition);
    this.schemas.set(api.apiId, { definition: api.schema.definition, schema });
    return schema;
  }

  private async introspectionSchema(apiId: string, format: string | null): Promise<Buffer> {
    const api = this.requireApi(apiId);
    if (!api.schema) throw new AwsError("NotFoundException", "The GraphQL API has no active schema.", 404);
    if (format !== "SDL" && format !== "JSON") {
      throw new AwsError("BadRequestException", "format must be SDL or JSON.", 400);
    }
    const schema = this.compiledSchema(api);
    if (format === "SDL") return Buffer.from(printSchema(schema), "utf8");
    const result = await graphql({ schema, source: getIntrospectionQuery() });
    return Buffer.from(JSON.stringify(result.data ?? {}), "utf8");
  }

  private keyBinding(api: AppSyncGraphqlApiState, key: Pick<AppSyncApiKeyState, "keyId">): MaterialBinding {
    return {
      service: "appsync",
      accountId: this.store.accountId,
      region: this.region,
      resourceArn: api.arn,
      generationId: key.keyId,
      valueKind: "ApiKey",
      version: 1,
    };
  }

  private keyExpiry(value: unknown, nowSeconds: number, fallback?: number): number {
    const requested = value === undefined ? fallback ?? nowSeconds + 7 * 24 * 60 * 60 : Number(value);
    if (!Number.isFinite(requested) || requested <= nowSeconds || requested > nowSeconds + 365 * 24 * 60 * 60) {
      throw new AwsError("BadRequestException", "expires must be between now and 365 days from now.", 400);
    }
    const expires = Math.floor(requested / 3600) * 3600;
    if (expires <= nowSeconds) {
      throw new AwsError("BadRequestException", "expires must remain in the future after AppSync hour rounding.", 400);
    }
    return expires;
  }

  private keyDescription(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > 255) {
      throw new AwsError("BadRequestException", "description must be a string no longer than 255 characters.", 400);
    }
    return value;
  }

  private async createApiKey(apiId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    rejectUnknown(input, ["description", "expires"]);
    const description = this.keyDescription(input.description);
    const nowSeconds = Math.floor(this.clock.now() / 1000);
    const expires = this.keyExpiry(input.expires, nowSeconds);
    const deletes = expires + 60 * 24 * 60 * 60;

    return this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId);
      if (Object.keys(api.apiKeys).length >= API_KEY_LIMIT) {
        throw new AwsError("ApiKeyLimitExceededException", "The API key limit was exceeded.", 400);
      }
      const keyId = randomBytes(12).toString("hex");
      const plaintext = Buffer.from(`da2-${randomBytes(24).toString("base64url")}`, "utf8");
      const published = await this.materials.publish(this.keyBinding(api, { keyId }), plaintext);
      const now = this.clock.now();
      const key: AppSyncApiKeyState = {
        keyId,
        materialId: published.materialId,
        ...(description === undefined ? {} : { description }),
        expires,
        deletes,
        createdAt: now,
        updatedAt: now,
      };
      const previousApiUpdatedAt = api.updatedAt;
      const previousApiRevision = api.revision;
      const previousStateRevision = this.state.revision;
      try {
        api.apiKeys[keyId] = key;
        api.updatedAt = now;
        api.revision++;
        this.state.revision++;
        await this.store.save();
        await this.materials.commit(published.materialId).catch(() => undefined);
        return {
          id: plaintext.toString("utf8"),
          ...(description === undefined ? {} : { description }),
          expires,
          deletes,
        };
      } catch (error) {
        delete api.apiKeys[keyId];
        api.updatedAt = previousApiUpdatedAt;
        api.revision = previousApiRevision;
        this.state.revision = previousStateRevision;
        await this.materials.abort(published.materialId).catch(() => undefined);
        throw error;
      } finally {
        plaintext.fill(0);
      }
    });
  }

  private async publicKey(api: AppSyncGraphqlApiState, key: AppSyncApiKeyState): Promise<Record<string, unknown>> {
    const plaintext = await this.materials.read(this.keyBinding(api, key), key.materialId);
    try {
      return {
        id: plaintext.toString("utf8"),
        ...(key.description === undefined ? {} : { description: key.description }),
        expires: key.expires,
        deletes: key.deletes,
      };
    } finally {
      plaintext.fill(0);
    }
  }

  private async findKey(api: AppSyncGraphqlApiState, id: string): Promise<AppSyncApiKeyState | undefined> {
    const supplied = Buffer.from(id, "utf8");
    try {
      for (const key of Object.values(api.apiKeys)) {
        const expected = await this.materials.read(this.keyBinding(api, key), key.materialId);
        try {
          if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return key;
        } finally {
          expected.fill(0);
        }
      }
      return undefined;
    } finally {
      supplied.fill(0);
    }
  }

  private async updateApiKey(apiId: string, id: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    rejectUnknown(input, ["description", "expires"]);
    const suppliedDescription = this.keyDescription(input.description);
    return this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId);
      const key = await this.findKey(api, id);
      const nowSeconds = Math.floor(this.clock.now() / 1000);
      if (!key || key.deletes <= nowSeconds) throw new AwsError("NotFoundException", "The API key was not found.", 404);
      if (input.description !== undefined) key.description = suppliedDescription;
      if (input.expires !== undefined) {
        key.expires = this.keyExpiry(input.expires, nowSeconds);
        key.deletes = key.expires + 60 * 24 * 60 * 60;
      }
      key.updatedAt = this.clock.now();
      api.updatedAt = key.updatedAt;
      api.revision++;
      this.state.revision++;
      await this.store.save();
      this.closeRealtimeApiKey(apiId, key.keyId, "AppSync API key changed");
      return this.publicKey(api, key);
    });
  }

  private async deleteApiKey(apiId: string, id: string): Promise<void> {
    const materialId = await this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId);
      const key = await this.findKey(api, id);
      if (!key) throw new AwsError("NotFoundException", "The API key was not found.", 404);
      delete api.apiKeys[key.keyId];
      api.updatedAt = this.clock.now();
      api.revision++;
      this.state.revision++;
      await this.store.save();
      this.closeRealtimeApiKey(apiId, key.keyId, "AppSync API key deleted");
      return key.materialId;
    });
    await this.materials.remove(materialId);
  }

  private async listApiKeys(apiId: string, url: URL): Promise<Record<string, unknown>> {
    const api = this.requireApi(apiId);
    const limit = maxResults(url);
    const nextToken = url.searchParams.get("nextToken");
    let offset = 0;
    if (nextToken !== null) {
      try {
        const cursor = this.tokens.decode<{ offset: number; revision: number; region: string; apiId: string }>(
          "AppSync.ListApiKeys",
          nextToken,
        );
        if (!Number.isInteger(cursor.offset) || cursor.offset < 0
          || cursor.revision !== api.revision || cursor.region !== this.region || cursor.apiId !== apiId) throw new Error();
        offset = cursor.offset;
      } catch {
        throw new AwsError("BadRequestException", "nextToken is invalid.", 400);
      }
    }
    const all = Object.values(api.apiKeys)
      .filter(key => key.deletes > Math.floor(this.clock.now() / 1000))
      .sort((left, right) => left.createdAt - right.createdAt || left.keyId.localeCompare(right.keyId));
    const keys = all.slice(offset, offset + limit);
    const nextOffset = offset + keys.length;
    return {
      apiKeys: await Promise.all(keys.map(key => this.publicKey(api, key))),
      ...(nextOffset < all.length
        ? { nextToken: this.tokens.encode("AppSync.ListApiKeys", {
          offset: nextOffset,
          revision: api.revision,
          region: this.region,
          apiId,
        }) }
        : {}),
    };
  }

  private async validApiKey(api: AppSyncGraphqlApiState, supplied: string): Promise<boolean> {
    const suppliedBytes = Buffer.from(supplied, "utf8");
    const nowSeconds = Math.floor(this.clock.now() / 1000);
    try {
      for (const key of Object.values(api.apiKeys)) {
        if (key.expires <= nowSeconds || key.deletes <= nowSeconds) continue;
        const expected = await this.materials.read(this.keyBinding(api, key), key.materialId);
        try {
          if (expected.length === suppliedBytes.length && timingSafeEqual(expected, suppliedBytes)) return true;
        } finally {
          expected.fill(0);
        }
      }
      return false;
    } finally {
      suppliedBytes.fill(0);
    }
  }

  private publicDataSource(dataSource: AppSyncDataSourceState): Record<string, unknown> {
    return {
      dataSourceArn: dataSource.arn,
      name: dataSource.name,
      ...(dataSource.description === undefined ? {} : { description: dataSource.description }),
      type: dataSource.type,
      ...(dataSource.serviceRoleArn ? { serviceRoleArn: dataSource.serviceRoleArn } : {}),
      ...(dataSource.dynamodbConfig ? { dynamodbConfig: structuredClone(dataSource.dynamodbConfig) } : {}),
    };
  }

  private async dataSourceInput(input: Record<string, unknown>, update = false): Promise<{
    name?: string;
    description?: string;
    type: "NONE" | "AMAZON_DYNAMODB";
    serviceRoleArn?: string;
    dynamodbConfig?: { tableName: string; awsRegion: string };
  }> {
    rejectUnknown(input, [
      ...(update ? [] : ["name"]),
      "description", "type", "serviceRoleArn", "dynamodbConfig", "lambdaConfig",
      "elasticsearchConfig", "openSearchServiceConfig", "httpConfig",
      "relationalDatabaseConfig", "eventBridgeConfig", "metricsConfig",
    ]);
    const name = update ? undefined : requireGraphqlName(input.name, "name");
    if (input.type !== "NONE" && input.type !== "AMAZON_DYNAMODB") {
      throw new AwsError("BadRequestException", "Only NONE and AMAZON_DYNAMODB data sources are implemented.", 400);
    }
    for (const field of [
      "lambdaConfig", "elasticsearchConfig",
      "openSearchServiceConfig", "httpConfig", "relationalDatabaseConfig",
      "eventBridgeConfig", "metricsConfig",
    ]) {
      if (input[field] !== undefined) {
        throw new AwsError("BadRequestException", `${field} is outside the APS-P0-010 data-source boundary.`, 400);
      }
    }
    const description = input.description === undefined ? undefined : this.keyDescription(input.description);
    if (input.type === "NONE") {
      if (input.serviceRoleArn !== undefined || input.dynamodbConfig !== undefined) {
        throw new AwsError("BadRequestException", "NONE data sources do not accept a service role or DynamoDB configuration.", 400);
      }
      return { ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }), type: "NONE" };
    }
    const serviceRoleArn = requireString(input.serviceRoleArn, "serviceRoleArn", 2048);
    const roleMatch = serviceRoleArn.match(/^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9+=,.@_\/-]+$/);
    if (!roleMatch || roleMatch[1] !== this.store.accountId) {
      throw new AwsError("BadRequestException", "serviceRoleArn must identify a role in the simulator account.", 400);
    }
    const role = Object.values(this.store.ensureAccount().iam.roles).find(candidate => candidate.arn === serviceRoleArn);
    if (!role || evaluateTrust(
      role.assumeRolePolicyDocument,
      "appsync.amazonaws.com",
      "sts:AssumeRole",
      { "aws:PrincipalServiceName": "appsync.amazonaws.com" },
    ).decision !== "allowed") {
      throw new AwsError("BadRequestException", "AppSync cannot assume the configured data source role.", 400);
    }
    if (!validObject(input.dynamodbConfig)) {
      throw new AwsError("BadRequestException", "dynamodbConfig is required for AMAZON_DYNAMODB.", 400);
    }
    rejectUnknown(input.dynamodbConfig, [
      "tableName", "awsRegion", "useCallerCredentials", "versioned", "deltaSyncConfig",
    ]);
    const tableName = requireString(input.dynamodbConfig.tableName, "dynamodbConfig.tableName", 255);
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)) {
      throw new AwsError("BadRequestException", "dynamodbConfig.tableName is invalid.", 400);
    }
    const awsRegion = requireString(input.dynamodbConfig.awsRegion, "dynamodbConfig.awsRegion", 64);
    if (awsRegion !== this.region) {
      throw new AwsError("BadRequestException", "The DynamoDB data source must use the GraphQL API Region.", 400);
    }
    if (input.dynamodbConfig.useCallerCredentials !== undefined
      && input.dynamodbConfig.useCallerCredentials !== false) {
      throw new AwsError("BadRequestException", "DynamoDB caller credentials are outside the P0 data-source boundary.", 400);
    }
    if (input.dynamodbConfig.versioned !== undefined && input.dynamodbConfig.versioned !== false) {
      throw new AwsError("BadRequestException", "Versioned DynamoDB data sources are outside the P0 boundary.", 400);
    }
    if (input.dynamodbConfig.deltaSyncConfig !== undefined) {
      throw new AwsError("BadRequestException", "Delta Sync is outside the P0 boundary.", 400);
    }
    try {
      if (!this.dynamodb) throw new Error();
      await this.dynamodb.DescribeTable({ TableName: tableName });
    } catch {
      throw new AwsError("BadRequestException", "The configured DynamoDB table was not found.", 400);
    }
    return {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      type: "AMAZON_DYNAMODB",
      serviceRoleArn,
      dynamodbConfig: { tableName, awsRegion },
    };
  }

  private requireDataSource(api: AppSyncGraphqlApiState, name: string): AppSyncDataSourceState {
    const dataSource = api.dataSources[name];
    if (!dataSource) throw new AwsError("NotFoundException", "The data source was not found.", 404);
    return dataSource;
  }

  private async createDataSource(apiId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const candidate = await this.dataSourceInput(input);
    return this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId);
      if (api.dataSources[candidate.name!]) throw new AwsError("BadRequestException", "A data source with that name already exists.", 400);
      if (Object.keys(api.dataSources).length >= DATA_SOURCE_LIMIT) throw new AwsError("LimitExceededException", "The data source limit was exceeded.", 400);
      const now = this.clock.now();
      const dataSource: AppSyncDataSourceState = {
        name: candidate.name!,
        arn: `${api.arn}/datasources/${candidate.name}`,
        ...(candidate.description === undefined ? {} : { description: candidate.description }),
        type: candidate.type,
        ...(candidate.serviceRoleArn ? { serviceRoleArn: candidate.serviceRoleArn } : {}),
        ...(candidate.dynamodbConfig ? { dynamodbConfig: candidate.dynamodbConfig } : {}),
        generation: randomUUID(),
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      api.dataSources[dataSource.name] = dataSource;
      api.updatedAt = now;
      api.revision++;
      this.state.revision++;
      await this.store.save();
      this.closeRealtimeApi(apiId);
      return this.publicDataSource(dataSource);
    });
  }

  private async updateDataSource(apiId: string, name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    requireGraphqlName(name, "name");
    const candidate = await this.dataSourceInput(input, true);
    return this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId);
      const dataSource = this.requireDataSource(api, name);
      if (input.description === undefined) delete dataSource.description;
      else dataSource.description = candidate.description;
      dataSource.type = candidate.type;
      if (candidate.serviceRoleArn) dataSource.serviceRoleArn = candidate.serviceRoleArn;
      else delete dataSource.serviceRoleArn;
      if (candidate.dynamodbConfig) dataSource.dynamodbConfig = candidate.dynamodbConfig;
      else delete dataSource.dynamodbConfig;
      dataSource.updatedAt = this.clock.now();
      dataSource.revision++;
      api.updatedAt = dataSource.updatedAt;
      api.revision++;
      this.state.revision++;
      await this.store.save();
      this.closeRealtimeApi(apiId);
      return this.publicDataSource(dataSource);
    });
  }

  private async deleteDataSource(apiId: string, name: string): Promise<void> {
    requireGraphqlName(name, "name");
    await this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId);
      this.requireDataSource(api, name);
      if (Object.values(api.resolvers).some(resolver => resolver.dataSourceName === name)) {
        throw new AwsError("BadRequestException", "The data source is referenced by a resolver.", 400);
      }
      if (Object.values(api.functions ?? {}).some(value => value.dataSourceName === name)) {
        throw new AwsError("BadRequestException", "The data source is referenced by a function.", 400);
      }
      delete api.dataSources[name];
      api.updatedAt = this.clock.now();
      api.revision++;
      this.state.revision++;
      await this.store.save();
      this.closeRealtimeApi(apiId);
    });
  }

  private listDataSources(apiId: string, url: URL): Record<string, unknown> {
    const api = this.requireApi(apiId);
    const limit = maxResults(url);
    const { offset, token } = this.listCursor(url, "AppSync.ListDataSources", api, apiId);
    const all = Object.values(api.dataSources).sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name));
    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      dataSources: page.map(dataSource => this.publicDataSource(dataSource)),
      ...(nextOffset < all.length ? { nextToken: token(nextOffset) } : {}),
    };
  }

  private resolverKey(typeName: string, fieldName: string): string {
    return `${typeName}.${fieldName}`;
  }

  private async executePipelineResolver(
    api: AppSyncGraphqlApiState,
    resolver: AppSyncResolverState,
    context: Omit<import("./appsync/vtl.js").AppSyncVtlContext, "result" | "error" | "prev">,
  ): Promise<import("./appsync/vtl.js").AppSyncVtlEvaluation> {
    const now = this.clock.now();
    const before = evaluateAppSyncVtl(resolver.requestMappingTemplate, { ...context, prev: { result: null } }, now);
    let previous = before.value;
    const errors = [...before.appendedErrors];
    const logs = [...before.logs];
    let subscriptionFilter = before.subscriptionFilter;
    for (const functionId of before.returned ? [] : resolver.pipelineConfig?.functions ?? []) {
      const fn = this.requireFunction(api, functionId);
      const dataSource = api.dataSources[fn.dataSourceName];
      if (!dataSource) throw new AppSyncVtlError("The function data source is missing or stale.", "DataSourceNotFound");
      const stageContext = { ...context, prev: { result: structuredClone(previous) } };
      let evaluation;
      if (dataSource.type === "NONE") {
        evaluation = executeNoneResolver(fn.requestMappingTemplate, fn.responseMappingTemplate, stageContext, now);
      } else if (this.dynamodb && this.assumeServiceRole && dataSource.serviceRoleArn && dataSource.dynamodbConfig) {
        evaluation = await executeDynamoResolver(
          { store: this.store, region: this.region, clock: this.clock, dynamodb: this.dynamodb, assumeServiceRole: this.assumeServiceRole },
          api,
          { ...resolver, generation: fn.generation, revision: fn.revision, requestMappingTemplate: fn.requestMappingTemplate, responseMappingTemplate: fn.responseMappingTemplate },
          dataSource as AppSyncDataSourceState & { type: "AMAZON_DYNAMODB"; serviceRoleArn: string; dynamodbConfig: { tableName: string; awsRegion: string } },
          stageContext,
        );
      } else throw new AppSyncVtlError("The function data source is missing or stale.", "DataSourceNotFound");
      previous = evaluation.value;
      if (evaluation.subscriptionFilter !== undefined) subscriptionFilter = evaluation.subscriptionFilter;
      errors.push(...evaluation.appendedErrors);
      logs.push(...evaluation.logs);
    }
    const after = evaluateAppSyncVtl(resolver.responseMappingTemplate, {
      ...context, prev: { result: structuredClone(previous) }, result: structuredClone(previous), error: null,
    }, now);
    if (after.subscriptionFilter !== undefined) subscriptionFilter = after.subscriptionFilter;
    return {
      ...after, appendedErrors: [...errors, ...after.appendedErrors], logs: [...logs, ...after.logs],
      ...(subscriptionFilter === undefined ? {} : { subscriptionFilter }),
    };
  }

  private functionInput(
    input: Record<string, unknown>,
    current?: AppSyncFunctionState,
  ): Pick<AppSyncFunctionState, "name" | "description" | "dataSourceName" | "requestMappingTemplate" | "responseMappingTemplate" | "requestMappingTemplateDigest" | "responseMappingTemplateDigest" | "functionVersion" | "runtime"> {
    rejectUnknown(input, ["name", "description", "dataSourceName", "requestMappingTemplate", "responseMappingTemplate", "functionVersion"]);
    const name = input.name === undefined ? current?.name : requireGraphqlName(input.name, "name");
    const dataSourceName = input.dataSourceName === undefined ? current?.dataSourceName : requireGraphqlName(input.dataSourceName, "dataSourceName");
    const requestMappingTemplate = input.requestMappingTemplate === undefined
      ? current?.requestMappingTemplate : requireString(input.requestMappingTemplate, "requestMappingTemplate", 64 * 1024);
    const responseMappingTemplate = input.responseMappingTemplate === undefined
      ? current?.responseMappingTemplate : requireString(input.responseMappingTemplate, "responseMappingTemplate", 64 * 1024);
    const functionVersion = input.functionVersion === undefined ? current?.functionVersion : input.functionVersion;
    if (!name || !dataSourceName || !requestMappingTemplate || !responseMappingTemplate) {
      throw new AwsError("BadRequestException", "name, dataSourceName, requestMappingTemplate, and responseMappingTemplate are required.", 400);
    }
    if (functionVersion !== "2018-05-29") throw new AwsError("BadRequestException", "functionVersion must be 2018-05-29 for a VTL function.", 400);
    let description = current?.description;
    if (input.description !== undefined) description = requireString(input.description, "description", 256);
    try { validateAppSyncVtl(requestMappingTemplate); validateAppSyncVtl(responseMappingTemplate); }
    catch (error) { throw new AwsError("BadRequestException", error instanceof Error ? error.message : "The function mapping templates are invalid.", 400); }
    return {
      name, ...(description === undefined ? {} : { description }), dataSourceName,
      requestMappingTemplate, responseMappingTemplate,
      requestMappingTemplateDigest: createHash("sha256").update(requestMappingTemplate).digest("hex"),
      responseMappingTemplateDigest: createHash("sha256").update(responseMappingTemplate).digest("hex"),
      functionVersion: "2018-05-29", runtime: "VTL",
    };
  }

  private publicFunction(value: AppSyncFunctionState): Record<string, unknown> {
    return {
      functionId: value.functionId, functionArn: value.functionArn, name: value.name,
      ...(value.description === undefined ? {} : { description: value.description }),
      dataSourceName: value.dataSourceName, requestMappingTemplate: value.requestMappingTemplate,
      responseMappingTemplate: value.responseMappingTemplate, functionVersion: value.functionVersion,
    };
  }

  private requireFunction(api: AppSyncGraphqlApiState, functionId: string): AppSyncFunctionState {
    const value = (api.functions ?? {})[functionId];
    if (!value) throw new AwsError("NotFoundException", "The function configuration was not found.", 404);
    return value;
  }

  private async createFunction(apiId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const candidate = this.functionInput(input);
    return this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId); api.functions ??= {};
      const dataSource = this.requireDataSource(api, candidate.dataSourceName);
      this.validateResolverDataSource(dataSource, candidate.requestMappingTemplate, candidate.responseMappingTemplate);
      if (Object.keys(api.functions).length >= FUNCTION_LIMIT) throw new AwsError("LimitExceededException", "The function limit was exceeded.", 400);
      const functionId = randomBytes(13).toString("hex");
      const now = this.clock.now();
      const value: AppSyncFunctionState = {
        functionId, functionArn: `${api.arn}/functions/${functionId}`, generation: randomUUID(),
        ...candidate, createdAt: now, updatedAt: now, revision: 1,
      };
      api.functions[functionId] = value; api.updatedAt = now; api.revision++; this.state.revision++;
      await this.store.save(); this.closeRealtimeApi(apiId); return this.publicFunction(value);
    });
  }

  private async updateFunction(apiId: string, functionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId); const value = this.requireFunction(api, functionId);
      const candidate = this.functionInput(input, value); const dataSource = this.requireDataSource(api, candidate.dataSourceName);
      this.validateResolverDataSource(dataSource, candidate.requestMappingTemplate, candidate.responseMappingTemplate);
      Object.assign(value, candidate); value.updatedAt = this.clock.now(); value.revision++;
      api.updatedAt = value.updatedAt; api.revision++; this.state.revision++; await this.store.save(); this.closeRealtimeApi(apiId);
      return this.publicFunction(value);
    });
  }

  private async deleteFunction(apiId: string, functionId: string): Promise<void> {
    await this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId); this.requireFunction(api, functionId);
      if (Object.values(api.resolvers).some(resolver => resolver.pipelineConfig?.functions.includes(functionId))) {
        throw new AwsError("ConcurrentModificationException", "The function is referenced by a pipeline resolver.", 409);
      }
      delete api.functions[functionId]; api.updatedAt = this.clock.now(); api.revision++; this.state.revision++; await this.store.save(); this.closeRealtimeApi(apiId);
    });
  }

  private listFunctions(apiId: string, url: URL): Record<string, unknown> {
    const api = this.requireApi(apiId); const limit = maxResults(url);
    const { offset, token } = this.listCursor(url, "AppSync.ListFunctions", api, apiId);
    const all = Object.values(api.functions ?? {}).sort((a, b) => a.createdAt - b.createdAt || a.functionId.localeCompare(b.functionId));
    const page = all.slice(offset, offset + limit); const next = offset + page.length;
    return { functions: page.map(value => this.publicFunction(value)), ...(next < all.length ? { nextToken: token(next) } : {}) };
  }

  private listResolversByFunction(apiId: string, functionId: string, url: URL): Record<string, unknown> {
    const api = this.requireApi(apiId); this.requireFunction(api, functionId); const limit = maxResults(url);
    const { offset, token } = this.listCursor(url, `AppSync.ListResolversByFunction:${functionId}`, api, apiId);
    const all = Object.values(api.resolvers).filter(value => value.pipelineConfig?.functions.includes(functionId))
      .sort((a, b) => a.createdAt - b.createdAt || a.arn.localeCompare(b.arn));
    const page = all.slice(offset, offset + limit); const next = offset + page.length;
    return { resolvers: page.map(value => this.publicResolver(value)), ...(next < all.length ? { nextToken: token(next) } : {}) };
  }

  private requireSchemaField(api: AppSyncGraphqlApiState, typeName: string, fieldName: string): void {
    if (!api.schema) throw new AwsError("BadRequestException", "An active schema is required before configuring a resolver.", 400);
    const schema = this.compiledSchema(api);
    const type = schema.getType(typeName);
    if (!type || !isObjectType(type) || !type.getFields()[fieldName]) {
      throw new AwsError("BadRequestException", `The schema field ${typeName}.${fieldName} does not exist.`, 400);
    }
  }

  private resolverInput(
    input: Record<string, unknown>,
    current?: AppSyncResolverState,
  ): Pick<AppSyncResolverState, "dataSourceName" | "pipelineConfig" | "requestMappingTemplate" | "responseMappingTemplate" | "requestMappingTemplateDigest" | "responseMappingTemplateDigest" | "kind" | "runtime"> {
    rejectUnknown(input, [
      ...(current ? [] : ["fieldName"]),
      "dataSourceName", "requestMappingTemplate", "responseMappingTemplate", "kind",
      "pipelineConfig", "syncConfig", "cachingConfig", "maxBatchSize", "runtime", "code",
      "metricsConfig",
    ]);
    for (const field of ["syncConfig", "cachingConfig", "maxBatchSize", "runtime", "code", "metricsConfig"]) {
      if (input[field] !== undefined) throw new AwsError("BadRequestException", `${field} is outside the APS-P0-006 VTL UNIT resolver boundary.`, 400);
    }
    const kind = input.kind === undefined ? current?.kind ?? "UNIT" : input.kind;
    if (kind !== "UNIT" && kind !== "PIPELINE") throw new AwsError("BadRequestException", "kind must be UNIT or PIPELINE.", 400);
    const dataSourceName = input.dataSourceName === undefined
      ? current?.dataSourceName
      : requireGraphqlName(input.dataSourceName, "dataSourceName");
    let pipelineConfig = current?.pipelineConfig;
    if (input.pipelineConfig !== undefined) {
      if (!validObject(input.pipelineConfig) || Object.keys(input.pipelineConfig).some(key => key !== "functions")
        || !Array.isArray(input.pipelineConfig.functions) || input.pipelineConfig.functions.length < 1
        || input.pipelineConfig.functions.length > 10 || input.pipelineConfig.functions.some(value => typeof value !== "string" || !value)) {
        throw new AwsError("BadRequestException", "pipelineConfig.functions must contain from 1 through 10 function IDs.", 400);
      }
      pipelineConfig = { functions: [...input.pipelineConfig.functions] as string[] };
    }
    if (kind === "UNIT" && !dataSourceName) throw new AwsError("BadRequestException", "dataSourceName is required for a UNIT resolver.", 400);
    if (kind === "UNIT" && pipelineConfig) throw new AwsError("BadRequestException", "pipelineConfig is not valid for a UNIT resolver.", 400);
    if (kind === "PIPELINE" && dataSourceName) throw new AwsError("BadRequestException", "dataSourceName is not valid for a PIPELINE resolver.", 400);
    if (kind === "PIPELINE" && !pipelineConfig) throw new AwsError("BadRequestException", "pipelineConfig is required for a PIPELINE resolver.", 400);
    const requestMappingTemplate = input.requestMappingTemplate === undefined
      ? current?.requestMappingTemplate
      : requireString(input.requestMappingTemplate, "requestMappingTemplate", 64 * 1024);
    const responseMappingTemplate = input.responseMappingTemplate === undefined
      ? current?.responseMappingTemplate
      : requireString(input.responseMappingTemplate, "responseMappingTemplate", 64 * 1024);
    if (!requestMappingTemplate || !responseMappingTemplate) {
      throw new AwsError("BadRequestException", "Both request and response mapping templates are required.", 400);
    }
    try {
      validateAppSyncVtl(requestMappingTemplate);
      validateAppSyncVtl(responseMappingTemplate);
    } catch (error) {
      throw new AwsError(
        "BadRequestException",
        error instanceof Error ? error.message : "The resolver mapping templates are invalid.",
        400,
      );
    }
    return {
      ...(dataSourceName === undefined ? {} : { dataSourceName }),
      ...(pipelineConfig === undefined ? {} : { pipelineConfig }),
      requestMappingTemplate,
      responseMappingTemplate,
      requestMappingTemplateDigest: createHash("sha256").update(requestMappingTemplate).digest("hex"),
      responseMappingTemplateDigest: createHash("sha256").update(responseMappingTemplate).digest("hex"),
      kind,
      runtime: "VTL",
    };
  }

  private publicResolver(resolver: AppSyncResolverState): Record<string, unknown> {
    return {
      typeName: resolver.typeName,
      fieldName: resolver.fieldName,
      ...(resolver.dataSourceName === undefined ? {} : { dataSourceName: resolver.dataSourceName }),
      resolverArn: resolver.arn,
      requestMappingTemplate: resolver.requestMappingTemplate,
      responseMappingTemplate: resolver.responseMappingTemplate,
      kind: resolver.kind,
      ...(resolver.pipelineConfig === undefined ? {} : { pipelineConfig: structuredClone(resolver.pipelineConfig) }),
    };
  }

  private requireResolver(api: AppSyncGraphqlApiState, typeName: string, fieldName: string): AppSyncResolverState {
    const resolver = api.resolvers[this.resolverKey(typeName, fieldName)];
    if (!resolver) throw new AwsError("NotFoundException", "The resolver was not found.", 404);
    return resolver;
  }

  private validateResolverDataSource(
    dataSource: AppSyncDataSourceState,
    requestMappingTemplate: string,
    responseMappingTemplate: string,
  ): void {
    try {
      if (dataSource.type === "NONE") {
        validateNoneResolverTemplates(requestMappingTemplate, responseMappingTemplate);
      } else {
        validateDynamoResolverTemplates(requestMappingTemplate, responseMappingTemplate);
      }
    } catch (error) {
      if (error instanceof AwsError) throw error;
      throw new AwsError(
        "BadRequestException",
        error instanceof Error ? error.message : "The resolver mapping templates are invalid.",
        400,
      );
    }
  }

  private async createResolver(apiId: string, typeNameValue: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const typeName = requireGraphqlName(typeNameValue, "typeName");
    const fieldName = requireGraphqlName(input.fieldName, "fieldName");
    const candidate = this.resolverInput(input);
    return this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId);
      this.requireSchemaField(api, typeName, fieldName);
      if (candidate.kind === "UNIT") {
        const dataSource = this.requireDataSource(api, candidate.dataSourceName!);
        this.validateResolverDataSource(dataSource, candidate.requestMappingTemplate, candidate.responseMappingTemplate);
      } else {
        for (const functionId of candidate.pipelineConfig!.functions) this.requireFunction(api, functionId);
      }
      const key = this.resolverKey(typeName, fieldName);
      if (api.resolvers[key]) throw new AwsError("BadRequestException", "A resolver already exists for that field.", 400);
      if (Object.keys(api.resolvers).length >= RESOLVER_LIMIT) throw new AwsError("LimitExceededException", "The resolver limit was exceeded.", 400);
      const now = this.clock.now();
      const resolver: AppSyncResolverState = {
        typeName,
        fieldName,
        arn: `${api.arn}/types/${typeName}/resolvers/${fieldName}`,
        generation: randomUUID(),
        ...candidate,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      api.resolvers[key] = resolver;
      api.updatedAt = now;
      api.revision++;
      this.state.revision++;
      await this.store.save();
      this.closeRealtimeApi(apiId);
      return this.publicResolver(resolver);
    });
  }

  private async updateResolver(
    apiId: string,
    typeNameValue: string,
    fieldNameValue: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const typeName = requireGraphqlName(typeNameValue, "typeName");
    const fieldName = requireGraphqlName(fieldNameValue, "fieldName");
    return this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId);
      this.requireSchemaField(api, typeName, fieldName);
      const resolver = this.requireResolver(api, typeName, fieldName);
      const candidate = this.resolverInput(input, resolver);
      if (candidate.kind === "UNIT") {
        const dataSource = this.requireDataSource(api, candidate.dataSourceName!);
        this.validateResolverDataSource(dataSource, candidate.requestMappingTemplate, candidate.responseMappingTemplate);
      } else {
        for (const functionId of candidate.pipelineConfig!.functions) this.requireFunction(api, functionId);
      }
      Object.assign(resolver, candidate);
      if (candidate.dataSourceName === undefined) delete resolver.dataSourceName;
      if (candidate.pipelineConfig === undefined) delete resolver.pipelineConfig;
      resolver.updatedAt = this.clock.now();
      resolver.revision++;
      api.updatedAt = resolver.updatedAt;
      api.revision++;
      this.state.revision++;
      await this.store.save();
      this.closeRealtimeApi(apiId);
      return this.publicResolver(resolver);
    });
  }

  private async deleteResolver(apiId: string, typeNameValue: string, fieldNameValue: string): Promise<void> {
    const typeName = requireGraphqlName(typeNameValue, "typeName");
    const fieldName = requireGraphqlName(fieldNameValue, "fieldName");
    await this.store.withMutationLock(`appsync:${this.store.accountId}:${this.region}:${apiId}`, async () => {
      const api = this.requireApi(apiId);
      this.requireResolver(api, typeName, fieldName);
      delete api.resolvers[this.resolverKey(typeName, fieldName)];
      api.updatedAt = this.clock.now();
      api.revision++;
      this.state.revision++;
      await this.store.save();
      this.closeRealtimeApi(apiId);
    });
  }

  private listResolvers(apiId: string, typeNameValue: string, url: URL): Record<string, unknown> {
    const typeName = requireGraphqlName(typeNameValue, "typeName");
    const api = this.requireApi(apiId);
    const limit = maxResults(url);
    const { offset, token } = this.listCursor(url, `AppSync.ListResolvers:${typeName}`, api, apiId);
    const all = Object.values(api.resolvers)
      .filter(resolver => resolver.typeName === typeName)
      .sort((left, right) => left.createdAt - right.createdAt || left.fieldName.localeCompare(right.fieldName));
    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      resolvers: page.map(resolver => this.publicResolver(resolver)),
      ...(nextOffset < all.length ? { nextToken: token(nextOffset) } : {}),
    };
  }

  private listCursor(
    url: URL,
    operation: string,
    api: AppSyncGraphqlApiState,
    apiId: string,
  ): { offset: number; token: (offset: number) => string } {
    const nextToken = url.searchParams.get("nextToken");
    let offset = 0;
    if (nextToken !== null) {
      try {
        const cursor = this.tokens.decode<{ offset: number; revision: number; region: string; apiId: string }>(
          operation,
          nextToken,
        );
        if (!Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.revision !== api.revision
          || cursor.region !== this.region || cursor.apiId !== apiId) throw new Error();
        offset = cursor.offset;
      } catch {
        throw new AwsError("BadRequestException", "nextToken is invalid.", 400);
      }
    }
    return {
      offset,
      token: nextOffset => this.tokens.encode(operation, {
        offset: nextOffset,
        revision: api.revision,
        region: this.region,
        apiId,
      }),
    };
  }
}
