import type { CloudWatchMetricsService } from "../../cloudwatch-metrics.js";
import {
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderSuccess,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";
import {
  CFN10_OWNER_TAG,
  CFN10_RETENTION,
  CFN10_STACK_TAGS,
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
  cfn10TagMap,
  cfn10Tags,
  cfn10UserTags,
  type Cfn10Tag,
} from "./cfn10-common.js";

export const CLOUDWATCH_METRIC_STREAM_TYPE = "AWS::CloudWatch::MetricStream";

export interface CloudWatchMetricStreamFilterModel {
  readonly Namespace: string;
  readonly MetricNames?: readonly string[];
}

export interface CloudWatchMetricStreamStatisticsModel {
  readonly AdditionalStatistics: readonly string[];
  readonly IncludeMetrics: readonly { readonly MetricName: string; readonly Namespace: string }[];
}

export interface CloudWatchMetricStreamModel {
  readonly Name: string;
  readonly FirehoseArn: string;
  readonly RoleArn: string;
  readonly OutputFormat: "json";
  readonly IncludeFilters?: readonly CloudWatchMetricStreamFilterModel[];
  readonly ExcludeFilters?: readonly CloudWatchMetricStreamFilterModel[];
  readonly IncludeLinkedAccountsMetrics: false;
  readonly StatisticsConfigurations?: readonly CloudWatchMetricStreamStatisticsModel[];
  readonly Tags: readonly Cfn10Tag[];
}

export const CLOUDWATCH_METRIC_STREAM_SCHEMA: ProviderSchema = Object.freeze({
  typeName: CLOUDWATCH_METRIC_STREAM_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ExcludeFilters: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    FirehoseArn: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE", description: "Executable local file:// directory destination." }),
    IncludeFilters: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    IncludeLinkedAccountsMetrics: Object.freeze({ valueType: "boolean", updateBehavior: "NOT_SUPPORTED", description: "Only absent or false is supported by the single-account simulator." }),
    Name: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    OutputFormat: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE", description: "The executable local destination supports json." }),
    RoleArn: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    StatisticsConfigurations: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Metric stream name" }),
  attributes: Object.freeze({
    Arn: Object.freeze({ valueType: "string" }),
    CreationDate: Object.freeze({ valueType: "string" }),
    LastUpdateDate: Object.freeze({ valueType: "string" }),
    State: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: CFN10_RETENTION,
  tags: CFN10_STACK_TAGS,
});

function printable(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255 && value.trim().length > 0 && !/[^\x20-\x7e]/.test(value);
}

function percentile(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^p(100(?:\.0{1,10})?|\d{1,2}(?:\.\d{1,10})?)$/i.exec(value);
  return Boolean(match && Number(match[1]) >= 0 && Number(match[1]) <= 100);
}

function validateFilters(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!Array.isArray(value)) return;
  const namespaces = new Set<string>();
  let total = 0;
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}.${index}`;
    if (!cfn10Record(item)) {
      cfn10Issue(issues, itemPath, "Metric stream filters must be objects");
      continue;
    }
    cfn10ExactKeys(item, ["MetricNames", "Namespace"], itemPath, issues);
    if (!printable(item.Namespace) || String(item.Namespace).startsWith(":")) cfn10Issue(issues, `${itemPath}.Namespace`, "Namespace must contain 1-255 printable ASCII characters and must not start with a colon");
    else if (namespaces.has(item.Namespace)) cfn10Issue(issues, `${itemPath}.Namespace`, "Filter namespaces must be unique");
    else namespaces.add(item.Namespace);
    total++;
    if (item.MetricNames !== undefined) {
      if (!Array.isArray(item.MetricNames) || item.MetricNames.some(name => !printable(name))) cfn10Issue(issues, `${itemPath}.MetricNames`, "MetricNames must be an array of printable 1-255 character strings");
      else {
        if (new Set(item.MetricNames).size !== item.MetricNames.length) cfn10Issue(issues, `${itemPath}.MetricNames`, "MetricNames must be unique");
        total += item.MetricNames.length;
      }
    }
  }
  if (total > 1_000) cfn10Issue(issues, path, "Filters support at most 1000 total namespaces and metric names");
}

function validateStatistics(value: unknown, issues: ProviderValidationIssue[]): void {
  const path = "Properties.StatisticsConfigurations";
  if (!Array.isArray(value)) return;
  if (value.length > 100) cfn10Issue(issues, path, "StatisticsConfigurations supports at most 100 entries");
  const configured = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}.${index}`;
    if (!cfn10Record(item)) {
      cfn10Issue(issues, itemPath, "Statistics configuration entries must be objects");
      continue;
    }
    cfn10ExactKeys(item, ["AdditionalStatistics", "IncludeMetrics"], itemPath, issues);
    if (!Array.isArray(item.AdditionalStatistics) || item.AdditionalStatistics.length < 1 || item.AdditionalStatistics.length > 20 || item.AdditionalStatistics.some(statistic => !percentile(statistic)) || new Set(item.AdditionalStatistics).size !== item.AdditionalStatistics.length) {
      cfn10Issue(issues, `${itemPath}.AdditionalStatistics`, "AdditionalStatistics must contain 1-20 unique percentile statistics such as p90 or p99.9");
    }
    if (!Array.isArray(item.IncludeMetrics) || item.IncludeMetrics.length < 1 || item.IncludeMetrics.length > 100) {
      cfn10Issue(issues, `${itemPath}.IncludeMetrics`, "IncludeMetrics must contain 1-100 metrics");
      continue;
    }
    for (const [metricIndex, metric] of item.IncludeMetrics.entries()) {
      const metricPath = `${itemPath}.IncludeMetrics.${metricIndex}`;
      if (!cfn10Record(metric)) {
        cfn10Issue(issues, metricPath, "Included metrics must be objects");
        continue;
      }
      cfn10ExactKeys(metric, ["MetricName", "Namespace"], metricPath, issues);
      if (!printable(metric.Namespace) || String(metric.Namespace).startsWith(":")) cfn10Issue(issues, `${metricPath}.Namespace`, "Namespace must contain 1-255 printable ASCII characters and must not start with a colon");
      if (!printable(metric.MetricName)) cfn10Issue(issues, `${metricPath}.MetricName`, "MetricName must contain 1-255 printable ASCII characters");
      if (printable(metric.Namespace) && printable(metric.MetricName)) {
        const key = `${metric.Namespace}\0${metric.MetricName}`;
        if (configured.has(key)) cfn10Issue(issues, metricPath, "A metric can appear in only one statistics configuration");
        configured.add(key);
      }
    }
  }
}

