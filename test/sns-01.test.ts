import assert from "node:assert/strict";
import { verify, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateFunctionCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  AttachRolePolicyCommand,
  CreatePolicyCommand,
  CreateRoleCommand,
  IAMClient,
} from "@aws-sdk/client-iam";
import {
  CreateQueueCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  CreateTopicCommand,
  DeleteTopicCommand,
  GetSubscriptionAttributesCommand,
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  ListSubscriptionsCommand,
  ListTagsForResourceCommand,
  ListTopicsCommand,
  PublishBatchCommand,
  PublishCommand,
  SNSClient,
  SubscribeCommand,
  TagResourceCommand,
  UnsubscribeCommand,
  UntagResourceCommand,
} from "@aws-sdk/client-sns";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { migrateState } from "../src/migrations/index.js";
import { CURRENT_SCHEMA_VERSION, emptyState } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function settle(clock: TestClock, predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    clock.advance(0);
    await new Promise(resolve => setImmediate(resolve));
    if (Date.now() >= deadline) throw new Error("Timed out waiting for SNS delivery");
  }
}

function allowSnsPolicy(queueArn: string, topicArn: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Service: "sns.amazonaws.com" },
      Action: "sqs:SendMessage",
      Resource: queueArn,
      Condition: {
        ArnEquals: { "aws:SourceArn": topicArn },
        StringEquals: { "aws:SourceAccount": accountId },
      },
    }],
  });
}

function verifyEnvelopeSignature(envelope: any, certificate: string): void {
  const canonical = [
    "Message", envelope.Message,
    "MessageId", envelope.MessageId,
    ...(envelope.Subject === undefined ? [] : ["Subject", envelope.Subject]),
    "Timestamp", envelope.Timestamp,
    "TopicArn", envelope.TopicArn,
    "Type", envelope.Type,
  ].join("\n") + "\n";
  assert.equal(verify("RSA-SHA1", Buffer.from(canonical), new X509Certificate(certificate).publicKey, Buffer.from(envelope.Signature, "base64")), true);
}

