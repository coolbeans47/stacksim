import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APIGatewayClient, GetAccountCommand, GetApiKeyCommand, GetApiKeysCommand, GetAuthorizerCommand, GetDeploymentCommand, GetDeploymentsCommand, GetGatewayResponseCommand, GetMethodCommand, GetModelCommand,
  GetRequestValidatorCommand, GetResourcesCommand, GetRestApiCommand, GetRestApisCommand, GetStageCommand, GetTagsCommand, GetUsagePlanCommand, GetUsagePlanKeyCommand,
  TagResourceCommand, UntagResourceCommand, UpdateRestApiCommand,
} from "@aws-sdk/client-api-gateway";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStackResourceCommand, DescribeStacksCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import { AddPermissionCommand, CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { AwsError } from "../src/errors.js";
import {
  API_GATEWAY_ACCOUNT_TYPE,
  API_GATEWAY_API_KEY_TYPE,
  API_GATEWAY_AUTHORIZER_TYPE,
  API_GATEWAY_DEPLOYMENT_TYPE,
  API_GATEWAY_GATEWAY_RESPONSE_TYPE,
  API_GATEWAY_METHOD_TYPE,
  API_GATEWAY_MODEL_TYPE,
  API_GATEWAY_REQUEST_VALIDATOR_TYPE,
  API_GATEWAY_RESOURCE_TYPE,
  API_GATEWAY_REST_API_TYPE,
  API_GATEWAY_STAGE_TYPE,
  API_GATEWAY_USAGE_PLAN_KEY_TYPE,
  API_GATEWAY_USAGE_PLAN_TYPE,
  createApiGatewayRestCloudFormationProviders,
  type ApiGatewayDeploymentModel,
  type ApiGatewayMethodModel,
  type ApiGatewayResourceModel,
  type ApiGatewayRestApiModel,
  type ApiGatewayStageModel,
} from "../src/cloudformation/providers/apigateway-rest.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const accountId = "000000000000";
const identity: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };

