import type { SqsService } from "../../sqs.js";
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
import {
  CFN09_RETENTION,
  canonicalTags,
  changedProperties,
  exactKeys,
  isNotFound,
  isRecord,
  issue,
  owns,
  providerFailure,
  same,
  stable,
  stableName,
  tagMap,
  validateTags,
  visibleTags,
  type Cfn09Tag,
} from "./cfn09-common.js";

export const SQS_QUEUE_TYPE = "AWS::SQS::Queue";

export interface SqsRedrivePolicyModel {
  readonly deadLetterTargetArn: string;
  readonly maxReceiveCount: number;
}

export interface SqsRedriveAllowPolicyModel {
  readonly redrivePermission: "allowAll" | "denyAll" | "byQueue";
  readonly sourceQueueArns?: readonly string[];
}

export interface SqsQueueModel {
  readonly QueueName: string;
  readonly ContentBasedDeduplication?: boolean;
  readonly DeduplicationScope?: "queue" | "messageGroup";
  readonly DelaySeconds: number;
  readonly FifoQueue: boolean;
  readonly FifoThroughputLimit?: "perQueue" | "perMessageGroupId";
  readonly MaximumMessageSize: number;
  readonly MessageRetentionPeriod: number;
  readonly ReceiveMessageWaitTimeSeconds: number;
  readonly RedriveAllowPolicy?: SqsRedriveAllowPolicyModel;
  readonly RedrivePolicy?: SqsRedrivePolicyModel;
  readonly SqsManagedSseEnabled: boolean;
  readonly Tags: readonly Cfn09Tag[];
  readonly VisibilityTimeout: number;
}

