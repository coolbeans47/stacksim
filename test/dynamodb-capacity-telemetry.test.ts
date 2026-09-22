import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand, PutItemCommand, GetItemCommand, QueryCommand, ScanCommand, BatchGetItemCommand, BatchWriteItemCommand, TransactGetItemsCommand, TransactWriteItemsCommand, ExecuteStatementCommand, BatchExecuteStatementCommand, ExecuteTransactionCommand } from "@aws-sdk/client-dynamodb";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import type { TelemetryEvent } from "../src/core/telemetry.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
test("DynamoDB SDK capacity, canonical charges and CloudWatch agree across native and PartiQL execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-capacity-metrics-")); const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", dynamoEnforceCapacity: true });
  let db: DynamoDBClient | undefined; let cw: CloudWatchClient | undefined; const events: TelemetryEvent[] = []; let unsubscribe: (() => void) | undefined;
  try {
    await sim.start(); const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    db = new DynamoDBClient(config); cw = new CloudWatchClient(config);
    const bus = (sim as any).services(region).telemetry; unsubscribe = bus.subscribe((event: TelemetryEvent) => { if (event.namespace === "AWS/DynamoDB") events.push(event); });
    for (const name of ["capacity-one", "capacity-two"]) {
      await db.send(new CreateTableCommand({ TableName: name, BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }], AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }, { AttributeName: "g", AttributeType: "S" }, { AttributeName: "l", AttributeType: "S" }], GlobalSecondaryIndexes: [{ IndexName: "global-index", KeySchema: [{ AttributeName: "g", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }], LocalSecondaryIndexes: [{ IndexName: "local-index", KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "l", KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" } }] }));
      for (let i = 0; i < 100; i++) { if ((await db.send(new DescribeTableCommand({ TableName: name }))).Table?.TableStatus === "ACTIVE") break; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    const item = (sk: string) => ({ pk: { S: "partition" }, sk: { S: sk }, g: { S: "group" }, l: { S: sk }, payload: { S: "x".repeat(10000) } });
    const key = (sk: string) => ({ pk: { S: "partition" }, sk: { S: sk } });
    const scopes = (samples: TelemetryEvent[]) => {
      const result: Record<string, number> = {};
      for (const sample of samples.filter(event => event.metricName.startsWith("Consumed"))) { const name = `${sample.dimensions.TableName}/${sample.dimensions.GlobalSecondaryIndexName ?? "table"}/${sample.metricName}`; result[name] = (result[name] ?? 0) + sample.value; }
      return result;
    };
    async function check(command: any, operation: string): Promise<any> {
      const before = events.length; const result: any = await db!.send(command); const samples = events.slice(before);
      assert.equal(samples.filter(event => event.metricName === "SuccessfulRequestLatency").length, 1, "nested operations publish only the outer request latency");
      assert.equal(samples.find(event => event.metricName === "SuccessfulRequestLatency")!.dimensions.Operation, operation);
      const expected: Record<string, number> = {};
      for (const capacity of Array.isArray(result.ConsumedCapacity) ? result.ConsumedCapacity : [result.ConsumedCapacity]) {
        if (!capacity) continue;
        const buckets = [{ name: "table", ReadCapacityUnits: (capacity.Table?.ReadCapacityUnits ?? capacity.ReadCapacityUnits) + Object.values<any>(capacity.LocalSecondaryIndexes ?? {}).reduce((sum, index) => sum + index.ReadCapacityUnits, 0), WriteCapacityUnits: (capacity.Table?.WriteCapacityUnits ?? capacity.WriteCapacityUnits) + Object.values<any>(capacity.LocalSecondaryIndexes ?? {}).reduce((sum, index) => sum + index.WriteCapacityUnits, 0) }, ...Object.entries<any>(capacity.GlobalSecondaryIndexes ?? {}).map(([name, bucket]) => ({ name, ...bucket }))];
        for (const bucket of buckets) for (const kind of ["Read", "Write"]) { const value = bucket[`${kind}CapacityUnits`]; if (value) { const name = `${capacity.TableName}/${bucket.name}/Consumed${kind}CapacityUnits`; expected[name] = (expected[name] ?? 0) + value; } }
      }
      assert.deepEqual(scopes(samples), expected, operation); return result;
    }
    for (const TableName of ["capacity-one", "capacity-two"]) for (const sk of ["1", "2"]) await check(new PutItemCommand({ TableName, Item: item(sk), ReturnConsumedCapacity: "INDEXES" }), "PutItem");
    const TableName = "capacity-one";
    const eventual = await check(new GetItemCommand({ TableName, Key: key("1"), ReturnConsumedCapacity: "INDEXES" }), "GetItem");
    const strong = await check(new GetItemCommand({ TableName, Key: key("1"), ConsistentRead: true, ReturnConsumedCapacity: "INDEXES" }), "GetItem");
    assert.equal(eventual.ConsumedCapacity.ReadCapacityUnits, 1.5); assert.equal(strong.ConsumedCapacity.ReadCapacityUnits, 3);
    for (const ReturnConsumedCapacity of [undefined, "NONE"] as const) { const before = events.length; const output: any = await db.send(new GetItemCommand({ TableName, Key: key("1"), ReturnConsumedCapacity })); assert.equal(output.ConsumedCapacity, undefined); assert.equal(events.slice(before).find(event => event.metricName === "ConsumedReadCapacityUnits")!.value, 1.5); }
    const query = { TableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": { S: "partition" }, ":missing": { S: "missing" } }, FilterExpression: "sk = :missing", ReturnConsumedCapacity: "INDEXES" as const };
    const filtered = await check(new QueryCommand(query), "Query"); assert.equal(filtered.Count, 0); assert.equal(filtered.ScannedCount, 2); assert.equal(filtered.ConsumedCapacity.ReadCapacityUnits, 3);
    await check(new ScanCommand({ TableName, FilterExpression: "sk = :missing", ExpressionAttributeValues: { ":missing": { S: "missing" } }, ReturnConsumedCapacity: "INDEXES" }), "Scan");
    await check(new QueryCommand({ TableName, IndexName: "global-index", KeyConditionExpression: "g = :g", ExpressionAttributeValues: { ":g": { S: "group" } }, ReturnConsumedCapacity: "INDEXES" }), "Query");
    await check(new QueryCommand({ TableName, IndexName: "local-index", KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": { S: "partition" } }, Select: "ALL_ATTRIBUTES", ConsistentRead: true, ReturnConsumedCapacity: "INDEXES" }), "Query");
    await check(new BatchGetItemCommand({ RequestItems: { [TableName]: { Keys: [key("1"), key("2")] }, "capacity-two": { Keys: [key("1")], ConsistentRead: true } }, ReturnConsumedCapacity: "INDEXES" }), "BatchGetItem");
    await check(new BatchWriteItemCommand({ RequestItems: { [TableName]: [{ PutRequest: { Item: item("3") } }], "capacity-two": [{ DeleteRequest: { Key: key("2") } }] }, ReturnConsumedCapacity: "INDEXES" }), "BatchWriteItem");
    await check(new TransactGetItemsCommand({ TransactItems: [{ Get: { TableName, Key: key("1") } }, { Get: { TableName: "capacity-two", Key: key("1") } }], ReturnConsumedCapacity: "INDEXES" }), "TransactGetItems");
    const transaction = new TransactWriteItemsCommand({ ClientRequestToken: "capacity-replay", TransactItems: [{ Put: { TableName, Item: item("4") } }, { Delete: { TableName: "capacity-two", Key: key("1") } }], ReturnConsumedCapacity: "INDEXES" });
    await check(transaction, "TransactWriteItems"); const replayStart = events.length; await db.send(transaction); assert.deepEqual(scopes(events.slice(replayStart)), {}, "idempotent response replay does not execute another charge");
    await check(new ExecuteStatementCommand({ Statement: 'SELECT * FROM "capacity-one" WHERE pk = ? AND sk = ?', Parameters: [{ S: "partition" }, { S: "1" }], ReturnConsumedCapacity: "INDEXES" }), "ExecuteStatement");
    await check(new BatchExecuteStatementCommand({ Statements: ["1", "2"].map(sk => ({ Statement: 'SELECT * FROM "capacity-one" WHERE pk = ? AND sk = ?', Parameters: [{ S: "partition" }, { S: sk }] })), ReturnConsumedCapacity: "INDEXES" }), "BatchExecuteStatement");
    await check(new ExecuteTransactionCommand({ TransactStatements: [{ Statement: 'SELECT * FROM "capacity-one" WHERE pk = ? AND sk = ?', Parameters: [{ S: "partition" }, { S: "1" }] }], ReturnConsumedCapacity: "INDEXES" }), "ExecuteTransaction");
    await check(new BatchExecuteStatementCommand({ Statements: [{ Statement: 'UPDATE "capacity-one" SET payload = ? WHERE pk = ? AND sk = ?', Parameters: [{ S: "y".repeat(12000) }, { S: "partition" }, { S: "1" }] }, { Statement: 'UPDATE "table-does-not-exist" SET payload = ? WHERE pk = ? AND sk = ?', Parameters: [{ S: "fail" }, { S: "partition" }, { S: "1" }] }], ReturnConsumedCapacity: "INDEXES" }), "BatchExecuteStatement");
    await check(new ExecuteTransactionCommand({ TransactStatements: [{ Statement: 'UPDATE "capacity-one" SET payload = ? WHERE pk = ? AND sk = ?', Parameters: [{ S: "z".repeat(10000) }, { S: "partition" }, { S: "2" }] }], ReturnConsumedCapacity: "INDEXES" }), "ExecuteTransaction");
    const concurrentStart = events.length;
    await Promise.all(["2", "3"].map(sk => db!.send(new GetItemCommand({ TableName, Key: key(sk) }))));
    assert.equal(events.slice(concurrentStart).filter(event => event.metricName === "SuccessfulRequestLatency").length, 2);
    assert.equal(events.slice(concurrentStart).filter(event => event.metricName === "ConsumedReadCapacityUnits").reduce((sum, event) => sum + event.value, 0), 3, "concurrent request accounting is isolated");
    const total = events.filter(event => event.metricName === "ConsumedReadCapacityUnits" && event.dimensions.TableName === TableName && !event.dimensions.GlobalSecondaryIndexName).reduce((sum, event) => sum + event.value, 0);
    const statistics = await cw.send(new GetMetricStatisticsCommand({ Namespace: "AWS/DynamoDB", MetricName: "ConsumedReadCapacityUnits", Dimensions: [{ Name: "TableName", Value: TableName }], StartTime: new Date(Date.now() - 300000), EndTime: new Date(Date.now() + 60000), Period: 60, Statistics: ["Sum"] }));
    assert.equal(statistics.Datapoints!.reduce((sum, point) => sum + point.Sum!, 0), total);
    await db.send(new CreateTableCommand({ TableName: "capacity-limited", BillingMode: "PROVISIONED", ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 }, KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }], AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }] }));
    for (let i = 0; i < 100; i++) { if ((await db.send(new DescribeTableCommand({ TableName: "capacity-limited" }))).Table?.TableStatus === "ACTIVE") break; await new Promise(resolve => setTimeout(resolve, 10)); }
    const rejectedStart = events.length;
    await assert.rejects(db.send(new PutItemCommand({ TableName: "capacity-limited", Item: item("too-large") })), { name: "ProvisionedThroughputExceededException" });
    assert.deepEqual(scopes(events.slice(rejectedStart)), {}, "rejected capacity admission emits no consumed units");
    assert.equal(events.slice(rejectedStart).filter(event => event.metricName === "SuccessfulRequestLatency").length, 0);
    const fail = bus.subscribe(() => { throw new Error("telemetry unavailable"); });
    try { await db.send(new PutItemCommand({ TableName, Item: item("committed") })); assert.ok((await db.send(new GetItemCommand({ TableName, Key: key("committed") }))).Item); } finally { fail(); }
  } finally { unsubscribe?.(); db?.destroy(); cw?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
