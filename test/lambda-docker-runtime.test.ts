import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LambdaDockerRuntime, type DockerImageInvocationInput } from "../src/lambda-docker-runtime.js";
import { assertSingleImageSource, normalizeDockerSocket } from "../src/lambda-images.js";

// LDP-08 (lambda-developer-parity-gaps.md): the Docker adapter against a fake daemon. No daemon is
// needed; the fake answers the Docker Engine API and plays the runtime interface client itself.

interface FakeDaemonOptions {
  /** Called once the container "starts"; receives the create payload so it can play the RIC. */
  onStart?: (config: any, runtimeAddress: string) => Promise<void> | void;
  stallCreate?: boolean;
  failNetworkCreate?: boolean;
  orphans?: { containers: any[]; networks: any[] };
  containerAddress?: string;
}

async function fakeDaemon(options: FakeDaemonOptions): Promise<{ socket: string; requests: string[]; close: () => Promise<void>; containerConfig: () => any }> {
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\stacksim-docker-runtime-${randomUUID()}` : join(await mkdtemp(join(tmpdir(), "stacksim-docker-runtime-")), "docker.sock");
  const requests: string[] = []; let containerConfig: any; let waitResponse: ServerResponse | undefined;
  const removed = new Set<string>();
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    requests.push(`${req.method} ${req.url}`); res.setHeader("content-type", "application/json"); const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/v1.41/containers/json")) return res.end(JSON.stringify((options.orphans?.containers ?? []).filter(item => !removed.has(item.Id))));
    if (req.method === "GET" && url.startsWith("/v1.41/networks?")) return res.end(JSON.stringify((options.orphans?.networks ?? []).filter(item => !removed.has(item.Id))));
    if (req.method === "POST" && url === "/v1.41/networks/create") { if (options.failNetworkCreate) { res.statusCode = 409; return res.end(JSON.stringify({ message: "pool overlaps with other one on this address space" })); } res.statusCode = 201; return res.end(JSON.stringify({ Id: "network-id" })); }
    if (req.method === "GET" && url === "/v1.41/networks/network-id") return res.end(JSON.stringify({ IPAM: { Config: [{ Gateway: "127.0.0.1" }] } }));
    if (req.method === "POST" && url.startsWith("/v1.41/containers/create?")) {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); containerConfig = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (options.stallCreate) return; // never answers: the daemon is stuck
      res.statusCode = 201; return res.end(JSON.stringify({ Id: "container-id" }));
    }
    if (req.method === "POST" && url === "/v1.41/containers/container-id/start") { res.statusCode = 204; res.end(); const address = String((containerConfig.Env as string[]).find((value: string) => value.startsWith("AWS_LAMBDA_RUNTIME_API="))).split("=").slice(1).join("=").replace("host.docker.internal", "127.0.0.1"); if (options.onStart) setImmediate(() => { void Promise.resolve(options.onStart!(containerConfig, address)).catch(() => undefined); }); return; }
    if (req.method === "GET" && url === "/v1.41/containers/container-id/json") return res.end(JSON.stringify({ NetworkSettings: { Networks: Object.fromEntries(Object.keys(containerConfig?.NetworkingConfig?.EndpointsConfig ?? {}).map(name => [name, { IPAddress: options.containerAddress ?? "127.0.0.1" }])) } }));
    if (req.method === "POST" && url.startsWith("/v1.41/containers/container-id/wait")) { waitResponse = res; return; }
    if (req.method === "POST" && url.startsWith("/v1.41/containers/container-id/kill")) { res.statusCode = 204; res.end(); if (waitResponse) { waitResponse.end(JSON.stringify({ StatusCode: 137 })); waitResponse = undefined; } return; }
    if (req.method === "GET" && url.startsWith("/v1.41/containers/container-id/logs")) return res.end();
    if (req.method === "DELETE" && (url.startsWith("/v1.41/containers/") || url.startsWith("/v1.41/networks/"))) { removed.add(decodeURIComponent(url.split("/")[3].split("?")[0])); res.statusCode = 204; return res.end(); }
    if (req.method === "POST" && url === "/v1.41/images/create") { res.statusCode = 409; return res.end(JSON.stringify({ message: "pool overlaps with other one on this address space" })); }
    res.statusCode = 500; return res.end(JSON.stringify({ message: `Unexpected fake Docker request ${req.method} ${url}` }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  return { socket, requests, containerConfig: () => containerConfig, close: () => new Promise(resolve => server.close(() => resolve())) };
}

function input(socket: string, overrides: Partial<DockerImageInvocationInput> = {}): DockerImageInvocationInput {
  return { socketPath: socket, imageUri: "000000000000.dkr.ecr.eu-west-1.amazonaws.com/app@sha256:" + "a".repeat(64), payload: Buffer.from('{"hello":"image"}'), requestId: randomUUID(), deadlineMs: Date.now() + 5_000, timeoutMs: 5_000, invokedFunctionArn: "arn:aws:lambda:eu-west-1:000000000000:function:image", environment: { AWS_REGION: "eu-west-1" }, memorySize: 128, ephemeralStorageSize: 512, architecture: "x86_64", ...overrides };
}

async function ric(address: string, requestId?: string): Promise<{ next: Response; event: string }> {
  const next = await fetch(`http://${address}/2018-06-01/runtime/invocation/next`); const event = await next.text();
  if (next.status === 200) await fetch(`http://${address}/2018-06-01/runtime/invocation/${encodeURIComponent(requestId ?? next.headers.get("lambda-runtime-aws-request-id") ?? "")}/response`, { method: "POST", body: JSON.stringify({ from: "container", event: event === "null" ? null : JSON.parse(event) }) });
  return { next, event };
}

