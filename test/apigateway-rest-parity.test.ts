import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APIGatewayClient,
  CreateAuthorizerCommand,
  CreateDeploymentCommand,
  CreateRequestValidatorCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  GetExportCommand,
  GetMethodCommand,
  GetResourcesCommand,
  GetRestApiCommand,
  GetRestApisCommand,
  GetStageCommand,
  ImportRestApiCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
  TestInvokeAuthorizerCommand,
  UpdateRequestValidatorCommand,
  UpdateRestApiCommand,
} from "@aws-sdk/client-api-gateway";
import { AddPermissionCommand, CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { StackSim } from "../src/server.js";
import { createZip } from "../src/core/zip-create.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

const handlers = `
exports.proxy = async event => {
  const mode = event.queryStringParameters && event.queryStringParameters.mode;
  if (mode === "throw") throw new Error("intentional proxy failure");
  if (mode === "malformed") return { body: "no status code" };
  if (mode === "objectbody") return { statusCode: 200, body: { not: "a string" } };
  return { statusCode: "201", headers: { "x-single": "one", "Set-Cookie": "a=1" }, multiValueHeaders: { "Set-Cookie": ["a=1", "b=2"] }, body: JSON.stringify({ headers: event.headers, multiValueHeaders: event.multiValueHeaders, query: event.queryStringParameters, multiQuery: event.multiValueQueryStringParameters, stageVariables: event.stageVariables, requestContext: event.requestContext, path: event.path, resource: event.resource }) };
};
exports.nonproxy = async event => { if (event && event.fail) throw new Error("[NotFound] item " + event.fail); return { ok: true }; };
exports.authorizer = async event => { const token = event.authorizationToken || (event.headers && (event.headers.Authorization || event.headers.authorization)); return { principalId: "user-" + token, policyDocument: { Version: "2012-10-17", Statement: [{ Effect: token === "allow" ? "Allow" : "Deny", Action: "execute-api:Invoke", Resource: event.methodArn }] } }; };
`;

interface RawResponse { status: number; headers: IncomingHttpHeaders; body: string }
function raw(url: string, options: { method?: string; headers?: Record<string, string | string[]>; body?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method ?? "GET", headers: options.headers }, res => { const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })); });
    req.on("error", reject); if (options.body !== undefined) req.write(options.body); req.end();
  });
}

async function withSimulator(name: string, run: (context: { simulator: StackSim; apig: APIGatewayClient; lambda: LambdaClient; iam: IAMClient; root: string }) => Promise<void>, options: { authMode?: "off" | "enforce" } = {}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `stacksim-apig-${name}-`)); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: options.authMode ?? "off", accountId: account, region });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const config = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials };
    const apig = new APIGatewayClient(config); const lambda = new LambdaClient(config); const iam = new IAMClient(config); clients.push(apig, lambda, iam);
    await run({ simulator, apig, lambda, iam, root });
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
}

async function createFunctions(lambda: LambdaClient, names: string[]): Promise<void> {
  const zip = createZip([{ name: "index.js", content: handlers }]);
  for (const name of names) await lambda.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Role: `arn:aws:iam::${account}:role/test`, Handler: `index.${name.split("-")[0]}`, Code: { ZipFile: zip } }));
}
function lambdaUri(name: string): string { return `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${region}:${account}:function:${name}/invocations`; }
async function rootId(apig: APIGatewayClient, apiId: string): Promise<string> { return (await apig.send(new GetResourcesCommand({ restApiId: apiId }))).items!.find(item => item.path === "/")!.id!; }
async function child(apig: APIGatewayClient, apiId: string, parentId: string, pathPart: string): Promise<string> { return (await apig.send(new CreateResourceCommand({ restApiId: apiId, parentId, pathPart }))).id!; }
async function mockRoute(apig: APIGatewayClient, apiId: string, resourceId: string, label: string): Promise<void> {
  await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId, httpMethod: "GET", authorizationType: "NONE" }));
  await apig.send(new PutMethodResponseCommand({ restApiId: apiId, resourceId, httpMethod: "GET", statusCode: "200" }));
  await apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } }));
  await apig.send(new PutIntegrationResponseCommand({ restApiId: apiId, resourceId, httpMethod: "GET", statusCode: "200", responseTemplates: { "application/json": JSON.stringify({ route: label }) } }));
}
const invokeBase = (simulator: StackSim, apiId: string, stage: string) => `http://127.0.0.1:${simulator.invokePort}/${apiId}/${stage}`;

