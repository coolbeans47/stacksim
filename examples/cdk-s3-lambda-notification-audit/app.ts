import { App, Arn, CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { CfnPermission, Code, Function as Lambda, Runtime } from "aws-cdk-lib/aws-lambda";
import { BlockPublicAccess, Bucket, BucketEncryption, CfnBucket } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { join } from "node:path";

const environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000",
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "eu-west-1",
};

// These are the wildcard event families shown in StackSim's S3 event
// notification panel. One notification configuration can select all of them.
const directNotificationEvents = [
  "s3:ObjectCreated:*",
  "s3:ObjectRemoved:*",
  "s3:ObjectRestore:*",
  "s3:ObjectTagging:*",
  "s3:ObjectAcl:Put",
  "s3:ObjectAnnotation:*",
  "s3:LifecycleExpiration:*",
  "s3:LifecycleTransition",
];

class S3LambdaNotificationAuditStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Versioning makes delete-marker and version information visible in the
    // event records. The bucket starts empty and is retained during destroy so
    // a learner's objects are never deleted unexpectedly.
    // A stable physical name lets the Lambda permission name the source bucket
    // without creating a circular CloudFormation dependency.
    const bucketName = `s3-lambda-audit-${this.account}-${this.region}-${this.node.addr.slice(-8)}`;
    const bucketArn = Arn.format({
      partition: this.partition,
      service: "s3",
      region: "",
      account: "",
      resource: bucketName,
    });
    const bucket = new Bucket(this, "LearningBucket", {
      bucketName,
      versioned: true,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ACLS,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // One partition contains the history for one bucket. The sort key starts
    // with the event time, which keeps records naturally ordered by time.
    const auditTable = new Table(this, "EventAuditTable", {
      partitionKey: { name: "bucketName", type: AttributeType.STRING },
      sortKey: { name: "eventKey", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const auditFunction = new Lambda(this, "EventAuditFunction", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset(join(import.meta.dirname, "lambda")),
      description: "Turns direct S3 event notifications into educational DynamoDB audit records",
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        AUDIT_TABLE_NAME: auditTable.tableName,
      },
    });
    auditTable.grantWriteData(auditFunction);
    auditFunction.addToRolePolicy(new PolicyStatement({
      actions: ["s3:GetObjectTagging", "s3:GetObjectVersionTagging"],
      resources: [`${bucketArn}/*`],
    }));

    // Direct S3 notifications require a Lambda resource-policy statement for
    // the s3.amazonaws.com service principal and this exact source bucket.
    const invokePermission = new CfnPermission(this, "AllowS3BucketNotifications", {
      action: "lambda:InvokeFunction",
      functionName: auditFunction.functionName,
      principal: "s3.amazonaws.com",
      sourceAccount: this.account,
      sourceArn: bucketArn,
    });

    // This is the direct S3 notification configuration. CloudFormation creates
    // one Lambda configuration per event family, all targeting the same
    // function. The bucket waits until S3 has permission to invoke it.
    const cloudFormationBucket = bucket.node.defaultChild as CfnBucket;
    cloudFormationBucket.notificationConfiguration = {
      lambdaConfigurations: directNotificationEvents.map(event => ({
        event,
        function: auditFunction.functionArn,
      })),
    };
    cloudFormationBucket.addDependency(invokePermission);

    Tags.of(this).add("application", "s3-lambda-notification-audit");
    Tags.of(this).add("purpose", "education");

    new CfnOutput(this, "BucketName", {
      value: bucket.bucketName,
      description: "Empty versioned bucket used for the hands-on S3 tests",
    });
    new CfnOutput(this, "AuditTableName", {
      value: auditTable.tableName,
      description: "DynamoDB table containing readable event records",
    });
    new CfnOutput(this, "AuditFunctionName", { value: auditFunction.functionName });
  }
}

const app = new App();
new S3LambdaNotificationAuditStack(app, "S3LambdaNotificationAuditStack", { env: environment });
