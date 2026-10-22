import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStackResourceCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  waitUntilStackCreateComplete,
  waitUntilStackDeleteComplete,
  waitUntilStackUpdateComplete,
  type Capability,
} from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { DescribeRuleCommand, EnableRuleCommand, EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { GetRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { LambdaClient, ListEventSourceMappingsCommand } from "@aws-sdk/client-lambda";
import { CreateBucketCommand, GetBucketNotificationConfigurationCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { DescribeExecutionCommand, ListExecutionsCommand, SFNClient } from "@aws-sdk/client-sfn";
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";
import { applicationMessage } from "./support/lambda-logs.js";

// The quick starts are the Node.js 22 `sam init` templates from
// aws/aws-sam-cli-app-templates (Apache-2.0; see test/fixtures/sam/quickstarts/NOTICE),
// rendered with project name sam-app and architecture x86_64.
const quickstarts = resolve("test", "fixtures", "sam", "quickstarts");
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const bucket = "sam-artifacts";

interface Fixture {
  simulator: StackSim;
  endpoint: string;
  cloudformation: CloudFormationClient;
  s3: S3Client;
  iam: IAMClient;
  logs: CloudWatchLogsClient;
  lambda: LambdaClient;
  sqs: SQSClient;
  sns: SNSClient;
  sfn: SFNClient;
  events: EventBridgeClient;
  dynamodb: DynamoDBClient;
}

async function withSimulator(prefix: string, authMode: "off" | "enforce", run: (fixture: Fixture) => Promise<void>, clock?: TestClock): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode, ...(clock ? { clock } : {}), ...(authMode === "enforce" ? { cdkBootstrap: true } : {}) });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials, maxAttempts: 1 };
    const fixture: Fixture = {
      simulator,
      endpoint,
      cloudformation: new CloudFormationClient(options),
      s3: new S3Client({ ...options, forcePathStyle: true }),
      iam: new IAMClient(options),
      logs: new CloudWatchLogsClient(options),
      lambda: new LambdaClient(options),
      sqs: new SQSClient(options),
      sns: new SNSClient(options),
      sfn: new SFNClient(options),
      events: new EventBridgeClient(options),
      dynamodb: new DynamoDBClient(options),
    };
    clients.push(fixture.cloudformation, fixture.s3, fixture.iam, fixture.logs, fixture.lambda, fixture.sqs, fixture.sns, fixture.sfn, fixture.events, fixture.dynamodb);
    await fixture.s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await run(fixture);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

/** What `sam build` puts in a function's artifact: every file under the CodeUri directory. */
function zipDirectory(directory: string, files: Record<string, string> = {}): Buffer {
  const entries: Array<{ name: string; content: string | Buffer }> = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else entries.push({ name: relative(directory, path).split("\\").join("/"), content: files[relative(directory, path).split("\\").join("/")] ?? readFileSync(path) });
    }
  };
  walk(directory);
  return createZip(entries);
}

const md5 = (data: string | Buffer) => createHash("md5").update(data).digest("hex");
let changeSetCounter = 0;

/**
 * The SAM CLI `sam deploy --s3-bucket` wire flow: upload each artifact as
 * <md5>, rewrite CodeUri to s3://bucket/key, upload the packaged template as
 * <md5>.template, then CreateChangeSet with a local TemplateURL, wait, and
 * ExecuteChangeSet. Returns "no-changes" for an unchanged redeploy.
 */
