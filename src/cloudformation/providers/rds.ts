import { createHash } from "node:crypto";
import { AwsError } from "../../errors.js";
import { RdsManager } from "../../rds.js";
import type { RdsDbInstanceState, RdsDbParameterGroupState } from "../../types.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderInProgress,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderSuccess,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";

export const RDS_DB_INSTANCE_TYPE = "AWS::RDS::DBInstance";
export const RDS_DB_PARAMETER_GROUP_TYPE = "AWS::RDS::DBParameterGroup";

const OWNER_TAG = "stacksim:cloudformation:owner";
const EXPLICIT_IDENTIFIER_TAG = "stacksim:cloudformation:explicit-identifier";
const INTERNAL_TAGS = new Set([OWNER_TAG, EXPLICIT_IDENTIFIER_TAG]);
const PARAMETER_FAMILY = "mysql8.0";
const DEFAULT_PARAMETER_GROUP = "default.mysql8.0";
const ENGINE_VERSION = "8.0";
const INSTANCE_CLASS = "db.t3.micro";
const DYNAMIC_PARAMETERS: Readonly<Record<string, (value: string) => boolean>> = Object.freeze({
  max_connections: value => integerRange(value, 10, 1_000),
  wait_timeout: value => integerRange(value, 60, 28_800),
  max_allowed_packet: value => integerRange(value, 1_048_576, 67_108_864),
  innodb_flush_log_at_trx_commit: value => new Set(["0", "1", "2"]).has(value),
});
const STATIC_PARAMETERS: Readonly<Record<string, (value: string) => boolean>> = Object.freeze({
  collation_server: value => new Set(["utf8mb4_unicode_ci", "utf8mb4_general_ci"]).has(value),
});

export interface RdsDbInstanceModel {
  readonly DBInstanceIdentifier?: string;
  readonly AllocatedStorage: string;
  readonly BackupRetentionPeriod: 0;
  readonly DBInstanceClass: "db.t3.micro";
  readonly DBName?: string;
  readonly DBParameterGroupName: string;
  readonly DeletionProtection: boolean;
  readonly Engine: "mysql";
  readonly EngineVersion: "8.0";
  readonly MasterUsername: string;
  readonly MasterUserPassword?: string;
  readonly ManageMasterUserPassword: boolean;
  readonly MultiAZ: false;
  readonly Port: string;
  readonly PubliclyAccessible: false;
  readonly StorageType: "gp2" | "gp3";
  readonly Tags: readonly { readonly Key: string; readonly Value: string }[];
}

export interface RdsDbParameterGroupModel {
  readonly Description: string;
  readonly Family: "mysql8.0";
  readonly Parameters: Readonly<Record<string, string>>;
  readonly Tags: readonly { readonly Key: string; readonly Value: string }[];
}

const retention = Object.freeze({
  deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  snapshotSupported: false,
});
const instanceRetention = Object.freeze({
  deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate", "Snapshot"] as const),
  updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  snapshotSupported: true,
});

