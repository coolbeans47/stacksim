import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ServiceIntegrationAttemptState, StepFunctionsExecutionState, StepFunctionsRegionState } from "../types.js";

const EXECUTION_SCHEMA_VERSION = 4;

/**
 * The per-account/Region transactional execution store. Execution payloads,
 * immutable snapshots, checkpoints, retry deadlines, and typed histories stay
 * outside state.json in a private SQLite database.
 */
export class StepFunctionsExecutionStore {
  readonly directory: string;
  readonly file: string;
  private executions: globalThis.Record<string, StepFunctionsExecutionState> = {};
  private database?: DatabaseSync;

  constructor(root: string, accountId: string, region: string) {
    this.directory = resolve(root, "data", "step-functions", accountId, region);
    this.file = resolve(this.directory, "executions.sqlite");
  }

  async start(regional: StepFunctionsRegionState): Promise<void> {
    if (this.database) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(this.file);
    try {
      database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        database.exec("CREATE TABLE IF NOT EXISTS executions (execution_arn TEXT PRIMARY KEY, document TEXT NOT NULL, updated_at INTEGER NOT NULL)");
        database.exec("CREATE TABLE IF NOT EXISTS integration_attempts (attempt_id TEXT PRIMARY KEY, document TEXT NOT NULL, updated_at INTEGER NOT NULL)");
        const version = database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value?: string } | undefined;
        if (version && Number(version.value) > EXECUTION_SCHEMA_VERSION) throw new Error(`Step Functions execution schema ${version.value} is newer than supported schema ${EXECUTION_SCHEMA_VERSION}`);
        database.prepare("INSERT INTO metadata(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(EXECUTION_SCHEMA_VERSION));
        const insert = database.prepare("INSERT INTO executions(execution_arn,document,updated_at) VALUES(?,?,?) ON CONFLICT(execution_arn) DO UPDATE SET document=excluded.document, updated_at=excluded.updated_at");
        const persisted = database.prepare("SELECT execution_arn, document FROM executions").all() as Array<{ execution_arn: string; document: string }>;
        for (const row of persisted) {
          const execution = JSON.parse(row.document) as StepFunctionsExecutionState;
          if (execution.executionArn !== row.execution_arn) throw new Error(`Execution identity mismatch for ${row.execution_arn}`);
          execution.taskJournal ??= {};
          execution.callbackTasks ??= {};
          execution.nestedExecutions ??= {};
          this.executions[row.execution_arn] = execution;
        }
        // One-time import from the pre-SFN-P0 control-state prototype.
        for (const execution of Object.values(regional.executions ?? {})) if (!this.executions[execution.executionArn]) {
          insert.run(execution.executionArn, JSON.stringify(execution), Date.now());
          this.executions[execution.executionArn] = execution;
        }
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      await chmod(this.file, 0o600).catch(() => undefined);
      Object.defineProperty(regional, "executions", { configurable: true, enumerable: false, writable: false, value: this.executions });
      this.database = database;
    } catch (error) { database.close(); throw error; }
  }

  async put(execution: StepFunctionsExecutionState): Promise<void> {
    const database = this.db(); const document = JSON.stringify(execution);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("INSERT INTO executions(execution_arn,document,updated_at) VALUES(?,?,?) ON CONFLICT(execution_arn) DO UPDATE SET document=excluded.document, updated_at=excluded.updated_at").run(execution.executionArn, document, Date.now());
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    this.executions[execution.executionArn] = execution;
  }

  async delete(executionArn: string): Promise<void> {
    this.db().prepare("DELETE FROM executions WHERE execution_arn = ?").run(executionArn);
    delete this.executions[executionArn];
  }

  integrationAttempt(attemptId: string): ServiceIntegrationAttemptState | undefined { const row = this.db().prepare("SELECT document FROM integration_attempts WHERE attempt_id = ?").get(attemptId) as { document: string } | undefined; return row ? JSON.parse(row.document) as ServiceIntegrationAttemptState : undefined; }
  async putIntegrationAttempt(attempt: ServiceIntegrationAttemptState): Promise<void> { const database = this.db(); database.exec("BEGIN IMMEDIATE"); try { const prior = database.prepare("SELECT document FROM integration_attempts WHERE attempt_id = ?").get(attempt.attemptId) as { document: string } | undefined; if (prior && prior.document !== JSON.stringify(attempt)) throw new Error(`Integration attempt ${attempt.attemptId} was committed with different metadata`); database.prepare("INSERT INTO integration_attempts(attempt_id,document,updated_at) VALUES(?,?,?) ON CONFLICT(attempt_id) DO NOTHING").run(attempt.attemptId, JSON.stringify(attempt), Date.now()); database.exec("COMMIT"); } catch (error) { database.exec("ROLLBACK"); throw error; } }
  async deleteIntegrationAttempt(attemptId: string): Promise<void> { this.db().prepare("DELETE FROM integration_attempts WHERE attempt_id = ?").run(attemptId); }

  async stop(): Promise<void> { this.database?.close(); this.database = undefined; }
  private db(): DatabaseSync { if (!this.database) throw new Error("Step Functions execution store is not started"); return this.database; }
}
