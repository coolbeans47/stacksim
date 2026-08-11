import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  CreateRestApiCommand,
  GetResourcesCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
  UpdateAccountCommand,
  UpdateStageCommand,
} from "@aws-sdk/client-api-gateway";
import { AddPermissionCommand, CreateFunctionCommand, InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CloudWatchLogsClient, CreateLogGroupCommand, DescribeLogStreamsCommand, FilterLogEventsCommand, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { StackSim } from "../src/server.js";
import { createZip } from "../src/core/zip-create.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const account = "000000000000";
const lambdaTrust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
const gatewayTrust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "sts:AssumeRole" }] });
const policy = (actions: string[]) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: actions, Resource: "*" }] });
const correlation = (message: string | undefined) => JSON.parse(String(message).split("\n")[0].replace(/^STACKSIM-SERVICE-CORRELATION /, ""));

test("API Gateway and Lambda emit SDK-retrievable service logs with shared correlation fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cw02-correlation-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true }); const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }; const iam = new IAMClient(options); const lambda = new LambdaClient(options); const gateway = new APIGatewayClient(options); const logs = new CloudWatchLogsClient(options); clients.push(iam, lambda, gateway, logs);
    const lambdaRole = await iam.send(new CreateRoleCommand({ RoleName: "cw02-lambda", AssumeRolePolicyDocument: lambdaTrust })); await iam.send(new PutRolePolicyCommand({ RoleName: "cw02-lambda", PolicyName: "logs", PolicyDocument: policy(["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]) }));
    const gatewayRole = await iam.send(new CreateRoleCommand({ RoleName: "cw02-gateway", AssumeRolePolicyDocument: gatewayTrust })); await iam.send(new PutRolePolicyCommand({ RoleName: "cw02-gateway", PolicyName: "logs", PolicyDocument: policy(["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]) })); await gateway.send(new UpdateAccountCommand({ patchOperations: [{ op: "replace", path: "/cloudwatchRoleArn", value: gatewayRole.Role!.Arn! }] }));
    const zip = createZip([{ name: "index.mjs", content: 'export async function handler(event) { console.log(JSON.stringify({ apiRequestId: event.requestContext.requestId })); return { statusCode: 200, body: JSON.stringify({ ok: true }) }; }' }]);
    const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "cw02-handler", Runtime: "nodejs22.x", Role: lambdaRole.Role!.Arn!, Handler: "index.handler", Code: { ZipFile: zip } }));
    const api = await gateway.send(new CreateRestApiCommand({ name: "cw02-api" })); await lambda.send(new AddPermissionCommand({ FunctionName: "cw02-handler", StatementId: "gateway", Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com", SourceArn: `arn:aws:execute-api:${region}:${account}:${api.id}/*/*/*`, SourceAccount: account }));
    const resource = (await gateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(item => item.path === "/")!; await gateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", authorizationType: "NONE" })); await gateway.send(new PutMethodResponseCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", statusCode: "200" })); await gateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", type: "AWS_PROXY", integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${fn.FunctionArn}/invocations` })); await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", statusCode: "200" })); await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
    await logs.send(new CreateLogGroupCommand({ logGroupName: "/learning/cw02-access" })); await gateway.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [
      { op: "replace", path: "/*/*/logging/loglevel", value: "INFO" },
      { op: "replace", path: "/accessLogSettings/destinationArn", value: `arn:aws:logs:${region}:${account}:log-group:/learning/cw02-access` },
      { op: "replace", path: "/accessLogSettings/format", value: '{"requestId":"$context.requestId","extendedRequestId":"$context.extendedRequestId","apiId":"$context.apiId","stage":"$context.stage","lambdaRequestId":"$context.integration.requestId","time":"$context.requestTimeEpoch"}' },
    ] }));
    const response = await fetch(`http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/`); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true }); const apiRequestId = response.headers.get("x-amzn-requestid"); const extendedRequestId = response.headers.get("x-amz-apigw-id"); assert.ok(apiRequestId && extendedRequestId);
    const execution = await logs.send(new FilterLogEventsCommand({ logGroupName: `API-Gateway-Execution-Logs_${api.id}/dev` })); const apiFields = correlation(execution.events?.[0].message); assert.deepEqual({ apiGatewayRequestId: apiFields.apiGatewayRequestId, apiGatewayExtendedRequestId: apiFields.apiGatewayExtendedRequestId, apiId: apiFields.apiId, stage: apiFields.stage, functionName: apiFields.functionName }, { apiGatewayRequestId: apiRequestId, apiGatewayExtendedRequestId: extendedRequestId, apiId: api.id, stage: "dev", functionName: "cw02-handler" }); assert.match(apiFields.timestamp, /^2026-|^20\d\d-/); assert.ok(apiFields.lambdaRequestId);
    const functionEvents = await logs.send(new FilterLogEventsCommand({ logGroupName: "/aws/lambda/cw02-handler", filterPattern: apiRequestId! })); const lambdaFields = correlation(functionEvents.events?.find(event => event.message?.startsWith("STACKSIM-SERVICE-CORRELATION"))?.message); assert.equal(lambdaFields.lambdaRequestId, apiFields.lambdaRequestId); assert.equal(lambdaFields.apiGatewayRequestId, apiRequestId); assert.equal(lambdaFields.apiGatewayExtendedRequestId, extendedRequestId); assert.equal(lambdaFields.functionName, "cw02-handler");
    const access = await logs.send(new FilterLogEventsCommand({ logGroupName: "/learning/cw02-access" })); assert.deepEqual(JSON.parse(access.events?.[0].message ?? "{}"), { requestId: apiRequestId, extendedRequestId, apiId: api.id, stage: "dev", lambdaRequestId: apiFields.lambdaRequestId, time: String(Number(JSON.parse(access.events?.[0].message ?? "{}").time)) });
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("service log delivery evaluates create and put permissions independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cw02-permissions-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true }); const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }; const iam = new IAMClient(options); const lambda = new LambdaClient(options); const logs = new CloudWatchLogsClient(options); clients.push(iam, lambda, logs); const role = await iam.send(new CreateRoleCommand({ RoleName: "cw02-granular", AssumeRolePolicyDocument: lambdaTrust }));
    await iam.send(new PutRolePolicyCommand({ RoleName: "cw02-granular", PolicyName: "logs", PolicyDocument: policy(["logs:CreateLogStream", "logs:PutLogEvents"]) })); const zip = createZip([{ name: "index.mjs", content: "export async function handler() { console.log('delivered'); return { ok: true }; }" }]); await lambda.send(new CreateFunctionCommand({ FunctionName: "cw02-granular", Runtime: "nodejs22.x", Role: role.Role!.Arn!, Handler: "index.handler", Code: { ZipFile: zip }, LoggingConfig: { LogGroup: "/learning/cw02-granular", LogFormat: "Text" } }));
    await lambda.send(new InvokeCommand({ FunctionName: "cw02-granular", Payload: Buffer.from("{}") })); await assert.rejects(logs.send(new DescribeLogStreamsCommand({ logGroupName: "/learning/cw02-granular" })), (error: any) => error.name === "ResourceNotFoundException");
    await logs.send(new CreateLogGroupCommand({ logGroupName: "/learning/cw02-granular" })); await lambda.send(new InvokeCommand({ FunctionName: "cw02-granular", Payload: Buffer.from("{}") })); const delivered = await logs.send(new DescribeLogStreamsCommand({ logGroupName: "/learning/cw02-granular" })); assert.equal(delivered.logStreams?.length, 1); assert.match(delivered.logStreams![0].logStreamName!, /^\d{4}\/\d{2}\/\d{2}\/cw02-granular\[\$LATEST\]/); assert.match((await logs.send(new GetLogEventsCommand({ logGroupName: "/learning/cw02-granular", logStreamName: delivered.logStreams![0].logStreamName!, startFromHead: true }))).events?.map(event => event.message).join("\n") ?? "", /delivered/);
    await iam.send(new PutRolePolicyCommand({ RoleName: "cw02-granular", PolicyName: "logs", PolicyDocument: policy(["logs:CreateLogStream"]) })); await (simulator.lambda as any).workerPool.retireFunctionVersion("cw02-granular", "$LATEST"); await lambda.send(new InvokeCommand({ FunctionName: "cw02-granular", Payload: Buffer.from("{}") })); const denied = await logs.send(new DescribeLogStreamsCommand({ logGroupName: "/learning/cw02-granular", orderBy: "LastEventTime", descending: true })); assert.equal(denied.logStreams?.length, 2); const empty = denied.logStreams!.find(stream => stream.storedBytes === 0)!; assert.deepEqual((await logs.send(new GetLogEventsCommand({ logGroupName: "/learning/cw02-granular", logStreamName: empty.logStreamName!, startFromHead: true }))).events, []);
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
