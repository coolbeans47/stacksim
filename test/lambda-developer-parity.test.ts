import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudFormationClient, CreateStackCommand, DescribeStackEventsCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  CreateFunctionCommand,
  GetFunctionConfigurationCommand,
  InvokeCommand,
  LambdaClient,
  ListLayersCommand,
  PublishLayerVersionCommand,
  type Runtime,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";

// LDP-01 rows of lambda-developer-parity-gaps.md: LDG-01 (S3 code on create),
// LDG-02 (AWS-shaped initialization errors), and LDG-05 (layer runtimes).
// LDG-03 is covered in lambda-event-source-mappings.test.ts and LDG-04 in
// cloudformation-cdk-s3-notifications.test.ts.

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const role = "arn:aws:iam::000000000000:role/test";

interface Clients { endpoint: string; lambda: LambdaClient; s3: S3Client; logs: CloudWatchLogsClient; cloudformation: CloudFormationClient }

async function withSimulator(prefix: string, run: (clients: Clients) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `stacksim-${prefix}-`));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  let clients: Clients | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    clients = { endpoint, lambda: new LambdaClient({ endpoint, region, credentials }), s3: new S3Client({ endpoint, region, credentials, forcePathStyle: true }), logs: new CloudWatchLogsClient({ endpoint, region, credentials }), cloudformation: new CloudFormationClient({ endpoint, region, credentials }) };
    await run(clients);
  } finally {
    clients?.lambda.destroy(); clients?.s3.destroy(); clients?.logs.destroy(); clients?.cloudformation.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const payloadOf = (result: { Payload?: Uint8Array }) => JSON.parse(Buffer.from(result.Payload!).toString("utf8"));
const tailOf = (result: { LogResult?: string }) => Buffer.from(result.LogResult!, "base64").toString("utf8");
const inline = (content: string, name = "index.mjs") => createZip([{ name, content }]);

test("LDG-01: CreateFunction accepts a deployment package stored in local S3", async () => {
  await withSimulator("ldg01", async ({ lambda, s3 }) => {
    const zip = inline("export const handler = async () => ({ source: \"s3\" });");
    const updated = inline("export const handler = async () => ({ source: \"s3-v2\" });");
    await s3.send(new CreateBucketCommand({ Bucket: "deploy-packages" }));
    await s3.send(new PutObjectCommand({ Bucket: "deploy-packages", Key: "function.zip", Body: zip }));
    await s3.send(new PutObjectCommand({ Bucket: "deploy-packages", Key: "function-v2.zip", Body: updated }));

    const created = await lambda.send(new CreateFunctionCommand({ FunctionName: "from-s3", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { S3Bucket: "deploy-packages", S3Key: "function.zip" } }));
    assert.equal(created.CodeSha256, createHash("sha256").update(zip).digest("base64"));
    assert.equal(created.CodeSize, zip.length);
    await settle();
    assert.deepEqual(payloadOf(await lambda.send(new InvokeCommand({ FunctionName: "from-s3", Payload: Buffer.from("{}") }))), { source: "s3" });

    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: "from-s3", S3Bucket: "deploy-packages", S3Key: "function-v2.zip" }));
    await settle();
    assert.deepEqual(payloadOf(await lambda.send(new InvokeCommand({ FunctionName: "from-s3", Payload: Buffer.from("{}") }))), { source: "s3-v2" });

    await assert.rejects(
      lambda.send(new CreateFunctionCommand({ FunctionName: "missing-object", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { S3Bucket: "deploy-packages", S3Key: "nope.zip" } })),
      (error: any) => error.name === "InvalidParameterValueException" && /NoSuchKey/.test(error.message),
    );
    await assert.rejects(
      lambda.send(new CreateFunctionCommand({ FunctionName: "no-code", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { S3Bucket: "deploy-packages" } })),
      (error: any) => error.name === "InvalidParameterValueException" && /S3Bucket and S3Key/.test(error.message),
    );
  });
});

