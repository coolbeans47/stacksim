import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";
import * as sdk from "@aws-sdk/client-sqs";
import { TestClock } from "../src/core/clock.js";
import { Scheduler } from "../src/core/scheduler.js";
import { TelemetryBus } from "../src/core/telemetry.js";
import { SQS_ACTIONS, SqsService } from "../src/sqs.js";
import { StateStore } from "../src/state.js";
import { SqsStorage } from "../src/sqs/storage.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "stacksim-move-"));
  let store = new StateStore(root, "000000000000", "eu-west-1"); await store.load();
  const clock = new TestClock(1_800_000_000_000), scheduler = new Scheduler(clock), telemetry = new TelemetryBus();
  let endpoint = "http://localhost";
  let service = new SqsService(store, "eu-west-1", clock, telemetry, scheduler, () => endpoint); await service.start();
  const server = createServer((req, res) => { void service.handle(req, res, "move-test"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  const client = new sdk.SQSClient({ region: "eu-west-1", endpoint, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });
  const h = { root, clock, scheduler, telemetry, endpoint, client, get store() { return store; }, get service() { return service; },
    async restart() { await service.stop(); store = new StateStore(root, "000000000000", "eu-west-1"); await store.load(); service = new SqsService(store, "eu-west-1", clock, telemetry, scheduler, () => endpoint); await service.start(); },
    async tick(ms = 1000) { clock.advance(ms); await service.runMessageMoveTasks(); },
    async queue(name: string, attributes: Record<string, string> = {}) { const q = await service.CreateQueue({ QueueName: name, Attributes: { ...(name.endsWith(".fifo") ? { FifoQueue: "true", ContentBasedDeduplication: "true" } : {}), ...attributes } }); return { url: q.QueueUrl, arn: service.resolveQueueUrl(q.QueueUrl).queueArn }; },
    async task(arn: string) { return (await service.ListMessageMoveTasks({ SourceArn: arn, MaxResults: 10 })).Results[0] as any; },
    async query(Action: string, input: Record<string, string>) { const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ Action, Version: "2012-11-05", ...input }) }); return { status: response.status, xml: await response.text() }; },
  };
  cleanups.push(async () => { client.destroy(); await service.stop(); scheduler.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return h;
}
async function pair(h: Awaited<ReturnType<typeof setup>>, fifo = false) {
  const suffix = fifo ? ".fifo" : "";
  const dlq = await h.queue(`dead${suffix}`);
  const source = await h.queue(`source${suffix}`, { VisibilityTimeout: "0", RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 1 }) });
  return { dlq, source };
}
async function poison(h: Awaited<ReturnType<typeof setup>>, source: { url: string }, body = "poison", fifo = false) {
  const sent = await h.service.SendMessage({ QueueUrl: source.url, MessageBody: body, MessageAttributes: { key: { DataType: "String", StringValue: "stable-business-key" } }, MessageSystemAttributes: { AWSTraceHeader: { DataType: "String", StringValue: "Root=1-test" } }, ...(fifo ? { MessageGroupId: "group", MessageDeduplicationId: body } : {}) });
  await h.service.ReceiveMessage({ QueueUrl: source.url }); await h.service.ReceiveMessage({ QueueUrl: source.url });
  return sent.MessageId;
}

