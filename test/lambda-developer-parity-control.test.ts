import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AddPermissionCommand,
  CreateAliasCommand,
  CreateFunctionCommand,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  GetPolicyCommand,
  InvokeCommand,
  LambdaClient,
  ListAliasesCommand,
  ListFunctionsCommand,
  PublishLayerVersionCommand,
  PublishVersionCommand,
  RemovePermissionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";
import { readZipEntries } from "../src/zip.js";

// LDP-03 rows of lambda-developer-parity-gaps.md: control-plane wire shapes and the CLI path.

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const role = `arn:aws:iam::${account}:role/test`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Clients { endpoint: string; lambda: LambdaClient; s3: S3Client }

async function withSimulator(prefix: string, run: (clients: Clients) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `stacksim-${prefix}-`));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  let clients: Clients | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    clients = { endpoint, lambda: new LambdaClient({ endpoint, region, credentials }), s3: new S3Client({ endpoint, region, credentials, forcePathStyle: true }) };
    await run(clients);
  } finally {
    clients?.lambda.destroy(); clients?.s3.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const inline = (content: string, name = "index.mjs") => createZip([{ name, content }]);
const payloadOf = (result: { Payload?: Uint8Array }) => JSON.parse(Buffer.from(result.Payload!).toString("utf8"));
const create = (lambda: LambdaClient, name: string, code = "export const handler = async () => 1;", extra: Record<string, unknown> = {}) => lambda.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: inline(code) }, ...extra }));

test("LDG-15/16/17: name forms, AWS timestamps and IDs, and the FunctionConfiguration shape", async () => {
  await withSimulator("ldp03-shape", async ({ lambda }) => {
    const created = await create(lambda, "shaped");
    assert.equal(created.State, "Pending"); assert.equal(created.StateReason, "The function is being created."); assert.equal(created.StateReasonCode, "Creating");
    assert.equal(created.LastUpdateStatus, undefined, "no update has happened yet");
    assert.match(created.LastModified!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+0000$/);
    assert.match(created.RevisionId!, uuid, "RevisionId is a UUID");
    await settle();

    const active = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "shaped" }));
    assert.equal(active.State, "Active"); assert.equal(active.StateReason, undefined); assert.equal(active.StateReasonCode, undefined); assert.equal(active.LastUpdateStatus, "Successful");
    assert.deepEqual(active.SnapStart, { ApplyOn: "None", OptimizationStatus: "Off" });
    assert.match(active.RuntimeVersionConfig?.RuntimeVersionArn ?? "", /^arn:aws:lambda:eu-west-1::runtime:[0-9a-f]{64}$/);
    assert.deepEqual(active.VpcConfig, { SubnetIds: [], SecurityGroupIds: [], VpcId: "", Ipv6AllowedForDualStack: false });
    for (const field of ["Environment", "Layers", "DeadLetterConfig", "FileSystemConfigs"] as const) assert.equal(active[field], undefined, `${field} is omitted when unset`);
    await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: "shaped", Environment: { Variables: { A1: "x" } } }));
    await settle();
    assert.deepEqual((await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "shaped" }))).Environment, { Variables: { A1: "x" } });

    // Partial ARN, full ARN, and qualified ARN forms, including on CreateFunction.
    const partial = `${account}:function:shaped`; const full = `arn:aws:lambda:${region}:${account}:function:shaped`;
    assert.equal((await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: partial }))).FunctionName, "shaped");
    assert.equal(payloadOf(await lambda.send(new InvokeCommand({ FunctionName: `${full}:$LATEST`, Payload: Buffer.from("{}") }))), 1);
    const byArn = await lambda.send(new CreateFunctionCommand({ FunctionName: `arn:aws:lambda:${region}:${account}:function:named-by-arn`, Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: inline("export const handler = async () => 2;") } }));
    assert.equal(byArn.FunctionName, "named-by-arn");
    await assert.rejects(lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "missing" })), (error: any) => error.name === "ResourceNotFoundException" && error.message === `Function not found: arn:aws:lambda:${region}:${account}:function:missing`);
  });
});

