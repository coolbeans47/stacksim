import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APIGatewayClient, GetMethodCommand, GetRestApiCommand, GetStageCommand, GetStagesCommand, GetTagsCommand } from "@aws-sdk/client-api-gateway";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStackEventsCommand, DescribeStacksCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import {
  API_GATEWAY_DEPLOYMENT_TYPE, API_GATEWAY_METHOD_TYPE, API_GATEWAY_REST_API_TYPE, API_GATEWAY_STAGE_TYPE, createApiGatewayRestCloudFormationProviders,
} from "../src/cloudformation/providers/apigateway-rest.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const accountId = "000000000000";
const identity: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };

function context(logicalId: string): ProviderContext {
  return {
    accountId, region, partition: "aws", stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/inline-stage/stack-id`, logicalId,
    operationId: `operation-${logicalId}`, resourceOperationId: `resource-${logicalId}`, idempotencyKey: `idempotency-${logicalId}`,
    deadlineAt: Date.now() + 60_000, principal: { identity },
  };
}

/** Validation and canonicalization never reach the service, except Method integration checks, which this stub accepts. */
function offlineProviders(): Record<string, any> {
  const service = { validateCloudFormationIntegration() {} } as any;
  return Object.fromEntries(createApiGatewayRestCloudFormationProviders(service).map(provider => [provider.typeName, provider]));
}

async function waitForStack(cloudformation: CloudFormationClient, stackName: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const status = (await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus;
    if (status === expected) return;
    if (status && /(FAILED|ROLLBACK_COMPLETE)$/.test(status) && status !== expected) {
      const events = (await cloudformation.send(new DescribeStackEventsCommand({ StackName: stackName }))).StackEvents ?? [];
      throw new Error(`${stackName} reached ${status}: ${events.filter(event => event.ResourceStatusReason).map(event => `${event.LogicalResourceId}: ${event.ResourceStatusReason}`).join(" | ")}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

async function outputs(cloudformation: CloudFormationClient, stackName: string): Promise<Record<string, string>> {
  const stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks![0];
  return Object.fromEntries((stack.Outputs ?? []).map(output => [output.OutputKey!, output.OutputValue!]));
}

/** The AWS::ApiGateway::Deployment documentation pattern: a MOCK method deployed straight to a stage named by the Deployment. */
function docsTemplate(deployment: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Resources: {
      Api: { Type: "AWS::ApiGateway::RestApi", Properties: { Name: "inline-stage-api" } },
      Hello: { Type: "AWS::ApiGateway::Resource", Properties: { RestApiId: { Ref: "Api" }, ParentId: { "Fn::GetAtt": ["Api", "RootResourceId"] }, PathPart: "hello" } },
      HelloGet: {
        Type: "AWS::ApiGateway::Method",
        Properties: {
          RestApiId: { Ref: "Api" }, ResourceId: { Ref: "Hello" }, HttpMethod: "GET", AuthorizationType: "NONE",
          Integration: { Type: "MOCK", RequestTemplates: { "application/json": "{\"statusCode\": 200}" }, IntegrationResponses: [{ StatusCode: "200", ResponseTemplates: { "application/json": "{\"message\": \"hello\"}" } }] },
          MethodResponses: [{ StatusCode: "200" }],
        },
      },
      Deployment: { Type: "AWS::ApiGateway::Deployment", DependsOn: "HelloGet", Properties: { RestApiId: { Ref: "Api" }, ...deployment } },
      ...extra,
    },
    Outputs: { ApiId: { Value: { Ref: "Api" } }, DeploymentId: { Value: { Ref: "Deployment" } } },
  });
}

