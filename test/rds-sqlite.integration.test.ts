import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppSyncClient, ListApiKeysCommand, ListDataSourcesCommand, ListGraphqlApisCommand, ListResolversCommand } from "@aws-sdk/client-appsync";
import { CreateDBInstanceCommand, CreateDBParameterGroupCommand, DeleteDBInstanceCommand, DescribeDBInstancesCommand, ModifyDBInstanceCommand, ModifyDBParameterGroupCommand, RebootDBInstanceCommand, RDSClient, StartDBInstanceCommand, StopDBInstanceCommand } from "@aws-sdk/client-rds";
import mysql from "mysql2/promise";
import { EmbeddedSqliteProvider } from "../src/rds/embedded-sqlite.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function runMainSeed(endpoint: string, sqlPort: number, password: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    const child = spawn(process.execPath, [join(process.cwd(), "dist/examples/deploy.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STACKSIM_ENDPOINT: endpoint,
        STACKSIM_RDS_PORT: String(sqlPort),
        STACKSIM_RDS_PASSWORD: password,
        AWS_REGION: "eu-west-1",
        AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`seed exited ${code}\n${Buffer.concat(stdout)}\n${Buffer.concat(stderr)}`)));
  });
}

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address(); const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function available(client: RDSClient, identifier: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const instance = (await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }))).DBInstances?.[0];
    if (instance?.DBInstanceStatus === "available") return instance;
    if (instance?.DBInstanceStatus === "failed") assert.fail(instance.StatusInfos?.[0]?.Message ?? "embedded SQLite provider failed");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail("embedded SQLite instance did not become available");
}

async function status(client: RDSClient, identifier: string, expected: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const instance = (await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }))).DBInstances?.[0];
    if (instance?.DBInstanceStatus === expected) return instance;
    if (instance?.DBInstanceStatus === "failed") assert.fail(instance.StatusInfos?.[0]?.Message ?? "embedded SQLite provider failed");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`embedded SQLite instance did not become ${expected}`);
}

async function missing(client: RDSClient, identifier: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier })); }
    catch (error: any) { if (error?.name === "DBInstanceNotFoundFault") return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail("embedded SQLite instance was not deleted");
}

