import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudWatchClient, GetMetricStatisticsCommand, ListMetricsCommand } from "@aws-sdk/client-cloudwatch";
import {
  CreateTableCommand,
  DescribeContributorInsightsCommand,
  DynamoDBClient,
  GetItemCommand,
  ListContributorInsightsCommand,
  PutItemCommand,
  QueryCommand,
  UpdateContributorInsightsCommand,
} from "@aws-sdk/client-dynamodb";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function clients(simulator: StackSim) { const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials, maxAttempts: 1 }; return { cloudwatch: new CloudWatchClient(options), dynamodb: new DynamoDBClient(options) }; }
async function tick(clock: TestClock, milliseconds = 50): Promise<void> { clock.advance(milliseconds); await new Promise<void>(resolve => setImmediate(resolve)); }

test("DynamoDB contributor insights persists table/GSI settings and publishes lightweight key-frequency metrics", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ddb-contributors-")); const clock = new TestClock(Date.parse("2026-07-16T00:15:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, dynamoEnforceCapacity: true, authMode: "off"}); let active: ReturnType<typeof clients> | undefined;
  try {
    await simulator.start(); active = clients(simulator); const { cloudwatch, dynamodb } = active;
    await dynamodb.send(new CreateTableCommand({ TableName: "ContributorRecords", BillingMode: "PROVISIONED", ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 }, AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "N" }, { AttributeName: "category", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }], GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" }, ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 } }] }));
    await waitForTableActive(dynamodb, "ContributorRecords", clock);
    const firstPage = await dynamodb.send(new ListContributorInsightsCommand({ TableName: "ContributorRecords", MaxResults: 1 })); assert.equal(firstPage.ContributorInsightsSummaries?.length, 1); assert.equal(firstPage.ContributorInsightsSummaries?.[0].ContributorInsightsStatus, "DISABLED"); assert.ok(firstPage.NextToken); const secondPage = await dynamodb.send(new ListContributorInsightsCommand({ TableName: "ContributorRecords", MaxResults: 1, NextToken: firstPage.NextToken })); assert.equal(secondPage.ContributorInsightsSummaries?.[0].IndexName, "ByCategory");
    await assert.rejects(dynamodb.send(new ListContributorInsightsCommand({ TableName: "AnotherTable", MaxResults: 1, NextToken: firstPage.NextToken })), (error: any) => error.name === "ResourceNotFoundException"); await assert.rejects(dynamodb.send(new DescribeContributorInsightsCommand({ TableName: "ContributorRecords", IndexName: "MissingIndex" })), (error: any) => error.name === "ResourceNotFoundException");

    const enabling = await dynamodb.send(new UpdateContributorInsightsCommand({ TableName: "ContributorRecords", ContributorInsightsAction: "ENABLE", ContributorInsightsMode: "ACCESSED_AND_THROTTLED_KEYS" })); assert.equal(enabling.ContributorInsightsStatus, "ENABLING"); await dynamodb.send(new UpdateContributorInsightsCommand({ TableName: "ContributorRecords", IndexName: "ByCategory", ContributorInsightsAction: "ENABLE", ContributorInsightsMode: "ACCESSED_AND_THROTTLED_KEYS" })); await tick(clock);
    const tableInsight = await dynamodb.send(new DescribeContributorInsightsCommand({ TableName: "ContributorRecords" })); assert.equal(tableInsight.ContributorInsightsStatus, "ENABLED"); assert.equal(tableInsight.ContributorInsightsMode, "ACCESSED_AND_THROTTLED_KEYS"); assert.equal(tableInsight.ContributorInsightsRuleList?.length, 4); const indexInsight = await dynamodb.send(new DescribeContributorInsightsCommand({ TableName: "ContributorRecords", IndexName: "ByCategory" })); assert.equal(indexInsight.ContributorInsightsRuleList?.length, 2);

    const item = { pk: { S: "hot" }, sk: { N: "1" }, category: { S: "featured" } }; await dynamodb.send(new PutItemCommand({ TableName: "ContributorRecords", Item: item })); await dynamodb.send(new GetItemCommand({ TableName: "ContributorRecords", Key: { pk: { S: "hot" }, sk: { N: "1" } } })); await dynamodb.send(new QueryCommand({ TableName: "ContributorRecords", IndexName: "ByCategory", KeyConditionExpression: "category = :category", ExpressionAttributeValues: { ":category": { S: "featured" } } }));
    const listed = await cloudwatch.send(new ListMetricsCommand({ Namespace: "StackSim/DynamoDBContributorInsights", MetricName: "AccessFrequency", Dimensions: [{ Name: "TableName", Value: "ContributorRecords" }] })); assert.equal(listed.Metrics?.length, 2); assert.ok(listed.Metrics?.some(metric => metric.Dimensions?.some(dimension => dimension.Name === "GlobalSecondaryIndexName" && dimension.Value === "ByCategory")));
    const stats = await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "StackSim/DynamoDBContributorInsights", MetricName: "AccessFrequency", Dimensions: [{ Name: "TableName", Value: "ContributorRecords" }, { Name: "ContributorKey", Value: '{"pk":{"S":"hot"},"sk":{"N":"1"}}' }], StartTime: new Date(clock.now() - 60_000), EndTime: new Date(clock.now() + 60_000), Period: 60, Statistics: ["Sum"] })); assert.equal(stats.Datapoints?.[0].Sum, 2);

    await dynamodb.send(new CreateTableCommand({ TableName: "ThrottleRecords", BillingMode: "PROVISIONED", ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 }, AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] })); await waitForTableActive(dynamodb, "ThrottleRecords", clock); await dynamodb.send(new UpdateContributorInsightsCommand({ TableName: "ThrottleRecords", ContributorInsightsAction: "ENABLE", ContributorInsightsMode: "THROTTLED_KEYS" })); await tick(clock); const throttledItem = { id: { S: "hot" } }; await dynamodb.send(new PutItemCommand({ TableName: "ThrottleRecords", Item: throttledItem })); await assert.rejects(dynamodb.send(new PutItemCommand({ TableName: "ThrottleRecords", Item: throttledItem })), (error: any) => error.name === "ProvisionedThroughputExceededException"); await new Promise<void>(resolve => setImmediate(resolve)); const throttleStats = await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "StackSim/DynamoDBContributorInsights", MetricName: "ThrottleFrequency", Dimensions: [{ Name: "TableName", Value: "ThrottleRecords" }, { Name: "ContributorKey", Value: '{"id":{"S":"hot"}}' }], StartTime: new Date(clock.now() - 60_000), EndTime: new Date(clock.now() + 60_000), Period: 60, Statistics: ["Sum"] })); assert.equal(throttleStats.Datapoints?.[0].Sum, 1); assert.equal((await cloudwatch.send(new ListMetricsCommand({ Namespace: "StackSim/DynamoDBContributorInsights", MetricName: "AccessFrequency", Dimensions: [{ Name: "TableName", Value: "ThrottleRecords" }] }))).Metrics?.length, 0);

    await dynamodb.send(new UpdateContributorInsightsCommand({ TableName: "ContributorRecords", ContributorInsightsAction: "DISABLE" })); Object.values(active).forEach(client => client.destroy()); active = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, dynamoEnforceCapacity: true, authMode: "off"}); await simulator.start(); active = clients(simulator); await tick(clock); assert.equal((await active.dynamodb.send(new DescribeContributorInsightsCommand({ TableName: "ContributorRecords" }))).ContributorInsightsStatus, "DISABLED"); assert.equal((await active.dynamodb.send(new DescribeContributorInsightsCommand({ TableName: "ContributorRecords", IndexName: "ByCategory" }))).ContributorInsightsStatus, "ENABLED"); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally { if (active) Object.values(active).forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
