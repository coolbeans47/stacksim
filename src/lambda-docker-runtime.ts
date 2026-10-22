import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { AwsError } from "./errors.js";
import { normalizeDockerSocket } from "./lambda-images.js";
import type { LambdaImageConfigState } from "./types.js";
import { id } from "./util.js";

const API_VERSION = "/v1.41";
const MAX_API_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const RUNTIME_PREFIX = "/2018-06-01/runtime/";
const INVOCATION_LABEL = "stacksim.lambda=invocation";
/** Orphans older than the longest possible Lambda timeout plus cleanup are safe to sweep even when another simulator shares the daemon. */
const ORPHAN_AGE_MS = 16 * 60_000;

interface DockerResponse { status: number; body: Buffer }
interface RuntimeOutcome { kind: "response" | "error" | "init-error"; payload: Buffer }
type Outcome = RuntimeOutcome | { kind: "exit"; statusCode: number } | { kind: "wait-error"; error: unknown } | { kind: "timeout" } | { kind: "budget" };

export interface DockerImageInvocationInput {
  socketPath: string;
  imageUri: string;
  imageConfig?: LambdaImageConfigState;
  payload: Buffer;
  requestId: string;
  deadlineMs: number;
  timeoutMs: number;
  invokedFunctionArn: string;
  clientContext?: unknown;
  /** X-Ray trace header; served as `Lambda-Runtime-Trace-Id` and `_X_AMZN_TRACE_ID` like the AWS Runtime API. */
  traceHeader?: string;
  /** Control-plane endpoint that non-runtime requests from the container are proxied to (LDG-59). */
  controlEndpoint?: string;
  environment: Record<string, string>;
  memorySize: number;
  ephemeralStorageSize: number;
  architecture: "x86_64" | "arm64";
}

export interface DockerImageInvocationResult {
  payload: Buffer;
  functionError?: "Unhandled";
  stdout: string[];
  stderr: string[];
  durationMs: number;
}

export interface LambdaDockerRuntimeOptions {
  /**
   * Reject Runtime API connections whose source address is not the container's. Defaults to Linux
   * only: Docker Desktop NATs container traffic through its VM gateway, so the source address there
   * is never the container's own IP and the check would block every invocation.
   */
  enforceContainerAddress?: boolean;
  /** Address the per-invocation Runtime API binds to; defaults to the bridge gateway on Linux and all interfaces elsewhere. */
  bindHost?: string;
  /** Deadline for every Docker API call except `wait` (LDG-58). */
  apiTimeoutMs?: number;
  /** Extra time beyond the function timeout for container start and cleanup before the invocation is failed. */
  cleanupAllowanceMs?: number;
}

function runtimeError(message: string): AwsError { return new AwsError("InvalidRuntimeException", message, 502); }

async function limitedBody(req: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maximum) throw runtimeError(`Container runtime response exceeded ${maximum} bytes`); chunks.push(bytes); }
  return Buffer.concat(chunks);
}

function daemonMessage(body: Buffer): string | undefined {
  try { const parsed = JSON.parse(body.toString("utf8")); return typeof parsed?.message === "string" && parsed.message ? parsed.message : undefined; } catch { return undefined; }
}

class DockerApi {
  constructor(private readonly socketPath: string, private readonly timeoutMs: number) {}

  /** `timeoutMs` 0 disables the per-call deadline (only `wait`, which the overall budget races). */
  call(method: string, path: string, value?: unknown, maximum = MAX_API_BYTES, timeoutMs = this.timeoutMs): Promise<DockerResponse> {
    const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socketPath, path: `${API_VERSION}${path}`, method, headers: { accept: "application/json", ...(body ? { "content-type": "application/json", "content-length": String(body.length) } : {}) }, ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}) }, res => {
        const chunks: Buffer[] = []; let size = 0; let exceeded = false;
        res.on("data", chunk => { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maximum) exceeded = true; else chunks.push(bytes); });
        res.on("end", () => exceeded ? reject(runtimeError("Docker API response exceeded the local size limit")) : resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks) }));
        res.on("error", error => reject(runtimeError(`Docker API ${method} ${path} failed: ${error.message}`)));
      });
      req.once("timeout", () => req.destroy(runtimeError(`Docker API ${method} ${path} did not respond within ${timeoutMs} ms`)));
      req.once("error", error => reject(error instanceof AwsError ? error : runtimeError(`Configured Docker socket is unavailable during invocation: ${error.message}`)));
      if (body) req.write(body); req.end();
    });
  }

  async json(method: string, path: string, value: unknown, expected: number[], timeoutMs?: number): Promise<any> {
    const response = await this.call(method, path, value, MAX_API_BYTES, timeoutMs);
    if (!expected.includes(response.status)) { const message = daemonMessage(response.body); throw runtimeError(`Docker API ${method} ${path} failed with status ${response.status}${message ? `: ${message}` : ""}`); }
    if (!response.body.length) return {}; try { return JSON.parse(response.body.toString("utf8")); } catch { throw runtimeError(`Docker API ${method} ${path} returned invalid JSON`); }
  }
}

