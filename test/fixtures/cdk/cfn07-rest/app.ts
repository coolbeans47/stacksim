import { App, CfnOutput, Duration, Stack, Tags } from "aws-cdk-lib";
import {
  ApiDefinition,
  ApiKey,
  CfnAccount,
  CfnUsagePlan,
  Deployment,
  EndpointType,
  JsonSchemaType,
  LambdaIntegration,
  Model,
  Period,
  RequestValidator,
  ResponseType,
  SpecRestApi,
  Stage,
  TokenAuthorizer,
  UsagePlan,
} from "aws-cdk-lib/aws-apigateway";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { join } from "node:path";

const release = process.env.CDK_CFN07_RELEASE ?? "v1";
const definitionRelease = release === "v2" ? "v2" : "v1";

const app = new App();
const stack = new Stack(app, "Cfn07Stack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: "Pinned standard-CDK CFN-07 API Gateway acceptance stack",
});

const api = new SpecRestApi(stack, "AssetApi", {
  apiDefinition: ApiDefinition.fromAsset(join(import.meta.dirname, `openapi-${definitionRelease}.json`)),
  cloudWatchRole: false,
  description: `CFN-07 asset API ${release}`,
  deploy: false,
  endpointTypes: [EndpointType.REGIONAL],
  restApiName: "cfn07-asset-api",
});

const model = new Model(stack, "PayloadModel", {
  contentType: "application/json",
  description: `CFN-07 payload ${release}`,
  modelName: "Cfn07Payload",
  restApi: api,
  schema: {
    properties: {
      message: { type: JsonSchemaType.STRING },
      ...(release === "v1" ? {} : { revision: { type: JsonSchemaType.INTEGER } }),
    },
    required: ["message"],
    type: JsonSchemaType.OBJECT,
  },
});

const validator = new RequestValidator(stack, "BodyValidator", {
  requestValidatorName: "cfn07-body-validator",
  restApi: api,
  validateRequestBody: true,
  validateRequestParameters: release !== "v1",
});

api.addGatewayResponse("AccessDeniedResponse", {
  responseHeaders: { "Access-Control-Allow-Origin": "'*'" },
  statusCode: release === "v1" ? "403" : "401",
  templates: { "application/json": JSON.stringify({ error: release }) },
  type: ResponseType.ACCESS_DENIED,
});

const backend = new LambdaFunction(stack, "Backend", {
  code: Code.fromInline(`
exports.handler = async (event) => {
  if (event.type === "TOKEN") {
    const Effect = event.authorizationToken === "Bearer allow" ? "Allow" : "Deny";
    return {
      principalId: "cfn07-user",
      policyDocument: { Version: "2012-10-17", Statement: [{ Action: "execute-api:Invoke", Effect, Resource: event.methodArn }] },
    };
  }
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ release: process.env.RELEASE, path: event.path }),
  };
};
`),
  environment: { RELEASE: release },
  handler: "index.handler",
  runtime: Runtime.NODEJS_22_X,
});

const authorizer = new TokenAuthorizer(stack, "TokenAuthorizer", {
  handler: backend,
  identitySource: "method.request.header.Authorization",
  resultsCacheTtl: Duration.seconds(release === "v1" ? 60 : 0),
  validationRegex: "^Bearer .+$",
  authorizerName: `cfn07-token-${release}`,
});

const lambdaResource = api.root.addResource("lambda");
const lambdaMethod = lambdaResource.addMethod("POST", new LambdaIntegration(backend), {
  apiKeyRequired: true,
  authorizer,
  requestModels: { "application/json": model },
  requestValidator: validator,
});
const deployment = new Deployment(stack, "Deployment", { api, description: `CFN-07 deployment ${release}` });
deployment.node.addDependency(lambdaMethod);
const stage = new Stage(stack, "Stage", { deployment, description: `CFN-07 stage ${release}`, stageName: "prod" });

const apiKey = new ApiKey(stack, "ClientKey", {
  apiKeyName: "cfn07-client-key",
  description: `CFN-07 client ${release}`,
  enabled: release !== "broken",
});
Tags.of(apiKey).add("release", release);

const usagePlan: UsagePlan = api.addUsagePlan("ClientPlan", {
  apiStages: [{ api, stage }],
  description: `CFN-07 plan ${release}`,
  name: "cfn07-client-plan",
  quota: { limit: release === "v1" ? 20 : 40, period: Period.DAY },
  throttle: { burstLimit: release === "v1" ? 2 : 4, rateLimit: release === "v1" ? 1 : 2 },
});
Tags.of(usagePlan).add("release", release);
usagePlan.addApiKey(apiKey);

if (release === "broken") {
  const cfnUsagePlan = usagePlan.node.defaultChild as CfnUsagePlan;
  cfnUsagePlan.addOverride("Properties.ApiStages.0.Stage", "missing-stage");
}

const accountRole = new Role(stack, "ApiGatewayAccountRole", {
  assumedBy: new ServicePrincipal("apigateway.amazonaws.com"),
  description: "CFN-07 API Gateway account role",
  roleName: "cfn07-apigateway-account",
});
const account = new CfnAccount(stack, "ApiGatewayAccount", { cloudWatchRoleArn: accountRole.roleArn });
account.node.addDependency(accountRole);

new CfnOutput(stack, "ApiId", { value: api.restApiId });
new CfnOutput(stack, "ApiKeyId", { value: apiKey.keyId });
new CfnOutput(stack, "RoleArn", { value: accountRole.roleArn });
new CfnOutput(stack, "StageName", { value: stage.stageName });
new CfnOutput(stack, "UsagePlanId", { value: usagePlan.usagePlanId });