test("LDG-18/19/20: Code.Location downloads the package, ListFunctions ALL lists versions, and an unchanged publish reuses the version", async () => {
  await withSimulator("ldp03-code", async ({ lambda }) => {
    await create(lambda, "versioned", "export const handler = async () => \"v1\";"); await settle();
    const fetched = await lambda.send(new GetFunctionCommand({ FunctionName: "versioned" }));
    assert.equal(fetched.Code?.RepositoryType, "S3");
    assert.match(fetched.Code?.Location ?? "", /^http:\/\/127\.0\.0\.1:\d+\/_stacksim\/lambda\/code\/.+\.zip$/);
    const download = await fetch(fetched.Code!.Location!);
    assert.equal(download.status, 200); assert.equal(download.headers.get("content-type"), "application/zip");
    const entries = readZipEntries(Buffer.from(await download.arrayBuffer()));
    assert.deepEqual(entries.entries.map(entry => entry.name), ["index.mjs"]);
    assert.equal((await fetch(fetched.Code!.Location!.replace(/\.zip$/, "x.zip"))).status, 403, "a tampered link is refused");

    const first = await lambda.send(new PublishVersionCommand({ FunctionName: "versioned" }));
    const again = await lambda.send(new PublishVersionCommand({ FunctionName: "versioned" }));
    assert.equal(first.Version, "1"); assert.equal(again.Version, "1", "nothing changed, so no new version");
    await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: "versioned", MemorySize: 256 })); await settle();
    assert.equal((await lambda.send(new PublishVersionCommand({ FunctionName: "versioned" }))).Version, "2");
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: "versioned", ZipFile: inline("export const handler = async () => \"v3\";") })); await settle();
    assert.equal((await lambda.send(new PublishVersionCommand({ FunctionName: "versioned" }))).Version, "3");

    const latestOnly = await lambda.send(new ListFunctionsCommand({}));
    assert.deepEqual(latestOnly.Functions?.map(fn => fn.Version), ["$LATEST"]);
    const all = await lambda.send(new ListFunctionsCommand({ FunctionVersion: "ALL" }));
    assert.deepEqual(all.Functions?.map(fn => fn.Version), ["$LATEST", "1", "2", "3"]);
  });
});

test("LDG-21/22/23: $LATEST aliases, policy principal shapes, and the smaller wire details", async () => {
  await withSimulator("ldp03-wire", async ({ lambda }) => {
    await create(lambda, "aliased", "export const handler = async () => \"first\";"); await settle();
    const dev = await lambda.send(new CreateAliasCommand({ FunctionName: "aliased", Name: "dev", FunctionVersion: "$LATEST" }));
    assert.equal(dev.FunctionVersion, "$LATEST"); assert.equal(dev.RoutingConfig, undefined, "no routing config is reported without weights");
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: "aliased", ZipFile: inline("export const handler = async () => \"second\";") })); await settle();
    assert.equal(payloadOf(await lambda.send(new InvokeCommand({ FunctionName: "aliased:dev", Payload: Buffer.from("{}") }))), "second", "a $LATEST alias follows the latest code");
    assert.deepEqual((await lambda.send(new ListAliasesCommand({ FunctionName: "aliased", FunctionVersion: "$LATEST" }))).Aliases?.map(alias => alias.Name), ["dev"]);

    const added = await lambda.send(new AddPermissionCommand({ FunctionName: "aliased", StatementId: "s3", Action: "lambda:InvokeFunction", Principal: "s3.amazonaws.com", SourceArn: "arn:aws:s3:::some-bucket" }));
    assert.equal((added as any).RevisionId, undefined);
    assert.deepEqual(JSON.parse(added.Statement!).Principal, { Service: "s3.amazonaws.com" });
    await lambda.send(new AddPermissionCommand({ FunctionName: "aliased", StatementId: "account", Action: "lambda:InvokeFunction", Principal: "123456789012" }));
    const policy = JSON.parse((await lambda.send(new GetPolicyCommand({ FunctionName: "aliased" }))).Policy!);
    assert.deepEqual(policy.Statement.map((statement: any) => statement.Principal), [{ Service: "s3.amazonaws.com" }, { AWS: "123456789012" }]);
    await lambda.send(new RemovePermissionCommand({ FunctionName: "aliased", StatementId: "s3" }));
    await lambda.send(new RemovePermissionCommand({ FunctionName: "aliased", StatementId: "account" }));
    await assert.rejects(lambda.send(new GetPolicyCommand({ FunctionName: "aliased" })), (error: any) => error.name === "ResourceNotFoundException");

    await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: "aliased", Environment: { Variables: { KEEP: "1" } } })); await settle();
    await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: "aliased", Environment: {} })); await settle();
    assert.equal((await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "aliased" }))).Environment, undefined, "an empty Environment clears the variables");
    await assert.rejects(lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: "aliased", Environment: { Variables: { X: "1" } } })), (error: any) => error.name === "InvalidParameterValueException" && /at least two characters/.test(error.message));
  });
});

