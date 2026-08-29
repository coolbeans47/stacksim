import { App, Duration, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { BlockPublicAccess, Bucket, BucketEncryption, CfnBucket, ObjectOwnership } from "aws-cdk-lib/aws-s3";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000";
const region = process.env.CDK_DEFAULT_REGION ?? "eu-west-1";
const stack = new Stack(app, "S3LifecycleFixture", { env: { account, region } });

const bucket = new Bucket(stack, "FilesBucket", {
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
  encryption: BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
  versioned: true,
  removalPolicy: RemovalPolicy.DESTROY,
  lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(7) }],
});
(bucket.node.defaultChild as CfnBucket).overrideLogicalId("FilesBucket759C181F");

for (const [key, value] of [
  ["Application", "StackSimShipments"],
  ["DataClassification", "Confidential"],
  ["Environment", "dev"],
  ["ManagedBy", "CDK"],
] as const) Tags.of(bucket).add(key, value);
