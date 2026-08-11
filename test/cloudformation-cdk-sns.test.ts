import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App, CfnOutput, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { GetTopicAttributesCommand, SNSClient } from "@aws-sdk/client-sns";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function synthesize(): Record<string, unknown> {
  const app = new App();
  const stack = new Stack(app, "Sns03CdkFixture", { env: { account, region } });
  const deadLetterQueue = new sqs.Queue(stack, "DeadLetterQueue", { queueName: "sns03-cdk-dlq" });
  const targetQueue = new sqs.Queue(stack, "TargetQueue", { queueName: "sns03-cdk-target" });
  const topic = new sns.Topic(stack, "OrdersTopic", { topicName: "sns03-cdk-orders", displayName: "Orders" });
  topic.applyRemovalPolicy(RemovalPolicy.RETAIN);
  (topic.node.defaultChild as sns.CfnTopic).addPropertyOverride("SignatureVersion", "2");
  topic.addSubscription(new subscriptions.SqsSubscription(targetQueue, {
    rawMessageDelivery: true,
    deadLetterQueue,
    filterPolicy: {
      kind: sns.SubscriptionFilter.stringFilter({ allowlist: ["order.created"], matchPrefixes: ["priority."] }),
    },
  }));
  const handler = new lambda.Function(stack, "Handler", {
    functionName: "sns03-cdk-handler",
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async event => ({ received: event.Records.length });"),
  });
  topic.addSubscription(new subscriptions.LambdaSubscription(handler, {
    filterPolicyWithMessageBody: {
      detail: sns.FilterOrPolicy.policy({ state: sns.FilterOrPolicy.filter(sns.SubscriptionFilter.stringFilter({ allowlist: ["ready"] })) }),
    },
  }));
  topic.addToResourcePolicy(new iam.PolicyStatement({
    principals: [new iam.ServicePrincipal("events.amazonaws.com")],
    actions: ["sns:Publish"],
    resources: [topic.topicArn],
    conditions: { StringEquals: { "aws:SourceAccount": account } },
  }));

  const inlineTopic = new sns.CfnTopic(stack, "InlineTopic", { topicName: "sns03-cdk-inline" });
  new sns.CfnTopicInlinePolicy(stack, "InlinePolicy", {
    topicArn: inlineTopic.ref,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "cloudwatch.amazonaws.com" }, Action: "sns:Publish", Resource: inlineTopic.ref }],
    },
  });
  const l1Topic = new sns.CfnTopic(stack, "L1Topic", { topicName: "sns03-cdk-l1" });
  new sns.CfnSubscription(stack, "L1Subscription", {
    topicArn: l1Topic.ref,
    protocol: "sqs",
    endpoint: targetQueue.queueArn,
    rawMessageDelivery: false,
    redrivePolicy: { deadLetterTargetArn: deadLetterQueue.queueArn },
  });

  const imported = sns.Topic.fromTopicArn(stack, "ImportedTopic", `arn:aws:sns:${region}:${account}:external-topic`);
  new CfnOutput(stack, "TopicArn", { value: topic.topicArn });
  new CfnOutput(stack, "TopicName", { value: topic.topicName });
  new CfnOutput(stack, "ImportedArn", { value: imported.topicArn });
  return app.synth().getStackArtifact(stack.artifactId).template as Record<string, unknown>;
}

async function waitForStack(client: CloudFormationClient, clock: TestClock, name: string, terminal: string): Promise<any> {
  for (let attempt = 0; attempt < 300; attempt++) {
    clock.advance(500); await new Promise(resolve => setTimeout(resolve, 5));
    try {
      const stack = (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
      if (stack?.StackStatus === terminal) return stack;
      if (stack?.StackStatus?.includes("FAILED") || stack?.StackStatus?.includes("ROLLBACK")) throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason ?? ""}`);
    } catch (error: any) {
      if (terminal === "DELETE_COMPLETE" && error.name === "ValidationError") return undefined;
      throw error;
    }
  }
  throw new Error(`Timed out waiting for ${terminal}`);
}

test("repository-pinned unmodified CDK SNS L1/L2 constructs synthesize and deploy through the four SNS providers", async () => {
  const template = synthesize();
  const resources = (template.Resources ?? {}) as Record<string, { Type: string; Properties?: Record<string, unknown>; DeletionPolicy?: string }>;
  assert.ok(Object.values(resources).some(resource => resource.Type === "AWS::SNS::TopicPolicy"));
  assert.ok(Object.values(resources).some(resource => resource.Type === "AWS::SNS::TopicInlinePolicy"));
  assert.ok(Object.values(resources).filter(resource => resource.Type === "AWS::SNS::Subscription").length >= 3);
  assert.ok(Object.values(resources).some(resource => resource.Type === "AWS::SNS::Topic" && resource.DeletionPolicy === "Retain"));

  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-sns03-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off" });
  let cloudformation!: CloudFormationClient; let snsClient!: SNSClient;
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, systemClockOffset: clock.now() - Date.now() };
    cloudformation = new CloudFormationClient(options); snsClient = new SNSClient(options);
    await cloudformation.send(new CreateStackCommand({ StackName: "sns03-cdk-fixture", TemplateBody: JSON.stringify(template), Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"] }));
    const created = await waitForStack(cloudformation, clock, "sns03-cdk-fixture", "CREATE_COMPLETE");
    const outputs = Object.fromEntries(created.Outputs.map((item: any) => [item.OutputKey, item.OutputValue]));
    assert.equal(outputs.TopicName, "sns03-cdk-orders");
    assert.equal(outputs.ImportedArn, `arn:aws:sns:${region}:${account}:external-topic`);
    assert.equal((await snsClient.send(new GetTopicAttributesCommand({ TopicArn: outputs.TopicArn }))).Attributes!.SignatureVersion, "2");
    await cloudformation.send(new DeleteStackCommand({ StackName: "sns03-cdk-fixture" }));
    await waitForStack(cloudformation, clock, "sns03-cdk-fixture", "DELETE_COMPLETE");
    assert.equal((await snsClient.send(new GetTopicAttributesCommand({ TopicArn: outputs.TopicArn }))).Attributes!.TopicArn, outputs.TopicArn);
  } finally {
    cloudformation?.destroy(); snsClient?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
