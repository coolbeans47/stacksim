import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudWatchClient, GetMetricDataCommand, GetMetricStatisticsCommand, ListMetricsCommand, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { APIGatewayClient, CreateDeploymentCommand, CreateRestApiCommand, GetResourcesCommand, PutIntegrationCommand, PutIntegrationResponseCommand, PutMethodCommand, PutMethodResponseCommand } from "@aws-sdk/client-api-gateway";
import { CreateTableCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function clients(simulator: StackSim) {
  const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials };
  return { apigateway: new APIGatewayClient(options), cloudwatch: new CloudWatchClient(options), dynamodb: new DynamoDBClient(options), iam: new IAMClient(options), lambda: new LambdaClient(options) };
}

test("CloudWatch metrics SDK supports custom data, dimensions, statistics, percentiles, list/data pagination, math, XML, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-metrics-")); const clock = new TestClock(Date.parse("2026-07-15T12:00:30Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); let active: ReturnType<typeof clients> | undefined;
  try {
    await simulator.start(); active = clients(simulator); const { cloudwatch } = active; const minute = new Date("2026-07-15T12:00:05Z");
    await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/App", MetricData: [
      { MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/notes" }, { Name: "Method", Value: "GET" }], Unit: "Milliseconds", Timestamp: minute, Value: 10 },
      { MetricName: "Latency", Dimensions: [{ Name: "Method", Value: "GET" }, { Name: "Route", Value: "/notes" }], Unit: "Milliseconds", Timestamp: new Date(minute.getTime() + 20_000), Values: [20, 40], Counts: [2, 1] },
      { MetricName: "Requests", Dimensions: [{ Name: "Route", Value: "/notes" }], Unit: "Count", Timestamp: minute, StatisticValues: { SampleCount: 4, Sum: 8, Minimum: 2, Maximum: 2 } },
    ] }));
    const stats = await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "Learning/App", MetricName: "Latency", Dimensions: [{ Name: "Route", Value: "/notes" }, { Name: "Method", Value: "GET" }], StartTime: new Date("2026-07-15T12:00:00Z"), EndTime: new Date("2026-07-15T12:01:00Z"), Period: 60, Statistics: ["SampleCount", "Sum", "Minimum", "Maximum", "Average"] }));
    assert.equal(stats.Datapoints?.length, 1); assert.equal(stats.Datapoints?.[0].SampleCount, 4); assert.equal(stats.Datapoints?.[0].Sum, 90); assert.equal(stats.Datapoints?.[0].Minimum, 10); assert.equal(stats.Datapoints?.[0].Maximum, 40); assert.equal(stats.Datapoints?.[0].Average, 22.5);
    const percentiles = await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "Learning/App", MetricName: "Latency", Dimensions: [{ Name: "Method", Value: "GET" }, { Name: "Route", Value: "/notes" }], StartTime: new Date("2026-07-15T12:00:00Z"), EndTime: new Date("2026-07-15T12:01:00Z"), Period: 60, ExtendedStatistics: ["p50", "p100"] }));
    assert.deepEqual(percentiles.Datapoints?.[0].ExtendedStatistics, { p50: 20, p100: 40 });

    const bulk = Array.from({ length: 501 }, (_, index) => ({ MetricName: `Bulk${String(index).padStart(3, "0")}`, Unit: "Count" as const, Value: index })); await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/Bulk", MetricData: bulk }));
    const first = await cloudwatch.send(new ListMetricsCommand({ Namespace: "Learning/Bulk" })); assert.equal(first.Metrics?.length, 500); assert.ok(first.NextToken); const second = await cloudwatch.send(new ListMetricsCommand({ Namespace: "Learning/Bulk", NextToken: first.NextToken })); assert.equal(second.Metrics?.length, 1);
    const filtered = await cloudwatch.send(new ListMetricsCommand({ Namespace: "Learning/App", Dimensions: [{ Name: "Method", Value: "GET" }] })); assert.deepEqual(filtered.Metrics?.map(metric => metric.MetricName), ["Latency"]);
    await assert.rejects(cloudwatch.send(new ListMetricsCommand({ Namespace: "Learning/App", NextToken: `${first.NextToken}x` })), (error: any) => error.name === "InvalidParameterValueException");
    await assert.rejects(cloudwatch.send(new PutMetricDataCommand({ Namespace: "AWS/Reserved", MetricData: [{ MetricName: "Nope", Value: 1 }] })), (error: any) => error.name === "InvalidParameterValueException");

    await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/Math", MetricData: [
      { MetricName: "Left", Timestamp: new Date("2026-07-15T12:00:05Z"), Value: 2 }, { MetricName: "Left", Timestamp: new Date("2026-07-15T12:01:05Z"), Value: 4 }, { MetricName: "Left", Timestamp: new Date("2026-07-15T12:02:05Z"), Value: 6 },
      { MetricName: "Right", Timestamp: new Date("2026-07-15T12:00:05Z"), Value: 3 },
    ] }));
    const mathInput = { StartTime: new Date("2026-07-15T12:00:00Z"), EndTime: new Date("2026-07-15T12:03:00Z"), ScanBy: "TimestampAscending" as const, MaxDatapoints: 2, MetricDataQueries: [
      { Id: "left", ReturnData: false, MetricStat: { Metric: { Namespace: "Learning/Math", MetricName: "Left" }, Period: 60, Stat: "Sum" } },
      { Id: "right", ReturnData: false, MetricStat: { Metric: { Namespace: "Learning/Math", MetricName: "Right" }, Period: 60, Stat: "Sum" } },
      { Id: "total", Label: "filled total", Expression: "left + FILL(right, 0)" },
    ] };
    const mathFirst = await cloudwatch.send(new GetMetricDataCommand(mathInput)); assert.deepEqual(mathFirst.MetricDataResults?.[0].Values, [5, 4]); assert.deepEqual(mathFirst.MetricDataResults?.[0].Timestamps, [new Date("2026-07-15T12:00:00Z"), new Date("2026-07-15T12:01:00Z")]); assert.ok(mathFirst.NextToken); const mathSecond = await cloudwatch.send(new GetMetricDataCommand({ ...mathInput, NextToken: mathFirst.NextToken })); assert.deepEqual(mathSecond.MetricDataResults?.[0].Values, [6]);
    await assert.rejects(cloudwatch.send(new GetMetricDataCommand({ ...mathInput, EndTime: new Date("2026-07-15T12:04:00Z"), NextToken: mathFirst.NextToken })), (error: any) => error.name === "InvalidNextToken");
    const metricSegments = (simulator.metrics as any).segments; const originalReadMatching = metricSegments.readMatching.bind(metricSegments); let metricStoreReads = 0; metricSegments.readMatching = async (predicate: (serialized: string) => boolean) => { metricStoreReads++; return originalReadMatching(predicate); };
    const functionResults = await cloudwatch.send(new GetMetricDataCommand({
      StartTime: mathInput.StartTime,
      EndTime: mathInput.EndTime,
      ScanBy: "TimestampAscending",
      MetricDataQueries: [
        ...mathInput.MetricDataQueries.slice(0, 2),
        { Id: "sum", Expression: "SUM([left,FILL(right,0)])" },
        { Id: "average", Expression: "AVG([left,FILL(right,0)])" },
        { Id: "minimum", Expression: "MIN([left,FILL(right,0)])" },
        { Id: "maximum", Expression: "MAX([left,FILL(right,0)])" },
        { Id: "arithmetic", Expression: "((left - FILL(right,0)) * 2) / 2" },
      ],
    }));
    metricSegments.readMatching = originalReadMatching; assert.equal(metricStoreReads, 1, "one GetMetricData request should share one filtered metric-store snapshot across every series");
    assert.deepEqual(functionResults.MetricDataResults?.map(result => result.Values), [[5, 4, 6], [2.5, 2, 3], [2, 0, 0], [3, 4, 6], [-1, 4, 6]]);

    const raw = await fetch(`http://127.0.0.1:${simulator.port}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-stacksim-region": "eu-west-1" }, body: new URLSearchParams({ Action: "GetMetricStatistics", Version: "2010-08-01", Namespace: "Learning/App", MetricName: "Requests", StartTime: "2026-07-15T12:00:00Z", EndTime: "2026-07-15T12:01:00Z", Period: "60", "Dimensions.member.1.Name": "Route", "Dimensions.member.1.Value": "/notes", "Statistics.member.1": "Sum" }) }); const xml = await raw.text(); assert.equal(raw.status, 200); assert.match(raw.headers.get("content-type") ?? "", /text\/xml/); assert.match(raw.headers.get("x-amzn-requestid") ?? "", /.+/); assert.match(xml, /<GetMetricStatisticsResponse xmlns="http:\/\/monitoring\.amazonaws\.com\/doc\/2010-08-01\/">/); assert.match(xml, /<Sum>8<\/Sum>/);

    Object.values(active).forEach(client => client.destroy()); active = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); active = clients(simulator);
    assert.equal((await active.cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "Learning/App", MetricName: "Requests", Dimensions: [{ Name: "Route", Value: "/notes" }], StartTime: new Date("2026-07-15T12:00:00Z"), EndTime: new Date("2026-07-15T12:01:00Z"), Period: 60, Statistics: ["Sum"] }))).Datapoints?.[0].Sum, 8);
  } finally { if (active) Object.values(active).forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("automatic service telemetry keeps one queryable statistical point per metric and minute", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-metric-telemetry-")); const clock = new TestClock(Date.parse("2026-07-15T13:00:30Z")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off" }); let cloudwatch: CloudWatchClient | undefined;
  try {
    await simulator.start(); cloudwatch = clients(simulator).cloudwatch;
    for (let index = 0; index < 1_000; index += 1) {
      await simulator.metrics.publish({ namespace: "AWS/SQS", metricName: "NumberOfEmptyReceives", dimensions: { QueueName: "quiet-worker" }, value: 1, unit: "Count", timestamp: clock.now() });
      await simulator.metrics.publish({ namespace: "AWS/SQS", metricName: "ApproximateNumberOfMessagesVisible", dimensions: { QueueName: "quiet-worker" }, value: index, unit: "Count", timestamp: clock.now(), aggregation: "gauge" });
    }
    assert.equal((simulator.metrics as any).telemetryBuckets.size, 2);
    assert.equal((await (simulator.metrics as any).segments.readAll()).length, 0, "active service telemetry remains in a bounded minute buffer");
    const result = await cloudwatch.send(new GetMetricDataCommand({ StartTime: new Date(clock.now() - 60_000), EndTime: new Date(clock.now() + 60_000), MetricDataQueries: [
      { Id: "empty", MetricStat: { Metric: { Namespace: "AWS/SQS", MetricName: "NumberOfEmptyReceives", Dimensions: [{ Name: "QueueName", Value: "quiet-worker" }] }, Period: 60, Stat: "Sum" } },
      { Id: "visible", MetricStat: { Metric: { Namespace: "AWS/SQS", MetricName: "ApproximateNumberOfMessagesVisible", Dimensions: [{ Name: "QueueName", Value: "quiet-worker" }] }, Period: 60, Stat: "Average" } },
    ] }));
    assert.deepEqual(result.MetricDataResults?.map(item => item.Values), [[1_000], [999]]);
    await simulator.metrics.flush(); assert.equal((await (simulator.metrics as any).segments.readAll()).length, 2, "one persisted point represents each service metric minute");
    await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/Legacy", MetricData: Array.from({ length: 1_000 }, () => ({ MetricName: "Repeated", Timestamp: new Date(clock.now()), Value: 1 })) }));
    assert.equal((await (simulator.metrics as any).segments.readAll()).length, 1_002);
    await simulator.metrics.compactNow(); assert.equal((await (simulator.metrics as any).segments.readAll()).length, 3, "compaction coalesces existing standard-resolution samples by minute");
    assert.equal((await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "Learning/Legacy", MetricName: "Repeated", StartTime: new Date(clock.now() - 60_000), EndTime: new Date(clock.now() + 60_000), Period: 60, Statistics: ["Sum"] }))).Datapoints?.[0].Sum, 1_000);
  } finally { cloudwatch?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("metric retention rolls up and existing services publish automatic request metrics", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-metrics-hooks-")); const clock = new TestClock(Date.parse("2026-07-15T14:00:00Z")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, metricRetention: { highResolutionMs: 100, minuteMs: 200, fiveMinuteMs: 300, totalMs: 1_000, compactEveryMs: 50 }, authMode: "off"}); let active: ReturnType<typeof clients> | undefined;
  try {
    await simulator.start(); active = clients(simulator); const { apigateway, cloudwatch, dynamodb, iam, lambda } = active;
    await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/Rollup", MetricData: [{ MetricName: "HighResolution", StorageResolution: 1, Timestamp: new Date(clock.now()), Value: 7 }] })); clock.advance(250); await simulator.metrics.compactNow();
    const tooFine = await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "Learning/Rollup", MetricName: "HighResolution", StartTime: new Date(clock.now() - 1_000), EndTime: new Date(clock.now() + 1_000), Period: 60, Statistics: ["Sum"] })); assert.equal(tooFine.Datapoints?.length, 0);
    const rolled = await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "Learning/Rollup", MetricName: "HighResolution", StartTime: new Date(clock.now() - 1_000), EndTime: new Date(clock.now() + 300_000), Period: 300, Statistics: ["Sum"] })); assert.equal(rolled.Datapoints?.[0].Sum, 7);

    await dynamodb.send(new CreateTableCommand({ TableName: "MetricNotes", ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 6 }, AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "category", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" }, ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 } }] })); await waitForTableActive(dynamodb, "MetricNotes", clock); await dynamodb.send(new PutItemCommand({ TableName: "MetricNotes", Item: { id: { S: "one" }, category: { S: "guides" } } }));
    assert.equal((await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "AWS/DynamoDB", MetricName: "ConsumedWriteCapacityUnits", Dimensions: [{ Name: "TableName", Value: "MetricNotes" }], StartTime: new Date(clock.now() - 60_000), EndTime: new Date(clock.now() + 60_000), Period: 60, Statistics: ["Sum"] }))).Datapoints?.[0].Sum, 1);
    const indexDimensions = [{ Name: "TableName", Value: "MetricNotes" }, { Name: "GlobalSecondaryIndexName", Value: "ByCategory" }];
    assert.equal((await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "AWS/DynamoDB", MetricName: "ConsumedWriteCapacityUnits", Dimensions: indexDimensions, StartTime: new Date(clock.now() - 60_000), EndTime: new Date(clock.now() + 60_000), Period: 60, Statistics: ["Sum"] }))).Datapoints?.[0].Sum, 1);
    assert.equal((await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "AWS/DynamoDB", MetricName: "ProvisionedWriteCapacityUnits", Dimensions: indexDimensions, StartTime: new Date(clock.now() - 60_000), EndTime: new Date(clock.now() + 60_000), Period: 60, Statistics: ["Average"] }))).Datapoints?.[0].Average, 4);

    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }); await iam.send(new CreateRoleCommand({ RoleName: "metric-role", AssumeRolePolicyDocument: trust })); const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip")); await lambda.send(new CreateFunctionCommand({ FunctionName: "metric-function", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/metric-role", Handler: "handler.echoHandler", Code: { ZipFile: zip } })); await lambda.send(new InvokeCommand({ FunctionName: "metric-function", Payload: Buffer.from("{}") }));
    const lambdaMetrics = await cloudwatch.send(new GetMetricDataCommand({ StartTime: new Date(clock.now() - 60_000), EndTime: new Date(clock.now() + 60_000), MetricDataQueries: [
      { Id: "invocations", MetricStat: { Metric: { Namespace: "AWS/Lambda", MetricName: "Invocations", Dimensions: [{ Name: "FunctionName", Value: "metric-function" }] }, Period: 60, Stat: "Sum" } },
      { Id: "duration", MetricStat: { Metric: { Namespace: "AWS/Lambda", MetricName: "Duration", Dimensions: [{ Name: "FunctionName", Value: "metric-function" }] }, Period: 60, Stat: "Average" } },
    ] })); assert.deepEqual(lambdaMetrics.MetricDataResults?.map(result => result.Values?.length), [1, 1]); assert.equal(lambdaMetrics.MetricDataResults?.[0].Values?.[0], 1); assert.ok((lambdaMetrics.MetricDataResults?.[1].Values?.[0] ?? 0) > 0);

    const api = await apigateway.send(new CreateRestApiCommand({ name: "metric-api" })); const rootResource = (await apigateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!; await apigateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: rootResource.id!, httpMethod: "GET", authorizationType: "NONE" })); await apigateway.send(new PutMethodResponseCommand({ restApiId: api.id!, resourceId: rootResource.id!, httpMethod: "GET", statusCode: "200" })); await apigateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: rootResource.id!, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } })); await apigateway.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: rootResource.id!, httpMethod: "GET", statusCode: "200", responseTemplates: { "application/json": "{\"ok\":true}" } })); await apigateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" })); const apiResponse = await fetch(`http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/`); assert.equal(apiResponse.status, 200);
    assert.equal((await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "AWS/ApiGateway", MetricName: "Count", Dimensions: [{ Name: "ApiName", Value: "metric-api" }, { Name: "Stage", Value: "dev" }], StartTime: new Date(clock.now() - 60_000), EndTime: new Date(clock.now() + 60_000), Period: 60, Statistics: ["SampleCount"] }))).Datapoints?.[0].SampleCount, 1);
  } finally { if (active) Object.values(active).forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
