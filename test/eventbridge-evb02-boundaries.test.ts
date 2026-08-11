import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
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
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DeleteResourcePolicyCommand,
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
  GetFunctionConfigurationCommand,
  InvocationType,
  InvokeCommand,
  LambdaClient,
  PutFunctionEventInvokeConfigCommand,
} from "@aws-sdk/client-lambda";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";
import { waitUntil } from "./support/polling.js";

const region = "eu-west-1";
const otherRegion = "us-east-1";
const account = "000000000000";
const destinationAccount = "111122223333";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const fixedTime = Date.parse("2026-07-20T12:00:00.000Z");

interface QueueSeed {
  accountId: string;
  regionName: string;
  queues: Array<{ name: string; attributes?: Record<string, string> }>;
}

interface QueueRef {
  name: string;
  arn: string;
  ownerAccountId: string;
}

interface Harness {
  root: string;
  simulator: StackSim;
  endpoint: string;
  clock: TestClock;
  clients: Array<{ destroy(): void }>;
  events: EventBridgeClient;
  sqs: SQSClient;
  logs: CloudWatchLogsClient;
  apigateway: APIGatewayClient;
  lambda: LambdaClient;
  cloudwatch: CloudWatchClient;
  iam: IAMClient;
}

const active: Harness[] = [];
const servers: Server[] = [];
const originalOutbound = process.env.STACKSIM_ALLOW_OUTBOUND_HTTP;
const originalPrivate = process.env.STACKSIM_ALLOW_PRIVATE_HTTP;

function document(statements: unknown[]): string {
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

function queueArn(name: string, ownerAccountId = account, regionName = region): string {
  return `arn:aws:sqs:${regionName}:${ownerAccountId}:${name}`;
}

function ruleArn(name: string, bus = "default"): string {
  return `arn:aws:events:${region}:${account}:rule/${bus === "default" ? "" : `${bus}/`}${name}`;
}

function queueRef(name: string, ownerAccountId = account, regionName = region): QueueRef {
  return { name, ownerAccountId, arn: queueArn(name, ownerAccountId, regionName) };
}

function queueUrl(h: Harness, queue: QueueRef): string {
  return `${h.endpoint}/${queue.ownerAccountId}/${encodeURIComponent(queue.name)}`;
}

function eventBridgeQueuePolicy(arn: string, sourceRuleArn: string): string {
  return document([{
    Sid: "AllowEventBridge",
    Effect: "Allow",
    Principal: { Service: "events.amazonaws.com" },
    Action: "sqs:SendMessage",
    Resource: arn,
    Condition: {
      ArnEquals: { "aws:SourceArn": sourceRuleArn },
      StringEquals: { "aws:SourceAccount": account },
    },
  }]);
}

function roleQueuePolicy(arn: string, roleArn: string, sourceRuleArn: string): string {
  return document([{
    Sid: "AllowSourceAccountTargetRole",
    Effect: "Allow",
    Principal: { AWS: roleArn },
    Action: "sqs:SendMessage",
    Resource: arn,
    Condition: {
      ArnEquals: { "aws:SourceArn": sourceRuleArn },
      StringEquals: { "aws:SourceAccount": account },
    },
  }]);
}

function attachClients(h: Harness): void {
  const options = { endpoint: h.endpoint, region, credentials };
  h.events = new EventBridgeClient(options);
  h.sqs = new SQSClient(options);
  h.logs = new CloudWatchLogsClient(options);
  h.apigateway = new APIGatewayClient(options);
  h.lambda = new LambdaClient(options);
  h.cloudwatch = new CloudWatchClient(options);
  h.iam = new IAMClient(options);
  h.clients.push(h.events, h.sqs, h.logs, h.apigateway, h.lambda, h.cloudwatch, h.iam);
}

async function seedQueues(root: string, clock: TestClock, seed: QueueSeed): Promise<void> {
  const seedCredentials = seed.accountId === account
    ? credentials
    : { accessKeyId: `admin-${seed.accountId}`, secretAccessKey: `password-${seed.accountId}` };
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    accountId: seed.accountId,
    region: seed.regionName,
    clock,
    authMode: "off",
    cdkBootstrap: false,
    defaultAccessKeyId: seedCredentials.accessKeyId,
    defaultSecretAccessKey: seedCredentials.secretAccessKey,
  });
  let client: SQSClient | undefined;
  try {
    await simulator.start();
    client = new SQSClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region: seed.regionName,
      credentials: seedCredentials,
    });
    for (const queue of seed.queues) {
      await client.send(new CreateQueueCommand({ QueueName: queue.name, Attributes: queue.attributes }));
    }
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
  }
}

