import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BatchWriteItemCommand,
  CreateTableCommand,
  DescribeGlobalTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  PutItemCommand,
  PutResourcePolicyCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import { ExecuteStatementCommand } from "@aws-sdk/client-dynamodb";
import { parseConditionExpression, validateExpressionSubstitutions } from "../src/dynamodb/expressions.js";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const westRegion = "eu-west-1";
const eastRegion = "us-east-1";

function clientFor(simulator: StackSim, region = westRegion): DynamoDBClient {
  return new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
}

async function settle(): Promise<void> { await new Promise(resolve => setImmediate(resolve)); }
async function tick(clock: TestClock, ms = 100): Promise<void> { clock.advance(ms); await settle(); }

async function awaitActive(client: DynamoDBClient, clock: TestClock, TableName: string): Promise<void> {
  await tick(clock);
  assert.equal((await client.send(new DescribeTableCommand({ TableName }))).Table?.TableStatus, "ACTIVE");
}

test("DDBGAP-01/03 item collection metrics for LSI-backed writes and omit without LSIs", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddbgap-metrics-"));
  const clock = new TestClock(Date.parse("2026-08-10T12:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off" });
  let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator);
    await client.send(new CreateTableCommand({
      TableName: "WithLsi", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }, { AttributeName: "gsiSk", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      LocalSecondaryIndexes: [{ IndexName: "ByGsiSk", KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "gsiSk", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }],
    }));
    await client.send(new CreateTableCommand({
      TableName: "NoLsi", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    }));
    await awaitActive(client, clock, "WithLsi"); await awaitActive(client, clock, "NoLsi");

    const none = await client.send(new TransactWriteItemsCommand({
      ReturnItemCollectionMetrics: "NONE",
      TransactItems: [{ Put: { TableName: "WithLsi", Item: { pk: { S: "a" }, sk: { S: "1" }, gsiSk: { S: "x" } } } }],
    }));
    assert.equal(none.ItemCollectionMetrics, undefined);

    const sized = await client.send(new TransactWriteItemsCommand({
      ReturnItemCollectionMetrics: "SIZE",
      TransactItems: [
        { Put: { TableName: "WithLsi", Item: { pk: { S: "a" }, sk: { S: "2" }, gsiSk: { S: "y" } } } },
        { Put: { TableName: "WithLsi", Item: { pk: { S: "a" }, sk: { S: "3" }, gsiSk: { S: "z" } } } },
      ],
    }));
    assert.ok((sized.ItemCollectionMetrics as any)?.WithLsi?.length === 1);
    assert.deepEqual((sized.ItemCollectionMetrics as any)?.WithLsi?.[0].ItemCollectionKey, { pk: { S: "a" } });
    assert.equal((sized.ItemCollectionMetrics as any)?.WithLsi?.[0].SizeEstimateRangeGB?.length, 2);

    const without = await client.send(new TransactWriteItemsCommand({
      ReturnItemCollectionMetrics: "SIZE",
      TransactItems: [{ Put: { TableName: "NoLsi", Item: { id: { S: "1" } } } }],
    }));
    assert.equal(without.ItemCollectionMetrics, undefined);

    const put = await client.send(new PutItemCommand({
      TableName: "WithLsi", Item: { pk: { S: "b" }, sk: { S: "1" }, gsiSk: { S: "q" } }, ReturnItemCollectionMetrics: "SIZE",
    }));
    assert.deepEqual(put.ItemCollectionMetrics?.ItemCollectionKey, { pk: { S: "b" } });
    assert.equal(put.ItemCollectionMetrics?.SizeEstimateRangeGB?.length, 2);

    const batch = await client.send(new BatchWriteItemCommand({
      ReturnItemCollectionMetrics: "SIZE",
      RequestItems: {
        WithLsi: [
          { PutRequest: { Item: { pk: { S: "c" }, sk: { S: "1" }, gsiSk: { S: "1" } } } },
          { PutRequest: { Item: { pk: { S: "c" }, sk: { S: "2" }, gsiSk: { S: "2" } } } },
        ],
        NoLsi: [{ PutRequest: { Item: { id: { S: "batch" } } } }],
      },
    }));
    assert.equal((batch.ItemCollectionMetrics as any)?.WithLsi?.length, 1);
    assert.equal((batch.ItemCollectionMetrics as any)?.NoLsi, undefined);
  } finally {
    client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("DDBGAP-02 DescribeTable.Replicas reports per-Region status after policy denial", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddbgap-replicas-"));
  const clock = new TestClock(Date.parse("2026-08-10T13:00:00Z"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off" });
  let west: DynamoDBClient | undefined; let east: DynamoDBClient | undefined;
  try {
    await simulator.start(); west = clientFor(simulator, westRegion); east = clientFor(simulator, eastRegion);
    await west.send(new CreateTableCommand({
      TableName: "ReplicaStatus", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
    }));
    await awaitActive(west, clock, "ReplicaStatus");
    await west.send(new UpdateTableCommand({ TableName: "ReplicaStatus", ReplicaUpdates: [{ Create: { RegionName: eastRegion } }], MultiRegionConsistency: "EVENTUAL" }));
    await tick(clock);
    const eastArn = `arn:aws:dynamodb:${eastRegion}:000000000000:table/ReplicaStatus`;
    await east.send(new PutResourcePolicyCommand({
      ResourceArn: eastArn, ExpectedRevisionId: "NO_POLICY",
      Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: "*", Action: "dynamodb:PutItem", Resource: eastArn }] }),
    }));
    clock.advance(1);
    await west.send(new PutItemCommand({ TableName: "ReplicaStatus", Item: { id: { S: "blocked" } } }));

    const global = await west.send(new DescribeGlobalTableCommand({ GlobalTableName: "ReplicaStatus" }));
    const eastGlobal = global.GlobalTableDescription?.ReplicationGroup?.find(replica => replica.RegionName === eastRegion);
    assert.equal(eastGlobal?.ReplicaStatus, "REGION_DISABLED");

    const described = await west.send(new DescribeTableCommand({ TableName: "ReplicaStatus" }));
    const eastReplica = described.Table?.Replicas?.find(replica => replica.RegionName === eastRegion);
    const westReplica = described.Table?.Replicas?.find(replica => replica.RegionName === westRegion);
    assert.equal(eastReplica?.ReplicaStatus, "REGION_DISABLED");
    assert.match(eastReplica?.ReplicaStatusDescription ?? "", /not authorized/);
    assert.equal(westReplica?.ReplicaStatus, "ACTIVE");

    west.destroy(); east.destroy(); west = undefined; east = undefined;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off" });
    await simulator.start(); west = clientFor(simulator, westRegion);
    const afterRestart = await west.send(new DescribeTableCommand({ TableName: "ReplicaStatus" }));
    assert.equal(afterRestart.Table?.Replicas?.find(replica => replica.RegionName === eastRegion)?.ReplicaStatus, "REGION_DISABLED");
    assert.equal(afterRestart.Table?.Replicas?.find(replica => replica.RegionName === westRegion)?.ReplicaStatus, "ACTIVE");
  } finally {
    west?.destroy(); east?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("DDBGAP-04 INDEXES consumed capacity nests table and GSI breakdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddbgap-capacity-"));
  const clock = new TestClock(Date.parse("2026-08-10T14:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off" });
  let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator);
    await client.send(new CreateTableCommand({
      TableName: "CapacityShape", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "category", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }],
    }));
    await awaitActive(client, clock, "CapacityShape");
    await client.send(new PutItemCommand({ TableName: "CapacityShape", Item: { id: { S: "1" }, category: { S: "books" } } }));

    const gsi = await client.send(new QueryCommand({
      TableName: "CapacityShape", IndexName: "ByCategory", ReturnConsumedCapacity: "INDEXES",
      KeyConditionExpression: "category = :category", ExpressionAttributeValues: { ":category": { S: "books" } },
    }));
    assert.ok(gsi.ConsumedCapacity?.GlobalSecondaryIndexes?.ByCategory);
    assert.ok((gsi.ConsumedCapacity?.GlobalSecondaryIndexes?.ByCategory.CapacityUnits ?? 0) > 0);
    assert.equal(gsi.ConsumedCapacity?.Table?.CapacityUnits, 0);

    const write = await client.send(new PutItemCommand({
      TableName: "CapacityShape", Item: { id: { S: "2" }, category: { S: "films" } }, ReturnConsumedCapacity: "INDEXES",
    }));
    assert.ok(write.ConsumedCapacity?.Table);
    assert.ok((write.ConsumedCapacity?.Table?.WriteCapacityUnits ?? 0) > 0);
    assert.ok(write.ConsumedCapacity?.GlobalSecondaryIndexes?.ByCategory);

    const keyMove = await client.send(new UpdateItemCommand({
      TableName: "CapacityShape", Key: { id: { S: "2" } },
      UpdateExpression: "SET #category = :category", ExpressionAttributeNames: { "#category": "category" }, ExpressionAttributeValues: { ":category": { S: "music" } },
      ReturnConsumedCapacity: "INDEXES",
    }));
    assert.equal(keyMove.ConsumedCapacity?.Table?.WriteCapacityUnits, 1);
    assert.equal(keyMove.ConsumedCapacity?.GlobalSecondaryIndexes?.ByCategory.WriteCapacityUnits, 2);
    assert.equal(keyMove.ConsumedCapacity?.WriteCapacityUnits, 3);

    const tableQuery = await client.send(new QueryCommand({
      TableName: "CapacityShape", ReturnConsumedCapacity: "INDEXES",
      KeyConditionExpression: "id = :id", ExpressionAttributeValues: { ":id": { S: "1" } },
    }));
    assert.ok((tableQuery.ConsumedCapacity?.Table?.ReadCapacityUnits ?? 0) > 0);
    assert.equal(tableQuery.ConsumedCapacity?.GlobalSecondaryIndexes, undefined);

    await client.send(new CreateTableCommand({
      TableName: "LsiCapacity", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }, { AttributeName: "lsiSk", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      LocalSecondaryIndexes: [{ IndexName: "ByLsiSk", KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "lsiSk", KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" } }],
    }));
    await awaitActive(client, clock, "LsiCapacity");
    await client.send(new PutItemCommand({ TableName: "LsiCapacity", Item: { pk: { S: "group" }, sk: { S: "1" }, lsiSk: { S: "a" }, payload: { S: "base-only" } } }));
    const lsi = await client.send(new QueryCommand({
      TableName: "LsiCapacity", IndexName: "ByLsiSk", ReturnConsumedCapacity: "INDEXES",
      KeyConditionExpression: "pk = :pk", ProjectionExpression: "#payload",
      ExpressionAttributeNames: { "#payload": "payload" }, ExpressionAttributeValues: { ":pk": { S: "group" } },
    }));
    assert.equal(lsi.Items?.[0]?.payload?.S, "base-only");
    assert.equal(lsi.ConsumedCapacity?.LocalSecondaryIndexes?.ByLsiSk.ReadCapacityUnits, 0.5);
    assert.equal(lsi.ConsumedCapacity?.Table?.ReadCapacityUnits, 0.5);
    assert.equal(lsi.ConsumedCapacity?.ReadCapacityUnits, 1);
  } finally {
    client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("DDBGAP-05 begins_with on binary attributes compares decoded bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddbgap-begins-"));
  const clock = new TestClock(Date.parse("2026-08-10T15:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off" });
  let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator);
    await client.send(new CreateTableCommand({
      TableName: "BinaryPrefix", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "B" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
    }));
    await awaitActive(client, clock, "BinaryPrefix");

    // Bytes [0xfb, 0x00] encode to base64 "-wA="; prefix [0xfb] encodes to "+w==".
    // String startsWith fails ("-wA=".startsWith("+w==") === false) but byte prefix matches.
    const valueBytes = Buffer.from([0xfb, 0x00]);
    const prefixBytes = Buffer.from([0xfb]);
    assert.equal(valueBytes.toString("base64").startsWith(prefixBytes.toString("base64")), false);
    await client.send(new PutItemCommand({ TableName: "BinaryPrefix", Item: { pk: { S: "row" }, sk: { B: valueBytes } } }));

    const matched = await client.send(new QueryCommand({
      TableName: "BinaryPrefix",
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": { S: "row" }, ":prefix": { B: prefixBytes } },
    }));
    assert.equal(matched.Count, 1);

    const partiql = await client.send(new ExecuteStatementCommand({
      Statement: "SELECT * FROM BinaryPrefix WHERE pk = ? AND begins_with(sk, ?)",
      Parameters: [{ S: "row" }, { B: prefixBytes }],
    }));
    assert.equal(partiql.Items?.length, 1);

    const filtered = await client.send(new ScanCommand({
      TableName: "BinaryPrefix",
      FilterExpression: "begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":prefix": { B: prefixBytes } },
    }));
    assert.equal(filtered.Count, 1);
  } finally {
    client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("DDBGAP-06/07 CreateTable lifecycle stays CREATING until tick and GSI Query rejects CREATING/DELETING", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddbgap-lifecycle-"));
  const clock = new TestClock(Date.parse("2026-08-10T16:00:00Z"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off" });
  let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator);
    const created = await client.send(new CreateTableCommand({
      TableName: "LifecycleGaps", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "owner", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [{ IndexName: "ByOwner", KeySchema: [{ AttributeName: "owner", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }],
    }));
    assert.equal(created.TableDescription?.TableStatus, "CREATING");
    assert.equal(created.TableDescription?.GlobalSecondaryIndexes?.[0].IndexStatus, "CREATING");
    assert.equal(created.TableDescription?.GlobalSecondaryIndexes?.[0].Backfilling, undefined);

    const immediate = await client.send(new DescribeTableCommand({ TableName: "LifecycleGaps" }));
    assert.equal(immediate.Table?.TableStatus, "CREATING");
    assert.equal(immediate.Table?.GlobalSecondaryIndexes?.[0].IndexStatus, "CREATING");
    assert.equal(immediate.Table?.GlobalSecondaryIndexes?.[0].Backfilling, undefined);
    await assert.rejects(client.send(new PutItemCommand({ TableName: "LifecycleGaps", Item: { id: { S: "1" }, owner: { S: "a" } } })), (error: any) => error.name === "ResourceNotFoundException");
    await assert.rejects(client.send(new QueryCommand({
      TableName: "LifecycleGaps", IndexName: "ByOwner", KeyConditionExpression: "#owner = :owner",
      ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: { ":owner": { S: "a" } },
    })), (error: any) => error.name === "ResourceNotFoundException");

    client.destroy(); await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off" });
    await simulator.start(); client = clientFor(simulator);
    assert.equal((await client.send(new DescribeTableCommand({ TableName: "LifecycleGaps" }))).Table?.TableStatus, "CREATING");
    await tick(clock);
    const active = await client.send(new DescribeTableCommand({ TableName: "LifecycleGaps" }));
    assert.equal(active.Table?.TableStatus, "ACTIVE");
    assert.equal(active.Table?.GlobalSecondaryIndexes?.[0].IndexStatus, "ACTIVE");
    assert.equal(active.Table?.GlobalSecondaryIndexes?.[0].Backfilling, undefined);

    await client.send(new PutItemCommand({ TableName: "LifecycleGaps", Item: { id: { S: "1" }, owner: { S: "team" } } }));
    const updating = await client.send(new UpdateTableCommand({
      TableName: "LifecycleGaps",
      GlobalSecondaryIndexUpdates: [{ Update: { IndexName: "ByOwner", OnDemandThroughput: { MaxReadRequestUnits: 5, MaxWriteRequestUnits: 5 } } }],
    }));
    assert.equal(updating.TableDescription?.GlobalSecondaryIndexes?.[0].IndexStatus, "UPDATING");
    const duringUpdate = await client.send(new QueryCommand({
      TableName: "LifecycleGaps", IndexName: "ByOwner", KeyConditionExpression: "#owner = :owner",
      ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: { ":owner": { S: "team" } },
    }));
    assert.equal(duringUpdate.Count, 1);
    await tick(clock);

    const deleting = await client.send(new UpdateTableCommand({
      TableName: "LifecycleGaps", GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: "ByOwner" } }],
    }));
    assert.equal(deleting.TableDescription?.GlobalSecondaryIndexes?.[0].IndexStatus, "DELETING");
    await assert.rejects(client.send(new QueryCommand({
      TableName: "LifecycleGaps", IndexName: "ByOwner", KeyConditionExpression: "#owner = :owner",
      ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: { ":owner": { S: "team" } },
    })), (error: any) => error.name === "ResourceNotFoundException");
    await tick(clock);
  } finally {
    client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("DDBGAP-15 completed GSI deletes prune only obsolete definitions and old snapshots stay forward-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddbgap-active-definitions-"));
  const clock = new TestClock(Date.parse("2026-08-21T10:00:00Z"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off" });
  let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator);
    await client.send(new CreateTableCommand({
      TableName: "DefinitionLifecycle", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "id", AttributeType: "S" },
        { AttributeName: "shared", AttributeType: "S" },
        { AttributeName: "obsolete", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        { IndexName: "KeepShared", KeySchema: [{ AttributeName: "shared", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } },
        { IndexName: "DeleteObsolete", KeySchema: [{ AttributeName: "obsolete", KeyType: "HASH" }, { AttributeName: "shared", KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" } },
      ],
    }));
    await awaitActive(client, clock, "DefinitionLifecycle");

    // Treat the successful UpdateTable response as lost. Before stabilization the
    // deleting index and every definition used by it remain authoritative.
    await client.send(new UpdateTableCommand({ TableName: "DefinitionLifecycle", GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: "DeleteObsolete" } }] }));
    let described = (await client.send(new DescribeTableCommand({ TableName: "DefinitionLifecycle" }))).Table!;
    assert.equal(described.GlobalSecondaryIndexes?.find(index => index.IndexName === "DeleteObsolete")?.IndexStatus, "DELETING");
    assert.deepEqual(described.AttributeDefinitions?.map(definition => definition.AttributeName), ["id", "shared", "obsolete"]);

    client.destroy(); await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off" });
    await simulator.start(); client = clientFor(simulator);
    described = (await client.send(new DescribeTableCommand({ TableName: "DefinitionLifecycle" }))).Table!;
    assert.equal(described.GlobalSecondaryIndexes?.find(index => index.IndexName === "DeleteObsolete")?.IndexStatus, "DELETING");
    assert.deepEqual(described.AttributeDefinitions?.map(definition => definition.AttributeName), ["id", "shared", "obsolete"]);
    await tick(clock);
    described = (await client.send(new DescribeTableCommand({ TableName: "DefinitionLifecycle" }))).Table!;
    assert.deepEqual(described.GlobalSecondaryIndexes?.map(index => index.IndexName), ["KeepShared"]);
    assert.deepEqual(described.AttributeDefinitions?.map(definition => definition.AttributeName), ["id", "shared"]);

    client.destroy(); await simulator.stop();
    const statePath = join(root, "state.json");
    const stale = JSON.parse(await readFile(statePath, "utf8"));
    stale.accounts["000000000000"].regions[westRegion].tables.DefinitionLifecycle.attributeDefinitions.push({ AttributeName: "obsolete", AttributeType: "S" });
    await writeFile(statePath, JSON.stringify(stale), { mode: 0o600 });

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off" });
    await simulator.start(); client = clientFor(simulator);
    described = (await client.send(new DescribeTableCommand({ TableName: "DefinitionLifecycle" }))).Table!;
    assert.deepEqual(described.AttributeDefinitions?.map(definition => definition.AttributeName), ["id", "shared"], "old stale snapshots are canonical on read");

    await client.send(new UpdateTableCommand({
      TableName: "DefinitionLifecycle",
      AttributeDefinitions: [{ AttributeName: "replacement", AttributeType: "N" }],
      GlobalSecondaryIndexUpdates: [{ Create: { IndexName: "AddReplacement", KeySchema: [{ AttributeName: "replacement", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } } }],
    }));
    await tick(clock);
    described = (await client.send(new DescribeTableCommand({ TableName: "DefinitionLifecycle" }))).Table!;
    assert.deepEqual(described.GlobalSecondaryIndexes?.map(index => index.IndexName), ["KeepShared", "AddReplacement"]);
    assert.deepEqual(described.AttributeDefinitions?.map(definition => definition.AttributeName), ["id", "shared", "replacement"]);

    client.destroy(); await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off" });
    await simulator.start(); client = clientFor(simulator);
    described = (await client.send(new DescribeTableCommand({ TableName: "DefinitionLifecycle" }))).Table!;
    assert.deepEqual(described.AttributeDefinitions?.map(definition => definition.AttributeName), ["id", "shared", "replacement"]);
  } finally {
    client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("DDBGAP-13 expression substitution and operator limits match AWS thresholds", async () => {
  validateExpressionSubstitutions({ ["#" + "n".repeat(254)]: "ok" }, { [":" + "v".repeat(254)]: { S: "x" } });
  assert.throws(() => validateExpressionSubstitutions({ ["#" + "n".repeat(255)]: "too-long" }), (error: any) => error.code === "ValidationException");
  const aggregateLimit = 2 * 1024 * 1024; const aggregateToken = ":v"; const valueOverhead = Buffer.byteLength(JSON.stringify({ S: "" }));
  const aggregateValue = "x".repeat(aggregateLimit - Buffer.byteLength(aggregateToken) - valueOverhead);
  validateExpressionSubstitutions(undefined, { [aggregateToken]: { S: aggregateValue } });
  assert.throws(() => validateExpressionSubstitutions(undefined, { [aggregateToken]: { S: `${aggregateValue}x` } }), (error: any) => error.code === "ValidationException");

  const names: Record<string, string> = {};
  const values: Record<string, any> = {};
  let expression = "attribute_exists(#a0)";
  for (let index = 0; index < 60; index += 1) {
    names[`#a${index}`] = `attr${index}`;
    values[`:v${index}`] = { S: `value-${index}` };
    if (index > 0) expression += ` OR #a${index} = :v${index}`;
  }
  parseConditionExpression(expression, { names, values });

  // 150 equality comparisons OR-joined => 150 compares + 149 ORs = 299 operators.
  const ops299 = Array.from({ length: 150 }, (_, index) => `#x = :v${index}`).join(" OR ");
  const ops301 = `${ops299} OR #x = :v150`; // +1 OR +1 compare => 301
  const opNames = { "#x": "x" };
  const opValues = Object.fromEntries(Array.from({ length: 151 }, (_, index) => [`:v${index}`, { N: String(index) }]));
  parseConditionExpression(ops299, { names: opNames, values: opValues });
  assert.throws(() => parseConditionExpression(ops301, { names: opNames, values: opValues }), (error: any) => error.code === "ValidationException");

  const root = await mkdtemp(join(tmpdir(), "stacksim-ddbgap-limits-"));
  const clock = new TestClock(Date.parse("2026-08-10T17:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off" });
  let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator);
    await client.send(new CreateTableCommand({
      TableName: "LimitTable", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    }));
    await awaitActive(client, clock, "LimitTable");
    await client.send(new PutItemCommand({ TableName: "LimitTable", Item: { id: { S: "1" }, x: { N: "0" } } }));
    const oversizedToken = "#" + "n".repeat(255);
    await assert.rejects(client.send(new ScanCommand({
      TableName: "LimitTable", ExpressionAttributeNames: { [oversizedToken]: "x" },
    })), (error: any) => error.name === "ValidationException");
    await assert.rejects(client.send(new TransactWriteItemsCommand({
      TransactItems: [{ Put: { TableName: "LimitTable", Item: { id: { S: "transaction" } }, ExpressionAttributeNames: { [oversizedToken]: "x" } } }],
    })), (error: any) => error.name === "ValidationException");
    await assert.rejects(client.send(new UpdateItemCommand({
      TableName: "LimitTable", Key: { id: { S: "1" } },
      UpdateExpression: "SET #x = :v",
      ExpressionAttributeNames: { ["#" + "n".repeat(255)]: "x" },
      ExpressionAttributeValues: { ":v": { N: "1" } },
    })), (error: any) => error.name === "ValidationException");
  } finally {
    client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});