test("LDG-60: the Docker socket is normalised once and both image sources together are rejected at startup", () => {
  assert.equal(normalizeDockerSocket("unix:///var/run/docker.sock"), "/var/run/docker.sock");
  assert.equal(normalizeDockerSocket("/var/run/docker.sock"), "/var/run/docker.sock");
  assert.throws(() => normalizeDockerSocket("var/run/docker.sock"), /absolute local socket or named-pipe path/);
  assert.throws(() => assertSingleImageSource({ STACKSIM_LAMBDA_OCI_ROOT: "/images", STACKSIM_LAMBDA_DOCKER_SOCKET: "/var/run/docker.sock" }), /both set; choose one image source/);
  assert.throws(() => assertSingleImageSource({ STACKSIM_LAMBDA_DOCKER_SOCKET: "relative.sock" }), /absolute local socket/);
  assert.doesNotThrow(() => assertSingleImageSource({ STACKSIM_LAMBDA_DOCKER_SOCKET: "unix:///var/run/docker.sock" }));
  assert.doesNotThrow(() => assertSingleImageSource({}));
});

test("LDG-57/59/61/62: only the container reaches the Runtime API, the proxy forwards to the control plane, empty payloads are null, trace IDs and orphans are handled", async () => {
  const control = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ path: req.url, host: req.headers.host, method: req.method })); });
  await new Promise<void>(resolve => control.listen(0, "127.0.0.1", resolve)); const controlPort = (control.address() as any).port;
  let intruderStatus: number | undefined; let proxied: any; let served: { next: Response; event: string } | undefined;
  const daemon = await fakeDaemon({
    orphans: { containers: [{ Id: "stale-container", Created: Math.floor(Date.now() / 1000) - 3600 }, { Id: "fresh-container", Created: Math.floor(Date.now() / 1000) }], networks: [{ Id: "stale-network", Created: new Date(Date.now() - 3_600_000).toISOString() }] },
    // The container address is reported as ::1 so a loopback IPv4 client ("intruder") differs from it; the RIC then connects over IPv6.
    containerAddress: "::1",
    onStart: async (_config, address) => {
      intruderStatus = (await fetch(`http://${address}/2018-06-01/runtime/invocation/next`)).status;
      const v6 = address.replace("127.0.0.1", "[::1]");
      // fetch() rewrites Host; an SDK inside the container sends host.docker.internal:<port>, which http.request can reproduce.
      proxied = await new Promise((resolve, reject) => { const req = request({ host: "::1", port: Number(v6.split(":").at(-1)), path: "/2015-03-31/functions?x=1", method: "GET", headers: { host: "host.docker.internal:9999" } }, res => { const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk))); res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); } }); }); req.once("error", reject); req.end(); });
      served = await ric(v6);
    },
  });
  const runtime = new LambdaDockerRuntime({ enforceContainerAddress: true, apiTimeoutMs: 2_000, cleanupAllowanceMs: 2_000, bindHost: "::" });
  try {
    const result = await runtime.invoke(input(daemon.socket, { payload: Buffer.alloc(0), traceHeader: "Root=1-abc;Sampled=1", controlEndpoint: `http://127.0.0.1:${controlPort}` }));
    assert.equal(result.functionError, undefined, result.payload.toString("utf8"));
    assert.deepEqual(JSON.parse(result.payload.toString("utf8")), { from: "container", event: null });
    assert.equal(intruderStatus, 403, "a client that is not the container must not receive the event");
    assert.equal(served?.next.status, 200); assert.equal(served?.event, "null"); assert.equal(served?.next.headers.get("lambda-runtime-trace-id"), "Root=1-abc;Sampled=1");
    assert.deepEqual(proxied, { path: "/2015-03-31/functions?x=1", host: "host.docker.internal:9999", method: "GET" });
    const env = Object.fromEntries((daemon.containerConfig().Env as string[]).map(entry => entry.split(/=(.*)/s).slice(0, 2)));
    assert.match(env.AWS_ENDPOINT_URL, /^http:\/\/host\.docker\.internal:\d+$/); assert.equal(env.STACKSIM_ENDPOINT, env.AWS_ENDPOINT_URL); assert.equal(env._X_AMZN_TRACE_ID, "Root=1-abc;Sampled=1");
    assert.doesNotMatch(daemon.containerConfig().HostConfig.Tmpfs["/tmp"], /noexec/);
    assert.ok(daemon.requests.includes("DELETE /v1.41/containers/stale-container?force=1&v=1"), "stale orphan swept");
    assert.ok(daemon.requests.includes("DELETE /v1.41/networks/stale-network"), "stale network swept");
    assert.ok(!daemon.requests.includes("DELETE /v1.41/containers/fresh-container?force=1&v=1"), "a recent container may belong to another simulator");
    assert.equal(daemon.requests.filter(item => item.startsWith("GET /v1.41/containers/json")).length, 1);
    await runtime.invoke(input(daemon.socket, { payload: Buffer.from("{}"), timeoutMs: 200 }));
    assert.equal(daemon.requests.filter(item => item.startsWith("GET /v1.41/containers/json")).length, 1, "the sweep runs once per socket");
  } finally { await runtime.stop(); await daemon.close(); await new Promise<void>(resolve => control.close(() => resolve())); }
});