async function harness(seeds: QueueSeed[] = []): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "stacksim-eventbridge-evb02-boundaries-"));
  const clock = new TestClock(fixedTime);
  try {
    for (const seed of seeds) await seedQueues(root, clock, seed);
    const simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      accountId: account,
      region,
      clock,
      authMode: "off",
      cdkBootstrap: true,
    });
    await simulator.start();
    const h = {
      root,
      simulator,
      endpoint: `http://127.0.0.1:${simulator.port}`,
      clock,
      clients: [],
    } as unknown as Harness;
    attachClients(h);
    active.push(h);
    return h;
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    throw error;
  }
}

async function restart(h: Harness): Promise<void> {
  for (const client of h.clients.splice(0)) client.destroy();
  await h.simulator.stop();
  h.simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: h.root,
    accountId: account,
    region,
    clock: h.clock,
    authMode: "off",
    cdkBootstrap: true,
  });
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
  if (originalOutbound === undefined) delete process.env.STACKSIM_ALLOW_OUTBOUND_HTTP;
  else process.env.STACKSIM_ALLOW_OUTBOUND_HTTP = originalOutbound;
  if (originalPrivate === undefined) delete process.env.STACKSIM_ALLOW_PRIVATE_HTTP;
  else process.env.STACKSIM_ALLOW_PRIVATE_HTTP = originalPrivate;
  while (active.length) {
    const h = active.pop()!;
    for (const client of h.clients) client.destroy();
    await h.simulator.stop().catch(() => undefined);
    await rm(h.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, h?: Harness, timeoutMs = 30_000): Promise<T> {
  return waitUntil(
    async () => {
      h?.clock.advance(0);
      await tick();
      return read();
    },
    accept,
    { timeoutMs, intervalMs: 5, timeoutMessage: "Timed out waiting for an EVB-02 boundary condition" },
  );
}

async function createQueue(h: Harness, name: string, attributes: Record<string, string> = {}): Promise<QueueRef> {
  const queue = queueRef(name);
  await h.sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  return queue;
}

async function allowRuleToSend(h: Harness, queue: QueueRef, sourceRuleArn: string): Promise<void> {
  await h.sqs.send(new SetQueueAttributesCommand({
    QueueUrl: queueUrl(h, queue),
    Attributes: { Policy: eventBridgeQueuePolicy(queue.arn, sourceRuleArn) },
  }));
}

async function receiveOne(h: Harness, queue: QueueRef, timeoutMs = 10_000): Promise<Message> {
  const message = await waitFor(
    async () => (await h.sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl(h, queue),
      AttributeNames: ["All"],
      MessageAttributeNames: ["All"],
    }))).Messages?.[0],
    value => Boolean(value),
    h,
    timeoutMs,
  );
  return message!;
}

interface ScriptedResponse {
  status: number;
  delayMs?: number;
}

async function scriptedBackend(responses: ScriptedResponse[]): Promise<{ origin: string; requests: Array<{ path: string; body: string; response: ScriptedResponse }> }> {
  const requests: Array<{ path: string; body: string; response: ScriptedResponse }> = [];
  let index = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const response = responses[Math.min(index++, responses.length - 1)];
    requests.push({ path: req.url ?? "/", body: Buffer.concat(chunks).toString("utf8"), response });
    if (response.delayMs) await new Promise(resolve => setTimeout(resolve, response.delayMs));
    res.statusCode = response.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ accepted: response.status < 400 }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP backend did not bind a TCP port");
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}

