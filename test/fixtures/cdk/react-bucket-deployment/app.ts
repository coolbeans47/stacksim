import { App, CfnOutput, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { join } from "node:path";

const app = new App();
const stack = new Stack(app, "ReactBucketStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: "Pinned stacksim public React S3 website deployment fixture",
});

const bucket = new s3.Bucket(stack, "FrontendBucket", {
  versioned: true,
  encryption: s3.BucketEncryption.S3_MANAGED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
  publicReadAccess: true,
  websiteIndexDocument: "index.html",
  removalPolicy: RemovalPolicy.RETAIN,
});

new s3deploy.BucketDeployment(stack, "DeployFrontend", {
  sources: [s3deploy.Source.asset(join(import.meta.dirname, "frontend", "dist"))],
  destinationBucket: bucket,
  ...(process.env.CDK_FRONTEND_PREFIX
    ? { destinationKeyPrefix: process.env.CDK_FRONTEND_PREFIX }
    : {}),
  prune: true,
});

new CfnOutput(stack, "FrontendBucketName", {
  value: bucket.bucketName,
});

new CfnOutput(stack, "FrontendWebsiteUrl", {
  value: bucket.bucketWebsiteUrl,
});
