import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ApiGatewayV2Client, CreateApiCommand, CreateAuthorizerCommand, CreateIntegrationCommand, CreateIntegrationResponseCommand, CreateRouteCommand, CreateRouteResponseCommand, CreateStageCommand, GetIntegrationCommand, UpdateIntegrationCommand } from "@aws-sdk/client-apigatewayv2";
import { ApiGatewayManagementApiClient, GetConnectionCommand, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { AddPermissionCommand, CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import WebSocket from "ws";
import { StackSim } from "../src/server.js";

const simulators: StackSim[] = []; const roots: string[] = []; const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(simulators.splice(0).map(simulator => simulator.stop().catch(() => undefined)));
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function zip(name: string, content: string): Buffer { const fileName = Buffer.from(name); const body = Buffer.from(content); const checksum = crc32(body); const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(fileName.length, 26); const centralOffset = local.length + fileName.length + body.length; const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + fileName.length, 12); end.writeUInt32LE(centralOffset, 16); return Buffer.concat([local, fileName, body, central, fileName, end]); }
function deadline<T>(label: string, subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { onTimeout?.(); reject(new Error(`Timed out waiting for ${label}`)); }, 10_000); subscribe(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); }); });
}
function onceOpen(socket: WebSocket): Promise<void> { return deadline("WebSocket open", (resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); socket.once("unexpected-response", (_request, response) => { const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("end", () => reject(new Error(`Unexpected server response ${response.statusCode}: ${Buffer.concat(chunks).toString("utf8")}`))); }); }, () => socket.terminate()); }
function onceMessage(socket: WebSocket): Promise<{ text: string; binary: boolean }> { return deadline("WebSocket message", (resolve, reject) => { socket.once("message", (data, binary) => resolve({ text: (Buffer.isBuffer(data) ? data : Buffer.from(data as any)).toString("utf8"), binary })); socket.once("error", reject); }, () => socket.terminate()); }
function onceClose(socket: WebSocket): Promise<number> { return deadline("WebSocket close", resolve => socket.once("close", code => resolve(code))); }
function raw(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => { const req = request({ host: "127.0.0.1", port, method, path, headers }, res => { const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers })); }); req.on("error", reject); req.end(body); });
}