test("DPG-01 REST routing prefers literal, then {param}, then {greedy+}, segment by segment, and ignores a trailing slash", async () => {
  await withSimulator("routing", async ({ simulator, apig }) => {
    const api = await apig.send(new CreateRestApiCommand({ name: "routing" })); const apiId = api.id!; const root = await rootId(apig, apiId);
    const proxy = await child(apig, apiId, root, "{proxy+}"); await mockRoute(apig, apiId, proxy, "root-proxy");
    const str = await child(apig, apiId, root, "str"); await mockRoute(apig, apiId, str, "str");
    const items = await child(apig, apiId, root, "items"); const item = await child(apig, apiId, items, "{id}"); await mockRoute(apig, apiId, item, "item-param");
    const special = await child(apig, apiId, items, "special"); await mockRoute(apig, apiId, special, "item-literal");
    const itemsProxy = await child(apig, apiId, items, "{rest+}"); await mockRoute(apig, apiId, itemsProxy, "items-proxy");
    await apig.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev" })); const base = invokeBase(simulator, apiId, "dev");
    const route = async (path: string) => (await (await fetch(`${base}${path}`)).json()).route;
    assert.equal(await route("/str"), "str", "a short literal route is not swallowed by a root proxy");
    assert.equal(await route("/str/"), "str", "a trailing slash selects the same resource");
    assert.equal(await route("/items/special"), "item-literal");
    assert.equal(await route("/items/42"), "item-param");
    assert.equal(await route("/items/42/history"), "items-proxy");
    assert.equal(await route("/anything/else/deep"), "root-proxy");
    const missing = await fetch(`http://127.0.0.1:${simulator.invokePort}/${apiId}/nostage/str`);
    assert.equal(missing.status, 403); assert.equal(missing.headers.get("x-amzn-errortype"), "MissingAuthenticationTokenException");
  });
});

test("DPG-08/09/24/30 Lambda proxy events keep client header casing, multi-values, the shared request context, and AWS error shapes", async () => {
  await withSimulator("proxy", async ({ simulator, apig, lambda }) => {
    await createFunctions(lambda, ["proxy"]);
    const api = await apig.send(new CreateRestApiCommand({ name: "proxy-shapes" })); const apiId = api.id!; const root = await rootId(apig, apiId); const echo = await child(apig, apiId, root, "echo");
    await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId: echo, httpMethod: "GET", authorizationType: "NONE" }));
    await assert.rejects(apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: echo, httpMethod: "GET", type: "AWS_PROXY", uri: lambdaUri("proxy") })), (error: any) => error.name === "BadRequestException" && /HttpMethod must be non-empty/.test(error.message));
    await assert.rejects(apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: echo, httpMethod: "GET", type: "AWS_PROXY", integrationHttpMethod: "GET", uri: lambdaUri("proxy") })), (error: any) => error.name === "BadRequestException" && /POST/.test(error.message), "DPG-29: Lambda integrations require POST");
    await apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: echo, httpMethod: "GET", type: "AWS_PROXY", integrationHttpMethod: "POST", uri: lambdaUri("proxy") }));
    await apig.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev" })); const url = `${invokeBase(simulator, apiId, "dev")}/echo`;
    const response = await raw(`${url}?q=1&q=2`, { headers: { "X-Custom-Header": "Value", "X-Multi": ["first", "second"] } });
    assert.equal(response.status, 201, "DPG-30: a numeric-string statusCode is accepted");
    assert.deepEqual(response.headers["set-cookie"], ["a=1", "b=2"], "DPG-09: multiValueHeaders become separate response headers");
    assert.equal(response.headers["x-single"], "one");
    const event = JSON.parse(response.body);
    assert.equal(event.headers["X-Custom-Header"], "Value", "event headers preserve client casing");
    assert.equal(event.headers["X-Multi"], "second", "headers carries the last value of a repeated header");
    assert.deepEqual(event.multiValueHeaders["X-Multi"], ["first", "second"]);
    assert.equal(event.query.q, "2"); assert.deepEqual(event.multiQuery.q, ["1", "2"]);
    assert.equal(event.stageVariables, null, "stageVariables is null when the stage defines none");
    const context = event.requestContext;
    assert.equal(context.accountId, account); assert.equal(context.protocol, "HTTP/1.1"); assert.equal(context.extendedRequestId, response.headers["x-amz-apigw-id"]); assert.equal(typeof context.requestTimeEpoch, "number"); assert.match(context.requestTime, /^\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2} \+0000$/); assert.equal(context.resourcePath, "/echo"); assert.equal(context.path, "/dev/echo"); assert.equal(context.domainName, `127.0.0.1:${simulator.invokePort}`); assert.equal(context.domainPrefix, "127");
    for (const mode of ["throw", "malformed", "objectbody"]) {
      const failed = await fetch(`${url}?mode=${mode}`);
      assert.equal(failed.status, 502, `DPG-08: ${mode} returns 502`); assert.deepEqual(await failed.json(), { message: "Internal server error" }); assert.equal(failed.headers.get("x-amzn-errortype"), "InternalServerErrorException");
    }
  });
});

