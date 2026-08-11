import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import type { Scheduler } from "./core/scheduler.js";
import type { TelemetryBus } from "./core/telemetry.js";
import { AwsError, sendAwsError } from "./errors.js";
import { combineIdentityAndResourceAuthorization, evaluateRoleAuthorization, type AuthorizationContext, type AuthorizationResult } from "./iam/evaluator.js";
import { awsQueryErrorXml, escapeXml, parseAwsQuery } from "./protocols/query-xml.js";
import type { StateStore } from "./state.js";
import type { SqsQueueAttributesState, SqsQueueState } from "./types.js";
import { json, readBody } from "./util.js";
import { md5OfMessageAttributes, md5OfMessageBody, normalizeBinaryAttributeValue, type SqsMessageAttributeValue } from "./sqs/md5.js";
import { SqsStorage, type SqsQueueData, type SqsStoredMessage, type SqsStoredMessagePayload } from "./sqs/storage.js";
import { acceptedIntegrationAttempt, assertMatchingIntegrationAttempt, type ServiceIntegrationAttempt } from "./step-functions/integration-attempt.js";
import {
  evaluateSqsQueuePolicy,
  parseSqsQueuePolicy,
  removeSqsPermission,
  SqsPolicyValidationError,
  upsertSqsPermission,
} from "./sqs/policy.js";

const SQS_NAMESPACE = "http://queue.amazonaws.com/doc/2012-11-05/";
const MAX_MESSAGE_BYTES = 1024 * 1024;
const QUEUE_DELETE_COOLDOWN_MS = 60_000;
const PURGE_COOLDOWN_MS = 60_000;
const FIFO_DEDUPLICATION_WINDOW_MS = 5 * 60_000;
const RECEIVE_ATTEMPT_WINDOW_MS = 5 * 60_000;
const ACTIONS = new Set([
  "CreateQueue", "DeleteQueue", "GetQueueUrl", "ListQueues", "GetQueueAttributes", "SetQueueAttributes",
  "TagQueue", "UntagQueue", "ListQueueTags", "SendMessage", "ReceiveMessage", "DeleteMessage",
  "ChangeMessageVisibility", "SendMessageBatch", "DeleteMessageBatch", "ChangeMessageVisibilityBatch", "PurgeQueue",
  "ListDeadLetterSourceQueues", "AddPermission", "RemovePermission",
]);

const DEFAULT_QUEUE_ATTRIBUTES: SqsQueueAttributesState = {
  DelaySeconds: "0",
  MaximumMessageSize: String(MAX_MESSAGE_BYTES),
  MessageRetentionPeriod: "345600",
  ReceiveMessageWaitTimeSeconds: "0",
  VisibilityTimeout: "30",
  FifoQueue: "false",
  SqsManagedSseEnabled: "true",
};

export interface CreateQueueInput { QueueName: string; Attributes?: Record<string, string>; tags?: Record<string, string>; Tags?: Record<string, string> }
export interface CreateQueueOutput { QueueUrl: string }
export interface QueueUrlInput { QueueUrl: string }
export interface DeleteQueueInput extends QueueUrlInput {}
export interface GetQueueUrlInput { QueueName: string; QueueOwnerAWSAccountId?: string }
export interface GetQueueUrlOutput { QueueUrl: string }
export interface ListQueuesInput { QueueNamePrefix?: string; MaxResults?: number; NextToken?: string }
export interface ListQueuesOutput { QueueUrls?: string[]; NextToken?: string }
export interface GetQueueAttributesInput extends QueueUrlInput { AttributeNames?: string[] }
export interface GetQueueAttributesOutput { Attributes?: Record<string, string> }
export interface SetQueueAttributesInput extends QueueUrlInput { Attributes: Record<string, string> }
export interface TagQueueInput extends QueueUrlInput { Tags: Record<string, string> }
export interface UntagQueueInput extends QueueUrlInput { TagKeys: string[] }
export interface ListQueueTagsInput extends QueueUrlInput {}
export interface ListQueueTagsOutput { Tags?: Record<string, string> }
export interface AddPermissionInput extends QueueUrlInput { Label: string; AWSAccountIds: string[]; Actions: string[] }
export interface RemovePermissionInput extends QueueUrlInput { Label: string }

export interface SendMessageInput extends QueueUrlInput {
  MessageBody: string;
  DelaySeconds?: number;
  MessageAttributes?: Record<string, SqsMessageAttributeValue>;
  MessageSystemAttributes?: Record<string, SqsMessageAttributeValue>;
  MessageDeduplicationId?: string;
  MessageGroupId?: string;
}
export interface SendMessageOutput {
  MD5OfMessageBody: string;
  MD5OfMessageAttributes?: string;
  MD5OfMessageSystemAttributes?: string;
  MessageId: string;
  SequenceNumber?: string;
}
export interface SqsMessage {
  MessageId?: string;
  ReceiptHandle?: string;
  MD5OfBody?: string;
  Body?: string;
  Attributes?: Record<string, string>;
  MD5OfMessageAttributes?: string;
  MessageAttributes?: Record<string, SqsMessageAttributeValue>;
  /** Internal, non-enumerable delivery metadata used only by local service consumers. */
  deliveryLineage?: string[];
}
export interface ReceiveMessageInput extends QueueUrlInput {
  AttributeNames?: string[];
  MessageAttributeNames?: string[];
  MessageSystemAttributeNames?: string[];
  MaxNumberOfMessages?: number;
  VisibilityTimeout?: number;
  WaitTimeSeconds?: number;
  ReceiveRequestAttemptId?: string;
}
export interface ReceiveMessageOutput { Messages?: SqsMessage[] }
export interface DeleteMessageInput extends QueueUrlInput { ReceiptHandle: string }
export interface ChangeMessageVisibilityInput extends DeleteMessageInput { VisibilityTimeout: number }

export interface SendMessageBatchRequestEntry extends Omit<SendMessageInput, "QueueUrl"> { Id: string }
export interface DeleteMessageBatchRequestEntry { Id: string; ReceiptHandle: string }
export interface ChangeMessageVisibilityBatchRequestEntry extends DeleteMessageBatchRequestEntry { VisibilityTimeout: number }
export interface BatchResultErrorEntry { Id: string; Code: string; Message?: string; SenderFault: boolean }
export interface SendMessageBatchResultEntry extends SendMessageOutput { Id: string }
export interface DeleteMessageBatchResultEntry { Id: string }
export interface ChangeMessageVisibilityBatchResultEntry { Id: string }
export interface SendMessageBatchInput extends QueueUrlInput { Entries: SendMessageBatchRequestEntry[] }
export interface SendMessageBatchOutput { Successful?: SendMessageBatchResultEntry[]; Failed?: BatchResultErrorEntry[] }
export interface DeleteMessageBatchInput extends QueueUrlInput { Entries: DeleteMessageBatchRequestEntry[] }
export interface DeleteMessageBatchOutput { Successful?: DeleteMessageBatchResultEntry[]; Failed?: BatchResultErrorEntry[] }
export interface ChangeMessageVisibilityBatchInput extends QueueUrlInput { Entries: ChangeMessageVisibilityBatchRequestEntry[] }
export interface ChangeMessageVisibilityBatchOutput { Successful?: ChangeMessageVisibilityBatchResultEntry[]; Failed?: BatchResultErrorEntry[] }
export interface ListDeadLetterSourceQueuesInput extends QueueUrlInput { MaxResults?: number; NextToken?: string }
export interface ListDeadLetterSourceQueuesOutput { queueUrls?: string[]; NextToken?: string }

export interface ResolvedSqsQueue {
  queueArn: string;
  queueUrl: string;
  queueName: string;
  visibilityTimeoutSeconds: number;
  fifo: boolean;
  ownerAccountId: string;
  state: SqsQueueState;
}

export interface SqsConsumerReceiveInput {
  queueArn: string;
  maxNumberOfMessages: number;
  visibilityTimeoutSeconds?: number;
  waitTimeSeconds?: number;
  roleArn?: string;
  abortSignal?: AbortSignal;
}
export interface SqsConsumerReceiveOutput { messages: SqsMessage[] }
export interface SqsConsumerAcknowledgeInput { queueArn: string; receiptHandles: string[]; roleArn?: string }

export type SqsAuthorizedMessageCaller =
  | { kind: "service"; principal: string; sourceArn: string; sourceAccount: string; deliveryLineage?: string[] }
  | { kind: "role"; roleArn: string; sourceArn?: string; sourceAccount?: string; deliveryLineage?: string[] };

interface RedrivePolicy { deadLetterTargetArn: string; maxReceiveCount: number }
interface RedriveAllowPolicy { redrivePermission: "allowAll" | "denyAll" | "byQueue"; sourceQueueArns?: string[] }
interface PageCursor { after: string; fingerprint: string }
interface SqsRequestContext { abortSignal?: AbortSignal }
type XmlRecord = Record<string, unknown>;

class SqsRequestAbortedError extends Error {
  constructor() { super("The SQS request was aborted by the client."); this.name = "SqsRequestAbortedError"; }
}

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function numeric(value: unknown, name: string, minimum: number, maximum: number, fallback?: number): number {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new AwsError("MissingParameter", `The request must contain the parameter ${name}.`, 400);
  }
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AwsError("InvalidParameterValue", `Value ${String(value)} for parameter ${name} is invalid. Reason: must be between ${minimum} and ${maximum}.`, 400);
  }
  return parsed;
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function validXmlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)) continue;
    return false;
  }
  return true;
}

function queueName(value: unknown): string {
  const name = String(value ?? "");
  if (!/^(?:[A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\.fifo)$/.test(name)) {
    throw new AwsError("InvalidParameterValue", "Queue names must be 1 to 80 characters and may contain alphanumeric characters, hyphens, or underscores; FIFO names end in .fifo.", 400);
  }
  return name;
}

function fifoIdentifier(value: unknown, name: string): string {
  const normalized = String(value ?? "");
  if (!/^[\u0021-\u007e]{1,128}$/.test(normalized)) throw new AwsError("InvalidParameterValue", `${name} must contain 1 to 128 supported alphanumeric or punctuation characters.`, 400);
  return normalized;
}

function booleanAttribute(value: unknown, name: string): "true" | "false" {
  if (String(value) !== "true" && String(value) !== "false") throw new AwsError("InvalidParameterValue", `${name} must be true or false.`, 400);
  return String(value) as "true" | "false";
}

function tagMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const item = String(raw ?? "");
    if (!key || [...key].length > 128 || [...item].length > 256 || key.toLowerCase().startsWith("aws:")) throw new AwsError("InvalidParameterValue", "Tag keys and values must satisfy the SQS tag restrictions.", 400);
    result[key] = item;
  }
  return result;
}

function normalizeAttributeMap(value: unknown): Record<string, SqsMessageAttributeValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, SqsMessageAttributeValue> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AwsError("InvalidParameterValue", `The message attribute ${name} is invalid.`, 400);
    const candidate = raw as Record<string, unknown>;
    const DataType = String(candidate.DataType ?? "");
    const baseType = DataType.split(".", 1)[0];
    if (!DataType || DataType.length > 256 || !["String", "Number", "Binary"].includes(baseType)) throw new AwsError("InvalidParameterValue", `The message attribute ${name} has an invalid data type.`, 400);
    if (!/^[A-Za-z0-9_.-]{1,256}$/.test(name) || name.startsWith(".") || name.endsWith(".") || name.includes("..") || /^(AWS|Amazon)\./i.test(name)) throw new AwsError("InvalidParameterValue", `The message attribute name ${name} is invalid.`, 400);
    if (asArray(candidate.StringListValues as string[] | undefined).length || asArray(candidate.BinaryListValues as Array<string | Uint8Array> | undefined).length) throw new AwsError("UnsupportedOperation", "List-valued SQS message attributes are not supported.", 400);
    if (baseType === "Binary") {
      if (candidate.BinaryValue === undefined || candidate.StringValue !== undefined) throw new AwsError("InvalidParameterValue", `The message attribute ${name} must contain BinaryValue.`, 400);
      const binary = candidate.BinaryValue;
      if (!(typeof binary === "string" || binary instanceof Uint8Array)) throw new AwsError("InvalidParameterValue", `The message attribute ${name} has an invalid BinaryValue.`, 400);
      result[name] = { DataType, BinaryValue: normalizeBinaryAttributeValue(binary) };
    } else {
      if (candidate.StringValue === undefined || candidate.BinaryValue !== undefined) throw new AwsError("InvalidParameterValue", `The message attribute ${name} must contain StringValue.`, 400);
      const StringValue = String(candidate.StringValue);
      if (!validXmlCharacters(StringValue)) throw new AwsError("InvalidMessageContents", `The message attribute ${name} contains invalid characters.`, 400);
      if (baseType === "Number" && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(StringValue) || !Number.isFinite(Number(StringValue)))) throw new AwsError("InvalidParameterValue", `The message attribute ${name} is not a valid number.`, 400);
      result[name] = { DataType, StringValue };
    }
  }
  return result;
}