function context(logicalId: string, operation = logicalId): ProviderContext {
  return {
    accountId, region, partition: "aws", stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/apig-provider/stack-id`, logicalId,
    operationId: `operation-${operation}`, resourceOperationId: `resource-${operation}`, idempotencyKey: `idempotency-${operation}`,
    deadlineAt: Date.now() + 60_000, principal: { identity },
  };
}

function requireSuccess(result: any): any {
  assert.equal(result.status, "SUCCESS", result.message); return result;
}

async function completeProviderCallbacks(invoke: (callbackContext: ProviderContext) => Promise<any>, initialContext: ProviderContext): Promise<any> {
  let callbackContext = initialContext;
  for (let attempt = 0; attempt < 32; attempt++) {
    const result = await invoke(callbackContext);
    if (result.status !== "IN_PROGRESS") return result;
    assert.equal(result.callbackAfterMs, 25);
    const durable = JSON.parse(JSON.stringify(result.checkpoint.callbackContext));
    assert.deepEqual(durable, result.checkpoint.callbackContext, "callbackContext must remain JSON-stable");
    callbackContext = { ...initialContext, callbackContext: durable };
  }
  assert.fail("Provider did not complete within 32 callbacks");
}

async function waitForStackStatus(cloudformation: CloudFormationClient, stackName: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const status = (await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus;
    if (status === expected) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

function restApiRollbackTemplate(version: "old" | "new", failAfterUpdate = false): string {
  const path = `/${version}`;
  return JSON.stringify({ Resources: {
    Api: {
      Type: "AWS::ApiGateway::RestApi",
      Properties: {
        Name: "rest-api-rollback",
        Description: `${version} description`,
        Mode: "overwrite",
        Body: { openapi: "3.0.1", info: { title: `${version} source`, version: version === "old" ? "1" : "2" }, paths: { [path]: {} } },
        Tags: [{ Key: "version", Value: version }, ...(version === "old" ? [{ Key: "restored", Value: "true" }] : [{ Key: "temporary", Value: "true" }])],
      },
    },
    ...(failAfterUpdate ? {
      FailureResource: {
        Type: "AWS::ApiGateway::Resource",
        DependsOn: "Api",
        Properties: { RestApiId: { Ref: "Api" }, ParentId: "missing-parent", PathPart: "fail" },
      },
    } : {}),
  } });
}

function requireMethodProgress(result: any, operation: "CREATE" | "UPDATE" | "DELETE", phase: string, index = 0): Record<string, any> {
  assert.equal(result.status, "IN_PROGRESS", result.message);
  assert.equal(result.callbackAfterMs, 25);
  assert.deepEqual(result.checkpoint.callbackContext, { stateMachine: "apigateway-method-v1", operation, phase, index });
  return JSON.parse(JSON.stringify(result.checkpoint.callbackContext));
}

function requireRestApiProgress(result: any, operation: "CREATE" | "UPDATE" | "DELETE", phase: string, apiId?: string): Record<string, any> {
  assert.equal(result.status, "IN_PROGRESS", result.message);
  assert.equal(result.callbackAfterMs, 25);
  const actualApiId = apiId ?? result.checkpoint.callbackContext.apiId;
  assert.equal(typeof actualApiId, "string");
  const { marker, failure, ...base } = result.checkpoint.callbackContext;
  assert.deepEqual(base, { stateMachine: "apigateway-rest-api-v1", operation, phase, apiId: actualApiId });
  if (operation === "CREATE" || marker !== undefined) assert.match(marker, /^stacksim-cfn:[a-f0-9]{24}:[a-f0-9]{32}$/);
  if (phase.startsWith("cleanup-")) assert.deepEqual(failure, { errorCode: "BadRequestException", message: "injected permanent settings failure" });
  else assert.equal(failure, undefined);
  assert.equal(result.checkpoint.physicalId, actualApiId);
  return JSON.parse(JSON.stringify(result.checkpoint.callbackContext));
}

function providerByType(simulator: StackSim): Record<string, any> {
  return Object.fromEntries(createApiGatewayRestCloudFormationProviders(simulator.apigateway).map(provider => [provider.typeName, provider]));
}

async function createProxyFunction(lambda: LambdaClient, name: string, version: string): Promise<string> {
  const zip = createZip([{ name: "index.js", content: `exports.handler = async event => ({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ version: ${JSON.stringify(version)}, path: event.path }) });` }]);
  const result = await lambda.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Handler: "index.handler", Role: `arn:aws:iam::${accountId}:role/test`, Code: { ZipFile: zip } }));
  return result.FunctionArn!;
}

test("API Gateway REST providers create, update, deploy, invoke, read, and delete a Lambda proxy", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-provider-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
  let apiClient: APIGatewayClient | undefined; let lambda: LambdaClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`;
    apiClient = new APIGatewayClient({ endpoint, region, credentials }); lambda = new LambdaClient({ endpoint, region, credentials });
    const firstArn = await createProxyFunction(lambda, "cfn-api-first", "one"); const secondArn = await createProxyFunction(lambda, "cfn-api-second", "two");
    const providers = providerByType(simulator); const restProvider = providers[API_GATEWAY_REST_API_TYPE]; const resourceProvider = providers[API_GATEWAY_RESOURCE_TYPE]; const methodProvider = providers[API_GATEWAY_METHOD_TYPE]; const deploymentProvider = providers[API_GATEWAY_DEPLOYMENT_TYPE]; const stageProvider = providers[API_GATEWAY_STAGE_TYPE];

    assert.deepEqual(restProvider.schema.tags, { behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true });
    const rest: ApiGatewayRestApiModel = restProvider.canonicalize({ Name: "provider-api", Description: "provider lifecycle", EndpointConfiguration: { Types: ["REGIONAL"] }, Tags: [{ Key: "team", Value: "platform" }] }, context("Api"));
    const restCreateContext = context("Api", "ApiCreate");
    const restResult = requireSuccess(await completeProviderCallbacks(callback => restProvider.create(rest, callback), restCreateContext)); const apiId = String(restResult.model.attributes.RestApiId); const rootId = String(restResult.model.attributes.RootResourceId);
    const apiArn = `arn:aws:apigateway:${region}::/restapis/${apiId}`;
    assert.deepEqual((await apiClient.send(new GetRestApiCommand({ restApiId: apiId }))).tags, { team: "platform" });
    assert.deepEqual((await apiClient.send(new GetTagsCommand({ resourceArn: apiArn }))).tags, { team: "platform" });
    await apiClient.send(new TagResourceCommand({ resourceArn: apiArn, tags: { owner: "direct-service" } }));
    assert.deepEqual((await restProvider.read(apiId, context("Api"))).model.properties.Tags, [{ Key: "owner", Value: "direct-service" }, { Key: "team", Value: "platform" }]);
    await apiClient.send(new UntagResourceCommand({ resourceArn: apiArn, tagKeys: ["owner"] }));
    const updatedRest: ApiGatewayRestApiModel = restProvider.canonicalize({ ...rest, Description: "provider lifecycle updated", Tags: [{ Key: "environment", Value: "local" }, { Key: "team", Value: "services" }] }, context("Api"));
    assert.equal(restProvider.plan(rest, updatedRest, context("Api")).action, "UPDATE");
    const restUpdateContext = context("Api", "ApiUpdate");
    requireSuccess(await completeProviderCallbacks(callback => restProvider.update(apiId, rest, updatedRest, callback), restUpdateContext));
    assert.deepEqual((await apiClient.send(new GetRestApiCommand({ restApiId: apiId }))).tags, { environment: "local", team: "services" });
    await lambda.send(new AddPermissionCommand({ FunctionName: "cfn-api-first", StatementId: "gateway", Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com", SourceArn: `arn:aws:execute-api:${region}:${accountId}:${apiId}/*/*/*` }));
    await lambda.send(new AddPermissionCommand({ FunctionName: "cfn-api-second", StatementId: "gateway", Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com", SourceArn: `arn:aws:execute-api:${region}:${accountId}:${apiId}/*/*/*` }));

    const resource: ApiGatewayResourceModel = resourceProvider.canonicalize({ RestApiId: apiId, ParentId: rootId, PathPart: "graphql" }, context("GraphqlResource"));
    const resourceResult = requireSuccess(await resourceProvider.create(resource, context("GraphqlResource"))); const resourceId = String(resourceResult.model.attributes.ResourceId);
    const lambdaUri = (arn: string) => `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${arn}/invocations`;
    const method: ApiGatewayMethodModel = methodProvider.canonicalize({ RestApiId: apiId, ResourceId: resourceId, HttpMethod: "POST", AuthorizationType: "NONE", Integration: { Type: "AWS_PROXY", IntegrationHttpMethod: "POST", Uri: lambdaUri(firstArn) } }, context("GraphqlMethod"));
    const methodCreateContext = context("GraphqlMethod");
    const methodResult = requireSuccess(await completeProviderCallbacks(callback => methodProvider.create(method, callback), methodCreateContext));
    const methodRef = methodProvider.ref(methodResult.model); assert.match(methodRef, /^[a-f0-9]{16}$/); assert.notEqual(methodRef, methodResult.physicalId);
    assert.equal((await apiClient.send(new GetMethodCommand({ restApiId: apiId, resourceId, httpMethod: "POST" }))).methodIntegration?.uri, lambdaUri(firstArn));

    const firstDeployment: ApiGatewayDeploymentModel = deploymentProvider.canonicalize({ RestApiId: apiId, Description: "first snapshot" }, context("DeploymentOne"));
    const firstDeploymentContext = context("DeploymentOne", "DeploymentOneCreate"); const firstDeploymentResult = requireSuccess(await completeProviderCallbacks(callback => deploymentProvider.create(firstDeployment, callback), firstDeploymentContext)); const firstDeploymentId = String(firstDeploymentResult.model.attributes.DeploymentId);
    const changedDeployment = deploymentProvider.canonicalize({ RestApiId: apiId, Description: "must replace" }, context("DeploymentOne"));
    const immutableUpdate = await deploymentProvider.update(firstDeploymentResult.physicalId, firstDeployment, changedDeployment, context("DeploymentOne"));
    assert.equal(immutableUpdate.status, "FAILED"); assert.equal(immutableUpdate.errorCode, "RequiresReplacement");
    assert.equal((await apiClient.send(new GetDeploymentCommand({ restApiId: apiId, deploymentId: firstDeploymentId }))).description, "first snapshot");
    const stage: ApiGatewayStageModel = stageProvider.canonicalize({ RestApiId: apiId, DeploymentId: firstDeploymentId, StageName: "dev", Variables: { environment: "local" }, MethodSettings: [{ ResourcePath: "/*", HttpMethod: "*", MetricsEnabled: true }], Tags: [{ Key: "team", Value: "platform" }] }, context("Stage"));
    const stageResult = requireSuccess(await stageProvider.create(stage, context("Stage")));
    assert.equal((await apiClient.send(new GetStageCommand({ restApiId: apiId, stageName: "dev" }))).methodSettings?.["*/*"]?.metricsEnabled, true);
    let response = await fetch(`http://127.0.0.1:${simulator.invokePort}/${apiId}/dev/graphql`, { method: "POST", body: JSON.stringify({ query: "{ health }" }), headers: { "content-type": "application/json" } });
    const firstPayload = await response.json(); assert.equal(response.status, 200, JSON.stringify(firstPayload)); assert.deepEqual(firstPayload, { version: "one", path: "/graphql" });

    const updatedMethod: ApiGatewayMethodModel = methodProvider.canonicalize({ RestApiId: apiId, ResourceId: resourceId, HttpMethod: "POST", AuthorizationType: "NONE", OperationName: "graphqlV2", Integration: { Type: "AWS_PROXY", IntegrationHttpMethod: "POST", Uri: lambdaUri(secondArn) } }, context("GraphqlMethod"));
    assert.equal(methodProvider.plan(method, updatedMethod, context("GraphqlMethod")).action, "UPDATE");
    const methodUpdateContext = context("GraphqlMethod");
    requireSuccess(await completeProviderCallbacks(callback => methodProvider.update(methodResult.physicalId, method, updatedMethod, callback), methodUpdateContext));
    const secondDeployment: ApiGatewayDeploymentModel = deploymentProvider.canonicalize({ RestApiId: apiId, Description: "second snapshot" }, context("DeploymentTwo"));
    const secondDeploymentContext = context("DeploymentTwo", "DeploymentTwoCreate"); const secondDeploymentResult = requireSuccess(await completeProviderCallbacks(callback => deploymentProvider.create(secondDeployment, callback), secondDeploymentContext)); const secondDeploymentId = String(secondDeploymentResult.model.attributes.DeploymentId);
    const updatedStage: ApiGatewayStageModel = stageProvider.canonicalize({ ...stage, DeploymentId: secondDeploymentId, Variables: { environment: "updated" }, MethodSettings: [{ ResourcePath: "/*", HttpMethod: "*", MetricsEnabled: false }], Tags: [{ Key: "team", Value: "services" }] }, context("Stage"));
    requireSuccess(await stageProvider.update(stageResult.physicalId, stage, updatedStage, context("Stage")));
    response = await fetch(`http://127.0.0.1:${simulator.invokePort}/${apiId}/dev/graphql`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    const secondPayload = await response.json(); assert.equal(response.status, 200, JSON.stringify(secondPayload)); assert.deepEqual(secondPayload, { version: "two", path: "/graphql" });

    const readMethod = await methodProvider.read(methodResult.physicalId, context("GraphqlMethod")); assert.equal(readMethod.status, "SUCCESS"); assert.equal(methodProvider.ref(readMethod.model), methodRef);
    requireSuccess(await stageProvider.delete(stageResult.physicalId, updatedStage, context("Stage")));
    requireSuccess(await deploymentProvider.delete(secondDeploymentResult.physicalId, secondDeployment, context("DeploymentTwo")));
    requireSuccess(await deploymentProvider.delete(firstDeploymentResult.physicalId, firstDeployment, context("DeploymentOne")));
    const methodDeleteContext = context("GraphqlMethod");
    requireSuccess(await completeProviderCallbacks(callback => methodProvider.delete(methodResult.physicalId, updatedMethod, callback), methodDeleteContext));
    requireSuccess(await resourceProvider.delete(resourceResult.physicalId, resource, context("GraphqlResource")));
    const restDeleteContext = context("Api", "ApiDelete");
    requireSuccess(await completeProviderCallbacks(callback => restProvider.delete(restResult.physicalId, updatedRest, callback), restDeleteContext));
    assert.equal((await restProvider.read(restResult.physicalId, context("Api"))).status, "NOT_FOUND");
    await assert.rejects(apiClient.send(new GetTagsCommand({ resourceArn: apiArn })), (error: any) => error.name === "NotFoundException");
    assert.equal((await methodProvider.read(methodResult.physicalId, context("GraphqlMethod"))).status, "NOT_FOUND");
  } finally {
    apiClient?.destroy(); lambda?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true });
  }
});

test("API Gateway Method validation rejects unsafe integrations before mutation and reports missing Lambda permission at invocation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-method-validation-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "enforce", cdkBootstrap: true });
  let apiClient: APIGatewayClient | undefined; let lambda: LambdaClient | undefined; let iam: IAMClient | undefined;
  const previousOutbound = process.env.STACKSIM_ALLOW_OUTBOUND_HTTP; const previousPrivate = process.env.STACKSIM_ALLOW_PRIVATE_HTTP;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`;
    apiClient = new APIGatewayClient({ endpoint, region, credentials }); lambda = new LambdaClient({ endpoint, region, credentials }); iam = new IAMClient({ endpoint, region, credentials });
    const functionArn = await createProxyFunction(lambda, "cfn-api-validation", "validation");
    const providers = providerByType(simulator); const restProvider = providers[API_GATEWAY_REST_API_TYPE]; const resourceProvider = providers[API_GATEWAY_RESOURCE_TYPE]; const methodProvider = providers[API_GATEWAY_METHOD_TYPE]; const deploymentProvider = providers[API_GATEWAY_DEPLOYMENT_TYPE]; const stageProvider = providers[API_GATEWAY_STAGE_TYPE];
    const rest = restProvider.canonicalize({ Name: "integration-validation" }, context("ValidationApi"));
    const restResult = requireSuccess(await completeProviderCallbacks(callback => restProvider.create(rest, callback), context("ValidationApi", "ValidationApiCreate")));
    const apiId = String(restResult.model.attributes.RestApiId); const rootId = String(restResult.model.attributes.RootResourceId);
    const resource = resourceProvider.canonicalize({ RestApiId: apiId, ParentId: rootId, PathPart: "check" }, context("ValidationResource"));
    const resourceResult = requireSuccess(await resourceProvider.create(resource, context("ValidationResource"))); const resourceId = String(resourceResult.model.attributes.ResourceId);
    const lambdaUri = `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${functionArn}/invocations`;
    const base = { RestApiId: apiId, ResourceId: resourceId, HttpMethod: "GET", AuthorizationType: "NONE" };

    const lambdaMethodProperties = { ...base, Integration: { Type: "AWS_PROXY", IntegrationHttpMethod: "POST", Uri: lambdaUri } };
    assert.deepEqual(methodProvider.validate(lambdaMethodProperties, context("ValidationMethod")), [], "AWS permits creating the method before its Lambda permission resource");

    const invalidTrust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
    const invalidRoleArn = (await iam.send(new CreateRoleCommand({ RoleName: "invalid-api-integration-role", AssumeRolePolicyDocument: invalidTrust }))).Role!.Arn!;
    let issues = methodProvider.validate({ ...base, Integration: { Type: "AWS_PROXY", IntegrationHttpMethod: "POST", Uri: lambdaUri, Credentials: invalidRoleArn } }, context("ValidationMethod"));
    assert.match(issues.map((entry: any) => entry.message).join("\n"), /cannot assume the configured integration role/);

    issues = methodProvider.validate({ ...base, Integration: { Type: "AWS", IntegrationHttpMethod: "POST", Uri: `arn:aws:apigateway:${region}:sns:action/Publish`, Credentials: invalidRoleArn } }, context("ValidationMethod"));
    assert.match(issues.map((entry: any) => entry.message).join("\n"), /support only local Lambda, DynamoDB, and SQS targets/);

    process.env.STACKSIM_ALLOW_OUTBOUND_HTTP = "true"; delete process.env.STACKSIM_ALLOW_PRIVATE_HTTP;
    issues = methodProvider.validate({ ...base, Integration: { Type: "HTTP_PROXY", IntegrationHttpMethod: "GET", Uri: "http://169.254.169.254/latest/meta-data" } }, context("ValidationMethod"));
    assert.match(issues.map((entry: any) => entry.message).join("\n"), /Private and metadata HTTP integration targets are blocked/);
    assert.deepEqual(methodProvider.validate({ ...base, Integration: { Type: "HTTP_PROXY", IntegrationHttpMethod: "GET", Uri: "https://example.com/health" } }, context("ValidationMethod")), []);

    await assert.rejects(apiClient.send(new GetMethodCommand({ restApiId: apiId, resourceId, httpMethod: "GET" })), (error: any) => error.name === "NotFoundException");
    const method = methodProvider.canonicalize(lambdaMethodProperties, context("ValidationMethod"));
    await completeProviderCallbacks(callback => methodProvider.create(method, callback), context("ValidationMethod", "ValidationMethodCreate"));
    const deployment = deploymentProvider.canonicalize({ RestApiId: apiId }, context("ValidationDeployment"));
    const deploymentResult = requireSuccess(await completeProviderCallbacks(callback => deploymentProvider.create(deployment, callback), context("ValidationDeployment", "ValidationDeploymentCreate")));
    const stage = stageProvider.canonicalize({ RestApiId: apiId, DeploymentId: String(deploymentResult.model.attributes.DeploymentId), StageName: "dev" }, context("ValidationStage"));
    requireSuccess(await stageProvider.create(stage, context("ValidationStage")));
    const invokeUrl = `http://127.0.0.1:${simulator.invokePort}/${apiId}/dev/check`;
    const denied = await fetch(invokeUrl);
    assert.equal(denied.status, 403); assert.match(await denied.text(), /not authorized to invoke this Lambda function/);
    await lambda.send(new AddPermissionCommand({ FunctionName: "cfn-api-validation", StatementId: "gateway-validation", Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com", SourceArn: `arn:aws:execute-api:${region}:${accountId}:${apiId}/*/GET/check` }));
    const allowed = await fetch(invokeUrl); assert.equal(allowed.status, 200); assert.deepEqual(await allowed.json(), { version: "validation", path: "/check" });
  } finally {
    if (previousOutbound === undefined) delete process.env.STACKSIM_ALLOW_OUTBOUND_HTTP; else process.env.STACKSIM_ALLOW_OUTBOUND_HTTP = previousOutbound;
    if (previousPrivate === undefined) delete process.env.STACKSIM_ALLOW_PRIVATE_HTTP; else process.env.STACKSIM_ALLOW_PRIVATE_HTTP = previousPrivate;
    apiClient?.destroy(); lambda?.destroy(); iam?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true });
  }
});

test("API Gateway Method provider durably checkpoints composite mutations and resumes after restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-method-checkpoints-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
  const mutations: string[] = [];
  const tracedMethodProvider = (active: StackSim): any => {
    const tracedService = {
      handle: (req: any, res: any, pathname: string, url: URL) => {
        if (req.method !== "GET") mutations.push(`${req.method} ${pathname}`);
        return active.apigateway.handle(req, res, pathname, url);
      },
    } as any;
    return createApiGatewayRestCloudFormationProviders(tracedService).find(provider => provider.typeName === API_GATEWAY_METHOD_TYPE)!;
  };
  try {
    await simulator.start();
    const setup = providerByType(simulator); const restProvider = setup[API_GATEWAY_REST_API_TYPE]; const resourceProvider = setup[API_GATEWAY_RESOURCE_TYPE];
    const rest = restProvider.canonicalize({ Name: "checkpoint-api" }, context("CheckpointApi")); const restCreateContext = context("CheckpointApi", "CheckpointApiCreate"); const restResult = requireSuccess(await completeProviderCallbacks(callback => restProvider.create(rest, callback), restCreateContext)); const apiId = String(restResult.model.attributes.RestApiId); const rootId = String(restResult.model.attributes.RootResourceId);
    const resource = resourceProvider.canonicalize({ RestApiId: apiId, ParentId: rootId, PathPart: "durable" }, context("CheckpointResource")); const resourceResult = requireSuccess(await resourceProvider.create(resource, context("CheckpointResource"))); const resourceId = String(resourceResult.model.attributes.ResourceId);
    let methodProvider = tracedMethodProvider(simulator); const operationContext = context("CheckpointMethod");
    const desired: ApiGatewayMethodModel = methodProvider.canonicalize({
      RestApiId: apiId, ResourceId: resourceId, HttpMethod: "POST", AuthorizationType: "NONE", OperationName: "durable-v1",
      MethodResponses: [
        { StatusCode: "400", ResponseModels: { "application/json": "Error" } },
        { StatusCode: "200", ResponseModels: { "application/json": "Empty" } },
      ],
      Integration: {
        Type: "MOCK", RequestTemplates: { "application/json": "{\"statusCode\":200}" },
        IntegrationResponses: [
          { StatusCode: "400", SelectionPattern: "4\\d{2}", ResponseTemplates: { "application/json": "{\"error\":true}" } },
          { StatusCode: "200", ResponseTemplates: { "application/json": "{\"ok\":true}" } },
        ],
      },
    }, operationContext);
    const base = `/restapis/${apiId}/resources/${resourceId}/methods/POST`;

    let result = await methodProvider.create(desired, operationContext);
    let callback = requireMethodProgress(result, "CREATE", "put-integration");
    assert.deepEqual(mutations, [`PUT ${base}`], "PutMethod must be the only first mutation");

    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
    await simulator.start(); methodProvider = tracedMethodProvider(simulator);
    const integrationCallback = { ...operationContext, callbackContext: callback };
    result = await methodProvider.create(desired, integrationCallback);
    callback = requireMethodProgress(result, "CREATE", "put-method-response", 0);
    assert.deepEqual(mutations, [`PUT ${base}`, `PUT ${base}/integration`], "PutIntegration must resume from persisted state");

    const replay = await methodProvider.create(desired, integrationCallback);
    assert.deepEqual(requireMethodProgress(replay, "CREATE", "put-method-response", 0), callback);
    assert.deepEqual(mutations, [`PUT ${base}`, `PUT ${base}/integration`], "replaying a completed integration phase must not repeat its PUT");

    result = await methodProvider.create(desired, { ...operationContext, callbackContext: callback });
    callback = requireMethodProgress(result, "CREATE", "put-method-response", 1);
    assert.equal(mutations.at(-1), `PUT ${base}/responses/200`);
    result = await methodProvider.create(desired, { ...operationContext, callbackContext: callback });
    callback = requireMethodProgress(result, "CREATE", "put-integration-response", 0);
    assert.equal(mutations.at(-1), `PUT ${base}/responses/400`);
    result = await methodProvider.create(desired, { ...operationContext, callbackContext: callback });
    callback = requireMethodProgress(result, "CREATE", "put-integration-response", 1);
    assert.equal(mutations.at(-1), `PUT ${base}/integration/responses/200`);
    result = await methodProvider.create(desired, { ...operationContext, callbackContext: callback });
    callback = requireMethodProgress(result, "CREATE", "verify");
    assert.equal(mutations.at(-1), `PUT ${base}/integration/responses/400`);
    const created = requireSuccess(await methodProvider.create(desired, { ...operationContext, callbackContext: callback }));
    assert.match(methodProvider.ref(created.model), /^[a-f0-9]{16}$/);

    const updated: ApiGatewayMethodModel = methodProvider.canonicalize({ ...desired, OperationName: "durable-v2" }, operationContext);
    const updateStart = mutations.length;
    result = await methodProvider.update(created.physicalId, desired, updated, operationContext);
    callback = requireMethodProgress(result, "UPDATE", "put-method");
    assert.deepEqual(mutations.slice(updateStart), [`DELETE ${base}`], "update must durably checkpoint deletion before recreation");
    result = await methodProvider.update(created.physicalId, desired, updated, { ...operationContext, callbackContext: callback });
    callback = requireMethodProgress(result, "UPDATE", "put-integration"); assert.equal(mutations.at(-1), `PUT ${base}`);
    result = await methodProvider.update(created.physicalId, desired, updated, { ...operationContext, callbackContext: callback });
    callback = requireMethodProgress(result, "UPDATE", "put-method-response", 0); assert.equal(mutations.at(-1), `PUT ${base}/integration`);
    result = await methodProvider.update(created.physicalId, desired, updated, { ...operationContext, callbackContext: callback });
    callback = requireMethodProgress(result, "UPDATE", "put-method-response", 1); assert.equal(mutations.at(-1), `PUT ${base}/responses/200`);
    result = await methodProvider.update(created.physicalId, desired, updated, { ...operationContext, callbackContext: callback });
    callback = requireMethodProgress(result, "UPDATE", "put-integration-response", 0); assert.equal(mutations.at(-1), `PUT ${base}/responses/400`);
    result = await methodProvider.update(created.physicalId, desired, updated, { ...operationContext, callbackContext: callback });
    callback = requireMethodProgress(result, "UPDATE", "put-integration-response", 1); assert.equal(mutations.at(-1), `PUT ${base}/integration/responses/200`);
    result = await methodProvider.update(created.physicalId, desired, updated, { ...operationContext, callbackContext: callback });
    callback = requireMethodProgress(result, "UPDATE", "verify"); assert.equal(mutations.at(-1), `PUT ${base}/integration/responses/400`);
    requireSuccess(await methodProvider.update(created.physicalId, desired, updated, { ...operationContext, callbackContext: callback }));

    const deleteStart = mutations.length;
    result = await methodProvider.delete(created.physicalId, updated, operationContext);
    callback = requireMethodProgress(result, "DELETE", "verify");
    assert.deepEqual(mutations.slice(deleteStart), [`DELETE ${base}`], "delete must checkpoint before reporting completion");
    requireSuccess(await methodProvider.delete(created.physicalId, updated, { ...operationContext, callbackContext: callback }));
    assert.deepEqual(mutations.slice(deleteStart), [`DELETE ${base}`], "delete verification must be read-only");
  } finally { await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true }); }
});

