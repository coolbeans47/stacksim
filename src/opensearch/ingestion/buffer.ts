import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { EncryptedSearchStorage } from "../encrypted-storage.js";
import { AwsError } from "../../errors.js";
import type { IngestionConfig } from "./config.js";
import type { S3ScanState } from './s3-source.js';
import type { DynamoEvent, DynamoSourceState } from './dynamodb-source.js';

export interface BufferedEvent {
  id: string;
  source: Record<string, any>;
  config: IngestionConfig;
  acceptedAt: number;
  attempts: number;
  nextAttemptAt: number;
  status: "pending" | "failed";
  error?: string;
  sourceTag?: string;
  metadata?: Record<string, string | number>;
}
const TABLES = { events: ["id", "value", "bytes", "status", "due"], counters: ["name", "value"] } as const;

/** An acknowledged input and its delivery configuration share one encrypted
 * transaction. Removing a delivered item is another durable transaction, so a
 * restart retries only unfinished rows (with an at-least-once crash window). */
export class IngestionBuffer {
  private readonly db = new DatabaseSync(":memory:");
  private readonly storage: EncryptedSearchStorage;
  private failed = false;
  private closed = false;
  constructor(file: string, keyFile: string, readonly maxRecords = 10000, readonly maxBytes = 64 * 1024 * 1024) {
    this.db.exec("PRAGMA temp_store=MEMORY; CREATE TABLE events(id TEXT PRIMARY KEY, value TEXT NOT NULL, bytes INTEGER NOT NULL, status TEXT NOT NULL, due INTEGER NOT NULL); CREATE INDEX events_due ON events(status,due); CREATE TABLE counters(name TEXT PRIMARY KEY, value INTEGER NOT NULL);");
    try { this.storage = new EncryptedSearchStorage(file, keyFile, this.db, TABLES); } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(work: () => T): T {
    if (this.failed || this.closed) throw new AwsError("InternalException", "Pipeline buffer is unavailable; restart to recover encrypted storage", 503);
    this.db.exec("BEGIN IMMEDIATE"); const session = this.db.createSession(); let durable = false;
    try {
      const result = work(), changes = session.changeset();
      try { this.storage.commit(changes); durable = changes.length > 0; }
      catch (error) { this.failed = true; throw error; }
      finally { changes.fill(0); }
      this.db.exec("COMMIT"); this.storage.compactIfNeeded(); return result;
    } catch (error) { if (durable) this.failed = true; try { this.db.exec("ROLLBACK"); } catch { /* SQLite may have rolled back. */ } throw error; }
    finally { session.close(); }
  }
  private increment(name: string, value = 1): void { this.db.prepare("INSERT INTO counters(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=value+excluded.value").run(name, value); }
  private save(event: BufferedEvent): void {
    const serialized = JSON.stringify(event), bytes = Buffer.byteLength(serialized) + 1024;
    this.db.prepare("INSERT INTO events(id,value,bytes,status,due) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,status=excluded.status,due=excluded.due").run(event.id, serialized, bytes, event.status, event.nextAttemptAt);
  }
  scan(): S3ScanState | undefined { const row = this.db.prepare("SELECT value FROM events WHERE id='__s3_scan' AND status='source'").get(); return row ? JSON.parse(String(row.value)) : undefined; }
  private writeScan(scan: S3ScanState): void {
    const value = JSON.stringify(scan), bytes = Buffer.byteLength(value);
    if (bytes > 2 * 1024 * 1024) throw new AwsError('ValidationException', 'S3 checkpoint exceeds 2 MiB', 400);
    const used = Number(this.db.prepare("SELECT coalesce(sum(bytes),0) AS bytes FROM events WHERE id!='__s3_scan'").get()!.bytes);
    if (used + bytes > this.maxBytes) throw new AwsError('ThrottlingException', 'Pipeline buffer has no room for the source checkpoint', 429);
    this.db.prepare("INSERT INTO events(id,value,bytes,status,due) VALUES('__s3_scan',?,?,'source',0) ON CONFLICT(id) DO UPDATE SET value=excluded.value,bytes=excluded.bytes").run(value, bytes);
  }
  saveScan(scan: S3ScanState): void { this.transaction(() => this.writeScan(scan)); }
  stream(): DynamoSourceState | undefined { const row = this.db.prepare("SELECT value FROM events WHERE id='__dynamodb_stream' AND status='source'").get(); return row ? JSON.parse(String(row.value)) : undefined; }
  private writeStream(state: DynamoSourceState): void {
    const value = JSON.stringify(state), bytes = Buffer.byteLength(value);
    if (bytes > 65536) throw new AwsError('ValidationException', 'DynamoDB checkpoint exceeds 64 KiB', 400);
    const used = Number(this.db.prepare("SELECT coalesce(sum(bytes),0) AS bytes FROM events WHERE id!='__dynamodb_stream'").get()!.bytes);
    if (used + bytes > this.maxBytes) throw new AwsError('ThrottlingException', 'Pipeline buffer has no room for the source checkpoint', 429);
    this.db.prepare("INSERT INTO events(id,value,bytes,status,due) VALUES('__dynamodb_stream',?,?,'source',0) ON CONFLICT(id) DO UPDATE SET value=excluded.value,bytes=excluded.bytes").run(value, bytes);
  }
  saveStream(state: DynamoSourceState): void { this.transaction(() => this.writeStream(state)); }
  private advanceStream(state: DynamoSourceState): void {
    if (state.pending!.exportNextOffset !== undefined) { state.export!.offset = state.pending!.exportNextOffset; state.status = 'EXPORTING'; }
    else { state.cursor!.nextSequence = state.pending!.nextSequence; state.status = state.pending!.closed ? 'COMPLETED' : 'READING'; }
    delete state.pending; delete state.failure;
  }
  acceptStream(events: DynamoEvent[], config: IngestionConfig, now: number, state: DynamoSourceState, tag: string, closed: boolean, exportNextOffset?: number): void {
    if (events.length > 1000) throw new AwsError('ValidationException', 'DynamoDB batches exceed 1000 events', 400);
    this.transaction(() => {
      const rows: BufferedEvent[] = events.map(event => ({ id: `${tag}-${event.sequence}`, source: event.source, metadata: event.metadata, config, acceptedAt: now, attempts: 0, nextAttemptAt: now, status: 'pending', sourceTag: tag }));
      const used = this.db.prepare("SELECT coalesce(sum(CASE WHEN status!='source' THEN 1 ELSE 0 END),0) AS records,coalesce(sum(bytes),0) AS bytes FROM events").get()!;
      const bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1024, 0);
      if (bytes + 65536 > this.maxBytes) throw new AwsError('ValidationException', 'DynamoDB batch cannot fit in an empty pipeline buffer', 400);
      if (Number(used.records) + rows.length > this.maxRecords || Number(used.bytes) + bytes + 65536 > this.maxBytes) throw new AwsError('ThrottlingException', 'Pipeline persistent buffer is full', 429);
      rows.forEach(row => this.save(row)); state.accepted += rows.length;
      state.pending = { tag, remaining: rows.length, nextSequence: exportNextOffset === undefined && rows.length ? String(BigInt(events.at(-1)!.sequence) + 1n) : state.cursor!.nextSequence, closed, ...(exportNextOffset === undefined ? {} : { exportNextOffset }) };
      if (rows.length) state.status = 'DELIVERING'; else this.advanceStream(state);
      this.writeStream(state); this.increment('accepted', rows.length);
    });
  }
  private advanceScan(scan: S3ScanState): void {
    delete scan.pending; scan.cursor++; scan.status = scan.cursor >= (scan.objects?.length ?? 0) ? scan.deadLettered ? 'COMPLETED_WITH_FAILURES' : 'COMPLETED' : 'READING';
  }
  acceptScan(sources: Record<string, any>[], config: IngestionConfig, now: number, scan: S3ScanState, tag: string): void {
    if (sources.length > 1000) throw new AwsError('ValidationException', 'Too many events in source object', 400);
    this.transaction(() => {
      const rows: BufferedEvent[] = sources.map((source, index) => ({ id: `${tag}-${index}`, source, config, acceptedAt: now, attempts: 0, nextAttemptAt: now, status: 'pending', sourceTag: tag }));
      const used = this.db.prepare("SELECT coalesce(sum(CASE WHEN status!='source' THEN 1 ELSE 0 END),0) AS records,coalesce(sum(bytes),0) AS bytes FROM events").get()!;
      const bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1024, 0);
      if (bytes > this.maxBytes - Buffer.byteLength(JSON.stringify(scan)) - 1024) throw new AwsError('ValidationException', 'The source object cannot fit in an empty pipeline buffer; use smaller objects', 400);
      if (Number(used.records) + rows.length > this.maxRecords || Number(used.bytes) + bytes > this.maxBytes) throw new AwsError('ThrottlingException', 'Pipeline persistent buffer is full', 429);
      rows.forEach(row => this.save(row)); scan.accepted += rows.length;
      if (rows.length) scan.pending = { tag, remaining: rows.length }; else this.advanceScan(scan);
      this.writeScan(scan); this.increment('accepted', rows.length);
    });
  }
  accept(sources: Record<string, any>[], config: IngestionConfig, now: number): string[] {
    if (!sources.length || sources.length > 1000) throw new AwsError("ValidationException", "Ingestion batches require 1–1000 events", 400);
    const rows: BufferedEvent[] = sources.map(source => ({ id: randomUUID(), source, config, acceptedAt: now, attempts: 0, nextAttemptAt: now, status: "pending" }));
    const bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1024, 0);
    return this.transaction(() => {
      const used = this.db.prepare("SELECT coalesce(sum(CASE WHEN status!='source' THEN 1 ELSE 0 END),0) AS records, coalesce(sum(bytes),0) AS bytes FROM events").get()!;
      if (Number(used.records) + rows.length > this.maxRecords || Number(used.bytes) + bytes > this.maxBytes) throw new AwsError("ThrottlingException", "Pipeline persistent buffer is full", 429);
      rows.forEach(row => this.save(row)); this.increment("accepted", rows.length); return rows.map(row => row.id);
    });
  }
  due(now: number, maximum: number): BufferedEvent[] {
    if (this.failed || this.closed) throw new AwsError("InternalException", "Pipeline buffer is unavailable", 503);
    return this.db.prepare("SELECT value FROM events WHERE status='pending' AND due<=? ORDER BY due,id LIMIT ?").all(now, maximum).map(row => JSON.parse(String(row.value)));
  }
  delivered(id: string, deadLetter = false, now?: number): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM events WHERE id=? AND status!='source'").get(id); if (!row) return;
      const event = JSON.parse(String(row.value)) as BufferedEvent;
      this.db.prepare('DELETE FROM events WHERE id=?').run(id); this.increment(deadLetter ? 'deadLettered' : 'delivered');
      const scan = event.sourceTag ? this.scan() : undefined;
      if (scan && event.sourceTag && scan.pending?.tag === event.sourceTag) {
        if (now !== undefined) scan.updatedAt = now;
        scan.pending!.remaining--; scan[deadLetter ? 'deadLettered' : 'delivered']++;
        if (!scan.pending!.remaining) { delete scan.failure; this.advanceScan(scan); }
        this.writeScan(scan);
      }
      const stream = event.metadata ? this.stream() : undefined;
      if (stream?.pending && event.sourceTag === stream.pending.tag) {
        stream.updatedAt = now ?? stream.updatedAt; stream.pending.remaining--; stream[deadLetter ? 'deadLettered' : 'delivered']++;
        if (!stream.pending.remaining) this.advanceStream(stream);
        this.writeStream(stream);
      }
    });
  }
  retry(event: BufferedEvent, now: number, message: string, permanent = false): void {
    this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM events WHERE id=?").get(event.id)) return;
      const attempts = event.attempts + 1;
      this.save({ ...event, attempts, nextAttemptAt: now + Math.min(60000, 1000 * 2 ** Math.min(attempts - 1, 6)), status: permanent ? "failed" : "pending", error: message.slice(0, 512) });
      this.increment("deliveryFailures");
      if (event.sourceTag) { const scan = this.scan(); if (scan?.pending?.tag === event.sourceTag) { scan.updatedAt = now; scan.status = permanent ? 'BLOCKED' : 'DELIVERING'; scan.failure = permanent ? 'A source event failed permanently; inspect pipeline failures or configure an S3 DLQ' : 'Source events are waiting for sink or failure-destination recovery'; this.writeScan(scan); } }
      if (event.metadata) { const stream = this.stream(); if (stream?.pending?.tag === event.sourceTag) { stream!.updatedAt = now; stream!.status = permanent ? 'BLOCKED' : 'DELIVERING'; stream!.failure = permanent ? 'A stream event failed permanently; inspect pipeline failures or configure an S3 DLQ' : 'Stream events are waiting for sink or failure-destination recovery'; this.writeStream(stream!); } }
    });
  }
  failures(maximum = 100): BufferedEvent[] { return this.db.prepare("SELECT value FROM events WHERE status='failed' ORDER BY due,id LIMIT ?").all(maximum).map(row => JSON.parse(String(row.value))); }
  stats(): Record<string, number> {
    const row = this.db.prepare("SELECT coalesce(sum(CASE WHEN status!='source' THEN 1 ELSE 0 END),0) AS buffered, coalesce(sum(bytes),0) AS bytes, coalesce(sum(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed FROM events").get()!;
    return { ...Object.fromEntries(this.db.prepare("SELECT name,value FROM counters").all().map(row => [String(row.name), Number(row.value)])), buffered: Number(row.buffered), bytes: Number(row.bytes), failed: Number(row.failed) };
  }
  close(): void { if (this.closed) return; this.closed = true; this.storage.close(); this.db.close(); }
}
