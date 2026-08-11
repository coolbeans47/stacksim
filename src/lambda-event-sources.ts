import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AwsError } from "./errors.js";
import type { Clock } from "./core/clock.js";
import type { Scheduler } from "./core/scheduler.js";
import type { TelemetryBus } from "./core/telemetry.js";
import { PaginationTokens } from "./core/pagination.js";
import { evaluateRoleAuthorization } from "./iam/evaluator.js";
import { DynamoStreamPersistence } from "./dynamodb/streams.js";
import type { DynamoStreamDescriptorState, DynamoStreamRecordState, LambdaEventSourceMappingState } from "./types.js";
import type { StateStore } from "./state.js";
import { id, json, readJson } from "./util.js";
import { LambdaSqsEventSource, type LambdaSqsMappingState, type LambdaSqsServicePort } from "./lambda-sqs-event-source.js";

interface EventSourceFunction {
  functionName: string;
  qualifier?: string;
  functionArn: string;
  role: string;
  timeout: number;
}

interface EventSourceInvokeResult {
  payload: Buffer;
  functionError?: string;
  interrupted?: boolean;
}

interface EventSourceCallbacks {
  resolveFunction(target: string): EventSourceFunction;
  invoke(functionName: string, qualifier: string | undefined, payload: Buffer, requestId: string, lineage?: string[]): Promise<EventSourceInvokeResult>;
}

export interface LambdaSnsServicePort {
  assertTopicExists(topicArn: string): void;
  publishAuthorized(input: { TopicArn: string; Message: string; MessageAttributes?: Record<string, unknown> }, caller: {
    principal: string;
    sourceArn: string;
    sourceAccount: string;
    identityAuthorized?: boolean;
    lineage?: string[];
  }): Promise<{ MessageId: string }>;
}

type StoredEventSourceMapping = LambdaEventSourceMappingState | LambdaSqsMappingState;

const POLL_INTERVAL_MS = 250;
const RETRY_INTERVAL_MS = 1_000;
const SOURCE_FIELDS = [
  "AmazonManagedKafkaEventSourceConfig", "DocumentDBEventSourceConfig", "KMSKeyArn", "Queues", "ScalingConfig",
  "LoggingConfig", "MetricsConfig", "ProvisionedPollerConfig", "SelfManagedEventSource", "SelfManagedKafkaEventSourceConfig", "SourceAccessConfigurations", "Topics",
];

function sequenceValue(value: string): bigint {
  try { return BigInt(value); } catch { throw new AwsError("InvalidParameterValueException", "The stream sequence number is invalid"); }
}

function afterSequence(value: string): string {
  return String(sequenceValue(value) + 1n).padStart(Math.max(21, value.length), "0");
}

