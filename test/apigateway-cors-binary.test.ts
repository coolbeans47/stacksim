import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  DeleteGatewayResponseCommand,
  GetGatewayResponseCommand,
  GetGatewayResponsesCommand,
  GetResourcesCommand,
  GetRestApiCommand,
  PutGatewayResponseCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
  PutRestApiCommand,
  UpdateGatewayResponseCommand,
  UpdateRestApiCommand,
} from "@aws-sdk/client-api-gateway";
import { CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { StateStore } from "../src/state.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function rawRequest(url: string, headers: Record<string, string>, body: Buffer): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => { const target = new URL(url); const req = request({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: "POST", headers: { ...headers, "content-length": String(body.length) } }, res => { const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk))); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })); }); req.on("error", reject); req.end(body); });
}

test("API Gateway CORS, binary media, compression, and gateway responses use SDK-visible deployment state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-cors-binary-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const gateway = new APIGatewayClient({ endpoint, region: "eu-west-1", credentials }); const lambda = new LambdaClient({ endpoint, region: "eu-west-1", credentials }); clients.push(gateway, lambda);
    const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip")); await lambda.send(new CreateFunctionCommand({ FunctionName: "binary-proxy", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: "handler.binaryProxyHandler", Code: { ZipFile: zip } }));
    const api = await gateway.send(new CreateRestApiCommand({ name: "cors-binary", binaryMediaTypes: ["application/octet-stream"], minimumCompressionSize: 0 })); assert.deepEqual(api.binaryMediaTypes, ["application/octet-stream"]); assert.equal(api.minimumCompressionSize, 0);
    await gateway.send(new UpdateRestApiCommand({ restApiId: api.id!, patchOperations: [{ op: "add", path: "/binaryMediaTypes/image~1png" }, { op: "replace", path: "/minimumCompressionSize", value: "1" }] })); const updated = await gateway.send(new GetRestApiCommand({ restApiId: api.id! })); assert.deepEqual(updated.binaryMediaTypes, ["application/octet-stream", "image/png"]); assert.equal(updated.minimumCompressionSize, 1);
    await gateway.send(new PutRestApiCommand({ restApiId: api.id!, mode: "overwrite", body: Buffer.from(JSON.stringify({ swagger: "2.0", info: { title: "media settings", version: "1" }, paths: {}, "x-amazon-apigateway-binary-media-types": ["application/octet-stream", "image/png"], "x-amazon-apigateway-minimum-compression-size": 1 })) })); const put = await gateway.send(new GetRestApiCommand({ restApiId: api.id! })); assert.deepEqual(put.binaryMediaTypes, ["application/octet-stream", "image/png"]); assert.equal(put.minimumCompressionSize, 1);
    await assert.rejects(gateway.send(new UpdateRestApiCommand({ restApiId: api.id!, patchOperations: [{ op: "replace", path: "/minimumCompressionSize", value: "10485761" }] })), (error: any) => error.name === "BadRequestException"); assert.equal((await gateway.send(new GetRestApiCommand({ restApiId: api.id! }))).minimumCompressionSize, 1, "invalid settings update is atomic");

    const defaults = await gateway.send(new GetGatewayResponsesCommand({ restApiId: api.id! })); assert.ok((defaults.items?.length ?? 0) >= 20); assert.equal((await gateway.send(new GetGatewayResponseCommand({ restApiId: api.id!, responseType: "MISSING_AUTHENTICATION_TOKEN" }))).defaultResponse, true);
    await gateway.send(new PutGatewayResponseCommand({ restApiId: api.id!, responseType: "MISSING_AUTHENTICATION_TOKEN", statusCode: "404", responseParameters: { "gatewayresponse.header.Access-Control-Allow-Origin": "'*'", "gatewayresponse.header.x-sim-error": "'missing-route'" }, responseTemplates: { "application/json": "{\"kind\":\"$context.error.responseType\",\"message\":$context.error.messageString}" } }));
    await gateway.send(new UpdateGatewayResponseCommand({ restApiId: api.id!, responseType: "MISSING_AUTHENTICATION_TOKEN", patchOperations: [{ op: "replace", path: "/statusCode", value: "418" }, { op: "add", path: "/responseParameters/gatewayresponse.header.x-updated", value: "'yes'" }] })); const customized = await gateway.send(new GetGatewayResponseCommand({ restApiId: api.id!, responseType: "MISSING_AUTHENTICATION_TOKEN" })); assert.equal(customized.statusCode, "418"); assert.equal(customized.defaultResponse, false); assert.equal(customized.responseParameters?.["gatewayresponse.header.x-updated"], "'yes'");

    const rootResource = (await gateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!; const binary = await gateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: rootResource.id!, pathPart: "binary" }));
    await gateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: binary.id!, httpMethod: "POST", authorizationType: "NONE" })); await gateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: binary.id!, httpMethod: "POST", type: "AWS_PROXY", integrationHttpMethod: "POST", uri: "arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-1:000000000000:function:binary-proxy/invocations" }));
    await gateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: binary.id!, httpMethod: "OPTIONS", authorizationType: "NONE" })); await gateway.send(new PutMethodResponseCommand({ restApiId: api.id!, resourceId: binary.id!, httpMethod: "OPTIONS", statusCode: "200", responseParameters: { "method.response.header.Access-Control-Allow-Origin": true, "method.response.header.Access-Control-Allow-Methods": true, "method.response.header.Access-Control-Allow-Headers": true, "method.response.header.Access-Control-Allow-Credentials": true, "method.response.header.Access-Control-Expose-Headers": true } })); await gateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: binary.id!, httpMethod: "OPTIONS", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" }, contentHandling: "CONVERT_TO_TEXT" })); await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: binary.id!, httpMethod: "OPTIONS", statusCode: "200", responseParameters: { "method.response.header.Access-Control-Allow-Origin": "'https://app.example'", "method.response.header.Access-Control-Allow-Methods": "'POST,OPTIONS'", "method.response.header.Access-Control-Allow-Headers": "'content-type,x-token'", "method.response.header.Access-Control-Allow-Credentials": "'true'", "method.response.header.Access-Control-Expose-Headers": "'x-request-was-base64'" } }));
    await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" })); const invoke = `http://127.0.0.1:${simulator.invokePort}/${api.id}/dev`;

    const preflight = await fetch(`${invoke}/binary`, { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-token" } }); assert.equal(preflight.status, 200); assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.example"); assert.equal(preflight.headers.get("access-control-allow-credentials"), "true"); assert.equal(preflight.headers.get("access-control-expose-headers"), "x-request-was-base64");
    const payload = Buffer.from([0, 1, 2, 127, 128, 254, 255]); const roundTrip = await fetch(`${invoke}/binary`, { method: "POST", headers: { "content-type": "application/octet-stream", accept: "application/octet-stream" }, body: payload }); assert.equal(roundTrip.status, 200); assert.equal(roundTrip.headers.get("x-request-was-base64"), "true"); assert.deepEqual(Buffer.from(await roundTrip.arrayBuffer()), payload);
    const textAccept = await fetch(`${invoke}/binary`, { method: "POST", headers: { "content-type": "application/octet-stream", accept: "text/plain" }, body: payload }); assert.equal(await textAccept.text(), payload.toString("base64"), "the first Accept media type controls binary decoding");
    const compressed = await rawRequest(`${invoke}/binary`, { "content-type": "application/octet-stream", accept: "application/octet-stream", "accept-encoding": "gzip" }, payload); assert.equal(compressed.status, 200); assert.equal(compressed.headers["content-encoding"], "gzip"); assert.deepEqual(gunzipSync(compressed.body), payload);
    const missing = await fetch(`${invoke}/does-not-exist`); assert.equal(missing.status, 418); assert.equal(missing.headers.get("x-sim-error"), "missing-route"); assert.equal(missing.headers.get("x-updated"), "yes"); assert.deepEqual(await missing.json(), { kind: "MISSING_AUTHENTICATION_TOKEN", message: "Missing Authentication Token" });

    await gateway.send(new DeleteGatewayResponseCommand({ restApiId: api.id!, responseType: "MISSING_AUTHENTICATION_TOKEN" })); assert.equal((await gateway.send(new GetGatewayResponseCommand({ restApiId: api.id!, responseType: "MISSING_AUTHENTICATION_TOKEN" }))).defaultResponse, true); const deployedStillCustomized = await fetch(`${invoke}/still-missing`); assert.equal(deployedStillCustomized.status, 418, "deployment snapshots freeze gateway responses");
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("schema v3 migration initializes API Gateway media and gateway-response deployment state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-v3-migration-"));
  try {
    const state = { schemaVersion: 3, installation: { id: "installation", createdAt: 1, paginationSecret: "secret" }, activeAccountId: "000000000000", defaultRegion: "eu-west-1", accounts: { "000000000000": { accountId: "000000000000", partition: "aws", iam: { roles: {}, policies: {}, instanceProfiles: {}, accessKeys: {}, sessions: {}, authorizationDecisions: [] }, regions: { "eu-west-1": { functions: {}, tables: {}, apis: { api: { id: "api", name: "legacy", createdDate: 1, rootResourceId: "root", resources: { root: { id: "root", path: "/", methods: {}, integrations: {} } }, deployments: { deployment: { id: "deployment", createdDate: 1, snapshot: { rootResourceId: "root", resources: { root: { id: "root", path: "/", methods: {}, integrations: {} } }, authorizers: {} } } }, stages: {}, authorizers: {}, binaryMediaTypes: ["image/png"], minimumCompressionSize: 128 } }, logs: {}, metrics: { points: {}, alarms: {} } } } } } };
    await writeFile(join(root, "state.json"), JSON.stringify(state)); const store = new StateStore(root, "000000000000", "eu-west-1"); await store.load(); const api = store.regionState("eu-west-1").apis.api; const snapshot = api.deployments.deployment.snapshot!; assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.deepEqual(api.gatewayResponses, {}); assert.deepEqual(Object.keys(api.models ?? {}).sort(), ["Empty", "Error"]); assert.deepEqual(api.requestValidators, {}); assert.deepEqual(snapshot.binaryMediaTypes, ["image/png"]); assert.equal(snapshot.minimumCompressionSize, 128); assert.deepEqual(snapshot.gatewayResponses, {}); assert.deepEqual(Object.keys(snapshot.models ?? {}).sort(), ["Empty", "Error"]); assert.deepEqual(snapshot.requestValidators, {}); assert.deepEqual(store.regionState("eu-west-1").cloudwatch, { alarms: {}, compositeAlarms: {}, logAlarms: {}, alarmMuteRules: {}, anomalyDetectors: {}, metricStreams: {}, insightRules: {}, alarmHistory: [], eventBridgeOutbox: [], snsActionOutbox: [], lambdaActionOutbox: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
