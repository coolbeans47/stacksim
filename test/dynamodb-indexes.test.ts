import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BatchWriteItemCommand,
  CreateTableCommand,
  type AttributeValue,
  type CreateTableCommandInput,
  DeleteItemCommand,
  DescribeEndpointsCommand,
  DescribeLimitsCommand,
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function clientFor(simulator: StackSim): DynamoDBClient {
  return new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
}

async function lifecycleTick(simulator: StackSim, clock: TestClock): Promise<void> {
  clock.advance(100);
  await new Promise<void>(resolve => setImmediate(resolve));
  await simulator.store.save();
}

function validation(promise: Promise<unknown>): Promise<void> {
  return assert.rejects(promise, (error: any) => error.name === "ValidationException");
}

function indexedTable(TableName: string): CreateTableCommandInput {
  return {
    TableName,
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 6 },
    AttributeDefinitions: [
      { AttributeName: "tenant", AttributeType: "S" },
      { AttributeName: "recordId", AttributeType: "N" },
      { AttributeName: "created", AttributeType: "N" },
      { AttributeName: "category", AttributeType: "S" },
      { AttributeName: "score", AttributeType: "N" },
    ],
    KeySchema: [
      { AttributeName: "tenant", KeyType: "HASH" },
      { AttributeName: "recordId", KeyType: "RANGE" },
    ],
    LocalSecondaryIndexes: [{
      IndexName: "ByCreated",
      KeySchema: [
        { AttributeName: "tenant", KeyType: "HASH" },
        { AttributeName: "created", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "KEYS_ONLY" },
    }],
    GlobalSecondaryIndexes: [{
      IndexName: "ByCategory",
      KeySchema: [
        { AttributeName: "category", KeyType: "HASH" },
        { AttributeName: "score", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["title"] },
      ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 3 },
    }],
  };
}

