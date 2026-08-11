import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, DeleteLogGroupCommand, DescribeLogGroupsCommand, DescribeLogStreamsCommand, FilterLogEventsCommand, GetLogEventsCommand, ListTagsForResourceCommand, PutLogEventsCommand, PutRetentionPolicyCommand, TagResourceCommand } from "@aws-sdk/client-cloudwatch-logs";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

function clientFor(simulator: StackSim): CloudWatchLogsClient {
  return new CloudWatchLogsClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
}

test("CloudWatch Logs SDK supports groups, streams, concurrent events, filtering, pagination, retention, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-logs-")); const clock = new TestClock(Date.parse("2026-07-14T12:00:00Z"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); let client: CloudWatchLogsClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator);
    await client.send(new CreateLogGroupCommand({ logGroupName: "/learning/app", tags: { environment: "test" } }));
    const group = (await client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: "/learning" }))).logGroups?.[0]; assert.equal(group?.logGroupName, "/learning/app"); assert.match(group?.arn ?? "", /log-group:\/learning\/app:\*$/);
    await client.send(new TagResourceCommand({ resourceArn: group!.arn!, tags: { team: "platform" } }));
    assert.deepEqual((await client.send(new ListTagsForResourceCommand({ resourceArn: group!.arn! }))).tags, { environment: "test", team: "platform" });
    await client.send(new CreateLogStreamCommand({ logGroupName: "/learning/app", logStreamName: "application" }));
    await Promise.all([
      client.send(new PutLogEventsCommand({ logGroupName: "/learning/app", logStreamName: "application", logEvents: [{ timestamp: clock.now(), message: "startup complete" }, { timestamp: clock.now() + 1, message: '{"level":"info","requestId":"one"}' }] })),
      client.send(new PutLogEventsCommand({ logGroupName: "/learning/app", logStreamName: "application", logEvents: [{ timestamp: clock.now() + 2, message: "request finished" }] })),
    ]);
    const streams = await client.send(new DescribeLogStreamsCommand({ logGroupName: "/learning/app", orderBy: "LastEventTime", descending: true })); assert.equal(streams.logStreams?.[0].storedBytes! > 0, true);
    const first = await client.send(new GetLogEventsCommand({ logGroupName: "/learning/app", logStreamName: "application", startFromHead: true, limit: 1 })); assert.equal(first.events?.length, 1); assert.ok(first.nextForwardToken);
    const second = await client.send(new GetLogEventsCommand({ logGroupName: "/learning/app", logStreamName: "application", nextToken: first.nextForwardToken, startFromHead: true, limit: 10 })); assert.equal(second.events?.length, 2); assert.deepEqual([first.events![0].timestamp, ...second.events!.map(event => event.timestamp)], [clock.now(), clock.now() + 1, clock.now() + 2]);
    assert.equal((await client.send(new FilterLogEventsCommand({ logGroupName: "/learning/app", filterPattern: '"request"' }))).events?.length, 2);
    assert.equal((await client.send(new FilterLogEventsCommand({ logGroupName: "/learning/app", filterPattern: '{ $.level = "info" }' }))).events?.[0].message, '{"level":"info","requestId":"one"}');
    await assert.rejects(client.send(new PutLogEventsCommand({ logGroupName: "/learning/app", logStreamName: "application", logEvents: [{ timestamp: clock.now() + 10, message: "later" }, { timestamp: clock.now() + 9, message: "earlier" }] })), (error: any) => error.name === "InvalidParameterException");

    client.destroy(); await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); client = clientFor(simulator);
    assert.equal((await client.send(new GetLogEventsCommand({ logGroupName: "/learning/app", logStreamName: "application", startFromHead: true }))).events?.length, 3, "events must survive restart");
    await client.send(new PutRetentionPolicyCommand({ logGroupName: "/learning/app", retentionInDays: 1 })); clock.advance(2 * 86_400_000 + 60_000); await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await client.send(new GetLogEventsCommand({ logGroupName: "/learning/app", logStreamName: "application", startFromHead: true }))).events?.length, 0);
    await client.send(new DeleteLogGroupCommand({ logGroupName: "/learning/app" })); assert.equal((await client.send(new DescribeLogGroupsCommand({}))).logGroups?.length, 0);
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
