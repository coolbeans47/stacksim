import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GetBucketEncryptionCommand,
  GetBucketCorsCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { createZip } from "../src/core/zip-create.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import {
  createS3BucketProvider,
  S3_BUCKET_SCHEMA,
} from "../src/cloudformation/providers/s3-bucket.js";
import {
  createS3BucketPolicyProvider,
  S3_BUCKET_POLICY_SCHEMA,
} from "../src/cloudformation/providers/s3-bucket-policy.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const identity: PrincipalContext = {
  accessKeyId: credentials.accessKeyId,
  principalArn: `arn:aws:iam::${accountId}:root`,
  principalId: accountId,
  accountId,
};

function context(logicalId = "FrontendBucket", stackId = `arn:aws:cloudformation:${region}:${accountId}:stack/react-site/stack-id`): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId,
    logicalId,
    operationId: "operation-1",
    resourceOperationId: `${logicalId}-operation-1`,
    idempotencyKey: `${logicalId}-stable-key`,
    deadlineAt: Date.now() + 60_000,
    principal: { identity },
  };
}

function bucketProperties(name = "provider-react-site"): Record<string, unknown> {
  return {
    BucketName: name,
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
    },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
    },
    Tags: [{ Key: "aws-cdk:cr-owned:fixture", Value: "true" }, { Key: "application", Value: "react" }],
    VersioningConfiguration: { Status: "Enabled" },
    WebsiteConfiguration: { IndexDocument: "index.html" },
    CorsConfiguration: { CorsRules: [{ AllowedHeaders: ["*"], AllowedMethods: ["GET", "HEAD"], AllowedOrigins: [`https://${region}.console.aws.amazon.com/amplify`] }] },
  };
}

function policyProperties(bucket: string): Record<string, unknown> {
  return {
    Bucket: bucket,
    PolicyDocument: {
      Statement: [{
        Action: "s3:GetObject",
        Effect: "Allow",
        Principal: { AWS: "*" },
        Resource: `arn:aws:s3:::${bucket}/*`,
      }],
      Version: "2012-10-17",
    },
  };
}

