import { createHash, createHmac, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import mysql, { type Connection, type FieldPacket, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import type { Clock } from "./core/clock.js";
import { AwsError } from "./errors.js";
import { awsQueryList, awsQueryXml, parseAwsQuery, sendAwsQueryXml } from "./protocols/query-xml.js";
import type { RdsEngineConfig, RdsEngineProvider, RdsEngineSnapshotFile } from "./rds/provider.js";
import { effectiveParameterValues, parameterDefinition, RDS_PARAMETER_DEFINITIONS, validateParameterValue } from "./rds/parameters.js";
import type { StateStore } from "./state.js";
import type { RdsDbInstanceState, RdsDbParameterGroupState, RdsDbSnapshotState, RdsInstanceLease, RdsPendingModifiedValuesState } from "./types.js";
import { readBody } from "./util.js";

const NAMESPACE = "http://rds.amazonaws.com/doc/2014-10-31/";
const COMPATIBILITY_ENGINE_VERSION = "8.0";
const INSTANCE_CLASS = "db.t3.micro";
const PARAMETER_GROUP_FAMILY = "mysql8.0";
const DEFAULT_PARAMETER_GROUP = "default.mysql8.0";
const QUERY_EDITOR_MAX_SQL_BYTES = 65_536;
const QUERY_EDITOR_MAX_ROWS = 500;
const QUERY_EDITOR_MAX_CELL_CHARACTERS = 16_384;
const QUERY_EDITOR_BLOCKED_SQL = /\b(?:ATTACH|DETACH|VACUUM|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|END|LOAD_EXTENSION|PRAGMA_[A-Za-z0-9_]*)\b/i;
const SNAPSHOT_QUOTA = 20;
const SNAPSHOT_ROOT_MARKER = ".stacksim-rds-snapshots.json";
const SNAPSHOT_OWNERSHIP_MARKER = ".stacksim-rds-snapshot-work.json";
const SNAPSHOT_MANIFEST = "manifest.json";

interface RdsSecret {
  version: 1 | 2;
  resourceId: string;
  databaseName?: string;
  masterUsername: string;
  masterPassword: string;
  pendingMasterPassword?: string;
}

interface RdsSnapshotManifest {
  schemaVersion: 1;
  installationId: string;
  accountId: string;
  region: string;
  snapshotResourceId: string;
  dbSnapshotIdentifier: string;
  sourceDbiResourceId: string;
  databaseName?: string;
  createdAt: number;
  files: RdsEngineSnapshotFile[];
}

interface RdsQueryEditorColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

interface RdsQueryEditorObject {
  name: string;
  type: "table" | "view";
  columns: RdsQueryEditorColumn[];
}

type RdsQueryEditorCell = string | number | boolean | null;

export interface RdsQueryEditorCatalog {
  databases: string[];
  selectedDatabase: string | null;
  objects: RdsQueryEditorObject[];
}

export interface RdsQueryEditorResult {
  database: string | null;
  columns: string[];
  columnMetadata: Array<{
    name: string;
    type: string;
    length: number | null;
    decimals: number | null;
    numeric: boolean;
  }>;
  rows: RdsQueryEditorCell[][];
  rowCount: number;
  truncated: boolean;
  affectedRows?: number;
  insertId?: number;
  elapsedMs: number;
}

const QUERY_EDITOR_NUMERIC_TYPES = new Set([
  "decimal", "double", "float", "int24", "long", "longlong", "newdecimal", "short", "tiny", "year",
]);

function queryEditorFieldMetadata(field: FieldPacket): RdsQueryEditorResult["columnMetadata"][number] {
  const typeCode = field.columnType ?? field.type;
  const resolvedType = field.extendedTypeName
    || field.typeName
    || (typeof typeCode === "number" ? String((mysql.Types as unknown as Record<number, string>)[typeCode] ?? "unknown") : "unknown");
  const type = resolvedType.toLowerCase();
  return {
    name: String(field.name ?? ""),
    type,
    length: Number.isFinite(Number(field.columnLength)) ? Number(field.columnLength) : null,
    decimals: Number.isFinite(Number(field.decimals)) ? Number(field.decimals) : null,
    numeric: QUERY_EDITOR_NUMERIC_TYPES.has(type),
  };
}

function namedList(value: any, memberName: string): any[] {
  const members = value?.[memberName] ?? value;
  if (members === undefined || members === null) return [];
  return Array.isArray(members) ? members : [members];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new AwsError("InvalidParameterValue", `${field} is required`);
  return value;
}

function integer(value: unknown, fallback: number, field: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed)) throw new AwsError("InvalidParameterValue", `${field} must be an integer`);
  return parsed;
}

function boolean(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new AwsError("InvalidParameterValue", "Boolean parameters must be true or false");
}

function rejectUnsupportedInput(input: Record<string, unknown>, supported: readonly string[]): void {
  const allowed = new Set(supported);
  const field = Object.keys(input).find(key => !allowed.has(key));
  if (field) throw new AwsError("InvalidParameterCombination", `${field} is not supported by the local RDS development profile`);
}

function tags(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  const entries = namedList(value, "Tag");
  if (entries.length > 50) throw new AwsError("InvalidParameterValue", "A maximum of 50 tags is allowed");
  for (const entry of entries) {
    const key = String(entry?.Key ?? ""); const tagValue = String(entry?.Value ?? "");
    if (!key || key.length > 128 || tagValue.length > 256 || key.toLowerCase().startsWith("aws:")) throw new AwsError("InvalidParameterValue", "Tag keys or values are invalid");
    if (Object.hasOwn(result, key)) throw new AwsError("InvalidParameterValue", `Duplicate tag key ${key}`);
    result[key] = tagValue;
  }
  return result;
}

function validatePassword(value: unknown): string {
  const password = requiredString(value, "MasterUserPassword");
  if (password.length < 8 || password.length > 41 || /[^\x20-\x7e]/.test(password) || /[\/@\"]/.test(password)) throw new AwsError("InvalidParameterValue", "MasterUserPassword must be 8-41 printable ASCII characters and cannot contain slash, at-sign, or double quote");
  return password;
}

function parameterGroupName(value: unknown): string {
  const name = requiredString(value, "DBParameterGroupName").toLowerCase();
  if (name === DEFAULT_PARAMETER_GROUP) return name;
  if (!/^[a-z][a-z0-9-]{0,254}$/.test(name) || name.endsWith("-") || name.includes("--")) throw new AwsError("InvalidParameterValue", "DBParameterGroupName must start with a letter and contain only letters, numbers, and single hyphens");
  return name;
}

function snapshotIdentifier(value: unknown, field = "DBSnapshotIdentifier"): string {
  const identifier = requiredString(value, field).toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,254}$/.test(identifier) || identifier.endsWith("-") || identifier.includes("--")) throw new AwsError("InvalidParameterValue", `${field} must start with a letter and contain only letters, numbers, and single hyphens`);
  return identifier;
}

function dbInstanceView(instance: RdsDbInstanceState): Record<string, unknown> {
  const statusInfos = instance.statusMessage
    ? [{ StatusType: "local-provider", Normal: false, Status: instance.dbInstanceStatus, Message: instance.statusMessage }]
    : instance.providerVersion ? [{ StatusType: "local-provider", Normal: true, Status: instance.dbInstanceStatus, Message: `Local SQL provider ${instance.providerVersion}` }] : [];
  return {
    DBInstanceIdentifier: instance.dbInstanceIdentifier,
    DBInstanceClass: instance.dbInstanceClass,
    Engine: instance.engine,
    DBInstanceStatus: instance.dbInstanceStatus,
    MasterUsername: instance.masterUsername,
    DBName: instance.dbName,
    Endpoint: { Address: "127.0.0.1", Port: instance.port, HostedZoneId: "local" },
    AllocatedStorage: instance.allocatedStorage,
    InstanceCreateTime: new Date(instance.instanceCreateTime),
    PreferredBackupWindow: "00:00-00:00",
    BackupRetentionPeriod: instance.backupRetentionPeriod,
    DBSecurityGroups: awsQueryList("DBSecurityGroup", []),
    VpcSecurityGroups: awsQueryList("VpcSecurityGroupMembership", []),
    DBParameterGroups: awsQueryList("DBParameterGroup", [{ DBParameterGroupName: instance.dbParameterGroupName, ParameterApplyStatus: instance.parameterApplyStatus }]),
    AvailabilityZone: instance.availabilityZone,
    PreferredMaintenanceWindow: "sun:00:00-sun:00:30",
    PendingModifiedValues: instance.pendingModifiedValues ? {
      AllocatedStorage: instance.pendingModifiedValues.allocatedStorage,
      DBInstanceClass: instance.pendingModifiedValues.dbInstanceClass,
      StorageType: instance.pendingModifiedValues.storageType,
      Port: instance.pendingModifiedValues.port,
    } : {},
    MultiAZ: instance.multiAZ,
    EngineVersion: instance.engineVersion,
    AutoMinorVersionUpgrade: false,
    ReadReplicaDBInstanceIdentifiers: awsQueryList("ReadReplicaDBInstanceIdentifier", []),
    LicenseModel: "general-public-license",
    OptionGroupMemberships: awsQueryList("OptionGroupMembership", [{ OptionGroupName: "default:mysql-8-0", Status: "in-sync" }]),
    PubliclyAccessible: instance.publiclyAccessible,
    StatusInfos: awsQueryList("DBInstanceStatusInfo", statusInfos),
    StorageType: instance.storageType,
    StorageEncrypted: false,
    DbiResourceId: instance.dbiResourceId,
    DomainMemberships: awsQueryList("DomainMembership", []),
    CopyTagsToSnapshot: false,
    MonitoringInterval: 0,
    DBInstanceArn: instance.dbInstanceArn,
    IAMDatabaseAuthenticationEnabled: false,
    PerformanceInsightsEnabled: false,
    DeletionProtection: instance.deletionProtection,
    TagList: awsQueryList("Tag", Object.entries(instance.tags).sort(([left], [right]) => left.localeCompare(right)).map(([Key, Value]) => ({ Key, Value }))),
    NetworkType: "IPV4",
    DedicatedLogVolume: false,
    ...(instance.manageMasterUserPassword && instance.masterUserSecretArn ? { MasterUserSecret: { SecretArn: instance.masterUserSecretArn, SecretStatus: "active" } } : {}),
  };
}

function dbParameterGroupView(group: RdsDbParameterGroupState | undefined, region: string, accountId: string): Record<string, unknown> {
  return group ? {
    DBParameterGroupName: group.dbParameterGroupName,
    DBParameterGroupFamily: group.dbParameterGroupFamily,
    Description: group.description,
    DBParameterGroupArn: group.dbParameterGroupArn,
  } : {
    DBParameterGroupName: DEFAULT_PARAMETER_GROUP,
    DBParameterGroupFamily: PARAMETER_GROUP_FAMILY,
    Description: "Default safe parameters for the stacksim MySQL 8.0 compatibility profile",
    DBParameterGroupArn: `arn:aws:rds:${region}:${accountId}:pg:${DEFAULT_PARAMETER_GROUP}`,
  };
}

function dbSnapshotView(snapshot: RdsDbSnapshotState): Record<string, unknown> {
  return {
    DBSnapshotIdentifier: snapshot.dbSnapshotIdentifier,
    DBInstanceIdentifier: snapshot.dbInstanceIdentifier,
    SnapshotCreateTime: new Date(snapshot.snapshotCreateTime),
    Engine: snapshot.engine,
    AllocatedStorage: snapshot.allocatedStorage,
    Status: snapshot.status,
    Port: snapshot.port,
    AvailabilityZone: snapshot.availabilityZone,
    EngineVersion: snapshot.engineVersion,
    LicenseModel: "general-public-license",
    SnapshotType: snapshot.snapshotType,
    StorageType: snapshot.storageType,
    Encrypted: false,
    PercentProgress: snapshot.status === "available" ? 100 : snapshot.status === "failed" ? 0 : 50,
    DBSnapshotArn: snapshot.dbSnapshotArn,
    DbiResourceId: snapshot.sourceDbiResourceId,
    TagList: awsQueryList("Tag", Object.entries(snapshot.tags).sort(([left], [right]) => left.localeCompare(right)).map(([Key, Value]) => ({ Key, Value }))),
    OriginalSnapshotCreateTime: new Date(snapshot.snapshotCreateTime),
    SnapshotTarget: "local",
    DedicatedLogVolume: false,
    LocalManifestChecksum: snapshot.manifestChecksum,
    LocalDataSizeBytes: snapshot.dataSizeBytes,
    LocalFileCount: snapshot.fileCount,
    LocalStatusMessage: snapshot.statusMessage,
  };
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path); stream.on("data", chunk => hash.update(chunk)); stream.once("end", resolveHash); stream.once("error", rejectHash);
  });
  return hash.digest("hex");
}

