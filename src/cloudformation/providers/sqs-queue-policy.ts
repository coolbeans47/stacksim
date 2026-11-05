import type { SqsService } from "../../sqs.js";
import { normalizeSqsQueuePolicy, validateSqsQueuePolicyTarget } from "../../sqs/policy.js";
import type { PolicyDocument } from "../../types.js";
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
  CFN10_NO_TAGS,
  CFN10_RETENTION,
  cfn10Failure,
  cfn10GetAtt,
  cfn10Issue,
  cfn10Owner,
  cfn10Plan,
  cfn10Record,
} from "./cfn10-common.js";

export const SQS_QUEUE_POLICY_TYPE = "AWS::SQS::QueuePolicy";
export const SQS_QUEUE_INLINE_POLICY_TYPE = "AWS::SQS::QueueInlinePolicy";
/**
 * Earlier releases marked a stack-managed queue policy by writing this prefix
 * and the resource owner into the stored document's Id. The user's document is
 * now stored unchanged; the marker is still recognised so queues deployed by
 * those releases can be updated and cleaned up.
 */
const LEGACY_POLICY_ID_PREFIX = "stacksim-cloudformation:";
const PHYSICAL_PREFIX = "sqs-queue-policy:";

export interface SqsQueuePolicyModel {
  readonly PolicyDocument: Readonly<Record<string, unknown>>;
  readonly Queues: readonly string[];
}

export interface SqsQueueInlinePolicyModel {
  readonly PolicyDocument: Readonly<Record<string, unknown>>;
  readonly Queue: string;
}

export const SQS_QUEUE_POLICY_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SQS_QUEUE_POLICY_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    PolicyDocument: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    Queues: Object.freeze({ valueType: "array", required: true, updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Queue-policy resource ID" }),
  attributes: Object.freeze({
    Id: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

export const SQS_QUEUE_INLINE_POLICY_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SQS_QUEUE_INLINE_POLICY_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    PolicyDocument: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    Queue: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT", description: "Queue URL" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Queue URL" }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

interface QueueTarget {
  readonly url: string;
  readonly arn: string;
  readonly policy?: string;
}

function physicalId(context: ProviderContext): string {
  return `${PHYSICAL_PREFIX}${cfn10Owner(context)}`;
}

function legacyPolicyId(context: ProviderContext): string {
  return `${LEGACY_POLICY_ID_PREFIX}${cfn10Owner(context)}`;
}

function parseQueueUrl(value: unknown, context: ProviderContext): { url: string; arn: string } | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    const parts = url.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
    if (parts.length !== 2 || parts[0] !== context.accountId || !/^(?:[A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\.fifo)$/.test(parts[1])) return undefined;
    return { url: value, arn: `arn:${context.partition}:sqs:${context.region}:${context.accountId}:${parts[1]}` };
  } catch {
    return undefined;
  }
}

function parseQueueArn(value: unknown, context: ProviderContext): { arn: string; name: string } | undefined {
  if (typeof value !== "string") return undefined;
  const prefix = `arn:${context.partition}:sqs:${context.region}:${context.accountId}:`;
  if (!value.startsWith(prefix)) return undefined;
  const name = value.slice(prefix.length);
  if (!/^(?:[A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\.fifo)$/.test(name)) return undefined;
  return { arn: value, name };
}

/** The public template contract is queue URLs; a persisted model carries the local queue ARNs emitted by canonicalize. */
function publicQueueUrl(value: unknown, context: ProviderContext): unknown {
  const parsed = parseQueueArn(value, context);
  return parsed ? `https://sqs.${context.region}.amazonaws.com/${context.accountId}/${parsed.name}` : value;
}

function validatePolicyDocument(document: unknown, targets: readonly { arn: string }[], issues: ProviderValidationIssue[]): void {
  if (!cfn10Record(document)) return;
  try {
    const normalized = normalizeSqsQueuePolicy(document as unknown as PolicyDocument);
    for (const target of targets) validateSqsQueuePolicyTarget(normalized.document, target.arn);
  } catch (error) {
    cfn10Issue(issues, "Properties.PolicyDocument", error instanceof Error ? error.message : String(error));
  }
}

function validation(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, SQS_QUEUE_POLICY_SCHEMA);
  if (!cfn10Record(properties)) return issues;
  const targets: Array<{ url: string; arn: string }> = [];
  if (Array.isArray(properties.Queues)) {
    if (properties.Queues.length < 1 || properties.Queues.length > 100) cfn10Issue(issues, "Properties.Queues", "Queues must contain 1-100 queue URLs");
    for (const [index, value] of properties.Queues.entries()) {
      const target = parseQueueUrl(value, context);
      if (!target) cfn10Issue(issues, `Properties.Queues.${index}`, "Each queue URL must identify a queue in this simulator account and Region");
      else targets.push(target);
    }
    if (new Set(targets.map(target => target.arn)).size !== targets.length) {
      cfn10Issue(issues, "Properties.Queues", "Queues must identify distinct queue resources; URL aliases for the same queue are not allowed");
    }
  }
  validatePolicyDocument(properties.PolicyDocument, targets, issues);
  return issues;
}

function inlineValidation(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, SQS_QUEUE_INLINE_POLICY_SCHEMA);
  if (!cfn10Record(properties)) return issues;
  const target = parseQueueUrl(properties.Queue, context);
  if (typeof properties.Queue === "string" && !target) cfn10Issue(issues, "Properties.Queue", "Queue must be the URL of a queue in this simulator account and Region");
  validatePolicyDocument(properties.PolicyDocument, target ? [target] : [], issues);
  return issues;
}

function canonicalPolicy(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze(normalizeSqsQueuePolicy(value as unknown as PolicyDocument).document as unknown as Record<string, unknown>);
}

function throwIssues(issues: readonly ProviderValidationIssue[]): void {
  if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
}

/** The document exactly as the user wrote it, in the form SQS stores a policy set through its API. */
function attachedPolicy(document: Readonly<Record<string, unknown>>): string {
  return normalizeSqsQueuePolicy(document as unknown as PolicyDocument).normalized;
}

/**
 * True when the queue still carries the policy this stack resource wrote:
 * either the document from the resource's last applied model, or a document
 * with the ownership marker written by an earlier release.
 */
function writtenByResource(raw: string | undefined, lastApplied: Readonly<Record<string, unknown>> | undefined, context: ProviderContext): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.Id === legacyPolicyId(context)) return true;
    return lastApplied !== undefined && normalizeSqsQueuePolicy(parsed as unknown as PolicyDocument).normalized === attachedPolicy(lastApplied);
  } catch {
    return false;
  }
}