function validation(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, CLOUDWATCH_METRIC_STREAM_SCHEMA);
  if (!cfn10Record(properties)) return issues;
  if (properties.Name !== undefined && (typeof properties.Name !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(properties.Name))) cfn10Issue(issues, "Properties.Name", "Name must contain 1-255 letters, numbers, hyphens, or underscores");
  if (typeof properties.FirehoseArn === "string") {
    try {
      const destination = new URL(properties.FirehoseArn);
      if (destination.protocol !== "file:" || destination.search || destination.hash) throw new Error();
    } catch {
      cfn10Issue(issues, "Properties.FirehoseArn", "The supported executable destination is an absolute file:// directory URL");
    }
  }
  if (typeof properties.RoleArn === "string") {
    const match = /^arn:(aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/.+$/.exec(properties.RoleArn);
    if (!match || match[1] !== context.partition || match[2] !== context.accountId || properties.RoleArn.length > 1_024) cfn10Issue(issues, "Properties.RoleArn", "RoleArn must identify an IAM role in this simulator account and partition");
  }
  if (properties.OutputFormat !== undefined && properties.OutputFormat !== "json") cfn10Issue(issues, "Properties.OutputFormat", "The executable local metric-stream destination supports OutputFormat json");
  if (properties.IncludeFilters !== undefined && properties.ExcludeFilters !== undefined) cfn10Issue(issues, "Properties.IncludeFilters", "IncludeFilters and ExcludeFilters cannot both be specified");
  if (properties.IncludeFilters !== undefined) validateFilters(properties.IncludeFilters, "Properties.IncludeFilters", issues);
  if (properties.ExcludeFilters !== undefined) validateFilters(properties.ExcludeFilters, "Properties.ExcludeFilters", issues);
  if (properties.IncludeLinkedAccountsMetrics !== undefined && properties.IncludeLinkedAccountsMetrics !== false) cfn10Issue(issues, "Properties.IncludeLinkedAccountsMetrics", "Linked-account metrics are unavailable in the single-account simulator");
  if (properties.StatisticsConfigurations !== undefined) validateStatistics(properties.StatisticsConfigurations, issues);
  if (properties.Tags !== undefined) {
    try { cfn10Tags(properties.Tags, 49); } catch (error) { cfn10Issue(issues, "Properties.Tags", error instanceof Error ? error.message : String(error)); }
  }
  return issues;
}

function canonicalFilters(value: unknown): readonly CloudWatchMetricStreamFilterModel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return Object.freeze(value.map(item => {
    const filter = item as Record<string, unknown>;
    return Object.freeze({
      Namespace: String(filter.Namespace),
      ...(Array.isArray(filter.MetricNames) && filter.MetricNames.length ? { MetricNames: Object.freeze(filter.MetricNames.map(String).sort()) } : {}),
    });
  }).sort((left, right) => left.Namespace.localeCompare(right.Namespace)));
}

