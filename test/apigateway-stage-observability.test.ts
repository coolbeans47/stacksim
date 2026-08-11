import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  CreateDocumentationVersionCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  CreateStageCommand,
  FlushStageCacheCommand,
  GetAccountCommand,
  GetResourcesCommand,
  GetStageCommand,
  GetTagsCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateAccountCommand,
  UpdateStageCommand,
} from "@aws-sdk/client-api-gateway";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, CreateLogGroupCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("API Gateway stages persist settings and tags, route deterministic canaries, write logs and metrics, and throttle requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-stage-")); const clock = new TestClock(Date.parse("2026-07-16T10:00:00Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }; const apigateway = new APIGatewayClient(options); const cloudwatch = new CloudWatchClient(options); const logs = new CloudWatchLogsClient(options); const iam = new IAMClient(options); clients.push(apigateway, cloudwatch, logs, iam);
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "sts:AssumeRole" }] }); const role = await iam.send(new CreateRoleCommand({ RoleName: "apigateway-cloudwatch", AssumeRolePolicyDocument: trust })); await iam.send(new PutRolePolicyCommand({ RoleName: "apigateway-cloudwatch", PolicyName: "logs", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }] }) }));
    assert.equal((await apigateway.send(new GetAccountCommand({}))).cloudwatchRoleArn, undefined); const account = await apigateway.send(new UpdateAccountCommand({ patchOperations: [{ op: "replace", path: "/cloudwatchRoleArn", value: role.Role!.Arn! }] })); assert.equal(account.cloudwatchRoleArn, role.Role!.Arn); assert.ok((account.throttleSettings?.burstLimit ?? 0) > 0);
    await logs.send(new CreateLogGroupCommand({ logGroupName: "/learning/apig-access" }));

    const api = await apigateway.send(new CreateRestApiCommand({ name: "stage-observability" })); const rootResource = (await apigateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!; const items = await apigateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: rootResource.id!, pathPart: "items" }));
    await apigateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: items.id!, httpMethod: "GET", authorizationType: "NONE" })); await apigateway.send(new PutMethodResponseCommand({ restApiId: api.id!, resourceId: items.id!, httpMethod: "GET", statusCode: "200" })); await apigateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: items.id!, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } })); await apigateway.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: items.id!, httpMethod: "GET", statusCode: "200", responseTemplates: { "application/json": "{\"deployment\":\"base\",\"release\":\"$stageVariables.release\"}" } }));
    const base = await apigateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" })); await apigateway.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: items.id!, httpMethod: "GET", statusCode: "200", responseTemplates: { "application/json": "{\"deployment\":\"canary\",\"release\":\"$stageVariables.release\"}" } })); const canary = await apigateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev", canarySettings: { percentTraffic: 50, stageVariableOverrides: { release: "preview" }, useStageCache: false } })); await apigateway.send(new CreateDocumentationVersionCommand({ restApiId: api.id!, documentationVersion: "v1", description: "Stage settings fixture" })); const createdStage = await apigateway.send(new CreateStageCommand({ restApiId: api.id!, stageName: "configured", deploymentId: base.id!, description: "Created with complete settings", cacheClusterEnabled: true, cacheClusterSize: "0.5", variables: { release: "configured" }, documentationVersion: "v1", tracingEnabled: true, tags: { owner: "tutorial" }, canarySettings: { deploymentId: canary.id!, percentTraffic: 0, stageVariableOverrides: {}, useStageCache: false } })); assert.equal(createdStage.cacheClusterStatus, "AVAILABLE"); assert.equal(createdStage.documentationVersion, "v1"); assert.equal(createdStage.tracingEnabled, true); assert.deepEqual(createdStage.tags, { owner: "tutorial" });
    const accessFormat = "{\"requestId\":\"$context.requestId\",\"canary\":\"$context.isCanaryRequest\",\"deployment\":\"$context.deploymentId\",\"status\":\"$context.status\"}"; const stage = await apigateway.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [
      { op: "add", path: "/variables/release", value: "stable" },
      { op: "add", path: "/*/*/metrics/enabled", value: "true" },
      { op: "add", path: "/*/*/logging/loglevel", value: "INFO" },
      { op: "add", path: "/*/*/logging/dataTrace", value: "true" },
      { op: "add", path: "/*/*/caching/enabled", value: "true" },
      { op: "replace", path: "/tracingEnabled", value: "true" },
      { op: "replace", path: "/cacheClusterEnabled", value: "true" },
      { op: "replace", path: "/cacheClusterSize", value: "0.5" },
      { op: "add", path: "/accessLogSettings/destinationArn", value: "arn:aws:logs:eu-west-1:000000000000:log-group:/learning/apig-access" },
      { op: "add", path: "/accessLogSettings/format", value: accessFormat },
      { op: "add", path: "/canarySettings/deploymentId", value: canary.id! },
      { op: "add", path: "/canarySettings/percentTraffic", value: "50" },
      { op: "add", path: "/canarySettings/stageVariableOverrides/release", value: "preview" },
      { op: "add", path: "/canarySettings/useStageCache", value: "false" },
    ] }));
    assert.equal(stage.deploymentId, base.id); assert.equal(stage.methodSettings?.["*/*"]?.metricsEnabled, true); assert.equal(stage.methodSettings?.["*/*"]?.loggingLevel, "INFO"); assert.equal(stage.tracingEnabled, true); assert.equal(stage.cacheClusterStatus, "AVAILABLE"); assert.equal(stage.canarySettings?.percentTraffic, 50); assert.equal(stage.canarySettings?.stageVariableOverrides?.release, "preview"); const copied = await apigateway.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [{ op: "copy", from: "/*/*/metrics/enabled", path: "/~1items/GET/metrics/enabled" }] })); assert.equal(copied.methodSettings?.["/items/GET"]?.metricsEnabled, true);
    await assert.rejects(apigateway.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [{ op: "replace", path: "/canarySettings/percentTraffic", value: "101" }] })), (error: any) => error.name === "BadRequestException"); assert.equal((await apigateway.send(new GetStageCommand({ restApiId: api.id!, stageName: "dev" }))).canarySettings?.percentTraffic, 50, "invalid stage updates are atomic");

    const stageArn = `arn:aws:apigateway:eu-west-1::/restapis/${api.id}/stages/dev`; await apigateway.send(new TagResourceCommand({ resourceArn: stageArn, tags: { team: "learning", environment: "dev" } })); assert.deepEqual((await apigateway.send(new GetTagsCommand({ resourceArn: stageArn }))).tags, { team: "learning", environment: "dev" }); await apigateway.send(new UntagResourceCommand({ resourceArn: stageArn, tagKeys: ["environment"] })); assert.deepEqual((await apigateway.send(new GetTagsCommand({ resourceArn: stageArn }))).tags, { team: "learning" }); assert.deepEqual((await apigateway.send(new GetStageCommand({ restApiId: api.id!, stageName: "dev" }))).tags, { team: "learning" }); await apigateway.send(new FlushStageCacheCommand({ restApiId: api.id!, stageName: "dev" }));

    const invoke = `http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/items`; const first = await fetch(invoke); const second = await fetch(invoke); assert.deepEqual(await first.json(), { deployment: "base", release: "stable" }); assert.deepEqual(await second.json(), { deployment: "canary", release: "preview" }); assert.match(first.headers.get("x-amz-apigw-id") ?? "", /.+/);
    const start = new Date(clock.now() - 60_000); const end = new Date(clock.now() + 60_000); const statistic = async (metricName: string, dimensions: Array<{ Name: string; Value: string }>) => (await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "AWS/ApiGateway", MetricName: metricName, Dimensions: dimensions, StartTime: start, EndTime: end, Period: 60, Statistics: ["Sum"] }))).Datapoints?.[0]?.Sum;
    assert.equal(await statistic("Count", [{ Name: "ApiName", Value: "stage-observability" }, { Name: "Stage", Value: "dev" }]), 2); assert.equal(await statistic("Count", [{ Name: "ApiName", Value: "stage-observability" }, { Name: "Stage", Value: "dev" }, { Name: "Resource", Value: "/items" }, { Name: "Method", Value: "GET" }]), 2); assert.equal(await statistic("Count", [{ Name: "ApiName", Value: "stage-observability" }, { Name: "Stage", Value: "dev" }, { Name: "Canary", Value: "true" }]), 1); assert.equal(await statistic("CacheMissCount", [{ Name: "ApiName", Value: "stage-observability" }, { Name: "Stage", Value: "dev" }]), 1); assert.equal(await statistic("CacheHitCount", [{ Name: "ApiName", Value: "stage-observability" }, { Name: "Stage", Value: "dev" }]), undefined);
    const executionBase = await logs.send(new FilterLogEventsCommand({ logGroupName: `API-Gateway-Execution-Logs_${api.id}/dev` })); const executionCanary = await logs.send(new FilterLogEventsCommand({ logGroupName: `API-Gateway-Execution-Logs_${api.id}/dev/Canary` })); assert.match(executionBase.events?.[0].message ?? "", /Endpoint request body after transformations/); assert.match(executionCanary.events?.[0].message ?? "", /Method completed with status: 200/); const accessBase = await logs.send(new FilterLogEventsCommand({ logGroupName: "/learning/apig-access" })); const accessCanary = await logs.send(new FilterLogEventsCommand({ logGroupName: "/learning/apig-access/Canary" })); assert.equal(JSON.parse(accessBase.events?.[0].message ?? "{}").canary, "false"); assert.deepEqual(JSON.parse(accessCanary.events?.[0].message ?? "{}"), { requestId: second.headers.get("x-amzn-requestid"), canary: "true", deployment: canary.id, status: "200" });

    await apigateway.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [{ op: "add", path: "/*/*/throttling/burstLimit", value: "1" }, { op: "add", path: "/*/*/throttling/rateLimit", value: "1" }] })); assert.equal((await fetch(invoke)).status, 200); const throttled = await fetch(invoke); assert.equal(throttled.status, 429); assert.equal(throttled.headers.get("retry-after"), "1"); clock.advance(1_000); assert.equal((await fetch(invoke)).status, 200);
    const methodThrottle = await apigateway.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [{ op: "remove", path: "/*/*/throttling/burstLimit" }, { op: "remove", path: "/*/*/throttling/rateLimit" }, { op: "add", path: "/~1items/GET/throttling/burstLimit", value: "1" }, { op: "add", path: "/~1items/GET/throttling/rateLimit", value: "1" }] })); assert.equal(methodThrottle.methodSettings?.["/items/GET"]?.throttlingBurstLimit, 1); assert.equal((await fetch(invoke)).status, 200); assert.equal((await fetch(invoke)).status, 429); clock.advance(1_000); assert.equal((await fetch(invoke)).status, 200);

    clients.splice(0).forEach(client => client.destroy()); await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); const restartedOptions = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }; const restartedGateway = new APIGatewayClient(restartedOptions); const restartedLogs = new CloudWatchLogsClient(restartedOptions); clients.push(restartedGateway, restartedLogs); const restarted = await restartedGateway.send(new GetStageCommand({ restApiId: api.id!, stageName: "dev" })); assert.equal(restarted.canarySettings?.deploymentId, canary.id); assert.equal(restarted.methodSettings?.["*/*"]?.loggingLevel, "INFO"); assert.equal(restarted.methodSettings?.["/items/GET"]?.throttlingRateLimit, 1); assert.deepEqual(restarted.tags, { team: "learning" }); assert.equal((await restartedGateway.send(new GetAccountCommand({}))).cloudwatchRoleArn, role.Role!.Arn); const afterRestart = await fetch(`http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/items`); assert.deepEqual(await afterRestart.json(), { deployment: "base", release: "stable" }); assert.ok((await restartedLogs.send(new FilterLogEventsCommand({ logGroupName: `API-Gateway-Execution-Logs_${api.id}/dev` }))).events?.length);
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("API Gateway enforces the regional account token bucket", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-account-throttle-")); const clock = new TestClock(Date.parse("2026-07-16T11:00:00Z")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, apiGatewayRateLimit: 1, apiGatewayBurstLimit: 1, authMode: "off"}); let apigateway: APIGatewayClient | undefined;
  try {
    await simulator.start(); apigateway = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }); const api = await apigateway.send(new CreateRestApiCommand({ name: "account-throttle" })); const resource = (await apigateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(item => item.path === "/")!; await apigateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", authorizationType: "NONE" })); await apigateway.send(new PutMethodResponseCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", statusCode: "200" })); await apigateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } })); await apigateway.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", statusCode: "200", responseTemplates: { "application/json": "{\"ok\":true}" } })); await apigateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" })); const invoke = `http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/`; assert.equal((await fetch(invoke)).status, 200); assert.equal((await fetch(invoke)).status, 429); clock.advance(1_000); assert.equal((await fetch(invoke)).status, 200);
  } finally { apigateway?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
