import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  AddTagsToResourceCommand, CreateDBClusterCommand, CreateDBInstanceCommand, DeleteDBClusterCommand,
  DescribeDBClustersCommand, DescribeGlobalClustersCommand, ListTagsForResourceCommand, ModifyDBClusterCommand,
  RDSClient, RemoveTagsFromResourceCommand, waitUntilDBClusterAvailable, waitUntilDBClusterDeleted, type CreateDBClusterCommandInput,
} from "@aws-sdk/client-rds";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { StackSim } from "../src/server.js";
import { signedFetch, type TestCredentials } from "./helpers/signed-fetch.js";

const region = "us-east-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const name = "app-db";
const arn = `arn:aws:rds:${region}:000000000000:cluster:${name}`;
const input: CreateDBClusterCommandInput = {
  DBClusterIdentifier: name, Engine: "aurora-mysql", EngineVersion: "8.0.mysql_aurora.3.08.0", EngineMode: "provisioned",
  DatabaseName: "app", MasterUsername: "developer", MasterUserPassword: "ClusterPrivateTest123",
  ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 }, Tags: [{ Key: "team", Value: "development" }],
};

async function available(client: RDSClient) {
  const identifier = { DBClusterIdentifier: name };
  await waitUntilDBClusterAvailable({ client, minDelay: 1, maxDelay: 1, maxWaitTime: 10 }, identifier);
  const { DBClusters } = await client.send(new DescribeDBClustersCommand(identifier));
  assert.ok(DBClusters?.[0]);
  return DBClusters[0];
}

function namedError(name: string, status?: number) {
  return (error: unknown) => error instanceof Error && error.name === name
    && (status === undefined || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === status);
}

