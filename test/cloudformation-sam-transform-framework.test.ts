import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  CreateStackCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  GetTemplateSummaryCommand,
  UpdateStackCommand,
  ValidateTemplateCommand,
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
} from "@aws-sdk/client-cloudformation";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { StackSim } from "../src/server.js";
import {
  SERVERLESS_TRANSFORM,
  ServerlessTransformError,
  TemplateTransformError,
  declaredTransforms,
  expandServerlessTransform,
  prepareCloudFormationTemplate,
} from "../src/cloudformation/transforms.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const context = { region, partition: "aws", accountId: "000000000000" };
const execFileAsync = promisify(execFile);

function transformError(action: () => unknown): TemplateTransformError | ServerlessTransformError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof TemplateTransformError || error instanceof ServerlessTransformError, String(error));
    return error;
  }
  assert.fail("expected a transform error");
}

const SAM_BUCKET_ONLY = `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: SAM-01 identity expansion
Resources:
  ArtifactBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub "\${AWS::StackName}-artifacts"
Outputs:
  BucketName:
    Value: !Ref ArtifactBucket
  BucketArn:
    Value: !GetAtt ArtifactBucket.Arn
`;

const YAML_QUEUE_TOPIC = `AWSTemplateFormatVersion: "2010-09-09"
Description: >-
  Plain CloudFormation YAML with short-form tags
Parameters:
  Environment:
    Type: String
    Default: dev
    AllowedValues: [dev, prod]
Conditions:
  IsProd: !Equals [!Ref Environment, prod]
Resources:
  # A queue and a topic, as in the AWS sample templates.
  Queue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub "\${AWS::StackName}-\${Environment}"
      VisibilityTimeout: 45
      Tags:
        - Key: Environment
          Value: !Ref Environment
  Topic:
    Type: AWS::SNS::Topic
    Properties:
      DisplayName: !If [IsProd, Production alerts, !Join ["-", [dev, alerts]]]
Outputs:
  QueueArn:
    Description: The queue ARN
    Value: !GetAtt Queue.Arn
  TopicArn:
    Value: !Ref Topic
  Joined:
    Value: !Join
      - ":"
      - - !Select [0, !Split [",", "a,b"]]
        - !Ref "AWS::Region"
`;

test("transform admission accepts only the SAM transform and names every other boundary", () => {
  assert.deepEqual(declaredTransforms({ Resources: {} }), []);
  assert.deepEqual(declaredTransforms({ Transform: SERVERLESS_TRANSFORM }), [SERVERLESS_TRANSFORM]);
  assert.deepEqual(declaredTransforms({ Transform: [SERVERLESS_TRANSFORM] }), [SERVERLESS_TRANSFORM]);
  assert.equal(transformError(() => declaredTransforms({ Transform: [] })).message, "Transform must name at least one transform");
  assert.equal(transformError(() => declaredTransforms({ Transform: [SERVERLESS_TRANSFORM, SERVERLESS_TRANSFORM] })).message, `Transform ${SERVERLESS_TRANSFORM} is declared more than once`);
  assert.equal(transformError(() => declaredTransforms({ Transform: "MyMacro" })).message, "No transform named MyMacro found.");
  assert.equal(transformError(() => declaredTransforms({ Transform: "AWS::Include" })).message, "Transform AWS::Include is not supported by StackSim");
  assert.equal(transformError(() => declaredTransforms({ Transform: { Name: "AWS::Include", Parameters: { Location: "s3://b/k" } } })).message, "Transform AWS::Include is not supported by StackSim");
  assert.equal(transformError(() => declaredTransforms({ Transform: ["AWS::LanguageExtensions", SERVERLESS_TRANSFORM] })).message, "Transform AWS::LanguageExtensions is not supported by StackSim");
  assert.equal(transformError(() => declaredTransforms({ Transform: 42 })).message, "Transform must be a transform name or a list of transform names");
});

