import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CloudFormationClient, DescribeStackResourceCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateBucketCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { StackSim } from "../src/server.js";

const execFileAsync = promisify(execFile);
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const quickstarts = resolve("test", "fixtures", "sam", "quickstarts");
const quickstart = join(quickstarts, "hello-world");
const INSTALL = "Install AWS SAM CLI 1.91 or later (https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html; for example `winget install Amazon.SAM-CLI`, `brew install aws-sam-cli`, or `pip install aws-sam-cli`) to run this fixture";

/** The installed SAM CLI version, or undefined when `sam` is not on PATH. */
async function samVersion(): Promise<[number, number, number] | undefined> {
  try {
    const { stdout } = await execFileAsync("sam", ["--version"], { timeout: 60_000, windowsHide: true, shell: process.platform === "win32" });
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  } catch {
    return undefined;
  }
}

/** The environment that points the unmodified SAM CLI at a StackSim endpoint. */
function samEnvironment(root: string, endpoint: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_ENDPOINT_URL: endpoint,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_CONFIG_FILE: join(root, "missing-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(root, "missing-credentials"),
    AWS_EC2_METADATA_DISABLED: "true",
    SAM_CLI_TELEMETRY: "0",
  };
  delete env.AWS_PROFILE;
  return env;
}

