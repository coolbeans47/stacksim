import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test("CloudFormation console links S3, CDK deployment, and SES resources to their service views", async () => {
  const previousStorage = (globalThis as any).localStorage;
  (globalThis as any).localStorage = { getItem: () => null, setItem: () => undefined };
  let module: Record<string, unknown>;
  try {
    module = await import(pathToFileURL(join(process.cwd(), "web/services/cloudformation.js")).href);
  } finally {
    if (previousStorage === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = previousStorage;
  }
  const resourceLinks = module.relatedResourceLinks as Function;

  assert.deepEqual(resourceLinks({
    resourceType: "AWS::S3::Bucket",
    physicalResourceId: "react-site-assets",
    properties: {},
  }), [{ href: "#/s3/buckets/react-site-assets/objects" }]);

  assert.deepEqual(resourceLinks({
    resourceType: "Custom::CDKBucketDeployment",
    physicalResourceId: "aws.cdk.s3deployment.00000000-0000-0000-0000-000000000000",
    properties: { DestinationBucketName: "react site + assets", DestinationBucketKeyPrefix: "releases/v1" },
  }), [{ href: "#/s3/buckets/react%20site%20%2B%20assets/objects/releases%2Fv1%2F" }]);

  assert.deepEqual(resourceLinks({
    ResourceType: "Custom::CDKBucketDeployment",
    PhysicalResourceId: "aws.cdk.s3deployment.11111111-1111-1111-1111-111111111111",
    Properties: { DestinationBucketName: "react-site-assets" },
  }), [{ href: "#/s3/buckets/react-site-assets/objects" }]);
  assert.deepEqual(resourceLinks({
    resourceType: "Custom::CDKBucketDeployment",
    physicalResourceId: "aws.cdk.s3deployment.22222222-2222-2222-2222-222222222222",
    properties: {},
  }), []);

  assert.deepEqual(resourceLinks({
    resourceType: "AWS::SES::EmailIdentity",
    physicalResourceId: "sender+alerts@example.test",
    properties: {},
  }), [{ href: "#/ses/identities/sender%2Balerts%40example.test" }]);

  assert.deepEqual(resourceLinks({
    resourceType: "AWS::SES::ConfigurationSet",
    physicalResourceId: "transactional_mail",
    properties: {},
  }), [{ href: "#/ses/configuration-sets/transactional_mail" }]);

  assert.deepEqual(resourceLinks({
    ResourceType: "AWS::SES::Template",
    PhysicalResourceId: "welcome-template",
    Properties: {},
  }), [{ href: "#/ses/templates/welcome-template" }]);

  assert.deepEqual(resourceLinks({
    ResourceType: "AWS::StepFunctions::StateMachine",
    PhysicalResourceId: "arn:aws:states:eu-west-1:000000000000:stateMachine:order-workflow",
    Properties: {},
  }), [{ href: "#/step-functions/state-machines/arn%3Aaws%3Astates%3Aeu-west-1%3A000000000000%3AstateMachine%3Aorder-workflow" }]);
});