test("the SAM transform is an identity expansion without AWS::Serverless resources", () => {
  const document = { AWSTemplateFormatVersion: "2010-09-09", Transform: SERVERLESS_TRANSFORM, Resources: { Bucket: { Type: "AWS::S3::Bucket" } } };
  assert.deepEqual(expandServerlessTransform(document, context), { AWSTemplateFormatVersion: "2010-09-09", Resources: { Bucket: { Type: "AWS::S3::Bucket" } } });
  assert.equal(document.Transform, SERVERLESS_TRANSFORM, "expansion is pure");

  const first = prepareCloudFormationTemplate(SAM_BUCKET_ONLY, context);
  const second = prepareCloudFormationTemplate(SAM_BUCKET_ONLY, context);
  assert.deepEqual(first.transforms, [SERVERLESS_TRANSFORM]);
  assert.equal(first.transformedBody, second.transformedBody, "expansion is byte-for-byte deterministic");
  assert.equal(JSON.parse(first.transformedBody!).Transform, undefined);
  assert.equal(first.template.Resources.ArtifactBucket.Type, "AWS::S3::Bucket");
  assert.equal(prepareCloudFormationTemplate(YAML_QUEUE_TOPIC, context).transformedBody, undefined);
});

test("unimplemented AWS::Serverless resources, properties, and Globals fail the whole transform in the AWS format", () => {
  const error = transformError(() => expandServerlessTransform({
    Transform: SERVERLESS_TRANSFORM,
    Resources: {
      HelloWorldFunction: { Type: "AWS::Serverless::Function", Properties: { CodeUri: "s3://bucket/key", Handler: "app.handler", Runtime: "nodejs22.x", AutoPublishAlias: "live", DeploymentPreference: { Type: "AllAtOnce" } } },
      Bucket: { Type: "AWS::S3::Bucket" },
      App: { Type: "AWS::Serverless::Application" },
    },
  }, context));
  assert.equal(error.code, "ValidationError");
  assert.equal(error.message, "Transform AWS::Serverless-2016-10-31 failed with: Invalid Serverless Application Specification document. Number of errors found: 2. "
    + "Resource with id [HelloWorldFunction] is invalid. Property 'DeploymentPreference' is not supported by StackSim. "
    + "Resource with id [App] is invalid. Resource type AWS::Serverless::Application is not supported by StackSim.");
  assert.match(transformError(() => expandServerlessTransform({ Transform: SERVERLESS_TRANSFORM, Globals: { Function: { VpcConfig: { SubnetIds: [] } } }, Resources: {} }, context)).message, /Number of errors found: 1\. 'Globals' section is invalid\. 'VpcConfig' in 'Function' is not supported by StackSim\./);
});

async function withSimulator(prefix: string, run: (fixture: { root: string; simulator: StackSim; options: { endpoint: string; region: string; credentials: typeof credentials; maxAttempts: number } }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  try {
    await simulator.start();
    await run({ root, simulator, options: { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 } });
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function assertNoStack(client: CloudFormationClient, stackName: string): Promise<void> {
  await assert.rejects(client.send(new DescribeStacksCommand({ StackName: stackName })), (error: any) => error.name === "ValidationError" && error.message === `Stack with id ${stackName} does not exist`);
}

test("YAML templates deploy through the SDK and GetTemplate returns the original YAML", async () => {
  await withSimulator("stacksim-sam01-yaml-", async ({ options }) => {
    const client = new CloudFormationClient(options);
    try {
      const validated = await client.send(new ValidateTemplateCommand({ TemplateBody: YAML_QUEUE_TOPIC }));
      assert.equal(validated.Description, "Plain CloudFormation YAML with short-form tags");
      assert.deepEqual(validated.DeclaredTransforms ?? [], []);
      assert.deepEqual(validated.Parameters?.map(parameter => parameter.ParameterKey), ["Environment"]);

      const created = await client.send(new CreateStackCommand({ StackName: "yaml-queue-topic", TemplateBody: YAML_QUEUE_TOPIC }));
      assert.equal((await waitUntilStackCreateComplete({ client, minDelay: 1, maxDelay: 1, maxWaitTime: 20 }, { StackName: created.StackId })).state, "SUCCESS");
      const stack = (await client.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0];
      const outputs = Object.fromEntries((stack?.Outputs ?? []).map(output => [output.OutputKey, output.OutputValue]));
      assert.equal(outputs.QueueArn, "arn:aws:sqs:eu-west-1:000000000000:yaml-queue-topic-dev");
      assert.match(outputs.TopicArn ?? "", /^arn:aws:sns:eu-west-1:000000000000:/);
      assert.equal(outputs.Joined, "a:eu-west-1");
      assert.equal((await client.send(new GetTemplateCommand({ StackName: created.StackId }))).TemplateBody, YAML_QUEUE_TOPIC);
      assert.deepEqual((await client.send(new GetTemplateSummaryCommand({ StackName: created.StackId }))).ResourceTypes, ["AWS::SNS::Topic", "AWS::SQS::Queue"]);

      // A YAML update with an equivalent template is still a no-op.
      await assert.rejects(client.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: YAML_QUEUE_TOPIC.replace("# A queue", "# Still a queue") })), (error: any) => error.name === "ValidationError" && error.message === "No updates are to be performed.");
    } finally { client.destroy(); }
  });
});

