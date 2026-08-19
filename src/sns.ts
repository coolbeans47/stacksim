import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PrincipalContext } from "./auth/sigv4.js";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import type { Scheduler } from "./core/scheduler.js";
import type { TelemetryBus } from "./core/telemetry.js";
import { AwsError } from "./errors.js";
import { combineIdentityAndResourceAuthorization, evaluateResourcePolicy, evaluateRoleAuthorization, evaluateTrust, type AuthorizationResult } from "./iam/evaluator.js";
import { awsQueryErrorXml, awsQueryList, awsQueryMap, parseAwsQuery, sendAwsQueryXml } from "./protocols/query-xml.js";
import type { StateStore } from "./state.js";
import type { SnsMessageAttributeState, SnsSubscriptionState, SnsTopicState } from "./types.js";
import { json, readBody } from "./util.js";
import { SnsSigner, type SnsNotificationFields } from "./sns/signing.js";
import { filterMatchResult, validateFilterPolicy } from "./sns/filter.js";
import {
  SnsDeliveryStorage,
  type SnsDeliveryData,
  type SnsDeliveryIntent,
  type SnsStoredMessage,
} from "./sns/storage.js";
import { SNS_02_IMPLEMENTED_ACTIONS } from "./sns/action-inventory.js";
import { acceptedIntegrationAttempt, assertMatchingIntegrationAttempt, type ServiceIntegrationAttempt } from "./step-functions/integration-attempt.js";

const SNS_NAMESPACE = "https://sns.amazonaws.com/doc/2010-03-31/";
const SNS_VERSION = "2010-03-31";
const MAX_MESSAGE_BYTES = 262_144;
const MAX_QUERY_BYTES = 1_048_576;
const DEFAULT_MAX_TOPICS = 100_000;
const DEFAULT_MAX_SUBSCRIPTIONS = 100_000;
const DEFAULT_MAX_DELIVERY_MESSAGES = 10_000;
const DEFAULT_DELIVERY_RETENTION_MS = 24 * 60 * 60_000;
const LEASE_MS = 30_000;
const MANAGED_DELIVERY_ATTEMPTS = 100_015;

export const SNS_02_ACTIONS = new Set(SNS_02_IMPLEMENTED_ACTIONS);
/** Compatibility alias for callers compiled against the SNS-01 export. */
export const SNS_01_ACTIONS = SNS_02_ACTIONS;

interface SqsPort {
  resolveQueueArn(arn: string): { fifo: boolean; ownerAccountId: string };
  sendAuthorizedMessageToArn(
    arn: string,
    input: {
      MessageBody: string;
      MessageGroupId?: string;
      MessageAttributes?: Record<string, { DataType: string; StringValue?: string; BinaryValue?: Uint8Array }>;
    },
    caller: { kind: "service"; principal: string; sourceArn: string; sourceAccount: string; deliveryLineage?: string[] },
  ): Promise<unknown>;
}

interface LambdaPort {
  assertFunctionExists(nameOrArn: string): void;
  enqueueServiceInvocation(nameOrArn: string, payload: Buffer, principal: string, sourceArn: string, sourceAccount: string, lineage?: string[]): Promise<string>;
}

interface LogsPort {
  deliverServiceEvents(
    input: { logGroupName: string; logStreamName: string; logEvents: Array<{ timestamp: number; message: string }> },
    authorize: (action: "logs:CreateLogGroup" | "logs:CreateLogStream" | "logs:PutLogEvents", resource: string) => boolean,
    options?: { deliveryLineage?: string[] },
  ): Promise<boolean>;
}

export interface SnsCapacityOptions {
  maximumTopics?: number;
  maximumSubscriptions?: number;
  maximumDeliveryMessages?: number;
  deliveryRetentionMs?: number;
}

interface PageCursor { after: string; revision: number }

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function topicName(value: unknown): string {
  const name = String(value ?? "");
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(name)) {
    if (name.endsWith(".fifo")) throw new AwsError("InvalidParameter", "FIFO topics are not available until SNS-04.", 400);
    throw new AwsError("InvalidParameter", "Topic Name must be 1 to 256 characters containing only letters, numbers, hyphens, and underscores.", 400);
  }
  return name;
}

function tags(value: unknown): Record<string, string> {
  const entries = Array.isArray(value)
    ? value.map(item => [String(item?.Key ?? ""), String(item?.Value ?? "")] as const)
    : value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item ?? "")] as const)
      : [];
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!key || key.length > 128 || item.length > 256 || key.toLowerCase().startsWith("aws:") || !/^[A-Za-z0-9 +\-=._:/@]*$/.test(key) || !/^[A-Za-z0-9 +\-=._:/@]*$/.test(item)) {
      throw new AwsError("InvalidParameter", `Invalid tag key or value: ${key || "(empty)"}`, 400);
    }
    if (Object.hasOwn(result, key)) throw new AwsError("InvalidParameter", `Duplicate tag key ${key}`, 400);
    result[key] = item;
  }
  if (Object.keys(result).length > 50) throw new AwsError("TagLimitExceeded", "A topic can have at most 50 tags.", 400);
  return result;
}

function createTopicAttributes(value: unknown): { displayName?: string } {
  const source: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      const key = String(entry?.key ?? entry?.Name ?? "");
      if (!key || Object.hasOwn(source, key)) throw new AwsError("InvalidParameter", `Topic attribute ${key || "(empty)"} is invalid or duplicated.`, 400);
      source[key] = String(entry?.value ?? entry?.Value ?? "");
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) source[key] = String(item ?? "");
  }
  const allowed = new Set([
    "DisplayName", "FifoTopic", "Policy", "SignatureVersion",
    "SQSSuccessFeedbackRoleArn", "SQSSuccessFeedbackSampleRate", "SQSFailureFeedbackRoleArn",
    "LambdaSuccessFeedbackRoleArn", "LambdaSuccessFeedbackSampleRate", "LambdaFailureFeedbackRoleArn",
  ]);
  const unsupported = Object.keys(source).find(key => !allowed.has(key));
  if (unsupported) {
    if (["DeliveryPolicy", "KmsMasterKeyId", "TracingConfig", "ArchivePolicy", "ContentBasedDeduplication", "FifoThroughputScope"].includes(unsupported)) {
      throw new AwsError("InvalidParameter", `Topic attribute ${unsupported} requires a later SNS phase and was not applied.`, 400);
    }
    throw new AwsError("InvalidParameter", `Topic attribute ${unsupported} is unsupported.`, 400);
  }
  if (source.FifoTopic !== undefined && source.FifoTopic !== "false") throw new AwsError("InvalidParameter", "FIFO topics are not available until SNS-04.", 400);
  if (source.DisplayName !== undefined) displayName(source.DisplayName);
  return source as any;
}

function stringMap(value: unknown, label: string): Record<string, string> {
  const source: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      const key = String(entry?.key ?? entry?.Name ?? "");
      if (!key || Object.hasOwn(source, key)) throw new AwsError("InvalidParameter", `${label} ${key || "(empty)"} is invalid or duplicated.`, 400);
      source[key] = String(entry?.value ?? entry?.Value ?? "");
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (Object.hasOwn(source, key)) throw new AwsError("InvalidParameter", `${label} ${key} is duplicated.`, 400);
      source[key] = String(item ?? "");
    }
  }
  return source;
}

