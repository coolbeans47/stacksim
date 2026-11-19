import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import {
  CreateDBClusterCommand, CreateDBInstanceCommand, CreateDBSnapshotCommand, DeleteDBClusterCommand, DeleteDBInstanceCommand,
  DescribeDBClustersCommand, DescribeDBInstancesCommand, ModifyDBClusterCommand, ModifyDBInstanceCommand, RDSClient, type DBInstance,
} from "@aws-sdk/client-rds";
import { CreateSecretCommand, GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { StackSim } from "../src/server.js";

const region = "us-east-1";
const clusterId = "app-db";
const writerId = "app-writer";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const writerRequest = { DBClusterIdentifier: clusterId, DBInstanceIdentifier: writerId, DBInstanceClass: "db.serverless", Engine: "aurora-mysql", PromotionTier: 0 };

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  do {
    const value = await read();
    if (accept(value)) return value;
    await delay(20);
  } while (Date.now() < deadline);
  return assert.fail("The RDS lifecycle transition did not finish");
}

test("the Aurora writer runs SQL on cluster storage through replacement, restart and final detach", async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-aurora-writer-"));
  const port = await freePort();
  const sql = { host: "127.0.0.1", database: "app", user: "developer", password: "WriterLifecyclePrivate123", port };
  const options = { dataDir: root, region, port: 0, invokePort: 0, authMode: "off" as const };
  let sim = new StackSim(options);
  let db: mysql.Connection | undefined;
  let rds: RDSClient;
  const start = async () => {
    await sim.start();
    rds = new RDSClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 });
  };
  t.after(async () => {
    await db?.end().catch(() => undefined); rds?.destroy();
    await sim.stop(); await rm(root, { recursive: true, force: true });
  });
  await start();
  const cluster = async () => (await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: clusterId }))).DBClusters![0];
  const members = async () => (await rds.send(new DescribeDBInstancesCommand({ Filters: [{ Name: "db-cluster-id", Values: [clusterId] }] }))).DBInstances ?? [];
  const writer = async (): Promise<DBInstance> => (await waitFor(members, list => list[0]?.DBInstanceStatus === "available"))[0];
  const attach = () => rds.send(new CreateDBInstanceCommand(writerRequest));
  const detach = () => rds.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: writerId }));
  await rds!.send(new CreateDBClusterCommand({
    DBClusterIdentifier: clusterId, Engine: "aurora-mysql", MasterUsername: sql.user, MasterUserPassword: sql.password, DatabaseName: sql.database,
    Port: port, ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
  }));
  const parent = await waitFor(cluster, value => value.Status === "available");
  assert.equal(parent.Endpoint, "127.0.0.1");
  await assert.rejects(rds!.send(new CreateDBInstanceCommand({ ...writerRequest, Engine: "aurora-postgresql" })), /InvalidParameterCombination/);
  const competing = await Promise.allSettled([attach(), attach()]);
  assert.equal(competing.filter(result => result.status === "fulfilled").length, 1);
  const original = await writer();
  assert.equal(original.DBClusterIdentifier, clusterId);
  assert.equal(original.Engine, parent.Engine);
  assert.equal(original.EngineVersion, parent.EngineVersion);
  assert.equal(original.Endpoint?.Port, port);
  assert.equal(original.DBName, "app");
  assert.equal(original.DBInstanceArn, `arn:aws:rds:${region}:000000000000:db:${writerId}`);
  const membership = (await cluster()).DBClusterMembers![0];
  assert.equal(membership.DBInstanceIdentifier, writerId);
  assert.equal(membership.IsClusterWriter, true);
  assert.equal(membership.PromotionTier, 0);
  await assert.rejects(rds!.send(new CreateDBInstanceCommand({ ...writerRequest, DBInstanceIdentifier: "second-writer" })), /InvalidDBClusterState/);
  await assert.rejects(rds!.send(new DeleteDBClusterCommand({ DBClusterIdentifier: clusterId, SkipFinalSnapshot: true })), /InvalidDBClusterState/);
  await assert.rejects(rds!.send(new CreateDBSnapshotCommand({ DBInstanceIdentifier: writerId, DBSnapshotIdentifier: "wrong-scope" })), /InvalidDBInstanceState/);
  await rds!.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: writerId, ApplyImmediately: true, PromotionTier: 3, CopyTagsToSnapshot: true }));
  assert.equal((await cluster()).DBClusterMembers![0].PromotionTier, 3);

  db = await mysql.createConnection(sql);
  db.on("error", () => undefined); // The writer deliberately terminates this session on detach.
  await db.query("CREATE TABLE work_items (id INT AUTO_INCREMENT PRIMARY KEY, body VARCHAR(80) NOT NULL)");
  const [id] = await db.execute<mysql.ResultSetHeader>("INSERT INTO work_items (body) VALUES (?)", ["committed"]);
  assert.equal(id.insertId, 1);
  await db.execute("UPDATE work_items SET body = ? WHERE id = ?", ["retained", id.insertId]);
  await db.beginTransaction();
  await db.execute("INSERT INTO work_items (body) VALUES (?)", ["uncommitted"]);
  await detach();
  await waitFor(members, list => !list.length);
  assert.deepEqual((await cluster()).DBClusterMembers, []);
  assert.equal((await cluster()).Endpoint, parent.Endpoint);
  await db.end().catch(() => undefined); db = undefined;
  await assert.rejects(mysql.createConnection(sql), /ECONNREFUSED/);
  await attach();
  const replacement = await writer();
  assert.notEqual(replacement.DbiResourceId, original.DbiResourceId);
  assert.equal((await cluster()).DbClusterResourceId, parent.DbClusterResourceId);
  const rows = async () => {
    db = await mysql.createConnection(sql);
    const [result] = await db.query<RowDataPacket[]>("SELECT body FROM work_items ORDER BY id");
    await db.end(); db = undefined;
    return result.map(row => row.body);
  };
  assert.deepEqual(await rows(), ["retained"]);

  // Reopen a journaled attach after process shutdown and verify the same writer generation resumes.
  rds!.destroy(); await sim.stop();
  sim.store.regionState(region).rdsDbInstances[writerId].dbInstanceStatus = "creating"; await sim.store.save();
  sim = new StackSim(options); await start();
  assert.equal((await writer()).DbiResourceId, replacement.DbiResourceId);
  assert.deepEqual(await rows(), ["retained"]);
  rds!.destroy(); await sim.stop();
  sim.store.regionState(region).rdsDbInstances[writerId].dbInstanceStatus = "deleting"; await sim.store.save();
  sim = new StackSim(options); await start();
  assert.deepEqual(await members(), []);
  assert.equal((await cluster()).DbClusterResourceId, parent.DbClusterResourceId);
  await rds!.send(new DeleteDBClusterCommand({ DBClusterIdentifier: clusterId, SkipFinalSnapshot: true }));
  await waitFor(async () => (await rds.send(new DescribeDBClustersCommand({}))).DBClusters, list => list?.length === 0);
  assert.equal(sim.store.state.installation.rds.clusterLease, undefined);
});

