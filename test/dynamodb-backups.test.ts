import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateBackupCommand,
  CreateTableCommand,
  DeleteBackupCommand,
  DeleteItemCommand,
  DescribeBackupCommand,
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  GetItemCommand,
  ListBackupsCommand,
  ListTagsOfResourceCommand,
  PutItemCommand,
  QueryCommand,
  RestoreTableFromBackupCommand,
  RestoreTableToPointInTimeCommand,
  UpdateContinuousBackupsCommand,
  UpdateItemCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";
import { assertPrivateFile } from "./support/platform.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function clientFor(simulator: StackSim): DynamoDBClient { return new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }); }
async function tick(clock: TestClock, milliseconds = 50): Promise<void> { clock.advance(milliseconds); await new Promise<void>(resolve => setImmediate(resolve)); }
async function rejects(promise: Promise<unknown>, name: string): Promise<void> { await assert.rejects(promise, (error: any) => error.name === name); }

test("DynamoDB on-demand backups are immutable, deduplicated, restorable, paginated, and restart durable", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-backups-")); const clock = new TestClock(Date.parse("2026-07-15T08:00:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator);
    const created = await client.send(new CreateTableCommand({ TableName: "BackupSource", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "category", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }], TableClass: "STANDARD_INFREQUENT_ACCESS", Tags: [{ Key: "environment", Value: "learning" }] }));
    await waitForTableActive(client, "BackupSource", clock);
    await client.send(new PutItemCommand({ TableName: "BackupSource", Item: { id: { S: "alpha" }, category: { S: "before" }, value: { N: "1" } } })); await client.send(new UpdateTimeToLiveCommand({ TableName: "BackupSource", TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" } })); await tick(clock); await simulator.dynamodb.sweepTtlNow();

    const first = await client.send(new CreateBackupCommand({ TableName: created.TableDescription!.TableArn!, BackupName: "before-mutation" })); const firstArn = first.BackupDetails!.BackupArn!; assert.equal(first.BackupDetails?.BackupStatus, "CREATING"); await tick(clock);
    const described = (await client.send(new DescribeBackupCommand({ BackupArn: firstArn }))).BackupDescription!; assert.equal(described.BackupDetails?.BackupStatus, "AVAILABLE"); assert.equal(described.SourceTableDetails?.ItemCount, 1); assert.equal(described.SourceTableFeatureDetails?.GlobalSecondaryIndexes?.[0].IndexName, "ByCategory"); assert.equal(described.SourceTableFeatureDetails?.SSEDescription, undefined); assert.equal(described.SourceTableFeatureDetails?.TimeToLiveDescription?.TimeToLiveStatus, "ENABLED");

    await client.send(new PutItemCommand({ TableName: "BackupSource", Item: { id: { S: "alpha" }, category: { S: "after" }, value: { N: "2" } } })); await client.send(new PutItemCommand({ TableName: "BackupSource", Item: { id: { S: "beta" }, category: { S: "after" }, value: { N: "3" } } }));
    const restoring = await client.send(new RestoreTableFromBackupCommand({ BackupArn: firstArn, TargetTableName: "BackupRestore" })); assert.equal(restoring.TableDescription?.TableStatus, "CREATING"); assert.equal(restoring.TableDescription?.RestoreSummary?.SourceBackupArn, firstArn); await tick(clock);
    const restored = (await client.send(new DescribeTableCommand({ TableName: "BackupRestore" }))).Table!; assert.equal(restored.TableStatus, "ACTIVE"); assert.equal(restored.TableClassSummary?.TableClass, "STANDARD_INFREQUENT_ACCESS"); assert.equal(restored.SSEDescription, undefined); assert.equal(restored.RestoreSummary?.RestoreInProgress, false); assert.equal((await client.send(new GetItemCommand({ TableName: "BackupRestore", Key: { id: { S: "alpha" } } }))).Item?.value?.N, "1"); assert.equal((await client.send(new GetItemCommand({ TableName: "BackupRestore", Key: { id: { S: "beta" } } }))).Item, undefined); assert.equal((await client.send(new QueryCommand({ TableName: "BackupRestore", IndexName: "ByCategory", KeyConditionExpression: "category = :category", ExpressionAttributeValues: { ":category": { S: "before" } } }))).Count, 1);
    assert.deepEqual((await client.send(new ListTagsOfResourceCommand({ ResourceArn: restored.TableArn! }))).Tags, []); assert.equal((await client.send(new DescribeTimeToLiveCommand({ TableName: "BackupRestore" }))).TimeToLiveDescription?.TimeToLiveStatus, "DISABLED"); await rejects(client.send(new RestoreTableFromBackupCommand({ BackupArn: firstArn, TargetTableName: "BackupRestore" })), "TableAlreadyExistsException");
    await client.send(new RestoreTableFromBackupCommand({ BackupArn: firstArn, TargetTableName: "BackupOverride", BillingModeOverride: "PAY_PER_REQUEST", OnDemandThroughputOverride: { MaxReadRequestUnits: 40, MaxWriteRequestUnits: 20 }, GlobalSecondaryIndexOverride: [] })); const overridden = (await client.send(new DescribeTableCommand({ TableName: "BackupOverride" }))).Table!; assert.deepEqual(overridden.OnDemandThroughput, { MaxReadRequestUnits: 40, MaxWriteRequestUnits: 20 }); assert.deepEqual(overridden.GlobalSecondaryIndexes, []); await rejects(client.send(new RestoreTableFromBackupCommand({ BackupArn: firstArn, TargetTableName: "InvalidOverride", GlobalSecondaryIndexOverride: [{ IndexName: "MissingIndex", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }] })), "ValidationException");

    const secondArn = (await client.send(new CreateBackupCommand({ TableName: "BackupSource", BackupName: "after-mutation-a" }))).BackupDetails!.BackupArn!; await tick(clock); const thirdArn = (await client.send(new CreateBackupCommand({ TableName: "BackupSource", BackupName: "after-mutation-b" }))).BackupDetails!.BackupArn!; await tick(clock);
    const catalog = simulator.store.regionState("eu-west-1").dynamodbBackups; assert.equal(catalog[secondArn].snapshotHash, catalog[thirdArn].snapshotHash); const snapshotDirectory = join(root, "data", "dynamodb", "backups", "000000000000", "eu-west-1", "snapshots"); const files = await readdir(snapshotDirectory); assert.equal(files.length, 2); await assertPrivateFile(join(snapshotDirectory, files[0]));
    const pageOne = await client.send(new ListBackupsCommand({ TableName: "BackupSource", BackupType: "USER", Limit: 1 })); assert.equal(pageOne.BackupSummaries?.length, 1); assert.ok(pageOne.LastEvaluatedBackupArn); const pageTwo = await client.send(new ListBackupsCommand({ TableName: "BackupSource", BackupType: "USER", Limit: 1, ExclusiveStartBackupArn: pageOne.LastEvaluatedBackupArn })); assert.equal(pageTwo.BackupSummaries?.length, 1);
    assert.equal((await client.send(new DeleteBackupCommand({ BackupArn: firstArn }))).BackupDescription?.BackupDetails?.BackupStatus, "DELETED"); await rejects(client.send(new DescribeBackupCommand({ BackupArn: firstArn })), "BackupNotFoundException"); const pendingArn = (await client.send(new CreateBackupCommand({ TableName: "BackupSource", BackupName: "pending-restart" }))).BackupDetails!.BackupArn!; await client.send(new RestoreTableFromBackupCommand({ BackupArn: secondArn, TargetTableName: "RestartingRestore" })); await rejects(client.send(new DeleteBackupCommand({ BackupArn: secondArn })), "BackupInUseException");

    client.destroy(); await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); client = clientFor(simulator); await tick(clock); assert.equal((await client.send(new DescribeBackupCommand({ BackupArn: pendingArn }))).BackupDescription?.BackupDetails?.BackupStatus, "AVAILABLE"); assert.equal((await client.send(new DescribeTableCommand({ TableName: "RestartingRestore" }))).Table?.TableStatus, "ACTIVE"); assert.equal((await client.send(new DescribeBackupCommand({ BackupArn: secondArn }))).BackupDescription?.BackupDetails?.BackupStatus, "AVAILABLE"); assert.equal((await client.send(new GetItemCommand({ TableName: "BackupRestore", Key: { id: { S: "alpha" } } }))).Item?.value?.N, "1"); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("DynamoDB point-in-time recovery replays second-resolution writes and deletes across restart and resets after disable", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-pitr-")); const clock = new TestClock(Date.parse("2026-07-15T10:00:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator); const source = await client.send(new CreateTableCommand({ TableName: "PitrSource", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] })); await waitForTableActive(client, "PitrSource", clock); await client.send(new PutItemCommand({ TableName: "PitrSource", Item: { id: { S: "record" }, version: { N: "0" } } }));
    const enabled = await client.send(new UpdateContinuousBackupsCommand({ TableName: source.TableDescription!.TableArn!, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 1 } })); assert.equal(enabled.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus, "ENABLED"); assert.equal(enabled.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.RecoveryPeriodInDays, 1);
    const beforeWrites = new Date(clock.now() - 1_000); await tick(clock, 1_000); await client.send(new PutItemCommand({ TableName: "PitrSource", Item: { id: { S: "record" }, version: { N: "1" } } })); const versionOne = new Date(clock.now()); await tick(clock, 1_000); await client.send(new UpdateItemCommand({ TableName: "PitrSource", Key: { id: { S: "record" } }, UpdateExpression: "SET version = :version", ExpressionAttributeValues: { ":version": { N: "2" } } })); const versionTwo = new Date(clock.now()); await tick(clock, 1_000); await client.send(new DeleteItemCommand({ TableName: "PitrSource", Key: { id: { S: "record" } } }));

    await rejects(client.send(new RestoreTableToPointInTimeCommand({ SourceTableName: "PitrSource", TargetTableName: "TooEarly", RestoreDateTime: beforeWrites })), "InvalidRestoreTimeException");
    await client.send(new RestoreTableToPointInTimeCommand({ SourceTableName: "PitrSource", TargetTableName: "VersionOne", RestoreDateTime: versionOne })); await waitForTableActive(client, "VersionOne", clock); assert.equal((await client.send(new GetItemCommand({ TableName: "VersionOne", Key: { id: { S: "record" } } }))).Item?.version?.N, "1");
    const secondRestore = await client.send(new RestoreTableToPointInTimeCommand({ SourceTableArn: source.TableDescription!.TableArn!, TargetTableName: "VersionTwo", RestoreDateTime: versionTwo })); assert.equal(secondRestore.TableDescription?.RestoreSummary?.SourceTableArn, source.TableDescription!.TableArn); await waitForTableActive(client, "VersionTwo", clock); assert.equal((await client.send(new GetItemCommand({ TableName: "VersionTwo", Key: { id: { S: "record" } } }))).Item?.version?.N, "2");
    await client.send(new RestoreTableToPointInTimeCommand({ SourceTableName: "PitrSource", TargetTableName: "LatestState", UseLatestRestorableTime: true })); await waitForTableActive(client, "LatestState", clock); assert.equal((await client.send(new GetItemCommand({ TableName: "LatestState", Key: { id: { S: "record" } } }))).Item, undefined); await rejects(client.send(new RestoreTableToPointInTimeCommand({ SourceTableName: "PitrSource", TargetTableName: "VersionOne", UseLatestRestorableTime: true })), "TableAlreadyExistsException");

    client.destroy(); await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); client = clientFor(simulator); const restarted = await client.send(new DescribeContinuousBackupsCommand({ TableName: "PitrSource" })); assert.equal(restarted.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus, "ENABLED"); assert.ok(restarted.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.EarliestRestorableDateTime instanceof Date);
    await client.send(new UpdateContinuousBackupsCommand({ TableName: "PitrSource", PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false } })); assert.equal((await client.send(new DescribeContinuousBackupsCommand({ TableName: "PitrSource" }))).ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus, "DISABLED"); await tick(clock, 1_000); await client.send(new UpdateContinuousBackupsCommand({ TableName: "PitrSource", PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 1 } })); const reenabledAt = new Date(clock.now()); await rejects(client.send(new RestoreTableToPointInTimeCommand({ SourceTableName: "PitrSource", TargetTableName: "OldHistory", RestoreDateTime: versionTwo })), "InvalidRestoreTimeException");
    await tick(clock, 24 * 60 * 60_000 + 1_000); await client.send(new PutItemCommand({ TableName: "PitrSource", Item: { id: { S: "retained" }, version: { N: "5" } } })); const pruned = await client.send(new DescribeContinuousBackupsCommand({ TableName: "PitrSource" })); const earliest = pruned.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.EarliestRestorableDateTime; assert.ok(earliest && earliest.getTime() > reenabledAt.getTime()); await rejects(client.send(new RestoreTableToPointInTimeCommand({ SourceTableName: "PitrSource", TargetTableName: "PrunedHistory", RestoreDateTime: reenabledAt })), "InvalidRestoreTimeException");
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