test("Deployment StageName creates, serves, reconfigures, renames, survives restart, and deletes its stage", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-inline-stage-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off" });
  let cloudformation: CloudFormationClient | undefined; let apiClient: APIGatewayClient | undefined;
  const clients = () => { const endpoint = `http://127.0.0.1:${simulator.port}`; cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 }); apiClient = new APIGatewayClient({ endpoint, region, credentials, maxAttempts: 1 }); };
  try {
    await simulator.start(); clients();
    const stackName = (await cloudformation!.send(new CreateStackCommand({ StackName: "inline-stage", TemplateBody: docsTemplate({ StageName: "prod" }) }))).StackId!;
    await waitForStack(cloudformation!, stackName, "CREATE_COMPLETE");
    const { ApiId: apiId, DeploymentId: deploymentId } = await outputs(cloudformation!, stackName);
    const created = await apiClient!.send(new GetStageCommand({ restApiId: apiId, stageName: "prod" }));
    assert.equal(created.deploymentId, deploymentId, "StageName creates the stage pointing at the deployment");
    const invoke = () => fetch(`http://127.0.0.1:${simulator.invokePort}/${apiId}/prod/hello`);
    let response = await invoke(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { message: "hello" });

    await simulator.stop(); cloudformation!.destroy(); apiClient!.destroy();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off" }); await simulator.start(); clients();
    response = await invoke(); assert.equal(response.status, 200, "the implicit stage is durable across restart");

    const stageDescription = {
      Description: "production", Variables: { color: "blue" }, TracingEnabled: true, MetricsEnabled: true, ThrottlingBurstLimit: 10, ThrottlingRateLimit: 5,
      MethodSettings: [{ ResourcePath: "/hello", HttpMethod: "GET", ThrottlingBurstLimit: 3 }], Tags: [{ Key: "env", Value: "prod" }],
    };
    await cloudformation!.send(new UpdateStackCommand({ StackName: stackName, TemplateBody: docsTemplate({ StageName: "prod", Description: "described", StageDescription: stageDescription }) }));
    await waitForStack(cloudformation!, stackName, "UPDATE_COMPLETE");
    assert.equal((await outputs(cloudformation!, stackName)).DeploymentId, deploymentId, "Description and StageDescription update without replacement");
    const configured = await apiClient!.send(new GetStageCommand({ restApiId: apiId, stageName: "prod" }));
    assert.equal(configured.description, "production"); assert.deepEqual(configured.variables, { color: "blue" }); assert.equal(configured.tracingEnabled, true);
    const stageWide = configured.methodSettings?.["*/*"];
    assert.deepEqual([stageWide?.metricsEnabled, stageWide?.throttlingBurstLimit, stageWide?.throttlingRateLimit], [true, 10, 5], "stage-wide StageDescription options apply to */*");
    assert.equal(configured.methodSettings?.["/hello/GET"]?.throttlingBurstLimit, 3);
    assert.deepEqual((await apiClient!.send(new GetTagsCommand({ resourceArn: `arn:aws:apigateway:${region}::/restapis/${apiId}/stages/prod` }))).tags, { env: "prod" });
    response = await invoke(); assert.equal(response.status, 200);

    await cloudformation!.send(new UpdateStackCommand({ StackName: stackName, TemplateBody: docsTemplate({ StageName: "live", Description: "described", StageDescription: stageDescription }) }));
    await waitForStack(cloudformation!, stackName, "UPDATE_COMPLETE");
    assert.equal((await outputs(cloudformation!, stackName)).DeploymentId, deploymentId, "a StageName change does not replace the deployment");
    assert.deepEqual((await apiClient!.send(new GetStagesCommand({ restApiId: apiId }))).item?.map(stage => [stage.stageName, stage.deploymentId]), [["live", deploymentId]], "the renamed stage replaces the old implicit stage");
    response = await fetch(`http://127.0.0.1:${simulator.invokePort}/${apiId}/live/hello`); assert.equal(response.status, 200);

    await cloudformation!.send(new DeleteStackCommand({ StackName: stackName }));
    await waitForStack(cloudformation!, stackName, "DELETE_COMPLETE");
    await assert.rejects(apiClient!.send(new GetRestApiCommand({ restApiId: apiId })), (error: any) => error.name === "NotFoundException");
  } finally {
    cloudformation?.destroy(); apiClient?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true });
  }
});