test("all installed SQS SDK commands are explicitly registered; SDK and Query move shapes agree", async () => {
  assert.deepEqual(Object.keys(sdk).filter(key => key.endsWith("Command") && !key.startsWith("$")).map(key => key.slice(0, -7)).sort(), [...SQS_ACTIONS].sort());
  const h = await setup(); const { dlq, source } = await pair(h);
  await poison(h, source);
  const { TaskHandle } = await h.client.send(new sdk.StartMessageMoveTaskCommand({ SourceArn: dlq.arn, MaxNumberOfMessagesPerSecond: 1 }));
  assert.ok(TaskHandle);
  const listed = await h.client.send(new sdk.ListMessageMoveTasksCommand({ SourceArn: dlq.arn }));
  assert.equal(listed.Results?.[0].TaskHandle, TaskHandle); assert.equal(listed.Results?.[0].StartedTimestamp, h.clock.now());
  assert.equal(listed.Results?.[0].DestinationArn, undefined);
  const xml = await h.query("ListMessageMoveTasks", { SourceArn: dlq.arn });
  assert.match(xml.xml, /<Result><TaskHandle>/); assert.match(xml.xml, /<ApproximateNumberOfMessagesToMove>1</);
  const cancel = await h.query("CancelMessageMoveTask", { TaskHandle: TaskHandle! }); assert.equal(cancel.status, 200); assert.match(cancel.xml, /<ApproximateNumberOfMessagesMoved>0</);
  await h.tick(); assert.equal((await h.task(dlq.arn)).Status, "CANCELLED");
  const start = await h.query("StartMessageMoveTask", { SourceArn: dlq.arn, DestinationArn: source.arn, MaxNumberOfMessagesPerSecond: "2" });
  assert.equal(start.status, 200); assert.match(start.xml, /<TaskHandle>/);
  await h.tick(); await h.tick();
  const done = await h.task(dlq.arn); assert.equal(done.Status, "COMPLETED"); assert.equal(done.ApproximateNumberOfMessagesMoved, 1); assert.equal(done.TaskHandle, undefined);
  for (const action of ["StartMessageMoveTask", "ListMessageMoveTasks", "CancelMessageMoveTask"]) assert.equal((await h.query(action, action === "CancelMessageMoveTask" ? { TaskHandle: "bad" } : { SourceArn: "bad" })).status, 400);
  const unsupported = await fetch(h.endpoint, { method: "POST", headers: { "x-amz-target": "AmazonSQS.StartMessageMoveTask", "content-type": "application/x-amz-json-1.0" }, body: JSON.stringify({ SourceArn: dlq.arn, Filter: "ignored?" }) }); assert.equal(unsupported.status, 400);
});

test("shared DLQ uses stored original queue, resets transport metadata, preserves payload and attributes", async () => {
  const h = await setup(); const { dlq, source } = await pair(h);
  const second = await h.queue("second", { VisibilityTimeout: "0", RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 1 }) });
  const firstId = await poison(h, source, "one"); await poison(h, second, "two");
  await h.service.SetQueueAttributes({ QueueUrl: source.url, Attributes: { RedrivePolicy: "" } });
  h.clock.advance(5000);
  await h.service.StartMessageMoveTask({ SourceArn: dlq.arn });
  await h.tick(); await h.tick(); await h.tick();
  assert.equal((await h.task(dlq.arn)).Status, "COMPLETED");
  const one = (await h.service.ReceiveMessage({ QueueUrl: source.url, MessageAttributeNames: ["All"], MessageSystemAttributeNames: ["All"] })).Messages![0];
  assert.equal(one.Body, "one"); assert.notEqual(one.MessageId, firstId); assert.equal(one.Attributes?.ApproximateReceiveCount, "1"); assert.equal(one.Attributes?.AWSTraceHeader, "Root=1-test"); assert.equal(one.MessageAttributes?.key.StringValue, "stable-business-key"); assert.ok(Number(one.Attributes?.SentTimestamp) > 1_800_000_000_000); assert.equal(one.Attributes?.DeadLetterQueueSourceArn, undefined);
  assert.equal((await h.service.ReceiveMessage({ QueueUrl: second.url })).Messages?.[0].Body, "two");
});

test("FIFO DLQ transformation survives redrive with fresh sequence and ID; producers interleave", async () => {
  const h = await setup(); const { dlq, source } = await pair(h, true);
  const firstId = await poison(h, source, "fifo-work", true);
  const inspect = (await h.service.ReceiveMessage({ QueueUrl: dlq.url, VisibilityTimeout: 0, MessageSystemAttributeNames: ["All"] })).Messages![0];
  assert.equal(inspect.Attributes?.MessageDeduplicationId, firstId); assert.equal(inspect.Attributes?.DeadLetterQueueSourceArn, source.arn);
  await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, MaxNumberOfMessagesPerSecond: 1 });
  await h.tick();
  await h.service.SendMessage({ QueueUrl: source.url, MessageBody: "new producer", MessageGroupId: "group", MessageDeduplicationId: "producer" });
  const messages = (await h.service.ReceiveMessage({ QueueUrl: source.url, MaxNumberOfMessages: 10, MessageSystemAttributeNames: ["All"] })).Messages!;
  assert.deepEqual(messages.map(m => m.Body), ["fifo-work", "new producer"]);
  assert.notEqual(messages[0].MessageId, firstId); assert.equal(messages[0].Attributes?.MessageDeduplicationId, firstId); assert.equal(messages[0].Attributes?.MessageGroupId, "group");
  assert.ok(BigInt(messages[0].Attributes!.SequenceNumber) < BigInt(messages[1].Attributes!.SequenceNumber));
});

