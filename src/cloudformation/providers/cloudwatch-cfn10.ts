import type { CloudWatchMetricsService } from "../../cloudwatch-metrics.js";
import { parseAlarmRule } from "../../cloudwatch-alarm-rule.js";
import { validateDashboardBody } from "../../cloudwatch-dashboards.js";
import { AwsError } from "../../errors.js";
import {
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderSuccess,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";
import {
  CFN10_NO_TAGS,
  CFN10_RETENTION,
  CFN10_STACK_TAGS,
  cfn10DeleteFailure,
  cfn10ExactKeys,
  cfn10Failure,
  cfn10GeneratedName,
  cfn10GetAtt,
  cfn10Issue,
  cfn10Missing,
  cfn10Owned,
  cfn10Plan,
  cfn10Record,
  cfn10Same,
  cfn10ServiceTags,
  cfn10Stable,
  cfn10Tags,
  cfn10ThrowIssues,
  cfn10UserTags,
  type Cfn10Object,
  type Cfn10Tag,
} from "./cfn10-common.js";

export const CLOUDWATCH_ALARM_TYPE = "AWS::CloudWatch::Alarm";
export const CLOUDWATCH_COMPOSITE_ALARM_TYPE = "AWS::CloudWatch::CompositeAlarm";
export const CLOUDWATCH_DASHBOARD_TYPE = "AWS::CloudWatch::Dashboard";
export const CLOUDWATCH_ANOMALY_DETECTOR_TYPE = "AWS::CloudWatch::AnomalyDetector";
export const CLOUDWATCH_INSIGHT_RULE_TYPE = "AWS::CloudWatch::InsightRule";

const mutable = (valueType: "string" | "number" | "boolean" | "object" | "array" | "any", required = false) => Object.freeze({ valueType, ...(required ? { required: true } : {}), updateBehavior: "MUTABLE" as const });
const replacement = (valueType: "string" | "number" | "boolean" | "object" | "array" | "any", required = false) => Object.freeze({ valueType, ...(required ? { required: true } : {}), updateBehavior: "REPLACEMENT" as const });

export const CLOUDWATCH_ALARM_SCHEMA: ProviderSchema = Object.freeze({
  typeName: CLOUDWATCH_ALARM_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    ActionsEnabled: mutable("boolean"), AlarmActions: mutable("array"), AlarmDescription: mutable("string"), AlarmName: replacement("string"),
    ComparisonOperator: mutable("string", true), DatapointsToAlarm: mutable("number"), Dimensions: mutable("array"), EvaluateLowSampleCountPercentile: mutable("string"),
    EvaluationPeriods: mutable("number", true), ExtendedStatistic: mutable("string"), InsufficientDataActions: mutable("array"), MetricName: mutable("string"),
    Metrics: mutable("array"), Namespace: mutable("string"), OKActions: mutable("array"), Period: mutable("number"), Statistic: mutable("string"),
    Tags: mutable("array"), Threshold: mutable("number"), ThresholdMetricId: mutable("string"), TreatMissingData: mutable("string"), Unit: mutable("string"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Alarm name" }), attributes: Object.freeze({ Arn: Object.freeze({ valueType: "string" as const, description: "Alarm ARN" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: CFN10_RETENTION, tags: CFN10_STACK_TAGS,
});

export const CLOUDWATCH_COMPOSITE_ALARM_SCHEMA: ProviderSchema = Object.freeze({
  typeName: CLOUDWATCH_COMPOSITE_ALARM_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    ActionsEnabled: mutable("boolean"), ActionsSuppressor: mutable("string"), ActionsSuppressorExtensionPeriod: mutable("number"), ActionsSuppressorWaitPeriod: mutable("number"),
    AlarmActions: mutable("array"), AlarmDescription: mutable("string"), AlarmName: replacement("string"), AlarmRule: mutable("string", true),
    InsufficientDataActions: mutable("array"), OKActions: mutable("array"), Tags: mutable("array"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Composite alarm name" }), attributes: Object.freeze({ Arn: Object.freeze({ valueType: "string" as const, description: "Composite alarm ARN" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: CFN10_RETENTION, tags: CFN10_STACK_TAGS,
});

export const CLOUDWATCH_DASHBOARD_SCHEMA: ProviderSchema = Object.freeze({
  typeName: CLOUDWATCH_DASHBOARD_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({ DashboardBody: mutable("string", true), DashboardName: replacement("string") }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Dashboard name" }), attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: CFN10_RETENTION, tags: CFN10_NO_TAGS,
});

export const CLOUDWATCH_ANOMALY_DETECTOR_SCHEMA: ProviderSchema = Object.freeze({
  typeName: CLOUDWATCH_ANOMALY_DETECTOR_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    Configuration: mutable("object"), Dimensions: replacement("array"), MetricCharacteristics: replacement("object"), MetricMathAnomalyDetector: replacement("object"),
    MetricName: replacement("string"), Namespace: replacement("string"), SingleMetricAnomalyDetector: replacement("object"), Stat: replacement("string"),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Stable anomaly detector ID" }), attributes: Object.freeze({ Id: Object.freeze({ valueType: "string" as const, description: "Stable anomaly detector ID" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: CFN10_RETENTION, tags: CFN10_NO_TAGS,
});

export const CLOUDWATCH_INSIGHT_RULE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: CLOUDWATCH_INSIGHT_RULE_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({ ApplyOnTransformedLogs: mutable("boolean"), RuleBody: mutable("string", true), RuleName: replacement("string", true), RuleState: mutable("string", true), Tags: mutable("array") }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Contributor Insights rule ARN" }),
  attributes: Object.freeze({ Arn: Object.freeze({ valueType: "string" as const, description: "Contributor Insights rule ARN" }), Id: Object.freeze({ valueType: "string" as const, description: "Rule identifier (the backed rule name)" }), RuleName: Object.freeze({ valueType: "string" as const, description: "Contributor Insights rule name" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: CFN10_RETENTION, tags: CFN10_STACK_TAGS,
});

export const CLOUDWATCH_CFN10_SCHEMAS = Object.freeze([CLOUDWATCH_ALARM_SCHEMA, CLOUDWATCH_COMPOSITE_ALARM_SCHEMA, CLOUDWATCH_DASHBOARD_SCHEMA, CLOUDWATCH_ANOMALY_DETECTOR_SCHEMA, CLOUDWATCH_INSIGHT_RULE_SCHEMA]);

interface DimensionModel extends Cfn10Object { readonly Name: string; readonly Value: string }
interface AlarmModel extends Cfn10Object {
  readonly ActionsEnabled: boolean; readonly AlarmActions: readonly string[]; readonly AlarmDescription?: string; readonly AlarmName: string;
  readonly ComparisonOperator: string; readonly DatapointsToAlarm: number; readonly Dimensions?: readonly DimensionModel[]; readonly EvaluateLowSampleCountPercentile: "evaluate" | "ignore";
  readonly EvaluationPeriods: number; readonly ExtendedStatistic?: string; readonly InsufficientDataActions: readonly string[]; readonly MetricName?: string;
  readonly Metrics?: readonly Cfn10Object[]; readonly Namespace?: string; readonly OKActions: readonly string[]; readonly Period?: number; readonly Statistic?: string;
  readonly Tags: readonly Cfn10Tag[]; readonly Threshold?: number; readonly ThresholdMetricId?: string; readonly TreatMissingData: "breaching" | "notBreaching" | "ignore" | "missing"; readonly Unit?: string;
}
interface CompositeAlarmModel extends Cfn10Object {
  readonly ActionsEnabled: boolean; readonly ActionsSuppressor?: string; readonly ActionsSuppressorExtensionPeriod?: number; readonly ActionsSuppressorWaitPeriod?: number;
  readonly AlarmActions: readonly string[]; readonly AlarmDescription?: string; readonly AlarmName: string; readonly AlarmRule: string;
  readonly InsufficientDataActions: readonly string[]; readonly OKActions: readonly string[]; readonly Tags: readonly Cfn10Tag[];
}
interface DashboardModel extends Cfn10Object { readonly DashboardBody: string; readonly DashboardName: string }
interface AnomalyConfigurationModel extends Cfn10Object { readonly ExcludedTimeRanges: readonly { readonly StartTime: string; readonly EndTime: string }[]; readonly MetricTimeZone?: string }
interface SingleAnomalyModel extends Cfn10Object { readonly AccountId?: string; readonly Dimensions: readonly DimensionModel[]; readonly MetricName: string; readonly Namespace: string; readonly Stat: string }
interface AnomalyDetectorModel extends Cfn10Object { readonly Configuration: AnomalyConfigurationModel; readonly MetricCharacteristics?: { readonly PeriodicSpikes: boolean }; readonly MetricMathAnomalyDetector?: { readonly MetricDataQueries: readonly Cfn10Object[] }; readonly SingleMetricAnomalyDetector?: SingleAnomalyModel }
interface InsightRuleModel extends Cfn10Object { readonly ApplyOnTransformedLogs: false; readonly RuleBody: string; readonly RuleName: string; readonly RuleState: "ENABLED" | "DISABLED"; readonly Tags: readonly Cfn10Tag[] }

function success<Model>(physicalId: string, properties: Model, attributes: Readonly<Record<string, unknown>> = {}): ProviderSuccess<Model> { return { status: "SUCCESS", physicalId, model: { physicalId, properties, attributes } }; }
function issues(properties: unknown, schema: ProviderSchema): ProviderValidationIssue[] { return validateDeclaredProperties(properties, schema); }
function validAlarmName(value: unknown): value is string { return typeof value === "string" && value.length >= 1 && value.length <= 255 && !value.includes(":") && !/[\x00-\x1f]/.test(value); }
function validateName(value: unknown, path: string, output: ProviderValidationIssue[]): void { if (!validAlarmName(value)) cfn10Issue(output, path, `${path.split(".").at(-1)} must be a valid 1-255 character name without ':' or control characters`); }
function validateDimensions(value: unknown, path: string, output: ProviderValidationIssue[]): void {
  if (!Array.isArray(value) || value.length > 30) return cfn10Issue(output, path, `${path} must be an array containing at most 30 dimensions`);
  const names = new Set<string>(); value.forEach((dimension, index) => { const itemPath = `${path}[${index}]`; if (!cfn10Record(dimension)) return cfn10Issue(output, itemPath, "Dimension must be an object"); cfn10ExactKeys(dimension, ["Name", "Value"], itemPath, output); if (typeof dimension.Name !== "string" || !dimension.Name || dimension.Name.length > 255 || names.has(dimension.Name)) cfn10Issue(output, `${itemPath}.Name`, "Dimension Name must be unique and contain 1-255 characters"); else names.add(dimension.Name); if (typeof dimension.Value !== "string" || !dimension.Value || dimension.Value.length > 1024 || /[\x00-\x1f]/.test(dimension.Value)) cfn10Issue(output, `${itemPath}.Value`, "Dimension Value must contain 1-1024 characters without control characters"); });
}
function dimensions(value: unknown): readonly DimensionModel[] { return Object.freeze((Array.isArray(value) ? value : []).map(item => Object.freeze({ Name: String((item as Cfn10Object).Name), Value: String((item as Cfn10Object).Value) })).sort((left, right) => left.Name.localeCompare(right.Name) || left.Value.localeCompare(right.Value))); }
function actionIssues(value: unknown, path: string, output: ProviderValidationIssue[], context: ProviderContext): void {
  if (!Array.isArray(value) || value.length > 5) return cfn10Issue(output, path, `${path.split(".").at(-1)} must contain at most five Lambda action ARNs`);
  for (const [index, action] of value.entries()) {
    const text = String(action);
    const lambda = text.match(/^arn:(?:aws|aws-us-gov|aws-cn):lambda:([^:]+):(\d{12}):function:[A-Za-z0-9-_]{1,64}(?::[A-Za-z0-9-_$]+)?$/);
    const sns = text.match(/^arn:(?:aws|aws-us-gov|aws-cn):sns:([^:]+):(\d{12}):[A-Za-z0-9_-]{1,256}$/);
    const match = lambda ?? sns;
    if (!match) cfn10Issue(output, `${path}[${index}]`, "Alarm actions support Lambda function and Standard SNS topic ARNs; Auto Scaling, SSM, and unavailable services are dependency-blocked");
    else if (match[1] !== context.region || match[2] !== context.accountId) cfn10Issue(output, `${path}[${index}]`, "Alarm actions must use this simulator account and Region");
  }
}
function actionList(value: unknown): readonly string[] { return Object.freeze((Array.isArray(value) ? value : []).map(String)); }
function finite(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value); }
function integer(value: unknown, min: number, max: number): boolean { return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max; }
const comparisons = new Set(["GreaterThanThreshold", "GreaterThanOrEqualToThreshold", "LessThanThreshold", "LessThanOrEqualToThreshold"]);
const anomalyComparisons = new Set(["LessThanLowerOrGreaterThanUpperThreshold", "LessThanLowerThreshold", "GreaterThanUpperThreshold"]);
const statistics = new Set(["SampleCount", "Average", "Sum", "Minimum", "Maximum"]);
const units = new Set(["Seconds", "Microseconds", "Milliseconds", "Bytes", "Kilobytes", "Megabytes", "Gigabytes", "Terabytes", "Bits", "Kilobits", "Megabits", "Gigabits", "Terabits", "Percent", "Count", "Bytes/Second", "Kilobytes/Second", "Megabytes/Second", "Gigabytes/Second", "Terabytes/Second", "Bits/Second", "Kilobits/Second", "Megabits/Second", "Gigabits/Second", "Terabits/Second", "Count/Second", "None"]);
function validPeriod(value: unknown): boolean { return integer(value, 10, 86_400) && ([10, 20, 30].includes(Number(value)) || Number(value) % 60 === 0); }
function percentile(value: unknown): boolean { const match = String(value ?? "").match(/^p(100(?:\.0{1,10})?|\d{1,2}(?:\.\d{1,10})?)$/i); return Boolean(match && Number(match[1]) >= 0 && Number(match[1]) <= 100); }

function metricStatIssues(value: unknown, path: string, output: ProviderValidationIssue[]): void {
  if (!cfn10Record(value)) return cfn10Issue(output, path, `${path} must be an object`); cfn10ExactKeys(value, ["Metric", "Period", "Stat", "Unit"], path, output);
  if (!cfn10Record(value.Metric)) cfn10Issue(output, `${path}.Metric`, "Metric is required and must be an object"); else { const metric = value.Metric; cfn10ExactKeys(metric, ["Dimensions", "MetricName", "Namespace"], `${path}.Metric`, output); for (const key of ["MetricName", "Namespace"] as const) if (typeof metric[key] !== "string" || !metric[key] || String(metric[key]).length > 255) cfn10Issue(output, `${path}.Metric.${key}`, `${key} must contain 1-255 characters`); if (metric.Dimensions !== undefined) validateDimensions(metric.Dimensions, `${path}.Metric.Dimensions`, output); }
  if (!validPeriod(value.Period)) cfn10Issue(output, `${path}.Period`, "Period must be 10, 20, 30, or a multiple of 60 up to 86400"); if (typeof value.Stat !== "string" || !value.Stat || value.Stat.length > 50) cfn10Issue(output, `${path}.Stat`, "Stat must be a non-empty supported statistic string"); if (value.Unit !== undefined && !units.has(String(value.Unit))) cfn10Issue(output, `${path}.Unit`, "Unit is not supported");
}
function metricQueryIssues(value: unknown, path: string, output: ProviderValidationIssue[]): void {
  if (!cfn10Record(value)) return cfn10Issue(output, path, `${path} must be an object`); cfn10ExactKeys(value, ["AccountId", "Expression", "Id", "Label", "MetricStat", "Period", "ReturnData"], path, output);
  if (typeof value.Id !== "string" || !/^[a-z][A-Za-z0-9_]{0,254}$/.test(value.Id)) cfn10Issue(output, `${path}.Id`, "Id must begin with a lowercase letter and contain only alphanumeric/underscore characters");
  if ((value.Expression === undefined) === (value.MetricStat === undefined)) cfn10Issue(output, path, "Each metric query must contain exactly one Expression or MetricStat"); if (value.Expression !== undefined && (typeof value.Expression !== "string" || !value.Expression)) cfn10Issue(output, `${path}.Expression`, "Expression must be a non-empty string"); if (value.MetricStat !== undefined) metricStatIssues(value.MetricStat, `${path}.MetricStat`, output); if (value.Period !== undefined && !validPeriod(value.Period)) cfn10Issue(output, `${path}.Period`, "Period is invalid"); if (value.ReturnData !== undefined && typeof value.ReturnData !== "boolean") cfn10Issue(output, `${path}.ReturnData`, "ReturnData must be boolean"); if (value.AccountId !== undefined) cfn10Issue(output, `${path}.AccountId`, "Cross-account metric queries are unavailable in the single-account simulator");
}
function validateMetricQueries(value: unknown, path: string, output: ProviderValidationIssue[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return cfn10Issue(output, path, `${path} must contain 1-20 metric queries`); const ids = new Set<string>(); value.forEach((query, index) => { metricQueryIssues(query, `${path}[${index}]`, output); if (cfn10Record(query) && typeof query.Id === "string") { if (ids.has(query.Id)) cfn10Issue(output, `${path}[${index}].Id`, "Metric query IDs must be unique"); ids.add(query.Id); } });
}

function alarmIssues(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const output = issues(properties, CLOUDWATCH_ALARM_SCHEMA); if (!cfn10Record(properties)) return output;
  if (properties.AlarmName !== undefined) validateName(properties.AlarmName, "Properties.AlarmName", output); if (properties.AlarmDescription !== undefined && (typeof properties.AlarmDescription !== "string" || properties.AlarmDescription.length > 1024)) cfn10Issue(output, "Properties.AlarmDescription", "AlarmDescription must not exceed 1024 characters");
  if (!integer(properties.EvaluationPeriods, 1, 86_400)) cfn10Issue(output, "Properties.EvaluationPeriods", "EvaluationPeriods must be an integer between 1 and 86400"); const evaluation = Number(properties.EvaluationPeriods); if (properties.DatapointsToAlarm !== undefined && !integer(properties.DatapointsToAlarm, 1, Number.isInteger(evaluation) ? evaluation : 86_400)) cfn10Issue(output, "Properties.DatapointsToAlarm", "DatapointsToAlarm must be between 1 and EvaluationPeriods");
  const anomaly = properties.ThresholdMetricId !== undefined; if (!(anomaly ? anomalyComparisons : comparisons).has(String(properties.ComparisonOperator))) cfn10Issue(output, "Properties.ComparisonOperator", anomaly ? "Anomaly alarms require an anomaly comparison operator" : "Static alarms require a static comparison operator"); if (anomaly ? properties.Threshold !== undefined : !finite(properties.Threshold)) cfn10Issue(output, "Properties.Threshold", anomaly ? "Threshold cannot be combined with ThresholdMetricId" : "Threshold must be a finite number");
  if (properties.TreatMissingData !== undefined && !["breaching", "notBreaching", "ignore", "missing"].includes(String(properties.TreatMissingData))) cfn10Issue(output, "Properties.TreatMissingData", "TreatMissingData is invalid"); if (properties.EvaluateLowSampleCountPercentile !== undefined && !["evaluate", "ignore"].includes(String(properties.EvaluateLowSampleCountPercentile))) cfn10Issue(output, "Properties.EvaluateLowSampleCountPercentile", "EvaluateLowSampleCountPercentile must be evaluate or ignore");
  for (const field of ["AlarmActions", "OKActions", "InsufficientDataActions"] as const) if (properties[field] !== undefined) actionIssues(properties[field], `Properties.${field}`, output, context);
  try { cfn10Tags(properties.Tags); } catch (error) { cfn10Issue(output, "Properties.Tags", error instanceof Error ? error.message : String(error)); }
  const standardFields = ["MetricName", "Namespace", "Dimensions", "Period", "Statistic", "ExtendedStatistic", "Unit"] as const; const standard = standardFields.some(field => properties[field] !== undefined); const math = properties.Metrics !== undefined;
  if (standard === math) cfn10Issue(output, "Properties", "Specify either MetricName/Namespace metric fields or Metrics, but not both");
  if (standard) {
    for (const field of ["MetricName", "Namespace"] as const) if (typeof properties[field] !== "string" || !properties[field] || String(properties[field]).length > 255) cfn10Issue(output, `Properties.${field}`, `${field} must contain 1-255 characters`);
    if (!validPeriod(properties.Period)) cfn10Issue(output, "Properties.Period", "Period must be 10, 20, 30, or a multiple of 60 up to 86400");
    else if (Number(properties.Period) * evaluation > 604_800 || (Number(properties.Period) < 3600 && Number(properties.Period) * evaluation > 86_400)) cfn10Issue(output, "Properties.Period", "Period and EvaluationPeriods exceed the supported evaluation window");
    if ((properties.Statistic === undefined) === (properties.ExtendedStatistic === undefined)) cfn10Issue(output, "Properties.Statistic", "Specify exactly one Statistic or ExtendedStatistic"); if (properties.Statistic !== undefined && !statistics.has(String(properties.Statistic))) cfn10Issue(output, "Properties.Statistic", "Statistic is unsupported"); if (properties.ExtendedStatistic !== undefined && !percentile(properties.ExtendedStatistic)) cfn10Issue(output, "Properties.ExtendedStatistic", "ExtendedStatistic must be a p0-p100 percentile"); if (properties.Dimensions !== undefined) validateDimensions(properties.Dimensions, "Properties.Dimensions", output); if (properties.Unit !== undefined && !units.has(String(properties.Unit))) cfn10Issue(output, "Properties.Unit", "Unit is unsupported");
    if (anomaly) cfn10Issue(output, "Properties.ThresholdMetricId", "Anomaly detection alarms require the Metrics form");
  }
  if (math) {
    validateMetricQueries(properties.Metrics, "Properties.Metrics", output);
    if (Array.isArray(properties.Metrics)) {
      const queries = properties.Metrics.filter(cfn10Record);
      if (anomaly) {
        const thresholdId = typeof properties.ThresholdMetricId === "string" ? properties.ThresholdMetricId : "";
        const band = queries.find(query => query.Id === thresholdId);
        const match = String(band?.Expression ?? "").match(/^\s*ANOMALY_DETECTION_BAND\s*\(\s*([a-z][A-Za-z0-9_]*)\s*(?:,\s*(\d+(?:\.\d+)?)\s*)?\)\s*$/i);
        if (!thresholdId || !match || !queries.some(query => query.Id === match[1])) cfn10Issue(output, "Properties.ThresholdMetricId", "ThresholdMetricId must identify an ANOMALY_DETECTION_BAND expression with an existing source query");
        const returned = queries.filter(query => query.Id !== thresholdId && query.ReturnData !== false);
        if (!match || returned.length !== 1 || returned[0]?.Id !== match[1]) cfn10Issue(output, "Properties.Metrics", "Exactly the anomaly band source query must return data");
      } else if (queries.filter(query => query.ReturnData !== false).length !== 1) cfn10Issue(output, "Properties.Metrics", "Exactly one metric data query must return data");
      const returned = queries.find(query => query.Id !== properties.ThresholdMetricId && query.ReturnData !== false);
      const resultPeriod = returned?.Period ?? (cfn10Record(returned?.MetricStat) ? returned.MetricStat.Period : undefined);
      if (!validPeriod(resultPeriod)) cfn10Issue(output, "Properties.Metrics", "The returned metric query must define a supported Period");
      else if (Number(resultPeriod) * evaluation > 604_800 || (Number(resultPeriod) < 3600 && Number(resultPeriod) * evaluation > 86_400)) cfn10Issue(output, "Properties.Metrics", "The returned metric query period and EvaluationPeriods exceed the supported evaluation window");
    }
  }
  return output;
}

function canonicalAlarm(properties: Cfn10Object, context: ProviderContext): AlarmModel {
  const evaluation = Number(properties.EvaluationPeriods); const math = Array.isArray(properties.Metrics);
  return Object.freeze({
    ActionsEnabled: properties.ActionsEnabled === undefined ? true : Boolean(properties.ActionsEnabled), AlarmActions: actionList(properties.AlarmActions),
    ...(properties.AlarmDescription !== undefined ? { AlarmDescription: String(properties.AlarmDescription) } : {}), AlarmName: String(properties.AlarmName ?? cfn10GeneratedName(context, "", 255, /[^A-Za-z0-9_.-]/g)),
    ComparisonOperator: String(properties.ComparisonOperator), DatapointsToAlarm: Number(properties.DatapointsToAlarm ?? evaluation), EvaluateLowSampleCountPercentile: String(properties.EvaluateLowSampleCountPercentile ?? "evaluate") as AlarmModel["EvaluateLowSampleCountPercentile"], EvaluationPeriods: evaluation,
    InsufficientDataActions: actionList(properties.InsufficientDataActions), OKActions: actionList(properties.OKActions), Tags: cfn10Tags(properties.Tags), TreatMissingData: String(properties.TreatMissingData ?? "missing") as AlarmModel["TreatMissingData"],
    ...(properties.Threshold !== undefined ? { Threshold: Number(properties.Threshold) } : {}), ...(properties.ThresholdMetricId !== undefined ? { ThresholdMetricId: String(properties.ThresholdMetricId) } : {}),
    ...(math ? { Metrics: Object.freeze((properties.Metrics as unknown[]).map(item => Object.freeze(cfn10Stable(item as Cfn10Object)))) } : {
      MetricName: String(properties.MetricName), Namespace: String(properties.Namespace), Period: Number(properties.Period), Dimensions: dimensions(properties.Dimensions),
      ...(properties.Statistic !== undefined ? { Statistic: String(properties.Statistic) } : {}), ...(properties.ExtendedStatistic !== undefined ? { ExtendedStatistic: String(properties.ExtendedStatistic) } : {}), ...(properties.Unit !== undefined ? { Unit: String(properties.Unit) } : {}),
    }),
  });
}

function alarmInput(model: AlarmModel, tags?: readonly { Key: string; Value: string }[]): Cfn10Object {
  return { ...model, ...(tags ? { Tags: tags } : {}), ...(!tags ? { Tags: undefined } : {}) };
}
async function findAnyAlarm(cloudwatch: CloudWatchMetricsService, name: string): Promise<{ kind: "metric" | "composite" | "log"; raw: any } | undefined> {
  const response = await cloudwatch.alarms.DescribeAlarms({ AlarmNames: [name], AlarmTypes: ["MetricAlarm", "CompositeAlarm", "LogAlarm"] });
  if (response.MetricAlarms?.[0]) return { kind: "metric", raw: response.MetricAlarms[0] }; if (response.CompositeAlarms?.[0]) return { kind: "composite", raw: response.CompositeAlarms[0] }; if (response.LogAlarms?.[0]) return { kind: "log", raw: response.LogAlarms[0] }; return undefined;
}
async function cloudwatchTags(cloudwatch: CloudWatchMetricsService, arn: string): Promise<readonly { Key?: unknown; Value?: unknown }[]> { return (await cloudwatch.ListTagsForResource({ ResourceARN: arn })).Tags ?? []; }
async function reconcileCloudWatchTags(cloudwatch: CloudWatchMetricsService, arn: string, desired: readonly Cfn10Tag[], context: ProviderContext): Promise<void> {
  const current = await cloudwatchTags(cloudwatch, arn); const wanted = cfn10ServiceTags(desired, context); const keys = new Set(wanted.map(tag => tag.Key)); const remove = current.map(tag => String(tag.Key)).filter(key => !keys.has(key)); if (remove.length) await cloudwatch.UntagResource({ ResourceARN: arn, TagKeys: remove }); await cloudwatch.TagResource({ ResourceARN: arn, Tags: wanted });
}
function alarmFromService(raw: any, tags: readonly { Key?: unknown; Value?: unknown }[]): AlarmModel {
  const standard = raw.Metrics === undefined;
  return Object.freeze({ ActionsEnabled: Boolean(raw.ActionsEnabled), AlarmActions: actionList(raw.AlarmActions), ...(raw.AlarmDescription !== undefined ? { AlarmDescription: String(raw.AlarmDescription) } : {}), AlarmName: String(raw.AlarmName), ComparisonOperator: String(raw.ComparisonOperator), DatapointsToAlarm: Number(raw.DatapointsToAlarm), EvaluateLowSampleCountPercentile: String(raw.EvaluateLowSampleCountPercentile ?? "evaluate") as AlarmModel["EvaluateLowSampleCountPercentile"], EvaluationPeriods: Number(raw.EvaluationPeriods), InsufficientDataActions: actionList(raw.InsufficientDataActions), OKActions: actionList(raw.OKActions), Tags: cfn10UserTags(tags), TreatMissingData: String(raw.TreatMissingData ?? "missing") as AlarmModel["TreatMissingData"], ...(raw.Threshold !== undefined ? { Threshold: Number(raw.Threshold) } : {}), ...(raw.ThresholdMetricId !== undefined ? { ThresholdMetricId: String(raw.ThresholdMetricId) } : {}), ...(standard ? { MetricName: String(raw.MetricName), Namespace: String(raw.Namespace), Period: Number(raw.Period), Dimensions: dimensions(raw.Dimensions), ...(raw.Statistic !== undefined ? { Statistic: String(raw.Statistic) } : {}), ...(raw.ExtendedStatistic !== undefined ? { ExtendedStatistic: String(raw.ExtendedStatistic) } : {}), ...(raw.Unit !== undefined ? { Unit: String(raw.Unit) } : {}) } : { Metrics: Object.freeze(raw.Metrics.map((item: any) => Object.freeze(cfn10Stable(item)))) }) });
}

export function createCloudWatchAlarmProvider(cloudwatch: CloudWatchMetricsService): ProductionResourceProvider<AlarmModel> {
  return {
    typeName: CLOUDWATCH_ALARM_TYPE, providerVersion: 1, visibility: "production", schema: CLOUDWATCH_ALARM_SCHEMA,
    validate(properties, context) { return alarmIssues(properties, context); }, canonicalize(properties, context) { const output = this.validate(properties, context); cfn10ThrowIssues(output); return canonicalAlarm(properties as Cfn10Object, context); }, plan(previous, desired) { return cfn10Plan(previous, desired, CLOUDWATCH_ALARM_SCHEMA); },
    async create(desired, context) { try { const existing = await findAnyAlarm(cloudwatch, desired.AlarmName); if (existing) { if (existing.kind !== "metric") return { status: "FAILED", errorCode: "AlreadyExists", message: `Alarm ${desired.AlarmName} already exists with another alarm type` }; const tags = await cloudwatchTags(cloudwatch, existing.raw.AlarmArn); if (!cfn10Owned(tags, context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Alarm ${desired.AlarmName} already exists and is not owned by this stack resource` }; } await cloudwatch.alarms.PutMetricAlarm(alarmInput(desired, cfn10ServiceTags(desired.Tags, context))); const raw = (await findAnyAlarm(cloudwatch, desired.AlarmName))!.raw; await reconcileCloudWatchTags(cloudwatch, raw.AlarmArn, desired.Tags, context); return success(desired.AlarmName, alarmFromService(raw, await cloudwatchTags(cloudwatch, raw.AlarmArn)), { Arn: raw.AlarmArn }); } catch (error) { return cfn10Failure(error); } },
    async read(physicalId, context): Promise<ProviderReadResult<AlarmModel>> { try { const found = await findAnyAlarm(cloudwatch, physicalId); if (!found || found.kind !== "metric") return { status: "NOT_FOUND", physicalId }; const tags = await cloudwatchTags(cloudwatch, found.raw.AlarmArn); if (!cfn10Owned(tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Alarm ${physicalId} is not owned by this stack resource` }; return success(physicalId, alarmFromService(found.raw, tags), { Arn: found.raw.AlarmArn }); } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error) as ProviderReadResult<AlarmModel>; } },
    async update(physicalId, _previous, desired, context) { if (physicalId !== desired.AlarmName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "AlarmName changes require replacement" }; try { const owned = await this.read(physicalId, context); if (owned.status !== "SUCCESS") return owned as ProviderUpdateResult<AlarmModel>; await cloudwatch.alarms.PutMetricAlarm(alarmInput(desired)); const raw = (await findAnyAlarm(cloudwatch, physicalId))!.raw; await reconcileCloudWatchTags(cloudwatch, raw.AlarmArn, desired.Tags, context); return success(physicalId, alarmFromService(raw, await cloudwatchTags(cloudwatch, raw.AlarmArn)), { Arn: raw.AlarmArn }); } catch (error) { return cfn10Failure(error); } },
    async delete(physicalId, _previous, context) { try { const found = await findAnyAlarm(cloudwatch, physicalId); if (!found || found.kind !== "metric") return { status: "NOT_FOUND", physicalId }; if (!cfn10Owned(await cloudwatchTags(cloudwatch, found.raw.AlarmArn), context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Alarm ${physicalId} is not owned by this stack resource` }; await cloudwatch.alarms.DeleteAlarms({ AlarmNames: [physicalId] }); return { status: "SUCCESS", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10DeleteFailure(error); } },
    ref(model) { return model.physicalId; }, getAtt(model, attribute) { return cfn10GetAtt(CLOUDWATCH_ALARM_TYPE, CLOUDWATCH_ALARM_SCHEMA, model, attribute); },
  };
}

function compositeIssues(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const output = issues(properties, CLOUDWATCH_COMPOSITE_ALARM_SCHEMA); if (!cfn10Record(properties)) return output; if (properties.AlarmName !== undefined) validateName(properties.AlarmName, "Properties.AlarmName", output); if (properties.AlarmDescription !== undefined && (typeof properties.AlarmDescription !== "string" || properties.AlarmDescription.length > 1024)) cfn10Issue(output, "Properties.AlarmDescription", "AlarmDescription must not exceed 1024 characters"); if (properties.AlarmRule !== undefined) try { const parsed = parseAlarmRule(properties.AlarmRule); parsed.children.forEach((reference, index) => compositeReferenceIssues(reference, `Properties.AlarmRule.children[${index}]`, output, context)); } catch (error) { cfn10Issue(output, "Properties.AlarmRule", error instanceof Error ? error.message : String(error)); }
  if (properties.ActionsSuppressor !== undefined) compositeReferenceIssues(properties.ActionsSuppressor, "Properties.ActionsSuppressor", output, context);
  for (const field of ["AlarmActions", "OKActions", "InsufficientDataActions"] as const) if (properties[field] !== undefined) actionIssues(properties[field], `Properties.${field}`, output, context); const suppressor = properties.ActionsSuppressor !== undefined; if (suppressor !== (properties.ActionsSuppressorWaitPeriod !== undefined) || suppressor !== (properties.ActionsSuppressorExtensionPeriod !== undefined)) cfn10Issue(output, "Properties.ActionsSuppressor", "ActionsSuppressor and both suppression periods must be specified together"); for (const field of ["ActionsSuppressorWaitPeriod", "ActionsSuppressorExtensionPeriod"] as const) if (properties[field] !== undefined && !integer(properties[field], 0, 86_400)) cfn10Issue(output, `Properties.${field}`, `${field} must be an integer between 0 and 86400`); try { cfn10Tags(properties.Tags); } catch (error) { cfn10Issue(output, "Properties.Tags", error instanceof Error ? error.message : String(error)); } return output;
}
function canonicalComposite(properties: Cfn10Object, context: ProviderContext): CompositeAlarmModel { return Object.freeze({ ActionsEnabled: properties.ActionsEnabled === undefined ? true : Boolean(properties.ActionsEnabled), ...(properties.ActionsSuppressor !== undefined ? { ActionsSuppressor: referenceName(String(properties.ActionsSuppressor)), ActionsSuppressorExtensionPeriod: Number(properties.ActionsSuppressorExtensionPeriod), ActionsSuppressorWaitPeriod: Number(properties.ActionsSuppressorWaitPeriod) } : {}), AlarmActions: actionList(properties.AlarmActions), ...(properties.AlarmDescription !== undefined ? { AlarmDescription: String(properties.AlarmDescription) } : {}), AlarmName: String(properties.AlarmName ?? cfn10GeneratedName(context, "", 255, /[^A-Za-z0-9_.-]/g)), AlarmRule: String(properties.AlarmRule), InsufficientDataActions: actionList(properties.InsufficientDataActions), OKActions: actionList(properties.OKActions), Tags: cfn10Tags(properties.Tags) }); }
function compositeFromService(raw: any, tags: readonly { Key?: unknown; Value?: unknown }[]): CompositeAlarmModel { return Object.freeze({ ActionsEnabled: Boolean(raw.ActionsEnabled), ...(raw.ActionsSuppressor !== undefined ? { ActionsSuppressor: String(raw.ActionsSuppressor), ActionsSuppressorExtensionPeriod: Number(raw.ActionsSuppressorExtensionPeriod), ActionsSuppressorWaitPeriod: Number(raw.ActionsSuppressorWaitPeriod) } : {}), AlarmActions: actionList(raw.AlarmActions), ...(raw.AlarmDescription !== undefined ? { AlarmDescription: String(raw.AlarmDescription) } : {}), AlarmName: String(raw.AlarmName), AlarmRule: String(raw.AlarmRule), InsufficientDataActions: actionList(raw.InsufficientDataActions), OKActions: actionList(raw.OKActions), Tags: cfn10UserTags(tags) }); }
async function ensureNoCompositeCycle(cloudwatch: CloudWatchMetricsService, desired: CompositeAlarmModel): Promise<void> {
  const graph = new Map<string, string[]>();
  let nextToken: string | undefined;
  do {
    const response = await cloudwatch.alarms.DescribeAlarms({ AlarmTypes: ["CompositeAlarm"], MaxRecords: 100, NextToken: nextToken });
    for (const raw of response.CompositeAlarms ?? []) graph.set(String(raw.AlarmName), parseAlarmRule(raw.AlarmRule).children.map(referenceName));
    nextToken = response.NextToken;
  } while (nextToken);
  graph.set(desired.AlarmName, parseAlarmRule(desired.AlarmRule).children.map(referenceName)); const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (name: string): void => { if (visiting.has(name)) throw new AwsError("InvalidParameterValue", `Composite alarm dependency cycle includes ${name}`); if (visited.has(name)) return; visiting.add(name); for (const child of graph.get(name) ?? []) if (graph.has(child)) visit(child); visiting.delete(name); visited.add(name); }; visit(desired.AlarmName);
}
function referenceName(value: string): string { const match = value.match(/^arn:[^:]+:cloudwatch:[^:]+:\d{12}:alarm:(.+)$/); return match?.[1] ?? value; }
function compositeReferenceIssues(value: unknown, path: string, output: ProviderValidationIssue[], context: ProviderContext): void {
  if (typeof value !== "string") return cfn10Issue(output, path, "Alarm reference must be a string");
  const match = value.match(/^arn:([^:]+):cloudwatch:([^:]+):(\d{12}):alarm:(.+)$/);
  if (match) {
    if (match[1] !== context.partition || match[2] !== context.region || match[3] !== context.accountId) cfn10Issue(output, path, "Composite alarm references must use this partition, account, and Region");
    if (!validAlarmName(match[4])) cfn10Issue(output, path, "Composite alarm ARN contains an invalid alarm name");
  } else if (!validAlarmName(value)) cfn10Issue(output, path, "Composite alarm reference must be an alarm name or ARN");
}

export function createCloudWatchCompositeAlarmProvider(cloudwatch: CloudWatchMetricsService): ProductionResourceProvider<CompositeAlarmModel> {
  return {
    typeName: CLOUDWATCH_COMPOSITE_ALARM_TYPE, providerVersion: 1, visibility: "production", schema: CLOUDWATCH_COMPOSITE_ALARM_SCHEMA,
    validate(properties, context) { return compositeIssues(properties, context); }, canonicalize(properties, context) { const output = this.validate(properties, context); cfn10ThrowIssues(output); return canonicalComposite(properties as Cfn10Object, context); }, plan(previous, desired) { return cfn10Plan(previous, desired, CLOUDWATCH_COMPOSITE_ALARM_SCHEMA); },
    async create(desired, context) { try { const existing = await findAnyAlarm(cloudwatch, desired.AlarmName); if (existing) { if (existing.kind !== "composite") return { status: "FAILED", errorCode: "AlreadyExists", message: `Alarm ${desired.AlarmName} already exists with another alarm type` }; if (!cfn10Owned(await cloudwatchTags(cloudwatch, existing.raw.AlarmArn), context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Composite alarm ${desired.AlarmName} already exists and is not owned by this stack resource` }; } await ensureNoCompositeCycle(cloudwatch, desired); await cloudwatch.alarms.PutCompositeAlarm({ ...desired, Tags: cfn10ServiceTags(desired.Tags, context) }); const raw = (await findAnyAlarm(cloudwatch, desired.AlarmName))!.raw; await reconcileCloudWatchTags(cloudwatch, raw.AlarmArn, desired.Tags, context); return success(desired.AlarmName, compositeFromService(raw, await cloudwatchTags(cloudwatch, raw.AlarmArn)), { Arn: raw.AlarmArn }); } catch (error) { return cfn10Failure(error); } },
    async read(physicalId, context): Promise<ProviderReadResult<CompositeAlarmModel>> { try { const found = await findAnyAlarm(cloudwatch, physicalId); if (!found || found.kind !== "composite") return { status: "NOT_FOUND", physicalId }; const tags = await cloudwatchTags(cloudwatch, found.raw.AlarmArn); if (!cfn10Owned(tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Composite alarm ${physicalId} is not owned by this stack resource` }; return success(physicalId, compositeFromService(found.raw, tags), { Arn: found.raw.AlarmArn }); } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error) as ProviderReadResult<CompositeAlarmModel>; } },
    async update(physicalId, _previous, desired, context) { if (physicalId !== desired.AlarmName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "AlarmName changes require replacement" }; try { const owned = await this.read(physicalId, context); if (owned.status !== "SUCCESS") return owned as ProviderUpdateResult<CompositeAlarmModel>; await ensureNoCompositeCycle(cloudwatch, desired); await cloudwatch.alarms.PutCompositeAlarm({ ...desired, Tags: undefined }); const raw = (await findAnyAlarm(cloudwatch, physicalId))!.raw; await reconcileCloudWatchTags(cloudwatch, raw.AlarmArn, desired.Tags, context); return success(physicalId, compositeFromService(raw, await cloudwatchTags(cloudwatch, raw.AlarmArn)), { Arn: raw.AlarmArn }); } catch (error) { return cfn10Failure(error); } },
    async delete(physicalId, _previous, context) { try { const found = await findAnyAlarm(cloudwatch, physicalId); if (!found || found.kind !== "composite") return { status: "NOT_FOUND", physicalId }; if (!cfn10Owned(await cloudwatchTags(cloudwatch, found.raw.AlarmArn), context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Composite alarm ${physicalId} is not owned by this stack resource` }; await cloudwatch.alarms.DeleteAlarms({ AlarmNames: [physicalId] }); return { status: "SUCCESS", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10DeleteFailure(error); } },
    ref(model) { return model.physicalId; }, getAtt(model, attribute) { return cfn10GetAtt(CLOUDWATCH_COMPOSITE_ALARM_TYPE, CLOUDWATCH_COMPOSITE_ALARM_SCHEMA, model, attribute); },
  };
}

export function createCloudWatchDashboardProvider(cloudwatch: CloudWatchMetricsService): ProductionResourceProvider<DashboardModel> {
  const read = async (name: string): Promise<any | undefined> => { try { return await cloudwatch.dashboards.GetDashboard({ DashboardName: name }); } catch (error) { if (cfn10Missing(error)) return undefined; throw error; } };
  return {
    typeName: CLOUDWATCH_DASHBOARD_TYPE, providerVersion: 1, visibility: "production", schema: CLOUDWATCH_DASHBOARD_SCHEMA,
    validate(properties) { const output = issues(properties, CLOUDWATCH_DASHBOARD_SCHEMA); if (!cfn10Record(properties)) return output; if (properties.DashboardName !== undefined && (typeof properties.DashboardName !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(properties.DashboardName))) cfn10Issue(output, "Properties.DashboardName", "DashboardName must contain 1-255 letters, numbers, hyphens, or underscores"); if (properties.DashboardBody !== undefined) try { validateDashboardBody(properties.DashboardBody); } catch (error) { cfn10Issue(output, "Properties.DashboardBody", error instanceof Error ? error.message : String(error)); } return output; },
    canonicalize(properties, context) { const output = this.validate(properties, context); cfn10ThrowIssues(output); const input = properties as Cfn10Object; return Object.freeze({ DashboardBody: String(input.DashboardBody), DashboardName: String(input.DashboardName ?? cfn10GeneratedName(context, "", 255, /[^A-Za-z0-9_-]/g)) }); }, plan(previous, desired) { return cfn10Plan(previous, desired, CLOUDWATCH_DASHBOARD_SCHEMA); },
    async create(desired) { try { const existing = await read(desired.DashboardName); if (existing) { const current = Object.freeze({ DashboardBody: String(existing.DashboardBody), DashboardName: String(existing.DashboardName) }); if (!cfn10Same(current, desired)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Dashboard ${desired.DashboardName} already exists with different configuration` }; return success(desired.DashboardName, current); } await cloudwatch.dashboards.PutDashboard({ DashboardName: desired.DashboardName, DashboardBody: desired.DashboardBody }); return success(desired.DashboardName, desired); } catch (error) { return cfn10Failure(error); } },
    async read(physicalId): Promise<ProviderReadResult<DashboardModel>> { try { const raw = await read(physicalId); return raw ? success(physicalId, Object.freeze({ DashboardBody: String(raw.DashboardBody), DashboardName: String(raw.DashboardName) })) : { status: "NOT_FOUND", physicalId }; } catch (error) { return cfn10Failure(error) as ProviderReadResult<DashboardModel>; } },
    async update(physicalId, _previous, desired) { if (physicalId !== desired.DashboardName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "DashboardName changes require replacement" }; try { await cloudwatch.dashboards.PutDashboard({ DashboardName: physicalId, DashboardBody: desired.DashboardBody }); return success(physicalId, desired); } catch (error) { return cfn10Failure(error); } },
    async delete(physicalId) { try { if (!await read(physicalId)) return { status: "NOT_FOUND", physicalId }; await cloudwatch.dashboards.DeleteDashboards({ DashboardNames: [physicalId] }); return { status: "SUCCESS", physicalId }; } catch (error) { return cfn10DeleteFailure(error); } },
    ref(model) { return model.physicalId; }, getAtt(model, attribute) { return cfn10GetAtt(CLOUDWATCH_DASHBOARD_TYPE, CLOUDWATCH_DASHBOARD_SCHEMA, model, attribute); },
  };
}

function anomalyConfigurationIssues(value: unknown, path: string, output: ProviderValidationIssue[]): void {
  if (!cfn10Record(value)) return cfn10Issue(output, path, "Configuration must be an object"); cfn10ExactKeys(value, ["ExcludedTimeRanges", "MetricTimeZone"], path, output); if (value.MetricTimeZone !== undefined) { if (typeof value.MetricTimeZone !== "string" || !value.MetricTimeZone || value.MetricTimeZone.length > 50) cfn10Issue(output, `${path}.MetricTimeZone`, "MetricTimeZone is invalid"); else try { new Intl.DateTimeFormat("en-US", { timeZone: value.MetricTimeZone }).format(0); } catch { cfn10Issue(output, `${path}.MetricTimeZone`, "MetricTimeZone must be a tz database name"); } } if (value.ExcludedTimeRanges !== undefined) { if (!Array.isArray(value.ExcludedTimeRanges) || value.ExcludedTimeRanges.length > 10) cfn10Issue(output, `${path}.ExcludedTimeRanges`, "ExcludedTimeRanges can contain at most 10 entries"); else value.ExcludedTimeRanges.forEach((range, index) => { const rangePath = `${path}.ExcludedTimeRanges[${index}]`; if (!cfn10Record(range)) return cfn10Issue(output, rangePath, "Excluded range must be an object"); cfn10ExactKeys(range, ["EndTime", "StartTime"], rangePath, output); const start = Date.parse(String(range.StartTime ?? "")); const end = Date.parse(String(range.EndTime ?? "")); if (!Number.isFinite(start)) cfn10Issue(output, `${rangePath}.StartTime`, "StartTime must be a timestamp"); if (!Number.isFinite(end)) cfn10Issue(output, `${rangePath}.EndTime`, "EndTime must be a timestamp"); if (Number.isFinite(start) && Number.isFinite(end) && start >= end) cfn10Issue(output, rangePath, "Excluded range must start before it ends"); }); } }
function validAnomalyStat(value: unknown): boolean {
  const result = String(value ?? "");
  return result.length <= 50 && (["SampleCount", "Average", "Sum", "Minimum", "Maximum", "IQM"].includes(result) || /^(?:p|tc|tm|ts|wm|[ou])\d+(?:\.\d+)?(?:_[ELH])?$/i.test(result));
}
function singleAnomalyIssues(value: unknown, path: string, output: ProviderValidationIssue[], context: ProviderContext): void { if (!cfn10Record(value)) return cfn10Issue(output, path, `${path} must be an object`); cfn10ExactKeys(value, ["AccountId", "Dimensions", "MetricName", "Namespace", "Stat"], path, output); if (value.AccountId !== undefined && value.AccountId !== context.accountId) cfn10Issue(output, `${path}.AccountId`, "Cross-account anomaly detectors are unavailable"); for (const field of ["MetricName", "Namespace"] as const) if (typeof value[field] !== "string" || !value[field] || String(value[field]).length > 255) cfn10Issue(output, `${path}.${field}`, `${field} must contain 1-255 characters`); if (!validAnomalyStat(value.Stat)) cfn10Issue(output, `${path}.Stat`, "Stat must be a supported statistic or extended statistic"); if (value.Dimensions !== undefined) validateDimensions(value.Dimensions, `${path}.Dimensions`, output); }
function anomalyIssues(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const output = issues(properties, CLOUDWATCH_ANOMALY_DETECTOR_SCHEMA); if (!cfn10Record(properties)) return output; const legacy = ["Dimensions", "MetricName", "Namespace", "Stat"].some(field => properties[field] !== undefined); const single = properties.SingleMetricAnomalyDetector !== undefined; const math = properties.MetricMathAnomalyDetector !== undefined; if ([legacy, single, math].filter(Boolean).length !== 1) cfn10Issue(output, "Properties", "Specify exactly one legacy, SingleMetricAnomalyDetector, or MetricMathAnomalyDetector identity"); if (legacy) singleAnomalyIssues({ AccountId: context.accountId, Dimensions: properties.Dimensions, MetricName: properties.MetricName, Namespace: properties.Namespace, Stat: properties.Stat }, "Properties", output, context); if (single) singleAnomalyIssues(properties.SingleMetricAnomalyDetector, "Properties.SingleMetricAnomalyDetector", output, context); if (math) {
    if (!cfn10Record(properties.MetricMathAnomalyDetector)) cfn10Issue(output, "Properties.MetricMathAnomalyDetector", "MetricMathAnomalyDetector must be an object");
    else {
      cfn10ExactKeys(properties.MetricMathAnomalyDetector, ["MetricDataQueries"], "Properties.MetricMathAnomalyDetector", output);
      const queries = properties.MetricMathAnomalyDetector.MetricDataQueries;
      validateMetricQueries(queries, "Properties.MetricMathAnomalyDetector.MetricDataQueries", output);
      if (Array.isArray(queries)) {
        const records = queries.filter(cfn10Record);
        const metricCount = records.filter(query => query.MetricStat !== undefined).length;
        const expressionCount = records.filter(query => query.Expression !== undefined).length;
        if (metricCount > 10 || expressionCount > 10) cfn10Issue(output, "Properties.MetricMathAnomalyDetector.MetricDataQueries", "Metric-math anomaly detectors support at most 10 metrics and 10 expressions");
        if (records.some(query => /^\s*ANOMALY_DETECTION_BAND\s*\(/i.test(String(query.Expression ?? "")))) cfn10Issue(output, "Properties.MetricMathAnomalyDetector.MetricDataQueries", "An anomaly detector source cannot contain ANOMALY_DETECTION_BAND");
        const returned = records.filter(query => query.ReturnData === true);
        if (returned.length !== 1 || returned[0]?.Expression === undefined) cfn10Issue(output, "Properties.MetricMathAnomalyDetector.MetricDataQueries", "Exactly one metric-math expression must set ReturnData to true");
      }
    }
  } if (properties.Configuration !== undefined) anomalyConfigurationIssues(properties.Configuration, "Properties.Configuration", output); if (properties.MetricCharacteristics !== undefined) { if (!cfn10Record(properties.MetricCharacteristics)) cfn10Issue(output, "Properties.MetricCharacteristics", "MetricCharacteristics must be an object"); else { cfn10ExactKeys(properties.MetricCharacteristics, ["PeriodicSpikes"], "Properties.MetricCharacteristics", output); if (typeof properties.MetricCharacteristics.PeriodicSpikes !== "boolean") cfn10Issue(output, "Properties.MetricCharacteristics.PeriodicSpikes", "PeriodicSpikes must be boolean"); } } return output;
}
function anomalyConfig(value: unknown): AnomalyConfigurationModel { const input = cfn10Record(value) ? value : {}; return Object.freeze({ ExcludedTimeRanges: Object.freeze((Array.isArray(input.ExcludedTimeRanges) ? input.ExcludedTimeRanges : []).map(range => { const item = range as Cfn10Object; return Object.freeze({ StartTime: new Date(String(item.StartTime)).toISOString(), EndTime: new Date(String(item.EndTime)).toISOString() }); }).sort((left, right) => left.StartTime.localeCompare(right.StartTime) || left.EndTime.localeCompare(right.EndTime))), ...(input.MetricTimeZone !== undefined ? { MetricTimeZone: String(input.MetricTimeZone) } : {}) }); }
function canonicalAnomaly(properties: Cfn10Object, context: ProviderContext): AnomalyDetectorModel { const legacy = ["Dimensions", "MetricName", "Namespace", "Stat"].some(field => properties[field] !== undefined); const single = (legacy ? { AccountId: context.accountId, Dimensions: properties.Dimensions, MetricName: properties.MetricName, Namespace: properties.Namespace, Stat: properties.Stat } : properties.SingleMetricAnomalyDetector) as Cfn10Object | undefined; return Object.freeze({ Configuration: anomalyConfig(properties.Configuration), ...(properties.MetricCharacteristics !== undefined ? { MetricCharacteristics: Object.freeze({ PeriodicSpikes: Boolean((properties.MetricCharacteristics as Cfn10Object).PeriodicSpikes) }) } : {}), ...(single ? { SingleMetricAnomalyDetector: Object.freeze({ ...(single.AccountId !== undefined ? { AccountId: String(single.AccountId) } : {}), Dimensions: dimensions(single.Dimensions), MetricName: String(single.MetricName), Namespace: String(single.Namespace), Stat: String(single.Stat) }) } : { MetricMathAnomalyDetector: Object.freeze({ MetricDataQueries: Object.freeze((((properties.MetricMathAnomalyDetector as Cfn10Object).MetricDataQueries as unknown[]) ?? []).map(item => Object.freeze(cfn10Stable(item as Cfn10Object)))) }) }) }); }
function anomalyInput(model: AnomalyDetectorModel): Cfn10Object { return { Configuration: { ExcludedTimeRanges: model.Configuration.ExcludedTimeRanges.map(range => ({ StartTime: range.StartTime, EndTime: range.EndTime })), MetricTimezone: model.Configuration.MetricTimeZone }, ...(model.MetricCharacteristics ? { MetricCharacteristics: model.MetricCharacteristics } : {}), ...(model.SingleMetricAnomalyDetector ? { SingleMetricAnomalyDetector: model.SingleMetricAnomalyDetector } : { MetricMathAnomalyDetector: model.MetricMathAnomalyDetector }) }; }
function anomalyFromService(raw: any): AnomalyDetectorModel { const configuration = raw.Configuration ?? {}; return Object.freeze({ Configuration: Object.freeze({ ExcludedTimeRanges: Object.freeze((configuration.ExcludedTimeRanges ?? []).map((range: any) => Object.freeze({ StartTime: new Date(range.StartTime).toISOString(), EndTime: new Date(range.EndTime).toISOString() })).sort((left: any, right: any) => left.StartTime.localeCompare(right.StartTime))), ...(configuration.MetricTimezone ? { MetricTimeZone: String(configuration.MetricTimezone) } : {}) }), ...(raw.MetricCharacteristics ? { MetricCharacteristics: Object.freeze({ PeriodicSpikes: Boolean(raw.MetricCharacteristics.PeriodicSpikes) }) } : {}), ...(raw.SingleMetricAnomalyDetector ? { SingleMetricAnomalyDetector: Object.freeze({ ...(raw.SingleMetricAnomalyDetector.AccountId ? { AccountId: String(raw.SingleMetricAnomalyDetector.AccountId) } : {}), Dimensions: dimensions(raw.SingleMetricAnomalyDetector.Dimensions), MetricName: String(raw.SingleMetricAnomalyDetector.MetricName), Namespace: String(raw.SingleMetricAnomalyDetector.Namespace), Stat: String(raw.SingleMetricAnomalyDetector.Stat) }) } : { MetricMathAnomalyDetector: Object.freeze({ MetricDataQueries: Object.freeze(raw.MetricMathAnomalyDetector.MetricDataQueries.map((item: any) => Object.freeze(cfn10Stable(item)))) }) }) }); }
async function findAnomalyById(cloudwatch: CloudWatchMetricsService, id: string): Promise<any | undefined> { return (await cloudwatch.anomalies.DescribeAnomalyDetectors({ AnomalyDetectorIds: [id], AnomalyDetectorTypes: undefined })).AnomalyDetectors?.find((item: any) => item.AnomalyDetectorId === id); }
async function findAnomalyByModel(cloudwatch: CloudWatchMetricsService, desired: AnomalyDetectorModel): Promise<any | undefined> {
  let nextToken: string | undefined;
  do {
    const page = await cloudwatch.anomalies.DescribeAnomalyDetectors({ AnomalyDetectorTypes: [desired.SingleMetricAnomalyDetector ? "SINGLE_METRIC" : "METRIC_MATH"], MaxResults: 100, NextToken: nextToken });
    const found = page.AnomalyDetectors?.find((item: any) => {
      const current = anomalyFromService(item); const left = { ...current, Configuration: undefined, MetricCharacteristics: undefined }; const right = { ...desired, Configuration: undefined, MetricCharacteristics: undefined };
      return cfn10Same(left, right);
    });
    if (found) return found;
    nextToken = page.NextToken;
  } while (nextToken);
  return undefined;
}

export function createCloudWatchAnomalyDetectorProvider(cloudwatch: CloudWatchMetricsService): ProductionResourceProvider<AnomalyDetectorModel> {
  return {
    typeName: CLOUDWATCH_ANOMALY_DETECTOR_TYPE, providerVersion: 1, visibility: "production", schema: CLOUDWATCH_ANOMALY_DETECTOR_SCHEMA,
    validate(properties, context) { return anomalyIssues(properties, context); }, canonicalize(properties, context) { const output = this.validate(properties, context); cfn10ThrowIssues(output); return canonicalAnomaly(properties as Cfn10Object, context); }, plan(previous, desired) {
      const plan = cfn10Plan(previous, desired, CLOUDWATCH_ANOMALY_DETECTOR_SCHEMA);
      // MetricCharacteristics is replacement-only, but it is not part of the
      // backing service identity. Creating first would therefore collide with
      // the detector that is being replaced. Identity-changing replacements
      // remain create-before-delete so the old detector is preserved on error.
      if (previous && plan.action === "REPLACE"
        && plan.replacementProperties.length === 1
        && plan.replacementProperties[0] === "MetricCharacteristics") {
        return { ...plan, replacementOrder: "DELETE_BEFORE_CREATE" };
      }
      return plan;
    },
    async create(desired) { try { const existing = await findAnomalyByModel(cloudwatch, desired); if (existing) { const current = anomalyFromService(existing); if (!cfn10Same(current, desired)) return { status: "FAILED", errorCode: "AlreadyExists", message: "An anomaly detector with this metric identity already exists with different configuration" }; return success(String(existing.AnomalyDetectorId), current, { Id: String(existing.AnomalyDetectorId) }); } const response = await cloudwatch.anomalies.PutAnomalyDetector(anomalyInput(desired)); const id = String(response.AnomalyDetectorId); return success(id, anomalyFromService((await findAnomalyById(cloudwatch, id))!), { Id: id }); } catch (error) { return cfn10Failure(error); } },
    async read(physicalId): Promise<ProviderReadResult<AnomalyDetectorModel>> { try { const raw = await findAnomalyById(cloudwatch, physicalId); return raw ? success(physicalId, anomalyFromService(raw), { Id: physicalId }) : { status: "NOT_FOUND", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error) as ProviderReadResult<AnomalyDetectorModel>; } },
    async update(physicalId, previous, desired) { const plan = cfn10Plan(previous, desired, CLOUDWATCH_ANOMALY_DETECTOR_SCHEMA); if (plan.action === "REPLACE") return { status: "FAILED", errorCode: "RequiresReplacement", message: `${plan.replacementProperties.join(", ")} changes require replacement` }; try { if (!await findAnomalyById(cloudwatch, physicalId)) return { status: "FAILED", errorCode: "NotFound", message: `Anomaly detector ${physicalId} no longer exists` }; const response = await cloudwatch.anomalies.PutAnomalyDetector(anomalyInput(desired)); if (String(response.AnomalyDetectorId) !== physicalId) return { status: "FAILED", errorCode: "RequiresReplacement", message: "Anomaly detector identity changed during an in-place update" }; return success(physicalId, anomalyFromService((await findAnomalyById(cloudwatch, physicalId))!), { Id: physicalId }); } catch (error) { return cfn10Failure(error); } },
    async delete(physicalId) { try { if (!await findAnomalyById(cloudwatch, physicalId)) return { status: "NOT_FOUND", physicalId }; await cloudwatch.anomalies.DeleteAnomalyDetector({ AnomalyDetectorId: physicalId }); return { status: "SUCCESS", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10DeleteFailure(error); } },
    ref(model) { return model.physicalId; }, getAtt(model, attribute) { return cfn10GetAtt(CLOUDWATCH_ANOMALY_DETECTOR_TYPE, CLOUDWATCH_ANOMALY_DETECTOR_SCHEMA, model, attribute); },
  };
}

function insightIssues(properties: unknown): ProviderValidationIssue[] { const output = issues(properties, CLOUDWATCH_INSIGHT_RULE_SCHEMA); if (!cfn10Record(properties)) return output; if (properties.RuleName !== undefined && (typeof properties.RuleName !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(properties.RuleName))) cfn10Issue(output, "Properties.RuleName", "RuleName must contain 1-128 letters, numbers, periods, hyphens, or underscores"); if (properties.RuleState !== undefined && !["ENABLED", "DISABLED"].includes(String(properties.RuleState))) cfn10Issue(output, "Properties.RuleState", "RuleState must be ENABLED or DISABLED"); if (properties.ApplyOnTransformedLogs !== undefined && properties.ApplyOnTransformedLogs !== false) cfn10Issue(output, "Properties.ApplyOnTransformedLogs", "ApplyOnTransformedLogs can only be false because Logs transformers are dependency-blocked"); if (properties.RuleBody !== undefined) { if (typeof properties.RuleBody !== "string" || Buffer.byteLength(properties.RuleBody) < 1 || Buffer.byteLength(properties.RuleBody) > 8192 || /[^\x00-\x7f]/.test(properties.RuleBody)) cfn10Issue(output, "Properties.RuleBody", "RuleBody must contain 1-8192 ASCII bytes"); else try { const body = JSON.parse(properties.RuleBody); if (!cfn10Record(body) || !cfn10Record(body.Schema) || body.Schema.Name !== "CloudWatchLogRule" || body.Schema.Version !== 1) throw new Error(); } catch { cfn10Issue(output, "Properties.RuleBody", "RuleBody must be valid CloudWatchLogRule version 1 JSON"); } } try { cfn10Tags(properties.Tags); } catch (error) { cfn10Issue(output, "Properties.Tags", error instanceof Error ? error.message : String(error)); } return output; }
async function findInsight(cloudwatch: CloudWatchMetricsService, name: string): Promise<any | undefined> { let token: string | undefined; do { const page = await cloudwatch.insightRules.DescribeInsightRules({ MaxResults: 500, NextToken: token }); const found = page.InsightRules?.find((item: any) => item.Name === name); if (found) return found; token = page.NextToken; } while (token); return undefined; }
function insightArn(context: ProviderContext, name: string): string { return `arn:${context.partition}:cloudwatch:${context.region}:${context.accountId}:insight-rule/${name}`; }
function insightModel(raw: any, tags: readonly { Key?: unknown; Value?: unknown }[]): InsightRuleModel { return Object.freeze({ ApplyOnTransformedLogs: false, RuleBody: String(raw.Definition), RuleName: String(raw.Name), RuleState: String(raw.State) as InsightRuleModel["RuleState"], Tags: cfn10UserTags(tags) }); }

export function createCloudWatchInsightRuleProvider(cloudwatch: CloudWatchMetricsService): ProductionResourceProvider<InsightRuleModel> {
  return {
    typeName: CLOUDWATCH_INSIGHT_RULE_TYPE, providerVersion: 1, visibility: "production", schema: CLOUDWATCH_INSIGHT_RULE_SCHEMA,
    validate(properties) { return insightIssues(properties); }, canonicalize(properties, context) { const output = this.validate(properties, context); cfn10ThrowIssues(output); const input = properties as Cfn10Object; return Object.freeze({ ApplyOnTransformedLogs: false, RuleBody: String(input.RuleBody), RuleName: String(input.RuleName), RuleState: String(input.RuleState) as InsightRuleModel["RuleState"], Tags: cfn10Tags(input.Tags) }); }, plan(previous, desired) { return cfn10Plan(previous, desired, CLOUDWATCH_INSIGHT_RULE_SCHEMA); },
    async create(desired, context) { const arn = insightArn(context, desired.RuleName); try { const existing = await findInsight(cloudwatch, desired.RuleName); if (existing && !cfn10Owned(await cloudwatchTags(cloudwatch, arn), context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Insight rule ${desired.RuleName} already exists and is not owned by this stack resource` }; await cloudwatch.insightRules.PutInsightRule({ RuleName: desired.RuleName, RuleDefinition: desired.RuleBody, RuleState: desired.RuleState, ApplyOnTransformedLogs: desired.ApplyOnTransformedLogs, Tags: cfn10ServiceTags(desired.Tags, context) }); await reconcileCloudWatchTags(cloudwatch, arn, desired.Tags, context); const raw = (await findInsight(cloudwatch, desired.RuleName))!; return success(desired.RuleName, insightModel(raw, await cloudwatchTags(cloudwatch, arn)), { Arn: arn, Id: desired.RuleName, RuleName: desired.RuleName }); } catch (error) { return cfn10Failure(error); } },
    async read(physicalId, context): Promise<ProviderReadResult<InsightRuleModel>> { const arn = insightArn(context, physicalId); try { const raw = await findInsight(cloudwatch, physicalId); if (!raw) return { status: "NOT_FOUND", physicalId }; const tags = await cloudwatchTags(cloudwatch, arn); if (!cfn10Owned(tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Insight rule ${physicalId} is not owned by this stack resource` }; return success(physicalId, insightModel(raw, tags), { Arn: arn, Id: physicalId, RuleName: physicalId }); } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error) as ProviderReadResult<InsightRuleModel>; } },
    async update(physicalId, _previous, desired, context) { if (physicalId !== desired.RuleName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "RuleName changes require replacement" }; const arn = insightArn(context, physicalId); try { const owned = await this.read(physicalId, context); if (owned.status !== "SUCCESS") return owned as ProviderUpdateResult<InsightRuleModel>; await cloudwatch.insightRules.PutInsightRule({ RuleName: physicalId, RuleDefinition: desired.RuleBody, RuleState: desired.RuleState, ApplyOnTransformedLogs: desired.ApplyOnTransformedLogs }); await reconcileCloudWatchTags(cloudwatch, arn, desired.Tags, context); return success(physicalId, insightModel((await findInsight(cloudwatch, physicalId))!, await cloudwatchTags(cloudwatch, arn)), { Arn: arn, Id: physicalId, RuleName: physicalId }); } catch (error) { return cfn10Failure(error); } },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> { const arn = insightArn(context, physicalId); try { if (!await findInsight(cloudwatch, physicalId)) return { status: "NOT_FOUND", physicalId }; if (!cfn10Owned(await cloudwatchTags(cloudwatch, arn), context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Insight rule ${physicalId} is not owned by this stack resource` }; const result = await cloudwatch.insightRules.DeleteInsightRules({ RuleNames: [physicalId] }); if (result.Failures?.length) return { status: "FAILED", errorCode: String(result.Failures[0].FailureCode ?? "DeleteFailed"), message: String(result.Failures[0].FailureDescription ?? "Insight rule deletion failed") }; return { status: "SUCCESS", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10DeleteFailure(error); } },
    ref(model) { return model.attributes.Arn; }, getAtt(model, attribute) { return cfn10GetAtt(CLOUDWATCH_INSIGHT_RULE_TYPE, CLOUDWATCH_INSIGHT_RULE_SCHEMA, model, attribute); },
  };
}

export function createCloudWatchCfn10Providers(cloudwatch: CloudWatchMetricsService): readonly ProductionResourceProvider<any>[] {
  return Object.freeze([createCloudWatchAlarmProvider(cloudwatch), createCloudWatchCompositeAlarmProvider(cloudwatch), createCloudWatchDashboardProvider(cloudwatch), createCloudWatchAnomalyDetectorProvider(cloudwatch), createCloudWatchInsightRuleProvider(cloudwatch)]);
}
