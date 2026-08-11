import { App, CfnOutput, DefaultStackSynthesizer, Stack } from "aws-cdk-lib";
import { DockerImageAsset } from "aws-cdk-lib/aws-ecr-assets";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { join } from "node:path";

const app = new App();
const qualifier = process.env.CDK_TEST_QUALIFIER;
const stack = new Stack(app, "Cfn04NegativeStack", {
  env: {
    account: process.env.CDK_TEST_STACK_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_TEST_STACK_REGION ?? process.env.CDK_DEFAULT_REGION,
  },
  ...(qualifier ? { synthesizer: new DefaultStackSynthesizer({ qualifier }) } : {}),
  description: "Pinned standard-CDK CFN-04 negative-boundary fixture",
});

if (process.env.CDK_TEST_ASSET_KIND === "file") {
  const asset = new Asset(stack, "FileAsset", { path: join(import.meta.dirname, "asset.txt") });
  new CfnOutput(stack, "FileAssetKey", { value: asset.s3ObjectKey });
}

if (process.env.CDK_TEST_ASSET_KIND === "lambda-gate") {
  const asset = new Asset(stack, "LambdaFileAsset", { path: join(import.meta.dirname, "asset.txt") });
  new CfnFunction(stack, "PhaseGateFunction", {
    code: { s3Bucket: asset.s3BucketName, s3Key: asset.s3ObjectKey },
    handler: "index.handler",
    role: `arn:aws:iam::${process.env.CDK_DEFAULT_ACCOUNT}:role/cfn04-phase-gate-placeholder`,
    runtime: "nodejs22.x",
  });
}

if (process.env.CDK_TEST_ASSET_KIND === "image") {
  const asset = new DockerImageAsset(stack, "ImageAsset", { directory: join(import.meta.dirname, "image") });
  new CfnOutput(stack, "ImageUri", { value: asset.imageUri });
}
