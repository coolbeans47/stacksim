import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  CreateCodeSigningConfigCommand,
  CreateFunctionCommand,
  DeleteCodeSigningConfigCommand,
  DeleteFunctionCodeSigningConfigCommand,
  GetCodeSigningConfigCommand,
  GetFunctionCodeSigningConfigCommand,
  GetFunctionConfigurationCommand,
  GetFunctionRecursionConfigCommand,
  GetRuntimeManagementConfigCommand,
  InvokeCommand,
  LambdaClient,
  ListCodeSigningConfigsCommand,
  ListFunctionsByCodeSigningConfigCommand,
  ListTagsCommand,
  PublishVersionCommand,
  PutFunctionCodeSigningConfigCommand,
  PutFunctionRecursionConfigCommand,
  PutRuntimeManagementConfigCommand,
  TagResourceCommand,
  UpdateCodeSigningConfigCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { slashPath } from "./support/platform.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const role = "arn:aws:iam::000000000000:role/test";

function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function zip(entries: Array<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = []; const centralParts: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const content = Buffer.from(entry.content); const checksum = crc32(content); const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    const part = Buffer.concat([local, name, content]); localParts.push(part); centralParts.push(Buffer.concat([central, name])); offset += part.length;
  }
  const directory = Buffer.concat(centralParts); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...localParts, directory, end]);
}

const source = `
const os = require("node:os");
exports.handler = async (_event, context) => {
  console.debug("debug-hidden");
  console.error("error-visible");
  return { tmp: os.tmpdir(), configuredSize: process.env.STACKSIM_LAMBDA_EPHEMERAL_STORAGE_SIZE, logGroup: context.logGroupName };
};
`;
const code = zip([{ name: "index.js", content: source }, { name: "package.json", content: '{"type":"commonjs"}' }]);
const payload = (value: any) => JSON.parse(Buffer.from(value.Payload ?? []).toString("utf8"));

