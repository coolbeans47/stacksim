import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateAuthorizerCommand,
  CreateDeploymentCommand,
  CreateIntegrationCommand,
  CreateRouteCommand,
  CreateStageCommand,
  GetApiCommand,
  GetApisCommand,
  GetDeploymentsCommand,
  GetDomainNamesCommand,
  GetIntegrationsCommand,
  GetModelCommand,
  GetModelsCommand,
  GetStageCommand,
  GetStagesCommand,
  UpdateApiCommand,
  UpdateModelCommand,
  UpdateStageCommand,
} from "@aws-sdk/client-apigatewayv2";
import WebSocket from "ws";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import type { ProductionResourceProvider, ProviderContext } from "../src/cloudformation/providers/contract.js";
import {
  API_GATEWAY_V2_API_MAPPING_TYPE,
  API_GATEWAY_V2_API_TYPE,
  API_GATEWAY_V2_AUTHORIZER_TYPE,
  API_GATEWAY_V2_DEPLOYMENT_TYPE,
  API_GATEWAY_V2_DOMAIN_NAME_TYPE,
  API_GATEWAY_V2_INTEGRATION_RESPONSE_TYPE,
  API_GATEWAY_V2_INTEGRATION_TYPE,
  API_GATEWAY_V2_MODEL_TYPE,
  API_GATEWAY_V2_ROUTE_RESPONSE_TYPE,
  API_GATEWAY_V2_ROUTE_TYPE,
  API_GATEWAY_V2_STAGE_TYPE,
  createApiGatewayV2CloudFormationProviders,
} from "../src/cloudformation/providers/apigateway-v2.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const stackId = `arn:aws:cloudformation:${region}:${accountId}:stack/cfn12-providers/stack-id`;
const identity: PrincipalContext = {
  accessKeyId: credentials.accessKeyId,
  principalArn: `arn:aws:iam::${accountId}:root`,
  principalId: accountId,
  accountId,
};

function context(logicalId: string, operation = "lifecycle"): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId,
    logicalId,
    operationId: `${logicalId}-${operation}`,
    resourceOperationId: `${logicalId}-${operation}-resource`,
    idempotencyKey: `${logicalId}-${operation}-key`,
    deadlineAt: Date.now() + 60_000,
    principal: { identity },
  };
}

function requireSuccess(result: any): any {
  assert.equal(result.status, "SUCCESS", result.message);
  return result;
}

function requireProvider(
  providers: ReadonlyMap<string, ProductionResourceProvider<any>>,
  typeName: string,
): ProductionResourceProvider<any> {
  const provider = providers.get(typeName);
  assert.ok(provider, `missing provider ${typeName}`);
  return provider;
}

async function createAndRead(
  provider: ProductionResourceProvider<any>,
  desired: any,
  providerContext: ProviderContext,
): Promise<any> {
  const dryRun = provider.plan(undefined, desired, providerContext);
  assert.equal(dryRun.action, "CREATE");
  assert.deepEqual(dryRun.replacementProperties, []);
  const created = requireSuccess(await provider.create(desired, providerContext));
  const replayed = requireSuccess(await provider.create(desired, providerContext));
  assert.equal(replayed.physicalId, created.physicalId, `${provider.typeName} replay changed physical identity`);
  assert.deepEqual(replayed.model, created.model, `${provider.typeName} replay changed the authoritative model`);
  const read = requireSuccess(await provider.read(created.physicalId, providerContext));
  assert.equal(read.physicalId, created.physicalId);
  assert.deepEqual(read.model.properties, created.model.properties);
  return created;
}

async function updateAndRead(
  provider: ProductionResourceProvider<any>,
  physicalId: string,
  previous: any,
  desired: any,
  providerContext: ProviderContext,
): Promise<any> {
  assert.equal(provider.plan(previous, desired, providerContext).action, "UPDATE");
  const updated = requireSuccess(await provider.update(physicalId, previous, desired, providerContext));
  const read = requireSuccess(await provider.read(physicalId, providerContext));
  assert.deepEqual(read.model.properties, updated.model.properties);
  return updated;
}

function assertReplacement(
  provider: ProductionResourceProvider<any>,
  previous: any,
  desired: any,
  providerContext: ProviderContext,
  property: string,
  order: "CREATE_BEFORE_DELETE" | "DELETE_BEFORE_CREATE",
): void {
  const dryRun = provider.plan(previous, desired, providerContext);
  assert.equal(dryRun.action, "REPLACE");
  assert.ok(dryRun.replacementProperties.includes(property), `${provider.typeName} did not replace on ${property}`);
  assert.equal(dryRun.replacementOrder, order);
}

function expectWebSocketUpgradeStatus(target: string, status: number, headers?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target, { headers });
    socket.once("open", () => {
      socket.close();
      reject(new Error(`WebSocket upgrade unexpectedly succeeded for ${target}`));
    });
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      if (response.statusCode === status) resolve();
      else reject(new Error(`Expected WebSocket status ${status}, received ${response.statusCode}`));
    });
  });
}