test("LDG-24/25: Python and other managed runtimes are intentionally unsupported, and layer content can come from S3", async () => {
  await withSimulator("ldp03-runtimes", async ({ lambda, s3 }) => {
    for (const runtime of ["python3.13", "python3.12", "java21", "provided.al2023"]) {
      await assert.rejects(
        lambda.send(new CreateFunctionCommand({ FunctionName: `rt-${runtime.replace(/\W/g, "")}`, Runtime: runtime as any, Role: role, Handler: "index.handler", Code: { ZipFile: inline("def handler(event, context): return 1", "index.py") } })),
        (error: any) => error.name === "InvalidParameterValueException" && /intentionally unsupported/.test(error.message) && /nodejs24\.x/.test(error.message),
        runtime,
      );
    }
    await create(lambda, "node-only"); await settle();
    await assert.rejects(lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: "node-only", Runtime: "python3.13" })), (error: any) => /intentionally unsupported/.test(error.message));
    assert.equal((await lambda.send(new ListFunctionsCommand({}))).Functions?.length, 1, "no Python function was created");

    await s3.send(new CreateBucketCommand({ Bucket: "layer-source" }));
    await s3.send(new PutObjectCommand({ Bucket: "layer-source", Key: "greeter.zip", Body: createZip([{ name: "nodejs/node_modules/greeter/index.js", content: "module.exports.greet = () => \"hello from s3 layer\";" }]) }));
    const layer = await lambda.send(new PublishLayerVersionCommand({ LayerName: "s3-greeter", CompatibleRuntimes: ["nodejs22.x"], Content: { S3Bucket: "layer-source", S3Key: "greeter.zip" } }));
    assert.match(layer.Content?.Location ?? "", /^http:\/\/127\.0\.0\.1:\d+\/_stacksim\/lambda\/code\/.+\.zip$/);
    await lambda.send(new CreateFunctionCommand({ FunctionName: "uses-s3-layer", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Layers: [layer.LayerVersionArn!], Code: { ZipFile: inline("const { greet } = require(\"greeter\"); exports.handler = async () => greet();", "index.js") } }));
    await settle();
    assert.equal(payloadOf(await lambda.send(new InvokeCommand({ FunctionName: "uses-s3-layer", Payload: Buffer.from("{}") }))), "hello from s3 layer");
    await assert.rejects(lambda.send(new PublishLayerVersionCommand({ LayerName: "s3-missing", Content: { S3Bucket: "layer-source", S3Key: "nope.zip" } })), (error: any) => error.name === "InvalidParameterValueException" && /NoSuchKey/.test(error.message));
  });
});
