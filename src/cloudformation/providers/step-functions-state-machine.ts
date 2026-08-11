import { createHash } from "node:crypto";
import { AwsError } from "../../errors.js";
import type { StepFunctionsService } from "../../step-functions.js";
import { validateDefinition } from "../../step-functions/asl-validator.js";
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

export const STEP_FUNCTIONS_STATE_MACHINE_TYPE = "AWS::StepFunctions::StateMachine";

export interface StepFunctionsStateMachineModel {
  readonly StateMachineName: string;
  readonly DefinitionString: string;
  readonly RoleArn: string;
  readonly StateMachineType: "STANDARD";
  readonly Tags: readonly { readonly Key: string; readonly Value: string }[];
}

export const STEP_FUNCTIONS_STATE_MACHINE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: STEP_FUNCTIONS_STATE_MACHINE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Definition: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    DefinitionString: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    DefinitionSubstitutions: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    RoleArn: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    StateMachineName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    StateMachineType: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    LoggingConfiguration: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    TracingConfiguration: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    EncryptionConfiguration: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "State machine ARN" }),
  attributes: Object.freeze({
    Arn: Object.freeze({ valueType: "string", description: "State machine ARN" }),
    Name: Object.freeze({ valueType: "string", description: "State machine name" }),
    StateMachineRevisionId: Object.freeze({ valueType: "string", description: "Current state machine revision ID" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: Object.freeze({
    deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    snapshotSupported: false,
  }),
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stackName(context: ProviderContext): string {
  return context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack";
}

function generatedName(context: ProviderContext): string {
  const suffix = createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex").slice(0, 12);
  const prefix = `${stackName(context)}-${context.logicalId}`.replace(/[^A-Za-z0-9-_]/g, "-");
  return `${prefix.slice(0, Math.max(1, 80 - suffix.length - 1))}-${suffix}`;
}

function canonicalTags(value: unknown): readonly { Key: string; Value: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("Tags must be an array");
  const result = value.map(item => {
    if (!record(item) || typeof item.Key !== "string" || typeof item.Value !== "string") throw new TypeError("Each tag requires string Key and Value");
    return { Key: item.Key, Value: item.Value };
  }).sort((left, right) => left.Key.localeCompare(right.Key));
  if (result.length > 47 || new Set(result.map(item => item.Key)).size !== result.length || result.some(item => !item.Key || item.Key.toLowerCase().startsWith("aws:"))) {
    throw new TypeError("Tags require unique non-aws: keys and contain at most 47 entries after reserving CloudFormation ownership tags");
  }
  return result;
}

function ownershipTags(model: StepFunctionsStateMachineModel, context: ProviderContext): Record<string, string> {
  return {
    ...Object.fromEntries((model.Tags ?? []).map(tag => [tag.Key, tag.Value])),
    "aws:cloudformation:stack-id": context.stackId,
    "aws:cloudformation:stack-name": stackName(context),
    "aws:cloudformation:logical-id": context.logicalId,
  };
}

function owned(tags: Readonly<Record<string, string>>, context: ProviderContext): boolean {
  return tags["aws:cloudformation:stack-id"] === context.stackId
    && tags["aws:cloudformation:logical-id"] === context.logicalId;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (record(value)) return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
  return value;
}

function applySubstitutions(definition: string, value: unknown): string {
  if (value === undefined) return definition;
  if (!record(value) || Object.values(value).some(item => typeof item !== "string")) throw new TypeError("DefinitionSubstitutions must be a string map");
  return definition.replace(/\$\{([A-Za-z0-9_]+(?:,[A-Za-z0-9_]+)*)\}/g, (_match, names: string) => {
    const keys = names.split(",");
    const missing = keys.find(key => !Object.hasOwn(value, key));
    if (missing) throw new TypeError(`DefinitionSubstitutions does not define ${missing}`);
    return keys.map(key => String(value[key])).join("");
  });
}

function definitionString(properties: Record<string, unknown>): string {
  const hasObject = properties.Definition !== undefined;
  const hasString = properties.DefinitionString !== undefined;
  if (hasObject === hasString) throw new TypeError("Specify exactly one of Definition or DefinitionString");
  const raw = hasObject ? JSON.stringify(stable(properties.Definition)) : String(properties.DefinitionString);
  return applySubstitutions(raw, properties.DefinitionSubstitutions);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function stateMachineArn(model: StepFunctionsStateMachineModel, context: ProviderContext): string {
  return `arn:${context.partition}:states:${context.region}:${context.accountId}:stateMachine:${model.StateMachineName}`;
}

function inProgress(physicalId: string, phase: string): ProviderInProgress {
  return {
    status: "IN_PROGRESS",
    callbackAfterMs: 1,
    checkpoint: { schemaVersion: 1, physicalId, callbackContext: { phase } },
  };
}

function failure(error: unknown): ProviderUpdateResult<StepFunctionsStateMachineModel> {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}

function notFound(error: unknown): boolean {
  return error instanceof AwsError && error.code === "StateMachineDoesNotExist";
}

function success(model: StepFunctionsStateMachineModel, arn: string, revisionId: string): ProviderSuccess<StepFunctionsStateMachineModel> {
  return {
    status: "SUCCESS",
    physicalId: arn,
    model: {
      physicalId: arn,
      properties: model,
      attributes: { Arn: arn, Name: model.StateMachineName, StateMachineRevisionId: revisionId },
    },
  };
}

export function createStepFunctionsStateMachineProvider(stepFunctions: StepFunctionsService): ProductionResourceProvider<StepFunctionsStateMachineModel> {
  const describe = async (arn: string): Promise<any | undefined> => {
    try { return await stepFunctions.DescribeStateMachine({ stateMachineArn: arn }); }
    catch (error) { if (notFound(error)) return undefined; throw error; }
  };
  const tagMap = async (arn: string): Promise<Record<string, string>> =>
    Object.fromEntries(((await stepFunctions.ListTagsForResource({ resourceArn: arn })).tags ?? []).map((tag: any) => [String(tag.key), String(tag.value)]));

  const readOwned = async (arn: string, context: ProviderContext): Promise<{ machine: any; tags: Record<string, string> } | undefined> => {
    const machine = await describe(arn);
    if (!machine) return undefined;
    const tags = await tagMap(arn);
    if (!owned(tags, context)) throw new AwsError("OwnershipConflict", `State machine ${arn} is not owned by this stack resource`, 409);
    return { machine, tags };
  };

  const modelFrom = (machine: any, tags: Readonly<Record<string, string>>): StepFunctionsStateMachineModel => ({
    StateMachineName: String(machine.name),
    DefinitionString: String(machine.definition),
    RoleArn: String(machine.roleArn),
    StateMachineType: "STANDARD",
    Tags: Object.entries(tags)
      .filter(([key]) => !key.startsWith("aws:cloudformation:"))
      .map(([Key, Value]) => ({ Key, Value }))
      .sort((left, right) => left.Key.localeCompare(right.Key)),
  });

  const reconcile = async (
    arn: string,
    desired: StepFunctionsStateMachineModel,
    context: ProviderContext,
  ): Promise<ProviderUpdateResult<StepFunctionsStateMachineModel>> => {
    const current = await readOwned(arn, context);
    if (!current) return { status: "FAILED", errorCode: "NotFound", message: `State machine ${arn} no longer exists` };
    if (current.machine.definition !== desired.DefinitionString || current.machine.roleArn !== desired.RoleArn) {
      await stepFunctions.UpdateStateMachine({
        stateMachineArn: arn,
        ...(current.machine.definition !== desired.DefinitionString ? { definition: desired.DefinitionString } : {}),
        ...(current.machine.roleArn !== desired.RoleArn ? { roleArn: desired.RoleArn } : {}),
      });
      return inProgress(arn, "after-update");
    }
    const wanted = ownershipTags(desired, context);
    const removals = Object.keys(current.tags).filter(key => !Object.hasOwn(wanted, key));
    if (removals.length) {
      await stepFunctions.UntagResource({ resourceArn: arn, tagKeys: removals });
      return inProgress(arn, "after-untag");
    }
    const additions = Object.entries(wanted)
      .filter(([key, value]) => current.tags[key] !== value)
      .map(([key, value]) => ({ key, value }));
    if (additions.length) {
      await stepFunctions.TagResource({ resourceArn: arn, tags: additions });
      return inProgress(arn, "after-tag");
    }
    const refreshed = await readOwned(arn, context);
    if (!refreshed) return { status: "FAILED", errorCode: "NotFound", message: `State machine ${arn} no longer exists` };
    return success(modelFrom(refreshed.machine, refreshed.tags), arn, String(refreshed.machine.revisionId));
  };

  return {
    typeName: STEP_FUNCTIONS_STATE_MACHINE_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: STEP_FUNCTIONS_STATE_MACHINE_SCHEMA,
    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] {
      const issues = validateDeclaredProperties(properties ?? {}, STEP_FUNCTIONS_STATE_MACHINE_SCHEMA);
      if (!record(properties)) return issues;
      const invalid = (path: string, message: string) => issues.push({ code: "InvalidProperty", path, message });
      const unsupported = (path: string, message: string) => issues.push({ code: "UnsupportedProperty", path, message });
      if ((properties.Definition === undefined) === (properties.DefinitionString === undefined)) invalid("Properties", "Specify exactly one of Definition or DefinitionString");
      if (properties.DefinitionSubstitutions !== undefined && (!record(properties.DefinitionSubstitutions) || Object.values(properties.DefinitionSubstitutions).some(item => typeof item !== "string"))) invalid("Properties.DefinitionSubstitutions", "DefinitionSubstitutions must be a string map");
      const name = properties.StateMachineName;
      if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z0-9-_]{1,80}$/.test(name))) invalid("Properties.StateMachineName", "StateMachineName must contain 1-80 letters, numbers, hyphens, or underscores");
      if (properties.StateMachineType !== undefined && properties.StateMachineType !== "STANDARD") unsupported("Properties.StateMachineType", "Only STANDARD state machines are supported");
      if (typeof properties.RoleArn === "string" && !new RegExp(`^arn:${context.partition}:iam::${context.accountId}:role/[\\w+=,.@/-]+$`).test(properties.RoleArn)) invalid("Properties.RoleArn", "RoleArn must identify a role in the stack account");
      try { canonicalTags(properties.Tags); } catch (error) { invalid("Properties.Tags", error instanceof Error ? error.message : String(error)); }
      if (properties.LoggingConfiguration !== undefined) {
        const logging = properties.LoggingConfiguration;
        if (!record(logging)
          || Object.keys(logging).some(key => !["Destinations", "IncludeExecutionData", "Level"].includes(key))
          || (logging.Level ?? "OFF") !== "OFF"
          || logging.IncludeExecutionData === true
          || Array.isArray(logging.Destinations) && logging.Destinations.length > 0) {
          unsupported("Properties.LoggingConfiguration", "Execution logging requires SFN-05; only the disabled OFF configuration is accepted");
        }
      }
      if (properties.TracingConfiguration !== undefined) {
        const tracing = properties.TracingConfiguration;
        if (!record(tracing) || Object.keys(tracing).some(key => key !== "Enabled") || tracing.Enabled === true) unsupported("Properties.TracingConfiguration", "X-Ray tracing is not supported");
      }
      if (properties.EncryptionConfiguration !== undefined) {
        const encryption = properties.EncryptionConfiguration;
        if (!record(encryption) || Object.keys(encryption).some(key => key !== "Type") || encryption.Type !== "AWS_OWNED_KEY") unsupported("Properties.EncryptionConfiguration", "Only AWS_OWNED_KEY encryption is supported");
      }
      try {
        const definition = definitionString(properties);
        if (Buffer.byteLength(definition) > 1024 * 1024) invalid("Properties.DefinitionString", "The effective definition exceeds 1 MiB");
        else {
          const validation = validateDefinition(definition, context.region, context.accountId);
          for (const diagnostic of validation.diagnostics.filter(item => item.severity === "ERROR")) invalid("Properties.DefinitionString", `${diagnostic.location}: ${diagnostic.message}`);
        }
      } catch (error) { invalid("Properties.DefinitionString", error instanceof Error ? error.message : String(error)); }
      return issues;
    },
    canonicalize(properties: unknown, context: ProviderContext): StepFunctionsStateMachineModel {
      if (!record(properties)) throw new TypeError(`${STEP_FUNCTIONS_STATE_MACHINE_TYPE} Properties must be an object`);
      const issues = this.validate(properties, context);
      if (issues.length) throw new TypeError(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
      return {
        StateMachineName: String(properties.StateMachineName ?? generatedName(context)),
        DefinitionString: definitionString(properties),
        RoleArn: String(properties.RoleArn),
        StateMachineType: "STANDARD",
        Tags: canonicalTags(properties.Tags) ?? [],
      };
    },
    plan(previous: StepFunctionsStateMachineModel | undefined, desired: StepFunctionsStateMachineModel): ProviderPlan<StepFunctionsStateMachineModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const changed = (["StateMachineName", "DefinitionString", "RoleArn", "StateMachineType", "Tags"] as const).filter(key => !same(previous[key], desired[key]));
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      if (changed.includes("StateMachineName") || changed.includes("StateMachineType")) {
        const replacement = changed.filter(key => key === "StateMachineName" || key === "StateMachineType");
        return { action: "REPLACE", desired, changedProperties: changed, replacementProperties: replacement, replacementOrder: "CREATE_BEFORE_DELETE" };
      }
      return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
    },
    async create(desired: StepFunctionsStateMachineModel, context: ProviderContext) {
      const arn = stateMachineArn(desired, context);
      try {
        const existing = await describe(arn);
        if (existing) {
          const currentTags = await tagMap(arn);
          if (!owned(currentTags, context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `State machine ${arn} already exists and is not owned by this stack resource` };
          return await reconcile(arn, desired, context);
        }
        await stepFunctions.CreateStateMachine({
          name: desired.StateMachineName,
          definition: desired.DefinitionString,
          roleArn: desired.RoleArn,
          type: "STANDARD",
          tags: Object.entries(ownershipTags(desired, context)).map(([key, value]) => ({ key, value })),
        });
        return inProgress(arn, "after-create");
      } catch (error) { return failure(error); }
    },
    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<StepFunctionsStateMachineModel>> {
      try {
        const current = await readOwned(physicalId, context);
        if (!current) return { status: "NOT_FOUND", physicalId };
        return success(modelFrom(current.machine, current.tags), physicalId, String(current.machine.revisionId));
      } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failure(error) as ProviderReadResult<StepFunctionsStateMachineModel>; }
    },
    async update(physicalId: string, _previous: StepFunctionsStateMachineModel, desired: StepFunctionsStateMachineModel, context: ProviderContext): Promise<ProviderUpdateResult<StepFunctionsStateMachineModel>> {
      if (physicalId !== stateMachineArn(desired, context)) return { status: "FAILED", errorCode: "RequiresReplacement", message: "StateMachineName changes require replacement" };
      try { return await reconcile(physicalId, desired, context); } catch (error) { return failure(error); }
    },
    async delete(physicalId: string, _previous: StepFunctionsStateMachineModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const current = await readOwned(physicalId, context);
        if (!current) return { status: "NOT_FOUND", physicalId };
        await stepFunctions.DeleteStateMachine({ stateMachineArn: physicalId });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failure(error) as ProviderDeleteResult; }
    },
    ref(model: ProviderReadModel<StepFunctionsStateMachineModel>): unknown { return model.physicalId; },
    getAtt(model: ProviderReadModel<StepFunctionsStateMachineModel>, attribute: string): unknown {
      if (attribute === "Arn") return model.attributes.Arn;
      if (attribute === "Name") return model.attributes.Name;
      if (attribute === "StateMachineRevisionId") return model.attributes.StateMachineRevisionId;
      throw new ProviderReferenceError(STEP_FUNCTIONS_STATE_MACHINE_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}
