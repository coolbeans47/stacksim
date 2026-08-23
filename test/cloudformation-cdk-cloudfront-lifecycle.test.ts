import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import { StackSim } from "../src/server.js";
import { cdkCli } from "./support/project-cli.js";

interface ProcessResult { code: number | null; stdout: string; stderr: string }
interface ViewerResponse { status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "cloudfront-website");
const frontend = join(fixture, "frontend");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const region = "eu-west-1";

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 600_000): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
  });
}

function environment(simulator: StackSim | undefined, root: string, variant: "v1" | "v2"): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete env[key];
  }
  const endpoint = simulator ? `http://127.0.0.1:${simulator.port}` : undefined;
  return {
    ...env,
    AWS_ACCESS_KEY_ID: "admin", AWS_SECRET_ACCESS_KEY: "password", AWS_REGION: region, AWS_DEFAULT_REGION: region,
    ...(endpoint ? { AWS_ENDPOINT_URL: endpoint, STACKSIM_NETWORK_ALLOW_PORT: String(simulator!.port) } : { STACKSIM_NETWORK_ALLOW_PORT: "" }),
    AWS_EC2_METADATA_DISABLED: "true", AWS_MAX_ATTEMPTS: "1",
    AWS_CONFIG_FILE: join(root, "no-aws-config"), AWS_SHARED_CREDENTIALS_FILE: join(root, "no-aws-credentials"),
    CDK_DEFAULT_ACCOUNT: "000000000000", CDK_DEFAULT_REGION: region,
    CDK_DISABLE_CLI_TELEMETRY: "true", CDK_DISABLE_VERSION_CHECK: "true", JSII_AGENT: "stacksim-tests/1",
    CLOUDFRONT_FIXTURE_VARIANT: variant,
    NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

async function buildFrontend(root: string, variant: "v1" | "v2"): Promise<void> {
  const result = await run(process.execPath, ["build.mjs"], frontend, environment(undefined, root, variant));
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
}

async function runCdk(simulator: StackSim, root: string, variant: "v1" | "v2", args: readonly string[]): Promise<ProcessResult> {
  return run(process.execPath, [cdkCli, ...args, "--no-notices", "--no-color"], fixture, environment(simulator, root, variant));
}

async function viewerRequest(simulator: StackSim, path: string, method = "GET", headers: Record<string, string> = {}): Promise<ViewerResponse> {
  const viewer = simulator.cloudfront.listLocalViewers()[0] as { localUrl: string } | undefined;
  assert.ok(viewer, "the deployed distribution has no local viewer endpoint");
  const url = new URL(viewer.localUrl);
  const ca = await readFile(simulator.cloudfront.caCertificatePath!);
  return new Promise((resolvePromise, reject) => {
    const req = httpsRequest({ hostname: "127.0.0.1", port: Number(url.port), path, method, servername: url.hostname, ca, headers: { host: url.host, ...headers } }, response => {
      const body: Buffer[] = [];
      response.on("data", chunk => body.push(Buffer.from(chunk)));
      response.once("end", () => resolvePromise({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(body) }));
    });
    req.once("error", reject); req.end();
  });
}

async function waitForRollback(simulator: StackSim): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const stack = Object.values(simulator.store.regionState(region).cloudformation.stacks).find(candidate => candidate.stackName === "CloudFrontWebsiteStack");
    if (stack?.stackStatus === "UPDATE_ROLLBACK_COMPLETE") return;
    if (stack?.stackStatus === "UPDATE_COMPLETE") throw new Error("the deliberately colliding CloudFront update unexpectedly succeeded");
    if (stack?.stackStatus === "UPDATE_ROLLBACK_FAILED") throw new Error("the deliberately failing CloudFront update could not roll back");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error("timed out waiting for the CloudFront stack rollback");
}

