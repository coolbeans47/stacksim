import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SystemClock } from "../src/core/clock.js";
import { RdsManager } from "../src/rds.js";
import { EmbeddedSqliteProvider } from "../src/rds/embedded-sqlite.js";
import { StateStore } from "../src/state.js";

const account = "000000000000";
const region = "us-east-1";
const identifier = "recoverable-aurora";
const input = { DBClusterIdentifier: identifier, Engine: "aurora-mysql", DatabaseName: "app", MasterUsername: "developer", MasterUserPassword: "Cluster-recovery-private1", DeletionProtection: true };

async function openManager(root: string) {
  const store = new StateStore(root, account, region);
  await store.load();
  const manager = new RdsManager(store, new EmbeddedSqliteProvider({ instancesRoot: join(root, "data", "rds", "instances") }), new SystemClock());
  await manager.start();
  return { manager, store };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "stacksim-aurora-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { manager, store } = await openManager(root);
  await manager.createCluster(region, input);
  await manager.stop(); // Drains provisioning and leaves the volume closed.
  const cluster = store.regionState(region).rdsDbClusters[identifier];
  assert.equal(cluster.status, "available");
  const rdsRoot = join(root, "data", "rds");
  const volume = join(rdsRoot, "instances", cluster.storageResourceId);
  const secret = join(rdsRoot, "secrets", cluster.storageResourceId + ".json");
  return { root, store, cluster, volume, secret };
}

test("Aurora startup resumes a reserved empty volume, retains its generation, and completes tombstoned deletion", async t => {
  const { root, store, cluster, volume, secret } = await fixture(t);
  const credential = await readFile(secret, "utf8");
  await rm(volume, { recursive: true });
  await mkdir(volume); // Process stopped between resource-directory creation and marker publication.
  cluster.status = "creating";
  delete store.state.installation.rds.clusterLease;
  await store.save();

  const reopened = await openManager(root);
  const recovered = reopened.store.regionState(region).rdsDbClusters[identifier];
  assert.equal(recovered.status, "available");
  assert.equal(recovered.dbClusterResourceId, cluster.dbClusterResourceId);
  assert.equal(reopened.store.state.installation.rds.clusterLease?.dbClusterResourceId, cluster.dbClusterResourceId);
  assert.equal(await readFile(secret, "utf8"), credential);
  await reopened.manager.stop();

  recovered.status = "deleting";
  recovered.deletionProtection = false;
  await reopened.store.save();
  await rename(volume, volume + ".deleting");
  const deleted = await openManager(root);
  assert.deepEqual(deleted.manager.describeClusters(region, {}), []);
  assert.equal(deleted.manager.accountQuota().used, 0);
  await assert.rejects(readFile(secret), { code: "ENOENT" });
  await assert.rejects(readFile(join(volume + ".deleting", ".stacksim-rds-sqlite.json")), { code: "ENOENT" });
  await deleted.manager.stop();
});

for (const window of ["staging first marker", "initializing after marker", "after storage publication"]) {
  test("Aurora startup resumes create interrupted " + window, async t => {
    const { root, store, volume, cluster } = await fixture(t);
    const markerPath = join(volume, ".stacksim-rds-sqlite.json");
    if (window === "staging first marker") {
      await rm(volume, { recursive: true });
      await mkdir(volume);
      await writeFile(markerPath + ".initializing", '{"schemaVer');
    } else if (window === "initializing after marker") {
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      await writeFile(markerPath, JSON.stringify({ ...marker, state: "initializing" }));
      await rm(join(volume, "logs"), { recursive: true });
    }
    cluster.status = "creating";
    await store.save();
    const { manager } = await openManager(root);
    const [recovered] = manager.describeClusters(region, {});
    assert.equal(recovered.status, "available");
    assert.equal(recovered.dbClusterResourceId, cluster.dbClusterResourceId);
    assert.equal(JSON.parse(await readFile(markerPath, "utf8")).state, "ready");
    assert.equal(await readFile(join(volume, "logs", "sqlite.log"), "utf8"), "");
    assert.equal((await readFile(join(volume, "data", "app.sqlite"))).subarray(0, 15).toString(), "SQLite format 3");
    await manager.stop();
  });
}

test("Aurora startup unwinds admission interrupted before publishing the credential", async t => {
  const { root, store, cluster, volume, secret } = await fixture(t);
  await rm(volume, { recursive: true });
  await rm(secret);
  const staging = secret + ".d9696421-8e79-4825-a27c-fd631e9c6098.tmp";
  await writeFile(staging, input.MasterUserPassword);
  const foreign = join(root, "data", "rds", "secrets", "db-1234567890abcdef1234567890.json.d9696421-8e79-4825-a27c-fd631e9c6098.tmp");
  const unrelated = secret + ".notes.tmp";
  await writeFile(foreign, "another generation");
  await writeFile(unrelated, "unrelated file");
  cluster.status = "creating";
  await store.save();
  const { manager } = await openManager(root);
  assert.deepEqual(manager.describeClusters(region, {}), []);
  assert.equal(manager.accountQuota().used, 0);
  await assert.rejects(readFile(staging), { code: "ENOENT" });
  assert.equal(await readFile(foreign, "utf8"), "another generation");
  assert.equal(await readFile(unrelated, "utf8"), "unrelated file");
  await manager.stop();
});

test("Aurora reports a lost database as failed without recreating it and permits protected-resource cleanup", async t => {
  const { root, cluster, volume, secret } = await fixture(t);
  const databasePath = join(volume, "data", "app.sqlite");
  await rm(databasePath);
  const { manager } = await openManager(root);
  const [failed] = manager.describeClusters(region, {});
  assert.equal(failed.status, "failed");
  assert.equal(failed.dbClusterResourceId, cluster.dbClusterResourceId);
  await assert.rejects(readFile(databasePath), { code: "ENOENT" });
  await assert.rejects(manager.deleteCluster(region, { DBClusterIdentifier: identifier, SkipFinalSnapshot: true }), /disable deletion protection/);
  await assert.rejects(manager.modifyCluster(region, { DBClusterIdentifier: identifier, DeletionProtection: false, CopyTagsToSnapshot: true }), /available/);
  await manager.modifyCluster(region, { DBClusterIdentifier: identifier, DeletionProtection: false, ApplyImmediately: true });
  await manager.deleteCluster(region, { DBClusterIdentifier: identifier, SkipFinalSnapshot: true });
  await manager.stop();
  assert.equal(manager.accountQuota().used, 0);
  await assert.rejects(readFile(secret), { code: "ENOENT" });
});
