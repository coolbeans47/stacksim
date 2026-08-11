import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { TestClock } from "../src/core/clock.js";
import { Scheduler } from "../src/core/scheduler.js";
import { TelemetryBus, type TelemetryEvent } from "../src/core/telemetry.js";
import { LambdaSqsEventSource, type LambdaSqsServicePort } from "../src/lambda-sqs-event-source.js";
import { CURRENT_SCHEMA_VERSION, emptyState } from "../src/migrations/v1-to-v2.js";
import { SqsService } from "../src/sqs.js";
import { StateStore } from "../src/state.js";

interface Harness {
  root: string;
  store: StateStore;
  clock: TestClock;
  events: TelemetryEvent[];
  scheduler: Scheduler;
  service: SqsService;
  server: Server;
  endpoint: string;
  client: SQSClient;
  restart(): Promise<void>;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sqs-fifo-"));
  const clock = new TestClock(1_800_000_000_000);
  const telemetry = new TelemetryBus();
  const events: TelemetryEvent[] = [];
  telemetry.subscribe(event => { events.push(event); });
  const scheduler = new Scheduler(clock);
  let endpoint = "http://127.0.0.1";
  const context = {} as Harness;
  context.store = new StateStore(root, "000000000000", "eu-west-1");
  await context.store.load();
  context.service = new SqsService(context.store, "eu-west-1", clock, telemetry, scheduler, () => endpoint);
  await context.service.start();
  const server = createServer((request, response) => { void context.service.handle(request, response, randomUUID()); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert(address && typeof address === "object");
  endpoint = `http://127.0.0.1:${address.port}`;
  const client = new SQSClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  Object.assign(context, {
    root, clock, events, scheduler, server, endpoint, client,
    async restart() {
      await context.service.stop();
      context.store = new StateStore(root, "000000000000", "eu-west-1");
      await context.store.load();
      context.service = new SqsService(context.store, "eu-west-1", clock, telemetry, scheduler, () => endpoint);
      await context.service.start();
    },
    async close() {
      client.destroy();
      await context.service.stop();
      scheduler.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  });
  harnesses.push(context);
  return context;
}

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
});

test("schema v46 migrates existing queues to immutable Standard descriptors", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sqs-v46-"));
  try {
    const legacy = emptyState();
    legacy.schemaVersion = 46;
    legacy.accounts["000000000000"].regions["eu-west-1"].sqsQueues.legacy = {
      queueName: "legacy",
      queueArn: "arn:aws:sqs:eu-west-1:000000000000:legacy",
      createdAt: 1,
      lastModified: 1,
      attributes: { DelaySeconds: "0", MaximumMessageSize: "1048576", MessageRetentionPeriod: "345600", ReceiveMessageWaitTimeSeconds: "0", VisibilityTimeout: "30" } as any,
      tags: {},
    };
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root, "000000000000", "eu-west-1");
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(store.regionState("eu-west-1").sqsQueues.legacy.attributes.SqsManagedSseEnabled, "false");
    assert.equal(store.regionState("eu-west-1").sqsQueues.legacy.attributes.FifoQueue, "false");
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fifoQueue(h: Harness, name: string, attributes: Record<string, string> = {}): Promise<string> {
  return (await h.client.send(new CreateQueueCommand({ QueueName: `${name}.fifo`, Attributes: { FifoQueue: "true", ...attributes } }))).QueueUrl!;
}

test("FIFO queues enforce type, preserve group order, deduplicate, replay receive attempts, and restart", async () => {
  const h = await harness();
  await assert.rejects(h.client.send(new CreateQueueCommand({ QueueName: "missing-type.fifo" })), (error: any) => error.name === "InvalidParameterValue");
  await assert.rejects(h.client.send(new CreateQueueCommand({ QueueName: "missing-suffix", Attributes: { FifoQueue: "true" } })), (error: any) => error.name === "InvalidParameterValue");
  const QueueUrl = await fifoQueue(h, "ordered", { ContentBasedDeduplication: "true", VisibilityTimeout: "2" });
  const attributes = (await h.client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["All"] }))).Attributes!;
  assert.equal(attributes.FifoQueue, "true");
  assert.equal(attributes.ContentBasedDeduplication, "true");
  await assert.rejects(h.client.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { FifoQueue: "false" } })), (error: any) => error.name === "InvalidParameterValue");
  await assert.rejects(h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "missing-group" })), (error: any) => error.name === "MissingParameter");
  await assert.rejects(h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "delay", MessageGroupId: "a", DelaySeconds: 0 })), (error: any) => error.name === "InvalidParameterValue");

  const first = await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "a-1", MessageGroupId: "a", MessageDeduplicationId: "a-1" }));
  const duplicate = await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "different-body", MessageGroupId: "a", MessageDeduplicationId: "a-1" }));
  assert.equal(duplicate.MessageId, first.MessageId);
  assert.equal(duplicate.SequenceNumber, first.SequenceNumber);
  const second = await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "a-2", MessageGroupId: "a", MessageDeduplicationId: "a-2" }));
  const independent = await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "b-1", MessageGroupId: "b" }));
  assert(BigInt(second.SequenceNumber!) > BigInt(first.SequenceNumber!));
  assert(BigInt(independent.SequenceNumber!) > BigInt(second.SequenceNumber!));
  assert(h.events.some(event => event.metricName === "NumberOfDeduplicatedSentMessages" && event.dimensions.QueueName === "ordered.fifo"));

  const receivedA = (await h.client.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1, AttributeNames: ["All"] }))).Messages![0];
  assert.equal(receivedA.Body, "a-1");
  assert.equal(receivedA.Attributes?.MessageGroupId, "a");
  assert.equal(receivedA.Attributes?.MessageDeduplicationId, "a-1");
  assert.equal(receivedA.Attributes?.SequenceNumber, first.SequenceNumber);
  const receivedB = (await h.client.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, AttributeNames: ["All"] }))).Messages![0];
  assert.equal(receivedB.Body, "b-1", "an in-flight group head does not block an independent group");
  await h.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: receivedA.ReceiptHandle! }));
  const nextA = (await h.client.send(new ReceiveMessageCommand({ QueueUrl, AttributeNames: ["All"] }))).Messages![0];
  assert.equal(nextA.Body, "a-2", "the next group member is released only after its predecessor is acknowledged");

  await h.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: nextA.ReceiptHandle! }));
  await h.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: receivedB.ReceiptHandle! }));
  const durable = await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "durable-attempt", MessageGroupId: "restart", MessageDeduplicationId: "restart-1" }));
  const attempt = (await h.client.send(new ReceiveMessageCommand({ QueueUrl, ReceiveRequestAttemptId: "attempt-1", AttributeNames: ["All"] }))).Messages![0];
  await h.restart();
  const replay = (await h.client.send(new ReceiveMessageCommand({ QueueUrl, ReceiveRequestAttemptId: "attempt-1", AttributeNames: ["All"] }))).Messages![0];
  assert.equal(replay.MessageId, durable.MessageId);
  assert.equal(replay.ReceiptHandle, attempt.ReceiptHandle);
  assert.equal(replay.Attributes?.ApproximateReceiveCount, "1");
  await h.client.send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle: replay.ReceiptHandle!, VisibilityTimeout: 0 }));
  assert.equal((await h.client.send(new ReceiveMessageCommand({ QueueUrl, ReceiveRequestAttemptId: "attempt-1" }))).Messages, undefined, "visibility mutation invalidates an attempt replay");
  const redelivered = (await h.client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages![0];
  await h.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: redelivered.ReceiptHandle! }));

  await h.restart();
  const stillDuplicate = await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "durable-attempt", MessageGroupId: "restart", MessageDeduplicationId: "restart-1" }));
  assert.equal(stillDuplicate.MessageId, durable.MessageId, "send deduplication survives deletion and restart");
  h.clock.advance(300_001);
  const expired = await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "durable-attempt", MessageGroupId: "restart", MessageDeduplicationId: "restart-1" }));
  assert.notEqual(expired.MessageId, durable.MessageId, "the five-minute deduplication window expires");
});

