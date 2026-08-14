import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  CancelReplayCommand,
  CreateArchiveCommand,
  CreateEventBusCommand,
  DeleteArchiveCommand,
  DescribeArchiveCommand,
  DescribeReplayCommand,
  EventBridgeClient,
  ListArchivesCommand,
  ListReplaysCommand,
  PutEventsCommand,
  PutRuleCommand,
  PutTargetsCommand,
  StartReplayCommand,
  UpdateArchiveCommand,
} from "@aws-sdk/client-eventbridge";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const active: Array<{ simulator: StackSim; client: EventBridgeClient; root: string }> = [];

async function harness(clock = new TestClock(Date.parse("2026-08-08T12:00:00Z"))) {
  const root = await mkdtemp(join(tmpdir(), "stacksim-eventbridge-archive-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" }); await simulator.start();
  const client = new EventBridgeClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }); active.push({ simulator, client, root }); return { simulator, client, root, clock };
}

afterEach(async () => { while (active.length) { const item = active.pop()!; item.client.destroy(); await item.simulator.stop().catch(() => undefined); await rm(item.root, { recursive: true, force: true }); } });

async function drive(clock: TestClock, predicate: () => boolean, timeout = 10_000): Promise<void> { const end = Date.now() + timeout; while (!predicate()) { clock.advance(0); if (Date.now() > end) throw new Error("Timed out waiting for replay"); await new Promise(resolve => setTimeout(resolve, 5)); } }

