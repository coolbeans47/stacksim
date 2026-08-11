import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  CreateEventBusCommand,
  EventBridgeClient,
  ListTargetsByRuleCommand,
  PutEventsCommand,
  PutRuleCommand,
  PutTargetsCommand,
} from "@aws-sdk/client-eventbridge";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
  PutResourcePolicyCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  GetResourcesCommand,
  PutIntegrationCommand,
  PutMethodCommand,
} from "@aws-sdk/client-api-gateway";
import {
  CreateFunctionCommand,
  InvocationType,
  InvokeCommand,
  LambdaClient,
  PutFunctionEventInvokeConfigCommand,
} from "@aws-sdk/client-lambda";
import { CloudWatchClient, ListMetricsCommand, PutAlarmMuteRuleCommand, PutCompositeAlarmCommand, PutMetricAlarmCommand, SetAlarmStateCommand } from "@aws-sdk/client-cloudwatch";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const fixedTime = Date.parse("2026-07-20T12:00:00.000Z");

interface Harness {
  root: string;
  simulator: StackSim;
  endpoint: string;
  clock: TestClock;
  authMode: "off" | "enforce";
  clients: Array<{ destroy(): void }>;
  events: EventBridgeClient;
  sqs: SQSClient;
  logs: CloudWatchLogsClient;
  apigateway: APIGatewayClient;
  lambda: LambdaClient;
  cloudwatch: CloudWatchClient;
  iam: IAMClient;
  sts: STSClient;
}

const active: Harness[] = [];
const servers: Server[] = [];
const originalOutbound = process.env.STACKSIM_ALLOW_OUTBOUND_HTTP;
const originalPrivate = process.env.STACKSIM_ALLOW_PRIVATE_HTTP;

function attachClients(h: Harness): void {
  const options = { endpoint: h.endpoint, region, credentials };
  h.events = new EventBridgeClient(options);
  h.sqs = new SQSClient(options);
  h.logs = new CloudWatchLogsClient(options);
  h.apigateway = new APIGatewayClient(options);
  h.lambda = new LambdaClient(options);
  h.cloudwatch = new CloudWatchClient(options);
  h.iam = new IAMClient(options);
  h.sts = new STSClient(options);
  h.clients.push(h.events, h.sqs, h.logs, h.apigateway, h.lambda, h.cloudwatch, h.iam, h.sts);
}

async function harness(options: { authMode?: "off" | "enforce"; clock?: TestClock } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "stacksim-eventbridge-extended-"));
  const clock = options.clock ?? new TestClock(options.authMode === "enforce" ? Date.now() : fixedTime);
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: options.authMode ?? "off", cdkBootstrap: true });
  await simulator.start();
  const h = {
    root,
    simulator,
    endpoint: `http://127.0.0.1:${simulator.port}`,
    clock,
    authMode: options.authMode ?? "off",
    clients: [],
  } as unknown as Harness;
  attachClients(h);
  active.push(h);
  return h;
}

async function restart(h: Harness): Promise<void> {
  for (const client of h.clients.splice(0)) client.destroy();
  await h.simulator.stop();
  h.simulator = new StackSim({ port: 0, invokePort: 0, dataDir: h.root, region, clock: h.clock, authMode: h.authMode, cdkBootstrap: true });
  await h.simulator.start();
  h.endpoint = `http://127.0.0.1:${h.simulator.port}`;
  attachClients(h);
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    server.closeAllConnections?.();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
  if (originalOutbound === undefined) delete process.env.STACKSIM_ALLOW_OUTBOUND_HTTP; else process.env.STACKSIM_ALLOW_OUTBOUND_HTTP = originalOutbound;
  if (originalPrivate === undefined) delete process.env.STACKSIM_ALLOW_PRIVATE_HTTP; else process.env.STACKSIM_ALLOW_PRIVATE_HTTP = originalPrivate;
  while (active.length) {
    const h = active.pop()!;
    for (const client of h.clients) client.destroy();
    await h.simulator.stop().catch(() => undefined);
    await rm(h.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, h?: Harness, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    h?.clock.advance(0);
    await tick();
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for EVB-02 asynchronous work");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function queueArn(name: string): string { return `arn:aws:sqs:${region}:${account}:${name}`; }
function ruleArn(name: string, bus = "default"): string { return `arn:aws:events:${region}:${account}:rule/${bus === "default" ? "" : `${bus}/`}${name}`; }

function document(statements: unknown[]): string {
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

function eventBridgeQueuePolicy(arn: string, sourceRuleArn: string): string {
  return document([{
    Sid: "AllowEventBridge",
    Effect: "Allow",
    Principal: { Service: "events.amazonaws.com" },
    Action: "sqs:SendMessage",
    Resource: arn,
    Condition: { ArnEquals: { "aws:SourceArn": sourceRuleArn }, StringEquals: { "aws:SourceAccount": account } },
  }]);
}

async function createQueue(h: Harness, name: string, attributes: Record<string, string> = {}): Promise<{ url: string; arn: string }> {
  const arn = queueArn(name);
  const output = await h.sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  return { url: output.QueueUrl!, arn };
}

async function allowRuleToSend(h: Harness, queue: { url: string; arn: string }, sourceRuleArn: string): Promise<void> {
  await h.sqs.send(new SetQueueAttributesCommand({ QueueUrl: queue.url, Attributes: { Policy: eventBridgeQueuePolicy(queue.arn, sourceRuleArn) } }));
}

async function receiveOne(h: Harness, queueUrl: string, timeoutMs = 10_000): Promise<Message> {
  const message = await waitFor(
    async () => (await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, AttributeNames: ["All"], MessageAttributeNames: ["All"] }))).Messages?.[0],
    value => Boolean(value),
    h,
    timeoutMs,
  );
  return message!;
}

async function createHttpBackend(status = 202): Promise<{ origin: string; requests: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: string }>; setStatus(value: number): void }> {
  const requests: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
  let responseStatus = status;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url ?? "/", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.statusCode = responseStatus;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ accepted: responseStatus < 400 }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP backend did not bind a TCP port");
  return { origin: `http://127.0.0.1:${address.port}`, requests, setStatus(value) { responseStatus = value; } };
}