test("validation covers source eligibility, ARN scope, types, limits, dependencies and forged handles", async () => {
  const h = await setup(); const { dlq, source } = await pair(h); const fifo = await h.queue("other.fifo");
  for (const input of [{ SourceArn: source.arn }, { SourceArn: dlq.arn, DestinationArn: dlq.arn }, { SourceArn: dlq.arn, DestinationArn: fifo.arn }, { SourceArn: dlq.arn.replace("eu-west-1", "us-east-1") }, { SourceArn: dlq.arn.replace("000000000000", "111111111111") }]) await assert.rejects(h.service.StartMessageMoveTask(input), { code: "UnsupportedOperation" });
  await assert.rejects(h.service.StartMessageMoveTask({ SourceArn: h.service.queueArn("missing") }), { code: "ResourceNotFoundException" });
  for (const rate of [0, -1, 501, 1.5, NaN]) await assert.rejects(h.service.StartMessageMoveTask({ SourceArn: dlq.arn, MaxNumberOfMessagesPerSecond: rate }), { code: "InvalidParameterValue" });
  for (const MaxResults of [0, 11, 2.5]) await assert.rejects(h.service.ListMessageMoveTasks({ SourceArn: dlq.arn, MaxResults }), { code: "InvalidParameterValue" });
  const started = await h.service.StartMessageMoveTask({ SourceArn: dlq.arn });
  await assert.rejects(h.service.StartMessageMoveTask({ SourceArn: dlq.arn }), { code: "UnsupportedOperation" });
  const forged = Buffer.from(JSON.stringify({ taskId: "fake", sourceArn: dlq.arn })).toString("base64url");
  await assert.rejects(h.service.CancelMessageMoveTask({ TaskHandle: forged }), { code: "ResourceNotFoundException" });
  await h.tick(); await assert.rejects(h.service.CancelMessageMoveTask(started), { code: "UnsupportedOperation" });
  await h.service.SetQueueAttributes({ QueueUrl: dlq.url, Attributes: { Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: "*", Action: "sqs:*", Resource: dlq.arn, Condition: { StringNotEquals: { "aws:SourceVpc": "vpc-test" } } }] }) } });
  await assert.rejects(h.service.StartMessageMoveTask({ SourceArn: dlq.arn }), /VPC endpoint/);
});

test("velocity, partial cancellation, new DLQ arrivals, delayed and in-flight messages, and bounded history", async () => {
  const h = await setup(); const { dlq, source } = await pair(h); const target = await h.queue("repair");
  for (let i = 0; i < 4; i++) await h.service.SendMessage({ QueueUrl: dlq.url, MessageBody: `work-${i}` });
  const task = await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, DestinationArn: target.arn, MaxNumberOfMessagesPerSecond: 2 });
  await h.tick(0); assert.equal((await h.task(dlq.arn)).ApproximateNumberOfMessagesMoved, 1);
  await h.tick(499); assert.equal((await h.task(dlq.arn)).ApproximateNumberOfMessagesMoved, 1);
  await h.tick(1); assert.equal((await h.task(dlq.arn)).ApproximateNumberOfMessagesMoved, 2);
  await h.service.SendMessage({ QueueUrl: dlq.url, MessageBody: "concurrent" });
  assert.equal((await h.service.CancelMessageMoveTask(task)).ApproximateNumberOfMessagesMoved, 2);
  await h.tick(); assert.equal((await h.task(dlq.arn)).Status, "CANCELLED");
  assert.equal((await h.service.GetQueueAttributes({ QueueUrl: target.url, AttributeNames: ["All"] })).Attributes?.ApproximateNumberOfMessages, "2");
  await h.service.PurgeQueue({ QueueUrl: dlq.url });
  await h.service.SendMessage({ QueueUrl: dlq.url, MessageBody: "delayed", DelaySeconds: 3 });
  await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, DestinationArn: target.arn }); await h.tick(0); assert.equal((await h.task(dlq.arn)).Status, "RUNNING");
  await h.tick(3000); await h.tick(); assert.equal((await h.task(dlq.arn)).Status, "COMPLETED");
  for (let i = 0; i < 12; i++) { await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, DestinationArn: source.arn }); await h.tick(); }
  assert.equal((await h.service.ListMessageMoveTasks({ SourceArn: dlq.arn, MaxResults: 10 })).Results.length, 10);
  assert.equal((await h.service.ListMessageMoveTasks({ SourceArn: dlq.arn })).Results.length, 1);
  await h.service.stop(); assert.equal(h.scheduler.size, 0);
});