test("Lambda advanced configuration, runtime management, recursion settings, and code signing round trip through the SDK and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-configuration-")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); let lambda: LambdaClient | undefined; let logs: CloudWatchLogsClient | undefined;
  const connect = () => { const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }; lambda = new LambdaClient(options); logs = new CloudWatchLogsClient(options); };
  const disconnect = () => { lambda?.destroy(); logs?.destroy(); lambda = undefined; logs = undefined; };
  try {
    await simulator.start(); connect();
    await simulator.sqs.CreateQueue({ QueueName: "stored-only" });
    const signerArn = `arn:aws:signer:${region}:000000000000:/signing-profiles/local_profile/abc123`;
    const signing = await lambda!.send(new CreateCodeSigningConfigCommand({ AllowedPublishers: { SigningProfileVersionArns: [signerArn] }, CodeSigningPolicies: { UntrustedArtifactOnDeployment: "Warn" }, Description: "local validation reference", Tags: { owner: "platform" } })); const signingArn = signing.CodeSigningConfig!.CodeSigningConfigArn!;
    assert.equal((await lambda!.send(new GetCodeSigningConfigCommand({ CodeSigningConfigArn: signingArn }))).CodeSigningConfig?.Description, "local validation reference");
    const spare = await lambda!.send(new CreateCodeSigningConfigCommand({ AllowedPublishers: { SigningProfileVersionArns: [signerArn] } })); const listedPage = await lambda!.send(new ListCodeSigningConfigsCommand({ MaxItems: 1 })); assert.equal(listedPage.CodeSigningConfigs?.length, 1); assert.ok(listedPage.NextMarker); await lambda!.send(new DeleteCodeSigningConfigCommand({ CodeSigningConfigArn: spare.CodeSigningConfig!.CodeSigningConfigArn! }));
    const created = await lambda!.send(new CreateFunctionCommand({
      FunctionName: "configured", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: code }, CodeSigningConfigArn: signingArn,
      Architectures: ["arm64"], EphemeralStorage: { Size: 1024 }, Environment: { Variables: { APP_MODE: "test" } }, TracingConfig: { Mode: "Active" }, DeadLetterConfig: { TargetArn: `arn:aws:sqs:${region}:000000000000:stored-only` },
      FileSystemConfigs: [{ Arn: `arn:aws:elasticfilesystem:${region}:000000000000:access-point/fsap-0123456789abcdef0`, LocalMountPath: "/mnt/shared" }], VpcConfig: { SubnetIds: ["subnet-0123abcd"], SecurityGroupIds: ["sg-0123abcd"], Ipv6AllowedForDualStack: true }, KMSKeyArn: `arn:aws:kms:${region}:000000000000:key/12345678-abcd-1234-abcd-1234567890ab`,
      LoggingConfig: { LogFormat: "JSON", ApplicationLogLevel: "ERROR", SystemLogLevel: "INFO", LogGroup: "/stacksim/lambda/configured" },
    })); await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(created.Architectures, ["arm64"]); assert.equal(created.EphemeralStorage?.Size, 1024); assert.equal(created.LoggingConfig?.LogGroup, "/stacksim/lambda/configured"); assert.equal(created.TracingConfig?.Mode, "Active"); assert.equal(created.DeadLetterConfig?.TargetArn, `arn:aws:sqs:${region}:000000000000:stored-only`); assert.equal(created.FileSystemConfigs?.[0].LocalMountPath, "/mnt/shared"); assert.deepEqual(created.VpcConfig?.SubnetIds, ["subnet-0123abcd"]); assert.equal(created.KMSKeyArn?.endsWith("1234567890ab"), true);
    const configuredState = simulator.store.regionState(region).functions.configured; configuredState.environmentError = { errorCode: "KMSAccessDeniedException", message: "The environment could not be decrypted" }; await simulator.store.save(); assert.deepEqual((await lambda!.send(new GetFunctionConfigurationCommand({ FunctionName: "configured" }))).Environment?.Error, { ErrorCode: "KMSAccessDeniedException", Message: "The environment could not be decrypted" }); delete configuredState.environmentError; await simulator.store.save();
    await assert.rejects(lambda!.send(new UpdateFunctionConfigurationCommand({ FunctionName: "configured", RevisionId: "stale", Timeout: 4 })), (error: any) => error.name === "PreconditionFailedException");
    await assert.rejects(lambda!.send(new UpdateFunctionConfigurationCommand({ FunctionName: "configured", EphemeralStorage: { Size: 511 } })), (error: any) => error.name === "InvalidParameterValueException");
    await assert.rejects(lambda!.send(new UpdateFunctionConfigurationCommand({ FunctionName: "configured", VpcConfig: { SubnetIds: ["subnet-0123abcd"], SecurityGroupIds: [] } })), (error: any) => error.name === "InvalidParameterValueException");
    assert.equal((await lambda!.send(new GetFunctionCodeSigningConfigCommand({ FunctionName: "configured" }))).CodeSigningConfigArn, signingArn);
    assert.deepEqual((await lambda!.send(new ListFunctionsByCodeSigningConfigCommand({ CodeSigningConfigArn: signingArn }))).FunctionArns, [created.FunctionArn]);
    await lambda!.send(new TagResourceCommand({ Resource: signingArn, Tags: { stage: "test" } })); assert.equal((await lambda!.send(new ListTagsCommand({ Resource: signingArn }))).Tags?.stage, "test");
    const runtimeArn = `arn:aws:lambda:${region}::runtime:nodejs22-local-1`; const runtime = await lambda!.send(new PutRuntimeManagementConfigCommand({ FunctionName: "configured", Qualifier: "$LATEST", UpdateRuntimeOn: "Manual", RuntimeVersionArn: runtimeArn })); assert.equal(runtime.UpdateRuntimeOn, "Manual"); assert.equal(runtime.RuntimeVersionArn, runtimeArn);
    assert.equal((await lambda!.send(new GetFunctionRecursionConfigCommand({ FunctionName: "configured" }))).RecursiveLoop, "Terminate"); await lambda!.send(new PutFunctionRecursionConfigCommand({ FunctionName: "configured", RecursiveLoop: "Allow" })); assert.equal((await lambda!.send(new GetFunctionRecursionConfigCommand({ FunctionName: "configured" }))).RecursiveLoop, "Allow");
    const version = await lambda!.send(new PublishVersionCommand({ FunctionName: "configured" })); assert.equal((await lambda!.send(new GetRuntimeManagementConfigCommand({ FunctionName: "configured", Qualifier: version.Version }))).RuntimeVersionArn, runtimeArn);
    const invoked = payload(await lambda!.send(new InvokeCommand({ FunctionName: "configured", Payload: Buffer.from("{}") }))); assert.match(slashPath(invoked.tmp), /runtime\/lambda\/[^/]+\/tmp$/); assert.equal(invoked.configuredSize, "1024"); assert.equal(invoked.logGroup, "/stacksim/lambda/configured"); const events = await logs!.send(new FilterLogEventsCommand({ logGroupName: "/stacksim/lambda/configured" })); const messages = events.events?.map(event => event.message ?? "") ?? []; assert.ok(messages.some(message => message.includes('"level":"ERROR"') && message.includes("error-visible"))); assert.ok(messages.some(message => message.includes('"type":"platform.start"'))); assert.ok(!messages.some(message => message.includes("debug-hidden")));
    disconnect(); await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); await simulator.start(); connect();
    const restarted = await lambda!.send(new GetFunctionConfigurationCommand({ FunctionName: "configured" })); assert.deepEqual(restarted.Architectures, ["arm64"]); assert.equal(restarted.EphemeralStorage?.Size, 1024); assert.equal(restarted.LoggingConfig?.LogFormat, "JSON"); assert.equal(restarted.VpcConfig?.Ipv6AllowedForDualStack, true); assert.equal((await lambda!.send(new GetRuntimeManagementConfigCommand({ FunctionName: "configured", Qualifier: "$LATEST" }))).RuntimeVersionArn, runtimeArn); assert.equal((await lambda!.send(new GetFunctionRecursionConfigCommand({ FunctionName: "configured" }))).RecursiveLoop, "Allow");
    await lambda!.send(new UpdateCodeSigningConfigCommand({ CodeSigningConfigArn: signingArn, CodeSigningPolicies: { UntrustedArtifactOnDeployment: "Enforce" }, Description: "enforced locally" })); await assert.rejects(lambda!.send(new UpdateFunctionCodeCommand({ FunctionName: "configured", ZipFile: code })), (error: any) => error.name === "InvalidCodeSignatureException"); await lambda!.send(new UpdateCodeSigningConfigCommand({ CodeSigningConfigArn: signingArn, CodeSigningPolicies: { UntrustedArtifactOnDeployment: "Warn" } })); assert.equal((await lambda!.send(new UpdateFunctionCodeCommand({ FunctionName: "configured", ZipFile: code }))).FunctionName, "configured");
    await assert.rejects(lambda!.send(new DeleteCodeSigningConfigCommand({ CodeSigningConfigArn: signingArn })), (error: any) => error.name === "ResourceConflictException"); await lambda!.send(new DeleteFunctionCodeSigningConfigCommand({ FunctionName: "configured" })); await assert.rejects(lambda!.send(new GetFunctionCodeSigningConfigCommand({ FunctionName: "configured" })), (error: any) => error.name === "CodeSigningConfigNotFoundException"); await lambda!.send(new PutFunctionCodeSigningConfigCommand({ FunctionName: "configured", CodeSigningConfigArn: signingArn })); assert.equal((await lambda!.send(new GetFunctionCodeSigningConfigCommand({ FunctionName: "configured" }))).CodeSigningConfigArn, signingArn); await lambda!.send(new DeleteFunctionCodeSigningConfigCommand({ FunctionName: "configured" })); await lambda!.send(new DeleteCodeSigningConfigCommand({ CodeSigningConfigArn: signingArn }));
    assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally { disconnect(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("Lambda propagates local invocation lineage, terminates at 16, and rejects host-incompatible native artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-lineage-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); let lambda: LambdaClient | undefined;
  try {
    await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; lambda = new LambdaClient({ endpoint, region, credentials }); await lambda.send(new CreateFunctionCommand({ FunctionName: "lineage", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Code: { ZipFile: code } })); await new Promise(resolve => setTimeout(resolve, 10)); await lambda.send(new InvokeCommand({ FunctionName: "lineage", Payload: Buffer.from("{}") }));
    const sessions = () => Object.values(simulator.store.ensureAccount().iam.sessions); const first = sessions().find(session => session.lambdaLineage?.length === 1)!; assert.ok(first); const firstMaterial = simulator.store.credentialStore!.get(first.credentialId!, { type: "sts-session", accountId: "000000000000", ownerId: first.principalId, accessKeyId: first.accessKeyId }); assert(firstMaterial?.sessionToken); const nested = new LambdaClient({ endpoint, region, credentials: { accessKeyId: first.accessKeyId, secretAccessKey: firstMaterial.secretAccessKey, sessionToken: firstMaterial.sessionToken } }); await nested.send(new InvokeCommand({ FunctionName: "lineage", Payload: Buffer.from("{}") })); nested.destroy(); assert.ok(sessions().some(session => session.lambdaLineage?.length === 2), "runtime credentials carry the caller lineage into the next local invocation");
    first.lambdaLineage = Array.from({ length: 16 }, (_, index) => `arn:aws:lambda:${region}:000000000000:function:lineage:${index}`); const terminating = new LambdaClient({ endpoint, region, credentials: { accessKeyId: first.accessKeyId, secretAccessKey: firstMaterial.secretAccessKey, sessionToken: firstMaterial.sessionToken } }); await assert.rejects(terminating.send(new InvokeCommand({ FunctionName: "lineage", Payload: Buffer.from("{}") })), (error: any) => error.name === "RecursiveInvocationException"); await lambda.send(new PutFunctionRecursionConfigCommand({ FunctionName: "lineage", RecursiveLoop: "Allow" })); assert.equal(payload(await terminating.send(new InvokeCommand({ FunctionName: "lineage", Payload: Buffer.from("{}") }))).configuredSize, "512"); terminating.destroy();
    const opposite = process.arch === "arm64" ? "x86_64" : "arm64"; await lambda.send(new CreateFunctionCommand({ FunctionName: "portable", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Architectures: [opposite], Code: { ZipFile: code } })); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(payload(await lambda.send(new InvokeCommand({ FunctionName: "portable", Payload: Buffer.from("{}") }))).configuredSize, "512"); const nativeCode = zip([{ name: "index.js", content: "exports.handler = async () => 'never';" }, { name: "addon.node", content: "\u007fELF" }]); await lambda.send(new CreateFunctionCommand({ FunctionName: "native-mismatch", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Architectures: [opposite], Code: { ZipFile: nativeCode } })); await new Promise(resolve => setTimeout(resolve, 10)); await assert.rejects(lambda.send(new InvokeCommand({ FunctionName: "native-mismatch", Payload: Buffer.from("{}") })), (error: any) => error.name === "InvalidRuntimeException" && /host architecture/.test(error.message));
  } finally { lambda?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