async function deployEventBridgeApi(h: Harness, sourceRuleArn: string, backendOrigin: string): Promise<string> {
  process.env.STACKSIM_ALLOW_OUTBOUND_HTTP = "true";
  process.env.STACKSIM_ALLOW_PRIVATE_HTTP = "true";
  const api = await h.apigateway.send(new CreateRestApiCommand({
    name: "eventbridge-target",
    policy: document([{
      Effect: "Allow",
      Principal: { Service: "events.amazonaws.com" },
      Action: "execute-api:Invoke",
      Resource: "execute-api:/*",
      Condition: { ArnEquals: { "aws:SourceArn": sourceRuleArn }, StringEquals: { "aws:SourceAccount": account } },
    }]),
  }));
  const root = (await h.apigateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!;
  const orders = await h.apigateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: root.id!, pathPart: "orders" }));
  const customer = await h.apigateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: orders.id!, pathPart: "{customer}" }));
  await h.apigateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: customer.id!, httpMethod: "POST", authorizationType: "NONE" }));
  await h.apigateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: customer.id!, httpMethod: "POST", type: "HTTP_PROXY", integrationHttpMethod: "POST", uri: `${backendOrigin}/capture` }));
  await h.apigateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
  return `arn:aws:execute-api:${region}:${account}:${api.id}/dev/POST/orders/*`;
}

test("Target.RoleArn requires PassRole and EventBridge trust, and supported target parameters round-trip", async () => {
  const h = await harness({ authMode: "enforce" });
  const queue = await createQueue(h, "role-target");
  const sourceRule = ruleArn("role-target-rule");
  await h.events.send(new PutRuleCommand({ Name: "role-target-rule", EventPattern: JSON.stringify({ source: ["role.test"] }) }));

  const targetRole = await h.iam.send(new CreateRoleCommand({ RoleName: "eventbridge-target", AssumeRolePolicyDocument: document([{
    Effect: "Allow",
    Principal: { Service: "events.amazonaws.com" },
    Action: "sts:AssumeRole",
    Condition: { ArnLike: { "aws:SourceArn": sourceRule }, StringEquals: { "aws:SourceAccount": account } },
  }]) }));
  await h.iam.send(new PutRolePolicyCommand({ RoleName: "eventbridge-target", PolicyName: "send", PolicyDocument: document([{
    Effect: "Allow",
    Action: "sqs:SendMessage",
    Resource: queue.arn,
    Condition: { StringEquals: { "aws:PrincipalArn": targetRole.Role!.Arn!, "aws:PrincipalAccount": account, "aws:SourceArn": sourceRule, "aws:SourceAccount": account, "aws:RequestedRegion": region } },
  }]) }));
  const wrongTrust = await h.iam.send(new CreateRoleCommand({ RoleName: "eventbridge-wrong-trust", AssumeRolePolicyDocument: document([{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }]) }));
  const caller = await h.iam.send(new CreateRoleCommand({ RoleName: "eventbridge-configurer", AssumeRolePolicyDocument: document([{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: "sts:AssumeRole" }]) }));
  const callerPolicy = (withPassRole: boolean) => document([
    { Effect: "Allow", Action: ["events:PutTargets", "events:ListTargetsByRule"], Resource: sourceRule },
    ...(withPassRole ? [{ Effect: "Allow", Action: "iam:PassRole", Resource: targetRole.Role!.Arn!, Condition: { StringEquals: { "iam:PassedToService": "events.amazonaws.com" } } }] : []),
  ]);
  await h.iam.send(new PutRolePolicyCommand({ RoleName: "eventbridge-configurer", PolicyName: "configure", PolicyDocument: callerPolicy(false) }));
  const assumed = await h.sts.send(new AssumeRoleCommand({ RoleArn: caller.Role!.Arn!, RoleSessionName: "configure" }));
  const delegated = new EventBridgeClient({ endpoint: h.endpoint, region, credentials: { accessKeyId: assumed.Credentials!.AccessKeyId!, secretAccessKey: assumed.Credentials!.SecretAccessKey!, sessionToken: assumed.Credentials!.SessionToken! } });
  h.clients.push(delegated);

  const target = { Id: "queue", Arn: queue.arn, RoleArn: targetRole.Role!.Arn!, SqsParameters: { MessageGroupId: "tenant-a" }, RetryPolicy: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 2 } };
  await assert.rejects(delegated.send(new PutTargetsCommand({ Rule: "role-target-rule", Targets: [target] })), (error: any) => error.name === "AccessDeniedException" && /iam:PassRole/.test(error.message));
  await h.iam.send(new PutRolePolicyCommand({ RoleName: "eventbridge-configurer", PolicyName: "configure", PolicyDocument: callerPolicy(true) }));
  assert.equal((await delegated.send(new PutTargetsCommand({ Rule: "role-target-rule", Targets: [target] }))).FailedEntryCount, 0);
  const stored = (await delegated.send(new ListTargetsByRuleCommand({ Rule: "role-target-rule" }))).Targets![0];
  assert.equal(stored.RoleArn, targetRole.Role!.Arn);
  assert.equal(stored.SqsParameters?.MessageGroupId, "tenant-a");
  assert.equal(stored.RetryPolicy?.MaximumRetryAttempts, 2);
  await h.events.send(new PutEventsCommand({ Entries: [{ Source: "role.test", DetailType: "Role delivery", Detail: "{}" }] }));
  assert.equal((await receiveOne(h, queue.url)).Attributes?.MessageGroupId, "tenant-a", "delivery re-assumes the source-scoped role with session context");

  const untrusted = await h.events.send(new PutTargetsCommand({ Rule: "role-target-rule", Targets: [{ Id: "wrong-trust", Arn: queue.arn, RoleArn: wrongTrust.Role!.Arn! }] }));
  assert.equal(untrusted.FailedEntryCount, 1);
  assert.equal(untrusted.FailedEntries?.[0].ErrorCode, "AccessDeniedException");
});

test("EventBridge target-role sessions expose global and rule context to Lambda authorization", async () => {
  const h = await harness();
  const sourceRule = ruleArn("lambda-role-session");
  await h.events.send(new PutRuleCommand({ Name: "lambda-role-session", EventPattern: JSON.stringify({ source: ["role.lambda"] }) }));

  const executionRole = await h.iam.send(new CreateRoleCommand({ RoleName: "lambda-role-session-runtime", AssumeRolePolicyDocument: document([{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }]) }));
  const zip = createZip([{ name: "index.mjs", content: "export async function handler() { return { ok: true }; }" }]);
  const fn = await h.lambda.send(new CreateFunctionCommand({ FunctionName: "eventbridge-role-target", Runtime: "nodejs22.x", Role: executionRole.Role!.Arn!, Handler: "index.handler", Code: { ZipFile: zip } }));
  await tick();

  const targetRole = await h.iam.send(new CreateRoleCommand({ RoleName: "eventbridge-lambda-target", AssumeRolePolicyDocument: document([{
    Effect: "Allow",
    Principal: { Service: "events.amazonaws.com" },
    Action: "sts:AssumeRole",
    Condition: { ArnLike: { "aws:SourceArn": sourceRule }, StringEquals: { "aws:SourceAccount": account } },
  }]) }));
  await h.iam.send(new PutRolePolicyCommand({ RoleName: "eventbridge-lambda-target", PolicyName: "invoke", PolicyDocument: document([{
    Effect: "Allow",
    Action: "lambda:InvokeFunction",
    Resource: fn.FunctionArn!,
    Condition: { StringEquals: { "aws:PrincipalArn": targetRole.Role!.Arn!, "aws:PrincipalAccount": account, "aws:SourceArn": sourceRule, "aws:SourceAccount": account, "aws:RequestedRegion": region } },
  }]) }));

  const configured = await h.events.send(new PutTargetsCommand({ Rule: "lambda-role-session", Targets: [{ Id: "lambda", Arn: fn.FunctionArn!, RoleArn: targetRole.Role!.Arn! }] }));
  assert.equal(configured.FailedEntryCount, 0);
  await h.events.send(new PutEventsCommand({ Entries: [{ Source: "role.lambda", DetailType: "Role delivery", Detail: "{}" }] }));
  await waitFor(
    () => h.simulator.eventbridge.deliveryDiagnostics().diagnostics,
    diagnostics => diagnostics.some((item: any) => item.targetId === "lambda" && item.status === "SUCCEEDED"),
    h,
  );
});

