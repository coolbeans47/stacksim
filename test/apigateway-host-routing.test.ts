import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { APIGatewayClient, CreateDeploymentCommand, CreateResourceCommand, CreateRestApiCommand, GetResourcesCommand, PutIntegrationCommand, PutIntegrationResponseCommand, PutMethodCommand, PutMethodResponseCommand } from "@aws-sdk/client-api-gateway";
import { ApiGatewayV2Client, CreateApiCommand, CreateIntegrationCommand, CreateRouteCommand, CreateStageCommand } from "@aws-sdk/client-apigatewayv2";
import { AddPermissionCommand, CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { StackSim } from "../src/server.js";

const simulators: StackSim[] = []; const roots: string[] = [];
afterEach(async () => {
  await Promise.all(simulators.splice(0).map(simulator => simulator.stop().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function zip(name: string, content: string): Buffer { const fileName = Buffer.from(name); const body = Buffer.from(content); const checksum = crc32(body); const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(fileName.length, 26); const centralOffset = local.length + fileName.length + body.length; const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + fileName.length, 12); end.writeUInt32LE(centralOffset, 16); return Buffer.concat([local, fileName, body, central, fileName, end]); }
function raw(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => { const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host } }, res => { const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })); }); req.on("error", reject); req.end(); });
}

test("DPG-12c: Host-based {apiId}.execute-api.localhost routing reaches REST and HTTP APIs like the /{apiId} path form", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-host-")); roots.push(root);
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" }); simulators.push(simulator); await simulator.start();
  const options = { region: "eu-west-1", endpoint: `http://127.0.0.1:${simulator.port}`, credentials };
  const rest = new APIGatewayClient(options); const apig = new ApiGatewayV2Client(options); const lambda = new LambdaClient(options); const port = simulator.invokePort;

  // REST API: MOCK GET /hello deployed to prod.
  const restApi = await rest.send(new CreateRestApiCommand({ name: "host-rest" }));
  const rootId = (await rest.send(new GetResourcesCommand({ restApiId: restApi.id }))).items!.find(item => item.path === "/")!.id;
  const hello = await rest.send(new CreateResourceCommand({ restApiId: restApi.id, parentId: rootId, pathPart: "hello" }));
  await rest.send(new PutMethodCommand({ restApiId: restApi.id, resourceId: hello.id, httpMethod: "GET", authorizationType: "NONE" }));
  await rest.send(new PutIntegrationCommand({ restApiId: restApi.id, resourceId: hello.id, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\": 200}" } }));
  await rest.send(new PutMethodResponseCommand({ restApiId: restApi.id, resourceId: hello.id, httpMethod: "GET", statusCode: "200" }));
  await rest.send(new PutIntegrationResponseCommand({ restApiId: restApi.id, resourceId: hello.id, httpMethod: "GET", statusCode: "200", responseTemplates: { "application/json": "{\"hello\":\"rest\"}" } }));
  await rest.send(new CreateDeploymentCommand({ restApiId: restApi.id, stageName: "prod" }));
  const pathForm = await raw(port, `/${restApi.id}/prod/hello`, `localhost:${port}`); assert.equal(pathForm.status, 200); assert.deepEqual(JSON.parse(pathForm.body), { hello: "rest" });
  const hostForm = await raw(port, "/prod/hello", `${restApi.id}.execute-api.localhost:${port}`); assert.equal(hostForm.status, 200); assert.deepEqual(JSON.parse(hostForm.body), { hello: "rest" });
  const awsHost = await raw(port, "/prod/hello", `${restApi.id}.execute-api.eu-west-1.amazonaws.com`); assert.equal(awsHost.status, 200);
  const unknownHost = await raw(port, "/prod/hello", `nosuchapi1.execute-api.localhost:${port}`); assert.notEqual(unknownHost.status, 200, "a Host naming no API keeps today's path-based behavior");

  // HTTP API: Lambda proxy route on $default (no stage segment) and on a named stage.
  const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "host-http", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: "index.handler", Code: { ZipFile: zip("index.js", "exports.handler = async event => ({ statusCode: 200, body: JSON.stringify({ stage: event.requestContext.stage, routeKey: event.routeKey, rawPath: event.rawPath }) });") } }));
  await lambda.send(new AddPermissionCommand({ FunctionName: "host-http", StatementId: "gateway", Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com" }));
  const httpApi = await apig.send(new CreateApiCommand({ Name: "host-http", ProtocolType: "HTTP" }));
  const integration = await apig.send(new CreateIntegrationCommand({ ApiId: httpApi.ApiId, IntegrationType: "AWS_PROXY", IntegrationUri: fn.FunctionArn, PayloadFormatVersion: "2.0" }));
  await apig.send(new CreateRouteCommand({ ApiId: httpApi.ApiId, RouteKey: "GET /hello", Target: `integrations/${integration.IntegrationId}` }));
  await apig.send(new CreateStageCommand({ ApiId: httpApi.ApiId, StageName: "$default", AutoDeploy: true }));
  await apig.send(new CreateStageCommand({ ApiId: httpApi.ApiId, StageName: "beta", AutoDeploy: true }));
  const httpPath = await raw(port, `/${httpApi.ApiId}/hello`, `localhost:${port}`); assert.equal(httpPath.status, 200); assert.equal(JSON.parse(httpPath.body).stage, "$default");
  const httpHost = await raw(port, "/hello", `${httpApi.ApiId}.execute-api.localhost:${port}`); assert.equal(httpHost.status, 200, httpHost.body); assert.deepEqual(JSON.parse(httpHost.body), { stage: "$default", routeKey: "GET /hello", rawPath: "/hello" });
  const httpStage = await raw(port, "/beta/hello", `${httpApi.ApiId}.execute-api.localhost:${port}`); assert.equal(httpStage.status, 200, httpStage.body); assert.equal(JSON.parse(httpStage.body).stage, "beta"); assert.equal(JSON.parse(httpStage.body).rawPath, "/beta/hello", "AWS includes a named stage in rawPath for host-based requests too");
  const httpStagePath = await raw(port, `/${httpApi.ApiId}/beta/hello`, `localhost:${port}`); assert.equal(httpStagePath.status, 200, httpStagePath.body); assert.equal(JSON.parse(httpStagePath.body).rawPath, "/beta/hello");
  rest.destroy(); apig.destroy(); lambda.destroy();
});