test("CFN-12 API Gateway v2 providers use authoritative HTTP and WebSocket state across all eleven exact types", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn12-providers-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
  let client: ApiGatewayV2Client | undefined;
  try {
    await simulator.start();
    client = new ApiGatewayV2Client({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials,
    });

    const exactTypes = [
      API_GATEWAY_V2_API_TYPE,
      API_GATEWAY_V2_INTEGRATION_TYPE,
      API_GATEWAY_V2_ROUTE_TYPE,
      API_GATEWAY_V2_DEPLOYMENT_TYPE,
      API_GATEWAY_V2_STAGE_TYPE,
      API_GATEWAY_V2_AUTHORIZER_TYPE,
      API_GATEWAY_V2_DOMAIN_NAME_TYPE,
      API_GATEWAY_V2_API_MAPPING_TYPE,
      API_GATEWAY_V2_MODEL_TYPE,
      API_GATEWAY_V2_INTEGRATION_RESPONSE_TYPE,
      API_GATEWAY_V2_ROUTE_RESPONSE_TYPE,
    ].sort();
    const providers = new Map(
      createApiGatewayV2CloudFormationProviders(simulator.apigatewayv2)
        .map(provider => [provider.typeName, provider] as const),
    );
    assert.deepEqual([...providers.keys()].sort(), exactTypes);

    const apiProvider = requireProvider(providers, API_GATEWAY_V2_API_TYPE);
    const integrationProvider = requireProvider(providers, API_GATEWAY_V2_INTEGRATION_TYPE);
    const routeProvider = requireProvider(providers, API_GATEWAY_V2_ROUTE_TYPE);
    const deploymentProvider = requireProvider(providers, API_GATEWAY_V2_DEPLOYMENT_TYPE);
    const stageProvider = requireProvider(providers, API_GATEWAY_V2_STAGE_TYPE);
    const authorizerProvider = requireProvider(providers, API_GATEWAY_V2_AUTHORIZER_TYPE);
    const domainProvider = requireProvider(providers, API_GATEWAY_V2_DOMAIN_NAME_TYPE);
    const mappingProvider = requireProvider(providers, API_GATEWAY_V2_API_MAPPING_TYPE);
    const modelProvider = requireProvider(providers, API_GATEWAY_V2_MODEL_TYPE);
    const integrationResponseProvider = requireProvider(providers, API_GATEWAY_V2_INTEGRATION_RESPONSE_TYPE);
    const routeResponseProvider = requireProvider(providers, API_GATEWAY_V2_ROUTE_RESPONSE_TYPE);

    const httpApiContext = context("HttpApi");
    const httpApi = apiProvider.canonicalize({
      Name: "cfn12-http-api",
      ProtocolType: "HTTP",
      Description: "initial HTTP API",
      CorsConfiguration: { AllowMethods: ["GET"], AllowOrigins: ["https://app.example.test"] },
      DisableExecuteApiEndpoint: false,
      IpAddressType: "ipv4",
      Tags: { team: "platform" },
      Version: "1",
    }, httpApiContext);
    const httpApiCreated = await createAndRead(apiProvider, httpApi, httpApiContext);
    const httpApiId = String(httpApiCreated.model.attributes.ApiId);
    const authoritativeHttpApi = await client.send(new GetApiCommand({ ApiId: httpApiId }));
    assert.equal((await client.send(new GetApisCommand({ MaxResults: "500" }))).Items?.length, 1, "API create replay must not duplicate backing state");
    assert.equal((authoritativeHttpApi as any).cloudFormationOperationToken, undefined, "internal replay metadata must not leak through SDK views");
    assert.equal(httpApiCreated.model.attributes.ApiEndpoint, authoritativeHttpApi.ApiEndpoint);
    assert.equal(apiProvider.getAtt(httpApiCreated.model, "ApiEndpoint"), authoritativeHttpApi.ApiEndpoint);
    assert.equal(apiProvider.ref(httpApiCreated.model), httpApiId);

    const updatedHttpApi = apiProvider.canonicalize({
      Name: "cfn12-http-api",
      ProtocolType: "HTTP",
      Description: "updated HTTP API",
      CorsConfiguration: { AllowHeaders: ["authorization"], AllowMethods: ["GET"], AllowOrigins: ["https://app.example.test"] },
      DisableExecuteApiEndpoint: false,
      IpAddressType: "dualstack",
      Tags: { environment: "test", team: "services" },
      Version: "2",
    }, httpApiContext);
    await updateAndRead(apiProvider, httpApiId, httpApi, updatedHttpApi, httpApiContext);
    const websocketReplacement = apiProvider.canonicalize({
      Name: "cfn12-http-api",
      ProtocolType: "WEBSOCKET",
      RouteSelectionExpression: "$request.body.action",
    }, httpApiContext);
    assertReplacement(apiProvider, updatedHttpApi, websocketReplacement, httpApiContext, "ProtocolType", "CREATE_BEFORE_DELETE");

    const localTarget = `arn:aws:lambda:${region}:${accountId}:function:cfn12-target`;
    for (const invalidRole of [
      `arn:aws:iam::${accountId}:user/not-a-role`,
      `arn:aws:iam::${accountId}:group/not-a-role`,
      "arn:aws:iam::*:user/*",
      "arn:aws:iam::111111111111:role/remote-role",
    ]) {
      assert.ok(apiProvider.validate({ Name: "invalid-quick-role", ProtocolType: "HTTP", Target: localTarget, CredentialsArn: invalidRole }, httpApiContext).some(issue => issue.path === "Properties.CredentialsArn"));
    }
    const failedQuickContext = context("FailedQuickApi");
    const failedQuickApi = apiProvider.canonicalize({
      Name: "cfn12-failed-quick-api",
      ProtocolType: "HTTP",
      Target: localTarget,
      CredentialsArn: `arn:aws:iam::${accountId}:role/cfn12-missing-quick-role`,
    }, failedQuickContext);
    const apiCountBeforeFailedQuickCreate = (await client.send(new GetApisCommand({ MaxResults: "500" }))).Items?.length;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failedQuickCreate = await apiProvider.create(failedQuickApi, failedQuickContext);
      assert.equal(failedQuickCreate.status, "FAILED");
      if (failedQuickCreate.status === "FAILED") assert.match(failedQuickCreate.message, /cannot assume the configured integration role/);
    }
    assert.equal((await client.send(new GetApisCommand({ MaxResults: "500" }))).Items?.length, apiCountBeforeFailedQuickCreate, "a failed quick-create retry must not publish a partial API");

    const integrationContext = context("HttpIntegration");
    assert.ok(integrationProvider.validate({
      ApiId: httpApiId,
      IntegrationMethod: "POST",
      IntegrationType: "AWS_PROXY",
      IntegrationUri: localTarget,
      PayloadFormatVersion: "2.0",
      CredentialsArn: `arn:aws:iam::${accountId}:user/not-a-role`,
    }, integrationContext).some(issue => issue.path === "Properties.CredentialsArn"));
    const httpIntegration = integrationProvider.canonicalize({
      ApiId: httpApiId,
      Description: "initial HTTP integration",
      IntegrationMethod: "GET",
      IntegrationType: "HTTP_PROXY",
      IntegrationUri: "https://backend.example.test/v1",
      PayloadFormatVersion: "1.0",
      TimeoutInMillis: 25_000,
    }, integrationContext);
    const httpIntegrationCreated = await createAndRead(integrationProvider, httpIntegration, integrationContext);
    const httpIntegrationId = String(httpIntegrationCreated.model.attributes.IntegrationId);
    assert.equal((await client.send(new GetIntegrationsCommand({ ApiId: httpApiId, MaxResults: "500" }))).Items?.length, 1, "integration create replay must not duplicate backing state");
    assert.equal(integrationProvider.ref(httpIntegrationCreated.model), httpIntegrationId);
    const updatedHttpIntegration = integrationProvider.canonicalize({
      ApiId: httpApiId,
      Description: "updated HTTP integration",
      IntegrationMethod: "GET",
      IntegrationType: "HTTP_PROXY",
      IntegrationUri: "https://backend.example.test/v2",
      PayloadFormatVersion: "1.0",
      TimeoutInMillis: 24_000,
    }, integrationContext);
    await updateAndRead(integrationProvider, httpIntegrationCreated.physicalId, httpIntegration, updatedHttpIntegration, integrationContext);
    assertReplacement(
      integrationProvider,
      updatedHttpIntegration,
      integrationProvider.canonicalize({ ...updatedHttpIntegration, ApiId: "replacement-api" }, integrationContext),
      integrationContext,
      "ApiId",
      "CREATE_BEFORE_DELETE",
    );

    const authorizerContext = context("HttpAuthorizer");
    assert.ok(authorizerProvider.validate({
      ApiId: httpApiId,
      AuthorizerResultTtlInSeconds: 0,
      AuthorizerType: "REQUEST",
      AuthorizerUri: `arn:aws:lambda:${region}:${accountId}:function:cfn12-authorizer`,
      IdentitySource: ["$request.header.Authorization"],
      Name: "invalid-role-authorizer",
      AuthorizerCredentialsArn: "arn:aws:iam::111111111111:role/remote-role",
    }, authorizerContext).some(issue => issue.path === "Properties.AuthorizerCredentialsArn"));
    const httpAuthorizer = authorizerProvider.canonicalize({
      ApiId: httpApiId,
      AuthorizerResultTtlInSeconds: 0,
      AuthorizerType: "JWT",
      IdentitySource: ["$request.header.Authorization"],
      JwtConfiguration: { Audience: ["web", "mobile"], Issuer: "https://issuer.example.test/" },
      Name: "cfn12-jwt",
    }, authorizerContext);
    const httpAuthorizerCreated = await createAndRead(authorizerProvider, httpAuthorizer, authorizerContext);
    const updatedHttpAuthorizer = authorizerProvider.canonicalize({
      ApiId: httpApiId,
      AuthorizerResultTtlInSeconds: 0,
      AuthorizerType: "JWT",
      IdentitySource: ["$request.header.Authorization"],
      JwtConfiguration: { Audience: ["admin", "web"], Issuer: "https://issuer.example.test" },
      Name: "cfn12-jwt-updated",
    }, authorizerContext);
    await updateAndRead(authorizerProvider, httpAuthorizerCreated.physicalId, httpAuthorizer, updatedHttpAuthorizer, authorizerContext);
    const requestAuthorizer = authorizerProvider.canonicalize({
      ApiId: httpApiId,
      AuthorizerPayloadFormatVersion: "2.0",
      AuthorizerResultTtlInSeconds: 0,
      AuthorizerType: "REQUEST",
      AuthorizerUri: `arn:aws:lambda:${region}:${accountId}:function:cfn12-authorizer`,
      IdentitySource: ["$request.header.Authorization"],
      Name: "cfn12-jwt-updated",
    }, authorizerContext);
    assertReplacement(authorizerProvider, updatedHttpAuthorizer, requestAuthorizer, authorizerContext, "AuthorizerType", "DELETE_BEFORE_CREATE");

    const routeContext = context("HttpRoute");
    const httpRoute = routeProvider.canonicalize({
      ApiId: httpApiId,
      AuthorizationType: "NONE",
      OperationName: "listItems",
      RouteKey: "GET /items",
      Target: `integrations/${httpIntegrationId}`,
    }, routeContext);
    const httpRouteCreated = await createAndRead(routeProvider, httpRoute, routeContext);
    const httpRouteId = String(httpRouteCreated.model.attributes.RouteId);
    const updatedHttpRoute = routeProvider.canonicalize({
      ApiId: httpApiId,
      AuthorizationType: "NONE",
      OperationName: "listItemsV2",
      RouteKey: "GET /items",
      Target: `integrations/${httpIntegrationId}`,
    }, routeContext);
    await updateAndRead(routeProvider, httpRouteCreated.physicalId, httpRoute, updatedHttpRoute, routeContext);
    assertReplacement(
      routeProvider,
      updatedHttpRoute,
      routeProvider.canonicalize({ ...updatedHttpRoute, ApiId: "replacement-api" }, routeContext),
      routeContext,
      "ApiId",
      "CREATE_BEFORE_DELETE",
    );

    const deploymentContext = context("HttpDeployment");
    const deployment = deploymentProvider.canonicalize({ ApiId: httpApiId, Description: "HTTP snapshot" }, deploymentContext);
    const deploymentCreated = await createAndRead(deploymentProvider, deployment, deploymentContext);
    assert.equal((await client.send(new GetDeploymentsCommand({ ApiId: httpApiId, MaxResults: "500" }))).Items?.length, 1, "deployment create replay must not duplicate backing state");
    assert.equal(deploymentProvider.plan(deployment, deployment, deploymentContext).action, "NO_OP");
    requireSuccess(await deploymentProvider.update(deploymentCreated.physicalId, deployment, deployment, deploymentContext));
    requireSuccess(await deploymentProvider.read(deploymentCreated.physicalId, deploymentContext));
    const replacementDeployment = deploymentProvider.canonicalize({ ApiId: httpApiId, Description: "replacement snapshot" }, deploymentContext);
    assertReplacement(deploymentProvider, deployment, replacementDeployment, deploymentContext, "Description", "CREATE_BEFORE_DELETE");
    const failedHttpDeploymentContext = context("FailedHttpDeployment");
    const failedHttpDeployment = deploymentProvider.canonicalize({ ApiId: httpApiId, Description: "must remain atomic", StageName: "missing-stage" }, failedHttpDeploymentContext);
    const httpDeploymentCountBeforeFailure = (await client.send(new GetDeploymentsCommand({ ApiId: httpApiId, MaxResults: "500" }))).Items?.length;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await deploymentProvider.create(failedHttpDeployment, failedHttpDeploymentContext);
      assert.equal(result.status, "FAILED");
      if (result.status === "FAILED") assert.match(result.message, /stage/i);
    }
    assert.equal((await client.send(new GetDeploymentsCommand({ ApiId: httpApiId, MaxResults: "500" }))).Items?.length, httpDeploymentCountBeforeFailure, "a failed HTTP deployment retry must not publish a partial deployment");

    const stageContext = context("HttpStage");
    const stage = stageProvider.canonicalize({
      ApiId: httpApiId,
      DefaultRouteSettings: { DetailedMetricsEnabled: true, ThrottlingBurstLimit: 10, ThrottlingRateLimit: 5 },
      DeploymentId: String(deploymentCreated.model.attributes.DeploymentId),
      Description: "initial stage",
      StageName: "dev",
      StageVariables: { Version: "one" },
      Tags: { team: "platform" },
    }, stageContext);
    const stageCreated = await createAndRead(stageProvider, stage, stageContext);
    assert.equal((await client.send(new GetStagesCommand({ ApiId: httpApiId, MaxResults: "500" }))).Items?.length, 1, "stage create replay must not duplicate backing state");
    const unrelatedStageCollision = await stageProvider.create(stage, context("UnrelatedStageOwner"));
    assert.equal(unrelatedStageCollision.status, "FAILED");
    assert.equal(unrelatedStageCollision.errorCode, "ConflictException", "a natural-name stage must not be adopted by another operation token");
    const updatedStage = stageProvider.canonicalize({
      ApiId: httpApiId,
      DefaultRouteSettings: { DetailedMetricsEnabled: false, ThrottlingBurstLimit: 20, ThrottlingRateLimit: 10 },
      DeploymentId: String(deploymentCreated.model.attributes.DeploymentId),
      Description: "updated stage",
      StageName: "dev",
      StageVariables: { Version: "two" },
      Tags: { team: "services" },
    }, stageContext);
    await updateAndRead(stageProvider, stageCreated.physicalId, stage, updatedStage, stageContext);
    await assert.rejects(
      client.send(new UpdateStageCommand({
        ApiId: httpApiId,
        StageName: "dev",
        Description: "must-not-partially-commit",
        StageVariables: { Invalid: "" },
      })),
      (error: any) => error?.name === "BadRequestException",
    );
    assert.equal((await client.send(new GetStageCommand({ ApiId: httpApiId, StageName: "dev" }))).Description, "updated stage");
    assertReplacement(
      stageProvider,
      updatedStage,
      stageProvider.canonicalize({ ...updatedStage, StageName: "prod" }, stageContext),
      stageContext,
      "StageName",
      "DELETE_BEFORE_CREATE",
    );

    const domainContext = context("HttpDomain");
    const domain = domainProvider.canonicalize({
      DomainName: "cfn12.example.test",
      DomainNameConfigurations: [{
        CertificateArn: `arn:aws:acm:${region}:${accountId}:certificate/cfn12-certificate`,
        EndpointType: "REGIONAL",
        IpAddressType: "ipv4",
        SecurityPolicy: "TLS_1_2",
      }],
      RoutingMode: "API_MAPPING_ONLY",
      Tags: { team: "platform" },
    }, domainContext);
    const domainCreated = await createAndRead(domainProvider, domain, domainContext);
    assert.equal((await client.send(new GetDomainNamesCommand({ MaxResults: "500" }))).Items?.length, 1, "domain create replay must not duplicate backing state");
    const unrelatedDomainCollision = await domainProvider.create(domain, context("UnrelatedDomainOwner"));
    assert.equal(unrelatedDomainCollision.status, "FAILED");
    assert.equal(unrelatedDomainCollision.errorCode, "ConflictException", "a natural-name domain must not be adopted by another operation token");
    const updatedDomain = domainProvider.canonicalize({
      ...domain,
      RoutingMode: "ROUTING_RULE_THEN_API_MAPPING",
      Tags: { team: "services" },
    }, domainContext);
    await updateAndRead(domainProvider, domainCreated.physicalId, domain, updatedDomain, domainContext);
    assertReplacement(
      domainProvider,
      updatedDomain,
      domainProvider.canonicalize({ ...updatedDomain, DomainName: "replacement.example.test" }, domainContext),
      domainContext,
      "DomainName",
      "DELETE_BEFORE_CREATE",
    );

    const mappingContext = context("HttpMapping");
    const mapping = mappingProvider.canonicalize({
      ApiId: httpApiId,
      ApiMappingKey: "/v1/",
      DomainName: domain.DomainName,
      Stage: stage.StageName,
    }, mappingContext);
    const mappingCreated = await createAndRead(mappingProvider, mapping, mappingContext);
    const updatedMapping = mappingProvider.canonicalize({ ...mapping, ApiMappingKey: "v2" }, mappingContext);
    await updateAndRead(mappingProvider, mappingCreated.physicalId, mapping, updatedMapping, mappingContext);
    assertReplacement(
      mappingProvider,
      updatedMapping,
      mappingProvider.canonicalize({ ...updatedMapping, DomainName: "replacement.example.test" }, mappingContext),
      mappingContext,
      "DomainName",
      "CREATE_BEFORE_DELETE",
    );

    const blockedModel = modelProvider.canonicalize({
      ApiId: httpApiId,
      Name: "BlockedModel",
      Schema: { type: "object" },
    }, context("BlockedModel"));
    const blockedModelResult = await modelProvider.create(blockedModel, context("BlockedModel"));
    assert.equal(blockedModelResult.status, "FAILED");
    assert.equal(blockedModelResult.errorCode, "BadRequestException");
    assert.match(blockedModelResult.message, /supported only for WebSocket APIs/);

    const blockedIntegrationResponse = integrationResponseProvider.canonicalize({
      ApiId: httpApiId,
      IntegrationId: httpIntegrationId,
      IntegrationResponseKey: "$default",
    }, context("BlockedIntegrationResponse"));
    const blockedIntegrationResponseResult = await integrationResponseProvider.create(blockedIntegrationResponse, context("BlockedIntegrationResponse"));
    assert.equal(blockedIntegrationResponseResult.status, "FAILED");
    assert.equal(blockedIntegrationResponseResult.errorCode, "BadRequestException");
    assert.match(blockedIntegrationResponseResult.message, /supported only for WebSocket APIs/);

    const blockedRouteResponse = routeResponseProvider.canonicalize({
      ApiId: httpApiId,
      RouteId: httpRouteId,
      RouteResponseKey: "$default",
    }, context("BlockedRouteResponse"));
    const blockedRouteResponseResult = await routeResponseProvider.create(blockedRouteResponse, context("BlockedRouteResponse"));
    assert.equal(blockedRouteResponseResult.status, "FAILED");
    assert.equal(blockedRouteResponseResult.errorCode, "BadRequestException");
    assert.match(blockedRouteResponseResult.message, /supported only for WebSocket APIs/);

    const websocketApiContext = context("WebSocketApi");
    const websocketApi = apiProvider.canonicalize({
      Name: "cfn12-websocket-api",
      ProtocolType: "WEBSOCKET",
      Description: "WebSocket lifecycle API",
      RouteSelectionExpression: "$request.body.action",
      Tags: { team: "realtime" },
    }, websocketApiContext);
    const websocketApiCreated = await createAndRead(apiProvider, websocketApi, websocketApiContext);
    const websocketApiId = String(websocketApiCreated.model.attributes.ApiId);
    assert.equal((await client.send(new GetApisCommand({ MaxResults: "500" }))).Items?.length, 2, "WebSocket API create replay must not duplicate backing state");
    const authoritativeWebSocketApi = await client.send(new GetApiCommand({ ApiId: websocketApiId }));
    assert.equal(websocketApiCreated.model.attributes.ApiEndpoint, authoritativeWebSocketApi.ApiEndpoint);
    assert.match(String(authoritativeWebSocketApi.ApiEndpoint), /^ws:\/\//);
    await assert.rejects(
      client.send(new UpdateApiCommand({
        ApiId: websocketApiId,
        Name: "must-not-partially-commit",
        RouteSelectionExpression: "$request.header.invalid",
      })),
      (error: any) => error?.name === "BadRequestException",
    );
    assert.equal((await client.send(new GetApiCommand({ ApiId: websocketApiId }))).Name, "cfn12-websocket-api");
    const failedWebSocketDeploymentContext = context("FailedWebSocketDeployment");
    const failedWebSocketDeployment = deploymentProvider.canonicalize({ ApiId: websocketApiId, Description: "must remain atomic", StageName: "missing-stage" }, failedWebSocketDeploymentContext);
    const webSocketDeploymentCountBeforeFailure = (await client.send(new GetDeploymentsCommand({ ApiId: websocketApiId, MaxResults: "500" }))).Items?.length;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await deploymentProvider.create(failedWebSocketDeployment, failedWebSocketDeploymentContext);
      assert.equal(result.status, "FAILED");
      if (result.status === "FAILED") assert.match(result.message, /stage/i);
    }
    assert.equal((await client.send(new GetDeploymentsCommand({ ApiId: websocketApiId, MaxResults: "500" }))).Items?.length, webSocketDeploymentCountBeforeFailure, "a failed WebSocket deployment retry must not publish a partial deployment");

    const websocketIntegrationContext = context("WebSocketIntegration");
    const websocketIntegration = integrationProvider.canonicalize({
      ApiId: websocketApiId,
      Description: "initial mock integration",
      IntegrationType: "MOCK",
      PassthroughBehavior: "WHEN_NO_MATCH",
      RequestTemplates: { "application/json": "{\"statusCode\":200}" },
      TemplateSelectionExpression: "$request.body.template",
      TimeoutInMillis: 29_000,
    }, websocketIntegrationContext);
    const websocketIntegrationCreated = await createAndRead(integrationProvider, websocketIntegration, websocketIntegrationContext);
    const websocketIntegrationId = String(websocketIntegrationCreated.model.attributes.IntegrationId);
    const updatedWebSocketIntegration = integrationProvider.canonicalize({
      ...websocketIntegration,
      Description: "updated mock integration",
      RequestTemplates: { "application/json": "{\"statusCode\":201}" },
    }, websocketIntegrationContext);
    await updateAndRead(
      integrationProvider,
      websocketIntegrationCreated.physicalId,
      websocketIntegration,
      updatedWebSocketIntegration,
      websocketIntegrationContext,
    );

    const modelContext = context("WebSocketModel");
    const model = modelProvider.canonicalize({
      ApiId: websocketApiId,
      ContentType: "application/json",
      Description: "initial message model",
      Name: "Message",
      Schema: { properties: { action: { type: "string" } }, required: ["action"], type: "object" },
    }, modelContext);
    const modelCreated = await createAndRead(modelProvider, model, modelContext);
    assert.equal((await client.send(new GetModelsCommand({ ApiId: websocketApiId, MaxResults: "500" }))).Items?.length, 1, "WebSocket-only model replay must not duplicate backing state");
    const modelId = String(modelCreated.model.attributes.ModelId);
    await assert.rejects(
      client.send(new UpdateModelCommand({ ApiId: websocketApiId, ModelId: modelId, Name: "must-not-partially-commit", Schema: "{" })),
      (error: any) => error?.name === "BadRequestException",
    );
    assert.equal((await client.send(new GetModelCommand({ ApiId: websocketApiId, ModelId: modelId }))).Name, "Message");
    const updatedModel = modelProvider.canonicalize({
      ...model,
      Description: "updated message model",
      Schema: { properties: { action: { type: "string" }, payload: { type: "object" } }, required: ["action"], type: "object" },
    }, modelContext);
    await updateAndRead(modelProvider, modelCreated.physicalId, model, updatedModel, modelContext);
    assertReplacement(
      modelProvider,
      updatedModel,
      modelProvider.canonicalize({ ...updatedModel, ApiId: "replacement-api" }, modelContext),
      modelContext,
      "ApiId",
      "CREATE_BEFORE_DELETE",
    );

    const websocketRouteContext = context("WebSocketRoute");
    const websocketRoute = routeProvider.canonicalize({
      ApiId: websocketApiId,
      AuthorizationType: "NONE",
      ModelSelectionExpression: "$request.body.model",
      OperationName: "sendMessage",
      RequestModels: { "$default": "Message" },
      RequestParameters: { "route.request.header.x-token": { Required: false } },
      RouteKey: "send",
      RouteResponseSelectionExpression: "$default",
      Target: `integrations/${websocketIntegrationId}`,
    }, websocketRouteContext);
    const websocketRouteCreated = await createAndRead(routeProvider, websocketRoute, websocketRouteContext);
    const websocketRouteId = String(websocketRouteCreated.model.attributes.RouteId);
    const updatedWebSocketRoute = routeProvider.canonicalize({
      ...websocketRoute,
      OperationName: "sendMessageV2",
      RequestParameters: { "route.request.header.x-token": { Required: true } },
    }, websocketRouteContext);
    await updateAndRead(routeProvider, websocketRouteCreated.physicalId, websocketRoute, updatedWebSocketRoute, websocketRouteContext);

    const integrationResponseContext = context("WebSocketIntegrationResponse");
    const integrationResponse = integrationResponseProvider.canonicalize({
      ApiId: websocketApiId,
      IntegrationId: websocketIntegrationId,
      IntegrationResponseKey: "$default",
      ResponseParameters: { "integration.response.header.x-cfn12": "'initial'" },
      ResponseTemplates: { "application/json": "{\"accepted\":true}" },
      TemplateSelectionExpression: "$request.body.template",
    }, integrationResponseContext);
    const integrationResponseCreated = await createAndRead(integrationResponseProvider, integrationResponse, integrationResponseContext);
    const updatedIntegrationResponse = integrationResponseProvider.canonicalize({
      ...integrationResponse,
      ContentHandlingStrategy: "CONVERT_TO_TEXT",
      ResponseParameters: { "integration.response.header.x-cfn12": "'updated'" },
      ResponseTemplates: { "application/json": "{\"accepted\":true,\"version\":2}" },
    }, integrationResponseContext);
    await updateAndRead(
      integrationResponseProvider,
      integrationResponseCreated.physicalId,
      integrationResponse,
      updatedIntegrationResponse,
      integrationResponseContext,
    );
    assertReplacement(
      integrationResponseProvider,
      updatedIntegrationResponse,
      integrationResponseProvider.canonicalize({ ...updatedIntegrationResponse, IntegrationId: "replacement-integration" }, integrationResponseContext),
      integrationResponseContext,
      "IntegrationId",
      "CREATE_BEFORE_DELETE",
    );

    const routeResponseContext = context("WebSocketRouteResponse");
    const routeResponse = routeResponseProvider.canonicalize({
      ApiId: websocketApiId,
      ModelSelectionExpression: "$request.body.model",
      ResponseModels: { "$default": "Message" },
      ResponseParameters: { "route.response.header.x-result": { Required: false } },
      RouteId: websocketRouteId,
      RouteResponseKey: "$default",
    }, routeResponseContext);
    const routeResponseCreated = await createAndRead(routeResponseProvider, routeResponse, routeResponseContext);
    const updatedRouteResponse = routeResponseProvider.canonicalize({
      ...routeResponse,
      ModelSelectionExpression: "$request.body.updatedModel",
      ResponseParameters: { "route.response.header.x-result": { Required: true } },
    }, routeResponseContext);
    await updateAndRead(
      routeResponseProvider,
      routeResponseCreated.physicalId,
      routeResponse,
      updatedRouteResponse,
      routeResponseContext,
    );
    assertReplacement(
      routeResponseProvider,
      updatedRouteResponse,
      routeResponseProvider.canonicalize({ ...updatedRouteResponse, RouteId: "replacement-route" }, routeResponseContext),
      routeResponseContext,
      "RouteId",
      "CREATE_BEFORE_DELETE",
    );

    requireSuccess(await routeResponseProvider.delete(routeResponseCreated.physicalId, updatedRouteResponse, routeResponseContext));
    assert.equal((await routeResponseProvider.read(routeResponseCreated.physicalId, routeResponseContext)).status, "NOT_FOUND");
    requireSuccess(await integrationResponseProvider.delete(integrationResponseCreated.physicalId, updatedIntegrationResponse, integrationResponseContext));
    assert.equal((await integrationResponseProvider.read(integrationResponseCreated.physicalId, integrationResponseContext)).status, "NOT_FOUND");
    requireSuccess(await routeProvider.delete(websocketRouteCreated.physicalId, updatedWebSocketRoute, websocketRouteContext));
    assert.equal((await routeProvider.read(websocketRouteCreated.physicalId, websocketRouteContext)).status, "NOT_FOUND");
    requireSuccess(await modelProvider.delete(modelCreated.physicalId, updatedModel, modelContext));
    assert.equal((await modelProvider.read(modelCreated.physicalId, modelContext)).status, "NOT_FOUND");
    requireSuccess(await integrationProvider.delete(websocketIntegrationCreated.physicalId, updatedWebSocketIntegration, websocketIntegrationContext));
    assert.equal((await integrationProvider.read(websocketIntegrationCreated.physicalId, websocketIntegrationContext)).status, "NOT_FOUND");
    requireSuccess(await apiProvider.delete(websocketApiCreated.physicalId, websocketApi, websocketApiContext));
    assert.equal((await apiProvider.read(websocketApiCreated.physicalId, websocketApiContext)).status, "NOT_FOUND");

    requireSuccess(await mappingProvider.delete(mappingCreated.physicalId, updatedMapping, mappingContext));
    assert.equal((await mappingProvider.read(mappingCreated.physicalId, mappingContext)).status, "NOT_FOUND");
    requireSuccess(await domainProvider.delete(domainCreated.physicalId, updatedDomain, domainContext));
    assert.equal((await domainProvider.read(domainCreated.physicalId, domainContext)).status, "NOT_FOUND");
    requireSuccess(await stageProvider.delete(stageCreated.physicalId, updatedStage, stageContext));
    assert.equal((await stageProvider.read(stageCreated.physicalId, stageContext)).status, "NOT_FOUND");
    requireSuccess(await deploymentProvider.delete(deploymentCreated.physicalId, deployment, deploymentContext));
    assert.equal((await deploymentProvider.read(deploymentCreated.physicalId, deploymentContext)).status, "NOT_FOUND");
    requireSuccess(await routeProvider.delete(httpRouteCreated.physicalId, updatedHttpRoute, routeContext));
    assert.equal((await routeProvider.read(httpRouteCreated.physicalId, routeContext)).status, "NOT_FOUND");
    requireSuccess(await authorizerProvider.delete(httpAuthorizerCreated.physicalId, updatedHttpAuthorizer, authorizerContext));
    assert.equal((await authorizerProvider.read(httpAuthorizerCreated.physicalId, authorizerContext)).status, "NOT_FOUND");
    requireSuccess(await integrationProvider.delete(httpIntegrationCreated.physicalId, updatedHttpIntegration, integrationContext));
    assert.equal((await integrationProvider.read(httpIntegrationCreated.physicalId, integrationContext)).status, "NOT_FOUND");
    requireSuccess(await apiProvider.delete(httpApiCreated.physicalId, updatedHttpApi, httpApiContext));
    assert.equal((await apiProvider.read(httpApiCreated.physicalId, httpApiContext)).status, "NOT_FOUND");
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("CFN-12 API Gateway v2 runtime revalidates API Gateway role trust after resources are deployed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn12-runtime-trust-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off"});
  let client: ApiGatewayV2Client | undefined;
  try {
    await simulator.start();
    client = new ApiGatewayV2Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });

    const trustedPolicy = {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "sts:AssumeRole" }],
    };
    const deniedPolicy = {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
    };
    const roleName = "cfn12-runtime-gateway";
    const role = await simulator.iam.CreateRole({ RoleName: roleName, AssumeRolePolicyDocument: trustedPolicy });
    const roleArn = String(role.Role.Arn);
    const disconnectRoleName = "cfn12-runtime-disconnect";
    const disconnectRole = await simulator.iam.CreateRole({ RoleName: disconnectRoleName, AssumeRolePolicyDocument: trustedPolicy });
    const disconnectRoleArn = String(disconnectRole.Role.Arn);
    await simulator.iam.PutRolePolicy({
      RoleName: roleName,
      PolicyName: "invoke-and-send",
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["lambda:InvokeFunction", "sqs:SendMessage"], Resource: "*" }],
      },
    });
    const queueUrl = String((await simulator.sqs.CreateQueue({ QueueName: "cfn12-runtime-trust" })).QueueUrl);

    const httpApi = await client.send(new CreateApiCommand({ Name: "cfn12-runtime-trust-http", ProtocolType: "HTTP" }));
    const lambdaIntegration = await client.send(new CreateIntegrationCommand({
      ApiId: httpApi.ApiId,
      CredentialsArn: roleArn,
      IntegrationType: "AWS_PROXY",
      IntegrationUri: `arn:aws:lambda:${region}:${accountId}:function:cfn12-missing-integration`,
      PayloadFormatVersion: "2.0",
    }));
    const authorizerTarget = await client.send(new CreateIntegrationCommand({
      ApiId: httpApi.ApiId,
      IntegrationType: "AWS_PROXY",
      IntegrationUri: `arn:aws:lambda:${region}:${accountId}:function:cfn12-missing-authorizer-target`,
      PayloadFormatVersion: "2.0",
    }));
    const authorizer = await client.send(new CreateAuthorizerCommand({
      ApiId: httpApi.ApiId,
      AuthorizerCredentialsArn: roleArn,
      AuthorizerPayloadFormatVersion: "2.0",
      AuthorizerResultTtlInSeconds: 0,
      AuthorizerType: "REQUEST",
      AuthorizerUri: `arn:aws:lambda:${region}:${accountId}:function:cfn12-missing-authorizer`,
      EnableSimpleResponses: true,
      IdentitySource: ["$request.header.Authorization"],
      Name: "cfn12-runtime-authorizer",
    }));
    const sqsIntegration = await client.send(new CreateIntegrationCommand({
      ApiId: httpApi.ApiId,
      CredentialsArn: roleArn,
      IntegrationSubtype: "SQS-SendMessage",
      IntegrationType: "AWS_PROXY",
      PayloadFormatVersion: "1.0",
      RequestParameters: { MessageBody: "'must-not-send'", QueueUrl: `'${queueUrl}'`, Region: region },
    }));
    await client.send(new CreateRouteCommand({ ApiId: httpApi.ApiId, RouteKey: "GET /lambda", Target: `integrations/${lambdaIntegration.IntegrationId}` }));
    await client.send(new CreateRouteCommand({ ApiId: httpApi.ApiId, RouteKey: "GET /authorized", AuthorizationType: "CUSTOM", AuthorizerId: authorizer.AuthorizerId, Target: `integrations/${authorizerTarget.IntegrationId}` }));
    await client.send(new CreateRouteCommand({ ApiId: httpApi.ApiId, RouteKey: "POST /queue", Target: `integrations/${sqsIntegration.IntegrationId}` }));
    const httpDeployment = await client.send(new CreateDeploymentCommand({ ApiId: httpApi.ApiId }));
    await client.send(new CreateStageCommand({ ApiId: httpApi.ApiId, StageName: "dev", DeploymentId: httpDeployment.DeploymentId }));

    const webSocketIntegrationApi = await client.send(new CreateApiCommand({ Name: "cfn12-runtime-trust-ws-integration", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action" }));
    const webSocketIntegration = await client.send(new CreateIntegrationCommand({
      ApiId: webSocketIntegrationApi.ApiId,
      CredentialsArn: roleArn,
      IntegrationMethod: "POST",
      IntegrationType: "AWS_PROXY",
      IntegrationUri: `arn:aws:lambda:${region}:${accountId}:function:cfn12-missing-websocket-integration`,
    }));
    const webSocketDisconnectIntegration = await client.send(new CreateIntegrationCommand({
      ApiId: webSocketIntegrationApi.ApiId,
      CredentialsArn: disconnectRoleArn,
      IntegrationMethod: "POST",
      IntegrationType: "AWS_PROXY",
      IntegrationUri: `arn:aws:lambda:${region}:${accountId}:function:cfn12-missing-websocket-disconnect`,
    }));
    await client.send(new CreateRouteCommand({ ApiId: webSocketIntegrationApi.ApiId, RouteKey: "$connect", Target: `integrations/${webSocketIntegration.IntegrationId}` }));
    await client.send(new CreateRouteCommand({ ApiId: webSocketIntegrationApi.ApiId, RouteKey: "$disconnect", Target: `integrations/${webSocketDisconnectIntegration.IntegrationId}` }));
    const webSocketIntegrationDeployment = await client.send(new CreateDeploymentCommand({ ApiId: webSocketIntegrationApi.ApiId }));
    await client.send(new CreateStageCommand({ ApiId: webSocketIntegrationApi.ApiId, StageName: "dev", DeploymentId: webSocketIntegrationDeployment.DeploymentId }));

    const webSocketAuthorizerApi = await client.send(new CreateApiCommand({ Name: "cfn12-runtime-trust-ws-authorizer", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action" }));
    const webSocketAuthorizer = await client.send(new CreateAuthorizerCommand({
      ApiId: webSocketAuthorizerApi.ApiId,
      AuthorizerCredentialsArn: roleArn,
      AuthorizerResultTtlInSeconds: 0,
      AuthorizerType: "REQUEST",
      AuthorizerUri: `arn:aws:lambda:${region}:${accountId}:function:cfn12-missing-websocket-authorizer`,
      IdentitySource: ["route.request.header.Authorization"],
      Name: "cfn12-runtime-websocket-authorizer",
    }));
    await client.send(new CreateRouteCommand({ ApiId: webSocketAuthorizerApi.ApiId, RouteKey: "$connect", AuthorizationType: "CUSTOM", AuthorizerId: webSocketAuthorizer.AuthorizerId }));
    const webSocketAuthorizerDeployment = await client.send(new CreateDeploymentCommand({ ApiId: webSocketAuthorizerApi.ApiId }));
    await client.send(new CreateStageCommand({ ApiId: webSocketAuthorizerApi.ApiId, StageName: "dev", DeploymentId: webSocketAuthorizerDeployment.DeploymentId }));

    await simulator.iam.UpdateAssumeRolePolicy({ RoleName: roleName, PolicyDocument: deniedPolicy });

    const httpBase = `http://127.0.0.1:${simulator.invokePort}/${httpApi.ApiId}/dev`;
    assert.equal((await fetch(`${httpBase}/lambda`)).status, 500, "a deployed role-backed HTTP Lambda integration must re-check role trust");
    assert.equal((await fetch(`${httpBase}/authorized`, { headers: { authorization: "allow" } })).status, 500, "a deployed HTTP Lambda authorizer must re-check role trust");
    assert.equal((await fetch(`${httpBase}/queue`, { method: "POST" })).status, 500, "a deployed HTTP SQS integration must re-check role trust");
    assert.equal((await simulator.sqs.ReceiveMessage({ QueueUrl: queueUrl })).Messages, undefined, "the SQS dispatch must not occur after trust is revoked");

    await expectWebSocketUpgradeStatus(`ws://127.0.0.1:${simulator.invokePort}/${webSocketIntegrationApi.ApiId}/dev`, 500);
    await expectWebSocketUpgradeStatus(`ws://127.0.0.1:${simulator.invokePort}/${webSocketAuthorizerApi.ApiId}/dev`, 500, { authorization: "allow" });

    const webSocketState = simulator.store.regionState(region).webSocketApis[webSocketIntegrationApi.ApiId!];
    const deployed = webSocketState.deployments[webSocketIntegrationDeployment.DeploymentId!];
    const disconnectRoute = Object.values(deployed.snapshot.routes).find(route => route.routeKey === "$disconnect")!;
    await assert.rejects(
      (simulator.apigatewaywebsocket as any).invokeDisconnect({ snapshot: deployed.snapshot }, disconnectRoute, 1000, "test"),
      (error: any) => error?.status === 500 && /integration role cannot invoke the Lambda function/.test(error.message),
      "a deployed WebSocket disconnect integration must re-check role permissions even while trust remains valid",
    );
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