test("A separate Stage with the Deployment's StageName fails like CreateStage, and a canary Deployment joins the existing stage", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-inline-conflict-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off" });
  let cloudformation: CloudFormationClient | undefined; let apiClient: APIGatewayClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 }); apiClient = new APIGatewayClient({ endpoint, region, credentials, maxAttempts: 1 });
    const conflictId = (await cloudformation.send(new CreateStackCommand({ StackName: "inline-conflict", TemplateBody: docsTemplate({ StageName: "prod" }, { ProdStage: { Type: "AWS::ApiGateway::Stage", Properties: { RestApiId: { Ref: "Api" }, DeploymentId: { Ref: "Deployment" }, StageName: "prod" } } }) }))).StackId!;
    await waitForStack(cloudformation, conflictId, "ROLLBACK_COMPLETE");
    const events = (await cloudformation.send(new DescribeStackEventsCommand({ StackName: conflictId }))).StackEvents ?? [];
    assert.ok(events.some(event => event.LogicalResourceId === "ProdStage" && event.ResourceStatus === "CREATE_FAILED" && /Stage already exists/.test(event.ResourceStatusReason ?? "")), JSON.stringify(events.map(event => [event.LogicalResourceId, event.ResourceStatus, event.ResourceStatusReason])));

    const canaryId = (await cloudformation.send(new CreateStackCommand({ StackName: "inline-canary", TemplateBody: docsTemplate({ StageName: "prod" }, {
      Canary: { Type: "AWS::ApiGateway::Deployment", DependsOn: "Deployment", Properties: { RestApiId: { Ref: "Api" }, StageName: "prod", DeploymentCanarySettings: { PercentTraffic: 25, StageVariableOverrides: { color: "green" } } } },
    }) }))).StackId!;
    await waitForStack(cloudformation, canaryId, "CREATE_COMPLETE");
    const { ApiId: apiId, DeploymentId: deploymentId } = await outputs(cloudformation, canaryId);
    const stage = await apiClient.send(new GetStageCommand({ restApiId: apiId, stageName: "prod" }));
    assert.equal(stage.deploymentId, deploymentId, "the canary deployment leaves the stage on its main deployment");
    assert.equal(stage.canarySettings?.percentTraffic, 25); assert.notEqual(stage.canarySettings?.deploymentId, deploymentId); assert.deepEqual(stage.canarySettings?.stageVariableOverrides, { color: "green" });
    await cloudformation.send(new DeleteStackCommand({ StackName: canaryId }));
    await waitForStack(cloudformation, canaryId, "DELETE_COMPLETE");
  } finally {
    cloudformation?.destroy(); apiClient?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true });
  }
});