test("FIFO and fair SQS target validation enforces group, deduplication, Region, and Standard-DLQ boundaries", async () => {
  const h = await harness();
  const sourceRule = ruleArn("sqs-boundaries");
  await h.events.send(new PutRuleCommand({ Name: "sqs-boundaries", EventPattern: JSON.stringify({ source: ["sqs.boundaries"] }) }));
  const fifo = await createQueue(h, "ordered.fifo", { FifoQueue: "true", ContentBasedDeduplication: "true" });
  const noDedup = await createQueue(h, "manual-dedup.fifo", { FifoQueue: "true", ContentBasedDeduplication: "false" });
  const standard = await createQueue(h, "fair-boundary");
  const fifoDlq = await createQueue(h, "invalid-dlq.fifo", { FifoQueue: "true", ContentBasedDeduplication: "true" });
  await allowRuleToSend(h, fifo, sourceRule);
  await allowRuleToSend(h, standard, sourceRule);

  const result = await h.events.send(new PutTargetsCommand({ Rule: "sqs-boundaries", Targets: [
    { Id: "fifo", Arn: fifo.arn, SqsParameters: { MessageGroupId: "orders" } },
    { Id: "fifo-missing-group", Arn: fifo.arn },
    { Id: "fifo-no-content-dedup", Arn: noDedup.arn, SqsParameters: { MessageGroupId: "orders" } },
    { Id: "cross-region", Arn: `arn:aws:sqs:us-east-1:${account}:remote`, SqsParameters: { MessageGroupId: "orders" } },
    { Id: "fifo-dlq", Arn: standard.arn, SqsParameters: { MessageGroupId: "fair" }, DeadLetterConfig: { Arn: fifoDlq.arn } },
  ] }));
  assert.equal(result.FailedEntryCount, 4);
  assert.deepEqual(result.FailedEntries?.map(entry => entry.TargetId).sort(), ["cross-region", "fifo-dlq", "fifo-missing-group", "fifo-no-content-dedup"]);
  assert.equal(result.FailedEntries?.every(entry => entry.ErrorCode === "ValidationException"), true);

  const listed = (await h.events.send(new ListTargetsByRuleCommand({ Rule: "sqs-boundaries" }))).Targets!;
  assert.deepEqual(listed.map(target => ({ id: target.Id, group: target.SqsParameters?.MessageGroupId })), [{ id: "fifo", group: "orders" }]);
  await h.events.send(new PutEventsCommand({ Entries: [{ Source: "sqs.boundaries", DetailType: "FIFO", Detail: JSON.stringify({ sequence: 1 }) }] }));
  const delivered = await receiveOne(h, fifo.url);
  assert.equal(delivered.Attributes?.MessageGroupId, "orders");
  assert.ok(delivered.Attributes?.MessageDeduplicationId, "FIFO delivery uses the queue's content-based deduplication ID");
});

test("CloudWatch Logs targets reject Input and InputPath and require the timestamp/message transformer shape at PutTargets", async () => {
  const h = await harness();
  await h.events.send(new PutRuleCommand({ Name: "logs-input-contract", EventPattern: JSON.stringify({ source: ["logs.contract"] }) }));
  const groupArn = `arn:aws:logs:${region}:${account}:log-group:/aws/events/input-contract`;
  const rejected = await h.events.send(new PutTargetsCommand({ Rule: "logs-input-contract", Targets: [
    { Id: "input", Arn: groupArn, Input: JSON.stringify({ message: "unsupported" }) },
    { Id: "input-path", Arn: groupArn, InputPath: "$.detail" },
    { Id: "wrong-key", Arn: groupArn, InputTransformer: { InputPathsMap: { timestamp: "$.detail.timestamp", message: "$.detail.message" }, InputTemplate: "{\"timestamp\":<timestamp>,\"body\":<message>}" } },
    { Id: "composed-message", Arn: groupArn, InputTransformer: { InputPathsMap: { timestamp: "$.detail.timestamp", message: "$.detail.message" }, InputTemplate: "{\"timestamp\":<timestamp>,\"message\":\"prefix <message>\"}" } },
  ] }));
  assert.equal(rejected.FailedEntryCount, 4);
  assert.ok(rejected.FailedEntries?.every(entry => entry.ErrorCode === "ValidationException"));
  assert.match(rejected.FailedEntries?.find(entry => entry.TargetId === "input")?.ErrorMessage ?? "", /do not support Target\.Input/);
  assert.match(rejected.FailedEntries?.find(entry => entry.TargetId === "input-path")?.ErrorMessage ?? "", /do not support Target\.InputPath/);
  assert.match(rejected.FailedEntries?.find(entry => entry.TargetId === "wrong-key")?.ErrorMessage ?? "", /timestamp.*message/);
  assert.match(rejected.FailedEntries?.find(entry => entry.TargetId === "composed-message")?.ErrorMessage ?? "", /timestamp.*message/);
  assert.equal((await h.events.send(new ListTargetsByRuleCommand({ Rule: "logs-input-contract" }))).Targets?.length, 0, "invalid target entries do not mutate the rule");

  const accepted = await h.events.send(new PutTargetsCommand({ Rule: "logs-input-contract", Targets: [{
    Id: "logs",
    Arn: groupArn,
    InputTransformer: {
      InputPathsMap: { timestamp: "$.detail.timestamp", message: "$.detail.message" },
      InputTemplate: "{ \"timestamp\": <timestamp>, \"message\": <message> }",
    },
  }] }));
  assert.equal(accepted.FailedEntryCount, 0);
  assert.equal((await h.events.send(new ListTargetsByRuleCommand({ Rule: "logs-input-contract" }))).Targets?.[0].InputTransformer?.InputTemplate, "{ \"timestamp\": <timestamp>, \"message\": <message> }");
});

