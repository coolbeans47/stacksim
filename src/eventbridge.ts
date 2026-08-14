import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import type { Scheduler } from "./core/scheduler.js";
import type { TelemetryBus } from "./core/telemetry.js";
import { AwsError } from "./errors.js";
import type { LambdaService } from "./lambda.js";
import { parseAwsJson, sendAwsJson } from "./protocols/aws-json.js";
import type { StateStore } from "./state.js";
import type {
  EventBridgeEventBusState,
  EventBridgeHttpParametersState,
  EventBridgeRuleState,
  EventBridgeTargetState,
  EventBridgeTargetType,
} from "./types.js";
import { EventPatternValidationError, isEventJsonNumber, matchesEventPattern, parseEventJson, parseEventPattern, stringifyEventJson, type EventPattern } from "./eventbridge/pattern.js";
import { EventBridgeDeliveryStore, type EventBridgeDelivery, type EventBridgeDeliveryDiagnostic } from "./eventbridge/delivery-store.js";
import { EventBridgeArchiveStore, type EventBridgeArchiveMetadata, type EventBridgeReplayMetadata } from "./eventbridge/archive-store.js";
import { nextScheduleOccurrence, parseScheduleExpression } from "./eventbridge/schedule-expression.js";
import { EVENTBRIDGE_EVB01_ACTIONS, EVENTBRIDGE_EVB04_ACTIONS } from "./eventbridge/action-inventory.js";
import { evaluateRoleAuthorization, evaluateTrust, roleSessionAuthorizationContext, type AuthorizationResult } from "./iam/evaluator.js";
import type { SqsService } from "./sqs.js";
import type { CloudWatchLogsService } from "./cloudwatch-logs.js";
import type { ApiGatewayService } from "./apigateway.js";
import type { SnsService } from "./sns.js";
import type { StepFunctionsService } from "./step-functions.js";
import { acceptedIntegrationAttempt, assertMatchingIntegrationAttempt, integrationInputDigest, type ServiceIntegrationAttempt } from "./step-functions/integration-attempt.js";

const ACTIONS = new Set<string>([...EVENTBRIDGE_EVB01_ACTIONS, ...EVENTBRIDGE_EVB04_ACTIONS]);
const MAX_PUT_EVENTS_BYTES = 1024 * 1024;

function deterministicEventId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const MAX_LAMBDA_ASYNC_PAYLOAD_BYTES = 1024 * 1024;
const MAX_TARGET_INPUT_BYTES = 8 * 1024;
const LEASE_MS = 30_000;
const DEFAULT_EVENT_AGE_SECONDS = 24 * 60 * 60;
const DEFAULT_RETRY_ATTEMPTS = 185;
const MAX_EVENT_PATTERN_BYTES = 4 * 1024;
const MAX_DELIVERY_LINEAGE = 32;
const REPLAY_LEASE_MS = 30_000;

type JsonObject = Record<string, unknown>;
type ExtendedEventBridgeTargetState = EventBridgeTargetState;

const NON_RETRYABLE_DELIVERY_CODES = new Set([
  "AccessDeniedException",
  "AccessDenied",
  "BadRequestException",
  "ForbiddenException",
  "InvalidParameterValueException",
  "MalformedPolicyDocumentException",
  "MissingAuthenticationTokenException",
  "NotFoundException",
  "QueueDoesNotExist",
  "ResourceNotFoundException",
  "TargetResponseException",
  "ValidationException",
]);

const PROHIBITED_EVENTBRIDGE_HEADERS = new Set([
  "authorization", "connection", "content-encoding", "content-length", "host", "max-forwards", "te",
  "transfer-encoding", "trailer", "upgrade", "via", "www-authenticate", "x-forwarded-for",
]);

function dependency(feature: string, phase: string): never {
  throw new AwsError("ValidationException", `${feature} requires ${phase}, which is not implemented by this development profile.`);
}

function compiledPattern(value: string): EventPattern {
  try { return parseEventPattern(value); }
  catch (error) { if (error instanceof EventPatternValidationError) throw new AwsError("InvalidEventPatternException", error.message); throw error; }
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value) || isEventJsonNumber(value)) throw new AwsError("ValidationException", `${name} must be an object.`);
  return value as JsonObject;
}

function text(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || [...value].length < minimum || [...value].length > maximum) throw new AwsError("ValidationException", `${name} must be between ${minimum} and ${maximum} characters.`);
  return value;
}

function busName(value: unknown): string {
  const name = text(value, "Name", 1, 256);
  if (!/^[./_A-Za-z0-9-]+$/.test(name)) throw new AwsError("ValidationException", "Event bus names may contain letters, numbers, periods, hyphens, underscores, and slashes.");
  return name;
}

function ruleName(value: unknown): string {
  const name = text(value, "Name", 1, 64);
  if (!/^[._A-Za-z0-9-]+$/.test(name)) throw new AwsError("ValidationException", "Rule names may contain letters, numbers, periods, hyphens, and underscores.");
  return name;
}

function archiveName(value: unknown): string {
  const name = text(value, "ArchiveName", 1, 48);
  if (!/^[._A-Za-z0-9-]+$/.test(name)) throw new AwsError("ValidationException", "Archive names may contain letters, numbers, periods, hyphens, and underscores.");
  return name;
}

function replayName(value: unknown): string {
  const name = text(value, "ReplayName", 1, 64);
  if (!/^[._A-Za-z0-9-]+$/.test(name)) throw new AwsError("ValidationException", "Replay names may contain letters, numbers, periods, hyphens, and underscores.");
  return name;
}

function timestamp(value: unknown, name: string): number {
  const millis = typeof value === "number" ? value * 1_000 : value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(millis)) throw new AwsError("ValidationException", `${name} must be a valid timestamp.`);
  return millis;
}

function validateKmsIdentifier(value: unknown): never {
  const identifier = text(value, "KmsKeyIdentifier", 1, 2048);
  if (!/^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|mrk-[0-9a-fA-F]{32}|alias\/[A-Za-z0-9/_-]+|arn:aws(?:-[a-z]+)*:kms:[a-z0-9-]+:\d{12}:(?:key\/(?:[0-9a-fA-F-]{36}|mrk-[0-9a-fA-F]{32})|alias\/[A-Za-z0-9/_-]+))$/.test(identifier)) throw new AwsError("ValidationException", "KmsKeyIdentifier must be a key ID, key ARN, alias name, or alias ARN.");
  dependency("Customer-managed KMS encryption for EventBridge archives", "a local KMS service");
}

function targetId(value: unknown): string {
  const id = text(value, "Target.Id", 1, 64);
  if (!/^[._A-Za-z0-9-]+$/.test(id)) throw new AwsError("ValidationException", "Target IDs may contain letters, numbers, periods, hyphens, and underscores.");
  return id;
}

function positiveInteger(value: unknown, name: string, minimum: number, maximum: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new AwsError("ValidationException", `${name} must be an integer between ${minimum} and ${maximum}.`);
  return Number(value);
}

function tagList(value: unknown): Array<{ Key: string; Value: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AwsError("ValidationException", "Tags must be an array.");
  if (value.length > 50) throw new AwsError("ValidationException", "A resource can have at most 50 tags.");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const tag = object(raw, `Tags[${index}]`);
    const Key = text(tag.Key, `Tags[${index}].Key`, 1, 128);
    const Value = text(tag.Value ?? "", `Tags[${index}].Value`, 0, 256);
    if (Key.toLowerCase().startsWith("aws:")) throw new AwsError("ValidationException", "Tag keys beginning with aws: are reserved.");
    if (seen.has(Key)) throw new AwsError("ValidationException", `Duplicate tag key ${Key}.`);
    seen.add(Key);
    return { Key, Value };
  });
}

function tagsRecord(value: unknown): Record<string, string> {
  return Object.assign(Object.create(null), Object.fromEntries(tagList(value).map(tag => [tag.Key, tag.Value])));
}

function clone<T>(value: T): T { return structuredClone(value); }

function nullRecord<T>(value: Record<string, T> | undefined): Record<string, T> {
  if (value && Object.getPrototypeOf(value) === null) return value;
  return Object.assign(Object.create(null), value ?? {});
}

function depthAndNumbers(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > 1_000) throw new AwsError("ValidationException", "Detail exceeds the maximum JSON nesting depth of 1000.");
    if (isEventJsonNumber(current.value)) continue;
    if (typeof current.value === "number" && !Number.isFinite(current.value)) throw new AwsError("ValidationException", "Detail numbers must be finite.");
    if (current.value && typeof current.value === "object") for (const item of Object.values(current.value as JsonObject)) pending.push({ value: item, depth: current.depth + 1 });
  }
}

function eventTime(value: unknown, now: number): string {
  if (value === undefined) return new Date(now).toISOString();
  const millis = typeof value === "number" ? value * 1000 : value instanceof Date ? value.getTime() : Date.parse(String(value));
  const date = new Date(millis); if (!Number.isFinite(millis) || !Number.isFinite(date.getTime())) throw new AwsError("ValidationException", "Time must be a valid timestamp.");
  return date.toISOString();
}

function putEventsEntrySize(raw: unknown): number {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return 0;
  const entry = raw as JsonObject;
  let size = entry.Time === undefined ? 0 : 14;
  for (const field of [entry.Source, entry.DetailType, entry.Detail]) if (typeof field === "string") size += Buffer.byteLength(field, "utf8");
  if (Array.isArray(entry.Resources)) for (const resource of entry.Resources) if (typeof resource === "string") size += Buffer.byteLength(resource, "utf8");
  return size;
}

function jsonPathParts(path: string): Array<string | number> {
  if (path === "$") return [];
  if (!path.startsWith("$")) throw new AwsError("ValidationException", `JSONPath ${path} must begin with $.`);
  const parts: Array<string | number> = [];
  let cursor = 1;
  while (cursor < path.length) {
    if (path[cursor] === ".") {
      const match = path.slice(cursor + 1).match(/^(?:\*|[A-Za-z0-9_\/-]+)/);
      if (!match) throw new AwsError("ValidationException", `JSONPath ${path} contains an unsupported field expression.`);
      parts.push(match[0]); cursor += match[0].length + 1; continue;
    }
    const match = path.slice(cursor).match(/^\[(\d+|\*)\]/);
    if (!match) throw new AwsError("ValidationException", `JSONPath ${path} contains an unsupported expression.`);
    parts.push(match[1] === "*" ? "*" : Number(match[1])); cursor += match[0].length;
  }
  return parts;
}

function jsonPath(value: unknown, path: string): unknown {
  const parts = jsonPathParts(path);
  const visit = (current: unknown, index: number): unknown => {
    if (index === parts.length) return current;
    const part = parts[index];
    if (part === "*") {
      const values = Array.isArray(current) ? current : current && typeof current === "object" ? Object.values(current as JsonObject) : [];
      const matches = values.map(item => visit(item, index + 1)).filter(item => item !== undefined);
      return matches.length ? matches : undefined;
    }
    if (typeof part === "number") return Array.isArray(current) && part < current.length ? visit(current[part], index + 1) : undefined;
    return current && typeof current === "object" && Object.hasOwn(current, part) ? visit((current as JsonObject)[part], index + 1) : undefined;
  };
  return visit(value, 0);
}

interface TemplatePlaceholder { start: number; end: number; name: string; inString: boolean }

function templatePlaceholders(template: string): TemplatePlaceholder[] {
  const placeholders: TemplatePlaceholder[] = []; let inString = false; let escaped = false;
  for (let index = 0; index < template.length; index++) {
    const character = template[index];
    if (inString && escaped) { escaped = false; continue; }
    if (inString && character === "\\") { escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (character !== "<") continue;
    const match = template.slice(index).match(/^<([A-Za-z0-9_.-]+)>/); if (!match) continue;
    placeholders.push({ start: index, end: index + match[0].length, name: match[1], inString }); index += match[0].length - 1;
  }
  return placeholders;
}

function validateCloudWatchLogsInputTemplate(template: string): void {
  const invalid = (): never => {
    throw new AwsError("ValidationException", "A CloudWatch Logs target InputTemplate must have exactly the form {\"timestamp\":<timestamp>,\"message\":<message>}.");
  };
  const placeholders = templatePlaceholders(template);
  if (placeholders.length !== 2 || placeholders.some(placeholder => placeholder.inString)) invalid();
  let cursor = 0;
  let rendered = "";
  const sentinels: string[] = [];
  for (let index = 0; index < placeholders.length; index++) {
    const placeholder = placeholders[index];
    const sentinel = `__STACKSIM_EVENTBRIDGE_LOGS_${index}__`;
    sentinels.push(sentinel);
    rendered += template.slice(cursor, placeholder.start) + JSON.stringify(sentinel);
    cursor = placeholder.end;
  }
  rendered += template.slice(cursor);
  let parsed: unknown;
  try { parsed = parseEventJson(rendered); } catch { invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || isEventJsonNumber(parsed)) invalid();
  const record = parsed as JsonObject;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "message" || keys[1] !== "timestamp") invalid();
  if (!sentinels.includes(String(record.timestamp)) || !sentinels.includes(String(record.message)) || record.timestamp === record.message) invalid();
}

