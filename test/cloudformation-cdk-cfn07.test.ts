import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APIGatewayClient,
  GetAccountCommand,
  GetApiKeyCommand,
  GetAuthorizersCommand,
  GetGatewayResponseCommand,
  GetModelsCommand,
  GetRequestValidatorsCommand,
  GetResourcesCommand,
  GetRestApiCommand,
  GetRestApisCommand,
  GetStageCommand,
  GetUsagePlanCommand,
  GetUsagePlanKeysCommand,
  TestInvokeMethodCommand,
} from "@aws-sdk/client-api-gateway";
import { CloudFormationClient, DescribeStacksCommand, ListStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { StackSim } from "../src/server.js";
import { semanticCdkAssemblyDigests } from "./support/artifact-snapshots.js";
import { cdkCli } from "./support/project-cli.js";

interface CdkResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface AwsCall { command: string; method: string; path: string; service: string; action: string }

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "cfn07-rest");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const region = "eu-west-1";

function signingService(authorization: string | undefined): string {
  return authorization?.match(/Credential=[^,\s]+\/\d{8}\/[^/]+\/([^/]+)\/aws4_request/)?.[1] ?? "unknown";
}

function awsAction(service: string, body: Buffer, target: string | undefined, method: string, path: string): string {
  if (target) return target.slice(target.lastIndexOf(".") + 1);
  if (service === "s3") return `${method}ObjectOrBucket`;
  try { return new URLSearchParams(body.toString("utf8")).get("Action") ?? "unknown"; }
  catch { return path; }
}

