import {
  App,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
} from "aws-cdk-lib";
import {
  Cors,
  EndpointType,
  LambdaIntegration,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  Code,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Domain, EngineVersion } from "aws-cdk-lib/aws-opensearchservice";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const app = new App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000",
  region:
    process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "eu-west-1",
};
const application = new Stack(app, "SearchLabApplicationStack", {
  env,
  description: "Embedded OpenSearch product catalog and Lambda REST API",
});
const domain = new Domain(application, "Search", {
  version: EngineVersion.OPENSEARCH_2_19,
  capacity: { dataNodes: 1, dataNodeInstanceType: "r6gd.large.search" },
  ebs: { enabled: false },
  zoneAwareness: { enabled: false },
  encryptionAtRest: { enabled: false },
  nodeToNodeEncryption: false,
  enforceHttps: true,
  removalPolicy: RemovalPolicy.DESTROY,
});
const caFile = join(import.meta.dirname, ".runtime", "ca.pem");
const apiHandler = new LambdaFunction(application, "SearchApi", {
  runtime: Runtime.NODEJS_22_X,
  handler: "index.handler",
  code: Code.fromAsset(join(import.meta.dirname, "lambda", "dist")),
  timeout: Duration.seconds(15),
  memorySize: 256,
  environment: {
    SEARCH_ENDPOINT: `https://${domain.domainEndpoint}`,
    SEARCH_INDEX: "catalog",
    // The public local CA is supplied by deploy.mjs; TLS verification stays on.
    ...(existsSync(caFile)
      ? { SEARCH_CA_PEM: readFileSync(caFile, "utf8") }
      : {}),
  },
  logGroup: new LogGroup(application, "SearchApiLogs", {
    retention: RetentionDays.ONE_WEEK,
    removalPolicy: RemovalPolicy.DESTROY,
  }),
});
apiHandler.addToRolePolicy(
  new PolicyStatement({
    actions: [
      "es:ESHttpGet",
      "es:ESHttpHead",
      "es:ESHttpPost",
      "es:ESHttpPut",
      "es:ESHttpDelete",
    ],
    resources: [`${domain.domainArn}/catalog`, `${domain.domainArn}/catalog/*`],
  }),
);
const api = new RestApi(application, "Api", {
  restApiName: "search-lab",
  endpointTypes: [EndpointType.REGIONAL],
  cloudWatchRole: false,
  deployOptions: { stageName: "prod" },
  defaultCorsPreflightOptions: {
    allowOrigins: Cors.ALL_ORIGINS,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  },
});
const integration = new LambdaIntegration(apiHandler);
api.root.addResource("search").addMethod("GET", integration);
api.root.addResource("seed").addMethod("POST", integration);
const products = api.root.addResource("products");
products.addMethod("POST", integration);
const product = products.addResource("{id}");
product.addMethod("PUT", integration);
product.addMethod("DELETE", integration);
for (const [name, value] of Object.entries({
  DomainName: domain.domainName,
  SearchEndpoint: `https://${domain.domainEndpoint}`,
  ApiId: api.restApiId,
  StageName: api.deploymentStage.stageName,
  ApiFunctionName: apiHandler.functionName,
}))
  new CfnOutput(application, name, { value });

const web = new Stack(app, "SearchLabWebStack", {
  env,
  description: "S3-hosted React OpenSearch learning demo",
});
const website = new Bucket(web, "Website", {
  encryption: BucketEncryption.S3_MANAGED,
  blockPublicAccess: BlockPublicAccess.BLOCK_ACLS,
  publicReadAccess: true,
  websiteIndexDocument: "index.html",
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});
new BucketDeployment(web, "DeployWebsite", {
  sources: [Source.asset(join(import.meta.dirname, "frontend", "dist"))],
  destinationBucket: website,
  prune: true,
});
new CfnOutput(web, "WebsiteUrl", { value: website.bucketWebsiteUrl });
new CfnOutput(web, "WebsiteBucketName", { value: website.bucketName });
web.addDependency(application, "React uses the deployed API identity");
Tags.of(app).add("application", "opensearch-search-lab");