test("malformed YAML fails with line and column before any stack mutation", async () => {
  await withSimulator("stacksim-sam01-malformed-", async ({ options, simulator }) => {
    const client = new CloudFormationClient(options);
    try {
      const cases: Array<[string, RegExp]> = [
        ["Resources:\n\tQueue:\n\t\tType: AWS::SQS::Queue\n", /\(line 2, column 1\): tab characters must not be used for indentation/],
        ["Resources:\n  Queue: &q\n    Type: AWS::SQS::Queue\n", /\(line 2, column 10\): anchors are not supported/],
        ["Resources:\n  Queue:\n    Type: AWS::SQS::Queue\n  Queue:\n    Type: AWS::SQS::Queue\n", /\(line 4, column 3\): duplicate mapping key "Queue"/],
        ["Resources:\n  Queue:\n    Type: AWS::SQS::Queue\n    Properties:\n      QueueName: !Reference Name\n", /\(line 5, column 18\): unknown tag !Reference/],
      ];
      for (const [index, [body, pattern]] of cases.entries()) {
        await assert.rejects(client.send(new CreateStackCommand({ StackName: `malformed-${index}`, TemplateBody: body })), (error: any) => error.name === "ValidationError" && /^Template format error: YAML not well-formed\./.test(error.message) && pattern.test(error.message));
        await assertNoStack(client, `malformed-${index}`);
      }
      assert.deepEqual(Object.keys(simulator.store.regionState(region).cloudformation.stacks), []);
    } finally { client.destroy(); }
  });
});

