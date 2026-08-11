import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateAuthorizerCommand,
  CreateDeploymentCommand,
  CreateIntegrationCommand,
  CreateIntegrationResponseCommand,
  CreateModelCommand,
  CreateRouteCommand,
  CreateRouteResponseCommand,
  CreateStageCommand,
  GetApiCommand,
  GetApisCommand,
  GetDeploymentCommand,
  GetIntegrationResponseCommand,
  GetModelTemplateCommand,
  GetRouteResponseCommand,
  TagResourceCommand,
  UpdateStageCommand,
} from "@aws-sdk/client-apigatewayv2";
import { ApiGatewayManagementApiClient, DeleteConnectionCommand, GetConnectionCommand, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { AddPermissionCommand, CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CloudWatchClient, ListMetricsCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, CreateLogGroupCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import WebSocket from "ws";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const simulators: StackSim[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(simulators.splice(0).map(simulator => simulator.stop().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function client(simulator: StackSim): ApiGatewayV2Client {
  return new ApiGatewayV2Client({ region: "eu-west-1", endpoint: `http://127.0.0.1:${simulator.port}`, credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
}

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function zip(name: string, content: string): Buffer { const fileName = Buffer.from(name); const body = Buffer.from(content); const checksum = crc32(body); const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(fileName.length, 26); const centralOffset = local.length + fileName.length + body.length; const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + fileName.length, 12); end.writeUInt32LE(centralOffset, 16); return Buffer.concat([local, fileName, body, central, fileName, end]); }
function deadline<T>(label: string, subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { onTimeout?.(); reject(new Error(`Timed out waiting for ${label}`)); }, 10_000); subscribe(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); }); });
}
function onceOpen(socket: WebSocket): Promise<void> { return deadline("WebSocket open", (resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); socket.once("unexpected-response", (_request, response) => { const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("end", () => reject(new Error(`Unexpected server response ${response.statusCode}: ${Buffer.concat(chunks).toString("utf8")}`))); }); }, () => socket.terminate()); }
function onceMessage(socket: WebSocket): Promise<Buffer> { return deadline("WebSocket message", (resolve, reject) => { socket.once("message", data => resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as any))); socket.once("error", reject); }, () => socket.terminate()); }
function onceClose(socket: WebSocket): Promise<{ code: number; reason: string }> { return deadline("WebSocket close", resolve => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }))); }

