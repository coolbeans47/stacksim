import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BatchExecuteStatementCommand,
  CreateTableCommand,
  DynamoDBClient,
  ExecuteStatementCommand,
  ExecuteTransactionCommand,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";
import { parsePartiql } from "../src/dynamodb/partiql.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function validation(promise: Promise<unknown>, name = "ValidationException"): Promise<void> {
  return assert.rejects(promise, (error: any) => error.name === name);
}

async function rawDynamo(endpoint: string, operation: string, body: unknown): Promise<{ status: number; headers: Headers; body: any }> {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": `DynamoDB_20120810.${operation}` }, body: JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test("DynamoDB PartiQL pinned grammar corpus stays within the documented subset", async () => {
  const corpus = JSON.parse(await readFile(join(process.cwd(), "test", "fixtures", "dynamodb-partiql", "grammar.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(process.cwd(), "docs", "generated", "dynamodb-partiql-conformance.json"), "utf8"));
  const installed = JSON.parse(await readFile(join(process.cwd(), "node_modules", "@aws-sdk", "client-dynamodb", "package.json"), "utf8"));
  assert.equal(manifest.sdk.version, installed.version); assert.equal(manifest.checkedAt, "2026-08-01"); assert.equal(manifest.grammar.statementLimitControl.includes("ExecuteStatement.Limit"), true);
  for (const fixture of corpus.positive) assert.doesNotThrow(() => parsePartiql(fixture.statement, fixture.parameters));
  for (const statement of corpus.negative) assert.throws(() => parsePartiql(statement, undefined), (error: any) => error.code === "ValidationException");
});

test("DynamoDB PartiQL executes literal and parameterized CRUD, projections, index reads, returning, and pagination", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-partiql-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off"}); let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
    await client.send(new CreateTableCommand({ TableName: "PartiqlRecords", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "tenant", AttributeType: "S" }, { AttributeName: "recordId", AttributeType: "N" }, { AttributeName: "category", AttributeType: "S" }], KeySchema: [{ AttributeName: "tenant", KeyType: "HASH" }, { AttributeName: "recordId", KeyType: "RANGE" }], GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }] }));
    await waitForTableActive(client, "PartiqlRecords");
    const inserted = await client.send(new ExecuteStatementCommand({ Statement: `INSERT INTO "PartiqlRecords" VALUE {'tenant':'acme','recordId':1,'category':'books','title':'Literal','counter':0,'profile':{'name':'Ada'},'years':[2024,2025],'labels':<<'new','read'>>}` }));
    assert.deepEqual(inserted.Items, []);
    await validation(client.send(new ExecuteStatementCommand({ Statement: `INSERT INTO "PartiqlRecords" VALUE {'tenant':'acme','recordId':1}` })), "DuplicateItemException");
    const injectionLike = `x' OR tenant='other`;
    await client.send(new ExecuteStatementCommand({ Statement: `INSERT INTO "PartiqlRecords" VALUE {'tenant':?,'recordId':?,'category':?,'title':?}`, Parameters: [{ S: "acme" }, { N: "2" }, { S: "books" }, { S: injectionLike }] }));
    await client.send(new ExecuteStatementCommand({ Statement: `INSERT INTO "PartiqlRecords" VALUE {'tenant':?,'recordId':?,'category':?,'title':?}`, Parameters: [{ S: "acme" }, { N: "3" }, { S: "music" }, { S: "Third" }] }));

    const selected = await client.send(new ExecuteStatementCommand({ Statement: `SELECT tenant, recordId, profile.name FROM "PartiqlRecords" WHERE tenant=? AND recordId=?`, Parameters: [{ S: "acme" }, { N: "1" }], ConsistentRead: true }));
    assert.deepEqual(selected.Items, [{ tenant: { S: "acme" }, recordId: { N: "1" }, profile: { M: { name: { S: "Ada" } } } }]);
    const computed = await client.send(new ExecuteStatementCommand({ Statement: `SELECT size(title), counter+?, begins_with(title,'Lit'), contains(labels,'read') FROM "PartiqlRecords" WHERE tenant='acme' AND recordId=1`, Parameters: [{ N: "1" }] }));
    assert.deepEqual(computed.Items, [{ _1: { N: "7" }, _2: { N: "1" }, _3: { BOOL: true }, _4: { BOOL: true } }]);
    assert.deepEqual((await client.send(new ExecuteStatementCommand({ Statement: `SELECT size(missing) FROM "PartiqlRecords" WHERE tenant='acme' AND recordId=1` }))).Items, [{}]);
    await validation(client.send(new ExecuteStatementCommand({ Statement: `SELECT size(counter) FROM "PartiqlRecords" WHERE tenant='acme' AND recordId=1` })));
    assert.equal((await client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlRecords" WHERE title=?`, Parameters: [{ S: injectionLike }] }))).Items?.[0].recordId?.N, "2");
    assert.equal((await client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlRecords"."ByCategory" WHERE category='books'` }))).Items?.length, 2);

    const pageStatement = `SELECT tenant, recordId, title FROM "PartiqlRecords" WHERE tenant=? ORDER BY recordId DESC`;
    const first = await client.send(new ExecuteStatementCommand({ Statement: pageStatement, Parameters: [{ S: "acme" }], Limit: 1 }));
    assert.deepEqual(first.Items?.map(item => item.recordId?.N), ["3"]); assert.ok(first.NextToken); assert.ok(first.LastEvaluatedKey);
    const second = await client.send(new ExecuteStatementCommand({ Statement: pageStatement, Parameters: [{ S: "acme" }], Limit: 1, NextToken: first.NextToken }));
    assert.deepEqual(second.Items?.map(item => item.recordId?.N), ["2"]); assert.ok(second.NextToken);
    const third = await client.send(new ExecuteStatementCommand({ Statement: pageStatement, Parameters: [{ S: "acme" }], Limit: 1, NextToken: second.NextToken }));
    assert.deepEqual(third.Items?.map(item => item.recordId?.N), ["1"]); assert.equal(third.NextToken, undefined);
    await validation(client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlRecords" WHERE tenant=?`, Parameters: [{ S: "acme" }], Limit: 1, NextToken: `${first.NextToken}x` })));
    await validation(client.send(new ExecuteStatementCommand({ Statement: `${pageStatement} LIMIT 2`, Parameters: [{ S: "acme" }] })), "ValidationException");

    const updated = await client.send(new ExecuteStatementCommand({ Statement: `UPDATE "PartiqlRecords" SET title=? SET counter=counter+? SET years=list_append(years,[2026]) REMOVE profile.name WHERE tenant=? AND recordId=? RETURNING ALL NEW *`, Parameters: [{ S: "Updated" }, { N: "2" }, { S: "acme" }, { N: "1" }] }));
    assert.equal(updated.Items?.[0].title?.S, "Updated"); assert.equal(updated.Items?.[0].counter?.N, "2"); assert.deepEqual((updated.Items?.[0].years as any).L.map((value: any) => value.N), ["2024", "2025", "2026"]);
    const setUpdated = await client.send(new ExecuteStatementCommand({ Statement: `UPDATE "PartiqlRecords" SET labels=set_add(labels, <<'favorite'>>) WHERE tenant='acme' AND recordId=1 RETURNING MODIFIED NEW *` }));
    assert.deepEqual(new Set((setUpdated.Items?.[0].labels as any).SS), new Set(["new", "read", "favorite"]));
    const deleted = await client.send(new ExecuteStatementCommand({ Statement: `DELETE FROM "PartiqlRecords" WHERE tenant=? AND recordId=? RETURNING ALL OLD *`, Parameters: [{ S: "acme" }, { N: "3" }] }));
    assert.equal(deleted.Items?.[0].title?.S, "Third");
    assert.deepEqual((await client.send(new ExecuteStatementCommand({ Statement: `DELETE FROM "PartiqlRecords" WHERE tenant='acme' AND recordId=999 RETURNING ALL OLD *` }))).Items, []);

    await validation(client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM ? WHERE tenant=?`, Parameters: [{ S: "PartiqlRecords" }, { S: "acme" }] })));
    await validation(client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlRecords"; DELETE FROM "PartiqlRecords" WHERE tenant='acme' AND recordId=1` })));
    await validation(client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlRecords" JOIN "Other" ON tenant=tenant` })));
  } finally { client?.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true }); }
});