test("SAM transform admission, CAPABILITY_AUTO_EXPAND, processed templates, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-sam01-transform-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  let client: CloudFormationClient | undefined;
  let s3: S3Client | undefined;
  try {
    await simulator.start();
    const connect = () => {
      client = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
      s3 = new S3Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, forcePathStyle: true, maxAttempts: 1 });
    };
    connect();

    const summary = await client!.send(new GetTemplateSummaryCommand({ TemplateBody: SAM_BUCKET_ONLY }));
    assert.deepEqual(summary.DeclaredTransforms, [SERVERLESS_TRANSFORM]);
    assert.deepEqual(summary.ResourceTypes, ["AWS::S3::Bucket"]);
    assert.deepEqual(summary.Capabilities ?? [], []);
    assert.deepEqual((await client!.send(new ValidateTemplateCommand({ TemplateBody: SAM_BUCKET_ONLY }))).DeclaredTransforms, [SERVERLESS_TRANSFORM]);

    // CreateStack must acknowledge the transform; a change set need not.
    await assert.rejects(client!.send(new CreateStackCommand({ StackName: "sam-direct", TemplateBody: SAM_BUCKET_ONLY })), (error: any) => error.name === "InsufficientCapabilitiesException" && error.message === "Requires capabilities : [CAPABILITY_AUTO_EXPAND]");
    await assertNoStack(client!, "sam-direct");

    const planned = await client!.send(new CreateChangeSetCommand({ StackName: "sam-bucket", ChangeSetName: "initial", ChangeSetType: "CREATE", TemplateBody: SAM_BUCKET_ONLY }));
    const described = await client!.send(new DescribeChangeSetCommand({ ChangeSetName: planned.Id }));
    assert.equal(described.Status, "CREATE_COMPLETE");
    assert.deepEqual(described.Changes?.map(change => [change.ResourceChange?.LogicalResourceId, change.ResourceChange?.ResourceType, change.ResourceChange?.Action]), [["ArtifactBucket", "AWS::S3::Bucket", "Add"]]);
    const changeSetProcessed = JSON.parse(String((await client!.send(new GetTemplateCommand({ ChangeSetName: planned.Id, TemplateStage: "Processed" }))).TemplateBody));
    assert.equal(changeSetProcessed.Transform, undefined);
    await client!.send(new ExecuteChangeSetCommand({ ChangeSetName: planned.Id }));
    assert.equal((await waitUntilStackCreateComplete({ client: client!, minDelay: 1, maxDelay: 1, maxWaitTime: 20 }, { StackName: "sam-bucket" })).state, "SUCCESS");
    await s3!.send(new HeadBucketCommand({ Bucket: "sam-bucket-artifacts" }));
    const outputs = Object.fromEntries(((await client!.send(new DescribeStacksCommand({ StackName: "sam-bucket" }))).Stacks?.[0]?.Outputs ?? []).map(output => [output.OutputKey, output.OutputValue]));
    assert.deepEqual(outputs, { BucketName: "sam-bucket-artifacts", BucketArn: "arn:aws:s3:::sam-bucket-artifacts" });

    const original = await client!.send(new GetTemplateCommand({ StackName: "sam-bucket", TemplateStage: "Original" }));
    assert.equal(original.TemplateBody, SAM_BUCKET_ONLY);
    assert.deepEqual(original.StagesAvailable, ["Original", "Processed"]);
    const processedBody = String((await client!.send(new GetTemplateCommand({ StackName: "sam-bucket", TemplateStage: "Processed" }))).TemplateBody);
    const processed = JSON.parse(processedBody);
    assert.equal(processed.Transform, undefined);
    assert.deepEqual(processed.Resources, { ArtifactBucket: { Type: "AWS::S3::Bucket", Properties: { BucketName: { "Fn::Sub": "${AWS::StackName}-artifacts" } } } });
    assert.deepEqual((await client!.send(new GetTemplateSummaryCommand({ StackName: "sam-bucket" }))).DeclaredTransforms, [SERVERLESS_TRANSFORM]);

    // With the capability, CreateStack accepts the transform directly.
    const direct = await client!.send(new CreateStackCommand({ StackName: "sam-direct", TemplateBody: SAM_BUCKET_ONLY, Capabilities: ["CAPABILITY_AUTO_EXPAND"] }));
    assert.equal((await waitUntilStackCreateComplete({ client: client!, minDelay: 1, maxDelay: 1, maxWaitTime: 20 }, { StackName: direct.StackId })).state, "SUCCESS");

    // IAM capability checks see the processed template.
    const withRole = SAM_BUCKET_ONLY.replace("Outputs:", `  Role:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal: { Service: lambda.amazonaws.com }
            Action: sts:AssumeRole
Outputs:`);
    assert.deepEqual((await client!.send(new GetTemplateSummaryCommand({ TemplateBody: withRole }))).Capabilities, ["CAPABILITY_IAM"]);
    await assert.rejects(client!.send(new UpdateStackCommand({ StackName: "sam-direct", TemplateBody: withRole, Capabilities: ["CAPABILITY_AUTO_EXPAND"] })), (error: any) => error.name === "InsufficientCapabilitiesException" && error.message === "Requires capabilities : [CAPABILITY_IAM]");
    await assert.rejects(client!.send(new UpdateStackCommand({ StackName: "sam-direct", TemplateBody: withRole, Capabilities: ["CAPABILITY_IAM"] })), (error: any) => error.name === "InsufficientCapabilitiesException" && error.message === "Requires capabilities : [CAPABILITY_AUTO_EXPAND]");
    await client!.send(new UpdateStackCommand({ StackName: "sam-direct", TemplateBody: withRole, Capabilities: ["CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"] }));
    assert.equal((await waitUntilStackUpdateComplete({ client: client!, minDelay: 1, maxDelay: 1, maxWaitTime: 20 }, { StackName: "sam-direct" })).state, "SUCCESS");
    assert.equal(JSON.parse(String((await client!.send(new GetTemplateCommand({ StackName: "sam-direct", TemplateStage: "Processed" }))).TemplateBody)).Resources.Role.Type, "AWS::IAM::Role");

    // Restart preserves the original YAML and the processed template.
    client!.destroy(); s3!.destroy(); await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
    await simulator.start();
    connect();
    assert.equal((await client!.send(new GetTemplateCommand({ StackName: "sam-bucket" }))).TemplateBody, SAM_BUCKET_ONLY);
    assert.equal((await client!.send(new GetTemplateCommand({ StackName: "sam-bucket", TemplateStage: "Processed" }))).TemplateBody, processedBody);
    assert.equal((await client!.send(new DescribeStacksCommand({ StackName: "sam-bucket" }))).Stacks?.[0]?.StackStatus, "CREATE_COMPLETE");
  } finally {
    client?.destroy(); s3?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an unimplemented AWS::Serverless property fails the change set and CreateStack with no mutation", async () => {
  await withSimulator("stacksim-sam01-serverless-", async ({ options, simulator }) => {
    const client = new CloudFormationClient(options);
    const lambda = new LambdaClient(options);
    const template = `Transform: AWS::Serverless-2016-10-31
Resources:
  HelloWorldFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: s3://bucket/key
      Handler: app.lambdaHandler
      Runtime: nodejs22.x
      AutoPublishAlias: live
      DeploymentPreference:
        Type: AllAtOnce
`;
    const expected = "Transform AWS::Serverless-2016-10-31 failed with: Invalid Serverless Application Specification document. Number of errors found: 1. Resource with id [HelloWorldFunction] is invalid. Property 'DeploymentPreference' is not supported by StackSim.";
    try {
      const planned = await client.send(new CreateChangeSetCommand({ StackName: "sam-function", ChangeSetName: "initial", ChangeSetType: "CREATE", TemplateBody: template, Capabilities: ["CAPABILITY_IAM"] }));
      const described = await client.send(new DescribeChangeSetCommand({ ChangeSetName: planned.Id }));
      assert.equal(described.Status, "FAILED");
      assert.equal(described.ExecutionStatus, "UNAVAILABLE");
      assert.equal(described.StatusReason, expected);
      assert.equal((await client.send(new DescribeStacksCommand({ StackName: "sam-function" }))).Stacks?.[0]?.StackStatus, "REVIEW_IN_PROGRESS");
      await assert.rejects(client.send(new CreateStackCommand({ StackName: "sam-function-direct", TemplateBody: template, Capabilities: ["CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"] })), (error: any) => error.name === "ValidationError" && error.message === expected);
      await assertNoStack(client, "sam-function-direct");
      await assert.rejects(client.send(new ValidateTemplateCommand({ TemplateBody: template })), (error: any) => error.name === "ValidationError" && error.message === expected);
      assert.deepEqual((await lambda.send(new ListFunctionsCommand({}))).Functions ?? [], []);
      assert.deepEqual(Object.values(simulator.store.regionState(region).cloudformation.stacks).flatMap(stack => Object.keys(stack.resources)), []);

      const unknown = await client.send(new CreateChangeSetCommand({ StackName: "sam-function", ChangeSetName: "macro", ChangeSetType: "CREATE", TemplateBody: "Transform: MyMacro\nResources:\n  Topic:\n    Type: AWS::SNS::Topic\n" }));
      assert.equal((await client.send(new DescribeChangeSetCommand({ ChangeSetName: unknown.Id }))).StatusReason, "No transform named MyMacro found.");
    } finally { client.destroy(); lambda.destroy(); }
  });
});

