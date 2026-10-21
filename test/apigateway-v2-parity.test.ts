import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign as signValue } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as apigatewayv2 from "@aws-sdk/client-apigatewayv2";
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateAuthorizerCommand,
  CreateIntegrationCommand,
  CreateRouteCommand,
  CreateStageCommand,
  CreateVpcLinkCommand,
  DeleteVpcLinkCommand,
  ExportApiCommand,
  GetApiCommand,
  GetAuthorizersCommand,
  GetIntegrationsCommand,
  GetRoutesCommand,
  GetStagesCommand,
  GetVpcLinkCommand,
  GetVpcLinksCommand,
  ImportApiCommand,
  ReimportApiCommand,
  UpdateApiCommand,
  UpdateIntegrationCommand,
  UpdateVpcLinkCommand,
} from "@aws-sdk/client-apigatewayv2";
import { CloudWatchLogsClient, CreateLogGroupCommand, DescribeLogStreamsCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { EventBridgeClient, PutRuleCommand, PutTargetsCommand } from "@aws-sdk/client-eventbridge";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AddPermissionCommand, CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateStateMachineCommand, DescribeExecutionCommand, SFNClient } from "@aws-sdk/client-sfn";
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const executionRole = `arn:aws:iam::${account}:role/test`;
const CLF = /^\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2} \+0000$/;

function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function zip(name: string, content: string): Buffer {
  const fileName = Buffer.from(name); const body = Buffer.from(content); const checksum = crc32(body); const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(fileName.length, 26); const centralOffset = local.length + fileName.length + body.length; const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + fileName.length, 12); end.writeUInt32LE(centralOffset, 16); return Buffer.concat([local, fileName, body, central, fileName, end]);
}

const lambdaSource = `
exports.echo = async event => ({ statusCode: 201, headers: { "content-type": "application/json", "x-origin": "lambda" }, body: JSON.stringify(event) });
exports.text = async () => "Hello from Lambda!";
exports.fail = async () => { throw new Error("boom"); };
exports.simple = async event => ({ isAuthorized: event.headers?.["x-token"] === "allow", context: { source: (event.identitySource || []).join("|"), tenant: "t1" } });
exports.policy = async event => ({ principalId: "user-7", policyDocument: { Version: "2012-10-17", Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: event.methodArn }] }, context: { tenant: "t1" } });
exports.unauthorized = async () => { throw new Error("Unauthorized"); };
`;

type Clients = { apig: ApiGatewayV2Client; lambda: LambdaClient; logs: CloudWatchLogsClient; iam: IAMClient; sqs: SQSClient; sfn: SFNClient; events: EventBridgeClient };
function clients(simulator: StackSim): Clients { const value = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }; return { apig: new ApiGatewayV2Client(value), lambda: new LambdaClient(value), logs: new CloudWatchLogsClient(value), iam: new IAMClient(value), sqs: new SQSClient(value), sfn: new SFNClient(value), events: new EventBridgeClient(value) }; }
async function withSimulator(prefix: string, options: Record<string, unknown>, body: (simulator: StackSim, active: Clients) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix)); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off", ...options } as any); let active: Clients | undefined;
  try { await simulator.start(); active = clients(simulator); await body(simulator, active); }
  finally { if (active) for (const client of Object.values(active)) client.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
}
async function lambdaFunction(lambda: LambdaClient, name: string, handler: string): Promise<string> { return (await lambda.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Role: executionRole, Handler: handler, Code: { ZipFile: zip("index.js", lambdaSource) } }))).FunctionArn!; }
async function permit(lambda: LambdaClient, name: string, apiId: string, suffix = "*/*/*", statement = "gateway"): Promise<void> { await lambda.send(new AddPermissionCommand({ FunctionName: name, StatementId: statement, Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com", SourceArn: `arn:aws:execute-api:${region}:${account}:${apiId}/${suffix}` })); }
function jwt(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], kid: string, claims: Record<string, unknown>): string { const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url"); const payload = Buffer.from(JSON.stringify(claims)).toString("base64url"); return `${header}.${payload}.${signValue("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`; }
function signedHeaders(urlValue: string, date: Date): Record<string, string> {
  const url = new URL(urlValue); const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, ""); const shortDate = amzDate.slice(0, 8); const payloadHash = createHash("sha256").update("").digest("hex"); const values: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate }; const names = Object.keys(values).sort(); const canonicalHeaders = names.map(name => `${name}:${values[name]}\n`).join(""); const canonicalRequest = `GET\n${url.pathname}\n\n${canonicalHeaders}\n${names.join(";")}\n${payloadHash}`; const scope = `${shortDate}/${region}/execute-api/aws4_request`; const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`; const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest(); const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, shortDate), region), "execute-api"), "aws4_request"); return { "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${createHmac("sha256", signingKey).update(stringToSign).digest("hex")}` };
}
async function gatewayRole(iam: IAMClient, statements: Array<{ Action: string | string[]; Resource: string | string[] }>): Promise<string> {
  const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "sts:AssumeRole" }] });
  const role = await iam.send(new CreateRoleCommand({ RoleName: `apig-v2-${Math.random().toString(36).slice(2)}`, AssumeRolePolicyDocument: trust }));
  await iam.send(new PutRolePolicyCommand({ RoleName: role.Role!.RoleName!, PolicyName: "service", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: statements.map(statement => ({ Effect: "Allow", ...statement })) }) }));
  return role.Role!.Arn!;
}
async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> { const deadline = Date.now() + timeoutMs; for (;;) { const value = await read(); if (value !== undefined) return value; if (Date.now() > deadline) throw new Error("condition not reached"); await new Promise(resolve => setTimeout(resolve, 100)); } }
const rejects = (pattern: RegExp, name = "BadRequestException") => (error: any) => { assert.equal(error.name, name, error.message); assert.match(error.message, pattern); return true; };

