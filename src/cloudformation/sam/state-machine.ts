import { parseS3Uri, readStateMachineApiEvent, translateStateMachineApiEvent } from "./api.js";
import { cfnResource, eventError, getAtt, isIntrinsic, isObject, passthroughAttributes, primaryAttributes, pythonIndentedJson, ref, resourceError, SamCause, SamDocumentError, tagList, validateProperties, type JsonObject, type PropertySpec } from "./common.js";
import type { SamContext } from "./context.js";
import { readEventProperties, type EventSpec } from "./events/common.js";
import { deadLetterQueue, targetId, validateDeadLetterConfig } from "./events/rules.js";
import { resolveParameterRefs } from "./parameters.js";
import { constructRole } from "./policies.js";

const SAM_TAG = "stateMachine:createdBy";
const TARGET_SUFFIX = "StepFunctionsTarget";
const SUBSTITUTION_PATTERN = /^\{\{resolve:([a-z-]+):(.+)\}\}$/;

/** SamStateMachine.property_types, in SAM's order. */
const STATE_MACHINE_PROPERTIES: Readonly<Record<string, PropertySpec>> = {
  Definition: { type: "map" },
  DefinitionUri: { type: "string-or-map", generic: true },
  Logging: { type: "map" },
  Role: { type: "string" },
  DefinitionSubstitutions: { type: "map" },
  Events: { type: "map", generic: true },
  Name: { type: "string" },
  Type: { type: "string" },
  Tags: { type: "map" },
  PropagateTags: { type: "boolean" },
  Policies: { type: "string-or-list-of-string-or-map", generic: true },
  Tracing: { type: "map" },
  PermissionsBoundary: { type: "string" },
  UseAliasAsEventTarget: { type: "boolean", intrinsics: false },
};

const SCHEDULE_SPEC: EventSpec = {
  Schedule: { type: "string", required: true },
  Input: { type: "string" },
  Enabled: { type: "boolean" },
  State: { type: "string" },
  Name: { type: "string" },
  Description: { type: "string" },
  DeadLetterConfig: { type: "map" },
  RetryPolicy: { type: "map" },
  Target: { type: "map", intrinsics: false },
  RoleArn: { type: "string", intrinsics: false },
};

const CLOUDWATCH_EVENT_SPEC: EventSpec = {
  EventBusName: { type: "string" },
  RuleName: { type: "string" },
  Pattern: { type: "map" },
  Input: { type: "string" },
  InputPath: { type: "string" },
  DeadLetterConfig: { type: "map" },
  RetryPolicy: { type: "map" },
  State: { type: "string" },
  Target: { type: "map", intrinsics: false },
  InputTransformer: { type: "map" },
};

const EVENT_SPECS: Readonly<Record<string, EventSpec>> = { Schedule: SCHEDULE_SPEC, CloudWatchEvent: CLOUDWATCH_EVENT_SPEC, EventBridgeRule: CLOUDWATCH_EVENT_SPEC };

/** The state machine a state machine event targets. */
export interface StateMachineTarget {
  readonly logicalId: string;
  readonly resource: JsonObject;
  readonly permissionsBoundary: unknown;
}

/** EventSource._construct_role: `<S><Event>Role`, which the service assumes to call StartExecution. */
export function startExecutionRole(target: StateMachineTarget, roleLogicalId: string, principal: string): JsonObject {
  return cfnResource("AWS::IAM::Role", {
    AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Action: ["sts:AssumeRole"], Effect: "Allow", Principal: { Service: [principal] } }] },
    Policies: [{ PolicyName: `${roleLogicalId}StartExecutionPolicy`, PolicyDocument: { Statement: [{ Action: "states:StartExecution", Effect: "Allow", Resource: ref(target.logicalId) }] } }],
    PermissionsBoundary: target.permissionsBoundary || undefined,
  }, passthroughAttributes(target.resource));
}

