import type { EventBridgeService } from "../../eventbridge.js";
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

export const EVENT_BUS_TYPE = "AWS::Events::EventBus";
export const EVENT_RULE_TYPE = "AWS::Events::Rule";

export interface EventBusModel {
  readonly Name: string;
  readonly Tags: readonly Cfn09Tag[];
}

export interface EventRuleInputTransformerModel {
  readonly InputPathsMap?: Readonly<Record<string, string>>;
  readonly InputTemplate: string;
}

export interface EventRuleRetryPolicyModel {
  readonly MaximumEventAgeInSeconds: number;
  readonly MaximumRetryAttempts: number;
}

export interface EventRuleTargetModel {
  readonly Arn: string;
  readonly Id: string;
  readonly Input?: string;
  readonly InputPath?: string;
  readonly InputTransformer?: EventRuleInputTransformerModel;
  readonly RetryPolicy?: EventRuleRetryPolicyModel;
}

export interface EventRuleModel {
  readonly Name: string;
  readonly EventBusName: string;
  readonly EventPattern: Readonly<Record<string, unknown>>;
  readonly Description?: string;
  readonly State: "ENABLED" | "DISABLED" | "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS";
  readonly Tags: readonly Cfn09Tag[];
  readonly Targets: readonly EventRuleTargetModel[];
}

