import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CloudFormationClient,
  CreateStackCommand,
} from "@aws-sdk/client-cloudformation";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import {
  CDK_BOOTSTRAP_COMPATIBILITY_VERSION,
  CDK_BOOTSTRAP_POLICY_NAME,
  CDK_BOOTSTRAP_VERSION_PARAMETER,
  cdkBootstrapNames,
} from "../src/cloudformation/bootstrap.js";
import { StackSim } from "../src/server.js";
import type { PolicyDocument } from "../src/types.js";
import { semanticCdkAssemblyDigests } from "./support/artifact-snapshots.js";

interface CdkResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface TracedCall {
  command: string;
  service: string;
  action: string;
  accessKeyId: string;
  region: string;
  host: string;
  method: string;
  path: string;
  roleArn?: string;
}

const sourceRoot = process.cwd();
const fixture = join(sourceRoot, "test", "fixtures", "cdk", "cfn04-negative");
const tripwire = join(sourceRoot, "test", "fixtures", "cdk", "network-tripwire.cjs");
const cdkCli = join(sourceRoot, "node_modules", "cdk", "bin", "cdk");
const accountId = "000000000000";
const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function signingScope(authorization: string | undefined): { accessKeyId: string; region: string; service: string } {
  const match = authorization?.match(/Credential=([^/,\s]+)\/\d{8}\/([^/]+)\/([^/]+)\/aws4_request/);
  return { accessKeyId: match?.[1] ?? "unknown", region: match?.[2] ?? "unknown", service: match?.[3] ?? "unknown" };
}

function tracedAction(service: string, target: string | undefined, body: Buffer, method: string): { action: string; roleArn?: string } {
  if (target) return { action: target.slice(target.lastIndexOf(".") + 1) };
  if (service === "s3") return { action: `${method}ObjectOrBucket` };
  const query = new URLSearchParams(body.toString("utf8"));
  return { action: query.get("Action") ?? "unknown", ...(query.get("RoleArn") ? { roleArn: query.get("RoleArn")! } : {}) };
}

async function tracingProxy(upstreamPort: number, calls: TracedCall[], currentCommand: () => string) {
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const scope = signingScope(incoming.headers.authorization);
    const action = tracedAction(scope.service, incoming.headers["x-amz-target"]?.toString(), body, incoming.method ?? "GET");
    calls.push({
      command: currentCommand(),
      service: scope.service,
      action: action.action,
      accessKeyId: scope.accessKeyId,
      region: scope.region,
      host: incoming.headers.host ?? "unknown",
      method: incoming.method ?? "GET",
      path: incoming.url ?? "/",
      ...(action.roleArn ? { roleArn: action.roleArn } : {}),
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
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolvePromise(); });
  });
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise())),
  };
}

