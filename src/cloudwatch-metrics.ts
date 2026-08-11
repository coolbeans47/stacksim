import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import type { Clock } from "./core/clock.js";
import { SystemClock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import type { Scheduler } from "./core/scheduler.js";
import type { TelemetryEvent } from "./core/telemetry.js";
import { AwsError, sendAwsError } from "./errors.js";
import { CLOUDWATCH_ALARM_ACTIONS, CloudWatchAlarmEngine, type AlarmSeries } from "./cloudwatch-alarms.js";
import { CLOUDWATCH_ANOMALY_ACTIONS, CloudWatchAnomalyEngine } from "./cloudwatch-anomalies.js";
import { CLOUDWATCH_DASHBOARD_ACTIONS, CloudWatchDashboardEngine } from "./cloudwatch-dashboards.js";
import { CLOUDWATCH_METRIC_STREAM_ACTIONS, CloudWatchMetricStreamEngine } from "./cloudwatch-metric-streams.js";
import { CLOUDWATCH_INSIGHT_RULE_ACTIONS, CloudWatchInsightRuleEngine, decodeDynamoContributorKey, type ManagedContributorResult } from "./cloudwatch-insight-rules.js";
import type { CloudWatchLogsService } from "./cloudwatch-logs.js";
import type { LambdaService } from "./lambda.js";
import { SegmentedStore } from "./persistence/segmented-store.js";
import { awsQueryErrorXml, awsQueryMap, parseAwsQuery, sendAwsQueryXml } from "./protocols/query-xml.js";
import type { StateStore } from "./state.js";
import { readBody } from "./util.js";
import type { PrincipalContext } from "./auth/sigv4.js";

const NAMESPACE = "http://monitoring.amazonaws.com/doc/2010-08-01/";
const UNITS = new Set(["Seconds", "Microseconds", "Milliseconds", "Bytes", "Kilobytes", "Megabytes", "Gigabytes", "Terabytes", "Bits", "Kilobits", "Megabits", "Gigabits", "Terabits", "Percent", "Count", "Bytes/Second", "Kilobytes/Second", "Megabytes/Second", "Gigabytes/Second", "Terabytes/Second", "Bits/Second", "Kilobits/Second", "Megabits/Second", "Gigabits/Second", "Terabits/Second", "Count/Second", "None"]);
const STATISTICS = new Set(["SampleCount", "Average", "Sum", "Minimum", "Maximum"]);
const MAX_VALUE = 2 ** 360;

export interface MetricRetentionSchedule {
  highResolutionMs: number;
  minuteMs: number;
  fiveMinuteMs: number;
  totalMs: number;
  compactEveryMs: number;
}

const DEFAULT_RETENTION: MetricRetentionSchedule = {
  highResolutionMs: 3 * 60 * 60_000,
  minuteMs: 15 * 86_400_000,
  fiveMinuteMs: 63 * 86_400_000,
  totalMs: 455 * 86_400_000,
  compactEveryMs: 60_000,
};

interface Dimension { Name: string; Value: string }
interface RawValue { value: number; count: number }
interface MetricPoint {
  namespace: string;
  metricName: string;
  dimensions: Dimension[];
  unit: string;
  storageResolution: 1 | 60;
  resolution: 1 | 60 | 300 | 3600;
  timestamp: number;
  sampleCount: number;
  sum: number;
  minimum: number;
  maximum: number;
  raw?: RawValue[];
  rollup?: boolean;
  firstTimestamp?: number;
  lastTimestamp?: number;
}

interface Aggregate {
  timestamp: number;
  unit: string;
  sampleCount: number;
  sum: number;
  minimum: number;
  maximum: number;
  raw?: RawValue[];
}

interface Series { values: Map<number, number>; period: number; sourceId?: string; labelSuffix?: string }
type MathValue = { kind: "scalar"; value: number } | { kind: "series"; series: Series };
type ParsedValue = MathValue | MathValue[];

interface InsightsQuery {
  aggregate: "AVG" | "COUNT" | "MAX" | "MIN" | "SUM";
  metricName: string;
  namespace: string;
  schemaDimensions?: string[];
  filters: Array<{ label: string; operator: "=" | "!="; value: string }>;
  groupBy: string[];
  orderBy?: { aggregate: "AVG" | "COUNT" | "MAX" | "MIN" | "SUM"; direction: "ASC" | "DESC" };
  limit: number;
}

interface InsightsToken { kind: "word" | "string" | "number" | "symbol"; value: string }

function tokenizeInsights(value: string): InsightsToken[] {
  const tokens: InsightsToken[] = []; let index = 0;
  while (index < value.length) {
    if (/\s/.test(value[index])) { index++; continue; }
    const character = value[index];
    if (character === '"' || character === "'") {
      const quote = character; let result = ""; index++; let closed = false;
      while (index < value.length) { const current = value[index++]; if (current === "\\" && index < value.length) result += value[index++]; else if (current === quote) { closed = true; break; } else result += current; }
      if (!closed) throw new AwsError("InvalidParameterValue", "Metrics Insights query contains an unterminated quoted value");
      tokens.push({ kind: quote === "'" ? "string" : "word", value: result }); continue;
    }
    const operator = value.slice(index, index + 2); if (operator === "!=") { tokens.push({ kind: "symbol", value: operator }); index += 2; continue; }
    if ("(),=".includes(character)) { tokens.push({ kind: "symbol", value: character }); index++; continue; }
    const numberMatch = value.slice(index).match(/^\d+/); if (numberMatch) { tokens.push({ kind: "number", value: numberMatch[0] }); index += numberMatch[0].length; continue; }
    const word = value.slice(index).match(/^[A-Za-z_][A-Za-z0-9_.]*/); if (word) { tokens.push({ kind: "word", value: word[0] }); index += word[0].length; continue; }
    throw new AwsError("InvalidParameterValue", `Unsupported Metrics Insights token near ${value.slice(index, index + 16)}`);
  }
  return tokens;
}

class MetricsInsightsParser {
  private index = 0;
  private readonly tokens: InsightsToken[];
  constructor(value: string, private readonly accountId: string) { this.tokens = tokenizeInsights(value); }
  parse(): InsightsQuery {
    this.expectWord("SELECT"); const aggregate = this.aggregate(); this.expectSymbol("("); const metricName = this.name("metric name"); this.expectSymbol(")"); this.expectWord("FROM");
    let namespace: string; let schemaDimensions: string[] | undefined;
    if (this.peekWord("SCHEMA")) { this.index++; this.expectSymbol("("); namespace = this.name("namespace"); schemaDimensions = []; while (this.consumeSymbol(",")) schemaDimensions.push(this.name("schema dimension")); this.expectSymbol(")"); if (new Set(schemaDimensions).size !== schemaDimensions.length) throw new AwsError("InvalidParameterValue", "SCHEMA dimensions must be unique"); }
    else namespace = this.name("namespace");
    const filters: InsightsQuery["filters"] = [];
    if (this.peekWord("WHERE")) {
      this.index++;
      do { const label = this.name("filter label"); const operator = this.consumeSymbol("!=") ? "!=" : (this.expectSymbol("="), "="); let value: string; const token = this.tokens[this.index++]; if (token?.kind === "string") value = token.value; else if (token?.kind === "word" && token.value.toUpperCase() === "CURRENT_ACCOUNT_ID") { this.expectSymbol("("); this.expectSymbol(")"); value = this.accountId; } else throw new AwsError("InvalidParameterValue", "Metrics Insights filter values must use single quotes"); filters.push({ label, operator, value }); if (!this.peekWord("AND")) break; this.index++; } while (true);
    }
    const groupBy: string[] = [];
    if (this.peekWord("GROUP")) { this.index++; this.expectWord("BY"); do { groupBy.push(this.name("group label")); } while (this.consumeSymbol(",")); if (new Set(groupBy).size !== groupBy.length) throw new AwsError("InvalidParameterValue", "GROUP BY labels must be unique"); }
    let orderBy: InsightsQuery["orderBy"];
    if (this.peekWord("ORDER")) { this.index++; this.expectWord("BY"); const orderAggregate = this.aggregate(); this.expectSymbol("("); this.expectSymbol(")"); const direction = this.peekWord("DESC") ? (this.index++, "DESC" as const) : this.peekWord("ASC") ? (this.index++, "ASC" as const) : "ASC"; orderBy = { aggregate: orderAggregate, direction }; }
    let limit = 500; if (this.peekWord("LIMIT")) { this.index++; const token = this.tokens[this.index++]; limit = token?.kind === "number" ? Number(token.value) : Number.NaN; if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new AwsError("InvalidParameterValue", "Metrics Insights LIMIT must be between 1 and 500"); }
    if (this.index !== this.tokens.length) throw new AwsError("InvalidParameterValue", `Unsupported Metrics Insights clause ${this.tokens[this.index]?.value ?? ""}`);
    for (const label of [...filters.map(filter => filter.label), ...groupBy]) if (label.toLowerCase().startsWith("tag.")) throw new AwsError("InvalidParameterValue", "Resource-tag filters and groups are not available in the local Metrics Insights subset");
    return { aggregate, metricName, namespace, ...(schemaDimensions ? { schemaDimensions } : {}), filters, groupBy, ...(orderBy ? { orderBy } : {}), limit };
  }
  private aggregate(): InsightsQuery["aggregate"] { const value = this.name("aggregate function").toUpperCase(); if (!["AVG", "COUNT", "MAX", "MIN", "SUM"].includes(value)) throw new AwsError("InvalidParameterValue", `Unsupported Metrics Insights aggregate ${value}`); return value as InsightsQuery["aggregate"]; }
  private name(label: string): string { const token = this.tokens[this.index++]; if (token?.kind !== "word" || !token.value) throw new AwsError("InvalidParameterValue", `Metrics Insights ${label} is required`); return token.value; }
  private peekWord(value: string): boolean { const token = this.tokens[this.index]; return token?.kind === "word" && token.value.toUpperCase() === value; }
  private expectWord(value: string): void { if (!this.peekWord(value)) throw new AwsError("InvalidParameterValue", `Metrics Insights query expected ${value}`); this.index++; }
  private consumeSymbol(value: string): boolean { const token = this.tokens[this.index]; if (token?.kind !== "symbol" || token.value !== value) return false; this.index++; return true; }
  private expectSymbol(value: string): void { if (!this.consumeSymbol(value)) throw new AwsError("InvalidParameterValue", `Metrics Insights query expected ${value}`); }
}

function list<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function number(value: unknown, field: string): number { const parsed = Number(value); if (!Number.isFinite(parsed)) throw new AwsError("InvalidParameterValue", `${field} must be a finite number`); return parsed; }
function timestamp(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value < 1e12 ? value * 1000 : value : Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new AwsError("InvalidParameterValue", "Timestamp is invalid");
  return parsed;
}
function dimensions(value: unknown, filters = false): Dimension[] {
  const result = list<any>(value).map(item => ({ Name: String(item?.Name ?? ""), Value: item?.Value === undefined && filters ? "" : String(item?.Value ?? "") }));
  if (result.length > (filters ? 10 : 30)) throw new AwsError("InvalidParameterValue", `A maximum of ${filters ? 10 : 30} dimensions is allowed`);
  const names = new Set<string>();
  for (const dimension of result) {
    if (!dimension.Name || dimension.Name.length > 255 || /[\x00-\x1f]/.test(dimension.Name)) throw new AwsError("InvalidParameterValue", "Dimension name is invalid");
    if (!filters && (!dimension.Value || dimension.Value.length > 1024 || /[\x00-\x1f]/.test(dimension.Value))) throw new AwsError("InvalidParameterValue", "Dimension value is invalid");
    if (names.has(dimension.Name)) throw new AwsError("InvalidParameterValue", "Duplicate dimension names are not allowed");
    names.add(dimension.Name);
  }
  return result.sort((left, right) => left.Name.localeCompare(right.Name) || left.Value.localeCompare(right.Value));
}
function metricKey(point: Pick<MetricPoint, "namespace" | "metricName" | "dimensions">): string { return `${point.namespace}\0${point.metricName}\0${point.dimensions.map(item => `${item.Name}\0${item.Value}`).join("\0")}`; }
function sameDimensions(left: Dimension[], right: Dimension[]): boolean { return left.length === right.length && left.every((item, index) => item.Name === right[index].Name && item.Value === right[index].Value); }
function validName(value: unknown, label: string): string {
  const result = String(value ?? "");
  if (!result || result.length > 255 || /^:/.test(result) || /[\x00-\x1f]/.test(result) || !result.trim()) throw new AwsError("InvalidParameterValue", `${label} is invalid`);
  return result;
}
function validUnit(value: unknown): string { const unit = String(value ?? "None"); if (!UNITS.has(unit)) throw new AwsError("InvalidParameterValue", `Invalid unit ${unit}`); return unit; }
function validValue(value: unknown, field: string): number { const result = number(value, field); if (Math.abs(result) > MAX_VALUE) throw new AwsError("InvalidParameterValue", `${field} is outside the supported range`); return result; }
function percentileName(value: string): number | undefined { const match = value.match(/^p(100(?:\.0{1,10})?|\d{1,2}(?:\.\d{1,10})?)$/i); if (!match) return undefined; const result = Number(match[1]); return result >= 0 && result <= 100 ? result : undefined; }
function percentile(raw: RawValue[], requested: number): number | undefined {
  if (!raw.length || raw.some(item => item.value < 0)) return undefined;
  const sorted = [...raw].sort((left, right) => left.value - right.value); const total = sorted.reduce((sum, item) => sum + item.count, 0);
  if (total <= 0) return undefined; const rank = requested === 0 ? 1 : Math.ceil((requested / 100) * total); let cursor = 0;
  for (const item of sorted) { cursor += item.count; if (cursor >= rank) return item.value; }
  return sorted.at(-1)?.value;
}
function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([key]) => key !== "NextToken").sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function jsonResponse(value: unknown): unknown {
  if (value instanceof Date) return value.getTime() / 1000;
  if (Array.isArray(value)) return value.map(jsonResponse);
  if (value && typeof value === "object") {
    const candidate = value as any; if (candidate.__awsQueryMap === true) return Object.fromEntries(candidate.entries.map(([key, item]: [string, unknown]) => [key, jsonResponse(item)]));
    return Object.fromEntries(Object.entries(candidate).filter(([, item]) => item !== undefined).map(([key, item]) => [key, jsonResponse(item)]));
  }
  return value;
}