for (const point of ["before-destination", "after-destination", "after-source"] as const) test(`restart reconciles ${point} publication without lost messages or repeated committed moves`, async () => {
  const h = await setup(); const { dlq, source } = await pair(h, true); await poison(h, source, "recover", true);
  const task = await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, MaxNumberOfMessagesPerSecond: 1 });
  const storage = (h.service as any).storage as SqsStorage;
  const originalSave = (storage as any).saveQueue.bind(storage);
  let fired = false;
  (storage as any).saveQueue = async (data: any) => {
    const destination = data.queueArn === source.arn && Object.values(data.messages).some((m: any) => m.transferId && m.messageId !== m.messageDeduplicationId);
    const removed = data.queueArn === dlq.arn && data.moveTasks?.[0]?.ApproximateNumberOfMessagesMoved === 1;
    if (!fired && ((point !== "after-source" && destination) || (point === "after-source" && removed))) {
      fired = true; if (point !== "before-destination") await originalSave(data); throw new Error("simulated termination");
    }
    return originalSave(data);
  };
  // Stop immediately at the interrupted journal boundary; bypass worker failure finalization to model process loss.
  const data = await storage.readQueue(dlq.arn); const message = Object.values(data.messages)[0];
  await assert.rejects(storage.moveMessage(dlq.arn, source.arn, message.messageId, (m, id, target) => {
    target.nextSequenceNumber = "10"; target.deduplication!["recovered"] = { expiresAt: h.clock.now() + 300000, messageId: "new-transport", sequenceNumber: "9" };
    return { ...m, messageId: "new-transport", transferId: id, sequenceNumber: "9", receiveCount: 0, availableAt: h.clock.now(), invisibleUntil: undefined };
  }, { taskHandle: task.TaskHandle, nextMoveAt: h.clock.now() + 1000 }));
  assert.equal(fired, true);
  await h.restart(); await h.tick();
  const done = await h.task(dlq.arn); assert.equal(done.ApproximateNumberOfMessagesMoved, 1); assert.equal(done.Status, "COMPLETED");
  const dest = await ((h.service as any).storage as SqsStorage).readQueue(source.arn);
  assert.equal(Object.keys(dest.messages).length, 1); assert.equal(dest.nextSequenceNumber, "10"); assert.ok(dest.deduplication?.recovered);
  assert.equal(Object.keys((await ((h.service as any).storage as SqsStorage).readQueue(dlq.arn)).messages).length, 0);
  assert.equal(await readFile(join(rootOf(h), "moves.journal"), "utf8"), "");
});
function rootOf(h: Awaited<ReturnType<typeof setup>>) { return join(h.root, "data", "sqs", "queues"); }

