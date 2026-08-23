import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APIGatewayClient, GetAccountCommand, GetStageCommand } from "@aws-sdk/client-api-gateway";
import { CloudFormationClient, DescribeStacksCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import { GetRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { BatchGetTracesCommand, XRayClient } from "@aws-sdk/client-xray";
import { StackSim } from "../src/server.js";
import { cdkCli, cdkCommandTimeoutMs } from "./support/project-cli.js";

const fixture = join(process.cwd(), "test", "fixtures", "cdk", "xray-rest");
const tripwire = join(process.cwd(), "test", "fixtures", "cdk", "network-tripwire.cjs");
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const traceHeader = (suffix: string) => `Root=1-66aa0000-${suffix.padStart(24, "0")};Parent=1111111111111111;Sampled=1`;

function environment(endpoint: string, root: string, tracing: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete env[key];
  return { ...env, AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey, AWS_REGION: region, AWS_DEFAULT_REGION: region, AWS_ENDPOINT_URL: endpoint, AWS_EC2_METADATA_DISABLED: "true", AWS_MAX_ATTEMPTS: "1", AWS_CONFIG_FILE: join(root, "no-config"), AWS_SHARED_CREDENTIALS_FILE: join(root, "no-credentials"), CDK_DEFAULT_ACCOUNT: "000000000000", CDK_DEFAULT_REGION: region, CDK_DISABLE_CLI_TELEMETRY: "true", CDK_DISABLE_VERSION_CHECK: "true", JSII_AGENT: "stacksim-tests/1", NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1", STACKSIM_NETWORK_ALLOW_PORT: new URL(endpoint).port, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(), XRY_TRACING: tracing ? "true" : "false" };
}

async function cdk(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cdkCli, ...args, "--no-notices", "--no-color"], { cwd: fixture, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; child.stdout.on("data", value => chunks.push(Buffer.from(value))); child.stderr.on("data", value => chunks.push(Buffer.from(value)));
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, cdkCommandTimeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); }); child.once("close", code => { clearTimeout(timer); resolve({ code, output: Buffer.concat(chunks).toString("utf8") }); });
  });
}