test("per-target diagnostics retain retry counts after a retry reaches terminal success", async () => {
  const h = await harness();
  await h.events.send(new PutRuleCommand({ Name: "retry-diagnostics", EventPattern: JSON.stringify({ source: ["retry.diagnostics"] }) }));
  const lambdaArn = `arn:aws:lambda:${region}:${account}:function:retry-diagnostics`;
  let calls = 0;
  (h.simulator.lambda as any).enqueueEventBridgeInvocation = async () => {
    calls++;
    if (calls === 1) { const error = new Error("retry once"); error.name = "TooManyRequestsException"; throw error; }
    return "accepted";
  };
  assert.equal((await h.events.send(new PutTargetsCommand({ Rule: "retry-diagnostics", Targets: [{ Id: "lambda", Arn: lambdaArn, RetryPolicy: { MaximumEventAgeInSeconds: 300, MaximumRetryAttempts: 2 } }] }))).FailedEntryCount, 0);
  await h.events.send(new PutEventsCommand({ Entries: [{ Source: "retry.diagnostics", DetailType: "Retry", Detail: "{}" }] }));

  const queued = await waitFor(
    () => h.simulator.eventbridge.deliveryDiagnostics().deliveries[0],
    delivery => delivery?.status === "QUEUED" && delivery.attempts === 1,
    h,
  );
  let diagnostics = await waitFor(
    () => h.simulator.eventbridge.deliveryDiagnostics(),
    state => state.diagnostics.some((item: any) => item.targetId === "lambda" && item.status === "RETRYING"),
    h,
  );
  assert.equal(diagnostics.diagnostics.find((item: any) => item.targetId === "lambda")?.retries, 1);
  assert.equal(diagnostics.targets.find((item: any) => item.targetId === "lambda")?.retries, 1);
  h.clock.advance(Math.max(0, queued.nextAttemptAt - h.clock.now()));
  diagnostics = await waitFor(
    () => h.simulator.eventbridge.deliveryDiagnostics(),
    state => state.diagnostics.some((item: any) => item.targetId === "lambda" && item.status === "SUCCEEDED"),
    h,
  );
  const completed = diagnostics.diagnostics.find((item: any) => item.targetId === "lambda");
  assert.equal(calls, 2);
  assert.equal(completed.attempts, 2);
  assert.equal(completed.retries, 1);
  const summary = diagnostics.targets.find((item: any) => item.targetId === "lambda");
  assert.equal(summary.retries, 1);
  assert.equal(summary.successes, 1);
  assert.equal(summary.failures, 0);
});

test("one event independently reaches Lambda, fair SQS, Logs, and deployed API Gateway with target transforms", async () => {
  const h = await harness();
  const sourceRule = ruleArn("four-way");
  await h.events.send(new PutRuleCommand({ Name: "four-way", EventPattern: JSON.stringify({ source: ["fanout.extended"] }) }));
  const queue = await createQueue(h, "fair-orders");
  await allowRuleToSend(h, queue, sourceRule);
  const groupName = "/aws/events/four-way";
  const groupArn = `arn:aws:logs:${region}:${account}:log-group:${groupName}`;
  await h.logs.send(new CreateLogGroupCommand({ logGroupName: groupName }));
  await h.logs.send(new PutResourcePolicyCommand({
    policyName: "eventbridge-four-way",
    resourceArn: groupArn,
    policyDocument: document([{
      Effect: "Allow",
      Principal: { Service: "events.amazonaws.com" },
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: `${groupArn}:*`,
      Condition: { ArnEquals: { "aws:SourceArn": sourceRule }, StringEquals: { "aws:SourceAccount": account } },
    }]),
  }));
  const backend = await createHttpBackend();
  const apiArn = await deployEventBridgeApi(h, sourceRule, backend.origin);
  const lambdaArn = `arn:aws:lambda:${region}:${account}:function:extended-capture`;
  const lambdaCalls: Array<{ arn: string; payload: unknown; rule: string; lineage: string[] }> = [];
  (h.simulator.lambda as any).enqueueEventBridgeInvocation = async (arn: string, payload: Buffer, rule: string, _role?: string, lineage: string[] = []) => {
    lambdaCalls.push({ arn, payload: JSON.parse(payload.toString("utf8")), rule, lineage });
    return "accepted";
  };

  const configured = await h.events.send(new PutTargetsCommand({ Rule: "four-way", Targets: [
    { Id: "lambda", Arn: lambdaArn, Input: JSON.stringify({ target: "lambda" }) },
    { Id: "queue", Arn: queue.arn, SqsParameters: { MessageGroupId: "tenant-a" }, InputTransformer: { InputPathsMap: { id: "$.detail.id", kind: "$.detail.kind" }, InputTemplate: "{\"id\":<id>,\"kind\":<kind>}" } },
    { Id: "logs", Arn: groupArn, InputTransformer: { InputPathsMap: { message: "$.detail.logMessage", timestamp: "$.detail.timestamp" }, InputTemplate: "{\"timestamp\":<timestamp>,\"message\":<message>}" } },
    { Id: "api", Arn: apiArn, InputPath: "$.detail", HttpParameters: { PathParameterValues: ["$.detail.customer"], QueryStringParameters: { kind: "$.detail.kind", fixed: "yes" }, HeaderParameters: { "X-Order": "$.detail.id" } } },
  ] }));
  assert.equal(configured.FailedEntryCount, 0);
  const listed = (await h.events.send(new ListTargetsByRuleCommand({ Rule: "four-way" }))).Targets!;
  assert.deepEqual(listed.find(target => target.Id === "api")?.HttpParameters, { PathParameterValues: ["$.detail.customer"], QueryStringParameters: { fixed: "yes", kind: "$.detail.kind" }, HeaderParameters: { "X-Order": "$.detail.id" } });
  assert.equal(listed.find(target => target.Id === "queue")?.SqsParameters?.MessageGroupId, "tenant-a");

  const sent = await h.events.send(new PutEventsCommand({ Entries: [{ Source: "fanout.extended", DetailType: "Order created", Detail: JSON.stringify({ id: "o-1", kind: "created", customer: "alice", timestamp: fixedTime, logMessage: "log o-1" }), Time: new Date(fixedTime) }] }));
  assert.equal(sent.FailedEntryCount, 0);
  await waitFor(() => h.simulator.eventbridge.deliveryDiagnostics().diagnostics, diagnostics => diagnostics.filter((item: any) => item.status === "SUCCEEDED").length >= 4, h);

  assert.deepEqual(lambdaCalls.map(call => ({ arn: call.arn, payload: call.payload, rule: call.rule })), [{ arn: lambdaArn, payload: { target: "lambda" }, rule: sourceRule }]);
  assert.deepEqual(lambdaCalls[0].lineage, [sourceRule]);
  const queued = await receiveOne(h, queue.url);
  assert.deepEqual(JSON.parse(queued.Body!), { id: "o-1", kind: "created" });
  assert.equal(queued.Attributes?.MessageGroupId, "tenant-a", "MessageGroupId makes a Standard target a fair queue delivery");

  const streams = await h.logs.send(new DescribeLogStreamsCommand({ logGroupName: groupName }));
  assert.equal(streams.logStreams?.length, 1);
  assert.match(streams.logStreams![0].logStreamName!, /^eventbridge\/[0-9a-f]{32}$/);
  const logEvents = await h.logs.send(new GetLogEventsCommand({ logGroupName: groupName, logStreamName: streams.logStreams![0].logStreamName!, startFromHead: true }));
  assert.deepEqual(logEvents.events?.map(event => ({ timestamp: event.timestamp, message: event.message })), [{ timestamp: fixedTime, message: "log o-1" }]);

  assert.equal(backend.requests.length, 1);
  const request = backend.requests[0];
  assert.equal(new URL(request.path, backend.origin).searchParams.get("kind"), "created");
  assert.equal(new URL(request.path, backend.origin).searchParams.get("fixed"), "yes");
  assert.equal(request.headers["x-order"], "o-1");
  assert.deepEqual(JSON.parse(request.body), { id: "o-1", kind: "created", customer: "alice", timestamp: fixedTime, logMessage: "log o-1" });
});

