import type { IncomingMessage, ServerResponse } from "node:http";
import { AwsError } from "./errors.js";
import type { Clock } from "./core/clock.js";
import type { Scheduler } from "./core/scheduler.js";
import { PaginationTokens } from "./core/pagination.js";
import type { StateStore } from "./state.js";
import type { LambdaDurableErrorState, LambdaDurableExecutionState, LambdaDurableHistoryEventState, LambdaDurableOperationState, LambdaVersionState } from "./types.js";
import { id, json, readBody, sha256 } from "./util.js";

const OPERATION_TYPES = new Set(["EXECUTION", "CONTEXT", "STEP", "WAIT", "CALLBACK", "CHAINED_INVOKE"]);
const OPERATION_ACTIONS = new Set(["START", "SUCCEED", "FAIL", "RETRY", "CANCEL"]);
const EXECUTION_STATUSES = new Set(["RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "STOPPED"]);
const TERMINAL_OPERATIONS = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "STOPPED"]);
const DEFAULT_EXECUTION_TIMEOUT = 86_400;
const DEFAULT_RETENTION_DAYS = 14;

export interface DurableRuntimeResult {
  payload: Buffer;
  functionError?: string;
  interrupted?: boolean;
  requestId: string;
  durationMs: number;
  billedDurationMs: number;
  executedVersion: string;
  logResult?: string;
}

interface DurableHooks {
  invokeExecution(execution: LambdaDurableExecutionState, input: Record<string, unknown>): Promise<DurableRuntimeResult>;
  invokeChained(execution: LambdaDurableExecutionState, functionName: string, payload: Buffer): Promise<DurableRuntimeResult>;
  deliverDeadLetter(execution: LambdaDurableExecutionState): Promise<void>;
  terminateExecution(executionArn: string): void;
}

export interface StartDurableExecutionInput {
  functionName: string;
  functionArn: string;
  requestedQualifier: string;
  executedVersion: string;
  executable: LambdaVersionState;
  invocationType: "RequestResponse" | "Event";
  payload: Buffer;
  durableExecutionName?: string;
  traceHeader?: string;
  lineage?: string[];
}

export interface DurableRunOutcome {
  execution: LambdaDurableExecutionState;
  invocation?: DurableRuntimeResult;
}

function checkpointToken(): string { return Buffer.from(id(48), "hex").toString("base64"); }
function callbackId(): string { return Buffer.from(id(48), "hex").toString("base64url"); }
function epoch(value: number): number { return value / 1000; }
function plainObject(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function clone<T>(value: T): T { return structuredClone(value); }

function durableError(value: unknown, fallbackType = "Error", fallbackMessage = "Durable execution failed"): LambdaDurableErrorState {
  if (!plainObject(value)) return { ErrorType: fallbackType, ErrorMessage: fallbackMessage };
  const result: LambdaDurableErrorState = {};
  if (value.ErrorMessage !== undefined) { if (typeof value.ErrorMessage !== "string") throw new AwsError("InvalidParameterValueException", "ErrorMessage must be a string"); result.ErrorMessage = value.ErrorMessage; }
  if (value.ErrorType !== undefined) { if (typeof value.ErrorType !== "string") throw new AwsError("InvalidParameterValueException", "ErrorType must be a string"); result.ErrorType = value.ErrorType; }
  if (value.ErrorData !== undefined) { if (typeof value.ErrorData !== "string") throw new AwsError("InvalidParameterValueException", "ErrorData must be a string"); result.ErrorData = value.ErrorData; }
  if (value.StackTrace !== undefined) { if (!Array.isArray(value.StackTrace) || value.StackTrace.some(item => typeof item !== "string")) throw new AwsError("InvalidParameterValueException", "StackTrace must be a string list"); result.StackTrace = [...value.StackTrace]; }
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new AwsError("InvalidParameterValueException", "The durable error exceeds 256 KB");
  return Object.keys(result).length ? result : { ErrorType: fallbackType, ErrorMessage: fallbackMessage };
}

function maxItems(url: URL): number {
  const value = Number(url.searchParams.get("MaxItems") ?? 100);
  if (!Number.isInteger(value) || value < 0 || value > 1000) throw new AwsError("InvalidParameterValueException", "MaxItems must be between 0 and 1000");
  return value || 100;
}

function booleanQuery(url: URL, name: string, defaultValue: boolean): boolean {
  const raw = url.searchParams.get(name); if (raw === null) return defaultValue;
  if (raw !== "true" && raw !== "false") throw new AwsError("InvalidParameterValueException", `${name} must be true or false`);
  return raw === "true";
}

function queryTimestamp(raw: string | null, name: string): number | undefined {
  if (raw === null) return undefined; const numeric = Number(raw); const value = raw.trim() && Number.isFinite(numeric) ? numeric * 1000 : Date.parse(raw);
  if (!Number.isFinite(value)) throw new AwsError("InvalidParameterValueException", `${name} must be a valid timestamp`); return value;
}

export function durableConfig(input: unknown, region: string, accountId: string, previous?: LambdaDurableExecutionState["durableConfig"], creating = false): LambdaDurableExecutionState["durableConfig"] | undefined {
  if (input === undefined) return previous ? clone(previous) : undefined;
  if (!plainObject(input)) throw new AwsError("InvalidParameterValueException", "DurableConfig must be an object");
  if (!creating && !previous) throw new AwsError("InvalidParameterValueException", "Durability can be enabled only when the function is created");
  if (!creating && input.KMSKeyArn !== undefined && input.KMSKeyArn !== previous?.kmsKeyArn) throw new AwsError("InvalidParameterValueException", "A durable KMS key cannot be changed after function creation");
  const executionTimeout = input.ExecutionTimeout ?? previous?.executionTimeout ?? DEFAULT_EXECUTION_TIMEOUT;
  const retentionPeriodInDays = input.RetentionPeriodInDays ?? previous?.retentionPeriodInDays ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(executionTimeout) || executionTimeout < 1 || executionTimeout > 31_622_400) throw new AwsError("InvalidParameterValueException", "DurableConfig.ExecutionTimeout must be between 1 and 31622400 seconds");
  if (!Number.isInteger(retentionPeriodInDays) || retentionPeriodInDays < 1 || retentionPeriodInDays > 90) throw new AwsError("InvalidParameterValueException", "DurableConfig.RetentionPeriodInDays must be between 1 and 90 days");
  const kmsKeyArn = input.KMSKeyArn ?? previous?.kmsKeyArn;
  if (kmsKeyArn !== undefined && (typeof kmsKeyArn !== "string" || !new RegExp(`^arn:(?:aws|aws-us-gov|aws-cn):kms:${region}:${accountId}:key/[A-Za-z0-9-]+$`).test(kmsKeyArn))) throw new AwsError("InvalidParameterValueException", "DurableConfig.KMSKeyArn must be a same-account, same-Region KMS key ARN");
  return { executionTimeout, retentionPeriodInDays, ...(kmsKeyArn ? { kmsKeyArn } : {}) };
}

