import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListDeadLetterSourceQueuesCommand,
  ListQueueTagsCommand,
  ListQueuesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
  TagQueueCommand,
  UntagQueueCommand,
} from "@aws-sdk/client-sqs";
import { TestClock } from "../src/core/clock.js";
import { Scheduler } from "../src/core/scheduler.js";
import { TelemetryBus, type TelemetryEvent } from "../src/core/telemetry.js";
import { SqsService } from "../src/sqs.js";
import { md5OfMessageAttributes } from "../src/sqs/md5.js";
import { StateStore } from "../src/state.js";

interface Harness {
  root: string;
  store: StateStore;
  clock: TestClock;
  telemetry: TelemetryBus;
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
  const root = await mkdtemp(join(tmpdir(), "stacksim-sqs-"));
  const store = new StateStore(root, "000000000000", "eu-west-1");
  await store.load();
  const clock = new TestClock(1_700_000_000_000);
  const telemetry = new TelemetryBus();
  const events: TelemetryEvent[] = [];
  telemetry.subscribe(event => { events.push(event); });
  const scheduler = new Scheduler(clock);
  let endpoint = "http://127.0.0.1";
  const context = {} as Harness;
  context.service = new SqsService(store, "eu-west-1", clock, telemetry, scheduler, () => endpoint);
  await context.service.start();
  const server = createServer((request, response) => { void context.service.handle(request, response, randomUUID()); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert(address && typeof address === "object");
  endpoint = `http://127.0.0.1:${address.port}`;
  const client = new SQSClient({ region: "eu-west-1", endpoint, credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  Object.assign(context, {
    root, store, clock, telemetry, events, scheduler, server, endpoint, client,
    async restart() {
      await context.service.stop();
      const reloaded = new StateStore(root, "000000000000", "eu-west-1");
      await reloaded.load();
      context.store = reloaded;
      context.service = new SqsService(reloaded, "eu-west-1", clock, telemetry, scheduler, () => endpoint);
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for SQS test condition");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function regularFiles(root: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? regularFiles(join(root, entry.name)) : [join(root, entry.name)]))).flat();
}

test("official SQS client covers control plane, MD5s, visibility, partial batches, purge, and tags", async () => {
  const h = await harness();
  const created = await h.client.send(new CreateQueueCommand({
    QueueName: "orders",
    Attributes: { VisibilityTimeout: "2", MessageRetentionPeriod: "60" },
    tags: { environment: "test" },
  }));
  const QueueUrl = created.QueueUrl!;
  assert(h.events.some(event => event.metricName === "ApproximateNumberOfMessagesVisible" && event.aggregation === "gauge"));
  assert.equal(h.events.some(event => event.metricName.includes("QuietGroups")), false, "ordinary standard queues do not emit fair-queue gauges");
  assert.equal((await h.client.send(new CreateQueueCommand({ QueueName: "orders", Attributes: { VisibilityTimeout: "2", MessageRetentionPeriod: "60" } }))).QueueUrl, QueueUrl, "CreateQueue is idempotent only for the same effective attributes");
  await assert.rejects(h.client.send(new CreateQueueCommand({ QueueName: "orders" })), (error: any) => error.name === "QueueNameExists");
  assert.equal((await h.client.send(new GetQueueUrlCommand({ QueueName: "orders" }))).QueueUrl, QueueUrl);
  assert.deepEqual((await h.client.send(new ListQueuesCommand({ QueueNamePrefix: "ord" }))).QueueUrls, [QueueUrl]);
  await h.client.send(new CreateQueueCommand({ QueueName: "orders-archive" }));
  const firstPage = await h.client.send(new ListQueuesCommand({ QueueNamePrefix: "orders", MaxResults: 1 }));
  assert.equal(firstPage.QueueUrls?.length, 1);
  assert(firstPage.NextToken);
  const secondPage = await h.client.send(new ListQueuesCommand({ QueueNamePrefix: "orders", MaxResults: 1, NextToken: firstPage.NextToken }));
  assert.equal(secondPage.QueueUrls?.length, 1);
  assert.notEqual(secondPage.QueueUrls![0], firstPage.QueueUrls![0]);
  assert.equal((await h.client.send(new ListQueueTagsCommand({ QueueUrl }))).Tags?.environment, "test");
  await h.client.send(new TagQueueCommand({ QueueUrl, Tags: { owner: "local" } }));
  await h.client.send(new UntagQueueCommand({ QueueUrl, TagKeys: ["environment"] }));
  assert.deepEqual((await h.client.send(new ListQueueTagsCommand({ QueueUrl }))).Tags, { owner: "local" });

  const messageAttributes = {
    kind: { DataType: "String", StringValue: "created" },
    bytes: { DataType: "Binary", BinaryValue: Uint8Array.from([0, 1, 254, 255]) },
  };
  const sent = await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "hello", MessageAttributes: messageAttributes }));
  assert.equal(sent.MD5OfMessageBody, "5d41402abc4b2a76b9719d911017c592");
  assert.equal(sent.MD5OfMessageAttributes, md5OfMessageAttributes(messageAttributes));
  assert.doesNotMatch(await readFile(join(h.root, "state.json"), "utf8"), /hello/, "message bodies stay out of control state");
  for (const file of await regularFiles(join(h.root, "data", "sqs", "queues"))) assert.equal((await readFile(file)).includes(Buffer.from("hello")), false, `message bodies are encrypted at rest in ${file}`);
  const first = (await h.client.send(new ReceiveMessageCommand({ QueueUrl, AttributeNames: ["All"], MessageAttributeNames: ["All"] }))).Messages![0];
  assert.equal(first.Body, "hello");
  assert.equal(first.Attributes?.ApproximateReceiveCount, "1");
  assert.deepEqual([...first.MessageAttributes!.bytes.BinaryValue!], [0, 1, 254, 255]);
  await assert.rejects(h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "" })), (error: any) => error.name === "InvalidParameterValue");
  const staleReceipt = first.ReceiptHandle!;
  h.clock.advance(2_001);
  await assert.rejects(h.client.send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle: staleReceipt, VisibilityTimeout: 30 })), (error: any) => error.name === "ReceiptHandleIsInvalid", "an expired lease cannot be hidden again without a new receive");
  await assert.rejects(h.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: staleReceipt })), (error: any) => error.name === "ReceiptHandleIsInvalid", "an expired lease cannot acknowledge a visible message");
  const second = (await h.client.send(new ReceiveMessageCommand({ QueueUrl, VisibilityTimeout: 30 }))).Messages![0];
  assert.notEqual(second.ReceiptHandle, staleReceipt);
  await assert.rejects(h.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: staleReceipt })), (error: any) => error.name === "ReceiptHandleIsInvalid");
  await h.client.send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle: second.ReceiptHandle!, VisibilityTimeout: 0 }));
  const third = (await h.client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages![0];
  await h.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: third.ReceiptHandle! }));
  assert.equal((await regularFiles(join(h.root, "data", "sqs", "queues", "blobs"))).length, 0, "acknowledged payload blobs are reclaimed after the durable tombstone");

  const batch = await h.client.send(new SendMessageBatchCommand({ QueueUrl, Entries: [
    { Id: "good", MessageBody: "batch-good" },
    { Id: "bad", MessageBody: "bad\u0000body" },
    { Id: "bad-attribute", MessageBody: "bad attribute", MessageAttributes: { ".invalid": { DataType: "String", StringValue: "value" } } },
  ] }));
  assert.deepEqual(batch.Successful?.map(entry => entry.Id), ["good"]);
  assert.deepEqual(batch.Failed?.map(entry => [entry.Id, entry.Code]), [["bad", "InvalidMessageContents"], ["bad-attribute", "InvalidParameterValue"]]);
  const batchMessage = (await h.client.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }))).Messages![0];
  const deleted = await h.client.send(new DeleteMessageBatchCommand({ QueueUrl, Entries: [
    { Id: "ok", ReceiptHandle: batchMessage.ReceiptHandle! },
    { Id: "invalid", ReceiptHandle: "not-a-handle" },
  ] }));
  assert.deepEqual(deleted.Successful?.map(entry => entry.Id), ["ok"]);
  assert.equal(deleted.Failed?.[0].Code, "ReceiptHandleIsInvalid");

  await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "purge-me" }));
  await h.client.send(new PurgeQueueCommand({ QueueUrl }));
  await assert.rejects(h.client.send(new PurgeQueueCommand({ QueueUrl })), (error: any) => error.name === "PurgeQueueInProgress");
  const attributes = await h.client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["All"] }));
  assert.equal(attributes.Attributes?.ApproximateNumberOfMessages, "0");
  assert(h.events.some(event => event.namespace === "AWS/SQS" && event.metricName === "NumberOfMessagesSent" && event.dimensions.QueueName === "orders"));

  await h.client.send(new DeleteQueueCommand({ QueueUrl }));
  await assert.rejects(h.client.send(new CreateQueueCommand({ QueueName: "orders" })), (error: any) => error.name === "QueueDeletedRecently");
  h.clock.advance(60_001);
  await h.client.send(new CreateQueueCommand({ QueueName: "another-queue" }));
  assert.equal(h.store.regionState("eu-west-1").sqsQueueDeletionTimes.orders, undefined, "expired queue-deletion tombstones are pruned on control-plane activity");
});

