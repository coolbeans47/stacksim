import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand, DeleteStackCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import {
  createRdsDbInstanceProvider,
  createRdsDbParameterGroupProvider,
  RDS_DB_INSTANCE_SCHEMA,
  type RdsDbInstanceModel,
} from "../src/cloudformation/providers/rds.js";
import { SystemClock } from "../src/core/clock.js";
import { EmbeddedSqliteProvider } from "../src/rds/embedded-sqlite.js";
import { RdsEngineProviderError, type RdsEngineProvider } from "../src/rds/provider.js";
import { RdsManager } from "../src/rds.js";
import { StackSim } from "../src/server.js";
import { StateStore } from "../src/state.js";
import { waitUntil } from "./support/polling.js";

const accountId = "000000000000";
const region = "eu-west-1";
const identity: PrincipalContext = {
  accessKeyId: "admin",
  principalArn: `arn:aws:iam::${accountId}:root`,
  principalId: accountId,
  accountId,
};

function context(logicalId: string, operationId = "operation-1"): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/rds-provider/stack-id`,
    logicalId,
    operationId,
    resourceOperationId: `${operationId}-${logicalId}`,
    idempotencyKey: `${operationId}-${logicalId}-key`,
    deadlineAt: Date.now() + 60_000,
    principal: { identity },
  };
}

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  assert.ok(port >= 1_150, `expected an RDS-compatible ephemeral port, got ${port}`);
  return port;
}

async function waitForStack(client: CloudFormationClient, stackName: string, expected: string): Promise<void> {
  await waitUntil(
    async () => (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0],
    stack => {
      const status = stack?.StackStatus;
      if (status?.endsWith("FAILED") || status?.includes("ROLLBACK")) assert.fail(`Stack ${stackName} reached ${status} while waiting for ${expected}`);
      return status === expected;
    },
    { timeoutMessage: stack => `Stack ${stackName} did not reach ${expected}; current=${stack?.StackStatus} reason=${stack?.StackStatusReason}` },
  );
}

async function rdsHarness(root: string): Promise<{ store: StateStore; manager: RdsManager }> {
  const store = new StateStore(root, accountId, region);
  await store.load();
  const engine = new EmbeddedSqliteProvider({ instancesRoot: join(root, "data", "rds", "instances") });
  const manager = new RdsManager(store, engine, new SystemClock());
  await manager.start();
  return { store, manager };
}

async function waitForInstanceRead(
  provider: ReturnType<typeof createRdsDbInstanceProvider>,
  physicalId: string,
  providerContext: ProviderContext,
): Promise<Extract<Awaited<ReturnType<typeof provider.read>>, { status: "SUCCESS" }>> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await provider.read(physicalId, providerContext);
    if (result.status === "SUCCESS") return result;
    if (result.status === "FAILED") assert.fail(`${result.errorCode}: ${result.message}`);
    if (result.status === "NOT_FOUND") assert.fail(`DB instance ${physicalId} disappeared while waiting for readiness`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`DB instance ${physicalId} did not become readable`);
}

async function completeInstanceUpdate(
  provider: ReturnType<typeof createRdsDbInstanceProvider>,
  physicalId: string,
  previous: RdsDbInstanceModel,
  desired: RdsDbInstanceModel,
  providerContext: ProviderContext,
): Promise<Extract<Awaited<ReturnType<typeof provider.update>>, { status: "SUCCESS" }>> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await provider.update(physicalId, previous, desired, providerContext);
    if (result.status === "SUCCESS") return result;
    if (result.status === "FAILED") assert.fail(`${result.errorCode}: ${result.message}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`DB instance ${physicalId} update did not complete`);
}

