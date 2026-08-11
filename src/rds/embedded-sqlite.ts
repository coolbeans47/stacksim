import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readdirSync } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { backup, DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementColumnMetadata } from "node:sqlite";
import { basename, join, parse, relative, resolve, sep } from "node:path";
import mysql from "mysql2";
import {
  RdsEngineProviderError,
  type RdsEngineConfig,
  type RdsEngineDiscovery,
  type RdsEngineProvider,
  type RdsEngineResourceConfig,
  type RdsEngineRuntime,
  type RdsEngineSnapshotFile,
} from "./provider.js";
import {
  compileMysqlStatement,
  MYSQL_SERVER_VERSION,
  mysqlProfileError,
  type MysqlProfilePlan,
} from "./mysql-profile.js";

const PROVIDER_NAME = "embedded-sqlite";
const LOOPBACK = "127.0.0.1" as const;
const MARKER_FILE = ".stacksim-rds-sqlite.json";
const ENGINE_VERSION = process.versions.sqlite ?? "unknown";
const MYSQL_COMPATIBILITY_VERSION = MYSQL_SERVER_VERSION;
const DEFAULT_PARAMETERS: Record<string, string> = {
  max_connections: "100",
  wait_timeout: "28800",
  max_allowed_packet: "16777216",
  innodb_flush_log_at_trx_commit: "1",
  collation_server: "utf8mb4_unicode_ci",
};
const DYNAMIC_PARAMETERS = new Set(["max_connections", "wait_timeout", "max_allowed_packet", "innodb_flush_log_at_trx_commit"]);
const DATABASE_NAME = /^[A-Za-z][A-Za-z0-9_$]{0,63}$/;

// mysql2 intentionally exposes only a small public server type even though its
// server-side protocol implementation offers these methods and events.
interface MysqlServerConnection {
  stream: NodeJS.ReadWriteStream & { remoteAddress?: string; destroy(): void; end(): void };
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  serverHandshake(options: Record<string, unknown>): void;
  writeColumns(columns: MysqlColumn[]): void;
  writeTextRow(row: unknown[]): void;
  writeOk(options?: Record<string, unknown>): void;
  writeError(options: { code: number; message: string }): void;
  writeEof(warnings?: number, statusFlags?: number): void;
  writePacket(packet: WirePacket): void;
  sequenceId: number;
}

interface MysqlServer {
  _server: import("node:net").Server;
  listen(port: number, host: string, callback: () => void): void;
  close(callback: (error?: Error) => void): void;
}

interface MysqlColumn {
  catalog: string;
  schema: string;
  table: string;
  orgTable: string;
  name: string;
  orgName: string;
  characterSet: number;
  columnLength: number;
  columnType: number;
  flags: number;
  decimals: number;
}

interface ProviderMarker {
  schemaVersion: 1;
  providerName: typeof PROVIDER_NAME;
  resourceId: string;
  databaseName?: string;
  port: number;
  engineVersion: string;
  state: "initializing" | "ready" | "failed";
  failureCode?: string;
}

interface ActiveEngine {
  config: RdsEngineConfig;
  server: MysqlServer;
  connections: Set<MysqlServerConnection>;
  parameters: Record<string, string>;
}

interface ConnectionState {
  database?: string;
  sqlite?: DatabaseSync;
  statements: Map<number, string>;
  nextStatementId: number;
  lastInsertId: number;
  closed: boolean;
}

interface SqlResult {
  rows?: Record<string, SQLOutputValue>[];
  metadata?: StatementColumnMetadata[];
  affectedRows?: number;
  insertId?: number;
}

export interface EmbeddedSqliteProviderOptions {
  /** Only direct children of this directory may be initialized or destroyed. */
  instancesRoot?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  platform?: NodeJS.Platform;
}

/**
 * Development-only, file-backed SQLite engine exposed through mysql2's MySQL
 * protocol server. It deliberately implements a documented MySQL subset, not
 * a general MariaDB/MySQL replacement.
 */
export class EmbeddedSqliteProvider implements RdsEngineProvider {
  private readonly instancesRoot: string;
  private readonly startupTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private active?: ActiveEngine;

  constructor(options: EmbeddedSqliteProviderOptions = {}) {
    this.instancesRoot = resolve(options.instancesRoot ?? join(".stacksim", "data", "rds", "instances"));
    if (this.instancesRoot === parse(this.instancesRoot).root) {
      throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The RDS instances root cannot be a filesystem root.");
    }
    this.startupTimeoutMs = positiveDuration(options.startupTimeoutMs, 30_000, "startupTimeoutMs");
    this.stopTimeoutMs = positiveDuration(options.stopTimeoutMs, 10_000, "stopTimeoutMs");
    this.platform = options.platform ?? process.platform;
  }

  async discover(): Promise<RdsEngineDiscovery> {
    await this.prepareRoot();
    if (ENGINE_VERSION === "unknown") {
      throw new RdsEngineProviderError("PROVIDER_INCOMPATIBLE", "This Node.js runtime does not expose its embedded SQLite version.");
    }
    return {
      providerName: PROVIDER_NAME,
      engineVersion: ENGINE_VERSION,
      version: `SQLite ${ENGINE_VERSION} embedded in Node.js ${process.versions.node}`,
    };
  }

  async initialize(input: RdsEngineConfig): Promise<void> {
    if (this.active) throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "An embedded SQLite RDS listener is already active.");
    const config = this.validateConfig(input);
    const discovery = await this.discover();
    await this.assertSafeResourceDirectory(config.resourceDir, false);
    const marker = await this.readMarker(config.resourceDir);
    if (marker) {
      if (marker.state === "ready" && this.markerMatches(marker, config)) return;
      throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The RDS resource directory contains an incomplete or different embedded SQLite instance. Destroy it explicitly before retrying.");
    }
    const entries = await readdir(config.resourceDir).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    if (entries.length) {
      throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The RDS resource directory is not empty and has no embedded SQLite ownership marker.");
    }

