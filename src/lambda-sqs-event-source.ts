import { AwsError } from "./errors.js";
import type { Clock } from "./core/clock.js";
import type { TelemetryBus } from "./core/telemetry.js";
import { evaluateRoleAuthorization } from "./iam/evaluator.js";
import type { StateStore } from "./state.js";
import { id } from "./util.js";

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
  state: "Creating" | "Enabled" | "Disabled" | "Updating" | "Deleting";
  stateTransitionReason: string;
  batchSize: number;
  maximumBatchingWindowInSeconds: number;
  functionResponseTypes: Array<"ReportBatchItemFailures">;
  filterCriteria?: { Filters: Array<{ Pattern: string }> };
  scalingMaximumConcurrency?: number;
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

function integer(value: unknown, field: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new AwsError("InvalidParameterValueException", `${field} must be between ${minimum} and ${maximum}`);
  return Number(value);
}

function scalarMatch(candidate: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    const operator = expected as Record<string, unknown>;
    if (Object.hasOwn(operator, "exists")) return Boolean(operator.exists) === (candidate !== undefined);
    if (Object.hasOwn(operator, "prefix")) return typeof candidate === "string" && candidate.startsWith(String(operator.prefix));
    if (Object.hasOwn(operator, "suffix")) return typeof candidate === "string" && candidate.endsWith(String(operator.suffix));
    if (Object.hasOwn(operator, "equals-ignore-case")) return typeof candidate === "string" && candidate.toLowerCase() === String(operator["equals-ignore-case"]).toLowerCase();
    if (Object.hasOwn(operator, "anything-but")) {
      const excluded = Array.isArray(operator["anything-but"]) ? operator["anything-but"] as unknown[] : [operator["anything-but"]];
      return !excluded.some(value => scalarMatch(candidate, value));
    }
    if (Array.isArray(operator.numeric)) {
      const values = operator.numeric; const number = Number(candidate); if (!Number.isFinite(number)) return false;
      for (let index = 0; index + 1 < values.length; index += 2) { const op = values[index]; const bound = Number(values[index + 1]); if (!Number.isFinite(bound) || !(op === "=" ? number === bound : op === ">" ? number > bound : op === ">=" ? number >= bound : op === "<" ? number < bound : op === "<=" ? number <= bound : false)) return false; }
      return values.length >= 2;
    }
  }
  return candidate === expected || (typeof candidate === "number" && typeof expected === "string" && String(candidate) === expected);
}

function eventPatternMatch(candidate: unknown, pattern: unknown): boolean {
  if (Array.isArray(pattern)) return pattern.some(expected => scalarMatch(candidate, expected));
  if (!pattern || typeof pattern !== "object" || Array.isArray(candidate)) return scalarMatch(candidate, pattern);
  if (!candidate || typeof candidate !== "object") return false;
  return Object.entries(pattern as Record<string, unknown>).every(([key, value]) => eventPatternMatch((candidate as Record<string, unknown>)[key], value));
}