/** Schedule, CloudWatchEvent, and EventBridgeRule events: the `<S><Event>` rule, its role, and an optional dead-letter queue. */
function translateRuleEvent(target: StateMachineTarget, eventId: string, eventType: string, properties: JsonObject): Record<string, JsonObject> {
  const logicalId = `${target.logicalId}${eventId}`;
  const attributes = passthroughAttributes(target.resource);
  const schedule = eventType === "Schedule";
  const rule: JsonObject = schedule ? { ScheduleExpression: properties.Schedule } : { EventBusName: properties.EventBusName, EventPattern: properties.Pattern, Name: properties.RuleName };
  if (schedule) {
    if (properties.State && properties.Enabled !== undefined && properties.Enabled !== null) throw eventError(eventId, "State and Enabled Properties cannot both be specified.");
    if (properties.State) rule.State = properties.State;
    if (properties.Enabled !== undefined && properties.Enabled !== null) rule.State = properties.Enabled ? "ENABLED" : "DISABLED";
    rule.Name = properties.Name;
    rule.Description = properties.Description;
  } else if (properties.State) rule.State = properties.State;

  const output: Record<string, JsonObject> = { [logicalId]: {} };
  const roleLogicalId = `${logicalId}Role`;
  let roleArn: unknown = properties.RoleArn;
  if (!schedule || properties.RoleArn === undefined || properties.RoleArn === null) {
    output[roleLogicalId] = startExecutionRole(target, roleLogicalId, "events.amazonaws.com");
    roleArn = getAtt(roleLogicalId, "Arn");
  }
  let dlqArn: unknown;
  if (properties.DeadLetterConfig !== undefined && properties.DeadLetterConfig !== null) {
    validateDeadLetterConfig(logicalId, properties.DeadLetterConfig as JsonObject);
    dlqArn = deadLetterQueue(logicalId, properties.DeadLetterConfig as JsonObject, getAtt(logicalId, "Arn"), attributes, output);
  }
  const custom = isObject(properties.Target) && Object.hasOwn(properties.Target, "Id") ? properties.Target.Id : undefined;
  const ruleTarget: JsonObject = { Arn: ref(target.logicalId), Id: custom ?? targetId(logicalId, TARGET_SUFFIX), RoleArn: roleArn };
  if (properties.Input !== undefined && properties.Input !== null) ruleTarget.Input = properties.Input;
  if (!schedule && properties.InputPath !== undefined && properties.InputPath !== null) ruleTarget.InputPath = properties.InputPath;
  if (properties.DeadLetterConfig !== undefined && properties.DeadLetterConfig !== null) ruleTarget.DeadLetterConfig = { Arn: dlqArn };
  if (properties.RetryPolicy !== undefined && properties.RetryPolicy !== null) ruleTarget.RetryPolicy = properties.RetryPolicy;
  if (!schedule && properties.InputTransformer !== undefined && properties.InputTransformer !== null) ruleTarget.InputTransformer = properties.InputTransformer;
  rule.Targets = [ruleTarget];
  output[logicalId] = cfnResource("AWS::Events::Rule", rule, attributes);
  return output;
}

/**
 * StateMachineGenerator._replace_dynamic_values_with_substitutions: replace
 * every intrinsic and dynamic reference in the definition (visiting keys in
 * sorted order) with `${definition_substitution_N}`.
 */
function substituteDynamicValues(definition: unknown, substitutions: JsonObject, counter: { next: number }): void {
  if (!isObject(definition) && !Array.isArray(definition)) return;
  const entries: Array<[string | number, unknown]> = Array.isArray(definition) ? definition.map((item, index) => [index, item]) : Object.entries(definition).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [key, value] of entries) {
    if (isIntrinsic(value) || (typeof value === "string" && SUBSTITUTION_PATTERN.test(value))) {
      const name = `definition_substitution_${counter.next++}`;
      substitutions[name] = value;
      (definition as Record<string | number, unknown>)[key] = `\${${name}}`;
    } else if (isObject(value) || Array.isArray(value)) substituteDynamicValues(value, substitutions, counter);
  }
}

function definitionLocation(logicalId: string, value: unknown): JsonObject {
  let pointer: JsonObject;
  if (isObject(value)) {
    if (!value.Bucket || !value.Key) throw resourceError(logicalId, "'DefinitionUri' requires Bucket and Key properties to be specified.");
    pointer = value;
  } else {
    const parsed = parseS3Uri(value);
    if (!parsed) throw resourceError(logicalId, "'DefinitionUri' is not a valid S3 Uri of the form 's3://bucket/key' with optional versionId query parameter.");
    pointer = parsed;
  }
  return { Bucket: pointer.Bucket, Key: pointer.Key, ...(Object.hasOwn(pointer, "Version") ? { Version: pointer.Version } : {}) };
}

function readEvents(logicalId: string, events: JsonObject): Map<string, JsonObject> {
  const read = new Map<string, JsonObject>();
  for (const [eventId, event] of Object.entries(events)) {
    if (!isObject(event)) continue;
    const eventLogicalId = `${logicalId}${eventId}`;
    try {
      if (event.Type === "Api") read.set(eventId, readStateMachineApiEvent(eventLogicalId, event));
      else if (typeof event.Type === "string" && Object.hasOwn(EVENT_SPECS, event.Type)) read.set(eventId, readEventProperties(eventLogicalId, event.Type, event, EVENT_SPECS[event.Type]));
    } catch (error) {
      if (error instanceof SamCause && !error.message.startsWith("Resource with id [")) throw resourceError(logicalId, error.message);
      throw error;
    }
  }
  return read;
}

/**
 * AWS::Serverless::StateMachine (STANDARD) → Step Functions state machine,
 * its generated `<S>Role`, and event resources. An inline Definition becomes
 * a DefinitionString join; DefinitionUri becomes DefinitionS3Location.
 */
