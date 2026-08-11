import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ServiceIntegrationAttemptState } from "../types.js";

const SCHEMA_VERSION = 1;

/** Private DynamoDB integration results. Arbitrary item values never enter state.json. */
export class DynamoIntegrationAttemptStore {
  readonly directory: string;
  readonly file: string;
  private database?: DatabaseSync;

  constructor(root: string, accountId: string, region: string) {
    this.directory = resolve(root, "data", "dynamodb", accountId, region);
    this.file = resolve(this.directory, "integration-attempts.sqlite");
  }

  async start(): Promise<void> {
    if (this.database) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(this.file);
    try {
      database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        database.exec("CREATE TABLE IF NOT EXISTS attempts (attempt_id TEXT PRIMARY KEY, document TEXT NOT NULL, updated_at INTEGER NOT NULL)");
        const version = database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value?: string } | undefined;
        if (version && Number(version.value) > SCHEMA_VERSION) throw new Error(`DynamoDB integration-attempt schema ${version.value} is newer than supported schema ${SCHEMA_VERSION}`);
        database.prepare("INSERT INTO metadata(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(SCHEMA_VERSION));
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      await chmod(this.file, 0o600).catch(() => undefined);
      this.database = database;
    } catch (error) { database.close(); throw error; }
  }

  get(attemptId: string): ServiceIntegrationAttemptState | undefined {
    const row = this.db().prepare("SELECT document FROM attempts WHERE attempt_id = ?").get(attemptId) as { document: string } | undefined;
    return row ? JSON.parse(row.document) as ServiceIntegrationAttemptState : undefined;
  }

  put(attempt: ServiceIntegrationAttemptState): void {
    this.db().prepare("INSERT INTO attempts(attempt_id,document,updated_at) VALUES(?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET document=excluded.document, updated_at=excluded.updated_at").run(attempt.attemptId, JSON.stringify(attempt), Date.now());
  }

  delete(attemptId: string): void { this.db().prepare("DELETE FROM attempts WHERE attempt_id = ?").run(attemptId); }

  prune(retained: ReadonlySet<string>): void {
    const database = this.db(); const rows = database.prepare("SELECT attempt_id FROM attempts").all() as Array<{ attempt_id: string }>;
    const remove = database.prepare("DELETE FROM attempts WHERE attempt_id = ?");
    database.exec("BEGIN IMMEDIATE");
    try { for (const row of rows) if (!retained.has(row.attempt_id)) remove.run(row.attempt_id); database.exec("COMMIT"); }
    catch (error) { database.exec("ROLLBACK"); throw error; }
  }

  async stop(): Promise<void> { this.database?.close(); this.database = undefined; }
  private db(): DatabaseSync { if (!this.database) throw new Error("DynamoDB integration-attempt store is not started"); return this.database; }
}