export const EVENT_BUS_SCHEMA: ProviderSchema = Object.freeze({
  typeName: EVENT_BUS_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Name: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Event bus name" }),
  attributes: Object.freeze({
    Arn: Object.freeze({ valueType: "string", description: "Event bus ARN" }),
    Name: Object.freeze({ valueType: "string", description: "Event bus name" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: CFN09_RETENTION,
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

export const EVENT_RULE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: EVENT_RULE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    EventBusName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT", description: "CFN-09 pins bus moves to replacement because PutRule cannot move an existing rule." }),
    EventPattern: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    Name: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    State: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    Targets: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Event rule name" }),
  attributes: Object.freeze({ Arn: Object.freeze({ valueType: "string", description: "Event rule ARN" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: CFN09_RETENTION,
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

function eventTags(tags: readonly Cfn09Tag[], context: ProviderContext): Array<{ Key: string; Value: string }> {
  return Object.entries(tagMap(tags, context)).map(([Key, Value]) => ({ Key, Value })).sort((left, right) => left.Key.localeCompare(right.Key));
}

function validateEventBus(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, EVENT_BUS_SCHEMA);
  if (!isRecord(properties)) return issues;
  if (typeof properties.Name === "string" && (!/^[._A-Za-z0-9-]{1,256}$/.test(properties.Name) || properties.Name === "default")) issue(issues, "Properties.Name", "Name must be a valid custom event-bus name other than default; partner buses belong to a later EventBridge phase");
  if (properties.Tags !== undefined) validateTags(properties.Tags, "Properties.Tags", issues);
  return issues;
}

function busSuccess(model: EventBusModel, arn: string): ProviderSuccess<EventBusModel> {
  return { status: "SUCCESS", physicalId: arn, model: { physicalId: arn, properties: model, attributes: { Arn: arn, Name: model.Name } } };
}

export function createEventBusProvider(events: EventBridgeService): ProductionResourceProvider<EventBusModel> {
  const describe = async (identifier: string): Promise<{ model: EventBusModel; arn: string; tags: Readonly<Record<string, string>> }> => {
    const bus = await events.DescribeEventBus({ Name: identifier });
    const listed = await events.ListTagsForResource({ ResourceARN: bus.Arn });
    const tags = Object.fromEntries((listed.Tags ?? []).map((tag: any) => [String(tag.Key), String(tag.Value)]));
    return { model: { Name: String(bus.Name), Tags: visibleTags(tags) }, arn: String(bus.Arn), tags };
  };
  const reconcile = async (physicalId: string, desired: EventBusModel, context: ProviderContext): Promise<ProviderUpdateResult<EventBusModel>> => {
    const current = await describe(physicalId);
    if (!owns(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Event bus ${current.model.Name} is not owned by this stack resource` };
    if (current.model.Name !== desired.Name) return { status: "FAILED", errorCode: "RequiresReplacement", message: "Event bus Name changes require replacement" };
    const wanted = tagMap(desired.Tags, context);
    const removals = Object.keys(current.tags).filter(key => key !== "stacksim:cloudformation:owner" && !Object.hasOwn(wanted, key));
    if (removals.length) await events.UntagResource({ ResourceARN: current.arn, TagKeys: removals });
    const additions = Object.entries(wanted).filter(([key, value]) => current.tags[key] !== value).map(([Key, Value]) => ({ Key, Value }));
    if (additions.length) await events.TagResource({ ResourceARN: current.arn, Tags: additions });
    const updated = await describe(physicalId);
    return busSuccess(updated.model, updated.arn);
  };
  return {
    typeName: EVENT_BUS_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: EVENT_BUS_SCHEMA,
    validate(properties: unknown): readonly ProviderValidationIssue[] { return validateEventBus(properties); },
    canonicalize(properties: unknown): EventBusModel {
      if (!isRecord(properties)) throw new TypeError(`${EVENT_BUS_TYPE} Properties must be an object`);
      const issues = validateEventBus(properties); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return { Name: String(properties.Name), Tags: canonicalTags(properties.Tags) };
    },
    plan(previous: EventBusModel | undefined, desired: EventBusModel): ProviderPlan<EventBusModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const changed = changedProperties(previous, desired);
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      if (previous.Name !== desired.Name) return { action: "REPLACE", desired, changedProperties: changed, replacementProperties: ["Name"], replacementOrder: "CREATE_BEFORE_DELETE" };
      return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
    },
    async create(desired: EventBusModel, context: ProviderContext) {
      try {
        try {
          const existing = await describe(desired.Name);
          if (!owns(existing.tags, context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Event bus ${desired.Name} already exists and is not owned by this stack resource` };
          return await reconcile(existing.arn, desired, context);
        } catch (error) { if (!isNotFound(error, ["ResourceNotFoundException"])) throw error; }
        const created = await events.CreateEventBus({ Name: desired.Name, Tags: eventTags(desired.Tags, context) });
        const current = await describe(String(created.EventBusArn));
        return busSuccess(current.model, current.arn);
      } catch (error) { return providerFailure(error); }
    },
    async read(physicalId: string): Promise<ProviderReadResult<EventBusModel>> {
      try { const current = await describe(physicalId); return busSuccess(current.model, current.arn); }
      catch (error) { return isNotFound(error, ["ResourceNotFoundException"]) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    async update(physicalId: string, _previous: EventBusModel, desired: EventBusModel, context: ProviderContext): Promise<ProviderUpdateResult<EventBusModel>> {
      try { return await reconcile(physicalId, desired, context); } catch (error) { return providerFailure(error); }
    },
    async delete(physicalId: string, _previous: EventBusModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const current = await describe(physicalId);
        if (!owns(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Event bus ${current.model.Name} is not owned by this stack resource` };
        await events.DeleteEventBus({ Name: physicalId });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isNotFound(error, ["ResourceNotFoundException"]) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    ref(current: ProviderReadModel<EventBusModel>): unknown { return current.properties.Name; },
    getAtt(current: ProviderReadModel<EventBusModel>, attribute: string): unknown {
      if (attribute === "Arn" || attribute === "Name") return current.attributes[attribute];
      throw new ProviderReferenceError(EVENT_BUS_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}

function canonicalBusName(value: unknown, context: ProviderContext): string {
  const supplied = value === undefined || value === "" ? "default" : String(value);
  const match = /^arn:aws:events:([^:]+):(\d{12}):event-bus\/(.+)$/.exec(supplied);
  if (!match) return supplied;
  if (match[1] !== context.region || match[2] !== context.accountId) return supplied;
  return match[3];
}

function generatedRuleName(context: ProviderContext): string {
  return stableName(context, 64, /[._A-Za-z0-9-]/, "rule");
}

function validateInputTransformer(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!isRecord(value)) return;
  exactKeys(value, ["InputPathsMap", "InputTemplate"], path, issues);
  if (typeof value.InputTemplate !== "string" || !value.InputTemplate || Buffer.byteLength(value.InputTemplate) > 8_192) issue(issues, `${path}.InputTemplate`, "InputTemplate must be a nonempty string no larger than 8192 bytes");
  if (value.InputPathsMap !== undefined) {
    if (!isRecord(value.InputPathsMap)) issue(issues, `${path}.InputPathsMap`, "InputPathsMap must be an object");
    else {
      if (Object.keys(value.InputPathsMap).length > 100) issue(issues, `${path}.InputPathsMap`, "InputPathsMap can contain at most 100 entries");
      for (const [name, rawPath] of Object.entries(value.InputPathsMap)) {
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(name)) issue(issues, `${path}.InputPathsMap.${name}`, "Input transformer variable names must contain 1-256 supported characters");
        if (typeof rawPath !== "string" || !rawPath.startsWith("$") || rawPath.length > 256) issue(issues, `${path}.InputPathsMap.${name}`, "Input transformer paths must be JSONPath strings of at most 256 characters");
      }
    }
  }
}

function validateRetryPolicy(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!isRecord(value)) return;
  exactKeys(value, ["MaximumEventAgeInSeconds", "MaximumRetryAttempts"], path, issues);
  if (value.MaximumEventAgeInSeconds !== undefined && (!Number.isInteger(value.MaximumEventAgeInSeconds) || Number(value.MaximumEventAgeInSeconds) < 60 || Number(value.MaximumEventAgeInSeconds) > 86_400)) issue(issues, `${path}.MaximumEventAgeInSeconds`, "MaximumEventAgeInSeconds must be an integer between 60 and 86400");
  if (value.MaximumRetryAttempts !== undefined && (!Number.isInteger(value.MaximumRetryAttempts) || Number(value.MaximumRetryAttempts) < 0 || Number(value.MaximumRetryAttempts) > 185)) issue(issues, `${path}.MaximumRetryAttempts`, "MaximumRetryAttempts must be an integer between 0 and 185");
}

function validateTargets(value: unknown, context: ProviderContext, issues: ProviderValidationIssue[]): void {
  if (!Array.isArray(value)) return;
  if (value.length > 5) issue(issues, "Properties.Targets", "A CFN-09 EventBridge rule can contain at most five Lambda targets");
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const path = `Properties.Targets.${index}`;
    if (!isRecord(raw)) { issue(issues, path, "Each target must be an object"); continue; }
    exactKeys(raw, ["Arn", "Id", "Input", "InputPath", "InputTransformer", "RetryPolicy"], path, issues);
    if (typeof raw.Id !== "string" || !/^[._A-Za-z0-9-]{1,64}$/.test(raw.Id)) issue(issues, `${path}.Id`, "Id must contain 1-64 supported characters");
    else if (ids.has(raw.Id)) issue(issues, `${path}.Id`, "Target IDs must be unique"); else ids.add(raw.Id);
    const arn = typeof raw.Arn === "string" ? /^arn:aws:lambda:([^:]+):(\d{12}):function:[A-Za-z0-9-_]{1,64}(?::[A-Za-z0-9-_.$]+)?$/.exec(raw.Arn) : undefined;
    if (!arn || arn[1] !== context.region || arn[2] !== context.accountId) issue(issues, `${path}.Arn`, "CFN-09 rule targets must identify a Lambda function in this simulator account and Region; other target families belong to later EventBridge phases");
    const selectors = [raw.Input, raw.InputPath, raw.InputTransformer].filter(item => item !== undefined);
    if (selectors.length > 1) issue(issues, path, "Input, InputPath, and InputTransformer are mutually exclusive");
    if (raw.Input !== undefined) {
      if (typeof raw.Input !== "string" || Buffer.byteLength(raw.Input) > 8_192) issue(issues, `${path}.Input`, "Input must be JSON text no larger than 8192 bytes");
      else try { JSON.parse(raw.Input); } catch { issue(issues, `${path}.Input`, "Input must contain valid JSON"); }
    }
    if (raw.InputPath !== undefined && (typeof raw.InputPath !== "string" || !raw.InputPath.startsWith("$") || raw.InputPath.length > 256)) issue(issues, `${path}.InputPath`, "InputPath must be a JSONPath string of at most 256 characters");
    if (raw.InputTransformer !== undefined) validateInputTransformer(raw.InputTransformer, `${path}.InputTransformer`, issues);
    if (raw.RetryPolicy !== undefined) validateRetryPolicy(raw.RetryPolicy, `${path}.RetryPolicy`, issues);
  }
}

function validateRule(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, EVENT_RULE_SCHEMA);
  if (!isRecord(properties)) return issues;
  if (properties.Name !== undefined && (typeof properties.Name !== "string" || !/^[._A-Za-z0-9-]{1,64}$/.test(properties.Name))) issue(issues, "Properties.Name", "Name must contain 1-64 supported rule-name characters");
  if (properties.EventBusName !== undefined) {
    const bus = canonicalBusName(properties.EventBusName, context);
    if (!/^[._A-Za-z0-9-]{1,256}$/.test(bus)) issue(issues, "Properties.EventBusName", "EventBusName must identify the default or a custom event bus in this simulator account and Region");
  }
  if (properties.Description !== undefined && (typeof properties.Description !== "string" || [...properties.Description].length > 512)) issue(issues, "Properties.Description", "Description must not exceed 512 characters");
  if (isRecord(properties.EventPattern) && (!Object.keys(properties.EventPattern).length || Buffer.byteLength(JSON.stringify(properties.EventPattern)) > 4_096)) issue(issues, "Properties.EventPattern", "EventPattern must be a nonempty JSON object no larger than 4096 bytes");
  if (properties.State !== undefined && !["ENABLED", "DISABLED", "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS"].includes(String(properties.State))) issue(issues, "Properties.State", "State must be ENABLED, DISABLED, or ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS");
  if (properties.Tags !== undefined) validateTags(properties.Tags, "Properties.Tags", issues);
  if (properties.Targets !== undefined) validateTargets(properties.Targets, context, issues);
  return issues;
}

function canonicalTarget(value: Record<string, unknown>): EventRuleTargetModel {
  const transformer = isRecord(value.InputTransformer) ? {
    InputTemplate: String(value.InputTransformer.InputTemplate),
    ...(isRecord(value.InputTransformer.InputPathsMap) ? { InputPathsMap: Object.fromEntries(Object.entries(value.InputTransformer.InputPathsMap).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, String(item)])) } : {}),
  } : undefined;
  const retry = isRecord(value.RetryPolicy) ? {
    MaximumEventAgeInSeconds: Number(value.RetryPolicy.MaximumEventAgeInSeconds ?? 86_400),
    MaximumRetryAttempts: Number(value.RetryPolicy.MaximumRetryAttempts ?? 185),
  } : undefined;
  return {
    Arn: String(value.Arn), Id: String(value.Id),
    ...(value.Input !== undefined ? { Input: String(value.Input) } : {}),
    ...(value.InputPath !== undefined ? { InputPath: String(value.InputPath) } : {}),
    ...(transformer ? { InputTransformer: transformer } : {}),
    ...(retry ? { RetryPolicy: retry } : {}),
  };
}

function targetFromView(value: Record<string, unknown>, context: ProviderContext): EventRuleTargetModel {
  const supported = new Set(["Arn", "Id", "Input", "InputPath", "InputTransformer", "RetryPolicy"]);
  const unsupported = Object.keys(value).filter(key => !supported.has(key)).sort();
  if (unsupported.length) throw new AwsError("UnsupportedResourceState", `EventBridge target ${String(value.Id)} uses unsupported fields: ${unsupported.join(", ")}`, 409);
  const arn = typeof value.Arn === "string" ? /^arn:([^:]+):lambda:([^:]+):(\d{12}):function:[A-Za-z0-9-_]{1,64}(?::[A-Za-z0-9-_.$]+)?$/.exec(value.Arn) : undefined;
  if (!arn || arn[1] !== context.partition || arn[2] !== context.region || arn[3] !== context.accountId) {
    throw new AwsError("UnsupportedResourceState", `EventBridge target ${String(value.Id)} is not a local Lambda target supported by CFN-09`, 409);
  }
  return canonicalTarget(value);
}

function canonicalRule(properties: Record<string, unknown>, context: ProviderContext): EventRuleModel {
  return {
    Name: String(properties.Name ?? generatedRuleName(context)),
    EventBusName: canonicalBusName(properties.EventBusName, context),
    EventPattern: stable(structuredClone(properties.EventPattern as Record<string, unknown>)),
    ...(properties.Description !== undefined ? { Description: String(properties.Description) } : {}),
    State: String(properties.State ?? "ENABLED") as EventRuleModel["State"],
    Tags: canonicalTags(properties.Tags),
    Targets: (Array.isArray(properties.Targets) ? properties.Targets : []).map(item => canonicalTarget(item as Record<string, unknown>)).sort((left, right) => left.Id.localeCompare(right.Id)),
  };
}

function ruleIdentity(arn: string): { bus: string; name: string } {
  const match = /^arn:aws:events:[^:]+:\d{12}:rule\/(.+)$/.exec(arn);
  if (!match) throw new Error(`Invalid EventBridge rule physical ID ${arn}`);
  const parts = match[1].split("/");
  return parts.length === 1 ? { bus: "default", name: parts[0] } : { bus: parts[0], name: parts.slice(1).join("/") };
}

function ruleSuccess(model: EventRuleModel, arn: string): ProviderSuccess<EventRuleModel> {
  return { status: "SUCCESS", physicalId: arn, model: { physicalId: arn, properties: model, attributes: { Arn: arn } } };
}

export function createEventRuleProvider(events: EventBridgeService): ProductionResourceProvider<EventRuleModel> {
  const describe = async (identifier: { bus: string; name: string } | string, context: ProviderContext): Promise<{ model: EventRuleModel; arn: string; tags: Readonly<Record<string, string>> }> => {
    const identity = typeof identifier === "string" ? ruleIdentity(identifier) : identifier;
    const rule = await events.DescribeRule({ Name: identity.name, EventBusName: identity.bus });
    const targetResult = await events.ListTargetsByRule({ Rule: identity.name, EventBusName: identity.bus, Limit: 100 });
    const listedTags = await events.ListTagsForResource({ ResourceARN: rule.Arn });
    const tags = Object.fromEntries((listedTags.Tags ?? []).map((tag: any) => [String(tag.Key), String(tag.Value)]));
    const pattern = JSON.parse(String(rule.EventPattern));
    const targetModels = (targetResult.Targets ?? []).map((target: any) => targetFromView(target, context)).sort((left: EventRuleTargetModel, right: EventRuleTargetModel) => left.Id.localeCompare(right.Id));
    const current: EventRuleModel = {
      Name: String(rule.Name), EventBusName: String(rule.EventBusName), EventPattern: stable(pattern),
      ...(rule.Description !== undefined ? { Description: String(rule.Description) } : {}),
      State: String(rule.State) as EventRuleModel["State"], Tags: visibleTags(tags), Targets: targetModels,
    };
    return { model: current, arn: String(rule.Arn), tags };
  };

  const putTargets = async (desired: EventRuleModel, current: EventRuleModel): Promise<void> => {
    const wanted = new Set(desired.Targets.map(target => target.Id));
    const removals = current.Targets.map(target => target.Id).filter(id => !wanted.has(id));
    if (removals.length) {
      const response = await events.RemoveTargets({ Rule: desired.Name, EventBusName: desired.EventBusName, Ids: removals });
      if (Number(response.FailedEntryCount ?? 0) > 0) throw new AwsError("ValidationException", `EventBridge RemoveTargets failed: ${JSON.stringify(response.FailedEntries ?? [])}`, 400);
    }
    const currentById = new Map(current.Targets.map(target => [target.Id, target]));
    const upserts = desired.Targets.filter(target => !same(currentById.get(target.Id), target));
    if (upserts.length) {
      const response = await events.PutTargets({ Rule: desired.Name, EventBusName: desired.EventBusName, Targets: structuredClone(upserts) });
      if (Number(response.FailedEntryCount ?? 0) > 0) {
        const details = (response.FailedEntries ?? []).map((entry: any) => `${entry.TargetId || "target"}: ${entry.ErrorCode}: ${entry.ErrorMessage}`).join("; ");
        throw new AwsError("ValidationException", `EventBridge PutTargets failed: ${details}`, 400);
      }
    }
  };

  const reconcile = async (physicalId: string, desired: EventRuleModel, context: ProviderContext): Promise<ProviderUpdateResult<EventRuleModel>> => {
    let current = await describe(physicalId, context);
    if (!owns(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Event rule ${current.model.Name} is not owned by this stack resource` };
    if (current.model.Name !== desired.Name || current.model.EventBusName !== desired.EventBusName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "Name and EventBusName changes require replacement in CFN-09" };
    const ruleFields = ["Description", "EventPattern", "State"] as const;
    if (ruleFields.some(field => !same(current.model[field], desired[field]))) {
      await events.PutRule({ Name: desired.Name, EventBusName: desired.EventBusName, EventPattern: JSON.stringify(stable(desired.EventPattern)), State: desired.State, ...(desired.Description !== undefined ? { Description: desired.Description } : {}) });
      current = await describe(physicalId, context);
    }
    await putTargets(desired, current.model);
    current = await describe(physicalId, context);
    const wantedTags = tagMap(desired.Tags, context);
    const removals = Object.keys(current.tags).filter(key => key !== "stacksim:cloudformation:owner" && !Object.hasOwn(wantedTags, key));
    if (removals.length) await events.UntagResource({ ResourceARN: current.arn, TagKeys: removals });
    const additions = Object.entries(wantedTags).filter(([key, value]) => current.tags[key] !== value).map(([Key, Value]) => ({ Key, Value }));
    if (additions.length) await events.TagResource({ ResourceARN: current.arn, Tags: additions });
    current = await describe(physicalId, context);
    return ruleSuccess(current.model, current.arn);
  };

  const compensateNewRule = async (desired: EventRuleModel): Promise<void> => {
    const listed = await events.ListTargetsByRule({ Rule: desired.Name, EventBusName: desired.EventBusName, Limit: 100 });
    const ids = (listed.Targets ?? []).map((target: any) => String(target.Id)).filter(Boolean);
    if (ids.length) {
      const response = await events.RemoveTargets({ Rule: desired.Name, EventBusName: desired.EventBusName, Ids: ids });
      if (Number(response.FailedEntryCount ?? 0) > 0) {
        throw new AwsError("RemoveTargetsFailed", `EventBridge create compensation could not remove targets: ${JSON.stringify(response.FailedEntries ?? [])}`, 500);
      }
    }
    await events.DeleteRule({ Name: desired.Name, EventBusName: desired.EventBusName });
  };

  return {
    typeName: EVENT_RULE_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: EVENT_RULE_SCHEMA,
    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] { return validateRule(properties, context); },
    canonicalize(properties: unknown, context: ProviderContext): EventRuleModel {
      if (!isRecord(properties)) throw new TypeError(`${EVENT_RULE_TYPE} Properties must be an object`);
      const issues = validateRule(properties, context); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return canonicalRule(properties, context);
    },
    plan(previous: EventRuleModel | undefined, desired: EventRuleModel): ProviderPlan<EventRuleModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const changed = changedProperties(previous, desired);
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      const replacements = (["Name", "EventBusName"] as const).filter(field => !same(previous[field], desired[field]));
      return replacements.length
        ? { action: "REPLACE", desired, changedProperties: changed, replacementProperties: replacements, replacementOrder: "CREATE_BEFORE_DELETE" }
        : { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
    },
    async create(desired: EventRuleModel, context: ProviderContext) {
      let createdHere = false;
      try {
        try {
          const existing = await describe({ bus: desired.EventBusName, name: desired.Name }, context);
          if (!owns(existing.tags, context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Event rule ${desired.Name} already exists and is not owned by this stack resource` };
          return await reconcile(existing.arn, desired, context);
        } catch (error) { if (!isNotFound(error, ["ResourceNotFoundException"])) throw error; }
        const created = await events.PutRule({ Name: desired.Name, EventBusName: desired.EventBusName, EventPattern: JSON.stringify(stable(desired.EventPattern)), State: desired.State, ...(desired.Description !== undefined ? { Description: desired.Description } : {}), Tags: eventTags(desired.Tags, context) });
        createdHere = true;
        return await reconcile(String(created.RuleArn), desired, context);
      } catch (error) {
        if (createdHere) {
          try { await compensateNewRule(desired); }
          catch (cleanupError) {
            const original = error instanceof Error ? error.message : String(error);
            const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            return { status: "FAILED", errorCode: "CreateCompensationFailed", message: `${original}; compensation also failed: ${cleanup}`, retryable: false };
          }
        }
        return providerFailure(error);
      }
    },
    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<EventRuleModel>> {
      try { const current = await describe(physicalId, context); return ruleSuccess(current.model, current.arn); }
      catch (error) { return isNotFound(error, ["ResourceNotFoundException"]) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    async update(physicalId: string, _previous: EventRuleModel, desired: EventRuleModel, context: ProviderContext): Promise<ProviderUpdateResult<EventRuleModel>> {
      try { return await reconcile(physicalId, desired, context); } catch (error) { return providerFailure(error); }
    },
    async delete(physicalId: string, _previous: EventRuleModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const current = await describe(physicalId, context);
        if (!owns(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Event rule ${current.model.Name} is not owned by this stack resource` };
        const ids = current.model.Targets.map(target => target.Id);
        if (ids.length) {
          const response = await events.RemoveTargets({ Rule: current.model.Name, EventBusName: current.model.EventBusName, Ids: ids });
          if (Number(response.FailedEntryCount ?? 0) > 0) return { status: "FAILED", errorCode: "RemoveTargetsFailed", message: JSON.stringify(response.FailedEntries ?? []) };
        }
        await events.DeleteRule({ Name: current.model.Name, EventBusName: current.model.EventBusName });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isNotFound(error, ["ResourceNotFoundException"]) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    ref(current: ProviderReadModel<EventRuleModel>): unknown { return current.properties.Name; },
    getAtt(current: ProviderReadModel<EventRuleModel>, attribute: string): unknown {
      if (attribute === "Arn") return current.attributes.Arn;
      throw new ProviderReferenceError(EVENT_RULE_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}

export function createEventBridgeCloudFormationProviders(events: EventBridgeService): readonly ProductionResourceProvider<any>[] {
  return [createEventBusProvider(events), createEventRuleProvider(events)];
}