    await mkdir(join(config.resourceDir, "data"), { recursive: true, mode: 0o700 });
    await mkdir(join(config.resourceDir, "logs"), { recursive: true, mode: 0o700 });
    await this.assertSafeResourceDirectory(config.resourceDir, true);
    const initializing: ProviderMarker = {
      schemaVersion: 1,
      providerName: PROVIDER_NAME,
      resourceId: config.resourceId,
      databaseName: config.databaseName,
      port: config.port,
      engineVersion: discovery.engineVersion,
      state: "initializing",
    };
    await this.writeMarker(config.resourceDir, initializing);
    try {
      if (config.databaseName) this.createDatabaseFile(config.resourceDir, config.databaseName, true);
      await writeFile(join(config.resourceDir, "logs", "sqlite.log"), "", { encoding: "utf8", mode: 0o600, flag: "wx" });
      await this.writeMarker(config.resourceDir, { ...initializing, state: "ready" });
    } catch (error) {
      try { await this.writeMarker(config.resourceDir, { ...initializing, state: "failed", failureCode: "INITIALIZATION_FAILED" }); } catch {}
      if (error instanceof RdsEngineProviderError) throw error;
      throw new RdsEngineProviderError("INITIALIZATION_FAILED", "The embedded SQLite RDS data directory could not be initialized.");
    }
  }

  async start(input: RdsEngineConfig): Promise<RdsEngineRuntime> {
    const config = this.validateConfig(input);
    await this.prepareRoot();
    await this.assertSafeResourceDirectory(config.resourceDir, true);
    const marker = await this.readMarker(config.resourceDir);
    if (!marker || marker.state !== "ready" || !this.markerMatches(marker, config)) {
      throw new RdsEngineProviderError("START_FAILED", "The embedded SQLite resource is not initialized for this RDS instance.");
    }

    if (this.active) {
      if (!samePath(this.active.config.resourceDir, config.resourceDir, this.platform) || this.active.config.port !== config.port) {
        throw new RdsEngineProviderError("START_FAILED", "A different embedded SQLite resource is already active in this simulator process.");
      }
      const current = await this.readiness(config);
      if (current.ready) return current;
      throw new RdsEngineProviderError("START_FAILED", current.diagnostic ?? "The embedded SQLite listener is not ready.");
    }

    const ownershipKey = pathKey(config.resourceDir, this.platform);
    const existing = ACTIVE_OWNERS.get(ownershipKey);
    if (existing && existing !== this) await existing.stop();

    const connections = new Set<MysqlServerConnection>();
    const parameters = { ...DEFAULT_PARAMETERS, ...validateProviderParameters(config.parameters ?? {}, false) };
    const server = mysql.createServer(connection => this.acceptConnection(connection as unknown as MysqlServerConnection)) as unknown as MysqlServer;
    const active: ActiveEngine = { config: { ...config }, server, connections, parameters };
    this.active = active;
    ACTIVE_OWNERS.set(ownershipKey, this);
    try {
      await listen(server, config.port, this.startupTimeoutMs);
      const runtime = await this.readiness(config);
      if (!runtime.ready) throw new RdsEngineProviderError("START_FAILED", runtime.diagnostic ?? "The embedded SQLite listener failed its authenticated readiness check.");
      return runtime;
    } catch (error) {
      await this.stop().catch(() => undefined);
      if (error instanceof RdsEngineProviderError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" || code === "EACCES") {
        throw new RdsEngineProviderError("PORT_IN_USE", "The configured RDS port is unavailable on 127.0.0.1.");
      }
      throw new RdsEngineProviderError("START_FAILED", "The embedded SQLite MySQL listener could not be started.");
    }
  }

  async readiness(input: RdsEngineConfig): Promise<RdsEngineRuntime> {
    const config = this.validateConfig(input);
    const marker = await this.readMarker(config.resourceDir);
    const base: RdsEngineRuntime = {
      providerName: PROVIDER_NAME,
      resourceId: config.resourceId,
      resourceDir: config.resourceDir,
      endpoint: { address: LOOPBACK, port: config.port },
      engineVersion: marker?.engineVersion ?? ENGINE_VERSION,
      pid: process.pid,
      ready: false,
    };
    const active = this.active;
    if (!active || !samePath(active.config.resourceDir, config.resourceDir, this.platform) || active.config.port !== config.port) {
      return { ...base, diagnostic: "The embedded SQLite RDS listener is not running for this resource." };
    }
    try {
      const client = await import("mysql2/promise");
      const connection = await client.default.createConnection({
        host: LOOPBACK,
        port: config.port,
        user: config.masterUsername,
        password: config.masterPassword,
        database: config.databaseName,
        connectTimeout: Math.min(1_500, this.startupTimeoutMs),
      });
      try {
        const [rows] = await connection.query("SELECT 1 AS ready");
        if (!Array.isArray(rows) || (rows[0] as Record<string, unknown> | undefined)?.ready !== 1) throw new Error("readiness row mismatch");
      } finally {
        await connection.end();
      }
      return { ...base, ready: true };
    } catch {
      return { ...base, diagnostic: "The embedded SQLite listener did not accept the managed master credential." };
    }
  }

  async rotateMasterPassword(input: RdsEngineConfig, nextPassword: string): Promise<void> {
    const config = this.validateConfig(input);
    if (!nextPassword || nextPassword.length > 1_024) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The replacement RDS master password is invalid.");
    const active = this.requireActive(config);
    if (active.config.masterUsername !== config.masterUsername || active.config.masterPassword !== config.masterPassword) {
      throw new RdsEngineProviderError("AUTHENTICATION_FAILED", "The current RDS master credential could not be authenticated.");
    }
    active.config = { ...active.config, masterPassword: nextPassword };
    const next = { ...config, masterPassword: nextPassword };
    const verification = await this.readiness(next);
    if (!verification.ready) {
      active.config = { ...active.config, masterPassword: config.masterPassword };
      throw new RdsEngineProviderError("AUTHENTICATION_FAILED", "The replacement RDS master credential could not be verified.");
    }
  }

  async applyParameters(input: RdsEngineConfig, parameters: Record<string, string>): Promise<void> {
    const config = this.validateConfig(input);
    const validated = validateProviderParameters(parameters, true);
    if (!Object.keys(validated).length) return;
    const active = this.requireActive(config);
    active.parameters = { ...active.parameters, ...validated };
    active.config = { ...active.config, parameters: { ...(active.config.parameters ?? {}), ...validated } };
  }

  async captureSnapshot(input: RdsEngineConfig, targetDataDir: string): Promise<RdsEngineSnapshotFile[]> {
    const config = this.validateConfig(input);
    if (this.active) throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The embedded SQLite provider must be stopped before snapshot capture.");
    await this.assertSafeResourceDirectory(config.resourceDir, true);
    const marker = await this.readMarker(config.resourceDir);
    if (!marker || marker.state !== "ready" || !this.markerMatches(marker, config)) throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The snapshot source ownership marker does not match the stopped resource.");
    const target = resolve(targetDataDir);
    const targetEntries = await readdir(target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    if (targetEntries.length) throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The snapshot staging data directory must be empty.");
    await mkdir(target, { recursive: true, mode: 0o700 });
    const names = this.listDatabases(config.resourceDir);
    const files: RdsEngineSnapshotFile[] = [];
    for (const name of names) {
      const fileName = `${name}.sqlite`;
      const sourcePath = this.databasePath(config.resourceDir, name);
      assertSafeDatabaseFiles(sourcePath, true);
      const destinationPath = join(target, fileName);
      const source = new DatabaseSync(sourcePath, { readOnly: true });
      try { await backup(source, destinationPath); }
      finally { source.close(); }
      const handle = await open(destinationPath, "r+");
      try { await handle.sync(); }
      finally { await handle.close(); }
      const metadata = await lstat(destinationPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new RdsEngineProviderError("INITIALIZATION_FAILED", "A snapshot database file was not published safely.");
      files.push({ name: fileName, sizeBytes: metadata.size, sha256: await sha256File(destinationPath) });
    }
    return files;
  }

  async restoreSnapshot(input: RdsEngineConfig, sourceDataDir: string, files: readonly RdsEngineSnapshotFile[]): Promise<void> {
    const config = this.validateConfig(input);
    if (this.active) throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The embedded SQLite provider must be stopped before snapshot restore.");
    await this.assertSafeResourceDirectory(config.resourceDir, true);
    const marker = await this.readMarker(config.resourceDir);
    if (!marker || marker.state !== "ready" || !this.markerMatches(marker, config)) throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The restore target ownership marker does not match the new resource.");
    const source = resolve(sourceDataDir);
    const target = join(config.resourceDir, "data");
    const validatedNames = new Set<string>();
    for (const file of files) {
      if (!/^[A-Za-z][A-Za-z0-9_$]{0,63}\.sqlite$/.test(file.name) || validatedNames.has(file.name)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The snapshot contains an invalid database file name.");
      validatedNames.add(file.name);
      const sourcePath = join(source, file.name);
      const metadata = await lstat(sourcePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.sizeBytes || await sha256File(sourcePath) !== file.sha256) throw new RdsEngineProviderError("INITIALIZATION_FAILED", "The snapshot database checksum validation failed.");
    }
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.sqlite(?:-(?:wal|shm|journal))?$/.test(entry.name)) throw new RdsEngineProviderError("DESTROY_REFUSED", "The new restore target contains an unexpected data entry.");
      await rm(join(target, entry.name), { force: true });
    }
    for (const file of files) {
      const destination = join(target, file.name);
      const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
      try {
        await copyFile(join(source, file.name), temporary);
        const handle = await open(temporary, "r+");
        try { await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, destination);
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    }
  }

  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    const ownershipKey = pathKey(active.config.resourceDir, this.platform);
    if (ACTIVE_OWNERS.get(ownershipKey) === this) ACTIVE_OWNERS.delete(ownershipKey);
    for (const connection of active.connections) connection.stream.destroy();
    active.connections.clear();
    try {
      await closeServer(active.server, this.stopTimeoutMs);
    } catch {
      throw new RdsEngineProviderError("STOP_FAILED", "The embedded SQLite MySQL listener did not stop cleanly.");
    }
  }

  async reconfigure(currentInput: RdsEngineConfig, nextInput: RdsEngineConfig): Promise<void> {
    if (this.active) throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The embedded SQLite provider must be stopped before its listener configuration changes.");
    const current = this.validateConfig(currentInput);
    const next = this.validateConfig(nextInput);
    if (current.resourceId !== next.resourceId || !samePath(current.resourceDir, next.resourceDir, this.platform) || current.databaseName !== next.databaseName || current.masterUsername !== next.masterUsername) {
      throw new RdsEngineProviderError("INVALID_CONFIGURATION", "Only the owned embedded SQLite listener port and safe compatibility variables can be reconfigured.");
    }
    await this.assertSafeResourceDirectory(current.resourceDir, true);
    const marker = await this.readMarker(current.resourceDir);
    if (!marker || marker.state !== "ready" || !this.markerMatches(marker, current)) {
      throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The embedded SQLite ownership marker does not match the current configuration.");
    }
    await this.writeMarker(current.resourceDir, { ...marker, port: next.port });
  }

  async destroy(input: RdsEngineResourceConfig): Promise<void> {
    const config = this.validateResourceConfig(input);
    await this.prepareRoot();
    const tombstone = join(this.instancesRoot, `${config.resourceId}.deleting`);
    if (!await pathExists(config.resourceDir)) {
      if (await pathExists(tombstone)) await this.removeTombstone(tombstone, config);
      return;
    }
    await this.assertSafeResourceDirectory(config.resourceDir, true);
    const marker = await this.readMarker(config.resourceDir);
    if (!marker || marker.resourceId !== config.resourceId || marker.port !== config.port) {
      throw new RdsEngineProviderError("DESTROY_REFUSED", "The directory does not contain a matching embedded SQLite ownership marker.");
    }
    const owner = ACTIVE_OWNERS.get(pathKey(config.resourceDir, this.platform));
    if (owner) await owner.stop();
    if (this.active && !samePath(this.active.config.resourceDir, config.resourceDir, this.platform)) {
      throw new RdsEngineProviderError("DESTROY_REFUSED", "A different embedded SQLite resource is active in this provider.");
    }
    if (await pathExists(tombstone)) throw new RdsEngineProviderError("DESTROY_REFUSED", "An embedded SQLite deletion tombstone already exists.");
    await rename(config.resourceDir, tombstone);
    await this.removeTombstone(tombstone, config);
  }

  private acceptConnection(connection: MysqlServerConnection): void {
    const active = this.active;
    if (!active) {
      connection.stream.destroy();
      return;
    }
    active.connections.add(connection);
    const state: ConnectionState = { statements: new Map(), nextStatementId: 1, lastInsertId: 0, closed: false };
    const cleanup = () => {
      if (state.closed) return;
      state.closed = true;
      try { state.sqlite?.close(); } catch {}
      state.sqlite = undefined;
      active.connections.delete(connection);
    };
    connection.stream.once("close", cleanup);
    connection.stream.once("error", cleanup);
    connection.on("error", cleanup);
    connection.on("quit", () => { cleanup(); connection.stream.end(); });
    connection.on("ping", () => this.respond(connection, () => connection.writeOk()));
    connection.on("init_db", (database: string) => this.respond(connection, () => this.useDatabase(active, state, database)));
    connection.on("query", (sql: string) => this.respond(connection, () => this.executeAndWrite(active, state, connection, sql, [], false)));
    connection.on("stmt_prepare", (sql: string) => this.respond(connection, () => {
      // mysql2 routes text-protocol SET commands through this event too.
      if (/^\s*SET\b/i.test(sql)) return this.executeAndWrite(active, state, connection, sql, [], false);
      compileMysqlStatement(stripTerminator(sql), {
        database: state.database,
        parameters: active.parameters,
        lastInsertId: state.lastInsertId,
      });
      const id = state.nextStatementId++;
      state.statements.set(id, sql);
      this.writePreparedHeader(connection, id, countParameters(sql));
    }));
    connection.on("stmt_execute", (statementId: number | null, _flags: number, _iterations: number, values: unknown[] | null, textSql?: string) => this.respond(connection, () => {
      if (textSql) return this.executeAndWrite(active, state, connection, textSql, [], false);
      const sql = statementId === null ? undefined : state.statements.get(statementId);
      if (!sql) throw mysqlError(1243, "Unknown prepared statement handler");
      return this.executeAndWrite(active, state, connection, sql, values ?? [], true);
    }));
    connection.on("packet", (packet: { readInt32(): number }, _known: boolean, command: number) => {
      // mysql2's server dispatcher does not currently expose COM_STMT_CLOSE.
      if (command === 0x19) state.statements.delete(packet.readInt32());
    });

    connection.serverHandshake({
      protocolVersion: 10,
      serverVersion: MYSQL_COMPATIBILITY_VERSION,
      connectionId: nextConnectionId++,
      statusFlags: 0x0002,
      characterSet: 45,
      capabilityFlags: 0x0000_0001 | 0x0000_0004 | 0x0000_0008 | 0x0000_0200 | 0x0000_2000 | 0x0000_8000 | 0x0002_0000 | 0x0004_0000 | 0x0008_0000,
      authCallback: (auth: { user: string; database?: string; authPluginData1: Buffer; authPluginData2: Buffer; authToken: Buffer }, done: (error: unknown, mysqlFailure?: { code: number; message: string }) => void) => {
        if (active.connections.size > Number(active.parameters.max_connections)) {
          done(null, { code: 1040, message: "Too many connections" });
          return;
        }
        if (auth.user !== active.config.masterUsername || !verifyNativePassword(active.config.masterPassword, auth.authPluginData1, auth.authPluginData2, auth.authToken)) {
          done(null, { code: 1045, message: "Access denied for user" });
          return;
        }
        if (auth.database && !this.databaseExists(active.config.resourceDir, auth.database)) {
          done(null, { code: 1049, message: `Unknown database '${auth.database}'` });
          return;
        }
        state.database = auth.database || undefined;
        done(null);
        queueMicrotask(() => { connection.sequenceId = 0; });
      },
    });
  }

  private respond(connection: MysqlServerConnection, operation: () => void): void {
    try { operation(); }
    catch (error) {
      const failure = normalizeMysqlError(error);
      connection.writePacket(mysqlErrorPacket(failure.code, failure.sqlState, failure.message));
    } finally { connection.sequenceId = 0; }
  }

  private executeAndWrite(active: ActiveEngine, state: ConnectionState, connection: MysqlServerConnection, sourceSql: string, values: unknown[], binary: boolean): void {
    const result = this.executeSql(active, state, sourceSql, values);
    if (!result.rows) {
      connection.writeOk({ affectedRows: result.affectedRows ?? 0, insertId: result.insertId ?? 0, serverStatus: 0x0002 });
      return;
    }
    const columns = buildColumns(result.rows, result.metadata, sourceSql, state.database);
    connection.writeColumns(columns);
    for (const row of result.rows) {
      const ordered = columns.map(column => row[column.name] ?? null);
      if (binary) connection.writePacket(binaryRowPacket(ordered, columns));
      else connection.writePacket(textRowPacket(ordered));
    }
    connection.writeEof(0, 0x0002);
  }

  private executeSql(active: ActiveEngine, state: ConnectionState, sourceSql: string, suppliedValues: unknown[]): SqlResult {
    const sql = stripTerminator(sourceSql);
    if (!sql) return { affectedRows: 0 };
    if (/^SHUTDOWN\b/i.test(sql)) throw mysqlError(1227, "Access denied; the managed master account cannot shut down the embedded RDS engine");

    const plan = compileMysqlStatement(sql, {
      database: state.database,
      parameters: active.parameters,
      lastInsertId: state.lastInsertId,
    });
    if (plan.kind === "set") return { affectedRows: 0 };
    if (plan.kind === "createDatabase") {
      this.validateDatabaseName(plan.database);
      const exists = this.databaseExists(active.config.resourceDir, plan.database);
      if (exists && !plan.ifNotExists) throw mysqlError(1007, `Can't create database '${plan.database}'; database exists`);
      if (!exists) this.createDatabaseFile(active.config.resourceDir, plan.database, true);
      return { affectedRows: exists ? 0 : 1 };
    }
    if (plan.kind === "useDatabase") {
      this.useDatabase(active, state, plan.database);
      return { affectedRows: 0 };
    }
    if (plan.kind === "showDatabases") {
      return {
        rows: this.listDatabases(active.config.resourceDir).map(database => ({ Database: database })),
        metadata: [{ name: "Database", column: null, database: null, table: null, type: "VARCHAR(64)" }],
      };
    }
    if (!state.database && !isDatabaseIndependentPlan(plan)) {
      throw mysqlError(1046, "No database selected");
    }
    const database = this.openSessionDatabase(active, state);
    if (plan.kind === "showTables") return this.showTables(database, state.database!, plan.full);
    if (plan.kind === "describe") return this.describeTable(database, state.database!, plan.table);
    if (plan.kind === "showIndex") return this.showIndexes(database, state.database!, plan.table);
    const translated = plan.sql;
    if (plan.informationSchema) this.refreshInformationSchema(active, database, state.database);
    const values = suppliedValues.map(toSqliteValue);
    const statement = database.prepare(translated);
    if (plan.returnsRows) {
      const rows = statement.all(...values);
      const metadata = typeof (statement as unknown as { columns?: () => StatementColumnMetadata[] }).columns === "function"
        ? (statement as unknown as { columns: () => StatementColumnMetadata[] }).columns()
        : undefined;
      return { rows, metadata };
    }
    const outcome = statement.run(...values);
    const insert = /^\s*INSERT\b/i.test(translated);
    if (insert) state.lastInsertId = Number(outcome.lastInsertRowid);
    return {
      affectedRows: Number(outcome.changes),
      insertId: insert ? state.lastInsertId : 0,
    };
  }

  private showTables(database: DatabaseSync, databaseName: string, full: boolean): SqlResult {
    const name = `Tables_in_${databaseName}`;
    const rows = database.prepare("SELECT name, type FROM main.sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(row => full ? { [name]: row.name, Table_type: String(row.type).toUpperCase() === "VIEW" ? "VIEW" : "BASE TABLE" } : { [name]: row.name });
    return {
      rows,
      metadata: [
        { name, column: null, database: databaseName, table: null, type: "VARCHAR(64)" },
        ...(full ? [{ name: "Table_type", column: null, database: databaseName, table: null, type: "VARCHAR(16)" } as StatementColumnMetadata] : []),
      ],
    };
  }

  private describeTable(database: DatabaseSync, databaseName: string, table: string): SqlResult {
    const tableType = database.prepare("SELECT type FROM main.sqlite_schema WHERE name = ? AND type IN ('table', 'view')").get(table);
    if (!tableType) throw mysqlProfileError(1146, "42S02", `Table '${databaseName}.${table}' doesn't exist`);
    const columns = pragmaTableColumns(database, table);
    const autoIncrement = tableHasAutoIncrement(database, table);
    const rows = columns.map(column => ({
      Field: String(column.name),
      Type: mysqlDeclaredType(String(column.type || "text"), autoIncrement && Number(column.pk) > 0),
      Collation: /(?:CHAR|TEXT|JSON)/i.test(String(column.type)) ? "utf8mb4_bin" : null,
      Null: Number(column.notnull) > 0 || Number(column.pk) > 0 ? "NO" : "YES",
      Key: Number(column.pk) > 0 ? "PRI" : "",
      Default: column.dflt_value ?? null,
      Extra: autoIncrement && Number(column.pk) > 0 ? "auto_increment" : "",
      Privileges: "select,insert,update,references",
      Comment: "",
    }));
    return { rows };
  }

  private showIndexes(database: DatabaseSync, databaseName: string, table: string): SqlResult {
    const exists = database.prepare("SELECT 1 AS present FROM main.sqlite_schema WHERE name = ? AND type = 'table'").get(table);
    if (!exists) throw mysqlProfileError(1146, "42S02", `Table '${databaseName}.${table}' doesn't exist`);
    const rows: Record<string, SQLOutputValue>[] = [];
    const columns = pragmaTableColumns(database, table);
    for (const column of columns.filter(column => Number(column.pk) > 0).sort((left, right) => Number(left.pk) - Number(right.pk))) {
      rows.push(indexRow(table, "PRIMARY", String(column.name), Number(column.pk), false));
    }
    for (const index of pragmaIndexList(database, table)) {
      if (String(index.origin) === "pk") continue;
      for (const column of pragmaIndexColumns(database, String(index.name))) {
        rows.push(indexRow(table, String(index.name), String(column.name), Number(column.seqno) + 1, Number(index.unique) !== 1));
      }
    }
    return { rows };
  }

  private refreshInformationSchema(active: ActiveEngine, database: DatabaseSync, currentDatabase?: string): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS information_schema.SCHEMATA (
        CATALOG_NAME TEXT, SCHEMA_NAME TEXT, DEFAULT_CHARACTER_SET_NAME TEXT, DEFAULT_COLLATION_NAME TEXT
      );
      CREATE TABLE IF NOT EXISTS information_schema.TABLES (
        TABLE_CATALOG TEXT, TABLE_SCHEMA TEXT, TABLE_NAME TEXT, TABLE_TYPE TEXT, ENGINE TEXT, TABLE_ROWS INTEGER, TABLE_COLLATION TEXT
      );
      CREATE TABLE IF NOT EXISTS information_schema.COLUMNS (
        TABLE_CATALOG TEXT, TABLE_SCHEMA TEXT, TABLE_NAME TEXT, COLUMN_NAME TEXT, ORDINAL_POSITION INTEGER,
        COLUMN_DEFAULT, IS_NULLABLE TEXT, DATA_TYPE TEXT, CHARACTER_MAXIMUM_LENGTH INTEGER, NUMERIC_PRECISION INTEGER,
        NUMERIC_SCALE INTEGER, COLUMN_TYPE TEXT, COLUMN_KEY TEXT, EXTRA TEXT, COLLATION_NAME TEXT, CHARACTER_SET_NAME TEXT
      );
      CREATE TABLE IF NOT EXISTS information_schema.STATISTICS (
        TABLE_SCHEMA TEXT, TABLE_NAME TEXT, NON_UNIQUE INTEGER, INDEX_NAME TEXT, SEQ_IN_INDEX INTEGER, COLUMN_NAME TEXT, COLLATION TEXT
      );
      DELETE FROM information_schema.SCHEMATA;
      DELETE FROM information_schema.TABLES;
      DELETE FROM information_schema.COLUMNS;
      DELETE FROM information_schema.STATISTICS;
    `);
    const schemaInsert = database.prepare("INSERT INTO information_schema.SCHEMATA VALUES (?, ?, ?, ?)");
    for (const name of this.listDatabases(active.config.resourceDir)) schemaInsert.run("def", name, "utf8mb4", "utf8mb4_bin");
    if (!currentDatabase) return;
    const tableInsert = database.prepare("INSERT INTO information_schema.TABLES VALUES (?, ?, ?, ?, ?, ?, ?)");
    const columnInsert = database.prepare("INSERT INTO information_schema.COLUMNS VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const indexInsert = database.prepare("INSERT INTO information_schema.STATISTICS VALUES (?, ?, ?, ?, ?, ?, ?)");
    const objects = database.prepare("SELECT name, type FROM main.sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const object of objects) {
      const table = String(object.name); const tableType = String(object.type) === "view" ? "VIEW" : "BASE TABLE";
      tableInsert.run("def", currentDatabase, table, tableType, tableType === "VIEW" ? null : "InnoDB", 0, "utf8mb4_bin");
      const autoIncrement = tableHasAutoIncrement(database, table);
      for (const column of pragmaTableColumns(database, table)) {
        const declared = mysqlDeclaredType(String(column.type || "text"), autoIncrement && Number(column.pk) > 0);
        const dataType = declared.match(/^[a-z]+/i)?.[0]?.toLowerCase() ?? "text";
        const length = declared.match(/\((\d+)/)?.[1];
        const textual = /char|text|json/.test(dataType);
        columnInsert.run("def", currentDatabase, table, String(column.name), Number(column.cid) + 1, column.dflt_value ?? null,
          Number(column.notnull) > 0 || Number(column.pk) > 0 ? "NO" : "YES", dataType, length ? Number(length) : null,
          /int|decimal|numeric|float|double|real/.test(dataType) ? 65 : null, null, declared,
          Number(column.pk) > 0 ? "PRI" : "", autoIncrement && Number(column.pk) > 0 ? "auto_increment" : "",
          textual ? "utf8mb4_bin" : null, textual ? "utf8mb4" : null);
      }
      const primary = pragmaTableColumns(database, table).filter(column => Number(column.pk) > 0);
      for (const column of primary) indexInsert.run(currentDatabase, table, 0, "PRIMARY", Number(column.pk), String(column.name), "A");
      for (const index of pragmaIndexList(database, table)) {
        if (String(index.origin) === "pk") continue;
        for (const column of pragmaIndexColumns(database, String(index.name))) {
          indexInsert.run(currentDatabase, table, Number(index.unique) === 1 ? 0 : 1, String(index.name), Number(column.seqno) + 1, String(column.name), "A");
        }
      }
    }
  }

  private useDatabase(active: ActiveEngine, state: ConnectionState, rawName: string): void {
    const name = unquoteIdentifier(rawName);
    this.validateDatabaseName(name);
    if (!this.databaseExists(active.config.resourceDir, name)) throw mysqlError(1049, `Unknown database '${name}'`);
    if (state.database === name) return;
    try { state.sqlite?.close(); } catch {}
    state.sqlite = undefined;
    state.database = name;
  }

  private openSessionDatabase(active: ActiveEngine, state: ConnectionState): DatabaseSync {
    if (state.sqlite) return state.sqlite;
    const path = state.database ? this.databasePath(active.config.resourceDir, state.database) : ":memory:";
    if (state.database) assertSafeDatabaseFiles(path, true);
    const database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    if (state.database) {
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = NORMAL");
    }
    database.exec("ATTACH DATABASE ':memory:' AS information_schema");
    state.sqlite = database;
    return database;
  }

  private writePreparedHeader(connection: MysqlServerConnection, statementId: number, parameterCount: number): void {
    const payload = Buffer.alloc(12);
    payload.writeUInt8(0, 0);
    payload.writeUInt32LE(statementId, 1);
    payload.writeUInt16LE(0, 5);
    payload.writeUInt16LE(parameterCount, 7);
    payload.writeUInt8(0, 9);
    payload.writeUInt16LE(0, 10);
    connection.writePacket(new WirePacket(payload, "PreparedStatementHeader"));
    if (parameterCount > 0) {
      for (let index = 0; index < parameterCount; index += 1) {
        connection.writePacket(columnDefinitionPacket(mysqlColumn(`parameter_${index + 1}`, 0xfd, "", "", 1024)));
      }
      connection.writeEof(0, 0x0002);
    }
  }

  private requireActive(config: RdsEngineConfig): ActiveEngine {
    const active = this.active;
    if (!active || !samePath(active.config.resourceDir, config.resourceDir, this.platform) || active.config.port !== config.port) {
      throw new RdsEngineProviderError("START_FAILED", "The embedded SQLite RDS listener is not active for this resource.");
    }
    return active;
  }

  private validateConfig(input: RdsEngineConfig): RdsEngineConfig {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.resourceId)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The RDS engine resource identifier is invalid.");
    if (input.databaseName !== undefined) this.validateDatabaseName(input.databaseName);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(input.masterUsername) || /^(?:root|mysql|mariadb|sqlite)$/i.test(input.masterUsername)) {
      throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The RDS master username is invalid or reserved.");
    }
    if (!input.masterPassword || input.masterPassword.length > 1_024) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The RDS master password must be non-empty and no longer than 1024 characters.");
    const parameters = validateProviderParameters(input.parameters ?? {}, false);
    return { ...input, ...this.validateResourceConfig(input), ...(Object.keys(parameters).length ? { parameters } : {}) };
  }

  private validateResourceConfig(input: RdsEngineResourceConfig): RdsEngineResourceConfig {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.resourceId)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The RDS engine resource identifier is invalid.");
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The RDS port must be an integer from 1 through 65535.");
    const resourceDir = resolve(input.resourceDir);
    if (!isDirectChild(this.instancesRoot, resourceDir, this.platform) || basename(resourceDir) !== input.resourceId) {
      throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The RDS resource directory must be a direct child named for its resource identifier.");
    }
    return { resourceId: input.resourceId, resourceDir, port: input.port };
  }

  private validateDatabaseName(name: string): void {
    if (!DATABASE_NAME.test(name)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The RDS database name must begin with a letter and contain at most 64 identifier characters.");
  }

  private databasePath(resourceDir: string, database: string): string {
    this.validateDatabaseName(database);
    return join(resourceDir, "data", `${database}.sqlite`);
  }

  private databaseExists(resourceDir: string, database: string): boolean {
    const names = this.listDatabases(resourceDir);
    return names.some(name => normalizeCase(name, this.platform) === normalizeCase(database, this.platform));
  }

  private listDatabases(resourceDir: string): string[] {
    // Directory reads are intentionally synchronous at the protocol boundary:
    // mysql2's server events require a response before the next packet.
    try {
      return readdirSync(join(resourceDir, "data"), { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(".sqlite"))
        .map(entry => entry.name.slice(0, -".sqlite".length))
        .filter(name => DATABASE_NAME.test(name))
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private createDatabaseFile(resourceDir: string, database: string, failIfUnsafe: boolean): void {
    this.validateDatabaseName(database);
    const path = this.databasePath(resourceDir, database);
    if (failIfUnsafe) assertSafeDatabaseFiles(path, false);
    const connection = new DatabaseSync(path);
    try {
      connection.exec("PRAGMA foreign_keys = ON");
      connection.exec("PRAGMA journal_mode = WAL");
    } finally { connection.close(); }
  }

  private markerMatches(marker: ProviderMarker, config: RdsEngineConfig): boolean {
    return marker.providerName === PROVIDER_NAME && marker.resourceId === config.resourceId && marker.databaseName === config.databaseName && marker.port === config.port;
  }

  private async readMarker(resourceDir: string): Promise<ProviderMarker | undefined> {
    try {
      const path = join(resourceDir, MARKER_FILE);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("unsafe marker");
      const value = JSON.parse(await readFile(path, "utf8")) as Partial<ProviderMarker>;
      if (value.schemaVersion !== 1 || value.providerName !== PROVIDER_NAME || typeof value.resourceId !== "string" || typeof value.port !== "number" || (value.engineVersion !== undefined && typeof value.engineVersion !== "string") || !["initializing", "ready", "failed"].includes(value.state ?? "")) {
        throw new Error("invalid marker");
      }
      return { ...value, engineVersion: value.engineVersion ?? ENGINE_VERSION } as ProviderMarker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The embedded SQLite ownership marker is missing, unsafe, or invalid.");
    }
  }

  private async writeMarker(resourceDir: string, marker: ProviderMarker): Promise<void> {
    const target = join(resourceDir, MARKER_FILE);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { await rename(temporary, target); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  private async prepareRoot(): Promise<void> {
    await mkdir(this.instancesRoot, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.instancesRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The RDS instances root is a link or is not a directory.");
  }

  private async assertSafeResourceDirectory(resourceDir: string, mustExist: boolean): Promise<void> {
    const validated = this.validateResourceConfig({ resourceId: basename(resolve(resourceDir)), resourceDir, port: 1 }).resourceDir;
    let metadata;
    try { metadata = await lstat(validated); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !mustExist) return;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The RDS resource directory is missing.");
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The RDS resource path is a link or is not a directory.");
    const rootReal = await realpath(this.instancesRoot);
    const resourceReal = await realpath(validated);
    if (!isDirectChild(rootReal, resourceReal, this.platform)) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The resolved RDS resource path is outside the configured instances root.");
    for (const childName of ["data", "logs"]) {
      const child = join(validated, childName);
      try {
        const childMetadata = await lstat(child);
        if (childMetadata.isSymbolicLink() || !childMetadata.isDirectory()) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", `The embedded SQLite ${childName} path is unsafe.`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private async removeTombstone(tombstone: string, config: RdsEngineResourceConfig): Promise<void> {
    const metadata = await lstat(tombstone);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new RdsEngineProviderError("DESTROY_REFUSED", "The embedded SQLite deletion tombstone is unsafe.");
    const rootReal = await realpath(this.instancesRoot);
    const tombstoneReal = await realpath(tombstone);
    if (!isDirectChild(rootReal, tombstoneReal, this.platform)) throw new RdsEngineProviderError("DESTROY_REFUSED", "The deletion tombstone resolves outside the instances root.");
    const marker = await this.readMarker(tombstone);
    if (!marker || marker.resourceId !== config.resourceId || marker.port !== config.port) throw new RdsEngineProviderError("DESTROY_REFUSED", "The deletion tombstone does not match the owned resource.");
    try { await rm(tombstone, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 }); }
    catch { throw new RdsEngineProviderError("DESTROY_REFUSED", "The stopped embedded SQLite resource was tombstoned but could not be removed."); }
  }
}

const ACTIVE_OWNERS = new Map<string, EmbeddedSqliteProvider>();
let nextConnectionId = 1;

class WirePacket {
  readonly buffer: Buffer;
  readonly _name: string;

  constructor(payload: Buffer, name: string) {
    this.buffer = Buffer.allocUnsafe(payload.length + 4);
    this.buffer.fill(0, 0, 4);
    payload.copy(this.buffer, 4);
    this._name = name;
  }

  length(): number { return this.buffer.length - 4; }

  writeHeader(sequenceId: number): void {
    const length = this.length();
    this.buffer[0] = length & 0xff;
    this.buffer[1] = (length >>> 8) & 0xff;
    this.buffer[2] = (length >>> 16) & 0xff;
    this.buffer[3] = sequenceId & 0xff;
  }
}

function buildColumns(rows: Record<string, SQLOutputValue>[], metadata: StatementColumnMetadata[] | undefined, sourceSql: string, database?: string): MysqlColumn[] {
  const names = metadata?.map(column => column.name) ?? (rows[0] ? Object.keys(rows[0]) : selectColumnNames(sourceSql));
  return names.map((name, index) => {
    const source = metadata?.[index];
    const sample = rows.find(row => row[name] !== null && row[name] !== undefined)?.[name];
    const type = mysqlType(source?.type, sample);
    return mysqlColumn(name, type, source?.database ?? database ?? "", source?.table ?? "", type === 0x03 ? 11 : 1024);
  });
}

function mysqlColumn(name: string, columnType: number, schema: string, table: string, columnLength: number): MysqlColumn {
  return { catalog: "def", schema, table, orgTable: table, name, orgName: name, characterSet: columnType === 0xfc ? 63 : 45, columnLength, columnType, flags: 0, decimals: columnType === 0x05 ? 31 : 0 };
}

function mysqlType(declared: string | null | undefined, sample: SQLOutputValue | undefined): number {
  const type = declared?.toUpperCase() ?? "";
  if (/\b(?:INT|INTEGER|TINYINT|SMALLINT|MEDIUMINT|BOOLEAN)\b/.test(type)) return 0x03;
  if (/\b(?:REAL|FLOAT|DOUBLE)\b/.test(type)) return 0x05;
  if (/\b(?:BLOB|BINARY)\b/.test(type) || sample instanceof Uint8Array) return 0xfc;
  if (typeof sample === "number") return Number.isInteger(sample) && sample >= -2_147_483_648 && sample <= 2_147_483_647 ? 0x03 : 0x05;
  if (typeof sample === "bigint") return 0x08;
  return 0xfd;
}

function binaryRowPacket(values: unknown[], columns: MysqlColumn[]): WirePacket {
  const nullBytes = Buffer.alloc(Math.floor((columns.length + 7 + 2) / 8));
  const encoded: Buffer[] = [];
  values.forEach((value, index) => {
    if (value === null || value === undefined) {
      nullBytes[Math.floor((index + 2) / 8)] |= 1 << ((index + 2) % 8);
      return;
    }
    const type = columns[index].columnType;
    if (type === 0x03) {
      const buffer = Buffer.allocUnsafe(4); buffer.writeInt32LE(Number(value)); encoded.push(buffer);
    } else if (type === 0x08) {
      const buffer = Buffer.allocUnsafe(8); buffer.writeBigInt64LE(BigInt(value as bigint | number)); encoded.push(buffer);
    } else if (type === 0x05) {
      const buffer = Buffer.allocUnsafe(8); buffer.writeDoubleLE(Number(value)); encoded.push(buffer);
    } else {
      const buffer = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value), "utf8");
      encoded.push(Buffer.concat([lengthEncodedInteger(buffer.length), buffer]));
    }
  });
  return new WirePacket(Buffer.concat([Buffer.from([0]), nullBytes, ...encoded]), "BinaryRow");
}

function textRowPacket(values: unknown[]): WirePacket {
  const encoded = values.map(value => {
    if (value === null || value === undefined) return Buffer.from([0xfb]);
    const buffer = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value), "utf8");
    return Buffer.concat([lengthEncodedInteger(buffer.length), buffer]);
  });
  return new WirePacket(Buffer.concat(encoded), "TextRow");
}

function columnDefinitionPacket(column: MysqlColumn): WirePacket {
  const strings = [column.catalog, column.schema, column.table, column.orgTable, column.name, column.orgName]
    .map(value => { const buffer = Buffer.from(value, "utf8"); return Buffer.concat([lengthEncodedInteger(buffer.length), buffer]); });
  const fixed = Buffer.allocUnsafe(13);
  fixed.writeUInt8(0x0c, 0);
  fixed.writeUInt16LE(column.characterSet, 1);
  fixed.writeUInt32LE(column.columnLength, 3);
  fixed.writeUInt8(column.columnType, 7);
  fixed.writeUInt16LE(column.flags, 8);
  fixed.writeUInt8(column.decimals, 10);
  fixed.writeUInt16LE(0, 11);
  return new WirePacket(Buffer.concat([...strings, fixed]), "ColumnDefinition");
}

function mysqlErrorPacket(code: number, sqlState: string, message: string): WirePacket {
  const safeState = /^[0-9A-Z]{5}$/.test(sqlState) ? sqlState : "HY000";
  const payload = Buffer.concat([
    Buffer.from([0xff, code & 0xff, (code >>> 8) & 0xff, 0x23]),
    Buffer.from(safeState, "ascii"),
    Buffer.from(message.replace(/[\r\n]+/g, " "), "utf8"),
  ]);
  return new WirePacket(payload, "Error");
}

function lengthEncodedInteger(value: number): Buffer {
  if (value < 251) return Buffer.from([value]);
  if (value < 65_536) { const result = Buffer.allocUnsafe(3); result[0] = 0xfc; result.writeUInt16LE(value, 1); return result; }
  const result = Buffer.allocUnsafe(4); result[0] = 0xfd; result[1] = value & 0xff; result[2] = (value >>> 8) & 0xff; result[3] = (value >>> 16) & 0xff; return result;
}

function selectColumnNames(sql: string): string[] {
  const select = sql.match(/^\s*SELECT\s+([\s\S]+?)(?:\s+FROM\s|$)/i)?.[1];
  if (!select) return [];
  return splitSqlList(select).map((expression, index) => {
    const alias = expression.match(/\s+AS\s+(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*$/i)?.[1]
      ?? expression.match(/\s+(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1];
    if (alias) return unquoteIdentifier(alias);
    const identifier = expression.trim().match(/(?:^|\.)(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
    return identifier ? unquoteIdentifier(identifier) : `column_${index + 1}`;
  });
}

function splitSqlList(value: string): string[] {
  const result: string[] = [];
  let start = 0; let depth = 0; let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index + 1] === quote) { index += 1; continue; }
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) { result.push(value.slice(start, index).trim()); start = index + 1; }
  }
  result.push(value.slice(start).trim());
  return result;
}

function countParameters(sql: string): number {
  let count = 0; let quote = "";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      if (character === "\\") { index += 1; continue; }
      if (character === quote && sql[index + 1] === quote) { index += 1; continue; }
      if (character === quote) quote = "";
    } else if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === "?") count += 1;
  }
  return count;
}

function verifyNativePassword(password: string, seed1: Buffer, seed2: Buffer, token: Buffer): boolean {
  const stage1 = sha1(Buffer.from(password));
  const stage2 = sha1(stage1);
  const scramble = sha1(Buffer.concat([seed1.subarray(0, 8), seed2.subarray(0, 12), stage2]));
  const expected = Buffer.allocUnsafe(stage1.length);
  for (let index = 0; index < stage1.length; index += 1) expected[index] = stage1[index] ^ scramble[index];
  return token.length === expected.length && timingSafeEqual(token, expected);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", chunk => hash.update(chunk));
    stream.once("end", resolveHash);
    stream.once("error", rejectHash);
  });
  return hash.digest("hex");
}

function sha1(value: Buffer): Buffer { return createHash("sha1").update(value).digest(); }

function toSqliteValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString().replace("T", " ").replace("Z", "");
  if (typeof value === "boolean") return value ? 1 : 0;
  throw mysqlError(1210, "Incorrect arguments to prepared statement");
}

function mysqlError(code: number, message: string): Error & { mysqlCode: number; sqlState: string } {
  return Object.assign(new Error(message), { mysqlCode: code, sqlState: defaultSqlState(code) });
}

function normalizeMysqlError(error: unknown): { code: number; sqlState: string; message: string } {
  if (error && typeof error === "object" && typeof (error as { mysqlCode?: unknown }).mysqlCode === "number") {
    const failure = error as { mysqlCode: number; sqlState?: string; message?: string };
    return { code: failure.mysqlCode, sqlState: failure.sqlState ?? defaultSqlState(failure.mysqlCode), message: String(failure.message) };
  }
  const message = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ") : "Embedded SQLite query failed";
  const sqliteCode = error && typeof error === "object" ? String((error as { code?: unknown }).code ?? "") : "";
  if (sqliteCode.includes("CONSTRAINT_UNIQUE") || sqliteCode.includes("CONSTRAINT_PRIMARYKEY") || /UNIQUE constraint failed/i.test(message)) return { code: 1062, sqlState: "23000", message: `Duplicate entry violates a unique key` };
  if (sqliteCode.includes("CONSTRAINT_FOREIGNKEY") || /FOREIGN KEY constraint failed/i.test(message)) return { code: 1452, sqlState: "23000", message: "Cannot add or update a child row: a foreign key constraint fails" };
  if (sqliteCode.includes("CONSTRAINT_NOTNULL") || /NOT NULL constraint failed/i.test(message)) return { code: 1048, sqlState: "23000", message };
  if (/no such table: (.+)/i.test(message)) return { code: 1146, sqlState: "42S02", message: `Table '${message.match(/no such table: (.+)/i)?.[1]}' doesn't exist` };
  if (/no such column: (.+)/i.test(message)) return { code: 1054, sqlState: "42S22", message: `Unknown column '${message.match(/no such column: (.+)/i)?.[1]}'` };
  if (/already exists/i.test(message)) return { code: 1050, sqlState: "42S01", message };
  if (/syntax error|near .*syntax/i.test(message)) return { code: 1064, sqlState: "42000", message };
  return { code: 1105, sqlState: "HY000", message };
}

function defaultSqlState(code: number): string {
  if (new Set([1048, 1062, 1451, 1452]).has(code)) return "23000";
  if (code === 1049) return "42000";
  if (code === 1064 || code === 1091 || code === 1142 || code === 1227) return "42000";
  if (code === 1146) return "42S02";
  if (code === 1054) return "42S22";
  return "HY000";
}

function validateProviderParameters(parameters: Record<string, string>, dynamicOnly: boolean): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, supplied] of Object.entries(parameters)) {
    const name = rawName.toLowerCase();
    if (!Object.hasOwn(DEFAULT_PARAMETERS, name) || (dynamicOnly && !DYNAMIC_PARAMETERS.has(name))) throw new RdsEngineProviderError("INVALID_CONFIGURATION", `RDS compatibility variable ${rawName} is not available for this operation.`);
    const value = String(supplied); const numeric = Number(value);
    if (name === "max_connections" && (!/^\d+$/.test(value) || numeric < 10 || numeric > 1_000)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "max_connections must be an integer from 10 through 1000.");
    if (name === "wait_timeout" && (!/^\d+$/.test(value) || numeric < 60 || numeric > 28_800)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "wait_timeout must be an integer from 60 through 28800 seconds.");
    if (name === "max_allowed_packet" && (!/^\d+$/.test(value) || numeric < 1_048_576 || numeric > 67_108_864)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "max_allowed_packet must be an integer from 1048576 through 67108864 bytes.");
    if (name === "innodb_flush_log_at_trx_commit" && !new Set(["0", "1", "2"]).has(value)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "innodb_flush_log_at_trx_commit must be 0, 1, or 2.");
    if (name === "collation_server" && !new Set(["utf8mb4_unicode_ci", "utf8mb4_general_ci"]).has(value)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "collation_server must be an approved utf8mb4 collation.");
    result[name] = value;
  }
  return result;
}