test("attaching a writer requires access to its exact member and parent, with independent resource tags", async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-aurora-writer-iam-"));
  const sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: true, authMode: "enforce" });
  t.after(async () => { await sim.stop(); await rm(root, { recursive: true, force: true }); });
  await sim.start();
  const config = { region, credentials, endpoint: `http://127.0.0.1:${sim.port}`, maxAttempts: 1 };
  const admin = new RDSClient(config);
  const iam = new IAMClient(config);
  const sts = new STSClient(config);
  t.after(() => { admin.destroy(); iam.destroy(); sts.destroy(); });
  await admin.send(new CreateDBClusterCommand({
    DBClusterIdentifier: clusterId, Engine: "aurora-mysql", Port: await freePort(), MasterUsername: "developer", MasterUserPassword: "WriterIAMPrivate123",
    ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 }, Tags: [{ Key: "owner", Value: "app" }],
  }));
  const parent = await waitFor(async () => (await admin.send(new DescribeDBClustersCommand({ DBClusterIdentifier: clusterId }))).DBClusters![0], value => value.Status === "available");
  const writerArn = `arn:aws:rds:${region}:000000000000:db:${writerId}`;
  const RoleName = "writer-operator";
  const { Role } = await iam.send(new CreateRoleCommand({ RoleName, AssumeRolePolicyDocument: JSON.stringify({
    Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Principal: { AWS: "arn:aws:iam::000000000000:root" } }],
  }) }));
  const { Credentials } = await sts.send(new AssumeRoleCommand({ RoleArn: Role!.Arn, RoleSessionName: "writer-access" }));
  const client = new RDSClient({ ...config, credentials: { accessKeyId: Credentials!.AccessKeyId!, secretAccessKey: Credentials!.SecretAccessKey!, sessionToken: Credentials!.SessionToken } });
  t.after(() => client.destroy());
  const grant = (Statement: object[]) => iam.send(new PutRolePolicyCommand({ RoleName, PolicyName: "writer-create", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement }) }));
  const instanceGrant = { Effect: "Allow", Action: "rds:CreateDBInstance", Resource: writerArn };
  const taggedParent = { StringEquals: { "aws:ResourceTag/owner": "app" } };
  const parentGrant = { ...instanceGrant, Resource: parent.DBClusterArn, Condition: taggedParent };
  const create = () => client.send(new CreateDBInstanceCommand(writerRequest));
  await grant([instanceGrant]);
  await assert.rejects(create(), /AccessDenied/);
  await grant([{ ...instanceGrant, Condition: taggedParent }, parentGrant]);
  await assert.rejects(create(), /AccessDenied/);
  assert.deepEqual((await admin.send(new DescribeDBInstancesCommand({}))).DBInstances, []);
  await grant([instanceGrant, parentGrant]);
  assert.equal((await create()).DBInstance?.DBInstanceArn, writerArn);
});