async function syncDirectory(path: string): Promise<void> {
  try { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
  catch (error) { if (process.platform !== "win32") throw error; }
}

export interface RdsManagerOptions {
  startupTimeoutMs?: number;
  /** Used only to safely delete stopped data directories created by the retired provider. */
  legacyDestroyProvider?: RdsEngineProvider;
}

export interface RdsManagedSecretsPort {
  create(input: { resourceId: string; targetArn: string; dbInstanceIdentifier: string; username: string; port: number; currentPassword?: string }): Promise<{ arn: string; generationId: string; versionId: string; password: string }>;
  delete(secretArn: string, targetArn: string): Promise<void>;
}

export class RdsManager {
  private mutex = Promise.resolve();
  private engineQueue = Promise.resolve();
  private readonly rdsRoot: string;
  private readonly managedSecrets = new Map<string, RdsManagedSecretsPort>();

  constructor(
    private readonly store: StateStore,
    private readonly provider: RdsEngineProvider,
    private readonly clock: Clock,
    readonly options: RdsManagerOptions = {},
  ) {
    this.rdsRoot = resolve(store.root, "data", "rds");
  }

  get accountId(): string { return this.store.accountId; }

  setManagedSecretsPort(region: string, port: RdsManagedSecretsPort): void { this.managedSecrets.set(region, port); }

  async start(): Promise<void> {
    await this.reconcileSnapshots();
    let lease = this.store.state.installation.rds.instanceLease;
    const descriptors = this.allInstances();
    if (descriptors.length > 1) throw new Error("RDS state contains multiple DB instances; the installation-wide singleton cannot be reconciled safely");
    if (!lease) {
      if (!descriptors.length) return;
      const recovered = descriptors[0];
      lease = { accountId: recovered.accountId, region: recovered.region, dbInstanceIdentifier: recovered.instance.dbInstanceIdentifier, dbiResourceId: recovered.instance.dbiResourceId, port: recovered.instance.port };
      this.store.state.installation.rds.instanceLease = lease;
      await this.store.save();
    }
    const instance = this.instanceForLease(lease);
    if (!instance) {
      throw new Error("RDS installation lease does not match the persisted DB descriptor; refusing to release provider ownership automatically");
    }
    if (instance.providerEngine === "mariadb" && this.options.legacyDestroyProvider) {
      if (instance.dbInstanceStatus === "deleting") await this.enqueueEngine(() => this.removeInstance(lease, instance));
      else {
        instance.dbInstanceStatus = "failed";
        delete instance.lifecycleOperation;
        instance.statusMessage = "This persisted RDS instance uses the retired external provider and cannot be opened by embedded SQLite. Delete and recreate the instance to use the current provider.";
        await this.store.save();
      }
      return;
    }
    if (instance.dbInstanceStatus === "creating" && instance.restoreSourceSnapshotArn) {
      try {
        const located = this.findSnapshot(instance.restoreSourceSnapshotArn); const manifest = await this.readSnapshotManifest(located.region, located.snapshot);
        await this.enqueueEngine(() => this.provisionRestore(lease!, instance, located.region, located.snapshot, manifest));
      } catch (error) {
        instance.dbInstanceStatus = "failed"; delete instance.restoreSourceSnapshotArn; instance.statusMessage = `Snapshot restore recovery failed: ${this.safeMessage(error)}`; await this.store.save();
      }
    }
    else if (instance.dbInstanceStatus === "deleting") await this.enqueueEngine(() => this.removeInstance(lease, instance));
    else if (instance.dbInstanceStatus === "stopped") return;
    else if (instance.dbInstanceStatus === "stopping") await this.enqueueEngine(() => this.finishStop(lease));
    else if (instance.dbInstanceStatus === "starting") await this.enqueueEngine(() => this.finishStart(lease));
    else if (instance.dbInstanceStatus === "modifying") await this.enqueueEngine(() => this.applyPending(lease, "modify"));
    else if (instance.dbInstanceStatus === "rebooting") await this.enqueueEngine(() => this.applyPending(lease, "reboot"));
    else if (instance.dbInstanceStatus !== "failed") await this.enqueueEngine(() => this.provision(lease, instance));
  }

  async stop(): Promise<void> {
    await this.engineQueue.catch(() => undefined);
    await this.provider.stop();
  }

  async create(region: string, input: any): Promise<RdsDbInstanceState> {
    const validated = this.validateCreate(region, input);
    await this.exclusive(async () => this.assertCreateSlot(region, validated.identifier));
    try { await this.provider.discover(); }
    catch (error) { throw new AwsError("InsufficientDBInstanceCapacity", `The embedded SQL provider is unavailable: ${this.safeMessage(error)}`); }
    await this.assertPortAvailable(validated.port);
    let response!: RdsDbInstanceState; let lease!: RdsInstanceLease;
    await this.exclusive(async () => {
      this.assertCreateSlot(region, validated.identifier);
      const regional = this.store.regionState(region);
      const resourceId = `db-${randomUUID().replace(/-/g, "").slice(0, 26)}`;
      const instance: RdsDbInstanceState = {
        dbInstanceIdentifier: validated.identifier,
        dbiResourceId: resourceId,
        dbInstanceArn: `arn:aws:rds:${region}:${this.store.accountId}:db:${validated.identifier}`,
        dbInstanceClass: INSTANCE_CLASS,
        dbInstanceStatus: "creating",
        engine: "mysql",
        engineVersion: COMPATIBILITY_ENGINE_VERSION,
        allocatedStorage: validated.allocatedStorage,
        storageType: validated.storageType,
        ...(validated.dbName ? { dbName: validated.dbName } : {}),
        masterUsername: validated.masterUsername,
        port: validated.port,
        backupRetentionPeriod: 0,
        publiclyAccessible: false,
        multiAZ: false,
        deletionProtection: validated.deletionProtection,
        dbParameterGroupName: validated.parameterGroupName,
        parameterApplyStatus: "in-sync",
        appliedParameters: effectiveParameterValues(this.parameterGroup(region, validated.parameterGroupName)),
        availabilityZone: `${region}a`,
        instanceCreateTime: this.clock.now(),
        tags: validated.tags,
        ...(validated.manageMasterUserPassword ? { manageMasterUserPassword: true } : {}),
      };
      lease = { accountId: this.store.accountId, region, dbInstanceIdentifier: validated.identifier, dbiResourceId: resourceId, port: validated.port };
      let managed: Awaited<ReturnType<RdsManagedSecretsPort["create"]>> | undefined;
      if (validated.manageMasterUserPassword) {
        const port = this.managedSecrets.get(region);
        if (!port) throw new AwsError("InvalidDBInstanceState", "Secrets Manager isn't ready for managed RDS credentials", 503);
        managed = await port.create({ resourceId, targetArn: instance.dbInstanceArn, dbInstanceIdentifier: instance.dbInstanceIdentifier, username: instance.masterUsername, port: instance.port });
        instance.masterUserSecretArn = managed.arn;
      }
      await this.writeSecret(instance, managed?.password ?? validated.masterPassword!);
      regional.rdsDbInstances[validated.identifier] = instance;
      this.store.state.installation.rds.instanceLease = lease;
      try { await this.store.save(); }
      catch (error) { delete regional.rdsDbInstances[validated.identifier]; delete this.store.state.installation.rds.instanceLease; await this.deleteSecret(resourceId); if (managed) await this.managedSecrets.get(region)?.delete(managed.arn, instance.dbInstanceArn).catch(() => undefined); throw error; }
      response = structuredClone(instance);
    });
    void this.enqueueEngine(() => this.provision(lease, this.instanceForLease(lease)!));
    return response;
  }

  describe(region: string, input: any): RdsDbInstanceState[] {
    rejectUnsupportedInput(input, ["DBInstanceIdentifier", "Filters", "MaxRecords"]);
    let instances = Object.values(this.store.regionState(region).rdsDbInstances);
    if (input.DBInstanceIdentifier !== undefined) {
      const identifier = String(input.DBInstanceIdentifier).toLowerCase(); const found = this.store.regionState(region).rdsDbInstances[identifier];
      if (!found) throw new AwsError("DBInstanceNotFound", `DB instance ${identifier} was not found`, 404);
      instances = [found];
    }
    const maxRecords = input.MaxRecords === undefined ? 100 : integer(input.MaxRecords, 100, "MaxRecords");
    if (maxRecords < 20 || maxRecords > 100) throw new AwsError("InvalidParameterValue", "MaxRecords must be between 20 and 100");
    for (const filter of namedList(input.Filters, "Filter")) {
      const name = String(filter?.Name ?? ""); const values = namedList(filter?.Values, "Value").map(String);
      if (!values.length) throw new AwsError("InvalidParameterValue", `Filter ${name} must include a value`);
      if (name === "db-instance-id") instances = instances.filter(instance => values.includes(instance.dbInstanceIdentifier));
      else if (name === "engine") instances = instances.filter(instance => values.includes(instance.engine));
      else if (name === "db-instance-status") instances = instances.filter(instance => values.includes(instance.dbInstanceStatus));
      else throw new AwsError("InvalidParameterValue", `Unsupported RDS filter ${name}`);
    }
    return instances.sort((left, right) => left.dbInstanceIdentifier.localeCompare(right.dbInstanceIdentifier)).slice(0, maxRecords).map(instance => structuredClone(instance));
  }

  async createSnapshot(region: string, input: any): Promise<RdsDbSnapshotState> {
    rejectUnsupportedInput(input, ["DBSnapshotIdentifier", "DBInstanceIdentifier", "Tags"]);
    const identifier = snapshotIdentifier(input.DBSnapshotIdentifier);
    const dbIdentifier = requiredString(input.DBInstanceIdentifier, "DBInstanceIdentifier").toLowerCase();
    let snapshot!: RdsDbSnapshotState; let source!: RdsDbInstanceState; let wasAvailable = false;
    await this.exclusive(async () => {
      const regional = this.store.regionState(region);
      if (regional.rdsDbSnapshots[identifier]) throw new AwsError("DBSnapshotAlreadyExists", `DB snapshot ${identifier} already exists`);
      if (Object.keys(regional.rdsDbSnapshots).length >= SNAPSHOT_QUOTA) throw new AwsError("SnapshotQuotaExceeded", `The local manual snapshot quota of ${SNAPSHOT_QUOTA} has been reached`);
      const instance = this.requireInstance(region, dbIdentifier);
      if (!new Set(["available", "stopped"]).has(instance.dbInstanceStatus)) throw new AwsError("InvalidDBInstanceState", `DB instance ${dbIdentifier} must be available or stopped before snapshot creation`);
      if (instance.providerEngine === "mariadb" || !this.provider.captureSnapshot) throw new AwsError("InvalidDBInstanceState", "Manual snapshots require the embedded SQLite provider");
      wasAvailable = instance.dbInstanceStatus === "available";
      if (wasAvailable) instance.dbInstanceStatus = "backing-up";
      const snapshotResourceId = `snapshot-${randomUUID().replace(/-/g, "").slice(0, 26)}`;
      snapshot = {
        dbSnapshotIdentifier: identifier,
        dbSnapshotArn: `arn:aws:rds:${region}:${this.store.accountId}:snapshot:${identifier}`,
        snapshotResourceId,
        dbInstanceIdentifier: instance.dbInstanceIdentifier,
        sourceDbiResourceId: instance.dbiResourceId,
        status: "creating",
        snapshotType: "manual",
        snapshotCreateTime: this.clock.now(),
        engine: "mysql",
        engineVersion: instance.engineVersion,
        allocatedStorage: instance.allocatedStorage,
        storageType: instance.storageType,
        port: instance.port,
        availabilityZone: instance.availabilityZone,
        ...(instance.dbName ? { dbName: instance.dbName } : {}),
        dbParameterGroupName: instance.dbParameterGroupName,
        appliedParameters: { ...instance.appliedParameters },
        tags: tags(input.Tags),
        restoreAttributes: [],
      };
      regional.rdsDbSnapshots[identifier] = snapshot;
      source = structuredClone(instance);
      await this.store.save();
    });
    let manifest: { checksum: string; sizeBytes: number; fileCount: number } | undefined; let failure: unknown; let restartFailure: unknown;
    try {
      if (wasAvailable) await this.provider.stop();
      const secret = await this.readSecret(source);
      manifest = await this.publishCapturedSnapshot(region, snapshot, this.engineConfig(source, secret));
    } catch (error) { failure = error; }
    if (wasAvailable) {
      try {
        const secret = await this.readSecret(source);
        const runtime = await this.provider.start(this.engineConfig(source, secret));
        if (!runtime.ready) throw new Error(runtime.diagnostic ?? "The SQL listener was not ready after snapshot capture");
      } catch (error) { restartFailure = error; }
    }
    await this.exclusive(async () => {
      const current = this.store.regionState(region).rdsDbSnapshots[identifier];
      if (current) {
        if (manifest) { current.status = "available"; current.manifestChecksum = manifest.checksum; current.dataSizeBytes = manifest.sizeBytes; current.fileCount = manifest.fileCount; delete current.statusMessage; }
        else { current.status = "failed"; current.statusMessage = `Snapshot publication failed: ${this.safeMessage(failure)}`; }
      }
      const instance = this.store.regionState(region).rdsDbInstances[dbIdentifier];
      if (instance?.dbiResourceId === source.dbiResourceId && wasAvailable) {
        if (restartFailure) { instance.dbInstanceStatus = "failed"; instance.statusMessage = `Snapshot captured but listener restart failed: ${this.safeMessage(restartFailure)}`; }
        else { instance.dbInstanceStatus = "available"; delete instance.statusMessage; }
      }
      await this.store.save();
    });
    return structuredClone(this.requireSnapshot(region, identifier));
  }

  async describeSnapshots(region: string, input: any): Promise<RdsDbSnapshotState[]> {
    rejectUnsupportedInput(input, ["DBSnapshotIdentifier", "DBInstanceIdentifier", "SnapshotType", "IncludeShared", "IncludePublic", "Filters", "MaxRecords", "Marker"]);
    if (input.Marker !== undefined) throw new AwsError("InvalidParameterValue", "Marker is invalid");
    if (boolean(input.IncludeShared, false) || boolean(input.IncludePublic, false)) throw new AwsError("InvalidParameterCombination", "Shared and public DB snapshots are not available in the installation-local profile");
    if (input.SnapshotType !== undefined && String(input.SnapshotType) !== "manual") return [];
    let snapshots = Object.values(this.store.regionState(region).rdsDbSnapshots);
    if (input.DBSnapshotIdentifier !== undefined) snapshots = [this.requireSnapshot(region, snapshotIdentifier(input.DBSnapshotIdentifier))];
    if (input.DBInstanceIdentifier !== undefined) snapshots = snapshots.filter(snapshot => snapshot.dbInstanceIdentifier === String(input.DBInstanceIdentifier).toLowerCase());
    for (const filter of namedList(input.Filters, "Filter")) {
      const name = String(filter?.Name ?? ""); const values = namedList(filter?.Values, "Value").map(String);
      if (!values.length) throw new AwsError("InvalidParameterValue", `Filter ${name} must include a value`);
      if (name === "db-snapshot-id") snapshots = snapshots.filter(snapshot => values.includes(snapshot.dbSnapshotIdentifier));
      else if (name === "db-instance-id") snapshots = snapshots.filter(snapshot => values.includes(snapshot.dbInstanceIdentifier));
      else if (name === "snapshot-type") snapshots = snapshots.filter(snapshot => values.includes(snapshot.snapshotType));
      else if (name === "engine") snapshots = snapshots.filter(snapshot => values.includes(snapshot.engine));
      else if (name === "status") snapshots = snapshots.filter(snapshot => values.includes(snapshot.status));
      else throw new AwsError("InvalidParameterValue", `Unsupported DB snapshot filter ${name}`);
    }
    const maxRecords = input.MaxRecords === undefined ? 100 : integer(input.MaxRecords, 100, "MaxRecords");
    if (maxRecords < 20 || maxRecords > 100) throw new AwsError("InvalidParameterValue", "MaxRecords must be between 20 and 100");
    let changed = false;
    for (const snapshot of snapshots) if (snapshot.status === "available") {
      try { await this.readSnapshotManifest(region, snapshot); }
      catch (error) { snapshot.status = "failed"; snapshot.statusMessage = `Snapshot validation failed: ${this.safeMessage(error)}`; changed = true; }
    }
    if (changed) await this.store.save();
    return snapshots.sort((left, right) => left.dbSnapshotIdentifier.localeCompare(right.dbSnapshotIdentifier)).slice(0, maxRecords).map(value => structuredClone(value));
  }

  async copySnapshot(region: string, input: any): Promise<RdsDbSnapshotState> {
    rejectUnsupportedInput(input, ["SourceDBSnapshotIdentifier", "TargetDBSnapshotIdentifier", "CopyTags", "Tags", "SourceRegion"]);
    if (input.SourceRegion !== undefined) throw new AwsError("InvalidParameterCombination", "SourceRegion is not required; installation-local snapshot ARNs identify their source Region");
    const targetIdentifier = snapshotIdentifier(input.TargetDBSnapshotIdentifier, "TargetDBSnapshotIdentifier");
    const source = this.findSnapshot(requiredString(input.SourceDBSnapshotIdentifier, "SourceDBSnapshotIdentifier"));
    if (source.snapshot.status !== "available") throw new AwsError("InvalidDBSnapshotState", `DB snapshot ${source.snapshot.dbSnapshotIdentifier} is not available for copy`);
    let target!: RdsDbSnapshotState;
    await this.exclusive(async () => {
      const regional = this.store.regionState(region);
      if (regional.rdsDbSnapshots[targetIdentifier]) throw new AwsError("DBSnapshotAlreadyExists", `DB snapshot ${targetIdentifier} already exists`);
      if (Object.keys(regional.rdsDbSnapshots).length >= SNAPSHOT_QUOTA) throw new AwsError("SnapshotQuotaExceeded", `The local manual snapshot quota of ${SNAPSHOT_QUOTA} has been reached`);
      target = { ...structuredClone(source.snapshot), dbSnapshotIdentifier: targetIdentifier, dbSnapshotArn: `arn:aws:rds:${region}:${this.store.accountId}:snapshot:${targetIdentifier}`, snapshotResourceId: `snapshot-${randomUUID().replace(/-/g, "").slice(0, 26)}`, status: "copying", snapshotCreateTime: this.clock.now(), sourceSnapshotIdentifier: source.snapshot.dbSnapshotIdentifier, sourceSnapshotArn: source.snapshot.dbSnapshotArn, tags: boolean(input.CopyTags, false) ? { ...source.snapshot.tags, ...tags(input.Tags) } : tags(input.Tags), restoreAttributes: [] };
      delete target.manifestChecksum; delete target.dataSizeBytes; delete target.fileCount; delete target.statusMessage;
      regional.rdsDbSnapshots[targetIdentifier] = target; await this.store.save();
    });
    try {
      const result = await this.publishCopiedSnapshot(region, target, source.region, source.snapshot);
      await this.exclusive(async () => { const current = this.requireSnapshot(region, targetIdentifier); current.status = "available"; current.manifestChecksum = result.checksum; current.dataSizeBytes = result.sizeBytes; current.fileCount = result.fileCount; await this.store.save(); });
    } catch (error) {
      await this.exclusive(async () => { const current = this.requireSnapshot(region, targetIdentifier); current.status = "failed"; current.statusMessage = `Snapshot copy failed: ${this.safeMessage(error)}`; await this.store.save(); });
    }
    return structuredClone(this.requireSnapshot(region, targetIdentifier));
  }

  async deleteSnapshot(region: string, input: any): Promise<RdsDbSnapshotState> {
    rejectUnsupportedInput(input, ["DBSnapshotIdentifier"]);
    const identifier = snapshotIdentifier(input.DBSnapshotIdentifier); let response!: RdsDbSnapshotState;
    await this.exclusive(async () => {
      const snapshot = this.requireSnapshot(region, identifier);
      if (!new Set(["available", "failed"]).has(snapshot.status)) throw new AwsError("InvalidDBSnapshotState", `DB snapshot ${identifier} cannot be deleted while ${snapshot.status}`);
      const restoreUsesSnapshot = this.allInstances().some(value => value.instance.restoreSourceSnapshotArn === snapshot.dbSnapshotArn);
      const copyUsesSnapshot = Object.values(this.store.ensureAccount().regions).some(regional => Object.values(regional.rdsDbSnapshots).some(value => value.status === "copying" && value.sourceSnapshotArn === snapshot.dbSnapshotArn));
      if (restoreUsesSnapshot || copyUsesSnapshot) throw new AwsError("InvalidDBSnapshotState", `DB snapshot ${identifier} is in use by a restore or copy operation`);
      snapshot.status = "deleting"; response = structuredClone(snapshot); await this.store.save();
    });
    try {
      await this.removeSnapshotFiles(response.snapshotResourceId);
      await this.exclusive(async () => { delete this.store.regionState(region).rdsDbSnapshots[identifier]; await this.store.save(); });
    } catch (error) {
      await this.exclusive(async () => { const current = this.store.regionState(region).rdsDbSnapshots[identifier]; if (current) { current.status = "failed"; current.statusMessage = `Snapshot deletion failed: ${this.safeMessage(error)}`; await this.store.save(); } });
    }
    return response;
  }

  describeSnapshotAttributes(region: string, input: any): RdsDbSnapshotState {
    rejectUnsupportedInput(input, ["DBSnapshotIdentifier"]);
    return structuredClone(this.requireSnapshot(region, snapshotIdentifier(input.DBSnapshotIdentifier)));
  }

  async modifySnapshotAttribute(region: string, input: any): Promise<RdsDbSnapshotState> {
    rejectUnsupportedInput(input, ["DBSnapshotIdentifier", "AttributeName", "ValuesToAdd", "ValuesToRemove"]);
    const identifier = snapshotIdentifier(input.DBSnapshotIdentifier);
    if (requiredString(input.AttributeName, "AttributeName") !== "restore") throw new AwsError("InvalidParameterValue", "Only the restore DB snapshot attribute is supported");
    const additions = namedList(input.ValuesToAdd, "AttributeValue").map(String); const removals = namedList(input.ValuesToRemove, "AttributeValue").map(String);
    if (!additions.length && !removals.length) throw new AwsError("InvalidParameterCombination", "ValuesToAdd or ValuesToRemove is required");
    const valid = (value: string) => value === "all" || /^\d{12}$/.test(value);
    if (![...additions, ...removals].every(valid)) throw new AwsError("InvalidParameterValue", "Restore attribute values must be all or a 12-digit account ID");
    let result!: RdsDbSnapshotState;
    await this.exclusive(async () => {
      const snapshot = this.requireSnapshot(region, identifier);
      if (snapshot.status !== "available") throw new AwsError("InvalidDBSnapshotState", `DB snapshot ${identifier} must be available before attributes change`);
      const values = new Set(snapshot.restoreAttributes); for (const value of additions) values.add(value); for (const value of removals) values.delete(value);
      if (values.size > 20) throw new AwsError("SharedSnapshotQuotaExceeded", "A maximum of 20 restore attribute values is supported");
      snapshot.restoreAttributes = [...values].sort(); result = structuredClone(snapshot); await this.store.save();
    });
    return result;
  }

  async restoreSnapshot(region: string, input: any): Promise<RdsDbInstanceState> {
    rejectUnsupportedInput(input, ["DBInstanceIdentifier", "DBSnapshotIdentifier", "DBInstanceClass", "Port", "MasterUsername", "MasterUserPassword", "DBParameterGroupName", "DeletionProtection", "PubliclyAccessible", "MultiAZ", "Tags"]);
    const identifier = requiredString(input.DBInstanceIdentifier, "DBInstanceIdentifier").toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(identifier) || identifier.endsWith("-") || identifier.includes("--")) throw new AwsError("InvalidParameterValue", "DBInstanceIdentifier is invalid");
    const located = this.findSnapshot(requiredString(input.DBSnapshotIdentifier, "DBSnapshotIdentifier")); const snapshot = located.snapshot;
    if (snapshot.status !== "available") throw new AwsError("InvalidDBSnapshotState", `DB snapshot ${snapshot.dbSnapshotIdentifier} is not available for restore`);
    if (String(input.DBInstanceClass ?? INSTANCE_CLASS) !== INSTANCE_CLASS) throw new AwsError("InvalidParameterValue", `Only ${INSTANCE_CLASS} is supported`);
    if (boolean(input.PubliclyAccessible, false) || boolean(input.MultiAZ, false)) throw new AwsError("InvalidParameterCombination", "Restored DB instances remain singleton, loopback-only, and non-Multi-AZ");
    const masterUsername = requiredString(input.MasterUsername, "MasterUsername");
    if (!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(masterUsername) || /^root$/i.test(masterUsername)) throw new AwsError("InvalidParameterValue", "MasterUsername is invalid or reserved");
    const password = validatePassword(input.MasterUserPassword); const port = integer(input.Port, snapshot.port, "Port");
    if (port < 1150 || port > 65_535) throw new AwsError("InvalidParameterValue", "Port must be between 1150 and 65535");
    const requestedGroup = input.DBParameterGroupName === undefined ? snapshot.dbParameterGroupName : parameterGroupName(input.DBParameterGroupName);
    if (requestedGroup !== DEFAULT_PARAMETER_GROUP && !this.store.regionState(region).rdsDbParameterGroups[requestedGroup]) throw new AwsError("DBParameterGroupNotFound", `DB parameter group ${requestedGroup} was not found`, 404);
    const group = requestedGroup;
    const manifest = await this.readSnapshotManifest(located.region, snapshot);
    await this.assertPortAvailable(port);
    let instance!: RdsDbInstanceState; let lease!: RdsInstanceLease;
    await this.exclusive(async () => {
      this.assertCreateSlot(region, identifier);
      const resourceId = `db-${randomUUID().replace(/-/g, "").slice(0, 26)}`;
      instance = { dbInstanceIdentifier: identifier, dbiResourceId: resourceId, dbInstanceArn: `arn:aws:rds:${region}:${this.store.accountId}:db:${identifier}`, dbInstanceClass: INSTANCE_CLASS, dbInstanceStatus: "creating", engine: "mysql", engineVersion: snapshot.engineVersion, allocatedStorage: snapshot.allocatedStorage, storageType: snapshot.storageType, ...(snapshot.dbName ? { dbName: snapshot.dbName } : {}), masterUsername, port, backupRetentionPeriod: 0, publiclyAccessible: false, multiAZ: false, deletionProtection: boolean(input.DeletionProtection, false), dbParameterGroupName: group, parameterApplyStatus: group === snapshot.dbParameterGroupName ? "in-sync" : "pending-reboot", appliedParameters: { ...snapshot.appliedParameters }, restoreSourceSnapshotArn: snapshot.dbSnapshotArn, availabilityZone: `${region}a`, instanceCreateTime: this.clock.now(), tags: tags(input.Tags) };
      lease = { accountId: this.store.accountId, region, dbInstanceIdentifier: identifier, dbiResourceId: resourceId, port };
      await this.writeSecret(instance, password); this.store.regionState(region).rdsDbInstances[identifier] = instance; this.store.state.installation.rds.instanceLease = lease;
      try { await this.store.save(); } catch (error) { delete this.store.regionState(region).rdsDbInstances[identifier]; delete this.store.state.installation.rds.instanceLease; await this.deleteSecret(resourceId); throw error; }
    });
    void this.enqueueEngine(() => this.provisionRestore(lease, instance, located.region, snapshot, manifest));
    return structuredClone(instance);
  }

  async delete(region: string, input: any): Promise<RdsDbInstanceState> {
    rejectUnsupportedInput(input, ["DBInstanceIdentifier", "SkipFinalSnapshot", "FinalDBSnapshotIdentifier", "DeleteAutomatedBackups"]);
    const identifier = requiredString(input.DBInstanceIdentifier, "DBInstanceIdentifier").toLowerCase();
    const skipFinalSnapshot = boolean(input.SkipFinalSnapshot, false);
    if (skipFinalSnapshot && input.FinalDBSnapshotIdentifier !== undefined) throw new AwsError("InvalidParameterCombination", "FinalDBSnapshotIdentifier cannot be specified when SkipFinalSnapshot=true");
    if (!skipFinalSnapshot && input.FinalDBSnapshotIdentifier === undefined) throw new AwsError("InvalidParameterCombination", "FinalDBSnapshotIdentifier is required unless SkipFinalSnapshot=true");
    if (input.DeleteAutomatedBackups !== undefined && !boolean(input.DeleteAutomatedBackups, true)) throw new AwsError("InvalidParameterCombination", "Automated backup retention is not supported; DeleteAutomatedBackups cannot be false");
    if (!skipFinalSnapshot) {
      const finalIdentifier = snapshotIdentifier(input.FinalDBSnapshotIdentifier, "FinalDBSnapshotIdentifier");
      const existingFinal = this.store.regionState(region).rdsDbSnapshots[finalIdentifier];
      if (existingFinal && (existingFinal.dbInstanceIdentifier !== identifier || existingFinal.status !== "available")) throw new AwsError("DBSnapshotAlreadyExists", `Final DB snapshot ${finalIdentifier} already exists and is not an available recovery point for ${identifier}`);
      const finalSnapshot = existingFinal ?? await this.createSnapshot(region, { DBInstanceIdentifier: identifier, DBSnapshotIdentifier: finalIdentifier });
      if (finalSnapshot.status !== "available") throw new AwsError("InvalidDBSnapshotState", `Final DB snapshot ${finalSnapshot.dbSnapshotIdentifier} was not published; deletion was not started`);
    }
    let lease!: RdsInstanceLease; let response!: RdsDbInstanceState;
    await this.exclusive(async () => {
      const instance = this.store.regionState(region).rdsDbInstances[identifier];
      if (!instance) throw new AwsError("DBInstanceNotFound", `DB instance ${identifier} was not found`, 404);
      if (instance.deletionProtection) throw new AwsError("InvalidParameterCombination", `Cannot delete protected DB instance ${identifier}`);
      if (!new Set(["available", "stopped", "failed"]).has(instance.dbInstanceStatus)) throw new AwsError("InvalidDBInstanceState", `DB instance ${identifier} cannot be deleted while ${instance.dbInstanceStatus}`);
      const currentLease = this.store.state.installation.rds.instanceLease;
      if (!currentLease || currentLease.dbiResourceId !== instance.dbiResourceId) throw new AwsError("InvalidDBInstanceState", `DB instance ${identifier} does not own the local provider`);
      instance.dbInstanceStatus = "deleting"; delete instance.statusMessage; lease = structuredClone(currentLease); response = structuredClone(instance); await this.store.save();
    });
    void this.enqueueEngine(() => this.removeInstance(lease, this.instanceForLease(lease) ?? response));
    return response;
  }

  /**
   * Private CloudFormation recovery bridge. A failed create can retain the
   * requested deletion-protection bit even though the instance never became
   * modifiable. After the provider verifies its ownership tag, this clears that
   * bit only for the failed state and starts the ordinary durable delete path.
   */
  async cleanupFailedCloudFormationCreate(region: string, dbInstanceIdentifier: string): Promise<void> {
    const identifier = dbInstanceIdentifier.toLowerCase();
    let shouldDelete = false;
    await this.exclusive(async () => {
      const instance = this.store.regionState(region).rdsDbInstances[identifier];
      if (!instance) throw new AwsError("DBInstanceNotFound", `DB instance ${identifier} was not found`, 404);
      if (instance.dbInstanceStatus === "deleting") return;
      if (instance.dbInstanceStatus !== "failed") throw new AwsError("InvalidDBInstanceState", `DB instance ${identifier} is not a failed CloudFormation create`, 409);
      instance.deletionProtection = false;
      await this.store.save();
      shouldDelete = true;
    });
    if (shouldDelete) await this.delete(region, { DBInstanceIdentifier: identifier, SkipFinalSnapshot: true, DeleteAutomatedBackups: true });
  }

  accountQuota(): { used: number; max: number } {
    return { used: this.store.state.installation.rds.instanceLease ? 1 : 0, max: 1 };
  }

  metadata(): { controlPlane: "available"; instanceStatus: RdsDbInstanceState["dbInstanceStatus"] | "none"; ownerRegion?: string; dbInstanceIdentifier?: string } {
    const lease = this.store.state.installation.rds.instanceLease;
    const instance = lease ? this.instanceForLease(lease) : undefined;
    return {
      controlPlane: "available",
      instanceStatus: instance?.dbInstanceStatus ?? "none",
      ...(lease ? { ownerRegion: lease.region, dbInstanceIdentifier: lease.dbInstanceIdentifier } : {}),
    };
  }

  async queryEditorObjects(region: string, dbInstanceIdentifier: string, requestedDatabase?: string): Promise<RdsQueryEditorCatalog> {
    const instance = this.queryEditorInstance(region, dbInstanceIdentifier);
    const databases = await this.queryEditorDatabases(instance);
    const selectedDatabase = this.queryEditorDatabase(databases, requestedDatabase, instance.dbName);
    if (!selectedDatabase) return { databases, selectedDatabase: null, objects: [] };
    const connection = await this.queryEditorConnection(instance, selectedDatabase);
    try {
      const [objectRows] = await connection.query<RowDataPacket[]>("SHOW FULL TABLES");
      const objects: RdsQueryEditorObject[] = [];
      for (const objectRow of objectRows) {
        const name = String(Object.values(objectRow)[0]);
        const type = String(objectRow.Table_type).toUpperCase() === "VIEW" ? "view" : "table";
        const escapedName = name.replaceAll("`", "``");
        const [columnRows] = await connection.query<RowDataPacket[]>(`SHOW FULL COLUMNS FROM \`${escapedName}\``);
        objects.push({
          name,
          type,
          columns: columnRows.map(column => {
            const primaryKey = String(column.Key) === "PRI";
            return {
              name: String(column.Field),
              type: String(column.Type || ""),
              nullable: !primaryKey && String(column.Null) === "YES",
              primaryKey,
              defaultValue: column.Default === null || column.Default === undefined ? null : String(column.Default),
            };
          }),
        });
      }
      return { databases, selectedDatabase, objects };
    } catch (error) {
      throw new AwsError("QueryEditorUnavailable", `Database objects could not be loaded: ${this.safeMessage(error)}`, 503);
    } finally {
      await connection.end().catch(() => undefined);
    }
  }

  async queryEditorExecute(region: string, dbInstanceIdentifier: string, requestedDatabase: unknown, suppliedSql: unknown): Promise<RdsQueryEditorResult> {
    const instance = this.queryEditorInstance(region, dbInstanceIdentifier);
    if (typeof suppliedSql !== "string" || !suppliedSql.trim()) throw new AwsError("InvalidParameterValue", "SQL must be a non-empty string", 400);
    if (Buffer.byteLength(suppliedSql, "utf8") > QUERY_EDITOR_MAX_SQL_BYTES) throw new AwsError("InvalidParameterValue", `SQL must not exceed ${QUERY_EDITOR_MAX_SQL_BYTES} bytes`, 400);
    if (suppliedSql.includes("\0")) throw new AwsError("InvalidParameterValue", "SQL cannot contain a null character", 400);
    if (QUERY_EDITOR_BLOCKED_SQL.test(suppliedSql)) {
      throw new AwsError("InvalidParameterValue", "The query editor does not allow filesystem, extension, PRAGMA, or transaction-control statements", 400);
    }
    if (requestedDatabase !== undefined && requestedDatabase !== null && typeof requestedDatabase !== "string") {
      throw new AwsError("InvalidParameterValue", "database must be a string or null", 400);
    }
    const databases = await this.queryEditorDatabases(instance);
    const selectedDatabase = this.queryEditorDatabase(databases, requestedDatabase as string | null | undefined, instance.dbName);
    const connection = await this.queryEditorConnection(instance, selectedDatabase ?? undefined);
    const started = process.hrtime.bigint();
    try {
      const [result, fields] = await (connection as any).query({
        sql: suppliedSql.trim(),
        rowsAsArray: true,
        timeout: 10_000,
      });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      if (Array.isArray(result)) {
        const rows = result as unknown[][];
        const columnMetadata: RdsQueryEditorResult["columnMetadata"] = (fields ?? []).map((field: FieldPacket) => queryEditorFieldMetadata(field));
        return {
          database: selectedDatabase,
          columns: columnMetadata.map(column => column.name),
          columnMetadata,
          rows: rows.slice(0, QUERY_EDITOR_MAX_ROWS).map(row => row.map(value => this.queryEditorCell(value))),
          rowCount: rows.length,
          truncated: rows.length > QUERY_EDITOR_MAX_ROWS,
          elapsedMs,
        };
      }
      const header = result as ResultSetHeader;
      return {
        database: selectedDatabase,
        columns: [],
        columnMetadata: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        affectedRows: Number(header.affectedRows ?? 0),
        ...(Number(header.insertId ?? 0) > 0 ? { insertId: Number(header.insertId) } : {}),
        elapsedMs,
      };
    } catch (error) {
      const secret = await this.readSecret(instance).catch(() => undefined);
      throw new AwsError("InvalidQuery", this.safeMessage(error, secret?.masterPassword), 400);
    } finally {
      await connection.end().catch(() => undefined);
    }
  }

  /**
   * Private bridge used by the CloudFormation resource provider to rebuild
   * its sensitive canonical model after an asynchronous create or update.
   * This is deliberately not routed by the RDS Query API and never exposes a
   * credential through an SDK response or console model.
   */
  async cloudFormationCredentials(region: string, dbInstanceIdentifier: string): Promise<{ masterUsername: string; masterPassword: string }> {
    const instance = this.requireInstance(region, dbInstanceIdentifier.toLowerCase());
    const secret = await this.readSecret(instance);
    return { masterUsername: secret.masterUsername, masterPassword: secret.pendingMasterPassword ?? secret.masterPassword };
  }

  describeSecretTarget(region: string, targetId: string): { targetArn: string; targetGenerationId: string; engine: "mysql"; host: "127.0.0.1"; port: number; username: string } {
    const instance = targetId.startsWith("arn:")
      ? Object.values(this.store.regionState(region).rdsDbInstances).find(candidate => candidate.dbInstanceArn === targetId)
      : this.store.regionState(region).rdsDbInstances[targetId.toLowerCase()];
    if (!instance) throw new AwsError("ResourceNotFoundException", `RDS target ${targetId} was not found`, 404);
    if (instance.dbInstanceStatus === "deleting" || instance.dbInstanceStatus === "failed") throw new AwsError("InvalidDBInstanceState", `RDS target ${targetId} isn't attachable while ${instance.dbInstanceStatus}`);
    return { targetArn: instance.dbInstanceArn, targetGenerationId: instance.dbiResourceId, engine: "mysql", host: "127.0.0.1", port: instance.port, username: instance.masterUsername };
  }

  private secretRotationTarget(region: string, targetId: string, secretArn: string): RdsDbInstanceState {
    const described = this.describeSecretTarget(region, targetId);
    const instance = Object.values(this.store.regionState(region).rdsDbInstances).find(candidate => candidate.dbInstanceArn === described.targetArn)!;
    if (instance.masterUserSecretArn && instance.masterUserSecretArn !== secretArn) throw new AwsError("InvalidRequestException", "The supplied secret isn't the managed credential for this RDS target", 400);
    if (instance.dbInstanceStatus !== "available") throw new AwsError("InvalidDBInstanceState", `RDS target ${targetId} must be available for rotation`);
    return instance;
  }

  private targetFingerprint(instance: RdsDbInstanceState, secretArn: string, versionId: string, password: string): string {
    return createHmac("sha256", this.store.state.installation.paginationSecret).update(`${instance.dbiResourceId}\0${secretArn}\0${versionId}\0${password}`).digest("hex");
  }

  private async credentialAuthenticates(instance: RdsDbInstanceState, password: string): Promise<boolean> {
    let connection: Connection | undefined;
    try { connection = await mysql.createConnection({ host: "127.0.0.1", port: instance.port, user: instance.masterUsername, password, connectTimeout: 2_000 }); await connection.query("SELECT 1"); return true; }
    catch { return false; }
    finally { await connection?.end().catch(() => undefined); }
  }

  async applySecretRotation(input: { region: string; targetId: string; secretArn: string; secretGenerationId: string; pendingVersionId: string; previousVersionId: string; pendingPassword: string }): Promise<void> {
    const instance = this.secretRotationTarget(input.region, input.targetId, input.secretArn);
    let privateSecret = await this.readSecret(instance);
    const existing = instance.managedCredentialSaga;
    if (existing && (existing.secretArn !== input.secretArn || existing.pendingVersionId !== input.pendingVersionId)) throw new AwsError("InvalidDBInstanceState", "A different managed credential rotation is already active");
    if (!existing) {
      await this.stagePendingPassword(instance, input.pendingPassword);
      await this.exclusive(async () => {
        const current = this.requireInstance(input.region, instance.dbInstanceIdentifier);
        current.managedCredentialSaga = { secretArn: input.secretArn, secretGenerationId: input.secretGenerationId, pendingVersionId: input.pendingVersionId, previousVersionId: input.previousVersionId, credentialGenerationId: randomUUID(), phase: "STAGED", targetApplied: false, targetFingerprint: this.targetFingerprint(current, input.secretArn, input.pendingVersionId, input.pendingPassword), updatedAt: this.clock.now() };
        await this.store.save();
      });
      privateSecret = await this.readSecret(instance);
    }
    const saga = this.requireInstance(input.region, instance.dbInstanceIdentifier).managedCredentialSaga!;
    if (saga.targetFingerprint !== this.targetFingerprint(instance, input.secretArn, input.pendingVersionId, input.pendingPassword)) throw new AwsError("InvalidDBInstanceState", "The managed credential rotation fingerprint doesn't match", 500);
    if (!saga.targetApplied) {
      if (!await this.credentialAuthenticates(instance, input.pendingPassword)) {
        if (!await this.credentialAuthenticates(instance, privateSecret.masterPassword)) throw new AwsError("InvalidDBInstanceState", "Neither retained RDS credential is known to authenticate", 500);
        await this.provider.rotateMasterPassword(this.engineConfig(instance, privateSecret), input.pendingPassword);
      }
      if (!await this.credentialAuthenticates(instance, input.pendingPassword)) throw new AwsError("InvalidDBInstanceState", "The pending RDS credential failed verification", 500);
      await this.exclusive(async () => { const current = this.requireInstance(input.region, instance.dbInstanceIdentifier); const active = current.managedCredentialSaga; if (!active || active.pendingVersionId !== input.pendingVersionId) return; active.targetApplied = true; active.phase = "TARGET_VERIFIED"; active.updatedAt = this.clock.now(); await this.store.save(); });
    }
  }

  async finalizeSecretRotation(region: string, targetId: string, secretArn: string, pendingVersionId: string): Promise<void> {
    const instance = this.secretRotationTarget(region, targetId, secretArn); const saga = instance.managedCredentialSaga;
    if (!saga || saga.pendingVersionId !== pendingVersionId || !saga.targetApplied || saga.phase !== "TARGET_VERIFIED") throw new AwsError("InvalidDBInstanceState", "The RDS credential hasn't passed its target verification checkpoint", 500);
    saga.phase = "FINALIZING"; saga.updatedAt = this.clock.now(); await this.store.save();
    const privateSecret = await this.readSecret(instance); await this.promotePendingPassword(instance, privateSecret);
    await this.exclusive(async () => { const current = this.requireInstance(region, instance.dbInstanceIdentifier); if (current.managedCredentialSaga?.pendingVersionId === pendingVersionId) { delete current.managedCredentialSaga; await this.store.save(); } });
  }

  async compensateSecretRotation(region: string, targetId: string, secretArn: string, pendingVersionId: string): Promise<void> {
    const instance = this.secretRotationTarget(region, targetId, secretArn); const saga = instance.managedCredentialSaga;
    if (!saga || saga.pendingVersionId !== pendingVersionId) return;
    saga.phase = "COMPENSATING"; saga.updatedAt = this.clock.now(); await this.store.save();
    const privateSecret = await this.readSecret(instance);
    if (saga.targetApplied && privateSecret.pendingMasterPassword) {
      if (!await this.credentialAuthenticates(instance, privateSecret.masterPassword)) await this.provider.rotateMasterPassword(this.engineConfig(instance, privateSecret, privateSecret.pendingMasterPassword), privateSecret.masterPassword);
      if (!await this.credentialAuthenticates(instance, privateSecret.masterPassword)) throw new AwsError("InvalidDBInstanceState", "RDS credential compensation couldn't restore the retained credential", 500);
    }
    const restored = { ...privateSecret }; delete restored.pendingMasterPassword; await this.writeSecretValue(instance, restored);
    await this.exclusive(async () => { const current = this.requireInstance(region, instance.dbInstanceIdentifier); if (current.managedCredentialSaga?.pendingVersionId === pendingVersionId) { delete current.managedCredentialSaga; await this.store.save(); } });
  }

  async modify(region: string, input: any): Promise<RdsDbInstanceState> {
    rejectUnsupportedInput(input, ["DBInstanceIdentifier", "AllocatedStorage", "DBInstanceClass", "ApplyImmediately", "MasterUserPassword", "ManageMasterUserPassword", "MasterUserSecretKmsKeyId", "DBParameterGroupName", "BackupRetentionPeriod", "MultiAZ", "EngineVersion", "AutoMinorVersionUpgrade", "PubliclyAccessible", "StorageType", "DBPortNumber", "DeletionProtection"]);
    if (input.MasterUserSecretKmsKeyId !== undefined) throw new AwsError("InvalidParameterCombination", "MasterUserSecretKmsKeyId requires customer KMS, which is outside the local profile");
    const identifier = requiredString(input.DBInstanceIdentifier, "DBInstanceIdentifier").toLowerCase();
    const applyImmediately = boolean(input.ApplyImmediately, false);
    const suppliedChanges = ["AllocatedStorage", "DBInstanceClass", "MasterUserPassword", "ManageMasterUserPassword", "DBParameterGroupName", "StorageType", "DBPortNumber", "DeletionProtection"].filter(field => input[field] !== undefined);
    if (!suppliedChanges.length && input.BackupRetentionPeriod === undefined && input.MultiAZ === undefined && input.EngineVersion === undefined && input.AutoMinorVersionUpgrade === undefined && input.PubliclyAccessible === undefined) throw new AwsError("InvalidParameterCombination", "At least one locally supported modification must be supplied");
    if (input.BackupRetentionPeriod !== undefined && integer(input.BackupRetentionPeriod, 0, "BackupRetentionPeriod") !== 0) throw new AwsError("InvalidParameterCombination", "Automated backups are not supported; BackupRetentionPeriod must remain 0");
    if (input.MultiAZ !== undefined && boolean(input.MultiAZ, false)) throw new AwsError("InvalidParameterCombination", "MultiAZ is not supported by the local RDS profile");
    if (input.PubliclyAccessible !== undefined && boolean(input.PubliclyAccessible, false)) throw new AwsError("InvalidParameterCombination", "PubliclyAccessible must remain false");
    if (input.EngineVersion !== undefined && String(input.EngineVersion) !== COMPATIBILITY_ENGINE_VERSION) throw new AwsError("InvalidParameterValue", `Only MySQL compatibility version ${COMPATIBILITY_ENGINE_VERSION} is supported`);
    if (input.AutoMinorVersionUpgrade !== undefined && boolean(input.AutoMinorVersionUpgrade, false)) throw new AwsError("InvalidParameterCombination", "Automatic engine upgrades are not supported locally");

    let response!: RdsDbInstanceState; let lease!: RdsInstanceLease; let runWorker = false;
    await this.exclusive(async () => {
      const instance = this.requireInstance(region, identifier);
      if (!new Set(["available", "stopped"]).has(instance.dbInstanceStatus)) throw new AwsError("InvalidDBInstanceState", `DB instance ${identifier} cannot be modified while ${instance.dbInstanceStatus}`);
      if (instance.manageMasterUserPassword && input.MasterUserPassword !== undefined && input.ManageMasterUserPassword !== false && input.ManageMasterUserPassword !== "false") throw new AwsError("InvalidParameterCombination", "MasterUserPassword can't be supplied while RDS manages the master user secret");
      if (input.ManageMasterUserPassword !== undefined && boolean(input.ManageMasterUserPassword, false) && input.MasterUserPassword !== undefined) throw new AwsError("InvalidParameterCombination", "ManageMasterUserPassword and MasterUserPassword are mutually exclusive");
      lease = this.requireLease(instance);
      const pending: RdsPendingModifiedValuesState = { ...(instance.pendingModifiedValues ?? {}) };
      if (input.AllocatedStorage !== undefined) {
        const value = integer(input.AllocatedStorage, instance.allocatedStorage, "AllocatedStorage");
        if (value < 20 || value > 65_536) throw new AwsError("InvalidParameterValue", "AllocatedStorage must be between 20 and 65536 GiB; it is descriptor-only locally");
        if (value !== instance.allocatedStorage) pending.allocatedStorage = value; else delete pending.allocatedStorage;
      }
      if (input.DBInstanceClass !== undefined) {
        if (String(input.DBInstanceClass) !== INSTANCE_CLASS) throw new AwsError("InvalidParameterValue", `Only ${INSTANCE_CLASS} is supported`);
        delete pending.dbInstanceClass;
      }
      if (input.StorageType !== undefined) {
        const value = String(input.StorageType) as "gp2" | "gp3";
        if (!new Set(["gp2", "gp3"]).has(value)) throw new AwsError("InvalidParameterValue", "Only gp2 and gp3 storage descriptors are supported");
        if (value !== instance.storageType) pending.storageType = value; else delete pending.storageType;
      }
      if (input.DBPortNumber !== undefined) {
        const value = integer(input.DBPortNumber, instance.port, "DBPortNumber");
        if (value < 1150 || value > 65_535) throw new AwsError("InvalidParameterValue", "DBPortNumber must be between 1150 and 65535");
        if (value !== instance.port) pending.port = value; else delete pending.port;
      }
      if (input.MasterUserPassword !== undefined) {
        const value = validatePassword(input.MasterUserPassword);
        await this.stagePendingPassword(instance, value);
        pending.masterUserPassword = true;
      }
      if (input.ManageMasterUserPassword !== undefined) {
        const enabled = boolean(input.ManageMasterUserPassword, false);
        const port = this.managedSecrets.get(region);
        if (!port) throw new AwsError("InvalidDBInstanceState", "Secrets Manager isn't ready for managed RDS credentials", 503);
        if (enabled && !instance.manageMasterUserPassword) {
          const currentCredential = await this.readSecret(instance);
          const managed = await port.create({ resourceId: instance.dbiResourceId, targetArn: instance.dbInstanceArn, dbInstanceIdentifier: instance.dbInstanceIdentifier, username: instance.masterUsername, port: instance.port, currentPassword: currentCredential.masterPassword });
          instance.manageMasterUserPassword = true; instance.masterUserSecretArn = managed.arn;
        } else if (!enabled && instance.manageMasterUserPassword) {
          if (!instance.masterUserSecretArn) throw new AwsError("InvalidDBInstanceState", "The managed master-user secret identity is missing", 500);
          await port.delete(instance.masterUserSecretArn, instance.dbInstanceArn);
          delete instance.manageMasterUserPassword; delete instance.masterUserSecretArn; delete instance.managedCredentialSaga;
        }
      }
      if (input.DeletionProtection !== undefined) instance.deletionProtection = boolean(input.DeletionProtection, instance.deletionProtection);
      if (input.DBParameterGroupName !== undefined) {
        const name = parameterGroupName(input.DBParameterGroupName);
        if (name !== DEFAULT_PARAMETER_GROUP && !this.store.regionState(region).rdsDbParameterGroups[name]) throw new AwsError("DBParameterGroupNotFound", `DB parameter group ${name} was not found`, 404);
        instance.dbParameterGroupName = name;
        this.refreshParameterApplyStatus(region, instance);
      }
      instance.pendingModifiedValues = Object.keys(pending).length ? pending : undefined;
      runWorker = instance.dbInstanceStatus === "available" && (Boolean(pending.masterUserPassword) || (applyImmediately && Object.keys(pending).some(key => key !== "masterUserPassword")));
      if (runWorker) { instance.dbInstanceStatus = "modifying"; instance.lifecycleOperation = "modify"; instance.applyPendingConfiguration = applyImmediately; delete instance.statusMessage; }
      await this.store.save(); response = structuredClone(instance);
    });
    if (runWorker) void this.enqueueEngine(() => this.applyPending(lease, "modify"));
    return response;
  }

  async reboot(region: string, input: any): Promise<RdsDbInstanceState> {
    rejectUnsupportedInput(input, ["DBInstanceIdentifier", "ForceFailover"]);
    if (boolean(input.ForceFailover, false)) throw new AwsError("InvalidParameterCombination", "ForceFailover requires Multi-AZ and is not supported locally");
    return this.beginLifecycle(region, input.DBInstanceIdentifier, "available", "rebooting", "reboot", lease => this.applyPending(lease, "reboot"));
  }

  async stopInstance(region: string, input: any): Promise<RdsDbInstanceState> {
    rejectUnsupportedInput(input, ["DBInstanceIdentifier", "DBSnapshotIdentifier"]);
    if (input.DBSnapshotIdentifier !== undefined) {
      const snapshot = await this.createSnapshot(region, { DBInstanceIdentifier: input.DBInstanceIdentifier, DBSnapshotIdentifier: input.DBSnapshotIdentifier });
      if (snapshot.status !== "available") throw new AwsError("InvalidDBSnapshotState", `Stop snapshot ${snapshot.dbSnapshotIdentifier} was not published; stop was not started`);
    }
    return this.beginLifecycle(region, input.DBInstanceIdentifier, "available", "stopping", "stop", lease => this.finishStop(lease));
  }

  async startInstance(region: string, input: any): Promise<RdsDbInstanceState> {
    rejectUnsupportedInput(input, ["DBInstanceIdentifier"]);
    return this.beginLifecycle(region, input.DBInstanceIdentifier, "stopped", "starting", "start", lease => this.finishStart(lease));
  }

  validModifications(region: string, input: any): Record<string, unknown> {
    rejectUnsupportedInput(input, ["DBInstanceIdentifier"]);
    this.requireInstance(region, requiredString(input.DBInstanceIdentifier, "DBInstanceIdentifier").toLowerCase());
    const option = (storageType: "gp2" | "gp3") => ({ StorageType: storageType, StorageSize: awsQueryList("Range", [{ From: 20, To: 65_536, Step: 1 }]), ProvisionedIops: awsQueryList("Range", []), IopsToStorageRatio: awsQueryList("DoubleRange", []), ProvisionedStorageThroughput: awsQueryList("Range", []), StorageThroughputToIopsRatio: awsQueryList("DoubleRange", []), SupportsStorageAutoscaling: false });
    return { ValidDBInstanceModificationsMessage: { Storage: awsQueryList("ValidStorageOptions", [option("gp2"), option("gp3")]), ValidProcessorFeatures: awsQueryList("AvailableProcessorFeature", []), SupportsDedicatedLogVolume: false, AdditionalStorage: { SupportsAdditionalStorageVolumes: false, Volumes: awsQueryList("ValidVolumeOptions", []) } } };
  }

  async addTags(region: string, input: any): Promise<void> {
    rejectUnsupportedInput(input, ["ResourceName", "Tags"]);
    const resource = this.taggedResource(region, requiredString(input.ResourceName, "ResourceName")); const additions = tags(input.Tags);
    const merged = { ...resource.tags, ...additions };
    if (Object.keys(merged).length > 50) throw new AwsError("InvalidParameterValue", "A maximum of 50 tags is allowed");
    resource.replace(merged); await this.store.save();
  }

  async removeTags(region: string, input: any): Promise<void> {
    rejectUnsupportedInput(input, ["ResourceName", "TagKeys"]);
    const resource = this.taggedResource(region, requiredString(input.ResourceName, "ResourceName"));
    const keys = namedList(input.TagKeys, "member").map(String);
    if (!keys.length) throw new AwsError("InvalidParameterValue", "At least one TagKey is required");
    for (const key of keys) if (!key || key.length > 128 || key.toLowerCase().startsWith("aws:")) throw new AwsError("InvalidParameterValue", "Tag keys are invalid");
    const next = { ...resource.tags }; for (const key of keys) delete next[key]; resource.replace(next); await this.store.save();
  }

  listTags(region: string, input: any): Record<string, string> {
    rejectUnsupportedInput(input, ["ResourceName", "Filters"]);
    if (namedList(input.Filters, "Filter").length) throw new AwsError("InvalidParameterCombination", "Tag filters are not supported by the local RDS profile");
    return { ...this.taggedResource(region, requiredString(input.ResourceName, "ResourceName")).tags };
  }

  async createParameterGroup(region: string, input: any): Promise<RdsDbParameterGroupState> {
    rejectUnsupportedInput(input, ["DBParameterGroupName", "DBParameterGroupFamily", "Description", "Tags"]);
    const name = parameterGroupName(input.DBParameterGroupName);
    if (name === DEFAULT_PARAMETER_GROUP) throw new AwsError("DBParameterGroupAlreadyExists", `DB parameter group ${name} already exists`);
    if (requiredString(input.DBParameterGroupFamily, "DBParameterGroupFamily") !== PARAMETER_GROUP_FAMILY) throw new AwsError("InvalidParameterValue", `Only parameter group family ${PARAMETER_GROUP_FAMILY} is supported`);
    const description = requiredString(input.Description, "Description");
    if (description.length > 255) throw new AwsError("InvalidParameterValue", "Description must be 255 characters or fewer");
    let created!: RdsDbParameterGroupState;
    await this.exclusive(async () => {
      const regional = this.store.regionState(region);
      if (regional.rdsDbParameterGroups[name]) throw new AwsError("DBParameterGroupAlreadyExists", `DB parameter group ${name} already exists`);
      created = { dbParameterGroupName: name, dbParameterGroupFamily: PARAMETER_GROUP_FAMILY, description, dbParameterGroupArn: `arn:aws:rds:${region}:${this.store.accountId}:pg:${name}`, createdAt: this.clock.now(), tags: tags(input.Tags), parameters: {} };
      regional.rdsDbParameterGroups[name] = created; await this.store.save();
    });
    return structuredClone(created);
  }

  describeParameterGroups(region: string, input: any): Array<RdsDbParameterGroupState | undefined> {
    rejectUnsupportedInput(input, ["DBParameterGroupName", "MaxRecords", "Marker"]);
    if (input.Marker !== undefined) throw new AwsError("InvalidParameterValue", "Marker is invalid");
    const maxRecords = input.MaxRecords === undefined ? 100 : integer(input.MaxRecords, 100, "MaxRecords");
    if (maxRecords < 20 || maxRecords > 100) throw new AwsError("InvalidParameterValue", "MaxRecords must be between 20 and 100");
    if (input.DBParameterGroupName !== undefined) {
      const name = parameterGroupName(input.DBParameterGroupName);
      if (name === DEFAULT_PARAMETER_GROUP) return [undefined];
      const group = this.store.regionState(region).rdsDbParameterGroups[name];
      if (!group) throw new AwsError("DBParameterGroupNotFound", `DB parameter group ${name} was not found`, 404);
      return [structuredClone(group)];
    }
    return [undefined, ...Object.values(this.store.regionState(region).rdsDbParameterGroups).sort((left, right) => left.dbParameterGroupName.localeCompare(right.dbParameterGroupName)).map(group => structuredClone(group))].slice(0, maxRecords);
  }

  async modifyParameterGroup(region: string, input: any): Promise<string> {
    rejectUnsupportedInput(input, ["DBParameterGroupName", "Parameters"]);
    const name = parameterGroupName(input.DBParameterGroupName); const group = this.requireCustomParameterGroup(region, name);
    const requested = namedList(input.Parameters, "Parameter");
    if (!requested.length || requested.length > 20) throw new AwsError("InvalidParameterValue", "ModifyDBParameterGroup requires 1 through 20 parameters");
    const updates: Array<{ name: string; value: string; applyMethod: "immediate" | "pending-reboot" }> = [];
    for (const parameter of requested) {
      const parameterName = requiredString(parameter?.ParameterName, "ParameterName"); const validated = validateParameterValue(parameterName, parameter?.ParameterValue);
      const applyMethod = String(parameter?.ApplyMethod ?? "immediate") as "immediate" | "pending-reboot";
      if (!new Set(["immediate", "pending-reboot"]).has(applyMethod) || (validated.definition.applyType === "static" && applyMethod !== "pending-reboot")) throw new AwsError("InvalidParameterCombination", `Parameter ${parameterName} requires ApplyMethod=pending-reboot`);
      updates.push({ name: parameterName, value: validated.value, applyMethod });
    }
    await this.applyParameterGroupChanges(region, group, updates.map(update => ({ ...update, reset: false })));
    return name;
  }

  async resetParameterGroup(region: string, input: any): Promise<string> {
    rejectUnsupportedInput(input, ["DBParameterGroupName", "ResetAllParameters", "Parameters"]);
    const name = parameterGroupName(input.DBParameterGroupName); const group = this.requireCustomParameterGroup(region, name);
    const resetAll = boolean(input.ResetAllParameters, false); const requested = namedList(input.Parameters, "Parameter");
    if (resetAll === Boolean(requested.length)) throw new AwsError("InvalidParameterCombination", "Specify ResetAllParameters=true or a nonempty Parameters list, but not both");
    const names = resetAll ? Object.keys(group.parameters) : requested.map(parameter => requiredString(parameter?.ParameterName, "ParameterName"));
    const updates = names.map(parameterName => {
      const definition = parameterDefinition(parameterName); const requestedParameter = requested.find(parameter => parameter?.ParameterName === parameterName);
      const applyMethod = String(requestedParameter?.ApplyMethod ?? (definition.applyType === "static" ? "pending-reboot" : "immediate")) as "immediate" | "pending-reboot";
      if (!new Set(["immediate", "pending-reboot"]).has(applyMethod) || (definition.applyType === "static" && applyMethod !== "pending-reboot")) throw new AwsError("InvalidParameterCombination", `Parameter ${parameterName} requires ApplyMethod=pending-reboot`);
      return { name: parameterName, value: definition.defaultValue, applyMethod, reset: true };
    });
    await this.applyParameterGroupChanges(region, group, updates); return name;
  }

  async deleteParameterGroup(region: string, input: any): Promise<void> {
    rejectUnsupportedInput(input, ["DBParameterGroupName"]);
    const name = parameterGroupName(input.DBParameterGroupName); this.requireCustomParameterGroup(region, name);
    if (Object.values(this.store.regionState(region).rdsDbInstances).some(instance => instance.dbParameterGroupName === name)) throw new AwsError("InvalidDBParameterGroupState", `DB parameter group ${name} is associated with a DB instance`);
    delete this.store.regionState(region).rdsDbParameterGroups[name]; await this.store.save();
  }

  describeParameters(region: string, input: any, defaultsOnly = false): Array<Record<string, unknown>> {
    const supported = defaultsOnly ? ["DBParameterGroupFamily", "MaxRecords", "Marker"] : ["DBParameterGroupName", "Source", "Filters", "MaxRecords", "Marker"];
    rejectUnsupportedInput(input, supported);
    if (input.Marker !== undefined) throw new AwsError("InvalidParameterValue", "Marker is invalid");
    let group: RdsDbParameterGroupState | undefined;
    if (defaultsOnly) {
      if (requiredString(input.DBParameterGroupFamily, "DBParameterGroupFamily") !== PARAMETER_GROUP_FAMILY) throw new AwsError("DBParameterGroupNotFound", `Parameter group family ${input.DBParameterGroupFamily} was not found`, 404);
    } else {
      const name = parameterGroupName(input.DBParameterGroupName); group = name === DEFAULT_PARAMETER_GROUP ? undefined : this.requireCustomParameterGroup(region, name);
    }
    let definitions = [...RDS_PARAMETER_DEFINITIONS];
    if (!defaultsOnly && input.Source !== undefined) {
      const source = String(input.Source); if (!new Set(["user", "engine-default", "system"]).has(source)) throw new AwsError("InvalidParameterValue", "Source must be user, system, or engine-default");
      definitions = definitions.filter(definition => source === "user" ? Boolean(group?.parameters[definition.name]) : source === "engine-default" ? !group?.parameters[definition.name] : !definition.modifiable);
    }
    if (!defaultsOnly) for (const filter of namedList(input.Filters, "Filter")) {
      if (String(filter?.Name) !== "parameter-name") throw new AwsError("InvalidParameterValue", `Unsupported RDS parameter filter ${filter?.Name}`);
      const values = namedList(filter?.Values, "Value").map(String); if (!values.length) throw new AwsError("InvalidParameterValue", "parameter-name filter requires a value"); definitions = definitions.filter(definition => values.includes(definition.name));
    }
    const maxRecords = input.MaxRecords === undefined ? 100 : integer(input.MaxRecords, 100, "MaxRecords");
    if (maxRecords < 20 || maxRecords > 100) throw new AwsError("InvalidParameterValue", "MaxRecords must be between 20 and 100");
    return definitions.slice(0, maxRecords).map(definition => {
      const override = group?.parameters[definition.name];
      return { ParameterName: definition.name, ParameterValue: override?.value ?? definition.defaultValue, Description: definition.description, Source: override ? "user" : "engine-default", ApplyType: definition.applyType, DataType: definition.dataType, AllowedValues: definition.allowedValues, IsModifiable: definition.modifiable, MinimumEngineVersion: COMPATIBILITY_ENGINE_VERSION, ApplyMethod: override?.applyMethod ?? (definition.applyType === "static" ? "pending-reboot" : "immediate"), SupportedEngineModes: awsQueryList("member", ["provisioned"]) };
    });
  }

  private async beginLifecycle(
    region: string,
    rawIdentifier: unknown,
    expected: RdsDbInstanceState["dbInstanceStatus"],
    next: RdsDbInstanceState["dbInstanceStatus"],
    operation: NonNullable<RdsDbInstanceState["lifecycleOperation"]>,
    worker: (lease: RdsInstanceLease) => Promise<void>,
  ): Promise<RdsDbInstanceState> {
    const identifier = requiredString(rawIdentifier, "DBInstanceIdentifier").toLowerCase(); let lease!: RdsInstanceLease; let response!: RdsDbInstanceState;
    await this.exclusive(async () => {
      const instance = this.requireInstance(region, identifier);
      if (instance.dbInstanceStatus !== expected) throw new AwsError("InvalidDBInstanceState", `DB instance ${identifier} must be ${expected} before ${operation}`);
      lease = this.requireLease(instance); instance.dbInstanceStatus = next; instance.lifecycleOperation = operation; delete instance.statusMessage; await this.store.save(); response = structuredClone(instance);
    });
    void this.enqueueEngine(() => worker(lease)); return response;
  }

  private requireInstance(region: string, identifier: string): RdsDbInstanceState {
    const instance = this.store.regionState(region).rdsDbInstances[identifier];
    if (!instance) throw new AwsError("DBInstanceNotFound", `DB instance ${identifier} was not found`, 404);
    return instance;
  }

  private queryEditorInstance(region: string, rawIdentifier: string): RdsDbInstanceState {
    const identifier = requiredString(rawIdentifier, "DBInstanceIdentifier").toLowerCase();
    const instance = this.requireInstance(region, identifier);
    if (instance.dbInstanceStatus !== "available") {
      throw new AwsError("InvalidDBInstanceState", `DB instance ${identifier} must be available before using the query editor`, 409);
    }
    this.requireLease(instance);
    return instance;
  }

  private async queryEditorDatabases(instance: RdsDbInstanceState): Promise<string[]> {
    const connection = await this.queryEditorConnection(instance);
    try {
      const [rows] = await connection.query<RowDataPacket[]>("SHOW DATABASES");
      return rows.map(row => String(row.Database)).sort((left, right) => left.localeCompare(right));
    } catch (error) {
      throw new AwsError("QueryEditorUnavailable", `Databases could not be listed: ${this.safeMessage(error)}`, 503);
    } finally {
      await connection.end().catch(() => undefined);
    }
  }

  private queryEditorDatabase(databases: string[], requested: string | null | undefined, fallback?: string): string | null {
    const wanted = requested === undefined || requested === null ? fallback : requested;
    if (wanted === undefined || wanted === null) return databases[0] ?? null;
    if (!/^[A-Za-z][A-Za-z0-9_$]{0,63}$/.test(wanted)) throw new AwsError("InvalidParameterValue", "database is not a valid local database name", 400);
    const selected = databases.find(database => database.toLowerCase() === wanted.toLowerCase());
    if (!selected) throw new AwsError("DatabaseNotFound", `Database ${wanted} was not found`, 404);
    return selected;
  }

  private async queryEditorConnection(instance: RdsDbInstanceState, database?: string): Promise<Connection> {
    const secret = await this.readSecret(instance);
    try {
      return await mysql.createConnection({
        host: "127.0.0.1",
        port: instance.port,
        user: secret.masterUsername,
        password: secret.masterPassword,
        ...(database ? { database } : {}),
        connectTimeout: 5_000,
        supportBigNumbers: true,
        bigNumberStrings: true,
        multipleStatements: false,
      });
    } catch (error) {
      throw new AwsError("QueryEditorUnavailable", `The query editor could not connect to ${instance.dbInstanceIdentifier}: ${this.safeMessage(error, secret.masterPassword)}`, 503);
    }
  }

  private queryEditorCell(value: unknown): RdsQueryEditorCell {
    if (value === null || value === undefined) return null;
    if (typeof value === "boolean" || typeof value === "string") {
      const text = String(value);
      return text.length > QUERY_EDITOR_MAX_CELL_CHARACTERS ? `${text.slice(0, QUERY_EDITOR_MAX_CELL_CHARACTERS)}…` : value;
    }
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Uint8Array) {
      const bytes = Buffer.from(value);
      const limited = bytes.subarray(0, Math.floor(QUERY_EDITOR_MAX_CELL_CHARACTERS / 2));
      return `0x${limited.toString("hex")}${limited.length < bytes.length ? "…" : ""}`;
    }
    if (value instanceof Date) return value.toISOString();
    let text: string;
    try { text = JSON.stringify(value); }
    catch { text = String(value); }
    return text.length > QUERY_EDITOR_MAX_CELL_CHARACTERS ? `${text.slice(0, QUERY_EDITOR_MAX_CELL_CHARACTERS)}…` : text;
  }

  private requireLease(instance: RdsDbInstanceState): RdsInstanceLease {
    const lease = this.store.state.installation.rds.instanceLease;
    if (!lease || lease.dbiResourceId !== instance.dbiResourceId) throw new AwsError("InvalidDBInstanceState", `DB instance ${instance.dbInstanceIdentifier} does not own the local provider`);
    return structuredClone(lease);
  }

  private parameterGroup(region: string, name: string): RdsDbParameterGroupState | undefined {
    if (name === DEFAULT_PARAMETER_GROUP) return undefined;
    return this.store.regionState(region).rdsDbParameterGroups[name];
  }

  private requireCustomParameterGroup(region: string, name: string): RdsDbParameterGroupState {
    if (name === DEFAULT_PARAMETER_GROUP) throw new AwsError("InvalidDBParameterGroupState", `DB parameter group ${name} is provider-owned and cannot be changed`);
    const group = this.store.regionState(region).rdsDbParameterGroups[name];
    if (!group) throw new AwsError("DBParameterGroupNotFound", `DB parameter group ${name} was not found`, 404);
    return group;
  }

  private refreshParameterApplyStatus(region: string, instance: RdsDbInstanceState): void {
    const desired = effectiveParameterValues(this.parameterGroup(region, instance.dbParameterGroupName));
    instance.parameterApplyStatus = Object.entries(desired).every(([name, value]) => instance.appliedParameters[name] === value) ? "in-sync" : "pending-reboot";
  }

  private async applyParameterGroupChanges(
    region: string,
    group: RdsDbParameterGroupState,
    updates: Array<{ name: string; value: string; applyMethod: "immediate" | "pending-reboot"; reset: boolean }>,
  ): Promise<void> {
    if (new Set(updates.map(update => update.name)).size !== updates.length) throw new AwsError("InvalidParameterValue", "Each parameter may be changed only once per request");
    const instance = Object.values(this.store.regionState(region).rdsDbInstances).find(candidate => candidate.dbParameterGroupName === group.dbParameterGroupName);
    if (instance && !new Set(["available", "stopped"]).has(instance.dbInstanceStatus)) throw new AwsError("InvalidDBInstanceState", `Associated DB instance ${instance.dbInstanceIdentifier} is ${instance.dbInstanceStatus}`);
    const immediate = Object.fromEntries(updates.filter(update => update.applyMethod === "immediate" && parameterDefinition(update.name).applyType === "dynamic").map(update => [update.name, update.value]));
    if (instance && instance.dbInstanceStatus === "available" && Object.keys(immediate).length) {
      const secret = await this.readSecret(instance); await this.provider.applyParameters(this.engineConfig(instance, secret), immediate);
    }
    for (const update of updates) {
      if (update.reset) delete group.parameters[update.name];
      else group.parameters[update.name] = { value: update.value, applyMethod: update.applyMethod, modifiedAt: this.clock.now() };
      if (instance && update.applyMethod === "immediate" && parameterDefinition(update.name).applyType === "dynamic") instance.appliedParameters[update.name] = update.value;
    }
    if (instance) this.refreshParameterApplyStatus(region, instance);
    await this.store.save();
  }

  private taggedResource(region: string, arn: string): { tags: Record<string, string>; replace(value: Record<string, string>): void } {
    const prefix = `arn:aws:rds:${region}:${this.store.accountId}:`; if (!arn.startsWith(prefix)) throw new AwsError("InvalidParameterValue", "ResourceName must be an RDS ARN in the requested Region and account");
    const instance = Object.values(this.store.regionState(region).rdsDbInstances).find(candidate => candidate.dbInstanceArn === arn);
    if (instance) return { tags: { ...instance.tags }, replace: value => { instance.tags = value; } };
    const group = Object.values(this.store.regionState(region).rdsDbParameterGroups).find(candidate => candidate.dbParameterGroupArn === arn);
    if (group) return { tags: { ...group.tags }, replace: value => { group.tags = value; } };
    const snapshot = Object.values(this.store.regionState(region).rdsDbSnapshots).find(candidate => candidate.dbSnapshotArn === arn);
    if (snapshot) return { tags: { ...snapshot.tags }, replace: value => { snapshot.tags = value; } };
    throw new AwsError("InvalidParameterValue", "ResourceName does not identify a local RDS DB instance, DB snapshot, or parameter group");
  }

  private async finishStop(lease: RdsInstanceLease): Promise<void> {
    try {
      await this.provider.stop();
      await this.exclusive(async () => { const current = this.instanceForLease(lease); if (!current) return; current.dbInstanceStatus = "stopped"; delete current.lifecycleOperation; delete current.statusMessage; await this.store.save(); });
    } catch (error) {
      await this.exclusive(async () => { const current = this.instanceForLease(lease); if (!current) return; current.dbInstanceStatus = "failed"; delete current.lifecycleOperation; current.statusMessage = `Stop failed: ${this.safeMessage(error)}`; await this.store.save(); });
    }
  }

  private async finishStart(lease: RdsInstanceLease): Promise<void> {
    let listenerReady = false;
    try {
      const instance = this.instanceForLease(lease); if (!instance) return;
      let secret = await this.readSecret(instance); secret = await this.discardUntrackedPendingPassword(instance, secret); const started = await this.startWithCredentialCandidates(instance, secret, instance.appliedParameters); listenerReady = true;
      if (secret.pendingMasterPassword) {
        if (started.password !== secret.pendingMasterPassword) await this.provider.rotateMasterPassword(this.engineConfig(instance, secret, started.password), secret.pendingMasterPassword);
        secret = await this.promotePendingPassword(instance, secret);
      }
      await this.exclusive(async () => {
        const current = this.instanceForLease(lease); if (!current) return;
        if (current.pendingModifiedValues?.masterUserPassword) { delete current.pendingModifiedValues.masterUserPassword; if (!Object.keys(current.pendingModifiedValues).length) delete current.pendingModifiedValues; }
        current.dbInstanceStatus = "available"; delete current.lifecycleOperation; delete current.statusMessage; await this.store.save();
      });
    } catch (error) {
      try { await this.provider.stop(); } catch {}
      await this.exclusive(async () => { const current = this.instanceForLease(lease); if (!current) return; current.dbInstanceStatus = listenerReady ? "failed" : "stopped"; delete current.lifecycleOperation; current.statusMessage = `Start failed: ${this.safeMessage(error)}`; await this.store.save(); });
    }
  }

  private async applyPending(lease: RdsInstanceLease, mode: "modify" | "reboot"): Promise<void> {
    let listenerRecovered = false; let passwordPromoted = false; let recoveredAppliedPort: number | undefined;
    try {
      const instance = this.instanceForLease(lease); if (!instance) return;
      const original = structuredClone(instance); const pending = { ...(instance.pendingModifiedValues ?? {}) }; const applyConfiguration = mode === "reboot" || Boolean(instance.applyPendingConfiguration);
      const desiredPort = applyConfiguration ? pending.port ?? original.port : original.port;
      let secret = await this.readSecret(instance); let runningInstance = original; let started;
      try { started = await this.startWithCredentialCandidates(runningInstance, secret, original.appliedParameters); }
      catch (error) {
        if (desiredPort === original.port) throw error;
        runningInstance = { ...original, port: desiredPort }; started = await this.startWithCredentialCandidates(runningInstance, secret, original.appliedParameters); recoveredAppliedPort = desiredPort;
      }
      listenerRecovered = true;
      let activePassword = started.password;
      if (secret.pendingMasterPassword) {
        if (activePassword !== secret.pendingMasterPassword) await this.provider.rotateMasterPassword(this.engineConfig(runningInstance, secret, activePassword), secret.pendingMasterPassword);
        activePassword = secret.pendingMasterPassword; secret = await this.promotePendingPassword(instance, secret); passwordPromoted = true;
      }
      if (desiredPort !== runningInstance.port) await this.assertPortAvailable(desiredPort);
      const desiredParameters = mode === "reboot" ? effectiveParameterValues(this.parameterGroup(lease.region, original.dbParameterGroupName)) : { ...original.appliedParameters };
      const mustRestart = mode === "reboot" || desiredPort !== runningInstance.port;
      if (mustRestart) {
        const currentConfig = this.engineConfig(runningInstance, secret, activePassword, original.appliedParameters);
        const nextConfig = { ...currentConfig, port: desiredPort, parameters: desiredParameters };
        await this.provider.stop(); listenerRecovered = false;
        if (desiredPort !== runningInstance.port) await this.provider.reconfigure(currentConfig, nextConfig);
        try {
          await this.provider.start(nextConfig); const runtime = await this.provider.readiness(nextConfig); if (!runtime.ready) throw new Error(runtime.diagnostic ?? "The modified SQL listener is not ready"); listenerRecovered = true; if (desiredPort !== original.port) recoveredAppliedPort = desiredPort;
        } catch (error) {
          try { await this.provider.stop(); } catch {}
          if (desiredPort !== runningInstance.port) await this.provider.reconfigure(nextConfig, currentConfig);
          await this.provider.start(currentConfig); const rollback = await this.provider.readiness(currentConfig); if (!rollback.ready) throw new Error(`Port rollback failed: ${rollback.diagnostic ?? "old listener is not ready"}`); listenerRecovered = true; throw error;
        }
      }
      await this.exclusive(async () => {
        const current = this.instanceForLease(lease); if (!current) return;
        if (applyConfiguration && pending.allocatedStorage !== undefined) current.allocatedStorage = pending.allocatedStorage;
        if (applyConfiguration && pending.dbInstanceClass !== undefined) current.dbInstanceClass = pending.dbInstanceClass;
        if (applyConfiguration && pending.storageType !== undefined) current.storageType = pending.storageType;
        if (applyConfiguration && pending.port !== undefined) { current.port = pending.port; const currentLease = this.store.state.installation.rds.instanceLease; if (currentLease?.dbiResourceId === current.dbiResourceId) currentLease.port = pending.port; }
        if (mode === "reboot") current.appliedParameters = desiredParameters;
        if (applyConfiguration) delete current.pendingModifiedValues;
        else if (current.pendingModifiedValues?.masterUserPassword) { delete current.pendingModifiedValues.masterUserPassword; if (!Object.keys(current.pendingModifiedValues).length) delete current.pendingModifiedValues; }
        delete current.applyPendingConfiguration; this.refreshParameterApplyStatus(lease.region, current); current.dbInstanceStatus = "available"; delete current.lifecycleOperation; delete current.statusMessage; await this.store.save();
      });
    } catch (error) {
      await this.exclusive(async () => {
        const current = this.instanceForLease(lease); if (!current) return;
        if (listenerRecovered && recoveredAppliedPort !== undefined && current.port !== recoveredAppliedPort) { current.port = recoveredAppliedPort; const currentLease = this.store.state.installation.rds.instanceLease; if (currentLease?.dbiResourceId === current.dbiResourceId) currentLease.port = recoveredAppliedPort; if (current.pendingModifiedValues?.port === recoveredAppliedPort) delete current.pendingModifiedValues.port; }
        if (passwordPromoted && current.pendingModifiedValues?.masterUserPassword) delete current.pendingModifiedValues.masterUserPassword;
        if (/port .*unavailable/i.test(error instanceof Error ? error.message : String(error)) && current.pendingModifiedValues?.port !== undefined) delete current.pendingModifiedValues.port;
        if (current.pendingModifiedValues && !Object.keys(current.pendingModifiedValues).length) delete current.pendingModifiedValues;
        current.dbInstanceStatus = listenerRecovered ? "available" : "failed"; delete current.lifecycleOperation; delete current.applyPendingConfiguration; current.statusMessage = `${mode === "reboot" ? "Reboot" : "Modification"} failed: ${this.safeMessage(error)}`; await this.store.save();
      });
    }
  }

  private async startWithCredentialCandidates(instance: RdsDbInstanceState, secret: RdsSecret, parameters: Record<string, string>): Promise<{ password: string; providerName: string; runtimeVersion: string }> {
    const candidates = [...new Set([secret.masterPassword, secret.pendingMasterPassword].filter((value): value is string => Boolean(value)))]; let lastError: unknown;
    for (const password of candidates) {
      const config = this.engineConfig(instance, secret, password, parameters);
      try { const runtime = await this.provider.start(config); const ready = await this.provider.readiness(config); if (!ready.ready || ready.endpoint.address !== "127.0.0.1" || ready.endpoint.port !== instance.port) throw new Error(ready.diagnostic ?? "The embedded SQL provider is not ready on the exact loopback endpoint"); return { password, providerName: runtime.providerName, runtimeVersion: runtime.engineVersion }; }
      catch (error) { lastError = error; try { await this.provider.stop(); } catch {} }
    }
    throw lastError ?? new Error("No local RDS master credential is available");
  }

  private validateCreate(region: string, input: any) {
    const identifier = requiredString(input.DBInstanceIdentifier, "DBInstanceIdentifier").toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(identifier) || identifier.endsWith("-") || identifier.includes("--")) throw new AwsError("InvalidParameterValue", "DBInstanceIdentifier must start with a letter and contain only lowercase letters, numbers, and single hyphens");
    if (requiredString(input.DBInstanceClass, "DBInstanceClass") !== INSTANCE_CLASS) throw new AwsError("InvalidParameterValue", `Only ${INSTANCE_CLASS} is supported`);
    if (requiredString(input.Engine, "Engine").toLowerCase() !== "mysql") throw new AwsError("InvalidParameterCombination", "The local RDS profile supports only Engine=mysql");
    if (input.EngineVersion !== undefined && String(input.EngineVersion) !== COMPATIBILITY_ENGINE_VERSION) throw new AwsError("InvalidParameterValue", `Only MySQL compatibility version ${COMPATIBILITY_ENGINE_VERSION} is supported`);
    const allocatedStorage = integer(input.AllocatedStorage, 20, "AllocatedStorage");
    if (allocatedStorage < 20 || allocatedStorage > 65_536) throw new AwsError("InvalidParameterValue", "AllocatedStorage must be between 20 and 65536 GiB; it is descriptor-only locally");
    const storageType = String(input.StorageType ?? "gp3") as "gp2" | "gp3";
    if (!new Set(["gp2", "gp3"]).has(storageType)) throw new AwsError("InvalidParameterValue", "Only gp2 and gp3 storage descriptors are supported");
    const dbName = input.DBName === undefined ? undefined : String(input.DBName);
    if (dbName !== undefined && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(dbName)) throw new AwsError("InvalidParameterValue", "DBName must start with a letter and contain only letters, numbers, and underscores");
    const masterUsername = requiredString(input.MasterUsername, "MasterUsername");
    if (!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(masterUsername) || /^root$/i.test(masterUsername)) throw new AwsError("InvalidParameterValue", "MasterUsername is invalid or reserved");
    const manageMasterUserPassword = boolean(input.ManageMasterUserPassword, false);
    if (input.MasterUserSecretKmsKeyId !== undefined) throw new AwsError("InvalidParameterCombination", "MasterUserSecretKmsKeyId requires customer KMS, which is outside the local profile");
    if (manageMasterUserPassword && input.MasterUserPassword !== undefined) throw new AwsError("InvalidParameterCombination", "ManageMasterUserPassword and MasterUserPassword are mutually exclusive");
    const masterPassword = manageMasterUserPassword ? undefined : validatePassword(input.MasterUserPassword);
    const port = integer(input.Port, 3306, "Port");
    if (port < 1150 || port > 65_535) throw new AwsError("InvalidParameterValue", "Port must be between 1150 and 65535");
    if (integer(input.BackupRetentionPeriod, 0, "BackupRetentionPeriod") !== 0) throw new AwsError("InvalidParameterCombination", "Automated backups are not supported; BackupRetentionPeriod must be 0");
    if (boolean(input.PubliclyAccessible, false)) throw new AwsError("InvalidParameterCombination", "PubliclyAccessible must be false; local RDS binds only to 127.0.0.1");
    if (boolean(input.MultiAZ, false)) throw new AwsError("InvalidParameterCombination", "MultiAZ is not supported by the single-instance development profile");
    if (boolean(input.StorageEncrypted, false) || input.KmsKeyId !== undefined) throw new AwsError("InvalidParameterCombination", "RDS storage encryption options are not supported locally");
    const deletionProtection = boolean(input.DeletionProtection, false);
    const requestedParameterGroup = input.DBParameterGroupName === undefined ? DEFAULT_PARAMETER_GROUP : parameterGroupName(input.DBParameterGroupName);
    if (requestedParameterGroup !== DEFAULT_PARAMETER_GROUP && !this.store.regionState(region).rdsDbParameterGroups[requestedParameterGroup]) throw new AwsError("DBParameterGroupNotFound", `DB parameter group ${requestedParameterGroup} was not found`, 404);
    if (input.DBClusterIdentifier !== undefined || input.DBSubnetGroupName !== undefined || namedList(input.VpcSecurityGroupIds, "VpcSecurityGroupId").length) throw new AwsError("InvalidParameterCombination", "Clusters, subnet groups, and VPC security groups are outside the local RDS profile");
    const unsupported = ["DBSecurityGroups", "AvailabilityZone", "OptionGroupName", "LicenseModel", "Iops", "StorageThroughput", "MaxAllocatedStorage", "MonitoringInterval", "MonitoringRoleArn", "EnablePerformanceInsights", "PerformanceInsightsKMSKeyId", "PerformanceInsightsRetentionPeriod", "EnableCloudwatchLogsExports", "EnableIAMDatabaseAuthentication", "AutoMinorVersionUpgrade", "PreferredBackupWindow", "PreferredMaintenanceWindow", "CACertificateIdentifier", "CopyTagsToSnapshot", "CharacterSetName", "NcharCharacterSetName", "TdeCredentialArn", "TdeCredentialPassword", "Domain", "DomainFqdn", "DomainOu", "DomainAuthSecretArn", "DomainDnsIps", "DomainIAMRoleName", "PromotionTier", "Timezone", "DatabaseInsightsMode", "NetworkType", "DedicatedLogVolume", "EnableCustomerOwnedIp", "ProcessorFeatures", "EngineLifecycleSupport", "MasterUserAuthenticationType", "BackupTarget", "CustomIamInstanceProfile", "DBSystemId", "MultiTenant", "AdditionalStorageVolumes", "TagSpecifications"];
    const suppliedUnsupported = unsupported.find(field => input[field] !== undefined);
    if (suppliedUnsupported) throw new AwsError("InvalidParameterCombination", `${suppliedUnsupported} is not supported by the local RDS development profile`);
    const supported = new Set(["DBName", "DBInstanceIdentifier", "AllocatedStorage", "DBInstanceClass", "Engine", "MasterUsername", "MasterUserPassword", "VpcSecurityGroupIds", "DBSubnetGroupName", "DBParameterGroupName", "BackupRetentionPeriod", "Port", "MultiAZ", "EngineVersion", "PubliclyAccessible", "Tags", "DBClusterIdentifier", "StorageType", "StorageEncrypted", "KmsKeyId", "DeletionProtection", "ManageMasterUserPassword", "MasterUserSecretKmsKeyId"]);
    const unknown = Object.keys(input).find(field => !supported.has(field) && !unsupported.includes(field));
    if (unknown) throw new AwsError("InvalidParameterCombination", `${unknown} is not supported by the local RDS development profile`);
    return { identifier, allocatedStorage, storageType, dbName, masterUsername, masterPassword, manageMasterUserPassword, port, deletionProtection, parameterGroupName: requestedParameterGroup, tags: tags(input.Tags), region };
  }

  private requireSnapshot(region: string, identifier: string): RdsDbSnapshotState {
    const snapshot = this.store.regionState(region).rdsDbSnapshots[identifier];
    if (!snapshot) throw new AwsError("DBSnapshotNotFound", `DB snapshot ${identifier} was not found`, 404);
    return snapshot;
  }

  private findSnapshot(identifierOrArn: string): { region: string; snapshot: RdsDbSnapshotState } {
    if (identifierOrArn.startsWith("arn:")) {
      for (const [region, regional] of Object.entries(this.store.ensureAccount().regions)) {
        const snapshot = Object.values(regional.rdsDbSnapshots).find(value => value.dbSnapshotArn === identifierOrArn);
        if (snapshot) return { region, snapshot };
      }
      throw new AwsError("DBSnapshotNotFound", `DB snapshot ${identifierOrArn} was not found`, 404);
    }
    const identifier = snapshotIdentifier(identifierOrArn);
    const matches: Array<{ region: string; snapshot: RdsDbSnapshotState }> = [];
    for (const [region, regional] of Object.entries(this.store.ensureAccount().regions)) if (regional.rdsDbSnapshots[identifier]) matches.push({ region, snapshot: regional.rdsDbSnapshots[identifier] });
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw new AwsError("DBSnapshotNotFound", `DB snapshot ${identifier} was not found`, 404);
    throw new AwsError("InvalidParameterValue", `DB snapshot identifier ${identifier} is ambiguous across Regions; use its ARN`);
  }

  private snapshotsRoot(): string { return resolve(this.rdsRoot, "snapshots"); }

  private snapshotDirectory(resourceId: string): string {
    if (!/^snapshot-[a-f0-9]{26}$/.test(resourceId)) throw new Error("Invalid RDS snapshot resource ID in persisted state");
    const root = this.snapshotsRoot(); const target = resolve(root, resourceId);
    if (!target.startsWith(`${root}${sep}`)) throw new Error("Unsafe RDS snapshot path");
    return target;
  }

  private async prepareSnapshotsRoot(): Promise<string> {
    const root = this.snapshotsRoot(); await mkdir(root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(root); if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("The RDS snapshots root is unsafe");
    const markerPath = join(root, SNAPSHOT_ROOT_MARKER);
    try {
      const markerMetadata = await lstat(markerPath); if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) throw new Error("The RDS snapshot ownership marker is unsafe");
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      if (marker?.schemaVersion !== 1 || marker?.installationId !== this.store.state.installation.id) throw new Error("The RDS snapshot ownership marker belongs to a different installation");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.writeAtomicJson(markerPath, { schemaVersion: 1, installationId: this.store.state.installation.id });
    }
    return root;
  }

  private async publishCapturedSnapshot(region: string, snapshot: RdsDbSnapshotState, config: RdsEngineConfig): Promise<{ checksum: string; sizeBytes: number; fileCount: number }> {
    if (!this.provider.captureSnapshot) throw new Error("The active RDS provider cannot capture snapshots");
    return this.publishSnapshot(region, snapshot, async dataDir => this.provider.captureSnapshot!(config, dataDir));
  }

  private async publishCopiedSnapshot(region: string, target: RdsDbSnapshotState, sourceRegion: string, source: RdsDbSnapshotState): Promise<{ checksum: string; sizeBytes: number; fileCount: number }> {
    const sourceManifest = await this.readSnapshotManifest(sourceRegion, source);
    const sourceData = join(this.snapshotDirectory(source.snapshotResourceId), "data");
    return this.publishSnapshot(region, target, async targetData => {
      const copied: RdsEngineSnapshotFile[] = [];
      for (const file of sourceManifest.files) {
        const destination = join(targetData, file.name); await copyFile(join(sourceData, file.name), destination);
        const handle = await open(destination, "r+"); try { await handle.sync(); } finally { await handle.close(); }
        const metadata = await lstat(destination); const checksum = await sha256File(destination);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.sizeBytes || checksum !== file.sha256) throw new Error(`Snapshot copy validation failed for ${file.name}`);
        copied.push({ ...file });
      }
      return copied;
    });
  }

  private async publishSnapshot(region: string, snapshot: RdsDbSnapshotState, produce: (dataDir: string) => Promise<RdsEngineSnapshotFile[]>): Promise<{ checksum: string; sizeBytes: number; fileCount: number }> {
    const root = await this.prepareSnapshotsRoot(); const finalDirectory = this.snapshotDirectory(snapshot.snapshotResourceId);
    if (await exists(finalDirectory)) throw new Error("The target snapshot resource directory already exists");
    const temporary = join(root, `.tmp-${snapshot.snapshotResourceId}-${randomUUID()}`);
    try {
      await mkdir(temporary, { mode: 0o700 });
      await this.writeAtomicJson(join(temporary, SNAPSHOT_OWNERSHIP_MARKER), { schemaVersion: 1, installationId: this.store.state.installation.id, snapshotResourceId: snapshot.snapshotResourceId });
      const dataDir = join(temporary, "data"); await mkdir(dataDir, { mode: 0o700 });
      const files = await produce(dataDir);
      const fileNames = new Set<string>();
      for (const file of files) {
        if (!/^[A-Za-z][A-Za-z0-9_$]{0,63}\.sqlite$/.test(file.name) || fileNames.has(file.name) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("The snapshot provider returned invalid file metadata");
        fileNames.add(file.name);
      }
      const manifest: RdsSnapshotManifest = { schemaVersion: 1, installationId: this.store.state.installation.id, accountId: this.store.accountId, region, snapshotResourceId: snapshot.snapshotResourceId, dbSnapshotIdentifier: snapshot.dbSnapshotIdentifier, sourceDbiResourceId: snapshot.sourceDbiResourceId, ...(snapshot.dbName ? { databaseName: snapshot.dbName } : {}), createdAt: snapshot.snapshotCreateTime, files };
      const manifestPath = join(temporary, SNAPSHOT_MANIFEST); await this.writeAtomicJson(manifestPath, manifest); await syncDirectory(temporary);
      await rename(temporary, finalDirectory); await syncDirectory(root);
      const checksum = await sha256File(join(finalDirectory, SNAPSHOT_MANIFEST));
      return { checksum, sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0), fileCount: files.length };
    } finally { await this.removeOwnedWorkDirectory(temporary, snapshot.snapshotResourceId).catch(() => undefined); }
  }

  private async readSnapshotManifest(region: string, snapshot: RdsDbSnapshotState): Promise<RdsSnapshotManifest> {
    const directory = this.snapshotDirectory(snapshot.snapshotResourceId); const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new AwsError("InvalidDBSnapshotState", `DB snapshot ${snapshot.dbSnapshotIdentifier} storage is unsafe`);
    await this.assertSnapshotOwnership(directory, snapshot.snapshotResourceId);
    const manifestPath = join(directory, SNAPSHOT_MANIFEST); const raw = await readFile(manifestPath);
    const checksum = createHash("sha256").update(raw).digest("hex");
    if (snapshot.manifestChecksum && snapshot.manifestChecksum !== checksum) throw new AwsError("InvalidDBSnapshotState", `DB snapshot ${snapshot.dbSnapshotIdentifier} manifest checksum failed`);
    let manifest: RdsSnapshotManifest; try { manifest = JSON.parse(raw.toString("utf8")); } catch { throw new AwsError("InvalidDBSnapshotState", `DB snapshot ${snapshot.dbSnapshotIdentifier} manifest is invalid`); }
    if (manifest.schemaVersion !== 1 || manifest.installationId !== this.store.state.installation.id || manifest.accountId !== this.store.accountId || manifest.region !== region || manifest.snapshotResourceId !== snapshot.snapshotResourceId || manifest.dbSnapshotIdentifier !== snapshot.dbSnapshotIdentifier || manifest.sourceDbiResourceId !== snapshot.sourceDbiResourceId || !Array.isArray(manifest.files)) throw new AwsError("InvalidDBSnapshotState", `DB snapshot ${snapshot.dbSnapshotIdentifier} ownership manifest does not match control state`);
    const entries = (await readdir(join(directory, "data"))).sort(); const expected = manifest.files.map(file => file.name).sort();
    if (JSON.stringify(entries) !== JSON.stringify(expected)) throw new AwsError("InvalidDBSnapshotState", `DB snapshot ${snapshot.dbSnapshotIdentifier} file inventory does not match its manifest`);
    const seen = new Set<string>();
    for (const file of manifest.files) {
      if (!/^[A-Za-z][A-Za-z0-9_$]{0,63}\.sqlite$/.test(file.name) || seen.has(file.name)) throw new AwsError("InvalidDBSnapshotState", `DB snapshot ${snapshot.dbSnapshotIdentifier} contains an invalid file inventory`);
      seen.add(file.name); const path = join(directory, "data", file.name); const fileMetadata = await lstat(path);
      if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink() || fileMetadata.size !== file.sizeBytes || await sha256File(path) !== file.sha256) throw new AwsError("InvalidDBSnapshotState", `DB snapshot ${snapshot.dbSnapshotIdentifier} data checksum failed`);
    }
    return manifest;
  }

  private async removeSnapshotFiles(resourceId: string): Promise<void> {
    const root = await this.prepareSnapshotsRoot(); const directory = this.snapshotDirectory(resourceId);
    if (!await exists(directory)) return;
    await this.assertSnapshotOwnership(directory, resourceId);
    const tombstone = join(root, `.deleting-${resourceId}-${randomUUID()}`); await rename(directory, tombstone); await syncDirectory(root);
    await rm(tombstone, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 }); await syncDirectory(root);
  }

  private async removeOwnedWorkDirectory(path: string, resourceId: string): Promise<void> {
    if (!await exists(path)) return;
    await this.assertSnapshotOwnership(path, resourceId);
    await rm(path, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
  }

  private async assertSnapshotOwnership(path: string, resourceId: string): Promise<void> {
    const markerMetadata = await lstat(join(path, SNAPSHOT_OWNERSHIP_MARKER));
    if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) throw new Error("Snapshot cleanup refused because its ownership marker is unsafe");
    const marker = JSON.parse(await readFile(join(path, SNAPSHOT_OWNERSHIP_MARKER), "utf8"));
    if (marker?.schemaVersion !== 1 || marker?.installationId !== this.store.state.installation.id || marker?.snapshotResourceId !== resourceId) throw new Error("Snapshot cleanup refused because ownership could not be proven");
  }

  private async reconcileSnapshots(): Promise<void> {
    const root = await this.prepareSnapshotsRoot(); let changed = false;
    for (const [region, regional] of Object.entries(this.store.ensureAccount().regions)) {
      for (const [identifier, snapshot] of Object.entries(regional.rdsDbSnapshots)) {
        if (snapshot.status === "deleting") {
          try { await this.removeSnapshotFiles(snapshot.snapshotResourceId); delete regional.rdsDbSnapshots[identifier]; changed = true; } catch (error) { snapshot.status = "failed"; snapshot.statusMessage = `Snapshot deletion recovery failed: ${this.safeMessage(error)}`; changed = true; }
          continue;
        }
        try {
          const manifest = await this.readSnapshotManifest(region, snapshot);
          const checksum = await sha256File(join(this.snapshotDirectory(snapshot.snapshotResourceId), SNAPSHOT_MANIFEST));
          if (snapshot.status === "creating" || snapshot.status === "copying") snapshot.status = "available";
          snapshot.manifestChecksum = checksum; snapshot.fileCount = manifest.files.length; snapshot.dataSizeBytes = manifest.files.reduce((total, file) => total + file.sizeBytes, 0); delete snapshot.statusMessage; changed = true;
        } catch (error) {
          if (snapshot.status !== "failed" || !snapshot.statusMessage) { snapshot.status = "failed"; snapshot.statusMessage = `Snapshot recovery validation failed: ${this.safeMessage(error)}`; changed = true; }
        }
      }
    }
    const reachable = new Set<string>(); for (const account of Object.values(this.store.state.accounts)) for (const regional of Object.values(account.regions)) for (const snapshot of Object.values(regional.rdsDbSnapshots ?? {})) reachable.add(snapshot.snapshotResourceId);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name);
      if (entry.name.startsWith(".tmp-snapshot-")) {
        const marker = JSON.parse(await readFile(join(path, SNAPSHOT_OWNERSHIP_MARKER), "utf8").catch(() => "null"));
        if (marker?.installationId === this.store.state.installation.id && /^snapshot-[a-f0-9]{26}$/.test(marker.snapshotResourceId ?? "")) await rm(path, { recursive: true, force: false });
      } else if (entry.name.startsWith(".deleting-snapshot-")) {
        const marker = JSON.parse(await readFile(join(path, SNAPSHOT_OWNERSHIP_MARKER), "utf8").catch(() => "null"));
        if (marker?.installationId === this.store.state.installation.id && /^snapshot-[a-f0-9]{26}$/.test(marker.snapshotResourceId ?? "")) await rm(path, { recursive: true, force: false });
      } else if (/^snapshot-[a-f0-9]{26}$/.test(entry.name) && !reachable.has(entry.name)) {
        const marker = JSON.parse(await readFile(join(path, SNAPSHOT_OWNERSHIP_MARKER), "utf8").catch(() => "null"));
        if (marker?.installationId === this.store.state.installation.id && marker.snapshotResourceId === entry.name) await rm(path, { recursive: true, force: false });
      }
    }
    if (changed) await this.store.save();
  }

  private async writeAtomicJson(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, path); await syncDirectory(resolve(path, ".."));
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  private async provisionRestore(lease: RdsInstanceLease, instance: RdsDbInstanceState, sourceRegion: string, snapshot: RdsDbSnapshotState, admittedManifest: RdsSnapshotManifest): Promise<void> {
    let secret: RdsSecret | undefined;
    try {
      if (!this.provider.restoreSnapshot) throw new Error("The active RDS provider cannot restore snapshots");
      const currentManifest = await this.readSnapshotManifest(sourceRegion, snapshot);
      if (JSON.stringify(currentManifest) !== JSON.stringify(admittedManifest)) throw new Error("The snapshot manifest changed after restore admission");
      secret = await this.readSecret(instance); const config = this.engineConfig(instance, secret);
      await this.provider.initialize(config);
      await this.provider.restoreSnapshot(config, join(this.snapshotDirectory(snapshot.snapshotResourceId), "data"), currentManifest.files);
      const runtime = await this.provider.start(config);
      if (!runtime.ready) throw new Error(runtime.diagnostic ?? "The restored SQL listener did not become ready");
      await this.exclusive(async () => { const current = this.instanceForLease(lease); if (!current || current.dbInstanceStatus === "deleting") return; current.dbInstanceStatus = "available"; current.providerEngine = "sqlite"; current.providerVersion = runtime.engineVersion; delete current.restoreSourceSnapshotArn; delete current.statusMessage; await this.store.save(); });
    } catch (error) {
      try { await this.provider.stop(); } catch {}
      await this.exclusive(async () => { const current = this.instanceForLease(lease); if (!current || current.dbInstanceStatus === "deleting") return; current.dbInstanceStatus = "failed"; delete current.restoreSourceSnapshotArn; current.statusMessage = `Snapshot restore failed: ${this.safeMessage(error, secret?.masterPassword)}`; await this.store.save(); });
    }
  }

  private async provision(lease: RdsInstanceLease, instance: RdsDbInstanceState): Promise<void> {
    let secret: RdsSecret | undefined;
    try {
      secret = await this.readSecret(instance);
      secret = await this.discardUntrackedPendingPassword(instance, secret);
      const config = this.engineConfig(instance, secret);
      await this.provider.initialize(config);
      const runtime = await this.startWithCredentialCandidates(instance, secret, instance.appliedParameters);
      await this.exclusive(async () => {
        const current = this.instanceForLease(lease);
        if (!current || current.dbInstanceStatus === "deleting") return;
        current.dbInstanceStatus = "available"; current.providerEngine = /sqlite/i.test(runtime.providerName) ? "sqlite" : "mariadb"; current.providerVersion = runtime.runtimeVersion; delete current.lifecycleOperation; delete current.statusMessage; await this.store.save();
      });
    } catch (error) {
      try { await this.provider.stop(); } catch {}
      await this.exclusive(async () => {
        const current = this.instanceForLease(lease);
        if (!current || current.dbInstanceStatus === "deleting") return;
        current.dbInstanceStatus = "failed"; current.statusMessage = this.safeMessage(error, secret?.masterPassword); await this.store.save();
      });
    }
  }

  private async removeInstance(lease: RdsInstanceLease, instance: RdsDbInstanceState): Promise<void> {
    try {
      const provider = instance.providerEngine === "mariadb" ? this.options.legacyDestroyProvider ?? this.provider : this.provider;
      await provider.stop();
      await provider.destroy({ resourceId: instance.dbiResourceId, resourceDir: this.resourceDir(instance.dbiResourceId), port: instance.port });
      let removed = false;
      await this.exclusive(async () => {
        const currentLease = this.store.state.installation.rds.instanceLease;
        if (currentLease?.dbiResourceId !== lease.dbiResourceId) return;
        const region = this.store.state.accounts[lease.accountId]?.regions[lease.region];
        const current = region?.rdsDbInstances[lease.dbInstanceIdentifier];
        if (!region || current?.dbiResourceId !== lease.dbiResourceId) return;
        delete region.rdsDbInstances[lease.dbInstanceIdentifier];
        delete this.store.state.installation.rds.instanceLease;
        try { await this.store.save(); removed = true; }
        catch (error) { region.rdsDbInstances[lease.dbInstanceIdentifier] = current; this.store.state.installation.rds.instanceLease = currentLease; throw error; }
      });
      // Publish NOT_FOUND before removing the private credential. Otherwise a
      // concurrent waiter can observe the instance while its secret is already
      // gone and surface a platform-timing-dependent ENOENT.
      if (removed) {
        await this.deleteSecret(instance.dbiResourceId);
        if (instance.masterUserSecretArn) await this.managedSecrets.get(lease.region)?.delete(instance.masterUserSecretArn, instance.dbInstanceArn);
      }
    } catch (error) {
      await this.exclusive(async () => {
        const current = this.instanceForLease(lease);
        if (!current) return;
        current.dbInstanceStatus = "failed"; current.statusMessage = `Deletion failed: ${this.safeMessage(error)}`; await this.store.save();
      });
    }
  }

  private engineConfig(instance: RdsDbInstanceState, secret: RdsSecret, password = secret.masterPassword, parameters = instance.appliedParameters): RdsEngineConfig {
    return { resourceId: instance.dbiResourceId, resourceDir: this.resourceDir(instance.dbiResourceId), databaseName: secret.databaseName, masterUsername: secret.masterUsername, masterPassword: password, port: instance.port, parameters: { ...parameters } };
  }

  private resourceDir(resourceId: string): string {
    if (!/^db-[a-f0-9]{26}$/.test(resourceId)) throw new Error("Invalid RDS resource ID in persisted state");
    const base = resolve(this.rdsRoot, "instances"); const target = resolve(base, resourceId);
    if (!target.startsWith(`${base}${sep}`)) throw new Error("Unsafe RDS resource path");
    return target;
  }

  private secretPath(resourceId: string): string {
    if (!/^db-[a-f0-9]{26}$/.test(resourceId)) throw new Error("Invalid RDS resource ID in persisted state");
    return join(this.rdsRoot, "secrets", `${resourceId}.json`);
  }

  private async writeSecret(instance: RdsDbInstanceState, password: string): Promise<void> {
    const value: RdsSecret = { version: 2, resourceId: instance.dbiResourceId, ...(instance.dbName ? { databaseName: instance.dbName } : {}), masterUsername: instance.masterUsername, masterPassword: password };
    await this.writeSecretValue(instance, value);
  }

  private async writeSecretValue(instance: RdsDbInstanceState, value: RdsSecret): Promise<void> {
    const directory = join(this.rdsRoot, "secrets"); await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = this.secretPath(instance.dbiResourceId); const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  private async stagePendingPassword(instance: RdsDbInstanceState, password: string): Promise<void> {
    const secret = await this.readSecret(instance); await this.writeSecretValue(instance, { ...secret, version: 2, pendingMasterPassword: password });
  }

  private async promotePendingPassword(instance: RdsDbInstanceState, secret: RdsSecret): Promise<RdsSecret> {
    if (!secret.pendingMasterPassword) return secret;
    const promoted: RdsSecret = { ...secret, version: 2, masterPassword: secret.pendingMasterPassword }; delete promoted.pendingMasterPassword; await this.writeSecretValue(instance, promoted); return promoted;
  }

  private async discardUntrackedPendingPassword(instance: RdsDbInstanceState, secret: RdsSecret): Promise<RdsSecret> {
    if (!secret.pendingMasterPassword || instance.pendingModifiedValues?.masterUserPassword || instance.managedCredentialSaga) return secret;
    const cleaned = { ...secret }; delete cleaned.pendingMasterPassword; await this.writeSecretValue(instance, cleaned); return cleaned;
  }

  private async readSecret(instance: RdsDbInstanceState): Promise<RdsSecret> {
    const value = JSON.parse(await readFile(this.secretPath(instance.dbiResourceId), "utf8")) as RdsSecret;
    if (!new Set([1, 2]).has(value.version) || value.resourceId !== instance.dbiResourceId || value.databaseName !== instance.dbName || value.masterUsername !== instance.masterUsername || typeof value.masterPassword !== "string" || (value.pendingMasterPassword !== undefined && typeof value.pendingMasterPassword !== "string")) throw new Error("The local RDS credential file is invalid");
    return value;
  }

  private async deleteSecret(resourceId: string): Promise<void> { await rm(this.secretPath(resourceId), { force: true }); }

  private instanceForLease(lease: RdsInstanceLease): RdsDbInstanceState | undefined {
    const instance = this.store.state.accounts[lease.accountId]?.regions[lease.region]?.rdsDbInstances?.[lease.dbInstanceIdentifier];
    return instance?.dbiResourceId === lease.dbiResourceId ? instance : undefined;
  }

  private allInstances(): Array<{ accountId: string; region: string; instance: RdsDbInstanceState }> {
    const result: Array<{ accountId: string; region: string; instance: RdsDbInstanceState }> = [];
    for (const [accountId, account] of Object.entries(this.store.state.accounts)) for (const [region, regional] of Object.entries(account.regions)) for (const instance of Object.values(regional.rdsDbInstances ?? {})) result.push({ accountId, region, instance });
    return result;
  }

  private assertCreateSlot(region: string, identifier: string): void {
    const existingLease = this.store.state.installation.rds.instanceLease;
    if (existingLease) {
      if (existingLease.accountId === this.store.accountId && existingLease.region === region && existingLease.dbInstanceIdentifier === identifier) throw new AwsError("DBInstanceAlreadyExists", `DB instance ${identifier} already exists`);
      throw new AwsError("InstanceQuotaExceeded", "This stacksim installation supports one RDS DB instance at a time");
    }
    if (this.store.regionState(region).rdsDbInstances[identifier]) throw new AwsError("DBInstanceAlreadyExists", `DB instance ${identifier} already exists`);
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutex.then(work, work); this.mutex = result.then(() => undefined, () => undefined); return result;
  }

  private enqueueEngine(work: () => Promise<void>): Promise<void> {
    const result = this.engineQueue.then(work, work); this.engineQueue = result.then(() => undefined, () => undefined); return result;
  }

  private safeMessage(error: unknown, password?: string): string {
    let message = error instanceof Error ? error.message : String(error);
    if (password) message = message.split(password).join("[REDACTED]");
    for (const path of [this.rdsRoot, this.store.root]) message = message.split(path).join("[LOCAL_DATA]");
    return message.slice(0, 1_024);
  }

  private assertPortAvailable(port: number): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const server = createServer(); server.unref();
      server.once("error", (error: NodeJS.ErrnoException) => reject(new AwsError("InsufficientDBInstanceCapacity", `Requested local RDS port ${port} is unavailable: ${error.code ?? error.message}`)));
      server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : resolvePromise()));
    });
  }
}

