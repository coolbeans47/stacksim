import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AddPermissionCommand,
  CreateAliasCommand,
  CreateFunctionCommand,
  CreateFunctionUrlConfigCommand,
  DeleteFunctionUrlConfigCommand,
  GetFunctionUrlConfigCommand,
  GetPolicyCommand,
  InvokeWithResponseStreamCommand,
  LambdaClient,
  ListFunctionUrlConfigsCommand,
  PublishVersionCommand,
  RemovePermissionCommand,
  UpdateFunctionUrlConfigCommand,
} from "@aws-sdk/client-lambda";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const role = "arn:aws:iam::000000000000:role/test";

function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function zip(name: string, content: string): Buffer {
  const fileName = Buffer.from(name); const body = Buffer.from(content); const checksum = crc32(body); const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(fileName.length, 26); const centralOffset = local.length + fileName.length + body.length; const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + fileName.length, 12); end.writeUInt32LE(centralOffset, 16); return Buffer.concat([local, fileName, body, central, fileName, end]);
}

const source = `
exports.buffered = async (event, context) => ({
  statusCode: 201,
  headers: { "content-type": "application/json", "x-handler-version": context.functionVersion },
  cookies: ["session=local; Path=/"],
  body: JSON.stringify({ event, version: context.functionVersion })
});
exports.streamed = awslambda.streamifyResponse(async (event, responseStream, context) => {
  responseStream = awslambda.HttpResponseStream.from(responseStream, { statusCode: 202, headers: { "content-type": "text/plain", "x-handler-version": context.functionVersion }, cookies: ["stream=yes; Path=/"] });
  responseStream.write("first:");
  await new Promise(resolve => setTimeout(resolve, 80));
  responseStream.write(event.message || "second");
  responseStream.end();
  await responseStream.finished();
});
exports.invalidStream = awslambda.streamifyResponse(async (_event, responseStream) => {
  responseStream = awslambda.HttpResponseStream.from(responseStream, { statusCode: 700, headers: { "content-type": "text/plain" } });
  responseStream.end("invalid");
});
exports.timeoutStream = awslambda.streamifyResponse(async (_event, responseStream) => {
  responseStream = awslambda.HttpResponseStream.from(responseStream, { statusCode: 200, headers: { "content-type": "text/plain" } });
  responseStream.write("started");
  await new Promise(resolve => setTimeout(resolve, 1500));
  responseStream.end("late");
});
`;
const code = zip("index.js", source);