test("CFR-01 ordinary CDK CloudFront website creates, serves, updates, no-ops, rolls back, restarts, destroys, and redeploys", { timeout: 900_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cloudfront-lifecycle-"));
  const dataDir = join(root, "data");
  let simulator: StackSim | undefined;
  const clients: Array<{ destroy(): void }> = [];
  const start = async () => {
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "enforce", cdkBootstrap: true });
    await simulator.start(); return simulator;
  };
  const checkedCdk = async (label: string, variant: "v1" | "v2", args: readonly string[]) => {
    const result = await runCdk(simulator!, root, variant, args);
    assert.equal(result.code, 0, `${label} failed:\n${result.stdout}\n${result.stderr}`);
  };
  try {
    await start(); await buildFrontend(root, "v1");
    const outputsFile = join(root, "outputs.json");
    await checkedCdk("create", "v1", ["--output", join(root, "create.out"), "deploy", "--all", "--require-approval", "never", "--outputs-file", outputsFile]);
    assert.equal(Object.keys(simulator!.store.regionState(region).cloudformation.stacks).length >= 3, true);
    assert.equal(Object.values(simulator!.store.regionState(region).cloudformation.stacks).find(stack => stack.stackName === "CloudFrontWebsiteStack")?.stackStatus, "CREATE_COMPLETE");
    const outputs = JSON.parse(await readFile(outputsFile, "utf8"));
    assert.match(outputs.CloudFrontWebsiteStack.WebUrl, /^https:\/\/d[a-f0-9]+\.cloudfront\.net$/);
    const originalDistribution = simulator!.cloudfront.consoleSnapshot().distributions[0] as any;
    const originalOac = simulator!.cloudfront.consoleSnapshot().originAccessControls[0] as any;
    const originalViewer = simulator!.cloudfront.listLocalViewers()[0] as any;
    assert.equal(outputs.CloudFrontWebsiteStack.WebUrl, `https://${originalDistribution.domainName}`);
    assert.notEqual(originalViewer.localUrl.replace(/\/$/, ""), outputs.CloudFrontWebsiteStack.WebUrl);

    for (const path of ["/", "/shipments/42", "/settings/"]) {
      const response = await viewerRequest(simulator!, path);
      assert.equal(response.status, 200, `${path} did not serve the SPA shell`);
      assert.match(response.body.toString("utf8"), /StackSim CloudFront fixture/);
      assert.equal(response.headers["strict-transport-security"], "max-age=31536000; includeSubDomains; preload");
    }
    const runtime = await viewerRequest(simulator!, "/runtime-config.json");
    assert.equal(runtime.status, 200); assert.equal(JSON.parse(runtime.body.toString("utf8")).apiBaseUrl, "https://fixtureapi01.execute-api.eu-west-1.amazonaws.com/fixture-v1/v1");
    const compressed = await viewerRequest(simulator!, "/assets/app.js", "GET", { "accept-encoding": "br" });
    assert.equal(compressed.status, 200); assert.equal(compressed.headers["content-encoding"], "br"); assert.equal(compressed.headers["x-cache"], "Miss from cloudfront");
    assert.equal((await viewerRequest(simulator!, "/assets/app.js", "GET", { "accept-encoding": "br" })).headers["x-cache"], "Hit from cloudfront");
    const head = await viewerRequest(simulator!, "/assets/app.js", "HEAD"); assert.equal(head.status, 200); assert.equal(head.body.length, 0);
    assert.equal((await viewerRequest(simulator!, "/", "OPTIONS")).status, 403);
    const redirect = await fetch(`http://127.0.0.1:${simulator!.port}/_stacksim/cloudfront/${originalDistribution.id}/shipments/42?source=tooling`, { redirect: "manual" });
    assert.equal(redirect.status, 301); assert.equal(redirect.headers.get("location"), `${originalViewer.localUrl}shipments/42?source=tooling`);

    await buildFrontend(root, "v2");
    const updateOutput = join(root, "update.out");
    await checkedCdk("update", "v2", ["--output", updateOutput, "deploy", "CloudFrontWebsiteStack", "--require-approval", "never"]);
    assert.match((await viewerRequest(simulator!, "/")).body.toString("utf8"), /fixture v2/);
    const revisionBeforeNoOp = simulator!.store.ensureAccount().cloudfront.revision;
    await checkedCdk("no-op", "v2", ["--output", join(root, "noop.out"), "deploy", "CloudFrontWebsiteStack", "--require-approval", "never"]);
    assert.equal(simulator!.store.ensureAccount().cloudfront.revision, revisionBeforeNoOp, "a no-op deployment mutated account-global CloudFront state");

    const collision = await simulator!.cloudfront.createOriginAccessControl({ Name: "cfr01-rollback-collision", Description: "test-only collision", OriginAccessControlOriginType: "s3", SigningBehavior: "always", SigningProtocol: "sigv4" });
    const template = JSON.parse(await readFile(join(updateOutput, "CloudFrontWebsiteStack.template.json"), "utf8"));
    const oac = Object.values<any>(template.Resources).find(resource => resource.Type === "AWS::CloudFront::OriginAccessControl");
    assert.ok(oac); oac.Properties.OriginAccessControlConfig.Name = collision.name;
    const cloudformation = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator!.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 }); clients.push(cloudformation);
    await cloudformation.send(new UpdateStackCommand({ StackName: "CloudFrontWebsiteStack", TemplateBody: JSON.stringify(template), Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"] }));
    await waitForRollback(simulator!);
    assert.equal(simulator!.cloudfront.getOriginAccessControl(originalOac.id).name, originalOac.name, "rollback did not restore the prior OAC configuration");
    assert.equal((await viewerRequest(simulator!, "/")).status, 200, "rollback did not restore a serving deployed generation");
    await simulator!.cloudfront.deleteOriginAccessControl(collision.id, collision.etag);

    const stableViewer = simulator!.cloudfront.listLocalViewers()[0] as any;
    await simulator!.stop(); simulator = undefined; await start();
    assert.equal((simulator!.cloudfront.listLocalViewers()[0] as any).localUrl, stableViewer.localUrl, "restart changed the persisted viewer endpoint");
    assert.equal((await viewerRequest(simulator!, "/assets/app.js")).status, 200);

    await checkedCdk("Web-first destroy", "v2", ["destroy", "CloudFrontWebsiteStack", "--force"]);
    assert.equal(simulator!.cloudfront.consoleSnapshot().distributions.length, 0);
    await checkedCdk("producer destroy", "v2", ["destroy", "FixtureApiExports", "FixtureIdentityExports", "--force"]);
    await checkedCdk("same-name redeploy", "v2", ["--output", join(root, "redeploy.out"), "deploy", "--all", "--require-approval", "never"]);
    assert.equal(simulator!.cloudfront.consoleSnapshot().distributions.length, 1); assert.equal((await viewerRequest(simulator!, "/")).status, 200);
    await checkedCdk("final reverse-order destroy", "v2", ["destroy", "CloudFrontWebsiteStack", "FixtureApiExports", "FixtureIdentityExports", "--force"]);
  } finally {
    for (const client of clients) client.destroy();
    await simulator?.stop().catch(() => undefined);
    await buildFrontend(root, "v1").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("later CloudFront resources and unsupported registered properties reject before stack mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cloudfront-negative-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  let client: CloudFormationClient | undefined;
  try {
    await simulator.start();
    client = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 });
    for (const [stackName, resource] of [
      ["UnsupportedCloudFrontType", { Type: "AWS::CloudFront::CachePolicy", Properties: { CachePolicyConfig: {} } }],
      ["UnsupportedCloudFrontProperty", { Type: "AWS::CloudFront::Distribution", Properties: { DistributionConfig: {}, Aliases: ["example.invalid"] } }],
    ] as const) {
      await assert.rejects(client.send(new CreateStackCommand({ StackName: stackName, TemplateBody: JSON.stringify({ AWSTemplateFormatVersion: "2010-09-09", Resources: { Target: resource } }) })), (error: any) => error.name === "ValidationError");
      assert.equal(Object.keys(simulator.store.regionState(region).cloudformation.stacks).length, 0, `${stackName} mutated the stack catalog`);
    }
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