async function deployEventBridgeApi(h: Harness, sourceRuleArn: string, backendOrigin: string, integrationTimeoutInMillis = 50): Promise<string> {
  process.env.STACKSIM_ALLOW_OUTBOUND_HTTP = "true";
  process.env.STACKSIM_ALLOW_PRIVATE_HTTP = "true";
  const api = await h.apigateway.send(new CreateRestApiCommand({
    name: "eventbridge-boundary-target",
    policy: document([{
      Effect: "Allow",
      Principal: { Service: "events.amazonaws.com" },
      Action: "execute-api:Invoke",
      Resource: "execute-api:/*",
      Condition: {
        ArnEquals: { "aws:SourceArn": sourceRuleArn },
        StringEquals: { "aws:SourceAccount": account },
      },
    }]),
  }));
  const root = (await h.apigateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!;
  const capture = await h.apigateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: root.id!, pathPart: "capture" }));
  await h.apigateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: capture.id!, httpMethod: "POST", authorizationType: "NONE" }));
  await h.apigateway.send(new PutIntegrationCommand({
    restApiId: api.id!,
    resourceId: capture.id!,
    httpMethod: "POST",
    type: "HTTP_PROXY",
    integrationHttpMethod: "POST",
    uri: `${backendOrigin}/capture`,
    timeoutInMillis: integrationTimeoutInMillis,
  }));
  await h.apigateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
  return `arn:aws:execute-api:${region}:${account}:${api.id}/dev/POST/capture`;
}

test("configured cross-account SQS target requires its source role and destination policy, while its DLQ uses the EventBridge service policy", async () => {
  const ruleName = "cross-account-queue";
  const sourceRuleArn = ruleArn(ruleName);
  const roleName = "eventbridge-cross-account-target";
  const roleArn = `arn:aws:iam::${account}:role/${roleName}`;
  const target = queueRef("cross-account-target", destinationAccount);
  const dlq = queueRef("cross-account-dlq", destinationAccount);
  const h = await harness([{
    accountId: destinationAccount,
    regionName: region,
    queues: [
      { name: target.name, attributes: { Policy: roleQueuePolicy(target.arn, roleArn, sourceRuleArn) } },
      { name: dlq.name, attributes: { Policy: eventBridgeQueuePolicy(dlq.arn, sourceRuleArn) } },
    ],
  }]);

  await h.events.send(new PutRuleCommand({ Name: ruleName, EventPattern: JSON.stringify({ source: ["cross.account"] }) }));
  const role = await h.iam.send(new CreateRoleCommand({
    RoleName: roleName,
    AssumeRolePolicyDocument: document([{
      Effect: "Allow",
      Principal: { Service: "events.amazonaws.com" },
      Action: "sts:AssumeRole",
      Condition: {
        ArnEquals: { "aws:SourceArn": sourceRuleArn },
        StringEquals: { "aws:SourceAccount": account },
      },
    }]),
  }));
  assert.equal(role.Role?.Arn, roleArn);
  await h.iam.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: "send-cross-account",
    PolicyDocument: document([{
      Effect: "Allow",
      Action: "sqs:SendMessage",
      Resource: target.arn,
      Condition: {
        ArnEquals: { "aws:SourceArn": sourceRuleArn },
        StringEquals: { "aws:SourceAccount": account, "aws:RequestedRegion": region },
      },
    }]),
  }));

  const missingRole = await h.events.send(new PutTargetsCommand({
    Rule: ruleName,
    Targets: [{ Id: "queue", Arn: target.arn, DeadLetterConfig: { Arn: dlq.arn } }],
  }));
  assert.equal(missingRole.FailedEntryCount, 1);
  assert.equal(missingRole.FailedEntries?.[0].ErrorCode, "ValidationException");
  assert.match(missingRole.FailedEntries?.[0].ErrorMessage ?? "", /cross-account.*RoleArn/i);

  const configured = await h.events.send(new PutTargetsCommand({
    Rule: ruleName,
    Targets: [{
      Id: "queue",
      Arn: target.arn,
      RoleArn: roleArn,
      DeadLetterConfig: { Arn: dlq.arn },
      RetryPolicy: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 2 },
    }],
  }));
  assert.equal(configured.FailedEntryCount, 0);

  await h.events.send(new PutEventsCommand({
    Entries: [{ Source: "cross.account", DetailType: "Allowed", Detail: JSON.stringify({ id: "allowed" }) }],
  }));
  const delivered = await receiveOne(h, target);
  assert.equal(JSON.parse(delivered.Body!).detail.id, "allowed");
  await h.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl(h, target), ReceiptHandle: delivered.ReceiptHandle! }));

  await h.sqs.send(new SetQueueAttributesCommand({ QueueUrl: queueUrl(h, target), Attributes: { Policy: "" } }));
  await h.events.send(new PutEventsCommand({
    Entries: [{ Source: "cross.account", DetailType: "Denied", Detail: JSON.stringify({ id: "to-dlq" }) }],
  }));
  const deadLetter = await receiveOne(h, dlq);
  assert.equal(JSON.parse(deadLetter.Body!).detail.id, "to-dlq");
  assert.equal(deadLetter.MessageAttributes?.RULE_ARN?.StringValue, sourceRuleArn);
  assert.equal(deadLetter.MessageAttributes?.TARGET_ARN?.StringValue, target.arn);
  assert.equal(deadLetter.MessageAttributes?.ERROR_CODE?.StringValue, "NO_PERMISSIONS");
  assert.equal(deadLetter.MessageAttributes?.RETRY_ATTEMPTS?.StringValue, "0");
});

