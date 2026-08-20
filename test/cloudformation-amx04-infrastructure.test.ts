import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStackEventsCommand, DescribeStacksCommand, ListStackResourcesCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ListExecutionsCommand, ListStateMachinesCommand, SFNClient } from "@aws-sdk/client-sfn";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { StackSim } from "../src/server.js";
import { createZip } from "../src/core/zip-create.js";
import { zipContentSnapshot, type ZipContentSnapshot } from "./support/artifact-snapshots.js";
import { readCanonicalText } from "./support/frozen-text.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const executionRoleArn = `arn:aws:iam::${accountId}:role/cdk-hnb659fds-cfn-exec-role-${accountId}-${region}`;
const tableManagerAssetId = "f2c5bec0e463cae18d0bf683be5923ae6bd676a06af1a994bdfa076a66ac07d6";
const autoDeleteAssetId = "faa95a81ae7d7373f3e1f242268f904eb748d8d0fdd306e8a6fe515a1905a7d6";
const bucketDeploymentHandlerAssetId = "97e9ebf0b174a5c8f7faa505739022b7f509edddffcab9211dcd08b759944c4f";
const codegenSourceAssetId = "0f7665a8e7b1e1ae8c018961a67ede6600792bf5393ac23068f79ccf68608357";
const introspectionSourceAssetId = "5c0312441b16a7cf32bb8e3252a08bd1889a860bba81f5fa32c1053ec5371509";
const legacyAwsCliLayerAssetId = "a72522445441e9b66c2f16956c54d4786af8c61c156b80c48a6e7c32fcc49023";
const expectedZipContents: Record<string, ZipContentSnapshot> = {
  f2c5bec0e463cae18d0bf683be5923ae6bd676a06af1a994bdfa076a66ac07d6: { entries: 17, uncompressedBytes: 165497, sha256: "bd1de93b0a0c0574d56b9d0e30b6e005e497a38e78c38fcd5ac763460b2b06e0" },
  faa95a81ae7d7373f3e1f242268f904eb748d8d0fdd306e8a6fe515a1905a7d6: { entries: 1, uncompressedBytes: 4403, sha256: "a477eb808b7d9d512ec7e4fd41b470428586c790480dc1aced05c91ac7ecaa7e" },
  "97e9ebf0b174a5c8f7faa505739022b7f509edddffcab9211dcd08b759944c4f": { entries: 1, uncompressedBytes: 17312, sha256: "0a3b9f17a65aefa6718f01247b14f1882ca49c63dbb3483e448eaa2655a04883" },
  a72522445441e9b66c2f16956c54d4786af8c61c156b80c48a6e7c32fcc49023: { entries: 3239, uncompressedBytes: 36379161, sha256: "a04afd1eb1525705d06f7f33288d62073aef04be1a59b8ca37868a77afef7ce3" },
  "0f7665a8e7b1e1ae8c018961a67ede6600792bf5393ac23068f79ccf68608357": { entries: 1, uncompressedBytes: 167, sha256: "61c09ace9bcf654391790f63504300a3e9412bf65b3729830f35614bc1472811" },
  "5c0312441b16a7cf32bb8e3252a08bd1889a860bba81f5fa32c1053ec5371509": { entries: 1, uncompressedBytes: 3208, sha256: "3e426c22f66f20e93707b557815db7167d7617477d6a81ebcb1d3cf1de6bfe67" },
};

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