test("API Gateway Deployment provider adopts the authoritative deployment after its create response is lost", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-deployment-crash-")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
  let client: APIGatewayClient | undefined; let deploymentMutations = 0;
  const providerFor = (active: StackSim, injectLostResponse: boolean): any => {
    let injected = false;
    const service = {
      handle: async (req: any, res: any, pathname: string, url: URL) => {
        await active.apigateway.handle(req, res, pathname, url);
        if (req.method === "POST" && /\/restapis\/[^/]+\/deployments$/.test(pathname)) {
          deploymentMutations++;
          if (injectLostResponse && !injected) { injected = true; throw new AwsError("InternalFailure", "injected lost CreateDeployment response", 500); }
        }
      },
    } as any;
    return createApiGatewayRestCloudFormationProviders(service).find(provider => provider.typeName === API_GATEWAY_DEPLOYMENT_TYPE)!;
  };
  try {
    await simulator.start();
    const setup = providerByType(simulator); const restProvider = setup[API_GATEWAY_REST_API_TYPE]; const restContext = context("DeploymentCrashApi", "DeploymentCrashApiCreate");
    const rest = restProvider.canonicalize({ Name: "deployment-crash-api" }, restContext); const createdRest = requireSuccess(await completeProviderCallbacks(callback => restProvider.create(rest, callback), restContext)); const apiId = String(createdRest.model.attributes.RestApiId);
    let provider = providerFor(simulator, true); const operationContext = context("CrashDeployment", "CrashDeploymentCreate"); const desired: ApiGatewayDeploymentModel = provider.canonicalize({ RestApiId: apiId, Description: "snapshot exactly once" }, operationContext);
    const lost = await provider.create(desired, operationContext); assert.equal(lost.status, "FAILED"); assert.equal(lost.errorCode, "InternalFailure"); assert.equal(lost.retryable, true); assert.equal(deploymentMutations, 1);
    client = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }); assert.equal((await client.send(new GetDeploymentsCommand({ restApiId: apiId }))).items?.length, 1);

    client.destroy(); client = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"}); await simulator.start(); provider = providerFor(simulator, false);
    let result = await provider.create(desired, { ...operationContext, callbackContext: {} }); assert.equal(result.status, "IN_PROGRESS"); assert.equal(result.callbackAfterMs, 25); assert.deepEqual(Object.keys(result.checkpoint.callbackContext).sort(), ["apiId", "deploymentId", "stateMachine", "token"]); assert.equal(result.checkpoint.callbackContext.stateMachine, "apigateway-deployment-v1"); assert.match(result.checkpoint.callbackContext.token, /^[a-f0-9]{64}$/); assert.equal(deploymentMutations, 1, "retry after restart must list/adopt instead of creating a second deployment");
    const changed = provider.canonicalize({ RestApiId: apiId, Description: "different snapshot" }, operationContext); const conflict = await provider.create(changed, operationContext); assert.equal(conflict.status, "FAILED"); assert.equal(conflict.errorCode, "ConflictException"); assert.equal(deploymentMutations, 1);
    result = await provider.create(desired, { ...operationContext, callbackContext: result.checkpoint.callbackContext }); assert.equal(result.status, "SUCCESS"); assert.equal(deploymentMutations, 1);
    client = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }); const deploymentsOutput = await client.send(new GetDeploymentsCommand({ restApiId: apiId })); const deployments = deploymentsOutput.items ?? []; assert.equal(deployments.length, 1); assert.equal(deployments[0].id, result.model.attributes.DeploymentId); assert.equal(JSON.stringify(deploymentsOutput).includes("cloudFormationOperationToken"), false);
    assert.equal((await provider.delete(result.physicalId, desired, operationContext)).status, "SUCCESS");
    const cleanupRestProvider = providerByType(simulator)[API_GATEWAY_REST_API_TYPE]; const deleteContext = context("DeploymentCrashApi", "DeploymentCrashApiDelete"); requireSuccess(await completeProviderCallbacks(callback => cleanupRestProvider.delete(createdRest.physicalId, rest, callback), deleteContext));
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true }); }
});

