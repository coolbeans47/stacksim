import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudFormationClient, CreateStackCommand, DescribeStackEventsCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function waitForStack(client: CloudFormationClient, stackName: string, expected: string, attempts = 250, modeledClock?: TestClock): Promise<any> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    modeledClock?.advance(25);
    const stack = (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
    if (stack?.StackStatus === expected) return stack;
    if (stack?.StackStatus?.endsWith("FAILED") || stack?.StackStatus === "ROLLBACK_COMPLETE") throw new Error(`${stackName} reached ${stack.StackStatus}: ${stack.StackStatusReason}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${stackName} to reach ${expected}`);
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try { await readFile(path); return; } catch { /* not written yet */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForCondition(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function template(handler: string, properties: Record<string, unknown> = {}, environment?: Record<string, string>): string {
  return JSON.stringify({
    Resources: {
      ProviderRole: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] } } },
      ProviderFunction: { Type: "AWS::Lambda::Function", Properties: { Runtime: "nodejs22.x", Handler: "index.handler", Role: { "Fn::GetAtt": ["ProviderRole", "Arn"] }, Code: { ZipFile: handler }, Timeout: 30, ...(environment ? { Environment: { Variables: environment } } : {}) } },
      Probe: { Type: "Custom::Cfn14ShutdownNetwork", Properties: { ServiceToken: { "Fn::GetAtt": ["ProviderFunction", "Arn"] }, ServiceTimeout: 30, ...properties } },
    },
    Outputs: { PhysicalId: { Value: { Ref: "Probe" } }, Results: { Value: { "Fn::GetAtt": ["Probe", "Results"] } }, FunctionName: { Value: { Ref: "ProviderFunction" } } },
  });
}

const callbackThenHangHandler = `
const https = require("node:https");
exports.handler = async event => {
  const callbackToken = new URL(event.ResponseURL).pathname.split("/").pop();
  console.log("CFN14_CALLBACK_LEAK_TEST", event.ResponseURL, callbackToken);
  await new Promise(resolve => setTimeout(resolve, 25));
  const body = JSON.stringify({
    Status: "SUCCESS",
    PhysicalResourceId: "callback-before-exit",
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: { Results: "callback-committed" }
  });
  await new Promise((resolve, reject) => {
    const request = https.request(event.ResponseURL, { method: "PUT", headers: { "content-length": Buffer.byteLength(body) } }, response => {
      response.resume();
      response.on("end", () => response.statusCode === 200 ? resolve() : reject(new Error("callback status " + response.statusCode)));
    });
    request.on("error", reject);
    request.end(body);
  });
  await new Promise(() => {});
};`;

