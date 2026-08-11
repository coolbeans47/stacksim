import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createWriteStream } from "node:fs";
import { Writable } from "node:stream";
import { formatWithOptions } from "node:util";
import { createRequire, syncBuiltinESMExports } from "node:module";

interface InitializeRequest {
  type: "initialize";
  codeDir: string;
  handler: string;
}

interface InvokeRequest {
  type: "invoke";
  invocationId: string;
  event: unknown;
  context: Record<string, unknown>;
  environment: Record<string, string>;
  streaming?: boolean;
}

const STREAMING_HANDLER = Symbol.for("aws.lambda.runtime.streaming-handler");
const streamProtocol = createWriteStream("lambda-runtime-stream", { fd: 4, autoClose: false });
const applicationLogProtocol = createWriteStream("lambda-runtime-application-logs", { fd: 5, autoClose: false });

function installCloudFormationNetworkTripwire(): void {
  const allowedPorts = new Set(String(process.env.STACKSIM_CLOUDFORMATION_NETWORK_PORTS ?? "").split(",").filter(port => /^\d+$/.test(port)));
  if (!allowedPorts.size) return;
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const blocked = (target: string): never => {
    const error = new Error(`CloudFormation custom-resource provider blocked outbound connection to ${target}`);
    (error as any).code = "STACKSIM_CLOUDFORMATION_NETWORK_BLOCKED";
    throw error;
  };
  const assertHostPort = (hostValue: unknown, portValue: unknown): void => {
    const host = String(hostValue ?? "").replace(/\.$/, "").toLowerCase();
    const port = String(portValue ?? "");
    if (!loopback.has(host) || !allowedPorts.has(port)) blocked(`${host || "unknown"}:${port || "unknown"}`);
  };
  const assertTarget = (args: any[], defaultPort?: number) => {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const first = normalized[0];
    const options = first && typeof first === "object" ? first : undefined;
    const port = options?.port ?? (typeof first === "number" ? first : defaultPort);
    const host = options?.hostname ?? options?.host ?? (typeof first === "number" && typeof normalized[1] === "string" ? normalized[1] : "localhost");
    assertHostPort(host, port);
  };
  const assertUrlTarget = (input: any, defaultPort?: number): void => {
    const candidate = input instanceof URL ? input : input?.url ?? input?.origin ?? input;
    let url: URL;
    try { url = candidate instanceof URL ? candidate : new URL(String(candidate)); }
    catch { return blocked("an invalid URL"); }
    const protocolPort = url.protocol === "https:" || url.protocol === "wss:" ? 443 : url.protocol === "http:" || url.protocol === "ws:" ? 80 : defaultPort;
    assertHostPort(url.hostname, url.port || protocolPort);
  };
  const net = createRequire(import.meta.url)("node:net") as typeof import("node:net");
  const originalConnect = net.connect;
  const originalCreateConnection = net.createConnection;
  const originalSocketConnect = net.Socket.prototype.connect;
  (net as any).connect = function (...args: any[]) { assertTarget(args); return originalConnect.apply(net, args as any); };
  (net as any).createConnection = function (...args: any[]) { assertTarget(args); return originalCreateConnection.apply(net, args as any); };
  (net.Socket.prototype as any).connect = function (...args: any[]) { assertTarget(args); return originalSocketConnect.apply(this, args as any); };
  const tls = createRequire(import.meta.url)("node:tls") as typeof import("node:tls");
  const originalTlsConnect = tls.connect;
  (tls as any).connect = function (...args: any[]) { assertTarget(args, 443); return originalTlsConnect.apply(tls, args as any); };

  // Node's built-in fetch implementation can bypass the public net exports.
  // Force manual redirects so an allowed loopback URL cannot bounce to a
  // remote origin after this one-time target check.
  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input: any, init?: RequestInit): Promise<Response> {
      assertUrlTarget(input);
      return originalFetch.call(globalThis, input, { ...init, redirect: "manual" });
    };
  }

  const patchFunction = (owner: any, name: string, guard: (...args: any[]) => void, options?: (value: any) => any): void => {
    const original = owner?.[name];
    if (typeof original !== "function") return;
    try { owner[name] = function (...args: any[]) { guard(...args); if (options && args.length > 1) args[1] = options(args[1]); return original.apply(this, args); }; } catch { /* A frozen optional dependency remains covered by net/fetch guards. */ }
  };

  // Guard common direct undici entry points when the package is available.
  try {
    const undici = createRequire(import.meta.url)("undici") as any;
    for (const method of ["fetch", "request", "stream", "pipeline", "connect"]) patchFunction(undici, method, input => assertUrlTarget(input), value => ({ ...value, redirect: "manual", maxRedirections: 0 }));
    for (const constructorName of ["Client", "Pool", "BalancedPool", "WebSocket", "EventSource"]) {
      const Original = undici[constructorName];
      if (typeof Original !== "function") continue;
      try { undici[constructorName] = new Proxy(Original, { construct(Target, args, NewTarget) { assertUrlTarget(args[0]); return Reflect.construct(Target, args, NewTarget); } }); } catch { /* net/fetch remain guarded */ }
    }
    const dispatcher = undici.Dispatcher?.prototype;
    if (dispatcher && typeof dispatcher.dispatch === "function") {
      const originalDispatch = dispatcher.dispatch;
      dispatcher.dispatch = function (options: any, handler: any) { assertUrlTarget(options?.origin ?? `${options?.protocol ?? "http:"}//${options?.hostname ?? ""}:${options?.port ?? ""}`); return originalDispatch.call(this, { ...options, maxRedirections: 0 }, handler); };
    }
  } catch { /* undici is optional */ }

  const childProcess = createRequire(import.meta.url)("node:child_process") as any;
  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) patchFunction(childProcess, method, () => blocked("a child process"));
  if (typeof childProcess.ChildProcess?.prototype?.spawn === "function") patchFunction(childProcess.ChildProcess.prototype, "spawn", () => blocked("a child process"));

  const dgram = createRequire(import.meta.url)("node:dgram") as any;
  patchFunction(dgram, "createSocket", () => blocked("a datagram socket"));
  for (const method of ["connect", "send", "sendto"]) patchFunction(dgram.Socket?.prototype, method, () => blocked("a datagram socket"));

  const cluster = createRequire(import.meta.url)("node:cluster") as any;
  patchFunction(cluster, "fork", () => blocked("a cluster worker process"));

  const workerThreads = createRequire(import.meta.url)("node:worker_threads") as any;
  if (typeof workerThreads.Worker === "function") {
    const OriginalWorker = workerThreads.Worker;
    try { workerThreads.Worker = new Proxy(OriginalWorker, { construct() { return blocked("a worker thread"); } }); } catch { /* Node exposes a mutable CommonJS facade on supported runtimes. */ }
  }

  const http2 = createRequire(import.meta.url)("node:http2") as any;
  patchFunction(http2, "connect", authority => assertUrlTarget(authority));

  const guardDns = (dns: any): void => {
    const methods = ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"];
    for (const method of methods) patchFunction(dns, method, target => {
      const host = String(target ?? "").replace(/\.$/, "").toLowerCase();
      if (!loopback.has(host)) blocked(`DNS target ${host || "unknown"}`);
    });
    const prototype = dns.Resolver?.prototype;
    if (prototype) for (const method of methods.filter(name => name !== "lookup" && name !== "lookupService")) patchFunction(prototype, method, target => {
      const host = String(target ?? "").replace(/\.$/, "").toLowerCase();
      if (!loopback.has(host)) blocked(`DNS target ${host || "unknown"}`);
    });
  };
  guardDns(createRequire(import.meta.url)("node:dns") as any);
  guardDns(createRequire(import.meta.url)("node:dns/promises") as any);

  const WebSocketConstructor = (globalThis as any).WebSocket;
  if (typeof WebSocketConstructor === "function") {
    try { (globalThis as any).WebSocket = new Proxy(WebSocketConstructor, { construct(Target, args, NewTarget) { assertUrlTarget(args[0]); return Reflect.construct(Target, args, NewTarget); } }); } catch { /* Optional global. */ }
  }
  // Keep dynamic `import("node:...")` named exports aligned with the patched
  // CommonJS facades above.
  syncBuiltinESMExports();
}