function mergePoints(points: MetricPoint[], timestamp: number, unit: string): Aggregate {
  const raw = points.every(point => point.raw) ? points.flatMap(point => point.raw!) : undefined;
  return {
    timestamp, unit,
    sampleCount: points.reduce((sum, point) => sum + point.sampleCount, 0),
    sum: points.reduce((sum, point) => sum + point.sum, 0),
    minimum: Math.min(...points.map(point => point.minimum)),
    maximum: Math.max(...points.map(point => point.maximum)),
    ...(raw ? { raw } : {}),
  };
}

function consolidateRaw(values: RawValue[]): RawValue[] {
  const counts = new Map<number, number>();
  for (const item of values) counts.set(item.value, (counts.get(item.value) ?? 0) + item.count);
  return [...counts.entries()].map(([value, count]) => ({ value, count }));
}

class MetricMathParser {
  private index = 0;
  constructor(private readonly tokens: string[], private readonly resolve: (identifier: string) => ParsedValue, private readonly start: number, private readonly end: number, private readonly anomalyBand: (series: Series, deviations: number) => MathValue[]) {}
  parse(): ParsedValue {
    const value = this.expression();
    if (this.index !== this.tokens.length) throw new AwsError("InvalidParameterValue", "Invalid metric math expression");
    return value;
  }
  private expression(): ParsedValue { let value = this.term(); while (["+", "-"].includes(this.tokens[this.index])) { const operator = this.tokens[this.index++]; value = this.binary(value, this.term(), operator); } return value; }
  private term(): ParsedValue { let value = this.unary(); while (["*", "/"].includes(this.tokens[this.index])) { const operator = this.tokens[this.index++]; value = this.binary(value, this.unary(), operator); } return value; }
  private unary(): ParsedValue { if (this.tokens[this.index] === "-") { this.index++; return this.binary({ kind: "scalar", value: 0 }, this.unary(), "-"); } return this.primary(); }
  private primary(): ParsedValue {
    const token = this.tokens[this.index++];
    if (token === "(") { const value = this.expression(); if (this.tokens[this.index++] !== ")") throw new AwsError("InvalidParameterValue", "Unclosed metric math expression"); return value; }
    if (token === "[") { const values: MathValue[] = []; while (this.tokens[this.index] !== "]") { const value = this.expression(); if (Array.isArray(value)) values.push(...value); else values.push(value); if (this.tokens[this.index] === ",") this.index++; else if (this.tokens[this.index] !== "]") throw new AwsError("InvalidParameterValue", "Invalid metric math list"); } this.index++; return values; }
    if (/^\d+(?:\.\d+)?$/.test(token ?? "")) return { kind: "scalar", value: Number(token) };
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(token ?? "")) {
      if (this.tokens[this.index] !== "(") return this.resolve(token);
      this.index++; const args: ParsedValue[] = [];
      while (this.tokens[this.index] !== ")") { args.push(this.expression()); if (this.tokens[this.index] === ",") this.index++; else if (this.tokens[this.index] !== ")") throw new AwsError("InvalidParameterValue", "Invalid metric math function"); }
      this.index++; return this.call(token.toUpperCase(), args);
    }
    throw new AwsError("InvalidParameterValue", "Invalid metric math expression");
  }
  private one(value: ParsedValue): MathValue { if (Array.isArray(value)) throw new AwsError("InvalidParameterValue", "Metric math list is not valid here"); return value; }
  private binary(leftInput: ParsedValue, rightInput: ParsedValue, operator: string): ParsedValue {
    if (Array.isArray(leftInput) || Array.isArray(rightInput)) {
      if (Array.isArray(leftInput) && Array.isArray(rightInput)) { if (leftInput.length !== rightInput.length) throw new AwsError("InvalidParameterValue", "Metric math time-series arrays must have equal lengths"); return leftInput.map((left, index) => this.binary(left, rightInput[index], operator) as MathValue); }
      const values = Array.isArray(leftInput) ? leftInput : rightInput as MathValue[]; const other = Array.isArray(leftInput) ? rightInput : leftInput;
      return values.map(value => this.binary(Array.isArray(leftInput) ? value : other, Array.isArray(leftInput) ? other : value, operator) as MathValue);
    }
    const left = leftInput; const right = rightInput; const apply = (a: number, b: number) => operator === "+" ? a + b : operator === "-" ? a - b : operator === "*" ? a * b : b === 0 ? Number.NaN : a / b;
    if (left.kind === "scalar" && right.kind === "scalar") return { kind: "scalar", value: apply(left.value, right.value) };
    const period = Math.max(left.kind === "series" ? left.series.period : 1, right.kind === "series" ? right.series.period : 1); const values = new Map<number, number>();
    const timestamps = left.kind === "series" && right.kind === "series" ? [...left.series.values.keys()].filter(time => right.series.values.has(time)) : [...(left.kind === "series" ? left.series.values : (right as { kind: "series"; series: Series }).series.values).keys()];
    for (const time of timestamps) { const a = left.kind === "scalar" ? left.value : left.series.values.get(time)!; const b = right.kind === "scalar" ? right.value : right.series.values.get(time)!; const result = apply(a, b); if (Number.isFinite(result)) values.set(time, result); }
    const source = left.kind === "series" ? left.series : right.kind === "series" ? right.series : undefined;
    return { kind: "series", series: { values, period, ...(source?.labelSuffix ? { labelSuffix: source.labelSuffix } : {}) } };
  }
  private call(name: string, input: ParsedValue[]): ParsedValue {
    if (name === "ANOMALY_DETECTION_BAND") {
      if (input.length < 1 || input.length > 2) throw new AwsError("InvalidParameterValue", "ANOMALY_DETECTION_BAND requires a time series and optional deviation value"); const source = this.one(input[0]); const width = input.length === 2 ? this.one(input[1]) : { kind: "scalar" as const, value: 2 };
      if (source.kind !== "series" || width.kind !== "scalar" || !Number.isFinite(width.value) || width.value <= 0) throw new AwsError("InvalidParameterValue", "ANOMALY_DETECTION_BAND requires a time series and positive scalar deviation value"); return this.anomalyBand(source.series, width.value);
    }
    if (name === "FILL") {
      if (input.length !== 2) throw new AwsError("InvalidParameterValue", "FILL requires a time series and fill value"); const series = this.one(input[0]); const fill = this.one(input[1]);
      if (series.kind !== "series" || fill.kind !== "scalar") throw new AwsError("InvalidParameterValue", "FILL requires a time series and scalar fill value"); const values = new Map(series.series.values); const step = series.series.period * 1000;
      for (let time = Math.floor(this.start / step) * step; time < this.end; time += step) if (time >= this.start && !values.has(time)) values.set(time, fill.value);
      return { kind: "series", series: { values, period: series.series.period } };
    }
    if (!["SUM", "AVG", "MIN", "MAX"].includes(name)) throw new AwsError("InvalidParameterValue", `Unsupported metric math function ${name}`);
    const args = input.flatMap(value => Array.isArray(value) ? value : [value]); if (!args.length) throw new AwsError("InvalidParameterValue", `${name} requires at least one argument`);
    if (args.every(value => value.kind === "scalar")) { const values = args.map(value => (value as { kind: "scalar"; value: number }).value); return { kind: "scalar", value: name === "SUM" ? values.reduce((a, b) => a + b, 0) : name === "AVG" ? values.reduce((a, b) => a + b, 0) / values.length : name === "MIN" ? Math.min(...values) : Math.max(...values) }; }
    const series = args.filter((value): value is { kind: "series"; series: Series } => value.kind === "series"); const timestamps = [...new Set(series.flatMap(value => [...value.series.values.keys()]))].sort((a, b) => a - b); const values = new Map<number, number>();
    for (const time of timestamps) { const samples = args.flatMap(value => value.kind === "scalar" ? [value.value] : value.series.values.has(time) ? [value.series.values.get(time)!] : []); if (samples.length) values.set(time, name === "SUM" ? samples.reduce((a, b) => a + b, 0) : name === "AVG" ? samples.reduce((a, b) => a + b, 0) / samples.length : name === "MIN" ? Math.min(...samples) : Math.max(...samples)); }
    return { kind: "series", series: { values, period: Math.max(...series.map(value => value.series.period)) } };
  }
}

