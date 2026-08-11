import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  GetResourcePolicyCommand,
  ListTablesCommand,
  ListTagsOfResourceCommand,
} from "@aws-sdk/client-dynamodb";
import { DescribeStreamCommand, DynamoDBStreamsClient } from "@aws-sdk/client-dynamodb-streams";
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import {
  AttributeType,
  BillingMode,
  ContributorInsightsMode,
  ProjectionType,
  StreamViewType,
  Table,
  TableClass,
} from "aws-cdk-lib/aws-dynamodb";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { ProviderReferenceError, type ProviderContext } from "../src/cloudformation/providers/contract.js";
import {
  createDynamoDbTableProvider,
  DYNAMODB_TABLE_SCHEMA,
} from "../src/cloudformation/providers/dynamodb-table.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const accountId = "000000000000";
const identity: PrincipalContext = {
  accessKeyId: credentials.accessKeyId,
  principalArn: `arn:aws:iam::${accountId}:root`,
  principalId: accountId,
  accountId,
};

function context(logicalId = "OrdersTable", callbackContext?: Readonly<Record<string, any>>, operationId = "operation-1"): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/provider-dynamodb/stack-id`,
    logicalId,
    operationId,
    resourceOperationId: `${logicalId}-${operationId}`,
    idempotencyKey: `${logicalId}-stable-key`,
    deadlineAt: Date.now() + 60_000,
    ...(callbackContext ? { callbackContext } : {}),
    principal: { identity },
  };
}

async function settle(
  invoke: (current: ProviderContext) => Promise<any>,
  logicalId = "OrdersTable",
): Promise<any> {
  let result = await invoke(context(logicalId));
  for (let attempt = 0; result.status === "IN_PROGRESS" && attempt < 240; attempt++) {
    await new Promise(resolve => setTimeout(resolve, Math.max(10, result.callbackAfterMs)));
    result = await invoke(context(logicalId, result.checkpoint.callbackContext));
  }
  assert.notEqual(result.status, "IN_PROGRESS", "DynamoDB provider did not stabilize within the callback budget");
  return result;
}

function clients(simulator: StackSim): { dynamodb: DynamoDBClient; streams: DynamoDBStreamsClient } {
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  return {
    dynamodb: new DynamoDBClient({ endpoint, region, credentials }),
    streams: new DynamoDBStreamsClient({ endpoint, region, credentials }),
  };
}

function initialProperties(): Record<string, any> {
  const tableArn = `arn:aws:dynamodb:${region}:${accountId}:table/provider-orders`;
  return {
    TableName: "provider-orders",
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
      { AttributeName: "localSort", AttributeType: "N" },
      { AttributeName: "group", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 6 },
    WarmThroughput: { ReadUnitsPerSecond: 12, WriteUnitsPerSecond: 8 },
    LocalSecondaryIndexes: [{
      IndexName: "by-local",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "localSort", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["payload"] },
    }],
    GlobalSecondaryIndexes: [{
      IndexName: "by-group",
      KeySchema: [{ AttributeName: "group", KeyType: "HASH" }],
      Projection: { ProjectionType: "ALL" },
      ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
      WarmThroughput: { ReadUnitsPerSecond: 7, WriteUnitsPerSecond: 5 },
      ContributorInsightsSpecification: { Enabled: true, Mode: "ACCESSED_AND_THROTTLED_KEYS" },
    }],
    StreamSpecification: {
      StreamViewType: "NEW_AND_OLD_IMAGES",
      ResourcePolicy: {
        Version: "2012-10-17",
        Statement: [{ Sid: "StreamRead", Effect: "Allow", Principal: "*", Action: "dynamodb:GetRecords", Resource: "*" }],
      },
    },
    TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 7 },
    SSESpecification: { SSEEnabled: false },
    TableClass: "STANDARD",
    DeletionProtectionEnabled: false,
    ContributorInsightsSpecification: { Enabled: true, Mode: "ACCESSED_AND_THROTTLED_KEYS" },
    Tags: [{ Key: "environment", Value: "development" }, { Key: "service", Value: "orders" }],
    ResourcePolicy: {
      Version: "2012-10-17",
      Statement: [{ Sid: "TableRead", Effect: "Allow", Principal: "*", Action: ["dynamodb:GetItem", "dynamodb:Query"], Resource: [tableArn, `${tableArn}/index/*`] }],
    },
  };
}

function updatedProperties(): Record<string, any> {
  const properties = structuredClone(initialProperties());
  properties.BillingMode = "PAY_PER_REQUEST";
  delete properties.ProvisionedThroughput;
  properties.OnDemandThroughput = { MaxReadRequestUnits: 40, MaxWriteRequestUnits: 30 };
  properties.WarmThroughput = { ReadUnitsPerSecond: 16, WriteUnitsPerSecond: 10 };
  properties.AttributeDefinitions.push({ AttributeName: "status", AttributeType: "S" });
  properties.GlobalSecondaryIndexes = [
    {
      IndexName: "by-group",
      KeySchema: [{ AttributeName: "group", KeyType: "HASH" }],
      Projection: { ProjectionType: "ALL" },
      OnDemandThroughput: { MaxReadRequestUnits: 18, MaxWriteRequestUnits: 14 },
      WarmThroughput: { ReadUnitsPerSecond: 9, WriteUnitsPerSecond: 6 },
      ContributorInsightsSpecification: { Enabled: true, Mode: "THROTTLED_KEYS" },
    },
    {
      IndexName: "by-status",
      KeySchema: [{ AttributeName: "status", KeyType: "HASH" }],
      Projection: { ProjectionType: "KEYS_ONLY" },
      OnDemandThroughput: { MaxReadRequestUnits: 11, MaxWriteRequestUnits: 9 },
      ContributorInsightsSpecification: { Enabled: true, Mode: "THROTTLED_KEYS" },
    },
  ];
  properties.StreamSpecification.StreamViewType = "NEW_IMAGE";
  properties.PointInTimeRecoverySpecification.RecoveryPeriodInDays = 14;
  properties.TableClass = "STANDARD_INFREQUENT_ACCESS";
  properties.DeletionProtectionEnabled = true;
  properties.ContributorInsightsSpecification.Mode = "THROTTLED_KEYS";
  properties.Tags = [{ Key: "environment", Value: "test" }, { Key: "owner", Value: "platform" }];
  properties.ResourcePolicy.Statement[0].Action.push("dynamodb:UpdateItem");
  return properties;
}

test("DynamoDB table provider drives the real service through composite create, update, restart, and delete", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-dynamodb-provider-"));
  const options = {
    port: 0,
    invokePort: 0,
    dataDir: root,
    accountId,
    region,
    authMode: "off" as const,
    dynamoTtlSchedule: { sweepEveryMs: 10, transitionMs: 5, updateCooldownMs: 10 },
    dynamoPolicyUpdateCooldownMs: 1,
  };
  let simulator = new StackSim(options);
  let sdk: ReturnType<typeof clients> | undefined;
  try {
    await simulator.start();
    sdk = clients(simulator);
    let provider = createDynamoDbTableProvider(simulator.dynamodb);
    const initial = provider.canonicalize(initialProperties(), context());
    const created = await settle(current => provider.create(initial, current));
    assert.equal(created.status, "SUCCESS");
    if (created.status !== "SUCCESS") assert.fail(`create failed: ${JSON.stringify(created)}`);
    assert.equal(provider.ref(created.model), "provider-orders");
    assert.equal(provider.getAtt(created.model, "Arn"), `arn:aws:dynamodb:${region}:${accountId}:table/provider-orders`);
    assert.match(String(provider.getAtt(created.model, "StreamArn")), /\/stream\//);
    assert.throws(() => provider.getAtt(created.model, "TableId"), ProviderReferenceError);

    const tableArn = String(provider.getAtt(created.model, "Arn"));
    const streamArn = String(provider.getAtt(created.model, "StreamArn"));
    const described = (await sdk.dynamodb.send(new DescribeTableCommand({ TableName: initial.TableName }))).Table!;
    assert.equal(described.TableStatus, "ACTIVE");
    assert.equal(described.BillingModeSummary?.BillingMode, "PROVISIONED");
    assert.equal(described.LocalSecondaryIndexes?.[0].IndexName, "by-local");
    assert.equal(described.GlobalSecondaryIndexes?.[0].IndexName, "by-group");
    assert.equal((await sdk.streams.send(new DescribeStreamCommand({ StreamArn: streamArn }))).StreamDescription?.StreamStatus, "ENABLED");
    assert.deepEqual((await sdk.dynamodb.send(new DescribeTimeToLiveCommand({ TableName: initial.TableName }))).TimeToLiveDescription, { AttributeName: "expiresAt", TimeToLiveStatus: "ENABLED" });
    const backups = await sdk.dynamodb.send(new DescribeContinuousBackupsCommand({ TableName: initial.TableName }));
    assert.equal(backups.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus, "ENABLED");
    assert.equal(backups.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.RecoveryPeriodInDays, 7);
    assert.equal((await sdk.dynamodb.send(new DescribeContributorInsightsCommand({ TableName: initial.TableName }))).ContributorInsightsStatus, "ENABLED");
    assert.equal((await sdk.dynamodb.send(new DescribeContributorInsightsCommand({ TableName: initial.TableName, IndexName: "by-group" }))).ContributorInsightsStatus, "ENABLED");
    const tags = (await sdk.dynamodb.send(new ListTagsOfResourceCommand({ ResourceArn: tableArn }))).Tags ?? [];
    assert.ok(tags.some(tag => tag.Key === "service" && tag.Value === "orders"));
    assert.ok(tags.some(tag => tag.Key === "stacksim:cloudformation:owner"));
    assert.match((await sdk.dynamodb.send(new GetResourcePolicyCommand({ ResourceArn: tableArn }))).Policy!, /TableRead/);
    assert.match((await sdk.dynamodb.send(new GetResourcePolicyCommand({ ResourceArn: streamArn }))).Policy!, /StreamRead/);

    const retried = await settle(current => provider.create(initial, current));
    assert.equal(retried.status, "SUCCESS", "an owned create retry must converge without a second table");
    const foreignDelete = await provider.delete(initial.TableName, initial, context("ForeignTable"));
    assert.equal(foreignDelete.status, "FAILED");
    if (foreignDelete.status === "FAILED") assert.equal(foreignDelete.errorCode, "OwnershipConflict");

    const updated = provider.canonicalize(updatedProperties(), context());
    const plan = provider.plan(initial, updated, context());
    assert.equal(plan.action, "UPDATE");
    const update = await settle(current => provider.update(initial.TableName, initial, updated, current));
    if (update.status !== "SUCCESS") assert.fail(`update failed: ${JSON.stringify(update)}`);
    assert.equal(update.status, "SUCCESS");
    const updatedTable = (await sdk.dynamodb.send(new DescribeTableCommand({ TableName: initial.TableName }))).Table!;
    assert.equal(updatedTable.BillingModeSummary?.BillingMode, "PAY_PER_REQUEST");
    assert.deepEqual(updatedTable.OnDemandThroughput, { MaxReadRequestUnits: 40, MaxWriteRequestUnits: 30 });
    assert.equal(updatedTable.TableClassSummary?.TableClass, "STANDARD_INFREQUENT_ACCESS");
    assert.equal(updatedTable.DeletionProtectionEnabled, true);
    assert.deepEqual(updatedTable.GlobalSecondaryIndexes?.map(index => index.IndexName).sort(), ["by-group", "by-status"]);
    assert.deepEqual(updatedTable.GlobalSecondaryIndexes?.find(index => index.IndexName === "by-group")?.OnDemandThroughput, { MaxReadRequestUnits: 18, MaxWriteRequestUnits: 14 });
    const updatedStreamArn = updatedTable.LatestStreamArn!;
    assert.notEqual(updatedStreamArn, streamArn);
    assert.equal(updatedTable.StreamSpecification?.StreamViewType, "NEW_IMAGE");
    assert.match((await sdk.dynamodb.send(new GetResourcePolicyCommand({ ResourceArn: updatedStreamArn }))).Policy!, /StreamRead/);
    await assert.rejects(sdk.dynamodb.send(new GetResourcePolicyCommand({ ResourceArn: streamArn })), (error: any) => error.name === "PolicyNotFoundException");
    assert.equal((await sdk.dynamodb.send(new DescribeContinuousBackupsCommand({ TableName: initial.TableName }))).ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.RecoveryPeriodInDays, 14);
    assert.equal((await sdk.dynamodb.send(new DescribeContributorInsightsCommand({ TableName: initial.TableName }))).ContributorInsightsMode, "THROTTLED_KEYS");
    assert.equal((await sdk.dynamodb.send(new DescribeContributorInsightsCommand({ TableName: initial.TableName, IndexName: "by-status" }))).ContributorInsightsStatus, "ENABLED");

    sdk.dynamodb.destroy(); sdk.streams.destroy(); sdk = undefined;
    await simulator.stop();
    simulator = new StackSim(options);
    await simulator.start();
    sdk = clients(simulator);
    provider = createDynamoDbTableProvider(simulator.dynamodb);
    const restarted = await settle(current => provider.read(initial.TableName, current));
    assert.equal(restarted.status, "SUCCESS");
    if (restarted.status !== "SUCCESS") assert.fail(`restart read failed: ${JSON.stringify(restarted)}`);
    assert.deepEqual(restarted.model.properties, updated, "provider read must reconstruct the canonical model from persisted DynamoDB state");

    const lockedProperties = structuredClone(updatedProperties());
    lockedProperties.ResourcePolicy = {
      Version: "2012-10-17",
      Statement: [{ Effect: "Deny", Principal: "*", Action: "dynamodb:PutResourcePolicy", Resource: tableArn }],
    };
    const locked = provider.canonicalize(lockedProperties, context());
    const lockResult = await provider.update(initial.TableName, updated, locked, context());
    assert.equal(lockResult.status, "FAILED");
    if (lockResult.status === "FAILED") assert.match(lockResult.message, /ConfirmRemoveSelfResourceAccess/);

    const protectedDelete = await provider.delete(initial.TableName, updated, context());
    assert.equal(protectedDelete.status, "FAILED");
    if (protectedDelete.status === "FAILED") assert.equal(protectedDelete.errorCode, "ValidationException");
    assert.equal((await sdk.dynamodb.send(new DescribeTableCommand({ TableName: initial.TableName }))).Table?.TableStatus, "ACTIVE");

    const unprotectedProperties = structuredClone(updatedProperties());
    unprotectedProperties.DeletionProtectionEnabled = false;
    delete unprotectedProperties.OnDemandThroughput.MaxReadRequestUnits;
    delete unprotectedProperties.GlobalSecondaryIndexes[0].OnDemandThroughput.MaxReadRequestUnits;
    delete unprotectedProperties.GlobalSecondaryIndexes[1].OnDemandThroughput;
    const unprotected = provider.canonicalize(unprotectedProperties, context());
    const protectionUpdate = await settle(current => provider.update(initial.TableName, updated, unprotected, current));
    assert.equal(protectionUpdate.status, "SUCCESS");
    const reducedLimits = (await sdk.dynamodb.send(new DescribeTableCommand({ TableName: initial.TableName }))).Table!;
    assert.deepEqual(reducedLimits.OnDemandThroughput, { MaxWriteRequestUnits: 30 });
    assert.deepEqual(reducedLimits.GlobalSecondaryIndexes?.find(index => index.IndexName === "by-group")?.OnDemandThroughput, { MaxWriteRequestUnits: 14 });
    assert.equal(reducedLimits.GlobalSecondaryIndexes?.find(index => index.IndexName === "by-status")?.OnDemandThroughput, undefined);
    const deleted = await settle(current => provider.delete(initial.TableName, unprotected, current));
    assert.equal(deleted.status, "SUCCESS");
    assert.equal((await provider.read(initial.TableName, context())).status, "NOT_FOUND");
    assert.equal((await provider.delete(initial.TableName, unprotected, context())).status, "NOT_FOUND");
    await assert.rejects(sdk.dynamodb.send(new DescribeTableCommand({ TableName: initial.TableName })), (error: any) => error.name === "ResourceNotFoundException");
  } finally {
    sdk?.dynamodb.destroy(); sdk?.streams.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("DynamoDB provider accepts the ordinary current CDK table shape and plans exact replacements", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-dynamodb-contract-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  try {
    await simulator.start();
    const provider = createDynamoDbTableProvider(simulator.dynamodb);
    const app = new App();
    const stack = new Stack(app, "DynamoProviderStack", { env: { account: accountId, region } });
    const table = new Table(stack, "Orders", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      maxReadRequestUnits: 50,
      maxWriteRequestUnits: 40,
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true, recoveryPeriodInDays: 14 },
      contributorInsightsSpecification: { enabled: true, mode: ContributorInsightsMode.THROTTLED_KEYS },
      tableClass: TableClass.STANDARD,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    table.addLocalSecondaryIndex({ indexName: "by-local", sortKey: { name: "localSort", type: AttributeType.NUMBER }, projectionType: ProjectionType.INCLUDE, nonKeyAttributes: ["payload"] });
    table.addGlobalSecondaryIndex({ indexName: "by-status", partitionKey: { name: "status", type: AttributeType.STRING }, projectionType: ProjectionType.KEYS_ONLY, maxReadRequestUnits: 20, maxWriteRequestUnits: 10, contributorInsightsSpecification: { enabled: true, mode: ContributorInsightsMode.THROTTLED_KEYS } });
    Tags.of(table).add("service", "orders");
    const template = app.synth().getStackArtifact(stack.artifactId).template as any;
    const [logicalId, resource] = Object.entries<any>(template.Resources).find(([, candidate]) => candidate.Type === "AWS::DynamoDB::Table")!;
    assert.deepEqual(provider.validate(resource.Properties, context(logicalId)), []);
    const cdkModel = provider.canonicalize(resource.Properties, context(logicalId));
    assert.match(cdkModel.TableName, /^provider-dynamodb-/);
    assert.equal(cdkModel.BillingMode, "PAY_PER_REQUEST");
    assert.equal(cdkModel.GlobalSecondaryIndexes?.[0].IndexName, "by-status");
    assert.equal(cdkModel.LocalSecondaryIndexes?.[0].IndexName, "by-local");
    assert.equal(provider.canonicalize(resource.Properties, context(logicalId, undefined, "another-operation")).TableName, cdkModel.TableName, "generated physical names must not depend on operation IDs");

    assert.equal(provider.plan(undefined, cdkModel, context(logicalId)).action, "CREATE");
    assert.equal(provider.plan(cdkModel, cdkModel, context(logicalId)).action, "NO_OP");
    const capacityProperties = structuredClone(resource.Properties);
    capacityProperties.OnDemandThroughput.MaxReadRequestUnits = 60;
    const capacity = provider.canonicalize(capacityProperties, context(logicalId));
    assert.equal(provider.plan(cdkModel, capacity, context(logicalId)).action, "UPDATE");

    const removedIndexProperties = structuredClone(resource.Properties);
    delete removedIndexProperties.GlobalSecondaryIndexes;
    removedIndexProperties.AttributeDefinitions = removedIndexProperties.AttributeDefinitions.filter((definition: any) => definition.AttributeName !== "status");
    const removedIndex = provider.canonicalize(removedIndexProperties, context(logicalId));
    const removedIndexPlan = provider.plan(cdkModel, removedIndex, context(logicalId));
    assert.equal(removedIndexPlan.action, "REPLACE", "removing an attribute definition exceeds the backing UpdateTable boundary");
    assert.ok(removedIndexPlan.replacementProperties.includes("AttributeDefinitions"));

    const replacedProperties = structuredClone(resource.Properties);
    replacedProperties.KeySchema = [{ AttributeName: "replacementPk", KeyType: "HASH" }];
    replacedProperties.AttributeDefinitions = [{ AttributeName: "replacementPk", AttributeType: "S" }];
    delete replacedProperties.LocalSecondaryIndexes;
    delete replacedProperties.GlobalSecondaryIndexes;
    const replacement = provider.canonicalize(replacedProperties, context(logicalId));
    const replacementPlan = provider.plan(cdkModel, replacement, context(logicalId));
    assert.equal(replacementPlan.action, "REPLACE");
    assert.equal(replacementPlan.replacementOrder, "DELETE_BEFORE_CREATE");
    assert.ok(replacementPlan.replacementProperties.includes("KeySchema"));

    const renamedProperties = { ...resource.Properties, TableName: "provider-orders-renamed" };
    const renamed = provider.canonicalize(renamedProperties, context(logicalId));
    const renamePlan = provider.plan(cdkModel, renamed, context(logicalId));
    assert.equal(renamePlan.action, "REPLACE");
    assert.equal(renamePlan.replacementOrder, "CREATE_BEFORE_DELETE");
    assert.deepEqual(DYNAMODB_TABLE_SCHEMA.retention.deletionPolicies, ["Delete", "Retain", "RetainExceptOnCreate"]);
    assert.deepEqual(DYNAMODB_TABLE_SCHEMA.retention.updateReplacePolicies, ["Delete", "Retain", "RetainExceptOnCreate"]);
    assert.equal(DYNAMODB_TABLE_SCHEMA.retention.snapshotSupported, false);
    const noStreamModel = { physicalId: cdkModel.TableName, properties: cdkModel, attributes: { Arn: `arn:aws:dynamodb:${region}:${accountId}:table/${cdkModel.TableName}` } };
    assert.throws(() => provider.getAtt(noStreamModel, "StreamArn"), ProviderReferenceError);
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("DynamoDB provider rejects dependency-blocked Kinesis, KMS, import, and replica properties before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-dynamodb-boundary-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  let dynamodb: DynamoDBClient | undefined;
  try {
    await simulator.start();
    dynamodb = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    const provider = createDynamoDbTableProvider(simulator.dynamodb);
    const blocked = {
      TableName: "blocked-table",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
      KinesisStreamSpecification: { StreamArn: `arn:aws:kinesis:${region}:${accountId}:stream/not-backed` },
      ImportSourceSpecification: { InputFormat: "DYNAMODB_JSON", S3BucketSource: { S3Bucket: "remote" } },
      Replicas: [{ Region: "us-east-1" }],
      SSESpecification: { SSEEnabled: true, SSEType: "KMS", KMSMasterKeyId: "alias/aws/dynamodb" },
    };
    const issues = provider.validate(blocked, context("BlockedTable"));
    for (const property of ["KinesisStreamSpecification", "ImportSourceSpecification", "Replicas"]) {
      assert.ok(issues.some(issue => issue.code === "UnsupportedProperty" && issue.path === `Properties.${property}`), `${property} should be dependency-blocked`);
    }
    assert.ok(issues.some(issue => issue.path === "Properties.SSESpecification.SSEEnabled" && /KMS/.test(issue.message)));
    assert.throws(() => provider.canonicalize(blocked, context("BlockedTable")), /KinesisStreamSpecification|ImportSourceSpecification|Replicas/);
    assert.deepEqual((await dynamodb.send(new ListTablesCommand({}))).TableNames, []);
  } finally {
    dynamodb?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