export function durableConfigView(config?: LambdaDurableExecutionState["durableConfig"]): any {
  return config ? { ExecutionTimeout: config.executionTimeout, RetentionPeriodInDays: config.retentionPeriodInDays, ...(config.kmsKeyArn ? { KMSKeyArn: config.kmsKeyArn } : {}) } : undefined;
}

export class LambdaDurableExecutions {
  private readonly running = new Set<string>();
  private readonly activeRuns = new Set<Promise<DurableRunOutcome>>();
  private readonly timers = new Map<string, () => void>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly waiters = new Map<string, Set<(terminal: boolean) => void>>();
  private stopped = true;

  constructor(private readonly store: StateStore, private readonly region: string, private readonly clock: Clock, private readonly scheduler: Scheduler | undefined, private readonly hooks: DurableHooks) {}
  private get state(): Record<string, LambdaDurableExecutionState> { return this.store.regionState(this.region).lambdaDurableExecutions; }
  private get tokens(): PaginationTokens { return new PaginationTokens(this.store.state.installation.paginationSecret); }
  private require(arn: string): LambdaDurableExecutionState { const execution = this.state[arn]; if (!execution) throw new AwsError("ResourceNotFoundException", "Durable execution not found", 404); return execution; }
  private cancel(key: string): void { this.timers.get(key)?.(); this.timers.delete(key); }
  private schedule(key: string, at: number, callback: () => void | Promise<void>): void {
    this.cancel(key); const run = () => {
      this.timers.delete(key);
      let task: Promise<void>;
      try { task = Promise.resolve(callback()).then(() => undefined); }
      catch (error) { task = Promise.reject(error); }
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
    }; const delay = Math.max(0, at - this.clock.now());
    if (this.scheduler) this.timers.set(key, this.scheduler.schedule(run, delay)); else { const handle = this.clock.setTimeout(run, delay); this.timers.set(key, () => this.clock.clearTimeout(handle)); }
  }
  private appendHistory(execution: LambdaDurableExecutionState, eventType: string, operation?: LambdaDurableOperationState, details?: Record<string, unknown>): void {
    const event: LambdaDurableHistoryEventState = { eventId: execution.nextEventId++, eventType, eventTimestamp: this.clock.now(), ...(operation ? { id: operation.id, ...(operation.parentId ? { parentId: operation.parentId } : {}), ...(operation.name ? { name: operation.name } : {}), ...(operation.subType ? { subType: operation.subType } : {}) } : {}), ...(details ? { details } : {}) };
    execution.history.push(event);
  }
  private operationView(operation: LambdaDurableOperationState): any {
    return { Id: operation.id, ...(operation.parentId ? { ParentId: operation.parentId } : {}), ...(operation.name ? { Name: operation.name } : {}), Type: operation.type, ...(operation.subType ? { SubType: operation.subType } : {}), StartTimestamp: epoch(operation.startTimestamp), ...(operation.endTimestamp !== undefined ? { EndTimestamp: epoch(operation.endTimestamp) } : {}), Status: operation.status,
      ...(operation.executionDetails ? { ExecutionDetails: { ...(operation.executionDetails.inputPayload !== undefined ? { InputPayload: operation.executionDetails.inputPayload } : {}) } } : {}),
      ...(operation.contextDetails ? { ContextDetails: { ...(operation.contextDetails.replayChildren !== undefined ? { ReplayChildren: operation.contextDetails.replayChildren } : {}), ...(operation.contextDetails.result !== undefined ? { Result: operation.contextDetails.result } : {}), ...(operation.contextDetails.error ? { Error: clone(operation.contextDetails.error) } : {}) } } : {}),
      ...(operation.stepDetails ? { StepDetails: { ...(operation.stepDetails.attempt !== undefined ? { Attempt: operation.stepDetails.attempt } : {}), ...(operation.stepDetails.nextAttemptTimestamp !== undefined ? { NextAttemptTimestamp: epoch(operation.stepDetails.nextAttemptTimestamp) } : {}), ...(operation.stepDetails.result !== undefined ? { Result: operation.stepDetails.result } : {}), ...(operation.stepDetails.error ? { Error: clone(operation.stepDetails.error) } : {}) } } : {}),
      ...(operation.waitDetails ? { WaitDetails: { ...(operation.waitDetails.scheduledEndTimestamp !== undefined ? { ScheduledEndTimestamp: epoch(operation.waitDetails.scheduledEndTimestamp) } : {}) } } : {}),
      ...(operation.callbackDetails ? { CallbackDetails: { ...(operation.callbackDetails.callbackId ? { CallbackId: operation.callbackDetails.callbackId } : {}), ...(operation.callbackDetails.result !== undefined ? { Result: operation.callbackDetails.result } : {}), ...(operation.callbackDetails.error ? { Error: clone(operation.callbackDetails.error) } : {}) } } : {}),
      ...(operation.chainedInvokeDetails ? { ChainedInvokeDetails: { ...(operation.chainedInvokeDetails.result !== undefined ? { Result: operation.chainedInvokeDetails.result } : {}), ...(operation.chainedInvokeDetails.error ? { Error: clone(operation.chainedInvokeDetails.error) } : {}) } } : {}) };
  }
  private historyView(event: LambdaDurableHistoryEventState, includeData: boolean): any {
    const value: any = { EventType: event.eventType, EventId: event.eventId, EventTimestamp: epoch(event.eventTimestamp), ...(event.id ? { Id: event.id } : {}), ...(event.parentId ? { ParentId: event.parentId } : {}), ...(event.name ? { Name: event.name } : {}), ...(event.subType ? { SubType: event.subType } : {}), ...(event.details ? clone(event.details) : {}) };
    if (!includeData) {
      const strip = (item: any): void => { if (!item || typeof item !== "object") return; if (Object.prototype.hasOwnProperty.call(item, "Payload")) delete item.Payload; for (const child of Object.values(item)) strip(child); };
      strip(value);
    }
    return value;
  }
  private executionView(execution: LambdaDurableExecutionState, includeData = true): any {
    return { DurableExecutionArn: execution.durableExecutionArn, DurableExecutionName: execution.durableExecutionName, FunctionArn: execution.functionArn, StartTimestamp: epoch(execution.startTimestamp), Status: execution.status, ...(execution.endTimestamp !== undefined ? { EndTimestamp: epoch(execution.endTimestamp) } : {}), Version: execution.executedVersion, ...(execution.traceHeader ? { TraceHeader: { XAmznTraceId: execution.traceHeader } } : {}), ExecutionDataIncluded: includeData, DurableConfig: durableConfigView(execution.durableConfig), ...(includeData ? { InputPayload: execution.inputPayload, ...(execution.result !== undefined ? { Result: execution.result } : {}), ...(execution.error ? { Error: clone(execution.error) } : {}) } : {}) };
  }
  private summary(execution: LambdaDurableExecutionState): any { return { DurableExecutionArn: execution.durableExecutionArn, DurableExecutionName: execution.durableExecutionName, FunctionArn: execution.functionArn, Status: execution.status, StartTimestamp: epoch(execution.startTimestamp), ...(execution.endTimestamp !== undefined ? { EndTimestamp: epoch(execution.endTimestamp) } : {}), ...(execution.durableConfig.kmsKeyArn ? { KMSKeyArn: execution.durableConfig.kmsKeyArn } : {}) }; }