function messageAttributeBytes(attributes: Record<string, SqsMessageAttributeValue>): number {
  return Object.entries(attributes).reduce((total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value.DataType)
    + (value.BinaryValue === undefined ? Buffer.byteLength(value.StringValue ?? "") : Buffer.from(String(value.BinaryValue), "base64").length), 0);
}

function requested(name: string, patterns: string[]): boolean {
  return patterns.some(pattern => pattern === "All" || pattern === ".*" || pattern === name || (pattern.endsWith(".*") && name.startsWith(pattern.slice(0, -1))));
}

function queryNameValueMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of asArray(value as any)) if (entry && typeof entry === "object" && (entry as any).Name !== undefined) result[String((entry as any).Name)] = String((entry as any).Value ?? "");
  return result;
}

function queryMessageAttributes(value: unknown): Record<string, SqsMessageAttributeValue> {
  const result: Record<string, SqsMessageAttributeValue> = {};
  for (const entry of asArray(value as any)) if (entry && typeof entry === "object" && (entry as any).Name !== undefined) result[String((entry as any).Name)] = (entry as any).Value ?? {};
  return result;
}

function normalizeQueryInput(action: string, parsed: Record<string, unknown>): any {
  const input: any = { ...parsed };
  delete input.Action; delete input.Version;
  if (input.Attribute !== undefined) { input.Attributes = queryNameValueMap(input.Attribute); delete input.Attribute; }
  if (input.Tag !== undefined) {
    const tags: Record<string, string> = {};
    for (const tag of asArray<any>(input.Tag)) if (tag?.Key !== undefined) tags[String(tag.Key)] = String(tag.Value ?? "");
    input.Tags = tags; delete input.Tag;
  }
  if (input.AttributeName !== undefined) { input.AttributeNames = asArray(input.AttributeName).map(String); delete input.AttributeName; }
  if (input.MessageAttributeName !== undefined) { input.MessageAttributeNames = asArray(input.MessageAttributeName).map(String); delete input.MessageAttributeName; }
  if (input.MessageSystemAttributeName !== undefined) { input.MessageSystemAttributeNames = asArray(input.MessageSystemAttributeName).map(String); delete input.MessageSystemAttributeName; }
  if (input.TagKey !== undefined) { input.TagKeys = asArray(input.TagKey).map(String); delete input.TagKey; }
  if (input.ActionName !== undefined) { input.Actions = asArray(input.ActionName).map(String); delete input.ActionName; }
  if (input.AWSAccountId !== undefined) { input.AWSAccountIds = asArray(input.AWSAccountId).map(String); delete input.AWSAccountId; }
  if (input.MessageAttribute !== undefined) { input.MessageAttributes = queryMessageAttributes(input.MessageAttribute); delete input.MessageAttribute; }
  if (input.MessageSystemAttribute !== undefined) { input.MessageSystemAttributes = queryMessageAttributes(input.MessageSystemAttribute); delete input.MessageSystemAttribute; }
  const batchKey = action === "SendMessageBatch" ? "SendMessageBatchRequestEntry" : action === "DeleteMessageBatch" ? "DeleteMessageBatchRequestEntry" : action === "ChangeMessageVisibilityBatch" ? "ChangeMessageVisibilityBatchRequestEntry" : undefined;
  if (batchKey) {
    input.Entries = asArray<any>(input[batchKey]).map(entry => {
      const normalized = { ...entry };
      if (normalized.MessageAttribute !== undefined) { normalized.MessageAttributes = queryMessageAttributes(normalized.MessageAttribute); delete normalized.MessageAttribute; }
      if (normalized.MessageSystemAttribute !== undefined) { normalized.MessageSystemAttributes = queryMessageAttributes(normalized.MessageSystemAttribute); delete normalized.MessageSystemAttribute; }
      return normalized;
    });
    delete input[batchKey];
  }
  return input;
}

function xmlElement(name: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(item => xmlElement(name, item)).join("");
  if (typeof value === "object") return `<${name}>${Object.entries(value as XmlRecord).map(([key, item]) => xmlElement(key, item)).join("")}</${name}>`;
  return `<${name}>${escapeXml(value)}</${name}>`;
}

function queryResultShape(action: string, result: any): XmlRecord {
  if (action === "ListQueues" || action === "ListDeadLetterSourceQueues") return { QueueUrl: result.QueueUrls ?? result.queueUrls, NextToken: result.NextToken };
  if (action === "GetQueueAttributes") return { Attribute: Object.entries(result.Attributes ?? {}).map(([Name, Value]) => ({ Name, Value })) };
  if (action === "ListQueueTags") return { Tag: Object.entries(result.Tags ?? {}).map(([Key, Value]) => ({ Key, Value })) };
  if (action === "ReceiveMessage") return {
    Message: asArray<SqsMessage>(result.Messages).map(message => ({
      MessageId: message.MessageId, ReceiptHandle: message.ReceiptHandle, MD5OfBody: message.MD5OfBody, Body: message.Body,
      Attribute: Object.entries(message.Attributes ?? {}).map(([Name, Value]) => ({ Name, Value })),
      MD5OfMessageAttributes: message.MD5OfMessageAttributes,
      MessageAttribute: Object.entries(message.MessageAttributes ?? {}).map(([Name, Value]) => ({ Name, Value })),
    })),
  };
  if (action === "SendMessageBatch") return {
    SendMessageBatchResultEntry: result.Successful,
    BatchResultErrorEntry: result.Failed,
  };
  if (action === "DeleteMessageBatch") return { DeleteMessageBatchResultEntry: result.Successful, BatchResultErrorEntry: result.Failed };
  if (action === "ChangeMessageVisibilityBatch") return { ChangeMessageVisibilityBatchResultEntry: result.Successful, BatchResultErrorEntry: result.Failed };
  return result ?? {};
}