test("API Gateway v2 WebSocket control plane supports SDK resources, snapshots, tags, pagination, and current-schema persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-ws-control-")); roots.push(root);
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); simulators.push(simulator); await simulator.start();
  let apig = client(simulator);
  const http = await apig.send(new CreateApiCommand({ Name: "http-peer", ProtocolType: "HTTP" }));
  const api = await apig.send(new CreateApiCommand({ Name: "chat", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action", Tags: { phase: "APIG-12" } }));
  assert.equal(api.ProtocolType, "WEBSOCKET"); assert.match(api.ApiEndpoint!, /^ws:\/\/localhost:\d+\//);
  const firstPage = await apig.send(new GetApisCommand({ MaxResults: "1" })); assert.equal(firstPage.Items?.length, 1); assert.ok(firstPage.NextToken);
  const secondPage = await apig.send(new GetApisCommand({ MaxResults: "1", NextToken: firstPage.NextToken })); assert.equal(secondPage.Items?.length, 1); assert.deepEqual(new Set([firstPage.Items![0].ApiId, secondPage.Items![0].ApiId]), new Set([api.ApiId, http.ApiId]));
  await assert.rejects(apig.send(new GetApisCommand({ NextToken: `${firstPage.NextToken}x` })), (error: any) => error.name === "BadRequestException");

  const proxy = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "AWS_PROXY", IntegrationMethod: "POST", IntegrationUri: "arn:aws:lambda:eu-west-1:000000000000:function:chat-handler" }));
  const custom = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "MOCK", RequestTemplates: { "$default": "{\"statusCode\":200}" } }));
  const integrationResponse = await apig.send(new CreateIntegrationResponseCommand({ ApiId: api.ApiId, IntegrationId: custom.IntegrationId, IntegrationResponseKey: "$default", ResponseTemplates: { "$default": "ok" } }));
  assert.equal((await apig.send(new GetIntegrationResponseCommand({ ApiId: api.ApiId, IntegrationId: custom.IntegrationId, IntegrationResponseId: integrationResponse.IntegrationResponseId }))).IntegrationResponseKey, "$default");
  const authorizer = await apig.send(new CreateAuthorizerCommand({ ApiId: api.ApiId, Name: "connect-auth", AuthorizerType: "REQUEST", AuthorizerUri: "arn:aws:lambda:eu-west-1:000000000000:function:connect-auth", IdentitySource: ["route.request.header.Authorization"], AuthorizerResultTtlInSeconds: 60 }));
  const connect = await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "$connect", AuthorizationType: "CUSTOM", AuthorizerId: authorizer.AuthorizerId, Target: `integrations/${proxy.IntegrationId}` }));
  const message = await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "send", Target: `integrations/${proxy.IntegrationId}` }));
  const routeResponse = await apig.send(new CreateRouteResponseCommand({ ApiId: api.ApiId, RouteId: message.RouteId, RouteResponseKey: "$default" }));
  assert.equal((await apig.send(new GetRouteResponseCommand({ ApiId: api.ApiId, RouteId: message.RouteId, RouteResponseId: routeResponse.RouteResponseId }))).RouteResponseKey, "$default");
  const model = await apig.send(new CreateModelCommand({ ApiId: api.ApiId, Name: "ChatMessage", ContentType: "application/json", Schema: JSON.stringify({ type: "object", required: ["action"] }) }));
  assert.match((await apig.send(new GetModelTemplateCommand({ ApiId: api.ApiId, ModelId: model.ModelId }))).Value!, /required/);
  const deployment = await apig.send(new CreateDeploymentCommand({ ApiId: api.ApiId, Description: "first" }));
  await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "$default", Target: `integrations/${proxy.IntegrationId}` }));
  assert.equal(Object.keys(simulator.store.regionState("eu-west-1").webSocketApis[api.ApiId!].deployments[deployment.DeploymentId!].snapshot.routes).length, 2);
  await apig.send(new CreateStageCommand({ ApiId: api.ApiId, StageName: "dev", DeploymentId: deployment.DeploymentId, Tags: { env: "test" } }));
  await apig.send(new TagResourceCommand({ ResourceArn: `arn:aws:apigateway:eu-west-1::/apis/${api.ApiId}`, Tags: { owner: "sim" } }));

  apig.destroy(); simulators.splice(simulators.indexOf(simulator), 1); await simulator.stop();
  simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); simulators.push(simulator); await simulator.start(); apig = client(simulator);
  assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal((await apig.send(new GetApiCommand({ ApiId: api.ApiId }))).Tags?.owner, "sim");
  assert.equal((await apig.send(new GetDeploymentCommand({ ApiId: api.ApiId, DeploymentId: deployment.DeploymentId }))).Description, "first");
  assert.equal(simulator.store.regionState("eu-west-1").webSocketApis[api.ApiId!].routes[connect.RouteId!].authorizationType, "CUSTOM");
  apig.destroy();
});

