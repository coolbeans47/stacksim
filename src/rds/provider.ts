export interface RdsEngineConfig {
  /** Stable provider-owned resource identifier. It must match the resource directory name. */
  resourceId: string;
  /** Absolute or working-directory-relative path below the provider's configured instances root. */
  resourceDir: string;
  databaseName?: string;
  masterUsername: string;
  /** Kept in memory only. Providers must not write this value to configuration, state, or logs. */
  masterPassword: string;
  port: number;
  /** Validated provider-safe MySQL-compatibility variables. */
  parameters?: Record<string, string>;
}

export type RdsEngineResourceConfig = Pick<RdsEngineConfig, "resourceId" | "resourceDir" | "port">;

export interface RdsEngineSnapshotFile {
  name: string;
  sizeBytes: number;
  sha256: string;
}

export interface RdsEngineDiscovery {
  providerName: string;
  engineVersion: string;
  /** Complete provider version line, suitable for local diagnostics. */
  version: string;
  /** Legacy external-provider diagnostics. Embedded providers leave these unset. */
  mariadbdPath?: string;
  installDbPath?: string;
}

export interface RdsEngineRuntime {
  providerName: string;
  resourceId: string;
  resourceDir: string;
  endpoint: { address: "127.0.0.1"; port: number };
  engineVersion: string;
  pid?: number;
  ready: boolean;
  /** Redacted, developer-facing status; never contains credentials or host filesystem paths. */
  diagnostic?: string;
}

export interface RdsEngineProvider {
  discover(): Promise<RdsEngineDiscovery>;
  /** Prepare and bootstrap a durable instance. A successful return leaves the provider stopped. */
  initialize(config: RdsEngineConfig): Promise<void>;
  /** Start the prepared instance and return only after authenticated readiness succeeds. */
  start(config: RdsEngineConfig): Promise<RdsEngineRuntime>;
  /** Return the current authenticated readiness state without changing lifecycle state. */
  readiness(config: RdsEngineConfig): Promise<RdsEngineRuntime>;
  /** Rotate the exact managed master account and prove the new credential before returning. */
  rotateMasterPassword(config: RdsEngineConfig, nextPassword: string): Promise<void>;
  /** Apply validated dynamic compatibility variables to the active owned engine. */
  applyParameters(config: RdsEngineConfig, parameters: Record<string, string>): Promise<void>;
  /** Capture every logical database into an empty caller-owned directory. The engine must be quiescent. */
  captureSnapshot?(config: RdsEngineConfig, targetDataDir: string): Promise<RdsEngineSnapshotFile[]>;
  /** Replace a newly initialized, stopped resource's databases from a validated snapshot directory. */
  restoreSnapshot?(config: RdsEngineConfig, sourceDataDir: string, files: readonly RdsEngineSnapshotFile[]): Promise<void>;
  /** Stop the exact listener/engine owned by this provider object. */
  stop(): Promise<void>;
  /** Update stopped provider ownership metadata before a caller-controlled restart. */
  reconfigure(current: RdsEngineConfig, next: RdsEngineConfig): Promise<void>;
  /** Destroy one marked resource after confirmed quiescence or authenticated orphan shutdown. */
  destroy(config: RdsEngineResourceConfig): Promise<void>;
}

export type RdsEngineProviderErrorCode =
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_INCOMPATIBLE"
  | "MYSQL_DRIVER_MISSING"
  | "INVALID_CONFIGURATION"
  | "UNSAFE_RESOURCE_PATH"
  | "INITIALIZATION_CONFLICT"
  | "INITIALIZATION_FAILED"
  | "PORT_IN_USE"
  | "START_FAILED"
  | "AUTHENTICATION_FAILED"
  | "CREDENTIAL_UNAVAILABLE"
  | "ORPHAN_UNCERTAIN"
  | "STOP_FAILED"
  | "DESTROY_REFUSED";

export class RdsEngineProviderError extends Error {
  readonly name = "RdsEngineProviderError";

  constructor(
    readonly code: RdsEngineProviderErrorCode,
    message: string,
  ) {
    super(message);
  }
}
