import { AwsError } from "./errors.js";
import type { Clock } from "./core/clock.js";
import type { TelemetryBus } from "./core/telemetry.js";
import type { LambdaState } from "./types.js";
import type { StateStore } from "./state.js";

export type LambdaThrottleReason = "ConcurrentInvocationLimitExceeded" | "ReservedFunctionConcurrentInvocationLimitExceeded";

export interface LambdaConcurrencyTarget {
  functionName: string;
  requestedQualifier?: string;
}

export interface LambdaConcurrencyLease {
  initializationType: "on-demand" | "provisioned-concurrency";
  provisioned: boolean;
  spillover: boolean;
  release(): Promise<void>;
}

interface Admission {
  functionName: string;
  qualifier?: string;
  resource?: string;
  provisioned: boolean;
  unreserved: boolean;
  spillover: boolean;
  provisionedLimit: number;
}

export class LambdaConcurrencyController {
  private readonly functionActive = new Map<string, number>();
  private readonly targetActive = new Map<string, number>();
  private readonly provisionedActive = new Map<string, number>();
  private activeUnreserved = 0;
  private admissionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: StateStore,
    private readonly region: string,
    private readonly clock: Clock,
    readonly concurrentExecutions: number,
    readonly unreservedSafetyReserve: number,
    private readonly telemetry?: TelemetryBus,
  ) {}

  private get functions(): Record<string, LambdaState> { return this.store.regionState(this.region).functions; }
  private active(map: Map<string, number>, key: string): number { return map.get(key) ?? 0; }
  private change(map: Map<string, number>, key: string, delta: number): number { const next = Math.max(0, this.active(map, key) + delta); if (next) map.set(key, next); else map.delete(key); return next; }
  private targetKey(functionName: string, qualifier?: string): string { return `${functionName}:${qualifier ?? ""}`; }

  reservedTotal(overrideFunction?: string, override?: number): number {
    return Object.values(this.functions).reduce((sum, fn) => sum + (fn.functionName === overrideFunction ? override ?? 0 : fn.reservedConcurrentExecutions ?? 0), 0);
  }

  provisionedTotal(fn: LambdaState, overrideQualifier?: string, override?: number): number {
    return Object.values(fn.provisionedConcurrencyConfigs ?? {}).reduce((sum, config) => sum + (config.qualifier === overrideQualifier ? override ?? 0 : config.requestedProvisionedConcurrentExecutions), overrideQualifier && !fn.provisionedConcurrencyConfigs?.[overrideQualifier] ? override ?? 0 : 0);
  }

  provisionedWithoutReserved(overrideFunction?: string, overrideReserved?: number, overrideQualifier?: string, overrideProvisioned?: number): number {
    return Object.values(this.functions).reduce((sum, fn) => {
      const reserved = fn.functionName === overrideFunction ? overrideReserved : fn.reservedConcurrentExecutions;
      if (reserved !== undefined) return sum;
      return sum + this.provisionedTotal(fn, fn.functionName === overrideFunction ? overrideQualifier : undefined, fn.functionName === overrideFunction ? overrideProvisioned : undefined);
    }, 0);
  }

  claimedConfigured(): number { return this.reservedTotal() + this.provisionedWithoutReserved(); }
  unreservedConfigured(): number { return Math.max(0, this.concurrentExecutions - this.claimedConfigured()); }
  maxConfigurable(): number { return Math.max(0, this.concurrentExecutions - this.unreservedSafetyReserve); }

  validateReserved(fn: LambdaState, value: number | undefined): void {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new AwsError("InvalidParameterValueException", "ReservedConcurrentExecutions must be a non-negative integer");
    const provisioned = this.provisionedTotal(fn);
    if (value !== undefined && provisioned > value) throw new AwsError("InvalidParameterValueException", "Reserved concurrency must be greater than or equal to the function's provisioned concurrency");
    const claimed = this.reservedTotal(fn.functionName, value) + this.provisionedWithoutReserved(fn.functionName, value);
    if (claimed > this.maxConfigurable()) throw new AwsError("InvalidParameterValueException", `Specified reserved concurrency would leave fewer than ${this.unreservedSafetyReserve} unreserved concurrent executions`);
  }

  validateProvisioned(fn: LambdaState, qualifier: string, value: number): void {
    if (!Number.isInteger(value) || value < 1) throw new AwsError("InvalidParameterValueException", "ProvisionedConcurrentExecutions must be an integer of at least 1");
    const functionTotal = this.provisionedTotal(fn, qualifier, value);
    if (fn.reservedConcurrentExecutions !== undefined && functionTotal > fn.reservedConcurrentExecutions) throw new AwsError("InvalidParameterValueException", "Provisioned concurrency cannot exceed the function's reserved concurrency");
    if (fn.reservedConcurrentExecutions === undefined) {
      const claimed = this.reservedTotal() + this.provisionedWithoutReserved(fn.functionName, undefined, qualifier, value);
      if (claimed > this.maxConfigurable()) throw new AwsError("InvalidParameterValueException", `Specified provisioned concurrency would leave fewer than ${this.unreservedSafetyReserve} unreserved concurrent executions`);
    }
  }

  async acquire(target: LambdaConcurrencyTarget): Promise<LambdaConcurrencyLease> {
    const previous = this.admissionTail; let open!: () => void; this.admissionTail = new Promise(resolve => { open = resolve; }); await previous;
    let admission: Admission | undefined; let throttle: LambdaThrottleReason | undefined;
    try {
      const fn = this.functions[target.functionName]; if (!fn) throw new AwsError("ResourceNotFoundException", `Function not found: ${target.functionName}`, 404);
      const qualifier = target.requestedQualifier && target.requestedQualifier !== "$LATEST" ? target.requestedQualifier : undefined;
      const resource = qualifier ? `${target.functionName}:${qualifier}` : undefined; const key = this.targetKey(target.functionName, qualifier);
      const config = qualifier ? fn.provisionedConcurrencyConfigs?.[qualifier] : undefined; const provisionedLimit = config?.status === "READY" ? config.allocatedProvisionedConcurrentExecutions : 0;
      const functionActive = this.active(this.functionActive, target.functionName); const totalActive = [...this.functionActive.values()].reduce((sum, value) => sum + value, 0); const reserved = fn.reservedConcurrentExecutions;
      if (reserved !== undefined && functionActive >= reserved) throttle = "ReservedFunctionConcurrentInvocationLimitExceeded";
      else if (totalActive >= this.concurrentExecutions) throttle = "ConcurrentInvocationLimitExceeded";
      else if (provisionedLimit > this.active(this.provisionedActive, key)) admission = { functionName: target.functionName, qualifier, resource, provisioned: true, unreserved: false, spillover: false, provisionedLimit };
      else if (reserved !== undefined) admission = { functionName: target.functionName, qualifier, resource, provisioned: false, unreserved: false, spillover: Boolean(config?.status === "READY"), provisionedLimit };
      else if (this.activeUnreserved < this.unreservedConfigured()) admission = { functionName: target.functionName, qualifier, resource, provisioned: false, unreserved: true, spillover: Boolean(config?.status === "READY"), provisionedLimit };
      else throttle = "ConcurrentInvocationLimitExceeded";
      if (admission) {
        this.change(this.functionActive, admission.functionName, 1); this.change(this.targetActive, key, 1);
        if (admission.provisioned) this.change(this.provisionedActive, key, 1); if (admission.unreserved) this.activeUnreserved++;
      }
    } finally { open(); }
    if (!admission) {
      await this.publishThrottle(target.functionName, target.requestedQualifier, throttle!);
      throw new AwsError("TooManyRequestsException", "Rate Exceeded.", 429, { Type: "User", Reason: throttle, retryAfterSeconds: "1" });
    }
    await this.publishAdmission(admission, true);
    let released = false;
    return {
      initializationType: admission.provisioned ? "provisioned-concurrency" : "on-demand",
      provisioned: admission.provisioned,
      spillover: admission.spillover,
      release: async () => {
        if (released) return; released = true; const key = this.targetKey(admission!.functionName, admission!.qualifier);
        this.change(this.functionActive, admission!.functionName, -1); this.change(this.targetActive, key, -1); if (admission!.provisioned) this.change(this.provisionedActive, key, -1); if (admission!.unreserved) this.activeUnreserved = Math.max(0, this.activeUnreserved - 1);
        await this.publishAdmission(admission!, false);
      },
    };
  }

  private async publish(metricName: string, dimensions: Record<string, string>, value: number, unit = "Count"): Promise<void> {
    await this.telemetry?.publish({ namespace: "AWS/Lambda", metricName, dimensions, value, unit, timestamp: this.clock.now() }).catch(() => undefined);
  }

  private async publishThrottle(functionName: string, qualifier: string | undefined, _reason: LambdaThrottleReason): Promise<void> {
    const base = { FunctionName: functionName }; await this.publish("Throttles", base, 1); if (qualifier && qualifier !== "$LATEST") await this.publish("Throttles", { ...base, Resource: `${functionName}:${qualifier}` }, 1);
  }

  private async publishAdmission(admission: Admission, acquiring: boolean): Promise<void> {
    const key = this.targetKey(admission.functionName, admission.qualifier); const base = { FunctionName: admission.functionName }; const functionCount = this.active(this.functionActive, admission.functionName); const targetCount = this.active(this.targetActive, key); const qualified = admission.resource ? { ...base, Resource: admission.resource } : undefined;
    const events: Array<Promise<void>> = [this.publish("ConcurrentExecutions", base, functionCount)]; if (qualified) events.push(this.publish("ConcurrentExecutions", qualified, targetCount));
    if (admission.provisioned && qualified) { const active = this.active(this.provisionedActive, key); const utilization = admission.provisionedLimit ? active / admission.provisionedLimit : 0; events.push(this.publish("ProvisionedConcurrentExecutions", base, active), this.publish("ProvisionedConcurrentExecutions", qualified, active), this.publish("ProvisionedConcurrencyUtilization", base, utilization, "None"), this.publish("ProvisionedConcurrencyUtilization", qualified, utilization, "None")); if (acquiring) events.push(this.publish("ProvisionedConcurrencyInvocations", base, 1), this.publish("ProvisionedConcurrencyInvocations", qualified, 1)); }
    if (acquiring && admission.spillover && qualified) events.push(this.publish("ProvisionedConcurrencySpilloverInvocations", base, 1), this.publish("ProvisionedConcurrencySpilloverInvocations", qualified, 1));
    if (admission.unreserved) events.push(this.publish("UnreservedConcurrentExecutions", {}, this.activeUnreserved), this.publish("ClaimedAccountConcurrency", {}, this.claimedConfigured() + this.activeUnreserved));
    await Promise.all(events);
  }

  reset(): void { this.functionActive.clear(); this.targetActive.clear(); this.provisionedActive.clear(); this.activeUnreserved = 0; this.admissionTail = Promise.resolve(); }
}