  async create(input: StartDurableExecutionInput): Promise<{ execution: LambdaDurableExecutionState; created: boolean }> {
    this.purgeExpired(); const name = input.durableExecutionName ?? id(32);
    if (!/^[A-Za-z0-9-_]{1,64}$/.test(name)) throw new AwsError("InvalidParameterValueException", "X-Amz-Durable-Execution-Name must be 1-64 letters, numbers, hyphens, or underscores");
    const hash = sha256(input.payload); const existing = Object.values(this.state).find(item => item.durableExecutionName === name);
    if (existing) {
      if (existing.inputHash !== hash || existing.functionArn !== input.functionArn) throw new AwsError("DurableExecutionAlreadyStartedException", `A durable execution named ${name} already exists with different input`, 409);
      return { execution: existing, created: false };
    }
    const invocationId = id(32); const arn = `${input.functionArn}/durable-execution/${name}/${invocationId}`; const now = this.clock.now(); const config = clone(input.executable.durableConfig!);
    const root: LambdaDurableOperationState = { id: "execution", type: "EXECUTION", startTimestamp: now, status: "STARTED", sequence: 0, executionDetails: { inputPayload: input.payload.toString("utf8") } };
    const execution: LambdaDurableExecutionState = { durableExecutionArn: arn, durableExecutionName: name, invocationId, functionName: input.functionName, functionArn: input.functionArn, requestedQualifier: input.requestedQualifier, executedVersion: input.executedVersion, executable: clone(input.executable), invocationType: input.invocationType, inputPayload: input.payload.toString("utf8"), inputHash: hash, status: "RUNNING", startTimestamp: now, ...(input.traceHeader ? { traceHeader: input.traceHeader } : {}), durableConfig: config, checkpointToken: checkpointToken(), operations: [root], history: [], nextEventId: 1, nextOperationSequence: 1, updatedOperationIds: [], clientTokens: {}, ...(input.lineage?.length ? { lineage: [...input.lineage] } : {}) };
    this.appendHistory(execution, "ExecutionStarted", root, { ExecutionStartedDetails: { Input: { Payload: execution.inputPayload, Truncated: false }, ExecutionTimeout: config.executionTimeout } }); this.state[arn] = execution; await this.store.save(); this.scheduleExecutionTimeout(execution); return { execution, created: true };
  }