function filterCriteria(value: unknown, fallback?: LambdaSqsMappingState["filterCriteria"]): LambdaSqsMappingState["filterCriteria"] {
  if (value === undefined) return fallback ? structuredClone(fallback) : undefined;
  if (value === null || (typeof value === "object" && value && Array.isArray((value as any).Filters) && (value as any).Filters.length === 0)) return undefined;
  const filters = (value as any)?.Filters;
  if (!Array.isArray(filters) || filters.length < 1 || filters.length > 5) throw new AwsError("InvalidParameterValueException", "FilterCriteria.Filters must contain between 1 and 5 filters");
  return { Filters: filters.map((filter: any) => {
    if (!filter || typeof filter.Pattern !== "string" || Buffer.byteLength(filter.Pattern) > 4096) throw new AwsError("InvalidParameterValueException", "Each filter Pattern must be a JSON string no larger than 4096 bytes");
    let parsed: any; try { parsed = JSON.parse(filter.Pattern); } catch { throw new AwsError("InvalidParameterValueException", "Filter Pattern must contain valid JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some(key => key !== "body")) throw new AwsError("InvalidParameterValueException", "SQS filter patterns may only use the body event key");
    return { Pattern: filter.Pattern };
  }) };
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
    if (target.timeout > queue.visibilityTimeoutSeconds) throw new AwsError("InvalidParameterValueException", `The function timeout (${target.timeout} seconds) exceeds the queue visibility timeout (${queue.visibilityTimeoutSeconds} seconds)`);
    if (this.authMode !== "enforce") return;
    const iam = this.store.ensureAccount().iam;
    const actions = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"];
    if (actions.some(action => evaluateRoleAuthorization(iam, target.role, action, queue.queueArn).decision !== "allowed")) throw new AwsError("InvalidParameterValueException", `The function execution role is not authorized to consume SQS queue ${queue.queueArn}`);
  }

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
    return {
      batchSize,
      maximumBatchingWindowInSeconds,
      functionResponseTypes: responseTypes(input.FunctionResponseTypes, previous?.functionResponseTypes ?? []),
      filterCriteria: filterCriteria(input.FilterCriteria, previous?.filterCriteria),
      ...(scalingMaximumConcurrency !== undefined ? { scalingMaximumConcurrency } : {}),
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
      LastProcessingResult: mapping.lastProcessingResult,
      State: mapping.state,
      StateTransitionReason: mapping.stateTransitionReason,
      FunctionResponseTypes: mapping.functionResponseTypes,
      ...(mapping.filterCriteria ? { FilterCriteria: structuredClone(mapping.filterCriteria) } : {}),
      ...(mapping.scalingMaximumConcurrency !== undefined ? { ScalingConfig: { MaximumConcurrency: mapping.scalingMaximumConcurrency } } : {}),
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

  private matches(mapping: LambdaSqsMappingState, message: NormalizedMessage): boolean {
    if (!mapping.filterCriteria) return true;
    let body: unknown = message.body; try { body = JSON.parse(message.body); } catch { /* Plain strings remain strings. */ }
    return mapping.filterCriteria.Filters.some(filter => { try { return eventPatternMatch({ body }, JSON.parse(filter.Pattern)); } catch { return false; } });
  }

  private async receive(mapping: LambdaSqsMappingState, count: number, visibilityTimeoutSeconds: number, abortSignal: AbortSignal): Promise<NormalizedMessage[]> {
    if (!this.service || count <= 0) return [];
    const roleArn = this.callbacks.resolveFunction(mapping.functionArn).role;
    const result = await this.service.receiveForConsumer({ queueArn: mapping.eventSourceArn, maxNumberOfMessages: Math.min(10, count), visibilityTimeoutSeconds, waitTimeSeconds: 20, roleArn, abortSignal });
    const messages = result.messages.map(message => this.normalize(message)).filter((message): message is NormalizedMessage => Boolean(message));
    if (messages.length) await this.metric(mapping, "EventSourceMappingPolled", messages.length);
    const retried = messages.filter(message => Number(message.attributes.ApproximateReceiveCount ?? "1") > 1).length;
    if (retried) await this.metric(mapping, "EventSourceMappingRetried", retried);
    if (!this.callbacks.isCurrent(mapping)) return [];
    const matching = new Set(messages.filter(message => this.matches(mapping, message)).map(message => message.messageId));
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
    if (acknowledged.length && this.callbacks.isCurrent(mapping)) await this.service.acknowledge({ queueArn: mapping.eventSourceArn, receiptHandles: acknowledged.map(message => message.receiptHandle), roleArn });
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
    try { queue = this.resolveQueue(mapping.eventSourceArn); target = this.callbacks.resolveFunction(mapping.functionArn); this.validateFunction(target, queue); }
    catch (error) {
      if (error instanceof AwsError && error.code === "ResourceNotFoundException") { mapping.enabled = false; mapping.state = "Disabled"; mapping.stateTransitionReason = "Event source queue no longer exists"; this.pending.delete(mapping.uuid); }
      mapping.lastProcessingResult = error instanceof Error ? error.message : String(error); mapping.lastModified = this.clock.now(); await this.store.save().catch(() => undefined); return;
    }
    const maximumConcurrency = this.maximumConcurrency(mapping);
    let available = maximumConcurrency === undefined ? Number.POSITIVE_INFINITY : maximumConcurrency - this.active(mapping.uuid); if (available <= 0) return;
    let pending = this.pending.get(mapping.uuid);
    if (pending) {
      const remaining = mapping.batchSize - pending.messages.length;
      if (!pending.ready && remaining > 0) pending.messages.push(...await this.receive(mapping, remaining, queue.visibilityTimeoutSeconds, abortSignal));
      if (!this.callbacks.isCurrent(mapping)) return;
      if (pending.messages.length >= mapping.batchSize || this.clock.now() - pending.startedAt >= mapping.maximumBatchingWindowInSeconds * 1000) pending.ready = true;
      if (!pending.ready) return;
      this.pending.delete(mapping.uuid);
      const chunks = this.chunks(mapping.eventSourceArn, pending.messages);
      for (let index = 0; index < chunks.length; index++) {
        if (available <= 0 || !this.launch(mapping, chunks[index])) { this.pending.set(mapping.uuid, { queueArn: mapping.eventSourceArn, messages: chunks.slice(index).flat(), startedAt: pending.startedAt, ready: true }); break; }
        available -= 1;
      }
    }
    while (available > 0 && this.callbacks.isCurrent(mapping)) {
      const messages: NormalizedMessage[] = [];
      while (messages.length < mapping.batchSize) {
        const received = await this.receive(mapping, mapping.batchSize - messages.length, queue.visibilityTimeoutSeconds, abortSignal); messages.push(...received);
        if (received.length < Math.min(10, mapping.batchSize - messages.length + received.length)) break;
        if (this.payload(mapping.eventSourceArn, messages).length >= SIX_MIB) break;
      }
      if (!messages.length) break;
      if (!this.callbacks.isCurrent(mapping)) return;
      if (messages.length < mapping.batchSize && mapping.maximumBatchingWindowInSeconds > 0) { this.pending.set(mapping.uuid, { queueArn: mapping.eventSourceArn, messages, startedAt: this.clock.now(), ready: false }); break; }
      const chunks = this.chunks(mapping.eventSourceArn, messages);
      for (let index = 0; index < chunks.length; index++) {
        if (available <= 0 || !this.launch(mapping, chunks[index])) { this.pending.set(mapping.uuid, { queueArn: mapping.eventSourceArn, messages: chunks.slice(index).flat(), startedAt: this.clock.now(), ready: true }); break; }
        available -= 1;
      }
    }
  }

  private messageGroups(mapping: LambdaSqsMappingState, messages: NormalizedMessage[]): Set<string> {
    if (!this.resolveQueue(mapping.eventSourceArn).fifo) return new Set();
    return new Set(messages.map(message => message.attributes.MessageGroupId ?? message.messageId));
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
      this.tasks.delete(task); if (!this.stopped) this.callbacks.wake();
    });
    this.tasks.add(task); void task.catch(() => undefined);
    return true;
  }

  private async invoke(mapping: LambdaSqsMappingState, messages: NormalizedMessage[]): Promise<void> {
    let result = "OK"; let metricName = "EventSourceMappingSucceeded"; let interrupted = false; const started = this.clock.now();
    try {
      const lineage = [...new Set(messages.flatMap(message => message.deliveryLineage ?? []))].slice(-32);
      const invocation = await this.callbacks.invoke(mapping.functionName, mapping.functionQualifier, this.payload(mapping.eventSourceArn, messages), id(24), lineage);
      if (invocation.interrupted) { interrupted = true; return; }
      if (invocation.functionError) { result = "Function error"; metricName = "EventSourceMappingFailed"; return; }
      let successful = messages;
      if (mapping.functionResponseTypes.includes("ReportBatchItemFailures")) {
        let response: any; try { response = JSON.parse(invocation.payload.toString("utf8")); } catch { result = "Invalid partial batch response"; metricName = "EventSourceMappingFailed"; return; }
        const failures = response?.batchItemFailures;
        if (failures !== undefined && !Array.isArray(failures)) { result = "Invalid partial batch response"; metricName = "EventSourceMappingFailed"; return; }
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
      if (successful.length && this.callbacks.isCurrent(mapping) && this.service) await this.service.acknowledge({ queueArn: mapping.eventSourceArn, receiptHandles: successful.map(message => message.receiptHandle), roleArn: this.callbacks.resolveFunction(mapping.functionArn).role });
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
  async stop(): Promise<void> { this.stopped = true; this.pending.clear(); for (const poll of this.polls.values()) poll.controller.abort(); await Promise.allSettled([...this.polls.values()].map(poll => poll.promise)); this.polls.clear(); await Promise.allSettled([...this.tasks]); this.activeGroups.clear(); }
}
