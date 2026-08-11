import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AddLayerVersionPermissionCommand,
  CreateFunctionCommand,
  DeleteLayerVersionCommand,
  GetFunctionCommand,
  GetLayerVersionByArnCommand,
  GetLayerVersionCommand,
  GetLayerVersionPolicyCommand,
  InvokeCommand,
  LambdaClient,
  ListLayersCommand,
  ListLayerVersionsCommand,
  PublishLayerVersionCommand,
  PublishVersionCommand,
  RemoveLayerVersionPermissionCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { slashPath } from "./support/platform.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const role = "arn:aws:iam::000000000000:role/test";

function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function zip(entries: Array<{ name: string; content: string; mode?: number }>): Buffer {
  const localParts: Buffer[] = []; const centralParts: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const content = Buffer.from(entry.content); const checksum = crc32(content); const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    const localPart = Buffer.concat([local, name, content]); localParts.push(localPart); centralParts.push(Buffer.concat([central, name])); offset += localPart.length;
  }
  const directory = Buffer.concat(centralParts); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...localParts, directory, end]);
}
const moduleLayer = (source: string) => zip([{ name: "nodejs/node_modules/shared-value/index.js", content: `module.exports = { source: ${JSON.stringify(source)} };` }]);
const functionZip = zip([
  { name: "index.js", content: 'exports.handler = async () => ({ source: require("shared-value").source, optDir: process.env.STACKSIM_LAMBDA_OPT_DIR, taskRoot: process.env.LAMBDA_TASK_ROOT, nodePath: process.env.NODE_PATH });' },
  { name: "package.json", content: '{"type":"commonjs"}' },
]);
const payload = (result: any) => JSON.parse(Buffer.from(result.Payload ?? []).toString("utf8"));