test("API Gateway REST provider durably reconciles import, put, settings, tags, and deletion after lost callbacks", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-rest-checkpoints-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
  let client: APIGatewayClient | undefined;
  const mutations: string[] = [];
  let bodyS3Document: Record<string, any>;
  let failNextPatch = false;
  const openApi = (path: string, version: string) => ({
    openapi: "3.0.1",
    info: { title: `source-${version}`, version },
    paths: { [path]: {} },
  });
  const tracedProvider = (active: StackSim): any => {
    const tracedService = {
      handle: (req: any, res: any, pathname: string, url: URL) => {
        if (req.method !== "GET") mutations.push(`${req.method} ${pathname}${url.search}`);
        if (failNextPatch && req.method === "PATCH" && /^\/restapis\/[^/]+$/.test(pathname)) { failNextPatch = false; throw new AwsError("BadRequestException", "injected permanent settings failure", 400); }
        return active.apigateway.handle(req, res, pathname, url);
      },
    } as any;
    return createApiGatewayRestCloudFormationProviders(tracedService, {
      resolveBodyS3Location: async location => {
        assert.deepEqual(location, { Bucket: "assets", Key: "api.json", Version: "one" });
        return Buffer.from(JSON.stringify(bodyS3Document));
      },
    }).find(provider => provider.typeName === API_GATEWAY_REST_API_TYPE)!;
  };
  const invokeOne = async (invoke: () => Promise<any>): Promise<any> => {
    const before = mutations.length;
    const result = await invoke();
    assert.ok(mutations.length - before <= 1, `one callback performed ${mutations.length - before} API Gateway mutations`);
    return result;
  };
  try {
    await simulator.start();
    let provider = tracedProvider(simulator);
    bodyS3Document = openApi("/one", "1");
    const createContext = context("DurableRestApi", "DurableRestApiCreate");
    const desired: ApiGatewayRestApiModel = provider.canonicalize({
      Name: "durable-rest-api",
      Description: "created",
      BodyS3Location: { Bucket: "assets", Key: "api.json", Version: "one" },
      Mode: "overwrite",
      Tags: [{ Key: "change", Value: "old" }, { Key: "remove", Value: "old" }],
    }, createContext);

    let result = await invokeOne(() => provider.create(desired, createContext));
    let callback = requireRestApiProgress(result, "CREATE", "settings");
    const apiId = String(callback.apiId);
    assert.deepEqual(mutations, ["POST /restapis?mode=import"], "the import must be the only initial mutation");

    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
    await simulator.start(); provider = tracedProvider(simulator);
    bodyS3Document = openApi("/changed-after-import", "unexpected");
    const changedSource = await invokeOne(() => provider.create(desired, createContext));
    assert.equal(changedSource.status, "FAILED"); assert.equal(changedSource.errorCode, "SourceChanged");
    assert.deepEqual(mutations, ["POST /restapis?mode=import"], "changed source recovery must fail without creating a duplicate API");
    bodyS3Document = openApi("/one", "1");
    result = await invokeOne(() => provider.create(desired, createContext));
    callback = requireRestApiProgress(result, "CREATE", "settings", apiId);
    assert.deepEqual(mutations, ["POST /restapis?mode=import"], "retrying a lost import callback must discover the owned API without another POST");

    const createSettingsContext = { ...createContext, callbackContext: callback };
    result = await invokeOne(() => provider.create(desired, createSettingsContext));
    const createTags = requireRestApiProgress(result, "CREATE", "tags", apiId);
    assert.equal(mutations.at(-1), `PATCH /restapis/${apiId}`);
    const replayedSettings = await invokeOne(() => provider.create(desired, createSettingsContext));
    assert.deepEqual(requireRestApiProgress(replayedSettings, "CREATE", "tags", apiId), createTags);
    assert.equal(mutations.filter(value => value === `PATCH /restapis/${apiId}`).length, 1, "a replayed settings callback must not repeat PATCH");
    result = await invokeOne(() => provider.create(desired, { ...createContext, callbackContext: createTags }));
    callback = requireRestApiProgress(result, "CREATE", "tags", apiId);
    assert.match(mutations.at(-1)!, /^PUT \/tags\//);
    const created = requireSuccess(await invokeOne(() => provider.create(desired, { ...createContext, callbackContext: callback })));
    assert.equal(created.physicalId, apiId);

    client = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    assert.equal((await client.send(new GetRestApisCommand({}))).items?.filter(api => api.id === apiId).length, 1);
    assert.deepEqual((await client.send(new GetRestApiCommand({ restApiId: apiId }))).tags, { change: "old", remove: "old" });

    const updateContext = context("DurableRestApi", "DurableRestApiUpdate");
    const updated: ApiGatewayRestApiModel = provider.canonicalize({
      Name: "durable-rest-api",
      Description: "updated",
      Body: openApi("/two", "2"),
      Mode: "overwrite",
      Tags: [{ Key: "add", Value: "new" }, { Key: "change", Value: "new" }],
    }, updateContext);
    result = await invokeOne(() => provider.update(apiId, desired, updated, updateContext));
    callback = requireRestApiProgress(result, "UPDATE", "settings", apiId);
    assert.equal(mutations.at(-1), `PUT /restapis/${apiId}?mode=overwrite`);

    client.destroy(); client = undefined;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
    await simulator.start(); provider = tracedProvider(simulator);
    result = await invokeOne(() => provider.update(apiId, desired, updated, updateContext));
    callback = requireRestApiProgress(result, "UPDATE", "settings", apiId);
    assert.equal(mutations.filter(value => value.startsWith(`PUT /restapis/${apiId}?`)).length, 1, "retrying a lost body callback must observe the operation fingerprint");

    const updateSettingsContext = { ...updateContext, callbackContext: callback };
    result = await invokeOne(() => provider.update(apiId, desired, updated, updateSettingsContext));
    const updateTags = requireRestApiProgress(result, "UPDATE", "tags", apiId);
    assert.equal(mutations.at(-1), `PATCH /restapis/${apiId}`);
    const replayedUpdateSettings = await invokeOne(() => provider.update(apiId, desired, updated, updateSettingsContext));
    assert.deepEqual(requireRestApiProgress(replayedUpdateSettings, "UPDATE", "tags", apiId), updateTags);
    assert.equal(mutations.filter(value => value === `PATCH /restapis/${apiId}`).length, 2, "each create/update settings phase must PATCH exactly once");

    result = await invokeOne(() => provider.update(apiId, desired, updated, { ...updateContext, callbackContext: updateTags }));
    callback = requireRestApiProgress(result, "UPDATE", "tags", apiId);
    assert.match(mutations.at(-1)!, /^DELETE \/tags\//);
    result = await invokeOne(() => provider.update(apiId, desired, updated, { ...updateContext, callbackContext: callback }));
    callback = requireRestApiProgress(result, "UPDATE", "tags", apiId);
    assert.match(mutations.at(-1)!, /^PUT \/tags\//);
    client = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    await client.send(new UpdateRestApiCommand({ restApiId: apiId, patchOperations: [{ op: "replace", path: "/description", value: "out-of-band drift" }] }));
    result = await invokeOne(() => provider.update(apiId, desired, updated, { ...updateContext, callbackContext: callback }));
    callback = requireRestApiProgress(result, "UPDATE", "settings", apiId);
    result = await invokeOne(() => provider.update(apiId, desired, updated, { ...updateContext, callbackContext: callback }));
    callback = requireRestApiProgress(result, "UPDATE", "tags", apiId);
    assert.equal(mutations.at(-1), `PATCH /restapis/${apiId}`, "terminal verification must rewind settings drift before success");
    requireSuccess(await invokeOne(() => provider.update(apiId, desired, updated, { ...updateContext, callbackContext: callback })));

    assert.deepEqual((await client.send(new GetRestApiCommand({ restApiId: apiId }))).tags, { add: "new", change: "new" });
    assert.deepEqual((await client.send(new GetResourcesCommand({ restApiId: apiId }))).items?.map(resource => resource.path).sort(), ["/", "/two"]);

    const deleteContext = context("DurableRestApi", "DurableRestApiDelete");
    const deleteStart = mutations.length;
    result = await invokeOne(() => provider.delete(apiId, updated, deleteContext));
    callback = requireRestApiProgress(result, "DELETE", "verify-delete", apiId);
    assert.deepEqual(mutations.slice(deleteStart), [`DELETE /restapis/${apiId}`]);
    client.destroy(); client = undefined;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
    await simulator.start(); provider = tracedProvider(simulator);
    assert.equal((await invokeOne(() => provider.delete(apiId, updated, deleteContext))).status, "NOT_FOUND");
    requireSuccess(await invokeOne(() => provider.delete(apiId, updated, { ...deleteContext, callbackContext: callback })));
    assert.deepEqual(mutations.slice(deleteStart), [`DELETE /restapis/${apiId}`], "delete retries and verification must not repeat DELETE");

    const cleanupContext = context("FailedRestApi", "FailedRestApiCreate");
    const cleanupDesired: ApiGatewayRestApiModel = provider.canonicalize({ Name: "must-clean-up", Description: "never-completes", Body: openApi("/cleanup", "1") }, cleanupContext);
    result = await invokeOne(() => provider.create(cleanupDesired, cleanupContext));
    callback = requireRestApiProgress(result, "CREATE", "settings");
    const cleanupApiId = String(callback.apiId); failNextPatch = true;
    result = await invokeOne(() => provider.create(cleanupDesired, { ...cleanupContext, callbackContext: callback }));
    callback = requireRestApiProgress(result, "CREATE", "cleanup-delete", cleanupApiId);
    result = await invokeOne(() => provider.create(cleanupDesired, { ...cleanupContext, callbackContext: callback }));
    callback = requireRestApiProgress(result, "CREATE", "cleanup-verify", cleanupApiId);
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
    await simulator.start(); provider = tracedProvider(simulator);
    const cleanedFailure = await invokeOne(() => provider.create(cleanupDesired, { ...cleanupContext, callbackContext: callback }));
    assert.equal(cleanedFailure.status, "FAILED"); assert.equal(cleanedFailure.errorCode, "BadRequestException");
    client = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    assert.equal((await client.send(new GetRestApisCommand({}))).items?.some(api => api.id === cleanupApiId), false, "failed create cleanup must leave no orphan API");
  } finally {
    client?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true });
  }
});

