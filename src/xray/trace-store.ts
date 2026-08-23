import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AwsError } from "../errors.js";
import type { CanonicalSegment, StoredTrace, StoredTraceSummary, XRayPage, XRayRepositoryHealth, XRayStoreOptions } from "./model.js";

const SCHEMA_VERSION = 1;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_TRACES = 100_000;
const DEFAULT_MAX_SEGMENTS = 500_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_CLEANUP_BATCH = 1_000;

function safeNamespace(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error(`Invalid X-Ray ${label} namespace`);
  return value;
}

function number(value: unknown): number { return typeof value === "bigint" ? Number(value) : Number(value ?? 0); }

export class XRayTraceStore {
  private database?: DatabaseSync;
  private key?: Buffer;
  private readonly file: string;
  private readonly keyFile: string;
  private readonly retentionMs: number;
  private readonly maximumTraces: number;
  private readonly maximumSegments: number;
  private readonly maximumDocumentBytes: number;
  private readonly cleanupBatchSize: number;
  private healthState: XRayRepositoryHealth = { status: "ready", traceCount: 0, segmentCount: 0, rejectedCount: 0, errors: [] };

  constructor(
    root: string,
    readonly accountId: string,
    readonly region: string,
    private readonly now: () => number,
    options: XRayStoreOptions = {},
  ) {
    const account = safeNamespace(accountId, "account"); const regional = safeNamespace(region, "Region");
    this.file = resolve(root, "data", "xray", account, regional, "traces.sqlite3");
    this.keyFile = resolve(root, "secrets", "xray.key");
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maximumTraces = options.maximumTraces ?? DEFAULT_MAX_TRACES;
    this.maximumSegments = options.maximumSegments ?? DEFAULT_MAX_SEGMENTS;
    this.maximumDocumentBytes = options.maximumDocumentBytes ?? DEFAULT_MAX_BYTES;
    this.cleanupBatchSize = options.cleanupBatchSize ?? DEFAULT_CLEANUP_BATCH;
  }

  async start(): Promise<void> {
    await mkdir(resolve(this.file, ".."), { recursive: true, mode: 0o700 });
    await mkdir(resolve(this.keyFile, ".."), { recursive: true, mode: 0o700 });
    const existingDatabase = await stat(this.file).then(value => value.size > 0).catch((error: any) => error?.code === "ENOENT" ? false : Promise.reject(error));
    try {
      const encoded = await readFile(this.keyFile, "utf8");
      const key = Buffer.from(encoded.trim(), "base64");
      if (key.length !== 32) throw new Error("X-Ray repository key has an invalid length");
      this.key = key;
    } catch (error: any) {
      if (error?.code !== "ENOENT") { this.healthState.status = "key-unavailable"; throw error; }
      if (existingDatabase) { this.healthState.status = "key-unavailable"; throw new Error("X-Ray encryption key is missing while trace data exists; restore the database and key from the same stopped backup"); }
      this.key = randomBytes(32);
      await writeFile(this.keyFile, this.key.toString("base64"), { mode: 0o600, flag: "wx" });
    }
    try {
      const database = new DatabaseSync(this.file);
      database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      this.database = database;
      this.migrate();
      await this.restrictPermissions();
      this.cleanup();
      this.refreshHealth();
    } catch (error) {
      this.healthState.status = "corrupt";
      this.recordError(error);
      this.database?.close(); this.database = undefined;
      throw error;
    }
  }

  private async restrictPermissions(): Promise<void> {
    if (process.platform === "win32") return;
    await Promise.all([this.file, `${this.file}-wal`, `${this.file}-shm`, this.keyFile].map(file => chmod(file, 0o600).catch((error: any) => { if (error?.code !== "ENOENT") this.recordError(error); })));
  }

  private db(): DatabaseSync {
    if (!this.database) throw new AwsError("InternalServerError", "X-Ray repository is unavailable", 500);
    return this.database;
  }