/** A local HTTP sink the Lambda posts its events to, so tests can inspect CONNECT, MESSAGE, and DISCONNECT payloads. */
async function eventSink(): Promise<{ url: string; events: any[]; requests: Array<{ url: string; headers: Record<string, unknown>; body: string }>; next(predicate: (event: any) => boolean): Promise<any> }> {
  const events: any[] = []; const requests: Array<{ url: string; headers: Record<string, unknown>; body: string }> = []; const waiters: Array<{ predicate: (event: any) => boolean; resolve: (event: any) => void }> = [];
  const server = createServer((req, res) => { const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => { const body = Buffer.concat(chunks).toString("utf8"); requests.push({ url: req.url ?? "", headers: req.headers, body }); if (req.url === "/events") { const event = JSON.parse(body); events.push(event); for (const waiter of waiters.splice(0)) { if (waiter.predicate(event)) waiter.resolve(event); else waiters.push(waiter); } res.end(); return; } res.setHeader("content-type", "application/json"); res.statusCode = req.url?.startsWith("/fail") ? 404 : 200; res.end(JSON.stringify({ echoed: body, path: req.url })); }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, events, requests, next: predicate => { const found = events.find(predicate); return found ? Promise.resolve(found) : deadline("Lambda event", resolve => waiters.push({ predicate, resolve })); } };
}

const handlerSource = `
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require("@aws-sdk/client-apigatewaymanagementapi");
exports.handler = async event => {
  const ctx = event.requestContext;
  if (process.env.SINK) await fetch(process.env.SINK + "/events", { method: "POST", body: JSON.stringify(event) });
  if (ctx.eventType === "CONNECT") { const offered = event.headers?.["sec-websocket-protocol"]; return offered ? { statusCode: 200, headers: { "Sec-WebSocket-Protocol": offered.split(",")[0].trim() } } : { statusCode: 200 }; }
  if (ctx.eventType === "DISCONNECT") return { statusCode: 200 };
  let message = {}; try { message = JSON.parse(event.body); } catch {}
  if (message.action === "callback") { const client = new ApiGatewayManagementApiClient({ endpoint: "http://" + ctx.domainName + "/" + ctx.stage }); await client.send(new PostToConnectionCommand({ ConnectionId: ctx.connectionId, Data: "via-domain" })); return { statusCode: 200 }; }
  if (message.action === "implicit") { const client = new ApiGatewayManagementApiClient({}); await client.send(new PostToConnectionCommand({ ConnectionId: ctx.connectionId, Data: "via-env" })); return { statusCode: 200 }; }
  return { statusCode: 200, body: JSON.stringify({ authorizer: ctx.authorizer ?? null, domainName: ctx.domainName }) };
};
exports.authorizer = async event => ({ principalId: "user-" + event.queryStringParameters.user, policyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: event.methodArn }] }, context: { tenant: "acme", admin: true, level: 3 } });
exports.raw = async event => ({ received: event, note: "non-proxy" });
`;

async function setup(sinkUrl?: string) {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-ws-parity-")); roots.push(root);
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" }); simulators.push(simulator); await simulator.start();
  const options = { region: "eu-west-1", endpoint: `http://127.0.0.1:${simulator.port}`, credentials };
  const apig = new ApiGatewayV2Client(options); const lambda = new LambdaClient(options);
  const fn = async (name: string, handler: string) => { const created = await lambda.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: handler, Code: { ZipFile: zip("index.js", handlerSource) }, Environment: sinkUrl ? { Variables: { SINK: sinkUrl } } : undefined })); await lambda.send(new AddPermissionCommand({ FunctionName: name, StatementId: "gateway", Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com" })); return created.FunctionArn!; };
  return { simulator, apig, lambda, fn };
}

test("DPG-12/13/32 and §6: Lambda callbacks via domainName/stage and AWS_ENDPOINT_URL, authorizer context on every route, subprotocols, and query-string parity", async () => {
  const sink = await eventSink(); const { simulator, apig, lambda, fn } = await setup(sink.url);
  const handlerArn = await fn("ws-parity-handler", "index.handler"); const authorizerArn = await fn("ws-parity-authorizer", "index.authorizer");
  const api = await apig.send(new CreateApiCommand({ Name: "parity", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action" }));
  const integration = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "AWS_PROXY", IntegrationUri: handlerArn }));
  const authorizer = await apig.send(new CreateAuthorizerCommand({ ApiId: api.ApiId, Name: "users", AuthorizerType: "REQUEST", AuthorizerUri: authorizerArn, IdentitySource: ["route.request.querystring.user"], AuthorizerResultTtlInSeconds: 0 }));
  await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "$connect", AuthorizationType: "CUSTOM", AuthorizerId: authorizer.AuthorizerId, Target: `integrations/${integration.IntegrationId}` }));
  await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "$disconnect", Target: `integrations/${integration.IntegrationId}` }));
  const fallback = await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "$default", Target: `integrations/${integration.IntegrationId}` }));
  await apig.send(new CreateRouteResponseCommand({ ApiId: api.ApiId, RouteId: fallback.RouteId, RouteResponseKey: "$default" }));
  await apig.send(new CreateStageCommand({ ApiId: api.ApiId, StageName: "dev", AutoDeploy: true }));
  await apig.send(new CreateStageCommand({ ApiId: api.ApiId, StageName: "prod", AutoDeploy: true }));
  const port = simulator.invokePort;

  // §6: repeated query keys keep the last value in queryStringParameters; the multi-value map keeps all.
  const socket = new WebSocket(`ws://127.0.0.1:${port}/${api.ApiId}/dev?user=ann&tag=a&tag=b`, ["chat.v2", "token-abc"]); await onceOpen(socket);
  assert.equal(socket.protocol, "chat.v2", "the $connect Sec-WebSocket-Protocol header is returned in the 101 response");
  const connectEvent = await sink.next(event => event.requestContext.eventType === "CONNECT");
  assert.equal(connectEvent.queryStringParameters.tag, "b"); assert.deepEqual(connectEvent.multiValueQueryStringParameters.tag, ["a", "b"]);
  assert.equal(connectEvent.requestContext.authorizer.principalId, "user-ann");
  const connectionId = connectEvent.requestContext.connectionId; assert.equal(connectEvent.requestContext.domainName, `127.0.0.1:${port}`);

  // DPG-13: MESSAGE events carry the $connect authorizer result (principalId, stringified context, integrationLatency).
  let next = onceMessage(socket); socket.send(JSON.stringify({ action: "whoami" })); const whoami = JSON.parse((await next).text);
  assert.equal(whoami.authorizer.principalId, "user-ann"); assert.equal(whoami.authorizer.tenant, "acme"); assert.equal(whoami.authorizer.admin, "true"); assert.equal(whoami.authorizer.level, "3"); assert.equal(typeof whoami.authorizer.integrationLatency, "number");

  // DPG-12a: new ApiGatewayManagementApiClient({ endpoint: `http://${domainName}/${stage}` }) inside the Lambda.
  next = onceMessage(socket); socket.send(JSON.stringify({ action: "callback" })); assert.equal((await next).text, "via-domain");
  // DPG-12b: a client with no explicit endpoint uses AWS_ENDPOINT_URL (the control port) and posts /@connections/{id}.
  next = onceMessage(socket); socket.send(JSON.stringify({ action: "implicit" })); assert.equal((await next).text, "via-env");

  // The short /{stage} form resolves the connection; the wrong (existing) stage is 410 Gone; an unknown stage or API is 403 Forbidden.
  const shortForm = new ApiGatewayManagementApiClient({ region: "eu-west-1", endpoint: `http://127.0.0.1:${port}/dev`, credentials });
  next = onceMessage(socket); await shortForm.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from("short-form") })); assert.equal((await next).text, "short-form");
  assert.ok((await shortForm.send(new GetConnectionCommand({ ConnectionId: connectionId }))).ConnectedAt instanceof Date);
  const wrongStage = new ApiGatewayManagementApiClient({ region: "eu-west-1", endpoint: `http://127.0.0.1:${port}/prod`, credentials });
  await assert.rejects(wrongStage.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from("x") })), (error: any) => error.name === "GoneException" && error.$metadata.httpStatusCode === 410);
  const wrongStageFull = new ApiGatewayManagementApiClient({ region: "eu-west-1", endpoint: `http://127.0.0.1:${port}/${api.ApiId}/prod`, credentials });
  await assert.rejects(wrongStageFull.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from("x") })), (error: any) => error.name === "GoneException");
  const missingStage = new ApiGatewayManagementApiClient({ region: "eu-west-1", endpoint: `http://127.0.0.1:${port}/${api.ApiId}/nope`, credentials });
  await assert.rejects(missingStage.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from("x") })), (error: any) => error.$metadata.httpStatusCode === 403);
  const controlPort = new ApiGatewayManagementApiClient({ region: "eu-west-1", endpoint: `http://127.0.0.1:${simulator.port}`, credentials });
  next = onceMessage(socket); await controlPort.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from("control-port") })); assert.equal((await next).text, "control-port");
  await assert.rejects(controlPort.send(new PostToConnectionCommand({ ConnectionId: "unknownconn1", Data: Buffer.from("x") })), (error: any) => error.name === "GoneException");

  // DPG-12c: host-based management and WebSocket upgrades; domainName then names the execute-api host.
  const host = `${api.ApiId}.execute-api.localhost:${port}`;
  next = onceMessage(socket); const hosted = await raw(port, "POST", `/dev/@connections/${connectionId}`, { host }, "host-based"); assert.equal(hosted.status, 200); assert.equal((await next).text, "host-based");
  next = onceMessage(socket); const awsStyle = await raw(port, "POST", `/dev/@connections/${connectionId}`, { host: `${api.ApiId}.execute-api.eu-west-1.amazonaws.com` }, "aws-host"); assert.equal(awsStyle.status, 200); assert.equal((await next).text, "aws-host");
  const hostSocket = new WebSocket(`ws://127.0.0.1:${port}/dev?user=bob`, { headers: { host } }); await onceOpen(hostSocket); assert.equal(hostSocket.protocol, "", "no subprotocol is returned when none was requested");
  next = onceMessage(hostSocket); hostSocket.send(JSON.stringify({ action: "whoami" })); const hostWhoami = JSON.parse((await next).text);
  assert.equal(hostWhoami.domainName, host); assert.equal(hostWhoami.authorizer.principalId, "user-bob");

  // DPG-13: DISCONNECT events also carry the authorizer.
  const closed = onceClose(socket); socket.close(1000); await closed;
  const disconnectEvent = await sink.next(event => event.requestContext.eventType === "DISCONNECT" && event.requestContext.connectionId === connectionId);
  assert.equal(disconnectEvent.requestContext.authorizer.principalId, "user-ann"); assert.equal(disconnectEvent.requestContext.authorizer.tenant, "acme");
  hostSocket.close(); shortForm.destroy(); wrongStage.destroy(); wrongStageFull.destroy(); missingStage.destroy(); controlPort.destroy(); apig.destroy(); lambda.destroy();
});

