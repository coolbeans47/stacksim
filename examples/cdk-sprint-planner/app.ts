import {
  App,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  Tags,
  type StackProps,
} from "aws-cdk-lib";
import {
  CfnApi,
  CfnAuthorizer,
  CfnIntegration,
  CfnRoute,
  CfnStage,
} from "aws-cdk-lib/aws-apigatewayv2";
import {
  Alarm,
  ComparisonOperator,
  Dashboard,
  GraphWidget,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { CfnUserPool, CfnUserPoolClient } from "aws-cdk-lib/aws-cognito";
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  StreamViewType,
  Table,
} from "aws-cdk-lib/aws-dynamodb";
import { CfnEventBus, CfnRule } from "aws-cdk-lib/aws-events";
import {
  AnyPrincipal,
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  CfnEventInvokeConfig,
  CfnEventSourceMapping,
  CfnPermission,
  Code,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import {
  CfnMetricFilter,
  CfnQueryDefinition,
  LogGroup,
  RetentionDays,
} from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { CfnConfigurationSet, CfnEmailIdentity } from "aws-cdk-lib/aws-ses";
import { CfnTemplate } from "aws-cdk-lib/aws-ses";
import { CfnQueue, type CfnQueueProps } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { join } from "node:path";
// @ts-ignore The runtime-validated ESM config loader is JavaScript by design.
import { loadConfig } from "./scripts/config.mjs";

const config = await loadConfig();
const env = { account: config.accountId, region: config.region };
const workspaceId = "northstar-product";
const buildRoot = join(import.meta.dirname, ".lambda-build");

interface DataStackProps extends StackProps {}

class SprintPlannerDataStack extends Stack {
  readonly applicationTable: Table;
  readonly connectionTable: Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    this.applicationTable = new Table(this, "ApplicationTable", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.applicationTable.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
    this.applicationTable.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "GSI2PK", type: AttributeType.STRING },
      sortKey: { name: "GSI2SK", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.connectionTable = new Table(this, "ConnectionTable", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.connectionTable.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    for (const table of [this.applicationTable, this.connectionTable]) {
      Tags.of(table).add("application", "sprint-planner");
      Tags.of(table).add("workspace", workspaceId);
    }
    new CfnOutput(this, "ApplicationTableName", { value: this.applicationTable.tableName });
    new CfnOutput(this, "ApplicationTableArn", { value: this.applicationTable.tableArn });
    new CfnOutput(this, "ApplicationTableStreamArn", { value: this.applicationTable.tableStreamArn! });
    new CfnOutput(this, "ConnectionTableName", { value: this.connectionTable.tableName });
    new CfnOutput(this, "ConnectionTableArn", { value: this.connectionTable.tableArn });
  }
}

class SprintPlannerWebStack extends Stack {
  readonly websiteUrl: string;
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    this.bucket = new s3.Bucket(this, "WebsiteBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      websiteIndexDocument: "index.html",
      websiteErrorDocument: "index.html",
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // stacksim's bounded CloudFormation S3 provider intentionally accepts only
    // these two public-access-block fields. CDK emits the other two boolean
    // fields even when they are false, so keep the synthesized model exact.
    const websiteBucketResource = this.bucket.node.defaultChild as s3.CfnBucket;
    websiteBucketResource.addDeletionOverride(
      "Properties.PublicAccessBlockConfiguration.BlockPublicPolicy",
    );
    websiteBucketResource.addDeletionOverride(
      "Properties.PublicAccessBlockConfiguration.RestrictPublicBuckets",
    );
    this.bucket.addToResourcePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      principals: [new AnyPrincipal()],
      actions: ["s3:GetObject"],
      resources: [`${this.bucket.bucketArn}/*`],
    }));
    new s3deploy.BucketDeployment(this, "WebsiteDeployment", {
      sources: [s3deploy.Source.asset(join(import.meta.dirname, "frontend", "dist"))],
      destinationBucket: this.bucket,
      prune: true,
    });
    this.websiteUrl = this.bucket.bucketWebsiteUrl;
    new CfnOutput(this, "WebsiteUrl", { value: this.websiteUrl });
    new CfnOutput(this, "WebsiteBucketName", { value: this.bucket.bucketName });
  }
}

