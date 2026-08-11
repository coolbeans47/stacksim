import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcessByStdio, type SpawnOptions } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server as NetServer } from "node:net";
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import {
  RdsEngineProviderError,
  type RdsEngineConfig,
  type RdsEngineDiscovery,
  type RdsEngineProvider,
  type RdsEngineResourceConfig,
  type RdsEngineRuntime,
} from "./provider.js";

const PROVIDER_NAME = "managed-mariadb";
const LOOPBACK = "127.0.0.1" as const;
const MARKER_FILE = ".stacksim-rds-mariadb.json";
const CONTROL_KEY_FILE = ".managed-mariadb.key";
const OUTPUT_LIMIT = 16 * 1024;
const MINIMUM_MARIADB_VERSION = [10, 4, 0] as const;
const MASTER_PRIVILEGES = [
  "ALTER", "ALTER ROUTINE", "CREATE", "CREATE ROUTINE", "CREATE TEMPORARY TABLES", "CREATE VIEW",
  "DELETE", "DROP", "EXECUTE", "INDEX", "INSERT", "LOCK TABLES", "REFERENCES", "SELECT", "SHOW VIEW", "TRIGGER", "UPDATE",
].join(", ");
const PROVIDER_PARAMETER_DEFAULTS: Record<string, string> = {
  max_connections: "100",
  wait_timeout: "28800",
  max_allowed_packet: "16777216",
  innodb_flush_log_at_trx_commit: "1",
  collation_server: "utf8mb4_unicode_ci",
};
const DYNAMIC_PROVIDER_PARAMETERS = new Set(["max_connections", "wait_timeout", "max_allowed_packet", "innodb_flush_log_at_trx_commit"]);

type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;
type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ManagedChild;

export interface MariaDbConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
  destroy(): void;
}

export interface MariaDbMysqlModule {
  createConnection(options: Record<string, unknown>): Promise<MariaDbConnection>;
}

export interface ManagedMariaDbProviderOptions {
  /** Only direct children of this directory may be initialized or destroyed. */
  instancesRoot?: string;
  mariadbdPath?: string;
  installDbPath?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnProcess?: SpawnProcess;
  mysqlLoader?: () => Promise<MariaDbMysqlModule>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
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

interface ControlCredential {
  schemaVersion: 1;
  resourceId: string;
  username: string;
  password: string;
}

interface CredentialEnvelope {
  schemaVersion: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  ciphertext: string;
  tag: string;
}

interface ManagedMariaDbDiscovery extends RdsEngineDiscovery {
  mariadbdPath: string;
  installDbPath: string;
}

interface ActiveProcess {
  config: RdsEngineResourceConfig;
  discovery: ManagedMariaDbDiscovery;
  child: ManagedChild;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

/**
 * Runs one private MariaDB process for the development-only RDS profile.
 *
 * The provider never installs a system service, never reads machine-wide option
 * files, and never records the supplied master password. The caller owns the
 * installation-wide singleton lease; this object additionally refuses to run
 * two child processes at once.
 */
export class ManagedMariaDbProvider implements RdsEngineProvider {
  private readonly instancesRoot: string;
  private readonly secretsRoot: string;
  private readonly explicitMariadbdPath?: string;
  private readonly explicitInstallDbPath?: string;
  private readonly startupTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly spawnProcess: SpawnProcess;
  private readonly mysqlLoader: () => Promise<MariaDbMysqlModule>;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private mysqlModule?: Promise<MariaDbMysqlModule>;
  private encryptionKey?: Promise<Buffer>;
  private windowsAclReady?: Promise<void>;
  private active?: ActiveProcess;

