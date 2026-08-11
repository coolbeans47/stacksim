import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
} from "@aws-sdk/client-cloudformation";
import {
  GetBucketEncryptionCommand,
  GetBucketLocationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetBucketWebsiteCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { CloudFormationCheckpointObservation } from "../src/cloudformation.js";
import { semanticCdkAssemblyDigests, sha256 } from "./support/artifact-snapshots.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";
import { cdkCli } from "./support/project-cli.js";

interface ProcessResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface AwsCall { command: string; method: string; path: string; service: string; action: string }

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "react-bucket-deployment");
const frontend = join(fixture, "frontend");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const region = "eu-west-1";

function signingService(authorization: string | undefined): string {
  return authorization?.match(/Credential=[^,\s]+\/\d{8}\/[^/]+\/([^/]+)\/aws4_request/)?.[1] ?? "unknown";
}

function awsAction(service: string, body: Buffer, target: string | undefined, method: string, path: string): string {
  if (target) return target.slice(target.lastIndexOf(".") + 1);
  if (service === "s3") return `${method}ObjectOrBucket`;
  try { return new URLSearchParams(body.toString("utf8")).get("Action") ?? "unknown"; }
  catch { return path; }
}

async function tracingProxy(upstreamPort: number, calls: AwsCall[], currentCommand: () => string) {
  const proxy = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const service = signingService(incoming.headers.authorization);
    calls.push({ command: currentCommand(), method: incoming.method ?? "GET", path: incoming.url ?? "/", service, action: awsAction(service, body, incoming.headers["x-amz-target"]?.toString(), incoming.method ?? "GET", incoming.url ?? "/") });
    const forwarded = request({ host: "127.0.0.1", port: upstreamPort, method: incoming.method, path: incoming.url, headers: incoming.headers }, response => {
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

function cdkEnvironment(endpoint: string | undefined, tempRoot: string, variant = "v1"): NodeJS.ProcessEnv {
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
    ...(endpoint ? { AWS_ENDPOINT_URL: endpoint, STACKSIM_NETWORK_ALLOW_PORT: new URL(endpoint).port } : { STACKSIM_NETWORK_ALLOW_PORT: "" }),
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_CONFIG_FILE: join(tempRoot, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(tempRoot, "no-aws-credentials"),
    CDK_DEFAULT_ACCOUNT: "000000000000",
    CDK_DEFAULT_REGION: region,
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    JSII_AGENT: "stacksim-tests/1", // Keep CDK metadata hashes independent of the host Node.js version.
    REACT_FIXTURE_VARIANT: variant,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

async function runProcess(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 180_000): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

async function buildFrontend(env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runProcess(process.execPath, ["build.mjs"], frontend, env);
  assert.equal(result.code, 0, `React fixture build failed:\n${result.stdout}\n${result.stderr}`);
}

function runCdk(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 240_000): Promise<ProcessResult> {
  return runProcess(process.execPath, [cdkCli, ...args, "--no-notices", "--no-color"], fixture, env, timeoutMs);
}

async function objectBytes(s3: S3Client, bucket: string, key: string): Promise<{ bytes: Buffer; contentType?: string; metadata?: Record<string, string> }> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return { bytes: Buffer.from(await result.Body!.transformToByteArray()), contentType: result.ContentType, metadata: result.Metadata };
}

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolvePromise, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", () => resolvePromise()); });
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolvePromise, reject) => listener.close(error => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function waitForChangeSet(cloudformation: CloudFormationClient, stackName: string, changeSetName: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await cloudformation.send(new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }));
    if (value.Status === "CREATE_COMPLETE" && value.ExecutionStatus === "AVAILABLE") return;
    if (value.Status === "FAILED") throw new Error(`Change set ${changeSetName} failed: ${value.StatusReason}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for change set ${changeSetName}`);
}

async function waitForStackStatus(cloudformation: CloudFormationClient, stackName: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const status = (await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus;
    if (status === expected) return;
    if (status?.endsWith("_FAILED") || status?.endsWith("ROLLBACK_FAILED")) throw new Error(`Stack ${stackName} entered ${status} while waiting for ${expected}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for stack ${stackName} to enter ${expected}`);
}

async function checkpointBeforeCdkExit(checkpoint: Promise<CloudFormationCheckpointObservation>, command: Promise<ProcessResult>, label: string): Promise<CloudFormationCheckpointObservation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      checkpoint,
      command.then(result => { throw new Error(`CDK exited before ${label}: code=${result.code}\n${result.stdout}\n${result.stderr}`); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 120_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

test("pinned standard CDK synthesizes the exact public React S3 website assembly", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-react-synth-"));
  try {
    const env = cdkEnvironment(undefined, root, "v1");
    await buildFrontend(env);
    const output = join(root, "cdk.out");
    const result = await runCdk(["--output", output, "synth", "ReactBucketStack"], env);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const lock = JSON.parse(await readFile(join(fixture, "expected-assembly.json"), "utf8"));
    const names = Object.keys(lock.files) as string[];
    const hashes = await semanticCdkAssemblyDigests(output, ["ReactBucketStack.template.json"], names.filter(name => name !== "ReactBucketStack.template.json"));
    assert.deepEqual(hashes, lock.files, "the pinned CDK 2.1132.0/aws-cdk-lib 2.261.0 React semantic assembly drifted");
    const assemblyDigest = sha256(names.map(name => hashes[name]).join("\n"));
    assert.equal(assemblyDigest, lock.assemblySha256);
    const template = JSON.parse(await readFile(join(output, "ReactBucketStack.template.json"), "utf8"));
    assert.deepEqual(Object.entries<any>(template.Resources).map(([logicalId, resource]) => [logicalId, resource.Type]), lock.resources);
    assert.deepEqual(Object.keys(template.Outputs), lock.outputs);
    const bucket = template.Resources.FrontendBucketEFE2E19C;
    assert.deepEqual(bucket.Properties.WebsiteConfiguration, { IndexDocument: "index.html" });
    assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, { BlockPublicAcls: true, IgnorePublicAcls: true });
    assert.equal(bucket.DeletionPolicy, "Retain");
    assert.equal(template.Resources.FrontendBucketPolicy1DFF75D9.Properties.PolicyDocument.Statement[0].Principal.AWS, "*");
    const deployment = template.Resources.DeployFrontendCustomResource3E02C3B7;
    assert.equal(deployment.Properties.Prune, true);
    assert.deepEqual(deployment.Properties.SourceObjectKeys, [lock.assets.reactBuildV1 + ".zip"]);
    assert.equal(template.Resources.CustomCDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C81C01536.Properties.Runtime, "python3.13");
  } finally {
    await buildFrontend(cdkEnvironment(undefined, root, "v1")).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("unmodified standard CDK deploys, updates, prunes, deduplicates, serves, retains, and never contacts AWS", { timeout: 900_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-react-deploy-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "enforce", cdkBootstrap: true });
  let proxy: Awaited<ReturnType<typeof tracingProxy>> | undefined;
  const calls: AwsCall[] = [];
  let command = "startup";
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    proxy = await tracingProxy(simulator.port, calls, () => command);
    let env = cdkEnvironment(proxy.endpoint, root, "v1");
    await buildFrontend(env);
    const expectedV1 = Object.fromEntries(await Promise.all(["index.html", "assets/app.js", "assets/app.css", "build.txt", "obsolete.txt"].map(async key => [key, await readFile(join(frontend, "dist", ...key.split("/")))])));

    command = "diff";
    const diff = await runCdk(["--output", join(root, "diff.out"), "diff", "ReactBucketStack", "--method", "template"], env);
    assert.equal(diff.code, 0, `${diff.stdout}\n${diff.stderr}`);

    command = "deploy-v1";
    const outputsFile = join(root, "outputs-v1.json");
    const deployed = await runCdk(["--output", join(root, "deploy-v1.out"), "deploy", "ReactBucketStack", "--require-approval", "never", "--outputs-file", outputsFile], env, 480_000);
    assert.equal(deployed.code, 0, `${deployed.stdout}\n${deployed.stderr}`);
    const outputs = (JSON.parse(await readFile(outputsFile, "utf8"))).ReactBucketStack as Record<string, string>;
    const bucket = outputs.FrontendBucketName;
    assert.ok(bucket);
    const clientOptions = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 3 };
    const s3 = new S3Client({ ...clientOptions, forcePathStyle: true }); clients.push(s3);
    const cloudformation = new CloudFormationClient(clientOptions); clients.push(cloudformation);
    assert.equal((await cloudformation.send(new DescribeStacksCommand({ StackName: "ReactBucketStack" }))).Stacks?.[0]?.StackStatus, "CREATE_COMPLETE");
    assert.match(outputs.FrontendWebsiteUrl, new RegExp(`/_stacksim/s3-website/${bucket}/?$`));
    assert.equal((await s3.send(new GetBucketLocationCommand({ Bucket: bucket }))).LocationConstraint, region);
    assert.equal((await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }))).Status, "Enabled");
    assert.deepEqual((await s3.send(new GetBucketEncryptionCommand({ Bucket: bucket }))).ServerSideEncryptionConfiguration?.Rules, [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" }, BucketKeyEnabled: false }]);
    assert.deepEqual((await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }))).PublicAccessBlockConfiguration, { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false });
    assert.deepEqual((await s3.send(new GetBucketWebsiteCommand({ Bucket: bucket }))).IndexDocument, { Suffix: "index.html" });
    const publicPolicy = JSON.parse((await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }))).Policy!);
    assert.ok(publicPolicy.Statement.some((statement: any) => statement.Effect === "Allow" && statement.Principal?.AWS === "*" && statement.Action === "s3:GetObject"));

    for (const [key, expected] of Object.entries(expectedV1)) {
      const actual = await objectBytes(s3, bucket, key);
      assert.deepEqual(actual.bytes, expected, `${key} bytes drifted during deployment`);
      assert.deepEqual(actual.metadata ?? {}, {});
    }
    assert.equal((await objectBytes(s3, bucket, "index.html")).contentType, "text/html");
    assert.equal((await objectBytes(s3, bucket, "assets/app.js")).contentType, "application/javascript");
    assert.equal((await objectBytes(s3, bucket, "assets/app.css")).contentType, "text/css");
    const website = await fetch(outputs.FrontendWebsiteUrl);
    assert.equal(website.status, 200);
    assert.deepEqual(Buffer.from(await website.arrayBuffer()), expectedV1["index.html"]);
    const websiteJs = await fetch(new URL("assets/app.js", outputs.FrontendWebsiteUrl));
    const websiteCss = await fetch(new URL("assets/app.css", outputs.FrontendWebsiteUrl));
    assert.equal(websiteJs.headers.get("content-type"), "application/javascript");
    assert.equal(websiteCss.headers.get("content-type"), "text/css");
    assert.deepEqual(Buffer.from(await websiteJs.arrayBuffer()), expectedV1["assets/app.js"]);
    assert.deepEqual(Buffer.from(await websiteCss.arrayBuffer()), expectedV1["assets/app.css"]);

    const versionsBefore = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }));
    command = "deploy-identical";
    const identical = await runCdk(["--output", join(root, "deploy-identical.out"), "deploy", "ReactBucketStack", "--require-approval", "never"], env, 360_000);
    assert.equal(identical.code, 0, `${identical.stdout}\n${identical.stderr}`);
    const versionsAfter = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }));
    assert.equal(versionsAfter.Versions?.length, versionsBefore.Versions?.length, "identical deployment created application object versions");
    assert.equal(versionsAfter.DeleteMarkers?.length ?? 0, versionsBefore.DeleteMarkers?.length ?? 0, "identical deployment created delete markers");

    env = cdkEnvironment(proxy.endpoint, root, "v2");
    await buildFrontend(env);
    const expectedV2 = Object.fromEntries(await Promise.all(["index.html", "assets/app.js", "assets/app.css", "build.txt"].map(async key => [key, await readFile(join(frontend, "dist", ...key.split("/")))])));

    command = "synth-unsafe-update";
    const unsafeAssembly = join(root, "unsafe-update.out");
    const unsafeSynth = await runCdk(["--output", unsafeAssembly, "synth", "ReactBucketStack"], env);
    assert.equal(unsafeSynth.code, 0, `${unsafeSynth.stdout}\n${unsafeSynth.stderr}`);
    const unsafeTemplate = JSON.parse(await readFile(join(unsafeAssembly, "ReactBucketStack.template.json"), "utf8"));
    const unsafeDeployment = Object.values<any>(unsafeTemplate.Resources).find(resource => resource.Type === "Custom::CDKBucketDeployment");
    assert.ok(unsafeDeployment);
    const unsafeKey = `${"f".repeat(64)}.zip`;
    unsafeDeployment.Properties.SourceObjectKeys = [unsafeKey];
    const bootstrapForFailure = simulator.store.regionState(region).cloudformation.bootstrap!;
    await s3.send(new PutObjectCommand({ Bucket: bootstrapForFailure.bucketName, Key: unsafeKey, Body: createZip([{ name: "../escape.txt", content: "must-never-deploy" }]) }));
    const beforeUnsafe = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }));
    command = "unsafe-update";
    await cloudformation.send(new CreateChangeSetCommand({
      StackName: "ReactBucketStack",
      ChangeSetName: "unsafe-react-asset",
      ChangeSetType: "UPDATE",
      TemplateBody: JSON.stringify(unsafeTemplate),
      Capabilities: ["CAPABILITY_NAMED_IAM"],
    }));
    await waitForChangeSet(cloudformation, "ReactBucketStack", "unsafe-react-asset");
    await cloudformation.send(new ExecuteChangeSetCommand({ StackName: "ReactBucketStack", ChangeSetName: "unsafe-react-asset", ClientRequestToken: "unsafe-react-asset-execution" }));
    await waitForStackStatus(cloudformation, "ReactBucketStack", "UPDATE_ROLLBACK_COMPLETE");
    const afterUnsafe = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }));
    assert.deepEqual(afterUnsafe.Versions?.map(value => [value.Key, value.VersionId, value.IsLatest]), beforeUnsafe.Versions?.map(value => [value.Key, value.VersionId, value.IsLatest]), "unsafe asset update or rollback changed application object versions");
    assert.deepEqual(afterUnsafe.DeleteMarkers?.map(value => [value.Key, value.VersionId, value.IsLatest]), beforeUnsafe.DeleteMarkers?.map(value => [value.Key, value.VersionId, value.IsLatest]), "unsafe asset update or rollback created application delete markers");
    const unsafeEvents = (await cloudformation.send(new DescribeStackEventsCommand({ StackName: "ReactBucketStack" }))).StackEvents?.filter(event => event.ClientRequestToken === "unsafe-react-asset-execution") ?? [];
    assert.ok(unsafeEvents.some(event => event.ResourceType === "Custom::CDKBucketDeployment" && event.ResourceStatus === "UPDATE_FAILED"), "unsafe helper update did not publish a failed custom-resource event");
    assert.ok(unsafeEvents.some(event => event.ResourceType === "Custom::CDKBucketDeployment" && event.ResourceStatus === "UPDATE_ROLLBACK_COMPLETE"), "unsafe helper update did not roll back the custom resource");
    assert.equal(unsafeEvents.some(event => event.ResourceType === "Custom::CDKBucketDeployment" && event.ResourceStatus === "UPDATE_COMPLETE"), false, "unsafe helper update reported false success");
    const diagnostics = JSON.stringify(unsafeEvents);
    assert.doesNotMatch(diagnostics, /must-never-deploy|escape\.txt|AWS_SECRET_ACCESS_KEY|no-aws-credentials/i);
    assert.doesNotMatch(diagnostics, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

    command = "deploy-v2";
    const updated = await runCdk(["--output", join(root, "deploy-v2.out"), "deploy", "ReactBucketStack", "--require-approval", "never"], env, 480_000);
    assert.equal(updated.code, 0, `${updated.stdout}\n${updated.stderr}`);
    for (const [key, expected] of Object.entries(expectedV2)) assert.deepEqual((await objectBytes(s3, bucket, key)).bytes, expected, `${key} was not updated to v2`);
    assert.notDeepEqual(expectedV2["assets/app.js"], expectedV1["assets/app.js"]);
    await assert.rejects(s3.send(new GetObjectCommand({ Bucket: bucket, Key: "obsolete.txt" })), (error: any) => error instanceof NoSuchKey || error.name === "NoSuchKey");
    const versionsV2 = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }));
    const countVersions = (key: string, values = versionsV2) => values.Versions?.filter(version => version.Key === key).length ?? 0;
    assert.equal(countVersions("index.html"), versionsBefore.Versions?.filter(version => version.Key === "index.html").length, "unchanged HTML was recopied");
    assert.equal(countVersions("assets/app.css"), versionsBefore.Versions?.filter(version => version.Key === "assets/app.css").length, "unchanged CSS was recopied");
    assert.equal(countVersions("assets/app.js"), (versionsBefore.Versions?.filter(version => version.Key === "assets/app.js").length ?? 0) + 1, "changed JavaScript did not create exactly one new version");
    assert.equal(countVersions("build.txt"), (versionsBefore.Versions?.filter(version => version.Key === "build.txt").length ?? 0) + 1, "changed build marker did not create exactly one new version");
    assert.equal(versionsV2.DeleteMarkers?.filter(marker => marker.Key === "obsolete.txt").length, 1, "prune did not create exactly one delete marker");

    const bootstrap = simulator.store.regionState(region).cloudformation.bootstrap!;
    const bootstrapBeforeDestroy = await s3.send(new ListObjectsV2Command({ Bucket: bootstrap.bucketName }));
    assert.ok((bootstrapBeforeDestroy.Contents?.length ?? 0) >= 4);
    command = "destroy";
    const destroyed = await runCdk(["destroy", "ReactBucketStack", "--force"], env, 480_000);
    assert.equal(destroyed.code, 0, `${destroyed.stdout}\n${destroyed.stderr}`);
    const retained = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    assert.deepEqual((retained.Contents ?? []).map(item => item.Key).sort(), Object.keys(expectedV2).sort());
    assert.deepEqual((await objectBytes(s3, bucket, "index.html")).bytes, expectedV2["index.html"]);
    const bootstrapAfterDestroy = await s3.send(new ListObjectsV2Command({ Bucket: bootstrap.bucketName }));
    assert.deepEqual((bootstrapAfterDestroy.Contents ?? []).map(item => item.Key).sort(), (bootstrapBeforeDestroy.Contents ?? []).map(item => item.Key).sort(), "application destruction removed bootstrap assets");
    assert.ok(calls.some(call => call.command === "deploy-v1" && call.service === "cloudformation" && call.action === "CreateChangeSet"), "default cdk deploy did not use a change set");
    assert.ok(calls.some(call => call.command === "deploy-v1" && call.service === "cloudformation" && call.action === "ExecuteChangeSet"), "default cdk deploy did not execute its change set");
    assert.equal(calls.some(call => call.service === "unknown"), false, `a CDK subprocess made an unsigned or unassigned request: ${JSON.stringify(calls.filter(call => call.service === "unknown"), null, 2)}`);
  } finally {
    clients.forEach(client => client.destroy());
    await proxy?.close().catch(() => undefined);
    await simulator.stop().catch(() => undefined);
    await buildFrontend(cdkEnvironment(undefined, root, "v1")).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("standard CDK deployment resumes after asset, bucket, helper-invocation, and object-copy restarts", { timeout: 900_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-react-recovery-"));
  const dataDir = join(root, "data");
  const port = await freePort();
  let invokePort = await freePort();
  while (invokePort === port) invokePort = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  let simulator: StackSim | undefined;
  let proxy: Awaited<ReturnType<typeof tracingProxy>> | undefined;
  let verificationS3: S3Client | undefined;
  const calls: AwsCall[] = [];
  let command = "startup";
  let armed: { label: string; matches: (observation: CloudFormationCheckpointObservation) => boolean; resolve: (observation: CloudFormationCheckpointObservation) => void } | undefined;
  const interceptor = (observation: CloudFormationCheckpointObservation): boolean => {
    if (!armed || !armed.matches(observation)) return false;
    const selected = armed; armed = undefined; selected.resolve(observation); return true;
  };
  const arm = (label: string, matches: (observation: CloudFormationCheckpointObservation) => boolean) => new Promise<CloudFormationCheckpointObservation>(resolvePromise => {
    assert.equal(armed, undefined, "only one React recovery checkpoint may be armed");
    armed = { label, matches, resolve: resolvePromise };
  });
  const start = async () => {
    const next = new StackSim({ port, invokePort, cloudFormationCustomResourceCallbackPort: 0, dataDir, region, authMode: "enforce", cdkBootstrap: true });
    next.cloudformation.setCheckpointInterceptorForTest(interceptor);
    await next.start(); simulator = next; return next;
  };
  const restart = async () => { await simulator?.stop(); simulator = undefined; return start(); };
  try {
    await start();
    proxy = await tracingProxy(port, calls, () => command);
    const env = cdkEnvironment(proxy.endpoint, root, "v1");
    await buildFrontend(env);
    const expectedRecovery = Object.fromEntries(await Promise.all(["index.html", "assets/app.js", "assets/app.css"].map(async key => [key, await readFile(join(frontend, "dist", ...key.split("/")))])));
    const assemblyLock = JSON.parse(await readFile(join(fixture, "expected-assembly.json"), "utf8"));
    const assembly = join(root, "prepared.out");
    command = "prepare";
    const prepared = await runCdk(["--output", assembly, "deploy", "ReactBucketStack", "--method", "prepare-change-set", "--change-set-name", "react-recovery", "--require-approval", "never"], env, 480_000);
    assert.equal(prepared.code, 0, `${prepared.stdout}\n${prepared.stderr}`);
    const bootstrap = simulator!.store.regionState(region).cloudformation.bootstrap!;
    assert.ok((await simulator!.s3.listCurrentObjectsInternal(bootstrap.bucketName)).length >= 4, "prepare-change-set did not durably publish all standard CDK assets");
    const reactAssetKey = `${assemblyLock.assets.reactBuildV1}.zip`;
    const overwriteClient = new S3Client({ endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, forcePathStyle: true, maxAttempts: 1 });
    try { await overwriteClient.send(new PutObjectCommand({ Bucket: bootstrap.bucketName, Key: reactAssetKey, Body: Buffer.from("superseding corrupt archive") })); }
    finally { overwriteClient.destroy(); }
    assert.deepEqual((await simulator!.s3.readObjectBytes(bootstrap.bucketName, reactAssetKey)).body, Buffer.from("superseding corrupt archive"), "test setup did not overwrite the current bootstrap object version");

    // The available change set and all immutable assets survive a complete
    // service restart before CloudFormation starts mutating application state.
    // A later version at the same key cannot replace the version and digest
    // accepted into the change set.
    await restart();
    const bucketPause = arm("application bucket create", observation => observation.operationKind === "CREATE" && observation.resourceType === "AWS::S3::Bucket" && observation.checkpoint.endsWith(":create-complete"));
    command = "execute";
    const executing = runCdk(["deploy", "ReactBucketStack", "--method", "execute-change-set", "--change-set-name", "react-recovery", "--require-approval", "never"], env, 600_000);
    await checkpointBeforeCdkExit(bucketPause, executing, "application bucket create");
    const stack = Object.values(simulator!.store.regionState(region).cloudformation.stacks).find(value => value.stackName === "ReactBucketStack")!;
    const bucketResource = Object.values(stack.resources).find(value => value.resourceType === "AWS::S3::Bucket");
    assert.ok(bucketResource?.physicalResourceId && simulator!.store.regionState(region).s3Buckets[bucketResource.physicalResourceId]);

    const invocationPause = arm("BucketDeployment source pin", observation => observation.resourceType === "Custom::CDKBucketDeployment" && /:create:attempt-1$/.test(observation.checkpoint));
    await restart();
    await checkpointBeforeCdkExit(invocationPause, executing, "BucketDeployment source pin");
    assert.equal((await simulator!.s3.listCurrentObjectsInternal(bucketResource!.physicalResourceId!)).length, 0, "helper invocation mutated the destination before archive validation and source pinning completed");

    const copyPause = arm("first deployed object copy", observation => observation.resourceType === "Custom::CDKBucketDeployment" && /:create:attempt-2$/.test(observation.checkpoint));
    await restart();
    await checkpointBeforeCdkExit(copyPause, executing, "first deployed object copy");
    assert.equal((await simulator!.s3.listCurrentObjectsInternal(bucketResource!.physicalResourceId!)).length, 1, "the copy checkpoint must follow exactly one durable object mutation");

    await restart();
    const completed = await executing;
    assert.equal(completed.code, 0, `${completed.stdout}\n${completed.stderr}`);
    const finalStack = Object.values(simulator!.store.regionState(region).cloudformation.stacks).find(value => value.stackName === "ReactBucketStack")!;
    assert.equal(finalStack.stackStatus, "CREATE_COMPLETE");
    assert.equal((await simulator!.s3.listCurrentObjectsInternal(bucketResource!.physicalResourceId!)).length, 5);
    verificationS3 = new S3Client({ endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, forcePathStyle: true, maxAttempts: 1 });
    for (const [key, expected] of Object.entries(expectedRecovery)) assert.deepEqual((await objectBytes(verificationS3, bucketResource!.physicalResourceId!, key)).bytes, expected, `${key} did not survive recovery with exact accepted bytes`);
    const recoveredWebsite = `http://127.0.0.1:${port}/_stacksim/s3-website/${bucketResource!.physicalResourceId!}/`;
    for (const [key, expected] of Object.entries(expectedRecovery)) {
      const response = await fetch(new URL(key, recoveredWebsite));
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, `${key} was not anonymously readable after recovery`);
    }
    assert.equal(Object.values(simulator!.store.regionState(region).s3Buckets).filter(bucket => bucket.name === bucketResource!.physicalResourceId).length, 1, "recovery duplicated the application bucket");
    assert.equal(Object.keys(simulator!.store.regionState(region).functions).length, 1, "recovery duplicated the helper Lambda");
    assert.equal(Object.values(simulator!.store.regionState(region).lambdaLayers).flatMap(layer => Object.values(layer.versions)).filter(version => !version.deleted).length, 1, "recovery duplicated the helper layer");
  } finally {
    armed = undefined;
    verificationS3?.destroy();
    await proxy?.close().catch(() => undefined);
    await simulator?.stop().catch(() => undefined);
    await buildFrontend(cdkEnvironment(undefined, root, "v1")).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
