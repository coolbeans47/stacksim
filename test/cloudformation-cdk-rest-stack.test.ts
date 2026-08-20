import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GetRestApiCommand, GetRestApisCommand, GetStageCommand, APIGatewayClient } from "@aws-sdk/client-api-gateway";
import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand, ListStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient, ListMetricsCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeTableCommand, DescribeTimeToLiveCommand, DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { GetAliasCommand, GetFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { StackSim } from "../src/server.js";
import { semanticCdkAssemblyDigests } from "./support/artifact-snapshots.js";
import { cdkCli, cdkCommandTimeoutMs } from "./support/project-cli.js";

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "rest-stack");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const region = "eu-west-1";
const expectedResourceTypes = Object.freeze({
  "AWS::ApiGateway::Account": 1,
  "AWS::ApiGateway::Deployment": 1,
  "AWS::ApiGateway::Method": 5,
  "AWS::ApiGateway::Resource": 3,
  "AWS::ApiGateway::RestApi": 1,
  "AWS::ApiGateway::Stage": 1,
  "AWS::CDK::Metadata": 1,
  "AWS::DynamoDB::Table": 1,
  "AWS::IAM::Policy": 1,
  "AWS::IAM::Role": 2,
  "AWS::Lambda::Alias": 1,
  "AWS::Lambda::Function": 1,
  "AWS::Lambda::Permission": 10,
  "AWS::Lambda::Version": 1,
  "AWS::Logs::LogGroup": 1,
});

interface CdkResult { code: number | null; stdout: string; stderr: string }

function cdkEnvironment(endpoint: string, tempRoot: string, release: string): NodeJS.ProcessEnv {
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
    CDK_DEFAULT_ACCOUNT: "000000000000",
    CDK_DEFAULT_REGION: region,
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    JSII_AGENT: "stacksim-tests/1", // Keep CDK metadata hashes independent of the host Node.js version.
    CDK_REST_TEST_VERSION: release,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

async function runCdk(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = cdkCommandTimeoutMs): Promise<CdkResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cdkCli, ...args, "--no-notices", "--no-color"], {
      cwd: fixture, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    let timedOut = false;
    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (timedOut) {
        reject(new Error(`CDK command timed out after ${timeoutMs}ms: ${args.join(" ")}\nstdout:\n${stdoutText}\nstderr:\n${stderrText}`));
        return;
      }
      resolvePromise({ code, stdout: stdoutText, stderr: stderrText });
    });
  });
}

function signedGetHeaders(urlValue: string, date = new Date()): Record<string, string> {
  const url = new URL(urlValue); const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, ""); const shortDate = amzDate.slice(0, 8); const payloadHash = createHash("sha256").update("").digest("hex");
  const values: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(values).sort(); const canonicalHeaders = names.map(name => `${name}:${values[name]}\n`).join(""); const canonicalQuery = [...url.searchParams.entries()].map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])).map(([key, value]) => `${key}=${value}`).join("&");
  const canonicalRequest = `GET\n${url.pathname}\n${canonicalQuery}\n${canonicalHeaders}\n${names.join(";")}\n${payloadHash}`; const scope = `${shortDate}/${region}/execute-api/aws4_request`; const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest(); const signingKey = hmac(hmac(hmac(hmac("AWS4password", shortDate), region), "execute-api"), "aws4_request"); const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const headers = Object.fromEntries(Object.entries(values).filter(([name]) => name !== "host")); headers.authorization = `AWS4-HMAC-SHA256 Credential=admin/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`; return headers;
}

