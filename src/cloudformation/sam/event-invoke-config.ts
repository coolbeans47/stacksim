import { cfnResource, clone, getAtt, isIntrinsicIf, isNoValue, isObject, logicalIdHash, makeConditional, passthroughAttributes, ref, resourceError, type JsonObject } from "./common.js";
import type { SamContext } from "./context.js";
import { truthy } from "./events/common.js";
import { snsPublishPolicy, sqsSendMessagePolicy } from "./events/pull.js";
import { resolveParameterRefs } from "./parameters.js";

const DESTINATION_TYPES = ["SQS", "SNS", "EventBridge", "Lambda", "S3Bucket"];
const GENERATED_TYPES = ["SQS", "SNS"];
const CONDITION_NAME_LIMIT = 255;
/** The SAM resource attributes SAM copies to the EventInvokeConfig (Resource._supported_resource_attributes). */
const EVENT_INVOKE_ATTRIBUTES = ["DeletionPolicy", "UpdatePolicy", "Condition", "UpdateReplacePolicy", "Metadata"];

const pythonList = (items: readonly string[]) => `[${items.map(item => `'${item}'`).join(", ")}]`;

/** _make_gen_condition_name: the name plus a 10-character hash of `hashInput`, within CloudFormation's limit. */
const conditionName = (name: string, hashInput: string) => `${name}${logicalIdHash(hashInput)}`.slice(0, CONDITION_NAME_LIMIT);

function conditions(context: SamContext): JsonObject {
  if (!isObject(context.template.Conditions)) context.template.Conditions = {};
  return context.template.Conditions as JsonObject;
}

/**
 * _get_or_make_condition: a Destination of `Fn::If [C, NoValue, arn]` makes
 * SAM create the queue or topic only when C holds; `Fn::If [C, arn, NoValue]`
 * adds a negated condition `NOT<C><hash>`.
 */
function destinationCondition(context: SamContext, eventInvokeId: string, destination: unknown): [string | undefined, unknown] {
  if (destination === undefined || destination === null || !isIntrinsicIf(destination)) return [undefined, undefined];
  const items = destination["Fn::If"];
  if (items.length !== 3) throw resourceError(eventInvokeId, "Malformed 'Destination' property: Fn::If requires 3 arguments.");
  const [condition, whenTrue, whenFalse] = items;
  if (isNoValue(whenTrue) && isNoValue(whenFalse)) return [undefined, undefined];
  if (isNoValue(whenTrue)) return [condition as string, whenFalse];
  if (isNoValue(whenFalse)) {
    const negated = conditionName(`NOT${String(condition)}`, eventInvokeId);
    conditions(context)[negated] = { "Fn::Not": [{ Condition: condition }] };
    return [negated, whenTrue];
  }
  return [undefined, undefined];
}

/** _make_and_conditions, including SAM's doubly nested Condition operands. */
function andCondition(context: SamContext, logicalId: string, resourceCondition: unknown, propertyCondition: string | undefined): unknown {
  if (resourceCondition === undefined || resourceCondition === null) return propertyCondition;
  if (propertyCondition === undefined) return resourceCondition;
  const name = conditionName(`${String(resourceCondition)}AND${propertyCondition}`, logicalId);
  conditions(context)[name] = { "Fn::And": [{ Condition: { Condition: resourceCondition } }, { Condition: { Condition: propertyCondition } }] };
  return name;
}

function destinationPolicy(type: unknown, logicalId: string, arn: unknown): JsonObject {
  if (type === "SQS") return sqsSendMessagePolicy(arn, logicalId);
  if (type === "SNS") return snsPublishPolicy(arn, logicalId);
  if (type === "EventBridge") return { PolicyName: `${logicalId}EventBridgePolicy`, PolicyDocument: { Statement: [{ Action: "events:PutEvents", Effect: "Allow", Resource: arn }] } };
  return { PolicyName: `${logicalId}LambdaPolicy`, PolicyDocument: { Statement: [{ Action: "lambda:InvokeFunction", Effect: "Allow", Resource: arn }] } };
}

