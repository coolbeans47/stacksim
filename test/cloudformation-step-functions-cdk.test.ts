import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  DescribeExecutionCommand,
  DescribeStateMachineCommand,
  GetExecutionHistoryCommand,
  SFNClient,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";
import { StackSim } from "../src/server.js";
import { cdkCli } from "./support/project-cli.js";

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "step-functions-stack");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

interface CommandResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function environment(endpoint: string, root: string, release: "v1" | "v2"): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete env[key];
  }
  return {
    ...env,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_ENDPOINT_URL: endpoint,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_CONFIG_FILE: join(root, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(root, "no-aws-credentials"),
    STACKSIM_NETWORK_ALLOW_PORT: new URL(endpoint).port,
    CDK_DEFAULT_ACCOUNT: "000000000000",
    CDK_DEFAULT_REGION: region,
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    CDK_SFN_TEST_RELEASE: release,
    JSII_AGENT: "stacksim-tests/1",
    JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION: "1",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

async function runCdk(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 180_000): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cdkCli, ...args], {
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
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

function succeeded(result: CommandResult, label: string): void {
  assert.equal(result.code, 0, `${label} failed (signal=${result.signal ?? "none"})\n${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /STACKSIM_NETWORK_TRIPWIRE/, `${label} attempted an outbound network connection`);
}

async function completed(sfn: SFNClient, executionArn: string): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const execution = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    if (execution.status !== "RUNNING") return execution;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Execution ${executionArn} did not complete`);
}

test("unmodified pinned CDK deploys, updates, executes, and destroys a Standard Lambda workflow", { timeout: 420_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-sfn-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options); const sfn = new SFNClient(options); clients.push(cloudformation, sfn);

    const synthDirectory = join(root, "synth.out");
    const synth = await runCdk(["--output", synthDirectory, "synth", "StepFunctionsStack", "--no-notices", "--no-color"], environment(endpoint, root, "v1"));
    succeeded(synth, "cdk synth");
    const template = JSON.parse(await readFile(join(synthDirectory, "StepFunctionsStack.template.json"), "utf8"));
    assert.equal(Object.values<any>(template.Resources).filter(resource => resource.Type === "AWS::StepFunctions::StateMachine").length, 1);
    assert.equal(Object.values<any>(template.Resources).filter(resource => resource.Type === "AWS::Lambda::Function").length, 1);

    const outputsV1 = join(root, "outputs-v1.json");
    const create = await runCdk(["deploy", "StepFunctionsStack", "--require-approval", "never", "--outputs-file", outputsV1, "--no-notices", "--no-color"], environment(endpoint, root, "v1"));
    succeeded(create, "cdk deploy v1");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "StepFunctionsStack" }))).Stacks?.[0]?.StackStatus, "CREATE_COMPLETE");
    const v1 = JSON.parse(await readFile(outputsV1, "utf8")).StepFunctionsStack as Record<string, string>;
    const machineV1 = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: v1.StateMachineArn }));
    assert.equal(machineV1.name, v1.StateMachineName);
    assert.equal(machineV1.type, "STANDARD");
    const startedV1 = await sfn.send(new StartExecutionCommand({ stateMachineArn: v1.StateMachineArn, name: "release-v1", input: JSON.stringify({ number: 7 }) }));
    const executionV1 = await completed(sfn, startedV1.executionArn!);
    assert.equal(executionV1.status, "SUCCEEDED");
    const v1Output = JSON.parse(executionV1.output!);
    assert.equal(v1Output.ExecutedVersion, "$LATEST");
    assert.equal(v1Output.SdkHttpMetadata.HttpStatusCode, 200);
    assert.equal(typeof v1Output.SdkResponseMetadata.RequestId, "string");
    assert.equal(v1Output.Payload.release, "v1");
    assert.deepEqual(v1Output.Payload.event, { number: 7, release: "v1" });

    const outputsV2 = join(root, "outputs-v2.json");
    const update = await runCdk(["deploy", "StepFunctionsStack", "--require-approval", "never", "--outputs-file", outputsV2, "--no-notices", "--no-color"], environment(endpoint, root, "v2"));
    succeeded(update, "cdk deploy v2");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "StepFunctionsStack" }))).Stacks?.[0]?.StackStatus, "UPDATE_COMPLETE");
    const v2 = JSON.parse(await readFile(outputsV2, "utf8")).StepFunctionsStack as Record<string, string>;
    assert.equal(v2.StateMachineArn, v1.StateMachineArn);
    const startedV2 = await sfn.send(new StartExecutionCommand({ stateMachineArn: v2.StateMachineArn, name: "release-v2", input: JSON.stringify({ number: 9 }) }));
    const executionV2 = await completed(sfn, startedV2.executionArn!);
    assert.equal(executionV2.status, "SUCCEEDED");
    assert.equal(JSON.parse(executionV2.output!).Payload.release, "v2");

    const destroy = await runCdk(["destroy", "StepFunctionsStack", "--force", "--no-notices", "--no-color"], environment(endpoint, root, "v2"));
    succeeded(destroy, "cdk destroy");
    await assert.rejects(() => sfn.send(new DescribeStateMachineCommand({ stateMachineArn: v1.StateMachineArn })), (error: any) => error?.name === "StateMachineDoesNotExist");
    assert.equal((await sfn.send(new DescribeExecutionCommand({ executionArn: startedV1.executionArn! }))).status, "SUCCEEDED");
    assert.ok((await sfn.send(new GetExecutionHistoryCommand({ executionArn: startedV1.executionArn! }))).events!.length > 0);
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
