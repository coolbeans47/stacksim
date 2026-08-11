import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CreateTableCommand,
  DeleteItemCommand,
  DescribeTableCommand,
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import { AttachRolePolicyCommand, CreateRoleCommand, GetRoleCommand, IAMClient, UpdateAssumeRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  CreateEventSourceMappingCommand,
  CreateFunctionCommand,
  GetEventSourceMappingCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  UpdateEventSourceMappingCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { CreateDBInstanceCommand, DescribeDBInstancesCommand, RDSClient, StartDBInstanceCommand, type DBInstance } from "@aws-sdk/client-rds";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { expectedInventoryProjection, initialInventory, removedInventoryItemId, updatedInventoryItem } from "./seed-data.js";

const endpoint = process.env.STACKSIM_ENDPOINT ?? "http://127.0.0.1:4566";
const region = process.env.AWS_REGION ?? "eu-west-1";
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "admin",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "password",
};
const common = { endpoint, region, credentials, maxAttempts: 1 };
const rds = new RDSClient(common);
const dynamodb = new DynamoDBClient(common);
const lambda = new LambdaClient(common);
const iam = new IAMClient(common);

const instanceIdentifier = "rds-stream-db";
const databaseName = "stream_projection";
const masterUsername = "stream_writer";
const sourceTableName = "RdsStreamInventory";
const projectionTableName = "inventory_projection";
const roleName = "rds-stream-projector-role";
const functionName = "rds-stream-projector";
const password = process.env.STACKSIM_RDS_STREAM_PASSWORD ?? "LocalStreamSecret123";
const requestedPort = Number(process.env.STACKSIM_RDS_STREAM_PORT ?? "3307");

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function validateConfiguration(): void {
  if (!Number.isInteger(requestedPort) || requestedPort < 1150 || requestedPort > 65_535) throw new Error("STACKSIM_RDS_STREAM_PORT must be an integer from 1150 through 65535");
  if (password.length < 8 || password.length > 41 || /[^\x20-\x7e]/.test(password) || /[\/@\"]/.test(password)) throw new Error("STACKSIM_RDS_STREAM_PASSWORD must satisfy the local RDS master-password rules");
}

async function waitForDatabase(timeoutMs = 45_000): Promise<DBInstance> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const instance = (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: instanceIdentifier }))).DBInstances?.[0];
    if (instance?.DBInstanceStatus === "available") return instance;
    if (instance?.DBInstanceStatus === "failed") throw new Error(instance.StatusInfos?.[0]?.Message ?? `RDS instance ${instanceIdentifier} failed to start`);
    if (instance?.DBInstanceStatus === "deleting") throw new Error(`RDS instance ${instanceIdentifier} is being deleted; wait for deletion to finish before rerunning the seed`);
    await sleep(200);
  }
  throw new Error(`Timed out waiting for RDS instance ${instanceIdentifier}`);
}

async function ensureDatabase(): Promise<DBInstance> {
  const instances = (await rds.send(new DescribeDBInstancesCommand({}))).DBInstances ?? [];
  const existing = instances.find(instance => instance.DBInstanceIdentifier === instanceIdentifier);
  if (instances.length && !existing) {
    const owner = instances.map(instance => instance.DBInstanceIdentifier).join(", ");
    throw new Error(`The local RDS profile permits one installation-wide instance and it is already occupied by ${owner}; this seed will not replace it`);
  }
  if (existing) {
    if (existing.DBName !== databaseName || existing.MasterUsername !== masterUsername) throw new Error(`Existing ${instanceIdentifier} does not match the seed database/user and will not be modified`);
    if (existing.Endpoint?.Port !== requestedPort) throw new Error(`Existing ${instanceIdentifier} uses port ${existing.Endpoint?.Port}; set STACKSIM_RDS_STREAM_PORT to that port or use a fresh simulator data directory`);
    if (existing.DBInstanceStatus === "stopped") await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: instanceIdentifier }));
    return waitForDatabase();
  }
  try {
    await rds.send(new CreateDBInstanceCommand({
      DBInstanceIdentifier: instanceIdentifier,
      DBInstanceClass: "db.t3.micro",
      Engine: "mysql",
      EngineVersion: "8.0",
      AllocatedStorage: 20,
      StorageType: "gp3",
      DBName: databaseName,
      MasterUsername: masterUsername,
      MasterUserPassword: password,
      Port: requestedPort,
      BackupRetentionPeriod: 0,
      PubliclyAccessible: false,
      Tags: [{ Key: "stacksim:seed", Value: "rds-stream" }],
    }));
  } catch (error: any) {
    if (error?.name === "InstanceQuotaExceeded" || error?.name === "InstanceQuotaExceededFault") throw new Error("The installation-wide RDS instance is owned in another Region; this seed will not replace it", { cause: error });
    throw error;
  }
  return waitForDatabase();
}