export class RdsService {
  constructor(private readonly manager: RdsManager, private readonly region: string) {}

  async handle(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    try {
      const input = parseAwsQuery((await readBody(req)).toString("utf8")) as any;
      const action = String(input.Action ?? ""); const version = input.Version; delete input.Action; delete input.Version;
      if (version !== "2014-10-31") throw new AwsError("InvalidParameterValue", "Version must be 2014-10-31");
      let result: Record<string, unknown>;
      if (action === "CreateDBInstance") result = { DBInstance: dbInstanceView(await this.manager.create(this.region, input)) };
      else if (action === "DescribeDBInstances") result = { DBInstances: awsQueryList("DBInstance", this.manager.describe(this.region, input).map(dbInstanceView)) };
      else if (action === "DeleteDBInstance") result = { DBInstance: dbInstanceView(await this.manager.delete(this.region, input)) };
      else if (action === "CreateDBSnapshot") result = { DBSnapshot: dbSnapshotView(await this.manager.createSnapshot(this.region, input)) };
      else if (action === "DescribeDBSnapshots") result = { DBSnapshots: awsQueryList("DBSnapshot", (await this.manager.describeSnapshots(this.region, input)).map(dbSnapshotView)) };
      else if (action === "DeleteDBSnapshot") result = { DBSnapshot: dbSnapshotView(await this.manager.deleteSnapshot(this.region, input)) };
      else if (action === "CopyDBSnapshot") result = { DBSnapshot: dbSnapshotView(await this.manager.copySnapshot(this.region, input)) };
      else if (action === "RestoreDBInstanceFromDBSnapshot") result = { DBInstance: dbInstanceView(await this.manager.restoreSnapshot(this.region, input)) };
      else if (action === "RestoreDBInstanceToPointInTime") throw new AwsError("InvalidParameterCombination", "Point-in-time recovery requires a bounded durable SQLite WAL/checkpoint recovery design and is not supported by RDS-03");
      else if (action === "DescribeDBSnapshotAttributes") {
        const snapshot = this.manager.describeSnapshotAttributes(this.region, input); result = { DBSnapshotAttributesResult: { DBSnapshotIdentifier: snapshot.dbSnapshotIdentifier, DBSnapshotAttributes: awsQueryList("DBSnapshotAttribute", [{ AttributeName: "restore", AttributeValues: awsQueryList("AttributeValue", snapshot.restoreAttributes) }]) } };
      }
      else if (action === "ModifyDBSnapshotAttribute") {
        const snapshot = await this.manager.modifySnapshotAttribute(this.region, input); result = { DBSnapshotAttributesResult: { DBSnapshotIdentifier: snapshot.dbSnapshotIdentifier, DBSnapshotAttributes: awsQueryList("DBSnapshotAttribute", [{ AttributeName: "restore", AttributeValues: awsQueryList("AttributeValue", snapshot.restoreAttributes) }]) } };
      }
      else if (action === "ModifyDBInstance") result = { DBInstance: dbInstanceView(await this.manager.modify(this.region, input)) };
      else if (action === "RebootDBInstance") result = { DBInstance: dbInstanceView(await this.manager.reboot(this.region, input)) };
      else if (action === "StopDBInstance") result = { DBInstance: dbInstanceView(await this.manager.stopInstance(this.region, input)) };
      else if (action === "StartDBInstance") result = { DBInstance: dbInstanceView(await this.manager.startInstance(this.region, input)) };
      else if (action === "DescribeValidDBInstanceModifications") result = this.manager.validModifications(this.region, input);
      else if (action === "AddTagsToResource") { await this.manager.addTags(this.region, input); result = {}; }
      else if (action === "RemoveTagsFromResource") { await this.manager.removeTags(this.region, input); result = {}; }
      else if (action === "ListTagsForResource") result = { TagList: awsQueryList("Tag", Object.entries(this.manager.listTags(this.region, input)).sort(([left], [right]) => left.localeCompare(right)).map(([Key, Value]) => ({ Key, Value }))) };
      else if (action === "CreateDBParameterGroup") result = { DBParameterGroup: dbParameterGroupView(await this.manager.createParameterGroup(this.region, input), this.region, this.manager.accountId) };
      else if (action === "DescribeDBParameterGroups") result = { DBParameterGroups: awsQueryList("DBParameterGroup", this.manager.describeParameterGroups(this.region, input).map(group => dbParameterGroupView(group, this.region, this.manager.accountId))) };
      else if (action === "ModifyDBParameterGroup") result = { DBParameterGroupName: await this.manager.modifyParameterGroup(this.region, input) };
      else if (action === "ResetDBParameterGroup") result = { DBParameterGroupName: await this.manager.resetParameterGroup(this.region, input) };
      else if (action === "DeleteDBParameterGroup") { await this.manager.deleteParameterGroup(this.region, input); result = {}; }
      else if (action === "DescribeDBParameters") result = { Parameters: awsQueryList("Parameter", this.manager.describeParameters(this.region, input)) };
      else if (action === "DescribeEngineDefaultParameters") result = { EngineDefaults: { DBParameterGroupFamily: PARAMETER_GROUP_FAMILY, Parameters: awsQueryList("Parameter", this.manager.describeParameters(this.region, input, true)) } };
      else if (action === "DescribeDBEngineVersions") result = this.describeDBEngineVersions(input);
      else if (action === "DescribeOrderableDBInstanceOptions") result = this.describeOrderableDBInstanceOptions(input);
      else if (action === "DescribeAccountAttributes") { rejectUnsupportedInput(input, []); const quota = this.manager.accountQuota(); result = { AccountQuotas: awsQueryList("AccountQuota", [{ AccountQuotaName: "DBInstances", Used: quota.used, Max: quota.max }]) }; }
      else throw new AwsError("InvalidAction", `The action ${action || "(missing)"} is not valid for the local RDS profile`);
      sendAwsQueryXml(res, `${action}Response`, { [`${action}Result`]: result, ResponseMetadata: { RequestId: requestId } }, NAMESPACE);
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", "The local RDS operation failed", 500);
      res.statusCode = aws.status; res.setHeader("content-type", "text/xml; charset=utf-8");
      res.end(awsQueryXml("ErrorResponse", { Error: { Type: aws.status >= 500 ? "Receiver" : "Sender", Code: aws.code.replace(/(?:Exception|Fault)$/, ""), Message: aws.message }, RequestId: requestId }, NAMESPACE));
    }
  }