function missingQueue(error: unknown): boolean {
  const code = cfn10Record(error) ? String(error.code ?? "") : "";
  return code === "QueueDoesNotExist" || code === "AWS.SimpleQueueService.NonExistentQueue";
}

/** Queue-policy operations shared by AWS::SQS::QueuePolicy and AWS::SQS::QueueInlinePolicy. */
function queuePolicyOperations(sqs: SqsService) {
  const target = async (identity: string): Promise<QueueTarget> => {
    const url = identity.startsWith("arn:")
      ? (await sqs.GetQueueUrl({ QueueName: identity.slice(identity.lastIndexOf(":") + 1) })).QueueUrl
      : identity;
    const attributes = (await sqs.GetQueueAttributes({ QueueUrl: url, AttributeNames: ["All"] })).Attributes ?? {};
    return { url, arn: String(attributes.QueueArn), ...(attributes.Policy ? { policy: String(attributes.Policy) } : {}) };
  };

  const existingTarget = async (identity: string): Promise<QueueTarget | undefined> => {
    try { return await target(identity); }
    catch (error) { if (missingQueue(error)) return undefined; throw error; }
  };

  const mutate = async (
    updates: readonly { target: QueueTarget; policy: string }[],
    ignoreMissing = false,
  ): Promise<void> => {
    const completed: Array<{ target: QueueTarget; previous: string }> = [];
    try {
      for (const update of updates) {
        const previous = update.target.policy ?? "";
        if (previous === update.policy) continue;
        try {
          await sqs.SetQueueAttributes({ QueueUrl: update.target.url, Attributes: { Policy: update.policy } });
        } catch (error) {
          if (ignoreMissing && missingQueue(error)) continue;
          throw error;
        }
        completed.push({ target: update.target, previous });
      }
    } catch (error) {
      for (const rollback of completed.reverse()) {
        try { await sqs.SetQueueAttributes({ QueueUrl: rollback.target.url, Attributes: { Policy: rollback.previous } }); }
        catch { /* The original failure remains authoritative. */ }
      }
      throw error;
    }
  };

  /**
   * Apply the document to every desired queue, replacing whatever policy the
   * queue has (the last writer wins, as with SetQueueAttributes on AWS), and
   * clear it from queues this resource no longer names when they still carry
   * the policy this resource wrote.
   */
  const apply = async (
    desiredQueues: readonly string[],
    document: Readonly<Record<string, unknown>>,
    previous: { readonly queues: readonly string[]; readonly document: Readonly<Record<string, unknown>> } | undefined,
    context: ProviderContext,
  ): Promise<QueueTarget[]> => {
    const desiredTargets: QueueTarget[] = [];
    for (const arn of desiredQueues) desiredTargets.push(await target(arn));
    const desiredArns = new Set(desiredTargets.map(item => item.arn));
    const released: QueueTarget[] = [];
    for (const arn of previous?.queues ?? []) {
      if (desiredArns.has(arn)) continue;
      const current = await existingTarget(arn);
      if (current && writtenByResource(current.policy, previous!.document, context)) released.push(current);
    }
    const wanted = attachedPolicy(document);
    await mutate([
      ...desiredTargets.map(item => ({ target: item, policy: wanted })),
      ...released.map(item => ({ target: item, policy: "" })),
    ]);
    return desiredTargets;
  };

  /** Remove the policy from each queue that still carries the one this resource wrote. Returns how many queues still exist. */
  const release = async (queues: readonly string[], document: Readonly<Record<string, unknown>>, context: ProviderContext): Promise<number> => {
    const owned: QueueTarget[] = [];
    let found = 0;
    for (const arn of queues) {
      const current = await existingTarget(arn);
      if (!current) continue;
      found++;
      if (writtenByResource(current.policy, document, context)) owned.push(current);
    }
    await mutate(owned.map(item => ({ target: item, policy: "" })), true);
    return found;
  };

  return { target, existingTarget, apply, release };
}