test("PutRule.RoleArn remains an explicit EVB-06 cross-account event-bus-target dependency", async () => {
  const h = await harness();
  await assert.rejects(
    h.events.send(new PutRuleCommand({
      Name: "rule-level-role",
      EventPattern: JSON.stringify({ source: ["rule.role"] }),
      RoleArn: `arn:aws:iam::${account}:role/eventbridge-rule-role`,
    })),
    /PutRule\.RoleArn.*EVB-06/i,
  );
});

test("configured cross-account fair and FIFO targets preserve their message groups through the destination-account queue service", async () => {
  const ruleName = "cross-account-grouped-queues";
  const sourceRuleArn = ruleArn(ruleName);
  const roleName = "eventbridge-cross-account-grouped-targets";
  const roleArn = `arn:aws:iam::${account}:role/${roleName}`;
  const fair = queueRef("cross-account-fair", destinationAccount);
  const fifo = queueRef("cross-account-fifo.fifo", destinationAccount);
  const h = await harness([{
    accountId: destinationAccount,
    regionName: region,
    queues: [
      { name: fair.name, attributes: { Policy: roleQueuePolicy(fair.arn, roleArn, sourceRuleArn) } },
      { name: fifo.name, attributes: { FifoQueue: "true", ContentBasedDeduplication: "true", Policy: roleQueuePolicy(fifo.arn, roleArn, sourceRuleArn) } },
    ],
  }]);

  await h.events.send(new PutRuleCommand({ Name: ruleName, EventPattern: JSON.stringify({ source: ["cross.account.grouped"] }) }));
  await h.iam.send(new CreateRoleCommand({
    RoleName: roleName,
    AssumeRolePolicyDocument: document([{
      Effect: "Allow",
      Principal: { Service: "events.amazonaws.com" },
      Action: "sts:AssumeRole",
      Condition: {
        ArnEquals: { "aws:SourceArn": sourceRuleArn },
        StringEquals: { "aws:SourceAccount": account },
      },
    }]),
  }));
  await h.iam.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: "send-cross-account-grouped",
    PolicyDocument: document([{
      Effect: "Allow",
      Action: "sqs:SendMessage",
      Resource: [fair.arn, fifo.arn],
      Condition: {
        ArnEquals: { "aws:SourceArn": sourceRuleArn },
        StringEquals: { "aws:SourceAccount": account, "aws:RequestedRegion": region },
      },
    }]),
  }));

  const configured = await h.events.send(new PutTargetsCommand({
    Rule: ruleName,
    Targets: [
      { Id: "fair", Arn: fair.arn, RoleArn: roleArn, SqsParameters: { MessageGroupId: "tenant-fair" } },
      { Id: "fifo", Arn: fifo.arn, RoleArn: roleArn, SqsParameters: { MessageGroupId: "tenant-fifo" } },
    ],
  }));
  assert.equal(configured.FailedEntryCount, 0);

  await h.events.send(new PutEventsCommand({
    Entries: [{ Source: "cross.account.grouped", DetailType: "Grouped", Detail: JSON.stringify({ id: "grouped" }) }],
  }));
  const [fairMessage, fifoMessage] = await Promise.all([receiveOne(h, fair), receiveOne(h, fifo)]);
  assert.equal(JSON.parse(fairMessage.Body!).detail.id, "grouped");
  assert.equal(fairMessage.Attributes?.MessageGroupId, "tenant-fair");
  assert.equal(JSON.parse(fifoMessage.Body!).detail.id, "grouped");
  assert.equal(fifoMessage.Attributes?.MessageGroupId, "tenant-fifo");
  assert.match(fifoMessage.Attributes?.SequenceNumber ?? "", /^\d+$/);
});