test("queued target intents survive restart and re-authorize the destination policy at delivery time", async () => {
  const h = await harness();
  const sourceRule = ruleArn("restart-queue");
  const queue = await createQueue(h, "restart-target");
  await allowRuleToSend(h, queue, sourceRule);
  await h.events.send(new PutRuleCommand({ Name: "restart-queue", EventPattern: JSON.stringify({ source: ["restart.extended"] }) }));
  await h.events.send(new PutTargetsCommand({ Rule: "restart-queue", Targets: [{ Id: "queue", Arn: queue.arn, InputTransformer: { InputPathsMap: { id: "$.detail.id" }, InputTemplate: "{\"persisted\":<id>}" } }] }));
  await h.events.send(new PutEventsCommand({ Entries: [{ Source: "restart.extended", DetailType: "Restart", Detail: JSON.stringify({ id: "before-stop" }) }] }));
  assert.equal(h.simulator.eventbridge.deliveryDiagnostics().queued, 1);

  await restart(h);
  const delivered = await receiveOne(h, queue.url);
  assert.deepEqual(JSON.parse(delivered.Body!), { persisted: "before-stop" });

  let lambdaAccepted = 0;
  (h.simulator.lambda as any).enqueueEventBridgeInvocation = async () => { lambdaAccepted++; return "accepted"; };
  await h.events.send(new PutTargetsCommand({ Rule: "restart-queue", Targets: [{ Id: "independent-lambda", Arn: `arn:aws:lambda:${region}:${account}:function:policy-isolation` }] }));
  await h.events.send(new PutEventsCommand({ Entries: [{ Source: "restart.extended", DetailType: "Policy revoked", Detail: JSON.stringify({ id: "policy-change" }) }] }));
  await h.sqs.send(new SetQueueAttributesCommand({ QueueUrl: queue.url, Attributes: { Policy: "" } }));
  await waitFor(
    () => ({ failed: h.simulator.eventbridge.deliveryDiagnostics().failed, lambdaAccepted }),
    outcome => outcome.failed >= 1 && outcome.lambdaAccepted >= 1,
    h,
  );
  assert.equal(lambdaAccepted, 1, "a terminal queue authorization error does not roll back another target");
  assert.equal((await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: queue.url }))).Messages?.length ?? 0, 0, "a policy removed after ingestion is honored by the queued attempt");
});

test("missing targets go directly to a Standard SQS DLQ with the original event and AWS delivery attributes", async () => {
  const h = await harness();
  const sourceRule = ruleArn("missing-to-dlq");
  const target = await createQueue(h, "deleted-target");
  const dlq = await createQueue(h, "eventbridge-dlq");
  await allowRuleToSend(h, target, sourceRule);
  await allowRuleToSend(h, dlq, sourceRule);
  await h.events.send(new PutRuleCommand({ Name: "missing-to-dlq", EventPattern: JSON.stringify({ source: ["dlq.direct"] }) }));
  assert.equal((await h.events.send(new PutTargetsCommand({ Rule: "missing-to-dlq", Targets: [{ Id: "queue", Arn: target.arn, Input: JSON.stringify({ transformed: true }), DeadLetterConfig: { Arn: dlq.arn }, RetryPolicy: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 5 } }] }))).FailedEntryCount, 0);
  await h.sqs.send(new DeleteQueueCommand({ QueueUrl: target.url }));

  await h.events.send(new PutEventsCommand({ Entries: [{ Source: "dlq.direct", DetailType: "Missing target", Detail: JSON.stringify({ secret: "original-event" }) }] }));
  const deadLetter = await receiveOne(h, dlq.url);
  const original = JSON.parse(deadLetter.Body!);
  assert.equal(original.source, "dlq.direct");
  assert.equal(original["detail-type"], "Missing target");
  assert.deepEqual(original.detail, { secret: "original-event" });
  assert.notDeepEqual(original, { transformed: true }, "the DLQ body is the original EventBridge event, not the target transformation");
  const attributes = deadLetter.MessageAttributes!;
  assert.equal(attributes.RULE_ARN?.StringValue, sourceRule);
  assert.equal(attributes.TARGET_ARN?.StringValue, target.arn);
  assert.equal(attributes.ERROR_CODE?.StringValue, "NO_RESOURCE");
  assert.match(attributes.ERROR_MESSAGE?.StringValue ?? "", /queue|resource|exist/i);
  assert.equal(attributes.RETRY_ATTEMPTS?.StringValue, "0");
  assert.ok(attributes.EXHAUSTED_RETRY_CONDITION?.StringValue);
});