test("DPG-21/22/§6 HTTP API Lambda proxy: payload 1.0 REST-style requestContext, JWT claims, applied parameter mappings, stage-prefixed rawPath, 500 errors, and 2.0 response inference", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }); const kid = "parity-key"; const publicJwk = keys.publicKey.export({ format: "jwk" }); publicJwk.kid = kid; const issuer = "https://issuer.parity";
  await withSimulator("stacksim-apig-v2-lambda-parity-", { apiGatewayJwtJwks: { [issuer]: { keys: [publicJwk] } } }, async (simulator, { apig, lambda }) => {
    const echo = await lambdaFunction(lambda, "parity-echo", "index.echo"); const text = await lambdaFunction(lambda, "parity-text", "index.text"); const fail = await lambdaFunction(lambda, "parity-fail", "index.fail");
    const api = await apig.send(new CreateApiCommand({ Name: "lambda-parity", ProtocolType: "HTTP" })); const apiId = api.ApiId!;
    for (const name of ["parity-echo", "parity-text", "parity-fail"]) await permit(lambda, name, apiId);
    const authorizer = await apig.send(new CreateAuthorizerCommand({ ApiId: apiId, Name: "jwt", AuthorizerType: "JWT", IdentitySource: ["$request.header.Authorization"], JwtConfiguration: { Issuer: issuer, Audience: ["parity"] } }));
    const v1 = await apig.send(new CreateIntegrationCommand({ ApiId: apiId, IntegrationType: "AWS_PROXY", IntegrationUri: echo, PayloadFormatVersion: "1.0" }));
    await apig.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: "GET /v1/{id}", Target: `integrations/${v1.IntegrationId}`, AuthorizationType: "JWT", AuthorizerId: authorizer.AuthorizerId, AuthorizationScopes: ["orders:read"] }));
    await assert.rejects(apig.send(new CreateIntegrationCommand({ ApiId: apiId, IntegrationType: "AWS_PROXY", IntegrationUri: echo, PayloadFormatVersion: "2.0", RequestParameters: { "overwrite:header.authorization": "x" } })), rejects(/reserved/));
    await assert.rejects(apig.send(new CreateIntegrationCommand({ ApiId: apiId, IntegrationType: "AWS_PROXY", IntegrationUri: echo, PayloadFormatVersion: "2.0", ResponseParameters: { "201": { "overwrite:header.x-amzn-trace": "x" } } })), rejects(/reserved/));
    const mapped = await apig.send(new CreateIntegrationCommand({ ApiId: apiId, IntegrationType: "AWS_PROXY", IntegrationUri: echo, PayloadFormatVersion: "2.0", RequestParameters: { "overwrite:header.x-request": "$context.requestId", "append:querystring.source": "mapped", "remove:header.x-drop": "''", "overwrite:path": "/rewritten/$request.path.id" }, ResponseParameters: { "201": { "overwrite:statuscode": "202", "append:header.x-route": "$context.routeKey", "overwrite:header.x-copy": "$response.header.x-origin" } } }));
    await apig.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: "GET /mapped/{id}", Target: `integrations/${mapped.IntegrationId}` }));
    const textIntegration = await apig.send(new CreateIntegrationCommand({ ApiId: apiId, IntegrationType: "AWS_PROXY", IntegrationUri: text, PayloadFormatVersion: "2.0" })); await apig.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: "GET /text", Target: `integrations/${textIntegration.IntegrationId}` }));
    const failIntegration = await apig.send(new CreateIntegrationCommand({ ApiId: apiId, IntegrationType: "AWS_PROXY", IntegrationUri: fail, PayloadFormatVersion: "2.0" })); await apig.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: "GET /fail", Target: `integrations/${failIntegration.IntegrationId}` }));
    await apig.send(new CreateStageCommand({ ApiId: apiId, StageName: "dev", AutoDeploy: true }));
    const base = `http://127.0.0.1:${simulator.invokePort}/${apiId}/dev`; const now = Math.floor(Date.now() / 1000);
    const token = jwt(keys.privateKey, kid, { iss: issuer, aud: "parity", exp: now + 300, iat: now, scope: "orders:read profile", sub: "user-1" });
    let response = await fetch(`${base}/v1/7`, { headers: { authorization: `Bearer ${token}`, "user-agent": "parity-agent" } }); assert.equal(response.status, 201);
    const legacy = await response.json() as any;
    assert.equal(legacy.version, "1.0"); assert.equal(legacy.resource, "/v1/{id}"); assert.equal(legacy.path, "/dev/v1/7"); assert.equal(legacy.httpMethod, "GET"); assert.equal(legacy.queryStringParameters, null); assert.equal(legacy.multiValueQueryStringParameters, null); assert.equal(legacy.stageVariables, null); assert.deepEqual(legacy.pathParameters, { id: "7" });
    const context = legacy.requestContext; assert.equal(context.httpMethod, "GET"); assert.equal(context.path, "/dev/v1/7"); assert.equal(context.resourcePath, "/v1/{id}"); assert.equal(context.resourceId, "GET /v1/{id}"); assert.equal(context.protocol, "HTTP/1.1"); assert.equal(context.stage, "dev"); assert.equal(context.accountId, account); assert.equal(context.apiId, apiId);
    assert.equal(context.extendedRequestId, context.requestId); assert.equal(typeof context.requestTimeEpoch, "number"); assert.match(context.requestTime, CLF); assert.equal(context.identity.sourceIp, "127.0.0.1"); assert.equal(context.identity.userAgent, "parity-agent"); assert.equal(context.identity.accessKey, null); assert.equal(context.identity.userArn, null);
    assert.equal(context.authorizer.claims.sub, "user-1"); assert.deepEqual(context.authorizer.scopes, ["orders:read", "profile"]); assert.equal(context.authorizer.jwt, undefined, "payload 1.0 uses authorizer.claims, not authorizer.jwt");
    response = await fetch(`${base}/mapped/9?keep=1`, { headers: { "x-drop": "secret" } }); assert.equal(response.status, 202, "response mapping applies to the Lambda statusCode"); assert.equal(response.headers.get("x-route"), "GET /mapped/{id}"); assert.equal(response.headers.get("x-copy"), "lambda");
    const event = await response.json() as any; assert.equal(event.version, "2.0"); assert.equal(event.headers["x-request"], event.requestContext.requestId); assert.equal(event.headers["x-drop"], undefined); assert.deepEqual(event.queryStringParameters, { keep: "1", source: "mapped" }); assert.equal(event.rawQueryString, "keep=1&source=mapped"); assert.equal(event.rawPath, "/rewritten/9"); assert.match(event.requestContext.time, CLF);
    response = await fetch(`${base}/text`); assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/json"); assert.equal(await response.text(), "Hello from Lambda!");
    response = await fetch(`${base}/fail`); assert.equal(response.status, 500); assert.deepEqual(await response.json(), { message: "Internal Server Error" });
  });
});