test("CFN-14 commits a callback without waiting for the provider handler to exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-callback-exit-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  let client: CloudFormationClient | undefined;
  let logs: CloudWatchLogsClient | undefined;
  try {
    await simulator.start();
    client = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    logs = new CloudWatchLogsClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    const started = performance.now();
    const created = await client.send(new CreateStackCommand({ StackName: "cfn14-callback-before-exit", TemplateBody: template(callbackThenHangHandler), Capabilities: ["CAPABILITY_IAM"] }));
    const stack = await waitForStack(client, created.StackId!, "CREATE_COMPLETE", 200);
    assert.ok(performance.now() - started < 4_000, "the stack must not wait for the 30-second Lambda timeout after its callback commits");
    assert.equal(stack.Outputs?.find((output: { OutputKey?: string; OutputValue?: string }) => output.OutputKey === "Results")?.OutputValue, "callback-committed");
    const functionName = stack.Outputs?.find((output: { OutputKey?: string; OutputValue?: string }) => output.OutputKey === "FunctionName")?.OutputValue;
    const logEvents = await logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${functionName}` }));
    const messages = (logEvents.events ?? []).map(event => event.message ?? "").join("\n");
    assert.match(messages, /CFN14_CALLBACK_LEAK_TEST \[REDACTED\] \[REDACTED\]/, "both the exact callback URL and its bearer token must be redacted during log ingestion");
    assert.doesNotMatch(messages, /custom-resource-response\//, "the callback URL path must not enter Lambda logs");
  } finally {
    logs?.destroy();
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

const failedReasonHandler = `
const https = require("node:https");
exports.handler = async event => {
  const token = new URL(event.ResponseURL).pathname.split("/").pop();
  const body = JSON.stringify({
    Status: event.RequestType === "Delete" ? "SUCCESS" : "FAILED",
    Reason: event.RequestType === "Delete" ? undefined : "callback-url=" + event.ResponseURL + "; standalone-token=" + token,
    PhysicalResourceId: event.PhysicalResourceId || "failed-reason-provider",
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: {}
  });
  await new Promise((resolve, reject) => {
    const request = https.request(event.ResponseURL, { method: "PUT", headers: { "content-length": Buffer.byteLength(body) } }, response => {
      response.resume();
      response.on("end", () => response.statusCode === 200 ? resolve() : reject(new Error("callback status " + response.statusCode)));
    });
    request.on("error", reject);
    request.end(body);
  });
};`;

test("CFN-14 redacts full callback URLs and standalone bearer tokens from FAILED reasons", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-failed-reason-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  let client: CloudFormationClient | undefined;
  try {
    await simulator.start();
    client = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    const created = await client.send(new CreateStackCommand({ StackName: "cfn14-failed-reason-redaction", TemplateBody: template(failedReasonHandler), Capabilities: ["CAPABILITY_IAM"] }));
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const status = (await client.send(new DescribeStacksCommand({ StackName: created.StackId }))).Stacks?.[0]?.StackStatus;
      if (status === "ROLLBACK_COMPLETE") break;
      if (attempt === 249) throw new Error(`failed-reason stack did not roll back; last status ${status}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const events = await client.send(new DescribeStackEventsCommand({ StackName: created.StackId }));
    const rendered = JSON.stringify(events);
    assert.match(rendered, /callback-url=\[redacted callback URL\]/);
    assert.match(rendered, /standalone-token=\[redacted callback token\]/);
    assert.doesNotMatch(rendered, /custom-resource-response\//, "stack events must not expose a callback URL");
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

const halfOpenCallbackHandler = `
const fs = require("node:fs");
const https = require("node:https");
exports.handler = async event => {
  const request = https.request(event.ResponseURL, { method: "PUT", headers: { "content-length": 4096 } });
  request.on("error", () => {});
  request.write('{"Status":"SUCCESS"');
  request.on("socket", socket => socket.once("secureConnect", () => fs.writeFileSync(event.ResourceProperties.Marker, "connected")));
  await new Promise(() => {});
};`;

test("CFN-14 shutdown terminates a provider holding a callback PUT body open", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-half-open-callback-"));
  const marker = join(root, "half-open-callback-connected");
  const simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  let client: CloudFormationClient | undefined;
  let stopped = false;
  try {
    await simulator.start();
    client = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    await client.send(new CreateStackCommand({ StackName: "cfn14-half-open-callback", TemplateBody: template(halfOpenCallbackHandler, { Marker: marker }), Capabilities: ["CAPABILITY_IAM"] }));
    await waitForFile(marker);
    await waitForCondition(() => (simulator.lambda as any).children.size === 1, "the half-open callback provider did not remain active");
    await new Promise(resolve => setTimeout(resolve, 50));
    client.destroy();
    client = undefined;
    const started = performance.now();
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        simulator.stop(),
        new Promise<never>((_resolve, reject) => { stopTimer = setTimeout(() => reject(new Error("simulator stop remained blocked behind the half-open callback body")), 3_000); }),
      ]);
    } finally { if (stopTimer) clearTimeout(stopTimer); }
    stopped = true;
    assert.ok(performance.now() - started < 3_000, "Lambda child termination must run concurrently with callback-listener drain");
  } finally {
    client?.destroy();
    if (!stopped) await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

const interruptedHandler = `
const fs = require("node:fs");
const https = require("node:https");
exports.handler = async event => {
  const marker = event.ResourceProperties.Marker;
  let attempts = [];
  try { attempts = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
  attempts.push(event.RequestId);
  fs.writeFileSync(marker, JSON.stringify(attempts));
  if (attempts.length === 1) while (!fs.existsSync(event.ResourceProperties.Release)) await new Promise(resolve => setTimeout(resolve, 10));
  const body = JSON.stringify({
    Status: "SUCCESS",
    PhysicalResourceId: "resumed-custom-resource",
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: { Results: attempts.join(",") }
  });
  await new Promise((resolve, reject) => {
    const request = https.request(event.ResponseURL, { method: "PUT", headers: { "content-length": Buffer.byteLength(body) } }, response => {
      response.resume();
      response.on("end", () => response.statusCode === 200 ? resolve() : reject(new Error("callback status " + response.statusCode)));
    });
    request.on("error", reject);
    request.end(body);
  });
};`;

test("CFN-14 restart reinvokes a shutdown-interrupted INTENT with the same durable RequestId", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-restart-intent-"));
  const marker = join(root, "custom-resource-attempts.json");
  const release = join(root, "release-first-attempt");
  const first = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  let firstClient: CloudFormationClient | undefined;
  let second: StackSim | undefined;
  let secondClient: CloudFormationClient | undefined;
  try {
    await first.start();
    firstClient = new CloudFormationClient({ endpoint: `http://127.0.0.1:${first.port}`, region, credentials, maxAttempts: 1 });
    const created = await firstClient.send(new CreateStackCommand({ StackName: "cfn14-restart-intent", TemplateBody: template(interruptedHandler, { Marker: marker, Release: release }), Capabilities: ["CAPABILITY_IAM"] }));
    await waitForFile(marker);
    firstClient.destroy();
    firstClient = undefined;

    // Reproduce the graceful-stop edge exactly: Lambda is marked interrupted,
    // then the callback listener drains before the active provider attempts its
    // callback.  ECONNREFUSED must leave the durable INTENT replayable.
    first.lambda.beginShutdown();
    const callbackServer = (first as any).customResourceCallbackServer;
    await new Promise<void>((resolveClose, reject) => callbackServer.close((error?: Error) => error ? reject(error) : resolveClose()));
    await writeFile(release, "continue");
    await waitForCondition(() => (first.lambda as any).children.size === 0, "the first custom-resource invocation did not exit after callback listener shutdown");
    await first.stop();

    const firstAttempts = JSON.parse(await readFile(marker, "utf8")) as string[];
    const callback = await (first as any).customResourceCallbacks.read(region, firstAttempts[0]);
    assert.equal(callback?.invocationStatus, "INTENT", "shutdown must not convert the replayable callback intent into INVOCATION_FAILED");

    second = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
    await second.start();
    secondClient = new CloudFormationClient({ endpoint: `http://127.0.0.1:${second.port}`, region, credentials, maxAttempts: 1 });
    const stack = await waitForStack(secondClient, created.StackId!, "CREATE_COMPLETE", 300);
    const attempts = JSON.parse(await readFile(marker, "utf8")) as string[];
    assert.equal(attempts.length, 2, "restart must reinvoke the interrupted callback intent exactly once");
    assert.equal(attempts[0], attempts[1], "restart must preserve the durable custom-resource RequestId");
    assert.equal(stack.Outputs?.find((output: { OutputKey?: string; OutputValue?: string }) => output.OutputKey === "Results")?.OutputValue, `${attempts[0]},${attempts[1]}`);
  } finally {
    firstClient?.destroy();
    secondClient?.destroy();
    await second?.stop().catch(() => undefined);
    await first.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

const networkHandler = `
const https = require("node:https");
exports.handler = async event => {
  const results = {};
  const check = async (name, operation) => {
    try { await operation(); results[name] = "ALLOWED"; }
    catch (error) { results[name] = error && error.code || error && error.message || String(error); }
  };
  const local = await fetch(process.env.AWS_ENDPOINT_URL + "/_stacksim/health");
  results.localFetch = String(local.status);
  results.hostSecret = String(Boolean(process.env.STACKSIM_CFN14_HOST_SECRET));
  results.configuredEnvironment = String(process.env.STACKSIM_CFN14_CONFIGURED);
  const fs = require("node:fs");
  const path = require("node:path");
  results.privateKeySibling = String(fs.existsSync(path.join(path.dirname(process.env.NODE_EXTRA_CA_CERTS), "localhost-key.pem")));
  await check("fetch", () => fetch("https://example.com/"));
  await check("childProcess", () => require("node:child_process").execFileSync(process.execPath, ["-e", "process.exit(0)"]));
  await check("childProcessImport", async () => (await import("node:child_process")).execFileSync(process.execPath, ["-e", "process.exit(0)"]));
  await check("dgram", () => require("node:dgram").createSocket("udp4"));
  await check("worker", () => new (require("node:worker_threads").Worker)("", { eval: true }));
  await check("http2", () => require("node:http2").connect("https://example.com"));
  await check("dns", () => require("node:dns/promises").lookup("example.com"));
  await check("socket", () => new (require("node:net").Socket)().connect(443, "example.com"));
  const body = JSON.stringify({
    Status: "SUCCESS",
    PhysicalResourceId: "network-tripwire",
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: { Results: JSON.stringify(results) }
  });
  await new Promise((resolve, reject) => {
    const request = https.request(event.ResponseURL, { method: "PUT", headers: { "content-length": Buffer.byteLength(body) } }, response => {
      response.resume();
      response.on("end", () => response.statusCode === 200 ? resolve() : reject(new Error("callback status " + response.statusCode)));
    });
    request.on("error", reject);
    request.end(body);
  });
};`;

test("CFN-14 custom resources use a loopback SDK endpoint when the simulator binds to 0.0.0.0", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-wildcard-host-"));
  const simulator = new StackSim({ host: "0.0.0.0", port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  let client: CloudFormationClient | undefined;
  try {
    await simulator.start();
    client = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    const created = await client.send(new CreateStackCommand({ StackName: "cfn14-wildcard-host", TemplateBody: template(networkHandler), Capabilities: ["CAPABILITY_IAM"] }));
    const stack = await waitForStack(client, created.StackId!, "CREATE_COMPLETE", 250);
    const encoded = stack.Outputs?.find((output: { OutputKey?: string; OutputValue?: string }) => output.OutputKey === "Results")?.OutputValue;
    const results = JSON.parse(String(encoded)) as Record<string, string>;
    assert.equal(results.localFetch, "200", "the provider's standard SDK endpoint must connect through loopback rather than the wildcard bind address");
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CFN-14 callback TLS remains wall-clock valid when the modeled simulator clock is offset", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-offset-clock-tls-"));
  const modeledClock = new TestClock(Date.parse("2000-01-01T00:00:00Z"));
  const simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, clock: modeledClock, authMode: "off"});
  let client: CloudFormationClient | undefined;
  try {
    await simulator.start();
    client = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    const created = await client.send(new CreateStackCommand({ StackName: "cfn14-offset-clock-tls", TemplateBody: template(networkHandler), Capabilities: ["CAPABILITY_IAM"] }));
    const stack = await waitForStack(client, created.StackId!, "CREATE_COMPLETE", 250, modeledClock);
    const encoded = stack.Outputs?.find((output: { OutputKey?: string; OutputValue?: string }) => output.OutputKey === "Results")?.OutputValue;
    assert.equal((JSON.parse(String(encoded)) as Record<string, string>).localFetch, "200");
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CFN-14 runner allows pinned loopback traffic and blocks obvious network escape hatches", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn14-network-tripwire-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, cloudFormationCustomResourceCallbackPort: 0, dataDir: root, region, authMode: "off"});
  let client: CloudFormationClient | undefined;
  const priorHostSecret = process.env.STACKSIM_CFN14_HOST_SECRET;
  try {
    process.env.STACKSIM_CFN14_HOST_SECRET = "must-not-reach-provider";
    await simulator.start();
    client = new CloudFormationClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 });
    const created = await client.send(new CreateStackCommand({ StackName: "cfn14-network-tripwire", TemplateBody: template(networkHandler, {}, { STACKSIM_CFN14_CONFIGURED: "kept", NODE_OPTIONS: "--require=definitely-missing-cfn14-preload.js" }), Capabilities: ["CAPABILITY_IAM"] }));
    const stack = await waitForStack(client, created.StackId!, "CREATE_COMPLETE", 250);
    const encoded = stack.Outputs?.find((output: { OutputKey?: string; OutputValue?: string }) => output.OutputKey === "Results")?.OutputValue;
    const results = JSON.parse(String(encoded)) as Record<string, string>;
    assert.equal(results.localFetch, "200");
    assert.equal(results.hostSecret, "false", "the custom-resource child must not inherit arbitrary host environment variables");
    assert.equal(results.configuredEnvironment, "kept", "ordinary function configuration must survive the restricted runtime environment");
    assert.equal(results.privateKeySibling, "false", "NODE_EXTRA_CA_CERTS must point to an invocation-local public CA copy, not the persistent private-key directory");
    for (const name of ["fetch", "childProcess", "childProcessImport", "dgram", "worker", "http2", "dns", "socket"]) assert.equal(results[name], "STACKSIM_CLOUDFORMATION_NETWORK_BLOCKED", `${name} must be blocked by the custom-resource runner`);
  } finally {
    if (priorHostSecret === undefined) delete process.env.STACKSIM_CFN14_HOST_SECRET; else process.env.STACKSIM_CFN14_HOST_SECRET = priorHostSecret;
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
