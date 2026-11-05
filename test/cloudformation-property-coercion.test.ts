import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetEventSourceMappingCommand, GetFunctionConfigurationCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetSubscriptionAttributesCommand, ListSubscriptionsCommand, SNSClient } from "@aws-sdk/client-sns";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { coerceDeclaredProperties, validateDeclaredProperties, type ProviderSchema } from "../src/cloudformation/providers/contract.js";
import { StackSim } from "../src/server.js";
import { waitUntil } from "./support/polling.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

const schema: ProviderSchema = {
  typeName: "Test::Coerced",
  unknownProperties: "REJECT",
  properties: {
    Count: { valueType: "number", updateBehavior: "MUTABLE" },
    Enabled: { valueType: "boolean", updateBehavior: "MUTABLE" },
    Name: { valueType: "string", updateBehavior: "MUTABLE" },
    Limits: { valueType: "object", updateBehavior: "MUTABLE", members: { Maximum: "number", Strict: "boolean" } },
    Document: { valueType: "object", updateBehavior: "MUTABLE", acceptsJsonString: true, members: { retries: "number" } },
    Plain: { valueType: "object", updateBehavior: "MUTABLE" },
  },
  ref: { supported: false },
  attributes: {},
  replacement: { defaultOrder: "CREATE_BEFORE_DELETE" },
  retention: { deletionPolicies: ["Delete"], updateReplacePolicies: ["Delete"], snapshotSupported: false },
  tags: { behavior: "NONE", propagatesCloudFormationTags: false },
};

test("declared numbers and booleans accept their string form and nothing else", () => {
  const input = { Count: "60", Enabled: "false", Name: "007", Limits: { Maximum: "5", Strict: "true", Other: "9" }, Document: "{\"retries\":\"3\",\"target\":\"x\"}", Plain: { n: "1" } };
  const snapshot = structuredClone(input);
  assert.deepEqual(coerceDeclaredProperties(input, schema), {
    Count: 60, Enabled: false, Name: "007", Limits: { Maximum: 5, Strict: true, Other: "9" }, Document: { retries: 3, target: "x" }, Plain: { n: "1" },
  });
  assert.deepEqual(input, snapshot, "the evaluated template properties are not mutated");
  assert.deepEqual(validateDeclaredProperties(input, schema), []);

  const native = { Count: 1.5, Enabled: true };
  assert.equal(coerceDeclaredProperties(native, schema), native, "values that already have the declared type are returned as-is");
  assert.deepEqual(coerceDeclaredProperties({ Count: "-12.5" }, schema), { Count: -12.5 });

  // Anything that is not a numeric string or exactly "true"/"false" stays a string and is still rejected.
  for (const [property, value, type] of [["Count", "soon", "number"], ["Count", "", "number"], ["Count", "1e3x", "number"], ["Count", " 5", "number"], ["Enabled", "yes", "boolean"], ["Enabled", "TRUE", "boolean"], ["Enabled", 1, "boolean"], ["Count", true, "number"], ["Plain", "{\"a\":1}", "object"], ["Document", "[1]", "object"], ["Document", "not json", "object"]] as const) {
    assert.deepEqual(coerceDeclaredProperties({ [property]: value }, schema), { [property]: value });
    assert.deepEqual(validateDeclaredProperties({ [property]: value }, schema).map(issue => issue.message), [`Test::Coerced property ${property} must be ${type}`]);
  }
});

