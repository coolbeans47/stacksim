import { canonicalJson, cfnResource, eventError, isIntrinsic, isObject, passthroughAttributes, ref, type JsonObject } from "../common.js";
import { awsManagedPolicyArn } from "../policies.js";
import { pick, readEventProperties, truthy, type EventSpec, type EventTarget } from "./common.js";

const sameJson = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

/** Add a managed policy ARN to the generated role unless it is already there. */
export function linkManagedPolicy(role: JsonObject | undefined, arn: string): void {
  if (!role) return;
  const properties = role.Properties as JsonObject;
  const managed = (properties.ManagedPolicyArns ??= []) as unknown[];
  if (!managed.some(existing => sameJson(existing, arn))) managed.push(arn);
}

/** Add an inline policy to the generated role unless the same document is already there (PullEventSource._link_policy). */
export function linkRolePolicy(role: JsonObject | undefined, policy: JsonObject): void {
  if (!role) return;
  const properties = role.Properties as JsonObject;
  const policies = (properties.Policies ??= []) as unknown[];
  if (policies.some(existing => sameJson(existing, policy))) return;
  if (policies.some(existing => sameJson(isObject(existing) && existing.PolicyDocument !== undefined ? existing.PolicyDocument : {}, policy.PolicyDocument))) return;
  policies.push(policy);
}

export const sqsSendMessagePolicy = (queueArn: unknown, logicalId: string): JsonObject => ({
  PolicyName: `${logicalId}SQSPolicy`,
  PolicyDocument: { Statement: [{ Action: "sqs:SendMessage", Effect: "Allow", Resource: queueArn }] },
});

export const snsPublishPolicy = (topicArn: unknown, logicalId: string): JsonObject => ({
  PolicyName: `${logicalId}SNSPolicy`,
  PolicyDocument: { Statement: [{ Action: "sns:publish", Effect: "Allow", Resource: topicArn }] },
});

export const s3SendEventPayloadPolicy = (bucketArn: unknown, logicalId: string): JsonObject => ({
  PolicyName: `${logicalId}S3Policy`,
  PolicyDocument: {
    Statement: [
      { Action: "s3:PutObject", Effect: "Allow", Resource: { "Fn::Join": ["/", [bucketArn, "*"]] } },
      { Action: "s3:ListBucket", Effect: "Allow", Resource: bucketArn },
    ],
  },
});

/** Every property PullEventSource defines; SQS and DynamoDB add their source property. */
const PULL_SPEC: EventSpec = {
  BatchSize: { type: "integer" },
  StartingPosition: { type: "passthrough" },
  StartingPositionTimestamp: { type: "passthrough" },
  Enabled: { type: "boolean" },
  MaximumBatchingWindowInSeconds: { type: "integer" },
  MaximumRetryAttempts: { type: "integer" },
  BisectBatchOnFunctionError: { type: "boolean" },
  MaximumRecordAgeInSeconds: { type: "integer" },
  DestinationConfig: { type: "map" },
  ParallelizationFactor: { type: "integer" },
  Topics: { type: "list" },
  Queues: { type: "list" },
  SourceAccessConfigurations: { type: "list" },
  SecretsManagerKmsKeyId: { type: "string" },
  TumblingWindowInSeconds: { type: "integer" },
  FunctionResponseTypes: { type: "list" },
  KafkaBootstrapServers: { type: "list" },
  FilterCriteria: { type: "map" },
  KmsKeyArn: { type: "passthrough" },
  ConsumerGroupId: { type: "string" },
  ScalingConfig: { type: "map" },
  ProvisionedPollerConfig: { type: "map" },
  SchemaRegistryConfig: { type: "map" },
  MetricsConfig: { type: "map" },
  LoggingConfig: { type: "map" },
};

interface PullSource {
  readonly spec: EventSpec;
  readonly sourceProperty: string;
  readonly policy: string;
}

export const PULL_SOURCES: Readonly<Record<string, PullSource>> = {
  SQS: { spec: { ...PULL_SPEC, Queue: { type: "passthrough", required: true } }, sourceProperty: "Queue", policy: "AWSLambdaSQSQueueExecutionRole" },
  DynamoDB: { spec: { ...PULL_SPEC, Stream: { type: "passthrough", required: true }, StartingPosition: { type: "passthrough", required: true } }, sourceProperty: "Stream", policy: "AWSLambdaDynamoDBExecutionRole" },
};

/** The event source mapping properties SAM copies, in its order. Coverage rejects the rest before translation. */
const MAPPING_PROPERTIES = [
  "StartingPosition", "BatchSize", "Enabled", "MaximumBatchingWindowInSeconds", "MaximumRetryAttempts", "BisectBatchOnFunctionError",
  "MaximumRecordAgeInSeconds", "ParallelizationFactor", "TumblingWindowInSeconds", "FunctionResponseTypes", "FilterCriteria", "ScalingConfig",
];

const FILTERING_TYPES = ["DocumentDB", "DynamoDB", "Kinesis", "MQ", "MSK", "SelfManagedKafka", "SQS"];

/** PullEventSource.to_cloudformation: `<F><Event>` event source mapping, plus role policies. */
export function translatePullEvent(target: EventTarget, eventId: string, eventType: string, properties: JsonObject, logicalId = `${target.functionLogicalId}${eventId}`): Record<string, JsonObject> {
  const source = PULL_SOURCES[eventType];
  const mapping: JsonObject = {
    FunctionName: target.functionName,
    EventSourceArn: properties[source.sourceProperty],
    ...pick(properties, MAPPING_PROPERTIES),
  };
  const filter = properties.FilterCriteria;
  if (truthy(filter) && !isIntrinsic(filter)) {
    if (!FILTERING_TYPES.includes(eventType)) throw eventError(eventId, `FilterCriteria is only available for ${FILTERING_TYPES.join(", ")} events.`);
    const keys = Object.keys(filter as JsonObject);
    if (!(keys.length === 0 || (keys.length === 1 && keys[0] === "Filters"))) throw eventError(eventId, "FilterCriteria field has a wrong format");
  }
  let destinationPolicy: JsonObject | undefined;
  if (truthy(properties.DestinationConfig)) {
    const config = properties.DestinationConfig as JsonObject;
    const onFailure = config.OnFailure;
    if (!isObject(onFailure)) throw eventError(logicalId, "Property 'DestinationConfig.OnFailure' should be a map.");
    const type = onFailure.Type;
    if (truthy(type)) {
      // SAM reads Type to choose the role policy and removes it from the mapping.
      delete onFailure.Type;
      if (type === "SQS") destinationPolicy = sqsSendMessagePolicy(onFailure.Destination, logicalId);
      else if (type === "SNS") destinationPolicy = snsPublishPolicy(onFailure.Destination, logicalId);
      else if (type === "S3") destinationPolicy = s3SendEventPayloadPolicy(onFailure.Destination, logicalId);
      else if (type !== "Kafka") throw eventError(logicalId, "The only valid values for 'Type' are 'SQS', 'SNS', 'S3', and 'Kafka'");
    }
    mapping.DestinationConfig = config;
  }
  linkManagedPolicy(target.role, awsManagedPolicyArn(source.policy, target.partition));
  if (destinationPolicy) linkRolePolicy(target.role, destinationPolicy);
  return { [logicalId]: cfnResource("AWS::Lambda::EventSourceMapping", mapping, passthroughAttributes(target.fn), true) };
}

export function readPullEvent(eventLogicalId: string, eventType: string, event: JsonObject): JsonObject {
  return readEventProperties(eventLogicalId, eventType, event, PULL_SOURCES[eventType].spec);
}
