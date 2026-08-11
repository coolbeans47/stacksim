import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { StackSim } from "../src/server.js";
import { cdkCli } from "./support/project-cli.js";

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "nested-stack");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");

async function runCdk(args: readonly string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cdkCli, ...args, "--no-notices", "--no-color"], {
      cwd: fixture,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill(), 180_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

test("unmodified pinned CDK deploys and destroys a two-level NestedStack hierarchy", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-nested-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region: "eu-west-1", authMode: "off", cdkBootstrap: true });
  let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const inherited = { ...process.env };
    for (const key of Object.keys(inherited)) {
      if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete inherited[key];
    }
    const env: NodeJS.ProcessEnv = {
      ...inherited,
      AWS_ACCESS_KEY_ID: "admin",
      AWS_SECRET_ACCESS_KEY: "password",
      AWS_REGION: "eu-west-1",
      AWS_DEFAULT_REGION: "eu-west-1",
      AWS_ENDPOINT_URL: endpoint,
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_MAX_ATTEMPTS: "1",
      CDK_DEFAULT_ACCOUNT: "000000000000",
      CDK_DEFAULT_REGION: "eu-west-1",
      CDK_DISABLE_CLI_TELEMETRY: "true",
      CDK_DISABLE_VERSION_CHECK: "true",
      JSII_AGENT: "stacksim-tests/1",
      STACKSIM_NETWORK_ALLOW_PORT: new URL(endpoint).port,
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
      NODE_OPTIONS: `${inherited.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
    };
    cloudformation = new CloudFormationClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });

    const deployed = await runCdk(["--output", join(root, "deploy.out"), "deploy", "NestedRoot", "--require-approval", "never"], env);
    assert.equal(deployed.code, 0, `cdk deploy failed\n${deployed.stdout}\n${deployed.stderr}`);
    const stacks = (await cloudformation.send(new DescribeStacksCommand({}))).Stacks ?? [];
    assert.equal(stacks.length, 3);
    const rootStack = stacks.find(stack => !stack.ParentId);
    const childStack = stacks.find(stack => stack.ParentId === rootStack?.StackId);
    const leafStack = stacks.find(stack => stack.ParentId === childStack?.StackId);
    assert.ok(rootStack && childStack && leafStack, "CDK deployment should create a root, child, and leaf catalog hierarchy");
    assert.equal(childStack.RootId, rootStack.StackId);
    assert.equal(leafStack.RootId, rootStack.StackId);
    assert.equal(rootStack.Outputs?.find(output => output.OutputKey === "Ready")?.OutputValue, "ready");

    const destroyed = await runCdk(["--output", join(root, "destroy.out"), "destroy", "NestedRoot", "--force"], env);
    assert.equal(destroyed.code, 0, `cdk destroy failed\n${destroyed.stdout}\n${destroyed.stderr}`);
    assert.equal((await cloudformation.send(new DescribeStacksCommand({}))).Stacks?.length ?? 0, 0);
  } finally {
    cloudformation?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
