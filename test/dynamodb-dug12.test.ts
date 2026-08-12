import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
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
  PutItemCommand,
  UpdateContinuousBackupsCommand,
} from "@aws-sdk/client-dynamodb";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { TestClock } from "../src/core/clock.js";
import { migrateV85ToV86 } from "../src/migrations/v85-to-v86.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const accountId = "000000000000";

function dynamo(simulator: StackSim): DynamoDBClient {
  return new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
}
function s3(simulator: StackSim): S3Client {
  return new S3Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, forcePathStyle: true, credentials, maxAttempts: 1 });
}
async function flush(clock: TestClock, times = 8): Promise<void> {
  clock.advance(50);
  for (let index = 0; index < times; index++) await new Promise<void>(resolve => setTimeout(resolve, 2));
}
async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer> { const chunks: Buffer[] = []; for await (const chunk of body) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
async function waitExport(client: DynamoDBClient, arn: string, clock: TestClock) {
  for (let index = 0; index < 200; index++) {
    await flush(clock);
    const description = (await client.send(new DescribeExportCommand({ ExportArn: arn }))).ExportDescription!;
    if (description.ExportStatus !== "IN_PROGRESS") return description;
  }
  throw new Error("export timeout");
}
async function waitImport(client: DynamoDBClient, arn: string, clock: TestClock) {
  for (let index = 0; index < 200; index++) {
    await flush(clock);
    const description = (await client.send(new DescribeImportCommand({ ImportArn: arn }))).ImportTableDescription!;
    if (description.ImportStatus !== "IN_PROGRESS") return description;
  }
  throw new Error("import timeout");
}

function transferPolicy(bucket: string, allow = true): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DynamoExport",
        Effect: allow ? "Allow" : "Deny",
        Principal: { Service: "dynamodb.amazonaws.com" },
        Action: ["s3:PutObject"],
        Resource: `arn:aws:s3:::${bucket}/*`,
        Condition: {
          StringEquals: { "aws:SourceAccount": accountId },
          ArnLike: { "aws:SourceArn": `arn:aws:dynamodb:${region}:${accountId}:table/*` },
        },
      },
      {
        Sid: "DynamoImportGet",
        Effect: allow ? "Allow" : "Deny",
        Principal: { Service: "dynamodb.amazonaws.com" },
        Action: ["s3:GetObject"],
        Resource: `arn:aws:s3:::${bucket}/*`,
        Condition: { StringEquals: { "aws:SourceAccount": accountId } },
      },
      {
        Sid: "DynamoImportList",
        Effect: allow ? "Allow" : "Deny",
        Principal: { Service: "dynamodb.amazonaws.com" },
        Action: ["s3:ListBucket"],
        Resource: `arn:aws:s3:::${bucket}`,
        Condition: { StringEquals: { "aws:SourceAccount": accountId } },
      },
    ],
  });
}

async function prepareSource(client: DynamoDBClient, clock: TestClock, name: string) {
  const created = await client.send(new CreateTableCommand({
    TableName: name,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
  }));
  await waitForTableActive(client, name, clock);
  await client.send(new PutItemCommand({ TableName: name, Item: { id: { S: "one" }, note: { S: "alpha" } } }));
  await client.send(new PutItemCommand({ TableName: name, Item: { id: { S: "two" }, note: { S: "beta" } } }));
  await client.send(new UpdateContinuousBackupsCommand({ TableName: name, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }));
  return created.TableDescription!.TableArn!;
}

