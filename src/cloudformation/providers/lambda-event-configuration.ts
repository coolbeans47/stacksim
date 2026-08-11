import type { LambdaService } from "../../lambda.js";
import { AwsError } from "../../errors.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderInProgress,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderSuccess,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";
import { invokeJsonService } from "./service-invoker.js";
import {
  CFN09_OWNER_TAG,
  CFN09_RETENTION,
  changedProperties,
  exactKeys,
  isNotFound,
  isRecord,
  issue,
  ownerValue,
  providerFailure,
  same,
  stable,
} from "./cfn09-common.js";

export const LAMBDA_EVENT_SOURCE_MAPPING_TYPE = "AWS::Lambda::EventSourceMapping";
export const LAMBDA_EVENT_INVOKE_CONFIG_TYPE = "AWS::Lambda::EventInvokeConfig";

export interface LambdaEventFilterCriteriaModel {
  readonly Filters: readonly { readonly Pattern: string }[];
}

export interface LambdaEventSourceMappingModel {
  readonly BatchSize: number;
  readonly BisectBatchOnFunctionError?: boolean;
  readonly DestinationConfig?: { readonly OnFailure: { readonly Destination: string } };
  readonly Enabled: boolean;
  readonly EventSourceArn: string;
  readonly FilterCriteria?: LambdaEventFilterCriteriaModel;
  readonly FunctionName: string;
  readonly FunctionResponseTypes: readonly "ReportBatchItemFailures"[];
  readonly MaximumBatchingWindowInSeconds: number;
  readonly MaximumRecordAgeInSeconds?: number;
  readonly MaximumRetryAttempts?: number;
  readonly ParallelizationFactor?: number;
  readonly ScalingConfig?: { readonly MaximumConcurrency: number };
  readonly StartingPosition?: "TRIM_HORIZON" | "LATEST";
  readonly TumblingWindowInSeconds?: number;
}

export interface LambdaEventInvokeConfigModel {
  readonly DestinationConfig?: {
    readonly OnFailure?: { readonly Destination: string };
    readonly OnSuccess?: { readonly Destination: string };
  };
  readonly FunctionName: string;
  readonly MaximumEventAgeInSeconds?: number;
  readonly MaximumRetryAttempts?: number;
  readonly Qualifier: string;
}

