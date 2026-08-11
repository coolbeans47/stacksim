import { createHash } from "node:crypto";
import type { CloudWatchLogsService } from "../../cloudwatch-logs.js";
import { validateLogFilterPattern } from "../../cloudwatch-log-filter.js";
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
  cfn10ParsePhysical,
  cfn10Physical,
  cfn10Plan,
  cfn10Record,
  cfn10Same,
  cfn10Stable,
  cfn10TagMap,
  cfn10Tags,
  cfn10ThrowIssues,
  cfn10UserTags,
  type Cfn10Object,
  type Cfn10Tag,
} from "./cfn10-common.js";

export const LOG_STREAM_TYPE = "AWS::Logs::LogStream";
export const LOG_METRIC_FILTER_TYPE = "AWS::Logs::MetricFilter";
export const LOG_SUBSCRIPTION_FILTER_TYPE = "AWS::Logs::SubscriptionFilter";
export const LOG_DESTINATION_TYPE = "AWS::Logs::Destination";
export const LOG_RESOURCE_POLICY_TYPE = "AWS::Logs::ResourcePolicy";
export const LOG_QUERY_DEFINITION_TYPE = "AWS::Logs::QueryDefinition";

const mutable = (valueType: "string" | "number" | "boolean" | "object" | "array" | "any", required = false) => Object.freeze({ valueType, ...(required ? { required: true } : {}), updateBehavior: "MUTABLE" as const });
const replacement = (valueType: "string" | "number" | "boolean" | "object" | "array" | "any", required = false) => Object.freeze({ valueType, ...(required ? { required: true } : {}), updateBehavior: "REPLACEMENT" as const });
const noAttributes = Object.freeze({});

export const LOG_STREAM_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LOG_STREAM_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({ LogGroupName: replacement("string", true), LogStreamName: replacement("string") }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Log stream name" }), attributes: noAttributes,
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: CFN10_RETENTION, tags: CFN10_NO_TAGS,
});

export const LOG_METRIC_FILTER_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LOG_METRIC_FILTER_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    ApplyOnTransformedLogs: mutable("boolean"), EmitSystemFieldDimensions: mutable("array"), FieldSelectionCriteria: mutable("string"),
    FilterName: replacement("string"), FilterPattern: mutable("string", true), LogGroupName: replacement("string", true), MetricTransformations: mutable("array", true),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Composite LogGroupName|FilterName identifier" }), attributes: noAttributes,
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: CFN10_RETENTION, tags: CFN10_NO_TAGS,
});

export const LOG_SUBSCRIPTION_FILTER_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LOG_SUBSCRIPTION_FILTER_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    ApplyOnTransformedLogs: mutable("boolean"), DestinationArn: mutable("string", true), EmitSystemFields: mutable("array"), FieldSelectionCriteria: mutable("string"),
    FilterName: replacement("string"), FilterPattern: mutable("string", true), LogGroupName: replacement("string", true),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Subscription filter name" }), attributes: noAttributes,
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: CFN10_RETENTION, tags: CFN10_NO_TAGS,
});

export const LOG_DESTINATION_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LOG_DESTINATION_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({ DestinationName: replacement("string", true), DestinationPolicy: mutable("string"), RoleArn: mutable("string", true), Tags: mutable("array"), TargetArn: mutable("string", true) }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Destination name" }), attributes: Object.freeze({ Arn: Object.freeze({ valueType: "string" as const, description: "Destination ARN" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: CFN10_RETENTION, tags: CFN10_STACK_TAGS,
});

export const LOG_RESOURCE_POLICY_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LOG_RESOURCE_POLICY_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({ PolicyDocument: mutable("any", true), PolicyName: replacement("string", true) }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Resource policy name" }), attributes: noAttributes,
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: CFN10_RETENTION, tags: CFN10_NO_TAGS,
});

export const LOG_QUERY_DEFINITION_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LOG_QUERY_DEFINITION_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({ LogGroupNames: mutable("array"), Name: mutable("string", true), Parameters: mutable("array"), QueryLanguage: mutable("string"), QueryString: mutable("string", true) }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Query definition ID" }), attributes: Object.freeze({ QueryDefinitionId: Object.freeze({ valueType: "string" as const, description: "Query definition ID" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: CFN10_RETENTION, tags: CFN10_NO_TAGS,
});

export const LOGS_CFN10_SCHEMAS = Object.freeze([
  LOG_STREAM_SCHEMA, LOG_METRIC_FILTER_SCHEMA, LOG_SUBSCRIPTION_FILTER_SCHEMA, LOG_DESTINATION_SCHEMA, LOG_RESOURCE_POLICY_SCHEMA, LOG_QUERY_DEFINITION_SCHEMA,
]);

interface LogStreamModel extends Cfn10Object { readonly LogGroupName: string; readonly LogStreamName: string }
interface MetricTransformationModel extends Cfn10Object {
  readonly MetricName: string; readonly MetricNamespace: string; readonly MetricValue: string; readonly DefaultValue?: number;
  readonly Dimensions?: readonly { readonly Key: string; readonly Value: string }[]; readonly Unit?: string;
}
interface MetricFilterModel extends Cfn10Object {
  readonly ApplyOnTransformedLogs?: false; readonly EmitSystemFieldDimensions?: readonly string[]; readonly FieldSelectionCriteria?: string;
  readonly FilterName: string; readonly FilterPattern: string; readonly LogGroupName: string; readonly MetricTransformations: readonly MetricTransformationModel[];
}
interface SubscriptionFilterModel extends Cfn10Object {
  readonly ApplyOnTransformedLogs?: false; readonly DestinationArn: string; readonly EmitSystemFields?: readonly string[]; readonly FieldSelectionCriteria?: string;
  readonly FilterName: string; readonly FilterPattern: string; readonly LogGroupName: string;
}
interface DestinationModel extends Cfn10Object { readonly DestinationName: string; readonly DestinationPolicy?: string; readonly RoleArn: string; readonly Tags: readonly Cfn10Tag[]; readonly TargetArn: string }
interface ResourcePolicyModel extends Cfn10Object { readonly PolicyDocument: string; readonly PolicyName: string }
interface QueryParameterModel extends Cfn10Object { readonly Name: string; readonly DefaultValue?: string; readonly Description?: string }
interface QueryDefinitionModel extends Cfn10Object { readonly LogGroupNames?: readonly string[]; readonly Name: string; readonly Parameters?: readonly QueryParameterModel[]; readonly QueryLanguage: "CWLI" | "SQL" | "PPL"; readonly QueryString: string }