test("nested YAML children with transforms need CAPABILITY_AUTO_EXPAND on the parent", async () => {
  await withSimulator("stacksim-sam01-nested-", async ({ options }) => {
    const client = new CloudFormationClient(options);
    const s3 = new S3Client({ ...options, forcePathStyle: true });
    try {
      await s3.send(new CreateBucketCommand({ Bucket: "sam01-nested-templates" }));
      await s3.send(new PutObjectCommand({ Bucket: "sam01-nested-templates", Key: "child.yaml", Body: "Transform: AWS::Serverless-2016-10-31\nResources:\n  Topic:\n    Type: AWS::SNS::Topic\nOutputs:\n  TopicArn:\n    Value: !Ref Topic\n" }));
      const parent = `Resources:
  Child:
    Type: AWS::CloudFormation::Stack
    Properties:
      TemplateURL: https://sam01-nested-templates.s3.${region}.amazonaws.com/child.yaml
Outputs:
  ChildTopic:
    Value: !GetAtt Child.Outputs.TopicArn
`;
      await assert.rejects(client.send(new CreateStackCommand({ StackName: "nested-sam", TemplateBody: parent })), (error: any) => error.name === "InsufficientCapabilitiesException" && error.message === "Requires capabilities : [CAPABILITY_AUTO_EXPAND]");
      await assertNoStack(client, "nested-sam");
      const created = await client.send(new CreateStackCommand({ StackName: "nested-sam", TemplateBody: parent, Capabilities: ["CAPABILITY_AUTO_EXPAND"] }));
      assert.equal((await waitUntilStackCreateComplete({ client, minDelay: 1, maxDelay: 1, maxWaitTime: 30 }, { StackName: created.StackId })).state, "SUCCESS");
      const outputs = (await client.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0]?.Outputs ?? [];
      assert.match(outputs.find(output => output.OutputKey === "ChildTopic")?.OutputValue ?? "", /^arn:aws:sns:eu-west-1:000000000000:/);
    } finally { client.destroy(); s3.destroy(); }
  });
});

