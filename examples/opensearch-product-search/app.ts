import { App, CfnOutput, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Domain, EngineVersion } from "aws-cdk-lib/aws-opensearchservice";

const app = new App();
const stack = new Stack(app, "ProductSearch", { env: { account: process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000", region: process.env.CDK_DEFAULT_REGION ?? "eu-west-1" } });
const domain = new Domain(stack, "Search", {
  version: EngineVersion.OPENSEARCH_2_19,
  capacity: { dataNodes: 1, dataNodeInstanceType: "r6gd.large.search" },
  ebs: { enabled: false },
  zoneAwareness: { enabled: false },
  encryptionAtRest: { enabled: false },
  nodeToNodeEncryption: false,
  enforceHttps: true,
  removalPolicy: RemovalPolicy.DESTROY,
});
new CfnOutput(stack, "DomainName", { value: domain.domainName });
new CfnOutput(stack, "Endpoint", { value: domain.domainEndpoint });
new CfnOutput(stack, "DomainArn", { value: domain.domainArn });
app.synth();