test("DPG-08 a missing Lambda invoke permission is a 500 Internal server error with the detail kept out of the response", async () => {
  await withSimulator("permission", async ({ simulator, apig, lambda }) => {
    await createFunctions(lambda, ["proxy"]);
    const api = await apig.send(new CreateRestApiCommand({ name: "permission" })); const apiId = api.id!; const root = await rootId(apig, apiId); const echo = await child(apig, apiId, root, "echo");
    await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId: echo, httpMethod: "GET", authorizationType: "NONE" }));
    await apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: echo, httpMethod: "GET", type: "AWS_PROXY", integrationHttpMethod: "POST", uri: lambdaUri("proxy") }));
    await apig.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev" })); const url = `${invokeBase(simulator, apiId, "dev")}/echo`;
    const denied = await fetch(url); assert.equal(denied.status, 500); assert.deepEqual(await denied.json(), { message: "Internal server error" });
    await lambda.send(new AddPermissionCommand({ FunctionName: "proxy", StatementId: "apigateway", Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com", SourceArn: `arn:aws:execute-api:${region}:${account}:${apiId}/*/*/*` }));
    assert.equal((await fetch(url)).status, 201);
  }, { authMode: "enforce" });
});

test("DPG-26/27 non-proxy Lambda selection fully matches errorMessage, and a template failure is a generic 500", async () => {
  await withSimulator("selection", async ({ simulator, apig, lambda }) => {
    await createFunctions(lambda, ["nonproxy"]);
    const api = await apig.send(new CreateRestApiCommand({ name: "selection" })); const apiId = api.id!; const root = await rootId(apig, apiId); const items = await child(apig, apiId, root, "items");
    await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId: items, httpMethod: "POST", authorizationType: "NONE" }));
    for (const statusCode of ["200", "404", "400"]) await apig.send(new PutMethodResponseCommand({ restApiId: apiId, resourceId: items, httpMethod: "POST", statusCode }));
    await apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: items, httpMethod: "POST", type: "AWS", integrationHttpMethod: "POST", uri: lambdaUri("nonproxy") }));
    await apig.send(new PutIntegrationResponseCommand({ restApiId: apiId, resourceId: items, httpMethod: "POST", statusCode: "200" }));
    await apig.send(new PutIntegrationResponseCommand({ restApiId: apiId, resourceId: items, httpMethod: "POST", statusCode: "400", selectionPattern: "NotFound" }));
    await apig.send(new PutIntegrationResponseCommand({ restApiId: apiId, resourceId: items, httpMethod: "POST", statusCode: "404", selectionPattern: "\\[NotFound\\].*", responseTemplates: { "application/json": "{\"error\":\"not found\"}" } }));
    const broken = await child(apig, apiId, root, "broken");
    await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId: broken, httpMethod: "POST", authorizationType: "NONE" })); await apig.send(new PutMethodResponseCommand({ restApiId: apiId, resourceId: broken, httpMethod: "POST", statusCode: "200" }));
    await apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: broken, httpMethod: "POST", type: "MOCK", requestTemplates: { "application/json": "#set($parsed = $util.parseJson($input.body))\n{\"statusCode\":200}" } }));
    await apig.send(new PutIntegrationResponseCommand({ restApiId: apiId, resourceId: broken, httpMethod: "POST", statusCode: "200" }));
    await apig.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev" })); const base = invokeBase(simulator, apiId, "dev");
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const ok = await post("/items", {}); assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true });
    const notFound = await post("/items", { fail: "7" }); assert.equal(notFound.status, 404, "the anchored pattern matches errorMessage, not the stack trace"); assert.deepEqual(await notFound.json(), { error: "not found" });
    const invalid = await post("/broken", "{not json"); assert.equal(invalid.status, 500); assert.deepEqual(await invalid.json(), { message: "Internal server error" });
  });
});

