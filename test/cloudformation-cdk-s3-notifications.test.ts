import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { S3EventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStackEventsCommand, DescribeStacksCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { AddPermissionCommand, CreateFunctionCommand, GetFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateBucketCommand, GetBucketNotificationConfigurationCommand, PutBucketNotificationConfigurationCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

// LDG-04: the aws-cdk-lib S3 notification helpers (`bucket.addEventNotification`
// and `S3EventSource`) deploy through the native Custom::S3BucketNotifications
// provider, and the generated python3.13 handler function is admitted.

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const handlerCode = "exports.handler = async event => { for (const record of event.Records) console.log(`received ${decodeURIComponent(record.s3.object.key.replace(/\\+/g, \" \"))}`); return event.Records.length; };";

function synthesize(variant: "initial" | "updated"): Record<string, unknown> {
  const app = new App();
  const stack = new Stack(app, "S3NotificationsFixture", { env: { account, region } });
  const bucket = new s3.Bucket(stack, "Uploads", { bucketName: "cdk-s3-notifications-uploads", removalPolicy: RemovalPolicy.RETAIN });
  const fn = new lambda.Function(stack, "OnUpload", { functionName: "cdk-s3-notifications-on-upload", runtime: lambda.Runtime.NODEJS_22_X, handler: "index.handler", code: lambda.Code.fromInline(handlerCode) });
  bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new LambdaDestination(fn), { prefix: "uploads/" });
  if (variant === "updated") fn.addEventSource(new S3EventSource(bucket, { events: [s3.EventType.OBJECT_REMOVED], filters: [{ suffix: ".log" }] }));
  return app.synth().getStackArtifact(stack.artifactId).template as Record<string, unknown>;
}

function synthesizeImported(): Record<string, unknown> {
  const app = new App();
  const stack = new Stack(app, "S3ImportedNotificationsFixture", { env: { account, region } });
  const bucket = s3.Bucket.fromBucketName(stack, "External", "external-uploads");
  const fn = new lambda.Function(stack, "OnExternalUpload", { functionName: "cdk-s3-notifications-on-external-upload", runtime: lambda.Runtime.NODEJS_22_X, handler: "index.handler", code: lambda.Code.fromInline(handlerCode) });
  bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new LambdaDestination(fn));
  return app.synth().getStackArtifact(stack.artifactId).template as Record<string, unknown>;
}

async function waitForStack(client: CloudFormationClient, clock: TestClock, name: string, terminal: string): Promise<any> {
  for (let attempt = 0; attempt < 400; attempt++) {
    clock.advance(500); await new Promise(resolve => setTimeout(resolve, 5));
    try {
      const stack = (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
      if (stack?.StackStatus === terminal) return stack;
      if (stack?.StackStatus?.includes("FAILED") || stack?.StackStatus?.includes("ROLLBACK")) {
        const events = (await client.send(new DescribeStackEventsCommand({ StackName: name }))).StackEvents ?? [];
        const failures = events.filter(event => event.ResourceStatus?.includes("FAILED")).map(event => `${event.LogicalResourceId}: ${event.ResourceStatusReason}`);
        throw new Error(`${stack.StackStatus}: ${failures.join(" | ") || stack.StackStatusReason || ""}`);
      }
    } catch (error: any) {
      if (terminal === "DELETE_COMPLETE" && error.name === "ValidationError") return undefined;
      throw error;
    }
  }
  throw new Error(`Timed out waiting for ${terminal}`);
}

async function waitForLog(logs: CloudWatchLogsClient, clock: TestClock, logGroupName: string, pattern: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    clock.advance(250); await new Promise(resolve => setTimeout(resolve, 10));
    try {
      const events = await logs.send(new FilterLogEventsCommand({ logGroupName, filterPattern: `"${pattern}"` }));
      if (events.events?.length) return;
    } catch (error: any) { if (error.name !== "ResourceNotFoundException") throw error; }
  }
  throw new Error(`Timed out waiting for log line ${pattern}`);
}

const stackIdPrefix = (stackId: string) => `${stackId}-`;