function invoke(port: number, apiId: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, headers: { host: `${apiId}.execute-api.localhost:${port}` } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("the unmodified SAM CLI builds, deploys, redeploys, updates, and deletes sam init hello-world", async t => {
  const version = await samVersion();
  if (!version) { t.skip(`AWS SAM CLI is not installed or not on PATH. ${INSTALL}.`); return; }
  if (version[0] < 1 || (version[0] === 1 && version[1] < 91)) { t.skip(`AWS SAM CLI ${version.join(".")} is older than 1.91, whose bundled botocore first honors AWS_ENDPOINT_URL. ${INSTALL}.`); return; }

  const root = await mkdtemp(join(tmpdir(), "stacksim-sam-cli-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "off" });
  let cloudformation: CloudFormationClient | undefined;
  let s3: S3Client | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    s3 = new S3Client({ endpoint, region, credentials, forcePathStyle: true, maxAttempts: 1 });
    await s3.send(new CreateBucketCommand({ Bucket: "sam-cli-artifacts" }));
    const project = join(root, "sam-app");
    await cp(quickstart, project, { recursive: true });
    const env = samEnvironment(root, endpoint);
    const sam = (args: string[]) => execFileAsync("sam", args, { cwd: project, env, timeout: 300_000, windowsHide: true, shell: process.platform === "win32", maxBuffer: 16 * 1024 * 1024 });
    const deploy = () => sam(["deploy", "--stack-name", "hello", "--s3-bucket", "sam-cli-artifacts", "--capabilities", "CAPABILITY_IAM", "--region", region, "--no-confirm-changeset", "--no-fail-on-empty-changeset"]);

    await sam(["build"]);
    await deploy();
    const stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: "hello" }))).Stacks?.[0];
    assert.equal(stack?.StackStatus, "CREATE_COMPLETE");
    const apiId = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: "hello", LogicalResourceId: "ServerlessRestApi" }))).StackResourceDetail!.PhysicalResourceId!;
    assert.deepEqual(JSON.parse((await invoke(simulator.invokePort, apiId, "/Prod/hello/")).body), { message: "hello world" });

    const unchanged = await deploy();
    assert.match(`${unchanged.stdout}${unchanged.stderr}`, /No changes to deploy/);

    const app = join(project, "hello-world", "app.mjs");
    await writeFile(app, (await readFile(app, "utf8")).replace("hello world", "hello from the SAM CLI"));
    await sam(["build"]);
    await deploy();
    assert.deepEqual(JSON.parse((await invoke(simulator.invokePort, apiId, "/Prod/hello/")).body), { message: "hello from the SAM CLI" });

    await sam(["delete", "--stack-name", "hello", "--region", region, "--no-prompts"]);
    await assert.rejects(cloudformation.send(new DescribeStacksCommand({ StackName: "hello" })), /does not exist/);
  } finally {
    cloudformation?.destroy(); s3?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("the unmodified SAM CLI deploys hello-world with --resolve-s3 through the managed bucket over HTTPS, and sam delete keeps the managed stack", async t => {
  const version = await samVersion();
  if (!version) { t.skip(`AWS SAM CLI is not installed or not on PATH. ${INSTALL}.`); return; }
  if (version[0] < 1 || (version[0] === 1 && version[1] < 91)) { t.skip(`AWS SAM CLI ${version.join(".")} is older than 1.91, whose bundled botocore first honors AWS_ENDPOINT_URL. ${INSTALL}.`); return; }

  const root = await mkdtemp(join(tmpdir(), "stacksim-sam-cli-resolve-s3-"));
  // IAM enforcement stays on, so the managed bucket's TLS-only statement is evaluated.
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const caPath = join(root, "stacksim-ca.pem");
    await writeFile(caPath, await (await fetch(`${endpoint}/_stacksim/ca.pem`)).text());
    const cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    const s3Http = new S3Client({ endpoint, region, credentials, forcePathStyle: true, maxAttempts: 1 });
    clients.push(cloudformation, s3Http);
    const project = join(root, "sam-app");
    await cp(quickstart, project, { recursive: true });
    // S3 goes to the HTTPS endpoint (path style, because the endpoint is an IP), trusting the installation CA.
    const env = { ...samEnvironment(root, endpoint), AWS_ENDPOINT_URL_S3: `https://127.0.0.1:${simulator.s3TlsPort}`, AWS_CA_BUNDLE: caPath };
    const sam = (args: string[]) => execFileAsync("sam", args, { cwd: project, env, timeout: 300_000, windowsHide: true, shell: process.platform === "win32", maxBuffer: 16 * 1024 * 1024 });
    const deploy = () => sam(["deploy", "--stack-name", "hello", "--resolve-s3", "--capabilities", "CAPABILITY_IAM", "--region", region, "--no-confirm-changeset", "--no-fail-on-empty-changeset"]);

    await sam(["build"]);
    const first = await deploy();
    assert.match(`${first.stdout}${first.stderr}`, /Managed S3 bucket: aws-sam-cli-managed-default-samclisourcebucket-/);
    const managed = (await cloudformation.send(new DescribeStacksCommand({ StackName: "aws-sam-cli-managed-default" }))).Stacks![0];
    assert.equal(managed.StackStatus, "CREATE_COMPLETE");
    const bucket = managed.Outputs!.find(output => output.OutputKey === "SourceBucket")!.OutputValue!;
    const apiId = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: "hello", LogicalResourceId: "ServerlessRestApi" }))).StackResourceDetail!.PhysicalResourceId!;
    assert.deepEqual(JSON.parse((await invoke(simulator.invokePort, apiId, "/Prod/hello/")).body), { message: "hello world" });

    // The CLI's uploads reached the bucket over HTTPS; plain HTTP to it is denied.
    await assert.rejects(s3Http.send(new HeadObjectCommand({ Bucket: bucket, Key: "missing" })), (error: any) => error.$metadata?.httpStatusCode === 403);
    await assert.rejects(s3Http.send(new GetObjectCommand({ Bucket: bucket, Key: "missing" })), (error: any) => error.name === "AccessDeniedException" && /aws:SecureTransport/.test(error.message));

    const unchanged = await deploy();
    assert.match(`${unchanged.stdout}${unchanged.stderr}`, /No changes to deploy/);

    await sam(["delete", "--stack-name", "hello", "--region", region, "--no-prompts"]);
    await assert.rejects(cloudformation.send(new DescribeStacksCommand({ StackName: "hello" })), /does not exist/);
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "aws-sam-cli-managed-default" }))).Stacks![0].StackStatus, "CREATE_COMPLETE", "sam delete leaves the managed stack, as on AWS");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("the unmodified SAM CLI builds and deploys sam init sqs, and the queued message reaches the function's log", async t => {
  const version = await samVersion();
  if (!version) { t.skip(`AWS SAM CLI is not installed or not on PATH. ${INSTALL}.`); return; }
  if (version[0] < 1 || (version[0] === 1 && version[1] < 91)) { t.skip(`AWS SAM CLI ${version.join(".")} is older than 1.91, whose bundled botocore first honors AWS_ENDPOINT_URL. ${INSTALL}.`); return; }

  const root = await mkdtemp(join(tmpdir(), "stacksim-sam-cli-sqs-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    const s3 = new S3Client({ endpoint, region, credentials, forcePathStyle: true, maxAttempts: 1 });
    const sqs = new SQSClient({ endpoint, region, credentials, maxAttempts: 1 });
    const logs = new CloudWatchLogsClient({ endpoint, region, credentials, maxAttempts: 1 });
    clients.push(cloudformation, s3, sqs, logs);
    await s3.send(new CreateBucketCommand({ Bucket: "sam-cli-artifacts" }));
    const project = join(root, "sam-app");
    await cp(join(quickstarts, "sqs"), project, { recursive: true });
    const sam = (args: string[]) => execFileAsync("sam", args, { cwd: project, env: samEnvironment(root, endpoint), timeout: 300_000, windowsHide: true, shell: process.platform === "win32", maxBuffer: 16 * 1024 * 1024 });

    await sam(["build"]);
    await sam(["deploy", "--stack-name", "sqs-app", "--s3-bucket", "sam-cli-artifacts", "--capabilities", "CAPABILITY_IAM", "--region", region, "--no-confirm-changeset", "--no-fail-on-empty-changeset"]);
    const physical = async (logicalId: string) => (await cloudformation.send(new DescribeStackResourceCommand({ StackName: "sqs-app", LogicalResourceId: logicalId }))).StackResourceDetail!.PhysicalResourceId!;
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: await physical("SimpleQueue") }));
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: "hello through the SAM CLI" }));
    const functionName = await physical("SQSPayloadLogger");
    let logged = false;
    for (let attempt = 0; attempt < 200 && !logged; attempt++) {
      try { logged = Boolean((await logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${functionName}`, filterPattern: '"hello through the SAM CLI"' }))).events?.length); } catch { /* the log group appears with the first invocation */ }
      if (!logged) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
    assert.ok(logged, "the function logs the queued message");

    await sam(["delete", "--stack-name", "sqs-app", "--region", region, "--no-prompts"]);
    await assert.rejects(cloudformation.send(new DescribeStacksCommand({ StackName: "sqs-app" })), /does not exist/);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("the unmodified SAM CLI builds and deploys sam init step-func, and a started execution trades", async t => {
  const version = await samVersion();
  if (!version) { t.skip(`AWS SAM CLI is not installed or not on PATH. ${INSTALL}.`); return; }
  if (version[0] < 1 || (version[0] === 1 && version[1] < 91)) { t.skip(`AWS SAM CLI ${version.join(".")} is older than 1.91, whose bundled botocore first honors AWS_ENDPOINT_URL. ${INSTALL}.`); return; }

  const root = await mkdtemp(join(tmpdir(), "stacksim-sam-cli-step-func-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    const s3 = new S3Client({ endpoint, region, credentials, forcePathStyle: true, maxAttempts: 1 });
    const sfn = new SFNClient({ endpoint, region, credentials, maxAttempts: 1 });
    clients.push(cloudformation, s3, sfn);
    await s3.send(new CreateBucketCommand({ Bucket: "sam-cli-artifacts" }));
    const project = join(root, "sam-app");
    await cp(join(quickstarts, "step-func"), project, { recursive: true });
    const sam = (args: string[]) => execFileAsync("sam", args, { cwd: project, env: samEnvironment(root, endpoint), timeout: 300_000, windowsHide: true, shell: process.platform === "win32", maxBuffer: 16 * 1024 * 1024 });

    await sam(["build"]);
    await sam(["deploy", "--stack-name", "step-func-app", "--s3-bucket", "sam-cli-artifacts", "--capabilities", "CAPABILITY_IAM", "--region", region, "--no-confirm-changeset", "--no-fail-on-empty-changeset"]);
    const stateMachineArn = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: "step-func-app", LogicalResourceId: "StockTradingStateMachine" }))).StackResourceDetail!.PhysicalResourceId!;
    const { executionArn } = await sfn.send(new StartExecutionCommand({ stateMachineArn }));
    let status: string | undefined;
    for (let attempt = 0; attempt < 600 && (status === undefined || status === "RUNNING"); attempt++) {
      status = (await sfn.send(new DescribeExecutionCommand({ executionArn }))).status;
      if (status === "RUNNING") await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
    assert.equal(status, "SUCCEEDED");

    await sam(["delete", "--stack-name", "step-func-app", "--region", region, "--no-prompts"]);
    await assert.rejects(cloudformation.send(new DescribeStacksCommand({ StackName: "step-func-app" })), /does not exist/);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