test("EVB-04 SDK lifecycle proves independent capture, selected replay identity, and no re-archiving", async () => {
  const h = await harness(); const busArn = `arn:aws:events:${region}:${account}:event-bus/learning`; const selectedArn = `arn:aws:events:${region}:${account}:rule/learning/selected`; const otherArn = `arn:aws:events:${region}:${account}:rule/learning/other`; const targetArn = `arn:aws:lambda:${region}:${account}:function:learning-target`;
  await h.client.send(new CreateEventBusCommand({ Name: "learning" }));
  const created = await h.client.send(new CreateArchiveCommand({ ArchiveName: "orders", EventSourceArn: busArn, Description: "Learning archive", EventPattern: JSON.stringify({ source: ["learning.orders"] }) })); assert.equal(created.State, "ENABLED"); assert(created.CreationTime instanceof Date);
  await h.client.send(new CreateArchiveCommand({ ArchiveName: "orders-two", EventSourceArn: busArn }));
  const firstPage = await h.client.send(new ListArchivesCommand({ Limit: 1 })); assert.equal(firstPage.Archives?.length, 1); assert(firstPage.NextToken); assert.equal((await h.client.send(new ListArchivesCommand({ Limit: 1, NextToken: firstPage.NextToken }))).Archives?.length, 1);
  await h.client.send(new UpdateArchiveCommand({ ArchiveName: "orders", Description: "Updated", RetentionDays: 0 })); assert.equal((await h.client.send(new DescribeArchiveCommand({ ArchiveName: "orders" }))).Description, "Updated");
  await h.client.send(new PutRuleCommand({ Name: "selected", EventBusName: "learning", EventPattern: JSON.stringify({ source: ["learning.orders"] }) })); await h.client.send(new PutRuleCommand({ Name: "other", EventBusName: "learning", EventPattern: JSON.stringify({ source: ["learning.orders"] }) }));
  await h.client.send(new PutTargetsCommand({ Rule: "selected", EventBusName: "learning", Targets: [{ Id: "selected", Arn: targetArn, RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 } }] })); await h.client.send(new PutTargetsCommand({ Rule: "other", EventBusName: "learning", Targets: [{ Id: "other", Arn: targetArn, RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 } }] }));
  let broken = true; const received: any[] = []; (h.simulator.lambda as any).enqueueEventBridgeInvocation = async (_arn: string, payload: Buffer, sourceArn: string) => { if (broken) throw new Error("broken target"); received.push({ payload: JSON.parse(payload.toString("utf8")), sourceArn }); return "accepted"; };
  const eventTime = new Date(h.clock.now() - 60_000);
  const published = await h.client.send(new PutEventsCommand({ Entries: [{ EventBusName: "learning", Source: "learning.orders", DetailType: "Order", Detail: "{\"id\":1}", Time: eventTime }, { EventBusName: "learning", Source: "learning.inventory", DetailType: "Inventory", Detail: "{}", Time: eventTime }] }));
  const originalEventId = published.Entries?.[0].EventId;
  await drive(h.clock, () => h.simulator.eventbridge.deliveryDiagnostics().failed >= 2);
  const archived = await h.client.send(new DescribeArchiveCommand({ ArchiveName: "orders" })); assert.equal(archived.EventCount, 1, "archive filtering is independent of rule/target outcomes"); assert((archived.SizeBytes ?? 0) > 0);
  assert.equal(JSON.parse(await readFile(join(h.root, "state.json"), "utf8")).accounts[account].regions[region].eventArchives, undefined, "payload/index state stays outside state.json");
  const segmentText = await readFile(join(h.root, "data", "eventbridge", account, region, "archives", "segments", (h.simulator.eventbridge as any).archiveStore.archive("orders").records[0].segment), "utf8"); assert(!segmentText.includes("learning.orders") && !segmentText.includes("\"id\":1"), "archive segment is encrypted at rest");

  broken = false;
  const replay = await h.client.send(new StartReplayCommand({ ReplayName: "fixed-consumer", Description: "Replay after target fix", EventSourceArn: created.ArchiveArn!, EventStartTime: new Date(eventTime.getTime() - 1_000), EventEndTime: new Date(eventTime.getTime() + 1_000), Destination: { Arn: busArn, FilterArns: [selectedArn] } })); assert.equal(replay.State, "STARTING");
  await drive(h.clock, () => (h.simulator.eventbridge as any).archiveStore.replay("fixed-consumer")?.state === "COMPLETED");
  await drive(h.clock, () => received.length >= 1);
  const described = await h.client.send(new DescribeReplayCommand({ ReplayName: "fixed-consumer" })); assert.equal(described.State, "COMPLETED"); assert(described.EventLastReplayedTime instanceof Date); assert.deepEqual(described.Destination?.FilterArns, [selectedArn]);
  assert.equal(received.length, 1); assert.equal(received[0].sourceArn, selectedArn); assert.equal(received[0].payload["replay-name"], "fixed-consumer"); assert.equal(received[0].payload.id, originalEventId, "replay preserves the archived event identity"); assert.equal(received[0].payload.account, account); assert.equal(received[0].payload.region, region); assert.equal(received[0].payload.time, eventTime.toISOString()); assert.notEqual(received[0].sourceArn, otherArn);
  assert.equal((await h.client.send(new DescribeArchiveCommand({ ArchiveName: "orders" }))).EventCount, 1, "replayed events are not archived again");
  await h.client.send(new StartReplayCommand({ ReplayName: "fixed-consumer-2", EventSourceArn: created.ArchiveArn!, EventStartTime: new Date(eventTime.getTime() - 1_000), EventEndTime: new Date(eventTime.getTime() + 1_000), Destination: { Arn: busArn, FilterArns: [selectedArn] } }));
  await drive(h.clock, () => (h.simulator.eventbridge as any).archiveStore.replay("fixed-consumer-2")?.state === "COMPLETED");
  const replayPage = await h.client.send(new ListReplaysCommand({ State: "COMPLETED", Limit: 1 })); assert.equal(replayPage.Replays?.[0].ReplayName, "fixed-consumer"); assert(replayPage.NextToken);
  assert.equal((await h.client.send(new ListReplaysCommand({ State: "COMPLETED", Limit: 1, NextToken: replayPage.NextToken }))).Replays?.[0].ReplayName, "fixed-consumer-2");
  await h.client.send(new DeleteArchiveCommand({ ArchiveName: "orders" })); await assert.rejects(h.client.send(new DescribeArchiveCommand({ ArchiveName: "orders" })), (error: any) => error.name === "ResourceNotFoundException");
});

