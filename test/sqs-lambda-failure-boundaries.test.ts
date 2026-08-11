import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateTableCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { AttachRolePolicyCommand, CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateEventSourceMappingCommand, CreateFunctionCommand, GetFunctionConfigurationCommand, InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import type { LambdaSqsMessageAttributeValue, LambdaSqsQueueDescriptor, LambdaSqsServicePort } from "../src/lambda-sqs-event-source.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

class FailureBoundarySqsPort implements LambdaSqsServicePort {
  readonly queues = new Map<string, LambdaSqsQueueDescriptor>();
  readonly deliveries: Array<{ queueArn: string; input: { MessageBody: string; MessageAttributes?: Record<string, LambdaSqsMessageAttributeValue> } }> = [];
  failNextDeliveries = 0;

  queue(name: string): LambdaSqsQueueDescriptor {
    const queueArn = `arn:aws:sqs:${region}:${account}:${name}`;
    const descriptor = { queueArn, queueUrl: `http://localhost/queue/${account}/${name}`, visibilityTimeoutSeconds: 30 };
    this.queues.set(queueArn, descriptor); return descriptor;
  }

  resolveQueueArn(queueArn: string): LambdaSqsQueueDescriptor | undefined { return this.queues.get(queueArn); }
  async receiveForConsumer(): Promise<{ messages: [] }> { return { messages: [] }; }
  async acknowledge(): Promise<void> {}
  async sendMessageToArn(queueArn: string, input: { MessageBody: string; MessageAttributes?: Record<string, LambdaSqsMessageAttributeValue> }): Promise<unknown> {
    if (!this.queues.has(queueArn)) throw new Error("queue missing");
    if (this.failNextDeliveries > 0) { this.failNextDeliveries--; throw new Error("injected SQS delivery interruption"); }
    this.deliveries.push({ queueArn, input: structuredClone(input) }); return { MessageId: `delivery-${this.deliveries.length}` };
  }
}

const code = createZip([{ name: "index.mjs", content: `
export async function streamFailure() { throw new Error("intentional stream failure"); }
export async function durableFailure() { return { Status: "FAILED", Error: { ErrorType: "DurableTestFailure", ErrorMessage: "intentional durable failure" } }; }
` }]);

async function active(lambda: LambdaClient, functionName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }))).State === "Active") return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Function ${functionName} did not become active`);
}

async function pump(clock: TestClock, accept: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!accept()) { if (Date.now() >= deadline) throw new Error("Timed out waiting for Lambda failure delivery"); clock.advance(250); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test("DynamoDB stream OnFailure sends a bounded SQS discarded-record envelope and checks the execution role", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-sqs-failure-")); const clock = new TestClock(Date.now()); const sqs = new FailureBoundarySqsPort(); const destination = sqs.queue("discarded-records"); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce", cdkBootstrap: true }); const clients: Array<{ destroy(): void }> = [];
  try {
    simulator.lambda.setSqsService(sqs); await simulator.start(); const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }; const iam = new IAMClient(options); const lambda = new LambdaClient(options); const dynamodb = new DynamoDBClient(options); clients.push(iam, lambda, dynamodb);
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }); const createdRole = await iam.send(new CreateRoleCommand({ RoleName: "stream-discard-role", AssumeRolePolicyDocument: trust })); const roleArn = createdRole.Role!.Arn!;
    await iam.send(new AttachRolePolicyCommand({ RoleName: "stream-discard-role", PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaDynamoDBExecutionRole" }));
    const source = await dynamodb.send(new CreateTableCommand({ TableName: "DiscardSource", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" } })); const streamArn = source.TableDescription!.LatestStreamArn!;
    await waitForTableActive(dynamodb, "DiscardSource", clock);
    await lambda.send(new CreateFunctionCommand({ FunctionName: "discard-consumer", Runtime: "nodejs22.x", Role: roleArn, Handler: "index.streamFailure", Timeout: 1, Code: { ZipFile: code } })); await active(lambda, "discard-consumer");
    await assert.rejects(lambda.send(new CreateEventSourceMappingCommand({ FunctionName: "discard-consumer", EventSourceArn: streamArn, StartingPosition: "LATEST", MaximumRetryAttempts: 0, DestinationConfig: { OnFailure: { Destination: destination.queueArn } } })), (error: any) => error.name === "InvalidParameterValueException" && /not authorized to send discarded records/.test(error.message));
    await iam.send(new PutRolePolicyCommand({ RoleName: "stream-discard-role", PolicyName: "send-discarded-records", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: destination.queueArn }] }) }));
    const mapping = await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: "discard-consumer", EventSourceArn: streamArn, StartingPosition: "LATEST", BatchSize: 1, MaximumRetryAttempts: 0, DestinationConfig: { OnFailure: { Destination: destination.queueArn } } })); assert.equal(mapping.DestinationConfig?.OnFailure?.Destination, destination.queueArn); clock.advance(0);
    await dynamodb.send(new PutItemCommand({ TableName: "DiscardSource", Item: { id: { S: "poison" }, value: { S: "original" } } }));
    await pump(clock, () => sqs.deliveries.length === 1); const delivery = sqs.deliveries[0]; assert.equal(delivery.queueArn, destination.queueArn); const envelope = JSON.parse(delivery.input.MessageBody); assert.equal(envelope.version, "1.0"); assert.equal(envelope.requestContext.condition, "RetryAttemptsExhausted"); assert.equal(envelope.requestContext.functionArn, mapping.FunctionArn); assert.equal(envelope.requestPayload.Records[0].dynamodb.Keys.id.S, "poison"); assert.equal(envelope.responseContext.functionError, "Unhandled"); assert.equal(envelope.responsePayload.eventSourceMappingArn, mapping.EventSourceMappingArn); assert.ok(Buffer.byteLength(delivery.input.MessageBody) < 1024 * 1024);
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("terminal durable execution dead-letter delivery is authorized, restart-safe, and uses the original input", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-durable-sqs-failure-")); const clock = new TestClock(Date.now()); const sqs = new FailureBoundarySqsPort(); const destination = sqs.queue("durable-dead-letter"); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce", cdkBootstrap: true }); let lambda: LambdaClient | undefined; let iam: IAMClient | undefined;
  const connect = () => { const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }; lambda = new LambdaClient(options); iam = new IAMClient(options); };
  try {
    simulator.lambda.setSqsService(sqs); await simulator.start(); connect(); const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }); const createdRole = await iam!.send(new CreateRoleCommand({ RoleName: "durable-dead-letter-role", AssumeRolePolicyDocument: trust })); const roleArn = createdRole.Role!.Arn!;
    await iam!.send(new AttachRolePolicyCommand({ RoleName: "durable-dead-letter-role", PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" })); await iam!.send(new PutRolePolicyCommand({ RoleName: "durable-dead-letter-role", PolicyName: "send-durable-dead-letter", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: destination.queueArn }] }) }));
    await lambda!.send(new CreateFunctionCommand({ FunctionName: "durable-dead-letter", Runtime: "nodejs22.x", Role: roleArn, Handler: "index.durableFailure", Timeout: 1, Publish: true, DurableConfig: { ExecutionTimeout: 60 }, DeadLetterConfig: { TargetArn: destination.queueArn }, Code: { ZipFile: code } })); await active(lambda!, "durable-dead-letter");
    sqs.failNextDeliveries = 1; const original = { orderId: "order-123", attempt: 4 }; const invoked = await lambda!.send(new InvokeCommand({ FunctionName: "durable-dead-letter", Qualifier: "1", InvocationType: "Event", DurableExecutionName: "restart-safe-dead-letter", Payload: Buffer.from(JSON.stringify(original)) })); const executionArn = invoked.DurableExecutionArn!;
    await pump(clock, () => {
      const delivery = simulator.store.regionState(region).lambdaDurableExecutions[executionArn]?.deadLetterDelivery;
      return delivery?.attempts === 1 && /injected SQS delivery interruption/.test(delivery.lastError ?? "");
    }); const pending = simulator.store.regionState(region).lambdaDurableExecutions[executionArn]; assert.equal(pending.status, "FAILED"); assert.equal(pending.deadLetterDelivery?.status, "PENDING"); assert.match(pending.deadLetterDelivery?.lastError ?? "", /injected SQS delivery interruption/); assert.equal(sqs.deliveries.length, 0);
    lambda!.destroy(); iam!.destroy(); lambda = undefined; iam = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce", cdkBootstrap: true }); simulator.lambda.setSqsService(sqs); await simulator.start(); connect();
    clock.advance(1_000); await pump(clock, () => sqs.deliveries.length === 1); const delivery = sqs.deliveries[0]; assert.equal(delivery.queueArn, destination.queueArn); assert.deepEqual(JSON.parse(delivery.input.MessageBody), original); assert.match(delivery.input.MessageAttributes?.RequestID.StringValue ?? "", /^[a-f0-9]{32}$/); assert.equal(delivery.input.MessageAttributes?.ErrorCode.StringValue, "DurableTestFailure"); assert.match(delivery.input.MessageAttributes?.ErrorMessage.StringValue ?? "", /intentional durable failure/); assert.equal(simulator.store.regionState(region).lambdaDurableExecutions[executionArn].deadLetterDelivery?.status, "DELIVERED");
  } finally { lambda?.destroy(); iam?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
