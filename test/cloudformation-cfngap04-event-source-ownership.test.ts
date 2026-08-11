import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { CFN09_OWNER_TAG, ownerValue } from "../src/cloudformation/providers/cfn09-common.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { createLambdaEventSourceMappingProvider } from "../src/cloudformation/providers/lambda-event-configuration.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";
import { AttachRolePolicyCommand, CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import {
  CreateEventSourceMappingCommand,
  CreateFunctionCommand,
  GetEventSourceMappingCommand,
  GetFunctionConfigurationCommand,
  LambdaClient,
  TagResourceCommand,
} from "@aws-sdk/client-lambda";
import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const identity: PrincipalContext = { principalType: "root", accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };

function context(): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/cfngap04-owner/stack-id`,
    logicalId: "Mapping",
    operationId: "cfngap04-operation",
    resourceOperationId: "cfngap04-resource-operation",
    idempotencyKey: "cfngap04-operation:Mapping:read",
    deadlineAt: Date.now() + 60_000,
    principal: { identity },
  };
}

async function waitForFunction(lambda: LambdaClient): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "cfngap04-consumer" }))).State === "Active") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for CFNGAP-04 function");
}

async function waitForMapping(lambda: LambdaClient, uuid: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = (await lambda.send(new GetEventSourceMappingCommand({ UUID: uuid }))).State;
    if (state === "Enabled" || state === "Disabled") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for CFNGAP-04 event source mapping");
}

test("CFNGAP-04 EventSourceMapping read requires the CloudFormation owner tag across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfngap04-mapping-owner-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  let clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    let options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    let iam = new IAMClient(options);
    let lambda = new LambdaClient(options);
    let sqs = new SQSClient(options);
    clients.push(iam, lambda, sqs);

    const queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "cfngap04-source" }))).QueueUrl!;
    const queueArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
    const role = await iam.send(new CreateRoleCommand({
      RoleName: "cfngap04-lambda-role",
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }),
    }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: "cfngap04-lambda-role", PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole" }));
    await lambda.send(new CreateFunctionCommand({
      FunctionName: "cfngap04-consumer",
      Runtime: "nodejs22.x",
      Role: role.Role!.Arn!,
      Handler: "index.handler",
      Code: { ZipFile: createZip([{ name: "index.mjs", content: "export async function handler() {}" }]) },
    }));
    await waitForFunction(lambda);
    const mapping = await lambda.send(new CreateEventSourceMappingCommand({
      FunctionName: "cfngap04-consumer",
      EventSourceArn: queueArn,
      BatchSize: 1,
    }));
    await waitForMapping(lambda, mapping.UUID!);

    let provider = createLambdaEventSourceMappingProvider(simulator.lambda);
    const foreign = await provider.read!(mapping.UUID!, context());
    assert.equal(foreign.status, "FAILED");
    if (foreign.status === "FAILED") assert.equal(foreign.errorCode, "OwnershipConflict");

    await lambda.send(new TagResourceCommand({
      Resource: mapping.EventSourceMappingArn!,
      Tags: { [CFN09_OWNER_TAG]: ownerValue(context()) },
    }));
    assert.equal((await provider.read!(mapping.UUID!, context())).status, "SUCCESS");

    clients.forEach(client => client.destroy());
    clients = [];
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
    await simulator.start();
    options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    lambda = new LambdaClient(options);
    clients.push(lambda);
    provider = createLambdaEventSourceMappingProvider(simulator.lambda);
    assert.equal((await provider.read!(mapping.UUID!, context())).status, "SUCCESS");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