function cdkEnvironment(endpoint: string, root: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_") || ["AWS_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)) delete env[key];
  }
  return {
    ...env,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_ENDPOINT_URL: endpoint,
    STACKSIM_NETWORK_ALLOW_PORT: new URL(endpoint).port,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_CONFIG_FILE: join(root, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(root, "no-aws-credentials"),
    CDK_DEFAULT_ACCOUNT: accountId,
    CDK_DEFAULT_REGION: region,
    CDK_DISABLE_CLI_TELEMETRY: "true",
    CDK_DISABLE_VERSION_CHECK: "true",
    JSII_AGENT: "stacksim-tests/1", // Keep CDK metadata hashes independent of the host Node.js version.
    CDK_DOCKER: join(root, "docker-must-not-run"),
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${tripwire}`.trim(),
  };
}

async function runCdk(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 90_000): Promise<CdkResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cdkCli, ...args, "--no-notices", "--no-color"], {
      cwd: fixture,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
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

function activeStacks(simulator: StackSim): Array<{ region: string; name: string; status: string }> {
  return Object.entries(simulator.store.ensureAccount().regions).flatMap(([candidateRegion, state]) => Object.values(state.cloudformation.stacks)
    .filter(stack => stack.stackStatus !== "DELETE_COMPLETE")
    .map(stack => ({ region: candidateRegion, name: stack.stackName, status: stack.stackStatus })));
}

function assertNoStackMutation(simulator: StackSim, label: string): void {
  assert.deepEqual(activeStacks(simulator), [], `${label} partially mutated the CloudFormation stack catalog`);
}

function assertLocalCalls(calls: readonly TracedCall[], endpoint: string): void {
  const expectedHost = new URL(endpoint).host;
  assert.ok(calls.length > 0, "the standard CDK command did not reach the configured endpoint");
  assert.ok(calls.every(call => call.host === expectedHost), `a CDK request bypassed the local trace endpoint: ${JSON.stringify(calls, null, 2)}`);
}

const wrongTrust = (): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
});

test("pinned CFN-04 fixture variants freeze their complete standard-CDK assembly corpus", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn04-synth-corpus-"));
  const expected = {
    baseline: { template: "920235a5c5692d680345dba59113ec9e6caacc9ff67573f39a8e2d609ed12a2c", manifest: "277183a0c3c87a0fe399d367e5753462b9d83fd89b6d9e9c008bbce23e355357", assets: "83f52d53c75f58b292b2bdeddcd9680064d95cf7e2650ec473718a20eeaf752a", resources: { "AWS::CDK::Metadata": 1 }, files: 1, images: 0 },
    file: { template: "f396197a337effd0b31ef09d292a3ecf8d41315182f4c17105f1e391e1abcf21", manifest: "de69831c91773ae721b3e44bb99d09c12bbe7e8bb1796b76f1627501404efd88", assets: "6cb93060b7991e58e5d8294d0c75b49dec7fec56711cfcf6f660c33e381c0184", resources: { "AWS::CDK::Metadata": 1 }, files: 2, images: 0 },
    image: { template: "56777a47d035fefa23df693a530e82f4dc645baa6e87e050cdd48338b6c43070", manifest: "c024fbf353acf19bf3f4f14d1ae4ad1fe9112516334bbcd87154acf9fcc21e4b", assets: "b6facad5c91f186e9d70256f00266ec3ea5bf031bee72e1980f3213e44495cb4", resources: { "AWS::CDK::Metadata": 1 }, files: 1, images: 1 },
    "lambda-gate": { template: "fca7d1a83953ba5d205a64dec967f81dbe53b5ffbf2a2fcf66eb4d6099606f47", manifest: "b0b78a949173cc6b1eb81c59c2161ea70a0c80826b887256bf149c90ae385f7c", assets: "2a9adff4127f80c289d958ae18fd9fbc94ef8eda21536bf9c349431edcacd7eb", resources: { "AWS::CDK::Metadata": 1, "AWS::Lambda::Function": 1 }, files: 2, images: 0 },
  } as const;
  try {
    for (const [variant, frozen] of Object.entries(expected)) {
      const output = join(root, variant);
      const env = { ...cdkEnvironment("http://127.0.0.1:1", root), ...(variant === "baseline" ? {} : { CDK_TEST_ASSET_KIND: variant }) };
      const synthesized = await runCdk(["--output", output, "synth", "Cfn04NegativeStack"], env);
      assert.equal(synthesized.code, 0, `${variant}\n${synthesized.stdout}\n${synthesized.stderr}`);
      const templateBytes = await readFile(join(output, "Cfn04NegativeStack.template.json"));
      const assetBytes = await readFile(join(output, "Cfn04NegativeStack.assets.json"));
      const digests = await semanticCdkAssemblyDigests(output, ["Cfn04NegativeStack.template.json"], ["Cfn04NegativeStack.assets.json", "manifest.json"]);
      assert.deepEqual({
        template: digests["Cfn04NegativeStack.template.json"],
        manifest: digests["manifest.json"],
        assets: digests["Cfn04NegativeStack.assets.json"],
      }, { template: frozen.template, manifest: frozen.manifest, assets: frozen.assets }, `${variant} assembly drifted`);
      const template = JSON.parse(templateBytes.toString("utf8")) as { Resources: Record<string, { Type: string }> };
      const resources = Object.fromEntries(Object.entries(Object.values(template.Resources).reduce<Record<string, number>>((counts, resource) => ({ ...counts, [resource.Type]: (counts[resource.Type] ?? 0) + 1 }), {})).sort(([left], [right]) => left.localeCompare(right)));
      assert.deepEqual(resources, frozen.resources);
      const assetManifest = JSON.parse(assetBytes.toString("utf8")) as { files?: Record<string, unknown>; dockerImages?: Record<string, unknown> };
      assert.equal(Object.keys(assetManifest.files ?? {}).length, frozen.files);
      assert.equal(Object.keys(assetManifest.dockerImages ?? {}).length, frozen.images);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pinned standard CDK rejects changed qualifier, account, and Region environments before stack mutation", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn04-environment-negative-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "enforce", cdkBootstrap: true });
  const calls: TracedCall[] = [];
  let command = "startup";
  let proxy: Awaited<ReturnType<typeof tracingProxy>> | undefined;
  try {
    await simulator.start();
    proxy = await tracingProxy(simulator.port, calls, () => command);
    const base = cdkEnvironment(proxy.endpoint, root);
    const cases: Array<{ label: string; env: NodeJS.ProcessEnv; diagnostic: RegExp }> = [
      { label: "changed-qualifier", env: { ...base, CDK_TEST_QUALIFIER: "localtest1" }, diagnostic: /localtest1|qualifier|bootstrap|assume role|bucket/i },
      { label: "account-mismatch", env: { ...base, CDK_TEST_STACK_ACCOUNT: "111111111111" }, diagnostic: /111111111111|account|credentials|assume role/i },
      { label: "region-mismatch", env: { ...base, CDK_TEST_STACK_REGION: "us-east-1" }, diagnostic: /us-east-1|Region|bootstrap|assume role|bucket/i },
    ];
    for (const item of cases) {
      command = item.label;
      const before = calls.length;
      const result = await runCdk(["--output", join(root, `${item.label}.out`), "deploy", "Cfn04NegativeStack", "--method", "direct", "--require-approval", "never"], item.env);
      assert.notEqual(result.code, 0, `${item.label} unexpectedly deployed`);
      assert.match(`${result.stdout}\n${result.stderr}`, item.diagnostic, `${item.label} did not return a clear environment diagnostic`);
      assertNoStackMutation(simulator, item.label);
      assertLocalCalls(calls.slice(before), proxy.endpoint);
    }
    assert.equal(simulator.store.regionState("us-east-1").cloudformation.bootstrap, undefined, "a mismatched signed Region must not auto-materialize another reduced bootstrap");
    const wrongRegionNames = cdkBootstrapNames(accountId, "us-east-1");
    assert.equal(simulator.store.ensureAccount().iam.roles[wrongRegionNames.roleNames.deploy], undefined);
    assert.equal(simulator.store.regionState("us-east-1").s3Buckets[wrongRegionNames.bucketName], undefined);
  } finally {
    await proxy?.close().catch(() => undefined);
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("pinned standard CDK assumes the image role and rejects Docker assets at the first local ECR request", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn04-image-negative-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "enforce", cdkBootstrap: true });
  const calls: TracedCall[] = [];
  let command = "image-asset";
  let proxy: Awaited<ReturnType<typeof tracingProxy>> | undefined;
  try {
    await simulator.start();
    proxy = await tracingProxy(simulator.port, calls, () => command);
    const env = { ...cdkEnvironment(proxy.endpoint, root), CDK_TEST_ASSET_KIND: "image" };
    const result = await runCdk(["--output", join(root, "image.out"), "deploy", "Cfn04NegativeStack", "--method", "direct", "--require-approval", "never"], env);
    assert.notEqual(result.code, 0, "the reduced file-asset contract must not accept a Docker image asset");
    assert.match(`${result.stdout}\n${result.stderr}`, /ECR|ecr|DescribeRepositories|AccessDenied|not authorized|image asset/i);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /docker-must-not-run|ENOENT[^\n]*docker/i, "the CLI reached Docker before the assigned image-role/ECR boundary");

    const names = cdkBootstrapNames(accountId, region);
    const imageAssume = calls.find(call => call.service === "sts" && call.action === "AssumeRole" && call.roleArn === names.roleArns.imagePublishing);
    assert.ok(imageAssume, `the CLI did not assume the standard image-publishing role: ${JSON.stringify(calls, null, 2)}`);
    const ecr = calls.find(call => call.service === "ecr");
    assert.equal(ecr?.action, "DescribeRepositories", `the first image publication dependency changed: ${JSON.stringify(calls, null, 2)}`);
    assert.equal(simulator.store.ensureAccount().iam.sessions[ecr!.accessKeyId]?.roleArn, names.roleArns.imagePublishing, "the ECR denial must be evaluated under the image role session");
    assert.ok(simulator.store.ensureAccount().iam.authorizationDecisions.some(decision => decision.principalArn.includes(`assumed-role/${names.roleNames.imagePublishing}/`) && decision.action === "ecr:DescribeRepositories" && decision.decision === "explicitDeny"));
    assertNoStackMutation(simulator, "Docker image rejection");
    assertLocalCalls(calls, proxy.endpoint);
  } finally {
    await proxy?.close().catch(() => undefined);
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("the historical CFN-04 provider gate publishes a Lambda file asset before rejecting the unsupported function", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn04-lambda-gate-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: join(root, "data"),
    region,
    authMode: "enforce",
    cdkBootstrap: true,
    cloudFormationProviderTypes: [],
  });
  const calls: TracedCall[] = [];
  let proxy: Awaited<ReturnType<typeof tracingProxy>> | undefined;
  try {
    await simulator.start();
    proxy = await tracingProxy(simulator.port, calls, () => "lambda-file-phase-gate");
    const env = { ...cdkEnvironment(proxy.endpoint, root), CDK_TEST_ASSET_KIND: "lambda-gate" };
    const result = await runCdk(["--output", join(root, "lambda-gate.out"), "deploy", "Cfn04NegativeStack", "--method", "direct", "--require-approval", "never"], env);
    assert.notEqual(result.code, 0, "a CFN-04-only registry must not deploy the later Lambda provider");
    assert.match(`${result.stdout}\n${result.stderr}`, /Unrecognized resource type AWS::Lambda::Function/i);

    const names = cdkBootstrapNames(accountId, region);
    const bucket = await simulator.s3.storage.loadBucket(accountId, region, names.bucketName);
    assert.ok(Object.keys(bucket.objects).length > 0, "standard CDK must publish the file asset before CloudFormation reaches provider admission");
    const upload = calls.find(call => call.service === "s3" && call.method === "PUT" && call.path.includes(names.bucketName));
    assert.ok(upload, `the file publication trace was not observed: ${JSON.stringify(calls, null, 2)}`);
    assert.equal(simulator.store.ensureAccount().iam.sessions[upload!.accessKeyId]?.roleArn, names.roleArns.filePublishing, "the asset upload must use the standard file-publishing role");
    assertNoStackMutation(simulator, "CFN-04 Lambda provider gate");
    assert.deepEqual(simulator.store.regionState(region).functions, {}, "provider admission must fail before a Lambda workload mutation");
    assertLocalCalls(calls, proxy.endpoint);
  } finally {
    await proxy?.close().catch(() => undefined);
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("standard CDK role calls fail on wrong trust and denied file publication without falling back to root", { timeout: 420_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn04-role-negative-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, "data"), region, authMode: "enforce", cdkBootstrap: true });
  const calls: TracedCall[] = [];
  let command = "startup";
  let proxy: Awaited<ReturnType<typeof tracingProxy>> | undefined;
  let sts: STSClient | undefined;
  try {
    await simulator.start();
    proxy = await tracingProxy(simulator.port, calls, () => command);
    const names = cdkBootstrapNames(accountId, region);
    sts = new STSClient({ endpoint: proxy.endpoint, region, credentials, maxAttempts: 1 });
    const developerRoleName = "cfn04-bounded-developer";
    const developerRole = await simulator.iam.CreateRole({
      RoleName: developerRoleName,
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sts:AssumeRole" }],
      },
    });
    await simulator.iam.PutRolePolicy({
      RoleName: developerRoleName,
      PolicyName: "AssumeCdkBootstrapRoles",
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Resource: Object.values(names.roleArns) }],
      },
    });
    command = "bounded-developer-session";
    const developerSession = await sts.send(new AssumeRoleCommand({ RoleArn: developerRole.Role.Arn, RoleSessionName: "cfn04-negative-tests" }));
    const developerCredentials = developerSession.Credentials!;
    const env = {
      ...cdkEnvironment(proxy.endpoint, root),
      AWS_ACCESS_KEY_ID: developerCredentials.AccessKeyId!,
      AWS_SECRET_ACCESS_KEY: developerCredentials.SecretAccessKey!,
      AWS_SESSION_TOKEN: developerCredentials.SessionToken!,
    };

    command = "lookup-baseline";
    const lookupBaseline = await runCdk(["--output", join(root, "lookup-baseline.out"), "diff", "Cfn04NegativeStack", "--method", "template"], env);
    assert.equal(lookupBaseline.code, 0, `${lookupBaseline.stdout}\n${lookupBaseline.stderr}`);
    const lookupCfn = calls.find(call => call.command === command && call.service === "cloudformation");
    assert.ok(lookupCfn, "the baseline diff did not make its read-only CloudFormation lookup");
    assert.equal(simulator.store.ensureAccount().iam.sessions[lookupCfn.accessKeyId]?.roleArn, names.roleArns.lookup, "the lookup call must use a distinct signed lookup-role session");

    command = "execution-role-root-denied";
    await assert.rejects(sts.send(new AssumeRoleCommand({ RoleArn: names.roleArns.cloudFormationExecution, RoleSessionName: "root-must-not-assume" })), (error: any) => error.name === "AccessDenied" && /Trust policy|not allow/i.test(error.message));

    const roleCases: Array<{
      key: "lookup" | "filePublishing" | "imagePublishing" | "deploy" | "cloudFormationExecution";
      args: string[];
      extraEnv?: NodeJS.ProcessEnv;
      forbidden: (call: TracedCall) => boolean;
      fallbackService?: string;
    }> = [
      { key: "lookup", args: ["diff", "Cfn04NegativeStack", "--method", "template"], forbidden: call => call.service === "cloudformation" && call.action === "CreateStack", fallbackService: "cloudformation" },
      { key: "filePublishing", args: ["deploy", "Cfn04NegativeStack", "--method", "direct", "--require-approval", "never"], extraEnv: { CDK_TEST_ASSET_KIND: "file" }, forbidden: call => call.service === "s3" && call.method === "PUT" },
      // CDK deliberately falls back to same-account base credentials after a
      // failed image-role assumption. The bounded developer must then be
      // denied by ECR; independent template-file publication may run in
      // parallel and is explicitly allowed by the CFN-04 contract.
      { key: "imagePublishing", args: ["deploy", "Cfn04NegativeStack", "--method", "direct", "--require-approval", "never"], extraEnv: { CDK_TEST_ASSET_KIND: "image" }, forbidden: call => call.service === "cloudformation" && call.action === "CreateStack", fallbackService: "ecr" },
      { key: "deploy", args: ["deploy", "Cfn04NegativeStack", "--method", "direct", "--require-approval", "never"], forbidden: call => call.service === "cloudformation" && call.action === "CreateStack", fallbackService: "cloudformation" },
      { key: "cloudFormationExecution", args: ["deploy", "Cfn04NegativeStack", "--method", "direct", "--require-approval", "never"], forbidden: () => false },
    ];

    for (const roleCase of roleCases) {
      const roleName = names.roleNames[roleCase.key];
      const role = simulator.store.ensureAccount().iam.roles[roleName];
      assert.ok(role, `missing bootstrap role ${roleName}`);
      const originalTrust = structuredClone(role.assumeRolePolicyDocument);
      role.assumeRolePolicyDocument = wrongTrust();
      await simulator.store.save();
      command = `wrong-trust-${roleCase.key}`;
      const before = calls.length;
      try {
        const result = await runCdk(["--output", join(root, `${command}.out`), ...roleCase.args], { ...env, ...roleCase.extraEnv });
        assert.notEqual(result.code, 0, `${roleCase.key} wrong trust unexpectedly succeeded`);
        assert.match(`${result.stdout}\n${result.stderr}`, /Could not assume role|AccessDenied|not authorized|Trust policy|does not allow/i, `${roleCase.key} returned an unclear trust diagnostic`);
      } finally {
        role.assumeRolePolicyDocument = originalTrust;
        await simulator.store.save();
      }
      const caseCalls = calls.slice(before);
      if (roleCase.key !== "cloudFormationExecution") {
        assert.ok(caseCalls.some(call => call.service === "sts" && call.action === "AssumeRole" && call.roleArn === names.roleArns[roleCase.key]), `${roleCase.key} was not exercised through standard CDK STS`);
        if (roleCase.fallbackService) {
          const fallback = caseCalls.find(call => call.service === roleCase.fallbackService);
          assert.ok(fallback, `${roleCase.key} did not permission-check the CDK CLI's same-account credential fallback`);
          assert.equal(simulator.store.ensureAccount().iam.sessions[fallback.accessKeyId]?.roleName, developerRoleName, `${roleCase.key} fell back to an unexpected principal`);
        }
      } else {
        assert.ok(caseCalls.some(call => call.service === "cloudformation" && call.action === "CreateStack"), "the wrong CloudFormation execution trust was not reached by direct deployment");
      }
      assert.equal(caseCalls.some(roleCase.forbidden), false, `${roleCase.key} continued beyond its failed trust boundary: ${JSON.stringify(caseCalls, null, 2)}`);
      assertNoStackMutation(simulator, `${roleCase.key} wrong trust`);
    }

    const fileRole = simulator.store.ensureAccount().iam.roles[names.roleNames.filePublishing];
    const originalPolicy = structuredClone(fileRole.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME]);
    const deniedPolicy = structuredClone(originalPolicy);
    for (const statement of (Array.isArray(deniedPolicy.Statement) ? deniedPolicy.Statement : [deniedPolicy.Statement])) {
      const actions = Array.isArray(statement.Action) ? statement.Action : statement.Action === undefined ? [] : [statement.Action];
      statement.Action = actions.filter(action => action !== "s3:PutObject");
    }
    fileRole.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME] = deniedPolicy;
    await simulator.store.save();
    command = "denied-file-publish";
    const deniedBefore = calls.length;
    try {
      const denied = await runCdk(["--output", join(root, "denied-file.out"), "deploy", "Cfn04NegativeStack", "--method", "direct", "--require-approval", "never"], { ...env, CDK_TEST_ASSET_KIND: "file" });
      assert.notEqual(denied.code, 0, "a file role without PutObject unexpectedly published the asset");
      assert.match(`${denied.stdout}\n${denied.stderr}`, /s3:PutObject|AccessDenied|not authorized|upload/i);
    } finally {
      fileRole.inlinePolicies[CDK_BOOTSTRAP_POLICY_NAME] = originalPolicy;
      await simulator.store.save();
    }
    const deniedCalls = calls.slice(deniedBefore);
    const deniedPut = deniedCalls.find(call => call.service === "s3" && call.method === "PUT");
    assert.ok(deniedPut, `the denied file publisher did not reach PutObject: ${JSON.stringify(deniedCalls, null, 2)}`);
    assert.equal(simulator.store.ensureAccount().iam.sessions[deniedPut.accessKeyId]?.roleArn, names.roleArns.filePublishing);
    assertNoStackMutation(simulator, "denied file publication");
    assertLocalCalls(calls, proxy.endpoint);
  } finally {
    sts?.destroy();
    await proxy?.close().catch(() => undefined);
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a higher synthesized bootstrap requirement fails its CDK rule before stack mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn04-bootstrap-rule-negative-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, cdkBootstrap: true, authMode: "off"});
  let cloudformation: CloudFormationClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cloudformation = new CloudFormationClient({ endpoint, region, credentials, maxAttempts: 1 });
    const required = CDK_BOOTSTRAP_COMPATIBILITY_VERSION + 1;
    const template = JSON.stringify({
      Parameters: {
        BootstrapVersion: {
          Type: "AWS::SSM::Parameter::Value<String>",
          Default: CDK_BOOTSTRAP_VERSION_PARAMETER,
        },
      },
      Rules: {
        CheckBootstrapVersion: {
          Assertions: [{
            Assert: { "Fn::Not": [{ "Fn::Contains": [Array.from({ length: required - 1 }, (_, index) => String(index + 1)), { Ref: "BootstrapVersion" }] }] },
            AssertDescription: `CDK bootstrap stack version ${required} required. Please run 'cdk bootstrap' with a recent version of the CDK CLI.`,
          }],
        },
      },
      Resources: { Metadata: { Type: "AWS::CDK::Metadata" } },
    });
    await assert.rejects(cloudformation.send(new CreateStackCommand({ StackName: "requires-newer-bootstrap", TemplateBody: template })), (error: any) => {
      assert.equal(error.name, "ValidationError");
      assert.match(error.message, new RegExp(`bootstrap stack version ${required} required`, "i"));
      return true;
    });
    assertNoStackMutation(simulator, "higher bootstrap rule");
  } finally {
    cloudformation?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function corruptStoredObject(simulator: StackSim, bucket: string, key: string, versionId: string): Promise<void> {
  const index = await simulator.s3.storage.loadBucket(accountId, region, bucket);
  const object = index.objects[key]?.find(candidate => candidate.versionId === versionId);
  assert.ok(object?.blobId, `missing stored S3 blob for ${bucket}/${key}?versionId=${versionId}`);
  const path = join(simulator.s3.storage.root, "blobs", object.blobId.slice(0, 2), object.blobId.slice(2));
  const bytes = await readFile(path);
  assert.ok(bytes.length > 32, "the encrypted S3 blob is unexpectedly short");
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  await writeFile(path, bytes);
}

test("missing and corrupt local template/file assets fail synchronously without a partial stack", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn04-corrupt-assets-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const options = { endpoint, region, credentials, maxAttempts: 1 };
    const cloudformation = new CloudFormationClient(options);
    const s3 = new S3Client({ ...options, forcePathStyle: true });
    clients.push(cloudformation, s3);
    const names = cdkBootstrapNames(accountId, region);

    await assert.rejects(cloudformation.send(new CreateStackCommand({
      StackName: "missing-template-object",
      TemplateURL: `${endpoint}/${names.bucketName}/missing-template.json`,
    })), (error: any) => error.name === "ValidationError" && /Unable to read TemplateURL.*(?:NoSuchKey|specified key does not exist)/i.test(error.message));

    const templateKey = "negative/corrupt-template.json";
    const templateObject = await s3.send(new PutObjectCommand({
      Bucket: names.bucketName,
      Key: templateKey,
      Body: JSON.stringify({ Resources: { Metadata: { Type: "AWS::CDK::Metadata" } } }),
    }));
    assert.ok(templateObject.VersionId);
    await corruptStoredObject(simulator, names.bucketName, templateKey, templateObject.VersionId!);
    await assert.rejects(cloudformation.send(new CreateStackCommand({
      StackName: "corrupt-template-object",
      TemplateURL: `${endpoint}/${names.bucketName}/${templateKey}?versionId=${encodeURIComponent(templateObject.VersionId!)}`,
    })), (error: any) => error.name === "ValidationError" && /Unable to read TemplateURL/i.test(error.message));

    const functionTemplate = (key: string, version?: string) => JSON.stringify({ Resources: {
      Function: {
        Type: "AWS::Lambda::Function",
        Properties: {
          Runtime: "nodejs22.x",
          Handler: "index.handler",
          Role: `arn:aws:iam::${accountId}:role/not-evaluated-before-asset-read`,
          Code: { S3Bucket: names.bucketName, S3Key: key, ...(version ? { S3ObjectVersion: version } : {}) },
        },
      },
    } });
    await assert.rejects(cloudformation.send(new CreateStackCommand({
      StackName: "missing-file-asset",
      TemplateBody: functionTemplate("negative/missing-function.zip"),
      RoleARN: names.roleArns.cloudFormationExecution,
    })), (error: any) => error.name === "ValidationError" && /cannot read local S3 asset.*(?:NoSuchKey|specified key does not exist)/i.test(error.message));

    const assetKey = "negative/corrupt-function.zip";
    const fileAsset = await s3.send(new PutObjectCommand({ Bucket: names.bucketName, Key: assetKey, Body: Buffer.from("not reached by the Lambda provider") }));
    assert.ok(fileAsset.VersionId);
    await corruptStoredObject(simulator, names.bucketName, assetKey, fileAsset.VersionId!);
    await assert.rejects(cloudformation.send(new CreateStackCommand({
      StackName: "corrupt-file-asset",
      TemplateBody: functionTemplate(assetKey, fileAsset.VersionId),
      RoleARN: names.roleArns.cloudFormationExecution,
    })), (error: any) => error.name === "ValidationError" && /cannot read local S3 asset/i.test(error.message));

    assertNoStackMutation(simulator, "missing/corrupt template and file assets");
    assert.deepEqual(simulator.store.regionState(region).functions, {}, "no Lambda provider mutation may precede asset integrity validation");
  } finally {
    clients.forEach(client => client.destroy());
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