export const LAMBDA_EVENT_SOURCE_MAPPING_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LAMBDA_EVENT_SOURCE_MAPPING_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    BatchSize: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    BisectBatchOnFunctionError: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
    DestinationConfig: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    Enabled: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
    EventSourceArn: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    FilterCriteria: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    FunctionName: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    FunctionResponseTypes: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    MaximumBatchingWindowInSeconds: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    MaximumRecordAgeInSeconds: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    MaximumRetryAttempts: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    ParallelizationFactor: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    ScalingConfig: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    StartingPosition: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    TumblingWindowInSeconds: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Event source mapping UUID" }),
  attributes: Object.freeze({
    EventSourceMappingArn: Object.freeze({ valueType: "string", description: "Event source mapping ARN" }),
    Id: Object.freeze({ valueType: "string", description: "Event source mapping UUID" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: CFN09_RETENTION,
  tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

export const LAMBDA_EVENT_INVOKE_CONFIG_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LAMBDA_EVENT_INVOKE_CONFIG_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    DestinationConfig: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    FunctionName: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    MaximumEventAgeInSeconds: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    MaximumRetryAttempts: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    Qualifier: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "FunctionName|Qualifier unique identifier" }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: CFN09_RETENTION,
  tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

type SourceType = "dynamodb" | "sqs";

function localFunctionTarget(value: unknown, context: ProviderContext, allowQualifier: boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  const plain = /^([A-Za-z0-9-_]{1,64})(?::([A-Za-z0-9-_$]{1,129}))?$/.exec(value);
  if (plain && (allowQualifier || !plain[2])) return `${plain[1]}${plain[2] ? `:${plain[2]}` : ""}`;
  const arn = /^arn:([^:]+):lambda:([^:]+):(\d{12}):function:([A-Za-z0-9-_]{1,64})(?::([A-Za-z0-9-_$]{1,129}))?$/.exec(value);
  if (!arn || arn[1] !== context.partition || arn[2] !== context.region || arn[3] !== context.accountId || (!allowQualifier && arn[5])) return undefined;
  return `${arn[4]}${arn[5] ? `:${arn[5]}` : ""}`;
}

function sourceType(value: unknown, context: ProviderContext): SourceType | undefined {
  if (typeof value !== "string") return undefined;
  const sqs = /^arn:([^:]+):sqs:([^:]+):(\d{12}):([A-Za-z0-9_-]{1,80})$/.exec(value);
  if (sqs && sqs[1] === context.partition && sqs[2] === context.region && sqs[3] === context.accountId) return "sqs";
  const dynamodb = /^arn:([^:]+):dynamodb:([^:]+):(\d{12}):table\/[^/]+\/stream\/.+$/.exec(value);
  if (dynamodb && dynamodb[1] === context.partition && dynamodb[2] === context.region && dynamodb[3] === context.accountId) return "dynamodb";
  return undefined;
}

function standardSqsDestination(value: unknown, context: ProviderContext): value is string {
  if (typeof value !== "string") return false;
  const match = /^arn:([^:]+):sqs:([^:]+):(\d{12}):([A-Za-z0-9_-]{1,80})$/.exec(value);
  return Boolean(match && match[1] === context.partition && match[2] === context.region && match[3] === context.accountId);
}

function lambdaDestination(value: unknown, context: ProviderContext): value is string {
  if (typeof value !== "string") return false;
  const match = /^arn:([^:]+):lambda:([^:]+):(\d{12}):function:[A-Za-z0-9-_]{1,64}(?::[A-Za-z0-9-_$]{1,129})?$/.exec(value);
  return Boolean(match && match[1] === context.partition && match[2] === context.region && match[3] === context.accountId);
}

function integer(value: unknown, path: string, minimum: number, maximum: number, issues: ProviderValidationIssue[], allowMinusOne = false): void {
  if (!Number.isInteger(value) || (!(allowMinusOne && value === -1) && (Number(value) < minimum || Number(value) > maximum))) issue(issues, path, `${path.split(".").at(-1)} must be ${allowMinusOne ? "-1 or " : ""}an integer between ${minimum} and ${maximum}`);
}

function validateFilter(value: unknown, type: SourceType, issues: ProviderValidationIssue[]): void {
  const path = "Properties.FilterCriteria";
  if (!isRecord(value)) return;
  exactKeys(value, ["Filters"], path, issues);
  if (!Array.isArray(value.Filters) || value.Filters.length > 5) { issue(issues, `${path}.Filters`, "Filters must be an array containing at most five filters"); return; }
  for (const [index, raw] of value.Filters.entries()) {
    const filterPath = `${path}.Filters.${index}`;
    if (!isRecord(raw)) { issue(issues, filterPath, "Each filter must be an object"); continue; }
    exactKeys(raw, ["Pattern"], filterPath, issues);
    if (typeof raw.Pattern !== "string" || Buffer.byteLength(raw.Pattern) > 4_096) { issue(issues, `${filterPath}.Pattern`, "Pattern must be a JSON string no larger than 4096 bytes"); continue; }
    try {
      const pattern = JSON.parse(raw.Pattern);
      if (!isRecord(pattern) || Object.keys(pattern).some(key => key !== (type === "sqs" ? "body" : "dynamodb"))) issue(issues, `${filterPath}.Pattern`, `${type === "sqs" ? "SQS" : "DynamoDB Streams"} patterns may use only the ${type === "sqs" ? "body" : "dynamodb"} event key`);
    } catch { issue(issues, `${filterPath}.Pattern`, "Pattern must contain valid JSON"); }
  }
}

function validateResponseTypes(value: unknown, issues: ProviderValidationIssue[]): void {
  if (!Array.isArray(value)) return;
  if (value.length > 1 || value.some(item => item !== "ReportBatchItemFailures")) issue(issues, "Properties.FunctionResponseTypes", "FunctionResponseTypes supports only a single ReportBatchItemFailures value");
}

function validateDiscardDestination(value: unknown, context: ProviderContext, issues: ProviderValidationIssue[]): void {
  const path = "Properties.DestinationConfig";
  if (!isRecord(value)) return;
  exactKeys(value, ["OnFailure"], path, issues);
  if (!isRecord(value.OnFailure)) { issue(issues, `${path}.OnFailure`, "DestinationConfig must contain an OnFailure object"); return; }
  exactKeys(value.OnFailure, ["Destination"], `${path}.OnFailure`, issues);
  if (!standardSqsDestination(value.OnFailure.Destination, context)) issue(issues, `${path}.OnFailure.Destination`, "CFN-09 DynamoDB discarded-record destinations must identify a Standard SQS queue in this simulator account and Region");
}

function validateScaling(value: unknown, issues: ProviderValidationIssue[]): void {
  const path = "Properties.ScalingConfig";
  if (!isRecord(value)) return;
  exactKeys(value, ["MaximumConcurrency"], path, issues);
  if (value.MaximumConcurrency !== undefined) integer(value.MaximumConcurrency, `${path}.MaximumConcurrency`, 2, 1_000, issues);
}

const DYNAMODB_ONLY = ["BisectBatchOnFunctionError", "DestinationConfig", "MaximumRecordAgeInSeconds", "MaximumRetryAttempts", "ParallelizationFactor", "StartingPosition", "TumblingWindowInSeconds"] as const;

function validateEventSourceMapping(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, LAMBDA_EVENT_SOURCE_MAPPING_SCHEMA);
  if (!isRecord(properties)) return issues;
  const type = sourceType(properties.EventSourceArn, context);
  if (!type) {
    const service = typeof properties.EventSourceArn === "string" && properties.EventSourceArn.startsWith("arn:") ? properties.EventSourceArn.split(":")[2] : "unknown";
    issue(issues, "Properties.EventSourceArn", `CFN-09 supports only same-account, same-Region DynamoDB Streams and Standard SQS event sources; ${service} belongs to another source family or phase`);
  }
  if (!localFunctionTarget(properties.FunctionName, context, true)) issue(issues, "Properties.FunctionName", "FunctionName must identify a Lambda function or qualifier in this simulator account and Region");
  if (properties.Enabled !== undefined && typeof properties.Enabled !== "boolean") issue(issues, "Properties.Enabled", "Enabled must be a boolean");
  if (properties.MaximumBatchingWindowInSeconds !== undefined) integer(properties.MaximumBatchingWindowInSeconds, "Properties.MaximumBatchingWindowInSeconds", 0, 300, issues);
  if (properties.FunctionResponseTypes !== undefined) validateResponseTypes(properties.FunctionResponseTypes, issues);
  if (type && properties.FilterCriteria !== undefined) validateFilter(properties.FilterCriteria, type, issues);
  if (type === "sqs") {
    if (properties.BatchSize !== undefined) integer(properties.BatchSize, "Properties.BatchSize", 1, 10_000, issues);
    if (Number(properties.BatchSize ?? 10) > 10 && Number(properties.MaximumBatchingWindowInSeconds ?? 0) < 1) issue(issues, "Properties.MaximumBatchingWindowInSeconds", "MaximumBatchingWindowInSeconds must be at least 1 when SQS BatchSize is greater than 10");
    for (const field of DYNAMODB_ONLY) if (properties[field] !== undefined) issue(issues, `Properties.${field}`, `${field} is not supported for Standard SQS event source mappings in CFN-09`);
    if (properties.ScalingConfig !== undefined) validateScaling(properties.ScalingConfig, issues);
  }
  if (type === "dynamodb") {
    if (properties.BatchSize !== undefined) integer(properties.BatchSize, "Properties.BatchSize", 1, 10_000, issues);
    if (Number(properties.BatchSize ?? 100) > 10 && properties.BatchSize !== undefined && Number(properties.MaximumBatchingWindowInSeconds ?? 0) < 1) issue(issues, "Properties.MaximumBatchingWindowInSeconds", "MaximumBatchingWindowInSeconds must be at least 1 when an explicit DynamoDB BatchSize is greater than 10");
    if (properties.StartingPosition !== "TRIM_HORIZON" && properties.StartingPosition !== "LATEST") issue(issues, "Properties.StartingPosition", "DynamoDB Streams mappings require StartingPosition TRIM_HORIZON or LATEST");
    if (properties.BisectBatchOnFunctionError !== undefined && typeof properties.BisectBatchOnFunctionError !== "boolean") issue(issues, "Properties.BisectBatchOnFunctionError", "BisectBatchOnFunctionError must be a boolean");
    if (properties.MaximumRecordAgeInSeconds !== undefined) integer(properties.MaximumRecordAgeInSeconds, "Properties.MaximumRecordAgeInSeconds", 60, 604_800, issues, true);
    if (properties.MaximumRetryAttempts !== undefined) integer(properties.MaximumRetryAttempts, "Properties.MaximumRetryAttempts", 0, 10_000, issues, true);
    if (properties.ParallelizationFactor !== undefined) integer(properties.ParallelizationFactor, "Properties.ParallelizationFactor", 1, 10, issues);
    if (properties.TumblingWindowInSeconds !== undefined) integer(properties.TumblingWindowInSeconds, "Properties.TumblingWindowInSeconds", 0, 900, issues);
    if (properties.DestinationConfig !== undefined) validateDiscardDestination(properties.DestinationConfig, context, issues);
    if (properties.ScalingConfig !== undefined) issue(issues, "Properties.ScalingConfig", "ScalingConfig is supported only for Standard SQS event source mappings");
  }
  return issues;
}

function canonicalFilter(value: unknown): LambdaEventFilterCriteriaModel | undefined {
  if (!isRecord(value) || !Array.isArray(value.Filters) || !value.Filters.length) return undefined;
  return { Filters: value.Filters.map(item => ({ Pattern: String((item as Record<string, unknown>).Pattern) })) };
}

function canonicalEventSourceMapping(properties: Record<string, unknown>, context: ProviderContext): LambdaEventSourceMappingModel {
  const type = sourceType(properties.EventSourceArn, context)!;
  const filter = canonicalFilter(properties.FilterCriteria);
  const responseTypes = (Array.isArray(properties.FunctionResponseTypes) ? properties.FunctionResponseTypes : []) as "ReportBatchItemFailures"[];
  const common = {
    BatchSize: Number(properties.BatchSize ?? (type === "sqs" ? 10 : 100)),
    Enabled: properties.Enabled === undefined ? true : Boolean(properties.Enabled),
    EventSourceArn: String(properties.EventSourceArn),
    ...(filter ? { FilterCriteria: filter } : {}),
    FunctionName: localFunctionTarget(properties.FunctionName, context, true)!,
    FunctionResponseTypes: [...responseTypes],
    MaximumBatchingWindowInSeconds: Number(properties.MaximumBatchingWindowInSeconds ?? 0),
  };
  if (type === "sqs") {
    const scaling = isRecord(properties.ScalingConfig) && properties.ScalingConfig.MaximumConcurrency !== undefined ? { MaximumConcurrency: Number(properties.ScalingConfig.MaximumConcurrency) } : undefined;
    return { ...common, ...(scaling ? { ScalingConfig: scaling } : {}) };
  }
  const destination = isRecord(properties.DestinationConfig) && isRecord(properties.DestinationConfig.OnFailure) ? { OnFailure: { Destination: String(properties.DestinationConfig.OnFailure.Destination) } } : undefined;
  return {
    ...common,
    BisectBatchOnFunctionError: Boolean(properties.BisectBatchOnFunctionError ?? false),
    ...(destination ? { DestinationConfig: destination } : {}),
    MaximumRecordAgeInSeconds: Number(properties.MaximumRecordAgeInSeconds ?? -1),
    MaximumRetryAttempts: Number(properties.MaximumRetryAttempts ?? -1),
    ParallelizationFactor: Number(properties.ParallelizationFactor ?? 1),
    StartingPosition: properties.StartingPosition as "TRIM_HORIZON" | "LATEST",
    TumblingWindowInSeconds: Number(properties.TumblingWindowInSeconds ?? 0),
  };
}

function mappingUpdateInput(model: LambdaEventSourceMappingModel, type: SourceType): Record<string, unknown> {
  const common = {
    BatchSize: model.BatchSize,
    Enabled: model.Enabled,
    FilterCriteria: model.FilterCriteria ? structuredClone(model.FilterCriteria) : { Filters: [] },
    FunctionName: model.FunctionName,
    FunctionResponseTypes: [...model.FunctionResponseTypes],
    MaximumBatchingWindowInSeconds: model.MaximumBatchingWindowInSeconds,
  };
  return type === "sqs" ? {
    ...common,
    ScalingConfig: model.ScalingConfig ? structuredClone(model.ScalingConfig) : {},
  } : {
    ...common,
    BisectBatchOnFunctionError: model.BisectBatchOnFunctionError,
    DestinationConfig: { OnFailure: { Destination: model.DestinationConfig?.OnFailure.Destination ?? "" } },
    MaximumRecordAgeInSeconds: model.MaximumRecordAgeInSeconds,
    MaximumRetryAttempts: model.MaximumRetryAttempts,
    ParallelizationFactor: model.ParallelizationFactor,
    TumblingWindowInSeconds: model.TumblingWindowInSeconds,
  };
}

function mappingCreateInput(model: LambdaEventSourceMappingModel, type: SourceType, context: ProviderContext): Record<string, unknown> {
  return {
    ...mappingUpdateInput(model, type),
    EventSourceArn: model.EventSourceArn,
    ...(type === "dynamodb" ? { StartingPosition: model.StartingPosition } : {}),
    Tags: { [CFN09_OWNER_TAG]: ownerValue(context) },
  };
}

function mappingModelFromView(view: any, context: ProviderContext): LambdaEventSourceMappingModel {
  const type = sourceType(view.EventSourceArn, context);
  if (!type) throw new AwsError("UnsupportedResourceState", `Event source mapping ${view.UUID} uses a source outside CFN-09`, 409);
  const target = localFunctionTarget(view.FunctionArn, context, true);
  if (!target) throw new AwsError("UnsupportedResourceState", `Event source mapping ${view.UUID} uses a function outside this simulator account and Region`, 409);
  const filter = canonicalFilter(view.FilterCriteria);
  const common = {
    BatchSize: Number(view.BatchSize), Enabled: String(view.State) !== "Disabled", EventSourceArn: String(view.EventSourceArn),
    ...(filter ? { FilterCriteria: filter } : {}), FunctionName: target,
    FunctionResponseTypes: [...(view.FunctionResponseTypes ?? [])] as "ReportBatchItemFailures"[],
    MaximumBatchingWindowInSeconds: Number(view.MaximumBatchingWindowInSeconds),
  };
  if (type === "sqs") return { ...common, ...(view.ScalingConfig?.MaximumConcurrency !== undefined ? { ScalingConfig: { MaximumConcurrency: Number(view.ScalingConfig.MaximumConcurrency) } } : {}) };
  const destination = view.DestinationConfig?.OnFailure?.Destination;
  if (destination && !standardSqsDestination(destination, context)) throw new AwsError("UnsupportedResourceState", `Event source mapping ${view.UUID} uses a discarded-record destination outside CFN-09`, 409);
  return {
    ...common,
    BisectBatchOnFunctionError: Boolean(view.BisectBatchOnFunctionError),
    ...(view.DestinationConfig?.OnFailure?.Destination ? { DestinationConfig: { OnFailure: { Destination: String(view.DestinationConfig.OnFailure.Destination) } } } : {}),
    MaximumRecordAgeInSeconds: Number(view.MaximumRecordAgeInSeconds), MaximumRetryAttempts: Number(view.MaximumRetryAttempts),
    ParallelizationFactor: Number(view.ParallelizationFactor), StartingPosition: String(view.StartingPosition) as "TRIM_HORIZON" | "LATEST",
    TumblingWindowInSeconds: Number(view.TumblingWindowInSeconds),
  };
}

function mappingSuccess(view: any, context: ProviderContext): ProviderSuccess<LambdaEventSourceMappingModel> {
  const uuid = String(view.UUID); const arn = String(view.EventSourceMappingArn);
  return { status: "SUCCESS", physicalId: uuid, model: { physicalId: uuid, properties: mappingModelFromView(view, context), attributes: { EventSourceMappingArn: arn, Id: uuid } } };
}

function mappingInProgress(uuid: string, reason: string): ProviderInProgress {
  return { status: "IN_PROGRESS", callbackAfterMs: 0, checkpoint: { schemaVersion: 1, callbackContext: { stateMachine: "lambda-event-source-mapping-v1", physicalId: uuid, reason }, physicalId: uuid }, message: reason };
}

function invoker(lambda: LambdaService) {
  return <T>(context: ProviderContext, method: string, path: string, input?: unknown) => invokeJsonService<T>({
    method, path, input,
    handle: (req, res, pathname, url) => lambda.handle(req, res, pathname, url, context.principal.identity),
  });
}

export function createLambdaEventSourceMappingProvider(lambda: LambdaService): ProductionResourceProvider<LambdaEventSourceMappingModel> {
  const invoke = invoker(lambda);
  const get = async (uuid: string, context: ProviderContext): Promise<any> => (await invoke<any>(context, "GET", `/2015-03-31/event-source-mappings/${encodeURIComponent(uuid)}`)).body;
  const tags = async (arn: string, context: ProviderContext): Promise<Record<string, string>> => (await invoke<any>(context, "GET", `/2017-03-31/tags/${encodeURIComponent(arn)}`)).body.Tags ?? {};
  const owned = async (view: any, context: ProviderContext): Promise<boolean> => (await tags(String(view.EventSourceMappingArn), context))[CFN09_OWNER_TAG] === ownerValue(context);
  const reconcile = async (uuid: string, desired: LambdaEventSourceMappingModel, context: ProviderContext): Promise<ProviderUpdateResult<LambdaEventSourceMappingModel>> => {
    const view = await get(uuid, context);
    if (!await owned(view, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Event source mapping ${uuid} is not owned by this stack resource` };
    if (["Creating", "Updating", "Deleting"].includes(String(view.State))) return mappingInProgress(uuid, `Waiting for event source mapping ${uuid} to stabilize`);
    const actual = mappingModelFromView(view, context);
    if (actual.EventSourceArn !== desired.EventSourceArn || actual.StartingPosition !== desired.StartingPosition) return { status: "FAILED", errorCode: "RequiresReplacement", message: "EventSourceArn and StartingPosition changes require replacement" };
    if (same(actual, desired)) return mappingSuccess(view, context);
    if (actual.FunctionName !== desired.FunctionName) {
      const collisions = await scan(desired, context);
      if (collisions.some(candidate => String(candidate.UUID) !== uuid)) return { status: "FAILED", errorCode: "AlreadyExists", message: "An event source mapping already exists for the desired function and source" };
    }
    const type = sourceType(desired.EventSourceArn, context)!;
    await invoke(context, "PUT", `/2015-03-31/event-source-mappings/${encodeURIComponent(uuid)}`, mappingUpdateInput(desired, type));
    return mappingInProgress(uuid, `Updating event source mapping ${uuid}`);
  };
  const scan = async (desired: LambdaEventSourceMappingModel, context: ProviderContext): Promise<any[]> => {
    const query = new URLSearchParams({ EventSourceArn: desired.EventSourceArn, FunctionName: desired.FunctionName, MaxItems: "10000" });
    const response = (await invoke<any>(context, "GET", `/2015-03-31/event-source-mappings?${query}`)).body;
    return response.EventSourceMappings ?? [];
  };
  return {
    typeName: LAMBDA_EVENT_SOURCE_MAPPING_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: LAMBDA_EVENT_SOURCE_MAPPING_SCHEMA,
    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] { return validateEventSourceMapping(properties, context); },
    canonicalize(properties: unknown, context: ProviderContext): LambdaEventSourceMappingModel {
      if (!isRecord(properties)) throw new TypeError(`${LAMBDA_EVENT_SOURCE_MAPPING_TYPE} Properties must be an object`);
      const issues = validateEventSourceMapping(properties, context); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return canonicalEventSourceMapping(properties, context);
    },
    plan(previous: LambdaEventSourceMappingModel | undefined, desired: LambdaEventSourceMappingModel): ProviderPlan<LambdaEventSourceMappingModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const changed = changedProperties(previous, desired); if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      const replacements = (["EventSourceArn", "StartingPosition"] as const).filter(field => !same(previous[field], desired[field]));
      if (!replacements.length) return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
      const conflicts = previous.EventSourceArn === desired.EventSourceArn && previous.FunctionName === desired.FunctionName;
      return { action: "REPLACE", desired, changedProperties: changed, replacementProperties: replacements, replacementOrder: conflicts ? "DELETE_BEFORE_CREATE" : "CREATE_BEFORE_DELETE", ...(conflicts ? { reason: "Lambda permits only one mapping for a function and event-source pair" } : {}) };
    },
    async create(desired: LambdaEventSourceMappingModel, context: ProviderContext) {
      try {
        const checkpoint = context.callbackContext?.physicalId;
        if (typeof checkpoint === "string") return await reconcile(checkpoint, desired, context);
        const existing = await scan(desired, context);
        for (const candidate of existing) {
          if (await owned(candidate, context)) return await reconcile(String(candidate.UUID), desired, context);
        }
        if (existing.length) return { status: "FAILED", errorCode: "AlreadyExists", message: "An event source mapping already exists for this function and source and is not owned by this stack resource" };
        const type = sourceType(desired.EventSourceArn, context)!;
        const created = (await invoke<any>(context, "POST", "/2015-03-31/event-source-mappings", mappingCreateInput(desired, type, context))).body;
        return mappingInProgress(String(created.UUID), `Creating event source mapping ${created.UUID}`);
      } catch (error) { return providerFailure(error); }
    },
    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<LambdaEventSourceMappingModel>> {
      try { const view = await get(physicalId, context); return ["Creating", "Updating", "Deleting"].includes(String(view.State)) ? mappingInProgress(physicalId, `Waiting for event source mapping ${physicalId} to stabilize`) : mappingSuccess(view, context); }
      catch (error) { return isNotFound(error, ["ResourceNotFoundException"]) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    async update(physicalId: string, _previous: LambdaEventSourceMappingModel, desired: LambdaEventSourceMappingModel, context: ProviderContext): Promise<ProviderUpdateResult<LambdaEventSourceMappingModel>> {
      try { return await reconcile(physicalId, desired, context); }
      catch (error) { return providerFailure(error); }
    },
    async delete(physicalId: string, previous: LambdaEventSourceMappingModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const view = await get(physicalId, context);
        if (!await owned(view, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Event source mapping ${physicalId} is not owned by this stack resource` };
        const actual = mappingModelFromView(view, context);
        if (actual.EventSourceArn !== previous.EventSourceArn) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Event source mapping ${physicalId} no longer identifies the recorded event source` };
        await invoke(context, "DELETE", `/2015-03-31/event-source-mappings/${encodeURIComponent(physicalId)}`);
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isNotFound(error, ["ResourceNotFoundException"]) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    ref(current: ProviderReadModel<LambdaEventSourceMappingModel>): unknown { return current.physicalId; },
    getAtt(current: ProviderReadModel<LambdaEventSourceMappingModel>, attribute: string): unknown {
      if (attribute === "EventSourceMappingArn" || attribute === "Id") return current.attributes[attribute];
      throw new ProviderReferenceError(LAMBDA_EVENT_SOURCE_MAPPING_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}

function validateInvokeDestination(value: unknown, path: string, context: ProviderContext, issues: ProviderValidationIssue[]): void {
  if (!isRecord(value)) { issue(issues, path, `${path.split(".").at(-1)} must be an object`); return; }
  exactKeys(value, ["Destination"], path, issues);
  if (!lambdaDestination(value.Destination, context) && !standardSqsDestination(value.Destination, context)) issue(issues, `${path}.Destination`, "CFN-09 async destinations must identify a local Lambda function or Standard SQS queue; SNS, S3, and EventBridge destinations belong to their later CloudFormation slices");
}

function validateEventInvokeConfig(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, LAMBDA_EVENT_INVOKE_CONFIG_SCHEMA);
  if (!isRecord(properties)) return issues;
  if (!localFunctionTarget(properties.FunctionName, context, false)) issue(issues, "Properties.FunctionName", "FunctionName must identify an unqualified Lambda function in this simulator account and Region");
  if (typeof properties.Qualifier === "string" && !/^(?:\$LATEST|[A-Za-z0-9-_$]{1,129})$/.test(properties.Qualifier)) issue(issues, "Properties.Qualifier", "Qualifier must be $LATEST, a version, or an alias");
  if (properties.MaximumEventAgeInSeconds !== undefined) integer(properties.MaximumEventAgeInSeconds, "Properties.MaximumEventAgeInSeconds", 60, 21_600, issues);
  if (properties.MaximumRetryAttempts !== undefined) integer(properties.MaximumRetryAttempts, "Properties.MaximumRetryAttempts", 0, 2, issues);
  if (properties.DestinationConfig !== undefined) {
    const path = "Properties.DestinationConfig";
    if (isRecord(properties.DestinationConfig)) {
      exactKeys(properties.DestinationConfig, ["OnFailure", "OnSuccess"], path, issues);
      if (properties.DestinationConfig.OnFailure !== undefined) validateInvokeDestination(properties.DestinationConfig.OnFailure, `${path}.OnFailure`, context, issues);
      if (properties.DestinationConfig.OnSuccess !== undefined) validateInvokeDestination(properties.DestinationConfig.OnSuccess, `${path}.OnSuccess`, context, issues);
      if (properties.DestinationConfig.OnFailure === undefined && properties.DestinationConfig.OnSuccess === undefined) issue(issues, path, "DestinationConfig must contain OnFailure or OnSuccess");
    }
  }
  return issues;
}

function canonicalEventInvokeConfig(properties: Record<string, unknown>, context: ProviderContext): LambdaEventInvokeConfigModel {
  const raw = isRecord(properties.DestinationConfig) ? properties.DestinationConfig : undefined;
  const destination = raw ? {
    ...(isRecord(raw.OnFailure) ? { OnFailure: { Destination: String(raw.OnFailure.Destination) } } : {}),
    ...(isRecord(raw.OnSuccess) ? { OnSuccess: { Destination: String(raw.OnSuccess.Destination) } } : {}),
  } : undefined;
  return {
    ...(destination && Object.keys(destination).length ? { DestinationConfig: destination } : {}),
    FunctionName: localFunctionTarget(properties.FunctionName, context, false)!,
    ...(properties.MaximumEventAgeInSeconds !== undefined ? { MaximumEventAgeInSeconds: Number(properties.MaximumEventAgeInSeconds) } : {}),
    ...(properties.MaximumRetryAttempts !== undefined ? { MaximumRetryAttempts: Number(properties.MaximumRetryAttempts) } : {}),
    Qualifier: String(properties.Qualifier),
  };
}

function invokeConfigId(model: Pick<LambdaEventInvokeConfigModel, "FunctionName" | "Qualifier">): string { return `${model.FunctionName}|${model.Qualifier}`; }
function parseInvokeConfigId(physicalId: string): { FunctionName: string; Qualifier: string } {
  const separator = physicalId.lastIndexOf("|");
  if (separator < 1 || separator === physicalId.length - 1) throw new Error(`Invalid Lambda EventInvokeConfig physical ID ${physicalId}`);
  return { FunctionName: physicalId.slice(0, separator), Qualifier: physicalId.slice(separator + 1) };
}

function invokeConfigInput(model: LambdaEventInvokeConfigModel): Record<string, unknown> {
  return {
    ...(model.DestinationConfig ? { DestinationConfig: structuredClone(model.DestinationConfig) } : {}),
    ...(model.MaximumEventAgeInSeconds !== undefined ? { MaximumEventAgeInSeconds: model.MaximumEventAgeInSeconds } : {}),
    ...(model.MaximumRetryAttempts !== undefined ? { MaximumRetryAttempts: model.MaximumRetryAttempts } : {}),
  };
}

function invokeConfigFromView(view: any, identity: { FunctionName: string; Qualifier: string }, context: ProviderContext): LambdaEventInvokeConfigModel {
  for (const condition of ["OnFailure", "OnSuccess"] as const) {
    const target = view.DestinationConfig?.[condition]?.Destination;
    if (target && !lambdaDestination(target, context) && !standardSqsDestination(target, context)) {
      throw new AwsError("UnsupportedResourceState", `Async invocation ${condition} destination is outside the CFN-09 local Lambda/SQS boundary`, 409);
    }
  }
  const destination = view.DestinationConfig ? {
    ...(view.DestinationConfig.OnFailure?.Destination ? { OnFailure: { Destination: String(view.DestinationConfig.OnFailure.Destination) } } : {}),
    ...(view.DestinationConfig.OnSuccess?.Destination ? { OnSuccess: { Destination: String(view.DestinationConfig.OnSuccess.Destination) } } : {}),
  } : undefined;
  return {
    ...(destination && Object.keys(destination).length ? { DestinationConfig: destination } : {}),
    FunctionName: identity.FunctionName,
    ...(view.MaximumEventAgeInSeconds !== undefined ? { MaximumEventAgeInSeconds: Number(view.MaximumEventAgeInSeconds) } : {}),
    ...(view.MaximumRetryAttempts !== undefined ? { MaximumRetryAttempts: Number(view.MaximumRetryAttempts) } : {}),
    Qualifier: identity.Qualifier,
  };
}

function invokeConfigSuccess(view: any, identity: { FunctionName: string; Qualifier: string }, context: ProviderContext): ProviderSuccess<LambdaEventInvokeConfigModel> {
  const properties = invokeConfigFromView(view, identity, context); const physicalId = invokeConfigId(properties);
  return { status: "SUCCESS", physicalId, model: { physicalId, properties, attributes: {} } };
}

export function createLambdaEventInvokeConfigProvider(lambda: LambdaService): ProductionResourceProvider<LambdaEventInvokeConfigModel> {
  const invoke = invoker(lambda);
  const path = (identity: { FunctionName: string; Qualifier: string }): string => `/2019-09-25/functions/${encodeURIComponent(identity.FunctionName)}/event-invoke-config?Qualifier=${encodeURIComponent(identity.Qualifier)}`;
  const get = async (identity: { FunctionName: string; Qualifier: string }, context: ProviderContext): Promise<any> => (await invoke<any>(context, "GET", path(identity))).body;
  return {
    typeName: LAMBDA_EVENT_INVOKE_CONFIG_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: LAMBDA_EVENT_INVOKE_CONFIG_SCHEMA,
    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] { return validateEventInvokeConfig(properties, context); },
    canonicalize(properties: unknown, context: ProviderContext): LambdaEventInvokeConfigModel {
      if (!isRecord(properties)) throw new TypeError(`${LAMBDA_EVENT_INVOKE_CONFIG_TYPE} Properties must be an object`);
      const issues = validateEventInvokeConfig(properties, context); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return canonicalEventInvokeConfig(properties, context);
    },
    plan(previous: LambdaEventInvokeConfigModel | undefined, desired: LambdaEventInvokeConfigModel): ProviderPlan<LambdaEventInvokeConfigModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const changed = changedProperties(previous, desired); if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      const replacements = (["FunctionName", "Qualifier"] as const).filter(field => previous[field] !== desired[field]);
      return replacements.length ? { action: "REPLACE", desired, changedProperties: changed, replacementProperties: replacements, replacementOrder: "CREATE_BEFORE_DELETE" } : { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
    },
    async create(desired: LambdaEventInvokeConfigModel, context: ProviderContext) {
      const identity = { FunctionName: desired.FunctionName, Qualifier: desired.Qualifier };
      try {
        try {
          const existing = await get(identity, context); const actual = invokeConfigFromView(existing, identity, context);
          return same(actual, desired) ? invokeConfigSuccess(existing, identity, context) : { status: "FAILED", errorCode: "AlreadyExists", message: `An async invocation configuration already exists for ${invokeConfigId(identity)} with different contents` };
        } catch (error) { if (!isNotFound(error, ["ResourceNotFoundException"])) throw error; }
        await invoke(context, "PUT", path(identity), invokeConfigInput(desired));
        return invokeConfigSuccess(await get(identity, context), identity, context);
      } catch (error) { return providerFailure(error); }
    },
    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<LambdaEventInvokeConfigModel>> {
      try { const identity = parseInvokeConfigId(physicalId); return invokeConfigSuccess(await get(identity, context), identity, context); }
      catch (error) { return isNotFound(error, ["ResourceNotFoundException"]) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    async update(physicalId: string, previous: LambdaEventInvokeConfigModel, desired: LambdaEventInvokeConfigModel, context: ProviderContext): Promise<ProviderUpdateResult<LambdaEventInvokeConfigModel>> {
      try {
        if (physicalId !== invokeConfigId(desired)) return { status: "FAILED", errorCode: "RequiresReplacement", message: "FunctionName and Qualifier changes require replacement" };
        const identity = parseInvokeConfigId(physicalId); const before = await get(identity, context); const actual = invokeConfigFromView(before, identity, context);
        if (!same(actual, previous) && !same(actual, desired)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Async invocation configuration ${physicalId} no longer matches the resource recorded by CloudFormation` };
        if (same(actual, desired)) return invokeConfigSuccess(before, identity, context);
        await invoke(context, "PUT", path(identity), invokeConfigInput(desired));
        return invokeConfigSuccess(await get(identity, context), identity, context);
      } catch (error) { return providerFailure(error); }
    },
    async delete(physicalId: string, previous: LambdaEventInvokeConfigModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const identity = parseInvokeConfigId(physicalId); const before = await get(identity, context); const actual = invokeConfigFromView(before, identity, context);
        if (!same(actual, previous)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Async invocation configuration ${physicalId} no longer matches the resource recorded by CloudFormation` };
        await invoke(context, "DELETE", path(identity));
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isNotFound(error, ["ResourceNotFoundException"]) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    ref(current: ProviderReadModel<LambdaEventInvokeConfigModel>): unknown { return current.physicalId; },
    getAtt(_current: ProviderReadModel<LambdaEventInvokeConfigModel>, attribute: string): never { throw new ProviderReferenceError(LAMBDA_EVENT_INVOKE_CONFIG_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

export function createLambdaEventConfigurationProviders(lambda: LambdaService): readonly ProductionResourceProvider<any>[] {
  return [createLambdaEventSourceMappingProvider(lambda), createLambdaEventInvokeConfigProvider(lambda)];
}