test("delay, long polling, visibility and retention deadlines survive restart", async () => {
  const h = await harness();
  const QueueUrl = (await h.client.send(new CreateQueueCommand({ QueueName: "durable", Attributes: { DelaySeconds: "2", VisibilityTimeout: "3", MessageRetentionPeriod: "60" } }))).QueueUrl!;
  await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "persist me" }));
  assert.equal((await h.client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages, undefined);
  await h.restart();

  const pending = h.client.send(new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 5 }));
  await waitUntil(() => (h.service as any).waiters.size === 1);
  h.clock.advance(2_000);
  const first = (await pending).Messages![0];
  assert.equal(first.Body, "persist me");
  await h.restart();
  assert.equal((await h.client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages, undefined);
  h.clock.advance(3_001);
  const again = (await h.client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages![0];
  assert.equal(again.Body, "persist me");
  await h.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: again.ReceiptHandle! }));

  await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "expire me", DelaySeconds: 0 }));
  h.clock.advance(60_001);
  assert.equal((await h.client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages, undefined);
  const emptyPoll = h.client.send(new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 2 }));
  await waitUntil(() => (h.service as any).waiters.size === 1);
  h.clock.advance(2_000);
  assert.equal((await emptyPoll).Messages, undefined);
  assert(h.events.some(event => event.metricName === "NumberOfEmptyReceives"));
});

