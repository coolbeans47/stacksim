import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateTableCommand,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function fixture(name: string): Promise<{ client: DynamoDBClient; activate: () => Promise<void>; close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `stacksim-${name}-`));
  const clock = new TestClock(Date.parse("2026-08-10T12:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"});
  await simulator.start();
  const client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
  return { client, activate: async () => { clock.advance(50); await new Promise<void>(resolve => setImmediate(resolve)); }, close: async () => { client.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true }); } };
}

function validation(promise: Promise<unknown>): Promise<void> {
  return assert.rejects(promise, (error: any) => error.name === "ValidationException");
}

test("Query and Scan stop at one MiB before filtering and resume from the last evaluated item", async () => {
  const { client, activate, close } = await fixture("ddb-byte-pages");
  try {
    await client.send(new CreateTableCommand({ TableName: "BytePages", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "N" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }] }));
    await activate();
    const payload = "x".repeat(330_000);
    for (let sk = 1; sk <= 4; sk++) await client.send(new PutItemCommand({ TableName: "BytePages", Item: { pk: { S: "page" }, sk: { N: String(sk) }, visible: { BOOL: sk % 2 === 0 }, payload: { S: payload } } }));

    const query = await client.send(new QueryCommand({ TableName: "BytePages", KeyConditionExpression: "pk = :pk", FilterExpression: "visible = :yes", ExpressionAttributeValues: { ":pk": { S: "page" }, ":yes": { BOOL: true } } }));
    assert.equal(query.ScannedCount, 3); assert.equal(query.Count, 1); assert.deepEqual(query.Items?.map(item => item.sk.N), ["2"]); assert.deepEqual(query.LastEvaluatedKey, { pk: { S: "page" }, sk: { N: "3" } });
    const queryTail = await client.send(new QueryCommand({ TableName: "BytePages", KeyConditionExpression: "pk = :pk", FilterExpression: "visible = :yes", ExpressionAttributeValues: { ":pk": { S: "page" }, ":yes": { BOOL: true } }, ExclusiveStartKey: query.LastEvaluatedKey }));
    assert.equal(queryTail.ScannedCount, 1); assert.equal(queryTail.Count, 1); assert.deepEqual(queryTail.Items?.map(item => item.sk.N), ["4"]); assert.equal(queryTail.LastEvaluatedKey, undefined);

    const scan = await client.send(new ScanCommand({ TableName: "BytePages", FilterExpression: "visible = :yes", ExpressionAttributeValues: { ":yes": { BOOL: true } } }));
    assert.equal(scan.ScannedCount, 3); assert.equal(scan.Count, 1); assert.deepEqual(scan.LastEvaluatedKey, { pk: { S: "page" }, sk: { N: "3" } });
    const scanTail = await client.send(new ScanCommand({ TableName: "BytePages", FilterExpression: "visible = :yes", ExpressionAttributeValues: { ":yes": { BOOL: true } }, ExclusiveStartKey: scan.LastEvaluatedKey }));
    assert.equal(scanTail.ScannedCount, 1); assert.equal(scanTail.Count, 1); assert.equal(scanTail.LastEvaluatedKey, undefined);
  } finally { await close(); }
});

test("ExclusiveStartKey resumes canonically after reordered numeric keys and deleted boundaries", async () => {
  const { client, activate, close } = await fixture("ddb-canonical-start-key");
  try {
    await client.send(new CreateTableCommand({ TableName: "CanonicalPages", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "N" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }] }));
    await activate();
    for (const sk of ["1", "2", "3"]) await client.send(new PutItemCommand({ TableName: "CanonicalPages", Item: { pk: { S: "p" }, sk: { N: sk } } }));
    const common = { TableName: "CanonicalPages", KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": { S: "p" } } };
    const equivalent = await client.send(new QueryCommand({ ...common, ExclusiveStartKey: { sk: { N: "1.0" }, pk: { S: "p" } } }));
    assert.deepEqual(equivalent.Items?.map(item => item.sk.N), ["2", "3"]);
    await client.send(new DeleteItemCommand({ TableName: "CanonicalPages", Key: { pk: { S: "p" }, sk: { N: "2" } } }));
    const afterDeleted = await client.send(new QueryCommand({ ...common, ExclusiveStartKey: { sk: { N: "2e0" }, pk: { S: "p" } } }));
    assert.deepEqual(afterDeleted.Items?.map(item => item.sk.N), ["3"]);
    const descending = await client.send(new QueryCommand({ ...common, ScanIndexForward: false, ExclusiveStartKey: { sk: { N: "2.00" }, pk: { S: "p" } } }));
    assert.deepEqual(descending.Items?.map(item => item.sk.N), ["1"]);
  } finally { await close(); }
});