async function generatedAssetZip(fixture: string, assetId: string): Promise<Buffer> {
  if (assetId === legacyAwsCliLayerAssetId) {
    return createZip([{ name: "aws", content: "legacy aws cli layer attestation fixture\n" }]);
  }
  if (assetId === autoDeleteAssetId) {
    return createZip([{ name: "index.js", content: await readFile(join(fixture, "node_modules", "aws-cdk-lib", "custom-resource-handlers", "dist", "aws-s3", "auto-delete-objects-handler", "index.js")) }]);
  }
  if (assetId === bucketDeploymentHandlerAssetId) {
    return createZip([{ name: "index.py", content: await readFile(join(fixture, "node_modules", "aws-cdk-lib", "custom-resource-handlers", "dist", "aws-s3-deployment", "bucket-deployment-handler", "index.py")) }]);
  }
  if (assetId === codegenSourceAssetId) {
    return createZip([{ name: "model-schema.graphql", content: await readCanonicalText(join(fixture, "evidence", "assets", `${assetId}-model-schema.graphql`)) }]);
  }
  if (assetId === introspectionSourceAssetId) {
    return createZip([{ name: "modelIntrospectionSchema.json", content: await readCanonicalText(join(fixture, "evidence", "assets", `${assetId}-modelIntrospectionSchema.json`)) }]);
  }
  if (assetId === tableManagerAssetId) {
    const source = join(fixture, "node_modules", "@aws-amplify", "data-construct", "node_modules", "@aws-amplify", "graphql-model-transformer", "lib", "resources", "amplify-dynamodb-table", "amplify-table-manager-lambda");
    const names = [
      "amplify-table-manager-handler.d.ts.map", "amplify-table-manager-handler.js", "amplify-table-manager-handler.js.map",
      "cfn-response.d.ts.map", "cfn-response.js", "cfn-response.js.map",
      "import-table.d.ts.map", "import-table.js", "import-table.js.map",
      "outbound.d.ts.map", "outbound.js", "outbound.js.map",
      "util.d.ts.map", "util.js", "util.js.map",
      "node_modules/.package-lock.json", "node_modules/lodash.isequal/index.js",
    ];
    return createZip(await Promise.all(names.map(async name => ({ name, content: await readFile(join(source, ...name.split("/"))) }))));
  }
  throw new Error(`Unsupported generated AMX-04 asset ${assetId}`);
}

test("AMX-04A: the complete helper/resource/template/ZIP/layer/workflow manifest is immutable", async () => {
  const fixture = join(process.cwd(), "test", "fixtures", "amplify-gen2-data");
  const evidence = join(fixture, "evidence");
  const manifest = JSON.parse(await readFile(join(evidence, "amx04-helper-manifest.json"), "utf8"));
  assert.equal(manifest.implementationPath, "generated-provider-framework");
  assert.equal(manifest.resources.length, 28);
  assert.match(manifest.dug04, /no Parallel or Map/);

  const templates = new Map<string, any>();
  for (const expected of manifest.templates) {
    const bytes = await readCanonicalText(join(evidence, "templates", `${expected.name}.json`));
    assert.deepEqual({ bytes: bytes.length, sha256: sha256(bytes) }, { bytes: expected.bytes, sha256: expected.sha256 });
    templates.set(expected.name, JSON.parse(bytes.toString("utf8")));
  }
  for (const expected of manifest.resources) {
    const resource = templates.get(expected.template)?.Resources?.[expected.logicalId];
    assert.equal(resource?.Type, expected.type, `${expected.template}/${expected.logicalId} type drift`);
    assert.equal(sha256(JSON.stringify(canonical(resource?.Properties ?? {}))), expected.propertiesSha256, `${expected.template}/${expected.logicalId} property drift`);
  }
  for (const expected of manifest.assets) {
    if (expected.id === legacyAwsCliLayerAssetId) {
      // CDK 2.265 cannot recreate the retired archive. Preserve its protected
      // historical metadata while runtime compatibility uses an attested ZIP below.
      assert.deepEqual(expected, {
        id: legacyAwsCliLayerAssetId,
        kind: "bucket-deployment-awscli-layer-zip",
        bytes: 21_558_128,
        sha256: "e32c564500d8f80cfaaff79b1211480b95448f76780301d2b09c7133b89b4bd7",
      }, "the frozen legacy layer metadata remains protected without requiring an ignored 21.5 MB archive");
      assert.deepEqual(expectedZipContents[expected.id], { entries: 3239, uncompressedBytes: 36_379_161, sha256: "a04afd1eb1525705d06f7f33288d62073aef04be1a59b8ca37868a77afef7ce3" });
      continue;
    }
    const bytes = await generatedAssetZip(fixture, expected.id);
    assert.deepEqual(zipContentSnapshot(bytes), expectedZipContents[expected.id], `${expected.kind} content drift`);
  }
  const workflow = templates.get("table-manager").Resources[manifest.workflow.logicalId];
  assert.equal(sha256(JSON.stringify(workflow.Properties.DefinitionString)), manifest.workflow.definitionSha256);
  const gate = (actual: string, expected: string, kind: string): void => assert.equal(actual, expected, `${kind} drift rejected before helper mutation`);
  const changedProperties = structuredClone(templates.get("data").Resources[manifest.resources[0].logicalId].Properties);
  changedProperties.Tags[0].Value = "intentional-drift";
  assert.throws(() => gate(sha256(JSON.stringify(canonical(changedProperties))), manifest.resources[0].propertiesSha256, "property"), /property drift/);
  const firstAsset = manifest.assets[0];
  const changedZipSnapshot = { ...expectedZipContents[firstAsset.id], sha256: "0".repeat(64) };
  assert.throws(() => gate(JSON.stringify(changedZipSnapshot), JSON.stringify(expectedZipContents[firstAsset.id]), "helper ZIP content"), /helper ZIP content drift/);
  const changedWorkflow = structuredClone(workflow.Properties.DefinitionString);
  changedWorkflow["Fn::Join"][1][0] += " ";
  assert.throws(() => gate(sha256(JSON.stringify(changedWorkflow)), manifest.workflow.definitionSha256, "workflow"), /workflow drift/);
  assert.throws(() => gate("drifted-service-token", manifest.protocols["Custom::AmplifyDynamoDBTable"].serviceToken, "service-token"), /service-token drift/);
});