function canonicalStatistics(value: unknown): readonly CloudWatchMetricStreamStatisticsModel[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  return Object.freeze(value.map(item => {
    const configuration = item as Record<string, unknown>;
    const metrics = (configuration.IncludeMetrics as Record<string, unknown>[]).map(metric => Object.freeze({ MetricName: String(metric.MetricName), Namespace: String(metric.Namespace) }))
      .sort((left, right) => left.Namespace.localeCompare(right.Namespace) || left.MetricName.localeCompare(right.MetricName));
    return Object.freeze({
      AdditionalStatistics: Object.freeze((configuration.AdditionalStatistics as unknown[]).map(String).sort()),
      IncludeMetrics: Object.freeze(metrics),
    });
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function model(properties: Record<string, unknown>, context: ProviderContext): CloudWatchMetricStreamModel {
  return Object.freeze({
    Name: String(properties.Name ?? cfn10GeneratedName(context, "metric-stream-", 255, /[^A-Za-z0-9_-]/g)),
    FirehoseArn: String(properties.FirehoseArn),
    RoleArn: String(properties.RoleArn),
    OutputFormat: "json" as const,
    ...(properties.IncludeFilters !== undefined ? { IncludeFilters: canonicalFilters(properties.IncludeFilters)! } : {}),
    ...(properties.ExcludeFilters !== undefined ? { ExcludeFilters: canonicalFilters(properties.ExcludeFilters)! } : {}),
    IncludeLinkedAccountsMetrics: false as const,
    ...(properties.StatisticsConfigurations !== undefined && (properties.StatisticsConfigurations as unknown[]).length ? { StatisticsConfigurations: canonicalStatistics(properties.StatisticsConfigurations)! } : {}),
    Tags: cfn10Tags(properties.Tags, 49),
  });
}

interface MetricStreamSnapshot {
  readonly model: CloudWatchMetricStreamModel;
  readonly arn: string;
  readonly state: string;
  readonly creationDate: string;
  readonly lastUpdateDate: string;
  readonly tags: readonly { Key: string; Value: string }[];
}

function isoDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(value as string | number);
  return date.toISOString();
}

function success(snapshot: MetricStreamSnapshot): ProviderSuccess<CloudWatchMetricStreamModel> {
  return {
    status: "SUCCESS",
    physicalId: snapshot.model.Name,
    model: {
      physicalId: snapshot.model.Name,
      properties: snapshot.model,
      attributes: {
        Arn: snapshot.arn,
        CreationDate: snapshot.creationDate,
        LastUpdateDate: snapshot.lastUpdateDate,
        State: snapshot.state,
      },
    },
  };
}

function streamInput(stream: CloudWatchMetricStreamModel): Record<string, unknown> {
  return {
    Name: stream.Name,
    FirehoseArn: stream.FirehoseArn,
    RoleArn: stream.RoleArn,
    OutputFormat: stream.OutputFormat,
    ...(stream.IncludeFilters ? { IncludeFilters: stream.IncludeFilters } : {}),
    ...(stream.ExcludeFilters ? { ExcludeFilters: stream.ExcludeFilters } : {}),
    IncludeLinkedAccountsMetrics: false,
    ...(stream.StatisticsConfigurations ? { StatisticsConfigurations: stream.StatisticsConfigurations } : {}),
  };
}

export function createCloudWatchMetricStreamProvider(metrics: CloudWatchMetricsService): ProductionResourceProvider<CloudWatchMetricStreamModel> {
  const describe = async (name: string): Promise<MetricStreamSnapshot> => {
    const stream = await metrics.metricStreams.GetMetricStream({ Name: name });
    const tagResult = await metrics.ListTagsForResource({ ResourceARN: stream.Arn });
    const tags = (tagResult.Tags ?? []) as Array<{ Key: string; Value: string }>;
    const current: CloudWatchMetricStreamModel = Object.freeze({
      Name: String(stream.Name),
      FirehoseArn: String(stream.FirehoseArn),
      RoleArn: String(stream.RoleArn),
      OutputFormat: "json",
      ...(stream.IncludeFilters ? { IncludeFilters: canonicalFilters(stream.IncludeFilters)! } : {}),
      ...(stream.ExcludeFilters ? { ExcludeFilters: canonicalFilters(stream.ExcludeFilters)! } : {}),
      IncludeLinkedAccountsMetrics: false,
      ...(stream.StatisticsConfigurations?.length ? { StatisticsConfigurations: canonicalStatistics(stream.StatisticsConfigurations)! } : {}),
      Tags: cfn10UserTags(tags),
    });
    return {
      model: current,
      arn: String(stream.Arn),
      state: String(stream.State),
      creationDate: isoDate(stream.CreationDate),
      lastUpdateDate: isoDate(stream.LastUpdateDate),
      tags,
    };
  };

  const reconcile = async (physicalId: string, desired: CloudWatchMetricStreamModel, context: ProviderContext): Promise<ProviderUpdateResult<CloudWatchMetricStreamModel>> => {
    const current = await describe(physicalId);
    if (!cfn10Owned(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Metric stream ${physicalId} is not owned by this stack resource` };
    if (physicalId !== desired.Name) return { status: "FAILED", errorCode: "RequiresReplacement", message: "Name changes require replacement" };
    if (!cfn10Same(streamInput(current.model), streamInput(desired))) await metrics.metricStreams.PutMetricStream(streamInput(desired));

    const wanted = cfn10TagMap(desired.Tags, context);
    const existing = Object.fromEntries(current.tags.map(tag => [tag.Key, tag.Value]));
    const removals = Object.keys(existing).filter(key => key !== CFN10_OWNER_TAG && !Object.hasOwn(wanted, key));
    if (removals.length) await metrics.UntagResource({ ResourceARN: current.arn, TagKeys: removals });
    const additions = Object.entries(wanted).filter(([key, value]) => existing[key] !== value).map(([Key, Value]) => ({ Key, Value }));
    if (additions.length) await metrics.TagResource({ ResourceARN: current.arn, Tags: additions });
    return success(await describe(physicalId));
  };

  return {
    typeName: CLOUDWATCH_METRIC_STREAM_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: CLOUDWATCH_METRIC_STREAM_SCHEMA,
    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] { return validation(properties, context); },
    canonicalize(properties: unknown, context: ProviderContext): CloudWatchMetricStreamModel {
      if (!cfn10Record(properties)) throw new TypeError(`${CLOUDWATCH_METRIC_STREAM_TYPE} Properties must be an object`);
      const issues = validation(properties, context);
      if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return model(properties, context);
    },
    plan(previous: CloudWatchMetricStreamModel | undefined, desired: CloudWatchMetricStreamModel): ProviderPlan<CloudWatchMetricStreamModel> {
      return cfn10Plan(previous as CloudWatchMetricStreamModel & Record<string, unknown> | undefined, desired as CloudWatchMetricStreamModel & Record<string, unknown>, CLOUDWATCH_METRIC_STREAM_SCHEMA) as ProviderPlan<CloudWatchMetricStreamModel>;
    },
    async create(desired: CloudWatchMetricStreamModel, context: ProviderContext) {
      try {
        try {
          const current = await describe(desired.Name);
          if (!cfn10Owned(current.tags, context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Metric stream ${desired.Name} already exists and is not owned by this stack resource` };
          return await reconcile(desired.Name, desired, context);
        } catch (error) {
          if (!cfn10Missing(error)) throw error;
        }
        await metrics.metricStreams.PutMetricStream({ ...streamInput(desired), Tags: cfn10ServiceTags(desired.Tags, context) });
        return success(await describe(desired.Name));
      } catch (error) {
        return cfn10Failure(error);
      }
    },
    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<CloudWatchMetricStreamModel>> {
      try {
        const current = await describe(physicalId);
        if (!cfn10Owned(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Metric stream ${physicalId} is not owned by this stack resource` };
        return success(current);
      }
      catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error); }
    },
    async update(physicalId: string, _previous: CloudWatchMetricStreamModel, desired: CloudWatchMetricStreamModel, context: ProviderContext): Promise<ProviderUpdateResult<CloudWatchMetricStreamModel>> {
      try { return await reconcile(physicalId, desired, context); }
      catch (error) { return cfn10Failure(error); }
    },
    async delete(physicalId: string, _previous: CloudWatchMetricStreamModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const current = await describe(physicalId);
        if (!cfn10Owned(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Metric stream ${physicalId} is not owned by this stack resource` };
        await metrics.metricStreams.DeleteMetricStream({ Name: physicalId });
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error) as ProviderDeleteResult;
      }
    },
    ref(current: ProviderReadModel<CloudWatchMetricStreamModel>): unknown { return current.physicalId; },
    getAtt(current: ProviderReadModel<CloudWatchMetricStreamModel>, attribute: string): unknown {
      return cfn10GetAtt(CLOUDWATCH_METRIC_STREAM_TYPE, CLOUDWATCH_METRIC_STREAM_SCHEMA, current, attribute);
    },
  };
}