export const SQS_QUEUE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SQS_QUEUE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ContentBasedDeduplication: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE", description: "FIFO queues only." }),
    DeduplicationScope: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE", description: "FIFO queues only." }),
    DelaySeconds: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    FifoQueue: Object.freeze({ valueType: "boolean", updateBehavior: "REPLACEMENT" }),
    FifoThroughputLimit: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE", description: "FIFO queues only." }),
    MaximumMessageSize: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    MessageRetentionPeriod: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    QueueName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    ReceiveMessageWaitTimeSeconds: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    RedriveAllowPolicy: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    RedrivePolicy: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    SqsManagedSseEnabled: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE", description: "SSE-SQS only; SSE-KMS properties remain unsupported." }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    VisibilityTimeout: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Queue URL" }),
  attributes: Object.freeze({
    Arn: Object.freeze({ valueType: "string", description: "Queue ARN" }),
    QueueName: Object.freeze({ valueType: "string", description: "Queue name" }),
    QueueUrl: Object.freeze({ valueType: "string", description: "Queue URL" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: CFN09_RETENTION,
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

const NUMBER_BOUNDS = Object.freeze({
  DelaySeconds: [0, 900],
  MaximumMessageSize: [1_024, 1_048_576],
  MessageRetentionPeriod: [60, 1_209_600],
  ReceiveMessageWaitTimeSeconds: [0, 20],
  VisibilityTimeout: [0, 43_200],
} as const);

const DEFAULTS = Object.freeze({
  DelaySeconds: 0,
  MaximumMessageSize: 1_048_576,
  MessageRetentionPeriod: 345_600,
  ReceiveMessageWaitTimeSeconds: 0,
  VisibilityTimeout: 30,
});

function queueName(context: ProviderContext, fifo: boolean): string {
  const name = stableName(context, fifo ? 75 : 80, /[A-Za-z0-9_-]/, "queue");
  return fifo ? `${name}.fifo` : name;
}

function validQueueArn(value: unknown, context: ProviderContext, fifo: boolean): value is string {
  if (typeof value !== "string") return false;
  const match = /^arn:aws:sqs:([^:]+):(\d{12}):([A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\.fifo)$/.exec(value);
  return Boolean(match && match[1] === context.region && match[2] === context.accountId && match[3].endsWith(".fifo") === fifo);
}

function validateInteger(value: unknown, path: string, minimum: number, maximum: number, issues: ProviderValidationIssue[]): void {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) issue(issues, path, `${path.split(".").at(-1)} must be an integer between ${minimum} and ${maximum}`);
}

function validateRedrivePolicy(value: unknown, context: ProviderContext, fifo: boolean, issues: ProviderValidationIssue[]): void {
  const path = "Properties.RedrivePolicy";
  if (!isRecord(value)) return;
  exactKeys(value, ["deadLetterTargetArn", "maxReceiveCount"], path, issues);
  if (!validQueueArn(value.deadLetterTargetArn, context, fifo)) issue(issues, `${path}.deadLetterTargetArn`, `deadLetterTargetArn must identify a ${fifo ? "FIFO" : "Standard"} queue in this simulator account and Region`);
  validateInteger(value.maxReceiveCount, `${path}.maxReceiveCount`, 1, 1_000, issues);
}

function validateRedriveAllowPolicy(value: unknown, context: ProviderContext, fifo: boolean, issues: ProviderValidationIssue[]): void {
  const path = "Properties.RedriveAllowPolicy";
  if (!isRecord(value)) return;
  exactKeys(value, ["redrivePermission", "sourceQueueArns"], path, issues);
  const permission = value.redrivePermission;
  if (permission !== "allowAll" && permission !== "denyAll" && permission !== "byQueue") issue(issues, `${path}.redrivePermission`, "redrivePermission must be allowAll, denyAll, or byQueue");
  if (permission === "byQueue") {
    if (!Array.isArray(value.sourceQueueArns) || value.sourceQueueArns.length < 1 || value.sourceQueueArns.length > 10) issue(issues, `${path}.sourceQueueArns`, "byQueue requires between 1 and 10 source queue ARNs");
    else {
      const arns = value.sourceQueueArns;
      if (new Set(arns).size !== arns.length) issue(issues, `${path}.sourceQueueArns`, "sourceQueueArns must not contain duplicates");
      for (const [index, arn] of arns.entries()) if (!validQueueArn(arn, context, fifo)) issue(issues, `${path}.sourceQueueArns.${index}`, `Each sourceQueueArn must identify a ${fifo ? "FIFO" : "Standard"} queue in this simulator account and Region`);
    }
  } else if (value.sourceQueueArns !== undefined) {
    issue(issues, `${path}.sourceQueueArns`, "sourceQueueArns is valid only with redrivePermission byQueue");
  }
}

function validation(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, SQS_QUEUE_SCHEMA);
  if (!isRecord(properties)) return issues;
  const fifo = properties.FifoQueue === true;
  if (properties.QueueName !== undefined) {
    const valid = typeof properties.QueueName === "string"
      && (fifo ? /^[A-Za-z0-9_-]{1,75}\.fifo$/.test(properties.QueueName) : /^[A-Za-z0-9_-]{1,80}$/.test(properties.QueueName));
    if (!valid) issue(issues, "Properties.QueueName", `QueueName must be a valid ${fifo ? "FIFO name ending in .fifo" : "Standard queue name without a .fifo suffix"}`);
  }
  for (const [name, [minimum, maximum]] of Object.entries(NUMBER_BOUNDS)) {
    if (properties[name] !== undefined) validateInteger(properties[name], `Properties.${name}`, minimum, maximum, issues);
  }
  if (!fifo) {
    for (const property of ["ContentBasedDeduplication", "DeduplicationScope", "FifoThroughputLimit"]) {
      if (properties[property] !== undefined) issue(issues, `Properties.${property}`, `${property} is valid only when FifoQueue is true`);
    }
  } else {
    if (properties.DeduplicationScope !== undefined && properties.DeduplicationScope !== "queue" && properties.DeduplicationScope !== "messageGroup") issue(issues, "Properties.DeduplicationScope", "DeduplicationScope must be queue or messageGroup");
    if (properties.FifoThroughputLimit !== undefined && properties.FifoThroughputLimit !== "perQueue" && properties.FifoThroughputLimit !== "perMessageGroupId") issue(issues, "Properties.FifoThroughputLimit", "FifoThroughputLimit must be perQueue or perMessageGroupId");
    const scope = properties.DeduplicationScope ?? "queue";
    const limit = properties.FifoThroughputLimit ?? "perQueue";
    if (limit === "perMessageGroupId" && scope !== "messageGroup") issue(issues, "Properties.FifoThroughputLimit", "perMessageGroupId throughput requires DeduplicationScope messageGroup");
  }
  if (properties.RedrivePolicy !== undefined) validateRedrivePolicy(properties.RedrivePolicy, context, fifo, issues);
  if (properties.RedriveAllowPolicy !== undefined) validateRedriveAllowPolicy(properties.RedriveAllowPolicy, context, fifo, issues);
  if (properties.Tags !== undefined) validateTags(properties.Tags, "Properties.Tags", issues);
  return issues;
}

function canonicalRedrivePolicy(value: unknown): SqsRedrivePolicyModel | undefined {
  if (!isRecord(value)) return undefined;
  return { deadLetterTargetArn: String(value.deadLetterTargetArn), maxReceiveCount: Number(value.maxReceiveCount) };
}

function canonicalRedriveAllowPolicy(value: unknown): SqsRedriveAllowPolicyModel | undefined {
  if (!isRecord(value)) return undefined;
  const redrivePermission = String(value.redrivePermission) as SqsRedriveAllowPolicyModel["redrivePermission"];
  return {
    redrivePermission,
    ...(Array.isArray(value.sourceQueueArns) ? { sourceQueueArns: value.sourceQueueArns.map(String).sort() } : {}),
  };
}

function model(properties: Record<string, unknown>, context: ProviderContext): SqsQueueModel {
  const fifo = properties.FifoQueue === true;
  return {
    QueueName: String(properties.QueueName ?? queueName(context, fifo)),
    ...(fifo ? {
      ContentBasedDeduplication: Boolean(properties.ContentBasedDeduplication ?? false),
      DeduplicationScope: String(properties.DeduplicationScope ?? "queue") as "queue" | "messageGroup",
    } : {}),
    DelaySeconds: Number(properties.DelaySeconds ?? DEFAULTS.DelaySeconds),
    FifoQueue: fifo,
    ...(fifo ? { FifoThroughputLimit: String(properties.FifoThroughputLimit ?? "perQueue") as "perQueue" | "perMessageGroupId" } : {}),
    MaximumMessageSize: Number(properties.MaximumMessageSize ?? DEFAULTS.MaximumMessageSize),
    MessageRetentionPeriod: Number(properties.MessageRetentionPeriod ?? DEFAULTS.MessageRetentionPeriod),
    ReceiveMessageWaitTimeSeconds: Number(properties.ReceiveMessageWaitTimeSeconds ?? DEFAULTS.ReceiveMessageWaitTimeSeconds),
    ...(properties.RedriveAllowPolicy !== undefined ? { RedriveAllowPolicy: canonicalRedriveAllowPolicy(properties.RedriveAllowPolicy)! } : {}),
    ...(properties.RedrivePolicy !== undefined ? { RedrivePolicy: canonicalRedrivePolicy(properties.RedrivePolicy)! } : {}),
    SqsManagedSseEnabled: Boolean(properties.SqsManagedSseEnabled ?? true),
    Tags: canonicalTags(properties.Tags),
    VisibilityTimeout: Number(properties.VisibilityTimeout ?? DEFAULTS.VisibilityTimeout),
  };
}

function attributeInput(queue: SqsQueueModel): Record<string, string> {
  return {
    ...(queue.FifoQueue ? {
      ContentBasedDeduplication: String(queue.ContentBasedDeduplication),
      DeduplicationScope: String(queue.DeduplicationScope),
      FifoQueue: "true",
      FifoThroughputLimit: String(queue.FifoThroughputLimit),
    } : {}),
    DelaySeconds: String(queue.DelaySeconds),
    MaximumMessageSize: String(queue.MaximumMessageSize),
    MessageRetentionPeriod: String(queue.MessageRetentionPeriod),
    ReceiveMessageWaitTimeSeconds: String(queue.ReceiveMessageWaitTimeSeconds),
    ...(queue.RedriveAllowPolicy ? { RedriveAllowPolicy: JSON.stringify(stable(queue.RedriveAllowPolicy)) } : {}),
    ...(queue.RedrivePolicy ? { RedrivePolicy: JSON.stringify(stable(queue.RedrivePolicy)) } : {}),
    SqsManagedSseEnabled: String(queue.SqsManagedSseEnabled),
    VisibilityTimeout: String(queue.VisibilityTimeout),
  };
}

interface QueueSnapshot {
  readonly model: SqsQueueModel;
  readonly arn: string;
  readonly url: string;
  readonly tags: Readonly<Record<string, string>>;
}

function success(snapshot: QueueSnapshot): ProviderSuccess<SqsQueueModel> {
  return {
    status: "SUCCESS",
    physicalId: snapshot.model.QueueName,
    model: {
      physicalId: snapshot.model.QueueName,
      properties: snapshot.model,
      attributes: { Arn: snapshot.arn, QueueName: snapshot.model.QueueName, QueueUrl: snapshot.url },
    },
  };
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  return isRecord(parsed) ? parsed : undefined;
}

export function createSqsQueueProvider(sqs: SqsService): ProductionResourceProvider<SqsQueueModel> {
  const describe = async (name: string): Promise<QueueSnapshot> => {
    const url = (await sqs.GetQueueUrl({ QueueName: name })).QueueUrl;
    const attributes = (await sqs.GetQueueAttributes({ QueueUrl: url, AttributeNames: ["All"] })).Attributes ?? {};
    const tags = (await sqs.ListQueueTags({ QueueUrl: url })).Tags ?? {};
    const fifo = attributes.FifoQueue === "true";
    if (attributes.KmsMasterKeyId || attributes.KmsDataKeyReusePeriodSeconds) throw new Error(`Queue ${name} uses SSE-KMS, which is not supported by the local CloudFormation provider`);
    const redrive = parseJsonObject(attributes.RedrivePolicy);
    const allow = parseJsonObject(attributes.RedriveAllowPolicy);
    const current: SqsQueueModel = {
      QueueName: name,
      ...(fifo ? {
        ContentBasedDeduplication: attributes.ContentBasedDeduplication === "true",
        DeduplicationScope: String(attributes.DeduplicationScope) as "queue" | "messageGroup",
      } : {}),
      DelaySeconds: Number(attributes.DelaySeconds),
      FifoQueue: fifo,
      ...(fifo ? { FifoThroughputLimit: String(attributes.FifoThroughputLimit) as "perQueue" | "perMessageGroupId" } : {}),
      MaximumMessageSize: Number(attributes.MaximumMessageSize),
      MessageRetentionPeriod: Number(attributes.MessageRetentionPeriod),
      ReceiveMessageWaitTimeSeconds: Number(attributes.ReceiveMessageWaitTimeSeconds),
      ...(allow ? { RedriveAllowPolicy: canonicalRedriveAllowPolicy(allow)! } : {}),
      ...(redrive ? { RedrivePolicy: canonicalRedrivePolicy(redrive)! } : {}),
      SqsManagedSseEnabled: attributes.SqsManagedSseEnabled === "true",
      Tags: visibleTags(tags),
      VisibilityTimeout: Number(attributes.VisibilityTimeout),
    };
    return { model: current, arn: String(attributes.QueueArn), url, tags };
  };

  const reconcile = async (physicalId: string, desired: SqsQueueModel, context: ProviderContext): Promise<ProviderUpdateResult<SqsQueueModel>> => {
    const current = await describe(physicalId);
    if (!owns(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Queue ${physicalId} is not owned by this stack resource` };
    if (physicalId !== desired.QueueName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "QueueName changes require replacement" };
    if (current.model.FifoQueue !== desired.FifoQueue) return { status: "FAILED", errorCode: "RequiresReplacement", message: "FifoQueue changes require replacement" };
    const previousAttributes = attributeInput(current.model);
    const desiredAttributes = attributeInput(desired);
    const updates: Record<string, string> = {};
    for (const key of ["ContentBasedDeduplication", "DeduplicationScope", "DelaySeconds", "FifoThroughputLimit", "MaximumMessageSize", "MessageRetentionPeriod", "ReceiveMessageWaitTimeSeconds", "SqsManagedSseEnabled", "VisibilityTimeout"] as const) {
      if (previousAttributes[key] !== desiredAttributes[key]) updates[key] = desiredAttributes[key];
    }
    for (const key of ["RedriveAllowPolicy", "RedrivePolicy"] as const) {
      if (previousAttributes[key] !== desiredAttributes[key]) updates[key] = desiredAttributes[key] ?? "";
    }
    if (Object.keys(updates).length) await sqs.SetQueueAttributes({ QueueUrl: current.url, Attributes: updates });

    const wantedTags = tagMap(desired.Tags, context);
    const removals = Object.keys(current.tags).filter(key => key !== "stacksim:cloudformation:owner" && !Object.hasOwn(wantedTags, key));
    if (removals.length) await sqs.UntagQueue({ QueueUrl: current.url, TagKeys: removals });
    const additions = Object.fromEntries(Object.entries(wantedTags).filter(([key, value]) => current.tags[key] !== value));
    if (Object.keys(additions).length) await sqs.TagQueue({ QueueUrl: current.url, Tags: additions });
    return success(await describe(physicalId));
  };

  return {
    typeName: SQS_QUEUE_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: SQS_QUEUE_SCHEMA,
    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] { return validation(properties, context); },
    canonicalize(properties: unknown, context: ProviderContext): SqsQueueModel {
      if (!isRecord(properties)) throw new TypeError(`${SQS_QUEUE_TYPE} Properties must be an object`);
      const issues = validation(properties, context);
      if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return model(properties, context);
    },
    plan(previous: SqsQueueModel | undefined, desired: SqsQueueModel): ProviderPlan<SqsQueueModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const changed = changedProperties(previous, desired);
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      const replacements = [
        ...(previous.QueueName !== desired.QueueName ? ["QueueName"] : []),
        ...(previous.FifoQueue !== desired.FifoQueue ? ["FifoQueue"] : []),
      ];
      if (replacements.length) {
        const collision = previous.QueueName === desired.QueueName;
        return {
          action: "REPLACE",
          desired,
          changedProperties: changed,
          replacementProperties: replacements,
          replacementOrder: collision ? "DELETE_BEFORE_CREATE" : "CREATE_BEFORE_DELETE",
          ...(collision ? { reason: "SQS queue names are unique and FifoQueue is immutable" } : {}),
        };
      }
      return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
    },
    async create(desired: SqsQueueModel, context: ProviderContext) {
      try {
        try {
          const existing = await describe(desired.QueueName);
          if (!owns(existing.tags, context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Queue ${desired.QueueName} already exists and is not owned by this stack resource` };
          return await reconcile(desired.QueueName, desired, context);
        } catch (error) { if (!isNotFound(error, ["QueueDoesNotExist", "AWS.SimpleQueueService.NonExistentQueue"])) throw error; }
        await sqs.CreateQueue({ QueueName: desired.QueueName, Attributes: attributeInput(desired), Tags: tagMap(desired.Tags, context) });
        return success(await describe(desired.QueueName));
      } catch (error) { return providerFailure(error); }
    },
    async read(physicalId: string): Promise<ProviderReadResult<SqsQueueModel>> {
      try { return success(await describe(physicalId)); }
      catch (error) { return isNotFound(error, ["QueueDoesNotExist", "AWS.SimpleQueueService.NonExistentQueue"]) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    async update(physicalId: string, _previous: SqsQueueModel, desired: SqsQueueModel, context: ProviderContext): Promise<ProviderUpdateResult<SqsQueueModel>> {
      try { return await reconcile(physicalId, desired, context); }
      catch (error) { return providerFailure(error); }
    },
    async delete(physicalId: string, _previous: SqsQueueModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const current = await describe(physicalId);
        if (!owns(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Queue ${physicalId} is not owned by this stack resource` };
        await sqs.DeleteQueue({ QueueUrl: current.url });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isNotFound(error, ["QueueDoesNotExist", "AWS.SimpleQueueService.NonExistentQueue"]) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    ref(current: ProviderReadModel<SqsQueueModel>): unknown { return current.attributes.QueueUrl; },
    getAtt(current: ProviderReadModel<SqsQueueModel>, attribute: string): unknown {
      if (attribute === "Arn" || attribute === "QueueName" || attribute === "QueueUrl") return current.attributes[attribute];
      throw new ProviderReferenceError(SQS_QUEUE_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}