async function samDeploy(fixture: Fixture, stackName: string, template: string, artifacts: Record<string, Buffer>, capabilities: Capability[] = ["CAPABILITY_IAM"], parameters: Record<string, string> = {}): Promise<"deployed" | "no-changes"> {
  let packaged = template;
  for (const [placeholder, artifact] of Object.entries(artifacts)) {
    const key = md5(artifact);
    await fixture.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: artifact, ServerSideEncryption: "AES256" }));
    packaged = packaged.replaceAll(placeholder, `s3://${bucket}/${key}`);
  }
  const templateKey = `${md5(packaged)}.template`;
  await fixture.s3.send(new PutObjectCommand({ Bucket: bucket, Key: templateKey, Body: packaged, ServerSideEncryption: "AES256" }));
  let changeSetType: "CREATE" | "UPDATE" = "UPDATE";
  try {
    const status = (await fixture.cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus;
    if (status === "REVIEW_IN_PROGRESS") changeSetType = "CREATE";
  } catch (error: any) {
    if (error?.message !== `Stack with id ${stackName} does not exist`) throw error;
    changeSetType = "CREATE";
  }
  const created = await fixture.cloudformation.send(new CreateChangeSetCommand({
    StackName: stackName,
    ChangeSetName: `samcli-deploy${Date.now()}${changeSetCounter++}`,
    ChangeSetType: changeSetType,
    TemplateURL: `${fixture.endpoint}/${bucket}/${templateKey}`,
    Capabilities: capabilities,
    Parameters: Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
    Tags: [],
  }));
  const changeSet = await fixture.cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: created.Id }));
  if (changeSet.Status === "FAILED") {
    if (/didn't contain changes|No updates are to be performed/.test(changeSet.StatusReason ?? "")) return "no-changes";
    throw new Error(`Change set failed: ${changeSet.StatusReason}`);
  }
  assert.equal(changeSet.Status, "CREATE_COMPLETE");
  await fixture.cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: created.Id }));
  const waiter = changeSetType === "CREATE" ? waitUntilStackCreateComplete : waitUntilStackUpdateComplete;
  const result = await waiter({ client: fixture.cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 60 }, { StackName: stackName });
  assert.equal(result.state, "SUCCESS", JSON.stringify(result.reason));
  return "deployed";
}