test("CDK addEventNotification and S3EventSource deploy, fire, update, and clean up through Custom::S3BucketNotifications", async () => {
  const template = synthesize("initial");
  const resources = template.Resources as Record<string, { Type: string; Properties?: Record<string, any> }>;
  const custom = Object.values(resources).find(resource => resource.Type === "Custom::S3BucketNotifications");
  assert.ok(custom, "the CDK template contains the notifications custom resource");
  assert.ok(Object.values(resources).some(resource => resource.Type === "AWS::Lambda::Function" && resource.Properties?.Runtime === "python3.13"), "the CDK template contains the python3.13 helper");

  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-s3-notifications-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let cloudformation!: CloudFormationClient; let s3Client!: S3Client; let logs!: CloudWatchLogsClient; let lambdaClient!: LambdaClient;
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, systemClockOffset: clock.now() - Date.now() };
    cloudformation = new CloudFormationClient(options); s3Client = new S3Client({ ...options, forcePathStyle: true }); logs = new CloudWatchLogsClient(options); lambdaClient = new LambdaClient(options);

    await cloudformation.send(new CreateStackCommand({ StackName: "s3-notifications-fixture", TemplateBody: JSON.stringify(template), Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"] }));
    const created = await waitForStack(cloudformation, clock, "s3-notifications-fixture", "CREATE_COMPLETE");

    const configuration = await s3Client.send(new GetBucketNotificationConfigurationCommand({ Bucket: "cdk-s3-notifications-uploads" }));
    assert.equal(configuration.LambdaFunctionConfigurations?.length, 1);
    const [onCreated] = configuration.LambdaFunctionConfigurations!;
    assert.ok(onCreated.Id!.startsWith(stackIdPrefix(created.StackId)), "the helper names its configuration after the stack");
    assert.deepEqual(onCreated.Events, ["s3:ObjectCreated:*"]);
    assert.deepEqual(onCreated.Filter?.Key?.FilterRules?.map(rule => [rule.Name, rule.Value]), [["prefix", "uploads/"]]);
    assert.equal(onCreated.LambdaFunctionArn, `arn:aws:lambda:${region}:${account}:function:cdk-s3-notifications-on-upload`);

    const helper = Object.entries(resources).find(([, resource]) => resource.Type === "AWS::Lambda::Function" && resource.Properties?.Runtime === "python3.13")![0];
    const helperName = (await cloudformation.send(new DescribeStackEventsCommand({ StackName: "s3-notifications-fixture" }))).StackEvents!.find(event => event.LogicalResourceId === helper && event.PhysicalResourceId)!.PhysicalResourceId!;
    assert.equal((await lambdaClient.send(new GetFunctionCommand({ FunctionName: helperName }))).Configuration?.Runtime, "python3.13");

    await s3Client.send(new PutObjectCommand({ Bucket: "cdk-s3-notifications-uploads", Key: "uploads/hello world.txt", Body: "hi" }));
    await waitForLog(logs, clock, "/aws/lambda/cdk-s3-notifications-on-upload", "received uploads/hello world.txt");

    await cloudformation.send(new UpdateStackCommand({ StackName: "s3-notifications-fixture", TemplateBody: JSON.stringify(synthesize("updated")), Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"] }));
    await waitForStack(cloudformation, clock, "s3-notifications-fixture", "UPDATE_COMPLETE");
    const updated = await s3Client.send(new GetBucketNotificationConfigurationCommand({ Bucket: "cdk-s3-notifications-uploads" }));
    assert.deepEqual(updated.LambdaFunctionConfigurations?.map(item => item.Events).sort(), [["s3:ObjectCreated:*"], ["s3:ObjectRemoved:*"]]);

    await cloudformation.send(new DeleteStackCommand({ StackName: "s3-notifications-fixture" }));
    await waitForStack(cloudformation, clock, "s3-notifications-fixture", "DELETE_COMPLETE");
    const cleared = await s3Client.send(new GetBucketNotificationConfigurationCommand({ Bucket: "cdk-s3-notifications-uploads" }));
    assert.equal(cleared.LambdaFunctionConfigurations?.length ?? 0, 0, "the retained bucket keeps no stack notifications");
  } finally {
    cloudformation?.destroy(); s3Client?.destroy(); logs?.destroy(); lambdaClient?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an imported bucket keeps the notification configurations the CDK stack did not create", async () => {
  const template = synthesizeImported();
  const custom = Object.values(template.Resources as Record<string, any>).find(resource => resource.Type === "Custom::S3BucketNotifications");
  assert.equal(custom?.Properties?.Managed, false);

  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-s3-notifications-imported-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let cloudformation!: CloudFormationClient; let s3Client!: S3Client; let lambdaClient!: LambdaClient;
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, systemClockOffset: clock.now() - Date.now() };
    cloudformation = new CloudFormationClient(options); s3Client = new S3Client({ ...options, forcePathStyle: true }); lambdaClient = new LambdaClient(options);

    const externalArn = `arn:aws:lambda:${region}:${account}:function:external-consumer`;
    await lambdaClient.send(new CreateFunctionCommand({ FunctionName: "external-consumer", Runtime: "nodejs22.x", Role: `arn:aws:iam::${account}:role/test`, Handler: "index.handler", Code: { ZipFile: createZip([{ name: "index.js", content: "exports.handler = async () => 1;" }]) } }));
    await lambdaClient.send(new AddPermissionCommand({ FunctionName: "external-consumer", StatementId: "s3", Action: "lambda:InvokeFunction", Principal: "s3.amazonaws.com", SourceArn: "arn:aws:s3:::external-uploads" }));
    await s3Client.send(new CreateBucketCommand({ Bucket: "external-uploads" }));
    await s3Client.send(new PutBucketNotificationConfigurationCommand({ Bucket: "external-uploads", NotificationConfiguration: { LambdaFunctionConfigurations: [{ Id: "external", LambdaFunctionArn: externalArn, Events: ["s3:ObjectRemoved:*"] }] } }));

    await cloudformation.send(new CreateStackCommand({ StackName: "s3-imported-notifications-fixture", TemplateBody: JSON.stringify(template), Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"] }));
    const created = await waitForStack(cloudformation, clock, "s3-imported-notifications-fixture", "CREATE_COMPLETE");
    const merged = await s3Client.send(new GetBucketNotificationConfigurationCommand({ Bucket: "external-uploads" }));
    assert.deepEqual(merged.LambdaFunctionConfigurations?.map(item => item.Id === "external" ? "external" : item.Id!.startsWith(stackIdPrefix(created.StackId)) ? "stack" : item.Id).sort(), ["external", "stack"]);

    await cloudformation.send(new DeleteStackCommand({ StackName: "s3-imported-notifications-fixture" }));
    await waitForStack(cloudformation, clock, "s3-imported-notifications-fixture", "DELETE_COMPLETE");
    const remaining = await s3Client.send(new GetBucketNotificationConfigurationCommand({ Bucket: "external-uploads" }));
    assert.deepEqual(remaining.LambdaFunctionConfigurations?.map(item => item.Id), ["external"]);
  } finally {
    cloudformation?.destroy(); s3Client?.destroy(); lambdaClient?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