  constructor(options: ManagedMariaDbProviderOptions = {}) {
    this.instancesRoot = resolve(options.instancesRoot ?? join(".stacksim", "data", "rds", "instances"));
    this.secretsRoot = join(dirname(this.instancesRoot), "secrets");
    if (this.instancesRoot === parse(this.instancesRoot).root) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The RDS instances root cannot be a filesystem root.");
    this.explicitMariadbdPath = options.mariadbdPath;
    this.explicitInstallDbPath = options.installDbPath;
    this.startupTimeoutMs = positiveDuration(options.startupTimeoutMs, 30_000, "startupTimeoutMs");
    this.stopTimeoutMs = positiveDuration(options.stopTimeoutMs, 10_000, "stopTimeoutMs");
    this.environment = { ...process.env, ...options.environment };
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawnProcess ?? (nodeSpawn as unknown as SpawnProcess);
    this.mysqlLoader = options.mysqlLoader ?? defaultMysqlLoader;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)));
  }

  async discover(): Promise<ManagedMariaDbDiscovery> {
    await this.preparePrivateRoots();
    const configuredServer = this.explicitMariadbdPath ?? this.environment.STACKSIM_RDS_MARIADBD_PATH ?? this.environment.STACKSIM_RDS_MARIADBD;
    const mariadbdPath = await this.findExecutable(configuredServer, this.platform === "win32" ? ["mariadbd.exe", "mysqld.exe"] : ["mariadbd", "mysqld"]);
    if (!mariadbdPath) {
      const diagnostic = configuredServer
        ? "The configured MariaDB server executable cannot be executed."
        : "MariaDB is unavailable. Set STACKSIM_RDS_MARIADBD_PATH or install mariadbd on PATH.";
      throw new RdsEngineProviderError("PROVIDER_NOT_FOUND", diagnostic);
    }

    const configuredInstaller = this.explicitInstallDbPath ?? this.environment.STACKSIM_RDS_INSTALL_DB_PATH ?? this.environment.STACKSIM_RDS_INSTALL_DB;
    const installerNames = this.platform === "win32"
      ? ["mariadb-install-db.exe", "mysql_install_db.exe"]
      : ["mariadb-install-db", "mysql_install_db"];
    const siblingInstaller = configuredInstaller ? undefined : await firstExecutable(installerNames.map(name => join(dirname(mariadbdPath), name)), this.platform);
    const installDbPath = siblingInstaller ?? await this.findExecutable(configuredInstaller, installerNames);
    if (!installDbPath) {
      const diagnostic = configuredInstaller
        ? "The configured MariaDB data-directory initializer cannot be executed."
        : "MariaDB's install-db utility is unavailable. Set STACKSIM_RDS_INSTALL_DB_PATH or place it beside mariadbd/on PATH.";
      throw new RdsEngineProviderError("PROVIDER_NOT_FOUND", diagnostic);
    }

    const versionResult = await this.runCommand(mariadbdPath, ["--version"], Math.min(this.startupTimeoutMs, 5_000));
    const version = `${versionResult.stdout}\n${versionResult.stderr}`.trim().split(/\r?\n/).filter(Boolean).join(" ");
    if (!/MariaDB/i.test(version)) throw new RdsEngineProviderError("PROVIDER_INCOMPATIBLE", "The configured server does not identify itself as MariaDB.");
    const engineVersion = version.match(/(?:Distrib|Ver)\s+(\d+\.\d+\.\d+)/i)?.[1] ?? version.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
    if (!engineVersion) throw new RdsEngineProviderError("PROVIDER_INCOMPATIBLE", "The MariaDB server version could not be determined.");
    if (compareVersion(engineVersion, MINIMUM_MARIADB_VERSION) < 0) {
      throw new RdsEngineProviderError("PROVIDER_INCOMPATIBLE", `MariaDB ${MINIMUM_MARIADB_VERSION.join(".")} or newer is required by the managed bootstrap.`);
    }
    return { providerName: PROVIDER_NAME, mariadbdPath, installDbPath, engineVersion, version };
  }

  async initialize(input: RdsEngineConfig): Promise<void> {
    if (this.active) throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "A MariaDB provider process is already active.");
    const config = this.validateConfig(input);
    await this.preparePrivateRoots();
    const discovery = await this.discover();
    await this.assertSafeResourceDirectory(config.resourceDir, false);

    const marker = await this.readMarker(config.resourceDir);
    if (marker) {
      if (marker.state === "ready" && this.markerMatches(marker, config)) {
        this.assertCompatibleDataVersion(marker.engineVersion, discovery.engineVersion);
        return;
      }
      throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The RDS resource directory contains an incomplete or different MariaDB instance. Destroy it explicitly before retrying.");
    }
    const entries = await readdir(config.resourceDir).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    if (entries.length) throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The RDS resource directory is not empty and has no provider ownership marker.");

    await mkdir(config.resourceDir, { recursive: true, mode: 0o700 });
    await bestEffortChmod(config.resourceDir, 0o700);
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

    const bootstrap = randomCredential("stacksim_bootstrap", config.resourceId);
    const control = randomCredential("stacksim_control", config.resourceId);
    const initFile = join(config.resourceDir, "run", "bootstrap.sql");
    try {
      const dataDir = join(config.resourceDir, "data");
      await mkdir(join(config.resourceDir, "logs"), { recursive: true, mode: 0o700 });
      await mkdir(join(config.resourceDir, "run"), { recursive: true, mode: 0o700 });
      await mkdir(join(config.resourceDir, "secure-files"), { recursive: true, mode: 0o700 });
      await this.initializeDataDirectory(discovery, dataDir, config.port, config);
      await this.assertSafeResourceDirectory(config.resourceDir, true);
      await this.writeControlCredential(control);
      await this.writeBootstrapInitFile(initFile, bootstrap, control);
      await this.launch(config, discovery, initFile);
      const bootstrapConnection = await this.waitForConnection(config, { user: bootstrap.username, password: bootstrap.password }, true);
      await safeUnlink(initFile);
      try { await this.bootstrapDatabase(bootstrapConnection, config, bootstrap); }
      finally { await closeConnection(bootstrapConnection); }
      await this.waitForConnection(config, {
        user: config.masterUsername,
        password: config.masterPassword,
        database: config.databaseName,
      }, false).then(closeConnection);
      await this.probeOwnedInstance(config, control).then(closeConnection);
      await this.stop();
      await this.redactProviderLog(config, [bootstrap.password, control.password, config.masterPassword]);
      await this.writeMarker(config.resourceDir, { ...initializing, state: "ready" });
    } catch (error) {
      let cleanupError: unknown;
      try { await this.stop(); } catch (stopError) { cleanupError = stopError; }
      if (!this.active) {
        await safeUnlink(initFile);
        await this.redactProviderLog(config, [bootstrap.password, control.password, config.masterPassword]);
      }
      const failureCode = error instanceof RdsEngineProviderError ? error.code : "INITIALIZATION_FAILED";
      try { await this.writeMarker(config.resourceDir, { ...initializing, state: "failed", failureCode }); } catch {}
      if (cleanupError instanceof Error) throw cleanupError;
      if (error instanceof RdsEngineProviderError) throw error;
      throw new RdsEngineProviderError("INITIALIZATION_FAILED", "MariaDB initialization failed. Inspect the private provider log for details.");
    }
  }

  async start(input: RdsEngineConfig): Promise<RdsEngineRuntime> {
    const config = this.validateConfig(input);
    await this.preparePrivateRoots();
    await this.assertSafeResourceDirectory(config.resourceDir, true);
    const marker = await this.readMarker(config.resourceDir);
    if (!marker || marker.state !== "ready" || !this.markerMatches(marker, config)) throw new RdsEngineProviderError("START_FAILED", "The MariaDB resource is not initialized for this RDS instance.");

    if (this.active) {
      if (!samePath(this.active.config.resourceDir, config.resourceDir, this.platform) || this.active.config.port !== config.port) {
        throw new RdsEngineProviderError("START_FAILED", "A different MariaDB resource is already active in this simulator process.");
      }
      const current = await this.readiness(config);
      if (current.ready) return current;
      throw new RdsEngineProviderError("START_FAILED", current.diagnostic ?? "MariaDB is running but not ready.");
    }

    const discovery = await this.discover();
    this.assertCompatibleDataVersion(marker.engineVersion, discovery.engineVersion);
    try {
      const control = await this.readControlCredential(config.resourceId);
      await this.recoverOwnedOrphan(config, control);
      await this.launch(config, discovery);
      const connection = await this.waitForConnection(config, {
        user: config.masterUsername,
        password: config.masterPassword,
        database: config.databaseName,
      }, false);
      await closeConnection(connection);
      const runtime = await this.readiness(config);
      if (!runtime.ready) throw new RdsEngineProviderError("START_FAILED", runtime.diagnostic ?? "MariaDB did not pass its readiness query.");
      return runtime;
    } catch (error) {
      try { await this.terminateFailedStart(); }
      catch (cleanupError) { throw cleanupError; }
      if (error instanceof RdsEngineProviderError) throw error;
      throw new RdsEngineProviderError("START_FAILED", "MariaDB failed to start. Inspect the private provider log for details.");
    }
  }

  async readiness(input: RdsEngineConfig): Promise<RdsEngineRuntime> {
    const config = this.validateConfig(input);
    await this.preparePrivateRoots();
    await this.assertSafeResourceDirectory(config.resourceDir, true);
    const marker = await this.readMarker(config.resourceDir);
    const base: RdsEngineRuntime = {
      providerName: PROVIDER_NAME,
      resourceId: config.resourceId,
      resourceDir: config.resourceDir,
      endpoint: { address: LOOPBACK, port: config.port },
      engineVersion: marker?.engineVersion ?? "unknown",
      pid: this.active?.child.pid,
      ready: false,
    };
    const active = this.active;
    if (!active || !samePath(active.config.resourceDir, config.resourceDir, this.platform)) return { ...base, diagnostic: "MariaDB is not running for this RDS resource." };
    if (active.spawnError) return { ...base, diagnostic: "The MariaDB process could not be launched." };
    if (hasExited(active.child)) return { ...base, diagnostic: "The MariaDB process exited before readiness completed." };

    let connection: MariaDbConnection | undefined;
    try {
      const control = await this.readControlCredential(config.resourceId);
      await this.probeOwnedInstance(config, control).then(closeConnection);
      connection = await this.createConnection(config, {
        user: config.masterUsername,
        password: config.masterPassword,
        database: config.databaseName,
      }, Math.min(1_500, this.startupTimeoutMs));
      const [rows] = await connection.query("SELECT VERSION() AS engineVersion, DATABASE() AS databaseName");
      const first = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
      return { ...base, engineVersion: String(first?.engineVersion ?? base.engineVersion), ready: true, diagnostic: undefined };
    } catch (error) {
      return { ...base, diagnostic: connectionDiagnostic(error) };
    } finally {
      if (connection) await closeConnection(connection);
    }
  }

  async rotateMasterPassword(input: RdsEngineConfig, nextPassword: string): Promise<void> {
    const config = this.validateConfig(input);
    if (!nextPassword || nextPassword.length > 1_024) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The replacement MariaDB master password is invalid.");
    const connection = await this.createConnection(config, { user: config.masterUsername, password: config.masterPassword, database: config.databaseName }, Math.min(1_500, this.startupTimeoutMs));
    try {
      await connection.query("SET PASSWORD = PASSWORD(?)", [nextPassword]);
      const verification = await this.createConnection(config, { user: config.masterUsername, password: nextPassword, database: config.databaseName }, Math.min(1_500, this.startupTimeoutMs));
      await verification.query("SELECT 1 AS ready");
      await closeConnection(verification);
    } catch (error) {
      try { await connection.query("SET PASSWORD = PASSWORD(?)", [config.masterPassword]); } catch {}
      throw error instanceof RdsEngineProviderError ? error : new RdsEngineProviderError("AUTHENTICATION_FAILED", "The MariaDB master password could not be rotated safely.");
    } finally { await closeConnection(connection); }
  }

  async applyParameters(input: RdsEngineConfig, parameters: Record<string, string>): Promise<void> {
    const config = this.validateConfig(input);
    const validated = validateProviderParameters(parameters, true);
    if (!Object.keys(validated).length) return;
    const next = this.validateConfig({ ...config, parameters: { ...(config.parameters ?? {}), ...validated } });
    try {
      await this.stop(); await this.start(next);
    } catch (error) {
      try { await this.stop(); await this.start(config); } catch { throw new RdsEngineProviderError("START_FAILED", "The MariaDB parameter update and rollback both failed; provider ownership was retained."); }
      throw error instanceof RdsEngineProviderError ? error : new RdsEngineProviderError("INVALID_CONFIGURATION", "The MariaDB parameter update could not be applied safely.");
    }
  }

  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (hasExited(active.child)) {
      await safeUnlink(join(active.config.resourceDir, "run", "mariadbd.pid"));
      this.active = undefined;
      return;
    }

    let shutdown: MariaDbConnection | undefined;
    let sqlShutdownRequested = false;
    try {
      const control = await this.readControlCredential(active.config.resourceId);
      shutdown = await this.probeOwnedInstance(active.config, control);
      try { await shutdown.query("SHUTDOWN"); sqlShutdownRequested = true; }
      catch (error) {
        /* A transport close is the normal successful SHUTDOWN response. */
        sqlShutdownRequested = !errorCode(error).startsWith("ER_");
      }
    } catch { /* The exact retained child handle may be stopped safely even if SQL control authentication is unavailable. */ }
    finally { shutdown?.destroy(); }

    if (!await waitForExit(active.child, sqlShutdownRequested ? this.stopTimeoutMs : 0)) {
      active.child.kill("SIGTERM");
      if (!await waitForExit(active.child, Math.min(2_000, this.stopTimeoutMs))) {
        active.child.kill("SIGKILL");
        if (!await waitForExit(active.child, 2_000)) throw new RdsEngineProviderError("STOP_FAILED", "The managed MariaDB process did not stop within the configured timeout.");
      }
    }
    await safeUnlink(join(active.config.resourceDir, "run", "mariadbd.pid"));
    this.active = undefined;
  }

  async reconfigure(currentInput: RdsEngineConfig, nextInput: RdsEngineConfig): Promise<void> {
    if (this.active) throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The MariaDB provider must be stopped before its listener configuration changes.");
    const current = this.validateConfig(currentInput); const next = this.validateConfig(nextInput);
    if (current.resourceId !== next.resourceId || !samePath(current.resourceDir, next.resourceDir, this.platform) || current.databaseName !== next.databaseName || current.masterUsername !== next.masterUsername) {
      throw new RdsEngineProviderError("INVALID_CONFIGURATION", "Only the owned MariaDB listener port and safe parameter values can be reconfigured.");
    }
    await this.assertSafeResourceDirectory(current.resourceDir, true);
    const marker = await this.readMarker(current.resourceDir);
    if (!marker || marker.state !== "ready" || !this.markerMatches(marker, current)) throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The MariaDB ownership marker does not match the current configuration.");
    await this.writeMarker(current.resourceDir, { ...marker, port: next.port });
  }

  async destroy(input: RdsEngineResourceConfig): Promise<void> {
    const config = this.validateResourceConfig(input);
    await this.preparePrivateRoots();
    const tombstone = join(this.instancesRoot, `${config.resourceId}.deleting`);
    await this.assertSafeResourceDirectory(config.resourceDir, false);
    if (!await pathExists(config.resourceDir)) {
      if (await pathExists(tombstone)) await this.removeValidatedTombstone(tombstone, config);
      await safeUnlink(this.controlCredentialPath(config.resourceId));
      return;
    }
    if (await pathExists(tombstone)) throw new RdsEngineProviderError("DESTROY_REFUSED", "Both the active and deleting MariaDB resource directories exist; cleanup was retained for inspection.");
    await this.assertSafeResourceDirectory(config.resourceDir, true);
    const safeDirectory = config.resourceDir;
    if (this.active && !samePath(this.active.config.resourceDir, safeDirectory, process.platform)) throw new RdsEngineProviderError("DESTROY_REFUSED", "A different managed MariaDB resource is active.");
    let metadata;
    try { metadata = await lstat(safeDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new RdsEngineProviderError("DESTROY_REFUSED", "The RDS resource path is not an owned directory.");

    const rootReal = await realpath(this.instancesRoot);
    const resourceReal = await realpath(safeDirectory);
    if (!isDirectChild(rootReal, resourceReal, process.platform)) throw new RdsEngineProviderError("DESTROY_REFUSED", "The resolved RDS resource path is outside the configured instances root.");
    const marker = await this.readMarker(safeDirectory);
    if (!marker || marker.providerName !== PROVIDER_NAME || marker.resourceId !== config.resourceId) {
      throw new RdsEngineProviderError("DESTROY_REFUSED", "The directory does not contain a valid managed-MariaDB ownership marker.");
    }
    if (marker.port !== config.port) throw new RdsEngineProviderError("DESTROY_REFUSED", "The ownership marker does not match the requested MariaDB port.");

    if (this.active) await this.stop();
    if (!await this.resourceIsQuiescent(config.resourceDir, config.port)) {
      const control = await this.readControlCredential(config.resourceId);
      await this.recoverOwnedOrphan(config, control);
    }
    if (!await this.resourceIsQuiescent(config.resourceDir, config.port)) {
      throw new RdsEngineProviderError("DESTROY_REFUSED", "MariaDB shutdown could not be confirmed; the resource directory was retained.");
    }
    await this.assertSafeResourceDirectory(config.resourceDir, true);
    await rename(safeDirectory, tombstone);
    await this.removeValidatedTombstone(tombstone, config);
    await safeUnlink(this.controlCredentialPath(config.resourceId));
  }

  private async initializeDataDirectory(discovery: ManagedMariaDbDiscovery, dataDir: string, port: number, config: RdsEngineConfig): Promise<void> {
    const args = this.platform === "win32"
      ? [`--datadir=${dataDir}`, `--port=${port}`, "--silent"]
      : ["--no-defaults", `--basedir=${dirname(dirname(discovery.mariadbdPath))}`, `--datadir=${dataDir}`, "--auth-root-authentication-method=normal", "--skip-test-db"];
    try { await this.runCommand(discovery.installDbPath, args, this.startupTimeoutMs); }
    catch (error) {
      if (error instanceof RdsEngineProviderError) throw new RdsEngineProviderError("INITIALIZATION_FAILED", this.redact(error.message, config));
      throw error;
    }
  }

  private async bootstrapDatabase(connection: MariaDbConnection, config: RdsEngineConfig, bootstrap: ControlCredential): Promise<void> {
    try {
      if (config.databaseName) await connection.query("CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", [config.databaseName]);
      await connection.query("DROP USER IF EXISTS ?@?", [config.masterUsername, LOOPBACK]);
      await connection.query("CREATE USER ?@? IDENTIFIED BY ?", [config.masterUsername, LOOPBACK, config.masterPassword]);
      await connection.query(`GRANT ${MASTER_PRIVILEGES} ON *.* TO ?@?`, [config.masterUsername, LOOPBACK]);
      await connection.query("DROP USER ?@?", [bootstrap.username, LOOPBACK]);
    } catch {
      throw new RdsEngineProviderError("INITIALIZATION_FAILED", "MariaDB database and credential bootstrap failed.");
    }
  }

  private async launch(config: RdsEngineResourceConfig, discovery: ManagedMariaDbDiscovery, initFile?: string): Promise<void> {
    await this.assertSafeResourceDirectory(config.resourceDir, true);
    await assertPortAvailable(config.port);
    const dataDir = join(config.resourceDir, "data");
    const runDir = join(config.resourceDir, "run");
    const logsDir = join(config.resourceDir, "logs");
    const secureFilesDir = join(config.resourceDir, "secure-files");
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await mkdir(logsDir, { recursive: true, mode: 0o700 });
    await mkdir(secureFilesDir, { recursive: true, mode: 0o700 });
    await this.assertSafeResourceDirectory(config.resourceDir, true);
    await assertSafeOutputPath(join(logsDir, "mariadb.log"), "provider log");
    if (this.platform !== "win32") await assertSafeOutputPath(join(runDir, "mariadb.sock"), "local socket", true);
    const args = [
      "--no-defaults",
      `--datadir=${dataDir}`,
      `--port=${config.port}`,
      `--bind-address=${LOOPBACK}`,
      "--skip-name-resolve",
      `--pid-file=${join(runDir, "mariadbd.pid")}`,
      `--log-error=${join(logsDir, "mariadb.log")}`,
      `--secure-file-priv=${secureFilesDir}`,
      "--local-infile=0",
      "--skip-symbolic-links",
      "--character-set-server=utf8mb4",
      "--default-storage-engine=InnoDB",
      "--skip-log-bin",
      ...providerParameterArguments((config as RdsEngineConfig).parameters),
    ];
    if (this.platform !== "win32") args.push(`--socket=${join(runDir, "mariadb.sock")}`);
    if (initFile) args.push(`--init-file=${initFile}`);
    const child = this.spawnProcess(discovery.mariadbdPath, args, {
      cwd: config.resourceDir,
      env: this.environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const active: ActiveProcess = { config: { resourceId: config.resourceId, resourceDir: config.resourceDir, port: config.port }, discovery, child, stdout: "", stderr: "" };
    this.active = active;
    child.stdout.on("data", chunk => { active.stdout = appendBounded(active.stdout, chunk); });
    child.stderr.on("data", chunk => { active.stderr = appendBounded(active.stderr, chunk); });
    child.once("error", error => { active.spawnError = errorCode(error); });
  }

  private async waitForConnection(
    config: RdsEngineConfig,
    credentials: { user: string; password: string; database?: string },
    bootstrap: boolean,
  ): Promise<MariaDbConnection> {
    const deadline = this.now() + this.startupTimeoutMs;
    let lastError: unknown;
    while (this.now() < deadline) {
      const active = this.active;
      if (!active || active.spawnError || hasExited(active.child)) {
        throw new RdsEngineProviderError("START_FAILED", "MariaDB exited before readiness. Inspect the private redacted provider log for details.");
      }
      try {
        const connection = await this.createConnection(config, credentials, Math.min(1_000, Math.max(100, deadline - this.now())));
        await connection.query("SELECT 1 AS ready");
        return connection;
      } catch (error) {
        lastError = error;
        const code = errorCode(error);
        if (code === "ER_ACCESS_DENIED_ERROR" || code === "1045") {
          throw new RdsEngineProviderError("AUTHENTICATION_FAILED", bootstrap
            ? "MariaDB's bootstrap account is incompatible with managed initialization."
            : "MariaDB rejected the configured master credentials.");
        }
        if (code === "ER_BAD_DB_ERROR" || code === "1049") throw new RdsEngineProviderError("START_FAILED", "The configured MariaDB database is unavailable.");
        await this.sleep(100);
      }
    }
    throw new RdsEngineProviderError("START_FAILED", `MariaDB did not become ready within ${this.startupTimeoutMs}ms. ${connectionDiagnostic(lastError)}`);
  }

  private async createConnection(
    config: RdsEngineResourceConfig,
    credentials: { user: string; password: string; database?: string },
    connectTimeout: number,
  ): Promise<MariaDbConnection> {
    const mysql = await this.loadMysql();
    return mysql.createConnection({
      host: LOOPBACK,
      port: config.port,
      user: credentials.user,
      password: credentials.password,
      ...(credentials.database ? { database: credentials.database } : {}),
      connectTimeout,
      enableKeepAlive: true,
      multipleStatements: false,
    });
  }

  private loadMysql(): Promise<MariaDbMysqlModule> {
    return this.mysqlModule ??= this.mysqlLoader().catch(() => {
      throw new RdsEngineProviderError("MYSQL_DRIVER_MISSING", "The mysql2 package is required by the managed MariaDB provider.");
    });
  }

  private async terminateFailedStart(): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (!hasExited(active.child)) {
      active.child.kill("SIGTERM");
      if (!await waitForExit(active.child, 1_000)) {
        active.child.kill("SIGKILL");
        if (!await waitForExit(active.child, 2_000)) throw new RdsEngineProviderError("STOP_FAILED", "The failed MariaDB child process did not exit; provider ownership was retained.");
      }
    }
    await safeUnlink(join(active.config.resourceDir, "run", "mariadbd.pid"));
    this.active = undefined;
  }

  private async resourceIsQuiescent(resourceDir: string, port: number): Promise<boolean> {
    const pidPath = join(resourceDir, "run", "mariadbd.pid");
    for (let check = 0; check < 2; check += 1) {
      if (!await isPortAvailable(port) || await pathExists(pidPath)) return false;
      if (check === 0) await this.sleep(100);
    }
    return true;
  }

  private async removeValidatedTombstone(tombstone: string, config: RdsEngineResourceConfig): Promise<void> {
    const metadata = await lstat(tombstone);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new RdsEngineProviderError("DESTROY_REFUSED", "The MariaDB deletion tombstone is not a safe directory.");
    const rootReal = await realpath(this.instancesRoot);
    const tombstoneReal = await realpath(tombstone);
    if (!isDirectChild(rootReal, tombstoneReal, process.platform)) throw new RdsEngineProviderError("DESTROY_REFUSED", "The MariaDB deletion tombstone resolves outside the instances root.");
    const marker = await this.readMarker(tombstone);
    if (!marker || marker.providerName !== PROVIDER_NAME || marker.resourceId !== config.resourceId || marker.port !== config.port) {
      throw new RdsEngineProviderError("DESTROY_REFUSED", "The MariaDB deletion tombstone does not match the owned resource.");
    }
    if (!await this.resourceIsQuiescent(tombstone, config.port)) throw new RdsEngineProviderError("DESTROY_REFUSED", "The tombstoned MariaDB resource may still be running; its files were retained.");
    try { await rm(tombstone, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 }); }
    catch { throw new RdsEngineProviderError("DESTROY_REFUSED", "The stopped MariaDB resource was tombstoned but could not be removed; deletion can be retried safely."); }
  }

  private assertCompatibleDataVersion(initialized: string, configured: string): void {
    if (!sameMajorMinor(initialized, configured)) {
      throw new RdsEngineProviderError("PROVIDER_INCOMPATIBLE", `The data directory was initialized by MariaDB ${initialized}; configure a compatible ${majorMinor(initialized)}.x server before starting it.`);
    }
  }

  private validateConfig(input: RdsEngineConfig): RdsEngineConfig {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.resourceId)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The RDS engine resource identifier is invalid.");
    if (input.databaseName !== undefined && !/^[A-Za-z][A-Za-z0-9_$]{0,63}$/.test(input.databaseName)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The MariaDB database name must begin with a letter and contain at most 64 identifier characters.");
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(input.masterUsername) || /^(?:root|mysql|mariadb)$/i.test(input.masterUsername)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The MariaDB master username is invalid or reserved.");
    if (!input.masterPassword || input.masterPassword.length > 1_024) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The MariaDB master password must be non-empty and no longer than 1024 characters.");
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The MariaDB port must be an integer from 1 through 65535.");
    const parameters = validateProviderParameters(input.parameters ?? {}, false);
    return { ...input, ...this.validateResourceConfig(input), ...(Object.keys(parameters).length ? { parameters } : {}) };
  }

  private validateResourceConfig(input: RdsEngineResourceConfig): RdsEngineResourceConfig {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.resourceId)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The RDS engine resource identifier is invalid.");
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "The MariaDB port must be an integer from 1 through 65535.");
    const resourceDir = this.validateResourceDirectory(input.resourceDir);
    if (basename(resourceDir) !== input.resourceId) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The RDS resource directory name must equal its resource identifier.");
    return { resourceId: input.resourceId, resourceDir, port: input.port };
  }

  private validateResourceDirectory(value: string): string {
    const directory = resolve(value);
    if (!isDirectChild(this.instancesRoot, directory, process.platform)) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The RDS resource directory must be a direct child of the configured instances root.");
    return directory;
  }

  private markerMatches(marker: ProviderMarker, config: RdsEngineConfig): boolean {
    return marker.providerName === PROVIDER_NAME
      && marker.resourceId === config.resourceId
      && marker.databaseName === config.databaseName
      && marker.port === config.port;
  }

  private async readMarker(resourceDir: string): Promise<ProviderMarker | undefined> {
    try {
      const markerPath = join(resourceDir, MARKER_FILE);
      const metadata = await lstat(markerPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The MariaDB provider ownership marker is unsafe.");
      const value = JSON.parse(await readFile(markerPath, "utf8")) as Partial<ProviderMarker>;
      if (value.schemaVersion !== 1 || value.providerName !== PROVIDER_NAME || typeof value.resourceId !== "string" || (value.databaseName !== undefined && typeof value.databaseName !== "string") || typeof value.port !== "number" || typeof value.engineVersion !== "string" || !["initializing", "ready", "failed"].includes(value.state ?? "")) {
        throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The MariaDB provider ownership marker is invalid.");
      }
      return value as ProviderMarker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof RdsEngineProviderError) throw error;
      throw new RdsEngineProviderError("INITIALIZATION_CONFLICT", "The MariaDB provider ownership marker cannot be read.");
    }
  }

  private async writeMarker(resourceDir: string, marker: ProviderMarker): Promise<void> {
    const target = join(resourceDir, MARKER_FILE);
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The MariaDB ownership marker path is unsafe.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally { await safeUnlink(temporary); }
    await bestEffortChmod(target, 0o600);
  }

  private async preparePrivateRoots(): Promise<void> {
    const rdsRoot = dirname(this.instancesRoot);
    for (const directory of [rdsRoot, this.instancesRoot, this.secretsRoot]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "An RDS provider data directory is a link or is not a directory.");
      await bestEffortChmod(directory, 0o700);
    }
    const rdsReal = await realpath(rdsRoot);
    for (const directory of [this.instancesRoot, this.secretsRoot]) {
      const childReal = await realpath(directory);
      if (!isDirectChild(rdsReal, childReal, process.platform)) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "An RDS provider data directory resolves outside the RDS data root.");
    }
    if (this.platform === "win32") await (this.windowsAclReady ??= this.protectWindowsPrivateRoot(rdsRoot));
  }

  private async protectWindowsPrivateRoot(rdsRoot: string): Promise<void> {
    try {
      const identity = await this.runCommand("whoami.exe", ["/user", "/fo", "csv", "/nh"], Math.min(this.startupTimeoutMs, 5_000));
      const sid = identity.stdout.match(/"S-(?:\d+-)+\d+"/)?.[0]?.slice(1, -1);
      if (!sid) throw new Error("missing current-user SID");
      await this.runCommand("icacls.exe", [rdsRoot, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "/Q"], Math.min(this.startupTimeoutMs, 10_000));
      for (const child of [this.instancesRoot, this.secretsRoot]) {
        await this.runCommand("icacls.exe", [child, "/reset", "/T", "/Q"], Math.min(this.startupTimeoutMs, 10_000));
      }
    } catch {
      throw new RdsEngineProviderError("CREDENTIAL_UNAVAILABLE", "Owner-only Windows permissions could not be applied to the local RDS data root.");
    }
  }

  private async assertSafeResourceDirectory(resourceDir: string, mustExist: boolean): Promise<void> {
    const directory = this.validateResourceDirectory(resourceDir);
    const rootMetadata = await lstat(this.instancesRoot);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The RDS instances root is a link or is not a directory.");
    let metadata;
    try { metadata = await lstat(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !mustExist) return;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The RDS resource directory is missing.");
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The RDS resource directory is a link or is not a directory.");
    const rootReal = await realpath(this.instancesRoot);
    const resourceReal = await realpath(directory);
    if (!isDirectChild(rootReal, resourceReal, process.platform)) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The RDS resource directory resolves outside the configured instances root.");
    for (const name of ["data", "run", "logs", "secure-files"]) {
      const child = join(directory, name);
      try {
        const childMetadata = await lstat(child);
        if (childMetadata.isSymbolicLink() || !childMetadata.isDirectory()) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", `The MariaDB ${name} path is a link or is not a directory.`);
        const childReal = await realpath(child);
        if (!isDirectChild(resourceReal, childReal, process.platform)) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", `The MariaDB ${name} path resolves outside its resource directory.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const pidPath = join(directory, "run", "mariadbd.pid");
    try {
      const pidMetadata = await lstat(pidPath);
      if (pidMetadata.isSymbolicLink() || !pidMetadata.isFile()) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The MariaDB pid-file path is unsafe.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private async writeBootstrapInitFile(path: string, bootstrap: ControlCredential, control: ControlCredential): Promise<void> {
    const bootstrapAccount = `${sqlLiteral(bootstrap.username)}@${sqlLiteral(LOOPBACK)}`;
    const controlAccount = `${sqlLiteral(control.username)}@${sqlLiteral(LOOPBACK)}`;
    const statements = [
      `CREATE USER ${bootstrapAccount} IDENTIFIED BY ${sqlLiteral(bootstrap.password)};`,
      `GRANT ALL PRIVILEGES ON *.* TO ${bootstrapAccount} WITH GRANT OPTION;`,
      `CREATE USER ${controlAccount} IDENTIFIED BY ${sqlLiteral(control.password)};`,
      `GRANT SHUTDOWN ON *.* TO ${controlAccount};`,
      "DELETE FROM mysql.global_priv WHERE User = 'root' OR User = '';",
      "FLUSH PRIVILEGES;",
    ];
    await writeFile(path, `${statements.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await bestEffortChmod(path, 0o600);
  }

  private async redactProviderLog(config: RdsEngineResourceConfig, secrets: string[]): Promise<void> {
    const logPath = join(config.resourceDir, "logs", "mariadb.log");
    try {
      const metadata = await lstat(logPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "The MariaDB provider log path is unsafe.");
      let content = await readFile(logPath, "utf8");
      for (const secret of secrets) if (secret) content = content.split(secret).join("<redacted>");
      const temporary = `${logPath}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, logPath);
      await bestEffortChmod(logPath, 0o600);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private controlCredentialPath(resourceId: string): string { return join(this.secretsRoot, `${resourceId}.control.enc`); }

  private async credentialKey(): Promise<Buffer> {
    return this.encryptionKey ??= (async () => {
      await this.preparePrivateRoots();
      const keyPath = join(this.secretsRoot, CONTROL_KEY_FILE);
      try {
        const metadata = await lstat(keyPath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) throw new RdsEngineProviderError("CREDENTIAL_UNAVAILABLE", "The MariaDB credential key is not a private regular file.");
        const existing = await readFile(keyPath);
        if (existing.length !== 32) throw new RdsEngineProviderError("CREDENTIAL_UNAVAILABLE", "The MariaDB credential key is invalid.");
        return existing;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const generated = randomBytes(32);
      try { await writeFile(keyPath, generated, { mode: 0o600, flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; return this.credentialKeyAfterRace(keyPath); }
      await bestEffortChmod(keyPath, 0o600);
      return generated;
    })();
  }

  private async credentialKeyAfterRace(keyPath: string): Promise<Buffer> {
    const key = await readFile(keyPath);
    if (key.length !== 32) throw new RdsEngineProviderError("CREDENTIAL_UNAVAILABLE", "The MariaDB credential key is invalid.");
    return key;
  }

  private async writeControlCredential(credential: ControlCredential): Promise<void> {
    const key = await this.credentialKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(credential.resourceId, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential), "utf8"), cipher.final()]);
    const envelope: CredentialEnvelope = { schemaVersion: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
    const target = this.controlCredentialPath(credential.resourceId);
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new RdsEngineProviderError("CREDENTIAL_UNAVAILABLE", "The MariaDB control credential path is unsafe.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    await bestEffortChmod(target, 0o600);
  }

  private async readControlCredential(resourceId: string): Promise<ControlCredential> {
    try {
      const target = this.controlCredentialPath(resourceId);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("unsafe credential file");
      const envelope = JSON.parse(await readFile(target, "utf8")) as CredentialEnvelope;
      if (envelope.schemaVersion !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("invalid credential envelope");
      const decipher = createDecipheriv("aes-256-gcm", await this.credentialKey(), Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(Buffer.from(resourceId, "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const credential = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8")) as ControlCredential;
      if (credential.schemaVersion !== 1 || credential.resourceId !== resourceId || !/^stacksim_control_[a-f0-9]+$/.test(credential.username) || !credential.password) throw new Error("invalid credential payload");
      return credential;
    } catch {
      throw new RdsEngineProviderError("CREDENTIAL_UNAVAILABLE", "The private MariaDB control credential is missing, unsafe, or unreadable.");
    }
  }

  private async probeOwnedInstance(config: RdsEngineResourceConfig, control: ControlCredential): Promise<MariaDbConnection> {
    let connection: MariaDbConnection | undefined;
    try { connection = await this.createConnection(config, { user: control.username, password: control.password }, Math.min(1_500, this.startupTimeoutMs)); }
    catch (error) { throw error; }
    try {
      const [rows] = await connection.query("SELECT @@datadir AS dataDir, @@pid_file AS pidFile, @@port AS port");
      const row = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
      if (!row) throw new Error("missing identity row");
      const expectedData = await realpath(join(config.resourceDir, "data"));
      const expectedPid = await realpath(join(config.resourceDir, "run", "mariadbd.pid"));
      const actualData = await realpath(resolve(String(row.dataDir)));
      const actualPid = await realpath(resolve(String(row.pidFile)));
      if (!samePath(expectedData, actualData, process.platform) || !samePath(expectedPid, actualPid, process.platform) || Number(row.port) !== config.port) throw new Error("identity mismatch");
      return connection;
    } catch (error) {
      connection?.destroy();
      if (error instanceof RdsEngineProviderError) throw error;
      throw new RdsEngineProviderError("ORPHAN_UNCERTAIN", "The MariaDB listener could not be authenticated as the exact owned datadir, pid file, and port.");
    }
  }

  private async recoverOwnedOrphan(config: RdsEngineResourceConfig, control: ControlCredential): Promise<void> {
    if (await isPortAvailable(config.port)) {
      if (!await pathExists(join(config.resourceDir, "run", "mariadbd.pid"))) return;
      throw new RdsEngineProviderError("ORPHAN_UNCERTAIN", "A MariaDB pid file remains without an authenticated listener; the resource was retained.");
    }
    let connection: MariaDbConnection | undefined;
    try {
      connection = await this.probeOwnedInstance(config, control);
      try { await connection.query("SHUTDOWN"); } catch { /* Expected disconnect on successful shutdown. */ }
    } catch (error) {
      throw error instanceof RdsEngineProviderError ? error : new RdsEngineProviderError("ORPHAN_UNCERTAIN", "An occupied MariaDB port could not be safely adopted.");
    } finally { connection?.destroy(); }
    const deadline = this.now() + this.stopTimeoutMs;
    while (this.now() < deadline) {
      if (await isPortAvailable(config.port) && !await pathExists(join(config.resourceDir, "run", "mariadbd.pid"))) return;
      await this.sleep(100);
    }
    throw new RdsEngineProviderError("ORPHAN_UNCERTAIN", "The authenticated orphan did not shut down cleanly; ownership was retained.");
  }

  private redact(value: string, config: RdsEngineConfig): string {
    let redacted = value;
    for (const secret of [config.masterPassword, config.resourceDir, this.instancesRoot, this.explicitMariadbdPath, this.explicitInstallDbPath, environmentValue(this.environment, "STACKSIM_RDS_MARIADBD_PATH"), environmentValue(this.environment, "STACKSIM_RDS_INSTALL_DB_PATH"), environmentValue(this.environment, "STACKSIM_RDS_MARIADBD"), environmentValue(this.environment, "STACKSIM_RDS_INSTALL_DB")]) {
      if (secret) redacted = redacted.split(secret).join(secret === config.masterPassword ? "<redacted>" : "<local-path>");
    }
    return redacted.replace(/[\r\n]+/g, " ").trim();
  }

  private async findExecutable(explicit: string | undefined, candidates: string[]): Promise<string | undefined> {
    if (explicit) {
      if (isAbsolute(explicit) || explicit.includes("/") || explicit.includes("\\")) return await executableFile(resolve(explicit), this.platform) ? resolve(explicit) : undefined;
      return firstExecutable(this.pathCandidates([explicit]), this.platform);
    }
    return firstExecutable(this.pathCandidates(candidates), this.platform);
  }

  private pathCandidates(names: string[]): string[] {
    const pathValue = environmentValue(this.environment, "PATH") ?? "";
    const directories = pathValue.split(delimiter).map(item => item.replace(/^"|"$/g, "")).filter(Boolean);
    const extensions = this.platform === "win32"
      ? (environmentValue(this.environment, "PATHEXT") ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
    const result: string[] = [];
    for (const directory of directories) for (const name of names) {
      if (this.platform !== "win32" || /\.[A-Za-z0-9]+$/.test(name)) result.push(join(directory, name));
      else for (const extension of extensions) result.push(join(directory, `${name}${extension.toLowerCase()}`), join(directory, `${name}${extension.toUpperCase()}`));
    }
    return result;
  }

  private async runCommand(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    const child = this.spawnProcess(command, args, { env: this.environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = appendBounded(stderr, chunk); });
    return new Promise((resolveResult, rejectResult) => {
      let settled = false;
      const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); callback(); };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => rejectResult(new RdsEngineProviderError("INITIALIZATION_FAILED", "A MariaDB provider command timed out.")));
      }, timeoutMs);
      child.once("error", () => finish(() => rejectResult(new RdsEngineProviderError("PROVIDER_NOT_FOUND", "A MariaDB provider executable could not be launched."))));
      child.once("close", code => finish(() => code === 0
        ? resolveResult({ stdout, stderr })
        : rejectResult(new RdsEngineProviderError("INITIALIZATION_FAILED", `A MariaDB provider command exited with code ${code ?? "unknown"}. ${tailLine(`${stderr}\n${stdout}`)}`.trim()))));
    });
  }
}

async function defaultMysqlLoader(): Promise<MariaDbMysqlModule> {
  const specifier = "mysql2/promise";
  return await import(specifier) as unknown as MariaDbMysqlModule;
}

function randomCredential(prefix: "stacksim_bootstrap" | "stacksim_control", resourceId: string): ControlCredential {
  return { schemaVersion: 1, resourceId, username: `${prefix}_${randomBytes(6).toString("hex")}`, password: randomBytes(32).toString("base64url") };
}

function sqlLiteral(value: string): string {
  if (value.includes("\0")) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "A MariaDB bootstrap value contains a NUL byte.");
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new RdsEngineProviderError("INVALID_CONFIGURATION", `${name} must be a positive duration.`);
  return resolved;
}

function validateProviderParameters(parameters: Record<string, string>, dynamicOnly: boolean): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, supplied] of Object.entries(parameters)) {
    if (!Object.hasOwn(PROVIDER_PARAMETER_DEFAULTS, name) || (dynamicOnly && !DYNAMIC_PROVIDER_PARAMETERS.has(name))) {
      throw new RdsEngineProviderError("INVALID_CONFIGURATION", `MariaDB parameter ${name} is not available for this operation.`);
    }
    const value = String(supplied);
    const numeric = Number(value);
    if (name === "max_connections" && (!/^\d+$/.test(value) || numeric < 10 || numeric > 1_000)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "max_connections must be an integer from 10 through 1000.");
    if (name === "wait_timeout" && (!/^\d+$/.test(value) || numeric < 60 || numeric > 28_800)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "wait_timeout must be an integer from 60 through 28800 seconds.");
    if (name === "max_allowed_packet" && (!/^\d+$/.test(value) || numeric < 1_048_576 || numeric > 67_108_864)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "max_allowed_packet must be an integer from 1048576 through 67108864 bytes.");
    if (name === "innodb_flush_log_at_trx_commit" && !new Set(["0", "1", "2"]).has(value)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "innodb_flush_log_at_trx_commit must be 0, 1, or 2.");
    if (name === "collation_server" && !new Set(["utf8mb4_unicode_ci", "utf8mb4_general_ci"]).has(value)) throw new RdsEngineProviderError("INVALID_CONFIGURATION", "collation_server must be an approved utf8mb4 collation.");
    result[name] = value;
  }
  return result;
}

function providerParameterArguments(parameters: Record<string, string> | undefined): string[] {
  const values = { ...PROVIDER_PARAMETER_DEFAULTS, ...validateProviderParameters(parameters ?? {}, false) };
  return [
    `--max-connections=${values.max_connections}`,
    `--wait-timeout=${values.wait_timeout}`,
    `--max-allowed-packet=${values.max_allowed_packet}`,
    `--innodb-flush-log-at-trx-commit=${values.innodb_flush_log_at_trx_commit}`,
    `--collation-server=${values.collation_server}`,
  ];
}

function compareVersion(value: string, minimum: readonly [number, number, number]): number {
  const parts = value.split(".").slice(0, 3).map(part => Number.parseInt(part, 10));
  for (let index = 0; index < minimum.length; index += 1) {
    const difference = (parts[index] ?? 0) - minimum[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function majorMinor(value: string): string {
  return value.split(".").slice(0, 2).join(".");
}

function sameMajorMinor(left: string, right: string): boolean {
  return majorMinor(left) === majorMinor(right);
}

async function firstExecutable(candidates: string[], platform: NodeJS.Platform): Promise<string | undefined> {
  for (const candidate of candidates) if (await executableFile(candidate, platform)) return resolve(candidate);
  return undefined;
}

async function executableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch { return false; }
}

function environmentValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const match = Object.keys(environment).find(candidate => candidate.toUpperCase() === key.toUpperCase());
  return match ? environment[match] : undefined;
}

function isDirectChild(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const normalizedRoot = platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  const normalizedCandidate = platform === "win32" ? resolve(candidate).toLowerCase() : resolve(candidate);
  const difference = relative(normalizedRoot, normalizedCandidate);
  return Boolean(difference) && !difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference) && !difference.includes(sep);
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalizedLeft = resolve(left); const normalizedRight = resolve(right);
  return platform === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

async function assertPortAvailable(port: number): Promise<void> {
  const server: NetServer = createServer();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen({ host: LOOPBACK, port, exclusive: true }, () => { server.off("error", rejectListen); resolveListen(); });
    });
  } catch {
    throw new RdsEngineProviderError("PORT_IN_USE", `TCP port ${port} is unavailable on ${LOOPBACK}; no fallback port was selected.`);
  } finally {
    if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  const server: NetServer = createServer();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen({ host: LOOPBACK, port, exclusive: true }, () => { server.off("error", rejectListen); resolveListen(); });
    });
    return true;
  } catch { return false; }
  finally { if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose())); }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", "A MariaDB private temporary path is unsafe.");
    await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function assertSafeOutputPath(path: string, label: string, allowSocket = false): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !(allowSocket && metadata.isSocket()))) {
      throw new RdsEngineProviderError("UNSAFE_RESOURCE_PATH", `The MariaDB ${label} path is unsafe.`);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function appendBounded(current: string, chunk: unknown): string {
  const next = current + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  return next.length <= OUTPUT_LIMIT ? next : next.slice(next.length - OUTPUT_LIMIT);
}

function tailLine(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  return normalized.length <= 500 ? normalized : normalized.slice(normalized.length - 500);
}

function hasExited(child: ManagedChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ManagedChild, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise(resolveExit => {
    let settled = false;
    const finish = (exited: boolean) => { if (settled) return; settled = true; clearTimeout(timer); child.off("exit", onExit); resolveExit(exited); };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "UNKNOWN";
  const value = (error as { code?: unknown; errno?: unknown }).code ?? (error as { errno?: unknown }).errno;
  return String(value ?? "UNKNOWN").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "UNKNOWN";
}

function connectionDiagnostic(error: unknown): string {
  const code = errorCode(error);
  if (code === "ER_ACCESS_DENIED_ERROR" || code === "1045") return "MariaDB authentication failed for the configured master user.";
  if (code === "ER_BAD_DB_ERROR" || code === "1049") return "The configured MariaDB database is unavailable.";
  if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "PROTOCOL_CONNECTION_LOST"].includes(code)) return "The MariaDB loopback listener is not ready.";
  return `The MariaDB readiness query failed (${code}).`;
}

async function closeConnection(connection: MariaDbConnection): Promise<void> {
  try { await connection.end(); } catch { connection.destroy(); }
}

async function bestEffortChmod(path: string, mode: number): Promise<void> {
  try { await chmod(path, mode); } catch { /* Windows and some filesystems do not implement POSIX modes. */ }
}