test("DPG-36/§6 quick create HTTP targets, REQUEST authorizer $context/$stageVariables identity sources and default TTL, stage-variable Lambda URIs, and authorizer.iam", async () => {
  await withSimulator("stacksim-apig-v2-smaller-", { authMode: "validate" }, async (simulator, { apig, lambda }) => {
    const quick = await apig.send(new CreateApiCommand({ Name: "quick-http", ProtocolType: "HTTP", Target: "https://example.com/base" }));
    let integration = (await apig.send(new GetIntegrationsCommand({ ApiId: quick.ApiId }))).Items![0]; assert.equal(integration.IntegrationType, "HTTP_PROXY"); assert.equal(integration.PayloadFormatVersion, "1.0"); assert.equal(integration.IntegrationMethod, "ANY"); assert.equal(integration.IntegrationUri, "https://example.com/base"); assert.equal(integration.ApiGatewayManaged, true);
    assert.equal((await apig.send(new GetRoutesCommand({ ApiId: quick.ApiId }))).Items![0].RouteKey, "$default"); assert.equal((await apig.send(new GetStagesCommand({ ApiId: quick.ApiId }))).Items![0].StageName, "$default");
    await apig.send(new UpdateApiCommand({ ApiId: quick.ApiId, Target: "https://example.org/next", RouteKey: "ANY /{proxy+}" })); integration = (await apig.send(new GetIntegrationsCommand({ ApiId: quick.ApiId }))).Items![0]; assert.equal(integration.IntegrationUri, "https://example.org/next"); assert.equal((await apig.send(new GetRoutesCommand({ ApiId: quick.ApiId }))).Items![0].RouteKey, "ANY /{proxy+}");
    const echo = await lambdaFunction(lambda, "smaller-echo", "index.echo"); const simple = await lambdaFunction(lambda, "smaller-simple", "index.simple"); const unauthorized = await lambdaFunction(lambda, "smaller-unauthorized", "index.unauthorized");
    const api = await apig.send(new CreateApiCommand({ Name: "smaller", ProtocolType: "HTTP" })); const apiId = api.ApiId!;
    const defaults = await apig.send(new CreateAuthorizerCommand({ ApiId: apiId, Name: "defaults", AuthorizerType: "REQUEST", AuthorizerUri: simple, AuthorizerPayloadFormatVersion: "2.0", EnableSimpleResponses: true, IdentitySource: [] })); assert.equal(defaults.AuthorizerResultTtlInSeconds, 0, "caching is off unless AuthorizerResultTtlInSeconds is set"); assert.deepEqual(defaults.IdentitySource ?? [], []);
    await assert.rejects(apig.send(new CreateAuthorizerCommand({ ApiId: apiId, Name: "path", AuthorizerType: "REQUEST", AuthorizerUri: simple, AuthorizerPayloadFormatVersion: "2.0", IdentitySource: ["$request.path.id"] })), rejects(/IdentitySource/));
    await assert.rejects(apig.send(new CreateAuthorizerCommand({ ApiId: apiId, Name: "cached", AuthorizerType: "REQUEST", AuthorizerUri: simple, AuthorizerPayloadFormatVersion: "2.0", AuthorizerResultTtlInSeconds: 60, IdentitySource: [] })), rejects(/IdentitySource is required/));
    const contextual = await apig.send(new CreateAuthorizerCommand({ ApiId: apiId, Name: "contextual", AuthorizerType: "REQUEST", AuthorizerUri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${simple}/invocations`, AuthorizerPayloadFormatVersion: "2.0", EnableSimpleResponses: true, IdentitySource: ["$request.header.x-token", "$context.routeKey", "$stageVariables.tenant"], AuthorizerResultTtlInSeconds: 30 }));
    const throwing = await apig.send(new CreateAuthorizerCommand({ ApiId: apiId, Name: "throwing", AuthorizerType: "REQUEST", AuthorizerUri: unauthorized, AuthorizerPayloadFormatVersion: "2.0", EnableSimpleResponses: true, IdentitySource: [] }));
    const staged = await apig.send(new CreateIntegrationCommand({ ApiId: apiId, IntegrationType: "AWS_PROXY", IntegrationUri: `arn:aws:lambda:${region}:${account}:function:\${stageVariables.fn}`, PayloadFormatVersion: "2.0" })); assert.match(staged.IntegrationUri!, /\$\{stageVariables\.fn\}$/);
    await apig.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: "GET /authz", Target: `integrations/${staged.IntegrationId}`, AuthorizationType: "CUSTOM", AuthorizerId: contextual.AuthorizerId }));
    await apig.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: "GET /throwing", Target: `integrations/${staged.IntegrationId}`, AuthorizationType: "CUSTOM", AuthorizerId: throwing.AuthorizerId }));
    await apig.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: "GET /iam", Target: `integrations/${staged.IntegrationId}`, AuthorizationType: "AWS_IAM" }));
    await apig.send(new CreateStageCommand({ ApiId: apiId, StageName: "$default", AutoDeploy: true, StageVariables: { fn: "smaller-echo", tenant: "blue" } }));
    await permit(lambda, "smaller-echo", apiId); await permit(lambda, "smaller-simple", apiId, `authorizers/${contextual.AuthorizerId}`, "contextual"); await permit(lambda, "smaller-unauthorized", apiId, `authorizers/${throwing.AuthorizerId}`, "throwing"); void echo;
    const base = `http://127.0.0.1:${simulator.invokePort}/${apiId}`;
    assert.equal((await fetch(`${base}/authz`)).status, 401, "a missing identity source returns 401 without invoking the authorizer");
    let response = await fetch(`${base}/authz`, { headers: { "x-token": "allow" } }); assert.equal(response.status, 201);
    let event = await response.json() as any; assert.equal(event.requestContext.authorizer.lambda.source, "allow|GET /authz|blue"); assert.equal(event.stageVariables.fn, "smaller-echo"); assert.equal(event.rawPath, "/authz");
    assert.equal((await fetch(`${base}/throwing`)).status, 401, "an authorizer that fails with Unauthorized returns 401");
    const iamUrl = `${base}/iam`; response = await fetch(iamUrl, { headers: signedHeaders(iamUrl, new Date()) }); assert.equal(response.status, 201);
    event = await response.json() as any; const iam = event.requestContext.authorizer.iam; assert.ok(iam, "AWS_IAM routes expose authorizer.iam"); assert.equal(event.requestContext.authorizer.lambda, undefined); assert.equal(iam.accessKey, "admin"); assert.equal(iam.accountId, account); assert.ok(iam.userArn); assert.ok(iam.userId); assert.equal(iam.cognitoIdentity, null); assert.ok(Object.hasOwn(iam, "principalOrgId"));
  });
});

test("DPG-11 HTTP API AWS service integrations dispatch EventBridge-PutEvents, StepFunctions Start/StopExecution, and SQS Receive/Delete/Purge through the integration role", async () => {
  await withSimulator("stacksim-apig-v2-services-", {}, async (simulator, { apig, iam, sqs, sfn, events }) => {
    simulator.apigatewayv2.setServiceIntegrations({ eventbridge: simulator.eventbridge, stepfunctions: simulator.stepfunctions });
    const queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "apig-service-work" }))).QueueUrl!; const queueArn = `arn:aws:sqs:${region}:${account}:apig-service-work`;
    const eventsQueue = (await sqs.send(new CreateQueueCommand({ QueueName: "apig-service-events" }))).QueueUrl!; const eventsQueueArn = `arn:aws:sqs:${region}:${account}:apig-service-events`;
    const rule = await events.send(new PutRuleCommand({ Name: "from-api", EventPattern: JSON.stringify({ source: ["orders.api"] }) }));
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl: eventsQueue, Attributes: { Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sqs:SendMessage", Resource: eventsQueueArn, Condition: { ArnEquals: { "aws:SourceArn": rule.RuleArn } } }] }) } }));
    await events.send(new PutTargetsCommand({ Rule: "from-api", Targets: [{ Id: "queue", Arn: eventsQueueArn }] }));
    const machineRole = (await iam.send(new CreateRoleCommand({ RoleName: "apig-service-sfn", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }))).Role!.Arn!;
    const machine = await sfn.send(new CreateStateMachineCommand({ name: "apig-wait", roleArn: machineRole, definition: JSON.stringify({ StartAt: "Hold", States: { Hold: { Type: "Wait", Seconds: 300, End: true } } }) }));
    const role = await gatewayRole(iam, [
      { Action: "events:PutEvents", Resource: `arn:aws:events:${region}:${account}:event-bus/default` },
      { Action: ["states:StartExecution"], Resource: machine.stateMachineArn! }, { Action: ["states:StopExecution"], Resource: `arn:aws:states:${region}:${account}:execution:apig-wait:*` },
      { Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:PurgeQueue"], Resource: queueArn },
    ]);
    const api = await apig.send(new CreateApiCommand({ Name: "services", ProtocolType: "HTTP" })); const apiId = api.ApiId!;
    const service = (subtype: string, parameters: Record<string, string>, credentialsArn = role) => apig.send(new CreateIntegrationCommand({ ApiId: apiId, IntegrationType: "AWS_PROXY", IntegrationSubtype: subtype, PayloadFormatVersion: "1.0", CredentialsArn: credentialsArn, RequestParameters: parameters }));
    await assert.rejects(service("StepFunctions-StartSyncExecution", { StateMachineArn: machine.stateMachineArn! }), rejects(/EXPRESS.*STANDARD/));
    await assert.rejects(service("Kinesis-PutRecord", { StreamName: "s", Data: "d", PartitionKey: "p" }), rejects(/not supported by StackSim/));
    await assert.rejects(service("EventBridge-PutEvents", { Source: "orders.api", DetailType: "Created" }), rejects(/Detail is required/));
    await assert.rejects(service("SQS-PurgeQueue", { QueueUrl: queueUrl, MessageBody: "x" }), rejects(/Invalid SQS-PurgeQueue request parameter MessageBody/));
    const putEvents = await service("EventBridge-PutEvents", { Source: "$request.body.source", DetailType: "$request.body.type", Detail: "$request.body.detail", EventBusName: "default" });
    const deniedEvents = await service("EventBridge-PutEvents", { Source: "orders.api", DetailType: "Denied", Detail: "{}", EventBusName: "other" });
    const start = await service("StepFunctions-StartExecution", { StateMachineArn: machine.stateMachineArn!, Input: "$request.body", Name: "$request.header.x-name" });
    const stop = await service("StepFunctions-StopExecution", { ExecutionArn: "$request.body.executionArn", Cause: "stopped by api", Error: "Api.Stop" });
    const receive = await service("SQS-ReceiveMessage", { QueueUrl: queueUrl, MaxNumberOfMessages: "1", AttributeNames: "All" });
    const remove = await service("SQS-DeleteMessage", { QueueUrl: queueUrl, ReceiptHandle: "$request.querystring.receipt" });
    const purge = await service("SQS-PurgeQueue", { QueueUrl: queueUrl, Region: region });
    for (const [routeKey, integration] of [["POST /events", putEvents], ["POST /denied", deniedEvents], ["POST /start", start], ["POST /stop", stop], ["GET /receive", receive], ["DELETE /message", remove], ["POST /purge", purge]] as const) await apig.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: routeKey, Target: `integrations/${integration.IntegrationId}` }));
    await apig.send(new CreateStageCommand({ ApiId: apiId, StageName: "$default", AutoDeploy: true }));
    const base = `http://127.0.0.1:${simulator.invokePort}/${apiId}`; const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    let response = await post("/events", { source: "orders.api", type: "OrderCreated", detail: { orderId: "o-1" } }); assert.equal(response.status, 200); const put = await response.json() as any; assert.equal(put.FailedEntryCount, 0); assert.ok(put.Entries[0].EventId);
    const delivered = await eventually(async () => (await sqs.send(new ReceiveMessageCommand({ QueueUrl: eventsQueue }))).Messages?.[0]); const envelope = JSON.parse(delivered.Body!); assert.equal(envelope["detail-type"], "OrderCreated"); assert.deepEqual(envelope.detail, { orderId: "o-1" });
    assert.equal((await post("/denied", {})).status, 500, "the integration role must allow events:PutEvents on the target bus");
    response = await post("/start", { order: 42 }, { "x-name": "from-api" }); assert.equal(response.status, 200); const started = await response.json() as any; assert.match(started.executionArn, /:execution:apig-wait:from-api$/); assert.ok(started.startDate);
    const execution = await sfn.send(new DescribeExecutionCommand({ executionArn: started.executionArn })); assert.equal(execution.status, "RUNNING"); assert.deepEqual(JSON.parse(execution.input!), { order: 42 });
    response = await post("/stop", { executionArn: started.executionArn }); assert.equal(response.status, 200); assert.ok((await response.json() as any).stopDate);
    const stopped = await sfn.send(new DescribeExecutionCommand({ executionArn: started.executionArn })); assert.equal(stopped.status, "ABORTED"); assert.equal(stopped.error, "Api.Stop"); assert.equal(stopped.cause, "stopped by api");
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "work-1" }));
    response = await fetch(`${base}/receive`); assert.equal(response.status, 200); const received = await response.json() as any; assert.equal(received.Messages.length, 1); assert.equal(received.Messages[0].Body, "work-1");
    response = await fetch(`${base}/message?receipt=${encodeURIComponent(received.Messages[0].ReceiptHandle)}`, { method: "DELETE" }); assert.equal(response.status, 200);
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "work-2" })); response = await post("/purge", {}); assert.equal(response.status, 200);
    const attributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] })); assert.equal(attributes.Attributes?.ApproximateNumberOfMessages, "0"); assert.equal(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible, "0");
  });
});