test("Deployment StageName properties validate, canonicalize, and plan like the CloudFormation resource specification", () => {
  const providers = offlineProviders(); const deployments = providers[API_GATEWAY_DEPLOYMENT_TYPE];
  const paths = (properties: unknown) => deployments.validate(properties, context("Deployment")).map((value: any) => value.path);
  assert.deepEqual(paths({ RestApiId: "api", StageDescription: { Description: "x" } }), ["Properties.StageDescription"], "StageDescription requires StageName");
  assert.deepEqual(paths({ RestApiId: "api", StageName: "prod", DeploymentCanarySettings: { DeploymentId: "x" } }), ["Properties.DeploymentCanarySettings.DeploymentId"]);
  assert.deepEqual(paths({ RestApiId: "api", StageName: "prod", StageDescription: { Bogus: true, LoggingLevel: "LOUD", CacheTtlInSeconds: 4000 } }).sort(), ["Properties.StageDescription.Bogus", "Properties.StageDescription.CacheTtlInSeconds", "Properties.StageDescription.LoggingLevel"]);
  assert.deepEqual(paths({ RestApiId: "api", StageName: "bad name" }), ["Properties.StageName"]);
  assert.deepEqual(paths({ RestApiId: "api", StageName: "prod", StageDescription: { TracingEnabled: true, CanarySetting: { PercentTraffic: 10 }, AccessLogSetting: { DestinationArn: "arn:aws:logs:eu-west-1:000000000000:log-group:access", Format: "$context.requestId" }, CacheClusterEnabled: true, CacheClusterSize: "0.5", ClientCertificateId: "cert", DocumentationVersion: "v1" } }), []);

  const base = deployments.canonicalize({ RestApiId: "api", StageName: "prod", StageDescription: { LoggingLevel: "INFO", ThrottlingRateLimit: 5, MethodSettings: [{ ResourcePath: "/*", HttpMethod: "*", ThrottlingRateLimit: 9 }] } }, context("Deployment"));
  assert.deepEqual(base.StageDescription.MethodSettings, [{ ResourcePath: "/*", HttpMethod: "*", LoggingLevel: "INFO", ThrottlingRateLimit: 9 }], "stage-wide options fold into */*, and an explicit */* entry wins");
  const plan = (desired: Record<string, unknown>) => deployments.plan(base, deployments.canonicalize({ RestApiId: "api", StageName: "prod", StageDescription: { LoggingLevel: "INFO", ThrottlingRateLimit: 5, MethodSettings: [{ ResourcePath: "/*", HttpMethod: "*", ThrottlingRateLimit: 9 }] }, ...desired }, context("Deployment")), context("Deployment"));
  assert.equal(plan({ StageName: "live" }).action, "UPDATE"); assert.equal(plan({ Description: "new" }).action, "UPDATE"); assert.equal(plan({ StageDescription: { TracingEnabled: true } }).action, "UPDATE");
  const canaryPlan = plan({ DeploymentCanarySettings: { PercentTraffic: 10 } }); assert.equal(canaryPlan.action, "REPLACE"); assert.deepEqual(canaryPlan.replacementProperties, ["DeploymentCanarySettings"]);
});

test("CDK stage options plus methodOptions['/*/*'] merge into one MethodSetting, later values winning", () => {
  const stages = offlineProviders()[API_GATEWAY_STAGE_TYPE];
  /* CDK's Stage renders deployOptions throttling as one `/*` `*` entry and methodOptions['/*\/*'] as a second one; both deploy on AWS. */
  const properties = { RestApiId: "api", DeploymentId: "deployment", StageName: "prod", MethodSettings: [
    { ResourcePath: "/*", HttpMethod: "*", DataTraceEnabled: false, MetricsEnabled: true, ThrottlingBurstLimit: 100, ThrottlingRateLimit: 50 },
    { ResourcePath: "/*", HttpMethod: "*", DataTraceEnabled: false, LoggingLevel: "ERROR", ThrottlingRateLimit: 10 },
    { ResourcePath: "/items", HttpMethod: "get", CachingEnabled: true },
  ] };
  assert.deepEqual(stages.validate(properties, context("Stage")), []);
  assert.deepEqual(stages.canonicalize(properties, context("Stage")).MethodSettings, [
    { ResourcePath: "/*", HttpMethod: "*", DataTraceEnabled: false, MetricsEnabled: true, ThrottlingBurstLimit: 100, ThrottlingRateLimit: 10, LoggingLevel: "ERROR" },
    { ResourcePath: "/items", HttpMethod: "GET", CachingEnabled: true },
  ]);
});