test("DUG-12 weakness reproduction: ordinary S3 buckets are no longer rejected as dependency-blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug12-weak-s3-"));
  const clock = new TestClock(Date.parse("2026-08-11T12:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let ddb: DynamoDBClient | undefined;
  let s3Client: S3Client | undefined;
  try {
    await simulator.start();
    ddb = dynamo(simulator);
    s3Client = s3(simulator);
    const tableArn = await prepareSource(ddb, clock, "WeakSource");
    const bucket = "dug12-weak-bucket";
    await s3Client.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3Client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: transferPolicy(bucket) }));
    const exported = await ddb.send(new ExportTableToPointInTimeCommand({ TableArn: tableArn, S3Bucket: bucket, S3Prefix: "weak", ClientToken: "weak-s3" }));
    assert.equal(exported.ExportDescription?.ExportStatus, "IN_PROGRESS");
    const completed = await waitExport(ddb, exported.ExportDescription!.ExportArn!, clock);
    assert.equal(completed.ExportStatus, "COMPLETED");
  } finally {
    ddb?.destroy(); s3Client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("DUG-12 weakness reproduction: job descriptor is durable before S3 side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug12-weak-admit-"));
  const clock = new TestClock(Date.parse("2026-08-11T12:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let ddb: DynamoDBClient | undefined;
  let s3Client: S3Client | undefined;
  try {
    await simulator.start();
    ddb = dynamo(simulator);
    s3Client = s3(simulator);
    const tableArn = await prepareSource(ddb, clock, "AdmitSource");
    const bucket = "dug12-admit-bucket";
    await s3Client.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3Client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: transferPolicy(bucket) }));
    const exported = await ddb.send(new ExportTableToPointInTimeCommand({ TableArn: tableArn, S3Bucket: bucket, S3Prefix: "admit", ClientToken: "admit-first" }));
    const exportArn = exported.ExportDescription!.ExportArn!;
    const job = simulator.store.regionState(region).dynamodbExports[exportArn];
    assert.equal(job.exportStatus, "IN_PROGRESS");
    assert.equal(job.stage, "SNAPSHOT");
    assert.ok(job.snapshotId);
    const listed = await s3Client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "admit/" }));
    assert.equal(listed.KeyCount ?? 0, 0);
  } finally {
    ddb?.destroy(); s3Client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("DUG-12 weakness reproduction: startup resumes unfinished jobs instead of blind COMPLETED", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug12-weak-resume-"));
  const clock = new TestClock(Date.parse("2026-08-11T12:00:00Z"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let ddb: DynamoDBClient | undefined;
  let s3Client: S3Client | undefined;
  try {
    await simulator.start();
    ddb = dynamo(simulator);
    s3Client = s3(simulator);
    const tableArn = await prepareSource(ddb, clock, "ResumeSource");
    const bucket = "dug12-resume-bucket";
    await s3Client.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3Client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: transferPolicy(bucket) }));
    const exported = await ddb.send(new ExportTableToPointInTimeCommand({ TableArn: tableArn, S3Bucket: bucket, S3Prefix: "resume", ClientToken: "resume-job" }));
    const exportArn = exported.ExportDescription!.ExportArn!;
    assert.equal(simulator.store.regionState(region).dynamodbExports[exportArn].stage, "SNAPSHOT");
    ddb.destroy(); s3Client.destroy(); ddb = undefined; s3Client = undefined; await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
    await simulator.start();
    ddb = dynamo(simulator);
    const before = (await ddb.send(new DescribeExportCommand({ ExportArn: exportArn }))).ExportDescription!;
    assert.equal(before.ExportStatus, "IN_PROGRESS");
    const completed = await waitExport(ddb, exportArn, clock);
    assert.equal(completed.ExportStatus, "COMPLETED");
    assert.equal(completed.ItemCount, 2);
  } finally {
    ddb?.destroy(); s3Client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("DUG-12 official DynamoDB and S3 clients round-trip through a local bucket", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug12-roundtrip-"));
  const clock = new TestClock(Date.parse("2026-08-11T13:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let ddb: DynamoDBClient | undefined;
  let s3Client: S3Client | undefined;
  try {
    await simulator.start();
    ddb = dynamo(simulator);
    s3Client = s3(simulator);
    const tableArn = await prepareSource(ddb, clock, "RoundTripSource");
    const bucket = "dug12-roundtrip-bucket";
    await s3Client.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3Client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: transferPolicy(bucket) }));

    const exported = await ddb.send(new ExportTableToPointInTimeCommand({
      TableArn: tableArn,
      S3Bucket: bucket,
      S3Prefix: "snapshots",
      ExportFormat: "DYNAMODB_JSON",
      ClientToken: "roundtrip-export",
    }));
    const exportArn = exported.ExportDescription!.ExportArn!;
    assert.equal((await ddb.send(new ListExportsCommand({ TableArn: tableArn, MaxResults: 1 }))).ExportSummaries?.[0].ExportArn, exportArn);
    const completed = await waitExport(ddb, exportArn, clock);
    assert.equal(completed.ExportStatus, "COMPLETED");
    assert.equal(completed.ItemCount, 2);
    assert.ok(completed.BilledSizeBytes! > 0);

    const exportId = exportArn.split("/export/")[1];
    const dataKey = `snapshots/AWSDynamoDB/${exportId}/data/data.json.gz`;
    const object = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: dataKey }));
    const body = Buffer.from(await object.Body!.transformToByteArray());
    const rows = gunzipSync(body).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.Item.id.S).sort(), ["one", "two"]);
    assert.equal(createHash("md5").update(body).digest("hex"), object.ETag?.replaceAll('"', ""));

    const imported = await ddb.send(new ImportTableCommand({
      S3BucketSource: { S3Bucket: bucket, S3KeyPrefix: `snapshots/AWSDynamoDB/${exportId}` },
      InputFormat: "DYNAMODB_JSON",
      InputCompressionType: "GZIP",
      TableCreationParameters: {
        TableName: "RoundTripImported",
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      },
      ClientToken: "roundtrip-import",
    }));
    const importArn = imported.ImportTableDescription!.ImportArn!;
    assert.equal(imported.ImportTableDescription?.ImportStatus, "IN_PROGRESS");
    const importDone = await waitImport(ddb, importArn, clock);
    assert.equal(importDone.ImportStatus, "COMPLETED");
    assert.equal(importDone.ImportedItemCount, 2);
    assert.equal((await ddb.send(new GetItemCommand({ TableName: "RoundTripImported", Key: { id: { S: "one" } } }))).Item?.note?.S, "alpha");
    assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally {
    ddb?.destroy(); s3Client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("DUG-12 service principal allow/deny, ownership, region, archive, overwrite, KMS/Ion/CSV rejection, and migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug12-matrix-"));
  const clock = new TestClock(Date.parse("2026-08-11T14:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let ddb: DynamoDBClient | undefined;
  let s3Client: S3Client | undefined;
  try {
    await simulator.start();
    ddb = dynamo(simulator);
    s3Client = s3(simulator);
    const tableArn = await prepareSource(ddb, clock, "MatrixSource");
    const allowed = "dug12-matrix-allowed";
    const denied = "dug12-matrix-denied";
    await s3Client.send(new CreateBucketCommand({ Bucket: allowed, CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3Client.send(new CreateBucketCommand({ Bucket: denied, CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3Client.send(new PutBucketPolicyCommand({ Bucket: allowed, Policy: transferPolicy(allowed, true) }));
    await s3Client.send(new PutBucketPolicyCommand({ Bucket: denied, Policy: transferPolicy(denied, false) }));

    await assert.rejects(
      ddb.send(new ExportTableToPointInTimeCommand({ TableArn: tableArn, S3Bucket: allowed, S3BucketOwner: "111122223333", ClientToken: "wrong-owner" })),
      (error: any) => error.name === "AccessDenied",
    );
    const deniedExport = await ddb.send(new ExportTableToPointInTimeCommand({ TableArn: tableArn, S3Bucket: denied, S3Prefix: "deny", ClientToken: "deny-async" }));
    const deniedResult = await waitExport(ddb, deniedExport.ExportDescription!.ExportArn!, clock);
    assert.equal(deniedResult.ExportStatus, "FAILED");
    assert.match(String(deniedResult.FailureCode), /S3AccessDenied|AccessDenied/);

    await assert.rejects(
      ddb.send(new ExportTableToPointInTimeCommand({ TableArn: tableArn, S3Bucket: "no-such-dug12-bucket", ClientToken: "missing-bucket" })),
      (error: any) => error.name === "NoSuchBucket",
    );
    await assert.rejects(
      ddb.send(new ExportTableToPointInTimeCommand({ TableArn: tableArn, S3Bucket: allowed, ExportFormat: "ION", ClientToken: "ion" })),
      (error: any) => error.name === "ValidationException" && /codec-blocked/.test(error.message),
    );
    await assert.rejects(
      ddb.send(new ExportTableToPointInTimeCommand({ TableArn: tableArn, S3Bucket: allowed, S3SseAlgorithm: "KMS", S3SseKmsKeyId: "alias/aws/s3", ClientToken: "kms" })),
      (error: any) => error.name === "ValidationException" && /KMS/.test(error.message),
    );
    await assert.rejects(
      ddb.send(new ImportTableCommand({
        S3BucketSource: { S3Bucket: allowed, S3KeyPrefix: "x" },
        InputFormat: "CSV",
        TableCreationParameters: { TableName: "CsvBlocked", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], BillingMode: "PAY_PER_REQUEST" },
      })),
      (error: any) => error.name === "ValidationException" && /CSV/.test(error.message),
    );
    await assert.rejects(
      ddb.send(new ImportTableCommand({
        S3BucketSource: { S3Bucket: allowed, S3KeyPrefix: "x" },
        InputFormat: "DYNAMODB_JSON",
        InputCompressionType: "ZSTD",
        TableCreationParameters: { TableName: "ZstdBlocked", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], BillingMode: "PAY_PER_REQUEST" },
      })),
      (error: any) => error.name === "ValidationException" && /ZSTD/.test(error.message),
    );
    await assert.rejects(
      ddb.send(new ExportTableToPointInTimeCommand({ TableArn: tableArn, S3Bucket: allowed, ExportType: "INCREMENTAL_EXPORT", ClientToken: "incremental" })),
      (error: any) => error.name === "ValidationException" && /Incremental/.test(error.message),
    );

    const foreignRegion = "us-east-1";
    const wrongRegionBucket = "dug12-wrong-region";
    simulator.store.state.installation.s3BucketNames[wrongRegionBucket] = { accountId, region: foreignRegion };
    simulator.store.regionState(foreignRegion).s3Buckets[wrongRegionBucket] = {
      name: wrongRegionBucket,
      arn: `arn:aws:s3:::${wrongRegionBucket}`,
      region: foreignRegion,
      ownerAccountId: accountId,
      ownerId: accountId.padStart(64, "0"),
      createdAt: clock.now(),
      versioning: "unversioned",
      encryption: "AES256",
      encryptionConfiguration: { algorithm: "AES256", bucketKeyEnabled: false },
      tags: {},
      publicAccessBlock: { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true },
      objectOwnership: "BucketOwnerEnforced",
      acl: { ownerId: accountId.padStart(64, "0"), ownerDisplayName: "owner", grants: [] },
      requestPayment: "BucketOwner",
      abacStatus: "Disabled",
    };
    await assert.rejects(
      ddb.send(new ExportTableToPointInTimeCommand({ TableArn: tableArn, S3Bucket: wrongRegionBucket, ClientToken: "wrong-region" })),
      (error: any) => error.name === "PermanentRedirect" || error.$metadata?.httpStatusCode === 301,
    );

    const tamperExport = await ddb.send(new ExportTableToPointInTimeCommand({ TableArn: tableArn, S3Bucket: allowed, S3Prefix: "tamper", ClientToken: "tamper-export" }));
    const tamperDone = await waitExport(ddb, tamperExport.ExportDescription!.ExportArn!, clock);
    assert.equal(tamperDone.ExportStatus, "COMPLETED");
    const tamperRoot = tamperDone.ExportManifest!.replace(/\/manifest-summary\.json$/, "");
    await s3Client.send(new PutObjectCommand({ Bucket: allowed, Key: `${tamperRoot}/manifest-files.json`, Body: "{}\n", ContentType: "application/json" }));
    const tamperImport = await ddb.send(new ImportTableCommand({
      S3BucketSource: { S3Bucket: allowed, S3KeyPrefix: tamperRoot },
      InputFormat: "DYNAMODB_JSON", InputCompressionType: "GZIP",
      TableCreationParameters: { TableName: "TamperedManifest", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], BillingMode: "PAY_PER_REQUEST" },
      ClientToken: "tamper-import",
    }));
    const tampered = await waitImport(ddb, tamperImport.ImportTableDescription!.ImportArn!, clock);
    assert.equal(tampered.ImportStatus, "FAILED");
    assert.match(String(tampered.FailureMessage), /checksum/i);
    assert.equal(simulator.store.regionState(region).tables.TamperedManifest, undefined);

    await s3Client.send(new PutBucketVersioningCommand({ Bucket: allowed, VersioningConfiguration: { Status: "Enabled" } }));
    await s3Client.send(new PutObjectCommand({ Bucket: allowed, Key: "incoming/archive.json.gz", Body: gzipLines([{ Item: { id: { S: "archived" } } }]), ContentType: "application/x-gzip" }));
    await s3Client.send(new PutBucketLifecycleConfigurationCommand({
      Bucket: allowed,
      LifecycleConfiguration: { Rules: [{ ID: "archive", Status: "Enabled", Filter: { Prefix: "incoming/" }, Transitions: [{ Days: 0, StorageClass: "GLACIER" }] }] },
    }));
    await flush(clock, 20);
    const importArchived = await ddb.send(new ImportTableCommand({
      S3BucketSource: { S3Bucket: allowed, S3KeyPrefix: "incoming/" },
      InputFormat: "DYNAMODB_JSON",
      InputCompressionType: "GZIP",
      TableCreationParameters: { TableName: "ArchiveImport", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], BillingMode: "PAY_PER_REQUEST" },
      ClientToken: "archive-import",
    }));
    const archived = await waitImport(ddb, importArchived.ImportTableDescription!.ImportArn!, clock);
    assert.equal(archived.ImportStatus, "FAILED");
    assert.match(String(archived.FailureCode), /S3InvalidObjectState|InvalidObjectState/);

    const migrated = migrateV85ToV86({
      schemaVersion: 85,
      installation: simulator.store.state.installation,
      accounts: {
        [accountId]: {
          iam: simulator.store.ensureAccount().iam,
          cloudwatchDashboards: {},
          regions: {
            [region]: {
              ...simulator.store.regionState(region),
              dynamodbExports: {
                "arn:aws:dynamodb:eu-west-1:000000000000:table/X/export/legacy": {
                  exportArn: "arn:aws:dynamodb:eu-west-1:000000000000:table/X/export/legacy",
                  exportStatus: "IN_PROGRESS",
                  startTime: clock.now(),
                  exportManifest: "m",
                  tableArn: tableArn,
                  tableId: "id",
                  exportTime: clock.now(),
                  clientToken: "legacy",
                  requestHash: "hash",
                  s3Bucket: allowed,
                  s3SseAlgorithm: "AES256",
                  exportFormat: "DYNAMODB_JSON",
                  billedSizeBytes: 0,
                  itemCount: 0,
                  exportType: "FULL_EXPORT",
                },
              },
              dynamodbImports: {},
            },
          },
        },
      },
    } as any);
    assert.equal(migrated.schemaVersion, 86);
    const legacy = Object.values(migrated.accounts[accountId].regions[region].dynamodbExports)[0];
    assert.equal(legacy.exportStatus, "FAILED");
    assert.equal(legacy.stage, "FAILED");
    assert.equal(legacy.failureCode, "MigrationInterrupted");
  } finally {
    ddb?.destroy(); s3Client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

function gzipLines(rows: unknown[]): Buffer {
  return gzipSync(Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n"));
}

test("DUG-12 overwrite conflict, deletion during import, and TABLE-stage resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug12-faults-"));
  const clock = new TestClock(Date.parse("2026-08-11T16:00:00Z"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let ddb: DynamoDBClient | undefined;
  let s3Client: S3Client | undefined;
  try {
    await simulator.start();
    ddb = dynamo(simulator);
    s3Client = s3(simulator);
    const tableArn = await prepareSource(ddb, clock, "FaultSource");
    const bucket = "dug12-fault-bucket";
    await s3Client.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3Client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: transferPolicy(bucket) }));

    const conflicted = await ddb.send(new ExportTableToPointInTimeCommand({
      TableArn: tableArn,
      S3Bucket: bucket,
      S3Prefix: "conflict",
      ClientToken: "overwrite-conflict",
    }));
    const conflictArn = conflicted.ExportDescription!.ExportArn!;
    const conflictJob = simulator.store.regionState(region).dynamodbExports[conflictArn];
    await s3Client.send(new PutObjectCommand({ Bucket: bucket, Key: conflictJob.dataKey!, Body: Buffer.from("foreign-bytes") }));
    const conflictedResult = await waitExport(ddb, conflictArn, clock);
    assert.equal(conflictedResult.ExportStatus, "FAILED");
    assert.equal(conflictedResult.FailureCode, "S3ObjectConflict");

    const exported = await ddb.send(new ExportTableToPointInTimeCommand({
      TableArn: tableArn,
      S3Bucket: bucket,
      S3Prefix: "ok",
      ClientToken: "fault-export",
    }));
    const completed = await waitExport(ddb, exported.ExportDescription!.ExportArn!, clock);
    assert.equal(completed.ExportStatus, "COMPLETED");
    const exportId = exported.ExportDescription!.ExportArn!.split("/export/")[1];
    const dataKey = `ok/AWSDynamoDB/${exportId}/data/data.json.gz`;

    const importing = await ddb.send(new ImportTableCommand({
      S3BucketSource: { S3Bucket: bucket, S3KeyPrefix: `ok/AWSDynamoDB/${exportId}/data` },
      InputFormat: "DYNAMODB_JSON",
      InputCompressionType: "GZIP",
      TableCreationParameters: {
        TableName: "DeletedDuringImport",
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      },
      ClientToken: "delete-during-import",
    }));
    const importArn = importing.ImportTableDescription!.ImportArn!;
    const pinnedJob = simulator.store.regionState(region).dynamodbImports[importArn];
    const caller = { servicePrincipal: "dynamodb.amazonaws.com" as const, sourceAccount: accountId, sourceArn: importArn };
    const admittedPins = await simulator.s3.createTransferPort().listAndPinPrefix(bucket, `ok/AWSDynamoDB/${exportId}/data`, caller);
    pinnedJob.pinnedObjects = admittedPins.map(pin => ({ ...pin }));
    pinnedJob.stage = "MANIFEST";
    await simulator.store.save();
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: dataKey }));
    ddb.destroy(); s3Client.destroy(); ddb = undefined; s3Client = undefined; await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
    await simulator.start();
    ddb = dynamo(simulator);
    s3Client = s3(simulator);
    const deleted = await waitImport(ddb, importArn, clock);
    assert.equal(deleted.ImportStatus, "COMPLETED");
    assert.equal((await ddb.send(new GetItemCommand({ TableName: "DeletedDuringImport", Key: { id: { S: "one" } } }))).Item?.note?.S, "alpha");

    await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: "resume/data.json.gz",
      Body: gzipLines([{ Item: { id: { S: "resume" }, note: { S: "ok" } } }]),
    }));
    const resumeImport = await ddb.send(new ImportTableCommand({
      S3BucketSource: { S3Bucket: bucket, S3KeyPrefix: "resume/" },
      InputFormat: "DYNAMODB_JSON",
      InputCompressionType: "GZIP",
      TableCreationParameters: {
        TableName: "ResumeTableStage",
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      },
      ClientToken: "resume-table-stage",
    }));
    const resumeArn = resumeImport.ImportTableDescription!.ImportArn!;
    for (let index = 0; index < 40; index++) {
      await flush(clock, 2);
      const job = simulator.store.regionState(region).dynamodbImports[resumeArn];
      if (job.stage === "TABLE" || job.stage === "POPULATE" || job.importStatus !== "IN_PROGRESS") break;
    }
    const paused = simulator.store.regionState(region).dynamodbImports[resumeArn];
    if (paused.importStatus === "IN_PROGRESS" && paused.stage && ["TABLE", "POPULATE", "VALIDATE", "PROMOTE"].includes(paused.stage)) {
      paused.stage = "TABLE";
      await simulator.store.save();
      ddb.destroy(); s3Client.destroy(); ddb = undefined; s3Client = undefined; await simulator.stop();
      simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
      await simulator.start();
      ddb = dynamo(simulator);
      const resumed = await waitImport(ddb, resumeArn, clock);
      assert.equal(resumed.ImportStatus, "COMPLETED");
      assert.equal(resumed.ImportedItemCount, 1);
      assert.equal((await ddb.send(new GetItemCommand({ TableName: "ResumeTableStage", Key: { id: { S: "resume" } } }))).Item?.note?.S, "ok");
    } else {
      const finished = await waitImport(ddb, resumeArn, clock);
      assert.equal(finished.ImportStatus, "COMPLETED");
    }
  } finally {
    ddb?.destroy(); s3Client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("DUG-12 transfer port retains admitted generations for unversioned object replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug12-pin-"));
  const clock = new TestClock(Date.parse("2026-08-11T15:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let s3Client: S3Client | undefined;
  try {
    await simulator.start();
    s3Client = s3(simulator);
    const bucket = "dug12-pin-bucket";
    await s3Client.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3Client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: transferPolicy(bucket) }));
    await s3Client.send(new PutObjectCommand({ Bucket: bucket, Key: "data/data.json.gz", Body: gzipLines([{ Item: { id: { S: "pinned" }, v: { N: "1" } } }]) }));
    const port = simulator.s3.createTransferPort();
    const caller = {
      servicePrincipal: "dynamodb.amazonaws.com" as const,
      sourceAccount: accountId,
      sourceArn: `arn:aws:dynamodb:${region}:${accountId}:table/PinnedImport/import/test`,
    };
    const pin = await port.pinCurrentObject(bucket, "data/data.json.gz", caller);
    assert.equal(pin.versionId, "null");
    const first = await collect(port.readPinned(pin, caller));
    assert.equal(JSON.parse(gunzipSync(first).toString("utf8").trim()).Item.v.N, "1");
    await s3Client.send(new PutObjectCommand({ Bucket: bucket, Key: "data/data.json.gz", Body: gzipLines([{ Item: { id: { S: "pinned" }, v: { N: "2" } } }]) }));
    const stillPinned = await collect(port.readPinned(pin, caller));
    assert.equal(JSON.parse(gunzipSync(stillPinned).toString("utf8").trim()).Item.v.N, "1");
    const replaced = await port.pinCurrentObject(bucket, "data/data.json.gz", caller);
    assert.notEqual(replaced.generation, pin.generation);
    assert.equal(JSON.parse(gunzipSync(await collect(port.readPinned(replaced, caller))).toString("utf8").trim()).Item.v.N, "2");
  } finally {
    s3Client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});