test("CFN-13 DBParameterGroup covers the bounded six-parameter model, retry, and deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn13-parameter-group-"));
  let manager: RdsManager | undefined;
  try {
    const harness = await rdsHarness(root); manager = harness.manager;
    const provider = createRdsDbParameterGroupProvider(manager, region);
    const providerContext = context("DatabaseParameters");
    const initial = provider.canonicalize({
      Description: "Orders database parameters",
      Family: "mysql8.0",
      Parameters: {
        character_set_server: "utf8mb4",
        max_connections: 200,
        wait_timeout: "600",
        max_allowed_packet: 33_554_432,
        innodb_flush_log_at_trx_commit: 2,
        collation_server: "utf8mb4_general_ci",
      },
      Tags: [{ Key: "service", Value: "orders" }],
    }, providerContext);

    assert.deepEqual(initial.Parameters, {
      character_set_server: "utf8mb4",
      collation_server: "utf8mb4_general_ci",
      innodb_flush_log_at_trx_commit: "2",
      max_allowed_packet: "33554432",
      max_connections: "200",
      wait_timeout: "600",
    });
    assert.ok(provider.validate({ Description: "invalid", Family: "mysql8.0", Parameters: { character_set_server: "latin1" } }, providerContext).some(issue => issue.path === "Properties.Parameters"));

    const created = await provider.create(initial, providerContext);
    assert.equal(created.status, "SUCCESS");
    if (created.status !== "SUCCESS") return;
    const physicalId = created.physicalId;
    assert.match(physicalId, /^rds-provider-databaseparameters-[a-f0-9]{12}$/);
    assert.equal(provider.ref(created.model), physicalId);
    assert.match(String(provider.getAtt(created.model, "Arn")), new RegExp(`:pg:${physicalId}$`));

    const described = manager.describeParameters(region, { DBParameterGroupName: physicalId });
    const byName = Object.fromEntries(described.map(parameter => [parameter.ParameterName, parameter]));
    for (const name of ["max_connections", "wait_timeout", "max_allowed_packet", "innodb_flush_log_at_trx_commit"]) {
      assert.equal(byName[name].Source, "user");
      assert.equal(byName[name].ApplyType, "dynamic");
      assert.equal(byName[name].ApplyMethod, "immediate");
    }
    assert.equal(byName.collation_server.Source, "user");
    assert.equal(byName.collation_server.ApplyType, "static");
    assert.equal(byName.collation_server.ApplyMethod, "pending-reboot");
    assert.equal(byName.character_set_server.Source, "engine-default");
    assert.equal(byName.character_set_server.IsModifiable, false);

    const read = await provider.read(physicalId, providerContext);
    assert.equal(read.status, "SUCCESS");
    if (read.status !== "SUCCESS") return;
    assert.deepEqual(read.model.properties, initial);

    const desired = provider.canonicalize({
      Description: "Orders database parameters",
      Family: "mysql8.0",
      Parameters: {
        character_set_server: "utf8mb4",
        max_connections: 250,
        max_allowed_packet: 33_554_432,
        innodb_flush_log_at_trx_commit: 2,
      },
      Tags: [{ Key: "environment", Value: "test" }],
    }, providerContext);
    assert.deepEqual(provider.plan(initial, desired, providerContext), {
      action: "UPDATE",
      desired,
      changedProperties: ["Parameters", "Tags"],
      replacementProperties: [],
    });
    const updated = await provider.update(physicalId, initial, desired, providerContext);
    assert.equal(updated.status, "SUCCESS");
    if (updated.status !== "SUCCESS") return;
    assert.deepEqual(updated.model.properties, desired);
    assert.equal(Object.hasOwn(harness.store.regionState(region).rdsDbParameterGroups[physicalId].parameters, "wait_timeout"), false);
    assert.equal(Object.hasOwn(harness.store.regionState(region).rdsDbParameterGroups[physicalId].parameters, "collation_server"), false);

    const stateBeforeRetry = structuredClone(harness.store.regionState(region).rdsDbParameterGroups[physicalId]);
    const retried = await provider.update(physicalId, initial, desired, providerContext);
    assert.equal(retried.status, "SUCCESS");
    assert.deepEqual(harness.store.regionState(region).rdsDbParameterGroups[physicalId], stateBeforeRetry, "a lost update response must reconcile without rewriting service state");

    const replacement = provider.canonicalize({ ...desired, Description: "Replacement description" }, providerContext);
    const replacementPlan = provider.plan(desired, replacement, providerContext);
    assert.equal(replacementPlan.action, "REPLACE");
    assert.deepEqual(replacementPlan.replacementProperties, ["Description"]);
    assert.equal(replacementPlan.replacementOrder, "CREATE_BEFORE_DELETE");

    assert.equal((await provider.delete(physicalId, desired, providerContext)).status, "SUCCESS");
    assert.equal((await provider.read(physicalId, providerContext)).status, "NOT_FOUND");
    assert.equal((await provider.delete(physicalId, desired, providerContext)).status, "NOT_FOUND");
  } finally {
    await manager?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CFN-13 DBInstance canonicalizes, reconciles mutable updates, protects deletion, and deletes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn13-db-instance-"));
  let manager: RdsManager | undefined;
  try {
    const harness = await rdsHarness(root); manager = harness.manager;
    const provider = createRdsDbInstanceProvider(manager, region);
    const providerContext = context("Database");
    const initialPort = await freePort();
    const nextPort = await freePort();
    const initial = provider.canonicalize({
      DBInstanceIdentifier: "orders-db",
      DBInstanceClass: "db.t3.micro",
      Engine: "MySQL",
      MasterUsername: "appuser",
      MasterUserPassword: "InitialSecret123",
      Port: String(initialPort),
      Tags: [{ Key: "service", Value: "orders" }],
    }, providerContext);
    assert.deepEqual(initial, {
      AllocatedStorage: "20",
      BackupRetentionPeriod: 0,
      DBInstanceClass: "db.t3.micro",
      DBInstanceIdentifier: "orders-db",
      DBParameterGroupName: "default.mysql8.0",
      DeletionProtection: false,
      Engine: "mysql",
      EngineVersion: "8.0",
      ManageMasterUserPassword: false,
      MasterUsername: "appuser",
      MasterUserPassword: "InitialSecret123",
      MultiAZ: false,
      Port: String(initialPort),
      PubliclyAccessible: false,
      StorageType: "gp3",
      Tags: [{ Key: "service", Value: "orders" }],
    });

    const create = await provider.create(initial, providerContext);
    assert.equal(create.status, "IN_PROGRESS");
    const ready = await waitForInstanceRead(provider, "orders-db", providerContext);
    assert.equal(ready.model.properties.MasterUserPassword, "InitialSecret123");
    assert.equal(ready.model.attributes["Endpoint.Address"], "127.0.0.1");
    assert.equal(ready.model.attributes["Endpoint.Port"], String(initialPort));
    assert.equal(provider.ref(ready.model), "orders-db");
    assert.equal(provider.getAtt(ready.model, "Endpoint.Port"), String(initialPort));
    assert.equal((await provider.create(initial, providerContext)).status, "SUCCESS", "a lost create response must reconcile the owned instance");

    const desired = provider.canonicalize({
      ...initial,
      AllocatedStorage: "30",
      DeletionProtection: true,
      MasterUserPassword: "RotatedSecret456",
      Port: String(nextPort),
      StorageType: "gp2",
      Tags: [{ Key: "environment", Value: "test" }, { Key: "service", Value: "orders-api" }],
    }, providerContext);
    const updatePlan = provider.plan(initial, desired, providerContext);
    assert.equal(updatePlan.action, "UPDATE");
    assert.deepEqual(updatePlan.changedProperties, ["AllocatedStorage", "DeletionProtection", "MasterUserPassword", "Port", "StorageType", "Tags"]);
    const updated = await completeInstanceUpdate(provider, "orders-db", initial, desired, providerContext);
    assert.deepEqual(updated.model.properties, desired);
    assert.equal(harness.store.regionState(region).rdsDbInstances["orders-db"].allocatedStorage, 30);
    assert.equal(harness.store.regionState(region).rdsDbInstances["orders-db"].storageType, "gp2");
    assert.equal(harness.store.regionState(region).rdsDbInstances["orders-db"].deletionProtection, true);
    assert.equal(harness.store.regionState(region).rdsDbInstances["orders-db"].port, nextPort);

    const updateRetry = await provider.update("orders-db", initial, desired, providerContext);
    assert.equal(updateRetry.status, "SUCCESS", "a lost mutable-update response must converge on retry");

    const protectedDelete = await provider.delete("orders-db", desired, providerContext);
    assert.equal(protectedDelete.status, "FAILED");
    if (protectedDelete.status === "FAILED") assert.equal(protectedDelete.errorCode, "InvalidParameterCombination");
    assert.equal((await provider.read("orders-db", providerContext)).status, "SUCCESS");

    const replacement = provider.canonicalize({ ...desired, DBInstanceIdentifier: "orders-replacement" }, providerContext);
    assert.throws(() => provider.plan(desired, replacement, providerContext), /singleton RDS slot cannot perform CloudFormation replacement for DBInstanceIdentifier/);
    const replacementUpdate = await provider.update("orders-db", desired, replacement, providerContext);
    assert.equal(replacementUpdate.status, "FAILED");
    if (replacementUpdate.status === "FAILED") assert.equal(replacementUpdate.errorCode, "RequiresReplacement");

    const deletable = provider.canonicalize({ ...desired, DeletionProtection: false }, providerContext);
    await completeInstanceUpdate(provider, "orders-db", desired, deletable, providerContext);
    const deleting = await provider.delete("orders-db", deletable, providerContext);
    assert.equal(deleting.status, "IN_PROGRESS");
    let terminal: Awaited<ReturnType<typeof provider.delete>> | undefined;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      terminal = await provider.delete("orders-db", deletable, providerContext);
      if (terminal.status === "NOT_FOUND") break;
      if (terminal.status === "FAILED") assert.fail(`${terminal.errorCode}: ${terminal.message}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(terminal?.status, "NOT_FOUND");
    assert.equal(harness.store.state.installation.rds.instanceLease, undefined);
  } finally {
    await manager?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CFN-13 failed protected create durably cleans up its singleton lease before surfacing failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn13-failed-create-"));
  let destroyCalls = 0;
  const engine: RdsEngineProvider = {
    async discover() { return { providerName: "failing-test-provider", engineVersion: "8.0", version: "test" }; },
    async initialize() { throw new RdsEngineProviderError("INITIALIZATION_FAILED", "intentional provider startup failure"); },
    async start() { throw new Error("start must not run after initialization fails"); },
    async readiness() { throw new Error("readiness must not run after initialization fails"); },
    async rotateMasterPassword() { throw new Error("password rotation is outside this test"); },
    async applyParameters() { throw new Error("parameter updates are outside this test"); },
    async stop() {},
    async reconfigure() { throw new Error("reconfiguration is outside this test"); },
    async destroy() { destroyCalls += 1; },
  };
  const store = new StateStore(root, accountId, region);
  await store.load();
  const manager = new RdsManager(store, engine, new SystemClock());
  try {
    await manager.start();
    const provider = createRdsDbInstanceProvider(manager, region);
    const providerContext = context("FailedDatabase");
    const desired = provider.canonicalize({
      DBInstanceIdentifier: "failed-protected-db",
      DBInstanceClass: "db.t3.micro",
      Engine: "mysql",
      MasterUsername: "appuser",
      MasterUserPassword: "FailureSecret123",
      Port: String(await freePort()),
      DeletionProtection: true,
    }, providerContext);

    assert.equal((await provider.create(desired, providerContext)).status, "IN_PROGRESS");
    for (let attempt = 0; attempt < 300 && store.regionState(region).rdsDbInstances["failed-protected-db"]?.dbInstanceStatus !== "failed"; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const failedState = store.regionState(region).rdsDbInstances["failed-protected-db"];
    assert.equal(failedState?.dbInstanceStatus, "failed");
    assert.equal(failedState?.deletionProtection, true, "the requested property remains authoritative until CFN owns cleanup");

    const cleanup = await provider.create(desired, providerContext);
    assert.equal(cleanup.status, "IN_PROGRESS");
    if (cleanup.status !== "IN_PROGRESS") return;
    assert.equal(cleanup.checkpoint.callbackContext?.phase, "cleanup-failed-create");
    const retryContext: ProviderContext = { ...providerContext, callbackContext: cleanup.checkpoint.callbackContext };
    let terminal: Awaited<ReturnType<typeof provider.create>> | undefined;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      terminal = await provider.create(desired, retryContext);
      if (terminal.status === "FAILED") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(terminal?.status, "FAILED");
    if (terminal?.status === "FAILED") {
      assert.equal(terminal.errorCode, "DBInstanceFailed");
      assert.match(terminal.message, /intentional provider startup failure/);
    }
    assert.equal(store.regionState(region).rdsDbInstances["failed-protected-db"], undefined);
    assert.equal(store.state.installation.rds.instanceLease, undefined);
    assert.equal(destroyCalls, 1);
  } finally {
    await manager.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("RDS-03 enables real CloudFormation Snapshot deletion for DB instances", async () => {
  assert.equal(RDS_DB_INSTANCE_SCHEMA.retention.snapshotSupported, true);
  assert.deepEqual(RDS_DB_INSTANCE_SCHEMA.retention.deletionPolicies, ["Delete", "Retain", "RetainExceptOnCreate", "Snapshot"]);
  assert.deepEqual(RDS_DB_INSTANCE_SCHEMA.retention.updateReplacePolicies, ["Delete", "Retain", "RetainExceptOnCreate"]);

  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-rds03-snapshot-")); let manager: RdsManager | undefined;
  try {
    const harness = await rdsHarness(root); manager = harness.manager; const provider = createRdsDbInstanceProvider(manager, region);
    const providerContext = { ...context("Database", "snapshot-delete"), retentionPolicy: "Snapshot" as const };
    const desired = provider.canonicalize({ DBInstanceIdentifier: "cfn-snapshot-db", AllocatedStorage: "20", BackupRetentionPeriod: 0, DBInstanceClass: "db.t3.micro", DBParameterGroupName: "default.mysql8.0", DeletionProtection: false, Engine: "mysql", EngineVersion: "8.0", MasterUsername: "appuser", MasterUserPassword: "BoundarySecret123", MultiAZ: false, Port: String(await freePort()), PubliclyAccessible: false, StorageType: "gp3", Tags: [] }, providerContext);
    assert.equal((await provider.create(desired, providerContext)).status, "IN_PROGRESS"); await waitForInstanceRead(provider, "cfn-snapshot-db", providerContext);
    assert.equal((await provider.delete("cfn-snapshot-db", desired, providerContext)).status, "IN_PROGRESS");
    let terminal: Awaited<ReturnType<typeof provider.delete>> | undefined;
    for (let attempt = 0; attempt < 300; attempt += 1) { terminal = await provider.delete("cfn-snapshot-db", desired, providerContext); if (terminal.status === "NOT_FOUND") break; if (terminal.status === "FAILED") assert.fail(`${terminal.errorCode}: ${terminal.message}`); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(terminal?.status, "NOT_FOUND");
    const snapshots = Object.values(harness.store.regionState(region).rdsDbSnapshots); assert.equal(snapshots.length, 1); assert.equal(snapshots[0].status, "available"); assert.match(snapshots[0].dbSnapshotIdentifier, /^cfn-[a-f0-9]{40}$/);
  } finally { await manager?.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("CloudFormation applies the RDS Snapshot default when an update removes the DB instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-rds03-update-removal-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off", rdsStartupTimeoutMs: 45_000 });
  let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start();
    cloudformation = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials: { accessKeyId: "test", secretAccessKey: "test" }, maxAttempts: 1 });
    const template = JSON.stringify({ Resources: { Database: { Type: "AWS::RDS::DBInstance", Properties: { DBInstanceIdentifier: "cfn-update-removal-db", AllocatedStorage: "20", BackupRetentionPeriod: 0, DBInstanceClass: "db.t3.micro", Engine: "mysql", EngineVersion: "8.0", MasterUsername: "appuser", MasterUserPassword: "SnapshotDefaultSecret123", MultiAZ: false, Port: String(await freePort()), PubliclyAccessible: false, StorageType: "gp3" } } } });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "rds-snapshot-default", TemplateBody: template }));
    await waitForStack(cloudformation, created.StackId!, "CREATE_COMPLETE");
    await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: JSON.stringify({ Resources: {} }) }));
    await waitForStack(cloudformation, created.StackId!, "UPDATE_COMPLETE");
    assert.equal(simulator.store.regionState(region).rdsDbInstances["cfn-update-removal-db"], undefined);
    const snapshots = Object.values(simulator.store.regionState(region).rdsDbSnapshots);
    assert.equal(snapshots.length, 1); assert.equal(snapshots[0].status, "available"); assert.match(snapshots[0].dbSnapshotIdentifier, /^cfn-[a-f0-9]{40}$/);
    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
    await waitForStack(cloudformation, created.StackId!, "DELETE_COMPLETE");
  } finally {
    cloudformation?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
