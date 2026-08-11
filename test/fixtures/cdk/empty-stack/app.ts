import { App, CfnOutput, CfnResource, Stack } from "aws-cdk-lib";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { join } from "node:path";

const app = new App();

const stack = new Stack(app, "EmptyStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: "Pinned stacksim CloudFormation endpoint probe",
});

if (process.env.CDK_TEST_ANALYTICS) {
  new CfnResource(stack, "WorkflowProbe", {
    type: "AWS::CDK::Metadata",
    properties: { Analytics: process.env.CDK_TEST_ANALYTICS },
  });
  new CfnOutput(stack, "ProbeOutput", { value: process.env.CDK_TEST_ANALYTICS });
}

if (process.env.CDK_GENERIC_ASSET === "true") {
  const asset = new Asset(stack, "GenericAsset", { path: join(import.meta.dirname, "asset.txt") });
  new CfnOutput(stack, "GenericAssetBucket", { value: asset.s3BucketName });
  new CfnOutput(stack, "GenericAssetHash", { value: asset.assetHash });
  new CfnOutput(stack, "GenericAssetKey", { value: asset.s3ObjectKey });
}