  private scheduleExecutionTimeout(execution: LambdaDurableExecutionState): void {
    if (execution.status !== "RUNNING") return; this.schedule(`timeout:${execution.durableExecutionArn}`, execution.startTimestamp + execution.durableConfig.executionTimeout * 1000, async () => {
      if (execution.status !== "RUNNING") return; const error = { ErrorType: "DurableExecutionTimeout", ErrorMessage: "The durable execution exceeded its configured execution timeout" }; this.finish(execution, "TIMED_OUT", undefined, error); this.hooks.terminateExecution(execution.durableExecutionArn); await this.store.save();
    });
  }
  private pendingAt(operation: LambdaDurableOperationState): number | undefined {
    if (operation.status !== "PENDING") return undefined;
    if (operation.type === "WAIT") return operation.waitDetails?.scheduledEndTimestamp;
    if (operation.type === "STEP") return operation.stepDetails?.nextAttemptTimestamp;
    if (operation.type === "CALLBACK") return Math.min(operation.callbackDetails?.timeoutAt ?? Number.POSITIVE_INFINITY, operation.callbackDetails?.heartbeatDeadline ?? Number.POSITIVE_INFINITY);
    return undefined;
  }
  private scheduleOperation(execution: LambdaDurableExecutionState, operation: LambdaDurableOperationState): void {
    const at = this.pendingAt(operation); if (at === undefined || !Number.isFinite(at)) return; this.schedule(`operation:${execution.durableExecutionArn}:${operation.id}`, at, async () => {
      if (execution.status !== "RUNNING" || operation.status !== "PENDING") return; const now = this.clock.now();
      if (operation.type === "WAIT") { operation.status = "SUCCEEDED"; operation.endTimestamp = now; this.appendHistory(execution, "WaitSucceeded", operation, { WaitSucceededDetails: { Duration: operation.waitDetails?.duration } }); }
      else if (operation.type === "STEP") { operation.status = "READY"; if (operation.stepDetails) delete operation.stepDetails.nextAttemptTimestamp; }
      else if (operation.type === "CALLBACK") { operation.status = "TIMED_OUT"; operation.endTimestamp = now; operation.callbackDetails!.error = { ErrorType: "CallbackTimeoutException", ErrorMessage: "The durable callback timed out" }; this.appendHistory(execution, "CallbackTimedOut", operation, { CallbackTimedOutDetails: { Error: { Payload: clone(operation.callbackDetails!.error), Truncated: false } } }); }
      execution.updatedOperationIds.push(operation.id); await this.store.save(); this.scheduleReplay(execution, 0);
    });
  }
  private scheduleReplay(execution: LambdaDurableExecutionState, delayMs: number): void { if (this.stopped || execution.status !== "RUNNING") return; this.schedule(`replay:${execution.durableExecutionArn}`, this.clock.now() + delayMs, async () => { await this.run(execution.durableExecutionArn); }); }
  private scheduleDeadLetter(execution: LambdaDurableExecutionState): void {
    const delivery = execution.deadLetterDelivery;
    if (this.stopped || !delivery || delivery.status !== "PENDING") return;
    this.schedule(`dead-letter:${execution.durableExecutionArn}`, delivery.nextAttemptAt, async () => { await this.deliverDeadLetter(execution.durableExecutionArn); });
  }
  private async deliverDeadLetter(arn: string): Promise<void> {
    const execution = this.state[arn]; const delivery = execution?.deadLetterDelivery;
    if (this.stopped || !execution || !delivery || delivery.status !== "PENDING") return;
    delivery.attempts++; delivery.lastAttemptAt = this.clock.now(); delete delivery.lastError; await this.store.save();
    try {
      await this.hooks.deliverDeadLetter(execution); delivery.status = "DELIVERED"; delivery.deliveredAt = this.clock.now(); delete delivery.lastError; await this.store.save();
    } catch (error) {
      delivery.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
      delivery.nextAttemptAt = this.clock.now() + Math.min(300_000, 1_000 * 2 ** Math.min(8, delivery.attempts - 1));
      await this.store.save(); this.scheduleDeadLetter(execution);
    }
  }
  private finish(execution: LambdaDurableExecutionState, status: Exclude<LambdaDurableExecutionState["status"], "RUNNING">, result?: string, error?: LambdaDurableErrorState): void {
    if (execution.status !== "RUNNING") return; const now = this.clock.now(); execution.status = status; execution.endTimestamp = now; if (result !== undefined) execution.result = result; if (error) execution.error = clone(error); const root = execution.operations[0]; root.status = status; root.endTimestamp = now;
    const type = status === "SUCCEEDED" ? "ExecutionSucceeded" : status === "FAILED" ? "ExecutionFailed" : status === "TIMED_OUT" ? "ExecutionTimedOut" : "ExecutionStopped"; const key = `${type}Details`; const details = status === "SUCCEEDED" ? { Result: { Payload: result ?? "null", Truncated: false } } : { Error: { Payload: clone(error ?? { ErrorType: status, ErrorMessage: `Execution ${status.toLowerCase()}` }), Truncated: false } }; this.appendHistory(execution, type, root, { [key]: details });
    for (const keyName of [...this.timers.keys()]) if (keyName.includes(execution.durableExecutionArn)) this.cancel(keyName); for (const waiter of this.waiters.get(execution.durableExecutionArn) ?? []) waiter(true); this.waiters.delete(execution.durableExecutionArn);
    const targetArn = status === "SUCCEEDED" ? undefined : execution.executable.deadLetterTargetArn;
    if (targetArn) execution.deadLetterDelivery = targetArn.includes(":sqs:")
      ? { targetArn, status: "PENDING", attempts: 0, nextAttemptAt: now }
      : { targetArn, status: "UNSUPPORTED", attempts: 0, nextAttemptAt: now, lastError: "SNS durable dead-letter delivery is not available in this simulator" };
    this.scheduleDeadLetter(execution);
  }

  async run(arn: string): Promise<DurableRunOutcome> {
    const execution = this.require(arn); if (execution.status !== "RUNNING" || this.running.has(arn)) return { execution };
    const task = this.runActive(arn, execution); this.activeRuns.add(task);
    try { return await task; } finally { this.activeRuns.delete(task); }
  }
  private async runActive(arn: string, execution: LambdaDurableExecutionState): Promise<DurableRunOutcome> {
    this.cancel(`replay:${arn}`); this.running.add(arn); const updated = [...new Set(execution.updatedOperationIds)]; execution.updatedOperationIds = [];
    const input = { DurableExecutionArn: arn, CheckpointToken: execution.checkpointToken, ...(updated.length ? { UpdatedOperationIds: updated } : {}), InitialExecutionState: { Operations: execution.operations.sort((a, b) => a.sequence - b.sequence).map(item => this.operationView(item)) } };
    let invocation: DurableRuntimeResult | undefined;
    try {
      invocation = await this.hooks.invokeExecution(execution, input);
      if (invocation.interrupted) { execution.updatedOperationIds = [...new Set([...updated, ...execution.updatedOperationIds])]; await this.store.save(); return { execution, invocation }; }
      this.appendHistory(execution, "InvocationCompleted", undefined, { InvocationCompletedDetails: { StartTimestamp: epoch(Math.max(execution.startTimestamp, this.clock.now() - invocation.durationMs)), EndTimestamp: epoch(this.clock.now()), RequestId: invocation.requestId, ...(invocation.functionError ? { Error: { Payload: { ErrorType: invocation.functionError, ErrorMessage: invocation.payload.toString("utf8") }, Truncated: false } } : {}) } });
      if (execution.status !== "RUNNING") return { execution, invocation };
      if (invocation.functionError) { execution.interruptedAttempts = (execution.interruptedAttempts ?? 0) + 1; this.scheduleReplay(execution, Math.min(30_000, 1000 * 2 ** Math.min(5, execution.interruptedAttempts - 1))); }
      else {
        let output: any; try { output = JSON.parse(invocation.payload.toString("utf8")); } catch { output = undefined; }
        if (!plainObject(output) || !new Set(["SUCCEEDED", "FAILED", "PENDING"]).has(output.Status)) this.finish(execution, "FAILED", undefined, { ErrorType: "Runtime.MalformedResponse", ErrorMessage: "A durable handler must return the durable execution SDK response envelope" });
        else if (output.Status === "SUCCEEDED") this.finish(execution, "SUCCEEDED", typeof output.Result === "string" ? output.Result : "null");
        else if (output.Status === "FAILED") this.finish(execution, "FAILED", undefined, durableError(output.Error, "DurableExecutionFailed", "The durable handler failed"));
        else { execution.interruptedAttempts = 0; const pending = execution.operations.some(item => item.status === "PENDING"); if (!pending) this.scheduleReplay(execution, 0); }
      }
      await this.store.save(); return { execution, invocation };
    } catch (error) {
      if (execution.status === "RUNNING") { execution.interruptedAttempts = (execution.interruptedAttempts ?? 0) + 1; this.scheduleReplay(execution, Math.min(30_000, 1000 * 2 ** Math.min(5, execution.interruptedAttempts - 1))); await this.store.save(); }
      return { execution, invocation };
    } finally { this.running.delete(arn); if (execution.status === "RUNNING" && (execution.updatedOperationIds.length > 0 || execution.operations.some(operation => operation.status === "READY"))) this.scheduleReplay(execution, 0); }
  }

