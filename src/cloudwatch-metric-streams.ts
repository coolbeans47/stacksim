import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import { AwsError } from "./errors.js";
import type { StateStore } from "./state.js";
import type { CloudWatchMetricStreamFilterState, CloudWatchMetricStreamState, CloudWatchMetricStreamStatisticsConfigurationState } from "./types.js";

export const CLOUDWATCH_METRIC_STREAM_ACTIONS = ["PutMetricStream", "GetMetricStream", "ListMetricStreams", "DeleteMetricStream", "StartMetricStreams", "StopMetricStreams"] as const;

export interface MetricStreamPoint {
  namespace: string;
  metricName: string;
  dimensions: Array<{ Name: string; Value: string }>;
  unit: string;
  timestamp: number;
  sampleCount: number;
  sum: number;
  minimum: number;
  maximum: number;
  raw?: Array<{ value: number; count: number }>;
}

function list<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function printable(value: unknown, label: string): string {
  const result = String(value ?? "");
  if (!result || result.length > 255 || !result.trim() || /[^\x20-\x7e]/.test(result)) throw new AwsError("InvalidParameterValue", `${label} must contain 1-255 printable ASCII characters`);
  return result;
}
function streamName(value: unknown): string {
  const result = String(value ?? "");
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(result)) throw new AwsError("InvalidParameterValue", "Metric stream Name must contain 1-255 letters, numbers, hyphens, or underscores");
  return result;
}
function tags(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}; const values = list<any>(value);
  if (values.length > 50) throw new AwsError("LimitExceeded", "A maximum of 50 tags is allowed");
  for (const item of values) {
    const key = String(item?.Key ?? ""); const tagValue = String(item?.Value ?? "");
    if (!key || key.length > 128 || key.startsWith("aws:") || /[\x00-\x1f]/.test(key) || tagValue.length > 256 || /[\x00-\x1f]/.test(tagValue)) throw new AwsError("InvalidParameterValue", "Metric stream tag is invalid");
    if (Object.hasOwn(result, key)) throw new AwsError("InvalidParameterValue", `Duplicate tag key ${key}`);
    result[key] = tagValue;
  }
  return result;
}
function filters(value: unknown): CloudWatchMetricStreamFilterState[] {
  const result = list<any>(value).map(item => {
    const Namespace = printable(item?.Namespace, "Metric stream filter Namespace"); if (Namespace.startsWith(":")) throw new AwsError("InvalidParameterValue", "Metric stream filter Namespace must not start with a colon");
    const MetricNames = list<any>(item?.MetricNames).map(name => printable(name, "Metric stream filter MetricName"));
    if (new Set(MetricNames).size !== MetricNames.length) throw new AwsError("InvalidParameterValue", `Metric stream filter ${Namespace} contains duplicate metric names`);
    return { Namespace, ...(MetricNames.length ? { MetricNames: [...MetricNames].sort() } : {}) };
  });
  if (new Set(result.map(item => item.Namespace)).size !== result.length) throw new AwsError("InvalidParameterValue", "Metric stream filters must use unique namespaces");
  const totalNames = result.reduce((count, item) => count + 1 + (item.MetricNames?.length ?? 0), 0); if (totalNames > 1_000) throw new AwsError("InvalidParameterValue", "Metric stream filters support at most 1000 total namespace and metric names");
  return result.sort((left, right) => left.Namespace.localeCompare(right.Namespace));
}
function statistics(value: unknown, outputFormat: string): CloudWatchMetricStreamStatisticsConfigurationState[] {
  const configurations = list<any>(value); if (configurations.length > 100) throw new AwsError("InvalidParameterValue", "StatisticsConfigurations supports at most 100 entries"); const configured = new Set<string>();
  return configurations.map(configuration => {
    const IncludeMetrics = list<any>(configuration?.IncludeMetrics).map(item => ({ Namespace: printable(item?.Namespace, "Statistics Namespace"), MetricName: printable(item?.MetricName, "Statistics MetricName") }));
    if (!IncludeMetrics.length || IncludeMetrics.length > 100) throw new AwsError("InvalidParameterValue", "Each statistics configuration requires 1-100 metrics");
    for (const metric of IncludeMetrics) { if (metric.Namespace.startsWith(":")) throw new AwsError("InvalidParameterValue", "Statistics Namespace must not start with a colon"); const key = `${metric.Namespace}\0${metric.MetricName}`; if (configured.has(key)) throw new AwsError("InvalidParameterValue", "A metric can appear in only one statistics configuration"); configured.add(key); }
    const AdditionalStatistics = list<any>(configuration?.AdditionalStatistics).map(String); if (!AdditionalStatistics.length || AdditionalStatistics.length > 20 || new Set(AdditionalStatistics).size !== AdditionalStatistics.length) throw new AwsError("InvalidParameterValue", "Each statistics configuration requires 1-20 unique additional statistics");
    if (AdditionalStatistics.some(item => percentileValue(item) === undefined)) throw new AwsError("InvalidParameterValue", `${outputFormat} local metric streams currently support percentile additional statistics such as p90 and p99.9`);
    return { IncludeMetrics: IncludeMetrics.sort((left, right) => left.Namespace.localeCompare(right.Namespace) || left.MetricName.localeCompare(right.MetricName)), AdditionalStatistics };
  });
}
function percentileValue(name: string): number | undefined { const match = name.match(/^p(100(?:\.0{1,10})?|\d{1,2}(?:\.\d{1,10})?)$/i); if (!match) return undefined; const value = Number(match[1]); return value >= 0 && value <= 100 ? value : undefined; }
function percentile(raw: Array<{ value: number; count: number }>, requested: number): number | undefined {
  if (!raw.length || raw.some(item => item.value < 0 || item.count <= 0)) return undefined; const sorted = [...raw].sort((left, right) => left.value - right.value); const total = sorted.reduce((sum, item) => sum + item.count, 0); if (total <= 0) return undefined; const rank = requested === 0 ? 1 : Math.ceil(requested / 100 * total); let current = 0; for (const item of sorted) { current += item.count; if (current >= rank) return item.value; } return sorted.at(-1)?.value;
}

