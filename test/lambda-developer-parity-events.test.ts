import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand, PutRuleCommand, PutTargetsCommand } from "@aws-sdk/client-eventbridge";
import { AttachRolePolicyCommand, CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  AddPermissionCommand,
  CreateEventSourceMappingCommand,
  CreateFunctionCommand,
  GetEventSourceMappingCommand,
  InvokeCommand,
  LambdaClient,
  PutFunctionConcurrencyCommand,
  PutFunctionEventInvokeConfigCommand,
  RemovePermissionCommand,
  UpdateEventSourceMappingCommand,
} from "@aws-sdk/client-lambda";
import { CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, PutBucketNotificationConfigurationCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

// LDP-04 rows of lambda-developer-parity-gaps.md: asynchronous invocation,
// destinations, event source mappings, and the service-invoke policy path.

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const testRole = `arn:aws:iam::${account}:role/test`;

interface Clients { endpoint: string; simulator: StackSim; lambda: LambdaClient; sqs: SQSClient; s3: S3Client; logs: CloudWatchLogsClient; dynamodb: DynamoDBClient; iam: IAMClient; events: EventBridgeClient }

async function withSimulator(prefix: string, options: { authMode?: "off" | "enforce"; clock?: TestClock }, run: (clients: Clients) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `stacksim-${prefix}-`));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: options.authMode ?? "off", ...(options.clock ? { clock: options.clock } : {}), cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const common = { endpoint, region, credentials, ...(options.clock ? { systemClockOffset: options.clock.now() - Date.now() } : {}) };
    const made = { endpoint, simulator, lambda: new LambdaClient(common), sqs: new SQSClient(common), s3: new S3Client({ ...common, forcePathStyle: true }), logs: new CloudWatchLogsClient(common), dynamodb: new DynamoDBClient(common), iam: new IAMClient(common), events: new EventBridgeClient(common) };
    clients.push(made.lambda, made.sqs, made.s3, made.logs, made.dynamodb, made.iam, made.events);
    await run(made);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const inline = (content: string, name = "index.mjs") => createZip([{ name, content }]);
const payloadOf = (result: { Payload?: Uint8Array }) => JSON.parse(Buffer.from(result.Payload!).toString("utf8"));

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function createQueue(sqs: SQSClient, name: string): Promise<{ url: string; arn: string }> {
  const url = (await sqs.send(new CreateQueueCommand({ QueueName: name }))).QueueUrl!;
  const arn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
  return { url, arn };
}

async function receiveOne(sqs: SQSClient, url: string): Promise<{ body: any; attributes: Record<string, { StringValue?: string }> }> {
  return until(async () => {
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 1, WaitTimeSeconds: 1, MessageAttributeNames: ["All"] }));
    const message = received.Messages?.[0];
    if (!message) return undefined;
    let body: any = message.Body; try { body = JSON.parse(message.Body!); } catch { /* raw body */ }
    return { body, attributes: (message.MessageAttributes ?? {}) as Record<string, { StringValue?: string }> };
  });
}

test("LDG-27: queued asynchronous events run concurrently", async () => {
  await withSimulator("ldg27", {}, async ({ lambda, logs }) => {
    await lambda.send(new CreateFunctionCommand({ FunctionName: "fanout", Runtime: "nodejs22.x", Role: testRole, Handler: "index.handler", Code: { ZipFile: inline("export const handler = async () => { const start = Date.now(); await new Promise(resolve => setTimeout(resolve, 300)); console.log(JSON.stringify({ span: { start, end: Date.now() } })); return 1; };") } }));
    await settle();
    for (let index = 0; index < 3; index++) assert.equal((await lambda.send(new InvokeCommand({ FunctionName: "fanout", InvocationType: "Event", Payload: Buffer.from("{}") }))).StatusCode, 202);
    const spans = await until(async () => {
      let events; try { events = (await logs.send(new FilterLogEventsCommand({ logGroupName: "/aws/lambda/fanout", filterPattern: "span" }))).events ?? []; } catch { return undefined; }
      const parsed = events.map(event => { try { return JSON.parse(event.message!.slice(event.message!.indexOf("{"))).span; } catch { return undefined; } }).filter(Boolean) as Array<{ start: number; end: number }>;
      return parsed.length === 3 ? parsed : undefined;
    });
    assert.ok(Math.max(...spans.map(span => span.start)) < Math.min(...spans.map(span => span.end)), `all three ran at once: ${JSON.stringify(spans)}`);
  });
});