test("WebSocket clients route Lambda proxy messages, use the management API, redeploy snapshots, emit telemetry, and close on stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-ws-runtime-")); roots.push(root);
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); simulators.push(simulator); await simulator.start();
  const options = { region: "eu-west-1", endpoint: `http://127.0.0.1:${simulator.port}`, credentials };
  const apig = new ApiGatewayV2Client(options); const lambda = new LambdaClient(options); const logs = new CloudWatchLogsClient(options); const metrics = new CloudWatchClient(options);
  const api = await apig.send(new CreateApiCommand({ Name: "runtime", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action" }));
  const source = `
exports.handler = async event => {
  if (event.requestContext.eventType === "CONNECT") return { statusCode: 200 };
  if (event.requestContext.eventType === "DISCONNECT") return { statusCode: 200 };
  let message = {}; try { message = JSON.parse(event.body); } catch {}
  if (message.action === "manage") {
    await fetch(process.env.MANAGEMENT_ENDPOINT + "/@connections/" + event.requestContext.connectionId, { method: "POST", body: "lambda-management" });
    return { statusCode: 200 };
  }
  return { statusCode: 200, body: JSON.stringify({ route: event.requestContext.routeKey, body: event.body, connectionId: event.requestContext.connectionId }) };
};`;
  const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "websocket-handler", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: "index.handler", Code: { ZipFile: zip("index.js", source) }, Environment: { Variables: { MANAGEMENT_ENDPOINT: `http://127.0.0.1:${simulator.invokePort}/${api.ApiId}/dev` } } }));
  await lambda.send(new AddPermissionCommand({ FunctionName: fn.FunctionName, StatementId: "gateway", Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com", SourceArn: `arn:aws:execute-api:eu-west-1:000000000000:${api.ApiId}/*` }));
  const integration = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "AWS_PROXY", IntegrationMethod: "POST", IntegrationUri: fn.FunctionArn }));
  await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "$connect", Target: `integrations/${integration.IntegrationId}` }));
  await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "$disconnect", Target: `integrations/${integration.IntegrationId}` }));
  const send = await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "send", Target: `integrations/${integration.IntegrationId}` }));
  await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "manage", Target: `integrations/${integration.IntegrationId}` }));
  const fallback = await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "$default", Target: `integrations/${integration.IntegrationId}` }));
  await apig.send(new CreateRouteResponseCommand({ ApiId: api.ApiId, RouteId: send.RouteId, RouteResponseKey: "$default" }));
  await apig.send(new CreateRouteResponseCommand({ ApiId: api.ApiId, RouteId: fallback.RouteId, RouteResponseKey: "$default" }));
  await logs.send(new CreateLogGroupCommand({ logGroupName: "/aws/apigateway/chat" }));
  const deployment = await apig.send(new CreateDeploymentCommand({ ApiId: api.ApiId }));
  await apig.send(new CreateStageCommand({ ApiId: api.ApiId, StageName: "dev", DeploymentId: deployment.DeploymentId, DefaultRouteSettings: { DetailedMetricsEnabled: true }, AccessLogSettings: { DestinationArn: "arn:aws:logs:eu-west-1:000000000000:log-group:/aws/apigateway/chat", Format: "$context.requestId $context.eventType $context.routeKey $context.connectionId $context.status" } }));
  assert.equal(simulator.store.regionState("eu-west-1").functions["websocket-handler"].state, "Active");
  const endpoint = `ws://127.0.0.1:${simulator.invokePort}/${api.ApiId}/dev`; const first = new WebSocket(endpoint); const second = new WebSocket(endpoint); await Promise.all([onceOpen(first), onceOpen(second)]);
  let next = onceMessage(first); first.send(JSON.stringify({ action: "send", value: 1 })); const routed = JSON.parse((await next).toString("utf8")); assert.equal(routed.route, "send"); assert.match(routed.connectionId, /^[a-f0-9]{12}$/);
  next = onceMessage(first); first.send(JSON.stringify({ action: "manage" })); assert.equal((await next).toString("utf8"), "lambda-management", "a Lambda integration can post to its live connection");
  next = onceMessage(second); second.send("not-json"); assert.equal(JSON.parse((await next).toString("utf8")).route, "$default");
  const management = new ApiGatewayManagementApiClient({ region: "eu-west-1", endpoint: `http://127.0.0.1:${simulator.invokePort}/${api.ApiId}/dev`, credentials });
  const described = await management.send(new GetConnectionCommand({ ConnectionId: routed.connectionId })); assert.ok(described.ConnectedAt instanceof Date); assert.equal(typeof described.Identity?.SourceIp, "string"); assert.equal(typeof described.Identity?.UserAgent, "string");
  next = onceMessage(first); await management.send(new PostToConnectionCommand({ ConnectionId: routed.connectionId, Data: Buffer.from("management-message") })); assert.equal((await next).toString("utf8"), "management-message");
  await assert.rejects(management.send(new PostToConnectionCommand({ ConnectionId: "missing", Data: Buffer.from("x") })), (error: any) => error.name === "GoneException");

  const fresh = await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "fresh", Target: `integrations/${integration.IntegrationId}` })); await apig.send(new CreateRouteResponseCommand({ ApiId: api.ApiId, RouteId: fresh.RouteId, RouteResponseKey: "$default" }));
  next = onceMessage(first); first.send(JSON.stringify({ action: "fresh" })); assert.equal(JSON.parse((await next).toString("utf8")).route, "$default", "an existing connection retains its deployment snapshot");
  const nextDeployment = await apig.send(new CreateDeploymentCommand({ ApiId: api.ApiId })); await apig.send(new UpdateStageCommand({ ApiId: api.ApiId, StageName: "dev", DeploymentId: nextDeployment.DeploymentId }));
  const reconnected = new WebSocket(endpoint); await onceOpen(reconnected); next = onceMessage(reconnected); reconnected.send(JSON.stringify({ action: "fresh" })); assert.equal(JSON.parse((await next).toString("utf8")).route, "fresh");
  const listedMetrics = await metrics.send(new ListMetricsCommand({ Namespace: "AWS/ApiGateway", Dimensions: [{ Name: "ApiId", Value: api.ApiId }] })); assert.ok(listedMetrics.Metrics?.some(metric => metric.MetricName === "ConnectCount")); assert.ok(listedMetrics.Metrics?.some(metric => metric.MetricName === "MessageCount"));
  const logEvents = await logs.send(new FilterLogEventsCommand({ logGroupName: "/aws/apigateway/chat" })); assert.ok(logEvents.events?.some(event => event.message?.includes("CONNECT $connect"))); assert.ok(logEvents.events?.some(event => event.message?.includes("MESSAGE send")));
  const firstClosed = onceClose(first); await management.send(new DeleteConnectionCommand({ ConnectionId: routed.connectionId })); assert.equal((await firstClosed).code, 1000);
  const stoppedSecond = onceClose(second); const stoppedReconnected = onceClose(reconnected); simulators.splice(simulators.indexOf(simulator), 1); await simulator.stop(); assert.equal((await stoppedSecond).code, 1012); assert.equal((await stoppedReconnected).code, 1012);
  management.destroy(); apig.destroy(); lambda.destroy(); logs.destroy(); metrics.destroy();
});