function transformTemplate(template: string, paths: Record<string, string>, event: JsonObject, rule: EventBridgeRuleState, ingestionTime = 0): string {
  const values: Record<string, unknown> = Object.create(null);
  for (const [name, path] of Object.entries(paths)) values[name] = jsonPath(event, path);
  values["aws.events.rule-arn"] = rule.arn;
  values["aws.events.rule-name"] = rule.name;
  values["aws.events.event.ingestion-time"] = new Date(ingestionTime).toISOString();
  const eventWithoutDetail = { ...event }; delete eventWithoutDetail.detail;
  values["aws.events.event"] = eventWithoutDetail;
  values["aws.events.event.json"] = event;
  const placeholders = templatePlaceholders(template);
  const trimmed = template.trim();
  if (placeholders.length === 1 && trimmed === `<${placeholders[0].name}>`) {
    const value = values[placeholders[0].name];
    if (!(placeholders[0].name in values)) throw new AwsError("ValidationException", `InputTemplate references undefined variable ${placeholders[0].name}.`);
    return stringifyEventJson(value ?? null);
  }
  const plainText = !/^\s*[\[{\"]/.test(template); const missing = new Set<string>(); let cursor = 0; let rendered = "";
  for (let index = 0; index < placeholders.length; index++) {
    const placeholder = placeholders[index]; rendered += template.slice(cursor, placeholder.start); cursor = placeholder.end;
    if (!(placeholder.name in values)) throw new AwsError("ValidationException", `InputTemplate references undefined variable ${placeholder.name}.`);
    const value = values[placeholder.name];
    if (placeholder.inString && (placeholder.name === "aws.events.event" || placeholder.name === "aws.events.event.json")) throw new AwsError("ValidationException", `${placeholder.name} can only be used as a complete JSON field value.`);
    if (plainText) {
      if (value !== undefined) rendered += typeof value === "string" ? value : value && typeof value === "object" ? stringifyEventJson(value) : String(value);
      continue;
    }
    if (value === undefined) {
      const sentinel = `__STACKSIM_EVENTBRIDGE_MISSING_${index}__`; missing.add(sentinel); rendered += placeholder.inString ? sentinel : JSON.stringify(sentinel); continue;
    }
    if (placeholder.inString) {
      const stringValue = typeof value === "string" ? value : value && typeof value === "object" ? stringifyEventJson(value).replaceAll('"', "") : String(value);
      rendered += JSON.stringify(stringValue).slice(1, -1);
    } else rendered += stringifyEventJson(value);
  }
  rendered += template.slice(cursor);
  if (plainText) return JSON.stringify(rendered);
  const absent = Symbol("missing EventBridge input path");
  const clean = (value: unknown): unknown | typeof absent => {
    if (typeof value === "string") { if (missing.has(value)) return absent; let result = value; for (const sentinel of missing) result = result.replaceAll(sentinel, ""); return result; }
    if (isEventJsonNumber(value)) return value;
    if (Array.isArray(value)) return value.map(clean).filter(item => item !== absent);
    if (value && typeof value === "object") { const result: JsonObject = Object.create(null); for (const [key, item] of Object.entries(value as JsonObject)) { const cleaned = clean(item); if (cleaned !== absent) result[key] = cleaned; } return result; }
    return value;
  };
  try { const parsed = clean(parseEventJson(rendered)); return stringifyEventJson(parsed === absent ? null : parsed); }
  catch { throw new AwsError("ValidationException", "InputTemplate does not produce valid JSON."); }
}

function transformedPayload(target: EventBridgeTargetState, event: JsonObject, rule: EventBridgeRuleState, ingestionTime: number): string {
  if (target.input !== undefined) return target.input;
  if (target.inputPath !== undefined) return stringifyEventJson(jsonPath(event, target.inputPath) ?? null);
  if (target.inputTransformer) return transformTemplate(target.inputTransformer.inputTemplate, target.inputTransformer.inputPathsMap ?? {}, event, rule, ingestionTime);
  return stringifyEventJson(event);
}

function classifyTargetArn(arn: string, region: string, accountId: string): EventBridgeTargetType {
  const lambda = arn.match(/^arn:aws:lambda:([^:]+):(\d{12}):function:[A-Za-z0-9-_]{1,64}(?::[A-Za-z0-9-_.$]+)?$/);
  if (lambda) {
    if (lambda[1] !== region || lambda[2] !== accountId) throw new AwsError("ValidationException", "Lambda targets must be in the same account and Region as the rule.");
    return "lambda";
  }
  const sqs = arn.match(/^arn:aws:sqs:([^:]+):(\d{12}):((?:[A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\.fifo))$/);
  if (sqs) {
    if (sqs[1] !== region) throw new AwsError("ValidationException", "SQS targets must be in the same Region as the rule.");
    return "sqs";
  }
  const sns = arn.match(/^arn:aws:sns:([^:]+):(\d{12}):[A-Za-z0-9_-]{1,256}$/);
  if (sns) {
    if (sns[1] !== region || sns[2] !== accountId) throw new AwsError("ValidationException", "SNS targets must be in the same account and Region as the rule.");
    return "sns";
  }
  const logs = arn.match(/^arn:aws:logs:([^:]+):(\d{12}):log-group:(.+?)(?::\*)?$/);
  if (logs) {
    if (logs[1] !== region || logs[2] !== accountId) throw new AwsError("ValidationException", "CloudWatch Logs targets must be in the same account and Region as the rule.");
    return "logs";
  }
  const api = arn.match(/^arn:aws:execute-api:([^:]+):(\d{12}):[^/]+\/[^/]+\/[A-Za-z]+(?:\/.*)?$/);
  if (api) {
    if (api[1] !== region || api[2] !== accountId) throw new AwsError("ValidationException", "API Gateway targets must be in the same account and Region as the rule.");
    return "apigateway";
  }
  const states = arn.match(/^arn:aws:states:([^:]+):(\d{12}):stateMachine:[A-Za-z0-9-_]{1,80}$/);
  if (states) { if (states[1] !== region || states[2] !== accountId) throw new AwsError("ValidationException", "Step Functions targets must be in the same account and Region as the rule."); return "states"; }
  throw new AwsError("ValidationException", "The target ARN must identify a supported Lambda function, SQS queue, SNS topic, CloudWatch Logs log group, deployed API Gateway method, or Standard state machine.");
}

function sqsArnParts(arn: string): { region: string; accountId: string; queueName: string } | undefined {
  const match = /^arn:aws:sqs:([^:]+):(\d{12}):((?:[A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\.fifo))$/.exec(arn);
  return match ? { region: match[1], accountId: match[2], queueName: match[3] } : undefined;
}

function targetParameter(value: string, event: JsonObject, name: string): string {
  if (value !== "$" && !value.startsWith("$.")) return value;
  const selected = jsonPath(event, value);
  if (selected === undefined) throw new AwsError("ValidationException", `${name} JSONPath ${value} did not match the event.`);
  if (typeof selected === "string") return selected;
  return stringifyEventJson(selected);
}

function resolvedHttpParameters(parameters: EventBridgeHttpParametersState | undefined, event: JsonObject): EventBridgeHttpParametersState | undefined {
  if (!parameters) return undefined;
  const resolveMap = (values: Record<string, string> | undefined, name: string): Record<string, string> | undefined => values
    ? Object.fromEntries(Object.entries(values).map(([key, value]) => [key, targetParameter(value, event, `${name}.${key}`)]))
    : undefined;
  return {
    ...(parameters.pathParameterValues ? { pathParameterValues: parameters.pathParameterValues.map((value, index) => targetParameter(value, event, `HttpParameters.PathParameterValues[${index}]`)) } : {}),
    ...(parameters.queryStringParameters ? { queryStringParameters: resolveMap(parameters.queryStringParameters, "HttpParameters.QueryStringParameters") } : {}),
    ...(parameters.headerParameters ? { headerParameters: resolveMap(parameters.headerParameters, "HttpParameters.HeaderParameters") } : {}),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof AwsError) return error.code;
  const name = error && typeof error === "object" ? (error as any).name : undefined;
  return typeof name === "string" && name.endsWith("Exception") ? name : "InternalFailure";
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function safeDeliveryError(error: unknown): { code: string; message: string } {
  const code = errorCode(error);
  return { code, message: error instanceof AwsError ? error.message.slice(0, 1_024) : `Target handoff failed with ${code}.` };
}

function retryable(error: unknown): boolean {
  const code = errorCode(error);
  if (/throttl|too.?many/i.test(code)) return true;
  if (/timed?\s*out|timeout/i.test(`${code} ${errorMessage(error)}`)) return true;
  if (NON_RETRYABLE_DELIVERY_CODES.has(code) || code === "FailedToAssumeRoleException") return false;
  return !(error instanceof AwsError && error.status >= 400 && error.status < 500 && error.status !== 429);
}

function deadLetterErrorCode(error: unknown): string {
  const code = errorCode(error);
  if (code === "FailedToAssumeRoleException") return "FAILED_TO_ASSUME_ROLE";
  if (code === "TargetResponseException") return "ERROR_FROM_TARGET";
  if (/throttl|too.?many/i.test(code)) return "THROTTLING";
  if (/timed?\s*out|timeout/i.test(`${code} ${errorMessage(error)}`)) return "TIMEOUT";
  if (["AccessDenied", "AccessDeniedException", "ForbiddenException", "UnrecognizedClientException"].includes(code)) return "NO_PERMISSIONS";
  if (["QueueDoesNotExist", "ResourceNotFoundException", "MissingAuthenticationTokenException", "NotFoundException"].includes(code)) return "NO_RESOURCE";
  if (["BadRequestException", "InvalidParameterValueException", "MalformedPolicyDocumentException", "ValidationException"].includes(code)) return "INVALID_PARAMETER";
  return code === "InternalFailure" || code === "InternalError" ? "INTERNAL_ERROR" : "UNKNOWN";
}

export class EventBridgeService {
  private readonly deliveries: EventBridgeDeliveryStore;
  private readonly archiveStore: EventBridgeArchiveStore;
  private startPromise?: Promise<void>;
  private stopped = true;
  private workerRunning = false;
  private workerPromise?: Promise<void>;
  private cancelWorker?: () => void;
  private cancelLegacyScheduleWorker?: () => void;
  private cancelReplayWorker?: () => void;
  private replayWorkerRunning = false;
  private replayWorkerPromise?: Promise<void>;
  private legacyScheduleWorkerRunning = false;
  private legacyScheduleWorkerPromise?: Promise<void>;
  private readonly pendingTelemetry = new Set<Promise<void>>();
  private sqs?: SqsService;
  private sns?: SnsService;
  private logs?: CloudWatchLogsService;
  private apiGateway?: ApiGatewayService;
  private stepFunctions?: StepFunctionsService;

  constructor(
    private readonly store: StateStore,
    private readonly region: string,
    private readonly clock: Clock,
    private readonly scheduler: Scheduler,
    private readonly telemetry: TelemetryBus,
    private readonly lambda: LambdaService,
  ) {
    this.deliveries = new EventBridgeDeliveryStore(store.root, store.accountId, region);
    this.archiveStore = new EventBridgeArchiveStore(store.root, store.accountId, region, () => Buffer.from(store.state.installation.eventBridgeArchiveEncryptionKey, "base64"));
  }

  setTargetServices(services: { sqs: SqsService; sns: SnsService; logs: CloudWatchLogsService; apiGateway: ApiGatewayService }): void { this.sqs = services.sqs; this.sns = services.sns; this.logs = services.logs; this.apiGateway = services.apiGateway; }
  setStepFunctionsService(service: StepFunctionsService): void { this.stepFunctions = service; }

  private get pagination(): PaginationTokens { return new PaginationTokens(this.store.state.installation.paginationSecret); }
  private get state() { return this.store.regionState(this.region); }
  private get buses(): Record<string, EventBridgeEventBusState> { return this.state.eventBuses; }
  private get rules(): Record<string, EventBridgeRuleState> { return this.state.eventRules; }
  private get targets(): Record<string, Record<string, ExtendedEventBridgeTargetState>> { return this.state.eventTargets as Record<string, Record<string, ExtendedEventBridgeTargetState>>; }
  private key(bus: string, rule: string): string { return `${bus}\0${rule}`; }
  private busArn(name: string): string { return `arn:aws:events:${this.region}:${this.store.accountId}:event-bus/${name}`; }
  private ruleArn(bus: string, name: string): string { return `arn:aws:events:${this.region}:${this.store.accountId}:rule/${bus === "default" ? "" : `${bus}/`}${name}`; }

  async start(): Promise<void> {
    if (!this.startPromise) this.startPromise = (async () => {
      const created = this.ensureDefaultBus();
      await this.deliveries.start();
      await this.archiveStore.start(this.clock.now());
      if (created) await this.store.save();
    })();
    await this.startPromise;
    this.stopped = false;
    this.scheduleNext();
    this.scheduleNextReplay();
    await this.initializeLegacySchedules();
    this.scheduleNextLegacyRule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelWorker?.(); this.cancelWorker = undefined;
    this.cancelLegacyScheduleWorker?.(); this.cancelLegacyScheduleWorker = undefined;
    this.cancelReplayWorker?.(); this.cancelReplayWorker = undefined;
    await this.workerPromise?.catch(() => undefined);
    await this.replayWorkerPromise?.catch(() => undefined);
    await this.legacyScheduleWorkerPromise?.catch(() => undefined);
    await Promise.allSettled([...this.pendingTelemetry]);
    await this.deliveries.stop();
    await this.archiveStore.stop();
  }

  private async ensureControl(): Promise<void> { if (this.ensureDefaultBus()) await this.store.save(); }
  private async ensureStarted(): Promise<void> { await this.start(); }
  private ensureDefaultBus(): boolean {
    this.state.eventBuses = nullRecord(this.state.eventBuses);
    this.state.eventRules = nullRecord(this.state.eventRules);
    this.state.eventTargets = nullRecord(this.state.eventTargets);
    for (const bus of Object.values(this.buses)) bus.tags = nullRecord(bus.tags);
    for (const rule of Object.values(this.rules)) rule.tags = nullRecord(rule.tags);
    for (const [key, targets] of Object.entries(this.targets)) { this.targets[key] = nullRecord(targets); for (const target of Object.values(this.targets[key])) if (target.inputTransformer?.inputPathsMap) target.inputTransformer.inputPathsMap = nullRecord(target.inputTransformer.inputPathsMap); }
    if (Object.hasOwn(this.buses, "default")) return false;
    const now = this.clock.now();
    this.buses.default = { name: "default", arn: this.busArn("default"), createdAt: now, lastModified: now, tags: {} };
    return true;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.ensureStarted();
    const target = String(req.headers["x-amz-target"] ?? "");
    const action = target.startsWith("AWSEvents.") ? target.slice("AWSEvents.".length) : "";
    try {
      if (req.method !== "POST" || !ACTIONS.has(action)) throw new AwsError("UnknownOperationException", `The operation ${action || "(empty)"} is not supported.`);
      const input = await parseAwsJson(req);
      const operation = (this as unknown as Record<string, (value: any, request?: IncomingMessage) => Promise<unknown>>)[action];
      const output = await operation.call(this, input, req);
      sendAwsJson(res, output ?? {}, "1.1");
    } catch (error) { this.sendError(res, error); }
  }

  private sendError(res: ServerResponse, error: unknown): void {
    const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", errorMessage(error), 500);
    res.statusCode = aws.status;
    res.setHeader("content-type", "application/x-amz-json-1.1");
    res.end(JSON.stringify({ __type: `com.amazonaws.eventbridge#${aws.code}`, message: aws.message, ...aws.details }));
  }

  private resolveBusIdentifier(value: unknown, required = true): string {
    const supplied = value === undefined || value === "" ? "default" : String(value);
    const arn = supplied.match(/^arn:aws:events:([^:]+):(\d{12}):event-bus\/(.+)$/);
    const name = arn ? arn[3] : busName(supplied);
    if (arn && (arn[1] !== this.region || arn[2] !== this.store.accountId)) {
      if (required) throw new AwsError("ResourceNotFoundException", `Event bus ${supplied} does not exist.`);
      dependency("Cross-account or cross-Region event bus ingestion", "EVB-06");
    }
    if (required && !Object.hasOwn(this.buses, name)) throw new AwsError("ResourceNotFoundException", `Event bus ${supplied} does not exist.`);
    return name;
  }

  private requireRule(nameValue: unknown, busValue?: unknown): { key: string; rule: EventBridgeRuleState } {
    const name = ruleName(nameValue); const bus = this.resolveBusIdentifier(busValue); const key = this.key(bus, name); const rule = this.rules[key];
    if (!rule) throw new AwsError("ResourceNotFoundException", `Rule ${name} does not exist on event bus ${bus}.`);
    return { key, rule };
  }

  private executionRole(roleValue: unknown, delivery = false, sourceArn?: string): string {
    const roleArn = text(roleValue, "RoleArn", 1, 1600);
    const match = /^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9+=,.@_\/-]+$/.exec(roleArn);
    const role = match?.[1] === this.store.accountId ? Object.values(this.store.ensureAccount().iam.roles).find(candidate => candidate.arn === roleArn) : undefined;
    const trusted = role && evaluateTrust(role.assumeRolePolicyDocument, "events.amazonaws.com", "sts:AssumeRole", { "aws:PrincipalServiceName": "events.amazonaws.com", "aws:SourceAccount": this.store.accountId, ...(sourceArn ? { "aws:SourceArn": sourceArn } : {}) }).decision === "allowed";
    if (!role || !trusted) {
      if (delivery) throw new AwsError("FailedToAssumeRoleException", `EventBridge cannot assume target role ${roleArn}.`, 403);
      throw new AwsError("AccessDeniedException", `RoleArn must identify a role in this account that trusts events.amazonaws.com.`, 403);
    }
    return roleArn;
  }

  private queueState(arn: string): any | undefined {
    const parts = sqsArnParts(arn);
    return parts ? this.store.state.accounts[parts.accountId]?.regions[parts.region]?.sqsQueues?.[parts.queueName] : undefined;
  }

  private validateHttpParameters(raw: unknown, targetArn: string): EventBridgeHttpParametersState {
    const value = object(raw, "Target.HttpParameters");
    for (const key of Object.keys(value)) if (!["PathParameterValues", "QueryStringParameters", "HeaderParameters"].includes(key)) throw new AwsError("ValidationException", `Target.HttpParameters.${key} is not supported.`);
    const dynamic = (candidate: string, name: string): string => {
      if (candidate === "$" || candidate.startsWith("$.")) jsonPathParts(candidate);
      if (candidate.length > 512) throw new AwsError("ValidationException", `${name} must not exceed 512 characters.`);
      return candidate;
    };
    const map = (rawMap: unknown, name: string, header: boolean): Record<string, string> | undefined => {
      if (rawMap === undefined) return undefined;
      const source = object(rawMap, name);
      if (Object.keys(source).length > 100) throw new AwsError("ValidationException", `${name} can contain at most 100 entries.`);
      const result: Record<string, string> = Object.create(null);
      for (const [key, rawValue] of Object.entries(source)) {
        if (key.length < 1 || key.length > 512 || (header ? !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key) : /[\x00-\x1f\x7f]/.test(key))) throw new AwsError("ValidationException", `${name} contains an invalid key.`);
        const lower = key.toLowerCase();
        if (header && (lower.startsWith("x-amz") || lower.startsWith("x-amzn") || PROHIBITED_EVENTBRIDGE_HEADERS.has(lower))) throw new AwsError("ValidationException", `HTTP header ${key} cannot be supplied by an EventBridge target.`);
        const candidate = text(rawValue, `${name}.${key}`, 1, 512);
        if (header ? !/^[\t\x20-\x7e]+$/.test(candidate) : !/^[^\x00-\x09\x0b\x0c\x0e-\x1f\x7f]+$/.test(candidate)) throw new AwsError("ValidationException", `${name}.${key} contains unsupported control characters.`);
        result[key] = dynamic(candidate, `${name}.${key}`);
      }
      return result;
    };
    let pathParameterValues: string[] | undefined;
    if (value.PathParameterValues !== undefined) {
      if (!Array.isArray(value.PathParameterValues) || value.PathParameterValues.length > 100) throw new AwsError("ValidationException", "Target.HttpParameters.PathParameterValues must be an array of at most 100 values.");
      pathParameterValues = value.PathParameterValues.map((item, index) => {
        const candidate = text(item, `Target.HttpParameters.PathParameterValues[${index}]`, 1, 512);
        if (!candidate.trim()) throw new AwsError("ValidationException", "HTTP path parameter values cannot be blank.");
        return dynamic(candidate, `Target.HttpParameters.PathParameterValues[${index}]`);
      });
    }
    const wildcardCount = (targetArn.match(/\/[^/]+\/[^/]+\/[A-Za-z]+\/(.*)$/)?.[1].match(/\*/g) ?? []).length;
    if ((pathParameterValues?.length ?? 0) !== wildcardCount) throw new AwsError("ValidationException", `HttpParameters.PathParameterValues must contain exactly ${wildcardCount} value(s) for the target ARN.`);
    const queryStringParameters = map(value.QueryStringParameters, "Target.HttpParameters.QueryStringParameters", false);
    const headerParameters = map(value.HeaderParameters, "Target.HttpParameters.HeaderParameters", true);
    return { ...(pathParameterValues ? { pathParameterValues } : {}), ...(queryStringParameters ? { queryStringParameters } : {}), ...(headerParameters ? { headerParameters } : {}) };
  }

  private page<T>(operation: string, scope: unknown, values: T[], limitValue: unknown, tokenValue: unknown): { values: T[]; nextToken?: string } {
    const limit = positiveInteger(limitValue, "Limit", 1, 100, 100); let index = 0;
    if (tokenValue !== undefined) try {
      const cursor = this.pagination.decode<{ index: number; scope: unknown }>(operation, String(tokenValue));
      if (!Number.isInteger(cursor.index) || cursor.index < 0 || JSON.stringify(cursor.scope) !== JSON.stringify(scope)) throw new Error();
      index = cursor.index;
    } catch { throw new AwsError("InvalidToken", "The pagination token is invalid."); }
    const page = values.slice(index, index + limit); const next = index + page.length;
    return { values: page, ...(next < values.length ? { nextToken: this.pagination.encode(operation, { index: next, scope }) } : {}) };
  }

  async CreateEventBus(input: any): Promise<any> {
    await this.ensureControl();
    if (input.EventSourceName !== undefined) dependency("EventSourceName partner buses", "EVB-08");
    if (input.KmsKeyIdentifier !== undefined) dependency("KMS-backed event buses", "EVB-08");
    if (input.DeadLetterConfig !== undefined) dependency("Encrypted-bus DeadLetterConfig", "EVB-08");
    if (input.LogConfig !== undefined) dependency("Event bus LogConfig", "EVB-08");
    const name = busName(input.Name); if (name.includes("/")) throw new AwsError("ValidationException", "Custom event bus names cannot contain slashes."); if (name === "default") throw new AwsError("ResourceAlreadyExistsException", "The default event bus already exists.");
    if (Object.hasOwn(this.buses, name)) throw new AwsError("ResourceAlreadyExistsException", `Event bus ${name} already exists.`);
    const description = input.Description === undefined ? undefined : text(input.Description, "Description", 0, 512); const tags = tagsRecord(input.Tags); const now = this.clock.now(); const arn = this.busArn(name);
    this.buses[name] = { name, arn, ...(description !== undefined ? { description } : {}), createdAt: now, lastModified: now, tags };
    await this.store.save(); return { EventBusArn: arn, ...(description !== undefined ? { Description: description } : {}) };
  }

  async DescribeEventBus(input: any): Promise<any> {
    await this.ensureControl(); const name = this.resolveBusIdentifier(input.Name); const bus = this.buses[name];
    return { Name: bus.name, Arn: bus.arn, ...(bus.description !== undefined ? { Description: bus.description } : {}), CreationTime: bus.createdAt / 1000, LastModifiedTime: bus.lastModified / 1000 };
  }

  async ListEventBuses(input: any): Promise<any> {
    await this.ensureControl(); const prefix = input.NamePrefix === undefined ? undefined : text(input.NamePrefix, "NamePrefix", 1, 256);
    const buses = Object.values(this.buses).filter(bus => !prefix || bus.name.startsWith(prefix)).sort((a, b) => a.name.localeCompare(b.name));
    const page = this.page("ListEventBuses", { prefix: prefix ?? null }, buses, input.Limit, input.NextToken);
    return { EventBuses: page.values.map(bus => ({ Name: bus.name, Arn: bus.arn, ...(bus.description !== undefined ? { Description: bus.description } : {}), CreationTime: bus.createdAt / 1000, LastModifiedTime: bus.lastModified / 1000 })), ...(page.nextToken ? { NextToken: page.nextToken } : {}) };
  }

  async DeleteEventBus(input: any): Promise<any> {
    await this.ensureControl(); const name = this.resolveBusIdentifier(input.Name, false);
    if (name === "default") throw new AwsError("ValidationException", "The default event bus cannot be deleted.");
    if (!Object.hasOwn(this.buses, name)) return {};
    if (Object.values(this.rules).some(rule => rule.eventBusName === name)) throw new AwsError("ValidationException", `Event bus ${name} still has rules.`);
    if (this.archiveStore.archives().some(archive => archive.eventBusName === name)) throw new AwsError("ValidationException", `Event bus ${name} still has archives.`);
    delete this.buses[name]; await this.store.save(); return {};
  }

  private archiveArn(name: string): string { return `arn:aws:events:${this.region}:${this.store.accountId}:archive/${name}`; }
  private replayArn(name: string): string { return `arn:aws:events:${this.region}:${this.store.accountId}:replay/${name}`; }
  private archiveCounts(archive: EventBridgeArchiveMetadata): { EventCount: number; SizeBytes: number } { const records = archive.retentionDays ? archive.records.filter(record => record.eventTime >= this.clock.now() - archive.retentionDays * 24 * 60 * 60 * 1_000) : archive.records; return { EventCount: records.length, SizeBytes: records.reduce((sum, record) => sum + record.sizeBytes, 0) }; }
  private archiveSummary(archive: EventBridgeArchiveMetadata): any { return { ArchiveName: archive.name, EventSourceArn: archive.eventSourceArn, State: archive.state, ...(archive.stateReason ? { StateReason: archive.stateReason } : {}), RetentionDays: archive.retentionDays, ...this.archiveCounts(archive), CreationTime: archive.createdAt / 1_000 }; }
  private replaySummary(replay: EventBridgeReplayMetadata): any { return { ReplayName: replay.name, EventSourceArn: replay.eventSourceArn, State: replay.state, ...(replay.stateReason ? { StateReason: replay.stateReason } : {}), EventStartTime: replay.eventStartTime / 1_000, EventEndTime: replay.eventEndTime / 1_000, ...(replay.eventLastReplayedTime !== undefined ? { EventLastReplayedTime: replay.eventLastReplayedTime / 1_000 } : {}), ReplayStartTime: replay.replayStartTime / 1_000, ...(replay.replayEndTime !== undefined ? { ReplayEndTime: replay.replayEndTime / 1_000 } : {}) }; }

  async CreateArchive(input: any): Promise<any> {
    await this.ensureStarted();
    if (input.KmsKeyIdentifier !== undefined) validateKmsIdentifier(input.KmsKeyIdentifier);
    const name = archiveName(input.ArchiveName); const eventSourceArn = text(input.EventSourceArn, "EventSourceArn", 1, 1600);
    const bus = Object.values(this.buses).find(candidate => candidate.arn === eventSourceArn); if (!bus) throw new AwsError("ResourceNotFoundException", `Event source ${eventSourceArn} does not exist.`);
    const description = input.Description === undefined ? undefined : text(input.Description, "Description", 0, 512);
    const eventPattern = input.EventPattern === undefined ? undefined : text(input.EventPattern, "EventPattern", 1, MAX_EVENT_PATTERN_BYTES); if (eventPattern !== undefined) compiledPattern(eventPattern);
    const retentionDays = input.RetentionDays === undefined ? 0 : positiveInteger(input.RetentionDays, "RetentionDays", 0, Number.MAX_SAFE_INTEGER);
    const now = this.clock.now();
    try {
      const archive = await this.archiveStore.createArchive({ name, arn: this.archiveArn(name), eventSourceArn, eventBusName: bus.name, ...(description !== undefined ? { description } : {}), ...(eventPattern !== undefined ? { eventPattern } : {}), retentionDays, state: "ENABLED", createdAt: now, lastModified: now });
      return { ArchiveArn: archive.arn, State: archive.state, CreationTime: archive.createdAt / 1_000 };
    } catch (error) { if (errorMessage(error) === "ArchiveAlreadyExists") throw new AwsError("ResourceAlreadyExistsException", `Archive ${name} already exists.`); throw error; }
  }

  async DescribeArchive(input: any): Promise<any> {
    await this.ensureStarted(); await this.archiveStore.reconcile(this.clock.now()); const name = archiveName(input.ArchiveName); const archive = this.archiveStore.archive(name);
    if (!archive) throw new AwsError("ResourceNotFoundException", `Archive ${name} does not exist.`);
    return { ArchiveArn: archive.arn, ArchiveName: archive.name, EventSourceArn: archive.eventSourceArn, ...(archive.description !== undefined ? { Description: archive.description } : {}), ...(archive.eventPattern !== undefined ? { EventPattern: archive.eventPattern } : {}), State: archive.state, ...(archive.stateReason ? { StateReason: archive.stateReason } : {}), RetentionDays: archive.retentionDays, ...this.archiveCounts(archive), CreationTime: archive.createdAt / 1_000 };
  }

  async ListArchives(input: any): Promise<any> {
    await this.ensureStarted(); await this.archiveStore.reconcile(this.clock.now());
    const suppliedFilters = [input.NamePrefix, input.EventSourceArn, input.State].filter(value => value !== undefined); if (suppliedFilters.length > 1) throw new AwsError("ValidationException", "ListArchives filter parameters are mutually exclusive.");
    const prefix = input.NamePrefix === undefined ? undefined : text(input.NamePrefix, "NamePrefix", 1, 48); const source = input.EventSourceArn === undefined ? undefined : text(input.EventSourceArn, "EventSourceArn", 1, 1600);
    const state = input.State === undefined ? undefined : String(input.State); if (state && !new Set(["ENABLED", "DISABLED", "CREATING", "UPDATING", "CREATE_FAILED", "UPDATE_FAILED"]).has(state)) throw new AwsError("ValidationException", "State is not a valid archive state.");
    const values = this.archiveStore.archives().filter(item => (!prefix || item.name.startsWith(prefix)) && (!source || item.eventSourceArn === source) && (!state || item.state === state)).sort((a, b) => a.name.localeCompare(b.name));
    const page = this.page("ListArchives", { prefix: prefix ?? null, source: source ?? null, state: state ?? null }, values, input.Limit, input.NextToken);
    return { Archives: page.values.map(item => this.archiveSummary(item)), ...(page.nextToken ? { NextToken: page.nextToken } : {}) };
  }

  async UpdateArchive(input: any): Promise<any> {
    await this.ensureStarted(); if (input.KmsKeyIdentifier !== undefined) validateKmsIdentifier(input.KmsKeyIdentifier); const name = archiveName(input.ArchiveName); const existing = this.archiveStore.archive(name); if (!existing) throw new AwsError("ResourceNotFoundException", `Archive ${name} does not exist.`);
    const description = input.Description === undefined ? existing.description : text(input.Description, "Description", 0, 512); const eventPattern = input.EventPattern === undefined ? existing.eventPattern : text(input.EventPattern, "EventPattern", 1, MAX_EVENT_PATTERN_BYTES); if (eventPattern !== undefined) compiledPattern(eventPattern);
    const retentionDays = input.RetentionDays === undefined ? existing.retentionDays : positiveInteger(input.RetentionDays, "RetentionDays", 0, Number.MAX_SAFE_INTEGER); const archive = await this.archiveStore.updateArchive(name, { description, eventPattern, retentionDays, lastModified: this.clock.now() }); await this.archiveStore.reconcile(this.clock.now());
    return { ArchiveArn: archive.arn, State: archive.state, CreationTime: archive.createdAt / 1_000 };
  }

  async DeleteArchive(input: any): Promise<any> {
    await this.ensureStarted(); const name = archiveName(input.ArchiveName);
    try { if (!await this.archiveStore.deleteArchive(name)) throw new AwsError("ResourceNotFoundException", `Archive ${name} does not exist.`); return {}; }
    catch (error) { if (errorMessage(error) === "ArchiveReplayConflict") throw new AwsError("ConcurrentModificationException", `Archive ${name} has an active replay.`); throw error; }
  }

  async StartReplay(input: any): Promise<any> {
    await this.ensureStarted(); await this.archiveStore.reconcile(this.clock.now()); const name = replayName(input.ReplayName); const description = input.Description === undefined ? undefined : text(input.Description, "Description", 0, 512); const eventSourceArn = text(input.EventSourceArn, "EventSourceArn", 1, 1600);
    const archive = this.archiveStore.archives().find(candidate => candidate.arn === eventSourceArn); if (!archive) throw new AwsError("ResourceNotFoundException", `Archive ${eventSourceArn} does not exist.`); if (archive.state !== "ENABLED") throw new AwsError("ConcurrentModificationException", `Archive ${archive.name} is not enabled.`);
    const eventStartTime = timestamp(input.EventStartTime, "EventStartTime"); const eventEndTime = timestamp(input.EventEndTime, "EventEndTime"); if (eventStartTime > eventEndTime) throw new AwsError("ValidationException", "EventStartTime must not be after EventEndTime.");
    const destination = object(input.Destination, "Destination"); const destinationArn = text(destination.Arn, "Destination.Arn", 1, 1600); if (destinationArn !== archive.eventSourceArn) throw new AwsError("ValidationException", "A replay destination must be the archive source event bus.");
    let filterArns: string[] | undefined;
    if (destination.FilterArns !== undefined) {
      if (!Array.isArray(destination.FilterArns) || !destination.FilterArns.length || destination.FilterArns.length > 100) throw new AwsError("ValidationException", "Destination.FilterArns must contain between 1 and 100 rule ARNs.");
      filterArns = destination.FilterArns.map((value: unknown, index: number) => text(value, `Destination.FilterArns[${index}]`, 1, 1600)); if (new Set(filterArns).size !== filterArns.length) throw new AwsError("ValidationException", "Destination.FilterArns cannot contain duplicates.");
      for (const arn of filterArns) { const rule = Object.values(this.rules).find(candidate => candidate.arn === arn); if (!rule || rule.eventBusName !== archive.eventBusName) throw new AwsError("ResourceNotFoundException", `Replay destination rule ${arn} does not exist on the source event bus.`); if (rule.state === "DISABLED") throw new AwsError("ValidationException", `Replay destination rule ${arn} is disabled.`); }
    }
    const now = this.clock.now();
    try {
      const replay = await this.archiveStore.createReplay({ name, arn: this.replayArn(name), ...(description !== undefined ? { description } : {}), archiveName: archive.name, eventSourceArn, destinationArn, ...(filterArns ? { filterArns } : {}), eventStartTime, eventEndTime, state: "STARTING", stateReason: "Replay is queued for deterministic local processing.", replayStartTime: now }); this.scheduleNextReplay();
      return { ReplayArn: replay.arn, State: replay.state, StateReason: replay.stateReason, ReplayStartTime: replay.replayStartTime / 1_000 };
    } catch (error) {
      if (errorMessage(error) === "ReplayAlreadyExists") throw new AwsError("ResourceAlreadyExistsException", `Replay ${name} already exists.`);
      if (errorMessage(error) === "ReplayLimitExceeded") throw new AwsError("LimitExceededException", "The current account already has ten active replays.");
      if (errorMessage(error) === "ArchiveReplayConflict") throw new AwsError("ConcurrentModificationException", `Archive ${archive.name} already has an active replay.`);
      throw error;
    }
  }

  async DescribeReplay(input: any): Promise<any> {
    await this.ensureStarted(); await this.archiveStore.reconcile(this.clock.now()); const name = replayName(input.ReplayName); const replay = this.archiveStore.replay(name); if (!replay) throw new AwsError("ResourceNotFoundException", `Replay ${name} does not exist.`);
    return { ReplayArn: replay.arn, ...(replay.description !== undefined ? { Description: replay.description } : {}), Destination: { Arn: replay.destinationArn, ...(replay.filterArns ? { FilterArns: replay.filterArns } : {}) }, ...this.replaySummary(replay) };
  }

  async ListReplays(input: any): Promise<any> {
    await this.ensureStarted(); await this.archiveStore.reconcile(this.clock.now()); const suppliedFilters = [input.NamePrefix, input.EventSourceArn, input.State].filter(value => value !== undefined); if (suppliedFilters.length > 1) throw new AwsError("ValidationException", "ListReplays filter parameters are mutually exclusive.");
    const prefix = input.NamePrefix === undefined ? undefined : text(input.NamePrefix, "NamePrefix", 1, 64); const source = input.EventSourceArn === undefined ? undefined : text(input.EventSourceArn, "EventSourceArn", 1, 1600); const state = input.State === undefined ? undefined : String(input.State); if (state && !new Set(["STARTING", "RUNNING", "CANCELLING", "COMPLETED", "CANCELLED", "FAILED"]).has(state)) throw new AwsError("ValidationException", "State is not a valid replay state.");
    const values = this.archiveStore.replays().filter(item => (!prefix || item.name.startsWith(prefix)) && (!source || item.eventSourceArn === source) && (!state || item.state === state)).sort((a, b) => a.name.localeCompare(b.name)); const page = this.page("ListReplays", { prefix: prefix ?? null, source: source ?? null, state: state ?? null }, values, input.Limit, input.NextToken);
    return { Replays: page.values.map(item => this.replaySummary(item)), ...(page.nextToken ? { NextToken: page.nextToken } : {}) };
  }

  async CancelReplay(input: any): Promise<any> {
    await this.ensureStarted(); const name = replayName(input.ReplayName);
    try { const replay = await this.archiveStore.requestCancel(name); this.scheduleNextReplay(); return { ReplayArn: replay.arn, State: replay.state, StateReason: replay.stateReason }; }
    catch (error) { if (errorMessage(error) === "ReplayNotFound") throw new AwsError("ResourceNotFoundException", `Replay ${name} does not exist.`); if (errorMessage(error) === "ReplayNotCancellable") throw new AwsError("IllegalStatusException", `Replay ${name} is no longer active.`); throw error; }
  }

  async TestEventPattern(input: any): Promise<any> {
    const pattern = compiledPattern(text(input.EventPattern, "EventPattern", 1, MAX_EVENT_PATTERN_BYTES));
    let event: unknown; try { if (typeof input.Event !== "string" || !input.Event.length) throw new TypeError(); event = parseEventJson(input.Event); } catch { throw new AwsError("InvalidEventPatternException", "Event must be valid JSON and use supported numeric ranges."); }
    const envelope = object(event, "Event");
    for (const field of ["id", "account", "source", "time", "region", "resources", "detail-type"]) if (!(field in envelope)) throw new AwsError("InvalidEventPatternException", `Event is missing mandatory field ${field}.`);
    for (const field of ["id", "account", "source", "time", "region", "detail-type"]) if (typeof envelope[field] !== "string") throw new AwsError("InvalidEventPatternException", `Event field ${field} must be a string.`); if (!Array.isArray(envelope.resources) || envelope.resources.some(resource => typeof resource !== "string")) throw new AwsError("InvalidEventPatternException", "Event field resources must be an array of strings."); if (!Number.isFinite(Date.parse(String(envelope.time)))) throw new AwsError("InvalidEventPatternException", "Event field time must be an RFC3339 timestamp.");
    return { Result: matchesEventPattern(pattern, envelope) };
  }

  async PutRule(input: any): Promise<any> {
    await this.ensureControl();
    if (input.RoleArn !== undefined) dependency("PutRule.RoleArn for cross-account event-bus targets", "EVB-06");
    if (input.EventPattern === undefined && input.ScheduleExpression === undefined) throw new AwsError("ValidationException", "EventPattern or ScheduleExpression is required.");
    const name = ruleName(input.Name); const bus = this.resolveBusIdentifier(input.EventBusName);
    const pattern = input.EventPattern === undefined ? undefined : text(input.EventPattern, "EventPattern", 1, MAX_EVENT_PATTERN_BYTES); if (pattern !== undefined) compiledPattern(pattern);
    let scheduleExpression: string | undefined;
    if (input.ScheduleExpression !== undefined) {
      if (bus !== "default") throw new AwsError("ValidationException", "Scheduled rules can be created only on the default event bus.");
      scheduleExpression = text(input.ScheduleExpression, "ScheduleExpression", 1, 256);
      const parsed = parseScheduleExpression(scheduleExpression);
      if (parsed.kind === "at") throw new AwsError("ValidationException", "Legacy scheduled rules support only rate() and cron() expressions.");
    }
    const state = input.State ?? "ENABLED"; if (!new Set(["ENABLED", "DISABLED", "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS"]).has(state)) throw new AwsError("ValidationException", "State must be ENABLED, DISABLED, or ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS.");
    const description = input.Description === undefined ? undefined : text(input.Description, "Description", 0, 512);
    const key = this.key(bus, name); const existing = this.rules[key]; if (existing?.managedBy) throw new AwsError("ManagedRuleException", `Rule ${name} is managed by ${existing.managedBy}.`);
    const now = this.clock.now(); const arn = existing?.arn ?? this.ruleArn(bus, name); const tags = existing ? existing.tags : tagsRecord(input.Tags);
    const scheduleCreatedAt = scheduleExpression ? existing?.scheduleExpression === scheduleExpression ? existing.scheduleCreatedAt ?? existing.createdAt : now : undefined;
    const next = scheduleExpression ? nextScheduleOccurrence({ expression: scheduleExpression, timezone: "UTC", after: now - 1, anchor: scheduleCreatedAt!, lastLocalKey: undefined }) : undefined;
    this.rules[key] = { name, arn, eventBusName: bus, ...(pattern !== undefined ? { eventPattern: pattern } : {}), ...(scheduleExpression ? { scheduleExpression, scheduleCreatedAt, scheduleNextAt: next?.at } : {}), state, ...(description !== undefined ? { description } : {}), createdAt: existing?.createdAt ?? now, lastModified: now, tags };
    this.targets[key] ??= {}; await this.store.save(); this.scheduleNextLegacyRule(); return { RuleArn: arn };
  }

  private ruleView(rule: EventBridgeRuleState): any {
    return { Name: rule.name, Arn: rule.arn, EventBusName: rule.eventBusName, ...(rule.eventPattern !== undefined ? { EventPattern: rule.eventPattern } : {}), ...(rule.scheduleExpression ? { ScheduleExpression: rule.scheduleExpression } : {}), State: rule.state, ...(rule.description !== undefined ? { Description: rule.description } : {}), ...(rule.roleArn ? { RoleArn: rule.roleArn } : {}), ...(rule.managedBy ? { ManagedBy: rule.managedBy } : {}) };
  }

  async DescribeRule(input: any): Promise<any> { await this.ensureControl(); return this.ruleView(this.requireRule(input.Name, input.EventBusName).rule); }

  async ListRules(input: any): Promise<any> {
    await this.ensureControl(); const bus = this.resolveBusIdentifier(input.EventBusName); const prefix = input.NamePrefix === undefined ? undefined : text(input.NamePrefix, "NamePrefix", 1, 64);
    const rules = Object.values(this.rules).filter(rule => rule.eventBusName === bus && (!prefix || rule.name.startsWith(prefix))).sort((a, b) => a.name.localeCompare(b.name));
    const page = this.page("ListRules", { bus, prefix: prefix ?? null }, rules, input.Limit, input.NextToken);
    return { Rules: page.values.map(rule => this.ruleView(rule)), ...(page.nextToken ? { NextToken: page.nextToken } : {}) };
  }

  async DeleteRule(input: any): Promise<any> {
    await this.ensureControl(); const name = ruleName(input.Name); const bus = this.resolveBusIdentifier(input.EventBusName); const key = this.key(bus, name); const rule = this.rules[key]; if (!rule) return {};
    if (rule.managedBy && input.Force !== true) throw new AwsError("ManagedRuleException", `Rule ${rule.name} is managed by ${rule.managedBy}.`);
    if (Object.keys(this.targets[key] ?? {}).length) throw new AwsError("ValidationException", `Rule ${rule.name} still has targets. Remove the targets before deleting the rule.`);
    delete this.rules[key]; delete this.targets[key]; await this.store.save(); this.scheduleNextLegacyRule(); return {};
  }

  private async setRuleState(input: any, state: "ENABLED" | "DISABLED"): Promise<any> {
    await this.ensureControl(); const { rule } = this.requireRule(input.Name, input.EventBusName); if (rule.managedBy) throw new AwsError("ManagedRuleException", `Rule ${rule.name} is managed by ${rule.managedBy}.`);
    rule.state = state; rule.lastModified = this.clock.now();
    if (state === "ENABLED" && rule.scheduleExpression) rule.scheduleNextAt = nextScheduleOccurrence({ expression: rule.scheduleExpression, timezone: "UTC", after: this.clock.now() - 1, anchor: rule.scheduleCreatedAt ?? rule.createdAt })?.at;
    await this.store.save(); this.scheduleNextLegacyRule(); return {};
  }
  async EnableRule(input: any): Promise<any> { return this.setRuleState(input, "ENABLED"); }
  async DisableRule(input: any): Promise<any> { return this.setRuleState(input, "DISABLED"); }

  private validateTarget(raw: unknown, ruleArn?: string): ExtendedEventBridgeTargetState {
    const value = object(raw, "Target"); const id = targetId(value.Id); const arn = text(value.Arn, "Target.Arn", 1, 1600); const targetType = classifyTargetArn(arn, this.region, this.store.accountId);
    if (targetType === "states") { if (!this.stepFunctions?.hasStateMachine(arn)) throw new AwsError("ValidationException", `Step Functions target state machine does not exist: ${arn}`); if (value.RoleArn === undefined) throw new AwsError("ValidationException", "A Step Functions target requires Target.RoleArn."); }
    if (targetType === "sns") {
      if (!this.sns) throw new AwsError("ValidationException", "The SNS target dependency is unavailable.");
      try { this.sns.assertTopicExists(arn); } catch { throw new AwsError("ValidationException", `SNS target topic does not exist: ${arn}`); }
    }
    for (const field of ["BatchParameters", "EcsParameters", "KinesisParameters", "RedshiftDataParameters", "RunCommandParameters", "SageMakerPipelineParameters", "AppSyncParameters"]) if (value[field] !== undefined) dependency(`Target.${field}`, "a later EventBridge target phase");
    if (targetType === "logs" && value.Input !== undefined) throw new AwsError("ValidationException", "CloudWatch Logs targets do not support Target.Input.");
    if (targetType === "logs" && value.InputPath !== undefined) throw new AwsError("ValidationException", "CloudWatch Logs targets do not support Target.InputPath.");
    const selectors = [value.Input, value.InputPath, value.InputTransformer].filter(item => item !== undefined); if (selectors.length > 1) throw new AwsError("ValidationException", "Input, InputPath, and InputTransformer are mutually exclusive.");
    const result: ExtendedEventBridgeTargetState = { id, arn, targetType };
    if (value.RoleArn !== undefined) {
      if (targetType === "logs") throw new AwsError("ValidationException", "CloudWatch Logs targets use a Logs resource policy and do not accept Target.RoleArn.");
      result.roleArn = this.executionRole(value.RoleArn, false, ruleArn);
    }
    if (value.Input !== undefined) { const input = text(value.Input, "Target.Input", 0, MAX_TARGET_INPUT_BYTES); try { parseEventJson(input); } catch { throw new AwsError("ValidationException", "Target.Input must be valid JSON."); } result.input = input; }
    if (value.InputPath !== undefined) { const path = text(value.InputPath, "Target.InputPath", 1, 256); jsonPathParts(path); result.inputPath = path; }
    if (value.InputTransformer !== undefined) {
      const transformer = object(value.InputTransformer, "Target.InputTransformer"); const template = text(transformer.InputTemplate, "Target.InputTransformer.InputTemplate", 1, MAX_TARGET_INPUT_BYTES); const rawPaths = transformer.InputPathsMap === undefined ? {} : object(transformer.InputPathsMap, "Target.InputTransformer.InputPathsMap");
      if (Object.keys(rawPaths).length > 100) throw new AwsError("ValidationException", "InputPathsMap can contain at most 100 variables.");
      const paths: Record<string, string> = Object.create(null); for (const [name, rawPath] of Object.entries(rawPaths)) { if (!/^[A-Za-z0-9_-]{1,256}$/.test(name)) throw new AwsError("ValidationException", `Input transformer variable ${name} is invalid.`); const path = text(rawPath, `InputPathsMap.${name}`, 1, 256); jsonPathParts(path); paths[name] = path; }
      const placeholders = templatePlaceholders(template).map(placeholder => placeholder.name); const predefined = new Set(["aws.events.rule-arn", "aws.events.rule-name", "aws.events.event.ingestion-time", "aws.events.event", "aws.events.event.json"]); if (placeholders.some(name => !(name in paths) && !predefined.has(name))) throw new AwsError("ValidationException", "InputTemplate references an undefined variable.");
      if (/"(?:[^"\\]|\\.)*<[^>]+>(?:[^"\\]|\\.)*"\s*:/.test(template)) throw new AwsError("ValidationException", "InputTemplate placeholders cannot be used as object keys.");
      const sample = Object.fromEntries(Object.keys(paths).map(name => [name, "sample"])); transformTemplate(template, Object.fromEntries(Object.keys(paths).map(name => [name, `$.${name}`])), sample, { name: "sample", arn: this.ruleArn("default", "sample") } as EventBridgeRuleState);
      if (targetType === "logs") validateCloudWatchLogsInputTemplate(template);
      result.inputTransformer = { inputTemplate: template, ...(Object.keys(paths).length ? { inputPathsMap: paths } : {}) };
    }
    if (value.RetryPolicy !== undefined) {
      const policy = object(value.RetryPolicy, "Target.RetryPolicy"); const maximumEventAgeInSeconds = positiveInteger(policy.MaximumEventAgeInSeconds, "MaximumEventAgeInSeconds", 60, 86_400, DEFAULT_EVENT_AGE_SECONDS); const maximumRetryAttempts = positiveInteger(policy.MaximumRetryAttempts, "MaximumRetryAttempts", 0, 185, DEFAULT_RETRY_ATTEMPTS);
      result.retryPolicy = { maximumEventAgeInSeconds, maximumRetryAttempts };
    }
    if (value.HttpParameters !== undefined && targetType !== "apigateway") throw new AwsError("ValidationException", "Target.HttpParameters is supported only for API Gateway targets.");
    if (targetType === "apigateway") {
      const parameters = this.validateHttpParameters(value.HttpParameters ?? {}, arn);
      if (value.HttpParameters !== undefined) result.httpParameters = parameters;
    }
    if (value.SqsParameters !== undefined && targetType !== "sqs") throw new AwsError("ValidationException", "Target.SqsParameters is supported only for SQS targets.");
    if (targetType === "sqs") {
      const queue = this.queueState(arn);
      if (!queue) throw new AwsError("ValidationException", `SQS target ${arn} does not exist in the configured simulator accounts.`);
      if (value.SqsParameters !== undefined) {
        const parameters = object(value.SqsParameters, "Target.SqsParameters");
        for (const key of Object.keys(parameters)) if (key !== "MessageGroupId") throw new AwsError("ValidationException", `Target.SqsParameters.${key} is not supported.`);
        const messageGroupId = text(parameters.MessageGroupId, "Target.SqsParameters.MessageGroupId", 1, 100);
        if (messageGroupId === "$" || messageGroupId.startsWith("$.")) jsonPathParts(messageGroupId);
        result.sqsParameters = { messageGroupId };
      }
      const fifo = queue.attributes.FifoQueue === "true";
      if (fifo && queue.attributes.ContentBasedDeduplication !== "true") throw new AwsError("ValidationException", "An EventBridge FIFO queue target must have content-based deduplication enabled.");
      if (fifo && !result.sqsParameters?.messageGroupId) throw new AwsError("ValidationException", "An EventBridge FIFO queue target requires SqsParameters.MessageGroupId.");
      const queueAccount = sqsArnParts(arn)!.accountId;
      if (queueAccount !== this.store.accountId && !result.roleArn) throw new AwsError("ValidationException", "A cross-account SQS target requires Target.RoleArn.");
    }
    if (value.DeadLetterConfig !== undefined) {
      const config = object(value.DeadLetterConfig, "Target.DeadLetterConfig");
      for (const key of Object.keys(config)) if (key !== "Arn") throw new AwsError("ValidationException", `Target.DeadLetterConfig.${key} is not supported.`);
      const deadLetterArn = text(config.Arn, "Target.DeadLetterConfig.Arn", 1, 1600); const parts = sqsArnParts(deadLetterArn);
      if (!parts || parts.region !== this.region) throw new AwsError("ValidationException", "A target dead-letter queue must be a Standard SQS queue in the rule Region.");
      const queue = this.queueState(deadLetterArn);
      if (!queue || queue.attributes.FifoQueue === "true") throw new AwsError("ValidationException", "A target dead-letter queue must identify an existing Standard SQS queue in the rule Region.");
      result.deadLetterArn = deadLetterArn;
    }
    return result;
  }

  async PutTargets(input: any): Promise<any> {
    await this.ensureControl(); const { key, rule } = this.requireRule(input.Rule, input.EventBusName); if (rule.managedBy) throw new AwsError("ManagedRuleException", `Rule ${rule.name} is managed by ${rule.managedBy}.`); if (!Array.isArray(input.Targets) || !input.Targets.length) throw new AwsError("ValidationException", "Targets must contain at least one entry."); if (input.Targets.length > 10) throw new AwsError("ValidationException", "PutTargets accepts at most 10 targets per call.");
    const current: Record<string, ExtendedEventBridgeTargetState> = Object.assign(Object.create(null), this.targets[key] ?? {}); const failures: any[] = []; const seen = new Set<string>();
    for (const raw of input.Targets) {
      let id = typeof raw?.Id === "string" ? raw.Id : "";
      try {
        const target = this.validateTarget(raw, rule.arn); id = target.id; if (seen.has(id)) throw new AwsError("ValidationException", `Target ID ${id} is duplicated in this request.`); seen.add(id);
        if (!Object.hasOwn(current, id) && Object.keys(current).length >= 5) throw new AwsError("LimitExceededException", "A rule can have at most five targets."); current[id] = target;
      } catch (error) { failures.push({ TargetId: id, ErrorCode: errorCode(error), ErrorMessage: errorMessage(error) }); }
    }
    this.targets[key] = current; if (input.Targets.length > failures.length) await this.store.save(); return { FailedEntryCount: failures.length, ...(failures.length ? { FailedEntries: failures } : {}) };
  }

  private targetView(target: ExtendedEventBridgeTargetState): any {
    return {
      Id: target.id,
      Arn: target.arn,
      ...(target.roleArn ? { RoleArn: target.roleArn } : {}),
      ...(target.deadLetterArn ? { DeadLetterConfig: { Arn: target.deadLetterArn } } : {}),
      ...(target.sqsParameters ? { SqsParameters: { MessageGroupId: target.sqsParameters.messageGroupId } } : {}),
      ...(target.httpParameters ? { HttpParameters: {
        ...(target.httpParameters.pathParameterValues ? { PathParameterValues: [...target.httpParameters.pathParameterValues] } : {}),
        ...(target.httpParameters.queryStringParameters ? { QueryStringParameters: clone(target.httpParameters.queryStringParameters) } : {}),
        ...(target.httpParameters.headerParameters ? { HeaderParameters: clone(target.httpParameters.headerParameters) } : {}),
      } } : {}),
      ...(target.input !== undefined ? { Input: target.input } : {}),
      ...(target.inputPath !== undefined ? { InputPath: target.inputPath } : {}),
      ...(target.inputTransformer ? { InputTransformer: { InputTemplate: target.inputTransformer.inputTemplate, ...(target.inputTransformer.inputPathsMap ? { InputPathsMap: clone(target.inputTransformer.inputPathsMap) } : {}) } } : {}),
      ...(target.retryPolicy ? { RetryPolicy: { MaximumEventAgeInSeconds: target.retryPolicy.maximumEventAgeInSeconds, MaximumRetryAttempts: target.retryPolicy.maximumRetryAttempts } } : {}),
    };
  }

  async ListTargetsByRule(input: any): Promise<any> {
    await this.ensureControl(); const { key, rule } = this.requireRule(input.Rule, input.EventBusName); const values = Object.values(this.targets[key] ?? {}).sort((a, b) => a.id.localeCompare(b.id)); const page = this.page("ListTargetsByRule", { ruleArn: rule.arn }, values, input.Limit, input.NextToken);
    return { Targets: page.values.map(target => this.targetView(target)), ...(page.nextToken ? { NextToken: page.nextToken } : {}) };
  }

  async RemoveTargets(input: any): Promise<any> {
    await this.ensureControl(); const { key, rule } = this.requireRule(input.Rule, input.EventBusName); if (rule.managedBy && input.Force !== true) throw new AwsError("ManagedRuleException", `Rule ${rule.name} is managed by ${rule.managedBy}.`);
    if (!Array.isArray(input.Ids) || !input.Ids.length || input.Ids.length > 10) throw new AwsError("ValidationException", "Ids must contain between 1 and 10 target IDs.");
    const failures: any[] = []; const ids = new Set<string>(); for (const raw of input.Ids) try { const id = targetId(raw); if (ids.has(id)) throw new AwsError("ValidationException", `Target ID ${id} is duplicated.`); ids.add(id); delete (this.targets[key] ?? {})[id]; } catch (error) { failures.push({ TargetId: String(raw ?? ""), ErrorCode: errorCode(error), ErrorMessage: errorMessage(error) }); }
    if (ids.size) await this.store.save(); return { FailedEntryCount: failures.length, ...(failures.length ? { FailedEntries: failures } : {}) };
  }

  async ListRuleNamesByTarget(input: any): Promise<any> {
    await this.ensureControl(); const arn = text(input.TargetArn, "TargetArn", 1, 1600); const bus = input.EventBusName === undefined ? undefined : this.resolveBusIdentifier(input.EventBusName);
    const names = Object.entries(this.targets).filter(([key, targets]) => Object.values(targets).some(target => target.arn === arn) && (!bus || this.rules[key]?.eventBusName === bus)).map(([key]) => this.rules[key]?.name).filter((name): name is string => Boolean(name)).sort();
    const page = this.page("ListRuleNamesByTarget", { arn, bus: bus ?? null }, names, input.Limit, input.NextToken); return { RuleNames: page.values, ...(page.nextToken ? { NextToken: page.nextToken } : {}) };
  }

  private taggedResource(arnValue: unknown): { tags: Record<string, string>; touch: () => void; managedBy?: string } {
    const arn = text(arnValue, "ResourceARN", 1, 1600); const bus = Object.values(this.buses).find(item => item.arn === arn); if (bus) return { tags: bus.tags, touch: () => { bus.lastModified = this.clock.now(); } };
    const rule = Object.values(this.rules).find(item => item.arn === arn); if (rule) return { tags: rule.tags, touch: () => { rule.lastModified = this.clock.now(); }, managedBy: rule.managedBy };
    throw new AwsError("ResourceNotFoundException", `Resource ${arn} does not exist.`);
  }

  async TagResource(input: any): Promise<any> {
    await this.ensureControl(); const resource = this.taggedResource(input.ResourceARN); if (resource.managedBy) throw new AwsError("ManagedRuleException", `The rule is managed by ${resource.managedBy}.`); const tags = tagList(input.Tags); const merged = new Set([...Object.keys(resource.tags), ...tags.map(tag => tag.Key)]); if (merged.size > 50) throw new AwsError("ValidationException", "A resource can have at most 50 tags."); for (const tag of tags) resource.tags[tag.Key] = tag.Value; resource.touch(); await this.store.save(); return {};
  }
  async UntagResource(input: any): Promise<any> {
    await this.ensureControl(); const resource = this.taggedResource(input.ResourceARN); if (resource.managedBy) throw new AwsError("ManagedRuleException", `The rule is managed by ${resource.managedBy}.`); if (!Array.isArray(input.TagKeys) || !input.TagKeys.length || input.TagKeys.length > 50) throw new AwsError("ValidationException", "TagKeys must contain between 1 and 50 keys."); for (const raw of input.TagKeys) { const key = text(raw, "TagKey", 1, 128); if (key.toLowerCase().startsWith("aws:")) throw new AwsError("ValidationException", "Tag keys beginning with aws: are reserved."); delete resource.tags[key]; } resource.touch(); await this.store.save(); return {};
  }
  async ListTagsForResource(input: any): Promise<any> { await this.ensureControl(); const resource = this.taggedResource(input.ResourceARN); return { Tags: Object.entries(resource.tags).sort(([a], [b]) => a.localeCompare(b)).map(([Key, Value]) => ({ Key, Value })) }; }

  async PutEvents(input: any, req?: IncomingMessage, options: { trustedSource?: boolean; deliveryLineage?: string[]; directRuleKey?: string; allowedRuleKeys?: Set<string>; replayName?: string; skipArchives?: boolean; integrationAttempt?: ServiceIntegrationAttempt } = {}): Promise<any> {
    if (options.integrationAttempt) { const prior = this.reconcileIntegrationAttempt(options.integrationAttempt); if (prior !== undefined) return prior; }
    await this.ensureStarted(); const startedAt = this.clock.now(); const requestBytes = Array.isArray(input.Entries) ? input.Entries.reduce((sum: number, entry: unknown) => sum + putEventsEntrySize(entry), 0) : 0;
    this.metric("PutEventsApproximateCallCount", {}, 1, "Count"); this.metric("PutEventsRequestSize", {}, requestBytes, "Bytes");
    try {
      if (requestBytes >= MAX_PUT_EVENTS_BYTES) throw new AwsError("ValidationException", "The sum of PutEvents entry sizes must be less than 1 MB.");
      if (input.EndpointId !== undefined) dependency("Global endpoint EndpointId routing", "EVB-08");
      if (!Array.isArray(input.Entries) || input.Entries.length < 1 || input.Entries.length > 10) throw new AwsError("ValidationException", "Entries must contain between 1 and 10 events.");
      if (!input.Entries.some((entry: any) => entry && entry.Source !== undefined && entry.DetailType !== undefined && entry.Detail !== undefined)) throw new AwsError("ValidationException", "At least one entry must include Source, DetailType, and Detail.");
      const results: any[] = []; let failed = 0; const authorizationErrors = ((req as any)?.awsEventBridgeEntryAuthorizationErrors ?? []) as Array<{ ErrorCode: string; ErrorMessage: string } | undefined>;
      for (const [index, raw] of input.Entries.entries()) {
        if (authorizationErrors[index]) { failed++; results.push(authorizationErrors[index]); continue; }
        try { results.push(await this.acceptEvent(raw, { ...options, integrationEntryIndex: index })); }
        catch (error) { if (options.integrationAttempt && this.stopped) throw error; failed++; const code = errorCode(error); results.push({ ErrorCode: code === "ValidationException" || code === "InvalidEventPatternException" ? "InvalidArgument" : code, ErrorMessage: errorMessage(error) }); }
      }
      this.metric("PutEventsApproximateSuccessCount", {}, 1, "Count"); this.metric("PutEventsEntriesCount", {}, input.Entries.length, "Count"); if (failed) this.metric("PutEventsFailedEntriesCount", {}, failed, "Count");
      const output = { FailedEntryCount: failed, Entries: results }; if (options.integrationAttempt) await this.deliveries.recordIntegrationAttempt(acceptedIntegrationAttempt(options.integrationAttempt, output, this.clock.now())); return output;
    } catch (error) {
      this.metric("PutEventsApproximateFailedCount", {}, 1, "Count"); throw error;
    } finally { this.metric("PutEventsLatency", {}, Math.max(0, this.clock.now() - startedAt), "Milliseconds"); }
  }

  reconcileIntegrationAttempt(attempt: ServiceIntegrationAttempt): any | undefined { const receipt = this.deliveries.integrationAttempt(attempt.attemptId); if (receipt) assertMatchingIntegrationAttempt(receipt, attempt); return receipt ? structuredClone(receipt.output) : undefined; }
  reconcileIntegrationEntryAttempt(attempt: ServiceIntegrationAttempt, index: number, input: unknown): any | undefined { const entryAttempt = this.entryIntegrationAttempt(attempt, index, input); const receipt = this.deliveries.integrationAttempt(entryAttempt.attemptId); if (receipt) assertMatchingIntegrationAttempt(receipt, entryAttempt); return receipt ? structuredClone(receipt.output) : undefined; }
  async releaseIntegrationAttempt(attemptId: string): Promise<void> { await this.deliveries.deleteIntegrationAttemptTree(attemptId); }

  async publishServiceEvent(input: { source: string; detailType: string; detail: unknown; resources?: string[]; time?: number; eventBusName?: string; roleArn?: string; requireRole?: boolean; deliveryLineage?: string[] }): Promise<{ EventId: string }> {
    await this.ensureStarted();
    const bus = this.resolveBusIdentifier(input.eventBusName, true);
    const busArn = this.buses[bus].arn;
    if (input.requireRole && !input.roleArn) throw new AwsError("AccessDeniedException", "The service publisher requires an execution role with events:PutEvents permission.", 403);
    if (input.roleArn && evaluateRoleAuthorization(this.store.ensureAccount().iam, input.roleArn, "events:PutEvents", busArn, roleSessionAuthorizationContext(input.roleArn, this.region, this.clock.now(), { "events:source": input.source, "events:detail-type": input.detailType })).decision !== "allowed") throw new AwsError("AccessDeniedException", `Execution role ${input.roleArn} cannot publish to ${busArn}.`, 403);
    const detail = stringifyEventJson(input.detail);
    const result = await this.PutEvents({ Entries: [{ Source: input.source, DetailType: input.detailType, Detail: detail, Resources: input.resources ?? [], Time: new Date(input.time ?? this.clock.now()).toISOString(), EventBusName: bus }] }, undefined, { trustedSource: true, deliveryLineage: input.deliveryLineage });
    const entry = result.Entries?.[0];
    if (!entry?.EventId) throw new AwsError(String(entry?.ErrorCode ?? "InternalFailure"), String(entry?.ErrorMessage ?? "The service event was rejected by EventBridge."), 400);
    return { EventId: entry.EventId };
  }

  hasEventBusArn(arn: string): boolean { return Object.values(this.buses).some(bus => bus.arn === arn); }

  private entryIntegrationAttempt(attempt: ServiceIntegrationAttempt, index: number, input: unknown): ServiceIntegrationAttempt { return { ...attempt, attemptId: `${attempt.attemptId}:entry:${index}`, inputDigest: integrationInputDigest(input), operation: `${attempt.operation}:entry:${index}` }; }

  private async acceptEvent(raw: unknown, options: { trustedSource?: boolean; deliveryLineage?: string[]; directRuleKey?: string; allowedRuleKeys?: Set<string>; replayName?: string; skipArchives?: boolean; integrationAttempt?: ServiceIntegrationAttempt; integrationEntryIndex?: number; preservedEnvelope?: JsonObject } = {}): Promise<{ EventId: string }> {
    const entryAttempt: ServiceIntegrationAttempt | undefined = options.integrationAttempt && options.integrationEntryIndex !== undefined ? this.entryIntegrationAttempt(options.integrationAttempt, options.integrationEntryIndex, raw) : undefined;
    if (entryAttempt) { const prior = this.deliveries.integrationAttempt(entryAttempt.attemptId); if (prior) { assertMatchingIntegrationAttempt(prior, entryAttempt); return structuredClone(prior.output) as { EventId: string }; } }
    const entry = object(raw, "PutEvents entry"); const source = text(entry.Source, "Source", 1, 256); if (!options.trustedSource && source.startsWith("aws.")) throw new AwsError("NotAuthorizedForSourceException", `Source ${source} is reserved for trusted AWS service publishers.`); const detailType = text(entry.DetailType, "DetailType", 1, 128); const detailText = text(entry.Detail, "Detail", 1, MAX_PUT_EVENTS_BYTES);
    try { JSON.parse(detailText); } catch { throw new AwsError("MalformedDetail", "Detail is not valid JSON."); }
    let detail: unknown; try { detail = parseEventJson(detailText); } catch (error) { throw new AwsError("ValidationException", errorMessage(error)); }
    object(detail, "Detail"); depthAndNumbers(detail);
    const resources = entry.Resources === undefined ? [] : Array.isArray(entry.Resources) ? entry.Resources.map((item, index) => text(item, `Resources[${index}]`, 0, 2048)) : (() => { throw new AwsError("ValidationException", "Resources must be an array."); })();
    const traceHeader = entry.TraceHeader === undefined ? undefined : text(entry.TraceHeader, "TraceHeader", 1, 500);
    const bus = this.resolveBusIdentifier(entry.EventBusName, false); const generatedId = entryAttempt ? deterministicEventId(entryAttempt.attemptId) : randomUUID();
    const envelope: JsonObject = options.preservedEnvelope
      ? { ...structuredClone(options.preservedEnvelope), ...(options.replayName ? { "replay-name": options.replayName } : {}) }
      : { version: "0", id: generatedId, "detail-type": detailType, source, account: this.store.accountId, time: eventTime(entry.Time, this.clock.now()), region: this.region, ...(options.replayName ? { "replay-name": options.replayName } : {}), resources, detail };
    const id = typeof envelope.id === "string" && envelope.id ? envelope.id : generatedId; envelope.id = id;
    if (!Object.hasOwn(this.buses, bus)) { const output = { EventId: id }; if (entryAttempt) await this.deliveries.putMany([], [], acceptedIntegrationAttempt(entryAttempt, output, this.clock.now())); return output; }
    const acceptedAt = this.clock.now();
    if (!options.skipArchives && !options.replayName) {
      const archiveNames = this.archiveStore.archives().filter(archive => archive.eventBusName === bus && archive.state === "ENABLED" && (archive.eventPattern === undefined || matchesEventPattern(parseEventPattern(archive.eventPattern), envelope))).map(archive => archive.name);
      await this.archiveStore.publish(archiveNames, stringifyEventJson(envelope), acceptedAt);
    }
    const deliveries: EventBridgeDelivery[] = []; const terminalDiagnostics: EventBridgeDeliveryDiagnostic[] = []; const matched = Object.entries(this.rules).filter(([key, rule]) => rule.eventBusName === bus && rule.state !== "DISABLED" && (!options.allowedRuleKeys || options.allowedRuleKeys.has(key)) && (key === options.directRuleKey || rule.eventPattern !== undefined && matchesEventPattern(parseEventPattern(rule.eventPattern), envelope)));
    if (matched.length) this.metric("MatchedEvents", { EventBusName: bus }, 1, "Count");
    const originalEvent = stringifyEventJson(envelope); const sourceEventTime = Date.parse(String(envelope.time));
    for (const [key, rule] of matched) {
      this.ruleMetric("MatchedEvents", rule, 1, "Count"); this.ruleMetric("TriggeredRules", rule, 1, "Count");
      for (const target of Object.values(this.targets[key] ?? {})) {
        const deliveryLineage = [...(options.deliveryLineage ?? []), rule.arn];
        if (deliveryLineage.length > MAX_DELIVERY_LINEAGE || new Set(deliveryLineage).size !== deliveryLineage.length) { this.ruleMetric("DeadLetterInvocations", rule, 1, "Count"); continue; }
        const deliveryId = randomUUID(); const targetType = target.targetType ?? classifyTargetArn(target.arn, this.region, this.store.accountId); const transformed = target.input !== undefined || target.inputPath !== undefined || target.inputTransformer !== undefined;
        let payload = "null"; let sqsMessageGroupId: string | undefined; let httpParameters: EventBridgeHttpParametersState | undefined; let preflightErrorCode: string | undefined; let preflightErrorMessage: string | undefined;
        try {
          payload = transformedPayload(target, envelope, rule, acceptedAt);
          if (Buffer.byteLength(payload) > MAX_LAMBDA_ASYNC_PAYLOAD_BYTES) throw new AwsError("ValidationException", `Transformed target input for ${target.id} exceeds the 1 MB target payload limit.`);
          if (target.sqsParameters) {
            sqsMessageGroupId = targetParameter(target.sqsParameters.messageGroupId, envelope, "SqsParameters.MessageGroupId");
            if ([...sqsMessageGroupId].length < 1 || [...sqsMessageGroupId].length > 100) throw new AwsError("ValidationException", "The resolved SqsParameters.MessageGroupId must be between 1 and 100 characters.");
          }
          httpParameters = resolvedHttpParameters(target.httpParameters, envelope);
        } catch (error) {
          const failure = safeDeliveryError(error); preflightErrorCode = failure.code; preflightErrorMessage = failure.message;
        }
        if (preflightErrorCode && !target.deadLetterArn) {
          terminalDiagnostics.push({ deliveryId, eventId: id, eventBusName: bus, ruleName: rule.name, targetId: target.id, targetArn: target.arn, status: "FAILED", attempts: 0, updatedAt: acceptedAt, errorCode: preflightErrorCode, errorMessage: preflightErrorMessage });
          continue;
        }
        deliveries.push({ id: deliveryId, eventId: id, eventBusName: bus, eventSourceName: source, ruleName: rule.name, ruleArn: rule.arn, targetId: target.id, targetArn: target.arn, targetType, ...(target.roleArn ? { roleArn: target.roleArn } : {}), ...(target.deadLetterArn ? { deadLetterArn: target.deadLetterArn } : {}), ...(sqsMessageGroupId ? { sqsMessageGroupId } : {}), ...(httpParameters ? { httpParameters } : {}), transformed, eventTime: Number.isFinite(sourceEventTime) ? sourceEventTime : acceptedAt, originalEvent, deliveryLineage, payload, ...(preflightErrorCode ? { preflightErrorCode, preflightErrorMessage } : {}), ...(traceHeader ? { traceHeader } : {}), enqueuedAt: acceptedAt, nextAttemptAt: acceptedAt, attempts: 0, maximumEventAgeSeconds: target.retryPolicy?.maximumEventAgeInSeconds ?? DEFAULT_EVENT_AGE_SECONDS, maximumRetryAttempts: target.retryPolicy?.maximumRetryAttempts ?? DEFAULT_RETRY_ATTEMPTS, status: "QUEUED" });
      }
    }
    const output = { EventId: id }; await this.deliveries.putMany(deliveries, terminalDiagnostics, entryAttempt ? acceptedIntegrationAttempt(entryAttempt, output, acceptedAt) : undefined); for (const diagnostic of terminalDiagnostics) { const rule = this.rules[this.key(bus, diagnostic.ruleName)]; if (rule) this.ruleMetric("FailedInvocations", rule, 1, "Count"); } this.scheduleNext(); return output;
  }

  private async initializeLegacySchedules(): Promise<void> {
    let dirty = false; const now = this.clock.now();
    for (const rule of Object.values(this.rules)) {
      if (!rule.scheduleExpression) continue;
      rule.scheduleCreatedAt ??= rule.createdAt;
      if (rule.scheduleNextAt === undefined && rule.state !== "DISABLED") {
        rule.scheduleNextAt = nextScheduleOccurrence({ expression: rule.scheduleExpression, timezone: "UTC", after: rule.scheduleLastCommittedAt ?? now - 1, anchor: rule.scheduleCreatedAt })?.at;
        dirty = true;
      }
    }
    if (dirty) await this.store.save();
  }

  private scheduleNextLegacyRule(): void {
    if (this.stopped || this.legacyScheduleWorkerRunning) return;
    this.cancelLegacyScheduleWorker?.(); this.cancelLegacyScheduleWorker = undefined;
    const times = Object.values(this.rules).filter(rule => rule.state !== "DISABLED" && rule.scheduleExpression && rule.scheduleNextAt !== undefined).map(rule => rule.scheduleNextAt!);
    if (!times.length) return;
    try { this.cancelLegacyScheduleWorker = this.scheduler.schedule(() => { const running = this.runLegacyScheduleWorker(); this.legacyScheduleWorkerPromise = running; return running.finally(() => { if (this.legacyScheduleWorkerPromise === running) this.legacyScheduleWorkerPromise = undefined; }); }, Math.max(0, Math.min(...times) - this.clock.now())); } catch { /* simulator shutdown */ }
  }

  private async runLegacyScheduleWorker(): Promise<void> {
    if (this.stopped || this.legacyScheduleWorkerRunning) return;
    this.legacyScheduleWorkerRunning = true; this.cancelLegacyScheduleWorker = undefined;
    try {
      const now = this.clock.now();
      const entry = Object.entries(this.rules).filter(([, rule]) => rule.state !== "DISABLED" && rule.scheduleExpression && rule.scheduleNextAt !== undefined && rule.scheduleNextAt <= now).sort(([, left], [, right]) => left.scheduleNextAt! - right.scheduleNextAt! || left.name.localeCompare(right.name))[0];
      if (!entry) return;
      const [key, rule] = entry; const scheduledAt = rule.scheduleNextAt!;
      const event = { Source: "aws.events", DetailType: "Scheduled Event", Detail: "{}", Resources: [rule.arn], Time: new Date(scheduledAt).toISOString(), EventBusName: "default" };
      const attempt: ServiceIntegrationAttempt = {
        attemptId: `legacy-schedule:${createHash("sha256").update(`${rule.arn}\0${scheduledAt}`).digest("hex")}`,
        inputDigest: integrationInputDigest(event),
        operation: "events:LegacyScheduledRule",
        targetArn: this.buses.default.arn,
        executionArn: `${rule.arn}#${scheduledAt}`,
        stateMachineArn: rule.arn,
        roleArn: "",
        sourceArn: rule.arn,
        lineage: [rule.arn],
      };
      await this.acceptEvent(event, { trustedSource: true, directRuleKey: key, integrationAttempt: attempt, integrationEntryIndex: 0 });
      rule.scheduleLastCommittedAt = scheduledAt;
      rule.scheduleNextAt = nextScheduleOccurrence({ expression: rule.scheduleExpression!, timezone: "UTC", after: Math.max(scheduledAt, now), anchor: rule.scheduleCreatedAt ?? rule.createdAt })?.at;
      await this.store.save();
      await this.releaseIntegrationAttempt(attempt.attemptId);
    } finally { this.legacyScheduleWorkerRunning = false; this.scheduleNextLegacyRule(); }
  }

  private scheduleNextReplay(): void {
    if (this.stopped || this.replayWorkerRunning) return;
    this.cancelReplayWorker?.(); this.cancelReplayWorker = undefined;
    const active = this.archiveStore.replays().filter(replay => ["STARTING", "RUNNING", "CANCELLING"].includes(replay.state)); if (!active.length) return;
    const now = this.clock.now(); const next = Math.min(...active.map(replay => replay.cancelRequested ? now : replay.leaseUntil && replay.leaseUntil > now ? replay.leaseUntil : now));
    try { this.cancelReplayWorker = this.scheduler.schedule(() => { const running = this.runReplayWorker(); this.replayWorkerPromise = running; return running.finally(() => { if (this.replayWorkerPromise === running) this.replayWorkerPromise = undefined; }); }, Math.max(0, next - now)); } catch { /* simulator shutdown */ }
  }

  private async runReplayWorker(): Promise<void> {
    if (this.stopped || this.replayWorkerRunning) return; this.replayWorkerRunning = true; this.cancelReplayWorker = undefined; let runningReplayName: string | undefined;
    try {
      const now = this.clock.now(); const candidate = this.archiveStore.replays().filter(replay => ["STARTING", "RUNNING", "CANCELLING"].includes(replay.state) && (!replay.leaseUntil || replay.leaseUntil <= now || replay.cancelRequested)).sort((left, right) => left.replayStartTime - right.replayStartTime || left.name.localeCompare(right.name))[0];
      if (!candidate) return;
      const replay = await this.archiveStore.leaseReplay(candidate.name, now, REPLAY_LEASE_MS); if (!replay?.leaseId) return; runningReplayName = replay.name;
      if (replay.cancelRequested || replay.cursor >= replay.recordIds.length) { await this.archiveStore.finishEmptyReplay(replay.name, replay.leaseId, this.clock.now()); return; }
      const serialized = await this.archiveStore.readEvent(replay.archiveName, replay.recordIds[replay.cursor]);
      if (!serialized) { await this.archiveStore.failReplay(replay.name, "An archived event segment required by this replay is unavailable.", this.clock.now()); return; }
      const archived = object(parseEventJson(serialized), "Archived event"); const bus = this.archiveStore.archive(replay.archiveName)?.eventBusName; if (!bus) { await this.archiveStore.failReplay(replay.name, "The replay source archive is unavailable.", this.clock.now()); return; }
      const selectedArns = replay.filterArns ? new Set(replay.filterArns) : undefined; const allowedRuleKeys = new Set(Object.entries(this.rules).filter(([, rule]) => rule.eventBusName === bus && (!selectedArns || selectedArns.has(rule.arn))).map(([key]) => key));
      await this.acceptEvent({ EventBusName: bus, Source: archived.source, DetailType: archived["detail-type"], Detail: stringifyEventJson(archived.detail), Resources: archived.resources, Time: archived.time }, { trustedSource: true, allowedRuleKeys, replayName: replay.name, skipArchives: true, preservedEnvelope: archived });
      try { await this.archiveStore.checkpointReplay(replay.name, replay.leaseId, Date.parse(String(archived.time)), this.clock.now()); }
      catch { return; /* lease expiry/restart repeats an ambiguous admitted event */ }
    } catch (error) {
      if (runningReplayName) await this.archiveStore.failReplay(runningReplayName, `Local replay failed before its checkpoint (${error instanceof Error ? error.name : "InternalFailure"}).`, this.clock.now()).catch(() => undefined);
    } finally { this.replayWorkerRunning = false; this.scheduleNextReplay(); }
  }

  deliveryDiagnostics(): any {
    const active = this.deliveries.list().sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.id.localeCompare(b.id)); const diagnostics = this.deliveries.diagnostics().sort((a, b) => b.updatedAt - a.updatedAt);
    const retryCount = (item: EventBridgeDeliveryDiagnostic): number => item.status === "RETRYING" ? item.attempts : Math.max(0, item.attempts - 1);
    const diagnosticView = (item: EventBridgeDeliveryDiagnostic) => ({ ...item, retries: retryCount(item), ...(item.errorCode ? { errorMessage: item.status === "RETRYING" ? `Target delivery will be retried (${item.errorCode}).` : `Target delivery failed (${item.errorCode}).` } : {}) });
    const targets = new Map<string, { eventBusName: string; ruleName: string; targetId: string; targetArn: string; lastStatus: string; lastUpdatedAt: number; attempts: number; retries: number; successes: number; failures: number; dlqSent: number; dlqFailed: number }>();
    for (const item of [...diagnostics].reverse()) {
      const key = `${item.eventBusName}\0${item.ruleName}\0${item.targetId}`; const current = targets.get(key) ?? { eventBusName: item.eventBusName, ruleName: item.ruleName, targetId: item.targetId, targetArn: item.targetArn, lastStatus: item.status, lastUpdatedAt: item.updatedAt, attempts: 0, retries: 0, successes: 0, failures: 0, dlqSent: 0, dlqFailed: 0 };
      current.lastStatus = item.status; current.lastUpdatedAt = item.updatedAt; current.attempts = Math.max(current.attempts, item.attempts); current.retries += retryCount(item); if (item.status === "SUCCEEDED") current.successes++; if (item.status === "FAILED") current.failures++; if (item.deadLetterStatus === "SENT") current.dlqSent++; if (item.deadLetterStatus === "FAILED") current.dlqFailed++; targets.set(key, current);
    }
    return { queued: active.filter(item => item.status === "QUEUED").length, leased: active.filter(item => item.status === "LEASED").length, retrying: active.filter(item => item.attempts > 0).length, failed: diagnostics.filter(item => item.status === "FAILED").length, dlqSent: diagnostics.filter(item => item.deadLetterStatus === "SENT").length, dlqFailed: diagnostics.filter(item => item.deadLetterStatus === "FAILED").length, deliveries: active.map(item => ({ deliveryId: item.id, eventId: item.eventId, eventBusName: item.eventBusName, ruleName: item.ruleName, targetId: item.targetId, targetArn: item.targetArn, targetType: item.targetType ?? "lambda", status: item.status, attempts: item.attempts, enqueuedAt: item.enqueuedAt, nextAttemptAt: item.nextAttemptAt, ...(item.deadLetterArn ? { deadLetterArn: item.deadLetterArn } : {}), ...(item.lastError ? { lastError: `Target delivery will be retried (${item.lastError.split(":", 1)[0]}).` } : {}) })), targets: [...targets.values()].sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt || left.ruleName.localeCompare(right.ruleName) || left.targetId.localeCompare(right.targetId)), diagnostics: diagnostics.map(diagnosticView) };
  }

  private scheduleNext(): void {
    if (this.stopped || this.workerRunning) return; this.cancelWorker?.(); this.cancelWorker = undefined; const jobs = this.deliveries.list(); if (!jobs.length) return;
    const next = Math.min(...jobs.map(job => Math.min(job.enqueuedAt + job.maximumEventAgeSeconds * 1000, job.status === "LEASED" ? job.leaseUntil ?? this.clock.now() : job.nextAttemptAt)));
    try { this.cancelWorker = this.scheduler.schedule(() => { const running = this.runWorker(); this.workerPromise = running; return running.finally(() => { if (this.workerPromise === running) this.workerPromise = undefined; }); }, Math.max(0, next - this.clock.now())); } catch { /* simulator shutdown */ }
  }

  private async runWorker(): Promise<void> {
    if (this.stopped || this.workerRunning) return; this.workerRunning = true; this.cancelWorker = undefined;
    try {
      const now = this.clock.now(); const jobs = this.deliveries.list().sort((a, b) => (a.status === "LEASED" ? a.leaseUntil ?? 0 : a.nextAttemptAt) - (b.status === "LEASED" ? b.leaseUntil ?? 0 : b.nextAttemptAt) || a.id.localeCompare(b.id));
      let job = jobs.find(item => now - item.enqueuedAt >= item.maximumEventAgeSeconds * 1000);
      job ??= jobs.find(item => item.status === "QUEUED" && item.nextAttemptAt <= now);
      if (!job) {
        const expired = jobs.find(item => item.status === "LEASED" && (item.leaseUntil ?? 0) <= now);
        if (expired) { expired.status = "QUEUED"; delete expired.leaseId; delete expired.leaseUntil; await this.deliveries.put(expired); job = expired; }
      }
      if (job) await this.attempt(job);
    } finally { this.workerRunning = false; this.scheduleNext(); }
  }

  private async dispatch(job: EventBridgeDelivery): Promise<void> {
    if (job.preflightErrorCode) throw new AwsError(job.preflightErrorCode, job.preflightErrorMessage ?? "Target input preparation failed.");
    if (job.roleArn) this.executionRole(job.roleArn, true, job.ruleArn);
    const targetType = job.targetType ?? classifyTargetArn(job.targetArn, this.region, this.store.accountId);
    const payload = typeof job.payload === "string" ? job.payload : JSON.stringify(job.payload);
    if (targetType === "lambda") {
      await this.lambda.enqueueEventBridgeInvocation(job.targetArn, Buffer.from(payload), job.ruleArn, job.roleArn, job.deliveryLineage ?? [job.ruleArn]);
      return;
    }
    if (targetType === "sns") {
      if (!this.sns) throw new AwsError("InternalFailure", "The policy-aware SNS target adapter is unavailable.", 500);
      const identityAuthorization: AuthorizationResult | undefined = job.roleArn
        ? evaluateRoleAuthorization(this.store.ensureAccount().iam, job.roleArn, "sns:Publish", job.targetArn, roleSessionAuthorizationContext(job.roleArn, this.region, this.clock.now(), { "aws:SourceArn": job.ruleArn, "aws:SourceAccount": this.store.accountId }))
        : undefined;
      if (identityAuthorization && identityAuthorization.decision !== "allowed") throw new AwsError("AccessDeniedException", `EventBridge execution role ${job.roleArn} cannot publish to ${job.targetArn}.`, 403);
      await this.sns.publishAuthorized({ TopicArn: job.targetArn, Message: payload }, {
        principal: job.roleArn ?? "events.amazonaws.com",
        sourceArn: job.ruleArn,
        sourceAccount: this.store.accountId,
        identityAuthorization,
        lineage: job.deliveryLineage,
      });
      return;
    }
    if (targetType === "sqs") {
      if (!this.sqs) throw new AwsError("InternalFailure", "The policy-aware SQS target adapter is unavailable.", 500);
      await this.sqs.sendAuthorizedMessageToArn(job.targetArn, {
        MessageBody: payload,
        ...(job.sqsMessageGroupId ? { MessageGroupId: job.sqsMessageGroupId } : {}),
      }, job.roleArn
        ? { kind: "role", roleArn: job.roleArn, sourceArn: job.ruleArn, sourceAccount: this.store.accountId, deliveryLineage: job.deliveryLineage }
        : { kind: "service", principal: "events.amazonaws.com", sourceArn: job.ruleArn, sourceAccount: this.store.accountId, deliveryLineage: job.deliveryLineage });
      return;
    }
    if (targetType === "logs") {
      if (!this.logs) throw new AwsError("InternalFailure", "The CloudWatch Logs target adapter is unavailable.", 500);
      await this.logs.deliverEventBridgeTarget(job.targetArn, { ruleArn: job.ruleArn, payload, eventTime: job.eventTime ?? job.enqueuedAt, transformed: job.transformed === true, deliveryLineage: job.deliveryLineage });
      return;
    }
    if (targetType === "states") {
      if (!this.stepFunctions || !job.roleArn) throw new AwsError("InternalFailure", "The Step Functions target adapter or role is unavailable.", 500);
      await this.stepFunctions.startExecutionFromProducer({ stateMachineArn: job.targetArn, input: payload, name: `events-${createHash("sha256").update(job.id).digest("hex").slice(0, 48)}`, roleArn: job.roleArn, sourceArn: job.ruleArn, deliveryLineage: job.deliveryLineage, ...(job.traceHeader ? { traceHeader: job.traceHeader } : {}) }); return;
    }
    if (!this.apiGateway) throw new AwsError("InternalFailure", "The API Gateway target adapter is unavailable.", 500);
    const response = await this.apiGateway.invokeEventBridgeTarget({ targetArn: job.targetArn, payload, ruleArn: job.ruleArn, roleArn: job.roleArn, pathParameterValues: job.httpParameters?.pathParameterValues, queryStringParameters: job.httpParameters?.queryStringParameters, headerParameters: job.httpParameters?.headerParameters, deliveryLineage: job.deliveryLineage });
    if (response.statusCode === 429) throw new AwsError("ThrottlingException", "API Gateway returned HTTP 429 for the EventBridge target.", 429);
    if (response.statusCode >= 500) throw new AwsError("InternalFailure", `API Gateway returned HTTP ${response.statusCode} for the EventBridge target.`, response.statusCode);
    if (response.statusCode >= 400) throw new AwsError("TargetResponseException", `API Gateway returned non-retryable HTTP ${response.statusCode} for the EventBridge target.`, response.statusCode);
  }

  private async sendToDeadLetterQueue(job: EventBridgeDelivery, error: unknown, exhaustedCondition?: "MaximumRetryAttempts" | "MaximumEventAgeInSeconds"): Promise<"SENT" | "FAILED" | undefined> {
    if (!job.deadLetterArn) return undefined;
    const rule = { name: job.ruleName, eventBusName: job.eventBusName } as EventBridgeRuleState;
    try {
      if (!this.sqs) throw new AwsError("InternalFailure", "The policy-aware SQS dead-letter adapter is unavailable.", 500);
      const failure = safeDeliveryError(error);
      const attributes: Record<string, { DataType: string; StringValue: string }> = {
        RULE_ARN: { DataType: "String", StringValue: job.ruleArn },
        TARGET_ARN: { DataType: "String", StringValue: job.targetArn },
        ERROR_CODE: { DataType: "String", StringValue: deadLetterErrorCode(error) },
        ERROR_MESSAGE: { DataType: "String", StringValue: failure.message.slice(0, 1_024) },
        RETRY_ATTEMPTS: { DataType: "String", StringValue: String(Math.max(0, job.attempts - 1)) },
        ...(exhaustedCondition ? { EXHAUSTED_RETRY_CONDITION: { DataType: "String", StringValue: exhaustedCondition } } : {}),
      };
      if (!attributes.EXHAUSTED_RETRY_CONDITION) attributes.EXHAUSTED_RETRY_CONDITION = { DataType: "String", StringValue: "MaximumRetryAttempts" };
      await this.sqs.sendAuthorizedMessageToArn(job.deadLetterArn, { MessageBody: job.originalEvent ?? job.payload, MessageAttributes: attributes }, { kind: "service", principal: "events.amazonaws.com", sourceArn: job.ruleArn, sourceAccount: this.store.accountId, deliveryLineage: job.deliveryLineage });
      this.dlqMetric("InvocationsSentToDlq", rule);
      return "SENT";
    } catch {
      this.dlqMetric("InvocationsFailedToBeSentToDlq", rule);
      return "FAILED";
    }
  }

  private async terminalFailure(job: EventBridgeDelivery, error: unknown, exhaustedCondition?: "MaximumRetryAttempts" | "MaximumEventAgeInSeconds"): Promise<void> {
    const now = this.clock.now(); const rule = { name: job.ruleName, eventBusName: job.eventBusName } as EventBridgeRuleState; const failure = safeDeliveryError(error); const deadLetterStatus = await this.sendToDeadLetterQueue(job, error, exhaustedCondition);
    this.ruleMetric("Invocations", rule, 1, "Count"); this.ruleMetric("FailedInvocations", rule, 1, "Count");
    await this.deliveries.record({ deliveryId: job.id, eventId: job.eventId, eventBusName: job.eventBusName, ruleName: job.ruleName, targetId: job.targetId, targetArn: job.targetArn, status: "FAILED", attempts: job.attempts, updatedAt: now, errorCode: failure.code, errorMessage: failure.message, ...(job.deadLetterArn ? { deadLetterArn: job.deadLetterArn, deadLetterStatus: deadLetterStatus ?? "FAILED" } : {}) });
    await this.deliveries.delete(job.id);
  }

  private async attempt(job: EventBridgeDelivery): Promise<void> {
    const startedAt = this.clock.now(); const rule = { name: job.ruleName, eventBusName: job.eventBusName } as EventBridgeRuleState;
    if (startedAt - job.enqueuedAt >= job.maximumEventAgeSeconds * 1000) {
      await this.terminalFailure(job, new AwsError("MaximumEventAgeExceeded", "The event exceeded the target maximum event age before delivery."), "MaximumEventAgeInSeconds"); return;
    }
    job.status = "LEASED"; job.leaseId = randomUUID(); job.leaseUntil = startedAt + LEASE_MS; job.attempts++; await this.deliveries.put(job);
    this.ruleMetric("InvocationAttempts", rule, 1, "Count"); if (job.attempts > 1) this.ruleMetric("RetryInvocationAttempts", rule, 1, "Count"); if (job.attempts === 1) this.ruleMetric("IngestiontoInvocationStartLatency", rule, Math.max(0, startedAt - job.enqueuedAt), "Milliseconds");
    try {
      await this.dispatch(job);
      const completedAt = this.clock.now(); this.ruleMetric("Invocations", rule, 1, "Count"); this.ruleMetric("SuccessfulInvocationAttempts", rule, 1, "Count"); this.ruleMetric("IngestionToInvocationSuccessLatency", rule, Math.max(0, completedAt - job.enqueuedAt), "Milliseconds");
      await this.deliveries.record({ deliveryId: job.id, eventId: job.eventId, eventBusName: job.eventBusName, ruleName: job.ruleName, targetId: job.targetId, targetArn: job.targetArn, status: "SUCCEEDED", attempts: job.attempts, updatedAt: completedAt }); await this.deliveries.delete(job.id);
    } catch (error) {
      const now = this.clock.now(); const ageExpired = now - job.enqueuedAt >= job.maximumEventAgeSeconds * 1000; const retriesExhausted = job.attempts > job.maximumRetryAttempts; const terminal = !retryable(error) || ageExpired || retriesExhausted; const failure = safeDeliveryError(error); const code = failure.code; const message = failure.message;
      if (terminal) {
        await this.terminalFailure(job, error, ageExpired ? "MaximumEventAgeInSeconds" : retriesExhausted ? "MaximumRetryAttempts" : undefined);
      } else {
        job.status = "QUEUED"; delete job.leaseId; delete job.leaseUntil; job.lastError = `${code}: ${message}`; job.nextAttemptAt = now + this.retryDelay(job.id, job.attempts); await this.deliveries.put(job); await this.deliveries.record({ deliveryId: job.id, eventId: job.eventId, eventBusName: job.eventBusName, ruleName: job.ruleName, targetId: job.targetId, targetArn: job.targetArn, status: "RETRYING", attempts: job.attempts, updatedAt: now, nextAttemptAt: job.nextAttemptAt, errorCode: code, errorMessage: message });
      }
    } finally { if (job.attempts === 1) this.ruleMetric("IngestiontoInvocationCompleteLatency", rule, Math.max(0, this.clock.now() - job.enqueuedAt), "Milliseconds"); }
  }

  private retryDelay(id: string, attempt: number): number {
    const base = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(18, Math.max(0, attempt - 1))); const digest = createHash("sha256").update(`${id}:${attempt}`).digest(); const jitter = 0.5 + digest.readUInt32BE(0) / 0xffffffff; return Math.max(1, Math.round(base * jitter));
  }

  private metric(metricName: string, dimensions: Record<string, string>, value: number, unit: string): void { const pending = this.telemetry.publish({ namespace: "AWS/Events", metricName, dimensions, value, unit, timestamp: this.clock.now() }).catch(() => undefined); this.pendingTelemetry.add(pending); void pending.finally(() => this.pendingTelemetry.delete(pending)); }
  private dlqMetric(metricName: "InvocationsSentToDlq" | "InvocationsFailedToBeSentToDlq", rule: Pick<EventBridgeRuleState, "name">): void { this.metric(metricName, { RuleName: rule.name }, 1, "Count"); }
  private ruleMetric(metricName: string, rule: Pick<EventBridgeRuleState, "name" | "eventBusName">, value: number, unit: string): void {
    this.metric(metricName, rule.eventBusName === "default" ? { RuleName: rule.name } : { EventBusName: rule.eventBusName, RuleName: rule.name }, value, unit);
    if (new Set(["TriggeredRules", "Invocations", "InvocationAttempts", "SuccessfulInvocationAttempts", "RetryInvocationAttempts", "IngestiontoInvocationStartLatency", "IngestiontoInvocationCompleteLatency", "IngestionToInvocationSuccessLatency"]).has(metricName)) this.metric(metricName, {}, value, unit);
    if (new Set(["TriggeredRules", "InvocationAttempts", "SuccessfulInvocationAttempts", "RetryInvocationAttempts", "IngestiontoInvocationStartLatency", "IngestiontoInvocationCompleteLatency", "IngestionToInvocationSuccessLatency"]).has(metricName)) this.metric(metricName, { EventBusName: rule.eventBusName }, value, unit);
  }
}
