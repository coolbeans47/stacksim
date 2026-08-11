import { App, CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import {
  ApiKey,
  AuthorizationType,
  Cors,
  EndpointType,
  JsonSchemaType,
  LambdaIntegration,
  Model,
  Period,
  RequestValidator,
  ResponseType,
  RestApi,
  TokenAuthorizer,
} from "aws-cdk-lib/aws-apigateway";
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  StreamViewType,
  Table,
} from "aws-cdk-lib/aws-dynamodb";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as EventBridgeLambdaTarget } from "aws-cdk-lib/aws-events-targets";
import { ManagedPolicy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Alias, Code, Function as LambdaFunction, Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource, SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { join } from "node:path";

const DEMO_API_KEY = "AuroraAtlasLocalKey2026";
const DEMO_TOKEN = "aurora-demo";
const environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000",
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "eu-west-1",
};

class AuroraAtlasDataStack extends Stack {
  readonly signalsTable: Table;
  readonly journeyActivityTable: Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.signalsTable = new Table(this, "Signals", {
      partitionKey: { name: "id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.signalsTable.addGlobalSecondaryIndex({
      indexName: "byCategory",
      partitionKey: { name: "category", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.journeyActivityTable = new Table(this, "JourneyActivity", {
      partitionKey: { name: "journeyId", type: AttributeType.STRING },
      sortKey: { name: "activityId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    Tags.of(this.signalsTable).add("application", "aurora-atlas");
    Tags.of(this.signalsTable).add("purpose", "cloudformation-showcase");
    Tags.of(this.journeyActivityTable).add("application", "aurora-atlas");
    Tags.of(this.journeyActivityTable).add("purpose", "signal-journey-activity");

    new CfnOutput(this, "SignalsTableName", {
      value: this.signalsTable.tableName,
      exportName: "AuroraAtlasSignalsTableName",
    });
    new CfnOutput(this, "SignalsStreamArn", { value: this.signalsTable.tableStreamArn! });
    new CfnOutput(this, "JourneyTableName", {
      value: this.journeyActivityTable.tableName,
      exportName: "AuroraAtlasJourneyActivityTableName",
    });
    new CfnOutput(this, "JourneyActivityTableArn", { value: this.journeyActivityTable.tableArn });
  }
}

interface AuroraAtlasApiStackProps extends StackProps {
  readonly signalsTable: Table;
  readonly journeyActivityTable: Table;
}

class AuroraAtlasApiStack extends Stack {
  readonly api: RestApi;

  constructor(scope: Construct, id: string, props: AuroraAtlasApiStackProps) {
    super(scope, id, props);

    const journeyDeadLetterQueue = new Queue(this, "JourneyDeadLetterQueue", {
      queueName: "aurora-atlas-signal-journey-dlq",
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const journeyQueue = new Queue(this, "JourneyQueue", {
      queueName: "aurora-atlas-signal-journey",
      encryption: QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.seconds(3),
      retentionPeriod: Duration.days(1),
      deadLetterQueue: {
        queue: journeyDeadLetterQueue,
        maxReceiveCount: 3,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const journeyBus = new EventBus(this, "JourneyBus", {
      eventBusName: "aurora-atlas-signal-journey",
    });

    const publisherLogs = new LogGroup(this, "JourneyPublisherLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const publisher = new LambdaFunction(this, "JourneyPublisher", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset(join(import.meta.dirname, "lambda", "journey-publisher")),
      description: "Normalizes Aurora Atlas DynamoDB stream changes and publishes stable journey envelopes",
      memorySize: 128,
      timeout: Duration.seconds(10),
      logGroup: publisherLogs,
      environment: {
        EVENT_BUS_NAME: journeyBus.eventBusName,
      },
    });
    journeyBus.grantPutEventsTo(publisher);
    publisher.addEventSource(new DynamoEventSource(props.signalsTable, {
      startingPosition: StartingPosition.TRIM_HORIZON,
      batchSize: 10,
      bisectBatchOnError: true,
      retryAttempts: 2,
      reportBatchItemFailures: true,
    }));

    const relayLogs = new LogGroup(this, "JourneyRelayLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const relay = new LambdaFunction(this, "JourneyRelay", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset(join(import.meta.dirname, "lambda", "journey-relay")),
      description: "Relays matched Aurora Atlas EventBridge events into the Standard SQS work queue",
      memorySize: 128,
      timeout: Duration.seconds(5),
      logGroup: relayLogs,
      environment: {
        JOURNEY_QUEUE_URL: journeyQueue.queueUrl,
      },
    });
    journeyQueue.grantSendMessages(relay);

    const journeyRule = new Rule(this, "JourneyRule", {
      ruleName: "aurora-atlas-signal-journey",
      description: "Routes normalized Aurora Atlas signal changes through the Signal Journey relay",
      eventBus: journeyBus,
      eventPattern: {
        source: ["aurora.atlas"],
        detailType: ["Signal Journey"],
      },
    });
    journeyRule.addTarget(new EventBridgeLambdaTarget(relay, {
      maxEventAge: Duration.minutes(5),
      retryAttempts: 2,
    }));

    const workerLogs = new LogGroup(this, "JourneyWorkerLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const worker = new LambdaFunction(this, "JourneyWorker", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset(join(import.meta.dirname, "lambda", "journey-worker")),
      description: "Projects Signal Journey queue deliveries and retry outcomes into DynamoDB activity",
      memorySize: 128,
      timeout: Duration.seconds(2),
      logGroup: workerLogs,
      environment: {
        ACTIVITY_TABLE: props.journeyActivityTable.tableName,
        MAX_RECEIVE_COUNT: "3",
      },
    });
    props.journeyActivityTable.grantWriteData(worker);
    worker.addEventSource(new SqsEventSource(journeyQueue, {
      batchSize: 5,
      reportBatchItemFailures: true,
    }));

    const handlerLogs = new LogGroup(this, "ApplicationLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const application = new LambdaFunction(this, "Application", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset(join(import.meta.dirname, "lambda", "api")),
      description: "Aurora Atlas signal API and deterministic demo seeder",
      memorySize: 256,
      timeout: Duration.seconds(15),
      logGroup: handlerLogs,
      environment: {
        TABLE_NAME: props.signalsTable.tableName,
        ACTIVITY_TABLE: props.journeyActivityTable.tableName,
        JOURNEY_QUEUE_URL: journeyQueue.queueUrl,
        JOURNEY_DLQ_URL: journeyDeadLetterQueue.queueUrl,
        RELEASE: "2026.07",
      },
    });
    props.signalsTable.grantReadWriteData(application);
    props.journeyActivityTable.grantReadWriteData(application);
    journeyQueue.grantSendMessages(application);
    journeyQueue.grant(application, "sqs:GetQueueAttributes");
    journeyDeadLetterQueue.grant(application, "sqs:GetQueueAttributes");

    new ManagedPolicy(this, "ObservatoryPolicy", {
      description: "Aurora Atlas runtime observability and table discovery policy",
      roles: [application.role!],
      statements: [
        new PolicyStatement({
          actions: ["dynamodb:DescribeTable", "logs:DescribeLogStreams", "logs:FilterLogEvents"],
          resources: ["*"],
        }),
      ],
    });

    const version = application.currentVersion;
    const live = new Alias(this, "Live", {
      aliasName: "live",
      description: "Stable Aurora Atlas application release",
      version,
    });

    const authorizerFunction = new LambdaFunction(this, "AuthorizerFunction", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset(join(import.meta.dirname, "lambda", "authorizer")),
      environment: { DEMO_TOKEN },
      description: "Local-only token authorizer used to demonstrate API Gateway CUSTOM auth",
    });

    this.api = new RestApi(this, "ObservatoryApi", {
      description: "Aurora Atlas local signal observatory REST API",
      restApiName: "aurora-atlas-observatory",
      endpointTypes: [EndpointType.REGIONAL],
      // AWS::ApiGateway::Account is shared by every REST API in a region.
      // Aurora Atlas does not use API Gateway access/execution logging, so the
      // example must not claim that singleton or make deployment order matter.
      cloudWatchRole: false,
      defaultCorsPreflightOptions: {
        allowOrigins: Cors.ALL_ORIGINS,
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "X-Api-Key"],
      },
      deployOptions: {
        description: "Aurora Atlas production-like local stage",
        stageName: "prod",
      },
    });

    const authorizer = new TokenAuthorizer(this, "DemoAuthorizer", {
      authorizerName: "aurora-atlas-demo-token",
      handler: authorizerFunction,
      identitySource: "method.request.header.Authorization",
      resultsCacheTtl: Duration.seconds(0),
      validationRegex: "^Bearer [A-Za-z0-9-]+$",
    });

    const signalModel = new Model(this, "SignalModel", {
      restApi: this.api,
      contentType: "application/json",
      description: "Validated Aurora Atlas signal draft",
      modelName: "AuroraAtlasSignalDraft",
      schema: {
        type: JsonSchemaType.OBJECT,
        required: ["title", "summary", "category", "intensity"],
        properties: {
          title: { type: JsonSchemaType.STRING, minLength: 3, maxLength: 80 },
          summary: { type: JsonSchemaType.STRING, minLength: 8, maxLength: 280 },
          category: { type: JsonSchemaType.STRING },
          intensity: { type: JsonSchemaType.NUMBER, minimum: 1, maximum: 100 },
        },
      },
    });
    const seedModel = new Model(this, "SeedModel", {
      restApi: this.api,
      contentType: "application/json",
      description: "Idempotent demo seed request",
      modelName: "AuroraAtlasSeedRequest",
      schema: {
        type: JsonSchemaType.OBJECT,
        required: ["reset"],
        properties: { reset: { type: JsonSchemaType.BOOLEAN } },
      },
    });
    const bodyValidator = new RequestValidator(this, "BodyValidator", {
      restApi: this.api,
      requestValidatorName: "aurora-atlas-body-validator",
      validateRequestBody: true,
      validateRequestParameters: false,
    });

    this.api.addGatewayResponse("AccessDenied", {
      type: ResponseType.ACCESS_DENIED,
      statusCode: "403",
      responseHeaders: {
        "Access-Control-Allow-Origin": "'*'",
        "Access-Control-Allow-Headers": "'Content-Type,Authorization,X-Api-Key'",
      },
      templates: {
        "application/json": JSON.stringify({ error: "The local observatory channel rejected this request." }),
      },
    });

    const integration = new LambdaIntegration(live);
    const protectedMethod = {
      apiKeyRequired: true,
      authorizationType: AuthorizationType.CUSTOM,
      authorizer,
    } as const;

    const signals = this.api.root.addResource("signals");
    signals.addMethod("GET", integration);
    signals.addMethod("POST", integration, {
      ...protectedMethod,
      requestModels: { "application/json": signalModel },
      requestValidator: bodyValidator,
    });

    const signal = signals.addResource("{id}");
    signal.addMethod("GET", integration);
    signal.addMethod("PUT", integration, protectedMethod);
    signal.addMethod("DELETE", integration, protectedMethod);

    const journeys = this.api.root.addResource("journeys");
    journeys.addMethod("GET", integration);
    const journeyFault = journeys.addResource("fault");
    journeyFault.addMethod("POST", integration, protectedMethod);

    const demo = this.api.root.addResource("demo");
    const seed = demo.addResource("seed");
    seed.addMethod("POST", integration, {
      ...protectedMethod,
      requestModels: { "application/json": seedModel },
      requestValidator: bodyValidator,
    });

    const system = this.api.root.addResource("system");
    const proof = system.addResource("proof");
    proof.addMethod("GET", integration, protectedMethod);

    const apiKey = new ApiKey(this, "DemoApiKey", {
      apiKeyName: "aurora-atlas-demo-key",
      description: "Local demo key embedded in the public showcase; not production authentication",
      enabled: true,
      value: DEMO_API_KEY,
    });
    const plan = this.api.addUsagePlan("DemoUsagePlan", {
      name: "aurora-atlas-demo-plan",
      description: "Generous local quota that demonstrates API key association and throttling",
      apiStages: [{ api: this.api, stage: this.api.deploymentStage }],
      quota: { limit: 10_000, period: Period.DAY },
      throttle: { burstLimit: 100, rateLimit: 50 },
    });
    plan.addApiKey(apiKey);

    Tags.of(this).add("application", "aurora-atlas", {
      excludeResourceTypes: ["AWS::Lambda::EventSourceMapping"],
    });
    Tags.of(this).add("managed-by", "stacksim-cdk-showcase", {
      excludeResourceTypes: ["AWS::Lambda::EventSourceMapping"],
    });

    new CfnOutput(this, "ApiId", { value: this.api.restApiId });
    new CfnOutput(this, "StageName", { value: this.api.deploymentStage.stageName });
    new CfnOutput(this, "FunctionName", { value: application.functionName });
    new CfnOutput(this, "FunctionVersion", { value: version.version });
    new CfnOutput(this, "AliasArn", { value: live.functionArn });
    new CfnOutput(this, "ApiKeyId", { value: apiKey.keyId });
    new CfnOutput(this, "UsagePlanId", { value: plan.usagePlanId });
    new CfnOutput(this, "ApplicationLogGroup", { value: handlerLogs.logGroupName });
    new CfnOutput(this, "JourneyBusName", { value: journeyBus.eventBusName });
    new CfnOutput(this, "JourneyRuleName", { value: journeyRule.ruleName });
    new CfnOutput(this, "JourneyQueueUrl", { value: journeyQueue.queueUrl });
    new CfnOutput(this, "JourneyQueueArn", { value: journeyQueue.queueArn });
    new CfnOutput(this, "JourneyDeadLetterQueueUrl", { value: journeyDeadLetterQueue.queueUrl });
    new CfnOutput(this, "JourneyDeadLetterQueueArn", { value: journeyDeadLetterQueue.queueArn });
    new CfnOutput(this, "JourneyPublisherFunctionName", { value: publisher.functionName });
    new CfnOutput(this, "JourneyRelayFunctionName", { value: relay.functionName });
    new CfnOutput(this, "JourneyWorkerFunctionName", { value: worker.functionName });
  }
}

class AuroraAtlasWebStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const website = new s3.Bucket(this, "Website", {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
      publicReadAccess: true,
      websiteIndexDocument: "index.html",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new s3deploy.BucketDeployment(this, "DeployWebsite", {
      sources: [s3deploy.Source.asset(join(import.meta.dirname, "frontend", "dist"))],
      destinationBucket: website,
      prune: true,
    });

    Tags.of(website).add("application", "aurora-atlas");
    Tags.of(website).add("surface", "public-react-showcase");

    new CfnOutput(this, "WebsiteBucketName", { value: website.bucketName });
    new CfnOutput(this, "WebsiteUrl", { value: website.bucketWebsiteUrl });
  }
}

const app = new App();
const data = new AuroraAtlasDataStack(app, "AuroraAtlasDataStack", {
  env: environment,
  description: "Aurora Atlas DynamoDB data plane for the stacksim CDK showcase",
});
const api = new AuroraAtlasApiStack(app, "AuroraAtlasApiStack", {
  env: environment,
  description: "Aurora Atlas IAM, Lambda, Logs, API Gateway and DynamoDB integration showcase",
  signalsTable: data.signalsTable,
  journeyActivityTable: data.journeyActivityTable,
});
const web = new AuroraAtlasWebStack(app, "AuroraAtlasWebStack", {
  env: environment,
  description: "Aurora Atlas public React website deployed to the stacksim S3 website endpoint",
});
web.addDependency(api, "The website build is configured with the deployed local REST API identity");
