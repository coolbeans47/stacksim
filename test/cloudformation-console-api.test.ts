import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, waitUntilStackCreateComplete } from "@aws-sdk/client-cloudformation";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  CDK_BOOTSTRAP_COMPATIBILITY_VERSION,
  CDK_BOOTSTRAP_QUALIFIER,
  CDK_BOOTSTRAP_VERSION_PARAMETER,
  cdkBootstrapNames,
} from "../src/cloudformation/bootstrap.js";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

interface BootstrapRoleView {
  key: string;
  arn: string;
  roleName: string;
  status: string;
}

interface BootstrapView {
  owner: string;
  qualifier: string;
  compatibilityVersion: number;
  bucketName: string;
  bucketStatus: string;
  versionParameterName: string;
  versionParameterValue: string;
  status: string;
  roles: BootstrapRoleView[];
  fileAssets: { count: number; totalBytes: number };
  imageAssets: string;
}

async function getJson<T>(url: string): Promise<{ response: Response; value: T }> {
  const response = await fetch(url);
  return { response, value: await response.json() as T };
}

test("local CloudFormation console APIs expose template stages and durable redacted bootstrap diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-console-api-"));
  let simulator: StackSim | undefined;
  let cloudformation: CloudFormationClient | undefined;
  let s3: S3Client | undefined;
  const template = JSON.stringify({
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Local console template-stage fixture",
    Conditions: { IncludeExcludedFixture: { "Fn::Equals": ["included", "excluded"] } },
    Resources: {
      IncludedMetadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: "console-api" } },
      ExcludedQueue: { Type: "AWS::SQS::Queue", Condition: "IncludeExcludedFixture" },
    },
  });

  const start = async (): Promise<string> => {
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, cdkBootstrap: true, authMode: "off"});
    await simulator.start();
    return `http://127.0.0.1:${simulator.port}`;
  };

  try {
    let endpoint = await start();
    const options = { endpoint, region, credentials };
    cloudformation = new CloudFormationClient(options);
    s3 = new S3Client({ ...options, forcePathStyle: true });

    const created = await cloudformation.send(new CreateStackCommand({ StackName: "console-api-stack", TemplateBody: template }));
    assert.equal((await waitUntilStackCreateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: created.StackId })).state, "SUCCESS");

    const templateUrl = `${endpoint}/_stacksim/api/cloudformation/stacks/console-api-stack/template`;
    const original = await getJson<{ templateStage: string; templateBody: string }>(`${templateUrl}?templateStage=Original`);
    assert.equal(original.response.status, 200);
    assert.equal(original.value.templateStage, "Original");
    assert.ok(JSON.parse(original.value.templateBody).Resources.ExcludedQueue, "the original template retains conditionally excluded resources");

    const processed = await getJson<{ templateStage: string; templateBody: string }>(`${templateUrl}?templateStage=Processed`);
    assert.equal(processed.response.status, 200);
    assert.equal(processed.value.templateStage, "Processed");
    assert.equal(JSON.parse(processed.value.templateBody).Resources.ExcludedQueue, undefined, "the processed template reflects condition evaluation");
    assert.ok(JSON.parse(processed.value.templateBody).Resources.IncludedMetadata);

    const invalid = await getJson<{ __type: string; message: string }>(`${templateUrl}?templateStage=Invalid`);
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.value.__type, "ValidationError");
    assert.match(invalid.value.message, /TemplateStage Invalid is invalid/);

    const names = cdkBootstrapNames(accountId, region);
    await s3.send(new PutObjectCommand({ Bucket: names.bucketName, Key: "assets/console-secret-first.zip", Body: Buffer.from("abc") }));
    await s3.send(new PutObjectCommand({ Bucket: names.bucketName, Key: "assets/console-secret-second.zip", Body: Buffer.from("12345") }));

    const environment = await getJson<{ bootstrap: BootstrapView }>(`${endpoint}/_stacksim/api/environment`);
    assert.equal(environment.response.status, 200);
    const bootstrap = environment.value.bootstrap;
    assert.equal(bootstrap.owner, "stacksim");
    assert.equal(bootstrap.qualifier, CDK_BOOTSTRAP_QUALIFIER);
    assert.equal(bootstrap.compatibilityVersion, CDK_BOOTSTRAP_COMPATIBILITY_VERSION);
    assert.equal(bootstrap.bucketName, names.bucketName);
    assert.equal(bootstrap.bucketStatus, "available");
    assert.equal(bootstrap.versionParameterName, CDK_BOOTSTRAP_VERSION_PARAMETER);
    assert.equal(bootstrap.versionParameterValue, String(CDK_BOOTSTRAP_COMPATIBILITY_VERSION));
    assert.equal(bootstrap.status, "ready");
    assert.equal(bootstrap.imageAssets, "unsupported-until-ecr");
    assert.deepEqual(bootstrap.fileAssets, { count: 2, totalBytes: 8 });
    assert.deepEqual(Object.keys(bootstrap.fileAssets).sort(), ["count", "totalBytes"]);
    assert.deepEqual(bootstrap.roles.map(role => role.key).sort(), ["cloudFormationExecution", "deploy", "filePublishing", "imagePublishing", "lookup"]);
    assert.ok(bootstrap.roles.every(role => role.status === "available"));
    assert.deepEqual(bootstrap.roles.map(role => role.arn).sort(), Object.values(names.roleArns).sort());
    const serializedBootstrap = JSON.stringify(bootstrap);
    assert.doesNotMatch(serializedBootstrap, /console-secret-(?:first|second)\.zip/);
    assert.doesNotMatch(serializedBootstrap, /blobId|objectPath|storagePath|bodyBase64/);

    cloudformation.destroy();
    cloudformation = undefined;
    s3.destroy();
    s3 = undefined;
    assert.ok(simulator);
    await simulator.stop();
    simulator = undefined;

    endpoint = await start();
    const restarted = await getJson<{ bootstrap: BootstrapView }>(`${endpoint}/_stacksim/api/environment`);
    assert.equal(restarted.response.status, 200);
    assert.deepEqual(restarted.value.bootstrap.fileAssets, { count: 2, totalBytes: 8 }, "asset diagnostics survive a simulator restart without loading object bodies into the response");
    assert.doesNotMatch(JSON.stringify(restarted.value.bootstrap), /console-secret-(?:first|second)\.zip/);
  } finally {
    cloudformation?.destroy();
    s3?.destroy();
    await simulator?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