async function outputs(fixture: Fixture, stackName: string): Promise<Record<string, string>> {
  const stack = (await fixture.cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
  return Object.fromEntries((stack?.Outputs ?? []).map(output => [output.OutputKey!, output.OutputValue!]));
}

async function physicalId(fixture: Fixture, stackName: string, logicalId: string): Promise<string> {
  return (await fixture.cloudformation.send(new DescribeStackResourceCommand({ StackName: stackName, LogicalResourceId: logicalId }))).StackResourceDetail!.PhysicalResourceId!;
}

/** Call the host-based local execute-api endpoint `{apiId}.execute-api.localhost:{invokePort}`. */
function invoke(fixture: Fixture, apiId: string, method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const port = fixture.simulator.invokePort;
    const outgoing = request({ host: "127.0.0.1", port, method, path, headers: { host: `${apiId}.execute-api.localhost:${port}`, ...(body ? { "content-type": "application/json" } : {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("sam init hello-world (nodejs22.x) deploys through the sam deploy flow, serves, updates, and deletes", async () => {
  await withSimulator("stacksim-sam02-hello-", "off", async fixture => {
    const directory = join(quickstarts, "hello-world");
    const template = readFileSync(join(directory, "template.yaml"), "utf8").replaceAll("\r\n", "\n").replace("CodeUri: hello-world/", "CodeUri: __HELLO_WORLD_CODE__");
    const stackName = "hello";

    // Without CAPABILITY_IAM the generated role is refused, as on AWS.
    await assert.rejects(samDeploy(fixture, stackName, template, { __HELLO_WORLD_CODE__: zipDirectory(join(directory, "hello-world")) }, []), /Requires capabilities : \[CAPABILITY_IAM\]/);

    assert.equal(await samDeploy(fixture, stackName, template, { __HELLO_WORLD_CODE__: zipDirectory(join(directory, "hello-world")) }), "deployed");
    const apiId = await physicalId(fixture, stackName, "ServerlessRestApi");
    const values = await outputs(fixture, stackName);
    assert.equal(values.HelloWorldApi, `https://${apiId}.execute-api.${region}.amazonaws.com/Prod/hello/`);
    assert.equal(values.HelloWorldFunction, `arn:aws:lambda:${region}:000000000000:function:${await physicalId(fixture, stackName, "HelloWorldFunction")}`);
    assert.match(values.HelloWorldFunctionIamRole, /^arn:aws:iam::000000000000:role\/hello-HelloWorldFunctionRole-/);

    const response = await invoke(fixture, apiId, "GET", "/Prod/hello/");
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { message: "hello world" });
    assert.equal((await invoke(fixture, apiId, "GET", "/Stage/hello/")).status, 200, "the Deployment's StageName creates the extra Stage stage, as on AWS");

    const processed = JSON.parse(String((await fixture.cloudformation.send(new GetTemplateCommand({ StackName: stackName, TemplateStage: "Processed" }))).TemplateBody));
    assert.deepEqual(Object.keys(processed.Resources).map(id => id.replace(/[0-9a-f]{10}$/, "HASH")).sort(), [
      "HelloWorldFunction", "HelloWorldFunctionHelloWorldPermissionProd", "HelloWorldFunctionRole", "ServerlessRestApi", "ServerlessRestApiDeploymentHASH", "ServerlessRestApiProdStage",
    ]);
    assert.equal(processed.Resources.HelloWorldFunction.Properties.Timeout, 3, "Globals merge into the function");

    // An unchanged redeploy reports no changes.
    assert.equal(await samDeploy(fixture, stackName, template, { __HELLO_WORLD_CODE__: zipDirectory(join(directory, "hello-world")) }), "no-changes");

    // A code change updates only the function.
    const changedCode = zipDirectory(join(directory, "hello-world"), { "app.mjs": readFileSync(join(directory, "hello-world", "app.mjs"), "utf8").replace("hello world", "hello again") });
    assert.equal(await samDeploy(fixture, stackName, template, { __HELLO_WORLD_CODE__: changedCode }), "deployed");
    assert.deepEqual(JSON.parse((await invoke(fixture, apiId, "GET", "/Prod/hello/")).body), { message: "hello again" });
    assert.equal(await physicalId(fixture, stackName, "ServerlessRestApi"), apiId);

    const roleName = values.HelloWorldFunctionIamRole.split("/").pop()!;
    await fixture.cloudformation.send(new DeleteStackCommand({ StackName: stackName }));
    assert.equal((await waitUntilStackDeleteComplete({ client: fixture.cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 60 }, { StackName: stackName })).state, "SUCCESS");
    await assert.rejects(fixture.iam.send(new GetRoleCommand({ RoleName: roleName })), (error: any) => error.name === "NoSuchEntityException");
  });
});

test("sam init web CRUD quick start serves GET and POST, and its DynamoDBCrudPolicy is enforced", async () => {
  await withSimulator("stacksim-sam02-web-", "enforce", async fixture => {
    const directory = join(quickstarts, "web");
    // `sam build` packages the project directory for functions without CodeUri.
    const template = readFileSync(join(directory, "template.yaml"), "utf8").replaceAll("\r\n", "\n").replaceAll("      Handler: src/handlers/", "      CodeUri: __WEB_CODE__\n      Handler: src/handlers/");
    const code = zipDirectory(directory);
    const stackName = "web";
    assert.equal(await samDeploy(fixture, stackName, template, { __WEB_CODE__: code }), "deployed");
    const apiId = await physicalId(fixture, stackName, "ServerlessRestApi");
    assert.equal((await outputs(fixture, stackName)).WebEndpoint, `https://${apiId}.execute-api.${region}.amazonaws.com/Prod/`);

    const put = await invoke(fixture, apiId, "POST", "/Prod/", JSON.stringify({ id: "1", name: "first item" }));
    assert.equal(put.status, 200, put.body);
    assert.deepEqual(JSON.parse(put.body), { id: "1", name: "first item" });
    assert.deepEqual(JSON.parse((await invoke(fixture, apiId, "GET", "/Prod/")).body), [{ id: "1", name: "first item" }]);
    assert.deepEqual(JSON.parse((await invoke(fixture, apiId, "GET", "/Prod/1")).body), { id: "1", name: "first item" });

    // Removing the policy template removes the permission: the handler's Scan is denied.
    const withoutPolicy = template.replace(/(getAllItemsFunction:[\s\S]*?)      Policies:\n        # Give Create\/Read\/Update\/Delete Permissions to the SampleTable\n        - DynamoDBCrudPolicy:\n            TableName: !Ref SampleTable\n/, "$1");
    assert.notEqual(withoutPolicy, template);
    assert.equal(await samDeploy(fixture, stackName, withoutPolicy, { __WEB_CODE__: code }), "deployed");
    const denied = await invoke(fixture, apiId, "GET", "/Prod/");
    assert.equal(denied.status, 200, "the quick-start handler catches the error and returns no items");
    assert.equal(denied.body, "");
    const functionName = await physicalId(fixture, stackName, "getAllItemsFunction");
    const events = await fixture.logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${functionName}`, filterPattern: "AccessDenied" }));
    assert.ok(events.events?.length, "the denied Scan is logged as AccessDenied");
  });
});

test("an HttpApi event deploys an implicit HTTP API that serves through $default", async () => {
  await withSimulator("stacksim-sam02-httpapi-", "off", async fixture => {
    const template = `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  EchoFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: __ECHO_CODE__
      Handler: index.handler
      Runtime: nodejs22.x
      Events:
        Everything:
          Type: HttpApi
Outputs:
  HttpApiUrl:
    Value: !Sub "https://\${ServerlessHttpApi}.execute-api.\${AWS::Region}.\${AWS::URLSuffix}/"
`;
    const code = createZip([{ name: "index.mjs", content: "export const handler = async (event) => ({ statusCode: 200, body: JSON.stringify({ route: event.routeKey, path: event.rawPath, version: event.version }) });\n" }]);
    assert.equal(await samDeploy(fixture, "echo", template, { __ECHO_CODE__: code }), "deployed");
    const apiId = await physicalId(fixture, "echo", "ServerlessHttpApi");
    assert.equal((await outputs(fixture, "echo")).HttpApiUrl, `https://${apiId}.execute-api.${region}.amazonaws.com/`);
    const response = await invoke(fixture, apiId, "GET", "/any/path");
    assert.equal(response.status, 200, response.body);
    assert.deepEqual(JSON.parse(response.body), { route: "$default", path: "/any/path", version: "2.0" });
  });
});

// --- SAM-03 event-source quick starts -------------------------------------------

const sleep = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

/**
 * A quick start whose function has no CodeUri: `sam build` packages the
 * project directory with its npm dependencies. `<name>-dependencies` holds the
 * `npm install --omit=dev` output for dependencies the Node.js runtime does not
 * bundle (see its NOTICE); bundled `@aws-sdk/*` clients resolve from the runtime.
 */
function eventQuickStart(name: string): { template: string; code: Buffer } {
  const directory = join(quickstarts, name);
  const template = readFileSync(join(directory, "template.yaml"), "utf8").replaceAll("\r\n", "\n").replace("      Handler: src/handlers/", "      CodeUri: __CODE__\n      Handler: src/handlers/");
  const dependencies = join(quickstarts, `${name}-dependencies`);
  const entries: Array<{ name: string; content: Buffer }> = [];
  const walk = (root: string, current: string, prefix: string) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(root, path, prefix);
      else entries.push({ name: `${prefix}${relative(root, path).split("\\").join("/")}`, content: readFileSync(path) });
    }
  };
  walk(directory, directory, "");
  if (existsSync(dependencies)) walk(dependencies, dependencies, "node_modules/");
  return { template, code: createZip(entries) };
}

/** The template with the function's Events section removed. */
function withoutEvents(template: string): string {
  const removed = template.replace(/\n      Events:\n(?:(?: {8,}.*| *#.*|)\n)+/, "\n");
  assert.notEqual(removed, template);
  return removed;
}

/** Poll the function's CloudWatch Logs group until a message matches. */
async function functionLog(fixture: Fixture, functionName: string, pattern: RegExp, pump: () => void = () => undefined): Promise<string> {
  let seen: string[] = [];
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const events = await fixture.logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${functionName}` }));
      seen = (events.events ?? []).map(event => event.message ?? "");
      const match = seen.find(message => pattern.test(message));
      if (match) return match;
    } catch (error: any) {
      if (error?.name !== "ResourceNotFoundException") throw error;
    }
    pump();
    await sleep(50);
  }
  throw new Error(`No log line in /aws/lambda/${functionName} matched ${pattern}; saw: ${JSON.stringify(seen)}`);
}

/** Keep a fake clock moving (5x real time) while CloudFormation works through a deploy. */
async function withRunningClock<T>(clock: TestClock, step: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => clock.advance(100), 20);
  try { return await step(); } finally { clearInterval(timer); }
}

async function processedTemplate(fixture: Fixture, stackName: string): Promise<{ Resources: Record<string, any> }> {
  return JSON.parse(String((await fixture.cloudformation.send(new GetTemplateCommand({ StackName: stackName, TemplateStage: "Processed" }))).TemplateBody));
}

/** Redeploy without the function's events; exactly the event's generated resources disappear. */
async function assertEventRemoval(fixture: Fixture, stackName: string, template: string, code: Buffer, removed: string[], parameters: Record<string, string> = {}): Promise<void> {
  const before = Object.keys((await processedTemplate(fixture, stackName)).Resources).sort();
  for (const id of removed) assert.ok(before.includes(id), `${id} is generated by the event`);
  assert.equal(await samDeploy(fixture, stackName, withoutEvents(template), { __CODE__: code }, ["CAPABILITY_IAM"], parameters), "deployed");
  assert.deepEqual(Object.keys((await processedTemplate(fixture, stackName)).Resources).sort(), before.filter(id => !removed.includes(id)));
  for (const id of removed) {
    await assert.rejects(fixture.cloudformation.send(new DescribeStackResourceCommand({ StackName: stackName, LogicalResourceId: id })), /does not exist/);
  }
}

test("sam init sqs (nodejs22.x) deploys, logs a queued message, and drops its event source mapping when the event is removed", async () => {
  await withSimulator("stacksim-sam03-sqs-", "enforce", async fixture => {
    const { template, code } = eventQuickStart("sqs");
    const stackName = "sqs-app";
    assert.equal(await samDeploy(fixture, stackName, template, { __CODE__: code }), "deployed");
    const processed = await processedTemplate(fixture, stackName);
    assert.equal(processed.Resources.SQSPayloadLoggerSQSQueueEvent.Type, "AWS::Lambda::EventSourceMapping");
    assert.ok(processed.Resources.SQSPayloadLoggerRole.Properties.ManagedPolicyArns.includes("arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole"));

    const functionName = await physicalId(fixture, stackName, "SQSPayloadLogger");
    const { QueueUrl: queueUrl } = await fixture.sqs.send(new GetQueueUrlCommand({ QueueName: await physicalId(fixture, stackName, "SimpleQueue") }));
    await fixture.sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "hello from the sqs quick start" }));
    assert.match(await functionLog(fixture, functionName, /hello from the sqs quick start/), /"eventSource":"aws:sqs"/);

    await assertEventRemoval(fixture, stackName, template, code, ["SQSPayloadLoggerSQSQueueEvent"]);
    assert.deepEqual((await fixture.lambda.send(new ListEventSourceMappingsCommand({ FunctionName: functionName }))).EventSourceMappings, []);
  });
});

test("sam init sns (nodejs22.x) deploys, logs a published message, and drops its subscription when the event is removed", async () => {
  await withSimulator("stacksim-sam03-sns-", "enforce", async fixture => {
    const { template, code } = eventQuickStart("sns");
    const stackName = "sns-app";
    assert.equal(await samDeploy(fixture, stackName, template, { __CODE__: code }), "deployed");
    const functionName = await physicalId(fixture, stackName, "SNSPayloadLogger");
    const topicArn = await physicalId(fixture, stackName, "SimpleTopic");
    await fixture.sns.send(new PublishCommand({ TopicArn: topicArn, Message: "hello from the sns quick start" }));
    assert.match(await functionLog(fixture, functionName, /hello from the sns quick start/), /EventSource: 'aws:sns'/);

    await assertEventRemoval(fixture, stackName, template, code, ["SNSPayloadLoggerSNSTopicEvent", "SNSPayloadLoggerSNSTopicEventPermission"]);
  });
});

test("sam init s3 (nodejs22.x) deploys, logs a new .json object through S3ReadPolicy, skips other keys, and drops its notification when the event is removed", async () => {
  await withSimulator("stacksim-sam03-s3-", "enforce", async fixture => {
    const { template, code } = eventQuickStart("s3");
    const stackName = "s3-app";
    const parameters = { AppBucketName: "sam-app-json-objects" };
    assert.equal(await samDeploy(fixture, stackName, template, { __CODE__: code }, ["CAPABILITY_IAM"], parameters), "deployed");
    assert.deepEqual((await processedTemplate(fixture, stackName)).Resources.AppBucket.DependsOn, ["S3JsonLoggerFunctionS3NewObjectEventPermission"]);

    const functionName = await physicalId(fixture, stackName, "S3JsonLoggerFunction");
    await fixture.s3.send(new PutObjectCommand({ Bucket: parameters.AppBucketName, Key: "notes.txt", Body: "plain text the suffix filter skips" }));
    await fixture.s3.send(new PutObjectCommand({ Bucket: parameters.AppBucketName, Key: "data.json", Body: JSON.stringify({ hello: "from the s3 quick start" }) }));
    await functionLog(fixture, functionName, /\{"hello":"from the s3 quick start"\}/);
    await functionLog(fixture, functionName, /Complete!/);
    const all = await fixture.logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${functionName}` }));
    assert.ok(!all.events?.some(event => /plain text the suffix filter skips|AccessDenied/.test(event.message ?? "")), "only .json keys reach the function, and its S3ReadPolicy allows GetObject");

    await assertEventRemoval(fixture, stackName, template, code, ["S3JsonLoggerFunctionS3NewObjectEventPermission"], parameters);
    const notification = await fixture.s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: parameters.AppBucketName }));
    assert.equal(notification.LambdaFunctionConfigurations?.length ?? 0, 0);
  });
});

