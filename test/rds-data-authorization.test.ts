import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Agent, request, type IncomingHttpHeaders } from "node:http";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateDBClusterCommand, CreateDBInstanceCommand, DisableHttpEndpointCommand, EnableHttpEndpointCommand, RDSClient, waitUntilDBClusterAvailable, waitUntilDBInstanceAvailable } from "@aws-sdk/client-rds";
import { BeginTransactionCommand, ExecuteStatementCommand, RDSDataClient, RollbackTransactionCommand } from "@aws-sdk/client-rds-data";
import { CreateSecretCommand, DeleteResourcePolicyCommand, PutResourcePolicyCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { StackSim } from "../src/server.js";

function oversizedRequest(endpoint: string, agent: Agent, chunked: boolean): Promise<{ status?: number; headers: IncomingHttpHeaders; body: string; socket: Socket }> {
  // The body is just below 4 MiB. Including its HTTP headers puts the request over the limit.
  const body = Buffer.alloc(4 * 1024 * 1024 - 32, " ");
  const framing = chunked ? { "transfer-encoding": "chunked" } : { "content-length": body.length };
  return new Promise((resolve, reject) => {
    // Deliberately unsigned. A 413 proves admission happened before authentication.
    const req = request(new URL("/Execute", endpoint), { method: "POST", agent, headers: { "content-type": "application/json", ...framing } }, res => {
      const socket = res.socket;
      res.setEncoding("utf8");
      let text = "";
      res.on("data", part => { text += part; });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text, socket }));
    });
    req.once("error", reject);
    req.write(body.subarray(0, 512 * 1024));
    req.end(body.subarray(512 * 1024));
  });
}