export class CloudWatchMetricsService {
  private readonly segments: SegmentedStore<MetricPoint>;
  private readonly tokens: PaginationTokens;
  private readonly retention: MetricRetentionSchedule;
  private readonly telemetryBuckets = new Map<string, MetricPoint>();
  private writes = Promise.resolve();
  private started = false;
  readonly alarms: CloudWatchAlarmEngine;
  readonly anomalies: CloudWatchAnomalyEngine;
  readonly dashboards: CloudWatchDashboardEngine;
  readonly metricStreams: CloudWatchMetricStreamEngine;
  readonly insightRules: CloudWatchInsightRuleEngine;

  constructor(private readonly state: StateStore, private readonly region: string, private readonly clock: Clock = new SystemClock(), private readonly scheduler?: Scheduler, retention: Partial<MetricRetentionSchedule> = {}, alarmHistoryRetentionMs?: number, allowLocalFiles = false) {
    this.segments = new SegmentedStore(state.root, `cloudwatch/metrics/${state.accountId}/${region}`);
    this.tokens = new PaginationTokens(state.state.installation.paginationSecret);
    this.retention = { ...DEFAULT_RETENTION, ...retention };
    if (!(this.retention.highResolutionMs < this.retention.minuteMs && this.retention.minuteMs < this.retention.fiveMinuteMs && this.retention.fiveMinuteMs < this.retention.totalMs) || this.retention.compactEveryMs <= 0) throw new Error("Invalid metric retention schedule");
    this.anomalies = new CloudWatchAnomalyEngine(state, region, clock, input => this.GetMetricData(input));
    this.alarms = new CloudWatchAlarmEngine(state, region, clock, (metricStat, start, end) => this.alarmSeries(metricStat, start, end), input => this.GetMetricData(input), alarmHistoryRetentionMs, scheduler);
    this.dashboards = new CloudWatchDashboardEngine(state, clock);
    this.metricStreams = new CloudWatchMetricStreamEngine(state, region, clock, allowLocalFiles);
    this.insightRules = new CloudWatchInsightRuleEngine(state, region, clock, (resourceArn, templateName, start, end) => this.managedContributorObservations(resourceArn, templateName, start, end));
  }