test("LDG-02: initialization failures are function errors with Runtime.* types and logged init output", async () => {
  await withSimulator("ldg02", async ({ lambda, logs }) => {
    const cases = [
      { name: "wrong-handler", handler: "index.nope", code: inline("export const handler = async () => 1;"), errorType: "Runtime.HandlerNotFound", message: /^index\.nope is undefined or not exported$/ },
      { name: "missing-module", handler: "missing.handler", code: inline("export const handler = async () => 1;"), errorType: "Runtime.ImportModuleError", message: /Cannot find module 'missing'/ },
      { name: "syntax-error", handler: "index.handler", code: inline("export const handler = async () => {"), errorType: "Runtime.UserCodeSyntaxError", message: /^SyntaxError: / },
      { name: "missing-dependency", handler: "index.handler", code: inline("import \"left-pad-missing\";\nexport const handler = async () => 1;"), errorType: "Runtime.ImportModuleError", message: /left-pad-missing/ },
      { name: "init-throw", handler: "index.handler", code: inline("console.log(\"init log line\");\nthrow new Error(\"boom at init\");"), errorType: "Error", message: /^boom at init$/ },
    ];
    for (const item of cases) await lambda.send(new CreateFunctionCommand({ FunctionName: item.name, Runtime: "nodejs22.x", Role: role, Handler: item.handler, Code: { ZipFile: item.code } }));
    await settle();

    for (const item of cases) {
      const result = await lambda.send(new InvokeCommand({ FunctionName: item.name, LogType: "Tail", Payload: Buffer.from("{}") }));
      assert.equal(result.StatusCode, 200, item.name);
      assert.equal(result.FunctionError, "Unhandled", item.name);
      const payload = payloadOf(result);
      assert.equal(payload.errorType, item.errorType, item.name);
      assert.match(payload.errorMessage, item.message, item.name);
      assert.ok(Array.isArray(payload.trace), `${item.name} trace`);
      const tail = tailOf(result);
      assert.match(tail, /Uncaught Exception\t\{"errorType":/, item.name);
      assert.match(tail, new RegExp(`INIT_REPORT Init Duration: [0-9.]+ ms\\tPhase: init\\tStatus: error\\tError Type: ${item.errorType.replace(".", "\\.")}`), item.name);
      assert.ok(tail.indexOf("INIT_REPORT") < tail.indexOf("START RequestId:"), `${item.name} INIT_REPORT precedes START`);
      assert.match(tail, /REPORT RequestId: /, item.name);
    }

    // Init-phase console output reaches the function log before the report.
    const tail = tailOf(await lambda.send(new InvokeCommand({ FunctionName: "init-throw", LogType: "Tail", Payload: Buffer.from("{}") })));
    assert.ok(tail.indexOf("init log line") < tail.indexOf("INIT_REPORT"), "init log precedes INIT_REPORT");
    const events = await logs.send(new FilterLogEventsCommand({ logGroupName: "/aws/lambda/init-throw", filterPattern: "INIT_REPORT" }));
    assert.ok((events.events?.length ?? 0) >= 1, "INIT_REPORT is in CloudWatch Logs");

    // An asynchronous invocation of a failing function is still accepted.
    assert.equal((await lambda.send(new InvokeCommand({ FunctionName: "wrong-handler", InvocationType: "Event", Payload: Buffer.from("{}") }))).StatusCode, 202);

    // Fixing the handler recovers without a stuck execution environment.
    await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: "wrong-handler", Handler: "index.handler" }));
    await settle();
    assert.equal((await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "wrong-handler" }))).LastUpdateStatus, "Successful");
    const fixed = await lambda.send(new InvokeCommand({ FunctionName: "wrong-handler", Payload: Buffer.from("{}") }));
    assert.equal(fixed.FunctionError, undefined);
    assert.equal(payloadOf(fixed), 1);
  });
});