test("DynamoDB PartiQL batches preserve ordered item errors and transactions reuse atomic commit and idempotency", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-partiql-multi-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off"}); let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
    await client.send(new CreateTableCommand({ TableName: "PartiqlAccounts", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
    await waitForTableActive(client, "PartiqlAccounts");
    for (const [id, balance] of [["a", "10"], ["b", "20"]]) await client.send(new PutItemCommand({ TableName: "PartiqlAccounts", Item: { id: { S: id }, balance: { N: balance } } }));
    const reads = await client.send(new BatchExecuteStatementCommand({ Statements: [
      { Statement: `SELECT id, balance FROM "PartiqlAccounts" WHERE id=?`, Parameters: [{ S: "b" }], ConsistentRead: true },
      { Statement: `SELECT * FROM "PartiqlAccounts" WHERE id=?`, Parameters: [{ S: "missing" }] },
      { Statement: `SELECT * FROM "PartiqlAccounts" WHERE balance>?`, Parameters: [{ N: "1" }] },
    ] }));
    assert.equal(reads.Responses?.[0].Item?.id?.S, "b"); assert.deepEqual(reads.Responses?.[1], { TableName: "PartiqlAccounts" }); assert.equal(reads.Responses?.[2].Error?.Code, "ValidationException");
    const writes = await client.send(new BatchExecuteStatementCommand({ Statements: [
      { Statement: `INSERT INTO "PartiqlAccounts" VALUE {'id':?,'balance':?}`, Parameters: [{ S: "c" }, { N: "30" }] },
      { Statement: `INSERT INTO "PartiqlAccounts" VALUE {'id':'a','balance':99}` },
      { Statement: `UPDATE "PartiqlAccounts" SET balance=? WHERE id=?`, Parameters: [{ N: "25" }, { S: "b" }] },
    ] }));
    assert.equal(writes.Responses?.[0].TableName, "PartiqlAccounts"); assert.equal(writes.Responses?.[1].Error?.Code, "DuplicateItemException"); assert.equal((await client.send(new GetItemCommand({ TableName: "PartiqlAccounts", Key: { id: { S: "b" } } }))).Item?.balance?.N, "25");
    await validation(client.send(new BatchExecuteStatementCommand({ Statements: [{ Statement: `SELECT * FROM "PartiqlAccounts" WHERE id='a'` }, { Statement: `DELETE FROM "PartiqlAccounts" WHERE id='b'` }] })));

    const transaction = new ExecuteTransactionCommand({ ClientRequestToken: "partiql-transaction", TransactStatements: [
      { Statement: `UPDATE "PartiqlAccounts" SET balance=balance-? WHERE id=?`, Parameters: [{ N: "5" }, { S: "a" }] },
      { Statement: `UPDATE "PartiqlAccounts" SET balance=balance+? WHERE id=?`, Parameters: [{ N: "5" }, { S: "b" }] },
      { Statement: `INSERT INTO "PartiqlAccounts" VALUE {'id':?,'balance':?}`, Parameters: [{ S: "ledger" }, { N: "5" }] },
    ] });
    const committed = await client.send(transaction); assert.equal(committed.Responses?.length, 3); await client.send(transaction);
    assert.equal((await client.send(new GetItemCommand({ TableName: "PartiqlAccounts", Key: { id: { S: "a" } } }))).Item?.balance?.N, "5"); assert.equal((await client.send(new GetItemCommand({ TableName: "PartiqlAccounts", Key: { id: { S: "b" } } }))).Item?.balance?.N, "30");
    await validation(client.send(new ExecuteTransactionCommand({ ClientRequestToken: "partiql-transaction", TransactStatements: [{ Statement: `DELETE FROM "PartiqlAccounts" WHERE id='a'` }] })), "IdempotentParameterMismatchException");

    await validation(client.send(new ExecuteTransactionCommand({ TransactStatements: [
      { Statement: `UPDATE "PartiqlAccounts" SET balance=999 WHERE id='a'` },
      { Statement: `INSERT INTO "PartiqlAccounts" VALUE {'id':'ledger','balance':9}` },
    ] })), "TransactionCanceledException");
    assert.equal((await client.send(new GetItemCommand({ TableName: "PartiqlAccounts", Key: { id: { S: "a" } } }))).Item?.balance?.N, "5");
    const transactionRead = await client.send(new ExecuteTransactionCommand({ TransactStatements: [{ Statement: `SELECT id, balance FROM "PartiqlAccounts" WHERE id=?`, Parameters: [{ S: "a" }] }, { Statement: `SELECT * FROM "PartiqlAccounts" WHERE id=?`, Parameters: [{ S: "missing" }] }] }));
    assert.equal(transactionRead.Responses?.[0].Item?.balance?.N, "5"); assert.deepEqual(transactionRead.Responses?.[1], {});
  } finally { client?.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true }); }
});