test("CloudFormation rolls a mutable REST API body, settings, and tags back through durable callbacks", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-rest-rollback-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined; let apiClient: APIGatewayClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    apiClient = new APIGatewayClient({ endpoint, region, credentials, maxAttempts: 1 });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "rest-api-rollback-stack", TemplateBody: restApiRollbackTemplate("old") }));
    await waitForStackStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    const originalPhysicalId = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: created.StackId, LogicalResourceId: "Api" }))).StackResourceDetail!.PhysicalResourceId!;
    assert.deepEqual((await apiClient.send(new GetResourcesCommand({ restApiId: originalPhysicalId }))).items?.map(resource => resource.path).sort(), ["/", "/old"]);

    await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: restApiRollbackTemplate("new", true) }));
    await waitForStackStatus(cloudformation, created.StackId!, "UPDATE_ROLLBACK_COMPLETE");
    const restoredPhysicalId = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: created.StackId, LogicalResourceId: "Api" }))).StackResourceDetail!.PhysicalResourceId!;
    assert.equal(restoredPhysicalId, originalPhysicalId, "a mutable rollback must retain the REST API physical ID");
    const restored = await apiClient.send(new GetRestApiCommand({ restApiId: originalPhysicalId }));
    assert.equal(restored.description, "old description");
    assert.deepEqual(restored.tags, { restored: "true", version: "old" });
    assert.deepEqual((await apiClient.send(new GetResourcesCommand({ restApiId: originalPhysicalId }))).items?.map(resource => resource.path).sort(), ["/", "/old"]);
    assert.equal((await apiClient.send(new GetRestApisCommand({}))).items?.filter(api => api.name === "rest-api-rollback").length, 1);

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId }));
    await waitForStackStatus(cloudformation, created.StackId!, "DELETE_COMPLETE");
  } finally {
    cloudformation?.destroy(); apiClient?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true });
  }
});