test("FIFO batches assign ordered sequences and Standard MessageGroupId scheduling gives quiet groups bounded progress", async () => {
  const h = await harness();
  const fifoUrl = await fifoQueue(h, "batch");
  const batch = await h.client.send(new SendMessageBatchCommand({ QueueUrl: fifoUrl, Entries: [
    { Id: "one", MessageBody: "one", MessageGroupId: "same", MessageDeduplicationId: "one" },
    { Id: "invalid", MessageBody: "invalid" },
    { Id: "two", MessageBody: "two", MessageGroupId: "same", MessageDeduplicationId: "two" },
  ] }));
  assert.deepEqual(batch.Successful?.map(entry => entry.Id), ["one", "two"]);
  assert.deepEqual(batch.Failed?.map(entry => entry.Id), ["invalid"]);
  assert(BigInt(batch.Successful![1].SequenceNumber!) > BigInt(batch.Successful![0].SequenceNumber!));
  const sameGroup = (await h.client.send(new ReceiveMessageCommand({ QueueUrl: fifoUrl, MaxNumberOfMessages: 10 }))).Messages!;
  assert.deepEqual(sameGroup.map(message => message.Body), ["one", "two"], "one receive can lease an ordered same-group batch");

  const QueueUrl = (await h.client.send(new CreateQueueCommand({ QueueName: "fair-standard" }))).QueueUrl!;
  for (let index = 0; index < 8; index += 1) await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: `noisy-${index}`, MessageGroupId: "noisy" }));
  await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "quiet", MessageGroupId: "quiet" }));
  const fair = (await h.client.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 2, AttributeNames: ["All"] }))).Messages!;
  assert.deepEqual(fair.map(message => message.Attributes?.MessageGroupId), ["noisy", "quiet"]);
  assert(h.events.some(event => event.metricName === "ApproximateNumberOfNoisyGroups" && event.value === 1 && event.dimensions.QueueName === "fair-standard"));
  assert(h.events.some(event => event.metricName === "ApproximateNumberOfMessagesVisibleInQuietGroups" && event.dimensions.QueueName === "fair-standard"));
});