test("configured cross-Region SQS targets and DLQs are rejected before target state is stored", async () => {
  const remoteTarget = queueRef("configured-remote-target", account, otherRegion);
  const remoteDlq = queueRef("configured-remote-dlq", account, otherRegion);
  const h = await harness([{
    accountId: account,
    regionName: otherRegion,
    queues: [{ name: remoteTarget.name }, { name: remoteDlq.name }],
  }]);
  assert.ok(h.simulator.store.regionState(otherRegion, account).sqsQueues[remoteTarget.name]);
  assert.ok(h.simulator.store.regionState(otherRegion, account).sqsQueues[remoteDlq.name]);

  const localTarget = await createQueue(h, "local-target-for-remote-dlq");
  await h.events.send(new PutRuleCommand({ Name: "cross-region-boundaries", EventPattern: JSON.stringify({ source: ["cross.region"] }) }));
  const result = await h.events.send(new PutTargetsCommand({
    Rule: "cross-region-boundaries",
    Targets: [
      { Id: "remote-target", Arn: remoteTarget.arn },
      { Id: "remote-dlq", Arn: localTarget.arn, DeadLetterConfig: { Arn: remoteDlq.arn } },
    ],
  }));

  assert.equal(result.FailedEntryCount, 2);
  assert.deepEqual(result.FailedEntries?.map(entry => entry.TargetId).sort(), ["remote-dlq", "remote-target"]);
  assert.equal(result.FailedEntries?.every(entry => entry.ErrorCode === "ValidationException"), true);
  assert.deepEqual((await h.events.send(new ListTargetsByRuleCommand({ Rule: "cross-region-boundaries" }))).Targets, []);
});

