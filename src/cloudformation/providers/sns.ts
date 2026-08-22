import { providerValidationPathSegments } from "./contract.js";
import { createHash } from "node:crypto";
import type { SnsService } from "../../sns.js";
import { AwsError } from "../../errors.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderOperation,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderSuccess,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";

export const SNS_TOPIC_TYPE = "AWS::SNS::Topic";
export const SNS_SUBSCRIPTION_TYPE = "AWS::SNS::Subscription";
export const SNS_TOPIC_POLICY_TYPE = "AWS::SNS::TopicPolicy";
export const SNS_TOPIC_INLINE_POLICY_TYPE = "AWS::SNS::TopicInlinePolicy";
export const SNS_CLOUDFORMATION_RESOURCE_TYPES = Object.freeze([
  SNS_SUBSCRIPTION_TYPE,
  SNS_TOPIC_TYPE,
  SNS_TOPIC_INLINE_POLICY_TYPE,
  SNS_TOPIC_POLICY_TYPE,
] as const);

type SnsResourceType = typeof SNS_CLOUDFORMATION_RESOURCE_TYPES[number];
export const SNS_CLOUDFORMATION_AUTHORIZATION_MATRIX: Readonly<Record<SnsResourceType, Readonly<Record<ProviderOperation, readonly string[]>>>> = Object.freeze({
  [SNS_TOPIC_TYPE]: Object.freeze({
    CREATE: Object.freeze(["sns:CreateTopic", "sns:GetTopicAttributes", "sns:ListTagsForResource", "sns:TagResource", "sns:Subscribe", "sns:GetSubscriptionAttributes"]),
    READ: Object.freeze(["sns:GetTopicAttributes", "sns:ListTagsForResource", "sns:GetSubscriptionAttributes"]),
    UPDATE: Object.freeze(["sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:ListTagsForResource", "sns:TagResource", "sns:UntagResource", "sns:Subscribe", "sns:GetSubscriptionAttributes"]),
    DELETE: Object.freeze(["sns:GetTopicAttributes", "sns:DeleteTopic", "sns:GetSubscriptionAttributes"]),
  }),
  [SNS_SUBSCRIPTION_TYPE]: Object.freeze({
    CREATE: Object.freeze(["sns:Subscribe", "sns:GetSubscriptionAttributes"]),
    READ: Object.freeze(["sns:GetSubscriptionAttributes"]),
    UPDATE: Object.freeze(["sns:GetSubscriptionAttributes", "sns:SetSubscriptionAttributes"]),
    DELETE: Object.freeze(["sns:GetSubscriptionAttributes", "sns:Unsubscribe"]),
  }),
  [SNS_TOPIC_POLICY_TYPE]: Object.freeze({
    CREATE: Object.freeze(["sns:GetTopicAttributes", "sns:SetTopicAttributes"]),
    READ: Object.freeze(["sns:GetTopicAttributes"]),
    UPDATE: Object.freeze(["sns:GetTopicAttributes", "sns:SetTopicAttributes"]),
    DELETE: Object.freeze(["sns:GetTopicAttributes", "sns:SetTopicAttributes"]),
  }),
  [SNS_TOPIC_INLINE_POLICY_TYPE]: Object.freeze({
    CREATE: Object.freeze(["sns:GetTopicAttributes", "sns:SetTopicAttributes"]),
    READ: Object.freeze(["sns:GetTopicAttributes"]),
    UPDATE: Object.freeze(["sns:GetTopicAttributes", "sns:SetTopicAttributes"]),
    DELETE: Object.freeze(["sns:GetTopicAttributes", "sns:SetTopicAttributes"]),
  }),
});

const RETENTION = Object.freeze({
  deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  snapshotSupported: false,
});
const NO_TAGS = Object.freeze({ behavior: "NONE" as const, propagatesCloudFormationTags: false });
const STACK_TAGS = Object.freeze({ behavior: "STACK_AND_RESOURCE" as const, propertyName: "Tags", propagatesCloudFormationTags: true });