function success(currentPhysicalId: string, current: SqsQueuePolicyModel): ProviderSuccess<SqsQueuePolicyModel> {
  return {
    status: "SUCCESS",
    physicalId: currentPhysicalId,
    model: {
      physicalId: currentPhysicalId,
      properties: current,
      attributes: { Id: currentPhysicalId },
    },
  };
}

export function createSqsQueuePolicyProvider(sqs: SqsService): ProductionResourceProvider<SqsQueuePolicyModel> {
  const operations = queuePolicyOperations(sqs);
  // The stack's resource record holds the queue list, and update and delete
  // receive it as the previous model. Only read has no model, so the last
  // model applied by this process is remembered for it.
  const applied = new Map<string, SqsQueuePolicyModel>();

  const allQueueUrls = async (): Promise<string[]> => {
    const urls: string[] = [];
    let nextToken: string | undefined;
    do {
      const page = await sqs.ListQueues({ MaxResults: 1_000, ...(nextToken ? { NextToken: nextToken } : {}) });
      urls.push(...(page.QueueUrls ?? []));
      nextToken = page.NextToken;
    } while (nextToken);
    return urls.sort();
  };

  /** Queues whose stored policy carries the ownership marker written by an earlier release. */
  const legacyModel = async (context: ProviderContext): Promise<SqsQueuePolicyModel | undefined> => {
    const queues: QueueTarget[] = [];
    for (const url of await allQueueUrls()) {
      const current = await operations.existingTarget(url);
      if (current?.policy && writtenByResource(current.policy, undefined, context)) queues.push(current);
    }
    if (!queues.length) return undefined;
    const { Id: _marker, ...visible } = JSON.parse(queues[0].policy!) as Record<string, unknown>;
    return Object.freeze({ PolicyDocument: canonicalPolicy(visible), Queues: Object.freeze(queues.map(queue => queue.arn).sort()) });
  };

  const describe = async (currentPhysicalId: string, context: ProviderContext): Promise<SqsQueuePolicyModel | undefined> => {
    if (currentPhysicalId !== physicalId(context)) throw new Error("QueuePolicy physical ID is not owned by this stack resource");
    const remembered = applied.get(currentPhysicalId);
    if (!remembered) return legacyModel(context);
    const queues: string[] = [];
    for (const arn of remembered.Queues) {
      const current = await operations.existingTarget(arn);
      if (current && writtenByResource(current.policy, remembered.PolicyDocument, context)) queues.push(arn);
    }
    return queues.length ? Object.freeze({ PolicyDocument: remembered.PolicyDocument, Queues: Object.freeze(queues) }) : undefined;
  };

  const reconcile = async (currentPhysicalId: string, previous: SqsQueuePolicyModel | undefined, desired: SqsQueuePolicyModel, context: ProviderContext): Promise<ProviderUpdateResult<SqsQueuePolicyModel>> => {
    if (currentPhysicalId !== physicalId(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: "QueuePolicy physical ID is not owned by this stack resource" };
    const targets = await operations.apply(desired.Queues, desired.PolicyDocument, previous ? { queues: previous.Queues, document: previous.PolicyDocument } : undefined, context);
    const current: SqsQueuePolicyModel = Object.freeze({ PolicyDocument: desired.PolicyDocument, Queues: Object.freeze(targets.map(item => item.arn).sort()) });
    applied.set(currentPhysicalId, current);
    return success(currentPhysicalId, current);
  };

  return {
    typeName: SQS_QUEUE_POLICY_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: SQS_QUEUE_POLICY_SCHEMA,
    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] { return validation(properties, context); },
    canonicalize(properties: unknown, context: ProviderContext): SqsQueuePolicyModel {
      if (!cfn10Record(properties)) throw new TypeError(`${SQS_QUEUE_POLICY_TYPE} Properties must be an object`);
      // CloudFormation persists provider models and canonicalizes them again for
      // later update, delete, and rollback operations. The public template
      // contract remains queue URLs (enforced by validate), while this private
      // path accepts only the exact local queue ARNs emitted below.
      const internalQueues = Array.isArray(properties.Queues)
        && properties.Queues.length > 0
        && properties.Queues.every(value => parseQueueArn(value, context) !== undefined);
      const validationInput = internalQueues
        ? { ...properties, Queues: (properties.Queues as unknown[]).map(value => publicQueueUrl(value, context)) }
        : properties;
      throwIssues(validation(validationInput, context));
      return Object.freeze({
        PolicyDocument: canonicalPolicy(properties.PolicyDocument as Record<string, unknown>),
        Queues: Object.freeze((properties.Queues as unknown[]).map(value =>
          parseQueueUrl(value, context)?.arn ?? parseQueueArn(value, context)!.arn).sort()),
      });
    },
    plan(previous: SqsQueuePolicyModel | undefined, desired: SqsQueuePolicyModel): ProviderPlan<SqsQueuePolicyModel> {
      return cfn10Plan(previous as SqsQueuePolicyModel & Record<string, unknown> | undefined, desired as SqsQueuePolicyModel & Record<string, unknown>, SQS_QUEUE_POLICY_SCHEMA) as ProviderPlan<SqsQueuePolicyModel>;
    },
    async create(desired: SqsQueuePolicyModel, context: ProviderContext) {
      try { return await reconcile(physicalId(context), undefined, desired, context); }
      catch (error) { return cfn10Failure(error); }
    },
    async read(currentPhysicalId: string, context: ProviderContext): Promise<ProviderReadResult<SqsQueuePolicyModel>> {
      try {
        const current = await describe(currentPhysicalId, context);
        return current ? success(currentPhysicalId, current) : { status: "NOT_FOUND", physicalId: currentPhysicalId };
      } catch (error) {
        return cfn10Failure(error);
      }
    },
    async update(currentPhysicalId: string, previous: SqsQueuePolicyModel, desired: SqsQueuePolicyModel, context: ProviderContext): Promise<ProviderUpdateResult<SqsQueuePolicyModel>> {
      try { return await reconcile(currentPhysicalId, previous, desired, context); }
      catch (error) { return cfn10Failure(error); }
    },
    async delete(currentPhysicalId: string, previous: SqsQueuePolicyModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        if (currentPhysicalId !== physicalId(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: "QueuePolicy physical ID is not owned by this stack resource" };
        applied.delete(currentPhysicalId);
        const found = await operations.release(previous.Queues, previous.PolicyDocument, context);
        return found ? { status: "SUCCESS", physicalId: currentPhysicalId } : { status: "NOT_FOUND", physicalId: currentPhysicalId };
      } catch (error) {
        return missingQueue(error) ? { status: "NOT_FOUND", physicalId: currentPhysicalId } : cfn10Failure(error) as ProviderDeleteResult;
      }
    },
    ref(current: ProviderReadModel<SqsQueuePolicyModel>): unknown { return current.physicalId; },
    getAtt(current: ProviderReadModel<SqsQueuePolicyModel>, attribute: string): unknown {
      return cfn10GetAtt(SQS_QUEUE_POLICY_TYPE, SQS_QUEUE_POLICY_SCHEMA, current, attribute);
    },
  };
}