function isDatabaseIndependentPlan(plan: MysqlProfilePlan): boolean {
  if (plan.kind === "showDatabases" || plan.kind === "createDatabase" || plan.kind === "useDatabase" || plan.kind === "set") return true;
  if (plan.kind !== "sqlite") return false;
  return /^\s*(?:SELECT|WITH|EXPLAIN|BEGIN|COMMIT|ROLLBACK)\b/i.test(plan.sql);
}

function pragmaTableColumns(database: DatabaseSync, table: string): Record<string, SQLOutputValue>[] {
  const escaped = table.replace(/'/g, "''");
  return database.prepare(`PRAGMA main.table_xinfo('${escaped}')`).all();
}

function pragmaIndexList(database: DatabaseSync, table: string): Record<string, SQLOutputValue>[] {
  const escaped = table.replace(/'/g, "''");
  return database.prepare(`PRAGMA main.index_list('${escaped}')`).all();
}

function pragmaIndexColumns(database: DatabaseSync, index: string): Record<string, SQLOutputValue>[] {
  const escaped = index.replace(/'/g, "''");
  return database.prepare(`PRAGMA main.index_info('${escaped}')`).all();
}

function tableHasAutoIncrement(database: DatabaseSync, table: string): boolean {
  const row = database.prepare("SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = ?").get(table);
  return typeof row?.sql === "string" && /\bAUTOINCREMENT\b/i.test(row.sql);
}

function mysqlDeclaredType(declared: string, autoIncrement: boolean): string {
  const normalized = declared.trim();
  if (autoIncrement && normalized.toLowerCase() === "integer") return "int";
  if (normalized.toLowerCase() === "integer") return "int";
  return normalized.toUpperCase() || "TEXT";
}

function indexRow(table: string, name: string, column: string, sequence: number, nonUnique: boolean): Record<string, SQLOutputValue> {
  return {
    Table: table,
    Non_unique: nonUnique ? 1 : 0,
    Key_name: name,
    Seq_in_index: sequence,
    Column_name: column,
    Collation: "A",
    Cardinality: 0,
    Sub_part: null,
    Packed: null,
    Null: "",
    Index_type: "BTREE",
    Comment: "",
    Index_comment: "",
    Visible: "YES",
    Expression: null,
  };
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new RdsEngineProviderError("INVALID_CONFIGURATION", `${name} must be a positive duration.`);
  return resolved;
}

function stripTerminator(sql: string): string { return sql.trim().replace(/;\s*$/, "").trim(); }
function unquoteIdentifier(value: string): string { return value.startsWith("`") && value.endsWith("`") ? value.slice(1, -1).replace(/``/g, "`") : value; }
function sqlString(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
function normalizeCase(value: string, platform: NodeJS.Platform): string { return platform === "win32" ? value.toLowerCase() : value; }
function pathKey(value: string, platform: NodeJS.Platform): string { return normalizeCase(resolve(value), platform); }

function isDirectChild(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const normalizedRoot = normalizeCase(resolve(root), platform);
  const normalizedCandidate = normalizeCase(resolve(candidate), platform);
  const child = relative(normalizedRoot, normalizedCandidate);
  return Boolean(child) && child !== ".." && !child.startsWith(`..${sep}`) && !child.includes(sep);
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean { return pathKey(left, platform) === pathKey(right, platform); }
async function pathExists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }

function assertSafeDatabaseFiles(databasePath: string, requireDatabase: boolean): void {
  if (requireDatabase && !existsSync(databasePath)) throw mysqlError(1049, "The selected database no longer exists");
  for (const path of [databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (!existsSync(path)) continue;
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "An embedded SQLite database or journal path is not a regular owned file.");
    }
  }
}

async function listen(server: MysqlServer, port: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    let settled = false;
    const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); server._server.removeListener("error", onError); callback(); };
    const onError = (error: Error) => finish(() => rejectListen(error));
    const timer = setTimeout(() => finish(() => rejectListen(new RdsEngineProviderError("START_FAILED", "The embedded SQLite listener timed out while starting."))), timeoutMs);
    server._server.once("error", onError);
    server.listen(port, LOOPBACK, () => finish(resolveListen));
  });
}

async function closeServer(server: MysqlServer, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; rejectClose(new Error("close timeout")); } }, timeoutMs);
    server.close(error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") rejectClose(error);
      else resolveClose();
    });
  });
}
