import type { SqsService } from "../../sqs.js";
import { normalizeSqsQueuePolicy, validateSqsQueuePolicyTarget } from "../../sqs/policy.js";
import type { PolicyDocument } from "../../types.js";
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
const POLICY_ID_PREFIX = "stacksim-cloudformation:";
const PHYSICAL_PREFIX = "sqs-queue-policy:";

export interface SqsQueuePolicyModel {
  readonly PolicyDocument: Readonly<Record<string, unknown>>;
  readonly Queues: readonly string[];
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

interface QueueTarget {
  readonly url: string;
  readonly arn: string;
  readonly policy?: string;
}

function physicalId(context: ProviderContext): string {
  return `${PHYSICAL_PREFIX}${cfn10Owner(context)}`;
}

function policyId(context: ProviderContext): string {
  return `${POLICY_ID_PREFIX}${cfn10Owner(context)}`;
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
  if (cfn10Record(properties.PolicyDocument)) {
    if (properties.PolicyDocument.Id !== undefined) cfn10Issue(issues, "Properties.PolicyDocument.Id", "PolicyDocument.Id is reserved for CloudFormation ownership in the local QueuePolicy provider");
    try {
      const normalized = normalizeSqsQueuePolicy(properties.PolicyDocument as unknown as PolicyDocument);
      for (const target of targets) validateSqsQueuePolicyTarget(normalized.document, target.arn);
    } catch (error) {
      cfn10Issue(issues, "Properties.PolicyDocument", error instanceof Error ? error.message : String(error));
    }
  }
  return issues;
}

function canonicalPolicy(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze(normalizeSqsQueuePolicy(value as unknown as PolicyDocument).document as unknown as Record<string, unknown>);
}

function model(properties: Record<string, unknown>, context: ProviderContext): SqsQueuePolicyModel {
  return Object.freeze({
    PolicyDocument: canonicalPolicy(properties.PolicyDocument as Record<string, unknown>),
    Queues: Object.freeze((properties.Queues as unknown[]).map(value =>
      parseQueueUrl(value, context)?.arn ?? parseQueueArn(value, context)!.arn).sort()),
  });
}

function attachedPolicy(desired: SqsQueuePolicyModel, context: ProviderContext): string {
  return normalizeSqsQueuePolicy({
    ...(desired.PolicyDocument as unknown as PolicyDocument),
    Id: policyId(context),
  }).normalized;
}

function visiblePolicy(raw: string, context: ProviderContext): Readonly<Record<string, unknown>> {
  const parsed = normalizeSqsQueuePolicy(JSON.parse(raw) as PolicyDocument);
  const document = parsed.document as unknown as Record<string, unknown>;
  if (document.Id !== policyId(context)) throw new Error("Queue policy is not owned by this stack resource");
  const { Id: _ownership, ...visible } = document;
  return canonicalPolicy(visible);
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

function missingQueue(error: unknown): boolean {
  const code = cfn10Record(error) ? String(error.code ?? "") : "";
  return code === "QueueDoesNotExist" || code === "AWS.SimpleQueueService.NonExistentQueue";
}

export function createSqsQueuePolicyProvider(sqs: SqsService): ProductionResourceProvider<SqsQueuePolicyModel> {
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

  const target = async (identity: string): Promise<QueueTarget> => {
    const url = identity.startsWith("arn:")
      ? (await sqs.GetQueueUrl({ QueueName: identity.slice(identity.lastIndexOf(":") + 1) })).QueueUrl
      : identity;
    const attributes = (await sqs.GetQueueAttributes({ QueueUrl: url, AttributeNames: ["All"] })).Attributes ?? {};
    return { url, arn: String(attributes.QueueArn), ...(attributes.Policy ? { policy: String(attributes.Policy) } : {}) };
  };

  const ownedTargets = async (context: ProviderContext): Promise<QueueTarget[]> => {
    const result: QueueTarget[] = [];
    for (const url of await allQueueUrls()) {
      let current: QueueTarget;
      try {
        current = await target(url);
      } catch (error) {
        if (missingQueue(error)) continue;
        throw error;
      }
      if (!current.policy) continue;
      try {
        const document = JSON.parse(current.policy) as Record<string, unknown>;
        if (document.Id === policyId(context)) result.push(current);
      } catch {
        // SetQueueAttributes guarantees valid JSON, but an unrelated malformed value is not this provider's resource.
      }
    }
    return result.sort((left, right) => left.url.localeCompare(right.url));
  };

  const describe = async (currentPhysicalId: string, context: ProviderContext): Promise<SqsQueuePolicyModel | undefined> => {
    if (currentPhysicalId !== physicalId(context)) throw new Error("QueuePolicy physical ID is not owned by this stack resource");
    const queues = await ownedTargets(context);
    if (!queues.length) return undefined;
    const policy = visiblePolicy(queues[0].policy!, context);
    const expected = JSON.stringify(policy);
    for (const queue of queues.slice(1)) {
      if (JSON.stringify(visiblePolicy(queue.policy!, context)) !== expected) throw new Error("Owned queues contain inconsistent QueuePolicy documents");
    }
    return Object.freeze({ PolicyDocument: policy, Queues: Object.freeze(queues.map(queue => queue.arn)) });
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

  const reconcile = async (currentPhysicalId: string, desired: SqsQueuePolicyModel, context: ProviderContext): Promise<ProviderUpdateResult<SqsQueuePolicyModel>> => {
    if (currentPhysicalId !== physicalId(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: "QueuePolicy physical ID is not owned by this stack resource" };
    const existing = await ownedTargets(context);
    const existingByArn = new Map(existing.map(item => [item.arn, item]));
    const desiredTargets: QueueTarget[] = [];
    for (const arn of desired.Queues) {
      const current = await target(arn);
      if (current.policy && !existingByArn.has(arn)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Queue ${arn} already has a policy not owned by this stack resource` };
      desiredTargets.push(current);
    }
    const wantedPolicy = attachedPolicy(desired, context);
    const desiredArns = new Set(desired.Queues);
    await mutate([
      ...desiredTargets.map(item => ({ target: item, policy: wantedPolicy })),
      ...existing.filter(item => !desiredArns.has(item.arn)).map(item => ({ target: item, policy: "" })),
    ]);
    return success(currentPhysicalId, (await describe(currentPhysicalId, context))!);
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
      // path accepts only the exact local queue ARNs emitted by model().
      const internalQueues = Array.isArray(properties.Queues)
        && properties.Queues.length > 0
        && properties.Queues.every(value => parseQueueArn(value, context) !== undefined);
      const validationInput = internalQueues
        ? {
            ...properties,
            Queues: (properties.Queues as unknown[]).map(value => {
              const parsed = parseQueueArn(value, context)!;
              return `https://sqs.${context.region}.amazonaws.com/${context.accountId}/${parsed.name}`;
            }),
          }
        : properties;
      const issues = validation(validationInput, context);
      if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return model(properties, context);
    },
    plan(previous: SqsQueuePolicyModel | undefined, desired: SqsQueuePolicyModel): ProviderPlan<SqsQueuePolicyModel> {
      return cfn10Plan(previous as SqsQueuePolicyModel & Record<string, unknown> | undefined, desired as SqsQueuePolicyModel & Record<string, unknown>, SQS_QUEUE_POLICY_SCHEMA) as ProviderPlan<SqsQueuePolicyModel>;
    },
    async create(desired: SqsQueuePolicyModel, context: ProviderContext) {
      try {
        const id = physicalId(context);
        const existing = await describe(id, context);
        if (existing) return await reconcile(id, desired, context);
        const targets: QueueTarget[] = [];
        for (const arn of desired.Queues) {
          const current = await target(arn);
          if (current.policy) return { status: "FAILED", errorCode: "AlreadyExists", message: `Queue ${arn} already has a policy not owned by this stack resource` };
          targets.push(current);
        }
        await mutate(targets.map(item => ({ target: item, policy: attachedPolicy(desired, context) })));
        return success(id, (await describe(id, context))!);
      } catch (error) {
        return cfn10Failure(error);
      }
    },
    async read(currentPhysicalId: string, context: ProviderContext): Promise<ProviderReadResult<SqsQueuePolicyModel>> {
      try {
        const current = await describe(currentPhysicalId, context);
        return current ? success(currentPhysicalId, current) : { status: "NOT_FOUND", physicalId: currentPhysicalId };
      } catch (error) {
        return cfn10Failure(error);
      }
    },
    async update(currentPhysicalId: string, _previous: SqsQueuePolicyModel, desired: SqsQueuePolicyModel, context: ProviderContext): Promise<ProviderUpdateResult<SqsQueuePolicyModel>> {
      try { return await reconcile(currentPhysicalId, desired, context); }
      catch (error) { return cfn10Failure(error); }
    },
    async delete(currentPhysicalId: string, _previous: SqsQueuePolicyModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        if (currentPhysicalId !== physicalId(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: "QueuePolicy physical ID is not owned by this stack resource" };
        const targets = await ownedTargets(context);
        if (!targets.length) return { status: "NOT_FOUND", physicalId: currentPhysicalId };
        await mutate(targets.map(item => ({ target: item, policy: "" })), true);
        return { status: "SUCCESS", physicalId: currentPhysicalId };
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