export const SNS_TOPIC_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SNS_TOPIC_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ArchivePolicy: Object.freeze({ valueType: "object", updateBehavior: "NOT_SUPPORTED" }),
    ContentBasedDeduplication: Object.freeze({ valueType: "boolean", updateBehavior: "NOT_SUPPORTED" }),
    DataProtectionPolicy: Object.freeze({ valueType: "object", updateBehavior: "NOT_SUPPORTED" }),
    DeliveryStatusLogging: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    DisplayName: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    FifoThroughputScope: Object.freeze({ valueType: "string", updateBehavior: "NOT_SUPPORTED" }),
    FifoTopic: Object.freeze({ valueType: "boolean", updateBehavior: "NOT_SUPPORTED" }),
    KmsMasterKeyId: Object.freeze({ valueType: "string", updateBehavior: "NOT_SUPPORTED" }),
    SignatureVersion: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Subscription: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    TopicName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    TracingConfig: Object.freeze({ valueType: "string", updateBehavior: "NOT_SUPPORTED" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Topic ARN" }),
  attributes: Object.freeze({
    Arn: Object.freeze({ valueType: "string" }),
    TopicName: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: STACK_TAGS,
});

export const SNS_SUBSCRIPTION_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SNS_SUBSCRIPTION_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    DeliveryPolicy: Object.freeze({ valueType: "object", updateBehavior: "NOT_SUPPORTED" }),
    Endpoint: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    FilterPolicy: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    FilterPolicyScope: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Protocol: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    RawMessageDelivery: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
    RedrivePolicy: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    Region: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    ReplayPolicy: Object.freeze({ valueType: "object", updateBehavior: "NOT_SUPPORTED" }),
    SubscriptionRoleArn: Object.freeze({ valueType: "string", updateBehavior: "NOT_SUPPORTED" }),
    TopicArn: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Subscription ARN" }),
  attributes: Object.freeze({ Arn: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: NO_TAGS,
});

export const SNS_TOPIC_POLICY_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SNS_TOPIC_POLICY_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    PolicyDocument: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    Topics: Object.freeze({ valueType: "array", required: true, updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Topic-policy resource ID" }),
  attributes: Object.freeze({ Id: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: NO_TAGS,
});

export const SNS_TOPIC_INLINE_POLICY_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SNS_TOPIC_INLINE_POLICY_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    PolicyDocument: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    TopicArn: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Topic ARN" }),
  attributes: Object.freeze({ Arn: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: NO_TAGS,
});

interface Tag { readonly Key: string; readonly Value: string }
interface InlineSubscription { readonly Endpoint: string; readonly Protocol: "sqs" | "lambda" }
interface LoggingConfiguration {
  readonly Protocol: "sqs" | "lambda";
  readonly FailureFeedbackRoleArn?: string;
  readonly SuccessFeedbackRoleArn?: string;
  readonly SuccessFeedbackSampleRate?: string;
}
export interface SnsTopicModel {
  readonly TopicName: string;
  readonly DisplayName?: string;
  readonly SignatureVersion?: "1" | "2";
  readonly DeliveryStatusLogging?: readonly LoggingConfiguration[];
  readonly Subscription?: readonly InlineSubscription[];
  readonly Tags?: readonly Tag[];
}
export interface SnsSubscriptionModel {
  readonly Endpoint: string;
  readonly Protocol: "sqs" | "lambda";
  readonly TopicArn: string;
  readonly FilterPolicy?: Readonly<Record<string, unknown>>;
  readonly FilterPolicyScope?: "MessageAttributes" | "MessageBody";
  readonly RawMessageDelivery?: boolean;
  readonly RedrivePolicy?: Readonly<Record<string, unknown>>;
  readonly Region?: string;
}
export interface SnsTopicPolicyModel {
  readonly PolicyDocument: Readonly<Record<string, unknown>>;
  readonly Topics: readonly string[];
}
export interface SnsTopicInlinePolicyModel {
  readonly PolicyDocument: Readonly<Record<string, unknown>>;
  readonly TopicArn: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function owner(context: ProviderContext): string { return `${context.stackId}:${context.logicalId}`; }
function generatedTopicName(context: ProviderContext): string {
  const stack = context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack";
  const suffix = createHash("sha256").update(owner(context)).digest("hex").slice(0, 12);
  return `${stack}-${context.logicalId}-${suffix}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 256);
}
function topicArn(name: string, context: ProviderContext): string {
  return `arn:${context.partition}:sns:${context.region}:${context.accountId}:${name}`;
}
function failure(error: unknown): ProviderUpdateResult<any> {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}
function missing(error: unknown): boolean {
  return error instanceof AwsError && error.code === "NotFound";
}
function issue(issues: ProviderValidationIssue[], path: string, message: string, code: ProviderValidationIssue["code"] = "InvalidProperty"): void {
  issues.push({ code, path, pathSegments: providerValidationPathSegments(path), message });
}
function exact(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: ProviderValidationIssue[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issue(issues, `${path}.${key}`, `${path} does not support property ${key}`, "UnsupportedProperty");
}
function unsupported(properties: Record<string, unknown>, names: readonly string[], issues: ProviderValidationIssue[]): void {
  for (const name of names) if (properties[name] !== undefined) issue(issues, `Properties.${name}`, `${name} requires a later SNS phase and is not accepted`);
}
function tags(value: unknown, issues?: ProviderValidationIssue[]): readonly Tag[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const output: Tag[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (!record(item)) return issue(issues ?? [], `Properties.Tags[${index}]`, "Each tag must be an object");
    exact(item, ["Key", "Value"], `Properties.Tags[${index}]`, issues ?? []);
    if (typeof item.Key !== "string" || typeof item.Value !== "string" || !item.Key || item.Key.toLowerCase().startsWith("aws:") || seen.has(item.Key)) {
      return issue(issues ?? [], `Properties.Tags[${index}]`, "Tags require unique non-reserved string Key and Value fields");
    }
    seen.add(item.Key);
    output.push({ Key: item.Key, Value: item.Value });
  });
  if (output.length > 50) issue(issues ?? [], "Properties.Tags", "At most 50 tags are supported");
  return Object.freeze(output.sort((left, right) => left.Key.localeCompare(right.Key)));
}
function subscriptionAttributes(model: SnsSubscriptionModel): Record<string, string> {
  return {
    ...(model.FilterPolicy ? { FilterPolicy: JSON.stringify(model.FilterPolicy) } : {}),
    ...(model.FilterPolicyScope ? { FilterPolicyScope: model.FilterPolicyScope } : {}),
    ...(model.RawMessageDelivery !== undefined ? { RawMessageDelivery: String(model.RawMessageDelivery) } : {}),
    ...(model.RedrivePolicy ? { RedrivePolicy: JSON.stringify(model.RedrivePolicy) } : {}),
  };
}
function topicSuccess(model: SnsTopicModel, arn: string): ProviderSuccess<SnsTopicModel> {
  return { status: "SUCCESS", physicalId: arn, model: { physicalId: arn, properties: model, attributes: { Arn: arn, TopicName: model.TopicName } } };
}
function subscriptionSuccess(model: SnsSubscriptionModel, arn: string): ProviderSuccess<SnsSubscriptionModel> {
  return { status: "SUCCESS", physicalId: arn, model: { physicalId: arn, properties: model, attributes: { Arn: arn } } };
}
function plan<Model extends object>(previous: Model | undefined, desired: Model, replacement: readonly (keyof Model)[]): ProviderPlan<Model> {
  if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
  const keys = [...new Set([...Object.keys(previous), ...Object.keys(desired)])] as Array<keyof Model>;
  const changed = keys.filter(key => !same(previous[key], desired[key])).map(String).sort();
  if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
  const replacements = changed.filter(key => replacement.includes(key as keyof Model));
  return replacements.length
    ? { action: "REPLACE", desired, changedProperties: changed, replacementProperties: replacements, replacementOrder: "CREATE_BEFORE_DELETE" }
    : { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
}

function validateTopic(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, SNS_TOPIC_SCHEMA);
  if (!record(properties)) return issues;
  unsupported(properties, ["ArchivePolicy", "ContentBasedDeduplication", "DataProtectionPolicy", "FifoThroughputScope", "FifoTopic", "KmsMasterKeyId", "TracingConfig"], issues);
  if (properties.TopicName !== undefined && (typeof properties.TopicName !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(properties.TopicName))) issue(issues, "Properties.TopicName", "TopicName must identify a Standard topic");
  if (properties.SignatureVersion !== undefined && properties.SignatureVersion !== "1" && properties.SignatureVersion !== "2") issue(issues, "Properties.SignatureVersion", "SignatureVersion must be 1 or 2");
  tags(properties.Tags, issues);
  if (Array.isArray(properties.Subscription)) properties.Subscription.forEach((item, index) => {
    if (!record(item)) return issue(issues, `Properties.Subscription[${index}]`, "Subscription entries must be objects");
    exact(item, ["Endpoint", "Protocol"], `Properties.Subscription[${index}]`, issues);
    if (typeof item.Endpoint !== "string" || !["sqs", "lambda"].includes(String(item.Protocol))) issue(issues, `Properties.Subscription[${index}]`, "Inline subscriptions require Endpoint and an active sqs or lambda Protocol");
  });
  if (Array.isArray(properties.DeliveryStatusLogging)) properties.DeliveryStatusLogging.forEach((item, index) => {
    if (!record(item)) return issue(issues, `Properties.DeliveryStatusLogging[${index}]`, "Delivery logging entries must be objects");
    exact(item, ["Protocol", "FailureFeedbackRoleArn", "SuccessFeedbackRoleArn", "SuccessFeedbackSampleRate"], `Properties.DeliveryStatusLogging[${index}]`, issues);
    if (!["sqs", "lambda"].includes(String(item.Protocol))) issue(issues, `Properties.DeliveryStatusLogging[${index}].Protocol`, "Only sqs and lambda logging protocols are active");
  });
  return issues;
}

function canonicalTopic(properties: Record<string, unknown>, context: ProviderContext): SnsTopicModel {
  const model: SnsTopicModel = {
    TopicName: String(properties.TopicName ?? generatedTopicName(context)),
    ...(properties.DisplayName !== undefined ? { DisplayName: String(properties.DisplayName) } : {}),
    ...(properties.SignatureVersion !== undefined ? { SignatureVersion: properties.SignatureVersion as "1" | "2" } : {}),
    ...(properties.Tags !== undefined ? { Tags: tags(properties.Tags)! } : {}),
    ...(properties.Subscription !== undefined ? { Subscription: Object.freeze((properties.Subscription as any[]).map(item => ({ Endpoint: String(item.Endpoint), Protocol: item.Protocol })).sort((a, b) => `${a.Protocol}:${a.Endpoint}`.localeCompare(`${b.Protocol}:${b.Endpoint}`))) } : {}),
    ...(properties.DeliveryStatusLogging !== undefined ? { DeliveryStatusLogging: Object.freeze((properties.DeliveryStatusLogging as any[]).map(item => canonical(item)).sort((a, b) => a.Protocol.localeCompare(b.Protocol))) } : {}),
  };
  return Object.freeze(model);
}

function topicAttributes(model: SnsTopicModel): Record<string, string> {
  const attributes: Record<string, string> = {
    ...(model.DisplayName !== undefined ? { DisplayName: model.DisplayName } : {}),
    ...(model.SignatureVersion !== undefined ? { SignatureVersion: model.SignatureVersion } : {}),
  };
  for (const logging of model.DeliveryStatusLogging ?? []) {
    const prefix = logging.Protocol === "sqs" ? "SQS" : "Lambda";
    if (logging.SuccessFeedbackRoleArn !== undefined) attributes[`${prefix}SuccessFeedbackRoleArn`] = logging.SuccessFeedbackRoleArn;
    if (logging.SuccessFeedbackSampleRate !== undefined) attributes[`${prefix}SuccessFeedbackSampleRate`] = String(logging.SuccessFeedbackSampleRate);
    if (logging.FailureFeedbackRoleArn !== undefined) attributes[`${prefix}FailureFeedbackRoleArn`] = logging.FailureFeedbackRoleArn;
  }
  return attributes;
}

function createTopicProvider(sns: SnsService): ProductionResourceProvider<SnsTopicModel> {
  const readModel = async (arn: string, context: ProviderContext): Promise<SnsTopicModel | undefined> => {
    if (sns.cloudFormationTopicOwner(arn) !== owner(context)) return undefined;
    let attributes: Record<string, string>;
    try { attributes = (await sns.GetTopicAttributes({ TopicArn: arn })).Attributes; }
    catch (error) { if (missing(error)) return undefined; throw error; }
    const currentTags = (await sns.ListTagsForResource({ ResourceArn: arn })).Tags;
    const inline = sns.cloudFormationSubscriptions(owner(context)).filter(item => item.cloudFormationInline && item.topicArn === arn);
    const logging: LoggingConfiguration[] = [];
    for (const [protocol, prefix] of [["sqs", "SQS"], ["lambda", "Lambda"]] as const) {
      if (attributes[`${prefix}SuccessFeedbackRoleArn`] || attributes[`${prefix}FailureFeedbackRoleArn`]) logging.push({
        Protocol: protocol,
        ...(attributes[`${prefix}SuccessFeedbackRoleArn`] ? { SuccessFeedbackRoleArn: attributes[`${prefix}SuccessFeedbackRoleArn`] } : {}),
        ...(attributes[`${prefix}SuccessFeedbackSampleRate`] ? { SuccessFeedbackSampleRate: attributes[`${prefix}SuccessFeedbackSampleRate`] } : {}),
        ...(attributes[`${prefix}FailureFeedbackRoleArn`] ? { FailureFeedbackRoleArn: attributes[`${prefix}FailureFeedbackRoleArn`] } : {}),
      });
    }
    return Object.freeze({
      TopicName: arn.slice(arn.lastIndexOf(":") + 1),
      ...(attributes.DisplayName ? { DisplayName: attributes.DisplayName } : {}),
      ...(attributes.SignatureVersion !== "1" ? { SignatureVersion: attributes.SignatureVersion as "2" } : {}),
      ...(logging.length ? { DeliveryStatusLogging: Object.freeze(logging) } : {}),
      ...(inline.length ? { Subscription: Object.freeze(inline.map(item => ({ Endpoint: item.endpoint, Protocol: item.protocol })).sort((a, b) => `${a.Protocol}:${a.Endpoint}`.localeCompare(`${b.Protocol}:${b.Endpoint}`))) } : {}),
      Tags: Object.freeze(currentTags.map(tag => ({ Key: tag.Key, Value: tag.Value }))),
    });
  };
  const reconcile = async (arn: string, desired: SnsTopicModel, context: ProviderContext): Promise<ProviderUpdateResult<SnsTopicModel>> => {
    if (sns.cloudFormationTopicOwner(arn) !== owner(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Topic ${arn} is not owned by this stack resource` };
    const currentAttributes = (await sns.GetTopicAttributes({ TopicArn: arn })).Attributes;
    const wantedAttributes = topicAttributes(desired);
    const mutableNames = ["DisplayName", "SignatureVersion", "SQSSuccessFeedbackRoleArn", "SQSSuccessFeedbackSampleRate", "SQSFailureFeedbackRoleArn", "LambdaSuccessFeedbackRoleArn", "LambdaSuccessFeedbackSampleRate", "LambdaFailureFeedbackRoleArn"];
    for (const name of mutableNames) {
      const wanted = wantedAttributes[name] ?? (name.endsWith("SampleRate") ? "0" : name === "SignatureVersion" ? "1" : "");
      if ((currentAttributes[name] ?? "") !== wanted) await sns.SetTopicAttributes({ TopicArn: arn, AttributeName: name, AttributeValue: wanted });
    }
    const currentTags = Object.fromEntries((await sns.ListTagsForResource({ ResourceArn: arn })).Tags.map(tag => [tag.Key, tag.Value]));
    const wantedTags = Object.fromEntries((desired.Tags ?? []).map(tag => [tag.Key, tag.Value]));
    const remove = Object.keys(currentTags).filter(key => !Object.hasOwn(wantedTags, key));
    if (remove.length) await sns.UntagResource({ ResourceArn: arn, TagKeys: remove });
    const add = Object.entries(wantedTags).filter(([key, value]) => currentTags[key] !== value).map(([Key, Value]) => ({ Key, Value }));
    if (add.length) await sns.TagResource({ ResourceArn: arn, Tags: add });
    const currentInline = sns.cloudFormationSubscriptions(owner(context)).filter(item => item.cloudFormationInline && item.topicArn === arn);
    for (const wanted of desired.Subscription ?? []) {
      let subscription = currentInline.find(item => item.protocol === wanted.Protocol && item.endpoint === wanted.Endpoint);
      if (!subscription) {
        const created = await sns.Subscribe({ TopicArn: arn, Protocol: wanted.Protocol, Endpoint: wanted.Endpoint });
        await sns.claimCloudFormationSubscription(created.SubscriptionArn, owner(context), true);
        subscription = sns.cloudFormationSubscriptions(owner(context)).find(item => item.arn === created.SubscriptionArn);
      }
    }
    const wantedInline = new Set((desired.Subscription ?? []).map(item => `${item.Protocol}:${item.Endpoint}`));
    for (const existing of currentInline) if (!wantedInline.has(`${existing.protocol}:${existing.endpoint}`)) await sns.releaseCloudFormationSubscription(existing.arn, owner(context));
    const current = await readModel(arn, context);
    return current ? topicSuccess(current, arn) : { status: "FAILED", errorCode: "NotFound", message: `Topic ${arn} no longer exists` };
  };
  return {
    typeName: SNS_TOPIC_TYPE, providerVersion: 1, visibility: "production", schema: SNS_TOPIC_SCHEMA,
    validate(properties: unknown): readonly ProviderValidationIssue[] { return validateTopic(properties); },
    canonicalize(properties: unknown, context: ProviderContext): SnsTopicModel {
      if (!record(properties)) throw new TypeError(`${SNS_TOPIC_TYPE} Properties must be an object`);
      const issues = validateTopic(properties); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return canonicalTopic(properties, context);
    },
    plan(previous, desired) { return plan(previous, desired, ["TopicName"]); },
    async create(desired, context) {
      try {
        const arn = topicArn(desired.TopicName, context);
        const existingOwner = sns.cloudFormationTopicOwner(arn);
        if (existingOwner && existingOwner !== owner(context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Topic ${arn} is owned by another resource` };
        const created = await sns.CreateTopic({ Name: desired.TopicName, Attributes: topicAttributes(desired), Tags: desired.Tags ?? [] });
        await sns.claimCloudFormationTopic(created.TopicArn, owner(context));
        return await reconcile(created.TopicArn, desired, context);
      } catch (error) { return failure(error); }
    },
    async read(physicalId, context): Promise<ProviderReadResult<SnsTopicModel>> {
      try { const current = await readModel(physicalId, context); return current ? topicSuccess(current, physicalId) : { status: "NOT_FOUND", physicalId }; }
      catch (error) { return failure(error) as ProviderReadResult<SnsTopicModel>; }
    },
    async update(physicalId, _previous, desired, context) {
      if (physicalId !== topicArn(desired.TopicName, context)) return { status: "FAILED", errorCode: "RequiresReplacement", message: "TopicName changes require replacement" };
      try { return await reconcile(physicalId, desired, context); } catch (error) { return failure(error); }
    },
    async retain(physicalId, _previous, context): Promise<void> {
      await sns.releaseCloudFormationRetainedTopic(physicalId, owner(context));
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        if (!sns.cloudFormationTopicOwner(physicalId)) return { status: "NOT_FOUND", physicalId };
        await sns.deleteCloudFormationTopic(physicalId, owner(context));
        return { status: "SUCCESS", physicalId };
      } catch (error) { return failure(error) as ProviderDeleteResult; }
    },
    ref(current) { return current.physicalId; },
    getAtt(current, attribute) {
      if (attribute === "Arn") return current.physicalId;
      if (attribute === "TopicName") return current.properties.TopicName;
      throw new ProviderReferenceError(SNS_TOPIC_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}

function validateSubscription(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, SNS_SUBSCRIPTION_SCHEMA);
  if (!record(properties)) return issues;
  unsupported(properties, ["DeliveryPolicy", "ReplayPolicy", "SubscriptionRoleArn"], issues);
  if (properties.Protocol !== undefined && !["sqs", "lambda"].includes(String(properties.Protocol))) issue(issues, "Properties.Protocol", "Only sqs and lambda protocols are active in SNS-03");
  if (properties.FilterPolicyScope !== undefined && !["MessageAttributes", "MessageBody"].includes(String(properties.FilterPolicyScope))) issue(issues, "Properties.FilterPolicyScope", "FilterPolicyScope must be MessageAttributes or MessageBody");
  if (properties.Region !== undefined && properties.Region !== context.region) issue(issues, "Properties.Region", "Cross-Region subscriptions are not available");
  return issues;
}
function canonicalSubscription(properties: Record<string, unknown>): SnsSubscriptionModel {
  return Object.freeze({
    Endpoint: String(properties.Endpoint),
    Protocol: properties.Protocol as "sqs" | "lambda",
    TopicArn: String(properties.TopicArn),
    ...(properties.FilterPolicy !== undefined ? { FilterPolicy: Object.freeze(canonical(properties.FilterPolicy)) } : {}),
    ...(properties.FilterPolicyScope !== undefined ? { FilterPolicyScope: properties.FilterPolicyScope as "MessageAttributes" | "MessageBody" } : {}),
    ...(properties.RawMessageDelivery !== undefined ? { RawMessageDelivery: Boolean(properties.RawMessageDelivery) } : {}),
    ...(properties.RedrivePolicy !== undefined ? { RedrivePolicy: Object.freeze(canonical(properties.RedrivePolicy)) } : {}),
    ...(properties.Region !== undefined ? { Region: String(properties.Region) } : {}),
  });
}
function createSubscriptionProvider(sns: SnsService): ProductionResourceProvider<SnsSubscriptionModel> {
  const describe = async (arn: string, context: ProviderContext): Promise<SnsSubscriptionModel | undefined> => {
    if (sns.cloudFormationSubscriptionOwner(arn) !== owner(context)) return undefined;
    try {
      const attributes = (await sns.GetSubscriptionAttributes({ SubscriptionArn: arn })).Attributes;
      return Object.freeze({
        Endpoint: attributes.Endpoint,
        Protocol: attributes.Protocol as "sqs" | "lambda",
        TopicArn: attributes.TopicArn,
        ...(attributes.FilterPolicy ? { FilterPolicy: Object.freeze(canonical(JSON.parse(attributes.FilterPolicy))) } : {}),
        ...(attributes.FilterPolicyScope !== "MessageAttributes" ? { FilterPolicyScope: attributes.FilterPolicyScope as "MessageBody" } : {}),
        ...(attributes.RawMessageDelivery === "true" ? { RawMessageDelivery: true } : {}),
        ...(attributes.RedrivePolicy ? { RedrivePolicy: Object.freeze(canonical(JSON.parse(attributes.RedrivePolicy))) } : {}),
      });
    } catch (error) { if (missing(error)) return undefined; throw error; }
  };
  const reconcile = async (arn: string, desired: SnsSubscriptionModel, context: ProviderContext): Promise<ProviderUpdateResult<SnsSubscriptionModel>> => {
    if (sns.cloudFormationSubscriptionOwner(arn) !== owner(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Subscription ${arn} is not owned by this stack resource` };
    const current = (await sns.GetSubscriptionAttributes({ SubscriptionArn: arn })).Attributes;
    const wanted = subscriptionAttributes(desired);
    for (const name of ["FilterPolicyScope", "FilterPolicy", "RawMessageDelivery", "RedrivePolicy"]) {
      const value = wanted[name] ?? (name === "FilterPolicyScope" ? "MessageAttributes" : name === "RawMessageDelivery" ? "false" : "");
      if ((current[name] ?? (name === "FilterPolicyScope" ? "MessageAttributes" : "")) !== value) await sns.SetSubscriptionAttributes({ SubscriptionArn: arn, AttributeName: name, AttributeValue: value });
    }
    const model = await describe(arn, context);
    return model ? subscriptionSuccess(model, arn) : { status: "FAILED", errorCode: "NotFound", message: `Subscription ${arn} no longer exists` };
  };
  return {
    typeName: SNS_SUBSCRIPTION_TYPE, providerVersion: 1, visibility: "production", schema: SNS_SUBSCRIPTION_SCHEMA,
    validate(properties, context) { return validateSubscription(properties, context); },
    canonicalize(properties, context) {
      if (!record(properties)) throw new TypeError(`${SNS_SUBSCRIPTION_TYPE} Properties must be an object`);
      const issues = validateSubscription(properties, context); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return canonicalSubscription(properties);
    },
    plan(previous, desired) { return plan(previous, desired, ["Endpoint", "Protocol", "TopicArn", "Region"]); },
    async create(desired, context) {
      try {
        const created = await sns.Subscribe({ TopicArn: desired.TopicArn, Protocol: desired.Protocol, Endpoint: desired.Endpoint, Attributes: subscriptionAttributes(desired) });
        const existingOwner = sns.cloudFormationSubscriptionOwner(created.SubscriptionArn);
        if (existingOwner && existingOwner !== owner(context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Subscription ${created.SubscriptionArn} is owned by another resource` };
        await sns.claimCloudFormationSubscription(created.SubscriptionArn, owner(context));
        return await reconcile(created.SubscriptionArn, desired, context);
      } catch (error) { return failure(error); }
    },
    async read(physicalId, context) {
      try { const current = await describe(physicalId, context); return current ? subscriptionSuccess(current, physicalId) : { status: "NOT_FOUND", physicalId }; }
      catch (error) { return failure(error) as ProviderReadResult<SnsSubscriptionModel>; }
    },
    async update(physicalId, previous, desired, context) {
      if (["Endpoint", "Protocol", "TopicArn", "Region"].some(key => !same((previous as any)[key], (desired as any)[key]))) return { status: "FAILED", errorCode: "RequiresReplacement", message: "Endpoint, Protocol, TopicArn, and Region changes require replacement" };
      try { return await reconcile(physicalId, desired, context); } catch (error) { return failure(error); }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        if (!sns.cloudFormationSubscriptionOwner(physicalId)) return { status: "NOT_FOUND", physicalId };
        if (sns.cloudFormationSubscriptionOwner(physicalId) !== owner(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Subscription ${physicalId} is not owned by this stack resource` };
        await sns.Unsubscribe({ SubscriptionArn: physicalId });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return failure(error) as ProviderDeleteResult; }
    },
    ref(current) { return current.physicalId; },
    getAtt(current, attribute) { if (attribute === "Arn") return current.physicalId; throw new ProviderReferenceError(SNS_SUBSCRIPTION_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

function validatePolicy(properties: unknown, schema: ProviderSchema, inline: boolean): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, schema);
  if (!record(properties)) return issues;
  if (record(properties.PolicyDocument) && properties.PolicyDocument.Statement === undefined) issue(issues, "Properties.PolicyDocument.Statement", "PolicyDocument must contain Statement");
  if (!inline && Array.isArray(properties.Topics)) {
    if (!properties.Topics.length || properties.Topics.some(item => typeof item !== "string")) issue(issues, "Properties.Topics", "Topics must contain one or more topic ARN strings");
    if (new Set(properties.Topics).size !== properties.Topics.length) issue(issues, "Properties.Topics", "Topics must not contain duplicates");
  }
  return issues;
}
function policySuccess<Model>(physicalId: string, model: Model, attributes: Record<string, unknown>): ProviderSuccess<Model> {
  return { status: "SUCCESS", physicalId, model: { physicalId, properties: model, attributes } };
}
function createTopicPolicyProvider(sns: SnsService): ProductionResourceProvider<SnsTopicPolicyModel> {
  const physical = (context: ProviderContext) => `sns-topic-policy:${owner(context)}`;
  const read = async (context: ProviderContext): Promise<SnsTopicPolicyModel | undefined> => {
    const topics = sns.cloudFormationPolicyTopics(owner(context));
    if (!topics.length) return undefined;
    const policy = JSON.parse((await sns.GetTopicAttributes({ TopicArn: topics[0] })).Attributes.Policy);
    for (const arn of topics.slice(1)) if (!same(policy, JSON.parse((await sns.GetTopicAttributes({ TopicArn: arn })).Attributes.Policy))) throw new Error("Owned topic policies have drifted");
    return Object.freeze({ PolicyDocument: Object.freeze(canonical(policy)), Topics: Object.freeze(topics) });
  };
  const reconcile = async (desired: SnsTopicPolicyModel, context: ProviderContext): Promise<ProviderUpdateResult<SnsTopicPolicyModel>> => {
    const existing = new Set(sns.cloudFormationPolicyTopics(owner(context)));
    for (const arn of desired.Topics) await sns.setCloudFormationOwnedPolicy(arn, owner(context), JSON.stringify(desired.PolicyDocument));
    for (const arn of existing) if (!desired.Topics.includes(arn)) await sns.releaseCloudFormationOwnedPolicy(arn, owner(context));
    const current = await read(context);
    return current ? policySuccess(physical(context), current, { Id: physical(context) }) : { status: "FAILED", errorCode: "NotFound", message: "TopicPolicy did not attach to any topic" };
  };
  return {
    typeName: SNS_TOPIC_POLICY_TYPE, providerVersion: 1, visibility: "production", schema: SNS_TOPIC_POLICY_SCHEMA,
    validate(properties) { return validatePolicy(properties, SNS_TOPIC_POLICY_SCHEMA, false); },
    canonicalize(properties) {
      if (!record(properties)) throw new TypeError(`${SNS_TOPIC_POLICY_TYPE} Properties must be an object`);
      const issues = validatePolicy(properties, SNS_TOPIC_POLICY_SCHEMA, false); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return Object.freeze({ PolicyDocument: Object.freeze(canonical(properties.PolicyDocument)), Topics: Object.freeze((properties.Topics as string[]).slice().sort()) });
    },
    plan(previous, desired) { return plan(previous, desired, []); },
    async create(desired, context) { try { return await reconcile(desired, context); } catch (error) { return failure(error); } },
    async read(id, context) { try { if (id !== physical(context)) return { status: "NOT_FOUND", physicalId: id }; const current = await read(context); return current ? policySuccess(id, current, { Id: id }) : { status: "NOT_FOUND", physicalId: id }; } catch (error) { return failure(error) as ProviderReadResult<SnsTopicPolicyModel>; } },
    async update(id, _previous, desired, context) { if (id !== physical(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: "TopicPolicy physical ID is not owned by this resource" }; try { return await reconcile(desired, context); } catch (error) { return failure(error); } },
    async delete(id, _previous, context) { try { if (id !== physical(context)) return { status: "NOT_FOUND", physicalId: id }; const topics = sns.cloudFormationPolicyTopics(owner(context)); if (!topics.length) return { status: "NOT_FOUND", physicalId: id }; for (const arn of topics) await sns.releaseCloudFormationOwnedPolicy(arn, owner(context)); return { status: "SUCCESS", physicalId: id }; } catch (error) { return failure(error) as ProviderDeleteResult; } },
    ref(current) { return current.physicalId; },
    getAtt(current, attribute) { if (attribute === "Id") return current.physicalId; throw new ProviderReferenceError(SNS_TOPIC_POLICY_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

function createTopicInlinePolicyProvider(sns: SnsService): ProductionResourceProvider<SnsTopicInlinePolicyModel> {
  const describe = async (arn: string, context: ProviderContext): Promise<SnsTopicInlinePolicyModel | undefined> => {
    if (sns.cloudFormationPolicyOwner(arn) !== owner(context)) return undefined;
    return Object.freeze({ TopicArn: arn, PolicyDocument: Object.freeze(canonical(JSON.parse((await sns.GetTopicAttributes({ TopicArn: arn })).Attributes.Policy))) });
  };
  const reconcile = async (desired: SnsTopicInlinePolicyModel, context: ProviderContext) => {
    await sns.setCloudFormationOwnedPolicy(desired.TopicArn, owner(context), JSON.stringify(desired.PolicyDocument));
    return policySuccess(desired.TopicArn, (await describe(desired.TopicArn, context))!, { Arn: desired.TopicArn });
  };
  return {
    typeName: SNS_TOPIC_INLINE_POLICY_TYPE, providerVersion: 1, visibility: "production", schema: SNS_TOPIC_INLINE_POLICY_SCHEMA,
    validate(properties) { return validatePolicy(properties, SNS_TOPIC_INLINE_POLICY_SCHEMA, true); },
    canonicalize(properties) {
      if (!record(properties)) throw new TypeError(`${SNS_TOPIC_INLINE_POLICY_TYPE} Properties must be an object`);
      const issues = validatePolicy(properties, SNS_TOPIC_INLINE_POLICY_SCHEMA, true); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return Object.freeze({ TopicArn: String(properties.TopicArn), PolicyDocument: Object.freeze(canonical(properties.PolicyDocument)) });
    },
    plan(previous, desired) { return plan(previous, desired, ["TopicArn"]); },
    async create(desired, context) { try { return await reconcile(desired, context); } catch (error) { return failure(error); } },
    async read(id, context) { try { const current = await describe(id, context); return current ? policySuccess(id, current, { Arn: id }) : { status: "NOT_FOUND", physicalId: id }; } catch (error) { return failure(error) as ProviderReadResult<SnsTopicInlinePolicyModel>; } },
    async update(id, previous, desired, context) { if (id !== desired.TopicArn || previous.TopicArn !== desired.TopicArn) return { status: "FAILED", errorCode: "RequiresReplacement", message: "TopicArn changes require replacement" }; try { return await reconcile(desired, context); } catch (error) { return failure(error); } },
    async delete(id, _previous, context) { try { if (sns.cloudFormationPolicyOwner(id) !== owner(context)) return { status: "NOT_FOUND", physicalId: id }; await sns.releaseCloudFormationOwnedPolicy(id, owner(context)); return { status: "SUCCESS", physicalId: id }; } catch (error) { return failure(error) as ProviderDeleteResult; } },
    ref(current) { return current.physicalId; },
    getAtt(current, attribute) { if (attribute === "Arn") return current.physicalId; throw new ProviderReferenceError(SNS_TOPIC_INLINE_POLICY_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

export function createSnsCloudFormationProviders(sns: SnsService): readonly ProductionResourceProvider<any>[] {
  return Object.freeze([
    createTopicProvider(sns),
    createSubscriptionProvider(sns),
    createTopicPolicyProvider(sns),
    createTopicInlinePolicyProvider(sns),
  ]);
}
