import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DeleteRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  CreateActivityCommand, DeleteActivityCommand, DeleteStateMachineCommand,
  DescribeExecutionCommand, DescribeStateMachineCommand, GetActivityTaskCommand,
  GetExecutionHistoryCommand, ListTagsForResourceCommand, SendTaskHeartbeatCommand, SendTaskSuccessCommand,
  SFNClient, StartExecutionCommand,
} from "@aws-sdk/client-sfn";

const directory = import.meta.dirname;
const project = resolve(directory, "../..");
const runtime = join(directory, ".runtime");
const outputsFile = join(runtime, "outputs.json");
const endpoint = new URL(process.env.AWS_ENDPOINT_URL ?? "http://127.0.0.1:4566");
if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || !["http:", "https:"].includes(endpoint.protocol)) throw new Error("This learning fixture requires a loopback StackSim AWS_ENDPOINT_URL.");
const region = process.env.AWS_REGION ?? "eu-west-1";
const options = { endpoint: endpoint.href, region, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "admin", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "password" }, maxAttempts: 1 };
const sfn = new SFNClient(options); const cloudformation = new CloudFormationClient(options); const iam = new IAMClient(options); const dynamodb = new DynamoDBClient(options); const sqs = new SQSClient(options);
const [command = "execute", release = "v1"] = process.argv.slice(2);
const outputs = async () => JSON.parse(await readFile(outputsFile, "utf8")).StepFunctionsLifecycle;
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete environment[key];
Object.assign(environment, {
  AWS_ENDPOINT_URL: endpoint.href, AWS_ACCESS_KEY_ID: options.credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: options.credentials.secretAccessKey,
  AWS_REGION: region, AWS_DEFAULT_REGION: region, AWS_EC2_METADATA_DISABLED: "true", AWS_MAX_ATTEMPTS: "1",
  CDK_DEFAULT_REGION: region, CDK_DEFAULT_ACCOUNT: "000000000000", CDK_DISABLE_CLI_TELEMETRY: "true", CDK_DISABLE_VERSION_CHECK: "true",
  AWS_CONFIG_FILE: join(runtime, "no-aws-config"), AWS_SHARED_CREDENTIALS_FILE: join(runtime, "no-aws-credentials"),
  NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1", STACKSIM_NETWORK_ALLOW_PORT: endpoint.port || (endpoint.protocol === "https:" ? "443" : "80"),
  NODE_OPTIONS: `${environment.NODE_OPTIONS ?? ""} --require=${JSON.stringify(join(project, "test/fixtures/cdk/network-tripwire.cjs"))}`.trim(),
});
async function cdk(args, requestedRelease) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(project, "node_modules/cdk/bin/cdk"), "--output", join(runtime, "cdk.out"), ...args, "--no-notices", "--no-color"], {
      cwd: directory, env: { ...environment, CDK_SFN_TEST_RELEASE: requestedRelease }, shell: false, windowsHide: true, stdio: "inherit",
    });
    child.once("error", reject); child.once("close", code => resolvePromise(code));
  });
}
async function terminal(executionArn) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const execution = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    if (execution.status !== "RUNNING") { assert.equal(execution.status, "SUCCEEDED", `${execution.error}: ${execution.cause}`); return execution; }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error("Execution did not finish within 30 seconds");
}
async function start(stateMachineArn, input) {
  return (await sfn.send(new StartExecutionCommand({ stateMachineArn, input: JSON.stringify(input) }))).executionArn;
}