  setLambdaService(lambda: LambdaService): void { this.alarms.setLambdaService(lambda); }
  setEventPublisher(publisher: import("./cloudwatch-alarms.js").AlarmEventPublisher): void { this.alarms.setEventPublisher(publisher); }
  setSnsPublisher(publisher: import("./cloudwatch-alarms.js").AlarmSnsPublisher): void { this.alarms.setSnsPublisher(publisher); }
  setLogService(logs: CloudWatchLogsService): void { this.alarms.setLogQueryService(configuration => logs.validateLogAlarmQuery(configuration), (configuration, start, end, lineCount) => logs.runLogAlarmQuery(configuration, start, end, lineCount)); this.insightRules.setLogReader((selectors, start, end) => logs.contributorEvents(selectors, start, end)); }

  start(): void {
    this.alarms.start();
    if (this.started || !this.scheduler) return; this.started = true;
    const scheduleCompaction = () => this.scheduler!.schedule(async () => { try { await this.flushTelemetry(Math.floor(this.clock.now() / 60_000) * 60_000); await this.compactNow(); } finally { scheduleCompaction(); } }, this.retention.compactEveryMs);
    const scheduleAlarms = () => { const delay = 10_000 - (this.clock.now() % 10_000); this.scheduler!.schedule(async () => { await this.alarms.evaluateNow(Math.floor(this.clock.now() / 10_000) * 10_000); scheduleAlarms(); }, delay); };
    scheduleCompaction(); scheduleAlarms();
  }

  async stop(): Promise<void> { await this.alarms.stop(); await this.flush(); }
  async flush(): Promise<void> { await this.flushTelemetry(Number.POSITIVE_INFINITY); await this.writes; }

  async handle(req: IncomingMessage, res: ServerResponse, requestId: string, principal?: PrincipalContext): Promise<void> {
    const jsonProtocol = String(req.headers["x-amz-target"] ?? "").startsWith("GraniteServiceVersion20100801.");
    try {
      const wireBody = await readBody(req); if (wireBody.length > 1024 * 1024) throw new AwsError("InvalidParameterValue", "Request size exceeds 1 MB"); const requestBody = String(req.headers["content-encoding"] ?? "").toLowerCase() === "gzip" ? gunzipSync(wireBody) : wireBody; const input = (jsonProtocol ? JSON.parse(requestBody.toString("utf8") || "{}") : parseAwsQuery(requestBody.toString("utf8"))) as any; const action = jsonProtocol ? String(req.headers["x-amz-target"]).split(".").pop()! : String(input.Action ?? "");
      const metricActions = new Set(["PutMetricData", "ListMetrics", "GetMetricStatistics", "GetMetricData", "GetDataset", "AssociateDatasetKmsKey", "DisassociateDatasetKmsKey"]); const anomalyActions = new Set<string>(CLOUDWATCH_ANOMALY_ACTIONS); const alarmActions = new Set<string>(CLOUDWATCH_ALARM_ACTIONS); const dashboardActions = new Set<string>(CLOUDWATCH_DASHBOARD_ACTIONS); const metricStreamActions = new Set<string>(CLOUDWATCH_METRIC_STREAM_ACTIONS); const insightRuleActions = new Set<string>(CLOUDWATCH_INSIGHT_RULE_ACTIONS); const resourceActions = new Set(["TagResource", "UntagResource", "ListTagsForResource"]);
      if (!action || (!metricActions.has(action) && !anomalyActions.has(action) && !alarmActions.has(action) && !dashboardActions.has(action) && !metricStreamActions.has(action) && !insightRuleActions.has(action))) throw new AwsError("InvalidAction", `The action ${action} is not valid for this service`);
      delete input.Action; delete input.Version; const result = resourceActions.has(action) ? await (this as any)[action](input) : insightRuleActions.has(action) ? await (this.insightRules as any)[action](input) : metricStreamActions.has(action) ? await (this.metricStreams as any)[action](input) : anomalyActions.has(action) ? await (this.anomalies as any)[action](input) : alarmActions.has(action) ? await (this.alarms as any)[action](input, principal?.lambdaLineage) : dashboardActions.has(action) ? await (this.dashboards as any)[action](input) : await (this as any)[action](input);
      if (jsonProtocol) { res.statusCode = 200; res.setHeader("content-type", "application/x-amz-json-1.0"); res.end(JSON.stringify(jsonResponse(result ?? {}))); return; }
      const responseBody: Record<string, unknown> = result && Object.keys(result).length ? { [`${action}Result`]: result, ResponseMetadata: { RequestId: requestId } } : { ResponseMetadata: { RequestId: requestId } };
      sendAwsQueryXml(res, `${action}Response`, responseBody, NAMESPACE);
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("InternalServiceError", error instanceof Error ? error.message : String(error), 500);
      if (jsonProtocol) return sendAwsError(res, aws, "json", "com.amazonaws.cloudwatch#");
      res.statusCode = aws.status; res.setHeader("content-type", "text/xml; charset=utf-8"); res.end(awsQueryErrorXml(aws.code, aws.message, requestId));
    }
  }

  async PutMetricData(input: any): Promise<Record<string, never>> {
    const namespace = validName(input.Namespace, "Namespace"); if (namespace.startsWith("AWS/")) throw new AwsError("InvalidParameterValue", "Custom namespaces must not begin with AWS/");
    if (input.EntityMetricData !== undefined) throw new AwsError("InvalidParameterValue", "EntityMetricData is not implemented in this local metric phase");
    const data = list<any>(input.MetricData); if (!data.length) throw new AwsError("MissingParameter", "MetricData is required"); if (data.length > 1_000) throw new AwsError("InvalidParameterValue", "A maximum of 1000 metrics is allowed");
    const points = data.map(item => this.datum(namespace, item, false)); await this.append(points); return {};
  }

  private datasetArn(): string { return `arn:aws:cloudwatch:${this.region}:${this.state.accountId}:dataset/default`; }
  private validateDatasetIdentifier(value: unknown): void {
    const identifier = String(value ?? ""); if (identifier !== "default" && identifier !== this.datasetArn()) throw new AwsError("ResourceNotFoundException", "Only the default CloudWatch dataset exists in this account and Region", 404);
  }
  async GetDataset(input: any): Promise<any> { this.validateDatasetIdentifier(input.DatasetIdentifier); const KmsKeyArn = this.state.regionState(this.region).cloudwatch.datasetKmsKeyArn; return { DatasetId: "default", Arn: this.datasetArn(), ...(KmsKeyArn ? { KmsKeyArn } : {}) }; }
  async AssociateDatasetKmsKey(input: any): Promise<Record<string, never>> {
    this.validateDatasetIdentifier(input.DatasetIdentifier); const arn = String(input.KmsKeyArn ?? ""); const match = arn.match(/^arn:(?:aws|aws-us-gov|aws-cn):kms:([^:]+):(\d{12}):key\/[A-Za-z0-9-]+$/);
    if (!match || match[1] !== this.region || match[2] !== this.state.accountId) throw new AwsError("InvalidParameterValue", "KmsKeyArn must be a fully qualified symmetric-key ARN in this simulator account and Region");
    this.state.regionState(this.region).cloudwatch.datasetKmsKeyArn = arn; await this.state.save(); return {};
  }
  async DisassociateDatasetKmsKey(input: any): Promise<Record<string, never>> {
    this.validateDatasetIdentifier(input.DatasetIdentifier); const dataset = this.state.regionState(this.region).cloudwatch; if (!dataset.datasetKmsKeyArn) throw new AwsError("ResourceNotFoundException", "The default dataset has no customer managed KMS key association", 404); delete dataset.datasetKmsKeyArn; await this.state.save(); return {};
  }

