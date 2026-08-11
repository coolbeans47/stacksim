import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CloudWatchClient,
  GetMetricStreamCommand,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-cloudwatch";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import {
  GetFunctionCommand,
  GetFunctionConcurrencyCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { cdkBootstrapNames } from "../src/cloudformation/bootstrap.js";
import { StackSim } from "../src/server.js";
import { waitUntil } from "./support/polling.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const stackName = "cfn15-engine-lifecycle";
const metricStreamName = "cfn15-engine-metrics";
const globalTableName = "cfn15-engine-orders";
const firstQueueName = "cfn15-engine-first";
const secondQueueName = "cfn15-engine-second";
const lambdaStackName = "cfn15-lambda-create-auth";
const lambdaFunctionName = "cfn15-create-recovery-auth";

async function waitForStack(
  cloudformation: CloudFormationClient,
  stack: string,
  expected: string,
): Promise<any> {
  return waitUntil(
    async () => (await cloudformation.send(new DescribeStacksCommand({ StackName: stack }))).Stacks?.[0],
    current => {
      if (current?.StackStatus?.endsWith("_FAILED") || current?.StackStatus === "ROLLBACK_COMPLETE") {
        throw new Error(`${stack} reached ${current.StackStatus} while waiting for ${expected}: ${current.StackStatusReason ?? "no status reason"}`);
      }
      return current?.StackStatus === expected;
    },
    { timeoutMessage: current => `Timed out waiting for ${stack} to reach ${expected}; current=${current?.StackStatus} reason=${current?.StackStatusReason}` },
  );
}

function output(stack: any, key: string): string {
  const value = stack.Outputs?.find((entry: { OutputKey?: string }) => entry.OutputKey === key)?.OutputValue;
  assert.ok(value, `Expected stack output ${key}`);
  return value;
}

function list(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).map(String).sort();
}

function queuePolicyTemplate(outputDirectory: string, updated: boolean): string {
  const queueLogicalIds = updated ? ["FirstQueue"] : ["FirstQueue", "SecondQueue"];
  const resources = queueLogicalIds.map(logicalId => ({ "Fn::GetAtt": [logicalId, "Arn"] }));
  return JSON.stringify({
    Resources: {
      MetricStreamRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow",
              Principal: { Service: "streams.metrics.cloudwatch.amazonaws.com" },
              Action: "sts:AssumeRole",
            }],
          },
        },
      },
      MetricStream: {
        Type: "AWS::CloudWatch::MetricStream",
        Properties: {
          Name: metricStreamName,
          FirehoseArn: pathToFileURL(outputDirectory).href,
          RoleArn: { "Fn::GetAtt": ["MetricStreamRole", "Arn"] },
          OutputFormat: "json",
          IncludeFilters: [{
            Namespace: "Orders",
            MetricNames: updated ? ["Created", "Failed"] : ["Created"],
          }],
          Tags: [{ Key: "phase", Value: updated ? "updated" : "created" }],
        },
      },
      GlobalOrders: {
        Type: "AWS::DynamoDB::GlobalTable",
        Properties: {
          TableName: globalTableName,
          AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
          BillingMode: "PAY_PER_REQUEST",
          KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
          Replicas: [{ Region: region }, { Region: "us-east-1" }],
          StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
        },
      },
      FirstQueue: {
        Type: "AWS::SQS::Queue",
        Properties: { QueueName: firstQueueName, SqsManagedSseEnabled: true },
      },
      SecondQueue: {
        Type: "AWS::SQS::Queue",
        Properties: { QueueName: secondQueueName, SqsManagedSseEnabled: true },
      },
      QueuePolicy: {
        Type: "AWS::SQS::QueuePolicy",
        Properties: {
          Queues: queueLogicalIds.map(logicalId => ({ Ref: logicalId })),
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [{
              Sid: updated ? "ReadAttributes" : "Publish",
              Effect: "Allow",
              Principal: "*",
              Action: updated ? "sqs:GetQueueAttributes" : "sqs:SendMessage",
              Resource: updated ? resources[0] : resources,
            }],
          },
        },
      },
    },
    Outputs: {
      MetricStreamRoleName: { Value: { Ref: "MetricStreamRole" } },
      MetricStreamRoleArn: { Value: { "Fn::GetAtt": ["MetricStreamRole", "Arn"] } },
    },
  });
}

