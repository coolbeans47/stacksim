import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import {
  CreateAliasCommand,
  CreateFunctionCommand,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  InvokeCommand,
  LambdaClient,
  PublishVersionCommand,
  PutProvisionedConcurrencyConfigCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const role = "arn:aws:iam::000000000000:role/test";
const manifestMediaType = "application/vnd.oci.image.manifest.v1+json";

function digest(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

async function writeImage(root: string, imageUri: string, marker: string, architecture = "amd64"): Promise<string> {
  const blobs = join(root, "blobs", "sha256"); await mkdir(blobs, { recursive: true });
  const configBytes = Buffer.from(JSON.stringify({ architecture, os: "linux", config: { Labels: { marker } } })); const configDigest = digest(configBytes);
  await writeFile(join(blobs, configDigest.slice("sha256:".length)), configBytes);
  const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: manifestMediaType, config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: configBytes.length }, layers: [] })); const manifestDigest = digest(manifestBytes);
  await writeFile(join(blobs, manifestDigest.slice("sha256:".length)), manifestBytes);
  await writeFile(join(root, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(root, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: manifestMediaType, digest: manifestDigest, size: manifestBytes.length, annotations: { "org.opencontainers.image.ref.name": imageUri } }] }));
  return manifestDigest;
}

test("Lambda image functions resolve OCI references, pin versions, validate configuration, and survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-images-")); const ociRoot = join(root, "oci");
  const firstUri = `000000000000.dkr.ecr.${region}.amazonaws.com/lambda/image:first`; const secondUri = `000000000000.dkr.ecr.${region}.amazonaws.com/lambda/image:second`;
  const previousRoot = process.env.STACKSIM_LAMBDA_OCI_ROOT; const previousSocket = process.env.STACKSIM_LAMBDA_DOCKER_SOCKET;
  delete process.env.STACKSIM_LAMBDA_OCI_ROOT; delete process.env.STACKSIM_LAMBDA_DOCKER_SOCKET;
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); let lambda: LambdaClient | undefined;
  const connect = () => { lambda = new LambdaClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }); };
  const disconnect = () => { lambda?.destroy(); lambda = undefined; };
  try {
    await simulator.start(); connect();
    await assert.rejects(lambda!.send(new CreateFunctionCommand({ FunctionName: "disabled-image", PackageType: "Image", Role: role, Code: { ImageUri: firstUri } })), (error: any) => error.name === "InvalidParameterValueException" && /resolution is disabled/.test(error.message));
    process.env.STACKSIM_LAMBDA_OCI_ROOT = ociRoot; const firstDigest = await writeImage(ociRoot, firstUri, "first");
    const created = await lambda!.send(new CreateFunctionCommand({ FunctionName: "image-handler", PackageType: "Image", Role: role, Code: { ImageUri: firstUri }, Architectures: ["x86_64"], ImageConfig: { EntryPoint: ["/lambda-entrypoint.sh"], Command: ["app.handler"], WorkingDirectory: "/var/task" } }));
    assert.equal(created.PackageType, "Image"); assert.equal(created.Runtime, undefined); assert.equal(created.Handler, undefined); assert.deepEqual(created.ImageConfigResponse?.ImageConfig?.EntryPoint, ["/lambda-entrypoint.sh"]); assert.equal(created.ImageConfigResponse?.ImageConfig?.WorkingDirectory, "/var/task");
    const initial = await lambda!.send(new GetFunctionCommand({ FunctionName: "image-handler" })); assert.equal(initial.Code?.ImageUri, firstUri); assert.equal(initial.Code?.ResolvedImageUri, `${firstUri.slice(0, firstUri.lastIndexOf(":"))}@${firstDigest}`); assert.equal(initial.Code?.RepositoryType, "ECR");
    await assert.rejects(lambda!.send(new UpdateFunctionConfigurationCommand({ FunctionName: "image-handler", Runtime: "nodejs22.x" })), (error: any) => error.name === "InvalidParameterValueException" && /Runtime and Handler/.test(error.message));
    await assert.rejects(lambda!.send(new CreateFunctionCommand({ FunctionName: "bad-platform", PackageType: "Image", Role: role, Code: { ImageUri: firstUri }, Architectures: ["arm64"] })), (error: any) => error.name === "InvalidParameterValueException" && /does not match/.test(error.message));
    const configured = await lambda!.send(new UpdateFunctionConfigurationCommand({ FunctionName: "image-handler", ImageConfig: { Command: ["updated.handler"] }, Timeout: 12 })); assert.deepEqual(configured.ImageConfigResponse?.ImageConfig?.EntryPoint, ["/lambda-entrypoint.sh"]); assert.deepEqual(configured.ImageConfigResponse?.ImageConfig?.Command, ["updated.handler"]); assert.equal(configured.Timeout, 12);
    const published = await lambda!.send(new PublishVersionCommand({ FunctionName: "image-handler" })); await lambda!.send(new CreateAliasCommand({ FunctionName: "image-handler", Name: "stable", FunctionVersion: published.Version! }));
    await assert.rejects(lambda!.send(new PutProvisionedConcurrencyConfigCommand({ FunctionName: "image-handler", Qualifier: "stable", ProvisionedConcurrentExecutions: 1 })), (error: any) => error.name === "InvalidParameterValueException" && /reusable prewarmed Docker containers/.test(error.message));
    const secondDigest = await writeImage(ociRoot, secondUri, "second"); const updated = await lambda!.send(new UpdateFunctionCodeCommand({ FunctionName: "image-handler", ImageUri: secondUri, Publish: true })); assert.equal(updated.CodeSha256, Buffer.from(secondDigest.slice("sha256:".length), "hex").toString("base64")); assert.equal(updated.Version, "2"); assert.equal((await lambda!.send(new GetFunctionCommand({ FunctionName: "image-handler", Qualifier: "2" }))).Code?.ResolvedImageUri, `${secondUri.slice(0, secondUri.lastIndexOf(":"))}@${secondDigest}`);
    const latest = await lambda!.send(new GetFunctionCommand({ FunctionName: "image-handler" })); assert.equal(latest.Code?.ResolvedImageUri, `${secondUri.slice(0, secondUri.lastIndexOf(":"))}@${secondDigest}`);
    const pinned = await lambda!.send(new GetFunctionCommand({ FunctionName: "image-handler", Qualifier: "stable" })); assert.equal(pinned.Code?.ResolvedImageUri, `${firstUri.slice(0, firstUri.lastIndexOf(":"))}@${firstDigest}`);
    await assert.rejects(lambda!.send(new UpdateFunctionCodeCommand({ FunctionName: "image-handler", ZipFile: Buffer.from("not-a-zip") })), (error: any) => error.name === "InvalidParameterValueException" && /ImageUri is required/.test(error.message));
    await assert.rejects(lambda!.send(new InvokeCommand({ FunctionName: "image-handler", Payload: Buffer.from("{}") })), (error: any) => error.name === "InvalidRuntimeException" && /OCI root filesystems are never host-executed/.test(error.message));
    disconnect(); await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); await simulator.start(); connect();
    const restarted = await lambda!.send(new GetFunctionConfigurationCommand({ FunctionName: "image-handler" })); assert.equal(restarted.PackageType, "Image"); assert.deepEqual(restarted.ImageConfigResponse?.ImageConfig?.Command, ["updated.handler"]); assert.equal((await lambda!.send(new GetFunctionCommand({ FunctionName: "image-handler", Qualifier: published.Version }))).Code?.ResolvedImageUri, `${firstUri.slice(0, firstUri.lastIndexOf(":"))}@${firstDigest}`); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  } finally {
    disconnect(); await simulator.stop().catch(() => undefined); if (previousRoot === undefined) delete process.env.STACKSIM_LAMBDA_OCI_ROOT; else process.env.STACKSIM_LAMBDA_OCI_ROOT = previousRoot; if (previousSocket === undefined) delete process.env.STACKSIM_LAMBDA_DOCKER_SOCKET; else process.env.STACKSIM_LAMBDA_DOCKER_SOCKET = previousSocket; await rm(root, { recursive: true, force: true });
  }
});