  async TagResource(input: any): Promise<Record<string, never>> { return this.insightRules.hasResourceArn(input.ResourceARN) ? this.insightRules.TagResource(input) : this.metricStreams.hasResourceArn(input.ResourceARN) ? this.metricStreams.TagResource(input) : this.alarms.TagResource(input); }
  async UntagResource(input: any): Promise<Record<string, never>> { return this.insightRules.hasResourceArn(input.ResourceARN) ? this.insightRules.UntagResource(input) : this.metricStreams.hasResourceArn(input.ResourceARN) ? this.metricStreams.UntagResource(input) : this.alarms.UntagResource(input); }
  async ListTagsForResource(input: any): Promise<any> { return this.insightRules.hasResourceArn(input.ResourceARN) ? this.insightRules.ListTagsForResource(input) : this.metricStreams.hasResourceArn(input.ResourceARN) ? this.metricStreams.ListTagsForResource(input) : this.alarms.ListTagsForResource(input); }

  async publish(event: TelemetryEvent): Promise<void> {
    const point = this.datum(event.namespace, { MetricName: event.metricName, Dimensions: Object.entries(event.dimensions).map(([Name, Value]) => ({ Name, Value })), Unit: event.unit, Timestamp: new Date(event.timestamp), Value: event.value }, true);
    const observedAt = point.timestamp; const minute = Math.floor(observedAt / 60_000) * 60_000; point.timestamp = minute; point.firstTimestamp = observedAt; point.lastTimestamp = observedAt;
    const key = `${metricKey(point)}\0${point.unit}\0${minute}`; const current = this.telemetryBuckets.get(key);
    if (!current || event.aggregation === "gauge") this.telemetryBuckets.set(key, point);
    else {
      const aggregate = mergePoints([current, point], minute, point.unit); const raw = aggregate.raw ? consolidateRaw(aggregate.raw) : undefined;
      this.telemetryBuckets.set(key, { ...current, ...aggregate, firstTimestamp: Math.min(current.firstTimestamp ?? current.timestamp, observedAt), lastTimestamp: Math.max(current.lastTimestamp ?? current.timestamp, observedAt), ...(raw ? { raw } : { raw: undefined }) });
    }
    await this.flushTelemetry(minute);
  }

  private async flushTelemetry(cutoff: number): Promise<void> {
    const completed: MetricPoint[] = [];
    for (const [key, point] of this.telemetryBuckets) if (point.timestamp < cutoff) { this.telemetryBuckets.delete(key); completed.push(point); }
    if (!completed.length) return;
    try { await this.append(completed); }
    catch (error) { for (const point of completed) this.telemetryBuckets.set(`${metricKey(point)}\0${point.unit}\0${point.timestamp}`, point); throw error; }
  }

  private datum(namespaceInput: unknown, input: any, internal: boolean): MetricPoint {
    const namespace = validName(namespaceInput, "Namespace"); if (!internal && namespace.startsWith("AWS/")) throw new AwsError("InvalidParameterValue", "Custom namespaces must not begin with AWS/");
    const metricName = validName(input?.MetricName, "MetricName"); const metricDimensions = dimensions(input?.Dimensions); const unit = validUnit(input?.Unit); const at = timestamp(input?.Timestamp, this.clock.now());
    if (at < this.clock.now() - 14 * 86_400_000 || at > this.clock.now() + 2 * 60 * 60_000) throw new AwsError("InvalidParameterValue", "Timestamp must be within two weeks in the past and two hours in the future");
    const storageResolution = Number(input?.StorageResolution ?? 60); if (storageResolution !== 1 && storageResolution !== 60) throw new AwsError("InvalidParameterValue", "StorageResolution must be 1 or 60");
    const forms = [input?.Value !== undefined, input?.StatisticValues !== undefined, input?.Values !== undefined].filter(Boolean).length; if (forms !== 1) throw new AwsError("InvalidParameterCombination", "Specify exactly one of Value, StatisticValues, or Values");
    let sampleCount: number; let sum: number; let minimum: number; let maximum: number; let raw: RawValue[] | undefined;
    if (input.Value !== undefined) { const value = validValue(input.Value, "Value"); sampleCount = 1; sum = minimum = maximum = value; raw = [{ value, count: 1 }]; }
    else if (input.StatisticValues !== undefined) {
      const stats = input.StatisticValues; sampleCount = number(stats.SampleCount, "SampleCount"); sum = validValue(stats.Sum, "Sum"); minimum = validValue(stats.Minimum, "Minimum"); maximum = validValue(stats.Maximum, "Maximum");
      if (sampleCount <= 0 || minimum > maximum) throw new AwsError("InvalidParameterValue", "StatisticValues are invalid");
      if ((sampleCount === 1 && minimum === maximum && sum === minimum) || (minimum === maximum && sum === minimum * sampleCount)) raw = [{ value: minimum, count: sampleCount }];
    } else {
      const values = list<any>(input.Values).map((value, index) => validValue(value, `Values.member.${index + 1}`)); if (!values.length || values.length > 150) throw new AwsError("InvalidParameterValue", "Values must contain between 1 and 150 entries");
      const counts = input.Counts === undefined ? values.map(() => 1) : list<any>(input.Counts).map((value, index) => number(value, `Counts.member.${index + 1}`)); if (counts.length !== values.length || counts.some(value => value <= 0)) throw new AwsError("InvalidParameterValue", "Counts must contain one positive value for every Values entry");
      raw = values.map((value, index) => ({ value, count: counts[index] })); sampleCount = counts.reduce((a, b) => a + b, 0); sum = raw.reduce((total, item) => total + item.value * item.count, 0); minimum = Math.min(...values); maximum = Math.max(...values);
    }
    return { namespace, metricName, dimensions: metricDimensions, unit, storageResolution: storageResolution as 1 | 60, resolution: storageResolution as 1 | 60, timestamp: at, sampleCount, sum, minimum, maximum, ...(raw ? { raw } : {}) };
  }

  private async append(points: MetricPoint[]): Promise<void> { this.writes = this.writes.catch(() => undefined).then(async () => { for (const point of points) await this.segments.append(point); await this.metricStreams.deliver(points); }); await this.writes; }
  private async all(): Promise<MetricPoint[]> { await this.writes; return [...await this.segments.readAll(), ...this.telemetryBuckets.values()]; }
  private async metricSnapshot(queries: any[], start: number, end: number): Promise<MetricPoint[]> {
    const identities = new Set<string>();
    for (const query of queries) {
      if (query.MetricStat?.Metric) identities.add(`${String(query.MetricStat.Metric.Namespace ?? "")}\0${String(query.MetricStat.Metric.MetricName ?? "")}`);
      else if (/^\s*SELECT\b/i.test(String(query.Expression ?? ""))) try { const parsed = new MetricsInsightsParser(String(query.Expression), this.state.accountId).parse(); identities.add(`${parsed.namespace}\0${parsed.metricName}`); } catch {}
    }
    if (!identities.size) return [];
    const namespaceTokens = [...new Set([...identities].map(identity => `"namespace":${JSON.stringify(identity.split("\0")[0])}`))];
    await this.writes;
    const candidates = [...await this.segments.readMatching(serialized => namespaceTokens.some(token => serialized.includes(token))), ...this.telemetryBuckets.values()];
    return candidates.filter(point => point.timestamp >= start && point.timestamp < end && identities.has(`${point.namespace}\0${point.metricName}`));
  }

