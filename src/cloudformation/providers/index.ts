export * from "./contract.js";
export * from "./registry.js";
export * from "./cdk-metadata.js";
export * from "./iam.js";
export * from "./lambda-function.js";
export * from "./lambda-layer-version.js";
export * from "./lambda-companions.js";
export * from "./logs-log-group.js";
export * from "./apigateway-rest.js";
export * from "./dynamodb-table.js";
export * from "./dynamodb-global-table.js";
export * from "./s3-bucket.js";
export * from "./s3-bucket-policy.js";
export * from "./ssm-parameter.js";
export * from "./secrets-manager-secret.js";
export * from "./secrets-manager-resource-policy.js";
export * from "./secrets-manager-rotation.js";
export * from "./cdk-bucket-deployment.js";
export * from "./custom-resource.js";
export * from "./amplify-custom-resources.js";
export * from "./rds.js";
export * from "./cfn09.js";
export * from "./logs-cfn10.js";
export * from "./cloudwatch-cfn10.js";
export * from "./cloudwatch-metric-stream.js";
export * from "./sqs-queue-policy.js";
export * from "./apigateway-v2.js";
export * from "./lambda-cfn15.js";
export * from "./apigateway-rest-cfn15.js";
export * from "./ses.js";
export * from "./sns.js";
export * from "./appsync.js";
export * from "./cognito.js";
export * from "./step-functions-state-machine.js";
export * from "./nested-stack.js";

import { cdkMetadataProvider } from "./cdk-metadata.js";
import { CloudFormationProviderRegistry } from "./registry.js";

/** The public production registry for phases CFN-01 and CFN-02. */
export function createDefaultCloudFormationProviderRegistry(): CloudFormationProviderRegistry {
  return new CloudFormationProviderRegistry([cdkMetadataProvider]);
}