async function waitForSourceTable(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const table = (await dynamodb.send(new DescribeTableCommand({ TableName: sourceTableName }))).Table;
    if (table?.TableStatus === "ACTIVE" && table.LatestStreamArn && table.StreamSpecification?.StreamEnabled && table.StreamSpecification.StreamViewType === "NEW_AND_OLD_IMAGES") return table;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for DynamoDB stream on ${sourceTableName}`);
}

async function ensureSourceTable() {
  try {
    const table = (await dynamodb.send(new DescribeTableCommand({ TableName: sourceTableName }))).Table;
    if (!table?.StreamSpecification?.StreamEnabled || table.StreamSpecification.StreamViewType !== "NEW_AND_OLD_IMAGES") {
      await dynamodb.send(new UpdateTableCommand({ TableName: sourceTableName, StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" } }));
    }
  } catch (error: any) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    await dynamodb.send(new CreateTableCommand({
      TableName: sourceTableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
      Tags: [{ Key: "stacksim:seed", Value: "rds-stream" }],
    }));
  }
  return waitForSourceTable();
}

async function ensureRole(): Promise<string> {
  const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
  let roleArn: string | undefined;
  try {
    roleArn = (await iam.send(new CreateRoleCommand({ RoleName: roleName, Description: "Projects the seeded DynamoDB stream into local RDS", AssumeRolePolicyDocument: trust, Tags: [{ Key: "stacksim:seed", Value: "rds-stream" }] }))).Role?.Arn;
  } catch (error: any) {
    if (error?.name !== "EntityAlreadyExistsException") throw error;
    roleArn = (await iam.send(new GetRoleCommand({ RoleName: roleName }))).Role?.Arn;
  }
  await iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: roleName, PolicyDocument: trust }));
  await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaDynamoDBExecutionRole" }));
  if (!roleArn) throw new Error(`IAM did not return an ARN for ${roleName}`);
  return roleArn;
}

async function ensureFunction(zip: Uint8Array, roleArn: string, instance: DBInstance): Promise<void> {
  const environment = { Variables: {
    RDS_HOST: instance.Endpoint!.Address!,
    RDS_PORT: String(instance.Endpoint!.Port!),
    RDS_USER: masterUsername,
    RDS_PASSWORD: password,
    RDS_DATABASE: databaseName,
    RDS_TABLE: projectionTableName,
  } };
  try {
    await lambda.send(new CreateFunctionCommand({ FunctionName: functionName, Runtime: "nodejs22.x", Role: roleArn, Handler: "handler.rdsStreamHandler", Timeout: 10, Code: { ZipFile: zip }, Environment: environment, Tags: { "stacksim:seed": "rds-stream" } }));
  } catch (error: any) {
    if (error?.name !== "ResourceConflictException") throw error;
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: functionName, ZipFile: zip }));
    await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: functionName, Runtime: "nodejs22.x", Role: roleArn, Handler: "handler.rdsStreamHandler", Timeout: 10, Environment: environment }));
  }
}

async function ensureEventSourceMapping(streamArn: string): Promise<string> {
  const existing = (await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: functionName, EventSourceArn: streamArn }))).EventSourceMappings?.[0];
  if (existing?.UUID) {
    await lambda.send(new UpdateEventSourceMappingCommand({
      UUID: existing.UUID,
      Enabled: true,
      BatchSize: 10,
      MaximumBatchingWindowInSeconds: 0,
      ParallelizationFactor: 1,
      MaximumRecordAgeInSeconds: -1,
      MaximumRetryAttempts: 3,
      BisectBatchOnFunctionError: false,
      TumblingWindowInSeconds: 0,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      FilterCriteria: { Filters: [] },
    }));
    return existing.UUID;
  }
  const created = await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: functionName, EventSourceArn: streamArn, StartingPosition: "TRIM_HORIZON", BatchSize: 10, ParallelizationFactor: 1, MaximumRetryAttempts: 3, FunctionResponseTypes: ["ReportBatchItemFailures"], Tags: { "stacksim:seed": "rds-stream" } }));
  return created.UUID!;
}

async function writeSeedMutations(): Promise<void> {
  for (const item of initialInventory) {
    await dynamodb.send(new PutItemCommand({ TableName: sourceTableName, Item: { id: { S: item.id }, name: { S: item.name }, quantity: { N: String(item.quantity) } } }));
  }
  await dynamodb.send(new UpdateItemCommand({
    TableName: sourceTableName,
    Key: { id: { S: updatedInventoryItem.id } },
    UpdateExpression: "SET #name = :name, quantity = :quantity",
    ExpressionAttributeNames: { "#name": "name" },
    ExpressionAttributeValues: { ":name": { S: updatedInventoryItem.name }, ":quantity": { N: String(updatedInventoryItem.quantity) } },
  }));
  await dynamodb.send(new DeleteItemCommand({ TableName: sourceTableName, Key: { id: { S: removedInventoryItemId } } }));
}

interface ProjectionRow extends RowDataPacket {
  item_id: string;
  item_name: string;
  quantity: number;
  source_event: string;
}

async function waitForProjection(connection: Connection, mappingUuid: string, timeoutMs = 30_000): Promise<ProjectionRow[]> {
  const ids = [...expectedInventoryProjection.map(item => item.id), removedInventoryItemId];
  const deadline = Date.now() + timeoutMs;
  let lastMappingResult = "No records processed";
  while (Date.now() < deadline) {
    const [rows] = await connection.query<ProjectionRow[]>(`SELECT item_id, item_name, quantity, source_event FROM \`${projectionTableName}\` WHERE item_id IN (?, ?, ?) ORDER BY item_id`, ids);
    const expected = expectedInventoryProjection.every(item => rows.some(row => row.item_id === item.id && row.item_name === item.name && row.quantity === item.quantity));
    const removed = !rows.some(row => row.item_id === removedInventoryItemId);
    if (expected && removed) return rows;
    lastMappingResult = (await lambda.send(new GetEventSourceMappingCommand({ UUID: mappingUuid }))).LastProcessingResult ?? lastMappingResult;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for the RDS projection; event-source mapping reported: ${lastMappingResult}`);
}

async function resetProjectionFixture(connection: Connection): Promise<void> {
  await connection.beginTransaction();
  try {
    await connection.execute(`DELETE FROM \`${projectionTableName}\` WHERE item_id IN (?, ?)`, expectedInventoryProjection.map(item => item.id));
    await connection.execute(
      `INSERT INTO \`${projectionTableName}\` (item_id, item_name, quantity, source_event) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE item_name = VALUES(item_name), quantity = VALUES(quantity), source_event = VALUES(source_event)`,
      [removedInventoryItemId, "Awaiting stream removal", -1, "RESET"],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  }
}

