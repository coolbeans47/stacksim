import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BatchWriteItemCommand,
  CreateGlobalTableCommand,
  CreateTableCommand,
  DeleteItemCommand,
  DeleteResourcePolicyCommand,
  DescribeGlobalTableCommand,
  DescribeGlobalTableSettingsCommand,
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  ListGlobalTablesCommand,
  PutItemCommand,
  PutResourcePolicyCommand,
  TransactWriteItemsCommand,
  UpdateGlobalTableCommand,
  UpdateGlobalTableSettingsCommand,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { assertPrivateFile } from "./support/platform.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const westRegion = "eu-west-1";
const eastRegion = "us-east-1";

function client(simulator: StackSim, region: string): DynamoDBClient { return new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }); }
function tableInput(name: string, streams = false): any { return { TableName: name, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], ...(streams ? { StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" } } : {}) }; }
async function settle(): Promise<void> { await new Promise(resolve => setImmediate(resolve)); }

test("current global tables backfill and replicate every write path with deterministic LWW across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-global-current-")); const clock = new TestClock(Date.parse("2026-07-15T22:00:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off"}); let west: DynamoDBClient | undefined; let east: DynamoDBClient | undefined;
  try {
    await simulator.start(); west = client(simulator, westRegion); east = client(simulator, eastRegion); await west.send(new CreateTableCommand(tableInput("GlobalRecords", true))); clock.advance(100); await settle(); await west.send(new PutItemCommand({ TableName: "GlobalRecords", Item: { id: { S: "backfill" }, value: { S: "before" } } }));
    const creating = await west.send(new UpdateTableCommand({ TableName: "GlobalRecords", ReplicaUpdates: [{ Create: { RegionName: eastRegion } }], MultiRegionConsistency: "EVENTUAL" })); assert.equal(creating.TableDescription?.TableStatus, "UPDATING"); clock.advance(50); await settle();
    const described = await west.send(new DescribeTableCommand({ TableName: "GlobalRecords" })); assert.equal(described.Table?.GlobalTableVersion, "2019.11.21"); assert.deepEqual(described.Table?.Replicas?.map(replica => replica.RegionName).sort(), [westRegion, eastRegion].sort()); assert.equal((await east.send(new GetItemCommand({ TableName: "GlobalRecords", Key: { id: { S: "backfill" } } }))).Item?.value?.S, "before");
    assert.equal((await west.send(new DescribeGlobalTableCommand({ GlobalTableName: "GlobalRecords" }))).GlobalTableDescription?.GlobalTableStatus, "ACTIVE"); assert.deepEqual((await west.send(new ListGlobalTablesCommand({ RegionName: eastRegion }))).GlobalTables?.[0].ReplicationGroup?.map(replica => replica.RegionName).sort(), [westRegion, eastRegion].sort());

    clock.advance(1); await west.send(new PutItemCommand({ TableName: "GlobalRecords", Item: { id: { S: "single" }, value: { S: "west" } } })); assert.equal((await east.send(new GetItemCommand({ TableName: "GlobalRecords", Key: { id: { S: "single" } } }))).Item?.value?.S, "west");
    await east.send(new PutItemCommand({ TableName: "GlobalRecords", Item: { id: { S: "single" }, value: { S: "east-wins-same-timestamp" } } })); assert.equal((await west.send(new GetItemCommand({ TableName: "GlobalRecords", Key: { id: { S: "single" } } }))).Item?.value?.S, "east-wins-same-timestamp");
    await west.send(new BatchWriteItemCommand({ RequestItems: { GlobalRecords: [{ PutRequest: { Item: { id: { S: "batch" }, value: { N: "1" } } } }] } })); assert.equal((await east.send(new GetItemCommand({ TableName: "GlobalRecords", Key: { id: { S: "batch" } } }))).Item?.value?.N, "1");
    await east.send(new TransactWriteItemsCommand({ TransactItems: [{ Put: { TableName: "GlobalRecords", Item: { id: { S: "transaction" }, value: { N: "2" } } } }] })); assert.equal((await west.send(new GetItemCommand({ TableName: "GlobalRecords", Key: { id: { S: "transaction" } } }))).Item?.value?.N, "2");
    clock.advance(1); await east.send(new DeleteItemCommand({ TableName: "GlobalRecords", Key: { id: { S: "batch" } } })); assert.equal((await west.send(new GetItemCommand({ TableName: "GlobalRecords", Key: { id: { S: "batch" } } }))).Item, undefined);
    const eastArn = "arn:aws:dynamodb:us-east-1:000000000000:table/GlobalRecords"; const denied = await east.send(new PutResourcePolicyCommand({ ResourceArn: eastArn, ExpectedRevisionId: "NO_POLICY", Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: "*", Action: "dynamodb:PutItem", Resource: eastArn }] }) })); clock.advance(1); await west.send(new PutItemCommand({ TableName: "GlobalRecords", Item: { id: { S: "policy-blocked" } } })); assert.equal((await east.send(new GetItemCommand({ TableName: "GlobalRecords", Key: { id: { S: "policy-blocked" } } }))).Item, undefined); const degraded = await west.send(new DescribeGlobalTableCommand({ GlobalTableName: "GlobalRecords" })); assert.equal(degraded.GlobalTableDescription?.ReplicationGroup?.find(replica => replica.RegionName === eastRegion)?.ReplicaStatus, "REGION_DISABLED"); assert.match(degraded.GlobalTableDescription?.ReplicationGroup?.find(replica => replica.RegionName === eastRegion)?.ReplicaStatusDescription ?? "", /not authorized/); clock.advance(15_000); await east.send(new DeleteResourcePolicyCommand({ ResourceArn: eastArn, ExpectedRevisionId: denied.RevisionId })); clock.advance(1); await west.send(new PutItemCommand({ TableName: "GlobalRecords", Item: { id: { S: "policy-recovered" } } })); assert.ok((await east.send(new GetItemCommand({ TableName: "GlobalRecords", Key: { id: { S: "policy-recovered" } } }))).Item);

    const tableId = createHash("sha256").update("GlobalRecords").digest("hex"); const logPath = join(root, "data", "dynamodb", "global-tables", "000000000000", tableId, "segment-000001.jsonl"); const lines = (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)); assert.deepEqual(lines.map(entry => entry.ordinal), lines.map((_: any, index: number) => index + 1)); await assertPrivateFile(logPath);
    west.destroy(); east.destroy(); west = undefined; east = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off"}); await simulator.start(); west = client(simulator, westRegion); east = client(simulator, eastRegion); assert.equal((await east.send(new GetItemCommand({ TableName: "GlobalRecords", Key: { id: { S: "transaction" } } }))).Item?.value?.N, "2"); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    await west.send(new UpdateTableCommand({ TableName: "GlobalRecords", ReplicaUpdates: [{ Delete: { RegionName: eastRegion } }] })); clock.advance(50); await settle(); await assert.rejects(east.send(new DescribeTableCommand({ TableName: "GlobalRecords" })), (error: any) => error.name === "ResourceNotFoundException"); assert.equal((await west.send(new DescribeTableCommand({ TableName: "GlobalRecords" }))).Table?.GlobalTableVersion, undefined);
  } finally { west?.destroy(); east?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("legacy global-table controls validate replicas, page inventory, update settings, and add replicas", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-global-legacy-")); const clock = new TestClock(Date.parse("2026-07-15T23:00:00Z")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: westRegion, clock, authMode: "off"}); let west: DynamoDBClient | undefined; let east: DynamoDBClient | undefined; let north: DynamoDBClient | undefined;
  try {
    await simulator.start(); west = client(simulator, westRegion); east = client(simulator, eastRegion); north = client(simulator, "eu-north-1"); await west.send(new CreateTableCommand(tableInput("LegacyGlobal", true))); await east.send(new CreateTableCommand(tableInput("LegacyGlobal", true))); await north.send(new CreateTableCommand(tableInput("LegacyGlobal", true))); clock.advance(100); await settle();
    const created = await west.send(new CreateGlobalTableCommand({ GlobalTableName: "LegacyGlobal", ReplicationGroup: [{ RegionName: westRegion }, { RegionName: eastRegion }] })); assert.equal(created.GlobalTableDescription?.GlobalTableStatus, "ACTIVE"); assert.equal((await west.send(new DescribeTableCommand({ TableName: "LegacyGlobal" }))).Table?.GlobalTableVersion, "2017.11.29");
    await west.send(new PutItemCommand({ TableName: "LegacyGlobal", Item: { id: { S: "before-add" }, value: { S: "replicated" } } })); await west.send(new UpdateGlobalTableCommand({ GlobalTableName: "LegacyGlobal", ReplicaUpdates: [{ Create: { RegionName: "eu-north-1" } }] })); assert.equal((await north.send(new GetItemCommand({ TableName: "LegacyGlobal", Key: { id: { S: "before-add" } } }))).Item?.value?.S, "replicated");
    const page = await west.send(new ListGlobalTablesCommand({ Limit: 1 })); assert.equal(page.GlobalTables?.[0].GlobalTableName, "LegacyGlobal");
    const settings = await west.send(new UpdateGlobalTableSettingsCommand({ GlobalTableName: "LegacyGlobal", GlobalTableBillingMode: "PROVISIONED", GlobalTableProvisionedWriteCapacityUnits: 12, ReplicaSettingsUpdate: [{ RegionName: eastRegion, ReplicaProvisionedReadCapacityUnits: 7, ReplicaTableClass: "STANDARD_INFREQUENT_ACCESS" }] })); const eastSettings = settings.ReplicaSettings?.find(replica => replica.RegionName === eastRegion); assert.equal(eastSettings?.ReplicaProvisionedReadCapacityUnits, 7); assert.equal(eastSettings?.ReplicaProvisionedWriteCapacityUnits, 12); assert.equal(eastSettings?.ReplicaTableClassSummary?.TableClass, "STANDARD_INFREQUENT_ACCESS"); assert.equal((await west.send(new DescribeGlobalTableSettingsCommand({ GlobalTableName: "LegacyGlobal" }))).ReplicaSettings?.length, 3);
    await west.send(new UpdateGlobalTableCommand({ GlobalTableName: "LegacyGlobal", ReplicaUpdates: [{ Delete: { RegionName: "eu-north-1" } }] })); await assert.rejects(north.send(new DescribeTableCommand({ TableName: "LegacyGlobal" })), (error: any) => error.name === "ResourceNotFoundException");
    await assert.rejects(west.send(new UpdateTableCommand({ TableName: "LegacyGlobal", ReplicaUpdates: [{ Create: { RegionName: "ap-southeast-2" } }], MultiRegionConsistency: "STRONG" })), (error: any) => error.name === "ValidationException" && /strong consistency/.test(error.message));
  } finally { west?.destroy(); east?.destroy(); north?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