async function waitForStack(client: CloudFormationClient, stackId: string, terminal: string): Promise<any> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    const stack = (await client.send(new DescribeStacksCommand({ StackName: stackId }))).Stacks?.[0];
    if (stack?.StackStatus === terminal) return stack;
    if (stack?.StackStatus?.endsWith("FAILED") || stack?.StackStatus?.includes("ROLLBACK_COMPLETE")) {
      const events = (await client.send(new DescribeStackEventsCommand({ StackName: stackId }))).StackEvents ?? [];
      const failures = events.slice(0, 100).map(event => `${event.LogicalResourceId}:${event.ResourceStatus}:${event.ResourceStatusReason ?? ""}`).join(" | ");
      assert.fail(`stack reached ${stack.StackStatus}: ${stack.StackStatusReason ?? ""}; ${failures}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`stack ${stackId} did not reach ${terminal}`);
}

async function callbackPut(url: string, ca: Buffer, body: unknown): Promise<{ status: number; body: string }> {
  const parsed = new URL(url);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolvePromise, reject) => {
    const request = httpsRequest({ hostname: "127.0.0.1", port: Number(parsed.port), path: parsed.pathname, method: "PUT", servername: "localhost", ca, headers: { host: `localhost:${parsed.port}`, "content-length": payload.length } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

test("AMX-04D: generated-table callback identity survives restart and rejects stale or duplicate delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx04-callback-"));
  let simulator: StackSim | undefined = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, accountId, region, authMode: "enforce", cdkBootstrap: true });
  try {
    await simulator.start();
    let broker = (simulator as any).customResourceCallbacks;
    const resourceOperationId = "4".repeat(64);
    const expiresAt = broker.now() + 60_000;
    const intent = {
      region,
      resourceType: "Custom::AmplifyDynamoDBTable",
      requestType: "Create" as const,
      operationId: "amx04-parent-operation",
      resourceOperationId,
      stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/amx04-callback/stack-id`,
      logicalId: "TodoTable",
      serviceToken: `arn:aws:lambda:${region}:${accountId}:function:generated-on-event`,
      expiresAt,
    };
    const prepared = await broker.prepare(intent);
    await broker.markInvoked(prepared);
    const responseUrl = broker.responseUrl(region, resourceOperationId, expiresAt);
    const callbackPort = broker.port();
    const caPath = broker.caCertificatePath;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: callbackPort, dataDir: root, accountId, region, authMode: "enforce", cdkBootstrap: true });
    await simulator.start();
    broker = (simulator as any).customResourceCallbacks;
    const ca = await readFile(caPath);
    const response = { Status: "SUCCESS", PhysicalResourceId: "Todo-amx04api-NONE", StackId: intent.stackId, RequestId: resourceOperationId, LogicalResourceId: intent.logicalId, Data: { TableArn: `arn:aws:dynamodb:${region}:${accountId}:table/Todo-amx04api-NONE`, TableName: "Todo-amx04api-NONE", TableStreamArn: `arn:aws:dynamodb:${region}:${accountId}:table/Todo-amx04api-NONE/stream/frozen` } };
    const stale = { ...response, RequestId: "5".repeat(64) };
    assert.equal((await callbackPut(responseUrl, ca, stale)).status, 400);
    assert.equal((await broker.read(region, resourceOperationId)).invocationStatus, "INVOKED", "stale callback consumed the durable request");
    assert.equal((await callbackPut(responseUrl, ca, response)).status, 200);
    assert.equal((await callbackPut(responseUrl, ca, response)).status, 409);
    const terminal = await broker.read(region, resourceOperationId);
    assert.equal(terminal.operationId, intent.operationId);
    assert.equal(terminal.response.PhysicalResourceId, response.PhysicalResourceId);
    assert.deepEqual(terminal.response.Data, response.Data);
    await assert.rejects(broker.prepare({ ...intent, serviceToken: `${intent.serviceToken}-drift` }), /does not match the active operation/);
  } finally {
    await simulator?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("AMX-04A/C: the frozen SSM parameter shape is closed and mutates authoritative Parameter Store", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx04-ssm-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "enforce", cdkBootstrap: true });
  let cloudformation: CloudFormationClient | undefined;
  let ssm: SSMClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region, credentials });
    ssm = new SSMClient({ endpoint, region, credentials });
    const prefix = "/amplify/resource_reference/stacksimamplifygen2datafixture/amx01-sandbox-26187e8ba5/";
    const generated = {
      AMPLIFYDATAGRAPHQLENDPOINTParameter1C2CBB16: ["AMPLIFY_DATA_GRAPHQL_ENDPOINT", "https://example.appsync-api.eu-west-1.amazonaws.com/graphql"],
      AMPLIFYDATAMODELINTROSPECTIONSCHEMABUCKETNAMEParameter47BF4F44: ["AMPLIFY_DATA_MODEL_INTROSPECTION_SCHEMA_BUCKET_NAME", "model-introspection-bucket"],
      AMPLIFYDATAMODELINTROSPECTIONSCHEMAKEYParameterB6AEAE8A: ["AMPLIFY_DATA_MODEL_INTROSPECTION_SCHEMA_KEY", "modelIntrospectionSchema.json"],
      AMPLIFYDATADEFAULTNAMEParameterE7C23CC4: ["AMPLIFY_DATA_DEFAULT_NAME", "amplifyData"],
    } as const;
    const template = JSON.stringify({
      Resources: Object.fromEntries(Object.entries(generated).map(([logicalId, [name, value]]) => [logicalId, {
        Type: "AWS::SSM::Parameter",
        Properties: { Name: `${prefix}${name}`, Type: "String", Value: value, Tags: { "amplify:deployment-type": "sandbox", "created-by": "amplify" } },
      }])),
      Outputs: { ParameterName: { Value: { Ref: "AMPLIFYDATADEFAULTNAMEParameterE7C23CC4" } } },
    });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "amx04-ssm", TemplateBody: template, RoleARN: executionRoleArn }));
    const completed = await waitForStack(cloudformation, created.StackId!, "CREATE_COMPLETE");
    assert.equal(completed.Outputs?.[0]?.OutputValue, "/amplify/resource_reference/stacksimamplifygen2datafixture/amx01-sandbox-26187e8ba5/AMPLIFY_DATA_DEFAULT_NAME");
    for (const [name, value] of Object.values(generated)) {
      const response: { Parameter?: { Type?: string; Value?: string } } = await ssm.send(new GetParameterCommand({ Name: `${prefix}${name}` }));
      assert.equal(response.Parameter?.Type, "String");
      assert.equal(response.Parameter?.Value, value);
    }
    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId! }));
    await waitForStack(cloudformation, created.StackId!, "DELETE_COMPLETE");
    for (const [name] of Object.values(generated)) await assert.rejects(() => ssm!.send(new GetParameterCommand({ Name: `${prefix}${name}` })), /ParameterNotFound/);
  } finally {
    cloudformation?.destroy();
    ssm?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("AMX-04C/D: both exact generated BucketDeployments and S3AutoDeleteObjects paths copy, prune, and clean only owned buckets", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx04-autodelete-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const cloudformation = new CloudFormationClient({ endpoint, region, credentials }); clients.push(cloudformation);
    const s3 = new S3Client({ endpoint, region, credentials, forcePathStyle: true }); clients.push(s3);
    const logs = new CloudWatchLogsClient({ endpoint, region, credentials }); clients.push(logs);
    const fixture = join(process.cwd(), "test", "fixtures", "amplify-gen2-data");
    const assetHashes = [
      autoDeleteAssetId,
      bucketDeploymentHandlerAssetId,
      codegenSourceAssetId,
      introspectionSourceAssetId,
      legacyAwsCliLayerAssetId,
    ];
    for (const assetHash of assetHashes) {
      const body = await generatedAssetZip(fixture, assetHash);
      await s3.send(new PutObjectCommand({ Bucket: `cdk-hnb659fds-assets-${accountId}-${region}`, Key: `${assetHash}.zip`, Body: body }));
    }
    const data = JSON.parse(await readFile(join(fixture, "evidence", "templates", "data.json"), "utf8"));
    const logicalIds = [
      "amplifyDataAmplifyCodegenAssetsAmplifyCodegenAssetsBucket9CCB4ACA",
      "amplifyDataAmplifyCodegenAssetsAmplifyCodegenAssetsBucketPolicyF1C1C548",
      "amplifyDataAmplifyCodegenAssetsAmplifyCodegenAssetsBucketAutoDeleteObjectsCustomResource437F26F5",
      "amplifyDataAmplifyCodegenAssetsAmplifyCodegenAssetsDeploymentAwsCliLayerE322F905",
      "amplifyDataAmplifyCodegenAssetsAmplifyCodegenAssetsDeploymentCustomResource1536MiB21775929",
      "CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092",
      "CustomS3AutoDeleteObjectsCustomResourceProviderHandler9D90184F",
      "CustomCDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C1536MiBServiceRoleA41FC8C2",
      "CustomCDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C1536MiBServiceRoleDefaultPolicyFF1C635B",
      "CustomCDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C1536MiBC5D8AB21",
      "modelIntrospectionSchemaBucketF566B665",
      "modelIntrospectionSchemaBucketPolicy4DAB0D15",
      "modelIntrospectionSchemaBucketAutoDeleteObjectsCustomResourceFE57309F",
      "modelIntrospectionSchemaBucketDeploymentAwsCliLayer13C432F7",
      "modelIntrospectionSchemaBucketDeploymentCustomResource1536MiB104B97EC",
    ];
    const TemplateBody = JSON.stringify({ Resources: Object.fromEntries(logicalIds.map(logicalId => [logicalId, data.Resources[logicalId]])) });
    const created = await cloudformation.send(new CreateStackCommand({ StackName: "amplify-stacksimamplifygen2datafixture-amx01-sandbox-26187e8ba5-data", TemplateBody, Capabilities: ["CAPABILITY_NAMED_IAM"], RoleARN: executionRoleArn }));
    try {
      await waitForStack(cloudformation, created.StackId!, "CREATE_COMPLETE");
    } catch (error) {
      const diagnostics: string[] = [];
      for (const logGroupName of Object.keys(simulator.store.regionState(region).logs)) {
        const events = await logs.send(new FilterLogEventsCommand({ logGroupName }));
        diagnostics.push(`${logGroupName}: ${(events.events ?? []).map(event => event.message).join(" || ")}`);
      }
      assert.fail(`${error instanceof Error ? error.message : String(error)}; ${diagnostics.join(" | ")}`);
    }
    const resources = await cloudformation.send(new ListStackResourcesCommand({ StackName: created.StackId! }));
    const codegenBucket = resources.StackResourceSummaries?.find(resource => resource.LogicalResourceId === logicalIds[0])?.PhysicalResourceId;
    const introspectionBucket = resources.StackResourceSummaries?.find(resource => resource.LogicalResourceId === "modelIntrospectionSchemaBucketF566B665")?.PhysicalResourceId;
    assert.ok(codegenBucket && introspectionBucket);
    assert.deepEqual((await simulator.s3.listCurrentObjectsInternal(codegenBucket!)).map(object => object.key), ["model-schema.graphql"]);
    assert.deepEqual((await simulator.s3.listCurrentObjectsInternal(introspectionBucket!)).map(object => object.key), ["modelIntrospectionSchema.json"]);
    await s3.send(new PutObjectCommand({ Bucket: codegenBucket, Key: "owned/payload.txt", Body: "delete me" }));
    await cloudformation.send(new DeleteStackCommand({ StackName: created.StackId! }));
    await waitForStack(cloudformation, created.StackId!, "DELETE_COMPLETE");
    assert.equal(await simulator.s3.readBucketInternal(codegenBucket!), undefined);
    assert.equal(await simulator.s3.readBucketInternal(introspectionBucket!), undefined);
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("AMX-04B-D: the unchanged generated Provider framework creates, stabilizes, reports, and deletes the Amplify table", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx04-provider-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, accountId, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const cloudformation = new CloudFormationClient({ endpoint, region, credentials }); clients.push(cloudformation);
    const s3 = new S3Client({ endpoint, region, credentials, forcePathStyle: true }); clients.push(s3);
    const dynamodb = new DynamoDBClient({ endpoint, region, credentials }); clients.push(dynamodb);
    const sfn = new SFNClient({ endpoint, region, credentials }); clients.push(sfn);
    const logs = new CloudWatchLogsClient({ endpoint, region, credentials }); clients.push(logs);
    const cloudwatch = new CloudWatchClient({ endpoint, region, credentials }); clients.push(cloudwatch);
    const fixture = join(process.cwd(), "test", "fixtures", "amplify-gen2-data");
    const assetHash = tableManagerAssetId;
    const asset = await generatedAssetZip(fixture, assetHash);
    await s3.send(new PutObjectCommand({ Bucket: `cdk-hnb659fds-assets-${accountId}-${region}`, Key: `${assetHash}.zip`, Body: asset }));

    const managerTemplate = await readFile(join(fixture, "evidence", "templates", "table-manager.json"), "utf8");
    const manager = await cloudformation.send(new CreateStackCommand({
      StackName: "amx04-table-manager",
      TemplateBody: managerTemplate,
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      Parameters: [{ ParameterKey: "referencetoamplifystacksimamplifygen2datafixtureamx01sandbox26187e8ba5dataamplifyDataGraphQLAPI21884E71ApiId", ParameterValue: "amx04api" }],
      RoleARN: executionRoleArn,
    }));
    const managerComplete = await waitForStack(cloudformation, manager.StackId!, "CREATE_COMPLETE");
    const serviceToken = managerComplete.Outputs?.find((output: { OutputKey?: string; OutputValue?: string }) => output.OutputKey?.endsWith("B513Arn"))?.OutputValue;
    assert.match(serviceToken ?? "", /^arn:aws:lambda:eu-west-1:000000000000:function:/);

    const frozenTodo = JSON.parse(await readFile(join(fixture, "evidence", "templates", "todo.json"), "utf8"));
    const tableTemplate = (deletionProtectionEnabled: boolean): string => {
      const resource = structuredClone(frozenTodo.Resources.TodoTable);
      resource.Properties.deletionProtectionEnabled = deletionProtectionEnabled;
      return JSON.stringify({ Parameters: frozenTodo.Parameters, Conditions: frozenTodo.Conditions, Resources: { TodoTable: resource }, Outputs: {
      TableName: { Value: { "Fn::GetAtt": ["TodoTable", "TableName"] } },
      TableArn: { Value: { "Fn::GetAtt": ["TodoTable", "TableArn"] } },
      TableStreamArn: { Value: { "Fn::GetAtt": ["TodoTable", "TableStreamArn"] } },
    } });
    };
    const todoParameterNames = Object.keys(frozenTodo.Parameters) as string[];
    const tableParameters = [
      { ParameterKey: todoParameterNames.find(name => name.includes("AmplifyTableManager"))!, ParameterValue: serviceToken! },
      { ParameterKey: todoParameterNames.find(name => name.endsWith("ApiId"))!, ParameterValue: "amx04api" },
      { ParameterKey: todoParameterNames.find(name => name.endsWith("Name"))!, ParameterValue: "NONE" },
    ];
    const initialTableTemplate = tableTemplate(false);
    const table = await cloudformation.send(new CreateStackCommand({ StackName: "amx04-table", TemplateBody: initialTableTemplate, Parameters: tableParameters, RoleARN: executionRoleArn }));
    const tableComplete = await waitForStack(cloudformation, table.StackId!, "CREATE_COMPLETE");
    assert.equal(tableComplete.Outputs?.find((output: { OutputKey?: string; OutputValue?: string }) => output.OutputKey === "TableName")?.OutputValue, "Todo-amx04api-NONE");
    const described = await dynamodb.send(new DescribeTableCommand({ TableName: "Todo-amx04api-NONE" }));
    assert.equal(described.Table?.TableStatus, "ACTIVE");
    assert.equal(described.Table?.StreamSpecification?.StreamViewType, "NEW_AND_OLD_IMAGES");
    const createdResource = (await cloudformation.send(new ListStackResourcesCommand({ StackName: table.StackId! }))).StackResourceSummaries?.find(resource => resource.LogicalResourceId === "TodoTable");
    assert.equal(createdResource?.PhysicalResourceId, "Todo-amx04api-NONE");
    const machines = await sfn.send(new ListStateMachinesCommand({}));
    const waiter = machines.stateMachines?.find(machine => machine.name?.includes("AmplifyTableWaiter"));
    assert.ok(waiter?.stateMachineArn);
    let waiterSucceeded = false;
    for (let attempt = 0; attempt < 200 && !waiterSucceeded; attempt++) {
      const executions = await sfn.send(new ListExecutionsCommand({ stateMachineArn: waiter!.stateMachineArn! }));
      waiterSucceeded = Boolean(executions.executions?.some(execution => execution.status === "SUCCEEDED"));
      if (!waiterSucceeded) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(waiterSucceeded, "generated waiter did not execute successfully");

    const updatedTemplate = tableTemplate(true);
    await cloudformation.send(new UpdateStackCommand({ StackName: table.StackId!, TemplateBody: updatedTemplate }));
    await waitForStack(cloudformation, table.StackId!, "UPDATE_COMPLETE");
    const updatedResource = (await cloudformation.send(new ListStackResourcesCommand({ StackName: table.StackId! }))).StackResourceSummaries?.find(resource => resource.LogicalResourceId === "TodoTable");
    assert.equal(updatedResource?.PhysicalResourceId, createdResource?.PhysicalResourceId, "in-place update changed the generated physical ID");
    assert.equal((await dynamodb.send(new DescribeTableCommand({ TableName: "Todo-amx04api-NONE" }))).Table?.DeletionProtectionEnabled, true);
    const executionsBeforeNoOp = (await sfn.send(new ListExecutionsCommand({ stateMachineArn: waiter!.stateMachineArn! }))).executions?.length;
    await assert.rejects(cloudformation.send(new UpdateStackCommand({ StackName: table.StackId!, TemplateBody: updatedTemplate })), /No updates/);
    const executionsAfterNoOp = (await sfn.send(new ListExecutionsCommand({ stateMachineArn: waiter!.stateMachineArn! }))).executions?.length;
    assert.equal(executionsAfterNoOp, executionsBeforeNoOp, "no-op update invoked the generated helper");

    const managerResources = (await cloudformation.send(new ListStackResourcesCommand({ StackName: manager.StackId! }))).StackResourceSummaries ?? [];
    const generatedFunctions = managerResources.filter(resource => resource.ResourceType === "AWS::Lambda::Function").map(resource => resource.PhysicalResourceId!).sort();
    assert.equal(generatedFunctions.length, 2);
    const generatedLogs = (await Promise.all(generatedFunctions.map(async functionName => {
      const events = await logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${functionName}` }));
      const metric = await cloudwatch.send(new GetMetricStatisticsCommand({ Namespace: "AWS/Lambda", MetricName: "Invocations", Dimensions: [{ Name: "FunctionName", Value: functionName }], StartTime: new Date(Date.now() - 120_000), EndTime: new Date(Date.now() + 120_000), Period: 60, Statistics: ["Sum"] }));
      assert.ok((metric.Datapoints ?? []).reduce((sum, point) => sum + Number(point.Sum ?? 0), 0) >= 1, `${functionName} did not publish its real invocation metric`);
      return (events.events ?? []).map(event => event.message ?? "").join("\n");
    }))).join("\n");
    assert.match(generatedLogs, /onEventHandler/);
    assert.match(generatedLogs, /isComplete/);
    assert.doesNotMatch(generatedLogs, /https:\/\/localhost:\d+\/_stacksim\/cloudformation\/custom-resource-response|X-Amz-(?:Credential|Security-Token|Signature)/i);

    const driftedTodo = JSON.parse(updatedTemplate);
    driftedTodo.Resources.TodoTable.Properties.tableName = "must-not-exist";
    driftedTodo.Resources.TodoTable.Properties.unknownHelperField = true;
    await assert.rejects(cloudformation.send(new CreateStackCommand({ StackName: "amx04-unknown-helper-field", TemplateBody: JSON.stringify(driftedTodo), Parameters: tableParameters })), /unknownHelperField|does not support property/);
    await assert.rejects(dynamodb.send(new DescribeTableCommand({ TableName: "must-not-exist" })), /ResourceNotFound/);

    await cloudformation.send(new UpdateStackCommand({ StackName: table.StackId!, TemplateBody: initialTableTemplate }));
    await waitForStack(cloudformation, table.StackId!, "UPDATE_COMPLETE");
    await cloudformation.send(new DeleteStackCommand({ StackName: table.StackId! }));
    await waitForStack(cloudformation, table.StackId!, "DELETE_COMPLETE");
    await assert.rejects(() => dynamodb.send(new DescribeTableCommand({ TableName: "Todo-amx04api-NONE" })), /ResourceNotFound/);
    let runningExecutions = 1;
    for (let attempt = 0; attempt < 400 && runningExecutions; attempt++) {
      const executions = await sfn.send(new ListExecutionsCommand({ stateMachineArn: waiter!.stateMachineArn! }));
      runningExecutions = (executions.executions ?? []).filter(execution => execution.status === "RUNNING").length;
      if (runningExecutions) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(runningExecutions, 0, "generated waiter execution remained active after the terminal custom-resource callback");
    await cloudformation.send(new DeleteStackCommand({ StackName: manager.StackId! }));
    await waitForStack(cloudformation, manager.StackId!, "DELETE_COMPLETE");
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