test("Lambda layers provide immutable ordered runtime content, policies, validation, safe extraction, deletion, and restart persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-layers-")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); let lambda: LambdaClient | undefined;
  const connect = () => lambda = new LambdaClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
  const disconnect = () => { lambda?.destroy(); lambda = undefined; };
  try {
    await simulator.start(); connect();
    const first = await lambda!.send(new PublishLayerVersionCommand({ LayerName: "shared", Description: "first", Content: { ZipFile: moduleLayer("first") }, CompatibleRuntimes: ["nodejs22.x"], CompatibleArchitectures: ["x86_64"], LicenseInfo: "MIT" }));
    const second = await lambda!.send(new PublishLayerVersionCommand({ LayerName: "shared", Description: "second", Content: { ZipFile: moduleLayer("second") }, CompatibleRuntimes: ["nodejs22.x"], CompatibleArchitectures: ["x86_64"] }));
    assert.equal(first.Version, 1); assert.equal(second.Version, 2); assert.match(first.Content?.Location ?? "", /^file:\/\//); assert.equal(first.Content?.CodeSize, moduleLayer("first").length);
    assert.equal((await lambda!.send(new GetLayerVersionCommand({ LayerName: "shared", VersionNumber: 1 }))).LicenseInfo, "MIT"); assert.equal((await lambda!.send(new GetLayerVersionByArnCommand({ Arn: second.LayerVersionArn! }))).Version, 2);
    const page1 = await lambda!.send(new ListLayerVersionsCommand({ LayerName: "shared", MaxItems: 1 })); assert.deepEqual(page1.LayerVersions?.map(version => version.Version), [2]); assert.ok(page1.NextMarker); const page2 = await lambda!.send(new ListLayerVersionsCommand({ LayerName: "shared", MaxItems: 1, Marker: page1.NextMarker })); assert.deepEqual(page2.LayerVersions?.map(version => version.Version), [1]);
    const listed = await lambda!.send(new ListLayersCommand({ CompatibleRuntime: "nodejs22.x", CompatibleArchitecture: "x86_64" })); assert.equal(listed.Layers?.[0].LatestMatchingVersion?.Version, 2); assert.equal(listed.Layers?.[0].LayerName, "shared");

    const permission = await lambda!.send(new AddLayerVersionPermissionCommand({ LayerName: "shared", VersionNumber: 2, StatementId: "external", Action: "lambda:GetLayerVersion", Principal: "111122223333" })); const statement = JSON.parse(permission.Statement!); assert.deepEqual(statement.Principal, { AWS: "arn:aws:iam::111122223333:root" }); const policy = await lambda!.send(new GetLayerVersionPolicyCommand({ LayerName: "shared", VersionNumber: 2 })); assert.equal(JSON.parse(policy.Policy!).Statement[0].Sid, "external"); await assert.rejects(lambda!.send(new RemoveLayerVersionPermissionCommand({ LayerName: "shared", VersionNumber: 2, StatementId: "external", RevisionId: "wrong" })), (error: any) => error.name === "PreconditionFailedException"); await lambda!.send(new RemoveLayerVersionPermissionCommand({ LayerName: "shared", VersionNumber: 2, StatementId: "external", RevisionId: policy.RevisionId })); await assert.rejects(lambda!.send(new GetLayerVersionPolicyCommand({ LayerName: "shared", VersionNumber: 2 })), (error: any) => error.name === "ResourceNotFoundException");

    const incompatible = await lambda!.send(new PublishLayerVersionCommand({ LayerName: "node20-only", Content: { ZipFile: moduleLayer("node20") }, CompatibleRuntimes: ["nodejs20.x"], CompatibleArchitectures: ["arm64"] })); await assert.rejects(lambda!.send(new CreateFunctionCommand({ FunctionName: "incompatible", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: functionZip }, Layers: [incompatible.LayerVersionArn!] })), (error: any) => error.name === "InvalidParameterValueException" && /not compatible/.test(error.message));
    await assert.rejects(lambda!.send(new PublishLayerVersionCommand({ LayerName: "traversal", Content: { ZipFile: zip([{ name: "../escape.js", content: "bad" }]) } })), (error: any) => error.name === "InvalidParameterValueException" && /unsafe path/.test(error.message)); await assert.rejects(lambda!.send(new PublishLayerVersionCommand({ LayerName: "symlink", Content: { ZipFile: zip([{ name: "nodejs/link", content: "../escape", mode: 0o120777 }]) } })), (error: any) => error.name === "InvalidParameterValueException" && /symbolic links/.test(error.message));

    const created = await lambda!.send(new CreateFunctionCommand({ FunctionName: "layered", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: functionZip }, Layers: [first.LayerVersionArn!, second.LayerVersionArn!] })); assert.deepEqual(created.Layers?.map(layer => layer.Arn), [first.LayerVersionArn, second.LayerVersionArn]); await new Promise(resolve => setImmediate(resolve)); const ordered = payload(await lambda!.send(new InvokeCommand({ FunctionName: "layered", Payload: Buffer.from("{}") }))); assert.equal(ordered.source, "second", "later layers overwrite earlier layers"); const optDir = slashPath(ordered.optDir); assert.match(optDir, /runtime\/lambda\//); assert.equal(slashPath(ordered.taskRoot), optDir.replace(/\/opt$/, "/task")); assert.match(slashPath(ordered.nodePath), /\/opt\/nodejs\/node22\/node_modules/);
    const published = await lambda!.send(new PublishVersionCommand({ FunctionName: "layered" })); await lambda!.send(new UpdateFunctionConfigurationCommand({ FunctionName: "layered", Layers: [first.LayerVersionArn!] })); await new Promise(resolve => setImmediate(resolve)); assert.equal(payload(await lambda!.send(new InvokeCommand({ FunctionName: "layered", Payload: Buffer.from("{}") }))).source, "first"); assert.equal(payload(await lambda!.send(new InvokeCommand({ FunctionName: "layered", Qualifier: published.Version, Payload: Buffer.from("{}") }))).source, "second", "published function versions retain their layer order");

    await lambda!.send(new DeleteLayerVersionCommand({ LayerName: "shared", VersionNumber: 2 })); await assert.rejects(lambda!.send(new GetLayerVersionCommand({ LayerName: "shared", VersionNumber: 2 })), (error: any) => error.name === "ResourceNotFoundException"); assert.deepEqual((await lambda!.send(new ListLayerVersionsCommand({ LayerName: "shared" }))).LayerVersions?.map(version => version.Version), [1]); assert.equal(payload(await lambda!.send(new InvokeCommand({ FunctionName: "layered", Qualifier: published.Version, Payload: Buffer.from("{}") }))).source, "second", "deletion does not break an attached immutable function snapshot");
    const third = await lambda!.send(new PublishLayerVersionCommand({ LayerName: "shared", Content: { ZipFile: moduleLayer("third") }, CompatibleRuntimes: ["nodejs22.x"], CompatibleArchitectures: ["x86_64"] })); assert.equal(third.Version, 3, "deleted version numbers are never reused");

    disconnect(); await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); await simulator.start(); connect(); assert.equal(payload(await lambda!.send(new InvokeCommand({ FunctionName: "layered", Qualifier: published.Version, Payload: Buffer.from("{}") }))).source, "second"); assert.equal((await lambda!.send(new GetFunctionCommand({ FunctionName: "layered", Qualifier: published.Version }))).Configuration?.Layers?.[1].Arn, second.LayerVersionArn); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally { disconnect(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