test("LDG-05: layers accept every Lambda runtime identifier and nodejs24.x functions attach them", async () => {
  await withSimulator("ldg05", async ({ lambda }) => {
    const layerZip = createZip([{ name: "nodejs/node_modules/greeter/index.js", content: "module.exports.greet = name => `hello ${name}`;" }]);
    const published = await lambda.send(new PublishLayerVersionCommand({ LayerName: "greeter", CompatibleRuntimes: ["nodejs24.x", "python3.12"], CompatibleArchitectures: ["x86_64", "arm64"], Content: { ZipFile: layerZip } }));
    assert.deepEqual(published.CompatibleRuntimes, ["nodejs24.x", "python3.12"]);

    for (const runtime of ["nodejs24.x", "python3.12"] as Runtime[]) {
      const listed = await lambda.send(new ListLayersCommand({ CompatibleRuntime: runtime }));
      assert.deepEqual(listed.Layers?.map(layer => layer.LayerName), ["greeter"], runtime);
    }
    assert.deepEqual((await lambda.send(new ListLayersCommand({ CompatibleRuntime: "nodejs22.x" }))).Layers, []);
    const unknownRuntime = "nodejs99.x" as Runtime;
    await assert.rejects(lambda.send(new ListLayersCommand({ CompatibleRuntime: unknownRuntime })), (error: any) => error.name === "InvalidParameterValueException");
    await assert.rejects(
      lambda.send(new PublishLayerVersionCommand({ LayerName: "bogus", CompatibleRuntimes: [unknownRuntime], Content: { ZipFile: layerZip } })),
      (error: any) => error.name === "InvalidParameterValueException",
    );

    await lambda.send(new CreateFunctionCommand({ FunctionName: "node24-with-layer", Runtime: "nodejs24.x", Role: role, Handler: "index.handler", Layers: [published.LayerVersionArn!], Code: { ZipFile: inline("const { greet } = require(\"greeter\"); exports.handler = async () => greet(\"layer\");", "index.js") } }));
    await settle();
    assert.equal(payloadOf(await lambda.send(new InvokeCommand({ FunctionName: "node24-with-layer", Payload: Buffer.from("{}") }))), "hello layer");
    await assert.rejects(
      lambda.send(new CreateFunctionCommand({ FunctionName: "node22-with-layer", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Layers: [published.LayerVersionArn!], Code: { ZipFile: inline("exports.handler = async () => 1;", "index.js") } })),
      (error: any) => error.name === "InvalidParameterValueException",
    );
  });
});

// LDP-02 rows: LDG-06 through LDG-14.