test("LDG-58/62b: a stalled daemon fails within the budget with the daemon message surfaced and the listener released", async () => {
  const daemon = await fakeDaemon({ stallCreate: true });
  const runtime = new LambdaDockerRuntime({ enforceContainerAddress: false, apiTimeoutMs: 300, cleanupAllowanceMs: 200 });
  try {
    // Daemon failures before the container runs surface as InvalidRuntimeException (502) to the caller, as before; the deadline bounds them.
    const started = Date.now();
    await assert.rejects(runtime.invoke(input(daemon.socket, { timeoutMs: 200 })), (error: any) => /POST \/containers\/create\?name=stacksim-lambda-[a-f0-9]+ did not respond within 300 ms/.test(error.message));
    assert.ok(Date.now() - started < 3_000, "the stalled create must not hold the invocation");
    assert.ok(daemon.requests.includes("DELETE /v1.41/networks/network-id"), "cleanup still removes the network");
  } finally { await runtime.stop(); await daemon.close(); }
  const failing = await fakeDaemon({ failNetworkCreate: true });
  const surfaced = new LambdaDockerRuntime({ enforceContainerAddress: false, apiTimeoutMs: 500 });
  try {
    await assert.rejects(surfaced.invoke(input(failing.socket, { timeoutMs: 200 })), /status 409: pool overlaps with other one on this address space/);
  } finally { await surfaced.stop(); await failing.close(); }
});
