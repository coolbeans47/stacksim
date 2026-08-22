import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalTextSha256 } from "./support/frozen-text.js";

const captureScript = resolve("scripts/capture-amplify-gen2-evidence.mjs");
const evidenceRoot = resolve("test/fixtures/amplify-gen2-data/evidence");
const expectedFirstRunActions = new Set([
  "cloudformation:CreateStack", "cloudformation:DescribeStackEvents", "cloudformation:DescribeStacks",
  "cloudformation:GetTemplateSummary", "cloudformation:ListStackResources",
  "s3:CompleteMultipartUpload", "s3:CreateMultipartUpload", "s3:GetBucketEncryption", "s3:GetBucketLocation",
  "s3:GetObject", "s3:ListObjectsV2", "s3:PutObject", "s3:UploadPart",
  "ssm:GetParameter", "ssm:GetParametersByPath", "sts:AssumeRole", "sts:GetCallerIdentity",
]);

const protectedEvidence: Record<string, string> = {
  "graph-manifest.json": "4b796f05936b1943ab1f22f57395219d1b840573d959fdd0669818cb1b1f7868",
  "amx04-helper-manifest.json": "16200269bb57a1e015770e3e0c318bb813305d6ecb0d667350506ea29c55aaf2",
  "amx05-appsync-manifest.json": "273fe7171f89b09084334ca3836cc0ab1ea71333fa98bb2bd5018f06551e1e31",
  "amx06-authorization-manifest.json": "2e2e8fb4937b16ca262a5b6f31a9b015896b75e36a1ea01a629c05d74a81349d",
  "amx07-data-manifest.json": "8a10980c50ed9fe162128e57b0d98ec69f432816e43cf69f1ce2efe635c2ec3e",
  "amx08-realtime-manifest.json": "56254bf0e8253adb83bba572e48eea9602bfa3b136f47b4387896eeae9fb2b6f",
};

function assertExactActions(calls: any[]) {
  const actual = new Set(calls.map(call => `${call.service}:${call.action}`));
  assert.deepEqual({
    unexpected: [...actual].filter(action => !expectedFirstRunActions.has(action)),
    missing: [...expectedFirstRunActions].filter(action => !actual.has(action)),
  }, { unexpected: [], missing: [] }, "AMX-09 transport drift requires frozen-corpus review");
}