test("Lambda Docker images use inspect-only resolution and an isolated Runtime API container with timeout cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-lambda-docker-images-")); const socket = process.platform === "win32" ? `\\\\.\\pipe\\stacksim-lambda-docker-${randomUUID()}` : join(root, "docker.sock"); const imageUri = `000000000000.dkr.ecr.${region}.amazonaws.com/lambda/docker:current`; const imageDigest = `sha256:${"a".repeat(64)}`; const requests: string[] = []; let available = false; let runtimeMode: "success" | "timeout" = "success"; let containerConfig: any; let waitResponse: any; let runtimeFailure: unknown;
  const simulateRuntime = async () => { const address = String((containerConfig.Env as string[]).find(value => value.startsWith("AWS_LAMBDA_RUNTIME_API="))).split("=").slice(1).join("=").replace("host.docker.internal", "127.0.0.1"); const next = await fetch(`http://${address}/2018-06-01/runtime/invocation/next`); assert.equal(next.status, 200); const event = await next.json(); const requestId = next.headers.get("lambda-runtime-aws-request-id")!; const response = await fetch(`http://${address}/2018-06-01/runtime/invocation/${encodeURIComponent(requestId)}/response`, { method: "POST", body: JSON.stringify({ from: "container", event }) }); assert.equal(response.status, 202); };
  const docker = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`); res.setHeader("content-type", "application/json"); const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith(`/v1.41/images/${encodeURIComponent(imageUri)}/json`)) { if (!available) { res.statusCode = 404; return res.end(JSON.stringify({ message: "No such image" })); } return res.end(JSON.stringify({ Os: "linux", Architecture: "amd64", RepoDigests: [`${imageUri.slice(0, imageUri.lastIndexOf(":"))}@${imageDigest}`], Size: 1234 })); }
    if (req.method === "POST" && url === "/v1.41/networks/create") { res.statusCode = 201; return res.end(JSON.stringify({ Id: "network-id" })); }
    if (req.method === "GET" && url === "/v1.41/networks/network-id") return res.end(JSON.stringify({ IPAM: { Config: [{ Gateway: "127.0.0.1" }] } }));
    if (req.method === "POST" && url.startsWith("/v1.41/containers/create?")) { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); containerConfig = JSON.parse(Buffer.concat(chunks).toString("utf8")); res.statusCode = 201; return res.end(JSON.stringify({ Id: "container-id" })); }
    if (req.method === "POST" && url === "/v1.41/containers/container-id/start") { res.statusCode = 204; res.end(); if (runtimeMode === "success") setImmediate(() => { void simulateRuntime().catch(error => { runtimeFailure = error; }); }); return; }
    if (req.method === "POST" && url.startsWith("/v1.41/containers/container-id/wait")) { waitResponse = res; return; }
    if (req.method === "POST" && url.startsWith("/v1.41/containers/container-id/kill")) { res.statusCode = 204; res.end(); if (waitResponse) { waitResponse.end(JSON.stringify({ StatusCode: 137 })); waitResponse = undefined; } return; }
    if (req.method === "GET" && url.startsWith("/v1.41/containers/container-id/logs")) return res.end();
    if (req.method === "DELETE" && (url.startsWith("/v1.41/containers/container-id") || url === "/v1.41/networks/network-id")) { res.statusCode = 204; return res.end(); }
    res.statusCode = 500; return res.end(JSON.stringify({ message: `Unexpected fake Docker request ${req.method} ${url}` }));
  });
  await new Promise<void>((resolve, reject) => { docker.once("error", reject); docker.listen(socket, resolve); });
  const previousRoot = process.env.STACKSIM_LAMBDA_OCI_ROOT; const previousSocket = process.env.STACKSIM_LAMBDA_DOCKER_SOCKET; delete process.env.STACKSIM_LAMBDA_OCI_ROOT; process.env.STACKSIM_LAMBDA_DOCKER_SOCKET = socket;
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off"}); let lambda: LambdaClient | undefined;
  try {
    await simulator.start(); lambda = new LambdaClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
    await assert.rejects(lambda.send(new CreateFunctionCommand({ FunctionName: "missing-docker-image", PackageType: "Image", Role: role, Code: { ImageUri: imageUri } })), (error: any) => error.name === "InvalidParameterValueException" && /implicit pulls are disabled/.test(error.message));
    assert.deepEqual(requests, [`GET /v1.41/images/${encodeURIComponent(imageUri)}/json`]); available = true;
    const created = await lambda.send(new CreateFunctionCommand({ FunctionName: "local-docker-image", PackageType: "Image", Role: role, Code: { ImageUri: imageUri }, ImageConfig: { Command: ["app.handler"] } })); assert.equal(created.PackageType, "Image"); assert.equal((await lambda.send(new GetFunctionCommand({ FunctionName: "local-docker-image" }))).Code?.ResolvedImageUri, `${imageUri.slice(0, imageUri.lastIndexOf(":"))}@${imageDigest}`); assert.equal(requests.length, 2); assert.ok(requests.every(request => request.startsWith("GET ")), "image resolution must not issue a Docker pull or mutation request");
    const invoked = await lambda.send(new InvokeCommand({ FunctionName: "local-docker-image", Payload: Buffer.from('{"hello":"image"}') })); assert.equal(invoked.FunctionError, undefined); assert.deepEqual(JSON.parse(Buffer.from(invoked.Payload ?? []).toString("utf8")), { from: "container", event: { hello: "image" } }); assert.equal(runtimeFailure, undefined);
    assert.equal(containerConfig.Image, `${imageUri.slice(0, imageUri.lastIndexOf(":"))}@${imageDigest}`); assert.equal(containerConfig.User, "1000:1000"); assert.deepEqual(containerConfig.Cmd, ["app.handler"]); assert.equal(containerConfig.HostConfig.ReadonlyRootfs, true); assert.deepEqual(containerConfig.HostConfig.CapDrop, ["ALL"]); assert.deepEqual(containerConfig.HostConfig.SecurityOpt, ["no-new-privileges:true"]); assert.equal(containerConfig.HostConfig.PidsLimit, 128); assert.match(containerConfig.HostConfig.NetworkMode, /^stacksim-lambda-/); assert.match(containerConfig.HostConfig.Tmpfs["/tmp"], /size=512m/); assert.ok(!requests.some(request => request.includes("/images/create")), "neither resolution nor invocation may pull an image");
    await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: "local-docker-image", Timeout: 1 })); runtimeMode = "timeout"; const timedOut = await lambda.send(new InvokeCommand({ FunctionName: "local-docker-image", Payload: Buffer.from("{}") })); assert.equal(timedOut.FunctionError, "Unhandled"); assert.equal(JSON.parse(Buffer.from(timedOut.Payload ?? []).toString("utf8")).errorType, "TimeoutError"); assert.ok(requests.filter(request => request.startsWith("DELETE /v1.41/containers/container-id")).length >= 2); assert.ok(requests.filter(request => request === "DELETE /v1.41/networks/network-id").length >= 2);
  } finally {
    lambda?.destroy(); await simulator.stop().catch(() => undefined); await new Promise<void>(resolve => docker.close(() => resolve())); if (previousRoot === undefined) delete process.env.STACKSIM_LAMBDA_OCI_ROOT; else process.env.STACKSIM_LAMBDA_OCI_ROOT = previousRoot; if (previousSocket === undefined) delete process.env.STACKSIM_LAMBDA_DOCKER_SOCKET; else process.env.STACKSIM_LAMBDA_DOCKER_SOCKET = previousSocket; await rm(root, { recursive: true, force: true });
  }
});