function signGet(value: string): Record<string, string> {
  const url = new URL(value); const now = new Date(); const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); const shortDate = amzDate.slice(0, 8); const payloadHash = createHash("sha256").update("").digest("hex"); const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); const canonicalQuery = [...url.searchParams.entries()].map(([key, item]) => [encode(key), encode(item)]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])).map(([key, item]) => `${key}=${item}`).join("&"); const canonicalHeaders = `host:${url.host}\nx-amz-date:${amzDate}\n`; const signedHeaders = "host;x-amz-date"; const canonicalRequest = `GET\n${url.pathname}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`; const scope = `${shortDate}/${region}/lambda/aws4_request`; const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`; const hmac = (key: Buffer | string, text: string) => createHmac("sha256", key).update(text).digest(); const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, shortDate), region), "lambda"), "aws4_request"); const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex"); return { "x-amz-date": amzDate, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

async function chunks(output: Awaited<ReturnType<LambdaClient["send"]>> | any): Promise<{ values: string[]; complete: any }> {
  const values: string[] = []; let complete: any;
  for await (const event of output.EventStream) { if (event.PayloadChunk) values.push(Buffer.from(event.PayloadChunk.Payload ?? []).toString("utf8")); if (event.InvokeComplete) complete = event.InvokeComplete; }
  return { values, complete };
}

test("Lambda function URLs support durable configs, public/IAM invocation, CORS, aliases, policy conditions, and streaming", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-urls-")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: true }); let lambda: LambdaClient | undefined;
  const connect = () => lambda = new LambdaClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }); const disconnect = () => { lambda?.destroy(); lambda = undefined; };
  try {
    await simulator.start(); connect(); await lambda!.send(new CreateFunctionCommand({ FunctionName: "url-handler", Runtime: "nodejs22.x", Role: role, Handler: "index.buffered", Code: { ZipFile: code } })); await lambda!.send(new CreateFunctionCommand({ FunctionName: "stream-handler", Runtime: "nodejs22.x", Role: role, Handler: "index.streamed", Code: { ZipFile: code } })); await lambda!.send(new CreateFunctionCommand({ FunctionName: "invalid-stream-handler", Runtime: "nodejs22.x", Role: role, Handler: "index.invalidStream", Code: { ZipFile: code } })); await lambda!.send(new CreateFunctionCommand({ FunctionName: "timeout-stream-handler", Runtime: "nodejs22.x", Role: role, Handler: "index.timeoutStream", Timeout: 1, Code: { ZipFile: code } })); await new Promise(resolve => setTimeout(resolve, 10));
    const publicConfig = await lambda!.send(new CreateFunctionUrlConfigCommand({ FunctionName: "url-handler", AuthType: "NONE", InvokeMode: "BUFFERED", Cors: { AllowOrigins: ["https://app.example"], AllowMethods: ["GET", "POST"], AllowHeaders: ["content-type", "x-token"], ExposeHeaders: ["x-handler-version"], AllowCredentials: true, MaxAge: 300 } })); assert.match(publicConfig.FunctionUrl!, new RegExp(`^http://127\\.0\\.0\\.1:${simulator.invokePort}/lambda-url/[a-f0-9]{32}/$`)); assert.equal(publicConfig.InvokeMode, "BUFFERED"); assert.equal((publicConfig as any).LastModifiedTime, undefined);
    await lambda!.send(new AddPermissionCommand({ FunctionName: "url-handler", StatementId: "public-url", Action: "lambda:InvokeFunctionUrl", Principal: "*", FunctionUrlAuthType: "NONE" })); await lambda!.send(new AddPermissionCommand({ FunctionName: "url-handler", StatementId: "public-invoke", Action: "lambda:InvokeFunction", Principal: "*", InvokedViaFunctionUrl: true }));
    const response = await fetch(`${publicConfig.FunctionUrl}greeting?tag=one&tag=two`, { method: "POST", headers: { origin: "https://app.example", "content-type": "application/json", cookie: "first=1; second=2" }, body: '{"hello":"world"}' }); assert.equal(response.status, 201); assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example"); assert.equal(response.headers.get("access-control-allow-credentials"), "true"); assert.equal(response.headers.get("access-control-expose-headers"), "x-handler-version"); assert.match(response.headers.get("set-cookie") ?? "", /session=local/); const output = await response.json() as any; assert.equal(output.event.version, "2.0"); assert.equal(output.event.rawPath, "/greeting"); assert.equal(output.event.rawQueryString, "tag=one&tag=two"); assert.equal(output.event.queryStringParameters.tag, "one,two"); assert.deepEqual(output.event.cookies, ["first=1", "second=2"]); assert.equal(output.event.requestContext.authorizer, null); assert.match(output.event.requestContext.time, /^\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2} \+0000$/); assert.equal(typeof output.event.requestContext.timeEpoch, "number"); assert.equal(output.event.requestContext.http.method, "POST"); assert.equal(output.event.body, '{"hello":"world"}');
    const preflight = await fetch(`${publicConfig.FunctionUrl}greeting`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-token" } }); assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-methods"), "GET,POST"); assert.equal(preflight.headers.get("access-control-max-age"), "300");

    const policy = await lambda!.send(new GetPolicyCommand({ FunctionName: "url-handler" })); await lambda!.send(new RemovePermissionCommand({ FunctionName: "url-handler", StatementId: "public-invoke", RevisionId: policy.RevisionId })); assert.equal((await fetch(publicConfig.FunctionUrl!)).status, 403, "both current function URL invocation actions must be allowed"); await lambda!.send(new AddPermissionCommand({ FunctionName: "url-handler", StatementId: "public-invoke", Action: "lambda:InvokeFunction", Principal: "*", InvokedViaFunctionUrl: true }));

    const version = await lambda!.send(new PublishVersionCommand({ FunctionName: "url-handler" })); await lambda!.send(new CreateAliasCommand({ FunctionName: "url-handler", Name: "live", FunctionVersion: version.Version! })); await lambda!.send(new CreateAliasCommand({ FunctionName: "url-handler", Name: "preview", FunctionVersion: version.Version! })); const iamConfig = await lambda!.send(new CreateFunctionUrlConfigCommand({ FunctionName: "url-handler", Qualifier: "live", AuthType: "AWS_IAM" })); await lambda!.send(new CreateFunctionUrlConfigCommand({ FunctionName: "url-handler", Qualifier: "preview", AuthType: "AWS_IAM" })); assert.equal((await fetch(iamConfig.FunctionUrl!)).status, 403); const signed = await fetch(`${iamConfig.FunctionUrl}signed`, { headers: signGet(`${iamConfig.FunctionUrl}signed`) }); assert.equal(signed.status, 201); const signedBody = await signed.json() as any; assert.equal(signedBody.version, version.Version); assert.equal(signedBody.event.requestContext.authorizer.iam.userArn, `arn:aws:iam::000000000000:user/admin`);
    const firstPage = await lambda!.send(new ListFunctionUrlConfigsCommand({ FunctionName: "url-handler", MaxItems: 1 })); assert.equal(firstPage.FunctionUrlConfigs?.length, 1); assert.ok(firstPage.NextMarker); const secondPage = await lambda!.send(new ListFunctionUrlConfigsCommand({ FunctionName: "url-handler", MaxItems: 1, Marker: firstPage.NextMarker })); assert.equal(secondPage.FunctionUrlConfigs?.length, 1); assert.notEqual(firstPage.FunctionUrlConfigs?.[0].FunctionArn, secondPage.FunctionUrlConfigs?.[0].FunctionArn);
    const updated = await lambda!.send(new UpdateFunctionUrlConfigCommand({ FunctionName: "url-handler", Qualifier: "live", InvokeMode: "RESPONSE_STREAM", AuthType: "AWS_IAM" })); assert.equal(updated.InvokeMode, "RESPONSE_STREAM"); assert.ok(updated.LastModifiedTime); const ordinaryStreamUrl = `${iamConfig.FunctionUrl}ordinary`; const ordinaryStream = await fetch(ordinaryStreamUrl, { headers: signGet(ordinaryStreamUrl) }); assert.equal(ordinaryStream.status, 200); const ordinaryStreamBody = await ordinaryStream.json() as any; assert.equal(ordinaryStreamBody.statusCode, 201); assert.equal(JSON.parse(ordinaryStreamBody.body).event.rawPath, "/ordinary"); await lambda!.send(new DeleteFunctionUrlConfigCommand({ FunctionName: "url-handler", Qualifier: "preview" })); await assert.rejects(lambda!.send(new GetFunctionUrlConfigCommand({ FunctionName: "url-handler", Qualifier: "preview" })), (error: any) => error.name === "ResourceNotFoundException");

    const direct = await lambda!.send(new InvokeWithResponseStreamCommand({ FunctionName: "stream-handler", Payload: Buffer.from('{"message":"second"}'), LogType: "Tail" })); assert.equal(direct.StatusCode, 200); assert.equal(direct.ResponseStreamContentType, "application/vnd.amazon.eventstream"); const iterator = direct.EventStream![Symbol.asyncIterator](); const startedAt = Date.now(); const firstChunk = await iterator.next(); assert.equal(Buffer.from(firstChunk.value.PayloadChunk.Payload).toString("utf8"), "first:"); const secondChunk = await iterator.next(); assert.equal(Buffer.from(secondChunk.value.PayloadChunk.Payload).toString("utf8"), "second"); assert.ok(Date.now() - startedAt >= 50, "the second chunk must arrive after the handler delay instead of being buffered with the first"); const completed = await iterator.next(); assert.equal(completed.value.InvokeComplete.ErrorCode, undefined); assert.ok(completed.value.InvokeComplete.LogResult); assert.equal((await iterator.next()).done, true);
    const invalidDirect = await chunks(await lambda!.send(new InvokeWithResponseStreamCommand({ FunctionName: "invalid-stream-handler", Payload: Buffer.from("{}") }))); assert.equal(invalidDirect.complete.ErrorCode, "Unhandled"); assert.match(invalidDirect.complete.ErrorDetails, /statusCode must be an integer/);
    const timeoutDirect = await chunks(await lambda!.send(new InvokeWithResponseStreamCommand({ FunctionName: "timeout-stream-handler", Payload: Buffer.from("{}") }))); assert.equal(timeoutDirect.values[0], "started"); assert.equal(timeoutDirect.complete.ErrorCode, "Unhandled"); assert.match(timeoutDirect.complete.ErrorDetails, /timed out/);
    const streamedConfig = await lambda!.send(new CreateFunctionUrlConfigCommand({ FunctionName: "stream-handler", AuthType: "NONE", InvokeMode: "RESPONSE_STREAM" })); await lambda!.send(new AddPermissionCommand({ FunctionName: "stream-handler", StatementId: "stream-public-url", Action: "lambda:InvokeFunctionUrl", Principal: "*", FunctionUrlAuthType: "NONE" })); await lambda!.send(new AddPermissionCommand({ FunctionName: "stream-handler", StatementId: "stream-public-invoke", Action: "lambda:InvokeFunction", Principal: "*", InvokedViaFunctionUrl: true })); const streamed = await fetch(streamedConfig.FunctionUrl!, { method: "POST", headers: { "content-type": "application/json" }, body: '{"message":"second"}' }); assert.equal(streamed.status, 202); assert.equal(streamed.headers.get("content-type"), "text/plain"); assert.match(streamed.headers.get("set-cookie") ?? "", /stream=yes/); const reader = streamed.body!.getReader(); const received: string[] = []; while (true) { const item = await reader.read(); if (item.done) break; received.push(Buffer.from(item.value).toString("utf8")); } assert.equal(received.join(""), "first:second");

    const stableUrl = publicConfig.FunctionUrl!; const dataPort = simulator.invokePort; disconnect(); await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: dataPort, dataDir: root, region, authMode: "enforce", cdkBootstrap: true }); await simulator.start(); connect(); assert.equal((await lambda!.send(new GetFunctionUrlConfigCommand({ FunctionName: "url-handler" }))).FunctionUrl, stableUrl); assert.equal((await fetch(stableUrl)).status, 201); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally { disconnect(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