test("LDG-06/09/12: error payloads use trace, timeouts are Sandbox.Timedout, and a non-serialisable return is a TypeError", async () => {
  await withSimulator("ldp02-errors", async ({ lambda }) => {
    await lambda.send(new CreateFunctionCommand({ FunctionName: "throws", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: inline("export const handler = async () => { throw new Error(\"boom\"); };") } }));
    await lambda.send(new CreateFunctionCommand({ FunctionName: "throws-string", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: inline("export const handler = async () => { throw \"plain string\"; };") } }));
    await lambda.send(new CreateFunctionCommand({ FunctionName: "slow", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Timeout: 1, Code: { ZipFile: inline("export const handler = async () => { await new Promise(resolve => setTimeout(resolve, 5000)); };") } }));
    await lambda.send(new CreateFunctionCommand({ FunctionName: "circular", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: inline("let calls = 0; export const handler = async event => { calls++; if (event.circular) { const self = {}; self.self = self; return self; } return { calls }; };") } }));
    await settle();

    const thrown = await lambda.send(new InvokeCommand({ FunctionName: "throws", Payload: Buffer.from("{}") }));
    const thrownPayload = payloadOf(thrown);
    assert.equal(thrown.FunctionError, "Unhandled");
    assert.deepEqual(Object.keys(thrownPayload).sort(), ["errorMessage", "errorType", "trace"]);
    assert.equal(thrownPayload.errorType, "Error"); assert.equal(thrownPayload.errorMessage, "boom");
    assert.equal(thrownPayload.trace[0], "Error: boom");
    assert.ok(thrownPayload.trace.length > 1 && thrownPayload.trace.every((frame: string) => !frame.includes("lambda-runner")), "the runtime's own frames are not in the trace");

    assert.deepEqual(payloadOf(await lambda.send(new InvokeCommand({ FunctionName: "throws-string", Payload: Buffer.from("{}") }))), { errorType: "string", errorMessage: "plain string", trace: [] });

    const timedOut = await lambda.send(new InvokeCommand({ FunctionName: "slow", LogType: "Tail", Payload: Buffer.from("{}") }));
    const timeoutPayload = payloadOf(timedOut);
    assert.equal(timedOut.FunctionError, "Unhandled");
    assert.equal(timeoutPayload.errorType, "Sandbox.Timedout");
    assert.match(timeoutPayload.errorMessage, /^RequestId: [0-9a-f-]+ Error: Task timed out after 1\.00 seconds$/);
    const timeoutTail = tailOf(timedOut);
    assert.match(timeoutTail, /^RequestId: [0-9a-f-]+ Error: Task timed out after 1\.00 seconds$/m);
    assert.match(timeoutTail, /REPORT RequestId: .*\tStatus: timeout\tError Type: Sandbox\.Timedout$/m);

    const circular = await lambda.send(new InvokeCommand({ FunctionName: "circular", Payload: Buffer.from("{\"circular\":true}") }));
    assert.equal(circular.FunctionError, "Unhandled");
    assert.equal(payloadOf(circular).errorType, "TypeError");
    // The execution environment survives the serialization failure.
    assert.deepEqual(payloadOf(await lambda.send(new InvokeCommand({ FunctionName: "circular", Payload: Buffer.from("{}") }))), { calls: 2 });
  });
});

test("LDG-07/08: text logs carry the AWS prefix and REPORT shows whole-MB memory and Init Duration on cold starts only", async () => {
  await withSimulator("ldp02-logs", async ({ lambda }) => {
    const code = inline("export const handler = async () => { console.log(\"line one\\nline two\"); console.error(\"to stderr\"); process.stdout.write(\"raw\\n\"); return \"ok\"; };");
    await lambda.send(new CreateFunctionCommand({ FunctionName: "logging", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: code } }));
    await lambda.send(new CreateFunctionCommand({ FunctionName: "logging-json", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: code }, LoggingConfig: { LogFormat: "JSON" } }));
    await settle();

    const cold = await lambda.send(new InvokeCommand({ FunctionName: "logging", LogType: "Tail", Payload: Buffer.from("{}") }));
    const coldTail = tailOf(cold); const requestId = cold.$metadata.requestId!;
    const prefix = `\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\t${requestId}\\t`;
    assert.match(coldTail, new RegExp(`^${prefix}INFO\\tline one\\rline two$`, "m"));
    assert.match(coldTail, new RegExp(`^${prefix}ERROR\\tto stderr$`, "m"));
    assert.match(coldTail, new RegExp(`^${prefix}INFO\\traw$`, "m"));
    assert.match(coldTail, /^REPORT RequestId: \S+\tDuration: [\d.]+ ms\tBilled Duration: \d+ ms\tMemory Size: 128 MB\tMax Memory Used: \d+ MB\tInit Duration: [\d.]+ ms$/m);

    const warm = await lambda.send(new InvokeCommand({ FunctionName: "logging", LogType: "Tail", Payload: Buffer.from("{}") }));
    assert.match(tailOf(warm), /^REPORT RequestId: \S+\tDuration: [\d.]+ ms\tBilled Duration: \d+ ms\tMemory Size: 128 MB\tMax Memory Used: \d+ MB$/m);

    const jsonTail = tailOf(await lambda.send(new InvokeCommand({ FunctionName: "logging-json", LogType: "Tail", Payload: Buffer.from("{}") })));
    const records = jsonTail.trim().split("\n").map(line => JSON.parse(line));
    const report = records.find(record => record.type === "platform.report").record;
    assert.equal(report.status, "success"); assert.ok(report.metrics.initDurationMs > 0); assert.ok(Number.isInteger(report.metrics.memorySizeMB));
    assert.ok(records.some(record => record.level === "ERROR" && record.message === "to stderr" && typeof record.timestamp === "string"));
  });
});