  async waitForTerminal(execution: LambdaDurableExecutionState, timeoutMs: number): Promise<boolean> {
    if (execution.status !== "RUNNING") return true;
    if (this.stopped) return false;
    return new Promise(resolve => { const listeners = this.waiters.get(execution.durableExecutionArn) ?? new Set(); let done = false; const finish = (terminal: boolean) => { if (done) return; done = true; this.clock.clearTimeout(timer); listeners.delete(finish); resolve(terminal); }; listeners.add(finish); this.waiters.set(execution.durableExecutionArn, listeners); const timer = this.clock.setTimeout(() => finish(false), timeoutMs); });
  }
  scheduleInitial(execution: LambdaDurableExecutionState): void { this.scheduleReplay(execution, 0); }
  hasRunningForFunction(functionName: string, qualifier?: string): boolean { return Object.values(this.state).some(item => item.status === "RUNNING" && item.functionName === functionName && (!qualifier || item.executedVersion === qualifier || item.requestedQualifier === qualifier)); }

  private validateUpdate(execution: LambdaDurableExecutionState, raw: any): { operation: LambdaDurableOperationState; action: string; payload?: string; error?: LambdaDurableErrorState; update: any; created: boolean } {
    if (!plainObject(raw) || typeof raw.Id !== "string" || raw.Id.length < 1 || raw.Id.length > 128 || !OPERATION_TYPES.has(raw.Type) || !OPERATION_ACTIONS.has(raw.Action)) throw new AwsError("InvalidParameterValueException", "Each durable update requires a valid Id, Type, and Action");
    if (raw.ParentId !== undefined && (typeof raw.ParentId !== "string" || !execution.operations.some(item => item.id === raw.ParentId && item.type === "CONTEXT"))) throw new AwsError("InvalidParameterValueException", "ParentId must identify an existing context operation");
    if (raw.Name !== undefined && (typeof raw.Name !== "string" || raw.Name.length < 1 || raw.Name.length > 256)) throw new AwsError("InvalidParameterValueException", "Operation Name must be between 1 and 256 characters");
    if (raw.SubType !== undefined && (typeof raw.SubType !== "string" || raw.SubType.length > 128)) throw new AwsError("InvalidParameterValueException", "Operation SubType must not exceed 128 characters");
    const optionKeys: Record<string, string> = { CONTEXT: "ContextOptions", STEP: "StepOptions", WAIT: "WaitOptions", CALLBACK: "CallbackOptions", CHAINED_INVOKE: "ChainedInvokeOptions" }; for (const key of Object.values(optionKeys)) if (raw[key] !== undefined && key !== optionKeys[raw.Type]) throw new AwsError("InvalidParameterValueException", `${key} is not valid for ${raw.Type}`);
    const payload = raw.Payload; if (payload !== undefined && typeof payload !== "string") throw new AwsError("InvalidParameterValueException", "Operation Payload must be a string"); const limit = raw.Type === "EXECUTION" ? (execution.invocationType === "Event" ? 1024 * 1024 : 6 * 1024 * 1024) : raw.Type === "CHAINED_INVOKE" ? 1024 * 1024 : 256 * 1024; if (payload !== undefined && Buffer.byteLength(payload) > limit) throw new AwsError("InvalidParameterValueException", `Operation Payload exceeds ${limit} bytes`);
    const error = raw.Error !== undefined ? durableError(raw.Error) : undefined; let operation = execution.operations.find(item => item.id === raw.Id); const created = !operation;
    if (!operation) { if (raw.Action !== "START") throw new AwsError("InvalidParameterValueException", "A new operation must use START"); operation = { id: raw.Id, ...(raw.ParentId ? { parentId: raw.ParentId } : {}), ...(raw.Name ? { name: raw.Name } : {}), type: raw.Type, ...(raw.SubType ? { subType: raw.SubType } : {}), startTimestamp: this.clock.now(), status: "STARTED", sequence: execution.nextOperationSequence++ }; execution.operations.push(operation); }
    else if (operation.type !== raw.Type || operation.parentId !== raw.ParentId || operation.name !== raw.Name || operation.subType !== raw.SubType) throw new AwsError("InvalidParameterValueException", "An operation update cannot change type, parent, name, or subtype");
    if (TERMINAL_OPERATIONS.has(operation.status)) throw new AwsError("ResourceConflictException", `Operation ${operation.id} is already terminal`, 409);
    return { operation, action: raw.Action, ...(payload !== undefined ? { payload } : {}), ...(error ? { error } : {}), update: raw, created };
  }

