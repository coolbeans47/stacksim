import assert from "node:assert/strict";
import { createHash, verify, X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AddPermissionCommand,
  CreateTopicCommand,
  GetSubscriptionAttributesCommand,
  GetTopicAttributesCommand,
  PublishCommand,
  RemovePermissionCommand,
  SetSubscriptionAttributesCommand,
  SetTopicAttributesCommand,
  SNSClient,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  AttachRolePolicyCommand,
  CreatePolicyCommand,
  CreateRoleCommand,
  IAMClient,
} from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CloudWatchClient, ListMetricsCommand } from "@aws-sdk/client-cloudwatch";
import { TestClock } from "../src/core/clock.js";
import { AwsError } from "../src/errors.js";
import { migrateState } from "../src/migrations/index.js";
import { CURRENT_SCHEMA_VERSION, emptyState } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { validateFilterPolicy } from "../src/sns/filter.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function settle(clock: TestClock, predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    clock.advance(0);
    await new Promise(resolve => setImmediate(resolve));
    if (Date.now() >= deadline) throw new Error("Timed out waiting for SNS-02 delivery");
  }
}

function queuePolicy(queueArn: string, topicArn: string): string {
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

test("SNS-02 validates current filter operators and complexity limits", () => {
  const policy = validateFilterPolicy(JSON.stringify({
    kind: [{ wildcard: "order-*" }, { prefix: "invoice-" }],
    "$or": [
      { priority: [{ numeric: [">=", 5, "<", 10] }] },
      { source: [{ "equals-ignore-case": "API" }] },
    ],
    detail: { address: [{ ip: "10.0.0.0/8" }], state: [{ "anything-but": { suffix: "-ignored" } }] },
  }), "MessageBody");
  assert.equal(policy.leafKeys, 5);
  assert.ok(policy.combinations <= 150);
  assert.throws(() => validateFilterPolicy(JSON.stringify({
    a: ["1"], b: ["2"], c: ["3"], d: ["4"], e: ["5"], f: ["6"],
  }), "MessageAttributes"), /at most 5 leaf keys/);
  assert.throws(() => validateFilterPolicy(JSON.stringify({ a: Array.from({ length: 151 }, (_, index) => String(index)) }), "MessageAttributes"), /combinations/);
  assert.throws(() => validateFilterPolicy('{"a":["x"],"a":["y"]}', "MessageAttributes"), /duplicate key/);
  assert.throws(() => validateFilterPolicy(JSON.stringify({ a: [{ wildcard: "****" }] }), "MessageAttributes"), /at most three/);
});

test("SNS-02 official SDK covers policies, filters, raw SQS, signatures, terminal failure and DLQ", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns02-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let sns!: SNSClient;
  let sqs!: SQSClient;
  let iam!: IAMClient;
  let logs!: CloudWatchLogsClient;
  let cloudwatch!: CloudWatchClient;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const systemClockOffset = clock.now() - Date.now();
    sns = new SNSClient({ endpoint, region, credentials, systemClockOffset });
    sqs = new SQSClient({ endpoint, region, credentials, systemClockOffset });
    iam = new IAMClient({ endpoint, region, credentials, systemClockOffset });
    logs = new CloudWatchLogsClient({ endpoint, region, credentials, systemClockOffset });
    cloudwatch = new CloudWatchClient({ endpoint, region, credentials, systemClockOffset });
    const feedbackRole = await iam.send(new CreateRoleCommand({
      RoleName: "sns02-feedback",
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sts:AssumeRole" }],
      }),
    }));
    const feedbackPolicy = await iam.send(new CreatePolicyCommand({
      PolicyName: "Sns02FeedbackLogs",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }],
      }),
    }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: "sns02-feedback", PolicyArn: feedbackPolicy.Policy!.Arn! }));
    const TopicArn = (await sns.send(new CreateTopicCommand({
      Name: "sns02-orders",
      Attributes: {
        SignatureVersion: "2",
        SQSSuccessFeedbackRoleArn: feedbackRole.Role!.Arn!,
        SQSSuccessFeedbackSampleRate: "100",
        SQSFailureFeedbackRoleArn: feedbackRole.Role!.Arn!,
      },
      Tags: [{ Key: "environment", Value: "test" }],
    }))).TopicArn!;

    await sns.send(new AddPermissionCommand({ TopicArn, Label: "publisher", AWSAccountId: [accountId], ActionName: ["Publish"] }));
    assert.match((await sns.send(new GetTopicAttributesCommand({ TopicArn }))).Attributes!.Policy!, /publisher/);
    await sns.send(new RemovePermissionCommand({ TopicArn, Label: "publisher" }));
    assert.doesNotMatch((await sns.send(new GetTopicAttributesCommand({ TopicArn }))).Attributes!.Policy!, /publisher/);

    const createQueue = async (name: string, allow = true) => {
      const QueueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: name }))).QueueUrl!;
      const QueueArn = `arn:aws:sqs:${region}:${accountId}:${name}`;
      if (allow) await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: queuePolicy(QueueArn, TopicArn) } }));
      return { QueueUrl, QueueArn };
    };
    const raw = await createQueue("sns02-raw");
    const wrapped = await createQueue("sns02-wrapped");
    const denied = await createQueue("sns02-denied", false);
    const dlq = await createQueue("sns02-dlq");

    const rawSubscription = (await sns.send(new SubscribeCommand({
      TopicArn,
      Protocol: "sqs",
      Endpoint: raw.QueueArn,
      Attributes: {
        RawMessageDelivery: "true",
        FilterPolicyScope: "MessageAttributes",
        FilterPolicy: JSON.stringify({
          kind: [{ wildcard: "order-*" }],
          "$or": [
            { priority: [{ numeric: [">=", 5] }] },
            { source: [{ "equals-ignore-case": "API" }] },
          ],
        }),
      },
    }))).SubscriptionArn!;
    const wrappedSubscription = (await sns.send(new SubscribeCommand({
      TopicArn,
      Protocol: "sqs",
      Endpoint: wrapped.QueueArn,
      Attributes: {
        FilterPolicyScope: "MessageBody",
        FilterPolicy: JSON.stringify({ detail: { state: [{ "anything-but": "ignored" }] } }),
      },
    }))).SubscriptionArn!;
    await sns.send(new SubscribeCommand({
      TopicArn,
      Protocol: "sqs",
      Endpoint: denied.QueueArn,
      Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.QueueArn }) },
    }));

    const message = JSON.stringify({ detail: { state: "ready" } });
    await sns.send(new PublishCommand({
      TopicArn,
      Message: message,
      MessageAttributes: {
        kind: { DataType: "String", StringValue: "order-created" },
        priority: { DataType: "Number", StringValue: "7" },
      },
    }));
    let rawMessage: any;
    let wrappedMessage: any;
    let deadLetter: any;
    try {
      await settle(clock, async () => {
        rawMessage ??= (await sqs.send(new ReceiveMessageCommand({ QueueUrl: raw.QueueUrl, MessageAttributeNames: ["All"] }))).Messages?.[0];
        wrappedMessage ??= (await sqs.send(new ReceiveMessageCommand({ QueueUrl: wrapped.QueueUrl }))).Messages?.[0];
        deadLetter ??= (await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq.QueueUrl }))).Messages?.[0];
        return Boolean(rawMessage && wrappedMessage && deadLetter);
      });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} diagnostics=${JSON.stringify(await simulator.sns.deliveryDiagnostics())}`);
    }
    assert.equal(rawMessage.Body, message);
    assert.equal(rawMessage.MessageAttributes.kind.StringValue, "order-created");
    const envelope = JSON.parse(wrappedMessage.Body);
    assert.equal(envelope.SignatureVersion, "2");
    const certificate = new X509Certificate(await (await fetch(envelope.SigningCertURL)).text());
    const canonical = [
      "Message", envelope.Message,
      "MessageId", envelope.MessageId,
      "Timestamp", envelope.Timestamp,
      "TopicArn", envelope.TopicArn,
      "Type", envelope.Type,
    ].join("\n") + "\n";
    assert.equal(verify("RSA-SHA256", Buffer.from(canonical), certificate.publicKey, Buffer.from(envelope.Signature, "base64")), true);
    assert.equal(JSON.parse(deadLetter.Body).TopicArn, TopicArn);
    const feedback = await logs.send(new FilterLogEventsCommand({ logGroupName: `sns/${region}/${accountId}/sns02-orders/sqs` }));
    const feedbackMessages = feedback.events?.map(event => event.message ?? "") ?? [];
    assert.ok(feedbackMessages.some(line => line.includes('"status":"SUCCESS"')));
    assert.ok(feedbackMessages.some(line => line.includes('"status":"FAILURE"')));
    assert.equal(feedbackMessages.some(line => line.includes(message)), false, "delivery feedback must not expose message bodies");
    const metricNames = new Set((await cloudwatch.send(new ListMetricsCommand({ Namespace: "AWS/SNS" }))).Metrics?.map(metric => metric.MetricName));
    for (const name of ["NumberOfMessagesPublished", "PublishSize", "NumberOfNotificationsDelivered", "NumberOfNotificationsFailed"]) {
      assert.ok(metricNames.has(name), `expected AWS/SNS metric ${name}`);
    }

    const rawAttributes = (await sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: rawSubscription }))).Attributes!;
    assert.equal(rawAttributes.RawMessageDelivery, "true");
    assert.equal(rawAttributes.FilterPolicyScope, "MessageAttributes");
    await sns.send(new SetSubscriptionAttributesCommand({
      SubscriptionArn: wrappedSubscription,
      AttributeName: "FilterPolicy",
      AttributeValue: "",
    }));
    await sns.send(new SetSubscriptionAttributesCommand({
      SubscriptionArn: wrappedSubscription,
      AttributeName: "FilterPolicyScope",
      AttributeValue: "MessageAttributes",
    }));
    await sns.send(new SetTopicAttributesCommand({ TopicArn, AttributeName: "SignatureVersion", AttributeValue: "1" }));
    assert.equal((await sns.send(new GetTopicAttributesCommand({ TopicArn }))).Attributes!.SignatureVersion, "1");

    await assert.rejects(sns.send(new SetSubscriptionAttributesCommand({
      SubscriptionArn: rawSubscription,
      AttributeName: "DeliveryPolicy",
      AttributeValue: "{}",
    })), /later SNS phase/);
    assert.equal((await sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: rawSubscription }))).Attributes!.RawMessageDelivery, "true");

    const eleven = {
      kind: { DataType: "String", StringValue: "order-overflow" },
      priority: { DataType: "Number", StringValue: "7" },
      ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
        `attribute${index}`,
        { DataType: "String", StringValue: String(index) },
      ])),
    };
    await sns.send(new PublishCommand({ TopicArn, Message: "attribute-overflow", MessageAttributes: eleven }));
    await settle(clock, async () => (await simulator.sns.deliveryDiagnostics()).some(item =>
      item.subscriptionArn === rawSubscription && item.errorCode === "InvalidParameter" && item.status === "FAILED"));
  } finally {
    sns?.destroy();
    sqs?.destroy();
    iam?.destroy();
    logs?.destroy();
    cloudwatch?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SNS-02 composes identity, topic, endpoint, service-source, and tag conditions with explicit deny and lockout protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns02-auth-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const sns = new SNSClient({ endpoint, region, credentials, maxAttempts: 1 });
    const sqs = new SQSClient({ endpoint, region, credentials });
    const iam = new IAMClient({ endpoint, region, credentials });
    const sts = new STSClient({ endpoint, region, credentials });
    clients.push(sns, sqs, iam, sts);
    const TopicArn = (await sns.send(new CreateTopicCommand({
      Name: "sns02-auth",
      Tags: [{ Key: "environment", Value: "development" }],
    }))).TopicArn!;
    const queueOne = (await sqs.send(new CreateQueueCommand({ QueueName: "sns02-auth-one" }))).QueueUrl!;
    const queueTwo = (await sqs.send(new CreateQueueCommand({ QueueName: "sns02-auth-two" }))).QueueUrl!;
    const queueArn = `arn:aws:sqs:${region}:${accountId}:sns02-auth-one`;
    const otherQueueArn = `arn:aws:sqs:${region}:${accountId}:sns02-auth-two`;

    const before = (await sns.send(new GetTopicAttributesCommand({ TopicArn }))).Attributes!.Policy!;
    const lockout = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Deny",
        Principal: { AWS: `arn:aws:iam::${accountId}:root` },
        Action: "sns:SetTopicAttributes",
        Resource: TopicArn,
      }],
    });
    await assert.rejects(sns.send(new SetTopicAttributesCommand({
      TopicArn,
      AttributeName: "Policy",
      AttributeValue: lockout,
    })), /policy-recovery/);
    assert.equal((await sns.send(new GetTopicAttributesCommand({ TopicArn }))).Attributes!.Policy, before);

    const roleName = "sns02-topic-caller";
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sts:AssumeRole" }],
      }),
    }));
    const identityPolicy = await iam.send(new CreatePolicyCommand({
      PolicyName: "Sns02IdentityPublish",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "sns:Publish", Resource: TopicArn }],
      }),
    }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: identityPolicy.Policy!.Arn! }));

    const ruleArn = `arn:aws:events:${region}:${accountId}:rule/sns02-source`;
    const topicPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "EndpointScopedSubscribe",
          Effect: "Allow",
          Principal: { AWS: roleArn },
          Action: "sns:Subscribe",
          Resource: TopicArn,
          Condition: {
            StringEquals: {
              "sns:Protocol": "sqs",
              "sns:Endpoint": queueArn,
              "aws:ResourceTag/environment": "development",
            },
          },
        },
        {
          Sid: "DenyRolePublish",
          Effect: "Deny",
          Principal: { AWS: roleArn },
          Action: "sns:Publish",
          Resource: TopicArn,
        },
        {
          Sid: "AllowExactEventBridgeSource",
          Effect: "Allow",
          Principal: { Service: "events.amazonaws.com" },
          Action: "sns:Publish",
          Resource: TopicArn,
          Condition: {
            ArnEquals: { "aws:SourceArn": ruleArn },
            StringEquals: {
              "aws:SourceAccount": accountId,
              "aws:ResourceTag/environment": "development",
            },
          },
        },
      ],
    });
    await sns.send(new SetTopicAttributesCommand({ TopicArn, AttributeName: "Policy", AttributeValue: topicPolicy }));

    const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: "sns02-auth" }));
    const scoped = new SNSClient({
      endpoint,
      region,
      maxAttempts: 1,
      credentials: {
        accessKeyId: assumed.Credentials!.AccessKeyId!,
        secretAccessKey: assumed.Credentials!.SecretAccessKey!,
        sessionToken: assumed.Credentials!.SessionToken!,
      },
    });
    clients.push(scoped);
    assert.ok((await scoped.send(new SubscribeCommand({ TopicArn, Protocol: "sqs", Endpoint: queueArn }))).SubscriptionArn);
    await assert.rejects(
      scoped.send(new SubscribeCommand({ TopicArn, Protocol: "sqs", Endpoint: otherQueueArn })),
      (error: any) => ["AuthorizationError", "AccessDenied", "AccessDeniedException"].includes(error.name),
    );
    await assert.rejects(
      scoped.send(new PublishCommand({ TopicArn, Message: "identity allow loses to resource deny" })),
      (error: any) => ["AuthorizationError", "AccessDenied", "AccessDeniedException"].includes(error.name),
    );

    assert.ok((await simulator.sns.publishAuthorized(
      { TopicArn, Message: "service source accepted" },
      { principal: "events.amazonaws.com", sourceArn: ruleArn, sourceAccount: accountId },
    )).MessageId);
    await assert.rejects(
      simulator.sns.publishAuthorized(
        { TopicArn, Message: "wrong source rejected" },
        { principal: "events.amazonaws.com", sourceArn: `${ruleArn}-other`, sourceAccount: accountId },
      ),
      (error: any) => error.code === "AuthorizationError",
    );

    assert.ok(queueOne);
    assert.ok(queueTwo);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SNS-02 uses deterministic managed retry backoff and reclaims expired delivery leases after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns02-retry-"));
  const clock = new TestClock(Date.now());
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let sns: SNSClient | undefined;
  let sqs: SQSClient | undefined;
  try {
    await simulator.start();
    let endpoint = `http://127.0.0.1:${simulator.port}`;
    sns = new SNSClient({ endpoint, region, credentials, systemClockOffset: clock.now() - Date.now() });
    sqs = new SQSClient({ endpoint, region, credentials, systemClockOffset: clock.now() - Date.now() });
    const TopicArn = (await sns.send(new CreateTopicCommand({ Name: "sns02-retry" }))).TopicArn!;
    const QueueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "sns02-retry" }))).QueueUrl!;
    const QueueArn = `arn:aws:sqs:${region}:${accountId}:sns02-retry`;
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: queuePolicy(QueueArn, TopicArn) } }));
    await sns.send(new SubscribeCommand({ TopicArn, Protocol: "sqs", Endpoint: QueueArn }));

    const originalSend = simulator.sqs.sendAuthorizedMessageToArn.bind(simulator.sqs);
    let transientFailures = 4;
    (simulator.sqs as any).sendAuthorizedMessageToArn = async (queueArn: any, input: any, actor: any) => {
      if (transientFailures-- > 0) throw new AwsError("InternalError", "transient endpoint failure", 500);
      return originalSend(queueArn, input, actor);
    };
    await sns.send(new PublishCommand({ TopicArn, Message: "retry-safe" }));
    let retrying: any;
    await settle(clock, async () => {
      retrying = (await simulator.sns.deliveryDiagnostics()).find(item =>
        item.status === "QUEUED" && item.attempts === 4 && Number(item.nextAttemptAt) > clock.now());
      return Boolean(retrying);
    });
    const digest = createHash("sha256").update(`${retrying.deliveryId}:4`).digest();
    const expectedDelay = Math.round(1_000 * (0.5 + digest.readUInt32BE(0) / 0xffffffff));
    assert.equal(retrying.nextAttemptAt - clock.now(), expectedDelay);
    (simulator.sqs as any).sendAuthorizedMessageToArn = originalSend;
    clock.advance(expectedDelay);

    let first: any;
    await settle(clock, async () => {
      first ??= (await sqs!.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0];
      return Boolean(first);
    });
    assert.equal(JSON.parse(first.Body).Message, "retry-safe");
    await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: first.ReceiptHandle }));

    await (simulator.sns as any).storage.mutate((data: any) => {
      const delivery = data.deliveries[retrying.deliveryId];
      delivery.status = "LEASED";
      delivery.leaseId = "crash-shaped-expired-lease";
      delivery.leaseUntil = clock.now() - 1;
      delivery.nextAttemptAt = clock.now() + 60_000;
      delete delivery.completedAt;
    });
    sns.destroy();
    sqs.destroy();
    sns = undefined;
    sqs = undefined;
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
    await simulator.start();
    endpoint = `http://127.0.0.1:${simulator.port}`;
    sns = new SNSClient({ endpoint, region, credentials, systemClockOffset: clock.now() - Date.now() });
    sqs = new SQSClient({ endpoint, region, credentials, systemClockOffset: clock.now() - Date.now() });
    let recovered: any;
    await settle(clock, async () => {
      recovered ??= (await sqs!.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0];
      return Boolean(recovered);
    });
    assert.equal(JSON.parse(recovered.Body).Message, "retry-safe");
    assert.ok((await simulator.sns.deliveryDiagnostics()).some(item =>
      item.deliveryId === retrying.deliveryId && item.status === "DELIVERED" && Number(item.attempts) === 6));
  } finally {
    sns?.destroy();
    sqs?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SNS-02 raw Query/XML mutates topic attributes and labeled permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns02-query-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const query = async (values: Record<string, string>) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-service": "sns" },
        body: new URLSearchParams({ Version: "2010-03-31", ...values }),
      });
      return { response, body: await response.text() };
    };
    const created = await query({ Action: "CreateTopic", Name: "sns02-query" });
    assert.equal(created.response.status, 200);
    const TopicArn = created.body.match(/<TopicArn>([^<]+)<\/TopicArn>/)?.[1];
    assert.ok(TopicArn);

    const set = await query({
      Action: "SetTopicAttributes",
      TopicArn,
      AttributeName: "SignatureVersion",
      AttributeValue: "2",
    });
    assert.equal(set.response.status, 200);
    assert.match(set.body, /<SetTopicAttributesResponse xmlns="https:\/\/sns\.amazonaws\.com\/doc\/2010-03-31\/">/);

    const added = await query({
      Action: "AddPermission",
      TopicArn,
      Label: "wire-publisher",
      "AWSAccountId.member.1": accountId,
      "ActionName.member.1": "Publish",
    });
    assert.equal(added.response.status, 200);
    const attributes = await query({ Action: "GetTopicAttributes", TopicArn });
    assert.equal(attributes.response.status, 200);
    assert.match(attributes.body, /<key>SignatureVersion<\/key><value>2<\/value>/);
    assert.match(attributes.body, /wire-publisher/);

    const removed = await query({ Action: "RemovePermission", TopicArn, Label: "wire-publisher" });
    assert.equal(removed.response.status, 200);
    const after = await query({ Action: "GetTopicAttributes", TopicArn });
    assert.doesNotMatch(after.body, /wire-publisher/);
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SNS-02 state migration supplies deterministic defaults without payload state", () => {
  const state: any = emptyState(accountId, region);
  state.schemaVersion = 60;
  state.accounts[accountId].regions[region].sns.topics.old = {
    name: "old",
    arn: `arn:aws:sns:${region}:${accountId}:old`,
    generation: "g",
    createdAt: 1,
    updatedAt: 1,
    tags: {},
    subscriptionArns: [`arn:aws:sns:${region}:${accountId}:old:s`],
  };
  state.accounts[accountId].regions[region].sns.subscriptions[`arn:aws:sns:${region}:${accountId}:old:s`] = {
    arn: `arn:aws:sns:${region}:${accountId}:old:s`,
    id: "s",
    generation: "sg",
    topicArn: `arn:aws:sns:${region}:${accountId}:old`,
    topicGeneration: "g",
    protocol: "sqs",
    endpoint: `arn:aws:sqs:${region}:${accountId}:old`,
    ownerAccountId: accountId,
    createdAt: 1,
  };
  const migrated = migrateState(state, accountId, region).state;
  const topic = migrated.accounts[accountId].regions[region].sns.topics.old;
  const subscription = migrated.accounts[accountId].regions[region].sns.subscriptions[`arn:aws:sns:${region}:${accountId}:old:s`];
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(topic.signatureVersion, "1");
  assert.equal(topic.sqsSuccessFeedbackSampleRate, 0);
  assert.equal(subscription.filterPolicyScope, "MessageAttributes");
  assert.equal(subscription.rawMessageDelivery, false);
  assert.deepEqual(migrated.accounts[accountId].regions[region].cloudwatch.snsActionOutbox, []);
  assert.deepEqual(migrated.accounts[accountId].regions[region].cloudformation.notificationOutbox, []);
  assert.equal((migrated as any).message, undefined);
});
