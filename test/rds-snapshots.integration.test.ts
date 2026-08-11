import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AddTagsToResourceCommand,
  CopyDBSnapshotCommand,
  CreateDBInstanceCommand,
  CreateDBSnapshotCommand,
  DeleteDBInstanceCommand,
  DeleteDBSnapshotCommand,
  DescribeDBInstancesCommand,
  DescribeDBSnapshotAttributesCommand,
  DescribeDBSnapshotsCommand,
  ListTagsForResourceCommand,
  ModifyDBSnapshotAttributeCommand,
  RDSClient,
} from "@aws-sdk/client-rds";
import knexFactory from "knex";
import mysql from "mysql2/promise";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const KNEX_VERSION = "3.3.0";

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address(); const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

function client(simulator: StackSim, region = "eu-west-1"): RDSClient {
  return new RDSClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
}

async function waitForStatus(rds: RDSClient, identifier: string, status: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const instance = (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }))).DBInstances?.[0];
    if (instance?.DBInstanceStatus === status) return instance;
    if (instance?.DBInstanceStatus === "failed") assert.fail(instance.StatusInfos?.[0]?.Message ?? `${identifier} failed`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`${identifier} did not reach ${status}`);
}

async function waitForDeletion(rds: RDSClient, identifier: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier })); }
    catch (error: any) { if (error?.name === "DBInstanceNotFoundFault" || error?.Code === "DBInstanceNotFound") return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`${identifier} was not deleted`);
}