export interface EventInvokeConfigExpansion {
  readonly resources: Record<string, JsonObject>;
  /** Inline policies for the generated execution role. */
  readonly policies: JsonObject[];
}

/**
 * EventInvokeConfig → `<F>EventInvokeConfig` on `$LATEST`. A destination with
 * Type SQS or SNS and no Destination generates `<F>EventInvokeConfig<OnSuccess|OnFailure><Queue|Topic>`.
 * Every destination adds the matching send or invoke policy to the role.
 * With AutoPublishAlias the config qualifies the alias and depends on it.
 */
export function translateEventInvokeConfig(context: SamContext, logicalId: string, resource: JsonObject, config: unknown, alias?: { readonly name: string; readonly logicalId: string }): EventInvokeConfigExpansion {
  if (!isObject(config)) throw resourceError(logicalId, "Property 'EventInvokeConfig' should be a map.");
  const resolved = resolveParameterRefs(clone(config), context.parameters) as JsonObject;
  const eventInvokeId = `${logicalId}EventInvokeConfig`;
  const passthrough = passthroughAttributes(resource);
  const resources: Record<string, JsonObject> = {};
  const policies: JsonObject[] = [];
  const destinations: JsonObject = {};
  const input = resolved.DestinationConfig;
  if (truthy(input)) {
    if (!isObject(input)) throw resourceError(logicalId, "Property 'EventInvokeConfig.DestinationConfig' should be a map.");
    for (const name of ["OnSuccess", "OnFailure"]) {
      const value = input[name];
      if (value === undefined || value === null) continue;
      if (!isObject(value)) throw resourceError(logicalId, `Property 'EventInvokeConfig.DestinationConfig.${name}' should be a map.`);
      const type = value.Type;
      if (typeof type !== "string" || !DESTINATION_TYPES.includes(type)) throw resourceError(logicalId, `'Type: ${type === undefined || type === null ? "None" : String(type)}' must be one of ${pythonList(DESTINATION_TYPES)}`);
      if (type === "S3Bucket") throw resourceError(logicalId, "EventInvokeConfig destinations of Type 'S3Bucket' are not supported by StackSim.");
      const resourceLogicalId = `${eventInvokeId}${name}`;
      const [propertyCondition, otherArn] = destinationCondition(context, eventInvokeId, value.Destination);
      let destination = value.Destination;
      if (value.Destination === undefined || value.Destination === null || propertyCondition !== undefined) {
        if (!GENERATED_TYPES.includes(type)) throw resourceError(logicalId, `Destination is required if Type is not ${pythonList(GENERATED_TYPES)}`);
        const combined = andCondition(context, logicalId, passthrough.Condition, propertyCondition);
        const generatedId = `${resourceLogicalId}${type === "SQS" ? "Queue" : "Topic"}`;
        const generated = cfnResource(type === "SQS" ? "AWS::SQS::Queue" : "AWS::SNS::Topic", {}, passthrough, true);
        if (combined !== undefined) generated.Condition = combined;
        resources[generatedId] = generated;
        const arn = type === "SQS" ? getAtt(generatedId, "Arn") : ref(generatedId);
        destination = propertyCondition !== undefined ? makeConditional(propertyCondition, arn, otherArn) : arn;
      }
      policies.push(destinationPolicy(type, resourceLogicalId, destination));
      destinations[name] = { Destination: destination };
    }
  }
  const attributes: JsonObject = { ...(alias ? { DependsOn: [alias.logicalId] } : {}), ...Object.fromEntries(EVENT_INVOKE_ATTRIBUTES.filter(name => resource[name] !== undefined).map(name => [name, resource[name]])) };
  resources[eventInvokeId] = cfnResource("AWS::Lambda::EventInvokeConfig", {
    FunctionName: ref(logicalId),
    Qualifier: alias ? alias.name : "$LATEST",
    DestinationConfig: destinations,
    MaximumEventAgeInSeconds: resolved.MaximumEventAgeInSeconds,
    MaximumRetryAttempts: resolved.MaximumRetryAttempts,
  }, attributes);
  return { resources, policies };
}