test("LDG-10: the runtime waits for the event loop unless callbackWaitsForEmptyEventLoop is false", async () => {
  await withSimulator("ldp02-event-loop", async ({ lambda }) => {
    await lambda.send(new CreateFunctionCommand({ FunctionName: "pending-timer", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: inline("export const handler = async (event, context) => { if (event.noWait) context.callbackWaitsForEmptyEventLoop = false; setTimeout(() => {}, 400); return { waits: context.callbackWaitsForEmptyEventLoop }; };") } }));
    await lambda.send(new CreateFunctionCommand({ FunctionName: "interval-leak", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Timeout: 1, Code: { ZipFile: inline("export const handler = async () => { setInterval(() => {}, 100); return \"leaked\"; };") } }));
    await settle();

    let started = Date.now();
    assert.deepEqual(payloadOf(await lambda.send(new InvokeCommand({ FunctionName: "pending-timer", Payload: Buffer.from("{}") }))), { waits: true });
    assert.ok(Date.now() - started >= 380, "the default waits for the pending timer");
    started = Date.now();
    assert.deepEqual(payloadOf(await lambda.send(new InvokeCommand({ FunctionName: "pending-timer", Payload: Buffer.from("{\"noWait\":true}") }))), { waits: false });
    assert.ok(Date.now() - started < 300, "callbackWaitsForEmptyEventLoop=false responds at once");

    // The classic open-handle mistake times out, as on AWS.
    const leaked = await lambda.send(new InvokeCommand({ FunctionName: "interval-leak", Payload: Buffer.from("{}") }));
    assert.equal(leaked.FunctionError, "Unhandled"); assert.equal(payloadOf(leaked).errorType, "Sandbox.Timedout");
  });
});

test("LDG-11/13: reserved environment variables, UTC, and /tmp match the AWS execution environment", async () => {
  await withSimulator("ldp02-env", async ({ lambda }) => {
    const code = inline("import { writeFileSync, readFileSync } from \"node:fs\"; export const handler = async (event, context) => { const path = `/tmp/stacksim-parity-${process.pid}.txt`; writeFileSync(path, \"scratch\"); return { env: Object.fromEntries([\"_HANDLER\", \"AWS_EXECUTION_ENV\", \"AWS_LAMBDA_LOG_GROUP_NAME\", \"AWS_LAMBDA_LOG_STREAM_NAME\", \"LAMBDA_RUNTIME_DIR\", \"TZ\"].map(name => [name, process.env[name]])), logStreamName: context.logStreamName, date: new Date(0).toString(), tmp: readFileSync(path, \"utf8\") }; };");
    await lambda.send(new CreateFunctionCommand({ FunctionName: "env", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: code } }));
    await lambda.send(new CreateFunctionCommand({ FunctionName: "env-tokyo", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: code }, Environment: { Variables: { TZ: "Asia/Tokyo" } } }));
    await settle();

    const result = payloadOf(await lambda.send(new InvokeCommand({ FunctionName: "env", Payload: Buffer.from("{}") })));
    assert.equal(result.env._HANDLER, "index.handler");
    assert.equal(result.env.AWS_EXECUTION_ENV, "AWS_Lambda_nodejs22.x");
    assert.equal(result.env.AWS_LAMBDA_LOG_GROUP_NAME, "/aws/lambda/env");
    assert.equal(result.env.AWS_LAMBDA_LOG_STREAM_NAME, result.logStreamName);
    assert.ok(result.env.LAMBDA_RUNTIME_DIR);
    assert.equal(result.env.TZ, "UTC"); assert.match(result.date, /GMT\+0000/);
    assert.equal(result.tmp, "scratch");
    assert.match(payloadOf(await lambda.send(new InvokeCommand({ FunctionName: "env-tokyo", Payload: Buffer.from("{}") }))).date, /GMT\+0900/);
  });
});

