import { AwsError } from "../../errors.js";
import type { StepFunctionsService } from "../../step-functions.js";
import {
  ProviderReferenceError, providerValidationPathSegments, validateDeclaredProperties,
  type ProductionResourceProvider, type ProviderContext, type ProviderFailed,
  type ProviderInProgress, type ProviderSchema, type ProviderSuccess,
} from "./contract.js";

export const STEP_FUNCTIONS_ACTIVITY_TYPE = "AWS::StepFunctions::Activity";

export interface StepFunctionsActivityModel {
  readonly Name: string;
  readonly EncryptionConfiguration: { readonly Type: "AWS_OWNED_KEY" };
  readonly Tags: readonly { readonly Key: string; readonly Value: string }[];
}

export const STEP_FUNCTIONS_ACTIVITY_SCHEMA: ProviderSchema = Object.freeze({
  typeName: STEP_FUNCTIONS_ACTIVITY_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Name: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    EncryptionConfiguration: Object.freeze({ valueType: "object", updateBehavior: "REPLACEMENT" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Activity ARN" }),
  attributes: Object.freeze({
    Arn: Object.freeze({ valueType: "string", description: "Activity ARN" }),
    Name: Object.freeze({ valueType: "string", description: "Activity name" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: Object.freeze({
    deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    snapshotSupported: false,
  }),
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function canonicalTags(value: unknown): StepFunctionsActivityModel["Tags"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("Tags must be an array");
  const result = value.map(item => {
    if (!record(item) || Object.keys(item).some(key => key !== "Key" && key !== "Value")
      || typeof item.Key !== "string" || !item.Key || item.Key.length > 128
      || typeof item.Value !== "string" || item.Value.length > 256) throw new TypeError("Each tag requires a 1-128 character Key and a string Value of at most 256 characters");
    return { Key: item.Key, Value: item.Value };
  }).sort((left, right) => left.Key.localeCompare(right.Key));
  if (result.length > 47 || new Set(result.map(tag => tag.Key)).size !== result.length || result.some(tag => tag.Key.toLowerCase().startsWith("aws:"))) throw new TypeError("Tags require unique non-aws: keys and at most 47 entries, reserving three CloudFormation ownership tags");
  return result;
}
function ownerTags(model: StepFunctionsActivityModel, context: ProviderContext): Record<string, string> {
  return {
    ...Object.fromEntries(model.Tags.map(tag => [tag.Key, tag.Value])),
    "aws:cloudformation:stack-id": context.stackId,
    "aws:cloudformation:stack-name": context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack",
    "aws:cloudformation:logical-id": context.logicalId,
  };
}
function owned(tags: Record<string, string>, context: ProviderContext): boolean {
  return tags["aws:cloudformation:stack-id"] === context.stackId && tags["aws:cloudformation:logical-id"] === context.logicalId;
}
function arnFor(model: StepFunctionsActivityModel, context: ProviderContext): string { return `arn:${context.partition}:states:${context.region}:${context.accountId}:activity:${model.Name}`; }
function missing(error: unknown): boolean { return error instanceof AwsError && error.code === "ActivityDoesNotExist"; }
function failure(error: unknown): ProviderFailed {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}
function pending(physicalId: string, phase: string, generation: string): ProviderInProgress {
  return { status: "IN_PROGRESS", callbackAfterMs: 1, checkpoint: { schemaVersion: 1, physicalId, callbackContext: { phase, generation } } };
}

/** Uses the public Activity/tag APIs; only a bounded generation reference is private. */
export function createStepFunctionsActivityProvider(service: StepFunctionsService): ProductionResourceProvider<StepFunctionsActivityModel> {
  const describe = async (arn: string): Promise<any | undefined> => {
    try { return await service.DescribeActivity({ activityArn: arn }); } catch (error) { if (missing(error)) return undefined; throw error; }
  };
  const tags = async (arn: string): Promise<Record<string, string>> => Object.fromEntries((await service.ListTagsForResource({ resourceArn: arn })).tags.map((tag: any) => [tag.key, tag.value]));
  const readOwned = async (arn: string, context: ProviderContext) => {
    const activity = await describe(arn);
    if (!activity) return undefined;
    const currentTags = await tags(arn);
    if (!owned(currentTags, context)) throw new AwsError("OwnershipConflict", `Activity ${arn} is not owned by this stack resource`, 409);
    const generation = service.cloudFormationResourceGeneration(arn);
    const expected = context.callbackContext?.generation ?? context.resourceGeneration;
    if (!generation || expected !== undefined && expected !== generation) throw new AwsError("OwnershipConflict", `Activity ${arn} was deleted and recreated with a different generation`, 409);
    return { activity, tags: currentTags, generation };
  };
  const success = (current: NonNullable<Awaited<ReturnType<typeof readOwned>>>): ProviderSuccess<StepFunctionsActivityModel> => ({
    status: "SUCCESS", physicalId: current.activity.activityArn,
    model: {
      physicalId: current.activity.activityArn,
      properties: { Name: current.activity.name, EncryptionConfiguration: { Type: "AWS_OWNED_KEY" }, Tags: Object.entries(current.tags).filter(([key]) => !key.startsWith("aws:cloudformation:")).map(([Key, Value]) => ({ Key, Value })).sort((left, right) => left.Key.localeCompare(right.Key)) },
      attributes: { Arn: current.activity.activityArn, Name: current.activity.name, StackSimResourceGeneration: current.generation },
    },
  });
  const reconcile = async (arn: string, desired: StepFunctionsActivityModel, context: ProviderContext) => {
    const current = await readOwned(arn, context);
    if (!current) return { status: "FAILED" as const, errorCode: "NotFound", message: `Activity ${arn} no longer exists` };
    const wanted = ownerTags(desired, context);
    const removals = Object.keys(current.tags).filter(key => !Object.hasOwn(wanted, key));
    if (removals.length) { await service.UntagResource({ resourceArn: arn, tagKeys: removals }); return pending(arn, "after-untag", current.generation); }
    const additions = Object.entries(wanted).filter(([key, value]) => current.tags[key] !== value).map(([key, value]) => ({ key, value }));
    if (additions.length) { await service.TagResource({ resourceArn: arn, tags: additions }); return pending(arn, "after-tag", current.generation); }
    return success(current);
  };
  return {
    typeName: STEP_FUNCTIONS_ACTIVITY_TYPE, providerVersion: 1, visibility: "production", schema: STEP_FUNCTIONS_ACTIVITY_SCHEMA,
    validate(properties, _context) {
      const issues = validateDeclaredProperties(properties ?? {}, STEP_FUNCTIONS_ACTIVITY_SCHEMA);
      if (!record(properties)) return issues;
      const add = (code: "InvalidProperty" | "UnsupportedProperty", path: string, message: string) => issues.push({ code, path, pathSegments: providerValidationPathSegments(path), message });
      if (properties.Name !== undefined && (typeof properties.Name !== "string" || !properties.Name || [...properties.Name].length > 80 || /[\s<>{}\[\]?*"#%\\^|~`$&,;:/\u0000-\u001f\u007f-\u009f\ufffe\uffff\ud800-\udfff\u{10ffff}]/u.test(properties.Name))) add("InvalidProperty", "Properties.Name", "Name must contain 1-80 characters without whitespace, control characters, or reserved Activity name characters");
      try { canonicalTags(properties.Tags); } catch (error) { add("InvalidProperty", "Properties.Tags", error instanceof Error ? error.message : String(error)); }
      const encryption = properties.EncryptionConfiguration;
      if (encryption !== undefined && (!record(encryption) || Object.keys(encryption).some(key => key !== "Type") || encryption.Type !== "AWS_OWNED_KEY")) add("UnsupportedProperty", "Properties.EncryptionConfiguration", "Only AWS_OWNED_KEY encryption is supported; customer-managed encryption requires KMS");
      return issues;
    },
    canonicalize(properties, context) {
      const issues = this.validate(properties, context);
      if (issues.length || !record(properties)) throw new TypeError(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
      return { Name: String(properties.Name), EncryptionConfiguration: { Type: "AWS_OWNED_KEY" }, Tags: canonicalTags(properties.Tags) };
    },
    plan(previous, desired) {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const changed = (["Name", "EncryptionConfiguration", "Tags"] as const).filter(key => JSON.stringify(previous[key]) !== JSON.stringify(desired[key]));
      const replacement = changed.filter(key => key !== "Tags");
      return { action: !changed.length ? "NO_OP" : replacement.length ? "REPLACE" : "UPDATE", desired, changedProperties: changed, replacementProperties: replacement, ...(replacement.length ? { replacementOrder: "CREATE_BEFORE_DELETE" as const } : {}) };
    },
    async create(desired, context) {
      const arn = arnFor(desired, context);
      try {
        if (await describe(arn)) {
          if (!owned(await tags(arn), context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Activity ${arn} already exists and is not owned by this stack resource` };
          return await reconcile(arn, desired, context);
        }
        if (context.callbackContext?.generation) return { status: "FAILED", errorCode: "NotFound", message: `Activity ${arn} was deleted during creation` };
        await service.CreateActivity({ name: desired.Name, encryptionConfiguration: { type: "AWS_OWNED_KEY" }, tags: Object.entries(ownerTags(desired, context)).map(([key, value]) => ({ key, value })) });
        // CreateActivity itself is idempotent by name: confirm ownership after it returns.
        const current = await readOwned(arn, context);
        if (!current) throw new AwsError("NotFound", `Activity ${arn} disappeared during creation`, 404);
        return pending(arn, "after-create", current.generation);
      } catch (error) { return failure(error); }
    },
    async read(physicalId, context) {
      try { const current = await readOwned(physicalId, context); return current ? success(current) : { status: "NOT_FOUND", physicalId }; } catch (error) { return failure(error); }
    },
    async update(physicalId, _previous, desired, context) {
      if (physicalId !== arnFor(desired, context)) return { status: "FAILED", errorCode: "RequiresReplacement", message: "Activity Name changes require replacement" };
      try { return await reconcile(physicalId, desired, context); } catch (error) { return failure(error); }
    },
    async delete(physicalId, _previous, context) {
      try {
        const current = await readOwned(physicalId, context);
        if (!current) return { status: "NOT_FOUND", physicalId };
        if (context.callbackContext?.phase !== "before-delete") return pending(physicalId, "before-delete", current.generation);
        await service.DeleteActivity({ activityArn: physicalId });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return failure(error); }
    },
    ref(model) { return model.physicalId; },
    getAtt(model, attribute) {
      if (attribute === "Arn" || attribute === "Name") return model.attributes[attribute];
      throw new ProviderReferenceError(STEP_FUNCTIONS_ACTIVITY_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}
