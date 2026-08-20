import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, DeleteStackCommand, ListExportsCommand, ListImportsCommand, ListStacksCommand } from "@aws-sdk/client-cloudformation";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { HeadObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { StackSim } from "../src/server.js";
import { CLOUDFORMATION_SUPPORTED_ACTIONS } from "../src/cloudformation.js";
import { semanticCdkAssemblyDigests } from "./support/artifact-snapshots.js";
import { cdkCli, cdkCommandTimeoutMs } from "./support/project-cli.js";

interface CdkResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface AwsCall {
  command: string;
  method: string;
  path: string;
  service: string;
  action: string;
  credentialAccessKeyId: string;
  host: string;
  region: string;
  parameterName?: string;
}

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "empty-stack");
const multiStackFixture = join(sourceRoot, "test", "fixtures", "cdk", "multi-stack");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const region = "eu-west-1";

function signingScope(authorization: string | undefined): { credentialAccessKeyId: string; region: string; service: string } {
  const match = authorization?.match(/Credential=([^/,\s]+)\/\d{8}\/([^/]+)\/([^/]+)\/aws4_request/);
  return { credentialAccessKeyId: match?.[1] ?? "unknown", region: match?.[2] ?? "unknown", service: match?.[3] ?? "unknown" };
}

function awsAction(service: string, body: Buffer, target: string | undefined, method: string, path: string): string {
  if (target) return target.slice(target.lastIndexOf(".") + 1);
  const content = body.toString("utf8");
  if (service === "s3") {
    const url = new URL(path, "http://local");
    if (method === "GET" && url.searchParams.get("list-type") === "2") return "ListObjectsV2";
    return `${method}ObjectOrBucket`;
  }
  try { return new URLSearchParams(content).get("Action") ?? "unknown"; }
  catch { return "unknown"; }
}

async function tracingProxy(upstreamPort: number, calls: AwsCall[], currentCommand: () => string) {
  const proxy = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const scope = signingScope(incoming.headers.authorization);
    const service = scope.service;
    const action = awsAction(service, body, incoming.headers["x-amz-target"]?.toString(), incoming.method ?? "GET", incoming.url ?? "/");
    let parameterName: string | undefined;
    if (service === "ssm") {
      try { parameterName = String(JSON.parse(body.toString("utf8")).Name ?? "") || undefined; }
      catch { /* The upstream service will return the protocol error. */ }
    }
    calls.push({
      command: currentCommand(),
      method: incoming.method ?? "GET",
      path: incoming.url ?? "/",
      service,
      action,
      credentialAccessKeyId: scope.credentialAccessKeyId,
      host: incoming.headers.host ?? "unknown",
      region: scope.region,
      ...(parameterName ? { parameterName } : {}),
    });
    const forwarded = request({
      host: "127.0.0.1",
      port: upstreamPort,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
      response.pipe(outgoing);
    });
    forwarded.on("error", error => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain" });
      outgoing.end(`local trace proxy failed: ${error.message}`);
    });
    forwarded.end(body);
  });
  await new Promise<void>((resolvePromise, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => { proxy.off("error", reject); resolvePromise(); });
  });
  return {
    endpoint: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolvePromise, reject) => proxy.close(error => error ? reject(error) : resolvePromise())),
  };
}

function localCdkEnvironment(endpoint: string, tempRoot: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete env[key];
  }
  return {
    ...env,
    AWS_ACCESS_KEY_ID: "admin",
    AWS_SECRET_ACCESS_KEY: "password",
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_ENDPOINT_URL: endpoint,
    STACKSIM_NETWORK_ALLOW_PORT: new URL(endpoint).port,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_CONFIG_FILE: join(tempRoot, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(tempRoot, "no-aws-credentials"),
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    JSII_AGENT: "stacksim-tests/1", // Keep CDK metadata hashes independent of the host Node.js version.
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

async function runCdk(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = cdkCommandTimeoutMs, cwd = fixture): Promise<CdkResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cdkCli, ...args, "--no-notices", "--no-color"], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    let timedOut = false;
    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (timedOut) {
        reject(new Error(`CDK command timed out after ${timeoutMs}ms: ${args.join(" ")}\nstdout:\n${stdoutText}\nstderr:\n${stderrText}`));
        return;
      }
      resolvePromise({ code, signal, stdout: stdoutText, stderr: stderrText });
    });
  });
}