test("LDG-28/35: reserved concurrency 0 dead-letters at once, and the DLQ ErrorMessage is the first KB of the message", async () => {
  await withSimulator("ldg28", {}, async ({ lambda, sqs }) => {
    const reservedDlq = await createQueue(sqs, "reserved-dlq");
    await lambda.send(new CreateFunctionCommand({ FunctionName: "reserved-zero", Runtime: "nodejs22.x", Role: testRole, Handler: "index.handler", DeadLetterConfig: { TargetArn: reservedDlq.arn }, Code: { ZipFile: inline("export const handler = async () => 1;") } }));
    const errorDlq = await createQueue(sqs, "error-dlq");
    await lambda.send(new CreateFunctionCommand({ FunctionName: "long-error", Runtime: "nodejs22.x", Role: testRole, Handler: "index.handler", DeadLetterConfig: { TargetArn: errorDlq.arn }, Code: { ZipFile: inline("export const handler = async () => { throw new Error(\"x\".repeat(3000)); };") } }));
    await settle();
    await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: "reserved-zero", ReservedConcurrentExecutions: 0 }));
    await lambda.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "long-error", MaximumRetryAttempts: 0 }));

    const started = Date.now();
    assert.equal((await lambda.send(new InvokeCommand({ FunctionName: "reserved-zero", InvocationType: "Event", Payload: Buffer.from("{\"hello\":1}") }))).StatusCode, 202);
    const throttled = await receiveOne(sqs, reservedDlq.url);
    assert.ok(Date.now() - started < 5000, "no retry back-off before dead-lettering");
    assert.deepEqual(throttled.body, { hello: 1 });
    assert.equal(throttled.attributes.ErrorCode?.StringValue, "429");

    await lambda.send(new InvokeCommand({ FunctionName: "long-error", InvocationType: "Event", Payload: Buffer.from("{}") }));
    const failed = await receiveOne(sqs, errorDlq.url);
    const message = failed.attributes.ErrorMessage?.StringValue ?? "";
    assert.equal(message.length, 1024);
    assert.ok(message.startsWith("xxxx"), "the attribute is the error message text, not the error payload");
    assert.equal(failed.attributes.ErrorCode?.StringValue, "200");
  });
});

test("LDG-30/31: destinations deliver with enforcement off, and an S3 OnFailure destination stores the record", async () => {
  await withSimulator("ldg30", {}, async ({ lambda, sqs, s3 }) => {
    const success = await createQueue(sqs, "on-success");
    await s3.send(new CreateBucketCommand({ Bucket: "async-failures" }));
    await lambda.send(new CreateFunctionCommand({ FunctionName: "fine", Runtime: "nodejs22.x", Role: testRole, Handler: "index.handler", Code: { ZipFile: inline("export const handler = async event => ({ echoed: event });") } }));
    await lambda.send(new CreateFunctionCommand({ FunctionName: "failing", Runtime: "nodejs22.x", Role: testRole, Handler: "index.handler", Code: { ZipFile: inline("export const handler = async () => { throw new Error(\"nope\"); };") } }));
    await settle();
    // The test role has no sqs:SendMessage policy; with authMode "off" nothing evaluates it.
    await lambda.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "fine", DestinationConfig: { OnSuccess: { Destination: success.arn } } }));
    await lambda.send(new InvokeCommand({ FunctionName: "fine", InvocationType: "Event", Payload: Buffer.from("{\"n\":1}") }));
    const delivered = await receiveOne(sqs, success.url);
    assert.equal(delivered.body.requestContext.condition, "Success");
    assert.deepEqual(delivered.body.responsePayload, { echoed: { n: 1 } });

    await assert.rejects(lambda.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "failing", DestinationConfig: { OnSuccess: { Destination: "arn:aws:s3:::async-failures" } } })), (error: any) => error.name === "InvalidParameterValueException" && /OnFailure/.test(error.message));
    await assert.rejects(lambda.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "failing", DestinationConfig: { OnFailure: { Destination: "arn:aws:s3:::missing-bucket" } } })), (error: any) => error.name === "InvalidParameterValueException" && /does not exist/.test(error.message));
    const configured = await lambda.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "failing", MaximumRetryAttempts: 0, DestinationConfig: { OnFailure: { Destination: "arn:aws:s3:::async-failures" } } }));
    assert.equal(configured.DestinationConfig?.OnFailure?.Destination, "arn:aws:s3:::async-failures");
    await lambda.send(new InvokeCommand({ FunctionName: "failing", InvocationType: "Event", Payload: Buffer.from("{\"n\":2}") }));
    const key = await until(async () => (await s3.send(new ListObjectsV2Command({ Bucket: "async-failures", Prefix: "aws/lambda/async/failing/" }))).Contents?.[0]?.Key);
    assert.match(key, /^aws\/lambda\/async\/failing\/\d{4}\/\d{2}\/\d{2}\/\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}-[0-9a-f-]{36}$/);
    const record = JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket: "async-failures", Key: key }))).Body!.transformToString());
    assert.equal(record.requestContext.condition, "RetriesExhausted");
    assert.deepEqual(record.requestPayload, { n: 2 });
    assert.equal(record.responsePayload.errorMessage, "nope");
  });
});