test("API Gateway REST provider imports resolver-supplied OpenAPI and overwrites it from Body", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-import-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"}); let client: APIGatewayClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; client = new APIGatewayClient({ endpoint, region, credentials });
    const provider = createApiGatewayRestCloudFormationProviders(simulator.apigateway, { resolveBodyS3Location: async location => {
      assert.deepEqual(location, { Bucket: "assets", Key: "api.json", Version: "one" });
      return Buffer.from(JSON.stringify({ openapi: "3.0.1", info: { title: "from-s3", version: "1" }, paths: { "/one": { get: { "x-amazon-apigateway-integration": { type: "mock", requestTemplates: { "application/json": "{\"statusCode\":200}" }, responses: { default: { statusCode: "200" } } }, responses: { "200": { description: "ok" } } } } } }));
    } }).find(value => value.typeName === API_GATEWAY_REST_API_TYPE)!;
    const imported = provider.canonicalize({ Name: "imported-provider-api", BodyS3Location: { Bucket: "assets", Key: "api.json", Version: "one" }, Mode: "overwrite" }, context("ImportedApi"));
    const createContext = context("ImportedApi", "ImportedApiCreate");
    const created = requireSuccess(await completeProviderCallbacks(callback => provider.create(imported, callback), createContext)); const apiId = String(created.model.attributes.RestApiId);
    assert.ok((await client.send(new GetResourcesCommand({ restApiId: apiId }))).items?.some(resource => resource.path === "/one"));
    const desired = provider.canonicalize({ Name: "imported-provider-api", Body: { openapi: "3.0.1", info: { title: "inline", version: "2" }, paths: { "/two": {} } }, Mode: "overwrite" }, context("ImportedApi"));
    const updateContext = context("ImportedApi", "ImportedApiUpdate");
    requireSuccess(await completeProviderCallbacks(callback => provider.update(created.physicalId, imported, desired, callback), updateContext));
    const paths = (await client.send(new GetResourcesCommand({ restApiId: apiId }))).items?.map(resource => resource.path).sort();
    const deleteContext = context("ImportedApi", "ImportedApiDelete");
    assert.deepEqual(paths, ["/", "/two"]); requireSuccess(await completeProviderCallbacks(callback => provider.delete(created.physicalId, desired, callback), deleteContext));
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true }); }
});