function assertAssignedCalls(calls: readonly AwsCall[], label: string): void {
  const assigned = new Map<string, ReadonlySet<string>>([
    ["cloudformation", new Set(CLOUDFORMATION_SUPPORTED_ACTIONS)],
    ["dynamodb", new Set(["DescribeTable"])],
    ["s3", new Set(["DELETEObjectOrBucket", "GETObjectOrBucket", "HEADObjectOrBucket", "ListObjectsV2", "POSTObjectOrBucket", "PUTObjectOrBucket"])],
    ["ssm", new Set(["GetParameter", "GetParameters"])],
    ["sts", new Set(["AssumeRole", "GetCallerIdentity"])],
  ]);
  const unassigned = calls.filter(call => !assigned.get(call.service)?.has(call.action));
  assert.deepEqual(unassigned, [], `${label} made an unassigned standard-CDK call: ${JSON.stringify(unassigned, null, 2)}`);
}

function assertCloudFormationSubsequence(calls: readonly AwsCall[], command: string, expected: readonly string[]): void {
  const actual = calls.filter(call => call.command === command && call.service === "cloudformation").map(call => call.action);
  let cursor = 0;
  for (const action of expected) {
    const found = actual.indexOf(action, cursor);
    assert.notEqual(found, -1, `${command} omitted or reordered ${action}; expected minimum ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`);
    cursor = found + 1;
  }
}