test("RestApi EndpointConfiguration accepts EDGE and REGIONAL and keeps the control plane's PRIVATE boundary", async () => {
  const restApis = offlineProviders()[API_GATEWAY_REST_API_TYPE];
  const messages = (configuration: unknown) => restApis.validate({ Name: "endpoint", EndpointConfiguration: configuration }, context("Api")).map((value: any) => `${value.path}: ${value.message}`);
  assert.deepEqual(messages({ Types: ["EDGE"] }), []); assert.deepEqual(messages({ Types: ["REGIONAL"], IpAddressType: "dualstack" }), []);
  assert.match(messages({ Types: ["PRIVATE"], VpcEndpointIds: ["vpce-0123456789abcdef0"] }).join("\n"), /PRIVATE REST API endpoints are not supported by StackSim/);
  assert.match(messages({ Types: ["REGIONAL"], VpcEndpointIds: ["vpce-0123456789abcdef0"] }).join("\n"), /VpcEndpointIds can be associated only with a PRIVATE endpoint/);
  assert.match(messages({ Types: ["EDGE", "REGIONAL"] }).join("\n"), /exactly one/);
  assert.deepEqual(restApis.canonicalize({ EndpointConfiguration: {} }, context("Api")).EndpointConfiguration, { Types: ["EDGE"] }, "AWS defaults Types to EDGE");
  assert.equal(restApis.canonicalize({}, context("Api")).EndpointConfiguration, undefined, "an omitted EndpointConfiguration leaves the control plane default in place");

  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-endpoint-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off" });
  let cloudformation: CloudFormationClient | undefined; let apiClient: APIGatewayClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 }); apiClient = new APIGatewayClient({ endpoint, region, credentials, maxAttempts: 1 });
    const template = (types: string[]) => JSON.stringify({ Resources: { Api: { Type: "AWS::ApiGateway::RestApi", Properties: { Name: "edge-api", EndpointConfiguration: { Types: types } } } }, Outputs: { ApiId: { Value: { Ref: "Api" } } } });
    const edgeId = (await cloudformation.send(new CreateStackCommand({ StackName: "edge-endpoint", TemplateBody: template(["EDGE"]) }))).StackId!;
    await waitForStack(cloudformation, edgeId, "CREATE_COMPLETE");
    const { ApiId: apiId } = await outputs(cloudformation, edgeId);
    assert.deepEqual((await apiClient.send(new GetRestApiCommand({ restApiId: apiId }))).endpointConfiguration?.types, ["EDGE"], "the declared EDGE type is stored and echoed");
    await cloudformation.send(new UpdateStackCommand({ StackName: edgeId, TemplateBody: template(["REGIONAL"]) }));
    await waitForStack(cloudformation, edgeId, "UPDATE_COMPLETE");
    assert.equal((await outputs(cloudformation, edgeId)).ApiId, apiId, "an endpoint type change updates in place");
    assert.deepEqual((await apiClient.send(new GetRestApiCommand({ restApiId: apiId }))).endpointConfiguration?.types, ["REGIONAL"]);
    await cloudformation.send(new DeleteStackCommand({ StackName: edgeId }));
    await waitForStack(cloudformation, edgeId, "DELETE_COMPLETE");
  } finally {
    cloudformation?.destroy(); apiClient?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true });
  }
});