  private async managedContributorObservations(resourceArn: string, templateName: string, start: number, end: number): Promise<ManagedContributorResult> {
    const match = resourceArn.match(/:table\/([^/]+)(?:\/index\/([^/]+))?$/); if (!match) return { keyLabels: [], observations: [] }; const table = this.state.regionState(this.region).tables[match[1]]; const index = match[2] ? table?.globalSecondaryIndexes?.find(candidate => candidate.indexName === match[2]) : undefined; const schema = index?.keySchema ?? table?.keySchema ?? []; const keyType = templateName.endsWith("SKC") || templateName.endsWith("SKT") ? "RANGE" : "HASH"; const keyLabel = schema.find(key => key.KeyType === keyType)?.AttributeName; if (!table || !keyLabel) return { keyLabels: [], observations: [] }; const metricName = templateName.endsWith("C") ? "AccessFrequency" : "ThrottleFrequency"; const observations = (await this.all()).flatMap(point => {
      const observedAt = point.lastTimestamp ?? point.timestamp; if (point.namespace !== "StackSim/DynamoDBContributorInsights" || point.metricName !== metricName || observedAt < start || observedAt >= end) return []; const dimensions = Object.fromEntries(point.dimensions.map(dimension => [dimension.Name, dimension.Value])); if (dimensions.TableName !== table.name || (index ? dimensions.GlobalSecondaryIndexName !== index.indexName : dimensions.GlobalSecondaryIndexName !== undefined) || !dimensions.ContributorKey) return []; const keys = decodeDynamoContributorKey(dimensions.ContributorKey, schema, templateName); return keys ? [{ timestamp: observedAt, keys, value: point.sum }] : [];
    }); return { keyLabels: [keyLabel], observations };
  }

  async compactNow(): Promise<void> {
    this.writes = this.writes.catch(() => undefined).then(async () => {
      const now = this.clock.now(); const groups = new Map<string, MetricPoint>();
      for await (const point of this.segments.iterate()) {
        const age = now - point.timestamp; if (age > this.retention.totalMs) continue;
        const desired: MetricPoint["resolution"] = age > this.retention.fiveMinuteMs ? 3600 : age > this.retention.minuteMs ? 300 : point.resolution === 1 && age > this.retention.highResolutionMs ? 60 : point.resolution;
        const bucket = Math.floor(point.timestamp / (desired * 1000)) * desired * 1000; const key = `${metricKey(point)}\0${point.unit}\0${desired}\0${bucket}`;
        const retainRaw = point.storageResolution === desired && point.resolution === desired; const normalized: MetricPoint = { ...point, timestamp: bucket, resolution: desired, rollup: true, ...(!retainRaw ? { raw: undefined } : point.raw ? { raw: consolidateRaw(point.raw) } : {}) };
        const current = groups.get(key);
        if (!current) groups.set(key, normalized);
        else { const merged = mergePoints([current, normalized], bucket, point.unit); const retainsObservationRange = current.firstTimestamp !== undefined || current.lastTimestamp !== undefined || normalized.firstTimestamp !== undefined || normalized.lastTimestamp !== undefined; groups.set(key, { ...current, ...merged, ...(retainsObservationRange ? { firstTimestamp: Math.min(current.firstTimestamp ?? current.timestamp, normalized.firstTimestamp ?? normalized.timestamp), lastTimestamp: Math.max(current.lastTimestamp ?? current.timestamp, normalized.lastTimestamp ?? normalized.timestamp) } : {}), raw: merged.raw ? consolidateRaw(merged.raw) : undefined }); }
      }
      await this.segments.compact([...groups.values()].sort((a, b) => a.timestamp - b.timestamp || metricKey(a).localeCompare(metricKey(b))));
    });
    await this.writes;
  }

  async ListMetrics(input: any): Promise<any> {
    const namespace = input.Namespace === undefined ? undefined : validName(input.Namespace, "Namespace"); const metricName = input.MetricName === undefined ? undefined : validName(input.MetricName, "MetricName"); const filters = dimensions(input.Dimensions, true);
    if (input.RecentlyActive !== undefined && input.RecentlyActive !== "PT3H") throw new AwsError("InvalidParameterValue", "RecentlyActive must be PT3H");
    if (input.OwningAccount !== undefined || input.IncludeLinkedAccounts === true) throw new AwsError("InvalidParameterValue", "Cross-account observability is not available in the single-account simulator");
    const cutoff = this.clock.now() - (input.RecentlyActive === "PT3H" ? 3 * 60 * 60_000 : 14 * 86_400_000); const latest = new Map<string, MetricPoint>();
    for (const point of await this.all()) if (point.timestamp >= cutoff && (!namespace || point.namespace === namespace) && (!metricName || point.metricName === metricName) && filters.every(filter => point.dimensions.some(item => item.Name === filter.Name && (!filter.Value || item.Value === filter.Value)))) { const key = metricKey(point); if (!latest.has(key) || latest.get(key)!.timestamp < point.timestamp) latest.set(key, point); }
    const metrics = [...latest.values()].sort((a, b) => metricKey(a).localeCompare(metricKey(b))); const signature = createHash("sha256").update(canonical({ namespace, metricName, filters, RecentlyActive: input.RecentlyActive })).digest("hex"); let index = 0;
    if (input.NextToken) try { const cursor = this.tokens.decode<{ index: number; signature: string }>("ListMetrics", input.NextToken); if (cursor.signature !== signature) throw new Error(); index = cursor.index; } catch { throw new AwsError("InvalidParameterValue", "The next token is invalid"); }
    const page = metrics.slice(index, index + 500); const next = index + page.length;
    return { Metrics: page.map(point => ({ Namespace: point.namespace, MetricName: point.metricName, Dimensions: point.dimensions })), ...(next < metrics.length ? { NextToken: this.tokens.encode("ListMetrics", { index: next, signature }) } : {}) };
  }

  private queryPoints(input: any): { points: MetricPoint[]; namespace: string; metricName: string; dimensions: Dimension[]; start: number; end: number; period: number; unit?: string } {
    const namespace = validName(input.Namespace, "Namespace"); const metricName = validName(input.MetricName, "MetricName"); const metricDimensions = dimensions(input.Dimensions); const start = timestamp(input.StartTime); const end = timestamp(input.EndTime); const period = number(input.Period, "Period");
    if (start >= end) throw new AwsError("InvalidParameterValue", "StartTime must be before EndTime"); if (!Number.isInteger(period) || !([1, 5, 10, 20, 30].includes(period) || period % 60 === 0)) throw new AwsError("InvalidParameterValue", "Period must be 1, 5, 10, 20, 30, or a multiple of 60 seconds");
    const unit = input.Unit === undefined ? undefined : validUnit(input.Unit); return { points: [], namespace, metricName, dimensions: metricDimensions, start, end, period, unit };
  }

  private async aggregate(input: any, points?: MetricPoint[]): Promise<{ aggregates: Aggregate[]; query: ReturnType<CloudWatchMetricsService["queryPoints"]> }> {
    const query = this.queryPoints(input); const matching = (points ?? await this.all()).filter(point => point.namespace === query.namespace && point.metricName === query.metricName && sameDimensions(point.dimensions, query.dimensions) && point.timestamp >= query.start && point.timestamp < query.end && point.resolution <= query.period && (!query.unit || point.unit === query.unit));
    const buckets = new Map<string, MetricPoint[]>(); for (const point of matching) { const at = Math.floor(point.timestamp / (query.period * 1000)) * query.period * 1000; const key = `${at}\0${point.unit}`; const values = buckets.get(key) ?? []; values.push(point); buckets.set(key, values); }
    return { query, aggregates: [...buckets.entries()].map(([key, points]) => mergePoints(points, Number(key.split("\0")[0]), points[0].unit)).sort((a, b) => a.timestamp - b.timestamp || a.unit.localeCompare(b.unit)) };
  }