test("pinned unmodified CDK stays local and rejects deploys when the reduced bootstrap is disabled", { timeout: 600_000 }, async () => {
  await access(join(fixture, "app.ts")); await access(tripwire);
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-endpoint-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "off", cdkBootstrap: false });
  const calls: AwsCall[] = []; let command = "startup"; let proxy: Awaited<ReturnType<typeof tracingProxy>> | undefined; let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start();
    proxy = await tracingProxy(simulator.port, calls, () => command);
    const env = localCdkEnvironment(proxy.endpoint, root);
    cloudformation = new CloudFormationClient({ endpoint: proxy.endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });

    command = "version";
    const version = await runCdk(["--version"], env);
    assert.equal(version.code, 0, version.stderr);
    assert.match(version.stdout, /^2\.1132\.0\b/, "the subprocess must use the repository-pinned CDK CLI");

    const synthOutput = join(root, "synth.out");
    const callsBeforeSynth = calls.length;
    command = "synth";
    const synth = await runCdk(["--output", synthOutput, "synth", "EmptyStack"], env);
    assert.equal(synth.code, 0, `${synth.stdout}\n${synth.stderr}`);
    const synthesized = JSON.parse(await readFile(join(synthOutput, "EmptyStack.template.json"), "utf8"));
    const emptyDigests = await semanticCdkAssemblyDigests(synthOutput, ["EmptyStack.template.json"], ["manifest.json"]);
    assert.equal(emptyDigests["EmptyStack.template.json"], "8eaab08c5f631b444760be51f9ee3eb36a27b0523b539eaf78b52491d7e7bf97", "the pinned empty-stack semantic template corpus drifted");
    assert.equal(emptyDigests["manifest.json"], "c87f5cd9fb16691bbd46e5a85ee6dd0de1c129c5e07cce21af40ad9b5ae48c40", "the pinned empty-stack semantic cloud assembly drifted");
    assert.equal(synthesized.Parameters.BootstrapVersion.Type, "AWS::SSM::Parameter::Value<String>");
    assert.equal(synthesized.Parameters.BootstrapVersion.Default, "/cdk-bootstrap/hnb659fds/version");
    assert.ok(synthesized.Rules.CheckBootstrapVersion, "the default synthesizer bootstrap rule must remain intact");
    assert.equal(calls.length, callsBeforeSynth, "cdk synth must remain entirely local and make zero AWS SDK calls");

    command = "diff-template";
    const diff = await runCdk(["--output", join(root, "diff.out"), "diff", "EmptyStack", "--method", "template"], env);
    assert.equal(diff.code, 0, `${diff.stdout}\n${diff.stderr}`);

    for (const [label, args] of [
      ["deploy-direct", ["--output", join(root, "direct.out"), "deploy", "EmptyStack", "--method", "direct", "--require-approval", "never"]],
      ["deploy-default", ["--output", join(root, "default.out"), "deploy", "EmptyStack", "--require-approval", "never"]],
    ] as const) {
      command = label;
      const result = await runCdk(args, env);
      assert.notEqual(result.code, 0, `${label} unexpectedly deployed without the reduced bootstrap`);
      assert.match(`${result.stdout}\n${result.stderr}`, /(?:bootstrap|SSM|AWS::SSM::Parameter::Value|CFN-04)/i, `${label} did not identify the bootstrap SSM/version dependency; trace=${JSON.stringify(calls.filter(call => call.command === label))}`);
      command = `verify-${label}`;
      assert.equal((await cloudformation.send(new ListStacksCommand({}))).StackSummaries?.length, 0, `${label} accepted a stack without resolving the bootstrap version`);
    }

    command = "destroy";
    const destroy = await runCdk(["--output", join(root, "destroy.out"), "destroy", "EmptyStack", "--force"], env);
    assert.equal(destroy.code, 0, `${destroy.stdout}\n${destroy.stderr}`);

    const cliCommands = new Set(["diff-template", "deploy-direct", "deploy-default", "destroy"]);
    const cliCalls = calls.filter(call => cliCommands.has(call.command));
    assert.deepEqual(cliCalls.map(call => `${call.command}:${call.service}:${call.action}`), [
      "diff-template:sts:AssumeRole",
      "diff-template:cloudformation:DescribeStacks",
      "deploy-direct:sts:AssumeRole",
      "deploy-direct:s3:ListObjectsV2",
      "deploy-direct:sts:AssumeRole",
      "deploy-direct:ssm:GetParameter",
      "deploy-default:sts:AssumeRole",
      "deploy-default:s3:ListObjectsV2",
      "deploy-default:sts:AssumeRole",
      "deploy-default:ssm:GetParameter",
      "destroy:sts:AssumeRole",
      "destroy:cloudformation:DescribeStacks",
    ], "the pinned CDK endpoint call boundary changed");
    assert.ok(cliCalls.some(call => call.service === "sts" && (call.action === "GetCallerIdentity" || call.action === "AssumeRole")), "CDK did not exercise the configured local STS endpoint");
    assert.ok(cliCalls.some(call => call.service === "cloudformation" && call.action === "DescribeStacks"), "CDK did not exercise the configured local CloudFormation endpoint");
    assert.ok(cliCalls.some(call => call.service === "ssm" && call.action === "GetParameter"), "CDK did not stop at the configured local bootstrap SSM endpoint");
    assert.ok(cliCalls.some(call => call.service === "ssm" && call.parameterName === "/cdk-bootstrap/hnb659fds/version"), "CDK did not request the default synthesizer's exact bootstrap-version parameter");

    const assigned = new Map<string, Set<string>>([
      ["sts", new Set(["GetCallerIdentity", "AssumeRole"])],
      ["cloudformation", new Set(["DescribeStacks", "GetTemplate", "GetTemplateSummary", "ListStackResources", "DescribeStackEvents", "CreateStack", "DeleteStack"])],
      ["ssm", new Set(["GetParameter", "GetParameters"])],
      ["s3", new Set(["ListObjectsV2"])],
    ]);
    const unassigned = cliCalls.filter(call => !assigned.get(call.service)?.has(call.action));
    assert.deepEqual(unassigned, [], `CDK made an unassigned call: ${JSON.stringify(unassigned, null, 2)}`);
    assert.ok(cliCalls.every(call => call.path.startsWith("/")), "every recorded SDK call must traverse the loopback trace endpoint");
    assert.ok(cliCalls.every(call => call.host === new URL(proxy!.endpoint).host), "every traced call must use the configured standard endpoint");
    assert.ok(cliCalls.every(call => call.region === region), "every SigV4 scope must use the configured Region");
    const tracedRoles = [...new Set(cliCalls.map(call => simulator.store.ensureAccount().iam.sessions[call.credentialAccessKeyId]?.roleArn ?? `arn:aws:iam::000000000000:root`))].sort();
    assert.ok(tracedRoles.every(roleArn => roleArn.includes(":000000000000:")), "every traced principal must belong to the configured simulator account");
    assert.ok(tracedRoles.some(roleArn => roleArn.includes("lookup-role-") || roleArn.endsWith(":root")), "the trace must identify its concrete caller roles");
  } finally {
    cloudformation?.destroy();
    await proxy?.close().catch(() => undefined);
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("pinned unmodified CDK direct deploy uses the reduced bootstrap and real local role sessions", { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-direct-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "enforce", cdkBootstrap: true });
  const calls: AwsCall[] = []; let command = "startup"; let proxy: Awaited<ReturnType<typeof tracingProxy>> | undefined; let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start();
    proxy = await tracingProxy(simulator.port, calls, () => command);
    const env = localCdkEnvironment(proxy.endpoint, root);
    cloudformation = new CloudFormationClient({ endpoint: proxy.endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });

    command = "deploy-direct-bootstrap";
    const deployed = await runCdk(["--output", join(root, "direct.out"), "deploy", "EmptyStack", "--method", "direct", "--require-approval", "never"], env);
    assert.equal(deployed.code, 0, `${deployed.stdout}\n${deployed.stderr}\ntrace=${JSON.stringify(calls, null, 2)}`);
    const active = (await cloudformation.send(new ListStacksCommand({ StackStatusFilter: ["CREATE_COMPLETE"] }))).StackSummaries ?? [];
    assert.equal(active.length, 1);
    assert.equal(active[0].StackName, "EmptyStack");

    const bootstrap = simulator.store.regionState(region).cloudformation.bootstrap;
    assert.equal(bootstrap?.compatibilityVersion, 23);
    assert.equal(simulator.store.regionState(region).s3Buckets[bootstrap!.bucketName].versioning, "enabled");
    const sessionRoles = new Set(Object.values(simulator.store.ensureAccount().iam.sessions).map(session => session.roleName));
    assert.ok(simulator.store.ensureAccount().iam.roles[bootstrap!.roleArns.lookup.split("/").at(-1)!], "the distinct lookup role must exist even when this fixture performs no context lookup");
    assert.ok(sessionRoles.has(bootstrap!.roleArns.filePublishing.split("/").at(-1)!));
    assert.ok(sessionRoles.has(bootstrap!.roleArns.deploy.split("/").at(-1)!));
    assert.ok(sessionRoles.has(bootstrap!.roleArns.cloudFormationExecution.split("/").at(-1)!));
    assert.ok(calls.some(call => call.command === command && call.service === "s3" && call.method === "PUT"), "CDK did not publish its stack-template file asset through local S3");
    assert.ok(calls.some(call => call.command === command && call.service === "ssm" && call.parameterName === "/cdk-bootstrap/hnb659fds/version"));
    assert.ok(calls.some(call => call.command === command && call.service === "cloudformation" && call.action === "CreateStack"));
    assertCloudFormationSubsequence(calls, command, ["DescribeStacks", "CreateStack", "DescribeStackEvents", "DescribeStacks"]);

    command = "destroy-bootstrap";
    const destroyed = await runCdk(["--output", join(root, "destroy.out"), "destroy", "EmptyStack", "--force"], env);
    assert.equal(destroyed.code, 0, `${destroyed.stdout}\n${destroyed.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    assertCloudFormationSubsequence(calls, command, ["DescribeStacks", "DeleteStack", "DescribeStackEvents", "DescribeStacks"]);
    assert.equal((await cloudformation.send(new ListStacksCommand({ StackStatusFilter: ["CREATE_COMPLETE", "DELETE_IN_PROGRESS"] }))).StackSummaries?.length, 0);
    assert.ok(simulator.store.regionState(region).s3Buckets[bootstrap!.bucketName], "destroy must not remove the simulator-managed bootstrap bucket");
    assertAssignedCalls(calls, "direct deploy");
  } finally {
    cloudformation?.destroy();
    await proxy?.close().catch(() => undefined);
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("pinned aws_s3_assets.Asset publishes and deduplicates an arbitrary file through the reduced bootstrap", { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-generic-asset-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "enforce", cdkBootstrap: true });
  const calls: AwsCall[] = []; let command = "startup"; let proxy: Awaited<ReturnType<typeof tracingProxy>> | undefined;
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    proxy = await tracingProxy(simulator.port, calls, () => command);
    const env = { ...localCdkEnvironment(proxy.endpoint, root), CDK_DEFAULT_ACCOUNT: "000000000000", CDK_DEFAULT_REGION: region, CDK_GENERIC_ASSET: "true" };
    const options = { endpoint: proxy.endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options); const s3 = new S3Client(options); clients.push(cloudformation, s3);
    const outputsFile = join(root, "asset-outputs.json");

    command = "deploy-generic-asset";
    const deployed = await runCdk(["--output", join(root, "asset-create.out"), "deploy", "EmptyStack", "--method", "direct", "--require-approval", "never", "--outputs-file", outputsFile], env);
    assert.equal(deployed.code, 0, `${deployed.stdout}\n${deployed.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    const outputs = JSON.parse(await readFile(outputsFile, "utf8")).EmptyStack as Record<string, string>;
    assert.match(outputs.GenericAssetHash, /^[a-f0-9]{64}$/); assert.ok(outputs.GenericAssetBucket); assert.ok(outputs.GenericAssetKey);
    const object = await s3.send(new HeadObjectCommand({ Bucket: outputs.GenericAssetBucket, Key: outputs.GenericAssetKey }));
    assert.ok(object.VersionId, "the arbitrary asset must be stored in the real versioned bootstrap bucket");
    const versionsBefore = (await s3.send(new ListObjectVersionsCommand({ Bucket: outputs.GenericAssetBucket, Prefix: outputs.GenericAssetKey }))).Versions?.filter(version => version.Key === outputs.GenericAssetKey).length;
    assert.equal(versionsBefore, 1);
    assert.ok(calls.some(call => call.command === command && call.service === "s3" && call.method === "PUT" && decodeURIComponent(call.path).includes(outputs.GenericAssetKey)), "the generic file did not traverse local S3 publication");

    command = "redeploy-generic-asset";
    const repeated = await runCdk(["--output", join(root, "asset-repeat.out"), "deploy", "EmptyStack", "--method", "direct", "--require-approval", "never"], env);
    assert.equal(repeated.code, 0, `${repeated.stdout}\n${repeated.stderr}`);
    const versionsAfter = (await s3.send(new ListObjectVersionsCommand({ Bucket: outputs.GenericAssetBucket, Prefix: outputs.GenericAssetKey }))).Versions?.filter(version => version.Key === outputs.GenericAssetKey).length;
    assert.equal(versionsAfter, versionsBefore, "an identical generic asset deploy must deduplicate rather than create a new object version");

    command = "destroy-generic-asset";
    const destroyed = await runCdk(["--output", join(root, "asset-destroy.out"), "destroy", "EmptyStack", "--force"], env);
    assert.equal(destroyed.code, 0, `${destroyed.stdout}\n${destroyed.stderr}`);
    assert.equal((await cloudformation.send(new ListStacksCommand({ StackStatusFilter: ["CREATE_COMPLETE", "DELETE_IN_PROGRESS"] }))).StackSummaries?.length, 0);
    assert.ok((await s3.send(new HeadObjectCommand({ Bucket: outputs.GenericAssetBucket, Key: outputs.GenericAssetKey }))).VersionId, "the retention window must keep the now-unreferenced file immediately after destroy");
    assertAssignedCalls(calls, "generic file asset");
  } finally {
    clients.forEach(client => client.destroy()); await proxy?.close().catch(() => undefined); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("unmodified cdk bootstrap reaches change-set validation and fails before provisioning unsupported bootstrap resources", { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-bootstrap-negative-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "enforce", cdkBootstrap: true });
  const calls: AwsCall[] = []; let command = "bootstrap"; let proxy: Awaited<ReturnType<typeof tracingProxy>> | undefined; let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start(); proxy = await tracingProxy(simulator.port, calls, () => command);
    const env = { ...localCdkEnvironment(proxy.endpoint, root), CDK_DEFAULT_ACCOUNT: "000000000000", CDK_DEFAULT_REGION: region };
    cloudformation = new CloudFormationClient({ endpoint: proxy.endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });
    const bucketsBefore = Object.keys(simulator.store.regionState(region).s3Buckets).sort();
    const rolesBefore = Object.keys(simulator.store.ensureAccount().iam.roles).sort();

    const result = await runCdk(["--output", join(root, "bootstrap.out"), "bootstrap", `aws://000000000000/${region}`, "--force"], env);
    assert.notEqual(result.code, 0, "the reduced local contract must not claim support for the full default bootstrap template");
    assert.match(`${result.stdout}\n${result.stderr}`, /(?:Resource import change sets|AWS::S3::BucketPolicy|AWS::ECR::Repository|unsupported resource|JSON template|template)/i, "bootstrap must stop at its first exact, inventoried dependency boundary");
    const actions = calls.filter(call => call.service === "cloudformation").map(call => call.action);
    assert.ok(actions.includes("CreateChangeSet"), `bootstrap did not reach the implemented change-set boundary: ${JSON.stringify(actions)}`);
    assert.ok(!actions.includes("ExecuteChangeSet"), "an invalid full bootstrap change set must never execute");
    assert.deepEqual(Object.keys(simulator.store.regionState(region).s3Buckets).sort(), bucketsBefore, "full bootstrap must not provision an application bucket");
    assert.deepEqual(Object.keys(simulator.store.ensureAccount().iam.roles).sort(), rolesBefore, "full bootstrap must not provision template-owned roles");

    const placeholder = (await cloudformation.send(new ListStacksCommand({}))).StackSummaries?.find(stack => stack.StackName === "CDKToolkit");
    if (placeholder) await cloudformation.send(new DeleteStackCommand({ StackName: placeholder.StackId }));
    assertAssignedCalls(calls, "negative full bootstrap");
  } finally {
    cloudformation?.destroy(); await proxy?.close().catch(() => undefined); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("pinned unmodified default CDK deploys through local change sets for create, update, no-op, and destroy", { timeout: 900_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-change-set-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "enforce", cdkBootstrap: true });
  const calls: AwsCall[] = []; let command = "startup"; let proxy: Awaited<ReturnType<typeof tracingProxy>> | undefined; let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start();
    proxy = await tracingProxy(simulator.port, calls, () => command);
    const env = { ...localCdkEnvironment(proxy.endpoint, root), CDK_TEST_ANALYTICS: "v1" };
    cloudformation = new CloudFormationClient({ endpoint: proxy.endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });

    command = "deploy-create-change-set";
    const outputsFile = join(root, "outputs.json");
    const created = await runCdk(["--output", join(root, "create.out"), "deploy", "EmptyStack", "--require-approval", "never", "--outputs-file", outputsFile], env);
    assert.equal(created.code, 0, `${created.stdout}\n${created.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    assert.ok(calls.some(call => call.command === command && call.service === "cloudformation" && call.action === "CreateChangeSet"));
    assert.ok(calls.some(call => call.command === command && call.service === "cloudformation" && call.action === "ExecuteChangeSet"));
    assertCloudFormationSubsequence(calls, command, ["DescribeStacks", "CreateChangeSet", "DescribeChangeSet", "ExecuteChangeSet", "DescribeStackEvents", "DescribeStacks"]);
    assert.equal((await cloudformation.send(new ListStacksCommand({ StackStatusFilter: ["CREATE_COMPLETE"] }))).StackSummaries?.[0]?.StackName, "EmptyStack");
    assert.equal(JSON.parse(await readFile(outputsFile, "utf8")).EmptyStack.ProbeOutput, "v1");

    env.CDK_TEST_ANALYTICS = "v2";
    command = "deploy-update-change-set";
    const updated = await runCdk(["--output", join(root, "update.out"), "deploy", "EmptyStack", "--require-approval", "never"], env);
    assert.equal(updated.code, 0, `${updated.stdout}\n${updated.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    assert.ok(calls.some(call => call.command === command && call.service === "cloudformation" && call.action === "CreateChangeSet"));
    assert.ok(calls.some(call => call.command === command && call.service === "cloudformation" && call.action === "ExecuteChangeSet"));
    assertCloudFormationSubsequence(calls, command, ["DescribeStacks", "CreateChangeSet", "DescribeChangeSet", "ExecuteChangeSet", "DescribeStackEvents", "DescribeStacks"]);

    env.CDK_TEST_ANALYTICS = "v3";
    command = "diff-change-set";
    const difference = await runCdk(["--output", join(root, "diff-change-set.out"), "diff", "EmptyStack", "--method", "change-set"], env);
    assert.equal(difference.code, 0, `${difference.stdout}\n${difference.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    const diffActions = calls.filter(call => call.command === command && call.service === "cloudformation").map(call => call.action);
    assert.ok(diffActions.includes("CreateChangeSet") && diffActions.includes("DescribeChangeSet") && diffActions.includes("DeleteChangeSet"), `change-set diff silently fell back: ${JSON.stringify(diffActions)}`);
    assert.ok(!diffActions.includes("ExecuteChangeSet"), "read-only diff executed its change set");
    assertCloudFormationSubsequence(calls, command, ["DescribeStacks", "GetTemplate", "CreateChangeSet", "DescribeChangeSet", "DeleteChangeSet"]);
    assert.equal(simulator.store.regionState(region).cloudformation.stacks[simulator.store.regionState(region).cloudformation.stackNames.EmptyStack].resources.WorkflowProbe.properties.Analytics, "v2");

    command = "prepare-change-set";
    const prepared = await runCdk(["--output", join(root, "prepared.out"), "deploy", "EmptyStack", "--method", "prepare-change-set", "--change-set-name", "prepared-local-update", "--require-approval", "never"], env);
    assert.equal(prepared.code, 0, `${prepared.stdout}\n${prepared.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    const preparedActions = calls.filter(call => call.command === command && call.service === "cloudformation").map(call => call.action);
    assert.ok(preparedActions.includes("CreateChangeSet") && preparedActions.includes("DescribeChangeSet")); assert.ok(!preparedActions.includes("ExecuteChangeSet"));
    assertCloudFormationSubsequence(calls, command, ["DescribeStacks", "CreateChangeSet", "DescribeChangeSet"]);
    assert.equal(simulator.store.regionState(region).cloudformation.stacks[simulator.store.regionState(region).cloudformation.stackNames.EmptyStack].resources.WorkflowProbe.properties.Analytics, "v2", "preparing must not mutate workload state");

    command = "execute-prepared-change-set";
    const executed = await runCdk(["--output", join(root, "execute-prepared.out"), "deploy", "EmptyStack", "--method", "execute-change-set", "--change-set-name", "prepared-local-update", "--require-approval", "never"], env);
    assert.equal(executed.code, 0, `${executed.stdout}\n${executed.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    assert.ok(calls.some(call => call.command === command && call.service === "cloudformation" && call.action === "ExecuteChangeSet"));
    assertCloudFormationSubsequence(calls, command, ["ExecuteChangeSet", "DescribeStackEvents", "DescribeStacks"]);
    assert.equal(simulator.store.regionState(region).cloudformation.stacks[simulator.store.regionState(region).cloudformation.stackNames.EmptyStack].resources.WorkflowProbe.properties.Analytics, "v3");

    command = "deploy-no-op-change-set";
    const noOp = await runCdk(["--output", join(root, "noop.out"), "deploy", "EmptyStack", "--require-approval", "never"], env);
    assert.equal(noOp.code, 0, `${noOp.stdout}\n${noOp.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    assert.match(`${noOp.stdout}\n${noOp.stderr}`, /no changes/i);
    assertCloudFormationSubsequence(calls, command, ["DescribeStacks", "CreateChangeSet", "DescribeChangeSet", "DeleteChangeSet"]);
    assert.ok(!calls.some(call => call.command === command && call.service === "cloudformation" && call.action === "ExecuteChangeSet"), "ordinary no-op executed its empty change set");

    command = "deploy-force-no-op-change-set";
    const forcedNoOp = await runCdk(["--output", join(root, "forced-noop.out"), "deploy", "EmptyStack", "--require-approval", "never", "--force"], env);
    assert.equal(forcedNoOp.code, 0, `${forcedNoOp.stdout}\n${forcedNoOp.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    const forcedActions = calls.filter(call => call.command === command && call.service === "cloudformation").map(call => call.action);
    assert.ok(forcedActions.includes("CreateChangeSet") && forcedActions.includes("DescribeChangeSet") && forcedActions.includes("DeleteChangeSet"));
    assert.ok(!forcedActions.includes("ExecuteChangeSet"));
    assertCloudFormationSubsequence(calls, command, ["DescribeStacks", "CreateChangeSet", "DescribeChangeSet", "DeleteChangeSet"]);

    command = "destroy-change-set-stack";
    const destroyed = await runCdk(["--output", join(root, "destroy.out"), "destroy", "EmptyStack", "--force"], env);
    assert.equal(destroyed.code, 0, `${destroyed.stdout}\n${destroyed.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    assertCloudFormationSubsequence(calls, command, ["DescribeStacks", "DeleteStack", "DescribeStackEvents", "DescribeStacks"]);
    assert.equal((await cloudformation.send(new ListStacksCommand({ StackStatusFilter: ["CREATE_COMPLETE", "UPDATE_COMPLETE", "DELETE_IN_PROGRESS"] }))).StackSummaries?.length, 0);
    assertAssignedCalls(calls, "default change-set lifecycle");
  } finally {
    cloudformation?.destroy(); await proxy?.close().catch(() => undefined); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("pinned unmodified CDK deploy --all imports retained data into an API stack and destroys in reverse dependency order", { timeout: 600_000 }, async () => {
  await access(join(multiStackFixture, "app.ts"));
  const root = await mkdtemp(join(tmpdir(), "stacksim-cdk-multi-stack-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "enforce", cdkBootstrap: true });
  const calls: AwsCall[] = []; let command = "startup"; let proxy: Awaited<ReturnType<typeof tracingProxy>> | undefined;
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    proxy = await tracingProxy(simulator.port, calls, () => command);
    const env = { ...localCdkEnvironment(proxy.endpoint, root), CDK_DEFAULT_ACCOUNT: "000000000000", CDK_DEFAULT_REGION: region };
    const options = { endpoint: proxy.endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options); const dynamodb = new DynamoDBClient(options); clients.push(cloudformation, dynamodb);

    command = "deploy-all";
    const outputsFile = join(root, "multi-outputs.json");
    const deployed = await runCdk(["--output", join(root, "deploy-all.out"), "deploy", "--all", "--require-approval", "never", "--outputs-file", outputsFile], env, cdkCommandTimeoutMs, multiStackFixture);
    assert.equal(deployed.code, 0, `${deployed.stdout}\n${deployed.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    const multiAssembly = join(root, "deploy-all.out");
    const multiDigests = await semanticCdkAssemblyDigests(multiAssembly, ["DataStack.template.json", "ApiStack.template.json"], ["DataStack.assets.json", "ApiStack.assets.json", "manifest.json"]);
    assert.deepEqual(multiDigests, {
      "DataStack.template.json": "6c02e99f9dbb4f130976d769e60b0496c0e18f35a9773ed2e934cacd0a6e7b6a",
      "ApiStack.template.json": "d2c5223cbe654c6d75be984ed8e35d2154868a709bb3bcb7825e4aa3b676e5d8",
      "DataStack.assets.json": "55c2b1e337399c08a9e945697e361f9e30010df8d80b03bb3620f7b3841ee990",
      "ApiStack.assets.json": "3618046efc89180c516170cc6128e53708ddb14ee301bfc8a2f05e1da0562289",
      "manifest.json": "53a55ae97016b5fb60f699089ffb55167c1c809aeea4f469ebb31656eaae575d",
    }, "the pinned multi-stack semantic assembly drifted");
    const active = (await cloudformation.send(new ListStacksCommand({ StackStatusFilter: ["CREATE_COMPLETE", "UPDATE_COMPLETE"] }))).StackSummaries?.map(stack => stack.StackName).sort();
    assert.deepEqual(active, ["ApiStack", "DataStack"]);
    const outputs = JSON.parse(await readFile(outputsFile, "utf8"));
    assert.ok(outputs.DataStack.TableName);
    assert.ok(outputs.DataStack.TableArn);
    assert.equal(outputs.ApiStack.ImportedTableName, outputs.DataStack.TableName);
    assert.equal(outputs.ApiStack.ImportedTableArn, outputs.DataStack.TableArn);
    assert.ok(outputs.ApiStack.ApiId);
    const exports = await cloudformation.send(new ListExportsCommand({}));
    assert.equal(exports.Exports?.find(value => value.Name === "StackSimMultiStackTableName")?.Value, outputs.DataStack.TableName);
    assert.equal(exports.Exports?.find(value => value.Name === "StackSimMultiStackTableArn")?.Value, outputs.DataStack.TableArn);
    assert.deepEqual((await cloudformation.send(new ListImportsCommand({ ExportName: "StackSimMultiStackTableName" }))).Imports, ["ApiStack"]);
    assert.deepEqual((await cloudformation.send(new ListImportsCommand({ ExportName: "StackSimMultiStackTableArn" }))).Imports, ["ApiStack"]);
    assert.equal((await dynamodb.send(new DescribeTableCommand({ TableName: outputs.DataStack.TableName }))).Table?.TableName, outputs.DataStack.TableName);
    const invocation = await fetch(`http://127.0.0.1:${simulator.invokePort}/${outputs.ApiStack.ApiId}/prod/`);
    assert.equal(invocation.status, 200);
    assert.deepEqual(await invocation.json(), { tableName: outputs.DataStack.TableName, tableArn: outputs.DataStack.TableArn });
    await assert.rejects(cloudformation.send(new DeleteStackCommand({ StackName: "DataStack" })), error => /export|import|in use/i.test((error as Error).message));

    const createChangeSets = calls.filter(call => call.command === command && call.service === "cloudformation" && call.action === "CreateChangeSet");
    const executeChangeSets = calls.filter(call => call.command === command && call.service === "cloudformation" && call.action === "ExecuteChangeSet");
    assert.equal(createChangeSets.length, 2);
    assert.equal(executeChangeSets.length, 2);

    command = "destroy-all";
    const destroyed = await runCdk(["--output", join(root, "destroy-all.out"), "destroy", "--all", "--force"], env, cdkCommandTimeoutMs, multiStackFixture);
    assert.equal(destroyed.code, 0, `${destroyed.stdout}\n${destroyed.stderr}\ntrace=${JSON.stringify(calls.filter(call => call.command === command), null, 2)}`);
    assert.equal((await cloudformation.send(new ListStacksCommand({ StackStatusFilter: ["CREATE_COMPLETE", "UPDATE_COMPLETE", "DELETE_IN_PROGRESS", "DELETE_FAILED"] }))).StackSummaries?.length, 0);
    assert.equal((await dynamodb.send(new DescribeTableCommand({ TableName: outputs.DataStack.TableName }))).Table?.TableName, outputs.DataStack.TableName, "RemovalPolicy.RETAIN must preserve the data resource after both stacks are deleted");
    assert.ok(simulator.store.regionState(region).s3Buckets[simulator.store.regionState(region).cloudformation.bootstrap!.bucketName]);
    assertAssignedCalls(calls, "multi-stack lifecycle");
  } finally {
    clients.forEach(client => client.destroy()); await proxy?.close().catch(() => undefined); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});