function dockerLogs(bytes: Buffer): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []; const stderr: string[] = []; let offset = 0;
  while (offset + 8 <= bytes.length) { const stream = bytes[offset]; const length = bytes.readUInt32BE(offset + 4); offset += 8; if (offset + length > bytes.length) break; const lines = bytes.subarray(offset, offset + length).toString("utf8").split(/\r?\n/).filter(Boolean); (stream === 2 ? stderr : stdout).push(...lines); offset += length; }
  if (offset === 0 && bytes.length) stdout.push(...bytes.toString("utf8").split(/\r?\n/).filter(Boolean)); return { stdout, stderr };
}

function closeServer(server: Server): Promise<void> { return new Promise(resolve => server.close(() => resolve())); }
function remoteAddressOf(req: IncomingMessage): string { return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, ""); }
function labelFilter(): string { return encodeURIComponent(JSON.stringify({ label: [INVOCATION_LABEL] })); }

export class LambdaDockerRuntime {
  private readonly active = new Map<string, { api: DockerApi; requestId: string; networkId?: string }>();
  private readonly cancelled = new Set<string>();
  private readonly swept = new Set<string>();
  private readonly enforceContainerAddress: boolean;
  private readonly bindHost?: string;
  private readonly apiTimeoutMs: number;
  private readonly cleanupAllowanceMs: number;

  constructor(options: LambdaDockerRuntimeOptions = {}) {
    this.enforceContainerAddress = options.enforceContainerAddress ?? process.platform === "linux";
    this.bindHost = options.bindHost ?? process.env.STACKSIM_LAMBDA_RUNTIME_API_HOST;
    this.apiTimeoutMs = options.apiTimeoutMs ?? 10_000;
    this.cleanupAllowanceMs = options.cleanupAllowanceMs ?? 10_000;
  }

  async cancel(requestId: string): Promise<void> {
    this.cancelled.add(requestId); const entries = [...this.active.entries()].filter(([, value]) => value.requestId === requestId);
    await Promise.allSettled(entries.map(([containerId, value]) => value.api.call("POST", `/containers/${encodeURIComponent(containerId)}/kill?signal=KILL`)));
  }

  /**
   * Removes invocation containers and networks that an earlier process left behind (hard exit, killed
   * daemon connection). Runs once per socket per process and only touches labelled resources older than
   * the longest possible invocation, so a second simulator on the same daemon keeps its live containers.
   */
  async sweepOrphans(api: DockerApi, socketPath: string): Promise<number>;
  async sweepOrphans(api: unknown, socketPath: string): Promise<number> {
    const docker = api as DockerApi;
    if (this.swept.has(socketPath)) return 0; this.swept.add(socketPath); let removed = 0; const cutoff = Date.now() - ORPHAN_AGE_MS;
    try {
      const containers = await docker.json("GET", `/containers/json?all=1&filters=${labelFilter()}`, undefined, [200]);
      for (const container of Array.isArray(containers) ? containers : []) {
        if (typeof container?.Id !== "string" || this.active.has(container.Id) || (typeof container.Created === "number" && container.Created * 1000 > cutoff)) continue;
        await docker.call("DELETE", `/containers/${encodeURIComponent(container.Id)}?force=1&v=1`).catch(() => undefined); removed++;
      }
      const networks = await docker.json("GET", `/networks?filters=${labelFilter()}`, undefined, [200]);
      for (const network of Array.isArray(networks) ? networks : []) {
        if (typeof network?.Id !== "string" || (typeof network.Created === "string" && Date.parse(network.Created) > cutoff)) continue;
        await docker.call("DELETE", `/networks/${encodeURIComponent(network.Id)}`).catch(() => undefined); removed++;
      }
    } catch { /* a daemon that cannot list is reported by the invocation itself */ }
    return removed;
  }

