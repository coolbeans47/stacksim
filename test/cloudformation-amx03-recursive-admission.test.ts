import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  CreateStackCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
} from "@aws-sdk/client-cloudformation";
import { CreateBucketCommand, GetObjectCommand, PutBucketVersioningCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { TestClock } from "../src/core/clock.js";
import { S3Service } from "../src/s3.js";
import { StackSim } from "../src/server.js";
import { StateStore } from "../src/state.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function status(client: CloudFormationClient, stackName: string, expected: string): Promise<any> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const stack = (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
    if (stack?.StackStatus === expected) return stack;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

async function changeSet(client: CloudFormationClient, name: string, stackName: string): Promise<any> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await client.send(new DescribeChangeSetCommand({ ChangeSetName: name, StackName: stackName }));
    if (result.Status !== "CREATE_IN_PROGRESS") return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for change set ${name}`);
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactDirectory(root: string, collection: string): string {
  return join(root, "data", "cloudformation", accountId, region, "artifacts", collection);
}

test("AMX-03 admits, pins, and executes a two-level hierarchy without flattening", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx03-tree-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true });
    const cloudformation = new CloudFormationClient(options);
    clients.push(s3, cloudformation);
    const bucket = "amx03-recursive-templates";
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));

    const leafBody = JSON.stringify({ Resources: { Metadata: { Type: "AWS::CDK::Metadata" } }, Outputs: { Echo: { Value: { Ref: "Message" } } }, Parameters: { Message: { Type: "String" } } });
    const leafPut = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "leaf.json", Body: leafBody }));
    const leafUrl = `https://${bucket}.s3.${region}.amazonaws.com/leaf.json?versionId=${leafPut.VersionId}`;
    const childBody = JSON.stringify({
      Parameters: { Message: { Type: "String" } },
      Conditions: { IncludeLeaf: { "Fn::Equals": [{ Ref: "Message" }, "hello"] } },
      Resources: { Leaf: { Type: "AWS::CloudFormation::Stack", Condition: "IncludeLeaf", DependsOn: [], Properties: { TemplateURL: leafUrl, Parameters: { Message: { Ref: "Message" } }, Tags: [{ Key: "level", Value: "leaf" }] } } },
      Outputs: { Echo: { Condition: "IncludeLeaf", Value: { "Fn::GetAtt": ["Leaf", "Outputs.Echo"] } }, LeafId: { Condition: "IncludeLeaf", Value: { Ref: "Leaf" } } },
    });
    const childPut = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "child.json", Body: childBody }));
    const childUrl = `https://${bucket}.s3.${region}.amazonaws.com/child.json?versionId=${childPut.VersionId}`;
    const rootBody = JSON.stringify({ Resources: { Child: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: childUrl, Parameters: { Message: "hello" }, Tags: [{ Key: "level", Value: "child" }] } } }, Outputs: { Echo: { Value: { "Fn::GetAtt": ["Child", "Outputs.Echo"] } }, ChildId: { Value: { Ref: "Child" } } } });
    const rootPut = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "root.json", Body: rootBody }));
    const rootUrl = `https://${bucket}.s3.${region}.amazonaws.com/root.json?versionId=${rootPut.VersionId}`;

    const created = await cloudformation.send(new CreateStackCommand({ StackName: "amx03-tree", TemplateURL: rootUrl }));
    const completed = await status(cloudformation, created.StackId!, "CREATE_COMPLETE");
    assert.equal(completed.Outputs?.find((output: { OutputKey?: string; OutputValue?: string }) => output.OutputKey === "Echo")?.OutputValue, "hello");

    const state = simulator.store.regionState(region).cloudformation;
    const parent = state.stacks[created.StackId!];
    const child = state.stacks[parent.resources.Child.physicalResourceId!];
    const leaf = state.stacks[child.resources.Leaf.physicalResourceId!];
    assert.equal(child.parentId, parent.stackId);
    assert.equal(child.rootId, parent.stackId);
    assert.equal(child.parentLogicalId, "Child");
    assert.equal(leaf.parentId, child.stackId);
    assert.equal(leaf.rootId, parent.stackId);
    assert.equal(leaf.parentLogicalId, "Leaf");

    const artifactId = sha(parent.stackId);
    const manifest = JSON.parse(await readFile(join(artifactDirectory(root, "plans"), `${artifactId}.nested-templates.json`), "utf8"));
    assert.equal(manifest.schemaVersion, 2);
    assert.deepEqual({ templates: manifest.totalTemplates, resources: manifest.totalResources }, { templates: 3, resources: 3 });
    assert.equal(manifest.assets[0].versionId, childPut.VersionId);
    assert.equal(manifest.assets[0].digest, sha(childBody));
    assert.equal(manifest.assets[0].childStackId, child.stackId);
    assert.equal(manifest.assets[0].nestedTemplateManifest.assets[0].versionId, leafPut.VersionId);
    assert.equal(manifest.assets[0].nestedTemplateManifest.assets[0].digest, sha(leafBody));
    assert.equal(manifest.assets[0].nestedTemplateManifest.assets[0].childStackId, leaf.stackId);
    const source = JSON.parse(await readFile(join(artifactDirectory(root, "plans"), `${artifactId}.template-source.json`), "utf8"));
    assert.deepEqual({ versionId: source.versionId, digest: source.digest }, { versionId: rootPut.VersionId, digest: sha(rootBody) });
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("AMX-03 discovers the complete nested graph, then rolls back before an unsupported static item mutates workload state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx03-boundary-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true });
    const cloudformation = new CloudFormationClient(options);
    clients.push(s3, cloudformation);
    const bucket = "amx03-boundary-templates";
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
    const leaf = JSON.stringify({ Resources: { Metadata: { Type: "AWS::CDK::Metadata" } } });
    const first = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "first.json", Body: leaf }));
    const second = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "second.json", Body: leaf }));
    const data = JSON.stringify({ Resources: {
      First: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: `https://${bucket}.s3.${region}.amazonaws.com/first.json?versionId=${first.VersionId}` } },
      BlockedParameter: { Type: "AWS::SSM::Parameter", Properties: { Name: "/amx03/blocked", Type: "String", Value: "never-created", Tier: "Intelligent-Tiering" } },
      Second: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: `https://${bucket}.s3.${region}.amazonaws.com/second.json?versionId=${second.VersionId}` } },
    } });
    const dataPut = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "data.json", Body: data }));
    const rootBody = JSON.stringify({ Resources: { data: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: `https://${bucket}.s3.${region}.amazonaws.com/data.json?versionId=${dataPut.VersionId}` } } } });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "amx03-boundary", TemplateBody: rootBody }));
    const rolledBack = await status(cloudformation, created.StackId!, "ROLLBACK_COMPLETE");
    assert.match(rolledBack.StackStatusReason ?? "", /data: BlockedParameter: Properties\.Tier: Tier must be Standard or Advanced; Intelligent-Tiering remains unsupported/);
    const stackState = simulator.store.regionState(region).cloudformation.stacks[created.StackId!];
    assert.deepEqual(stackState.resources, {});
    assert.equal(Object.keys(simulator.store.regionState(region).cloudformation.stacks).length, 1, "no child stack catalog was created");
    assert.equal(Object.keys(simulator.store.regionState(region).functions).length, 0);
    assert.equal(Object.keys(simulator.store.regionState(region).tables).length, 0);
    assert.equal(Object.keys(simulator.store.regionState(region).appsync.graphqlApis).length, 0);

    const manifest = JSON.parse(await readFile(join(artifactDirectory(root, "plans"), `${sha(created.StackId!)}.nested-templates.json`), "utf8"));
    assert.deepEqual({ templates: manifest.totalTemplates, resources: manifest.totalResources, children: manifest.assets[0].nestedTemplateManifest.assets.length }, { templates: 4, resources: 6, children: 2 });
    assert.match(manifest.admissionFailure, /data: BlockedParameter: Properties\.Tier.*Intelligent-Tiering remains unsupported/);
    assert.equal(manifest.assets[0].versionId, dataPut.VersionId);
    assert.equal(manifest.assets[0].nestedTemplateManifest.assets[0].versionId, first.VersionId);
    assert.equal(manifest.assets[0].nestedTemplateManifest.assets[1].versionId, second.VersionId);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("AMX-03 truthfully rolls back a failure that becomes knowable only after authoritative parent resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx03-late-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true });
    const cloudformation = new CloudFormationClient(options);
    clients.push(s3, cloudformation);
    const templateBucket = "amx03-late-templates";
    const runtimeBucket = "amx03-late-runtime-owned";
    await s3.send(new CreateBucketCommand({ Bucket: templateBucket }));
    const child = JSON.stringify({
      Parameters: { Gate: { Type: "String" } },
      Conditions: { RuntimeOnly: { "Fn::Equals": [{ Ref: "Gate" }, runtimeBucket] } },
      Resources: { RuntimeParameter: { Type: "AWS::SSM::Parameter", Condition: "RuntimeOnly", Properties: { Name: "/amx03/runtime", Type: "String", Value: "rollback", Tier: "Intelligent-Tiering" } } },
    });
    await s3.send(new PutObjectCommand({ Bucket: templateBucket, Key: "child.json", Body: child }));
    const parent = JSON.stringify({ Resources: {
      GateBucket: { Type: "AWS::S3::Bucket", Properties: { BucketName: runtimeBucket } },
      Child: { Type: "AWS::CloudFormation::Stack", DependsOn: "GateBucket", Properties: { TemplateURL: `https://${templateBucket}.s3.${region}.amazonaws.com/child.json`, Parameters: { Gate: { Ref: "GateBucket" } } } },
    } });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "amx03-late-runtime", TemplateBody: parent }));
    const rolledBack = await status(cloudformation, created.StackId!, "ROLLBACK_COMPLETE");
    assert.match(rolledBack.StackStatusReason ?? "", /RuntimeParameter: Properties\.Tier: Tier must be Standard or Advanced; Intelligent-Tiering remains unsupported/);
    const regional = simulator.store.regionState(region);
    assert.equal(regional.s3Buckets[runtimeBucket], undefined, "the authoritative parent resource was removed by rollback");
    assert.ok(regional.s3Buckets[templateBucket]);
    assert.equal(Object.values(regional.cloudformation.stacks).filter(stack => stack.parentId).length, 0);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("AMX-03 rejects overwritten and tampered nested admission artifacts before change-set execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx03-integrity-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true });
    const cloudformation = new CloudFormationClient(options);
    clients.push(s3, cloudformation);
    const bucket = "amx03-integrity-templates";
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const childBody = JSON.stringify({ Resources: { Metadata: { Type: "AWS::CDK::Metadata" } }, Outputs: { Value: { Value: "original" } } });
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "child.json", Body: childBody }));
    const template = JSON.stringify({ Resources: { Child: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: `https://${bucket}.s3.${region}.amazonaws.com/child.json` } } }, Outputs: { Value: { Value: { "Fn::GetAtt": ["Child", "Outputs.Value"] } } } });
    await cloudformation.send(new CreateChangeSetCommand({ StackName: "amx03-overwrite", ChangeSetName: "overwrite", ChangeSetType: "CREATE", TemplateBody: template }));
    assert.equal((await changeSet(cloudformation, "overwrite", "amx03-overwrite")).Status, "CREATE_COMPLETE");
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "child.json", Body: JSON.stringify({ Resources: { Metadata: { Type: "AWS::CDK::Metadata" } }, Outputs: { Value: { Value: "overwritten" } } }) }));
    const currentBody = await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "child.json" }))).Body!.transformToString();
    assert.notEqual(sha(currentBody), sha(childBody));
    const overwriteInputName = (await readdir(artifactDirectory(root, "change-sets"))).find(name => name.endsWith(".input.json"))!;
    const overwriteArtifact = JSON.parse(await readFile(join(artifactDirectory(root, "change-sets"), overwriteInputName), "utf8"));
    assert.equal(overwriteArtifact.nestedTemplateManifest.assets[0].versionId, "null");
    assert.equal(overwriteArtifact.nestedTemplateManifest.assets[0].digest, sha(childBody));
    await assert.rejects(cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: "overwrite", StackName: "amx03-overwrite" })), (error: any) => error.name === "ValidationError" && /pinned object.*missing or failed immutable digest validation/i.test(error.message));
    const reviewId = simulator.store.regionState(region).cloudformation.stackNames["amx03-overwrite"];
    assert.deepEqual(simulator.store.regionState(region).cloudformation.stacks[reviewId].resources, {});

    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "child.json", Body: childBody }));
    await cloudformation.send(new CreateChangeSetCommand({ StackName: "amx03-tamper", ChangeSetName: "tamper", ChangeSetType: "CREATE", TemplateBody: template }));
    assert.equal((await changeSet(cloudformation, "tamper", "amx03-tamper")).Status, "CREATE_COMPLETE");
    const tamperState = Object.values(simulator.store.regionState(region).cloudformation.changeSets).find(value => value.changeSetName === "tamper")!;
    const inputPath = join(artifactDirectory(root, "change-sets"), `${tamperState.templateArtifactId}.input.json`);
    const artifact = JSON.parse(await readFile(inputPath, "utf8"));
    artifact.nestedTemplateManifest.assets[0].body += " ";
    await writeFile(inputPath, `${JSON.stringify(artifact, null, 2)}\n`);
    await assert.rejects(cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: "tamper", StackName: "amx03-tamper" })), (error: any) => error.name === "ValidationError" && /immutable child-template artifact failed integrity validation/i.test(error.message));
    const tamperedReviewId = simulator.store.regionState(region).cloudformation.stackNames["amx03-tamper"];
    assert.deepEqual(simulator.store.regionState(region).cloudformation.stacks[tamperedReviewId].resources, {});
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("AMX-03 reports missing, wrong-version, wrong-bucket, and cross-Region nested templates before stack admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx03-location-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true });
    const cloudformation = new CloudFormationClient(options);
    clients.push(s3, cloudformation);
    await s3.send(new CreateBucketCommand({ Bucket: "amx03-location-templates" }));
    await s3.send(new PutBucketVersioningCommand({ Bucket: "amx03-location-templates", VersioningConfiguration: { Status: "Enabled" } }));
    await s3.send(new PutObjectCommand({ Bucket: "amx03-location-templates", Key: "child.json", Body: JSON.stringify({ Resources: {} }) }));
    const cases = [
      ["missing", "https://amx03-location-templates.s3.eu-west-1.amazonaws.com/missing.json", /NoSuchKey|does not exist/i],
      ["wrong-version", "https://amx03-location-templates.s3.eu-west-1.amazonaws.com/child.json?versionId=not-a-version", /NoSuchVersion|does not exist/i],
      ["wrong-bucket", "https://amx03-wrong-bucket.s3.eu-west-1.amazonaws.com/child.json", /NoSuchBucket|does not exist/i],
      ["cross-region", "https://amx03-location-templates.s3.us-east-1.amazonaws.com/child.json", /Region us-east-1 does not match stack Region eu-west-1/i],
    ] as const;
    for (const [name, url, pattern] of cases) {
      const body = JSON.stringify({ Resources: { Child: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: url } } } });
      await assert.rejects(cloudformation.send(new CreateStackCommand({ StackName: `amx03-${name}`, TemplateBody: body })), (error: any) => error.name === "ValidationError" && pattern.test(error.message));
      assert.equal(simulator.store.regionState(region).cloudformation.stackNames[`amx03-${name}`], undefined);
    }
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("AMX-03 rejects a nested template owned by another account", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx03-account-"));
  const foreignAccount = "111111111111";
  const foreignStore = new StateStore(root, foreignAccount, region);
  await foreignStore.load();
  const foreignS3 = new S3Service(foreignStore, region, new TestClock());
  await foreignS3.start();
  await foreignS3.createBucketInternal({ name: "amx03-foreign-templates", versioning: "unversioned", encryption: "AES256" });
  await foreignS3.putObjectBytesInternal("amx03-foreign-templates", "child.json", Buffer.from(JSON.stringify({ Resources: {} })));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const cloudformation = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    clients.push(cloudformation);
    const body = JSON.stringify({ Resources: { Child: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: "https://amx03-foreign-templates.s3.eu-west-1.amazonaws.com/child.json" } } } });
    await assert.rejects(cloudformation.send(new CreateStackCommand({ StackName: "amx03-cross-account", TemplateBody: body })), (error: any) => error.name === "ValidationError" && /owned by account 111111111111, not stack account 000000000000/.test(error.message));
    assert.equal(simulator.store.regionState(region).cloudformation.stackNames["amx03-cross-account"], undefined);
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("AMX-03 reports new nested properties, helpers, transforms, dynamic references, and output expressions at their logical paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx03-drift-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true });
    const cloudformation = new CloudFormationClient(options);
    clients.push(s3, cloudformation);
    const bucket = "amx03-drift-templates";
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const run = async (name: string, child: unknown, expectedStatus: string | undefined, pattern: RegExp) => {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${name}.json`, Body: JSON.stringify(child) }));
      const parent = JSON.stringify({ Resources: { Child: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: `https://${bucket}.s3.${region}.amazonaws.com/${name}.json` } } } });
      if (!expectedStatus) {
        await assert.rejects(cloudformation.send(new CreateStackCommand({ StackName: `amx03-${name}`, TemplateBody: parent })), (error: any) => error.name === "ValidationError" && pattern.test(error.message));
        return;
      }
      const created = await cloudformation.send(new CreateStackCommand({ StackName: `amx03-${name}`, TemplateBody: parent }));
      const result = await status(cloudformation, created.StackId!, expectedStatus);
      assert.match(result.StackStatusReason ?? "", pattern);
      assert.deepEqual(simulator.store.regionState(region).cloudformation.stacks[created.StackId!].resources, {});
    };

    await run("property", { Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { UnexpectedProperty: true } } } }, "ROLLBACK_COMPLETE", /Child: Metadata\.Properties\.UnexpectedProperty.*owning future requirement/);
    await run("helper", { Resources: { NewHelper: { Type: "Custom::NewAmplifyHelper", Properties: { ServiceToken: "arn:aws:lambda:eu-west-1:000000000000:function:helper" } } } }, "ROLLBACK_COMPLETE", /Child\/NewHelper: Unrecognized custom-resource helper Custom::NewAmplifyHelper.*AMX-04/);
    await run("helper-token", { Resources: { GeneralHelper: { Type: "AWS::CloudFormation::CustomResource", Properties: { ServiceToken: "https://example.invalid/provider" } } } }, "ROLLBACK_COMPLETE", /Child: GeneralHelper: Properties\.ServiceToken.*AMX-04/);
    await run("transform", { Transform: "AWS::Serverless-2016-10-31", Resources: {} }, undefined, /UnsupportedTransform.*\$\.Transform|transforms are not supported.*\$\.Transform/i);
    await run("dynamic", { Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: "{{resolve:ssm:/secret}}" } } } }, undefined, /dynamic references are not supported.*Resources\.Metadata\.Properties\.Analytics/i);
    await run("output", { Resources: { Metadata: { Type: "AWS::CDK::Metadata" } }, Outputs: { Broken: { Value: { Ref: "Missing" } } } }, undefined, /missing resource or parameter "?Missing"?/i);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "child-output.json", Body: JSON.stringify({ Resources: { Metadata: { Type: "AWS::CDK::Metadata" } } }) }));
    const outputParent = JSON.stringify({ Resources: { Child: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: `https://${bucket}.s3.${region}.amazonaws.com/child-output.json` } } }, Outputs: { Broken: { Value: { "Fn::GetAtt": ["Child", "Outputs.Missing"] } } } });
    const outputCreated = await cloudformation.send(new CreateStackCommand({ StackName: "amx03-child-output", TemplateBody: outputParent }));
    const outputFailure = await status(cloudformation, outputCreated.StackId!, "ROLLBACK_COMPLETE");
    assert.match(outputFailure.StackStatusReason ?? "", /Child: \$\.Outputs\.Broken\.Value references missing authoritative child output Missing.*CFN-16/);
    assert.deepEqual(simulator.store.regionState(region).cloudformation.stacks[outputCreated.StackId!].resources, {});
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