test("DPG-06/07/28 HTTP integrations substitute path parameters and stage variables, forward only mapped parameters, and honor ANY", async () => {
  const seen: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders }> = [];
  const backend = createServer((req, res) => { seen.push({ method: req.method, url: req.url, headers: req.headers }); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true })); });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve)); const backendBase = `http://127.0.0.1:${(backend.address() as any).port}`;
  const previous = { outbound: process.env.STACKSIM_ALLOW_OUTBOUND_HTTP, private: process.env.STACKSIM_ALLOW_PRIVATE_HTTP }; process.env.STACKSIM_ALLOW_OUTBOUND_HTTP = "true"; process.env.STACKSIM_ALLOW_PRIVATE_HTTP = "true";
  try {
    await withSimulator("http", async ({ simulator, apig }) => {
      const api = await apig.send(new CreateRestApiCommand({ name: "http" })); const apiId = api.id!; const root = await rootId(apig, apiId);
      const things = await child(apig, apiId, root, "things"); const thing = await child(apig, apiId, things, "{id}");
      await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId: thing, httpMethod: "GET", authorizationType: "NONE", requestParameters: { "method.request.path.id": true, "method.request.querystring.q": false } }));
      await apig.send(new PutMethodResponseCommand({ restApiId: apiId, resourceId: thing, httpMethod: "GET", statusCode: "200" }));
      await assert.rejects(apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: thing, httpMethod: "GET", type: "HTTP", integrationHttpMethod: "GET", uri: `${backendBase}/x`, tlsConfig: { insecureSkipVerification: true } })), (error: any) => error.name === "BadRequestException" && /DUG-21/.test(error.message), "APIGGAP-04: insecure TLS is rejected at mutation");
      await apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: thing, httpMethod: "GET", type: "HTTP", integrationHttpMethod: "GET", uri: `${backendBase}/\${stageVariables.version}/things/{id}?static=1`, tlsConfig: { insecureSkipVerification: false }, requestParameters: { "integration.request.path.id": "method.request.path.id", "integration.request.querystring.mapped": "method.request.querystring.q", "integration.request.header.x-mapped": "'yes'" } }));
      await apig.send(new PutIntegrationResponseCommand({ restApiId: apiId, resourceId: thing, httpMethod: "GET", statusCode: "200" }));
      const proxy = await child(apig, apiId, root, "p"); const greedy = await child(apig, apiId, proxy, "{proxy+}");
      await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId: greedy, httpMethod: "ANY", authorizationType: "NONE", requestParameters: { "method.request.path.proxy": true } }));
      await apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: greedy, httpMethod: "ANY", type: "HTTP_PROXY", integrationHttpMethod: "ANY", uri: `${backendBase}/proxy/{proxy}`, requestParameters: { "integration.request.path.proxy": "method.request.path.proxy" } }));
      await apig.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev", variables: { version: "v2" } }));
      assert.deepEqual((await apig.send(new GetStageCommand({ restApiId: apiId, stageName: "dev" }))).variables, { version: "v2" }, "DPG-07: CreateDeployment variables are applied to the new stage");
      const base = invokeBase(simulator, apiId, "dev");
      const mapped = await fetch(`${base}/things/a%20b?q=1&unmapped=2`, { headers: { "x-unmapped": "no" } }); assert.equal(mapped.status, 200);
      const call = seen.at(-1)!; assert.equal(call.url, "/v2/things/a%20b?static=1&mapped=1"); assert.equal(call.headers["x-mapped"], "yes"); assert.equal(call.headers["x-unmapped"], undefined, "non-proxy HTTP forwards only mapped headers");
      const removed = await fetch(`${base}/p/a/b?keep=1`, { method: "DELETE", headers: { "x-client": "kept" } }); assert.equal(removed.status, 200);
      const proxied = seen.at(-1)!; assert.equal(proxied.method, "DELETE", "DPG-28: ANY forwards the client method"); assert.equal(proxied.url, "/proxy/a/b?keep=1"); assert.equal(proxied.headers["x-client"], "kept");
      await apig.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev", variables: { version: "v3" } }));
      assert.deepEqual((await apig.send(new GetStageCommand({ restApiId: apiId, stageName: "dev" }))).variables, { version: "v3" }, "CreateDeployment variables replace the stage variables of an existing stage");
    });
  } finally { if (previous.outbound === undefined) delete process.env.STACKSIM_ALLOW_OUTBOUND_HTTP; else process.env.STACKSIM_ALLOW_OUTBOUND_HTTP = previous.outbound; if (previous.private === undefined) delete process.env.STACKSIM_ALLOW_PRIVATE_HTTP; else process.env.STACKSIM_ALLOW_PRIVATE_HTTP = previous.private; await new Promise<void>(resolve => backend.close(() => resolve())); }
});

