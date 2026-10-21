/** REST API `AWS` integration targets StackSim can dispatch locally. Shared by the REST control plane, the runtime, and the CloudFormation provider so every entry point accepts exactly the same set. */

export type RestAwsIntegrationTarget =
  | { kind: "lambda"; region: string }
  | { kind: "action"; region: string; service: string; action: string }
  | { kind: "s3-path"; region: string; path: string }
  /** `sqs:path/{accountId}/{queueName}`; the SQS action comes from the mapped request (for example `Action=SendMessage`). */
  | { kind: "sqs-path"; region: string; path: string };

/** Action-style targets (`arn:aws:apigateway:{region}:{service}:action/{Action}`) dispatched through a local service. */
export const REST_AWS_INTEGRATION_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  dynamodb: ["PutItem", "GetItem", "UpdateItem", "DeleteItem", "Query", "Scan", "BatchGetItem", "BatchWriteItem", "TransactGetItems", "TransactWriteItems"],
  sqs: ["SendMessage", "SendMessageBatch"],
  sns: ["Publish"],
  events: ["PutEvents"],
  states: ["StartExecution", "StopExecution", "DescribeExecution"],
});

/** Targets AWS supports that StackSim deliberately rejects, with the reason shown to the caller. */
export const REST_AWS_INTEGRATION_BOUNDARIES: Readonly<Record<string, string>> = Object.freeze({
  "states:StartSyncExecution": "StartSyncExecution requires an EXPRESS state machine, and StackSim supports STANDARD state machines only",
});

/** HTTP methods an S3 `path/{bucket}/{key}` integration can use. */
export const REST_AWS_INTEGRATION_S3_METHODS = Object.freeze(["GET", "PUT", "DELETE", "HEAD"]);

export function parseRestAwsIntegrationUri(uri: string): RestAwsIntegrationTarget | { error: string } {
  if (/^arn:aws:apigateway:[a-z0-9-]+:lambda:path\/2015-03-31\/functions\/.+\/invocations$/.test(uri)) return { kind: "lambda", region: uri.split(":")[3] };
  const match = /^arn:aws:apigateway:([a-z0-9-]+):([a-z0-9-]+):(action|path)\/(.+)$/.exec(uri);
  if (!match) return { error: `Invalid AWS integration URI: ${uri}` };
  const [, region, service, style, rest] = match;
  if (service === "s3" && style === "path") return { kind: "s3-path", region, path: rest };
  if (service === "sqs" && style === "path") return { kind: "sqs-path", region, path: rest };
  if (style === "action") {
    const action = rest.split(/[?&]/)[0];
    const boundary = REST_AWS_INTEGRATION_BOUNDARIES[`${service}:${action}`];
    if (boundary) return { error: boundary };
    if (REST_AWS_INTEGRATION_ACTIONS[service]?.includes(action)) return { kind: "action", region, service, action };
  }
  const supported = [...Object.entries(REST_AWS_INTEGRATION_ACTIONS).map(([name, actions]) => `${name} (${actions.join(", ")})`), "s3 path/{bucket}/{key}", "sqs path/{accountId}/{queueName}", "lambda"].join("; ");
  return { error: `StackSim does not support the AWS integration ${service}:${style}/${rest}. Supported targets: ${supported}` };
}
