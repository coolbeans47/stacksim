import { AwsError } from "./errors.js";
import type { Clock } from "./core/clock.js";
import type { TelemetryBus } from "./core/telemetry.js";
import { evaluateRoleAuthorization } from "./iam/evaluator.js";
import { EventPatternValidationError, matchesEventPattern, parseEventJson, parseEventPattern, type EventPattern } from "./eventbridge/pattern.js";
import type { StateStore } from "./state.js";
import { randomUUID } from "node:crypto";

export interface LambdaSqsQueueDescriptor {
  queueArn: string;
  queueUrl: string;
  visibilityTimeoutSeconds: number;
  fifo?: boolean;
}

export interface LambdaSqsMessageAttributeValue {
  DataType: string;
  StringValue?: string;
  BinaryValue?: Uint8Array | string;
  StringListValues?: string[];
  BinaryListValues?: Array<Uint8Array | string>;
}

export interface LambdaSqsConsumerMessage {
  MessageId?: string;
  ReceiptHandle?: string;
  MD5OfBody?: string;
  MD5OfMessageAttributes?: string;
  Body?: string;
  Attributes?: Record<string, string>;
  MessageAttributes?: Record<string, LambdaSqsMessageAttributeValue>;
  messageId?: string;
  receiptHandle?: string;
  md5OfBody?: string;
  md5OfMessageAttributes?: string;
  body?: string;
  attributes?: Record<string, string>;
  messageAttributes?: Record<string, LambdaSqsMessageAttributeValue>;
  deliveryLineage?: string[];
}

export interface LambdaSqsServicePort {
  resolveQueueArn(queueArn: string): LambdaSqsQueueDescriptor | undefined;
  receiveForConsumer(input: { queueArn: string; maxNumberOfMessages: number; visibilityTimeoutSeconds?: number; waitTimeSeconds?: number; roleArn?: string; abortSignal?: AbortSignal }): Promise<{ messages: LambdaSqsConsumerMessage[] }>;
  acknowledge(input: { queueArn: string; receiptHandles: string[]; roleArn?: string }): Promise<void>;
  sendMessageToArn(queueArn: string, input: { MessageBody: string; MessageAttributes?: Record<string, LambdaSqsMessageAttributeValue>; MessageSystemAttributes?: Record<string, LambdaSqsMessageAttributeValue> }): Promise<unknown>;
  sendAuthorizedMessageToArn?(queueArn: string, input: { MessageBody: string; MessageAttributes?: Record<string, LambdaSqsMessageAttributeValue>; MessageSystemAttributes?: Record<string, LambdaSqsMessageAttributeValue> }, caller: { kind: "role"; roleArn: string; sourceArn?: string; sourceAccount?: string; deliveryLineage?: string[] } | { kind: "service"; principal: string; sourceArn: string; sourceAccount: string; deliveryLineage?: string[] }): Promise<unknown>;
}

export interface LambdaSqsFunction {
  functionName: string;
  qualifier?: string;
  functionArn: string;
  role: string;
  timeout: number;
}

export interface LambdaSqsMappingState {
  sourceType: "sqs";
  uuid: string;
  eventSourceMappingArn: string;
  eventSourceArn: string;
  functionName: string;
  functionQualifier?: string;
  functionArn: string;
  enabled: boolean;
  state: "Creating" | "Enabling" | "Enabled" | "Disabling" | "Disabled" | "Updating" | "Deleting";
  stateTransitionReason: string;
  batchSize: number;
  maximumBatchingWindowInSeconds: number;
  functionResponseTypes: Array<"ReportBatchItemFailures">;
  filterCriteria?: { Filters: Array<{ Pattern: string }> };
  scalingMaximumConcurrency?: number;
  /** Stored and returned as configured; the simulator does not publish the extra metrics. */
  metricsConfig?: { Metrics: Array<"EventCount"> };
  tags: Record<string, string>;
  createdAt: number;
  lastModified: number;
  lastProcessingResult: string;
}

export interface LambdaSqsConfiguration {
  batchSize: number;
  maximumBatchingWindowInSeconds: number;
  functionResponseTypes: Array<"ReportBatchItemFailures">;
  filterCriteria?: LambdaSqsMappingState["filterCriteria"];
  scalingMaximumConcurrency?: number;
  metricsConfig?: LambdaSqsMappingState["metricsConfig"];
}

