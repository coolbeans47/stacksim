import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CloudFormationClient, DescribeStackResourceCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { StackSim } from "../src/server.js";

const execFileAsync = promisify(execFile);
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const quickstart = resolve("test", "fixtures", "sam", "quickstarts", "hello-world");
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
    const env = {
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
    delete (env as Record<string, string | undefined>).AWS_PROFILE;
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
