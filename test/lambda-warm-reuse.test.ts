import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudWatchLogsClient, DescribeLogStreamsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  CreateAliasCommand,
  CreateFunctionCommand,
  GetProvisionedConcurrencyConfigCommand,
  InvokeCommand,
  LambdaClient,
  PublishVersionCommand,
  PutProvisionedConcurrencyConfigCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { createZip } from "../src/core/zip-create.js";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const role = "arn:aws:iam::000000000000:role/test";

function source(revision: string): string { return `
const { randomUUID } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { STSClient, GetCallerIdentityCommand } = require("@aws-sdk/client-sts");
let initializationCount = 0; initializationCount++;
let invocationCount = 0;
const environmentId = randomUUID();
const initializedAt = Date.now();
const client = new STSClient({});
const clientSingletonId = randomUUID();
exports.handler = async (event, context) => {
  if (event.crash) process.exit(17);
  if (event.readyPath) writeFileSync(event.readyPath, environmentId);
  if (event.releasePath) while (!existsSync(event.releasePath)) await new Promise(resolve => setTimeout(resolve, 10));
  if (event.waitMs) await new Promise(resolve => setTimeout(resolve, event.waitMs));
  if (event.timeout) await new Promise(() => {});
  invocationCount++;
  const markerPath = join(process.env.TMPDIR, "warm-marker");
  const previousMarker = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : undefined;
  if (!previousMarker) writeFileSync(markerPath, environmentId);
  const identity = await client.send(new GetCallerIdentityCommand({}));
  return { revision: ${JSON.stringify(revision)}, initializationCount, invocationCount, environmentId, initializedAt,
    clientSingletonId, previousMarker, marker: readFileSync(markerPath, "utf8"), accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    identityArn: identity.Arn, requestId: context.awsRequestId, remaining: context.getRemainingTimeInMillis(),
    clientContext: context.clientContext, traceHeader: process.env._X_AMZN_TRACE_ID, logStreamName: context.logStreamName,
    configured: process.env.CONFIGURED };
};` }

