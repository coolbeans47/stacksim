import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const templateFile = join(import.meta.dirname, "..", "cdk.out", "S3LambdaNotificationAuditStack.template.json");
const template = JSON.parse(await readFile(templateFile, "utf8"));
const entries = Object.entries(template.Resources ?? {});
const resources = entries.map(([, resource]) => resource);
const byType = type => resources.filter(resource => resource.Type === type);

assert.equal(byType("AWS::S3::Bucket").length, 1, "expected one learning bucket");
assert.equal(byType("AWS::DynamoDB::Table").length, 1, "expected one audit table");
assert.equal(byType("AWS::Lambda::Function").length, 1, "expected exactly one audit Lambda");
assert.equal(byType("AWS::Lambda::Permission").length, 1, "expected S3 permission to invoke Lambda");

const bucketEntry = entries.find(([, resource]) => resource.Type === "AWS::S3::Bucket");
const [bucketId, bucket] = bucketEntry;
const [permissionId, permission] = entries.find(([, resource]) => resource.Type === "AWS::Lambda::Permission");
assert.equal(permission.Properties.Principal, "s3.amazonaws.com");
assert.ok(JSON.stringify(permission.Properties.SourceArn).includes(bucket.Properties.BucketName), "Lambda permission must be limited to the learning bucket");

const lambdaConfigurations = bucket.Properties.NotificationConfiguration?.LambdaConfigurations;
assert.ok(Array.isArray(lambdaConfigurations), "the bucket's direct Lambda notification configuration is missing");
assert.deepEqual(lambdaConfigurations.map(configuration => configuration.Event), [
  "s3:ObjectCreated:*",
  "s3:ObjectRemoved:*",
  "s3:ObjectRestore:*",
  "s3:ObjectTagging:*",
  "s3:ObjectAcl:Put",
  "s3:ObjectAnnotation:*",
  "s3:LifecycleExpiration:*",
  "s3:LifecycleTransition",
]);
assert.ok(lambdaConfigurations.every(configuration => JSON.stringify(configuration.Function).includes("EventAuditFunction")), "every notification must target the audit Lambda");
const bucketDependencies = Array.isArray(bucket.DependsOn) ? bucket.DependsOn : [bucket.DependsOn];
assert.ok(bucketDependencies.includes(permissionId), `${bucketId} must wait for the Lambda permission`);

const table = byType("AWS::DynamoDB::Table")[0];
assert.deepEqual(table.Properties.KeySchema, [
  { AttributeName: "bucketName", KeyType: "HASH" },
  { AttributeName: "eventKey", KeyType: "RANGE" },
]);

const rolePolicies = JSON.stringify(byType("AWS::IAM::Policy").map(resource => resource.Properties.PolicyDocument));
assert.ok(rolePolicies.includes("s3:GetObjectTagging"), "the audit Lambda must be able to enrich current-version tagging events");
assert.ok(rolePolicies.includes("s3:GetObjectVersionTagging"), "the audit Lambda must be able to enrich versioned tagging events");

console.log("Verified direct S3 Lambda notification audit CDK assembly");