test("LDG-32/33: mapping states pass through Enabling/Disabling and results use AWS shapes", async () => {
  await withSimulator("ldg33", {}, async ({ lambda, sqs }) => {
    const queue = await createQueue(sqs, "state-queue");
    await lambda.send(new CreateFunctionCommand({ FunctionName: "consumer", Runtime: "nodejs22.x", Role: testRole, Handler: "index.handler", Code: { ZipFile: inline("export const handler = async () => 1;") } }));
    await settle();
    const created = await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: "consumer", EventSourceArn: queue.arn, Enabled: true }));
    assert.equal(created.LastProcessingResult, "No records processed");
    const uuid = created.UUID!;
    const state = async () => (await lambda.send(new GetEventSourceMappingCommand({ UUID: uuid }))).State;
    await until(async () => await state() === "Enabled" ? true : undefined);

    assert.equal((await lambda.send(new UpdateEventSourceMappingCommand({ UUID: uuid, Enabled: false }))).State, "Disabling");
    await until(async () => await state() === "Disabled" ? true : undefined);
    assert.equal((await lambda.send(new UpdateEventSourceMappingCommand({ UUID: uuid, Enabled: true }))).State, "Enabling");
    await until(async () => await state() === "Enabled" ? true : undefined);
    assert.equal((await lambda.send(new UpdateEventSourceMappingCommand({ UUID: uuid, Enabled: true, BatchSize: 5 }))).State, "Updating");
    await until(async () => await state() === "Enabled" ? true : undefined);
  });
});

