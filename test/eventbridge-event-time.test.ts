import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { EventBridgeClient, PutEventsCommand, PutRuleCommand, PutTargetsCommand } from "@aws-sdk/client-eventbridge";
import { CreateBucketCommand, PutBucketNotificationConfigurationCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

// EventBridge envelopes carry RFC 3339 times with whole seconds, for example "2026-10-21T10:00:00Z":
// https://docs.aws.amazon.com/eventbridge/latest/ref/overiew-event-structure.html
const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const targetArn = `arn:aws:lambda:${region}:${account}:function:time-target`;
const active: Array<{ simulator: StackSim; root: string; clients: Array<{ destroy(): void }> }> = [];

async function harness(start: string) {
  const root = await mkdtemp(join(tmpdir(), "stacksim-eventbridge-time-"));
  const clock = new TestClock(Date.parse(start));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  await simulator.start();
  const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials };
  const events = new EventBridgeClient(options);
  const s3 = new S3Client({ ...options, forcePathStyle: true });
  active.push({ simulator, root, clients: [events, s3] });
  const received: Array<{ payload: string; sourceArn: string }> = [];
  (simulator.lambda as any).enqueueEventBridgeInvocation = async (_arn: string, payload: Buffer, sourceArn: string) => { received.push({ payload: payload.toString("utf8"), sourceArn }); return "accepted"; };
  return { clock, simulator, events, s3, received };
}

afterEach(async () => { while (active.length) { const item = active.pop()!; for (const client of item.clients) client.destroy(); await item.simulator.stop().catch(() => undefined); await rm(item.root, { recursive: true, force: true }); } });

async function drive(clock: TestClock, predicate: () => boolean, timeout = 10_000): Promise<void> { const end = Date.now() + timeout; while (!predicate()) { clock.advance(0); if (Date.now() > end) throw new Error("Timed out waiting for EventBridge delivery"); await new Promise(resolve => setTimeout(resolve, 5)); } }

test("a legacy scheduled rule's event time is the whole-second occurrence", async () => {
  const h = await harness("2026-10-21T09:59:30.250Z");
  const rule = await h.events.send(new PutRuleCommand({ Name: "hourly", ScheduleExpression: "cron(0 * * * ? *)", State: "ENABLED" }));
  await h.events.send(new PutTargetsCommand({ Rule: "hourly", Targets: [{ Id: "lambda", Arn: targetArn }] }));
  h.clock.advance(30_500);
  await drive(h.clock, () => h.received.length === 1);
  const event = JSON.parse(h.received[0].payload);
  assert.equal(event.source, "aws.events"); assert.equal(event["detail-type"], "Scheduled Event"); assert.deepEqual(event.resources, [rule.RuleArn]);
  assert.equal(event.time, "2026-10-21T10:00:00Z");
  assert.match(h.received[0].payload, /"time":"2026-10-21T10:00:00Z"/);
});

test("PutEvents uses the call time without Time and truncates a sub-second Time to whole seconds", async () => {
  const h = await harness("2026-10-21T12:00:00.789Z");
  await h.events.send(new PutRuleCommand({ Name: "all", EventPattern: JSON.stringify({ source: ["time.test"] }) }));
  await h.events.send(new PutTargetsCommand({ Rule: "all", Targets: [{ Id: "lambda", Arn: targetArn }] }));
  await h.events.send(new PutRuleCommand({ Name: "exact-time", EventPattern: JSON.stringify({ source: ["time.test"], time: ["2026-10-21T11:58:30Z"] }) }));
  await h.events.send(new PutTargetsCommand({ Rule: "exact-time", Targets: [{ Id: "transformed", Arn: targetArn, InputTransformer: { InputPathsMap: { time: "$.time" }, InputTemplate: "{\"time\": <time>, \"ingested\": <aws.events.event.ingestion-time>}" } }] }));
  const allArn = `arn:aws:events:${region}:${account}:rule/all`; const exactArn = `arn:aws:events:${region}:${account}:rule/exact-time`;

  const result = await h.events.send(new PutEventsCommand({ Entries: [
    { Source: "time.test", DetailType: "Without time", Detail: "{\"case\":\"without\"}" },
    { Source: "time.test", DetailType: "With time", Detail: "{\"case\":\"with\"}", Time: new Date("2026-10-21T11:58:30.999Z") },
  ] }));
  assert.equal(result.FailedEntryCount, 0);
  await drive(h.clock, () => h.received.length === 3);

  const byCase = new Map(h.received.filter(item => item.sourceArn === allArn).map(item => [JSON.parse(item.payload).detail.case, JSON.parse(item.payload)]));
  assert.equal(byCase.get("without").time, "2026-10-21T12:00:00Z", "a missing Time uses the PutEvents call time in whole seconds");
  assert.equal(byCase.get("with").time, "2026-10-21T11:58:30Z", "a sub-second Time is truncated to whole seconds");

  const transformed = h.received.filter(item => item.sourceArn === exactArn);
  assert.equal(transformed.length, 1, "an event pattern on the whole-second time matches only that event");
  // AWS documents ingestion-time only as an ISO 8601 timestamp, so it keeps its millisecond form.
  assert.deepEqual(JSON.parse(transformed[0].payload), { time: "2026-10-21T11:58:30Z", ingested: "2026-10-21T12:00:00.789Z" });
});

test("an S3 EventBridge notification uses a whole-second event time", async () => {
  const h = await harness("2026-10-21T13:00:00.000Z");
  const bucket = "time-notifications";
  await h.events.send(new PutRuleCommand({ Name: "s3-objects", EventPattern: JSON.stringify({ source: ["aws.s3"], "detail-type": ["Object Created"] }) }));
  await h.events.send(new PutTargetsCommand({ Rule: "s3-objects", Targets: [{ Id: "lambda", Arn: targetArn }] }));
  await h.s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: region } }));
  await h.s3.send(new PutBucketNotificationConfigurationCommand({ Bucket: bucket, NotificationConfiguration: { EventBridgeConfiguration: {} } }));
  h.clock.advance(4_321);
  await h.s3.send(new PutObjectCommand({ Bucket: bucket, Key: "incoming/report.txt", Body: "report" }));
  await drive(h.clock, () => h.received.length === 1);
  const event = JSON.parse(h.received[0].payload);
  assert.equal(event.source, "aws.s3"); assert.equal(event.detail.object.key, "incoming/report.txt");
  assert.equal(event.time, "2026-10-21T13:00:04Z", "the notification publishes at 13:00:04.321 and carries that whole second");
});
