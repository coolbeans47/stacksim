import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { AwsError } from "./errors.js";
import type { LambdaImageConfigState } from "./types.js";
import { id } from "./util.js";

const API_VERSION = "/v1.41";
const MAX_API_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;

interface DockerResponse { status: number; body: Buffer }
interface RuntimeOutcome { kind: "response" | "error" | "init-error"; payload: Buffer }

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

function runtimeError(message: string): AwsError { return new AwsError("InvalidRuntimeException", message, 502); }

async function limitedBody(req: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maximum) throw runtimeError(`Container runtime response exceeded ${maximum} bytes`); chunks.push(bytes); }
  return Buffer.concat(chunks);
}

class DockerApi {
  constructor(private readonly socketPath: string) {}

  call(method: string, path: string, value?: unknown, maximum = MAX_API_BYTES): Promise<DockerResponse> {
    const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socketPath, path: `${API_VERSION}${path}`, method, headers: { accept: "application/json", ...(body ? { "content-type": "application/json", "content-length": String(body.length) } : {}) } }, res => {
        const chunks: Buffer[] = []; let size = 0; let exceeded = false;
        res.on("data", chunk => { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maximum) exceeded = true; else chunks.push(bytes); });
        res.on("end", () => exceeded ? reject(runtimeError("Docker API response exceeded the local size limit")) : resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks) }));
      });
      req.once("error", error => reject(runtimeError(`Configured Docker socket is unavailable during invocation: ${error.message}`))); if (body) req.write(body); req.end();
    });
  }

  async json(method: string, path: string, value: unknown, expected: number[]): Promise<any> {
    const response = await this.call(method, path, value); if (!expected.includes(response.status)) throw runtimeError(`Docker API ${method} ${path} failed with status ${response.status}`);
    if (!response.body.length) return {}; try { return JSON.parse(response.body.toString("utf8")); } catch { throw runtimeError(`Docker API ${method} ${path} returned invalid JSON`); }
  }
}

function dockerLogs(bytes: Buffer): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []; const stderr: string[] = []; let offset = 0;
  while (offset + 8 <= bytes.length) { const stream = bytes[offset]; const length = bytes.readUInt32BE(offset + 4); offset += 8; if (offset + length > bytes.length) break; const lines = bytes.subarray(offset, offset + length).toString("utf8").split(/\r?\n/).filter(Boolean); (stream === 2 ? stderr : stdout).push(...lines); offset += length; }
  if (offset === 0 && bytes.length) stdout.push(...bytes.toString("utf8").split(/\r?\n/).filter(Boolean)); return { stdout, stderr };
}

function closeServer(server: Server): Promise<void> { return new Promise(resolve => server.close(() => resolve())); }

export class LambdaDockerRuntime {
  private readonly active = new Map<string, { api: DockerApi; requestId: string; networkId?: string }>();
  private readonly cancelled = new Set<string>();

  async cancel(requestId: string): Promise<void> {
    this.cancelled.add(requestId); const entries = [...this.active.entries()].filter(([, value]) => value.requestId === requestId);
    await Promise.allSettled(entries.map(([containerId, value]) => value.api.call("POST", `/containers/${encodeURIComponent(containerId)}/kill?signal=KILL`)));
  }