  private migrate(): void {
    const database = this.db();
    database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS traces (
        account_id TEXT NOT NULL, region TEXT NOT NULL, trace_id TEXT NOT NULL,
        start_time REAL NOT NULL, end_time REAL NOT NULL, duration REAL NOT NULL,
        root_service TEXT NOT NULL, response_status INTEGER,
        has_error INTEGER NOT NULL, has_fault INTEGER NOT NULL, has_throttle INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, region, trace_id)
      );
      CREATE TABLE IF NOT EXISTS segments (
        account_id TEXT NOT NULL, region TEXT NOT NULL, trace_id TEXT NOT NULL, segment_id TEXT NOT NULL,
        parent_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL, start_time REAL NOT NULL, end_time REAL,
        in_progress INTEGER NOT NULL, origin TEXT, resource_arn TEXT, response_status INTEGER,
        has_error INTEGER NOT NULL, has_fault INTEGER NOT NULL, has_throttle INTEGER NOT NULL,
        document_bytes INTEGER NOT NULL, nonce BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL,
        canonical_hash TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, region, trace_id, segment_id),
        FOREIGN KEY (account_id, region, trace_id) REFERENCES traces(account_id, region, trace_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS annotations (
        account_id TEXT NOT NULL, region TEXT NOT NULL, trace_id TEXT NOT NULL, segment_id TEXT NOT NULL,
        annotation_key TEXT NOT NULL, string_value TEXT, number_value REAL, boolean_value INTEGER,
        PRIMARY KEY (account_id, region, trace_id, segment_id, annotation_key),
        FOREIGN KEY (account_id, region, trace_id, segment_id) REFERENCES segments(account_id, region, trace_id, segment_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS edges (
        account_id TEXT NOT NULL, region TEXT NOT NULL, trace_id TEXT NOT NULL,
        source_id TEXT NOT NULL, destination_id TEXT NOT NULL,
        PRIMARY KEY (account_id, region, trace_id, source_id, destination_id),
        FOREIGN KEY (account_id, region, trace_id) REFERENCES traces(account_id, region, trace_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS ingestion_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, region TEXT NOT NULL,
        occurred_at INTEGER NOT NULL, error_code TEXT NOT NULL, message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS traces_time ON traces(account_id, region, start_time DESC, trace_id);
      CREATE INDEX IF NOT EXISTS traces_status ON traces(account_id, region, has_fault, has_error, has_throttle, response_status);
      CREATE INDEX IF NOT EXISTS segments_service ON segments(account_id, region, name, start_time);
      CREATE INDEX IF NOT EXISTS annotations_lookup ON annotations(account_id, region, annotation_key, string_value, number_value, boolean_value);
    `);
    const current = database.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as any;
    if (current && Number(current.value) > SCHEMA_VERSION) { this.healthState.status = "migration-required"; throw new Error(`X-Ray repository schema ${current.value} is newer than supported schema ${SCHEMA_VERSION}`); }
    database.prepare("INSERT INTO metadata(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(SCHEMA_VERSION));
    database.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('generation',?)").run(randomBytes(16).toString("hex"));
  }

  generation(): string { return String((this.db().prepare("SELECT value FROM metadata WHERE key='generation'").get() as any)?.value ?? ""); }

  private associatedData(traceId: string, segmentId: string): Buffer { return Buffer.from(`${this.accountId}\0${this.region}\0${traceId}\0${segmentId}`); }

  private encrypt(segment: CanonicalSegment): { nonce: Buffer; tag: Buffer; ciphertext: Buffer } {
    const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key!, nonce); cipher.setAAD(this.associatedData(segment.traceId, segment.segmentId));
    const ciphertext = Buffer.concat([cipher.update(segment.document, "utf8"), cipher.final()]); return { nonce, tag: cipher.getAuthTag(), ciphertext };
  }

  private decrypt(row: any): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key!, Buffer.from(row.nonce)); decipher.setAAD(this.associatedData(String(row.trace_id), String(row.segment_id))); decipher.setAuthTag(Buffer.from(row.tag));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]).toString("utf8");
  }

  private capacityAllows(segment: CanonicalSegment, replacingBytes = 0): boolean {
    const database = this.db();
    const counts = database.prepare("SELECT COUNT(*) AS traces, (SELECT COUNT(*) FROM segments WHERE account_id=? AND region=?) AS segments, (SELECT COALESCE(SUM(document_bytes),0) FROM segments WHERE account_id=? AND region=?) AS bytes FROM traces WHERE account_id=? AND region=?").get(this.accountId, this.region, this.accountId, this.region, this.accountId, this.region) as any;
    const traceExists = Boolean(database.prepare("SELECT 1 FROM traces WHERE account_id=? AND region=? AND trace_id=?").get(this.accountId, this.region, segment.traceId));
    const segmentExists = Boolean(database.prepare("SELECT 1 FROM segments WHERE account_id=? AND region=? AND trace_id=? AND segment_id=?").get(this.accountId, this.region, segment.traceId, segment.segmentId));
    return number(counts.traces) + (traceExists ? 0 : 1) <= this.maximumTraces
      && number(counts.segments) + (segmentExists ? 0 : 1) <= this.maximumSegments
      && number(counts.bytes) - replacingBytes + Buffer.byteLength(segment.document) <= this.maximumDocumentBytes;
  }

  ingest(segment: CanonicalSegment): { accepted: true; duplicate: boolean } {
    const database = this.db(); const now = this.now();
    const existing = database.prepare("SELECT in_progress, canonical_hash, document_bytes FROM segments WHERE account_id=? AND region=? AND trace_id=? AND segment_id=?").get(this.accountId, this.region, segment.traceId, segment.segmentId) as any;
    if (existing && String(existing.canonical_hash) === segment.canonicalHash) return { accepted: true, duplicate: true };
    if (existing && !Boolean(existing.in_progress)) throw new AwsError("ConflictException", "A completed segment with this id already exists", 400);
    if (existing && segment.inProgress) throw new AwsError("ConflictException", "An in-progress segment can only be replaced by its completion", 400);
    if (!this.capacityAllows(segment, number(existing?.document_bytes))) { this.healthState.status = "capacity-limited"; this.recordFailure("ThrottledException", "X-Ray trace repository capacity is exhausted"); throw new AwsError("ThrottledException", "X-Ray trace repository capacity is exhausted", 429); }
    const encrypted = this.encrypt(segment);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`INSERT INTO traces(account_id,region,trace_id,start_time,end_time,duration,root_service,response_status,has_error,has_fault,has_throttle,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,region,trace_id) DO NOTHING`).run(this.accountId, this.region, segment.traceId, segment.startTime, segment.endTime ?? segment.startTime, Math.max(0, (segment.endTime ?? segment.startTime) - segment.startTime), segment.name, segment.responseStatus ?? null, Number(segment.error), Number(segment.fault), Number(segment.throttle), now);
      database.prepare(`INSERT INTO segments(account_id,region,trace_id,segment_id,parent_id,kind,name,start_time,end_time,in_progress,origin,resource_arn,response_status,has_error,has_fault,has_throttle,document_bytes,nonce,tag,ciphertext,canonical_hash,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id,region,trace_id,segment_id) DO UPDATE SET parent_id=excluded.parent_id,kind=excluded.kind,name=excluded.name,start_time=excluded.start_time,end_time=excluded.end_time,in_progress=excluded.in_progress,origin=excluded.origin,resource_arn=excluded.resource_arn,response_status=excluded.response_status,has_error=excluded.has_error,has_fault=excluded.has_fault,has_throttle=excluded.has_throttle,document_bytes=excluded.document_bytes,nonce=excluded.nonce,tag=excluded.tag,ciphertext=excluded.ciphertext,canonical_hash=excluded.canonical_hash,updated_at=excluded.updated_at`).run(
          this.accountId, this.region, segment.traceId, segment.segmentId, segment.parentId ?? null, segment.kind, segment.name, segment.startTime, segment.endTime ?? null, Number(segment.inProgress), segment.origin ?? null, segment.resourceArn ?? null, segment.responseStatus ?? null, Number(segment.error), Number(segment.fault), Number(segment.throttle), Buffer.byteLength(segment.document), encrypted.nonce, encrypted.tag, encrypted.ciphertext, segment.canonicalHash, now,
        );
      database.prepare("DELETE FROM annotations WHERE account_id=? AND region=? AND trace_id=? AND segment_id=?").run(this.accountId, this.region, segment.traceId, segment.segmentId);
      const insertAnnotation = database.prepare("INSERT INTO annotations(account_id,region,trace_id,segment_id,annotation_key,string_value,number_value,boolean_value) VALUES(?,?,?,?,?,?,?,?)");
      for (const [key, value] of Object.entries(segment.annotations)) insertAnnotation.run(this.accountId, this.region, segment.traceId, segment.segmentId, key, typeof value === "string" ? value : null, typeof value === "number" ? value : null, typeof value === "boolean" ? Number(value) : null);
      database.prepare("DELETE FROM edges WHERE account_id=? AND region=? AND trace_id=? AND (source_id=? OR destination_id=?)").run(this.accountId, this.region, segment.traceId, segment.segmentId, segment.segmentId);
      const insertEdge = database.prepare("INSERT OR IGNORE INTO edges(account_id,region,trace_id,source_id,destination_id) VALUES(?,?,?,?,?)");
      for (const edge of segment.edges) insertEdge.run(this.accountId, this.region, segment.traceId, edge.sourceId, edge.destinationId);
      this.recomputeTrace(segment.traceId, now);
      database.exec("COMMIT");
    } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    this.refreshHealth();
    return { accepted: true, duplicate: false };
  }

  private recomputeTrace(traceId: string, now: number): void {
    const database = this.db();
    const aggregate = database.prepare(`SELECT MIN(start_time) AS start_time, MAX(COALESCE(end_time,start_time)) AS end_time,
      MAX(has_error) AS has_error, MAX(has_fault) AS has_fault, MAX(has_throttle) AS has_throttle
      FROM segments WHERE account_id=? AND region=? AND trace_id=?`).get(this.accountId, this.region, traceId) as any;
    const root = database.prepare("SELECT name,response_status FROM segments WHERE account_id=? AND region=? AND trace_id=? ORDER BY CASE kind WHEN 'segment' THEN 0 ELSE 1 END, start_time, segment_id LIMIT 1").get(this.accountId, this.region, traceId) as any;
    const start = number(aggregate.start_time); const end = number(aggregate.end_time);
    database.prepare("UPDATE traces SET start_time=?,end_time=?,duration=?,root_service=?,response_status=?,has_error=?,has_fault=?,has_throttle=?,updated_at=? WHERE account_id=? AND region=? AND trace_id=?").run(start, end, Math.max(0, end - start), String(root?.name ?? "unknown"), root?.response_status ?? null, number(aggregate.has_error), number(aggregate.has_fault), number(aggregate.has_throttle), now, this.accountId, this.region, traceId);
  }

  summaries(startTime: number, endTime: number, position = 0, limit = 100): XRayPage<StoredTraceSummary> {
    const rows = this.db().prepare("SELECT * FROM traces WHERE account_id=? AND region=? AND start_time>=? AND start_time<=? ORDER BY start_time DESC,trace_id LIMIT ? OFFSET ?").all(this.accountId, this.region, startTime, endTime, limit + 1, position) as any[];
    const page = rows.slice(0, limit).map(row => this.summary(row));
    return { items: page, ...(rows.length > limit ? { nextPosition: position + limit } : {}) };
  }

  private summary(row: any): StoredTraceSummary {
    const annotationRows = this.db().prepare("SELECT annotation_key,string_value,number_value,boolean_value FROM annotations WHERE account_id=? AND region=? AND trace_id=? ORDER BY annotation_key").all(this.accountId, this.region, row.trace_id) as any[];
    const annotations: StoredTraceSummary["annotations"] = {};
    for (const annotation of annotationRows) {
      const value = annotation.string_value !== null ? { StringValue: String(annotation.string_value) } : annotation.number_value !== null ? { NumberValue: number(annotation.number_value) } : { BooleanValue: Boolean(annotation.boolean_value) };
      (annotations[String(annotation.annotation_key)] ??= []).push({ AnnotationValue: value, ServiceIds: [{ Name: String(row.root_service), Type: "AWS::ApiGateway::Stage", AccountId: this.accountId }] });
    }
    return { traceId: String(row.trace_id), startTime: number(row.start_time), endTime: number(row.end_time), duration: number(row.duration), rootService: String(row.root_service), ...(row.response_status === null ? {} : { responseStatus: number(row.response_status) }), error: Boolean(row.has_error), fault: Boolean(row.has_fault), throttle: Boolean(row.has_throttle), annotations };
  }

  getTrace(traceId: string): StoredTrace | undefined {
    const trace = this.db().prepare("SELECT * FROM traces WHERE account_id=? AND region=? AND trace_id=?").get(this.accountId, this.region, traceId) as any;
    if (!trace) return undefined;
    const rows = this.db().prepare("SELECT * FROM segments WHERE account_id=? AND region=? AND trace_id=? ORDER BY start_time,segment_id").all(this.accountId, this.region, traceId) as any[];
    try { return { id: traceId, duration: number(trace.duration), limitExceeded: false, segments: rows.map(row => ({ id: String(row.segment_id), document: this.decrypt(row) })) }; }
    catch (error) { this.healthState.status = "degraded"; this.recordError(error); return undefined; }
  }

  getTraces(traceIds: readonly string[], position = 0, limit = 100): XRayPage<StoredTrace> & { unprocessed: string[] } {
    const selected = traceIds.slice(position, position + limit); const items: StoredTrace[] = []; const unprocessed: string[] = [];
    for (const traceId of selected) { const trace = this.getTrace(traceId); if (trace) items.push(trace); else if (this.hasTrace(traceId)) unprocessed.push(traceId); }
    return { items, unprocessed, ...(position + limit < traceIds.length ? { nextPosition: position + limit } : {}) };
  }

  hasTrace(traceId: string): boolean { return Boolean(this.db().prepare("SELECT 1 FROM traces WHERE account_id=? AND region=? AND trace_id=?").get(this.accountId, this.region, traceId)); }

  edges(traceIds: readonly string[]): Array<{ traceId: string; sourceId: string; destinationId: string }> {
    const output: Array<{ traceId: string; sourceId: string; destinationId: string }> = [];
    for (const traceId of traceIds) for (const row of this.db().prepare("SELECT source_id,destination_id FROM edges WHERE account_id=? AND region=? AND trace_id=? ORDER BY source_id,destination_id").all(this.accountId, this.region, traceId) as any[]) output.push({ traceId, sourceId: String(row.source_id), destinationId: String(row.destination_id) });
    return output;
  }

  cleanup(): number {
    const database = this.db(); const cutoff = (this.now() - this.retentionMs) / 1000;
    const rows = database.prepare("SELECT trace_id FROM traces WHERE account_id=? AND region=? AND end_time<? ORDER BY end_time LIMIT ?").all(this.accountId, this.region, cutoff, this.cleanupBatchSize) as any[];
    if (rows.length) { database.exec("BEGIN IMMEDIATE"); try { const remove = database.prepare("DELETE FROM traces WHERE account_id=? AND region=? AND trace_id=?"); for (const row of rows) remove.run(this.accountId, this.region, row.trace_id); database.exec("COMMIT"); } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; } }
    const at = this.now(); database.prepare("INSERT INTO metadata(key,value) VALUES('last_cleanup_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(at)); this.healthState.lastCleanupAt = at; return rows.length;
  }

  recordFailure(code: string, message: string): void {
    const safe = message.replace(/(authorization|cookie|password|secret|token|credential)\s*[:=]\s*\S+/gi, "$1=<redacted>").slice(0, 500);
    try { this.db().prepare("INSERT INTO ingestion_failures(account_id,region,occurred_at,error_code,message) VALUES(?,?,?,?,?)").run(this.accountId, this.region, this.now(), code, safe); } catch {}
    this.healthState.rejectedCount += 1; this.recordError(`${code}: ${safe}`);
  }

  private recordError(error: unknown): void { const message = (error instanceof Error ? error.message : String(error)).slice(0, 500); this.healthState.errors = [...this.healthState.errors, message].slice(-20); }

  private refreshHealth(): void {
    if (!this.database) return;
    const row = this.database.prepare("SELECT COUNT(*) AS trace_count,MIN(start_time) AS oldest,MAX(start_time) AS newest,(SELECT COUNT(*) FROM segments WHERE account_id=? AND region=?) AS segment_count,(SELECT COUNT(*) FROM ingestion_failures WHERE account_id=? AND region=?) AS rejected FROM traces WHERE account_id=? AND region=?").get(this.accountId, this.region, this.accountId, this.region, this.accountId, this.region) as any;
    const cleanup = this.database.prepare("SELECT value FROM metadata WHERE key='last_cleanup_at'").get() as any;
    this.healthState = { ...this.healthState, traceCount: number(row.trace_count), segmentCount: number(row.segment_count), rejectedCount: number(row.rejected), ...(row.oldest === null ? {} : { oldestTraceTime: number(row.oldest) }), ...(row.newest === null ? {} : { newestTraceTime: number(row.newest) }), ...(cleanup ? { lastCleanupAt: Number(cleanup.value) } : {}) };
  }

  health(): XRayRepositoryHealth { this.refreshHealth(); return structuredClone(this.healthState); }

  async stop(): Promise<void> {
    if (!this.database) return;
    try { this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (error) { this.recordError(error); }
    this.database.close(); this.database = undefined; this.key = undefined;
  }

  static filterHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
}
