import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateTableCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { AttachRolePolicyCommand, CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  CreateEventSourceMappingCommand,
  CreateFunctionCommand,
  GetFunctionConfigurationCommand,
  InvokeCommand,
  LambdaClient,
  PutFunctionEventInvokeConfigCommand,
} from "@aws-sdk/client-lambda";
import { CreateTopicCommand, SNSClient, SubscribeCommand } from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const code = createZip([{ name: "index.mjs", content: `
export async function success(event) { return { accepted: event.id }; }
export async function failure() { throw new Error("intentional stream failure"); }
` }]);

async function active(lambda: LambdaClient, name: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }))).State === "Active") return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Function ${name} did not become active`);
}

async function receiveJson(sqs: SQSClient, queueUrl: string, clock: TestClock, accept: (value: any) => boolean): Promise<any> {
  for (let attempt = 0; attempt < 400; attempt++) {
    clock.advance(250);
    await new Promise(resolve => setTimeout(resolve, 8));
    const messages = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, VisibilityTimeout: 1 }))).Messages ?? [];
    for (const message of messages) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
      try {
        const value = JSON.parse(message.Body!);
        if (accept(value)) return value;
      } catch {}
    }
  }
  throw new Error("Timed out waiting for Lambda publication through SNS");
}

test("SNS-03 Lambda async and DynamoDB Streams discarded-record destinations publish under the Lambda execution role", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns03-lambda-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, systemClockOffset: clock.now() - Date.now() };
    const sns = new SNSClient(options); const sqs = new SQSClient(options); const lambda = new LambdaClient(options);
    const iam = new IAMClient(options); const dynamodb = new DynamoDBClient(options);
    clients.push(sns, sqs, lambda, iam, dynamodb);

    const topicArn = (await sns.send(new CreateTopicCommand({ Name: "lambda-destinations" }))).TopicArn!;
    const queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "lambda-destinations" }))).QueueUrl!;
    const queueArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: {
      Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": topicArn } } }] }),
    } }));
    await sns.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: "sqs", Endpoint: queueArn, Attributes: { RawMessageDelivery: "true" } }));

    const roleName = "sns03-lambda-role";
    const role = await iam.send(new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaDynamoDBExecutionRole" }));
    await iam.send(new PutRolePolicyCommand({ RoleName: roleName, PolicyName: "PublishSnsDestinations", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sns:Publish", Resource: topicArn }] }) }));

    await lambda.send(new CreateFunctionCommand({ FunctionName: "sns03-async", Runtime: "nodejs22.x", Role: role.Role!.Arn!, Handler: "index.success", Timeout: 3, Code: { ZipFile: code } }));
    await active(lambda, "sns03-async");
    await lambda.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "sns03-async", MaximumRetryAttempts: 0, DestinationConfig: { OnSuccess: { Destination: topicArn } } }));
    await lambda.send(new InvokeCommand({ FunctionName: "sns03-async", InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ id: "async-success" })) }));
    let asyncRecord: any;
    try { asyncRecord = await receiveJson(sqs, queueUrl, clock, value => value.requestContext?.condition === "Success"); }
    catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; async=${JSON.stringify(simulator.store.regionState(region).lambdaAsyncInvocations)}; sns=${JSON.stringify(await simulator.sns.deliveryDiagnostics())}`);
    }
    assert.deepEqual(asyncRecord.requestPayload, { id: "async-success" });
    assert.deepEqual(asyncRecord.responsePayload, { accepted: "async-success" });

    const table = await dynamodb.send(new CreateTableCommand({ TableName: "SnsDiscardSource", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" } }));
    await waitForTableActive(dynamodb, "SnsDiscardSource", clock);
    await lambda.send(new CreateFunctionCommand({ FunctionName: "sns03-discard", Runtime: "nodejs22.x", Role: role.Role!.Arn!, Handler: "index.failure", Timeout: 3, Code: { ZipFile: code } }));
    await active(lambda, "sns03-discard");
    const mapping = await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: "sns03-discard", EventSourceArn: table.TableDescription!.LatestStreamArn!, StartingPosition: "LATEST", BatchSize: 1, MaximumRetryAttempts: 0, DestinationConfig: { OnFailure: { Destination: topicArn } } }));
    clock.advance(0); await new Promise(resolve => setImmediate(resolve));
    await dynamodb.send(new PutItemCommand({ TableName: "SnsDiscardSource", Item: { id: { S: "discard-me" } } }));
    const discarded = await receiveJson(sqs, queueUrl, clock, value => value.requestContext?.condition === "RetryAttemptsExhausted");
    assert.equal(discarded.requestContext.functionArn, mapping.FunctionArn);
    assert.equal(discarded.requestPayload.Records[0].dynamodb.Keys.id.S, "discard-me");
    assert.equal(discarded.responsePayload.eventSourceMappingArn, mapping.EventSourceMappingArn);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
