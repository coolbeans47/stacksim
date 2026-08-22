import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APIGatewayClient, GetRestApisCommand } from "@aws-sdk/client-api-gateway";
import { CloudFormationClient, DescribeStacksCommand, ListStacksCommand } from "@aws-sdk/client-cloudformation";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { CLOUDFORMATION_SUPPORTED_ACTIONS } from "../src/cloudformation.js";
import {
  CDK_BOOTSTRAP_COMPATIBILITY_VERSION,
  CDK_BOOTSTRAP_POLICY_NAME,
  CDK_BOOTSTRAP_POLICY_REVISION,
  CDK_BOOTSTRAP_VERSION_PARAMETER,
  cdkBootstrapNames,
} from "../src/cloudformation/bootstrap.js";
import { CloudFormationJournal } from "../src/cloudformation/journal.js";
import { StackSim } from "../src/server.js";
import type { IamRoleState, PolicyDocument } from "../src/types.js";
import { cdkCli } from "./support/project-cli.js";

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "rest-stack");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const region = "eu-west-1";
const accountId = "000000000000";

interface CdkResult { code: number | null; stdout: string; stderr: string }
interface AwsCall {
  command: string;
  method: string;
  path: string;
  service: string;
  action: string;
  credentialAccessKeyId: string;
  host: string;
  region: string;
  parameterName?: string;
}

function statements(policy: PolicyDocument): any[] {
  return Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
}

function actions(policy: PolicyDocument, sid: string): string[] {
  const value = statements(policy).find(statement => statement.Sid === sid)?.Action;
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(String).sort();
}

function signingScope(authorization: string | undefined): { credentialAccessKeyId: string; region: string; service: string } {
  const match = authorization?.match(/Credential=([^/,\s]+)\/\d{8}\/([^/]+)\/([^/]+)\/aws4_request/);
  return { credentialAccessKeyId: match?.[1] ?? "unknown", region: match?.[2] ?? "unknown", service: match?.[3] ?? "unknown" };
}

function awsAction(service: string, body: Buffer, target: string | undefined, method: string, path: string): string {
  if (target) return target.slice(target.lastIndexOf(".") + 1);
  if (service === "s3") {
    const url = new URL(path, "http://local");
    if (method === "GET" && url.searchParams.get("list-type") === "2") return "ListObjectsV2";
    return `${method}ObjectOrBucket`;
  }
  return new URLSearchParams(body.toString("utf8")).get("Action") ?? "unknown";
}

async function tracingProxy(upstreamPort: number, calls: AwsCall[], currentCommand: () => string) {
  const proxy = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const scope = signingScope(incoming.headers.authorization);
    let parameterName: string | undefined;
    if (scope.service === "ssm") {
      try { parameterName = String(JSON.parse(body.toString("utf8")).Name ?? "") || undefined; }
      catch { /* The local service returns the protocol error. */ }
    }
    calls.push({
      command: currentCommand(),
      method: incoming.method ?? "GET",
      path: incoming.url ?? "/",
      service: scope.service,
      action: awsAction(scope.service, body, incoming.headers["x-amz-target"]?.toString(), incoming.method ?? "GET", incoming.url ?? "/"),
      credentialAccessKeyId: scope.credentialAccessKeyId,
      host: incoming.headers.host ?? "unknown",
      region: scope.region,
      ...(parameterName ? { parameterName } : {}),
    });
    const forwarded = request({ host: "127.0.0.1", port: upstreamPort, method: incoming.method, path: incoming.url, headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
      response.pipe(outgoing);
    });
    forwarded.on("error", error => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain" });
      outgoing.end(`local trace proxy failed: ${error.message}`);
    });
    forwarded.end(body);
  });
  await new Promise<void>((resolvePromise, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => { proxy.off("error", reject); resolvePromise(); });
  });
  return {
    endpoint: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolvePromise, reject) => proxy.close(error => error ? reject(error) : resolvePromise())),
  };
}