test("regional Aurora cluster CRUD, named Query XML, Terraform refresh and shared capacity", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds-cluster-"));
  const sim = new StackSim({ dataDir, region, port: 0, invokePort: 0, authMode: "off" });
  t.after(async () => { await sim.stop(); await rm(dataDir, { recursive: true, force: true }); });
  await sim.start();
  const endpoint = `http://127.0.0.1:${sim.port}`;
  const rds = new RDSClient({ region, endpoint, credentials, maxAttempts: 1 });
  const other = new RDSClient({ region: "eu-west-1", endpoint, credentials, maxAttempts: 1 });
  t.after(() => { rds.destroy(); other.destroy(); });

  assert.deepEqual((await rds.send(new DescribeDBClustersCommand({}))).DBClusters, []);
  for (const unsupported of [
    { StorageEncrypted: true },
    { Engine: "aurora-postgresql" },
    { ServerlessV2ScalingConfiguration: { MinCapacity: 4, MaxCapacity: 2 } },
  ]) {
    await assert.rejects(rds.send(new CreateDBClusterCommand({ ...input, ...unsupported })), /InvalidParameter/);
  }
  const { DBCluster: created } = await rds.send(new CreateDBClusterCommand(input));
  assert.equal(created?.DBClusterArn, arn);
  const cluster = await available(rds);
  assert.equal(cluster.DbClusterResourceId, created?.DbClusterResourceId);
  assert.ok(cluster.DbClusterResourceId);
  assert.deepEqual(cluster.DBClusterMembers, []);
  assert.deepEqual(cluster.ServerlessV2ScalingConfiguration, input.ServerlessV2ScalingConfiguration);
  assert.deepEqual(cluster.TagList, input.Tags);
  assert.equal(cluster.DatabaseName, input.DatabaseName);
  assert.equal(cluster.EngineVersion, input.EngineVersion);
  assert.equal(cluster.MasterUsername, input.MasterUsername);
  assert.equal(cluster.HttpEndpointEnabled, false);
  assert.doesNotMatch(await readFile(join(dataDir, "state.json"), "utf8"), /ClusterPrivateTest123/);

  const raw = await fetch(`${endpoint}/?Action=DescribeDBClusters&Version=2014-10-31&DBClusterIdentifier=${name}`);
  assert.equal(raw.status, 200);
  const xml = await raw.text();
  assert.match(xml, /<DBClusters><DBCluster>/);
  assert.match(xml, /<DBClusterMembers><\/DBClusterMembers>/);
  assert.match(xml, /<TagList><Tag><Key>team<\/Key>/);
  assert.match(xml, /<RequestId>[^<]+<\/RequestId>/);
  assert.deepEqual((await rds.send(new DescribeGlobalClustersCommand({ Filters: [{ Name: "db-cluster-id", Values: [arn] }] }))).GlobalClusters, []);
  await assert.rejects(rds.send(new DescribeGlobalClustersCommand({ Filters: [{ Name: "other", Values: [arn] }] })), /InvalidParameter/);
  assert.deepEqual((await other.send(new DescribeDBClustersCommand({}))).DBClusters, []);
  await assert.rejects(other.send(new DescribeDBClustersCommand({ DBClusterIdentifier: name })), namedError("DBClusterNotFoundFault", 404));
  await assert.rejects(rds.send(new CreateDBClusterCommand(input)), namedError("DBClusterAlreadyExistsFault", 400));
  await assert.rejects(other.send(new CreateDBClusterCommand({ ...input, DBClusterIdentifier: "other" })), namedError("DBClusterQuotaExceededFault", 403));
  await assert.rejects(rds.send(new CreateDBInstanceCommand({
    DBInstanceIdentifier: "standalone", DBInstanceClass: "db.t3.micro", Engine: "mysql", MasterUsername: "developer", MasterUserPassword: "StandaloneTest123",
  })), namedError("InstanceQuotaExceededFault"));
  for (const foreign of [arn.replace("000000000000", "111111111111"), arn.replace(region, "eu-west-1")]) {
    await assert.rejects(rds.send(new AddTagsToResourceCommand({ ResourceName: foreign, Tags: [{ Key: "foreign", Value: "false" }] })));
  }
  assert.deepEqual((await rds.send(new ListTagsForResourceCommand({ ResourceName: arn }))).TagList, input.Tags);
  await rds.send(new AddTagsToResourceCommand({ ResourceName: arn, Tags: [{ Key: "owner", Value: "app" }] }));
  await rds.send(new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: ["team"] }));
  assert.deepEqual((await rds.send(new ListTagsForResourceCommand({ ResourceName: arn }))).TagList, [{ Key: "owner", Value: "app" }]);
  await rds.send(new ModifyDBClusterCommand({ DBClusterIdentifier: name, DeletionProtection: true, ApplyImmediately: true }));
  const remove = () => rds.send(new DeleteDBClusterCommand({ DBClusterIdentifier: name, SkipFinalSnapshot: true }));
  await assert.rejects(remove(), namedError("InvalidParameterCombination", 400));
  await rds.send(new ModifyDBClusterCommand({ DBClusterIdentifier: name, DeletionProtection: false }));
  await assert.rejects(rds.send(new DeleteDBClusterCommand({ DBClusterIdentifier: name, FinalDBSnapshotIdentifier: "last-snapshot" })), /InvalidParameter/);
  assert.equal((await available(rds)).DbClusterResourceId, created!.DbClusterResourceId);
  await remove();
  await waitUntilDBClusterDeleted({ client: rds, minDelay: 1, maxDelay: 1, maxWaitTime: 10 }, { DBClusterIdentifier: name });
  await assert.rejects(rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: name })), namedError("DBClusterNotFoundFault", 404));
  const replacement = await other.send(new CreateDBClusterCommand({ ...input, DBClusterIdentifier: "reused-slot" }));
  assert.notEqual(replacement.DBCluster?.DbClusterResourceId, cluster.DbClusterResourceId);
});