test("DPG-33: non-proxy MOCK, AWS, and HTTP integrations evaluate request/response templates, selection expressions, passthrough, and request parameters", async () => {
  const sink = await eventSink(); const { simulator, apig, lambda, fn } = await setup();
  const rawArn = await fn("ws-parity-raw", "index.raw");
  const api = await apig.send(new CreateApiCommand({ Name: "templates", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action" }));
  const route = async (key: string, integrationId: string) => { const created = await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: key, Target: `integrations/${integrationId}` })); await apig.send(new CreateRouteResponseCommand({ ApiId: api.ApiId, RouteId: created.RouteId, RouteResponseKey: "$default" })); };

  const ping = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "MOCK", TemplateSelectionExpression: "\\$default", RequestTemplates: { "$default": "{\"statusCode\":200}" } }));
  await apig.send(new CreateIntegrationResponseCommand({ ApiId: api.ApiId, IntegrationId: ping.IntegrationId, IntegrationResponseKey: "$default", ResponseTemplates: { "$default": "{\"pong\":\"$context.connectionId\",\"route\":\"$context.routeKey\",\"stage\":\"$context.stage\"}" } }));
  await route("ping", ping.IntegrationId!);

  // Request templates selected by ${request.body.kind}; MOCK status comes from the rendered template and picks /4\d\d/ or $default.
  const status = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "MOCK", TemplateSelectionExpression: "${request.body.kind}", RequestTemplates: { bad: "{\"statusCode\":404}", "$default": "{\"statusCode\":200}" } }));
  await apig.send(new CreateIntegrationResponseCommand({ ApiId: api.ApiId, IntegrationId: status.IntegrationId, IntegrationResponseKey: "/4\\d\\d/", ResponseTemplates: { "$default": "client-error $context.connectionId" } }));
  await apig.send(new CreateIntegrationResponseCommand({ ApiId: api.ApiId, IntegrationId: status.IntegrationId, IntegrationResponseKey: "$default", TemplateSelectionExpression: "${request.body.format}", ResponseTemplates: { "$default": "ok", short: "k" } }));
  await route("status", status.IntegrationId!);

  const strict = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "MOCK", PassthroughBehavior: "NEVER", TemplateSelectionExpression: "${request.body.kind}", RequestTemplates: { known: "{\"statusCode\":200}" } }));
  await apig.send(new CreateIntegrationResponseCommand({ ApiId: api.ApiId, IntegrationId: strict.IntegrationId, IntegrationResponseKey: "$default", ResponseTemplates: { "$default": "strict-ok" } }));
  await route("strict", strict.IntegrationId!);

  // AWS (non-proxy Lambda): the request template is the Lambda payload and the raw result feeds the response template.
  const aws = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "AWS", IntegrationUri: rawArn, TemplateSelectionExpression: "\\$default", RequestTemplates: { "$default": "{\"wrapped\": $input.body, \"connection\": \"$context.connectionId\"}" } }));
  await apig.send(new CreateIntegrationResponseCommand({ ApiId: api.ApiId, IntegrationId: aws.IntegrationId, IntegrationResponseKey: "$default", ResponseTemplates: { "$default": "value=$input.path('$.received.wrapped.value') conn=$input.path('$.received.connection') note=$input.path('$.note')" } }));
  await route("lambda", aws.IntegrationId!);

  // HTTP (non-proxy) with request parameter mapping into headers and the query string.
  const http = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "HTTP", IntegrationMethod: "POST", IntegrationUri: `${sink.url}/backend`, RequestParameters: { "integration.request.header.connectionId": "context.connectionId", "integration.request.querystring.item": "route.request.body.item", "integration.request.header.x-static": "'fixed'" }, TemplateSelectionExpression: "\\$default", RequestTemplates: { "$default": "{\"item\":\"$input.path('$.item')\"}" } }));
  await apig.send(new CreateIntegrationResponseCommand({ ApiId: api.ApiId, IntegrationId: http.IntegrationId, IntegrationResponseKey: "/2\\d\\d/", ResponseTemplates: { "$default": "http=$input.path('$.echoed')" } }));
  await route("http", http.IntegrationId!);
  const http64 = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "HTTP", IntegrationMethod: "GET", IntegrationUri: `${sink.url}/backend64` }));
  await apig.send(new CreateIntegrationResponseCommand({ ApiId: api.ApiId, IntegrationId: http64.IntegrationId, IntegrationResponseKey: "$default", ContentHandlingStrategy: "CONVERT_TO_TEXT" }));
  await route("http64", http64.IntegrationId!);

  await apig.send(new CreateStageCommand({ ApiId: api.ApiId, StageName: "dev", AutoDeploy: true }));
  const previous = { outbound: process.env.STACKSIM_ALLOW_OUTBOUND_HTTP, private: process.env.STACKSIM_ALLOW_PRIVATE_HTTP }; process.env.STACKSIM_ALLOW_OUTBOUND_HTTP = "true"; process.env.STACKSIM_ALLOW_PRIVATE_HTTP = "true";
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${simulator.invokePort}/${api.ApiId}/dev`); await onceOpen(socket);
    const send = async (payload: unknown) => { const next = onceMessage(socket); socket.send(JSON.stringify(payload)); return next; };
    const pong = JSON.parse((await send({ action: "ping" })).text); const connectionId = pong.pong; assert.match(connectionId, /^[a-f0-9]{12}$/, "$context.connectionId renders the real connection id"); assert.deepEqual(pong, { pong: connectionId, route: "ping", stage: "dev" });
    assert.equal((await send({ action: "status", kind: "bad" })).text, `client-error ${connectionId}`);
    assert.equal((await send({ action: "status" })).text, "ok");
    assert.equal((await send({ action: "status", format: "short" })).text, "k");
    assert.equal(JSON.parse((await send({ action: "strict", kind: "unknown" })).text).message, "Unsupported Media Type");
    assert.equal((await send({ action: "strict", kind: "known" })).text, "strict-ok");
    assert.equal((await send({ action: "lambda", value: 42 })).text, `value=42 conn=${connectionId} note=non-proxy`);
    assert.equal((await send({ action: "http", item: "widget" })).text, "http={\"item\":\"widget\"}");
    const backend = sink.requests.find(item => item.url.startsWith("/backend"))!; assert.equal(backend.url, "/backend?item=widget"); assert.equal(backend.headers.connectionid, connectionId); assert.equal(backend.headers["x-static"], "fixed");

    // Integration-response contentHandlingStrategy CONVERT_TO_TEXT base64-encodes an untemplated backend payload.
    const encoded = await send({ action: "http64" }); assert.equal(Buffer.from(encoded.text, "base64").toString("utf8"), JSON.stringify({ echoed: "", path: "/backend64" }));
    socket.close();
  } finally { if (previous.outbound === undefined) delete process.env.STACKSIM_ALLOW_OUTBOUND_HTTP; else process.env.STACKSIM_ALLOW_OUTBOUND_HTTP = previous.outbound; if (previous.private === undefined) delete process.env.STACKSIM_ALLOW_PRIVATE_HTTP; else process.env.STACKSIM_ALLOW_PRIVATE_HTTP = previous.private; }

  // A MOCK $connect whose template yields a non-2xx status rejects the upgrade.
  const deny = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "MOCK", RequestTemplates: { "$default": "{\"statusCode\":403}" } }));
  await apig.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "$connect", Target: `integrations/${deny.IntegrationId}` }));
  await assert.rejects(onceOpen(new WebSocket(`ws://127.0.0.1:${simulator.invokePort}/${api.ApiId}/dev`)), /403/);
  apig.destroy(); lambda.destroy();
});