test("DPG-18/31 authorization runs before request validation, and TestInvokeAuthorizer reports clientStatus", async () => {
  await withSimulator("auth-order", async ({ simulator, apig, lambda }) => {
    await createFunctions(lambda, ["authorizer"]);
    const api = await apig.send(new CreateRestApiCommand({ name: "auth-order" })); const apiId = api.id!; const root = await rootId(apig, apiId); const secured = await child(apig, apiId, root, "secured");
    const authorizer = await apig.send(new CreateAuthorizerCommand({ restApiId: apiId, name: "token", type: "TOKEN", authorizerUri: lambdaUri("authorizer"), identitySource: "method.request.header.Authorization", authorizerResultTtlInSeconds: 0 }));
    const validator = await apig.send(new CreateRequestValidatorCommand({ restApiId: apiId, name: "params", validateRequestParameters: true }));
    await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId: secured, httpMethod: "GET", authorizationType: "CUSTOM", authorizerId: authorizer.id, requestValidatorId: validator.id, requestParameters: { "method.request.querystring.required": true } }));
    await apig.send(new PutMethodResponseCommand({ restApiId: apiId, resourceId: secured, httpMethod: "GET", statusCode: "200" }));
    await apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: secured, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } }));
    await apig.send(new PutIntegrationResponseCommand({ restApiId: apiId, resourceId: secured, httpMethod: "GET", statusCode: "200" }));
    await apig.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev" })); const url = `${invokeBase(simulator, apiId, "dev")}/secured`;
    assert.equal((await fetch(url, { headers: { authorization: "deny" } })).status, 403, "a deny decision wins over a missing required parameter");
    assert.equal((await fetch(url, { headers: { authorization: "allow" } })).status, 400, "an allowed caller then reaches request validation");
    assert.equal((await fetch(`${url}?required=1`, { headers: { authorization: "allow" } })).status, 200);
    const deny = await apig.send(new TestInvokeAuthorizerCommand({ restApiId: apiId, authorizerId: authorizer.id!, headers: { Authorization: "deny" } }));
    assert.equal(deny.clientStatus, 403); assert.equal(deny.principalId, "user-deny"); assert.match(deny.policy ?? "", /Deny/);
    const allow = await apig.send(new TestInvokeAuthorizerCommand({ restApiId: apiId, authorizerId: authorizer.id!, headers: { Authorization: "allow" } }));
    assert.equal(allow.clientStatus, 0); assert.equal(typeof allow.latency, "number");
    const missing = await apig.send(new TestInvokeAuthorizerCommand({ restApiId: apiId, authorizerId: authorizer.id!, headers: {} }));
    assert.equal(missing.clientStatus, 401);
    const open = await child(apig, apiId, root, "open");
    await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId: open, httpMethod: "GET", authorizationType: "NONE", requestValidatorId: validator.id, requestParameters: { "method.request.querystring.required": true } }));
    await apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: open, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } }));
    await apig.send(new UpdateRestApiCommand({ restApiId: apiId, patchOperations: [{ op: "replace", path: "/policy", value: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: "*", Action: "execute-api:Invoke", Resource: "execute-api:/*/GET/open" }] }) }] }));
    await apig.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev" }));
    assert.equal((await fetch(`${invokeBase(simulator, apiId, "dev")}/open`)).status, 403, "APIGGAP-01: a denying resource policy wins over invalid parameters");
  });
});