test("API Gateway 5xx responses exhaust retries before DLQ and emit only documented AWS/Events dimensions", async () => {
  const h = await harness();
  const bus = "api-retry-bus";
  await h.events.send(new CreateEventBusCommand({ Name: bus }));
  const sourceRule = ruleArn("api-retry", bus);
  await h.events.send(new PutRuleCommand({ Name: "api-retry", EventBusName: bus, EventPattern: JSON.stringify({ source: ["api.retry"] }) }));
  const dlq = await createQueue(h, "api-retry-dlq");
  await allowRuleToSend(h, dlq, sourceRule);
  const backend = await createHttpBackend(503);
  const apiArn = await deployEventBridgeApi(h, sourceRule, backend.origin);
  await h.events.send(new PutTargetsCommand({ Rule: "api-retry", EventBusName: bus, Targets: [{ Id: "api", Arn: apiArn, DeadLetterConfig: { Arn: dlq.arn }, RetryPolicy: { MaximumEventAgeInSeconds: 300, MaximumRetryAttempts: 2 }, HttpParameters: { PathParameterValues: ["fixed"] } }] }));
  await h.events.send(new PutEventsCommand({ Entries: [{ Source: "api.retry", DetailType: "Retry", Detail: "{}", EventBusName: bus }] }));

  for (let expectedAttempts = 1; expectedAttempts <= 3; expectedAttempts++) {
    await waitFor(() => backend.requests.length, count => count >= expectedAttempts, h);
    if (expectedAttempts < 3) {
      const activeDelivery = await waitFor(
        () => h.simulator.eventbridge.deliveryDiagnostics().deliveries[0],
        delivery => delivery?.status === "QUEUED" && delivery.attempts >= expectedAttempts,
        h,
      );
      h.clock.advance(Math.max(0, activeDelivery.nextAttemptAt - h.clock.now()));
    }
  }
  const deadLetter = await receiveOne(h, dlq.url);
  assert.equal(backend.requests.length, 3, "MaximumRetryAttempts counts retries after the initial attempt");
  assert.equal(deadLetter.MessageAttributes?.RETRY_ATTEMPTS?.StringValue, "2");
  assert.equal(deadLetter.MessageAttributes?.EXHAUSTED_RETRY_CONDITION?.StringValue, "MaximumRetryAttempts");
  const exhaustedState = await waitFor(
    () => h.simulator.eventbridge.deliveryDiagnostics(),
    state => state.diagnostics.some((item: any) => item.ruleName === "api-retry" && item.status === "FAILED"),
    h,
  );
  const exhaustedDiagnostic = exhaustedState.diagnostics.find((item: any) => item.ruleName === "api-retry" && item.status === "FAILED");
  assert.equal(exhaustedDiagnostic?.attempts, 3);
  assert.equal(exhaustedDiagnostic?.retries, 2, "terminal diagnostics retain all completed retry attempts");
  assert.equal(exhaustedState.targets.find((item: any) => item.ruleName === "api-retry" && item.targetId === "api")?.retries, 2, "per-target summaries retain retries after terminal failure");
  await h.sqs.send(new DeleteMessageCommand({ QueueUrl: dlq.url, ReceiptHandle: deadLetter.ReceiptHandle! }));

  backend.setStatus(400);
  await h.events.send(new PutEventsCommand({ Entries: [{ Source: "api.retry", DetailType: "No retry", Detail: JSON.stringify({ response: 400 }), EventBusName: bus }] }));
  const clientError = await receiveOne(h, dlq.url);
  assert.equal(clientError.MessageAttributes?.RETRY_ATTEMPTS?.StringValue, "0");
  h.clock.advance(300_000);
  await tick();
  assert.equal(backend.requests.length, 4, "API Gateway responses other than 429 and 5xx are not retried");

  const metrics = await h.cloudwatch.send(new ListMetricsCommand({ Namespace: "AWS/Events" }));
  const dlqMetrics = metrics.Metrics?.filter(metric => ["InvocationsSentToDlq", "InvocationsFailedToBeSentToDlq"].includes(metric.MetricName ?? "")) ?? [];
  assert.ok(dlqMetrics.some(metric => metric.MetricName === "InvocationsSentToDlq"));
  assert.deepEqual(dlqMetrics.map(metric => metric.Dimensions), [[{ Name: "RuleName", Value: "api-retry" }]], "DLQ metrics use only the documented RuleName dimension, even for a custom bus");
});

test("Lambda async success destinations publish the documented invocation record through the real event bus", async () => {
  const h = await harness();
  const bus = "lambda-results";
  const busArn = `arn:aws:events:${region}:${account}:event-bus/${bus}`;
  await h.events.send(new CreateEventBusCommand({ Name: bus }));
  const sourceRule = ruleArn("lambda-success", bus);
  await h.events.send(new PutRuleCommand({ Name: "lambda-success", EventBusName: bus, EventPattern: JSON.stringify({ source: ["lambda"], "detail-type": ["Lambda Function Invocation Result - Success"] }) }));
  const queue = await createQueue(h, "lambda-result-events");
  await allowRuleToSend(h, queue, sourceRule);
  await h.events.send(new PutTargetsCommand({ Rule: "lambda-success", EventBusName: bus, Targets: [{ Id: "queue", Arn: queue.arn }] }));

  const role = await h.iam.send(new CreateRoleCommand({ RoleName: "lambda-eventbridge-publisher", AssumeRolePolicyDocument: document([{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }]) }));
  await h.iam.send(new PutRolePolicyCommand({ RoleName: "lambda-eventbridge-publisher", PolicyName: "events", PolicyDocument: document([{ Effect: "Allow", Action: "events:PutEvents", Resource: busArn }]) }));
  const zip = createZip([{ name: "index.mjs", content: "export async function handler(event) { return { received: event.id }; }" }]);
  const fn = await h.lambda.send(new CreateFunctionCommand({ FunctionName: "async-eventbridge-source", Runtime: "nodejs22.x", Role: role.Role!.Arn!, Handler: "index.handler", Code: { ZipFile: zip } }));
  await tick();
  await h.lambda.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: "async-eventbridge-source", MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60, DestinationConfig: { OnSuccess: { Destination: busArn } } }));
  const invoked = await h.lambda.send(new InvokeCommand({ FunctionName: "async-eventbridge-source", InvocationType: InvocationType.Event, Payload: Buffer.from(JSON.stringify({ id: "request-1" })) }));
  assert.equal(invoked.StatusCode, 202);

  const message = await receiveOne(h, queue.url);
  const event = JSON.parse(message.Body!);
  assert.equal(event.source, "lambda");
  assert.equal(event["detail-type"], "Lambda Function Invocation Result - Success");
  assert.deepEqual(event.resources, [`${fn.FunctionArn}:$LATEST`, busArn]);
  assert.equal(event.detail.version, "1.0");
  assert.equal(event.detail.requestContext.functionArn, `${fn.FunctionArn}:$LATEST`);
  assert.equal(event.detail.requestContext.condition, "Success");
  assert.equal(event.detail.requestContext.approximateInvokeCount, 1);
  assert.deepEqual(event.detail.requestPayload, { id: "request-1" });
  assert.deepEqual(event.detail.responsePayload, { received: "request-1" });
});