test("DPG-33/34: WebSocket integration mutations reject HTTP-API-only TlsConfig and unsupported mapping shapes atomically", async () => {
  const { apig, lambda } = await setup();
  const api = await apig.send(new CreateApiCommand({ Name: "validation", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action" }));
  await assert.rejects(apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "HTTP_PROXY", IntegrationMethod: "POST", IntegrationUri: "https://example.com/", TlsConfig: { ServerNameToVerify: "example.com" } })), (error: any) => error.name === "BadRequestException" && /TlsConfig/.test(error.message));
  const integration = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "HTTP_PROXY", IntegrationMethod: "POST", IntegrationUri: "https://example.com/", Description: "before" }));
  await assert.rejects(apig.send(new UpdateIntegrationCommand({ ApiId: api.ApiId, IntegrationId: integration.IntegrationId, Description: "after", TlsConfig: { ServerNameToVerify: "example.com" } })), (error: any) => error.name === "BadRequestException");
  const unchanged = await apig.send(new GetIntegrationCommand({ ApiId: api.ApiId, IntegrationId: integration.IntegrationId })); assert.equal(unchanged.Description, "before"); assert.equal(unchanged.TlsConfig, undefined);
  await assert.rejects(apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "HTTP", IntegrationMethod: "POST", IntegrationUri: "https://example.com/", RequestParameters: { "integration.request.path.id": "context.connectionId" } })), (error: any) => error.name === "BadRequestException");
  await assert.rejects(apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "HTTP", IntegrationMethod: "POST", IntegrationUri: "https://example.com/", RequestParameters: { "integration.request.header.id": "method.request.header.id" } })), (error: any) => error.name === "BadRequestException");
  await assert.rejects(apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "HTTP_PROXY", IntegrationMethod: "POST", IntegrationUri: "https://example.com/", RequestTemplates: { "$default": "{}" } })), (error: any) => error.name === "BadRequestException");
  const mock = await apig.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "MOCK" }));
  await assert.rejects(apig.send(new CreateIntegrationResponseCommand({ ApiId: api.ApiId, IntegrationId: mock.IntegrationId, IntegrationResponseKey: "2xx" })), (error: any) => error.name === "BadRequestException");
  await assert.rejects(apig.send(new CreateIntegrationResponseCommand({ ApiId: api.ApiId, IntegrationId: mock.IntegrationId, IntegrationResponseKey: "$default", ContentHandlingStrategy: "CONVERT_TO_JSON" as any })), (error: any) => error.name === "BadRequestException");
  assert.ok((await apig.send(new CreateIntegrationResponseCommand({ ApiId: api.ApiId, IntegrationId: mock.IntegrationId, IntegrationResponseKey: "/5\\d\\d/" }))).IntegrationResponseId);
  apig.destroy(); lambda.destroy();
});
