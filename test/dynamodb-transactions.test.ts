import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateTableCommand, DynamoDBClient, GetItemCommand, PutItemCommand, TransactGetItemsCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { authorizationTarget } from "../src/auth/target.js";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("DynamoDB transaction authorization targets every exact table ARN", async () => {
  const request = {
    method: "POST",
    url: "/",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": "DynamoDB_20120810.TransactWriteItems",
    },
    socket: { remoteAddress: "127.0.0.1", encrypted: false },
    [Symbol.for("stacksim.request-body")]: Buffer.from(JSON.stringify({
      TransactItems: [
        { Update: { TableName: "Accounts", Key: { id: { S: "a" } }, UpdateExpression: "SET balance = :next", ExpressionAttributeValues: { ":next": { N: "7" } } } },
        { Put: { TableName: "Ledger", Item: { id: { S: "entry-1" } } } },
        { ConditionCheck: { TableName: "Accounts", Key: { id: { S: "a" } }, ConditionExpression: "attribute_exists(id)" } },
      ],
    })),
  } as any;
  const target = await authorizationTarget(
    request,
    new URL("http://127.0.0.1/"),
    "dynamodb",
    "eu-west-1",
    "000000000000",
    { principalArn: "arn:aws:iam::000000000000:role/transaction-writer", accountId: "000000000000", accessKeyId: "admin" } as any,
    Date.now(),
  );
  assert.equal(target.action, "dynamodb:TransactWriteItems");
  assert.equal(target.resource, "arn:aws:dynamodb:eu-west-1:000000000000:table/Accounts");
  assert.deepEqual(
    target.additionalTargets?.map(item => [item.action, item.resource]),
    [["dynamodb:TransactWriteItems", "arn:aws:dynamodb:eu-west-1:000000000000:table/Ledger"]],
  );
});