function success<Model>(physicalId: string, properties: Model, attributes: Readonly<Record<string, unknown>> = {}): ProviderSuccess<Model> {
  return { status: "SUCCESS", physicalId, model: { physicalId, properties, attributes } };
}

function validGroupName(value: unknown): value is string { return typeof value === "string" && /^[.\-_/#A-Za-z0-9]{1,512}$/.test(value); }
function validFilterName(value: unknown): value is string { return typeof value === "string" && value.length >= 1 && value.length <= 512 && !/[:*]/.test(value); }
function commonIssues(properties: unknown, schema: ProviderSchema): ProviderValidationIssue[] { return validateDeclaredProperties(properties, schema); }
function validateGroupName(value: unknown, path: string, issues: ProviderValidationIssue[]): void { if (!validGroupName(value)) cfn10Issue(issues, path, `${path.split(".").at(-1)} must be a valid 1-512 character log group name`); }
function validateFilterName(value: unknown, path: string, issues: ProviderValidationIssue[]): void { if (!validFilterName(value)) cfn10Issue(issues, path, `${path.split(".").at(-1)} must contain 1-512 characters and cannot contain ':' or '*'`); }
function validatePattern(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (typeof value !== "string" || Buffer.byteLength(value) > 1024) return cfn10Issue(issues, path, "FilterPattern must be a string of at most 1024 bytes");
  try { validateLogFilterPattern(value); } catch (error) { cfn10Issue(issues, path, error instanceof Error ? error.message : String(error)); }
}
function validateSystemFields(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!Array.isArray(value) || value.some(item => !["@aws.account", "@aws.region"].includes(String(item))) || new Set(value.map(String)).size !== value.length) cfn10Issue(issues, path, `${path.split(".").at(-1)} can contain only unique @aws.account and @aws.region values`);
}
function validateSelection(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (typeof value !== "string" || value.length > 2000 || (value && !value.split(/\s+(?:AND|OR)\s+/i).every(clause => /^@aws\.(?:account|region)\s*(?:=|!=|IN|NOT IN)\s*(?:"[^"]*"|\[[^\]]*])$/i.test(clause.trim())))) cfn10Issue(issues, path, "FieldSelectionCriteria uses an unsupported expression or exceeds 2000 characters");
}
function validateFalseTransformer(value: unknown, path: string, issues: ProviderValidationIssue[]): void { if (value !== false) cfn10Issue(issues, path, "ApplyOnTransformedLogs can only be false because Logs transformers are dependency-blocked"); }

function metricTransformationIssues(value: unknown, path: string, issues: ProviderValidationIssue[], systemDimensionCount: number): void {
  if (!cfn10Record(value)) return cfn10Issue(issues, path, `${path} must be an object`);
  cfn10ExactKeys(value, ["DefaultValue", "Dimensions", "MetricName", "MetricNamespace", "MetricValue", "Unit"], path, issues);
  for (const field of ["MetricName", "MetricNamespace", "MetricValue"] as const) if (typeof value[field] !== "string" || !value[field]) cfn10Issue(issues, `${path}.${field}`, `${field} is required and must be a non-empty string`);
  if (typeof value.MetricName === "string" && (value.MetricName.length > 255 || /[:*$]/.test(value.MetricName))) cfn10Issue(issues, `${path}.MetricName`, "MetricName is invalid");
  if (typeof value.MetricNamespace === "string" && (value.MetricNamespace.length > 255 || /[:*$]/.test(value.MetricNamespace) || value.MetricNamespace.startsWith("AWS/"))) cfn10Issue(issues, `${path}.MetricNamespace`, "MetricNamespace must be a valid custom namespace");
  if (typeof value.MetricValue === "string" && (value.MetricValue.length > 100 || (!value.MetricValue.startsWith("$") && !Number.isFinite(Number(value.MetricValue))))) cfn10Issue(issues, `${path}.MetricValue`, "MetricValue must be a numeric literal or extracted field selector");
  if (value.DefaultValue !== undefined && (typeof value.DefaultValue !== "number" || !Number.isFinite(value.DefaultValue))) cfn10Issue(issues, `${path}.DefaultValue`, "DefaultValue must be finite");
  if (value.Dimensions !== undefined) {
    if (!Array.isArray(value.Dimensions) || value.Dimensions.length + systemDimensionCount > 3) cfn10Issue(issues, `${path}.Dimensions`, "Dimensions and emitted system dimensions can contain at most three entries");
    else {
      const keys = new Set<string>();
      value.Dimensions.forEach((dimension, index) => {
        const itemPath = `${path}.Dimensions[${index}]`;
        if (!cfn10Record(dimension)) return cfn10Issue(issues, itemPath, "Dimension must be an object");
        cfn10ExactKeys(dimension, ["Key", "Value"], itemPath, issues);
        if (typeof dimension.Key !== "string" || !dimension.Key || dimension.Key.length > 255 || keys.has(dimension.Key)) cfn10Issue(issues, `${itemPath}.Key`, "Dimension Key must be unique and contain 1-255 characters"); else keys.add(dimension.Key);
        if (typeof dimension.Value !== "string" || !dimension.Value.startsWith("$") || dimension.Value.length > 255) cfn10Issue(issues, `${itemPath}.Value`, "Dimension Value must be an extracted field selector of at most 255 characters");
      });
    }
  }
  if (value.DefaultValue !== undefined && Array.isArray(value.Dimensions) && value.Dimensions.length) cfn10Issue(issues, `${path}.DefaultValue`, "DefaultValue cannot be combined with Dimensions");
}

function filterIssues(properties: unknown, schema: ProviderSchema, subscription: boolean): ProviderValidationIssue[] {
  const issues = commonIssues(properties, schema); if (!cfn10Record(properties)) return issues;
  if (properties.LogGroupName !== undefined) validateGroupName(properties.LogGroupName, "Properties.LogGroupName", issues);
  if (properties.FilterName !== undefined) validateFilterName(properties.FilterName, "Properties.FilterName", issues);
  if (properties.FilterPattern !== undefined) validatePattern(properties.FilterPattern, "Properties.FilterPattern", issues);
  if (properties.ApplyOnTransformedLogs !== undefined) validateFalseTransformer(properties.ApplyOnTransformedLogs, "Properties.ApplyOnTransformedLogs", issues);
  if (properties.FieldSelectionCriteria !== undefined) validateSelection(properties.FieldSelectionCriteria, "Properties.FieldSelectionCriteria", issues);
  const systemFieldProperty = subscription ? "EmitSystemFields" : "EmitSystemFieldDimensions";
  if (properties[systemFieldProperty] !== undefined) validateSystemFields(properties[systemFieldProperty], `Properties.${systemFieldProperty}`, issues);
  if (!subscription && properties.MetricTransformations !== undefined) {
    if (!Array.isArray(properties.MetricTransformations) || properties.MetricTransformations.length !== 1) cfn10Issue(issues, "Properties.MetricTransformations", "MetricTransformations must contain exactly one transformation");
    else metricTransformationIssues(properties.MetricTransformations[0], "Properties.MetricTransformations[0]", issues, Array.isArray(properties.EmitSystemFieldDimensions) ? properties.EmitSystemFieldDimensions.length : 0);
  }
  if (subscription && properties.DestinationArn !== undefined) {
    const match = String(properties.DestinationArn).match(/^arn:(?:aws|aws-us-gov|aws-cn):lambda:([^:]+):(\d{12}):function:([A-Za-z0-9-_]{1,64})(?::([A-Za-z0-9-_$]+))?$/);
    if (!match) cfn10Issue(issues, "Properties.DestinationArn", /^arn:[^:]+:(?:kinesis|firehose|logs):/.test(String(properties.DestinationArn)) ? "Kinesis, Firehose, and logical Logs destinations are dependency-blocked; CFN-10 supports only Lambda subscriptions" : "DestinationArn must identify a Lambda function");
  }
  return issues;
}

function canonicalTransformation(value: unknown): MetricTransformationModel {
  const input = value as Cfn10Object;
  return Object.freeze({
    MetricName: String(input.MetricName), MetricNamespace: String(input.MetricNamespace), MetricValue: String(input.MetricValue),
    ...(input.DefaultValue !== undefined ? { DefaultValue: Number(input.DefaultValue) } : {}),
    ...(Array.isArray(input.Dimensions) ? { Dimensions: Object.freeze(input.Dimensions.map(item => ({ Key: String((item as Cfn10Object).Key), Value: String((item as Cfn10Object).Value) })).sort((a, b) => a.Key.localeCompare(b.Key))) } : {}),
    ...(input.Unit !== undefined ? { Unit: String(input.Unit) } : {}),
  });
}

function serviceTransformation(value: MetricTransformationModel): Cfn10Object {
  return {
    metricName: value.MetricName, metricNamespace: value.MetricNamespace, metricValue: value.MetricValue,
    ...(value.DefaultValue !== undefined ? { defaultValue: value.DefaultValue } : {}),
    ...(value.Dimensions ? { dimensions: Object.fromEntries(value.Dimensions.map(item => [item.Key, item.Value])) } : {}),
    ...(value.Unit ? { unit: value.Unit } : {}),
  };
}

async function findStream(logs: CloudWatchLogsService, group: string, stream: string): Promise<any | undefined> {
  return (await logs.DescribeLogStreams({ logGroupName: group, logStreamNamePrefix: stream, limit: 50 })).logStreams?.find((item: any) => item.logStreamName === stream);
}
async function findMetricFilter(logs: CloudWatchLogsService, group: string, name: string): Promise<any | undefined> {
  return (await logs.DescribeMetricFilters({ logGroupName: group, filterNamePrefix: name, limit: 50 })).metricFilters?.find((item: any) => item.filterName === name);
}
async function findSubscriptionFilter(logs: CloudWatchLogsService, group: string, name: string): Promise<any | undefined> {
  return (await logs.DescribeSubscriptionFilters({ logGroupName: group, filterNamePrefix: name, limit: 50 })).subscriptionFilters?.find((item: any) => item.filterName === name);
}

function metricFilterFromService(raw: any): MetricFilterModel {
  const transformation = raw.metricTransformations[0];
  return Object.freeze({
    FilterName: String(raw.filterName), FilterPattern: String(raw.filterPattern), LogGroupName: String(raw.logGroupName),
    MetricTransformations: Object.freeze([Object.freeze({
      MetricName: String(transformation.metricName), MetricNamespace: String(transformation.metricNamespace), MetricValue: String(transformation.metricValue),
      ...(transformation.defaultValue !== undefined ? { DefaultValue: Number(transformation.defaultValue) } : {}),
      ...(transformation.dimensions ? { Dimensions: Object.freeze(Object.entries(transformation.dimensions).map(([Key, Value]) => ({ Key, Value: String(Value) })).sort((a, b) => a.Key.localeCompare(b.Key))) } : {}),
      ...(transformation.unit ? { Unit: String(transformation.unit) } : {}),
    })]),
    ...(raw.emitSystemFieldDimensions?.length ? { EmitSystemFieldDimensions: Object.freeze(raw.emitSystemFieldDimensions.map(String)) } : {}),
    ...(raw.fieldSelectionCriteria !== undefined ? { FieldSelectionCriteria: String(raw.fieldSelectionCriteria) } : {}),
  });
}

function subscriptionFromService(raw: any): SubscriptionFilterModel {
  return Object.freeze({
    DestinationArn: String(raw.destinationArn), FilterName: String(raw.filterName), FilterPattern: String(raw.filterPattern), LogGroupName: String(raw.logGroupName),
    ...(raw.emitSystemFields?.length ? { EmitSystemFields: Object.freeze(raw.emitSystemFields.map(String)) } : {}),
    ...(raw.fieldSelectionCriteria !== undefined ? { FieldSelectionCriteria: String(raw.fieldSelectionCriteria) } : {}),
  });
}

export function createLogStreamProvider(logs: CloudWatchLogsService): ProductionResourceProvider<LogStreamModel> {
  return {
    typeName: LOG_STREAM_TYPE, providerVersion: 1, visibility: "production", schema: LOG_STREAM_SCHEMA,
    validate(properties) { const issues = commonIssues(properties, LOG_STREAM_SCHEMA); if (cfn10Record(properties)) { if (properties.LogGroupName !== undefined) validateGroupName(properties.LogGroupName, "Properties.LogGroupName", issues); if (properties.LogStreamName !== undefined) validateFilterName(properties.LogStreamName, "Properties.LogStreamName", issues); } return issues; },
    canonicalize(properties, context) { const issues = this.validate(properties, context); cfn10ThrowIssues(issues); const input = properties as Cfn10Object; return Object.freeze({ LogGroupName: String(input.LogGroupName), LogStreamName: String(input.LogStreamName ?? cfn10GeneratedName(context, "", 512, /[:*]/g)) }); },
    plan(previous, desired) { return cfn10Plan(previous, desired, LOG_STREAM_SCHEMA); },
    async create(desired) { try { const existing = await findStream(logs, desired.LogGroupName, desired.LogStreamName); if (existing) return success(cfn10Physical("log-stream", [desired.LogGroupName, desired.LogStreamName]), desired); await logs.CreateLogStream({ logGroupName: desired.LogGroupName, logStreamName: desired.LogStreamName }); return success(cfn10Physical("log-stream", [desired.LogGroupName, desired.LogStreamName]), desired); } catch (error) { return cfn10Failure(error); } },
    async read(physicalId): Promise<ProviderReadResult<LogStreamModel>> { try { const [group, stream] = cfn10ParsePhysical(physicalId, "log-stream", 2); const raw = await findStream(logs, group, stream); return raw ? success(physicalId, Object.freeze({ LogGroupName: group, LogStreamName: stream })) : { status: "NOT_FOUND", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error) as ProviderReadResult<LogStreamModel>; } },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<LogStreamModel>> {
      if (!cfn10Same(previous, desired)) return { status: "FAILED", errorCode: "RequiresReplacement", message: "LogGroupName and LogStreamName changes require replacement" };
      try {
        const [group, stream] = cfn10ParsePhysical(physicalId, "log-stream", 2);
        return await findStream(logs, group, stream)
          ? success(physicalId, Object.freeze({ LogGroupName: group, LogStreamName: stream }))
          : { status: "FAILED", errorCode: "NotFound", message: `Log stream ${stream} no longer exists` };
      } catch (error) { return cfn10Failure(error); }
    },
    async delete(physicalId, previous): Promise<ProviderDeleteResult> { try { const [group, stream] = cfn10ParsePhysical(physicalId, "log-stream", 2); if (group !== previous.LogGroupName || stream !== previous.LogStreamName) return { status: "FAILED", errorCode: "OwnershipConflict", message: "Log stream physical ID does not match the recorded CloudFormation resource" }; const existing = await findStream(logs, group, stream); if (!existing) return { status: "NOT_FOUND", physicalId }; await logs.DeleteLogStream({ logGroupName: group, logStreamName: stream }); return { status: "SUCCESS", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10DeleteFailure(error); } },
    ref(model) { return model.properties.LogStreamName; }, getAtt(model, attribute) { return cfn10GetAtt(LOG_STREAM_TYPE, LOG_STREAM_SCHEMA, model, attribute); },
  };
}

export function createMetricFilterProvider(logs: CloudWatchLogsService): ProductionResourceProvider<MetricFilterModel> {
  const physical = (model: MetricFilterModel) => `${model.LogGroupName}|${model.FilterName}`;
  // Log-group names cannot contain a pipe, while filter names can. Split on the
  // first pipe to preserve the documented composite Ref for such filter names.
  const decode = (value: string): [string, string] => { const index = value.indexOf("|"); if (index < 1 || index === value.length - 1) throw new AwsError("InvalidPhysicalResourceId", "Metric filter physical ID must be LogGroupName|FilterName"); return [value.slice(0, index), value.slice(index + 1)]; };
  return {
    typeName: LOG_METRIC_FILTER_TYPE, providerVersion: 1, visibility: "production", schema: LOG_METRIC_FILTER_SCHEMA,
    validate(properties) { return filterIssues(properties, LOG_METRIC_FILTER_SCHEMA, false); },
    canonicalize(properties, context) { const issues = this.validate(properties, context); cfn10ThrowIssues(issues); const input = properties as Cfn10Object; return Object.freeze({ FilterName: String(input.FilterName ?? cfn10GeneratedName(context, "", 512, /[:*]/g)), FilterPattern: String(input.FilterPattern), LogGroupName: String(input.LogGroupName), MetricTransformations: Object.freeze((input.MetricTransformations as unknown[]).map(canonicalTransformation)), ...(Array.isArray(input.EmitSystemFieldDimensions) ? { EmitSystemFieldDimensions: Object.freeze(input.EmitSystemFieldDimensions.map(String)) } : {}), ...(input.FieldSelectionCriteria !== undefined ? { FieldSelectionCriteria: String(input.FieldSelectionCriteria) } : {}) }); },
    plan(previous, desired) { return cfn10Plan(previous, desired, LOG_METRIC_FILTER_SCHEMA); },
    async create(desired) { try { const existing = await findMetricFilter(logs, desired.LogGroupName, desired.FilterName); if (existing) { const current = metricFilterFromService(existing); if (!cfn10Same(current, desired)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Metric filter ${desired.FilterName} already exists with different configuration` }; return success(physical(desired), current); } await logs.PutMetricFilter({ logGroupName: desired.LogGroupName, filterName: desired.FilterName, filterPattern: desired.FilterPattern, metricTransformations: desired.MetricTransformations.map(serviceTransformation), applyOnTransformedLogs: desired.ApplyOnTransformedLogs, emitSystemFieldDimensions: desired.EmitSystemFieldDimensions, fieldSelectionCriteria: desired.FieldSelectionCriteria }); const current = metricFilterFromService((await findMetricFilter(logs, desired.LogGroupName, desired.FilterName))!); return success(physical(desired), current); } catch (error) { return cfn10Failure(error); } },
    async read(physicalId): Promise<ProviderReadResult<MetricFilterModel>> { try { const [group, name] = decode(physicalId); const raw = await findMetricFilter(logs, group, name); return raw ? success(physicalId, metricFilterFromService(raw)) : { status: "NOT_FOUND", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error) as ProviderReadResult<MetricFilterModel>; } },
    async update(physicalId, _previous, desired) { try { const [group, name] = decode(physicalId); if (group !== desired.LogGroupName || name !== desired.FilterName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "LogGroupName and FilterName changes require replacement" }; await logs.PutMetricFilter({ logGroupName: group, filterName: name, filterPattern: desired.FilterPattern, metricTransformations: desired.MetricTransformations.map(serviceTransformation), applyOnTransformedLogs: desired.ApplyOnTransformedLogs, emitSystemFieldDimensions: desired.EmitSystemFieldDimensions, fieldSelectionCriteria: desired.FieldSelectionCriteria }); return success(physicalId, metricFilterFromService((await findMetricFilter(logs, group, name))!)); } catch (error) { return cfn10Failure(error); } },
    async delete(physicalId, previous) { try { const [group, name] = decode(physicalId); if (group !== previous.LogGroupName || name !== previous.FilterName) return { status: "FAILED", errorCode: "OwnershipConflict", message: "Metric filter physical ID does not match the recorded CloudFormation resource" }; const current = await findMetricFilter(logs, group, name); if (!current) return { status: "NOT_FOUND", physicalId }; if (!cfn10Same(metricFilterFromService(current), previous)) return { status: "FAILED", errorCode: "OwnershipConflict", message: "Metric filter no longer matches the resource recorded by CloudFormation" }; await logs.DeleteMetricFilter({ logGroupName: group, filterName: name }); return { status: "SUCCESS", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10DeleteFailure(error); } },
    ref(model) { return model.physicalId; }, getAtt(model, attribute) { return cfn10GetAtt(LOG_METRIC_FILTER_TYPE, LOG_METRIC_FILTER_SCHEMA, model, attribute); },
  };
}

export function createSubscriptionFilterProvider(logs: CloudWatchLogsService): ProductionResourceProvider<SubscriptionFilterModel> {
  return {
    typeName: LOG_SUBSCRIPTION_FILTER_TYPE, providerVersion: 1, visibility: "production", schema: LOG_SUBSCRIPTION_FILTER_SCHEMA,
    validate(properties, context) { const issues = filterIssues(properties, LOG_SUBSCRIPTION_FILTER_SCHEMA, true); if (cfn10Record(properties) && typeof properties.DestinationArn === "string") { const match = properties.DestinationArn.match(/^arn:[^:]+:lambda:([^:]+):(\d{12}):/); if (match && (match[1] !== context.region || match[2] !== context.accountId)) cfn10Issue(issues, "Properties.DestinationArn", "Lambda subscription destinations must use this simulator account and Region"); } return issues; },
    canonicalize(properties, context) { const issues = this.validate(properties, context); cfn10ThrowIssues(issues); const input = properties as Cfn10Object; return Object.freeze({ DestinationArn: String(input.DestinationArn), FilterName: String(input.FilterName ?? cfn10GeneratedName(context, "", 512, /[:*]/g)), FilterPattern: String(input.FilterPattern), LogGroupName: String(input.LogGroupName), ...(Array.isArray(input.EmitSystemFields) ? { EmitSystemFields: Object.freeze(input.EmitSystemFields.map(String)) } : {}), ...(input.FieldSelectionCriteria !== undefined ? { FieldSelectionCriteria: String(input.FieldSelectionCriteria) } : {}) }); },
    plan(previous, desired) { return cfn10Plan(previous, desired, LOG_SUBSCRIPTION_FILTER_SCHEMA); },
    async create(desired) { try { const id = cfn10Physical("subscription-filter", [desired.LogGroupName, desired.FilterName]); const existing = await findSubscriptionFilter(logs, desired.LogGroupName, desired.FilterName); if (existing) { const current = subscriptionFromService(existing); if (!cfn10Same(current, desired)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Subscription filter ${desired.FilterName} already exists with different configuration` }; return success(id, current); } await logs.PutSubscriptionFilter({ logGroupName: desired.LogGroupName, filterName: desired.FilterName, filterPattern: desired.FilterPattern, destinationArn: desired.DestinationArn, applyOnTransformedLogs: desired.ApplyOnTransformedLogs, emitSystemFields: desired.EmitSystemFields, fieldSelectionCriteria: desired.FieldSelectionCriteria }); return success(id, subscriptionFromService((await findSubscriptionFilter(logs, desired.LogGroupName, desired.FilterName))!)); } catch (error) { return cfn10Failure(error); } },
    async read(physicalId): Promise<ProviderReadResult<SubscriptionFilterModel>> { try { const [group, name] = cfn10ParsePhysical(physicalId, "subscription-filter", 2); const raw = await findSubscriptionFilter(logs, group, name); return raw ? success(physicalId, subscriptionFromService(raw)) : { status: "NOT_FOUND", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error) as ProviderReadResult<SubscriptionFilterModel>; } },
    async update(physicalId, _previous, desired) { try { const [group, name] = cfn10ParsePhysical(physicalId, "subscription-filter", 2); if (group !== desired.LogGroupName || name !== desired.FilterName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "LogGroupName and FilterName changes require replacement" }; await logs.PutSubscriptionFilter({ logGroupName: group, filterName: name, filterPattern: desired.FilterPattern, destinationArn: desired.DestinationArn, applyOnTransformedLogs: desired.ApplyOnTransformedLogs, emitSystemFields: desired.EmitSystemFields, fieldSelectionCriteria: desired.FieldSelectionCriteria }); return success(physicalId, subscriptionFromService((await findSubscriptionFilter(logs, group, name))!)); } catch (error) { return cfn10Failure(error); } },
    async delete(physicalId, previous) { try { const [group, name] = cfn10ParsePhysical(physicalId, "subscription-filter", 2); if (group !== previous.LogGroupName || name !== previous.FilterName) return { status: "FAILED", errorCode: "OwnershipConflict", message: "Subscription filter physical ID does not match the recorded CloudFormation resource" }; const current = await findSubscriptionFilter(logs, group, name); if (!current) return { status: "NOT_FOUND", physicalId }; if (!cfn10Same(subscriptionFromService(current), previous)) return { status: "FAILED", errorCode: "OwnershipConflict", message: "Subscription filter no longer matches the resource recorded by CloudFormation" }; await logs.DeleteSubscriptionFilter({ logGroupName: group, filterName: name }); return { status: "SUCCESS", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10DeleteFailure(error); } },
    ref(model) { return model.properties.FilterName; }, getAtt(model, attribute) { return cfn10GetAtt(LOG_SUBSCRIPTION_FILTER_TYPE, LOG_SUBSCRIPTION_FILTER_SCHEMA, model, attribute); },
  };
}

async function findDestination(logs: CloudWatchLogsService, name: string): Promise<any | undefined> {
  return (await logs.DescribeDestinations({ destinationNamePrefix: name, limit: 50 })).destinations?.find((item: any) => item.destinationName === name);
}
async function destinationModel(logs: CloudWatchLogsService, raw: any): Promise<DestinationModel> {
  const tags = (await logs.ListTagsForResource({ resourceArn: raw.arn })).tags ?? {};
  return Object.freeze({ DestinationName: String(raw.destinationName), ...(raw.accessPolicy ? { DestinationPolicy: String(raw.accessPolicy) } : {}), RoleArn: String(raw.roleArn), Tags: cfn10UserTags(tags), TargetArn: String(raw.targetArn) });
}
async function reconcileLogTags(logs: CloudWatchLogsService, arn: string, desired: DestinationModel, context: ProviderContext): Promise<void> {
  const current = (await logs.ListTagsForResource({ resourceArn: arn })).tags ?? {}; const wanted = cfn10TagMap(desired.Tags, context);
  const remove = Object.keys(current).filter(key => !Object.hasOwn(wanted, key)); if (remove.length) await logs.UntagResource({ resourceArn: arn, tagKeys: remove });
  await logs.TagResource({ resourceArn: arn, tags: wanted });
}

export function createLogDestinationProvider(logs: CloudWatchLogsService): ProductionResourceProvider<DestinationModel> {
  return {
    typeName: LOG_DESTINATION_TYPE, providerVersion: 1, visibility: "production", schema: LOG_DESTINATION_SCHEMA,
    validate(properties) { const issues = commonIssues(properties, LOG_DESTINATION_SCHEMA); if (!cfn10Record(properties)) return issues; if (properties.DestinationName !== undefined) validateFilterName(properties.DestinationName, "Properties.DestinationName", issues); if (properties.TargetArn !== undefined && !/^arn:[^:]+:kinesis:[^:]+:\d{12}:stream\/.+/.test(String(properties.TargetArn))) cfn10Issue(issues, "Properties.TargetArn", "TargetArn must be a Kinesis descriptor ARN; active Kinesis delivery remains dependency-blocked"); if (properties.RoleArn !== undefined && !/^arn:[^:]+:iam::\d{12}:role\/.+/.test(String(properties.RoleArn))) cfn10Issue(issues, "Properties.RoleArn", "RoleArn must identify an IAM role"); if (properties.DestinationPolicy !== undefined) { if (typeof properties.DestinationPolicy !== "string" || Buffer.byteLength(properties.DestinationPolicy) > 5120 || !properties.DestinationPolicy) cfn10Issue(issues, "Properties.DestinationPolicy", "DestinationPolicy must contain 1-5120 bytes"); else try { JSON.parse(properties.DestinationPolicy); } catch { cfn10Issue(issues, "Properties.DestinationPolicy", "DestinationPolicy must be valid JSON"); } } try { cfn10Tags(properties.Tags); } catch (error) { cfn10Issue(issues, "Properties.Tags", error instanceof Error ? error.message : String(error)); } return issues; },
    canonicalize(properties, context) { const issues = this.validate(properties, context); cfn10ThrowIssues(issues); const input = properties as Cfn10Object; return Object.freeze({ DestinationName: String(input.DestinationName), ...(input.DestinationPolicy !== undefined ? { DestinationPolicy: String(input.DestinationPolicy) } : {}), RoleArn: String(input.RoleArn), Tags: cfn10Tags(input.Tags), TargetArn: String(input.TargetArn) }); },
    plan(previous, desired) { return cfn10Plan(previous, desired, LOG_DESTINATION_SCHEMA); },
    async create(desired, context) { try { const existing = await findDestination(logs, desired.DestinationName); if (existing) { const tags = (await logs.ListTagsForResource({ resourceArn: existing.arn })).tags ?? {}; if (!cfn10Owned(tags, context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Logs destination ${desired.DestinationName} already exists and is not owned by this stack resource` }; } await logs.PutDestination({ destinationName: desired.DestinationName, targetArn: desired.TargetArn, roleArn: desired.RoleArn, tags: cfn10TagMap(desired.Tags, context) }); if (desired.DestinationPolicy !== undefined) await logs.PutDestinationPolicy({ destinationName: desired.DestinationName, accessPolicy: desired.DestinationPolicy }); else if (existing?.accessPolicy !== undefined) await logs.clearDestinationPolicyForCloudFormation(desired.DestinationName); const raw = (await findDestination(logs, desired.DestinationName))!; await reconcileLogTags(logs, raw.arn, desired, context); return success(desired.DestinationName, await destinationModel(logs, raw), { Arn: raw.arn }); } catch (error) { return cfn10Failure(error); } },
    async read(physicalId, context): Promise<ProviderReadResult<DestinationModel>> { try { const raw = await findDestination(logs, physicalId); if (!raw) return { status: "NOT_FOUND", physicalId }; const tags = (await logs.ListTagsForResource({ resourceArn: raw.arn })).tags ?? {}; if (!cfn10Owned(tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Logs destination ${physicalId} is not owned by this stack resource` }; return success(physicalId, await destinationModel(logs, raw), { Arn: raw.arn }); } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error) as ProviderReadResult<DestinationModel>; } },
    async update(physicalId, _previous, desired, context) {
      if (physicalId !== desired.DestinationName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "DestinationName changes require replacement" };
      try {
        const owned = await this.read(physicalId, context);
        if (owned.status !== "SUCCESS") return owned as ProviderUpdateResult<DestinationModel>;
        await logs.PutDestination({ destinationName: physicalId, targetArn: desired.TargetArn, roleArn: desired.RoleArn });
        if (desired.DestinationPolicy !== undefined) await logs.PutDestinationPolicy({ destinationName: physicalId, accessPolicy: desired.DestinationPolicy });
        else if (owned.model.properties.DestinationPolicy !== undefined) await logs.clearDestinationPolicyForCloudFormation(physicalId);
        const raw = (await findDestination(logs, physicalId))!;
        await reconcileLogTags(logs, raw.arn, desired, context);
        return success(physicalId, await destinationModel(logs, raw), { Arn: raw.arn });
      } catch (error) { return cfn10Failure(error); }
    },
    async delete(physicalId, _previous, context) { try { const raw = await findDestination(logs, physicalId); if (!raw) return { status: "NOT_FOUND", physicalId }; const tags = (await logs.ListTagsForResource({ resourceArn: raw.arn })).tags ?? {}; if (!cfn10Owned(tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Logs destination ${physicalId} is not owned by this stack resource` }; await logs.DeleteDestination({ destinationName: physicalId }); return { status: "SUCCESS", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10DeleteFailure(error); } },
    ref(model) { return model.physicalId; }, getAtt(model, attribute) { return cfn10GetAtt(LOG_DESTINATION_TYPE, LOG_DESTINATION_SCHEMA, model, attribute); },
  };
}

async function findPolicy(logs: CloudWatchLogsService, name: string): Promise<any | undefined> { return (await logs.DescribeResourcePolicies({ policyScope: "ACCOUNT", limit: 50 })).resourcePolicies?.find((item: any) => item.policyName === name); }
function policyDocument(value: unknown): string { if (typeof value === "string") return value; return JSON.stringify(cfn10Stable(value)); }
function policyModel(raw: any): ResourcePolicyModel { return Object.freeze({ PolicyDocument: String(raw.policyDocument), PolicyName: String(raw.policyName) }); }

export function createLogResourcePolicyProvider(logs: CloudWatchLogsService): ProductionResourceProvider<ResourcePolicyModel> {
  return {
    typeName: LOG_RESOURCE_POLICY_TYPE, providerVersion: 1, visibility: "production", schema: LOG_RESOURCE_POLICY_SCHEMA,
    validate(properties) { const issues = commonIssues(properties, LOG_RESOURCE_POLICY_SCHEMA); if (!cfn10Record(properties)) return issues; if (properties.PolicyName !== undefined && (typeof properties.PolicyName !== "string" || !/^([^:*\/]+\/?)*[^:*\/]+$/.test(properties.PolicyName) || properties.PolicyName.length > 255)) cfn10Issue(issues, "Properties.PolicyName", "PolicyName must be a valid 1-255 character account policy name"); if (properties.PolicyDocument !== undefined) { try { const text = policyDocument(properties.PolicyDocument); const parsed = JSON.parse(text); if (!cfn10Record(parsed) || !text.length || Buffer.byteLength(text) > 5120) throw new Error(); } catch { cfn10Issue(issues, "Properties.PolicyDocument", "PolicyDocument must be a JSON object/string of 1-5120 bytes"); } } return issues; },
    canonicalize(properties, context) { const issues = this.validate(properties, context); cfn10ThrowIssues(issues); const input = properties as Cfn10Object; return Object.freeze({ PolicyDocument: policyDocument(input.PolicyDocument), PolicyName: String(input.PolicyName) }); },
    plan(previous, desired) { return cfn10Plan(previous, desired, LOG_RESOURCE_POLICY_SCHEMA); },
    async create(desired) { try { const existing = await findPolicy(logs, desired.PolicyName); if (existing) { const current = policyModel(existing); if (!cfn10Same(current, desired)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Logs resource policy ${desired.PolicyName} already exists with different configuration` }; return success(desired.PolicyName, current); } await logs.PutResourcePolicy({ policyName: desired.PolicyName, policyDocument: desired.PolicyDocument }); return success(desired.PolicyName, policyModel((await findPolicy(logs, desired.PolicyName))!)); } catch (error) { return cfn10Failure(error); } },
    async read(physicalId): Promise<ProviderReadResult<ResourcePolicyModel>> { try { const raw = await findPolicy(logs, physicalId); return raw ? success(physicalId, policyModel(raw)) : { status: "NOT_FOUND", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error) as ProviderReadResult<ResourcePolicyModel>; } },
    async update(physicalId, previous, desired) { if (physicalId !== desired.PolicyName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "PolicyName changes require replacement" }; try { const raw = await findPolicy(logs, physicalId); if (!raw) return { status: "FAILED", errorCode: "NotFound", message: `Logs resource policy ${physicalId} no longer exists` }; if (policyModel(raw).PolicyDocument !== previous.PolicyDocument) return { status: "FAILED", errorCode: "OwnershipConflict", message: "Logs resource policy no longer matches the resource recorded by CloudFormation" }; await logs.PutResourcePolicy({ policyName: physicalId, policyDocument: desired.PolicyDocument }); return success(physicalId, policyModel((await findPolicy(logs, physicalId))!)); } catch (error) { return cfn10Failure(error); } },
    async delete(physicalId, previous) { try { const raw = await findPolicy(logs, physicalId); if (!raw) return { status: "NOT_FOUND", physicalId }; if (!cfn10Same(policyModel(raw), previous)) return { status: "FAILED", errorCode: "OwnershipConflict", message: "Logs resource policy no longer matches the resource recorded by CloudFormation" }; await logs.DeleteResourcePolicy({ policyName: physicalId }); return { status: "SUCCESS", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10DeleteFailure(error); } },
    ref(model) { return model.physicalId; }, getAtt(model, attribute) { return cfn10GetAtt(LOG_RESOURCE_POLICY_TYPE, LOG_RESOURCE_POLICY_SCHEMA, model, attribute); },
  };
}

function queryIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = commonIssues(properties, LOG_QUERY_DEFINITION_SCHEMA); if (!cfn10Record(properties)) return issues;
  if (properties.Name !== undefined && (typeof properties.Name !== "string" || !properties.Name || properties.Name.length > 255)) cfn10Issue(issues, "Properties.Name", "Name must contain 1-255 characters");
  if (properties.QueryString !== undefined && (typeof properties.QueryString !== "string" || !properties.QueryString || properties.QueryString.length > 10_000)) cfn10Issue(issues, "Properties.QueryString", "QueryString must contain 1-10000 characters");
  if (properties.QueryLanguage !== undefined && !["CWLI", "SQL", "PPL"].includes(String(properties.QueryLanguage))) cfn10Issue(issues, "Properties.QueryLanguage", "QueryLanguage must be CWLI, SQL, or PPL");
  if (properties.LogGroupNames !== undefined && (!Array.isArray(properties.LogGroupNames) || properties.LogGroupNames.length < 1 || properties.LogGroupNames.length > 50 || properties.LogGroupNames.some(name => !validGroupName(name)))) cfn10Issue(issues, "Properties.LogGroupNames", "LogGroupNames must contain 1-50 valid log group names");
  if (properties.Parameters !== undefined) {
    if (!Array.isArray(properties.Parameters) || properties.Parameters.length > 20) cfn10Issue(issues, "Properties.Parameters", "Parameters must contain at most 20 entries");
    else { const names = new Set<string>(); properties.Parameters.forEach((parameter, index) => { const path = `Properties.Parameters[${index}]`; if (!cfn10Record(parameter)) return cfn10Issue(issues, path, "Query parameter must be an object"); cfn10ExactKeys(parameter, ["DefaultValue", "Description", "Name"], path, issues); if (typeof parameter.Name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter.Name) || names.has(parameter.Name)) cfn10Issue(issues, `${path}.Name`, "Parameter Name must be a unique identifier"); else names.add(parameter.Name); for (const field of ["DefaultValue", "Description"] as const) if (parameter[field] !== undefined && typeof parameter[field] !== "string") cfn10Issue(issues, `${path}.${field}`, `${field} must be a string`); }); }
  }
  if (properties.Parameters !== undefined && properties.QueryLanguage !== undefined && properties.QueryLanguage !== "CWLI") cfn10Issue(issues, "Properties.Parameters", "Parameters are supported only for CWLI query definitions");
  return issues;
}
function queryModel(raw: any): QueryDefinitionModel { return Object.freeze({ ...(raw.logGroupNames ? { LogGroupNames: Object.freeze(raw.logGroupNames.map(String)) } : {}), Name: String(raw.name), ...(raw.parameters ? { Parameters: Object.freeze(raw.parameters.map((item: any) => Object.freeze({ Name: String(item.name), ...(item.defaultValue !== undefined ? { DefaultValue: String(item.defaultValue) } : {}), ...(item.description !== undefined ? { Description: String(item.description) } : {}) }))) } : {}), QueryLanguage: String(raw.queryLanguage ?? "CWLI") as QueryDefinitionModel["QueryLanguage"], QueryString: String(raw.queryString) }); }
async function findQuery(logs: CloudWatchLogsService, id: string): Promise<any | undefined> { let token: string | undefined; do { const page = await logs.DescribeQueryDefinitions({ maxResults: 1000, nextToken: token }); const found = page.queryDefinitions?.find((item: any) => item.queryDefinitionId === id); if (found) return found; token = page.nextToken; } while (token); return undefined; }

export function createLogQueryDefinitionProvider(logs: CloudWatchLogsService): ProductionResourceProvider<QueryDefinitionModel> {
  return {
    typeName: LOG_QUERY_DEFINITION_TYPE, providerVersion: 1, visibility: "production", schema: LOG_QUERY_DEFINITION_SCHEMA,
    validate(properties) { return queryIssues(properties); },
    canonicalize(properties, context) { const issues = this.validate(properties, context); cfn10ThrowIssues(issues); const input = properties as Cfn10Object; return Object.freeze({ ...(Array.isArray(input.LogGroupNames) ? { LogGroupNames: Object.freeze(input.LogGroupNames.map(String)) } : {}), Name: String(input.Name), ...(Array.isArray(input.Parameters) ? { Parameters: Object.freeze(input.Parameters.map(item => { const parameter = item as Cfn10Object; return Object.freeze({ Name: String(parameter.Name), ...(parameter.DefaultValue !== undefined ? { DefaultValue: String(parameter.DefaultValue) } : {}), ...(parameter.Description !== undefined ? { Description: String(parameter.Description) } : {}) }); })) } : {}), QueryLanguage: String(input.QueryLanguage ?? "CWLI") as QueryDefinitionModel["QueryLanguage"], QueryString: String(input.QueryString) }); },
    plan(previous, desired) { return cfn10Plan(previous, desired, LOG_QUERY_DEFINITION_SCHEMA); },
    async create(desired, context) { try { const token = `cfn-${createHash("sha256").update(context.idempotencyKey).digest("hex")}`; const response = await logs.PutQueryDefinition({ name: desired.Name, queryString: desired.QueryString, queryLanguage: desired.QueryLanguage, logGroupNames: desired.LogGroupNames, parameters: desired.Parameters?.map(item => ({ name: item.Name, defaultValue: item.DefaultValue, description: item.Description })), clientToken: token }); const id = String(response.queryDefinitionId); return success(id, queryModel((await findQuery(logs, id))!), { QueryDefinitionId: id }); } catch (error) { return cfn10Failure(error); } },
    async read(physicalId): Promise<ProviderReadResult<QueryDefinitionModel>> { try { const raw = await findQuery(logs, physicalId); return raw ? success(physicalId, queryModel(raw), { QueryDefinitionId: physicalId }) : { status: "NOT_FOUND", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error) as ProviderReadResult<QueryDefinitionModel>; } },
    async update(physicalId, _previous, desired) { try { await logs.PutQueryDefinition({ queryDefinitionId: physicalId, name: desired.Name, queryString: desired.QueryString, queryLanguage: desired.QueryLanguage, logGroupNames: desired.LogGroupNames, parameters: desired.Parameters?.map(item => ({ name: item.Name, defaultValue: item.DefaultValue, description: item.Description })) }); return success(physicalId, queryModel((await findQuery(logs, physicalId))!), { QueryDefinitionId: physicalId }); } catch (error) { return cfn10Failure(error); } },
    async delete(physicalId, previous) { try { const raw = await findQuery(logs, physicalId); if (!raw) return { status: "NOT_FOUND", physicalId }; if (!cfn10Same(queryModel(raw), previous)) return { status: "FAILED", errorCode: "OwnershipConflict", message: "Query definition no longer matches the resource recorded by CloudFormation" }; await logs.DeleteQueryDefinition({ queryDefinitionId: physicalId }); return { status: "SUCCESS", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10DeleteFailure(error); } },
    ref(model) { return model.physicalId; }, getAtt(model, attribute) { return cfn10GetAtt(LOG_QUERY_DEFINITION_TYPE, LOG_QUERY_DEFINITION_SCHEMA, model, attribute); },
  };
}

export function createLogsCfn10Providers(logs: CloudWatchLogsService): readonly ProductionResourceProvider<any>[] {
  return Object.freeze([createLogStreamProvider(logs), createMetricFilterProvider(logs), createSubscriptionFilterProvider(logs), createLogDestinationProvider(logs), createLogResourcePolicyProvider(logs), createLogQueryDefinitionProvider(logs)]);
}
