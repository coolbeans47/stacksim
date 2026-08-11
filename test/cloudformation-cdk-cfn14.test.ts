import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { StackSim } from "../src/server.js";
import { cdkCli } from "./support/project-cli.js";

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "cfn14-stack");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

interface CommandResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function environment(endpoint: string, root: string, release: "v1" | "v2"): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete inherited[key];
  }
  return {
    ...inherited,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_ENDPOINT_URL: endpoint,
    STACKSIM_NETWORK_ALLOW_PORT: new URL(endpoint).port,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_CONFIG_FILE: join(root, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(root, "no-aws-credentials"),
    CDK_DEFAULT_ACCOUNT: "000000000000",
    CDK_DEFAULT_REGION: region,
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    CDK_CFN14_TEST_RELEASE: release,
    JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION: "1",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${inherited.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

async function runNpx(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 180_000): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    assert.equal(args[0], "cdk");
    const child = spawn(process.execPath, [cdkCli, ...args.slice(1)], { cwd: fixture, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
  });
}

function succeeded(result: CommandResult, label: string): void {
  assert.equal(result.code, 0, `${label} failed (signal=${result.signal ?? "none"})\n${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /STACKSIM_NETWORK_TRIPWIRE|STACKSIM_CLOUDFORMATION_NETWORK_BLOCKED/, `${label} attempted an unapproved network connection`);
}

function outputs(stack: any): Record<string, string> {
  return Object.fromEntries((stack.Outputs ?? []).map((output: any) => [output.OutputKey, output.OutputValue]));
}

test("CFN-14 deploys the pinned synchronous Provider and Lambda getFunction AwsCustomResource without modifying generated assets", { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-cfn14-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: join(root, "data"), region, authMode: "enforce", cdkBootstrap: true });
  let cloudformation: CloudFormationClient | undefined;
  let logs: CloudWatchLogsClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    logs = new CloudWatchLogsClient({ endpoint, region, credentials, maxAttempts: 1 });

    const createOutput = join(root, "create.out");
    const created = await runNpx(["cdk", "--output", createOutput, "deploy", "Cfn14Stack", "--require-approval", "never", "--no-notices", "--no-color"], environment(endpoint, root, "v1"));
    succeeded(created, "cdk deploy Cfn14Stack v1");

    const template = JSON.parse(await readFile(join(createOutput, "Cfn14Stack.template.json"), "utf8"));
    const resources = Object.values(template.Resources) as any[];
    const generatedFunctions = resources.filter(resource => resource.Type === "AWS::Lambda::Function" && resource.Properties?.Runtime === "nodejs24.x");
    assert.equal(generatedFunctions.length, 2);
    assert.deepEqual(generatedFunctions.map(resource => resource.Properties.Handler).sort(), ["framework.onEvent", "index.handler"]);
    const generatedAws = resources.find(resource => resource.Type === "Custom::AWS");
    assert.equal(generatedAws.Properties.InstallLatestAwsSdk, false);
    assert.ok(JSON.stringify(generatedAws.Properties.Create).includes('\\"service\\":\\"Lambda\\",\\"action\\":\\"getFunction\\"'));
    const generatedPolicy = resources.find(resource => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.PolicyDocument).includes("lambda:GetFunction") && JSON.stringify(resource.Properties.PolicyDocument).includes("TargetVersion"));
    assert.deepEqual(generatedPolicy.Properties.PolicyDocument.Statement.map((statement: any) => statement.Action), ["lambda:GetFunction"]);

    let stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: "Cfn14Stack" }))).Stacks?.[0];
    assert.equal(stack?.StackStatus, "CREATE_COMPLETE");
    const stackId = stack!.StackId!;
    let values = outputs(stack);
    assert.equal(values.SyncPhysicalId, "cfn14-sync-provider");
    assert.equal(values.SyncMessage, "Create:v1");
    assert.equal(values.SyncEndpoint, endpoint);
    assert.equal(values.SyncLambdaEndpoint, endpoint);
    assert.equal(values.SyncCredentials, "true");
    assert.match(values.AwsFunctionArn, new RegExp(`^arn:aws:lambda:${region}:000000000000:function:.+:1$`));
    const customResources = (await cloudformation.send(new DescribeStackResourcesCommand({ StackName: "Cfn14Stack" }))).StackResources ?? [];
    assert.equal(customResources.find(resource => resource.ResourceType === "Custom::AWS")?.PhysicalResourceId, "cfn14-aws-custom-resource");
    const onEventName = customResources.find(resource => resource.ResourceType === "AWS::Lambda::Function" && resource.LogicalResourceId?.startsWith("OnEvent"))?.PhysicalResourceId;
    assert.ok(onEventName, "the pinned Provider onEvent function must be present");
    const onEventMessages = (await logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${onEventName}` }))).events?.map(event => event.message ?? "").join("\n") ?? "";
    assert.match(onEventMessages, /CFN14_NESTED_CALLBACK_REDACTION \[REDACTED\] \[REDACTED\]/, "nested Provider handlers must redact the inherited callback URL and token");
    assert.doesNotMatch(onEventMessages, /_stacksim\/cloudformation\/custom-resource-response\//, "nested Provider logs must not persist a live callback URL");

    const updateOutput = join(root, "update.out");
    const updated = await runNpx(["cdk", "--output", updateOutput, "deploy", "Cfn14Stack", "--require-approval", "never", "--no-notices", "--no-color"], environment(endpoint, root, "v2"));
    succeeded(updated, "cdk deploy Cfn14Stack v2");
    stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: stackId }))).Stacks?.[0];
    assert.equal(stack?.StackStatus, "UPDATE_COMPLETE");
    values = outputs(stack);
    assert.equal(values.SyncMessage, "Update:v2");
    assert.equal(values.TargetVersionNumber, "2");
    assert.match(values.AwsFunctionArn, /:2$/);

    const destroyed = await runNpx(["cdk", "destroy", "Cfn14Stack", "--force", "--no-notices", "--no-color"], environment(endpoint, root, "v2"));
    succeeded(destroyed, "cdk destroy Cfn14Stack");
    stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: stackId }))).Stacks?.[0];
    assert.equal(stack?.StackStatus, "DELETE_COMPLETE");
  } finally {
    logs?.destroy();
    cloudformation?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
