import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateTableCommand, DeleteItemCommand, DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { CreateEventSourceMappingCommand, CreateFunctionCommand, GetEventSourceMappingCommand, GetFunctionCommand, LambdaClient, ListEventSourceMappingsCommand, UpdateEventSourceMappingCommand } from "@aws-sdk/client-lambda";
import { CreateDBInstanceCommand, DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import mysql, { type Connection } from "mysql2/promise";
import { expectedInventoryProjection, initialInventory, removedInventoryItemId, updatedInventoryItem } from "../examples/rds-stream/seed-data.js";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function available(client: RDSClient, identifier: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const instance = (await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }))).DBInstances?.[0];
    if (instance?.DBInstanceStatus === "available") return instance;
    if (instance?.DBInstanceStatus === "failed") assert.fail(instance.StatusInfos?.[0]?.Message ?? "embedded RDS provider failed");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail("embedded RDS instance did not become available");
}

async function progress<T>(clock: TestClock, read: () => T | Promise<T>, accept: (value: T) => boolean, iterations = 600): Promise<T> {
  for (let index = 0; index < iterations; index++) {
    clock.advance(250);
    await new Promise(resolve => setTimeout(resolve, 25));
    const value = await read();
    if (accept(value)) return value;
  }
  throw new Error("Timed out waiting for the DynamoDB stream Lambda to update RDS");
}

async function runSeed(endpoint: string, sqlPort: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    const child = spawn(process.execPath, [join(process.cwd(), "dist/examples/rds-stream/deploy.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STACKSIM_ENDPOINT: endpoint,
        STACKSIM_RDS_STREAM_PORT: String(sqlPort),
        STACKSIM_RDS_STREAM_PASSWORD: "LocalStreamSecret123",
        AWS_REGION: region,
        AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`seed:rds-stream exited ${code}\n${Buffer.concat(stdout)}\n${Buffer.concat(stderr)}`)));
  });
}