interface LambdaSqsInvokeResult {
  payload: Buffer;
  functionError?: string;
  interrupted?: boolean;
}

interface NormalizedMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  md5OfBody: string;
  md5OfMessageAttributes?: string;
  attributes: Record<string, string>;
  messageAttributes: Record<string, LambdaSqsMessageAttributeValue>;
  deliveryLineage?: string[];
}

interface PendingBatch {
  queueArn: string;
  messages: NormalizedMessage[];
  startedAt: number;
  ready: boolean;
}

const SIX_MIB = 6 * 1024 * 1024;
const SOURCE_ONLY_FIELDS = [
  "AmazonManagedKafkaEventSourceConfig", "BisectBatchOnFunctionError", "DestinationConfig", "DocumentDBEventSourceConfig", "KMSKeyArn",
  "MaximumRecordAgeInSeconds", "MaximumRetryAttempts", "ParallelizationFactor", "ProvisionedPollerConfig", "Queues", "SelfManagedEventSource",
  "SelfManagedKafkaEventSourceConfig", "SourceAccessConfigurations", "StartingPosition", "StartingPositionTimestamp", "Topics", "TumblingWindowInSeconds",
];

/**
 * The wire-visible `LastProcessingResult`. The pollers keep a precise local
 * outcome; the API reports AWS's shapes: `OK`, `No records processed`, or
 * `PROBLEM: <reason>`.
 */
export function awsProcessingResult(outcome: string): string {
  if (outcome === "OK" || outcome === "Window batch processed" || outcome === "No records matched event filter") return "OK";
  if (outcome === "No records processed" || outcome === "No messages processed") return "No records processed";
  if (outcome.startsWith("PROBLEM: ")) return outcome;
  return `PROBLEM: ${outcome === "Function error" ? "Function call failed" : outcome}`;
}

function integer(value: unknown, field: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new AwsError("InvalidParameterValueException", `${field} must be between ${minimum} and ${maximum}`);
  return Number(value);
}

/** SQS filters may only test the message body; $or alternatives are held to the same rule. */
function usesOnlyBody(pattern: unknown): boolean {
  if (!pattern || typeof pattern !== "object" || Array.isArray(pattern)) return false;
  return Object.entries(pattern as Record<string, unknown>).every(([key, value]) => key === "body" || (key === "$or" && Array.isArray(value) && value.every(usesOnlyBody)));
}

/**
 * Lambda event filters follow the EventBridge event-pattern rules, so the
 * EventBridge matcher validates and evaluates them. A pattern that uses an
 * operator the matcher does not implement is refused, because a filter that
 * silently matches nothing would delete every message.
 */
function sqsFilterPattern(pattern: string): EventPattern {
  let parsed: unknown; try { parsed = JSON.parse(pattern); } catch { throw new AwsError("InvalidParameterValueException", "Filter Pattern must contain valid JSON"); }
  if (!usesOnlyBody(parsed)) throw new AwsError("InvalidParameterValueException", "SQS filter patterns may only use the body event key");
  try { return parseEventPattern(pattern); }
  catch (error) {
    if (error instanceof EventPatternValidationError) throw new AwsError("InvalidParameterValueException", `Invalid filter pattern definition: ${error.message}`);
    throw error;
  }
}

function filterCriteria(value: unknown, fallback?: LambdaSqsMappingState["filterCriteria"]): LambdaSqsMappingState["filterCriteria"] {
  if (value === undefined) return fallback ? structuredClone(fallback) : undefined;
  if (value === null || (typeof value === "object" && value && Array.isArray((value as any).Filters) && (value as any).Filters.length === 0)) return undefined;
  const filters = (value as any)?.Filters;
  if (!Array.isArray(filters) || filters.length < 1 || filters.length > 5) throw new AwsError("InvalidParameterValueException", "FilterCriteria.Filters must contain between 1 and 5 filters");
  return { Filters: filters.map((filter: any) => {
    if (!filter || typeof filter.Pattern !== "string" || Buffer.byteLength(filter.Pattern) > 4096) throw new AwsError("InvalidParameterValueException", "Each filter Pattern must be a JSON string no larger than 4096 bytes");
    sqsFilterPattern(filter.Pattern);
    return { Pattern: filter.Pattern };
  }) };
}