test("LDG-14: a failed code update leaves LastUpdateStatus=Failed and blocks invocation until an update succeeds", async () => {
  await withSimulator("ldp02-failed-update", async ({ lambda }) => {
    await lambda.send(new CreateFunctionCommand({ FunctionName: "updated", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: inline("export const handler = async () => 1;") } }));
    await settle();
    await assert.rejects(lambda.send(new UpdateFunctionCodeCommand({ FunctionName: "updated", ZipFile: Buffer.from("this is not a zip archive") })), (error: any) => error.name === "InvalidParameterValueException");
    const failed = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "updated" }));
    assert.equal(failed.LastUpdateStatus, "Failed"); assert.equal(failed.LastUpdateStatusReasonCode, "InvalidZipFileException"); assert.ok(failed.LastUpdateStatusReason);
    await assert.rejects(lambda.send(new InvokeCommand({ FunctionName: "updated", Payload: Buffer.from("{}") })), (error: any) => error.name === "ResourceConflictException" && /last update failed/.test(error.message));
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: "updated", ZipFile: inline("export const handler = async () => 2;") }));
    await settle();
    const recovered = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "updated" }));
    assert.equal(recovered.LastUpdateStatus, "Successful"); assert.equal(recovered.LastUpdateStatusReasonCode, undefined);
    assert.equal(payloadOf(await lambda.send(new InvokeCommand({ FunctionName: "updated", Payload: Buffer.from("{}") }))), 2);
  });
});

test("LDG-05: CloudFormation AWS::Lambda::LayerVersion accepts nodejs24.x and a nodejs24.x function attaches it", async () => {
  await withSimulator("ldg05-cfn", async ({ lambda, s3, cloudformation }) => {
    await s3.send(new CreateBucketCommand({ Bucket: "layer-content" }));
    await s3.send(new PutObjectCommand({ Bucket: "layer-content", Key: "greeter.zip", Body: createZip([{ name: "nodejs/node_modules/greeter/index.js", content: "module.exports.greet = name => `hello ${name} from cfn`;" }]) }));
    const template = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        Greeter: { Type: "AWS::Lambda::LayerVersion", Properties: { LayerName: "cfn-greeter", CompatibleRuntimes: ["nodejs24.x", "nodejs22.x"], Content: { S3Bucket: "layer-content", S3Key: "greeter.zip" } } },
        Fn: { Type: "AWS::Lambda::Function", Properties: { FunctionName: "cfn-node24-with-layer", Runtime: "nodejs24.x", Handler: "index.handler", Role: role, Layers: [{ Ref: "Greeter" }], Code: { ZipFile: "const { greet } = require(\"greeter\"); exports.handler = async () => greet(\"layer\");" } } },
      },
    };
    await cloudformation.send(new CreateStackCommand({ StackName: "node24-layer", TemplateBody: JSON.stringify(template) }));
    for (let attempt = 0; ; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const status = (await cloudformation.send(new DescribeStacksCommand({ StackName: "node24-layer" }))).Stacks?.[0]?.StackStatus;
      if (status === "CREATE_COMPLETE") break;
      if (status?.includes("FAILED") || status?.includes("ROLLBACK")) {
        const events = (await cloudformation.send(new DescribeStackEventsCommand({ StackName: "node24-layer" }))).StackEvents ?? [];
        assert.fail(`${status}: ${events.filter(event => event.ResourceStatus?.includes("FAILED")).map(event => `${event.LogicalResourceId}: ${event.ResourceStatusReason}`).join(" | ")}`);
      }
      assert.ok(attempt < 400, `stack did not complete (last status ${status})`);
    }
    assert.equal(payloadOf(await lambda.send(new InvokeCommand({ FunctionName: "cfn-node24-with-layer", Payload: Buffer.from("{}") }))), "hello layer from cfn");
  });
});