test("API Gateway provider planning reports exact replacement properties and ordering", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-plans-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
  try {
    const providers = providerByType(simulator);
    const resourceProvider = providers[API_GATEWAY_RESOURCE_TYPE]; const resource = resourceProvider.canonicalize({ RestApiId: "api-one", ParentId: "root", PathPart: "one" }, context("Resource"));
    assert.deepEqual(resourceProvider.plan(resource, { ...resource, PathPart: "two" }, context("Resource")), { action: "REPLACE", desired: { ...resource, PathPart: "two" }, changedProperties: ["PathPart"], replacementProperties: ["PathPart"], replacementOrder: "CREATE_BEFORE_DELETE" });
    const methodProvider = providers[API_GATEWAY_METHOD_TYPE]; const method = methodProvider.canonicalize({ RestApiId: "api-one", ResourceId: "resource", HttpMethod: "GET", AuthorizationType: "NONE" }, context("Method"));
    const methodPlan = methodProvider.plan(method, { ...method, HttpMethod: "POST" }, context("Method")); assert.equal(methodPlan.action, "REPLACE"); assert.deepEqual(methodPlan.replacementProperties, ["HttpMethod"]); assert.equal(methodPlan.replacementOrder, "CREATE_BEFORE_DELETE");
    const stageProvider = providers[API_GATEWAY_STAGE_TYPE]; const stage = stageProvider.canonicalize({ RestApiId: "api-one", DeploymentId: "deployment", StageName: "dev" }, context("Stage"));
    const stagePlan = stageProvider.plan(stage, { ...stage, StageName: "next" }, context("Stage")); assert.equal(stagePlan.action, "REPLACE"); assert.deepEqual(stagePlan.replacementProperties, ["StageName"]); assert.equal(stagePlan.replacementOrder, "CREATE_BEFORE_DELETE");
    const deploymentProvider = providers[API_GATEWAY_DEPLOYMENT_TYPE]; const deployment = deploymentProvider.canonicalize({ RestApiId: "api-one" }, context("Deployment"));
    const deploymentPlan = deploymentProvider.plan(deployment, { ...deployment, RestApiId: "api-two" }, context("Deployment")); assert.equal(deploymentPlan.action, "REPLACE"); assert.deepEqual(deploymentPlan.replacementProperties, ["RestApiId"]); assert.equal(deploymentPlan.replacementOrder, "CREATE_BEFORE_DELETE");
    const deploymentDescriptionPlan = deploymentProvider.plan(deployment, { ...deployment, Description: "new immutable snapshot" }, context("Deployment")); assert.equal(deploymentDescriptionPlan.action, "REPLACE"); assert.deepEqual(deploymentDescriptionPlan.replacementProperties, ["Description"]);
    const apiKeyProvider = providers[API_GATEWAY_API_KEY_TYPE]; const apiKey = apiKeyProvider.canonicalize({ Name: "planned-key", Value: "A".repeat(20) }, context("ApiKey"));
    const apiKeyValuePlan = apiKeyProvider.plan(apiKey, { ...apiKey, Value: "B".repeat(20) }, context("ApiKey")); assert.equal(apiKeyValuePlan.action, "REPLACE"); assert.deepEqual(apiKeyValuePlan.replacementProperties, ["Value"]); assert.equal(apiKeyValuePlan.replacementOrder, "CREATE_BEFORE_DELETE");
    const apiKeyNamePlan = apiKeyProvider.plan(apiKey, { ...apiKey, Name: "renamed-key" }, context("ApiKey")); assert.equal(apiKeyNamePlan.action, "REPLACE"); assert.deepEqual(apiKeyNamePlan.replacementProperties, ["Name"]);
    const authorizerProvider = providers[API_GATEWAY_AUTHORIZER_TYPE]; const authorizer = authorizerProvider.canonicalize({ RestApiId: "api-one", Name: "auth", Type: "TOKEN", AuthorizerUri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${region}:${accountId}:function:auth/invocations`, IdentitySource: "method.request.header.Authorization" }, context("Authorizer")); assert.equal(authorizerProvider.plan(authorizer, { ...authorizer, Type: "REQUEST" }, context("Authorizer")).action, "UPDATE");
    const poolArn = `arn:aws:cognito-idp:${region}:${accountId}:userpool/${region}_AbCdEf123`;
    assert.deepEqual(authorizerProvider.validate({ RestApiId: "api-one", Name: "cognito", Type: "COGNITO_USER_POOLS", ProviderARNs: [poolArn], IdentitySource: "method.request.header.Authorization" }, context("CognitoAuthorizer")), []);
    assert.ok(authorizerProvider.validate({ RestApiId: "api-one", Name: "cognito", Type: "COGNITO_USER_POOLS", ProviderARNs: [poolArn], AuthorizerUri: "forbidden" }, context("CognitoAuthorizer")).some((value: any) => value.path === "Properties.AuthorizerUri"));
    assert.deepEqual(methodProvider.validate({ RestApiId: "api-one", ResourceId: "resource", HttpMethod: "GET", AuthorizationType: "COGNITO_USER_POOLS", AuthorizerId: "authorizer", AuthorizationScopes: ["board.read"] }, context("CognitoMethod")), []);
    assert.ok(methodProvider.validate({ RestApiId: "api-one", ResourceId: "resource", HttpMethod: "GET", AuthorizationType: "CUSTOM", AuthorizerId: "authorizer", AuthorizationScopes: ["board.read"] }, context("CustomMethod")).some((value: any) => value.path === "Properties.AuthorizationScopes"));
    const modelProvider = providers[API_GATEWAY_MODEL_TYPE]; const model = modelProvider.canonicalize({ RestApiId: "api-one", Name: "Payload", ContentType: "application/json" }, context("Model")); const contentTypePlan = modelProvider.plan(model, { ...model, ContentType: "application/xml" }, context("Model")); assert.equal(contentTypePlan.action, "REPLACE"); assert.deepEqual(contentTypePlan.replacementProperties, ["ContentType"]);
    const validatorProvider = providers[API_GATEWAY_REQUEST_VALIDATOR_TYPE]; const validator = validatorProvider.canonicalize({ RestApiId: "api-one", Name: "validator" }, context("Validator")); const validatorNamePlan = validatorProvider.plan(validator, { ...validator, Name: "renamed" }, context("Validator")); assert.equal(validatorNamePlan.action, "REPLACE"); assert.deepEqual(validatorNamePlan.replacementProperties, ["Name"]);
    const accountProvider = providers[API_GATEWAY_ACCOUNT_TYPE]; assert.equal(accountProvider.plan(accountProvider.canonicalize({}, context("Account")), accountProvider.canonicalize({ CloudWatchRoleArn: `arn:aws:iam::${accountId}:role/logging` }, context("Account")), context("Account")).action, "UPDATE");
    assert.ok(providers[API_GATEWAY_REST_API_TYPE].validate({ EndpointConfiguration: { Types: ["EDGE"] } }, context("Api")).some((value: any) => value.path === "Properties.EndpointConfiguration.Types"));
    const invalidNestedMethod = methodProvider.validate({
      RestApiId: "api-one", ResourceId: "resource", HttpMethod: "POST", AuthorizationType: "NONE",
      RequestModels: ["not-a-map"], RequestParameters: "not-a-map",
      MethodResponses: [{ StatusCode: "200", ResponseModels: false, ResponseParameters: [] }],
      Integration: {
        Type: "MOCK", RequestParameters: [], RequestTemplates: "not-a-map", CacheKeyParameters: {}, TlsConfig: false,
        IntegrationResponses: [{ StatusCode: "200", ResponseParameters: true, ResponseTemplates: [] }],
      },
    }, context("InvalidNestedMethod"));
    const invalidNestedPaths = new Set(invalidNestedMethod.map((value: any) => value.path));
    for (const path of [
      "Properties.RequestModels", "Properties.RequestParameters", "Properties.MethodResponses[0].ResponseModels", "Properties.MethodResponses[0].ResponseParameters",
      "Properties.Integration.RequestParameters", "Properties.Integration.RequestTemplates", "Properties.Integration.CacheKeyParameters", "Properties.Integration.TlsConfig",
      "Properties.Integration.IntegrationResponses[0].ResponseParameters", "Properties.Integration.IntegrationResponses[0].ResponseTemplates",
    ]) assert.ok(invalidNestedPaths.has(path), `expected an InvalidType issue for ${path}`);
    assert.ok(invalidNestedMethod.every((value: any) => value.code === "InvalidType"));
  } finally { await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true }); }
});

test("CloudFormation replaces API keys when Value changes and rolls replacement back cleanly", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-key-replacement-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"}); let cloudformation: CloudFormationClient | undefined; let apigateway: APIGatewayClient | undefined;
  const template = (value: string, invalidOutput = false) => JSON.stringify({ Resources: { Key: { Type: "AWS::ApiGateway::ApiKey", Properties: { Enabled: true, Value: value } } }, ...(invalidOutput ? { Outputs: { Invalid: { Value: ["not", "scalar"] } } } : {}) });
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; cloudformation = new CloudFormationClient({ endpoint, region, credentials }); apigateway = new APIGatewayClient({ endpoint, region, credentials });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "api-key-replacement", TemplateBody: template("A".repeat(20)) })); await waitForStackStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    const firstId = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: created.StackId, LogicalResourceId: "Key" }))).StackResourceDetail!.PhysicalResourceId!;

    await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: template("B".repeat(20)) })); await waitForStackStatus(cloudformation, created.StackId!, "UPDATE_COMPLETE");
    const secondId = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: created.StackId, LogicalResourceId: "Key" }))).StackResourceDetail!.PhysicalResourceId!; assert.notEqual(secondId, firstId); await assert.rejects(apigateway.send(new GetApiKeyCommand({ apiKey: firstId, includeValue: true })), (error: any) => error.name === "NotFoundException");

    await cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: template("C".repeat(20), true) })); await waitForStackStatus(cloudformation, created.StackId!, "UPDATE_ROLLBACK_COMPLETE");
    const restoredId = (await cloudformation.send(new DescribeStackResourceCommand({ StackName: created.StackId, LogicalResourceId: "Key" }))).StackResourceDetail!.PhysicalResourceId!; assert.equal(restoredId, secondId); assert.equal((await apigateway.send(new GetApiKeyCommand({ apiKey: secondId, includeValue: true }))).value, "B".repeat(20));
    const values = (await apigateway.send(new GetApiKeysCommand({ includeValues: true }))).items?.map(item => item.value); assert.deepEqual(values, ["B".repeat(20)]);

    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId })); await waitForStackStatus(cloudformation, created.StackId!, "DELETE_COMPLETE");
  } finally { cloudformation?.destroy(); apigateway?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true }); }
});

test("API Gateway common REST child providers use authoritative CRUD and dependency state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-common-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"}); let client: APIGatewayClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; client = new APIGatewayClient({ endpoint, region, credentials }); const providers = providerByType(simulator);
    const restProvider = providers[API_GATEWAY_REST_API_TYPE]; const deploymentProvider = providers[API_GATEWAY_DEPLOYMENT_TYPE]; const stageProvider = providers[API_GATEWAY_STAGE_TYPE];
    const rest = restProvider.canonicalize({ Name: "common-provider-api" }, context("CommonApi")); const restCreateContext = context("CommonApi", "CommonApiCreate"); const restResult = requireSuccess(await completeProviderCallbacks(callback => restProvider.create(rest, callback), restCreateContext)); const apiId = String(restResult.model.attributes.RestApiId);
    const deployment = deploymentProvider.canonicalize({ RestApiId: apiId }, context("CommonDeployment")); const deploymentCreateContext = context("CommonDeployment", "CommonDeploymentCreate"); const deploymentResult = requireSuccess(await completeProviderCallbacks(callback => deploymentProvider.create(deployment, callback), deploymentCreateContext)); const deploymentId = String(deploymentResult.model.attributes.DeploymentId);
    const stage = stageProvider.canonicalize({ RestApiId: apiId, DeploymentId: deploymentId, StageName: "common" }, context("CommonStage")); const stageResult = requireSuccess(await stageProvider.create(stage, context("CommonStage")));

    const authorizerProvider = providers[API_GATEWAY_AUTHORIZER_TYPE]; const authorizer = authorizerProvider.canonicalize({ RestApiId: apiId, Name: "request-auth", Type: "REQUEST", AuthorizerUri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${region}:${accountId}:function:authorizer/invocations`, AuthorizerResultTtlInSeconds: 0 }, context("Authorizer"));
    const authorizerResult = requireSuccess(await authorizerProvider.create(authorizer, context("Authorizer"))); const authorizerId = String(authorizerResult.model.attributes.AuthorizerId);
    const updatedAuthorizer = authorizerProvider.canonicalize({ ...authorizer, Name: "request-auth-updated", Type: "TOKEN", IdentitySource: "method.request.header.Authorization" }, context("Authorizer")); requireSuccess(await authorizerProvider.update(authorizerResult.physicalId, authorizer, updatedAuthorizer, context("Authorizer")));
    const directAuthorizer = await client.send(new GetAuthorizerCommand({ restApiId: apiId, authorizerId })); assert.equal(directAuthorizer.name, "request-auth-updated"); assert.equal(directAuthorizer.type, "TOKEN"); assert.equal(authorizerProvider.plan(authorizer, updatedAuthorizer, context("Authorizer")).action, "UPDATE");
    const pool = (await simulator.cognito.executeCloudFormationControl("CreateUserPool", { PoolName: "cfn-rest-authorizer-users" }) as any).UserPool;
    const poolArn = `arn:aws:cognito-idp:${region}:${accountId}:userpool/${pool.Id}`;
    const cognitoAuthorizer = authorizerProvider.canonicalize({
      RestApiId: apiId,
      Name: "cognito-users",
      Type: "COGNITO_USER_POOLS",
      ProviderARNs: [poolArn],
      IdentitySource: "method.request.header.Authorization",
      AuthorizerResultTtlInSeconds: 120,
    }, context("CognitoAuthorizer"));
    const cognitoAuthorizerResult = requireSuccess(await authorizerProvider.create(cognitoAuthorizer, context("CognitoAuthorizer")));
    const directCognitoAuthorizer = await client.send(new GetAuthorizerCommand({ restApiId: apiId, authorizerId: String(cognitoAuthorizerResult.model.attributes.AuthorizerId) }));
    assert.equal(directCognitoAuthorizer.type, "COGNITO_USER_POOLS");
    assert.deepEqual(directCognitoAuthorizer.providerARNs, [poolArn]);
    assert.equal(directCognitoAuthorizer.authorizerUri, undefined);

    const modelProvider = providers[API_GATEWAY_MODEL_TYPE]; const model = modelProvider.canonicalize({ RestApiId: apiId, Name: "GraphqlRequest", ContentType: "application/json", Schema: { type: "object", required: ["query"], properties: { query: { type: "string" } } } }, context("GraphqlModel"));
    const modelResult = requireSuccess(await modelProvider.create(model, context("GraphqlModel"))); const updatedModel = modelProvider.canonicalize({ ...model, Description: "GraphQL request envelope" }, context("GraphqlModel")); requireSuccess(await modelProvider.update(modelResult.physicalId, model, updatedModel, context("GraphqlModel")));
    assert.equal((await client.send(new GetModelCommand({ restApiId: apiId, modelName: "GraphqlRequest" }))).description, "GraphQL request envelope");

    const validatorProvider = providers[API_GATEWAY_REQUEST_VALIDATOR_TYPE]; const validator = validatorProvider.canonicalize({ RestApiId: apiId, Name: "body-validator", ValidateRequestBody: true }, context("Validator"));
    const validatorResult = requireSuccess(await validatorProvider.create(validator, context("Validator"))); const validatorId = String(validatorResult.model.attributes.RequestValidatorId); const updatedValidator = validatorProvider.canonicalize({ ...validator, ValidateRequestParameters: true }, context("Validator")); requireSuccess(await validatorProvider.update(validatorResult.physicalId, validator, updatedValidator, context("Validator")));
    assert.equal((await client.send(new GetRequestValidatorCommand({ restApiId: apiId, requestValidatorId: validatorId }))).validateRequestParameters, true);

    const responseProvider = providers[API_GATEWAY_GATEWAY_RESPONSE_TYPE]; const gatewayResponse = responseProvider.canonicalize({ RestApiId: apiId, ResponseType: "UNAUTHORIZED", StatusCode: "401", ResponseTemplates: { "application/json": "{\"error\":\"unauthorized\"}" } }, context("GatewayResponse"));
    const gatewayResponseResult = requireSuccess(await responseProvider.create(gatewayResponse, context("GatewayResponse"))); const updatedGatewayResponse = responseProvider.canonicalize({ ...gatewayResponse, StatusCode: "403" }, context("GatewayResponse")); requireSuccess(await responseProvider.update(gatewayResponseResult.physicalId, gatewayResponse, updatedGatewayResponse, context("GatewayResponse")));
    assert.equal((await client.send(new GetGatewayResponseCommand({ restApiId: apiId, responseType: "UNAUTHORIZED" }))).statusCode, "403");

    const apiKeyProvider = providers[API_GATEWAY_API_KEY_TYPE]; const apiKey = apiKeyProvider.canonicalize({ Name: "provider-key", Enabled: true, Tags: [{ Key: "team", Value: "platform" }] }, context("ApiKey")); const apiKeyResult = requireSuccess(await apiKeyProvider.create(apiKey, context("ApiKey"))); const apiKeyId = String(apiKeyResult.model.attributes.APIKeyId);
    const updatedApiKey = apiKeyProvider.canonicalize({ ...apiKey, Description: "provider managed", StageKeys: [{ RestApiId: apiId, StageName: "common" }], Tags: [{ Key: "team", Value: "services" }] }, context("ApiKey")); requireSuccess(await apiKeyProvider.update(apiKeyResult.physicalId, apiKey, updatedApiKey, context("ApiKey")));
    const directKey = await client.send(new GetApiKeyCommand({ apiKey: apiKeyId, includeValue: true })); assert.equal(directKey.description, "provider managed"); assert.equal(directKey.tags?.team, "services"); assert.deepEqual(directKey.stageKeys, [`${apiId}/common`]);

    const usagePlanProvider = providers[API_GATEWAY_USAGE_PLAN_TYPE]; const usagePlan = usagePlanProvider.canonicalize({ UsagePlanName: "provider-plan", ApiStages: [{ ApiId: apiId, Stage: "common", Throttle: { "/*/GET": { BurstLimit: 2, RateLimit: 1 } } }], Throttle: { BurstLimit: 5, RateLimit: 2 }, Quota: { Limit: 100, Period: "DAY" }, Tags: [{ Key: "tier", Value: "dev" }] }, context("UsagePlan"));
    const usagePlanResult = requireSuccess(await usagePlanProvider.create(usagePlan, context("UsagePlan"))); const usagePlanId = String(usagePlanResult.model.attributes.Id); const updatedUsagePlan = usagePlanProvider.canonicalize({ ...usagePlan, Description: "updated plan", Quota: { Limit: 200, Period: "DAY" } }, context("UsagePlan")); requireSuccess(await usagePlanProvider.update(usagePlanResult.physicalId, usagePlan, updatedUsagePlan, context("UsagePlan")));
    assert.equal((await client.send(new GetUsagePlanCommand({ usagePlanId }))).quota?.limit, 200);
    const usagePlanKeyProvider = providers[API_GATEWAY_USAGE_PLAN_KEY_TYPE]; const usagePlanKey = usagePlanKeyProvider.canonicalize({ UsagePlanId: usagePlanId, KeyId: apiKeyId, KeyType: "API_KEY" }, context("UsagePlanKey")); const usagePlanKeyResult = requireSuccess(await usagePlanKeyProvider.create(usagePlanKey, context("UsagePlanKey"))); assert.equal(usagePlanKeyProvider.ref(usagePlanKeyResult.model), `${apiKeyId}:${usagePlanId}`);
    assert.equal((await client.send(new GetUsagePlanKeyCommand({ usagePlanId, keyId: apiKeyId }))).id, apiKeyId);

    requireSuccess(await usagePlanKeyProvider.delete(usagePlanKeyResult.physicalId, usagePlanKey, context("UsagePlanKey")));
    requireSuccess(await usagePlanProvider.delete(usagePlanResult.physicalId, updatedUsagePlan, context("UsagePlan")));
    requireSuccess(await apiKeyProvider.delete(apiKeyResult.physicalId, updatedApiKey, context("ApiKey")));
    requireSuccess(await responseProvider.delete(gatewayResponseResult.physicalId, updatedGatewayResponse, context("GatewayResponse"))); assert.equal((await responseProvider.read(gatewayResponseResult.physicalId, context("GatewayResponse"))).status, "NOT_FOUND");
    requireSuccess(await validatorProvider.delete(validatorResult.physicalId, updatedValidator, context("Validator")));
    requireSuccess(await modelProvider.delete(modelResult.physicalId, updatedModel, context("GraphqlModel")));
    requireSuccess(await authorizerProvider.delete(cognitoAuthorizerResult.physicalId, cognitoAuthorizer, context("CognitoAuthorizer")));
    await simulator.cognito.executeCloudFormationControl("DeleteUserPool", { UserPoolId: pool.Id });
    requireSuccess(await authorizerProvider.delete(authorizerResult.physicalId, updatedAuthorizer, context("Authorizer")));
    requireSuccess(await stageProvider.delete(stageResult.physicalId, stage, context("CommonStage"))); requireSuccess(await deploymentProvider.delete(deploymentResult.physicalId, deployment, context("CommonDeployment"))); const restDeleteContext = context("CommonApi", "CommonApiDelete"); requireSuccess(await completeProviderCallbacks(callback => restProvider.delete(restResult.physicalId, rest, callback), restDeleteContext));
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true }); }
});