test("templates that pass numbers and booleans as strings or parameters deploy", async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-coercion-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options); const sqs = new SQSClient(options); const dynamodb = new DynamoDBClient(options);
    const lambda = new LambdaClient(options); const sns = new SNSClient(options);
    clients.push(cloudformation, sqs, dynamodb, lambda, sns);

    const settle = async (StackName: string) => waitUntil(
      async () => (await cloudformation.send(new DescribeStacksCommand({ StackName }))).Stacks?.[0],
      stack => !String(stack?.StackStatus).endsWith("_IN_PROGRESS"),
      { timeoutMs: 60_000 },
    );
    const parameterList = (parameters: Record<string, string>) => Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }));
    const deploy = async (StackName: string, template: unknown, parameters: Record<string, string> = {}) => {
      await cloudformation.send(new CreateStackCommand({ StackName, TemplateBody: JSON.stringify(template), Capabilities: ["CAPABILITY_IAM"], Parameters: parameterList(parameters) }));
      const stack = await settle(StackName);
      assert.equal(stack?.StackStatus, "CREATE_COMPLETE", stack?.StackStatusReason);
      return Object.fromEntries(((await cloudformation.send(new DescribeStackResourcesCommand({ StackName }))).StackResources ?? []).map(resource => [resource.LogicalResourceId!, resource.PhysicalResourceId!]));
    };
    const queueAttributes = async (QueueUrl: string) => (await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["All"] }))).Attributes!;
    const outputs = async (StackName: string) => Object.fromEntries(((await cloudformation.send(new DescribeStacksCommand({ StackName }))).Stacks?.[0]?.Outputs ?? []).map(output => [output.OutputKey!, output.OutputValue!]));

    await t.test("an SQS queue takes Number and String parameters, quoted values and a JSON-string redrive policy", async () => {
      const template = {
        Parameters: {
          Timeout: { Type: "Number", Default: 60 },
          Fifo: { Type: "String", Default: "true", AllowedValues: ["true", "false"] },
          MaxReceive: { Type: "Number", Default: 3 },
        },
        Resources: {
          DeadLetters: { Type: "AWS::SQS::Queue", Properties: { FifoQueue: { Ref: "Fifo" }, RedriveAllowPolicy: "{\"redrivePermission\":\"allowAll\"}" } },
          Work: {
            Type: "AWS::SQS::Queue",
            Properties: {
              FifoQueue: { Ref: "Fifo" }, ContentBasedDeduplication: "true", VisibilityTimeout: { Ref: "Timeout" }, DelaySeconds: "5",
              RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": ["DeadLetters", "Arn"] }, maxReceiveCount: { Ref: "MaxReceive" } },
            },
          },
          Retry: {
            Type: "AWS::SQS::Queue",
            Properties: {
              FifoQueue: true,
              RedrivePolicy: { "Fn::Sub": ["{\"deadLetterTargetArn\":\"${Target}\",\"maxReceiveCount\":\"4\"}", { Target: { "Fn::GetAtt": ["DeadLetters", "Arn"] } }] },
            },
          },
        },
        Outputs: { Work: { Value: { Ref: "Work" } }, Retry: { Value: { Ref: "Retry" } }, DeadLetters: { Value: { Ref: "DeadLetters" } }, DeadLettersArn: { Value: { "Fn::GetAtt": ["DeadLetters", "Arn"] } } },
      };
      await deploy("coerce-queue", template);
      const urls = await outputs("coerce-queue");
      const work = await queueAttributes(urls.Work);
      assert.equal(work.FifoQueue, "true"); assert.equal(work.ContentBasedDeduplication, "true");
      assert.equal(work.VisibilityTimeout, "60"); assert.equal(work.DelaySeconds, "5");
      assert.deepEqual(JSON.parse(work.RedrivePolicy!), { deadLetterTargetArn: urls.DeadLettersArn, maxReceiveCount: 3 });
      assert.deepEqual(JSON.parse((await queueAttributes(urls.Retry)).RedrivePolicy!), { deadLetterTargetArn: urls.DeadLettersArn, maxReceiveCount: 4 });
      assert.deepEqual(JSON.parse((await queueAttributes(urls.DeadLetters)).RedriveAllowPolicy!), { redrivePermission: "allowAll" });

      // A changed parameter value is an in-place update of the same queue.
      await cloudformation.send(new UpdateStackCommand({ StackName: "coerce-queue", TemplateBody: JSON.stringify(template), Parameters: parameterList({ Timeout: "90", MaxReceive: "7" }) }));
      const updated = await settle("coerce-queue");
      assert.equal(updated?.StackStatus, "UPDATE_COMPLETE", updated?.StackStatusReason);
      assert.equal((await outputs("coerce-queue")).Work, urls.Work);
      const after = await queueAttributes(urls.Work);
      assert.equal(after.VisibilityTimeout, "90");
      assert.equal(JSON.parse(after.RedrivePolicy!).maxReceiveCount, 7);
    });

    await t.test("a string that is not a number or boolean is still rejected", async () => {
      for (const [properties, message] of [
        [{ VisibilityTimeout: "soon" }, /property VisibilityTimeout must be number/],
        [{ FifoQueue: "yes" }, /property FifoQueue must be boolean/],
        [{ VisibilityTimeout: "50000" }, /VisibilityTimeout must be an integer between 0 and 43200/],
        [{ RedrivePolicy: "not json" }, /property RedrivePolicy must be object/],
      ] as const) {
        await assert.rejects(
          cloudformation.send(new CreateStackCommand({ StackName: "coerce-rejected", TemplateBody: JSON.stringify({ Resources: { Q: { Type: "AWS::SQS::Queue", Properties: properties } } }) })),
          (error: any) => error.name === "ValidationError" && message.test(error.message),
          JSON.stringify(properties),
        );
      }
    });

    await t.test("the KMS refusals say that KMS is not emulated and name the alternative", async () => {
      await assert.rejects(
        cloudformation.send(new CreateStackCommand({ StackName: "coerce-kms-property", TemplateBody: JSON.stringify({ Resources: { Q: { Type: "AWS::SQS::Queue", Properties: { KmsMasterKeyId: "alias/aws/sqs", KmsDataKeyReusePeriodSeconds: 300 } } } }) })),
        (error: any) => error.name === "ValidationError" && /does not support property KmsMasterKeyId: StackSim does not emulate KMS; .*SqsManagedSseEnabled/.test(error.message) && /KmsDataKeyReusePeriodSeconds: StackSim does not emulate KMS/.test(error.message),
      );
      await assert.rejects(
        cloudformation.send(new CreateStackCommand({ StackName: "coerce-kms-key", TemplateBody: JSON.stringify({ Resources: { Key: { Type: "AWS::KMS::Key", Properties: { KeyPolicy: {} } }, Q: { Type: "AWS::SQS::Queue" } } }) })),
        (error: any) => error.name === "ValidationError" && /Unrecognized resource type AWS::KMS::Key; StackSim does not support it\. StackSim does not emulate KMS/.test(error.message) && /SqsManagedSseEnabled/.test(error.message) && !/phase/i.test(error.message),
      );
      await assert.rejects(
        cloudformation.send(new CreateStackCommand({ StackName: "coerce-unknown-type", TemplateBody: JSON.stringify({ Resources: { Bus: { Type: "AWS::Pipes::Pipe", Properties: {} } } }) })),
        (error: any) => error.name === "ValidationError" && error.message.endsWith("Unrecognized resource type AWS::Pipes::Pipe; StackSim does not support it"),
      );
    });

    await t.test("DynamoDB, SNS and Lambda resources coerce the same way", async () => {
      const role = { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }, ManagedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole"] } };
      const physical = await deploy("coerce-neighbours", {
        Parameters: { Capacity: { Type: "Number", Default: 5 }, FunctionTimeout: { Type: "Number", Default: 20 }, Batch: { Type: "Number", Default: 5 } },
        Resources: {
          Table: { Type: "AWS::DynamoDB::Table", Properties: { AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], ProvisionedThroughput: { ReadCapacityUnits: { Ref: "Capacity" }, WriteCapacityUnits: "2" } } },
          Queue: { Type: "AWS::SQS::Queue" },
          Topic: { Type: "AWS::SNS::Topic" },
          Policy: { Type: "AWS::SQS::QueuePolicy", Properties: { Queues: [{ Ref: "Queue" }], PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: { "Fn::GetAtt": ["Queue", "Arn"] } }] } } },
          Subscription: { Type: "AWS::SNS::Subscription", DependsOn: "Policy", Properties: { TopicArn: { Ref: "Topic" }, Protocol: "sqs", Endpoint: { "Fn::GetAtt": ["Queue", "Arn"] }, RawMessageDelivery: "true" } },
          Role: role,
          Function: { Type: "AWS::Lambda::Function", Properties: { Runtime: "nodejs22.x", Handler: "index.handler", Role: { "Fn::GetAtt": ["Role", "Arn"] }, Code: { ZipFile: "exports.handler = async () => ({});" }, Timeout: { Ref: "FunctionTimeout" }, MemorySize: "256" } },
          Mapping: { Type: "AWS::Lambda::EventSourceMapping", Properties: { EventSourceArn: { "Fn::GetAtt": ["Queue", "Arn"] }, FunctionName: { Ref: "Function" }, BatchSize: { Ref: "Batch" }, Enabled: "false" } },
        },
      });
      const table = (await dynamodb.send(new DescribeTableCommand({ TableName: physical.Table }))).Table!;
      assert.equal(table.ProvisionedThroughput?.ReadCapacityUnits, 5); assert.equal(table.ProvisionedThroughput?.WriteCapacityUnits, 2);
      const subscription = (await sns.send(new ListSubscriptionsCommand({}))).Subscriptions?.find(item => item.TopicArn === physical.Topic);
      assert.equal((await sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: subscription!.SubscriptionArn }))).Attributes?.RawMessageDelivery, "true");
      const configuration = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: physical.Function }));
      assert.equal(configuration.Timeout, 20); assert.equal(configuration.MemorySize, 256);
      const mapping = await waitUntil(() => lambda.send(new GetEventSourceMappingCommand({ UUID: physical.Mapping })), view => view.State === "Disabled", { timeoutMs: 15_000 });
      assert.equal(mapping.BatchSize, 5);
    });
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