  /** Forwards a non-runtime request from the container to the control plane, host header intact so SigV4 still verifies. */
  private proxy(req: IncomingMessage, res: ServerResponse, controlEndpoint: string): void {
    const target = new URL(controlEndpoint);
    const upstream = request({ host: target.hostname, port: Number(target.port) || 80, method: req.method, path: req.url, headers: req.headers, timeout: this.apiTimeoutMs * 6 }, upstreamResponse => { res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers); upstreamResponse.pipe(res); });
    upstream.once("timeout", () => upstream.destroy(new Error("control plane did not respond")));
    upstream.once("error", error => { if (!res.headersSent) { res.statusCode = 502; res.setHeader("content-type", "application/json"); } res.end(JSON.stringify({ message: `StackSim control plane is unreachable from the container proxy: ${error.message}` })); });
    req.pipe(upstream);
  }

  async invoke(input: DockerImageInvocationInput): Promise<DockerImageInvocationResult> {
    const socketPath = normalizeDockerSocket(input.socketPath, message => runtimeError(message));
    let settle!: (value: RuntimeOutcome) => void; const runtimeOutcome = new Promise<RuntimeOutcome>(resolve => { settle = resolve; }); let nextServed = false; let settled = false;
    const finish = (value: RuntimeOutcome) => { if (settled) return; settled = true; setImmediate(() => settle(value)); };
    // With address enforcement the first `next` must wait until the container's IP is known; without it the gate opens at once.
    let allowedRemote: string | undefined; let openGate!: () => void; const gate = new Promise<void>(resolve => { openGate = resolve; }); if (!this.enforceContainerAddress) openGate();
    const eventPayload = input.payload.length ? input.payload : Buffer.from("null");
    const runtime = createServer(async (req, res) => {
      try {
        await gate;
        if (allowedRemote !== undefined && remoteAddressOf(req) !== allowedRemote) { res.statusCode = 403; return res.end(); }
        if (!req.url?.startsWith(RUNTIME_PREFIX)) { if (!input.controlEndpoint) { res.statusCode = 404; return res.end(); } return this.proxy(req, res, input.controlEndpoint); }
        if (req.method === "GET" && req.url === `${RUNTIME_PREFIX}invocation/next`) {
          if (nextServed) { res.statusCode = 410; return res.end(); } nextServed = true; res.statusCode = 200; res.setHeader("content-type", "application/json"); res.setHeader("lambda-runtime-aws-request-id", input.requestId); res.setHeader("lambda-runtime-deadline-ms", String(input.deadlineMs)); res.setHeader("lambda-runtime-invoked-function-arn", input.invokedFunctionArn); if (input.traceHeader) res.setHeader("lambda-runtime-trace-id", input.traceHeader); if (input.clientContext !== undefined) res.setHeader("lambda-runtime-client-context", Buffer.from(JSON.stringify(input.clientContext)).toString("base64")); return res.end(eventPayload);
        }
        const invocation = req.url.match(/^\/2018-06-01\/runtime\/invocation\/([^/]+)\/(response|error)$/); const initError = req.url === `${RUNTIME_PREFIX}init/error`;
        if (req.method !== "POST" || (!invocation && !initError)) { res.statusCode = 404; return res.end(); }
        if (invocation && decodeURIComponent(invocation[1]) !== input.requestId) { res.statusCode = 403; return res.end(); }
        if (String(req.headers["lambda-runtime-function-response-mode"] ?? "").toLowerCase() === "streaming") { res.statusCode = 400; finish({ kind: "error", payload: Buffer.from(JSON.stringify({ errorMessage: "Container response streaming is not available through the local Docker adapter", errorType: "Runtime.StreamingUnsupported" })) }); return res.end(); }
        const payload = await limitedBody(req, MAX_RESPONSE_BYTES); res.statusCode = 202; res.end(); finish({ kind: initError ? "init-error" : invocation![2] === "response" ? "response" : "error", payload });
      } catch (error) { res.statusCode = 413; res.end(); finish({ kind: "error", payload: Buffer.from(JSON.stringify({ errorMessage: error instanceof Error ? error.message : String(error), errorType: "Runtime.ResponseTooLarge" })) }); }
    });

    const api = new DockerApi(socketPath, this.apiTimeoutMs); const invocationId = id(20); const networkName = `stacksim-lambda-${invocationId}`; const containerName = `stacksim-lambda-${invocationId}`; let networkId: string | undefined; let containerId: string | undefined; let timer: ReturnType<typeof setTimeout> | undefined; let budgetTimer: ReturnType<typeof setTimeout> | undefined; let listening = false; let logs = { stdout: [] as string[], stderr: [] as string[] }; const diagnostics: string[] = []; const started = performance.now();
    // The budget covers daemon calls before and after the function runs; the function timer itself starts only once the container is running.
    const budget = new Promise<Outcome>(resolve => { budgetTimer = setTimeout(() => resolve({ kind: "budget" }), input.timeoutMs + this.cleanupAllowanceMs); });
    const run = async (): Promise<Outcome> => {
      await this.sweepOrphans(api, socketPath);
      const network = await api.json("POST", "/networks/create", { Name: networkName, Driver: "bridge", Internal: true, CheckDuplicate: false, Labels: { "stacksim.lambda": "invocation", "stacksim.request-id": input.requestId } }, [201]); networkId = network.Id; if (typeof networkId !== "string") throw runtimeError("Docker did not return an internal network ID");
      let extraHosts: string[] | undefined; let gateway: string | undefined;
      if (process.platform === "linux") { const inspected = await api.json("GET", `/networks/${encodeURIComponent(networkId)}`, undefined, [200]); gateway = inspected?.IPAM?.Config?.find((item: any) => typeof item?.Gateway === "string")?.Gateway; if (!gateway) throw runtimeError("Docker internal network did not expose a host gateway for the Runtime API"); extraHosts = [`host.docker.internal:${gateway}`]; }
      // Linux binds the listener to the bridge gateway so only that internal network can reach it; Docker Desktop reaches the host through its VM, so the listener stays on all interfaces unless overridden.
      const bindHost = this.bindHost ?? gateway ?? "0.0.0.0";
      await new Promise<void>((resolve, reject) => { runtime.once("error", reject); runtime.listen(0, bindHost, resolve); }); listening = true; const address = runtime.address(); if (!address || typeof address === "string") throw runtimeError("Unable to start the local Lambda Runtime API adapter");
      const hostEndpoint = `http://host.docker.internal:${address.port}`;
      const env = { ...input.environment, ...(input.controlEndpoint ? { AWS_ENDPOINT_URL: hostEndpoint, AWS_ENDPOINT_URL_LAMBDA: hostEndpoint, STACKSIM_ENDPOINT: hostEndpoint } : {}), ...(input.traceHeader ? { _X_AMZN_TRACE_ID: input.traceHeader } : {}), AWS_LAMBDA_RUNTIME_API: `host.docker.internal:${address.port}`, AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(input.memorySize), AWS_EXECUTION_ENV: "AWS_Lambda_image" };
      const created = await api.json("POST", `/containers/create?name=${encodeURIComponent(containerName)}`, {
        Image: input.imageUri, Env: Object.entries(env).map(([key, value]) => `${key}=${value}`), User: "1000:1000", ...(input.imageConfig?.entryPoint ? { Entrypoint: input.imageConfig.entryPoint } : {}), ...(input.imageConfig?.command ? { Cmd: input.imageConfig.command } : {}), ...(input.imageConfig?.workingDirectory !== undefined ? { WorkingDir: input.imageConfig.workingDirectory } : {}), Labels: { "stacksim.lambda": "invocation", "stacksim.request-id": input.requestId },
        // /tmp is a tmpfs that counts against the container memory limit; AWS allows executables under /tmp, so it is not mounted noexec.
        HostConfig: { NetworkMode: networkName, ReadonlyRootfs: true, Memory: input.memorySize * 1024 * 1024, MemorySwap: input.memorySize * 1024 * 1024, NanoCpus: Math.max(100_000_000, Math.min(6_000_000_000, Math.round(input.memorySize / 1769 * 1_000_000_000))), PidsLimit: 128, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], Init: true, AutoRemove: false, Tmpfs: { "/tmp": `rw,nosuid,nodev,size=${input.ephemeralStorageSize}m,mode=1777` }, ...(extraHosts ? { ExtraHosts: extraHosts } : {}) }, NetworkingConfig: { EndpointsConfig: { [networkName]: {} } },
      }, [201]); containerId = created.Id; if (typeof containerId !== "string") throw runtimeError("Docker did not return a container ID"); this.active.set(containerId, { api, requestId: input.requestId, networkId });
      await api.json("POST", `/containers/${encodeURIComponent(containerId)}/start`, undefined, [204]);
      if (this.enforceContainerAddress) {
        const inspected = await api.json("GET", `/containers/${encodeURIComponent(containerId)}/json`, undefined, [200]); const containerAddress = inspected?.NetworkSettings?.Networks?.[networkName]?.IPAddress;
        if (typeof containerAddress !== "string" || !containerAddress) throw runtimeError("Docker did not report the container's address on the invocation network, so the Runtime API cannot be scoped to it");
        allowedRemote = containerAddress; openGate();
      }
      if (this.cancelled.has(input.requestId)) await api.call("POST", `/containers/${encodeURIComponent(containerId)}/kill?signal=KILL`).catch(() => undefined);
      const stopped: Promise<Outcome> = api.json("POST", `/containers/${encodeURIComponent(containerId)}/wait?condition=not-running`, undefined, [200], 0).then(value => ({ kind: "exit" as const, statusCode: Number(value.StatusCode ?? 1) })).catch(error => ({ kind: "wait-error" as const, error }));
      const timeout = new Promise<Outcome>(resolve => { timer = setTimeout(() => resolve({ kind: "timeout" }), input.timeoutMs); });
      return Promise.race([runtimeOutcome, stopped, timeout]);
    };
    try {
      const outcome = await Promise.race([run(), budget]);
      if (containerId) { await api.call("POST", `/containers/${encodeURIComponent(containerId)}/kill?signal=KILL`).catch(() => undefined); const rawLogs = await api.call("GET", `/containers/${encodeURIComponent(containerId)}/logs?stdout=1&stderr=1&timestamps=0`, undefined, MAX_API_BYTES).catch(() => undefined); if (rawLogs?.status === 200) logs = dockerLogs(rawLogs.body); }
      const durationMs = performance.now() - started;
      if (outcome.kind === "budget") return { payload: Buffer.from(JSON.stringify({ errorMessage: `RequestId: ${input.requestId} Error: the Docker daemon did not complete the invocation within ${((input.timeoutMs + this.cleanupAllowanceMs) / 1000).toFixed(2)} seconds (function timeout plus cleanup allowance)`, errorType: "Runtime.DockerTimeout", trace: [] })), functionError: "Unhandled", ...logs, durationMs };
      if (outcome.kind === "timeout") return { payload: Buffer.from(JSON.stringify({ errorMessage: `RequestId: ${input.requestId} Error: Task timed out after ${(input.timeoutMs / 1000).toFixed(2)} seconds`, errorType: "Sandbox.Timedout", trace: [] })), functionError: "Unhandled", ...logs, durationMs };
      if (outcome.kind === "response") return { payload: outcome.payload, ...logs, durationMs };
      if (outcome.kind === "error" || outcome.kind === "init-error") return { payload: outcome.payload.length ? outcome.payload : Buffer.from(JSON.stringify({ errorMessage: "Container runtime reported an empty error", errorType: "Runtime.Error" })), functionError: "Unhandled", ...logs, durationMs };
      let message = "Container runtime exited without a response"; if (outcome.kind === "exit") message = `Container runtime exited with code ${outcome.statusCode}`; else if (outcome.kind === "wait-error") message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error); return { payload: Buffer.from(JSON.stringify({ errorMessage: logs.stderr.join("\n") || message, errorType: "Runtime.ExitError" })), functionError: "Unhandled", ...logs, durationMs };
    } finally {
      if (timer) clearTimeout(timer); if (budgetTimer) clearTimeout(budgetTimer); this.cancelled.delete(input.requestId);
      // Cleanup is bounded by the per-call deadline; anything that survives it is named so an operator can remove it by label.
      if (containerId) { this.active.delete(containerId); await api.call("DELETE", `/containers/${encodeURIComponent(containerId)}?force=1&v=1`).catch(error => diagnostics.push(`[stacksim] invocation container ${containerName} was not removed: ${error instanceof Error ? error.message : String(error)}`)); }
      if (networkId) await api.call("DELETE", `/networks/${encodeURIComponent(networkId)}`).catch(error => diagnostics.push(`[stacksim] invocation network ${networkName} was not removed: ${error instanceof Error ? error.message : String(error)}`));
      if (listening) await closeServer(runtime);
      logs.stderr.push(...diagnostics);
    }
  }

  async stop(): Promise<void> {
    const active = [...this.active.entries()]; this.active.clear(); this.cancelled.clear(); await Promise.allSettled(active.flatMap(([containerId, value]) => [value.api.call("POST", `/containers/${encodeURIComponent(containerId)}/kill?signal=KILL`), value.api.call("DELETE", `/containers/${encodeURIComponent(containerId)}?force=1&v=1`), ...(value.networkId ? [value.api.call("DELETE", `/networks/${encodeURIComponent(value.networkId)}`)] : [])]));
  }
}