test("API Gateway 429 and timeout retries survive restart, then a committed DLQ handoff survives another restart", async () => {
  const h = await harness();
  const ruleName = "api-boundary-retries";
  const sourceRuleArn = ruleArn(ruleName);
  const dlq = await createQueue(h, "api-boundary-dlq");
  await allowRuleToSend(h, dlq, sourceRuleArn);
  await h.events.send(new PutRuleCommand({ Name: ruleName, EventPattern: JSON.stringify({ source: ["api.boundary"] }) }));
  const backend = await scriptedBackend([
    { status: 429 },
    { status: 202 },
    { status: 202, delayMs: 100 },
    { status: 503 },
  ]);
  const apiArn = await deployEventBridgeApi(h, sourceRuleArn, backend.origin);
  assert.equal((await h.events.send(new PutTargetsCommand({
    Rule: ruleName,
    Targets: [{
      Id: "api",
      Arn: apiArn,
      DeadLetterConfig: { Arn: dlq.arn },
      RetryPolicy: { MaximumEventAgeInSeconds: 300, MaximumRetryAttempts: 1 },
    }],
  }))).FailedEntryCount, 0);

  const throttled = await h.events.send(new PutEventsCommand({
    Entries: [{ Source: "api.boundary", DetailType: "429 then repair", Detail: JSON.stringify({ id: "throttled" }) }],
  }));
  const throttledEventId = throttled.Entries?.[0].EventId!;
  const throttledRetry = await waitFor(
    () => h.simulator.eventbridge.deliveryDiagnostics(),
    diagnostics => diagnostics.diagnostics.some((item: any) => item.eventId === throttledEventId && item.status === "RETRYING" && item.errorCode === "ThrottlingException"),
    h,
  );
  const throttledDelivery = throttledRetry.deliveries.find((item: any) => item.eventId === throttledEventId)!;
  h.clock.advance(Math.max(0, throttledDelivery.nextAttemptAt - h.clock.now()));
  await waitFor(
    () => h.simulator.eventbridge.deliveryDiagnostics().diagnostics,
    diagnostics => diagnostics.some((item: any) => item.eventId === throttledEventId && item.status === "SUCCEEDED" && item.attempts === 2),
    h,
  );
  assert.equal(backend.requests.length, 2);

  const timedOut = await h.events.send(new PutEventsCommand({
    Entries: [{ Source: "api.boundary", DetailType: "Timeout then DLQ", Detail: JSON.stringify({ id: "timed-out" }) }],
  }));
  const timedOutEventId = timedOut.Entries?.[0].EventId!;
  await waitFor(
    () => h.simulator.eventbridge.deliveryDiagnostics().diagnostics,
    diagnostics => diagnostics.some((item: any) => item.eventId === timedOutEventId && item.status === "RETRYING" && item.errorCode === "IntegrationFailureException"),
    h,
  );
  assert.equal(backend.requests.length, 3);

  await restart(h);
  const recovered = h.simulator.eventbridge.deliveryDiagnostics().deliveries.find((item: any) => item.eventId === timedOutEventId);
  assert.equal(recovered?.status, "QUEUED");
  assert.equal(recovered?.attempts, 1);
  h.clock.advance(Math.max(0, recovered.nextAttemptAt - h.clock.now()));
  await waitFor(
    () => h.simulator.eventbridge.deliveryDiagnostics().diagnostics,
    diagnostics => diagnostics.some((item: any) => item.eventId === timedOutEventId && item.status === "FAILED" && item.attempts === 2 && item.deadLetterStatus === "SENT"),
    h,
  );
  assert.equal(backend.requests.length, 4);

  await restart(h);
  const deadLetter = await receiveOne(h, dlq);
  assert.equal(JSON.parse(deadLetter.Body!).detail.id, "timed-out");
  assert.equal(deadLetter.MessageAttributes?.RETRY_ATTEMPTS?.StringValue, "1");
  assert.equal(deadLetter.MessageAttributes?.EXHAUSTED_RETRY_CONDITION?.StringValue, "MaximumRetryAttempts");
});

test("API Gateway delivery is cut off by the EventBridge five-second target timeout before the longer integration timeout", async () => {
  const h = await harness();
  const ruleName = "api-eventbridge-five-second-timeout";
  const sourceRuleArn = ruleArn(ruleName);
  await h.events.send(new PutRuleCommand({ Name: ruleName, EventPattern: JSON.stringify({ source: ["api.five-second-timeout"] }) }));
  const backend = await scriptedBackend([{ status: 202, delayMs: 5_500 }]);
  const apiArn = await deployEventBridgeApi(h, sourceRuleArn, backend.origin, 7_000);
  assert.equal((await h.events.send(new PutTargetsCommand({
    Rule: ruleName,
    Targets: [{
      Id: "api",
      Arn: apiArn,
      RetryPolicy: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 0 },
    }],
  }))).FailedEntryCount, 0);

  const submitted = await h.events.send(new PutEventsCommand({
    Entries: [{ Source: "api.five-second-timeout", DetailType: "Slow response", Detail: JSON.stringify({ id: "slow" }) }],
  }));
  const eventId = submitted.Entries?.[0].EventId!;
  const diagnostic = await waitFor(
    () => h.simulator.eventbridge.deliveryDiagnostics().diagnostics.find((item: any) => item.eventId === eventId),
    item => item?.status === "FAILED",
    h,
    30_000,
  );
  assert.equal(diagnostic?.attempts, 1);
  assert.equal(diagnostic?.errorCode, "IntegrationFailureException");
  assert.equal(backend.requests.length, 1);
  assert.equal(backend.requests[0].response.delayMs, 5_500, "the backend remains slower than EventBridge's wrapper but faster than API Gateway's configured seven-second integration timeout");
});

