import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { StackSim } from "../src/server.js";

// Review rows API-19..31 (2026-10-22) fixed on 2026-10-23; the remaining rows are recorded as local differences.
test("DynamoDB low-severity API drift rows match AWS on the wire", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-api-drift-")); const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off" });
  try {
    await sim.start();
    const call = async (target: string, body: unknown, prefix = "DynamoDB_20120810", raw?: string) => {
      const response = await fetch(`http://127.0.0.1:${sim.port}/`, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": `${prefix}.${target}`, authorization: "AWS4-HMAC-SHA256 Credential=admin/20261023/eu-west-1/dynamodb/aws4_request, SignedHeaders=host, Signature=0" }, body: raw ?? JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text), crc: response.headers.get("x-amz-crc32") };
    };
    const created = await call("CreateTable", { TableName: "Drift", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }], StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_IMAGE" } });
    assert.match(created.body.TableDescription.TableId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "API-30 TableId is a UUID");
    assert.equal(created.crc, String(crc32(Buffer.from(created.text))), "API-30 x-amz-crc32 covers the response body");
    for (let attempt = 0; attempt < 200 && (await call("DescribeTable", { TableName: "Drift" })).body.Table.TableStatus !== "ACTIVE"; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    const streamArn = (await call("DescribeTable", { TableName: "Drift" })).body.Table.LatestStreamArn;
    const shard = (await call("DescribeStream", { StreamArn: streamArn }, "DynamoDBStreams_20120810")).body.StreamDescription.Shards[0].ShardId;
    const iterator = (await call("GetShardIterator", { StreamArn: streamArn, ShardId: shard, ShardIteratorType: "TRIM_HORIZON" }, "DynamoDBStreams_20120810")).body.ShardIterator;

    const expectError = async (response: Promise<{ status: number; body: any }>, type: string, message: RegExp, row: string) => { const result = await response; assert.equal(result.status, 400, row); assert.equal(result.body.__type, type, row); assert.match(result.body.message, message, row); };
    await expectError(call("GetRecords", { ShardIterator: iterator, Limit: 5000 }, "DynamoDBStreams_20120810"), "com.amazon.coral.validate#ValidationException", /at 'limit' failed to satisfy constraint: Member must have value less than or equal to 1000/, "API-19");
    await expectError(call("ListTables", {}, "Foo_20120810"), "com.amazon.coral.service#UnknownOperationException", /Unknown operation/, "API-20");
    await expectError(call("CreateTable", { TableName: "DriftOrder", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }], KeySchema: [{ AttributeName: "sk", KeyType: "RANGE" }, { AttributeName: "pk", KeyType: "HASH" }] }), "com.amazon.coral.validate#ValidationException", /The first KeySchemaElement is not a HASH key type/, "API-21 order");
    await expectError(call("CreateTable", { TableName: "DriftUnused", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "extra", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }] }), "com.amazon.coral.validate#ValidationException", /Some AttributeDefinitions are not used in the KeySchema or LocalSecondaryIndexes/, "API-21 unused");
    await expectError(call("PutItem", { TableName: "Drift", Item: { pk: { N: "1" }, sk: { S: "a" } } }), "com.amazon.coral.validate#ValidationException", /Type mismatch for key pk expected: S actual: N/, "API-21 mismatch");
    await expectError(call("PutItem", { TableName: "Drift", Item: { pk: { S: "b" }, sk: { S: "b" }, bin: { B: "!!!not-base64" } } }), "com.amazon.coral.service#SerializationException", /Base64/, "API-22 base64");
    assert.equal((await call("PutItem", { TableName: "Drift", Item: { pk: { S: "n" }, sk: { S: "n" }, big: { N: `1${"0".repeat(41)}` } } })).status, 200, "API-22 1E41 has one significant digit");
    await call("PutItem", { TableName: "Drift", Item: { pk: { S: "u" }, sk: { S: "u" }, list: { L: [{ S: "a" }] } } });
    const appended = await call("UpdateItem", { TableName: "Drift", Key: { pk: { S: "u" }, sk: { S: "u" } }, UpdateExpression: "SET #l[5] = :v", ExpressionAttributeNames: { "#l": "list" }, ExpressionAttributeValues: { ":v": { S: "z" } }, ReturnValues: "ALL_NEW" });
    assert.deepEqual(appended.body.Attributes.list, { L: [{ S: "a" }, { S: "z" }] }, "API-23 SET past the end appends");
    await expectError(call("UpdateItem", { TableName: "Drift", Key: { pk: { S: "u" }, sk: { S: "u" } }, UpdateExpression: "SET a = a + :v", ExpressionAttributeValues: { ":v": { N: "1" } } }), "com.amazon.coral.validate#ValidationException", /refers to an attribute that does not exist in the item/, "API-23 missing operand");
    await expectError(call("UpdateItem", { TableName: "Drift", Key: { pk: { S: "u" }, sk: { S: "u" } }, UpdateExpression: "SET pk = :same", ExpressionAttributeValues: { ":same": { S: "u" } } }), "com.amazon.coral.validate#ValidationException", /Cannot update attribute pk\. This attribute is part of the key/, "API-23 key attribute");
    assert.deepEqual((await call("ListTables", { ExclusiveStartTableName: "Zzz" })).body.TableNames, [], "API-25 unknown start name continues after it");
    assert.deepEqual((await call("ListTables", { ExclusiveStartTableName: "A" })).body.TableNames, ["Drift"]);
    await expectError(call("ListTagsOfResource", { ResourceArn: "not-an-arn" }), "com.amazon.coral.validate#ValidationException", /Invalid TableArn/, "API-26");
    const malformed = await fetch(`http://127.0.0.1:${sim.port}/`, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "DynamoDB_20120810.ListTables", authorization: "AWS4-HMAC-SHA256 Credential=admin/20261023/eu-west-1/dynamodb/aws4_request, SignedHeaders=host, Signature=0" }, body: "{" });
    assert.equal((await malformed.json()).__type, "com.amazon.coral.service#SerializationException", "API-29");
    await expectError(call("Scan", { TableName: "Drift", ExclusiveStartKey: { wrong: { S: "x" } } }), "com.amazon.coral.validate#ValidationException", /^The provided starting key is invalid/, "API-31 start key");
    await expectError(call("DescribeTable", { TableName: "Missing" }), "com.amazonaws.dynamodb.v20120810#ResourceNotFoundException", /not found/, "service errors keep the DynamoDB namespace");
  } finally { await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
