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
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CreateQueueCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  GetSubscriptionAttributesCommand,
  GetTopicAttributesCommand,
  ListSubscriptionsCommand,
  SNSClient,
} from "@aws-sdk/client-sns";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const stackWaitTimeoutMs = 120_000;
const stackPollIntervalMs = 50;
const testTimeoutMs = (stackWaitTimeoutMs * 3) + 60_000;

async function waitForStack(client: CloudFormationClient, clock: TestClock, name: string, terminal: string[]): Promise<any> {
  const deadline = Date.now() + stackWaitTimeoutMs;
  let lastStatus = "not found";
  let lastReason = "";
  while (Date.now() < deadline) {
    clock.advance(1_000);
    await new Promise(resolve => setTimeout(resolve, stackPollIntervalMs));
    try {
      const stack = (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
      lastStatus = stack?.StackStatus ?? "not found";
      lastReason = stack?.StackStatusReason ?? "";
      if (stack && terminal.includes(stack.StackStatus!)) return stack;
      if (stack?.StackStatus?.endsWith("_FAILED") || stack?.StackStatus?.includes("ROLLBACK")) throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason ?? ""}`);
    } catch (error: any) {
      if (terminal.includes("DELETE_COMPLETE") && error.name === "ValidationError") return undefined;
      throw error;
    }
  }
  throw new Error(`Timed out after ${stackWaitTimeoutMs}ms waiting for ${name} to reach ${terminal.join(" or ")}; last status=${lastStatus}${lastReason ? ` reason=${lastReason}` : ""}`);
}

function template(queueArn: string, raw: boolean): string {
  return JSON.stringify({
    AWSTemplateFormatVersion: "2010-09-09",
    Resources: {
      Orders: {
        Type: "AWS::SNS::Topic",
        Properties: {
          TopicName: "cfn-sns-orders",
          DisplayName: "Orders",
          SignatureVersion: "2",
          Tags: [{ Key: "environment", Value: "test" }],
        },
      },
      Audit: {
        Type: "AWS::SNS::Topic",
        DeletionPolicy: "Retain",
        Properties: { TopicName: "cfn-sns-audit" },
      },
      QueueSubscription: {
        Type: "AWS::SNS::Subscription",
        Properties: {
          TopicArn: { Ref: "Orders" },
          Protocol: "sqs",
          Endpoint: queueArn,
          RawMessageDelivery: raw,
          FilterPolicyScope: "MessageAttributes",
          FilterPolicy: { kind: [{ prefix: "order-" }] },
        },
      },
      OrdersPolicy: {
        Type: "AWS::SNS::TopicPolicy",
        Properties: {
          Topics: [{ Ref: "Orders" }],
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow",
              Principal: { Service: "events.amazonaws.com" },
              Action: "sns:Publish",
              Resource: { Ref: "Orders" },
              Condition: { StringEquals: { "aws:SourceAccount": accountId } },
            }],
          },
        },
      },
      AuditPolicy: {
        Type: "AWS::SNS::TopicInlinePolicy",
        Properties: {
          TopicArn: { Ref: "Audit" },
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Principal: { Service: "cloudwatch.amazonaws.com" }, Action: "sns:Publish", Resource: { Ref: "Audit" } }],
          },
        },
      },
    },
    Outputs: {
      TopicArn: { Value: { Ref: "Orders" } },
      TopicName: { Value: { "Fn::GetAtt": ["Orders", "TopicName"] } },
      SubscriptionArn: { Value: { Ref: "QueueSubscription" } },
      InlinePolicyArn: { Value: { "Fn::GetAtt": ["AuditPolicy", "Arn"] } },
    },
  });
}

test("SNS-03 four CloudFormation providers deploy, update, retain and restore policies through SNS operations", { timeout: testTimeoutMs }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-sns03-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let cloudformation!: CloudFormationClient;
  let sqs!: SQSClient;
  let sns!: SNSClient;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const configuration = { endpoint, region, credentials, systemClockOffset: clock.now() - Date.now() };
    cloudformation = new CloudFormationClient(configuration);
    sqs = new SQSClient(configuration);
    sns = new SNSClient(configuration);
    const QueueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "cfn-sns-target" }))).QueueUrl!;
    const QueueArn = `arn:aws:sqs:${region}:${accountId}:cfn-sns-target`;
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: {
      Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: QueueArn }] }),
    } }));

    await cloudformation.send(new CreateStackCommand({ StackName: "sns-provider-stack", TemplateBody: template(QueueArn, false) }));
    const created = await waitForStack(cloudformation, clock, "sns-provider-stack", ["CREATE_COMPLETE"]);
    const outputs = Object.fromEntries(created.Outputs.map((item: any) => [item.OutputKey, item.OutputValue]));
    assert.equal(outputs.TopicName, "cfn-sns-orders");
    assert.match(outputs.TopicArn, /^arn:aws:sns:/);
    assert.match(outputs.SubscriptionArn, /^arn:aws:sns:.+:[0-9a-f-]{36}$/);
    assert.match((await sns.send(new GetTopicAttributesCommand({ TopicArn: outputs.TopicArn }))).Attributes!.Policy!, /events\.amazonaws\.com/);
    assert.equal((await sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: outputs.SubscriptionArn }))).Attributes!.RawMessageDelivery, "false");

    await cloudformation.send(new UpdateStackCommand({ StackName: "sns-provider-stack", TemplateBody: template(QueueArn, true) }));
    await waitForStack(cloudformation, clock, "sns-provider-stack", ["UPDATE_COMPLETE"]);
    assert.equal((await sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: outputs.SubscriptionArn }))).Attributes!.RawMessageDelivery, "true");

    await cloudformation.send(new DeleteStackCommand({ StackName: "sns-provider-stack" }));
    await waitForStack(cloudformation, clock, "sns-provider-stack", ["DELETE_COMPLETE"]);
    await assert.rejects(sns.send(new GetTopicAttributesCommand({ TopicArn: outputs.TopicArn })), /does not exist/);
    assert.equal((await sns.send(new GetTopicAttributesCommand({ TopicArn: outputs.InlinePolicyArn }))).Attributes!.TopicArn, outputs.InlinePolicyArn);
    assert.equal((await sns.send(new ListSubscriptionsCommand({}))).Subscriptions?.some(item => item.SubscriptionArn === outputs.SubscriptionArn) ?? false, false);
  } finally {
    cloudformation?.destroy();
    sqs?.destroy();
    sns?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
