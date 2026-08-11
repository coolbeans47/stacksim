import { createHash } from "node:crypto";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import { AwsError } from "./errors.js";
import type { StateStore } from "./state.js";
import type { CloudWatchAnomalyDetectorConfigurationState, CloudWatchAnomalyDetectorState } from "./types.js";

export const CLOUDWATCH_ANOMALY_ACTIONS = ["PutAnomalyDetector", "DescribeAnomalyDetectors", "DeleteAnomalyDetector"] as const;

type MetricDataReader = (input: any) => Promise<any>;
interface Dimension { Name: string; Value: string }

function list<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function stable(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function dimensions(value: unknown): Dimension[] {
  const result = list<any>(value as any).map(item => ({ Name: String(item?.Name ?? ""), Value: String(item?.Value ?? "") })).sort((a, b) => a.Name.localeCompare(b.Name) || a.Value.localeCompare(b.Value));
  if (result.length > 30 || result.some(item => !item.Name || !item.Value || item.Name.length > 255 || item.Value.length > 1024 || /[\x00-\x1f]/.test(item.Name + item.Value)) || new Set(result.map(item => item.Name)).size !== result.length) throw new AwsError("InvalidParameterValue", "Dimensions are invalid");
  return result;
}
function metricName(value: unknown, field: string): string { const result = String(value ?? ""); if (!result || result.length > 255 || /[\x00-\x1f]/.test(result) || (field === "Namespace" && result.startsWith(":"))) throw new AwsError("InvalidParameterValue", `${field} is invalid`); return result; }
function validStat(value: unknown): string {
  const result = String(value ?? "");
  if (!["SampleCount", "Average", "Sum", "Minimum", "Maximum", "IQM"].includes(result) && !/^(?:p|tc|tm|ts|wm|[ou])\d+(?:\.\d+)?(?:_[ELH])?$/i.test(result)) throw new AwsError("InvalidParameterValue", "Stat is invalid");
  if (result.length > 50) throw new AwsError("InvalidParameterValue", "Stat is invalid");
  return result;
}
function time(value: unknown, field: string): number { const result = value instanceof Date ? value.getTime() : typeof value === "number" ? value < 1e12 ? value * 1000 : value : Date.parse(String(value)); if (!Number.isFinite(result)) throw new AwsError("InvalidParameterValue", `${field} is invalid`); return result; }
function sameDimensions(left: Dimension[] = [], right: Dimension[] = []): boolean { return left.length === right.length && left.every((item, index) => item.Name === right[index].Name && item.Value === right[index].Value); }
function isBand(expression: unknown): boolean { return /^\s*ANOMALY_DETECTION_BAND\s*\(/i.test(String(expression ?? "")); }

function semanticQueries(input: Array<Record<string, any>>): string {
  const normalized = input.filter(query => !isBand(query.Expression)).map(query => {
    const clone = structuredClone(query); delete clone.ReturnData; delete clone.Label;
    if (clone.MetricStat?.Metric?.Dimensions) clone.MetricStat.Metric.Dimensions = dimensions(clone.MetricStat.Metric.Dimensions);
    return clone;
  }).sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
  return stable(normalized);
}

export class CloudWatchAnomalyEngine {
  constructor(private readonly store: StateStore, private readonly region: string, private readonly clock: Clock, private readonly readMetricData: MetricDataReader) {}
  private get control() { return this.store.regionState(this.region).cloudwatch; }
  private get tokens(): PaginationTokens { return new PaginationTokens(this.store.state.installation.paginationSecret); }

  private configuration(input: any): CloudWatchAnomalyDetectorConfigurationState {
    const excludedTimeRanges = list<any>(input?.ExcludedTimeRanges); if (excludedTimeRanges.length > 10) throw new AwsError("InvalidParameterValue", "Configuration supports at most 10 excluded time ranges");
    const ranges = excludedTimeRanges.map((range, index) => { const StartTime = time(range?.StartTime, `ExcludedTimeRanges.${index + 1}.StartTime`); const EndTime = time(range?.EndTime, `ExcludedTimeRanges.${index + 1}.EndTime`); if (StartTime >= EndTime) throw new AwsError("InvalidParameterValue", "An excluded time range must start before it ends"); return { StartTime, EndTime }; }).sort((a, b) => a.StartTime - b.StartTime || a.EndTime - b.EndTime);
    const metricTimezone = input?.MetricTimezone === undefined ? undefined : String(input.MetricTimezone); if (metricTimezone !== undefined) { if (!metricTimezone || metricTimezone.length > 50) throw new AwsError("InvalidParameterValue", "MetricTimezone is invalid"); try { new Intl.DateTimeFormat("en-US", { timeZone: metricTimezone }).format(0); } catch { throw new AwsError("InvalidParameterValue", "MetricTimezone must be a valid tz database name"); } }
    return { excludedTimeRanges: ranges, ...(metricTimezone ? { metricTimezone } : {}) };
  }

  private parseIdentity(input: any, allowId = false): { key?: string; singleMetric?: CloudWatchAnomalyDetectorState["singleMetric"]; metricMath?: CloudWatchAnomalyDetectorState["metricMath"]; detectorType?: CloudWatchAnomalyDetectorState["detectorType"]; anomalyDetectorId?: string } {
    const anomalyDetectorId = input.AnomalyDetectorId === undefined ? undefined : String(input.AnomalyDetectorId); const legacy = ["Namespace", "MetricName", "Dimensions", "Stat"].some(field => input[field] !== undefined); const singleObject = input.SingleMetricAnomalyDetector !== undefined; const mathObject = input.MetricMathAnomalyDetector !== undefined;
    if (anomalyDetectorId !== undefined) { if (!allowId || legacy || singleObject || mathObject || !anomalyDetectorId) throw new AwsError("InvalidParameterCombination", "AnomalyDetectorId cannot be combined with metric identity fields"); return { anomalyDetectorId }; }
    if ([legacy, singleObject, mathObject].filter(Boolean).length !== 1) throw new AwsError(legacy || singleObject || mathObject ? "InvalidParameterCombination" : "MissingParameter", "Specify exactly one single-metric or metric-math anomaly detector");
    if (mathObject) {
      const queries = list<Record<string, any>>(input.MetricMathAnomalyDetector?.MetricDataQueries); if (!queries.length || queries.length > 20) throw new AwsError("InvalidParameterValue", "MetricDataQueries must contain between 1 and 20 queries");
      const ids = new Set<string>(); let metrics = 0; let expressions = 0;
      for (const query of queries) { const id = String(query?.Id ?? ""); if (!/^[a-z][A-Za-z0-9_]{0,254}$/.test(id) || ids.has(id)) throw new AwsError("InvalidParameterValue", "Metric data query IDs must be unique and start with a lowercase letter"); ids.add(id); if (Boolean(query.MetricStat) === Boolean(query.Expression)) throw new AwsError("InvalidParameterCombination", "Each metric data query must contain exactly one MetricStat or Expression"); if (query.MetricStat) metrics++; else { expressions++; if (isBand(query.Expression)) throw new AwsError("InvalidParameterValue", "An anomaly detector source cannot contain ANOMALY_DETECTION_BAND"); } }
      if (metrics > 10 || expressions > 10) throw new AwsError("InvalidParameterValue", "Metric-math anomaly detectors support at most 10 metrics and 10 expressions"); const returned = queries.filter(query => query.ReturnData === true); if (returned.length !== 1 || !returned[0].Expression) throw new AwsError("InvalidParameterValue", "Exactly one metric-math expression must set ReturnData to true");
      const metricMath = { MetricDataQueries: structuredClone(queries) }; const key = `math\0${semanticQueries(metricMath.MetricDataQueries)}`; return { key, metricMath, detectorType: "METRIC_MATH" };
    }
    const source = singleObject ? input.SingleMetricAnomalyDetector : input; const AccountId = source.AccountId === undefined ? undefined : String(source.AccountId); if (AccountId !== undefined && AccountId !== this.store.accountId) throw new AwsError("InvalidParameterValue", "Cross-account anomaly detectors are not available in the single-account simulator");
    const singleMetric = { ...(AccountId ? { AccountId } : {}), Namespace: metricName(source.Namespace, "Namespace"), MetricName: metricName(source.MetricName, "MetricName"), Dimensions: dimensions(source.Dimensions), Stat: validStat(source.Stat) }; const key = `single\0${singleMetric.AccountId ?? this.store.accountId}\0${singleMetric.Namespace}\0${singleMetric.MetricName}\0${stable(singleMetric.Dimensions)}\0${singleMetric.Stat}`;
    return { key, singleMetric, detectorType: "SINGLE_METRIC" };
  }

  async PutAnomalyDetector(input: any): Promise<any> {
    const identity = this.parseIdentity(input); const now = this.clock.now();
    if (identity.metricMath) await this.readMetricData({ StartTime: new Date(now - 300_000), EndTime: new Date(now), MetricDataQueries: identity.metricMath.MetricDataQueries, ScanBy: "TimestampAscending" });
    const previous = this.control.anomalyDetectors[identity.key!]; const metricCharacteristics = input.MetricCharacteristics === undefined ? undefined : { PeriodicSpikes: Boolean(input.MetricCharacteristics?.PeriodicSpikes) }; const anomalyDetectorId = previous?.anomalyDetectorId ?? `ad-${createHash("sha256").update(identity.key!).digest("hex").slice(0, 32)}`;
    this.control.anomalyDetectors[identity.key!] = { anomalyDetectorId, detectorType: identity.detectorType!, identityKey: identity.key!, ...(identity.singleMetric ? { singleMetric: identity.singleMetric } : {}), ...(identity.metricMath ? { metricMath: identity.metricMath } : {}), configuration: this.configuration(input.Configuration), ...(metricCharacteristics ? { metricCharacteristics } : {}), stateValue: "PENDING_TRAINING", createdAt: previous?.createdAt ?? now, updatedAt: now, trainingDueAt: now + 15 * 60_000 };
    await this.store.save(); return { AnomalyDetectorId: anomalyDetectorId };
  }

  private query(detector: CloudWatchAnomalyDetectorState): Array<Record<string, unknown>> {
    if (detector.metricMath) return detector.metricMath.MetricDataQueries;
    const single = detector.singleMetric!; return [{ Id: "m1", ReturnData: true, MetricStat: { Metric: { Namespace: single.Namespace, MetricName: single.MetricName, Dimensions: single.Dimensions }, Period: 60, Stat: single.Stat } }];
  }

  private async refresh(detector: CloudWatchAnomalyDetectorState): Promise<boolean> {
    if (detector.stateValue !== "PENDING_TRAINING" || this.clock.now() < detector.trainingDueAt) return false;
    let count = 0;
    try {
      const result = await this.readMetricData({ StartTime: new Date(this.clock.now() - 14 * 86_400_000), EndTime: new Date(this.clock.now()), MetricDataQueries: this.query(detector), ScanBy: "TimestampAscending", MaxDatapoints: 100_800 }); const output = result.MetricDataResults?.find((item: any) => item.Values?.length); const times = list<any>(output?.Timestamps); count = times.filter(value => { const at = time(value, "Timestamp"); return !detector.configuration.excludedTimeRanges.some(range => at >= range.StartTime && at < range.EndTime); }).length;
    } catch { count = 0; }
    detector.stateValue = count >= 3 ? "TRAINED" : "TRAINED_INSUFFICIENT_DATA"; return true;
  }

  private view(detector: CloudWatchAnomalyDetectorState): any {
    const Configuration = { ExcludedTimeRanges: detector.configuration.excludedTimeRanges.map(range => ({ StartTime: new Date(range.StartTime), EndTime: new Date(range.EndTime) })), MetricTimezone: detector.configuration.metricTimezone };
    if (detector.singleMetric) return { AnomalyDetectorId: detector.anomalyDetectorId, Namespace: detector.singleMetric.Namespace, MetricName: detector.singleMetric.MetricName, Dimensions: detector.singleMetric.Dimensions, Stat: detector.singleMetric.Stat, Configuration, StateValue: detector.stateValue, MetricCharacteristics: detector.metricCharacteristics, SingleMetricAnomalyDetector: detector.singleMetric };
    return { AnomalyDetectorId: detector.anomalyDetectorId, Configuration, StateValue: detector.stateValue, MetricCharacteristics: detector.metricCharacteristics, MetricMathAnomalyDetector: detector.metricMath };
  }

  async DescribeAnomalyDetectors(input: any): Promise<any> {
    const ids = list<any>(input.AnomalyDetectorIds).map(String); if (ids.length > 50) throw new AwsError("InvalidParameterValue", "AnomalyDetectorIds supports at most 50 identifiers"); const metricFilters = ["Namespace", "MetricName", "Dimensions", "AnomalyDetectorTypes"].some(field => input[field] !== undefined); if (ids.length && metricFilters) throw new AwsError("InvalidParameterCombination", "AnomalyDetectorIds cannot be combined with metric filters");
    const types = list<any>(input.AnomalyDetectorTypes).map(String); if (types.length > 2 || types.some(type => !["SINGLE_METRIC", "METRIC_MATH"].includes(type))) throw new AwsError("InvalidParameterValue", "AnomalyDetectorTypes is invalid"); const selectedTypes = new Set(types.length ? types : ids.length ? ["SINGLE_METRIC", "METRIC_MATH"] : ["SINGLE_METRIC"]); const requestedDimensions = input.Dimensions === undefined ? undefined : dimensions(input.Dimensions); if ((input.Namespace !== undefined || input.MetricName !== undefined || requestedDimensions !== undefined) && selectedTypes.has("METRIC_MATH")) throw new AwsError("InvalidParameterCombination", "Metric filters apply only to single-metric anomaly detectors");
    let dirty = false; for (const detector of Object.values(this.control.anomalyDetectors)) dirty = await this.refresh(detector) || dirty; if (dirty) await this.store.save();
    const selected = Object.values(this.control.anomalyDetectors).filter(detector => (!ids.length || ids.includes(detector.anomalyDetectorId)) && selectedTypes.has(detector.detectorType) && (input.Namespace === undefined || detector.singleMetric?.Namespace === input.Namespace) && (input.MetricName === undefined || detector.singleMetric?.MetricName === input.MetricName) && (requestedDimensions === undefined || sameDimensions(detector.singleMetric?.Dimensions, requestedDimensions))).sort((a, b) => a.anomalyDetectorId.localeCompare(b.anomalyDetectorId));
    const max = input.MaxResults === undefined ? 100 : Number(input.MaxResults); if (!Number.isInteger(max) || max < 1 || max > 100) throw new AwsError("InvalidParameterValue", "MaxResults must be between 1 and 100"); const filter = stable({ ids: [...ids].sort(), types: [...selectedTypes].sort(), Namespace: input.Namespace, MetricName: input.MetricName, Dimensions: requestedDimensions }); let index = 0;
    if (input.NextToken) try { const cursor = this.tokens.decode<{ index: number; filter: string }>("DescribeAnomalyDetectors", input.NextToken); if (cursor.filter !== filter) throw new Error(); index = cursor.index; } catch { throw new AwsError("InvalidNextToken", "The next token is invalid"); }
    const page = selected.slice(index, index + max); const next = index + page.length; return { AnomalyDetectors: page.map(detector => this.view(detector)), ...(next < selected.length ? { NextToken: this.tokens.encode("DescribeAnomalyDetectors", { index: next, filter }) } : {}) };
  }

  async DeleteAnomalyDetector(input: any): Promise<Record<string, never>> {
    const identity = this.parseIdentity(input, true); const detector = identity.anomalyDetectorId ? Object.values(this.control.anomalyDetectors).find(item => item.anomalyDetectorId === identity.anomalyDetectorId) : this.control.anomalyDetectors[identity.key!]; if (!detector) throw new AwsError("ResourceNotFound", "The anomaly detector does not exist", 404); delete this.control.anomalyDetectors[detector.identityKey]; await this.store.save(); return {};
  }

  modelFor(sourceId: string | undefined, sourceQuery: any, queries: any[]): Pick<CloudWatchAnomalyDetectorState, "configuration" | "metricCharacteristics"> | undefined {
    const detectors = Object.values(this.control.anomalyDetectors).sort((a, b) => a.anomalyDetectorId.localeCompare(b.anomalyDetectorId));
    if (sourceQuery?.MetricStat) { const metric = sourceQuery.MetricStat.Metric ?? {}; const dims = dimensions(metric.Dimensions); return detectors.find(detector => { const single = detector.singleMetric; return Boolean(single && single.Namespace === metric.Namespace && single.MetricName === metric.MetricName && single.Stat === sourceQuery.MetricStat.Stat && sameDimensions(single.Dimensions, dims)); }); }
    if (sourceId && sourceQuery?.Expression) { const semantic = semanticQueries(queries); return detectors.find(detector => detector.metricMath && detector.metricMath.MetricDataQueries.some(query => query.Id === sourceId && query.ReturnData === true) && semanticQueries(detector.metricMath.MetricDataQueries) === semantic); }
    return undefined;
  }
}