test("SNS-01 official client lifecycle and durable signed SQS/Lambda fan-out", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns01-"));
  const output = join(root, "lambda-sns-event.json");
  const clock = new TestClock(Date.now());
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce" });
  let sns!: SNSClient;
  let sqs!: SQSClient;
  let lambda!: LambdaClient;
  let cloudwatch!: CloudWatchClient;
  const connect = () => {
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const systemClockOffset = clock.now() - Date.now();
    sns = new SNSClient({ endpoint, region, credentials, systemClockOffset });
    sqs = new SQSClient({ endpoint, region, credentials, systemClockOffset });
    lambda = new LambdaClient({ endpoint, region, credentials, systemClockOffset });
    cloudwatch = new CloudWatchClient({ endpoint, region, credentials, systemClockOffset });
    return endpoint;
  };
  const disconnect = () => { sns?.destroy(); sqs?.destroy(); lambda?.destroy(); cloudwatch?.destroy(); };

  try {
    await simulator.start();
    let endpoint = connect();
    const created = await sns.send(new CreateTopicCommand({ Name: "orders", Attributes: { DisplayName: "Order events" }, Tags: [{ Key: "environment", Value: "test" }] }));
    const TopicArn = created.TopicArn!;
    assert.equal((await sns.send(new CreateTopicCommand({ Name: "orders" }))).TopicArn, TopicArn);
    const attributes = (await sns.send(new GetTopicAttributesCommand({ TopicArn }))).Attributes;
    assert.equal(attributes?.FifoTopic, "false");
    assert.equal(attributes?.DisplayName, "Order events");
    assert.equal(attributes?.SignatureVersion, "1");
    assert.deepEqual((await sns.send(new ListTopicsCommand({}))).Topics?.map(topic => topic.TopicArn), [TopicArn]);
    assert.deepEqual((await sns.send(new ListTagsForResourceCommand({ ResourceArn: TopicArn }))).Tags, [{ Key: "environment", Value: "test" }]);
    await sns.send(new TagResourceCommand({ ResourceArn: TopicArn, Tags: [{ Key: "owner", Value: "platform" }] }));
    await sns.send(new UntagResourceCommand({ ResourceArn: TopicArn, TagKeys: ["environment"] }));
    assert.deepEqual((await sns.send(new ListTagsForResourceCommand({ ResourceArn: TopicArn }))).Tags, [{ Key: "owner", Value: "platform" }]);

    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "sns-orders" }));
    const QueueUrl = queue.QueueUrl!;
    const QueueArn = `arn:aws:sqs:${region}:${accountId}:sns-orders`;
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: allowSnsPolicy(QueueArn, TopicArn) } }));
    const queueSubscription = await sns.send(new SubscribeCommand({ TopicArn, Protocol: "sqs", Endpoint: QueueArn }));

    const code = createZip([{ name: "index.mjs", content: `import { writeFileSync } from "node:fs"; export async function handler(event) { writeFileSync(process.env.OUT, JSON.stringify(event)); return { ok: true }; }` }]);
    const fn = await lambda.send(new CreateFunctionCommand({
      FunctionName: "sns-handler",
      Runtime: "nodejs22.x",
      Role: `arn:aws:iam::${accountId}:role/test`,
      Handler: "index.handler",
      Code: { ZipFile: code },
      Environment: { Variables: { OUT: output } },
    }));
    await lambda.send(new (await import("@aws-sdk/client-lambda")).AddPermissionCommand({
      FunctionName: "sns-handler",
      StatementId: "sns-orders",
      Action: "lambda:InvokeFunction",
      Principal: "sns.amazonaws.com",
      SourceArn: TopicArn,
      SourceAccount: accountId,
    }));
    const lambdaSubscription = await sns.send(new SubscribeCommand({ TopicArn, Protocol: "lambda", Endpoint: fn.FunctionArn! }));
    assert.equal((await sns.send(new ListSubscriptionsCommand({}))).Subscriptions?.length, 2);
    assert.equal((await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn }))).Subscriptions?.length, 2);
    assert.equal((await sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: queueSubscription.SubscriptionArn! }))).Attributes?.RawMessageDelivery, "false");

    const deniedQueue = await sqs.send(new CreateQueueCommand({ QueueName: "sns-orders-denied" }));
    const deniedQueueUrl = deniedQueue.QueueUrl!;
    const deniedQueueArn = `arn:aws:sqs:${region}:${accountId}:sns-orders-denied`;
    const deniedSubscription = await sns.send(new SubscribeCommand({ TopicArn, Protocol: "sqs", Endpoint: deniedQueueArn }));

    const published = await sns.send(new PublishCommand({
      TopicArn,
      Subject: "Order created",
      Message: "order-123",
      MessageAttributes: {
        kind: { DataType: "String", StringValue: "created" },
        attempts: { DataType: "Number", StringValue: "1.0" },
        bytes: { DataType: "Binary", BinaryValue: Uint8Array.from([0, 1, 254, 255]) },
      },
      MessageGroupId: "tenant-1",
    }));
    assert.match(published.MessageId!, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(await readFile(join(root, "state.json"), "utf8"), /order-123/);
    const encrypted = await readFile(join(root, "data", "sns", accountId, region, "deliveries.enc"));
    assert.equal(encrypted.includes(Buffer.from("order-123")), false);
    assert.equal((await stat(join(root, "secrets", "sns", "signing-key.pem"))).isFile(), true);

    let received: any;
    try {
      await settle(clock, async () => {
        received ??= (await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }))).Messages?.[0];
        return Boolean(received && await stat(output).then(() => true, () => false));
      });
    } catch (error) {
      const diagnostics = await simulator.sns.deliveryDiagnostics();
      throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(diagnostics)}`);
    }
    const envelope = JSON.parse(received.Body!);
    assert.equal(envelope.Message, "order-123");
    assert.equal(envelope.Subject, "Order created");
    assert.equal(envelope.MessageAttributes.attempts.Value, "1");
    assert.match(envelope.UnsubscribeURL, /_stacksim\/sns\/unsubscribe\?token=/);
    const certificate = await (await fetch(envelope.SigningCertURL)).text();
    verifyEnvelopeSignature(envelope, certificate);
    const lambdaEvent = JSON.parse(await readFile(output, "utf8"));
    assert.equal(lambdaEvent.Records[0].EventSource, "aws:sns");
    assert.equal(lambdaEvent.Records[0].EventSubscriptionArn, lambdaSubscription.SubscriptionArn);
    assert.equal(lambdaEvent.Records[0].Sns.Message, "order-123");
    await settle(clock, async () => (await simulator.sns.deliveryDiagnostics()).some(item =>
      item.subscriptionArn === deniedSubscription.SubscriptionArn && item.status === "FAILED"));
    assert.equal((await sqs.send(new ReceiveMessageCommand({ QueueUrl: deniedQueueUrl }))).Messages?.length ?? 0, 0);
    const metricSum = async (MetricName: string) => {
      const result = await cloudwatch.send(new GetMetricStatisticsCommand({
        Namespace: "AWS/SNS",
        MetricName,
        Dimensions: [{ Name: "TopicName", Value: "orders" }],
        StartTime: new Date(clock.now() - 60_000),
        EndTime: new Date(clock.now() + 60_000),
        Period: 60,
        Statistics: ["Sum"],
      }));
      return result.Datapoints?.reduce((total, point) => total + (point.Sum ?? 0), 0) ?? 0;
    };
    assert.equal(await metricSum("NumberOfMessagesPublished"), 1);
    assert.equal(await metricSum("NumberOfNotificationsDelivered"), 2);
    assert.equal(await metricSum("NumberOfNotificationsFailed"), 1);

    const batch = await sns.send(new PublishBatchCommand({ TopicArn, PublishBatchRequestEntries: [
      { Id: "good", Message: JSON.stringify({ default: "fallback", sqs: "queue-only", lambda: "lambda-only" }), MessageStructure: "json" },
      { Id: "bad", Message: "", Subject: "invalid" },
    ] }));
    assert.equal(batch.Successful?.[0].Id, "good");
    assert.equal(batch.Failed?.[0].Id, "bad");
    assert.equal(batch.Failed?.[0].SenderFault, true);

    await simulator.stop();
    disconnect();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce" });
    await simulator.start();
    endpoint = connect();
    assert.equal((await sns.send(new ListTopicsCommand({}))).Topics?.[0].TopicArn, TopicArn);
    assert.equal(await (await fetch(`${endpoint}/_stacksim/sns/certificate.pem`)).text(), certificate);

    await sns.send(new UnsubscribeCommand({ SubscriptionArn: queueSubscription.SubscriptionArn! }));
    assert.equal((await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn }))).Subscriptions?.length, 2);
    await sns.send(new DeleteTopicCommand({ TopicArn }));
    assert.equal((await sns.send(new ListTopicsCommand({}))).Topics?.length ?? 0, 0);
  } finally {
    disconnect();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SNS-01 schema 58 migration adds isolated regional control state and a 256-bit content key", () => {
  const legacy: any = emptyState();
  legacy.schemaVersion = 58;
  delete legacy.installation.snsEncryptionKey;
  delete legacy.accounts[accountId].regions[region].sns;
  legacy.accounts[accountId].regions[region].tables.preserved = { marker: "unchanged" };
  const migrated = migrateState(legacy, accountId, region);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(Buffer.from(migrated.state.installation.snsEncryptionKey, "base64").length, 32);
  assert.deepEqual(migrated.state.accounts[accountId].regions[region].sns, { revision: 0, topics: {}, subscriptions: {} });
  assert.equal((migrated.state.accounts[accountId].regions[region].tables as any).preserved.marker, "unchanged");
});

test("SNS-01 accepts zero-subscription publishes and isolates equal topic names by Region", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns01-isolation-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  const clients: SNSClient[] = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const west = new SNSClient({ endpoint, region, credentials });
    const east = new SNSClient({ endpoint, region: "us-east-1", credentials });
    clients.push(west, east);
    const westArn = (await west.send(new CreateTopicCommand({ Name: "shared-name" }))).TopicArn!;
    const eastArn = (await east.send(new CreateTopicCommand({ Name: "shared-name" }))).TopicArn!;
    assert.notEqual(westArn, eastArn);
    assert.deepEqual((await west.send(new ListTopicsCommand({}))).Topics?.map(item => item.TopicArn), [westArn]);
    assert.deepEqual((await east.send(new ListTopicsCommand({}))).Topics?.map(item => item.TopicArn), [eastArn]);
    const accepted = await west.send(new PublishCommand({ TopicArn: westArn, Message: "no-listeners" }));
    assert.match(accepted.MessageId!, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await (await fetch(`${endpoint}/_stacksim/api/sns/deliveries`, { headers: { "x-stacksim-region": region } })).json(), []);
    assert.equal((await readFile(join(root, "data", "sns", accountId, region, "deliveries.enc"))).includes(Buffer.from("no-listeners")), false);
    await assert.rejects(west.send(new PublishCommand({ TopicArn: eastArn, Message: "wrong-region" })), (error: any) => error.name === "InvalidParameterException");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SNS-01 configured topic and retained-message capacities fail atomically and prune after retention", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns01-capacity-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    clock,
    authMode: "off",
    snsMaximumTopics: 1,
    snsMaximumDeliveryMessages: 1,
    snsDeliveryRetentionMs: 1,
  });
  let client: SNSClient | undefined;
  try {
    await simulator.start();
    client = new SNSClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    const TopicArn = (await client.send(new CreateTopicCommand({ Name: "bounded" }))).TopicArn!;
    await assert.rejects(client.send(new CreateTopicCommand({ Name: "over-capacity" })), (error: any) => error.name === "TopicLimitExceededException");
    await client.send(new PublishCommand({ TopicArn, Message: "SNS_CAPACITY_SECRET_ONE" }));
    await assert.rejects(client.send(new PublishCommand({ TopicArn, Message: "SNS_CAPACITY_SECRET_TWO" })), (error: any) => error.name === "InternalErrorException");
    clock.advance(2);
    assert.match((await client.send(new PublishCommand({ TopicArn, Message: "SNS_CAPACITY_SECRET_THREE" }))).MessageId!, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(await readFile(join(root, "state.json"), "utf8"), /SNS_CAPACITY_SECRET_(ONE|TWO|THREE)/);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SNS-01 pagination is opaque and stale-safe, and topic recreation receives a new generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns01-pages-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  let client: SNSClient | undefined;
  try {
    await simulator.start();
    client = new SNSClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    await Promise.all(Array.from({ length: 101 }, (_, index) =>
      client!.send(new CreateTopicCommand({ Name: `page-${String(index).padStart(3, "0")}` }))));
    const first = await client.send(new ListTopicsCommand({}));
    assert.equal(first.Topics?.length, 100);
    assert.ok(first.NextToken);
    const second = await client.send(new ListTopicsCommand({ NextToken: first.NextToken }));
    assert.equal(second.Topics?.length, 1);
    assert.equal(second.NextToken, undefined);

    const recreatedArn = first.Topics![0].TopicArn!;
    const recreatedName = recreatedArn.slice(recreatedArn.lastIndexOf(":") + 1);
    const originalGeneration = simulator.store.regionState(region).sns.topics[recreatedName].generation;
    await client.send(new DeleteTopicCommand({ TopicArn: recreatedArn }));
    await client.send(new CreateTopicCommand({ Name: recreatedName }));
    assert.notEqual(simulator.store.regionState(region).sns.topics[recreatedName].generation, originalGeneration);
    await assert.rejects(client.send(new ListTopicsCommand({ NextToken: first.NextToken })), (error: any) => error.name === "InvalidParameterException");
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SNS-01 delivery-store corruption isolates only the affected account and Region without resetting control state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns01-isolation-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  let west: SNSClient | undefined;
  let east: SNSClient | undefined;
  try {
    await simulator.start();
    west = new SNSClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    const TopicArn = (await west.send(new CreateTopicCommand({ Name: "survives-corruption" }))).TopicArn!;
    west.destroy();
    west = undefined;
    await simulator.stop();
    await writeFile(join(root, "data", "sns", accountId, region, "deliveries.enc"), "{corrupt", "utf8");

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const environment = await fetch(`${endpoint}/_stacksim/api/environment`).then(response => response.json()) as any;
    assert.equal(environment.services.sns, "unavailable");
    assert.equal(simulator.store.regionState(region).sns.topics["survives-corruption"].arn, TopicArn);
    west = new SNSClient({ endpoint, region, credentials });
    await assert.rejects(west.send(new ListTopicsCommand({})), (error: any) => error.name === "InternalErrorException");

    east = new SNSClient({ endpoint, region: "us-east-1", credentials });
    assert.match((await east.send(new CreateTopicCommand({ Name: "isolated-east" }))).TopicArn!, /^arn:aws:sns:us-east-1:/);
  } finally {
    west?.destroy();
    east?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SNS-01 IAM authorization evaluates request tags and persisted topic resource tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns01-iam-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const admin = new SNSClient({ endpoint, region, credentials });
    const iam = new IAMClient({ endpoint, region, credentials });
    const sts = new STSClient({ endpoint, region, credentials });
    clients.push(admin, iam, sts);
    const allowedArn = (await admin.send(new CreateTopicCommand({
      Name: "tagged-development",
      Tags: [{ Key: "environment", Value: "development" }],
    }))).TopicArn!;
    const deniedArn = (await admin.send(new CreateTopicCommand({
      Name: "tagged-production",
      Tags: [{ Key: "environment", Value: "production" }],
    }))).TopicArn!;

    const roleName = "sns-tag-scoped";
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sts:AssumeRole" }],
      }),
    }));
    const policy = await iam.send(new CreatePolicyCommand({
      PolicyName: "SnsTagScoped",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "sns:GetTopicAttributes",
            Resource: `arn:aws:sns:${region}:${accountId}:*`,
            Condition: { StringEquals: { "aws:ResourceTag/environment": "development" } },
          },
          {
            Effect: "Allow",
            Action: "sns:CreateTopic",
            Resource: "*",
            Condition: { StringEquals: { "aws:RequestTag/environment": "development" } },
          },
        ],
      }),
    }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policy.Policy!.Arn! }));
    const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: "sns-tag-test" }));
    const scoped = new SNSClient({
      endpoint,
      region,
      credentials: {
        accessKeyId: assumed.Credentials!.AccessKeyId!,
        secretAccessKey: assumed.Credentials!.SecretAccessKey!,
        sessionToken: assumed.Credentials!.SessionToken!,
      },
      maxAttempts: 1,
    });
    clients.push(scoped);

    assert.equal((await scoped.send(new GetTopicAttributesCommand({ TopicArn: allowedArn }))).Attributes?.TopicArn, allowedArn);
    await assert.rejects(scoped.send(new GetTopicAttributesCommand({ TopicArn: deniedArn })), (error: any) => error.name === "AccessDenied");
    assert.match((await scoped.send(new CreateTopicCommand({
      Name: "request-tag-allowed",
      Tags: [{ Key: "environment", Value: "development" }],
    }))).TopicArn!, /:request-tag-allowed$/);
    await assert.rejects(scoped.send(new CreateTopicCommand({
      Name: "request-tag-denied",
      Tags: [{ Key: "environment", Value: "production" }],
    })), (error: any) => error.name === "AccessDenied");
    assert.equal(simulator.store.regionState(region).sns.topics["request-tag-denied"], undefined);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SNS-01 raw Query protocol returns the SNS namespace and rejects bad versions and duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns01-query-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const create = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-service": "sns" },
      body: "Action=CreateTopic&Version=2010-03-31&Name=wire-topic",
    });
    const body = await create.text();
    assert.equal(create.status, 200);
    assert.match(body, /<CreateTopicResponse xmlns="https:\/\/sns\.amazonaws\.com\/doc\/2010-03-31\/">/);
    assert.match(body, /<TopicArn>arn:aws:sns:eu-west-1:000000000000:wire-topic<\/TopicArn>/);
    const wrong = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-service": "sns" },
      body: "Action=ListTopics&Version=2000-01-01",
    });
    assert.equal(wrong.status, 400);
    assert.match(await wrong.text(), /<Code>InvalidParameter<\/Code>/);
    const duplicate = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-service": "sns" },
      body: "Action=CreateTopic&Version=2010-03-31&Name=first&Name=second",
    });
    assert.equal(duplicate.status, 400);
    assert.match(await duplicate.text(), /Duplicate parameter/);
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