test("DynamoDB secondary indexes stay sparse, projected, ordered, paginated, and atomic across every write path", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-indexes-"));
  const clock = new TestClock(Date.parse("2026-07-14T12:00:00Z"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"});
  let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator);
    const creating = await client.send(new CreateTableCommand(indexedTable("IndexedRecords")));
    assert.equal(creating.TableDescription?.TableStatus, "CREATING");
    assert.equal(creating.TableDescription?.GlobalSecondaryIndexes?.[0].IndexStatus, "CREATING");
    assert.equal(creating.TableDescription?.GlobalSecondaryIndexes?.[0].Backfilling, undefined);
    assert.equal((await client.send(new DescribeTableCommand({ TableName: "IndexedRecords" }))).Table?.TableStatus, "CREATING");
    await lifecycleTick(simulator, clock);

    const table = (await client.send(new DescribeTableCommand({ TableName: "IndexedRecords" }))).Table!;
    assert.equal(table.TableStatus, "ACTIVE");
    assert.deepEqual([table.ProvisionedThroughput?.ReadCapacityUnits, table.ProvisionedThroughput?.WriteCapacityUnits], [5, 6]);
    const lsi = table.LocalSecondaryIndexes?.find(index => index.IndexName === "ByCreated")!;
    const gsi = table.GlobalSecondaryIndexes?.find(index => index.IndexName === "ByCategory")!;
    assert.match(lsi.IndexArn ?? "", /:table\/IndexedRecords\/index\/ByCreated$/);
    assert.match(gsi.IndexArn ?? "", /:table\/IndexedRecords\/index\/ByCategory$/);
    assert.equal(gsi.IndexStatus, "ACTIVE");
    assert.deepEqual([gsi.ProvisionedThroughput?.ReadCapacityUnits, gsi.ProvisionedThroughput?.WriteCapacityUnits], [2, 3]);
    assert.equal(lsi.ItemCount, 0); assert.equal(gsi.ItemCount, 0);

    const items: Array<Record<string, AttributeValue>> = [
      { tenant: { S: "a" }, recordId: { N: "1" }, created: { N: "30" }, category: { S: "books" }, score: { N: "2" }, title: { S: "one" }, secret: { S: "hidden-one" } },
      { tenant: { S: "a" }, recordId: { N: "2" }, created: { N: "10" }, category: { S: "books" }, score: { N: "1" }, title: { S: "two" }, secret: { S: "hidden-two" } },
      { tenant: { S: "a" }, recordId: { N: "3" }, created: { N: "20" }, title: { S: "no-gsi-keys" } },
      { tenant: { S: "a" }, recordId: { N: "4" }, category: { S: "books" }, score: { N: "3" }, title: { S: "no-lsi-key" } },
      { tenant: { S: "a" }, recordId: { N: "5" }, created: { N: "25" }, category: { S: "books" }, title: { S: "half-a-gsi-key" } },
      { tenant: { S: "b" }, recordId: { N: "1" }, created: { N: "5" }, category: { S: "audio" }, score: { N: "9" }, title: { S: "other-partition" } },
    ];
    for (const Item of items) await client.send(new PutItemCommand({ TableName: "IndexedRecords", Item }));
    await validation(client.send(new PutItemCommand({
      TableName: "IndexedRecords", Item: { tenant: { S: "a" }, recordId: { N: "99" }, category: { N: "1" }, score: { N: "1" } },
    })));
    assert.equal((await client.send(new GetItemCommand({ TableName: "IndexedRecords", Key: { tenant: { S: "a" }, recordId: { N: "99" } } }))).Item, undefined);

    const lsiFirst = await client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCreated", ConsistentRead: true, Limit: 2,
      KeyConditionExpression: "tenant = :tenant", ExpressionAttributeValues: { ":tenant": { S: "a" } },
    }));
    assert.deepEqual(lsiFirst.Items, [
      { tenant: { S: "a" }, recordId: { N: "2" }, created: { N: "10" } },
      { tenant: { S: "a" }, recordId: { N: "3" }, created: { N: "20" } },
    ]);
    assert.deepEqual(lsiFirst.LastEvaluatedKey, { tenant: { S: "a" }, recordId: { N: "3" }, created: { N: "20" } });
    const lsiSecond = await client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCreated", Limit: 2, ExclusiveStartKey: lsiFirst.LastEvaluatedKey,
      KeyConditionExpression: "tenant = :tenant", ExpressionAttributeValues: { ":tenant": { S: "a" } },
    }));
    assert.deepEqual(lsiSecond.Items?.map(item => item.recordId.N), ["5", "1"]);
    assert.equal(lsiSecond.LastEvaluatedKey, undefined);
    const lsiReverse = await client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCreated", ScanIndexForward: false,
      KeyConditionExpression: "tenant = :tenant", ExpressionAttributeValues: { ":tenant": { S: "a" } },
    }));
    assert.deepEqual(lsiReverse.Items?.map(item => item.recordId.N), ["1", "5", "3", "2"]);

    const gsiFirst = await client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCategory", Limit: 2,
      KeyConditionExpression: "#category = :category", ExpressionAttributeNames: { "#category": "category" }, ExpressionAttributeValues: { ":category": { S: "books" } },
    }));
    assert.deepEqual(gsiFirst.Items, [
      { tenant: { S: "a" }, recordId: { N: "2" }, category: { S: "books" }, score: { N: "1" }, title: { S: "two" } },
      { tenant: { S: "a" }, recordId: { N: "1" }, category: { S: "books" }, score: { N: "2" }, title: { S: "one" } },
    ]);
    assert.deepEqual(gsiFirst.LastEvaluatedKey, { tenant: { S: "a" }, recordId: { N: "1" }, category: { S: "books" }, score: { N: "2" } });
    const projected = await client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCategory", Limit: 1, ProjectionExpression: "#title, score",
      KeyConditionExpression: "#category = :category", ExpressionAttributeNames: { "#category": "category", "#title": "title" }, ExpressionAttributeValues: { ":category": { S: "books" } },
    }));
    assert.deepEqual(projected.Items, [{ title: { S: "two" }, score: { N: "1" } }]);
    const gsiSecond = await client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCategory", Limit: 2, ExclusiveStartKey: gsiFirst.LastEvaluatedKey,
      KeyConditionExpression: "#category = :category", ExpressionAttributeNames: { "#category": "category" }, ExpressionAttributeValues: { ":category": { S: "books" } },
    }));
    assert.deepEqual(gsiSecond.Items?.map(item => item.score.N), ["3"]);
    const gsiReverse = await client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCategory", ScanIndexForward: false,
      KeyConditionExpression: "#category = :category", ExpressionAttributeNames: { "#category": "category" }, ExpressionAttributeValues: { ":category": { S: "books" } },
    }));
    assert.deepEqual(gsiReverse.Items?.map(item => item.score.N), ["3", "2", "1"]);
    const count = await client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCategory", Select: "COUNT",
      KeyConditionExpression: "#category = :category", ExpressionAttributeNames: { "#category": "category" }, ExpressionAttributeValues: { ":category": { S: "books" } },
    }));
    assert.equal(count.Count, 3); assert.equal(count.Items, undefined);
    await validation(client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCategory", Select: "ALL_ATTRIBUTES",
      KeyConditionExpression: "#category = :category", ExpressionAttributeNames: { "#category": "category" }, ExpressionAttributeValues: { ":category": { S: "books" } },
    })));
    await validation(client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCategory", ProjectionExpression: "#secret", ExpressionAttributeNames: { "#category": "category", "#secret": "secret" },
      KeyConditionExpression: "#category = :category", ExpressionAttributeValues: { ":category": { S: "books" } },
    })));
    await validation(client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCategory", ConsistentRead: true,
      KeyConditionExpression: "#category = :category", ExpressionAttributeNames: { "#category": "category" }, ExpressionAttributeValues: { ":category": { S: "books" } },
    })));
    await validation(client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCategory", KeyConditionExpression: "tenant = :tenant", ExpressionAttributeValues: { ":tenant": { S: "a" } },
    })));

    const scanFirst = await client.send(new ScanCommand({ TableName: "IndexedRecords", IndexName: "ByCategory", Limit: 2 }));
    assert.deepEqual(scanFirst.Items?.map(item => [item.category.S, item.score.N]), [["audio", "9"], ["books", "1"]]);
    assert.deepEqual(scanFirst.LastEvaluatedKey, { tenant: { S: "a" }, recordId: { N: "2" }, category: { S: "books" }, score: { N: "1" } });
    const scanSecond = await client.send(new ScanCommand({ TableName: "IndexedRecords", IndexName: "ByCategory", Limit: 2, ExclusiveStartKey: scanFirst.LastEvaluatedKey }));
    assert.deepEqual(scanSecond.Items?.map(item => [item.category.S, item.score.N]), [["books", "2"], ["books", "3"]]);
    assert.equal(scanSecond.LastEvaluatedKey, undefined);

    await client.send(new UpdateItemCommand({
      TableName: "IndexedRecords", Key: { tenant: { S: "a" }, recordId: { N: "2" } },
      UpdateExpression: "SET category = :films, score = :nine, created = :forty",
      ExpressionAttributeValues: { ":films": { S: "films" }, ":nine": { N: "9" }, ":forty": { N: "40" } },
    }));
    await client.send(new UpdateItemCommand({
      TableName: "IndexedRecords", Key: { tenant: { S: "a" }, recordId: { N: "3" } },
      UpdateExpression: "SET category = :books, score = :zero", ExpressionAttributeValues: { ":books": { S: "books" }, ":zero": { N: "0" } },
    }));
    await client.send(new DeleteItemCommand({ TableName: "IndexedRecords", Key: { tenant: { S: "a" }, recordId: { N: "1" } } }));
    await client.send(new PutItemCommand({ TableName: "IndexedRecords", Item: { tenant: { S: "a" }, recordId: { N: "4" }, created: { N: "50" }, title: { S: "overwrite-removes-gsi-entry" } } }));
    const reindexed = await client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCategory", KeyConditionExpression: "category = :books", ExpressionAttributeValues: { ":books": { S: "books" } },
    }));
    assert.deepEqual(reindexed.Items?.map(item => item.recordId.N), ["3"]);
    const movedLsi = await client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCreated", KeyConditionExpression: "tenant = :tenant", ExpressionAttributeValues: { ":tenant": { S: "a" } },
    }));
    assert.deepEqual(movedLsi.Items?.map(item => [item.recordId.N, item.created.N]), [["3", "20"], ["5", "25"], ["2", "40"], ["4", "50"]]);

    const batch = await client.send(new BatchWriteItemCommand({ RequestItems: { IndexedRecords: [
      { PutRequest: { Item: { tenant: { S: "a" }, recordId: { N: "10" }, created: { N: "60" }, category: { S: "books" }, score: { N: "4" }, title: { S: "batch-indexed" } } } },
      { DeleteRequest: { Key: { tenant: { S: "a" }, recordId: { N: "3" } } } },
      { PutRequest: { Item: { tenant: { S: "a" }, recordId: { N: "11" }, created: { N: "70" }, title: { S: "batch-sparse" } } } },
    ] } }));
    assert.deepEqual(batch.UnprocessedItems, {});
    assert.deepEqual((await client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCategory", KeyConditionExpression: "category = :books", ExpressionAttributeValues: { ":books": { S: "books" } },
    }))).Items?.map(item => item.recordId.N), ["10"]);

    await client.send(new TransactWriteItemsCommand({ TransactItems: [
      { Put: { TableName: "IndexedRecords", Item: { tenant: { S: "a" }, recordId: { N: "20" }, created: { N: "80" }, category: { S: "books" }, score: { N: "6" }, title: { S: "transaction-indexed" }, secret: { S: "project-me-only-in-all" } } } },
      { Update: { TableName: "IndexedRecords", Key: { tenant: { S: "a" }, recordId: { N: "10" } }, UpdateExpression: "SET category = :films, score = :five", ExpressionAttributeValues: { ":films": { S: "films" }, ":five": { N: "5" } } } },
      { Delete: { TableName: "IndexedRecords", Key: { tenant: { S: "a" }, recordId: { N: "11" } } } },
    ] }));
    assert.deepEqual((await client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCategory", KeyConditionExpression: "category = :films", ExpressionAttributeValues: { ":films": { S: "films" } },
    }))).Items?.map(item => [item.recordId.N, item.score.N]), [["10", "5"], ["2", "9"]]);
    assert.deepEqual((await client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCategory", KeyConditionExpression: "category = :books", ExpressionAttributeValues: { ":books": { S: "books" } },
    }))).Items?.map(item => item.recordId.N), ["20"]);

    const gsiBeforeRestart = await client.send(new ScanCommand({ TableName: "IndexedRecords", IndexName: "ByCategory" }));
    const lsiBeforeRestart = await client.send(new ScanCommand({ TableName: "IndexedRecords", IndexName: "ByCreated" }));
    assert.equal(gsiBeforeRestart.Count, 4); assert.equal(lsiBeforeRestart.Count, 6);
    client.destroy(); await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); client = clientFor(simulator);
    assert.deepEqual((await client.send(new ScanCommand({ TableName: "IndexedRecords", IndexName: "ByCategory" }))).Items, gsiBeforeRestart.Items);
    assert.deepEqual((await client.send(new ScanCommand({ TableName: "IndexedRecords", IndexName: "ByCreated" }))).Items, lsiBeforeRestart.Items);
    const restartedDescription = (await client.send(new DescribeTableCommand({ TableName: "IndexedRecords" }))).Table!;
    assert.equal(restartedDescription.GlobalSecondaryIndexes?.[0].ItemCount, 4);
    assert.equal(restartedDescription.LocalSecondaryIndexes?.[0].ItemCount, 6);
    assert.ok((restartedDescription.GlobalSecondaryIndexes?.[0].IndexSizeBytes ?? 0) > 0);
    await client.send(new UpdateItemCommand({
      TableName: "IndexedRecords", Key: { tenant: { S: "a" }, recordId: { N: "20" } }, UpdateExpression: "REMOVE category, score",
    }));
    assert.equal((await client.send(new QueryCommand({
      TableName: "IndexedRecords", IndexName: "ByCategory", KeyConditionExpression: "category = :books", ExpressionAttributeValues: { ":books": { S: "books" } },
    }))).Count, 0, "rebuilt index state must remain writable after restart");
  } finally {
    client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("UpdateTable exposes deterministic GSI backfill, throughput, billing, deletion, limits, endpoints, and restart state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-gsi-lifecycle-"));
  const clock = new TestClock(Date.parse("2026-07-14T13:00:00Z"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"});
  let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator);
    const limits = await client.send(new DescribeLimitsCommand({}));
    for (const value of [limits.AccountMaxReadCapacityUnits, limits.AccountMaxWriteCapacityUnits, limits.TableMaxReadCapacityUnits, limits.TableMaxWriteCapacityUnits]) {
      assert.ok(Number.isInteger(value) && value! > 0);
    }
    assert.ok(limits.AccountMaxReadCapacityUnits! >= limits.TableMaxReadCapacityUnits!);
    assert.ok(limits.AccountMaxWriteCapacityUnits! >= limits.TableMaxWriteCapacityUnits!);
    const endpoint = (await client.send(new DescribeEndpointsCommand({}))).Endpoints?.[0];
    assert.ok(endpoint?.Address); assert.ok(Number.isInteger(endpoint?.CachePeriodInMinutes) && (endpoint?.CachePeriodInMinutes ?? 0) > 0);

    await client.send(new CreateTableCommand({
      TableName: "LifecycleTable", BillingMode: "PROVISIONED", ProvisionedThroughput: { ReadCapacityUnits: 4, WriteCapacityUnits: 5 },
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    }));
    await lifecycleTick(simulator, clock);
    await client.send(new PutItemCommand({ TableName: "LifecycleTable", Item: { id: { S: "a" }, owner: { S: "team" }, revision: { N: "2" }, payload: { S: "full-a" } } }));
    await client.send(new PutItemCommand({ TableName: "LifecycleTable", Item: { id: { S: "b" }, owner: { S: "team" }, revision: { N: "1" }, payload: { S: "full-b" } } }));
    await client.send(new PutItemCommand({ TableName: "LifecycleTable", Item: { id: { S: "c" }, payload: { S: "sparse" } } }));

    const creating = await client.send(new UpdateTableCommand({
      TableName: "LifecycleTable",
      AttributeDefinitions: [{ AttributeName: "owner", AttributeType: "S" }, { AttributeName: "revision", AttributeType: "N" }],
      GlobalSecondaryIndexUpdates: [{ Create: {
        IndexName: "ByOwner", KeySchema: [{ AttributeName: "owner", KeyType: "HASH" }, { AttributeName: "revision", KeyType: "RANGE" }],
        Projection: { ProjectionType: "ALL" }, ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 3 },
      } }],
    }));
    assert.equal(creating.TableDescription?.TableStatus, "UPDATING");
    assert.equal(creating.TableDescription?.GlobalSecondaryIndexes?.[0].IndexStatus, "CREATING");
    assert.equal(creating.TableDescription?.GlobalSecondaryIndexes?.[0].Backfilling, true);
    await lifecycleTick(simulator, clock);
    let described = (await client.send(new DescribeTableCommand({ TableName: "LifecycleTable" }))).Table!;
    let byOwner = described.GlobalSecondaryIndexes?.find(index => index.IndexName === "ByOwner")!;
    assert.equal(described.TableStatus, "ACTIVE"); assert.equal(byOwner.IndexStatus, "ACTIVE"); assert.equal(byOwner.Backfilling, false);
    assert.equal(byOwner.ItemCount, 2); assert.ok((byOwner.IndexSizeBytes ?? 0) > 0); assert.match(byOwner.IndexArn ?? "", /\/index\/ByOwner$/);
    const backfilled = await client.send(new QueryCommand({
      TableName: "LifecycleTable", IndexName: "ByOwner", KeyConditionExpression: "#owner = :owner",
      ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: { ":owner": { S: "team" } },
    }));
    assert.deepEqual(backfilled.Items?.map(item => [item.id.S, item.revision.N, item.payload.S]), [["b", "1", "full-b"], ["a", "2", "full-a"]]);

    client.destroy(); await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); client = clientFor(simulator);
    described = (await client.send(new DescribeTableCommand({ TableName: "LifecycleTable" }))).Table!;
    byOwner = described.GlobalSecondaryIndexes?.find(index => index.IndexName === "ByOwner")!;
    assert.equal(byOwner.IndexStatus, "ACTIVE"); assert.equal(byOwner.ItemCount, 2);
    assert.deepEqual((await client.send(new QueryCommand({
      TableName: "LifecycleTable", IndexName: "ByOwner", KeyConditionExpression: "#owner = :owner",
      ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: { ":owner": { S: "team" } },
    }))).Items, backfilled.Items);

    const tableThroughput = await client.send(new UpdateTableCommand({ TableName: "LifecycleTable", ProvisionedThroughput: { ReadCapacityUnits: 11, WriteCapacityUnits: 12 } }));
    assert.equal(tableThroughput.TableDescription?.TableStatus, "UPDATING"); await lifecycleTick(simulator, clock);
    described = (await client.send(new DescribeTableCommand({ TableName: "LifecycleTable" }))).Table!;
    assert.deepEqual([described.ProvisionedThroughput?.ReadCapacityUnits, described.ProvisionedThroughput?.WriteCapacityUnits], [11, 12]);

    const updating = await client.send(new UpdateTableCommand({
      TableName: "LifecycleTable", GlobalSecondaryIndexUpdates: [{ Update: { IndexName: "ByOwner", ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 8 } } }],
    }));
    assert.equal(updating.TableDescription?.TableStatus, "UPDATING");
    assert.equal(updating.TableDescription?.GlobalSecondaryIndexes?.[0].IndexStatus, "UPDATING");
    await lifecycleTick(simulator, clock);
    byOwner = (await client.send(new DescribeTableCommand({ TableName: "LifecycleTable" }))).Table?.GlobalSecondaryIndexes?.[0]!;
    assert.equal(byOwner.IndexStatus, "ACTIVE");
    assert.deepEqual([byOwner.ProvisionedThroughput?.ReadCapacityUnits, byOwner.ProvisionedThroughput?.WriteCapacityUnits], [7, 8]);
    await validation(client.send(new UpdateTableCommand({
      TableName: "LifecycleTable", GlobalSecondaryIndexUpdates: [
        { Update: { IndexName: "ByOwner", ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 } } },
        { Update: { IndexName: "ByOwner", ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 6 } } },
      ],
    })));

    const billing = await client.send(new UpdateTableCommand({ TableName: "LifecycleTable", BillingMode: "PAY_PER_REQUEST" }));
    assert.equal(billing.TableDescription?.TableStatus, "UPDATING"); await lifecycleTick(simulator, clock);
    assert.equal((await client.send(new DescribeTableCommand({ TableName: "LifecycleTable" }))).Table?.BillingModeSummary?.BillingMode, "PAY_PER_REQUEST");

    const deleting = await client.send(new UpdateTableCommand({ TableName: "LifecycleTable", GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: "ByOwner" } }] }));
    assert.equal(deleting.TableDescription?.TableStatus, "UPDATING");
    assert.equal(deleting.TableDescription?.GlobalSecondaryIndexes?.[0].IndexStatus, "DELETING");
    await lifecycleTick(simulator, clock);
    assert.equal((await client.send(new DescribeTableCommand({ TableName: "LifecycleTable" }))).Table?.GlobalSecondaryIndexes?.length ?? 0, 0);
    await validation(client.send(new QueryCommand({
      TableName: "LifecycleTable", IndexName: "ByOwner", KeyConditionExpression: "#owner = :owner",
      ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: { ":owner": { S: "team" } },
    })));
  } finally {
    client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("secondary-index definitions reject invalid LSI keys, projection overflow and duplicates, and duplicate index schemas", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-index-validation-"));
  const clock = new TestClock(Date.parse("2026-07-14T14:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"});
  let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator);
    await validation(client.send(new CreateTableCommand({
      TableName: "BadLsiPartition", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "N" }, { AttributeName: "other", AttributeType: "S" }, { AttributeName: "alternate", AttributeType: "N" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      LocalSecondaryIndexes: [{ IndexName: "WrongPartition", KeySchema: [{ AttributeName: "other", KeyType: "HASH" }, { AttributeName: "alternate", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }],
    })));
    await validation(client.send(new CreateTableCommand({
      TableName: "TooManyProjected", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "gpk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [{ IndexName: "OversizedInclude", KeySchema: [{ AttributeName: "gpk", KeyType: "HASH" }], Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: Array.from({ length: 21 }, (_, index) => `projected${index}`) } }],
    })));
    await validation(client.send(new CreateTableCommand({
      TableName: "DuplicateProjection", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "gpk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [{ IndexName: "DuplicateInclude", KeySchema: [{ AttributeName: "gpk", KeyType: "HASH" }], Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["note", "note"] } }],
    })));
    const aggregateIndexes = Array.from({ length: 6 }, (_, index) => ({
      IndexName: `Aggregate${index}`,
      KeySchema: [{ AttributeName: `gpk${index}`, KeyType: "HASH" as const }],
      Projection: { ProjectionType: "INCLUDE" as const, NonKeyAttributes: Array.from({ length: 17 }, (_, projected) => `field${projected}`) },
    }));
    await validation(client.send(new CreateTableCommand({
      TableName: "AggregateProjection", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, ...Array.from({ length: 6 }, (_, index) => ({ AttributeName: `gpk${index}`, AttributeType: "S" as const }))],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }], GlobalSecondaryIndexes: aggregateIndexes,
    })));
    await validation(client.send(new CreateTableCommand({
      TableName: "DuplicateIndexKey", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "gpk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [{ IndexName: "BadKeySchema", KeySchema: [{ AttributeName: "gpk", KeyType: "HASH" }, { AttributeName: "gpk", KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" } }],
    })));
    await validation(client.send(new CreateTableCommand({
      TableName: "DuplicateIndexName", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "first", AttributeType: "S" }, { AttributeName: "second", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        { IndexName: "SameName", KeySchema: [{ AttributeName: "first", KeyType: "HASH" }], Projection: { ProjectionType: "KEYS_ONLY" } },
        { IndexName: "SameName", KeySchema: [{ AttributeName: "second", KeyType: "HASH" }], Projection: { ProjectionType: "KEYS_ONLY" } },
      ],
    })));
  } finally {
    client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("raw AWS JSON protocol supports index creation, UpdateTable, and index queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-index-protocol-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off"});
  const call = async (operation: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${simulator.port}`, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": `DynamoDB_20120810.${operation}` }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json() as Promise<any>;
  };
  try {
    await simulator.start();
    await call("CreateTable", { TableName: "RawIndexes", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] });
    await new Promise(resolve => setTimeout(resolve, 75));
    await call("PutItem", { TableName: "RawIndexes", Item: { id: { S: "one" }, owner: { S: "team" } } });
    const updating = await call("UpdateTable", { TableName: "RawIndexes", AttributeDefinitions: [{ AttributeName: "owner", AttributeType: "S" }], GlobalSecondaryIndexUpdates: [{ Create: { IndexName: "ByOwner", KeySchema: [{ AttributeName: "owner", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } } }] });
    assert.equal(updating.TableDescription.TableStatus, "UPDATING");
    await new Promise(resolve => setTimeout(resolve, 75));
    const queried = await call("Query", { TableName: "RawIndexes", IndexName: "ByOwner", KeyConditionExpression: "#owner = :owner", ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: { ":owner": { S: "team" } } });
    assert.equal(queried.Count, 1); assert.equal(queried.Items[0].id.S, "one");
  } finally { await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