async function awsCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync("aws", ["--version"], { timeout: 30_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

test("aws cloudformation deploy accepts YAML and SAM-transform templates", async t => {
  if (!await awsCliAvailable()) {
    t.skip("AWS CLI v2 is not installed or not on PATH; install it from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html to run this fixture");
    return;
  }
  await withSimulator("stacksim-sam01-cli-", async ({ root, options }) => {
    const env = {
      ...process.env,
      AWS_ACCESS_KEY_ID: "admin",
      AWS_SECRET_ACCESS_KEY: "password",
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
      AWS_ENDPOINT_URL: options.endpoint,
      AWS_CONFIG_FILE: join(root, "missing-aws-config"),
      AWS_SHARED_CREDENTIALS_FILE: join(root, "missing-aws-credentials"),
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_PAGER: "",
    };
    delete (env as Record<string, string | undefined>).AWS_PROFILE;
    delete (env as Record<string, string | undefined>).AWS_SESSION_TOKEN;
    const aws = (args: string[]) => execFileAsync("aws", [...args, "--endpoint-url", options.endpoint, "--region", region, "--no-cli-pager"], { env, timeout: 120_000, windowsHide: true });
    const client = new CloudFormationClient(options);
    try {
      const plainPath = join(root, "queue-topic.yaml");
      const samPath = join(root, "sam-bucket.yaml");
      await writeFile(plainPath, YAML_QUEUE_TOPIC);
      await writeFile(samPath, SAM_BUCKET_ONLY);

      await aws(["cloudformation", "deploy", "--template-file", plainPath, "--stack-name", "cli-yaml", "--parameter-overrides", "Environment=prod"]);
      const plain = (await client.send(new DescribeStacksCommand({ StackName: "cli-yaml" }))).Stacks?.[0];
      assert.equal(plain?.StackStatus, "CREATE_COMPLETE");
      assert.equal(plain?.Outputs?.find(output => output.OutputKey === "QueueArn")?.OutputValue, "arn:aws:sqs:eu-west-1:000000000000:cli-yaml-prod");
      assert.equal((await client.send(new GetTemplateCommand({ StackName: "cli-yaml" }))).TemplateBody, YAML_QUEUE_TOPIC);

      await aws(["cloudformation", "deploy", "--template-file", samPath, "--stack-name", "cli-sam"]);
      assert.equal((await client.send(new DescribeStacksCommand({ StackName: "cli-sam" }))).Stacks?.[0]?.StackStatus, "CREATE_COMPLETE");
      assert.equal(JSON.parse(String((await client.send(new GetTemplateCommand({ StackName: "cli-sam", TemplateStage: "Processed" }))).TemplateBody)).Transform, undefined);

      // Redeploying the same template reports no changes, as on AWS.
      const unchanged = await aws(["cloudformation", "deploy", "--template-file", samPath, "--stack-name", "cli-sam", "--no-fail-on-empty-changeset"]);
      assert.match(unchanged.stdout, /No changes to deploy/);
    } finally { client.destroy(); }
  });
});