  async invoke(input: DockerImageInvocationInput): Promise<DockerImageInvocationResult> {
    if (!isAbsolute(input.socketPath)) throw runtimeError("STACKSIM_LAMBDA_DOCKER_SOCKET must be an absolute local socket or named-pipe path");
    let settle!: (value: RuntimeOutcome) => void; const runtimeOutcome = new Promise<RuntimeOutcome>(resolve => { settle = resolve; }); let nextServed = false; let settled = false;
    const finish = (value: RuntimeOutcome) => { if (settled) return; settled = true; setImmediate(() => settle(value)); };
    const runtime = createServer(async (req, res) => {
      try {
        if (req.method === "GET" && req.url === "/2018-06-01/runtime/invocation/next") {
          if (nextServed) { res.statusCode = 410; return res.end(); } nextServed = true; res.statusCode = 200; res.setHeader("content-type", "application/json"); res.setHeader("lambda-runtime-aws-request-id", input.requestId); res.setHeader("lambda-runtime-deadline-ms", String(input.deadlineMs)); res.setHeader("lambda-runtime-invoked-function-arn", input.invokedFunctionArn); if (input.clientContext !== undefined) res.setHeader("lambda-runtime-client-context", Buffer.from(JSON.stringify(input.clientContext)).toString("base64")); return res.end(input.payload);
        }
        const invocation = req.url?.match(/^\/2018-06-01\/runtime\/invocation\/([^/]+)\/(response|error)$/); const initError = req.url === "/2018-06-01/runtime/init/error";
        if (req.method !== "POST" || (!invocation && !initError)) { res.statusCode = 404; return res.end(); }
        if (invocation && decodeURIComponent(invocation[1]) !== input.requestId) { res.statusCode = 403; return res.end(); }
        if (String(req.headers["lambda-runtime-function-response-mode"] ?? "").toLowerCase() === "streaming") { res.statusCode = 400; finish({ kind: "error", payload: Buffer.from(JSON.stringify({ errorMessage: "Container response streaming is not available through the local Docker adapter", errorType: "Runtime.StreamingUnsupported" })) }); return res.end(); }
        const payload = await limitedBody(req, MAX_RESPONSE_BYTES); res.statusCode = 202; res.end(); finish({ kind: initError ? "init-error" : invocation![2] === "response" ? "response" : "error", payload });
      } catch (error) { res.statusCode = 413; res.end(); finish({ kind: "error", payload: Buffer.from(JSON.stringify({ errorMessage: error instanceof Error ? error.message : String(error), errorType: "Runtime.ResponseTooLarge" })) }); }
    });
    await new Promise<void>((resolve, reject) => { runtime.once("error", reject); runtime.listen(0, "0.0.0.0", resolve); }); const address = runtime.address(); if (!address || typeof address === "string") { await closeServer(runtime); throw runtimeError("Unable to start the local Lambda Runtime API adapter"); }

    const api = new DockerApi(input.socketPath); const invocationId = id(20); const networkName = `stacksim-lambda-${invocationId}`; const containerName = `stacksim-lambda-${invocationId}`; let networkId: string | undefined; let containerId: string | undefined; let timer: ReturnType<typeof setTimeout> | undefined; let logs = { stdout: [] as string[], stderr: [] as string[] }; const started = performance.now();
    try {
      const network = await api.json("POST", "/networks/create", { Name: networkName, Driver: "bridge", Internal: true, CheckDuplicate: false, Labels: { "stacksim.lambda": "invocation", "stacksim.request-id": input.requestId } }, [201]); networkId = network.Id; if (typeof networkId !== "string") throw runtimeError("Docker did not return an internal network ID");
      let extraHosts: string[] | undefined; if (process.platform === "linux") { const inspected = await api.json("GET", `/networks/${encodeURIComponent(networkId)}`, undefined, [200]); const gateway = inspected?.IPAM?.Config?.find((item: any) => typeof item?.Gateway === "string")?.Gateway; if (!gateway) throw runtimeError("Docker internal network did not expose a host gateway for the Runtime API"); extraHosts = [`host.docker.internal:${gateway}`]; }
      const env = { ...input.environment, AWS_LAMBDA_RUNTIME_API: `host.docker.internal:${address.port}`, AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(input.memorySize), AWS_EXECUTION_ENV: "AWS_Lambda_image" };
      const created = await api.json("POST", `/containers/create?name=${encodeURIComponent(containerName)}`, {
        Image: input.imageUri, Env: Object.entries(env).map(([key, value]) => `${key}=${value}`), User: "1000:1000", ...(input.imageConfig?.entryPoint ? { Entrypoint: input.imageConfig.entryPoint } : {}), ...(input.imageConfig?.command ? { Cmd: input.imageConfig.command } : {}), ...(input.imageConfig?.workingDirectory !== undefined ? { WorkingDir: input.imageConfig.workingDirectory } : {}), Labels: { "stacksim.lambda": "invocation", "stacksim.request-id": input.requestId },
        HostConfig: { NetworkMode: networkName, ReadonlyRootfs: true, Memory: input.memorySize * 1024 * 1024, MemorySwap: input.memorySize * 1024 * 1024, NanoCpus: Math.max(100_000_000, Math.min(6_000_000_000, Math.round(input.memorySize / 1769 * 1_000_000_000))), PidsLimit: 128, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], Init: true, AutoRemove: false, Tmpfs: { "/tmp": `rw,noexec,nosuid,nodev,size=${input.ephemeralStorageSize}m,mode=1777` }, ...(extraHosts ? { ExtraHosts: extraHosts } : {}) }, NetworkingConfig: { EndpointsConfig: { [networkName]: {} } },
      }, [201]); containerId = created.Id; if (typeof containerId !== "string") throw runtimeError("Docker did not return a container ID"); this.active.set(containerId, { api, requestId: input.requestId, networkId }); await api.json("POST", `/containers/${encodeURIComponent(containerId)}/start`, undefined, [204]); if (this.cancelled.has(input.requestId)) await api.call("POST", `/containers/${encodeURIComponent(containerId)}/kill?signal=KILL`).catch(() => undefined);
      const stopped = api.json("POST", `/containers/${encodeURIComponent(containerId)}/wait?condition=not-running`, undefined, [200]).then(value => ({ kind: "exit" as const, statusCode: Number(value.StatusCode ?? 1) })).catch(error => ({ kind: "wait-error" as const, error }));
      const timeout = new Promise<{ kind: "timeout" }>(resolve => { timer = setTimeout(() => resolve({ kind: "timeout" }), input.timeoutMs); }); const outcome = await Promise.race([runtimeOutcome, stopped, timeout]);
      await api.call("POST", `/containers/${encodeURIComponent(containerId)}/kill?signal=KILL`).catch(() => undefined); const rawLogs = await api.call("GET", `/containers/${encodeURIComponent(containerId)}/logs?stdout=1&stderr=1&timestamps=0`, undefined, MAX_API_BYTES).catch(() => undefined); if (rawLogs?.status === 200) logs = dockerLogs(rawLogs.body);
      const durationMs = performance.now() - started;
      if ("kind" in outcome && outcome.kind === "timeout") return { payload: Buffer.from(JSON.stringify({ errorMessage: `Task timed out after ${(input.timeoutMs / 1000).toFixed(2)} seconds`, errorType: "TimeoutError" })), functionError: "Unhandled", ...logs, durationMs };
      if (outcome.kind === "response") return { payload: outcome.payload, ...logs, durationMs };
      if (outcome.kind === "error" || outcome.kind === "init-error") return { payload: outcome.payload.length ? outcome.payload : Buffer.from(JSON.stringify({ errorMessage: "Container runtime reported an empty error", errorType: "Runtime.Error" })), functionError: "Unhandled", ...logs, durationMs };
      let message = "Container runtime exited without a response"; if (outcome.kind === "exit") message = `Container runtime exited with code ${outcome.statusCode}`; else if (outcome.kind === "wait-error") message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error); return { payload: Buffer.from(JSON.stringify({ errorMessage: logs.stderr.join("\n") || message, errorType: "Runtime.ExitError" })), functionError: "Unhandled", ...logs, durationMs };
    } finally {
      if (timer) clearTimeout(timer); this.cancelled.delete(input.requestId); if (containerId) { this.active.delete(containerId); await api.call("DELETE", `/containers/${encodeURIComponent(containerId)}?force=1&v=1`).catch(() => undefined); } if (networkId) await api.call("DELETE", `/networks/${encodeURIComponent(networkId)}`).catch(() => undefined); await closeServer(runtime);
    }
  }

  async stop(): Promise<void> {
    const active = [...this.active.entries()]; this.active.clear(); this.cancelled.clear(); await Promise.allSettled(active.flatMap(([containerId, value]) => [value.api.call("POST", `/containers/${encodeURIComponent(containerId)}/kill?signal=KILL`), value.api.call("DELETE", `/containers/${encodeURIComponent(containerId)}?force=1&v=1`), ...(value.networkId ? [value.api.call("DELETE", `/networks/${encodeURIComponent(value.networkId)}`)] : [])]));
  }
}
