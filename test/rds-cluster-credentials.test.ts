import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateDBClusterCommand, CreateDBInstanceCommand, DeleteDBClusterCommand, DeleteDBInstanceCommand,
  DescribeDBClustersCommand, ModifyDBClusterCommand, RDSClient, waitUntilDBClusterAvailable,
  waitUntilDBClusterDeleted, waitUntilDBInstanceAvailable, waitUntilDBInstanceDeleted,
} from "@aws-sdk/client-rds";
import { BeginTransactionCommand, CommitTransactionCommand, ExecuteStatementCommand, RDSDataClient } from "@aws-sdk/client-rds-data";
import { CreateSecretCommand, GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import mysql from "mysql2/promise";
import { StackSim } from "../src/server.js";

const region = "us-east-1";
const clusterId = "managed-cluster";
const writerId = "managed-writer";
const clusterKey = { DBClusterIdentifier: clusterId };
const writerKey = { DBInstanceIdentifier: writerId };

async function start(dataDir: string) {
  const sim = new StackSim({ dataDir, region, port: 0, invokePort: 0, authMode: "enforce" });
  await sim.start();
  const config = { region, endpoint: `http://127.0.0.1:${sim.port}`, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
  const rds = new RDSClient(config);
  const secrets = new SecretsManagerClient(config);
  const data = new RDSDataClient(config);
  const wait = { client: rds, minDelay: 1, maxDelay: 1, maxWaitTime: 10 };
  return { sim, rds, secrets, data, wait, stop: async () => { rds.destroy(); secrets.destroy(); data.destroy(); await sim.stop(); } };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test("Aurora managed credentials rotate, recover and follow the cluster through writer replacement", async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-rds-managed-cluster-"));
  let services = await start(root);
  t.after(async () => { await services.stop(); await rm(root, { recursive: true, force: true }); });
  const port = await freePort();
  await services.rds.send(new CreateDBClusterCommand({
    ...clusterKey, Engine: "aurora-mysql", DatabaseName: "app", Port: port, MasterUsername: "developer",
    EnableHttpEndpoint: true, ManageMasterUserPassword: true, ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
  }));
  await waitUntilDBClusterAvailable(services.wait, clusterKey);
  const describe = async () => {
    const cluster = (await services.rds.send(new DescribeDBClustersCommand(clusterKey))).DBClusters?.[0];
    assert.ok(cluster);
    return cluster;
  };
  const parent = await describe();
  const managedArn = parent.MasterUserSecret?.SecretArn;
  const resourceArn = parent.DBClusterArn;
  assert.ok(managedArn && resourceArn);
  assert.equal(parent.MasterUserSecret?.SecretStatus, "active");
  const get = (SecretId: string, VersionStage = "AWSCURRENT") => services.secrets.send(new GetSecretValueCommand({ SecretId, VersionStage }));
  const initial = await get(managedArn);
  const initialLogin = JSON.parse(initial.SecretString!);
  assert.equal(initialLogin.dbClusterIdentifier, clusterId);
  assert.equal(initialLogin.username, "developer");
  assert.equal(initialLogin.port, port);
  const customerCredential = JSON.stringify({ username: "developer", password: "CustomerMaster123" });
  const customer = await services.secrets.send(new CreateSecretCommand({ Name: "managed-tests/customer", SecretString: customerCredential }));
  assert.ok(customer.ARN);
  const attach = async () => {
    await services.rds.send(new CreateDBInstanceCommand({ ...clusterKey, ...writerKey, Engine: "aurora-mysql", DBInstanceClass: "db.serverless" }));
    await waitUntilDBInstanceAvailable(services.wait, writerKey);
  };
  const detach = async () => {
    await services.rds.send(new DeleteDBInstanceCommand(writerKey));
    await waitUntilDBInstanceDeleted(services.wait, writerKey);
  };
  const readRows = (secretArn: string) => services.data.send(new ExecuteStatementCommand({ resourceArn, secretArn, database: "app", sql: "SELECT id FROM rotation_rows ORDER BY id" }));
  const target = { resourceArn, secretArn: managedArn, database: "app" };
  const rotate = (immediate: boolean) => services.rds.send(new ModifyDBClusterCommand({ ...clusterKey, RotateMasterUserPassword: true, ApplyImmediately: immediate }));
  await attach();
  await services.data.send(new ExecuteStatementCommand({ ...target, sql: "CREATE TABLE rotation_rows (id INT PRIMARY KEY)" }));
  await services.data.send(new ExecuteStatementCommand({ ...target, sql: "INSERT INTO rotation_rows (id) VALUES (1)" }));
  await assert.rejects(rotate(false), { name: "InvalidParameterCombination" });
  assert.equal((await get(managedArn)).VersionId, initial.VersionId);
  const transaction = await services.data.send(new BeginTransactionCommand(target));
  await services.data.send(new ExecuteStatementCommand({ ...target, transactionId: transaction.transactionId, sql: "INSERT INTO rotation_rows (id) VALUES (2)" }));
  await rotate(true);
  const rotated = await get(managedArn);
  assert.notEqual(rotated.VersionId, initial.VersionId);
  const prior = await get(managedArn, "AWSPREVIOUS");
  assert.equal(prior.VersionId, initial.VersionId);
  assert.ok(prior.SecretString === initial.SecretString);
  const rotatedLogin = JSON.parse(rotated.SecretString!);
  assert.ok(rotatedLogin.password !== initialLogin.password);
  await assert.rejects(mysql.createConnection({ host: "127.0.0.1", port, database: "app", user: initialLogin.username, password: initialLogin.password }), { code: "ER_ACCESS_DENIED_ERROR" });
  await assert.rejects(services.data.send(new CommitTransactionCommand({ resourceArn, secretArn: managedArn, transactionId: transaction.transactionId })), { name: "TransactionNotFoundException" });
  assert.deepEqual((await readRows(managedArn)).records, [[{ longValue: 1 }]]);

  // Interrupt after the writer changes password but before Secrets Manager publishes its version.
  const interrupted = t.mock.method(services.sim.secretsmanager.catalog, "RotateManagedRdsSecret", async () => { throw new Error("interrupted publication"); });
  await assert.rejects(rotate(true));
  interrupted.mock.restore();
  await services.stop();
  services = await start(root);
  assert.equal((await describe()).MasterUserSecret?.SecretArn, managedArn);
  const recovered = await get(managedArn);
  assert.notEqual(recovered.VersionId, rotated.VersionId);
  assert.equal((await get(managedArn, "AWSPREVIOUS")).VersionId, rotated.VersionId);
  assert.deepEqual((await readRows(managedArn)).records, [[{ longValue: 1 }]]);

  await detach();
  assert.equal((await get(managedArn)).VersionId, recovered.VersionId);
  await attach();
  assert.deepEqual((await readRows(managedArn)).records, [[{ longValue: 1 }]]);
  await services.rds.send(new ModifyDBClusterCommand({ ...clusterKey, ManageMasterUserPassword: false, MasterUserPassword: "CustomerMaster123", ApplyImmediately: true }));
  assert.equal((await describe()).MasterUserSecret, undefined);
  await assert.rejects(get(managedArn), { name: "ResourceNotFoundException" });
  assert.deepEqual((await readRows(customer.ARN)).records, [[{ longValue: 1 }]]);
  await services.rds.send(new ModifyDBClusterCommand({ ...clusterKey, ManageMasterUserPassword: true, ApplyImmediately: true }));
  const replacementArn = (await describe()).MasterUserSecret?.SecretArn;
  assert.ok(replacementArn && replacementArn !== managedArn);
  assert.deepEqual((await readRows(replacementArn)).records, [[{ longValue: 1 }]]);
  await detach();
  await services.rds.send(new DeleteDBClusterCommand({ ...clusterKey, SkipFinalSnapshot: true }));
  await waitUntilDBClusterDeleted(services.wait, clusterKey);
  await assert.rejects(get(replacementArn), { name: "ResourceNotFoundException" });
  assert.ok((await get(customer.ARN)).SecretString === customerCredential);
});
