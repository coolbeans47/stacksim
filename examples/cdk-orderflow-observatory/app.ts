import { App, ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import { Cors, EndpointType, LambdaIntegration, RestApi } from "aws-cdk-lib/aws-apigateway";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";
import { join } from "node:path";

const environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000",
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "eu-west-1",
};

class OrderFlowApplicationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const worker = new LambdaFunction(this, "WorkflowWorker", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset(join(import.meta.dirname, "lambda", "worker")),
      description: "Deterministic order validation, risk, inventory, packaging and dispatch operations",
      timeout: Duration.seconds(15),
      memorySize: 256,
      logGroup: new LogGroup(this, "WorkflowWorkerLogs", {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    const invoke = (
      id: string,
      operation: string,
      payload: Record<string, unknown>,
      resultSelector: Record<string, unknown>,
      resultPath?: string,
    ) => new tasks.LambdaInvoke(this, id, {
      lambdaFunction: worker,
      payload: sfn.TaskInput.fromObject({ operation, ...payload }),
      resultSelector,
      resultPath,
      retryOnServiceExceptions: false,
    });

    const validateOrder = invoke("Validate order", "validate", {
      "order.$": "$",
    }, {
      "accepted.$": "$.Payload.accepted",
      "lineCount.$": "$.Payload.lineCount",
    }, "$.validation");

    const markAccepted = new sfn.Pass(this, "Mark order accepted", {
      result: sfn.Result.fromObject({ status: "accepted", source: "orderflow-api" }),
      resultPath: "$.admission",
    });

    const reserveInventory = invoke("Reserve inventory", "inventory", {
      "order.$": "$",
      "attempt.$": "$$.State.RetryCount",
    }, {
      "reserved.$": "$.Payload.reserved",
      "warehouse.$": "$.Payload.warehouse",
      "attempt.$": "$.Payload.attempt",
    });
    reserveInventory.addRetry({
      errors: ["InventoryTransientError"],
      interval: Duration.seconds(1),
      backoffRate: 2,
      maxAttempts: 3,
    });

    const assessFraud = invoke("Assess fraud", "fraud", {
      "order.$": "$",
    }, {
      "approved.$": "$.Payload.approved",
      "score.$": "$.Payload.score",
      "band.$": "$.Payload.band",
    });

    const runChecks = new sfn.Parallel(this, "Run checks in parallel", {
      resultPath: "$.checks",
    });
    runChecks.branch(reserveInventory);
    runChecks.branch(assessFraud);

    const fraudDecision = new sfn.Choice(this, "Fraud approved?");
    const fraudRejected = new sfn.Fail(this, "Reject risky order", {
      error: "OrderRejected",
      cause: "The configured fraud score did not pass the approval threshold.",
    });

    const processingWindow = new sfn.Wait(this, "Processing window", {
      time: sfn.WaitTime.secondsPath("$.processingDelaySeconds"),
    });

    const packageItem = invoke("Package item", "package", {
      "orderId.$": "$.orderId",
      "item.$": "$.item",
      "itemIndex.$": "$.itemIndex",
      "failItem.$": "$.failItem",
    }, {
      "sku.$": "$.Payload.sku",
      "packageId.$": "$.Payload.packageId",
      "station.$": "$.Payload.station",
    });

    const packageItems = new sfn.Map(this, "Package items", {
      itemsPath: "$.items",
      maxConcurrency: 3,
      itemSelector: {
        "orderId.$": "$.orderId",
        "failItem.$": "$.failItem",
        "item.$": "$$.Map.Item.Value",
        "itemIndex.$": "$$.Map.Item.Index",
      },
      resultPath: "$.packages",
    });
    packageItems.itemProcessor(packageItem);

    const dispatchOrder = invoke("Dispatch order", "dispatch", {
      "orderId.$": "$.orderId",
      "customer.$": "$.customer",
      "packages.$": "$.packages",
    }, {
      "trackingNumber.$": "$.Payload.trackingNumber",
      "carrier.$": "$.Payload.carrier",
      "packageCount.$": "$.Payload.packageCount",
      "message.$": "$.Payload.message",
    }, "$.dispatch");

    const orderComplete = new sfn.Succeed(this, "Order complete");
    const compensate = invoke("Compensate order", "compensate", {
      "orderId.$": "$.orderId",
      "error.$": "$.workflowError",
    }, {
      "released.$": "$.Payload.released",
      "reason.$": "$.Payload.reason",
    }, "$.compensation");
    const orderFailed = new sfn.Fail(this, "Order failed", {
      error: "OrderProcessingFailed",
      cause: "A recoverable workflow stage exhausted its retry or map policy.",
    });
    compensate.next(orderFailed);

    runChecks.addCatch(compensate, {
      errors: ["States.ALL"],
      resultPath: "$.workflowError",
    });
    packageItems.addCatch(compensate, {
      errors: ["States.ALL"],
      resultPath: "$.workflowError",
    });

    validateOrder
      .next(markAccepted)
      .next(runChecks)
      .next(fraudDecision
        .when(sfn.Condition.booleanEquals("$.checks[1].approved", true), processingWindow
          .next(packageItems)
          .next(dispatchOrder)
          .next(orderComplete))
        .otherwise(fraudRejected));

    const stateMachine = new sfn.StateMachine(this, "OrderFlowStateMachine", {
      stateMachineName: "orderflow-observatory",
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(validateOrder),
      timeout: Duration.minutes(5),
      comment: "OrderFlow Observatory: visible Standard Workflow control flow",
    });

    const apiHandler = new LambdaFunction(this, "ApiHandler", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset(join(import.meta.dirname, "lambda", "api")),
      description: "Starts and inspects OrderFlow Step Functions executions",
      timeout: Duration.seconds(15),
      memorySize: 256,
      logGroup: new LogGroup(this, "ApiLogs", {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
        STATE_MACHINE_NAME: stateMachine.stateMachineName,
        RELEASE: "2026.07",
      },
    });
    apiHandler.addToRolePolicy(new PolicyStatement({
      actions: [
        "states:DescribeExecution",
        "states:DescribeStateMachine",
        "states:GetExecutionHistory",
        "states:ListExecutions",
        "states:StartExecution",
        "states:StopExecution",
      ],
      resources: [
        stateMachine.stateMachineArn,
        this.formatArn({
          service: "states",
          resource: "execution",
          resourceName: `${stateMachine.stateMachineName}:*`,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    }));

    const api = new RestApi(this, "OrderFlowApi", {
      restApiName: "orderflow-observatory",
      description: "Launch and observe Standard Workflow order executions",
      endpointTypes: [EndpointType.REGIONAL],
      // AWS::ApiGateway::Account is a regional singleton. OrderFlow does not
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
        description: "OrderFlow Observatory application stage",
      },
    });
    const integration = new LambdaIntegration(apiHandler);
    const executions = api.root.addResource("executions");
    executions.addMethod("GET", integration);
    executions.addMethod("POST", integration);
    const execution = executions.addResource("{executionArn}");
    execution.addMethod("GET", integration);
    execution.addResource("history").addMethod("GET", integration);
    execution.addResource("stop").addMethod("POST", integration);
    api.root.addResource("system").addMethod("GET", integration);

    Tags.of(this).add("application", "orderflow-observatory");
    Tags.of(this).add("managed-by", "stacksim-cdk-showcase");

    new CfnOutput(this, "ApiId", { value: api.restApiId });
    new CfnOutput(this, "StageName", { value: api.deploymentStage.stageName });
    new CfnOutput(this, "StateMachineArn", { value: stateMachine.stateMachineArn });
    new CfnOutput(this, "StateMachineName", { value: stateMachine.stateMachineName });
    new CfnOutput(this, "WorkerFunctionName", { value: worker.functionName });
    new CfnOutput(this, "ApiFunctionName", { value: apiHandler.functionName });
  }
}

class OrderFlowWebStack extends Stack {
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

    Tags.of(website).add("application", "orderflow-observatory");
    Tags.of(website).add("surface", "execution-observatory");
    new CfnOutput(this, "WebsiteUrl", { value: website.bucketWebsiteUrl });
    new CfnOutput(this, "WebsiteBucketName", { value: website.bucketName });
  }
}

const app = new App();
const application = new OrderFlowApplicationStack(app, "OrderFlowApplicationStack", {
  env: environment,
  description: "Step Functions workflow, Lambda tasks and observation API",
});
const web = new OrderFlowWebStack(app, "OrderFlowWebStack", {
  env: environment,
  description: "React execution observatory hosted on the stacksim S3 website endpoint",
});
web.addDependency(application, "The frontend is built with the deployed API identity");
