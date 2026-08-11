import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SegmentedStore } from "../persistence/segmented-store.js";
import type { Item, TableState } from "../types.js";
import { clone } from "./values.js";

export interface DynamoBackupSnapshot {
  version: 1;
  table: TableState;
}

export interface DynamoPitrChange {
  key: string;
  item?: Item;
}

interface DynamoPitrJournalEntry {
  at: number;
  sequence: number;
  kind: "checkpoint" | "changes";
  items?: Record<string, Item>;
  changes?: DynamoPitrChange[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function applyEntry(items: Record<string, Item>, entry: DynamoPitrJournalEntry): Record<string, Item> {
  if (entry.kind === "checkpoint") return clone(entry.items ?? {});
  for (const change of entry.changes ?? []) if (change.item) items[change.key] = clone(change.item); else delete items[change.key];
  return items;
}

export class DynamoBackupPersistence {
  private readonly snapshots: string;
  constructor(private readonly root: string, private readonly accountId: string, private readonly region: string) {
    this.snapshots = resolve(root, "data", "dynamodb", "backups", accountId, region, "snapshots");
  }

  private journal(tableId: string): SegmentedStore<DynamoPitrJournalEntry> {
    return new SegmentedStore(this.root, `dynamodb/pitr/${this.accountId}/${this.region}/${tableId}`);
  }

  async createSnapshot(table: TableState): Promise<{ hash: string; sizeBytes: number }> {
    const snapshot: DynamoBackupSnapshot = { version: 1, table: clone(table) };
    const encoded = canonical(snapshot); const hash = createHash("sha256").update(encoded).digest("hex");
    await mkdir(this.snapshots, { recursive: true }); const path = resolve(this.snapshots, `${hash}.json`);
    try { await readFile(path); } catch (error: any) {
      if (error.code !== "ENOENT") throw error; const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, encoded, { mode: 0o600 }); await rename(temporary, path);
    }
    return { hash, sizeBytes: Buffer.byteLength(JSON.stringify(table.items)) };
  }

  async readSnapshot(hash: string): Promise<DynamoBackupSnapshot> {
    return JSON.parse(await readFile(resolve(this.snapshots, `${hash}.json`), "utf8"));
  }

  async deleteSnapshot(hash: string): Promise<void> { await rm(resolve(this.snapshots, `${hash}.json`), { force: true }); }

  async resetPitr(table: TableState, at: number): Promise<void> {
    table.pointInTimeRecovery.sequence = 1;
    await this.journal(table.id).compact([{ at, sequence: 1, kind: "checkpoint", items: clone(table.items) }]);
  }

  async appendPitr(table: TableState, at: number, changes: DynamoPitrChange[]): Promise<void> {
    if (table.pointInTimeRecovery.status !== "ENABLED" || !changes.length) return;
    const sequence = ++table.pointInTimeRecovery.sequence;
    await this.journal(table.id).append({ at, sequence, kind: "changes", changes: clone(changes) });
  }

  async itemsAt(table: TableState, at: number): Promise<Record<string, Item>> {
    const entries = (await this.journal(table.id).readAll()).sort((left, right) => left.sequence - right.sequence); let items: Record<string, Item> = {};
    for (const entry of entries) if (entry.at <= at) items = applyEntry(items, entry);
    return items;
  }

  async prunePitr(table: TableState, now: number): Promise<void> {
    const pitr = table.pointInTimeRecovery; if (pitr.status !== "ENABLED" || pitr.enabledAt === undefined) return;
    const cutoff = Math.max(pitr.enabledAt, Math.floor((now - pitr.recoveryPeriodInDays * 24 * 60 * 60_000) / 1000) * 1000);
    if ((pitr.earliestRestorableAt ?? pitr.enabledAt) >= cutoff) return;
    const entries = (await this.journal(table.id).readAll()).sort((left, right) => left.sequence - right.sequence); let items: Record<string, Item> = {};
    for (const entry of entries) if (entry.at <= cutoff) items = applyEntry(items, entry);
    const later = entries.filter(entry => entry.at > cutoff); const sequence = later.length ? later[0].sequence - 1 : pitr.sequence;
    await this.journal(table.id).compact([{ at: cutoff, sequence, kind: "checkpoint", items }, ...later]); pitr.earliestRestorableAt = cutoff;
  }
}
