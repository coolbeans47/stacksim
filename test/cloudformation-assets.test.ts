import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APIGatewayClient, GetResourcesCommand, GetRestApisCommand } from "@aws-sdk/client-api-gateway";
import { CloudFormationClient, CreateChangeSetCommand, CreateStackCommand, DeleteChangeSetCommand, DeleteStackCommand, DescribeChangeSetCommand, DescribeStackEventsCommand, DescribeStackResourceCommand, DescribeStacksCommand, ExecuteChangeSetCommand, GetTemplateCommand, UpdateStackCommand, ValidateTemplateCommand, waitUntilStackCreateComplete, waitUntilStackUpdateComplete } from "@aws-sdk/client-cloudformation";
import { CreateBucketCommand, HeadObjectCommand, PutBucketVersioningCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { parseLocalS3ObjectUrl } from "../src/cloudformation/assets.js";
import { cdkBootstrapNames } from "../src/cloudformation/bootstrap.js";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const body = JSON.stringify({ Description: "template-url", Resources: { Metadata: { Type: "AWS::CDK::Metadata" } } });

async function waitForStatus(client: CloudFormationClient, stackName: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if ((await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus === expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const current = (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
  const events = await client.send(new DescribeStackEventsCommand({ StackName: stackName }));
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}; current=${current?.StackStatus} reason=${current?.StackStatusReason}; events=${JSON.stringify(events.StackEvents)}`);
}

async function waitForStatusWithClock(client: CloudFormationClient, stackName: string, expected: string, clock: TestClock): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    clock.advance(250);
    await new Promise(resolve => setTimeout(resolve, 5));
    if ((await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus === expected) return;
  }
  const current = (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
  const events = await client.send(new DescribeStackEventsCommand({ StackName: stackName }));
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}; current=${current?.StackStatus} reason=${current?.StackStatusReason}; events=${JSON.stringify(events.StackEvents)}`);
}

test("TemplateURL accepts local and AWS-shaped S3 URLs without fetching the network", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-assets-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); let s3: S3Client | undefined; let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`;
    s3 = new S3Client({ endpoint, region: "eu-west-1", credentials, forcePathStyle: true }); cloudformation = new CloudFormationClient({ endpoint, region: "eu-west-1", credentials });
    await s3.send(new CreateBucketCommand({ Bucket: "local-templates" })); await s3.send(new PutObjectCommand({ Bucket: "local-templates", Key: "nested/template.json", Body: body }));
    const local = `${endpoint}/local-templates/nested%2Ftemplate.json`; assert.equal((await cloudformation.send(new ValidateTemplateCommand({ TemplateURL: local }))).Description, "template-url");
    const awsShaped = "https://local-templates.s3.eu-west-1.amazonaws.com/nested/template.json"; const created = await cloudformation.send(new CreateStackCommand({ StackName: "url-stack", TemplateURL: awsShaped }));
    assert.equal((await waitUntilStackCreateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: created.StackId })).state, "SUCCESS");
  } finally { s3?.destroy(); cloudformation?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("ExecuteChangeSet retains the TemplateURL size allowance for an immutable UPDATE artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-change-set-template-url-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"});
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region: "eu-west-1", credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true }); const cloudformation = new CloudFormationClient(options); clients.push(s3, cloudformation);
    const initialTemplate = JSON.stringify({
      Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: "v1" } } },
      Outputs: { Release: { Value: "v1" } },
    });
    const oversizedTemplate = JSON.stringify({
      Metadata: { Padding: "x".repeat(60_000) },
      Resources: { Metadata: { Type: "AWS::CDK::Metadata", Properties: { Analytics: "v2" } } },
      Outputs: { Release: { Value: "v2" } },
    });
    assert.ok(Buffer.byteLength(oversizedTemplate) > 51_200);
    assert.ok(Buffer.byteLength(oversizedTemplate) < 1_048_576);

    const created = await cloudformation.send(new CreateStackCommand({ StackName: "large-url-change-set", TemplateBody: initialTemplate }));
    assert.equal((await waitUntilStackCreateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: created.StackId })).state, "SUCCESS");
    await assert.rejects(
      cloudformation.send(new UpdateStackCommand({ StackName: created.StackId, TemplateBody: oversizedTemplate })),
      (error: any) => error.name === "ValidationError" && /1-51200 bytes/.test(error.message),
    );

    await s3.send(new CreateBucketCommand({ Bucket: "oversized-change-set-templates" }));
    await s3.send(new PutObjectCommand({ Bucket: "oversized-change-set-templates", Key: "templates/update.json", Body: oversizedTemplate }));
    const planned = await cloudformation.send(new CreateChangeSetCommand({
      StackName: created.StackId,
      ChangeSetName: "large-template-url-update",
      ChangeSetType: "UPDATE",
      TemplateURL: "https://oversized-change-set-templates.s3.eu-west-1.amazonaws.com/templates/update.json",
    }));
    const available = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: planned.Id }));
    assert.equal(available.Status, "CREATE_COMPLETE");
    assert.equal(available.ExecutionStatus, "AVAILABLE");
    const processed = String((await cloudformation.send(new GetTemplateCommand({ ChangeSetName: planned.Id, TemplateStage: "Processed" }))).TemplateBody);
    assert.ok(Buffer.byteLength(processed) > 51_200, "the immutable processed artifact must cross the inline TemplateBody limit");

    await cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: planned.Id }));
    assert.equal((await waitUntilStackUpdateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { StackName: created.StackId })).state, "SUCCESS");
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0]?.Outputs?.[0]?.OutputValue, "v2");
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("TemplateURL parser rejects external, credentialed, cross-region, and malformed addresses", () => {
  for (const value of [
    "https://example.com/templates/app.json",
    "http://bucket.s3.eu-west-1.amazonaws.com/app.json",
    "https://user:secret@bucket.s3.eu-west-1.amazonaws.com/app.json",
    "https://bucket.s3.us-east-1.amazonaws.com/app.json",
    "file:///tmp/app.json",
    "http://169.254.169.254/latest/meta-data",
    "http://127.0.0.1:4566/bucket/bad%ZZkey",
    "http://127.0.0.1:4566/bucket/app.json?redirect=https://example.com",
  ]) assert.throws(() => parseLocalS3ObjectUrl(value, "eu-west-1"), /TemplateURL/);
  assert.deepEqual(parseLocalS3ObjectUrl("http://local-templates.localhost:4566/folder%2Fapp.json?versionId=abc", "eu-west-1"), { bucket: "local-templates", key: "folder/app.json", versionId: "abc", region: undefined, style: "virtual", endpoint: "loopback" });
});

test("CloudFormation pins API definition assets to an immutable S3 version in the processed template", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-versioned-assets-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"});
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region: "eu-west-1", credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true }); const cloudformation = new CloudFormationClient(options); const apigateway = new APIGatewayClient(options); clients.push(s3, cloudformation, apigateway);
    await s3.send(new CreateBucketCommand({ Bucket: "versioned-api-assets" }));
    await s3.send(new PutBucketVersioningCommand({ Bucket: "versioned-api-assets", VersioningConfiguration: { Status: "Enabled" } }));
    const first = await s3.send(new PutObjectCommand({ Bucket: "versioned-api-assets", Key: "api.json", Body: JSON.stringify({ openapi: "3.0.1", info: { title: "Pinned API", version: "1" }, paths: { "/first": { get: { responses: { "200": { description: "ok" } } } } } }) }));
    assert.ok(first.VersionId);
    const template = JSON.stringify({ Resources: { Api: { Type: "AWS::ApiGateway::RestApi", Properties: { BodyS3Location: { Bucket: "versioned-api-assets", Key: "api.json" }, Mode: "overwrite" } } } });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "versioned-api-stack", TemplateBody: template }));
    await s3.send(new PutObjectCommand({ Bucket: "versioned-api-assets", Key: "api.json", Body: JSON.stringify({ openapi: "3.0.1", info: { title: "Changed API", version: "2" }, paths: { "/second": { get: { responses: { "200": { description: "ok" } } } } } }) }));
    await waitForStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    const processed = JSON.parse(String((await cloudformation.send(new GetTemplateCommand({ StackName: created.StackId, TemplateStage: "Processed" }))).TemplateBody));
    assert.equal(processed.Resources.Api.Properties.BodyS3Location.Version, first.VersionId);
    const resource = await cloudformation.send(new DescribeStackResourceCommand({ StackName: created.StackId!, LogicalResourceId: "Api" }));
    const paths = (await apigateway.send(new GetResourcesCommand({ restApiId: resource.StackResourceDetail!.PhysicalResourceId! }))).items?.map(item => item.path).sort();
    assert.ok(paths?.includes("/first"));
    assert.equal(paths?.includes("/second"), false);
    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId })); await waitForStatus(cloudformation, created.StackId!, "DELETE_COMPLETE");
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("ExecuteChangeSet deploys the reviewed asset version after the current S3 object changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-change-set-assets-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"});
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region: "eu-west-1", credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true }); const cloudformation = new CloudFormationClient(options); const apigateway = new APIGatewayClient(options); clients.push(s3, cloudformation, apigateway);
    await s3.send(new CreateBucketCommand({ Bucket: "change-set-api-assets" }));
    await s3.send(new PutBucketVersioningCommand({ Bucket: "change-set-api-assets", VersioningConfiguration: { Status: "Enabled" } }));
    const reviewed = await s3.send(new PutObjectCommand({ Bucket: "change-set-api-assets", Key: "api.json", Body: JSON.stringify({ openapi: "3.0.1", info: { title: "Reviewed", version: "1" }, paths: { "/reviewed": { get: { responses: { "200": { description: "ok" } } } } } }) }));
    const template = JSON.stringify({ Resources: { Api: { Type: "AWS::ApiGateway::RestApi", Properties: { BodyS3Location: { Bucket: "change-set-api-assets", Key: "api.json" }, Mode: "overwrite" } } } });
    const planned = await cloudformation.send(new CreateChangeSetCommand({ StackName: "asset-change-set", ChangeSetName: "initial", ChangeSetType: "CREATE", TemplateBody: template }));
    const available = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: planned.Id }));
    assert.equal(available.ExecutionStatus, "AVAILABLE");
    const processed = JSON.parse(String((await cloudformation.send(new GetTemplateCommand({ ChangeSetName: planned.Id, TemplateStage: "Processed" }))).TemplateBody));
    assert.equal(processed.Resources.Api.Properties.BodyS3Location.Version, reviewed.VersionId);

    await s3.send(new PutObjectCommand({ Bucket: "change-set-api-assets", Key: "api.json", Body: JSON.stringify({ openapi: "3.0.1", info: { title: "Later", version: "2" }, paths: { "/later": { get: { responses: { "200": { description: "ok" } } } } } }) }));
    await cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: planned.Id }));
    assert.equal((await waitUntilStackCreateComplete({ client: cloudformation, minDelay: 1, maxDelay: 1, maxWaitTime: 30 }, { StackName: planned.StackId })).state, "SUCCESS");
    const resource = await cloudformation.send(new DescribeStackResourceCommand({ StackName: planned.StackId, LogicalResourceId: "Api" }));
    const paths = (await apigateway.send(new GetResourcesCommand({ restApiId: resource.StackResourceDetail!.PhysicalResourceId! }))).items?.map(item => item.path).sort();
    assert.ok(paths?.includes("/reviewed"));
    assert.equal(paths?.includes("/later"), false);
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("review-only change sets can plan an unpublished asset but execution remains strict", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-review-assets-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"});
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region: "eu-west-1", credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true }); const cloudformation = new CloudFormationClient(options); const apigateway = new APIGatewayClient(options); clients.push(s3, cloudformation, apigateway);
    await s3.send(new CreateBucketCommand({ Bucket: "review-only-api-assets" }));
    const template = JSON.stringify({ Resources: { Api: { Type: "AWS::ApiGateway::RestApi", Properties: { BodyS3Location: { Bucket: "review-only-api-assets", Key: "not-published.json" }, Mode: "overwrite" } } } });
    const planned = await cloudformation.send(new CreateChangeSetCommand({ StackName: "review-only-assets", ChangeSetName: "review", ChangeSetType: "CREATE", TemplateBody: template }));
    const available = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: planned.Id }));
    assert.equal(available.Status, "CREATE_COMPLETE"); assert.equal(available.ExecutionStatus, "AVAILABLE");
    const processed = JSON.parse(String((await cloudformation.send(new GetTemplateCommand({ ChangeSetName: planned.Id, TemplateStage: "Processed" }))).TemplateBody));
    assert.equal(processed.Resources.Api.Properties.BodyS3Location.Version, undefined, "an unpublished review asset cannot be assigned a fabricated version");
    await assert.rejects(cloudformation.send(new ExecuteChangeSetCommand({ ChangeSetName: planned.Id })), /specified key does not exist|cannot read local S3 asset/i);
    assert.equal((await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: planned.Id }))).ExecutionStatus, "EXECUTE_FAILED");
    assert.equal((await apigateway.send(new GetRestApisCommand({}))).items?.length ?? 0, 0, "failed execution must not mutate the provider service");
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("re-publishing identical content to a versioned CDK key remains a change-set no-op", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-identical-assets-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"});
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region: "eu-west-1", credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true }); const cloudformation = new CloudFormationClient(options); clients.push(s3, cloudformation);
    await s3.send(new CreateBucketCommand({ Bucket: "identical-api-assets" })); await s3.send(new PutBucketVersioningCommand({ Bucket: "identical-api-assets", VersioningConfiguration: { Status: "Enabled" } }));
    const definition = JSON.stringify({ openapi: "3.0.1", info: { title: "Identical", version: "1" }, paths: {} });
    const first = await s3.send(new PutObjectCommand({ Bucket: "identical-api-assets", Key: "content-addressed.json", Body: definition }));
    const template = JSON.stringify({ Resources: { Api: { Type: "AWS::ApiGateway::RestApi", Properties: { BodyS3Location: { Bucket: "identical-api-assets", Key: "content-addressed.json" }, Mode: "overwrite" } } } });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "identical-asset-stack", TemplateBody: template })); await waitForStatus(cloudformation, created.StackId!, "CREATE_COMPLETE");
    const second = await s3.send(new PutObjectCommand({ Bucket: "identical-api-assets", Key: "content-addressed.json", Body: definition })); assert.notEqual(second.VersionId, first.VersionId);
    const planned = await cloudformation.send(new CreateChangeSetCommand({ StackName: created.StackId, ChangeSetName: "same-content", ChangeSetType: "UPDATE", TemplateBody: template }));
    const noOp = await cloudformation.send(new DescribeChangeSetCommand({ ChangeSetName: planned.Id })); assert.equal(noOp.Status, "FAILED"); assert.equal(noOp.ExecutionStatus, "UNAVAILABLE"); assert.match(noOp.StatusReason ?? "", /didn't contain changes/i);
    const processed = JSON.parse(String((await cloudformation.send(new GetTemplateCommand({ ChangeSetName: planned.Id, TemplateStage: "Processed" }))).TemplateBody));
    assert.equal(processed.Resources.Api.Properties.BodyS3Location.Version, first.VersionId, "the deployed immutable version should be reused for identical bytes");
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("CloudFormation rejects an overwritten unversioned asset before its provider mutates", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-unversioned-assets-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"});
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region: "eu-west-1", credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true }); const cloudformation = new CloudFormationClient(options); const apigateway = new APIGatewayClient(options); clients.push(s3, cloudformation, apigateway);
    await s3.send(new CreateBucketCommand({ Bucket: "mutable-api-assets" }));
    const firstBody = JSON.stringify({ openapi: "3.0.1", info: { title: "Accepted API", version: "1" }, paths: { "/accepted": { get: { responses: { "200": { description: "ok" } } } } } });
    await s3.send(new PutObjectCommand({ Bucket: "mutable-api-assets", Key: "api.json", Body: firstBody }));
    const template = JSON.stringify({ Resources: {
      DelayTable: { Type: "AWS::DynamoDB::Table", Properties: { BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] } },
      Api: { Type: "AWS::ApiGateway::RestApi", DependsOn: "DelayTable", Properties: { BodyS3Location: { Bucket: "mutable-api-assets", Key: "api.json" }, Mode: "overwrite" } },
    } });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "mutable-api-stack", TemplateBody: template }));
    await s3.send(new PutObjectCommand({ Bucket: "mutable-api-assets", Key: "api.json", Body: JSON.stringify({ openapi: "3.0.1", info: { title: "Overwritten API", version: "2" }, paths: {} }) }));
    await waitForStatus(cloudformation, created.StackId!, "ROLLBACK_COMPLETE");
    const events = await cloudformation.send(new DescribeStackEventsCommand({ StackName: created.StackId }));
    assert.ok(events.StackEvents?.some(event => /changed after the stack operation accepted|durable operation checkpoint/i.test(event.ResourceStatusReason ?? "")), JSON.stringify(events.StackEvents));
    assert.equal((await apigateway.send(new GetRestApisCommand({}))).items?.length ?? 0, 0);
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("bootstrap asset reclamation keeps available change-set assets and removes only expired unreachable versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-asset-reclamation-")); const priorRetention = process.env.STACKSIM_CDK_ASSET_RETENTION_MS; process.env.STACKSIM_CDK_ASSET_RETENTION_MS = "0"; const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, cdkBootstrap: true, authMode: "off"});
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region: "eu-west-1", credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true }); const cloudformation = new CloudFormationClient(options); clients.push(s3, cloudformation);
    const bucket = cdkBootstrapNames("000000000000", "eu-west-1").bucketName;
    const retained = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "assets/referenced.json", Body: JSON.stringify({ openapi: "3.0.1", info: { title: "Referenced", version: "1" }, paths: {} }) }));
    const orphan = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "assets/orphan.zip", Body: Buffer.from("orphan") }));
    assert.ok(retained.VersionId); assert.ok(orphan.VersionId);
    const template = JSON.stringify({ Resources: { Api: { Type: "AWS::ApiGateway::RestApi", Properties: { BodyS3Location: { Bucket: bucket, Key: "assets/referenced.json" }, Mode: "overwrite" } } } });
    await cloudformation.send(new CreateChangeSetCommand({ StackName: "asset-reachability", ChangeSetName: "available-assets", ChangeSetType: "CREATE", TemplateBody: template }));
    for (let attempt = 0; attempt < 100; attempt += 1) { const status = (await cloudformation.send(new DescribeChangeSetCommand({ StackName: "asset-reachability", ChangeSetName: "available-assets" }))).Status; if (status === "CREATE_COMPLETE") break; if (status === "FAILED") throw new Error("asset reachability change set failed"); await new Promise(resolve => setTimeout(resolve, 10)); }

    await (simulator.cloudformation as any).reclaimUnreferencedBootstrapAssets();
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "assets/referenced.json", VersionId: retained.VersionId }));
    await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "assets/orphan.zip", VersionId: orphan.VersionId })), (error: any) => error.name === "NoSuchKey" || error.name === "NotFound");

    await cloudformation.send(new DeleteChangeSetCommand({ StackName: "asset-reachability", ChangeSetName: "available-assets" }));
    await (simulator.cloudformation as any).reclaimUnreferencedBootstrapAssets();
    await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "assets/referenced.json", VersionId: retained.VersionId })), (error: any) => error.name === "NoSuchKey" || error.name === "NotFound");
  } finally {
    if (priorRetention === undefined) delete process.env.STACKSIM_CDK_ASSET_RETENTION_MS; else process.env.STACKSIM_CDK_ASSET_RETENTION_MS = priorRetention;
    clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("asset reclamation follows successful updates and preserves versions shared by another stack", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-asset-shared-reachability-")); const priorRetention = process.env.STACKSIM_CDK_ASSET_RETENTION_MS; process.env.STACKSIM_CDK_ASSET_RETENTION_MS = "1000"; const clock = new TestClock(10_000); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, cdkBootstrap: true, clock, authMode: "off"});
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region: "eu-west-1", credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true }); const cloudformation = new CloudFormationClient(options); clients.push(s3, cloudformation);
    const bucket = cdkBootstrapNames("000000000000", "eu-west-1").bucketName;
    const first = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "assets/shared-api.json", Body: JSON.stringify({ openapi: "3.0.1", info: { title: "First", version: "1" }, paths: {} }) }));
    clock.advance(1);
    const second = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "assets/shared-api.json", Body: JSON.stringify({ openapi: "3.0.1", info: { title: "Second", version: "2" }, paths: {} }) }));
    assert.ok(first.VersionId); assert.ok(second.VersionId);
    const template = (version: string) => JSON.stringify({ Resources: { Api: { Type: "AWS::ApiGateway::RestApi", Properties: { BodyS3Location: { Bucket: bucket, Key: "assets/shared-api.json", Version: version }, Mode: "overwrite" } } } });
    for (const stackName of ["shared-assets-a", "shared-assets-b"]) {
      await cloudformation.send(new CreateStackCommand({ StackName: stackName, TemplateBody: template(first.VersionId!) }));
      await waitForStatusWithClock(cloudformation, stackName, "CREATE_COMPLETE", clock);
    }
    await cloudformation.send(new UpdateStackCommand({ StackName: "shared-assets-a", TemplateBody: template(second.VersionId!) }));
    await waitForStatusWithClock(cloudformation, "shared-assets-a", "UPDATE_COMPLETE", clock);
    clock.advance(2_000); await (simulator.cloudformation as any).reclaimUnreferencedBootstrapAssets();
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "assets/shared-api.json", VersionId: first.VersionId }));

    await cloudformation.send(new UpdateStackCommand({ StackName: "shared-assets-b", TemplateBody: template(second.VersionId!) }));
    await waitForStatusWithClock(cloudformation, "shared-assets-b", "UPDATE_COMPLETE", clock);
    await (simulator.cloudformation as any).reclaimUnreferencedBootstrapAssets();
    await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "assets/shared-api.json", VersionId: first.VersionId })), (error: any) => error.name === "NoSuchKey" || error.name === "NotFound");
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "assets/shared-api.json", VersionId: second.VersionId }));
  } finally {
    if (priorRetention === undefined) delete process.env.STACKSIM_CDK_ASSET_RETENTION_MS; else process.env.STACKSIM_CDK_ASSET_RETENTION_MS = priorRetention;
    clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("asset reclamation keeps the restored version and removes a rolled-back update asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-asset-rollback-reachability-")); const priorRetention = process.env.STACKSIM_CDK_ASSET_RETENTION_MS; process.env.STACKSIM_CDK_ASSET_RETENTION_MS = "1000"; const clock = new TestClock(20_000); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, cdkBootstrap: true, clock, authMode: "off"});
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region: "eu-west-1", credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...options, forcePathStyle: true }); const cloudformation = new CloudFormationClient(options); clients.push(s3, cloudformation);
    const bucket = cdkBootstrapNames("000000000000", "eu-west-1").bucketName;
    const first = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "assets/rollback-api.json", Body: JSON.stringify({ openapi: "3.0.1", info: { title: "Stable", version: "1" }, paths: {} }) }));
    clock.advance(1);
    const attempted = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "assets/rollback-api.json", Body: JSON.stringify({ openapi: "3.0.1", info: { title: "Attempted", version: "2" }, paths: {} }) }));
    assert.ok(first.VersionId); assert.ok(attempted.VersionId);
    const template = (version: string, fail = false) => JSON.stringify({ Resources: { Api: { Type: "AWS::ApiGateway::RestApi", Properties: { BodyS3Location: { Bucket: bucket, Key: "assets/rollback-api.json", Version: version }, Mode: "overwrite" } } }, ...(fail ? { Outputs: { Invalid: { Value: ["not", "scalar"] } } } : {}) });
    await cloudformation.send(new CreateStackCommand({ StackName: "rollback-assets", TemplateBody: template(first.VersionId!) }));
    await waitForStatusWithClock(cloudformation, "rollback-assets", "CREATE_COMPLETE", clock);
    await cloudformation.send(new UpdateStackCommand({ StackName: "rollback-assets", TemplateBody: template(attempted.VersionId!, true) }));
    await waitForStatusWithClock(cloudformation, "rollback-assets", "UPDATE_ROLLBACK_COMPLETE", clock);

    clock.advance(2_000); await (simulator.cloudformation as any).reclaimUnreferencedBootstrapAssets();
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "assets/rollback-api.json", VersionId: first.VersionId }));
    await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "assets/rollback-api.json", VersionId: attempted.VersionId })), (error: any) => error.name === "NoSuchKey" || error.name === "NotFound");
  } finally {
    if (priorRetention === undefined) delete process.env.STACKSIM_CDK_ASSET_RETENTION_MS; else process.env.STACKSIM_CDK_ASSET_RETENTION_MS = priorRetention;
    clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});
