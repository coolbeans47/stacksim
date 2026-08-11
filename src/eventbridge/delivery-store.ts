import { mkdir, open, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import type { EventBridgeHttpParametersState, EventBridgeTargetType, ServiceIntegrationAttemptState } from "../types.js";

export interface EventBridgeDelivery {
  id: string;
  eventId: string;
  eventBusName: string;
  eventSourceName: string;
  ruleName: string;
  ruleArn: string;
  targetId: string;
  targetArn: string;
  targetType?: EventBridgeTargetType;
  roleArn?: string;
  deadLetterArn?: string;
  sqsMessageGroupId?: string;
  httpParameters?: EventBridgeHttpParametersState;
  transformed?: boolean;
  eventTime?: number;
  /** Original EventBridge envelope bytes are retained only for target-DLQ delivery. */
  originalEvent?: string;
  deliveryLineage?: string[];
  /** Final JSON bytes for the target. Storing the serialized form preserves number lexemes across retries. */
  payload: string;
  /** A deterministic ingestion-time transform/parameter failure is delivered through the normal terminal/DLQ path. */
  preflightErrorCode?: string;
  preflightErrorMessage?: string;
  traceHeader?: string;
  enqueuedAt: number;
  nextAttemptAt: number;
  attempts: number;
  maximumEventAgeSeconds: number;
  maximumRetryAttempts: number;
  status: "QUEUED" | "LEASED";
  leaseId?: string;
  leaseUntil?: number;
  lastError?: string;
}

export interface EventBridgeDeliveryDiagnostic {
  deliveryId: string;
  eventId: string;
  eventBusName: string;
  ruleName: string;
  targetId: string;
  targetArn: string;
  status: "SUCCEEDED" | "RETRYING" | "FAILED";
  attempts: number;
  updatedAt: number;
  nextAttemptAt?: number;
  errorCode?: string;
  errorMessage?: string;
  deadLetterArn?: string;
  deadLetterStatus?: "SENT" | "FAILED";
}

type JournalRecord =
  | { op: "put"; delivery: EventBridgeDelivery }
  | { op: "delete"; id: string }
  | { op: "diagnostic"; diagnostic: EventBridgeDeliveryDiagnostic }
  | { op: "integration-attempt"; attempt: ServiceIntegrationAttemptState }
  | { op: "accept-integration-entry"; deliveries: EventBridgeDelivery[]; diagnostics: EventBridgeDeliveryDiagnostic[]; attempt: ServiceIntegrationAttemptState }
  | { op: "delete-integration-attempt"; id: string };

const MAX_DIAGNOSTICS = 100;
const COMPACT_AFTER_RECORDS = 1_000;

function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Append-only, fsync-backed EventBridge delivery state. A truncated final
 * journal record is ignored during recovery; every preceding record remains
 * authoritative. Payloads live here rather than in state.json.
 */
export class EventBridgeDeliveryStore {
  readonly directory: string;
  readonly journal: string;
  private readonly deliveries = new Map<string, EventBridgeDelivery>();
  private diagnosticsState: EventBridgeDeliveryDiagnostic[] = [];
  private readonly integrationAttempts = new Map<string, ServiceIntegrationAttemptState>();
  private serial = Promise.resolve();
  private records = 0;
  private started = false;

  constructor(root: string, accountId: string, region: string) {
    this.directory = resolve(root, "data", "eventbridge", accountId, region);
    this.journal = resolve(this.directory, "deliveries.jsonl");
  }

  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let journalExisted = true;
    try {
      const contents = await readFile(this.journal);
      let completeLength = contents.length;
      if (contents.length && contents[contents.length - 1] !== 0x0a) {
        completeLength = contents.lastIndexOf(0x0a) + 1;
        const handle = await open(this.journal, "r+");
        try { await handle.truncate(completeLength); await handle.sync(); }
        finally { await handle.close(); }
      }
      for (const line of contents.subarray(0, completeLength).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try { this.apply(JSON.parse(line) as JournalRecord); this.records++; }
        catch (error) { throw new Error(`EventBridge delivery journal contains a malformed committed record: ${error instanceof Error ? error.message : String(error)}`); }
      }
    } catch (error) {
      if (!missing(error)) throw error;
      journalExisted = false;
    }
    const handle = await open(this.journal, "a", 0o600);
    try { await handle.sync(); } finally { await handle.close(); }
    if (!journalExisted) await this.syncDirectory();
    this.started = true;
  }

  async stop(): Promise<void> { await this.serial.catch(() => undefined); }

  list(): EventBridgeDelivery[] {
    return [...this.deliveries.values()].map(item => structuredClone(item));
  }

  diagnostics(): EventBridgeDeliveryDiagnostic[] {
    return this.diagnosticsState.map(item => structuredClone(item));
  }

  integrationAttempt(id: string): ServiceIntegrationAttemptState | undefined { const value = this.integrationAttempts.get(id); return value ? structuredClone(value) : undefined; }
  async recordIntegrationAttempt(attempt: ServiceIntegrationAttemptState): Promise<void> { await this.append([{ op: "integration-attempt", attempt: structuredClone(attempt) }]); }
  async deleteIntegrationAttemptTree(id: string): Promise<void> { const ids = [...this.integrationAttempts.keys()].filter(candidate => candidate === id || candidate.startsWith(`${id}:entry:`)); if (ids.length) await this.append(ids.map(candidate => ({ op: "delete-integration-attempt", id: candidate }))); }

  async put(delivery: EventBridgeDelivery): Promise<void> {
    await this.append([{ op: "put", delivery: structuredClone(delivery) }]);
  }

  async putMany(deliveries: EventBridgeDelivery[], diagnostics: EventBridgeDeliveryDiagnostic[] = [], integrationAttempt?: ServiceIntegrationAttemptState): Promise<void> {
    if (!deliveries.length && !diagnostics.length && !integrationAttempt) return;
    if (integrationAttempt) { await this.append([{ op: "accept-integration-entry", deliveries: structuredClone(deliveries), diagnostics: structuredClone(diagnostics), attempt: structuredClone(integrationAttempt) }]); return; }
    await this.append([
      ...deliveries.map(delivery => ({ op: "put", delivery: structuredClone(delivery) } as const)),
      ...diagnostics.map(diagnostic => ({ op: "diagnostic", diagnostic: structuredClone(diagnostic) } as const)),
    ]);
  }

  async delete(id: string): Promise<void> { await this.append([{ op: "delete", id }]); }

  async record(diagnostic: EventBridgeDeliveryDiagnostic): Promise<void> {
    await this.append([{ op: "diagnostic", diagnostic: structuredClone(diagnostic) }]);
  }

  private async append(records: JournalRecord[]): Promise<void> {
    const operation = this.serial.catch(() => undefined).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const handle = await open(this.journal, "a", 0o600);
      try {
        await handle.writeFile(records.map(record => `${JSON.stringify(record)}\n`).join(""), "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      for (const record of records) this.apply(record);
      this.records += records.length;
      if (this.records >= COMPACT_AFTER_RECORDS) await this.compact();
    });
    this.serial = operation.then(() => undefined, () => undefined);
    await operation;
  }

  private apply(record: JournalRecord): void {
    if (record.op === "put") this.deliveries.set(record.delivery.id, record.delivery);
    else if (record.op === "delete") this.deliveries.delete(record.id);
    else if (record.op === "diagnostic") {
      const index = this.diagnosticsState.findIndex(item => item.deliveryId === record.diagnostic.deliveryId);
      if (index >= 0) this.diagnosticsState.splice(index, 1);
      this.diagnosticsState.push(record.diagnostic);
      if (this.diagnosticsState.length > MAX_DIAGNOSTICS) this.diagnosticsState.splice(0, this.diagnosticsState.length - MAX_DIAGNOSTICS);
    } else if (record.op === "integration-attempt") this.integrationAttempts.set(record.attempt.attemptId, record.attempt);
    else if (record.op === "accept-integration-entry") { for (const delivery of record.deliveries) this.deliveries.set(delivery.id, delivery); for (const diagnostic of record.diagnostics) { const index = this.diagnosticsState.findIndex(item => item.deliveryId === diagnostic.deliveryId); if (index >= 0) this.diagnosticsState.splice(index, 1); this.diagnosticsState.push(diagnostic); } if (this.diagnosticsState.length > MAX_DIAGNOSTICS) this.diagnosticsState.splice(0, this.diagnosticsState.length - MAX_DIAGNOSTICS); this.integrationAttempts.set(record.attempt.attemptId, record.attempt); }
    else this.integrationAttempts.delete(record.id);
  }

  private async compact(): Promise<void> {
    const records: JournalRecord[] = [
      ...[...this.deliveries.values()].map(delivery => ({ op: "put", delivery } as const)),
      ...this.diagnosticsState.map(diagnostic => ({ op: "diagnostic", diagnostic } as const)),
      ...[...this.integrationAttempts.values()].map(attempt => ({ op: "integration-attempt", attempt } as const)),
    ];
    const temporary = `${this.journal}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(records.map(record => `${JSON.stringify(record)}\n`).join(""), "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, this.journal);
    await this.syncDirectory();
    this.records = records.length;
  }

  private async syncDirectory(): Promise<void> {
    try {
      const handle = await open(this.directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
      if (process.platform === "win32" && new Set(["EACCES", "EISDIR", "EINVAL", "EPERM"]).has(code ?? "")) return;
      throw error;
    }
  }
}