function compareSequence(left: string, right: string): number {
  const a = sequenceValue(left); const b = sequenceValue(right); return a < b ? -1 : a > b ? 1 : 0;
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

export class LambdaEventSourceMappings {
  private readonly persistence: DynamoStreamPersistence;
  private readonly sqsSource: LambdaSqsEventSource;
  private workerCancel?: () => void;
  private workerRunning = false;
  private workerPromise?: Promise<void>;
  private stopped = true;
  private sqsService?: LambdaSqsServicePort;
  private snsService?: LambdaSnsServicePort;

  constructor(
    private readonly store: StateStore,
    private readonly region: string,
    private readonly clock: Clock,
    private readonly callbacks: EventSourceCallbacks,
    private readonly authMode: "off" | "validate" | "enforce",
    private readonly telemetry?: TelemetryBus,
    private readonly scheduler?: Scheduler,
    sqs?: LambdaSqsServicePort,
  ) {
    this.persistence = new DynamoStreamPersistence(store.root, store.accountId, region);
    this.sqsService = sqs;
    this.sqsSource = new LambdaSqsEventSource(store, region, clock, {
      resolveFunction: target => this.callbacks.resolveFunction(target),
      invoke: (functionName, qualifier, payload, requestId, lineage) => this.callbacks.invoke(functionName, qualifier, payload, requestId, lineage),
      isCurrent: mapping => this.mappings[mapping.uuid] === mapping && mapping.enabled && mapping.state === "Enabled",
      wake: () => this.scheduleWorker(0),
    }, authMode, telemetry, sqs);
  }

  private get tokens(): PaginationTokens { return new PaginationTokens(this.store.state.installation.paginationSecret); }

  private get mappings(): Record<string, StoredEventSourceMapping> {
    return (this.store.regionState(this.region).lambdaEventSourceMappings ??= {}) as unknown as Record<string, StoredEventSourceMapping>;
  }

  private require(uuid: string): StoredEventSourceMapping {
    const mapping = this.mappings[uuid];
    if (!mapping) throw new AwsError("ResourceNotFoundException", `The resource you requested does not exist: ${uuid}`, 404);
    return mapping;
  }

  private isSqsMapping(mapping: StoredEventSourceMapping): mapping is LambdaSqsMappingState { return (mapping as LambdaSqsMappingState).sourceType === "sqs" || this.sqsSource.isSqsArn(mapping.eventSourceArn); }

  private descriptor(arn: string): DynamoStreamDescriptorState | undefined {
    return this.store.regionState(this.region).dynamodbStreams[arn];
  }

  private view(mapping: StoredEventSourceMapping): any {
    if (this.isSqsMapping(mapping)) return this.sqsSource.view(mapping);
    return {
      UUID: mapping.uuid,
      StartingPosition: mapping.startingPosition,
      BatchSize: mapping.batchSize,
      MaximumBatchingWindowInSeconds: mapping.maximumBatchingWindowInSeconds,
      ParallelizationFactor: mapping.parallelizationFactor,
      EventSourceArn: mapping.eventSourceArn,
      FunctionArn: mapping.functionArn,
      LastModified: mapping.lastModified / 1000,
      LastProcessingResult: mapping.lastProcessingResult,
      State: mapping.state,
      StateTransitionReason: mapping.stateTransitionReason,
      DestinationConfig: mapping.destinationOnFailure ? { OnFailure: { Destination: mapping.destinationOnFailure } } : {},
      MaximumRecordAgeInSeconds: mapping.maximumRecordAgeInSeconds,
      BisectBatchOnFunctionError: mapping.bisectBatchOnFunctionError,
      MaximumRetryAttempts: mapping.maximumRetryAttempts,
      TumblingWindowInSeconds: mapping.tumblingWindowInSeconds,
      FunctionResponseTypes: mapping.functionResponseTypes,
      ...(mapping.filterCriteria ? { FilterCriteria: structuredClone(mapping.filterCriteria) } : {}),
      EventSourceMappingArn: mapping.eventSourceMappingArn,
    };
  }

  private integer(value: unknown, field: string, minimum: number, maximum: number, fallback: number): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new AwsError("InvalidParameterValueException", `${field} must be between ${minimum} and ${maximum}`);
    return Number(value);
  }

  private retryValue(value: unknown, field: string, fallback: number): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || (Number(value) !== -1 && (Number(value) < 0 || Number(value) > 10_000))) throw new AwsError("InvalidParameterValueException", `${field} must be -1 or between 0 and 10000`);
    return Number(value);
  }

  private ageValue(value: unknown, fallback: number): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || (Number(value) !== -1 && (Number(value) < 60 || Number(value) > 604_800))) throw new AwsError("InvalidParameterValueException", "MaximumRecordAgeInSeconds must be -1 or between 60 and 604800");
    return Number(value);
  }

  private filterCriteria(value: unknown, fallback?: LambdaEventSourceMappingState["filterCriteria"]): LambdaEventSourceMappingState["filterCriteria"] {
    if (value === undefined) return fallback ? structuredClone(fallback) : undefined;
    if (value === null || (typeof value === "object" && value && Array.isArray((value as any).Filters) && (value as any).Filters.length === 0)) return undefined;
    const filters = (value as any)?.Filters;
    if (!Array.isArray(filters) || filters.length < 1 || filters.length > 5) throw new AwsError("InvalidParameterValueException", "FilterCriteria.Filters must contain between 1 and 5 filters");
    return { Filters: filters.map((filter: any) => {
      if (!filter || typeof filter.Pattern !== "string" || Buffer.byteLength(filter.Pattern) > 4096) throw new AwsError("InvalidParameterValueException", "Each filter Pattern must be a JSON string no larger than 4096 bytes");
      let parsed: any; try { parsed = JSON.parse(filter.Pattern); } catch { throw new AwsError("InvalidParameterValueException", "Filter Pattern must contain valid JSON"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some(key => key !== "dynamodb")) throw new AwsError("InvalidParameterValueException", "DynamoDB stream filter patterns may only use the dynamodb event key");
      return { Pattern: filter.Pattern };
    }) };
  }

  private responseTypes(value: unknown, fallback: Array<"ReportBatchItemFailures">): Array<"ReportBatchItemFailures"> {
    if (value === undefined) return [...fallback];
    if (!Array.isArray(value) || value.some(item => item !== "ReportBatchItemFailures") || value.length > 1) throw new AwsError("InvalidParameterValueException", "FunctionResponseTypes only supports ReportBatchItemFailures");
    return [...value] as Array<"ReportBatchItemFailures">;
  }

  private rejectUnsupported(input: any): void {
    for (const field of SOURCE_FIELDS) if (input[field] !== undefined) throw new AwsError("InvalidParameterValueException", `${field} is not supported for DynamoDB stream event source mappings in this simulator`);
  }

  private discardedRecordDestination(input: any, target: EventSourceFunction, previous?: string): string | undefined {
    if (input.DestinationConfig === undefined) return previous;
    const config = input.DestinationConfig;
    if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some(key => key !== "OnFailure")) throw new AwsError("InvalidParameterValueException", "DestinationConfig must contain only OnFailure");
    if (config.OnFailure === undefined) return previous;
    if (!config.OnFailure || typeof config.OnFailure !== "object" || Array.isArray(config.OnFailure) || Object.keys(config.OnFailure).some(key => key !== "Destination")) throw new AwsError("InvalidParameterValueException", "DestinationConfig.OnFailure must contain only Destination");
    const destination = config.OnFailure.Destination;
    if (destination === undefined || destination === "") return undefined;
    if (typeof destination !== "string" || !/^arn:(?:aws|aws-us-gov|aws-cn):(sqs|sns|s3):/.test(destination)) throw new AwsError("InvalidParameterValueException", "DynamoDB discarded-record destinations must be an SQS, SNS, or S3 ARN");
    if (destination.includes(":sns:")) {
      const match = destination.match(/^arn:(?:aws|aws-us-gov|aws-cn):sns:([^:]+):(\d{12}):([^:]+)$/);
      if (!match || match[1] !== this.region || match[2] !== this.store.accountId) throw new AwsError("InvalidParameterValueException", "DynamoDB discarded-record SNS destinations must use this simulator account and Region");
      if (!this.snsService) throw new AwsError("InvalidParameterValueException", "The SNS discarded-record destination dependency is not available in this simulator");
      try { this.snsService.assertTopicExists(destination); } catch { throw new AwsError("ResourceNotFoundException", "The discarded-record SNS destination topic does not exist", 404); }
      if (this.authMode === "enforce" && evaluateRoleAuthorization(this.store.ensureAccount().iam, target.role, "sns:Publish", destination).decision !== "allowed") throw new AwsError("InvalidParameterValueException", `The function execution role is not authorized to publish discarded records to ${destination}`);
      return destination;
    }
    if (!destination.includes(":sqs:")) throw new AwsError("InvalidParameterValueException", `The ${destination.split(":")[2]} discarded-record destination dependency is not available in this simulator`);
    const match = destination.match(/^arn:(?:aws|aws-us-gov|aws-cn):sqs:([^:]+):(\d{12}):([^:]+)$/);
    if (!match || match[1] !== this.region || match[2] !== this.store.accountId) throw new AwsError("InvalidParameterValueException", "DynamoDB discarded-record SQS destinations must use this simulator account and Region");
    if (!this.sqsService) throw new AwsError("InvalidParameterValueException", "The SQS discarded-record destination dependency is not available in this simulator");
    let queue: ReturnType<LambdaSqsServicePort["resolveQueueArn"]>; try { queue = this.sqsService.resolveQueueArn(destination); } catch { queue = undefined; }
    if (!queue) throw new AwsError("ResourceNotFoundException", "The discarded-record SQS destination queue does not exist", 404);
    if (this.authMode === "enforce" && evaluateRoleAuthorization(this.store.ensureAccount().iam, target.role, "sqs:SendMessage", destination).decision !== "allowed") throw new AwsError("InvalidParameterValueException", `The function execution role is not authorized to send discarded records to ${destination}`);
    return destination;
  }

  private source(input: unknown): DynamoStreamDescriptorState {
    if (typeof input !== "string" || !input) throw new AwsError("InvalidParameterValueException", "EventSourceArn is required");
    if (!input.startsWith(`arn:aws:dynamodb:${this.region}:${this.store.accountId}:table/`)) {
      const service = input.startsWith("arn:") ? input.split(":")[2] : "unknown";
      throw new AwsError("InvalidParameterValueException", `${service === "dynamodb" ? "Cross-account or cross-Region DynamoDB streams are" : `${service} event sources are`} not supported in this simulator`);
    }
    const descriptor = this.descriptor(input);
    if (!descriptor || !["ENABLING", "ENABLED"].includes(descriptor.streamStatus)) throw new AwsError("ResourceNotFoundException", "The DynamoDB stream does not exist or is not enabled", 404);
    return descriptor;
  }

  private ensureRolePermissions(target: EventSourceFunction, streamArn: string): void {
    if (this.authMode !== "enforce") return;
    const iam = this.store.ensureAccount().iam;
    const checks: Array<[string, string]> = [
      ["dynamodb:DescribeStream", streamArn], ["dynamodb:GetRecords", streamArn], ["dynamodb:GetShardIterator", streamArn], ["dynamodb:ListStreams", "*"],
    ];
    if (checks.some(([action, resource]) => evaluateRoleAuthorization(iam, target.role, action, resource).decision !== "allowed")) throw new AwsError("InvalidParameterValueException", `The function execution role is not authorized to read DynamoDB stream ${streamArn}`);
  }

  private initialSequence(descriptor: DynamoStreamDescriptorState, position: "TRIM_HORIZON" | "LATEST"): string {
    if (position === "LATEST") return descriptor.lastSequenceNumber ? afterSequence(descriptor.lastSequenceNumber) : descriptor.startingSequenceNumber;
    return descriptor.trimmedThroughSequence ? afterSequence(descriptor.trimmedThroughSequence) : descriptor.startingSequenceNumber;
  }

  private commonConfiguration(input: any, target: EventSourceFunction, previous?: LambdaEventSourceMappingState): Pick<LambdaEventSourceMappingState, "batchSize" | "maximumBatchingWindowInSeconds" | "parallelizationFactor" | "maximumRecordAgeInSeconds" | "maximumRetryAttempts" | "bisectBatchOnFunctionError" | "tumblingWindowInSeconds" | "functionResponseTypes" | "filterCriteria" | "destinationOnFailure"> {
    this.rejectUnsupported(input);
    const batchSize = this.integer(input.BatchSize, "BatchSize", 1, 10_000, previous?.batchSize ?? 100);
    const maximumBatchingWindowInSeconds = this.integer(input.MaximumBatchingWindowInSeconds, "MaximumBatchingWindowInSeconds", 0, 300, previous?.maximumBatchingWindowInSeconds ?? 0);
    const batchSettingsChanged = !previous || (input.BatchSize !== undefined && batchSize !== previous.batchSize) || (input.MaximumBatchingWindowInSeconds !== undefined && maximumBatchingWindowInSeconds !== previous.maximumBatchingWindowInSeconds);
    if (batchSettingsChanged && input.BatchSize !== undefined && batchSize > 10 && maximumBatchingWindowInSeconds < 1) throw new AwsError("InvalidParameterValueException", "MaximumBatchingWindowInSeconds must be at least 1 when BatchSize is greater than 10");
    const bisect = input.BisectBatchOnFunctionError === undefined ? previous?.bisectBatchOnFunctionError ?? false : input.BisectBatchOnFunctionError;
    if (typeof bisect !== "boolean") throw new AwsError("InvalidParameterValueException", "BisectBatchOnFunctionError must be a boolean");
    return {
      batchSize,
      maximumBatchingWindowInSeconds,
      parallelizationFactor: this.integer(input.ParallelizationFactor, "ParallelizationFactor", 1, 10, previous?.parallelizationFactor ?? 1),
      maximumRecordAgeInSeconds: this.ageValue(input.MaximumRecordAgeInSeconds, previous?.maximumRecordAgeInSeconds ?? -1),
      maximumRetryAttempts: this.retryValue(input.MaximumRetryAttempts, "MaximumRetryAttempts", previous?.maximumRetryAttempts ?? -1),
      bisectBatchOnFunctionError: bisect,
      tumblingWindowInSeconds: this.integer(input.TumblingWindowInSeconds, "TumblingWindowInSeconds", 0, 900, previous?.tumblingWindowInSeconds ?? 0),
      functionResponseTypes: this.responseTypes(input.FunctionResponseTypes, previous?.functionResponseTypes ?? []),
      filterCriteria: this.filterCriteria(input.FilterCriteria, previous?.filterCriteria),
      destinationOnFailure: this.discardedRecordDestination(input, target, previous?.destinationOnFailure),
    };
  }

  private async create(input: any): Promise<any> {
    if (this.sqsSource.isSqsArn(input.EventSourceArn)) return this.createSqs(input);
    const descriptor = this.source(input.EventSourceArn);
    if (!input.FunctionName) throw new AwsError("InvalidParameterValueException", "FunctionName is required");
    const target = this.callbacks.resolveFunction(String(input.FunctionName)); this.ensureRolePermissions(target, descriptor.streamArn);
    if (input.StartingPositionTimestamp !== undefined) throw new AwsError("InvalidParameterValueException", "StartingPositionTimestamp is not supported for DynamoDB Streams; use TRIM_HORIZON or LATEST");
    if (!new Set(["TRIM_HORIZON", "LATEST"]).has(input.StartingPosition)) throw new AwsError("InvalidParameterValueException", "StartingPosition must be TRIM_HORIZON or LATEST");
    if (Object.values(this.mappings).some(mapping => mapping.eventSourceArn === descriptor.streamArn && mapping.functionArn === target.functionArn)) throw new AwsError("ResourceConflictException", "An event source mapping for this function and event source already exists", 409);
    const configuration = this.commonConfiguration(input, target); const uuid = randomUUID(); const now = this.clock.now(); const enabled = input.Enabled === undefined ? true : input.Enabled;
    if (typeof enabled !== "boolean") throw new AwsError("InvalidParameterValueException", "Enabled must be a boolean");
    const mapping: LambdaEventSourceMappingState = {
      uuid, eventSourceMappingArn: `arn:aws:lambda:${this.region}:${this.store.accountId}:event-source-mapping:${uuid}`,
      eventSourceArn: descriptor.streamArn, functionName: target.functionName, ...(target.qualifier ? { functionQualifier: target.qualifier } : {}), functionArn: target.functionArn,
      enabled, state: "Creating", stateTransitionReason: "USER_INITIATED", ...configuration,
      startingPosition: input.StartingPosition, tags: this.tags(input.Tags), createdAt: now, lastModified: now, lastProcessingResult: "No records processed",
      nextSequenceNumber: this.initialSequence(descriptor, input.StartingPosition),
    };
    this.mappings[uuid] = mapping; await this.store.save(); this.transition(mapping); this.scheduleWorker(0); return this.view(mapping);
  }

  private async createSqs(input: any): Promise<any> {
    const queue = this.sqsSource.resolveQueue(String(input.EventSourceArn));
    if (!input.FunctionName) throw new AwsError("InvalidParameterValueException", "FunctionName is required");
    const target = this.callbacks.resolveFunction(String(input.FunctionName)); this.sqsSource.validateFunction(target, queue);
    if (Object.values(this.mappings).some(mapping => mapping.eventSourceArn === queue.queueArn && mapping.functionArn === target.functionArn)) throw new AwsError("ResourceConflictException", "An event source mapping for this function and event source already exists", 409);
    const configuration = this.sqsSource.configuration(input, undefined, queue); const uuid = randomUUID(); const now = this.clock.now(); const enabled = input.Enabled === undefined ? true : input.Enabled;
    if (typeof enabled !== "boolean") throw new AwsError("InvalidParameterValueException", "Enabled must be a boolean");
    const mapping: LambdaSqsMappingState = {
      sourceType: "sqs", uuid, eventSourceMappingArn: `arn:aws:lambda:${this.region}:${this.store.accountId}:event-source-mapping:${uuid}`,
      eventSourceArn: queue.queueArn, functionName: target.functionName, ...(target.qualifier ? { functionQualifier: target.qualifier } : {}), functionArn: target.functionArn,
      enabled, state: "Creating", stateTransitionReason: "USER_INITIATED", ...configuration,
      tags: this.tags(input.Tags), createdAt: now, lastModified: now, lastProcessingResult: "No records processed",
    };
    this.mappings[uuid] = mapping; await this.store.save(); this.transition(mapping); this.scheduleWorker(0); return this.view(mapping);
  }

  private tags(value: unknown): Record<string, string> {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("InvalidParameterValueException", "Tags must be a string map");
    const result: Record<string, string> = {}; for (const [key, item] of Object.entries(value as object)) { if (!key || key.length > 128 || typeof item !== "string" || item.length > 256) throw new AwsError("InvalidParameterValueException", "Invalid tag"); result[key] = item; }
    if (Object.keys(result).length > 50) throw new AwsError("InvalidParameterValueException", "A maximum of 50 tags is allowed"); return result;
  }

  private async update(mapping: StoredEventSourceMapping, input: any): Promise<any> {
    if (this.isSqsMapping(mapping)) return this.updateSqs(mapping, input);
    if (input.EventSourceArn !== undefined || input.StartingPosition !== undefined || input.StartingPositionTimestamp !== undefined || input.Tags !== undefined) throw new AwsError("InvalidParameterValueException", "EventSourceArn, StartingPosition, StartingPositionTimestamp, and Tags cannot be updated");
    const previousTumblingWindow = mapping.tumblingWindowInSeconds; const target = input.FunctionName !== undefined ? this.callbacks.resolveFunction(String(input.FunctionName)) : this.callbacks.resolveFunction(mapping.functionArn); this.ensureRolePermissions(target, mapping.eventSourceArn); const configuration = this.commonConfiguration(input, target, mapping);
    if (input.Enabled !== undefined && typeof input.Enabled !== "boolean") throw new AwsError("InvalidParameterValueException", "Enabled must be a boolean");
    Object.assign(mapping, configuration);
    if (input.TumblingWindowInSeconds !== undefined && configuration.tumblingWindowInSeconds !== previousTumblingWindow) { delete mapping.tumblingWindowState; delete mapping.pendingBatch; delete mapping.batchWindowStartedAt; }
    if (target) { mapping.functionName = target.functionName; mapping.functionArn = target.functionArn; if (target.qualifier) mapping.functionQualifier = target.qualifier; else delete mapping.functionQualifier; }
    if (input.Enabled !== undefined) mapping.enabled = input.Enabled;
    mapping.state = "Updating"; mapping.stateTransitionReason = "USER_INITIATED"; mapping.lastModified = this.clock.now();
    await this.store.save(); this.transition(mapping); this.scheduleWorker(0); return this.view(mapping);
  }

  private async updateSqs(mapping: LambdaSqsMappingState, input: any): Promise<any> {
    if (input.EventSourceArn !== undefined || input.Tags !== undefined) throw new AwsError("InvalidParameterValueException", "EventSourceArn and Tags cannot be updated");
    const queue = this.sqsSource.resolveQueue(mapping.eventSourceArn); const configuration = this.sqsSource.configuration(input, mapping, queue); let target: EventSourceFunction | undefined;
    if (input.FunctionName !== undefined) target = this.callbacks.resolveFunction(String(input.FunctionName));
    this.sqsSource.validateFunction(target ?? this.callbacks.resolveFunction(mapping.functionArn), queue);
    if (input.Enabled !== undefined && typeof input.Enabled !== "boolean") throw new AwsError("InvalidParameterValueException", "Enabled must be a boolean");
    Object.assign(mapping, configuration);
    if (input.ScalingConfig !== undefined && configuration.scalingMaximumConcurrency === undefined) delete mapping.scalingMaximumConcurrency;
    if (target) { mapping.functionName = target.functionName; mapping.functionArn = target.functionArn; if (target.qualifier) mapping.functionQualifier = target.qualifier; else delete mapping.functionQualifier; }
    if (input.Enabled !== undefined) mapping.enabled = input.Enabled;
    mapping.state = "Updating"; mapping.stateTransitionReason = "USER_INITIATED"; mapping.lastModified = this.clock.now(); this.sqsSource.forget(mapping.uuid);
    await this.store.save(); this.transition(mapping); this.scheduleWorker(0); return this.view(mapping);
  }

  private async list(url: URL): Promise<any> {
    const max = this.integer(url.searchParams.has("MaxItems") ? Number(url.searchParams.get("MaxItems")) : undefined, "MaxItems", 1, 10_000, 100);
    const source = url.searchParams.get("EventSourceArn") ?? undefined; const functionName = url.searchParams.get("FunctionName") ?? undefined;
    let resolvedFunction: EventSourceFunction | undefined; if (functionName) resolvedFunction = this.callbacks.resolveFunction(functionName);
    const values = Object.values(this.mappings).filter(mapping => (!source || mapping.eventSourceArn === source) && (!resolvedFunction || mapping.functionArn === resolvedFunction.functionArn)).sort((left, right) => left.uuid.localeCompare(right.uuid));
    let start = 0; const marker = url.searchParams.get("Marker"); if (marker) try { const cursor = this.tokens.decode<{ source?: string; functionArn?: string; index: number }>("ListEventSourceMappings", marker); if (cursor.source !== source || cursor.functionArn !== resolvedFunction?.functionArn || !Number.isInteger(cursor.index) || cursor.index < 0) throw new Error(); start = cursor.index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid Marker"); }
    const page = values.slice(start, start + max); const next = start + page.length;
    return { EventSourceMappings: page.map(mapping => this.view(mapping)), ...(next < values.length ? { NextMarker: this.tokens.encode("ListEventSourceMappings", { source, functionArn: resolvedFunction?.functionArn, index: next }) } : {}) };
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const match = pathname.match(/^\/2015-03-31\/event-source-mappings(?:\/([^/]+))?$/);
    if (!match) throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404);
    const uuid = match[1] ? decodeURIComponent(match[1]) : undefined;
    if (!uuid && req.method === "POST") return json(res, await this.create(await readJson(req)), 202);
    if (!uuid && req.method === "GET") return json(res, await this.list(url));
    if (!uuid) throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404);
    const mapping = this.require(uuid);
    if (req.method === "GET") return json(res, this.view(mapping));
    if (req.method === "PUT") return json(res, await this.update(mapping, await readJson(req)), 202);
    if (req.method === "DELETE") { const deleted = { ...mapping, state: "Deleting" as const, stateTransitionReason: "USER_INITIATED", lastModified: this.clock.now() } as StoredEventSourceMapping; delete this.mappings[uuid]; if (this.isSqsMapping(mapping)) this.sqsSource.forget(uuid); await this.store.save(); return json(res, this.view(deleted), 202); }
    throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404);
  }

  private matchesFilters(mapping: LambdaEventSourceMappingState, record: DynamoStreamRecordState): boolean {
    if (!mapping.filterCriteria) return true;
    return mapping.filterCriteria.Filters.some(filter => { try { return eventPatternMatch(record, JSON.parse(filter.Pattern)); } catch { return false; } });
  }

  private scheduleWorker(delayMs: number): void {
    if (this.stopped || this.workerRunning || this.workerCancel || !Object.values(this.mappings).some(mapping => mapping.enabled)) return;
    const callback = () => { this.workerCancel = undefined; const promise = this.runWorker(); this.workerPromise = promise; void promise.finally(() => { if (this.workerPromise === promise) this.workerPromise = undefined; }).catch(() => undefined); };
    if (this.scheduler) this.workerCancel = this.scheduler.schedule(callback, Math.max(0, delayMs));
    else { const handle = this.clock.setTimeout(callback, Math.max(0, delayMs)); this.workerCancel = () => this.clock.clearTimeout(handle); }
  }

  private transition(mapping: StoredEventSourceMapping): void {
    const complete = async () => { if (!this.mappings[mapping.uuid] || !["Creating", "Updating"].includes(mapping.state)) return; mapping.state = mapping.enabled ? "Enabled" : "Disabled"; mapping.lastModified = this.clock.now(); await this.store.save(); if (mapping.enabled) this.scheduleWorker(0); };
    if (this.scheduler) this.scheduler.schedule(complete, 0); else this.clock.setTimeout(() => { void complete(); }, 0);
  }

  private async runWorker(): Promise<void> {
    if (this.stopped || this.workerRunning) return; this.workerRunning = true;
    try {
      for (const mapping of Object.values(this.mappings).filter(item => item.enabled && item.state === "Enabled").sort((left, right) => left.uuid.localeCompare(right.uuid))) {
        try { if (this.isSqsMapping(mapping)) await this.sqsSource.process(mapping); else await this.processMapping(mapping); }
        catch (error) { mapping.lastProcessingResult = error instanceof Error ? error.message : String(error); mapping.lastModified = this.clock.now(); await this.store.save().catch(() => undefined); }
      }
    } finally { this.workerRunning = false; this.scheduleWorker(POLL_INTERVAL_MS); }
  }

  private async processMapping(mapping: LambdaEventSourceMappingState): Promise<void> {
    const descriptor = this.descriptor(mapping.eventSourceArn);
    if (!descriptor) return this.disable(mapping, "Event source stream no longer exists");
    let target: EventSourceFunction; try { target = this.callbacks.resolveFunction(mapping.functionArn); } catch { return this.disable(mapping, "Function or qualifier no longer exists"); }
    try { this.ensureRolePermissions(target, mapping.eventSourceArn); } catch (error) { mapping.lastProcessingResult = error instanceof Error ? error.message : String(error); return; }
    if (descriptor.trimmedThroughSequence && compareSequence(mapping.nextSequenceNumber, descriptor.trimmedThroughSequence) <= 0) { mapping.nextSequenceNumber = afterSequence(descriptor.trimmedThroughSequence); delete mapping.pendingBatch; delete mapping.batchWindowStartedAt; mapping.lastProcessingResult = "Records expired"; await this.store.save(); }
    const records = await this.persistence.read(descriptor);
    if (mapping.pendingBatch) {
      if (mapping.pendingBatch.nextAttemptAt > this.clock.now()) return;
      const wanted = new Set(mapping.pendingBatch.sequenceNumbers); const batch = records.filter(record => wanted.has(record.dynamodb.SequenceNumber)).sort((a, b) => compareSequence(a.dynamodb.SequenceNumber, b.dynamodb.SequenceNumber));
      if (batch.length !== mapping.pendingBatch.sequenceNumbers.length) return this.discard(mapping, "Records expired before retry", batch);
      if (this.expired(mapping, batch)) return this.discard(mapping, "Records expired", batch);
      await this.invokeBatch(mapping, batch); return;
    }
    if (mapping.tumblingWindowInSeconds > 0) return this.processTumblingWindow(mapping, descriptor, records);
    const candidates = records.filter(record => compareSequence(record.dynamodb.SequenceNumber, mapping.nextSequenceNumber) >= 0).sort((a, b) => compareSequence(a.dynamodb.SequenceNumber, b.dynamodb.SequenceNumber));
    const selected: DynamoStreamRecordState[] = []; let through: string | undefined;
    const groupSize = mapping.batchSize * mapping.parallelizationFactor;
    for (const record of candidates) { through = record.dynamodb.SequenceNumber; if (this.matchesFilters(mapping, record)) selected.push(record); if (selected.length >= groupSize) break; }
    if (!selected.length) {
      if (through) { mapping.nextSequenceNumber = afterSequence(through); mapping.lastProcessingResult = "No records matched event filter"; await this.store.save(); }
      else if (descriptor.streamStatus === "DISABLED" && descriptor.endingSequenceNumber && compareSequence(mapping.nextSequenceNumber, descriptor.endingSequenceNumber) > 0) await this.disable(mapping, "Event source stream was disabled");
      return;
    }
    const windowSeconds = Math.max(mapping.maximumBatchingWindowInSeconds, mapping.tumblingWindowInSeconds);
    if (selected.length < mapping.batchSize && windowSeconds > 0) {
      mapping.batchWindowStartedAt ??= this.clock.now(); if (this.clock.now() - mapping.batchWindowStartedAt < windowSeconds * 1000) { await this.store.save(); return; }
    }
    delete mapping.batchWindowStartedAt; const now = this.clock.now(); mapping.pendingBatch = { sequenceNumbers: selected.map(record => record.dynamodb.SequenceNumber), throughSequenceNumber: through!, attempts: 0, nextAttemptAt: now, firstAttemptAt: now }; await this.store.save();
    if (this.expired(mapping, selected)) return this.discard(mapping, "Records expired", selected);
    await this.invokeBatch(mapping, selected);
  }

  private async processTumblingWindow(mapping: LambdaEventSourceMappingState, descriptor: DynamoStreamDescriptorState, records: DynamoStreamRecordState[]): Promise<void> {
    let window = mapping.tumblingWindowState; const retained = records.filter(record => compareSequence(record.dynamodb.SequenceNumber, window?.nextSequenceNumber ?? mapping.nextSequenceNumber) >= 0).sort((a, b) => compareSequence(a.dynamodb.SequenceNumber, b.dynamodb.SequenceNumber));
    if (!window) {
      const first = retained[0]; if (!first) { if (descriptor.streamStatus === "DISABLED" && descriptor.endingSequenceNumber && compareSequence(mapping.nextSequenceNumber, descriptor.endingSequenceNumber) > 0) await this.disable(mapping, "Event source stream was disabled"); return; }
      const duration = mapping.tumblingWindowInSeconds * 1000; const created = first.dynamodb.ApproximateCreationDateTime * 1000; const start = Math.floor(created / duration) * duration; window = mapping.tumblingWindowState = { start, end: start + duration, state: {}, nextSequenceNumber: mapping.nextSequenceNumber }; await this.store.save();
    }
    const candidates = records.filter(record => compareSequence(record.dynamodb.SequenceNumber, window!.nextSequenceNumber) >= 0 && record.dynamodb.ApproximateCreationDateTime * 1000 < window!.end).sort((a, b) => compareSequence(a.dynamodb.SequenceNumber, b.dynamodb.SequenceNumber));
    const selected: DynamoStreamRecordState[] = []; let through: string | undefined;
    for (const record of candidates) {
      const matches = this.matchesFilters(mapping, record); const next = matches ? [...selected, record] : selected; if (selected.length && Buffer.byteLength(JSON.stringify({ Records: next })) > 6 * 1024 * 1024) break;
      through = record.dynamodb.SequenceNumber; if (matches) selected.push(record); if (selected.length >= mapping.batchSize) break;
    }
    if (selected.length) {
      if (selected.length < mapping.batchSize && mapping.maximumBatchingWindowInSeconds > 0) { mapping.batchWindowStartedAt ??= this.clock.now(); if (this.clock.now() - mapping.batchWindowStartedAt < mapping.maximumBatchingWindowInSeconds * 1000) { await this.store.save(); return; } }
      delete mapping.batchWindowStartedAt; const now = this.clock.now(); mapping.pendingBatch = { sequenceNumbers: selected.map(record => record.dynamodb.SequenceNumber), throughSequenceNumber: through!, attempts: 0, nextAttemptAt: now, firstAttemptAt: now, tumbling: { start: window.start, end: window.end, state: structuredClone(window.state), isFinalInvokeForWindow: false } }; await this.store.save(); if (this.expired(mapping, selected)) return this.discard(mapping, "Records expired", selected); await this.invokeBatch(mapping, selected); return;
    }
    if (through) { window.nextSequenceNumber = afterSequence(through); window.throughSequenceNumber = through; mapping.lastProcessingResult = "No records matched event filter"; await this.store.save(); }
    const laterWindowExists = records.some(record => compareSequence(record.dynamodb.SequenceNumber, window!.nextSequenceNumber) >= 0 && record.dynamodb.ApproximateCreationDateTime * 1000 >= window!.end); const streamEnded = descriptor.streamStatus === "DISABLED" && descriptor.endingSequenceNumber !== undefined && compareSequence(window.nextSequenceNumber, descriptor.endingSequenceNumber) > 0;
    if ((this.clock.now() >= window.end || laterWindowExists || streamEnded) && window.throughSequenceNumber) {
      const now = this.clock.now(); mapping.pendingBatch = { sequenceNumbers: [], throughSequenceNumber: window.throughSequenceNumber, attempts: 0, nextAttemptAt: now, firstAttemptAt: now, tumbling: { start: window.start, end: window.end, state: structuredClone(window.state), isFinalInvokeForWindow: true } }; await this.store.save(); await this.invokeBatch(mapping, []);
    }
  }

  private invocationChunks(mapping: LambdaEventSourceMappingState, records: DynamoStreamRecordState[]): DynamoStreamRecordState[][] {
    const chunks: DynamoStreamRecordState[][] = []; let current: DynamoStreamRecordState[] = [];
    for (const record of records) {
      const candidate = [...current, record]; const bytes = Buffer.byteLength(JSON.stringify({ Records: candidate }));
      if (current.length && (current.length >= mapping.batchSize || bytes > 6 * 1024 * 1024)) { chunks.push(current); current = [record]; }
      else current = candidate;
    }
    if (current.length) chunks.push(current); return chunks;
  }

  private async invokeBatch(mapping: LambdaEventSourceMappingState, records: DynamoStreamRecordState[]): Promise<void> {
    const pending = mapping.pendingBatch!; pending.attempts++; await this.store.save(); const outcomes: Array<{ records: DynamoStreamRecordState[]; result?: EventSourceInvokeResult; error?: unknown }> = [];
    const chunks = pending.tumbling ? [records] : this.invocationChunks(mapping, records);
    for (let offset = 0; offset < chunks.length; offset += mapping.parallelizationFactor) {
      const wave = chunks.slice(offset, offset + mapping.parallelizationFactor);
      outcomes.push(...await Promise.all(wave.map(async batch => { const descriptor = this.descriptor(mapping.eventSourceArn); const event = pending.tumbling ? { Records: batch, window: { start: new Date(pending.tumbling.start).toISOString(), end: new Date(pending.tumbling.end).toISOString() }, state: pending.tumbling.state, shardId: descriptor?.shardId, eventSourceARN: mapping.eventSourceArn, isFinalInvokeForWindow: pending.tumbling.isFinalInvokeForWindow, isWindowTerminatedEarly: false } : { Records: batch }; try { return { records: batch, result: await this.callbacks.invoke(mapping.functionName, mapping.functionQualifier, Buffer.from(JSON.stringify(event)), id(24)) }; } catch (error) { return { records: batch, error }; } })));
    }
    if (outcomes.some(outcome => outcome.result?.interrupted)) return;
    const failedInvocation = outcomes.find(outcome => outcome.error || outcome.result?.functionError); if (failedInvocation) return this.failBatch(mapping, records, failedInvocation.error instanceof Error ? failedInvocation.error.message : "Function error");
    if (mapping.functionResponseTypes.includes("ReportBatchItemFailures")) {
      const identifiers: string[] = [];
      for (const outcome of outcomes) {
        let response: any; try { response = JSON.parse(outcome.result!.payload.toString("utf8")); } catch { return this.failBatch(mapping, records, "Invalid partial batch response"); }
        const failures = response?.batchItemFailures; if (failures !== undefined && !Array.isArray(failures)) return this.failBatch(mapping, records, "Invalid partial batch response");
        if (Array.isArray(failures)) identifiers.push(...failures.map((failure: any) => failure?.itemIdentifier));
      }
      if (identifiers.length) {
        if (identifiers.some((value: unknown) => typeof value !== "string" || !value || !pending.sequenceNumbers.includes(value))) return this.failBatch(mapping, records, "Invalid partial batch item identifier");
        const failed = [...identifiers].sort(compareSequence)[0]; const index = pending.sequenceNumbers.indexOf(failed); mapping.nextSequenceNumber = failed; pending.sequenceNumbers = pending.sequenceNumbers.slice(index); mapping.lastProcessingResult = "Partial batch failure";
        const remaining = records.filter(record => pending.sequenceNumbers.includes(record.dynamodb.SequenceNumber));
        if (this.expired(mapping, remaining) || (mapping.maximumRetryAttempts !== -1 && pending.attempts > mapping.maximumRetryAttempts)) return this.discard(mapping, this.expired(mapping, remaining) ? "Records expired" : "Retry attempts exhausted", remaining);
        pending.nextAttemptAt = this.clock.now() + RETRY_INTERVAL_MS; await this.store.save(); return;
      }
    }
    if (pending.tumbling) {
      let response: any; try { response = JSON.parse(outcomes[0].result!.payload.toString("utf8")); } catch { return this.failBatch(mapping, records, "Invalid tumbling window response"); }
      if (!response?.state || typeof response.state !== "object" || Array.isArray(response.state) || Buffer.byteLength(JSON.stringify(response.state)) > 1024 * 1024) return this.failBatch(mapping, records, "Tumbling window responses must contain a state object no larger than 1 MB");
      return this.succeedTumblingWindow(mapping, response.state);
    }
    await this.succeed(mapping);
  }

  private async succeedTumblingWindow(mapping: LambdaEventSourceMappingState, state: Record<string, unknown>): Promise<void> {
    const pending = mapping.pendingBatch!; const window = mapping.tumblingWindowState; if (!window || !pending.tumbling) return this.succeed(mapping);
    if (pending.tumbling.isFinalInvokeForWindow) { mapping.nextSequenceNumber = window.nextSequenceNumber; delete mapping.tumblingWindowState; mapping.lastProcessingResult = "OK"; }
    else { window.state = structuredClone(state); window.nextSequenceNumber = afterSequence(pending.throughSequenceNumber); window.throughSequenceNumber = pending.throughSequenceNumber; mapping.lastProcessingResult = "Window batch processed"; }
    delete mapping.pendingBatch; delete mapping.batchWindowStartedAt; mapping.lastModified = this.clock.now(); await this.store.save(); await this.metric("EventSourceMappingSucceeded", mapping);
  }

  private expired(mapping: LambdaEventSourceMappingState, records: DynamoStreamRecordState[]): boolean {
    return mapping.maximumRecordAgeInSeconds !== -1 && records.some(record => this.clock.now() - record.dynamodb.ApproximateCreationDateTime * 1000 >= mapping.maximumRecordAgeInSeconds * 1000);
  }

  private async failBatch(mapping: LambdaEventSourceMappingState, records: DynamoStreamRecordState[], result: string): Promise<void> {
    const pending = mapping.pendingBatch!;
    if (mapping.bisectBatchOnFunctionError && pending.sequenceNumbers.length > 1) {
      const half = Math.ceil(pending.sequenceNumbers.length / 2); pending.sequenceNumbers = pending.sequenceNumbers.slice(0, half); pending.throughSequenceNumber = pending.sequenceNumbers.at(-1)!; pending.attempts = 0; pending.nextAttemptAt = this.clock.now(); pending.firstAttemptAt = this.clock.now(); mapping.lastProcessingResult = "Bisected batch after function error"; await this.store.save(); return;
    }
    if (this.expired(mapping, records) || (mapping.maximumRetryAttempts !== -1 && pending.attempts > mapping.maximumRetryAttempts)) return this.discard(mapping, this.expired(mapping, records) ? "Records expired" : "Retry attempts exhausted", records);
    pending.nextAttemptAt = this.clock.now() + RETRY_INTERVAL_MS; mapping.lastProcessingResult = result; await this.store.save();
  }

  private async succeed(mapping: LambdaEventSourceMappingState): Promise<void> {
    mapping.nextSequenceNumber = afterSequence(mapping.pendingBatch!.throughSequenceNumber); delete mapping.pendingBatch; delete mapping.batchWindowStartedAt; mapping.lastProcessingResult = "OK"; mapping.lastModified = this.clock.now(); await this.store.save(); await this.metric("EventSourceMappingSucceeded", mapping);
  }

  private async deliverDiscardedRecords(mapping: LambdaEventSourceMappingState, result: string, records: DynamoStreamRecordState[]): Promise<void> {
    const destination = mapping.destinationOnFailure; const pending = mapping.pendingBatch;
    if (!destination || !pending) return;
    const condition = /expired/i.test(result) ? "RecordAgeExceeded" : "RetryAttemptsExhausted";
    const requestContext = { requestId: `${mapping.uuid}:${pending.throughSequenceNumber}`, functionArn: mapping.functionArn, condition, approximateInvokeCount: pending.attempts };
    const responseContext = { statusCode: 200, executedVersion: mapping.functionQualifier ?? "$LATEST", functionError: "Unhandled" };
    const responsePayload = { errorMessage: result, eventSourceArn: mapping.eventSourceArn, eventSourceMappingArn: mapping.eventSourceMappingArn, discardedRecordCount: pending.sequenceNumbers.length };
    let envelope: Record<string, unknown> = { version: "1.0", timestamp: new Date(this.clock.now()).toISOString(), requestContext, requestPayload: { Records: records }, responseContext, responsePayload };
    if (Buffer.byteLength(JSON.stringify(envelope)) > 900 * 1024) {
      const compact = records.slice(0, 100).map(record => ({ eventID: record.eventID, eventName: record.eventName, eventSourceARN: record.eventSourceARN, sequenceNumber: record.dynamodb.SequenceNumber, approximateCreationDateTime: record.dynamodb.ApproximateCreationDateTime }));
      envelope = { version: "1.0", timestamp: new Date(this.clock.now()).toISOString(), requestContext, requestPayload: { Records: compact, sequenceNumbers: pending.sequenceNumbers.slice(0, 1_000), truncated: true }, responseContext, responsePayload: { ...responsePayload, omittedRecordCount: Math.max(0, pending.sequenceNumbers.length - compact.length) } };
    }
    const target = this.callbacks.resolveFunction(mapping.functionArn);
    if (destination.includes(":sns:")) {
      if (!this.snsService) throw new AwsError("ResourceNotFoundException", "The SNS discarded-record destination service is unavailable", 404);
      const authorized = this.authMode !== "enforce" || evaluateRoleAuthorization(this.store.ensureAccount().iam, target.role, "sns:Publish", destination).decision === "allowed";
      if (!authorized) throw new AwsError("AccessDeniedException", `Execution role ${target.role} cannot publish discarded records to ${destination}`, 403);
      await this.snsService.publishAuthorized({ TopicArn: destination, Message: JSON.stringify(envelope) }, {
        principal: target.role,
        sourceArn: mapping.eventSourceArn,
        sourceAccount: this.store.accountId,
        identityAuthorized: true,
        lineage: [mapping.eventSourceArn],
      });
      return;
    }
    if (!this.sqsService || !this.sqsService.resolveQueueArn(destination)) throw new AwsError("ResourceNotFoundException", `Discarded-record destination queue does not exist: ${destination}`, 404);
    if (this.sqsService.sendAuthorizedMessageToArn) await this.sqsService.sendAuthorizedMessageToArn(destination, { MessageBody: JSON.stringify(envelope) }, { kind: "role", roleArn: target.role, sourceArn: mapping.eventSourceArn, sourceAccount: this.store.accountId });
    else {
      if (this.authMode === "enforce" && evaluateRoleAuthorization(this.store.ensureAccount().iam, target.role, "sqs:SendMessage", destination).decision !== "allowed") throw new AwsError("AccessDeniedException", `Execution role ${target.role} cannot send discarded records to ${destination}`, 403);
      await this.sqsService.sendMessageToArn(destination, { MessageBody: JSON.stringify(envelope) });
    }
  }

  private async discard(mapping: LambdaEventSourceMappingState, result: string, records: DynamoStreamRecordState[] = []): Promise<void> {
    let processingResult = result;
    if (mapping.destinationOnFailure) try { await this.deliverDiscardedRecords(mapping, result, records); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); processingResult = `${result}; destination delivery failed: ${message.slice(0, 256)}`; await this.metric("DestinationDeliveryFailures", mapping); }
    mapping.nextSequenceNumber = afterSequence(mapping.pendingBatch!.throughSequenceNumber); if (mapping.pendingBatch!.tumbling) delete mapping.tumblingWindowState; delete mapping.pendingBatch; delete mapping.batchWindowStartedAt; mapping.lastProcessingResult = processingResult; mapping.lastModified = this.clock.now(); await this.store.save(); await this.metric("EventSourceMappingDiscarded", mapping);
  }

  private async disable(mapping: LambdaEventSourceMappingState, reason: string): Promise<void> {
    mapping.enabled = false; mapping.state = "Disabled"; mapping.stateTransitionReason = reason; mapping.lastModified = this.clock.now(); delete mapping.pendingBatch; delete mapping.batchWindowStartedAt; await this.store.save();
  }

  private async metric(metricName: string, mapping: LambdaEventSourceMappingState): Promise<void> {
    await this.telemetry?.publish({ namespace: "AWS/Lambda", metricName, dimensions: { FunctionName: mapping.functionName, EventSourceMapping: mapping.uuid }, value: 1, unit: "Count", timestamp: this.clock.now() }).catch(() => undefined);
  }

  disableForFunction(functionName: string, qualifier?: string): void {
    let changed = false; for (const mapping of Object.values(this.mappings)) if (mapping.functionName === functionName && (qualifier === undefined || mapping.functionQualifier === qualifier)) { mapping.enabled = false; mapping.state = "Disabled"; mapping.stateTransitionReason = qualifier ? "Referenced function qualifier was deleted" : "Referenced function was deleted"; mapping.lastModified = this.clock.now(); if (this.isSqsMapping(mapping)) this.sqsSource.forget(mapping.uuid); else delete mapping.pendingBatch; changed = true; }
    if (changed) void this.store.save();
  }

  setSqsService(service: LambdaSqsServicePort): void { this.sqsService = service; this.sqsSource.setService(service); }
  setSnsService(service: LambdaSnsServicePort): void { this.snsService = service; }
  start(): void { this.stopped = false; this.sqsSource.start(); let recovered = false; for (const mapping of Object.values(this.mappings)) if (["Creating", "Updating"].includes(mapping.state)) { mapping.state = mapping.enabled ? "Enabled" : "Disabled"; mapping.lastModified = this.clock.now(); recovered = true; } if (recovered) void this.store.save(); this.scheduleWorker(0); }
  async stop(): Promise<void> { this.stopped = true; this.workerCancel?.(); this.workerCancel = undefined; await Promise.all([this.workerPromise?.catch(() => undefined), this.sqsSource.stop()]); }
}
