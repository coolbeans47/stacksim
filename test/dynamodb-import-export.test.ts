import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import {
  CreateTableCommand,
  DescribeExportCommand,
  DescribeImportCommand,
  DynamoDBClient,
  ExportTableToPointInTimeCommand,
  GetItemCommand,
  ImportTableCommand,
  ListExportsCommand,
  ListImportsCommand,
  PutItemCommand,
  QueryCommand,
  UpdateContinuousBackupsCommand,
} from "@aws-sdk/client-dynamodb";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";
import { assertPrivateFile } from "./support/platform.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function clientFor(simulator: StackSim): DynamoDBClient { return new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }); }
async function tick(clock: TestClock, milliseconds = 50): Promise<void> { clock.advance(milliseconds); await new Promise<void>(resolve => setImmediate(resolve)); }

test("DynamoDB local file export/import round trips DynamoDB JSON with durable job catalogs", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-transfer-")); const bucket = join(root, "bucket"); const bucketUrl = pathToFileURL(bucket).href; const clock = new TestClock(Date.parse("2026-07-15T23:30:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator); const source = await client.send(new CreateTableCommand({ TableName: "TransferSource", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "category", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }] })); await waitForTableActive(client, "TransferSource", clock); await client.send(new PutItemCommand({ TableName: "TransferSource", Item: { id: { S: "alpha" }, category: { S: "books" }, count: { N: "1" } } })); await client.send(new PutItemCommand({ TableName: "TransferSource", Item: { id: { S: "beta" }, category: { S: "music" }, enabled: { BOOL: true } } })); await client.send(new UpdateContinuousBackupsCommand({ TableName: "TransferSource", PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }));
    await assert.rejects(client.send(new ExportTableToPointInTimeCommand({ TableArn: source.TableDescription!.TableArn!, S3Bucket: bucketUrl })), (error: any) => error.name === "ValidationException" && /STACKSIM_ALLOW_LOCAL_FILES/.test(error.message));

    client.destroy(); client = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, allowLocalFiles: true, authMode: "off"}); await simulator.start(); client = clientFor(simulator);
    await assert.rejects(client.send(new ExportTableToPointInTimeCommand({ TableArn: source.TableDescription!.TableArn!, S3Bucket: "real-s3-bucket" })), (error: any) => error.name === "ValidationException" && /dependency-blocked/.test(error.message)); await assert.rejects(client.send(new ExportTableToPointInTimeCommand({ TableArn: source.TableDescription!.TableArn!, S3Bucket: bucketUrl, ExportFormat: "ION" })), (error: any) => error.name === "ValidationException" && /codec-blocked/.test(error.message));

    const exported = await client.send(new ExportTableToPointInTimeCommand({ TableArn: source.TableDescription!.TableArn!, S3Bucket: bucketUrl, S3Prefix: "roundtrip", ExportFormat: "DYNAMODB_JSON", ClientToken: "export-roundtrip" })); const exportArn = exported.ExportDescription!.ExportArn!; assert.equal(exported.ExportDescription?.ExportStatus, "IN_PROGRESS"); assert.equal((await client.send(new ExportTableToPointInTimeCommand({ TableArn: source.TableDescription!.TableArn!, S3Bucket: bucketUrl, S3Prefix: "roundtrip", ExportFormat: "DYNAMODB_JSON", ClientToken: "export-roundtrip" }))).ExportDescription?.ExportArn, exportArn); await assert.rejects(client.send(new ExportTableToPointInTimeCommand({ TableArn: source.TableDescription!.TableArn!, S3Bucket: bucketUrl, S3Prefix: "changed", ClientToken: "export-roundtrip" })), (error: any) => error.name === "ExportConflictException");
    assert.equal((await client.send(new ListExportsCommand({ TableArn: source.TableDescription!.TableArn!, MaxResults: 1 }))).ExportSummaries?.[0].ExportArn, exportArn); await tick(clock); const completed = await client.send(new DescribeExportCommand({ ExportArn: exportArn })); assert.equal(completed.ExportDescription?.ExportStatus, "COMPLETED"); assert.equal(completed.ExportDescription?.ItemCount, 2);

    const exportId = exportArn.split("/export/")[1]; const dataPath = join(bucket, "roundtrip", "AWSDynamoDB", exportId, "data", "data.json.gz"); const manifestPath = join(bucket, "roundtrip", "AWSDynamoDB", exportId, "manifest-summary.json"); await assertPrivateFile(dataPath); await assertPrivateFile(manifestPath); const rows = gunzipSync(await readFile(dataPath)).toString("utf8").trim().split("\n").map(line => JSON.parse(line)); assert.equal(rows.length, 2); assert.deepEqual(rows.map(row => row.Item.id.S).sort(), ["alpha", "beta"]);

    const creation = { TableName: "TransferImported", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "category", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }] } as any; const imported = await client.send(new ImportTableCommand({ S3BucketSource: { S3Bucket: bucketUrl, S3KeyPrefix: `roundtrip/AWSDynamoDB/${exportId}/data` }, InputFormat: "DYNAMODB_JSON", InputCompressionType: "GZIP", TableCreationParameters: creation, ClientToken: "import-roundtrip" })); const importArn = imported.ImportTableDescription!.ImportArn!; assert.equal(imported.ImportTableDescription?.ImportStatus, "IN_PROGRESS"); assert.equal(imported.ImportTableDescription?.ProcessedItemCount, 2); assert.equal((await client.send(new ImportTableCommand({ S3BucketSource: { S3Bucket: bucketUrl, S3KeyPrefix: `roundtrip/AWSDynamoDB/${exportId}/data` }, InputFormat: "DYNAMODB_JSON", InputCompressionType: "GZIP", TableCreationParameters: creation, ClientToken: "import-roundtrip" }))).ImportTableDescription?.ImportArn, importArn); await tick(clock); const importDescription = await client.send(new DescribeImportCommand({ ImportArn: importArn })); assert.equal(importDescription.ImportTableDescription?.ImportStatus, "COMPLETED"); assert.equal(importDescription.ImportTableDescription?.ImportedItemCount, 2); assert.equal((await client.send(new GetItemCommand({ TableName: "TransferImported", Key: { id: { S: "alpha" } } }))).Item?.count?.N, "1"); assert.equal((await client.send(new QueryCommand({ TableName: "TransferImported", IndexName: "ByCategory", KeyConditionExpression: "category = :category", ExpressionAttributeValues: { ":category": { S: "music" } } }))).Count, 1); assert.equal((await client.send(new ListImportsCommand({ TableArn: importDescription.ImportTableDescription!.TableArn!, PageSize: 1 }))).ImportSummaryList?.[0].ImportArn, importArn);

    const pending = await client.send(new ExportTableToPointInTimeCommand({ TableArn: source.TableDescription!.TableArn!, S3Bucket: bucketUrl, S3Prefix: "restart", ClientToken: "pending-restart" })); const pendingArn = pending.ExportDescription!.ExportArn!; client.destroy(); client = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, allowLocalFiles: true, authMode: "off"}); await simulator.start(); client = clientFor(simulator); await tick(clock); assert.equal((await client.send(new DescribeExportCommand({ ExportArn: pendingArn }))).ExportDescription?.ExportStatus, "COMPLETED"); assert.equal((await client.send(new DescribeImportCommand({ ImportArn: importArn }))).ImportTableDescription?.ImportStatus, "COMPLETED"); assert.equal((await client.send(new GetItemCommand({ TableName: "TransferImported", Key: { id: { S: "beta" } } }))).Item?.enabled?.BOOL, true); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