  private describeDBEngineVersions(input: any): Record<string, unknown> {
    rejectUnsupportedInput(input, ["Engine", "EngineVersion"]);
    if (input.Engine !== undefined && String(input.Engine).toLowerCase() !== "mysql") return { DBEngineVersions: awsQueryList("DBEngineVersion", []) };
    if (input.EngineVersion !== undefined && String(input.EngineVersion) !== COMPATIBILITY_ENGINE_VERSION) return { DBEngineVersions: awsQueryList("DBEngineVersion", []) };
    return { DBEngineVersions: awsQueryList("DBEngineVersion", [{ Engine: "mysql", EngineVersion: COMPATIBILITY_ENGINE_VERSION, DBParameterGroupFamily: "mysql8.0", DBEngineDescription: "Embedded SQLite with a bounded MySQL-compatible data plane", DBEngineVersionDescription: "stacksim MySQL 8.0 compatibility profile", ValidUpgradeTarget: awsQueryList("UpgradeTarget", []), ExportableLogTypes: awsQueryList("member", []), SupportsLogExportsToCloudwatchLogs: false, SupportsReadReplica: false, SupportsParallelQuery: false, SupportsGlobalDatabases: false, SupportsBabelfish: false, SupportsLimitlessDatabase: false }]) };
  }