test("signed Data API calls require the cluster action and access to the current secret on every request", async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-rds-data-iam-"));
  const region = "us-east-1";
  const sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, region, authMode: "enforce", cdkBootstrap: true });
  t.after(async () => { await sim.stop(); await rm(root, { recursive: true, force: true }); });
  await sim.start();
  const config = { region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, endpoint: `http://127.0.0.1:${sim.port}`, maxAttempts: 1 };
  const rds = new RDSClient(config);
  const secrets = new SecretsManagerClient(config);
  const iam = new IAMClient(config);
  const sts = new STSClient(config);
  t.after(() => { rds.destroy(); secrets.destroy(); iam.destroy(); sts.destroy(); });

  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => listener.close(err => err ? reject(err) : resolve()));
  const clusterId = "data-cluster";
  const login = { username: "developer", password: "LocalDataApi123" };
  const { DBCluster } = await rds.send(new CreateDBClusterCommand({
    DBClusterIdentifier: clusterId, Engine: "aurora-mysql", MasterUsername: login.username, MasterUserPassword: login.password,
    DatabaseName: "app", Port: address.port, EnableHttpEndpoint: true, ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
    Tags: [{ Key: "team", Value: "cluster-team" }],
  }));
  const resourceArn = DBCluster?.DBClusterArn;
  assert.ok(resourceArn);
  const wait = { client: rds, minDelay: 1, maxDelay: 1, maxWaitTime: 10 };
  await waitUntilDBClusterAvailable(wait, { DBClusterIdentifier: clusterId });
  const { ARN: secretArn } = await secrets.send(new CreateSecretCommand({
    Name: "data-credential", SecretString: JSON.stringify(login), Tags: [{ Key: "team", Value: "secret-team" }],
  }));
  assert.ok(secretArn);
  const { Role } = await iam.send(new CreateRoleCommand({ RoleName: "data-app", AssumeRolePolicyDocument: JSON.stringify({
    Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Principal: { AWS: `arn:aws:iam::${sim.store.accountId}:root` } }],
  }) }));
  assert.ok(Role?.Arn);
  const grant = (PolicyName: string, Statement: object[]) => iam.send(new PutRolePolicyCommand({
    RoleName: "data-app", PolicyName, PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement }),
  }));
  const dataActions = ["rds-data:ExecuteStatement", "rds-data:BeginTransaction", "rds-data:RollbackTransaction"];
  const clusterAccess = { Effect: "Allow", Action: dataActions, Resource: resourceArn, Condition: { StringEquals: { "aws:ResourceTag/team": "cluster-team" } } };
  const secretAccess = { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secretArn, Condition: { StringEquals: { "aws:ResourceTag/team": "secret-team", "secretsmanager:VersionStage": "AWSCURRENT" } } };
  await grant("Database", [clusterAccess]);
  const { Credentials } = await sts.send(new AssumeRoleCommand({ RoleArn: Role.Arn, RoleSessionName: "data-session" }));
  assert.ok(Credentials?.AccessKeyId && Credentials.SecretAccessKey);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const data = new RDSDataClient({ ...config, requestHandler: new NodeHttpHandler({ httpAgent: agent }), credentials: { accessKeyId: Credentials.AccessKeyId, secretAccessKey: Credentials.SecretAccessKey, sessionToken: Credentials.SessionToken } });
  const endpointManager = new RDSClient({ ...config, credentials: data.config.credentials });
  t.after(() => { data.destroy(); endpointManager.destroy(); });
  const target = { resourceArn, secretArn, database: "app" };
  const execute = (sql: string) => data.send(new ExecuteStatementCommand({ ...target, sql }));
  const denied = { name: "AccessDeniedException" };
  await assert.rejects(execute("SELECT 1"), denied);
  await grant("Secret", [secretAccess]);
  await assert.rejects(execute("SELECT 1"), { name: "DatabaseNotFoundException" });
  await rds.send(new CreateDBInstanceCommand({ DBClusterIdentifier: clusterId, DBInstanceIdentifier: "data-writer", DBInstanceClass: "db.serverless", Engine: "aurora-mysql" }));
  await waitUntilDBInstanceAvailable(wait, { DBInstanceIdentifier: "data-writer" });
  const ddl = await execute("CREATE TABLE auth_rows (value INT NOT NULL)");
  assert.equal(ddl.$metadata.httpStatusCode, 200);
  assert.ok(ddl.$metadata.requestId);
  const socketHistory = new Set<Socket>();
  agent.on("free", socket => socketHistory.add(socket));
  const requestIds = new Set<string>();
  for (const chunked of [false, true]) {
    const response = await oversizedRequest(config.endpoint, agent, chunked);
    socketHistory.add(response.socket);
    assert.equal(response.status, 413);
    assert.equal(response.headers["content-type"], "application/json");
    assert.equal(response.headers["x-amzn-errortype"], "BadRequestException");
    assert.deepEqual(JSON.parse(response.body), { message: "The request exceeds 4 MiB", __type: "BadRequestException" });
    const requestId = response.headers["x-amzn-requestid"];
    assert.ok(typeof requestId === "string" && requestId.length > 0);
    assert.equal(response.headers["x-amz-request-id"], requestId);
    requestIds.add(requestId);
    assert.deepEqual((await execute("SELECT value FROM auth_rows")).records, []);
  }
  assert.equal(requestIds.size, 2);
  assert.equal(socketHistory.size, 1, "the signed queries reused the HTTP connection after both oversized requests");

  const transaction = await data.send(new BeginTransactionCommand(target));
  const insert = () => data.send(new ExecuteStatementCommand({ ...target, transactionId: transaction.transactionId, sql: "INSERT INTO auth_rows (value) VALUES (9)" }));
  await secrets.send(new PutResourcePolicyCommand({ SecretId: secretArn, ResourcePolicy: JSON.stringify({
    Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: { AWS: Role.Arn }, Action: "secretsmanager:GetSecretValue", Resource: secretArn }],
  }) }));
  await assert.rejects(insert(), denied);
  await assert.rejects(data.send(new RollbackTransactionCommand({ ...target, transactionId: transaction.transactionId })), denied);
  await secrets.send(new DeleteResourcePolicyCommand({ SecretId: secretArn }));
  await data.send(new RollbackTransactionCommand({ ...target, transactionId: transaction.transactionId }));
  await grant("Database", [clusterAccess, { Effect: "Deny", Action: "rds-data:ExecuteStatement", Resource: resourceArn }]);
  await assert.rejects(execute("INSERT INTO auth_rows (value) VALUES (77)"), denied);
  await grant("Database", [clusterAccess]);
  assert.deepEqual((await execute("SELECT value FROM auth_rows")).records, []);

  await secrets.send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: "invalid" }));
  await assert.rejects(execute("SELECT 1"), { name: "InvalidSecretException" });
  await secrets.send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: JSON.stringify({ ...login, password: "WrongCredential" }) }));
  await assert.rejects(execute("SELECT 1"), { name: "InvalidSecretException" });
  await secrets.send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: JSON.stringify(login) }));
  const interrupted = await data.send(new BeginTransactionCommand(target));
  await assert.rejects(endpointManager.send(new DisableHttpEndpointCommand({ ResourceArn: resourceArn })), /AccessDenied/);
  await grant("Endpoint", [{ Effect: "Allow", Action: ["rds:EnableHttpEndpoint", "rds:DisableHttpEndpoint"], Resource: resourceArn, Condition: { StringEquals: { "aws:ResourceTag/team": "cluster-team" } } }]);
  await endpointManager.send(new DisableHttpEndpointCommand({ ResourceArn: resourceArn }));
  await assert.rejects(execute("SELECT 1"), { name: "HttpEndpointNotEnabledException" });
  await endpointManager.send(new EnableHttpEndpointCommand({ ResourceArn: resourceArn }));
  await assert.rejects(data.send(new RollbackTransactionCommand({ ...target, transactionId: interrupted.transactionId })), { name: "TransactionNotFoundException" });
  assert.deepEqual((await execute("SELECT value FROM auth_rows")).records, []);
});