test("canceled, deleted, and shutdown long polls release their waiters without leasing later messages", async () => {
  const h = await harness();
  const QueueUrl = (await h.client.send(new CreateQueueCommand({ QueueName: "cancel-poll" }))).QueueUrl!;
  const controller = new AbortController();
  const canceled = fetch(h.endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "AmazonSQS.ReceiveMessage" },
    body: JSON.stringify({ QueueUrl, WaitTimeSeconds: 20 }),
    signal: controller.signal,
  });
  await waitUntil(() => (h.service as any).waiters.size === 1);
  controller.abort();
  await assert.rejects(canceled, (error: any) => error.name === "AbortError");
  await waitUntil(() => (h.service as any).waiters.size === 0);

  await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "still available" }));
  const received = (await h.client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages![0];
  assert.equal(received.Body, "still available", "a message sent after cancellation is not leased to the disconnected poll");
  await h.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: received.ReceiptHandle! }));

  const deleteUrl = (await h.client.send(new CreateQueueCommand({ QueueName: "delete-poll" }))).QueueUrl!;
  const deletedPoll = h.client.send(new ReceiveMessageCommand({ QueueUrl: deleteUrl, WaitTimeSeconds: 20 }));
  await waitUntil(() => (h.service as any).waiters.size === 1);
  await h.client.send(new DeleteQueueCommand({ QueueUrl: deleteUrl }));
  await assert.rejects(deletedPoll, (error: any) => error.name === "QueueDoesNotExist");
  assert.equal((h.service as any).waiters.size, 0);

  const stopUrl = (await h.client.send(new CreateQueueCommand({ QueueName: "stop-poll" }))).QueueUrl!;
  const stoppedPoll = h.client.send(new ReceiveMessageCommand({ QueueUrl: stopUrl, WaitTimeSeconds: 20 }));
  await waitUntil(() => (h.service as any).waiters.size === 1);
  await h.service.stop();
  assert.equal((await stoppedPoll).Messages, undefined);
  assert.equal((h.service as any).waiters.size, 0);
});

