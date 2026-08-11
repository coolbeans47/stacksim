import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Clock } from "./core/clock.js";

export interface LambdaWorkerRuntime {
  codeDir: string;
  nodePath: string;
  optDir?: string;
  root: string;
  tmpDir: string;
}

export interface LambdaWorkerSpec {
  fingerprint: string;
  functionName: string;
  executedVersion: string;
  handler: string;
  logStreamName: string;
  initializationType: "on-demand" | "provisioned-concurrency";
  provisionedFor?: string;
  prepareRuntime(): Promise<LambdaWorkerRuntime>;
  launchEnvironment(runtime: LambdaWorkerRuntime): NodeJS.ProcessEnv;
}

export interface LambdaWorkerInvocation {
  invocationId: string;
  event: unknown;
  context: Record<string, unknown>;
  environment: Record<string, string>;
  streaming: boolean;
  timeoutMs: number;
  terminateOnCompletion?: Promise<void>;
  onMetadata?(metadata: Record<string, unknown>): Promise<void> | void;
  onChunk?(chunk: Buffer): Promise<void> | void;
}

export interface LambdaWorkerInvocationResult {
  ok: boolean;
  result?: unknown;
  error?: { errorMessage: string; errorType: string; stackTrace?: string[] };
  streamed?: boolean;
  metadata?: Record<string, unknown>;
  durationMs: number;
  timedOut: boolean;
  callbackTerminated: boolean;
  applicationLogs: Array<{ message: string; level: string }>;
}

interface RunnerMessage {
  type: "ready" | "result";
  invocationId?: string;
  ok: boolean;
  result?: unknown;
  error?: { errorMessage: string; errorType: string; stackTrace?: string[] };
  streamed?: boolean;
  metadata?: Record<string, unknown>;
}

class LambdaWorkerProtocolError extends Error {}

function runnerArguments(): string[] {
  const compiled = fileURLToPath(new URL("./lambda-runner.js", import.meta.url));
  if (existsSync(compiled)) return [compiled];
  const source = fileURLToPath(new URL("./lambda-runner.ts", import.meta.url));
  if (existsSync(source)) return ["--import", import.meta.resolve("tsx"), source];
  return [compiled];
}

export class LambdaWorker {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  busy = false;
  dead = false;
  retireOnRelease = false;
  lastUsedAt: number;
  idleCancel?: () => void;
  provisionedFor?: string;
  private protocolPending = "";
  private streamPending = "";
  private logPending = "";
  private initializationLogs: Array<{ message: string; level: string }> = [];
  private invocationLogs = new Map<string, Array<{ message: string; level: string }>>();
  private current?: {
    invocationId: string;
    resolve(message: RunnerMessage): void;
    reject(error: Error): void;
    onMetadata?(metadata: Record<string, unknown>): Promise<void> | void;
    onChunk?(chunk: Buffer): Promise<void> | void;
    streamEnded: boolean;
    streamMetadata: boolean;
    streamBytes: number;
    streamTail: Promise<void>;
    streamComplete: Promise<void>;
    resolveStreamComplete(): void;
    streamFailure?: Error;
    logsComplete: Promise<void>;
    resolveLogsComplete(): void;
  };
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private closed: Promise<void>;
  private resolveClosed!: () => void;