test("EVB-04 retention, fail-closed KMS, cancellation, and replay validation", async () => {
  const h = await harness(); const busArn = `arn:aws:events:${region}:${account}:event-bus/default`;
  await assert.rejects(h.client.send(new CreateArchiveCommand({ ArchiveName: "kms", EventSourceArn: busArn, KmsKeyIdentifier: "alias/local" })), (error: any) => error.name === "ValidationException" && /KMS/.test(error.message));
  assert.equal((await h.client.send(new ListArchivesCommand({}))).Archives?.length, 0, "KMS dependency failure must not persist an archive");
  const archive = await h.client.send(new CreateArchiveCommand({ ArchiveName: "finite", EventSourceArn: busArn, RetentionDays: 1 }));
  const old = new Date(h.clock.now() - 2 * 24 * 60 * 60 * 1_000); await h.client.send(new PutEventsCommand({ Entries: [{ Source: "old.event", DetailType: "Old", Detail: "{}", Time: old }] })); assert.equal((await h.client.send(new DescribeArchiveCommand({ ArchiveName: "finite" }))).EventCount, 0);
  await assert.rejects(h.client.send(new StartReplayCommand({ ReplayName: "bad-range", EventSourceArn: archive.ArchiveArn!, EventStartTime: new Date(h.clock.now()), EventEndTime: new Date(h.clock.now() - 1), Destination: { Arn: busArn } })), (error: any) => error.name === "ValidationException");
  await h.client.send(new PutRuleCommand({ Name: "disabled-replay-rule", State: "DISABLED", EventPattern: JSON.stringify({ source: ["old.event"] }) }));
  const disabledRuleArn = `arn:aws:events:${region}:${account}:rule/disabled-replay-rule`;
  await assert.rejects(h.client.send(new StartReplayCommand({ ReplayName: "disabled-rule", EventSourceArn: archive.ArchiveArn!, EventStartTime: old, EventEndTime: new Date(h.clock.now()), Destination: { Arn: busArn, FilterArns: [disabledRuleArn] } })), (error: any) => error.name === "ValidationException");
  await assert.rejects(h.client.send(new StartReplayCommand({ ReplayName: "missing-rule", EventSourceArn: archive.ArchiveArn!, EventStartTime: old, EventEndTime: new Date(h.clock.now()), Destination: { Arn: busArn, FilterArns: [`arn:aws:events:${region}:${account}:rule/missing`] } })), (error: any) => error.name === "ResourceNotFoundException");
  const started = await h.client.send(new StartReplayCommand({ ReplayName: "cancel-me", EventSourceArn: archive.ArchiveArn!, EventStartTime: old, EventEndTime: new Date(h.clock.now()), Destination: { Arn: busArn } })); assert.equal(started.State, "STARTING");
  await assert.rejects(h.client.send(new StartReplayCommand({ ReplayName: "same-archive-conflict", EventSourceArn: archive.ArchiveArn!, EventStartTime: old, EventEndTime: new Date(h.clock.now()), Destination: { Arn: busArn } })), (error: any) => error.name === "ConcurrentModificationException");
  await assert.rejects(h.client.send(new DeleteArchiveCommand({ ArchiveName: "finite" })), (error: any) => error.name === "ConcurrentModificationException");
  assert.equal((await h.client.send(new CancelReplayCommand({ ReplayName: "cancel-me" }))).State, "CANCELLING"); await drive(h.clock, () => (h.simulator.eventbridge as any).archiveStore.replay("cancel-me")?.state === "CANCELLED"); assert.equal((await h.client.send(new DescribeReplayCommand({ ReplayName: "cancel-me" }))).State, "CANCELLED");
  await assert.rejects(h.client.send(new CancelReplayCommand({ ReplayName: "cancel-me" })), (error: any) => error.name === "IllegalStatusException");
});

