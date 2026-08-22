import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DescribeTableReplicaAutoScalingCommand,
  DynamoDBClient,
  GetItemCommand,
  ListTagsOfResourceCommand,
  PutItemCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateTableCommand,
  UpdateTableReplicaAutoScalingCommand,
} from "@aws-sdk/client-dynamodb";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function clientFor(simulator: StackSim): DynamoDBClient { return new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }); }
async function tick(clock: TestClock): Promise<void> { clock.advance(50); await new Promise<void>(resolve => setImmediate(resolve)); }
async function validation(promise: Promise<unknown>, name = "ValidationException"): Promise<void> { await assert.rejects(promise, (error: any) => error.name === name); }

test("DynamoDB table settings, tags, encryption, auto scaling, and update timestamps survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-settings-")); const clock = new TestClock(Date.parse("2026-07-15T22:00:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator);
    const created = await client.send(new CreateTableCommand({
      TableName: "ConfiguredRecords", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      DeletionProtectionEnabled: true, TableClass: "STANDARD_INFREQUENT_ACCESS", OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 7 }, WarmThroughput: { ReadUnitsPerSecond: 20, WriteUnitsPerSecond: 10 }, Tags: [{ Key: "team", Value: "platform" }, { Key: "environment", Value: "local" }],
    }));
    const arn = created.TableDescription!.TableArn!; assert.equal(created.TableDescription?.TableStatus, "CREATING"); assert.deepEqual(created.TableDescription?.OnDemandThroughput, { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 7 }); assert.deepEqual(created.TableDescription?.WarmThroughput, { ReadUnitsPerSecond: 20, WriteUnitsPerSecond: 10, Status: "CREATING" }); assert.equal(created.TableDescription?.DeletionProtectionEnabled, true); assert.equal(created.TableDescription?.TableClassSummary?.TableClass, "STANDARD_INFREQUENT_ACCESS"); assert.equal(created.TableDescription?.SSEDescription, undefined);
    await tick(clock);
    assert.equal((await client.send(new DescribeTableCommand({ TableName: arn }))).Table?.TableName, "ConfiguredRecords"); assert.deepEqual((await client.send(new ListTagsOfResourceCommand({ ResourceArn: arn }))).Tags, [{ Key: "environment", Value: "local" }, { Key: "team", Value: "platform" }]);
    assert.deepEqual((await client.send(new DescribeTableCommand({ TableName: "ConfiguredRecords" }))).Table?.WarmThroughput, { ReadUnitsPerSecond: 20, WriteUnitsPerSecond: 10, Status: "ACTIVE" });
    await client.send(new TagResourceCommand({ ResourceArn: arn, Tags: [{ Key: "team", Value: "database" }, { Key: "owner", Value: "learning" }] })); await client.send(new UntagResourceCommand({ ResourceArn: arn, TagKeys: ["environment"] })); assert.deepEqual((await client.send(new ListTagsOfResourceCommand({ ResourceArn: arn }))).Tags, [{ Key: "owner", Value: "learning" }, { Key: "team", Value: "database" }]);
    await validation(client.send(new TagResourceCommand({ ResourceArn: arn, Tags: [{ Key: "aws:reserved", Value: "no" }] }))); await validation(client.send(new DeleteTableCommand({ TableName: "ConfiguredRecords" })));

    const updating = await client.send(new UpdateTableCommand({ TableName: arn, DeletionProtectionEnabled: false, TableClass: "STANDARD", OnDemandThroughput: { MaxReadRequestUnits: -1, MaxWriteRequestUnits: 9 }, WarmThroughput: { ReadUnitsPerSecond: 30, WriteUnitsPerSecond: 12 }, SSESpecification: { Enabled: true, SSEType: "KMS", KMSMasterKeyId: "arn:aws:kms:eu-west-1:000000000000:key/local-only" } }));
    assert.equal(updating.TableDescription?.TableStatus, "UPDATING"); assert.equal(updating.TableDescription?.WarmThroughput?.Status, "UPDATING"); await tick(clock);
    let described = (await client.send(new DescribeTableCommand({ TableName: "ConfiguredRecords" }))).Table!; assert.deepEqual(described.OnDemandThroughput, { MaxWriteRequestUnits: 9 }); assert.deepEqual(described.WarmThroughput, { ReadUnitsPerSecond: 30, WriteUnitsPerSecond: 12, Status: "ACTIVE" }); assert.equal(described.TableClassSummary?.TableClass, "STANDARD"); assert.equal(described.TableClassSummary?.LastUpdateDateTime?.getTime(), Date.parse("2026-07-15T22:00:00Z") + 50); assert.deepEqual(described.SSEDescription, { SSEType: "KMS", Status: "UPDATING", KMSMasterKeyArn: "arn:aws:kms:eu-west-1:000000000000:key/local-only" });

    await client.send(new CreateTableCommand({ TableName: "ScalingRecords", BillingMode: "PROVISIONED", ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 6 }, AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "category", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" }, ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 3 } }] }));
    await tick(clock); assert.deepEqual((await client.send(new DescribeTableCommand({ TableName: "ScalingRecords" }))).Table?.WarmThroughput, { ReadUnitsPerSecond: 12_000, WriteUnitsPerSecond: 4_000, Status: "ACTIVE" });
    for (let index = 0; index < 12; index += 1) await client.send(new PutItemCommand({ TableName: "ScalingRecords", Item: { id: { S: `burst-${index}` }, category: { S: "same-partition" } } }));
    const scaling = { MinimumUnits: 2, MaximumUnits: 20, AutoScalingDisabled: false, AutoScalingRoleArn: "arn:aws:iam::000000000000:role/aws-service-role/dynamodb.application-autoscaling.amazonaws.com/AWSServiceRoleForApplicationAutoScaling_DynamoDBTable", ScalingPolicyUpdate: { PolicyName: "learning-target", TargetTrackingScalingPolicyConfiguration: { TargetValue: 70, DisableScaleIn: false, ScaleInCooldown: 30, ScaleOutCooldown: 15 } } };
    const auto = await client.send(new UpdateTableReplicaAutoScalingCommand({ TableName: "ScalingRecords", ProvisionedWriteCapacityAutoScalingUpdate: scaling, GlobalSecondaryIndexUpdates: [{ IndexName: "ByCategory", ProvisionedWriteCapacityAutoScalingUpdate: scaling }], ReplicaUpdates: [{ RegionName: "eu-west-1", ReplicaProvisionedReadCapacityAutoScalingUpdate: scaling, ReplicaGlobalSecondaryIndexUpdates: [{ IndexName: "ByCategory", ProvisionedReadCapacityAutoScalingUpdate: scaling }] }] }));
    assert.equal(auto.TableAutoScalingDescription?.Replicas?.[0].ReplicaProvisionedReadCapacityAutoScalingSettings?.MinimumUnits, 2); assert.equal(auto.TableAutoScalingDescription?.Replicas?.[0].ReplicaProvisionedWriteCapacityAutoScalingSettings?.ScalingPolicies?.[0].PolicyName, "learning-target"); assert.equal(auto.TableAutoScalingDescription?.Replicas?.[0].GlobalSecondaryIndexes?.[0].ProvisionedReadCapacityAutoScalingSettings?.MaximumUnits, 20);
    await client.send(new UpdateTableCommand({ TableName: "ScalingRecords", ProvisionedThroughput: { ReadCapacityUnits: 4, WriteCapacityUnits: 5 } })); await tick(clock); described = (await client.send(new DescribeTableCommand({ TableName: "ScalingRecords" }))).Table!; assert.equal(described.ProvisionedThroughput?.NumberOfDecreasesToday, 1); assert.equal(described.ProvisionedThroughput?.LastDecreaseDateTime?.getTime(), clock.now() - 50);

    client.destroy(); await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); client = clientFor(simulator);
    described = (await client.send(new DescribeTableCommand({ TableName: "ConfiguredRecords" }))).Table!; assert.equal(described.DeletionProtectionEnabled, false); assert.deepEqual(described.OnDemandThroughput, { MaxWriteRequestUnits: 9 }); assert.equal(described.SSEDescription?.Status, "UPDATING"); assert.deepEqual((await client.send(new ListTagsOfResourceCommand({ ResourceArn: arn }))).Tags, [{ Key: "owner", Value: "learning" }, { Key: "team", Value: "database" }]); assert.equal((await client.send(new DescribeTableReplicaAutoScalingCommand({ TableName: "ScalingRecords" }))).TableAutoScalingDescription?.Replicas?.[0].GlobalSecondaryIndexes?.[0].IndexName, "ByCategory"); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("DynamoDB omits SSEDescription when a KMS-encrypted table returns to the AWS owned key", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-owned-key-")); const clock = new TestClock(Date.parse("2026-07-15T23:00:00Z")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off" }); let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator);
    const created = await client.send(new CreateTableCommand({ TableName: "EncryptedRecords", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], SSESpecification: { Enabled: true, SSEType: "KMS", KMSMasterKeyId: "arn:aws:kms:eu-west-1:000000000000:key/local-only" } }));
    assert.equal(created.TableDescription?.SSEDescription?.SSEType, "KMS"); await tick(clock);
    const updating = await client.send(new UpdateTableCommand({ TableName: "EncryptedRecords", SSESpecification: { Enabled: false } })); assert.equal(updating.TableDescription?.SSEDescription, undefined); await tick(clock);
    assert.equal((await client.send(new DescribeTableCommand({ TableName: "EncryptedRecords" }))).Table?.SSEDescription, undefined);
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("optional DynamoDB capacity enforcement uses deterministic refill and reports consumed units", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-capacity-")); const clock = new TestClock(1_000); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, dynamoEnforceCapacity: true, authMode: "off"}); let client: DynamoDBClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator); await client.send(new CreateTableCommand({ TableName: "LimitedRecords", BillingMode: "PROVISIONED", ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 }, AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
    await tick(clock);
    const firstWrite = await client.send(new PutItemCommand({ TableName: "LimitedRecords", Item: { id: { S: "one" } }, ReturnConsumedCapacity: "TOTAL" })); assert.deepEqual(firstWrite.ConsumedCapacity, { TableName: "LimitedRecords", CapacityUnits: 1, ReadCapacityUnits: 0, WriteCapacityUnits: 1 }); await validation(client.send(new PutItemCommand({ TableName: "LimitedRecords", Item: { id: { S: "two" } } })), "ProvisionedThroughputExceededException");
    clock.advance(999); await validation(client.send(new PutItemCommand({ TableName: "LimitedRecords", Item: { id: { S: "two" } } })), "ProvisionedThroughputExceededException"); clock.advance(1); await client.send(new PutItemCommand({ TableName: "LimitedRecords", Item: { id: { S: "two" } } }));
    const firstRead = await client.send(new GetItemCommand({ TableName: "LimitedRecords", Key: { id: { S: "one" } }, ConsistentRead: true, ReturnConsumedCapacity: "TOTAL" })); assert.equal(firstRead.ConsumedCapacity?.ReadCapacityUnits, 1); await validation(client.send(new GetItemCommand({ TableName: "LimitedRecords", Key: { id: { S: "two" } }, ConsistentRead: true })), "ProvisionedThroughputExceededException"); clock.advance(1_000); assert.equal((await client.send(new GetItemCommand({ TableName: "LimitedRecords", Key: { id: { S: "two" } }, ConsistentRead: true }))).Item?.id?.S, "two");
    await client.send(new CreateTableCommand({ TableName: "IndexedLimitedRecords", BillingMode: "PROVISIONED", ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 2 }, AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "category", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" }, ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } }] }));
    await tick(clock);
    await client.send(new PutItemCommand({ TableName: "IndexedLimitedRecords", Item: { id: { S: "one" }, category: { S: "group" } } }));
    await assert.rejects(client.send(new PutItemCommand({ TableName: "IndexedLimitedRecords", Item: { id: { S: "two" }, category: { S: "group" } } })), (error: any) => error.name === "ProvisionedThroughputExceededException" && error.ThrottlingReasons?.[0]?.reason === "IndexWriteProvisionedThroughputExceeded" && /\/index\/ByCategory$/.test(error.ThrottlingReasons?.[0]?.resource ?? ""));
  } finally { client?.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true }); }
});