test("sam init cw-event (nodejs22.x) runs on its hourly cron when the clock passes the hour, and drops its rule when the event is removed", async () => {
  // The fake clock runs while CloudFormation deploys, then jumps past the next hour so the cron fires.
  const clock = new TestClock(Date.UTC(2026, 9, 21, 9, 0, 0));
  await withSimulator("stacksim-sam03-cw-event-", "off", async fixture => {
    const { template, code } = eventQuickStart("cw-event");
    const stackName = "cw-event-app";
    assert.equal(await withRunningClock(clock, () => samDeploy(fixture, stackName, template, { __CODE__: code })), "deployed");
    assert.equal((await processedTemplate(fixture, stackName)).Resources.ScheduledEventLoggerCloudWatchEvent.Properties.ScheduleExpression, "cron(0 * * * ? *)");
    const functionName = await physicalId(fixture, stackName, "ScheduledEventLogger");

    assert.ok(clock.now() < Date.UTC(2026, 9, 21, 10, 0, 0), "the deploy finishes before the first cron occurrence");
    clock.advance(Date.UTC(2026, 9, 21, 10, 0, 1) - clock.now());
    const line = await functionLog(fixture, functionName, /"detail-type":"Scheduled Event"/, () => clock.advance(0));
    assert.equal(Date.parse(JSON.parse(applicationMessage(line)).time), Date.UTC(2026, 9, 21, 10, 0, 0), "the event is the 10:00 occurrence");

    await withRunningClock(clock, () => assertEventRemoval(fixture, stackName, template, code, ["ScheduledEventLoggerCloudWatchEvent", "ScheduledEventLoggerCloudWatchEventPermission"]));
  }, clock);
});