interface AppStackProps extends StackProps {
  readonly applicationTable: Table;
  readonly connectionTable: Table;
  readonly websiteUrl: string;
}

class SprintPlannerAppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const userPool = new CfnUserPool(this, "UserPool", {
      userPoolName: "sprint-planner-users",
      usernameAttributes: ["email"],
      autoVerifiedAttributes: ["email"],
      usernameConfiguration: { caseSensitive: false },
      adminCreateUserConfig: { allowAdminCreateUserOnly: false },
      policies: {
        passwordPolicy: {
          minimumLength: 8,
          requireLowercase: true,
          requireNumbers: true,
          requireSymbols: true,
          requireUppercase: true,
          temporaryPasswordValidityDays: 7,
        },
      },
      userPoolTags: { application: "sprint-planner", workspace: workspaceId },
    });
    userPool.applyRemovalPolicy(RemovalPolicy.DESTROY);
    const appClient = new CfnUserPoolClient(this, "UserPoolClient", {
      userPoolId: userPool.ref,
      clientName: "sprint-planner-browser",
      generateSecret: false,
      explicitAuthFlows: [
        "ALLOW_REFRESH_TOKEN_AUTH",
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_USER_SRP_AUTH",
      ],
      preventUserExistenceErrors: "ENABLED",
      enableTokenRevocation: true,
      readAttributes: ["email", "email_verified"],
      writeAttributes: ["email"],
    });
    appClient.applyRemovalPolicy(RemovalPolicy.DESTROY);
    const cognitoIssuer = Fn.join("", [
      `https://cognito-idp.${this.region}.amazonaws.com/`,
      userPool.ref,
    ]);

    const queue = (logicalId: string, settings: Omit<CfnQueueProps, "queueName"> = {}) =>
      new CfnQueue(this, logicalId, {
        sqsManagedSseEnabled: true,
        messageRetentionPeriod: 1_209_600,
        ...settings,
      });

    const notificationDlq = queue("NotificationDeadLetterQueue");
    const notificationQueue = queue("NotificationQueue", {
      visibilityTimeout: 60,
      messageRetentionPeriod: 345_600,
      redrivePolicy: {
        deadLetterTargetArn: notificationDlq.attrArn,
        maxReceiveCount: 3,
      },
    });
    const streamFailureQueue = queue("StreamFailureQueue");
    const eventConsumerFailureQueue = queue("EventConsumerFailureQueue");

    const log = (id: string) => new LogGroup(this, `${id}Logs`, {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const logs = {
      api: log("Application"),
      realtimeAuthorizer: log("RealtimeAuthorizer"),
      realtimeConnection: log("RealtimeConnection"),
      publisher: log("OutboxPublisher"),
      broadcast: log("Broadcast"),
      relay: log("NotificationRelay"),
      worker: log("NotificationWorker"),
      http: log("HttpAccess"),
      websocket: log("WebSocketAccess"),
    };

    const role = (id: string, statements: PolicyStatement[]) => {
      const created = new Role(this, `${id}Role`, {
        assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      });
      created.addToPolicy(new PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: Object.values(logs).map(group => `${group.logGroupArn}:*`),
      }));
      for (const statement of statements) created.addToPolicy(statement);
      return created;
    };
    const tableResources = [props.applicationTable.tableArn, `${props.applicationTable.tableArn}/index/*`];
    const connectionResources = [props.connectionTable.tableArn, `${props.connectionTable.tableArn}/index/*`];
    const sesResources = [
      `arn:aws:ses:${this.region}:${this.account}:identity/${config.email.fromAddress}`,
      `arn:aws:ses:${this.region}:${this.account}:template/sprint-planner-invitation`,
      `arn:aws:ses:${this.region}:${this.account}:template/sprint-planner-notification`,
    ];

    const apiRole = role("Application", [
      new PolicyStatement({
        actions: [
          "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:PutItem",
          "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:TransactWriteItems",
        ],
        resources: [...tableResources, ...connectionResources],
      }),
      new PolicyStatement({
        actions: ["ses:SendTemplatedEmail", "ses:GetTemplate"],
        resources: sesResources,
      }),
    ]);
    const realtimeRole = role("Realtime", [
      new PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"],
        resources: [...tableResources, ...connectionResources],
      }),
    ]);
    const publisherRole = role("Publisher", [
      new PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [props.applicationTable.tableArn],
      }),
      new PolicyStatement({
        actions: ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"],
        resources: [props.applicationTable.tableStreamArn!],
      }),
      new PolicyStatement({
        actions: ["dynamodb:ListStreams"],
        resources: ["*"],
      }),
      new PolicyStatement({ actions: ["sqs:SendMessage"], resources: [streamFailureQueue.attrArn] }),
    ]);
    const broadcastRole = role("Broadcast", [
      new PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:DeleteItem"], resources: [...tableResources, ...connectionResources] }),
      new PolicyStatement({ actions: ["sqs:SendMessage"], resources: [eventConsumerFailureQueue.attrArn] }),
    ]);
    const relayRole = role("Relay", [
      new PolicyStatement({ actions: ["dynamodb:GetItem"], resources: tableResources }),
      new PolicyStatement({ actions: ["sqs:SendMessage"], resources: [notificationQueue.attrArn, eventConsumerFailureQueue.attrArn] }),
    ]);
    const workerRole = role("Worker", [
      new PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: tableResources }),
      new PolicyStatement({ actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"], resources: [notificationQueue.attrArn] }),
      new PolicyStatement({ actions: ["ses:SendTemplatedEmail", "ses:GetTemplate"], resources: sesResources }),
    ]);

    const commonEnvironment = {
      APPLICATION_TABLE: props.applicationTable.tableName,
      CONNECTION_TABLE: props.connectionTable.tableName,
      WORKSPACE_ID: workspaceId,
      APP_CLIENT_ID: appClient.ref,
      BOOTSTRAP_EMAIL: config.bootstrapAdmin.email,
      WEBSITE_URL: props.websiteUrl,
      FROM_ADDRESS: config.email.fromAddress,
    };
    const fn = (
      id: string,
      entry: string,
      fnRole: Role,
      timeout: number,
      environment: Record<string, string> = {},
      reservedConcurrentExecutions?: number,
    ) => new LambdaFunction(this, id, {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset(join(buildRoot, entry)),
      role: fnRole,
      timeout: Duration.seconds(timeout),
      memorySize: id === "ApplicationFunction" ? 512 : 256,
      environment: { ...commonEnvironment, ...environment },
      logGroup: logs[entry.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) as keyof typeof logs],
      reservedConcurrentExecutions,
    });

    const application = fn("ApplicationFunction", "api", apiRole, 15, {
      INVITATION_TEMPLATE: "sprint-planner-invitation",
    });
    const realtimeAuthorizer = fn("RealtimeAuthorizerFunction", "realtime-authorizer", realtimeRole, 5);
    const realtimeConnection = fn("RealtimeConnectionFunction", "realtime-connection", realtimeRole, 5);
    const publisher = fn("OutboxPublisherFunction", "publisher", publisherRole, 10);
    const broadcast = fn("BroadcastFunction", "broadcast", broadcastRole, 10);
    const relay = fn("NotificationRelayFunction", "relay", relayRole, 10, {
      NOTIFICATION_QUEUE_URL: notificationQueue.ref,
    });
    const worker = fn("NotificationWorkerFunction", "worker", workerRole, 15, {
      NOTIFICATION_TEMPLATE: "sprint-planner-notification",
    }, 1);

    const httpApi = new CfnApi(this, "HttpApi", {
      name: "sprint-planner-http",
      protocolType: "HTTP",
      corsConfiguration: {
        allowOrigins: [new URL(config.controlPlaneEndpoint).origin],
        allowHeaders: ["Authorization", "Content-Type"],
        allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
        maxAge: 3600,
      },
      tags: { application: "sprint-planner" },
    });
    const httpIntegration = new CfnIntegration(this, "HttpIntegration", {
      apiId: httpApi.ref,
      integrationType: "AWS_PROXY",
      integrationMethod: "POST",
      integrationUri: application.functionArn,
      payloadFormatVersion: "2.0",
      timeoutInMillis: 15_000,
    });
    const jwtAuthorizer = new CfnAuthorizer(this, "JwtAuthorizer", {
      apiId: httpApi.ref,
      name: "sprint-planner-cognito",
      authorizerType: "JWT",
      identitySource: ["$request.header.Authorization"],
      jwtConfiguration: {
        issuer: cognitoIssuer,
        audience: [appClient.ref],
      },
    });
    const routes: Array<[string, boolean]> = [
      ["POST /invitations/inspect", false],
      ["POST /bootstrap/claim", true],
      ["POST /invitations/accept", true],
      ["GET /session", true],
      ["GET /board", true],
      ["GET /me/tickets", true],
      ["GET /tickets/{ticketKey}", true],
      ["POST /tickets", true],
      ["PATCH /tickets/{ticketKey}", true],
      ["POST /tickets/{ticketKey}/move", true],
      ["POST /tickets/{ticketKey}/assign", true],
      ["POST /tickets/{ticketKey}/archive", true],
      ["POST /tickets/{ticketKey}/comments", true],
      ["GET /sprints", true],
      ["POST /sprints", true],
      ["PATCH /sprints/{sprintId}", true],
      ["POST /sprints/{sprintId}/start", true],
      ["POST /sprints/{sprintId}/complete", true],
      ["GET /team", true],
      ["POST /invitations", true],
      ["POST /invitations/{invitationId}/resend", true],
      ["POST /invitations/{invitationId}/revoke", true],
      ["POST /members/{memberId}/revoke", true],
      ["POST /realtime/tickets", true],
      ["GET /activity", true],
    ];
    let inspectRoute: CfnRoute | undefined;
    for (const [routeKey, authenticated] of routes) {
      const route = new CfnRoute(this, `Route${routeKey.replace(/[^A-Za-z0-9]/g, "")}`, {
        apiId: httpApi.ref,
        routeKey,
        target: `integrations/${httpIntegration.ref}`,
        authorizationType: authenticated ? "JWT" : "NONE",
        ...(authenticated ? { authorizerId: jwtAuthorizer.ref, authorizationScopes: [] } : {}),
      });
      if (routeKey === "POST /invitations/inspect") inspectRoute = route;
    }
    new CfnPermission(this, "HttpInvokePermission", {
      action: "lambda:InvokeFunction",
      functionName: application.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${httpApi.ref}/*`,
    });
    const httpStage = new CfnStage(this, "HttpStage", {
      apiId: httpApi.ref,
      stageName: "$default",
      autoDeploy: true,
      accessLogSettings: {
        destinationArn: logs.http.logGroupArn,
        format: JSON.stringify({
          requestId: "$context.requestId",
          routeKey: "$context.routeKey",
          status: "$context.status",
          responseLength: "$context.responseLength",
        }),
      },
      defaultRouteSettings: {
        detailedMetricsEnabled: true,
        throttlingBurstLimit: 50,
        throttlingRateLimit: 25,
      },
      tags: { application: "sprint-planner" },
    });
    httpStage.addOverride("Properties.RouteSettings", {
      "POST /invitations/inspect": {
        DetailedMetricsEnabled: true,
        ThrottlingBurstLimit: 5,
        ThrottlingRateLimit: 2,
      },
    });
    if (inspectRoute) httpStage.addDependency(inspectRoute);

    const websocketApi = new CfnApi(this, "WebSocketApi", {
      name: "sprint-planner-realtime",
      protocolType: "WEBSOCKET",
      routeSelectionExpression: "$request.body.action",
      tags: { application: "sprint-planner" },
    });
    const wsAuthorizer = new CfnAuthorizer(this, "WebSocketAuthorizer", {
      apiId: websocketApi.ref,
      name: "sprint-planner-ticket-authorizer",
      authorizerType: "REQUEST",
      authorizerUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${realtimeAuthorizer.functionArn}/invocations`,
      identitySource: ["route.request.querystring.ticket"],
      authorizerResultTtlInSeconds: 0,
    });
    const wsIntegration = new CfnIntegration(this, "WebSocketIntegration", {
      apiId: websocketApi.ref,
      integrationType: "AWS_PROXY",
      integrationMethod: "POST",
      integrationUri: realtimeConnection.functionArn,
    });
    const wsRoutes: CfnRoute[] = [];
    for (const key of ["$connect", "$disconnect", "$default"]) {
      wsRoutes.push(new CfnRoute(this, `WebSocketRoute${key.slice(1)}`, {
        apiId: websocketApi.ref,
        routeKey: key,
        target: `integrations/${wsIntegration.ref}`,
        authorizationType: key === "$connect" ? "CUSTOM" : "NONE",
        ...(key === "$connect" ? { authorizerId: wsAuthorizer.ref } : {}),
      }));
    }
    new CfnPermission(this, "WebSocketAuthorizerPermission", {
      action: "lambda:InvokeFunction",
      functionName: realtimeAuthorizer.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${websocketApi.ref}/*`,
    });
    new CfnPermission(this, "WebSocketInvokePermission", {
      action: "lambda:InvokeFunction",
      functionName: realtimeConnection.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${websocketApi.ref}/*`,
    });
    const wsStage = new CfnStage(this, "WebSocketStage", {
      apiId: websocketApi.ref,
      stageName: "live",
      autoDeploy: true,
      accessLogSettings: {
        destinationArn: logs.websocket.logGroupArn,
        format: JSON.stringify({ requestId: "$context.requestId", routeKey: "$context.routeKey", status: "$context.status" }),
      },
      defaultRouteSettings: {
        detailedMetricsEnabled: true,
        throttlingBurstLimit: 20,
        throttlingRateLimit: 10,
      },
      tags: { application: "sprint-planner" },
    });
    wsRoutes.forEach(route => wsStage.addDependency(route));
    const managementArn = `arn:aws:execute-api:${this.region}:${this.account}:${websocketApi.ref}/live/POST/@connections/*`;
    for (const targetRole of [apiRole, broadcastRole]) {
      targetRole.addToPolicy(new PolicyStatement({ actions: ["execute-api:ManageConnections"], resources: [managementArn] }));
    }

    const eventBus = new CfnEventBus(this, "DomainEventBus", {
      name: "sprint-planner-domain-events",
      tags: [{ key: "application", value: "sprint-planner" }],
    });
    publisherRole.addToPolicy(new PolicyStatement({ actions: ["events:PutEvents"], resources: [eventBus.attrArn] }));
    const domainRule = new CfnRule(this, "DomainEventRule", {
      name: "sprint-planner-consumers",
      eventBusName: eventBus.ref,
      state: "ENABLED",
      eventPattern: {
        source: ["sprint.planner"],
        "detail-type": ["Sprint Planner Domain Event"],
      },
      targets: [
        {
          id: "broadcast",
          arn: broadcast.functionArn,
          retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts: 3 },
        },
        {
          id: "notification-relay",
          arn: relay.functionArn,
          retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts: 3 },
        },
      ],
    });
    for (const [id, target] of [["Broadcast", broadcast], ["Relay", relay]] as const) {
      new CfnPermission(this, `${id}EventBridgePermission`, {
        action: "lambda:InvokeFunction",
        functionName: target.functionName,
        principal: "events.amazonaws.com",
        sourceArn: domainRule.attrArn,
      });
    }
    new CfnEventInvokeConfig(this, "BroadcastInvokeConfig", {
      functionName: broadcast.functionName,
      qualifier: "$LATEST",
      maximumEventAgeInSeconds: 3600,
      maximumRetryAttempts: 2,
      destinationConfig: { onFailure: { destination: eventConsumerFailureQueue.attrArn } },
    });
    new CfnEventInvokeConfig(this, "RelayInvokeConfig", {
      functionName: relay.functionName,
      qualifier: "$LATEST",
      maximumEventAgeInSeconds: 3600,
      maximumRetryAttempts: 2,
      destinationConfig: { onFailure: { destination: eventConsumerFailureQueue.attrArn } },
    });

    const streamMapping = new CfnEventSourceMapping(this, "OutboxStreamMapping", {
      eventSourceArn: props.applicationTable.tableStreamArn!,
      functionName: publisher.functionArn,
      startingPosition: "TRIM_HORIZON",
      batchSize: 1,
      maximumBatchingWindowInSeconds: 0,
      parallelizationFactor: 1,
      maximumRecordAgeInSeconds: 3600,
      maximumRetryAttempts: 3,
      functionResponseTypes: ["ReportBatchItemFailures"],
      destinationConfig: { onFailure: { destination: streamFailureQueue.attrArn } },
      filterCriteria: {
        filters: [{
          pattern: JSON.stringify({
            dynamodb: {
              NewImage: { entityType: { S: ["OUTBOX"] } },
              OldImage: [{ exists: false }],
            },
          }),
        }],
      },
    });
    streamMapping.node.addDependency(publisher);
    streamMapping.node.addDependency(publisherRole.node.findChild("DefaultPolicy"));
    const notificationMapping = new CfnEventSourceMapping(this, "NotificationQueueMapping", {
      eventSourceArn: notificationQueue.attrArn,
      functionName: worker.functionArn,
      batchSize: 10,
      maximumBatchingWindowInSeconds: 1,
      functionResponseTypes: ["ReportBatchItemFailures"],
    });
    notificationMapping.node.addDependency(worker);
    notificationMapping.node.addDependency(workerRole.node.findChild("DefaultPolicy"));

    new CfnConfigurationSet(this, "EmailConfigurationSet", {
      name: "sprint-planner-email",
      sendingOptions: { sendingEnabled: true },
      tags: [{ key: "application", value: "sprint-planner" }],
    });
    new CfnEmailIdentity(this, "EmailIdentity", {
      emailIdentity: config.email.fromAddress,
      configurationSetAttributes: { configurationSetName: "sprint-planner-email" },
      tags: [{ key: "application", value: "sprint-planner" }],
    });
    new CfnTemplate(this, "InvitationTemplate", {
      template: {
        templateName: "sprint-planner-invitation",
        subjectPart: "You’re invited to Northstar Product",
        textPart: "Hello {{{displayName}}}, open this invitation to join Northstar Product: {{{inviteUrl}}}",
        htmlPart: "<h1>Join Northstar Product</h1><p>Hello {{{displayNameHtml}}},</p><p><a href=\"{{{inviteUrlHtml}}}\">Accept your invitation</a></p>",
      },
      tags: [{ key: "application", value: "sprint-planner" }],
    });
    new CfnTemplate(this, "NotificationTemplate", {
      template: {
        templateName: "sprint-planner-notification",
        subjectPart: "{{subject}}",
        textPart: "{{message}}",
        htmlPart: "<h1>{{subject}}</h1><p>{{message}}</p>",
      },
      tags: [{ key: "application", value: "sprint-planner" }],
    });

    const errorFilter = new CfnMetricFilter(this, "ApplicationErrorMetric", {
      filterPattern: '{ $.level = "error" }',
      logGroupName: logs.api.logGroupName,
      metricTransformations: [{
        metricName: "ApplicationErrors",
        metricNamespace: "SprintPlanner",
        metricValue: "1",
        defaultValue: 0,
        unit: "Count",
      }],
    });
    const conflictFilter = new CfnMetricFilter(this, "BoardConflictMetric", {
      filterPattern: '{ $.code = "BOARD_CONFLICT" }',
      logGroupName: logs.api.logGroupName,
      metricTransformations: [{
        metricName: "BoardConflicts",
        metricNamespace: "SprintPlanner",
        metricValue: "1",
        defaultValue: 0,
        unit: "Count",
      }],
    });
    new CfnQueryDefinition(this, "RecentErrorsQuery", {
      name: "Sprint Planner/Recent errors",
      logGroupNames: [logs.api.logGroupName, logs.publisher.logGroupName, logs.broadcast.logGroupName, logs.worker.logGroupName],
      queryString: "fields @timestamp, level, code, route, requestId | filter level = 'error' | sort @timestamp desc | limit 100",
      queryLanguage: "CWLI",
    });
    const applicationAlarm = new Alarm(this, "ApplicationErrorAlarm", {
      metric: new Metric({ namespace: "SprintPlanner", metricName: "ApplicationErrors", period: Duration.minutes(1), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    applicationAlarm.node.addDependency(errorFilter);
    const failureQueueMetric = (queueResource: CfnQueue, name: string) =>
      new Metric({
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensionsMap: { QueueName: queueResource.attrQueueName },
        period: Duration.minutes(1),
        statistic: "Maximum",
        label: name,
      });
    for (const [id, target] of [
      ["NotificationDlq", notificationDlq],
      ["StreamFailure", streamFailureQueue],
      ["EventConsumerFailure", eventConsumerFailureQueue],
    ] as const) {
      new Alarm(this, `${id}Alarm`, {
        metric: failureQueueMetric(target, id),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
    }
    const dashboard = new Dashboard(this, "Dashboard", { dashboardName: "SprintPlanner" });
    dashboard.addWidgets(
      new GraphWidget({
        title: "Application health",
        left: [
          new Metric({ namespace: "SprintPlanner", metricName: "ApplicationErrors", statistic: "Sum" }),
          new Metric({ namespace: "SprintPlanner", metricName: "BoardConflicts", statistic: "Sum" }),
        ],
      }),
      new GraphWidget({
        title: "Failure queues",
        left: [
          failureQueueMetric(notificationDlq, "Notification DLQ"),
          failureQueueMetric(streamFailureQueue, "Stream failures"),
          failureQueueMetric(eventConsumerFailureQueue, "Event consumer failures"),
        ],
      }),
    );
    dashboard.node.addDependency(conflictFilter);

    const websocketUrl = `${config.invokeEndpoint.replace(/^http/, "ws")}/${websocketApi.ref}/live`;
    const managementEndpoint = `${config.invokeEndpoint}/${websocketApi.ref}/live`;
    for (const target of [application, realtimeAuthorizer, realtimeConnection, broadcast]) {
      target.addEnvironment("WEBSOCKET_MANAGEMENT_ENDPOINT", managementEndpoint);
    }
    application.addEnvironment("WEBSOCKET_URL", websocketUrl);
    publisher.addEnvironment("EVENT_BUS_NAME", eventBus.ref);

    const outputs: Record<string, string> = {
      HttpApiId: httpApi.ref,
      ApiBaseUrl: `${config.invokeEndpoint}/${httpApi.ref}`,
      WebSocketApiId: websocketApi.ref,
      WebSocketUrl: websocketUrl,
      WebSocketStage: "live",
      ApplicationFunctionName: application.functionName,
      PublisherFunctionName: publisher.functionName,
      DomainEventBusName: eventBus.ref,
      NotificationQueueUrl: notificationQueue.ref,
      NotificationDeadLetterQueueUrl: notificationDlq.ref,
      StreamFailureQueueUrl: streamFailureQueue.ref,
      EventConsumerFailureQueueUrl: eventConsumerFailureQueue.ref,
      DashboardName: dashboard.dashboardName,
      CognitoUserPoolId: userPool.ref,
      CognitoAppClientId: appClient.ref,
      CognitoIssuer: cognitoIssuer,
    };
    for (const [key, value] of Object.entries(outputs)) {
      new CfnOutput(this, `${key}Output`, { value }).overrideLogicalId(key);
    }
  }
}

const app = new App();
const data = new SprintPlannerDataStack(app, "SprintPlannerDataStack", { env });
const web = new SprintPlannerWebStack(app, "SprintPlannerWebStack", { env });
new SprintPlannerAppStack(app, "SprintPlannerAppStack", {
  env,
  applicationTable: data.applicationTable,
  connectionTable: data.connectionTable,
  websiteUrl: web.websiteUrl,
});