function installCloudFormationCallbackPortCompatibility(): void {
  const port = Number(process.env.STACKSIM_CLOUDFORMATION_CALLBACK_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return;
  const https = createRequire(import.meta.url)("node:https") as typeof import("node:https");
  const original = https.request;
  (https as any).request = function patchedRequest(input: any, options?: any, callback?: any): any {
    const call = (value: any) => typeof options === "function" && callback === undefined ? original.call(https, value, options) : original.call(https, value, options, callback);
    if (input && typeof input === "object" && !Array.isArray(input) && input.port === undefined && /^(?:localhost|127\.0\.0\.1)$/i.test(String(input.hostname ?? input.host ?? "")) && String(input.path ?? "").startsWith("/_stacksim/cloudformation/custom-resource-response/")) {
      return call({ ...input, port });
    }
    return call(input);
  };
}

installCloudFormationNetworkTripwire();
installCloudFormationCallbackPortCompatibility();

let currentInvocationId = "initialization";

function emitApplicationLog(level: string, message: string): void {
  applicationLogProtocol.write(`${JSON.stringify({ invocationId: currentInvocationId, level, message })}\n`);
}

function finishApplicationLogs(invocationId: string): Promise<void> {
  return new Promise((resolve, reject) => applicationLogProtocol.write(`${JSON.stringify({ invocationId, type: "complete" })}\n`, error => error ? reject(error) : resolve()));
}

function captureConsole(): void {
  const levels = { trace: "TRACE", debug: "DEBUG", info: "INFO", log: "INFO", warn: "WARN", error: "ERROR" } as const;
  for (const [method, level] of Object.entries(levels)) (console as any)[method] = (...values: unknown[]) => emitApplicationLog(level, formatWithOptions({ colors: false, depth: 8 }, ...values));
  const capture = (level: string) => function (chunk: any, encoding?: any, callback?: any): boolean {
    const actualCallback = typeof encoding === "function" ? encoding : callback;
    emitApplicationLog(level, Buffer.isBuffer(chunk) ? chunk.toString((typeof encoding === "string" ? encoding : "utf8") as BufferEncoding) : String(chunk));
    if (typeof actualCallback === "function") queueMicrotask(actualCallback);
    return true;
  };
  (process.stdout as any).write = capture("INFO");
  (process.stderr as any).write = capture("ERROR");
}

function sendStream(message: Record<string, unknown>, callback: (error?: Error | null) => void): void {
  streamProtocol.write(`${JSON.stringify({ ...message, invocationId: currentInvocationId })}\n`, callback);
}

class LambdaResponseStream extends Writable {
  metadata?: Record<string, unknown>;
  private wrote = false;
  private endedMessage = false;

  setMetadata(metadata: unknown): void {
    if (this.wrote || this.metadata) throw new Error("HTTP response metadata must be supplied once before the first response chunk");
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("HTTP response metadata must be an object");
    this.metadata = metadata as Record<string, unknown>;
    sendStream({ type: "metadata", metadata: this.metadata }, error => { if (error) this.destroy(error); });
  }

  _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.wrote = true; const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    sendStream({ type: "chunk", payload: bytes.toString("base64") }, callback);
  }

  _final(callback: (error?: Error | null) => void): void {
    this.endedMessage = true; sendStream({ type: "end" }, callback);
  }

  async finished(): Promise<void> {
    if (this.writableFinished) return;
    await new Promise<void>((resolveFinished, reject) => { this.once("finish", resolveFinished); this.once("error", reject); });
  }

  get protocolEnded(): boolean { return this.endedMessage; }
}