test("DPG-23 HTTP API access logs populate the documented $context variables and reuse one log stream per stage", async () => {
  await withSimulator("stacksim-apig-v2-access-logs-", {}, async (simulator, { apig, lambda, logs }) => {
    await logs.send(new CreateLogGroupCommand({ logGroupName: "/aws/apigateway/parity" })); await lambdaFunction(lambda, "logs-echo", "index.echo"); const simple = await lambdaFunction(lambda, "logs-simple", "index.simple");
    const api = await apig.send(new CreateApiCommand({ Name: "access-logs", ProtocolType: "HTTP" })); const apiId = api.ApiId!;
    const integration = await apig.send(new CreateIntegrationCommand({ ApiId: apiId, IntegrationType: "AWS_PROXY", IntegrationUri: `arn:aws:lambda:${region}:${account}:function:logs-echo`, PayloadFormatVersion: "2.0" }));
    const authorizer = await apig.send(new CreateAuthorizerCommand({ ApiId: apiId, Name: "token", AuthorizerType: "REQUEST", AuthorizerUri: simple, AuthorizerPayloadFormatVersion: "2.0", EnableSimpleResponses: true, IdentitySource: ["$request.header.x-token"] }));
    await apig.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: "GET /ok", Target: `integrations/${integration.IntegrationId}` })); await apig.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: "GET /guarded", Target: `integrations/${integration.IntegrationId}`, AuthorizationType: "CUSTOM", AuthorizerId: authorizer.AuthorizerId }));
    const format = `$context.identity.sourceIp - - [$context.requestTime] "$context.httpMethod $context.routeKey $context.protocol" $context.status $context.responseLength $context.requestId ua=$context.identity.userAgent path=$context.path istatus=$context.integration.status iistatus=$context.integration.integrationStatus err=$context.error.message quoted=$context.error.messageString type=$context.error.responseType authz=$context.authorizer.error tenant=$context.authorizer.tenant stage=$context.stage api=$context.apiId epoch=$context.requestTimeEpoch xid=$context.extendedRequestId.`;
    await apig.send(new CreateStageCommand({ ApiId: apiId, StageName: "dev", AutoDeploy: true, AccessLogSettings: { DestinationArn: `arn:aws:logs:${region}:${account}:log-group:/aws/apigateway/parity`, Format: format } }));
    await permit(lambda, "logs-echo", apiId); await permit(lambda, "logs-simple", apiId, `authorizers/${authorizer.AuthorizerId}`, "authorizer");
    const base = `http://127.0.0.1:${simulator.invokePort}/${apiId}/dev`;
    assert.equal((await fetch(`${base}/ok`, { headers: { "user-agent": "log-agent" } })).status, 201); assert.equal((await fetch(`${base}/missing`)).status, 404); assert.equal((await fetch(`${base}/guarded`)).status, 401); assert.equal((await fetch(`${base}/guarded`, { headers: { "x-token": "allow" } })).status, 201);
    const streams = await logs.send(new DescribeLogStreamsCommand({ logGroupName: "/aws/apigateway/parity" })); assert.deepEqual(streams.logStreams?.map(stream => stream.logStreamName), [`${apiId}_dev`], "one log stream per stage, reused across requests");
    const lines = await eventually(async () => { const found = (await logs.send(new FilterLogEventsCommand({ logGroupName: "/aws/apigateway/parity" }))).events?.map(item => item.message!) ?? []; return found.length >= 4 ? found : undefined; });
    const ok = lines.find(line => line.includes("GET GET /ok"))!; assert.ok(ok, lines.join("\n"));
    assert.match(ok, /^127\.0\.0\.1 - - \[\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2} \+0000\] "GET GET \/ok HTTP\/1\.1" 201 \d+ /); assert.match(ok, /ua=log-agent path=\/dev\/ok istatus=201 iistatus=200 err=- quoted=- type=- authz=- tenant=- stage=dev /); assert.match(ok, new RegExp(`api=${apiId} epoch=\\d+ xid=[^ ]+\\.$`), "a trailing period after a variable is kept as text");
    const missing = lines.find(line => line.includes(" 404 "))!; assert.match(missing, /"GET - HTTP\/1\.1" 404 /); assert.match(missing, /err=Not Found quoted="Not Found" type=RESOURCE_NOT_FOUND/);
    const unauthorized = lines.find(line => line.includes(" 401 "))!; assert.match(unauthorized, /type=UNAUTHORIZED authz=Unauthorized/);
    const allowed = lines.filter(line => line.includes("GET /guarded") && line.includes(" 201 "))[0]; assert.match(allowed, /tenant=t1/);
  });
});

