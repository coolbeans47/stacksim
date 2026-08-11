import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateFunctionCommand, GetAccountSettingsCommand, GetFunctionConfigurationCommand, InvokeCommand, LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("Lambda invocation captures isolated runtime logs, tail output, errors, timeout, context, pagination, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-fidelity-")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off"}); let lambda: LambdaClient | undefined; let logs: CloudWatchLogsClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; lambda = new LambdaClient({ endpoint, region: "eu-west-1", credentials }); logs = new CloudWatchLogsClient({ endpoint, region: "eu-west-1", credentials }); const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    const create = async (name: string, handler: string, timeout = 3) => lambda!.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: handler, Timeout: timeout, Code: { ZipFile: zip } }));
    const created = await create("logging", "handler.loggingHandler"); assert.equal(created.State, "Pending");
    await create("throwing", "handler.throwingHandler"); await create("callback-error", "handler.callbackErrorHandler"); await create("timeout", "handler.timeoutHandler", 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "logging" }))).State, "Active");
    assert.equal((await lambda.send(new GetAccountSettingsCommand({}))).AccountUsage?.FunctionCount, 4);
    const first = await lambda.send(new ListFunctionsCommand({ MaxItems: 2 })); assert.equal(first.Functions?.length, 2); assert.ok(first.NextMarker); const second = await lambda.send(new ListFunctionsCommand({ MaxItems: 2, Marker: first.NextMarker })); assert.equal(second.Functions?.length, 2);

    const clientContext = Buffer.from(JSON.stringify({ custom: { lesson: "logs" } })).toString("base64");
    const success = await lambda.send(new InvokeCommand({ FunctionName: "logging", LogType: "Tail", ClientContext: clientContext, Payload: Buffer.from(JSON.stringify({ message: "visible", logBytes: 5000 })) }));
    assert.equal(success.FunctionError, undefined); assert.ok(success.LogResult); const tail = Buffer.from(success.LogResult!, "base64").toString("utf8"); assert.ok(Buffer.byteLength(tail) <= 4096); assert.match(tail, /REPORT RequestId:/);
    const payload = JSON.parse(Buffer.from(success.Payload!).toString("utf8")); assert.equal(payload.clientContext.custom.lesson, "logs"); assert.equal(payload.logGroup, "/aws/lambda/logging"); assert.ok(payload.remaining > 0 && payload.remaining <= 3000);
    const streams = await logs.send(new DescribeLogStreamsCommand({ logGroupName: "/aws/lambda/logging", orderBy: "LastEventTime", descending: true })); assert.equal(streams.logStreams?.length, 1); const events = await logs.send(new GetLogEventsCommand({ logGroupName: "/aws/lambda/logging", logStreamName: streams.logStreams![0].logStreamName!, startFromHead: true })); const messages = events.events?.map(event => event.message) ?? []; assert.match(messages.join("\n"), /stdout:visible/); assert.match(messages.join("\n"), /stderr:visible/); assert.match(messages.join("\n"), /START RequestId:/);

    for (const [name, pattern] of [["throwing", /intentional failure/], ["callback-error", /callback failure/]] as const) { const invocation: any = await lambda.send(new InvokeCommand({ FunctionName: name, Payload: Buffer.from("{}") })); assert.equal(invocation.FunctionError, "Unhandled"); assert.match(Buffer.from(invocation.Payload!).toString("utf8"), pattern); }
    const timed = await lambda.send(new InvokeCommand({ FunctionName: "timeout", Payload: Buffer.from("{}") })); assert.equal(timed.FunctionError, "Unhandled"); assert.match(Buffer.from(timed.Payload!).toString("utf8"), /timed out after 1\.00 seconds/);

    const pending = simulator.store.regionState().functions.logging; pending.state = "Pending"; await assert.rejects(lambda.send(new InvokeCommand({ FunctionName: "logging", Payload: Buffer.from("{}") })), (error: any) => error.name === "ResourceConflictException"); pending.state = "Active"; await simulator.store.save();
    const malformed = await fetch(`${endpoint}/2015-03-31/functions/logging/invocations`, { method: "POST", body: "not-json" }); assert.equal(malformed.status, 400);
    const oversized = await fetch(`${endpoint}/2015-03-31/functions/logging/invocations`, { method: "POST", body: Buffer.alloc(6 * 1024 * 1024 + 1, 32) }); assert.equal(oversized.status, 413);

    lambda.destroy(); logs.destroy(); await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off"}); await simulator.start(); lambda = new LambdaClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
    const restarted = await lambda.send(new InvokeCommand({ FunctionName: "logging", Payload: Buffer.from('{"message":"restart"}') })); assert.equal(restarted.FunctionError, undefined);
  } finally { lambda?.destroy(); logs?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("Lambda defaults bare JavaScript handlers to CommonJS inside an ESM host package", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "stacksim-lambda-esm-host-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: join(packageRoot, ".stacksim"), region: "eu-west-1", authMode: "off"});
  let lambda: LambdaClient | undefined;
  try {
    await writeFile(join(packageRoot, "package.json"), '{"type":"module"}\n');
    await simulator.start();
    lambda = new LambdaClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
    await lambda.send(new CreateFunctionCommand({
      FunctionName: "commonjs-default",
      Runtime: "nodejs22.x",
      Role: "arn:aws:iam::000000000000:role/test",
      Handler: "index.handler",
      Code: { ZipFile: createZip([{ name: "index.js", content: "module.exports.handler = async () => ({ format: 'commonjs' });" }]) },
    }));
    await new Promise(resolve => setTimeout(resolve, 10));
    const invoked = await lambda.send(new InvokeCommand({ FunctionName: "commonjs-default", Payload: Buffer.from("{}") }));
    assert.equal(invoked.FunctionError, undefined);
    assert.deepEqual(JSON.parse(Buffer.from(invoked.Payload!).toString("utf8")), { format: "commonjs" });
  } finally {
    lambda?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(packageRoot, { recursive: true, force: true });
  }
});
