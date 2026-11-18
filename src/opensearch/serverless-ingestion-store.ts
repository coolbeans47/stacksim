import { DatabaseSync } from 'node:sqlite';
import { EncryptedSearchStorage } from './encrypted-storage.js';
import { AwsError } from '../errors.js';
import type { ScanObject } from './ingestion/s3-source.js';

export interface StreamObject extends ScanObject { bucket: string; notification?: boolean; failure?: string }
export interface StreamMessage { id: string; receipt: string }
export interface JobProgress { objects?: ScanObject[]; cursor: number; currentFailed: boolean; objectsIngested: number; objectsFailed: number; stream?: { initialized: boolean; discovered: number; completed: string[]; message?: StreamMessage } }
const TABLES = { metadata: ['key', 'value'], records: ['position', 'value'] } as const;
/** Resource-owned encrypted work state; object admission and cursor publication
 * are independent durable boundaries from the collection's document commit. */
export class ServerlessIngestionStore {
  private readonly db = new DatabaseSync(':memory:');
  private readonly storage: EncryptedSearchStorage;
  private failed = false;
  constructor(file: string, key: string) {
    this.db.exec('PRAGMA temp_store=MEMORY; CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE records(position INTEGER PRIMARY KEY,value TEXT NOT NULL);');
    try { this.storage = new EncryptedSearchStorage(file, key, this.db, TABLES); } catch (error) { this.db.close(); throw error; }
  }
  private transaction(work: () => void): void {
    if (this.failed) throw new AwsError('InternalException', 'Ingestion work storage requires recovery', 503);
    this.db.exec('BEGIN IMMEDIATE'); const session = this.db.createSession(); let durable = false;
    try {
      work(); const changes = session.changeset();
      try { this.storage.commit(changes); durable = changes.length > 0; } catch (error) { this.failed = true; throw error; } finally { changes.fill(0); }
      this.db.exec('COMMIT'); this.storage.compactIfNeeded();
    } catch (error) { if (durable) this.failed = true; try { this.db.exec('ROLLBACK'); } catch {} throw error; }
    finally { session.close(); }
  }
  progress(): JobProgress { const row = this.db.prepare("SELECT value FROM metadata WHERE key='progress'").get(); return row ? JSON.parse(String(row.value)) : { cursor: 0, currentFailed: false, objectsIngested: 0, objectsFailed: 0 }; }
  private save(progress: JobProgress): void { const value = JSON.stringify(progress); if (Buffer.byteLength(value) > 2 * 1024 * 1024) throw new AwsError('ValidationException', 'Ingestion listing exceeds 2 MiB', 400); this.db.prepare("INSERT INTO metadata(key,value) VALUES('progress',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value); }
  listing(objects: ScanObject[]): void { this.transaction(() => { const progress = this.progress(); if (progress.objects) throw new Error('Listing already captured'); progress.objects = objects; this.save(progress); }); }
  streamBatch(objects: StreamObject[], message?: StreamMessage): void {
    this.transaction(() => {
      const progress = this.progress();
      if (this.admitted() || progress.cursor < (progress.objects?.length ?? 0) || progress.stream?.message) throw new Error('Stream batch has unfinished work');
      if (objects.length > 1000) throw new AwsError('ValidationException', 'Stream batch exceeds 1000 objects', 400);
      progress.objects = objects; progress.cursor = 0;
      progress.stream ??= { initialized: true, discovered: 0, completed: [] };
      progress.stream.discovered += objects.length; progress.stream.message = message;
      this.save(progress);
    });
  }
  completeStreamMessage(): void {
    this.transaction(() => {
      const progress = this.progress(), stream = progress.stream;
      if (!stream?.message || this.admitted() || progress.cursor < (progress.objects?.length ?? 0)) throw new Error('Stream message has unfinished work');
      stream.completed = [...stream.completed.filter(id => id !== stream.message!.id), stream.message.id].slice(-1000);
      this.save(progress);
    });
  }
  clearStreamMessage(): void { this.transaction(() => { const progress = this.progress(); if (progress.stream?.message && !progress.stream.completed.includes(progress.stream.message.id)) throw new Error('Stream message is not complete'); delete progress.stream?.message; this.save(progress); }); }
  admitted(): boolean { return Boolean(this.db.prepare("SELECT value FROM metadata WHERE key='admitted'").get()); }
  admit(documents: Record<string, any>[], failure?: string): void {
    this.transaction(() => {
      if (this.admitted()) throw new Error('Object already admitted');
      const rows = failure ? [{ failure }] : documents.map(document => ({ document }));
      if (rows.length > 1000 || Buffer.byteLength(JSON.stringify(rows)) > 12 * 1024 * 1024) throw new AwsError('ValidationException', 'Object admission exceeds local limits', 400);
      const insert = this.db.prepare('INSERT INTO records(position,value) VALUES(?,?)'); rows.forEach((row, position) => insert.run(position, JSON.stringify(row)));
      this.db.prepare("INSERT INTO metadata(key,value) VALUES('admitted','true')").run();
    });
  }
  next(): { position: number; document?: Record<string, any>; failure?: string } | undefined { const row = this.db.prepare('SELECT position,value FROM records ORDER BY position LIMIT 1').get(); return row ? { position: Number(row.position), ...JSON.parse(String(row.value)) } : undefined; }
  acknowledge(position: number, failed: boolean): void { this.transaction(() => { if (!this.db.prepare('SELECT 1 FROM records WHERE position=?').get(position)) return; this.db.prepare('DELETE FROM records WHERE position=?').run(position); if (failed) { const progress = this.progress(); progress.currentFailed = true; this.save(progress); } }); }
  finishObject(): void {
    this.transaction(() => { if (!this.admitted() || this.next()) throw new Error('Object has unfinished records'); const progress = this.progress(); progress[progress.currentFailed ? 'objectsFailed' : 'objectsIngested']++; progress.currentFailed = false; progress.cursor++; this.save(progress); this.db.prepare("DELETE FROM metadata WHERE key='admitted'").run(); });
  }
  close(): void { this.storage.close(); this.db.close(); }
}
