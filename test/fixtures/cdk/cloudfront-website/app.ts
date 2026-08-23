import { join } from "node:path";
import {
  App,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  Tags,
} from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";

const app = new App();
const environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000",
  region: process.env.CDK_DEFAULT_REGION ?? "eu-west-1",
};

const exportsByName = {
  userPoolId: "StackSimCloudFrontFixtureUserPoolId",
  userPoolClientId: "StackSimCloudFrontFixtureUserPoolClientId",
  apiId: "StackSimCloudFrontFixtureApiId",
  apiStage: "StackSimCloudFrontFixtureApiStage",
} as const;

const identity = new Stack(app, "FixtureIdentityExports", {
  env: environment,
  description: "Deterministic CloudFront fixture identity outputs",
});
new CfnOutput(identity, "UserPoolId", {
  exportName: exportsByName.userPoolId,
  value: "eu-west-1_FIXTURE",
});
new CfnOutput(identity, "UserPoolClientId", {
  exportName: exportsByName.userPoolClientId,
  value: "fixture-spa-client",
});

const api = new Stack(app, "FixtureApiExports", {
  env: environment,
  description: "Deterministic CloudFront fixture API outputs",
});
new CfnOutput(api, "ApiId", {
  exportName: exportsByName.apiId,
  value: "fixtureapi01",
});
new CfnOutput(api, "ApiStage", {
  exportName: exportsByName.apiStage,
  value: "fixture-v1",
});

const web = new Stack(app, "CloudFrontWebsiteStack", {
  env: environment,
  description: "Pinned stacksim private S3 CloudFront website fixture",
});
web.addDependency(identity);
web.addDependency(api);
for (const [key, value] of Object.entries({
  Application: "StackSimCloudFrontFixture",
  DataClassification: "Confidential",
  Environment: "test",
  ManagedBy: "CDK",
})) Tags.of(web).add(key, value);

const bucket = new s3.Bucket(web, "WebBucket", {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  enforceSSL: true,
  encryption: s3.BucketEncryption.S3_MANAGED,
  objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

const importedApiId = Fn.importValue(exportsByName.apiId);
const importedApiStage = Fn.importValue(exportsByName.apiStage);
const apiOrigin = Fn.join("", [
  "https://",
  importedApiId,
  `.execute-api.${web.region}.${web.urlSuffix}`,
]);
const responseHeaders = new cloudfront.ResponseHeadersPolicy(web, "SecurityHeaders", {
  responseHeadersPolicyName: "stacksim-cloudfront-fixture-security",
  securityHeadersBehavior: {
    contentTypeOptions: { override: true },
    frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
    referrerPolicy: {
      referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
      override: true,
    },
    strictTransportSecurity: {
      accessControlMaxAge: Duration.days(365),
      includeSubdomains: true,
      preload: true,
      override: true,
    },
    contentSecurityPolicy: {
      contentSecurityPolicy: Fn.join("", [
        "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self' ",
        apiOrigin,
        ` https://cognito-idp.${web.region}.${web.urlSuffix}`,
      ]),
      override: true,
    },
  },
});

const rewrite = new cloudfront.Function(web, "SpaRewrite", {
  code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var last = request.uri.split('/').pop();
  if (request.uri.endsWith('/') || last.indexOf('.') === -1) request.uri = '/index.html';
  return request;
}`),
});
const origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);
const distribution = new cloudfront.Distribution(web, "Distribution", {
  defaultRootObject: "index.html",
  httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
  defaultBehavior: {
    origin,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    responseHeadersPolicy: responseHeaders,
    functionAssociations: [{
      function: rewrite,
      eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
    }],
  },
  additionalBehaviors: {
    "assets/*": {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: responseHeaders,
      compress: true,
    },
    "runtime-config.json": {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      responseHeadersPolicy: responseHeaders,
    },
  },
});

const dist = join(import.meta.dirname, "frontend", "dist");
const applicationDeployment = new s3deploy.BucketDeployment(web, "DeployApplication", {
  destinationBucket: bucket,
  distribution,
  distributionPaths: ["/*"],
  sources: [
    s3deploy.Source.asset(dist, { exclude: ["assets/*"] }),
    s3deploy.Source.jsonData("runtime-config.json", {
      stage: "test",
      region: web.region,
      userPoolId: Fn.importValue(exportsByName.userPoolId),
      userPoolClientId: Fn.importValue(exportsByName.userPoolClientId),
      apiBaseUrl: Fn.join("", [apiOrigin, "/", importedApiStage, "/v1"]),
    }),
  ],
  cacheControl: [s3deploy.CacheControl.noCache()],
});
const assetDeployment = new s3deploy.BucketDeployment(web, "DeployAssets", {
  destinationBucket: bucket,
  sources: [s3deploy.Source.asset(dist, { exclude: ["*", "!assets", "!assets/*"] })],
  cacheControl: [s3deploy.CacheControl.fromString("public,max-age=31536000,immutable")],
  prune: false,
});
assetDeployment.node.addDependency(applicationDeployment);

new CfnOutput(web, "WebUrl", {
  value: Fn.join("", ["https://", distribution.distributionDomainName]),
});
new CfnOutput(web, "WebBucketName", { value: bucket.bucketName });

