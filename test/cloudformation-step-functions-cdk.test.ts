import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, DescribeStackEventsCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { DeleteRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  CreateActivityCommand,
  DeleteActivityCommand,
  DeleteStateMachineCommand,
  DescribeActivityCommand,
  DescribeExecutionCommand,
  DescribeStateMachineCommand,
  DescribeStateMachineForExecutionCommand,
  GetActivityTaskCommand,
  GetExecutionHistoryCommand,
  ListTagsForResourceCommand,
  SendTaskHeartbeatCommand,
  SendTaskSuccessCommand,
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

function environment(endpoint: string, root: string, release: "v1" | "v2" | "broken"): NodeJS.ProcessEnv {
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
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(tripwire)}`.trim(),
  };
}

async function runCdk(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 180_000, cwd = fixture): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cdkCli, ...args], {
      cwd,
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
  const simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: join(root, "data"), region, authMode: "enforce", cdkBootstrap: true });
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

test("unmodified pinned CDK deploys common integrations, S3 definitions and Activities through rollback, restart and retention", { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-sfn04-"));
  const fixtureRoot = join(sourceRoot, "test", "fixtures", "cdk", "step-functions-lifecycle");
  const config = { port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: join(root, "data"), region, authMode: "enforce" as const, cdkBootstrap: true };
  let simulator = new StackSim(config);
  let endpoint = "";
  let cloudformation!: CloudFormationClient; let sfn!: SFNClient; let dynamodb!: DynamoDBClient; let sqs!: SQSClient; let logs!: CloudWatchLogsClient; let iam!: IAMClient;
  const clients: Array<{ destroy(): void }> = [];
  const connect = () => {
    for (const client of clients.splice(0)) client.destroy();
    endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials, maxAttempts: 1 };
    cloudformation = new CloudFormationClient(options); sfn = new SFNClient(options); dynamodb = new DynamoDBClient(options); sqs = new SQSClient(options); logs = new CloudWatchLogsClient(options); iam = new IAMClient(options);
    clients.push(cloudformation, sfn, dynamodb, sqs, logs, iam);
  };
  const cdk = (args: readonly string[], release: "v1" | "v2" | "broken" = "v1") => runCdk(["--output", join(root, `assembly-${release}`), ...args, "--no-notices", "--no-color"], environment(endpoint, root, release), 180_000, fixtureRoot);
  const outputFile = join(root, "outputs.json");
  const deploy = (release: "v1" | "v2" | "broken") => cdk(["deploy", "StepFunctionsLifecycle", "--require-approval", "never", "--outputs-file", outputFile], release);
  const output = async (): Promise<Record<string, string>> => JSON.parse(await readFile(outputFile, "utf8")).StepFunctionsLifecycle;
  const execute = async (arn: string, name: string, input: unknown = {}) => {
    const started = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, name, input: JSON.stringify(input) }));
    const result = await completed(sfn, started.executionArn!);
    assert.equal(result.status, "SUCCEEDED", `${result.error}: ${result.cause}`);
    return result;
  };
  const messages = async (queueUrl: string): Promise<any[]> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10 }));
      if (response.Messages?.length) return response.Messages;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`No downstream messages arrived in ${queueUrl}`);
  };
  const removeRetained = async (outputs: Record<string, string>) => {
    await sfn.send(new DeleteStateMachineCommand({ stateMachineArn: outputs.RetainedArn }));
    await iam.send(new DeleteRoleCommand({ RoleName: outputs.RetainedRoleName }));
  };
  try {
    await simulator.start(); connect();
    succeeded(await cdk(["synth", "StepFunctionsLifecycle", "--quiet"]), "SFN-04 synth");
    const template = JSON.parse(await readFile(join(root, "assembly-v1", "StepFunctionsLifecycle.template.json"), "utf8"));
    const resources = Object.values<any>(template.Resources);
    assert.equal(resources.filter(resource => resource.Type === "AWS::StepFunctions::Activity").length, 1);
    assert.ok(resources.some(resource => resource.Type === "AWS::StepFunctions::StateMachine" && resource.Properties.DefinitionS3Location && resource.Properties.DefinitionSubstitutions));
    const policies = resources.filter(resource => resource.Type === "AWS::IAM::Policy").flatMap(resource => resource.Properties.PolicyDocument.Statement);
    for (const action of ["dynamodb:PutItem", "sqs:SendMessage", "sns:Publish", "events:PutEvents"]) {
      const policy = policies.find(statement => [statement.Action].flat().includes(action));
      assert.ok(policy, `CDK must generate ${action}`);
      assert.notEqual(policy.Resource, "*", `CDK ${action} permission must use its target resource`);
    }

    succeeded(await deploy("v1"), "SFN-04 deploy v1");
    const v1 = await output();
    const commonExecution = await execute(v1.CommonArn, "common-v1", { orderId: "sfn04-order-v1" });
    assert.deepEqual(JSON.parse(commonExecution.output!), { orderId: "sfn04-order-v1" });
    const item = await dynamodb.send(new GetItemCommand({ TableName: v1.TableName, Key: { orderId: { S: "sfn04-order-v1" } }, ConsistentRead: true }));
    assert.equal(item.Item?.release.S, "v1");
    assert.deepEqual(JSON.parse((await messages(v1.WorkQueueUrl))[0].Body), { orderId: "sfn04-order-v1" });
    assert.deepEqual(JSON.parse((await messages(v1.NotificationsUrl))[0].Body), { orderId: "sfn04-order-v1" });
    let logged = false;
    for (let attempt = 0; attempt < 100 && !logged; attempt++) {
      const events = await logs.send(new FilterLogEventsCommand({ logGroupName: v1.EventLogGroup }));
      logged = events.events?.some(event => event.message?.includes("SFN04_EVENT") && event.message.includes("sfn04-order-v1")) ?? false;
      if (!logged) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(logged, "EventBridge must actually deliver the workflow event to the CDK Lambda target");
    const assetExecutionV1 = await execute(v1.AssetArn, "asset-v1");
    assert.deepEqual(JSON.parse(assetExecutionV1.output!), { release: "v1", greeting: "Helloworkflow" });
    const tagsV1 = (await sfn.send(new ListTagsForResourceCommand({ resourceArn: v1.ActivityArn }))).tags!;
    assert.ok(tagsV1.some(tag => tag.key === "aws:cloudformation:stack-name" && tag.value === "StepFunctionsLifecycle"));

    const review = await sfn.send(new StartExecutionCommand({ stateMachineArn: v1.ReviewArn, name: "review-restart", input: JSON.stringify({ orderId: "review-1" }) }));
    const task = await sfn.send(new GetActivityTaskCommand({ activityArn: v1.ActivityArn, workerName: "ordinary-sdk-worker" }));
    assert.deepEqual(JSON.parse(task.input!), { orderId: "review-1" });
    assert.ok(task.taskToken);
    await sfn.send(new SendTaskHeartbeatCommand({ taskToken: task.taskToken }));
    await simulator.stop();
    simulator = new StackSim(config); await simulator.start(); connect();
    await sfn.send(new SendTaskSuccessCommand({ taskToken: task.taskToken, output: JSON.stringify({ approved: true }) }));
    assert.deepEqual(JSON.parse((await completed(sfn, review.executionArn!)).output!), { approved: true });

    succeeded(await deploy("v2"), "SFN-04 deploy v2");
    const v2 = await output();
    assert.equal(v2.AssetArn, v1.AssetArn); assert.equal(v2.ActivityArn, v1.ActivityArn);
    assert.deepEqual(JSON.parse((await execute(v2.AssetArn, "asset-v2")).output!), { release: "v2", greeting: "Helloworkflow" });
    assert.equal(JSON.parse((await sfn.send(new DescribeStateMachineForExecutionCommand({ executionArn: assetExecutionV1.executionArn }))).definition!).States.Release.Result.release, "v1");
    await execute(v2.CommonArn, "common-v2", { orderId: "sfn04-order-v2" });
    assert.equal((await dynamodb.send(new GetItemCommand({ TableName: v2.TableName, Key: { orderId: { S: "sfn04-order-v2" } } }))).Item?.release.S, "v2");
    assert.ok((await sfn.send(new ListTagsForResourceCommand({ resourceArn: v2.ActivityArn }))).tags!.some(tag => tag.key === "release" && tag.value === "v2"));
    const unchanged = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: v2.AssetArn }));
    succeeded(await deploy("v2"), "SFN-04 no-op");
    assert.equal((await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: v2.AssetArn }))).revisionId, unchanged.revisionId);

    const independent = await sfn.send(new CreateActivityCommand({ name: "sfn04-independent-review" }));
    const broken = await deploy("broken");
    assert.notEqual(broken.code, 0, "an independent same-name Activity must not be adopted");
    assert.doesNotMatch(`${broken.stdout}\n${broken.stderr}`, /STACKSIM_NETWORK_TRIPWIRE/);
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "StepFunctionsLifecycle" }))).Stacks?.[0]?.StackStatus, "UPDATE_ROLLBACK_COMPLETE", `${broken.stdout}\n${broken.stderr}`);
    assert.deepEqual(JSON.parse((await execute(v2.AssetArn, "asset-rolled-back")).output!), { release: "v2", greeting: "Helloworkflow" });
    await sfn.send(new DescribeActivityCommand({ activityArn: independent.activityArn }));
    const events = (await cloudformation.send(new DescribeStackEventsCommand({ StackName: "StepFunctionsLifecycle" }))).StackEvents!;
    assert.ok(events.some(event => event.LogicalResourceId?.startsWith("AssetWorkflow") && event.ResourceStatus === "UPDATE_ROLLBACK_COMPLETE"));

    const deletingReview = await sfn.send(new StartExecutionCommand({ stateMachineArn: v2.ReviewArn, name: "review-during-destroy", input: "{}" }));
    const deletingTask = await sfn.send(new GetActivityTaskCommand({ activityArn: v2.ActivityArn, workerName: "worker-during-destroy" }));
    assert.ok(deletingTask.taskToken);
    succeeded(await cdk(["destroy", "StepFunctionsLifecycle", "--force"], "v2"), "SFN-04 destroy");
    await assert.rejects(sfn.send(new DescribeStateMachineCommand({ stateMachineArn: v2.CommonArn })), (error: any) => error.name === "StateMachineDoesNotExist");
    await assert.rejects(sfn.send(new DescribeActivityCommand({ activityArn: v2.ActivityArn })), (error: any) => error.name === "ActivityDoesNotExist");
    await sfn.send(new SendTaskSuccessCommand({ taskToken: deletingTask.taskToken, output: JSON.stringify({ completedAfterDeletion: true }) }));
    assert.deepEqual(JSON.parse((await completed(sfn, deletingReview.executionArn!)).output!), { completedAfterDeletion: true });
    assert.equal((await sfn.send(new DescribeExecutionCommand({ executionArn: commonExecution.executionArn }))).status, "SUCCEEDED");
    assert.deepEqual(JSON.parse((await execute(v2.RetainedArn, "after-stack-deletion")).output!), { retained: true });
    await removeRetained(v2);
    await sfn.send(new DeleteActivityCommand({ activityArn: independent.activityArn }));
    succeeded(await deploy("v1"), "SFN-04 repeat deployment");
    const repeated = await output();
    assert.deepEqual(JSON.parse((await execute(repeated.AssetArn, "repeat-v1")).output!), { release: "v1", greeting: "Helloworkflow" });
    succeeded(await cdk(["destroy", "StepFunctionsLifecycle", "--force"]), "SFN-04 repeat destroy");
    await removeRetained(repeated);
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