test("a failed managed-secret removal preserves the current credential, and a customer name collision preserves the writer", async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-aurora-managed-"));
  const sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: "off" });
  t.after(async () => { await sim.stop(); await rm(root, { recursive: true, force: true }); });
  await sim.start();
  const config = { region, credentials, endpoint: `http://127.0.0.1:${sim.port}`, maxAttempts: 1 };
  const rds = new RDSClient(config);
  const secrets = new SecretsManagerClient(config);
  t.after(() => { rds.destroy(); secrets.destroy(); });
  const port = await freePort();
  await rds.send(new CreateDBClusterCommand({
    DBClusterIdentifier: clusterId, Engine: "aurora-mysql", ManageMasterUserPassword: true, MasterUsername: "developer", DatabaseName: "app",
    Port: port, ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
  }));
  const parent = await waitFor(async () => (await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: clusterId }))).DBClusters![0], cluster => cluster.Status === "available");
  const secretArn = parent.MasterUserSecret!.SecretArn!;
  const secretName = "rds/" + parent.DbClusterResourceId!;
  const previous = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const oldPassword = JSON.parse(previous.SecretString!).password;
  await rds.send(new CreateDBInstanceCommand(writerRequest));
  await waitFor(async () => (await rds.send(new DescribeDBInstancesCommand({}))).DBInstances![0], instance => instance.DBInstanceStatus === "available");
  const authenticate = async (password: string) => {
    const db = await mysql.createConnection({ host: "127.0.0.1", port, user: "developer", password, database: "app" });
    try { await db.query("SELECT 1"); } finally { await db.end(); }
  };
  const next = "ReplacementManagedPassword123";
  const disable = () => rds.send(new ModifyDBClusterCommand({ DBClusterIdentifier: clusterId, ManageMasterUserPassword: false, MasterUserPassword: next, ApplyImmediately: true }));
  const save = sim.store.save.bind(sim.store);
  let injected = false;
  sim.store.save = async staged => {
    if (staged && !injected) {
      staged.apply();
      try { injected = !sim.store.regionState(region).secretsManager.secrets[secretName]; } finally { staged.restore(); }
      if (injected) throw new Error("injected managed-secret deletion save failure");
    }
    await save(staged);
  };
  try { await assert.rejects(disable(), /InternalFailure/); } finally { sim.store.save = save; }
  assert.equal(injected, true);
  assert.equal((await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }))).VersionId, previous.VersionId);
  assert.equal(sim.store.regionState(region).secretsManager.retiredSuffixes[secretName], undefined);
  await authenticate(oldPassword);
  await disable();
  await authenticate(next);
  await assert.rejects(secrets.send(new GetSecretValueCommand({ SecretId: secretArn })), /ResourceNotFound/);
  const customer = await secrets.send(new CreateSecretCommand({ Name: secretName, SecretString: "customer-owned" }));
  await assert.rejects(rds.send(new ModifyDBClusterCommand({ DBClusterIdentifier: clusterId, ManageMasterUserPassword: true, ApplyImmediately: true })), /ResourceExists/);
  await authenticate(next);
  await rds.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: writerId }));
  await waitFor(async () => (await rds.send(new DescribeDBInstancesCommand({}))).DBInstances ?? [], instances => instances.length === 0);
  await rds.send(new DeleteDBClusterCommand({ DBClusterIdentifier: clusterId, SkipFinalSnapshot: true }));
  await waitFor(async () => (await rds.send(new DescribeDBClustersCommand({}))).DBClusters ?? [], clusters => clusters.length === 0);
  assert.equal((await secrets.send(new GetSecretValueCommand({ SecretId: customer.ARN }))).SecretString, "customer-owned");
});
