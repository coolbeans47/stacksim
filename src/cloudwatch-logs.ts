import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { AwsError, sendAwsError } from "./errors.js";
import type { StateStore } from "./state.js";
import type { LogDestinationState, LogEventState, LogExportTaskState, LogGroupState, LogMetricFilterState, LogMetricTransformationState, LogQueryDefinitionState, LogQueryJobState, LogQueryStatisticsState, LogResourcePolicyState, LogStreamState, LogSubscriptionFilterState } from "./types.js";
import { json, readJson } from "./util.js";
import { SegmentedStore } from "./persistence/segmented-store.js";
import type { Clock } from "./core/clock.js";
import type { Scheduler } from "./core/scheduler.js";
import { PaginationTokens } from "./core/pagination.js";
import { InsightsSyntaxError, parseInsightsQuery, validateInsightsQuery, type InsightsRecord } from "./cloudwatch-insights.js";
import {
  classifyInsightsExecution,
  finalizeInsightsExecution,
  ingestInsightsRecord,
  QueryCancelledError,
  QueryResourceLimitError,
} from "./cloudwatch-insights-executor.js";
import { discoverLogFields, logFieldType } from "./cloudwatch-log-discovery.js";
import { LogFilterSyntaxError, matchLogFilterPattern, regexCount, resolveExtractedValue, validateLogFilterPattern } from "./cloudwatch-log-filter.js";
import type { CloudWatchMetricsService } from "./cloudwatch-metrics.js";
import type { LambdaService } from "./lambda.js";
import { evaluateResourcePolicy } from "./iam/evaluator.js";
import { eventStreamMessage, writeWithBackpressure } from "./protocols/event-stream.js";

const RETENTION_DAYS = new Set([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653]);
const QUERY_STATUSES = new Set(["Scheduled", "Running", "Complete", "Failed", "Cancelled", "Timeout", "Unknown"]);
const QUERY_LANGUAGES = new Set(["CWLI", "SQL", "PPL"]);
const METRIC_UNITS = new Set(["Seconds", "Microseconds", "Milliseconds", "Bytes", "Kilobytes", "Megabytes", "Gigabytes", "Terabytes", "Bits", "Kilobits", "Megabits", "Gigabits", "Terabits", "Percent", "Count", "Bytes/Second", "Kilobytes/Second", "Megabytes/Second", "Gigabytes/Second", "Terabytes/Second", "Bits/Second", "Kilobits/Second", "Megabits/Second", "Gigabits/Second", "Terabits/Second", "Count/Second", "None"]);
const EXPORT_STATUSES = new Set(["CANCELLED", "COMPLETED", "FAILED", "PENDING", "PENDING_CANCEL", "RUNNING"]);
const QUERY_TIMEOUT_MS = 60 * 60 * 1000;

class QueryTimedOutError extends Error {}

type QueryJob = LogQueryJobState;
type QueryStatistics = LogQueryStatisticsState;

export interface LogAlarmQueryResult {
  values: Array<{ value: number; attributes: Record<string, string> }>;
  logLines: string[];
  partial: boolean;
}

function encodeName(value: string): string { return Buffer.from(value).toString("base64url"); }

function groupView(group: LogGroupState): any {
  return { logGroupName: group.logGroupName, creationTime: group.creationTime, metricFilterCount: Object.keys(group.metricFilters ?? {}).length, arn: `${group.arn}:*`, storedBytes: group.storedBytes, logGroupClass: group.logGroupClass ?? "STANDARD", ...(group.retentionInDays ? { retentionInDays: group.retentionInDays } : {}) };
}

function streamView(stream: LogStreamState): any {
  return { logStreamName: stream.logStreamName, creationTime: stream.creationTime, arn: stream.arn, storedBytes: stream.storedBytes, uploadSequenceToken: String(stream.sequence), ...(stream.firstEventTimestamp !== undefined ? { firstEventTimestamp: stream.firstEventTimestamp } : {}), ...(stream.lastEventTimestamp !== undefined ? { lastEventTimestamp: stream.lastEventTimestamp } : {}), ...(stream.lastIngestionTime !== undefined ? { lastIngestionTime: stream.lastIngestionTime } : {}) };
}

export class CloudWatchLogsService {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly querySchedules = new Map<string, Set<() => void>>();
  private readonly subscriptionLocks = new Set<string>();
  private readonly subscriptionSchedules = new Map<string, () => void>();
  private readonly exportSchedules = new Map<string, () => void>();
  private workerStarted = false;
  private metrics?: CloudWatchMetricsService;
  private lambda?: LambdaService;

  constructor(private readonly store: StateStore, private readonly region: string, private readonly clock: Clock, private readonly scheduler: Scheduler, private readonly allowLocalFiles = false) {}

  private get groups(): Record<string, LogGroupState> { return this.store.regionState(this.region).logs; }
  private get queryDefinitions(): Record<string, LogQueryDefinitionState> { return this.store.regionState(this.region).logQueryDefinitions; }
  private get queryJobs(): Record<string, QueryJob> { return this.store.regionState(this.region).logQueryJobs; }
  private get destinations(): Record<string, LogDestinationState> { return this.store.regionState(this.region).logDestinations; }
  private get resourcePolicies(): Record<string, LogResourcePolicyState> { return this.store.regionState(this.region).logResourcePolicies; }
  private get exportTasks(): Record<string, LogExportTaskState> { return this.store.regionState(this.region).logExportTasks; }
  private get tokens(): PaginationTokens { return new PaginationTokens(this.store.state.installation.paginationSecret); }
  private events(group: string, stream: string): SegmentedStore<LogEventState> { return new SegmentedStore(this.store.root, `logs/${this.store.accountId}/${this.region}/${encodeName(group)}/${encodeName(stream)}`, 1024 * 1024); }

  start(): void {
    if (this.workerStarted) return; this.workerStarted = true;
    const next = () => this.scheduler.schedule(async () => { await this.applyRetention(); next(); }, 60_000);
    next(); for (const group of Object.values(this.groups)) for (const filter of Object.values(group.subscriptionFilters ?? {})) for (const stream of Object.values(group.streams)) this.scheduleSubscription(group, filter, stream.logStreamName, 0);
    for (const task of Object.values(this.exportTasks)) if (task.status === "PENDING" || task.status === "RUNNING") { if (task.status === "RUNNING") task.status = "PENDING"; this.scheduleExport(task, 1); }
    let changed = false; for (const [id, job] of Object.entries(this.queryJobs)) { if (job.expiresAt <= this.clock.now()) { delete this.queryJobs[id]; changed = true; continue; } if (job.status === "Scheduled" || job.status === "Running") { job.status = "Scheduled"; delete job.startedAt; this.scheduleQuery(job, 1); changed = true; } } if (changed) void this.store.save();
  }

