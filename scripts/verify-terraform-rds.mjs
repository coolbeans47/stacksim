import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import { BeginTransactionCommand, CommitTransactionCommand, ExecuteStatementCommand, RDSDataClient } from "@aws-sdk/client-rds-data";
import { DescribeSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { StackSim } from "../dist/src/server.js";
import { TestClock } from "../dist/src/core/clock.js";

const run = promisify(execFile);
const work = await mkdtemp(join(tmpdir(), "stacksim-terraform-rds-"));
const fixture = new URL("../examples/terraform-rds-cluster/", import.meta.url);
const clock = new TestClock(Date.now());
// Terraform's real provider waiters and SigV4 timestamps use wall time.
let lastTick = Date.now();
const ticker = setInterval(() => {
  const now = Date.now();
  clock.advance(Math.max(0, now - lastTick));
  lastTick = now;
}, 1000).unref();
const dataDir = join(work, "simulator");
const local = { accessKeyId: "admin", secretAccessKey: "password" };
const env = { ...process.env, AWS_ACCESS_KEY_ID: local.accessKeyId, AWS_SECRET_ACCESS_KEY: local.secretAccessKey,
  AWS_EC2_METADATA_DISABLED: "true", TF_INPUT: "0", TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" };
for (const key of ["AWS_SESSION_TOKEN", "AWS_PROFILE", "TF_DATA_DIR"]) delete env[key];
const clients = [];
let simulator;
let config;
let controlPort = 0;

async function start() {
  simulator = new StackSim({ port: controlPort, invokePort: 0, s3TlsPort: 0, cloudFormationCustomResourceCallbackPort: 0,
    host: "127.0.0.1", region: "us-east-1", authMode: "enforce", clock, dataDir, cdkBootstrap: false });
  await simulator.start();
  controlPort = simulator.port;
  env.TF_VAR_stacksim_endpoint = `http://127.0.0.1:${simulator.port}`;
  config = { region: "us-east-1", endpoint: env.TF_VAR_stacksim_endpoint, credentials: local, maxAttempts: 1 };
}
function client(Service) { const c = new Service(config); clients.push(c); return c; }
async function terraform(...args) {
  const { stdout } = await run("terraform", args, { cwd: work, env, windowsHide: true });
  console.log(`terraform ${args[0]} passed`);
  return stdout;
}
async function writer() {
  const { DBInstances } = await client(RDSClient).send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "app-writer" }));
  return DBInstances[0].DbiResourceId;
}

try {
  const reservation = createServer();
  await new Promise((resolve, reject) => reservation.once("error", reject).listen(0, "127.0.0.1", resolve));
  env.TF_VAR_writer_port = String(reservation.address().port);
  await new Promise(resolve => reservation.close(resolve));
  for (const file of ["main.tf", ".terraform.lock.hcl"]) await copyFile(new URL(file, fixture), join(work, file));
  await start();
  await terraform("init", "-lockfile=readonly", "-no-color");
  await terraform("apply", "-auto-approve", "-no-color");
  await terraform("plan", "-detailed-exitcode", "-no-color");
  const outputs = JSON.parse(await terraform("output", "-json"));
  assert.equal(outputs.writer.value, true);
  const target = { resourceArn: outputs.cluster_arn.value, secretArn: outputs.secret_arn.value, database: outputs.database.value };
  let data = client(RDSDataClient);
  const select = () => data.send(new ExecuteStatementCommand({ ...target, sql: "SELECT note FROM app_notes ORDER BY id" }));
  const begin = async () => (await data.send(new BeginTransactionCommand(target))).transactionId;
  const writeUncommitted = transactionId => data.send(new ExecuteStatementCommand({ ...target, transactionId,
    sql: "INSERT INTO app_notes (run_id, note) VALUES ('interrupted', 'pending')" }));
  const commit = transactionId => data.send(new CommitTransactionCommand({ ...target, transactionId }));
  await run(process.execPath, [fileURLToPath(new URL("app.mjs", fixture))], { cwd: work, env, windowsHide: true });
  const expected = [[{ stringValue: "published" }], [{ stringValue: "committed" }]];
  assert.deepEqual((await select()).records, expected);

  const oldWriter = await writer();
  const detached = await begin();
  await writeUncommitted(detached);
  await terraform("apply", "-replace=aws_rds_cluster_instance.writer", "-auto-approve", "-no-color");
  assert.notEqual(await writer(), oldWriter);
  await assert.rejects(commit(detached), { name: "TransactionNotFoundException" });
  assert.deepEqual((await select()).records, expected);

  const disabled = await begin();
  await writeUncommitted(disabled);
  env.TF_VAR_enable_http_endpoint = "false";
  await terraform("apply", "-auto-approve", "-no-color");
  await assert.rejects(select(), { name: "HttpEndpointNotEnabledException" });
  env.TF_VAR_enable_http_endpoint = "true";
  await terraform("apply", "-auto-approve", "-no-color");
  await assert.rejects(commit(disabled), { name: "TransactionNotFoundException" });

  const expired = await begin();
  await writeUncommitted(expired);
  clock.advance(180_001);
  await assert.rejects(commit(expired), { name: "TransactionNotFoundException" });
  const interrupted = await begin();
  await writeUncommitted(interrupted);
  await simulator.stop();
  await start();
  data = client(RDSDataClient);
  await assert.rejects(commit(interrupted), { name: "TransactionNotFoundException" });
  assert.deepEqual((await select()).records, expected);
  await terraform("plan", "-detailed-exitcode", "-no-color");
  const destroyed = await begin();
  await writeUncommitted(destroyed);
  await terraform("destroy", "-auto-approve", "-no-color");
  await assert.rejects(commit(destroyed), { name: "DatabaseNotFoundException" });
  assert.deepEqual(simulator.store.state.installation.rds, {});
  assert.deepEqual(simulator.store.regionState("us-east-1").rdsDbInstances, {});
  assert.deepEqual(simulator.store.regionState("us-east-1").rdsDbClusters, {});
  await assert.rejects(client(SecretsManagerClient).send(new DescribeSecretCommand({ SecretId: target.secretArn })), { name: "ResourceNotFoundException" });
  assert.deepEqual(await readdir(join(dataDir, "data", "rds", "instances")), []);
  assert.deepEqual(await readdir(join(dataDir, "data", "rds", "secrets")), []);
  console.log("Cluster, writer, Data API and destroy verified");
} finally {
  clearInterval(ticker);
  for (const c of clients) c.destroy();
  await simulator?.stop();
  await rm(work, { recursive: true, force: true, maxRetries: 3 });
}