// --- SAM-04 state machine quick start ---------------------------------------------

/**
 * Under IAM enforcement StackSim checks SigV4 dates against its clock. Advance
 * the fake clock and move every client's clock offset with it, as the SDK
 * does after a skew correction.
 */
function advanceSigned(fixture: Fixture, clock: TestClock, ms: number): void {
  clock.advance(ms);
  for (const client of [fixture.cloudformation, fixture.s3, fixture.iam, fixture.logs, fixture.lambda, fixture.sqs, fixture.sns, fixture.sfn, fixture.events, fixture.dynamodb]) {
    (client.config as { systemClockOffset: number }).systemClockOffset = clock.now() - Date.now();
  }
}

/** withRunningClock for IAM-enforced fixtures: the clock runs and signatures follow it. */
async function withRunningSignedClock<T>(fixture: Fixture, clock: TestClock, step: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => advanceSigned(fixture, clock, 100), 20);
  try { return await step(); } finally { clearInterval(timer); }
}

test("sam init step-func (nodejs22.x) deploys unmodified, stays idle while its schedule is disabled, and trades on the hour once the rule is enabled", async () => {
  const clock = new TestClock(Date.now());
  await withSimulator("stacksim-sam04-step-func-", "enforce", async fixture => {
    const directory = join(quickstarts, "step-func");
    // `sam build` zips each CodeUri directory; `sam package` uploads the definition file as it is.
    const template = readFileSync(join(directory, "template.yaml"), "utf8").replaceAll("\r\n", "\n")
      .replace("DefinitionUri: statemachine/stock_trader.asl.json", "DefinitionUri: __DEFINITION__")
      .replace("CodeUri: functions/stock-checker/", "CodeUri: __CHECKER__")
      .replace("CodeUri: functions/stock-seller/", "CodeUri: __SELLER__")
      .replace("CodeUri: functions/stock-buyer/", "CodeUri: __BUYER__");
    const artifacts = {
      __DEFINITION__: readFileSync(join(directory, "statemachine", "stock_trader.asl.json")),
      __CHECKER__: zipDirectory(join(directory, "functions", "stock-checker")),
      __SELLER__: zipDirectory(join(directory, "functions", "stock-seller")),
      __BUYER__: zipDirectory(join(directory, "functions", "stock-buyer")),
    };
    const stackName = "step-func-app";
    assert.equal(await withRunningSignedClock(fixture, clock, () => samDeploy(fixture, stackName, template, artifacts)), "deployed");

    const processed = await processedTemplate(fixture, stackName);
    const machine = processed.Resources.StockTradingStateMachine;
    assert.equal(machine.Type, "AWS::StepFunctions::StateMachine");
    assert.deepEqual(machine.Properties.DefinitionS3Location, { Bucket: bucket, Key: md5(artifacts.__DEFINITION__) });
    assert.deepEqual(machine.Properties.RoleArn, { "Fn::GetAtt": ["StockTradingStateMachineRole", "Arn"] });
    assert.equal(processed.Resources.StockTradingStateMachineHourlyTradingSchedule.Properties.State, "DISABLED");
    assert.deepEqual(processed.Resources.StockTradingStateMachineHourlyTradingScheduleRole.Properties.Policies[0].PolicyDocument.Statement[0], { Action: "states:StartExecution", Effect: "Allow", Resource: { Ref: "StockTradingStateMachine" } });

    const values = await outputs(fixture, stackName);
    const stateMachineArn = values.StockTradingStateMachineArn;
    assert.equal(stateMachineArn, await physicalId(fixture, stackName, "StockTradingStateMachine"));
    assert.match(stateMachineArn, /^arn:aws:states:eu-west-1:000000000000:stateMachine:[A-Za-z0-9-]*StockTradingStateMachine-/);
    assert.match(values.StockTradingStateMachineRole, /^arn:aws:iam::000000000000:role\/step-func-app-StockTradingStateMachineRole-/);

    // The quick start ships its schedule disabled, so time passing starts nothing.
    const ruleName = (await physicalId(fixture, stackName, "StockTradingStateMachineHourlyTradingSchedule")).split("/").pop()!;
    assert.equal((await fixture.events.send(new DescribeRuleCommand({ Name: ruleName }))).State, "DISABLED");
    advanceSigned(fixture, clock, 2 * 3_600_000);
    await sleep(200);
    assert.deepEqual((await fixture.sfn.send(new ListExecutionsCommand({ stateMachineArn }))).executions, []);

    // Enabling the rule (as the README suggests) starts an execution on the next hourly occurrence.
    await fixture.events.send(new EnableRuleCommand({ Name: ruleName }));
    advanceSigned(fixture, clock, 3_600_000 + 1_000);
    let execution: { executionArn?: string; status?: string } | undefined;
    for (let attempt = 0; attempt < 300 && execution?.status !== "SUCCEEDED"; attempt++) {
      execution = (await fixture.sfn.send(new ListExecutionsCommand({ stateMachineArn }))).executions?.[0];
      if (execution?.status === "FAILED") break;
      // Task retries wait on the simulator clock.
      advanceSigned(fixture, clock, 1_000);
      await sleep(50);
    }
    const described = await fixture.sfn.send(new DescribeExecutionCommand({ executionArn: execution!.executionArn }));
    assert.equal(described.status, "SUCCEEDED", JSON.stringify(described));

    // The Record Transaction task wrote the trade through the role's DynamoDBWritePolicy.
    const items = (await fixture.dynamodb.send(new ScanCommand({ TableName: await physicalId(fixture, stackName, "TransactionTable") }))).Items ?? [];
    assert.equal(items.length, 1);
    assert.ok(["buy", "sell"].includes(items[0].Type.S!));
    assert.match(items[0].Id.S!, /^[0-9a-f]{32}$/);
  }, clock);
});
