import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  CreateStackCommand,
  DescribeChangeSetCommand,
  DescribeStackResourceCommand,
  DescribeStacksCommand,
  waitUntilStackCreateComplete,
} from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, CreateLogStreamCommand, FilterLogEventsCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { DescribeRuleCommand, EventBridgeClient, ListTargetsByRuleCommand } from "@aws-sdk/client-eventbridge";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { createEventRuleProvider } from "../src/cloudformation/providers/eventbridge-resources.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const sleep = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

/** Indent inline JavaScript under a YAML block scalar. */
const block = (source: string, indent: string) => source.trim().split("\n").map(line => `${indent}${line}`).join("\n");

const RECORDER = `
const zlib = require("node:zlib");
exports.handler = async (event) => {
  if (event.awslogs) console.log("LOGS " + zlib.gunzipSync(Buffer.from(event.awslogs.data, "base64")).toString());
  else console.log("EVENT " + JSON.stringify(event));
  return { statusCode: 200, body: "recorded" };
};`;

const FAILING = `
exports.handler = async () => { throw new Error("always fails"); };`;

// One SAM-03 feature per event, enforced under IAM: DynamoDB streams, SNS through a
// generated SQS subscription, CloudWatch Logs, a scheduled rule with a generated
// dead-letter queue, a public function URL, and an async OnFailure queue.
const TEMPLATE = `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  Table:
    Type: AWS::DynamoDB::Table
    Properties:
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions: [{ AttributeName: id, AttributeType: S }]
      KeySchema: [{ AttributeName: id, KeyType: HASH }]
      StreamSpecification: { StreamViewType: NEW_IMAGE }
  Topic:
    Type: AWS::SNS::Topic
  AppLogs:
    Type: AWS::Logs::LogGroup
  Recorder:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: nodejs22.x
      Handler: index.handler
      InlineCode: |
${block(RECORDER, "        ")}
      FunctionUrlConfig:
        AuthType: NONE
      Events:
        Stream:
          Type: DynamoDB
          Properties:
            Stream: !GetAtt Table.StreamArn
            StartingPosition: LATEST
            BatchSize: 1
        Notification:
          Type: SNS
          Properties:
            Topic: !Ref Topic
            SqsSubscription: true
        Logs:
          Type: CloudWatchLogs
          Properties:
            LogGroupName: !Ref AppLogs
            FilterPattern: ERROR
        Hourly:
          Type: Schedule
          Properties:
            Schedule: rate(1 hour)
            Input: '{"from":"schedule"}'
            RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 300 }
            DeadLetterConfig: { Type: SQS }
  Failing:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: nodejs22.x
      Handler: index.handler
      InlineCode: |
${block(FAILING, "        ")}
      EventInvokeConfig:
        MaximumRetryAttempts: 0
        DestinationConfig:
          OnFailure:
            Type: SQS
Outputs:
  RecorderUrl:
    Value: !GetAtt RecorderUrl.FunctionUrl
  FailureQueueUrl:
    Value: !Ref Failing.DestinationQueue
`;