  setMetricService(metrics: CloudWatchMetricsService): void { this.metrics = metrics; }
  setLambdaService(lambda: LambdaService): void { this.lambda = lambda; }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const operation = String(req.headers["x-amz-target"] ?? "").split(".").pop(); const input = await readJson(req);
      if (!operation || typeof (this as any)[operation] !== "function") throw new AwsError("UnknownOperationException", `Unknown operation: ${operation}`);
      if (operation === "GetLogObject") {
        const data = await this.GetLogObject(input);
        res.statusCode = 200; res.setHeader("content-type", "application/vnd.amazon.eventstream"); res.setHeader("x-amzn-requestid", randomUUID()); res.flushHeaders();
        await writeWithBackpressure(res, eventStreamMessage("fields", Buffer.from(JSON.stringify({ data: data.toString("base64") })), "application/json")); res.end(); return;
      }
      json(res, await (this as any)[operation](input, (req as any).awsPrincipal), 200, "application/x-amz-json-1.1");
    } catch (error) { sendAwsError(res, error, "json", "com.amazonaws.cloudwatchlogs#"); }
  }

  private group(name: string): LogGroupState { const group = this.groups[name]; if (!group) throw new AwsError("ResourceNotFoundException", `The specified log group does not exist: ${name}`); return group; }
  private stream(group: LogGroupState, name: string): LogStreamState { const stream = group.streams[name]; if (!stream) throw new AwsError("ResourceNotFoundException", `The specified log stream does not exist: ${name}`); return stream; }

  private decode<T>(operation: string, token: string | undefined): T | undefined {
    if (!token) return undefined;
    try { const cursor = this.tokens.decode<any>(operation, token); if (cursor.expiresAt < this.clock.now()) throw new Error(); return cursor as T; }
    catch { throw new AwsError("InvalidParameterException", "The specified nextToken is invalid"); }
  }

  private encode(operation: string, cursor: object): string { return this.tokens.encode(operation, { ...cursor, expiresAt: this.clock.now() + 24 * 60 * 60 * 1000 }); }
  private encodeFor(operation: string, cursor: object, durationMs: number): string { return this.tokens.encode(operation, { ...cursor, expiresAt: this.clock.now() + durationMs }); }

  async CreateLogGroup(input: any): Promise<any> {
    const name = String(input.logGroupName ?? ""); if (!name || name.length > 512 || !/^[.\-_/#A-Za-z0-9]+$/.test(name) || name.startsWith("aws/")) throw new AwsError("InvalidParameterException", "Invalid log group name");
    const logGroupClass = String(input.logGroupClass ?? "STANDARD"); if (logGroupClass !== "STANDARD" && logGroupClass !== "INFREQUENT_ACCESS") throw new AwsError("InvalidParameterException", "Only STANDARD and INFREQUENT_ACCESS log group classes are supported");
    if (this.groups[name]) throw new AwsError("ResourceAlreadyExistsException", "The specified log group already exists");
    const arn = `arn:aws:logs:${this.region}:${this.store.accountId}:log-group:${name}`; this.groups[name] = { logGroupName: name, arn, creationTime: this.clock.now(), logGroupClass: logGroupClass as "STANDARD" | "INFREQUENT_ACCESS", storedBytes: 0, tags: { ...(input.tags ?? {}) }, streams: {}, metricFilters: {}, subscriptionFilters: {} }; await this.store.save(); return {};
  }

  async DeleteLogGroup(input: any): Promise<any> {
    const group = this.group(input.logGroupName); for (const stream of Object.keys(group.streams)) await this.events(group.logGroupName, stream).clear(); delete this.groups[group.logGroupName]; await this.store.save(); return {};
  }

  async DescribeLogGroups(input: any): Promise<any> {
    let groups = Object.values(this.groups).sort((a, b) => a.logGroupName.localeCompare(b.logGroupName));
    if (input.logGroupNamePrefix) groups = groups.filter(group => group.logGroupName.startsWith(input.logGroupNamePrefix));
    if (input.logGroupNamePattern) groups = groups.filter(group => group.logGroupName.includes(input.logGroupNamePattern));
    if (input.logGroupIdentifiers?.length) groups = groups.filter(group => input.logGroupIdentifiers.includes(group.logGroupName) || input.logGroupIdentifiers.includes(group.arn));
    const cursor = this.decode<{ index: number }>("DescribeLogGroups", input.nextToken); const start = cursor?.index ?? 0; const limit = Math.min(50, Math.max(1, input.limit ?? 50)); const page = groups.slice(start, start + limit); const next = start + page.length;
    return { logGroups: page.map(groupView), ...(next < groups.length ? { nextToken: this.encode("DescribeLogGroups", { index: next }) } : {}) };
  }

  async CreateLogStream(input: any): Promise<any> {
    const group = this.group(input.logGroupName); const name = String(input.logStreamName ?? ""); if (!name || name.length > 512 || name.includes(":" ) || name.includes("*")) throw new AwsError("InvalidParameterException", "Invalid log stream name");
    if (group.streams[name]) throw new AwsError("ResourceAlreadyExistsException", "The specified log stream already exists");
    group.streams[name] = { logStreamName: name, arn: `${group.arn}:log-stream:${name}`, creationTime: this.clock.now(), storedBytes: 0, sequence: 0 }; await this.store.save(); return {};
  }

  async DeleteLogStream(input: any): Promise<any> { const group = this.group(input.logGroupName); this.stream(group, input.logStreamName); delete group.streams[input.logStreamName]; await this.events(group.logGroupName, input.logStreamName).clear(); await this.store.save(); return {}; }

  async DescribeLogStreams(input: any): Promise<any> {
    const group = this.group(input.logGroupName); let streams = Object.values(group.streams);
    if (input.logStreamNamePrefix) streams = streams.filter(stream => stream.logStreamName.startsWith(input.logStreamNamePrefix));
    const order = input.orderBy ?? "LogStreamName"; streams.sort((a, b) => order === "LastEventTime" ? (a.lastEventTimestamp ?? 0) - (b.lastEventTimestamp ?? 0) || a.logStreamName.localeCompare(b.logStreamName) : a.logStreamName.localeCompare(b.logStreamName)); if (input.descending) streams.reverse();
    const cursor = this.decode<{ index: number; group: string }>("DescribeLogStreams", input.nextToken); if (cursor && cursor.group !== group.logGroupName) throw new AwsError("InvalidParameterException", "The specified nextToken is invalid"); const start = cursor?.index ?? 0; const limit = Math.min(50, Math.max(1, input.limit ?? 50)); const page = streams.slice(start, start + limit); const next = start + page.length;
    return { logStreams: page.map(streamView), ...(next < streams.length ? { nextToken: this.encode("DescribeLogStreams", { group: group.logGroupName, index: next }) } : {}) };
  }

  async PutLogEvents(input: any): Promise<any> {
    const group = this.group(input.logGroupName); const stream = this.stream(group, input.logStreamName); const events = input.logEvents ?? [];
    if (!Array.isArray(events) || events.length < 1 || events.length > 10_000) throw new AwsError("InvalidParameterException", "Log event batch must contain between 1 and 10000 events");
    let bytes = 0; let previous = -Infinity; for (const event of events) {
      if (!Number.isInteger(event.timestamp) || typeof event.message !== "string") throw new AwsError("InvalidParameterException", "Each log event needs an integer timestamp and string message");
      if (event.timestamp < previous) throw new AwsError("InvalidParameterException", "Log events in a single PutLogEvents request must be in chronological order"); previous = event.timestamp; bytes += Buffer.byteLength(event.message) + 26;
    }
    if (bytes > 1_048_576) throw new AwsError("InvalidParameterException", "The batch of log events in a single request cannot exceed 1,048,576 bytes");
    if (events.at(-1).timestamp - events[0].timestamp > 24 * 60 * 60 * 1000) throw new AwsError("InvalidParameterException", "A batch of log events cannot span more than 24 hours");
    if (events[0].timestamp < this.clock.now() - 14 * 86_400_000 || events.at(-1).timestamp > this.clock.now() + 2 * 60 * 60 * 1000) throw new AwsError("InvalidParameterException", "Log event timestamp is outside the accepted time range");
    const lockKey = `${group.logGroupName}\0${stream.logStreamName}`; const previousLock = this.locks.get(lockKey) ?? Promise.resolve(); let release!: () => void; const current = new Promise<void>(resolve => { release = resolve; }); const chain = previousLock.then(() => current); this.locks.set(lockKey, chain); await previousLock;
    try {
      const ingestionTime = this.clock.now(); const segment = this.events(group.logGroupName, stream.logStreamName);
      const storedEvents: LogEventState[] = []; const lineage = Array.isArray(input._stackSimDeliveryLineage) ? input._stackSimDeliveryLineage.map(String).slice(-32) : undefined;
      for (const event of events) { const order = stream.sequence++; const stored: LogEventState = { timestamp: event.timestamp, ingestionTime, message: event.message, order, eventId: createHash("sha256").update(`${group.logGroupName}\0${stream.logStreamName}\0${event.timestamp}\0${order}\0${event.message}`).digest("hex"), ...(lineage?.length ? { deliveryLineage: lineage } : {}) }; storedEvents.push(stored); await segment.append(stored); }
      stream.firstEventTimestamp = Math.min(stream.firstEventTimestamp ?? Infinity, events[0].timestamp); stream.lastEventTimestamp = Math.max(stream.lastEventTimestamp ?? -Infinity, events.at(-1).timestamp); stream.lastIngestionTime = ingestionTime; stream.storedBytes += bytes; group.storedBytes += bytes; await this.store.save();
      await this.publishMetricFilters(group, storedEvents); for (const filter of Object.values(group.subscriptionFilters ?? {})) this.scheduleSubscription(group, filter, stream.logStreamName, 0);
      return { nextSequenceToken: String(stream.sequence) };
    } finally { release(); if (this.locks.get(lockKey) === chain) this.locks.delete(lockKey); }
  }

  async deliverServiceEvents(
    input: { logGroupName: string; logStreamName: string; logEvents: Array<{ timestamp: number; message: string }> },
    authorize: (action: "logs:CreateLogGroup" | "logs:CreateLogStream" | "logs:PutLogEvents", resource: string) => boolean,
    options: { deliveryLineage?: string[] } = {},
  ): Promise<boolean> {
    const groupArn = `arn:aws:logs:${this.region}:${this.store.accountId}:log-group:${input.logGroupName}`;
    const streamArn = `${groupArn}:log-stream:${input.logStreamName}`;
    try {
      if (!this.groups[input.logGroupName]) {
        if (!authorize("logs:CreateLogGroup", `arn:aws:logs:${this.region}:${this.store.accountId}:*`)) return false;
        await this.CreateLogGroup({ logGroupName: input.logGroupName });
      }
      const group = this.groups[input.logGroupName];
      if (!group.streams[input.logStreamName]) {
        if (!authorize("logs:CreateLogStream", streamArn)) return false;
        await this.CreateLogStream({ logGroupName: input.logGroupName, logStreamName: input.logStreamName });
      }
      if (!authorize("logs:PutLogEvents", streamArn)) return false;
      await this.PutLogEvents({ ...input, ...(options.deliveryLineage?.length ? { _stackSimDeliveryLineage: options.deliveryLineage } : {}) });
      return true;
    } catch (error) {
      if (error instanceof AwsError && ["ResourceAlreadyExistsException", "ResourceNotFoundException"].includes(error.code)) return false;
      throw error;
    }
  }

  async deliverEventBridgeTarget(
    targetArn: string,
    input: { ruleArn: string; payload: string; eventTime: number; transformed: boolean; deliveryLineage?: string[] },
  ): Promise<void> {
    const match = /^arn:aws:logs:([^:]+):(\d{12}):log-group:(.+?)(?::\*)?$/.exec(targetArn);
    if (!match || match[1] !== this.region || match[2] !== this.store.accountId) throw new AwsError("ResourceNotFoundException", `CloudWatch Logs target ${targetArn} does not exist.`);
    const logGroupName = match[3];
    const group = this.groups[logGroupName];
    if (!group || group.arn !== targetArn.replace(/:\*$/, "")) throw new AwsError("ResourceNotFoundException", `CloudWatch Logs target ${targetArn} does not exist.`);
    let timestamp = input.eventTime;
    let message = input.payload;
    if (input.transformed) {
      let value: unknown;
      try { value = JSON.parse(input.payload); } catch { throw new AwsError("ValidationException", "A transformed CloudWatch Logs target payload must be a timestamp/message JSON object."); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("ValidationException", "A transformed CloudWatch Logs target payload must be a timestamp/message JSON object.");
      const record = value as Record<string, unknown>;
      if (Object.keys(record).some(key => key !== "timestamp" && key !== "message") || !Number.isInteger(record.timestamp) || typeof record.message !== "string") throw new AwsError("ValidationException", "A transformed CloudWatch Logs target payload must contain only an integer timestamp and string message.");
      timestamp = record.timestamp as number;
      message = record.message as string;
    }
    const streamName = `eventbridge/${createHash("sha256").update(input.ruleArn).digest("hex").slice(0, 32)}`;
    const streamArn = `${group.arn}:log-stream:${streamName}`;
    const context = { "aws:SourceArn": input.ruleArn, "aws:SourceAccount": this.store.accountId };
    const authorize = (action: "logs:CreateLogGroup" | "logs:CreateLogStream" | "logs:PutLogEvents", resource: string): boolean => {
      if (action === "logs:CreateLogGroup") return false;
      let allowed = false;
      for (const policy of Object.values(this.resourcePolicies)) {
        if (policy.policyScope === "RESOURCE" && policy.resourceArn !== group.arn && policy.resourceArn !== `${group.arn}:*`) continue;
        let document;
        try { document = JSON.parse(policy.policyDocument); } catch { continue; }
        const result = evaluateResourcePolicy(document, "events.amazonaws.com", action, resource, context);
        if (result.decision === "explicitDeny") return false;
        if (result.decision === "allowed") allowed = true;
      }
      return allowed;
    };
    if (!authorize("logs:CreateLogStream", streamArn) || !authorize("logs:PutLogEvents", streamArn)) throw new AwsError("AccessDeniedException", `EventBridge is not authorized to write to ${targetArn}.`, 403);
    const delivered = await this.deliverServiceEvents(
      { logGroupName, logStreamName: streamName, logEvents: [{ timestamp, message }] },
      authorize,
      { deliveryLineage: input.deliveryLineage },
    );
    if (!delivered) throw new AwsError("AccessDeniedException", `EventBridge is not authorized to write to ${targetArn}.`, 403);
  }

  private async orderedEvents(group: LogGroupState, stream: LogStreamState): Promise<LogEventState[]> {
    await this.purge(group, stream); return (await this.events(group.logGroupName, stream.logStreamName).readAll()).sort((a, b) => a.timestamp - b.timestamp || a.ingestionTime - b.ingestionTime || a.order - b.order);
  }

  async contributorEvents(selectors: string[], start: number, end: number): Promise<Array<LogEventState & { logGroupName: string; logStreamName: string }>> {
    const matches = (name: string): boolean => selectors.some(selector => selector.endsWith("*") ? name.startsWith(selector.slice(0, -1)) : name === selector);
    const output: Array<LogEventState & { logGroupName: string; logStreamName: string }> = [];
    for (const group of Object.values(this.groups).filter(candidate => matches(candidate.logGroupName))) for (const stream of Object.values(group.streams)) {
      for (const event of await this.orderedEvents(group, stream)) if (event.timestamp >= start && event.timestamp < end) output.push({ ...event, logGroupName: group.logGroupName, logStreamName: stream.logStreamName });
    }
    return output.sort((a, b) => a.timestamp - b.timestamp || a.ingestionTime - b.ingestionTime || a.logGroupName.localeCompare(b.logGroupName) || a.logStreamName.localeCompare(b.logStreamName) || a.order - b.order);
  }

  async GetLogEvents(input: any): Promise<any> {
    const group = this.group(input.logGroupName); const stream = this.stream(group, input.logStreamName); let events = await this.orderedEvents(group, stream);
    if (input.startTime !== undefined) events = events.filter(event => event.timestamp >= input.startTime); if (input.endTime !== undefined) events = events.filter(event => event.timestamp < input.endTime);
    const cursor = this.decode<{ group: string; stream: string; index: number }>("GetLogEvents", input.nextToken); if (cursor && (cursor.group !== group.logGroupName || cursor.stream !== stream.logStreamName)) throw new AwsError("InvalidParameterException", "The specified nextToken is invalid"); const limit = Math.min(10_000, Math.max(1, input.limit ?? 10_000)); const start = cursor?.index ?? (input.startFromHead ? 0 : Math.max(0, events.length - limit)); const page = events.slice(start, start + limit);
    return { events: page.map(({ timestamp, message, ingestionTime }) => ({ timestamp, message, ingestionTime })), nextForwardToken: this.encode("GetLogEvents", { group: group.logGroupName, stream: stream.logStreamName, index: Math.min(events.length, start + page.length) }), nextBackwardToken: this.encode("GetLogEvents", { group: group.logGroupName, stream: stream.logStreamName, index: Math.max(0, start - limit) }) };
  }

  private matches(message: string, pattern: string | undefined): boolean { try { return matchLogFilterPattern(message, pattern).matched; } catch (error) { if (error instanceof LogFilterSyntaxError) throw new AwsError("InvalidParameterException", error.message); throw error; } }

  async FilterLogEvents(input: any): Promise<any> {
    const group = this.group(input.logGroupName); let streams = Object.values(group.streams);
    if (input.logStreamNames?.length) streams = streams.filter(stream => input.logStreamNames.includes(stream.logStreamName)); if (input.logStreamNamePrefix) streams = streams.filter(stream => stream.logStreamName.startsWith(input.logStreamNamePrefix));
    let events: Array<LogEventState & { logStreamName: string }> = []; for (const stream of streams) events.push(...(await this.orderedEvents(group, stream)).map(event => ({ ...event, logStreamName: stream.logStreamName })));
    events = events.filter(event => (input.startTime === undefined || event.timestamp >= input.startTime) && (input.endTime === undefined || event.timestamp <= input.endTime) && this.matches(event.message, input.filterPattern)).sort((a, b) => a.timestamp - b.timestamp || a.ingestionTime - b.ingestionTime || a.order - b.order);
    const cursor = this.decode<{ group: string; index: number }>("FilterLogEvents", input.nextToken); if (cursor && cursor.group !== group.logGroupName) throw new AwsError("InvalidParameterException", "The specified nextToken is invalid"); const start = cursor?.index ?? 0; const limit = Math.min(10_000, Math.max(1, input.limit ?? 10_000)); const page = events.slice(start, start + limit); const next = start + page.length;
    return { events: page.map(({ timestamp, message, ingestionTime, eventId, logStreamName }) => ({ timestamp, message, ingestionTime, eventId, logStreamName })), searchedLogStreams: streams.map(stream => ({ logStreamName: stream.logStreamName, searchedCompletely: true })), ...(next < events.length ? { nextToken: this.encode("FilterLogEvents", { group: group.logGroupName, index: next }) } : {}) };
  }

  private filterName(value: unknown): string { const name = String(value ?? ""); if (!name || name.length > 512 || /[:*]/.test(name)) throw new AwsError("InvalidParameterException", "Filter name must contain between 1 and 512 characters and cannot contain ':' or '*'"); return name; }
  private filterPattern(value: unknown): string { try { return validateLogFilterPattern(value); } catch (error) { throw new AwsError("InvalidParameterException", error instanceof Error ? error.message : String(error)); } }
  private systemFields(value: unknown, label: string): string[] | undefined {
    if (value === undefined) return undefined; if (!Array.isArray(value) || value.some(item => !["@aws.account", "@aws.region"].includes(String(item))) || new Set(value.map(String)).size !== value.length) throw new AwsError("InvalidParameterException", `${label} can contain only unique @aws.account and @aws.region values`); return value.map(String);
  }
  private fieldSelectionCriteria(value: unknown): string | undefined {
    if (value === undefined) return undefined; const criteria = String(value); if (criteria.length > 2000) throw new AwsError("InvalidParameterException", "fieldSelectionCriteria cannot exceed 2000 characters");
    if (criteria && !criteria.split(/\s+(?:AND|OR)\s+/i).every(clause => /^@aws\.(?:account|region)\s*(?:=|!=|IN|NOT IN)\s*(?:"[^"]*"|\[[^\]]*])$/i.test(clause.trim()))) throw new AwsError("InvalidParameterException", "fieldSelectionCriteria uses an unsupported expression"); return criteria;
  }
  private selectedBySystemFields(criteria?: string): boolean {
    if (!criteria) return true; const values: Record<string, string> = { "@aws.account": this.store.accountId, "@aws.region": this.region }; let result: boolean | undefined; let connector = "AND";
    for (const token of criteria.split(/\s+(AND|OR)\s+/i)) { if (/^(?:AND|OR)$/i.test(token)) { connector = token.toUpperCase(); continue; } const match = token.trim().match(/^(@aws\.(?:account|region))\s*(=|!=|IN|NOT IN)\s*(.+)$/i)!; const candidates = match[3].startsWith("[") ? match[3].slice(1, -1).split(",").map(value => value.trim().replace(/^"|"$/g, "")) : [match[3].replace(/^"|"$/g, "")]; const contains = candidates.includes(values[match[1].toLowerCase()]); const clause = match[2].toUpperCase() === "=" || match[2].toUpperCase() === "IN" ? contains : !contains; result = result === undefined ? clause : connector === "AND" ? result && clause : result || clause; }
    return Boolean(result);
  }
  private validateMetricTransformation(value: unknown, systemDimensions: string[] = []): LogMetricTransformationState {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("InvalidParameterException", "metricTransformations must contain one transformation"); const input = value as any; const metricName = String(input.metricName ?? ""); const metricNamespace = String(input.metricNamespace ?? ""); const metricValue = String(input.metricValue ?? "");
    if (!metricName || metricName.length > 255 || /[:*$]/.test(metricName)) throw new AwsError("InvalidParameterException", "metricName is invalid"); if (!metricNamespace || metricNamespace.length > 255 || /[:*$]/.test(metricNamespace) || metricNamespace.startsWith("AWS/")) throw new AwsError("InvalidParameterException", "metricNamespace must be a valid custom namespace"); if (!metricValue || metricValue.length > 100 || (!metricValue.startsWith("$") && !Number.isFinite(Number(metricValue)))) throw new AwsError("InvalidParameterException", "metricValue must be a numeric literal or extracted field selector");
    const dimensions = input.dimensions === undefined ? undefined : input.dimensions; if (dimensions !== undefined && (!dimensions || typeof dimensions !== "object" || Array.isArray(dimensions) || Object.keys(dimensions).length + systemDimensions.length > 3 || Object.entries(dimensions).some(([key, item]) => !key || key.length > 255 || typeof item !== "string" || item.length > 255 || !item.startsWith("$")))) throw new AwsError("InvalidParameterException", "A metric transformation supports at most three valid extracted dimensions");
    const defaultValue = input.defaultValue === undefined ? undefined : Number(input.defaultValue); if (defaultValue !== undefined && !Number.isFinite(defaultValue)) throw new AwsError("InvalidParameterException", "defaultValue must be finite"); if (defaultValue !== undefined && dimensions && Object.keys(dimensions).length) throw new AwsError("InvalidParameterException", "defaultValue cannot be used with dimensions"); const unit = input.unit === undefined ? undefined : String(input.unit); if (unit !== undefined && !METRIC_UNITS.has(unit)) throw new AwsError("InvalidParameterException", "unit is invalid");
    return { metricName, metricNamespace, metricValue, ...(defaultValue !== undefined ? { defaultValue } : {}), ...(dimensions ? { dimensions: Object.fromEntries(Object.entries(dimensions).map(([key, item]) => [key, String(item)])) } : {}), ...(unit ? { unit } : {}) };
  }

  async PutMetricFilter(input: any): Promise<any> {
    const group = this.group(input.logGroupName); const filterName = this.filterName(input.filterName); const filterPattern = this.filterPattern(input.filterPattern); if (input.applyOnTransformedLogs) throw new AwsError("InvalidOperationException", "Transformed log filters are not available until transformer support is implemented"); const emitSystemFieldDimensions = this.systemFields(input.emitSystemFieldDimensions, "emitSystemFieldDimensions"); const fieldSelectionCriteria = this.fieldSelectionCriteria(input.fieldSelectionCriteria);
    if (!Array.isArray(input.metricTransformations) || input.metricTransformations.length !== 1) throw new AwsError("InvalidParameterException", "Exactly one metric transformation is required"); const metricTransformation = this.validateMetricTransformation(input.metricTransformations[0], emitSystemFieldDimensions);
    if (!group.metricFilters[filterName] && Object.keys(group.metricFilters).length >= 100) throw new AwsError("LimitExceededException", "A log group can have no more than 100 metric filters"); const otherRegexes = Object.values(group.metricFilters).filter(filter => filter.filterName !== filterName).reduce((sum, filter) => sum + regexCount(filter.filterPattern), 0); if (otherRegexes + regexCount(filterPattern) > 5) throw new AwsError("LimitExceededException", "A log group can contain no more than five regular expressions across its filters"); const previous = group.metricFilters[filterName]; group.metricFilters[filterName] = { filterName, filterPattern, logGroupName: group.logGroupName, metricTransformations: [metricTransformation], creationTime: previous?.creationTime ?? this.clock.now(), ...(emitSystemFieldDimensions?.length ? { emitSystemFieldDimensions } : {}), ...(fieldSelectionCriteria !== undefined ? { fieldSelectionCriteria } : {}) }; await this.store.save(); return {};
  }

  async DescribeMetricFilters(input: any): Promise<any> {
    let filters = Object.values(input.logGroupName ? this.group(input.logGroupName).metricFilters : this.groups).flatMap((value: any) => value.filterName ? [value] : Object.values(value.metricFilters ?? {})) as LogMetricFilterState[]; filters.sort((left, right) => left.filterName < right.filterName ? -1 : left.filterName > right.filterName ? 1 : 0); if (input.filterNamePrefix) { if (!input.logGroupName) throw new AwsError("InvalidParameterException", "filterNamePrefix requires logGroupName"); filters = filters.filter(filter => filter.filterName.startsWith(input.filterNamePrefix)); } if (input.metricName !== undefined || input.metricNamespace !== undefined) { if (input.metricName === undefined || input.metricNamespace === undefined) throw new AwsError("InvalidParameterException", "metricName and metricNamespace must be specified together"); filters = filters.filter(filter => filter.metricTransformations.some(transformation => transformation.metricName === input.metricName && transformation.metricNamespace === input.metricNamespace)); }
    const limit = Number(input.limit ?? 50); if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AwsError("InvalidParameterException", "limit must be between 1 and 50"); const cursor = this.decode<{ index: number }>("DescribeMetricFilters", input.nextToken); const start = cursor?.index ?? 0; const page = filters.slice(start, start + limit); const next = start + page.length; return { metricFilters: page.map(filter => structuredClone(filter)), ...(next < filters.length ? { nextToken: this.encode("DescribeMetricFilters", { index: next }) } : {}) };
  }

  async DeleteMetricFilter(input: any): Promise<any> { const group = this.group(input.logGroupName); const name = this.filterName(input.filterName); if (!group.metricFilters[name]) throw new AwsError("ResourceNotFoundException", "The specified metric filter does not exist"); delete group.metricFilters[name]; await this.store.save(); return {}; }

  async TestMetricFilter(input: any): Promise<any> { const filterPattern = this.filterPattern(input.filterPattern); if (!Array.isArray(input.logEventMessages) || input.logEventMessages.length < 1 || input.logEventMessages.length > 50 || input.logEventMessages.some((message: unknown) => typeof message !== "string" || !message.length)) throw new AwsError("InvalidParameterException", "logEventMessages must contain between 1 and 50 non-empty strings"); return { matches: input.logEventMessages.flatMap((eventMessage: string, eventNumber: number) => { const match = matchLogFilterPattern(eventMessage, filterPattern); return match.matched ? [{ eventNumber, eventMessage, extractedValues: match.extractedValues }] : []; }) }; }

  private async publishMetricFilters(group: LogGroupState, events: LogEventState[]): Promise<void> {
    if (!this.metrics || !events.length) return; const metricData: any[] = [];
    for (const filter of Object.values(group.metricFilters ?? {})) {
      if (!this.selectedBySystemFields(filter.fieldSelectionCriteria)) continue; const transformation = filter.metricTransformations[0]; let emitted = 0;
      for (const event of events) { const match = matchLogFilterPattern(event.message, filter.filterPattern); if (!match.matched) continue; const raw = resolveExtractedValue(transformation.metricValue, match.extractedValues, event.message); const value = Number(raw); if (!Number.isFinite(value)) continue; const Dimensions = Object.entries(transformation.dimensions ?? {}).flatMap(([Name, selector]) => { const Value = resolveExtractedValue(selector, match.extractedValues, event.message); return Value === undefined ? [] : [{ Name, Value }]; }); if (Dimensions.length !== Object.keys(transformation.dimensions ?? {}).length) continue; for (const field of filter.emitSystemFieldDimensions ?? []) Dimensions.push({ Name: field, Value: field === "@aws.account" ? this.store.accountId : this.region }); metricData.push({ MetricName: transformation.metricName, Value: value, Timestamp: new Date(event.timestamp), Unit: transformation.unit ?? "None", ...(Dimensions.length ? { Dimensions } : {}) }); emitted++;
      }
      if (!emitted && transformation.defaultValue !== undefined) metricData.push({ MetricName: transformation.metricName, Value: transformation.defaultValue, Timestamp: new Date(events.at(-1)!.ingestionTime), Unit: transformation.unit ?? "None" });
      for (let index = 0; index < metricData.length; index += 1000) await this.metrics.PutMetricData({ Namespace: transformation.metricNamespace, MetricData: metricData.slice(index, index + 1000) }).catch(() => undefined);
      metricData.length = 0;
    }
  }

  async PutSubscriptionFilter(input: any): Promise<any> {
    const group = this.group(input.logGroupName); const filterName = this.filterName(input.filterName); const filterPattern = this.filterPattern(input.filterPattern); if (input.applyOnTransformedLogs) throw new AwsError("InvalidOperationException", "Transformed log filters are not available until transformer support is implemented"); const emitSystemFields = this.systemFields(input.emitSystemFields, "emitSystemFields"); const fieldSelectionCriteria = this.fieldSelectionCriteria(input.fieldSelectionCriteria); const destinationArn = String(input.destinationArn ?? "");
    const lambda = destinationArn.match(/^arn:(?:aws|aws-us-gov|aws-cn):lambda:([^:]+):(\d{12}):function:([A-Za-z0-9-_]{1,64})(?::([A-Za-z0-9-_$]+))?$/); if (!lambda) { if (/^arn:[^:]+:(?:kinesis|firehose|logs):/.test(destinationArn)) throw new AwsError("InvalidParameterException", "This destination is dependency-blocked because Kinesis and Firehose delivery are not available locally"); throw new AwsError("InvalidParameterException", "destinationArn must identify a same-account, same-Region Lambda function"); } if (lambda[1] !== this.region || lambda[2] !== this.store.accountId) throw new AwsError("InvalidParameterException", "Lambda subscription destinations must use this simulator account and Region"); if (!this.lambda) throw new AwsError("ServiceUnavailableException", "Lambda delivery is not initialized", 500); if (input.roleArn) throw new AwsError("InvalidParameterException", "roleArn is not used for Lambda subscription destinations"); if (input.distribution !== undefined) throw new AwsError("InvalidParameterException", "distribution applies only to Kinesis subscription destinations"); this.lambda.assertResourcePermission(destinationArn, `logs.${this.region}.amazonaws.com`, `${group.arn}:*`, this.store.accountId);
    if (!group.subscriptionFilters[filterName] && Object.keys(group.subscriptionFilters).length >= 2) throw new AwsError("LimitExceededException", "A log group can have no more than two subscription filters"); const otherRegexes = [...Object.values(group.metricFilters), ...Object.values(group.subscriptionFilters)].filter(filter => filter.filterName !== filterName).reduce((sum, filter) => sum + regexCount(filter.filterPattern), 0); if (otherRegexes + regexCount(filterPattern) > 5) throw new AwsError("LimitExceededException", "A log group can contain no more than five regular expressions across its filters"); const previous = group.subscriptionFilters[filterName]; const checkpoints = previous?.checkpoints ?? Object.fromEntries(Object.values(group.streams).map(stream => [stream.logStreamName, stream.sequence])); group.subscriptionFilters[filterName] = { filterName, filterPattern, logGroupName: group.logGroupName, destinationArn, creationTime: previous?.creationTime ?? this.clock.now(), ...(emitSystemFields?.length ? { emitSystemFields } : {}), ...(fieldSelectionCriteria !== undefined ? { fieldSelectionCriteria } : {}), checkpoints, deliveryAttempts: previous?.deliveryAttempts ?? {} }; await this.store.save(); return {};
  }

  async DescribeSubscriptionFilters(input: any): Promise<any> { const group = this.group(input.logGroupName); let filters = Object.values(group.subscriptionFilters).sort((left, right) => left.filterName < right.filterName ? -1 : left.filterName > right.filterName ? 1 : 0); if (input.filterNamePrefix) filters = filters.filter(filter => filter.filterName.startsWith(input.filterNamePrefix)); const limit = Number(input.limit ?? 50); if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AwsError("InvalidParameterException", "limit must be between 1 and 50"); const cursor = this.decode<{ group: string; index: number }>("DescribeSubscriptionFilters", input.nextToken); if (cursor && cursor.group !== group.logGroupName) throw new AwsError("InvalidParameterException", "The specified nextToken is invalid"); const start = cursor?.index ?? 0; const page = filters.slice(start, start + limit); const next = start + page.length; return { subscriptionFilters: page.map(({ checkpoints: _checkpoints, deliveryAttempts: _deliveryAttempts, ...filter }) => structuredClone(filter)), ...(next < filters.length ? { nextToken: this.encode("DescribeSubscriptionFilters", { group: group.logGroupName, index: next }) } : {}) }; }

  async DeleteSubscriptionFilter(input: any): Promise<any> { const group = this.group(input.logGroupName); const name = this.filterName(input.filterName); if (!group.subscriptionFilters[name]) throw new AwsError("ResourceNotFoundException", "The specified subscription filter does not exist"); delete group.subscriptionFilters[name]; for (const [key, cancel] of this.subscriptionSchedules) if (key.startsWith(`${group.logGroupName}\0${name}\0`)) { cancel(); this.subscriptionSchedules.delete(key); } await this.store.save(); return {}; }

  private scheduleSubscription(group: LogGroupState, filter: LogSubscriptionFilterState, streamName: string, delayMs: number): void { const key = `${group.logGroupName}\0${filter.filterName}\0${streamName}`; if (this.subscriptionSchedules.has(key) || this.subscriptionLocks.has(key)) return; const cancel = this.scheduler.schedule(() => { this.subscriptionSchedules.delete(key); return this.processSubscription(group.logGroupName, filter.filterName, streamName); }, delayMs); this.subscriptionSchedules.set(key, cancel); }
  private recursiveDestination(destinationArn: string, lineage?: string[]): boolean { if (!lineage?.length) return false; const base = destinationArn.replace(/:[^:]+$/, match => destinationArn.split(":").length > 7 ? "" : match); const functionBase = destinationArn.match(/^(arn:[^:]+:lambda:[^:]+:\d{12}:function:[^:]+)/)?.[1] ?? base; return lineage.some(item => item === destinationArn || item === functionBase || item.startsWith(`${functionBase}:`)); }
  private async processSubscription(groupName: string, filterName: string, streamName: string): Promise<void> {
    const key = `${groupName}\0${filterName}\0${streamName}`; if (this.subscriptionLocks.has(key)) return; this.subscriptionLocks.add(key);
    try {
      const group = this.groups[groupName]; const filter = group?.subscriptionFilters?.[filterName]; const stream = group?.streams?.[streamName]; if (!group || !filter || !stream || !this.lambda) return; const checkpoint = filter.checkpoints[streamName] ?? stream.sequence; const pending = (await this.orderedEvents(group, stream)).filter(event => event.order >= checkpoint); if (!pending.length) return; const through = pending.at(-1)!.order + 1;
      const matching = this.selectedBySystemFields(filter.fieldSelectionCriteria) ? pending.filter(event => !this.recursiveDestination(filter.destinationArn, event.deliveryLineage) && matchLogFilterPattern(event.message, filter.filterPattern).matched) : [];
      if (matching.length) { const payload = { owner: this.store.accountId, logGroup: group.logGroupName, logStream: stream.logStreamName, subscriptionFilters: [filter.filterName], messageType: "DATA_MESSAGE", logEvents: matching.map(event => ({ id: event.eventId, timestamp: event.timestamp, message: event.message, ...Object.fromEntries((filter.emitSystemFields ?? []).map(field => [field, field === "@aws.account" ? this.store.accountId : this.region])) })) }; const encoded = gzipSync(Buffer.from(JSON.stringify(payload))).toString("base64"); const lineage = [...new Set(matching.flatMap(event => event.deliveryLineage ?? []))].slice(-31); await this.lambda.enqueueServiceInvocation(filter.destinationArn, Buffer.from(JSON.stringify({ awslogs: { data: encoded } })), `logs.${this.region}.amazonaws.com`, `${group.arn}:*`, this.store.accountId, lineage); }
      filter.checkpoints[streamName] = through; delete filter.deliveryAttempts[streamName]; await this.store.save(); if (through < stream.sequence) this.scheduleSubscription(group, filter, streamName, 0);
    } catch {
      const group = this.groups[groupName]; const filter = group?.subscriptionFilters?.[filterName]; if (group && filter) { const attempts = (filter.deliveryAttempts[streamName] ?? 0) + 1; filter.deliveryAttempts[streamName] = attempts; await this.store.save().catch(() => undefined); this.scheduleSubscription(group, filter, streamName, Math.min(300_000, 1000 * 2 ** Math.min(8, attempts - 1))); }
    } finally { this.subscriptionLocks.delete(key); }
  }

  private destinationView(destination: LogDestinationState): any { const { tags: _tags, ...view } = destination; return structuredClone(view); }
  async PutDestination(input: any): Promise<any> { const destinationName = this.filterName(input.destinationName); const targetArn = String(input.targetArn ?? ""); const roleArn = String(input.roleArn ?? ""); if (!/^arn:[^:]+:kinesis:[^:]+:\d{12}:stream\/.+/.test(targetArn)) throw new AwsError("InvalidParameterException", "Only Kinesis logical destination descriptors are valid; delivery remains dependency-blocked locally"); if (!/^arn:[^:]+:iam::\d{12}:role\/.+/.test(roleArn)) throw new AwsError("InvalidParameterException", "roleArn must identify an IAM role"); const previous = this.destinations[destinationName]; const destination: LogDestinationState = { destinationName, targetArn, roleArn, arn: `arn:aws:logs:${this.region}:${this.store.accountId}:destination:${destinationName}`, creationTime: previous?.creationTime ?? this.clock.now(), ...(previous?.accessPolicy ? { accessPolicy: previous.accessPolicy } : {}), tags: previous?.tags ?? { ...(input.tags ?? {}) } }; this.destinations[destinationName] = destination; await this.store.save(); return { destination: this.destinationView(destination) }; }
  async PutDestinationPolicy(input: any): Promise<any> { const destination = this.destinations[this.filterName(input.destinationName)]; if (!destination) throw new AwsError("ResourceNotFoundException", "The specified destination does not exist"); const accessPolicy = String(input.accessPolicy ?? ""); if (!accessPolicy || Buffer.byteLength(accessPolicy) > 5120) throw new AwsError("InvalidParameterException", "accessPolicy must contain between 1 and 5120 bytes"); try { JSON.parse(accessPolicy); } catch { throw new AwsError("InvalidParameterException", "accessPolicy must be valid JSON"); } destination.accessPolicy = accessPolicy; await this.store.save(); return {}; }
  async clearDestinationPolicyForCloudFormation(destinationName: string): Promise<void> { const destination = this.destinations[this.filterName(destinationName)]; if (!destination) throw new AwsError("ResourceNotFoundException", "The specified destination does not exist"); if (destination.accessPolicy === undefined) return; delete destination.accessPolicy; await this.store.save(); }
  async DescribeDestinations(input: any): Promise<any> { let destinations = Object.values(this.destinations).sort((left, right) => left.destinationName < right.destinationName ? -1 : left.destinationName > right.destinationName ? 1 : 0); const prefix = input.DestinationNamePrefix ?? input.destinationNamePrefix; if (prefix) destinations = destinations.filter(destination => destination.destinationName.startsWith(prefix)); const limit = Number(input.limit ?? 50); if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AwsError("InvalidParameterException", "limit must be between 1 and 50"); const cursor = this.decode<{ index: number }>("DescribeDestinations", input.nextToken); const start = cursor?.index ?? 0; const page = destinations.slice(start, start + limit); const next = start + page.length; return { destinations: page.map(destination => this.destinationView(destination)), ...(next < destinations.length ? { nextToken: this.encode("DescribeDestinations", { index: next }) } : {}) }; }
  async DeleteDestination(input: any): Promise<any> { const name = this.filterName(input.destinationName); if (!this.destinations[name]) throw new AwsError("ResourceNotFoundException", "The specified destination does not exist"); delete this.destinations[name]; await this.store.save(); return {}; }

  private resourcePolicyView(policy: LogResourcePolicyState): any { return structuredClone(policy); }
  async PutResourcePolicy(input: any): Promise<any> { const policyName = String(input.policyName ?? ""); const policyDocument = String(input.policyDocument ?? ""); if (!policyName || policyName.length > 512 || !policyDocument || Buffer.byteLength(policyDocument) > 51_200) throw new AwsError("InvalidParameterException", "policyName and a policyDocument of at most 51200 bytes are required"); try { const parsed = JSON.parse(policyDocument); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); } catch { throw new AwsError("InvalidParameterException", "policyDocument must be a valid JSON policy object"); } const resourceArn = input.resourceArn === undefined ? undefined : String(input.resourceArn); if (resourceArn && !Object.values(this.groups).some(group => group.arn === resourceArn || `${group.arn}:*` === resourceArn)) throw new AwsError("ResourceNotFoundException", "The specified log group does not exist"); const key = resourceArn ? `resource:${resourceArn}` : `account:${policyName}`; const existing = this.resourcePolicies[key]; if (resourceArn && existing && input.expectedRevisionId !== existing.revisionId) throw new AwsError("OperationAbortedException", "The expected revision ID does not match"); if (!resourceArn && !existing && Object.values(this.resourcePolicies).filter(policy => policy.policyScope === "ACCOUNT").length >= 10) throw new AwsError("LimitExceededException", "An account can have no more than 10 account-scoped Logs resource policies"); const revisionId = resourceArn ? randomUUID() : undefined; const policy: LogResourcePolicyState = { policyName, policyDocument, policyScope: resourceArn ? "RESOURCE" : "ACCOUNT", lastUpdatedTime: this.clock.now(), ...(resourceArn ? { resourceArn, revisionId } : {}) }; this.resourcePolicies[key] = policy; await this.store.save(); return { resourcePolicy: this.resourcePolicyView(policy), ...(revisionId ? { revisionId } : {}) }; }
  async DescribeResourcePolicies(input: any): Promise<any> { const scope = String(input.policyScope ?? "ACCOUNT"); if (!['ACCOUNT', 'RESOURCE'].includes(scope)) throw new AwsError("InvalidParameterException", "policyScope must be ACCOUNT or RESOURCE"); let policies = Object.values(this.resourcePolicies).filter(policy => policy.policyScope === scope); if (input.resourceArn) policies = policies.filter(policy => policy.resourceArn === input.resourceArn); policies.sort((left, right) => left.policyName.localeCompare(right.policyName)); const limit = Number(input.limit ?? 50); if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AwsError("InvalidParameterException", "limit must be between 1 and 50"); const cursor = this.decode<{ index: number }>("DescribeResourcePolicies", input.nextToken); const start = cursor?.index ?? 0; const page = policies.slice(start, start + limit); const next = start + page.length; return { resourcePolicies: page.map(policy => this.resourcePolicyView(policy)), ...(next < policies.length ? { nextToken: this.encode("DescribeResourcePolicies", { index: next }) } : {}) }; }
  async DeleteResourcePolicy(input: any): Promise<any> { let entry: [string, LogResourcePolicyState] | undefined; if (input.resourceArn) entry = Object.entries(this.resourcePolicies).find(([, policy]) => policy.resourceArn === input.resourceArn); else if (input.policyName) entry = Object.entries(this.resourcePolicies).find(([, policy]) => policy.policyScope === "ACCOUNT" && policy.policyName === input.policyName); else throw new AwsError("InvalidParameterException", "policyName or resourceArn is required"); if (!entry) throw new AwsError("ResourceNotFoundException", "The specified resource policy does not exist"); if (entry[1].policyScope === "RESOURCE" && input.expectedRevisionId !== entry[1].revisionId) throw new AwsError("OperationAbortedException", "The expected revision ID does not match"); delete this.resourcePolicies[entry[0]]; await this.store.save(); return {}; }

  private localExportPath(destination: unknown, prefix: unknown): { base: string; path: string; prefix: string } { if (!this.allowLocalFiles) throw new AwsError("InvalidParameterException", "S3 is not available in this simulator. Set STACKSIM_ALLOW_LOCAL_FILES=true and use a file:// destination for the local export extension"); const value = String(destination ?? ""); if (!value.startsWith("file://")) throw new AwsError("InvalidParameterException", "S3 is dependency-blocked locally; destination must be a file:// URL when STACKSIM_ALLOW_LOCAL_FILES=true"); let base: string; try { base = resolve(fileURLToPath(value)); } catch { throw new AwsError("InvalidParameterException", "destination must be a valid file:// URL"); } const normalizedPrefix = String(prefix ?? "exportedlogs"); if (!normalizedPrefix || Buffer.byteLength(normalizedPrefix) > 1024 || normalizedPrefix.startsWith("/") || normalizedPrefix.split(/[\\/]/).includes("..")) throw new AwsError("InvalidParameterException", "destinationPrefix must be a safe relative path"); const path = resolve(base, normalizedPrefix); if (path !== base && !path.startsWith(`${base}${sep}`)) throw new AwsError("InvalidParameterException", "destinationPrefix escapes the destination"); return { base, path, prefix: normalizedPrefix }; }
  async CreateExportTask(input: any): Promise<any> { const group = this.group(input.logGroupName); const from = Number(input.from); const to = Number(input.to); if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to < group.creationTime) throw new AwsError("InvalidParameterException", "from and to must be a valid millisecond range ending after log group creation"); const destination = String(input.destination ?? ""); const target = this.localExportPath(destination, input.destinationPrefix); const taskName = input.taskName === undefined ? undefined : String(input.taskName); if (taskName !== undefined && (!taskName || taskName.length > 512)) throw new AwsError("InvalidParameterException", "taskName must contain between 1 and 512 characters"); if (taskName && Object.values(this.exportTasks).some(task => task.taskName === taskName)) throw new AwsError("ResourceAlreadyExistsException", "An export task with this name already exists"); if (Object.values(this.exportTasks).some(task => task.status === "PENDING" || task.status === "RUNNING")) throw new AwsError("LimitExceededException", "Only one export task can be active at a time"); const logStreamNamePrefix = input.logStreamNamePrefix === undefined ? undefined : String(input.logStreamNamePrefix); if (logStreamNamePrefix !== undefined && (!logStreamNamePrefix || logStreamNamePrefix.length > 512 || /[:*]/.test(logStreamNamePrefix))) throw new AwsError("InvalidParameterException", "logStreamNamePrefix is invalid"); const taskId = randomUUID(); const task: LogExportTaskState = { taskId, ...(taskName ? { taskName } : {}), logGroupName: group.logGroupName, ...(logStreamNamePrefix ? { logStreamNamePrefix } : {}), from, to, destination, destinationPrefix: target.prefix, status: "PENDING", statusMessage: "Pending local file export", creationTime: this.clock.now() }; this.exportTasks[taskId] = task; await this.store.save(); this.scheduleExport(task, 25); return { taskId }; }
  private scheduleExport(task: LogExportTaskState, delayMs: number): void { if (this.exportSchedules.has(task.taskId)) return; this.exportSchedules.set(task.taskId, this.scheduler.schedule(() => { this.exportSchedules.delete(task.taskId); return this.runExport(task.taskId); }, delayMs)); }
  private async runExport(taskId: string): Promise<void> { const task = this.exportTasks[taskId]; if (!task || task.status !== "PENDING") return; try { task.status = "RUNNING"; task.statusMessage = "Writing local gzip files"; await this.store.save(); const target = this.localExportPath(task.destination, task.destinationPrefix); await mkdir(target.path, { recursive: true }); const group = this.group(task.logGroupName); const files: string[] = []; for (const stream of Object.values(group.streams).filter(stream => !task.logStreamNamePrefix || stream.logStreamName.startsWith(task.logStreamNamePrefix))) { const events = (await this.orderedEvents(group, stream)).filter(event => event.timestamp >= task.from && event.timestamp <= task.to); if (!events.length) continue; const directory = resolve(target.path, encodeName(group.logGroupName), encodeName(stream.logStreamName)); await mkdir(directory, { recursive: true }); const file = resolve(directory, `${task.taskId}.log.gz`); await writeFile(file, gzipSync(Buffer.from(events.map(event => `${event.timestamp} ${event.message}\n`).join(""))), { mode: 0o600 }); files.push(file); } task.outputFiles = files; task.status = "COMPLETED"; task.statusMessage = `Completed local file export with ${files.length} object${files.length === 1 ? "" : "s"}`; task.completionTime = this.clock.now(); await this.store.save(); } catch (error) { task.status = "FAILED"; task.statusMessage = error instanceof Error ? error.message : String(error); task.completionTime = this.clock.now(); await this.store.save().catch(() => undefined); } }
  private exportTaskView(task: LogExportTaskState): any { return { taskId: task.taskId, ...(task.taskName ? { taskName: task.taskName } : {}), logGroupName: task.logGroupName, from: task.from, to: task.to, destination: task.destination, destinationPrefix: task.destinationPrefix, status: { code: task.status, message: task.statusMessage }, executionInfo: { creationTime: task.creationTime, ...(task.completionTime !== undefined ? { completionTime: task.completionTime } : {}) } }; }
  async DescribeExportTasks(input: any): Promise<any> { let tasks = Object.values(this.exportTasks).sort((left, right) => right.creationTime - left.creationTime || left.taskId.localeCompare(right.taskId)); if (input.taskId) tasks = tasks.filter(task => task.taskId === input.taskId); if (input.statusCode) { if (!EXPORT_STATUSES.has(input.statusCode)) throw new AwsError("InvalidParameterException", "statusCode is invalid"); tasks = tasks.filter(task => task.status === input.statusCode); } const limit = Number(input.limit ?? 50); if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AwsError("InvalidParameterException", "limit must be between 1 and 50"); const cursor = this.decode<{ index: number }>("DescribeExportTasks", input.nextToken); const start = cursor?.index ?? 0; const page = tasks.slice(start, start + limit); const next = start + page.length; return { exportTasks: page.map(task => this.exportTaskView(task)), ...(next < tasks.length ? { nextToken: this.encode("DescribeExportTasks", { index: next }) } : {}) }; }
  async CancelExportTask(input: any): Promise<any> { const task = this.exportTasks[String(input.taskId ?? "")]; if (!task) throw new AwsError("ResourceNotFoundException", "The specified export task does not exist"); if (task.status !== "PENDING" && task.status !== "RUNNING") throw new AwsError("InvalidOperationException", "Only PENDING or RUNNING export tasks can be cancelled"); this.exportSchedules.get(task.taskId)?.(); this.exportSchedules.delete(task.taskId); task.status = "CANCELLED"; task.statusMessage = "Cancelled by user"; task.completionTime = this.clock.now(); await this.store.save(); return {}; }

  async PutRetentionPolicy(input: any): Promise<any> { const group = this.group(input.logGroupName); if (!RETENTION_DAYS.has(input.retentionInDays)) throw new AwsError("InvalidParameterException", "Invalid retention value"); group.retentionInDays = input.retentionInDays; await this.applyRetention(); await this.store.save(); return {}; }
  async DeleteRetentionPolicy(input: any): Promise<any> { const group = this.group(input.logGroupName); delete group.retentionInDays; await this.store.save(); return {}; }

  private resource(arn: string): LogGroupState | LogDestinationState {
    const group = Object.values(this.groups).find(value => value.arn === arn || `${value.arn}:*` === arn);
    if (group) return group;
    const destination = Object.values(this.destinations).find(value => value.arn === arn);
    if (destination) return destination;
    throw new AwsError("ResourceNotFoundException", "The specified resource does not exist");
  }
  async TagResource(input: any): Promise<any> { Object.assign(this.resource(input.resourceArn).tags, input.tags ?? {}); await this.store.save(); return {}; }
  async UntagResource(input: any): Promise<any> { const group = this.resource(input.resourceArn); for (const key of input.tagKeys ?? []) delete group.tags[key]; await this.store.save(); return {}; }
  async ListTagsForResource(input: any): Promise<any> { return { tags: { ...this.resource(input.resourceArn).tags } }; }
  async TagLogGroup(input: any): Promise<any> { const group = this.group(input.logGroupName); Object.assign(group.tags, input.tags ?? {}); await this.store.save(); return {}; }
  async UntagLogGroup(input: any): Promise<any> { const group = this.group(input.logGroupName); for (const key of input.tags ?? []) delete group.tags[key]; await this.store.save(); return {}; }
  async ListTagsLogGroup(input: any): Promise<any> { return { tags: { ...this.group(input.logGroupName).tags } }; }

  private malformed(error: InsightsSyntaxError | string, start = 0, end = start + 1): AwsError {
    const message = typeof error === "string" ? error : error.message; const location = typeof error === "string" ? { startCharOffset: start, endCharOffset: end } : { startCharOffset: error.start, endCharOffset: error.end };
    return new AwsError("MalformedQueryException", message, 400, { queryCompileError: { message, location } });
  }

  private queryLanguage(value: unknown, allowUnsupported = false): "CWLI" | "SQL" | "PPL" {
    const language = String(value ?? "CWLI").toUpperCase();
    if (!QUERY_LANGUAGES.has(language)) throw new AwsError("InvalidParameterException", `Unsupported query language: ${language}`);
    if (!allowUnsupported && language !== "CWLI") throw this.malformed(`${language} queries are recognized but are not implemented by stacksim`, 0, 1);
    return language as "CWLI" | "SQL" | "PPL";
  }

  private resolveQueryGroups(input: any): string[] {
    const selectors = [input.logGroupName !== undefined, input.logGroupNames !== undefined, input.logGroupIdentifiers !== undefined].filter(Boolean).length;
    if (selectors !== 1) throw new AwsError("InvalidParameterException", "Exactly one of logGroupName, logGroupNames, or logGroupIdentifiers must be specified");
    const requested = input.logGroupName !== undefined ? [input.logGroupName] : input.logGroupNames ?? input.logGroupIdentifiers;
    if (!Array.isArray(requested) || requested.length < 1 || requested.length > 50) throw new AwsError("InvalidParameterException", "Queries require between 1 and 50 log groups");
    const names = requested.map((identifier: unknown) => {
      const value = String(identifier); if (value.length < 1 || value.length > 2048 || value.endsWith(":*")) throw new AwsError("InvalidParameterException", "Log group identifiers must be names or ARNs without a trailing wildcard"); const group = this.groups[value] ?? Object.values(this.groups).find(candidate => candidate.arn === value);
      if (!group) throw new AwsError("ResourceNotFoundException", `The specified log group does not exist: ${value}`); return group.logGroupName;
    });
    return [...new Set(names)];
  }

  private discoveredFields(message: string, logGroupName = ""): ReturnType<typeof discoverLogFields> { return discoverLogFields(message, logGroupName); }

  private pointer(group: string, stream: string, eventId: string): string { return this.encodeFor("LogRecordPointer", { group, stream, eventId }, 7 * 24 * 60 * 60 * 1000); }

  private decodeRecordPointer(pointer: string): { group: string; stream: string; eventId: string } {
    try { return this.tokens.decode<{ group: string; stream: string; eventId: string; expiresAt: number }>("LogRecordPointer", pointer); }
    catch {
      // Accept pointers created by schema 69 during their normal seven-day lifetime.
      try { return this.tokens.decode<{ group: string; stream: string; eventId: string; expiresAt: number }>("GetLogRecord", pointer); }
      catch { throw new AwsError("InvalidParameterException", "The log record pointer is invalid"); }
    }
  }

  private async eventForPointer(pointer: string): Promise<{ group: LogGroupState; stream: LogStreamState; event: LogEventState }> {
    if (!pointer || pointer.length > 512) throw new AwsError("InvalidParameterException", "A valid log object pointer is required");
    const cursor = this.decodeRecordPointer(pointer); if ((cursor as any).expiresAt < this.clock.now()) throw new AwsError("InvalidParameterException", "The log record pointer has expired");
    const group = this.group(cursor.group); const stream = this.stream(group, cursor.stream); const event = (await this.orderedEvents(group, stream)).find(candidate => candidate.eventId === cursor.eventId);
    if (!event) throw new AwsError("ResourceNotFoundException", "The specified log record is no longer available"); return { group, stream, event };
  }

  private queryControl(job: QueryJob): { cancelled: () => boolean; deadline: () => boolean } {
    return {
      cancelled: () => job.status !== undefined && job.status !== "Running" && job.status !== "Scheduled",
      deadline: () => job.startedAt !== undefined && this.clock.now() - job.startedAt >= QUERY_TIMEOUT_MS,
    };
  }

  private async executeInsightsJob(job: QueryJob, queryString: string, limit: number): Promise<{ result: ReturnType<typeof finalizeInsightsExecution>["result"]; scanned: number; scannedBytes: number }> {
    const plan = parseInsightsQuery(queryString);
    const execution = classifyInsightsExecution(plan, limit);
    const context = { queryStartTime: job.startTime * 1000, queryEndTime: job.endTime * 1000, now: this.clock.now() };
    const control = this.queryControl(job);
    const start = job.startTime * 1000;
    const end = job.endTime * 1000 + 999;
    const state = {
      records: [] as InsightsRecord[],
      buckets: new Map(),
      matched: 0,
      ordinal: 0,
      statsStage: undefined as Parameters<typeof ingestInsightsRecord>[4]["statsStage"],
    };
    if (execution.mode === "stream-stats") state.statsStage = plan.stages[execution.statsIndex!] as typeof state.statsStage;
    let scanned = 0, scannedBytes = 0;
    const saveProgress = async () => {
      job.statistics = { recordsMatched: state.matched, recordsScanned: scanned, estimatedRecordsSkipped: 0, bytesScanned: scannedBytes, estimatedBytesSkipped: 0, logGroupsScanned: job.logGroupNames.length };
      await this.store.save();
    };
    try {
      groups: for (const groupName of job.logGroupNames) {
        const group = this.group(groupName);
        for (const stream of Object.values(group.streams)) for await (const event of this.events(group.logGroupName, stream.logStreamName).iterate()) {
          if (control.cancelled()) throw new QueryCancelledError();
          if (control.deadline()) throw new QueryTimedOutError("The query exceeded the 60-minute execution deadline");
          if (event.timestamp < start || event.timestamp > end) continue;
          scanned++; scannedBytes += Buffer.byteLength(event.message);
          const record = { fields: { ...(group.logGroupClass === "INFREQUENT_ACCESS" ? {} : this.discoveredFields(event.message, group.logGroupName)), "@timestamp": event.timestamp, "@ingestionTime": event.ingestionTime, "@message": event.message, "@logStream": stream.logStreamName, "@log": `${this.store.accountId}:${group.logGroupName}` }, pointer: this.pointer(group.logGroupName, stream.logStreamName, event.eventId), bytes: Buffer.byteLength(event.message) } satisfies InsightsRecord;
          const accepted = ingestInsightsRecord(record, execution, plan, context, state);
          if (execution.mode === "early-limit-any" && accepted && state.records.length >= (execution.earlyLimit ?? 0)) break groups;
          if (scanned % 1000 === 0) {
            await saveProgress();
            await new Promise<void>(resolve => setImmediate(resolve));
            if (control.cancelled()) throw new QueryCancelledError();
          }
        }
      }
      const executed = finalizeInsightsExecution(execution, plan, limit, context, state, control);
      return { result: executed.result, scanned, scannedBytes };
    } catch (error) {
      await saveProgress();
      throw error;
    }
  }

  async runLogAlarmQuery(configuration: any, start: number, end: number, lineCount = 0): Promise<LogAlarmQueryResult> {
    this.validateLogAlarmQuery(configuration); const queryString = String(configuration.queryString ?? configuration.QueryString); const identifiers = configuration.logGroupIdentifiers ?? configuration.LogGroupIdentifiers; const groups = this.resolveQueryGroups({ logGroupIdentifiers: identifiers }); const aggregation = this.alarmAggregation(configuration.aggregationExpression ?? configuration.AggregationExpression);
    const job = { logGroupNames: groups, startTime: Math.floor(start / 1000), endTime: Math.floor((Math.max(start, end - 1)) / 1000), status: "Running" as const, startedAt: this.clock.now() } as QueryJob;
    const aggregateQuery = `${queryString} | ${aggregation.query}`;
    const executed = await this.executeInsightsJob(job, aggregateQuery, 501);
    const values = executed.result.rows.slice(0, 500).map(row => { const fields = Object.fromEntries(row.map(item => [item.field, item.value])); const value = Number(fields[aggregation.valueField]); if (!Number.isFinite(value)) throw new AwsError("InvalidParameterValue", "AggregationExpression did not produce a finite scalar value"); const attributes: Record<string, string> = {}; for (const [field, item] of Object.entries(fields)) if (field !== aggregation.valueField && field !== "@ptr") attributes[field] = item; return { value, attributes }; });
    let logLines: string[] = [];
    if (lineCount > 0) {
      const linesExecuted = await this.executeInsightsJob(job, `${queryString} | fields @timestamp, @message | sort @timestamp desc | limit ${Math.min(50, lineCount)}`, Math.min(50, lineCount));
      logLines = linesExecuted.result.rows.map(row => row.find(item => item.field === "@message")?.value).filter((value): value is string => value !== undefined);
    }
    return { values, logLines, partial: executed.result.rows.length > 500 };
  }

  private alarmAggregation(expression: unknown): { query: string; valueField: string } {
    const source = String(expression ?? "").trim(); if (!source || source.length > 2048) throw new AwsError("InvalidParameterValue", "AggregationExpression must contain between 1 and 2048 characters");
    const stages = source.split("|").map(stage => stage.trim()); const aggregate = stages.shift()!;
    const match = aggregate.match(/^(count|sum|avg|min|max)\s*\(\s*([A-Za-z_@][A-Za-z0-9_@.$-]*|\*)?\s*\)(?:\s+as\s+([A-Za-z_@][A-Za-z0-9_@.$-]*))?(?:\s+by\s+([A-Za-z_@][A-Za-z0-9_@.$-]*(?:\s*,\s*[A-Za-z_@][A-Za-z0-9_@.$-]*)*))?$/i);
    if (!match || (match[1].toLowerCase() !== "count" && (!match[2] || match[2] === "*"))) throw new AwsError("InvalidParameterValue", "AggregationExpression must contain one supported aggregate with optional contributor fields");
    const valueField = match[3] ?? `${match[1].toLowerCase()}(${match[2] || "*"})`; const normalized = [`stats ${aggregate}`];
    for (const stage of stages) {
      const sort = stage.match(/^sort(?:\s+([A-Za-z_@][A-Za-z0-9_@.$-]*))?\s+(asc|desc)$/i); const limit = stage.match(/^limit\s+(\d+)$/i);
      if (sort) normalized.push(`sort ${sort[1] ?? valueField} ${sort[2]}`);
      else if (limit && Number(limit[1]) >= 1 && Number(limit[1]) <= 500) normalized.push(`limit ${limit[1]}`);
      else throw new AwsError("InvalidParameterValue", "AggregationExpression supports only aggregate, sort, and limit stages");
    }
    return { query: normalized.join(" | "), valueField };
  }

  validateLogAlarmQuery(configuration: any): void {
    const queryString = String(configuration?.queryString ?? configuration?.QueryString ?? ""); if (!queryString || queryString.length > 10_000 || /(?:^|\|)\s*stats\b/i.test(queryString)) throw new AwsError("InvalidParameterValue", "Scheduled log alarm QueryString must be a non-empty non-aggregating CWLI query");
    const identifiers = configuration?.logGroupIdentifiers ?? configuration?.LogGroupIdentifiers; this.resolveQueryGroups({ logGroupIdentifiers: identifiers }); const aggregation = this.alarmAggregation(configuration?.aggregationExpression ?? configuration?.AggregationExpression);
    try { validateInsightsQuery(`${queryString} | ${aggregation.query}`); } catch (error) { if (error instanceof InsightsSyntaxError) throw new AwsError("InvalidParameterValue", `Scheduled log alarm query is invalid: ${error.message}`); throw error; }
  }

  private emptyQueryStatistics(groupCount = 0): QueryStatistics { return { recordsMatched: 0, recordsScanned: 0, estimatedRecordsSkipped: 0, bytesScanned: 0, estimatedBytesSkipped: 0, logGroupsScanned: groupCount }; }

  private trackQuerySchedule(queryId: string, cancel: () => void): void { const schedules = this.querySchedules.get(queryId) ?? new Set(); schedules.add(cancel); this.querySchedules.set(queryId, schedules); }
  private clearQuerySchedules(queryId: string): void { for (const cancel of this.querySchedules.get(queryId) ?? []) cancel(); this.querySchedules.delete(queryId); }
  private scheduleQuery(job: QueryJob, delay: number): void { let cancel!: () => void; cancel = this.scheduler.schedule(async () => { this.querySchedules.get(job.queryId)?.delete(cancel); await this.beginQuery(job); }, delay); this.trackQuerySchedule(job.queryId, cancel); }

  private async beginQuery(job: QueryJob): Promise<void> {
    if (job.status !== "Scheduled") return; job.status = "Running"; job.startedAt = this.clock.now(); await this.store.save();
    let cancelTimeout!: () => void; cancelTimeout = this.scheduler.schedule(async () => { this.querySchedules.get(job.queryId)?.delete(cancelTimeout); if (job.status !== "Running") return; delete job.finalResults; job.status = "Timeout"; job.completedAt = this.clock.now(); job.expiresAt = job.completedAt + 7 * 24 * 60 * 60 * 1000; await this.store.save(); }, QUERY_TIMEOUT_MS); this.trackQuerySchedule(job.queryId, cancelTimeout);
    try {
      const executed = await this.executeInsightsJob(job, job.queryString, job.limit); if (job.status !== "Running") return;
      job.finalResults = executed.result.rows;
      job.results = executed.result.rows.slice(0, executed.result.rows.length ? Math.max(1, Math.ceil(executed.result.rows.length / 2)) : 0);
      job.statistics = { recordsMatched: executed.result.recordsMatched, recordsScanned: executed.scanned, estimatedRecordsSkipped: 0, bytesScanned: executed.scannedBytes, estimatedBytesSkipped: 0, logGroupsScanned: job.logGroupNames.length };
      let cancelComplete!: () => void; cancelComplete = this.scheduler.schedule(async () => { this.querySchedules.get(job.queryId)?.delete(cancelComplete); if (job.status !== "Running") return; job.results = job.finalResults ?? []; job.status = "Complete"; job.completedAt = this.clock.now(); job.expiresAt = job.completedAt + 7 * 24 * 60 * 60 * 1000; delete job.finalResults; this.clearQuerySchedules(job.queryId); await this.store.save(); }, 25); this.trackQuerySchedule(job.queryId, cancelComplete); await this.store.save();
    } catch (error) {
      if (job.status !== "Running" && !(error instanceof QueryCancelledError)) return;
      if (error instanceof QueryCancelledError) return;
      job.status = error instanceof QueryTimedOutError ? "Timeout" : "Failed"; job.failure = error instanceof Error ? error.message : String(error); job.completedAt = this.clock.now(); job.expiresAt = job.completedAt + 7 * 24 * 60 * 60 * 1000; this.clearQuerySchedules(job.queryId); await this.store.save();
    }
  }

  private async pruneQueryJobs(): Promise<void> {
    let changed = false; for (const [id, job] of Object.entries(this.queryJobs)) if (job.status !== "Scheduled" && job.status !== "Running" && job.expiresAt <= this.clock.now()) { this.clearQuerySchedules(id); delete this.queryJobs[id]; changed = true; }
    if (changed) await this.store.save();
  }

  async StartQuery(input: any, principal?: any): Promise<any> {
    await this.pruneQueryJobs(); const language = this.queryLanguage(input.queryLanguage); const queryString = String(input.queryString ?? "");
    if (queryString.length > 10_000) throw new AwsError("InvalidParameterException", "queryString must not exceed 10000 characters");
    let plan: ReturnType<typeof parseInsightsQuery>; try { plan = parseInsightsQuery(queryString); } catch (error) { if (error instanceof InsightsSyntaxError) throw this.malformed(error); throw error; }
    const groups = this.resolveQueryGroups(input); if (groups.some(name => this.groups[name].logGroupClass === "INFREQUENT_ACCESS") && plan.stages.filter(stage => stage.kind === "stats").length > 2) throw this.malformed("An Infrequent Access log query can contain no more than 2 stats commands", 0, queryString.length);
    const startTime = Number(input.startTime); const endTime = Number(input.endTime);
    if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || startTime < 0 || endTime < startTime) throw new AwsError("InvalidParameterException", "startTime and endTime must be integer epoch seconds and endTime must not precede startTime");
    const limit = input.limit === undefined ? 10_000 : Number(input.limit); if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new AwsError("InvalidParameterException", "limit must be between 1 and 100000");
    if (Object.values(this.queryJobs).filter(job => job.status === "Scheduled" || job.status === "Running").length >= 100) throw new AwsError("LimitExceededException", "No more than 100 concurrent Logs Insights queries are allowed");
    const queryId = randomUUID(); const job: QueryJob = { queryId, queryString, queryLanguage: language as "CWLI", logGroupNames: groups, startTime, endTime, limit, status: "Scheduled", createTime: this.clock.now(), expiresAt: this.clock.now() + 7 * 24 * 60 * 60 * 1000, results: [], statistics: this.emptyQueryStatistics(groups.length), userIdentity: principal?.principalArn };
    this.queryJobs[queryId] = job; await this.store.save(); this.scheduleQuery(job, 1); return { queryId };
  }

  private queryJob(queryId: unknown): QueryJob {
    const id = String(queryId ?? ""); const job = this.queryJobs[id]; if (!job) throw new AwsError("ResourceNotFoundException", `Query ${id} was not found`); return job;
  }

  async GetQueryResults(input: any): Promise<any> {
    await this.pruneQueryJobs();
    const queryId = String(input.queryId ?? ""); if (!queryId || queryId.length > 256) throw new AwsError("InvalidParameterException", "queryId must contain between 1 and 256 characters");
    const job = this.queryJob(queryId); const maxItems = input.maxItems === undefined ? 10_000 : Number(input.maxItems);
    if (!Number.isInteger(maxItems) || maxItems < 0 || maxItems > 10_000) throw new AwsError("InvalidParameterException", "maxItems must be between 0 and 10000");
    const cursor = this.decode<{ queryId: string; index: number }>("GetQueryResults", input.nextToken); if (cursor && cursor.queryId !== job.queryId) throw new AwsError("InvalidParameterException", "The specified nextToken is invalid");
    const start = cursor?.index ?? 0; const page = job.results.slice(start, start + maxItems); const next = start + page.length;
    return { queryLanguage: job.queryLanguage, results: page, statistics: { ...job.statistics }, status: job.status, ...(next < job.results.length ? { nextToken: this.encodeFor("GetQueryResults", { queryId: job.queryId, index: next }, 60 * 60 * 1000) } : {}) };
  }

  async StopQuery(input: any): Promise<any> {
    const queryId = String(input.queryId ?? ""); if (!queryId || queryId.length > 256) throw new AwsError("InvalidParameterException", "queryId must contain between 1 and 256 characters");
    const job = this.queryJob(queryId); if (job.status !== "Scheduled" && job.status !== "Running") throw new AwsError("InvalidParameterException", "The specified query is not running");
    this.clearQuerySchedules(job.queryId); delete job.finalResults; job.status = "Cancelled"; job.completedAt = this.clock.now(); job.expiresAt = job.completedAt + 7 * 24 * 60 * 60 * 1000; await this.store.save(); return { success: true };
  }

  async DescribeQueries(input: any): Promise<any> {
    await this.pruneQueryJobs(); if (input.status !== undefined && !QUERY_STATUSES.has(String(input.status))) throw new AwsError("InvalidParameterException", "Invalid query status"); if (input.queryLanguage !== undefined) this.queryLanguage(input.queryLanguage, true);
    let jobs = Object.values(this.queryJobs).sort((left, right) => right.createTime - left.createTime || left.queryId.localeCompare(right.queryId));
    if (input.logGroupName) jobs = jobs.filter(job => job.logGroupNames.includes(input.logGroupName)); if (input.status) jobs = jobs.filter(job => job.status === input.status); if (input.queryLanguage) jobs = jobs.filter(job => job.queryLanguage === input.queryLanguage);
    const maxResults = input.maxResults === undefined ? 100 : Number(input.maxResults); if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 1000) throw new AwsError("InvalidParameterException", "maxResults must be between 1 and 1000");
    const filter = JSON.stringify({ logGroupName: input.logGroupName ?? null, status: input.status ?? null, queryLanguage: input.queryLanguage ?? null }); const cursor = this.decode<{ index: number; filter: string }>("DescribeQueries", input.nextToken); if (cursor && cursor.filter !== filter) throw new AwsError("InvalidParameterException", "The specified nextToken is invalid"); const start = cursor?.index ?? 0; const page = jobs.slice(start, start + maxResults); const next = start + page.length;
    return { queries: page.map(job => ({ queryLanguage: job.queryLanguage, queryId: job.queryId, queryString: job.queryString, status: job.status, createTime: Math.floor(job.createTime / 1000), logGroupName: job.logGroupNames[0], queryDuration: job.startedAt === undefined ? 0 : (job.completedAt ?? this.clock.now()) - job.startedAt, bytesScanned: job.statistics.bytesScanned, ...(job.userIdentity ? { userIdentity: job.userIdentity } : {}) })), ...(next < jobs.length ? { nextToken: this.encode("DescribeQueries", { index: next, filter }) } : {}) };
  }

  async GetLogRecord(input: any): Promise<any> {
    const pointer = String(input.logRecordPointer ?? ""); if (!pointer) throw new AwsError("InvalidParameterException", "logRecordPointer is required");
    const { group, stream, event } = await this.eventForPointer(pointer);
    const discovered = this.discoveredFields(event.message, group.logGroupName); const record: Record<string, string> = {}; for (const [field, value] of Object.entries(discovered)) record[field] = value !== null && typeof value === "object" ? JSON.stringify(value) : value === null ? "null" : String(value);
    Object.assign(record, { "@timestamp": new Date(event.timestamp).toISOString(), "@ingestionTime": new Date(event.ingestionTime).toISOString(), "@message": event.message, "@logStream": stream.logStreamName, "@log": `${this.store.accountId}:${group.logGroupName}` }); return { logRecord: record };
  }

  async GetLogObject(input: any): Promise<Buffer> {
    const pointer = String(input.logObjectPointer ?? ""); const { event } = await this.eventForPointer(pointer);
    // PutLogEvents stores the complete event, so the structured object is reconstructed
    // losslessly instead of fabricating an LLO truncation boundary.
    try { return Buffer.from(JSON.stringify(JSON.parse(event.message))); } catch { return Buffer.from(event.message); }
  }

  async GetLogGroupFields(input: any): Promise<any> {
    const selectors = [input.logGroupName !== undefined, input.logGroupIdentifier !== undefined].filter(Boolean).length; if (selectors !== 1) throw new AwsError("InvalidParameterException", "Specify exactly one of logGroupName or logGroupIdentifier");
    const identifier = String(input.logGroupName ?? input.logGroupIdentifier); const group = this.groups[identifier] ?? Object.values(this.groups).find(candidate => candidate.arn === identifier || `${candidate.arn}:*` === identifier); if (!group) throw new AwsError("ResourceNotFoundException", `The specified log group does not exist: ${identifier}`);
    if (group.logGroupClass === "INFREQUENT_ACCESS") throw new AwsError("InvalidParameterException", "Automatic field discovery is not supported for Infrequent Access log groups");
    const center = input.time === undefined ? undefined : Number(input.time); if (center !== undefined && (!Number.isInteger(center) || center < 0)) throw new AwsError("InvalidParameterException", "time must be a non-negative epoch second");
    const from = center === undefined ? this.clock.now() - 15 * 60 * 1000 : center * 1000 - 8 * 60 * 1000; const to = center === undefined ? this.clock.now() : center * 1000 + 8 * 60 * 1000;
    const counts = new Map<string, number>(); let total = 0;
    for (const stream of Object.values(group.streams)) for (const event of await this.orderedEvents(group, stream)) { if (event.timestamp < from || event.timestamp > to) continue; total++; const names = new Set([...Object.keys(this.discoveredFields(event.message, group.logGroupName)), "@timestamp", "@ingestionTime", "@message", "@logStream", "@log"]); for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1); }
    return { logGroupFields: [...counts].map(([name, count]) => ({ name, percent: total ? count * 100 / total : 0 })).sort((left, right) => right.percent - left.percent || left.name.localeCompare(right.name)).slice(0, 200) };
  }

  async GetLogFields(input: any): Promise<any> {
    const dataSourceName = String(input.dataSourceName ?? ""), dataSourceType = String(input.dataSourceType ?? ""); if (!dataSourceName || !dataSourceType) throw new AwsError("InvalidParameterException", "dataSourceName and dataSourceType are required");
    const types = new Map<string, Set<string>>();
    for (const group of Object.values(this.groups)) for (const stream of Object.values(group.streams)) for (const event of await this.orderedEvents(group, stream)) for (const [name, value] of Object.entries(this.discoveredFields(event.message, group.logGroupName))) { const values = types.get(name) ?? new Set<string>(); values.add(logFieldType(value)); types.set(name, values); }
    for (const [name, type] of [["@timestamp", "TIMESTAMP"], ["@ingestionTime", "TIMESTAMP"], ["@message", "STRING"], ["@logStream", "STRING"], ["@log", "STRING"]]) types.set(name, new Set([type]));
    return { logFields: [...types].sort(([left], [right]) => left.localeCompare(right)).slice(0, 200).map(([logFieldName, values]) => ({ logFieldName, logFieldType: { type: values.size === 1 ? [...values][0] : "VARIANT" } })) };
  }

  private validateQueryDefinition(input: any): { name: string; queryString: string; queryLanguage: "CWLI" | "SQL" | "PPL"; logGroupNames?: string[]; parameters?: Array<{ name: string; defaultValue?: string; description?: string }> } {
    const name = String(input.name ?? ""); const queryString = String(input.queryString ?? ""); const queryLanguage = this.queryLanguage(input.queryLanguage, true);
    if (!name || name.length > 255) throw new AwsError("InvalidParameterException", "name must contain between 1 and 255 characters"); if (!queryString || queryString.length > 10_000) throw new AwsError("InvalidParameterException", "queryString must contain between 1 and 10000 characters");
    let logGroupNames: string[] | undefined; if (input.logGroupNames !== undefined) { if (queryLanguage === "SQL") throw new AwsError("InvalidParameterException", "SQL query definitions specify log groups in queryString"); if (!Array.isArray(input.logGroupNames) || input.logGroupNames.length < 1 || input.logGroupNames.length > 50 || input.logGroupNames.some((value: unknown) => !/^[.\-_/#A-Za-z0-9]+$/.test(String(value)))) throw new AwsError("InvalidParameterException", "logGroupNames must contain between 1 and 50 valid log group names"); logGroupNames = input.logGroupNames.map(String); }
    let parameters: Array<{ name: string; defaultValue?: string; description?: string }> | undefined; if (input.parameters !== undefined) { if (queryLanguage !== "CWLI") throw new AwsError("InvalidParameterException", "Query parameters are supported only for CWLI definitions"); if (!Array.isArray(input.parameters) || input.parameters.length > 20) throw new AwsError("InvalidParameterException", "A query definition can contain no more than 20 parameters"); const names = new Set<string>(); parameters = input.parameters.map((parameter: any) => { const parameterName = String(parameter?.name ?? ""); const defaultValue = parameter?.defaultValue === undefined ? undefined : String(parameter.defaultValue); const description = parameter?.description === undefined ? undefined : String(parameter.description); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameterName) || parameterName.length > 128 || names.has(parameterName)) throw new AwsError("InvalidParameterException", "Query parameter names must be unique identifiers of at most 128 characters"); if ((defaultValue?.length ?? 0) > 1024 || (description?.length ?? 0) > 512) throw new AwsError("InvalidParameterException", "Query parameter default values and descriptions exceed their documented limits"); names.add(parameterName); return { name: parameterName, ...(defaultValue !== undefined ? { defaultValue } : {}), ...(description !== undefined ? { description } : {}) }; }); }
    const placeholders = [...queryString.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].map(match => match[1]); if (queryString.replace(/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/g, "").includes("{{") || queryString.replace(/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/g, "").includes("}}")) throw new AwsError("InvalidParameterException", "Query parameter placeholders must use {{parameterName}} syntax"); if (placeholders.some(parameter => !parameters?.some(candidate => candidate.name === parameter))) throw new AwsError("InvalidParameterException", "Every query placeholder must have matching parameter metadata");
    return { name, queryString, queryLanguage, ...(logGroupNames ? { logGroupNames } : {}), ...(parameters ? { parameters } : {}) };
  }

  async PutQueryDefinition(input: any): Promise<any> {
    const validated = this.validateQueryDefinition(input); const token = input.clientToken === undefined ? undefined : String(input.clientToken);
    if (token !== undefined && (token.length < 36 || token.length > 128 || /\s/.test(token))) throw new AwsError("InvalidParameterException", "clientToken must contain between 36 and 128 non-whitespace characters");
    const tokenHash = createHash("sha256").update(JSON.stringify(validated)).digest("hex"); if (token) { const existing = Object.values(this.queryDefinitions).find(definition => definition.clientToken === token); if (existing) { if (existing.clientTokenHash && existing.clientTokenHash !== tokenHash) throw new AwsError("InvalidParameterException", "A clientToken cannot be reused with different query definition parameters"); return { queryDefinitionId: existing.queryDefinitionId }; } }
    if (input.queryDefinitionId === undefined && Object.keys(this.queryDefinitions).length >= 1000) throw new AwsError("LimitExceededException", "No more than 1000 query definitions are allowed");
    const id = input.queryDefinitionId === undefined ? randomUUID() : String(input.queryDefinitionId); if (input.queryDefinitionId !== undefined && !this.queryDefinitions[id]) throw new AwsError("ResourceNotFoundException", `Query definition ${id} was not found`);
    this.queryDefinitions[id] = { queryDefinitionId: id, ...validated, lastModified: Math.floor(this.clock.now() / 1000), ...(token ? { clientToken: token, clientTokenHash: tokenHash } : {}) }; await this.store.save(); return { queryDefinitionId: id };
  }

  async DescribeQueryDefinitions(input: any): Promise<any> {
    if (input.queryLanguage !== undefined) this.queryLanguage(input.queryLanguage, true); let definitions = Object.values(this.queryDefinitions).sort((left, right) => left.name.localeCompare(right.name) || left.queryDefinitionId.localeCompare(right.queryDefinitionId));
    if (input.queryLanguage) definitions = definitions.filter(definition => definition.queryLanguage === input.queryLanguage); if (input.queryDefinitionNamePrefix) definitions = definitions.filter(definition => definition.name.startsWith(input.queryDefinitionNamePrefix));
    const maxResults = input.maxResults === undefined ? 100 : Number(input.maxResults); if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 1000) throw new AwsError("InvalidParameterException", "maxResults must be between 1 and 1000"); const filter = JSON.stringify({ queryLanguage: input.queryLanguage ?? null, queryDefinitionNamePrefix: input.queryDefinitionNamePrefix ?? null }); const cursor = this.decode<{ index: number; filter: string }>("DescribeQueryDefinitions", input.nextToken); if (cursor && cursor.filter !== filter) throw new AwsError("InvalidParameterException", "The specified nextToken is invalid"); const start = cursor?.index ?? 0; const page = definitions.slice(start, start + maxResults); const next = start + page.length;
    return { queryDefinitions: page.map(({ clientToken: _clientToken, clientTokenHash: _clientTokenHash, ...definition }) => structuredClone(definition)), ...(next < definitions.length ? { nextToken: this.encode("DescribeQueryDefinitions", { index: next, filter }) } : {}) };
  }

  async DeleteQueryDefinition(input: any): Promise<any> {
    const id = String(input.queryDefinitionId ?? ""); if (!this.queryDefinitions[id]) throw new AwsError("ResourceNotFoundException", `Query definition ${id} was not found`); delete this.queryDefinitions[id]; await this.store.save(); return { success: true };
  }

  async applyRetention(): Promise<void> { for (const group of Object.values(this.groups)) for (const stream of Object.values(group.streams)) await this.purge(group, stream); }
  private async purge(group: LogGroupState, stream: LogStreamState): Promise<void> {
    if (!group.retentionInDays) return; const segment = this.events(group.logGroupName, stream.logStreamName); const events = await segment.readAll(); const retained = events.filter(event => event.timestamp >= this.clock.now() - group.retentionInDays! * 86_400_000); if (retained.length === events.length) return;
    await segment.compact(retained); const old = stream.storedBytes; stream.storedBytes = retained.reduce((sum, event) => sum + Buffer.byteLength(event.message) + 26, 0); group.storedBytes = Math.max(0, group.storedBytes - old + stream.storedBytes); stream.firstEventTimestamp = retained[0]?.timestamp; stream.lastEventTimestamp = retained.at(-1)?.timestamp; await this.store.save();
  }
}
