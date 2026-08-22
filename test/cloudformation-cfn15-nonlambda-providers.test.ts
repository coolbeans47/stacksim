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

    await t.test("CFN-18 GlobalTable backs the rich single-Region TableV2 lifecycle", async () => {
      const provider = createDynamoDbGlobalTableProvider(simulator.dynamodb);
      const providerContext = context("RichTableV2");
      const properties = {
        TableName: "cfn18-rich-table",
        AttributeDefinitions: [
          { AttributeName: "id", AttributeType: "S" }, { AttributeName: "type", AttributeType: "S" },
          { AttributeName: "email", AttributeType: "S" }, { AttributeName: "cid", AttributeType: "S" }, { AttributeName: "userId", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
        GlobalSecondaryIndexes: [
          { IndexName: "email-index", KeySchema: [{ AttributeName: "email", KeyType: "HASH" }], Projection: { ProjectionType: "KEYS_ONLY" } },
          { IndexName: "company-memberships-index", KeySchema: [{ AttributeName: "cid", KeyType: "HASH" }, { AttributeName: "userId", KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" } },
          { IndexName: "user-memberships-index", KeySchema: [{ AttributeName: "userId", KeyType: "HASH" }, { AttributeName: "cid", KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" } },
        ],
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }, { AttributeName: "type", KeyType: "RANGE" }],
        Replicas: [{ Region: region, DeletionProtectionEnabled: true, GlobalSecondaryIndexes: [{ IndexName: "email-index" }, { IndexName: "company-memberships-index" }, { IndexName: "user-memberships-index" }], PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 35 }, TableClass: "STANDARD", Tags: [{ Key: "Application", Value: "StackSimShipments" }, { Key: "Environment", Value: "dev" }] }],
        SSESpecification: { SSEEnabled: false },
      } as const;
      const desired = provider.canonicalize(properties, providerContext);
      assert.deepEqual(provider.plan(desired, desired, providerContext).action, "NO_OP");
      assert.throws(() => provider.canonicalize({ ...properties, Replicas: [{ ...properties.Replicas[0], Region: "us-east-1" }] }, providerContext), /stack Region/);
      assert.throws(() => provider.canonicalize({ ...properties, SSESpecification: { SSEEnabled: true } }, providerContext), /AWS-owned encryption/);

      const created = await settle("RichTableV2", current => provider.create(desired, current));
      assert.equal(created.status, "SUCCESS", JSON.stringify(created));
      const table = (await simulator.dynamodb.DescribeTable({ TableName: desired.TableName })).Table;
      assert.equal(table.DeletionProtectionEnabled, true);
      assert.equal(table.GlobalSecondaryIndexes.length, 3);
      assert.equal(table.TableClassSummary.TableClass, "STANDARD");
      assert.equal((await simulator.dynamodb.DescribeContinuousBackups({ TableName: desired.TableName })).ContinuousBackupsDescription.PointInTimeRecoveryDescription.RecoveryPeriodInDays, 35);
      const serviceTags = (await simulator.dynamodb.ListTagsOfResource({ ResourceArn: table.TableArn })).Tags;
      assert.equal(serviceTags.length, 3, "two user tags plus the private owner tag");

      await simulator.dynamodb.PutItem({ TableName: desired.TableName, Item: { id: { S: "one" }, type: { S: "member" }, email: { S: "a@example.test" }, cid: { S: "company" }, userId: { S: "user" } } });
      for (const [IndexName, expression, names, values] of [
        ["email-index", "#key = :value", { "#key": "email" }, { ":value": { S: "a@example.test" } }],
        ["company-memberships-index", "#key = :value", { "#key": "cid" }, { ":value": { S: "company" } }],
        ["user-memberships-index", "#key = :value", { "#key": "userId" }, { ":value": { S: "user" } }],
      ] as const) assert.equal((await simulator.dynamodb.Query({ TableName: desired.TableName, IndexName, KeyConditionExpression: expression, ExpressionAttributeNames: names, ExpressionAttributeValues: values })).Count, 1);

      const settings = provider.canonicalize({ ...properties, Replicas: [{ Region: region, DeletionProtectionEnabled: false, GlobalSecondaryIndexes: properties.Replicas[0].GlobalSecondaryIndexes, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false }, TableClass: "STANDARD_INFREQUENT_ACCESS", Tags: [{ Key: "Application", Value: "StackSimShipmentsV2" }] }] }, providerContext);
      const updated = await settle("RichTableV2", current => provider.update(desired.TableName, desired, settings, current));
      assert.equal(updated.status, "SUCCESS", JSON.stringify(updated));
      const afterSettings = (await simulator.dynamodb.DescribeTable({ TableName: desired.TableName })).Table;
      assert.equal(afterSettings.DeletionProtectionEnabled, false); assert.equal(afterSettings.TableClassSummary.TableClass, "STANDARD_INFREQUENT_ACCESS");
      assert.equal((await simulator.dynamodb.DescribeContinuousBackups({ TableName: desired.TableName })).ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus, "DISABLED");

      const withoutEmail = provider.canonicalize({ ...properties, AttributeDefinitions: properties.AttributeDefinitions.filter(item => item.AttributeName !== "email"), GlobalSecondaryIndexes: properties.GlobalSecondaryIndexes.filter(item => item.IndexName !== "email-index"), Replicas: [{ Region: region, DeletionProtectionEnabled: false, GlobalSecondaryIndexes: properties.Replicas[0].GlobalSecondaryIndexes.filter(item => item.IndexName !== "email-index"), PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false }, TableClass: "STANDARD_INFREQUENT_ACCESS", Tags: [{ Key: "Application", Value: "StackSimShipmentsV2" }] }] }, providerContext);
      const removed = await settle("RichTableV2", current => provider.update(desired.TableName, settings, withoutEmail, current));
      assert.equal(removed.status, "SUCCESS", JSON.stringify(removed));
      assert.ok(!(await simulator.dynamodb.DescribeTable({ TableName: desired.TableName })).Table.AttributeDefinitions.some((item: any) => item.AttributeName === "email"));

      assert.equal((await settle("RichTableV2", current => provider.delete(desired.TableName, withoutEmail, current))).status, "SUCCESS");
    });

    await t.test("CFN-18 stages both profile transitions through a no-mutation checkpoint", async () => {
      const provider = createDynamoDbGlobalTableProvider(simulator.dynamodb); const providerContext = context("ProfileTransition");
      const common = { TableName: "cfn18-profile-transition", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" } } as const;
      const rich = provider.canonicalize({ ...common, Replicas: [{ Region: region }] }, providerContext);
      const bare = provider.canonicalize({ ...common, Replicas: [{ Region: region }, { Region: "us-east-1" }] }, providerContext);
      assert.equal((await settle("ProfileTransition", current => provider.create(rich, current))).status, "SUCCESS");
      const first = await provider.update(rich.TableName, rich, bare, providerContext);
      assert.equal(first.status, "IN_PROGRESS"); assert.equal(first.status === "IN_PROGRESS" ? first.checkpoint.callbackContext.transition : false, true);
      assert.deepEqual(((await simulator.dynamodb.DescribeTable({ TableName: rich.TableName })).Table.Replicas ?? []).map((item: any) => item.RegionName), [], "the first transition callback must not mutate membership");
      const toBare = await settle("ProfileTransition", current => provider.update(rich.TableName, rich, bare, current)); assert.equal(toBare.status, "SUCCESS", JSON.stringify(toBare));
      assert.deepEqual((await simulator.dynamodb.DescribeTable({ TableName: rich.TableName })).Table.Replicas.map((item: any) => item.RegionName).sort(), [region, "us-east-1"].sort());
      const toRich = await settle("ProfileTransition", current => provider.update(rich.TableName, bare, rich, current)); assert.equal(toRich.status, "SUCCESS", JSON.stringify(toRich));
      assert.equal((await simulator.dynamodb.DescribeTable({ TableName: rich.TableName })).Table.Replicas?.length ?? 0, 0, "absence of the replica descriptor is the authoritative singleton form");
      assert.equal((await settle("ProfileTransition", current => provider.delete(rich.TableName, rich, current))).status, "SUCCESS");
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