async function tracingProxy(upstreamPort: number, calls: AwsCall[], currentCommand: () => string) {
  const proxy = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const service = signingService(incoming.headers.authorization);
    calls.push({
      command: currentCommand(),
      method: incoming.method ?? "GET",
      path: incoming.url ?? "/",
      service,
      action: awsAction(service, body, incoming.headers["x-amz-target"]?.toString(), incoming.method ?? "GET", incoming.url ?? "/"),
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

function cdkEnvironment(endpoint: string | undefined, tempRoot: string, release: "v1" | "v2" | "broken"): NodeJS.ProcessEnv {
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
    ...(endpoint ? { AWS_ENDPOINT_URL: endpoint, STACKSIM_NETWORK_ALLOW_PORT: new URL(endpoint).port } : { STACKSIM_NETWORK_ALLOW_PORT: "" }),
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_CONFIG_FILE: join(tempRoot, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(tempRoot, "no-aws-credentials"),
    CDK_DEFAULT_ACCOUNT: "000000000000",
    CDK_DEFAULT_REGION: region,
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    JSII_AGENT: "stacksim-tests/1", // Keep CDK metadata hashes independent of the host Node.js version.
    CDK_CFN07_RELEASE: release,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

async function runCdk(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<CdkResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cdkCli, ...args, "--no-notices", "--no-color"], {
      cwd: fixture, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

async function openApiAssetBodies(s3: S3Client, bucket: string): Promise<string[]> {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  const bodies: string[] = [];
  for (const object of listed.Contents ?? []) {
    if (!object.Key) continue;
    const value = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
    const body = await value.Body?.transformToString();
    if (body?.includes("stacksim CFN-07 file asset")) bodies.push(body);
  }
  return bodies;
}

function typeCounts(template: { Resources: Record<string, { Type: string }> }): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const resource of Object.values(template.Resources)) counts[resource.Type] = (counts[resource.Type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

test("pinned standard CDK synthesizes the exact CFN-07 SpecRestApi resource set from a file asset", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-cfn07-synth-"));
  try {
    const output = join(root, "cdk.out");
    const result = await runCdk(["--output", output, "synth", "Cfn07Stack"], cdkEnvironment(undefined, root, "v1"));
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const template = JSON.parse(await readFile(join(output, "Cfn07Stack.template.json"), "utf8"));
    assert.deepEqual(typeCounts(template), {
      "AWS::ApiGateway::Account": 1,
      "AWS::ApiGateway::ApiKey": 1,
      "AWS::ApiGateway::Authorizer": 1,
      "AWS::ApiGateway::Deployment": 1,
      "AWS::ApiGateway::GatewayResponse": 1,
      "AWS::ApiGateway::Method": 1,
      "AWS::ApiGateway::Model": 1,
      "AWS::ApiGateway::RequestValidator": 1,
      "AWS::ApiGateway::Resource": 1,
      "AWS::ApiGateway::RestApi": 1,
      "AWS::ApiGateway::Stage": 1,
      "AWS::ApiGateway::UsagePlan": 1,
      "AWS::ApiGateway::UsagePlanKey": 1,
      "AWS::CDK::Metadata": 1,
      "AWS::IAM::Role": 2,
      "AWS::Lambda::Function": 1,
      "AWS::Lambda::Permission": 3,
    });
    const restApi = Object.values<any>(template.Resources).find(resource => resource.Type === "AWS::ApiGateway::RestApi");
    assert.ok(restApi?.Properties?.BodyS3Location, "ApiDefinition.fromAsset must synthesize BodyS3Location");
    assert.equal(restApi?.Properties?.Body, undefined, "the file asset must not be inlined into the template");
    const assembly = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    assert.ok(Object.values<any>(assembly.artifacts).some(artifact => String(artifact.type).includes("asset-manifest")), "the assembly must retain its standard CDK asset manifest");
    const resourceEntries = Object.entries<any>(template.Resources);
    const permissions = resourceEntries.filter(([, resource]) => resource.Type === "AWS::Lambda::Permission");
    const permissionSource = ([, resource]: [string, any]) => JSON.stringify(resource.Properties?.SourceArn ?? "");
    const invokePermissions = permissions.filter(entry => permissionSource(entry).includes("execute-api"));
    const testInvoke = invokePermissions.filter(entry => permissionSource(entry).includes("test-invoke-stage"));
    const authorizerInvoke = invokePermissions.filter(entry => permissionSource(entry).includes("authorizers"));
    const deployedInvoke = invokePermissions.filter(entry => !testInvoke.includes(entry) && !authorizerInvoke.includes(entry));
    assert.equal(testInvoke.length, 1, `expected one Lambda test-invoke permission: ${JSON.stringify(permissions)}`);
    assert.equal(authorizerInvoke.length, 1, `expected one Lambda authorizer permission: ${JSON.stringify(permissions)}`);
    assert.equal(deployedInvoke.length, 1, `expected one deployed Lambda invoke permission: ${JSON.stringify(permissions)}`);
    const [functionLogicalId] = resourceEntries.find(([, resource]) => resource.Type === "AWS::Lambda::Function")!;
    for (const [, permission] of permissions) {
      assert.equal(permission.Properties?.Action, "lambda:InvokeFunction");
      assert.equal(permission.Properties?.Principal, "apigateway.amazonaws.com");
      assert.ok(JSON.stringify(permission.Properties?.FunctionName).includes(functionLogicalId), "each permission must target the fixture Lambda through its synthesized dependency");
    }
    const [methodLogicalId, method] = resourceEntries.find(([, resource]) => resource.Type === "AWS::ApiGateway::Method")!;
    const [authorizerLogicalId, authorizer] = resourceEntries.find(([, resource]) => resource.Type === "AWS::ApiGateway::Authorizer")!;
    assert.ok(JSON.stringify(authorizer.Properties?.AuthorizerUri).includes(functionLogicalId), "the Authorizer must invoke the fixture Lambda");
    const [, deployment] = resourceEntries.find(([, resource]) => resource.Type === "AWS::ApiGateway::Deployment")!;
    const deploymentDependencies = new Set(Array.isArray(deployment.DependsOn) ? deployment.DependsOn : deployment.DependsOn ? [deployment.DependsOn] : []);
    assert.ok(deploymentDependencies.has(methodLogicalId), `the deployment must depend on the explicit SpecRestApi method: ${JSON.stringify(deployment.DependsOn)}`);
    assert.ok(method.Properties?.AuthorizerId?.Ref === authorizerLogicalId, "the Method must consume the synthesized authorizer Ref");
    const digests = await semanticCdkAssemblyDigests(output, ["Cfn07Stack.template.json"], ["Cfn07Stack.assets.json", "manifest.json"]);
    assert.deepEqual({
      template: digests["Cfn07Stack.template.json"],
      manifest: digests["manifest.json"],
      assets: digests["Cfn07Stack.assets.json"],
    }, {
      template: "2f9790d4e04af01eebbdd954122ea295474d067f3dddf4ce7cc83ade9db5dbeb",
      manifest: "e536011d6dce51e9406f274d22a9c1efeded6130b89b323cc16b0f9ce95c4171",
      assets: "19de40f8b135ba4ba0edfc67f3425be7a7b4a30861cfa8b1109272f0223a38d2",
    }, "the pinned CDK 2.1132.0/aws-cdk-lib 2.261.0 CFN-07 assembly drifted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pinned standard CDK publishes and manages the full CFN-07 REST set locally across update, rollback, restart, and destroy", { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-cfn07-"));
  const dataDir = join(root, "data");
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "enforce", cdkBootstrap: true });
  let proxy: Awaited<ReturnType<typeof tracingProxy>> | undefined;
  let command = "startup";
  const calls: AwsCall[] = [];
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    proxy = await tracingProxy(simulator.port, calls, () => command);
    let endpoint = proxy.endpoint;
    let options = { endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    let cloudformation = new CloudFormationClient(options); let gateway = new APIGatewayClient(options); let s3 = new S3Client({ ...options, forcePathStyle: true }); let iam = new IAMClient(options);
    clients.push(cloudformation, gateway, s3, iam);
    const outputsFile = join(root, "outputs.json");

    command = "deploy-v1";
    let env = cdkEnvironment(endpoint, root, "v1");
    const created = await runCdk(["--output", join(root, "create.out"), "deploy", "Cfn07Stack", "--require-approval", "never", "--outputs-file", outputsFile], env);
    assert.equal(created.code, 0, `${created.stdout}\n${created.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "Cfn07Stack" }))).Stacks?.[0]?.StackStatus, "CREATE_COMPLETE");
    assert.ok(calls.some(call => call.command === command && call.service === "s3" && call.method === "PUT"), "CDK must publish the OpenAPI asset through local S3");
    const outputs = JSON.parse(await readFile(outputsFile, "utf8")).Cfn07Stack as Record<string, string>;
    assert.ok(outputs.ApiId && outputs.ApiKeyId && outputs.UsagePlanId && outputs.RoleArn); assert.equal(outputs.StageName, "prod");
    const bootstrapBucket = simulator.store.regionState(region).cloudformation.bootstrap!.bucketName;
    const v1Assets = await openApiAssetBodies(s3, bootstrapBucket);
    assert.ok(v1Assets.some(body => JSON.parse(body).info.version === "1.0.0"), "the published bootstrap asset must contain the v1 OpenAPI document");

    const readRelease = async (release: "v1" | "v2") => {
      const expectedV2 = release === "v2";
      assert.equal((await gateway.send(new GetRestApiCommand({ restApiId: outputs.ApiId }))).name, "cfn07-asset-api");
      const resources = (await gateway.send(new GetResourcesCommand({ restApiId: outputs.ApiId, embed: ["methods.methodIntegration"] }))).items ?? [];
      assert.ok(resources.some(resource => resource.path === "/asset"));
      assert.equal(resources.some(resource => resource.path === "/asset-v2"), expectedV2);
      const lambdaRoute = resources.find(resource => resource.path === "/lambda");
      assert.ok(lambdaRoute?.id);
      const authorizer = (await gateway.send(new GetAuthorizersCommand({ restApiId: outputs.ApiId }))).items?.find(value => value.name === `cfn07-token-${release}`);
      assert.equal(authorizer?.authorizerResultTtlInSeconds, expectedV2 ? 0 : 60);
      const model = (await gateway.send(new GetModelsCommand({ restApiId: outputs.ApiId }))).items?.find(value => value.name === "Cfn07Payload");
      assert.equal(model?.description, `CFN-07 payload ${release}`);
      assert.equal(JSON.parse(model?.schema ?? "{}").properties.revision?.type, expectedV2 ? "integer" : undefined);
      const validator = (await gateway.send(new GetRequestValidatorsCommand({ restApiId: outputs.ApiId }))).items?.find(value => value.name === "cfn07-body-validator");
      assert.equal(validator?.validateRequestBody, true); assert.equal(validator?.validateRequestParameters, expectedV2);
      const response = await gateway.send(new GetGatewayResponseCommand({ restApiId: outputs.ApiId, responseType: "ACCESS_DENIED" }));
      assert.equal(response.statusCode, expectedV2 ? "401" : "403");
      assert.equal(response.responseTemplates?.["application/json"], JSON.stringify({ error: release }));
      const key = await gateway.send(new GetApiKeyCommand({ apiKey: outputs.ApiKeyId, includeValue: true }));
      assert.equal(key.description, `CFN-07 client ${release}`); assert.equal(key.enabled, true); assert.equal(key.tags?.release, release); assert.match(key.value ?? "", /^[A-Za-z0-9]{40}$/);
      const plan = await gateway.send(new GetUsagePlanCommand({ usagePlanId: outputs.UsagePlanId }));
      assert.equal(plan.description, `CFN-07 plan ${release}`); assert.equal(plan.quota?.limit, expectedV2 ? 40 : 20); assert.equal(plan.throttle?.burstLimit, expectedV2 ? 4 : 2); assert.equal(plan.tags?.release, release);
      assert.deepEqual(plan.apiStages?.map(value => `${value.apiId}/${value.stage}`), [`${outputs.ApiId}/prod`]);
      assert.deepEqual((await gateway.send(new GetUsagePlanKeysCommand({ usagePlanId: outputs.UsagePlanId }))).items?.map(value => value.id), [outputs.ApiKeyId]);
      assert.equal((await gateway.send(new GetAccountCommand({}))).cloudwatchRoleArn, outputs.RoleArn);
      assert.equal((await gateway.send(new GetStageCommand({ restApiId: outputs.ApiId, stageName: "prod" }))).stageName, "prod");
      const invocation = await fetch(`http://127.0.0.1:${simulator.invokePort}/${outputs.ApiId}/prod/asset`);
      assert.equal(invocation.status, 200); assert.deepEqual(await invocation.json(), { release });
      const lambdaInvocation = await fetch(`http://127.0.0.1:${simulator.invokePort}/${outputs.ApiId}/prod/lambda`, { method: "POST", headers: { authorization: "Bearer allow", "content-type": "application/json", "x-api-key": key.value! }, body: JSON.stringify({ message: "normal" }) });
      assert.equal(lambdaInvocation.status, 200); assert.deepEqual(await lambdaInvocation.json(), { release, path: "/lambda" });
      const tested = await gateway.send(new TestInvokeMethodCommand({ restApiId: outputs.ApiId, resourceId: lambdaRoute.id, httpMethod: "POST", headers: { authorization: "Bearer allow", "content-type": "application/json" }, body: JSON.stringify({ message: "test" }) }));
      assert.equal(tested.status, 200); assert.deepEqual(JSON.parse(tested.body ?? "{}"), { release, path: "/lambda" });
    };

    await readRelease("v1");

    command = "deploy-v2";
    env = cdkEnvironment(endpoint, root, "v2");
    const updated = await runCdk(["--output", join(root, "update.out"), "deploy", "Cfn07Stack", "--require-approval", "never"], env);
    assert.equal(updated.code, 0, `${updated.stdout}\n${updated.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "Cfn07Stack" }))).Stacks?.[0]?.StackStatus, "UPDATE_COMPLETE");
    assert.ok(calls.some(call => call.command === command && call.service === "s3" && call.method === "PUT"), "the v2 OpenAPI asset must be published locally");
    assert.ok((await openApiAssetBodies(s3, bootstrapBucket)).some(body => JSON.parse(body).info.version === "2.0.0"));
    await readRelease("v2");

    command = "deploy-broken";
    env = cdkEnvironment(endpoint, root, "broken");
    const broken = await runCdk(["--output", join(root, "broken.out"), "deploy", "Cfn07Stack", "--require-approval", "never"], env);
    assert.notEqual(broken.code, 0, "an invalid usage-plan stage must fail the update");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "Cfn07Stack" }))).Stacks?.[0]?.StackStatus, "UPDATE_ROLLBACK_COMPLETE", `${broken.stdout}\n${broken.stderr}`);
    await readRelease("v2");

    for (const client of clients.splice(0)) client.destroy();
    await proxy.close(); proxy = undefined;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "enforce", cdkBootstrap: true });
    await simulator.start();
    proxy = await tracingProxy(simulator.port, calls, () => command);
    endpoint = proxy.endpoint; options = { endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    cloudformation = new CloudFormationClient(options); gateway = new APIGatewayClient(options); s3 = new S3Client({ ...options, forcePathStyle: true }); iam = new IAMClient(options);
    clients.push(cloudformation, gateway, s3, iam);
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "Cfn07Stack" }))).Stacks?.[0]?.StackStatus, "UPDATE_ROLLBACK_COMPLETE");
    await readRelease("v2");

    command = "destroy";
    env = cdkEnvironment(endpoint, root, "v2");
    const destroyed = await runCdk(["--output", join(root, "destroy.out"), "destroy", "Cfn07Stack", "--force"], env);
    assert.equal(destroyed.code, 0, `${destroyed.stdout}\n${destroyed.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    assert.equal((await cloudformation.send(new ListStacksCommand({ StackStatusFilter: ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "DELETE_IN_PROGRESS", "DELETE_FAILED"] }))).StackSummaries?.length, 0);
    assert.equal((await gateway.send(new GetRestApisCommand({}))).items?.some(value => value.id === outputs.ApiId), false);
    await assert.rejects(gateway.send(new GetApiKeyCommand({ apiKey: outputs.ApiKeyId })), error => (error as { name?: string }).name === "NotFoundException");
    await assert.rejects(gateway.send(new GetUsagePlanCommand({ usagePlanId: outputs.UsagePlanId })), error => (error as { name?: string }).name === "NotFoundException");
    assert.equal((await gateway.send(new GetAccountCommand({}))).cloudwatchRoleArn, outputs.RoleArn, "AWS::ApiGateway::Account deletion is intentionally a no-op");
    await assert.rejects(iam.send(new GetRoleCommand({ RoleName: "cfn07-apigateway-account" })), error => ["NoSuchEntity", "NoSuchEntityException"].includes((error as { name?: string }).name ?? ""));
    assert.ok(simulator.store.regionState(region).s3Buckets[bootstrapBucket], "destroy must preserve the local CDK bootstrap bucket");
  } finally {
    for (const client of clients) client.destroy();
    await proxy?.close().catch(() => undefined);
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