test("DynamoDB transactions atomically write, cancel in order, project reads, reject duplicates, and persist idempotency", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-transactions-")); const clock = new TestClock(Date.now()); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, clock, authMode: "off"}); let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
    for (const TableName of ["Accounts", "Ledger"]) await client.send(new CreateTableCommand({ TableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
    clock.advance(100); await new Promise<void>(resolve => setImmediate(resolve));
    await client.send(new PutItemCommand({ TableName: "Accounts", Item: { id: { S: "a" }, balance: { N: "10" } } }));
    const token = "transfer-1"; const transaction = new TransactWriteItemsCommand({ ClientRequestToken: token, ReturnConsumedCapacity: "TOTAL", TransactItems: [
      { Update: { TableName: "Accounts", Key: { id: { S: "a" } }, UpdateExpression: "SET balance = :next", ConditionExpression: "balance = :old", ExpressionAttributeValues: { ":old": { N: "10" }, ":next": { N: "7" } } } },
      { Put: { TableName: "Ledger", Item: { id: { S: "entry-1" }, amount: { N: "3" } }, ConditionExpression: "attribute_not_exists(id)" } },
    ] });
    const written = await client.send(transaction); assert.equal(written.ConsumedCapacity?.length, 2); await client.send(transaction);
    assert.equal((await client.send(new GetItemCommand({ TableName: "Accounts", Key: { id: { S: "a" } } }))).Item?.balance?.N, "7");
    const read = await client.send(new TransactGetItemsCommand({ ReturnConsumedCapacity: "TOTAL", TransactItems: [
      { Get: { TableName: "Accounts", Key: { id: { S: "a" } }, ProjectionExpression: "balance" } },
      { Get: { TableName: "Ledger", Key: { id: { S: "missing" } } } },
    ] })); assert.deepEqual(read.Responses?.[0].Item, { balance: { N: "7" } }); assert.deepEqual(read.Responses?.[1], {});
    await client.send(new TransactWriteItemsCommand({ TransactItems: [{ Delete: { TableName: "Ledger", Key: { id: { S: "entry-1" } }, ConditionExpression: "attribute_exists(id)" } }] })); assert.equal((await client.send(new GetItemCommand({ TableName: "Ledger", Key: { id: { S: "entry-1" } } }))).Item, undefined);
    await assert.rejects(client.send(new TransactWriteItemsCommand({ ReturnCancellationReasons: true, TransactItems: [
      { ConditionCheck: { TableName: "Accounts", Key: { id: { S: "a" } }, ConditionExpression: "balance = :expected", ExpressionAttributeValues: { ":expected": { N: "999" } }, ReturnValuesOnConditionCheckFailure: "ALL_OLD" } },
      { Put: { TableName: "Ledger", Item: { id: { S: "must-not-exist" } } } },
    ] } as any)), (error: any) => { assert.equal(error.name, "TransactionCanceledException"); assert.equal(error.CancellationReasons?.[0]?.Code, "ConditionalCheckFailed"); assert.equal(error.CancellationReasons?.[1]?.Code, "None"); assert.equal(error.CancellationReasons?.[0]?.Item?.balance?.N, "7"); return true; });
    assert.equal((await client.send(new GetItemCommand({ TableName: "Ledger", Key: { id: { S: "must-not-exist" } } }))).Item, undefined);
    await assert.rejects(client.send(new TransactWriteItemsCommand({ TransactItems: [
      { Put: { TableName: "Ledger", Item: { id: { S: "duplicate" } } } }, { Delete: { TableName: "Ledger", Key: { id: { S: "duplicate" } } } },
    ] })), (error: any) => error.name === "ValidationException");
    await assert.rejects(client.send(new TransactWriteItemsCommand({ TransactItems: [] })), (error: any) => error.name === "ValidationException");
    await assert.rejects(client.send(new TransactWriteItemsCommand({ TransactItems: Array.from({ length: 101 }, (_, index) => ({ Put: { TableName: "Ledger", Item: { id: { S: `too-many-${index}` } } } })) })), (error: any) => error.name === "ValidationException");
    await assert.rejects(client.send(new TransactWriteItemsCommand({ TransactItems: [{ Put: { TableName: "Ledger", Item: { id: { S: "oversized" }, payload: { S: "x".repeat(4 * 1024 * 1024) } } } }] })), (error: any) => error.name === "ValidationException");
    await assert.rejects(client.send(new TransactWriteItemsCommand({ ClientRequestToken: "x".repeat(37), TransactItems: [{ Delete: { TableName: "Ledger", Key: { id: { S: "missing" } } } }] })), (error: any) => error.name === "ValidationException");
    await assert.rejects(client.send(new TransactGetItemsCommand({ TransactItems: [{ Get: { TableName: "MissingTable", Key: { id: { S: "missing" } } } }] })), (error: any) => error.name === "ResourceNotFoundException");
    const indexedCapacity = await client.send(new TransactGetItemsCommand({
      ReturnConsumedCapacity: "INDEXES",
      TransactItems: [{ Get: { TableName: "Accounts", Key: { id: { S: "a" } } } }],
    }));
    assert.equal(indexedCapacity.Responses?.[0]?.Item?.id?.S, "a");
    assert.equal(indexedCapacity.ConsumedCapacity?.[0]?.TableName, "Accounts");
    await assert.rejects(client.send(new TransactWriteItemsCommand({ ReturnItemCollectionMetrics: "invalid" as any, TransactItems: [{ Delete: { TableName: "Ledger", Key: { id: { S: "missing" } } } }] })), (error: any) => error.name === "ValidationException");
    await assert.rejects(client.send(new TransactWriteItemsCommand({ TransactItems: [{ Put: { TableName: "Ledger", Item: { id: { S: "invalid-return" } }, ReturnValuesOnConditionCheckFailure: "ALL_NEW" as any } }] })), (error: any) => error.name === "ValidationException");
    const identical = () => client!.send(new TransactWriteItemsCommand({ ClientRequestToken: "parallel.token!", TransactItems: [{ Put: { TableName: "Ledger", Item: { id: { S: "parallel-idempotent" } }, ConditionExpression: "attribute_not_exists(id)" } }] })); const identicalResults = await Promise.allSettled([identical(), identical()]); assert.equal(identicalResults.filter(result => result.status === "fulfilled").length, 2, "concurrent identical client tokens must coalesce");
    const mismatched = (id: string) => client!.send(new TransactWriteItemsCommand({ ClientRequestToken: "parallel-mismatch", TransactItems: [{ Put: { TableName: "Ledger", Item: { id: { S: id } } } }] })); const mismatchResults = await Promise.allSettled([mismatched("mismatch-a"), mismatched("mismatch-b")]); assert.equal(mismatchResults.filter(result => result.status === "fulfilled").length, 1); assert.equal(mismatchResults.filter(result => result.status === "rejected" && (result.reason as any).name === "IdempotentParameterMismatchException").length, 1);
    await assert.rejects(client.send(new TransactWriteItemsCommand({ ClientRequestToken: token, TransactItems: [{ Delete: { TableName: "Accounts", Key: { id: { S: "a" } } } }] })), (error: any) => error.name === "IdempotentParameterMismatchException");
    const competing = (next: string) => client!.send(new TransactWriteItemsCommand({ TransactItems: [{ Update: { TableName: "Accounts", Key: { id: { S: "a" } }, UpdateExpression: "SET balance = :next", ConditionExpression: "balance = :old", ExpressionAttributeValues: { ":old": { N: "7" }, ":next": { N: next } } } }] })); const conflicts = await Promise.allSettled([competing("6"), competing("5")]); assert.equal(conflicts.filter(result => result.status === "fulfilled").length, 1); assert.equal(conflicts.filter(result => result.status === "rejected" && (result.reason as any).name === "TransactionCanceledException").length, 1); assert.match((await client.send(new GetItemCommand({ TableName: "Accounts", Key: { id: { S: "a" } } }))).Item?.balance?.N ?? "", /^[56]$/);
    process.env.STACKSIM_DDB_FAIL_TRANSACTION_AFTER_EVALUATION = "true"; await assert.rejects(client.send(new TransactWriteItemsCommand({ TransactItems: [{ Put: { TableName: "Ledger", Item: { id: { S: "injected-a" } } } }, { Put: { TableName: "Ledger", Item: { id: { S: "injected-b" } } } }] })), (error: any) => error.name === "InternalServerError"); delete process.env.STACKSIM_DDB_FAIL_TRANSACTION_AFTER_EVALUATION; assert.equal((await client.send(new GetItemCommand({ TableName: "Ledger", Key: { id: { S: "injected-a" } } }))).Item, undefined); assert.equal((await client.send(new GetItemCommand({ TableName: "Ledger", Key: { id: { S: "injected-b" } } }))).Item, undefined);
    client.destroy(); await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, clock, authMode: "off"}); await simulator.start(); client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }); await client.send(transaction); assert.match((await client.send(new GetItemCommand({ TableName: "Accounts", Key: { id: { S: "a" } } }))).Item?.balance?.N ?? "", /^[56]$/);
    const expiring = new TransactWriteItemsCommand({ ClientRequestToken: "expires-after-ten-minutes", TransactItems: [{ Put: { TableName: "Ledger", Item: { id: { S: "expiring-token" } }, ConditionExpression: "attribute_not_exists(id)" } }] }); await client.send(expiring); await client.send(new TransactWriteItemsCommand({ TransactItems: [{ Delete: { TableName: "Ledger", Key: { id: { S: "expiring-token" } } } }] })); await client.send(expiring); assert.equal((await client.send(new GetItemCommand({ TableName: "Ledger", Key: { id: { S: "expiring-token" } } }))).Item, undefined, "replay inside the idempotency window must have no side effect"); clock.advance(10 * 60_000 + 1); await client.send(expiring); assert.equal((await client.send(new GetItemCommand({ TableName: "Ledger", Key: { id: { S: "expiring-token" } } }))).Item?.id?.S, "expiring-token");
  } finally { delete process.env.STACKSIM_DDB_FAIL_TRANSACTION_AFTER_EVALUATION; client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
