import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { GetEventSourceMappingCommand, GetFunctionEventInvokeConfigCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateQueueCommand, GetQueueAttributesCommand, ListQueueTagsCommand, ReceiveMessageCommand, SetQueueAttributesCommand, SQSClient, TagQueueCommand, UntagQueueCommand } from "@aws-sdk/client-sqs";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { createSqsQueueInlinePolicyProvider, createSqsQueuePolicyProvider } from "../src/cloudformation/providers/sqs-queue-policy.js";
import { StackSim } from "../src/server.js";
import { waitUntil } from "./support/polling.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const identity: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };

function providerContext(logicalId: string): ProviderContext {
  return {
    accountId, region, partition: "aws",
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/queue-policies/stack-id`,
    logicalId, operationId: `operation-${logicalId}`, resourceOperationId: `resource-operation-${logicalId}`, idempotencyKey: `idempotency-${logicalId}`,
    deadlineAt: Date.now() + 60_000, principal: { identity },
  };
}

const allow = (sid: string, service: string, resource: unknown) => ({ Sid: sid, Effect: "Allow", Principal: { Service: service }, Action: "sqs:SendMessage", Resource: resource });

test("CloudFormation templates around SQS queues deploy as written", async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-queue-policies-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off", cdkBootstrap: false });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options); const sqs = new SQSClient(options); const events = new EventBridgeClient(options); const lambda = new LambdaClient(options);
    clients.push(cloudformation, sqs, events, lambda);

    const settle = async (StackName: string) => waitUntil(
      async () => (await cloudformation.send(new DescribeStacksCommand({ StackName }))).Stacks?.[0],
      stack => !String(stack?.StackStatus).endsWith("_IN_PROGRESS"),
      { timeoutMs: 60_000 },
    );
    const deploy = async (StackName: string, template: unknown, update = false) => {
      const input = { StackName, TemplateBody: JSON.stringify(template), Capabilities: ["CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"] as const };
      await cloudformation.send(update ? new UpdateStackCommand({ ...input, Capabilities: [...input.Capabilities] }) : new CreateStackCommand({ ...input, Capabilities: [...input.Capabilities] }));
      const stack = await settle(StackName);
      assert.equal(stack?.StackStatus, update ? "UPDATE_COMPLETE" : "CREATE_COMPLETE", stack?.StackStatusReason);
      return Object.fromEntries((stack?.Outputs ?? []).map(output => [output.OutputKey!, output.OutputValue!]));
    };
    const remove = async (StackName: string) => {
      await cloudformation.send(new DeleteStackCommand({ StackName }));
      await waitUntil(
        async () => (await cloudformation.send(new DescribeStacksCommand({ StackName })).catch(() => undefined))?.Stacks?.[0]?.StackStatus,
        status => status === undefined || status === "DELETE_COMPLETE",
        { timeoutMs: 60_000 },
      );
    };
    const policyOf = async (QueueUrl: string): Promise<any> => {
      const policy = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["Policy"] }))).Attributes?.Policy;
      return policy === undefined ? undefined : JSON.parse(policy);
    };
    const apiQueue = async (QueueName: string, attributes: Record<string, string> = {}) => {
      const QueueUrl = (await sqs.send(new CreateQueueCommand({ QueueName, Attributes: attributes }))).QueueUrl!;
      return { QueueUrl, arn: (await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn! };
    };

    await t.test("a PolicyDocument Id is accepted and the document is stored as written", async () => {
      const outputs = await deploy("policy-with-id", {
        Resources: {
          Queue: { Type: "AWS::SQS::Queue" },
          Plain: { Type: "AWS::SQS::Queue" },
          Policy: { Type: "AWS::SQS::QueuePolicy", Properties: { Queues: [{ Ref: "Queue" }], PolicyDocument: { Version: "2012-10-17", Id: "MyQueuePolicy", Statement: [allow("FromSns", "sns.amazonaws.com", { "Fn::GetAtt": ["Queue", "Arn"] })] } } },
          PlainPolicy: { Type: "AWS::SQS::QueuePolicy", Properties: { Queues: [{ Ref: "Plain" }], PolicyDocument: { Version: "2012-10-17", Statement: [allow("FromSns", "sns.amazonaws.com", { "Fn::GetAtt": ["Plain", "Arn"] })] } } },
        },
        Outputs: { Queue: { Value: { Ref: "Queue" } }, Plain: { Value: { Ref: "Plain" } } },
      });
      const stored = await policyOf(outputs.Queue);
      assert.equal(stored.Id, "MyQueuePolicy");
      assert.equal(stored.Statement.length, 1); assert.equal(stored.Statement[0].Sid, "FromSns");
      const plain = await policyOf(outputs.Plain);
      assert.equal(Object.hasOwn(plain, "Id"), false, "no Id is added to a document that has none");
      await remove("policy-with-id");
    });

    await t.test("a later policy resource or an existing API policy is overwritten, and deletion only removes what the resource wrote", async () => {
      const existing = await apiQueue("policy-existing-queue");
      const apiPolicy = { Version: "2012-10-17", Id: "SetThroughTheApi", Statement: [allow("Api", "s3.amazonaws.com", existing.arn)] };
      await sqs.send(new SetQueueAttributesCommand({ QueueUrl: existing.QueueUrl, Attributes: { Policy: JSON.stringify(apiPolicy) } }));

      const first = { Version: "2012-10-17", Statement: [allow("First", "sns.amazonaws.com", existing.arn)] };
      const second = { Version: "2012-10-17", Statement: [allow("Second", "events.amazonaws.com", existing.arn)] };
      const resources = {
        First: { Type: "AWS::SQS::QueuePolicy", Properties: { Queues: [existing.QueueUrl], PolicyDocument: first } },
        Second: { Type: "AWS::SQS::QueuePolicy", DependsOn: "First", Properties: { Queues: [existing.QueueUrl], PolicyDocument: second } },
      };
      await deploy("policy-overwrite", { Resources: resources });
      assert.deepEqual((await policyOf(existing.QueueUrl)).Statement.map((statement: any) => statement.Sid), ["Second"], "the resource that deploys last wins");

      // Removing the first resource must not clear the policy the second one wrote.
      await deploy("policy-overwrite", { Resources: { Second: { ...resources.Second, DependsOn: undefined } } }, true);
      assert.deepEqual((await policyOf(existing.QueueUrl)).Statement.map((statement: any) => statement.Sid), ["Second"]);

      // A policy set through the API after deployment is not this resource's to remove.
      await sqs.send(new SetQueueAttributesCommand({ QueueUrl: existing.QueueUrl, Attributes: { Policy: JSON.stringify(apiPolicy) } }));
      await remove("policy-overwrite");
      assert.equal((await policyOf(existing.QueueUrl)).Id, "SetThroughTheApi");

      // A stack that still owns the stored policy removes it.
      await deploy("policy-owned", { Resources: { Only: { Type: "AWS::SQS::QueuePolicy", Properties: { Queues: [existing.QueueUrl], PolicyDocument: first } } } });
      assert.deepEqual((await policyOf(existing.QueueUrl)).Statement.map((statement: any) => statement.Sid), ["First"]);
      await remove("policy-owned");
      assert.equal(await policyOf(existing.QueueUrl), undefined);
    });

    await t.test("a policy written by an earlier release, marked in its Id, is still recognised as the stack's", async () => {
      const provider = createSqsQueuePolicyProvider(simulator.sqs);
      const context = providerContext("LegacyPolicy");
      const owner = createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex");
      const kept = await apiQueue("policy-legacy-kept"); const dropped = await apiQueue("policy-legacy-dropped");
      const document = (arn: string | string[]) => ({ Version: "2012-10-17", Statement: [allow("Legacy", "sns.amazonaws.com", arn)] });
      for (const queue of [kept, dropped]) {
        await sqs.send(new SetQueueAttributesCommand({ QueueUrl: queue.QueueUrl, Attributes: { Policy: JSON.stringify({ ...document([kept.arn, dropped.arn]), Id: `stacksim-cloudformation:${owner}` }) } }));
      }
      const physicalId = `sqs-queue-policy:${owner}`;
      const previous = provider.canonicalize({ Queues: [kept.QueueUrl, dropped.QueueUrl], PolicyDocument: document([kept.arn, dropped.arn]) }, context);
      const read = await provider.read(physicalId, context);
      assert.equal(read.status, "SUCCESS");
      assert.deepEqual(read.status === "SUCCESS" ? read.model.properties.Queues : [], [dropped.arn, kept.arn].sort());

      // An update rewrites the kept queue without the marker and releases the queue it no longer names.
      const desired = provider.canonicalize({ Queues: [kept.QueueUrl], PolicyDocument: { ...document(kept.arn), Id: "UserChosen" } }, context);
      assert.equal((await provider.update(physicalId, previous, desired, context)).status, "SUCCESS");
      assert.equal((await policyOf(kept.QueueUrl)).Id, "UserChosen");
      assert.equal(await policyOf(dropped.QueueUrl), undefined);

      // A delete of a resource that was never updated still finds its marked policy.
      await sqs.send(new SetQueueAttributesCommand({ QueueUrl: kept.QueueUrl, Attributes: { Policy: JSON.stringify({ ...document(kept.arn), Id: `stacksim-cloudformation:${owner}` }) } }));
      const marked = provider.canonicalize({ Queues: [kept.QueueUrl], PolicyDocument: document(kept.arn) }, context);
      assert.equal((await provider.delete(physicalId, marked, context)).status, "SUCCESS");
      assert.equal(await policyOf(kept.QueueUrl), undefined);
    });

    await t.test("AWS::SQS::QueueInlinePolicy attaches a policy to one queue and Ref returns the queue URL", async () => {
      const statement = (sid: string) => ({ Version: "2012-10-17", Statement: [allow(sid, "sns.amazonaws.com", { "Fn::GetAtt": ["Queue", "Arn"] })] });
      const template = (sid: string) => ({
        Resources: {
          Queue: { Type: "AWS::SQS::Queue" },
          Inline: { Type: "AWS::SQS::QueueInlinePolicy", Properties: { Queue: { Ref: "Queue" }, PolicyDocument: statement(sid) } },
        },
        Outputs: { Queue: { Value: { Ref: "Queue" } }, Inline: { Value: { Ref: "Inline" } } },
      });
      const outputs = await deploy("policy-inline", template("Initial"));
      assert.equal(outputs.Inline, outputs.Queue);
      assert.deepEqual((await policyOf(outputs.Queue)).Statement.map((item: any) => item.Sid), ["Initial"]);
      const resources = (await cloudformation.send(new DescribeStackResourcesCommand({ StackName: "policy-inline" }))).StackResources ?? [];
      assert.equal(resources.find(resource => resource.LogicalResourceId === "Inline")?.PhysicalResourceId, outputs.Queue);

      await deploy("policy-inline", template("Changed"), true);
      assert.deepEqual((await policyOf(outputs.Queue)).Statement.map((item: any) => item.Sid), ["Changed"]);

      // Removing only the policy resource clears the queue's policy and keeps the queue.
      const withoutPolicy = template("Changed"); delete (withoutPolicy.Resources as Record<string, unknown>).Inline; delete (withoutPolicy.Outputs as Record<string, unknown>).Inline;
      await deploy("policy-inline", withoutPolicy, true);
      assert.equal(await policyOf(outputs.Queue), undefined);
      await remove("policy-inline");

      const provider = createSqsQueueInlinePolicyProvider(simulator.sqs);
      const issues = provider.validate({ Queue: `arn:aws:sqs:${region}:${accountId}:by-arn`, PolicyDocument: { Version: "2012-10-17", Statement: [] } }, providerContext("Inline"));
      assert.ok(issues.some(issue => issue.path === "Properties.Queue"), "Queue must be a queue URL");
      await assert.rejects(
        cloudformation.send(new CreateStackCommand({ StackName: "policy-inline-missing", TemplateBody: JSON.stringify({ Resources: { Inline: { Type: "AWS::SQS::QueueInlinePolicy", Properties: { PolicyDocument: { Version: "2012-10-17", Statement: [] } } } } }) })),
        (error: any) => error.name === "ValidationError" && /requires property Queue/.test(error.message),
      );
    });

    await t.test("an AWS::Events::Rule delivers to a FIFO queue through SqsParameters", async () => {
      const outputs = await deploy("rule-fifo-target", {
        Resources: {
          Queue: { Type: "AWS::SQS::Queue", Properties: { FifoQueue: true, ContentBasedDeduplication: true } },
          Policy: { Type: "AWS::SQS::QueuePolicy", Properties: { Queues: [{ Ref: "Queue" }], PolicyDocument: { Version: "2012-10-17", Statement: [allow("FromEvents", "events.amazonaws.com", { "Fn::GetAtt": ["Queue", "Arn"] })] } } },
          Rule: {
            Type: "AWS::Events::Rule", DependsOn: "Policy",
            Properties: { EventPattern: { source: ["orders.test"] }, Targets: [{ Id: "queue", Arn: { "Fn::GetAtt": ["Queue", "Arn"] }, SqsParameters: { MessageGroupId: "orders" } }] },
          },
        },
        Outputs: { Queue: { Value: { Ref: "Queue" } } },
      });
      await events.send(new PutEventsCommand({ Entries: [{ Source: "orders.test", DetailType: "created", Detail: JSON.stringify({ id: 1 }) }] }));
      const message = await waitUntil(
        async () => (await sqs.send(new ReceiveMessageCommand({ QueueUrl: outputs.Queue, WaitTimeSeconds: 1, MessageSystemAttributeNames: ["MessageGroupId"] }))).Messages?.[0],
        value => value !== undefined,
        { timeoutMs: 20_000 },
      );
      assert.equal(message?.Attributes?.MessageGroupId, "orders");
      assert.deepEqual(JSON.parse(message!.Body!).detail, { id: 1 });
      await remove("rule-fifo-target");

      // The message group is required for a FIFO queue, as in the EventBridge API.
      await cloudformation.send(new CreateStackCommand({ StackName: "rule-fifo-missing-group", TemplateBody: JSON.stringify({
        Resources: {
          Queue: { Type: "AWS::SQS::Queue", Properties: { FifoQueue: true, ContentBasedDeduplication: true } },
          Rule: { Type: "AWS::Events::Rule", Properties: { EventPattern: { source: ["orders.test"] }, Targets: [{ Id: "queue", Arn: { "Fn::GetAtt": ["Queue", "Arn"] } }] } },
        },
      }) }));
      const failed = await settle("rule-fifo-missing-group");
      assert.equal(failed?.StackStatus, "ROLLBACK_COMPLETE");
      assert.match(failed?.StackStatusReason ?? "", /A FIFO queue target requires SqsParameters\.MessageGroupId/);
    });

    await t.test("an SQS event source mapping keeps its MetricsConfig", async () => {
      await deploy("mapping-metrics-config", {
        Resources: {
          Role: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }, ManagedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole"] } },
          Function: { Type: "AWS::Lambda::Function", Properties: { Runtime: "nodejs22.x", Handler: "index.handler", Role: { "Fn::GetAtt": ["Role", "Arn"] }, Code: { ZipFile: "exports.handler = async () => ({});" } } },
          Queue: { Type: "AWS::SQS::Queue" },
          Mapping: { Type: "AWS::Lambda::EventSourceMapping", Properties: { EventSourceArn: { "Fn::GetAtt": ["Queue", "Arn"] }, FunctionName: { Ref: "Function" }, Enabled: false, MetricsConfig: { Metrics: ["EventCount"] } } },
        },
      });
      const resources = (await cloudformation.send(new DescribeStackResourcesCommand({ StackName: "mapping-metrics-config" }))).StackResources ?? [];
      const uuid = resources.find(resource => resource.LogicalResourceId === "Mapping")?.PhysicalResourceId;
      assert.deepEqual((await lambda.send(new GetEventSourceMappingCommand({ UUID: uuid }))).MetricsConfig, { Metrics: ["EventCount"] });
    });

    await t.test("a function's EventInvokeConfig with only retry settings deploys with an empty DestinationConfig", async () => {
      await deploy("invoke-config-retries-only", {
        Transform: "AWS::Serverless-2016-10-31",
        Resources: {
          Worker: { Type: "AWS::Serverless::Function", Properties: { FunctionName: "invoke-config-retries-only", Runtime: "nodejs22.x", Handler: "index.handler", InlineCode: "exports.handler = async () => ({});", EventInvokeConfig: { MaximumRetryAttempts: 0 } } },
        },
      });
      const config = await lambda.send(new GetFunctionEventInvokeConfigCommand({ FunctionName: "invoke-config-retries-only", Qualifier: "$LATEST" }));
      assert.equal(config.MaximumRetryAttempts, 0);
      assert.equal(config.DestinationConfig?.OnFailure?.Destination, undefined);
      assert.equal(config.DestinationConfig?.OnSuccess?.Destination, undefined);
    });
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a stack-created queue carries the CloudFormation tags and hides the ownership marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-queue-tags-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off", cdkBootstrap: false });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options); const sqs = new SQSClient(options);
    clients.push(cloudformation, sqs);
    const settle = async () => waitUntil(
      async () => (await cloudformation.send(new DescribeStacksCommand({ StackName: "tagged-queue" }))).Stacks?.[0],
      stack => !String(stack?.StackStatus).endsWith("_IN_PROGRESS"),
      { timeoutMs: 60_000 },
    );
    const template = (visibility: number) => JSON.stringify({ Resources: { Jobs: { Type: "AWS::SQS::Queue", Properties: { VisibilityTimeout: visibility, Tags: [{ Key: "team", Value: "shop" }] } } }, Outputs: { Url: { Value: { Ref: "Jobs" } } } });
    await cloudformation.send(new CreateStackCommand({ StackName: "tagged-queue", TemplateBody: template(30) }));
    const created = await settle();
    assert.equal(created?.StackStatus, "CREATE_COMPLETE", created?.StackStatusReason);
    const QueueUrl = created!.Outputs![0].OutputValue!;
    const tags = (await sqs.send(new ListQueueTagsCommand({ QueueUrl }))).Tags ?? {};
    assert.deepEqual(Object.keys(tags).sort(), ["aws:cloudformation:logical-id", "aws:cloudformation:stack-id", "aws:cloudformation:stack-name", "team"]);
    assert.equal(tags["aws:cloudformation:stack-name"], "tagged-queue");
    assert.equal(tags["aws:cloudformation:logical-id"], "Jobs");
    assert.equal(tags["aws:cloudformation:stack-id"], created!.StackId);
    await assert.rejects(sqs.send(new TagQueueCommand({ QueueUrl, Tags: { "aws:cloudformation:stack-name": "forged" } })), (error: any) => error.name === "InvalidParameterValue");
    await assert.rejects(sqs.send(new UntagQueueCommand({ QueueUrl, TagKeys: ["aws:cloudformation:stack-name"] })), (error: any) => error.name === "InvalidParameterValue");

    await cloudformation.send(new UpdateStackCommand({ StackName: "tagged-queue", TemplateBody: template(45) }));
    const updated = await settle();
    assert.equal(updated?.StackStatus, "UPDATE_COMPLETE", updated?.StackStatusReason);
    assert.equal((await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["VisibilityTimeout"] }))).Attributes?.VisibilityTimeout, "45");
    assert.equal((await sqs.send(new ListQueueTagsCommand({ QueueUrl }))).Tags?.team, "shop");
    await cloudformation.send(new DeleteStackCommand({ StackName: "tagged-queue" }));
    await waitUntil(async () => { try { return (await cloudformation.send(new DescribeStacksCommand({ StackName: created!.StackId! }))).Stacks?.[0]?.StackStatus; } catch { return "DELETE_COMPLETE"; } }, status => status === "DELETE_COMPLETE", { timeoutMs: 60_000 });
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop();
    await rm(root, { recursive: true, force: true });
  }
});