function displayName(value: string): string {
  if ([...value].length > 100 || !validUnicode(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new AwsError("InvalidParameter", "DisplayName must be valid UTF-8 text of at most 100 characters without control characters.", 400);
  }
  return value;
}

function feedbackRole(value: string, accountId: string): string | undefined {
  if (value === "") return undefined;
  if (!new RegExp(`^arn:aws:iam::${accountId}:role\\/[A-Za-z0-9+=,.@_\\/-]{1,512}$`).test(value)) {
    throw new AwsError("InvalidParameter", "Delivery feedback roles must be IAM role ARNs in this simulator account.", 400);
  }
  return value;
}

function sampleRate(value: string): number {
  if (!/^(?:0|[1-9]\d?|100)$/.test(value)) throw new AwsError("InvalidParameter", "Success feedback sample rates must be integers from 0 through 100.", 400);
  return Number(value);
}

function normalizePolicy(input: unknown, topicArn: string): string {
  const source = String(input ?? "");
  if (!source || Buffer.byteLength(source) > 30_720) throw new AwsError("InvalidParameter", "Policy must be a non-empty JSON document no larger than 30720 bytes.", 400);
  let document: any;
  try { document = JSON.parse(source); } catch { throw new AwsError("InvalidParameter", "Policy must be valid JSON.", 400); }
  if (!document || typeof document !== "object" || Array.isArray(document) || !["2008-10-17", "2012-10-17"].includes(document.Version) || !document.Statement) {
    throw new AwsError("InvalidParameter", "Policy must contain a supported Version and Statement.", 400);
  }
  const statements = asArray<any>(document.Statement);
  if (!statements.length) throw new AwsError("InvalidParameter", "Policy must contain at least one statement.", 400);
  for (const statement of statements) {
    if (!statement || typeof statement !== "object" || !["Allow", "Deny"].includes(statement.Effect)
      || statement.Principal === undefined || statement.Action === undefined || statement.Resource === undefined) {
      throw new AwsError("InvalidParameter", "Each topic-policy statement must contain Effect, Principal, Action, and Resource.", 400);
    }
    const actions = asArray(statement.Action).map(String);
    if (!actions.length || actions.some(action => !/^sns:[A-Za-z*?]+$/i.test(action))) throw new AwsError("InvalidParameter", "Topic policies may contain only SNS actions.", 400);
    const resources = asArray(statement.Resource).map(String);
    if (resources.some(resource => resource !== topicArn && resource !== "*")) throw new AwsError("InvalidParameter", "Topic-policy resources must be this topic ARN or '*'.", 400);
    if (statement.Condition !== undefined && (!statement.Condition || typeof statement.Condition !== "object" || Array.isArray(statement.Condition))) {
      throw new AwsError("InvalidParameter", "Policy Condition must be an object.", 400);
    }
  }
  return JSON.stringify(document);
}

function rejectsOwnerMutation(policy: string, owner: string, topicArn: string): boolean {
  const document = JSON.parse(policy);
  return asArray<any>(document.Statement).some(statement => {
    if (statement.Effect !== "Deny") return false;
    const principals = statement.Principal === "*" ? ["*"] : asArray(statement.Principal?.AWS).map(String);
    const actions = asArray(statement.Action).map((item: unknown) => String(item).toLowerCase());
    const resources = asArray(statement.Resource).map(String);
    return (principals.includes("*") || principals.includes(`arn:aws:iam::${owner}:root`))
      && (resources.includes("*") || resources.includes(topicArn))
      && actions.some(action => action === "sns:*" || ["sns:settopicattributes", "sns:addpermission", "sns:removepermission"].includes(action));
  });
}

function redrivePolicy(value: string, sqs: SqsPort, region: string, accountId: string): string | undefined {
  if (value === "") return undefined;
  let parsed: any;
  try { parsed = JSON.parse(value); } catch { throw new AwsError("InvalidParameter", "RedrivePolicy must be valid JSON.", 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.deadLetterTargetArn !== "string") {
    throw new AwsError("InvalidParameter", "RedrivePolicy must contain only deadLetterTargetArn.", 400);
  }
  if (!new RegExp(`^arn:aws:sqs:${region}:${accountId}:[A-Za-z0-9_-]{1,80}$`).test(parsed.deadLetterTargetArn)) {
    throw new AwsError("InvalidParameter", "The SNS dead-letter queue must be in this simulator account and Region.", 400);
  }
  const queue = sqs.resolveQueueArn(parsed.deadLetterTargetArn);
  if (queue.fifo) throw new AwsError("InvalidParameter", "SNS subscription dead-letter queues must be Standard SQS queues.", 400);
  return JSON.stringify({ deadLetterTargetArn: parsed.deadLetterTargetArn });
}

function attributeEntries(value: unknown): Array<{ Name?: unknown; Value?: any; key?: unknown; value?: any }> {
  return asArray(value as any).filter(item => item && typeof item === "object");
}

function normalizeMessageAttributes(value: unknown): Record<string, SnsMessageAttributeState> {
  const source: Record<string, any> = {};
  if (Array.isArray(value)) {
    for (const entry of attributeEntries(value)) {
      const name = String(entry.Name ?? entry.key ?? "");
      if (!name || Object.hasOwn(source, name)) throw new AwsError("InvalidParameter", `Message attribute name ${name || "(empty)"} is invalid or duplicated.`, 400);
      source[name] = entry.Value ?? entry.value;
    }
  } else if (value && typeof value === "object") Object.assign(source, value);
  const result: Record<string, SnsMessageAttributeState> = {};
  for (const [name, raw] of Object.entries(source)) {
    if (!/^[A-Za-z0-9_.-]{1,256}$/.test(name) || name.startsWith(".") || name.endsWith(".") || name.includes("..") || /^(AWS|Amazon)\./i.test(name)) throw new AwsError("InvalidParameter", `Message attribute name ${name} is invalid.`, 400);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AwsError("InvalidParameter", `Message attribute ${name} is invalid.`, 400);
    const dataType = String((raw as any).DataType ?? "");
    const base = dataType.split(".", 1)[0];
    if (!dataType || dataType.length > 256 || !["String", "String.Array", "Number", "Binary"].includes(base === "String" && dataType === "String.Array" ? dataType : base)) throw new AwsError("InvalidParameter", `Message attribute ${name} has an invalid DataType.`, 400);
    if (base === "Binary") {
      if ((raw as any).BinaryValue === undefined || (raw as any).StringValue !== undefined) throw new AwsError("InvalidParameter", `Message attribute ${name} must contain BinaryValue.`, 400);
      const supplied = (raw as any).BinaryValue;
      let bytes: Buffer;
      if (supplied instanceof Uint8Array) bytes = Buffer.from(supplied);
      else {
        const encoded = String(supplied);
        bytes = Buffer.from(encoded, "base64");
        if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) throw new AwsError("InvalidParameter", `Message attribute ${name} has invalid base64 data.`, 400);
      }
      if (!bytes.length) throw new AwsError("InvalidParameter", `Message attribute ${name} may not be empty.`, 400);
      result[name] = { dataType, binaryValueBase64: bytes.toString("base64") };
    } else {
      if ((raw as any).StringValue === undefined || (raw as any).BinaryValue !== undefined) throw new AwsError("InvalidParameter", `Message attribute ${name} must contain StringValue.`, 400);
      let stringValue = String((raw as any).StringValue);
      if (!stringValue || !validUnicode(stringValue)) throw new AwsError("InvalidParameter", `Message attribute ${name} has an invalid or empty value.`, 400);
      if (base === "Number") {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(stringValue) || !Number.isFinite(Number(stringValue))) throw new AwsError("InvalidParameter", `Message attribute ${name} is not a valid number.`, 400);
        stringValue = String(Number(stringValue));
      }
      if (dataType === "String.Array") {
        let parsed: unknown;
        try { parsed = JSON.parse(stringValue); } catch { throw new AwsError("InvalidParameter", `Message attribute ${name} must contain a valid JSON array.`, 400); }
        if (!Array.isArray(parsed)) throw new AwsError("InvalidParameter", `Message attribute ${name} must contain a valid JSON array.`, 400);
      }
      result[name] = { dataType, stringValue };
    }
  }
  return result;
}

function messageAttributeBytes(attributes: Record<string, SnsMessageAttributeState>): number {
  return Object.entries(attributes).reduce((total, [name, value]) =>
    total + Buffer.byteLength(name) + Buffer.byteLength(value.dataType)
    + (value.binaryValueBase64 === undefined ? Buffer.byteLength(value.stringValue ?? "") : Buffer.from(value.binaryValueBase64, "base64").length), 0);
}

function unvalidatedMessageAttributeBytes(value: unknown): number {
  const source: Record<string, any> = {};
  if (Array.isArray(value)) {
    for (const entry of attributeEntries(value)) source[String(entry.Name ?? entry.key ?? "")] = entry.Value ?? entry.value;
  } else if (value && typeof value === "object") Object.assign(source, value);
  return Object.entries(source).reduce((total, [name, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return total + Buffer.byteLength(name) + Buffer.byteLength(String(raw ?? ""));
    const binary = (raw as any).BinaryValue;
    let binaryBytes = 0;
    if (binary instanceof Uint8Array) binaryBytes = binary.byteLength;
    else if (binary !== undefined) {
      const encoded = String(binary);
      const decoded = Buffer.from(encoded, "base64");
      binaryBytes = decoded.toString("base64").replace(/=+$/, "") === encoded.replace(/=+$/, "")
        ? decoded.length
        : Buffer.byteLength(encoded);
    }
    return total + Buffer.byteLength(name)
      + Buffer.byteLength(String((raw as any).DataType ?? ""))
      + Buffer.byteLength(String((raw as any).StringValue ?? ""))
      + binaryBytes;
  }, 0);
}

function topLevelJsonKeys(source: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let string = false;
  let escape = false;
  let tokenStart = -1;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (string) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === "\"") {
        string = false;
        if (depth === 1) {
          let following = index + 1;
          while (/\s/.test(source[following] ?? "")) following++;
          if (source[following] === ":") {
            try { keys.push(JSON.parse(source.slice(tokenStart, index + 1))); } catch {}
          }
        }
      }
      continue;
    }
    if (char === "\"") { string = true; tokenStart = index; }
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
  return keys;
}

function structuredMessages(message: string, structure: unknown): Record<string, string> | undefined {
  if (structure === undefined || structure === "") return undefined;
  if (String(structure) !== "json") throw new AwsError("InvalidParameter", "MessageStructure must be json.", 400);
  let parsed: unknown;
  try { parsed = JSON.parse(message); } catch { throw new AwsError("InvalidParameter", "Message is not valid JSON.", 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as any).default !== "string") throw new AwsError("InvalidParameter", "MessageStructure json requires an object containing a string default value.", 400);
  const keys = topLevelJsonKeys(message);
  if (new Set(keys).size !== keys.length) throw new AwsError("InvalidParameter", "MessageStructure json does not allow duplicate keys.", 400);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) if (typeof value === "string" && new Set(["default", "sqs", "lambda"]).has(key)) result[key] = value;
  return result;
}

function notificationAttributes(attributes: Record<string, SnsMessageAttributeState>): Record<string, { Type: string; Value: string }> {
  return Object.fromEntries(Object.entries(attributes).map(([name, value]) => [name, {
    Type: value.dataType,
    Value: value.binaryValueBase64 ?? value.stringValue ?? "",
  }]));
}

function sqsMessageAttributes(attributes: Record<string, SnsMessageAttributeState>): Record<string, { DataType: string; StringValue?: string; BinaryValue?: Uint8Array }> {
  return Object.fromEntries(Object.entries(attributes).map(([name, value]) => [name, {
    DataType: value.dataType,
    ...(value.binaryValueBase64 === undefined
      ? { StringValue: value.stringValue ?? "" }
      : { BinaryValue: Buffer.from(value.binaryValueBase64, "base64") }),
  }]));
}

function managedRetryDelay(deliveryId: string, attempts: number): number | undefined {
  if (attempts >= MANAGED_DELIVERY_ATTEMPTS) return undefined;
  let base: number;
  if (attempts <= 3) return 0;
  if (attempts <= 5) base = 1_000;
  else if (attempts <= 15) base = Math.min(20_000, 1_000 * (2 ** (attempts - 6)));
  else base = 20_000;
  const digest = createHash("sha256").update(`${deliveryId}:${attempts}`).digest();
  const fraction = digest.readUInt32BE(0) / 0xffffffff;
  return Math.round(base * (0.5 + fraction));
}

function normalizeQuery(action: string, parsed: Record<string, unknown>): any {
  const input: any = { ...parsed };
  delete input.Action;
  delete input.Version;
  if (action === "CreateTopic" && input.Tags !== undefined) input.Tags = asArray(input.Tags);
  if (input.TagKeys !== undefined) input.TagKeys = asArray(input.TagKeys).map(String);
  if (input.MessageAttributes !== undefined) input.MessageAttributes = normalizeMessageAttributes(input.MessageAttributes);
  return input;
}

function validateQueryParameters(parameters: URLSearchParams): void {
  for (const key of parameters.keys()) {
    if (!key || /(?:^|\.)(?:member|entry)(?:\.|$)/.test(key) && !/(?:^|\.)(?:member|entry)\.[1-9]\d*(?:\.|$)/.test(key)) {
      throw new AwsError("InvalidParameter", `Malformed AWS Query parameter path: ${key || "(empty)"}`, 400);
    }
  }
}

function decodeQueryBody(body: Buffer): string {
  if (body.length > MAX_QUERY_BYTES) throw new AwsError("InvalidParameter", `SNS Query requests may not exceed ${MAX_QUERY_BYTES} bytes.`, 400);
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(body); }
  catch { throw new AwsError("InvalidParameter", "SNS Query request body must be valid UTF-8.", 400); }
  if (/%(?![0-9a-f]{2})/i.test(decoded)) throw new AwsError("InvalidParameter", "SNS Query request body contains malformed percent encoding.", 400);
  return decoded;
}