test("CloudWatch publishes alarm configuration and state changes to the default bus with current native envelopes", async () => {
  const h = await harness();
  const sourceRule = ruleArn("cloudwatch-events");
  const queue = await createQueue(h, "cloudwatch-events");
  await allowRuleToSend(h, queue, sourceRule);
  await h.events.send(new PutRuleCommand({ Name: "cloudwatch-events", EventPattern: JSON.stringify({ source: ["aws.cloudwatch"], "detail-type": ["CloudWatch Alarm Configuration Change", "CloudWatch Alarm State Change"] }) }));
  await h.events.send(new PutTargetsCommand({ Rule: "cloudwatch-events", Targets: [{ Id: "queue", Arn: queue.arn }] }));

  await h.cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "orders-high", AlarmDescription: "Order failures", Namespace: "Learning/Orders", MetricName: "Failures", Dimensions: [{ Name: "Service", Value: "checkout" }], Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "notBreaching" }));
  const configuredMessage = await receiveOne(h, queue.url);
  const configured = JSON.parse(configuredMessage.Body!);
  assert.equal(configured.source, "aws.cloudwatch");
  assert.equal(configured["detail-type"], "CloudWatch Alarm Configuration Change");
  assert.deepEqual(configured.resources, [`arn:aws:cloudwatch:${region}:${account}:alarm:orders-high`]);
  assert.equal(configured.detail.alarmName, "orders-high");
  assert.equal(configured.detail.operation, "create");
  assert.equal(configured.detail.state.value, "INSUFFICIENT_DATA");
  assert.equal(configured.detail.configuration.metrics[0].metricStat.metric.namespace, "Learning/Orders");
  assert.deepEqual(configured.detail.configuration.metrics[0].metricStat.metric.dimensions, { Service: "checkout" });
  await h.sqs.send(new DeleteMessageCommand({ QueueUrl: queue.url, ReceiptHandle: configuredMessage.ReceiptHandle! }));

  h.clock.advance(1_000);
  await h.cloudwatch.send(new SetAlarmStateCommand({ AlarmName: "orders-high", StateValue: "ALARM", StateReason: "manual transition", StateReasonData: JSON.stringify({ source: "test" }) }));
  const stateMessage = await receiveOne(h, queue.url);
  const changed = JSON.parse(stateMessage.Body!);
  assert.equal(changed["detail-type"], "CloudWatch Alarm State Change");
  assert.equal(changed.detail.alarmName, "orders-high");
  assert.equal(changed.detail.previousState.value, "INSUFFICIENT_DATA");
  assert.equal(changed.detail.state.value, "ALARM");
  assert.equal(changed.detail.state.reason, "manual transition");
  assert.deepEqual(JSON.parse(changed.detail.state.reasonData), { source: "test" });
});

test("CloudWatch retries failed EventBridge publication with persisted backoff and FIFO payload identity", async () => {
  const h = await harness();
  const published: Array<Parameters<Parameters<typeof h.simulator.metrics.setEventPublisher>[0]>[0]> = [];
  h.simulator.metrics.setEventPublisher(async event => {
    published.push(structuredClone(event));
    if (published.length === 1) throw new Error("EventBridge is temporarily unavailable");
  });

  await h.cloudwatch.send(new PutMetricAlarmCommand({
    AlarmName: "retry-publication",
    Namespace: "Learning/Durable",
    MetricName: "Retries",
    Period: 60,
    Statistic: "Sum",
    EvaluationPeriods: 1,
    Threshold: 1,
    ComparisonOperator: "GreaterThanThreshold",
    TreatMissingData: "notBreaching",
  }));

  const pending = h.simulator.store.regionState(region).cloudwatch.eventBridgeOutbox;
  assert.equal(published.length, 1);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempts, 1);
  assert.equal(pending[0].nextAttemptAt, fixedTime + 1_000);

  h.clock.advance(999);
  await tick();
  assert.equal(published.length, 1, "the persisted retry does not run before its backoff expires");
  h.clock.advance(1);
  await waitFor(() => h.simulator.store.regionState(region).cloudwatch.eventBridgeOutbox.length, length => length === 0, h);
  assert.equal(published.length, 2);
  assert.deepEqual(published[1], published[0]);
  await h.simulator.store.flush();
  const persisted = JSON.parse(await readFile(h.simulator.store.file, "utf8"));
  assert.deepEqual(persisted.accounts[account].regions[region].cloudwatch.eventBridgeOutbox, []);

  h.clock.advance(1_000);
  await tick();
  assert.equal(published.length, 2, "a successful retry cancels further publication attempts");
});

test("CloudWatch durably resumes failed EventBridge publication from its persisted outbox after restart", async () => {
  const h = await harness();
  const sourceRule = ruleArn("cloudwatch-durable-events");
  const queue = await createQueue(h, "cloudwatch-durable-events");
  await allowRuleToSend(h, queue, sourceRule);
  await h.events.send(new PutRuleCommand({
    Name: "cloudwatch-durable-events",
    EventPattern: JSON.stringify({ source: ["aws.cloudwatch"], "detail-type": ["CloudWatch Alarm Configuration Change"] }),
  }));
  await h.events.send(new PutTargetsCommand({ Rule: "cloudwatch-durable-events", Targets: [{ Id: "queue", Arn: queue.arn }] }));

  h.simulator.metrics.setEventPublisher(async () => { throw new Error("EventBridge is temporarily unavailable"); });
  await h.cloudwatch.send(new PutMetricAlarmCommand({
    AlarmName: "durable-publication",
    Namespace: "Learning/Durable",
    MetricName: "Failures",
    Period: 60,
    Statistic: "Sum",
    EvaluationPeriods: 1,
    Threshold: 1,
    ComparisonOperator: "GreaterThanThreshold",
    TreatMissingData: "notBreaching",
  }));

  const pending = h.simulator.store.regionState(region).cloudwatch.eventBridgeOutbox;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempts, 1);
  assert.equal(pending[0].nextAttemptAt, fixedTime + 1_000);
  const persisted = JSON.parse(await readFile(h.simulator.store.file, "utf8"));
  assert.equal(persisted.accounts[account].regions[region].cloudwatch.eventBridgeOutbox.length, 1);

  await restart(h);
  h.clock.advance(1_000);
  const message = await receiveOne(h, queue.url);
  const event = JSON.parse(message.Body!);
  assert.equal(event.source, "aws.cloudwatch");
  assert.equal(event["detail-type"], "CloudWatch Alarm Configuration Change");
  assert.equal(event.detail.alarmName, "durable-publication");
  await waitFor(
    () => h.simulator.store.regionState(region).cloudwatch.eventBridgeOutbox.length,
    length => length === 0,
    h,
  );
  await h.simulator.store.flush();
  const drained = JSON.parse(await readFile(h.simulator.store.file, "utf8"));
  assert.deepEqual(drained.accounts[account].regions[region].cloudwatch.eventBridgeOutbox, []);
});