test("a DynamoDB stream Lambda mirrors seeded INSERT, MODIFY, and REMOVE records into RDS", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-rds-stream-lambda-"));
  const clock = new TestClock(Date.parse("2026-07-19T12:00:00Z"));
  const sqlPort = await freePort();
  const password = "StreamLambdaSecret123";
  const database = "stream_app";
  const tableName = "stream_inventory";
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, rdsStartupTimeoutMs: 45_000, authMode: "off"});
  const clients: Array<{ destroy(): void }> = [];
  let sql: Connection | undefined;
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const rds = new RDSClient(options); const dynamodb = new DynamoDBClient(options); const lambda = new LambdaClient(options);
    clients.push(rds, dynamodb, lambda);

    await rds.send(new CreateDBInstanceCommand({
      DBInstanceIdentifier: "stream-lambda-db",
      DBInstanceClass: "db.t3.micro",
      Engine: "mysql",
      EngineVersion: "8.0",
      AllocatedStorage: 20,
      StorageType: "gp3",
      DBName: database,
      MasterUsername: "developer",
      MasterUserPassword: password,
      Port: sqlPort,
      BackupRetentionPeriod: 0,
      PubliclyAccessible: false,
    }));
    const instance = await available(rds, "stream-lambda-db");
    sql = await mysql.createConnection({ host: instance.Endpoint!.Address!, port: instance.Endpoint!.Port!, user: "developer", password, database });
    await sql.execute(`CREATE TABLE \`${tableName}\` (item_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY, item_name VARCHAR(255) NOT NULL, quantity INT NOT NULL, source_event VARCHAR(8) NOT NULL)`);
    await sql.execute(`INSERT INTO \`${tableName}\` (item_id, item_name, quantity, source_event) VALUES (?, ?, ?, ?)`, [removedInventoryItemId, "Awaiting stream removal", -1, "RESET"]);

    const source = await dynamodb.send(new CreateTableCommand({
      TableName: "StreamInventorySource",
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
    }));
    await waitForTableActive(dynamodb, "StreamInventorySource", clock);
    const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    await lambda.send(new CreateFunctionCommand({
      FunctionName: "stream-to-rds",
      Runtime: "nodejs22.x",
      Role: "arn:aws:iam::000000000000:role/test",
      Handler: "handler.rdsStreamHandler",
      Timeout: 10,
      Code: { ZipFile: zip },
      Environment: { Variables: {
        RDS_HOST: instance.Endpoint!.Address!,
        RDS_PORT: String(instance.Endpoint!.Port!),
        RDS_USER: "developer",
        RDS_PASSWORD: password,
        RDS_DATABASE: database,
        RDS_TABLE: tableName,
      } },
    }));
    clock.advance(0);
    await new Promise(resolve => setImmediate(resolve));
    const mapping = await lambda.send(new CreateEventSourceMappingCommand({
      FunctionName: "stream-to-rds",
      EventSourceArn: source.TableDescription!.LatestStreamArn!,
      StartingPosition: "TRIM_HORIZON",
      BatchSize: 10,
      MaximumRetryAttempts: 0,
    }));

    for (const item of initialInventory) await dynamodb.send(new PutItemCommand({ TableName: "StreamInventorySource", Item: { id: { S: item.id }, name: { S: item.name }, quantity: { N: String(item.quantity) } } }));
    await dynamodb.send(new PutItemCommand({ TableName: "StreamInventorySource", Item: { id: { S: "Widget" }, name: { S: "Case-sensitive Widget" }, quantity: { N: "11" } } }));
    await dynamodb.send(new UpdateItemCommand({
      TableName: "StreamInventorySource",
      Key: { id: { S: updatedInventoryItem.id } },
      UpdateExpression: "SET #name = :name, quantity = :quantity",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: { ":name": { S: updatedInventoryItem.name }, ":quantity": { N: String(updatedInventoryItem.quantity) } },
    }));
    await dynamodb.send(new DeleteItemCommand({ TableName: "StreamInventorySource", Key: { id: { S: removedInventoryItemId } } }));

    const processingResult = await progress(clock, async () => (await lambda.send(new GetEventSourceMappingCommand({ UUID: mapping.UUID! }))).LastProcessingResult, result => result === "OK" || result === "Retry attempts exhausted");
    assert.equal(processingResult, "OK");
    const mappingView = await lambda.send(new GetEventSourceMappingCommand({ UUID: mapping.UUID! }));
    assert.equal(mappingView.State, "Enabled");
    assert.equal(mappingView.FunctionArn?.endsWith(":function:stream-to-rds"), true);

    const [rows] = await sql.query("SELECT item_id, item_name, quantity, source_event FROM stream_inventory ORDER BY BINARY item_id");
    assert.deepEqual(rows, [
      { item_id: "Widget", item_name: "Case-sensitive Widget", quantity: 11, source_event: "INSERT" },
      { item_id: expectedInventoryProjection[0].id, item_name: expectedInventoryProjection[0].name, quantity: expectedInventoryProjection[0].quantity, source_event: "INSERT" },
      { item_id: expectedInventoryProjection[1].id, item_name: expectedInventoryProjection[1].name, quantity: expectedInventoryProjection[1].quantity, source_event: "MODIFY" },
    ]);
  } finally {
    if (sql) await sql.end().catch(() => undefined);
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("the RDS stream seed is idempotent for a custom account and reconciles its event mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-rds-stream-seed-"));
  const sqlPort = await freePort();
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, accountId: "123456789012", authMode: "enforce", cdkBootstrap: true, rdsStartupTimeoutMs: 45_000 });
  let lambda: LambdaClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    await runSeed(endpoint, sqlPort);
    lambda = new LambdaClient({ endpoint, region, credentials, maxAttempts: 1 });
    const configuration = (await lambda.send(new GetFunctionCommand({ FunctionName: "rds-stream-projector" }))).Configuration;
    assert.equal(configuration?.Role, "arn:aws:iam::123456789012:role/rds-stream-projector-role");
    const mapping = (await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: "rds-stream-projector" }))).EventSourceMappings?.[0];
    assert.ok(mapping?.UUID);
    await lambda.send(new UpdateEventSourceMappingCommand({
      UUID: mapping.UUID,
      Enabled: false,
      BatchSize: 1,
      ParallelizationFactor: 2,
      MaximumRetryAttempts: 0,
      FunctionResponseTypes: [],
      FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ dynamodb: { NewImage: { kind: { S: ["never"] } } } }) }] },
    }));

    await runSeed(endpoint, sqlPort);
    const reconciled = await lambda.send(new GetEventSourceMappingCommand({ UUID: mapping.UUID }));
    assert.equal(reconciled.BatchSize, 10);
    assert.equal(reconciled.MaximumBatchingWindowInSeconds, 0);
    assert.equal(reconciled.ParallelizationFactor, 1);
    assert.equal(reconciled.MaximumRecordAgeInSeconds, -1);
    assert.equal(reconciled.MaximumRetryAttempts, 3);
    assert.equal(reconciled.BisectBatchOnFunctionError, false);
    assert.equal(reconciled.TumblingWindowInSeconds, 0);
    assert.deepEqual(reconciled.FunctionResponseTypes, ["ReportBatchItemFailures"]);
    assert.equal(reconciled.FilterCriteria, undefined);
  } finally {
    lambda?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
