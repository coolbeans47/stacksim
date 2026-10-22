import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App, Duration, Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, GetPolicyCommand, LambdaClient, ListEventSourceMappingsCommand } from "@aws-sdk/client-lambda";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { createLambdaEventSourceMappingProvider } from "../src/cloudformation/providers/lambda-event-configuration.js";
import { createLambdaFunctionProvider } from "../src/cloudformation/providers/lambda-function.js";
import { createLambdaPermissionProvider } from "../src/cloudformation/providers/lambda-companions.js";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

// LDP-05 (lambda-developer-parity-gaps.md): FIFO SQS mappings, permission principals and
// organization/token conditions, image-function templates, the inline code limit, and
// AWS-shaped generated function names.

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const role = `arn:aws:iam::${accountId}:role/parity-role`;
const identity: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };
const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });

function context(logicalId = "Handler"): ProviderContext {
  return {
    accountId, region, partition: "aws",
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/parity-stack/stack-id`,
    logicalId, operationId: "operation-1", resourceOperationId: `operation-1:${logicalId}`, idempotencyKey: `operation-1:${logicalId}`,
    deadlineAt: Date.now() + 60_000, principal: { identity },
  };
}

async function waitForStack(client: CloudFormationClient, clock: TestClock, stackName: string, terminalStatus: string): Promise<any> {
  for (let attempt = 0; attempt < 400; attempt++) {
    clock.advance(500);
    await new Promise(resolve => setTimeout(resolve, 5));
    try {
      const stack = (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
      if (stack?.StackStatus === terminalStatus) return stack;
      if (stack?.StackStatus?.includes("FAILED") || stack?.StackStatus?.includes("ROLLBACK")) throw new Error(`${stack.StackStatus}: ${stack.StackStatusReason ?? ""}`);
    } catch (error: any) {
      if (terminalStatus === "DELETE_COMPLETE" && error.name === "ValidationError") return undefined;
      throw error;
    }
  }
  throw new Error(`Timed out waiting for ${terminalStatus}`);
}

test("LDG-42/43/44: image templates, the 4 MB inline package limit, and 12-alphanumeric generated names", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ldp05-unit-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off" });
  try {
    await simulator.start();
    const provider = createLambdaFunctionProvider(simulator.lambda, simulator.s3);
    const zip = { ZipFile: "exports.handler = async () => undefined;" };

    // LDG-42: an image template fails on PackageType alone, not on the missing Handler/Runtime.
    const image = provider.validate({ PackageType: "Image", Role: role, Code: { ImageUri: `${accountId}.dkr.ecr.${region}.amazonaws.com/app:latest` } }, context());
    assert.ok(image.some(issue => issue.path === "Properties.PackageType" && /not supported in CloudFormation/.test(issue.message)));
    assert.ok(!image.some(issue => /requires property (?:Handler|Runtime)/.test(issue.message)));
    // Zip functions still require both.
    const missing = provider.validate({ Role: role, Code: zip }, context());
    assert.deepEqual(missing.filter(issue => issue.code === "MissingRequiredProperty").map(issue => issue.path).sort(), ["Properties.Handler", "Properties.Runtime"]);

    // LDG-43 (refuted): the CloudFormation limit is the 4 MB zipped inline package. aws-cdk-lib's S3 notifications
    // helper is ~5,000 characters of inline Python and deploys on AWS, so the CDK's 4096-character fromInline guard
    // is a CDK rule, not a service rule.
    const oversized = provider.validate({ Runtime: "nodejs22.x", Handler: "index.handler", Role: role, Code: { ZipFile: "x".repeat(4 * 1024 * 1024 + 1) } }, context());
    assert.ok(oversized.some(issue => issue.path === "Properties.Code.ZipFile" && /4 MB/.test(issue.message)));
    assert.equal(provider.validate({ Runtime: "nodejs22.x", Handler: "index.handler", Role: role, Code: { ZipFile: `${"// filler\n".repeat(500)}exports.handler = async () => 1;` } }, context()).length, 0);

    // LDG-44: generated names end in 12 alphanumerics and stay deterministic.
    const generated = provider.canonicalize({ Runtime: "nodejs22.x", Handler: "index.handler", Role: role, Code: zip }, context("ApiHandler"));
    assert.match(generated.FunctionName, /^parity-stack-ApiHandler-[A-Za-z0-9]{12}$/);
    assert.equal(provider.canonicalize({ Runtime: "nodejs22.x", Handler: "index.handler", Role: role, Code: zip }, context("ApiHandler")).FunctionName, generated.FunctionName);
    // A stack created before LDP-05 keeps its 10-hex name instead of replacing the function.
    const legacySuffix = createHash("sha256").update(`${context("ApiHandler").stackId}\0ApiHandler`).digest("hex").slice(0, 10);
    const legacy = { ...generated, FunctionName: generated.FunctionName.replace(/[A-Za-z0-9]{12}$/, legacySuffix) };
    const legacyPlan = provider.plan(legacy, generated, context("ApiHandler"));
    assert.notEqual(legacyPlan.action, "REPLACE");
    assert.equal(legacyPlan.desired.FunctionName, legacy.FunctionName);
    const foreign = { ...generated, FunctionName: "explicit-name" };
    assert.equal(provider.plan(foreign, generated, context("ApiHandler")).action, "REPLACE");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("LDG-40/41: provider validation admits FIFO SQS sources and AWS service principals with organization and token conditions", () => {
  const mapping = createLambdaEventSourceMappingProvider({} as any);
  const fifo = mapping.validate({ EventSourceArn: `arn:aws:sqs:${region}:${accountId}:orders.fifo`, FunctionName: "handler", BatchSize: 10 }, context());
  assert.ok(!fifo.some(issue => issue.path === "Properties.EventSourceArn"), JSON.stringify(fifo));
  const foreign = mapping.validate({ EventSourceArn: `arn:aws:kinesis:${region}:${accountId}:stream/orders`, FunctionName: "handler" }, context());
  assert.ok(foreign.some(issue => issue.path === "Properties.EventSourceArn"));

  const permission = createLambdaPermissionProvider({} as any);
  for (const principal of ["scheduler.amazonaws.com", "iot.amazonaws.com", "alexa-appkit.amazon.com", "*", "111122223333"]) {
    assert.deepEqual(permission.validate({ Action: "lambda:InvokeFunction", FunctionName: "handler", Principal: principal }, context()), [], principal);
  }
  assert.ok(permission.validate({ Action: "lambda:InvokeFunction", FunctionName: "handler", Principal: "not a principal" }, context()).some(issue => issue.path === "Properties.Principal"));
  assert.deepEqual(permission.validate({ Action: "lambda:InvokeFunction", FunctionName: "handler", Principal: "*", PrincipalOrgID: "o-abcdefghij", EventSourceToken: "amzn1.ask.skill.token" }, context()), []);
  assert.ok(permission.validate({ Action: "lambda:InvokeFunction", FunctionName: "handler", Principal: "*", PrincipalOrgID: "org-1" }, context()).some(issue => issue.path === "Properties.PrincipalOrgID"));
  const model = permission.canonicalize({ Action: "lambda:InvokeFunction", FunctionName: "handler", Principal: "scheduler.amazonaws.com", PrincipalOrgID: "o-abcdefghij", EventSourceToken: "token-1" }, context());
  assert.deepEqual(model, { Action: "lambda:InvokeFunction", FunctionName: "handler", Principal: "scheduler.amazonaws.com", PrincipalOrgID: "o-abcdefghij", EventSourceToken: "token-1" });
});

test("LDG-40: a CDK SqsEventSource on a FIFO queue deploys and LDG-41 permissions for scheduler and inert principals land as real policy statements", async () => {
  const app = new App();
  const stack = new Stack(app, "ParityFifoStack", { env: { account: accountId, region } });
  const queue = new sqs.Queue(stack, "Orders", { fifo: true, contentBasedDeduplication: true });
  const consumer = new lambda.Function(stack, "Consumer", {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async event => ({ records: event.Records.length });"),
    timeout: Duration.seconds(10),
  });
  consumer.addEventSource(new SqsEventSource(queue, { batchSize: 5 }));
  const template = app.synth().getStackArtifact(stack.artifactId).template as Record<string, any>;
  const synthesizedMapping = Object.values(template.Resources as Record<string, any>).find(resource => resource.Type === "AWS::Lambda::EventSourceMapping");
  assert.ok(synthesizedMapping);

  const root = await mkdtemp(join(tmpdir(), "stacksim-ldp05-cdk-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, clock, authMode: "off" });
  let cloudformation: CloudFormationClient | undefined; let lambdaClient: LambdaClient | undefined; let iam: IAMClient | undefined;
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, systemClockOffset: clock.now() - Date.now(), maxAttempts: 1 };
    cloudformation = new CloudFormationClient(options); lambdaClient = new LambdaClient(options); iam = new IAMClient(options);

    await cloudformation.send(new CreateStackCommand({ StackName: "parity-fifo", TemplateBody: JSON.stringify(template), Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"] }));
    const created = await waitForStack(cloudformation, clock, "parity-fifo", "CREATE_COMPLETE");
    assert.equal(created.StackStatus, "CREATE_COMPLETE");
    const mappings = (await lambdaClient.send(new ListEventSourceMappingsCommand({}))).EventSourceMappings ?? [];
    const fifoMapping = mappings.find(mapping => mapping.EventSourceArn?.endsWith(".fifo"));
    assert.ok(fifoMapping, JSON.stringify(mappings));
    assert.equal(fifoMapping.BatchSize, 5);

    // LDG-41: scheduler is a local invoking service; iot is accepted as an inert statement; PrincipalOrgID and EventSourceToken round-trip.
    await iam.send(new CreateRoleCommand({ RoleName: "parity-role", AssumeRolePolicyDocument: trust }));
    await lambdaClient.send(new CreateFunctionCommand({ FunctionName: "parity-target", Runtime: "nodejs22.x", Handler: "index.handler", Role: role, Code: { ZipFile: createZip([{ name: "index.js", content: "exports.handler = async () => 1;" }]) } }));
    const permissions = {
      Resources: {
        SchedulerPermission: { Type: "AWS::Lambda::Permission", Properties: { Action: "lambda:InvokeFunction", FunctionName: "parity-target", Principal: "scheduler.amazonaws.com", SourceArn: `arn:aws:scheduler:${region}:${accountId}:schedule/default/nightly`, SourceAccount: accountId } },
        OrganizationPermission: { Type: "AWS::Lambda::Permission", Properties: { Action: "lambda:InvokeFunction", FunctionName: "parity-target", Principal: "*", PrincipalOrgID: "o-abcdefghij" } },
        InertPermission: { Type: "AWS::Lambda::Permission", Properties: { Action: "lambda:InvokeFunction", FunctionName: "parity-target", Principal: "iot.amazonaws.com", EventSourceToken: "topic-rule-token" } },
      },
    };
    await cloudformation.send(new CreateStackCommand({ StackName: "parity-permissions", TemplateBody: JSON.stringify(permissions) }));
    await waitForStack(cloudformation, clock, "parity-permissions", "CREATE_COMPLETE");
    const statements = JSON.parse((await lambdaClient.send(new GetPolicyCommand({ FunctionName: "parity-target" }))).Policy!).Statement as any[];
    assert.equal(statements.length, 3);
    assert.ok(statements.some(statement => statement.Principal?.Service === "scheduler.amazonaws.com" && statement.Condition?.StringEquals?.["AWS:SourceAccount"] === accountId));
    assert.ok(statements.some(statement => statement.Principal === "*" && statement.Condition?.StringEquals?.["aws:PrincipalOrgID"] === "o-abcdefghij"));
    assert.ok(statements.some(statement => statement.Principal?.Service === "iot.amazonaws.com" && statement.Condition?.StringEquals?.["lambda:EventSourceToken"] === "topic-rule-token"));

    await cloudformation.send(new DeleteStackCommand({ StackName: "parity-permissions" }));
    await waitForStack(cloudformation, clock, "parity-permissions", "DELETE_COMPLETE");
    await assert.rejects(lambdaClient.send(new GetPolicyCommand({ FunctionName: "parity-target" })), /ResourceNotFoundException|The resource you requested does not exist/);
    await cloudformation.send(new DeleteStackCommand({ StackName: "parity-fifo" }));
    await waitForStack(cloudformation, clock, "parity-fifo", "DELETE_COMPLETE");
  } finally {
    cloudformation?.destroy(); lambdaClient?.destroy(); iam?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