  constructor(
    readonly spec: LambdaWorkerSpec,
    readonly runtime: LambdaWorkerRuntime,
    private readonly clock: Clock,
    private readonly children: Set<ChildProcess>,
    private readonly onUnexpectedExit: (worker: LambdaWorker) => void,
  ) {
    this.provisionedFor = spec.provisionedFor;
    this.lastUsedAt = clock.now();
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
    this.child = spawn(process.execPath, runnerArguments(), {
      cwd: runtime.codeDir,
      env: spec.launchEnvironment(runtime),
      stdio: ["pipe", "ignore", "ignore", "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    children.add(this.child);
    const stdio = this.child.stdio as unknown as Array<NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined>;
    (stdio[3] as NodeJS.ReadableStream).on("data", chunk => this.consumeProtocol(Buffer.from(chunk).toString("utf8")));
    (stdio[4] as NodeJS.ReadableStream).on("data", chunk => this.consumeStream(Buffer.from(chunk).toString("utf8")));
    (stdio[5] as NodeJS.ReadableStream).on("data", chunk => this.consumeLogs(Buffer.from(chunk).toString("utf8")));
    this.child.on("error", error => this.fail(error));
    this.child.on("close", (code, signal) => {
      this.dead = true;
      children.delete(this.child);
      const error = new Error(`Lambda runtime exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
      this.rejectReady(error);
      if (this.current) { this.current.streamFailure = error; this.current.resolveStreamComplete(); this.current.reject(error); }
      this.current = undefined;
      this.resolveClosed();
      void rm(runtime.root, { recursive: true, force: true });
      this.onUnexpectedExit(this);
    });
    this.child.stdin!.write(`${JSON.stringify({ type: "initialize", codeDir: runtime.codeDir, handler: spec.handler })}\n`);
  }

  private fail(error: Error): void {
    this.rejectReady(error);
    if (this.current) { this.current.streamFailure = error; this.current.resolveStreamComplete(); this.current.reject(error); }
    void this.terminate();
  }

  private consumeProtocol(chunk: string): void {
    this.protocolPending += chunk;
    for (;;) {
      const newline = this.protocolPending.indexOf("\n");
      if (newline < 0) return;
      const line = this.protocolPending.slice(0, newline); this.protocolPending = this.protocolPending.slice(newline + 1);
      if (!line) continue;
      let message: RunnerMessage;
      try { message = JSON.parse(line); }
      catch { return this.fail(new LambdaWorkerProtocolError("Lambda runtime emitted malformed result protocol JSON")); }
      if (message.type === "ready") {
        if (message.ok) this.resolveReady();
        else { this.retireOnRelease = true; this.rejectReady(new Error(message.error?.errorMessage ?? "Lambda runtime initialization failed")); void this.terminate(); }
        continue;
      }
      if (message.type !== "result" || !this.current || message.invocationId !== this.current.invocationId) return this.fail(new LambdaWorkerProtocolError("Lambda runtime emitted an unexpected result protocol message"));
      this.current.resolve(message);
    }
  }

  private consumeLogs(chunk: string): void {
    this.logPending += chunk;
    for (;;) {
      const newline = this.logPending.indexOf("\n"); if (newline < 0) return;
      const line = this.logPending.slice(0, newline); this.logPending = this.logPending.slice(newline + 1); if (!line) continue;
      try {
        const value = JSON.parse(line);
        if (value.type === "complete" && typeof value.invocationId === "string") { const current = this.current; if (current && current.invocationId === value.invocationId) current.resolveLogsComplete(); continue; }
        if (typeof value.message !== "string") continue;
        const entry = { message: value.message, level: String(value.level ?? "INFO") };
        if (value.invocationId === "initialization") this.initializationLogs.push(entry);
        else if (typeof value.invocationId === "string" && this.current?.invocationId === value.invocationId) {
          const logs = this.invocationLogs.get(value.invocationId) ?? []; logs.push(entry); this.invocationLogs.set(value.invocationId, logs);
        }
      } catch { this.fail(new LambdaWorkerProtocolError("Lambda runtime emitted malformed application-log protocol JSON")); }
    }
  }

  private consumeStream(chunk: string): void {
    this.streamPending += chunk;
    for (;;) {
      const newline = this.streamPending.indexOf("\n"); if (newline < 0) return;
      const line = this.streamPending.slice(0, newline); this.streamPending = this.streamPending.slice(newline + 1); if (!line) continue;
      let message: any;
      try { message = JSON.parse(line); } catch { return this.fail(new LambdaWorkerProtocolError("Lambda runtime emitted malformed streaming protocol JSON")); }
      const current = this.current;
      if (!current || message.invocationId !== current.invocationId) return this.fail(new LambdaWorkerProtocolError("Lambda runtime emitted a stream message for the wrong invocation"));
      current.streamTail = current.streamTail.then(async () => {
        if (message.type === "metadata") {
          if (current.streamMetadata || current.streamBytes || current.streamEnded || !message.metadata || typeof message.metadata !== "object") throw new LambdaWorkerProtocolError("Invalid or late response stream metadata");
          current.streamMetadata = true; await current.onMetadata?.(message.metadata);
        } else if (message.type === "chunk") {
          if (current.streamEnded || typeof message.payload !== "string") throw new LambdaWorkerProtocolError("Invalid response stream chunk sequence");
          const bytes = Buffer.from(message.payload, "base64"); current.streamBytes += bytes.length;
          if (current.streamBytes > 200 * 1024 * 1024) throw new LambdaWorkerProtocolError("The streamed response exceeded 200 MB");
          await current.onChunk?.(bytes);
        } else if (message.type === "end") {
          if (current.streamEnded) throw new LambdaWorkerProtocolError("The response stream ended more than once"); current.streamEnded = true; current.resolveStreamComplete();
        } else throw new LambdaWorkerProtocolError("Unknown response stream protocol message");
      }).catch(error => { this.fail(error instanceof Error ? error : new Error(String(error))); });
    }
  }

  private async finishStream(streaming: boolean, ok: boolean): Promise<void> {
    const current = this.current;
    if (!current) throw new LambdaWorkerProtocolError("Lambda runtime invocation state disappeared before its result was complete");
    if (streaming && ok) await current.streamComplete;
    await current.streamTail;
    if (current.streamFailure) throw current.streamFailure;
    if (streaming && ok && !current.streamEnded) throw new LambdaWorkerProtocolError("The response stream did not terminate");
  }

  async invoke(input: LambdaWorkerInvocation): Promise<LambdaWorkerInvocationResult> {
    if (this.dead || this.current) throw new Error("Lambda worker is not available");
    this.busy = true; this.lastUsedAt = this.clock.now();
    const started = performance.now(); let timedOut = false; let callbackTerminated = false; let closed = false;
    const result = new Promise<RunnerMessage>((resolve, reject) => {
      let resolveLogsComplete!: () => void; const logsComplete = new Promise<void>(resolveLogs => { resolveLogsComplete = resolveLogs; });
      let resolveStreamComplete!: () => void; const streamComplete = new Promise<void>(resolveStream => { resolveStreamComplete = resolveStream; });
      this.current = { invocationId: input.invocationId, resolve, reject, onMetadata: input.onMetadata, onChunk: input.onChunk, streamEnded: false, streamMetadata: false, streamBytes: 0, streamTail: Promise.resolve(), streamComplete, resolveStreamComplete, logsComplete, resolveLogsComplete };
    });
    const kill = () => { timedOut = true; void this.terminate(); };
    const timer = setTimeout(kill, input.timeoutMs);
    void input.terminateOnCompletion?.then(() => { if (!closed) { callbackTerminated = true; void this.terminate(); } }, () => undefined);
    try {
      this.child.stdin!.write(`${JSON.stringify({ type: "invoke", invocationId: input.invocationId, event: input.event, context: input.context, environment: input.environment, streaming: input.streaming })}\n`);
      const message = await result;
      await this.finishStream(input.streaming, message.ok);
      await this.current!.logsComplete;
      const applicationLogs = [...this.initializationLogs, ...(this.invocationLogs.get(input.invocationId) ?? [])];
      this.initializationLogs = []; this.invocationLogs.delete(input.invocationId);
      return { ok: message.ok, result: message.result, error: message.error, streamed: message.streamed, metadata: message.metadata, durationMs: performance.now() - started, timedOut, callbackTerminated, applicationLogs };
    } catch (error) {
      const applicationLogs = [...this.initializationLogs, ...(this.invocationLogs.get(input.invocationId) ?? [])];
      this.initializationLogs = []; this.invocationLogs.delete(input.invocationId);
      if (callbackTerminated) return { ok: true, result: null, durationMs: performance.now() - started, timedOut, callbackTerminated, applicationLogs };
      return { ok: false, error: { errorMessage: timedOut ? `Task timed out after ${(input.timeoutMs / 1000).toFixed(2)} seconds` : error instanceof Error ? error.message : String(error), errorType: timedOut ? "TimeoutError" : "Runtime.ExitError" }, durationMs: performance.now() - started, timedOut, callbackTerminated, applicationLogs };
    } finally {
      closed = true; clearTimeout(timer); this.current = undefined; this.busy = false; this.lastUsedAt = this.clock.now();
    }
  }

  async terminate(): Promise<void> {
    if (!this.dead) {
      this.dead = true;
      try { if (process.platform !== "win32") process.kill(-this.child.pid!, "SIGKILL"); else this.child.kill("SIGKILL"); } catch {}
    }
    await this.closed;
  }
}

export class LambdaWorkerPool {
  private readonly workers = new Set<LambdaWorker>();
  private readonly pendingCreations = new Set<Promise<void>>();
  private creating = 0;
  private stopped = false;

  constructor(
    private readonly clock: Clock,
    private readonly children: Set<ChildProcess>,
    private readonly maxWorkers: number,
    private readonly idleMs: number,
    private readonly onProvisionedChanged?: (target: string, allocated: number, error?: Error) => void,
  ) {}

  private onUnexpectedExit(worker: LambdaWorker): void {
    this.workers.delete(worker);
    if (!this.stopped && worker.provisionedFor && !worker.retireOnRelease) {
      const target = worker.provisionedFor; this.onProvisionedChanged?.(target, this.provisionedCount(target));
      void this.make(worker.spec).then(replacement => { replacement.busy = false; this.idle(replacement); this.onProvisionedChanged?.(target, this.provisionedCount(target)); }, error => this.onProvisionedChanged?.(target, this.provisionedCount(target), error instanceof Error ? error : new Error(String(error))));
    }
  }
  private idle(worker: LambdaWorker): void {
    worker.idleCancel?.(); worker.idleCancel = undefined;
    if (worker.dead || worker.busy || worker.provisionedFor || worker.retireOnRelease || this.stopped) {
      if (worker.retireOnRelease || this.stopped) void this.retire(worker);
      return;
    }
    const handle = this.clock.setTimeout(() => { if (!worker.busy && !worker.provisionedFor) void this.retire(worker); }, this.idleMs);
    worker.idleCancel = () => this.clock.clearTimeout(handle);
  }

  private async make(spec: LambdaWorkerSpec): Promise<LambdaWorker> {
    if (this.stopped) throw new Error("Lambda worker pool is stopped");
    let victim: LambdaWorker | undefined;
    if (this.workers.size + this.creating >= this.maxWorkers) {
      victim = [...this.workers].filter(worker => !worker.busy && !worker.provisionedFor).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!victim) throw new Error(`Lambda worker pool reached its bounded capacity of ${this.maxWorkers}`);
      victim.retireOnRelease = true; victim.idleCancel?.(); victim.idleCancel = undefined; this.workers.delete(victim);
    }
    let finishCreation!: () => void;
    const pendingCreation = new Promise<void>(resolve => { finishCreation = resolve; });
    this.pendingCreations.add(pendingCreation);
    this.creating++;
    try {
      if (victim) await victim.terminate().catch(() => undefined);
      const runtime = await spec.prepareRuntime();
      if (this.stopped) { await rm(runtime.root, { recursive: true, force: true }); throw new Error("Lambda worker pool is stopped"); }
      const worker = new LambdaWorker(spec, runtime, this.clock, this.children, value => this.onUnexpectedExit(value));
      // Keep initialization represented only by `creating` until it is ready.
      // Adding it to `workers` earlier double-counts the same capacity slot and
      // can make another admitted concurrent lease fail spuriously.
      worker.busy = true;
      try { await worker.ready; this.workers.add(worker); return worker; }
      catch (error) { this.workers.delete(worker); await worker.terminate().catch(() => undefined); throw error; }
    } finally { this.creating--; this.pendingCreations.delete(pendingCreation); finishCreation(); }
  }

  async lease(spec: LambdaWorkerSpec): Promise<LambdaWorker> {
    const worker = [...this.workers].filter(candidate => !candidate.dead && !candidate.busy && candidate.spec.fingerprint === spec.fingerprint && candidate.provisionedFor === spec.provisionedFor).sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] ?? await this.make(spec);
    worker.idleCancel?.(); worker.idleCancel = undefined; worker.busy = true; return worker;
  }

  release(worker: LambdaWorker, reusable: boolean): void {
    worker.busy = false;
    if (!reusable || worker.retireOnRelease || worker.dead || this.stopped) void this.retire(worker);
    else this.idle(worker);
  }

  async reconcileProvisioned(target: string, specs: LambdaWorkerSpec[]): Promise<void> {
    const desired = new Map<string, LambdaWorkerSpec[]>();
    for (const spec of specs) { const values = desired.get(spec.fingerprint) ?? []; values.push(spec); desired.set(spec.fingerprint, values); }
    for (const worker of [...this.workers].filter(value => value.provisionedFor === target)) {
      const values = desired.get(worker.spec.fingerprint);
      if (values?.length) values.pop(); else if (worker.busy) worker.retireOnRelease = true; else await this.retire(worker);
    }
    for (const values of desired.values()) for (const spec of values) { const worker = await this.make({ ...spec, provisionedFor: target, initializationType: "provisioned-concurrency" }); worker.busy = false; this.idle(worker); }
  }

  async retireFunctionVersion(functionName: string, executedVersion?: string): Promise<void> {
    await Promise.all([...this.workers].filter(worker => worker.spec.functionName === functionName && (executedVersion === undefined || worker.spec.executedVersion === executedVersion)).map(worker => this.retire(worker)));
  }

  async retireProvisioned(target: string): Promise<void> { await this.reconcileProvisioned(target, []); }

  private async retire(worker: LambdaWorker): Promise<void> {
    worker.retireOnRelease = true; worker.idleCancel?.(); worker.idleCancel = undefined; this.workers.delete(worker); await worker.terminate().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.workers].map(worker => this.retire(worker)));
    await Promise.all([...this.pendingCreations]);
    await Promise.all([...this.workers].map(worker => this.retire(worker)));
  }

  provisionedCount(target: string): number { return [...this.workers].filter(worker => !worker.dead && worker.provisionedFor === target).length; }
  get size(): number { return this.workers.size; }
}