const importedDocument = (lambdaArn: string, authorizerArn: string) => ({
  openapi: "3.0.1",
  info: { title: "imported-orders", description: "Imported from OpenAPI", version: "2026-10-21" },
  servers: [{ url: "https://{apiId}.execute-api.{region}.amazonaws.com/{basePath}", variables: { basePath: { default: "v1" } } }],
  "x-amazon-apigateway-importexport-version": "1.0",
  "x-amazon-apigateway-cors": { allowOrigins: ["https://app.test"], allowMethods: ["GET", "POST"], maxAge: 300 },
  paths: {
    "/orders/{id}": {
      get: { operationId: "GetOrder", security: [{ jwt: ["orders:read"] }], "x-amazon-apigateway-integration": { type: "aws_proxy", httpMethod: "POST", uri: lambdaArn, payloadFormatVersion: "2.0", timeoutInMillis: 15000, connectionType: "INTERNET" } },
      delete: { security: [{ sigv4: [] }], "x-amazon-apigateway-integration": { $ref: "#/components/x-amazon-apigateway-integrations/shared" } },
    },
    "/orders": {
      post: { security: [{ lambda: [] }], requestBody: { content: { "application/json": { schema: { type: "object" } } } }, "x-amazon-apigateway-integration": { type: "http_proxy", httpMethod: "POST", uri: "https://backend.example.com/orders", payloadFormatVersion: 1.0, requestParameters: { "append:header.x-source": "import" } } },
      get: { "x-amazon-apigateway-integration": { $ref: "#/components/x-amazon-apigateway-integrations/shared" } },
    },
    "/legacy": { get: { "x-amazon-apigateway-integration": { type: "aws", httpMethod: "POST", uri: lambdaArn } } },
    "/$default": { "x-amazon-apigateway-any-method": { isDefaultRoute: true, "x-amazon-apigateway-integration": { type: "aws_proxy", httpMethod: "POST", uri: lambdaArn, payloadFormatVersion: "2.0" } } },
  },
  components: {
    securitySchemes: {
      jwt: { type: "oauth2", flows: {}, "x-amazon-apigateway-authorizer": { type: "jwt", identitySource: "$request.header.Authorization", jwtConfiguration: { issuer: "https://issuer.import", audience: ["orders"] } } },
      lambda: { type: "apiKey", name: "x-token", in: "header", "x-amazon-apigateway-authorizer": { type: "request", identitySource: "$request.header.x-token", authorizerUri: authorizerArn, authorizerPayloadFormatVersion: "2.0", authorizerResultTtlInSeconds: 60, enableSimpleResponses: true } },
      sigv4: { type: "apiKey", name: "Authorization", in: "header", "x-amazon-apigateway-authtype": "awsSigv4" },
    },
    "x-amazon-apigateway-integrations": { shared: { type: "aws_proxy", httpMethod: "POST", uri: lambdaArn, payloadFormatVersion: "1.0" } },
  },
});

