import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  GetResourcesCommand,
  GetStageCommand,
  PutIntegrationCommand,
  PutMethodCommand,
  UpdateAccountCommand,
  UpdateStageCommand,
} from "@aws-sdk/client-api-gateway";
import { CloudWatchLogsClient, CreateLogGroupCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateRoleCommand, GetPolicyVersionCommand, GetRoleCommand, IAMClient, ListAttachedRolePoliciesCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AddPermissionCommand, CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { BatchGetTracesCommand, XRayClient } from "@aws-sdk/client-xray";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const trace = (suffix: string, sampled: "0" | "1" | "?") => `Root=1-66aa0000-${suffix.padStart(24, "0")};Parent=1111111111111111;Sampled=${sampled}`;

const handlerZip = createZip([
  { name: "index.js", content: `exports.handler = async event => {
    const mode = event.queryStringParameters?.mode;
    if (mode === "slow") await new Promise(resolve => setTimeout(resolve, 1_000));
    if (mode === "error") throw new Error("expected lambda failure");
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ traceHeader: process.env._X_AMZN_TRACE_ID, path: event.path }) };
  };` },
  { name: "package.json", content: '{"type":"commonjs"}' },
]);

function document(result: any): any { return JSON.parse(result.Traces?.[0]?.Segments?.[0]?.Document ?? "{}"); }
function iamDocument(value: unknown): any { return typeof value === "string" ? JSON.parse(decodeURIComponent(value)) : value; }

test("XRY-01 API Gateway traces real Lambda attempts, preserves outcomes, propagates context, and honors active/passive decisions", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-xray-apig-")); const clock = new TestClock(Date.now()); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, random: () => 1, authMode: "enforce", cdkBootstrap: true }); let clients: Array<{ destroy(): void }> = [];
  const connect = () => {
    const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region, credentials, maxAttempts: 1 };
    const apigateway = new APIGatewayClient(options); const lambda = new LambdaClient(options); const xray = new XRayClient(options); const iam = new IAMClient(options); const logs = new CloudWatchLogsClient(options); clients.push(apigateway, lambda, xray, iam, logs); return { apigateway, lambda, xray, iam, logs };
  };
  try {
    await simulator.start(); let { apigateway, lambda, xray, iam, logs } = connect();
    await iam.send(new CreateRoleCommand({ RoleName: "xray-execution", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
    await lambda.send(new CreateFunctionCommand({ FunctionName: "xray-handler", Runtime: "nodejs22.x", Handler: "index.handler", Role: `arn:aws:iam::${account}:role/xray-execution`, Timeout: 2, Code: { ZipFile: handlerZip } }));
    await lambda.send(new CreateFunctionCommand({ FunctionName: "xray-denied-handler", Runtime: "nodejs22.x", Handler: "index.handler", Role: `arn:aws:iam::${account}:role/xray-execution`, Timeout: 2, Code: { ZipFile: handlerZip } }));
    const api = await apigateway.send(new CreateRestApiCommand({ name: "xray-orders" }));
    const linked = await iam.send(new GetRoleCommand({ RoleName: "AWSServiceRoleForAPIGateway" }));
    assert.equal(linked.Role?.Path, "/aws-service-role/ops.apigateway.amazonaws.com/"); assert.deepEqual(iamDocument(linked.Role?.AssumeRolePolicyDocument).Statement?.[0]?.Principal, { Service: "ops.apigateway.amazonaws.com" });
    const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: "AWSServiceRoleForAPIGateway" })); assert.deepEqual(attached.AttachedPolicies?.map(policy => policy.PolicyArn), ["arn:aws:iam::aws:policy/aws-service-role/AmazonAPIGatewayServiceRolePolicy"]);
    const policy = await iam.send(new GetPolicyVersionCommand({ PolicyArn: attached.AttachedPolicies![0].PolicyArn!, VersionId: "v1" })); const serviceRolePolicy = iamDocument(policy.PolicyVersion?.Document); assert.equal(serviceRolePolicy.Statement?.length, 8); assert.ok(JSON.stringify(serviceRolePolicy).includes("xray:PutTraceSegments"));
    const east = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "us-east-1", credentials, maxAttempts: 1 }); clients.push(east); await east.send(new CreateRestApiCommand({ name: "xray-orders-east" })); assert.equal(Object.keys(simulator.store.ensureAccount().iam.roles).filter(name => name === "AWSServiceRoleForAPIGateway").length, 1, "multiple Regions reuse one account-global service-linked role");
    const rootResource = (await apigateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(item => item.path === "/")!;
    const echo = await apigateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: rootResource.id!, pathPart: "echo" }));
    await apigateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: echo.id!, httpMethod: "GET", authorizationType: "NONE" }));
    const functionArn = `arn:aws:lambda:${region}:${account}:function:xray-handler`;
    await lambda.send(new AddPermissionCommand({ FunctionName: "xray-handler", StatementId: "allow-api", Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com", SourceArn: `arn:aws:execute-api:${region}:${account}:${api.id}/*/GET/echo` }));
    await apigateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: echo.id!, httpMethod: "GET", type: "AWS_PROXY", integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${functionArn}/invocations`, timeoutInMillis: 500 }));
    const deniedResource = await apigateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: rootResource.id!, pathPart: "denied" })); await apigateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: deniedResource.id!, httpMethod: "GET", authorizationType: "NONE" })); await apigateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: deniedResource.id!, httpMethod: "GET", type: "AWS_PROXY", integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${region}:${account}:function:xray-denied-handler/invocations`, timeoutInMillis: 500 }));
    await apigateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
    const logTrust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "sts:AssumeRole" }] });
    const logRole = await iam.send(new CreateRoleCommand({ RoleName: "xray-access-logs", AssumeRolePolicyDocument: logTrust }));
    await iam.send(new PutRolePolicyCommand({ RoleName: "xray-access-logs", PolicyName: "logs", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }] }) }));
    await logs.send(new CreateLogGroupCommand({ logGroupName: "/xray/access" }));
    await apigateway.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [
      { op: "replace", path: "/tracingEnabled", value: "true" },
      { op: "replace", path: "/accessLogSettings/destinationArn", value: `arn:aws:logs:${region}:${account}:log-group:/xray/access` },
      { op: "replace", path: "/accessLogSettings/format", value: '{"requestId":"$context.requestId","traceId":"$context.xrayTraceId","status":"$context.status"}' },
    ] }));
    await apigateway.send(new UpdateAccountCommand({ patchOperations: [{ op: "replace", path: "/cloudwatchRoleArn", value: logRole.Role!.Arn! }] }));
    let url = `http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/echo`;

    const successId = "000000000000000000000001"; const success = await fetch(url, { headers: { "x-amzn-trace-id": trace(successId, "1") } });
    assert.equal(success.status, 200); assert.equal(success.headers.get("x-amzn-trace-id"), null, "tracing does not invent a response header");
    const lambdaOutput = await success.json() as any; assert.match(lambdaOutput.traceHeader, new RegExp(`^Root=1-66aa0000-${successId};Parent=[0-9a-f]{16};Sampled=1$`));
    const successTrace = document(await xray.send(new BatchGetTracesCommand({ TraceIds: [`1-66aa0000-${successId}`] })));
    assert.equal(successTrace.origin, "AWS::ApiGateway::Stage"); assert.equal(successTrace.aws.api_gateway.rest_api_id, api.id); assert.equal(successTrace.aws.api_gateway.stage, "dev"); assert.equal(successTrace.http.response.status, 200); assert.equal(successTrace.subsegments?.length, 1); assert.equal(successTrace.subsegments[0].name, "Lambda"); assert.equal(lambdaOutput.traceHeader.match(/Parent=([0-9a-f]{16})/)?.[1], successTrace.subsegments[0].id);
    const access = await logs.send(new FilterLogEventsCommand({ logGroupName: "/xray/access" })); assert.equal(JSON.parse(access.events?.[0].message ?? "{}").traceId, `1-66aa0000-${successId}`);

    const rejectedId = "000000000000000000000002"; const rejected = await fetch(`${url}-missing`, { headers: { "x-amzn-trace-id": trace(rejectedId, "1") } }); assert.equal(rejected.status, 403); const rejectedTrace = document(await xray.send(new BatchGetTracesCommand({ TraceIds: [`1-66aa0000-${rejectedId}`] }))); assert.equal(rejectedTrace.error, true); assert.equal(rejectedTrace.subsegments, undefined, "gateway rejection has no fabricated integration subsegment");
    await apigateway.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [{ op: "add", path: "/*/*/throttling/burstLimit", value: "1" }, { op: "add", path: "/*/*/throttling/rateLimit", value: "1" }] }));
    assert.equal((await fetch(url, { headers: { "x-amzn-trace-id": trace("000000000000000000000020", "1") } })).status, 200);
    const throttledId = "000000000000000000000021"; assert.equal((await fetch(url, { headers: { "x-amzn-trace-id": trace(throttledId, "1") } })).status, 429);
    const throttledTrace = document(await xray.send(new BatchGetTracesCommand({ TraceIds: [`1-66aa0000-${throttledId}`] }))); assert.equal(throttledTrace.error, true); assert.equal(throttledTrace.throttle, true); assert.equal(throttledTrace.subsegments, undefined, "throttling happens before an integration attempt");
    await apigateway.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [{ op: "remove", path: "/*/*/throttling/burstLimit" }, { op: "remove", path: "/*/*/throttling/rateLimit" }] })); clock.advance(1_000);
    const deniedId = "000000000000000000000022"; assert.equal((await fetch(`http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/denied`, { headers: { "x-amzn-trace-id": trace(deniedId, "1") } })).status, 403); const deniedTrace = document(await xray.send(new BatchGetTracesCommand({ TraceIds: [`1-66aa0000-${deniedId}`] }))); assert.equal(deniedTrace.error, true); assert.equal(deniedTrace.subsegments?.length, 1, "permission denial remains a real attempted integration"); assert.equal(deniedTrace.subsegments?.[0].error, true);
    const errorId = "000000000000000000000003"; const lambdaError = await fetch(`${url}?mode=error`, { headers: { "x-amzn-trace-id": trace(errorId, "1") } }); const lambdaErrorBody = await lambdaError.text(); assert.equal(lambdaError.status, 504, lambdaErrorBody); const errorTrace = document(await xray.send(new BatchGetTracesCommand({ TraceIds: [`1-66aa0000-${errorId}`] }))); assert.equal(errorTrace.fault, true); assert.equal(errorTrace.subsegments?.[0].fault, true);
    const timeoutId = "000000000000000000000004"; const timeout = await fetch(`${url}?mode=slow`, { headers: { "x-amzn-trace-id": trace(timeoutId, "1") } }); assert.equal(timeout.status, 504); const timeoutTrace = document(await xray.send(new BatchGetTracesCommand({ TraceIds: [`1-66aa0000-${timeoutId}`] }))); assert.equal(timeoutTrace.fault, true); assert.equal(timeoutTrace.subsegments?.length, 1);
    const skippedId = "000000000000000000000005"; assert.equal((await fetch(url, { headers: { "x-amzn-trace-id": trace(skippedId, "0") } })).status, 200); assert.equal((await xray.send(new BatchGetTracesCommand({ TraceIds: [`1-66aa0000-${skippedId}`] }))).Traces?.length, 0);

    clients.forEach(client => client.destroy()); clients = []; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, random: () => 1, authMode: "enforce", cdkBootstrap: true }); await simulator.start(); ({ apigateway, lambda, xray, iam, logs } = connect());
    url = `http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/echo`; assert.equal((await apigateway.send(new GetStageCommand({ restApiId: api.id!, stageName: "dev" }))).tracingEnabled, true); assert.equal((await xray.send(new BatchGetTracesCommand({ TraceIds: [`1-66aa0000-${successId}`] }))).Traces?.length, 1);
    await apigateway.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [{ op: "replace", path: "/tracingEnabled", value: "false" }] }));
    const passiveAbsentBefore = simulator.xray.health().traceCount; assert.equal((await fetch(url)).status, 200); assert.equal(simulator.xray.health().traceCount, passiveAbsentBefore, "passive stage does not sample absent context");
    const passiveId = "000000000000000000000006"; assert.equal((await fetch(url, { headers: { "x-amzn-trace-id": trace(passiveId, "1") } })).status, 200); assert.equal((await xray.send(new BatchGetTracesCommand({ TraceIds: [`1-66aa0000-${passiveId}`] }))).Traces?.length, 1, "passive stage honors upstream Sampled=1");
    await apigateway.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [{ op: "replace", path: "/tracingEnabled", value: "true" }] })); assert.equal((await apigateway.send(new GetStageCommand({ restApiId: api.id!, stageName: "dev" }))).tracingEnabled, true);
    assert.equal(Object.keys(simulator.store.ensureAccount().iam.roles).filter(name => name === "AWSServiceRoleForAPIGateway").length, 1, "re-enable and restart reuse the account-global role");
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