test("failed cluster tag saves preserve catalog tags and concurrent successful changes compose", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds-tag-save-"));
  const sim = new StackSim({ dataDir, region, port: 0, invokePort: 0, authMode: "off" });
  t.after(async () => { await sim.stop(); await rm(dataDir, { recursive: true, force: true }); });
  await sim.start();
  const client = new RDSClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 });
  t.after(() => client.destroy());
  await client.send(new CreateDBClusterCommand(input));
  await available(client);

  const add = () => client.send(new AddTagsToResourceCommand({ ResourceName: arn, Tags: [{ Key: "owner", Value: "app" }] }));
  const remove = () => client.send(new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: ["team"] }));
  const stateFile = join(dataDir, "state.json");
  const backup = join(dataDir, "state-backup.json");
  await sim.store.flush();
  await rename(stateFile, backup);
  // An existing directory at the destination forces the atomic file rename to fail on every supported OS.
  await mkdir(stateFile);
  try {
    await assert.rejects(add(), namedError("InternalFailure", 500));
    await assert.rejects(remove(), namedError("InternalFailure", 500));
    assert.deepEqual((await client.send(new ListTagsForResourceCommand({ ResourceName: arn }))).TagList, input.Tags);
  } finally {
    await rmdir(stateFile);
    await rename(backup, stateFile);
  }

  await Promise.all([add(), remove()]);
  assert.deepEqual((await client.send(new ListTagsForResourceCommand({ ResourceName: arn }))).TagList, [{ Key: "owner", Value: "app" }]);
  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(persisted.accounts[sim.store.accountId].regions[region].rdsDbClusters[name].tags, { owner: "app" });
});

test("cluster IAM checks tag-on-create, exact cluster ARNs and tag conditions before changes", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-rds-cluster-iam-"));
  const sim = new StackSim({ dataDir, region, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: true });
  t.after(async () => { await sim.stop(); await rm(dataDir, { recursive: true, force: true }); });
  await sim.start();
  const endpoint = `http://127.0.0.1:${sim.port}`;
  const config = { region, credentials, endpoint, maxAttempts: 1 };
  const iam = new IAMClient(config);
  const sts = new STSClient(config);
  const admin = new RDSClient(config);
  t.after(() => { iam.destroy(); sts.destroy(); admin.destroy(); });
  const RoleName = "cluster-developer";
  const { Role } = await iam.send(new CreateRoleCommand({ RoleName, AssumeRolePolicyDocument: JSON.stringify({
    Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Principal: { AWS: "arn:aws:iam::000000000000:root" } }],
  }) }));
  const grant = (PolicyName: string, Statement: object[]) => iam.send(new PutRolePolicyCommand({
    RoleName, PolicyName, PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement }),
  }));
  const requestTeam = { StringEquals: { "aws:RequestTag/team": "development" } };
  const resourceTeam = { StringEquals: { "aws:ResourceTag/team": "development" } };
  await grant("ClusterAccess", [
    { Effect: "Allow", Action: "rds:CreateDBCluster", Resource: arn, Condition: requestTeam },
    { Effect: "Allow", Action: ["rds:DescribeDBClusters", "rds:ModifyDBCluster", "rds:RemoveTagsFromResource"], Resource: arn, Condition: resourceTeam },
  ]);
  const { Credentials } = await sts.send(new AssumeRoleCommand({ RoleArn: Role!.Arn, RoleSessionName: "cluster-session" }));
  const session: TestCredentials = { accessKeyId: Credentials!.AccessKeyId!, secretAccessKey: Credentials!.SecretAccessKey!, sessionToken: Credentials!.SessionToken };
  const rds = new RDSClient({ ...config, credentials: session });
  const other = new RDSClient({ ...config, region: "eu-west-1", credentials: session });
  t.after(() => { rds.destroy(); other.destroy(); });
  const create = () => rds.send(new CreateDBClusterCommand(input));
  await assert.rejects(create(), /AccessDenied/);
  assert.deepEqual((await admin.send(new DescribeDBClustersCommand({}))).DBClusters, []);
  await grant("TagOnCreate", [{ Effect: "Allow", Action: "rds:AddTagsToResource", Resource: arn, Condition: requestTeam }]);
  await create();
  await available(rds);
  const query = new URLSearchParams({ Action: "DescribeDBClusters", Version: "2014-10-31", DBClusterIdentifier: name });
  const raw = await signedFetch(`${endpoint}/?${query}`, { service: "rds", region, credentials: session });
  assert.equal(raw.status, 200);
  await assert.rejects(other.send(new DescribeDBClustersCommand({ DBClusterIdentifier: name })), /AccessDenied/);
  await assert.rejects(rds.send(new DescribeDBClustersCommand({})), /AccessDenied/);
  await rds.send(new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: ["team"] }));
  await assert.rejects(rds.send(new ModifyDBClusterCommand({ DBClusterIdentifier: name, DeletionProtection: true })), /AccessDenied/);
  assert.equal((await available(admin)).DeletionProtection, false);
});
