import { cfnResource, eventError, getAtt, isObject, passthroughAttributes, ref, type JsonObject } from "../common.js";
import { eventPermission, readEventProperties, type EventSpec, type EventTarget } from "./common.js";

const SCHEDULE_SPEC: EventSpec = {
  Schedule: { type: "string", required: true },
  RuleName: { type: "string" },
  Input: { type: "string" },
  Enabled: { type: "boolean" },
  State: { type: "string" },
  Name: { type: "string" },
  Description: { type: "string" },
  DeadLetterConfig: { type: "map" },
  RetryPolicy: { type: "map" },
};

const CLOUDWATCH_EVENT_SPEC: EventSpec = {
  EventBusName: { type: "string" },
  RuleName: { type: "string" },
  Pattern: { type: "map" },
  DeadLetterConfig: { type: "map" },
  RetryPolicy: { type: "map" },
  Input: { type: "string" },
  InputPath: { type: "string" },
  Target: { type: "map" },
  Enabled: { type: "boolean" },
  State: { type: "string" },
  InputTransformer: { type: "map" },
};

export const RULE_EVENT_TYPES = ["Schedule", "CloudWatchEvent", "EventBridgeRule"];

export const readRuleEvent = (eventLogicalId: string, eventType: string, event: JsonObject): JsonObject =>
  readEventProperties(eventLogicalId, eventType, event, eventType === "Schedule" ? SCHEDULE_SPEC : CLOUDWATCH_EVENT_SPEC);

const TARGET_ID_LIMIT = 64;
const LAMBDA_TARGET_SUFFIX = "LambdaTarget";

/** generate_valid_target_id: `<id><suffix>`, truncated to the 64-character Target Id limit. */
export function targetId(logicalId: string, suffix = LAMBDA_TARGET_SUFFIX): string {
  return logicalId.length + suffix.length <= TARGET_ID_LIMIT ? `${logicalId}${suffix}` : `${logicalId.slice(0, TARGET_ID_LIMIT - suffix.length)}${suffix}`;
}

/** EventBridgeRuleUtils.validate_dlq_config. */
export function validateDeadLetterConfig(logicalId: string, config: JsonObject): void {
  const hasArn = Object.hasOwn(config, "Arn");
  const hasType = Object.hasOwn(config, "Type");
  if (hasArn && hasType) throw eventError(logicalId, "You can either define 'Arn' or 'Type' property of DeadLetterConfig.");
  if (hasType && config.Type !== "SQS") throw eventError(logicalId, "The only valid value for 'Type' property of DeadLetterConfig is 'SQS'.");
  if (!hasArn && !hasType) throw eventError(logicalId, "No 'Arn' or 'Type' property provided for DeadLetterConfig.");
}

/** The dead-letter queue ARN, generating `<F><Event>Queue` and its `<F><Event>QueuePolicy` when DeadLetterConfig has a Type. */
export function deadLetterQueue(logicalId: string, config: JsonObject, ruleArn: unknown, attributes: JsonObject, output: Record<string, JsonObject>): unknown {
  if (config.Arn !== undefined && config.Arn !== null) return config.Arn;
  const queueLogicalId = config.QueueLogicalId;
  if (queueLogicalId !== undefined && queueLogicalId !== null && typeof queueLogicalId !== "string") throw eventError(logicalId, "QueueLogicalId must be a string");
  const queueId = typeof queueLogicalId === "string" && queueLogicalId ? queueLogicalId : `${logicalId}Queue`;
  const queueArn = getAtt(queueId, "Arn");
  output[queueId] = cfnResource("AWS::SQS::Queue", {}, attributes, true);
  output[`${logicalId}QueuePolicy`] = cfnResource("AWS::SQS::QueuePolicy", {
    PolicyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "sqs:SendMessage", Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": ruleArn } } }],
    },
    Queues: [ref(queueId)],
  }, attributes);
  return queueArn;
}

function ruleState(eventId: string, properties: JsonObject): unknown {
  if (properties.State && properties.Enabled !== undefined && properties.Enabled !== null) throw eventError(eventId, "State and Enabled Properties cannot both be specified.");
  if (properties.Enabled !== undefined && properties.Enabled !== null) return properties.Enabled ? "ENABLED" : "DISABLED";
  return properties.State || undefined;
}

/**
 * Schedule, CloudWatchEvent, and EventBridgeRule events: the `<F><Event>`
 * rule with a `<F><Event>LambdaTarget` target, its permission, and an
 * optional generated dead-letter queue.
 */
export function translateRuleEvent(target: EventTarget, eventId: string, eventType: string, properties: JsonObject): Record<string, JsonObject> {
  const logicalId = `${target.functionLogicalId}${eventId}`;
  const attributes = passthroughAttributes(target.fn);
  const ruleArn = getAtt(logicalId, "Arn");
  const output: Record<string, JsonObject> = {};
  const schedule = eventType === "Schedule";
  const rule: JsonObject = schedule
    ? { ScheduleExpression: properties.Schedule }
    : { EventBusName: properties.EventBusName, EventPattern: properties.Pattern, Name: properties.RuleName };
  // Schedule checks State before the dead-letter queue; the rule events after.
  if (schedule) {
    rule.State = ruleState(eventId, properties);
    rule.Name = properties.Name;
    rule.Description = properties.Description;
  }
  const dlq = properties.DeadLetterConfig;
  let dlqArn: unknown;
  const dlqResources: Record<string, JsonObject> = {};
  if (dlq !== undefined && dlq !== null) {
    validateDeadLetterConfig(logicalId, dlq as JsonObject);
    dlqArn = deadLetterQueue(logicalId, dlq as JsonObject, ruleArn, attributes, dlqResources);
  }
  if (!schedule) rule.State = ruleState(eventId, properties);

  const custom = !schedule && isObject(properties.Target) && Object.hasOwn(properties.Target, "Id") ? properties.Target.Id : undefined;
  const ruleTarget: JsonObject = { Arn: target.functionArn, Id: custom ?? targetId(logicalId) };
  if (properties.Input !== undefined && properties.Input !== null) ruleTarget.Input = properties.Input;
  if (!schedule && properties.InputPath !== undefined && properties.InputPath !== null) ruleTarget.InputPath = properties.InputPath;
  if (dlq !== undefined && dlq !== null) ruleTarget.DeadLetterConfig = { Arn: dlqArn };
  if (properties.RetryPolicy !== undefined && properties.RetryPolicy !== null) ruleTarget.RetryPolicy = properties.RetryPolicy;
  if (!schedule && properties.InputTransformer !== undefined && properties.InputTransformer !== null) ruleTarget.InputTransformer = properties.InputTransformer;
  rule.Targets = [ruleTarget];

  // SAM lists a Schedule's rule first; the rule events list the queue first.
  if (schedule) output[logicalId] = cfnResource("AWS::Events::Rule", rule, attributes);
  Object.assign(output, dlqResources);
  if (!schedule) output[logicalId] = cfnResource("AWS::Events::Rule", rule, attributes);
  const [permissionId, permission] = eventPermission(target, logicalId, "events.amazonaws.com", { SourceArn: ruleArn });
  output[permissionId] = permission;
  return output;
}