test("DPG-35/37 REST API endpoint types, resource-policy principals, and unsupported AWS targets are validated at mutation", async () => {
  await withSimulator("control", async ({ apig, iam }) => {
    assert.deepEqual((await apig.send(new CreateRestApiCommand({ name: "default-edge" }))).endpointConfiguration?.types, ["EDGE"], "EDGE is the AWS default");
    const edge = await apig.send(new CreateRestApiCommand({ name: "edge", endpointConfiguration: { types: ["EDGE"] } })); assert.deepEqual(edge.endpointConfiguration?.types, ["EDGE"]); assert.ok(edge.warnings?.some(warning => /regional/i.test(warning)));
    const regional = await apig.send(new CreateRestApiCommand({ name: "regional", endpointConfiguration: { types: ["REGIONAL"] } })); assert.deepEqual((await apig.send(new GetRestApiCommand({ restApiId: regional.id! }))).endpointConfiguration?.types, ["REGIONAL"]);
    await assert.rejects(apig.send(new CreateRestApiCommand({ name: "private", endpointConfiguration: { types: ["PRIVATE"] } })), (error: any) => error.name === "BadRequestException");
    const updated = await apig.send(new UpdateRestApiCommand({ restApiId: edge.id!, patchOperations: [{ op: "replace", path: "/endpointConfiguration/types/EDGE", value: "REGIONAL" }] })); assert.deepEqual(updated.endpointConfiguration?.types, ["REGIONAL"]);

    const policy = (principal: unknown) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: principal, Action: "execute-api:Invoke", Resource: "execute-api:/*" }] });
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "sts:AssumeRole" }] });
    const role = await iam.send(new CreateRoleCommand({ RoleName: "known-caller", AssumeRolePolicyDocument: trust }));
    for (const principal of ["*", { AWS: account }, { AWS: `arn:aws:iam::${account}:root` }, { AWS: role.Role!.Arn! }, { AWS: `arn:aws:sts::${account}:assumed-role/known-caller/session` }, { Service: "events.amazonaws.com" }]) await apig.send(new CreateRestApiCommand({ name: "policy-ok", policy: policy(principal) }));
    for (const principal of [{ AWS: `arn:aws:iam::${account}:role/missing` }, { AWS: "123456789012" }, { Federated: "cognito-identity.amazonaws.com" }, { Service: "not a service" }]) await assert.rejects(apig.send(new CreateRestApiCommand({ name: "policy-bad", policy: policy(principal) })), (error: any) => error.name === "BadRequestException" && /Principals/.test(error.message), JSON.stringify(principal));
    const before = (await apig.send(new GetRestApisCommand({}))).items?.length;
    const document = { swagger: "2.0", info: { title: "bad-policy", version: "1" }, paths: {}, "x-amazon-apigateway-policy": JSON.parse(policy({ AWS: `arn:aws:iam::${account}:user/nobody` })) };
    await assert.rejects(apig.send(new ImportRestApiCommand({ body: Buffer.from(JSON.stringify(document)) })), (error: any) => error.name === "BadRequestException");
    assert.equal((await apig.send(new GetRestApisCommand({}))).items?.length, before, "a rejected import creates nothing");
    await assert.rejects(apig.send(new UpdateRestApiCommand({ restApiId: regional.id!, patchOperations: [{ op: "replace", path: "/policy", value: policy({ AWS: `arn:aws:iam::${account}:role/missing` }) }] })), (error: any) => error.name === "BadRequestException");
    assert.equal((await apig.send(new GetRestApiCommand({ restApiId: regional.id! }))).policy, undefined, "a rejected policy update leaves the API unchanged");

    const target = await apig.send(new CreateRestApiCommand({ name: "targets" })); const root = await rootId(apig, target.id!);
    await apig.send(new PutMethodCommand({ restApiId: target.id!, resourceId: root, httpMethod: "POST", authorizationType: "NONE" }));
    await assert.rejects(apig.send(new PutIntegrationCommand({ restApiId: target.id!, resourceId: root, httpMethod: "POST", type: "AWS", integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:kinesis:action/PutRecord`, credentials: role.Role!.Arn! })), (error: any) => error.name === "BadRequestException" && /does not support the AWS integration kinesis/.test(error.message));
    await assert.rejects(apig.send(new PutIntegrationCommand({ restApiId: target.id!, resourceId: root, httpMethod: "POST", type: "AWS", integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:states:action/StartSyncExecution`, credentials: role.Role!.Arn! })), (error: any) => error.name === "BadRequestException" && /EXPRESS/.test(error.message));
    await assert.rejects(apig.send(new PutIntegrationCommand({ restApiId: target.id!, resourceId: root, httpMethod: "POST", type: "AWS", integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:s3:path/bucket/key`, credentials: role.Role!.Arn! })), (error: any) => error.name === "BadRequestException" && /S3 path integrations/.test(error.message));
    await apig.send(new PutIntegrationCommand({ restApiId: target.id!, resourceId: root, httpMethod: "POST", type: "AWS", integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:sns:action/Publish`, credentials: role.Role!.Arn! }));
  });
});