test("LDG-34: a parallel partial batch failure retries only the failed chunk", async () => {
  const clock = new TestClock(Date.now());
  await withSimulator("ldg34", { clock }, async ({ lambda, dynamodb, logs, simulator }) => {
    // Lifecycle transitions and the stream poller run on the test clock, so every wait advances it.
    const tick = async () => { clock.advance(300); await new Promise(resolve => setTimeout(resolve, 30)); };
    const table = await dynamodb.send(new CreateTableCommand({ TableName: "Chunks", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], StreamSpecification: { StreamEnabled: true, StreamViewType: "KEYS_ONLY" } }));
    for (let attempt = 0; attempt < 40 && (await dynamodb.send(new DescribeTableCommand({ TableName: "Chunks" }))).Table?.TableStatus !== "ACTIVE"; attempt++) await tick();
    await lambda.send(new CreateFunctionCommand({ FunctionName: "chunked", Runtime: "nodejs22.x", Role: testRole, Handler: "index.handler", Code: { ZipFile: inline("export const handler = async event => { for (const record of event.Records) console.log(`record ${record.dynamodb.Keys.id.S}`); return { batchItemFailures: event.Records.filter(record => record.dynamodb.Keys.id.S === \"bad\").map(record => ({ itemIdentifier: record.dynamodb.SequenceNumber })) }; };") } }));
    await settle();
    const mapping = await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: "chunked", EventSourceArn: table.TableDescription!.LatestStreamArn!, StartingPosition: "TRIM_HORIZON", BatchSize: 1, ParallelizationFactor: 2, MaximumRetryAttempts: 1, FunctionResponseTypes: ["ReportBatchItemFailures"] }));
    const internal = () => (simulator.store.regionState() as any).lambdaEventSourceMappings[mapping.UUID!];
    // "bad" lands in the first parallel chunk and "good" in the second of the same poll wave.
    await dynamodb.send(new PutItemCommand({ TableName: "Chunks", Item: { id: { S: "bad" } } }));
    await dynamodb.send(new PutItemCommand({ TableName: "Chunks", Item: { id: { S: "good" } } }));
    for (let attempt = 0; attempt < 40 && internal().lastProcessingResult !== "Partial batch failure"; attempt++) await tick();
    assert.equal(internal().lastProcessingResult, "Partial batch failure");
    assert.equal(internal().pendingBatch.sequenceNumbers.length, 1, "only the failed chunk's record is retried");
    for (let attempt = 0; attempt < 80 && internal().pendingBatch; attempt++) await tick();
    assert.equal(internal().pendingBatch, undefined);
    const messages = ((await logs.send(new FilterLogEventsCommand({ logGroupName: "/aws/lambda/chunked", filterPattern: "record" }))).events ?? []).map(event => event.message!);
    assert.equal(messages.filter(message => message.endsWith("record good")).length, 1, "the succeeded sibling chunk is not re-invoked");
    assert.ok(messages.filter(message => message.endsWith("record bad")).length >= 2, "the failed chunk is retried");
    assert.equal((await lambda.send(new GetEventSourceMappingCommand({ UUID: mapping.UUID! }))).LastProcessingResult, "PROBLEM: Retry attempts exhausted");
  });
});

test("LDG-39: S3 notification keys keep '/' and form-encode spaces, with eventVersion 2.6", async () => {
  await withSimulator("ldg39", {}, async ({ lambda, s3, logs }) => {
    await lambda.send(new CreateFunctionCommand({ FunctionName: "on-object", Runtime: "nodejs22.x", Role: testRole, Handler: "index.handler", Code: { ZipFile: inline("export const handler = async event => { console.log(JSON.stringify({ seen: event.Records.map(record => ({ key: record.s3.object.key, version: record.eventVersion })) })); };") } }));
    await settle();
    await s3.send(new CreateBucketCommand({ Bucket: "keyed" }));
    await s3.send(new PutBucketNotificationConfigurationCommand({ Bucket: "keyed", NotificationConfiguration: { LambdaFunctionConfigurations: [{ Id: "all", LambdaFunctionArn: `arn:aws:lambda:${region}:${account}:function:on-object`, Events: ["s3:ObjectCreated:*"] }] } }));
    await s3.send(new PutObjectCommand({ Bucket: "keyed", Key: "uploads/a b+c.txt", Body: "x" }));
    const seen = await until(async () => {
      let events; try { events = (await logs.send(new FilterLogEventsCommand({ logGroupName: "/aws/lambda/on-object", filterPattern: "seen" }))).events ?? []; } catch { return undefined; }
      const message = events[0]?.message; if (!message) return undefined;
      return JSON.parse(message.slice(message.indexOf("{"))).seen[0];
    });
    assert.deepEqual(seen, { key: "uploads/a+b%2Bc.txt", version: "2.6" });
  });
});