  private async applyUpdate(execution: LambdaDurableExecutionState, raw: any): Promise<LambdaDurableOperationState> {
    const { operation, action, payload, error, update, created } = this.validateUpdate(execution, raw); const now = this.clock.now();
    if (action === "START") {
      if (!created && !(operation.type === "STEP" && operation.status === "READY")) throw new AwsError("ResourceConflictException", `Operation ${operation.id} has already started`, 409);
      if (operation.type === "CONTEXT") { operation.contextDetails = { ...(update.ContextOptions?.ReplayChildren !== undefined ? { replayChildren: Boolean(update.ContextOptions.ReplayChildren) } : {}) }; this.appendHistory(execution, "ContextStarted", operation, { ContextStartedDetails: {} }); }
      else if (operation.type === "STEP") { const attempt = operation.stepDetails?.attempt ?? 1; operation.status = "STARTED"; delete operation.endTimestamp; operation.stepDetails = { ...operation.stepDetails, attempt }; delete operation.stepDetails.nextAttemptTimestamp; this.appendHistory(execution, "StepStarted", operation, { StepStartedDetails: {} }); }
      else if (operation.type === "WAIT") { const seconds = update.WaitOptions?.WaitSeconds; if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 0 || seconds > 31_622_400) throw new AwsError("InvalidParameterValueException", "WAIT requires WaitSeconds between 0 and 31622400"); const waitSeconds = seconds; const scheduledEndTimestamp = now + waitSeconds * 1000; operation.status = "PENDING"; operation.waitDetails = { duration: waitSeconds, scheduledEndTimestamp }; this.appendHistory(execution, "WaitStarted", operation, { WaitStartedDetails: { Duration: waitSeconds, ScheduledEndTimestamp: epoch(scheduledEndTimestamp) } }); }
      else if (operation.type === "CALLBACK") { const timeout = update.CallbackOptions?.TimeoutSeconds ?? 0; const heartbeat = update.CallbackOptions?.HeartbeatTimeoutSeconds ?? 0; if (![timeout, heartbeat].every(value => Number.isInteger(value) && value >= 0 && value <= 31_622_400)) throw new AwsError("InvalidParameterValueException", "Callback timeouts must be between 0 and 31622400 seconds"); operation.status = "PENDING"; operation.callbackDetails = { callbackId: callbackId(), ...(timeout ? { timeoutAt: now + timeout * 1000 } : {}), ...(heartbeat ? { heartbeatTimeoutSeconds: heartbeat, heartbeatDeadline: now + heartbeat * 1000 } : {}) }; this.appendHistory(execution, "CallbackStarted", operation, { CallbackStartedDetails: { CallbackId: operation.callbackDetails.callbackId, ...(heartbeat ? { HeartbeatTimeout: heartbeat } : {}), ...(timeout ? { Timeout: timeout } : {}) } }); }
      else if (operation.type === "CHAINED_INVOKE") { const target = update.ChainedInvokeOptions?.FunctionName; if (typeof target !== "string" || !target) throw new AwsError("InvalidParameterValueException", "CHAINED_INVOKE requires FunctionName"); const arn = target.match(/^arn:(?:aws|aws-us-gov|aws-cn):lambda:([^:]+):(\d{12}):function:/); if (arn && (arn[1] !== this.region || arn[2] !== this.store.accountId)) throw new AwsError("InvalidParameterValueException", "Chained invokes must use this account and Region"); operation.chainedInvokeDetails = { functionName: target, ...(update.ChainedInvokeOptions?.TenantId ? { tenantId: update.ChainedInvokeOptions.TenantId } : {}) }; this.appendHistory(execution, "ChainedInvokeStarted", operation, { ChainedInvokeStartedDetails: { FunctionName: target, ...(payload !== undefined ? { Input: { Payload: payload, Truncated: false } } : {}) } }); const result = await this.hooks.invokeChained(execution, target, Buffer.from(payload ?? "null")); operation.endTimestamp = this.clock.now(); if (result.functionError) { operation.status = "FAILED"; operation.chainedInvokeDetails.error = { ErrorType: result.functionError, ErrorMessage: result.payload.toString("utf8") }; this.appendHistory(execution, "ChainedInvokeFailed", operation, { ChainedInvokeFailedDetails: { Error: { Payload: clone(operation.chainedInvokeDetails.error), Truncated: false } } }); } else { operation.status = "SUCCEEDED"; operation.chainedInvokeDetails.result = result.payload.toString("utf8"); this.appendHistory(execution, "ChainedInvokeSucceeded", operation, { ChainedInvokeSucceededDetails: { Result: { Payload: operation.chainedInvokeDetails.result, Truncated: false } } }); } }
    } else if (action === "SUCCEED") {
      operation.status = "SUCCEEDED"; operation.endTimestamp = now;
      if (operation.type === "STEP") { (operation.stepDetails ??= { attempt: 1 }).result = payload; delete operation.stepDetails.error; this.appendHistory(execution, "StepSucceeded", operation, { StepSucceededDetails: { Result: { Payload: payload ?? "null", Truncated: false }, RetryDetails: { CurrentAttempt: operation.stepDetails.attempt ?? 1 } } }); }
      else if (operation.type === "CONTEXT") { (operation.contextDetails ??= {}).result = payload; this.appendHistory(execution, "ContextSucceeded", operation, { ContextSucceededDetails: { Result: { Payload: payload ?? "null", Truncated: false } } }); }
      else if (operation.type === "WAIT") this.appendHistory(execution, "WaitSucceeded", operation, { WaitSucceededDetails: { Duration: operation.waitDetails?.duration } });
      else if (operation.type === "EXECUTION") this.finish(execution, "SUCCEEDED", payload ?? "null");
    } else if (action === "FAIL") {
      operation.status = "FAILED"; operation.endTimestamp = now; const failure = error ?? { ErrorType: "OperationFailed", ErrorMessage: `Operation ${operation.id} failed` };
      if (operation.type === "STEP") { (operation.stepDetails ??= { attempt: 1 }).error = failure; this.appendHistory(execution, "StepFailed", operation, { StepFailedDetails: { Error: { Payload: clone(failure), Truncated: false }, RetryDetails: { CurrentAttempt: operation.stepDetails.attempt ?? 1 } } }); }
      else if (operation.type === "CONTEXT") { (operation.contextDetails ??= {}).error = failure; this.appendHistory(execution, "ContextFailed", operation, { ContextFailedDetails: { Error: { Payload: clone(failure), Truncated: false } } }); }
      else if (operation.type === "EXECUTION") this.finish(execution, "FAILED", undefined, failure);
    } else if (action === "RETRY") {
      if (operation.type !== "STEP") throw new AwsError("InvalidParameterValueException", "RETRY is valid only for STEP operations"); const delay = update.StepOptions?.NextAttemptDelaySeconds ?? 0; if (!Number.isInteger(delay) || delay < 0 || delay > 31_622_400) throw new AwsError("InvalidParameterValueException", "NextAttemptDelaySeconds must be between 0 and 31622400"); const details = operation.stepDetails ??= { attempt: 1 }; details.attempt = (details.attempt ?? 1) + 1; details.error = error; details.nextAttemptTimestamp = now + delay * 1000; operation.status = "PENDING"; this.appendHistory(execution, "StepFailed", operation, { StepFailedDetails: { Error: { Payload: clone(error ?? { ErrorType: "StepRetry", ErrorMessage: "The step was scheduled for retry" }), Truncated: false }, RetryDetails: { CurrentAttempt: details.attempt - 1, NextAttemptDelaySeconds: delay } } });
    } else {
      operation.status = "CANCELLED"; operation.endTimestamp = now; if (operation.type === "WAIT") this.appendHistory(execution, "WaitCancelled", operation, { WaitCancelledDetails: { ...(error ? { Error: { Payload: clone(error), Truncated: false } } : {}) } });
    }
    this.scheduleOperation(execution, operation); return operation;
  }

  private callback(callback: string): { execution: LambdaDurableExecutionState; operation: LambdaDurableOperationState } {
    for (const execution of Object.values(this.state)) { const operation = execution.operations.find(item => item.type === "CALLBACK" && item.callbackDetails?.callbackId === callback); if (operation) return { execution, operation }; }
    throw new AwsError("CallbackTimeoutException", "The callback is invalid, closed, or expired", 410);
  }
  private async closeCallback(callback: string, success: boolean, body: Buffer): Promise<void> {
    const { execution, operation } = this.callback(callback); if (execution.status !== "RUNNING" || operation.status !== "PENDING") throw new AwsError("CallbackTimeoutException", "The callback is already closed or expired", 410); operation.endTimestamp = this.clock.now();
    if (success) { if (body.length > 256 * 1024) throw new AwsError("RequestTooLargeException", "Callback result exceeds 256 KB", 413); operation.status = "SUCCEEDED"; operation.callbackDetails!.result = body.toString("utf8"); this.appendHistory(execution, "CallbackSucceeded", operation, { CallbackSucceededDetails: { Result: { Payload: operation.callbackDetails!.result, Truncated: false } } }); }
    else { const input = body.length ? JSON.parse(body.toString("utf8")) : {}; const error = durableError(input, "CallbackExternalError", "The durable callback failed"); operation.status = "FAILED"; operation.callbackDetails!.error = error; this.appendHistory(execution, "CallbackFailed", operation, { CallbackFailedDetails: { Error: { Payload: clone(error), Truncated: false } } }); }
    this.cancel(`operation:${execution.durableExecutionArn}:${operation.id}`); execution.updatedOperationIds.push(operation.id); await this.store.save(); this.scheduleReplay(execution, 0);
  }

  private purgeExpired(): void {
    const now = this.clock.now(); let changed = false; for (const [arn, execution] of Object.entries(this.state)) if (execution.status !== "RUNNING" && execution.endTimestamp !== undefined && execution.endTimestamp + execution.durableConfig.retentionPeriodInDays * 86_400_000 <= now) { delete this.state[arn]; changed = true; }
    if (changed) void this.store.save();
  }
  start(): void {
    this.stopped = false; this.purgeExpired(); for (const execution of Object.values(this.state)) {
      if (execution.status === "RUNNING") { this.scheduleExecutionTimeout(execution); let scheduled = false; for (const operation of execution.operations) if (this.pendingAt(operation) !== undefined) { this.scheduleOperation(execution, operation); scheduled = true; } if (!scheduled) this.scheduleReplay(execution, 0); }
      else this.scheduleDeadLetter(execution);
    }
  }
  wakeDeadLetterDeliveries(): void { for (const execution of Object.values(this.state)) if (execution.deadLetterDelivery?.status === "PENDING") { execution.deadLetterDelivery.nextAttemptAt = Math.min(execution.deadLetterDelivery.nextAttemptAt, this.clock.now()); this.scheduleDeadLetter(execution); } }
  shutdown(): void { this.stopped = true; for (const cancel of this.timers.values()) cancel(); this.timers.clear(); for (const listeners of this.waiters.values()) for (const waiter of listeners) waiter(false); this.waiters.clear(); }
  async flush(): Promise<void> { while (this.tasks.size || this.activeRuns.size) await Promise.allSettled([...this.tasks, ...this.activeRuns]); }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<boolean> {
    if (!pathname.startsWith("/2025-12-01/")) return false; this.purgeExpired();
    const callbackMatch = pathname.match(/^\/2025-12-01\/durable-execution-callbacks\/([^/]+)\/(succeed|fail|heartbeat)$/);
    if (callbackMatch && req.method === "POST") { const callback = decodeURIComponent(callbackMatch[1]); if (callbackMatch[2] === "heartbeat") { const found = this.callback(callback); if (found.execution.status !== "RUNNING" || found.operation.status !== "PENDING") throw new AwsError("CallbackTimeoutException", "The callback is already closed or expired", 410); const heartbeat = found.operation.callbackDetails?.heartbeatTimeoutSeconds; if (heartbeat) { found.operation.callbackDetails!.heartbeatDeadline = this.clock.now() + heartbeat * 1000; this.scheduleOperation(found.execution, found.operation); await this.store.save(); } json(res, {}); return true; } await this.closeCallback(callback, callbackMatch[2] === "succeed", await readBody(req)); json(res, {}); return true; }
    const functionMatch = pathname.match(/^\/2025-12-01\/functions\/([^/]+)\/durable-executions$/);
    if (functionMatch && req.method === "GET") {
      const functionName = decodeURIComponent(functionMatch[1]).split(":function:").at(-1)!.split(":")[0]; const qualifier = url.searchParams.get("Qualifier") ?? "$LATEST"; const name = url.searchParams.get("DurableExecutionName"); if (name && !/^[A-Za-z0-9-_]{1,64}$/.test(name)) throw new AwsError("InvalidParameterValueException", "Invalid DurableExecutionName filter"); const statuses = [...url.searchParams.getAll("Statuses"), ...url.searchParams.getAll("Status")].flatMap(value => value.split(",")).filter(Boolean); if (statuses.some(status => !EXECUTION_STATUSES.has(status))) throw new AwsError("InvalidParameterValueException", "Invalid durable execution status filter"); const after = queryTimestamp(url.searchParams.get("StartedAfter"), "StartedAfter"); const before = queryTimestamp(url.searchParams.get("StartedBefore"), "StartedBefore"); const reverse = booleanQuery(url, "ReverseOrder", false); const max = maxItems(url); const filters = { functionName, qualifier, name: name ?? undefined, statuses, after, before, reverse }; let values = Object.values(this.state).filter(item => item.functionName === functionName && (item.requestedQualifier === qualifier || item.executedVersion === qualifier) && (!name || item.durableExecutionName === name) && (!statuses.length || statuses.includes(item.status)) && (after === undefined || item.startTimestamp > after) && (before === undefined || item.startTimestamp < before)).sort((a, b) => (reverse ? 1 : -1) * (a.startTimestamp - b.startTimestamp || a.durableExecutionArn.localeCompare(b.durableExecutionArn))); let start = 0; const marker = url.searchParams.get("Marker"); if (marker) try { const cursor = this.tokens.decode<any>("ListDurableExecutionsByFunction", marker); if (JSON.stringify(cursor.filters) !== JSON.stringify(filters) || cursor.expiresAt < this.clock.now()) throw new Error(); start = cursor.index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid or expired Marker"); } const page = values.slice(start, start + max); const next = start + page.length; json(res, { DurableExecutions: page.map(item => this.summary(item)), ...(next < values.length ? { NextMarker: this.tokens.encode("ListDurableExecutionsByFunction", { filters, index: next, expiresAt: this.clock.now() + 86_400_000 }) } : {}) }); return true;
    }
    const executionMatch = pathname.match(/^\/2025-12-01\/durable-executions\/([^/]+)(?:\/(history|state|checkpoint|stop))?$/);
    if (!executionMatch) throw new AwsError("ResourceNotFoundException", "Unknown durable execution route", 404); const arn = decodeURIComponent(executionMatch[1]); const execution = this.require(arn); const suffix = executionMatch[2];
    if (!suffix && req.method === "GET") { json(res, this.executionView(execution, booleanQuery(url, "IncludeExecutionData", true))); return true; }
    if (suffix === "history" && req.method === "GET") { const includeData = booleanQuery(url, "IncludeExecutionData", true); const reverse = booleanQuery(url, "ReverseOrder", false); const max = maxItems(url); const filters = { arn, includeData, reverse }; const values = [...execution.history].sort((a, b) => (reverse ? -1 : 1) * (a.eventId - b.eventId)); let start = 0; const marker = url.searchParams.get("Marker"); if (marker) try { const cursor = this.tokens.decode<any>("GetDurableExecutionHistory", marker); if (JSON.stringify(cursor.filters) !== JSON.stringify(filters) || cursor.expiresAt < this.clock.now()) throw new Error(); start = cursor.index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid or expired Marker"); } const page = values.slice(start, start + max); const next = start + page.length; json(res, { Events: page.map(item => this.historyView(item, includeData)), ...(next < values.length ? { NextMarker: this.tokens.encode("GetDurableExecutionHistory", { filters, index: next, expiresAt: this.clock.now() + 86_400_000 }) } : {}) }); return true; }
    if (suffix === "state" && req.method === "GET") { const token = url.searchParams.get("CheckpointToken"); if (!token || token !== execution.checkpointToken || execution.status !== "RUNNING") throw new AwsError("InvalidParameterValueException", "The checkpoint token is invalid or expired"); const max = maxItems(url); const filters = { arn, token }; const values = [...execution.operations].sort((a, b) => a.sequence - b.sequence); let start = 0; const marker = url.searchParams.get("Marker"); if (marker) try { const cursor = this.tokens.decode<any>("GetDurableExecutionState", marker); if (JSON.stringify(cursor.filters) !== JSON.stringify(filters) || cursor.expiresAt < this.clock.now()) throw new Error(); start = cursor.index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid or expired Marker"); } const page = values.slice(start, start + max); const next = start + page.length; json(res, { Operations: page.map(item => this.operationView(item)), ...(next < values.length ? { NextMarker: this.tokens.encode("GetDurableExecutionState", { filters, index: next, expiresAt: this.clock.now() + 86_400_000 }) } : {}) }); return true; }
    if (suffix === "checkpoint" && req.method === "POST") { const body = await readBody(req); if (body.length > 1024 * 1024) throw new AwsError("RequestTooLargeException", "Checkpoint request exceeds 1 MB", 413); const input = body.length ? JSON.parse(body.toString("utf8")) : {}; const clientToken = input.ClientToken; if (clientToken !== undefined && (typeof clientToken !== "string" || clientToken.length < 1 || clientToken.length > 64 || !/^[\x20-\x7e]+$/.test(clientToken))) throw new AwsError("InvalidParameterValueException", "ClientToken must contain 1-64 printable characters"); const requestHash = sha256(body); const dedupe = clientToken ? execution.clientTokens[clientToken] : undefined; if (dedupe && dedupe.expiresAt > this.clock.now()) { if (dedupe.requestHash !== requestHash) throw new AwsError("ResourceConflictException", "ClientToken was reused with a different checkpoint request", 409); json(res, clone(dedupe.response)); return true; } if (execution.status !== "RUNNING" || input.CheckpointToken !== execution.checkpointToken) throw new AwsError("InvalidParameterValueException", "The checkpoint token is invalid or expired"); if (input.DurableExecutionArn !== undefined && input.DurableExecutionArn !== arn) throw new AwsError("InvalidParameterValueException", "DurableExecutionArn does not match the request path"); const updates = input.Updates ?? []; if (!Array.isArray(updates) || updates.length > 100) throw new AwsError("InvalidParameterValueException", "Updates must contain at most 100 operations"); const touched: LambdaDurableOperationState[] = []; for (const update of updates) touched.push(await this.applyUpdate(execution, update)); execution.checkpointToken = checkpointToken(); for (const [key, value] of Object.entries(execution.clientTokens)) if (value.expiresAt <= this.clock.now()) delete execution.clientTokens[key]; const response = { CheckpointToken: execution.checkpointToken, NewExecutionState: { Operations: [...new Map(touched.map(item => [item.id, item])).values()].map(item => this.operationView(item)) } }; if (clientToken) execution.clientTokens[clientToken] = { requestHash, expiresAt: this.clock.now() + 15 * 60_000, response: clone(response) }; await this.store.save(); json(res, response); return true; }
    if (suffix === "stop" && req.method === "POST") { if (execution.status !== "RUNNING") throw new AwsError("ResourceConflictException", "The durable execution is already terminal", 409); const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); const error = durableError(input, "DurableExecutionStopped", "The durable execution was stopped"); for (const operation of execution.operations.slice(1)) if (!TERMINAL_OPERATIONS.has(operation.status)) { operation.status = "STOPPED"; operation.endTimestamp = this.clock.now(); } this.finish(execution, "STOPPED", undefined, error); this.hooks.terminateExecution(arn); await this.store.save(); json(res, { StopTimestamp: epoch(execution.endTimestamp!) }); return true; }
    throw new AwsError("ResourceNotFoundException", "Unknown durable execution route", 404);
  }
}