async function rawRds(simulator: StackSim, action: string, input: Record<string, string | number | boolean>) {
  const body = new URLSearchParams({ Action: action, Version: "2014-10-31" });
  for (const [key, value] of Object.entries(input)) body.set(key, String(value));
  return fetch(`http://127.0.0.1:${simulator.port}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-service": "rds" }, body });
}

test("RDS-03 manual snapshots, copy, restore, final snapshot, restart cleanup, and pinned ORM learning proof", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds03-"));
  const sourcePort = await freePort(); const restorePort = await freePort();
  const sourcePassword = "SourceSnapshotSecret123"; const restoredPassword = "RestoredSnapshotSecret456";
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir, authMode: "off", rdsStartupTimeoutMs: 45_000 });
  let rds: RDSClient | undefined; let knex: ReturnType<typeof knexFactory> | undefined;
  try {
    await simulator.start(); rds = client(simulator);
    await rds.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: "snapshot-source", DBInstanceClass: "db.t3.micro", Engine: "mysql", EngineVersion: "8.0", AllocatedStorage: 20, StorageType: "gp3", DBName: "learning", MasterUsername: "developer", MasterUserPassword: sourcePassword, Port: sourcePort, BackupRetentionPeriod: 0, PubliclyAccessible: false }));
    await waitForStatus(rds, "snapshot-source", "available");

    // LPP-05 learning proof uses the implementation-day pinned Knex fixture.
    knex = knexFactory({ client: "mysql2", connection: { host: "127.0.0.1", port: sourcePort, user: "developer", password: sourcePassword, database: "learning" }, pool: { min: 0, max: 2 } });
    await knex.schema.createTable("learning_rows", table => { table.increments("id").primary(); table.string("body", 200).notNullable(); table.binary("payload").notNullable(); });
    const generated = await knex("learning_rows").insert({ body: `before snapshot with Knex ${KNEX_VERSION}`, payload: Buffer.from([0, 1, 2, 250, 255]) });
    assert.equal(Number(generated[0]), 1);

    // An open uncommitted writer is drained and rolled back before the provider backup runs.
    const writer = await mysql.createConnection({ host: "127.0.0.1", port: sourcePort, user: "developer", password: sourcePassword, database: "learning" });
    await writer.beginTransaction(); await writer.execute("INSERT INTO learning_rows (body, payload) VALUES (?, ?)", ["uncommitted", Buffer.from("not durable")]);
    const created = await rds.send(new CreateDBSnapshotCommand({ DBInstanceIdentifier: "snapshot-source", DBSnapshotIdentifier: "learning-before-change", Tags: [{ Key: "stage", Value: "before" }] }));
    assert.equal(created.DBSnapshot?.Status, "available", simulator.store.regionState("eu-west-1").rdsDbSnapshots["learning-before-change"]?.statusMessage);
    await assert.rejects(writer.commit()); await writer.end().catch(() => undefined);

    const snapshotState = simulator.store.regionState("eu-west-1").rdsDbSnapshots["learning-before-change"];
    assert.match(snapshotState.manifestChecksum ?? "", /^[a-f0-9]{64}$/); assert.equal(snapshotState.fileCount, 1); assert.ok((snapshotState.dataSizeBytes ?? 0) > 0);
    const snapshotDirectory = join(dataDir, "data", "rds", "snapshots", snapshotState.snapshotResourceId);
    const manifestText = await readFile(join(snapshotDirectory, "manifest.json"), "utf8");
    assert.doesNotMatch(manifestText, new RegExp(sourcePassword)); assert.doesNotMatch(manifestText, /masterPassword|masterUsername/);
    const manifest = JSON.parse(manifestText); assert.equal(manifest.installationId, simulator.store.state.installation.id); assert.equal(manifest.files[0].sha256.length, 64);

    await rds.send(new ModifyDBSnapshotAttributeCommand({ DBSnapshotIdentifier: "learning-before-change", AttributeName: "restore", ValuesToAdd: ["all", simulator.store.accountId] }));
    const attributes = await rds.send(new DescribeDBSnapshotAttributesCommand({ DBSnapshotIdentifier: "learning-before-change" }));
    assert.deepEqual(attributes.DBSnapshotAttributesResult?.DBSnapshotAttributes?.[0]?.AttributeValues?.sort(), [simulator.store.accountId, "all"].sort());
    const snapshotArn = created.DBSnapshot?.DBSnapshotArn!;
    await rds.send(new AddTagsToResourceCommand({ ResourceName: snapshotArn, Tags: [{ Key: "owner", Value: "learning-proof" }] }));
    assert.deepEqual(Object.fromEntries((await rds.send(new ListTagsForResourceCommand({ ResourceName: snapshotArn }))).TagList!.map(tag => [tag.Key!, tag.Value!])), { owner: "learning-proof", stage: "before" });

    const copied = await rds.send(new CopyDBSnapshotCommand({ SourceDBSnapshotIdentifier: snapshotArn, TargetDBSnapshotIdentifier: "learning-copy", CopyTags: true, Tags: [{ Key: "copy", Value: "yes" }] }));
    assert.equal(copied.DBSnapshot?.Status, "available");
    assert.deepEqual(Object.fromEntries(copied.DBSnapshot?.TagList?.map(tag => [tag.Key!, tag.Value!]) ?? []), { copy: "yes", owner: "learning-proof", stage: "before" });

    // The destructive migration changes live state only; the immutable snapshot remains pre-change.
    await knex.schema.dropTable("learning_rows");
    await knex.schema.createTable("learning_rows", table => { table.increments("id").primary(); table.string("replacement", 40).notNullable(); });
    await knex("learning_rows").insert({ replacement: "destructive migration" });
    await knex.destroy(); knex = undefined;

    await rds.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: "snapshot-source", SkipFinalSnapshot: true, DeleteAutomatedBackups: true }));
    await waitForDeletion(rds, "snapshot-source");

    // A published snapshot in an interrupted control transition is recovered from its manifest.
    simulator.store.regionState("eu-west-1").rdsDbSnapshots["learning-before-change"].status = "creating";
    await simulator.store.save();
    const tempResourceId = "snapshot-aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const incomplete = join(dataDir, "data", "rds", "snapshots", `.tmp-${tempResourceId}-fault`);
    await mkdir(incomplete, { recursive: true });
    await writeFile(join(incomplete, ".stacksim-rds-snapshot-work.json"), JSON.stringify({ schemaVersion: 1, installationId: simulator.store.state.installation.id, snapshotResourceId: tempResourceId }));
    rds.destroy(); rds = undefined; await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, authMode: "off", rdsStartupTimeoutMs: 45_000 }); await simulator.start(); rds = client(simulator);
    assert.equal((await rds.send(new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: "learning-before-change" }))).DBSnapshots?.[0]?.Status, "available");
    assert.equal((await readdir(join(dataDir, "data", "rds", "snapshots"))).some(name => name.includes("fault")), false);

    const restoreResponse = await rawRds(simulator, "RestoreDBInstanceFromDBSnapshot", { DBInstanceIdentifier: "snapshot-restored", DBSnapshotIdentifier: snapshotArn, DBInstanceClass: "db.t3.micro", Port: restorePort, MasterUsername: "restoredadmin", MasterUserPassword: restoredPassword, DeletionProtection: false, PubliclyAccessible: false, MultiAZ: false, "Tags.Tag.1.Key": "identity", "Tags.Tag.1.Value": "restored" });
    assert.equal(restoreResponse.status, 200, await restoreResponse.text());
    await waitForStatus(rds, "snapshot-restored", "available");
    await assert.rejects(mysql.createConnection({ host: "127.0.0.1", port: restorePort, user: "developer", password: sourcePassword, database: "learning" }), (error: any) => error?.errno === 1045);
    const restored = await mysql.createConnection({ host: "127.0.0.1", port: restorePort, user: "restoredadmin", password: restoredPassword, database: "learning" });
    const [rows] = await restored.query("SELECT id, body, payload FROM learning_rows ORDER BY id");
    assert.deepEqual(rows, [{ id: 1, body: `before snapshot with Knex ${KNEX_VERSION}`, payload: Buffer.from([0, 1, 2, 250, 255]) }]);
    await restored.end();

    const pitr = await rawRds(simulator, "RestoreDBInstanceToPointInTime", { SourceDBInstanceIdentifier: "snapshot-source", TargetDBInstanceIdentifier: "pitr-target" });
    assert.equal(pitr.status, 400); assert.match(await pitr.text(), /Point-in-time recovery requires a bounded durable SQLite WAL\/checkpoint recovery design/);

    await rds.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: "snapshot-restored", SkipFinalSnapshot: false, FinalDBSnapshotIdentifier: "learning-final", DeleteAutomatedBackups: true }));
    await waitForDeletion(rds, "snapshot-restored");
    assert.equal((await rds.send(new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: "learning-final" }))).DBSnapshots?.[0]?.Status, "available");

    // Corruption is detected on restart and can never remain advertised as available.
    const copyState = simulator.store.regionState("eu-west-1").rdsDbSnapshots["learning-copy"];
    const copyManifest = JSON.parse(await readFile(join(dataDir, "data", "rds", "snapshots", copyState.snapshotResourceId, "manifest.json"), "utf8"));
    await writeFile(join(dataDir, "data", "rds", "snapshots", copyState.snapshotResourceId, "data", copyManifest.files[0].name), "corrupt");
    rds.destroy(); rds = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir, authMode: "off" }); await simulator.start(); rds = client(simulator);
    assert.equal((await rds.send(new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: "learning-copy" }))).DBSnapshots?.[0]?.Status, "failed");
    await rds.send(new DeleteDBSnapshotCommand({ DBSnapshotIdentifier: "learning-copy" }));
    await assert.rejects(rds.send(new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: "learning-copy" })), (error: any) => error?.name === "DBSnapshotNotFoundFault");

    // A corrupt manifest is no longer available but its independent ownership marker still permits exact cleanup.
    const finalState = simulator.store.regionState("eu-west-1").rdsDbSnapshots["learning-final"];
    const snapshotRoot = join(dataDir, "data", "rds", "snapshots");
    await writeFile(join(snapshotRoot, finalState.snapshotResourceId, "manifest.json"), "corrupt");
    assert.equal((await rds.send(new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: "learning-final" }))).DBSnapshots?.[0]?.Status, "failed");
    await rds.send(new DeleteDBSnapshotCommand({ DBSnapshotIdentifier: "learning-final" }));
    await assert.rejects(rds.send(new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: "learning-final" })), (error: any) => error?.name === "DBSnapshotNotFoundFault");

    // An interrupted owned tombstone is completed exactly on restart.
    const sourceState = simulator.store.regionState("eu-west-1").rdsDbSnapshots["learning-before-change"];
    const deletingName = `.deleting-${sourceState.snapshotResourceId}-fault`;
    await rename(join(snapshotRoot, sourceState.snapshotResourceId), join(snapshotRoot, deletingName));
    sourceState.status = "deleting"; await simulator.store.save();
    rds.destroy(); rds = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir, authMode: "off" }); await simulator.start(); rds = client(simulator);
    await assert.rejects(rds.send(new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: "learning-before-change" })), (error: any) => error?.name === "DBSnapshotNotFoundFault");
    assert.equal((await readdir(snapshotRoot)).includes(deletingName), false);
  } finally {
    await knex?.destroy().catch(() => undefined); rds?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true });
  }
});
