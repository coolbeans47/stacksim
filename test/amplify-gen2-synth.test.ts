import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { canonicalTextBytes } from "./support/frozen-text.js";

const fixture = resolve("test/fixtures/amplify-gen2-data");
const evidence = join(fixture, "evidence");
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const digest = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");

async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else result.push(full);
    }
  }
  await visit(root);
  return result.sort();
}

function verifyEvidence(entries: Array<{ path: string; sha256: string; bytes: number }>, contents: Map<string, Buffer>) {
  for (const entry of entries) {
    const content = contents.get(entry.path);
    assert.ok(content, `missing frozen evidence ${entry.path}`);
    const canonical = canonicalTextBytes(content);
    assert.equal(canonical.length, entry.bytes, `byte drift in ${entry.path}`);
    assert.equal(digest(canonical), entry.sha256, `content drift in ${entry.path}`);
  }
}

const expectedResources = new Set([
  "AWS::AppSync::ApiKey", "AWS::AppSync::DataSource", "AWS::AppSync::FunctionConfiguration",
  "AWS::AppSync::GraphQLApi", "AWS::AppSync::GraphQLSchema", "AWS::AppSync::Resolver",
  "AWS::CDK::Metadata", "AWS::CloudFormation::Stack", "AWS::IAM::Policy", "AWS::IAM::Role",
  "AWS::Lambda::Function", "AWS::Lambda::LayerVersion", "AWS::S3::Bucket", "AWS::S3::BucketPolicy",
  "AWS::SSM::Parameter", "AWS::StepFunctions::StateMachine", "Custom::AmplifyDynamoDBTable",
  "Custom::CDKBucketDeployment", "Custom::S3AutoDeleteObjects",
]);

const expectedActions = new Set([
  "cloudformation:CreateStack", "cloudformation:DescribeStackEvents", "cloudformation:DescribeStacks",
  "cloudformation:ListStackResources", "s3:CompleteMultipartUpload", "s3:CreateMultipartUpload",
  "s3:GetBucketEncryption", "s3:GetBucketLocation", "s3:ListObjectsV2", "s3:PutObject", "s3:UploadPart", "ssm:GetParameter",
  "ssm:GetParametersByPath", "sts:AssumeRole", "sts:GetCallerIdentity",
]);

function assertExactSet(actual: Set<string>, expected: Set<string>, label: string) {
  const unexpected = [...actual].filter(value => !expected.has(value));
  const missing = [...expected].filter(value => !actual.has(value));
  assert.deepEqual({ unexpected, missing }, { unexpected: [], missing: [] }, `${label} drift requires AMX-01 review`);
}

test("AMX-01 supports the repository Node minimum and newer releases", async () => {
  const pkg = await json(join(fixture, "package.json"));
  const nodeVersion = (await readFile(join(fixture, ".node-version"), "utf8")).trim();
  assert.equal(nodeVersion, "22.13.0");
  assert.equal(pkg.packageManager, "npm@11.9.0");
  assert.deepEqual(pkg.engines, { node: ">=22.13.0" });
  assert.deepEqual(pkg.dependencies, {
    "@aws-amplify/backend": "1.24.0",
    "@aws-amplify/backend-cli": "1.9.0",
    "aws-amplify": "6.20.0",
    "typescript": "7.0.2",
  });
  for (const version of Object.values(pkg.dependencies) as string[]) assert.match(version, /^\d+\.\d+\.\d+$/);
});

test("AMX-01 transitive manifest is an exact lockfile projection with registry integrities", async () => {
  const lock = await json(join(fixture, "package-lock.json"));
  const manifest = await json(join(evidence, "dependency-manifest.json"));
  const sources = await json(join(evidence, "fixture-source-manifest.json"));
  assert.equal(manifest.scope, "current-clean-install");
  assert.equal(manifest.frozenSynthesisProvenance, "fixture-source-manifest.json");
  assert.equal(sources.scope, "current-clean-install");
  assert.deepEqual(manifest.directDependencies, (await json(join(fixture, "package.json"))).dependencies);
  assert.deepEqual(manifest.directDevDependencies, { "aws-cdk-lib": "2.265.0" });
  assert.deepEqual(sources.frozenSynthesisProvenance, {
    status: "historical-compatibility-corpus",
    nodeVersion: "24.14.0",
    awsCdkLib: "2.263.0",
    bucketDeploymentAwsCliLayerAsset: "a72522445441e9b66c2f16956c54d4786af8c61c156b80c48a6e7c32fcc49023.zip",
    nodeVersionFile: { sha256: "75daa0bc10dae1f22b2d13386b55b232adf16930d4325902f37b5033b3a7ca93", bytes: 8 },
    packageJson: { sha256: "67e02a0264f943e625933d80c634cd7794449bc9ae3d83697efcdcf175d0ca39", bytes: 388 },
    packageLock: { sha256: "ef8f447f4f0a68b19043356a733d9c76d39ee221351c997bb457124c09b59f18", bytes: 729922 },
  });
  for (const entry of sources.files as Array<{ path: string; bytes: number; sha256: string }>) {
    const content = canonicalTextBytes(await readFile(join(fixture, entry.path)));
    assert.deepEqual({ bytes: content.length, sha256: digest(content) }, { bytes: entry.bytes, sha256: entry.sha256 }, `${entry.path} current-source provenance drift`);
  }
  assert.equal(manifest.lockfileVersion, lock.lockfileVersion);
  assert.equal(manifest.selectedPackages.length, Object.keys(lock.packages).length);
  for (const selected of manifest.selectedPackages) {
    const lockPath = selected.path === "." ? "" : selected.path.replaceAll("/", "\\");
    const item = lock.packages[lockPath] ?? lock.packages[selected.path];
    assert.ok(item, `lock entry ${selected.path}`);
    assert.equal(selected.version, item.version ?? null);
    assert.equal(selected.integrity, item.integrity ?? null);
    if (selected.resolved?.startsWith("https://registry.npmjs.org/")) assert.match(selected.integrity, /^sha512-/);
  }
});