function defaultPolicy(topicArn: string, owner: string): string {
  return JSON.stringify({
    Version: "2008-10-17",
    Id: "__default_policy_ID",
    Statement: [{
      Sid: "__default_statement_ID",
      Effect: "Allow",
      Principal: { AWS: "*" },
      Action: ["SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:AddPermission", "SNS:RemovePermission", "SNS:DeleteTopic", "SNS:Subscribe", "SNS:ListSubscriptionsByTopic", "SNS:Publish"],
      Resource: topicArn,
      Condition: { StringEquals: { "AWS:SourceOwner": owner } },
    }],
  });
}

function missingTopic(): AwsError {
  return new AwsError("NotFound", "Topic does not exist", 404);
}

export class SnsService {
  private readonly storage: SnsDeliveryStorage;
  private readonly signer: SnsSigner;
  private startPromise?: Promise<void>;
  private stopped = false;
  private unavailableReason?: string;
  private workerRunning = false;
  private workerCancel?: () => void;
  private workerPromise?: Promise<void>;

  constructor(
    private readonly store: StateStore,
    private readonly region: string,
    private readonly clock: Clock,
    private readonly scheduler: Scheduler,
    private readonly telemetry: TelemetryBus,
    private readonly sqs: SqsPort,
    private readonly lambda: LambdaPort,
    private readonly logs: LogsPort,
    private readonly publicOrigin: () => string,
    private readonly capacity: SnsCapacityOptions = {},
  ) {
    this.storage = new SnsDeliveryStorage(store, region);
    this.signer = new SnsSigner(store);
  }

  async start(): Promise<void> {
    if (!this.startPromise) this.startPromise = (async () => {
      await this.signer.start(this.clock.now());
      try {
        await this.storage.start();
        await this.storage.mutate(data => {
          let changed = false;
          for (const delivery of Object.values(data.deliveries)) {
            if ((delivery.status === "LEASED" || delivery.status === "REDRIVE_LEASED") && (delivery.leaseUntil ?? 0) <= this.clock.now()) {
              const redrive = delivery.status === "REDRIVE_LEASED";
              delivery.status = redrive ? "REDRIVE_QUEUED" : "QUEUED";
              delivery.nextAttemptAt = Math.min(delivery.nextAttemptAt, this.clock.now());
              delete delivery.leaseId;
              delete delivery.leaseUntil;
              changed = true;
            }
          }
          this.prune(data);
          return changed;
        });
      } catch (error) {
        this.unavailableReason = error instanceof Error ? error.message : String(error);
      }
    })();
    await this.startPromise;
    this.stopped = false;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.workerCancel?.();
    this.workerCancel = undefined;
    await this.workerPromise?.catch(() => undefined);
    await this.storage.stop();
  }

  certificate(): string {
    return this.signer.publicCertificate();
  }

  assertTopicExists(topicArn: string): void {
    this.requireTopic(topicArn);
  }

  admissionStatus(): "available" | "unavailable" {
    return this.unavailableReason ? "unavailable" : "available";
  }

  async handleUnsubscribeLink(token: string): Promise<boolean> {
    await this.ensureStarted();
    const decoded = this.signer.verifyUnsubscribeToken(token);
    if (!decoded) return false;
    const subscription = this.control.subscriptions[decoded.subscriptionArn];
    if (!subscription || subscription.generation !== decoded.generation) return false;
    await this.removeSubscription(subscription);
    return true;
  }

