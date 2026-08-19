import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  AddPermissionCommand,
  CreateTopicCommand,
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  PublishBatchCommand,
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
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function settle(clock: TestClock, predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    clock.advance(0);
    await new Promise(resolve => setImmediate(resolve));
    if (Date.now() >= deadline) throw new Error("Timed out waiting for focused SNS gap behavior");
  }
}

async function waitForStack(client: CloudFormationClient, clock: TestClock, name: string, terminal: string): Promise<any> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    clock.advance(1_000);
    await new Promise(resolve => setTimeout(resolve, 50));
    try {
      const stack = (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
      if (stack?.StackStatus === terminal) return stack;
      if (stack?.StackStatus?.endsWith("_FAILED") || stack?.StackStatus?.includes("ROLLBACK")) {
        throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason ?? ""}`);
      }
    } catch (error: any) {
      if (terminal === "DELETE_COMPLETE" && error.name === "ValidationError") return undefined;
      throw error;
    }
  }
  throw new Error(`Timed out waiting for ${name} to reach ${terminal}`);
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

function policyWithSerializedSize(topicArn: string, targetBytes: number): string {
  const document = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { AWS: "*" }, Action: "SNS:Publish", Resource: topicArn }],
    Padding: "",
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(document));
  assert.ok(baseBytes < targetBytes);
  document.Padding = "x".repeat(targetBytes - baseBytes);
  const serialized = JSON.stringify(document);
  assert.equal(Buffer.byteLength(serialized), targetBytes);
  return serialized;
}

test("approved SNS API gaps preserve batch isolation, policy limits, labels, and DisplayName character counting", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns-gaps-api-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  let sns!: SNSClient;
  try {
    await simulator.start();
    sns = new SNSClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });

    const TopicArn = (await sns.send(new CreateTopicCommand({ Name: "sns-gap-api" }))).TopicArn!;
    const batch = await sns.send(new PublishBatchCommand({
      TopicArn,
      PublishBatchRequestEntries: [
        { Id: "good", Message: "accepted" },
        { Id: "bad-attributes", Message: "rejected", MessageAttributes: { bad: { DataType: "Unsupported", StringValue: "x" } } },
      ],
    }));
    assert.deepEqual(batch.Successful?.map(item => item.Id), ["good"]);
    assert.deepEqual(batch.Failed?.map(item => ({ Id: item.Id, SenderFault: item.SenderFault })), [{ Id: "bad-attributes", SenderFault: true }]);

    const binaryBatch = await sns.send(new PublishBatchCommand({
      TopicArn,
      PublishBatchRequestEntries: [
        { Id: "good-binary-sibling", Message: "accepted" },
        {
          Id: "bad-binary-attribute",
          Message: "x".repeat(150_000),
          MessageAttributes: { "AWS.invalid": { DataType: "Binary", BinaryValue: Buffer.alloc(90_000, 1) } },
        },
      ],
    }));
    assert.deepEqual(binaryBatch.Successful?.map(item => item.Id), ["good-binary-sibling"]);
    assert.deepEqual(binaryBatch.Failed?.map(item => item.Id), ["bad-binary-attribute"]);

    await assert.rejects(sns.send(new PublishBatchCommand({ TopicArn, PublishBatchRequestEntries: [
      { Id: "duplicate", Message: "one" },
      { Id: "duplicate", Message: "two" },
    ] })), /unique/i);
    await assert.rejects(sns.send(new PublishBatchCommand({ TopicArn, PublishBatchRequestEntries: [
      { Id: "large-one", Message: "a".repeat(131_073) },
      { Id: "large-two", Message: "b".repeat(131_073) },
    ] })), /aggregate batch payload|BatchRequestTooLong/i);

    const defaultPolicy = (await sns.send(new GetTopicAttributesCommand({ TopicArn }))).Attributes!.Policy!;
    const nearLimitPolicy = policyWithSerializedSize(TopicArn, 30_650);
    await sns.send(new SetTopicAttributesCommand({ TopicArn, AttributeName: "Policy", AttributeValue: nearLimitPolicy }));
    const beforeOversizedAdd = (await sns.send(new GetTopicAttributesCommand({ TopicArn }))).Attributes!.Policy!;
    await assert.rejects(sns.send(new AddPermissionCommand({
      TopicArn,
      Label: "would-exceed-policy-limit",
      AWSAccountId: [accountId],
      ActionName: ["Publish"],
    })), /30720|30.?720|larger than 30/i);
    assert.equal((await sns.send(new GetTopicAttributesCommand({ TopicArn }))).Attributes!.Policy, beforeOversizedAdd);

    await sns.send(new SetTopicAttributesCommand({ TopicArn, AttributeName: "Policy", AttributeValue: defaultPolicy }));
    await sns.send(new AddPermissionCommand({ TopicArn, Label: "known-label", AWSAccountId: [accountId], ActionName: ["Publish"] }));
    await sns.send(new RemovePermissionCommand({ TopicArn, Label: "known-label" }));
    const beforeUnknownRemove = (await sns.send(new GetTopicAttributesCommand({ TopicArn }))).Attributes!.Policy!;
    await assert.rejects(sns.send(new RemovePermissionCommand({ TopicArn, Label: "unknown-label" })), /does not exist|unknown-label/i);
    assert.equal((await sns.send(new GetTopicAttributesCommand({ TopicArn }))).Attributes!.Policy, beforeUnknownRemove);

    const multibyteDisplayName = "😀".repeat(60);
    const displayTopicArn = (await sns.send(new CreateTopicCommand({
      Name: "sns-gap-display-name",
      Attributes: { DisplayName: multibyteDisplayName },
    }))).TopicArn!;
    assert.equal((await sns.send(new GetTopicAttributesCommand({ TopicArn: displayTopicArn }))).Attributes!.DisplayName, multibyteDisplayName);
    await sns.send(new SetTopicAttributesCommand({ TopicArn: displayTopicArn, AttributeName: "DisplayName", AttributeValue: "a".repeat(100) }));
    await assert.rejects(sns.send(new SetTopicAttributesCommand({
      TopicArn: displayTopicArn,
      AttributeName: "DisplayName",
      AttributeValue: "a".repeat(101),
    })), /100 characters/i);
  } finally {
    sns?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("approved SNS filter gaps use cidr for IPv4/IPv6 and type-strict anything-but", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns-gaps-filter-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let sns!: SNSClient;
  let sqs!: SQSClient;
  try {
    await simulator.start();
    const configuration = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, systemClockOffset: clock.now() - Date.now() };
    sns = new SNSClient(configuration);
    sqs = new SQSClient(configuration);
    const TopicArn = (await sns.send(new CreateTopicCommand({ Name: "sns-gap-filter" }))).TopicArn!;
    const QueueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "sns-gap-filter-target" }))).QueueUrl!;
    const QueueArn = `arn:aws:sqs:${region}:${accountId}:sns-gap-filter-target`;
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: queuePolicy(QueueArn, TopicArn) } }));
    const SubscriptionArn = (await sns.send(new SubscribeCommand({
      TopicArn,
      Protocol: "sqs",
      Endpoint: QueueArn,
      Attributes: { RawMessageDelivery: "true", FilterPolicyScope: "MessageBody" },
    }))).SubscriptionArn!;

    const publishPair = async (policy: unknown, delivered: unknown, filtered: unknown): Promise<void> => {
      await sns.send(new SetSubscriptionAttributesCommand({
        SubscriptionArn,
        AttributeName: "FilterPolicy",
        AttributeValue: JSON.stringify(policy),
      }));
      const deliveredBody = JSON.stringify(delivered);
      const filteredBody = JSON.stringify(filtered);
      const deliveredId = (await sns.send(new PublishCommand({ TopicArn, Message: deliveredBody }))).MessageId!;
      const filteredId = (await sns.send(new PublishCommand({ TopicArn, Message: filteredBody }))).MessageId!;
      await settle(clock, async () => {
        const diagnostics = await simulator.sns.deliveryDiagnostics();
        return diagnostics.some(item => item.messageId === deliveredId && item.status === "DELIVERED")
          && diagnostics.some(item => item.messageId === filteredId && item.status === "FILTERED");
      });
      const received = (await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0];
      assert.equal(received?.Body, deliveredBody);
      await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: received!.ReceiptHandle! }));
      assert.equal((await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.length ?? 0, 0);
    };

    await publishPair({ source_ip: [{ cidr: "10.0.0.0/24" }] }, { source_ip: "10.0.0.42" }, { source_ip: "10.0.1.42" });
    await assert.rejects(sns.send(new SetSubscriptionAttributesCommand({
      SubscriptionArn,
      AttributeName: "FilterPolicy",
      AttributeValue: JSON.stringify({ source_ip: [{ ip: "10.0.0.0/24" }] }),
    })), /invalid matcher|FilterPolicy/i);
    await publishPair({ source_ip: [{ cidr: "2001:db8::/32" }] }, { source_ip: "2001:db8:abcd::1" }, { source_ip: "2001:db9::1" });

    await sns.send(new SetSubscriptionAttributesCommand({
      SubscriptionArn,
      AttributeName: "FilterPolicy",
      AttributeValue: JSON.stringify({ price: [{ "anything-but": [100] }] }),
    }));
    const stringId = (await sns.send(new PublishCommand({ TopicArn, Message: JSON.stringify({ price: "100" }) }))).MessageId!;
    const deniedNumberId = (await sns.send(new PublishCommand({ TopicArn, Message: JSON.stringify({ price: 100 }) }))).MessageId!;
    const allowedNumberBody = JSON.stringify({ price: 99 });
    const allowedNumberId = (await sns.send(new PublishCommand({ TopicArn, Message: allowedNumberBody }))).MessageId!;
    await settle(clock, async () => {
      const diagnostics = await simulator.sns.deliveryDiagnostics();
      return diagnostics.some(item => item.messageId === stringId && item.status === "FILTERED")
        && diagnostics.some(item => item.messageId === deniedNumberId && item.status === "FILTERED")
        && diagnostics.some(item => item.messageId === allowedNumberId && item.status === "DELIVERED");
    });
    const allowedNumber = (await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0];
    assert.equal(allowedNumber?.Body, allowedNumberBody);
    await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: allowedNumber!.ReceiptHandle! }));
    await assert.rejects(sns.send(new SetSubscriptionAttributesCommand({
      SubscriptionArn,
      AttributeName: "FilterPolicy",
      AttributeValue: JSON.stringify({ price: [{ "anything-but": [100, "x"] }] }),
    })), /one JSON type|same type|anything-but/i);
  } finally {
    sns?.destroy();
    sqs?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("approved SNS retain gap releases topic and inline-subscription ownership across restart", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns-gaps-retain-"));
  const clock = new TestClock(Date.now());
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let cloudformation!: CloudFormationClient;
  let sns!: SNSClient;
  let sqs!: SQSClient;
  const disconnect = () => {
    cloudformation?.destroy();
    sns?.destroy();
    sqs?.destroy();
  };
  const connect = () => {
    const configuration = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, systemClockOffset: clock.now() - Date.now() };
    cloudformation = new CloudFormationClient(configuration);
    sns = new SNSClient(configuration);
    sqs = new SQSClient(configuration);
  };
  const retainedTemplate = (queueArn: string, retain: boolean) => JSON.stringify({
    AWSTemplateFormatVersion: "2010-09-09",
    Resources: {
      RetainedTopic: {
        Type: "AWS::SNS::Topic",
        ...(retain ? { DeletionPolicy: "Retain" } : {}),
        Properties: {
          TopicName: "sns-gap-retained-topic",
          Subscription: [{ Protocol: "sqs", Endpoint: queueArn }],
        },
      },
    },
    Outputs: { TopicArn: { Value: { Ref: "RetainedTopic" } } },
  });
  try {
    await simulator.start();
    connect();
    const QueueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "sns-gap-retained-target" }))).QueueUrl!;
    const QueueArn = `arn:aws:sqs:${region}:${accountId}:sns-gap-retained-target`;
    const TopicArn = `arn:aws:sns:${region}:${accountId}:sns-gap-retained-topic`;
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: queuePolicy(QueueArn, TopicArn) } }));

    await cloudformation.send(new CreateStackCommand({ StackName: "sns-retain-old", TemplateBody: retainedTemplate(QueueArn, true) }));
    await waitForStack(cloudformation, clock, "sns-retain-old", "CREATE_COMPLETE");
    await cloudformation.send(new DeleteStackCommand({ StackName: "sns-retain-old" }));
    await waitForStack(cloudformation, clock, "sns-retain-old", "DELETE_COMPLETE");
    assert.equal((await sns.send(new GetTopicAttributesCommand({ TopicArn }))).Attributes!.TopicArn, TopicArn);
    assert.equal((await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn }))).Subscriptions?.length, 1);

    disconnect();
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
    await simulator.start();
    connect();
    assert.equal((await sns.send(new GetTopicAttributesCommand({ TopicArn }))).Attributes!.TopicArn, TopicArn);
    assert.equal((await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn }))).Subscriptions?.length, 1);

    await cloudformation.send(new CreateStackCommand({ StackName: "sns-retain-new", TemplateBody: retainedTemplate(QueueArn, false) }));
    await waitForStack(cloudformation, clock, "sns-retain-new", "CREATE_COMPLETE");
    assert.equal((await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn }))).Subscriptions?.length, 1);

    await cloudformation.send(new DeleteStackCommand({ StackName: "sns-retain-new" }));
    await waitForStack(cloudformation, clock, "sns-retain-new", "DELETE_COMPLETE");
    await assert.rejects(sns.send(new GetTopicAttributesCommand({ TopicArn })), /does not exist/i);
  } finally {
    disconnect();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