test("API Gateway Account provider reconciles its regional singleton on create and deletion is a documented no-op", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-account-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"}); let apiClient: APIGatewayClient | undefined; let iam: IAMClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; apiClient = new APIGatewayClient({ endpoint, region, credentials }); iam = new IAMClient({ endpoint, region, credentials });
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "sts:AssumeRole" }] });
    const firstRole = (await iam.send(new CreateRoleCommand({ RoleName: "api-logs-one", AssumeRolePolicyDocument: trust }))).Role!.Arn!; const secondRole = (await iam.send(new CreateRoleCommand({ RoleName: "api-logs-two", AssumeRolePolicyDocument: trust }))).Role!.Arn!;
    const provider = providerByType(simulator)[API_GATEWAY_ACCOUNT_TYPE]; const first = provider.canonicalize({ CloudWatchRoleArn: firstRole }, context("Account")); const created = requireSuccess(await provider.create(first, context("Account")));
    const accountRef = provider.ref(created.model); assert.match(accountRef, /^[a-f0-9]{16}$/); assert.notEqual(accountRef, created.physicalId); assert.equal(provider.getAtt(created.model, "Id"), accountRef); assert.equal((await apiClient.send(new GetAccountCommand({}))).cloudwatchRoleArn, firstRole);
    const second = provider.canonicalize({ CloudWatchRoleArn: secondRole }, context("AnotherAccount")); const overwritten = requireSuccess(await provider.create(second, context("AnotherAccount"))); assert.equal(overwritten.physicalId, created.physicalId); assert.equal((await apiClient.send(new GetAccountCommand({}))).cloudwatchRoleArn, secondRole, "a later Account create overwrites the regional setting as CloudFormation documents");
    requireSuccess(await provider.update(overwritten.physicalId, second, first, context("AnotherAccount"))); assert.equal((await apiClient.send(new GetAccountCommand({}))).cloudwatchRoleArn, firstRole);
    const reread = requireSuccess(await provider.read(created.physicalId, context("Account"))); assert.equal(provider.ref(reread.model), accountRef); assert.equal(provider.getAtt(reread.model, "Id"), accountRef);
    requireSuccess(await provider.delete(created.physicalId, first, context("Account"))); assert.equal((await apiClient.send(new GetAccountCommand({}))).cloudwatchRoleArn, firstRole); assert.equal((await provider.read("wrong-region", context("Account"))).status, "NOT_FOUND");
  } finally { apiClient?.destroy(); iam?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true }); }
});