test("DynamoDB PartiQL plans key alternatives and ranges and supports NULL, ordering, EXISTS, and canonical duplicate keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-partiql-planner-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off"}); let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
    await client.send(new CreateTableCommand({ TableName: "PartiqlPlanner", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }] }));
    await waitForTableActive(client, "PartiqlPlanner");
    const rows = [
      { pk: "a", sk: "b", title: "alpha guide", nullable: { S: "value" } },
      { pk: "z", sk: "a", title: "first", nullable: undefined },
      { pk: "z", sk: "b", title: "second guide", nullable: { NULL: true } },
      { pk: "z", sk: "c", title: "third", nullable: { S: "value" } },
    ];
    for (const row of rows) await client.send(new PutItemCommand({ TableName: "PartiqlPlanner", Item: { pk: { S: row.pk }, sk: { S: row.sk }, title: { S: row.title }, ...(row.nullable ? { nullable: row.nullable } : {}) } }));

    const range = await client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlPlanner" WHERE pk='z' AND sk BETWEEN 'b' AND 'c'`, Limit: 1 }));
    assert.deepEqual(range.Items?.map(item => item.sk.S), ["b"], "sort-key predicates must be applied before the page limit");
    const begins = await client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlPlanner" WHERE pk='z' AND begins_with(sk,'c')`, Limit: 1 }));
    assert.deepEqual(begins.Items?.map(item => item.sk.S), ["c"]);
    const alternatives = await client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlPlanner" WHERE pk='a' OR pk='z' ORDER BY pk DESC, sk ASC`, Limit: 2 }));
    assert.deepEqual(alternatives.Items?.map(item => `${item.pk.S}/${item.sk.S}`), ["z/a", "z/b"]);
    const inValues = await client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlPlanner" WHERE pk IN ['a','z'] ORDER BY pk ASC, sk DESC` }));
    assert.deepEqual(inValues.Items?.map(item => `${item.pk.S}/${item.sk.S}`), ["a/b", "z/c", "z/b", "z/a"]);
    assert.deepEqual((await client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlPlanner" WHERE pk='z' AND contains(title,'guide')` }))).Items?.map(item => item.sk.S), ["b"]);
    assert.deepEqual((await client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlPlanner" WHERE pk='z' AND nullable IS NULL` }))).Items?.map(item => item.sk.S), ["b"]);
    assert.deepEqual((await client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlPlanner" WHERE pk='z' AND nullable IS MISSING` }))).Items?.map(item => item.sk.S), ["a"]);
    assert.deepEqual((await client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlPlanner" WHERE pk='z' AND nullable IS NOT NULL ORDER BY sk` }))).Items?.map(item => item.sk.S), ["a", "c"]);
    const tooMany = Array.from({ length: 51 }, (_, index) => `'p${index}'`).join(",");
    await validation(client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlPlanner" WHERE pk IN [${tooMany}]` })));
    await client.send(new ExecuteTransactionCommand({ TransactStatements: [{ Statement: `EXISTS (SELECT * FROM "PartiqlPlanner" WHERE pk='z' AND sk='b')` }] }));

    await client.send(new CreateTableCommand({ TableName: "PartiqlNumericKeys", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "N" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
    await waitForTableActive(client, "PartiqlNumericKeys");
    await client.send(new PutItemCommand({ TableName: "PartiqlNumericKeys", Item: { id: { N: "1" }, value: { S: "first" } } }));
    await client.send(new PutItemCommand({ TableName: "PartiqlNumericKeys", Item: { id: { N: "1.0" }, value: { S: "second" } } }));
    const numeric = await client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "PartiqlNumericKeys"` })); assert.equal(numeric.Items?.length, 1); assert.equal(numeric.Items?.[0].value.S, "second");
    await validation(client.send(new BatchExecuteStatementCommand({ Statements: [{ Statement: `UPDATE "PartiqlNumericKeys" SET value='a' WHERE id=1` }, { Statement: `UPDATE "PartiqlNumericKeys" SET value='b' WHERE id=1.0` }] })));
  } finally { client?.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true }); }
});

test("DynamoDB PartiQL raw protocol separates statement grammar from request controls and returns modeled validation errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-partiql-wire-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off" }); let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; client = new DynamoDBClient({ endpoint, region: "eu-west-1", credentials });
    await client.send(new CreateTableCommand({ TableName: "PartiqlWire", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
    await waitForTableActive(client, "PartiqlWire");
    for (const id of ["a", "b"]) await client.send(new PutItemCommand({ TableName: "PartiqlWire", Item: { id: { S: id }, score: { N: id === "a" ? "1" : "2" } } }));

    const page = await rawDynamo(endpoint, "ExecuteStatement", { Statement: `SELECT id, score+1 FROM "PartiqlWire"`, Limit: 1 });
    assert.equal(page.status, 200); assert.equal(page.body.Items.length, 1); assert.ok(page.body.LastEvaluatedKey); assert.ok(page.body.NextToken);
    for (const Statement of [`SELECT * FROM "PartiqlWire" LIMIT 1`, `SELECT COUNT(*) FROM "PartiqlWire"`, `SELECT * FROM "PartiqlWire"; DELETE FROM "PartiqlWire" WHERE id='a'`, `SELECT mystery(score) FROM "PartiqlWire"`]) {
      const rejected = await rawDynamo(endpoint, "ExecuteStatement", { Statement });
      assert.equal(rejected.status, 400); assert.match(String(rejected.body.__type), /ValidationException/); assert.ok(rejected.headers.get("x-amzn-requestid"));
    }
    const wrongControl = await rawDynamo(endpoint, "ExecuteStatement", { Statement: `DELETE FROM "PartiqlWire" WHERE id='a'`, Limit: 1 });
    assert.equal(wrongControl.status, 400); assert.match(String(wrongControl.body.__type), /ValidationException/);
    const emptyParameters = await rawDynamo(endpoint, "ExecuteStatement", { Statement: `SELECT * FROM "PartiqlWire"`, Parameters: [] });
    assert.equal(emptyParameters.status, 400); assert.match(String(emptyParameters.body.__type), /ValidationException/);
  } finally { client?.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true }); }
});