test("EVB-04 restart resumes an expired replay lease after a checkpoint fault at least once", async () => {
  const h = await harness(); const busArn = `arn:aws:events:${region}:${account}:event-bus/default`; const targetArn = `arn:aws:lambda:${region}:${account}:function:restart-target`; const eventTime = new Date(h.clock.now() - 60_000);
  const archive = await h.client.send(new CreateArchiveCommand({ ArchiveName: "restart", EventSourceArn: busArn })); await h.client.send(new PutRuleCommand({ Name: "restart-rule", EventPattern: JSON.stringify({ source: ["restart.test"] }) })); await h.client.send(new PutTargetsCommand({ Rule: "restart-rule", Targets: [{ Id: "target", Arn: targetArn }] })); await h.client.send(new PutEventsCommand({ Entries: [{ Source: "restart.test", DetailType: "Restart", Detail: "{}", Time: eventTime }] }));
  const store = (h.simulator.eventbridge as any).archiveStore; const originalCheckpoint = store.checkpointReplay.bind(store); let injected = true; store.checkpointReplay = async (...args: any[]) => { if (injected) { injected = false; throw new Error("injected replay checkpoint fault"); } return originalCheckpoint(...args); };
  await h.client.send(new StartReplayCommand({ ReplayName: "restart-replay", EventSourceArn: archive.ArchiveArn!, EventStartTime: new Date(eventTime.getTime() - 1_000), EventEndTime: new Date(eventTime.getTime() + 1_000), Destination: { Arn: busArn } })); await drive(h.clock, () => store.replay("restart-replay")?.leaseUntil > h.clock.now());

  const tracked = active.find(item => item.simulator === h.simulator)!; tracked.client.destroy(); await h.simulator.stop(); active.splice(active.indexOf(tracked), 1); h.clock.advance(30_000);
  const restarted = new StackSim({ port: 0, invokePort: 0, dataDir: h.root, region, clock: h.clock, authMode: "off" }); await restarted.start(); const client = new EventBridgeClient({ endpoint: `http://127.0.0.1:${restarted.port}`, region, credentials }); active.push({ simulator: restarted, client, root: h.root }); const received: any[] = []; (restarted.lambda as any).enqueueEventBridgeInvocation = async (_arn: string, payload: Buffer) => { received.push(JSON.parse(payload.toString("utf8"))); return "accepted"; };
  await drive(h.clock, () => (restarted.eventbridge as any).archiveStore.replay("restart-replay")?.state === "COMPLETED"); await drive(h.clock, () => received.some(event => event["replay-name"] === "restart-replay")); assert.equal((await client.send(new DescribeReplayCommand({ ReplayName: "restart-replay" }))).State, "COMPLETED"); assert(received.filter(event => event["replay-name"] === "restart-replay").length >= 1); assert.equal((await client.send(new DescribeArchiveCommand({ ArchiveName: "restart" }))).EventCount, 1);
});

test("EVB-04 does not acknowledge PutEvents before archive publication and recovers the committed segment", async () => {
  const h = await harness(); const busArn = `arn:aws:events:${region}:${account}:event-bus/default`; await h.client.send(new CreateArchiveCommand({ ArchiveName: "publication-boundary", EventSourceArn: busArn }));
  const store = (h.simulator.eventbridge as any).archiveStore; const originalPersist = store.persist.bind(store); let injected = true; store.persist = async (value: unknown) => { if (injected) { injected = false; throw new Error("injected archive control publication fault"); } return originalPersist(value); };
  const result = await h.client.send(new PutEventsCommand({ Entries: [{ Source: "publication.boundary", DetailType: "Publication", Detail: "{}" }] })); assert.equal(result.FailedEntryCount, 1); assert.equal(result.Entries?.[0].ErrorCode, "InternalFailure"); assert.equal(store.archive("publication-boundary").records.length, 0);

  const tracked = active.find(item => item.simulator === h.simulator)!; tracked.client.destroy(); await h.simulator.stop(); active.splice(active.indexOf(tracked), 1);
  const restarted = new StackSim({ port: 0, invokePort: 0, dataDir: h.root, region, clock: h.clock, authMode: "off" }); await restarted.start(); const client = new EventBridgeClient({ endpoint: `http://127.0.0.1:${restarted.port}`, region, credentials }); active.push({ simulator: restarted, client, root: h.root });
  assert.equal((await client.send(new DescribeArchiveCommand({ ArchiveName: "publication-boundary" }))).EventCount, 1, "restart re-indexes the committed segment after the failed acknowledgement boundary");
});
