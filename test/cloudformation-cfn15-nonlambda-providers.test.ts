import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { createCloudWatchMetricStreamProvider } from "../src/cloudformation/providers/cloudwatch-metric-stream.js";
import { createDynamoDbGlobalTableProvider } from "../src/cloudformation/providers/dynamodb-global-table.js";
import { createSqsQueuePolicyProvider } from "../src/cloudformation/providers/sqs-queue-policy.js";
import { createSqsQueueProvider } from "../src/cloudformation/providers/sqs-queue.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const identity: PrincipalContext = {
  accessKeyId: "admin",
  principalArn: `arn:aws:iam::${accountId}:root`,
  principalId: accountId,
  accountId,
};

function context(logicalId: string, callbackContext?: Readonly<Record<string, any>>): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/cfn15-nonlambda/stack-id`,
    logicalId,
    operationId: `operation-${logicalId}`,
    resourceOperationId: `resource-operation-${logicalId}`,
    idempotencyKey: `idempotency-${logicalId}`,
    deadlineAt: Date.now() + 60_000,
    ...(callbackContext ? { callbackContext } : {}),
    principal: { identity },
  };
}

async function settle(
  logicalId: string,
  invoke: (providerContext: ProviderContext) => Promise<any>,
): Promise<any> {
  let result = await invoke(context(logicalId));
  for (let attempt = 0; result.status === "IN_PROGRESS" && attempt < 80; attempt++) {
    await new Promise(resolve => setTimeout(resolve, Math.max(10, result.callbackAfterMs)));
    result = await invoke(context(logicalId, result.checkpoint.callbackContext));
  }
  assert.notEqual(result.status, "IN_PROGRESS", `${logicalId} did not stabilize within the callback budget`);
  return result;
}

test("CFN-15 non-Lambda providers use authoritative supported-service behavior", async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn15-providers-"));
  const output = await mkdtemp(join(tmpdir(), "stacksim-cfn15-metric-stream-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, allowLocalFiles: true, authMode: "off"});
  try {
    await simulator.start();

    await t.test("GlobalTable creates and removes current MREC replicas", async () => {
      const provider = createDynamoDbGlobalTableProvider(simulator.dynamodb);
      assert.throws(() => provider.canonicalize({
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        Replicas: [{ Region: region }],
      }, context("MissingBillingMode")), /BillingMode/);
      assert.throws(() => provider.canonicalize({
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        Replicas: [{ Region: region }, { Region: "us-east-1" }],
      }, context("MissingStream")), /StreamSpecification is required/);
      assert.doesNotThrow(() => provider.canonicalize({
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        Replicas: [{ Region: region }],
      }, context("SingleReplica")));
      const desired = provider.canonicalize({
        TableName: "cfn15-global-orders",
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        Replicas: [{ Region: region }, { Region: "us-east-1" }],
        StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
      }, context("GlobalOrders"));

      const created = await settle("GlobalOrders", current => provider.create(desired, current));
      assert.equal(created.status, "SUCCESS");
      if (created.status === "SUCCESS") {
        assert.equal(created.model.attributes.Arn, `arn:aws:dynamodb:${region}:${accountId}:table/cfn15-global-orders`);
        assert.equal(typeof created.model.attributes.TableId, "string");
        assert.equal(typeof created.model.attributes.StreamArn, "string");
      }
      const authoritative = (await simulator.dynamodb.DescribeTable({ TableName: desired.TableName })).Table;
      assert.deepEqual(authoritative.Replicas.map((replica: { RegionName: string }) => replica.RegionName).sort(), [region, "us-east-1"].sort());
      assert.equal(authoritative.GlobalTableVersion, "2019.11.21");

      const deleted = await settle("GlobalOrders", current => provider.delete(desired.TableName, desired, current));
      assert.equal(deleted.status, "SUCCESS");
      await assert.rejects(simulator.dynamodb.DescribeTable({ TableName: desired.TableName }), error => (error as { code?: string }).code === "ResourceNotFoundException");
    });

    await t.test("MetricStream manages executable local JSON delivery configuration and tags", async () => {
      const provider = createCloudWatchMetricStreamProvider(simulator.metrics);
      const providerContext = context("MetricStream");
      const initial = provider.canonicalize({
        Name: "cfn15-metrics",
        FirehoseArn: pathToFileURL(output).href,
        RoleArn: `arn:aws:iam::${accountId}:role/metric-stream-delivery`,
        OutputFormat: "json",
        IncludeFilters: [{ Namespace: "Orders", MetricNames: ["Created"] }],
        Tags: [{ Key: "service", Value: "orders" }],
      }, providerContext);
      const desired = provider.canonicalize({
        ...initial,
        IncludeFilters: [{ Namespace: "Orders", MetricNames: ["Created", "Failed"] }],
        Tags: [{ Key: "service", Value: "checkout" }],
      }, providerContext);

      const created = await provider.create(initial, providerContext);
      assert.equal(created.status, "SUCCESS");
      const updated = await provider.update(initial.Name, initial, desired, providerContext);
      assert.equal(updated.status, "SUCCESS");
      const authoritative = await simulator.metrics.metricStreams.GetMetricStream({ Name: initial.Name });
      assert.deepEqual(authoritative.IncludeFilters, [{ Namespace: "Orders", MetricNames: ["Created", "Failed"] }]);
      const tags = await simulator.metrics.ListTagsForResource({ ResourceARN: authoritative.Arn });
      assert.equal(tags.Tags.find((tag: { Key: string }) => tag.Key === "service")?.Value, "checkout");
      assert.equal((await provider.delete(initial.Name, desired, providerContext)).status, "SUCCESS");
    });

    await t.test("Queue and QueuePolicy support FIFO high throughput, SSE-SQS, ownership, update, and delete", async () => {
      const queueProvider = createSqsQueueProvider(simulator.sqs);
      const firstContext = context("FirstQueue");
      const secondContext = context("SecondQueue");
      const first = queueProvider.canonicalize({
        QueueName: "cfn15-first.fifo",
        FifoQueue: true,
        ContentBasedDeduplication: true,
        DeduplicationScope: "messageGroup",
        FifoThroughputLimit: "perMessageGroupId",
        SqsManagedSseEnabled: true,
      }, firstContext);
      const second = queueProvider.canonicalize({
        QueueName: "cfn15-second.fifo",
        FifoQueue: true,
        ContentBasedDeduplication: true,
        DeduplicationScope: "messageGroup",
        FifoThroughputLimit: "perMessageGroupId",
      }, secondContext);
      assert.equal(second.SqsManagedSseEnabled, true, "omitted SqsManagedSseEnabled follows the simulator/current SQS default");
      const firstCreated = await queueProvider.create(first, firstContext);
      const secondCreated = await queueProvider.create(second, secondContext);
      assert.equal(firstCreated.status, "SUCCESS");
      assert.equal(secondCreated.status, "SUCCESS");
      assert.equal(firstCreated.status === "SUCCESS" ? firstCreated.model.properties.SqsManagedSseEnabled : false, true);

      const firstUrl = firstCreated.status === "SUCCESS" ? String(firstCreated.model.attributes.QueueUrl) : "";
      const secondUrl = secondCreated.status === "SUCCESS" ? String(secondCreated.model.attributes.QueueUrl) : "";
      const policyProvider = createSqsQueuePolicyProvider(simulator.sqs);
      const policyContext = context("QueuePolicy");
      assert.throws(() => policyProvider.canonicalize({
        Queues: [firstUrl, firstUrl.replace("127.0.0.1", "localhost")],
        PolicyDocument: {
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Principal: "*",
            Action: "sqs:SendMessage",
            Resource: `arn:aws:sqs:${region}:${accountId}:${first.QueueName}`,
          }],
        },
      }, policyContext), /distinct queue resources/);
      const resources = [
        `arn:aws:sqs:${region}:${accountId}:${first.QueueName}`,
        `arn:aws:sqs:${region}:${accountId}:${second.QueueName}`,
      ];
      const initialPolicy = policyProvider.canonicalize({
        Queues: [firstUrl, secondUrl],
        PolicyDocument: {
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Principal: "*", Action: "sqs:SendMessage", Resource: resources }],
        },
      }, policyContext);
      assert.deepEqual(
        policyProvider.canonicalize(initialPolicy, policyContext),
        initialPolicy,
        "the engine must be able to re-canonicalize the persisted ARN model",
      );
      assert.ok(
        policyProvider.validate(initialPolicy, policyContext).some(issue => issue.path.startsWith("Properties.Queues.")),
        "the public template contract remains queue URLs",
      );
      const updatedPolicy = policyProvider.canonicalize({
        Queues: [firstUrl, secondUrl],
        PolicyDocument: {
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Principal: "*", Action: ["sqs:GetQueueAttributes", "sqs:SendMessage"], Resource: resources }],
        },
      }, policyContext);

      const policyCreated = await policyProvider.create(initialPolicy, policyContext);
      assert.equal(policyCreated.status, "SUCCESS", JSON.stringify(policyCreated));
      if (policyCreated.status === "SUCCESS") assert.equal(policyProvider.getAtt(policyCreated.model, "Id"), policyCreated.physicalId);
      const policyUpdated = await policyProvider.update(policyCreated.status === "SUCCESS" ? policyCreated.physicalId : "", initialPolicy, updatedPolicy, policyContext);
      assert.equal(policyUpdated.status, "SUCCESS");
      assert.equal((await policyProvider.read(policyCreated.status === "SUCCESS" ? policyCreated.physicalId : "", policyContext)).status, "SUCCESS");
      assert.equal((await policyProvider.delete(policyCreated.status === "SUCCESS" ? policyCreated.physicalId : "", updatedPolicy, policyContext)).status, "SUCCESS");
      const policyAttribute = (await simulator.sqs.GetQueueAttributes({ QueueUrl: firstUrl, AttributeNames: ["All"] })).Attributes?.Policy;
      assert.equal(policyAttribute, undefined);

      assert.equal((await queueProvider.delete(first.QueueName, first, firstContext)).status, "SUCCESS");
      assert.equal((await queueProvider.delete(second.QueueName, second, secondContext)).status, "SUCCESS");
    });
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});