async function waitForStack(cloudformation: CloudFormationClient, stackName: string, expected: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = (await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus;
    if (status === expected) return;
    if (status?.endsWith("FAILED") || (status?.endsWith("COMPLETE") && status !== expected)) throw new Error(`Stack reached ${status} while waiting for ${expected}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

test("XRY-01 ordinary CDK RestApi tracing deploys, updates, restarts, destroys, and reuses its account-global role", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-xray-")); const dataDir = join(root, "data"); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "enforce", cdkBootstrap: true }); let clients: Array<{ destroy(): void }> = [];
  const connect = () => { const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region, credentials, maxAttempts: 1 }; const cloudformation = new CloudFormationClient(options); const apigateway = new APIGatewayClient(options); const iam = new IAMClient(options); const xray = new XRayClient(options); clients.push(cloudformation, apigateway, iam, xray); return { endpoint, cloudformation, apigateway, iam, xray }; };
  try {
    await simulator.start(); let { endpoint, cloudformation, apigateway, iam, xray } = connect(); let env = environment(endpoint, root, true); const assembly = join(root, "synth.out");
    const synthesized = await cdk(["--output", assembly, "synth", "XRayRestStack"], env); assert.equal(synthesized.code, 0, synthesized.output);
    const template = JSON.parse(await readFile(join(assembly, "XRayRestStack.template.json"), "utf8")); const resources = Object.values(template.Resources) as any[]; const stage = resources.find(resource => resource.Type === "AWS::ApiGateway::Stage"); const deployment = resources.find(resource => resource.Type === "AWS::ApiGateway::Deployment");
    assert.equal(stage?.Properties?.TracingEnabled, true); assert.equal(deployment?.Properties?.StageDescription, undefined, "the fixture uses the standalone stage bridge"); assert.equal(resources.filter(resource => resource.Type === "AWS::ApiGateway::Account").length, 1, "the ordinary RestApi keeps CDK's default regional CloudWatch account resource"); assert.equal(resources.some(resource => resource.Type.startsWith("AWS::XRay::")), false, "the consuming stack declares no X-Ray resource"); assert.equal(resources.some(resource => resource.Type === "AWS::IAM::Role" && resource.Properties?.RoleName === "AWSServiceRoleForAPIGateway"), false, "the consuming stack does not declare the API Gateway service-linked role");
    const deploy = await cdk(["--output", join(root, "deploy.out"), "deploy", "XRayRestStack", "--require-approval", "never", "--outputs-file", join(root, "outputs.json")], env); assert.equal(deploy.code, 0, deploy.output);
    const stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: "XRayRestStack" }))).Stacks?.[0]; assert.equal(stack?.StackStatus, "CREATE_COMPLETE"); const outputs = Object.fromEntries((stack?.Outputs ?? []).map(value => [value.OutputKey!, value.OutputValue!])); assert.equal((await apigateway.send(new GetStageCommand({ restApiId: outputs.ApiId, stageName: outputs.Stage }))).tracingEnabled, true); const firstCloudWatchRoleArn = (await apigateway.send(new GetAccountCommand({}))).cloudwatchRoleArn; assert.match(firstCloudWatchRoleArn ?? "", /^arn:aws:iam::000000000000:role\//); await iam.send(new GetRoleCommand({ RoleName: "AWSServiceRoleForAPIGateway" }));
    const invoke = `http://127.0.0.1:${simulator.invokePort}/${outputs.ApiId}/${outputs.Stage}/health`; const successId = "000000000000000000000071"; const failureId = "000000000000000000000072";
    assert.equal((await fetch(invoke, { headers: { "x-amzn-trace-id": traceHeader(successId) } })).status, 200); assert.equal((await fetch(`${invoke}?fail=true`, { headers: { "x-amzn-trace-id": traceHeader(failureId) } })).status, 504);
    const endToEndTraces = await xray.send(new BatchGetTracesCommand({ TraceIds: [`1-66aa0000-${successId}`, `1-66aa0000-${failureId}`] })); assert.equal(endToEndTraces.Traces?.length, 2); const endToEndDocuments = endToEndTraces.Traces!.map(trace => JSON.parse(trace.Segments![0].Document!)); assert.equal(endToEndDocuments[0].subsegments?.length, 1); assert.equal(endToEndDocuments[1].fault, true);
    const noOp = await cdk(["--output", join(root, "noop.out"), "deploy", "XRayRestStack", "--require-approval", "never"], env); assert.equal(noOp.code, 0, noOp.output);
    env = environment(endpoint, root, false); const disabled = await cdk(["--output", join(root, "disabled.out"), "deploy", "XRayRestStack", "--require-approval", "never"], env); assert.equal(disabled.code, 0, disabled.output); assert.equal((await apigateway.send(new GetStageCommand({ restApiId: outputs.ApiId, stageName: outputs.Stage }))).tracingEnabled, false);
    env = environment(endpoint, root, true); const enabled = await cdk(["--output", join(root, "enabled.out"), "deploy", "XRayRestStack", "--require-approval", "never"], env); assert.equal(enabled.code, 0, enabled.output); assert.equal((await apigateway.send(new GetStageCommand({ restApiId: outputs.ApiId, stageName: outputs.Stage }))).tracingEnabled, true);
    const rollbackTemplate = structuredClone(template); const stageEntry = Object.entries(rollbackTemplate.Resources).find(([, resource]: any) => resource.Type === "AWS::ApiGateway::Stage")!; (stageEntry[1] as any).Properties.TracingEnabled = false; rollbackTemplate.Outputs.RollbackFailure = { Value: ["not", "a scalar"] };
    await cloudformation.send(new UpdateStackCommand({ StackName: "XRayRestStack", TemplateBody: JSON.stringify(rollbackTemplate) })); await waitForStack(cloudformation, "XRayRestStack", "UPDATE_ROLLBACK_COMPLETE"); assert.equal((await apigateway.send(new GetStageCommand({ restApiId: outputs.ApiId, stageName: outputs.Stage }))).tracingEnabled, true, "rollback restores the prior traced stage configuration");
    clients.forEach(client => client.destroy()); clients = []; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "enforce", cdkBootstrap: true }); await simulator.start(); ({ endpoint, cloudformation, apigateway, iam, xray } = connect()); assert.equal((await apigateway.send(new GetStageCommand({ restApiId: outputs.ApiId, stageName: outputs.Stage }))).tracingEnabled, true);
    env = environment(endpoint, root, true); const destroyed = await cdk(["--output", join(root, "destroy.out"), "destroy", "XRayRestStack", "--force"], env); assert.equal(destroyed.code, 0, destroyed.output); assert.equal((await apigateway.send(new GetAccountCommand({}))).cloudwatchRoleArn, firstCloudWatchRoleArn, "Account deletion retains the regional setting"); await iam.send(new GetRoleCommand({ RoleName: "AWSServiceRoleForAPIGateway" }));
    const redeployed = await cdk(["--output", join(root, "redeploy.out"), "deploy", "XRayRestStack", "--require-approval", "never"], env); assert.equal(redeployed.code, 0, redeployed.output); const reboundCloudWatchRoleArn = (await apigateway.send(new GetAccountCommand({}))).cloudwatchRoleArn; assert.match(reboundCloudWatchRoleArn ?? "", /^arn:aws:iam::000000000000:role\//); assert.notEqual(reboundCloudWatchRoleArn, firstCloudWatchRoleArn, "the recreated stack must replace the retained singleton with its newly generated role"); assert.equal(Object.keys(simulator.store.ensureAccount().iam.roles).filter(name => name === "AWSServiceRoleForAPIGateway").length, 1);
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