test("CloudWatch Logs policy revocation fails one delivery without retry and a repaired policy admits the next event", async () => {
  const h = await harness();
  const ruleName = "logs-policy-repair";
  const sourceRuleArn = ruleArn(ruleName);
  const groupName = "/aws/events/policy-repair";
  const groupArn = `arn:aws:logs:${region}:${account}:log-group:${groupName}`;
  const policyName = "eventbridge-logs-policy-repair";
  const policyDocument = document([{
    Effect: "Allow",
    Principal: { Service: "events.amazonaws.com" },
    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
    Resource: `${groupArn}:*`,
    Condition: {
      ArnEquals: { "aws:SourceArn": sourceRuleArn },
      StringEquals: { "aws:SourceAccount": account },
    },
  }]);

  await h.logs.send(new CreateLogGroupCommand({ logGroupName: groupName }));
  await h.logs.send(new PutResourcePolicyCommand({ policyName, policyDocument }));
  await h.events.send(new PutRuleCommand({ Name: ruleName, EventPattern: JSON.stringify({ source: ["logs.policy"] }) }));
  assert.equal((await h.events.send(new PutTargetsCommand({ Rule: ruleName, Targets: [{ Id: "logs", Arn: groupArn }] }))).FailedEntryCount, 0);

  await h.logs.send(new DeleteResourcePolicyCommand({ policyName }));
  const denied = await h.events.send(new PutEventsCommand({
    Entries: [{ Source: "logs.policy", DetailType: "Denied", Detail: JSON.stringify({ id: "denied" }) }],
  }));
  const deniedEventId = denied.Entries?.[0].EventId!;
  const deniedDiagnostic = await waitFor(
    () => h.simulator.eventbridge.deliveryDiagnostics().diagnostics.find((item: any) => item.eventId === deniedEventId),
    diagnostic => diagnostic?.status === "FAILED",
    h,
  );
  assert.equal(deniedDiagnostic?.errorCode, "AccessDeniedException");
  assert.equal(deniedDiagnostic?.attempts, 1, "a Logs resource-policy denial is not retryable");

  await h.logs.send(new PutResourcePolicyCommand({ policyName, policyDocument }));
  const repaired = await h.events.send(new PutEventsCommand({
    Entries: [{ Source: "logs.policy", DetailType: "Allowed", Detail: JSON.stringify({ id: "repaired" }) }],
  }));
  const repairedEventId = repaired.Entries?.[0].EventId!;
  await waitFor(
    () => h.simulator.eventbridge.deliveryDiagnostics().diagnostics,
    diagnostics => diagnostics.some((item: any) => item.eventId === repairedEventId && item.status === "SUCCEEDED"),
    h,
  );

  const streams = await h.logs.send(new DescribeLogStreamsCommand({ logGroupName: groupName }));
  assert.equal(streams.logStreams?.length, 1);
  const events = await h.logs.send(new GetLogEventsCommand({
    logGroupName: groupName,
    logStreamName: streams.logStreams![0].logStreamName!,
    startFromHead: true,
  }));
  assert.equal(events.events?.length, 1);
  assert.equal(JSON.parse(events.events![0].message!).detail.id, "repaired");
});