test("DPG-19 OpenAPI exports AWS_IAM as an awsSigv4 security scheme and imports it back", async () => {
  await withSimulator("openapi-iam", async ({ apig }) => {
    const api = await apig.send(new CreateRestApiCommand({ name: "iam-export" })); const apiId = api.id!; const root = await rootId(apig, apiId); const signed = await child(apig, apiId, root, "signed");
    await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId: signed, httpMethod: "GET", authorizationType: "AWS_IAM", apiKeyRequired: true }));
    await apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: signed, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } }));
    await apig.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev" }));
    for (const exportType of ["oas30", "swagger"]) {
      const exported = JSON.parse(Buffer.from((await apig.send(new GetExportCommand({ restApiId: apiId, stageName: "dev", exportType, accepts: "application/json", parameters: { extensions: "apigateway" } }))).body!).toString("utf8"));
      const schemes = exportType === "oas30" ? exported.components.securitySchemes : exported.securityDefinitions;
      assert.deepEqual(schemes.sigv4, { type: "apiKey", name: "Authorization", in: "header", "x-amazon-apigateway-authtype": "awsSigv4" });
      assert.deepEqual(exported.paths["/signed"].get.security, [{ sigv4: [], api_key: [] }]);
      const imported = await apig.send(new ImportRestApiCommand({ body: Buffer.from(JSON.stringify(exported)) }));
      const importedSigned = (await apig.send(new GetResourcesCommand({ restApiId: imported.id! }))).items!.find(item => item.path === "/signed")!;
      const method = await apig.send(new GetMethodCommand({ restApiId: imported.id!, resourceId: importedSigned.id!, httpMethod: "GET" }));
      assert.equal(method.authorizationType, "AWS_IAM", `${exportType} round trip keeps AWS_IAM`); assert.equal(method.apiKeyRequired, true);
    }
    const lookalike = { openapi: "3.0.1", info: { title: "lookalike", version: "1" }, components: { securitySchemes: { awsSigv4: { type: "apiKey", name: "Authorization", in: "header" } } }, security: [{ awsSigv4: [] }], paths: { "/open": { get: { security: [], responses: {} }, post: { responses: {} } } } };
    const imported = await apig.send(new ImportRestApiCommand({ body: Buffer.from(JSON.stringify(lookalike)) }));
    const open = (await apig.send(new GetResourcesCommand({ restApiId: imported.id! }))).items!.find(item => item.path === "/open")!;
    assert.equal((await apig.send(new GetMethodCommand({ restApiId: imported.id!, resourceId: open.id!, httpMethod: "POST" }))).authorizationType, "NONE", "a scheme merely named awsSigv4 is not IAM");
    const iamDocument = { ...lookalike, components: { securitySchemes: { awsSigv4: { ...lookalike.components.securitySchemes.awsSigv4, "x-amazon-apigateway-authtype": "awsSigv4" } } } };
    const iamImported = await apig.send(new ImportRestApiCommand({ body: Buffer.from(JSON.stringify(iamDocument)) }));
    const iamOpen = (await apig.send(new GetResourcesCommand({ restApiId: iamImported.id! }))).items!.find(item => item.path === "/open")!;
    assert.equal((await apig.send(new GetMethodCommand({ restApiId: iamImported.id!, resourceId: iamOpen.id!, httpMethod: "POST" }))).authorizationType, "AWS_IAM", "document-level IAM security applies");
    const override = await apig.send(new GetMethodCommand({ restApiId: iamImported.id!, resourceId: iamOpen.id!, httpMethod: "GET" }));
    assert.equal(override.authorizationType, "NONE", "an operation-level empty security override wins"); assert.equal(override.apiKeyRequired, false);
  });
});