test("retention changes discard expired messages and recover a persisted update intent", async () => {
  const h = await harness();
  const QueueUrl = (await h.client.send(new CreateQueueCommand({ QueueName: "retention-update", Attributes: { MessageRetentionPeriod: "60" } }))).QueueUrl!;
  await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "reap on attribute read" }));
  h.clock.advance(60_001);
  const emptyAttributes = await h.client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["ApproximateNumberOfMessages"] }));
  assert.equal(emptyAttributes.Attributes?.ApproximateNumberOfMessages, "0");
  assert.equal((await regularFiles(join(h.root, "data", "sqs", "queues", "blobs"))).length, 0, "an attribute-only read reclaims expired payloads");

  await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "must stay expired" }));
  h.clock.advance(60_001);
  await h.client.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { MessageRetentionPeriod: "120" } }));
  assert.equal((await h.client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages, undefined, "extending retention cannot resurrect a record that already expired");
  assert.equal((await regularFiles(join(h.root, "data", "sqs", "queues", "blobs"))).length, 0, "the expired payload is reclaimed during the retention rewrite");

  await h.client.send(new SendMessageCommand({ QueueUrl, MessageBody: "survives recovery" }));
  const storage = (h.service as any).storage;
  const mutateQueue = storage.mutateQueue.bind(storage);
  storage.mutateQueue = async () => { throw new Error("simulated crash before retention metadata commit"); };
  await assert.rejects(h.service.SetQueueAttributes({ QueueUrl, Attributes: { MessageRetentionPeriod: "300" } }), /simulated crash/);
  storage.mutateQueue = mutateQueue;
  const pending = h.store.regionState("eu-west-1").sqsQueues["retention-update"].pendingAttributeUpdate;
  assert.equal(pending?.attributes.MessageRetentionPeriod, "300", "the forward-completing intent is durable before message metadata changes");

  await h.restart();
  const attributes = await h.client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["MessageRetentionPeriod"] }));
  assert.equal(attributes.Attributes?.MessageRetentionPeriod, "300");
  assert.equal(h.store.regionState("eu-west-1").sqsQueues["retention-update"].pendingAttributeUpdate, undefined, "startup clears the intent only after completing its idempotent rewrite");
  h.clock.advance(120_001);
  assert.equal((await h.client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0].Body, "survives recovery");
});