/**
 * AWS::SQS::QueueInlinePolicy attaches one policy document to one queue. Its
 * physical ID and Ref value are the queue URL.
 */
export function createSqsQueueInlinePolicyProvider(sqs: SqsService): ProductionResourceProvider<SqsQueueInlinePolicyModel> {
  const operations = queuePolicyOperations(sqs);

  const success = (queue: QueueTarget, document: Readonly<Record<string, unknown>>): ProviderSuccess<SqsQueueInlinePolicyModel> => ({
    status: "SUCCESS",
    physicalId: queue.url,
    model: {
      physicalId: queue.url,
      properties: Object.freeze({ PolicyDocument: document, Queue: queue.arn }),
      attributes: { QueueUrl: queue.url },
    },
  });

  const reconcile = async (desired: SqsQueueInlinePolicyModel, context: ProviderContext): Promise<ProviderUpdateResult<SqsQueueInlinePolicyModel>> => {
    const [queue] = await operations.apply([desired.Queue], desired.PolicyDocument, undefined, context);
    return success(queue, desired.PolicyDocument);
  };

  return {
    typeName: SQS_QUEUE_INLINE_POLICY_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: SQS_QUEUE_INLINE_POLICY_SCHEMA,
    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] { return inlineValidation(properties, context); },
    canonicalize(properties: unknown, context: ProviderContext): SqsQueueInlinePolicyModel {
      if (!cfn10Record(properties)) throw new TypeError(`${SQS_QUEUE_INLINE_POLICY_TYPE} Properties must be an object`);
      // A persisted model carries the local queue ARN emitted below.
      throwIssues(inlineValidation({ ...properties, Queue: publicQueueUrl(properties.Queue, context) }, context));
      return Object.freeze({
        PolicyDocument: canonicalPolicy(properties.PolicyDocument as Record<string, unknown>),
        Queue: parseQueueUrl(properties.Queue, context)?.arn ?? parseQueueArn(properties.Queue, context)!.arn,
      });
    },
    plan(previous: SqsQueueInlinePolicyModel | undefined, desired: SqsQueueInlinePolicyModel): ProviderPlan<SqsQueueInlinePolicyModel> {
      return cfn10Plan(previous as SqsQueueInlinePolicyModel & Record<string, unknown> | undefined, desired as SqsQueueInlinePolicyModel & Record<string, unknown>, SQS_QUEUE_INLINE_POLICY_SCHEMA) as ProviderPlan<SqsQueueInlinePolicyModel>;
    },
    async create(desired: SqsQueueInlinePolicyModel, context: ProviderContext) {
      try { return await reconcile(desired, context); }
      catch (error) { return cfn10Failure(error); }
    },
    async read(currentPhysicalId: string): Promise<ProviderReadResult<SqsQueueInlinePolicyModel>> {
      try {
        const queue = await operations.existingTarget(currentPhysicalId);
        if (!queue?.policy) return { status: "NOT_FOUND", physicalId: currentPhysicalId };
        return success(queue, canonicalPolicy(JSON.parse(queue.policy) as Record<string, unknown>));
      } catch (error) {
        return cfn10Failure(error);
      }
    },
    async update(_currentPhysicalId: string, _previous: SqsQueueInlinePolicyModel, desired: SqsQueueInlinePolicyModel, context: ProviderContext): Promise<ProviderUpdateResult<SqsQueueInlinePolicyModel>> {
      try { return await reconcile(desired, context); }
      catch (error) { return cfn10Failure(error); }
    },
    async delete(currentPhysicalId: string, previous: SqsQueueInlinePolicyModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const found = await operations.release([previous.Queue], previous.PolicyDocument, context);
        return found ? { status: "SUCCESS", physicalId: currentPhysicalId } : { status: "NOT_FOUND", physicalId: currentPhysicalId };
      } catch (error) {
        return missingQueue(error) ? { status: "NOT_FOUND", physicalId: currentPhysicalId } : cfn10Failure(error) as ProviderDeleteResult;
      }
    },
    ref(current: ProviderReadModel<SqsQueueInlinePolicyModel>): unknown { return current.attributes.QueueUrl; },
    getAtt(_current: ProviderReadModel<SqsQueueInlinePolicyModel>, attribute: string): unknown {
      throw new ProviderReferenceError(SQS_QUEUE_INLINE_POLICY_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}