function metricsConfig(value: unknown, fallback?: LambdaSqsMappingState["metricsConfig"]): LambdaSqsMappingState["metricsConfig"] {
  if (value === undefined) return fallback ? structuredClone(fallback) : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "Metrics")) throw new AwsError("InvalidParameterValueException", "MetricsConfig must contain only Metrics");
  const metrics = (value as { Metrics?: unknown }).Metrics ?? [];
  if (!Array.isArray(metrics) || metrics.some(metric => metric !== "EventCount")) throw new AwsError("InvalidParameterValueException", "MetricsConfig.Metrics only supports EventCount");
  return metrics.length ? { Metrics: ["EventCount"] } : undefined;
}

function responseTypes(value: unknown, fallback: Array<"ReportBatchItemFailures">): Array<"ReportBatchItemFailures"> {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some(item => item !== "ReportBatchItemFailures") || value.length > 1) throw new AwsError("InvalidParameterValueException", "FunctionResponseTypes only supports ReportBatchItemFailures");
  return [...value] as Array<"ReportBatchItemFailures">;
}

function messageAttribute(value: LambdaSqsMessageAttributeValue): Record<string, unknown> {
  const binaryValue = value.BinaryValue === undefined ? undefined : typeof value.BinaryValue === "string" ? value.BinaryValue : Buffer.from(value.BinaryValue).toString("base64");
  const binaryListValues = value.BinaryListValues?.map(item => typeof item === "string" ? item : Buffer.from(item).toString("base64"));
  return {
    stringValue: value.StringValue,
    binaryValue,
    stringListValues: value.StringListValues ?? [],
    binaryListValues: binaryListValues ?? [],
    dataType: value.DataType ?? "String",
  };
}

export class LambdaSqsEventSource {
  private readonly pending = new Map<string, PendingBatch>();
  private readonly activeCounts = new Map<string, number>();
  private readonly activeGroups = new Map<string, Set<string>>();
  /** The running batch of each FIFO message group, keyed by mapping and group. */
  private readonly groupTasks = new Map<string, Promise<void>>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly polls = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private stopped = true;

  constructor(
    private readonly store: StateStore,
    private readonly region: string,
    private readonly clock: Clock,
    private readonly callbacks: {
      resolveFunction(target: string): LambdaSqsFunction;
      invoke(functionName: string, qualifier: string | undefined, payload: Buffer, requestId: string, lineage?: string[]): Promise<LambdaSqsInvokeResult>;
      isCurrent(mapping: LambdaSqsMappingState): boolean;
      wake(): void;
    },
    private readonly authMode: "off" | "validate" | "enforce",
    private readonly telemetry?: TelemetryBus,
    private service?: LambdaSqsServicePort,
  ) {}

  setService(service: LambdaSqsServicePort): void { this.service = service; this.callbacks.wake(); }
  isSqsArn(value: unknown): value is string { return typeof value === "string" && /^arn:(?:aws|aws-us-gov|aws-cn):sqs:/.test(value); }

  resolveQueue(queueArn: string): LambdaSqsQueueDescriptor {
    if (!this.service) throw new AwsError("InvalidParameterValueException", "The SQS event source dependency is not available in this simulator");
    const match = queueArn.match(/^arn:(?:aws|aws-us-gov|aws-cn):sqs:([^:]+):(\d{12}):([^:]+)$/);
    if (!match || match[1] !== this.region || match[2] !== this.store.accountId) throw new AwsError("InvalidParameterValueException", "SQS event sources must use this simulator account and Region");
    let queue: LambdaSqsQueueDescriptor | undefined;
    try { queue = this.service.resolveQueueArn(queueArn); } catch { queue = undefined; }
    if (!queue) throw new AwsError("ResourceNotFoundException", "The SQS queue does not exist", 404);
    return queue;
  }