test("FIFO dead-letter movement requires matching types and applies FIFO enqueue and deduplication rules", async () => {
  const h = await harness();
  const standardUrl = (await h.client.send(new CreateQueueCommand({ QueueName: "standard-dlq" }))).QueueUrl!;
  const standardArn = (await h.client.send(new GetQueueAttributesCommand({ QueueUrl: standardUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
  const sourceUrl = await fifoQueue(h, "fifo-source", { VisibilityTimeout: "1" });
  await assert.rejects(h.client.send(new SetQueueAttributesCommand({ QueueUrl: sourceUrl, Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: standardArn, maxReceiveCount: 1 }) } })), (error: any) => error.name === "InvalidParameterValue");

  const dlqUrl = await fifoQueue(h, "fifo-dlq");
  const dlqArn = (await h.client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
  await h.client.send(new SetQueueAttributesCommand({ QueueUrl: sourceUrl, Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 1 }) } }));
  const sent = await h.client.send(new SendMessageCommand({ QueueUrl: sourceUrl, MessageBody: "poison", MessageGroupId: "orders", MessageDeduplicationId: "external-id" }));
  const first = (await h.client.send(new ReceiveMessageCommand({ QueueUrl: sourceUrl, AttributeNames: ["All"] }))).Messages![0];
  const originalSent = Number(first.Attributes!.SentTimestamp);
  h.clock.advance(1_001);
  assert.equal((await h.client.send(new ReceiveMessageCommand({ QueueUrl: sourceUrl }))).Messages, undefined);
  await h.restart();
  const dead = (await h.client.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, AttributeNames: ["All"] }))).Messages![0];
  assert.equal(dead.MessageId, sent.MessageId);
  assert.equal(dead.Attributes?.MessageGroupId, "orders");
  assert.equal(dead.Attributes?.MessageDeduplicationId, sent.MessageId);
  assert(Number(dead.Attributes!.SentTimestamp) > originalSent);
  assert(dead.Attributes?.SequenceNumber);
});