async function deploy(): Promise<void> {
  validateConfiguration();
  let sql: Connection | undefined;
  try {
    const instance = await ensureDatabase();
    sql = await mysql.createConnection({ host: instance.Endpoint!.Address!, port: instance.Endpoint!.Port!, user: masterUsername, password, database: databaseName });
    await sql.execute(`CREATE TABLE IF NOT EXISTS \`${projectionTableName}\` (item_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY, item_name VARCHAR(255) NOT NULL, quantity INT NOT NULL, source_event VARCHAR(8) NOT NULL)`);
    await resetProjectionFixture(sql);
    const source = await ensureSourceTable();
    const roleArn = await ensureRole();
    const zip = await readFile(resolve("examples/lambda/function.zip"));
    await ensureFunction(zip, roleArn, instance);
    const mappingUuid = await ensureEventSourceMapping(source.LatestStreamArn!);
    await writeSeedMutations();
    const rows = await waitForProjection(sql, mappingUuid);
    console.log(`Seeded and verified ${sourceTableName} -> ${functionName} -> ${databaseName}.${projectionTableName} on 127.0.0.1:${instance.Endpoint!.Port}`);
    console.table(rows.map(row => ({ id: row.item_id, name: row.item_name, quantity: row.quantity, sourceEvent: row.source_event })));
  } finally {
    if (sql) await sql.end().catch(() => undefined);
    rds.destroy(); dynamodb.destroy(); lambda.destroy(); iam.destroy();
  }
}

deploy().catch(error => { console.error(error); process.exitCode = 1; });
