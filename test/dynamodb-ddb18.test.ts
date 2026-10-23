import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BatchExecuteStatementCommand, CreateBackupCommand, CreateTableCommand, DescribeBackupCommand, DescribeContributorInsightsCommand, DescribeTableCommand, DynamoDBClient, ExecuteStatementCommand, ExecuteTransactionCommand, GetItemCommand, PutItemCommand, RestoreTableFromBackupCommand, UpdateContributorInsightsCommand } from "@aws-sdk/client-dynamodb";
import type { TelemetryEvent } from "../src/core/telemetry.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

// DDB-18: the four documentation-pass items left open after the 2026-10-22 review.
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("DDB-18 PartiQL EXISTS, batch error codes, restored GSI Backfilling, Contributor Insights exclusion, and manifest rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb18-")); const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  let client: DynamoDBClient | undefined; let unsubscribe: (() => void) | undefined;
  try {
    await sim.start(); client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 });
    await client.send(new CreateTableCommand({ TableName: "Ddb18Music", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "Artist", AttributeType: "S" }, { AttributeName: "SongTitle", AttributeType: "S" }, { AttributeName: "Album", AttributeType: "S" }], KeySchema: [{ AttributeName: "Artist", KeyType: "HASH" }, { AttributeName: "SongTitle", KeyType: "RANGE" }], GlobalSecondaryIndexes: [{ IndexName: "ByAlbum", KeySchema: [{ AttributeName: "Album", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }] }));
    await waitForTableActive(client, "Ddb18Music");
    await client.send(new PutItemCommand({ TableName: "Ddb18Music", Item: { Artist: { S: "Acme" }, SongTitle: { S: "Happy" }, Album: { S: "Songs" }, Awards: { N: "1" } } }));

    // EXISTS: full primary key required; only in transactions; a false condition cancels like ConditionCheck.
    await assert.rejects(client.send(new ExecuteStatementCommand({ Statement: `EXISTS(SELECT * FROM "Ddb18Music" WHERE "Artist" = 'Acme' AND "SongTitle" = 'Happy')` })), { name: "ValidationException" });
    await assert.rejects(client.send(new ExecuteTransactionCommand({ TransactStatements: [{ Statement: `EXISTS(SELECT * FROM "Ddb18Music" WHERE "Artist" = 'Acme' AND "Awards" = 1)` }, { Statement: `INSERT INTO "Ddb18Music" VALUE {'Artist': 'Acme', 'SongTitle': 'New'}` }] })), (error: any) => error.name === "ValidationException" && /every primary key attribute/.test(error.message));
    await client.send(new ExecuteTransactionCommand({ TransactStatements: [{ Statement: `EXISTS(SELECT * FROM "Ddb18Music" WHERE "Artist" = 'Acme' AND "SongTitle" = 'Happy' AND "Awards" = 1)` }, { Statement: `INSERT INTO "Ddb18Music" VALUE {'Artist': 'Acme', 'SongTitle': 'Second'}` }] }));
    assert.ok((await client.send(new GetItemCommand({ TableName: "Ddb18Music", Key: { Artist: { S: "Acme" }, SongTitle: { S: "Second" } } }))).Item);
    await assert.rejects(client.send(new ExecuteTransactionCommand({ TransactStatements: [{ Statement: `EXISTS(SELECT * FROM "Ddb18Music" WHERE "Artist" = 'Acme' AND "SongTitle" = 'Happy' AND "Awards" IS MISSING)` }, { Statement: `INSERT INTO "Ddb18Music" VALUE {'Artist': 'Acme', 'SongTitle': 'Third'}` }] })), (error: any) => error.name === "TransactionCanceledException" && error.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed");

    // BatchStatementError.Code uses the documented enum values.
    const batch = await client.send(new BatchExecuteStatementCommand({ Statements: [
      { Statement: `INSERT INTO "Ddb18Music" VALUE {'Artist': 'Acme', 'SongTitle': 'Happy'}` },
      { Statement: `UPDATE "Ddb18Music" SET "Awards" = 2 WHERE "Artist" = 'Acme' AND "SongTitle" = 'Second' AND "Awards" = 99` },
      { Statement: `UPDATE "Ddb18Missing" SET "Awards" = 2 WHERE "Artist" = 'Acme' AND "SongTitle" = 'Happy'` },
    ] }));
    assert.deepEqual(batch.Responses?.map(response => response.Error?.Code), ["DuplicateItem", "ConditionalCheckFailed", "ResourceNotFound"]);

    // Contributor Insights does not count PartiQL requests.
    await client.send(new UpdateContributorInsightsCommand({ TableName: "Ddb18Music", ContributorInsightsAction: "ENABLE" }));
    for (let attempt = 0; attempt < 200; attempt++) { if ((await client.send(new DescribeContributorInsightsCommand({ TableName: "Ddb18Music" }))).ContributorInsightsStatus === "ENABLED") break; await new Promise(resolve => setTimeout(resolve, 20)); }
    const events: TelemetryEvent[] = []; unsubscribe = (sim as any).services(region).telemetry.subscribe((event: TelemetryEvent) => { if (event.metricName === "AccessFrequency") events.push(event); });
    await client.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "Ddb18Music" WHERE "Artist" = 'Acme' AND "SongTitle" = 'Happy'` }));
    await client.send(new ExecuteTransactionCommand({ TransactStatements: [{ Statement: `SELECT * FROM "Ddb18Music" WHERE "Artist" = 'Acme' AND "SongTitle" = 'Happy'` }] }));
    assert.equal(events.length, 0, "PartiQL requests are not Contributor Insights events");
    await client.send(new GetItemCommand({ TableName: "Ddb18Music", Key: { Artist: { S: "Acme" }, SongTitle: { S: "Happy" } } }));
    assert.ok(events.length > 0, "native reads still feed Contributor Insights");

    // GSIs on a restored table are created with the table, so DescribeTable omits Backfilling.
    const backup = await client.send(new CreateBackupCommand({ TableName: "Ddb18Music", BackupName: "ddb18-backup" }));
    for (let attempt = 0; attempt < 200; attempt++) { if ((await client.send(new DescribeBackupCommand({ BackupArn: backup.BackupDetails!.BackupArn! }))).BackupDescription?.BackupDetails?.BackupStatus === "AVAILABLE") break; await new Promise(resolve => setTimeout(resolve, 20)); }
    const restored = await client.send(new RestoreTableFromBackupCommand({ BackupArn: backup.BackupDetails!.BackupArn!, TargetTableName: "Ddb18Restored" }));
    assert.equal(restored.TableDescription?.GlobalSecondaryIndexes?.[0].IndexStatus, "CREATING");
    assert.equal(restored.TableDescription?.GlobalSecondaryIndexes?.[0].Backfilling, undefined);
    await waitForTableActive(client, "Ddb18Restored");
    const active = (await client.send(new DescribeTableCommand({ TableName: "Ddb18Restored" }))).Table!;
    assert.equal(active.GlobalSecondaryIndexes?.[0].IndexStatus, "ACTIVE"); assert.equal(active.GlobalSecondaryIndexes?.[0].Backfilling, undefined);

    // The conformance manifest carries the new rows with provenance.
    const manifest = JSON.parse(await readFile(join(process.cwd(), "docs", "generated", "dynamodb-partiql-conformance.json"), "utf8"));
    assert.equal(manifest.grammar.orderBy.defaultDirection, "ASC");
    assert.deepEqual(manifest.errors.batchStatementErrorCodes, ["ConditionalCheckFailed", "ItemCollectionSizeLimitExceeded", "RequestLimitExceeded", "ValidationError", "ProvisionedThroughputExceeded", "TransactionConflict", "ThrottlingError", "InternalServerError", "ResourceNotFound", "AccessDenied", "DuplicateItem"]);
    assert.equal(manifest.contributorInsights.supportsPartiql, false);
    assert.ok(manifest.provenance.includes("https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchStatementError.html"));
  } finally { unsubscribe?.(); client?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
