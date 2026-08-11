import { App, CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import {
  Cors,
  EndpointType,
  JsonSchemaType,
  LambdaIntegration,
  Model,
  RequestValidator,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { ArnPrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { join } from "node:path";

const environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000",
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "eu-west-1",
};

class SnsRoutingDataStack extends Stack {
  readonly incidents: Table;
  readonly deliveries: Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.incidents = new Table(this, "Incidents", {
      partitionKey: { name: "id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.deliveries = new Table(this, "Deliveries", {
      partitionKey: { name: "incidentId", type: AttributeType.STRING },
      sortKey: { name: "routeId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    Tags.of(this.incidents).add("application", "sns-routing-lab");
    Tags.of(this.incidents).add("purpose", "published-incidents");
    Tags.of(this.deliveries).add("application", "sns-routing-lab");
    Tags.of(this.deliveries).add("purpose", "subscription-observations");

    new CfnOutput(this, "IncidentsTableName", { value: this.incidents.tableName });
    new CfnOutput(this, "DeliveriesTableName", { value: this.deliveries.tableName });
  }
}

interface RoutingAppStackProps extends StackProps {
  readonly incidents: Table;
  readonly deliveries: Table;
}

class SnsRoutingAppStack extends Stack {
  readonly api: RestApi;

  constructor(scope: Construct, id: string, props: RoutingAppStackProps) {
    super(scope, id, props);

    const subscriptionDlq = new Queue(this, "SubscriptionDeadLetterQueue", {
      queueName: "sns-routing-lab-subscription-dlq",
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const auditQueue = new Queue(this, "AuditQueue", {
      queueName: "sns-routing-lab-audit",
      encryption: QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.seconds(10),
      retentionPeriod: Duration.days(1),
      deadLetterQueue: { queue: subscriptionDlq, maxReceiveCount: 3 },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const topic = new sns.Topic(this, "IncidentTopic", {
      topicName: "sns-routing-lab-incidents",
      displayName: "SNS Routing Lab incidents",
    });
    (topic.node.defaultChild as sns.CfnTopic).addPropertyOverride("SignatureVersion", "2");
    Tags.of(topic).add("application", "sns-routing-lab");
    Tags.of(topic).add("purpose", "attribute-and-body-routing");

    const subscriberCode = Code.fromAsset(join(import.meta.dirname, "lambda", "subscriber"));
    const subscriber = (id: string, routeId: string, routeName: string) => {
      const logs = new LogGroup(this, `${id}Logs`, {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const fn = new LambdaFunction(this, id, {
        runtime: Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: subscriberCode,
        description: `${routeName} SNS subscription consumer`,
        timeout: Duration.seconds(10),
        logGroup: logs,
        environment: {
          DELIVERIES_TABLE: props.deliveries.tableName,
          ROUTE_ID: routeId,
          ROUTE_NAME: routeName,
        },
      });
      props.deliveries.grantWriteData(fn);
      return fn;
    };

    const criticalResponder = subscriber("CriticalResponder", "critical-response", "Critical response");
    topic.addSubscription(new subscriptions.LambdaSubscription(criticalResponder, {
      deadLetterQueue: subscriptionDlq,
      filterPolicy: {
        severity: sns.SubscriptionFilter.stringFilter({ allowlist: ["critical"] }),
      },
    }));

    const paymentsTriage = subscriber("PaymentsTriage", "payments-triage", "Payments triage");
    topic.addSubscription(new subscriptions.LambdaSubscription(paymentsTriage, {
      deadLetterQueue: subscriptionDlq,
      filterPolicyWithMessageBody: {
        detail: sns.FilterOrPolicy.policy({
          service: sns.FilterOrPolicy.filter(
            sns.SubscriptionFilter.stringFilter({ allowlist: ["payments"] }),
          ),
        }),
      },
    }));

    const productionWatch = subscriber("ProductionWatch", "production-watch", "Production watch");
    topic.addSubscription(new subscriptions.LambdaSubscription(productionWatch, {
      deadLetterQueue: subscriptionDlq,
      filterPolicy: {
        environment: sns.SubscriptionFilter.stringFilter({ allowlist: ["production"] }),
      },
    }));

    topic.addSubscription(new subscriptions.SqsSubscription(auditQueue, {
      rawMessageDelivery: true,
      deadLetterQueue: subscriptionDlq,
    }));

    const auditLogs = new LogGroup(this, "AuditWorkerLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const auditWorker = new LambdaFunction(this, "AuditWorker", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset(join(import.meta.dirname, "lambda", "audit-worker")),
      description: "Consumes the SNS raw-message audit subscription",
      timeout: Duration.seconds(10),
      logGroup: auditLogs,
      environment: {
        DELIVERIES_TABLE: props.deliveries.tableName,
        ROUTE_ID: "audit-archive",
        ROUTE_NAME: "Audit archive",
      },
    });
    props.deliveries.grantWriteData(auditWorker);
    auditWorker.addEventSource(new SqsEventSource(auditQueue, {
      batchSize: 10,
      reportBatchItemFailures: true,
    }));

    const apiLogs = new LogGroup(this, "ApiLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const apiHandler = new LambdaFunction(this, "ApiHandler", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset(join(import.meta.dirname, "lambda", "api")),
      description: "Publishes incidents once to SNS and explains independent routing outcomes",
      timeout: Duration.seconds(15),
      memorySize: 256,
      logGroup: apiLogs,
      environment: {
        INCIDENTS_TABLE: props.incidents.tableName,
        DELIVERIES_TABLE: props.deliveries.tableName,
        TOPIC_ARN: topic.topicArn,
        TOPIC_NAME: topic.topicName,
        SUBSCRIPTION_DLQ_URL: subscriptionDlq.queueUrl,
        RELEASE: "2026.07",
      },
    });
    props.incidents.grantReadWriteData(apiHandler);
    props.deliveries.grantReadData(apiHandler);
    subscriptionDlq.grant(apiHandler, "sqs:GetQueueAttributes");
    topic.grantPublish(apiHandler);
    topic.addToResourcePolicy(new PolicyStatement({
      sid: "AllowPublisherRole",
      principals: [new ArnPrincipal(apiHandler.role!.roleArn)],
      actions: ["sns:Publish"],
      resources: [topic.topicArn],
    }));

    this.api = new RestApi(this, "RoutingApi", {
      restApiName: "sns-routing-lab",
      description: "Interactive SNS publish, filter and fan-out tutorial API",
      endpointTypes: [EndpointType.REGIONAL],
      // AWS::ApiGateway::Account is a regional singleton. This API does not
      // enable API Gateway access/execution logging, so it must not replace a
      // CloudWatch role configured by another example in the same installation.
      cloudWatchRole: false,
      defaultCorsPreflightOptions: {
        allowOrigins: Cors.ALL_ORIGINS,
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type"],
      },
      deployOptions: {
        stageName: "prod",
        description: "SNS Routing Lab tutorial stage",
      },
    });

    const publishModel = new Model(this, "PublishModel", {
      restApi: this.api,
      contentType: "application/json",
      modelName: "SnsRoutingLabIncident",
      description: "A validated incident that the API publishes once to SNS",
      schema: {
        type: JsonSchemaType.OBJECT,
        required: ["title", "summary", "severity", "service", "environment"],
        properties: {
          title: { type: JsonSchemaType.STRING, minLength: 3, maxLength: 80 },
          summary: { type: JsonSchemaType.STRING, minLength: 8, maxLength: 280 },
          severity: { type: JsonSchemaType.STRING, enum: ["critical", "high", "medium", "low"] },
          service: { type: JsonSchemaType.STRING, enum: ["payments", "identity", "search", "storefront"] },
          environment: { type: JsonSchemaType.STRING, enum: ["production", "staging", "development"] },
        },
      },
    });
    const validator = new RequestValidator(this, "RequestValidator", {
      restApi: this.api,
      requestValidatorName: "sns-routing-lab-body-validator",
      validateRequestBody: true,
      validateRequestParameters: false,
    });
    const integration = new LambdaIntegration(apiHandler);

    const incidents = this.api.root.addResource("incidents");
    incidents.addMethod("GET", integration);
    incidents.addMethod("POST", integration, {
      requestModels: { "application/json": publishModel },
      requestValidator: validator,
    });
    const demo = this.api.root.addResource("demo");
    demo.addResource("seed").addMethod("POST", integration);
    this.api.root.addResource("system").addMethod("GET", integration);

    Tags.of(this).add("application", "sns-routing-lab", {
      excludeResourceTypes: ["AWS::Lambda::EventSourceMapping"],
    });
    Tags.of(this).add("managed-by", "stacksim-cdk-showcase", {
      excludeResourceTypes: ["AWS::Lambda::EventSourceMapping"],
    });

    new CfnOutput(this, "ApiId", { value: this.api.restApiId });
    new CfnOutput(this, "StageName", { value: this.api.deploymentStage.stageName });
    new CfnOutput(this, "TopicArn", { value: topic.topicArn });
    new CfnOutput(this, "TopicName", { value: topic.topicName });
    new CfnOutput(this, "AuditQueueUrl", { value: auditQueue.queueUrl });
    new CfnOutput(this, "SubscriptionDeadLetterQueueUrl", { value: subscriptionDlq.queueUrl });
    new CfnOutput(this, "ApiFunctionName", { value: apiHandler.functionName });
  }
}

class SnsRoutingWebStack extends Stack {
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
    Tags.of(website).add("application", "sns-routing-lab");
    Tags.of(website).add("surface", "tutorial");

    new CfnOutput(this, "WebsiteUrl", { value: website.bucketWebsiteUrl });
    new CfnOutput(this, "WebsiteBucketName", { value: website.bucketName });
  }
}

const app = new App();
const data = new SnsRoutingDataStack(app, "SnsRoutingDataStack", {
  env: environment,
  description: "DynamoDB learning data for the SNS Routing Lab",
});
const routing = new SnsRoutingAppStack(app, "SnsRoutingAppStack", {
  env: environment,
  description: "SNS topic, filtered subscriptions, subscribers and tutorial API",
  incidents: data.incidents,
  deliveries: data.deliveries,
});
const web = new SnsRoutingWebStack(app, "SnsRoutingWebStack", {
  env: environment,
  description: "Public React tutorial deployed to the stacksim S3 website endpoint",
});
web.addDependency(routing, "The website is built with the deployed tutorial API identity");