test("standard CDK deploys, updates, restarts, invokes, and destroys a Lambda REST API with DynamoDB", { timeout: 1_200_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-rest-"));
  const dataDir = join(root, "data");
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    let endpoint = `http://127.0.0.1:${simulator.port}`;
    const clientOptions = { endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(clientOptions); clients.push(cloudformation);
    const lambda = new LambdaClient(clientOptions); clients.push(lambda);
    const dynamodb = new DynamoDBClient(clientOptions); clients.push(dynamodb);
    const apiGateway = new APIGatewayClient(clientOptions); clients.push(apiGateway);
    const cloudwatch = new CloudWatchClient(clientOptions); clients.push(cloudwatch);
    const logs = new CloudWatchLogsClient(clientOptions); clients.push(logs);
    const outputsFile = join(root, "outputs.json");

    let env = cdkEnvironment(endpoint, root, "v1");
    const initialDiff = await runCdk(["--output", join(root, "initial-diff.out"), "diff", "RestStack", "--method", "template"], env);
    assert.equal(initialDiff.code, 0, `${initialDiff.stdout}\n${initialDiff.stderr}`);
    assert.match(`${initialDiff.stdout}\n${initialDiff.stderr}`, /Stack RestStack|Resources/i, "the fresh-stack template diff did not inspect the synthesized REST stack");
    assert.equal(Object.keys(simulator.store.regionState(region).cloudformation.stacks).length, 0, "template diff must not accept or mutate a stack");
    const created = await runCdk(["--output", join(root, "create.out"), "deploy", "RestStack", "--require-approval", "never", "--outputs-file", outputsFile], env);
    assert.equal(created.code, 0, `${created.stdout}\n${created.stderr}`);
    const stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: "RestStack" }))).Stacks?.[0];
    assert.equal(stack?.StackStatus, "CREATE_COMPLETE");
    const outputs = JSON.parse(await readFile(outputsFile, "utf8")).RestStack as Record<string, string>;
    assert.ok(outputs.FunctionName); assert.ok(outputs.FunctionVersion); assert.ok(outputs.AliasArn); assert.ok(outputs.TableName); assert.ok(outputs.ApiId); assert.equal(outputs.Stage, "prod");
    assert.match(outputs.ApiUrl, /^https:\/\/.+\.execute-api\..+\.amazonaws\.com\/prod\/$/, "the ordinary CDK URL output remains AWS-shaped");
    const originalFunction = await lambda.send(new GetFunctionCommand({ FunctionName: outputs.FunctionName }));
    assert.equal(originalFunction.Configuration?.FunctionName, outputs.FunctionName);
    const originalAlias = await lambda.send(new GetAliasCommand({ FunctionName: outputs.FunctionName, Name: "live" }));
    assert.equal(originalAlias.AliasArn, outputs.AliasArn);
    assert.equal(originalAlias.FunctionVersion, outputs.FunctionVersion);
    const tableDescription = (await dynamodb.send(new DescribeTableCommand({ TableName: outputs.TableName }))).Table;
    assert.equal(tableDescription?.TableName, outputs.TableName);
    assert.equal(tableDescription?.StreamSpecification?.StreamEnabled, true);
    assert.equal(tableDescription?.StreamSpecification?.StreamViewType, "NEW_AND_OLD_IMAGES");
    assert.equal(tableDescription?.GlobalSecondaryIndexes?.find(index => index.IndexName === "byValue")?.IndexStatus, "ACTIVE");
    assert.equal((await dynamodb.send(new DescribeTimeToLiveCommand({ TableName: outputs.TableName }))).TimeToLiveDescription?.TimeToLiveStatus, "ENABLED");
    const createAssembly = join(root, "create.out");
    const templateBytes = await readFile(join(createAssembly, "RestStack.template.json"));
    const template = JSON.parse(templateBytes.toString("utf8")) as { Resources: Record<string, { Type: string; Properties?: Record<string, any> }> };
    const createDigests = await semanticCdkAssemblyDigests(createAssembly, ["RestStack.template.json"], ["RestStack.assets.json", "manifest.json"]);
    assert.deepEqual(createDigests, {
      "RestStack.template.json": "8a4012b58e6f8791725ab9b1d058329ee10e53d6c8253d9573d63a93822e465e",
      "RestStack.assets.json": "3628a65edaf7100d2b3893976e5cbfbf24d86130a21e277844d6cdebcab4ab3c",
      "manifest.json": "fd706cc39ee541144566d54bf88505431d4c0ce7d5569a0f3b9d8400aa305637",
    }, "the pinned REST semantic assembly drifted");
    const resourceTypes = Object.fromEntries(Object.entries(Object.values(template.Resources).reduce<Record<string, number>>((counts, resource) => ({ ...counts, [resource.Type]: (counts[resource.Type] ?? 0) + 1 }), {})).sort(([left], [right]) => left.localeCompare(right)));
    assert.deepEqual(resourceTypes, expectedResourceTypes, "the pinned CDK 2.1132.0/aws-cdk-lib 2.265.0 resource corpus must not drift silently");
    const tableTemplate = Object.values(template.Resources).find(resource => resource.Type === "AWS::DynamoDB::Table");
    assert.equal(tableTemplate?.Properties?.StreamSpecification?.StreamViewType, "NEW_AND_OLD_IMAGES");
    assert.deepEqual(tableTemplate?.Properties?.TimeToLiveSpecification, { AttributeName: "expiresAt", Enabled: true });
    assert.ok(tableTemplate?.Properties?.GlobalSecondaryIndexes?.some((index: any) => index.IndexName === "byValue"));
    assert.ok(Object.values(template.Resources).some(resource => resource.Type === "AWS::ApiGateway::Method" && resource.Properties?.AuthorizationType === "AWS_IAM"));
    const aliasEntry = Object.entries(template.Resources).find(([, resource]) => resource.Type === "AWS::Lambda::Alias");
    assert.ok(aliasEntry, "the main REST fixture must route through a Lambda alias");
    const [aliasLogicalId] = aliasEntry!;
    assert.equal(Object.values(template.Resources).filter(resource => resource.Type === "AWS::Lambda::Permission").every(resource => JSON.stringify(resource.Properties?.FunctionName) === JSON.stringify({ Ref: aliasLogicalId })), true, "all deployed/test-invoke permissions must target the Lambda alias");
    assert.equal(Object.values(template.Resources).filter(resource => resource.Type === "AWS::ApiGateway::Method").every(resource => JSON.stringify(resource.Properties?.Integration?.Uri).includes(`\"Ref\":\"${aliasLogicalId}\"`)), true, "all REST integrations must invoke the Lambda alias");
    const deploymentEntry = Object.entries(template.Resources).find(([, resource]) => resource.Type === "AWS::ApiGateway::Deployment");
    assert.deepEqual([...(deploymentEntry?.[1] as any)?.DependsOn ?? []].sort(), [
      "Apiitems8F0ED6C4",
      "ApiitemsPOST55EC2F9D",
      "ApiitemsidDELETE8DBAEF8D",
      "ApiitemsidE0B74190",
      "ApiitemsidGET54650149",
      "ApiitemsidPUT97D4F737",
      "Apisecure35752B8A",
      "ApisecureGET838F83B5",
    ].sort(), "the pinned CDK deployment dependency corpus drifted");
    const apis = (await apiGateway.send(new GetRestApisCommand({}))).items ?? [];
    assert.equal(apis.length, 1, "the CDK stack must create exactly one REST API");
    const api = apis[0];
    assert.equal(api.id, outputs.ApiId, "ApiId must be the authoritative API Gateway identifier");
    assert.equal(api.description, "stacksim REST CRUD fixture");
    const originalDeploymentId = (await apiGateway.send(new GetStageCommand({ restApiId: outputs.ApiId, stageName: outputs.Stage }))).deploymentId;
    assert.ok(originalDeploymentId);
    const invokeBase = `http://127.0.0.1:${simulator.invokePort}/${outputs.ApiId}/${outputs.Stage}`;
    const written = await fetch(`${invokeBase}/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "one", value: "first" }) });
    assert.equal(written.status, 200); assert.deepEqual(await written.json(), { ok: true, tableName: outputs.TableName, release: "v1", path: "/items", item: { id: "one", value: "first" } });
    const first = await fetch(`${invokeBase}/items/one`);
    assert.equal(first.status, 200); assert.deepEqual(await first.json(), { ok: true, tableName: outputs.TableName, release: "v1", path: "/items/one", item: { id: "one", value: "first" } });
    const changed = await fetch(`${invokeBase}/items/one`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "changed" }) });
    assert.equal(changed.status, 200); assert.deepEqual(await changed.json(), { ok: true, tableName: outputs.TableName, release: "v1", path: "/items/one", item: { id: "one", value: "changed" } });
    assert.deepEqual(await (await fetch(`${invokeBase}/items/one`)).json(), { ok: true, tableName: outputs.TableName, release: "v1", path: "/items/one", item: { id: "one", value: "changed" } });
    const removed = await fetch(`${invokeBase}/items/one`, { method: "DELETE" });
    assert.equal(removed.status, 200); assert.deepEqual(await removed.json(), { ok: true, tableName: outputs.TableName, release: "v1", path: "/items/one", item: { id: "one", value: "changed" } });
    assert.deepEqual(await (await fetch(`${invokeBase}/items/one`)).json(), { ok: true, tableName: outputs.TableName, release: "v1", path: "/items/one" });
    assert.equal((await fetch(`${invokeBase}/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "one", value: "first" }) })).status, 200, "restore the CRUD item for update/restart assertions");
    const indexed = await dynamodb.send(new QueryCommand({ TableName: outputs.TableName, IndexName: "byValue", KeyConditionExpression: "#value = :value", ExpressionAttributeNames: { "#value": "value" }, ExpressionAttributeValues: { ":value": { S: "first" } } }));
    assert.equal(indexed.Items?.[0]?.id?.S, "one", "the CDK-created GSI must be queryable");
    const secureUrl = `${invokeBase}/secure`;
    assert.equal((await fetch(secureUrl)).status, 403, "the AWS_IAM route must reject unsigned requests");
    const secure = await fetch(secureUrl, { headers: signedGetHeaders(secureUrl) });
    assert.equal(secure.status, 200); assert.deepEqual(await secure.json(), { ok: true, tableName: outputs.TableName, release: "v1", path: "/secure" });
    const stackResources = (await cloudformation.send(new ListStackResourcesCommand({ StackName: "RestStack" }))).StackResourceSummaries ?? [];
    const handlerLogGroup = stackResources.find(resource => resource.ResourceType === "AWS::Logs::LogGroup")?.PhysicalResourceId;
    assert.ok(handlerLogGroup, "the standard-CDK stack must expose its Lambda log group through CloudFormation");
    const handlerEvents = await logs.send(new FilterLogEventsCommand({ logGroupName: handlerLogGroup }));
    assert.ok((handlerEvents.events?.length ?? 0) > 0, "REST invocations must write service logs to the CloudFormation-managed log group");
    const lambdaMetrics = await cloudwatch.send(new ListMetricsCommand({ Namespace: "AWS/Lambda", MetricName: "Invocations", Dimensions: [{ Name: "FunctionName", Value: outputs.FunctionName }] }));
    assert.ok((lambdaMetrics.Metrics?.length ?? 0) > 0, "REST calls must publish Lambda invocation metrics");
    const apiMetrics = await cloudwatch.send(new ListMetricsCommand({ Namespace: "AWS/ApiGateway", MetricName: "Count", Dimensions: [{ Name: "ApiName", Value: api.name! }, { Name: "Stage", Value: outputs.Stage }] }));
    assert.ok((apiMetrics.Metrics?.length ?? 0) > 0, "REST calls must publish API Gateway service metrics");
    const tableMetrics = await cloudwatch.send(new ListMetricsCommand({ Namespace: "AWS/DynamoDB", MetricName: "ConsumedWriteCapacityUnits", Dimensions: [{ Name: "TableName", Value: outputs.TableName }] }));
    assert.ok((tableMetrics.Metrics?.length ?? 0) > 0, "REST CRUD must publish DynamoDB service metrics");

    env = cdkEnvironment(endpoint, root, "code-v2");
    const beforeDiff = new Set(Object.keys(simulator.store.regionState(region).cloudformation.changeSets));
    const difference = await runCdk(["--output", join(root, "diff.out"), "diff", "RestStack", "--method", "change-set"], env);
    assert.equal(difference.code, 0, `${difference.stdout}\n${difference.stderr}`);
    const diffChangeSets = Object.values(simulator.store.regionState(region).cloudformation.changeSets).filter(changeSet => !beforeDiff.has(changeSet.changeSetId));
    const codeDiff = diffChangeSets.find(changeSet => changeSet.status === "DELETE_COMPLETE" && changeSet.executionStatus === "UNAVAILABLE" && JSON.stringify(changeSet.changes).includes("AWS::Lambda::Function"));
    assert.ok(codeDiff, "change-set diff must plan the Lambda code update and then delete its read-only change set");
    assert.doesNotMatch(JSON.stringify(codeDiff!.changes), /AWS::ApiGateway::(?:Deployment|Method|RestApi)|AWS::DynamoDB::Table/, "a code-only change set must not redeploy the API or mutate the table");
    const updated = await runCdk(["--output", join(root, "update.out"), "deploy", "RestStack", "--require-approval", "never"], env);
    assert.equal(updated.code, 0, `${updated.stdout}\n${updated.stderr}`);
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "RestStack" }))).Stacks?.[0]?.StackStatus, "UPDATE_COMPLETE");
    const updatedFunction = await lambda.send(new GetFunctionCommand({ FunctionName: outputs.FunctionName }));
    assert.equal(updatedFunction.Configuration?.FunctionArn, originalFunction.Configuration?.FunctionArn, "a code-only deploy must not replace the function");
    assert.notEqual(updatedFunction.Configuration?.CodeSha256, originalFunction.Configuration?.CodeSha256, "the v2 file asset must update the function code bytes");
    assert.equal((await dynamodb.send(new DescribeTableCommand({ TableName: outputs.TableName }))).Table?.TableArn, tableDescription?.TableArn, "a code-only deploy must preserve the table");
    assert.equal((await apiGateway.send(new GetRestApisCommand({}))).items?.[0]?.id, outputs.ApiId, "a code-only deploy must preserve the REST API");
    assert.equal((await apiGateway.send(new GetStageCommand({ restApiId: outputs.ApiId, stageName: outputs.Stage }))).deploymentId, originalDeploymentId, "a code-only deploy must not publish a new API deployment");
    const updatedAlias = await lambda.send(new GetAliasCommand({ FunctionName: outputs.FunctionName, Name: "live" }));
    assert.equal(updatedAlias.AliasArn, originalAlias.AliasArn, "the code-only update must preserve the alias identity");
    assert.notEqual(updatedAlias.FunctionVersion, originalAlias.FunctionVersion, "the alias must advance to the newly published function version");
    assert.equal((await fetch(`${invokeBase}/health`)).status, 403, "the code-only update must retain API Gateway's missing-route response instead of adding the later API route");
    const second = await fetch(`${invokeBase}/items/two`);
    assert.equal(second.status, 200); assert.deepEqual(await second.json(), { ok: true, tableName: outputs.TableName, release: "v2", path: "/items/two" });
    const persisted = await fetch(`${invokeBase}/items/one`);
    assert.equal(persisted.status, 200); assert.deepEqual(await persisted.json(), { ok: true, tableName: outputs.TableName, release: "v2", path: "/items/one", item: { id: "one", value: "first" } });

    env = cdkEnvironment(endpoint, root, "api-v2");
    const apiUpdated = await runCdk(["--output", join(root, "api-update.out"), "deploy", "RestStack", "--require-approval", "never"], env);
    assert.equal(apiUpdated.code, 0, `${apiUpdated.stdout}\n${apiUpdated.stderr}`);
    const updatedDeploymentId = (await apiGateway.send(new GetStageCommand({ restApiId: outputs.ApiId, stageName: outputs.Stage }))).deploymentId;
    assert.ok(updatedDeploymentId); assert.notEqual(updatedDeploymentId, originalDeploymentId, "the independent health-route update must publish a new immutable API deployment");
    assert.equal((await lambda.send(new GetFunctionCommand({ FunctionName: outputs.FunctionName }))).Configuration?.CodeSha256, updatedFunction.Configuration?.CodeSha256, "the API-only update must not republish Lambda code");
    assert.equal((await lambda.send(new GetAliasCommand({ FunctionName: outputs.FunctionName, Name: "live" }))).FunctionVersion, updatedAlias.FunctionVersion, "the API-only update must not move the Lambda alias");
    assert.deepEqual(await (await fetch(`${invokeBase}/health`)).json(), { ok: true, tableName: outputs.TableName, release: "v2", path: "/health" });

    const noOp = await runCdk(["--output", join(root, "noop.out"), "deploy", "RestStack", "--require-approval", "never"], env);
    assert.equal(noOp.code, 0, `${noOp.stdout}\n${noOp.stderr}`); assert.match(`${noOp.stdout}\n${noOp.stderr}`, /no changes/i);
    const beforeForce = new Set(Object.keys(simulator.store.regionState(region).cloudformation.changeSets));
    const forced = await runCdk(["--output", join(root, "force.out"), "deploy", "RestStack", "--require-approval", "never", "--force"], env);
    assert.equal(forced.code, 0, `${forced.stdout}\n${forced.stderr}`);
    const forcedChangeSets = Object.values(simulator.store.regionState(region).cloudformation.changeSets).filter(changeSet => !beforeForce.has(changeSet.changeSetId));
    assert.ok(forcedChangeSets.some(changeSet => changeSet.status === "DELETE_COMPLETE" && changeSet.executionStatus === "UNAVAILABLE" && !changeSet.executionOperationId), `forced no-op must create, describe, and delete an unexecutable empty change set: ${JSON.stringify(forcedChangeSets)}`);

    env = cdkEnvironment(endpoint, root, "v3");
    const beforeDefaultDiff = new Set(Object.keys(simulator.store.regionState(region).cloudformation.changeSets));
    const defaultDifference = await runCdk(["--output", join(root, "default-diff.out"), "diff", "RestStack"], env);
    assert.equal(defaultDifference.code, 0, `${defaultDifference.stdout}\n${defaultDifference.stderr}`);
    const defaultDiffChangeSets = Object.values(simulator.store.regionState(region).cloudformation.changeSets).filter(changeSet => !beforeDefaultDiff.has(changeSet.changeSetId));
    assert.ok(defaultDiffChangeSets.some(changeSet => changeSet.status === "DELETE_COMPLETE" && JSON.stringify(changeSet.changes).includes("AWS::DynamoDB::Table")), "bare cdk diff must exercise the default read-only change-set path");
    const tableUpdate = await runCdk(["--output", join(root, "table-update.out"), "deploy", "RestStack", "--require-approval", "never"], env);
    assert.equal(tableUpdate.code, 0, `${tableUpdate.stdout}\n${tableUpdate.stderr}`);
    const tableAfterIndexUpdate = (await dynamodb.send(new DescribeTableCommand({ TableName: outputs.TableName }))).Table;
    assert.equal(tableAfterIndexUpdate?.TableArn, tableDescription?.TableArn, "adding a supported GSI must update the existing table");
    assert.deepEqual(tableAfterIndexUpdate?.GlobalSecondaryIndexes?.map(index => index.IndexName).sort(), ["byCategory", "byValue"]);
    assert.deepEqual(tableAfterIndexUpdate?.WarmThroughput, { ReadUnitsPerSecond: 20, WriteUnitsPerSecond: 10, Status: "ACTIVE" });

    env = cdkEnvironment(endpoint, root, "ddb-invalid");
    const failedUpdate = await runCdk(["--output", join(root, "invalid.out"), "deploy", "RestStack", "--require-approval", "never", "--no-rollback"], env);
    assert.notEqual(failedUpdate.code, 0, "the invalid table update must fail without fabricating completion");
    assert.match(`${failedUpdate.stdout}\n${failedUpdate.stderr}`, /WarmThroughput|unsupported.*remov/i, "the failed standard-CDK update must expose the real DynamoDB configuration failure");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "RestStack" }))).Stacks?.[0]?.StackStatus, "UPDATE_FAILED", `${failedUpdate.stdout}\n${failedUpdate.stderr}`);
    const partiallyUpdatedTable = (await dynamodb.send(new DescribeTableCommand({ TableName: outputs.TableName }))).Table;
    assert.deepEqual(partiallyUpdatedTable?.GlobalSecondaryIndexes?.map(index => index.IndexName).sort(), ["byCategory", "byValue"]);
    assert.deepEqual(partiallyUpdatedTable?.OnDemandThroughput, { MaxReadRequestUnits: 50, MaxWriteRequestUnits: 40 }, "the failing composite update must have applied a real earlier table mutation");
    assert.deepEqual(partiallyUpdatedTable?.WarmThroughput, { ReadUnitsPerSecond: 20, WriteUnitsPerSecond: 10, Status: "ACTIVE" }, "the rejected configuration itself must not be fabricated as applied");
    const rolledBack = await runCdk(["--output", join(root, "rollback.out"), "rollback", "RestStack", "--yes"], env);
    assert.equal(rolledBack.code, 0, `${rolledBack.stdout}\n${rolledBack.stderr}`);
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "RestStack" }))).Stacks?.[0]?.StackStatus, "UPDATE_ROLLBACK_COMPLETE");
    const rollbackStackState = simulator.store.regionState(region).cloudformation.stacks[simulator.store.regionState(region).cloudformation.stackNames.RestStack];
    assert.equal(rollbackStackState.activeOperation?.kind, "ROLLBACK_UPDATE", "standard cdk rollback must route through the RollbackStack recovery operation");
    assert.equal((await apiGateway.send(new GetRestApiCommand({ restApiId: outputs.ApiId }))).description, "stacksim REST CRUD fixture API v2", "rollback must restore the prior API configuration");
    assert.equal((await apiGateway.send(new GetStageCommand({ restApiId: outputs.ApiId, stageName: outputs.Stage }))).deploymentId, updatedDeploymentId, "rollback must restore the prior immutable deployment pointer");
    assert.equal((await lambda.send(new GetFunctionCommand({ FunctionName: outputs.FunctionName }))).Configuration?.MemorySize, 256, "cdk rollback must restore the prior Lambda configuration");
    const restoredTable = (await dynamodb.send(new DescribeTableCommand({ TableName: outputs.TableName }))).Table;
    assert.deepEqual(restoredTable?.GlobalSecondaryIndexes?.map(index => index.IndexName).sort(), ["byCategory", "byValue"]);
    assert.equal(restoredTable?.OnDemandThroughput, undefined, "cdk rollback must remove the capacity limits applied before the table failure");
    assert.deepEqual(restoredTable?.WarmThroughput, { ReadUnitsPerSecond: 20, WriteUnitsPerSecond: 10, Status: "ACTIVE" });
    assert.equal((await fetch(`${invokeBase}/health`)).status, 200, "the previously deployed API remains callable after rollback");

    env = cdkEnvironment(endpoint, root, "api-invalid");
    const invalidMethodUpdate = await runCdk(["--output", join(root, "api-invalid.out"), "deploy", "RestStack", "--require-approval", "never"], env);
    assert.notEqual(invalidMethodUpdate.code, 0, "a duplicate API method must fail through the standard CDK change-set path");
    assert.match(`${invalidMethodUpdate.stdout}\n${invalidMethodUpdate.stderr}`, /Method POST already exists|ConflictException/i, "the API method provider failure must remain visible to CDK");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "RestStack" }))).Stacks?.[0]?.StackStatus, "UPDATE_ROLLBACK_COMPLETE", `${invalidMethodUpdate.stdout}\n${invalidMethodUpdate.stderr}`);
    assert.equal((await apiGateway.send(new GetStageCommand({ restApiId: outputs.ApiId, stageName: outputs.Stage }))).deploymentId, updatedDeploymentId, "automatic rollback must preserve the last valid immutable deployment");
    assert.equal((await lambda.send(new GetFunctionCommand({ FunctionName: outputs.FunctionName }))).Configuration?.MemorySize, 256, "automatic rollback must restore mutations completed before the invalid method");

    for (const client of clients) client.destroy(); clients.length = 0;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "enforce", cdkBootstrap: true });
    await simulator.start(); endpoint = `http://127.0.0.1:${simulator.port}`; env = cdkEnvironment(endpoint, root, "v3");
    const restartedOptions = { endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    const restartedCloudFormation = new CloudFormationClient(restartedOptions); const restartedLambda = new LambdaClient(restartedOptions); const restartedDynamoDb = new DynamoDBClient(restartedOptions); const restartedApiGateway = new APIGatewayClient(restartedOptions); clients.push(restartedCloudFormation, restartedLambda, restartedDynamoDb, restartedApiGateway);
    const restartedBase = `http://127.0.0.1:${simulator.invokePort}/${outputs.ApiId}/${outputs.Stage}`;
    const afterRestart = await fetch(`${restartedBase}/items/one`);
    assert.equal(afterRestart.status, 200); assert.deepEqual(await afterRestart.json(), { ok: true, tableName: outputs.TableName, release: "v2", path: "/items/one", item: { id: "one", value: "first" } });
    const restartedSecureUrl = `${restartedBase}/secure`;
    assert.equal((await fetch(restartedSecureUrl)).status, 403); assert.equal((await fetch(restartedSecureUrl, { headers: signedGetHeaders(restartedSecureUrl) })).status, 200);

    const destroyed = await runCdk(["--output", join(root, "destroy.out"), "destroy", "RestStack", "--force"], env);
    assert.equal(destroyed.code, 0, `${destroyed.stdout}\n${destroyed.stderr}`);
    assert.equal((await restartedCloudFormation.send(new ListStacksCommand({ StackStatusFilter: ["CREATE_COMPLETE", "UPDATE_COMPLETE", "DELETE_IN_PROGRESS"] }))).StackSummaries?.length, 0);
    await assert.rejects(restartedLambda.send(new GetFunctionCommand({ FunctionName: outputs.FunctionName })), error => (error as { name?: string }).name === "ResourceNotFoundException");
    await assert.rejects(restartedDynamoDb.send(new DescribeTableCommand({ TableName: outputs.TableName })), error => (error as { name?: string }).name === "ResourceNotFoundException");
    assert.equal((await restartedApiGateway.send(new GetRestApisCommand({}))).items?.some(candidate => candidate.id === outputs.ApiId), false);

    const retainedOutputsFile = join(root, "retained-outputs.json");
    const retainedDeploy = await runCdk(["--output", join(root, "retain-create.out"), "deploy", "RetainStack", "--require-approval", "never", "--outputs-file", retainedOutputsFile], env);
    assert.equal(retainedDeploy.code, 0, `${retainedDeploy.stdout}\n${retainedDeploy.stderr}`);
    const retainedAssembly = join(root, "retain-create.out");
    assert.deepEqual(await semanticCdkAssemblyDigests(retainedAssembly, ["RetainStack.template.json"], ["RetainStack.assets.json"]), {
      "RetainStack.template.json": "2fe54b5a304c154eb423be1e47d76ce8e698c0c702fe08315af9b462f33f38f6",
      "RetainStack.assets.json": "9c293686744170ced59b719f2db4126c1edf198f79f3b1efdd425a87915796b2",
    });
    const retainedTableName = (JSON.parse(await readFile(retainedOutputsFile, "utf8")).RetainStack as Record<string, string>).RetainedTableName;
    const retainedDestroy = await runCdk(["--output", join(root, "retain-destroy.out"), "destroy", "RetainStack", "--force"], env);
    assert.equal(retainedDestroy.code, 0, `${retainedDestroy.stdout}\n${retainedDestroy.stderr}`);
    assert.equal((await restartedDynamoDb.send(new DescribeTableCommand({ TableName: retainedTableName }))).Table?.TableName, retainedTableName, "DeletionPolicy Retain must preserve the authoritative table after cdk destroy");
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("standard CDK deploys and destroys the ordinary apigateway.RestApi construct", { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-plain-rest-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options); const lambda = new LambdaClient(options); const apiGateway = new APIGatewayClient(options);
    clients.push(cloudformation, lambda, apiGateway);
    const env = cdkEnvironment(endpoint, root, "v1");
    const outputsFile = join(root, "plain-outputs.json");
    const deployed = await runCdk(["--output", join(root, "plain-deploy.out"), "deploy", "PlainRestStack", "--require-approval", "never", "--outputs-file", outputsFile], env);
    assert.equal(deployed.code, 0, `${deployed.stdout}\n${deployed.stderr}`);
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "PlainRestStack" }))).Stacks?.[0]?.StackStatus, "CREATE_COMPLETE");

    const assembly = join(root, "plain-deploy.out");
    const templateBytes = await readFile(join(assembly, "PlainRestStack.template.json"));
    assert.deepEqual(await semanticCdkAssemblyDigests(assembly, ["PlainRestStack.template.json"], ["PlainRestStack.assets.json"]), {
      "PlainRestStack.template.json": "70c7ef760fb919d3688befd1f521692c513da1a88cc57face224bea0b94415e5",
      "PlainRestStack.assets.json": "6e4e421fc94e33831fe3c04e13e37907932a291b07cd58cf61d6aca351967026",
    });
    const template = JSON.parse(templateBytes.toString("utf8")) as { Resources: Record<string, { Type: string; DependsOn?: string[] }> };
    const typeCounts = Object.fromEntries(Object.entries(Object.values(template.Resources).reduce<Record<string, number>>((counts, resource) => ({ ...counts, [resource.Type]: (counts[resource.Type] ?? 0) + 1 }), {})).sort(([left], [right]) => left.localeCompare(right)));
    assert.deepEqual(typeCounts, {
      "AWS::ApiGateway::Account": 1,
      "AWS::ApiGateway::Deployment": 1,
      "AWS::ApiGateway::Method": 1,
      "AWS::ApiGateway::Resource": 1,
      "AWS::ApiGateway::RestApi": 1,
      "AWS::ApiGateway::Stage": 1,
      "AWS::CDK::Metadata": 1,
      "AWS::IAM::Role": 2,
      "AWS::Lambda::Function": 1,
      "AWS::Lambda::Permission": 2,
    });
    const deployment = Object.values(template.Resources).find(resource => resource.Type === "AWS::ApiGateway::Deployment");
    assert.deepEqual([...(deployment?.DependsOn ?? [])].sort(), ["ApiplainAFDDA460", "ApiplainGETF975BEAF"].sort());

    const outputs = JSON.parse(await readFile(outputsFile, "utf8")).PlainRestStack as Record<string, string>;
    assert.ok(outputs.ApiId); assert.equal(outputs.Stage, "prod");
    const resources = (await cloudformation.send(new ListStackResourcesCommand({ StackName: "PlainRestStack" }))).StackResourceSummaries ?? [];
    const functionName = resources.find(resource => resource.ResourceType === "AWS::Lambda::Function")?.PhysicalResourceId;
    assert.ok(functionName); assert.ok((await lambda.send(new GetFunctionCommand({ FunctionName: functionName }))).Configuration?.FunctionArn);
    assert.ok((await apiGateway.send(new GetRestApisCommand({}))).items?.some(api => api.id === outputs.ApiId));
    const response = await fetch(`http://127.0.0.1:${simulator.invokePort}/${outputs.ApiId}/${outputs.Stage}/plain`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { construct: "RestApi", path: "/plain" });

    const destroyed = await runCdk(["--output", join(root, "plain-destroy.out"), "destroy", "PlainRestStack", "--force"], env);
    assert.equal(destroyed.code, 0, `${destroyed.stdout}\n${destroyed.stderr}`);
    await assert.rejects(lambda.send(new GetFunctionCommand({ FunctionName: functionName! })), error => (error as { name?: string }).name === "ResourceNotFoundException");
    assert.equal((await apiGateway.send(new GetRestApisCommand({}))).items?.some(api => api.id === outputs.ApiId), false);
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
