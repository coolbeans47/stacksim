import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiGatewayV2Client, GetApiCommand, GetIntegrationsCommand, GetRoutesCommand, GetTagsCommand } from "@aws-sdk/client-apigatewayv2";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import type { ProductionResourceProvider, ProviderContext } from "../src/cloudformation/providers/contract.js";
import { API_GATEWAY_V2_API_TYPE, API_GATEWAY_V2_INTEGRATION_TYPE, createApiGatewayV2CloudFormationProviders } from "../src/cloudformation/providers/apigateway-v2.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const identity: PrincipalContext = { accessKeyId: credentials.accessKeyId, principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };

function context(logicalId: string, operation = "lifecycle"): ProviderContext {
  return { accountId, region, partition: "aws", stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/dpg-v2/stack-id`, logicalId, operationId: `${logicalId}-${operation}`, resourceOperationId: `${logicalId}-${operation}-resource`, idempotencyKey: `${logicalId}-${operation}-key`, deadlineAt: Date.now() + 60_000, principal: { identity } };
}
function success(result: any): any { assert.equal(result.status, "SUCCESS", result.message); return result; }
const lambdaArn = `arn:aws:lambda:${region}:${accountId}:function:cfn-openapi`;
const definition = (paths: string[], title = "cfn-openapi") => ({ openapi: "3.0.1", info: { title }, servers: [{ url: "https://example.com/{basePath}", variables: { basePath: { default: "prod" } } }], paths: Object.fromEntries(paths.map(path => [path, { get: { "x-amazon-apigateway-integration": { type: "aws_proxy", httpMethod: "POST", uri: lambdaArn, payloadFormatVersion: "2.0" } } }])) });

test("DPG-20/DPG-11 AWS::ApiGatewayV2::Api imports Body/BodyS3Location with BasePath and FailOnWarnings, and AWS::ApiGatewayV2::Integration accepts the HTTP API service subtypes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-dpg-v2-cfn-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off" });
  let apig: ApiGatewayV2Client | undefined; let s3: S3Client | undefined; let iam: IAMClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; apig = new ApiGatewayV2Client({ endpoint, region, credentials }); s3 = new S3Client({ endpoint, region, credentials, forcePathStyle: true }); iam = new IAMClient({ endpoint, region, credentials });
    const providers = new Map<string, ProductionResourceProvider<any>>(createApiGatewayV2CloudFormationProviders(simulator.apigatewayv2, { resolveBodyS3Location: async location => (await simulator.s3.readObjectBytes(location.Bucket, location.Key, location.Version)).body }).map(provider => [provider.typeName, provider]));
    const apiProvider = providers.get(API_GATEWAY_V2_API_TYPE)!; const integrationProvider = providers.get(API_GATEWAY_V2_INTEGRATION_TYPE)!;
    assert.deepEqual(apiProvider.validate({ ProtocolType: "HTTP" }, context("Missing")).map(issue => issue.path), ["Properties.Name"]);
    assert.ok(apiProvider.validate({ Body: definition(["/a"]), BodyS3Location: { Bucket: "b", Key: "k" } }, context("Both")).some(issue => issue.path === "Properties.BodyS3Location"));
    assert.ok(apiProvider.validate({ Name: "x", ProtocolType: "HTTP", BasePath: "split" }, context("NoBody")).some(issue => issue.path === "Properties.BasePath"));
    assert.ok(apiProvider.validate({ Name: "ws", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action", Body: definition(["/a"]) }, context("Socket")).some(issue => issue.path === "Properties.Body"));
    assert.equal(apiProvider.validate({ ProtocolType: "HTTP", Target: "https://example.com", Name: "quick" }, context("Quick")).length, 0, "quick-create Target accepts HTTP URLs");

    const providerContext = context("ImportedApi"); const desired = apiProvider.canonicalize({ Body: definition(["/orders", "/orders/{id}"]), BasePath: "prepend", Description: "declared description", Tags: { owner: "cfn" } }, providerContext);
    assert.equal(apiProvider.plan(undefined, desired, providerContext).action, "CREATE");
    const created = success(await apiProvider.create(desired, providerContext)); const replayed = success(await apiProvider.create(desired, providerContext)); assert.equal(replayed.physicalId, created.physicalId);
    const apiId = created.physicalId; assert.equal(created.model.properties.Name, "cfn-openapi"); assert.equal(created.model.properties.Description, "declared description", "declared properties override the imported definition");
    assert.deepEqual((await apig.send(new GetRoutesCommand({ ApiId: apiId }))).Items!.map(route => route.RouteKey).sort(), ["GET /prod/orders", "GET /prod/orders/{id}"]);
    assert.deepEqual((await apig.send(new GetTagsCommand({ ResourceArn: `arn:aws:apigateway:${region}::/apis/${apiId}` }))).Tags, { owner: "cfn" });
    assert.deepEqual(success(await apiProvider.read(apiId, providerContext)).model.properties, created.model.properties);

    await s3.send(new CreateBucketCommand({ Bucket: "openapi-defs", CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3.send(new PutObjectCommand({ Bucket: "openapi-defs", Key: "api.yaml", Body: `openapi: 3.0.1\ninfo:\n  title: from-s3\npaths:\n  /health:\n    get:\n      x-amazon-apigateway-integration:\n        type: http_proxy\n        httpMethod: GET\n        uri: https://example.com/health\n        payloadFormatVersion: "1.0"\n` }));
    const updated = apiProvider.canonicalize({ BodyS3Location: { Bucket: "openapi-defs", Key: "api.yaml" }, Tags: { owner: "cfn" } }, providerContext);
    assert.equal(apiProvider.plan(desired, updated, providerContext).action, "UPDATE");
    const afterUpdate = success(await apiProvider.update(apiId, desired, updated, providerContext)); assert.equal(afterUpdate.model.properties.Name, "from-s3");
    assert.deepEqual((await apig.send(new GetRoutesCommand({ ApiId: apiId }))).Items!.map(route => route.RouteKey), ["GET /health"]); assert.equal((await apig.send(new GetIntegrationsCommand({ ApiId: apiId }))).Items![0].IntegrationType, "HTTP_PROXY");
    const warnings = apiProvider.canonicalize({ Body: { openapi: "3.0.1", info: { title: "warned" }, paths: { "/x": { get: { "x-amazon-apigateway-integration": { type: "mock" } } } } }, FailOnWarnings: true }, context("Warned"));
    const failed = await apiProvider.create(warnings, context("Warned")); assert.equal(failed.status, "FAILED"); assert.equal(failed.errorCode, "BadRequestException"); assert.match(failed.message, /Warnings found during import/);
    assert.equal((await apig.send(new GetApiCommand({ ApiId: apiId }))).Name, "from-s3");

    const http = success(await apiProvider.create(apiProvider.canonicalize({ Name: "services", ProtocolType: "HTTP" }, context("Services")), context("Services"))).physicalId;
    const role = (await iam.send(new CreateRoleCommand({ RoleName: "cfn-apig-service", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }))).Role!.Arn!;
    assert.ok(integrationProvider.validate({ ApiId: http, IntegrationType: "AWS_PROXY", IntegrationSubtype: "StepFunctions-StartSyncExecution", PayloadFormatVersion: "1.0", CredentialsArn: role, RequestParameters: { StateMachineArn: "arn" } }, context("Sync")).some(issue => /EXPRESS/.test(issue.message)));
    assert.ok(integrationProvider.validate({ ApiId: http, IntegrationType: "HTTP_PROXY", ConnectionType: "VPC_LINK", IntegrationUri: "https://example.com", PayloadFormatVersion: "1.0" }, context("Vpc")).some(issue => /VPC links for HTTP APIs are not supported by StackSim/.test(issue.message)));
    for (const [logicalId, subtype, parameters] of [
      ["Events", "EventBridge-PutEvents", { Source: "orders", DetailType: "Created", Detail: "$request.body" }],
      ["Start", "StepFunctions-StartExecution", { StateMachineArn: `arn:aws:states:${region}:${accountId}:stateMachine:m`, Input: "$request.body" }],
      ["Stop", "StepFunctions-StopExecution", { ExecutionArn: "$request.body.executionArn" }],
      ["Receive", "SQS-ReceiveMessage", { QueueUrl: "https://sqs/queue" }],
      ["Delete", "SQS-DeleteMessage", { QueueUrl: "https://sqs/queue", ReceiptHandle: "$request.querystring.receipt" }],
      ["Purge", "SQS-PurgeQueue", { QueueUrl: "https://sqs/queue" }],
    ] as const) {
      const integrationContext = context(logicalId); const model = integrationProvider.canonicalize({ ApiId: http, IntegrationType: "AWS_PROXY", IntegrationSubtype: subtype, PayloadFormatVersion: "1.0", CredentialsArn: role, RequestParameters: parameters }, integrationContext);
      const result = success(await integrationProvider.create(model, integrationContext)); assert.equal(result.model.properties.IntegrationSubtype, subtype); assert.deepEqual(result.model.properties.RequestParameters, Object.fromEntries(Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b))));
    }
    const missing = await integrationProvider.create(integrationProvider.canonicalize({ ApiId: http, IntegrationType: "AWS_PROXY", IntegrationSubtype: "EventBridge-PutEvents", PayloadFormatVersion: "1.0", CredentialsArn: role, RequestParameters: { Source: "orders" } }, context("Missing")), context("Missing"));
    assert.equal(missing.status, "FAILED"); assert.match(missing.message, /requires request parameter Detail/);
  } finally { apig?.destroy(); s3?.destroy(); iam?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true }); }
});