test("SAM-03 event sources, function URLs, and async destinations deploy and deliver under IAM enforcement", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sam03-events-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options);
    const logs = new CloudWatchLogsClient(options);
    const dynamodb = new DynamoDBClient(options);
    const events = new EventBridgeClient(options);
    const lambda = new LambdaClient(options);
    const sns = new SNSClient(options);
    const sqs = new SQSClient(options);
    clients.push(cloudformation, logs, dynamodb, events, lambda, sns, sqs);

    await cloudformation.send(new CreateStackCommand({ StackName: "events", TemplateBody: TEMPLATE, Capabilities: ["CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"] }));
    const created = await waitUntilStackCreateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 90 }, { StackName: "events" });
    assert.equal(created.state, "SUCCESS", JSON.stringify(created.reason));
    const physical = async (logicalId: string) => (await cloudformation.send(new DescribeStackResourceCommand({ StackName: "events", LogicalResourceId: logicalId }))).StackResourceDetail!.PhysicalResourceId!;
    const outputs = Object.fromEntries(((await cloudformation.send(new DescribeStacksCommand({ StackName: "events" }))).Stacks![0].Outputs ?? []).map(output => [output.OutputKey!, output.OutputValue!]));
    const recorder = await physical("Recorder");
    const recorded = async (pattern: RegExp): Promise<string> => {
      for (let attempt = 0; attempt < 300; attempt++) {
        try {
          const found = (await logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${recorder}` }))).events?.find(event => pattern.test(event.message ?? ""));
          if (found) return found.message!;
        } catch (error: any) { if (error?.name !== "ResourceNotFoundException") throw error; }
        await sleep(50);
      }
      const seen = (await logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${recorder}` }))).events?.map(event => event.message);
      throw new Error(`Recorder never logged ${pattern}; saw ${JSON.stringify(seen)}`);
    };

    // DynamoDB stream → event source mapping, allowed by AWSLambdaDynamoDBExecutionRole.
    await dynamodb.send(new PutItemCommand({ TableName: await physical("Table"), Item: { id: { S: "stream-item" } } }));
    assert.match(await recorded(/"eventSource":"aws:dynamodb"/), /stream-item/);

    // SNS → generated queue (its policy admits the topic) → mapping.
    await sns.send(new PublishCommand({ TopicArn: await physical("Topic"), Message: "through the generated queue" }));
    assert.match(await recorded(/through the generated queue/), /"eventSource":"aws:sqs"/);

    // CloudWatch Logs subscription filter, permitted for logs.amazonaws.com.
    const group = await physical("AppLogs");
    await logs.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: "app" }));
    await logs.send(new PutLogEventsCommand({ logGroupName: group, logStreamName: "app", logEvents: [{ timestamp: Date.now(), message: "INFO fine" }, { timestamp: Date.now(), message: "ERROR broken" }] }));
    const subscribed = JSON.parse((await recorded(/^LOGS /)).slice(5));
    assert.deepEqual(subscribed.logEvents.map((event: { message: string }) => event.message), ["ERROR broken"]);

    // The public function URL answers without signing.
    const response = await fetch(outputs.RecorderUrl);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "recorded");

    // The scheduled rule targets the function with its retry policy and generated dead-letter queue.
    const rule = (await physical("RecorderHourly")).split("/").pop()!;
    assert.equal((await events.send(new DescribeRuleCommand({ Name: rule }))).ScheduleExpression, "rate(1 hour)");
    const [target] = (await events.send(new ListTargetsByRuleCommand({ Rule: rule }))).Targets!;
    assert.equal(target.Id, "RecorderHourlyLambdaTarget");
    assert.equal(target.Input, '{"from":"schedule"}');
    assert.deepEqual(target.RetryPolicy, { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 300 });
    assert.match(target.DeadLetterConfig!.Arn!, new RegExp(`^arn:aws:sqs:${region}:000000000000:${await physical("RecorderHourlyQueue")}$`));

    // A failed async invocation goes to the generated OnFailure queue, which the role may send to.
    await lambda.send(new InvokeCommand({ FunctionName: await physical("Failing"), InvocationType: "Event", Payload: Buffer.from("{}") }));
    let failure: string | undefined;
    for (let attempt = 0; attempt < 100 && !failure; attempt++) {
      failure = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: outputs.FailureQueueUrl, WaitTimeSeconds: 0 }))).Messages?.[0]?.Body;
      if (!failure) await sleep(50);
    }
    assert.ok(failure, "the OnFailure destination receives the failed event");
    assert.equal(JSON.parse(failure).requestContext.condition, "RetriesExhausted");
    assert.equal(JSON.parse(failure).responsePayload.errorMessage, "always fails");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SAM-03 boundaries fail the whole transform with the AWS-format error and create nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sam03-boundaries-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const cloudformation = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    clients.push(cloudformation);
    const fn = (events: string) => `Transform: AWS::Serverless-2016-10-31
Resources:
  Fn:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: nodejs22.x
      Handler: index.handler
      InlineCode: "exports.handler = async () => {};"
      Events:
${events}`;

    // A change set fails with SAM's message when the S3 bucket is not in the template.
    const outside = await cloudformation.send(new CreateChangeSetCommand({ StackName: "outside", ChangeSetName: "outside", ChangeSetType: "CREATE", TemplateBody: fn("        Upload:\n          Type: S3\n          Properties:\n            Bucket: some-existing-bucket\n            Events: s3:ObjectCreated:*\n"), Capabilities: ["CAPABILITY_IAM"] }));
    const changeSet = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: outside.Id }));
    assert.equal(changeSet.Status, "FAILED");
    assert.equal(changeSet.StatusReason, "Transform AWS::Serverless-2016-10-31 failed with: Invalid Serverless Application Specification document. Number of errors found: 1. Resource with id [Fn] is invalid. Event with id [Upload] is invalid. S3 events must reference an S3 bucket in the same template.");

    // Event types and properties outside the implemented subset fail CreateStack synchronously.
    for (const [events, reason] of [
      ["        Stream:\n          Type: Kinesis\n          Properties:\n            Stream: arn:aws:kinesis:eu-west-1:000000000000:stream/s\n            StartingPosition: LATEST\n", "Resource with id [Fn] is invalid. Event with id [Stream] is invalid. Event type 'Kinesis' is not supported by StackSim."],
      ["        Later:\n          Type: ScheduleV2\n          Properties:\n            ScheduleExpression: rate(1 hour)\n", "Resource with id [Fn] is invalid. Event with id [Later] is invalid. Event type 'ScheduleV2' is not supported by StackSim."],
      ["        Queue:\n          Type: SQS\n          Properties:\n            Queue: arn:aws:sqs:eu-west-1:000000000000:q\n            KmsKeyArn: arn:aws:kms:eu-west-1:000000000000:key/k\n", "Resource with id [Fn] is invalid. Event with id [Queue] is invalid. Property 'KmsKeyArn' is not supported by StackSim."],
    ]) {
      await assert.rejects(cloudformation.send(new CreateStackCommand({ StackName: "boundary", TemplateBody: fn(events), Capabilities: ["CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"] })), (error: any) => {
        assert.equal(error.name, "ValidationError");
        assert.equal(error.message, `Transform AWS::Serverless-2016-10-31 failed with: Invalid Serverless Application Specification document. Number of errors found: 1. ${reason}`);
        return true;
      });
      await assert.rejects(cloudformation.send(new DescribeStacksCommand({ StackName: "boundary" })), /does not exist/);
    }
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("AWS::Events::Rule accepts a ScheduleExpression without an EventPattern, on the default bus only", () => {
  const provider = createEventRuleProvider({} as never);
  const context = { accountId: "000000000000", region, partition: "aws" } as ProviderContext;
  const target = { Arn: `arn:aws:lambda:${region}:000000000000:function:f`, Id: "t", DeadLetterConfig: { Arn: `arn:aws:sqs:${region}:000000000000:dlq` } };
  const issues = (properties: Record<string, unknown>) => provider.validate(properties, context).map(issue => `${issue.path}: ${issue.message}`);
  assert.deepEqual(issues({ ScheduleExpression: "cron(0 * * * ? *)", Targets: [target] }), []);
  assert.deepEqual(issues({ ScheduleExpression: "rate(5 minutes)", EventPattern: { source: ["app"] } }), []);
  assert.deepEqual(issues({}), ["Properties: EventPattern or ScheduleExpression is required"]);
  assert.deepEqual(issues({ ScheduleExpression: "rate(1 hour)", EventBusName: "custom" }), ["Properties.EventBusName: Scheduled rules can be created only on the default event bus"]);
  assert.ok(issues({ ScheduleExpression: "at(2026-10-21T10:00:00)" }).includes("Properties.ScheduleExpression: Scheduled rules support only rate() and cron() expressions"));
  assert.ok(issues({ ScheduleExpression: "every hour" }).some(issue => issue.startsWith("Properties.ScheduleExpression: ")));
  assert.deepEqual(issues({ ScheduleExpression: "rate(1 hour)", Targets: [{ ...target, DeadLetterConfig: { Arn: "not-a-queue" } }] }), ["Properties.Targets.0.DeadLetterConfig.Arn: DeadLetterConfig.Arn must be an SQS queue ARN"]);
});