async function capture(args: string[]): Promise<any> {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx09-test-"));
  const output = join(root, "capture.json");
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [captureScript, ...args, "--output", output], { cwd: resolve("."), env: process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk))); child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
      child.once("error", reject); child.once("close", code => resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    });
    assert.equal(result.code, 0, `capture failed\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(await readFile(output, "utf8"));
  } finally { await rm(root, { recursive: true, force: true }); }
}

function allTrue(value: any): boolean {
  return value && Object.entries(value).every(([key, item]) => key === "subscriptionErrors" ? item === 0 : typeof item === "object" ? allTrue(item) : item === true);
}

test("AMX-09 deploys the unchanged sandbox, writes usable outputs, survives restart, and deletes only owned workload", { timeout: 300_000 }, async () => {
  const evidence = await capture(["--bootstrap", "--auth-enforce", "--appsync-tls", "--restart", "--delete"]);
  assert.equal(evidence.mode, "credential-enforced-transport");
  assert.equal(evidence.result.code, 0);
  assert.match(evidence.result.stdout, /Deployment completed/);
  assert.match(evidence.result.stdout, /File written: amplify_outputs\.json/);
  assert.doesNotMatch(evidence.result.stdout, /RoleName must be a valid IAM name|ROLLBACK_/);
  assertExactActions(evidence.calls.filter((call: any) => call.phase === "sandbox-once"));
  assert.equal(evidence.calls.some((call: any) => call.service === "amplify"), false, "AMX-02A remains inactive");

  assert.equal(evidence.bootstrap.descriptor.compatibilityVersion, 23);
  assert.equal(evidence.bootstrap.descriptor.policyRevision, 17);
  assert.equal(evidence.bootstrap.bucket.managedRevision, 17);
  assert.equal(evidence.bootstrap.versionParameter.Parameter.Value, "23");
  assert.deepEqual(Object.fromEntries(evidence.bootstrap.roles.map((role: any) => [role.purpose, role.roleName])), {
    deploy: "cdk-hnb659fds-deploy-role-000000000000-eu-west-1",
    filePublishing: "cdk-hnb659fds-file-publishing-role-000000000000-eu-west-1",
    imagePublishing: "cdk-hnb659fds-image-publishing-role-000000000000-eu-west-1",
    lookup: "cdk-hnb659fds-lookup-role-000000000000-eu-west-1",
    cloudFormationExecution: "cdk-hnb659fds-cfn-exec-role-000000000000-eu-west-1",
  });

  assert.deepEqual(evidence.output.topLevelKeys, ["data", "version"]);
  assert.deepEqual(evidence.output.dataKeys, ["api_key", "authorization_types", "aws_region", "default_authorization_type", "model_introspection", "url"]);
  assert.equal(evidence.output.version, "1.5");
  assert.equal(evidence.output.region, "eu-west-1");
  assert.equal(evidence.output.defaultAuthorizationType, "API_KEY");
  assert.deepEqual(evidence.output.authorizationTypes, ["AWS_IAM"]);
  assert.deepEqual(evidence.output.modelIntrospection, { version: 1, models: ["Todo"] });
  assert.match(evidence.output.graphqlUrl, new RegExp(`^https://127\\.0\\.0\\.1:\\d+/graphql/eu-west-1/${evidence.output.apiId}$`));
  assert.equal(evidence.output.realtimeDerivation, evidence.output.graphqlUrl.replace(/^https:/, "wss:") + "/realtime");
  assert.deepEqual(evidence.output.apiKey, { present: true, length: 36, value: "<redacted>" });
  assert.match(evidence.output.redactedDigest, /^[a-f0-9]{64}$/);
  assert.equal(allTrue(evidence.clientUse), true);
  assert.equal(allTrue(evidence.outputIsolation), true);

  assert.equal(evidence.successfulStackGraph.length, 4);
  assert.ok(evidence.successfulStackGraph.every((stack: any) => stack.status === "CREATE_COMPLETE"));
  assert.deepEqual(evidence.successfulStackGraph.map((stack: any) => stack.resources.length).sort((a: number, b: number) => a - b), [2, 9, 26, 38]);
  const root = evidence.successfulStackGraph.find((stack: any) => stack.parentId === null);
  assert.deepEqual(root.outputs.map((output: any) => output.key).sort(), [
    "amplifyApiModelSchemaS3Uri", "awsAppsyncAdditionalAuthenticationTypes", "awsAppsyncApiEndpoint", "awsAppsyncApiId",
    "awsAppsyncApiKey", "awsAppsyncAuthenticationType", "awsAppsyncRegion", "deploymentType", "region",
  ]);
  assert.equal(root.outputs.find((output: any) => output.key === "awsAppsyncApiId").value, evidence.output.apiId);
  assert.equal(root.outputs.find((output: any) => output.key === "awsAppsyncApiEndpoint").value, evidence.output.graphqlUrl);
  assert.equal(root.outputs.find((output: any) => output.key === "awsAppsyncApiKey").value, "<redacted>");
  const generatedRole = evidence.successfulStackGraph.flatMap((stack: any) => stack.resources).find((resource: any) => resource.logicalId === "TodoIAMRole2DA8E66E");
  assert.match(generatedRole.physicalId, /^TodoIAMRolecfd440-[a-f0-9]{26}-NONE$/);
  assert.ok(generatedRole.physicalId.length <= 64);

  assert.equal(evidence.restart.stackGraphIdentityPreserved, true);
  assert.equal(evidence.restart.outputIdentityPreserved, true);
  assert.equal(allTrue(evidence.restart.clientUse), true);
  assert.deepEqual(evidence.deletion, {
    rootStatus: "DELETE_COMPLETE", ownedChildStacksRemaining: 0,
    workload: { functions: 0, tables: 0, appsyncApis: 0 }, bootstrapPreserved: true, unrelatedStackPreserved: true, staleOutputRejected: true,
    command: "DeleteStack",
  });

  for (const [file, digest] of Object.entries(protectedEvidence)) {
    assert.equal(canonicalTextSha256(await readFile(join(evidenceRoot, file))), digest, `${file} changed during AMX-09`);
  }
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /ASIA[0-9A-Z]{16}|da2-[A-Za-z0-9_-]{20,}|X-Amz-Security-Token|"secretAccessKey"|"sessionToken"|password|PolicyDocument|Conditional\(|amx09-alpha/i);
});

test("AMX-09 fails before deployment and does not write a success-shaped output when bootstrap is missing", {
  timeout: 300_000,
  skip: process.env.STACKSIM_RUN_AMPLIFY_BOOTSTRAP_NEGATIVE_TEST === "1"
    ? false
    : "Opt-in because the pinned Amplify CLI opens the AWS bootstrap page in the developer's browser",
}, async () => {
  const evidence = await capture(["--auth-enforce", "--appsync-tls"]);
  assert.equal(evidence.result.code, 0, "the pinned CLI diagnoses the missing bootstrap with a zero process code");
  assert.match(`${evidence.result.stdout}\n${evidence.result.stderr}`, /region eu-west-1 has not been bootstrapped/i);
  assert.deepEqual(evidence.calls.map((call: any) => ({ service: call.service, action: call.action, resultClass: call.resultClass })), [{ service: "ssm", action: "GetParameter", resultClass: "error:ParameterNotFound" }]);
  assert.equal(evidence.bootstrap, null);
  assert.equal(evidence.output?.cliWriteObserved ?? false, false);
  assert.equal(evidence.clientUse, undefined);
  assert.deepEqual(evidence.stateSummary, { stacks: 0, buckets: 0, functions: 0, tables: 0, appsyncApis: 0 });
});
