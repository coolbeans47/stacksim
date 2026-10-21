import { cfnResource, eventError, getAtt, isIntrinsic, isObject, passthroughAttributes, ref, type JsonObject } from "../common.js";
import type { SamContext } from "../context.js";
import { resolveParameterRefs } from "../parameters.js";
import { eventPermission, pick, readEventProperties, truthy, type EventSpec, type EventTarget } from "./common.js";
import { translatePullEvent } from "./pull.js";

const SNS_SPEC: EventSpec = {
  Topic: { type: "string", required: true },
  Region: { type: "string" },
  FilterPolicy: { type: "passthrough" },
  FilterPolicyScope: { type: "passthrough" },
  SqsSubscription: { type: "boolean-or-map" },
  RedrivePolicy: { type: "map" },
};

export const readSnsEvent = (eventLogicalId: string, event: JsonObject): JsonObject => readEventProperties(eventLogicalId, "SNS", event, SNS_SPEC);

/** SQSQueuePolicies.sns_topic_send_message_role_policy. */
const topicSendMessagePolicy = (topicArn: unknown, queueArn: unknown): JsonObject => ({
  Version: "2012-10-17",
  Statement: [{ Action: "sqs:SendMessage", Effect: "Allow", Principal: "*", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": topicArn } } }],
});

/** The logical ID in a Ref or a two-part Fn::GetAtt (get_logical_id_from_intrinsic). */
function intrinsicLogicalId(value: unknown): string | undefined {
  if (!isIntrinsic(value)) return undefined;
  if (typeof value.Ref === "string") return value.Ref;
  const getAtt = value["Fn::GetAtt"];
  if (Array.isArray(getAtt) && getAtt.length === 2 && typeof getAtt[0] === "string") return getAtt[0];
  if (typeof getAtt === "string" && getAtt.split(".").length === 2) return getAtt.split(".")[0];
  return undefined;
}

/** SNS event: a subscription and permission, or the SqsSubscription queue, policy, subscription, and mapping. */
export function translateSnsEvent(context: SamContext, target: EventTarget, eventId: string, properties: JsonObject): Record<string, JsonObject> {
  const logicalId = `${target.functionLogicalId}${eventId}`;
  const attributes = passthroughAttributes(target.fn);
  const subscription = (protocol: string, endpoint: unknown): JsonObject => cfnResource("AWS::SNS::Subscription", {
    Protocol: protocol,
    Endpoint: endpoint,
    TopicArn: properties.Topic,
    ...pick(properties, ["Region", "FilterPolicy", "FilterPolicyScope", "RedrivePolicy"]),
  }, attributes);
  const queuePolicy = (queueArn: unknown, queueUrl: unknown): JsonObject => cfnResource("AWS::SQS::QueuePolicy", { PolicyDocument: topicSendMessagePolicy(properties.Topic, queueArn), Queues: [queueUrl] }, attributes);
  const output: Record<string, JsonObject> = {};
  const sqs = properties.SqsSubscription;

  if (!truthy(sqs)) {
    const [permissionId, permission] = eventPermission(target, logicalId, "sns.amazonaws.com", { SourceArn: properties.Topic });
    output[permissionId] = permission;
    output[logicalId] = subscription("lambda", target.functionArn);
    return output;
  }

  if (typeof sqs === "boolean") {
    const topicId = intrinsicLogicalId(properties.Topic);
    const topic = topicId ? context.resources[topicId] : undefined;
    const fifo = isObject(topic) && isObject(topic.Properties) ? resolveParameterRefs(topic.Properties.FifoTopic ?? false, context.parameters) : false;
    const queueId = `${logicalId}Queue`;
    const queueArn = getAtt(queueId, "Arn");
    Object.assign(output, translatePullEvent(target, eventId, "SQS", { Queue: queueArn, BatchSize: 10, Enabled: true }, `${logicalId}EventSourceMapping`));
    output[queueId] = cfnResource("AWS::SQS::Queue", truthy(fifo) ? { FifoQueue: fifo } : {}, attributes, true);
    output[`${logicalId}QueuePolicy`] = queuePolicy(queueArn, ref(queueId));
    output[logicalId] = subscription("sqs", queueArn);
    return output;
  }

  const existing = sqs as JsonObject;
  const queueArn = existing.QueueArn;
  const queueUrl = existing.QueueUrl;
  if (!truthy(queueArn) || !truthy(queueUrl)) throw eventError(eventId, "No QueueARN or QueueURL provided.");
  const batchSize = existing.BatchSize;
  Object.assign(output, translatePullEvent(target, eventId, "SQS", { Queue: queueArn, BatchSize: truthy(batchSize) ? batchSize : 10, Enabled: true }, `${logicalId}EventSourceMapping`));
  output[typeof existing.QueuePolicyLogicalId === "string" && existing.QueuePolicyLogicalId ? existing.QueuePolicyLogicalId : `${logicalId}QueuePolicy`] = queuePolicy(queueArn, queueUrl);
  output[logicalId] = subscription("sqs", queueArn);
  return output;
}