(globalThis as any).awslambda = {
  streamifyResponse(handler: unknown) {
    if (typeof handler !== "function") throw new TypeError("streamifyResponse expects a function");
    Object.defineProperty(handler, STREAMING_HANDLER, { value: true }); return handler;
  },
  HttpResponseStream: {
    from(stream: unknown, metadata: unknown) {
      if (!(stream instanceof LambdaResponseStream)) throw new TypeError("HttpResponseStream.from expects the Lambda response stream");
      stream.setMetadata(metadata); return stream;
    },
  },
};

function invokeOrdinary(handler: Function, event: unknown, context: Record<string, unknown>): Promise<unknown> {
  let callbackCalled = false;
  return new Promise((resolveResult, reject) => {
    const callback = (error: unknown, result: unknown) => { callbackCalled = true; error ? reject(error) : resolveResult(result); };
    (context as any).done = (error?: unknown, result?: unknown) => callback(error, result);
    (context as any).succeed = (result: unknown) => callback(undefined, result);
    (context as any).fail = (error: unknown) => callback(error, undefined);
    try {
      const returned = handler(event, context, callback);
      if (returned && typeof returned.then === "function") returned.then(resolveResult, reject);
      else if (returned !== undefined) resolveResult(returned);
      else if (handler.length < 3 && !callbackCalled) resolveResult(undefined);
    } catch (error) { reject(error); }
  });
}

