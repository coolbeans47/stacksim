import { createHash } from "node:crypto";
import type { S3Service } from "../../s3.js";
import type { StateStore } from "../../state.js";
import type { S3BucketState } from "../../types.js";
import { AwsError } from "../../errors.js";
import {
  ProviderReferenceError,
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
import { isRecord, issue, same, stable } from "./s3-common.js";

/**
 * The aws-cdk-lib `Custom::S3BucketNotifications` helper, implemented
 * natively. `bucket.addEventNotification(...)` and `S3EventSource` emit this
 * resource plus an inline Python handler function; the handler is admitted by
 * the function provider but never invoked, and this provider applies the
 * notification configuration to the local bucket the way the handler does on
 * AWS: a managed bucket's configuration is replaced, an unmanaged (imported)
 * bucket keeps the configurations this stack did not create.
 */
export const S3_BUCKET_NOTIFICATIONS_TYPE = "Custom::S3BucketNotifications";
export const S3_BUCKET_NOTIFICATIONS_HANDLER_DESCRIPTION = "AWS CloudFormation handler for \"Custom::S3BucketNotifications\" resources (@aws-cdk/aws-s3)";

type NotificationState = NonNullable<S3BucketState["notificationConfiguration"]>;
type NotificationEntry = NotificationState["lambda"][number];

export interface S3NotificationFilterRuleModel { readonly Name: "prefix" | "suffix"; readonly Value: string }
export interface S3NotificationDestinationModel {
  readonly Events: readonly string[];
  readonly Filter?: { readonly Key: { readonly FilterRules: readonly S3NotificationFilterRuleModel[] } };
  readonly LambdaFunctionArn?: string;
  readonly QueueArn?: string;
}
export interface S3BucketNotificationsConfigurationModel {
  readonly LambdaFunctionConfigurations?: readonly S3NotificationDestinationModel[];
  readonly QueueConfigurations?: readonly S3NotificationDestinationModel[];
  readonly EventBridgeConfiguration?: Record<string, never>;
}
export interface S3BucketNotificationsModel {
  readonly ServiceToken: string;
  readonly BucketName: string;
  readonly NotificationConfiguration: S3BucketNotificationsConfigurationModel;
  readonly Managed: boolean;
  readonly SkipDestinationValidation: boolean;
}

export const S3_BUCKET_NOTIFICATIONS_SCHEMA: ProviderSchema = Object.freeze({
  typeName: S3_BUCKET_NOTIFICATIONS_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ServiceToken: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE", sensitive: true }),
    BucketName: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    NotificationConfiguration: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    Managed: Object.freeze({ valueType: "any", updateBehavior: "MUTABLE", description: "true when the bucket belongs to this stack; the helper accepts a boolean or its string form" }),
    SkipDestinationValidation: Object.freeze({ valueType: "any", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "The helper's physical ID: the logical resource ID" }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: Object.freeze({
    deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    snapshotSupported: false,
  }),
  tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

const CONFIGURATION_TYPES = ["LambdaFunctionConfigurations", "QueueConfigurations"] as const;
const S3_NOTIFICATION_EVENT = /^(?:s3:)?(?:(?:ObjectCreated|ObjectRemoved):(?:\*|Put|Post|Copy|CompleteMultipartUpload|Delete|DeleteMarkerCreated)|ObjectRestore:(?:\*|Post|Completed|Delete)|ObjectTagging:(?:\*|Put|Delete)|ObjectAcl:Put|ObjectAnnotation:(?:\*|Put|Delete)|LifecycleExpiration:(?:\*|Delete|DeleteMarkerCreated|DeleteMarkerDeleted)|LifecycleTransition)$/;
const LAMBDA_ARN = /^arn:aws:lambda:[^:]+:\d{12}:function:[A-Za-z0-9-_]+(?::[A-Za-z0-9-_$]+)?$/;
const QUEUE_ARN = /^arn:aws:sqs:[^:]+:\d{12}:[A-Za-z0-9-_]+(?:\.fifo)?$/;

function helperBoolean(value: unknown, fallback: boolean): boolean | undefined {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && ["true", "false"].includes(value.toLowerCase())) return value.toLowerCase() === "true";
  return undefined;
}

function validateDestination(value: unknown, path: string, kind: typeof CONFIGURATION_TYPES[number], issues: ProviderValidationIssue[]): void {
  if (!isRecord(value)) { issue(issues, path, "Each notification configuration must be an object"); return; }
  const destinationKey = kind === "LambdaFunctionConfigurations" ? "LambdaFunctionArn" : "QueueArn";
  for (const key of Object.keys(value)) if (!["Events", "Filter", "Id", destinationKey].includes(key)) issue(issues, `${path}.${key}`, `${key} is not supported in ${kind}`);
  if (!Array.isArray(value.Events) || !value.Events.length || value.Events.some(event => typeof event !== "string" || !S3_NOTIFICATION_EVENT.test(event))) issue(issues, `${path}.Events`, "Events must list supported S3 notification event names");
  const arn = value[destinationKey];
  if (typeof arn !== "string" || !(kind === "LambdaFunctionConfigurations" ? LAMBDA_ARN : QUEUE_ARN).test(arn)) issue(issues, `${path}.${destinationKey}`, `${destinationKey} must be a resolved ${kind === "LambdaFunctionConfigurations" ? "Lambda function" : "SQS queue"} ARN`);
  if (value.Id !== undefined && (typeof value.Id !== "string" || !value.Id || Buffer.byteLength(value.Id) > 255)) issue(issues, `${path}.Id`, "Id must be a string of at most 255 bytes");
  if (value.Filter === undefined) return;
  const rules = isRecord(value.Filter) && isRecord(value.Filter.Key) ? value.Filter.Key.FilterRules : undefined;
  if (!isRecord(value.Filter) || Object.keys(value.Filter).some(key => key !== "Key") || !isRecord(value.Filter.Key) || Object.keys(value.Filter.Key).some(key => key !== "FilterRules") || !Array.isArray(rules)) { issue(issues, `${path}.Filter`, "Filter must be { Key: { FilterRules: [...] } }"); return; }
  const names = rules.map(rule => isRecord(rule) && typeof rule.Name === "string" ? rule.Name.toLowerCase() : "");
  if (rules.some(rule => !isRecord(rule) || typeof rule.Value !== "string") || names.some(name => name !== "prefix" && name !== "suffix") || new Set(names).size !== names.length) issue(issues, `${path}.Filter.Key.FilterRules`, "FilterRules accept at most one prefix and one suffix rule with string values");
}

function validateProperties(properties: unknown, context?: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, S3_BUCKET_NOTIFICATIONS_SCHEMA);
  if (!isRecord(properties)) return issues;
  if (typeof properties.BucketName !== "string" || !properties.BucketName) issue(issues, "Properties.BucketName", "BucketName must be a resolved bucket name");
  if (typeof properties.ServiceToken === "string" && context && !properties.ServiceToken.startsWith(`arn:${context.partition}:lambda:${context.region}:${context.accountId}:function:`)) issue(issues, "Properties.ServiceToken", "ServiceToken must be the stack's generated BucketNotificationsHandler function ARN");
  if (helperBoolean(properties.Managed, true) === undefined) issue(issues, "Properties.Managed", "Managed must be a boolean or 'true'/'false'");
  if (helperBoolean(properties.SkipDestinationValidation, false) === undefined) issue(issues, "Properties.SkipDestinationValidation", "SkipDestinationValidation must be a boolean or 'true'/'false'");
  const configuration = properties.NotificationConfiguration;
  if (!isRecord(configuration)) return issues;
  for (const key of Object.keys(configuration)) {
    if (key === "TopicConfigurations") issue(issues, "Properties.NotificationConfiguration.TopicConfigurations", "SNS notification destinations are not supported by the local S3 service");
    else if (key === "EventBridgeConfiguration") { if (!isRecord(configuration[key]) || Object.keys(configuration[key] as object).length) issue(issues, `Properties.NotificationConfiguration.${key}`, "EventBridgeConfiguration must be an empty object"); }
    else if (!(CONFIGURATION_TYPES as readonly string[]).includes(key)) issue(issues, `Properties.NotificationConfiguration.${key}`, `${key} is not supported in NotificationConfiguration`);
  }
  for (const kind of CONFIGURATION_TYPES) {
    const items = configuration[kind];
    if (items === undefined) continue;
    if (!Array.isArray(items)) { issue(issues, `Properties.NotificationConfiguration.${kind}`, `${kind} must be an array`); continue; }
    items.forEach((item, index) => validateDestination(item, `Properties.NotificationConfiguration.${kind}.${index}`, kind, issues));
  }
  return issues;
}

function canonicalDestination(value: Record<string, unknown>, kind: typeof CONFIGURATION_TYPES[number]): S3NotificationDestinationModel {
  const rules = isRecord(value.Filter) && isRecord(value.Filter.Key) && Array.isArray(value.Filter.Key.FilterRules) ? value.Filter.Key.FilterRules as Array<Record<string, unknown>> : undefined;
  const filterRules = rules?.map(rule => ({ Name: String(rule.Name).toLowerCase() as "prefix" | "suffix", Value: String(rule.Value) })).sort((left, right) => left.Name.localeCompare(right.Name));
  return {
    Events: [...(value.Events as string[])].map(event => event.startsWith("s3:") ? event : `s3:${event}`).sort(),
    ...(filterRules?.length ? { Filter: { Key: { FilterRules: filterRules } } } : {}),
    ...(kind === "LambdaFunctionConfigurations" ? { LambdaFunctionArn: String(value.LambdaFunctionArn) } : { QueueArn: String(value.QueueArn) }),
  };
}

function canonicalModel(properties: Record<string, unknown>): S3BucketNotificationsModel {
  const configuration = properties.NotificationConfiguration as Record<string, unknown>;
  const lambda = (configuration.LambdaFunctionConfigurations as Array<Record<string, unknown>> | undefined)?.map(item => canonicalDestination(item, "LambdaFunctionConfigurations"));
  const queue = (configuration.QueueConfigurations as Array<Record<string, unknown>> | undefined)?.map(item => canonicalDestination(item, "QueueConfigurations"));
  return stable({
    ServiceToken: String(properties.ServiceToken),
    BucketName: String(properties.BucketName),
    NotificationConfiguration: {
      ...(lambda ? { LambdaFunctionConfigurations: lambda } : {}),
      ...(queue ? { QueueConfigurations: queue } : {}),
      ...(configuration.EventBridgeConfiguration !== undefined ? { EventBridgeConfiguration: {} } : {}),
    },
    Managed: helperBoolean(properties.Managed, true)!,
    SkipDestinationValidation: helperBoolean(properties.SkipDestinationValidation, false)!,
  });
}

/** The helper names each configuration it creates after the stack, so a later delete can tell them from external ones. */
function configurationId(context: ProviderContext, destination: S3NotificationDestinationModel): string {
  return `${context.stackId}-${createHash("sha256").update(JSON.stringify(stable(destination))).digest("hex").slice(0, 16)}`;
}

function toState(context: ProviderContext, destination: S3NotificationDestinationModel): NotificationEntry {
  const prefix = destination.Filter?.Key.FilterRules.find(rule => rule.Name === "prefix")?.Value;
  const suffix = destination.Filter?.Key.FilterRules.find(rule => rule.Name === "suffix")?.Value;
  return { id: configurationId(context, destination), arn: destination.LambdaFunctionArn ?? destination.QueueArn!, events: [...destination.Events], ...(prefix !== undefined ? { prefix } : {}), ...(suffix !== undefined ? { suffix } : {}) };
}

function fromState(entry: NotificationEntry, kind: typeof CONFIGURATION_TYPES[number]): S3NotificationDestinationModel {
  const rules: S3NotificationFilterRuleModel[] = [...(entry.prefix !== undefined ? [{ Name: "prefix" as const, Value: entry.prefix }] : []), ...(entry.suffix !== undefined ? [{ Name: "suffix" as const, Value: entry.suffix }] : [])];
  return { Events: [...entry.events].sort(), ...(rules.length ? { Filter: { Key: { FilterRules: rules } } } : {}), ...(kind === "LambdaFunctionConfigurations" ? { LambdaFunctionArn: entry.arn } : { QueueArn: entry.arn }) };
}

function stackOwned(context: ProviderContext, entry: NotificationEntry): boolean { return entry.id.startsWith(`${context.stackId}-`); }

/**
 * The configuration to store: the desired destinations plus, for an unmanaged
 * bucket, every existing destination this stack did not create. `previous`
 * identifies the ones it did create on an update.
 */
function mergedConfiguration(context: ProviderContext, existing: NotificationState | undefined, desired: S3BucketNotificationsModel | undefined, previous: S3BucketNotificationsModel | undefined, managed: boolean): NotificationState {
  const incomingLambda = (desired?.NotificationConfiguration.LambdaFunctionConfigurations ?? []).map(item => toState(context, item));
  const incomingQueue = (desired?.NotificationConfiguration.QueueConfigurations ?? []).map(item => toState(context, item));
  if (managed) return { lambda: incomingLambda, queue: incomingQueue, eventBridge: desired?.NotificationConfiguration.EventBridgeConfiguration !== undefined };
  const previousIds = new Set([...(previous?.NotificationConfiguration.LambdaFunctionConfigurations ?? []), ...(previous?.NotificationConfiguration.QueueConfigurations ?? [])].map(item => configurationId(context, item)));
  const external = (entries: NotificationEntry[]) => entries.filter(entry => !previousIds.has(entry.id) && !stackOwned(context, entry));
  const eventBridge = desired?.NotificationConfiguration.EventBridgeConfiguration !== undefined || (existing?.eventBridge === true && previous?.NotificationConfiguration.EventBridgeConfiguration === undefined);
  return { lambda: [...external(existing?.lambda ?? []), ...incomingLambda], queue: [...external(existing?.queue ?? []), ...incomingQueue], eventBridge };
}

function readModel(context: ProviderContext, physicalId: string, bucketName: string, state: NotificationState | undefined, previous?: S3BucketNotificationsModel): ProviderReadModel<S3BucketNotificationsModel> {
  const owned = (entries: NotificationEntry[]) => entries.filter(entry => stackOwned(context, entry));
  const lambda = owned(state?.lambda ?? []).map(entry => fromState(entry, "LambdaFunctionConfigurations"));
  const queue = owned(state?.queue ?? []).map(entry => fromState(entry, "QueueConfigurations"));
  const model = stable({
    ServiceToken: previous?.ServiceToken ?? "",
    BucketName: bucketName,
    NotificationConfiguration: { ...(lambda.length || previous?.NotificationConfiguration.LambdaFunctionConfigurations ? { LambdaFunctionConfigurations: lambda } : {}), ...(queue.length || previous?.NotificationConfiguration.QueueConfigurations ? { QueueConfigurations: queue } : {}), ...(state?.eventBridge ? { EventBridgeConfiguration: {} } : {}) },
    Managed: previous?.Managed ?? true,
    SkipDestinationValidation: previous?.SkipDestinationValidation ?? false,
  });
  return { physicalId, properties: model, attributes: {} };
}

function failed(error: unknown): { status: "FAILED"; errorCode: string; message: string; retryable: boolean } {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}

export function createS3BucketNotificationsProvider(s3: S3Service, store: StateStore): ProductionResourceProvider<S3BucketNotificationsModel> {
  const physicalIdFor = (context: ProviderContext) => context.logicalId;
  const apply = async (desired: S3BucketNotificationsModel, previous: S3BucketNotificationsModel | undefined, context: ProviderContext): Promise<ProviderSuccess<S3BucketNotificationsModel> | ReturnType<typeof failed>> => {
    const bucket = await s3.readBucketInternal(desired.BucketName);
    if (!bucket) return { status: "FAILED", errorCode: "NoSuchBucket", message: `Bucket ${desired.BucketName} does not exist`, retryable: false };
    const merged = mergedConfiguration(context, bucket.notificationConfiguration, desired, previous, desired.Managed);
    const stored = await s3.putBucketNotificationInternal(desired.BucketName, merged);
    const physicalId = physicalIdFor(context);
    return { status: "SUCCESS", physicalId, model: readModel(context, physicalId, desired.BucketName, stored.notificationConfiguration, desired) };
  };

  return {
    typeName: S3_BUCKET_NOTIFICATIONS_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: S3_BUCKET_NOTIFICATIONS_SCHEMA,

    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] {
      return validateProperties(properties, context);
    },

    canonicalize(properties: unknown, context: ProviderContext): S3BucketNotificationsModel {
      if (!isRecord(properties)) throw new TypeError(`${S3_BUCKET_NOTIFICATIONS_TYPE} Properties must be an object`);
      const issues = validateProperties(properties, context);
      if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return canonicalModel(properties);
    },

    plan(previous: S3BucketNotificationsModel | undefined, desired: S3BucketNotificationsModel): ProviderPlan<S3BucketNotificationsModel> {
      const fields = ["ServiceToken", "BucketName", "NotificationConfiguration", "Managed", "SkipDestinationValidation"] as const;
      if (!previous) return { action: "CREATE", desired, changedProperties: [...fields], replacementProperties: [] };
      const changed = fields.filter(field => !same(previous[field], desired[field]));
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      if (changed.includes("BucketName")) return { action: "REPLACE", desired, changedProperties: changed, replacementProperties: ["BucketName"], replacementOrder: "CREATE_BEFORE_DELETE" };
      return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
    },

    async create(desired: S3BucketNotificationsModel, context: ProviderContext) {
      try { return await apply(desired, undefined, context); } catch (error) { return failed(error); }
    },

    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<S3BucketNotificationsModel>> {
      try {
        // The helper's physical ID is its logical ID; the bucket comes from the stack's retained resource properties.
        if (physicalId !== physicalIdFor(context)) return { status: "NOT_FOUND", physicalId };
        const resource = store.regionState(context.region).cloudformation.stacks[context.stackId]?.resources[context.logicalId];
        if (!resource || resource.resourceType !== S3_BUCKET_NOTIFICATIONS_TYPE) return { status: "NOT_FOUND", physicalId };
        const model = this.canonicalize(resource.properties, context);
        const bucket = await s3.readBucketInternal(model.BucketName);
        if (!bucket) return { status: "NOT_FOUND", physicalId };
        return { status: "SUCCESS", physicalId, model: readModel(context, physicalId, model.BucketName, bucket.notificationConfiguration, model) };
      } catch (error) { return failed(error); }
    },

    async update(physicalId: string, previous: S3BucketNotificationsModel, desired: S3BucketNotificationsModel, context: ProviderContext): Promise<ProviderUpdateResult<S3BucketNotificationsModel>> {
      if (previous.BucketName !== desired.BucketName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "BucketName changes require replacement" };
      try { const result = await apply(desired, previous, context); return result.status === "SUCCESS" ? { ...result, physicalId } : result; } catch (error) { return failed(error); }
    },

    async delete(physicalId: string, previous: S3BucketNotificationsModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const bucket = await s3.readBucketInternal(previous.BucketName);
        if (!bucket) return { status: "NOT_FOUND", physicalId };
        await s3.putBucketNotificationInternal(previous.BucketName, mergedConfiguration(context, bucket.notificationConfiguration, undefined, previous, previous.Managed));
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        if (error instanceof AwsError && error.code === "NoSuchBucket") return { status: "NOT_FOUND", physicalId };
        return failed(error);
      }
    },

    ref(model: ProviderReadModel<S3BucketNotificationsModel>): unknown {
      return model.physicalId;
    },

    getAtt(_model: ProviderReadModel<S3BucketNotificationsModel>, attribute: string): never {
      throw new ProviderReferenceError(S3_BUCKET_NOTIFICATIONS_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}