test("CFN-15 non-Lambda resources complete enforce-mode CloudFormation create, update, and delete", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn15-engine-"));
  const outputDirectory = await mkdtemp(join(tmpdir(), "stacksim-cfn15-stream-output-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    accountId,
    region,
    authMode: "enforce",
    cdkBootstrap: true,
    allowLocalFiles: true,
  });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = {
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials,
      maxAttempts: 1,
    };
    const cloudformation = new CloudFormationClient(options);
    const cloudwatch = new CloudWatchClient(options);
    const dynamodb = new DynamoDBClient(options);
    const iam = new IAMClient(options);
    const sqs = new SQSClient(options);
    clients.push(cloudformation, cloudwatch, dynamodb, iam, sqs);

    const bootstrap = cdkBootstrapNames(accountId, region);
    const created = await cloudformation.send(new CreateStackCommand({
      StackName: stackName,
      TemplateBody: queuePolicyTemplate(outputDirectory, false),
      Capabilities: ["CAPABILITY_IAM"],
      RoleARN: bootstrap.roleArns.cloudFormationExecution,
    }));
    const createdStack = await waitForStack(cloudformation, created.StackId!, "CREATE_COMPLETE");

    const roleName = output(createdStack, "MetricStreamRoleName");
    const roleArn = output(createdStack, "MetricStreamRoleArn");
    const authoritativeRole = (await iam.send(new GetRoleCommand({ RoleName: roleName }))).Role;
    assert.equal(authoritativeRole?.Arn, roleArn);

    let stream = await cloudwatch.send(new GetMetricStreamCommand({ Name: metricStreamName }));
    assert.equal(stream.RoleArn, roleArn, "the metric stream must use the same-stack role accepted by PassRole");
    assert.deepEqual(stream.IncludeFilters, [{ Namespace: "Orders", MetricNames: ["Created"] }]);
    let streamTags = (await cloudwatch.send(new ListTagsForResourceCommand({ ResourceARN: stream.Arn! }))).Tags ?? [];
    assert.equal(streamTags.find(tag => tag.Key === "phase")?.Value, "created");

    let table = (await dynamodb.send(new DescribeTableCommand({ TableName: globalTableName }))).Table;
    assert.deepEqual(table?.Replicas?.map(replica => replica.RegionName).sort(), [region, "us-east-1"].sort());
    assert.equal(table?.GlobalTableVersion, "2019.11.21");

    const firstUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: firstQueueName }))).QueueUrl!;
    const secondUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: secondQueueName }))).QueueUrl!;
    const firstAttributes = (await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: firstUrl,
      AttributeNames: ["All"],
    }))).Attributes ?? {};
    const secondAttributes = (await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: secondUrl,
      AttributeNames: ["All"],
    }))).Attributes ?? {};
    const initialFirstPolicy = JSON.parse(firstAttributes.Policy!);
    const initialSecondPolicy = JSON.parse(secondAttributes.Policy!);
    assert.equal(initialFirstPolicy.Id, initialSecondPolicy.Id);
    assert.deepEqual(list(initialFirstPolicy.Statement[0].Action), ["sqs:SendMessage"]);
    assert.deepEqual(
      list(initialFirstPolicy.Statement[0].Resource),
      [firstAttributes.QueueArn!, secondAttributes.QueueArn!].sort(),
    );

    await cloudformation.send(new UpdateStackCommand({
      StackName: created.StackId,
      TemplateBody: queuePolicyTemplate(outputDirectory, true),
      Capabilities: ["CAPABILITY_IAM"],
      RoleARN: bootstrap.roleArns.cloudFormationExecution,
    }));
    await waitForStack(cloudformation, created.StackId!, "UPDATE_COMPLETE");

    stream = await cloudwatch.send(new GetMetricStreamCommand({ Name: metricStreamName }));
    assert.deepEqual(stream.IncludeFilters, [{ Namespace: "Orders", MetricNames: ["Created", "Failed"] }]);
    streamTags = (await cloudwatch.send(new ListTagsForResourceCommand({ ResourceARN: stream.Arn! }))).Tags ?? [];
    assert.equal(streamTags.find(tag => tag.Key === "phase")?.Value, "updated");

    const updatedFirstAttributes = (await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: firstUrl,
      AttributeNames: ["All"],
    }))).Attributes ?? {};
    const updatedSecondAttributes = (await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: secondUrl,
      AttributeNames: ["All"],
    }))).Attributes ?? {};
    const updatedFirstPolicy = JSON.parse(updatedFirstAttributes.Policy!);
    assert.equal(updatedFirstPolicy.Id, initialFirstPolicy.Id);
    assert.deepEqual(list(updatedFirstPolicy.Statement[0].Action), ["sqs:GetQueueAttributes"]);
    assert.deepEqual(list(updatedFirstPolicy.Statement[0].Resource), [updatedFirstAttributes.QueueArn!]);
    assert.equal(updatedSecondAttributes.Policy, undefined, "the update must clear the policy from the previous queue target");

    table = (await dynamodb.send(new DescribeTableCommand({ TableName: globalTableName }))).Table;
    assert.deepEqual(table?.Replicas?.map(replica => replica.RegionName).sort(), [region, "us-east-1"].sort());

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
    await waitForStack(cloudformation, created.StackId!, "DELETE_COMPLETE");

    await assert.rejects(
      cloudwatch.send(new GetMetricStreamCommand({ Name: metricStreamName })),
      error => (error as { name?: string }).name === "ResourceNotFoundException",
    );
    await assert.rejects(
      dynamodb.send(new DescribeTableCommand({ TableName: globalTableName })),
      error => (error as { name?: string }).name === "ResourceNotFoundException",
    );
    await assert.rejects(
      sqs.send(new GetQueueUrlCommand({ QueueName: firstQueueName })),
      error => (error as { name?: string }).name === "QueueDoesNotExist",
    );
    await assert.rejects(
      sqs.send(new GetQueueUrlCommand({ QueueName: secondQueueName })),
      error => (error as { name?: string }).name === "QueueDoesNotExist",
    );
    await assert.rejects(
      iam.send(new GetRoleCommand({ RoleName: roleName })),
      error => ["NoSuchEntity", "NoSuchEntityException"].includes((error as { name?: string }).name ?? ""),
    );
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("CFN-15 Lambda Function create preauthorizes its composite recovery path", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn15-lambda-auth-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    accountId,
    region,
    authMode: "enforce",
    cdkBootstrap: true,
  });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = {
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials,
      maxAttempts: 1,
    };
    const cloudformation = new CloudFormationClient(options);
    const lambda = new LambdaClient(options);
    clients.push(cloudformation, lambda);

    const bootstrap = cdkBootstrapNames(accountId, region);
    const template = JSON.stringify({
      Resources: {
        FunctionRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [{
                Effect: "Allow",
                Principal: { Service: "lambda.amazonaws.com" },
                Action: "sts:AssumeRole",
              }],
            },
          },
        },
        Function: {
          Type: "AWS::Lambda::Function",
          Properties: {
            FunctionName: lambdaFunctionName,
            Runtime: "nodejs22.x",
            Handler: "index.handler",
            Role: { "Fn::GetAtt": ["FunctionRole", "Arn"] },
            Code: { ZipFile: "exports.handler = async () => ({ ok: true });" },
            ReservedConcurrentExecutions: 3,
            Tags: [{ Key: "phase", Value: "created" }],
          },
        },
      },
    });
    const created = await cloudformation.send(new CreateStackCommand({
      StackName: lambdaStackName,
      TemplateBody: template,
      Capabilities: ["CAPABILITY_IAM"],
      RoleARN: bootstrap.roleArns.cloudFormationExecution,
    }));
    await waitForStack(cloudformation, created.StackId!, "CREATE_COMPLETE");

    const current = await lambda.send(new GetFunctionCommand({ FunctionName: lambdaFunctionName }));
    assert.equal(current.Tags?.phase, "created");
    assert.equal((await lambda.send(new GetFunctionConcurrencyCommand({
      FunctionName: lambdaFunctionName,
    }))).ReservedConcurrentExecutions, 3);

    const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${lambdaFunctionName}`;
    const decisions = simulator.store.ensureAccount().iam.authorizationDecisions;
    for (const action of [
      "lambda:GetFunction",
      "lambda:ListTags",
      "lambda:UpdateFunctionConfiguration",
      "lambda:TagResource",
      "lambda:UntagResource",
      "lambda:PutFunctionConcurrency",
    ]) {
      assert.ok(
        decisions.some(decision =>
          decision.action === action
          && decision.resource === functionArn
          && decision.decision === "allowed"),
        `${action} must be preauthorized on the exact function ARN`,
      );
    }
    assert.ok(decisions.some(decision =>
      decision.action === "lambda:CreateFunction"
      && decision.resource === functionArn
      && decision.decision === "allowed"),
    "lambda:CreateFunction must be preauthorized on the exact function ARN");

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
    await waitForStack(cloudformation, created.StackId!, "DELETE_COMPLETE");
    await assert.rejects(
      lambda.send(new GetFunctionCommand({ FunctionName: lambdaFunctionName })),
      error => (error as { name?: string }).name === "ResourceNotFoundException",
    );
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