export class CloudWatchMetricStreamEngine {
  private readonly tokens: PaginationTokens;
  constructor(private readonly store: StateStore, private readonly region: string, private readonly clock: Clock, private readonly allowLocalFiles = false) { this.tokens = new PaginationTokens(store.state.installation.paginationSecret); }
  private get control(): Record<string, CloudWatchMetricStreamState> { return this.store.regionState(this.region).cloudwatch.metricStreams; }
  private arn(name: string): string { return `arn:aws:cloudwatch:${this.region}:${this.store.accountId}:metric-stream/${name}`; }
  private require(value: unknown): CloudWatchMetricStreamState { const name = streamName(value); const stream = this.control[name]; if (!stream) throw new AwsError("ResourceNotFoundException", `Metric stream ${name} does not exist`, 404); return stream; }
  private localTarget(value: string, name: string, outputFormat: string): string | undefined {
    if (!value.startsWith("file://")) return undefined; if (!this.allowLocalFiles) throw new AwsError("InvalidParameterValue", "Local metric stream delivery requires STACKSIM_ALLOW_LOCAL_FILES=true"); if (outputFormat !== "json") throw new AwsError("InvalidParameterCombination", "The local file extension supports the JSON metric stream format; OpenTelemetry protobuf delivery remains dependency-blocked");
    let directory: string; try { const url = new URL(value); if (url.protocol !== "file:" || url.search || url.hash) throw new Error(); directory = resolve(fileURLToPath(url)); } catch { throw new AwsError("InvalidParameterValue", "Local metric stream FirehoseArn must be an absolute file:// directory URL"); }
    return join(directory, `${name}.jsonl`);
  }
  private validateFirehoseArn(value: string): void { const match = value.match(/^arn:(?:aws|aws-us-gov|aws-cn):firehose:([^:]+):(\d{12}):deliverystream\/[A-Za-z0-9_.-]{1,64}$/); if (!match || match[1] !== this.region || match[2] !== this.store.accountId) throw new AwsError("InvalidParameterValue", "FirehoseArn must identify a same-account, same-Region delivery stream or an opted-in file:// directory"); }
  private validateRoleArn(value: string): void { const match = value.match(/^arn:(?:aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/.+$/); if (!match || match[1] !== this.store.accountId || value.length > 1_024) throw new AwsError("InvalidParameterValue", "RoleArn must identify an IAM role in this simulator account"); }
  private view(stream: CloudWatchMetricStreamState): any { return { Arn: stream.arn, Name: stream.name, ...(stream.includeFilters ? { IncludeFilters: structuredClone(stream.includeFilters) } : {}), ...(stream.excludeFilters ? { ExcludeFilters: structuredClone(stream.excludeFilters) } : {}), FirehoseArn: stream.firehoseArn, RoleArn: stream.roleArn, State: stream.state, CreationDate: new Date(stream.creationDate), LastUpdateDate: new Date(stream.lastUpdateDate), OutputFormat: stream.outputFormat, ...(stream.statisticsConfigurations.length ? { StatisticsConfigurations: structuredClone(stream.statisticsConfigurations) } : {}), IncludeLinkedAccountsMetrics: stream.includeLinkedAccountsMetrics }; }
  async PutMetricStream(input: any): Promise<{ Arn: string }> {
    const name = streamName(input.Name); const outputFormat = String(input.OutputFormat ?? ""); if (!new Set(["json", "opentelemetry0.7", "opentelemetry1.0"]).has(outputFormat)) throw new AwsError("InvalidParameterValue", "OutputFormat must be json, opentelemetry0.7, or opentelemetry1.0");
    if (input.IncludeFilters !== undefined && input.ExcludeFilters !== undefined) throw new AwsError("InvalidParameterCombination", "IncludeFilters and ExcludeFilters cannot be specified together"); const includeFilters = input.IncludeFilters === undefined ? undefined : filters(input.IncludeFilters); const excludeFilters = input.ExcludeFilters === undefined ? undefined : filters(input.ExcludeFilters);
    const firehoseArn = String(input.FirehoseArn ?? ""); if (!firehoseArn) throw new AwsError("MissingParameter", "FirehoseArn is required"); const localFilePath = this.localTarget(firehoseArn, name, outputFormat); if (!localFilePath) this.validateFirehoseArn(firehoseArn); const roleArn = String(input.RoleArn ?? ""); if (!roleArn) throw new AwsError("MissingParameter", "RoleArn is required"); this.validateRoleArn(roleArn);
    if (input.IncludeLinkedAccountsMetrics === true) throw new AwsError("InvalidParameterValue", "Linked-account metric streaming is unavailable in the single-account simulator"); const streamStatistics = statistics(input.StatisticsConfigurations, outputFormat); const previous = this.control[name]; const now = this.clock.now();
    this.control[name] = { name, arn: this.arn(name), ...(includeFilters ? { includeFilters } : {}), ...(excludeFilters ? { excludeFilters } : {}), firehoseArn, roleArn, outputFormat: outputFormat as CloudWatchMetricStreamState["outputFormat"], state: previous?.state ?? "running", statisticsConfigurations: streamStatistics, includeLinkedAccountsMetrics: false, tags: previous?.tags ?? tags(input.Tags), creationDate: previous?.creationDate ?? now, lastUpdateDate: now, destinationType: localFilePath ? "local-file" : "dependency-blocked", ...(localFilePath ? { localFilePath } : {}), deliveredRecords: previous?.deliveredRecords ?? 0, ...(previous?.lastDeliveryDate === undefined ? {} : { lastDeliveryDate: previous.lastDeliveryDate }), ...(previous?.lastDeliveryError === undefined ? {} : { lastDeliveryError: previous.lastDeliveryError }) };
    await this.store.save(); return { Arn: this.arn(name) };
  }
  async GetMetricStream(input: any): Promise<any> { return this.view(this.require(input.Name)); }
  async ListMetricStreams(input: any): Promise<any> {
    const max = input.MaxResults === undefined ? 500 : Number(input.MaxResults); if (!Number.isInteger(max) || max < 1 || max > 500) throw new AwsError("InvalidParameterValue", "MaxResults must be between 1 and 500"); let index = 0; if (input.NextToken) try { index = this.tokens.decode<{ index: number }>("ListMetricStreams", input.NextToken).index; } catch { throw new AwsError("InvalidNextToken", "The next token is invalid"); }
    const streams = Object.values(this.control).sort((left, right) => left.name.localeCompare(right.name)); const page = streams.slice(index, index + max); const next = index + page.length; return { Entries: page.map(stream => ({ Arn: stream.arn, CreationDate: new Date(stream.creationDate), LastUpdateDate: new Date(stream.lastUpdateDate), Name: stream.name, FirehoseArn: stream.firehoseArn, State: stream.state, OutputFormat: stream.outputFormat })), ...(next < streams.length ? { NextToken: this.tokens.encode("ListMetricStreams", { index: next }) } : {}) };
  }
  async DeleteMetricStream(input: any): Promise<Record<string, never>> { const name = streamName(input.Name); this.require(name); delete this.control[name]; await this.store.save(); return {}; }
  private async transition(input: any, state: "running" | "stopped"): Promise<Record<string, never>> { const names = list<any>(input.Names).map(streamName); if (!names.length) throw new AwsError("MissingParameter", "Names is required"); if (names.length > 255 || new Set(names).size !== names.length) throw new AwsError("InvalidParameterValue", "Names must contain 1-255 unique metric stream names"); const streams = names.map(name => this.require(name)); const now = this.clock.now(); for (const stream of streams) { stream.state = state; stream.lastUpdateDate = now; } await this.store.save(); return {}; }
  async StartMetricStreams(input: any): Promise<Record<string, never>> { return this.transition(input, "running"); }
  async StopMetricStreams(input: any): Promise<Record<string, never>> { return this.transition(input, "stopped"); }
  hasResourceArn(value: unknown): boolean { const arn = String(value ?? ""); return Object.values(this.control).some(stream => stream.arn === arn); }
  private resource(value: unknown): CloudWatchMetricStreamState { const arn = String(value ?? ""); const stream = Object.values(this.control).find(item => item.arn === arn); if (!stream) throw new AwsError("ResourceNotFound", `CloudWatch resource ${arn} does not exist`, 404); return stream; }
  async TagResource(input: any): Promise<Record<string, never>> { const stream = this.resource(input.ResourceARN); const next = { ...stream.tags, ...tags(input.Tags) }; if (Object.keys(next).length > 50) throw new AwsError("LimitExceeded", "A maximum of 50 tags is allowed"); stream.tags = next; await this.store.save(); return {}; }
  async UntagResource(input: any): Promise<Record<string, never>> { const stream = this.resource(input.ResourceARN); for (const key of list<any>(input.TagKeys).map(String)) delete stream.tags[key]; await this.store.save(); return {}; }
  async ListTagsForResource(input: any): Promise<any> { const stream = this.resource(input.ResourceARN); return { Tags: Object.entries(stream.tags).sort(([left], [right]) => left.localeCompare(right)).map(([Key, Value]) => ({ Key, Value })) }; }
  private selected(stream: CloudWatchMetricStreamState, point: MetricStreamPoint): boolean { const matches = (filter: CloudWatchMetricStreamFilterState) => filter.Namespace === point.namespace && (!filter.MetricNames?.length || filter.MetricNames.includes(point.metricName)); if (stream.includeFilters) return stream.includeFilters.some(matches); if (stream.excludeFilters) return !stream.excludeFilters.some(matches); return true; }
  private additional(stream: CloudWatchMetricStreamState, point: MetricStreamPoint): Record<string, number> { const configuration = stream.statisticsConfigurations.find(item => item.IncludeMetrics.some(metric => metric.Namespace === point.namespace && metric.MetricName === point.metricName)); if (!configuration || !point.raw) return {}; return Object.fromEntries(configuration.AdditionalStatistics.flatMap(name => { const requested = percentileValue(name); const value = requested === undefined ? undefined : percentile(point.raw!, requested); return value === undefined ? [] : [[name, value]]; })); }
  private envelope(stream: CloudWatchMetricStreamState, point: MetricStreamPoint): string { return JSON.stringify({ metric_stream_name: stream.name, account_id: this.store.accountId, region: this.region, namespace: point.namespace, metric_name: point.metricName, dimensions: Object.fromEntries(point.dimensions.map(item => [item.Name, item.Value])), timestamp: point.timestamp, value: { count: point.sampleCount, sum: point.sum, max: point.maximum, min: point.minimum, ...this.additional(stream, point) }, unit: point.unit }); }
  async deliver(points: MetricStreamPoint[]): Promise<void> {
    let dirty = false;
    for (const stream of Object.values(this.control)) {
      if (stream.state !== "running" || stream.destinationType !== "local-file" || !stream.localFilePath) continue; const selected = points.filter(point => this.selected(stream, point)); if (!selected.length) continue;
      try { await mkdir(resolve(stream.localFilePath, ".."), { recursive: true, mode: 0o700 }); await appendFile(stream.localFilePath, `${selected.map(point => this.envelope(stream, point)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 }); stream.deliveredRecords += selected.length; stream.lastDeliveryDate = this.clock.now(); delete stream.lastDeliveryError; }
      catch (error) { stream.lastDeliveryError = error instanceof Error ? error.message : String(error); }
      dirty = true;
    }
    if (dirty) await this.store.save();
  }
}