test("parallel Scan validates its envelope and partitions keys stably without overlap", async () => {
  const { client, activate, close } = await fixture("ddb-segments");
  try {
    await client.send(new CreateTableCommand({ TableName: "SegmentedItems", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
    await activate();
    const expected = Array.from({ length: 60 }, (_, index) => `item-${String(index).padStart(3, "0")}`);
    for (const id of expected) await client.send(new PutItemCommand({ TableName: "SegmentedItems", Item: { id: { S: id }, value: { N: id.slice(-3) } } }));

    await validation(client.send(new ScanCommand({ TableName: "SegmentedItems", Segment: 0 })));
    await validation(client.send(new ScanCommand({ TableName: "SegmentedItems", TotalSegments: 2 })));
    await validation(client.send(new ScanCommand({ TableName: "SegmentedItems", Segment: 2, TotalSegments: 2 })));
    await validation(client.send(new ScanCommand({ TableName: "SegmentedItems", Segment: 0, TotalSegments: 0 })));

    const segments: string[][] = [];
    for (let segment = 0; segment < 4; segment++) {
      const ids: string[] = []; let ExclusiveStartKey: Record<string, any> | undefined;
      do {
        const page = await client.send(new ScanCommand({ TableName: "SegmentedItems", Segment: segment, TotalSegments: 4, Limit: 3, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) }));
        ids.push(...(page.Items ?? []).map(item => item.id.S!)); ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      const repeated = await client.send(new ScanCommand({ TableName: "SegmentedItems", Segment: segment, TotalSegments: 4 }));
      assert.deepEqual(ids, repeated.Items?.map(item => item.id.S)); segments.push(ids);
    }
    assert.deepEqual([...segments.flat()].sort(), expected);
    assert.equal(new Set(segments.flat()).size, expected.length);

    await client.send(new CreateTableCommand({ TableName: "CompositeSegments", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "N" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }] }));
    await activate();
    for (const pk of ["a", "b", "c", "d", "e", "f"]) for (let sk = 0; sk < 5; sk++) await client.send(new PutItemCommand({ TableName: "CompositeSegments", Item: { pk: { S: pk }, sk: { N: String(sk) } } }));
    const owners = new Map<string, number>();
    for (let segment = 0; segment < 4; segment++) {
      const page = await client.send(new ScanCommand({ TableName: "CompositeSegments", Segment: segment, TotalSegments: 4 }));
      for (const item of page.Items ?? []) { const pk = item.pk.S!; assert.equal(owners.get(pk) ?? segment, segment, `partition ${pk} was split across parallel Scan segments`); owners.set(pk, segment); }
    }
    assert.equal(owners.size, 6);
  } finally { await close(); }
});

test("LSI projections may fetch base-table attributes while GSI projections remain restricted", async () => {
  const { client, activate, close } = await fixture("ddb-index-projections");
  try {
    await client.send(new CreateTableCommand({
      TableName: "ProjectionReads", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "N" }, { AttributeName: "lsiSk", AttributeType: "N" }, { AttributeName: "gsiPk", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      LocalSecondaryIndexes: [{ IndexName: "ByLocal", KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "lsiSk", KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" } }],
      GlobalSecondaryIndexes: [{ IndexName: "ByGlobal", KeySchema: [{ AttributeName: "gsiPk", KeyType: "HASH" }], Projection: { ProjectionType: "KEYS_ONLY" } }],
    }));
    await activate();
    await client.send(new PutItemCommand({ TableName: "ProjectionReads", Item: { pk: { S: "p" }, sk: { N: "1" }, lsiSk: { N: "9" }, gsiPk: { S: "g" }, secret: { S: "from-table" } } }));

    const projected = await client.send(new QueryCommand({ TableName: "ProjectionReads", IndexName: "ByLocal", KeyConditionExpression: "pk = :pk", ProjectionExpression: "secret", ExpressionAttributeValues: { ":pk": { S: "p" } } }));
    assert.deepEqual(projected.Items, [{ secret: { S: "from-table" } }]);
    const all = await client.send(new QueryCommand({ TableName: "ProjectionReads", IndexName: "ByLocal", KeyConditionExpression: "pk = :pk", Select: "ALL_ATTRIBUTES", ExpressionAttributeValues: { ":pk": { S: "p" } } }));
    assert.equal(all.Items?.[0].secret?.S, "from-table");
    const filteredLocal = await client.send(new QueryCommand({ TableName: "ProjectionReads", IndexName: "ByLocal", KeyConditionExpression: "pk = :pk", FilterExpression: "secret = :secret", ExpressionAttributeValues: { ":pk": { S: "p" }, ":secret": { S: "from-table" } } }));
    assert.equal(filteredLocal.Count, 1); assert.equal(filteredLocal.Items?.[0].secret, undefined, "filter-only base attributes are not added to the default projected response");
    await validation(client.send(new QueryCommand({ TableName: "ProjectionReads", IndexName: "ByGlobal", KeyConditionExpression: "gsiPk = :pk", ProjectionExpression: "secret", ExpressionAttributeValues: { ":pk": { S: "g" } } })));
    await validation(client.send(new QueryCommand({ TableName: "ProjectionReads", IndexName: "ByGlobal", KeyConditionExpression: "gsiPk = :pk", FilterExpression: "secret = :secret", ExpressionAttributeValues: { ":pk": { S: "g" }, ":secret": { S: "from-table" } } })));
  } finally { await close(); }
});
