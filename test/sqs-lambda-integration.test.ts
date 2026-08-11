import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateEventSourceMappingCommand,
  CreateFunctionCommand,
  GetEventSourceMappingCommand,
  InvokeCommand,
  LambdaClient,
  PutFunctionEventInvokeConfigCommand,
} from "@aws-sdk/client-lambda";
import { AttachRolePolicyCommand, CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateQueueCommand, GetQueueAttributesCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import type { LambdaSqsMessageAttributeValue, LambdaSqsQueueDescriptor, LambdaSqsServicePort } from "../src/lambda-sqs-event-source.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

interface TestMessage {
  id: string;
  body: string;
  messageAttributes: Record<string, LambdaSqsMessageAttributeValue>;
  systemAttributes: Record<string, LambdaSqsMessageAttributeValue>;
  visibleAt: number;
  receiveCount: number;
  receiptHandle?: string;
}

class TestSqsPort implements LambdaSqsServicePort {
  readonly descriptors = new Map<string, LambdaSqsQueueDescriptor>();
  readonly messages = new Map<string, TestMessage[]>();
  readonly acknowledged = new Set<string>();
  readonly deliveries: Array<{ queueArn: string; input: { MessageBody: string; MessageAttributes?: Record<string, LambdaSqsMessageAttributeValue>; MessageSystemAttributes?: Record<string, LambdaSqsMessageAttributeValue> } }> = [];
  maximumInFlight = 0;
  readonly receiveInputs: Array<{ waitTimeSeconds?: number; abortSignal?: AbortSignal }> = [];
  private serial = 0;

  constructor(private readonly clock: TestClock) {}

  queue(name: string, visibilityTimeoutSeconds = 5): LambdaSqsQueueDescriptor {
    const queueArn = `arn:aws:sqs:${region}:${account}:${name}`; const queueUrl = `http://localhost/queue/${account}/${name}`;
    const descriptor = { queueArn, queueUrl, visibilityTimeoutSeconds }; this.descriptors.set(queueArn, descriptor); this.messages.set(queueArn, []); return descriptor;
  }

  enqueue(queueArn: string, body: string, messageAttributes: Record<string, LambdaSqsMessageAttributeValue> = {}): string {
    const id = `message-${++this.serial}`; this.messages.get(queueArn)!.push({ id, body, messageAttributes, systemAttributes: { AWSTraceHeader: { DataType: "String", StringValue: `Root=1-${id}` } }, visibleAt: this.clock.now(), receiveCount: 0 }); return id;
  }

  resolveQueueArn(queueArn: string): LambdaSqsQueueDescriptor | undefined { return this.descriptors.get(queueArn); }

  async receiveForConsumer(input: { queueArn: string; maxNumberOfMessages: number; visibilityTimeoutSeconds?: number; waitTimeSeconds?: number; abortSignal?: AbortSignal }): Promise<{ messages: any[] }> {
    this.receiveInputs.push({ waitTimeSeconds: input.waitTimeSeconds, abortSignal: input.abortSignal });
    const now = this.clock.now(); const values = (this.messages.get(input.queueArn) ?? []).filter(message => message.visibleAt <= now).slice(0, input.maxNumberOfMessages);
    for (const message of values) { message.receiveCount++; message.receiptHandle = `receipt-${message.id}-${message.receiveCount}`; message.visibleAt = now + (input.visibilityTimeoutSeconds ?? this.descriptors.get(input.queueArn)!.visibilityTimeoutSeconds) * 1000; }
    const inFlight = [...this.messages.values()].flat().filter(message => message.visibleAt > now && !this.acknowledged.has(message.id)).length; this.maximumInFlight = Math.max(this.maximumInFlight, inFlight);
    return { messages: values.map(message => ({ MessageId: message.id, ReceiptHandle: message.receiptHandle, Body: message.body, MD5OfBody: `md5-${message.id}`, MD5OfMessageAttributes: Object.keys(message.messageAttributes).length ? `attrs-${message.id}` : undefined, Attributes: { ApproximateReceiveCount: String(message.receiveCount), SentTimestamp: String(now - 100), ApproximateFirstReceiveTimestamp: String(now), AWSTraceHeader: message.systemAttributes.AWSTraceHeader.StringValue! }, MessageAttributes: message.messageAttributes })) };
  }

  async acknowledge(input: { queueArn: string; receiptHandles: string[] }): Promise<void> {
    const receipts = new Set(input.receiptHandles); const queue = this.messages.get(input.queueArn) ?? [];
    for (const message of queue) if (message.receiptHandle && receipts.has(message.receiptHandle)) this.acknowledged.add(message.id);
    this.messages.set(input.queueArn, queue.filter(message => !message.receiptHandle || !receipts.has(message.receiptHandle)));
  }

  async sendMessageToArn(queueArn: string, input: { MessageBody: string; MessageAttributes?: Record<string, LambdaSqsMessageAttributeValue>; MessageSystemAttributes?: Record<string, LambdaSqsMessageAttributeValue> }): Promise<unknown> {
    if (!this.descriptors.has(queueArn)) throw new Error("queue missing"); this.deliveries.push({ queueArn, input: structuredClone(input) }); this.enqueue(queueArn, input.MessageBody, input.MessageAttributes); return { MessageId: `message-${this.serial}` };
  }
}

const code = createZip([{ name: "index.mjs", content: `
export async function batch(event) {
  if (!Array.isArray(event.Records) || event.Records.some(record => record.eventSource !== "aws:sqs" || !record.eventSourceARN || !record.awsRegion || !record.receiptHandle || !record.md5OfBody || !record.attributes?.ApproximateReceiveCount)) throw new Error("invalid SQS event shape");
  for (const record of event.Records) {
    const body = JSON.parse(record.body);
    if (body.requireBinary && record.messageAttributes?.binary?.binaryValue !== "AQI=") throw new Error("binary message attribute was not normalized");
    if (body.fail) throw new Error("intentional batch failure");
  }
  return { batchItemFailures: event.Records.filter(record => JSON.parse(record.body).partial).map(record => ({ itemIdentifier: record.messageId })) };
}
export async function asyncHandler(event) {
  if (event.fail) throw new Error("intentional async failure");
  return { accepted: true, value: event.value };
}
` }]);

async function pump(clock: TestClock, accept: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!accept()) { if (Date.now() >= deadline) throw new Error("Timed out waiting for Lambda/SQS work"); clock.advance(250); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test("SQS event-source mappings use queue leases, filtering, partial acknowledgement, concurrency, and restart-safe visibility", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sqs-lambda-")); const clock = new TestClock(Date.parse("2026-07-19T10:00:00Z")); const sqs = new TestSqsPort(clock);
  const source = sqs.queue("worker-source", 5); const restartSource = sqs.queue("restart-source", 5); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off"}); let lambda: LambdaClient | undefined;
  const connect = () => { lambda = new LambdaClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }); };
  try {
    simulator.lambda.setSqsService(sqs); await simulator.start(); connect();
    const fn = await lambda!.send(new CreateFunctionCommand({ FunctionName: "sqs-worker", Runtime: "nodejs22.x", Role: `arn:aws:iam::${account}:role/test`, Handler: "index.batch", Timeout: 1, Code: { ZipFile: code } })); await new Promise(resolve => setTimeout(resolve, 10));
    const created = await lambda!.send(new CreateEventSourceMappingCommand({ FunctionName: fn.FunctionArn, EventSourceArn: source.queueArn, BatchSize: 1, FunctionResponseTypes: ["ReportBatchItemFailures"], FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ body: { kind: ["keep"] } }) }] }, ScalingConfig: { MaximumConcurrency: 2 } }));
    assert.equal(created.StartingPosition, undefined); assert.equal(created.ScalingConfig?.MaximumConcurrency, 2); assert.equal(created.State, "Creating"); clock.advance(0);
    await pump(clock, () => (simulator.store.regionState(region).lambdaEventSourceMappings[created.UUID!]?.state as string) === "Enabled");
    const success = sqs.enqueue(source.queueArn, JSON.stringify({ kind: "keep", requireBinary: true }), { binary: { DataType: "Binary", BinaryValue: Uint8Array.from([1, 2]) } });
    const partial = sqs.enqueue(source.queueArn, JSON.stringify({ kind: "keep", partial: true }));
    const filtered = sqs.enqueue(source.queueArn, JSON.stringify({ kind: "drop" }));
    const failed = sqs.enqueue(source.queueArn, JSON.stringify({ kind: "keep", fail: true }));
    await pump(clock, () => sqs.acknowledged.has(success) && sqs.acknowledged.has(filtered) && (sqs.messages.get(source.queueArn)?.find(message => message.id === partial)?.receiveCount ?? 0) >= 1 && (sqs.messages.get(source.queueArn)?.find(message => message.id === failed)?.receiveCount ?? 0) >= 1);
    assert(sqs.receiveInputs.some(input => input.waitTimeSeconds === 20 && input.abortSignal), "SQS mappings use cancellable long polls");
    assert.equal(sqs.acknowledged.has(partial), false); assert.equal(sqs.acknowledged.has(failed), false); assert.ok(sqs.maximumInFlight >= 2, "mapping maximum concurrency allows two leased batches");
    clock.advance(5_000); await pump(clock, () => (sqs.messages.get(source.queueArn)?.find(message => message.id === partial)?.receiveCount ?? 0) >= 2 && (sqs.messages.get(source.queueArn)?.find(message => message.id === failed)?.receiveCount ?? 0) >= 2);
    const view = await lambda!.send(new GetEventSourceMappingCommand({ UUID: created.UUID })); assert.equal(view.EventSourceArn, source.queueArn); assert.equal(view.BisectBatchOnFunctionError, undefined); assert.ok(["Partial batch failure", "Function error"].includes(view.LastProcessingResult ?? ""));

    const restartMapping = await lambda!.send(new CreateEventSourceMappingCommand({ FunctionName: fn.FunctionArn, EventSourceArn: restartSource.queueArn, BatchSize: 2, MaximumBatchingWindowInSeconds: 2 })); clock.advance(0); const restartMessage = sqs.enqueue(restartSource.queueArn, JSON.stringify({ kind: "keep" }));
    await pump(clock, () => (sqs.messages.get(restartSource.queueArn)?.find(message => message.id === restartMessage)?.receiveCount ?? 0) === 1); assert.equal(sqs.acknowledged.has(restartMessage), false, "the batching window does not acknowledge before invoke");
    lambda!.destroy(); lambda = undefined; await simulator.stop(); clock.advance(5_000);
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off"}); simulator.lambda.setSqsService(sqs); await simulator.start(); connect();
    await pump(clock, () => sqs.acknowledged.has(restartMessage)); assert.ok((await lambda!.send(new GetEventSourceMappingCommand({ UUID: restartMapping.UUID }))).State === "Enabled");
  } finally { lambda?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("Lambda asynchronous SQS destinations and ordinary dead-letter queues use SendMessage with AWS envelopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sqs-destination-")); const clock = new TestClock(Date.parse("2026-07-19T11:00:00Z")); const sqs = new TestSqsPort(clock); const destination = sqs.queue("async-destination"); const deadLetter = sqs.queue("async-dead-letter"); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off"}); let lambda: LambdaClient | undefined;
  try {
    simulator.lambda.setSqsService(sqs); await simulator.start(); lambda = new LambdaClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    await lambda.send(new CreateFunctionCommand({ FunctionName: "async-sqs", Runtime: "nodejs22.x", Role: `arn:aws:iam::${account}:role/test`, Handler: "index.asyncHandler", Timeout: 1, Code: { ZipFile: code }, DeadLetterConfig: { TargetArn: deadLetter.queueArn } })); await new Promise(resolve => setTimeout(resolve, 10));
    await lambda.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "async-sqs", MaximumRetryAttempts: 0, DestinationConfig: { OnSuccess: { Destination: destination.queueArn }, OnFailure: { Destination: destination.queueArn } } }));
    await lambda.send(new InvokeCommand({ FunctionName: "async-sqs", InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ value: "ok" })) })); clock.advance(0);
    await pump(clock, () => sqs.deliveries.filter(delivery => delivery.queueArn === destination.queueArn).length === 1);
    const success = JSON.parse(sqs.deliveries.find(delivery => delivery.queueArn === destination.queueArn)!.input.MessageBody); assert.equal(success.requestContext.condition, "Success"); assert.deepEqual(success.requestPayload, { value: "ok" });
    await lambda.send(new InvokeCommand({ FunctionName: "async-sqs", InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ value: "bad", fail: true })) })); clock.advance(0);
    await pump(clock, () => sqs.deliveries.filter(delivery => delivery.queueArn === destination.queueArn).length === 2 && sqs.deliveries.some(delivery => delivery.queueArn === deadLetter.queueArn));
    const failure = JSON.parse(sqs.deliveries.filter(delivery => delivery.queueArn === destination.queueArn)[1].input.MessageBody); assert.equal(failure.requestContext.condition, "RetriesExhausted"); assert.equal(failure.responseContext.functionError, "Unhandled");
    const dlq = sqs.deliveries.find(delivery => delivery.queueArn === deadLetter.queueArn)!; assert.deepEqual(JSON.parse(dlq.input.MessageBody), { value: "bad", fail: true }); assert.match(dlq.input.MessageAttributes?.RequestID.StringValue ?? "", /^[a-f0-9]{32}$/); assert.equal(dlq.input.MessageAttributes?.ErrorCode.StringValue, "200"); assert.match(dlq.input.MessageAttributes?.ErrorMessage.StringValue ?? "", /intentional async failure/);
  } finally { lambda?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("the real SQS queue path enforces Lambda execution-role permissions and acknowledges successful work", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sqs-real-lambda-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials };
    const sqs = new SQSClient(options); const lambda = new LambdaClient(options); const iam = new IAMClient(options);
    clients.push(sqs, lambda, iam);
    const QueueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "real-worker", Attributes: { VisibilityTimeout: "30" } }))).QueueUrl!;
    const queueArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
    const roleName = "real-sqs-worker-role";
    const role = await iam.send(new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" }));
    const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "real-sqs-worker", Runtime: "nodejs22.x", Role: role.Role!.Arn!, Handler: "index.batch", Timeout: 1, Code: { ZipFile: code } }));
    await assert.rejects(lambda.send(new CreateEventSourceMappingCommand({ FunctionName: fn.FunctionArn, EventSourceArn: queueArn, BatchSize: 1 })), (error: any) => error.name === "InvalidParameterValueException" && /not authorized/.test(error.message));
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole" }));
    const mapping = await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: fn.FunctionArn, EventSourceArn: queueArn, BatchSize: 1 }));
    const pollDeadline = Date.now() + 5_000; while ((simulator.sqs as any).waiters.size === 0 && Date.now() < pollDeadline) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok((simulator.sqs as any).waiters.size > 0, "an idle mapping holds a long poll instead of short-polling repeatedly");
    const deliveryStarted = Date.now();
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: JSON.stringify({ kind: "keep" }) }));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [view, attributes] = await Promise.all([
        lambda.send(new GetEventSourceMappingCommand({ UUID: mapping.UUID })),
        sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] })),
      ]);
      if (view.LastProcessingResult === "OK" && attributes.Attributes?.ApproximateNumberOfMessages === "0" && attributes.Attributes?.ApproximateNumberOfMessagesNotVisible === "0") break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const final = await lambda.send(new GetEventSourceMappingCommand({ UUID: mapping.UUID }));
    assert.equal(final.LastProcessingResult, "OK");
    assert.ok(Date.now() - deliveryStarted < 2_000, "queue notification wakes the long poll without adding delivery latency");
    const attributes = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }))).Attributes!;
    assert.deepEqual(attributes, { ApproximateNumberOfMessages: "0", ApproximateNumberOfMessagesNotVisible: "0" });
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