export function translateStateMachine(context: SamContext, logicalId: string, resource: JsonObject): Record<string, JsonObject> {
  const properties = isObject(resource.Properties) ? resource.Properties : {};
  validateProperties(logicalId, properties, STATE_MACHINE_PROPERTIES);
  const events = isObject(properties.Events) ? readEvents(logicalId, properties.Events) : new Map<string, JsonObject>();
  const type = resolveParameterRefs(properties.Type, context.parameters);
  if (typeof type === "string" && type !== "STANDARD") throw resourceError(logicalId, `Type '${type}' is not supported by StackSim: Step Functions in StackSim supports STANDARD state machines only.`);

  const machine: JsonObject = {};
  if (isObject(properties.DefinitionSubstitutions) && Object.keys(properties.DefinitionSubstitutions).length) machine.DefinitionSubstitutions = { ...properties.DefinitionSubstitutions };
  if (properties.Definition && properties.DefinitionUri) throw resourceError(logicalId, "Specify either 'Definition' or 'DefinitionUri' property and not both.");
  if (isObject(properties.Definition) && Object.keys(properties.Definition).length) {
    const definition = structuredClone(properties.Definition);
    const substitutions: JsonObject = {};
    substituteDynamicValues(definition, substitutions, { next: 1 });
    if (Object.keys(substitutions).length) machine.DefinitionSubstitutions = { ...(machine.DefinitionSubstitutions as JsonObject | undefined ?? {}), ...substitutions };
    machine.DefinitionString = { "Fn::Join": ["\n", pythonIndentedJson(definition).split("\n")] };
  } else if (properties.DefinitionUri) machine.DefinitionS3Location = definitionLocation(logicalId, properties.DefinitionUri);
  else throw resourceError(logicalId, "Either 'Definition' or 'DefinitionUri' property must be specified.");

  const hasPolicies = properties.Policies !== undefined && properties.Policies !== null && !(Array.isArray(properties.Policies) && properties.Policies.length === 0) && properties.Policies !== "";
  if (properties.Role && hasPolicies) throw resourceError(logicalId, "Specify either 'Role' or 'Policies' (but not both at the same time) or neither of them");
  const tags = [{ Key: SAM_TAG, Value: "SAM" }, ...tagList(properties.Tags)];
  const output: Record<string, JsonObject> = { [logicalId]: {} };
  if (properties.Role) machine.RoleArn = properties.Role;
  else {
    const policies = hasPolicies ? [...(Array.isArray(properties.Policies) ? properties.Policies : [properties.Policies])] : [];
    // SAM adds the X-Ray policy by name, after the template's policies.
    if (isObject(properties.Tracing) && properties.Tracing.Enabled === true) policies.push(context.partition === "aws" ? "AWSXrayWriteOnlyAccess" : "AWSXRayDaemonWriteAccess");
    output[`${logicalId}Role`] = constructRole({
      logicalId,
      roleLogicalId: `${logicalId}Role`,
      attributes: passthroughAttributes(resource),
      partition: context.partition,
      assumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Action: ["sts:AssumeRole"], Effect: "Allow", Principal: { Service: ["states.amazonaws.com"] } }] },
      managedPolicyArns: [],
      policyDocuments: [],
      policies,
      rolePath: properties.RolePath,
      permissionsBoundary: properties.PermissionsBoundary,
      tags,
    });
    machine.RoleArn = getAtt(`${logicalId}Role`, "Arn");
  }
  machine.StateMachineName = properties.Name;
  machine.StateMachineType = properties.Type;
  machine.LoggingConfiguration = properties.Logging;
  machine.TracingConfiguration = properties.Tracing;
  machine.Tags = tags;
  output[logicalId] = cfnResource("AWS::StepFunctions::StateMachine", machine, primaryAttributes(resource));

  const target: StateMachineTarget = { logicalId, resource, permissionsBoundary: properties.PermissionsBoundary };
  const causes: SamCause[] = [];
  for (const [eventId, event] of Object.entries(isObject(properties.Events) ? properties.Events : {})) {
    const read = events.get(eventId);
    if (!isObject(event) || !read) continue;
    // SAM reports state machine event errors as they are, without naming the state machine.
    try {
      Object.assign(output, event.Type === "Api" ? translateStateMachineApiEvent(context, target, eventId, read) : translateRuleEvent(target, eventId, event.Type as string, read));
    } catch (error) {
      if (!(error instanceof SamCause)) throw error;
      causes.push(error);
      break;
    }
  }
  if (causes.length) throw new SamDocumentError(causes);

  if (properties.PropagateTags === true && isObject(properties.Tags) && Object.keys(properties.Tags).length) {
    for (const generated of Object.values(output)) {
      if (generated.Type === "AWS::StepFunctions::StateMachine" || generated.Type === "AWS::IAM::Role" || generated.Type === "AWS::SQS::Queue") (generated.Properties as JsonObject).Tags = tagList(properties.Tags);
    }
  }
  return output;
}

