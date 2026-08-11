import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type AttributeValue,
  CreateTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const ttlSchedule = { sweepEveryMs: 100, transitionMs: 10, updateCooldownMs: 20 };

function clients(simulator: StackSim): { dynamodb: DynamoDBClient; cloudwatch: CloudWatchClient } {
  const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials };
  return { dynamodb: new DynamoDBClient(options), cloudwatch: new CloudWatchClient(options) };
}

function validation(promise: Promise<unknown>): Promise<void> {
  return assert.rejects(promise, (error: any) => error.name === "ValidationException");
}

test("DynamoDB TTL validates transitions and removes only eligible items from tables, indexes, and streams", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-ttl-"));
  const clock = new TestClock(Date.parse("2026-07-15T12:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, dynamoTtlSchedule: { ...ttlSchedule, sweepEveryMs: 1_000 }, authMode: "off"});
  let dynamodb: DynamoDBClient | undefined; let cloudwatch: CloudWatchClient | undefined;
  try {
    await simulator.start(); ({ dynamodb, cloudwatch } = clients(simulator));
    const created = await dynamodb.send(new CreateTableCommand({
      TableName: "TtlRecords",
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "category", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }],
    }));
    await waitForTableActive(dynamodb, "TtlRecords", clock);
    assert.equal((await dynamodb.send(new DescribeTimeToLiveCommand({ TableName: "TtlRecords" }))).TimeToLiveDescription?.TimeToLiveStatus, "DISABLED");
    await validation(dynamodb.send(new UpdateTimeToLiveCommand({ TableName: "TtlRecords", TimeToLiveSpecification: { Enabled: true, AttributeName: "x".repeat(256) } })));

    assert.deepEqual((await dynamodb.send(new UpdateTimeToLiveCommand({ TableName: created.TableDescription!.TableArn!, TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" } }))).TimeToLiveSpecification, { Enabled: true, AttributeName: "expiresAt" });
    assert.deepEqual((await dynamodb.send(new DescribeTimeToLiveCommand({ TableName: created.TableDescription!.TableArn! }))).TimeToLiveDescription, { AttributeName: "expiresAt", TimeToLiveStatus: "ENABLING" });
    await validation(dynamodb.send(new UpdateTimeToLiveCommand({ TableName: "TtlRecords", TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" } })));
    clock.advance(ttlSchedule.transitionMs); await simulator.dynamodb.sweepTtlNow();
    assert.equal((await dynamodb.send(new DescribeTimeToLiveCommand({ TableName: "TtlRecords" }))).TimeToLiveDescription?.TimeToLiveStatus, "ENABLED");

    const now = Math.floor(clock.now() / 1000); const fiveYears = 5 * 365 * 24 * 60 * 60;
    const items: Array<Record<string, AttributeValue>> = [
      { id: { S: "absent" } },
      { id: { S: "wrong-type" }, expiresAt: { S: String(now - 1) } },
      { id: { S: "future" }, expiresAt: { N: String(now + 60) } },
      { id: { S: "too-old" }, expiresAt: { N: String(now - fiveYears - 1) } },
      { id: { S: "expired" }, expiresAt: { N: String(now) } },
      { id: { S: "indexed-expired" }, category: { S: "expired-category" }, expiresAt: { N: String(now - 1) } },
    ];
    for (const Item of items) await dynamodb.send(new PutItemCommand({ TableName: "TtlRecords", Item }));
    assert.equal((await dynamodb.send(new GetItemCommand({ TableName: "TtlRecords", Key: { id: { S: "expired" } } }))).Item?.id?.S, "expired");

    await dynamodb.send(new UpdateTableCommand({ TableName: "TtlRecords", StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" } })); clock.advance(50); await new Promise<void>(resolve => setImmediate(resolve));
    const tableState = simulator.store.regionState("eu-west-1").tables.TtlRecords; const streamDescription = (await simulator.dynamodb.DescribeStream({ StreamArn: tableState.latestStreamArn })).StreamDescription; const shardIterator = (await simulator.dynamodb.GetShardIterator({ StreamArn: tableState.latestStreamArn, ShardId: streamDescription.Shards[0].ShardId, ShardIteratorType: "TRIM_HORIZON" })).ShardIterator;
    assert.equal(await simulator.dynamodb.sweepTtlNow(), 2);
    for (const id of ["expired", "indexed-expired"]) assert.equal((await dynamodb.send(new GetItemCommand({ TableName: "TtlRecords", Key: { id: { S: id } } }))).Item, undefined);
    for (const id of ["absent", "wrong-type", "future", "too-old"]) assert.equal((await dynamodb.send(new GetItemCommand({ TableName: "TtlRecords", Key: { id: { S: id } } }))).Item?.id?.S, id);
    assert.equal((await dynamodb.send(new QueryCommand({ TableName: "TtlRecords", IndexName: "ByCategory", KeyConditionExpression: "category = :category", ExpressionAttributeValues: { ":category": { S: "expired-category" } } }))).Count, 0);
    const streamRecords = (await simulator.dynamodb.GetRecords({ ShardIterator: shardIterator })).Records; assert.equal(streamRecords.length, 2);
    for (const record of streamRecords) {
      assert.equal(record.eventName, "REMOVE");
      assert.deepEqual(record.userIdentity, { type: "Service", principalId: "dynamodb.amazonaws.com" });
      assert.ok(record.dynamodb.OldImage); assert.equal(record.dynamodb.StreamViewType, "NEW_AND_OLD_IMAGES");
    }
    const ttlMetric = await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "AWS/DynamoDB", MetricName: "TimeToLiveDeletedItemCount", Dimensions: [{ Name: "TableName", Value: "TtlRecords" }], StartTime: new Date(clock.now() - 60_000), EndTime: new Date(clock.now() + 60_000), Period: 60, Statistics: ["Sum"] }));
    assert.equal(ttlMetric.Datapoints?.[0].Sum, 2);

    clock.advance(ttlSchedule.updateCooldownMs - ttlSchedule.transitionMs);
    await validation(dynamodb.send(new UpdateTimeToLiveCommand({ TableName: "TtlRecords", TimeToLiveSpecification: { Enabled: false, AttributeName: "otherAttribute" } })));
    await dynamodb.send(new UpdateTimeToLiveCommand({ TableName: "TtlRecords", TimeToLiveSpecification: { Enabled: false, AttributeName: "expiresAt" } }));
    assert.equal((await dynamodb.send(new DescribeTimeToLiveCommand({ TableName: "TtlRecords" }))).TimeToLiveDescription?.TimeToLiveStatus, "DISABLING");
    await dynamodb.send(new PutItemCommand({ TableName: "TtlRecords", Item: { id: { S: "during-disable" }, expiresAt: { N: String(now) } } }));
    assert.equal(await simulator.dynamodb.sweepTtlNow(), 1);
    clock.advance(ttlSchedule.transitionMs); await simulator.dynamodb.sweepTtlNow();
    assert.equal((await dynamodb.send(new DescribeTimeToLiveCommand({ TableName: "TtlRecords" }))).TimeToLiveDescription?.TimeToLiveStatus, "DISABLED");
    await dynamodb.send(new PutItemCommand({ TableName: "TtlRecords", Item: { id: { S: "disabled" }, expiresAt: { N: String(now) } } }));
    assert.equal(await simulator.dynamodb.sweepTtlNow(), 0);
    assert.equal((await dynamodb.send(new GetItemCommand({ TableName: "TtlRecords", Key: { id: { S: "disabled" } } }))).Item?.id?.S, "disabled");

    clock.advance(ttlSchedule.updateCooldownMs - ttlSchedule.transitionMs);
    await dynamodb.send(new UpdateTimeToLiveCommand({ TableName: "TtlRecords", TimeToLiveSpecification: { Enabled: true, AttributeName: "removeAfter" } }));
    assert.equal((await dynamodb.send(new DescribeTimeToLiveCommand({ TableName: "TtlRecords" }))).TimeToLiveDescription?.AttributeName, "removeAfter");
  } finally {
    dynamodb?.destroy(); cloudwatch?.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true });
  }
});

test("DynamoDB TTL configuration and scheduled expiration survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-ttl-restart-"));
  const clock = new TestClock(Date.parse("2026-07-15T14:00:00Z"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, dynamoTtlSchedule: { ...ttlSchedule, sweepEveryMs: 20 }, authMode: "off"});
  let dynamodb: DynamoDBClient | undefined;
  try {
    await simulator.start(); ({ dynamodb } = clients(simulator));
    await dynamodb.send(new CreateTableCommand({ TableName: "RestartExpiry", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
    await waitForTableActive(dynamodb, "RestartExpiry", clock);
    await dynamodb.send(new UpdateTimeToLiveCommand({ TableName: "RestartExpiry", TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" } }));
    clock.advance(ttlSchedule.transitionMs); await simulator.dynamodb.sweepTtlNow();
    const expiresAt = Math.floor(clock.now() / 1000) + 1;
    await dynamodb.send(new PutItemCommand({ TableName: "RestartExpiry", Item: { id: { S: "restart-me" }, expiresAt: { N: String(expiresAt) } } }));
    dynamodb.destroy(); await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, dynamoTtlSchedule: { ...ttlSchedule, sweepEveryMs: 20 }, authMode: "off"});
    await simulator.start(); ({ dynamodb } = clients(simulator));
    assert.equal((await dynamodb.send(new DescribeTimeToLiveCommand({ TableName: "RestartExpiry" }))).TimeToLiveDescription?.TimeToLiveStatus, "ENABLED");
    assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    clock.advance(1_000); await new Promise<void>(resolve => setImmediate(resolve));
    clock.advance(20); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((await dynamodb.send(new GetItemCommand({ TableName: "RestartExpiry", Key: { id: { S: "restart-me" } } }))).Item, undefined);
  } finally {
    dynamodb?.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true });
  }
});