test("AMX-01 evidence manifest detects file and intentional manifest drift", async () => {
  const manifest = await json(join(evidence, "evidence-manifest.json"));
  const contents = new Map<string, Buffer>();
  for (const file of await filesUnder(evidence)) {
    const path = relative(evidence, file).replaceAll("\\", "/");
    if (path !== "evidence-manifest.json") contents.set(path, await readFile(file));
  }
  verifyEvidence(manifest.files, contents);
  const tampered = manifest.files.map((entry: { path: string; sha256: string; bytes: number }, index: number) => index ? entry : { ...entry, sha256: "0".repeat(64) });
  assert.throws(() => verifyEvidence(tampered, contents), /content drift/);
});

test("AMX-01 graph gate rejects unexpected resources and freezes properties, helpers, IAM, assets, and outputs", async () => {
  const graph = await json(join(evidence, "graph-manifest.json"));
  assertExactSet(new Set(graph.resources.map((item: { type: string }) => item.type)), expectedResources, "resource");
  assert.equal(graph.resources.length, 75);
  assert.equal(graph.customResources.length, 5);
  assert.equal(graph.lambdas.length, 4);
  assert.equal(graph.stateMachines.length, 1);
  assert.deepEqual(graph.stateMachines[0].integrations, ["direct-lambda-arn-task"]);
  assert.ok(graph.iamEdges.length > 0);
  assert.equal(graph.outputs.length, 16);
  const assets = await json(join(evidence, "assets-manifest.json"));
  assert.equal(assets.assets.length, 29);
  assert.ok(assets.assets.every((item: { sha256: string }) => /^[a-f0-9]{64}$/.test(item.sha256)));
  const unexpected = new Set([...expectedResources, "AWS::MadeUp::Drift"]);
  assert.throws(() => assertExactSet(unexpected, expectedResources, "resource"), /requires AMX-01 review/);
});

test("AMX-01 trace is loopback-only, redacted, and gates unexpected service calls", async () => {
  const trace = await json(join(evidence, "aws-call-trace.json"));
  assert.equal(trace.amx02aActivated, false);
  assert.equal(trace.preSandboxAmplifyServiceCall, false);
  assert.deepEqual(trace.stateAfterFailure, { stacks: 1, buckets: 1, functions: 0, tables: 0, appsyncApis: 0 });
  assert.match(trace.firstUnsupported, /AWS::SSM::Parameter/);
  assert.ok(trace.calls.every((call: { hostClass: string; account: string; region: string }) => call.hostClass === "approved-loopback" && call.account === "000000000000" && call.region === "eu-west-1"));
  assertExactSet(new Set(trace.calls.map((call: { service: string; action: string }) => `${call.service}:${call.action}`)), expectedActions, "action");
  const unexpected = new Set([...expectedActions, "amplify:GetBackendEnvironment"]);
  assert.throws(() => assertExactSet(unexpected, expectedActions, "action"), /requires AMX-01 review/);
  const allEvidence = Buffer.concat(await Promise.all((await filesUnder(evidence)).map(file => readFile(file)))).toString("utf8");
  assert.doesNotMatch(allEvidence, /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|X-Amz-Security-Token|AWS_SECRET_ACCESS_KEY\s*[:=]|x-api-key\s*[:=]/i);
});

test("AMX-01 isolates telemetry/update checks and records every frontend endpoint derivation", async () => {
  const optional = await json(join(evidence, "optional-network.json"));
  assert.ok(optional.attempts.every((attempt: { hostClass: string }) => attempt.hostClass === "approved-loopback"));
  assert.equal(optional.isolation.amplifyTelemetry, "AMPLIFY_DISABLE_TELEMETRY=1");
  assert.match(optional.isolation.networkTripwire, /loopback/);
  const endpoints = await json(join(evidence, "endpoint-derivation.json"));
  assert.deepEqual(Object.keys(endpoints.categories).sort(), ["appSyncHttp", "appSyncRealtime", "cognitoIdentity", "cognitoUserPool", "lambda", "s3"]);
  assert.match(endpoints.categories.s3.localOverride, /no supported frontend loopback route/i);
  assert.match(endpoints.categories.lambda.derivation, /no direct Lambda invocation category/i);
});

test("AMX-01 synthesis-only tripwire records zero workload mutation", async () => {
  const synthesis = await json(join(evidence, "synthesis-only.json"));
  assert.equal(synthesis.workloadMutation, false);
  assert.deepEqual(synthesis.stateAfterRun, { stacks: 0, buckets: 1, functions: 0, tables: 0, appsyncApis: 0 });
  assert.equal(synthesis.firstBlockedMutation.service, "cloudformation");
  assert.equal(synthesis.firstBlockedMutation.action, "CreateStack");
  assert.equal(synthesis.firstBlockedMutation.resultClass, "blocked:synthesis-only-no-workload-mutation");
  assert.deepEqual(synthesis.networkHostClasses, ["approved-loopback"]);
});