try {
  await mkdir(runtime, { recursive: true });
  if (command === "deploy" || command === "synth") {
    assert.ok(["v1", "v2"].includes(release), "release must be v1 or v2");
    const args = command === "synth" ? ["synth", "StepFunctionsLifecycle"] : ["deploy", "StepFunctionsLifecycle", "--require-approval", "never", "--outputs-file", outputsFile];
    assert.equal(await cdk(args, release), 0, `cdk ${command} failed`);
  } else if (command === "execute") {
    const out = await outputs(); const orderId = `order-${Date.now()}`;
    const common = await terminal(await start(out.CommonArn, { orderId }));
    const asset = await terminal(await start(out.AssetArn, {}));
    const reviewArn = await start(out.ReviewArn, { orderId });
    let task;
    for (let attempt = 0; attempt < 10 && !task?.taskToken; attempt++) task = await sfn.send(new GetActivityTaskCommand({ activityArn: out.ActivityArn, workerName: "learning-sdk-worker" }));
    assert.ok(task?.taskToken, "No Activity task was available");
    await sfn.send(new SendTaskHeartbeatCommand({ taskToken: task.taskToken }));
    await sfn.send(new SendTaskSuccessCommand({ taskToken: task.taskToken, output: JSON.stringify({ approved: true, orderId }) }));
    const review = await terminal(reviewArn);
    const item = await dynamodb.send(new GetItemCommand({ TableName: out.TableName, Key: { orderId: { S: orderId } } }));
    assert.ok(item.Item);
    console.log(JSON.stringify({ common: { executionArn: common.executionArn, output: JSON.parse(common.output) }, asset: JSON.parse(asset.output), review: JSON.parse(review.output), storedOrder: item.Item }, null, 2));
    for (const QueueUrl of [out.WorkQueueUrl, out.NotificationsUrl]) {
      const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }));
      console.log(JSON.stringify({ QueueUrl, messages: result.Messages?.map(message => message.Body) ?? [] }, null, 2));
    }
    console.log(`EventBridge delivery is visible in Lambda log group ${out.EventLogGroup}.`);
    console.log(`Execution history: ${JSON.stringify((await sfn.send(new GetExecutionHistoryCommand({ executionArn: common.executionArn, includeExecutionData: false }))).events?.map(event => ({ id: event.id, type: event.type })), null, 2)}`);
  } else if (command === "fail") {
    const independent = await sfn.send(new CreateActivityCommand({ name: "sfn04-independent-review", tags: [{ key: "example-owner", value: "step-functions-lifecycle" }] }));
    const tags = (await sfn.send(new ListTagsForResourceCommand({ resourceArn: independent.activityArn }))).tags;
    assert.ok(tags.some(tag => tag.key === "example-owner" && tag.value === "step-functions-lifecycle"), "The conflict Activity belongs to another caller; choose a clean local environment");
    assert.notEqual(await cdk(["deploy", "StepFunctionsLifecycle", "--require-approval", "never", "--outputs-file", join(runtime, "failed-outputs.json")], "broken"), 0, "Expected deployment to reject the independently owned Activity");
    const stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: "StepFunctionsLifecycle" }))).Stacks[0];
    assert.equal(stack.StackStatus, "UPDATE_ROLLBACK_COMPLETE");
    const out = await outputs();
    const restored = await terminal(await start(out.AssetArn, {}));
    console.log(`Rollback restored ${restored.output}; the independent Activity remains ${independent.activityArn}.`);
  } else if (command === "inspect") {
    const out = await outputs();
    for (const key of ["CommonArn", "AssetArn", "ReviewArn", "RetainedArn"]) {
      const machine = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: out[key] }));
      console.log(JSON.stringify({ name: machine.name, stateMachineArn: machine.stateMachineArn, roleArn: machine.roleArn, revisionId: machine.revisionId, definition: JSON.parse(machine.definition) }, null, 2));
    }
  } else if (command === "destroy") {
    assert.equal(await cdk(["destroy", "StepFunctionsLifecycle", "--force"], "v2"), 0, "cdk destroy failed");
    const out = await outputs();
    const retained = await terminal(await start(out.RetainedArn, {}));
    console.log(`Retained workflow still runs: ${retained.output}. Use cleanup to remove it and its retained role.`);
  } else if (command === "cleanup") {
    await assert.rejects(cloudformation.send(new DescribeStacksCommand({ StackName: "StepFunctionsLifecycle" })), error => error.name === "ValidationError", "Run destroy before cleanup");
    const out = await outputs();
    await sfn.send(new DeleteStateMachineCommand({ stateMachineArn: out.RetainedArn }));
    try { await iam.send(new DeleteRoleCommand({ RoleName: out.RetainedRoleName })); } catch (error) { if (error.name !== "NoSuchEntity") throw error; }
    const activityArn = `arn:aws:states:${region}:000000000000:activity:sfn04-independent-review`;
    try {
      const tags = (await sfn.send(new ListTagsForResourceCommand({ resourceArn: activityArn }))).tags;
      if (tags.some(tag => tag.key === "example-owner" && tag.value === "step-functions-lifecycle")) await sfn.send(new DeleteActivityCommand({ activityArn }));
    } catch (error) { if (!["ActivityDoesNotExist", "ResourceNotFound"].includes(error.name)) throw error; }
    console.log("Retained resources and independent Activity removed; deploy v1 can be repeated.");
  } else throw new Error("Use synth, deploy [v1|v2], execute, inspect, fail, destroy, or cleanup.");
} finally {
  for (const client of [sfn, cloudformation, iam, dynamodb, sqs]) client.destroy();
}