test("FIFO Lambda mappings enforce limits and do not acknowledge failed or interrupted items", async () => {
  const h = await harness();
  const QueueUrl = await fifoQueue(h, "lambda-source", { VisibilityTimeout: "30" });
  const descriptor = h.service.resolveQueueUrl(QueueUrl);
  const acknowledged: string[] = [];
  const port: LambdaSqsServicePort = {
    resolveQueueArn: arn => arn === descriptor.queueArn ? descriptor : undefined,
    receiveForConsumer: async () => ({ messages: [] }),
    acknowledge: async input => { acknowledged.push(...input.receiptHandles); },
    sendMessageToArn: async () => ({}),
  };
  let interruptInvocation = false;
  const source = new LambdaSqsEventSource(h.store, "eu-west-1", h.clock, {
    resolveFunction: () => ({ functionName: "worker", functionArn: "arn:aws:lambda:eu-west-1:000000000000:function:worker", role: "arn:aws:iam::000000000000:role/worker", timeout: 1 }),
    invoke: async () => interruptInvocation ? { payload: Buffer.from("null"), interrupted: true } : { payload: Buffer.from(JSON.stringify({ batchItemFailures: [{ itemIdentifier: "a-2" }] })) },
    isCurrent: () => true,
    wake: () => undefined,
  }, "off", undefined, port);
  assert.throws(() => source.configuration({ EventSourceArn: descriptor.queueArn, BatchSize: 11 }), /BatchSize/);
  assert.throws(() => source.configuration({ EventSourceArn: descriptor.queueArn, MaximumBatchingWindowInSeconds: 1 }), /not supported for FIFO/);
  assert.equal(source.configuration({ EventSourceArn: descriptor.queueArn, BatchSize: 10 }).batchSize, 10);

  const mapping: any = {
    sourceType: "sqs", uuid: "mapping", eventSourceArn: descriptor.queueArn, functionName: "worker", functionArn: "arn:aws:lambda:eu-west-1:000000000000:function:worker",
    enabled: true, state: "Enabled", batchSize: 10, maximumBatchingWindowInSeconds: 0, functionResponseTypes: ["ReportBatchItemFailures"], tags: {}, lastProcessingResult: "", lastModified: h.clock.now(),
  };
  const message = (messageId: string, group: string) => ({ messageId, receiptHandle: `receipt-${messageId}`, body: "{}", md5OfBody: "md5", attributes: { MessageGroupId: group }, messageAttributes: {} });
  await (source as any).invoke(mapping, [message("a-1", "a"), message("b-1", "b"), message("a-2", "a"), message("a-3", "a")]);
  assert.deepEqual(acknowledged.sort(), ["receipt-a-1", "receipt-b-1"], "the failed FIFO item and every later item in its group remain unacknowledged");
  acknowledged.length = 0; mapping.lastProcessingResult = "before shutdown"; interruptInvocation = true;
  await (source as any).invoke(mapping, [message("interrupted", "shutdown")]);
  assert.deepEqual(acknowledged, [], "shutdown-interrupted batches remain available for retry");
  assert.equal(mapping.lastProcessingResult, "before shutdown", "shutdown interruption is not reported as a successful mapping result");
});

test("AWS Query/XML routes FIFO attributes and message fields through the shared engine", async () => {
  const h = await harness();
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  const created = await fetch(h.endpoint, { method: "POST", headers, body: new URLSearchParams({ Action: "CreateQueue", Version: "2012-11-05", QueueName: "query-fifo.fifo", "Attribute.1.Name": "FifoQueue", "Attribute.1.Value": "true" }) });
  assert.equal(created.status, 200);
  const QueueUrl = (await created.text()).match(/<QueueUrl>([^<]+)<\/QueueUrl>/)![1].replace(/&amp;/g, "&");
  const sent = await fetch(QueueUrl, { method: "POST", headers, body: new URLSearchParams({ Action: "SendMessage", Version: "2012-11-05", MessageBody: "query-fifo", MessageGroupId: "query-group", MessageDeduplicationId: "query-dedup" }) });
  const sentXml = await sent.text();
  assert.equal(sent.status, 200);
  assert.match(sentXml, /<SequenceNumber>\d+<\/SequenceNumber>/);
  const received = await fetch(QueueUrl, { method: "POST", headers, body: new URLSearchParams({ Action: "ReceiveMessage", Version: "2012-11-05", AttributeName: "All" }) });
  const receivedXml = await received.text();
  assert.match(receivedXml, /<Name>MessageGroupId<\/Name><Value>query-group<\/Value>/);
  assert.match(receivedXml, /<Name>MessageDeduplicationId<\/Name><Value>query-dedup<\/Value>/);
});