test("$connect CUSTOM authorization rejects missing and denied identities, while protocol and idle closes use AWS-compatible codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-ws-auth-")); roots.push(root);
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, apiGatewayWebSocketIdleTimeoutMs: 80, apiGatewayWebSocketLifetimeMs: 2_000, authMode: "off"}); simulators.push(simulator); await simulator.start();
  const options = { region: "eu-west-1", endpoint: `http://127.0.0.1:${simulator.port}`, credentials }; const apig = new ApiGatewayV2Client(options); const lambda = new LambdaClient(options);
  const source = `
exports.handler = async () => ({ statusCode: 200 });
exports.authorizer = async event => ({ principalId: "client", policyDocument: { Version: "2012-10-17", Statement: [{ Effect: event.headers.authorization === "allow" ? "Allow" : "Deny", Action: "execute-api:Invoke", Resource: event.methodArn }] }, context: { authenticated: true } });`;
  const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "websocket-auth", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: "index.handler", Code: { ZipFile: zip("index.js", source) } }));
  const authFn = await lambda.send(new CreateFunctionCommand({ FunctionName: "websocket-authorizer", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: "index.authorizer", Code: { ZipFile: zip("index.js", source) } }));
  const api = await apig.send(new CreateApiCommand({ Name: "authorized", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action" }));
  const integration = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "AWS_PROXY", IntegrationMethod: "POST", IntegrationUri: fn.FunctionArn }));
  const authorizer = await apig.send(new CreateAuthorizerCommand({ ApiId: api.ApiId, Name: "clients", AuthorizerType: "REQUEST", AuthorizerUri: authFn.FunctionArn, IdentitySource: ["route.request.header.Authorization"], AuthorizerResultTtlInSeconds: 0 }));
  await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "$connect", AuthorizationType: "CUSTOM", AuthorizerId: authorizer.AuthorizerId, Target: `integrations/${integration.IntegrationId}` }));
  const deployment = await apig.send(new CreateDeploymentCommand({ ApiId: api.ApiId })); await apig.send(new CreateStageCommand({ ApiId: api.ApiId, StageName: "dev", DeploymentId: deployment.DeploymentId }));
  const endpoint = `ws://127.0.0.1:${simulator.invokePort}/${api.ApiId}/dev`;
  await assert.rejects(onceOpen(new WebSocket(endpoint)), /401/);
  await assert.rejects(onceOpen(new WebSocket(endpoint, { headers: { authorization: "deny" } })), /403/);
  const binary = new WebSocket(endpoint, { headers: { authorization: "allow" } }); await onceOpen(binary); const binaryClosed = onceClose(binary); binary.send(Buffer.from([1, 2, 3])); assert.equal((await binaryClosed).code, 1003);
  const idle = new WebSocket(endpoint, { headers: { authorization: "allow" } }); await onceOpen(idle); const idleClosed = await onceClose(idle); assert.equal(idleClosed.code, 1001); assert.match(idleClosed.reason, /Idle timeout/);
  apig.destroy(); lambda.destroy();
});
