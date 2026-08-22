import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import {
  CreateAliasCommand,
  CreateFunctionCommand,
  DeleteAliasCommand,
  DeleteFunctionCommand,
  DeleteFunctionConcurrencyCommand,
  DeleteProvisionedConcurrencyConfigCommand,
  GetAccountSettingsCommand,
  GetFunctionCommand,
  GetFunctionConcurrencyCommand,
  GetProvisionedConcurrencyConfigCommand,
  InvokeCommand,
  LambdaClient,
  ListProvisionedConcurrencyConfigsCommand,
  PublishVersionCommand,
  PutFunctionConcurrencyCommand,
  PutProvisionedConcurrencyConfigCommand,
} from "@aws-sdk/client-lambda";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const parsePayload = (result: any) => JSON.parse(Buffer.from(result.Payload ?? []).toString("utf8"));
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) { const value = await read(); if (accept(value)) return value; if (Date.now() >= deadline) throw new Error("Timed out waiting for provisioned concurrency"); await delay(10); }
}

test("Lambda concurrency APIs enforce reserved, account, and qualified provisioned pools with metrics and durable leases", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-concurrency-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, lambdaConcurrentExecutions: 5, lambdaUnreservedConcurrencyReserve: 1, authMode: "off"});
  let lambda: LambdaClient | undefined; let cloudwatch: CloudWatchClient | undefined; let endpoint = "";
  const connect = () => { endpoint = `http://127.0.0.1:${simulator.port}`; lambda = new LambdaClient({ endpoint, region, credentials }); cloudwatch = new CloudWatchClient({ endpoint, region, credentials }); };
  const disconnect = () => { lambda?.destroy(); cloudwatch?.destroy(); lambda = undefined; cloudwatch = undefined; };
  const rawInvoke = (functionName: string, payload: unknown, qualifier?: string) => fetch(`${endpoint}/2015-03-31/functions/${encodeURIComponent(functionName)}/invocations${qualifier ? `?Qualifier=${encodeURIComponent(qualifier)}` : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const metric = async (metricName: string, dimensions: Array<{ Name: string; Value: string }>, statistic: "Sum" | "Maximum" = "Sum") => {
    const result = await cloudwatch!.send(new GetMetricStatisticsCommand({ Namespace: "AWS/Lambda", MetricName: metricName, Dimensions: dimensions, StartTime: new Date(Date.now() - 120_000), EndTime: new Date(Date.now() + 60_000), Period: 60, Statistics: [statistic] }));
    return result.Datapoints?.reduce((value, point) => Math.max(value, point[statistic] ?? 0), 0) ?? 0;
  };

  try {
    await simulator.start(); connect(); const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip")); const role = "arn:aws:iam::000000000000:role/test";
    const create = (name: string, handler = "handler.concurrencyHandler", timeout = 3) => lambda!.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Role: role, Handler: handler, Timeout: timeout, Code: { ZipFile: zip } }));
    await Promise.all([create("reserved"), create("shared"), create("timeout", "handler.timeoutHandler", 1)]); await delay(10);
    const version = await lambda!.send(new PublishVersionCommand({ FunctionName: "reserved" })); await lambda!.send(new CreateAliasCommand({ FunctionName: "reserved", Name: "live", FunctionVersion: version.Version! }));

    assert.equal((await lambda!.send(new PutFunctionConcurrencyCommand({ FunctionName: "reserved", ReservedConcurrentExecutions: 2 }))).ReservedConcurrentExecutions, 2);
    assert.equal((await lambda!.send(new GetFunctionConcurrencyCommand({ FunctionName: "reserved" }))).ReservedConcurrentExecutions, 2);
    assert.equal((await lambda!.send(new GetFunctionCommand({ FunctionName: "reserved" }))).Concurrency?.ReservedConcurrentExecutions, 2);
    assert.equal((await lambda!.send(new GetAccountSettingsCommand({}))).AccountLimit?.UnreservedConcurrentExecutions, 3);
    await assert.rejects(lambda!.send(new PutFunctionConcurrencyCommand({ FunctionName: "shared", ReservedConcurrentExecutions: 3 })), (error: any) => error.name === "InvalidParameterValueException" && /fewer than 1/.test(error.message));

    const aliasPut = await lambda!.send(new PutProvisionedConcurrencyConfigCommand({ FunctionName: "reserved", Qualifier: "live", ProvisionedConcurrentExecutions: 1 })); assert.equal(aliasPut.Status, "IN_PROGRESS");
    await lambda!.send(new PutProvisionedConcurrencyConfigCommand({ FunctionName: "reserved", Qualifier: version.Version!, ProvisionedConcurrentExecutions: 1 }));
    const aliasConfig = await waitFor(() => lambda!.send(new GetProvisionedConcurrencyConfigCommand({ FunctionName: "reserved", Qualifier: "live" })), value => value.Status === "READY"); assert.equal(aliasConfig.AllocatedProvisionedConcurrentExecutions, 1); assert.equal(aliasConfig.AvailableProvisionedConcurrentExecutions, 1);
    await waitFor(() => lambda!.send(new GetProvisionedConcurrencyConfigCommand({ FunctionName: "reserved", Qualifier: version.Version! })), value => value.Status === "READY");
    const firstPage = await lambda!.send(new ListProvisionedConcurrencyConfigsCommand({ FunctionName: "reserved", MaxItems: 1 })); assert.equal(firstPage.ProvisionedConcurrencyConfigs?.length, 1); assert.ok(firstPage.NextMarker);
    const secondPage = await lambda!.send(new ListProvisionedConcurrencyConfigsCommand({ FunctionName: "reserved", MaxItems: 1, Marker: firstPage.NextMarker })); assert.equal(secondPage.ProvisionedConcurrencyConfigs?.length, 1); assert.deepEqual(new Set([firstPage.ProvisionedConcurrencyConfigs![0].FunctionArn, secondPage.ProvisionedConcurrencyConfigs![0].FunctionArn]), new Set([`${simulator.store.regionState(region).functions.reserved.functionArn}:${version.Version}`, `${simulator.store.regionState(region).functions.reserved.functionArn}:live`]));
    await assert.rejects(lambda!.send(new PutProvisionedConcurrencyConfigCommand({ FunctionName: "reserved", Qualifier: "$LATEST", ProvisionedConcurrentExecutions: 1 })), (error: any) => error.name === "InvalidParameterValueException");
    await assert.rejects(lambda!.send(new PutProvisionedConcurrencyConfigCommand({ FunctionName: "reserved", Qualifier: "live", ProvisionedConcurrentExecutions: 2 })), (error: any) => error.name === "InvalidParameterValueException" && /cannot exceed/.test(error.message));

    const provisioned = lambda!.send(new InvokeCommand({ FunctionName: "reserved", Qualifier: "live", Payload: Buffer.from(JSON.stringify({ waitMs: 220 })) }));
    const spillover = lambda!.send(new InvokeCommand({ FunctionName: "reserved", Qualifier: "live", Payload: Buffer.from(JSON.stringify({ waitMs: 220 })) })); await delay(50);
    const reservedThrottle = await rawInvoke("reserved", { waitMs: 1 }, "live"); const reservedError = await reservedThrottle.json() as any; assert.equal(reservedThrottle.status, 429); assert.equal(reservedThrottle.headers.get("retry-after"), "1"); assert.equal(reservedError.Reason, "ReservedFunctionConcurrentInvocationLimitExceeded"); assert.equal(reservedError.retryAfterSeconds, "1");
    const results = await Promise.all([provisioned, spillover]); assert.deepEqual(new Set(results.map(parsePayload).map(value => value.initializationType)), new Set(["provisioned-concurrency", "on-demand"])); assert.ok(results.every(result => result.ExecutedVersion === version.Version));
    const resourceDimensions = [{ Name: "FunctionName", Value: "reserved" }, { Name: "Resource", Value: "reserved:live" }]; assert.equal(await metric("ProvisionedConcurrencyInvocations", resourceDimensions), 1); assert.equal(await metric("ProvisionedConcurrencySpilloverInvocations", resourceDimensions), 1); assert.equal(await metric("Throttles", resourceDimensions), 1); assert.equal(await metric("ProvisionedConcurrentExecutions", resourceDimensions, "Maximum"), 1);

    const crashed = await lambda!.send(new InvokeCommand({ FunctionName: "reserved", Qualifier: "live", Payload: Buffer.from(JSON.stringify({ crash: true })) })); assert.equal(crashed.FunctionError, "Unhandled");
    const afterCrash = await lambda!.send(new InvokeCommand({ FunctionName: "reserved", Qualifier: "live", Payload: Buffer.from("{}") })); assert.equal(afterCrash.FunctionError, undefined, "runtime exit releases its concurrency lease");

    await lambda!.send(new PutFunctionConcurrencyCommand({ FunctionName: "timeout", ReservedConcurrentExecutions: 1 }));
    const timed = lambda!.send(new InvokeCommand({ FunctionName: "timeout", Payload: Buffer.from("{}") })); await delay(50); const timeoutThrottle = await rawInvoke("timeout", {}); assert.equal(timeoutThrottle.status, 429); assert.equal((await timeoutThrottle.json() as any).Reason, "ReservedFunctionConcurrentInvocationLimitExceeded"); assert.equal((await timed).FunctionError, "Unhandled");
    assert.equal(parsePayload(await lambda!.send(new InvokeCommand({ FunctionName: "timeout", Payload: Buffer.from(JSON.stringify({ releaseProbe: true })) }))).released, true, "timeout releases its concurrency lease");

    const sharedOne = lambda!.send(new InvokeCommand({ FunctionName: "shared", Payload: Buffer.from(JSON.stringify({ waitMs: 220 })) })); const sharedTwo = lambda!.send(new InvokeCommand({ FunctionName: "shared", Payload: Buffer.from(JSON.stringify({ waitMs: 220 })) })); await delay(50);
    const accountThrottle = await rawInvoke("shared", { waitMs: 1 }); assert.equal(accountThrottle.status, 429); assert.equal((await accountThrottle.json() as any).Reason, "ConcurrentInvocationLimitExceeded"); await Promise.all([sharedOne, sharedTwo]); assert.equal((await lambda!.send(new GetAccountSettingsCommand({}))).AccountLimit?.UnreservedConcurrentExecutions, 2);

    const pending = await lambda!.send(new PutProvisionedConcurrencyConfigCommand({ FunctionName: "reserved", Qualifier: "live", ProvisionedConcurrentExecutions: 1 })); assert.equal(pending.Status, "IN_PROGRESS"); disconnect(); await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, lambdaConcurrentExecutions: 5, lambdaUnreservedConcurrencyReserve: 1, authMode: "off"}); await simulator.start(); connect(); assert.equal((await lambda!.send(new GetProvisionedConcurrencyConfigCommand({ FunctionName: "reserved", Qualifier: "live" }))).Status, "READY"); assert.equal((await lambda!.send(new GetFunctionConcurrencyCommand({ FunctionName: "reserved" }))).ReservedConcurrentExecutions, 2);

    await assert.rejects(lambda!.send(new DeleteAliasCommand({ FunctionName: "reserved", Name: "live" })), (error: any) => error.name === "ResourceConflictException" && /provisioned concurrency/.test(error.message));
    await lambda!.send(new DeleteProvisionedConcurrencyConfigCommand({ FunctionName: "reserved", Qualifier: "live" })); await assert.rejects(lambda!.send(new GetProvisionedConcurrencyConfigCommand({ FunctionName: "reserved", Qualifier: "live" })), (error: any) => error.name === "ProvisionedConcurrencyConfigNotFoundException"); await lambda!.send(new DeleteAliasCommand({ FunctionName: "reserved", Name: "live" }));
    await assert.rejects(lambda!.send(new DeleteFunctionCommand({ FunctionName: "reserved", Qualifier: version.Version })), (error: any) => error.name === "ResourceConflictException" && /provisioned concurrency/.test(error.message)); await lambda!.send(new DeleteProvisionedConcurrencyConfigCommand({ FunctionName: "reserved", Qualifier: version.Version! })); await lambda!.send(new DeleteFunctionCommand({ FunctionName: "reserved", Qualifier: version.Version }));
    await lambda!.send(new DeleteFunctionConcurrencyCommand({ FunctionName: "reserved" })); assert.equal((await lambda!.send(new GetFunctionConcurrencyCommand({ FunctionName: "reserved" }))).ReservedConcurrentExecutions, undefined); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally { disconnect(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
