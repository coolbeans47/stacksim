import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  NoSuchKey,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { CDK_BOOTSTRAP_POLICY_REVISION, cdkBootstrapNames } from "../src/cloudformation/bootstrap.js";
import {
  createCdkBucketDeploymentProvider,
  PINNED_BUCKET_DEPLOYMENT_AWSCLI_ASSET,
  PINNED_BUCKET_DEPLOYMENT_HANDLER_ASSET,
  type CdkBucketDeploymentModel,
} from "../src/cloudformation/providers/cdk-bucket-deployment.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const stackId = `arn:aws:cloudformation:${region}:${accountId}:stack/bucket-deployment-provider/stack-id`;
const functionName = "pinned-cdk-bucket-deployment-provider";
const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${functionName}`;
const roleName = "pinned-cdk-bucket-deployment-role";
const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
const layerArn = `arn:aws:lambda:${region}:${accountId}:layer:pinned-awscli:1`;
const identity: PrincipalContext = { accessKeyId: "admin", principalArn: `arn:aws:iam::${accountId}:root`, principalId: accountId, accountId };

function context(callbackContext?: Readonly<Record<string, any>>, logicalId = "DeployFrontend"): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId,
    logicalId,
    operationId: "operation-1",
    resourceOperationId: `${logicalId}-operation-1`,
    idempotencyKey: `${logicalId}-idempotency-key`,
    deadlineAt: Date.now() + 120_000,
    ...(callbackContext ? { callbackContext } : {}),
    principal: { identity },
  };
}

async function body(output: Awaited<ReturnType<S3Client["send"]>> | any): Promise<Buffer> {
  return Buffer.from(await output.Body.transformToByteArray());
}

async function seedPinnedHelper(simulator: StackSim, destinationBucket: string, s3: S3Client): Promise<void> {
  const sourceBucket = cdkBootstrapNames(accountId, region).bucketName;
  const sourceArn = `arn:aws:s3:::${sourceBucket}`;
  const destinationArn = `arn:aws:s3:::${destinationBucket}`;
  const handlerZip = createZip([{ name: "index.py", content: "def handler(event, context): return {}\n" }]);
  const layerZip = createZip([{ name: "aws", content: "pinned aws cli layer\n" }]);
  const handlerPut = await s3.send(new PutObjectCommand({ Bucket: sourceBucket, Key: PINNED_BUCKET_DEPLOYMENT_HANDLER_ASSET, Body: handlerZip }));
  const layerPut = await s3.send(new PutObjectCommand({ Bucket: sourceBucket, Key: PINNED_BUCKET_DEPLOYMENT_AWSCLI_ASSET, Body: layerZip }));
  assert.ok(handlerPut.VersionId && layerPut.VersionId);
  simulator.store.ensureAccount().iam.roles[roleName] = {
    roleName,
    roleId: "AROAPINNEDBUCKETDEPLOY",
    arn: roleArn,
    path: "/",
    createDate: Date.now(),
    maxSessionDuration: 3600,
    assumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] },
    tags: { "aws:cloudformation:stack-id": stackId, "aws:cloudformation:logical-id": "HelperRole" },
    attachedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
    inlinePolicies: {
      bucketDeployment: {
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: ["s3:GetObject*", "s3:GetBucket*", "s3:List*"], Resource: [sourceArn, `${sourceArn}/*`] },
          { Effect: "Allow", Action: ["s3:GetObject*", "s3:GetBucket*", "s3:List*", "s3:DeleteObject*", "s3:PutObject"], Resource: [destinationArn, `${destinationArn}/*`] },
        ],
      },
    },
  };
  simulator.store.regionState(region).lambdaLayers.pinnedAwsCli = {
    layerName: "pinned-awscli",
    layerArn: layerArn.slice(0, -2),
    nextVersion: 2,
    versions: {
      "1": {
        version: 1,
        layerArn: layerArn.slice(0, -2),
        arn: layerArn,
        description: "/opt/awscli/aws",
        createdDate: new Date().toISOString(),
        codeSha256: createHash("sha256").update(layerZip).digest("base64"),
        codeSize: layerZip.length,
        uncompressedCodeSize: 1,
        codeDir: "",
        compatibleRuntimes: [],
        compatibleArchitectures: [],
        cloudFormationOwner: `${stackId}\0AwsCliLayer`,
      },
    },
  };
  simulator.store.regionState(region).functions[functionName] = {
    functionName,
    functionArn,
    packageType: "Zip",
    runtime: "python3.13",
    handler: "index.handler",
    role: roleArn,
    timeout: 900,
    environment: { AWS_CA_BUNDLE: "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem" },
    codeSha256: createHash("sha256").update(handlerZip).digest("base64"),
    codeSize: handlerZip.length,
    tags: { "aws:cloudformation:stack-id": stackId, "aws:cloudformation:logical-id": "Helper" },
    layers: [{ arn: layerArn, codeSize: 1, uncompressedCodeSize: 1, codeDir: "", compatibleRuntimes: [], compatibleArchitectures: [] }],
  } as any;
  simulator.store.regionState(region).cloudformation.stacks[stackId] = {
    resources: {
      Helper: {
        logicalResourceId: "Helper",
        resourceType: "AWS::Lambda::Function",
        physicalResourceId: functionName,
        properties: { Code: { S3Bucket: sourceBucket, S3Key: PINNED_BUCKET_DEPLOYMENT_HANDLER_ASSET, S3ObjectVersion: handlerPut.VersionId }, Role: roleArn },
      },
      AwsCliLayer: {
        logicalResourceId: "AwsCliLayer",
        resourceType: "AWS::Lambda::LayerVersion",
        physicalResourceId: layerArn,
        refValue: layerArn,
        properties: { Content: { S3Bucket: sourceBucket, S3Key: PINNED_BUCKET_DEPLOYMENT_AWSCLI_ASSET, S3ObjectVersion: layerPut.VersionId } },
      },
      HelperRole: {
        logicalResourceId: "HelperRole",
        resourceType: "AWS::IAM::Role",
        physicalResourceId: roleName,
        attributes: { Arn: roleArn },
        properties: {},
      },
    },
  } as any;
}

function properties(sourceKey: string, destinationBucket: string): Record<string, unknown> {
  return {
    ServiceToken: functionArn,
    SourceBucketNames: [cdkBootstrapNames(accountId, region).bucketName],
    SourceObjectKeys: [sourceKey],
    DestinationBucketName: destinationBucket,
    DestinationBucketKeyPrefix: "site",
    WaitForDistributionInvalidation: true,
    Prune: true,
    OutputObjectKeys: true,
  };
}

async function settle(operation: (current: ProviderContext) => Promise<any>, firstContext = context()): Promise<any> {
  let current = firstContext;
  let result = await operation(current);
  for (let attempt = 0; result.status === "IN_PROGRESS" && attempt < 50; attempt++) {
    current = context(result.checkpoint.callbackContext);
    result = await operation(current);
  }
  return result;
}

test("native pinned BucketDeployment copies exact bytes, metadata, prunes, deduplicates, and resumes from a pinned source version", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-bucket-deployment-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  let s3: S3Client | undefined;
  try {
    await simulator.start();
    let endpoint = `http://127.0.0.1:${simulator.port}`;
    s3 = new S3Client({ endpoint, region, credentials, forcePathStyle: true });
    const destination = "provider-react-application";
    const bootstrap = cdkBootstrapNames(accountId, region).bucketName;
    await simulator.s3.ensureManagedBucket(bootstrap, CDK_BOOTSTRAP_POLICY_REVISION);
    await s3.send(new CreateBucketCommand({ Bucket: destination }));
    await s3.send(new PutBucketVersioningCommand({ Bucket: destination, VersioningConfiguration: { Status: "Enabled" } }));
    await seedPinnedHelper(simulator, destination, s3);
    const firstKey = `${"1".repeat(64)}.zip`;
    const firstZip = createZip([
      { name: "index.html", content: "<main>first</main>" },
      { name: "assets/app.js", content: "console.log('first');" },
      { name: "assets/app.css", content: "main{color:green}" },
      { name: "obsolete.txt", content: "remove me" },
    ]);
    await s3.send(new PutObjectCommand({ Bucket: bootstrap, Key: firstKey, Body: firstZip }));
    await simulator.store.save();
    let provider = createCdkBucketDeploymentProvider(simulator.s3, simulator.store);
    const initial = provider.canonicalize(properties(firstKey, destination), context());
    const captured = await provider.create(initial, context());
    assert.equal(captured.status, "IN_PROGRESS");
    const pin = (captured as any).checkpoint.callbackContext.sourcePins[0];
    assert.match(pin.versionId, /.+/);
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    const overwritten = await s3.send(new PutObjectCommand({ Bucket: bootstrap, Key: firstKey, Body: createZip([{ name: "index.html", content: "<main>wrong mutable head</main>" }]) }));

    // Restart after invocation capture: later phases must use the concrete
    // version and digest from the durable callback, never the mutable key head.
    // The direct-provider harness uses a deliberately minimal synthetic stack
    // resource solely for pinned helper attestation; remove and recreate that
    // harness record around service startup rather than asking CloudFormation
    // recovery to treat it as a complete stack journal.
    delete simulator.store.regionState(region).cloudformation.stacks[stackId];
    await simulator.store.save();
    s3.destroy(); s3 = undefined;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
    await simulator.start(); endpoint = `http://127.0.0.1:${simulator.port}`;
    s3 = new S3Client({ endpoint, region, credentials, forcePathStyle: true });
    await seedPinnedHelper(simulator, destination, s3);
    provider = createCdkBucketDeploymentProvider(simulator.s3, simulator.store);
    const copied = await provider.create(initial, context((captured as any).checkpoint.callbackContext));
    assert.equal(copied.status, "IN_PROGRESS", "the first pinned replay should checkpoint its first object copy");

    // A second restart after object copying proves that the real S3 write and
    // the provider phase can be safely replayed independently.
    delete simulator.store.regionState(region).cloudformation.stacks[stackId];
    await simulator.store.save();
    s3.destroy(); s3 = undefined;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
    await simulator.start(); endpoint = `http://127.0.0.1:${simulator.port}`;
    s3 = new S3Client({ endpoint, region, credentials, forcePathStyle: true });
    await seedPinnedHelper(simulator, destination, s3);
    provider = createCdkBucketDeploymentProvider(simulator.s3, simulator.store);
    const created = await settle(current => provider.create(initial, current), context((copied as any).checkpoint.callbackContext));
    assert.equal(created.status, "SUCCESS");
    assert.equal(provider.ref(created.model), created.physicalId);
    assert.deepEqual(provider.getAtt(created.model, "SourceObjectKeys"), [firstKey]);

    const html = await s3.send(new GetObjectCommand({ Bucket: destination, Key: "site/index.html" }));
    const js = await s3.send(new GetObjectCommand({ Bucket: destination, Key: "site/assets/app.js" }));
    const css = await s3.send(new GetObjectCommand({ Bucket: destination, Key: "site/assets/app.css" }));
    assert.equal((await body(html)).toString(), "<main>first</main>");
    assert.equal((await body(js)).toString(), "console.log('first');");
    assert.equal((await body(css)).toString(), "main{color:green}");
    assert.equal(html.ContentType, "text/html");
    assert.equal(js.ContentType, "application/javascript");
    assert.equal(css.ContentType, "text/css");

    await simulator.s3.deleteObjectVersionInternal(bootstrap, firstKey, overwritten.VersionId!);

    const versionsBefore = await s3.send(new ListObjectVersionsCommand({ Bucket: destination }));
    const identical = await settle(current => provider.update(created.physicalId, initial, initial, current));
    assert.equal(identical.status, "SUCCESS");
    const versionsAfter = await s3.send(new ListObjectVersionsCommand({ Bucket: destination }));
    assert.equal(versionsAfter.Versions?.length, versionsBefore.Versions?.length, "identical replay created an S3 version");

    const secondKey = `${"2".repeat(64)}.zip`;
    await s3.send(new PutObjectCommand({ Bucket: bootstrap, Key: secondKey, Body: createZip([
      { name: "index.html", content: "<main>second</main>" },
      { name: "assets/app.js", content: "console.log('second');" },
      { name: "assets/app.css", content: "main{color:blue}" },
    ]) }));
    const updated = provider.canonicalize(properties(secondKey, destination), context());
    assert.equal(provider.plan(initial, updated, context()).action, "UPDATE");
    const updateResult = await settle(current => provider.update(created.physicalId, initial, updated, current));
    assert.equal(updateResult.status, "SUCCESS");
    assert.equal((await body(await s3.send(new GetObjectCommand({ Bucket: destination, Key: "site/index.html" })))).toString(), "<main>second</main>");
    await assert.rejects(s3.send(new GetObjectCommand({ Bucket: destination, Key: "site/obsolete.txt" })), (error: any) => error instanceof NoSuchKey || error.name === "NoSuchKey");

    assert.equal((await provider.delete(created.physicalId, updated, context())).status, "SUCCESS");
    assert.equal((await body(await s3.send(new GetObjectCommand({ Bucket: destination, Key: "site/index.html" })))).toString(), "<main>second</main>", "default RetainOnDelete removed deployed bytes");
    assert.ok((await s3.send(new GetObjectCommand({ Bucket: bootstrap, Key: secondKey }))).Body, "application deletion removed the bootstrap asset");

    const deleteProperties = { ...properties(secondKey, destination), RetainOnDelete: false };
    const deleteModel = provider.canonicalize(deleteProperties, context());
    await s3.send(new PutBucketTaggingCommand({
      Bucket: destination,
      Tagging: { TagSet: [{ Key: "aws-cdk:cr-owned:ad3c1e9c", Value: "true" }] },
    }));
    const removed = await settle(current => provider.delete(created.physicalId, deleteModel, current));
    assert.equal(removed.status, "SUCCESS");
    await assert.rejects(s3.send(new GetObjectCommand({ Bucket: destination, Key: "site/index.html" })), (error: any) => error.name === "NoSuchKey");
    assert.ok((await s3.send(new GetObjectCommand({ Bucket: bootstrap, Key: secondKey }))).Body, "non-retaining application deletion crossed into the bootstrap bucket");
  } finally {
    s3?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("native BucketDeployment rejects schema drift and unsafe assets before destination mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-bucket-boundary-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "off"});
  let s3: S3Client | undefined;
  try {
    await simulator.start();
    s3 = new S3Client({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, forcePathStyle: true });
    const destination = "provider-unsafe-application";
    const bootstrap = cdkBootstrapNames(accountId, region).bucketName;
    await simulator.s3.ensureManagedBucket(bootstrap, CDK_BOOTSTRAP_POLICY_REVISION);
    await s3.send(new CreateBucketCommand({ Bucket: destination }));
    await s3.send(new PutObjectCommand({ Bucket: destination, Key: "sentinel.txt", Body: "untouched" }));
    await seedPinnedHelper(simulator, destination, s3);
    const provider = createCdkBucketDeploymentProvider(simulator.s3, simulator.store);
    const key = `${"3".repeat(64)}.zip`;
    const unsafe = Buffer.from(createZip([{ name: "safe.js", content: "unsafe" }]));
    const central = unsafe.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    Buffer.from("../evil").copy(unsafe, 30);
    Buffer.from("../evil").copy(unsafe, central + 46);
    await s3.send(new PutObjectCommand({ Bucket: bootstrap, Key: key, Body: unsafe }));
    const desired = provider.canonicalize(properties(key, destination), context());
    const rejected = await provider.create(desired, context());
    assert.equal(rejected.status, "FAILED");
    assert.equal((rejected as any).errorCode, "InvalidAsset");
    assert.equal((await body(await s3.send(new GetObjectCommand({ Bucket: destination, Key: "sentinel.txt" })))).toString(), "untouched");
    await assert.rejects(s3.send(new GetObjectCommand({ Bucket: destination, Key: "site/evil" })), (error: any) => error.name === "NoSuchKey");

    const drift = provider.validate({ ...properties(key, destination), Extract: false }, context());
    assert.ok(drift.some(item => item.code === "UnsupportedProperty" && item.path === "Properties.Extract"));
    assert.ok(provider.validate({ ...properties(key, destination), SourceBucketNames: [destination] }, context()).length);
    assert.ok(provider.validate({ ...properties(key, destination), Prune: false }, context()).length);
    const replacement = provider.canonicalize({ ...properties(key, destination), ServiceToken: `arn:aws:lambda:${region}:${accountId}:function:replacement-helper` }, context());
    assert.equal(provider.plan(desired, replacement, context()).action, "REPLACE");

    const validKey = `${"4".repeat(64)}.zip`;
    await s3.send(new PutObjectCommand({ Bucket: bootstrap, Key: validKey, Body: createZip([{ name: "index.html", content: "not authorized" }]) }));
    const destinationStatement = simulator.store.ensureAccount().iam.roles[roleName].inlinePolicies.bucketDeployment.Statement as any[];
    destinationStatement[1].Action = destinationStatement[1].Action.filter((action: string) => action !== "s3:PutObject");
    const unauthorized = await provider.create(provider.canonicalize(properties(validKey, destination), context()), context());
    assert.equal(unauthorized.status, "FAILED");
    assert.equal((unauthorized as any).errorCode, "AccessDenied");
    await assert.rejects(s3.send(new GetObjectCommand({ Bucket: destination, Key: "site/index.html" })), (error: any) => error.name === "NoSuchKey");
  } finally {
    s3?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