  private describeOrderableDBInstanceOptions(input: any): Record<string, unknown> {
    rejectUnsupportedInput(input, ["Engine", "EngineVersion", "DBInstanceClass"]);
    if (input.Engine !== undefined && String(input.Engine).toLowerCase() !== "mysql") return { OrderableDBInstanceOptions: awsQueryList("OrderableDBInstanceOption", []) };
    if (input.EngineVersion !== undefined && String(input.EngineVersion) !== COMPATIBILITY_ENGINE_VERSION) return { OrderableDBInstanceOptions: awsQueryList("OrderableDBInstanceOption", []) };
    if (input.DBInstanceClass !== undefined && String(input.DBInstanceClass) !== INSTANCE_CLASS) return { OrderableDBInstanceOptions: awsQueryList("OrderableDBInstanceOption", []) };
    const option = (storageType: "gp2" | "gp3") => ({ Engine: "mysql", EngineVersion: COMPATIBILITY_ENGINE_VERSION, DBInstanceClass: INSTANCE_CLASS, LicenseModel: "general-public-license", AvailabilityZoneGroup: "local", AvailabilityZones: awsQueryList("AvailabilityZone", [{ Name: `${this.region}a` }]), MultiAZCapable: false, ReadReplicaCapable: false, Vpc: false, SupportsStorageEncryption: false, StorageType: storageType, SupportsIops: false, SupportsEnhancedMonitoring: false, SupportsIAMDatabaseAuthentication: false, SupportsPerformanceInsights: false, MinStorageSize: 20, MaxStorageSize: 65_536 });
    return { OrderableDBInstanceOptions: awsQueryList("OrderableDBInstanceOption", [option("gp2"), option("gp3")]) };
  }
}