test("LDG-37/38: EventBridge role targets still need the function policy, and stored conditions apply on the service path", async () => {
  await withSimulator("ldg37", { authMode: "enforce" }, async ({ lambda, iam, events, s3, simulator }) => {
    const trust = (service: string, condition?: Record<string, unknown>) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole", ...(condition ? { Condition: condition } : {}) }] });
    const executionRole = await iam.send(new CreateRoleCommand({ RoleName: "parity-execution", AssumeRolePolicyDocument: trust("lambda.amazonaws.com") }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: "parity-execution", PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" }));
    const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "policy-target", Runtime: "nodejs22.x", Role: executionRole.Role!.Arn!, Handler: "index.handler", Code: { ZipFile: inline("export const handler = async () => 1;") } }));
    await settle();

    // LDG-37: a target RoleArn that may invoke the function does not replace the resource-based policy.
    const ruleArn = (await events.send(new PutRuleCommand({ Name: "role-only", EventPattern: JSON.stringify({ source: ["parity"] }) }))).RuleArn!;
    const targetRole = await iam.send(new CreateRoleCommand({ RoleName: "parity-events-target", AssumeRolePolicyDocument: trust("events.amazonaws.com") }));
    await iam.send(new PutRolePolicyCommand({ RoleName: "parity-events-target", PolicyName: "invoke", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: fn.FunctionArn }] }) }));
    assert.equal((await events.send(new PutTargetsCommand({ Rule: "role-only", Targets: [{ Id: "fn", Arn: fn.FunctionArn!, RoleArn: targetRole.Role!.Arn! }] }))).FailedEntryCount, 0);
    const diagnostics = () => (simulator as any).eventbridge.deliveryDiagnostics().diagnostics as Array<{ targetId: string; status: string; errorCode?: string }>;
    await events.send(new PutEventsCommand({ Entries: [{ Source: "parity", DetailType: "first", Detail: "{}" }] }));
    const denied = await until(async () => diagnostics().find(item => item.targetId === "fn" && item.status === "FAILED"));
    assert.equal(denied.errorCode, "AccessDeniedException");
    await lambda.send(new AddPermissionCommand({ FunctionName: "policy-target", StatementId: "events", Action: "lambda:InvokeFunction", Principal: "events.amazonaws.com", SourceArn: ruleArn }));
    await events.send(new PutEventsCommand({ Entries: [{ Source: "parity", DetailType: "second", Detail: "{}" }] }));
    await until(async () => diagnostics().some(item => item.targetId === "fn" && item.status === "SUCCEEDED") ? true : undefined);
    await lambda.send(new RemovePermissionCommand({ FunctionName: "policy-target", StatementId: "events" }));

    // LDG-38: an organization condition the service principal cannot satisfy denies; a URL-only condition and a plain source ARN allow.
    await s3.send(new CreateBucketCommand({ Bucket: "conditioned" }));
    const notification = { LambdaFunctionConfigurations: [{ Id: "created", LambdaFunctionArn: fn.FunctionArn!, Events: ["s3:ObjectCreated:*" as const] }] };
    await lambda.send(new AddPermissionCommand({ FunctionName: "policy-target", StatementId: "org", Action: "lambda:InvokeFunction", Principal: "s3.amazonaws.com", SourceArn: "arn:aws:s3:::conditioned", PrincipalOrgID: "o-example" }));
    await assert.rejects(s3.send(new PutBucketNotificationConfigurationCommand({ Bucket: "conditioned", NotificationConfiguration: notification })));
    await lambda.send(new RemovePermissionCommand({ FunctionName: "policy-target", StatementId: "org" }));
    await lambda.send(new AddPermissionCommand({ FunctionName: "policy-target", StatementId: "url-only", Action: "lambda:InvokeFunction", Principal: "s3.amazonaws.com", SourceArn: "arn:aws:s3:::conditioned", FunctionUrlAuthType: "NONE" }));
    await assert.rejects(s3.send(new PutBucketNotificationConfigurationCommand({ Bucket: "conditioned", NotificationConfiguration: notification })));
    await lambda.send(new RemovePermissionCommand({ FunctionName: "policy-target", StatementId: "url-only" }));
    await lambda.send(new AddPermissionCommand({ FunctionName: "policy-target", StatementId: "plain", Action: "lambda:InvokeFunction", Principal: "s3.amazonaws.com", SourceArn: "arn:aws:s3:::conditioned", SourceAccount: account }));
    await s3.send(new PutBucketNotificationConfigurationCommand({ Bucket: "conditioned", NotificationConfiguration: notification }));
    assert.equal(payloadOf(await lambda.send(new InvokeCommand({ FunctionName: "policy-target", Payload: Buffer.from("{}") }))), 1);
  });
});