async function loadHandler(request: InitializeRequest): Promise<Function> {
  const dot = request.handler.lastIndexOf(".");
  if (dot < 1) throw new Error(`Invalid handler '${request.handler}'. Expected module.exportName`);
  const moduleName = request.handler.slice(0, dot);
  const exportName = request.handler.slice(dot + 1);
  const modulePath = resolve(request.codeDir, moduleName);
  let loaded: any;
  let lastError: unknown;
  for (const candidate of [modulePath, `${modulePath}.js`, `${modulePath}.mjs`, `${modulePath}.cjs`]) {
    try { loaded = await import(pathToFileURL(candidate).href); break; }
    catch (error: any) {
      lastError = error;
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  if (!loaded) throw lastError;
  const handler = loaded[exportName] ?? loaded.default?.[exportName];
  if (typeof handler !== "function") throw new Error(`Handler export '${exportName}' was not found in ${moduleName}`);
  return handler;
}

const dynamicEnvironment = new Set<string>();
function refreshEnvironment(environment: Record<string, string>): void {
  for (const name of dynamicEnvironment) if (!(name in environment)) delete process.env[name];
  dynamicEnvironment.clear();
  for (const [name, value] of Object.entries(environment)) { process.env[name] = value; dynamicEnvironment.add(name); }
}
function clearEnvironment(): void { for (const name of dynamicEnvironment) delete process.env[name]; dynamicEnvironment.clear(); }

async function invoke(handler: Function, request: InvokeRequest): Promise<Record<string, unknown>> {
  currentInvocationId = request.invocationId;
  refreshEnvironment(request.environment);
  captureConsole();
  const started = performance.now();
  const timeoutMs = Number((request.context as any).__timeoutMs ?? 0);
  (request.context as any).getRemainingTimeInMillis = () => Math.max(0, timeoutMs - (performance.now() - started));
  delete (request.context as any).__timeoutMs;
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    if (request.streaming && (handler as any)[STREAMING_HANDLER]) {
      const response = new LambdaResponseStream(); await handler(request.event, response, request.context);
      if (!response.writableEnded) throw new Error("The response stream was not ended before the handler completed");
      await response.finished(); return { ok: true, streamed: true, metadata: response.metadata };
    } else if (request.streaming) {
      const result = await invokeOrdinary(handler, request.event, request.context); const bytes = Buffer.from(JSON.stringify(result ?? null));
      await new Promise<void>((resolveWrite, reject) => sendStream({ type: "chunk", payload: bytes.toString("base64") }, error => error ? reject(error) : resolveWrite()));
      await new Promise<void>((resolveWrite, reject) => sendStream({ type: "end" }, error => error ? reject(error) : resolveWrite()));
      return { ok: true, streamed: true };
    } else if ((handler as any)[STREAMING_HANDLER]) {
      throw new Error("Response streaming handlers require InvokeWithResponseStream or a RESPONSE_STREAM function URL");
    } else {
      const result = await invokeOrdinary(handler, request.event, request.context); return { ok: true, result };
    }
  }
  catch (error: any) { return { ok: false, error: { errorMessage: error?.message ?? String(error), errorType: error?.name ?? "Error", stackTrace: String(error?.stack ?? "").split("\n") } }; }
  finally { clearInterval(keepAlive); clearEnvironment(); currentInvocationId = "between-invocations"; }
}

const protocol = createWriteStream("lambda-runtime-result", { fd: 3, autoClose: false });
captureConsole();
let handler: Function | undefined;
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  pending += chunk;
  void (async () => {
    for (;;) {
      const newline = pending.indexOf("\n"); if (newline < 0) return;
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1); if (!line) continue;
      const request = JSON.parse(line) as InitializeRequest | InvokeRequest;
      if (request.type === "initialize") {
        try { handler = await loadHandler(request); protocol.write(`${JSON.stringify({ type: "ready", ok: true })}\n`); }
        catch (error: any) { protocol.write(`${JSON.stringify({ type: "ready", ok: false, error: { errorMessage: error?.message ?? String(error), errorType: error?.name ?? "Error", stackTrace: String(error?.stack ?? "").split("\n") } })}\n`); process.exitCode = 1; }
      } else if (request.type === "invoke" && handler) {
        const result = await invoke(handler, request); await finishApplicationLogs(request.invocationId); protocol.write(`${JSON.stringify({ type: "result", invocationId: request.invocationId, ...result })}\n`);
      } else throw new Error("Lambda runtime received an invalid protocol request");
    }
  })().catch(error => { protocol.write(`${JSON.stringify({ type: "ready", ok: false, error: { errorMessage: error?.message ?? String(error), errorType: error?.name ?? "Error" } })}\n`); process.exitCode = 1; });
});