  async handle(req: IncomingMessage, res: ServerResponse, requestId: string, principal: PrincipalContext): Promise<void> {
    try {
      await this.ensureStarted();
      if (req.method !== "POST" && req.method !== "GET") throw new AwsError("InvalidParameter", "SNS Query requests must use GET or POST.", 400);
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const parameters = new URLSearchParams(url.search);
      if (req.method === "POST") {
        if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) throw new AwsError("InvalidParameter", "SNS Query POST requests require application/x-www-form-urlencoded.", 400);
        for (const [key, value] of new URLSearchParams(decodeQueryBody(await readBody(req)))) parameters.append(key, value);
      }
      const scalarDuplicates = [...new Set([...parameters.keys()])].filter(key => parameters.getAll(key).length > 1);
      if (scalarDuplicates.length) throw new AwsError("InvalidParameter", `Duplicate parameter: ${scalarDuplicates[0]}`, 400);
      validateQueryParameters(parameters);
      const raw = parseAwsQuery(parameters);
      const action = String(raw.Action ?? "");
      const version = String(raw.Version ?? "");
      if (version !== SNS_VERSION) throw new AwsError("InvalidParameter", `Invalid API version ${version || "(empty)"}. Expected ${SNS_VERSION}.`, 400);
      if (!SNS_02_ACTIONS.has(action)) throw new AwsError("InvalidAction", `The action ${action || "(empty)"} is not valid for this SNS implementation.`, 400);
      const operation = (this as any)[action];
      const result = await operation.call(this, normalizeQuery(action, raw), principal);
      res.setHeader("x-amzn-requestid", requestId);
      sendAwsQueryXml(res, `${action}Response`, { [`${action}Result`]: this.responseShape(action, result), ResponseMetadata: { RequestId: requestId } }, SNS_NAMESPACE);
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("InternalError", error instanceof Error ? error.message : String(error), 500);
      res.statusCode = aws.status;
      res.setHeader("content-type", "text/xml; charset=utf-8");
      res.setHeader("x-amzn-requestid", requestId);
      res.end(awsQueryErrorXml(aws.code, aws.message, requestId));
    }
  }

  async CreateTopic(input: any): Promise<{ TopicArn: string }> {
    const name = topicName(input.Name);
    const attributes = createTopicAttributes(input.Attributes);
    const suppliedTags = tags(input.Tags);
    return this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const existing = this.control.topics[name];
      if (existing) return { TopicArn: existing.arn };
      if (Object.keys(this.control.topics).length >= (this.capacity.maximumTopics ?? DEFAULT_MAX_TOPICS)) throw new AwsError("TopicLimitExceeded", "The configured local SNS topic capacity has been reached.", 403);
      const now = this.clock.now();
      const topic: SnsTopicState = {
        name,
        arn: this.topicArn(name),
        generation: randomUUID(),
        createdAt: now,
        updatedAt: now,
        policy: defaultPolicy(this.topicArn(name), this.store.accountId),
        signatureVersion: "1",
        sqsSuccessFeedbackSampleRate: 0,
        lambdaSuccessFeedbackSampleRate: 0,
        tags: suppliedTags,
        subscriptionArns: [],
      };
      this.applyTopicAttributes(topic, attributes as any, true);
      this.control.topics[name] = topic;
      this.control.revision++;
      await this.store.save();
      return { TopicArn: topic.arn };
    });
  }

  async DeleteTopic(input: any): Promise<Record<string, never>> {
    const topic = this.topicByArn(input.TopicArn, false);
    if (!topic) return {};
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const current = this.topicByArn(input.TopicArn, false);
      if (!current) return;
      for (const arn of current.subscriptionArns) delete this.control.subscriptions[arn];
      delete this.control.topics[current.name];
      this.control.revision++;
      await this.store.save();
    });
    return {};
  }

  async GetTopicAttributes(input: any): Promise<{ Attributes: Record<string, string> }> {
    const topic = this.requireTopic(input.TopicArn);
    return { Attributes: this.topicAttributes(topic) };
  }

  async SetTopicAttributes(input: any): Promise<Record<string, never>> {
    const name = String(input.AttributeName ?? "");
    if (!name) throw new AwsError("InvalidParameter", "AttributeName is required.", 400);
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const topic = this.requireTopic(input.TopicArn);
      this.applyTopicAttributes(topic, { [name]: String(input.AttributeValue ?? "") }, false);
      topic.updatedAt = this.clock.now();
      this.control.revision++;
      await this.store.save();
    });
    return {};
  }

  async AddPermission(input: any): Promise<Record<string, never>> {
    const label = String(input.Label ?? "");
    if (!/^[\x20-\x7e]{1,80}$/.test(label)) throw new AwsError("InvalidParameter", "Label must contain 1 to 80 printable ASCII characters.", 400);
    const accountIds = asArray(input.AWSAccountId).map(String);
    const actions = asArray(input.ActionName).map(String);
    const supported = new Set(["GetTopicAttributes", "SetTopicAttributes", "AddPermission", "RemovePermission", "DeleteTopic", "Subscribe", "ListSubscriptionsByTopic", "Publish", "Receive"]);
    if (!accountIds.length || accountIds.length > 100 || accountIds.some(value => !/^\d{12}$/.test(value))) throw new AwsError("InvalidParameter", "AWSAccountId must contain one or more 12-digit account IDs.", 400);
    if (!actions.length || actions.some(action => !supported.has(action))) throw new AwsError("InvalidParameter", "ActionName contains an unsupported SNS permission action.", 400);
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const topic = this.requireTopic(input.TopicArn);
      const policy = JSON.parse(topic.policy);
      const statements = asArray<any>(policy.Statement);
      if (statements.some(statement => statement?.Sid === label)) throw new AwsError("InvalidParameter", `A statement with label ${label} already exists.`, 400);
      statements.push({
        Sid: label,
        Effect: "Allow",
        Principal: { AWS: accountIds.map(account => `arn:aws:iam::${account}:root`) },
        Action: actions.map(action => `SNS:${action}`),
        Resource: topic.arn,
      });
      policy.Statement = statements;
      topic.policy = normalizePolicy(JSON.stringify(policy), topic.arn);
      topic.updatedAt = this.clock.now();
      this.control.revision++;
      await this.store.save();
    });
    return {};
  }

  async RemovePermission(input: any): Promise<Record<string, never>> {
    const label = String(input.Label ?? "");
    if (!label) throw new AwsError("InvalidParameter", "Label is required.", 400);
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const topic = this.requireTopic(input.TopicArn);
      const policy = JSON.parse(topic.policy);
      const statements = asArray<any>(policy.Statement);
      if (!statements.some(statement => statement?.Sid === label)) throw new AwsError("InvalidParameter", `A policy statement with label ${label} does not exist.`, 400);
      policy.Statement = statements.filter(statement => statement?.Sid !== label);
      topic.policy = JSON.stringify(policy);
      topic.updatedAt = this.clock.now();
      this.control.revision++;
      await this.store.save();
    });
    return {};
  }

  async ListTopics(input: any): Promise<{ Topics?: Array<{ TopicArn: string }>; NextToken?: string }> {
    const arns = Object.values(this.control.topics).map(topic => topic.arn).sort(utf8Compare);
    const page = this.page("ListTopics", arns, input.NextToken, 100);
    return { ...(page.items.length ? { Topics: page.items.map(TopicArn => ({ TopicArn })) } : {}), ...(page.nextToken ? { NextToken: page.nextToken } : {}) };
  }

  async Subscribe(input: any): Promise<{ SubscriptionArn: string }> {
    const topic = this.requireTopic(input.TopicArn);
    const protocol = String(input.Protocol ?? "");
    if (protocol !== "sqs" && protocol !== "lambda") throw new AwsError("InvalidParameter", `Protocol ${protocol || "(empty)"} is unavailable in SNS-01; only sqs and lambda are active.`, 400);
    const attributes = stringMap(input.Attributes, "Subscription attribute");
    const endpoint = String(input.Endpoint ?? "");
    if (!endpoint) throw new AwsError("InvalidParameter", "Endpoint is required.", 400);
    const match = endpoint.match(/^arn:(aws):(sqs|lambda):([^:]+):(\d{12}):(.+)$/);
    if (!match || match[2] !== protocol || match[3] !== this.region || match[4] !== this.store.accountId) throw new AwsError("InvalidParameter", "SNS-01 subscriptions must target the same simulator account and Region using a matching SQS or Lambda ARN.", 400);
    if (protocol === "sqs") {
      const queue = this.sqs.resolveQueueArn(endpoint);
      if (queue.fifo) throw new AwsError("InvalidParameter", "FIFO queue subscriptions require SNS-04.", 400);
    } else this.lambda.assertFunctionExists(endpoint);
    return this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const currentTopic = this.requireTopic(topic.arn);
      const existing = currentTopic.subscriptionArns.map(arn => this.control.subscriptions[arn]).find(item => item?.protocol === protocol && item.endpoint === endpoint);
      if (existing) return { SubscriptionArn: existing.arn };
      if (Object.keys(this.control.subscriptions).length >= (this.capacity.maximumSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS)) throw new AwsError("SubscriptionLimitExceeded", "The configured local SNS subscription capacity has been reached.", 403);
      const id = randomUUID();
      const arn = `${currentTopic.arn}:${id}`;
      const subscription: SnsSubscriptionState = {
        arn,
        id,
        generation: randomUUID(),
        topicArn: currentTopic.arn,
        topicGeneration: currentTopic.generation,
        protocol,
        endpoint,
        ownerAccountId: this.store.accountId,
        createdAt: this.clock.now(),
        filterPolicyScope: "MessageAttributes",
        rawMessageDelivery: false,
        filterRevision: 1,
        deliveryRevision: 1,
      };
      this.applySubscriptionAttributes(subscription, attributes, true);
      this.control.subscriptions[arn] = subscription;
      currentTopic.subscriptionArns.push(arn);
      currentTopic.updatedAt = this.clock.now();
      this.control.revision++;
      await this.store.save();
      return { SubscriptionArn: arn };
    });
  }

  async Unsubscribe(input: any): Promise<Record<string, never>> {
    const subscription = this.subscription(input.SubscriptionArn, false);
    if (!subscription) return {};
    await this.removeSubscription(subscription);
    return {};
  }

  async GetSubscriptionAttributes(input: any): Promise<{ Attributes: Record<string, string> }> {
    const subscription = this.requireSubscription(input.SubscriptionArn);
    return { Attributes: this.subscriptionAttributes(subscription) };
  }

  async SetSubscriptionAttributes(input: any): Promise<Record<string, never>> {
    const name = String(input.AttributeName ?? "");
    if (!name) throw new AwsError("InvalidParameter", "AttributeName is required.", 400);
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const subscription = this.requireSubscription(input.SubscriptionArn);
      this.applySubscriptionAttributes(subscription, { [name]: String(input.AttributeValue ?? "") }, false);
      this.control.revision++;
      const topic = this.topicByArn(subscription.topicArn, false);
      if (topic) topic.updatedAt = this.clock.now();
      await this.store.save();
    });
    return {};
  }

  async ListSubscriptions(input: any): Promise<{ Subscriptions?: any[]; NextToken?: string }> {
    const arns = Object.keys(this.control.subscriptions).sort(utf8Compare);
    const page = this.page("ListSubscriptions", arns, input.NextToken, 100);
    return { ...(page.items.length ? { Subscriptions: page.items.map(arn => this.subscriptionView(this.control.subscriptions[arn])) } : {}), ...(page.nextToken ? { NextToken: page.nextToken } : {}) };
  }

  async ListSubscriptionsByTopic(input: any): Promise<{ Subscriptions?: any[]; NextToken?: string }> {
    const topic = this.requireTopic(input.TopicArn);
    const arns = topic.subscriptionArns.filter(arn => this.control.subscriptions[arn]).sort(utf8Compare);
    const page = this.page(`ListSubscriptionsByTopic:${topic.arn}`, arns, input.NextToken, 100);
    return { ...(page.items.length ? { Subscriptions: page.items.map(arn => this.subscriptionView(this.control.subscriptions[arn])) } : {}), ...(page.nextToken ? { NextToken: page.nextToken } : {}) };
  }

  async Publish(input: any, principal?: PrincipalContext): Promise<{ MessageId: string }> {
    const accepted = await this.accept(input, principal);
    return { MessageId: accepted.messageId };
  }

  async publishAuthorized(input: any, caller: {
    principal: string;
    sourceArn: string;
    sourceAccount: string;
    identityAuthorization?: AuthorizationResult;
    lineage?: string[];
  }, attempt?: ServiceIntegrationAttempt): Promise<{ MessageId: string }> {
    if (attempt) { const prior = await this.reconcileIntegrationAttempt(attempt); if (prior !== undefined) return prior; }
    await this.ensureStarted();
    const topic = this.requireTopic(input.TopicArn);
    const context: Record<string, unknown> = {
      "aws:PrincipalArn": caller.principal,
      "aws:PrincipalAccount": caller.sourceAccount,
      "aws:PrincipalServiceName": caller.principal.endsWith(".amazonaws.com") ? caller.principal : undefined,
      "aws:SourceArn": caller.sourceArn,
      "aws:SourceAccount": caller.sourceAccount,
      "AWS:SourceOwner": caller.sourceAccount,
      "aws:RequestedRegion": this.region,
      ...Object.fromEntries(Object.entries(topic.tags).map(([key, value]) => [`aws:ResourceTag/${key}`, value])),
    };
    const servicePrincipal = caller.principal.endsWith(".amazonaws.com");
    const resource = evaluateResourcePolicy(JSON.parse(topic.policy), {
      principalArn: caller.principal,
      ...(!servicePrincipal && caller.principal.includes(":role/") ? { roleArn: caller.principal } : {}),
    }, "sns:Publish", topic.arn, context);
    const identity = caller.identityAuthorization ?? {
      decision: "implicitDeny",
      reason: servicePrincipal ? "Service principals use the topic resource policy" : "No identity authorization was supplied",
      matchedStatements: [],
    };
    const authorization = combineIdentityAndResourceAuthorization(
      identity,
      resource,
      servicePrincipal ? "service" : caller.sourceAccount === this.store.accountId ? "sameAccount" : "crossAccount",
    );
    if (authorization.decision !== "allowed") {
      throw new AwsError("AuthorizationError", `The principal ${caller.principal} is not authorized to publish to ${topic.arn}. ${authorization.reason}`, 403);
    }
    const accepted = await this.accept(input, {
      principalType: "service",
      accessKeyId: "",
      principalArn: caller.principal,
      principalId: caller.principal,
      accountId: caller.sourceAccount,
      lambdaLineage: caller.lineage,
    } as PrincipalContext, attempt);
    return { MessageId: accepted.messageId };
  }

  async reconcileIntegrationAttempt(attempt: ServiceIntegrationAttempt): Promise<any | undefined> { const receipt = (await this.storage.snapshot()).integrationAttempts[attempt.attemptId]; if (receipt) assertMatchingIntegrationAttempt(receipt, attempt); return receipt ? structuredClone(receipt.output) : undefined; }
  async releaseIntegrationAttempt(attemptId: string): Promise<void> { await this.storage.mutate(data => { delete data.integrationAttempts[attemptId]; }); }

  async claimCloudFormationTopic(topicArn: string, owner: string): Promise<void> {
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const topic = this.requireTopic(topicArn);
      if (topic.cloudFormationOwner && topic.cloudFormationOwner !== owner) throw new AwsError("ResourceConflictException", `Topic ${topicArn} is owned by another CloudFormation resource.`, 409);
      topic.cloudFormationOwner = owner;
      this.control.revision++;
      await this.store.save();
    });
  }

  async releaseCloudFormationTopic(topicArn: string, owner: string): Promise<void> {
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const topic = this.topicByArn(topicArn, false);
      if (!topic) return;
      if (topic.cloudFormationOwner !== owner) throw new AwsError("ResourceConflictException", `Topic ${topicArn} is not owned by this CloudFormation resource.`, 409);
      delete topic.cloudFormationOwner;
      this.control.revision++;
      await this.store.save();
    });
  }

  async releaseCloudFormationRetainedTopic(topicArn: string, owner: string): Promise<void> {
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const topic = this.topicByArn(topicArn, false);
      if (!topic) return;
      if (topic.cloudFormationOwner !== undefined && topic.cloudFormationOwner !== owner) {
        throw new AwsError("ResourceConflictException", `Topic ${topicArn} is not owned by this CloudFormation resource.`, 409);
      }
      let changed = false;
      if (topic.cloudFormationOwner === owner) {
        delete topic.cloudFormationOwner;
        changed = true;
      }
      for (const subscriptionArn of topic.subscriptionArns) {
        const subscription = this.control.subscriptions[subscriptionArn];
        if (subscription?.cloudFormationOwner === owner && subscription.cloudFormationInline) {
          delete subscription.cloudFormationOwner;
          delete subscription.cloudFormationInline;
          changed = true;
        }
      }
      if (!changed) return;
      this.control.revision++;
      await this.store.save();
    });
  }

  async deleteCloudFormationTopic(topicArn: string, owner: string): Promise<void> {
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const topic = this.topicByArn(topicArn, false);
      if (!topic) return;
      if (topic.cloudFormationOwner !== owner) throw new AwsError("ResourceConflictException", `Topic ${topicArn} is not owned by this CloudFormation resource.`, 409);
      for (const arn of topic.subscriptionArns) {
        const subscription = this.control.subscriptions[arn];
        if (subscription?.cloudFormationOwner === owner && subscription.cloudFormationInline) {
          delete subscription.cloudFormationOwner;
          delete subscription.cloudFormationInline;
        } else delete this.control.subscriptions[arn];
      }
      delete this.control.topics[topic.name];
      this.control.revision++;
      await this.store.save();
    });
  }

  async claimCloudFormationSubscription(subscriptionArn: string, owner: string, inline = false): Promise<void> {
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const subscription = this.requireSubscription(subscriptionArn);
      if (subscription.cloudFormationOwner && subscription.cloudFormationOwner !== owner) throw new AwsError("ResourceConflictException", `Subscription ${subscriptionArn} is owned by another CloudFormation resource.`, 409);
      subscription.cloudFormationOwner = owner;
      subscription.cloudFormationInline = inline;
      this.control.revision++;
      await this.store.save();
    });
  }

  async releaseCloudFormationSubscription(subscriptionArn: string, owner: string): Promise<void> {
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const subscription = this.subscription(subscriptionArn, false);
      if (!subscription) return;
      if (subscription.cloudFormationOwner !== owner) throw new AwsError("ResourceConflictException", `Subscription ${subscriptionArn} is not owned by this CloudFormation resource.`, 409);
      delete subscription.cloudFormationOwner;
      delete subscription.cloudFormationInline;
      this.control.revision++;
      await this.store.save();
    });
  }

  cloudFormationTopicOwner(topicArn: string): string | undefined {
    return this.topicByArn(topicArn, false)?.cloudFormationOwner;
  }

  cloudFormationSubscriptionOwner(subscriptionArn: string): string | undefined {
    return this.subscription(subscriptionArn, false)?.cloudFormationOwner;
  }

  cloudFormationSubscriptions(owner: string): SnsSubscriptionState[] {
    return Object.values(this.control.subscriptions).filter(subscription => subscription.cloudFormationOwner === owner).map(subscription => structuredClone(subscription));
  }

  async setCloudFormationOwnedPolicy(topicArn: string, owner: string, policyValue: string): Promise<void> {
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const topic = this.requireTopic(topicArn);
      if (topic.policyOwner && topic.policyOwner !== owner) throw new AwsError("ResourceConflictException", `Topic policy for ${topicArn} is owned by another CloudFormation resource.`, 409);
      const policy = normalizePolicy(policyValue, topic.arn);
      if (rejectsOwnerMutation(policy, this.store.accountId, topic.arn)) throw new AwsError("InvalidParameter", "The policy explicitly denies the topic owner all policy-recovery operations.", 400);
      if (!topic.policyOwner) topic.policyBaseline = topic.policy;
      topic.policyOwner = owner;
      topic.policy = policy;
      topic.updatedAt = this.clock.now();
      this.control.revision++;
      await this.store.save();
    });
  }

  async releaseCloudFormationOwnedPolicy(topicArn: string, owner: string): Promise<void> {
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const topic = this.topicByArn(topicArn, false);
      if (!topic) return;
      if (topic.policyOwner !== owner) throw new AwsError("ResourceConflictException", `Topic policy for ${topicArn} is not owned by this CloudFormation resource.`, 409);
      topic.policy = topic.policyBaseline ?? defaultPolicy(topic.arn, this.store.accountId);
      delete topic.policyBaseline;
      delete topic.policyOwner;
      topic.updatedAt = this.clock.now();
      this.control.revision++;
      await this.store.save();
    });
  }

  cloudFormationPolicyOwner(topicArn: string): string | undefined {
    return this.topicByArn(topicArn, false)?.policyOwner;
  }

  cloudFormationPolicyTopics(owner: string): string[] {
    return Object.values(this.control.topics).filter(topic => topic.policyOwner === owner).map(topic => topic.arn).sort();
  }

  async PublishBatch(input: any, principal?: PrincipalContext): Promise<{ Successful?: any[]; Failed?: any[] }> {
    const topic = this.requireTopic(input.TopicArn);
    const entries = asArray<any>(input.PublishBatchRequestEntries);
    if (!entries.length || entries.length > 10) throw new AwsError("InvalidParameter", "PublishBatchRequestEntries must contain between 1 and 10 entries.", 400);
    const ids = entries.map(entry => String(entry?.Id ?? ""));
    if (ids.some(id => !/^[A-Za-z0-9_-]{1,80}$/.test(id)) || new Set(ids).size !== ids.length) throw new AwsError("InvalidParameter", "Batch entry Id values must be unique and contain 1 to 80 alphanumeric, hyphen, or underscore characters.", 400);
    const aggregate = entries.reduce((total, entry) => {
      let attributeBytes: number;
      try {
        const attributes = entry?.MessageAttributes && !Array.isArray(entry.MessageAttributes)
          && Object.values(entry.MessageAttributes).every(value => value && typeof value === "object" && Object.hasOwn(value as object, "dataType"))
          ? entry.MessageAttributes as Record<string, SnsMessageAttributeState>
          : normalizeMessageAttributes(entry?.MessageAttributes);
        attributeBytes = messageAttributeBytes(attributes);
      } catch {
        attributeBytes = unvalidatedMessageAttributeBytes(entry?.MessageAttributes);
      }
      return total + Buffer.byteLength(String(entry?.Message ?? "")) + attributeBytes;
    }, 0);
    if (aggregate > MAX_MESSAGE_BYTES) throw new AwsError("BatchRequestTooLong", "The aggregate batch payload exceeds 262144 bytes.", 400);
    const Successful: any[] = [];
    const Failed: any[] = [];
    for (const [index, entry] of entries.entries()) {
      try {
        const accepted = await this.accept({ ...entry, TopicArn: topic.arn }, principal);
        Successful.push({ Id: ids[index], MessageId: accepted.messageId });
      } catch (error) {
        const aws = error instanceof AwsError ? error : new AwsError("InternalError", error instanceof Error ? error.message : String(error), 500);
        Failed.push({ Id: ids[index], Code: aws.code, Message: aws.message, SenderFault: aws.status < 500 });
      }
    }
    return { ...(Successful.length ? { Successful } : {}), ...(Failed.length ? { Failed } : {}) };
  }

  async TagResource(input: any): Promise<Record<string, never>> {
    const additions = tags(input.Tags);
    if (!Object.keys(additions).length) throw new AwsError("InvalidParameter", "Tags must contain at least one tag.", 400);
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const topic = this.requireTopic(input.ResourceArn);
      const combined = { ...topic.tags, ...additions };
      if (Object.keys(combined).length > 50) throw new AwsError("TagLimitExceeded", "A topic can have at most 50 tags.", 400);
      topic.tags = combined;
      topic.updatedAt = this.clock.now();
      this.control.revision++;
      await this.store.save();
    });
    return {};
  }

  async UntagResource(input: any): Promise<Record<string, never>> {
    const keys = asArray(input.TagKeys).map(String);
    if (!keys.length) throw new AwsError("InvalidParameter", "TagKeys must contain at least one key.", 400);
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const topic = this.requireTopic(input.ResourceArn);
      for (const key of keys) delete topic.tags[key];
      topic.updatedAt = this.clock.now();
      this.control.revision++;
      await this.store.save();
    });
    return {};
  }

  async ListTagsForResource(input: any): Promise<{ Tags: Array<{ Key: string; Value: string }> }> {
    const topic = this.requireTopic(input.ResourceArn);
    return { Tags: Object.entries(topic.tags).sort(([left], [right]) => utf8Compare(left, right)).map(([Key, Value]) => ({ Key, Value })) };
  }

  async deliveryDiagnostics(): Promise<Array<Record<string, unknown>>> {
    const snapshot = await this.storage.snapshot();
    return Object.values(snapshot.deliveries).sort((left, right) => right.nextAttemptAt - left.nextAttemptAt).slice(0, 250).map(delivery => ({
      deliveryId: delivery.deliveryId,
      messageId: delivery.messageId,
      subscriptionArn: delivery.subscriptionArn,
      protocol: delivery.protocol,
      endpoint: this.redactedEndpoint(delivery.endpoint),
      status: delivery.status,
      attempts: delivery.attempts,
      redriveAttempts: delivery.redriveAttempts,
      filterRevision: delivery.filterRevision,
      deliveryRevision: delivery.deliveryRevision,
      rawMessageDelivery: delivery.rawMessageDelivery,
      signatureVersion: delivery.signatureVersion,
      deadLetterQueue: delivery.deadLetterTargetArn ? this.redactedEndpoint(delivery.deadLetterTargetArn) : undefined,
      nextAttemptAt: delivery.nextAttemptAt,
      completedAt: delivery.completedAt,
      errorCode: delivery.errorCode,
      errorMessage: delivery.errorMessage,
    }));
  }

  private async accept(input: any, principal?: PrincipalContext, attempt?: ServiceIntegrationAttempt): Promise<{ messageId: string }> {
    if (attempt) { const prior = await this.reconcileIntegrationAttempt(attempt); if (prior !== undefined) return { messageId: String(prior.MessageId) }; }
    const topic = this.requireTopic(input.TopicArn);
    if (input.TargetArn !== undefined || input.PhoneNumber !== undefined) throw new AwsError("InvalidParameter", "SNS-01 Publish accepts TopicArn only; mobile and SMS targets are unavailable.", 400);
    if (input.MessageDeduplicationId !== undefined) throw new AwsError("InvalidParameter", "MessageDeduplicationId is valid only for FIFO topics in SNS-04.", 400);
    const message = String(input.Message ?? "");
    if (!message || !validUnicode(message)) throw new AwsError("InvalidParameter", "Message must be a non-empty valid UTF-8 string.", 400);
    const subject = input.Subject === undefined ? undefined : String(input.Subject);
    if (subject !== undefined && ([...subject].length >= 100 || /[\x00-\x1f\x7f]/.test(subject))) throw new AwsError("InvalidParameter", "Subject must be valid UTF-8 text under 100 characters without control characters or line breaks.", 400);
    const messageAttributes = input.MessageAttributes && !Array.isArray(input.MessageAttributes)
      && Object.values(input.MessageAttributes).every(value => value && typeof value === "object" && Object.hasOwn(value as object, "dataType"))
      ? input.MessageAttributes as Record<string, SnsMessageAttributeState>
      : normalizeMessageAttributes(input.MessageAttributes);
    const protocolMessages = structuredMessages(message, input.MessageStructure);
    if (protocolMessages && Object.keys(messageAttributes).length) throw new AwsError("InvalidParameter", "MessageAttributes cannot be used with MessageStructure json.", 400);
    const sizeBytes = Buffer.byteLength(message) + messageAttributeBytes(messageAttributes);
    if (sizeBytes > MAX_MESSAGE_BYTES) throw new AwsError("InvalidParameter", "Message and attributes exceed the maximum 262144-byte size.", 400);
    const messageGroupId = input.MessageGroupId === undefined ? undefined : String(input.MessageGroupId);
    if (messageGroupId !== undefined && (!messageGroupId || Buffer.byteLength(messageGroupId) > 128 || /[^\x21-\x7e]/.test(messageGroupId))) throw new AwsError("InvalidParameter", "MessageGroupId must contain 1 to 128 supported characters.", 400);
    const lineage = [...(principal?.lambdaLineage ?? [])];
    if (lineage.length >= 32 || lineage.includes(topic.arn)) throw new AwsError("InvalidParameter", "SNS delivery lineage exceeds the 32-hop limit or repeats this topic.", 400);
    const messageId = randomUUID();
    const timestamp = this.clock.now();
    const filteredMetrics: string[] = [];
    const acceptedMessageId = await this.storage.mutate(data => {
      const prior = attempt ? data.integrationAttempts[attempt.attemptId] : undefined; if (prior) { assertMatchingIntegrationAttempt(prior, attempt!); return String((prior.output as any).MessageId); }
      this.prune(data);
      if (Object.keys(data.messages).length >= (this.capacity.maximumDeliveryMessages ?? DEFAULT_MAX_DELIVERY_MESSAGES)) throw new AwsError("InternalError", "The configured local SNS durable delivery capacity has been reached.", 500);
      const current = this.requireTopic(topic.arn);
      const subscriptions = current.subscriptionArns.map(arn => this.control.subscriptions[arn]).filter((item): item is SnsSubscriptionState => Boolean(item));
      const stored: SnsStoredMessage = {
        messageId,
        topicArn: current.arn,
        topicGeneration: current.generation,
        timestamp,
        message,
        ...(protocolMessages ? { protocolMessages } : {}),
        ...(subject === undefined ? {} : { subject }),
        messageAttributes,
        ...(messageGroupId === undefined ? {} : { messageGroupId }),
        sizeBytes,
        lineage: [...lineage, current.arn].slice(-32),
        retainUntil: timestamp + (this.capacity.deliveryRetentionMs ?? DEFAULT_DELIVERY_RETENTION_MS),
      };
      data.messages[messageId] = stored;
      for (const subscription of subscriptions) {
        const deliveryId = randomUUID();
        const filterMessage = protocolMessages?.[subscription.protocol] ?? protocolMessages?.default ?? message;
        const outcome = filterMatchResult(subscription.filterPolicy, subscription.filterPolicyScope, messageAttributes, filterMessage);
        const matches = outcome.matches;
        if (!matches) {
          filteredMetrics.push(subscription.filterPolicyScope === "MessageBody"
            ? outcome.invalidMessageBody ? "NumberOfNotificationsFilteredOut-InvalidMessageBody" : "NumberOfNotificationsFilteredOut-MessageBody"
            : "NumberOfNotificationsFilteredOut-MessageAttributes");
        }
        data.deliveries[deliveryId] = {
          deliveryId,
          messageId,
          subscriptionArn: subscription.arn,
          subscriptionGeneration: subscription.generation,
          protocol: subscription.protocol,
          endpoint: subscription.endpoint,
          topicName: current.name,
          signatureVersion: current.signatureVersion,
          rawMessageDelivery: subscription.rawMessageDelivery,
          filterRevision: subscription.filterRevision,
          deliveryRevision: subscription.deliveryRevision,
          ...(subscription.redrivePolicy ? { deadLetterTargetArn: JSON.parse(subscription.redrivePolicy).deadLetterTargetArn } : {}),
          ...(subscription.protocol === "sqs"
            ? {
                ...(current.sqsSuccessFeedbackRoleArn ? { successFeedbackRoleArn: current.sqsSuccessFeedbackRoleArn } : {}),
                successFeedbackSampleRate: current.sqsSuccessFeedbackSampleRate,
                ...(current.sqsFailureFeedbackRoleArn ? { failureFeedbackRoleArn: current.sqsFailureFeedbackRoleArn } : {}),
              }
            : {
                ...(current.lambdaSuccessFeedbackRoleArn ? { successFeedbackRoleArn: current.lambdaSuccessFeedbackRoleArn } : {}),
                successFeedbackSampleRate: current.lambdaSuccessFeedbackSampleRate,
                ...(current.lambdaFailureFeedbackRoleArn ? { failureFeedbackRoleArn: current.lambdaFailureFeedbackRoleArn } : {}),
              }),
          status: matches ? "QUEUED" : "FILTERED",
          attempts: 0,
          redriveAttempts: 0,
          nextAttemptAt: timestamp,
          ...(matches ? {} : { completedAt: timestamp }),
        };
      }
      if (attempt) data.integrationAttempts[attempt.attemptId] = acceptedIntegrationAttempt(attempt, { MessageId: messageId }, timestamp);
      return messageId;
    });
    if (acceptedMessageId !== messageId) return { messageId: acceptedMessageId };
    await Promise.all([
      this.metric("NumberOfMessagesPublished", topic.name, 1, "Count"),
      this.metric("PublishSize", topic.name, sizeBytes, "Bytes"),
      ...filteredMetrics.flatMap(name => [
        this.metric("NumberOfNotificationsFilteredOut", topic.name, 1, "Count"),
        this.metric(name, topic.name, 1, "Count"),
      ]),
    ]);
    this.schedule(0);
    return { messageId };
  }

  private responseShape(action: string, result: any): Record<string, unknown> {
    if (action === "GetTopicAttributes" || action === "GetSubscriptionAttributes") return { Attributes: awsQueryMap(result.Attributes ?? {}) };
    if (action === "ListTopics") return { ...(result.Topics ? { Topics: awsQueryList("member", result.Topics) } : {}), NextToken: result.NextToken };
    if (action === "ListSubscriptions" || action === "ListSubscriptionsByTopic") return { ...(result.Subscriptions ? { Subscriptions: awsQueryList("member", result.Subscriptions) } : {}), NextToken: result.NextToken };
    if (action === "ListTagsForResource") return { Tags: awsQueryList("member", result.Tags ?? []) };
    if (action === "PublishBatch") return {
      ...(result.Successful ? { Successful: awsQueryList("member", result.Successful) } : {}),
      ...(result.Failed ? { Failed: awsQueryList("member", result.Failed) } : {}),
    };
    return result ?? {};
  }

  private applyTopicAttributes(topic: SnsTopicState, attributes: Record<string, string>, creating: boolean): void {
    const supported = new Set([
      "DisplayName", "FifoTopic", "Policy", "SignatureVersion",
      "SQSSuccessFeedbackRoleArn", "SQSSuccessFeedbackSampleRate", "SQSFailureFeedbackRoleArn",
      "LambdaSuccessFeedbackRoleArn", "LambdaSuccessFeedbackSampleRate", "LambdaFailureFeedbackRoleArn",
    ]);
    for (const [name, value] of Object.entries(attributes)) {
      if (!supported.has(name)) {
        if (["DeliveryPolicy", "KmsMasterKeyId", "TracingConfig", "ArchivePolicy", "ContentBasedDeduplication", "FifoThroughputScope"].includes(name)) {
          throw new AwsError("InvalidParameter", `Topic attribute ${name} requires a later SNS phase and was not applied.`, 400);
        }
        throw new AwsError("InvalidParameter", `Topic attribute ${name} is unsupported.`, 400);
      }
      if (name === "FifoTopic") {
        if (value !== "false") throw new AwsError("InvalidParameter", "FIFO topics are not available until SNS-04.", 400);
      } else if (name === "DisplayName") {
        topic.displayName = displayName(value);
      } else if (name === "Policy") {
        const policy = normalizePolicy(value, topic.arn);
        if (rejectsOwnerMutation(policy, this.store.accountId, topic.arn)) {
          throw new AwsError("InvalidParameter", "The policy explicitly denies the topic owner all policy-recovery operations.", 400);
        }
        topic.policy = policy;
      } else if (name === "SignatureVersion") {
        if (value !== "1" && value !== "2") throw new AwsError("InvalidParameter", "SignatureVersion must be 1 or 2.", 400);
        topic.signatureVersion = value;
      } else if (name === "SQSSuccessFeedbackRoleArn") topic.sqsSuccessFeedbackRoleArn = feedbackRole(value, this.store.accountId);
      else if (name === "SQSFailureFeedbackRoleArn") topic.sqsFailureFeedbackRoleArn = feedbackRole(value, this.store.accountId);
      else if (name === "SQSSuccessFeedbackSampleRate") topic.sqsSuccessFeedbackSampleRate = sampleRate(value);
      else if (name === "LambdaSuccessFeedbackRoleArn") topic.lambdaSuccessFeedbackRoleArn = feedbackRole(value, this.store.accountId);
      else if (name === "LambdaFailureFeedbackRoleArn") topic.lambdaFailureFeedbackRoleArn = feedbackRole(value, this.store.accountId);
      else if (name === "LambdaSuccessFeedbackSampleRate") topic.lambdaSuccessFeedbackSampleRate = sampleRate(value);
    }
    for (const roleArn of [
      topic.sqsSuccessFeedbackRoleArn, topic.sqsFailureFeedbackRoleArn,
      topic.lambdaSuccessFeedbackRoleArn, topic.lambdaFailureFeedbackRoleArn,
    ].filter((value): value is string => Boolean(value))) {
      const role = Object.values(this.store.ensureAccount().iam.roles).find(candidate => candidate.arn === roleArn);
      if (!role) throw new AwsError("InvalidParameter", `Delivery feedback role ${roleArn} does not exist.`, 400);
      const trust = evaluateTrust(role.assumeRolePolicyDocument, "sns.amazonaws.com", "sts:AssumeRole", {
        "aws:PrincipalServiceName": "sns.amazonaws.com",
        "aws:SourceArn": topic.arn,
        "aws:SourceAccount": this.store.accountId,
      });
      if (trust.decision !== "allowed") throw new AwsError("InvalidParameter", `Delivery feedback role ${roleArn} does not trust sns.amazonaws.com.`, 400);
    }
    if (creating && attributes.FifoTopic === undefined) {
      // Standard topics are the only topic type active in SNS-02.
    }
  }

  private applySubscriptionAttributes(subscription: SnsSubscriptionState, attributes: Record<string, string>, creating: boolean): void {
    const supported = new Set(["FilterPolicy", "FilterPolicyScope", "RawMessageDelivery", "RedrivePolicy"]);
    const unknown = Object.keys(attributes).find(name => !supported.has(name));
    if (unknown) {
      if (["DeliveryPolicy", "SubscriptionRoleArn", "ReplayPolicy"].includes(unknown)) {
        throw new AwsError("InvalidParameter", `Subscription attribute ${unknown} requires a later SNS phase and was not applied.`, 400);
      }
      throw new AwsError("InvalidParameter", `Subscription attribute ${unknown} is unsupported.`, 400);
    }
    const nextScope = attributes.FilterPolicyScope === undefined
      ? subscription.filterPolicyScope
      : attributes.FilterPolicyScope;
    if (nextScope !== "MessageAttributes" && nextScope !== "MessageBody") throw new AwsError("InvalidParameter", "FilterPolicyScope must be MessageAttributes or MessageBody.", 400);
    const nextFilter = attributes.FilterPolicy === undefined
      ? subscription.filterPolicy
      : attributes.FilterPolicy === "" ? undefined : validateFilterPolicy(attributes.FilterPolicy, nextScope).source;
    if (nextFilter) validateFilterPolicy(nextFilter, nextScope);
    let filterChanged = false;
    let deliveryChanged = false;
    if (subscription.filterPolicyScope !== nextScope) {
      subscription.filterPolicyScope = nextScope;
      filterChanged = true;
    }
    if (subscription.filterPolicy !== nextFilter) {
      subscription.filterPolicy = nextFilter;
      filterChanged = true;
    }
    if (attributes.RawMessageDelivery !== undefined) {
      if (!["true", "false"].includes(attributes.RawMessageDelivery)) throw new AwsError("InvalidParameter", "RawMessageDelivery must be true or false.", 400);
      const value = attributes.RawMessageDelivery === "true";
      if (value && subscription.protocol !== "sqs") throw new AwsError("InvalidParameter", "RawMessageDelivery is available only for SQS subscriptions in SNS-02.", 400);
      if (subscription.rawMessageDelivery !== value) {
        subscription.rawMessageDelivery = value;
        deliveryChanged = true;
      }
    }
    if (attributes.RedrivePolicy !== undefined) {
      const value = redrivePolicy(attributes.RedrivePolicy, this.sqs, this.region, this.store.accountId);
      if (subscription.redrivePolicy !== value) {
        subscription.redrivePolicy = value;
        deliveryChanged = true;
      }
    }
    if (!creating && filterChanged) subscription.filterRevision++;
    if (!creating && (filterChanged || deliveryChanged)) subscription.deliveryRevision++;
  }

  private topicAttributes(topic: SnsTopicState): Record<string, string> {
    return {
      TopicArn: topic.arn,
      Owner: this.store.accountId,
      Policy: topic.policy,
      SubscriptionsConfirmed: String(topic.subscriptionArns.filter(arn => this.control.subscriptions[arn]).length),
      SubscriptionsPending: "0",
      SubscriptionsDeleted: "0",
      FifoTopic: "false",
      SignatureVersion: topic.signatureVersion,
      DisplayName: topic.displayName ?? "",
      SQSSuccessFeedbackRoleArn: topic.sqsSuccessFeedbackRoleArn ?? "",
      SQSSuccessFeedbackSampleRate: String(topic.sqsSuccessFeedbackSampleRate),
      SQSFailureFeedbackRoleArn: topic.sqsFailureFeedbackRoleArn ?? "",
      LambdaSuccessFeedbackRoleArn: topic.lambdaSuccessFeedbackRoleArn ?? "",
      LambdaSuccessFeedbackSampleRate: String(topic.lambdaSuccessFeedbackSampleRate),
      LambdaFailureFeedbackRoleArn: topic.lambdaFailureFeedbackRoleArn ?? "",
    };
  }

  private subscriptionAttributes(subscription: SnsSubscriptionState): Record<string, string> {
    return {
      SubscriptionArn: subscription.arn,
      TopicArn: subscription.topicArn,
      Owner: subscription.ownerAccountId,
      Protocol: subscription.protocol,
      Endpoint: subscription.endpoint,
      RawMessageDelivery: String(subscription.rawMessageDelivery),
      FilterPolicyScope: subscription.filterPolicyScope,
      ...(subscription.filterPolicy === undefined ? {} : { FilterPolicy: subscription.filterPolicy }),
      ...(subscription.redrivePolicy === undefined ? {} : { RedrivePolicy: subscription.redrivePolicy }),
      PendingConfirmation: "false",
      ConfirmationWasAuthenticated: "true",
    };
  }

  private subscriptionView(subscription: SnsSubscriptionState): Record<string, string> {
    return {
      SubscriptionArn: subscription.arn,
      Owner: subscription.ownerAccountId,
      Protocol: subscription.protocol,
      Endpoint: subscription.endpoint,
      TopicArn: subscription.topicArn,
    };
  }

  private async removeSubscription(subscription: SnsSubscriptionState): Promise<void> {
    await this.store.withMutationLock(`sns:${this.store.accountId}:${this.region}:control`, async () => {
      const current = this.control.subscriptions[subscription.arn];
      if (!current || current.generation !== subscription.generation) return;
      delete this.control.subscriptions[current.arn];
      const topic = this.topicByArn(current.topicArn, false);
      if (topic) {
        topic.subscriptionArns = topic.subscriptionArns.filter(arn => arn !== current.arn);
        topic.updatedAt = this.clock.now();
      }
      this.control.revision++;
      await this.store.save();
    });
  }

  private topicArn(name: string): string {
    return `arn:aws:sns:${this.region}:${this.store.accountId}:${name}`;
  }

  private topicByArn(value: unknown, failInvalid = true): SnsTopicState | undefined {
    const arn = String(value ?? "");
    const match = arn.match(/^arn:(aws):sns:([^:]+):(\d{12}):([A-Za-z0-9_-]{1,256})$/);
    if (!match || match[2] !== this.region || match[3] !== this.store.accountId) {
      if (failInvalid) throw new AwsError("InvalidParameter", "TopicArn must identify a topic in this simulator account and Region.", 400);
      return undefined;
    }
    const topic = this.control.topics[match[4]];
    return topic?.arn === arn ? topic : undefined;
  }

  private requireTopic(value: unknown): SnsTopicState {
    return this.topicByArn(value) ?? (() => { throw missingTopic(); })();
  }

  private subscription(value: unknown, failInvalid = true): SnsSubscriptionState | undefined {
    const arn = String(value ?? "");
    if (!/^arn:aws:sns:[^:]+:\d{12}:[A-Za-z0-9_-]{1,256}:[0-9a-f-]{36}$/i.test(arn)) {
      if (failInvalid) throw new AwsError("InvalidParameter", "SubscriptionArn is invalid.", 400);
      return undefined;
    }
    return this.control.subscriptions[arn];
  }

  private requireSubscription(value: unknown): SnsSubscriptionState {
    const found = this.subscription(value);
    if (!found) throw new AwsError("NotFound", "Subscription does not exist", 404);
    return found;
  }

  private page(operation: string, values: string[], token: unknown, maximum: number): { items: string[]; nextToken?: string } {
    let after = "";
    if (token !== undefined) {
      try {
        const decoded = this.pagination.decode<PageCursor>(operation, String(token));
        if (decoded.revision !== this.control.revision) throw new Error("revision");
        after = decoded.after;
      } catch { throw new AwsError("InvalidParameter", "NextToken is invalid or stale.", 400); }
    }
    const start = after ? values.findIndex(value => utf8Compare(value, after) > 0) : 0;
    const offset = start < 0 ? values.length : start;
    const items = values.slice(offset, offset + maximum);
    const nextToken = offset + maximum < values.length ? this.pagination.encode(operation, { after: items.at(-1), revision: this.control.revision }) : undefined;
    return { items, nextToken };
  }

  private get pagination(): PaginationTokens {
    return new PaginationTokens(this.store.state.installation.paginationSecret);
  }

  private get control() {
    return this.store.regionState(this.region).sns;
  }

  private async ensureStarted(): Promise<void> {
    if (!this.startPromise) await this.start();
    else await this.startPromise;
    if (this.unavailableReason) throw new AwsError("InternalError", `SNS delivery storage is unavailable for account ${this.store.accountId} in ${this.region}: ${this.unavailableReason}`, 500);
    if (this.stopped) throw new AwsError("InternalError", "The SNS service is stopping.", 500);
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.workerRunning || this.workerCancel) return;
    this.workerCancel = this.scheduler.schedule(async () => {
      this.workerCancel = undefined;
      const running = this.runWorker();
      this.workerPromise = running;
      try { await running; }
      finally { if (this.workerPromise === running) this.workerPromise = undefined; }
    }, Math.max(0, delayMs));
  }

  private async scheduleFromData(): Promise<void> {
    if (this.stopped || this.workerRunning || this.workerCancel) return;
    const data = await this.storage.snapshot();
    const now = this.clock.now();
    const times = Object.values(data.deliveries)
      .filter(item => ["QUEUED", "LEASED", "REDRIVE_QUEUED", "REDRIVE_LEASED"].includes(item.status))
      .map(item => item.status === "LEASED" || item.status === "REDRIVE_LEASED" ? item.leaseUntil ?? now : item.nextAttemptAt);
    if (times.length) this.schedule(Math.max(0, Math.min(...times) - now));
  }

  private scheduleNext(): void {
    void this.scheduleFromData().catch(() => undefined);
  }

  private async runWorker(): Promise<void> {
    if (this.stopped || this.workerRunning) return;
    this.workerRunning = true;
    try {
      const now = this.clock.now();
      let claimed: { delivery: SnsDeliveryIntent; message: SnsStoredMessage } | undefined;
      await this.storage.mutate(data => {
        for (const delivery of Object.values(data.deliveries)) if ((delivery.status === "LEASED" || delivery.status === "REDRIVE_LEASED") && (delivery.leaseUntil ?? 0) <= now) {
          delivery.status = delivery.status === "REDRIVE_LEASED" ? "REDRIVE_QUEUED" : "QUEUED";
          delivery.nextAttemptAt = now;
          delete delivery.leaseId;
          delete delivery.leaseUntil;
        }
        const delivery = Object.values(data.deliveries)
          .filter(item => (item.status === "QUEUED" || item.status === "REDRIVE_QUEUED") && item.nextAttemptAt <= now)
          .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt || left.deliveryId.localeCompare(right.deliveryId))[0];
        if (!delivery) return;
        const redrive = delivery.status === "REDRIVE_QUEUED";
        const message = data.messages[delivery.messageId];
        if (!message) {
          delivery.status = redrive ? "REDRIVE_FAILED" : "FAILED";
          delivery.completedAt = now;
          delivery.errorCode = "PayloadUnavailable";
          delivery.errorMessage = "The durable message payload is unavailable.";
          return;
        }
        delivery.status = redrive ? "REDRIVE_LEASED" : "LEASED";
        delivery.leaseId = randomUUID();
        delivery.leaseUntil = now + LEASE_MS;
        if (redrive) delivery.redriveAttempts++;
        else delivery.attempts++;
        claimed = { delivery: structuredClone(delivery), message: structuredClone(message) };
      });
      if (!claimed) return;
      if (claimed.delivery.status === "REDRIVE_LEASED") await this.deliverToDeadLetterQueue(claimed.delivery, claimed.message);
      else await this.deliver(claimed.delivery, claimed.message);
    } finally {
      this.workerRunning = false;
      await this.scheduleFromData().catch(() => undefined);
    }
  }

  private async deliver(delivery: SnsDeliveryIntent, message: SnsStoredMessage): Promise<void> {
    const selectedMessage = message.protocolMessages?.[delivery.protocol] ?? message.protocolMessages?.default ?? message.message;
    const timestamp = new Date(message.timestamp).toISOString();
    const fields: SnsNotificationFields = {
      Type: "Notification",
      MessageId: message.messageId,
      TopicArn: message.topicArn,
      Message: selectedMessage,
      Timestamp: timestamp,
      ...(message.subject === undefined ? {} : { Subject: message.subject }),
    };
    const signature = this.signer.signature(fields, delivery.signatureVersion);
    const origin = this.publicOrigin().replace(/\/+$/, "");
    const certificateUrl = `${origin}/_stacksim/sns/certificate.pem`;
    const unsubscribeUrl = `${origin}/_stacksim/sns/unsubscribe?token=${encodeURIComponent(this.signer.unsubscribeToken(delivery.subscriptionArn, delivery.subscriptionGeneration))}`;
    const envelope = {
      ...fields,
      SignatureVersion: delivery.signatureVersion,
      Signature: signature,
      SigningCertURL: certificateUrl,
      UnsubscribeURL: unsubscribeUrl,
      MessageAttributes: notificationAttributes(message.messageAttributes),
    };
    try {
      const lineage = [...message.lineage, delivery.endpoint].slice(-32);
      if (new Set(lineage).size !== lineage.length || lineage.length > 32) throw new AwsError("RecursiveDelivery", "SNS delivery lineage repeated a resource or exceeded 32 hops.", 400);
      if (delivery.protocol === "sqs") {
        if (delivery.rawMessageDelivery && Object.keys(message.messageAttributes).length > 10) {
          throw new AwsError("InvalidParameter", "Raw SQS delivery supports at most 10 message attributes.", 400);
        }
        await this.sqs.sendAuthorizedMessageToArn(delivery.endpoint, {
          MessageBody: delivery.rawMessageDelivery ? selectedMessage : JSON.stringify(envelope),
          ...(delivery.rawMessageDelivery ? { MessageAttributes: sqsMessageAttributes(message.messageAttributes) } : {}),
          ...(message.messageGroupId === undefined ? {} : { MessageGroupId: message.messageGroupId }),
        }, {
          kind: "service",
          principal: "sns.amazonaws.com",
          sourceArn: message.topicArn,
          sourceAccount: this.store.accountId,
          deliveryLineage: lineage,
        });
      } else {
        const event = {
          Records: [{
            EventSource: "aws:sns",
            EventVersion: "1.0",
            EventSubscriptionArn: delivery.subscriptionArn,
            Sns: {
              ...fields,
              SignatureVersion: delivery.signatureVersion,
              Signature: signature,
              SigningCertUrl: certificateUrl,
              UnsubscribeUrl: unsubscribeUrl,
              MessageAttributes: notificationAttributes(message.messageAttributes),
            },
          }],
        };
        await this.lambda.enqueueServiceInvocation(delivery.endpoint, Buffer.from(JSON.stringify(event)), "sns.amazonaws.com", message.topicArn, this.store.accountId, lineage);
      }
      await this.completeDelivery(delivery, true);
      await this.metric("NumberOfNotificationsDelivered", delivery.topicName, 1, "Count");
      await this.deliveryFeedback(delivery, message, true);
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("InternalError", error instanceof Error ? error.message : String(error), 500);
      const retryable = aws.status >= 500 || aws.status === 429 || aws.code === "ResourceConflictException";
      const delay = retryable ? managedRetryDelay(delivery.deliveryId, delivery.attempts) : undefined;
      const canRetry = delay !== undefined;
      await this.storage.mutate(data => {
        const current = data.deliveries[delivery.deliveryId];
        if (!current || current.leaseId !== delivery.leaseId) return;
        delete current.leaseId;
        delete current.leaseUntil;
        current.errorCode = aws.code;
        current.errorMessage = aws.message.slice(0, 512);
        if (canRetry) {
          current.status = "QUEUED";
          current.nextAttemptAt = this.clock.now() + delay;
        } else if (current.deadLetterTargetArn) {
          current.status = "REDRIVE_QUEUED";
          current.nextAttemptAt = this.clock.now();
        } else {
          current.status = "FAILED";
          current.completedAt = this.clock.now();
        }
      });
      if (!canRetry) {
        await this.metric("NumberOfNotificationsFailed", delivery.topicName, 1, "Count");
        await this.deliveryFeedback(delivery, message, false, aws.code);
      }
    }
  }

  private async deliverToDeadLetterQueue(delivery: SnsDeliveryIntent, message: SnsStoredMessage): Promise<void> {
    if (!delivery.deadLetterTargetArn) return;
    const selectedMessage = message.protocolMessages?.[delivery.protocol] ?? message.protocolMessages?.default ?? message.message;
    const fields: SnsNotificationFields = {
      Type: "Notification",
      MessageId: message.messageId,
      TopicArn: message.topicArn,
      Message: selectedMessage,
      Timestamp: new Date(message.timestamp).toISOString(),
      ...(message.subject === undefined ? {} : { Subject: message.subject }),
    };
    const origin = this.publicOrigin().replace(/\/+$/, "");
    const payload = JSON.stringify({
      ...fields,
      SignatureVersion: delivery.signatureVersion,
      Signature: this.signer.signature(fields, delivery.signatureVersion),
      SigningCertURL: `${origin}/_stacksim/sns/certificate.pem`,
      UnsubscribeURL: `${origin}/_stacksim/sns/unsubscribe?token=${encodeURIComponent(this.signer.unsubscribeToken(delivery.subscriptionArn, delivery.subscriptionGeneration))}`,
      MessageAttributes: notificationAttributes(message.messageAttributes),
    });
    try {
      await this.sqs.sendAuthorizedMessageToArn(delivery.deadLetterTargetArn, { MessageBody: payload }, {
        kind: "service",
        principal: "sns.amazonaws.com",
        sourceArn: message.topicArn,
        sourceAccount: this.store.accountId,
        deliveryLineage: [...message.lineage, delivery.deadLetterTargetArn].slice(-32),
      });
      await this.storage.mutate(data => {
        const current = data.deliveries[delivery.deliveryId];
        if (!current || current.leaseId !== delivery.leaseId) return;
        current.status = "REDRIVEN";
        current.completedAt = this.clock.now();
        delete current.leaseId;
        delete current.leaseUntil;
      });
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("InternalError", error instanceof Error ? error.message : String(error), 500);
      await this.storage.mutate(data => {
        const current = data.deliveries[delivery.deliveryId];
        if (!current || current.leaseId !== delivery.leaseId) return;
        current.status = "REDRIVE_FAILED";
        current.completedAt = this.clock.now();
        current.errorCode = aws.code;
        current.errorMessage = aws.message.slice(0, 512);
        delete current.leaseId;
        delete current.leaseUntil;
      });
    }
  }

  private async completeDelivery(delivery: SnsDeliveryIntent, success: boolean): Promise<void> {
    await this.storage.mutate(data => {
      const current = data.deliveries[delivery.deliveryId];
      if (!current || current.leaseId !== delivery.leaseId) return;
      current.status = success ? "DELIVERED" : "FAILED";
      current.completedAt = this.clock.now();
      delete current.leaseId;
      delete current.leaseUntil;
      delete current.errorCode;
      delete current.errorMessage;
    });
  }

  private prune(data: SnsDeliveryData): void {
    const now = this.clock.now();
    for (const [messageId, message] of Object.entries(data.messages)) {
      const deliveries = Object.values(data.deliveries).filter(delivery => delivery.messageId === messageId);
      if (message.retainUntil > now || deliveries.some(delivery => ["QUEUED", "LEASED", "REDRIVE_QUEUED", "REDRIVE_LEASED"].includes(delivery.status))) continue;
      for (const delivery of deliveries) delete data.deliveries[delivery.deliveryId];
      delete data.messages[messageId];
    }
  }

  private metric(metricName: string, topicNameValue: string, value: number, unit: string): Promise<void> {
    return this.telemetry.publish({ namespace: "AWS/SNS", metricName, dimensions: { TopicName: topicNameValue }, value, unit, timestamp: this.clock.now() }).catch(() => undefined);
  }

  private async deliveryFeedback(delivery: SnsDeliveryIntent, message: SnsStoredMessage, success: boolean, code?: string): Promise<void> {
    const roleArn = success ? delivery.successFeedbackRoleArn : delivery.failureFeedbackRoleArn;
    if (!roleArn) return;
    if (success) {
      const sample = createHash("sha256").update(`${message.messageId}:${delivery.subscriptionArn}`).digest().readUInt32BE(0) % 100;
      if (sample >= delivery.successFeedbackSampleRate) return;
    }
    const event = {
      notification: {
        messageId: message.messageId,
        topicArn: message.topicArn,
        timestamp: new Date(message.timestamp).toISOString(),
      },
      delivery: {
        deliveryId: delivery.deliveryId,
        destination: this.redactedEndpoint(delivery.endpoint),
        providerResponse: success ? "SUCCESS" : String(code ?? "ERROR").slice(0, 128),
        dwellTimeMs: Math.max(0, this.clock.now() - message.timestamp),
        attempts: delivery.attempts,
        status: success ? "SUCCESS" : "FAILURE",
      },
    };
    const iam = this.store.ensureAccount().iam;
    const group = `sns/${this.region}/${this.store.accountId}/${delivery.topicName}/${delivery.protocol}`;
    await this.logs.deliverServiceEvents({
      logGroupName: group,
      logStreamName: success ? "success" : "failure",
      logEvents: [{ timestamp: this.clock.now(), message: JSON.stringify(event) }],
    }, (action, resource) => evaluateRoleAuthorization(iam, roleArn, action, resource, {
      "aws:SourceArn": message.topicArn,
      "aws:SourceAccount": this.store.accountId,
      "aws:RequestedRegion": this.region,
    }).decision === "allowed", { deliveryLineage: message.lineage }).catch(() => false);
  }

  private topicNameFromArn(arn: string): string {
    return arn.slice(arn.lastIndexOf(":") + 1);
  }

  private redactedEndpoint(endpoint: string): string {
    const digest = createHash("sha256").update(endpoint).digest("hex").slice(0, 12);
    const service = endpoint.split(":")[2] ?? "endpoint";
    return `${service}:${digest}`;
  }

  private pageFingerprint(values: string[]): string {
    return createHash("sha256").update(values.join("\0")).digest("hex");
  }
}