test("DPG-20 HTTP API ImportApi, ReimportApi, and ExportApi round-trip OpenAPI 3.0 with API Gateway extensions; WebSocket APIs reject import/export", async () => {
  await withSimulator("stacksim-apig-v2-openapi-", {}, async (simulator, { apig, lambda }) => {
    const echo = await lambdaFunction(lambda, "openapi-echo", "index.echo"); const simple = await lambdaFunction(lambda, "openapi-simple", "index.simple");
    const body = JSON.stringify(importedDocument(echo, `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${simple}/invocations`));
    await assert.rejects(apig.send(new ImportApiCommand({ Body: body, FailOnWarnings: true })), rejects(/Warnings found during import[\s\S]*aws/));
    await assert.rejects(apig.send(new ImportApiCommand({ Body: JSON.stringify({ swagger: "2.0", info: { title: "old" }, paths: {} }) })), rejects(/OpenAPI 3\.0/));
    await assert.rejects(apig.send(new ImportApiCommand({ Body: JSON.stringify({ openapi: "3.0.1", info: { title: "multi" }, paths: { "/a": { get: { security: [{ a: [] }, { b: [] }] } } } }) })), rejects(/multiple security requirements/));
    const imported = await apig.send(new ImportApiCommand({ Body: body, Basepath: "prepend" })); const apiId = imported.ApiId!;
    assert.equal(imported.Name, "imported-orders"); assert.equal(imported.Description, "Imported from OpenAPI"); assert.equal(imported.Version, "2026-10-21"); assert.equal(imported.ProtocolType, "HTTP"); assert.deepEqual(imported.CorsConfiguration?.AllowOrigins, ["https://app.test"]);
    assert.ok(imported.Warnings?.some(value => /aws for route GET \/v1\/legacy/.test(value)), JSON.stringify(imported.Warnings)); assert.ok(imported.ImportInfo?.some(value => /requestBody for POST \/v1\/orders/.test(value)), JSON.stringify(imported.ImportInfo));
    const routes = (await apig.send(new GetRoutesCommand({ ApiId: apiId }))).Items!; const byKey = Object.fromEntries(routes.map(route => [route.RouteKey!, route]));
    assert.deepEqual(Object.keys(byKey).sort(), ["$default", "DELETE /v1/orders/{id}", "GET /v1/legacy", "GET /v1/orders", "GET /v1/orders/{id}", "POST /v1/orders"]);
    assert.equal(byKey["GET /v1/orders/{id}"].AuthorizationType, "JWT"); assert.deepEqual(byKey["GET /v1/orders/{id}"].AuthorizationScopes, ["orders:read"]); assert.equal(byKey["GET /v1/orders/{id}"].OperationName, "GetOrder"); assert.equal(byKey["POST /v1/orders"].AuthorizationType, "CUSTOM"); assert.equal(byKey["DELETE /v1/orders/{id}"].AuthorizationType, "AWS_IAM"); assert.equal(byKey["GET /v1/legacy"].Target, undefined);
    assert.equal(byKey["GET /v1/orders"].Target, byKey["DELETE /v1/orders/{id}"].Target, "a shared $ref integration is imported once");
    const authorizers = (await apig.send(new GetAuthorizersCommand({ ApiId: apiId }))).Items!; const jwtAuthorizer = authorizers.find(value => value.Name === "jwt")!; const lambdaAuthorizer = authorizers.find(value => value.Name === "lambda")!;
    assert.equal(jwtAuthorizer.AuthorizerType, "JWT"); assert.equal(jwtAuthorizer.JwtConfiguration?.Issuer, "https://issuer.import"); assert.equal(lambdaAuthorizer.AuthorizerType, "REQUEST"); assert.equal(lambdaAuthorizer.AuthorizerResultTtlInSeconds, 60); assert.equal(lambdaAuthorizer.EnableSimpleResponses, true); assert.deepEqual(lambdaAuthorizer.IdentitySource, ["$request.header.x-token"]);
    const integrations = (await apig.send(new GetIntegrationsCommand({ ApiId: apiId }))).Items!; const http = integrations.find(value => value.IntegrationType === "HTTP_PROXY")!; assert.equal(http.PayloadFormatVersion, "1.0"); assert.deepEqual(http.RequestParameters, { "append:header.x-source": "import" }); assert.equal(integrations.find(value => value.TimeoutInMillis === 15000)?.PayloadFormatVersion, "2.0");
    await apig.send(new CreateStageCommand({ ApiId: apiId, StageName: "$default", AutoDeploy: true })); await permit(lambda, "openapi-echo", apiId);
    const invoked = await fetch(`http://127.0.0.1:${simulator.invokePort}/${apiId}/anything`); assert.equal(invoked.status, 201); assert.equal((await invoked.json() as any).routeKey, "$default");
    const exported = JSON.parse(Buffer.from((await apig.send(new ExportApiCommand({ ApiId: apiId, Specification: "OAS30", OutputType: "JSON" }))).body!).toString("utf8"));
    assert.equal(exported.openapi, "3.0.1"); assert.equal(exported.info.title, "imported-orders"); assert.equal(exported["x-amazon-apigateway-importexport-version"], "1.0"); assert.deepEqual(exported["x-amazon-apigateway-cors"].allowOrigins, ["https://app.test"]);
    const getOrder = exported.paths["/v1/orders/{id}"].get; assert.equal(getOrder.operationId, "GetOrder"); assert.deepEqual(getOrder.security, [{ jwt: ["orders:read"] }]); assert.equal(getOrder["x-amazon-apigateway-integration"].type, "aws_proxy"); assert.equal(getOrder["x-amazon-apigateway-integration"].uri, echo); assert.equal(getOrder["x-amazon-apigateway-integration"].payloadFormatVersion, "2.0");
    assert.deepEqual(exported.paths["/v1/orders/{id}"].parameters.map((value: any) => value.name), ["id"]); assert.equal(exported.paths["/$default"]["x-amazon-apigateway-any-method"].isDefaultRoute, true);
    assert.equal(exported.components.securitySchemes.jwt["x-amazon-apigateway-authorizer"].type, "jwt"); assert.equal(exported.components.securitySchemes.lambda["x-amazon-apigateway-authorizer"].type, "request"); assert.equal(exported.components.securitySchemes.sigv4["x-amazon-apigateway-authtype"], "awsSigv4");
    const yaml = Buffer.from((await apig.send(new ExportApiCommand({ ApiId: apiId, Specification: "OAS30", OutputType: "YAML", StageName: "$default", IncludeExtensions: false }))).body!).toString("utf8");
    assert.match(yaml, /^openapi: "3\.0\.1"/m); assert.doesNotMatch(yaml, /x-amazon-apigateway-integration|x-amazon-apigateway-cors/); assert.match(yaml, /x-amazon-apigateway-any-method/);
    await assert.rejects(apig.send(new ExportApiCommand({ ApiId: apiId, Specification: "OAS20", OutputType: "JSON" })), rejects(/OAS30/));
    await assert.rejects(apig.send(new ExportApiCommand({ ApiId: apiId, Specification: "OAS30", OutputType: "JSON", StageName: "missing" })), rejects(/Invalid Stage/, "NotFoundException"));
    const copy = await apig.send(new ImportApiCommand({ Body: JSON.stringify(exported) })); assert.deepEqual((await apig.send(new GetRoutesCommand({ ApiId: copy.ApiId }))).Items!.map(route => route.RouteKey).sort(), Object.keys(byKey).filter(key => key !== "GET /v1/legacy").concat("GET /v1/legacy").sort(), "an exported definition imports as an equivalent API");
    const yamlImport = await apig.send(new ImportApiCommand({ Body: `openapi: 3.0.1\ninfo:\n  title: yaml-api\npaths:\n  /hello:\n    get:\n      x-amazon-apigateway-integration:\n        type: aws_proxy\n        httpMethod: POST\n        uri: ${echo}\n        payloadFormatVersion: "2.0"\n` })); assert.equal(yamlImport.Name, "yaml-api"); assert.equal((await apig.send(new GetRoutesCommand({ ApiId: yamlImport.ApiId }))).Items![0].RouteKey, "GET /hello");
    const reimported = await apig.send(new ReimportApiCommand({ ApiId: apiId, Body: JSON.stringify({ openapi: "3.0.1", info: { title: "reimported" }, paths: { "/ping": { get: { "x-amazon-apigateway-integration": { type: "aws_proxy", httpMethod: "POST", uri: echo, payloadFormatVersion: "2.0" } } } } }) }));
    assert.equal(reimported.ApiId, apiId); assert.equal(reimported.Name, "reimported"); assert.deepEqual((await apig.send(new GetRoutesCommand({ ApiId: apiId }))).Items!.map(route => route.RouteKey), ["GET /ping"]); assert.equal((await apig.send(new GetAuthorizersCommand({ ApiId: apiId }))).Items!.length, 0); assert.equal((await apig.send(new GetApiCommand({ ApiId: apiId }))).CorsConfiguration, undefined);
    assert.equal((await fetch(`http://127.0.0.1:${simulator.invokePort}/${apiId}/ping`)).status, 201, "reimport keeps stages and auto-deploys");
    const socket = await apig.send(new CreateApiCommand({ Name: "socket", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action" }));
    await assert.rejects(apig.send(new ExportApiCommand({ ApiId: socket.ApiId, Specification: "OAS30", OutputType: "JSON" })), rejects(/only for HTTP APIs/));
    await assert.rejects(apig.send(new ReimportApiCommand({ ApiId: socket.ApiId, Body: body })), rejects(/only for HTTP APIs/));
  });
});

test("DPG-20 every @aws-sdk/client-apigatewayv2 command gets a real handler or an explicit StackSim boundary, never an unknown-route 404", async () => {
  await withSimulator("stacksim-apig-v2-audit-", {}, async (simulator, { apig }) => {
    await assert.rejects(apig.send(new CreateVpcLinkCommand({ Name: "link", SubnetIds: ["subnet-1"] })), rejects(/VPC links for HTTP APIs are not supported by StackSim/));
    await assert.rejects(apig.send(new GetVpcLinksCommand({})), rejects(/VPC links for HTTP APIs are not supported by StackSim/));
    await assert.rejects(apig.send(new GetVpcLinkCommand({ VpcLinkId: "abc" })), rejects(/VPC links for HTTP APIs are not supported by StackSim/));
    await assert.rejects(apig.send(new UpdateVpcLinkCommand({ VpcLinkId: "abc", Name: "x" })), rejects(/VPC links for HTTP APIs are not supported by StackSim/));
    await assert.rejects(apig.send(new DeleteVpcLinkCommand({ VpcLinkId: "abc" })), rejects(/VPC links for HTTP APIs are not supported by StackSim/));
    const http = await apig.send(new CreateApiCommand({ Name: "audit-http", ProtocolType: "HTTP" }));
    const integration = await apig.send(new CreateIntegrationCommand({ ApiId: http.ApiId, IntegrationType: "HTTP_PROXY", IntegrationUri: "https://example.com", PayloadFormatVersion: "1.0" }));
    await assert.rejects(apig.send(new CreateIntegrationCommand({ ApiId: http.ApiId, IntegrationType: "HTTP_PROXY", IntegrationUri: "arn:aws:elasticloadbalancing:eu-west-1:000000000000:listener/app/x/1/2", ConnectionType: "VPC_LINK", ConnectionId: "vl", PayloadFormatVersion: "1.0" })), rejects(/VPC links for HTTP APIs are not supported by StackSim/));
    await assert.rejects(apig.send(new UpdateIntegrationCommand({ ApiId: http.ApiId, IntegrationId: integration.IntegrationId, ConnectionType: "VPC_LINK", ConnectionId: "vl" })), rejects(/VPC links for HTTP APIs are not supported by StackSim/));
    const socket = await apig.send(new CreateApiCommand({ Name: "audit-socket", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action" }));
    const commands = Object.entries(apigatewayv2).filter(([name, value]) => name.endsWith("Command") && typeof value === "function") as Array<[string, new (input: any) => any]>;
    assert.ok(commands.length > 90, `expected the full command set, found ${commands.length}`);
    const ordered = [...commands.filter(([name]) => !name.startsWith("Delete")), ...commands.filter(([name]) => name.startsWith("Delete"))];
    const unknown: string[] = [];
    for (const apiId of [http.ApiId!, socket.ApiId!]) for (const [name, Command] of ordered) {
      const input = { ApiId: apiId, DomainName: "audit.example.test", IntegrationId: "missing", RouteId: "missing", StageName: "missing", AuthorizerId: "missing", DeploymentId: "missing", ModelId: "missing", ApiMappingId: "missing", IntegrationResponseId: "missing", RouteResponseId: "missing", RequestParameterKey: "route.request.header.x", RouteKey: "GET /a", ResourceArn: `arn:aws:apigateway:${region}::/apis/${apiId}`, TagKeys: ["x"], Tags: { x: "y" }, VpcLinkId: "missing", PortalId: "missing", PortalProductId: "missing", ProductPageId: "missing", ProductRestEndpointPageId: "missing", RoutingRuleId: "missing", Specification: "OAS30", OutputType: "JSON", Name: "audit", ProtocolType: "HTTP", Body: "{}", SubnetIds: [], IntegrationType: "HTTP_PROXY", AuthorizerType: "JWT", IntegrationResponseKey: "$default", RouteResponseKey: "$default", Schema: "{}", Stage: "missing", Actions: [], Conditions: [], Priority: 1, DomainNameConfigurations: [], PortalContent: {}, Authorization: {}, EndpointConfiguration: {}, DisplayName: "audit", PageTitle: "audit", RestEndpointIdentifier: {}, PolicyDocument: "{}" };
      try { await apig.send(new Command(input)); }
      catch (error: any) { if (error?.name === "NotFoundException" && /Unknown API Gateway v2/.test(String(error.message))) unknown.push(`${name} (${apiId === http.ApiId ? "HTTP" : "WEBSOCKET"})`); }
    }
    assert.deepEqual(unknown, [], `commands that fell through to the unknown-route 404: ${unknown.join(", ")}`);
  });
});