const archive = (revision: string) => createZip([{ name: "index.js", content: source(revision) }, { name: "package.json", content: '{"type":"commonjs"}' }]);
const payload = (result: any) => JSON.parse(Buffer.from(result.Payload ?? result.payload ?? []).toString("utf8"));
async function active(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 10)); }
async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> { for (let index = 0; index < 500; index++) { const value = await read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error("condition did not become ready"); }

test("DUG-13 reuses bounded Node ZIP environments while refreshing invocation state and isolating concurrency", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-warm-"));
  const previousIdle = process.env.STACKSIM_LAMBDA_WORKER_IDLE_MS; process.env.STACKSIM_LAMBDA_WORKER_IDLE_MS = "120";
  const clock = new TestClock(Date.now());
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off", lambdaConcurrentExecutions: 3, lambdaUnreservedConcurrencyReserve: 1 });
  let lambda: LambdaClient | undefined; let logs: CloudWatchLogsClient | undefined;
  const connect = () => { const endpoint = `http://127.0.0.1:${simulator.port}`; lambda = new LambdaClient({ endpoint, region, credentials }); logs = new CloudWatchLogsClient({ endpoint, region, credentials }); };
  const disconnect = () => { lambda?.destroy(); logs?.destroy(); lambda = undefined; logs = undefined; };
  try {
    await simulator.start(); connect();
    await lambda!.send(new CreateFunctionCommand({ FunctionName: "warm-worker", Runtime: "nodejs22.x", Handler: "index.handler", Role: role, Timeout: 1, Code: { ZipFile: archive("one") }, Environment: { Variables: { CONFIGURED: "one" } } })); await active();

    const clientContextOne = Buffer.from(JSON.stringify({ custom: { invocation: "one" } })).toString("base64");
    const first = payload(await lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", ClientContext: clientContextOne, Payload: Buffer.from("{}") })));
    const traceResponse = await fetch(`http://127.0.0.1:${simulator.port}/2015-03-31/functions/warm-worker/invocations`, { method: "POST", headers: { "content-type": "application/json", "x-amzn-trace-id": "Root=1-warm-proof" }, body: "{}" });
    assert.equal(traceResponse.status, 200); const second = await traceResponse.json() as any;
    assert.equal(first.initializationCount, 1); assert.equal(second.initializationCount, 1); assert.equal(second.invocationCount, 2);
    assert.equal(second.environmentId, first.environmentId); assert.equal(second.clientSingletonId, first.clientSingletonId, "the module-level SDK client singleton belongs to the warm environment");
    assert.equal(second.previousMarker, first.environmentId); assert.equal(second.marker, first.environmentId, "private /tmp survives a warm lease");
    assert.notEqual(second.accessKeyId, first.accessKeyId, "execution-role credentials refresh on every lease"); assert.notEqual(second.identityArn, first.identityArn);
    assert.notEqual(second.requestId, first.requestId); assert.equal(first.clientContext.custom.invocation, "one"); assert.equal(second.clientContext, undefined); assert.equal(second.traceHeader, "Root=1-warm-proof");
    assert.equal(second.logStreamName, first.logStreamName, "one environment reuses one log stream");
    const lineaged = payload(await simulator.lambda.invoke("warm-worker", Buffer.from("{}"), "lineaged-request", { lineage: ["arn:stacksim:test:first"] }));
    const unlineaged = payload(await simulator.lambda.invoke("warm-worker", Buffer.from("{}"), "unlineaged-request", {}));
    const sessions = simulator.store.ensureAccount().iam.sessions;
    assert.ok(sessions[lineaged.accessKeyId].lambdaLineage?.includes("arn:stacksim:test:first"));
    assert.ok(!sessions[unlineaged.accessKeyId].lambdaLineage?.includes("arn:stacksim:test:first"), "lineage does not carry into the next warm lease");
    assert.equal(unlineaged.traceHeader, undefined, "trace metadata is removed when the next lease does not supply it");

    const [concurrentOne, concurrentTwo] = await Promise.all([
      lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Payload: Buffer.from('{"waitMs":80}') })).then(payload),
      lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Payload: Buffer.from('{"waitMs":80}') })).then(payload),
    ]);
    assert.notEqual(concurrentOne.environmentId, concurrentTwo.environmentId, "concurrent requests lease separate workers");
    assert.equal(concurrentOne.marker, concurrentOne.environmentId); assert.equal(concurrentTwo.marker, concurrentTwo.environmentId);
    assert.notEqual(concurrentOne.logStreamName, concurrentTwo.logStreamName);
    assert.ok((simulator.lambda as any).workerPool.size <= 3, "the regional pool is bounded by admitted concurrency");
    const streams = await logs!.send(new DescribeLogStreamsCommand({ logGroupName: "/aws/lambda/warm-worker" })); assert.ok((streams.logStreams?.length ?? 0) >= 2);

    const beforeCrash = payload(await lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Payload: Buffer.from("{}") })));
    const crashed = await lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Payload: Buffer.from('{"crash":true}') })); assert.equal(crashed.FunctionError, "Unhandled");
    const afterCrash = payload(await lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Payload: Buffer.from("{}") }))); assert.notEqual(afterCrash.environmentId, beforeCrash.environmentId, "a crashed environment is replaced");
    const timed = await lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Payload: Buffer.from('{"timeout":true}') })); assert.equal(timed.FunctionError, "Unhandled"); assert.match(Buffer.from(timed.Payload ?? []).toString("utf8"), /timed out/);
    const afterTimeout = payload(await lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Payload: Buffer.from("{}") }))); assert.notEqual(afterTimeout.environmentId, afterCrash.environmentId, "a timed-out environment is replaced");

    clock.advance(121); await new Promise(resolve => setImmediate(resolve));
    const afterIdle = payload(await lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Payload: Buffer.from("{}") }))); assert.notEqual(afterIdle.environmentId, afterTimeout.environmentId, "idle expiry cold-starts a replacement"); assert.equal(afterIdle.previousMarker, undefined);

    const published = await lambda!.send(new PublishVersionCommand({ FunctionName: "warm-worker" }));
    await lambda!.send(new CreateAliasCommand({ FunctionName: "warm-worker", Name: "stable", FunctionVersion: published.Version! }));
    const versionFirst = payload(await lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Qualifier: "stable", Payload: Buffer.from("{}") })));
    const versionSecond = payload(await lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Qualifier: published.Version, Payload: Buffer.from("{}") })));
    assert.equal(versionSecond.environmentId, versionFirst.environmentId, "an alias and its unchanged immutable version share the executable pool");
    await lambda!.send(new UpdateFunctionCodeCommand({ FunctionName: "warm-worker", ZipFile: archive("two") })); await active();
    const latestUpdated = payload(await lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Payload: Buffer.from("{}") }))); assert.equal(latestUpdated.revision, "two"); assert.notEqual(latestUpdated.environmentId, afterIdle.environmentId); assert.equal(latestUpdated.previousMarker, undefined);
    const unchangedVersion = payload(await lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Qualifier: "stable", Payload: Buffer.from("{}") }))); assert.equal(unchangedVersion.environmentId, versionFirst.environmentId, "updating latest does not retire an addressable immutable version");
    await lambda!.send(new UpdateFunctionConfigurationCommand({ FunctionName: "warm-worker", Environment: { Variables: { CONFIGURED: "two" } } })); await active();
    const configured = payload(await lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Payload: Buffer.from("{}") }))); assert.equal(configured.configured, "two"); assert.notEqual(configured.environmentId, latestUpdated.environmentId, "configuration mutation invalidates the latest fingerprint");
    await lambda!.send(new UpdateFunctionConfigurationCommand({ FunctionName: "warm-worker", Timeout: 10 })); await active();
    await (simulator.lambda as any).workerPool.retireFunctionVersion("warm-worker", "$LATEST");
    const releasePath = join(root, "cold-burst-release");
    const readyPaths = Array.from({ length: 3 }, (_, index) => join(root, `cold-burst-ready-${index}`));
    const coldBurstPromise = Promise.all(readyPaths.map(readyPath => lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Payload: Buffer.from(JSON.stringify({ readyPath, releasePath })) })).then(payload)));
    await waitFor(() => Promise.all(readyPaths.map(readyPath => readFile(readyPath, "utf8").catch(() => ""))), values => values.every(Boolean));
    await writeFile(releasePath, "release");
    const coldBurst = await coldBurstPromise;
    assert.equal(new Set(coldBurst.map(item => item.environmentId)).size, 3); assert.ok((simulator.lambda as any).workerPool.size <= 3, "concurrent cold creation reserves bounded pool capacity atomically");

    const provisioned = await lambda!.send(new PutProvisionedConcurrencyConfigCommand({ FunctionName: "warm-worker", Qualifier: "stable", ProvisionedConcurrentExecutions: 1 })); assert.equal(provisioned.Status, "IN_PROGRESS"); clock.advance(50);
    const ready = await waitFor(() => lambda!.send(new GetProvisionedConcurrencyConfigCommand({ FunctionName: "warm-worker", Qualifier: "stable" })), value => value.Status === "READY"); assert.equal(ready.AvailableProvisionedConcurrentExecutions, 1); const readyAt = Date.now();
    const prewarmed = payload(await lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Qualifier: "stable", Payload: Buffer.from("{}") }))); assert.ok(prewarmed.initializedAt <= readyAt, "READY means module initialization already completed");

    const stoppedLambda = simulator.lambda as any; disconnect(); await simulator.stop(); assert.equal(stoppedLambda.children.size, 0); assert.equal(stoppedLambda.workerPool.size, 0);
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "off", lambdaConcurrentExecutions: 3, lambdaUnreservedConcurrencyReserve: 1 }); await simulator.start(); connect();
    const restarted = payload(await lambda!.send(new InvokeCommand({ FunctionName: "warm-worker", Payload: Buffer.from("{}") }))); assert.notEqual(restarted.environmentId, configured.environmentId, "simulator restart is cold"); assert.equal(restarted.previousMarker, undefined);
  } finally {
    disconnect(); await simulator.stop().catch(() => undefined); if (previousIdle === undefined) delete process.env.STACKSIM_LAMBDA_WORKER_IDLE_MS; else process.env.STACKSIM_LAMBDA_WORKER_IDLE_MS = previousIdle; await rm(root, { recursive: true, force: true });
  }
});
