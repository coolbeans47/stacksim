import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BatchExecuteStatementCommand, BeginTransactionCommand, CommitTransactionCommand, ExecuteStatementCommand,
  RDSDataClient, RollbackTransactionCommand, type ExecuteStatementCommandInput } from "@aws-sdk/client-rds-data";
import { TestClock } from "../src/core/clock.js";
import { RdsDataService } from "../src/rds/data-api.js";
import { EmbeddedSqliteProvider } from "../src/rds/embedded-sqlite.js";

const access = { resourceArn: "arn:aws:rds:us-east-1:000000000000:cluster:work", secretArn: "arn:aws:secretsmanager:us-east-1:000000000000:secret:work-123456", database: "app" };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "stacksim-data-api-"));
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const provider = new EmbeddedSqliteProvider({ instancesRoot: root });
  const resourceId = "db-abcdef0123456789abcdef0123";
  const config = { resourceId, resourceDir: join(root, resourceId), port, masterUsername: "appuser", masterPassword: "DatabaseTest123", databaseName: "app" };
  await provider.initialize(config);
  await provider.start(config);
  const clock = new TestClock();
  let password = config.masterPassword;
  let waiting: Promise<void> | undefined;
  const service = new RdsDataService(clock, () => ({ generation: resourceId, port, database: "app" }),
    async arn => {
      await waiting;
      return { username: config.masterUsername, password: arn === access.secretArn ? password : "wrong" };
    });
  const server = httpServer((req, res) => void service.handle(req, res, "sdk-request"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const listen = server.address();
  assert.ok(listen && typeof listen === "object");
  const client = new RDSDataClient({ endpoint: `http://127.0.0.1:${listen.port}`, region: "us-east-1", maxAttempts: 1, credentials: { accessKeyId: "admin", secretAccessKey: "local" } });
  t.after(async () => {
    client.destroy(); service.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await provider.stop(); await rm(root, { recursive: true, force: true });
  });
  const execute = (sql: string, options: Partial<ExecuteStatementCommandInput> = {}) =>
    client.send(new ExecuteStatementCommand({ ...access, sql, ...options }));
  const holdSecret = () => {
    let release!: () => void;
    waiting = new Promise<void>(resolve => { release = resolve; });
    return () => { waiting = undefined; release(); };
  };
  return { client, clock, service, execute, holdSecret, replaceSecret: (value: string) => { password = value; } };
}

test("Data API binds typed parameters, encodes SDK typed and JSON results, and enforces limits", async t => {
  const { execute, client } = await fixture(t);
  await execute("CREATE TABLE notes (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(40), active BOOLEAN, payload BLOB, score DOUBLE, amount DECIMAL(10,2), memo TEXT)");
  const inserted = await execute("INSERT INTO notes (title,active,payload,score,amount,memo) VALUES (:t,:a,:p,:s,:d,:m)", { parameters: [
    { name: "t", value: { stringValue: "a ':literal' value" } }, { name: "a", value: { booleanValue: true } },
    { name: "p", value: { blobValue: Uint8Array.from([0, 250, 255]) } }, { name: "s", value: { doubleValue: 2.5 } },
    { name: "d", typeHint: "DECIMAL", value: { stringValue: "14.75" } }, { name: "m", value: { isNull: true } },
  ] });
  assert.equal(inserted.numberOfRecordsUpdated, 1);
  assert.deepEqual(inserted.generatedFields, [{ longValue: 1 }]);
  const sql = "SELECT id,title,active,payload,score,amount,memo,':x?' AS literal FROM notes WHERE id=:id /* :untouched? */";
  const options = { parameters: [{ name: "id", value: { longValue: 1 } }], includeResultMetadata: true };
  const selected = await execute(sql, options);
  assert.deepEqual(selected.records, [[{ longValue: 1 }, { stringValue: "a ':literal' value" }, { booleanValue: true }, { blobValue: Uint8Array.from([0,250,255]) },
    { doubleValue: 2.5 }, { stringValue: "14.75" }, { isNull: true }, { stringValue: ":x?" }]]);
  assert.deepEqual(selected.columnMetadata?.map(column => column.label), ["id","title","active","payload","score","amount","memo","literal"]);
  const duplicate = await execute("SELECT :first AS x, :second AS x", { includeResultMetadata: true, parameters: [
    { name: "first", value: { longValue: 1 } }, { name: "second", value: { stringValue: "two" } },
  ] });
  assert.deepEqual(duplicate.columnMetadata?.map(column => column.label), ["x", "x"]);
  assert.deepEqual(duplicate.records, [[{ longValue: 1 }, { stringValue: "two" }]]);
  await assert.rejects(execute("SELECT 1 AS x, 2 AS x WHERE 1=0", { formatRecordsAs: "JSON" }), { name: "BadRequestException" });
  const formatted = await execute(sql, { ...options, resultSetOptions: { longReturnType: "STRING", decimalReturnType: "DOUBLE_OR_LONG" }, formatRecordsAs: "JSON" });
  assert.equal(formatted.records, undefined);
  assert.equal(formatted.columnMetadata, undefined);
  assert.deepEqual(JSON.parse(formatted.formattedRecords!), [{ id: "1", title: "a ':literal' value", active: true, payload: "APr/", score: 2.5, amount: 14.75, memo: null, literal: ":x?" }]);
  await assert.rejects(execute("SELECT :p", { parameters: [{ name: "p", value: { arrayValue: { longValues: [1] } } }] }), { name: "BadRequestException" });
  await assert.rejects(execute("SELECT 1; SELECT 2"), { name: "DatabaseErrorException" });
  await assert.rejects(execute("SELECT 1", { secretArn: access.secretArn + "bad" }), { name: "InvalidSecretException" });
  await assert.rejects(execute("SELECT :p AS result", { parameters: [{ name: "p", value: { stringValue: "x".repeat(65537) } }] }), { name: "UnsupportedResultException" });
  const bulk = await client.send(new BatchExecuteStatementCommand({ ...access, sql: "INSERT INTO notes (title) VALUES (:title)",
    parameterSets: ["two", "three"].map(title => [{ name: "title", value: { stringValue: title } }]) }));
  assert.deepEqual(bulk.updateResults, [{ generatedFields: [{ longValue: 2 }] }, { generatedFields: [{ longValue: 3 }] }]);
  await execute("CREATE TABLE counters (n BIGINT)");
  await execute("INSERT INTO counters VALUES (9223372036854775807)");
  assert.deepEqual((await execute("SELECT n FROM counters", { resultSetOptions: { longReturnType: "STRING" } })).records, [[{ stringValue: "9223372036854775807" }]]);
  await assert.rejects(execute("SELECT n FROM counters"), { name: "UnsupportedResultException" });
});

test("Data API transactions isolate work and roll back on expiry, cluster invalidation and shutdown", async t => {
  const { execute, client, clock, service, replaceSecret } = await fixture(t);
  await execute("CREATE TABLE events (id INT PRIMARY KEY)");
  const begin = async () => (await client.send(new BeginTransactionCommand(access))).transactionId!;
  const write = (id: number, transactionId: string) => execute("INSERT INTO events VALUES (:id)", { transactionId, parameters: [{ name: "id", value: { longValue: id } }] });
  const rows = async () => (await execute("SELECT id FROM events ORDER BY id")).records;
  const commit = (transactionId: string) => client.send(new CommitTransactionCommand({ ...access, transactionId }));
  const first = await begin();
  await write(1, first);
  assert.deepEqual(await rows(), []);
  assert.equal((await commit(first)).transactionStatus, "Transaction Committed");
  await assert.rejects(commit(first), { name: "TransactionNotFoundException" });
  const rolledBack = await begin();
  await write(2, rolledBack);
  await assert.rejects(execute("DROP TABLE events", { transactionId: rolledBack }), { name: "BadRequestException" });
  await client.send(new RollbackTransactionCommand({ ...access, transactionId: rolledBack }));
  for (const stop of [() => clock.advance(180000), () => service.invalidate(access.resourceArn), () => service.close()]) {
    const id = await begin();
    await write(3, id);
    stop();
    await assert.rejects(commit(id), { name: "TransactionNotFoundException" });
    assert.deepEqual(await rows(), [[{ longValue: 1 }]]);
  }
  const aged = await begin();
  for (let minute = 1; minute < 60; minute++) {
    clock.advance(60_000);
    await execute("SELECT id FROM events", { transactionId: aged });
  }
  clock.advance(60_000);
  await assert.rejects(commit(aged), { name: "TransactionNotFoundException" });

  const scoped = await begin();
  await write(4, scoped);
  for (const different of [{ database: "other" }, { secretArn: access.secretArn + "other" }, { resourceArn: access.resourceArn + "other" }]) {
    await assert.rejects(execute("SELECT 1", { transactionId: scoped, ...different }), { name: "TransactionNotFoundException" });
  }
  const transactionQuery = { ...access, transactionId: scoped, sql: "SELECT id FROM events" };
  const inFlight = service.execute("ExecuteStatement", transactionQuery);
  await assert.rejects(service.execute("ExecuteStatement", transactionQuery), (error: any) => error.code === "DatabaseErrorException");
  await inFlight;
  replaceSecret("ChangedAwayFromWriterPassword");
  await assert.rejects(commit(scoped), { name: "TransactionNotFoundException" });
  replaceSecret("DatabaseTest123");
  await assert.rejects(commit(scoped), { name: "TransactionNotFoundException" });
  assert.deepEqual(await rows(), [[{ longValue: 1 }]]);
});

test("batch validation precedes execution, runtime DML errors preserve transaction semantics and output limits match the format", async t => {
  const { execute, client } = await fixture(t);
  await execute("CREATE TABLE items (id INT PRIMARY KEY, body TEXT)");
  const batch = (ids: number[], transactionId?: string) => client.send(new BatchExecuteStatementCommand({ ...access, transactionId,
    sql: "INSERT INTO items (id) VALUES (:id)", parameterSets: ids.map(id => [{ name: "id", value: { longValue: id } }]) }));
  await assert.rejects(batch([1,1,2]), { name: "DatabaseErrorException" });
  assert.deepEqual((await execute("SELECT id FROM items")).records, [[{ longValue: 1 }]]);
  const transactionId = (await client.send(new BeginTransactionCommand(access))).transactionId!;
  await assert.rejects(batch([2,1,3], transactionId), { name: "DatabaseErrorException" });
  assert.deepEqual((await execute("SELECT id FROM items ORDER BY id", { transactionId })).records, [[{ longValue: 1 }],[{ longValue: 2 }]]);
  await client.send(new RollbackTransactionCommand({ ...access, transactionId }));
  assert.deepEqual((await execute("SELECT id FROM items")).records, [[{ longValue: 1 }]]);
  await assert.rejects(client.send(new BatchExecuteStatementCommand({ ...access, sql: "INSERT INTO items (id) VALUES (:id)",
    parameterSets: [[{ name: "id", value: { longValue: 2 } }], [{ name: "absent", value: { longValue: 3 } }]] })), { name: "BadRequestException" });
  await batch([2]);
  const text = "x".repeat(60 * 1024);
  await client.send(new BatchExecuteStatementCommand({ ...access, sql: "INSERT INTO items VALUES (:id,:body)", parameterSets: Array.from({ length: 20 }, (_, i) =>
    [{ name: "id", value: { longValue: i + 10 } }, { name: "body", value: { stringValue: text } }]) }));
  await assert.rejects(execute("SELECT body FROM items"), { name: "UnsupportedResultException" });
  const formatted = await execute("SELECT body FROM items", { formatRecordsAs: "JSON" });
  assert.equal(JSON.parse(formatted.formattedRecords!).length, 22);
  await assert.rejects(execute("SELECT a.body FROM items a CROSS JOIN items b", { formatRecordsAs: "JSON" }), { name: "UnsupportedResultException" });
  await assert.rejects(execute("INSERT INTO items VALUES (99,:body)", { parameters: [{ name: "body", value: { stringValue: "y".repeat(4 * 1024 * 1024) } }] }));
  assert.deepEqual((await execute("SELECT id FROM items WHERE id=99")).records, []);
});

test("a timed-out Data API request continues only with the explicit continuation option", async t => {
  const { execute, service, clock, holdSecret } = await fixture(t);
  await execute("CREATE TABLE writes (id INT PRIMARY KEY)");
  for (const [id, continueAfterTimeout] of [[1, false], [2, true]] as const) {
    const resume = holdSecret();
    const request = service.execute("ExecuteStatement", { ...access, sql: "INSERT INTO writes VALUES (:id)", parameters: [{ name: "id", value: { longValue: id } }], continueAfterTimeout });
    clock.advance(45000);
    await assert.rejects(request, (error: any) => error.code === "StatementTimeoutException");
    resume();
  }
  const deadline = Date.now() + 2000;
  const read = async () => (await execute("SELECT id FROM writes ORDER BY id")).records;
  let rows = await read();
  while (!rows?.length && Date.now() < deadline) rows = await read();
  assert.deepEqual(rows, [[{ longValue: 2 }]]);
});
