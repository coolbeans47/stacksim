import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CloudWatchClient,
  DescribeAlarmHistoryCommand,
  PutMetricAlarmCommand,
  SetAlarmStateCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  EventBridgeClient,
  PutEventsCommand,
  PutRuleCommand,
  PutTargetsCommand,
} from "@aws-sdk/client-eventbridge";
import {
  CreateTopicCommand,
  SetTopicAttributesCommand,
  SNSClient,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function waitForStack(client: CloudFormationClient, clock: TestClock, name: string): Promise<any> {
  for (let attempt = 0; attempt < 200; attempt++) {
    clock.advance(250);
    await new Promise(resolve => setTimeout(resolve, 5));
    const stack = (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
    if (stack?.StackStatus === "CREATE_COMPLETE") return stack;
    if (stack?.StackStatus?.includes("FAILED") || stack?.StackStatus?.includes("ROLLBACK")) throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason ?? ""}`);
  }
  throw new Error(`Timed out waiting for ${name}`);
}

async function receiveJson(sqs: SQSClient, queueUrl: string, clock: TestClock, accept: (value: any) => boolean): Promise<any> {
  for (let attempt = 0; attempt < 300; attempt++) {
    clock.advance(250);
    await new Promise(resolve => setTimeout(resolve, 5));
    const messages = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, VisibilityTimeout: 1 }))).Messages ?? [];
    for (const message of messages) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
      try {
        const value = JSON.parse(message.Body!);
        if (accept(value)) return value;
      } catch {}
    }
  }
  throw new Error("Timed out waiting for matching SNS delivery");
}

test("SNS-03 producer integrations publish durably from EventBridge, CloudWatch alarms, and CloudFormation notifications", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sns03-producers-"));
  const clock = new TestClock(Date.parse("2026-07-27T12:00:00Z"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, systemClockOffset: clock.now() - Date.now() };
    const sns = new SNSClient(options); const sqs = new SQSClient(options); const events = new EventBridgeClient(options);
    const cloudwatch = new CloudWatchClient(options); const cloudformation = new CloudFormationClient(options);
    clients.push(sns, sqs, events, cloudwatch, cloudformation);

    const topicArn = (await sns.send(new CreateTopicCommand({ Name: "sns03-integrations" }))).TopicArn!;
    const queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "sns03-integrations" }))).QueueUrl!;
    const queueArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: {
      Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": topicArn } } }] }),
    } }));
    await sns.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: "sqs", Endpoint: queueArn, Attributes: { RawMessageDelivery: "true" } }));
    await sns.send(new SetTopicAttributesCommand({
      TopicArn: topicArn,
      AttributeName: "Policy",
      AttributeValue: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sns:Publish", Resource: topicArn, Condition: { StringEquals: { "aws:SourceAccount": accountId } } },
          { Effect: "Allow", Principal: { Service: "cloudwatch.amazonaws.com" }, Action: "sns:Publish", Resource: topicArn, Condition: { StringEquals: { "aws:SourceAccount": accountId } } },
          { Effect: "Allow", Principal: { Service: "cloudformation.amazonaws.com" }, Action: "sns:Publish", Resource: topicArn, Condition: { StringEquals: { "aws:SourceAccount": accountId } } },
          { Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sns:*", Resource: topicArn },
        ],
      }),
    }));

    const ruleArn = (await events.send(new PutRuleCommand({ Name: "sns03-rule", EventPattern: JSON.stringify({ source: ["sns03.test"] }) }))).RuleArn!;
    assert.equal((await events.send(new PutTargetsCommand({ Rule: "sns03-rule", Targets: [{ Id: "topic", Arn: topicArn, InputTransformer: { InputPathsMap: { id: "$.detail.id" }, InputTemplate: "{\"producer\":\"eventbridge\",\"id\":<id>}" } }] }))).FailedEntryCount, 0);
    assert.equal((await events.send(new PutEventsCommand({ Entries: [{ Source: "sns03.test", DetailType: "SNS integration", Detail: JSON.stringify({ id: "event-1" }) }] }))).FailedEntryCount, 0);
    assert.deepEqual(await receiveJson(sqs, queueUrl, clock, value => value.producer === "eventbridge"), { producer: "eventbridge", id: "event-1" });
    assert.ok(ruleArn.endsWith("/sns03-rule"));

    await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "sns03-alarm", Namespace: "SNS03/Test", MetricName: "Missing", Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "notBreaching", AlarmActions: [topicArn] }));
    await cloudwatch.send(new SetAlarmStateCommand({ AlarmName: "sns03-alarm", StateValue: "ALARM", StateReason: "SNS-03 integration test" }));
    const alarmMessage = await receiveJson(sqs, queueUrl, clock, value => value.AlarmName === "sns03-alarm");
    assert.equal(alarmMessage.NewStateValue, "ALARM");
    for (let attempt = 0; attempt < 50; attempt++) {
      const history = (await cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "sns03-alarm", HistoryItemType: "Action" }))).AlarmHistoryItems ?? [];
      if (history.some(item => /Successfully executed/.test(item.HistorySummary ?? ""))) break;
      clock.advance(250); await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok((await cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: "sns03-alarm", HistoryItemType: "Action" }))).AlarmHistoryItems?.some(item => /Successfully executed/.test(item.HistorySummary ?? "")));

    await cloudformation.send(new CreateStackCommand({
      StackName: "sns03-notifications",
      NotificationARNs: [topicArn],
      TemplateBody: JSON.stringify({ AWSTemplateFormatVersion: "2010-09-09", Resources: {}, Outputs: { Topic: { Value: topicArn } } }),
    }));
    await waitForStack(cloudformation, clock, "sns03-notifications");
    const notification = await receiveJson(sqs, queueUrl, clock, value => value.StackName === "sns03-notifications");
    assert.equal(notification.StackId.includes(":stack/sns03-notifications/"), true);
    assert.equal(Object.hasOwn(notification, "ResourceProperties"), false);

    clients.forEach(client => client.destroy()); clients.length = 0;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
    await simulator.start();
    assert.deepEqual(simulator.store.regionState(region).cloudwatch.snsActionOutbox, []);
    assert.deepEqual(simulator.store.regionState(region).cloudformation.notificationOutbox, []);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