  validateFunction(target: LambdaSqsFunction, queue: LambdaSqsQueueDescriptor): void {
    if (target.timeout > queue.visibilityTimeoutSeconds) throw new AwsError("InvalidParameterValueException", `Queue visibility timeout: ${queue.visibilityTimeoutSeconds} seconds is less than Function timeout: ${target.timeout} seconds`);
    if (!this.enforcesRole()) return;
    const iam = this.store.ensureAccount().iam;
    // The execution-role permissions AWS documents for SQS event sources (and AWSLambdaSQSQueueExecutionRole grants).
    const actions = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"];
    const denied = actions.find(action => evaluateRoleAuthorization(iam, target.role, action, queue.queueArn).decision !== "allowed");
    if (denied) throw new AwsError("InvalidParameterValueException", `The provided execution role does not have permissions to call ${denied.slice("sqs:".length)} on SQS`);
  }

  /**
   * The execution role is checked only when authorization is enforced, both
   * when a mapping is created and when the poller consumes the queue.
   */
  private enforcesRole(): boolean { return this.authMode === "enforce"; }
  private consumerRole(mapping: LambdaSqsMappingState): string | undefined { return this.enforcesRole() ? this.callbacks.resolveFunction(mapping.functionArn).role : undefined; }

  configuration(input: any, previous?: LambdaSqsMappingState, suppliedQueue?: LambdaSqsQueueDescriptor): LambdaSqsConfiguration {
    for (const field of SOURCE_ONLY_FIELDS) if (input[field] !== undefined) throw new AwsError("InvalidParameterValueException", `${field} is not supported for SQS event source mappings in this simulator`);
    const queue = suppliedQueue ?? this.resolveQueue(String(input.EventSourceArn ?? previous?.eventSourceArn ?? ""));
    const batchSize = integer(input.BatchSize, "BatchSize", 1, queue.fifo ? 10 : 10_000, previous?.batchSize ?? 10);
    const maximumBatchingWindowInSeconds = integer(input.MaximumBatchingWindowInSeconds, "MaximumBatchingWindowInSeconds", 0, 300, previous?.maximumBatchingWindowInSeconds ?? 0);
    if (queue.fifo && maximumBatchingWindowInSeconds !== 0) throw new AwsError("InvalidParameterValueException", "MaximumBatchingWindowInSeconds is not supported for FIFO SQS event source mappings");
    if (batchSize > 10 && maximumBatchingWindowInSeconds < 1) throw new AwsError("InvalidParameterValueException", "MaximumBatchingWindowInSeconds must be at least 1 when BatchSize is greater than 10");
    let scalingMaximumConcurrency = previous?.scalingMaximumConcurrency;
    if (input.ScalingConfig !== undefined) {
      const scaling = input.ScalingConfig;
      if (!scaling || typeof scaling !== "object" || Array.isArray(scaling) || Object.keys(scaling).some(key => key !== "MaximumConcurrency")) throw new AwsError("InvalidParameterValueException", "ScalingConfig must contain only MaximumConcurrency");
      if (scaling.MaximumConcurrency === undefined) scalingMaximumConcurrency = undefined;
      else scalingMaximumConcurrency = integer(scaling.MaximumConcurrency, "ScalingConfig.MaximumConcurrency", 2, 1_000, 2);
    }
    const metrics = metricsConfig(input.MetricsConfig, previous?.metricsConfig);
    return {
      batchSize,
      maximumBatchingWindowInSeconds,
      functionResponseTypes: responseTypes(input.FunctionResponseTypes, previous?.functionResponseTypes ?? []),
      filterCriteria: filterCriteria(input.FilterCriteria, previous?.filterCriteria),
      ...(scalingMaximumConcurrency !== undefined ? { scalingMaximumConcurrency } : {}),
      ...(metrics ? { metricsConfig: metrics } : {}),
    };
  }

  view(mapping: LambdaSqsMappingState): Record<string, unknown> {
    return {
      UUID: mapping.uuid,
      BatchSize: mapping.batchSize,
      MaximumBatchingWindowInSeconds: mapping.maximumBatchingWindowInSeconds,
      EventSourceArn: mapping.eventSourceArn,
      FunctionArn: mapping.functionArn,
      LastModified: mapping.lastModified / 1000,
      LastProcessingResult: awsProcessingResult(mapping.lastProcessingResult),
      State: mapping.state,
      StateTransitionReason: mapping.stateTransitionReason,
      FunctionResponseTypes: mapping.functionResponseTypes,
      ...(mapping.filterCriteria ? { FilterCriteria: structuredClone(mapping.filterCriteria) } : {}),
      ...(mapping.scalingMaximumConcurrency !== undefined ? { ScalingConfig: { MaximumConcurrency: mapping.scalingMaximumConcurrency } } : {}),
      ...(mapping.metricsConfig ? { MetricsConfig: structuredClone(mapping.metricsConfig) } : {}),
      EventSourceMappingArn: mapping.eventSourceMappingArn,
    };
  }