test("CloudWatch composite alarm events include suppression and active mute-window details", async () => {
  const h = await harness();
  const alarmName = "checkout-composite";
  const sourceRule = ruleArn("cloudwatch-composite-events");
  const queue = await createQueue(h, "cloudwatch-composite-events");
  await allowRuleToSend(h, queue, sourceRule);
  await h.events.send(new PutRuleCommand({
    Name: "cloudwatch-composite-events",
    EventPattern: JSON.stringify({
      source: ["aws.cloudwatch"],
      "detail-type": ["CloudWatch Alarm Configuration Change", "CloudWatch Alarm State Change"],
      detail: { alarmName: [alarmName] },
    }),
  }));
  await h.events.send(new PutTargetsCommand({ Rule: "cloudwatch-composite-events", Targets: [{ Id: "queue", Arn: queue.arn }] }));

  const metricAlarm = (name: string) => new PutMetricAlarmCommand({ AlarmName: name, Namespace: "Learning/Checkout", MetricName: name, Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "notBreaching" });
  await h.cloudwatch.send(metricAlarm("checkout-child"));
  await h.cloudwatch.send(metricAlarm("checkout-suppressor"));
  await h.cloudwatch.send(new SetAlarmStateCommand({ AlarmName: "checkout-child", StateValue: "OK", StateReason: "initial child state" }));
  await h.cloudwatch.send(new SetAlarmStateCommand({ AlarmName: "checkout-suppressor", StateValue: "OK", StateReason: "initial suppressor state" }));

  const compositeInput = {
    AlarmName: alarmName,
    AlarmRule: "ALARM(checkout-child)",
    AlarmActions: [`arn:aws:sns:${region}:${account}:checkout-alerts`],
    ActionsSuppressor: "checkout-suppressor",
    ActionsSuppressorWaitPeriod: 300,
    ActionsSuppressorExtensionPeriod: 60,
  };
  await h.cloudwatch.send(new PutCompositeAlarmCommand(compositeInput));

  const bufferedEvents = new Map<string, any[]>();
  const receiveAlarmEvent = async (detailType: string): Promise<any> => {
    const buffered = bufferedEvents.get(detailType)?.shift();
    if (buffered) return buffered;
    for (;;) {
      const message = await receiveOne(h, queue.url);
      const event = JSON.parse(message.Body!);
      await h.sqs.send(new DeleteMessageCommand({ QueueUrl: queue.url, ReceiptHandle: message.ReceiptHandle! }));
      if (event["detail-type"] === detailType) return event;
      const pending = bufferedEvents.get(event["detail-type"]) ?? [];
      pending.push(event);
      bufferedEvents.set(event["detail-type"], pending);
    }
  };
  await receiveAlarmEvent("CloudWatch Alarm Configuration Change");
  await receiveAlarmEvent("CloudWatch Alarm State Change");

  await h.cloudwatch.send(new PutAlarmMuteRuleCommand({
    Name: "checkout-maintenance",
    Rule: { Schedule: { Expression: "at(2026-07-20T11:59)", Duration: "PT10M", Timezone: "UTC" } },
    MuteTargets: { AlarmNames: [alarmName] },
  }));
  await h.cloudwatch.send(new SetAlarmStateCommand({ AlarmName: "checkout-child", StateValue: "ALARM", StateReason: "checkout failed" }));

  const stateChanged = await receiveAlarmEvent("CloudWatch Alarm State Change");
  assert.equal(stateChanged.detail.state.actionsSuppressedBy, "WaitPeriod");
  assert.match(stateChanged.detail.state.actionsSuppressedReason, /checkout-suppressor/);
  assert.deepEqual(stateChanged.detail.muteDetail, {
    mutedByArn: `arn:aws:cloudwatch:${region}:${account}:alarm-mute-rule:checkout-maintenance`,
    muteWindowStart: "2026-07-20T11:59:00.000Z",
    muteWindowEnd: "2026-07-20T12:09:00.000Z",
  });

  await h.cloudwatch.send(new PutCompositeAlarmCommand({ ...compositeInput, AlarmDescription: "updated while suppressed" }));
  const configurationChanged = await receiveAlarmEvent("CloudWatch Alarm Configuration Change");
  assert.equal(configurationChanged.detail.operation, "update");
  assert.equal(configurationChanged.detail.state.actionsSuppressedBy, "WaitPeriod");
  assert.deepEqual(configurationChanged.detail.muteDetail, stateChanged.detail.muteDetail);
});

test("CloudWatch service-event lineage terminates repeated and maximum-depth publication chains", async () => {
  const h = await harness();
  const alarmName = "lineage-guard";
  const alarmArn = `arn:aws:cloudwatch:${region}:${account}:alarm:${alarmName}`;
  await h.cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: alarmName, Namespace: "Learning/Lineage", MetricName: "Depth", Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "notBreaching" }));

  const originalPublisher = h.simulator.eventbridge.publishServiceEvent.bind(h.simulator.eventbridge);
  let published = 0;
  (h.simulator.eventbridge as any).publishServiceEvent = async () => { published++; return { EventId: "unexpected" }; };
  try {
    await h.simulator.metrics.alarms.SetAlarmState({ AlarmName: alarmName, StateValue: "ALARM", StateReason: "repeated lineage" }, [alarmArn]);
    await h.simulator.metrics.alarms.SetAlarmState({ AlarmName: alarmName, StateValue: "OK", StateReason: "maximum lineage" }, Array.from({ length: 31 }, (_, index) => `arn:aws:events:${region}:${account}:rule/lineage-${index}`));
  } finally {
    (h.simulator.eventbridge as any).publishServiceEvent = originalPublisher;
  }
  assert.equal(published, 0, "the service publisher stops repeated resources and chains that reach the 32-hop bound");

  const registryContext = (h.simulator.apigateway as any).registryContext("dynamodb", "PutItem", {
    requestId: "eventbridge-api-request",
    lambdaLineage: Array.from({ length: 34 }, (_, index) => `lineage-${index}`),
  });
  assert.deepEqual(registryContext.deliveryLineage, Array.from({ length: 32 }, (_, index) => `lineage-${index + 2}`), "API Gateway retains bounded EventBridge delivery lineage for service-registry handoffs");
});