test("APIGGAP-03 a legacy deployment without a snapshot is frozen once, including models and validators", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-legacy-snapshot-"));
  const options = { port: 0, invokePort: 0, dataDir: root, authMode: "off" as const, accountId: account, region };
  let apiId = ""; let validatorId = ""; let resourceId = "";
  let simulator = new StackSim(options); let apig: APIGatewayClient | undefined;
  try {
    await simulator.start(); apig = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    const api = await apig.send(new CreateRestApiCommand({ name: "legacy" })); apiId = api.id!; const rootResource = await rootId(apig, apiId); resourceId = await child(apig, apiId, rootResource, "orders");
    const validator = await apig.send(new CreateRequestValidatorCommand({ restApiId: apiId, name: "body", validateRequestBody: true })); validatorId = validator.id!;
    await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId, httpMethod: "POST", authorizationType: "NONE", requestValidatorId: validatorId, requestModels: { "application/json": "Error" } }));
    await apig.send(new PutMethodResponseCommand({ restApiId: apiId, resourceId, httpMethod: "POST", statusCode: "200" }));
    await apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId, httpMethod: "POST", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } }));
    await apig.send(new PutIntegrationResponseCommand({ restApiId: apiId, resourceId, httpMethod: "POST", statusCode: "200" }));
    await apig.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev" }));
    apig.destroy(); apig = undefined; await simulator.stop();
    const statePath = join(root, "state.json"); const state = JSON.parse(await readFile(statePath, "utf8"));
    const stored = state.accounts[account].regions[region].apis[apiId]; for (const deployment of Object.values<any>(stored.deployments)) { delete deployment.snapshot; delete deployment.contentHash; }
    await writeFile(statePath, JSON.stringify(state));
    simulator = new StackSim(options); await simulator.start(); apig = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    await apig.send(new UpdateRequestValidatorCommand({ restApiId: apiId, requestValidatorId: validatorId, patchOperations: [{ op: "replace", path: "/validateRequestBody", value: "false" }] }));
    const invalid = await fetch(`http://127.0.0.1:${simulator.invokePort}/${apiId}/dev/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: 7 }) });
    assert.equal(invalid.status, 400, "the frozen validator still validates the body after the mutable validator changed");
    apig.destroy(); apig = undefined; await simulator.stop();
    const reloaded = JSON.parse(await readFile(statePath, "utf8")).accounts[account].regions[region].apis[apiId];
    const snapshot = (Object.values<any>(reloaded.deployments)[0]).snapshot;
    assert.equal(snapshot.requestValidators[validatorId].validateRequestBody, true); assert.ok(snapshot.models.Error); assert.equal(snapshot.schemaProfileVersion, 1);
  } finally { apig?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("DPG-04 $context.responseOverride and requestOverride apply after the integration mappings", async t => {
  const seen: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];
  const backend = createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); res.setHeader("content-type", "application/json"); res.end("{}"); });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve)); const backendBase = `http://127.0.0.1:${(backend.address() as any).port}`;
  const previous = { outbound: process.env.STACKSIM_ALLOW_OUTBOUND_HTTP, private: process.env.STACKSIM_ALLOW_PRIVATE_HTTP }; process.env.STACKSIM_ALLOW_OUTBOUND_HTTP = "true"; process.env.STACKSIM_ALLOW_PRIVATE_HTTP = "true";
  try {
    await withSimulator("overrides", async ({ simulator, apig }) => {
      const api = await apig.send(new CreateRestApiCommand({ name: "overrides" })); const apiId = api.id!; const root = await rootId(apig, apiId); const teapot = await child(apig, apiId, root, "teapot");
      await apig.send(new PutMethodCommand({ restApiId: apiId, resourceId: teapot, httpMethod: "POST", authorizationType: "NONE" }));
      await apig.send(new PutMethodResponseCommand({ restApiId: apiId, resourceId: teapot, httpMethod: "POST", statusCode: "200", responseParameters: { "method.response.header.x-mapped": true } }));
      try {
        await apig.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: teapot, httpMethod: "POST", type: "HTTP", integrationHttpMethod: "POST", uri: `${backendBase}/brew`, requestParameters: { "integration.request.header.x-added": "'mapped'" }, requestTemplates: { "application/json": "#set($context.requestOverride.header.x-added = \"overridden\")\n#set($context.requestOverride.querystring.cup = \"large\")\n{}" } }));
        await apig.send(new PutIntegrationResponseCommand({ restApiId: apiId, resourceId: teapot, httpMethod: "POST", statusCode: "200", responseParameters: { "method.response.header.x-mapped": "'mapping'" }, responseTemplates: { "application/json": "#set($context.responseOverride.status = 418)\n#set($context.responseOverride.header.x-mapped = \"override\")\n{\"teapot\":true}" } }));
      } catch (error: any) {
        if (error?.name === "BadRequestException") { t.skip(`the VTL engine does not accept override targets yet: ${error.message}`); return; }
        throw error;
      }
      await apig.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev" }));
      const response = await fetch(`${invokeBase(simulator, apiId, "dev")}/teapot`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, 418); assert.equal(response.headers.get("x-mapped"), "override"); assert.deepEqual(await response.json(), { teapot: true });
      assert.equal(seen.at(-1)!.headers["x-added"], "overridden"); assert.equal(seen.at(-1)!.url, "/brew?cup=large");
    });
  } finally { if (previous.outbound === undefined) delete process.env.STACKSIM_ALLOW_OUTBOUND_HTTP; else process.env.STACKSIM_ALLOW_OUTBOUND_HTTP = previous.outbound; if (previous.private === undefined) delete process.env.STACKSIM_ALLOW_PRIVATE_HTTP; else process.env.STACKSIM_ALLOW_PRIVATE_HTTP = previous.private; await new Promise<void>(resolve => backend.close(() => resolve())); }
});