  forget(uuid: string): void { this.pending.delete(uuid); this.polls.get(uuid)?.controller.abort(); }

  private normalize(raw: LambdaSqsConsumerMessage): NormalizedMessage | undefined {
    const messageId = raw.MessageId ?? raw.messageId; const receiptHandle = raw.ReceiptHandle ?? raw.receiptHandle;
    if (!messageId || !receiptHandle) return undefined;
    return {
      messageId,
      receiptHandle,
      body: raw.Body ?? raw.body ?? "",
      md5OfBody: raw.MD5OfBody ?? raw.md5OfBody ?? "",
      md5OfMessageAttributes: raw.MD5OfMessageAttributes ?? raw.md5OfMessageAttributes,
      attributes: structuredClone(raw.Attributes ?? raw.attributes ?? {}),
      messageAttributes: structuredClone(raw.MessageAttributes ?? raw.messageAttributes ?? {}),
      ...(raw.deliveryLineage?.length ? { deliveryLineage: raw.deliveryLineage.map(String).slice(-32) } : {}),
    };
  }

  private record(queueArn: string, message: NormalizedMessage): Record<string, unknown> {
    return {
      messageId: message.messageId,
      receiptHandle: message.receiptHandle,
      body: message.body,
      attributes: message.attributes,
      messageAttributes: Object.fromEntries(Object.entries(message.messageAttributes).map(([key, value]) => [key, messageAttribute(value)])),
      md5OfBody: message.md5OfBody,
      ...(message.md5OfMessageAttributes ? { md5OfMessageAttributes: message.md5OfMessageAttributes } : {}),
      eventSource: "aws:sqs",
      eventSourceARN: queueArn,
      awsRegion: this.region,
    };
  }

  /** The mapping's filters, validated. A stored pattern the matcher cannot evaluate throws rather than dropping messages. */
  private filterPatterns(mapping: LambdaSqsMappingState): EventPattern[] | undefined {
    return mapping.filterCriteria?.Filters.map(filter => sqsFilterPattern(filter.Pattern));
  }

  private matches(patterns: EventPattern[] | undefined, message: NormalizedMessage): boolean {
    if (!patterns) return true;
    let body: unknown = message.body; try { body = parseEventJson(message.body); } catch { /* Plain strings remain strings. */ }
    return patterns.some(pattern => matchesEventPattern(pattern, { body }));
  }

  private async receive(mapping: LambdaSqsMappingState, count: number, visibilityTimeoutSeconds: number, abortSignal: AbortSignal, waitTimeSeconds = 20): Promise<NormalizedMessage[]> {
    if (!this.service || count <= 0) return [];
    const patterns = this.filterPatterns(mapping);
    const roleArn = this.consumerRole(mapping);
    const result = await this.service.receiveForConsumer({ queueArn: mapping.eventSourceArn, maxNumberOfMessages: Math.min(10, count), visibilityTimeoutSeconds, waitTimeSeconds, ...(roleArn ? { roleArn } : {}), abortSignal });
    const messages = result.messages.map(message => this.normalize(message)).filter((message): message is NormalizedMessage => Boolean(message));
    if (messages.length) await this.metric(mapping, "EventSourceMappingPolled", messages.length);
    const retried = messages.filter(message => Number(message.attributes.ApproximateReceiveCount ?? "1") > 1).length;
    if (retried) await this.metric(mapping, "EventSourceMappingRetried", retried);
    if (!this.callbacks.isCurrent(mapping)) return [];
    const matching = new Set(messages.filter(message => this.matches(patterns, message)).map(message => message.messageId));
    let included = messages.filter(message => matching.has(message.messageId));
    let acknowledged = messages.filter(message => !matching.has(message.messageId));
    if (this.resolveQueue(mapping.eventSourceArn).fifo) {
      included = [];
      acknowledged = [];
      const groupsWithIncluded = new Set<string>();
      const blockedGroups = new Set<string>();
      for (const message of messages) {
        const group = message.attributes.MessageGroupId ?? message.messageId;
        if (blockedGroups.has(group)) continue;
        if (matching.has(message.messageId)) { groupsWithIncluded.add(group); included.push(message); continue; }
        if (groupsWithIncluded.has(group)) { blockedGroups.add(group); continue; }
        acknowledged.push(message);
      }
    }
    if (acknowledged.length && this.callbacks.isCurrent(mapping)) await this.service.acknowledge({ queueArn: mapping.eventSourceArn, receiptHandles: acknowledged.map(message => message.receiptHandle), ...(roleArn ? { roleArn } : {}) });
    return included;
  }

