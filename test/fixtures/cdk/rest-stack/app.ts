import { App, CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { AttributeType, BillingMode, ProjectionType, StreamViewType, Table } from "aws-cdk-lib/aws-dynamodb";
import {
  ApiKey,
  AuthorizationType,
  CfnMethod,
  JsonSchemaType,
  LambdaIntegration,
  LambdaRestApi,
  Model,
  Period,
  RequestValidator,
  ResponseType,
  RestApi,
  TokenAuthorizer,
} from "aws-cdk-lib/aws-apigateway";
import { ManagedPolicy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Alias, Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { join } from "node:path";

const app = new App();
const variant = process.env.CDK_REST_TEST_VERSION ?? "v1";
const recoveryMatrix = process.env.CDK_RECOVERY_MATRIX === "1";
const categoryIndex = variant === "v3" || variant === "ddb-invalid" || variant === "api-invalid";
const warmThroughput = variant === "v3" || variant === "api-invalid";
const invalidUpdate = variant === "ddb-invalid" || variant === "api-invalid";
const apiConfigurationV2 = ["api-v2", "v3", "ddb-invalid", "api-invalid"].includes(variant);
const environment = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
const stack = new Stack(app, "RestStack", {
  env: environment,
  description: "Pinned stacksim Lambda, API Gateway REST, and DynamoDB acceptance stack",
});

const table = new Table(stack, "Items", {
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  stream: StreamViewType.NEW_AND_OLD_IMAGES,
  timeToLiveAttribute: "expiresAt",
  ...(warmThroughput ? { warmThroughput: { readUnitsPerSecond: 20, writeUnitsPerSecond: 10 } } : {}),
  ...(variant === "ddb-invalid" ? { maxReadRequestUnits: 50, maxWriteRequestUnits: 40 } : {}),
  removalPolicy: RemovalPolicy.DESTROY,
});
table.addGlobalSecondaryIndex({
  indexName: "byValue",
  partitionKey: { name: "value", type: AttributeType.STRING },
  projectionType: ProjectionType.ALL,
});
if (categoryIndex) {
  table.addGlobalSecondaryIndex({
    indexName: "byCategory",
    partitionKey: { name: "category", type: AttributeType.STRING },
    projectionType: ProjectionType.KEYS_ONLY,
  });
}

const logGroup = new LogGroup(stack, "HandlerLogs", {
  retention: RetentionDays.ONE_WEEK,
  removalPolicy: RemovalPolicy.DESTROY,
});

const handler = new LambdaFunction(stack, "Handler", {
  runtime: Runtime.NODEJS_22_X,
  handler: "index.handler",
  code: Code.fromAsset(join(import.meta.dirname, variant === "v1" ? "handler" : "handler-v2")),
  timeout: Duration.seconds(10),
  memorySize: invalidUpdate ? 512 : 256,
  environment: {
    TABLE_NAME: table.tableName,
  },
  logGroup,
});
table.grantReadWriteData(handler);

const version = handler.currentVersion;
const live = new Alias(stack, "Live", {
  aliasName: "live",
  version,
});

const api = new LambdaRestApi(stack, "Api", {
  handler: live,
  proxy: false,
  description: apiConfigurationV2 ? "stacksim REST CRUD fixture API v2" : "stacksim REST CRUD fixture",
});
const items = api.root.addResource("items");
items.addMethod("POST", new LambdaIntegration(live));
const item = items.addResource("{id}");
item.addMethod("GET", new LambdaIntegration(live));
item.addMethod("PUT", new LambdaIntegration(live));
item.addMethod("DELETE", new LambdaIntegration(live));
const secure = api.root.addResource("secure");
secure.addMethod("GET", new LambdaIntegration(live), { authorizationType: AuthorizationType.IAM });
if (apiConfigurationV2) api.root.addResource("health").addMethod("GET", new LambdaIntegration(live));

if (recoveryMatrix) {
  new ManagedPolicy(stack, "RecoveryManagedPolicy", {
    description: "Scenario C restart recovery managed policy",
    roles: [handler.role!],
    statements: [new PolicyStatement({ actions: ["logs:CreateLogStream"], resources: ["*"] })],
  });

  const recoveryModel = new Model(stack, "RecoveryModel", {
    contentType: "application/json",
    description: "Scenario C request model",
    modelName: "RecoveryPayload",
    restApi: api,
    schema: {
      properties: { message: { type: JsonSchemaType.STRING } },
      required: ["message"],
      type: JsonSchemaType.OBJECT,
    },
  });
  const recoveryValidator = new RequestValidator(stack, "RecoveryValidator", {
    requestValidatorName: "recovery-body-validator",
    restApi: api,
    validateRequestBody: true,
    validateRequestParameters: false,
  });
  const recoveryAuthorizer = new TokenAuthorizer(stack, "RecoveryAuthorizer", {
    authorizerName: "recovery-token-authorizer",
    handler: live,
    identitySource: "method.request.header.Authorization",
    resultsCacheTtl: Duration.seconds(0),
    validationRegex: "^Bearer .+$",
  });
  api.root.addResource("recovery").addMethod("POST", new LambdaIntegration(live), {
    apiKeyRequired: true,
    authorizer: recoveryAuthorizer,
    requestModels: { "application/json": recoveryModel },
    requestValidator: recoveryValidator,
  });
  api.addGatewayResponse("RecoveryAccessDenied", {
    responseHeaders: { "Access-Control-Allow-Origin": "'*'" },
    statusCode: "403",
    templates: { "application/json": JSON.stringify({ error: "access denied" }) },
    type: ResponseType.ACCESS_DENIED,
  });

  const recoveryKey = new ApiKey(stack, "RecoveryApiKey", {
    apiKeyName: "recovery-client-key",
    description: "Scenario C API key",
    enabled: true,
  });
  const recoveryPlan = api.addUsagePlan("RecoveryUsagePlan", {
    apiStages: [{ api, stage: api.deploymentStage }],
    description: "Scenario C usage plan",
    name: "recovery-client-plan",
    quota: { limit: 20, period: Period.DAY },
    throttle: { burstLimit: 2, rateLimit: 1 },
  });
  recoveryPlan.addApiKey(recoveryKey);
}

if (variant === "api-invalid") {
  const duplicate = new CfnMethod(stack, "DuplicateItemsPost", {
    restApiId: api.restApiId,
    resourceId: items.resourceId,
    httpMethod: "POST",
    authorizationType: "NONE",
    integration: { type: "MOCK" },
  });
  duplicate.node.addDependency(items);
  duplicate.node.addDependency(api.deploymentStage);
}

new CfnOutput(stack, "ApiUrl", { value: api.url });
new CfnOutput(stack, "ApiId", { value: api.restApiId });
new CfnOutput(stack, "Stage", { value: api.deploymentStage.stageName });
new CfnOutput(stack, "FunctionName", { value: handler.functionName });
new CfnOutput(stack, "FunctionVersion", { value: version.version });
new CfnOutput(stack, "AliasArn", { value: live.functionArn });
new CfnOutput(stack, "TableName", { value: table.tableName });

const plainStack = new Stack(app, "PlainRestStack", {
  env: environment,
  description: "Pinned stacksim ordinary RestApi acceptance stack",
});
const plainHandler = new LambdaFunction(plainStack, "Handler", {
  runtime: Runtime.NODEJS_22_X,
  handler: "index.handler",
  code: Code.fromInline(`exports.handler = async event => ({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ construct: "RestApi", path: event.path })
  });`),
});
const plainApi = new RestApi(plainStack, "Api", {
  description: "stacksim plain RestApi fixture",
});
plainApi.root.addResource("plain").addMethod("GET", new LambdaIntegration(plainHandler));
new CfnOutput(plainStack, "ApiId", { value: plainApi.restApiId });
new CfnOutput(plainStack, "Stage", { value: plainApi.deploymentStage.stageName });

const retainStack = new Stack(app, "RetainStack", {
  env: environment,
  description: "Pinned stacksim retained DynamoDB table acceptance stack",
});
const retainedTable = new Table(retainStack, "RetainedItems", {
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  removalPolicy: RemovalPolicy.RETAIN,
});
new CfnOutput(retainStack, "RetainedTableName", { value: retainedTable.tableName });
