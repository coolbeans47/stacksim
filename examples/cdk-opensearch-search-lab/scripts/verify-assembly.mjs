import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot } from "./common.mjs";
const template = async (name) =>
  JSON.parse(
    await readFile(
      join(projectRoot, "cdk.out", `${name}.template.json`),
      "utf8",
    ),
  );
const application = await template("SearchLabApplicationStack"),
  web = await template("SearchLabWebStack");
const resources = (stack, type) =>
  Object.values(stack.Resources).filter((resource) => resource.Type === type);
for (const type of [
  "AWS::OpenSearchService::Domain",
  "AWS::Lambda::Function",
  "AWS::ApiGateway::RestApi",
])
  assert.equal(resources(application, type).length, 1, type);
assert.equal(resources(application, "AWS::ApiGateway::Account").length, 0);
assert.equal(
  resources(application, "AWS::OpenSearchService::Domain")[0].Properties
    .EngineVersion,
  "OpenSearch_2.19",
);
assert.equal(
  resources(application, "AWS::Lambda::Function")[0].Properties.Runtime,
  "nodejs22.x",
);
for (const type of [
  "AWS::S3::Bucket",
  "Custom::CDKBucketDeployment",
  "Custom::S3AutoDeleteObjects",
])
  assert.equal(resources(web, type).length, 1, type);
assert.equal(resources(web, "AWS::S3::Bucket")[0].DeletionPolicy, "Delete");
const policies = JSON.stringify(resources(application, "AWS::IAM::Policy"));
assert.ok(
  policies.includes("/catalog/*"),
  "The Lambda role is scoped to the catalog index.",
);
console.log(
  "[search-lab] verified OpenSearch, Lambda REST API, scoped IAM and auto-cleaned S3 React website",
);
