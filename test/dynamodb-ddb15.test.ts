import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BatchGetItemCommand,
  BatchWriteItemCommand,
  CreateTableCommand,
  DeleteItemCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListBackupsCommand,
  ListTagsOfResourceCommand,
  TagResourceCommand,
  UpdateContinuousBackupsCommand,
  ExecuteStatementCommand,
  GetItemCommand,
  ListTablesCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import { DescribeStreamCommand, DynamoDBStreamsClient, GetRecordsCommand } from "@aws-sdk/client-dynamodb-streams";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";

async function settle(): Promise<void> { await new Promise(resolve => setImmediate(resolve)); }

async function raw(endpoint: string, target: string, body: string): Promise<{ status: number; type: string | null; body: any }> {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": target }, body });
  const text = await response.text();
  return { status: response.status, type: response.headers.get("content-type"), body: text ? JSON.parse(text) : undefined };
}

function rejects(promise: Promise<unknown>, name: string, messagePart?: string): Promise<void> {
  return assert.rejects(promise, (error: any) => { assert.equal(error.name, name); if (messagePart) assert.match(String(error.message), new RegExp(messagePart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))); return true; });
}

test("DDB-15 request dispatch, condition semantics, and validation match DynamoDB", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb15-"));
  const clock = new TestClock(Date.parse("2026-10-22T12:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const client = new DynamoDBClient({ endpoint, region, credentials });
    await client.send(new CreateTableCommand({
      TableName: "Orders", BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "N" }, { AttributeName: "gsi", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      GlobalSecondaryIndexes: [{ IndexName: "ByGsi", KeySchema: [{ AttributeName: "gsi", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }],
    }));
    clock.advance(100); await settle();
    await client.send(new PutItemCommand({ TableName: "Orders", Item: { pk: { S: "a" }, sk: { N: "1" }, gsi: { S: "g" }, tags: { L: [{ S: "x" }] } } }));
    await client.send(new PutItemCommand({ TableName: "Orders", Item: { pk: { S: "a" }, sk: { N: "2" }, gsi: { S: "g" } } }));

    // API-02: only official actions for the matching target prefix are dispatchable.
    const unknown = await raw(endpoint, "DynamoDB_20120810.NotAnOperation", "{}");
    assert.equal(unknown.status, 400); assert.match(unknown.body.__type, /#UnknownOperationException$/);
    for (const target of ["DynamoDB_20120810.stop", "DynamoDB_20120810.sweepTtlNow", "DynamoDB_20120810.executePutItem", "DynamoDB_20120810.constructor", "DynamoDB_20120810.toString", "DynamoDB_20120810.ListStreams", "DynamoDBStreams_20120810.ListTables", "DynamoDB_19990101.ListTables"]) {
      const response = await raw(endpoint, target, "{}");
      assert.equal(response.status, 400, target); assert.match(response.body.__type, /#UnknownOperationException$/, target);
    }
    assert.equal((await raw(endpoint, "DynamoDBStreams_20120810.ListStreams", "{}")).status, 200);
    assert.deepEqual((await client.send(new ListTablesCommand({}))).TableNames, ["Orders"]);

    // API-12: malformed bodies and missing members are client errors, not InternalFailure.
    const malformed = await raw(endpoint, "DynamoDB_20120810.ListTables", "{not json");
    assert.equal(malformed.status, 400); assert.match(malformed.body.__type, /#SerializationException$/);
    const missingKey = await raw(endpoint, "DynamoDB_20120810.GetItem", JSON.stringify({ TableName: "Orders" }));
    assert.equal(missingKey.status, 400); assert.match(missingKey.body.__type, /#ValidationException$/); assert.match(missingKey.body.message, /'key'/);
    const missingTable = await raw(endpoint, "DynamoDB_20120810.DescribeTable", "{}");
    assert.equal(missingTable.status, 400); assert.match(missingTable.body.__type, /#ValidationException$/); assert.match(missingTable.body.message, /'tableName'/);
    const badBatch = await raw(endpoint, "DynamoDB_20120810.BatchWriteItem", JSON.stringify({ RequestItems: { Orders: {} } }));
    assert.equal(badBatch.status, 400); assert.match(badBatch.body.__type, /#ValidationException$/);
    await rejects(client.send(new ListTablesCommand({ Limit: 0 })), "ValidationException", "between 1 and 100");

    // API-01: conditions on a missing item are evaluated against an empty item.
    await client.send(new UpdateItemCommand({ TableName: "Orders", Key: { pk: { S: "new" }, sk: { N: "1" } }, UpdateExpression: "SET x = :v", ConditionExpression: "attribute_not_exists(pk)", ExpressionAttributeValues: { ":v": { S: "1" } } }));
    await rejects(client.send(new UpdateItemCommand({ TableName: "Orders", Key: { pk: { S: "new" }, sk: { N: "1" } }, UpdateExpression: "SET x = :v", ConditionExpression: "attribute_not_exists(pk)", ExpressionAttributeValues: { ":v": { S: "2" } } })), "ConditionalCheckFailedException");
    await rejects(client.send(new UpdateItemCommand({ TableName: "Orders", Key: { pk: { S: "absent" }, sk: { N: "1" } }, UpdateExpression: "SET x = :v", ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":v": { S: "1" } } })), "ConditionalCheckFailedException");
    assert.equal((await client.send(new GetItemCommand({ TableName: "Orders", Key: { pk: { S: "absent" }, sk: { N: "1" } } }))).Item, undefined);
    const created = await client.send(new UpdateItemCommand({ TableName: "Orders", Key: { pk: { S: "fresh" }, sk: { N: "1" } }, UpdateExpression: "SET x = :v", ExpressionAttributeValues: { ":v": { S: "1" } }, ReturnValues: "ALL_OLD" }));
    assert.equal(created.Attributes, undefined);
    // API-14: an update without UpdateExpression is a key-only upsert.
    await client.send(new UpdateItemCommand({ TableName: "Orders", Key: { pk: { S: "keyonly" }, sk: { N: "1" } } }));
    assert.deepEqual((await client.send(new GetItemCommand({ TableName: "Orders", Key: { pk: { S: "keyonly" }, sk: { N: "1" } } }))).Item, { pk: { S: "keyonly" }, sk: { N: "1" } });

    // API-09: single-item writes return the current item on a failed condition when asked.
    await assert.rejects(client.send(new PutItemCommand({ TableName: "Orders", Item: { pk: { S: "a" }, sk: { N: "1" } }, ConditionExpression: "attribute_not_exists(pk)", ReturnValuesOnConditionCheckFailure: "ALL_OLD" })), (error: any) => error.name === "ConditionalCheckFailedException" && error.Item?.gsi?.S === "g");
    await assert.rejects(client.send(new DeleteItemCommand({ TableName: "Orders", Key: { pk: { S: "a" }, sk: { N: "1" } }, ConditionExpression: "attribute_not_exists(pk)", ReturnValuesOnConditionCheckFailure: "ALL_OLD" })), (error: any) => error.name === "ConditionalCheckFailedException" && error.Item?.gsi?.S === "g");
    await assert.rejects(client.send(new UpdateItemCommand({ TableName: "Orders", Key: { pk: { S: "a" }, sk: { N: "1" } }, UpdateExpression: "SET x = :v", ConditionExpression: "attribute_not_exists(pk)", ExpressionAttributeValues: { ":v": { S: "1" } }, ReturnValuesOnConditionCheckFailure: "ALL_OLD" })), (error: any) => error.name === "ConditionalCheckFailedException" && error.Item?.gsi?.S === "g");
    await assert.rejects(client.send(new PutItemCommand({ TableName: "Orders", Item: { pk: { S: "a" }, sk: { N: "1" } }, ConditionExpression: "attribute_not_exists(pk)", ReturnValuesOnConditionCheckFailure: "NONE" })), (error: any) => error.name === "ConditionalCheckFailedException" && error.Item === undefined);

    // API-05: unused or empty placeholder maps are rejected before any write.
    await rejects(client.send(new UpdateItemCommand({ TableName: "Orders", Key: { pk: { S: "a" }, sk: { N: "1" } }, UpdateExpression: "SET x = :v", ExpressionAttributeValues: { ":v": { S: "1" }, ":unused": { S: "2" } } })), "ValidationException", "Value provided in ExpressionAttributeValues unused in expressions: keys: {:unused}");
    await rejects(client.send(new UpdateItemCommand({ TableName: "Orders", Key: { pk: { S: "a" }, sk: { N: "1" } }, UpdateExpression: "SET x = :v", ExpressionAttributeNames: { "#n": "name" }, ExpressionAttributeValues: { ":v": { S: "1" } } })), "ValidationException", "Value provided in ExpressionAttributeNames unused in expressions: keys: {#n}");
    await rejects(client.send(new ScanCommand({ TableName: "Orders", ExpressionAttributeValues: {} })), "ValidationException", "ExpressionAttributeValues must not be empty");
    await rejects(client.send(new GetItemCommand({ TableName: "Orders", Key: { pk: { S: "a" }, sk: { N: "1" } }, ExpressionAttributeNames: { "#x": "x" } })), "ValidationException", "can only be specified when using expressions");
    assert.equal((await client.send(new GetItemCommand({ TableName: "Orders", Key: { pk: { S: "a" }, sk: { N: "1" } } }))).Item?.x, undefined);

    // API-07: enum fields are validated.
    await rejects(client.send(new PutItemCommand({ TableName: "Orders", Item: { pk: { S: "z" }, sk: { N: "1" } }, ReturnValues: "ALL_NEW" })), "ValidationException", "Return values set to invalid value");
    await rejects(client.send(new DeleteItemCommand({ TableName: "Orders", Key: { pk: { S: "z" }, sk: { N: "1" } }, ReturnValues: "UPDATED_NEW" })), "ValidationException", "Return values set to invalid value");
    await rejects(client.send(new UpdateItemCommand({ TableName: "Orders", Key: { pk: { S: "z" }, sk: { N: "1" } }, ReturnValues: "BOGUS" as any })), "ValidationException", "Return values set to invalid value");
    await rejects(client.send(new GetItemCommand({ TableName: "Orders", Key: { pk: { S: "a" }, sk: { N: "1" } }, ReturnConsumedCapacity: "BOGUS" as any })), "ValidationException", "returnConsumedCapacity");
    await rejects(client.send(new ScanCommand({ TableName: "Orders", Select: "FOO" as any })), "ValidationException", "select");
    await rejects(client.send(new QueryCommand({ TableName: "Orders", Select: "ALL_PROJECTED_ATTRIBUTES", KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": { S: "a" } } })), "ValidationException", "ALL_PROJECTED_ATTRIBUTES");
    assert.equal((await client.send(new GetItemCommand({ TableName: "Orders", Key: { pk: { S: "z" }, sk: { N: "1" } } }))).Item, undefined);

    // API-08: Query filters cannot reference key attributes.
    await rejects(client.send(new QueryCommand({ TableName: "Orders", KeyConditionExpression: "pk = :p", FilterExpression: "sk > :z", ExpressionAttributeValues: { ":p": { S: "a" }, ":z": { N: "0" } } })), "ValidationException", "Filter Expression can only contain non-primary key attributes: Primary key attribute: sk");
    await rejects(client.send(new QueryCommand({ TableName: "Orders", IndexName: "ByGsi", KeyConditionExpression: "gsi = :g", FilterExpression: "gsi = :g", ExpressionAttributeValues: { ":g": { S: "g" } } })), "ValidationException", "Primary key attribute: gsi");
    assert.equal((await client.send(new ScanCommand({ TableName: "Orders", FilterExpression: "sk > :z", ExpressionAttributeValues: { ":z": { N: "1" } } }))).Count, 1);

    // API-06: size() of a missing attribute is false in filters and conditions, but still an error in updates.
    const sized = await client.send(new ScanCommand({ TableName: "Orders", FilterExpression: "size(tags) > :n", ExpressionAttributeValues: { ":n": { N: "0" } } }));
    assert.equal(sized.Count, 1); assert.equal(sized.Items?.[0]?.sk?.N, "1");
    await rejects(client.send(new UpdateItemCommand({ TableName: "Orders", Key: { pk: { S: "a" }, sk: { N: "2" } }, UpdateExpression: "SET n = size(tags)" })), "ValidationException", "does not exist in the item");

    // API-03: legacy parameters are honored by translation into expressions, and mixing styles is rejected.
    await rejects(client.send(new PutItemCommand({ TableName: "Orders", Item: { pk: { S: "a" }, sk: { N: "1" } }, Expected: { pk: { Exists: false } } })), "ConditionalCheckFailedException");
    await rejects(client.send(new PutItemCommand({ TableName: "Orders", Item: { pk: { S: "a" }, sk: { N: "1" } }, Expected: { pk: { Exists: false } }, ConditionExpression: "attribute_not_exists(pk)" })), "ValidationException", "Can not use both expression and non-expression parameters in the same request");
    assert.equal((await client.send(new GetItemCommand({ TableName: "Orders", Key: { pk: { S: "a" }, sk: { N: "1" } } }))).Item?.gsi?.S, "g");
    await client.send(new UpdateItemCommand({ TableName: "Orders", Key: { pk: { S: "a" }, sk: { N: "1" } }, AttributeUpdates: { count: { Action: "ADD", Value: { N: "2" } }, label: { Action: "PUT", Value: { S: "legacy" } }, x: { Action: "DELETE" } }, Expected: { gsi: { ComparisonOperator: "EQ", AttributeValueList: [{ S: "g" }] } } }));
    const legacyRead = await client.send(new GetItemCommand({ TableName: "Orders", Key: { pk: { S: "a" }, sk: { N: "1" } }, AttributesToGet: ["count", "label", "x"] }));
    assert.deepEqual(legacyRead.Item, { count: { N: "2" }, label: { S: "legacy" } });
    const legacyQuery = await client.send(new QueryCommand({ TableName: "Orders", KeyConditions: { pk: { ComparisonOperator: "EQ", AttributeValueList: [{ S: "a" }] }, sk: { ComparisonOperator: "BETWEEN", AttributeValueList: [{ N: "0" }, { N: "5" }] } }, QueryFilter: { label: { ComparisonOperator: "BEGINS_WITH", AttributeValueList: [{ S: "leg" }] } } }));
    assert.equal(legacyQuery.Count, 1); assert.equal(legacyQuery.ScannedCount, 2);
    const legacyScan = await client.send(new ScanCommand({ TableName: "Orders", ScanFilter: { label: { ComparisonOperator: "NOT_NULL" }, count: { ComparisonOperator: "GT", AttributeValueList: [{ N: "5" }] } }, ConditionalOperator: "OR" }));
    assert.equal(legacyScan.Count, 1);

    // API-04: the full AWS reserved-word list applies.
    for (const word of ["data", "state", "url", "token", "ttl", "timestamp"]) await rejects(client.send(new UpdateItemCommand({ TableName: "Orders", Key: { pk: { S: "a" }, sk: { N: "1" } }, UpdateExpression: `SET ${word} = :v`, ExpressionAttributeValues: { ":v": { S: "1" } } })), "ValidationException", `reserved keyword: ${word}`);

    // API-15: numbers are stored in canonical form and numeric set members are compared numerically.
    await client.send(new PutItemCommand({ TableName: "Orders", Item: { pk: { S: "num" }, sk: { N: "01.50" }, a: { N: "1.10" }, b: { N: "-0" }, c: { N: "1e2" }, d: { N: ".5" }, e: { N: "+7" }, big: { N: "1E+125" }, set: { NS: ["3", "10", "0.25"] }, nested: { M: { v: { N: "02.0" } } } } }));
    const numeric = (await client.send(new GetItemCommand({ TableName: "Orders", Key: { pk: { S: "num" }, sk: { N: "1.5" } } }))).Item!;
    assert.deepEqual({ sk: numeric.sk, a: numeric.a, b: numeric.b, c: numeric.c, d: numeric.d, e: numeric.e, big: numeric.big, nested: numeric.nested }, { sk: { N: "1.5" }, a: { N: "1.1" }, b: { N: "0" }, c: { N: "100" }, d: { N: "0.5" }, e: { N: "7" }, big: { N: "1E+125" }, nested: { M: { v: { N: "2" } } } });
    await rejects(client.send(new PutItemCommand({ TableName: "Orders", Item: { pk: { S: "dup" }, sk: { N: "1" }, set: { NS: ["1", "1.0"] } } })), "ValidationException", "duplicates");

    // API-13/17: a stream cannot be enabled twice, and the latest stream ARN survives a disable.
    await client.send(new UpdateTableCommand({ TableName: "Orders", StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_IMAGE" } })); clock.advance(100); await settle();
    const streamArn = (await client.send(new DescribeTableCommand({ TableName: "Orders" }))).Table!.LatestStreamArn!;
    await rejects(client.send(new UpdateTableCommand({ TableName: "Orders", StreamSpecification: { StreamEnabled: true, StreamViewType: "KEYS_ONLY" } })), "ValidationException", "Table already has an enabled stream");
    await client.send(new UpdateTableCommand({ TableName: "Orders", StreamSpecification: { StreamEnabled: false } })); clock.advance(100); await settle();
    const afterDisable = (await client.send(new DescribeTableCommand({ TableName: "Orders" }))).Table!;
    assert.equal(afterDisable.StreamSpecification?.StreamEnabled, false); assert.equal(afterDisable.LatestStreamArn, streamArn);
    await rejects(client.send(new UpdateTableCommand({ TableName: "Orders", StreamSpecification: { StreamEnabled: false } })), "ValidationException", "does not have an enabled stream");

    // A concurrent reuse of an in-flight client token is TransactionInProgressException; the in-process call is deterministic because the first call registers the token before its first await.
    const service = (simulator as any).regionalServices.get(region).dynamodb;
    const inFlight = service.TransactWriteItems({ ClientRequestToken: "ddb15-token", TransactItems: [{ Put: { TableName: "Orders", Item: { pk: { S: "token" }, sk: { N: "1" } } } }] });
    await assert.rejects(service.TransactWriteItems({ ClientRequestToken: "ddb15-token", TransactItems: [{ Put: { TableName: "Orders", Item: { pk: { S: "token" }, sk: { N: "1" } } } }] }), (error: any) => error.code === "TransactionInProgressException");
    await inFlight;
    await service.TransactWriteItems({ ClientRequestToken: "ddb15-token", TransactItems: [{ Put: { TableName: "Orders", Item: { pk: { S: "token" }, sk: { N: "1" } } } }] });

    // API-16: an UpdateTable that keeps the same provisioned units is rejected.
    await client.send(new CreateTableCommand({ TableName: "Plain", BillingMode: "PROVISIONED", ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 }, AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }] })); clock.advance(100); await settle();
    await rejects(client.send(new UpdateTableCommand({ TableName: "Plain", ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 } })), "ValidationException", "will not change");
    await client.send(new UpdateTableCommand({ TableName: "Plain", ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 5 } }));

    // API-10: every transaction condition is evaluated and reported.
    await assert.rejects(client.send(new TransactWriteItemsCommand({ TransactItems: [
      { ConditionCheck: { TableName: "Orders", Key: { pk: { S: "a" }, sk: { N: "1" } }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: "Orders", Item: { pk: { S: "txn" }, sk: { N: "1" } } } },
      { ConditionCheck: { TableName: "Orders", Key: { pk: { S: "a" }, sk: { N: "2" } }, ConditionExpression: "attribute_not_exists(pk)", ReturnValuesOnConditionCheckFailure: "ALL_OLD" } },
    ] })), (error: any) => {
      assert.equal(error.name, "TransactionCanceledException");
      assert.match(error.message, /\[ConditionalCheckFailed, None, ConditionalCheckFailed\]$/);
      assert.deepEqual(error.CancellationReasons.map((reason: any) => reason.Code), ["ConditionalCheckFailed", "None", "ConditionalCheckFailed"]);
      assert.equal(error.CancellationReasons[1].Message ?? null, null);
      assert.equal(error.CancellationReasons[2].Item?.gsi?.S, "g");
      return true;
    });
    assert.equal((await client.send(new GetItemCommand({ TableName: "Orders", Key: { pk: { S: "txn" }, sk: { N: "1" } } }))).Item, undefined);

    // PartiQL DELETE of a missing key succeeds with zero items (AWS: "SUCCESS is returned with 0 items deleted"); UPDATE of a missing key fails the condition.
    assert.deepEqual((await client.send(new ExecuteStatementCommand({ Statement: `DELETE FROM "Orders" WHERE pk = 'nope' AND sk = 1` }))).Items, []);
    await rejects(client.send(new ExecuteStatementCommand({ Statement: `UPDATE "Orders" SET x = 1 WHERE pk = 'nope' AND sk = 1` })), "ConditionalCheckFailedException");

    // Design corrections from the AWS documentation pass: AT_TIMESTAMP iterators, wire record shape, stream tags, SYSTEM backups, and capacity quotas.
    await client.send(new UpdateTableCommand({ TableName: "Orders", StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_IMAGE" } })); clock.advance(100); await settle();
    const tsStreamArn = (await client.send(new DescribeTableCommand({ TableName: "Orders" }))).Table!.LatestStreamArn!;
    await client.send(new PutItemCommand({ TableName: "Orders", Item: { pk: { S: "ts" }, sk: { N: "1" } } })); clock.advance(5_000);
    await client.send(new PutItemCommand({ TableName: "Orders", Item: { pk: { S: "ts" }, sk: { N: "2" } } }));
    const streams = new DynamoDBStreamsClient({ endpoint, region, credentials });
    const shardId = (await streams.send(new DescribeStreamCommand({ StreamArn: tsStreamArn }))).StreamDescription!.Shards![0].ShardId!;
    const atTime = Math.floor(clock.now() / 1000) - 1;
    // The pinned @aws-sdk/client-dynamodb-streams (3.1088) predates AT_TIMESTAMP and drops the Timestamp member, so the iterator request goes over the raw wire.
    const atIterator = (await raw(endpoint, "DynamoDBStreams_20120810.GetShardIterator", JSON.stringify({ StreamArn: tsStreamArn, ShardId: shardId, ShardIteratorType: "AT_TIMESTAMP", Timestamp: atTime }))).body.ShardIterator as string;
    const atRecords = (await streams.send(new GetRecordsCommand({ ShardIterator: atIterator }))).Records!;
    assert.deepEqual(atRecords.map(record => record.dynamodb?.Keys?.sk?.N), ["2"]); assert.equal((atRecords[0] as any).eventSourceARN, undefined, "GetRecords output carries only the documented record fields");
    const futureIterator = await raw(endpoint, "DynamoDBStreams_20120810.GetShardIterator", JSON.stringify({ StreamArn: tsStreamArn, ShardId: shardId, ShardIteratorType: "AT_TIMESTAMP", Timestamp: Math.floor(clock.now() / 1000) + 60 }));
    assert.equal(futureIterator.status, 400); assert.match(futureIterator.body.__type, /#ValidationException$/); assert.match(futureIterator.body.message, /future/);
    const missingTimestamp = await raw(endpoint, "DynamoDBStreams_20120810.GetShardIterator", JSON.stringify({ StreamArn: tsStreamArn, ShardId: shardId, ShardIteratorType: "AT_TIMESTAMP" }));
    assert.equal(missingTimestamp.status, 400); assert.match(missingTimestamp.body.message, /Timestamp is required/);
    assert.deepEqual(((await streams.send(new DescribeStreamCommand({ StreamArn: tsStreamArn }))).StreamDescription?.Shards ?? []).length, 1);
    await client.send(new TagResourceCommand({ ResourceArn: tsStreamArn, Tags: [{ Key: "stream-owner", Value: "ddb15" }] }));
    assert.deepEqual((await client.send(new ListTagsOfResourceCommand({ ResourceArn: tsStreamArn }))).Tags, [{ Key: "stream-owner", Value: "ddb15" }]);
    assert.deepEqual((await client.send(new ListTagsOfResourceCommand({ ResourceArn: `arn:aws:dynamodb:${region}:000000000000:table/Orders` }))).Tags, [], "stream tags do not leak onto the table");

    await client.send(new UpdateContinuousBackupsCommand({ TableName: "Plain", PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }));
    await client.send(new DeleteTableCommand({ TableName: "Plain" })); clock.advance(100); await settle();
    const systemBackups = (await client.send(new ListBackupsCommand({ BackupType: "SYSTEM" }))).BackupSummaries ?? [];
    assert.equal(systemBackups.length, 1); assert.equal(systemBackups[0].BackupName, "Plain$DeletedTableBackup"); assert.equal(systemBackups[0].BackupType, "SYSTEM"); assert.ok(systemBackups[0].BackupExpiryDateTime);
    assert.equal(((await client.send(new ListBackupsCommand({}))).BackupSummaries ?? []).length, 0, "USER is the default ListBackups filter");
    clock.advance(36 * 24 * 3_600_000);
    assert.equal(((await client.send(new ListBackupsCommand({ BackupType: "ALL" }))).BackupSummaries ?? []).length, 0, "SYSTEM backups expire after 35 days");

    await client.send(new CreateTableCommand({ TableName: "Quota", BillingMode: "PROVISIONED", ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 }, AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }] })); clock.advance(100); await settle();
    for (let units = 9; units >= 6; units--) { await client.send(new UpdateTableCommand({ TableName: "Quota", ProvisionedThroughput: { ReadCapacityUnits: units, WriteCapacityUnits: 10 } })); clock.advance(100); await settle(); }
    await rejects(client.send(new UpdateTableCommand({ TableName: "Quota", ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 10 } })), "LimitExceededException", "decreases are limited");
    clock.advance(3_600_000);
    await client.send(new UpdateTableCommand({ TableName: "Quota", ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 10 } })); clock.advance(100); await settle();
    // Warm throughput below the 12,000 / 4,000 defaults is accepted (the developer guide's own examples use 5 / 5 and 88 / 77); only a decrease below an explicitly set value is rejected.
    await client.send(new UpdateTableCommand({ TableName: "Quota", WarmThroughput: { ReadUnitsPerSecond: 500, WriteUnitsPerSecond: 300 } })); clock.advance(100); await settle();
    await rejects(client.send(new UpdateTableCommand({ TableName: "Quota", WarmThroughput: { ReadUnitsPerSecond: 100, WriteUnitsPerSecond: 100 } })), "ValidationException", "cannot be decreased");
    for (let round = 0; round < 4; round++) { await client.send(new UpdateTableCommand({ TableName: "Quota", BillingMode: "PAY_PER_REQUEST" })); clock.advance(100); await settle(); await client.send(new UpdateTableCommand({ TableName: "Quota", BillingMode: "PROVISIONED", ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 10 } })); clock.advance(100); await settle(); }
    await rejects(client.send(new UpdateTableCommand({ TableName: "Quota", BillingMode: "PAY_PER_REQUEST" })), "LimitExceededException", "4 times in a 24-hour");
    await rejects(client.send(new UpdateTableCommand({ TableName: "Quota", GlobalSecondaryIndexUpdates: [{ Create: { IndexName: "Extra", KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" }, ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } } }], ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 10 } })), "ValidationException", "same request that creates or deletes");

    // Batch envelopes must contain at least one request per table.
    await rejects(client.send(new BatchGetItemCommand({ RequestItems: { Orders: { Keys: [] } } })), "ValidationException", "greater than or equal to 1");
    await rejects(client.send(new BatchWriteItemCommand({ RequestItems: {} })), "ValidationException", "greater than or equal to 1");
  } finally {
    await simulator.stop();
    await rm(root, { recursive: true, force: true });
  }
});
