import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CreateEventBusCommand, EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import {
  CreateFunctionCommand,
  GetFunctionConfigurationCommand,
  GetFunctionEventInvokeConfigCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import { CreateTopicCommand, SNSClient } from "@aws-sdk/client-sns";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const code = createZip([{ name: "index.mjs", content: "export async function handler(event) { return event; }" }]);

async function waitForFunction(lambda: LambdaClient, name: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }))).State === "Active") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for Lambda function ${name}`);
}

async function waitForStack(cloudformation: CloudFormationClient, stack: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if ((await cloudformation.send(new DescribeStacksCommand({ StackName: stack }))).Stacks?.[0]?.StackStatus === expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for stack ${stack} to reach ${expected}`);
}

test("CFNGAP-02 CloudFormation EventInvokeConfig accepts SNS and EventBridge buses but rejects S3", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfngap02-invoke-destinations-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  let clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    let endpoint = `http://127.0.0.1:${simulator.port}`;
    let options = { endpoint, region, credentials, maxAttempts: 1 };
    let cloudformation = new CloudFormationClient(options);
    let events = new EventBridgeClient(options);
    let iam = new IAMClient(options);
    let lambda = new LambdaClient(options);
    let sns = new SNSClient(options);
    clients.push(cloudformation, events, iam, lambda, sns);

    const topicArn = (await sns.send(new CreateTopicCommand({ Name: "cfngap02-destination" }))).TopicArn!;
    const busArn = (await events.send(new CreateEventBusCommand({ Name: "cfngap02-destination" }))).EventBusArn!;
    const role = await iam.send(new CreateRoleCommand({
      RoleName: "cfngap02-lambda-role",
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }),
    }));
    await lambda.send(new CreateFunctionCommand({
      FunctionName: "cfngap02-source",
      Runtime: "nodejs22.x",
      Role: role.Role!.Arn!,
      Handler: "index.handler",
      Code: { ZipFile: code },
    }));
    await waitForFunction(lambda, "cfngap02-source");

    const template = (destinations: { success: string; failure: string }) => JSON.stringify({ Resources: {
      Config: {
        Type: "AWS::Lambda::EventInvokeConfig",
        Properties: {
          FunctionName: "cfngap02-source",
          Qualifier: "$LATEST",
          MaximumRetryAttempts: 0,
          DestinationConfig: {
            OnSuccess: { Destination: destinations.success },
            OnFailure: { Destination: destinations.failure },
          },
        },
      },
    } });

    const created = await cloudformation.send(new CreateStackCommand({
      StackName: "cfngap02-destinations",
      TemplateBody: template({ success: topicArn, failure: busArn }),
    }));
    await waitForStack(cloudformation, created.StackId!, "CREATE_COMPLETE");
    const configured = await lambda.send(new GetFunctionEventInvokeConfigCommand({ FunctionName: "cfngap02-source", Qualifier: "$LATEST" }));
    assert.equal(configured.DestinationConfig?.OnSuccess?.Destination, topicArn);
    assert.equal(configured.DestinationConfig?.OnFailure?.Destination, busArn);

    await assert.rejects(
      cloudformation.send(new CreateStackCommand({
        StackName: "cfngap02-s3-rejected",
        TemplateBody: template({ success: "arn:aws:s3:::unsupported-destination", failure: busArn }),
      })),
      error => /S3|destination|Lambda.*SQS.*SNS.*EventBridge/i.test((error as Error).message),
    );
    assert.equal(simulator.store.regionState(region).cloudformation.stackNames["cfngap02-s3-rejected"], undefined);

    clients.forEach(client => client.destroy());
    clients = [];
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
    await simulator.start();
    endpoint = `http://127.0.0.1:${simulator.port}`;
    options = { endpoint, region, credentials, maxAttempts: 1 };
    lambda = new LambdaClient(options);
    clients.push(lambda);
    const restarted = await lambda.send(new GetFunctionEventInvokeConfigCommand({ FunctionName: "cfngap02-source", Qualifier: "$LATEST" }));
    assert.equal(restarted.DestinationConfig?.OnSuccess?.Destination, topicArn);
    assert.equal(restarted.DestinationConfig?.OnFailure?.Destination, busArn);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