test("redrive policy atomically moves poison messages and lists DLQ sources", async () => {
  const h = await harness();
  const dlqUrl = (await h.client.send(new CreateQueueCommand({ QueueName: "orders-dlq" }))).QueueUrl!;
  const sourceUrl = (await h.client.send(new CreateQueueCommand({ QueueName: "orders-source", Attributes: { VisibilityTimeout: "1" } }))).QueueUrl!;
  const dlqArn = (await h.client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn;
  const sourceArn = (await h.client.send(new GetQueueAttributesCommand({ QueueUrl: sourceUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn;
  await h.client.send(new SetQueueAttributesCommand({ QueueUrl: dlqUrl, Attributes: { RedriveAllowPolicy: JSON.stringify({ redrivePermission: "byQueue", sourceQueueArns: [sourceArn] }) } }));
  await h.client.send(new SetQueueAttributesCommand({ QueueUrl: sourceUrl, Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 1 }) } }));
  assert.deepEqual((await h.client.send(new ListDeadLetterSourceQueuesCommand({ QueueUrl: dlqUrl }))).queueUrls, [sourceUrl]);

  await h.client.send(new SendMessageCommand({ QueueUrl: sourceUrl, MessageBody: "poison" }));
  const first = (await h.client.send(new ReceiveMessageCommand({ QueueUrl: sourceUrl }))).Messages![0];
  assert.equal(first.Body, "poison");
  h.clock.advance(1_001);
  assert.equal((await h.client.send(new ReceiveMessageCommand({ QueueUrl: sourceUrl }))).Messages, undefined);
  await h.restart();
  const dead = (await h.client.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, AttributeNames: ["All"] }))).Messages![0];
  assert.equal(dead.Body, "poison");
  assert.equal(dead.MessageId, first.MessageId);
  assert(h.events.some(event => event.metricName === "NumberOfMessagesMovedToDeadLetterQueue" && event.dimensions.SourceQueue === "orders-source" && event.dimensions.DeadLetterQueue === "orders-dlq"));
});

test("raw AWS Query/XML and AWS JSON 1.0 share the queue engine", async () => {
  const h = await harness();
  const queryHeaders = { "content-type": "application/x-www-form-urlencoded" };
  const created = await fetch(h.endpoint, { method: "POST", headers: queryHeaders, body: new URLSearchParams({ Action: "CreateQueue", Version: "2012-11-05", QueueName: "query-queue" }) });
  assert.equal(created.status, 200);
  const createXml = await created.text();
  const QueueUrl = createXml.match(/<QueueUrl>([^<]+)<\/QueueUrl>/)![1].replace(/&amp;/g, "&");
  const sent = await fetch(QueueUrl, { method: "POST", headers: queryHeaders, body: new URLSearchParams({ Action: "SendMessage", Version: "2012-11-05", MessageBody: "from-query" }) });
  assert.match(await sent.text(), /<MD5OfMessageBody>[a-f0-9]{32}<\/MD5OfMessageBody>/);
  const listed = await fetch(h.endpoint, { method: "POST", headers: queryHeaders, body: new URLSearchParams({ Action: "ListQueues", Version: "2012-11-05" }) });
  const listXml = await listed.text();
  assert.match(listXml, /<ListQueuesResult><QueueUrl>[^<]+<\/QueueUrl><\/ListQueuesResult>/);
  const queriedByGet = await fetch(`${h.endpoint}?${new URLSearchParams({ Action: "GetQueueUrl", Version: "2012-11-05", QueueName: "query-queue" })}`);
  assert.match(await queriedByGet.text(), /<GetQueueUrlResult><QueueUrl>[^<]+<\/QueueUrl><\/GetQueueUrlResult>/);
  const missing = await fetch(`${h.endpoint}?${new URLSearchParams({ Action: "GetQueueUrl", Version: "2012-11-05", QueueName: "missing" })}`);
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /<Code>QueueDoesNotExist<\/Code>/);
  const malformed = await fetch(h.endpoint, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "AmazonSQS.ReceiveMessage" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.match(JSON.stringify(await malformed.json()), /InvalidParameterValue/);
  const jsonResponse = await fetch(h.endpoint, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "AmazonSQS.ReceiveMessage" }, body: JSON.stringify({ QueueUrl }) });
  assert.equal((await jsonResponse.json() as any).Messages[0].Body, "from-query");
});