  private payload(queueArn: string, messages: NormalizedMessage[]): Buffer { return Buffer.from(JSON.stringify({ Records: messages.map(message => this.record(queueArn, message)) })); }

  private chunks(queueArn: string, messages: NormalizedMessage[]): NormalizedMessage[][] {
    const chunks: NormalizedMessage[][] = []; let current: NormalizedMessage[] = [];
    for (const message of messages) {
      const next = [...current, message];
      if (current.length && this.payload(queueArn, next).length > SIX_MIB) { chunks.push(current); current = [message]; }
      else current = next;
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  private active(uuid: string): number { return this.activeCounts.get(uuid) ?? 0; }
  private maximumConcurrency(mapping: LambdaSqsMappingState): number | undefined { return mapping.scalingMaximumConcurrency; }

  private async metric(mapping: LambdaSqsMappingState, metricName: string, value = 1): Promise<void> {
    await this.telemetry?.publish({ namespace: "AWS/Lambda", metricName, dimensions: { FunctionName: mapping.functionName, EventSourceMapping: mapping.uuid }, value, unit: "Count", timestamp: this.clock.now() }).catch(() => undefined);
  }

  async process(mapping: LambdaSqsMappingState): Promise<void> {
    if (this.stopped || this.polls.has(mapping.uuid)) return;
    const controller = new AbortController();
    const promise = this.processOnce(mapping, controller.signal).catch(async error => {
      if (controller.signal.aborted || this.stopped) return;
      if (this.callbacks.isCurrent(mapping)) { mapping.lastProcessingResult = error instanceof Error ? error.message : String(error); mapping.lastModified = this.clock.now(); await this.store.save().catch(() => undefined); }
    }).finally(() => { if (this.polls.get(mapping.uuid)?.promise === promise) this.polls.delete(mapping.uuid); if (!this.stopped) this.callbacks.wake(); });
    this.polls.set(mapping.uuid, { controller, promise });
  }

  private async processOnce(mapping: LambdaSqsMappingState, abortSignal: AbortSignal): Promise<void> {
    if (this.stopped || !this.service || !mapping.enabled || mapping.state !== "Enabled") return;
    let queue: LambdaSqsQueueDescriptor; let target: LambdaSqsFunction;
    try { queue = this.resolveQueue(mapping.eventSourceArn); target = this.callbacks.resolveFunction(mapping.functionArn); this.validateFunction(target, queue); this.filterPatterns(mapping); }
    catch (error) {
      if (error instanceof AwsError && error.code === "ResourceNotFoundException") { mapping.enabled = false; mapping.state = "Disabled"; mapping.stateTransitionReason = "Event source queue no longer exists"; this.pending.delete(mapping.uuid); }
      mapping.lastProcessingResult = error instanceof Error ? error.message : String(error); mapping.lastModified = this.clock.now(); await this.store.save().catch(() => undefined); return;
    }
    const maximumConcurrency = this.maximumConcurrency(mapping);
    let available = maximumConcurrency === undefined ? Number.POSITIVE_INFINITY : maximumConcurrency - this.active(mapping.uuid); if (available <= 0) return;
    let pending = this.pending.get(mapping.uuid);
    if (pending) {
      const remaining = mapping.batchSize - pending.messages.length;
      // The batch is invoked when it fills or its batching window ends, so the top-up poll never waits past the window.
      const windowRemainingMs = pending.startedAt + mapping.maximumBatchingWindowInSeconds * 1000 - this.clock.now();
      if (!pending.ready && remaining > 0 && windowRemainingMs > 0) pending.messages.push(...await this.receive(mapping, remaining, queue.visibilityTimeoutSeconds, abortSignal, Math.min(20, Math.ceil(windowRemainingMs / 1000))));
      if (!this.callbacks.isCurrent(mapping)) return;
      if (pending.messages.length >= mapping.batchSize || this.clock.now() - pending.startedAt >= mapping.maximumBatchingWindowInSeconds * 1000) pending.ready = true;
      if (!pending.ready) return;
      this.pending.delete(mapping.uuid);
      const chunks = this.chunks(mapping.eventSourceArn, pending.messages);
      for (let index = 0; index < chunks.length; index++) {
        if (available > 0) await this.groupsIdle(mapping, chunks[index]);
        if (available <= 0 || !this.launch(mapping, chunks[index])) { this.pending.set(mapping.uuid, { queueArn: mapping.eventSourceArn, messages: chunks.slice(index).flat(), startedAt: pending.startedAt, ready: true }); break; }
        available -= 1;
      }
    }
    while (available > 0 && this.callbacks.isCurrent(mapping)) {
      const messages: NormalizedMessage[] = [];
      while (messages.length < mapping.batchSize) {
        // Only an empty batch long-polls; once messages are held, further pages are taken without waiting.
        const received = await this.receive(mapping, mapping.batchSize - messages.length, queue.visibilityTimeoutSeconds, abortSignal, messages.length ? 0 : 20); messages.push(...received);
        if (received.length < Math.min(10, mapping.batchSize - messages.length + received.length)) break;
        if (this.payload(mapping.eventSourceArn, messages).length >= SIX_MIB) break;
      }
      if (!messages.length) break;
      if (!this.callbacks.isCurrent(mapping)) return;
      if (messages.length < mapping.batchSize && mapping.maximumBatchingWindowInSeconds > 0) { this.pending.set(mapping.uuid, { queueArn: mapping.eventSourceArn, messages, startedAt: this.clock.now(), ready: false }); break; }
      const chunks = this.chunks(mapping.eventSourceArn, messages);
      for (let index = 0; index < chunks.length; index++) {
        if (available > 0) await this.groupsIdle(mapping, chunks[index]);
        if (available <= 0 || !this.launch(mapping, chunks[index])) { this.pending.set(mapping.uuid, { queueArn: mapping.eventSourceArn, messages: chunks.slice(index).flat(), startedAt: this.clock.now(), ready: true }); break; }
        available -= 1;
      }
    }
  }

  private messageGroups(mapping: LambdaSqsMappingState, messages: NormalizedMessage[]): Set<string> {
    if (!this.resolveQueue(mapping.eventSourceArn).fifo) return new Set();
    return new Set(messages.map(message => message.attributes.MessageGroupId ?? message.messageId));
  }

  /**
   * Wait for the running batch of each message group in the next batch. The
   * queue releases a group as soon as its messages are deleted, which is just
   * before the previous batch finishes its bookkeeping; starting the next
   * batch then, instead of parking it behind another long poll, keeps a FIFO
   * group flowing batch after batch.
   */
  private async groupsIdle(mapping: LambdaSqsMappingState, messages: NormalizedMessage[]): Promise<void> {
    const running = [...this.messageGroups(mapping, messages)].map(group => this.groupTasks.get(`${mapping.uuid}\0${group}`)).filter((task): task is Promise<void> => task !== undefined);
    if (running.length) await Promise.allSettled(running);
  }

  private launch(mapping: LambdaSqsMappingState, messages: NormalizedMessage[]): boolean {
    if (this.stopped || !this.callbacks.isCurrent(mapping)) return false;
    const groups = this.messageGroups(mapping, messages);
    const activeGroups = this.activeGroups.get(mapping.uuid) ?? new Set<string>();
    if ([...groups].some(group => activeGroups.has(group))) return false;
    for (const group of groups) activeGroups.add(group);
    if (activeGroups.size) this.activeGroups.set(mapping.uuid, activeGroups);
    this.activeCounts.set(mapping.uuid, this.active(mapping.uuid) + 1);
    const task = this.invoke(mapping, messages).finally(() => {
      const remaining = Math.max(0, this.active(mapping.uuid) - 1); if (remaining) this.activeCounts.set(mapping.uuid, remaining); else this.activeCounts.delete(mapping.uuid);
      const currentGroups = this.activeGroups.get(mapping.uuid);
      if (currentGroups) { for (const group of groups) currentGroups.delete(group); if (!currentGroups.size) this.activeGroups.delete(mapping.uuid); }
      for (const group of groups) if (this.groupTasks.get(`${mapping.uuid}\0${group}`) === task) this.groupTasks.delete(`${mapping.uuid}\0${group}`);
      this.tasks.delete(task); if (!this.stopped) this.callbacks.wake();
    });
    for (const group of groups) this.groupTasks.set(`${mapping.uuid}\0${group}`, task);
    this.tasks.add(task); void task.catch(() => undefined);
    return true;
  }

  private async invoke(mapping: LambdaSqsMappingState, messages: NormalizedMessage[]): Promise<void> {
    let result = "OK"; let metricName = "EventSourceMappingSucceeded"; let interrupted = false; const started = this.clock.now();
    try {
      const lineage = [...new Set(messages.flatMap(message => message.deliveryLineage ?? []))].slice(-32);
      const invocation = await this.callbacks.invoke(mapping.functionName, mapping.functionQualifier, this.payload(mapping.eventSourceArn, messages), randomUUID(), lineage);
      if (invocation.interrupted) { interrupted = true; return; }
      if (invocation.functionError) { result = "Function error"; metricName = "EventSourceMappingFailed"; return; }
      let successful = messages;
      if (mapping.functionResponseTypes.includes("ReportBatchItemFailures")) {
        let response: any; try { response = JSON.parse(invocation.payload.toString("utf8")); } catch { result = "Invalid partial batch response"; metricName = "EventSourceMappingFailed"; return; }
        const failures = response?.batchItemFailures;
        // A missing, null or empty list is a complete success.
        if (failures !== undefined && failures !== null && !Array.isArray(failures)) { result = "Invalid partial batch response"; metricName = "EventSourceMappingFailed"; return; }
        const identifiers = (failures ?? []).map((failure: any) => failure?.itemIdentifier);
        const known = new Set(messages.map(message => message.messageId));
        if (identifiers.some((identifier: unknown) => typeof identifier !== "string" || !known.has(identifier))) { result = "Invalid partial batch item identifier"; metricName = "EventSourceMappingFailed"; return; }
        const failed = new Set(identifiers);
        if (this.resolveQueue(mapping.eventSourceArn).fifo && failed.size) {
          const blockedGroups = new Set<string>();
          successful = messages.filter(message => {
            const group = message.attributes.MessageGroupId ?? message.messageId;
            if (failed.has(message.messageId)) { blockedGroups.add(group); return false; }
            return !blockedGroups.has(group);
          });
        } else successful = messages.filter(message => !failed.has(message.messageId));
        if (failed.size) { result = "Partial batch failure"; metricName = "EventSourceMappingPartialFailure"; }
      }
      if (successful.length && this.callbacks.isCurrent(mapping) && this.service) { const roleArn = this.consumerRole(mapping); await this.service.acknowledge({ queueArn: mapping.eventSourceArn, receiptHandles: successful.map(message => message.receiptHandle), ...(roleArn ? { roleArn } : {}) }); }
    } catch (error) {
      result = error instanceof Error ? error.message : String(error); metricName = error instanceof AwsError && error.code === "TooManyRequestsException" ? "EventSourceMappingThrottled" : "EventSourceMappingFailed";
    } finally {
      if (!interrupted) {
        if (this.callbacks.isCurrent(mapping)) { mapping.lastProcessingResult = result; mapping.lastModified = this.clock.now(); await this.store.save().catch(() => undefined); }
        await this.telemetry?.publish({ namespace: "AWS/Lambda", metricName, dimensions: { FunctionName: mapping.functionName, EventSourceMapping: mapping.uuid }, value: 1, unit: "Count", timestamp: started }).catch(() => undefined);
      }
    }
  }

  start(): void { this.stopped = false; this.callbacks.wake(); }
  async stop(): Promise<void> { this.stopped = true; this.pending.clear(); for (const poll of this.polls.values()) poll.controller.abort(); await Promise.allSettled([...this.polls.values()].map(poll => poll.promise)); this.polls.clear(); await Promise.allSettled([...this.tasks]); this.activeGroups.clear(); this.groupTasks.clear(); }
}
