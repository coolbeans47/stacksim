import { providerValidationPathSegments } from "./contract.js";
import { createHash } from "node:crypto";
import type { CloudWatchLogsService } from "../../cloudwatch-logs.js";
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

export const LOG_GROUP_TYPE = "AWS::Logs::LogGroup";
const RETENTION_DAYS = new Set([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653]);

export interface LogGroupModel {
  readonly LogGroupName: string;
  readonly RetentionInDays?: number;
  readonly Tags?: readonly { readonly Key: string; readonly Value: string }[];
}

export const LOG_GROUP_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LOG_GROUP_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    LogGroupName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    RetentionInDays: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Log group name" }),
  attributes: Object.freeze({ Arn: Object.freeze({ valueType: "string", description: "Log group ARN ending in :*" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: Object.freeze({ deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), snapshotSupported: false }),
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stackName(context: ProviderContext): string { return context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack"; }
function generatedName(context: ProviderContext): string {
  const hash = createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex").slice(0, 12);
  return `/stacksim/cloudformation/${stackName(context)}/${context.logicalId}-${hash}`.slice(0, 512);
}
function tags(value: unknown): readonly { Key: string; Value: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("Tags must be an array");
  const result = value.map(item => { if (!record(item) || typeof item.Key !== "string" || typeof item.Value !== "string") throw new TypeError("Each tag requires string Key and Value"); return { Key: item.Key, Value: item.Value }; }).sort((a, b) => a.Key.localeCompare(b.Key));
  if (new Set(result.map(item => item.Key)).size !== result.length || result.length > 47 || result.some(item => !item.Key || item.Key.toLowerCase().startsWith("aws:"))) throw new TypeError("Tags require unique non-aws: keys and contain at most 47 entries after reserving CloudFormation ownership tags");
  return result;
}
function tagMap(model: LogGroupModel, context: ProviderContext): Record<string, string> {
  return { ...Object.fromEntries((model.Tags ?? []).map(tag => [tag.Key, tag.Value])), "aws:cloudformation:stack-id": context.stackId, "aws:cloudformation:stack-name": stackName(context), "aws:cloudformation:logical-id": context.logicalId };
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function success(model: LogGroupModel, arn: string): ProviderSuccess<LogGroupModel> { return { status: "SUCCESS", physicalId: model.LogGroupName, model: { physicalId: model.LogGroupName, properties: model, attributes: { Arn: arn } } }; }
function failed(error: unknown): ProviderUpdateResult<LogGroupModel> { const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500); return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 }; }
function notFound(error: unknown): boolean { return error instanceof AwsError && error.code === "ResourceNotFoundException"; }

export function createLogGroupProvider(logs: CloudWatchLogsService): ProductionResourceProvider<LogGroupModel> {
  const find = async (name: string): Promise<any | undefined> => (await logs.DescribeLogGroups({ logGroupNamePrefix: name, limit: 50 })).logGroups.find((group: any) => group.logGroupName === name);
  const reconcile = async (desired: LogGroupModel, context: ProviderContext): Promise<ProviderUpdateResult<LogGroupModel>> => {
    let group = await find(desired.LogGroupName);
    if (!group) return { status: "FAILED", errorCode: "NotFound", message: `Log group ${desired.LogGroupName} no longer exists` };
    let currentTags = (await logs.ListTagsForResource({ resourceArn: group.arn })).tags ?? {};
    if (currentTags["aws:cloudformation:stack-id"] !== context.stackId || currentTags["aws:cloudformation:logical-id"] !== context.logicalId) {
      return { status: "FAILED", errorCode: "OwnershipConflict", message: `Log group ${desired.LogGroupName} is not owned by this stack resource` };
    }
    if (group.retentionInDays !== desired.RetentionInDays) {
      if (desired.RetentionInDays === undefined) await logs.DeleteRetentionPolicy({ logGroupName: desired.LogGroupName });
      else await logs.PutRetentionPolicy({ logGroupName: desired.LogGroupName, retentionInDays: desired.RetentionInDays });
    }
    const wanted = tagMap(desired, context);
    const remove = Object.keys(currentTags).filter(key => !Object.hasOwn(wanted, key));
    if (remove.length) await logs.UntagResource({ resourceArn: group.arn, tagKeys: remove });
    const additions = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => currentTags[key] !== value));
    if (Object.keys(additions).length) await logs.TagResource({ resourceArn: group.arn, tags: additions });
    group = await find(desired.LogGroupName);
    currentTags = (await logs.ListTagsForResource({ resourceArn: group.arn })).tags ?? {};
    const model: LogGroupModel = {
      LogGroupName: desired.LogGroupName,
      ...(group.retentionInDays !== undefined ? { RetentionInDays: Number(group.retentionInDays) } : {}),
      ...(desired.Tags !== undefined ? { Tags: Object.entries(currentTags).filter(([key]) => !key.startsWith("aws:cloudformation:")).map(([Key, Value]) => ({ Key, Value: String(Value) })).sort((left, right) => left.Key.localeCompare(right.Key)) } : {}),
    };
    return success(model, group.arn);
  };
  return {
    typeName: LOG_GROUP_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: LOG_GROUP_SCHEMA,
    validate(properties: unknown): readonly ProviderValidationIssue[] {
      const issues = validateDeclaredProperties(properties ?? {}, LOG_GROUP_SCHEMA);
      if (!record(properties)) return issues;
      if (properties.LogGroupName !== undefined && (typeof properties.LogGroupName !== "string" || !/^[.\-_/#A-Za-z0-9]{1,512}$/.test(properties.LogGroupName) || properties.LogGroupName.startsWith("aws/"))) issues.push({ code: "InvalidProperty", path: "Properties.LogGroupName", pathSegments: providerValidationPathSegments("Properties.LogGroupName"), message: "LogGroupName must be a valid 1-512 character group name outside the reserved aws/ prefix" });
      if (properties.RetentionInDays !== undefined && (!Number.isInteger(properties.RetentionInDays) || !RETENTION_DAYS.has(Number(properties.RetentionInDays)))) issues.push({ code: "InvalidProperty", path: "Properties.RetentionInDays", pathSegments: providerValidationPathSegments("Properties.RetentionInDays"), message: "RetentionInDays is not supported by the Logs service" });
      try { tags(properties.Tags); } catch (error) { issues.push({ code: "InvalidProperty", path: "Properties.Tags", pathSegments: providerValidationPathSegments("Properties.Tags"), message: error instanceof Error ? error.message : String(error) }); }
      return issues;
    },
    canonicalize(properties: unknown, context: ProviderContext): LogGroupModel {
      if (!record(properties)) throw new TypeError(`${LOG_GROUP_TYPE} Properties must be an object`);
      const issues = this.validate(properties, context); if (issues.length) throw new TypeError(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
      return { LogGroupName: String(properties.LogGroupName ?? generatedName(context)), ...(properties.RetentionInDays !== undefined ? { RetentionInDays: Number(properties.RetentionInDays) } : {}), ...(properties.Tags !== undefined ? { Tags: tags(properties.Tags)! } : {}) };
    },
    plan(previous: LogGroupModel | undefined, desired: LogGroupModel): ProviderPlan<LogGroupModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const changed = (["LogGroupName", "RetentionInDays", "Tags"] as const).filter(key => !same(previous[key], desired[key]));
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      return changed.includes("LogGroupName") ? { action: "REPLACE", desired, changedProperties: changed, replacementProperties: ["LogGroupName"], replacementOrder: "CREATE_BEFORE_DELETE" } : { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
    },
    async create(desired: LogGroupModel, context: ProviderContext) {
      try {
        const existing = await find(desired.LogGroupName);
        if (existing) {
          const existingTags = (await logs.ListTagsForResource({ resourceArn: existing.arn })).tags ?? {};
          if (existingTags["aws:cloudformation:stack-id"] !== context.stackId || existingTags["aws:cloudformation:logical-id"] !== context.logicalId) return { status: "FAILED", errorCode: "AlreadyExists", message: `Log group ${desired.LogGroupName} already exists and is not owned by this stack resource` };
          return await reconcile(desired, context);
        }
        await logs.CreateLogGroup({ logGroupName: desired.LogGroupName, tags: tagMap(desired, context) });
        return await reconcile(desired, context);
      } catch (error) { return failed(error); }
    },
    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<LogGroupModel>> {
      try {
        const group = await find(physicalId); if (!group) return { status: "NOT_FOUND", physicalId };
        const currentTags = (await logs.ListTagsForResource({ resourceArn: group.arn })).tags ?? {};
        if (currentTags["aws:cloudformation:stack-id"] !== context.stackId || currentTags["aws:cloudformation:logical-id"] !== context.logicalId) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Log group ${physicalId} is not owned by this stack resource` };
        const model: LogGroupModel = { LogGroupName: physicalId, ...(group.retentionInDays !== undefined ? { RetentionInDays: group.retentionInDays } : {}), Tags: Object.entries(currentTags).filter(([key]) => !key.startsWith("aws:cloudformation:")).map(([Key, Value]) => ({ Key, Value: String(Value) })).sort((a, b) => a.Key.localeCompare(b.Key)) };
        return success(model, group.arn);
      } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderReadResult<LogGroupModel>; }
    },
    async update(physicalId: string, _previous: LogGroupModel, desired: LogGroupModel, context: ProviderContext): Promise<ProviderUpdateResult<LogGroupModel>> {
      try {
        if (physicalId !== desired.LogGroupName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "LogGroupName changes require replacement" };
        return await reconcile(desired, context);
      } catch (error) { return failed(error); }
    },
    async delete(physicalId: string, _previous: LogGroupModel, context: ProviderContext): Promise<ProviderDeleteResult> { try { const group = await find(physicalId); if (!group) return { status: "NOT_FOUND", physicalId }; const ownership = (await logs.ListTagsForResource({ resourceArn: group.arn })).tags ?? {}; if (ownership["aws:cloudformation:stack-id"] !== context.stackId || ownership["aws:cloudformation:logical-id"] !== context.logicalId) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Log group ${physicalId} is not owned by this stack resource` }; await logs.DeleteLogGroup({ logGroupName: physicalId }); return { status: "SUCCESS", physicalId }; } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult; } },
    ref(model: ProviderReadModel<LogGroupModel>): unknown { return model.physicalId; },
    getAtt(model: ProviderReadModel<LogGroupModel>, attribute: string): unknown { if (attribute === "Arn") return model.attributes.Arn; throw new ProviderReferenceError(LOG_GROUP_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}