  async GetMetricStatistics(input: any): Promise<any> {
    const statistics = list<string>(input.Statistics); const extended = list<string>(input.ExtendedStatistics); if ((!statistics.length && !extended.length) || (statistics.length && extended.length)) throw new AwsError("InvalidParameterCombination", "Specify either Statistics or ExtendedStatistics");
    if (statistics.length > 5 || statistics.some(item => !STATISTICS.has(item))) throw new AwsError("InvalidParameterValue", "Invalid statistics"); if (extended.length > 10 || extended.some(item => percentileName(item) === undefined)) throw new AwsError("InvalidParameterValue", "Invalid extended statistic");
    const { aggregates, query } = await this.aggregate(input); if (Math.ceil((query.end - query.start) / (query.period * 1000)) > 1_440) throw new AwsError("InvalidParameterValue", "The request would return more than 1440 data points");
    const Datapoints = aggregates.map(item => ({ Timestamp: new Date(item.timestamp), Unit: item.unit, ...Object.fromEntries(statistics.map(stat => [stat, stat === "SampleCount" ? item.sampleCount : stat === "Sum" ? item.sum : stat === "Minimum" ? item.minimum : stat === "Maximum" ? item.maximum : item.sum / item.sampleCount])), ...(extended.length ? { ExtendedStatistics: awsQueryMap(Object.fromEntries(extended.flatMap(stat => { const value = item.raw && percentile(item.raw, percentileName(stat)!); return value === undefined ? [] : [[stat, value]]; }))) } : {}) }));
    return { Label: query.metricName, Datapoints };
  }

  private async series(metricStat: any, start: number, end: number, points?: MetricPoint[]): Promise<Series> {
    if (!metricStat?.Metric) throw new AwsError("InvalidParameterValue", "MetricStat.Metric is required"); const stat = String(metricStat.Stat ?? ""); if (!STATISTICS.has(stat) && percentileName(stat) === undefined) throw new AwsError("InvalidParameterValue", "MetricStat.Stat is invalid");
    const { aggregates, query } = await this.aggregate({ ...metricStat.Metric, Period: metricStat.Period, Unit: metricStat.Unit, StartTime: new Date(start), EndTime: new Date(end) }, points); const values = new Map<number, number>();
    for (const item of aggregates) { const value = stat === "SampleCount" ? item.sampleCount : stat === "Sum" ? item.sum : stat === "Minimum" ? item.minimum : stat === "Maximum" ? item.maximum : stat === "Average" ? item.sum / item.sampleCount : item.raw ? percentile(item.raw, percentileName(stat)!) : undefined; if (value !== undefined) values.set(item.timestamp, value); }
    return { values, period: query.period };
  }

  private async alarmSeries(metricStat: any, start: number, end: number): Promise<AlarmSeries> {
    if (!metricStat?.Metric) throw new AwsError("InvalidParameterValue", "MetricStat.Metric is required"); const stat = String(metricStat.Stat ?? ""); if (!STATISTICS.has(stat) && percentileName(stat) === undefined) throw new AwsError("InvalidParameterValue", "MetricStat.Stat is invalid");
    const { aggregates, query } = await this.aggregate({ ...metricStat.Metric, Period: metricStat.Period, Unit: metricStat.Unit, StartTime: new Date(start), EndTime: new Date(end) }); const values = new Map<number, number>(); const sampleCounts = new Map<number, number>();
    for (const item of aggregates) { const value = stat === "SampleCount" ? item.sampleCount : stat === "Sum" ? item.sum : stat === "Minimum" ? item.minimum : stat === "Maximum" ? item.maximum : stat === "Average" ? item.sum / item.sampleCount : item.raw ? percentile(item.raw, percentileName(stat)!) : undefined; if (value !== undefined) { values.set(item.timestamp, value); sampleCounts.set(item.timestamp, item.sampleCount); } }
    return { values, sampleCounts, period: query.period };
  }

  async evaluateAlarmsNow(at = this.clock.now()): Promise<void> { await this.alarms.evaluateNow(at); }

  private insightsLabel(point: MetricPoint, label: string): string | undefined { if (label === "AWS.AccountId") return this.state.accountId; return point.dimensions.find(dimension => dimension.Name === label)?.Value; }
  private insightsValue(points: MetricPoint[], aggregate: InsightsQuery["aggregate"]): number {
    if (aggregate === "COUNT") return points.reduce((sum, point) => sum + point.sampleCount, 0);
    if (aggregate === "SUM") return points.reduce((sum, point) => sum + point.sum, 0);
    if (aggregate === "MIN") return Math.min(...points.map(point => point.minimum));
    if (aggregate === "MAX") return Math.max(...points.map(point => point.maximum));
    const count = points.reduce((sum, point) => sum + point.sampleCount, 0); return points.reduce((sum, point) => sum + point.sum, 0) / count;
  }
  private insightsOrder(series: Series, aggregate: InsightsQuery["aggregate"]): number {
    const values = [...series.values.values()]; if (!values.length) return Number.NEGATIVE_INFINITY; if (aggregate === "COUNT") return values.length; if (aggregate === "SUM") return values.reduce((sum, value) => sum + value, 0); if (aggregate === "MIN") return Math.min(...values); if (aggregate === "MAX") return Math.max(...values); return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  private async metricsInsights(expression: string, period: unknown, start: number, end: number, snapshotPoints?: MetricPoint[]): Promise<MathValue[]> {
    if (Buffer.byteLength(expression) > 2_048) throw new AwsError("InvalidParameterValue", "Metrics Insights query must not exceed 2048 bytes"); const seconds = number(period, "Period"); if (!Number.isInteger(seconds) || seconds < 60 || seconds % 60 !== 0) throw new AwsError("InvalidParameterValue", "Metrics Insights Period must be a multiple of 60 seconds"); if (end - start > 3 * 60 * 60_000 || start < this.clock.now() - 3 * 60 * 60_000) throw new AwsError("InvalidParameterValue", "Metrics Insights GetMetricData queries are limited to the most recent three hours");
    const query = new MetricsInsightsParser(expression, this.state.accountId).parse(); const schemaNames = query.schemaDimensions?.slice().sort(); const all = (snapshotPoints ?? await this.all()).filter(point => point.namespace === query.namespace && point.metricName === query.metricName && point.timestamp >= start && point.timestamp < end && point.resolution <= seconds && (!schemaNames || point.dimensions.map(dimension => dimension.Name).sort().join("\0") === schemaNames.join("\0")) && query.filters.every(filter => { const value = this.insightsLabel(point, filter.label); return value !== undefined && (filter.operator === "=" ? value === filter.value : value !== filter.value); }));
    const identityKeys = [...new Set(all.map(metricKey))].sort().slice(0, 10_000); const selected = new Set(identityKeys); const points = all.filter(point => selected.has(metricKey(point))); const grouped = new Map<string, { labels: string[]; points: MetricPoint[] }>();
    for (const point of points) { const labels = query.groupBy.map(label => this.insightsLabel(point, label) ?? "Other"); const key = labels.join("\0"); const group = grouped.get(key) ?? { labels, points: [] }; group.points.push(point); grouped.set(key, group); }
    if (!query.groupBy.length && !grouped.size) grouped.set("", { labels: [], points: [] });
    let results = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => { const buckets = new Map<number, MetricPoint[]>(); for (const point of group.points) { const at = Math.floor(point.timestamp / (seconds * 1000)) * seconds * 1000; const values = buckets.get(at) ?? []; values.push(point); buckets.set(at, values); } const values = new Map([...buckets.entries()].sort(([left], [right]) => left - right).map(([at, values]) => [at, this.insightsValue(values, query.aggregate)])); const suffix = group.labels.map((value, index) => `${query.groupBy[index]}=${value}`).join(", "); return { kind: "series" as const, series: { values, period: seconds, ...(suffix ? { labelSuffix: suffix } : {}) } }; });
    if (query.orderBy) results.sort((left, right) => { const difference = this.insightsOrder(left.series, query.orderBy!.aggregate) - this.insightsOrder(right.series, query.orderBy!.aggregate); return (query.orderBy!.direction === "DESC" ? -difference : difference) || String(left.series.labelSuffix ?? "").localeCompare(String(right.series.labelSuffix ?? "")); });
    return results.slice(0, query.limit);
  }