function sendQueryResult(res: ServerResponse, action: string, result: unknown, requestId: string): void {
  const shape = queryResultShape(action, result);
  const contents = Object.entries(shape).map(([name, value]) => xmlElement(name, value)).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><${action}Response xmlns="${SQS_NAMESPACE}"><${action}Result>${contents}</${action}Result><ResponseMetadata><RequestId>${escapeXml(requestId)}</RequestId></ResponseMetadata></${action}Response>`;
  res.statusCode = 200;
  res.setHeader("content-type", "text/xml; charset=utf-8");
  res.end(xml);
}

export class SqsService {
  private readonly storage: SqsStorage;
  private startPromise?: Promise<void>;
  private stopped = false;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly attributeUpdateTails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: StateStore,
    private readonly region: string,
    private readonly clock: Clock,
    private readonly telemetry: TelemetryBus,
    private readonly scheduler: Scheduler,
    private readonly endpointProvider: () => string,
  ) {
    this.storage = new SqsStorage(store);
    void this.scheduler;
  }

  private get pagination(): PaginationTokens {
    return new PaginationTokens(this.store.state.installation.paginationSecret);
  }

  async start(): Promise<void> {
    if (!this.startPromise) this.startPromise = (async () => {
      await this.storage.start();
      await this.recoverPendingAttributeUpdates();
      if (this.pruneQueueDeletionTimes()) await this.store.save();
    })();
    await this.startPromise;
    this.stopped = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const callbacks of this.waiters.values()) for (const wake of [...callbacks]) wake();
    this.waiters.clear();
    await this.storage.stop();
  }

  async handle(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    await this.ensureStarted();
    const target = String(req.headers["x-amz-target"] ?? "");
    const jsonProtocol = target.startsWith("AmazonSQS.") || String(req.headers["content-type"] ?? "").toLowerCase().includes("amz-json");
    let action = target.startsWith("AmazonSQS.") ? target.slice("AmazonSQS.".length) : "";
    const requestAbort = new AbortController();
    const onRequestAborted = () => requestAbort.abort();
    const onResponseClosed = () => { if (!res.writableEnded) requestAbort.abort(); };
    req.once("aborted", onRequestAborted);
    res.once("close", onResponseClosed);
    try {
      const body = await readBody(req);
      let input: any;
      if (jsonProtocol) {
        try { input = body.length ? JSON.parse(body.toString("utf8")) : {}; }
        catch { throw new AwsError("InvalidParameterValue", "The request body contains malformed JSON.", 400); }
      } else {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const parameters = new URLSearchParams(url.search);
        for (const [name, value] of new URLSearchParams(body.toString("utf8"))) parameters.append(name, value);
        const parsed = parseAwsQuery(parameters);
        action = String(parsed.Action ?? action);
        input = normalizeQueryInput(action, parsed);
        if (input.QueueUrl === undefined && url.pathname !== "/" && !new Set(["CreateQueue", "GetQueueUrl", "ListQueues"]).has(action)) {
          input.QueueUrl = new URL(url.pathname, `${this.endpointProvider().replace(/\/+$/, "")}/`).toString();
        }
      }
      if (!ACTIONS.has(action)) throw new AwsError("InvalidAction", `The action ${action || "(empty)"} is not valid for this endpoint.`, 400);
      const operation = (this as unknown as Record<string, (value: any, context?: SqsRequestContext) => Promise<unknown>>)[action];
      const result = await operation.call(this, input, { abortSignal: requestAbort.signal });
      if (requestAbort.signal.aborted || res.destroyed) return;
      res.setHeader("x-amzn-requestid", requestId);
      if (jsonProtocol) json(res, result, 200, "application/x-amz-json-1.0");
      else sendQueryResult(res, action, result, requestId);
    } catch (error) {
      if (error instanceof SqsRequestAbortedError || requestAbort.signal.aborted || res.destroyed) return;
      const aws = error instanceof AwsError ? error : new AwsError("InternalError", error instanceof Error ? error.message : String(error), 500);
      res.setHeader("x-amzn-requestid", requestId);
      if (jsonProtocol) {
        res.setHeader("x-amzn-query-error", `${aws.code};${aws.status >= 500 ? "Server" : "Sender"}`);
        sendAwsError(res, aws, "json", "com.amazonaws.sqs#");
      } else {
        res.statusCode = aws.status; res.setHeader("content-type", "text/xml; charset=utf-8"); res.end(awsQueryErrorXml(aws.code, aws.message, requestId));
      }
    } finally {
      req.removeListener("aborted", onRequestAborted);
      res.removeListener("close", onResponseClosed);
    }
  }

  queueArn(name: string): string {
    return `arn:aws:sqs:${this.region}:${this.store.accountId}:${queueName(name)}`;
  }

  queueUrl(name: string, ownerAccountId = this.store.accountId): string {
    const endpoint = this.endpointProvider().replace(/\/+$/, "");
    return `${endpoint}/${ownerAccountId}/${encodeURIComponent(queueName(name))}`;
  }

  resolveQueueArn(arn: string): ResolvedSqsQueue {
    const match = /^arn:[a-z0-9-]+:sqs:([^:]+):(\d{12}):((?:[A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\.fifo))$/i.exec(String(arn));
    if (!match || match[1] !== this.region) throw this.missingQueue();
    const state = this.accountRegion(match[2])?.sqsQueues[match[3]];
    if (!state || state.queueArn !== arn) throw this.missingQueue();
    return { queueArn: arn, queueUrl: this.queueUrl(state.queueName, match[2]), queueName: state.queueName, visibilityTimeoutSeconds: Number(state.attributes.VisibilityTimeout), fifo: state.attributes.FifoQueue === "true", ownerAccountId: match[2], state };
  }

  resolveQueueUrl(url: string): ResolvedSqsQueue {
    let parsed: URL;
    try { parsed = new URL(String(url)); } catch { throw this.missingQueue(); }
    const components = parsed.pathname.split("/").filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { throw this.missingQueue(); } });
    if (components.length < 2 || !/^\d{12}$/.test(components.at(-2)!)) throw this.missingQueue();
    const ownerAccountId = components.at(-2)!;
    const state = this.accountRegion(ownerAccountId)?.sqsQueues[components.at(-1)!];
    if (!state) throw this.missingQueue();
    return { queueArn: state.queueArn, queueUrl: this.queueUrl(state.queueName, ownerAccountId), queueName: state.queueName, visibilityTimeoutSeconds: Number(state.attributes.VisibilityTimeout), fifo: state.attributes.FifoQueue === "true", ownerAccountId, state };
  }

  async CreateQueue(input: CreateQueueInput): Promise<CreateQueueOutput> {
    await this.ensureStarted();
    const name = queueName(input.QueueName);
    const rawAttributes = input.Attributes ?? {};
    const fifoRequested = Object.hasOwn(rawAttributes, "FifoQueue") && booleanAttribute(rawAttributes.FifoQueue, "FifoQueue") === "true";
    if (name.endsWith(".fifo") !== fifoRequested) throw new AwsError("InvalidParameterValue", fifoRequested ? "The name of a FIFO queue must end with the .fifo suffix." : "A queue name ending in .fifo requires the FifoQueue attribute set to true.", 400);
    const region = this.regionState();
    const prunedDeletionTimes = this.pruneQueueDeletionTimes();
    const existing = region.sqsQueues[name];
    const arn = this.queueArn(name);
    const supplied = await this.normalizedQueueAttributeUpdates(rawAttributes, arn, { creating: true, fifo: fifoRequested });
    if (existing) {
      const expected: SqsQueueAttributesState = {
        ...DEFAULT_QUEUE_ATTRIBUTES,
        ...(fifoRequested ? { FifoQueue: "true", ContentBasedDeduplication: "false", DeduplicationScope: "queue", FifoThroughputLimit: "perQueue" } : {}),
        ...supplied,
      } as SqsQueueAttributesState;
      const names = new Set<keyof SqsQueueAttributesState>([
        ...Object.keys(existing.attributes) as Array<keyof SqsQueueAttributesState>,
        ...Object.keys(expected) as Array<keyof SqsQueueAttributesState>,
      ]);
      for (const attribute of names) if (existing.attributes[attribute] !== expected[attribute]) throw new AwsError("QueueNameExists", "A queue already exists with the same name and a different value for an attribute.", 400);
      if (prunedDeletionTimes) await this.store.save();
      return { QueueUrl: this.queueUrl(name) };
    }
    const deletedAt = region.sqsQueueDeletionTimes[name];
    if (deletedAt !== undefined && this.clock.now() - deletedAt < QUEUE_DELETE_COOLDOWN_MS) throw new AwsError("QueueDeletedRecently", "You must wait 60 seconds after deleting a queue before you can create another with the same name.", 400);
    delete region.sqsQueueDeletionTimes[name];
    const tags = tagMap(input.Tags ?? input.tags);
    if (Object.keys(tags).length > 50) throw new AwsError("InvalidParameterValue", "A queue cannot have more than 50 tags.", 400);
    const now = this.clock.now();
    region.sqsQueues[name] = {
      queueName: name,
      queueArn: arn,
      createdAt: now,
      lastModified: now,
      attributes: {
        ...DEFAULT_QUEUE_ATTRIBUTES,
        ...(fifoRequested ? { FifoQueue: "true", ContentBasedDeduplication: "false", DeduplicationScope: "queue", FifoThroughputLimit: "perQueue" } : {}),
        ...supplied,
      } as SqsQueueAttributesState,
      tags,
    };
    await this.store.save();
    await this.storage.createQueue(arn, true);
    await this.publishGauges(region.sqsQueues[name]);
    return { QueueUrl: this.queueUrl(name) };
  }

  async DeleteQueue(input: DeleteQueueInput): Promise<Record<string, never>> {
    await this.ensureStarted();
    const queue = this.resolveQueueUrl(input.QueueUrl);
    const sources = this.deadLetterSources(queue.queueArn);
    if (sources.length) throw new AwsError("ResourceInUse", "The queue is in use as a dead-letter queue. Remove the source queue redrive policies first.", 400);
    const region = this.regionState();
    this.pruneQueueDeletionTimes();
    delete region.sqsQueues[queue.queueName];
    region.sqsQueueDeletionTimes[queue.queueName] = this.clock.now();
    await this.store.save();
    await this.storage.deleteQueue(queue.queueArn);
    this.notify(queue.queueArn);
    return {};
  }

  async GetQueueUrl(input: GetQueueUrlInput): Promise<GetQueueUrlOutput> {
    if (input.QueueOwnerAWSAccountId !== undefined && String(input.QueueOwnerAWSAccountId) !== this.store.accountId) throw this.missingQueue();
    const name = queueName(input.QueueName);
    if (!this.regionState().sqsQueues[name]) throw this.missingQueue();
    return { QueueUrl: this.queueUrl(name) };
  }

  async ListQueues(input: ListQueuesInput): Promise<ListQueuesOutput> {
    const prefix = String(input.QueueNamePrefix ?? "");
    if (prefix.length > 80) throw new AwsError("InvalidParameterValue", "QueueNamePrefix cannot exceed 80 characters.", 400);
    const names = Object.keys(this.regionState().sqsQueues).filter(name => name.startsWith(prefix)).sort(utf8Compare);
    const page = this.page("ListQueues", names, input.MaxResults, input.NextToken, prefix);
    return { ...(page.items.length ? { QueueUrls: page.items.map(name => this.queueUrl(name)) } : {}), ...(page.nextToken ? { NextToken: page.nextToken } : {}) };
  }

  async GetQueueAttributes(input: GetQueueAttributesInput): Promise<GetQueueAttributesOutput> {
    await this.ensureStarted();
    const queue = this.resolveQueueUrl(input.QueueUrl);
    const data = await this.readQueueAndRemoveExpired(queue.queueArn);
    const now = this.clock.now();
    const live = Object.values(data.messages).filter(message => message.retentionUntil > now);
    const fifoOnlyAttributes = new Set(["FifoQueue", "ContentBasedDeduplication", "DeduplicationScope", "FifoThroughputLimit"]);
    const configuredAttributes = Object.fromEntries(Object.entries(queue.state.attributes).filter(([name]) => queue.state.attributes.FifoQueue === "true" || !fifoOnlyAttributes.has(name)));
    const available: Record<string, string> = {
      ...configuredAttributes,
      QueueArn: queue.queueArn,
      CreatedTimestamp: String(Math.floor(queue.state.createdAt / 1000)),
      LastModifiedTimestamp: String(Math.floor(queue.state.lastModified / 1000)),
      ApproximateNumberOfMessages: String(live.filter(message => message.availableAt <= now && (message.invisibleUntil ?? 0) <= now).length),
      ApproximateNumberOfMessagesNotVisible: String(live.filter(message => (message.invisibleUntil ?? 0) > now).length),
      ApproximateNumberOfMessagesDelayed: String(live.filter(message => message.availableAt > now).length),
    };
    const names = asArray(input.AttributeNames);
    const selected = !names.length || names.includes("All") ? available : Object.fromEntries(names.filter(name => available[name] !== undefined).map(name => [name, available[name]]));
    for (const name of names) if (name !== "All" && available[name] === undefined) throw new AwsError("InvalidAttributeName", `Unknown Attribute ${name}.`, 400);
    await this.publishGauges(queue.state, data);
    return { Attributes: selected };
  }

  async SetQueueAttributes(input: SetQueueAttributesInput): Promise<Record<string, never>> {
    await this.ensureStarted();
    const target = this.resolveQueueUrl(input.QueueUrl);
    return this.serializeAttributeUpdate(target.queueArn, async () => {
      const queue = this.resolveQueueUrl(input.QueueUrl);
      await this.completePendingAttributeUpdate(queue.state);
      const updates = await this.normalizedQueueAttributeUpdates(input.Attributes ?? {}, queue.queueArn, { creating: false, fifo: queue.state.attributes.FifoQueue === "true", current: queue.state.attributes });
      const lastModified = this.clock.now();
      queue.state.pendingAttributeUpdate = {
        attributes: Object.fromEntries(Object.entries(updates).map(([name, value]) => [name, value ?? null])),
        lastModified,
      };
      this.applyPendingAttributeValues(queue.state);
      await this.store.save();
      await this.completePendingAttributeUpdate(queue.state);
      this.notify(queue.queueArn);
      await this.publishGauges(queue.state);
      return {};
    });
  }

  async AddPermission(input: AddPermissionInput): Promise<Record<string, never>> {
    await this.ensureStarted();
    const target = this.resolveQueueUrl(input.QueueUrl);
    return this.serializeAttributeUpdate(target.queueArn, async () => {
      const queue = this.resolveQueueUrl(input.QueueUrl);
      try {
        const policy = upsertSqsPermission(queue.state.attributes.Policy, {
          queueArn: queue.queueArn,
          label: String(input.Label ?? ""),
          accountIds: asArray(input.AWSAccountIds).map(String),
          actions: asArray(input.Actions).map(String),
        });
        queue.state.attributes.Policy = policy.normalized;
      } catch (error) { this.throwPolicyError(error, true); }
      queue.state.lastModified = this.clock.now();
      await this.store.save();
      return {};
    });
  }

  async RemovePermission(input: RemovePermissionInput): Promise<Record<string, never>> {
    await this.ensureStarted();
    const target = this.resolveQueueUrl(input.QueueUrl);
    return this.serializeAttributeUpdate(target.queueArn, async () => {
      const queue = this.resolveQueueUrl(input.QueueUrl);
      try {
        const policy = removeSqsPermission(queue.state.attributes.Policy, String(input.Label ?? ""));
        if (policy) queue.state.attributes.Policy = policy.normalized;
        else delete queue.state.attributes.Policy;
      } catch (error) { this.throwPolicyError(error, false); }
      queue.state.lastModified = this.clock.now();
      await this.store.save();
      return {};
    });
  }

  async TagQueue(input: TagQueueInput): Promise<Record<string, never>> {
    const queue = this.resolveQueueUrl(input.QueueUrl);
    const tags = tagMap(input.Tags);
    if (Object.keys({ ...queue.state.tags, ...tags }).length > 50) throw new AwsError("InvalidParameterValue", "A queue cannot have more than 50 tags.", 400);
    Object.assign(queue.state.tags, tags); queue.state.lastModified = this.clock.now(); await this.store.save(); return {};
  }

  async UntagQueue(input: UntagQueueInput): Promise<Record<string, never>> {
    const queue = this.resolveQueueUrl(input.QueueUrl);
    for (const key of asArray(input.TagKeys).map(String)) delete queue.state.tags[key];
    queue.state.lastModified = this.clock.now(); await this.store.save(); return {};
  }

  async ListQueueTags(input: ListQueueTagsInput): Promise<ListQueueTagsOutput> {
    const queue = this.resolveQueueUrl(input.QueueUrl); return { Tags: { ...queue.state.tags } };
  }

  async SendMessage(input: SendMessageInput): Promise<SendMessageOutput> {
    await this.ensureStarted();
    const queue = this.resolveQueueUrl(input.QueueUrl);
    return this.sendMessage(queue, input);
  }

  async sendMessageToArn(queueArn: string, input: Omit<SendMessageInput, "QueueUrl">, attempt?: ServiceIntegrationAttempt): Promise<SendMessageOutput> {
    await this.ensureStarted();
    const queue = this.resolveQueueArn(queueArn);
    return this.sendMessage(queue, { ...input, QueueUrl: queue.queueUrl }, { integrationAttempt: attempt });
  }

  async sendAuthorizedMessageToArn(queueArn: string, input: Omit<SendMessageInput, "QueueUrl">, caller: SqsAuthorizedMessageCaller, attempt?: ServiceIntegrationAttempt): Promise<SendMessageOutput> {
    await this.ensureStarted();
    const queue = this.resolveQueueArn(queueArn);
    await this.authorizeMessageProducer(queue, caller);
    return this.sendMessage(queue, { ...input, QueueUrl: queue.queueUrl }, { deliveryLineage: caller.deliveryLineage?.map(String).slice(-32), integrationAttempt: attempt });
  }

  async reconcileIntegrationAttempt(queueArn: string, attempt: ServiceIntegrationAttempt): Promise<any | undefined> { const receipt = (await this.storage.readQueue(queueArn)).integrationAttempts?.[attempt.attemptId]; if (receipt) assertMatchingIntegrationAttempt(receipt, attempt); return receipt ? structuredClone(receipt.output) : undefined; }
  async releaseIntegrationAttempt(queueArn: string, attemptId: string): Promise<void> { await this.storage.mutateQueue(queueArn, data => { if (data.integrationAttempts) delete data.integrationAttempts[attemptId]; }); }

  /** Validate a service/role producer without publishing a message. */
  async assertAuthorizedMessageDestination(queueArn: string, caller: SqsAuthorizedMessageCaller): Promise<void> {
    await this.ensureStarted();
    await this.authorizeMessageProducer(this.resolveQueueArn(queueArn), caller);
  }

  async sendAuthorizedMessageBatchToArn(queueArn: string, input: Omit<SendMessageBatchInput, "QueueUrl">, caller: SqsAuthorizedMessageCaller): Promise<SendMessageBatchOutput> {
    await this.ensureStarted();
    const queue = this.resolveQueueArn(queueArn);
    await this.authorizeMessageProducer(queue, caller);
    return this.sendMessageBatch(queue, input.Entries, caller.deliveryLineage?.map(String).slice(-32));
  }

  /** Alias retained for internal integrations that naturally spell ARN in title case. */
  async SendMessageToArn(queueArn: string, input: Omit<SendMessageInput, "QueueUrl">, attempt?: ServiceIntegrationAttempt): Promise<SendMessageOutput> {
    return this.sendMessageToArn(queueArn, input, attempt);
  }

  async ReceiveMessage(input: ReceiveMessageInput, context: SqsRequestContext = {}): Promise<ReceiveMessageOutput> {
    await this.ensureStarted();
    this.throwIfAborted(context.abortSignal);
    const queue = this.resolveQueueUrl(input.QueueUrl);
    if (input.ReceiveRequestAttemptId !== undefined) {
      if (queue.state.attributes.FifoQueue !== "true") throw new AwsError("InvalidParameterValue", "ReceiveRequestAttemptId is only valid for FIFO queues.", 400);
      input.ReceiveRequestAttemptId = fifoIdentifier(input.ReceiveRequestAttemptId, "ReceiveRequestAttemptId");
    }
    const maximum = numeric(input.MaxNumberOfMessages, "MaxNumberOfMessages", 1, 10, 1);
    const visibility = numeric(input.VisibilityTimeout, "VisibilityTimeout", 0, 43_200, Number(queue.state.attributes.VisibilityTimeout));
    const waitSeconds = numeric(input.WaitTimeSeconds, "WaitTimeSeconds", 0, 20, Number(queue.state.attributes.ReceiveMessageWaitTimeSeconds));
    const deadline = this.clock.now() + waitSeconds * 1000;
    while (true) {
      this.throwIfAborted(context.abortSignal);
      if (this.stopped) return {};
      const attempt = await this.tryReceive(queue, maximum, visibility, input, context.abortSignal);
      if (attempt.messages.length) {
        if (context.abortSignal?.aborted) {
          await this.releaseAbortedReceive(queue, attempt.messages);
          this.throwIfAborted(context.abortSignal);
        }
        await this.metric(queue.queueName, "NumberOfMessagesReceived", attempt.messages.length, "Count");
        await this.publishGauges(queue.state);
        if (context.abortSignal?.aborted) {
          await this.releaseAbortedReceive(queue, attempt.messages);
          this.throwIfAborted(context.abortSignal);
        }
        return { Messages: attempt.messages };
      }
      if (waitSeconds === 0 || this.stopped || this.clock.now() >= deadline) {
        await this.metric(queue.queueName, "NumberOfEmptyReceives", 1, "Count");
        await this.publishGauges(queue.state);
        return {};
      }
      const wakeAt = Math.min(deadline, attempt.nextAt ?? deadline);
      await this.waitForQueue(queue.queueArn, Math.max(0, wakeAt - this.clock.now()), context.abortSignal);
      this.throwIfAborted(context.abortSignal);
      if (this.stopped) return {};
      if (!this.accountRegion(queue.ownerAccountId)?.sqsQueues[queue.queueName]) throw this.missingQueue();
    }
  }

  async DeleteMessage(input: DeleteMessageInput): Promise<Record<string, never>> {
    await this.ensureStarted();
    const queue = this.resolveQueueUrl(input.QueueUrl);
    const receipt = String(input.ReceiptHandle ?? "");
    if (!receipt) throw new AwsError("ReceiptHandleIsInvalid", "The input receipt handle is invalid.", 400);
    const deleted = await this.storage.mutateQueue(queue.queueArn, data => {
      this.removeExpired(data);
      const found = Object.values(data.messages).find(message => message.currentReceiptHandle === receipt && (message.invisibleUntil ?? 0) > this.clock.now());
      if (!found) return false;
      delete data.messages[found.messageId];
      return true;
    });
    if (!deleted) throw new AwsError("ReceiptHandleIsInvalid", "The input receipt handle is invalid or has expired.", 400);
    await this.metric(queue.queueName, "NumberOfMessagesDeleted", 1, "Count");
    await this.publishGauges(queue.state);
    return {};
  }

  async ChangeMessageVisibility(input: ChangeMessageVisibilityInput): Promise<Record<string, never>> {
    await this.ensureStarted();
    const queue = this.resolveQueueUrl(input.QueueUrl);
    const visibility = numeric(input.VisibilityTimeout, "VisibilityTimeout", 0, 43_200);
    const receipt = String(input.ReceiptHandle ?? "");
    const changed = await this.storage.mutateQueue(queue.queueArn, data => {
      this.removeExpired(data);
      const found = Object.values(data.messages).find(message => message.currentReceiptHandle === receipt && (message.invisibleUntil ?? 0) > this.clock.now());
      if (!found) return false;
      found.invisibleUntil = this.clock.now() + visibility * 1000;
      found.leaseMutationVersion = (found.leaseMutationVersion ?? 0) + 1;
      return true;
    });
    if (!changed) throw new AwsError("ReceiptHandleIsInvalid", "The input receipt handle is invalid or has expired.", 400);
    if (visibility === 0) this.notify(queue.queueArn);
    await this.publishGauges(queue.state);
    return {};
  }

  async SendMessageBatch(input: SendMessageBatchInput): Promise<SendMessageBatchOutput> {
    await this.ensureStarted();
    const queue = this.resolveQueueUrl(input.QueueUrl);
    return this.sendMessageBatch(queue, input.Entries);
  }

  private async sendMessageBatch(queue: ResolvedSqsQueue, rawEntries: SendMessageBatchRequestEntry[], deliveryLineage?: string[]): Promise<SendMessageBatchOutput> {
    const entries = this.batchEntries<SendMessageBatchRequestEntry>(rawEntries);
    const rawBytes = entries.reduce((total, entry) => {
      let attributeBytes = 0;
      // Entry-level validation belongs in the partial-result loop below. An
      // invalid attribute must not turn the whole batch into a top-level error.
      try { attributeBytes = messageAttributeBytes(normalizeAttributeMap(entry.MessageAttributes)); } catch { /* reported for this entry below */ }
      return total + Buffer.byteLength(String(entry.MessageBody ?? "")) + attributeBytes;
    }, 0);
    if (rawBytes > MAX_MESSAGE_BYTES) throw new AwsError("BatchRequestTooLong", "The length of all the messages put together is more than the limit.", 400);
    const Successful: SendMessageBatchResultEntry[] = [];
    const Failed: BatchResultErrorEntry[] = [];
    for (const entry of entries) {
      try {
        const { Id, ...message } = entry;
        const result = await this.sendMessage(queue, { ...message, QueueUrl: queue.queueUrl }, { deliveryLineage });
        Successful.push({ Id, ...result });
      } catch (error) { Failed.push(this.batchFailure(entry.Id, error)); }
    }
    return { ...(Successful.length ? { Successful } : {}), ...(Failed.length ? { Failed } : {}) };
  }

  async DeleteMessageBatch(input: DeleteMessageBatchInput): Promise<DeleteMessageBatchOutput> {
    const queue = this.resolveQueueUrl(input.QueueUrl);
    const entries = this.batchEntries<DeleteMessageBatchRequestEntry>(input.Entries);
    const Successful: DeleteMessageBatchResultEntry[] = [];
    const Failed: BatchResultErrorEntry[] = [];
    for (const entry of entries) {
      try { await this.DeleteMessage({ QueueUrl: queue.queueUrl, ReceiptHandle: entry.ReceiptHandle }); Successful.push({ Id: entry.Id }); }
      catch (error) { Failed.push(this.batchFailure(entry.Id, error)); }
    }
    return { ...(Successful.length ? { Successful } : {}), ...(Failed.length ? { Failed } : {}) };
  }

  async ChangeMessageVisibilityBatch(input: ChangeMessageVisibilityBatchInput): Promise<ChangeMessageVisibilityBatchOutput> {
    const queue = this.resolveQueueUrl(input.QueueUrl);
    const entries = this.batchEntries<ChangeMessageVisibilityBatchRequestEntry>(input.Entries);
    const Successful: ChangeMessageVisibilityBatchResultEntry[] = [];
    const Failed: BatchResultErrorEntry[] = [];
    for (const entry of entries) {
      try { await this.ChangeMessageVisibility({ QueueUrl: queue.queueUrl, ReceiptHandle: entry.ReceiptHandle, VisibilityTimeout: entry.VisibilityTimeout }); Successful.push({ Id: entry.Id }); }
      catch (error) { Failed.push(this.batchFailure(entry.Id, error)); }
    }
    return { ...(Successful.length ? { Successful } : {}), ...(Failed.length ? { Failed } : {}) };
  }

  async PurgeQueue(input: QueueUrlInput): Promise<Record<string, never>> {
    await this.ensureStarted();
    const queue = this.resolveQueueUrl(input.QueueUrl);
    if ((queue.state.purgeAvailableAt ?? 0) > this.clock.now()) throw new AwsError("PurgeQueueInProgress", "Only one PurgeQueue operation on a queue is allowed every 60 seconds.", 403);
    await this.storage.purgeQueue(queue.queueArn);
    queue.state.purgeAvailableAt = this.clock.now() + PURGE_COOLDOWN_MS;
    queue.state.lastModified = this.clock.now();
    await this.store.save();
    this.notify(queue.queueArn);
    await this.publishGauges(queue.state);
    return {};
  }

  async ListDeadLetterSourceQueues(input: ListDeadLetterSourceQueuesInput): Promise<ListDeadLetterSourceQueuesOutput> {
    const target = this.resolveQueueUrl(input.QueueUrl);
    const names = this.deadLetterSources(target.queueArn).map(queue => queue.queueName).sort(utf8Compare);
    const page = this.page("ListDeadLetterSourceQueues", names, input.MaxResults, input.NextToken, target.queueArn);
    return { ...(page.items.length ? { queueUrls: page.items.map(name => this.queueUrl(name)) } : {}), ...(page.nextToken ? { NextToken: page.nextToken } : {}) };
  }

  async receiveForConsumer(input: SqsConsumerReceiveInput): Promise<SqsConsumerReceiveOutput> {
    const queue = this.resolveQueueArn(input.queueArn);
    if (input.roleArn) {
      for (const action of ["sqs:GetQueueAttributes", "sqs:ReceiveMessage", "sqs:ChangeMessageVisibility"]) {
        const decision = this.roleQueueAuthorization(queue, input.roleArn, action);
        await this.recordAuthorization(input.roleArn, action, queue.queueArn, decision);
        if (decision.decision !== "allowed") throw new AwsError("AccessDeniedException", `${input.roleArn} is not authorized to consume ${queue.queueArn}. ${decision.reason}`, 403);
      }
    }
    const result = await this.ReceiveMessage({
      QueueUrl: queue.queueUrl,
      MaxNumberOfMessages: input.maxNumberOfMessages,
      VisibilityTimeout: input.visibilityTimeoutSeconds,
      WaitTimeSeconds: input.waitTimeSeconds ?? 0,
      AttributeNames: ["All"],
      MessageAttributeNames: ["All"],
      MessageSystemAttributeNames: ["All"],
    }, { abortSignal: input.abortSignal });
    return { messages: result.Messages ?? [] };
  }

  async acknowledge(input: SqsConsumerAcknowledgeInput): Promise<void> {
    const queue = this.resolveQueueArn(input.queueArn);
    if (input.roleArn) {
      const decision = this.roleQueueAuthorization(queue, input.roleArn, "sqs:DeleteMessage");
      await this.recordAuthorization(input.roleArn, "sqs:DeleteMessage", queue.queueArn, decision);
      if (decision.decision !== "allowed") throw new AwsError("AccessDeniedException", `${input.roleArn} is not authorized to acknowledge messages from ${queue.queueArn}. ${decision.reason}`, 403);
    }
    for (const ReceiptHandle of input.receiptHandles) await this.DeleteMessage({ QueueUrl: queue.queueUrl, ReceiptHandle });
  }

  async acknowledgeMessages(queueArn: string, receiptHandles: string[]): Promise<void> {
    await this.acknowledge({ queueArn, receiptHandles });
  }

  private async sendMessage(queue: ResolvedSqsQueue, input: SendMessageInput, internal: { deliveryLineage?: string[]; integrationAttempt?: ServiceIntegrationAttempt } = {}): Promise<SendMessageOutput> {
    if (internal.integrationAttempt) { const prior = await this.reconcileIntegrationAttempt(queue.queueArn, internal.integrationAttempt); if (prior !== undefined) return prior; }
    const isFifo = queue.state.attributes.FifoQueue === "true";
    let messageGroupId: string | undefined;
    let messageDeduplicationId: string | undefined;
    if (isFifo) {
      if (input.DelaySeconds !== undefined) throw new AwsError("InvalidParameterValue", "DelaySeconds is not supported for individual messages sent to a FIFO queue.", 400);
      if (input.MessageGroupId === undefined) throw new AwsError("MissingParameter", "The request must contain the parameter MessageGroupId.", 400);
      messageGroupId = fifoIdentifier(input.MessageGroupId, "MessageGroupId");
      if (input.MessageDeduplicationId !== undefined) messageDeduplicationId = fifoIdentifier(input.MessageDeduplicationId, "MessageDeduplicationId");
      else if (queue.state.attributes.ContentBasedDeduplication === "true") messageDeduplicationId = createHash("sha256").update(String(input.MessageBody ?? ""), "utf8").digest("hex");
      else throw new AwsError("MissingParameter", "The request must contain the parameter MessageDeduplicationId.", 400);
    } else {
      if (input.MessageDeduplicationId !== undefined) throw new AwsError("InvalidParameterValue", "MessageDeduplicationId is valid only for FIFO queues.", 400);
      if (input.MessageGroupId !== undefined) messageGroupId = fifoIdentifier(input.MessageGroupId, "MessageGroupId");
    }
    if (input.MessageBody === undefined || typeof input.MessageBody !== "string") throw new AwsError("MissingParameter", "The request must contain the parameter MessageBody.", 400);
    if (Buffer.byteLength(input.MessageBody) === 0) throw new AwsError("InvalidParameterValue", "The message body must contain at least one byte.", 400);
    if (!validXmlCharacters(input.MessageBody)) throw new AwsError("InvalidMessageContents", "The message contains characters outside the allowed set.", 400);
    const messageAttributes = normalizeAttributeMap(input.MessageAttributes);
    if (Object.keys(messageAttributes).length > 10) throw new AwsError("InvalidParameterValue", "A message can contain no more than 10 message attributes.", 400);
    const messageSystemAttributes = normalizeAttributeMap(input.MessageSystemAttributes);
    for (const [name, value] of Object.entries(messageSystemAttributes)) if (name !== "AWSTraceHeader" || !value.DataType.startsWith("String") || value.StringValue === undefined) throw new AwsError("InvalidParameterValue", "AWSTraceHeader is the only supported message system attribute and must be a String.", 400);
    // SQS system attributes, including AWSTraceHeader, do not count toward the
    // message size quota.
    const size = Buffer.byteLength(input.MessageBody) + messageAttributeBytes(messageAttributes);
    if (size > Number(queue.state.attributes.MaximumMessageSize) || size > MAX_MESSAGE_BYTES) throw new AwsError("InvalidParameterValue", "One or more parameters are invalid. Reason: Message must be shorter than the queue maximum.", 400);
    const delay = numeric(input.DelaySeconds, "DelaySeconds", 0, 900, Number(queue.state.attributes.DelaySeconds));
    const messageId = randomUUID();
    const md5Body = md5OfMessageBody(input.MessageBody);
    const md5Attributes = md5OfMessageAttributes(messageAttributes);
    const md5SystemAttributes = md5OfMessageAttributes(messageSystemAttributes);
    const response = (acceptedMessageId: string, sequenceNumber?: string): SendMessageOutput => ({ MD5OfMessageBody: md5Body, ...(md5Attributes ? { MD5OfMessageAttributes: md5Attributes } : {}), ...(md5SystemAttributes ? { MD5OfMessageSystemAttributes: md5SystemAttributes } : {}), MessageId: acceptedMessageId, ...(sequenceNumber ? { SequenceNumber: sequenceNumber } : {}) });
    const payload: SqsStoredMessagePayload = { body: input.MessageBody, messageAttributes, messageSystemAttributes };
    const blobId = await this.storage.putPayload(messageId, payload);
    const now = this.clock.now();
    const stored = await this.storage.mutateQueue(queue.queueArn, data => {
      const existingAttempt = internal.integrationAttempt ? data.integrationAttempts?.[internal.integrationAttempt.attemptId] : undefined;
      if (existingAttempt) { assertMatchingIntegrationAttempt(existingAttempt, internal.integrationAttempt!); return { duplicate: true, messageId: String((existingAttempt.output as any)?.MessageId ?? ""), sequenceNumber: (existingAttempt.output as any)?.SequenceNumber, integrationOutput: structuredClone(existingAttempt.output) as SendMessageOutput }; }
      if (!this.accountRegion(queue.ownerAccountId)?.sqsQueues[queue.queueName]) throw this.missingQueue();
      this.removeExpired(data);
      let sequenceNumber: string | undefined;
      if (isFifo) {
        const deduplicationKey = queue.state.attributes.DeduplicationScope === "messageGroup" ? `${messageGroupId}\u0000${messageDeduplicationId}` : messageDeduplicationId!;
        const duplicate = data.deduplication?.[deduplicationKey];
        if (duplicate && duplicate.expiresAt > now) { const output = response(duplicate.messageId, duplicate.sequenceNumber); if (internal.integrationAttempt) { data.integrationAttempts ??= {}; data.integrationAttempts[internal.integrationAttempt.attemptId] = acceptedIntegrationAttempt(internal.integrationAttempt, output, now); } return { duplicate: true, messageId: duplicate.messageId, sequenceNumber: duplicate.sequenceNumber, integrationOutput: output }; }
        sequenceNumber = BigInt(data.nextSequenceNumber ?? "1").toString();
        data.nextSequenceNumber = (BigInt(sequenceNumber) + 1n).toString();
        data.deduplication ??= {};
        data.deduplication[deduplicationKey] = { expiresAt: now + FIFO_DEDUPLICATION_WINDOW_MS, messageId, sequenceNumber };
      }
      data.messages[messageId] = {
        messageId, blobId, md5OfBody: md5Body, ...(md5Attributes ? { md5OfMessageAttributes: md5Attributes } : {}),
        ...(md5SystemAttributes ? { md5OfMessageSystemAttributes: md5SystemAttributes } : {}), sentAt: now,
        availableAt: now + delay * 1000, retentionUntil: now + Number(queue.state.attributes.MessageRetentionPeriod) * 1000,
        receiveCount: 0, receiptVersion: 0, leaseMutationVersion: 0,
        ...(messageGroupId ? { messageGroupId } : {}),
        ...(messageDeduplicationId ? { messageDeduplicationId } : {}),
        ...(sequenceNumber ? { sequenceNumber } : {}),
        sqsManagedSse: queue.state.attributes.SqsManagedSseEnabled === "true",
        ...(internal.deliveryLineage?.length ? { deliveryLineage: internal.deliveryLineage.slice(-32) } : {}),
      };
      const output = response(messageId, sequenceNumber); if (internal.integrationAttempt) { data.integrationAttempts ??= {}; data.integrationAttempts[internal.integrationAttempt.attemptId] = acceptedIntegrationAttempt(internal.integrationAttempt, output, now); } return { duplicate: false, messageId, sequenceNumber, integrationOutput: output };
    });
    if (stored.duplicate) {
      await this.storage.discardPayload(blobId);
      await this.metric(queue.queueName, "NumberOfDeduplicatedSentMessages", 1, "Count");
      await this.publishGauges(queue.state);
      return stored.integrationOutput ?? response(stored.messageId, stored.sequenceNumber);
    }
    await this.metric(queue.queueName, "NumberOfMessagesSent", 1, "Count");
    await this.metric(queue.queueName, "SentMessageSize", size, "Bytes");
    await this.publishGauges(queue.state);
    this.notify(queue.queueArn);
    return stored.integrationOutput ?? response(stored.messageId, stored.sequenceNumber);
  }

  private async tryReceive(queue: ResolvedSqsQueue, maximum: number, visibility: number, input: ReceiveMessageInput, abortSignal?: AbortSignal): Promise<{ messages: SqsMessage[]; nextAt?: number }> {
    while (true) {
      this.throwIfAborted(abortSignal);
      const now = this.clock.now();
      let redrive = this.readRedrivePolicy(queue.state.attributes.RedrivePolicy, false);
      let redriveTarget: ResolvedSqsQueue | undefined;
      if (redrive) {
        try { redriveTarget = this.resolveQueueArn(redrive.deadLetterTargetArn); }
        catch { redrive = undefined; }
      }
      const leased = await this.storage.mutateQueue(queue.queueArn, data => {
        this.throwIfAborted(abortSignal);
        this.removeExpired(data);
        const ordered = Object.values(data.messages).sort((left, right) => left.sentAt - right.sentAt || utf8Compare(left.messageId, right.messageId));
        const receiveAttempt = input.ReceiveRequestAttemptId ? data.receiveAttempts?.[input.ReceiveRequestAttemptId] : undefined;
        if (receiveAttempt && receiveAttempt.expiresAt > now) {
          const replayed: SqsStoredMessage[] = [];
          for (const recorded of receiveAttempt.messages) {
            const message = data.messages[recorded.messageId];
            if (!message || message.currentReceiptHandle !== recorded.receiptHandle || (message.leaseMutationVersion ?? 0) !== recorded.leaseMutationVersion) continue;
            message.invisibleUntil = now + visibility * 1000;
            replayed.push(structuredClone(message));
          }
          return { selected: replayed, nextAt: undefined as number | undefined, replay: true };
        }
        const visible = this.selectMessagesForReceive(queue, data, maximum, now);
        const poison = redrive ? visible.find(message => message.receiveCount >= redrive.maxReceiveCount) : undefined;
        if (poison) return { redriveId: poison.messageId, selected: [] as SqsStoredMessage[], nextAt: undefined as number | undefined };
        const selected = visible.slice(0, maximum);
        for (const message of selected) {
          message.receiveCount += 1;
          message.receiptVersion += 1;
          message.leaseMutationVersion = (message.leaseMutationVersion ?? 0) + 1;
          message.firstReceivedAt ??= now;
          message.currentReceiptHandle = `AQEB${Buffer.from(JSON.stringify({ q: queue.queueArn, m: message.messageId, v: message.receiptVersion, r: randomUUID() })).toString("base64url")}`;
          message.invisibleUntil = now + visibility * 1000;
        }
        if (input.ReceiveRequestAttemptId) {
          data.receiveAttempts ??= {};
          data.receiveAttempts[input.ReceiveRequestAttemptId] = {
            expiresAt: now + RECEIVE_ATTEMPT_WINDOW_MS,
            messages: selected.map(message => ({ messageId: message.messageId, receiptHandle: message.currentReceiptHandle!, leaseMutationVersion: message.leaseMutationVersion! })),
          };
        }
        const nextAt = ordered.map(message => message.availableAt > now ? message.availableAt : (message.invisibleUntil ?? 0) > now ? message.invisibleUntil! : undefined).filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0];
        return { selected: structuredClone(selected), nextAt };
      });
      if ("redriveId" in leased && leased.redriveId) {
        if (!redrive || !redriveTarget) continue;
        const fifoMove = queue.state.attributes.FifoQueue === "true";
        const moved = await this.storage.moveMessage(queue.queueArn, redriveTarget.queueArn, leased.redriveId, (message, transferId, destination) => {
          let sequenceNumber = message.sequenceNumber;
          if (fifoMove) {
            sequenceNumber = BigInt(destination.nextSequenceNumber ?? "1").toString();
            destination.nextSequenceNumber = (BigInt(sequenceNumber) + 1n).toString();
            destination.deduplication ??= {};
            const deduplicationKey = redriveTarget!.state.attributes.DeduplicationScope === "messageGroup" ? `${message.messageGroupId}\u0000${message.messageId}` : message.messageId;
            destination.deduplication[deduplicationKey] = { expiresAt: now + FIFO_DEDUPLICATION_WINDOW_MS, messageId: message.messageId, sequenceNumber };
          }
          return {
            ...message,
            transferId,
            deadLetteredAt: now,
            availableAt: now,
            invisibleUntil: undefined,
            currentReceiptHandle: undefined,
            leaseMutationVersion: (message.leaseMutationVersion ?? 0) + 1,
            ...(fifoMove ? {
              sentAt: now,
              retentionUntil: now + Number(redriveTarget!.state.attributes.MessageRetentionPeriod) * 1000,
              messageDeduplicationId: message.messageId,
              sequenceNumber,
            } : {}),
          };
        });
        if (moved) {
          this.notify(redriveTarget.queueArn);
          await this.telemetry.publish({ namespace: "AWS/SQS", metricName: "NumberOfMessagesMovedToDeadLetterQueue", dimensions: { SourceQueue: queue.queueName, DeadLetterQueue: redriveTarget.queueName }, value: 1, unit: "Count", timestamp: this.clock.now() });
          await this.publishGauges(queue.state); await this.publishGauges(redriveTarget.state);
        }
        continue;
      }
      if (abortSignal?.aborted) {
        await this.releaseAbortedReceive(queue, leased.selected.map(message => ({ MessageId: message.messageId, ReceiptHandle: message.currentReceiptHandle })));
        this.throwIfAborted(abortSignal);
      }
      const messages: SqsMessage[] = [];
      for (const message of leased.selected) {
        messages.push(await this.materializeMessage(message, input));
        if (abortSignal?.aborted) {
          await this.releaseAbortedReceive(queue, leased.selected.map(selected => ({ MessageId: selected.messageId, ReceiptHandle: selected.currentReceiptHandle })));
          this.throwIfAborted(abortSignal);
        }
      }
      return { messages, nextAt: leased.nextAt };
    }
  }

  private selectMessagesForReceive(queue: ResolvedSqsQueue, data: SqsQueueData, maximum: number, now: number): SqsStoredMessage[] {
    const ordered = Object.values(data.messages).sort((left, right) => {
      if (queue.state.attributes.FifoQueue === "true" && left.sequenceNumber !== undefined && right.sequenceNumber !== undefined) {
        const sequenceOrder = BigInt(left.sequenceNumber) < BigInt(right.sequenceNumber) ? -1 : BigInt(left.sequenceNumber) > BigInt(right.sequenceNumber) ? 1 : 0;
        if (sequenceOrder) return sequenceOrder;
      }
      return left.sentAt - right.sentAt || utf8Compare(left.messageId, right.messageId);
    });
    if (queue.state.attributes.FifoQueue === "true") {
      const groups = new Map<string, SqsStoredMessage[]>();
      for (const message of ordered) {
        const group = message.messageGroupId ?? `legacy:${message.messageId}`;
        const values = groups.get(group) ?? [];
        values.push(message);
        groups.set(group, values);
      }
      const ready = [...groups.values()].map(messages => {
        const prefix: SqsStoredMessage[] = [];
        for (const message of messages) {
          if (message.availableAt > now || (message.invisibleUntil ?? 0) > now) break;
          prefix.push(message);
        }
        return prefix;
      }).filter(messages => messages.length).sort((left, right) => {
        if (left[0].sequenceNumber !== undefined && right[0].sequenceNumber !== undefined) {
          if (BigInt(left[0].sequenceNumber) < BigInt(right[0].sequenceNumber)) return -1;
          if (BigInt(left[0].sequenceNumber) > BigInt(right[0].sequenceNumber)) return 1;
        }
        return left[0].sentAt - right[0].sentAt || utf8Compare(left[0].messageId, right[0].messageId);
      });
      const selected: SqsStoredMessage[] = [];
      for (const group of ready) {
        selected.push(...group.slice(0, maximum - selected.length));
        if (selected.length >= maximum) break;
      }
      return selected;
    }

    const visible = ordered.filter(message => message.availableAt <= now && (message.invisibleUntil ?? 0) <= now);
    const groups = new Map<string, SqsStoredMessage[]>();
    for (const message of visible) {
      const group = message.messageGroupId ?? `\u0000${String(message.sentAt).padStart(16, "0")}:${message.messageId}`;
      const values = groups.get(group) ?? [];
      values.push(message);
      groups.set(group, values);
    }
    const keys = [...groups.keys()].sort(utf8Compare);
    if (!keys.length) return [];
    let index = data.fairGroupCursor === undefined ? 0 : Math.max(0, keys.findIndex(key => utf8Compare(key, data.fairGroupCursor!) > 0));
    const selected: SqsStoredMessage[] = [];
    while (selected.length < maximum && [...groups.values()].some(messages => messages.length)) {
      let progressed = false;
      for (let offset = 0; offset < keys.length && selected.length < maximum; offset += 1) {
        const key = keys[(index + offset) % keys.length];
        const message = groups.get(key)?.shift();
        if (!message) continue;
        selected.push(message);
        data.fairGroupCursor = key;
        progressed = true;
      }
      if (!progressed) break;
      index = (keys.indexOf(data.fairGroupCursor ?? keys[0]) + 1) % keys.length;
    }
    return selected;
  }

  private async materializeMessage(message: SqsStoredMessage, input: ReceiveMessageInput): Promise<SqsMessage> {
    const payload = await this.storage.readPayload(message.blobId);
    const attributeNames = asArray(input.AttributeNames).map(String);
    const systemNames = asArray(input.MessageSystemAttributeNames).map(String);
    const requestedSystem = [...attributeNames, ...systemNames];
    const availableSystem: Record<string, string> = {
      SenderId: this.store.accountId,
      SentTimestamp: String(message.sentAt),
      ApproximateReceiveCount: String(message.receiveCount),
      ...(message.firstReceivedAt === undefined ? {} : { ApproximateFirstReceiveTimestamp: String(message.firstReceivedAt) }),
      ...(message.messageGroupId === undefined ? {} : { MessageGroupId: message.messageGroupId }),
      ...(message.messageDeduplicationId === undefined ? {} : { MessageDeduplicationId: message.messageDeduplicationId }),
      ...(message.sequenceNumber === undefined ? {} : { SequenceNumber: message.sequenceNumber }),
      ...Object.fromEntries(Object.entries(payload.messageSystemAttributes).filter(([, value]) => value.StringValue !== undefined).map(([name, value]) => [name, value.StringValue!])),
    };
    const Attributes = Object.fromEntries(Object.entries(availableSystem).filter(([name]) => requested(name, requestedSystem)));
    const requestedAttributes = asArray(input.MessageAttributeNames).map(String);
    const MessageAttributes = Object.fromEntries(Object.entries(payload.messageAttributes).filter(([name]) => requested(name, requestedAttributes)));
    const result: SqsMessage = {
      MessageId: message.messageId, ReceiptHandle: message.currentReceiptHandle, MD5OfBody: message.md5OfBody, Body: payload.body,
      ...(Object.keys(Attributes).length ? { Attributes } : {}),
      ...(message.md5OfMessageAttributes ? { MD5OfMessageAttributes: message.md5OfMessageAttributes } : {}),
      ...(Object.keys(MessageAttributes).length ? { MessageAttributes } : {}),
    };
    if (message.deliveryLineage?.length) Object.defineProperty(result, "deliveryLineage", { value: message.deliveryLineage.slice(-32), enumerable: false });
    return result;
  }

  private async ensureStarted(): Promise<void> {
    if (!this.startPromise) await this.start();
    else await this.startPromise;
    if (this.stopped) throw new AwsError("InternalError", "The SQS service is stopping.", 500);
  }

  private async authorizeMessageProducer(queue: ResolvedSqsQueue, caller: SqsAuthorizedMessageCaller): Promise<void> {
    const decision = caller.kind === "service"
      ? evaluateSqsQueuePolicy(queue.state.attributes.Policy, { type: "Service", service: caller.principal }, "sqs:SendMessage", queue.queueArn, {
          "aws:SourceArn": caller.sourceArn,
          "aws:SourceAccount": caller.sourceAccount,
          "aws:RequestedRegion": this.region,
          "aws:CurrentTime": new Date(this.clock.now()).toISOString(),
        })
      : this.roleQueueAuthorization(queue, caller.roleArn, "sqs:SendMessage", {
          ...(caller.sourceArn ? { "aws:SourceArn": caller.sourceArn } : {}),
          ...(caller.sourceAccount ? { "aws:SourceAccount": caller.sourceAccount } : {}),
        });
    const principalArn = caller.kind === "service" ? caller.principal : caller.roleArn;
    await this.recordAuthorization(principalArn, "sqs:SendMessage", queue.queueArn, decision);
    if (decision.decision !== "allowed") throw new AwsError("AccessDeniedException", `${principalArn} is not authorized to send messages to ${queue.queueArn}. ${decision.reason}`, 403);
  }

  private roleQueueAuthorization(queue: ResolvedSqsQueue, roleArn: string, action: string, extraContext: AuthorizationContext = {}): AuthorizationResult {
    const callerAccountId = roleArn.match(/^arn:[a-z0-9-]+:iam::(\d{12}):role\//i)?.[1];
    const context: AuthorizationContext = {
      "aws:PrincipalArn": roleArn,
      ...(callerAccountId ? { "aws:PrincipalAccount": callerAccountId } : {}),
      "aws:RequestedRegion": this.region,
      "aws:CurrentTime": new Date(this.clock.now()).toISOString(),
      ...extraContext,
    };
    const identity = callerAccountId
      ? evaluateRoleAuthorization(this.store.ensureAccount(callerAccountId).iam, roleArn, action, queue.queueArn, context)
      : { decision: "implicitDeny" as const, reason: "The caller role ARN is invalid", matchedStatements: [] };
    const resource = evaluateSqsQueuePolicy(queue.state.attributes.Policy, { type: "AWS", arn: roleArn, ...(callerAccountId ? { accountId: callerAccountId } : {}) }, action, queue.queueArn, context);
    return combineIdentityAndResourceAuthorization(identity, resource, callerAccountId === queue.ownerAccountId ? "sameAccount" : "crossAccount");
  }

  private async recordAuthorization(principalArn: string, action: string, resource: string, decision: AuthorizationResult): Promise<void> {
    const accountId = principalArn.match(/^arn:[a-z0-9-]+:(?:iam|sts)::(\d{12}):/i)?.[1] ?? resource.match(/^arn:[a-z0-9-]+:sqs:[^:]+:(\d{12}):/i)?.[1] ?? this.store.accountId;
    const decisions = this.store.ensureAccount(accountId).iam.authorizationDecisions;
    decisions.push({ time: this.clock.now(), requestId: randomUUID(), principalArn, action, resource, decision: decision.decision, reason: decision.reason });
    if (decisions.length > 1_000) decisions.splice(0, decisions.length - 1_000);
    await this.store.save();
  }

  private throwPolicyError(error: unknown, addPermission: boolean): never {
    if (error instanceof SqsPolicyValidationError) {
      if (error.kind === "limit") throw new AwsError(addPermission ? "OverLimit" : "InvalidAttributeValue", error.message, 400);
      throw new AwsError("InvalidParameterValue", error.message, 400);
    }
    throw error;
  }

  private regionState() {
    return this.store.regionState(this.region);
  }

  private accountRegion(accountId: string) {
    return this.store.state.accounts[accountId]?.regions[this.region];
  }

  private missingQueue(): AwsError {
    return new AwsError("QueueDoesNotExist", "The specified queue does not exist or you do not have access to it.", 400);
  }

  private removeExpired(data: SqsQueueData): void {
    const now = this.clock.now();
    for (const [messageId, message] of Object.entries(data.messages)) if (message.retentionUntil <= now) delete data.messages[messageId];
    for (const [key, record] of Object.entries(data.deduplication ?? {})) if (record.expiresAt <= now) delete data.deduplication![key];
    for (const [key, record] of Object.entries(data.receiveAttempts ?? {})) if (record.expiresAt <= now) delete data.receiveAttempts![key];
  }

  private pruneQueueDeletionTimes(): boolean {
    const deletionTimes = this.regionState().sqsQueueDeletionTimes;
    const now = this.clock.now();
    let changed = false;
    for (const [name, deletedAt] of Object.entries(deletionTimes)) {
      if (now - deletedAt < QUEUE_DELETE_COOLDOWN_MS) continue;
      delete deletionTimes[name];
      changed = true;
    }
    return changed;
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new SqsRequestAbortedError();
  }

  private async releaseAbortedReceive(queue: ResolvedSqsQueue, messages: SqsMessage[]): Promise<void> {
    const receipts = new Map(messages.filter(message => message.MessageId && message.ReceiptHandle).map(message => [message.MessageId!, message.ReceiptHandle!]));
    if (!receipts.size || !this.accountRegion(queue.ownerAccountId)?.sqsQueues[queue.queueName]) return;
    await this.storage.mutateQueue(queue.queueArn, data => {
      for (const [messageId, receipt] of receipts) {
        const message = data.messages[messageId];
        if (!message || message.currentReceiptHandle !== receipt) continue;
        message.currentReceiptHandle = undefined;
        message.invisibleUntil = undefined;
        message.leaseMutationVersion = (message.leaseMutationVersion ?? 0) + 1;
        message.receiveCount = Math.max(0, message.receiveCount - 1);
        message.receiptVersion = Math.max(0, message.receiptVersion - 1);
        if (message.receiveCount === 0) message.firstReceivedAt = undefined;
      }
    });
    this.notify(queue.queueArn);
  }

  private applyPendingAttributeValues(queue: SqsQueueState): void {
    const pending = queue.pendingAttributeUpdate;
    if (!pending) return;
    for (const [name, value] of Object.entries(pending.attributes)) {
      if (value === null) delete (queue.attributes as any)[name];
      else (queue.attributes as any)[name] = value;
    }
    queue.lastModified = pending.lastModified;
  }

  private async applyPendingAttributeStorage(queue: SqsQueueState): Promise<void> {
    const retention = queue.pendingAttributeUpdate?.attributes.MessageRetentionPeriod;
    const delay = queue.attributes.FifoQueue === "true" ? queue.pendingAttributeUpdate?.attributes.DelaySeconds : undefined;
    if ((retention === undefined || retention === null) && (delay === undefined || delay === null)) return;
    const retentionMs = retention === undefined || retention === null ? undefined : Number(retention) * 1000;
    const delayMs = delay === undefined || delay === null ? undefined : Number(delay) * 1000;
    await this.storage.mutateQueue(queue.queueArn, data => {
      // Expire against the previously committed deadlines before extending a
      // retention period. Deleted records cannot be resurrected by the update.
      this.removeExpired(data);
      for (const message of Object.values(data.messages)) {
        if (retentionMs !== undefined) message.retentionUntil = message.sentAt + retentionMs;
        if (delayMs !== undefined) message.availableAt = message.sentAt + delayMs;
      }
    });
  }

  private async recoverPendingAttributeUpdates(): Promise<void> {
    for (const queue of Object.values(this.regionState().sqsQueues)) {
      if (!queue.pendingAttributeUpdate) continue;
      await this.completePendingAttributeUpdate(queue);
    }
  }

  private async completePendingAttributeUpdate(queue: SqsQueueState): Promise<void> {
    if (!queue.pendingAttributeUpdate) return;
    this.applyPendingAttributeValues(queue);
    await this.applyPendingAttributeStorage(queue);
    delete queue.pendingAttributeUpdate;
    await this.store.save();
  }

  private async serializeAttributeUpdate<T>(queueArn: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.attributeUpdateTails.get(queueArn) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(operation);
    const tail = running.then(() => undefined, () => undefined);
    this.attributeUpdateTails.set(queueArn, tail);
    try { return await running; }
    finally { if (this.attributeUpdateTails.get(queueArn) === tail) this.attributeUpdateTails.delete(queueArn); }
  }

  private batchEntries<T extends { Id: string }>(raw: T[] | undefined): T[] {
    const entries = asArray(raw);
    if (!entries.length) throw new AwsError("EmptyBatchRequest", "There should be at least one entry in the request.", 400);
    if (entries.length > 10) throw new AwsError("TooManyEntriesInBatchRequest", "Maximum number of entries per request are 10.", 400);
    const ids = new Set<string>();
    for (const entry of entries) {
      entry.Id = String(entry.Id ?? "");
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(entry.Id)) throw new AwsError("InvalidBatchEntryId", `The Id ${entry.Id} is invalid.`, 400);
      if (ids.has(entry.Id)) throw new AwsError("BatchEntryIdsNotDistinct", "Two or more batch entries in the request have the same Id.", 400);
      ids.add(entry.Id);
    }
    return entries;
  }

  private batchFailure(id: string, error: unknown): BatchResultErrorEntry {
    const aws = error instanceof AwsError ? error : new AwsError("InternalError", error instanceof Error ? error.message : String(error), 500);
    return { Id: id, Code: aws.code, Message: aws.message, SenderFault: aws.status < 500 };
  }

  private page(operation: string, values: string[], rawMaximum: unknown, token: unknown, fingerprint: string): { items: string[]; nextToken?: string } {
    const maximum = numeric(rawMaximum, "MaxResults", 1, 1000, 1000);
    let start = 0;
    if (token !== undefined) {
      try {
        const cursor = this.pagination.decode<PageCursor>(operation, String(token));
        if (cursor.fingerprint !== fingerprint) throw new Error("mismatch");
        start = values.findIndex(value => utf8Compare(value, cursor.after) > 0);
        if (start < 0) start = values.length;
      } catch { throw new AwsError("InvalidParameterValue", "The supplied NextToken is invalid.", 400); }
    }
    const items = values.slice(start, start + maximum);
    const nextToken = start + items.length < values.length && items.length ? this.pagination.encode(operation, { after: items.at(-1)!, fingerprint }) : undefined;
    return { items, ...(nextToken ? { nextToken } : {}) };
  }

  private async normalizedQueueAttributeUpdates(
    raw: Record<string, string>,
    sourceArn: string,
    options: { creating: boolean; fifo: boolean; current?: SqsQueueAttributesState } = { creating: false, fifo: false },
  ): Promise<Partial<Record<keyof SqsQueueAttributesState, string | undefined>>> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AwsError("InvalidParameterValue", "Attributes must be a map.", 400);
    const kmsKey = raw.KmsMasterKeyId;
    const kmsReuse = raw.KmsDataKeyReusePeriodSeconds;
    if (kmsKey !== undefined && kmsKey !== "" && !this.validKmsKeyId(kmsKey)) throw new AwsError("InvalidParameterValue", "KmsMasterKeyId must be a valid KMS key ID, key ARN, alias name, or alias ARN.", 400);
    if (kmsReuse !== undefined) numeric(kmsReuse, "KmsDataKeyReusePeriodSeconds", 60, 86_400);
    const nextSqsManaged = raw.SqsManagedSseEnabled === undefined
      ? kmsKey ? "false" : options.current?.SqsManagedSseEnabled ?? DEFAULT_QUEUE_ATTRIBUTES.SqsManagedSseEnabled
      : booleanAttribute(raw.SqsManagedSseEnabled, "SqsManagedSseEnabled");
    if (kmsKey && nextSqsManaged === "true") throw new AwsError("InvalidParameterValue", "SqsManagedSseEnabled and KmsMasterKeyId cannot both enable encryption.", 400);
    if (kmsKey || kmsReuse !== undefined) throw new AwsError("UnsupportedOperation", "SSE-KMS requires the KMS service, which is not implemented by this simulator.", 400);
    const result: Partial<Record<keyof SqsQueueAttributesState, string | undefined>> = {};
    for (const [name, value] of Object.entries(raw)) {
      switch (name) {
        case "DelaySeconds": result.DelaySeconds = String(numeric(value, name, 0, 900)); break;
        case "MaximumMessageSize": result.MaximumMessageSize = String(numeric(value, name, 1024, MAX_MESSAGE_BYTES)); break;
        case "MessageRetentionPeriod": result.MessageRetentionPeriod = String(numeric(value, name, 60, 1_209_600)); break;
        case "ReceiveMessageWaitTimeSeconds": result.ReceiveMessageWaitTimeSeconds = String(numeric(value, name, 0, 20)); break;
        case "VisibilityTimeout": result.VisibilityTimeout = String(numeric(value, name, 0, 43_200)); break;
        case "Policy": {
          try { result.Policy = parseSqsQueuePolicy(value, { queueArn: sourceArn })?.normalized; }
          catch (error) { this.throwPolicyError(error, false); }
          break;
        }
        case "SqsManagedSseEnabled": result.SqsManagedSseEnabled = booleanAttribute(value, name); break;
        case "KmsMasterKeyId": result.KmsMasterKeyId = undefined; break;
        case "KmsDataKeyReusePeriodSeconds": result.KmsDataKeyReusePeriodSeconds = undefined; break;
        case "RedrivePolicy": {
          if (value === "") { result.RedrivePolicy = undefined; break; }
          const policy = this.readRedrivePolicy(String(value), true)!;
          let target: ResolvedSqsQueue;
          try { target = this.resolveQueueArn(policy.deadLetterTargetArn); }
          catch { throw new AwsError("InvalidParameterValue", "RedrivePolicy deadLetterTargetArn must identify an existing queue in the same account and Region.", 400); }
          if (target.queueArn === sourceArn) throw new AwsError("InvalidParameterValue", "A queue cannot use itself as its dead-letter queue.", 400);
          if ((target.state.attributes.FifoQueue === "true") !== options.fifo) throw new AwsError("InvalidParameterValue", "The source queue and dead-letter queue must both be the same queue type.", 400);
          const allow = this.readRedriveAllowPolicy(target.state.attributes.RedriveAllowPolicy, false);
          if (!this.redriveAllowed(allow, sourceArn)) throw new AwsError("InvalidParameterValue", "The dead-letter queue RedriveAllowPolicy does not permit this source queue.", 400);
          let cursor: ResolvedSqsQueue | undefined = target;
          const visited = new Set<string>();
          while (cursor && !visited.has(cursor.queueArn)) {
            if (cursor.queueArn === sourceArn) throw new AwsError("InvalidParameterValue", "RedrivePolicy cannot create a dead-letter queue cycle.", 400);
            visited.add(cursor.queueArn);
            const next = this.readRedrivePolicy(cursor.state.attributes.RedrivePolicy, false);
            if (!next) break;
            try { cursor = this.resolveQueueArn(next.deadLetterTargetArn); } catch { break; }
          }
          result.RedrivePolicy = JSON.stringify(policy);
          break;
        }
        case "RedriveAllowPolicy": {
          if (value === "") { result.RedriveAllowPolicy = undefined; break; }
          const allow = this.readRedriveAllowPolicy(String(value), true)!;
          for (const source of this.deadLetterSources(sourceArn)) if (!this.redriveAllowed(allow, source.queueArn)) throw new AwsError("InvalidParameterValue", "RedriveAllowPolicy cannot exclude a queue that currently uses this dead-letter queue.", 400);
          result.RedriveAllowPolicy = JSON.stringify(allow);
          break;
        }
        case "FifoQueue": {
          if (!options.creating) throw new AwsError("InvalidParameterValue", "The FifoQueue attribute is immutable after queue creation.", 400);
          result.FifoQueue = booleanAttribute(value, name);
          break;
        }
        case "ContentBasedDeduplication": {
          if (!options.fifo) throw new AwsError("InvalidParameterValue", "ContentBasedDeduplication is valid only for FIFO queues.", 400);
          result.ContentBasedDeduplication = booleanAttribute(value, name);
          break;
        }
        case "DeduplicationScope": {
          if (!options.fifo || !["queue", "messageGroup"].includes(String(value))) throw new AwsError("InvalidParameterValue", "DeduplicationScope must be queue or messageGroup on a FIFO queue.", 400);
          result.DeduplicationScope = String(value) as "queue" | "messageGroup";
          break;
        }
        case "FifoThroughputLimit": {
          if (!options.fifo || !["perQueue", "perMessageGroupId"].includes(String(value))) throw new AwsError("InvalidParameterValue", "FifoThroughputLimit must be perQueue or perMessageGroupId on a FIFO queue.", 400);
          result.FifoThroughputLimit = String(value) as "perQueue" | "perMessageGroupId";
          break;
        }
        default: throw new AwsError("InvalidAttributeName", `Unknown Attribute ${name}.`, 400);
      }
    }
    if (options.fifo) {
      const scope = result.DeduplicationScope ?? options.current?.DeduplicationScope ?? "queue";
      const limit = result.FifoThroughputLimit ?? options.current?.FifoThroughputLimit ?? "perQueue";
      if (limit === "perMessageGroupId" && scope !== "messageGroup") throw new AwsError("InvalidParameterValue", "FifoThroughputLimit perMessageGroupId requires DeduplicationScope messageGroup.", 400);
    }
    return result;
  }

  private validKmsKeyId(value: string): boolean {
    if (value.length < 1 || value.length > 2_048) return false;
    if (/^alias\/[A-Za-z0-9/_-]+$/.test(value)) return true;
    if (/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/i.test(value)) return true;
    return /^arn:[a-z0-9-]+:kms:[a-z0-9-]+:\d{12}:(?:key\/(?:[0-9a-f-]{36}|mrk-[0-9a-f]{32})|alias\/[A-Za-z0-9/_-]+)$/i.test(value);
  }

  private readRedrivePolicy(raw: string | undefined, strict: boolean): RedrivePolicy | undefined {
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const deadLetterTargetArn = String(parsed.deadLetterTargetArn ?? "");
      const maxReceiveCount = numeric(parsed.maxReceiveCount, "maxReceiveCount", 1, 1000);
      if (!/^arn:aws:sqs:[^:]+:\d{12}:(?:[A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\.fifo)$/.test(deadLetterTargetArn)) throw new Error("arn");
      return { deadLetterTargetArn, maxReceiveCount };
    } catch (error) {
      if (!strict) return undefined;
      if (error instanceof AwsError) throw error;
      throw new AwsError("InvalidParameterValue", "RedrivePolicy must be valid JSON containing deadLetterTargetArn and maxReceiveCount.", 400);
    }
  }

  private readRedriveAllowPolicy(raw: string | undefined, strict: boolean): RedriveAllowPolicy | undefined {
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const permission = String(parsed.redrivePermission ?? "") as RedriveAllowPolicy["redrivePermission"];
      if (!["allowAll", "denyAll", "byQueue"].includes(permission)) throw new Error("permission");
      const sourceQueueArns = parsed.sourceQueueArns === undefined ? undefined : asArray(parsed.sourceQueueArns as string[]).map(String);
      if (permission === "byQueue") {
        if (!sourceQueueArns?.length || sourceQueueArns.length > 10 || new Set(sourceQueueArns).size !== sourceQueueArns.length) throw new Error("sources");
        for (const arn of sourceQueueArns) {
          const match = /^arn:aws:sqs:([^:]+):(\d{12}):(?:[A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\.fifo)$/.exec(arn);
          if (!match || match[1] !== this.region || match[2] !== this.store.accountId) throw new Error("source arn");
        }
      } else if (sourceQueueArns?.length) throw new Error("unexpected sources");
      return { redrivePermission: permission, ...(sourceQueueArns ? { sourceQueueArns: [...sourceQueueArns].sort(utf8Compare) } : {}) };
    } catch {
      if (!strict) return undefined;
      throw new AwsError("InvalidParameterValue", "RedriveAllowPolicy must contain a valid redrivePermission and sourceQueueArns configuration.", 400);
    }
  }

  private redriveAllowed(policy: RedriveAllowPolicy | undefined, sourceArn: string): boolean {
    if (!policy || policy.redrivePermission === "allowAll") return true;
    if (policy.redrivePermission === "denyAll") return false;
    return policy.sourceQueueArns?.includes(sourceArn) ?? false;
  }

  private deadLetterSources(targetArn: string): SqsQueueState[] {
    return Object.values(this.regionState().sqsQueues).filter(queue => this.readRedrivePolicy(queue.attributes.RedrivePolicy, false)?.deadLetterTargetArn === targetArn);
  }

  private async metric(queueName: string, metricName: string, value: number, unit: string, aggregation: "sample" | "gauge" = "sample"): Promise<void> {
    await this.telemetry.publish({ namespace: "AWS/SQS", metricName, dimensions: { QueueName: queueName }, value, unit, timestamp: this.clock.now(), aggregation });
  }

  private async publishGauges(queue: SqsQueueState, supplied?: SqsQueueData): Promise<void> {
    const ownerAccountId = queue.queueArn.match(/^arn:[a-z0-9-]+:sqs:[^:]+:(\d{12}):/i)?.[1] ?? this.store.accountId;
    if (!this.accountRegion(ownerAccountId)?.sqsQueues[queue.queueName]) return;
    const data = await this.readQueueAndRemoveExpired(queue.queueArn, supplied);
    const now = this.clock.now();
    const messages = Object.values(data.messages).filter(message => message.retentionUntil > now);
    const visible = messages.filter(message => message.availableAt <= now && (message.invisibleUntil ?? 0) <= now);
    const unavailable = messages.filter(message => (message.invisibleUntil ?? 0) > now);
    const delayed = messages.filter(message => message.availableAt > now);
    const oldest = visible.length ? Math.max(0, now - Math.min(...visible.map(message => message.deadLetteredAt ?? message.sentAt))) / 1000 : 0;
    await this.metric(queue.queueName, "ApproximateNumberOfMessagesVisible", visible.length, "Count", "gauge");
    if (unavailable.length) await this.metric(queue.queueName, "ApproximateNumberOfMessagesNotVisible", unavailable.length, "Count", "gauge");
    if (delayed.length) await this.metric(queue.queueName, "ApproximateNumberOfMessagesDelayed", delayed.length, "Count", "gauge");
    if (visible.length) await this.metric(queue.queueName, "ApproximateAgeOfOldestMessage", oldest, "Seconds", "gauge");
    if (queue.attributes.FifoQueue === "true") {
      const inflightGroups = new Set(unavailable.map(message => message.messageGroupId).filter((value): value is string => value !== undefined));
      await this.metric(queue.queueName, "ApproximateNumberOfGroupsWithInflightMessages", inflightGroups.size, "Count", "gauge");
      return;
    }

    const grouped = new Map<string, SqsStoredMessage[]>();
    for (const message of messages) {
      if (message.messageGroupId === undefined) continue;
      const values = grouped.get(message.messageGroupId) ?? [];
      values.push(message);
      grouped.set(message.messageGroupId, values);
    }
    const average = grouped.size ? [...grouped.values()].reduce((total, values) => total + values.length, 0) / grouped.size : 0;
    const noisy = new Set(grouped.size < 2 ? [] : [...grouped.entries()].filter(([, values]) => values.length > average).map(([group]) => group));
    const quiet = messages.filter(message => message.messageGroupId === undefined || !noisy.has(message.messageGroupId));
    const quietVisible = quiet.filter(message => message.availableAt <= now && (message.invisibleUntil ?? 0) <= now);
    const quietUnavailable = quiet.filter(message => (message.invisibleUntil ?? 0) > now);
    const quietDelayed = quiet.filter(message => message.availableAt > now);
    const quietOldest = quietVisible.length ? Math.max(0, now - Math.min(...quietVisible.map(message => message.deadLetteredAt ?? message.sentAt))) / 1000 : 0;
    if (grouped.size) {
      await this.metric(queue.queueName, "ApproximateNumberOfNoisyGroups", noisy.size, "Count", "gauge");
      await this.metric(queue.queueName, "ApproximateNumberOfMessagesVisibleInQuietGroups", quietVisible.length, "Count", "gauge");
      if (quietUnavailable.length) await this.metric(queue.queueName, "ApproximateNumberOfMessagesNotVisibleInQuietGroups", quietUnavailable.length, "Count", "gauge");
      if (quietDelayed.length) await this.metric(queue.queueName, "ApproximateNumberOfMessagesDelayedInQuietGroups", quietDelayed.length, "Count", "gauge");
      if (quietVisible.length) await this.metric(queue.queueName, "ApproximateAgeOfOldestMessageInQuietGroups", quietOldest, "Seconds", "gauge");
    }
  }

  private async readQueueAndRemoveExpired(queueArn: string, supplied?: SqsQueueData): Promise<SqsQueueData> {
    const data = supplied ?? await this.storage.readQueue(queueArn);
    if (!Object.values(data.messages).some(message => message.retentionUntil <= this.clock.now())) return data;
    return this.storage.mutateQueue(queueArn, current => {
      this.removeExpired(current);
      return structuredClone(current);
    });
  }

  private waitForQueue(queueArn: string, delayMs: number, abortSignal?: AbortSignal): Promise<void> {
    this.throwIfAborted(abortSignal);
    return new Promise((resolve, reject) => {
      const callbacks = this.waiters.get(queueArn) ?? new Set<() => void>();
      this.waiters.set(queueArn, callbacks);
      let handle: ReturnType<Clock["setTimeout"]> | undefined;
      let settled = false;
      const cleanup = () => {
        if (handle !== undefined) this.clock.clearTimeout(handle);
        callbacks.delete(wake);
        if (!callbacks.size) this.waiters.delete(queueArn);
        abortSignal?.removeEventListener("abort", abort);
      };
      const wake = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new SqsRequestAbortedError());
      };
      callbacks.add(wake);
      abortSignal?.addEventListener("abort", abort, { once: true });
      handle = this.clock.setTimeout(wake, delayMs);
      if (abortSignal?.aborted) abort();
    });
  }

  private notify(queueArn: string): void {
    for (const wake of [...(this.waiters.get(queueArn) ?? [])]) wake();
  }
}