test("embedded SQLite provides durable MySQL-compatible SQL connectivity", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds-sqlite-"));
  const sqlPort = await freePort(); const password = "EmbeddedSqliteSecret123"; const identifier = "sql-integration";
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir, rdsStartupTimeoutMs: 45_000, authMode: "off"});
  let rds: RDSClient | undefined; let connection: mysql.Connection | undefined; let occupied: ReturnType<typeof createServer> | undefined; let running = false;
  try {
    await simulator.start(); running = true;
    rds = new RDSClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials, maxAttempts: 1 });
    await rds.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: identifier, DBInstanceClass: "db.t3.micro", Engine: "mysql", EngineVersion: "8.0", AllocatedStorage: 20, StorageType: "gp3", DBName: "appdb", MasterUsername: "developer", MasterUserPassword: password, Port: sqlPort, BackupRetentionPeriod: 0, PubliclyAccessible: false }));
    const instance = await available(rds, identifier); assert.equal(instance.Endpoint?.Port, sqlPort);
    await assert.rejects(mysql.createConnection({ host: "127.0.0.1", port: sqlPort, user: "developer", password: "wrong-password", database: "appdb" }));
    await assert.rejects(mysql.createConnection({ host: "127.0.0.1", port: sqlPort, user: "root", password: "" }));
    connection = await mysql.createConnection({ host: "127.0.0.1", port: sqlPort, user: "developer", password, database: "appdb" });
    await assert.rejects(connection.query("SHUTDOWN"));
    assert.deepEqual((await connection.query("SELECT 1 AS stillRunning"))[0], [{ stillRunning: 1 }]);
    const resourceId = simulator.store.state.installation.rds.instanceLease?.dbiResourceId;
    assert.ok(resourceId);
    const resourceDir = join(dataDir, "data", "rds", "instances", resourceId);
    await assert.rejects(readFile(join(resourceDir, "run", "bootstrap.sql"), "utf8"), (error: any) => error?.code === "ENOENT");
    assert.doesNotMatch(await readFile(join(resourceDir, "logs", "sqlite.log"), "utf8"), new RegExp(password));
    await connection.execute("CREATE TABLE categories (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL UNIQUE)");
    await connection.execute("CREATE TABLE notes (id INT PRIMARY KEY, category_id INT NOT NULL, body VARCHAR(255) NOT NULL, CONSTRAINT fk_note_category FOREIGN KEY (category_id) REFERENCES categories(id))");
    await connection.execute("CREATE INDEX idx_notes_body ON notes (body)");
    await connection.beginTransaction();
    await connection.execute("INSERT INTO categories (id, name) VALUES (?, ?)", [1, "development"]);
    await connection.execute("INSERT INTO notes (id, category_id, body) VALUES (?, ?, ?)", [1, 1, "before update"]);
    await connection.execute("UPDATE notes SET body = ? WHERE id = ?", ["survives restart", 1]);
    await connection.commit();
    await connection.execute("INSERT INTO notes (id, category_id, body) VALUES (?, ?, ?)", [2, 1, "delete me"]);
    await connection.execute("DELETE FROM notes WHERE id = ?", [2]);
    const [before] = await connection.execute("SELECT n.id, n.body, c.name AS category FROM notes n JOIN categories c ON c.id = n.category_id WHERE n.id = ?", [1]);
    assert.deepEqual(before, [{ id: 1, body: "survives restart", category: "development" }]);
    await connection.end(); connection = undefined; rds.destroy(); rds = undefined;
    await simulator.stop(); running = false;

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, rdsStartupTimeoutMs: 45_000, authMode: "off"});
    await simulator.start(); running = true;
    rds = new RDSClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials, maxAttempts: 1 });
    assert.equal((await available(rds, identifier)).DBInstanceStatus, "available");
    connection = await mysql.createConnection({ host: "127.0.0.1", port: sqlPort, user: "developer", password, database: "appdb" });
    const [after] = await connection.execute("SELECT n.id, n.body, c.name AS category FROM notes n JOIN categories c ON c.id = n.category_id");
    assert.deepEqual(after, [{ id: 1, body: "survives restart", category: "development" }]);
    await connection.end(); connection = undefined;

    const rotatedPassword = "EmbeddedSqliteRotated456";
    await rds.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: identifier, MasterUserPassword: rotatedPassword })); await available(rds, identifier);
    await assert.rejects(mysql.createConnection({ host: "127.0.0.1", port: sqlPort, user: "developer", password, database: "appdb" }));
    connection = await mysql.createConnection({ host: "127.0.0.1", port: sqlPort, user: "developer", password: rotatedPassword, database: "appdb" }); await connection.end(); connection = undefined;
    await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: identifier })); await status(rds, identifier, "stopped");
    await assert.rejects(mysql.createConnection({ host: "127.0.0.1", port: sqlPort, user: "developer", password: rotatedPassword, database: "appdb", connectTimeout: 1_000 }));
    await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: identifier })); await available(rds, identifier);

    await rds.send(new CreateDBParameterGroupCommand({ DBParameterGroupName: "integration-safe", DBParameterGroupFamily: "mysql8.0", Description: "RDS-02 integration parameters" }));
    await rds.send(new ModifyDBParameterGroupCommand({ DBParameterGroupName: "integration-safe", Parameters: [{ ParameterName: "max_connections", ParameterValue: "120", ApplyMethod: "immediate" }] }));
    await rds.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: identifier, DBParameterGroupName: "integration-safe" }));
    await rds.send(new RebootDBInstanceCommand({ DBInstanceIdentifier: identifier })); await available(rds, identifier);
    connection = await mysql.createConnection({ host: "127.0.0.1", port: sqlPort, user: "developer", password: rotatedPassword, database: "appdb" });
    assert.deepEqual((await connection.query("SELECT @@max_connections AS maxConnections"))[0], [{ maxConnections: 120 }]); await connection.end(); connection = undefined;
    await rds.send(new ModifyDBParameterGroupCommand({ DBParameterGroupName: "integration-safe", Parameters: [{ ParameterName: "max_connections", ParameterValue: "130", ApplyMethod: "immediate" }] }));
    connection = await mysql.createConnection({ host: "127.0.0.1", port: sqlPort, user: "developer", password: rotatedPassword, database: "appdb" }); assert.deepEqual((await connection.query("SELECT @@max_connections AS maxConnections, (SELECT body FROM notes WHERE id = 1) AS body"))[0], [{ maxConnections: 130, body: "survives restart" }]); await connection.end(); connection = undefined;

    occupied = createServer(); const collidingPort = await freePort(); await new Promise<void>((resolve, reject) => { occupied!.once("error", reject); occupied!.listen(collidingPort, "127.0.0.1", resolve); });
    await rds.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: identifier, DBPortNumber: collidingPort, ApplyImmediately: true }));
    assert.equal((await available(rds, identifier)).Endpoint?.Port, sqlPort); await new Promise<void>((resolve, reject) => occupied!.close(error => error ? reject(error) : resolve())); occupied = undefined;
    const movedPort = await freePort(); await rds.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: identifier, DBPortNumber: movedPort, ApplyImmediately: true })); assert.equal((await available(rds, identifier)).Endpoint?.Port, movedPort);
    await assert.rejects(mysql.createConnection({ host: "127.0.0.1", port: sqlPort, user: "developer", password: rotatedPassword, database: "appdb", connectTimeout: 1_000 }));
    connection = await mysql.createConnection({ host: "127.0.0.1", port: movedPort, user: "developer", password: rotatedPassword, database: "appdb" }); assert.deepEqual((await connection.query("SELECT body FROM notes WHERE id = 1"))[0], [{ body: "survives restart" }]); await connection.end(); connection = undefined;
    const controlState = await readFile(join(dataDir, "state.json"), "utf8"); assert.doesNotMatch(controlState, new RegExp(password)); assert.doesNotMatch(controlState, new RegExp(rotatedPassword));
    await rds.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: identifier, SkipFinalSnapshot: true }));
    await missing(rds, identifier);

    const noDefaultPort = await freePort(); const noDefaultPassword = "NoDefaultDatabaseSecret123";
    await rds.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "no-default-database", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "developer", MasterUserPassword: noDefaultPassword, Port: noDefaultPort }));
    const noDefault = await available(rds, "no-default-database");
    assert.equal(noDefault.DBName, undefined);
    connection = await mysql.createConnection({ host: "127.0.0.1", port: noDefaultPort, user: "developer", password: noDefaultPassword });
    const [currentDatabase] = await connection.execute("SELECT DATABASE() AS currentDatabase");
    assert.deepEqual(currentDatabase, [{ currentDatabase: null }]);
    const [databases] = await connection.execute("SHOW DATABASES");
    assert.equal((databases as Array<{ Database: string }>).some(row => row.Database === "stacksim"), false);
    await connection.execute("CREATE DATABASE developer_created");
    await connection.query("USE developer_created");
    await connection.execute("CREATE TABLE smoke_test (id INT PRIMARY KEY)");
    await connection.end(); connection = undefined;
    await rds.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: "no-default-database", SkipFinalSnapshot: true }));
    await missing(rds, "no-default-database");
  } finally {
    connection?.destroy(); rds?.destroy(); if (occupied?.listening) await new Promise<void>(resolve => occupied!.close(() => resolve())); if (running) await simulator.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("embedded SQLite authenticates and recovers its exact orphan", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds-orphan-"));
  const instancesRoot = join(dataDir, "rds", "instances");
  const resourceId = "db-abcdef0123456789abcdef0123";
  const config = {
    resourceId,
    resourceDir: join(instancesRoot, resourceId),
    databaseName: "appdb",
    masterUsername: "developer",
    masterPassword: "OrphanRecoverySecret123",
    port: await freePort(),
  };
  const options = { instancesRoot, startupTimeoutMs: 45_000 };
  const original = new EmbeddedSqliteProvider(options);
  const adopter = new EmbeddedSqliteProvider(options);
  try {
    await original.initialize(config);
    assert.equal((await original.start(config)).ready, true);
    assert.equal((await adopter.start(config)).ready, true);
    assert.equal((await adopter.readiness(config)).ready, true);
    await adopter.destroy(config);
    assert.deepEqual(await readdir(instancesRoot), []);
  } finally {
    await adopter.stop().catch(() => undefined);
    await original.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the main seed idempotently creates the AppSync API and assigned bug-ticket RDS data", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds-main-seed-"));
  const sqlPort = await freePort(); const password = "MainSeedSecret123";
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", rdsStartupTimeoutMs: 45_000, authMode: "off"});
  let appsync: AppSyncClient | undefined; let rds: RDSClient | undefined; let connection: mysql.Connection | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    await runMainSeed(endpoint, sqlPort, password);
    await runMainSeed(endpoint, sqlPort, password);
    appsync = new AppSyncClient({ endpoint, region: "eu-west-1", credentials, maxAttempts: 1 });
    const seededApis = (await appsync.send(new ListGraphqlApisCommand({}))).graphqlApis
      ?.filter(api => api.name === "learning-notes-api") ?? [];
    assert.equal(seededApis.length, 1);
    const seededApi = seededApis[0];
    assert.equal(seededApi.tags?.["stacksim:seed"], "true");
    assert.deepEqual(
      (await appsync.send(new ListDataSourcesCommand({ apiId: seededApi.apiId }))).dataSources?.map(source => [
        source.name,
        source.type,
        source.dynamodbConfig?.tableName,
      ]),
      [["LearningNotes", "AMAZON_DYNAMODB", "LearningNotes"]],
    );
    assert.deepEqual(
      (await appsync.send(new ListResolversCommand({ apiId: seededApi.apiId, typeName: "Query" }))).resolvers
        ?.map(resolver => resolver.fieldName).sort(),
      ["getNote", "listNotes", "notesByCategory"],
    );
    assert.deepEqual(
      (await appsync.send(new ListResolversCommand({ apiId: seededApi.apiId, typeName: "Mutation" }))).resolvers
        ?.map(resolver => resolver.fieldName).sort(),
      ["deleteNote", "saveNote"],
    );
    const seededKeys = (await appsync.send(new ListApiKeysCommand({ apiId: seededApi.apiId }))).apiKeys
      ?.filter(key => key.description === "Seeded API key for npm run seed") ?? [];
    assert.equal(seededKeys.length, 1);
    const graphql = async (query: string, variables?: Record<string, unknown>): Promise<any> => {
      const response = await fetch(seededApi.uris!.GRAPHQL!, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": seededKeys[0].id! },
        body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const firstPage = await graphql("query { listNotes(limit: 2) { items { id title } nextToken scannedCount } }");
    assert.equal(firstPage.data.listNotes.items.length, 2);
    assert.equal(firstPage.data.listNotes.scannedCount, 2);
    assert.equal(typeof firstPage.data.listNotes.nextToken, "string");
    assert.deepEqual(await graphql(
      "mutation Save($input: NoteInput!) { saveNote(input: $input) { id title category completed priority } }",
      { input: { id: "graphql-seed-test", title: "Created through AppSync", body: "Resolver path works", category: "development", completed: false, priority: 6 } },
    ), {
      data: {
        saveNote: {
          id: "graphql-seed-test",
          title: "Created through AppSync",
          category: "development",
          completed: false,
          priority: 6,
        },
      },
    });
    assert.deepEqual(await graphql(
      "query Get($id: ID!) { getNote(id: $id) { id body } }",
      { id: "graphql-seed-test" },
    ), { data: { getNote: { id: "graphql-seed-test", body: "Resolver path works" } } });

    rds = new RDSClient({ endpoint, region: "eu-west-1", credentials, maxAttempts: 1 });
    const instance = await available(rds, "learning-db");
    assert.equal(instance.DBName, "learning_app");
    assert.equal(instance.MasterUsername, "learning_admin");
    assert.equal(instance.Endpoint?.Port, sqlPort);
    connection = await mysql.createConnection({ host: "127.0.0.1", port: sqlPort, user: "learning_admin", password, database: "learning_app" });
    assert.deepEqual((await connection.query("SELECT COUNT(*) AS userCount FROM bug_users"))[0], [{ userCount: 6 }]);
    assert.deepEqual((await connection.query("SELECT COUNT(*) AS ticketCount FROM bug_tickets"))[0], [{ ticketCount: 12 }]);
    assert.deepEqual((await connection.query("SELECT COUNT(*) AS assignedCount FROM bug_tickets WHERE assignee_id IS NOT NULL"))[0], [{ assignedCount: 11 }]);
    assert.deepEqual((await connection.query("SELECT COUNT(*) AS resolvedCount FROM bug_tickets WHERE resolved_at IS NOT NULL"))[0], [{ resolvedCount: 2 }]);
    assert.deepEqual((await connection.query("SELECT t.ticket_id AS ticketId, t.ticket_status AS ticketStatus, t.severity, assignee.display_name AS assignee, reporter.display_name AS reporter FROM bug_tickets t LEFT JOIN bug_users assignee ON assignee.user_id = t.assignee_id JOIN bug_users reporter ON reporter.user_id = t.reporter_id ORDER BY t.ticket_id"))[0], [
      { ticketId: "BUG-101", ticketStatus: "IN_PROGRESS", severity: "HIGH", assignee: "Maya Chen", reporter: "Amina Yusuf" },
      { ticketId: "BUG-102", ticketStatus: "OPEN", severity: "MEDIUM", assignee: "Theo Martin", reporter: "Noah Williams" },
      { ticketId: "BUG-103", ticketStatus: "TRIAGE", severity: "CRITICAL", assignee: "Priya Shah", reporter: "Priya Shah" },
      { ticketId: "BUG-104", ticketStatus: "IN_PROGRESS", severity: "HIGH", assignee: "Lucas Garcia", reporter: "Amina Yusuf" },
      { ticketId: "BUG-105", ticketStatus: "READY", severity: "MEDIUM", assignee: "Maya Chen", reporter: "Noah Williams" },
      { ticketId: "BUG-106", ticketStatus: "OPEN", severity: "LOW", assignee: "Theo Martin", reporter: "Noah Williams" },
      { ticketId: "BUG-107", ticketStatus: "INVESTIGATING", severity: "HIGH", assignee: "Priya Shah", reporter: "Priya Shah" },
      { ticketId: "BUG-108", ticketStatus: "RESOLVED", severity: "HIGH", assignee: "Maya Chen", reporter: "Amina Yusuf" },
      { ticketId: "BUG-109", ticketStatus: "OPEN", severity: "MEDIUM", assignee: "Theo Martin", reporter: "Amina Yusuf" },
      { ticketId: "BUG-110", ticketStatus: "TRIAGE", severity: "CRITICAL", assignee: "Amina Yusuf", reporter: "Amina Yusuf" },
      { ticketId: "BUG-111", ticketStatus: "BACKLOG", severity: "LOW", assignee: null, reporter: "Maya Chen" },
      { ticketId: "BUG-112", ticketStatus: "RESOLVED", severity: "MEDIUM", assignee: "Lucas Garcia", reporter: "Noah Williams" },
    ]);

    const objectsUrl = `${endpoint}/_stacksim/api/rds/query-editor/learning-db/objects?database=learning_app`;
    const objectsResponse = await fetch(objectsUrl, { headers: { "x-stacksim-region": "eu-west-1" } });
    const objectsBody = await objectsResponse.json() as any;
    assert.equal(objectsResponse.status, 200, JSON.stringify(objectsBody));
    assert.deepEqual(objectsBody.databases, ["learning_app"]);
    assert.equal(objectsBody.selectedDatabase, "learning_app");
    assert.deepEqual(objectsBody.objects.map((object: any) => [object.name, object.type]), [
      ["bug_tickets", "table"],
      ["bug_users", "table"],
    ]);
    assert.deepEqual(objectsBody.objects.find((object: any) => object.name === "bug_users")?.columns, [
      { name: "user_id", type: "VARCHAR(32)", nullable: false, primaryKey: true, defaultValue: null },
      { name: "display_name", type: "VARCHAR(128)", nullable: false, primaryKey: false, defaultValue: null },
      { name: "email", type: "VARCHAR(255)", nullable: false, primaryKey: false, defaultValue: null },
      { name: "team", type: "VARCHAR(64)", nullable: false, primaryKey: false, defaultValue: null },
      { name: "user_role", type: "VARCHAR(64)", nullable: false, primaryKey: false, defaultValue: null },
      { name: "active", type: "BOOLEAN", nullable: false, primaryKey: false, defaultValue: null },
      { name: "created_at", type: "DATETIME", nullable: false, primaryKey: false, defaultValue: null },
    ]);
    assert.deepEqual(
      objectsBody.objects.find((object: any) => object.name === "bug_tickets")?.columns.find((column: any) => column.name === "assignee_id"),
      { name: "assignee_id", type: "VARCHAR(32)", nullable: true, primaryKey: false, defaultValue: null },
    );
    assert.doesNotMatch(JSON.stringify(objectsBody), new RegExp(password));
    assert.doesNotMatch(JSON.stringify(objectsBody), /\.sqlite|masterPassword|resourceDir/);

    const queryUrl = `${endpoint}/_stacksim/api/rds/query-editor/learning-db/query`;
    const queryHeaders = {
      "content-type": "application/json",
      "x-stacksim-console-request": "1",
      "x-stacksim-region": "eu-west-1",
      origin: endpoint,
    };
    const runQuery = async (sql: string): Promise<{ response: Response; body: any }> => {
      const response = await fetch(queryUrl, {
        method: "POST",
        headers: queryHeaders,
        body: JSON.stringify({ database: "learning_app", sql }),
      });
      return { response, body: await response.json() };
    };

    const selected = await runQuery("SELECT t.ticket_id, t.title, t.ticket_status, u.display_name AS assignee FROM bug_tickets t LEFT JOIN bug_users u ON u.user_id = t.assignee_id ORDER BY t.ticket_id LIMIT 3");
    assert.equal(selected.response.status, 200, JSON.stringify(selected.body));
    assert.deepEqual({
      columns: selected.body.columns,
      rows: selected.body.rows,
      rowCount: selected.body.rowCount,
      truncated: selected.body.truncated,
    }, {
      columns: ["ticket_id", "title", "ticket_status", "assignee"],
      rows: [
        ["BUG-101", "Sessions expire while users are actively editing", "IN_PROGRESS", "Maya Chen"],
        ["BUG-102", "Dashboard cards overflow on Safari", "OPEN", "Theo Martin"],
        ["BUG-103", "Webhook retries create duplicate deliveries", "TRIAGE", "Priya Shah"],
      ],
      rowCount: 3,
      truncated: false,
    });
    assert.equal(typeof selected.body.elapsedMs, "number");
    assert.ok(selected.body.elapsedMs >= 0);

    const updated = await runQuery("UPDATE bug_tickets SET ticket_status = 'IN_PROGRESS', assignee_id = 'USR-001' WHERE ticket_id = 'BUG-111'");
    assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.affectedRows, 1);
    const updatedRow = await runQuery("SELECT ticket_id, ticket_status, assignee_id FROM bug_tickets WHERE ticket_id = 'BUG-111'");
    assert.equal(updatedRow.response.status, 200, JSON.stringify(updatedRow.body));
    assert.deepEqual(updatedRow.body.rows, [["BUG-111", "IN_PROGRESS", "USR-001"]]);

    const capped = await runQuery("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 501) SELECT n FROM seq ORDER BY n");
    assert.equal(capped.response.status, 200, JSON.stringify(capped.body));
    assert.deepEqual(capped.body.columns, ["n"]);
    assert.equal(capped.body.rows.length, 500);
    assert.deepEqual(capped.body.rows[0], [1]);
    assert.deepEqual(capped.body.rows[499], [500]);
    assert.equal(capped.body.rowCount, 501);
    assert.equal(capped.body.truncated, true);

    const missingIntentResponse = await fetch(queryUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-stacksim-region": "eu-west-1", origin: endpoint },
      body: JSON.stringify({ database: "learning_app", sql: "SELECT 1" }),
    });
    const missingIntentBody = await missingIntentResponse.json() as any;
    assert.equal(missingIntentResponse.status, 403);
    assert.equal(missingIntentBody.code, "InvalidConsoleRequest");

    const foreignOriginResponse = await fetch(queryUrl, {
      method: "POST",
      headers: { ...queryHeaders, origin: "https://example.test" },
      body: JSON.stringify({ database: "learning_app", sql: "SELECT 1" }),
    });
    const foreignOriginBody = await foreignOriginResponse.json() as any;
    assert.equal(foreignOriginResponse.status, 403);
    assert.equal(foreignOriginBody.code, "InvalidConsoleRequest");

    const contentTypeResponse = await fetch(queryUrl, {
      method: "POST",
      headers: { ...queryHeaders, "content-type": "text/plain" },
      body: JSON.stringify({ database: "learning_app", sql: "SELECT 1" }),
    });
    const contentTypeBody = await contentTypeResponse.json() as any;
    assert.equal(contentTypeResponse.status, 415);
    assert.equal(contentTypeBody.code, "InvalidConsoleRequest");

    for (const sql of ["ATTACH DATABASE ':memory:' AS forbidden", "PRAGMA database_list"]) {
      const blocked = await runQuery(sql);
      assert.equal(blocked.response.status, 400, JSON.stringify(blocked.body));
      assert.equal(blocked.body.code, "InvalidParameterValue");
    }

    const invalid = await runQuery(`SELECT ${password} FROM bug_tickets`);
    assert.equal(invalid.response.status, 400, JSON.stringify(invalid.body));
    assert.equal(invalid.body.code, "InvalidQuery");
    assert.doesNotMatch(JSON.stringify(invalid.body), new RegExp(password));
    assert.doesNotMatch(JSON.stringify(invalid.body), /\.sqlite|masterPassword|resourceDir/);
  } finally {
    connection?.destroy(); appsync?.destroy(); rds?.destroy(); await simulator.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
