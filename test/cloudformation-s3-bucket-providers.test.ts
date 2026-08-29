import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteBucketLifecycleCommand,
  GetBucketEncryptionCommand,
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketOwnershipControlsCommand,
  GetPublicAccessBlockCommand,
  GetBucketVersioningCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { TestClock } from "../src/core/clock.js";
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
    OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: false,
      RestrictPublicBuckets: false,
    },
    Tags: [{ Key: "aws-cdk:cr-owned:fixture", Value: "true" }, { Key: "application", Value: "react" }],
    VersioningConfiguration: { Status: "Enabled" },
    WebsiteConfiguration: { IndexDocument: "index.html" },
    CorsConfiguration: { CorsRules: [{ AllowedHeaders: ["*"], AllowedMethods: ["GET", "HEAD"], AllowedOrigins: [`https://${region}.console.aws.amazon.com/amplify`] }] },
    LifecycleConfiguration: { Rules: [{ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }, Status: "Enabled" }] },
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

function tlsOnlyPolicyProperties(bucket: string, sid?: string): Record<string, unknown> {
  const bucketArn = `arn:aws:s3:::${bucket}`;
  return {
    Bucket: bucket,
    PolicyDocument: {
      Statement: [{
        Action: "s3:*",
        Condition: { Bool: { "aws:SecureTransport": "false" } },
        Effect: "Deny",
        Principal: { AWS: "*" },
        Resource: [bucketArn, `${bucketArn}/*`],
        ...(sid ? { Sid: sid } : {}),
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
    assert.equal(bucketProvider.getAtt(created.model, "RegionalDomainName"), `${initial.BucketName}.s3.${region}.amazonaws.com`);
    const websiteUrl = String(bucketProvider.getAtt(created.model, "WebsiteURL"));
    assert.equal(websiteUrl, `http://127.0.0.1:${simulator.port}/_stacksim/s3-website/${initial.BucketName}/`);
    assert.equal((await bucketProvider.create(initial, context())).status, "SUCCESS", "a lost create response must converge on the owned bucket");

    assert.equal((await sdk.send(new GetBucketVersioningCommand({ Bucket: initial.BucketName }))).Status, "Enabled");
    assert.equal((await sdk.send(new GetBucketEncryptionCommand({ Bucket: initial.BucketName }))).ServerSideEncryptionConfiguration?.Rules?.[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm, "AES256");
    assert.equal((await sdk.send(new GetBucketOwnershipControlsCommand({ Bucket: initial.BucketName }))).OwnershipControls?.Rules?.[0].ObjectOwnership, "BucketOwnerEnforced");
    assert.deepEqual((await sdk.send(new GetPublicAccessBlockCommand({ Bucket: initial.BucketName }))).PublicAccessBlockConfiguration, {
      BlockPublicAcls: true,
      BlockPublicPolicy: false,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: false,
    });
    assert.deepEqual((await sdk.send(new GetBucketCorsCommand({ Bucket: initial.BucketName }))).CORSRules?.[0].AllowedMethods, ["GET", "HEAD"]);
    assert.equal((await sdk.send(new GetBucketLifecycleConfigurationCommand({ Bucket: initial.BucketName }))).Rules?.[0].AbortIncompleteMultipartUpload?.DaysAfterInitiation, 7);
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

    const tlsPolicy = policyProvider.canonicalize(tlsOnlyPolicyProperties(initial.BucketName), context("FrontendBucketPolicy"));
    assert.equal((await policyProvider.create(tlsPolicy, context("FrontendBucketPolicy"))).status, "SUCCESS");
    assert.equal((await policyProvider.create(tlsPolicy, context("FrontendBucketPolicy"))).status, "SUCCESS", "a lost TLS-policy create response must converge");
    assert.equal((await policyProvider.read(initial.BucketName, context("FrontendBucketPolicy"))).status, "SUCCESS");

    const policy = policyProvider.canonicalize(policyProperties(initial.BucketName), context("FrontendBucketPolicy"));
    const policyCreated = await policyProvider.update(initial.BucketName, tlsPolicy, policy, context("FrontendBucketPolicy"));
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
    updatedProperties.PublicAccessBlockConfiguration = {
      BlockPublicAcls: false,
      BlockPublicPolicy: false,
      IgnorePublicAcls: false,
      RestrictPublicBuckets: false,
    };
    updatedProperties.Tags = [{ Key: "application", Value: "react-v2" }];
    updatedProperties.WebsiteConfiguration = { IndexDocument: "index.html", ErrorDocument: "error.html" };
    updatedProperties.LifecycleConfiguration = { Rules: [{ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 8 }, Status: "Disabled" }] };
    const updated = bucketProvider.canonicalize(updatedProperties, context());
    assert.equal(bucketProvider.plan(initial, updated, context()).action, "UPDATE");
    const update = await bucketProvider.update(initial.BucketName, initial, updated, context());
    assert.equal(update.status, "SUCCESS");
    const read = await bucketProvider.read(initial.BucketName, context());
    assert.equal(read.status, "SUCCESS");
    if (read.status === "SUCCESS") assert.deepEqual(read.model.properties, updated);
    assert.deepEqual((await sdk.send(new GetBucketLifecycleConfigurationCommand({ Bucket: initial.BucketName }))).Rules?.[0], {
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 8 },
      Status: "Disabled",
    });
    assert.equal((await bucketProvider.update(initial.BucketName, updated, initial, context())).status, "SUCCESS", "rollback must restore the prior lifecycle configuration");
    assert.deepEqual((await sdk.send(new GetBucketLifecycleConfigurationCommand({ Bucket: initial.BucketName }))).Rules?.[0], {
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
      Status: "Enabled",
    });
    assert.equal((await bucketProvider.update(initial.BucketName, initial, updated, context())).status, "SUCCESS", "the intended update must remain replayable after rollback");

    sdk.destroy(); sdk = undefined;
    await simulator.stop();
    simulator = new StackSim(options);
    await simulator.start();
    sdk = new S3Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, forcePathStyle: true });
    bucketProvider = createS3BucketProvider(simulator.s3);
    policyProvider = createS3BucketPolicyProvider(simulator.s3);
    assert.equal((await bucketProvider.read(initial.BucketName, context())).status, "SUCCESS", "bucket ownership/configuration must survive restart");
    assert.equal((await policyProvider.read(initial.BucketName, context("FrontendBucketPolicy"))).status, "SUCCESS", "bucket policy must survive restart");

    await sdk.send(new DeleteBucketLifecycleCommand({ Bucket: initial.BucketName }));
    const drifted = await bucketProvider.read(initial.BucketName, context());
    assert.equal(drifted.status, "SUCCESS");
    if (drifted.status === "SUCCESS") assert.equal(drifted.model.properties.LifecycleConfiguration, undefined, "direct lifecycle deletion must be visible to CloudFormation read");
    const withoutLifecycleProperties = structuredClone(updatedProperties);
    delete withoutLifecycleProperties.LifecycleConfiguration;
    const withoutLifecycle = bucketProvider.canonicalize(withoutLifecycleProperties, context());
    assert.equal((await bucketProvider.update(initial.BucketName, updated, withoutLifecycle, context())).status, "SUCCESS");
    await assert.rejects(sdk.send(new GetBucketLifecycleConfigurationCommand({ Bucket: initial.BucketName })), error => (error as any).name === "NoSuchLifecycleConfiguration");

    assert.equal((await policyProvider.delete(initial.BucketName, policy, context("FrontendBucketPolicy"))).status, "SUCCESS");
    assert.equal((await fetch(String((await bucketProvider.read(initial.BucketName, context()) as any).model.attributes.WebsiteURL))).status, 403);
    for (const version of await simulator.s3.listObjectVersionsInternal(initial.BucketName)) {
      await simulator.s3.deleteObjectVersionInternal(initial.BucketName, version.key, version.versionId);
    }
    assert.equal((await bucketProvider.delete(initial.BucketName, withoutLifecycle, context())).status, "SUCCESS");
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

test("S3 TLS-only bucket-policy profile is enforced for direct HTTP requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-s3-tls-only-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "enforce" });
  let sdk: S3Client | undefined;
  const bucketName = "provider-tls-only-bucket";
  try {
    await simulator.start();
    sdk = new S3Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, forcePathStyle: true, maxAttempts: 1 });
    const bucketProvider = createS3BucketProvider(simulator.s3);
    const policyProvider = createS3BucketPolicyProvider(simulator.s3);
    const properties = bucketProperties(bucketName);
    delete properties.WebsiteConfiguration;
    delete properties.CorsConfiguration;
    delete properties.LifecycleConfiguration;
    properties.PublicAccessBlockConfiguration = { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true };
    const bucket = bucketProvider.canonicalize(properties, context("TlsBucket"));
    assert.equal((await bucketProvider.create(bucket, context("TlsBucket"))).status, "SUCCESS");
    await sdk.send(new PutObjectCommand({ Bucket: bucketName, Key: "private.txt", Body: "private" }));

    const policy = policyProvider.canonicalize(tlsOnlyPolicyProperties(bucketName), context("TlsBucketPolicy"));
    assert.equal((await policyProvider.create(policy, context("TlsBucketPolicy"))).status, "SUCCESS");
    assert.equal((await policyProvider.read(bucketName, context("TlsBucketPolicy"))).status, "SUCCESS");
    await assert.rejects(sdk.send(new HeadObjectCommand({ Bucket: bucketName, Key: "private.txt" })), error => (error as any).$metadata?.httpStatusCode === 403);

    assert.equal((await policyProvider.delete(bucketName, policy, context("TlsBucketPolicy"))).status, "SUCCESS");
    assert.equal((await sdk.send(new HeadObjectCommand({ Bucket: bucketName, Key: "private.txt" }))).ContentLength, 7);
    for (const version of await simulator.s3.listObjectVersionsInternal(bucketName)) await simulator.s3.deleteObjectVersionInternal(bucketName, version.key, version.versionId);
    assert.equal((await bucketProvider.delete(bucketName, bucket, context("TlsBucket"))).status, "SUCCESS");
  } finally {
    sdk?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
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
      ReplicationConfiguration: {},
      ObjectLockEnabled: true,
      LoggingConfiguration: {},
    }, context());
    for (const property of ["ReplicationConfiguration", "ObjectLockEnabled", "LoggingConfiguration"]) {
      assert.ok(blocked.some(item => item.code === "UnsupportedProperty" && item.path === `Properties.${property}`));
    }
    const disabledLifecycle = structuredClone(bucketProperties());
    (disabledLifecycle.LifecycleConfiguration as any).Rules[0].Status = "Disabled";
    assert.equal(bucketProvider.validate(disabledLifecycle, context()).length, 0);
    for (const [label, lifecycle, expectedPath] of [
      ["zero days", { Rules: [{ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 0 }, Status: "Enabled" }] }, "DaysAfterInitiation"],
      ["negative days", { Rules: [{ AbortIncompleteMultipartUpload: { DaysAfterInitiation: -1 }, Status: "Enabled" }] }, "DaysAfterInitiation"],
      ["fractional days", { Rules: [{ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1.5 }, Status: "Enabled" }] }, "DaysAfterInitiation"],
      ["missing abort action", { Rules: [{ Status: "Enabled" }] }, "AbortIncompleteMultipartUpload"],
      ["unknown abort member", { Rules: [{ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7, Extra: true }, Status: "Enabled" }] }, "Extra"],
      ["multiple rules", { Rules: [{ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }, Status: "Enabled" }, { AbortIncompleteMultipartUpload: { DaysAfterInitiation: 8 }, Status: "Disabled" }] }, "Rules"],
      ["transition default", { Rules: [{ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }, Status: "Enabled" }], TransitionDefaultMinimumObjectSize: "all_storage_classes_128K" }, "TransitionDefaultMinimumObjectSize"],
      ["expiration", { Rules: [{ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }, ExpirationInDays: 30, Status: "Enabled" }] }, "ExpirationInDays"],
    ] as const) {
      const properties = structuredClone(bucketProperties());
      properties.LifecycleConfiguration = lifecycle as any;
      assert.ok(bucketProvider.validate(properties, context()).some(item => item.path.endsWith(expectedPath)), `${label} must be rejected`);
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
    assert.equal(bucketProvider.validate(bucketProperties(), context()).length, 0, "all four public-access-block fields and exact ownership controls must be admitted");
    const invalidOwnership = structuredClone(bucketProperties());
    (invalidOwnership.OwnershipControls as any).Rules[0].ObjectOwnership = "ObjectWriter";
    assert.ok(bucketProvider.validate(invalidOwnership, context()).some(item => item.path === "Properties.OwnershipControls.Rules.0.ObjectOwnership"));
    const extraOwnership = structuredClone(bucketProperties());
    (extraOwnership.OwnershipControls as any).Rules[0].Unknown = true;
    assert.ok(bucketProvider.validate(extraOwnership, context()).some(item => item.path === "Properties.OwnershipControls.Rules.0.Unknown"));
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

    const tlsOnly = tlsOnlyPolicyProperties("provider-react-site", "DenyInsecureTransport");
    assert.equal(policyProvider.validate(tlsOnly, context("FrontendBucketPolicy")).length, 0);
    const arrayAction = structuredClone(tlsOnly);
    (arrayAction.PolicyDocument as any).Statement[0].Action = ["s3:*"];
    assert.equal(policyProvider.validate(arrayAction, context("FrontendBucketPolicy")).length, 0, "singleton action arrays normalize to the exact set");
    const booleanCondition = structuredClone(tlsOnly);
    (booleanCondition.PolicyDocument as any).Statement[0].Condition.Bool["aws:SecureTransport"] = false;
    assert.ok(policyProvider.validate(booleanCondition, context("FrontendBucketPolicy")).some(item => item.path.endsWith(".Condition")));
    const duplicateTls = structuredClone(tlsOnly);
    (duplicateTls.PolicyDocument as any).Statement.push(structuredClone((duplicateTls.PolicyDocument as any).Statement[0]));
    assert.ok(policyProvider.validate(duplicateTls, context("FrontendBucketPolicy")).some(item => item.path.endsWith(".Statement")), "duplicate TLS roles must not form a supported profile");

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

test("S3 bucket lifecycle provider aborts only eligible incomplete multipart uploads and honors disabled rules after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-s3-lifecycle-"));
  const clock = new TestClock(Date.parse("2026-08-01T00:00:00Z"));
  const options = { port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off" as const, clock };
  let simulator = new StackSim(options);
  let sdk: S3Client | undefined;
  const bucketName = "provider-lifecycle-bucket";
  try {
    await simulator.start();
    sdk = new S3Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, forcePathStyle: true });
    let provider = createS3BucketProvider(simulator.s3);
    const properties = bucketProperties(bucketName);
    delete properties.WebsiteConfiguration;
    delete properties.CorsConfiguration;
    const enabled = provider.canonicalize(properties, context("LifecycleBucket"));
    assert.equal((await provider.create(enabled, context("LifecycleBucket"))).status, "SUCCESS");
    await sdk.send(new PutObjectCommand({ Bucket: bucketName, Key: "complete.txt", Body: "complete" }));
    const first = await sdk.send(new CreateMultipartUploadCommand({ Bucket: bucketName, Key: "incomplete.bin" }));
    clock.advance(6 * 86_400_000);
    await simulator.s3.runLifecycleNow();
    assert.deepEqual((await sdk.send(new ListMultipartUploadsCommand({ Bucket: bucketName }))).Uploads?.map(upload => upload.UploadId), [first.UploadId]);

    sdk.destroy(); sdk = undefined; await simulator.stop();
    simulator = new StackSim(options); await simulator.start();
    sdk = new S3Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, forcePathStyle: true });
    provider = createS3BucketProvider(simulator.s3);
    clock.advance(86_400_000);
    await simulator.s3.runLifecycleNow();
    assert.equal((await sdk.send(new ListMultipartUploadsCommand({ Bucket: bucketName }))).Uploads?.length ?? 0, 0);
    assert.equal((await sdk.send(new HeadObjectCommand({ Bucket: bucketName, Key: "complete.txt" }))).ContentLength, 8, "completed objects must be unaffected");

    const disabledProperties = structuredClone(properties);
    (disabledProperties.LifecycleConfiguration as any).Rules[0].Status = "Disabled";
    const disabled = provider.canonicalize(disabledProperties, context("LifecycleBucket"));
    assert.equal((await provider.update(bucketName, enabled, disabled, context("LifecycleBucket"))).status, "SUCCESS");
    const second = await sdk.send(new CreateMultipartUploadCommand({ Bucket: bucketName, Key: "disabled.bin" }));
    clock.advance(30 * 86_400_000);
    await simulator.s3.runLifecycleNow();
    assert.deepEqual((await sdk.send(new ListMultipartUploadsCommand({ Bucket: bucketName }))).Uploads?.map(upload => upload.UploadId), [second.UploadId]);
    await sdk.send(new AbortMultipartUploadCommand({ Bucket: bucketName, Key: "disabled.bin", UploadId: second.UploadId }));
    for (const version of await simulator.s3.listObjectVersionsInternal(bucketName)) await simulator.s3.deleteObjectVersionInternal(bucketName, version.key, version.versionId);
    assert.equal((await provider.delete(bucketName, disabled, context("LifecycleBucket"))).status, "SUCCESS");
  } finally {
    sdk?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("S3 bucket-policy provider recognizes the exact semantic CloudFront OAC and auto-delete profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-s3-oac-policy-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off" });
  try {
    await simulator.start();
    const bucketProvider = createS3BucketProvider(simulator.s3);
    const policyProvider = createS3BucketPolicyProvider(simulator.s3);
    const bucketInput = bucketProperties("provider-private-cloudfront");
    delete bucketInput.WebsiteConfiguration;
    delete bucketInput.CorsConfiguration;
    bucketInput.PublicAccessBlockConfiguration = {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    };
    const bucket = bucketProvider.canonicalize(bucketInput, context("WebBucket"));
    const bucketCreated = await bucketProvider.create(bucket, context("WebBucket"));
    assert.equal(bucketCreated.status, "SUCCESS");
    const bucketArn = `arn:aws:s3:::${bucket.BucketName}`;
    const objectArn = `${bucketArn}/*`;
    const distributionArn = `arn:aws:cloudfront::${accountId}:distribution/E123ABC456DEF`;
    const tls = {
      Resource: [objectArn, bucketArn],
      Principal: { AWS: "*" },
      Effect: "Deny",
      Condition: { Bool: { "aws:SecureTransport": "false" } },
      Action: "s3:*",
    };
    const autoDelete = {
      Resource: [objectArn, bucketArn],
      Principal: { AWS: `arn:aws:iam::${accountId}:role/CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092` },
      Effect: "Allow",
      Action: ["s3:PutBucketPolicy", "s3:List*", "s3:DeleteObject*", "s3:GetBucket*"],
    };
    const oac = {
      Resource: objectArn,
      Principal: { Service: "cloudfront.amazonaws.com" },
      Effect: "Allow",
      Condition: { StringEquals: { "AWS:SourceArn": distributionArn } },
      Action: "s3:GetObject",
    };
    const legacyAutoDeleteOnly = { Bucket: bucket.BucketName, PolicyDocument: { Version: "2012-10-17", Statement: [autoDelete] } };
    assert.equal(policyProvider.validate(legacyAutoDeleteOnly, context("WebBucketPolicy")).length, 0, "the existing exact generated auto-delete-only profile remains supported");
    const supplied = { Bucket: bucket.BucketName, PolicyDocument: { Version: "2012-10-17", Statement: [oac, autoDelete, tls] } };
    assert.equal(policyProvider.validate(supplied, context("WebBucketPolicy")).length, 0);
    const policy = policyProvider.canonicalize(supplied, context("WebBucketPolicy"));
    assert.deepEqual((policy.PolicyDocument.Statement as any[]).map(statement => statement.Principal), [
      { AWS: "*" },
      { AWS: `arn:aws:iam::${accountId}:role/CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092` },
      { Service: "cloudfront.amazonaws.com" },
    ], "canonical policy order must be stable and independent of synthesized statement order");
    assert.deepEqual((policy.PolicyDocument.Statement as any[])[1].Action, ["s3:DeleteObject*", "s3:GetBucket*", "s3:List*", "s3:PutBucketPolicy"]);
    assert.equal((await policyProvider.create(policy, context("WebBucketPolicy"))).status, "SUCCESS");
    assert.equal((await policyProvider.read(bucket.BucketName, context("WebBucketPolicy"))).status, "SUCCESS");

    const reordered = structuredClone(supplied);
    (reordered.PolicyDocument as any).Statement = [tls, oac, { ...autoDelete, Action: [...autoDelete.Action].reverse(), Resource: [...autoDelete.Resource].reverse() }];
    assert.deepEqual(policyProvider.canonicalize(reordered, context("WebBucketPolicy")), policy, "statement/action/resource ordering is not semantic");

    const wrongAccount = structuredClone(supplied);
    (wrongAccount.PolicyDocument as any).Statement[0].Condition.StringEquals["AWS:SourceArn"] = "arn:aws:cloudfront::111111111111:distribution/E123ABC456DEF";
    assert.ok(policyProvider.validate(wrongAccount, context("WebBucketPolicy")).some(item => item.path.endsWith(".Condition")));
    const extraAction = structuredClone(supplied);
    (extraAction.PolicyDocument as any).Statement[1].Action.push("s3:PutObject");
    assert.ok(policyProvider.validate(extraAction, context("WebBucketPolicy")).some(item => item.path.endsWith(".Action")));
    const unsupportedFourth = structuredClone(supplied);
    (unsupportedFourth.PolicyDocument as any).Statement.push({ Effect: "Deny", Principal: "*", Action: ["s3:DeleteObject"], Resource: [objectArn] });
    assert.ok(policyProvider.validate(unsupportedFourth, context("WebBucketPolicy")).some(item => item.path === "Properties.PolicyDocument.Statement"));

    const cleanup = structuredClone(policy.PolicyDocument) as any;
    cleanup.Statement = [
      { Principal: "*", Effect: "Deny", Action: ["s3:PutObject"], Resource: [objectArn] },
      ...cleanup.Statement.reverse(),
    ];
    await simulator.s3.putBucketPolicyInternal(bucket.BucketName, cleanup);
    const cleanupRead = await policyProvider.read(bucket.BucketName, context("WebBucketPolicy"));
    assert.equal(cleanupRead.status, "FAILED", "the temporary cleanup profile must not become a steady-state read model");
    assert.equal((await policyProvider.delete(bucket.BucketName, policy, context("WebBucketPolicy"))).status, "SUCCESS", "delete recovery must recognize the exact temporary cleanup statement");
    assert.equal((await bucketProvider.delete(bucket.BucketName, bucket, context("WebBucket"))).status, "SUCCESS");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("S3 bucket-policy provider preserves Sid for direct public object hosting and recovers cleanup policies", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-s3-direct-policy-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off" });
  try {
    await simulator.start();
    const bucketProvider = createS3BucketProvider(simulator.s3);
    const policyProvider = createS3BucketPolicyProvider(simulator.s3);
    const providerRoleArn = `arn:aws:iam::${accountId}:role/CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092`;

    const createBucket = async (bucketName: string, logicalId: string) => {
      const input = bucketProperties(bucketName);
      input.PublicAccessBlockConfiguration = {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      };
      const bucket = bucketProvider.canonicalize(input, context(logicalId));
      assert.equal((await bucketProvider.create(bucket, context(logicalId))).status, "SUCCESS");
      return bucket;
    };

    const statementsFor = (bucketName: string) => {
      const bucketArn = `arn:aws:s3:::${bucketName}`;
      const objectArn = `${bucketArn}/*`;
      return {
        bucketArn,
        objectArn,
        tls: {
          Action: "s3:*",
          Condition: { Bool: { "aws:SecureTransport": "false" } },
          Effect: "Deny",
          Principal: { AWS: "*" },
          Resource: [bucketArn, objectArn],
        },
        autoDelete: {
          Action: ["s3:DeleteObject*", "s3:GetBucket*", "s3:List*", "s3:PutBucketPolicy"],
          Effect: "Allow",
          Principal: { AWS: providerRoleArn },
          Resource: [bucketArn, objectArn],
        },
        publicRead: {
          Action: "s3:GetObject",
          Effect: "Allow",
          Principal: { AWS: "*" },
          Resource: objectArn,
          Sid: "AllowPublicReadOfWebAssets",
        },
        cleanup: {
          Action: "s3:PutObject",
          Effect: "Deny",
          Principal: "*",
          Resource: objectArn,
        },
      };
    };

    const bucket = await createBucket("provider-direct-public-assets", "WebBucket");
    const exact = statementsFor(bucket.BucketName);
    const supplied = {
      Bucket: bucket.BucketName,
      PolicyDocument: {
        Statement: [exact.tls, exact.autoDelete, exact.publicRead],
        Version: "2012-10-17",
      },
    };
    const policyContext = context("WebBucketPolicy");
    assert.equal(policyProvider.validate(supplied, policyContext).length, 0, "the exact synthesized Shipments profile must be accepted");
    const policy = policyProvider.canonicalize(supplied, policyContext);
    const canonicalStatements = policy.PolicyDocument.Statement as any[];
    assert.deepEqual(canonicalStatements.map(statement => statement.Sid), [undefined, undefined, "AllowPublicReadOfWebAssets"]);
    assert.equal((await policyProvider.create(policy, policyContext)).status, "SUCCESS");
    const read = await policyProvider.read(bucket.BucketName, policyContext);
    assert.equal(read.status, "SUCCESS");
    if (read.status === "SUCCESS") assert.deepEqual(read.model.properties, policy, "read must preserve the public-read statement Sid");

    const reordered = structuredClone(supplied);
    (reordered.PolicyDocument as any).Statement = [
      exact.publicRead,
      { ...exact.autoDelete, Action: [...exact.autoDelete.Action].reverse(), Resource: [...exact.autoDelete.Resource].reverse() },
      { ...exact.tls, Resource: [...exact.tls.Resource].reverse() },
    ];
    assert.deepEqual(policyProvider.canonicalize(reordered, policyContext), policy, "statement/action/resource ordering is not semantic");

    const punctuatedSid = structuredClone(supplied);
    (punctuatedSid.PolicyDocument as any).Statement[2].Sid = "Allow-public-read";
    assert.equal(policyProvider.validate(punctuatedSid, policyContext).length, 0, "S3 resource-policy Sids may contain punctuation such as hyphens");

    for (const [label, sid] of [
      ["object", { value: "not-a-string" }],
      ["number", 7],
      ["empty", ""],
      ["control character", "AllowPublicRead\nOfWebAssets"],
    ] as const) {
      const malformed = structuredClone(supplied);
      (malformed.PolicyDocument as any).Statement[2].Sid = sid;
      const issues = policyProvider.validate(malformed, policyContext);
      assert.ok(issues.some(item => item.path === "Properties.PolicyDocument.Statement.2.Sid"), `${label} Sid must be rejected`);
      assert.throws(() => policyProvider.canonicalize(malformed, policyContext), /\.Sid/);
    }

    const duplicateSid = structuredClone(supplied);
    (duplicateSid.PolicyDocument as any).Statement[0].Sid = "AllowPublicReadOfWebAssets";
    const duplicateIssues = policyProvider.validate(duplicateSid, policyContext);
    assert.ok(duplicateIssues.some(item => item.path.endsWith(".Sid") && /duplicate|unique/i.test(item.message)), "duplicate Sid values must be rejected");
    assert.throws(() => policyProvider.canonicalize(duplicateSid, policyContext), /duplicate|unique/i);

    const cleanupPolicy = structuredClone(policy.PolicyDocument) as any;
    cleanupPolicy.Statement = [exact.cleanup, ...cleanupPolicy.Statement.reverse()];
    await simulator.s3.putBucketPolicyInternal(bucket.BucketName, cleanupPolicy);
    assert.equal((await policyProvider.read(bucket.BucketName, policyContext)).status, "FAILED", "cleanup state must not be exposed as a steady-state model");
    assert.equal((await policyProvider.delete(bucket.BucketName, policy, policyContext)).status, "SUCCESS", "delete recovery must retain and compare the public-read statement");
    assert.equal((await bucketProvider.delete(bucket.BucketName, bucket, context("WebBucket"))).status, "SUCCESS");

    const httpBucket = await createBucket("provider-direct-http-assets", "HttpWebBucket");
    const httpStatements = statementsFor(httpBucket.BucketName);
    const httpSupplied = {
      Bucket: httpBucket.BucketName,
      PolicyDocument: {
        Statement: [httpStatements.publicRead, httpStatements.autoDelete],
        Version: "2012-10-17",
      },
    };
    const httpPolicyContext = context("HttpWebBucketPolicy");
    assert.equal(policyProvider.validate(httpSupplied, httpPolicyContext).length, 0, "the direct HTTP profile omits only the TLS deny statement");
    const httpPolicy = policyProvider.canonicalize(httpSupplied, httpPolicyContext);
    assert.deepEqual((httpPolicy.PolicyDocument.Statement as any[]).map(statement => statement.Sid), [undefined, "AllowPublicReadOfWebAssets"]);
    assert.equal((await policyProvider.create(httpPolicy, httpPolicyContext)).status, "SUCCESS");
    const httpRead = await policyProvider.read(httpBucket.BucketName, httpPolicyContext);
    assert.equal(httpRead.status, "SUCCESS");
    if (httpRead.status === "SUCCESS") assert.deepEqual(httpRead.model.properties, httpPolicy);

    const httpCleanupPolicy = structuredClone(httpPolicy.PolicyDocument) as any;
    httpCleanupPolicy.Statement = [httpStatements.cleanup, ...httpCleanupPolicy.Statement.reverse()];
    await simulator.s3.putBucketPolicyInternal(httpBucket.BucketName, httpCleanupPolicy);
    assert.equal((await policyProvider.delete(httpBucket.BucketName, httpPolicy, httpPolicyContext)).status, "SUCCESS", "HTTP-profile cleanup recovery must include public read without TLS deny");
    assert.equal((await bucketProvider.delete(httpBucket.BucketName, httpBucket, context("HttpWebBucket"))).status, "SUCCESS");
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