test("restart resumes running work; deletion, missing provenance, storage errors and timeout fail safely", async () => {
  const h = await setup(); const { dlq } = await pair(h); const target = await h.queue("target");
  await h.service.SendMessage({ QueueUrl: dlq.url, MessageBody: "direct" });
  await h.service.StartMessageMoveTask({ SourceArn: dlq.arn }); await h.tick(); assert.match((await h.task(dlq.arn)).FailureReason, /CouldNotDetermineMessageSource/);
  await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, DestinationArn: target.arn }); await h.restart(); await h.tick(); await h.tick(); assert.equal((await h.task(dlq.arn)).Status, "COMPLETED");
  await h.service.SendMessage({ QueueUrl: dlq.url, MessageBody: "still here" });
  await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, DestinationArn: target.arn }); await h.service.DeleteQueue({ QueueUrl: target.url }); await h.tick(); assert.equal((await h.task(dlq.arn)).Status, "FAILED");
  const target2 = await h.queue("target2"); await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, DestinationArn: target2.arn });
  const storage = (h.service as any).storage; const read = storage.readPayload.bind(storage); storage.readPayload = () => { throw new Error("secret message content credentials"); };
  await h.tick(); storage.readPayload = read; assert.match((await h.task(dlq.arn)).FailureReason, /StorageFailure/); assert.doesNotMatch(JSON.stringify(await h.task(dlq.arn)), /secret message/);
  await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, DestinationArn: target2.arn }); await h.tick(36 * 60 * 60_000); assert.match((await h.task(dlq.arn)).FailureReason, /TaskTimedOut/);
  assert.equal((await h.service.GetQueueAttributes({ QueueUrl: dlq.url, AttributeNames: ["All"] })).Attributes?.ApproximateNumberOfMessages, "1");
});

test("telemetry failures do not fail committed sends, DLQ transfers, redrive or consumer notification", async () => {
  const h = await setup(); const { dlq, source } = await pair(h); const target = await h.queue("target");
  const polling = h.service.ReceiveMessage({ QueueUrl: target.url, WaitTimeSeconds: 20 });
  const unsubscribe = h.telemetry.subscribe(() => { throw new Error("payload-secret"); });
  const sent = await h.service.SendMessage({ QueueUrl: target.url, MessageBody: "wakes waiter" });
  assert.equal((await polling).Messages?.[0].MessageId, sent.MessageId);
  await poison(h, source);
  await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, DestinationArn: target.arn }); await h.tick(); await h.tick();
  assert.equal((await h.task(dlq.arn)).ApproximateNumberOfMessagesMoved, 1); assert.equal((await h.task(dlq.arn)).Status, "COMPLETED");
  assert.ok(h.service.diagnostics.length <= 32); assert.equal(h.service.diagnostics.at(-1)?.code, "TelemetrySubscriberFailed"); assert.doesNotMatch(JSON.stringify(h.service.diagnostics), /payload-secret/);
  unsubscribe(); await h.restart(); assert.equal((await h.task(dlq.arn)).ApproximateNumberOfMessagesMoved, 1);
});

test("in-flight visibility, oldest arrival ordering, expiration and source deletion are deliberate", async () => {
  const h = await setup(); const { dlq, source } = await pair(h); const destination = await h.queue("repaired");
  for (const body of ["first", "second"]) await h.service.SendMessage({ QueueUrl: dlq.url, MessageBody: body });
  const receipt = (await h.service.ReceiveMessage({ QueueUrl: dlq.url, VisibilityTimeout: 10 })).Messages![0];
  await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, DestinationArn: destination.arn, MaxNumberOfMessagesPerSecond: 1 });
  await h.tick(0); assert.equal((await h.task(dlq.arn)).ApproximateNumberOfMessagesMoved, 1);
  assert.equal((await h.task(dlq.arn)).Status, "RUNNING");
  await h.service.ChangeMessageVisibility({ QueueUrl: dlq.url, ReceiptHandle: receipt.ReceiptHandle!, VisibilityTimeout: 0 });
  await h.tick(); await h.tick(); assert.equal((await h.task(dlq.arn)).ApproximateNumberOfMessagesMoved, 2);
  // Fresh arrivals sharing a timestamp use a durable arrival ordinal, not random transport IDs.
  for (const body of ["third", "fourth", "fifth"]) await h.service.SendMessage({ QueueUrl: dlq.url, MessageBody: body });
  const storage = (h.service as any).storage as SqsStorage;
  const seen: string[] = []; const move = storage.moveMessage.bind(storage);
  storage.moveMessage = async (...args) => { seen.push((await storage.readPayload((await storage.readQueue(args[0])).messages[args[2]].blobId)).body); return move(...args); };
  await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, DestinationArn: destination.arn });
  for (let i = 0; i < 4; i++) await h.tick(); assert.deepEqual(seen, ["third", "fourth", "fifth"]); storage.moveMessage = move;
  await h.service.SetQueueAttributes({ QueueUrl: dlq.url, Attributes: { MessageRetentionPeriod: "60" } });
  await h.service.SendMessage({ QueueUrl: dlq.url, MessageBody: "expires", DelaySeconds: 90 });
  await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, DestinationArn: destination.arn }); await h.tick(61000);
  assert.equal((await h.task(dlq.arn)).Status, "COMPLETED"); assert.equal((await h.task(dlq.arn)).ApproximateNumberOfMessagesMoved, 0);
  await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, DestinationArn: destination.arn });
  await h.service.SetQueueAttributes({ QueueUrl: source.url, Attributes: { RedrivePolicy: "" } });
  await h.service.DeleteQueue({ QueueUrl: dlq.url }); await h.tick();
  assert.equal((await storage.readQueue(dlq.arn)).moveTasks?.[0].Status, "FAILED");
  await h.restart(); assert.equal(h.scheduler.size, 0);
});