export const RDS_DB_INSTANCE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: RDS_DB_INSTANCE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    AllocatedStorage: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    BackupRetentionPeriod: Object.freeze({ valueType: "number", updateBehavior: "NOT_SUPPORTED" }),
    DBInstanceClass: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    DBInstanceIdentifier: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    DBName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    DBParameterGroupName: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    DeletionProtection: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
    Engine: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    EngineVersion: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    MasterUsername: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT", sensitive: true }),
    MasterUserPassword: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE", sensitive: true }),
    ManageMasterUserPassword: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
    MasterUserSecretKmsKeyId: Object.freeze({ valueType: "string", updateBehavior: "NOT_SUPPORTED" }),
    MultiAZ: Object.freeze({ valueType: "boolean", updateBehavior: "NOT_SUPPORTED" }),
    Port: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    PubliclyAccessible: Object.freeze({ valueType: "boolean", updateBehavior: "NOT_SUPPORTED" }),
    StorageType: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "DB instance identifier" }),
  attributes: Object.freeze({
    DBInstanceArn: Object.freeze({ valueType: "string" }),
    DbiResourceId: Object.freeze({ valueType: "string" }),
    Endpoint: Object.freeze({ valueType: "object" }),
    "Endpoint.Address": Object.freeze({ valueType: "string" }),
    "Endpoint.HostedZoneId": Object.freeze({ valueType: "string" }),
    "Endpoint.Port": Object.freeze({ valueType: "string" }),
    MasterUserSecret: Object.freeze({ valueType: "object" }),
    "MasterUserSecret.SecretArn": Object.freeze({ valueType: "string" }),
    "MasterUserSecret.SecretStatus": Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: instanceRetention,
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

export const RDS_DB_PARAMETER_GROUP_SCHEMA: ProviderSchema = Object.freeze({
  typeName: RDS_DB_PARAMETER_GROUP_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Description: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Family: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Parameters: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "DB parameter group name" }),
  attributes: Object.freeze({
    Arn: Object.freeze({ valueType: "string" }),
    DBParameterGroupName: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE", deleteBeforeCreateReason: "Generated RDS parameter-group identity is operation scoped" }),
  retention,
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stable<T>(value: T): T { if (Array.isArray(value)) return value.map(stable) as T; if (record(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) as T; return value; }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }
function integerRange(value: string, minimum: number, maximum: number): boolean { return /^\d+$/.test(value) && Number(value) >= minimum && Number(value) <= maximum; }
function owner(context: ProviderContext): string { return createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex"); }
type GeneratedNameContext = Pick<ProviderContext, "stackId" | "logicalId" | "operationId">;
function stackName(context: Pick<ProviderContext, "stackId">): string { return context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack"; }

function generatedName(context: GeneratedNameContext, maximum: number): string {
  const suffix = createHash("sha256").update(`${context.stackId}\0${context.logicalId}\0${context.operationId}`).digest("hex").slice(0, 12);
  const prefix = `${stackName(context)}-${context.logicalId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "stacksim";
  return `${prefix.slice(0, maximum - suffix.length - 1).replace(/-$/g, "")}-${suffix}`;
}

export function rdsDbParameterGroupPhysicalId(context: GeneratedNameContext): string {
  return generatedName(context, 255);
}
function issue(issues: ProviderValidationIssue[], path: string, message: string): void { issues.push({ code: "InvalidProperty", path, message }); }

function tags(value: unknown, maximum = 48): readonly { Key: string; Value: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("Tags must be an array");
  const result = value.map(item => {
    if (!record(item) || typeof item.Key !== "string" || typeof item.Value !== "string") throw new TypeError("Each tag requires string Key and Value");
    return { Key: item.Key, Value: item.Value };
  }).sort((a, b) => a.Key.localeCompare(b.Key));
  if (result.length > maximum || new Set(result.map(item => item.Key)).size !== result.length || result.some(item => !item.Key || item.Key.toLowerCase().startsWith("aws:") || INTERNAL_TAGS.has(item.Key))) throw new TypeError(`Tags require unique non-reserved keys and at most ${maximum} entries`);
  return result;
}

function tagMap(value: readonly { Key: string; Value: string }[]): Record<string, string> { return Object.fromEntries(value.map(tag => [tag.Key, tag.Value])); }
function serviceTags(value: readonly { Key: string; Value: string }[], context: ProviderContext, explicitIdentifier?: boolean): { Tag: Array<{ Key: string; Value: string }> } {
  return { Tag: [...value, { Key: OWNER_TAG, Value: owner(context) }, ...(explicitIdentifier === undefined ? [] : [{ Key: EXPLICIT_IDENTIFIER_TAG, Value: String(explicitIdentifier) }])] };
}
function userTags(value: Readonly<Record<string, string>>): readonly { Key: string; Value: string }[] { return Object.entries(value).filter(([key]) => !INTERNAL_TAGS.has(key)).map(([Key, Value]) => ({ Key, Value })).sort((a, b) => a.Key.localeCompare(b.Key)); }
function owned(value: Readonly<Record<string, string>>, context: ProviderContext): boolean { return value[OWNER_TAG] === owner(context); }
function failed(error: unknown) { const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500); return { status: "FAILED" as const, errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 }; }
function notFound(error: unknown): boolean { return error instanceof AwsError && new Set(["DBInstanceNotFound", "DBParameterGroupNotFound"]).has(error.code); }
function progress(physicalId: string, phase: string): ProviderInProgress { return { status: "IN_PROGRESS", callbackAfterMs: 250, checkpoint: { schemaVersion: 1, physicalId, callbackContext: { phase } }, message: phase }; }
function failedCreateCleanupProgress(physicalId: string, reason: string): ProviderInProgress { return { status: "IN_PROGRESS", callbackAfterMs: 250, checkpoint: { schemaVersion: 1, physicalId, callbackContext: { phase: "cleanup-failed-create", reason: reason.slice(0, 4096) } }, message: "cleanup-failed-create" }; }

function validateInstance(properties: Record<string, unknown>, issues: ProviderValidationIssue[]): void {
  const identifier = properties.DBInstanceIdentifier;
  if (identifier !== undefined && (typeof identifier !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(identifier) || identifier.endsWith("-") || identifier.includes("--"))) issue(issues, "Properties.DBInstanceIdentifier", "DBInstanceIdentifier must be a valid lowercase RDS identifier");
  if (properties.DBInstanceClass !== INSTANCE_CLASS) issue(issues, "Properties.DBInstanceClass", `Only ${INSTANCE_CLASS} is supported`);
  if (String(properties.Engine ?? "").toLowerCase() !== "mysql") issue(issues, "Properties.Engine", "Only Engine=mysql is supported");
  if (properties.EngineVersion !== undefined && properties.EngineVersion !== ENGINE_VERSION) issue(issues, "Properties.EngineVersion", `Only engine version ${ENGINE_VERSION} is supported`);
  const allocated = String(properties.AllocatedStorage ?? "20"); if (!integerRange(allocated, 20, 65_536)) issue(issues, "Properties.AllocatedStorage", "AllocatedStorage must be an integer string from 20 through 65536");
  if (properties.StorageType !== undefined && !new Set(["gp2", "gp3"]).has(String(properties.StorageType))) issue(issues, "Properties.StorageType", "StorageType must be gp2 or gp3");
  if (properties.DBName !== undefined && (typeof properties.DBName !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(properties.DBName))) issue(issues, "Properties.DBName", "DBName must be a valid local database name");
  if (typeof properties.MasterUsername !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(properties.MasterUsername) || /^root$/i.test(properties.MasterUsername)) issue(issues, "Properties.MasterUsername", "MasterUsername is invalid or reserved");
  const managed = properties.ManageMasterUserPassword === true;
  if (managed && properties.MasterUserPassword !== undefined) issue(issues, "Properties.MasterUserPassword", "MasterUserPassword and ManageMasterUserPassword are mutually exclusive");
  if (!managed && (typeof properties.MasterUserPassword !== "string" || properties.MasterUserPassword.length < 8 || properties.MasterUserPassword.length > 41 || /[^\x20-\x7e]/.test(properties.MasterUserPassword) || /[\/@\"]/.test(properties.MasterUserPassword))) issue(issues, "Properties.MasterUserPassword", "MasterUserPassword is required unless ManageMasterUserPassword=true and must be 8-41 printable ASCII characters without slash, at-sign, or double quote");
  if (properties.MasterUserSecretKmsKeyId !== undefined) issue(issues, "Properties.MasterUserSecretKmsKeyId", "Customer KMS is outside the local RDS managed-secret profile");
  const port = String(properties.Port ?? "3306"); if (!integerRange(port, 1_150, 65_535)) issue(issues, "Properties.Port", "Port must be an integer string from 1150 through 65535");
  if (properties.BackupRetentionPeriod !== undefined && properties.BackupRetentionPeriod !== 0) issue(issues, "Properties.BackupRetentionPeriod", "Automated backups and PITR are unavailable; BackupRetentionPeriod must remain 0");
  if (properties.PubliclyAccessible !== undefined && properties.PubliclyAccessible !== false) issue(issues, "Properties.PubliclyAccessible", "PubliclyAccessible must be false");
  if (properties.MultiAZ !== undefined && properties.MultiAZ !== false) issue(issues, "Properties.MultiAZ", "MultiAZ must be false");
  if (properties.DBParameterGroupName !== undefined && (typeof properties.DBParameterGroupName !== "string" || !properties.DBParameterGroupName)) issue(issues, "Properties.DBParameterGroupName", "DBParameterGroupName must be a nonempty string");
  try { tags(properties.Tags, 48); } catch (error) { issue(issues, "Properties.Tags", error instanceof Error ? error.message : String(error)); }
}

function parameters(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return { character_set_server: "utf8mb4" };
  if (!record(value)) throw new TypeError("Parameters must be an object");
  const result: Record<string, string> = { character_set_server: "utf8mb4" };
  for (const [name, raw] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    const normalized = String(raw);
    if (name === "character_set_server") { if (normalized !== "utf8mb4") throw new TypeError("character_set_server is read-only and must remain utf8mb4"); continue; }
    const validator = DYNAMIC_PARAMETERS[name] ?? STATIC_PARAMETERS[name];
    if (!validator) throw new TypeError(`Parameter ${name} is outside the safe RDS allowlist`);
    if (!validator(normalized)) throw new TypeError(`Parameter ${name} has an unsupported value`);
    result[name] = normalized;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function canonicalInstance(properties: Record<string, unknown>): RdsDbInstanceModel {
  return stable({
    ...(properties.DBInstanceIdentifier !== undefined ? { DBInstanceIdentifier: String(properties.DBInstanceIdentifier).toLowerCase() } : {}),
    AllocatedStorage: String(properties.AllocatedStorage ?? "20"), BackupRetentionPeriod: 0 as const, DBInstanceClass: INSTANCE_CLASS,
    ...(properties.DBName !== undefined ? { DBName: String(properties.DBName) } : {}),
    DBParameterGroupName: String(properties.DBParameterGroupName ?? DEFAULT_PARAMETER_GROUP), DeletionProtection: Boolean(properties.DeletionProtection ?? false), Engine: "mysql" as const, EngineVersion: ENGINE_VERSION,
    MasterUsername: String(properties.MasterUsername), ...(properties.MasterUserPassword === undefined ? {} : { MasterUserPassword: String(properties.MasterUserPassword) }), ManageMasterUserPassword: properties.ManageMasterUserPassword === true, MultiAZ: false as const, Port: String(properties.Port ?? "3306"), PubliclyAccessible: false as const,
    StorageType: String(properties.StorageType ?? "gp3") as "gp2" | "gp3", Tags: tags(properties.Tags, 48),
  });
}

function canonicalParameterGroup(properties: Record<string, unknown>): RdsDbParameterGroupModel {
  return stable({ Description: String(properties.Description), Family: PARAMETER_FAMILY, Parameters: parameters(properties.Parameters), Tags: tags(properties.Tags, 49) });
}

function changed<T extends object>(previous: T, desired: T): string[] { return [...new Set([...Object.keys(previous), ...Object.keys(desired)])].filter(key => !same((previous as any)[key], (desired as any)[key])).sort(); }

function instanceAttributes(state: RdsDbInstanceState): Record<string, unknown> {
  const endpoint = { Address: "127.0.0.1", Port: String(state.port), HostedZoneId: "local" };
  const master = state.masterUserSecretArn ? { SecretArn: state.masterUserSecretArn, SecretStatus: "active" } : undefined;
  return { DBInstanceArn: state.dbInstanceArn, DbiResourceId: state.dbiResourceId, Endpoint: endpoint, "Endpoint.Address": endpoint.Address, "Endpoint.Port": endpoint.Port, "Endpoint.HostedZoneId": endpoint.HostedZoneId, ...(master ? { MasterUserSecret: master, "MasterUserSecret.SecretArn": master.SecretArn, "MasterUserSecret.SecretStatus": master.SecretStatus } : {}) };
}

export function createRdsDbInstanceProvider(manager: RdsManager, region: string): ProductionResourceProvider<RdsDbInstanceModel> {
  const snapshot = async (physicalId: string, context: ProviderContext): Promise<{ state: RdsDbInstanceState; model: RdsDbInstanceModel; tags: Record<string, string> }> => {
    const state = manager.describe(region, { DBInstanceIdentifier: physicalId })[0];
    const currentTags = manager.listTags(region, { ResourceName: state.dbInstanceArn });
    const secret = state.manageMasterUserPassword ? undefined : await manager.cloudFormationCredentials(region, physicalId);
    const model: RdsDbInstanceModel = stable({
      ...(currentTags[EXPLICIT_IDENTIFIER_TAG] === "true" ? { DBInstanceIdentifier: state.dbInstanceIdentifier } : {}),
      AllocatedStorage: String(state.allocatedStorage), BackupRetentionPeriod: 0 as const, DBInstanceClass: INSTANCE_CLASS,
      ...(state.dbName ? { DBName: state.dbName } : {}), DBParameterGroupName: state.dbParameterGroupName, DeletionProtection: state.deletionProtection,
      Engine: "mysql" as const, EngineVersion: ENGINE_VERSION, MasterUsername: state.masterUsername, ...(secret ? { MasterUserPassword: secret.masterPassword } : {}), ManageMasterUserPassword: state.manageMasterUserPassword === true,
      MultiAZ: false as const, Port: String(state.port), PubliclyAccessible: false as const, StorageType: state.storageType, Tags: userTags(currentTags),
    });
    return { state, model, tags: currentTags };
  };
  const success = (physicalId: string, value: Awaited<ReturnType<typeof snapshot>>): ProviderSuccess<RdsDbInstanceModel> => ({ status: "SUCCESS", physicalId, model: { physicalId, properties: value.model, attributes: instanceAttributes(value.state) } });
  const reconcile = async (physicalId: string, previous: RdsDbInstanceModel, desired: RdsDbInstanceModel, context: ProviderContext): Promise<ProviderUpdateResult<RdsDbInstanceModel>> => {
    try {
      const current = await snapshot(physicalId, context);
      if (!owned(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `DB instance ${physicalId} is not owned by this stack resource` };
      if (["creating", "modifying", "rebooting", "starting", "stopping", "deleting"].includes(current.state.dbInstanceStatus)) return progress(physicalId, `wait-for-${current.state.dbInstanceStatus}`);
      if (current.state.dbInstanceStatus === "failed") return { status: "FAILED", errorCode: "DBInstanceFailed", message: current.state.statusMessage ?? `DB instance ${physicalId} is failed` };
      const mutable = ["AllocatedStorage", "DBParameterGroupName", "DeletionProtection", "EngineVersion", "MasterUserPassword", "ManageMasterUserPassword", "Port", "StorageType"] as const;
      const input: Record<string, unknown> = { DBInstanceIdentifier: physicalId, ApplyImmediately: true };
      const apiNames: Record<(typeof mutable)[number], string> = { AllocatedStorage: "AllocatedStorage", DBParameterGroupName: "DBParameterGroupName", DeletionProtection: "DeletionProtection", EngineVersion: "EngineVersion", MasterUserPassword: "MasterUserPassword", ManageMasterUserPassword: "ManageMasterUserPassword", Port: "DBPortNumber", StorageType: "StorageType" };
      for (const key of mutable) if (!same((current.model as any)[key], (desired as any)[key])) input[apiNames[key]] = key === "AllocatedStorage" || key === "Port" ? Number((desired as any)[key]) : (desired as any)[key];
      if (Object.keys(input).length > 2) { await manager.modify(region, input); return progress(physicalId, "modify-db-instance"); }
      const actualTags = tagMap(current.model.Tags); const wantedTags = tagMap(desired.Tags);
      const removals = Object.keys(actualTags).filter(key => !Object.hasOwn(wantedTags, key));
      if (removals.length) await manager.removeTags(region, { ResourceName: current.state.dbInstanceArn, TagKeys: { member: removals } });
      const additions = Object.entries(wantedTags).filter(([key, value]) => actualTags[key] !== value).map(([Key, Value]) => ({ Key, Value }));
      if (additions.length) await manager.addTags(region, { ResourceName: current.state.dbInstanceArn, Tags: { Tag: additions } });
      return success(physicalId, await snapshot(physicalId, context));
    } catch (error) { return failed(error); }
  };
  return {
    typeName: RDS_DB_INSTANCE_TYPE, providerVersion: 1, visibility: "production", schema: RDS_DB_INSTANCE_SCHEMA,
    validate(properties: unknown): readonly ProviderValidationIssue[] { const issues = validateDeclaredProperties(properties ?? {}, RDS_DB_INSTANCE_SCHEMA); if (record(properties)) validateInstance(properties, issues); return issues; },
    canonicalize(properties: unknown, context: ProviderContext): RdsDbInstanceModel { if (!record(properties)) throw new TypeError(`${RDS_DB_INSTANCE_TYPE} Properties must be an object`); const issues = this.validate(properties, context); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; ")); return canonicalInstance(properties); },
    plan(previous: RdsDbInstanceModel | undefined, desired: RdsDbInstanceModel): ProviderPlan<RdsDbInstanceModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const differences = changed(previous, desired); if (!differences.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      const replacements = differences.filter(key => new Set(["DBInstanceIdentifier", "DBName", "Engine", "MasterUsername"]).has(key));
      if (replacements.length) throw new TypeError(`The singleton RDS slot cannot perform CloudFormation replacement for ${replacements.join(", ")}; RDS-03 restore is an explicit free-slot operation`);
      return { action: "UPDATE", desired, changedProperties: differences, replacementProperties: [] };
    },
    async create(desired: RdsDbInstanceModel, context: ProviderContext) {
      const physicalId = desired.DBInstanceIdentifier ?? generatedName(context, 63);
      const cleaningFailedCreate = context.callbackContext?.phase === "cleanup-failed-create";
      const createFailureReason = typeof context.callbackContext?.reason === "string" ? context.callbackContext.reason : `DB instance ${physicalId} failed during creation`;
      try {
        try {
          const raw = manager.describe(region, { DBInstanceIdentifier: physicalId })[0];
          const currentTags = manager.listTags(region, { ResourceName: raw.dbInstanceArn });
          if (!owned(currentTags, context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `DB instance ${physicalId} already exists and is not owned by this stack resource` };
          if (cleaningFailedCreate || raw.dbInstanceStatus === "failed") {
            const reason = raw.statusMessage ?? createFailureReason;
            if (raw.dbInstanceStatus !== "deleting") await manager.cleanupFailedCloudFormationCreate(region, physicalId);
            return failedCreateCleanupProgress(physicalId, reason);
          }
          const existing = await snapshot(physicalId, context);
          return reconcile(physicalId, existing.model, desired, context);
        } catch (error) {
          if (!notFound(error)) throw error;
          if (cleaningFailedCreate) return { status: "FAILED", errorCode: "DBInstanceFailed", message: createFailureReason };
        }
        await manager.create(region, { DBInstanceIdentifier: physicalId, AllocatedStorage: Number(desired.AllocatedStorage), DBInstanceClass: desired.DBInstanceClass, Engine: desired.Engine, EngineVersion: desired.EngineVersion, ...(desired.DBName ? { DBName: desired.DBName } : {}), MasterUsername: desired.MasterUsername, ...(desired.MasterUserPassword === undefined ? {} : { MasterUserPassword: desired.MasterUserPassword }), ManageMasterUserPassword: desired.ManageMasterUserPassword, DBParameterGroupName: desired.DBParameterGroupName, BackupRetentionPeriod: 0, Port: Number(desired.Port), MultiAZ: false, PubliclyAccessible: false, StorageType: desired.StorageType, DeletionProtection: desired.DeletionProtection, Tags: serviceTags(desired.Tags, context, desired.DBInstanceIdentifier !== undefined) });
        return progress(physicalId, "create-db-instance");
      } catch (error) { return failed(error); }
    },
    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<RdsDbInstanceModel>> { try { const value = await snapshot(physicalId, context); if (!owned(value.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `DB instance ${physicalId} is not owned by this stack resource` }; if (["creating", "modifying", "rebooting", "starting", "stopping", "deleting"].includes(value.state.dbInstanceStatus)) return progress(physicalId, `wait-for-${value.state.dbInstanceStatus}`); if (value.state.dbInstanceStatus === "failed") return { status: "FAILED", errorCode: "DBInstanceFailed", message: value.state.statusMessage ?? `DB instance ${physicalId} is failed` }; return success(physicalId, value); } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderReadResult<RdsDbInstanceModel>; } },
    async update(physicalId: string, previous: RdsDbInstanceModel, desired: RdsDbInstanceModel, context: ProviderContext): Promise<ProviderUpdateResult<RdsDbInstanceModel>> { if (desired.DBInstanceIdentifier !== undefined && desired.DBInstanceIdentifier !== physicalId) return { status: "FAILED", errorCode: "RequiresReplacement", message: "DBInstanceIdentifier changes require replacement" }; return reconcile(physicalId, previous, desired, context); },
    async delete(physicalId: string, _previous: RdsDbInstanceModel, context: ProviderContext): Promise<ProviderDeleteResult> { try { const value = await snapshot(physicalId, context); if (!owned(value.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `DB instance ${physicalId} is not owned by this stack resource` }; if (value.state.dbInstanceStatus === "deleting") return progress(physicalId, "delete-db-instance"); if (["creating", "backing-up", "modifying", "rebooting", "starting", "stopping"].includes(value.state.dbInstanceStatus)) return progress(physicalId, `wait-for-${value.state.dbInstanceStatus}`); const finalIdentifier = `cfn-${createHash("sha256").update(`${context.stackId}\0${context.logicalId}\0${physicalId}`).digest("hex").slice(0, 40)}`; await manager.delete(region, context.retentionPolicy === "Snapshot" ? { DBInstanceIdentifier: physicalId, SkipFinalSnapshot: false, FinalDBSnapshotIdentifier: finalIdentifier, DeleteAutomatedBackups: true } : { DBInstanceIdentifier: physicalId, SkipFinalSnapshot: true, DeleteAutomatedBackups: true }); return progress(physicalId, "delete-db-instance"); } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult; } },
    ref(model: ProviderReadModel<RdsDbInstanceModel>): unknown { return model.physicalId; },
    getAtt(model: ProviderReadModel<RdsDbInstanceModel>, attribute: string): unknown { if (Object.hasOwn(model.attributes, attribute)) return model.attributes[attribute]; throw new ProviderReferenceError(RDS_DB_INSTANCE_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

export function createRdsDbParameterGroupProvider(manager: RdsManager, region: string): ProductionResourceProvider<RdsDbParameterGroupModel> {
  const snapshot = (physicalId: string): { state: RdsDbParameterGroupState; model: RdsDbParameterGroupModel; tags: Record<string, string> } => {
    const state = manager.describeParameterGroups(region, { DBParameterGroupName: physicalId })[0];
    if (!state) throw new AwsError("DBParameterGroupNotFound", `Default parameter group ${physicalId} cannot be owned by CloudFormation`, 404);
    const currentTags = manager.listTags(region, { ResourceName: state.dbParameterGroupArn });
    const overrides = Object.fromEntries(Object.entries(state.parameters).map(([name, item]) => [name, item.value]));
    const model: RdsDbParameterGroupModel = stable({ Description: state.description, Family: state.dbParameterGroupFamily, Parameters: { character_set_server: "utf8mb4", ...overrides }, Tags: userTags(currentTags) });
    return { state, model, tags: currentTags };
  };
  const success = (physicalId: string, value: ReturnType<typeof snapshot>): ProviderSuccess<RdsDbParameterGroupModel> => ({ status: "SUCCESS", physicalId, model: { physicalId, properties: value.model, attributes: { Arn: value.state.dbParameterGroupArn, DBParameterGroupName: physicalId } } });
  const applyParameters = async (physicalId: string, previous: Readonly<Record<string, string>>, desired: Readonly<Record<string, string>>): Promise<void> => {
    const removed = Object.keys(previous).filter(name => name !== "character_set_server" && !Object.hasOwn(desired, name));
    if (removed.length) await manager.resetParameterGroup(region, { DBParameterGroupName: physicalId, ResetAllParameters: false, Parameters: { Parameter: removed.map(ParameterName => ({ ParameterName, ApplyMethod: STATIC_PARAMETERS[ParameterName] ? "pending-reboot" : "immediate" })) } });
    const updates = Object.entries(desired).filter(([name, value]) => name !== "character_set_server" && previous[name] !== value).map(([ParameterName, ParameterValue]) => ({ ParameterName, ParameterValue, ApplyMethod: STATIC_PARAMETERS[ParameterName] ? "pending-reboot" : "immediate" }));
    if (updates.length) await manager.modifyParameterGroup(region, { DBParameterGroupName: physicalId, Parameters: { Parameter: updates } });
  };
  return {
    typeName: RDS_DB_PARAMETER_GROUP_TYPE, providerVersion: 1, visibility: "production", schema: RDS_DB_PARAMETER_GROUP_SCHEMA,
    validate(properties: unknown): readonly ProviderValidationIssue[] { const issues = validateDeclaredProperties(properties ?? {}, RDS_DB_PARAMETER_GROUP_SCHEMA); if (!record(properties)) return issues; if (typeof properties.Description !== "string" || !properties.Description || properties.Description.length > 255) issue(issues, "Properties.Description", "Description must be 1-255 characters"); if (properties.Family !== PARAMETER_FAMILY) issue(issues, "Properties.Family", `Family must be ${PARAMETER_FAMILY}`); try { parameters(properties.Parameters); } catch (error) { issue(issues, "Properties.Parameters", error instanceof Error ? error.message : String(error)); } try { tags(properties.Tags, 49); } catch (error) { issue(issues, "Properties.Tags", error instanceof Error ? error.message : String(error)); } return issues; },
    canonicalize(properties: unknown, context: ProviderContext): RdsDbParameterGroupModel { if (!record(properties)) throw new TypeError(`${RDS_DB_PARAMETER_GROUP_TYPE} Properties must be an object`); const issues = this.validate(properties, context); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; ")); return canonicalParameterGroup(properties); },
    plan(previous: RdsDbParameterGroupModel | undefined, desired: RdsDbParameterGroupModel): ProviderPlan<RdsDbParameterGroupModel> { if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] }; const differences = changed(previous, desired); if (!differences.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] }; const replacements = differences.filter(key => key === "Description" || key === "Family"); return replacements.length ? { action: "REPLACE", desired, changedProperties: differences, replacementProperties: replacements, replacementOrder: "CREATE_BEFORE_DELETE" } : { action: "UPDATE", desired, changedProperties: differences, replacementProperties: [] }; },
    async create(desired: RdsDbParameterGroupModel, context: ProviderContext) { const physicalId = rdsDbParameterGroupPhysicalId(context); try { try { const existing = snapshot(physicalId); if (!owned(existing.tags, context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `DB parameter group ${physicalId} already exists and is not owned by this stack resource` }; await applyParameters(physicalId, existing.model.Parameters, desired.Parameters); const actualTags = tagMap(existing.model.Tags); const wantedTags = tagMap(desired.Tags); const removals = Object.keys(actualTags).filter(key => !Object.hasOwn(wantedTags, key)); if (removals.length) await manager.removeTags(region, { ResourceName: existing.state.dbParameterGroupArn, TagKeys: { member: removals } }); const additions = Object.entries(wantedTags).filter(([key, value]) => actualTags[key] !== value).map(([Key, Value]) => ({ Key, Value })); if (additions.length) await manager.addTags(region, { ResourceName: existing.state.dbParameterGroupArn, Tags: { Tag: additions } }); return success(physicalId, snapshot(physicalId)); } catch (error) { if (!notFound(error)) throw error; } await manager.createParameterGroup(region, { DBParameterGroupName: physicalId, DBParameterGroupFamily: desired.Family, Description: desired.Description, Tags: serviceTags(desired.Tags, context) }); await applyParameters(physicalId, {}, desired.Parameters); return success(physicalId, snapshot(physicalId)); } catch (error) { return failed(error); } },
    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<RdsDbParameterGroupModel>> { try { const value = snapshot(physicalId); return owned(value.tags, context) ? success(physicalId, value) : { status: "FAILED", errorCode: "OwnershipConflict", message: `DB parameter group ${physicalId} is not owned by this stack resource` }; } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderReadResult<RdsDbParameterGroupModel>; } },
    async update(physicalId: string, previous: RdsDbParameterGroupModel, desired: RdsDbParameterGroupModel, context: ProviderContext): Promise<ProviderUpdateResult<RdsDbParameterGroupModel>> { try { const current = snapshot(physicalId); if (!owned(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `DB parameter group ${physicalId} is not owned by this stack resource` }; await applyParameters(physicalId, current.model.Parameters, desired.Parameters); const actualTags = tagMap(current.model.Tags); const wantedTags = tagMap(desired.Tags); const removals = Object.keys(actualTags).filter(key => !Object.hasOwn(wantedTags, key)); if (removals.length) await manager.removeTags(region, { ResourceName: current.state.dbParameterGroupArn, TagKeys: { member: removals } }); const additions = Object.entries(wantedTags).filter(([key, value]) => actualTags[key] !== value).map(([Key, Value]) => ({ Key, Value })); if (additions.length) await manager.addTags(region, { ResourceName: current.state.dbParameterGroupArn, Tags: { Tag: additions } }); return success(physicalId, snapshot(physicalId)); } catch (error) { return failed(error); } },
    async delete(physicalId: string, _previous: RdsDbParameterGroupModel, context: ProviderContext): Promise<ProviderDeleteResult> { try { const current = snapshot(physicalId); if (!owned(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `DB parameter group ${physicalId} is not owned by this stack resource` }; await manager.deleteParameterGroup(region, { DBParameterGroupName: physicalId }); return { status: "SUCCESS", physicalId }; } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult; } },
    ref(model: ProviderReadModel<RdsDbParameterGroupModel>): unknown { return model.physicalId; },
    getAtt(model: ProviderReadModel<RdsDbParameterGroupModel>, attribute: string): unknown { if (Object.hasOwn(model.attributes, attribute)) return model.attributes[attribute]; throw new ProviderReferenceError(RDS_DB_PARAMETER_GROUP_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

export function createRdsCloudFormationProviders(manager: RdsManager, region: string): readonly ProductionResourceProvider<any>[] {
  return [createRdsDbParameterGroupProvider(manager, region), createRdsDbInstanceProvider(manager, region)];
}