test("Lambda async success and failure destinations use the real EventBridge bus, including rejection and repair", async () => {
  const h = await harness();
  const busName = "lambda-rejected-destination";
  const busArn = `arn:aws:events:${region}:${account}:event-bus/${busName}`;
  const ruleName = "lambda-rejected-destination";
  const sourceRuleArn = ruleArn(ruleName, busName);
  await h.events.send(new CreateEventBusCommand({ Name: busName }));
  await h.events.send(new PutRuleCommand({
    Name: ruleName,
    EventBusName: busName,
    EventPattern: JSON.stringify({ source: ["lambda"], "detail-type": ["Lambda Function Invocation Result - Success", "Lambda Function Invocation Result - Failure"] }),
  }));
  const queue = await createQueue(h, "lambda-rejected-events");
  await allowRuleToSend(h, queue, sourceRuleArn);
  await h.events.send(new PutTargetsCommand({ Rule: ruleName, EventBusName: busName, Targets: [{ Id: "queue", Arn: queue.arn }] }));

  const roleName = "lambda-rejected-eventbridge-publisher";
  const role = await h.iam.send(new CreateRoleCommand({
    RoleName: roleName,
    AssumeRolePolicyDocument: document([{
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    }]),
  }));
  const zip = createZip([{
    name: "index.mjs",
    content: "export async function handler(event) { if (event.fail) throw new Error('expected failure'); return { received: event.id }; }",
  }]);
  await h.lambda.send(new CreateFunctionCommand({
    FunctionName: "lambda-rejected-eventbridge-source",
    Runtime: "nodejs22.x",
    Role: role.Role!.Arn!,
    Handler: "index.handler",
    Code: { ZipFile: zip },
  }));
  await waitFor(
    async () => (await h.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "lambda-rejected-eventbridge-source" }))).State,
    state => state === "Active",
    h,
  );
  await h.lambda.send(new PutFunctionEventInvokeConfigCommand({
    FunctionName: "lambda-rejected-eventbridge-source",
    MaximumRetryAttempts: 0,
    MaximumEventAgeInSeconds: 60,
    DestinationConfig: { OnSuccess: { Destination: busArn }, OnFailure: { Destination: busArn } },
  }));

  await h.lambda.send(new InvokeCommand({
    FunctionName: "lambda-rejected-eventbridge-source",
    InvocationType: InvocationType.Event,
    Payload: Buffer.from(JSON.stringify({ id: "denied" })),
  }));
  const destinationFailures = async (): Promise<number> => {
    const result = await h.cloudwatch.send(new GetMetricStatisticsCommand({
      Namespace: "AWS/Lambda",
      MetricName: "DestinationDeliveryFailures",
      Dimensions: [{ Name: "FunctionName", Value: "lambda-rejected-eventbridge-source" }],
      StartTime: new Date(h.clock.now() - 60_000),
      EndTime: new Date(h.clock.now() + 60_000),
      Period: 60,
      Statistics: ["Sum"],
    }));
    return result.Datapoints?.reduce((sum, point) => sum + (point.Sum ?? 0), 0) ?? 0;
  };
  assert.equal(await waitFor(destinationFailures, value => value === 1, h), 1);
  assert.equal((await h.sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl(h, queue) }))).Messages?.length ?? 0, 0);

  await h.iam.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: "publish-eventbridge-destination",
    PolicyDocument: document([{ Effect: "Allow", Action: "events:PutEvents", Resource: busArn }]),
  }));
  await h.lambda.send(new InvokeCommand({
    FunctionName: "lambda-rejected-eventbridge-source",
    InvocationType: InvocationType.Event,
    Payload: Buffer.from(JSON.stringify({ id: "repaired" })),
  }));
  const repairedMessage = await receiveOne(h, queue);
  const delivered = JSON.parse(repairedMessage.Body!);
  assert.equal(delivered.detail.requestPayload.id, "repaired");
  assert.equal(delivered["detail-type"], "Lambda Function Invocation Result - Success");
  await h.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl(h, queue), ReceiptHandle: repairedMessage.ReceiptHandle! }));

  await h.lambda.send(new InvokeCommand({
    FunctionName: "lambda-rejected-eventbridge-source",
    InvocationType: InvocationType.Event,
    Payload: Buffer.from(JSON.stringify({ id: "failed", fail: true })),
  }));
  const failed = JSON.parse((await receiveOne(h, queue)).Body!);
  assert.equal(failed.source, "lambda");
  assert.equal(failed["detail-type"], "Lambda Function Invocation Result - Failure");
  assert.equal(failed.detail.requestPayload.id, "failed");
  assert.equal(failed.detail.requestContext.condition, "RetriesExhausted");
  assert.equal(failed.detail.requestContext.approximateInvokeCount, 1);
  assert.equal(failed.detail.responseContext.functionError, "Unhandled");
  assert.equal(await destinationFailures(), 1, "the repaired delivery does not add another destination failure");
});