  private anomalyBand(source: Series, deviations: number, queries: any[]): MathValue[] {
    const sourceQuery = queries.find(query => query.Id === source.sourceId); const model = this.anomalies.modelFor(source.sourceId, sourceQuery, queries); const excluded = model?.configuration.excludedTimeRanges ?? []; const timezone = model?.configuration.metricTimezone ?? "UTC"; const spikeFactor = model?.metricCharacteristics?.PeriodicSpikes ? 1.5 : 1;
    const points = [...source.values.entries()].filter(([, value]) => Number.isFinite(value)).sort((a, b) => a[0] - b[0]); const eligible = points.filter(([at]) => !excluded.some(range => at >= range.StartTime && at < range.EndTime)); const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", hourCycle: "h23" });
    const slot = (at: number) => formatter.format(new Date(at)); const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }; const lower = new Map<number, number>(); const upper = new Map<number, number>();
    for (const [at] of points) {
      const prior = eligible.filter(([time]) => time < at); const seasonal = prior.filter(([time]) => slot(time) === slot(at)); let training = seasonal.length >= 3 ? seasonal : prior; if (training.length < 3) training = eligible.filter(([time]) => time !== at); if (!training.length) training = eligible.length ? eligible : points;
      const values = training.map(([, value]) => value); const center = median(values); const mad = median(values.map(value => Math.abs(value - center))); const sigma = Math.max(mad * 1.4826, Math.abs(center) * 0.05, 0.5); const width = deviations * spikeFactor * sigma; const floor = values.every(value => value >= 0) ? 0 : Number.NEGATIVE_INFINITY; lower.set(at, Math.max(floor, center - width)); upper.set(at, center + width);
    }
    return [{ kind: "series", series: { values: lower, period: source.period, labelSuffix: "lower" } }, { kind: "series", series: { values: upper, period: source.period, labelSuffix: "upper" } }];
  }

  async GetMetricData(input: any): Promise<any> {
    const start = timestamp(input.StartTime); const end = timestamp(input.EndTime); if (start >= end) throw new AwsError("InvalidParameterValue", "StartTime must be before EndTime"); const queries = list<any>(input.MetricDataQueries); if (!queries.length || queries.length > 500) throw new AwsError("InvalidParameterValue", "MetricDataQueries must contain between 1 and 500 entries");
    if (queries.filter(query => /^\s*SELECT\b/i.test(String(query?.Expression ?? ""))).length > 1) throw new AwsError("InvalidParameterValue", "A GetMetricData request can include only one Metrics Insights query");
    const byId = new Map<string, any>(); for (const query of queries) { if (!/^[a-z][A-Za-z0-9_]{0,254}$/.test(query.Id ?? "") || byId.has(query.Id)) throw new AwsError("InvalidParameterValue", "Metric data query IDs must be unique and start with a lowercase letter"); if (Boolean(query.MetricStat) === Boolean(query.Expression)) throw new AwsError("InvalidParameterCombination", "Each query must contain exactly one MetricStat or Expression"); if (query.AccountId !== undefined) throw new AwsError("InvalidParameterValue", "Cross-account metric queries are not available"); byId.set(query.Id, query); }
    let snapshotPromise: Promise<MetricPoint[]> | undefined; const snapshot = () => snapshotPromise ??= this.metricSnapshot(queries, start, end);
    const resolved = new Map<string, ParsedValue>(); const resolving = new Set<string>();
    const resolve = async (id: string): Promise<ParsedValue> => {
      if (resolved.has(id)) return resolved.get(id)!; const query = byId.get(id); if (!query || resolving.has(id)) throw new AwsError("InvalidParameterValue", `Unknown or circular metric math reference ${id}`); resolving.add(id);
      let result: ParsedValue;
      if (query.MetricStat) result = { kind: "series", series: { ...(await this.series(query.MetricStat, start, end, await snapshot())), sourceId: id } };
      else {
        const expression = String(query.Expression); if (/^\s*SELECT\b/i.test(expression)) result = await this.metricsInsights(expression, query.Period, start, end, await snapshot());
        else { const identifiers = [...new Set(expression.match(/[a-z][A-Za-z0-9_]*/g) ?? [])].filter(value => !["SUM", "AVG", "MIN", "MAX", "FILL", "ANOMALY_DETECTION_BAND"].includes(value.toUpperCase())); for (const dependency of identifiers) if (dependency !== id) await resolve(dependency); const tokens = expression.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[+\-*/(),\[\]]/g) ?? []; const parser = new MetricMathParser(tokens, identifier => { const value = resolved.get(identifier); if (!value) throw new AwsError("InvalidParameterValue", `Unknown metric math reference ${identifier}`); return value; }, start, end, (series, width) => this.anomalyBand(series, width, queries)); result = parser.parse(); }
        if (!Array.isArray(result) && result.kind !== "series") throw new AwsError("InvalidParameterValue", "A returned metric math expression must produce a time series"); if (Array.isArray(result)) result.forEach(value => { if (value.kind !== "series") throw new AwsError("InvalidParameterValue", "A returned metric math array must contain only time series"); }); else result.series.sourceId = id;
      }
      resolving.delete(id); resolved.set(id, result); return result;
    };
    for (const query of queries) await resolve(query.Id);
    const descending = input.ScanBy !== "TimestampAscending"; if (input.ScanBy !== undefined && !["TimestampAscending", "TimestampDescending"].includes(input.ScanBy)) throw new AwsError("InvalidParameterValue", "ScanBy is invalid");
    const outputs = queries.filter(query => query.ReturnData !== false).flatMap(query => { const value = resolved.get(query.Id)!; const seriesValues = Array.isArray(value) ? value : [value]; return seriesValues.map(item => { if (item.kind !== "series") throw new AwsError("InvalidParameterValue", "Returned metric data must be a time series"); const points = [...item.series.values.entries()].sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]); const base = query.Label ?? (query.MetricStat ? query.MetricStat.Metric.MetricName : query.Expression); const label = item.series.labelSuffix ? `${base} (${item.series.labelSuffix})` : base; return { Id: query.Id, Label: label, StatusCode: "Complete", points }; }); });
    const signature = createHash("sha256").update(canonical(input)).digest("hex"); let offset = 0; if (input.NextToken) try { const cursor = this.tokens.decode<{ offset: number; signature: string }>("GetMetricData", input.NextToken); if (cursor.signature !== signature) throw new Error(); offset = cursor.offset; } catch { throw new AwsError("InvalidNextToken", "The next token is invalid"); }
    const max = input.MaxDatapoints === undefined ? 100_800 : number(input.MaxDatapoints, "MaxDatapoints"); if (!Number.isInteger(max) || max < 1 || max > 100_800) throw new AwsError("InvalidParameterValue", "MaxDatapoints must be between 1 and 100800"); const total = outputs.reduce((sum, output) => sum + output.points.length, 0); let skip = offset; let remaining = max;
    const MetricDataResults = outputs.map(output => { const startAt = Math.min(skip, output.points.length); skip -= startAt; const selected = output.points.slice(startAt, startAt + remaining); remaining -= selected.length; return { Id: output.Id, Label: output.Label, StatusCode: output.StatusCode, Timestamps: selected.map(([time]) => new Date(time)), Values: selected.map(([, value]) => value) }; }); const consumed = Math.min(max, Math.max(0, total - offset));
    return { MetricDataResults, ...(offset + consumed < total ? { NextToken: this.tokens.encode("GetMetricData", { offset: offset + consumed, signature }) } : {}) };
  }
}