test("account-wide active-task quota and simultaneous starts are bounded", async () => {
  const h = await setup();
  for (let i = 0; i < 101; i++) {
    const dlq = await h.queue(`quota-dead-${i}`);
    await h.queue(`quota-source-${i}`, { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 1 }) });
    if (i < 100) await h.service.StartMessageMoveTask({ SourceArn: dlq.arn });
    else await assert.rejects(h.service.StartMessageMoveTask({ SourceArn: dlq.arn }), { code: "RequestThrottled" });
  }
  const other = new SqsService(h.store, "us-east-1", h.clock, h.telemetry, h.scheduler, () => h.endpoint);
  await other.start();
  try {
    const dlq = await other.CreateQueue({ QueueName: "other-region-dead" });
    const arn = other.resolveQueueUrl(dlq.QueueUrl).queueArn;
    await other.CreateQueue({ QueueName: "other-region-source", Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 1 }) } });
    await assert.rejects(other.StartMessageMoveTask({ SourceArn: arn }), { code: "RequestThrottled" });
  } finally { await other.stop(); }
  assert.equal(h.scheduler.size, 1, "one regional worker regardless of task count");
  await h.tick();
  const arn = h.service.queueArn("quota-dead-0");
  const results = await Promise.allSettled([h.service.StartMessageMoveTask({ SourceArn: arn }), h.service.StartMessageMoveTask({ SourceArn: arn })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
});


test("FIFO redrive honors an in-flight group head while independent groups can progress", async () => {
  const h = await setup(); const { dlq, source } = await pair(h, true);
  for (const [body, group] of [["head", "a"], ["follower", "a"], ["independent", "b"]]) await h.service.SendMessage({ QueueUrl: dlq.url, MessageBody: body, MessageGroupId: group });
  const head = (await h.service.ReceiveMessage({ QueueUrl: dlq.url, VisibilityTimeout: 10 })).Messages![0];
  assert.equal(head.Body, "head");
  await h.service.StartMessageMoveTask({ SourceArn: dlq.arn, DestinationArn: source.arn, MaxNumberOfMessagesPerSecond: 1 });
  await h.tick();
  assert.equal((await h.task(dlq.arn)).ApproximateNumberOfMessagesMoved, 1);
  assert.equal((await h.service.ReceiveMessage({ QueueUrl: source.url })).Messages?.[0].Body, "independent");
  await h.tick(); assert.equal((await h.task(dlq.arn)).ApproximateNumberOfMessagesMoved, 1);
  await h.service.ChangeMessageVisibility({ QueueUrl: dlq.url, ReceiptHandle: head.ReceiptHandle!, VisibilityTimeout: 0 });
  await h.tick(); await h.tick(); await h.tick();
  assert.equal((await h.task(dlq.arn)).Status, "COMPLETED"); assert.equal((await h.task(dlq.arn)).ApproximateNumberOfMessagesMoved, 3);
});