function cdkEnvironment(endpoint: string, tempRoot: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete env[key];
  }
  return {
    ...env,
    AWS_ACCESS_KEY_ID: "admin",
    AWS_SECRET_ACCESS_KEY: "password",
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_ENDPOINT_URL: endpoint,
    STACKSIM_NETWORK_ALLOW_PORT: new URL(endpoint).port,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_CONFIG_FILE: join(tempRoot, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(tempRoot, "no-aws-credentials"),
    CDK_DEFAULT_ACCOUNT: accountId,
    CDK_DEFAULT_REGION: region,
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    CDK_REST_TEST_VERSION: "v1",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

async function runCdk(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 150_000): Promise<CdkResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cdkCli, ...args, "--no-notices", "--no-color"], {
      cwd: fixture,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

test("an older persisted reduced bootstrap upgrades on restart before standard CDK REST deployment", { timeout: 420_000 }, async () => {
  await access(join(fixture, "app.ts"));
  await access(tripwire);
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-bootstrap-upgrade-"));
  const dataDir = join(root, "data");
  let simulator: StackSim | undefined = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "enforce", cdkBootstrap: true });
  let proxy: Awaited<ReturnType<typeof tracingProxy>> | undefined;
  const clients: Array<{ destroy(): void }> = [];
  const disconnect = () => { for (const client of clients.splice(0)) client.destroy(); };
  try {
    await simulator.start();
    const names = cdkBootstrapNames(accountId, region);
    const fresh = structuredClone(simulator.store.regionState(region).cloudformation.bootstrap!);
    assert.equal(fresh.policyRevision, CDK_BOOTSTRAP_POLICY_REVISION);
    assert.equal(fresh.compatibilityVersion, CDK_BOOTSTRAP_COMPATIBILITY_VERSION);
    assert.equal(Object.keys(simulator.store.regionState(region).cloudformation.stacks).length, 0, "fresh reduced bootstrap must not fabricate CDKToolkit");
    const roleIds = Object.fromEntries(Object.entries(names.roleNames).map(([key, roleName]) => [key, simulator!.store.ensureAccount().iam.roles[roleName].roleId]));

    // Persist the shape of an older simulator-owned revision. Reconciliation
    // must preserve identities while replacing stale owned policy content.
    const oldRevision = Math.max(0, CDK_BOOTSTRAP_POLICY_REVISION - 1);
    const regionState = simulator.store.regionState(region);
    regionState.cloudformation.bootstrap!.policyRevision = oldRevision;
    regionState.cloudformation.bootstrap!.compatibilityVersion = 8;
    regionState.cloudformation.bootstrap!.updatedAt = fresh.updatedAt - 60_000;
    regionState.s3Buckets[names.bucketName].managedRevision = oldRevision;
    regionState.s3Buckets[names.bucketName].versioning = "suspended";
    for (const roleName of Object.values(names.roleNames)) simulator.store.ensureAccount().iam.roles[roleName].tags["stacksim:policy-revision"] = String(oldRevision);
    simulator.store.ensureAccount().iam.roles[names.roleNames.deploy].inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME] = {
      Version: "2012-10-17", Statement: [{ Sid: "OldDeploy", Effect: "Allow", Action: "cloudformation:DescribeStacks", Resource: "*" }],
    };
    simulator.store.ensureAccount().iam.roles[names.roleNames.cloudFormationExecution].inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME] = {
      Version: "2012-10-17", Statement: [{ Sid: "OldExecution", Effect: "Allow", Action: "lambda:GetFunction", Resource: "*" }],
    };
    await simulator.store.save();
    const persistedOldUpdatedAt = regionState.cloudformation.bootstrap!.updatedAt;
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "enforce", cdkBootstrap: true });
    await simulator.start();
    const upgraded = structuredClone(simulator.store.regionState(region).cloudformation.bootstrap!);
    assert.equal(upgraded.policyRevision, CDK_BOOTSTRAP_POLICY_REVISION);
    assert.equal(upgraded.compatibilityVersion, CDK_BOOTSTRAP_COMPATIBILITY_VERSION);
    assert.ok(upgraded.updatedAt > persistedOldUpdatedAt, "upgrade reconciliation must record a new descriptor timestamp");
    assert.equal(upgraded.bucketName, fresh.bucketName);
    assert.deepEqual(upgraded.roleArns, fresh.roleArns);
    assert.deepEqual(Object.fromEntries(Object.entries(names.roleNames).map(([key, roleName]) => [key, simulator!.store.ensureAccount().iam.roles[roleName].roleId])), roleIds, "owned role identities must survive an in-place upgrade");
    assert.equal(simulator.store.regionState(region).s3Buckets[names.bucketName].managedRevision, CDK_BOOTSTRAP_POLICY_REVISION);
    assert.equal(simulator.store.regionState(region).s3Buckets[names.bucketName].versioning, "enabled");
    assert.equal(Object.values(simulator.store.regionState(region).s3Buckets).filter(bucket => bucket.managedBy === "stacksim-cdk-bootstrap").length, 1);
    assert.equal(Object.values(simulator.store.ensureAccount().iam.roles).filter(role => role.tags["stacksim:managed-by"] === "cdk-bootstrap").length, 5);
    assert.equal(simulator.store.regionState(region).cloudformation.stackNames.CDKToolkit, undefined);

    const deployRole = simulator.store.ensureAccount().iam.roles[names.roleNames.deploy];
    const deployPolicy = deployRole.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME];
    assert.deepEqual(actions(deployPolicy, "DirectCloudFormationDeployment"), CLOUDFORMATION_SUPPORTED_ACTIONS.filter(action => action !== "DescribeEvents").map(action => `cloudformation:${action}`).sort());
    assert.deepEqual(statements(deployPolicy).find(statement => statement.Sid === "DescribeChangeSetValidationEvents"), {
      Sid: "DescribeChangeSetValidationEvents", Effect: "Allow", Action: "cloudformation:DescribeEvents", Resource: `arn:aws:cloudformation:${region}:${accountId}:stack/*/*`,
    });
    assert.deepEqual(statements(deployPolicy).find(statement => statement.Sid === "PassCloudFormationExecutionRole"), {
      Sid: "PassCloudFormationExecutionRole", Effect: "Allow", Action: "iam:PassRole", Resource: names.roleArns.cloudFormationExecution,
    });
    const executionRole = simulator.store.ensureAccount().iam.roles[names.roleNames.cloudFormationExecution];
    const executionPolicy = executionRole.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME];
    for (const [sid, required] of Object.entries({
      ManageIamResources: ["iam:CreateRole", "iam:DeleteRole", "iam:PutRolePolicy"],
      ManageApplicationBuckets: ["s3:CreateBucket", "s3:PutBucketWebsite", "s3:PutBucketPolicy"],
      ManageLambdaResources: ["lambda:CreateFunction", "lambda:DeleteFunction", "lambda:UpdateFunctionCode", "lambda:PublishLayerVersion", "lambda:InvokeFunction"],
      ManageLogGroups: ["logs:CreateLogGroup", "logs:DeleteLogGroup"],
      ManageRestApis: ["apigateway:GET", "apigateway:POST", "apigateway:DELETE"],
      ManageDynamoDbTables: ["dynamodb:CreateTable", "dynamodb:DeleteTable", "dynamodb:UpdateTable"],
    })) {
      const actual = actions(executionPolicy, sid);
      for (const action of required) assert.ok(actual.includes(action), `${sid} did not restore ${action}`);
    }
    for (const roleName of Object.values(names.roleNames)) {
      const managedRole: IamRoleState = simulator.store.ensureAccount().iam.roles[roleName];
      assert.equal(managedRole.tags["stacksim:policy-revision"], String(CDK_BOOTSTRAP_POLICY_REVISION));
      assert.equal(statements(managedRole.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME]).some(statement => statement.Action === "*" || (Array.isArray(statement.Action) && statement.Action.includes("*"))), false);
    }

    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const localOptions = { endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    const ssm = new SSMClient(localOptions); clients.push(ssm);
    assert.equal((await ssm.send(new GetParameterCommand({ Name: CDK_BOOTSTRAP_VERSION_PARAMETER }))).Parameter?.Value, String(CDK_BOOTSTRAP_COMPATIBILITY_VERSION));

    const calls: AwsCall[] = [];
    let command = "startup";
    proxy = await tracingProxy(simulator.port, calls, () => command);
    const env = cdkEnvironment(proxy.endpoint, root);
    const outputsFile = join(root, "outputs.json");
    command = "deploy-upgraded-bootstrap";
    const deployed = await runCdk(["--output", join(root, "deploy.out"), "deploy", "RestStack", "--require-approval", "never", "--outputs-file", outputsFile], env);
    assert.equal(deployed.code, 0, `${deployed.stdout}\n${deployed.stderr}\ntrace=${JSON.stringify(calls, null, 2)}`);

    const cloudformation = new CloudFormationClient(localOptions); const lambda = new LambdaClient(localOptions); const dynamodb = new DynamoDBClient(localOptions); const apiGateway = new APIGatewayClient(localOptions);
    clients.push(cloudformation, lambda, dynamodb, apiGateway);
    const stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: "RestStack" }))).Stacks?.[0];
    assert.equal(stack?.StackStatus, "CREATE_COMPLETE");
    assert.equal(stack?.RoleARN, names.roleArns.cloudFormationExecution, "standard CDK must persist the reconciled CloudFormation execution role");
    const outputs = JSON.parse(await readFile(outputsFile, "utf8")).RestStack as Record<string, string>;
    assert.ok((await lambda.send(new GetFunctionCommand({ FunctionName: outputs.FunctionName }))).Configuration?.FunctionArn);
    assert.ok((await dynamodb.send(new DescribeTableCommand({ TableName: outputs.TableName }))).Table?.TableArn);
    assert.ok((await apiGateway.send(new GetRestApisCommand({}))).items?.some(api => api.id === outputs.ApiId));

    const invokeBase = `http://127.0.0.1:${simulator.invokePort}/${outputs.ApiId}/${outputs.Stage}`;
    const written = await fetch(`${invokeBase}/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "upgrade", value: "reconciled" }) });
    assert.equal(written.status, 200);
    const read = await fetch(`${invokeBase}/items/upgrade`);
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json() as any).item, { id: "upgrade", value: "reconciled" }, "the CDK Lambda must use the CDK DynamoDB table through the local invoke plane");

    const stackId = simulator.store.regionState(region).cloudformation.stackNames.RestStack;
    const stackState = simulator.store.regionState(region).cloudformation.stacks[stackId];
    assert.ok(stackState.templateArtifactId);
    const journal = new CloudFormationJournal(dataDir, accountId, region);
    await journal.start();
    const executionPrincipal = await journal.readJsonArtifact<any>("execution", `${stackState.templateArtifactId}.principal.json`);
    assert.equal(executionPrincipal?.roleArn, names.roleArns.cloudFormationExecution);
    assert.match(executionPrincipal?.principalArn ?? "", new RegExp(`^arn:aws:sts::${accountId}:assumed-role/${names.roleNames.cloudFormationExecution}/`));
    assert.notEqual(executionPrincipal?.principalArn, `arn:aws:iam::${accountId}:root`);
    const executionSession = simulator.store.ensureAccount().iam.sessions[executionPrincipal.accessKeyId];
    assert.equal(executionSession?.roleArn, names.roleArns.cloudFormationExecution, "provider authorization must use the execution-role session recorded in the durable operation artifact");

    assert.ok(calls.length > 0);
    assert.ok(calls.every(call => call.path.startsWith("/")));
    assert.ok(calls.every(call => call.host === new URL(proxy!.endpoint).host), "every standard-CDK request must use the configured loopback endpoint");
    assert.ok(calls.every(call => call.region === region));
    assert.ok(calls.some(call => call.command === command && call.service === "ssm" && call.parameterName === CDK_BOOTSTRAP_VERSION_PARAMETER));
    const assetPut = calls.find(call => call.command === command && call.service === "s3" && call.method === "PUT");
    assert.ok(assetPut, "the reconciled file-publishing role must publish the Lambda asset locally");
    assert.equal(simulator.store.ensureAccount().iam.sessions[assetPut.credentialAccessKeyId]?.roleArn, names.roleArns.filePublishing);
    const deploymentCalls = calls.filter(call => call.command === command && call.service === "cloudformation" && ["CreateChangeSet", "ExecuteChangeSet"].includes(call.action));
    assert.deepEqual([...new Set(deploymentCalls.map(call => call.action))].sort(), ["CreateChangeSet", "ExecuteChangeSet"]);
    for (const call of deploymentCalls) {
      assert.equal(simulator.store.ensureAccount().iam.sessions[call.credentialAccessKeyId]?.roleArn, names.roleArns.deploy, `${call.action} must use the deployment-role session`);
    }

    command = "destroy-upgraded-bootstrap";
    const destroyed = await runCdk(["--output", join(root, "destroy.out"), "destroy", "RestStack", "--force"], env);
    assert.equal(destroyed.code, 0, `${destroyed.stdout}\n${destroyed.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    const deleteCall = calls.find(call => call.command === command && call.service === "cloudformation" && call.action === "DeleteStack");
    assert.ok(deleteCall);
    assert.equal(simulator.store.ensureAccount().iam.sessions[deleteCall.credentialAccessKeyId]?.roleArn, names.roleArns.deploy);
    assert.equal((await cloudformation.send(new ListStacksCommand({ StackStatusFilter: ["CREATE_COMPLETE", "DELETE_IN_PROGRESS"] }))).StackSummaries?.length, 0);
    await assert.rejects(lambda.send(new GetFunctionCommand({ FunctionName: outputs.FunctionName })), error => (error as { name?: string }).name === "ResourceNotFoundException");
    await assert.rejects(dynamodb.send(new DescribeTableCommand({ TableName: outputs.TableName })), error => (error as { name?: string }).name === "ResourceNotFoundException");
    assert.equal((await apiGateway.send(new GetRestApisCommand({}))).items?.some(api => api.id === outputs.ApiId), false);
    assert.ok(simulator.store.regionState(region).s3Buckets[names.bucketName], "cdk destroy must preserve the upgraded simulator-managed bootstrap");

    disconnect();
    await proxy.close(); proxy = undefined;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "enforce", cdkBootstrap: true });
    await simulator.start();
    assert.deepEqual(simulator.store.regionState(region).cloudformation.bootstrap, upgraded, "a second restart at the current revision must be idempotent");
    assert.deepEqual(Object.fromEntries(Object.entries(names.roleNames).map(([key, roleName]) => [key, simulator!.store.ensureAccount().iam.roles[roleName].roleId])), roleIds);
  } finally {
    disconnect();
    await proxy?.close().catch(() => undefined);
    await simulator?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
