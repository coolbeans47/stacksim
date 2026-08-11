import { App, Stack } from "aws-cdk-lib";
import {
  CfnBasePathMapping,
  CfnBasePathMappingV2,
  CfnClientCertificate,
  CfnDocumentationPart,
  CfnDocumentationVersion,
  CfnDomainName,
  CfnDomainNameAccessAssociation,
  CfnDomainNameV2,
  CfnVpcLink,
} from "aws-cdk-lib/aws-apigateway";
import { CfnMetricStream } from "aws-cdk-lib/aws-cloudwatch";
import { CfnGlobalTable } from "aws-cdk-lib/aws-dynamodb";
import { CfnCodeSigningConfig, CfnLayerVersionPermission, CfnUrl } from "aws-cdk-lib/aws-lambda";
import { CfnQueuePolicy } from "aws-cdk-lib/aws-sqs";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000";
const region = process.env.CDK_DEFAULT_REGION ?? "eu-west-1";
const stack = new Stack(app, "Cfn15Closure", {
  env: { account, region },
  description: "Pinned stacksim CFN-15 closure-provider synthesis corpus",
});

new CfnLayerVersionPermission(stack, "LayerPermission", {
  action: "lambda:GetLayerVersion",
  layerVersionArn: `arn:aws:lambda:${region}:${account}:layer:cfn15-layer:1`,
  principal: account,
});
new CfnUrl(stack, "FunctionUrl", {
  authType: "NONE",
  cors: { allowHeaders: ["content-type"], allowMethods: ["GET"], allowOrigins: ["*"], maxAge: 60 },
  invokeMode: "BUFFERED",
  targetFunctionArn: `arn:aws:lambda:${region}:${account}:function:cfn15-handler`,
});
new CfnCodeSigningConfig(stack, "SigningConfig", {
  allowedPublishers: { signingProfileVersionArns: [`arn:aws:signer:${region}:${account}:/signing-profiles/cfn15/abc123`] },
  codeSigningPolicies: { untrustedArtifactOnDeployment: "Warn" },
  description: "Descriptor-only local signing policy",
  tags: [{ key: "phase", value: "CFN-15" }],
});

new CfnDomainName(stack, "Domain", {
  domainName: "cfn15.example.test",
  endpointConfiguration: { types: ["REGIONAL"] },
  regionalCertificateArn: `arn:aws:acm:${region}:${account}:certificate/cfn15-descriptor`,
  securityPolicy: "TLS_1_2",
  tags: [{ key: "phase", value: "CFN-15" }],
});
new CfnBasePathMapping(stack, "Mapping", {
  basePath: "api",
  domainName: "cfn15.example.test",
  restApiId: "cfn15api",
  stage: "prod",
});
const privateDomainArn = `arn:aws:apigateway:${region}:${account}:/domainnames/private.cfn15.example.test+domainid15`;
new CfnDomainNameV2(stack, "PrivateDomain", {
  certificateArn: `arn:aws:acm:${region}:${account}:certificate/cfn15-private-descriptor`,
  domainName: "private.cfn15.example.test",
  endpointConfiguration: { types: ["PRIVATE"] },
  policy: { Version: "2012-10-17", Statement: [] },
  routingMode: "BASE_PATH_MAPPING_ONLY",
  securityPolicy: "TLS_1_2",
  tags: [{ key: "phase", value: "CFN-15" }],
});
new CfnBasePathMappingV2(stack, "PrivateMapping", {
  basePath: "private",
  domainNameArn: privateDomainArn,
  restApiId: "cfn15api",
  stage: "prod",
});
new CfnDomainNameAccessAssociation(stack, "PrivateAccess", {
  accessAssociationSource: "vpce-cfn15",
  accessAssociationSourceType: "VPCE",
  domainNameArn: privateDomainArn,
  tags: [{ key: "phase", value: "CFN-15" }],
});
new CfnVpcLink(stack, "VpcLink", {
  description: "Explicit local origin mapping",
  name: "cfn15-link",
  targetArns: [`arn:aws:elasticloadbalancing:${region}:${account}:loadbalancer/net/cfn15/0123456789abcdef`],
  tags: [{ key: "phase", value: "CFN-15" }],
});
new CfnClientCertificate(stack, "ClientCertificate", {
  description: "Opted-in local client-certificate descriptor",
  tags: [{ key: "phase", value: "CFN-15" }],
});
new CfnDocumentationPart(stack, "DocumentationPart", {
  location: { type: "API" },
  properties: JSON.stringify({ description: "CFN-15 documentation" }),
  restApiId: "cfn15api",
});
new CfnDocumentationVersion(stack, "DocumentationVersion", {
  description: "Pinned documentation snapshot",
  documentationVersion: "v15",
  restApiId: "cfn15api",
});

new CfnGlobalTable(stack, "GlobalTable", {
  attributeDefinitions: [{ attributeName: "pk", attributeType: "S" }],
  billingMode: "PAY_PER_REQUEST",
  keySchema: [{ attributeName: "pk", keyType: "HASH" }],
  replicas: [{ region }, { region: "us-east-1" }],
  streamSpecification: { streamViewType: "NEW_AND_OLD_IMAGES" },
  tableName: "Cfn15Global",
});
new CfnMetricStream(stack, "MetricStream", {
  firehoseArn: "file:///tmp/stacksim-cfn15-metrics",
  includeFilters: [{ namespace: "Learning/CFN15", metricNames: ["Requests"] }],
  name: "cfn15-stream",
  outputFormat: "json",
  roleArn: `arn:aws:iam::${account}:role/cfn15-metric-stream`,
  tags: [{ key: "phase", value: "CFN-15" }],
});
new CfnQueuePolicy(stack, "QueuePolicy", {
  policyDocument: {
    Version: "2012-10-17",
    Statement: [{
      Sid: "AllowAccountSend",
      Effect: "Allow",
      Principal: { AWS: `arn:aws:iam::${account}:root` },
      Action: "sqs:SendMessage",
      Resource: `arn:aws:sqs:${region}:${account}:cfn15-queue`,
    }],
  },
  queues: [`http://127.0.0.1:4566/${account}/cfn15-queue`],
});
