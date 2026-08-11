import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateAccessKeyCommand, CreateRoleCommand, CreateUserCommand, IAMClient, PutRolePolicyCommand, PutUserPolicyCommand } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { AssumeRoleCommand, STSClient, type AssumeRoleCommandOutput } from "@aws-sdk/client-sts";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function temporaryCredentials(assumed: AssumeRoleCommandOutput) {
  return { accessKeyId: assumed.Credentials!.AccessKeyId!, secretAccessKey: assumed.Credentials!.SecretAccessKey!, sessionToken: assumed.Credentials!.SessionToken! };
}

test("IAMGAP-15 TokenIssueTime is immutable, restart-safe, absent for users/legacy sessions, and set for Lambda sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-iamgap15-"));
  const issuedAt = Date.now();
  const clock = new TestClock(issuedAt);
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce", cdkBootstrap: true });
  let clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    let endpoint = `http://127.0.0.1:${simulator.port}`;
    let iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    let sts = new STSClient({ endpoint, region, credentials, maxAttempts: 1 });
    clients.push(iam, sts);
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sts:AssumeRole" }] });
    const stableRole = await iam.send(new CreateRoleCommand({ RoleName: "token-stable", AssumeRolePolicyDocument: trust }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: "token-stable",
      PolicyName: "mint-time",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "dynamodb:ListTables", Resource: "*", Condition: { DateLessThan: { "aws:TokenIssueTime": new Date(issuedAt + 10_000).toISOString() } } }] }),
    }));
    const legacyRole = await iam.send(new CreateRoleCommand({ RoleName: "token-legacy", AssumeRolePolicyDocument: trust }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: "token-legacy",
      PolicyName: "must-have-real-mint-time",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "dynamodb:ListTables", Resource: "*", Condition: { DateGreaterThan: { "aws:TokenIssueTime": new Date(issuedAt - 1_000).toISOString() } } }] }),
    }));
    await iam.send(new CreateUserCommand({ UserName: "token-user" }));
    await iam.send(new PutUserPolicyCommand({
      UserName: "token-user",
      PolicyName: "no-token-time",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "dynamodb:ListTables", Resource: "*", Condition: { Null: { "aws:TokenIssueTime": "true" } } }] }),
    }));
    const userKey = await iam.send(new CreateAccessKeyCommand({ UserName: "token-user" }));
    const stable = await sts.send(new AssumeRoleCommand({ RoleArn: stableRole.Role!.Arn!, RoleSessionName: "stable" }));
    const legacy = await sts.send(new AssumeRoleCommand({ RoleArn: legacyRole.Role!.Arn!, RoleSessionName: "legacy" }));
    const stableKey = stable.Credentials!.AccessKeyId!;
    const legacyKey = legacy.Credentials!.AccessKeyId!;
    assert.equal((simulator.store.ensureAccount().iam.sessions[stableKey] as any).issuedAt, issuedAt);
    delete (simulator.store.ensureAccount().iam.sessions[legacyKey] as any).issuedAt;
    await simulator.store.save();
    clients.forEach(client => client.destroy()); clients = [];
    clock.advance(20_000);
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce", cdkBootstrap: true });
    await simulator.start();
    endpoint = `http://127.0.0.1:${simulator.port}`;
    iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    sts = new STSClient({ endpoint, region, credentials, maxAttempts: 1 });
    const stableDynamo = new DynamoDBClient({ endpoint, region, credentials: temporaryCredentials(stable), maxAttempts: 1 });
    const legacyDynamo = new DynamoDBClient({ endpoint, region, credentials: temporaryCredentials(legacy), maxAttempts: 1 });
    const userDynamo = new DynamoDBClient({ endpoint, region, credentials: { accessKeyId: userKey.AccessKey!.AccessKeyId!, secretAccessKey: userKey.AccessKey!.SecretAccessKey! }, maxAttempts: 1 });
    clients.push(iam, sts, stableDynamo, legacyDynamo, userDynamo);
    assert.equal((simulator.store.ensureAccount().iam.sessions[stableKey] as any).issuedAt, issuedAt);
    assert.equal((simulator.store.ensureAccount().iam.sessions[legacyKey] as any).issuedAt, undefined);
    await stableDynamo.send(new ListTablesCommand({}));
    await assert.rejects(legacyDynamo.send(new ListTablesCommand({})), (error: any) => error.name === "AccessDeniedException");
    await userDynamo.send(new ListTablesCommand({}));

    const lambdaRole = await iam.send(new CreateRoleCommand({
      RoleName: "token-lambda",
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }),
    }));
    const lambda = new LambdaClient({ endpoint, region, credentials, maxAttempts: 1 });
    clients.push(lambda);
    await lambda.send(new CreateFunctionCommand({ FunctionName: "token-function", Runtime: "nodejs22.x", Role: lambdaRole.Role!.Arn!, Handler: "index.handler", Code: { ZipFile: createZip([{ name: "index.js", content: "exports.handler = async () => ({ ok: true });" }]) } }));
    await lambda.send(new InvokeCommand({ FunctionName: "token-function", Payload: Buffer.from("{}") }));
    const lambdaSessions = Object.values(simulator.store.ensureAccount().iam.sessions).filter(session => session.roleName === "token-lambda");
    assert.equal(lambdaSessions.length, 1);
    const lambdaSession = lambdaSessions[0] as any;
    assert.equal(lambdaSession.issuedAt, clock.now());
    const lambdaAccessKey = lambdaSession.accessKeyId;
    const lambdaIssuedAt = lambdaSession.issuedAt;
    clients.forEach(client => client.destroy()); clients = [];
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce", cdkBootstrap: true });
    await simulator.start();
    assert.equal((simulator.store.ensureAccount().iam.sessions[lambdaAccessKey] as any).issuedAt, lambdaIssuedAt);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