test("AWS service integrations validate through the shared REST target table and are created with Credentials and request mappings", async () => {
  const methods = offlineProviders()[API_GATEWAY_METHOD_TYPE];
  const base = { RestApiId: "api", ResourceId: "resource", HttpMethod: "POST", AuthorizationType: "NONE" };
  const role = `arn:aws:iam::${accountId}:role/apigateway-integration`;
  const integration = (uri: string, extra: Record<string, unknown> = {}) => methods.validate({ ...base, Integration: { Type: "AWS", IntegrationHttpMethod: "POST", Uri: uri, Credentials: role, ...extra } }, context("Method")).map((value: any) => value.message);
  for (const uri of [
    `arn:aws:apigateway:${region}:sns:action/Publish`, `arn:aws:apigateway:${region}:events:action/PutEvents`,
    `arn:aws:apigateway:${region}:states:action/StartExecution`, `arn:aws:apigateway:${region}:states:action/DescribeExecution`,
    `arn:aws:apigateway:${region}:s3:path/bucket/{key}`, `arn:aws:apigateway:${region}:sqs:path/${accountId}/queue`, `arn:aws:apigateway:${region}:dynamodb:action/PutItem`,
  ]) assert.deepEqual(integration(uri), [], uri);
  assert.deepEqual(methods.validate({ ...base, Integration: { Type: "AWS", IntegrationHttpMethod: "POST", Uri: `arn:aws:apigateway:${region}:sns:action/Publish` } }, context("Method")), [], "Credentials are optional, as in PutIntegration");
  assert.match(integration(`arn:aws:apigateway:${region}:states:action/StartSyncExecution`).join("\n"), /STANDARD state machines only/);
  assert.match(integration(`arn:aws:apigateway:${region}:kinesis:action/PutRecord`).join("\n"), /does not support the AWS integration/);
  assert.deepEqual(integration(`arn:aws:apigateway:${region}:sqs:path/${accountId}/queue`, { RequestParameters: { "integration.request.header.Content-Type": "'application/x-www-form-urlencoded'", "integration.request.querystring.Action": "'SendMessage'", "integration.request.path.id": "method.request.path.id" } }), []);
  assert.match(integration(`arn:aws:apigateway:${region}:sns:action/Publish`, { RequestParameters: { "method.request.header.x": "'y'" } }).join("\n"), /must be integration.request.header, querystring, or path/);

  const dataDir = await mkdtemp(join(tmpdir(), "stacksim-cfn-apig-service-integration-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, accountId, region, authMode: "off" });
  let cloudformation: CloudFormationClient | undefined; let apiClient: APIGatewayClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 }); apiClient = new APIGatewayClient({ endpoint, region, credentials, maxAttempts: 1 });
    const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "sts:AssumeRole" }] };
    const serviceId = (await cloudformation.send(new CreateStackCommand({ StackName: "service-integration", Capabilities: ["CAPABILITY_IAM"], TemplateBody: JSON.stringify({
      Resources: {
        Topic: { Type: "AWS::SNS::Topic" },
        Role: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: trust, Policies: [{ PolicyName: "publish", PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sns:Publish", Resource: { Ref: "Topic" } }] } }] } },
        Api: { Type: "AWS::ApiGateway::RestApi", Properties: { Name: "sns-api" } },
        Publish: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            RestApiId: { Ref: "Api" }, ResourceId: { "Fn::GetAtt": ["Api", "RootResourceId"] }, HttpMethod: "POST", AuthorizationType: "NONE",
            RequestParameters: { "method.request.querystring.message": true },
            Integration: {
              Type: "AWS", IntegrationHttpMethod: "POST", Uri: { "Fn::Sub": "arn:aws:apigateway:${AWS::Region}:sns:action/Publish" }, Credentials: { "Fn::GetAtt": ["Role", "Arn"] },
              RequestParameters: { "integration.request.querystring.TopicArn": { "Fn::Sub": "'${Topic}'" }, "integration.request.querystring.Message": "method.request.querystring.message" },
              IntegrationResponses: [{ StatusCode: "200" }],
            },
            MethodResponses: [{ StatusCode: "200" }],
          },
        },
      },
      Outputs: { ApiId: { Value: { Ref: "Api" } }, RootId: { Value: { "Fn::GetAtt": ["Api", "RootResourceId"] } }, RoleArn: { Value: { "Fn::GetAtt": ["Role", "Arn"] } } },
    }) }))).StackId!;
    await waitForStack(cloudformation, serviceId, "CREATE_COMPLETE");
    const { ApiId: apiId, RootId: rootId, RoleArn: roleArn } = await outputs(cloudformation, serviceId);
    const created = (await apiClient.send(new GetMethodCommand({ restApiId: apiId, resourceId: rootId, httpMethod: "POST" }))).methodIntegration;
    assert.equal(created?.uri, `arn:aws:apigateway:${region}:sns:action/Publish`); assert.equal(created?.credentials, roleArn);
    assert.equal(created?.requestParameters?.["integration.request.querystring.Message"], "method.request.querystring.message");
    await cloudformation.send(new DeleteStackCommand({ StackName: serviceId }));
    await waitForStack(cloudformation, serviceId, "DELETE_COMPLETE");
  } finally {
    cloudformation?.destroy(); apiClient?.destroy(); await simulator.stop().catch(() => undefined); await rm(dataDir, { recursive: true, force: true });
  }
});