async function rawRequest(port: number, path: string, method: string, headers: Record<string, string>): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders }> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, method, headers }, response => {
      response.resume();
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, headers: response.headers }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("S3 bucket and bucket-policy providers drive the durable public website lifecycle", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-s3-provider-"));
  const options = { port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off" as const };
  let simulator = new StackSim(options);
  let sdk: S3Client | undefined;
  try {
    await simulator.start();
    sdk = new S3Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, forcePathStyle: true });
    let bucketProvider = createS3BucketProvider(simulator.s3);
    let policyProvider = createS3BucketPolicyProvider(simulator.s3);
    const initial = bucketProvider.canonicalize(bucketProperties(), context());
    assert.equal(bucketProvider.plan(undefined, initial, context()).action, "CREATE");
    assert.equal(bucketProvider.plan(initial, initial, context()).action, "NO_OP");

    const created = await bucketProvider.create(initial, context());
    assert.equal(created.status, "SUCCESS");
    if (created.status !== "SUCCESS") assert.fail(JSON.stringify(created));
    assert.equal(bucketProvider.ref(created.model), initial.BucketName);
    assert.equal(bucketProvider.getAtt(created.model, "Arn"), `arn:aws:s3:::${initial.BucketName}`);
    const websiteUrl = String(bucketProvider.getAtt(created.model, "WebsiteURL"));
    assert.equal(websiteUrl, `http://127.0.0.1:${simulator.port}/_stacksim/s3-website/${initial.BucketName}/`);
    assert.equal((await bucketProvider.create(initial, context())).status, "SUCCESS", "a lost create response must converge on the owned bucket");

    assert.equal((await sdk.send(new GetBucketVersioningCommand({ Bucket: initial.BucketName }))).Status, "Enabled");
    assert.equal((await sdk.send(new GetBucketEncryptionCommand({ Bucket: initial.BucketName }))).ServerSideEncryptionConfiguration?.Rules?.[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm, "AES256");
    assert.deepEqual((await sdk.send(new GetBucketCorsCommand({ Bucket: initial.BucketName }))).CORSRules?.[0].AllowedMethods, ["GET", "HEAD"]);
    const html = Buffer.from("<!doctype html><main>provider fixture</main>\n", "utf8");
    await sdk.send(new PutObjectCommand({ Bucket: initial.BucketName, Key: "index.html", Body: html, ContentType: "text/html; charset=utf-8" }));
    const corsOrigin = `https://${region}.console.aws.amazon.com/amplify`;
    const corsHost = `${initial.BucketName}.localhost:${simulator.port}`;
    const corsGet = await rawRequest(simulator.port, "/index.html", "GET", { Host: corsHost, Origin: corsOrigin });
    assert.equal(corsGet.headers["access-control-allow-origin"], corsOrigin);
    const preflight = await rawRequest(simulator.port, "/index.html", "OPTIONS", { Host: corsHost, Origin: corsOrigin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" });
    assert.equal(preflight.status, 200);
    assert.equal(preflight.headers["access-control-allow-methods"], "GET, HEAD");
    assert.equal((await fetch(websiteUrl)).status, 403, "website reads require the real public bucket policy");

    const policy = policyProvider.canonicalize(policyProperties(initial.BucketName), context("FrontendBucketPolicy"));
    const policyCreated = await policyProvider.create(policy, context("FrontendBucketPolicy"));
    assert.equal(policyCreated.status, "SUCCESS");
    if (policyCreated.status !== "SUCCESS") assert.fail(JSON.stringify(policyCreated));
    assert.equal(policyProvider.ref(policyCreated.model), initial.BucketName);
    const website = await fetch(websiteUrl);
    assert.equal(website.status, 200);
    assert.equal(website.headers.get("content-type"), "text/html; charset=utf-8");
    assert.deepEqual(Buffer.from(await website.arrayBuffer()), html);

    const conflictingPolicy = structuredClone(policy);
    (conflictingPolicy.PolicyDocument.Statement as any[])[0].Resource = `arn:aws:s3:::${initial.BucketName}/prefix/*`;
    const createConflict = await policyProvider.create(conflictingPolicy, context("FrontendBucketPolicy"));
    assert.equal(createConflict.status, "FAILED");
    if (createConflict.status === "FAILED") assert.equal(createConflict.errorCode, "AlreadyExists");

    const nonemptyDelete = await bucketProvider.delete(initial.BucketName, initial, context());
    assert.equal(nonemptyDelete.status, "FAILED");
    if (nonemptyDelete.status === "FAILED") assert.equal(nonemptyDelete.errorCode, "BucketNotEmpty");
    const foreign = await bucketProvider.read(initial.BucketName, context("FrontendBucket", `arn:aws:cloudformation:${region}:${accountId}:stack/foreign/stack-id`));
    assert.equal(foreign.status, "FAILED");
    if (foreign.status === "FAILED") assert.equal(foreign.errorCode, "OwnershipConflict");

    const updatedProperties = bucketProperties();
    updatedProperties.VersioningConfiguration = { Status: "Suspended" };
    updatedProperties.Tags = [{ Key: "application", Value: "react-v2" }];
    updatedProperties.WebsiteConfiguration = { IndexDocument: "index.html", ErrorDocument: "error.html" };
    const updated = bucketProvider.canonicalize(updatedProperties, context());
    assert.equal(bucketProvider.plan(initial, updated, context()).action, "UPDATE");
    const update = await bucketProvider.update(initial.BucketName, initial, updated, context());
    assert.equal(update.status, "SUCCESS");
    const read = await bucketProvider.read(initial.BucketName, context());
    assert.equal(read.status, "SUCCESS");
    if (read.status === "SUCCESS") assert.deepEqual(read.model.properties, updated);

    sdk.destroy(); sdk = undefined;
    await simulator.stop();
    simulator = new StackSim(options);
    await simulator.start();
    sdk = new S3Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, forcePathStyle: true });
    bucketProvider = createS3BucketProvider(simulator.s3);
    policyProvider = createS3BucketPolicyProvider(simulator.s3);
    assert.equal((await bucketProvider.read(initial.BucketName, context())).status, "SUCCESS", "bucket ownership/configuration must survive restart");
    assert.equal((await policyProvider.read(initial.BucketName, context("FrontendBucketPolicy"))).status, "SUCCESS", "bucket policy must survive restart");

    assert.equal((await policyProvider.delete(initial.BucketName, policy, context("FrontendBucketPolicy"))).status, "SUCCESS");
    assert.equal((await fetch(String((await bucketProvider.read(initial.BucketName, context()) as any).model.attributes.WebsiteURL))).status, 403);
    for (const version of await simulator.s3.listObjectVersionsInternal(initial.BucketName)) {
      await simulator.s3.deleteObjectVersionInternal(initial.BucketName, version.key, version.versionId);
    }
    assert.equal((await bucketProvider.delete(initial.BucketName, updated, context())).status, "SUCCESS");
    assert.equal((await bucketProvider.read(initial.BucketName, context())).status, "NOT_FOUND");

    const recreated = await bucketProvider.create(initial, context());
    assert.equal(recreated.status, "SUCCESS", "rollback recreation must be able to reclaim the deleted physical name");
    assert.equal((await bucketProvider.delete(initial.BucketName, initial, context())).status, "SUCCESS");
  } finally {
    sdk?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("S3 CloudFormation providers freeze the CDK subset and replacement/retention contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-s3-contract-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  try {
    await simulator.start();
    const bucketProvider = createS3BucketProvider(simulator.s3);
    const policyProvider = createS3BucketPolicyProvider(simulator.s3);
    const generated = bucketProvider.canonicalize({
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
      VersioningConfiguration: { Status: "Enabled" },
    }, context());
    assert.match(generated.BucketName, /^react-site-frontendbucket-[a-f0-9]{12}$/);
    assert.equal(bucketProvider.canonicalize({ BucketEncryption: bucketProperties().BucketEncryption }, context()).BucketName, generated.BucketName, "generated names must not depend on operation retries");
    const generatedCreated = await bucketProvider.create(generated, context());
    assert.equal(generatedCreated.status, "SUCCESS");
    assert.ok(simulator.store.regionState(region).s3Buckets[generated.BucketName], "generated bucket creation did not reach real S3 state");
    const renamed = bucketProvider.canonicalize(bucketProperties("provider-react-site-replacement"), context());
    const replacement = bucketProvider.plan(bucketProvider.canonicalize(bucketProperties(), context()), renamed, context());
    assert.equal(replacement.action, "REPLACE");
    assert.deepEqual(replacement.replacementProperties, ["BucketName"]);
    assert.equal(replacement.replacementOrder, "CREATE_BEFORE_DELETE");
    assert.equal((await bucketProvider.create(renamed, context())).status, "SUCCESS", "replacement create did not establish the new bucket");
    assert.equal((await bucketProvider.delete(generated.BucketName, generated, context())).status, "SUCCESS", "replacement cleanup did not delete the old generated bucket");
    assert.equal((await bucketProvider.delete(renamed.BucketName, renamed, context())).status, "SUCCESS");

    const blocked = bucketProvider.validate({
      ...bucketProperties(),
      LifecycleConfiguration: { Rules: [] },
      ReplicationConfiguration: {},
      ObjectLockEnabled: true,
      LoggingConfiguration: {},
    }, context());
    for (const property of ["LifecycleConfiguration", "ReplicationConfiguration", "ObjectLockEnabled", "LoggingConfiguration"]) {
      assert.ok(blocked.some(item => item.code === "UnsupportedProperty" && item.path === `Properties.${property}`));
    }
    const notificationProperties = bucketProperties("provider-notification-bucket");
    notificationProperties.NotificationConfiguration = {
      LambdaConfigurations: [{
        Event: "s3:ObjectCreated:*",
        Function: `arn:aws:lambda:${region}:${accountId}:function:audit-function`,
      }],
    };
    const notificationModel = bucketProvider.canonicalize(notificationProperties, context());
    assert.deepEqual(notificationModel.NotificationConfiguration?.LambdaConfigurations, [{
      Event: "s3:ObjectCreated:*",
      Function: `arn:aws:lambda:${region}:${accountId}:function:audit-function`,
    }]);
    assert.equal(bucketProvider.plan(bucketProvider.canonicalize(bucketProperties("provider-notification-bucket"), context()), notificationModel, context()).action, "UPDATE");
    const invalidNotification = structuredClone(notificationProperties);
    (invalidNotification.NotificationConfiguration as any).LambdaConfigurations[0].Event = "s3:Unknown:*";
    assert.ok(bucketProvider.validate(invalidNotification, context()).some(item => item.path.endsWith(".Event")));
    const driftedCors = structuredClone(bucketProperties());
    (driftedCors.CorsConfiguration as any).CorsRules[0].AllowedMethods = ["GET", "HEAD", "PUT"];
    assert.ok(bucketProvider.validate(driftedCors, context()).some(item => item.path.endsWith("AllowedMethods")));
    const unpinnedPublicBlock = structuredClone(bucketProperties());
    (unpinnedPublicBlock.PublicAccessBlockConfiguration as any).BlockPublicPolicy = false;
    (unpinnedPublicBlock.PublicAccessBlockConfiguration as any).RestrictPublicBuckets = false;
    const publicBlockIssues = bucketProvider.validate(unpinnedPublicBlock, context());
    assert.ok(publicBlockIssues.some(item => item.path === "Properties.PublicAccessBlockConfiguration.BlockPublicPolicy"));
    assert.ok(publicBlockIssues.some(item => item.path === "Properties.PublicAccessBlockConfiguration.RestrictPublicBuckets"));
    const kms = structuredClone(bucketProperties());
    (kms.BucketEncryption as any).ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault = { SSEAlgorithm: "aws:kms", KMSMasterKeyID: "alias/aws/s3" };
    assert.ok(bucketProvider.validate(kms, context()).some(item => item.path.includes("SSEAlgorithm") && /KMS/.test(item.message)));
    assert.throws(() => bucketProvider.canonicalize(kms, context()), /KMS/);

    const broadPolicy = policyProperties("provider-react-site");
    (broadPolicy.PolicyDocument as any).Statement[0].Action = "s3:*";
    (broadPolicy.PolicyDocument as any).Statement[0].Condition = { Bool: { "aws:SecureTransport": false } };
    const policyIssues = policyProvider.validate(broadPolicy, context("FrontendBucketPolicy"));
    assert.ok(policyIssues.some(item => item.path.endsWith(".Action")));
    assert.ok(policyIssues.some(item => item.path.endsWith(".Condition")));
    assert.throws(() => policyProvider.canonicalize(broadPolicy, context("FrontendBucketPolicy")), /s3:GetObject|Condition/);

    assert.deepEqual(S3_BUCKET_SCHEMA.retention.deletionPolicies, ["Delete", "Retain", "RetainExceptOnCreate"]);
    assert.deepEqual(S3_BUCKET_SCHEMA.retention.updateReplacePolicies, ["Delete", "Retain", "RetainExceptOnCreate"]);
    assert.deepEqual(S3_BUCKET_POLICY_SCHEMA.retention.deletionPolicies, ["Delete", "Retain", "RetainExceptOnCreate"]);
    assert.equal(S3_BUCKET_SCHEMA.retention.snapshotSupported, false);
    assert.equal(S3_BUCKET_POLICY_SCHEMA.retention.snapshotSupported, false);
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("S3 bucket provider applies and removes native direct Lambda notifications", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-s3-notification-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off" });
  let s3: S3Client | undefined;
  let lambda: LambdaClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    s3 = new S3Client({ endpoint, region, credentials, forcePathStyle: true });
    lambda = new LambdaClient({ endpoint, region, credentials });
    const createdFunction = await lambda.send(new CreateFunctionCommand({
      FunctionName: "provider-notification-audit",
      Runtime: "nodejs22.x",
      Role: `arn:aws:iam::${accountId}:role/test`,
      Handler: "index.handler",
      Code: { ZipFile: createZip([{ name: "index.js", content: "exports.handler = async () => undefined;" }]) },
    }));

    const provider = createS3BucketProvider(simulator.s3);
    const baseProperties = bucketProperties("provider-native-notification");
    const desired = provider.canonicalize({
      ...baseProperties,
      NotificationConfiguration: {
        LambdaConfigurations: [{ Event: "s3:ObjectCreated:*", Function: createdFunction.FunctionArn }],
      },
    }, context());
    const created = await provider.create(desired, context());
    assert.equal(created.status, "SUCCESS");
    const configured = await s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: desired.BucketName }));
    assert.deepEqual(configured.LambdaFunctionConfigurations?.map(item => ({ events: item.Events, arn: item.LambdaFunctionArn })), [{
      events: ["s3:ObjectCreated:*"],
      arn: createdFunction.FunctionArn,
    }]);

    const withoutNotification = provider.canonicalize(baseProperties, context());
    assert.equal((await provider.update(desired.BucketName, desired, withoutNotification, context())).status, "SUCCESS");
    assert.deepEqual((await s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: desired.BucketName }))).LambdaFunctionConfigurations, undefined);
    assert.equal((await provider.delete(desired.BucketName, withoutNotification, context())).status, "SUCCESS");
  } finally {
    s3?.destroy();
    lambda?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
