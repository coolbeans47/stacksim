import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { AwsError, sendAwsError } from "./errors.js";
import type { StateStore } from "./state.js";
import type { Clock } from "./core/clock.js";
import { SystemClock } from "./core/clock.js";
import type { TelemetryBus } from "./core/telemetry.js";
import type { Scheduler } from "./core/scheduler.js";
import { PaginationTokens } from "./core/pagination.js";
import type { DynamoAutoScalingSettingState, DynamoBackupState, DynamoContributorInsightsMode, DynamoContributorInsightsState, DynamoExportState, DynamoImportState, DynamoIndexState, DynamoOnDemandThroughputState, DynamoProvisionedThroughputState, DynamoStreamDescriptorState, DynamoStreamRecordState, DynamoStreamViewType, DynamoWarmThroughputState, Item, ServiceIntegrationAttemptMetadataState, ServiceIntegrationAttemptState, TableState } from "./types.js";
import { acceptedIntegrationAttempt, assertMatchingIntegrationAttempt, integrationOutputDigest, type ServiceIntegrationAttempt } from "./step-functions/integration-attempt.js";
import { DynamoIntegrationAttemptStore } from "./dynamodb/integration-attempt-store.js";
import { id, json, readJson } from "./util.js";
import { applyUpdateExpression, conditionPaths, evaluateCondition, parseConditionExpression, parseProjectionExpression, projectItem, validateExpressionSubstitutions, validateKeyCondition } from "./dynamodb/expressions.js";
import { attributeType, clone, compareAttributeValues, equalAttributeValues, keyFromItem, stableItemKey, validateItem, validateKey } from "./dynamodb/values.js";
import { classifyPartiqlAccess, parsePartiql, projectPartiqlItem, type PartiqlPlan } from "./dynamodb/partiql.js";
import { DynamoBackupPersistence, type DynamoPitrChange } from "./dynamodb/backups.js";
import { DynamoStreamPersistence } from "./dynamodb/streams.js";
import { DynamoGlobalTablePersistence } from "./dynamodb/global-tables.js";
import { combineIdentityAndResourceAuthorization, evaluateResourcePolicy } from "./iam/evaluator.js";
import type { PrincipalContext } from "./auth/sigv4.js";
import type { DynamoGlobalTableChangeState, DynamoGlobalTableItemVersionState, DynamoResourcePolicyState, PolicyDocument, PolicyStatement } from "./types.js";

const DYNAMODB_READ_PAGE_BYTES = 1024 * 1024;
const PARTIQL_TOKEN_TTL_MS = 15 * 60_000;

function indexItems(table: TableState, index: DynamoIndexState): Item[] {
  return Object.values(table.items).filter(item => index.keySchema.every(key => item[key.AttributeName]));
}

function indexKey(table: TableState, index: DynamoIndexState, item: Item): Item {
  const names = new Set([...table.keySchema, ...index.keySchema].map(key => key.AttributeName));
  return Object.fromEntries([...names].map(name => [name, clone(item[name])]));
}

function projectedIndexItem(table: TableState, index: DynamoIndexState, item: Item): Item {
  if (index.projection.ProjectionType === "ALL") return clone(item);
  const names = new Set([...table.keySchema, ...index.keySchema].map(key => key.AttributeName));
  for (const name of index.projection.NonKeyAttributes ?? []) names.add(name);
  return Object.fromEntries([...names].filter(name => item[name]).map(name => [name, clone(item[name])]));
}

function validateThroughput(value: any, required: boolean): DynamoProvisionedThroughputState | undefined {
  if (!value) { if (required) throw new AwsError("ValidationException", "ProvisionedThroughput is required for PROVISIONED capacity mode"); return undefined; }
  if (!Number.isInteger(value.ReadCapacityUnits) || value.ReadCapacityUnits <= 0 || !Number.isInteger(value.WriteCapacityUnits) || value.WriteCapacityUnits <= 0) throw new AwsError("ValidationException", "ReadCapacityUnits and WriteCapacityUnits must be positive integers");
  return { ReadCapacityUnits: value.ReadCapacityUnits, WriteCapacityUnits: value.WriteCapacityUnits };
}

function updateThroughput(previous: DynamoProvisionedThroughputState | undefined, value: any, now: number): DynamoProvisionedThroughputState {
  const next = validateThroughput(value, true)!; if (!previous) return next;
  const day = new Date(now).toISOString().slice(0, 10); const decreased = next.ReadCapacityUnits < previous.ReadCapacityUnits || next.WriteCapacityUnits < previous.WriteCapacityUnits; const increased = next.ReadCapacityUnits > previous.ReadCapacityUnits || next.WriteCapacityUnits > previous.WriteCapacityUnits;
  return { ...next, ...(increased ? { lastIncreaseAt: now } : previous.lastIncreaseAt ? { lastIncreaseAt: previous.lastIncreaseAt } : {}), ...(decreased ? { lastDecreaseAt: now } : previous.lastDecreaseAt ? { lastDecreaseAt: previous.lastDecreaseAt } : {}), decreasesToday: decreased ? (previous.decreaseDay === day ? previous.decreasesToday ?? 0 : 0) + 1 : previous.decreaseDay === day ? previous.decreasesToday ?? 0 : 0, decreaseDay: day };
}

function throughputDescription(value: DynamoProvisionedThroughputState | undefined): any {
  const throughput = value ?? { ReadCapacityUnits: 0, WriteCapacityUnits: 0 };
  return { ReadCapacityUnits: throughput.ReadCapacityUnits, WriteCapacityUnits: throughput.WriteCapacityUnits, NumberOfDecreasesToday: throughput.decreasesToday ?? 0, ...(throughput.lastIncreaseAt !== undefined ? { LastIncreaseDateTime: throughput.lastIncreaseAt / 1000 } : {}), ...(throughput.lastDecreaseAt !== undefined ? { LastDecreaseDateTime: throughput.lastDecreaseAt / 1000 } : {}) };
}

function validateOnDemandThroughput(value: any, updating = false): DynamoOnDemandThroughputState | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || (value.MaxReadRequestUnits === undefined && value.MaxWriteRequestUnits === undefined)) throw new AwsError("ValidationException", "OnDemandThroughput must specify MaxReadRequestUnits, MaxWriteRequestUnits, or both");
  const result: DynamoOnDemandThroughputState = {};
  for (const field of ["MaxReadRequestUnits", "MaxWriteRequestUnits"] as const) if (value[field] !== undefined) {
    const units = value[field]; if (!Number.isInteger(units) || (units < 1 && !(updating && units === -1))) throw new AwsError("ValidationException", `${field} must be a positive integer${updating ? " or -1" : ""}`);
    if (units !== -1) result[field] = units;
  }
  return result;
}

function validateWarmThroughput(value: any, now: number, status: "CREATING" | "UPDATING" = "UPDATING"): DynamoWarmThroughputState | undefined {
  if (value === undefined) return undefined;
  if (!value || !Number.isInteger(value.ReadUnitsPerSecond) || value.ReadUnitsPerSecond < 1 || !Number.isInteger(value.WriteUnitsPerSecond) || value.WriteUnitsPerSecond < 1) throw new AwsError("ValidationException", "WarmThroughput requires positive integer ReadUnitsPerSecond and WriteUnitsPerSecond");
  return { ReadUnitsPerSecond: value.ReadUnitsPerSecond, WriteUnitsPerSecond: value.WriteUnitsPerSecond, status, lastUpdatedAt: now };
}

function warmThroughputDescription(value: DynamoWarmThroughputState | undefined): any {
  return value ? { ReadUnitsPerSecond: value.ReadUnitsPerSecond, WriteUnitsPerSecond: value.WriteUnitsPerSecond, Status: value.status } : undefined;
}

function validateTags(value: any, existing: Record<string, string> = {}): Record<string, string> {
  if (value === undefined) return clone(existing);
  if (!Array.isArray(value) || value.length > 50) throw new AwsError("ValidationException", "Tags must contain at most 50 entries");
  const result = clone(existing); const keys = new Set<string>();
  for (const tag of value) {
    if (!tag || typeof tag.Key !== "string" || tag.Key.length < 1 || tag.Key.length > 128 || /^aws:/i.test(tag.Key) || typeof tag.Value !== "string" || tag.Value.length > 256 || keys.has(tag.Key)) throw new AwsError("ValidationException", "Invalid tag key or value");
    keys.add(tag.Key); result[tag.Key] = tag.Value;
  }
  if (Object.keys(result).length > 50) throw new AwsError("LimitExceededException", "A maximum of 50 tags can be associated with a resource");
  return result;
}

function validateSse(value: any, now: number): TableState["sse"] {
  if (value === undefined || value.Enabled === false) return { sseType: "AES256", status: "ENABLED", lastUpdatedAt: now };
  if (value.Enabled !== true || (value.SSEType !== undefined && value.SSEType !== "KMS") || (value.KMSMasterKeyId !== undefined && (typeof value.KMSMasterKeyId !== "string" || !value.KMSMasterKeyId.length))) throw new AwsError("ValidationException", "SSESpecification must select the AWS owned key or a valid KMS key");
  return { sseType: "KMS", status: "UPDATING", ...(value.KMSMasterKeyId ? { kmsMasterKeyId: value.KMSMasterKeyId } : {}), lastUpdatedAt: now };
}

function validateAutoScalingSetting(value: any): DynamoAutoScalingSettingState {
  if (!value || !Number.isInteger(value.MinimumUnits) || value.MinimumUnits < 1 || !Number.isInteger(value.MaximumUnits) || value.MaximumUnits < value.MinimumUnits) throw new AwsError("ValidationException", "Auto scaling MinimumUnits and MaximumUnits must be positive integers and maximum must not be lower than minimum");
  if (value.AutoScalingDisabled !== undefined && typeof value.AutoScalingDisabled !== "boolean") throw new AwsError("ValidationException", "AutoScalingDisabled must be a boolean");
  if (value.AutoScalingRoleArn !== undefined && (typeof value.AutoScalingRoleArn !== "string" || !/^arn:[^:]+:iam::\d{12}:role\/.+/.test(value.AutoScalingRoleArn))) throw new AwsError("ValidationException", "Invalid AutoScalingRoleArn");
  const policy = value.ScalingPolicyUpdate; let scalingPolicy: DynamoAutoScalingSettingState["scalingPolicy"];
  if (policy !== undefined) { const target = policy.TargetTrackingScalingPolicyConfiguration; if (!target || typeof target.TargetValue !== "number" || !Number.isFinite(target.TargetValue) || target.TargetValue <= 0) throw new AwsError("ValidationException", "TargetValue must be a positive number"); for (const field of ["ScaleInCooldown", "ScaleOutCooldown"]) if (target[field] !== undefined && (!Number.isInteger(target[field]) || target[field] < 0)) throw new AwsError("ValidationException", `${field} must be a non-negative integer`); scalingPolicy = { ...(policy.PolicyName ? { policyName: String(policy.PolicyName) } : {}), disableScaleIn: target.DisableScaleIn ?? false, scaleInCooldown: target.ScaleInCooldown ?? 0, scaleOutCooldown: target.ScaleOutCooldown ?? 0, targetValue: target.TargetValue }; }
  return { autoScalingDisabled: value.AutoScalingDisabled ?? false, ...(value.AutoScalingRoleArn ? { autoScalingRoleArn: value.AutoScalingRoleArn } : {}), minimumUnits: value.MinimumUnits, maximumUnits: value.MaximumUnits, ...(scalingPolicy ? { scalingPolicy } : {}) };
}

function autoScalingDescription(value: DynamoAutoScalingSettingState | undefined): any {
  if (!value) return undefined; const policy = value.scalingPolicy;
  return { AutoScalingDisabled: value.autoScalingDisabled, ...(value.autoScalingRoleArn ? { AutoScalingRoleArn: value.autoScalingRoleArn } : {}), MinimumUnits: value.minimumUnits, MaximumUnits: value.maximumUnits, ...(policy ? { ScalingPolicies: [{ ...(policy.policyName ? { PolicyName: policy.policyName } : {}), TargetTrackingScalingPolicyConfiguration: { DisableScaleIn: policy.disableScaleIn, ScaleInCooldown: policy.scaleInCooldown, ScaleOutCooldown: policy.scaleOutCooldown, TargetValue: policy.targetValue } }] } : {}) };
}

function validateIndexDefinitions(input: any, now = Date.now()): { local: DynamoIndexState[]; global: DynamoIndexState[] } {
  const local = input.LocalSecondaryIndexes ?? []; const global = input.GlobalSecondaryIndexes ?? [];
  if (!Array.isArray(local) || local.length > 5 || !Array.isArray(global) || global.length > 20) throw new AwsError("ValidationException", "Too many secondary indexes");
  const all = [...local, ...global];
  if (new Set(all.map((index: any) => index.IndexName)).size !== all.length) throw new AwsError("ValidationException", "Duplicate index name");
  let projected = 0;
  const normalize = (index: any, isLocal: boolean): DynamoIndexState => {
    if (!index?.IndexName || !/^[A-Za-z0-9_.-]{3,255}$/.test(index.IndexName)) throw new AwsError("ValidationException", "Invalid index name");
    const hashes = index.KeySchema?.filter((key: any) => key.KeyType === "HASH") ?? []; const ranges = index.KeySchema?.filter((key: any) => key.KeyType === "RANGE") ?? [];
    if (hashes.length !== 1 || ranges.length > 1 || (isLocal && ranges.length !== 1) || index.KeySchema.length !== hashes.length + ranges.length || new Set(index.KeySchema.map((key: any) => key.AttributeName)).size !== index.KeySchema.length) throw new AwsError("ValidationException", "Invalid secondary index key schema");
    if (isLocal && hashes[0].AttributeName !== input.KeySchema.find((key: any) => key.KeyType === "HASH")?.AttributeName) throw new AwsError("ValidationException", "Local secondary index must use the table partition key");
    if (isLocal && ranges[0].AttributeName === input.KeySchema.find((key: any) => key.KeyType === "RANGE")?.AttributeName) throw new AwsError("ValidationException", "Local secondary index must use an alternate sort key");
    for (const key of index.KeySchema) if (!input.AttributeDefinitions.find((definition: any) => definition.AttributeName === key.AttributeName && ["S", "N", "B"].includes(definition.AttributeType))) throw new AwsError("ValidationException", `Invalid or missing AttributeDefinition for ${key.AttributeName}`);
    const type = index.Projection?.ProjectionType;
    if (!["KEYS_ONLY", "INCLUDE", "ALL"].includes(type)) throw new AwsError("ValidationException", "Invalid ProjectionType");
    const nonKeys = index.Projection.NonKeyAttributes ?? [];
    if (type !== "INCLUDE" && nonKeys.length) throw new AwsError("ValidationException", "NonKeyAttributes are only valid for INCLUDE projections");
    if (type === "INCLUDE" && (!nonKeys.length || nonKeys.length > 20 || new Set(nonKeys).size !== nonKeys.length)) throw new AwsError("ValidationException", "Invalid NonKeyAttributes projection");
    projected += nonKeys.length;
    const throughput = validateThroughput(index.ProvisionedThroughput, !isLocal && (input.BillingMode ?? "PROVISIONED") === "PROVISIONED");
    const onDemand = isLocal ? undefined : validateOnDemandThroughput(index.OnDemandThroughput); const warm = isLocal ? undefined : validateWarmThroughput(index.WarmThroughput, now, "CREATING");
    if (!isLocal && (input.BillingMode ?? "PROVISIONED") === "PROVISIONED" && onDemand) throw new AwsError("ValidationException", "OnDemandThroughput is only valid in PAY_PER_REQUEST capacity mode");
    if (!isLocal && (input.BillingMode ?? "PROVISIONED") === "PAY_PER_REQUEST" && index.ProvisionedThroughput !== undefined) throw new AwsError("ValidationException", "ProvisionedThroughput is not valid in PAY_PER_REQUEST capacity mode");
    return { indexName: index.IndexName, keySchema: clone(index.KeySchema), projection: clone(index.Projection), ...(throughput ? { provisionedThroughput: throughput } : {}), ...(onDemand && Object.keys(onDemand).length ? { onDemandThroughput: onDemand } : {}), ...(warm ? { warmThroughput: warm } : {}), ...(!isLocal ? { indexStatus: "CREATING" as const } : {}) };
  };
  const result = { local: local.map((index: any) => normalize(index, true)), global: global.map((index: any) => normalize(index, false)) };
  if (projected > 100) throw new AwsError("ValidationException", "Too many projected attributes across all secondary indexes");
  const used = new Set([...input.KeySchema, ...all.flatMap((index: any) => index.KeySchema)].map((key: any) => key.AttributeName));
  if (input.AttributeDefinitions.length !== used.size || input.AttributeDefinitions.some((definition: any) => !used.has(definition.AttributeName)) || new Set(input.AttributeDefinitions.map((definition: any) => definition.AttributeName)).size !== input.AttributeDefinitions.length) throw new AwsError("ValidationException", "AttributeDefinitions must exactly match attributes used in key schemas");
  return result;
}

function validateIndexAttributes(table: TableState, item: Item): void {
  for (const index of [...(table.localSecondaryIndexes ?? []), ...(table.globalSecondaryIndexes ?? [])]) for (const key of index.keySchema) {
    const value = item[key.AttributeName]; if (!value) continue;
    const expected = table.attributeDefinitions.find(definition => definition.AttributeName === key.AttributeName)?.AttributeType;
    const actual = attributeType(value);
    if (actual !== expected || !["S", "N", "B"].includes(actual) || ((actual === "S" || actual === "B") && !(value as any)[actual].length)) throw new AwsError("ValidationException", "The provided secondary index key element does not match the schema");
  }
}

function tableDescription(table: TableState, store?: StateStore): any {
  const description = (index: DynamoIndexState, local: boolean) => {
    const entries = indexItems(table, index);
    return { IndexName: index.indexName, KeySchema: index.keySchema, Projection: index.projection, IndexArn: `${table.arn}/index/${index.indexName}`, ItemCount: entries.length, IndexSizeBytes: Buffer.byteLength(JSON.stringify(entries)), ...(!local ? { IndexStatus: index.indexStatus ?? "ACTIVE", ...(index.backfilling !== undefined ? { Backfilling: index.backfilling } : {}), ProvisionedThroughput: throughputDescription(index.provisionedThroughput), ...(index.onDemandThroughput && Object.keys(index.onDemandThroughput).length ? { OnDemandThroughput: clone(index.onDemandThroughput) } : {}), ...(index.warmThroughput ? { WarmThroughput: warmThroughputDescription(index.warmThroughput) } : {}) } : {}) };
  };
  return {
    AttributeDefinitions: table.attributeDefinitions,
    TableName: table.name,
    KeySchema: table.keySchema,
    TableStatus: table.status,
    CreationDateTime: table.createdAt / 1000,
    ItemCount: Object.keys(table.items).length,
    TableSizeBytes: Buffer.byteLength(JSON.stringify(table.items)),
    TableArn: table.arn,
    TableId: table.id,
    BillingModeSummary: { BillingMode: table.billingMode, ...(table.billingModeLastUpdatedAt !== undefined ? { LastUpdateToPayPerRequestDateTime: table.billingModeLastUpdatedAt / 1000 } : {}) },
    ProvisionedThroughput: throughputDescription(table.billingMode === "PROVISIONED" ? table.provisionedThroughput : undefined),
    DeletionProtectionEnabled: table.deletionProtectionEnabled,
    TableClassSummary: { TableClass: table.tableClass, ...(table.tableClassLastUpdatedAt !== undefined ? { LastUpdateDateTime: table.tableClassLastUpdatedAt / 1000 } : {}) },
    ...(table.onDemandThroughput && Object.keys(table.onDemandThroughput).length ? { OnDemandThroughput: clone(table.onDemandThroughput) } : {}),
    WarmThroughput: table.warmThroughput
      ? warmThroughputDescription(table.warmThroughput)
      : { ReadUnitsPerSecond: 12_000, WriteUnitsPerSecond: 4_000, Status: table.status === "CREATING" ? "CREATING" : table.status === "UPDATING" ? "UPDATING" : "ACTIVE" },
    SSEDescription: { SSEType: table.sse.sseType, Status: table.sse.status, ...(table.sse.kmsMasterKeyId ? { KMSMasterKeyArn: table.sse.kmsMasterKeyId } : {}) },
    ...(table.restoreSummary ? { RestoreSummary: { RestoreDateTime: table.restoreSummary.restoreDateTime / 1000, RestoreInProgress: table.restoreSummary.restoreInProgress, ...(table.restoreSummary.sourceBackupArn ? { SourceBackupArn: table.restoreSummary.sourceBackupArn } : {}), ...(table.restoreSummary.sourceTableArn ? { SourceTableArn: table.restoreSummary.sourceTableArn } : {}) } } : {}),
    ...(table.streamSpecification ? { StreamSpecification: clone(table.streamSpecification) } : {}),
    ...(table.latestStreamArn ? { LatestStreamArn: table.latestStreamArn, LatestStreamLabel: table.latestStreamArn.split("/stream/")[1] } : {}),
    ...(table.globalTable ? {
      GlobalTableVersion: table.globalTable.version,
      Replicas: table.globalTable.replicaRegions.map(RegionName => {
        const replica = store?.regionState(RegionName).tables[table.name];
        const state = replica?.globalTable;
        return {
          RegionName,
          ReplicaStatus: state?.lastReplicationError ? "REGION_DISABLED" : state?.status ?? "REGION_DISABLED",
          ReplicaStatusPercentProgress: state?.status === "ACTIVE" ? "100" : "50",
          ...(state?.lastReplicationError ? { ReplicaStatusDescription: state.lastReplicationError } : {}),
        };
      }),
    } : {}),
    LocalSecondaryIndexes: (table.localSecondaryIndexes ?? []).map(index => description(index, true)),
    GlobalSecondaryIndexes: (table.globalSecondaryIndexes ?? []).map(index => description(index, false)),
  };
}

function requireTable(store: StateStore, region: string, name: string): TableState {
  const table = store.regionState(region).tables[name];
  if (!table) throw new AwsError("ResourceNotFoundException", `Requested resource not found: Table: ${name} not found`);
  return table;
}

function requireTableControl(store: StateStore, region: string, value: unknown): TableState {
  const raw = String(value ?? ""); const tableName = raw.match(/^arn:[^:]+:dynamodb:[^:]+:\d{12}:table\/([^/]+)$/)?.[1] ?? raw; return requireTable(store, region, tableName);
}

function assertDataPlaneAvailable(table: TableState): void {
  if (table.status === "CREATING" || table.status === "DELETING") throw new AwsError("ResourceNotFoundException", `Requested resource not found: Table: ${table.name} not found`);
}

function assertGsiQueryable(index: DynamoIndexState): void {
  const status = index.indexStatus ?? "ACTIVE";
  if (status === "CREATING" || status === "DELETING") throw new AwsError("ResourceNotFoundException", `Requested resource not found: Index: ${index.indexName} not found`);
}

interface CapacityBucket { read: number; write: number }
interface CapacityCharge {
  tableName: string;
  table: CapacityBucket;
  localIndexes: Record<string, CapacityBucket>;
  globalIndexes: Record<string, CapacityBucket>;
}

function emptyCapacity(tableName: string): CapacityCharge {
  return { tableName, table: { read: 0, write: 0 }, localIndexes: {}, globalIndexes: {} };
}

function addCapacityUnits(charge: CapacityCharge, target: "table" | { local: string } | { global: string }, read: number, write: number): void {
  const bucket = target === "table" ? charge.table : "local" in target ? (charge.localIndexes[target.local] ??= { read: 0, write: 0 }) : (charge.globalIndexes[target.global] ??= { read: 0, write: 0 });
  bucket.read += read; bucket.write += write;
}

function capacityTotals(charge: CapacityCharge): { read: number; write: number } {
  const indexRead = [...Object.values(charge.localIndexes), ...Object.values(charge.globalIndexes)].reduce((sum, bucket) => sum + bucket.read, 0);
  const indexWrite = [...Object.values(charge.localIndexes), ...Object.values(charge.globalIndexes)].reduce((sum, bucket) => sum + bucket.write, 0);
  return { read: charge.table.read + indexRead, write: charge.table.write + indexWrite };
}

function formatIndexCapacity(buckets: Record<string, CapacityBucket>): Record<string, any> | undefined {
  const entries = Object.entries(buckets); if (!entries.length) return undefined;
  return Object.fromEntries(entries.map(([name, bucket]) => [name, { CapacityUnits: bucket.read + bucket.write, ReadCapacityUnits: bucket.read, WriteCapacityUnits: bucket.write }]));
}

function formatConsumedCapacity(mode: string | undefined, charge: CapacityCharge): any | undefined {
  if (!mode || mode === "NONE") return undefined;
  const totals = capacityTotals(charge);
  const result: any = { TableName: charge.tableName, CapacityUnits: totals.read + totals.write, ReadCapacityUnits: totals.read, WriteCapacityUnits: totals.write };
  if (mode === "INDEXES") {
    result.Table = { CapacityUnits: charge.table.read + charge.table.write, ReadCapacityUnits: charge.table.read, WriteCapacityUnits: charge.table.write };
    const local = formatIndexCapacity(charge.localIndexes); if (local) result.LocalSecondaryIndexes = local;
    const global = formatIndexCapacity(charge.globalIndexes); if (global) result.GlobalSecondaryIndexes = global;
  }
  return result;
}

function consumed(tableName: string, read = 0, write = 0): any {
  const charge = emptyCapacity(tableName); addCapacityUnits(charge, "table", read, write); return formatConsumedCapacity("TOTAL", charge);
}

function expressionContext(input: any): any { return { names: input.ExpressionAttributeNames, values: input.ExpressionAttributeValues }; }

function validateExpressionRequest(input: any): void {
  validateExpressionSubstitutions(input.ExpressionAttributeNames, input.ExpressionAttributeValues);
}

function capacity(input: any, tableName: string, read = 0, write = 0, index?: { name: string; local: boolean }): any {
  const mode = input.ReturnConsumedCapacity; if (!mode || mode === "NONE") return {};
  const charge = emptyCapacity(tableName);
  if (index) addCapacityUnits(charge, index.local ? { local: index.name } : { global: index.name }, read, write);
  else addCapacityUnits(charge, "table", read, write);
  return { ConsumedCapacity: formatConsumedCapacity(mode, charge) };
}

function validateReturnItemCollectionMetrics(value: unknown): void {
  if (value !== undefined && !["NONE", "SIZE"].includes(String(value))) throw new AwsError("ValidationException", "ReturnItemCollectionMetrics must be NONE or SIZE");
}

/** Local size estimate: base-table item JSON bytes for the partition plus each projected LSI entry. Ranges are deterministic lower/upper GB bounds. */
function itemCollectionSizeEstimateRangeGB(bytes: number): [number, number] {
  const gb = bytes / (1024 ** 3);
  return [Number(gb.toFixed(12)), Number(Math.max(gb, gb + 1e-12).toFixed(12))];
}

function partitionKeyAttributes(table: TableState, item: Item): Item {
  const hash = table.keySchema.find(key => key.KeyType === "HASH")!;
  return { [hash.AttributeName]: clone(item[hash.AttributeName]) };
}

function estimateItemCollectionBytes(table: TableState, partitionKey: Item): number {
  const hashName = table.keySchema.find(key => key.KeyType === "HASH")!.AttributeName;
  const expected = partitionKey[hashName];
  let bytes = 0;
  for (const item of Object.values(table.items)) {
    if (!equalAttributeValues(item[hashName], expected)) continue;
    bytes += Buffer.byteLength(JSON.stringify(item));
    for (const index of table.localSecondaryIndexes ?? []) {
      if (!index.keySchema.every(key => item[key.AttributeName])) continue;
      bytes += Buffer.byteLength(JSON.stringify(projectedIndexItem(table, index, item)));
    }
  }
  return bytes;
}

function collectionMetricsForTable(table: TableState, items: Item[]): any[] | undefined {
  if (!table.localSecondaryIndexes?.length || !items.length) return undefined;
  const collections = new Map<string, Item>();
  for (const item of items) {
    const key = partitionKeyAttributes(table, item);
    collections.set(JSON.stringify(key), key);
  }
  return [...collections.values()].map(ItemCollectionKey => ({
    ItemCollectionKey,
    SizeEstimateRangeGB: itemCollectionSizeEstimateRangeGB(estimateItemCollectionBytes(table, ItemCollectionKey)),
  }));
}

function itemCollectionMetricsResponse(mode: unknown, entries: Array<{ table: TableState; items: Item[] }>, style: "map" | "single" = "map"): Record<string, any> {
  if (mode !== "SIZE") return {};
  const metrics: Record<string, any[]> = {};
  for (const { table, items } of entries) {
    const collection = collectionMetricsForTable(table, items);
    if (!collection?.length) continue;
    const existing = metrics[table.name] ?? [];
    const seen = new Set(existing.map(entry => JSON.stringify(entry.ItemCollectionKey)));
    for (const entry of collection) {
      const key = JSON.stringify(entry.ItemCollectionKey);
      if (seen.has(key)) continue;
      seen.add(key); existing.push(entry);
    }
    metrics[table.name] = existing;
  }
  if (!Object.keys(metrics).length) return {};
  if (style === "single") {
    const first = Object.values(metrics)[0]?.[0];
    return first ? { ItemCollectionMetrics: first } : {};
  }
  return { ItemCollectionMetrics: metrics };
}

function sameIndexKey(index: DynamoIndexState, left: Item, right: Item): boolean {
  return index.keySchema.every(key => equalAttributeValues(left[key.AttributeName], right[key.AttributeName]));
}

function indexWriteUnits(index: DynamoIndexState, previous: Item | undefined, next: Item | undefined, writeUnits: (item: Item | undefined) => number): number {
  if (!previous || !next) return writeUnits(previous ?? next);
  if (sameIndexKey(index, previous, next)) return Math.max(writeUnits(previous), writeUnits(next));
  return writeUnits(previous) + writeUnits(next);
}

function writeIndexCapacity(charge: CapacityCharge, table: TableState, oldItem: Item | undefined, newItem: Item | undefined, writeUnits: (item: Item | undefined) => number): void {
  for (const index of table.localSecondaryIndexes ?? []) {
    const previous = oldItem && index.keySchema.every(key => oldItem[key.AttributeName]) ? projectedIndexItem(table, index, oldItem) : undefined;
    const next = newItem && index.keySchema.every(key => newItem[key.AttributeName]) ? projectedIndexItem(table, index, newItem) : undefined;
    if (!previous && !next) continue;
    if (previous && next && canonicalJson(previous) === canonicalJson(next)) continue;
    addCapacityUnits(charge, { local: index.indexName }, 0, indexWriteUnits(index, previous, next, writeUnits));
  }
  for (const index of table.globalSecondaryIndexes ?? []) {
    const previous = oldItem && index.keySchema.every(key => oldItem[key.AttributeName]) ? projectedIndexItem(table, index, oldItem) : undefined;
    const next = newItem && index.keySchema.every(key => newItem[key.AttributeName]) ? projectedIndexItem(table, index, newItem) : undefined;
    if (!previous && !next) continue;
    if (previous && next && canonicalJson(previous) === canonicalJson(next)) continue;
    addCapacityUnits(charge, { global: index.indexName }, 0, indexWriteUnits(index, previous, next, writeUnits));
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function policyList<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }

function normalizeDynamoResourcePolicy(document: any): string {
  const sorted = (value: any): any => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sorted(item)])) : value;
  const ordered = (value: any, keys: string[]): any => { const result: any = {}; for (const key of keys) if (value[key] !== undefined) result[key] = sorted(value[key]); for (const key of Object.keys(value).filter(key => !keys.includes(key)).sort()) result[key] = sorted(value[key]); return result; };
  const statements = policyList<any>(document.Statement).map(statement => ordered(statement, ["Sid", "Effect", "Principal", "NotPrincipal", "Action", "NotAction", "Resource", "NotResource", "Condition"]));
  const normalized: any = {}; if (document.Version !== undefined) normalized.Version = document.Version; if (document.Id !== undefined) normalized.Id = document.Id; normalized.Statement = statements; for (const key of Object.keys(document).filter(key => !["Version", "Id", "Statement"].includes(key)).sort()) normalized[key] = sorted(document[key]); return JSON.stringify(normalized);
}

function validateDynamoResourcePolicy(input: unknown): { document: PolicyDocument; normalized: string } {
  if (typeof input !== "string" || input.length === 0) throw new AwsError("ValidationException", "Policy must be a non-empty JSON string");
  if (Buffer.byteLength(input) > 20 * 1024) throw new AwsError("LimitExceededException", "Resource policy exceeds the maximum size of 20 KB");
  let document: any; try { document = JSON.parse(input); } catch { throw new AwsError("ValidationException", "Policy contains invalid JSON"); }
  if (!document || typeof document !== "object" || Array.isArray(document) || !document.Statement || document.Version && !["2008-10-17", "2012-10-17"].includes(document.Version)) throw new AwsError("ValidationException", "Policy must contain a valid Version and Statement");
  const statements = policyList<PolicyStatement>(document.Statement); if (!statements.length) throw new AwsError("ValidationException", "Policy must contain at least one statement");
  const stringValues = (value: unknown, label: string): string[] => { const result = policyList<any>(value); if (!result.length || result.some(item => typeof item !== "string" || !item.length)) throw new AwsError("ValidationException", `${label} must contain non-empty strings`); return result; };
  const principals = (value: unknown, label: string): void => { if (typeof value === "string") { stringValues(value, label); return; } if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) throw new AwsError("ValidationException", `${label} must be a string or principal map`); for (const entries of Object.values(value)) stringValues(entries, label); };
  const supportedResource = (value: string): boolean => value === "*" || /^arn:(?:aws|aws-us-gov|aws-cn):dynamodb:[a-z0-9-*?]+:(?:\d{12}|\*):table\/[^/]+(?:\/(?:index|stream)\/[^/]+)?$/.test(value);
  for (const statement of statements) {
    if (!statement || typeof statement !== "object" || !["Allow", "Deny"].includes(statement.Effect) || (statement.Action === undefined) === (statement.NotAction === undefined) || (statement.Resource === undefined) === (statement.NotResource === undefined) || (statement.Principal === undefined) === (statement.NotPrincipal === undefined)) throw new AwsError("ValidationException", "Each policy statement needs Effect and exactly one of Action/NotAction, Resource/NotResource, and Principal/NotPrincipal");
    for (const action of stringValues(statement.Action ?? statement.NotAction, "Action")) if (!/^dynamodb:[A-Za-z*?]+$/i.test(action)) throw new AwsError("ValidationException", `Unsupported DynamoDB resource-policy action: ${action}`);
    for (const resource of stringValues(statement.Resource ?? statement.NotResource, "Resource")) if (!supportedResource(resource)) throw new AwsError("ValidationException", `Unsupported DynamoDB resource ARN: ${resource}`);
    principals(statement.Principal ?? statement.NotPrincipal, "Principal");
    if (statement.Condition !== undefined && (!statement.Condition || typeof statement.Condition !== "object" || Array.isArray(statement.Condition))) throw new AwsError("ValidationException", "Condition must be an object");
  }
  return { document: structuredClone(document) as PolicyDocument, normalized: normalizeDynamoResourcePolicy(document) };
}

export interface DynamoTtlSchedule { sweepEveryMs: number; transitionMs: number; updateCooldownMs: number }
const DEFAULT_TTL_SCHEDULE: DynamoTtlSchedule = { sweepEveryMs: 1_000, transitionMs: 50, updateCooldownMs: 60 * 60_000 };
const DEFAULT_STREAM_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_RESOURCE_POLICY_MUTATION_COOLDOWN_MS = 15_000;
const STREAM_ITERATOR_TTL_MS = 15 * 60_000;
const STREAM_VIEWS = new Set<DynamoStreamViewType>(["KEYS_ONLY", "NEW_IMAGE", "OLD_IMAGE", "NEW_AND_OLD_IMAGES"]);
const CONTRIBUTOR_TABLE_KEY = "__TABLE__";
const CONTRIBUTOR_METRIC_NAMESPACE = "StackSim/DynamoDBContributorInsights";

interface DynamoStreamChange { oldImage?: Item; newImage?: Item; ttl?: boolean }
interface DynamoGlobalReplicationChange extends DynamoPitrChange { ttl?: boolean }

function streamSequence(value: number | bigint): string { return String(value).padStart(21, "0"); }
function streamSequenceValue(value: string): bigint { try { return BigInt(value); } catch { throw new AwsError("ValidationException", "SequenceNumber must be a valid decimal value"); } }

export class DynamoDbService {
  private readonly transactionLocks = new Map<string, Promise<void>>();
  private readonly capacityBuckets = new Map<string, { tokens: number; at: number; rate: number }>();
  private readonly ttlSchedule: DynamoTtlSchedule;
  private partiqlTokens: PaginationTokens;
  private readonly backupPersistence: DynamoBackupPersistence;
  private readonly streamPersistence: DynamoStreamPersistence;
  private readonly globalTablePersistence: DynamoGlobalTablePersistence;
  private readonly integrationAttemptStore: DynamoIntegrationAttemptStore;
  private readonly streamRetentionMs: number;
  private readonly resourcePolicyMutationCooldownMs: number;
  private streamReady: Promise<void> = Promise.resolve();
  private readonly transitionHandles = new Set<ReturnType<Clock["setTimeout"]>>();
  private readonly transitionSaves = new Set<Promise<void>>();
  private started = false;
  constructor(private readonly store: StateStore, private readonly region: string, private readonly clock: Clock = new SystemClock(), private readonly telemetry?: TelemetryBus, private readonly scheduler?: Scheduler, ttlSchedule: Partial<DynamoTtlSchedule> = {}, private readonly enforceCapacity = false, streamRetentionMs = DEFAULT_STREAM_RETENTION_MS, resourcePolicyMutationCooldownMs = DEFAULT_RESOURCE_POLICY_MUTATION_COOLDOWN_MS, private readonly allowLocalFiles = false) { this.ttlSchedule = { ...DEFAULT_TTL_SCHEDULE, ...ttlSchedule }; if (Object.values(this.ttlSchedule).some(value => !Number.isFinite(value) || value <= 0)) throw new Error("Invalid DynamoDB TTL schedule"); if (!Number.isFinite(streamRetentionMs) || streamRetentionMs <= 0) throw new Error("Invalid DynamoDB stream retention"); if (!Number.isFinite(resourcePolicyMutationCooldownMs) || resourcePolicyMutationCooldownMs < 0) throw new Error("Invalid DynamoDB resource-policy mutation cooldown"); this.streamRetentionMs = streamRetentionMs; this.resourcePolicyMutationCooldownMs = resourcePolicyMutationCooldownMs; this.partiqlTokens = new PaginationTokens(this.store.state.installation.paginationSecret); this.backupPersistence = new DynamoBackupPersistence(this.store.root, this.store.accountId, this.region); this.streamPersistence = new DynamoStreamPersistence(this.store.root, this.store.accountId, this.region); this.globalTablePersistence = new DynamoGlobalTablePersistence(this.store.root, this.store.accountId); this.integrationAttemptStore = new DynamoIntegrationAttemptStore(this.store.root, this.store.accountId, this.region); }

  private itemReadUnits(item: Item | undefined, consistent = false, transactional = false): number { const blocks = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(item ?? {})) / 4096)); return blocks * (transactional ? 2 : consistent ? 1 : 0.5); }
  private itemWriteUnits(item: Item | undefined, transactional = false): number { const blocks = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(item ?? {})) / 1024)); return blocks * (transactional ? 2 : 1); }
  private takeCapacity(table: TableState, kind: "read" | "write", units: number, suffix = "table", contributors: Item[] = []): void {
    if (!this.enforceCapacity || units <= 0) return; const index = suffix === "table" ? undefined : table.globalSecondaryIndexes?.find(candidate => candidate.indexName === suffix); const provisioned = kind === "read" ? index?.provisionedThroughput?.ReadCapacityUnits ?? table.provisionedThroughput?.ReadCapacityUnits : index?.provisionedThroughput?.WriteCapacityUnits ?? table.provisionedThroughput?.WriteCapacityUnits; const onDemand = kind === "read" ? index?.onDemandThroughput?.MaxReadRequestUnits ?? table.onDemandThroughput?.MaxReadRequestUnits : index?.onDemandThroughput?.MaxWriteRequestUnits ?? table.onDemandThroughput?.MaxWriteRequestUnits; const rate = table.billingMode === "PROVISIONED" ? provisioned : onDemand; if (rate === undefined || rate <= 0) return;
    const key = `${table.name}\0${suffix}\0${kind}`; const now = this.clock.now(); let bucket = this.capacityBuckets.get(key); if (!bucket || bucket.rate !== rate) bucket = { tokens: rate, at: now, rate }; else { bucket.tokens = Math.min(rate, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * rate); bucket.at = now; }
    if (bucket.tokens + Number.EPSILON < units) { this.capacityBuckets.set(key, bucket); void this.publishContributorMetrics(table, contributors, "ThrottleFrequency", index?.indexName, true); const scope = index ? "Index" : "Table"; const operation = kind === "read" ? "Read" : "Write"; throw new AwsError("ProvisionedThroughputExceededException", "The level of configured provisioned throughput for the table was exceeded. Consider increasing your provisioning level.", 400, { ThrottlingReasons: [{ reason: `${scope}${operation}ProvisionedThroughputExceeded`, resource: index ? `${table.arn}/index/${index.indexName}` : table.arn }] }); }
    bucket.tokens -= units; this.capacityBuckets.set(key, bucket);
  }

  private takeCapacityCharge(table: TableState, kind: "read" | "write", charge: CapacityCharge, contributors: Item[] = []): void {
    const localUnits = Object.values(charge.localIndexes).reduce((sum, bucket) => sum + bucket[kind], 0);
    const requests = [
      { suffix: "table", units: charge.table[kind] + localUnits },
      ...Object.entries(charge.globalIndexes).map(([suffix, bucket]) => ({ suffix, units: bucket[kind] })),
    ];
    const snapshots = new Map(requests.map(({ suffix }) => { const key = `${table.name}\0${suffix}\0${kind}`; const bucket = this.capacityBuckets.get(key); return [key, bucket ? { ...bucket } : undefined] as const; }));
    try {
      for (const request of requests) this.takeCapacity(table, kind, request.units, request.suffix, contributors);
    } catch (error) {
      for (const [key, bucket] of snapshots) { if (bucket) this.capacityBuckets.set(key, bucket); else this.capacityBuckets.delete(key); }
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.started) return; this.started = true;
    await this.integrationAttemptStore.start();
    let sanitized = false;
    for (const [attemptId, value] of Object.entries(this.integrationAttempts)) {
      if (!Object.hasOwn(value, "output")) continue;
      const receipt = value as ServiceIntegrationAttemptState; this.integrationAttemptStore.put(receipt);
      this.integrationAttempts[attemptId] = this.integrationMetadata(receipt); sanitized = true;
    }
    this.integrationAttemptStore.prune(new Set(Object.keys(this.integrationAttempts)));
    if (sanitized) await this.store.save();
    this.partiqlTokens = new PaginationTokens(this.store.state.installation.paginationSecret);
    const ready = this.importLegacyStreamRecords(); this.streamReady = ready; this.transitionSaves.add(ready); void ready.finally(() => this.transitionSaves.delete(ready)).catch(() => undefined);
    for (const backup of Object.values(this.backups)) if (backup.backupStatus === "CREATING") this.scheduleTransition(() => { const current = this.backups[backup.backupArn]; if (current) current.backupStatus = "AVAILABLE"; });
    for (const job of Object.values(this.exports)) if (job.exportStatus === "IN_PROGRESS") this.scheduleTransition(() => { const current = this.exports[job.exportArn]; if (current) { current.exportStatus = "COMPLETED"; current.endTime = this.clock.now(); } });
    for (const job of Object.values(this.imports)) if (job.importStatus === "IN_PROGRESS") this.scheduleTransition(() => { const current = this.imports[job.importArn]; if (current) { current.importStatus = "COMPLETED"; current.endTime = this.clock.now(); const table = this.tables[current.tableCreationParameters.TableName as string]; if (table) { table.status = "ACTIVE"; for (const index of table.globalSecondaryIndexes ?? []) { index.indexStatus = "ACTIVE"; index.backfilling = false; } } } });
    for (const table of Object.values(this.tables)) for (const insight of Object.values(table.contributorInsights)) if (insight.status === "ENABLING" || insight.status === "DISABLING") this.scheduleTransition(() => { insight.status = insight.status === "ENABLING" ? "ENABLED" : "DISABLED"; insight.lastUpdatedAt = this.clock.now(); });
    for (const table of Object.values(this.tables)) for (const destination of Object.values(table.kinesisStreamingDestinations)) if (destination.status === "ENABLING" || destination.status === "DISABLING" || destination.status === "UPDATING") this.scheduleTransition(() => { destination.status = destination.status === "DISABLING" ? "DISABLED" : "ACTIVE"; destination.lastUpdatedAt = this.clock.now(); destination.statusDescription = this.kinesisDestinationDescription(destination.status); });
    for (const table of Object.values(this.tables)) if (table.restoreSummary?.restoreInProgress) this.transition(table, () => { if (table.restoreSummary) table.restoreSummary.restoreInProgress = false; for (const index of table.globalSecondaryIndexes ?? []) { index.indexStatus = "ACTIVE"; index.backfilling = false; } });
    for (const table of Object.values(this.tables)) {
      if (table.status !== "CREATING" || table.restoreSummary?.restoreInProgress) continue;
      if (Object.values(this.imports).some(job => job.tableArn === table.arn && job.importStatus === "IN_PROGRESS")) continue;
      this.scheduleTableActivation(table);
    }
    for (const table of Object.values(this.tables)) { const pending = Object.values(this.streams).filter(stream => stream.tableName === table.name && (stream.streamStatus === "ENABLING" || stream.streamStatus === "DISABLING")); if (pending.length) this.transition(table, () => { for (const stream of pending) stream.streamStatus = stream.streamStatus === "ENABLING" ? "ENABLED" : "DISABLED"; }); }
    if (!this.scheduler) return; const schedule = () => this.scheduler!.schedule(async () => { await this.sweepTtlNow(); schedule(); }, this.ttlSchedule.sweepEveryMs); schedule();
  }

  async stop(): Promise<void> { for (const handle of this.transitionHandles) this.clock.clearTimeout(handle); this.transitionHandles.clear(); this.started = false; await Promise.allSettled(this.transitionSaves); await this.integrationAttemptStore.stop(); }

  private scheduleTransition(callback: () => void, delayMs = 50): void {
    const handle = this.clock.setTimeout(() => { this.transitionHandles.delete(handle); callback(); const saving = this.store.save(); this.transitionSaves.add(saving); void saving.finally(() => this.transitionSaves.delete(saving)); }, delayMs); this.transitionHandles.add(handle);
  }

  private transition(table: TableState, callback: () => void): void {
    this.scheduleTransition(() => { callback(); table.status = "ACTIVE"; });
  }

  private scheduleTableActivation(table: TableState): void {
    this.scheduleTransition(() => {
      if (table.status !== "CREATING" || table.restoreSummary?.restoreInProgress) return;
      if (Object.values(this.imports).some(job => job.tableArn === table.arn && job.importStatus === "IN_PROGRESS")) return;
      table.status = "ACTIVE";
      if (table.warmThroughput) table.warmThroughput.status = "ACTIVE";
      for (const index of table.globalSecondaryIndexes ?? []) {
        if ((index.indexStatus ?? "ACTIVE") !== "CREATING") continue;
        index.indexStatus = "ACTIVE";
        if (index.warmThroughput) index.warmThroughput.status = "ACTIVE";
      }
    });
  }

  private get tables(): Record<string, TableState> { return this.store.regionState(this.region).tables; }
  private get backups(): Record<string, DynamoBackupState> { return this.store.regionState(this.region).dynamodbBackups; }
  private get exports(): Record<string, DynamoExportState> { return this.store.regionState(this.region).dynamodbExports; }
  private get imports(): Record<string, DynamoImportState> { return this.store.regionState(this.region).dynamodbImports; }
  private get streams(): Record<string, DynamoStreamDescriptorState> { return this.store.regionState(this.region).dynamodbStreams; }
  private get resourcePolicies(): Record<string, DynamoResourcePolicyState> { return this.store.regionState(this.region).dynamodbResourcePolicies; }
  private get resourcePolicyMutationTimes(): Record<string, number> { return this.store.regionState(this.region).dynamodbResourcePolicyMutationTimes; }
  private get integrationAttempts(): Record<string, ServiceIntegrationAttemptMetadataState | ServiceIntegrationAttemptState> { return this.store.regionState(this.region).dynamodbIntegrationAttempts; }
  private integrationMetadata(receipt: ServiceIntegrationAttemptState): ServiceIntegrationAttemptMetadataState { const { output, ...metadata } = receipt; return { ...metadata, outputDigest: integrationOutputDigest(output) }; }
  reconcileIntegrationAttempt(attempt: ServiceIntegrationAttempt): ServiceIntegrationAttemptState | undefined { const metadata = this.integrationAttempts[attempt.attemptId]; if (!metadata) return undefined; assertMatchingIntegrationAttempt(metadata, attempt); const receipt = this.integrationAttemptStore.get(attempt.attemptId); if (!receipt || integrationOutputDigest(receipt.output) !== (metadata as ServiceIntegrationAttemptMetadataState).outputDigest) throw new Error(`DynamoDB integration receipt ${attempt.attemptId} is incomplete or corrupt`); assertMatchingIntegrationAttempt(receipt, attempt); return structuredClone(receipt); }
  async releaseIntegrationAttempt(attemptId: string): Promise<void> { if (!this.integrationAttempts[attemptId]) { this.integrationAttemptStore.delete(attemptId); return; } delete this.integrationAttempts[attemptId]; await this.store.save(); this.integrationAttemptStore.delete(attemptId); }
  private acceptIntegrationAttempt(attempt: ServiceIntegrationAttempt, output: unknown): void { const receipt = acceptedIntegrationAttempt(attempt, output, this.clock.now()); this.integrationAttemptStore.put(receipt); this.integrationAttempts[attempt.attemptId] = this.integrationMetadata(receipt); }
  private pitrTime(): number { return Math.floor(this.clock.now() / 1000) * 1000; }
  private async journalChanges(table: TableState, changes: DynamoPitrChange[]): Promise<void> { await this.backupPersistence.appendPitr(table, this.pitrTime(), changes); await this.backupPersistence.prunePitr(table, this.pitrTime()); }

  private compareGlobalVersions(left: DynamoGlobalTableItemVersionState, right: DynamoGlobalTableItemVersionState | undefined): number {
    if (!right) return 1;
    if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt;
    const region = left.regionName.localeCompare(right.regionName); if (region) return region;
    return left.sourceSequence - right.sourceSequence;
  }

  private globalReplicaEntries(table: TableState): Array<[string, TableState]> {
    const regions = table.globalTable?.replicaRegions ?? [];
    return regions.flatMap(region => { const replica = this.store.regionState(region).tables[table.name]; return replica ? [[region, replica] as [string, TableState]] : []; });
  }

  private async replicateGlobalChanges(table: TableState, changes: DynamoGlobalReplicationChange[]): Promise<void> {
    const membership = table.globalTable; if (!membership || changes.length === 0) return;
    const updatedAt = this.clock.now();
    const prepared = changes.map(change => {
      const version: DynamoGlobalTableItemVersionState = { updatedAt, regionName: this.region, sourceSequence: ++membership.sourceSequence, ...(!change.item ? { deleted: true } : {}) };
      membership.itemVersions[change.key] = version;
      return { change, version };
    });
    for (const { change, version } of prepared) {
      const replicas = this.globalReplicaEntries(table); const ordinal = Math.max(0, ...replicas.map(([, replica]) => replica.globalTable?.changeSequence ?? 0)) + 1;
      for (const [, replica] of replicas) if (replica.globalTable) replica.globalTable.changeSequence = ordinal;
      const logEntry: DynamoGlobalTableChangeState = { ordinal, tableName: table.name, sourceRegion: this.region, sourceSequence: version.sourceSequence, updatedAt: version.updatedAt, key: change.key, ...(change.item ? { item: clone(change.item) } : {}) };
      await this.globalTablePersistence.append(table.name, logEntry);
      for (const [region, replica] of replicas) {
        if (region === this.region || !replica.globalTable || this.compareGlobalVersions(version, replica.globalTable.itemVersions[change.key]) <= 0) continue;
        try {
          const regional = this.store.regionState(region); const attached = regional.dynamodbResourcePolicies[replica.arn];
          if (attached) { const action = change.item ? "dynamodb:PutItem" : "dynamodb:DeleteItem"; const serviceRole = `arn:aws:iam::${this.store.accountId}:role/aws-service-role/replication.dynamodb.amazonaws.com/AWSServiceRoleForDynamoDBReplication`; const resourceAuthorization = evaluateResourcePolicy(JSON.parse(attached.policy), { principalArn: serviceRole, roleArn: serviceRole }, action, replica.arn, { "aws:PrincipalArn": serviceRole, "aws:PrincipalAccount": this.store.accountId, "aws:RequestedRegion": region }); const decision = combineIdentityAndResourceAuthorization({ decision: "allowed", reason: "The DynamoDB replication service-linked role authorizes replication", matchedStatements: [] }, resourceAuthorization, "sameAccount"); if (decision.decision !== "allowed") { replica.globalTable.lastReplicationError = "Replication is not authorized by the target table resource policy"; continue; } }
          const previous = replica.items[change.key]; if (change.item) replica.items[change.key] = clone(change.item); else delete replica.items[change.key]; replica.globalTable.itemVersions[change.key] = clone(version); delete replica.globalTable.lastReplicationError;
          const persistence = new DynamoBackupPersistence(this.store.root, this.store.accountId, region); await persistence.appendPitr(replica, this.pitrTime(), [{ key: change.key, ...(change.item ? { item: change.item } : {}) }]); await persistence.prunePitr(replica, this.pitrTime());
          if (change.item || previous) await this.emitStreamRecordForRegion(region, replica, { oldImage: previous, ...(change.item ? { newImage: change.item } : {}), ...(change.ttl ? { ttl: true } : {}) });
        } catch (error) { replica.globalTable.lastReplicationError = error instanceof Error ? error.message : String(error); }
      }
    }
  }

  private ttlTable(value: unknown): TableState { const raw = String(value ?? ""); const arnName = raw.match(/^arn:[^:]+:dynamodb:[^:]+:\d{12}:table\/([^/]+)$/)?.[1]; return requireTable(this.store, this.region, arnName ?? raw); }

  async DescribeTimeToLive(input: any): Promise<any> { const ttl = this.ttlTable(input.TableName).timeToLive; return { TimeToLiveDescription: { ...(ttl.attributeName ? { AttributeName: ttl.attributeName } : {}), TimeToLiveStatus: ttl.status } }; }

  async UpdateTimeToLive(input: any): Promise<any> {
    const table = this.ttlTable(input.TableName); const specification = input.TimeToLiveSpecification;
    if (!specification || typeof specification.Enabled !== "boolean") throw new AwsError("ValidationException", "TimeToLiveSpecification with Enabled and AttributeName is required"); const attributeName = String(specification.AttributeName ?? ""); if (!attributeName || attributeName.length > 255 || /[\x00-\x1f]/.test(attributeName)) throw new AwsError("ValidationException", "TimeToLiveSpecification.AttributeName must contain between 1 and 255 valid characters");
    this.advanceTtlStatus(table); const ttl = table.timeToLive; if (ttl.status === "ENABLING" || ttl.status === "DISABLING") throw new AwsError("ValidationException", "Time to live is being modified for this table"); if (ttl.lastUpdatedAt !== undefined && this.clock.now() - ttl.lastUpdatedAt < this.ttlSchedule.updateCooldownMs) throw new AwsError("ValidationException", "Time to live has been modified multiple times within a fixed interval");
    if (specification.Enabled) { if (ttl.status === "ENABLED") throw new AwsError("ValidationException", "Time to live is already enabled"); ttl.attributeName = attributeName; ttl.status = "ENABLING"; }
    else { if (ttl.status === "DISABLED") throw new AwsError("ValidationException", "Time to live is already disabled"); if (ttl.attributeName !== attributeName) throw new AwsError("ValidationException", "The TTL attribute name must match the currently configured attribute"); ttl.status = "DISABLING"; }
    ttl.lastUpdatedAt = this.clock.now(); await this.store.save(); return { TimeToLiveSpecification: { Enabled: Boolean(specification.Enabled), AttributeName: attributeName } };
  }

  private advanceTtlStatus(table: TableState): boolean { const ttl = table.timeToLive; if (ttl.lastUpdatedAt === undefined || this.clock.now() - ttl.lastUpdatedAt < this.ttlSchedule.transitionMs) return false; if (ttl.status === "ENABLING") { ttl.status = "ENABLED"; return true; } if (ttl.status === "DISABLING") { ttl.status = "DISABLED"; delete ttl.attributeName; return true; } return false; }

  async sweepTtlNow(): Promise<number> {
    let changed = false; let removed = 0; const removedByTable = new Map<string, number>(); const journal = new Map<TableState, DynamoPitrChange[]>(); const nowSeconds = this.clock.now() / 1000; const oldestEligible = nowSeconds - 5 * 365 * 24 * 60 * 60;
    for (const table of Object.values(this.tables).sort((left, right) => left.name.localeCompare(right.name))) {
      changed = this.advanceTtlStatus(table) || changed; const ttl = table.timeToLive; if (!new Set(["ENABLED", "DISABLING"]).has(ttl.status) || !ttl.attributeName) continue;
      for (const [key, item] of Object.entries(table.items).sort(([left], [right]) => left.localeCompare(right))) { const value = item[ttl.attributeName]; if (!value || !("N" in value)) continue; const expiresAt = Number(value.N); if (!Number.isFinite(expiresAt) || expiresAt > nowSeconds || expiresAt < oldestEligible) continue; delete table.items[key]; (journal.get(table) ?? (journal.set(table, []), journal.get(table)!)).push({ key }); await this.emitStreamRecord(table, { oldImage: item, ttl: true }); removed++; removedByTable.set(table.name, (removedByTable.get(table.name) ?? 0) + 1); changed = true; }
    }
    for (const [table, changes] of journal) { await this.journalChanges(table, changes); await this.replicateGlobalChanges(table, changes.map(change => ({ ...change, ttl: true }))); }
    if (changed) await this.store.save();
    if (this.telemetry) for (const [tableName, value] of removedByTable) await this.telemetry.publish({ namespace: "AWS/DynamoDB", metricName: "TimeToLiveDeletedItemCount", dimensions: { TableName: tableName }, value, unit: "Count", timestamp: this.clock.now() }).catch(() => undefined);
    return removed;
  }

  private validateStreamSpecification(value: any): { StreamEnabled: boolean; StreamViewType?: DynamoStreamViewType } {
    if (!value || typeof value.StreamEnabled !== "boolean") throw new AwsError("ValidationException", "StreamSpecification.StreamEnabled must be a boolean");
    if (value.StreamEnabled && !STREAM_VIEWS.has(value.StreamViewType)) throw new AwsError("ValidationException", "StreamViewType is required when streams are enabled and must be KEYS_ONLY, NEW_IMAGE, OLD_IMAGE, or NEW_AND_OLD_IMAGES");
    if (!value.StreamEnabled && value.StreamViewType !== undefined) throw new AwsError("ValidationException", "StreamViewType cannot be specified when streams are disabled");
    return { StreamEnabled: value.StreamEnabled, ...(value.StreamViewType ? { StreamViewType: value.StreamViewType } : {}) };
  }

  private createStreamDescriptor(table: TableState, view: DynamoStreamViewType, status: "ENABLING" | "ENABLED"): DynamoStreamDescriptorState {
    let createdAt = this.clock.now(); let label = new Date(createdAt).toISOString().replace(/Z$/, ""); let arn = `${table.arn}/stream/${label}`;
    while (this.streams[arn]) { createdAt++; label = new Date(createdAt).toISOString().replace(/Z$/, ""); arn = `${table.arn}/stream/${label}`; }
    const shardHash = createHash("sha256").update(arn).digest("hex").slice(0, 8);
    const descriptor: DynamoStreamDescriptorState = { streamArn: arn, streamLabel: label, tableName: table.name, tableArn: table.arn, keySchema: clone(table.keySchema), streamViewType: view, streamStatus: status, createdAt, shardId: `shardId-${String(Math.floor(createdAt / 1000)).padStart(20, "0")}-${shardHash}`, startingSequenceNumber: streamSequence((table.streamSequence ?? 0) + 1) };
    this.streams[arn] = descriptor; table.streamSpecification = { StreamEnabled: true, StreamViewType: view }; table.latestStreamArn = arn; return descriptor;
  }

  private retireStream(table: TableState, status: "DISABLING" | "DISABLED" = "DISABLING"): DynamoStreamDescriptorState | undefined {
    const descriptor = table.latestStreamArn ? this.streams[table.latestStreamArn] : undefined; if (!descriptor) return undefined;
    descriptor.streamStatus = status; descriptor.disabledAt = this.clock.now(); descriptor.endingSequenceNumber = descriptor.lastSequenceNumber ?? descriptor.startingSequenceNumber; return descriptor;
  }

  private configureStream(table: TableState, value: any, status: "ENABLING" | "ENABLED" = "ENABLING"): { enabled?: DynamoStreamDescriptorState; retired?: DynamoStreamDescriptorState } {
    const specification = this.validateStreamSpecification(value); const currentEnabled = table.streamSpecification?.StreamEnabled === true;
    if (specification.StreamEnabled && currentEnabled && specification.StreamViewType === table.streamSpecification?.StreamViewType) throw new AwsError("ValidationException", "The requested stream configuration is already active");
    if (!specification.StreamEnabled && !currentEnabled) throw new AwsError("ValidationException", "DynamoDB Streams is already disabled");
    const retired = currentEnabled ? this.retireStream(table, status === "ENABLED" ? "DISABLED" : "DISABLING") : undefined;
    if (!specification.StreamEnabled) { table.streamSpecification = { StreamEnabled: false }; delete table.latestStreamArn; return { retired }; }
    return { retired, enabled: this.createStreamDescriptor(table, specification.StreamViewType!, status) };
  }

  private async importLegacyStreamRecords(): Promise<void> {
    let changed = false; for (const descriptor of Object.values(this.streams)) if (descriptor.legacyRecords) { await this.streamPersistence.replace(descriptor, descriptor.legacyRecords); delete descriptor.legacyRecords; changed = true; } if (changed) await this.store.save();
  }

  private async pruneStreams(): Promise<boolean> {
    await this.streamReady; const cutoff = this.clock.now() - this.streamRetentionMs; let changed = false;
    for (const [arn, descriptor] of Object.entries(this.streams)) {
      if (descriptor.disabledAt !== undefined && descriptor.disabledAt <= cutoff) { await this.streamPersistence.clear(descriptor); delete this.streams[arn]; delete this.resourcePolicies[arn]; delete this.resourcePolicyMutationTimes[arn]; changed = true; continue; }
      changed = await this.streamPersistence.prune(descriptor, cutoff) || changed;
    }
    return changed;
  }

  private async emitStreamRecord(table: TableState, change: DynamoStreamChange): Promise<void> {
    await this.emitStreamRecordForRegion(this.region, table, change);
  }

  private async emitStreamRecordForRegion(region: string, table: TableState, change: DynamoStreamChange): Promise<void> {
    if (region === this.region) await this.streamReady;
    const regionState = this.store.regionState(region); if (!table.streamSpecification?.StreamEnabled || !table.latestStreamArn) return; const descriptor = regionState.dynamodbStreams[table.latestStreamArn]; if (!descriptor || !["ENABLING", "ENABLED"].includes(descriptor.streamStatus)) return;
    const oldImage = change.oldImage; const newImage = change.newImage; if (!oldImage && !newImage) return;
    const eventName = !oldImage ? "INSERT" : !newImage ? "REMOVE" : "MODIFY"; const source = newImage ?? oldImage!; const view = descriptor.streamViewType; const keys = keyFromItem(table, source); const sequence = streamSequence(table.streamSequence = (table.streamSequence ?? 0) + 1);
    const dynamodb: DynamoStreamRecordState["dynamodb"] = { ApproximateCreationDateTime: Math.floor(this.clock.now() / 1000), Keys: clone(keys), ...(["OLD_IMAGE", "NEW_AND_OLD_IMAGES"].includes(view) && oldImage ? { OldImage: clone(oldImage) } : {}), ...(["NEW_IMAGE", "NEW_AND_OLD_IMAGES"].includes(view) && newImage ? { NewImage: clone(newImage) } : {}), SequenceNumber: sequence, SizeBytes: 0, StreamViewType: view };
    dynamodb.SizeBytes = Buffer.byteLength(JSON.stringify({ Keys: dynamodb.Keys, OldImage: dynamodb.OldImage, NewImage: dynamodb.NewImage }));
    const record: DynamoStreamRecordState = { eventID: id(32), eventName, eventVersion: "1.1", eventSource: "aws:dynamodb", awsRegion: region, eventSourceARN: descriptor.streamArn, dynamodb, ...(change.ttl ? { userIdentity: { type: "Service", principalId: "dynamodb.amazonaws.com" } } : {}) };
    const persistence = region === this.region ? this.streamPersistence : new DynamoStreamPersistence(this.store.root, this.store.accountId, region);
    await persistence.appendAndPrune(descriptor, record, this.clock.now() - this.streamRetentionMs); descriptor.lastSequenceNumber = sequence;
  }

  private requireStream(arn: unknown): DynamoStreamDescriptorState { const descriptor = this.streams[String(arn ?? "")]; if (!descriptor) throw new AwsError("ResourceNotFoundException", "Requested resource not found"); return descriptor; }

  async ListStreams(input: any): Promise<any> {
    const changed = await this.pruneStreams(); if (input.TableName !== undefined && (typeof input.TableName !== "string" || !/^[A-Za-z0-9_.-]{3,255}$/.test(input.TableName))) throw new AwsError("ValidationException", "TableName must be a valid name between 3 and 255 characters"); if (input.TableName && !this.tables[input.TableName]) throw new AwsError("ResourceNotFoundException", "Requested resource not found"); if (input.Limit !== undefined && (!Number.isInteger(input.Limit) || input.Limit < 1 || input.Limit > 100)) throw new AwsError("ValidationException", "Limit must be between 1 and 100");
    let descriptors = Object.values(this.streams).filter(stream => !input.TableName || stream.tableName === input.TableName).sort((left, right) => right.createdAt - left.createdAt || left.streamArn.localeCompare(right.streamArn));
    if (input.ExclusiveStartStreamArn) { const index = descriptors.findIndex(stream => stream.streamArn === input.ExclusiveStartStreamArn); if (index < 0) throw new AwsError("ValidationException", "ExclusiveStartStreamArn was not found in the result set"); descriptors = descriptors.slice(index + 1); }
    const limit = input.Limit ?? 100; const page = descriptors.slice(0, limit); if (changed) await this.store.save(); return { Streams: page.map(stream => ({ StreamArn: stream.streamArn, TableName: stream.tableName, StreamLabel: stream.streamLabel })), ...(descriptors.length > limit ? { LastEvaluatedStreamArn: page.at(-1)!.streamArn } : {}) };
  }

  async DescribeStream(input: any): Promise<any> {
    const changed = await this.pruneStreams(); if (typeof input.StreamArn !== "string" || !input.StreamArn) throw new AwsError("ValidationException", "StreamArn is required"); const stream = this.requireStream(input.StreamArn); if (input.Limit !== undefined && (!Number.isInteger(input.Limit) || input.Limit < 1 || input.Limit > 100)) throw new AwsError("ValidationException", "Limit must be between 1 and 100"); if (input.ShardFilter !== undefined) throw new AwsError("ValidationException", "ShardFilter is not supported by the local deterministic single-shard model");
    let shards = [{ ShardId: stream.shardId, SequenceNumberRange: { StartingSequenceNumber: stream.startingSequenceNumber, ...(stream.endingSequenceNumber ? { EndingSequenceNumber: stream.endingSequenceNumber } : {}) } }]; if (input.ExclusiveStartShardId) { if (input.ExclusiveStartShardId !== stream.shardId) throw new AwsError("ValidationException", "ExclusiveStartShardId does not belong to this stream"); shards = []; }
    if (changed) await this.store.save(); return { StreamDescription: { StreamArn: stream.streamArn, StreamLabel: stream.streamLabel, StreamStatus: stream.streamStatus, StreamViewType: stream.streamViewType, CreationRequestDateTime: stream.createdAt / 1000, TableName: stream.tableName, KeySchema: clone(stream.keySchema), Shards: shards } };
  }

  private encodeShardIterator(stream: DynamoStreamDescriptorState, nextSequenceNumber: string): string { return this.partiqlTokens.encode("DynamoDBStreams.GetRecords", { streamArn: stream.streamArn, shardId: stream.shardId, nextSequenceNumber, expiresAt: this.clock.now() + STREAM_ITERATOR_TTL_MS }); }

  async GetShardIterator(input: any): Promise<any> {
    const changed = await this.pruneStreams(); if (typeof input.StreamArn !== "string" || !input.StreamArn || typeof input.ShardId !== "string" || !input.ShardId || typeof input.ShardIteratorType !== "string") throw new AwsError("ValidationException", "StreamArn, ShardId, and ShardIteratorType are required"); const stream = this.requireStream(input.StreamArn); if (input.ShardId !== stream.shardId) throw new AwsError("ResourceNotFoundException", "The shard does not exist"); const type = input.ShardIteratorType; if (!new Set(["TRIM_HORIZON", "LATEST", "AT_SEQUENCE_NUMBER", "AFTER_SEQUENCE_NUMBER"]).has(type)) throw new AwsError("ValidationException", "Invalid ShardIteratorType");
    const usesSequence = type === "AT_SEQUENCE_NUMBER" || type === "AFTER_SEQUENCE_NUMBER"; if (usesSequence !== (input.SequenceNumber !== undefined)) throw new AwsError("ValidationException", usesSequence ? "SequenceNumber is required for this iterator type" : "SequenceNumber is only valid for AT_SEQUENCE_NUMBER or AFTER_SEQUENCE_NUMBER");
    let next: bigint; if (type === "TRIM_HORIZON") { const records = await this.streamPersistence.read(stream); next = records.length ? streamSequenceValue(records[0].dynamodb.SequenceNumber) : stream.trimmedThroughSequence ? streamSequenceValue(stream.trimmedThroughSequence) + 1n : streamSequenceValue(stream.startingSequenceNumber); } else if (type === "LATEST") next = stream.lastSequenceNumber ? streamSequenceValue(stream.lastSequenceNumber) + 1n : streamSequenceValue(stream.startingSequenceNumber); else { next = streamSequenceValue(String(input.SequenceNumber)); if (stream.trimmedThroughSequence && next <= streamSequenceValue(stream.trimmedThroughSequence)) throw new AwsError("TrimmedDataAccessException", "The data you are trying to access has been trimmed"); if (type === "AFTER_SEQUENCE_NUMBER") next++; }
    if (changed) await this.store.save(); return { ShardIterator: this.encodeShardIterator(stream, streamSequence(next)) };
  }

  async GetRecords(input: any): Promise<any> {
    if (input.Limit !== undefined && (!Number.isInteger(input.Limit) || input.Limit < 1 || input.Limit > 1000)) throw new AwsError("LimitExceededException", "GetRecords Limit must be between 1 and 1000"); let cursor: { streamArn: string; shardId: string; nextSequenceNumber: string; expiresAt: number };
    try { cursor = this.partiqlTokens.decode("DynamoDBStreams.GetRecords", String(input.ShardIterator ?? "")); } catch { throw new AwsError("ValidationException", "Invalid ShardIterator"); }
    if (!cursor || typeof cursor.streamArn !== "string" || typeof cursor.shardId !== "string" || typeof cursor.nextSequenceNumber !== "string" || !Number.isFinite(cursor.expiresAt)) throw new AwsError("ValidationException", "Invalid ShardIterator"); if (cursor.expiresAt <= this.clock.now()) throw new AwsError("ExpiredIteratorException", "The provided iterator exceeds the maximum age allowed");
    const changed = await this.pruneStreams(); const stream = this.requireStream(cursor.streamArn); if (cursor.shardId !== stream.shardId) throw new AwsError("ResourceNotFoundException", "The shard does not exist"); const next = streamSequenceValue(cursor.nextSequenceNumber); if (stream.trimmedThroughSequence && next <= streamSequenceValue(stream.trimmedThroughSequence)) throw new AwsError("TrimmedDataAccessException", "The data you are trying to access has been trimmed");
    const limit = input.Limit ?? 1000; const records: DynamoStreamRecordState[] = []; let bytes = 0; for (const record of await this.streamPersistence.read(stream)) { if (streamSequenceValue(record.dynamodb.SequenceNumber) < next) continue; const size = Buffer.byteLength(JSON.stringify(record)); if (records.length >= limit || (records.length > 0 && bytes + size > 1024 * 1024)) break; records.push(clone(record)); bytes += size; }
    const following = records.length ? streamSequenceValue(records.at(-1)!.dynamodb.SequenceNumber) + 1n : next; const ending = stream.endingSequenceNumber ? streamSequenceValue(stream.endingSequenceNumber) : undefined; const closed = stream.streamStatus === "DISABLED" && ending !== undefined && (following > ending || (records.length === 0 && next >= ending)); if (changed) await this.store.save(); return { Records: records, ...(!closed ? { NextShardIterator: this.encodeShardIterator(stream, streamSequence(following)) } : {}) };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now(); let operation = ""; let input: any = {};
    try {
      operation = String(req.headers["x-amz-target"] ?? "").split(".").pop() ?? "";
      input = await readJson(req);
      if (!operation || typeof (this as any)[operation] !== "function") throw new AwsError("UnknownOperationException", `Unknown operation: ${operation}`);
      const output = await (this as any)[operation](input, (req as any).awsPrincipal);
      await this.publishRequestMetrics(operation, input, performance.now() - started).catch(() => undefined);
      json(res, output, 200, "application/x-amz-json-1.0");
    } catch (error) { if (this.telemetry && operation) { const metricName = error instanceof AwsError && error.status < 500 ? error.code === "ConditionalCheckFailedException" ? "ConditionalCheckFailedRequests" : "UserErrors" : "SystemErrors"; await this.telemetry.publish({ namespace: "AWS/DynamoDB", metricName, dimensions: {}, value: 1, unit: "Count", timestamp: this.clock.now() }).catch(() => undefined); } sendAwsError(res, error); }
  }

  private async publishRequestMetrics(operation: string, input: any, latency: number): Promise<void> {
    if (!this.telemetry || !new Set(["PutItem", "GetItem", "UpdateItem", "DeleteItem", "Scan", "Query", "BatchGetItem", "BatchWriteItem", "TransactGetItems", "TransactWriteItems"]).has(operation)) return;
    const at = this.clock.now(); await this.telemetry.publish({ namespace: "AWS/DynamoDB", metricName: "SuccessfulRequestLatency", dimensions: { Operation: operation }, value: latency, unit: "Milliseconds", timestamp: at });
    if (!input.TableName) return; const read = new Set(["GetItem", "Scan", "Query"]).has(operation); const write = new Set(["PutItem", "UpdateItem", "DeleteItem"]).has(operation); if (!read && !write) return;
    const table = requireTable(this.store, this.region, String(input.TableName)); const index = input.IndexName ? table.globalSecondaryIndexes?.find(candidate => candidate.indexName === input.IndexName) : undefined;
    const publishScope = async (dimensions: Record<string, string>, provisioned: DynamoProvisionedThroughputState | undefined, metricName: "ConsumedReadCapacityUnits" | "ConsumedWriteCapacityUnits") => {
      await this.telemetry!.publish({ namespace: "AWS/DynamoDB", metricName, dimensions, value: 1, unit: "Count", timestamp: at });
      if (table.billingMode === "PROVISIONED" && provisioned) await Promise.all([
        this.telemetry!.publish({ namespace: "AWS/DynamoDB", metricName: "ProvisionedReadCapacityUnits", dimensions, value: provisioned.ReadCapacityUnits, unit: "Count", timestamp: at }),
        this.telemetry!.publish({ namespace: "AWS/DynamoDB", metricName: "ProvisionedWriteCapacityUnits", dimensions, value: provisioned.WriteCapacityUnits, unit: "Count", timestamp: at }),
      ]);
    };
    const dimensions = { TableName: table.name, ...(index ? { GlobalSecondaryIndexName: index.indexName } : {}) };
    await publishScope(dimensions, index?.provisionedThroughput ?? table.provisionedThroughput, read ? "ConsumedReadCapacityUnits" : "ConsumedWriteCapacityUnits");
    if (write) await Promise.all((table.globalSecondaryIndexes ?? []).map(globalIndex => publishScope({ TableName: table.name, GlobalSecondaryIndexName: globalIndex.indexName }, globalIndex.provisionedThroughput, "ConsumedWriteCapacityUnits")));
  }

  async CreateTable(input: any): Promise<any> {
    if (!input.TableName || !Array.isArray(input.KeySchema) || !Array.isArray(input.AttributeDefinitions)) throw new AwsError("ValidationException", "TableName, KeySchema and AttributeDefinitions are required");
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(input.TableName)) throw new AwsError("ValidationException", "TableName must be between 3 and 255 characters and contain only letters, numbers, underscores, hyphens, and periods");
    const hashes = input.KeySchema.filter((key: any) => key.KeyType === "HASH"); const ranges = input.KeySchema.filter((key: any) => key.KeyType === "RANGE");
    if (hashes.length !== 1 || ranges.length > 1 || input.KeySchema.length > 2) throw new AwsError("ValidationException", "Invalid KeySchema: exactly one HASH key and at most one RANGE key are required");
    if (new Set(input.KeySchema.map((key: any) => key.AttributeName)).size !== input.KeySchema.length) throw new AwsError("ValidationException", "Key schema contains duplicate attributes");
    for (const key of input.KeySchema) {
      const definition = input.AttributeDefinitions.find((entry: any) => entry.AttributeName === key.AttributeName);
      if (!definition || !["S", "N", "B"].includes(definition.AttributeType)) throw new AwsError("ValidationException", `Invalid or missing AttributeDefinition for ${key.AttributeName}`);
    }
    if (![undefined, "PROVISIONED", "PAY_PER_REQUEST"].includes(input.BillingMode)) throw new AwsError("ValidationException", "Invalid BillingMode");
    const now = this.clock.now(); const billingMode = input.BillingMode ?? "PROVISIONED";
    if (billingMode === "PAY_PER_REQUEST" && input.ProvisionedThroughput !== undefined) throw new AwsError("ValidationException", "ProvisionedThroughput is not valid in PAY_PER_REQUEST capacity mode");
    if (billingMode === "PROVISIONED" && input.OnDemandThroughput !== undefined) throw new AwsError("ValidationException", "OnDemandThroughput is only valid in PAY_PER_REQUEST capacity mode");
    if (input.DeletionProtectionEnabled !== undefined && typeof input.DeletionProtectionEnabled !== "boolean") throw new AwsError("ValidationException", "DeletionProtectionEnabled must be a boolean");
    if (input.TableClass !== undefined && !["STANDARD", "STANDARD_INFREQUENT_ACCESS"].includes(input.TableClass)) throw new AwsError("ValidationException", "Invalid TableClass");
    const streamSpecification = input.StreamSpecification === undefined ? undefined : this.validateStreamSpecification(input.StreamSpecification);
    const indexes = validateIndexDefinitions(input, now);
    const throughput = validateThroughput(input.ProvisionedThroughput, (input.BillingMode ?? "PROVISIONED") === "PROVISIONED");
    const onDemandThroughput = validateOnDemandThroughput(input.OnDemandThroughput); const warmThroughput = validateWarmThroughput(input.WarmThroughput, now, "CREATING"); const tags = validateTags(input.Tags); const sse = validateSse(input.SSESpecification, now);
    if (this.tables[input.TableName]) throw new AwsError("ResourceInUseException", `Table already exists: ${input.TableName}`);
    const resourcePolicy = input.ResourcePolicy === undefined ? undefined : validateDynamoResourcePolicy(input.ResourcePolicy);
    const table: TableState = {
      name: input.TableName, id: id(32), status: "CREATING", createdAt: this.clock.now(),
      arn: `arn:aws:dynamodb:${this.region}:${this.store.accountId}:table/${input.TableName}`,
      keySchema: clone(input.KeySchema), attributeDefinitions: clone(input.AttributeDefinitions),
      billingMode, ...(throughput ? { provisionedThroughput: throughput } : {}), ...(onDemandThroughput && Object.keys(onDemandThroughput).length ? { onDemandThroughput } : {}), ...(warmThroughput ? { warmThroughput } : {}),
      tableClass: input.TableClass ?? "STANDARD", deletionProtectionEnabled: input.DeletionProtectionEnabled ?? false, tags, sse,
      localSecondaryIndexes: indexes.local, globalSecondaryIndexes: indexes.global, timeToLive: { status: "DISABLED" }, pointInTimeRecovery: { status: "DISABLED", recoveryPeriodInDays: 35, sequence: 0 }, contributorInsights: {}, kinesisStreamingDestinations: {}, items: {},
    };
    if (streamSpecification?.StreamEnabled) this.createStreamDescriptor(table, streamSpecification.StreamViewType!, "ENABLED"); else if (streamSpecification) table.streamSpecification = streamSpecification;
    this.tables[table.name] = table;
    if (resourcePolicy) { this.resourcePolicies[table.arn] = { resourceArn: table.arn, policy: resourcePolicy.normalized, revisionId: id(32), updatedAt: now }; this.resourcePolicyMutationTimes[table.arn] = now; }
    await this.store.save();
    this.scheduleTableActivation(table);
    return { TableDescription: tableDescription(table, this.store) };
  }

  async DescribeLimits(): Promise<any> { return { AccountMaxReadCapacityUnits: 80_000, AccountMaxWriteCapacityUnits: 80_000, TableMaxReadCapacityUnits: 40_000, TableMaxWriteCapacityUnits: 40_000 }; }
  async DescribeEndpoints(): Promise<any> { return { Endpoints: [{ Address: `127.0.0.1`, CachePeriodInMinutes: 60 }] }; }

  private resourceTable(value: unknown): TableState {
    const arn = String(value ?? ""); const table = Object.values(this.tables).find(candidate => candidate.arn === arn); if (!table) throw new AwsError("ResourceNotFoundException", `Requested resource not found: ${arn}`); return table;
  }

  async TagResource(input: any): Promise<any> {
    const table = this.resourceTable(input.ResourceArn); table.tags = validateTags(input.Tags, table.tags); await this.store.save(); return {};
  }

  async UntagResource(input: any): Promise<any> {
    const table = this.resourceTable(input.ResourceArn); if (!Array.isArray(input.TagKeys) || input.TagKeys.length < 1 || input.TagKeys.length > 50 || new Set(input.TagKeys).size !== input.TagKeys.length || input.TagKeys.some((key: unknown) => typeof key !== "string" || key.length < 1 || key.length > 128 || /^aws:/i.test(key))) throw new AwsError("ValidationException", "TagKeys must contain between 1 and 50 unique valid tag keys"); for (const key of input.TagKeys) delete table.tags[key]; await this.store.save(); return {};
  }

  async ListTagsOfResource(input: any): Promise<any> {
    if (input.NextToken !== undefined) throw new AwsError("ValidationException", "Invalid NextToken"); const table = this.resourceTable(input.ResourceArn); return { Tags: Object.entries(table.tags).sort(([left], [right]) => left.localeCompare(right)).map(([Key, Value]) => ({ Key, Value })) };
  }

  private async policyResource(value: unknown): Promise<string> {
    const changed = await this.pruneStreams(); const arn = String(value ?? "");
    const table = Object.values(this.tables).find(candidate => candidate.arn === arn); const stream = this.streams[arn];
    if (changed) await this.store.save();
    if (!table && !stream) throw new AwsError("ResourceNotFoundException", `Requested resource not found: ${arn}`);
    return arn;
  }

  private validateExpectedRevision(policy: DynamoResourcePolicyState | undefined, expected: unknown, allowNoPolicy = false): void {
    if (expected === undefined) return;
    if (typeof expected !== "string" || !expected.length) throw new AwsError("ValidationException", "ExpectedRevisionId must be a non-empty string");
    const mismatched = allowNoPolicy && expected === "NO_POLICY"
      ? Boolean(policy)
      : !policy || policy.revisionId !== expected;
    if (mismatched) throw new AwsError("PolicyNotFoundException", "The resource policy was not found or its revision ID did not match");
  }

  private assertPolicyMutationAvailable(resourceArn: string): void {
    const last = this.resourcePolicyMutationTimes[resourceArn];
    if (last !== undefined && this.clock.now() - last < this.resourcePolicyMutationCooldownMs) throw new AwsError("ResourceInUseException", "A resource policy on this resource was updated less than 15 seconds ago");
  }

  async PutResourcePolicy(input: any, principal?: PrincipalContext): Promise<any> {
    if (input.ConfirmRemoveSelfResourceAccess !== undefined && typeof input.ConfirmRemoveSelfResourceAccess !== "boolean") throw new AwsError("ValidationException", "ConfirmRemoveSelfResourceAccess must be a boolean");
    const resourceArn = await this.policyResource(input.ResourceArn); const current = this.resourcePolicies[resourceArn]; this.validateExpectedRevision(current, input.ExpectedRevisionId, true);
    const policy = validateDynamoResourcePolicy(input.Policy); if (current?.policy === policy.normalized) return { RevisionId: current.revisionId };
    this.assertPolicyMutationAvailable(resourceArn);
    const principalArn = principal?.principalArn ?? `arn:aws:iam::${this.store.accountId}:root`; const self = evaluateResourcePolicy(policy.document, principalArn, "dynamodb:PutResourcePolicy", resourceArn, { "aws:PrincipalArn": principalArn, "aws:PrincipalAccount": principal?.accountId ?? this.store.accountId, "aws:RequestedRegion": this.region, "aws:CurrentTime": new Date(this.clock.now()).toISOString() });
    const crossAccountRemoval = principal?.accountId !== undefined && principal.accountId !== this.store.accountId && self.decision !== "allowed";
    if ((self.decision === "explicitDeny" || crossAccountRemoval) && input.ConfirmRemoveSelfResourceAccess !== true) throw new AwsError("ValidationException", "ConfirmRemoveSelfResourceAccess must be true because this policy removes the caller's future access to update the policy");
    const revisionId = id(32); this.resourcePolicies[resourceArn] = { resourceArn, policy: policy.normalized, revisionId, updatedAt: this.clock.now() }; this.resourcePolicyMutationTimes[resourceArn] = this.clock.now(); await this.store.save(); return { RevisionId: revisionId };
  }

  async GetResourcePolicy(input: any): Promise<any> {
    const resourceArn = await this.policyResource(input.ResourceArn); const policy = this.resourcePolicies[resourceArn]; if (!policy) throw new AwsError("PolicyNotFoundException", "The operation tried to access a nonexistent resource-based policy"); return { Policy: policy.policy, RevisionId: policy.revisionId };
  }

  async DeleteResourcePolicy(input: any): Promise<any> {
    const resourceArn = await this.policyResource(input.ResourceArn); const policy = this.resourcePolicies[resourceArn]; this.validateExpectedRevision(policy, input.ExpectedRevisionId); if (!policy) return { RevisionId: "" };
    this.assertPolicyMutationAvailable(resourceArn); delete this.resourcePolicies[resourceArn]; this.resourcePolicyMutationTimes[resourceArn] = this.clock.now(); await this.store.save(); return { RevisionId: policy.revisionId };
  }

  private validateRegionName(value: unknown): string {
    const region = String(value ?? ""); if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) throw new AwsError("ValidationException", "RegionName must be a valid AWS Region identifier"); return region;
  }

  private findGlobalTable(name: unknown): TableState | undefined {
    const tableName = String(name ?? "");
    for (const region of this.store.listRegions()) { const table = this.store.regionState(region).tables[tableName]; if (table?.globalTable) return table; }
    return undefined;
  }

  private requireGlobalTable(name: unknown): TableState {
    const table = this.findGlobalTable(name); if (!table) throw new AwsError("GlobalTableNotFoundException", "The specified global table does not exist"); return table;
  }

  private globalTableArn(name: string): string { return `arn:aws:dynamodb::${this.store.accountId}:global-table/${name}`; }

  private globalReplicaDefinition(table: TableState): string {
    const indexes = (values: DynamoIndexState[] | undefined) => (values ?? []).map(index => ({ name: index.indexName, key: index.keySchema, projection: index.projection, write: index.provisionedThroughput?.WriteCapacityUnits })).sort((left, right) => left.name.localeCompare(right.name));
    return canonicalJson({ name: table.name, key: table.keySchema, attributes: table.attributeDefinitions, billingMode: table.billingMode, write: table.provisionedThroughput?.WriteCapacityUnits, local: indexes(table.localSecondaryIndexes), global: indexes(table.globalSecondaryIndexes) });
  }

  private assertLegacyReplica(source: TableState, target: TableState, requireEmpty: boolean): void {
    if (this.globalReplicaDefinition(source) !== this.globalReplicaDefinition(target)) throw new AwsError("ValidationException", "Replica tables must have matching names, key schemas, indexes, billing mode, and write capacity");
    if (!source.streamSpecification?.StreamEnabled || source.streamSpecification.StreamViewType !== "NEW_AND_OLD_IMAGES" || !target.streamSpecification?.StreamEnabled || target.streamSpecification.StreamViewType !== "NEW_AND_OLD_IMAGES") throw new AwsError("ValidationException", "Legacy global table replicas require DynamoDB Streams with NEW_AND_OLD_IMAGES");
    if (requireEmpty && Object.keys(target.items).length) throw new AwsError("ValidationException", "A replica table added to a legacy global table must be empty");
  }

  private createStreamDescriptorForRegion(table: TableState, region: string, view: DynamoStreamViewType): void {
    const state = this.store.regionState(region); let createdAt = this.clock.now(); let label = new Date(createdAt).toISOString().replace(/Z$/, ""); let arn = `${table.arn}/stream/${label}`;
    while (state.dynamodbStreams[arn]) { createdAt++; label = new Date(createdAt).toISOString().replace(/Z$/, ""); arn = `${table.arn}/stream/${label}`; }
    const shardHash = createHash("sha256").update(arn).digest("hex").slice(0, 8); state.dynamodbStreams[arn] = { streamArn: arn, streamLabel: label, tableName: table.name, tableArn: table.arn, keySchema: clone(table.keySchema), streamViewType: view, streamStatus: "ENABLED", createdAt, shardId: `shardId-${String(Math.floor(createdAt / 1000)).padStart(20, "0")}-${shardHash}`, startingSequenceNumber: streamSequence(1) };
    table.streamSpecification = { StreamEnabled: true, StreamViewType: view }; table.latestStreamArn = arn; table.streamSequence = 0;
  }

  private cloneReplicaTable(source: TableState, region: string): TableState {
    const replica = clone(source); replica.id = id(32); replica.arn = `arn:aws:dynamodb:${region}:${this.store.accountId}:table/${source.name}`; replica.createdAt = this.clock.now(); replica.status = "ACTIVE"; replica.tags = {}; replica.restoreSummary = undefined; replica.latestStreamArn = undefined; replica.streamSequence = 0; replica.globalTable = undefined; replica.contributorInsights = {}; replica.kinesisStreamingDestinations = {};
    if (replica.streamSpecification?.StreamEnabled && replica.streamSpecification.StreamViewType) this.createStreamDescriptorForRegion(replica, region, replica.streamSpecification.StreamViewType);
    return replica;
  }

  private installGlobalMembership(source: TableState, replicas: Array<[string, TableState]>, version: "2017.11.29" | "2019.11.21"): void {
    const now = this.clock.now(); const regions = replicas.map(([region]) => region).sort(); let sourceSequence = source.globalTable?.sourceSequence ?? 0; const itemVersions = clone(source.globalTable?.itemVersions ?? {});
    for (const key of Object.keys(source.items).sort()) if (!itemVersions[key]) itemVersions[key] = { updatedAt: now, regionName: this.region, sourceSequence: ++sourceSequence };
    const base = { version, createdAt: source.globalTable?.createdAt ?? now, status: "ACTIVE" as const, replicaRegions: regions, changeSequence: source.globalTable?.changeSequence ?? 0, sourceSequence, itemVersions };
    for (const [, replica] of replicas) { replica.items = clone(source.items); replica.globalTable = clone(base); }
  }

  private globalTableDescription(table: TableState): any {
    const membership = table.globalTable!;
    const ReplicationGroup = membership.replicaRegions.map(region => {
      const replica = this.store.regionState(region).tables[table.name]; const state = replica?.globalTable; const indexes = replica?.globalSecondaryIndexes ?? [];
      return { RegionName: region, ReplicaArn: replica?.arn ?? `arn:aws:dynamodb:${region}:${this.store.accountId}:table/${table.name}`, ReplicaStatus: state?.lastReplicationError ? "REGION_DISABLED" : state?.status ?? "REGION_DISABLED", ReplicaStatusPercentProgress: state?.status === "ACTIVE" ? "100" : "50", ...(state?.lastReplicationError ? { ReplicaStatusDescription: state.lastReplicationError } : {}), ...(indexes.length ? { GlobalSecondaryIndexes: indexes.map(index => ({ IndexName: index.indexName })) } : {}), ...(replica?.sse.kmsMasterKeyId ? { KMSMasterKeyId: replica.sse.kmsMasterKeyId } : {}) };
    });
    return { CreationDateTime: membership.createdAt / 1000, GlobalTableArn: this.globalTableArn(table.name), GlobalTableName: table.name, GlobalTableStatus: ReplicationGroup.every((replica: any) => replica.ReplicaStatus === "ACTIVE") ? "ACTIVE" : "UPDATING", ReplicationGroup };
  }

  private globalReplicaSettings(table: TableState): any[] {
    return table.globalTable!.replicaRegions.map(region => {
      const replica = this.store.regionState(region).tables[table.name]; if (!replica) return { RegionName: region, ReplicaStatus: "REGION_DISABLED" };
      const auto = replica.autoScaling ?? {}; const regionAuto = auto.replicas?.[region];
      return { RegionName: region, ReplicaBillingModeSummary: { BillingMode: replica.billingMode, ...(replica.billingModeLastUpdatedAt !== undefined ? { LastUpdateToPayPerRequestDateTime: replica.billingModeLastUpdatedAt / 1000 } : {}) }, ReplicaProvisionedReadCapacityUnits: replica.provisionedThroughput?.ReadCapacityUnits ?? 0, ReplicaProvisionedWriteCapacityUnits: replica.provisionedThroughput?.WriteCapacityUnits ?? 0, ...(regionAuto?.provisionedRead ? { ReplicaProvisionedReadCapacityAutoScalingSettings: autoScalingDescription(regionAuto.provisionedRead) } : {}), ...(auto.provisionedWrite ? { ReplicaProvisionedWriteCapacityAutoScalingSettings: autoScalingDescription(auto.provisionedWrite) } : {}), ReplicaStatus: replica.globalTable?.lastReplicationError ? "REGION_DISABLED" : replica.globalTable?.status ?? "REGION_DISABLED", ReplicaTableClassSummary: { TableClass: replica.tableClass, ...(replica.tableClassLastUpdatedAt !== undefined ? { LastUpdateDateTime: replica.tableClassLastUpdatedAt / 1000 } : {}) }, ReplicaGlobalSecondaryIndexSettings: (replica.globalSecondaryIndexes ?? []).map(index => ({ IndexName: index.indexName, IndexStatus: index.indexStatus ?? "ACTIVE", ProvisionedReadCapacityUnits: index.provisionedThroughput?.ReadCapacityUnits ?? 0, ProvisionedWriteCapacityUnits: index.provisionedThroughput?.WriteCapacityUnits ?? 0, ...(regionAuto?.globalSecondaryIndexes?.[index.indexName]?.provisionedRead ? { ProvisionedReadCapacityAutoScalingSettings: autoScalingDescription(regionAuto.globalSecondaryIndexes[index.indexName].provisionedRead) } : {}), ...(auto.globalSecondaryIndexes?.[index.indexName]?.provisionedWrite ? { ProvisionedWriteCapacityAutoScalingSettings: autoScalingDescription(auto.globalSecondaryIndexes[index.indexName].provisionedWrite) } : {}) })) };
    });
  }

  async CreateGlobalTable(input: any): Promise<any> {
    const name = String(input.GlobalTableName ?? ""); if (!/^[A-Za-z0-9_.-]{3,255}$/.test(name)) throw new AwsError("ValidationException", "GlobalTableName must be a valid table name");
    if (!Array.isArray(input.ReplicationGroup) || input.ReplicationGroup.length < 2) throw new AwsError("ValidationException", "ReplicationGroup must contain at least two Regions");
    const regions: string[] = input.ReplicationGroup.map((entry: any) => this.validateRegionName(entry?.RegionName)); if (new Set(regions).size !== regions.length) throw new AwsError("ValidationException", "ReplicationGroup must contain unique Regions"); if (!regions.includes(this.region)) throw new AwsError("ValidationException", "ReplicationGroup must include the request Region"); if (this.findGlobalTable(name)) throw new AwsError("GlobalTableAlreadyExistsException", "The specified global table already exists");
    const replicas = regions.map(region => { const table = this.store.regionState(region).tables[name]; if (!table) throw new AwsError("TableNotFoundException", `A source table named ${name} does not exist in ${region}`); return [region, table] as [string, TableState]; }); const source = replicas.find(([region]) => region === this.region)![1];
    for (const [, replica] of replicas) { if (replica.globalTable) throw new AwsError("ResourceInUseException", "A replica is already part of a global table"); this.assertLegacyReplica(source, replica, true); }
    this.installGlobalMembership(source, replicas, "2017.11.29"); await this.store.save(); return { GlobalTableDescription: this.globalTableDescription(source) };
  }

  async DescribeGlobalTable(input: any): Promise<any> { return { GlobalTableDescription: this.globalTableDescription(this.requireGlobalTable(input.GlobalTableName)) }; }

  async ListGlobalTables(input: any): Promise<any> {
    const region = input.RegionName === undefined ? this.region : this.validateRegionName(input.RegionName); if (input.Limit !== undefined && (!Number.isInteger(input.Limit) || input.Limit < 1 || input.Limit > 100)) throw new AwsError("ValidationException", "Limit must be between 1 and 100");
    let tables = Object.values(this.store.regionState(region).tables).filter(table => table.globalTable).sort((left, right) => left.name.localeCompare(right.name)); if (input.ExclusiveStartGlobalTableName !== undefined) { const index = tables.findIndex(table => table.name === input.ExclusiveStartGlobalTableName); if (index < 0) throw new AwsError("ValidationException", "ExclusiveStartGlobalTableName is invalid"); tables = tables.slice(index + 1); }
    const limit = input.Limit ?? 100; const page = tables.slice(0, limit); return { GlobalTables: page.map(table => ({ GlobalTableName: table.name, ReplicationGroup: table.globalTable!.replicaRegions.map(RegionName => ({ RegionName })) })), ...(tables.length > page.length && page.length ? { LastEvaluatedGlobalTableName: page.at(-1)!.name } : {}) };
  }

  private removeGlobalReplica(table: TableState, region: string): void {
    const membership = table.globalTable!; if (!membership.replicaRegions.includes(region)) throw new AwsError("ReplicaNotFoundException", "The specified replica is no longer part of the global table"); if (region === this.region) throw new AwsError("ValidationException", "Remove a replica from a different remaining Region");
    const targetState = this.store.regionState(region); const target = targetState.tables[table.name]; if (target?.deletionProtectionEnabled) throw new AwsError("ValidationException", "Replica deletion protection is enabled");
    if (target?.latestStreamArn && targetState.dynamodbStreams[target.latestStreamArn]) { targetState.dynamodbStreams[target.latestStreamArn].streamStatus = "DISABLED"; targetState.dynamodbStreams[target.latestStreamArn].disabledAt = this.clock.now(); }
    if (target) { delete targetState.dynamodbResourcePolicies[target.arn]; delete targetState.dynamodbResourcePolicyMutationTimes[target.arn]; delete targetState.tables[target.name]; }
    const remaining = membership.replicaRegions.filter(candidate => candidate !== region); for (const candidate of remaining) { const replica = this.store.regionState(candidate).tables[table.name]; if (!replica) continue; if (remaining.length === 1) delete replica.globalTable; else if (replica.globalTable) replica.globalTable.replicaRegions = [...remaining]; }
  }

  async UpdateGlobalTable(input: any): Promise<any> {
    const table = this.requireGlobalTable(input.GlobalTableName); if (!Array.isArray(input.ReplicaUpdates) || !input.ReplicaUpdates.length) throw new AwsError("ValidationException", "ReplicaUpdates must not be empty");
    for (const update of input.ReplicaUpdates) {
      const kinds = ["Create", "Delete"].filter(kind => update?.[kind]); if (kinds.length !== 1 || Object.keys(update).length !== 1) throw new AwsError("ValidationException", "Each replica update must contain exactly one Create or Delete action"); const region = this.validateRegionName(update[kinds[0]].RegionName);
      if (kinds[0] === "Delete") { this.removeGlobalReplica(table, region); continue; }
      if (table.globalTable!.replicaRegions.includes(region)) throw new AwsError("ReplicaAlreadyExistsException", "The specified replica is already part of the global table"); const target = this.store.regionState(region).tables[table.name]; if (!target) throw new AwsError("TableNotFoundException", `A source table named ${table.name} does not exist in ${region}`); this.assertLegacyReplica(table, target, true); const entries = [...this.globalReplicaEntries(table), [region, target] as [string, TableState]]; this.installGlobalMembership(table, entries, table.globalTable!.version);
    }
    await this.store.save(); const current = this.findGlobalTable(input.GlobalTableName); return { GlobalTableDescription: current ? this.globalTableDescription(current) : { GlobalTableName: String(input.GlobalTableName), GlobalTableStatus: "DELETING", ReplicationGroup: [] } };
  }

  async DescribeGlobalTableSettings(input: any): Promise<any> { const table = this.requireGlobalTable(input.GlobalTableName); return { GlobalTableName: table.name, ReplicaSettings: this.globalReplicaSettings(table) }; }

  async UpdateGlobalTableSettings(input: any): Promise<any> {
    const table = this.requireGlobalTable(input.GlobalTableName); const replicas = this.globalReplicaEntries(table); const now = this.clock.now();
    if (input.GlobalTableBillingMode !== undefined && !["PROVISIONED", "PAY_PER_REQUEST"].includes(input.GlobalTableBillingMode)) throw new AwsError("ValidationException", "Invalid GlobalTableBillingMode");
    if (input.GlobalTableProvisionedWriteCapacityUnits !== undefined && (!Number.isInteger(input.GlobalTableProvisionedWriteCapacityUnits) || input.GlobalTableProvisionedWriteCapacityUnits < 1)) throw new AwsError("ValidationException", "GlobalTableProvisionedWriteCapacityUnits must be a positive integer");
    for (const [, replica] of replicas) {
      if (input.GlobalTableBillingMode !== undefined) { replica.billingMode = input.GlobalTableBillingMode; replica.billingModeLastUpdatedAt = now; if (replica.billingMode === "PAY_PER_REQUEST") delete replica.provisionedThroughput; else replica.provisionedThroughput ??= { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }; }
      if (input.GlobalTableProvisionedWriteCapacityUnits !== undefined) { if (replica.billingMode !== "PROVISIONED") throw new AwsError("ValidationException", "Provisioned write capacity requires PROVISIONED billing mode"); replica.provisionedThroughput = { ...(replica.provisionedThroughput ?? { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }), WriteCapacityUnits: input.GlobalTableProvisionedWriteCapacityUnits }; }
      if (input.GlobalTableProvisionedWriteCapacityAutoScalingSettingsUpdate !== undefined) { replica.autoScaling ??= {}; replica.autoScaling.provisionedWrite = validateAutoScalingSetting(input.GlobalTableProvisionedWriteCapacityAutoScalingSettingsUpdate); }
      for (const update of input.GlobalTableGlobalSecondaryIndexSettingsUpdate ?? []) { const index = replica.globalSecondaryIndexes?.find(candidate => candidate.indexName === update.IndexName); if (!index) throw new AwsError("IndexNotFoundException", `Index not found: ${update.IndexName}`); if (update.ProvisionedWriteCapacityUnits !== undefined) index.provisionedThroughput = { ...(index.provisionedThroughput ?? { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }), WriteCapacityUnits: update.ProvisionedWriteCapacityUnits }; if (update.ProvisionedWriteCapacityAutoScalingSettingsUpdate !== undefined) { replica.autoScaling ??= {}; replica.autoScaling.globalSecondaryIndexes ??= {}; (replica.autoScaling.globalSecondaryIndexes[update.IndexName] ??= {}).provisionedWrite = validateAutoScalingSetting(update.ProvisionedWriteCapacityAutoScalingSettingsUpdate); } }
    }
    for (const update of input.ReplicaSettingsUpdate ?? []) {
      const region = this.validateRegionName(update.RegionName); const replica = this.store.regionState(region).tables[table.name]; if (!replica?.globalTable) throw new AwsError("ReplicaNotFoundException", "The specified replica is no longer part of the global table");
      if (update.ReplicaProvisionedReadCapacityUnits !== undefined) { if (!Number.isInteger(update.ReplicaProvisionedReadCapacityUnits) || update.ReplicaProvisionedReadCapacityUnits < 1) throw new AwsError("ValidationException", "ReplicaProvisionedReadCapacityUnits must be positive"); replica.provisionedThroughput = { ...(replica.provisionedThroughput ?? { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }), ReadCapacityUnits: update.ReplicaProvisionedReadCapacityUnits }; }
      if (update.ReplicaTableClass !== undefined) { if (!["STANDARD", "STANDARD_INFREQUENT_ACCESS"].includes(update.ReplicaTableClass)) throw new AwsError("ValidationException", "Invalid ReplicaTableClass"); replica.tableClass = update.ReplicaTableClass; replica.tableClassLastUpdatedAt = now; }
      if (update.ReplicaProvisionedReadCapacityAutoScalingSettingsUpdate !== undefined) { replica.autoScaling ??= {}; replica.autoScaling.replicas ??= {}; (replica.autoScaling.replicas[region] ??= {}).provisionedRead = validateAutoScalingSetting(update.ReplicaProvisionedReadCapacityAutoScalingSettingsUpdate); }
      for (const indexUpdate of update.ReplicaGlobalSecondaryIndexSettingsUpdate ?? []) { const index = replica.globalSecondaryIndexes?.find(candidate => candidate.indexName === indexUpdate.IndexName); if (!index) throw new AwsError("IndexNotFoundException", `Index not found: ${indexUpdate.IndexName}`); if (indexUpdate.ProvisionedReadCapacityUnits !== undefined) index.provisionedThroughput = { ...(index.provisionedThroughput ?? { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }), ReadCapacityUnits: indexUpdate.ProvisionedReadCapacityUnits }; if (indexUpdate.ProvisionedReadCapacityAutoScalingSettingsUpdate !== undefined) { replica.autoScaling ??= {}; replica.autoScaling.replicas ??= {}; const auto = replica.autoScaling.replicas[region] ??= {}; auto.globalSecondaryIndexes ??= {}; (auto.globalSecondaryIndexes[indexUpdate.IndexName] ??= {}).provisionedRead = validateAutoScalingSetting(indexUpdate.ProvisionedReadCapacityAutoScalingSettingsUpdate); } }
    }
    for (const [, replica] of replicas) { if (replica.globalTable) replica.globalTable.status = "ACTIVE"; replica.status = "ACTIVE"; } await this.store.save(); return { GlobalTableName: table.name, ReplicaSettings: this.globalReplicaSettings(table) };
  }

  private async updateCurrentGlobalReplicas(table: TableState, input: any): Promise<any> {
    if (!Array.isArray(input.ReplicaUpdates) || input.ReplicaUpdates.length !== 1) throw new AwsError("ValidationException", "ReplicaUpdates must contain exactly one update");
    if (input.MultiRegionConsistency !== undefined && input.MultiRegionConsistency !== "EVENTUAL") throw new AwsError("ValidationException", "Multi-Region strong consistency and witnesses are dependency-blocked in this local environment; use EVENTUAL");
    if (input.GlobalTableWitnessUpdates !== undefined) throw new AwsError("ValidationException", "Global table witnesses require the dependency-blocked MRSC model");
    if (input.GlobalTableSettingsReplicationMode !== undefined) throw new AwsError("ValidationException", "Multi-account global-table settings replication is dependency-blocked in this single-account simulator");
    const update = input.ReplicaUpdates[0]; const kinds = ["Create", "Delete", "Update"].filter(kind => update?.[kind]); if (kinds.length !== 1 || Object.keys(update).length !== 1) throw new AwsError("ValidationException", "Each replica update must contain exactly one Create, Delete, or Update action"); const request = update[kinds[0]]; const region = this.validateRegionName(request.RegionName); if (region === this.region) throw new AwsError("ValidationException", "Replica update RegionName must differ from the request Region");
    if (kinds[0] === "Create") {
      if (table.globalTable?.replicaRegions.includes(region)) throw new AwsError("ReplicaAlreadyExistsException", "The specified replica is already part of the global table"); const targetState = this.store.regionState(region); if (targetState.tables[table.name]) throw new AwsError("ResourceInUseException", `A table named ${table.name} already exists in ${region}`);
      const target = this.cloneReplicaTable(table, region); targetState.tables[target.name] = target; const entries = table.globalTable ? [...this.globalReplicaEntries(table), [region, target] as [string, TableState]] : [[this.region, table] as [string, TableState], [region, target] as [string, TableState]]; this.installGlobalMembership(table, entries, "2019.11.21");
      for (const [, replica] of entries) if (replica.globalTable) replica.globalTable.status = "UPDATING";
    } else if (kinds[0] === "Delete") this.removeGlobalReplica(table, region);
    else {
      const replica = this.store.regionState(region).tables[table.name]; if (!replica?.globalTable) throw new AwsError("ReplicaNotFoundException", "The specified replica is no longer part of the global table");
      if (request.TableClassOverride !== undefined) { if (!["STANDARD", "STANDARD_INFREQUENT_ACCESS"].includes(request.TableClassOverride)) throw new AwsError("ValidationException", "Invalid TableClassOverride"); replica.tableClass = request.TableClassOverride; replica.tableClassLastUpdatedAt = this.clock.now(); }
      if (request.ProvisionedThroughputOverride?.ReadCapacityUnits !== undefined) replica.provisionedThroughput = { ...(replica.provisionedThroughput ?? { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }), ReadCapacityUnits: request.ProvisionedThroughputOverride.ReadCapacityUnits };
      if (request.OnDemandThroughputOverride?.MaxReadRequestUnits !== undefined) replica.onDemandThroughput = { ...(replica.onDemandThroughput ?? {}), MaxReadRequestUnits: request.OnDemandThroughputOverride.MaxReadRequestUnits };
      if (request.KMSMasterKeyId !== undefined) throw new AwsError("ValidationException", "KMS-backed replica keys are dependency-blocked until KMS is implemented");
    }
    table.status = "UPDATING"; await this.store.save(); const description = tableDescription(table, this.store); this.scheduleTransition(() => { table.status = "ACTIVE"; for (const [, replica] of this.globalReplicaEntries(table)) if (replica.globalTable) replica.globalTable.status = "ACTIVE"; }); return { TableDescription: description };
  }

  private backupDetails(backup: DynamoBackupState, status: "CREATING" | "AVAILABLE" | "DELETED" = backup.backupStatus): any {
    return { BackupArn: backup.backupArn, BackupCreationDateTime: backup.createdAt / 1000, BackupName: backup.backupName, BackupSizeBytes: backup.sizeBytes, BackupStatus: status, BackupType: backup.backupType };
  }

  private backupSummary(backup: DynamoBackupState): any {
    return { ...this.backupDetails(backup), TableArn: backup.sourceTableArn, TableId: backup.sourceTableId, TableName: backup.sourceTableName };
  }

  private async backupDescription(backup: DynamoBackupState, status?: "CREATING" | "AVAILABLE" | "DELETED"): Promise<any> {
    const source = (await this.backupPersistence.readSnapshot(backup.snapshotHash)).table;
    const indexDescription = (index: DynamoIndexState) => ({ IndexName: index.indexName, KeySchema: clone(index.keySchema), Projection: clone(index.projection), ...(index.provisionedThroughput ? { ProvisionedThroughput: { ReadCapacityUnits: index.provisionedThroughput.ReadCapacityUnits, WriteCapacityUnits: index.provisionedThroughput.WriteCapacityUnits } } : {}), ...(index.onDemandThroughput && Object.keys(index.onDemandThroughput).length ? { OnDemandThroughput: clone(index.onDemandThroughput) } : {}) });
    return { BackupDetails: this.backupDetails(backup, status), SourceTableDetails: { BillingMode: source.billingMode, ItemCount: Object.keys(source.items).length, KeySchema: clone(source.keySchema), ...(source.onDemandThroughput && Object.keys(source.onDemandThroughput).length ? { OnDemandThroughput: clone(source.onDemandThroughput) } : {}), ...(source.provisionedThroughput ? { ProvisionedThroughput: { ReadCapacityUnits: source.provisionedThroughput.ReadCapacityUnits, WriteCapacityUnits: source.provisionedThroughput.WriteCapacityUnits } } : {}), TableArn: source.arn, TableCreationDateTime: source.createdAt / 1000, TableId: source.id, TableName: source.name, TableSizeBytes: backup.sizeBytes }, SourceTableFeatureDetails: { GlobalSecondaryIndexes: (source.globalSecondaryIndexes ?? []).map(indexDescription), LocalSecondaryIndexes: (source.localSecondaryIndexes ?? []).map(indexDescription), SSEDescription: { SSEType: source.sse.sseType, Status: source.sse.status, ...(source.sse.kmsMasterKeyId ? { KMSMasterKeyArn: source.sse.kmsMasterKeyId } : {}) }, TimeToLiveDescription: { ...(source.timeToLive.attributeName ? { AttributeName: source.timeToLive.attributeName } : {}), TimeToLiveStatus: source.timeToLive.status } } };
  }

  private requireBackup(value: unknown): DynamoBackupState {
    const arn = String(value ?? ""); const backup = this.backups[arn]; if (!backup) throw new AwsError("BackupNotFoundException", "Backup not found for the given BackupARN"); return backup;
  }

  private requireBackupTable(value: unknown): TableState {
    try { return requireTableControl(this.store, this.region, value); } catch (error) { if (error instanceof AwsError && error.code === "ResourceNotFoundException") throw new AwsError("TableNotFoundException", "A source table with the specified name does not exist"); throw error; }
  }

  async CreateBackup(input: any): Promise<any> {
    const table = this.requireBackupTable(input.TableName); if (table.status !== "ACTIVE") throw new AwsError("TableInUseException", "The source table is being created, updated, or deleted"); const name = String(input.BackupName ?? ""); if (!/^[A-Za-z0-9_.-]{3,255}$/.test(name)) throw new AwsError("ValidationException", "BackupName must be between 3 and 255 characters and contain only letters, numbers, underscores, hyphens, and periods");
    const now = this.clock.now(); const snapshot = await this.backupPersistence.createSnapshot(table); const arn = `${table.arn}/backup/${String(now).padStart(13, "0")}-${id(8)}`;
    const backup: DynamoBackupState = { backupArn: arn, backupName: name, backupType: "USER", backupStatus: "CREATING", createdAt: now, sizeBytes: snapshot.sizeBytes, sourceTableArn: table.arn, sourceTableId: table.id, sourceTableName: table.name, snapshotHash: snapshot.hash };
    this.backups[arn] = backup; await this.store.save(); this.scheduleTransition(() => { const current = this.backups[arn]; if (current) current.backupStatus = "AVAILABLE"; }); return { BackupDetails: this.backupDetails(backup) };
  }

  async DescribeBackup(input: any): Promise<any> { return { BackupDescription: await this.backupDescription(this.requireBackup(input.BackupArn)) }; }

  async ListBackups(input: any): Promise<any> {
    if (input.Limit !== undefined && (!Number.isInteger(input.Limit) || input.Limit < 1 || input.Limit > 100)) throw new AwsError("ValidationException", "Limit must be between 1 and 100");
    if (input.BackupType !== undefined && !["USER", "SYSTEM", "AWS_BACKUP", "ALL"].includes(input.BackupType)) throw new AwsError("ValidationException", "Invalid BackupType");
    const tableValue = input.TableName === undefined ? undefined : String(input.TableName); const tableName = tableValue?.match(/^arn:[^:]+:dynamodb:[^:]+:\d{12}:table\/([^/]+)$/)?.[1] ?? tableValue; const lower = input.TimeRangeLowerBound === undefined ? undefined : Number(input.TimeRangeLowerBound) * 1000; const upper = input.TimeRangeUpperBound === undefined ? undefined : Number(input.TimeRangeUpperBound) * 1000;
    if (lower !== undefined && !Number.isFinite(lower) || upper !== undefined && !Number.isFinite(upper)) throw new AwsError("ValidationException", "Invalid backup time range");
    let values = Object.values(this.backups).filter(backup => (!tableName || backup.sourceTableName === tableName) && ([undefined, "USER", "ALL"].includes(input.BackupType)) && (lower === undefined || backup.createdAt >= lower) && (upper === undefined || backup.createdAt < upper)).sort((left, right) => right.createdAt - left.createdAt || left.backupArn.localeCompare(right.backupArn));
    if (input.ExclusiveStartBackupArn !== undefined) { const index = values.findIndex(backup => backup.backupArn === input.ExclusiveStartBackupArn); if (index < 0) throw new AwsError("ValidationException", "ExclusiveStartBackupArn is invalid for this request"); values = values.slice(index + 1); }
    const limit = input.Limit ?? 100; const page = values.slice(0, limit); return { BackupSummaries: page.map(backup => this.backupSummary(backup)), ...(values.length > page.length && page.length ? { LastEvaluatedBackupArn: page.at(-1)!.backupArn } : {}) };
  }

  async DeleteBackup(input: any): Promise<any> {
    const backup = this.requireBackup(input.BackupArn); if (backup.backupStatus === "CREATING" || Object.values(this.tables).some(table => table.restoreSummary?.restoreInProgress && table.restoreSummary.sourceBackupArn === backup.backupArn)) throw new AwsError("BackupInUseException", "There is another ongoing conflicting backup control plane operation on the table"); const description = await this.backupDescription(backup, "DELETED"); delete this.backups[backup.backupArn]; const shared = Object.values(this.backups).some(candidate => candidate.snapshotHash === backup.snapshotHash); await this.store.save(); if (!shared) await this.backupPersistence.deleteSnapshot(backup.snapshotHash); return { BackupDescription: description };
  }

  private continuousBackupsDescription(table: TableState): any {
    const pitr = table.pointInTimeRecovery; return { ContinuousBackupsStatus: "ENABLED", PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: pitr.status, RecoveryPeriodInDays: pitr.recoveryPeriodInDays, ...(pitr.status === "ENABLED" && pitr.enabledAt !== undefined ? { EarliestRestorableDateTime: (pitr.earliestRestorableAt ?? pitr.enabledAt) / 1000, LatestRestorableDateTime: this.pitrTime() / 1000 } : {}) } };
  }

  async DescribeContinuousBackups(input: any): Promise<any> {
    const table = this.requireBackupTable(input.TableName); await this.backupPersistence.prunePitr(table, this.pitrTime()); await this.store.save(); return { ContinuousBackupsDescription: this.continuousBackupsDescription(table) };
  }

  async UpdateContinuousBackups(input: any): Promise<any> {
    const table = this.requireBackupTable(input.TableName); const specification = input.PointInTimeRecoverySpecification; if (!specification || typeof specification.PointInTimeRecoveryEnabled !== "boolean") throw new AwsError("ValidationException", "PointInTimeRecoverySpecification with PointInTimeRecoveryEnabled is required");
    const period = specification.RecoveryPeriodInDays; if (period !== undefined && (!Number.isInteger(period) || period < 1 || period > 35)) throw new AwsError("ValidationException", "RecoveryPeriodInDays must be between 1 and 35"); if (!specification.PointInTimeRecoveryEnabled && period !== undefined) throw new AwsError("ValidationException", "RecoveryPeriodInDays cannot be specified while disabling point-in-time recovery");
    const now = this.pitrTime(); const pitr = table.pointInTimeRecovery;
    if (specification.PointInTimeRecoveryEnabled) {
      if (pitr.status === "DISABLED") { pitr.status = "ENABLED"; pitr.recoveryPeriodInDays = period ?? 35; pitr.enabledAt = now; pitr.earliestRestorableAt = now; await this.backupPersistence.resetPitr(table, now); }
      else { if (period !== undefined) pitr.recoveryPeriodInDays = period; await this.backupPersistence.prunePitr(table, now); }
    } else pitr.status = "DISABLED";
    await this.store.save(); return { ContinuousBackupsDescription: this.continuousBackupsDescription(table) };
  }

  private localBucketRoot(value: unknown): string {
    if (!this.allowLocalFiles) throw new AwsError("ValidationException", "S3 is not available in this simulator. Set STACKSIM_ALLOW_LOCAL_FILES=true and use a file:// bucket location for the local import/export extension");
    if (typeof value !== "string" || !value.startsWith("file://")) throw new AwsError("ValidationException", "S3 is dependency-blocked locally; S3Bucket must be a file:// location when STACKSIM_ALLOW_LOCAL_FILES=true");
    try { const url = new URL(value); if (url.protocol !== "file:") throw new Error(); return resolve(fileURLToPath(url)); }
    catch { throw new AwsError("ValidationException", "S3Bucket must be a valid absolute file:// location"); }
  }

  private localObjectPath(bucket: unknown, prefix: unknown): string {
    const root = this.localBucketRoot(bucket); const value = prefix === undefined ? "" : String(prefix);
    if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || value.split("/").some(segment => segment === "..")) throw new AwsError("ValidationException", "Local S3 prefixes must be relative and cannot traverse outside the file:// bucket");
    const target = resolve(root, value); const fromRoot = relative(root, target); if (fromRoot.startsWith("..") || fromRoot.startsWith("/")) throw new AwsError("ValidationException", "Local S3 prefix escapes the file:// bucket"); return target;
  }

  private exportDescription(job: DynamoExportState): any {
    return { ExportArn: job.exportArn, ExportStatus: job.exportStatus, StartTime: job.startTime / 1000, ...(job.endTime !== undefined ? { EndTime: job.endTime / 1000 } : {}), ExportManifest: job.exportManifest, TableArn: job.tableArn, TableId: job.tableId, ExportTime: job.exportTime / 1000, ClientToken: job.clientToken, S3Bucket: job.s3Bucket, ...(job.s3BucketOwner ? { S3BucketOwner: job.s3BucketOwner } : {}), ...(job.s3Prefix ? { S3Prefix: job.s3Prefix } : {}), S3SseAlgorithm: job.s3SseAlgorithm, ...(job.failureCode ? { FailureCode: job.failureCode } : {}), ...(job.failureMessage ? { FailureMessage: job.failureMessage } : {}), ExportFormat: job.exportFormat, BilledSizeBytes: job.billedSizeBytes, ItemCount: job.itemCount, ExportType: job.exportType };
  }

  private requireExport(value: unknown): DynamoExportState {
    const job = this.exports[String(value ?? "")]; if (!job) throw new AwsError("ExportNotFoundException", "The specified export was not found"); return job;
  }

  async ExportTableToPointInTime(input: any): Promise<any> {
    const table = this.requireBackupTable(input.TableArn); const pitr = table.pointInTimeRecovery;
    if (pitr.status !== "ENABLED" || pitr.enabledAt === undefined) throw new AwsError("PointInTimeRecoveryUnavailableException", "Point in time recovery has not yet been enabled for this source table");
    const format = input.ExportFormat ?? "DYNAMODB_JSON"; if (format === "ION") throw new AwsError("ValidationException", "Ion export is codec-blocked locally; use DYNAMODB_JSON"); if (format !== "DYNAMODB_JSON") throw new AwsError("ValidationException", "ExportFormat must be DYNAMODB_JSON or ION");
    const exportType = input.ExportType ?? "FULL_EXPORT"; if (exportType === "INCREMENTAL_EXPORT" || input.IncrementalExportSpecification !== undefined) throw new AwsError("ValidationException", "Incremental export is not implemented in the local file extension; use FULL_EXPORT"); if (exportType !== "FULL_EXPORT") throw new AwsError("ValidationException", "Invalid ExportType");
    if (input.S3SseAlgorithm === "KMS" || input.S3SseKmsKeyId !== undefined) throw new AwsError("ValidationException", "KMS-encrypted export is dependency-blocked until KMS is implemented; use AES256"); if (input.S3SseAlgorithm !== undefined && input.S3SseAlgorithm !== "AES256") throw new AwsError("ValidationException", "S3SseAlgorithm must be AES256 or KMS");
    const root = this.localBucketRoot(input.S3Bucket); const prefix = input.S3Prefix === undefined ? "" : String(input.S3Prefix); this.localObjectPath(input.S3Bucket, prefix);
    const request = clone(input); delete request.ClientToken; const requestHash = createHash("sha256").update(canonicalJson(request)).digest("hex"); const clientToken = String(input.ClientToken ?? id(32)); const previous = Object.values(this.exports).filter(job => job.clientToken === clientToken && this.clock.now() - job.startTime <= 8 * 60 * 60 * 1000).sort((left, right) => right.startTime - left.startTime)[0];
    if (previous) { if (previous.requestHash !== requestHash) throw new AwsError("ExportConflictException", "A different export request already used this ClientToken"); return { ExportDescription: this.exportDescription(previous) }; }
    const latest = this.pitrTime(); const exportTime = input.ExportTime === undefined ? latest : Math.floor(Number(input.ExportTime) * 1000); const earliest = pitr.earliestRestorableAt ?? pitr.enabledAt;
    if (!Number.isFinite(exportTime) || exportTime < earliest || exportTime > latest) throw new AwsError("InvalidExportTimeException", "The specified ExportTime is outside of the point in time recovery window");
    await this.backupPersistence.prunePitr(table, latest); const items = input.ExportTime === undefined ? clone(table.items) : await this.backupPersistence.itemsAt(table, exportTime); const now = this.clock.now(); const exportId = `${String(now).padStart(13, "0")}-${id(8)}`; const keyPrefix = [prefix.replace(/^\/+|\/+$/g, ""), "AWSDynamoDB", exportId].filter(Boolean).join("/"); const directory = resolve(root, keyPrefix); const dataKey = `${keyPrefix}/data/data.json.gz`; const dataPath = resolve(root, dataKey); const lines = Object.entries(items).sort(([left], [right]) => left.localeCompare(right)).map(([, item]) => JSON.stringify({ Item: item })).join("\n") + (Object.keys(items).length ? "\n" : ""); const compressed = gzipSync(Buffer.from(lines));
    await mkdir(dirname(dataPath), { recursive: true, mode: 0o700 }); await writeFile(dataPath, compressed, { mode: 0o600 }); await writeFile(resolve(directory, "_started"), "", { mode: 0o600 });
    const manifestFiles = `${JSON.stringify({ itemCount: Object.keys(items).length, md5Checksum: createHash("md5").update(compressed).digest("base64"), etag: createHash("md5").update(compressed).digest("hex"), dataFileS3Key: dataKey })}\n`; const manifestFilesKey = `${keyPrefix}/manifest-files.json`; const exportArn = `${table.arn}/export/${exportId}`;
    const summary = JSON.stringify({ version: "2020-06-30", exportArn, startTime: new Date(now).toISOString(), endTime: new Date(now + 50).toISOString(), tableArn: table.arn, tableId: table.id, exportTime: new Date(exportTime).toISOString(), s3Bucket: input.S3Bucket, s3Prefix: prefix, s3SseAlgorithm: "AES256", s3SseKmsKeyId: null, manifestFilesS3Key: manifestFilesKey, billedSizeBytes: Buffer.byteLength(JSON.stringify(items)), itemCount: Object.keys(items).length, outputFormat: "DYNAMODB_JSON" }, null, 2);
    await writeFile(resolve(directory, "manifest-files.json"), manifestFiles, { mode: 0o600 }); await writeFile(resolve(directory, "manifest-files.checksum"), createHash("md5").update(manifestFiles).digest("hex"), { mode: 0o600 }); await writeFile(resolve(directory, "manifest-summary.json"), summary, { mode: 0o600 }); await writeFile(resolve(directory, "manifest-summary.checksum"), createHash("md5").update(summary).digest("hex"), { mode: 0o600 });
    const job: DynamoExportState = { exportArn, exportStatus: "IN_PROGRESS", startTime: now, exportManifest: `${keyPrefix}/manifest-summary.json`, tableArn: table.arn, tableId: table.id, exportTime, clientToken, requestHash, s3Bucket: input.S3Bucket, ...(input.S3BucketOwner ? { s3BucketOwner: String(input.S3BucketOwner) } : {}), ...(prefix ? { s3Prefix: prefix } : {}), s3SseAlgorithm: "AES256", exportFormat: "DYNAMODB_JSON", billedSizeBytes: Buffer.byteLength(JSON.stringify(items)), itemCount: Object.keys(items).length, exportType: "FULL_EXPORT" };
    this.exports[exportArn] = job; await this.store.save(); this.scheduleTransition(() => { const current = this.exports[exportArn]; if (current) { current.exportStatus = "COMPLETED"; current.endTime = this.clock.now(); } }); return { ExportDescription: this.exportDescription(job) };
  }

  async DescribeExport(input: any): Promise<any> { return { ExportDescription: this.exportDescription(this.requireExport(input.ExportArn)) }; }

  async ListExports(input: any): Promise<any> {
    if (input.MaxResults !== undefined && (!Number.isInteger(input.MaxResults) || input.MaxResults < 1 || input.MaxResults > 25)) throw new AwsError("ValidationException", "MaxResults must be between 1 and 25"); let offset = 0;
    if (input.NextToken !== undefined) { try { const token = this.partiqlTokens.decode<{ offset: number; tableArn: string | null }>("DynamoDB.ListExports", String(input.NextToken)); if (!Number.isInteger(token.offset) || token.offset < 0 || token.tableArn !== (input.TableArn ?? null)) throw new Error(); offset = token.offset; } catch { throw new AwsError("ValidationException", "Invalid NextToken"); } }
    const cutoff = this.clock.now() - 90 * 24 * 60 * 60 * 1000; const values = Object.values(this.exports).filter(job => job.startTime >= cutoff && (!input.TableArn || job.tableArn === input.TableArn)).sort((left, right) => right.exportArn.localeCompare(left.exportArn)); const limit = input.MaxResults ?? 25; const page = values.slice(offset, offset + limit); return { ExportSummaries: page.map(job => ({ ExportArn: job.exportArn, ExportStatus: job.exportStatus, ExportType: job.exportType })), ...(offset + page.length < values.length ? { NextToken: this.partiqlTokens.encode("DynamoDB.ListExports", { offset: offset + page.length, tableArn: input.TableArn ?? null }) } : {}) };
  }

  private importDescription(job: DynamoImportState): any {
    return { ImportArn: job.importArn, ImportStatus: job.importStatus, TableArn: job.tableArn, TableId: job.tableId, ClientToken: job.clientToken, S3BucketSource: clone(job.s3BucketSource), ErrorCount: job.errorCount, InputFormat: job.inputFormat, InputCompressionType: job.inputCompressionType, TableCreationParameters: clone(job.tableCreationParameters), StartTime: job.startTime / 1000, ...(job.endTime !== undefined ? { EndTime: job.endTime / 1000 } : {}), ProcessedSizeBytes: job.processedSizeBytes, ProcessedItemCount: job.processedItemCount, ImportedItemCount: job.importedItemCount, ...(job.failureCode ? { FailureCode: job.failureCode } : {}), ...(job.failureMessage ? { FailureMessage: job.failureMessage } : {}) };
  }

  private requireImport(value: unknown): DynamoImportState {
    const job = this.imports[String(value ?? "")]; if (!job) throw new AwsError("ImportNotFoundException", "The specified import was not found"); return job;
  }

  private async importSourceFiles(path: string): Promise<string[]> {
    let info; try { info = await stat(path); } catch { throw new AwsError("ValidationException", "The local import source does not exist"); }
    if (info.isFile()) return [path]; if (!info.isDirectory()) throw new AwsError("ValidationException", "The local import source must be a file or directory"); const result: string[] = [];
    const visit = async (directory: string): Promise<void> => { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = resolve(directory, entry.name); if (entry.isDirectory()) await visit(path); else if (entry.isFile() && !entry.name.startsWith("manifest-") && !entry.name.endsWith(".checksum") && entry.name !== "_started" && /\.(?:json|jsonl)(?:\.gz)?$/i.test(entry.name)) result.push(path); } }; await visit(path); result.sort(); if (!result.length) throw new AwsError("ValidationException", "No DynamoDB JSON data files were found under the local import prefix"); return result;
  }

  async ImportTable(input: any): Promise<any> {
    if (input.InputFormat === "ION") throw new AwsError("ValidationException", "Ion import is codec-blocked locally; use DYNAMODB_JSON"); if (input.InputFormat === "CSV") throw new AwsError("ValidationException", "CSV import is not implemented in the local file extension; use DYNAMODB_JSON"); if (input.InputFormat !== "DYNAMODB_JSON") throw new AwsError("ValidationException", "InputFormat must be DYNAMODB_JSON, ION, or CSV"); if (input.InputFormatOptions !== undefined) throw new AwsError("ValidationException", "InputFormatOptions are only valid for the dependency-blocked CSV format");
    const compression = input.InputCompressionType ?? "NONE"; if (compression === "ZSTD") throw new AwsError("ValidationException", "ZSTD import is codec-blocked locally; use NONE or GZIP"); if (!["NONE", "GZIP"].includes(compression)) throw new AwsError("ValidationException", "InputCompressionType must be NONE, GZIP, or ZSTD");
    const source = input.S3BucketSource; if (!source || typeof source !== "object" || typeof source.S3Bucket !== "string") throw new AwsError("ValidationException", "S3BucketSource.S3Bucket is required"); const sourcePath = this.localObjectPath(source.S3Bucket, source.S3KeyPrefix); const creation = input.TableCreationParameters; if (!creation || typeof creation !== "object") throw new AwsError("ValidationException", "TableCreationParameters are required");
    const request = clone(input); delete request.ClientToken; const requestHash = createHash("sha256").update(canonicalJson(request)).digest("hex"); const clientToken = String(input.ClientToken ?? id(32)); const previous = Object.values(this.imports).filter(job => job.clientToken === clientToken && this.clock.now() - job.startTime <= 8 * 60 * 60 * 1000).sort((left, right) => right.startTime - left.startTime)[0];
    if (previous) { if (previous.requestHash !== requestHash) throw new AwsError("IdempotentParameterMismatch", "A different import request already used this ClientToken"); return { ImportTableDescription: this.importDescription(previous) }; }
    if (this.tables[creation.TableName]) throw new AwsError("ResourceInUseException", `Table already exists: ${creation.TableName}`); const files = await this.importSourceFiles(sourcePath); const imported: Item[] = []; let processedSizeBytes = 0;
    for (const file of files) { const raw = await readFile(file); processedSizeBytes += raw.length; let decoded: Buffer; try { decoded = compression === "GZIP" ? gunzipSync(raw) : raw; } catch { throw new AwsError("ValidationException", `Unable to decompress local import data file ${file}`); } for (const [index, line] of decoded.toString("utf8").split(/\r?\n/).entries()) { if (!line.trim()) continue; let value: any; try { value = JSON.parse(line); } catch { throw new AwsError("ValidationException", `Invalid DynamoDB JSON at ${file}:${index + 1}`); } if (!value?.Item || typeof value.Item !== "object" || Array.isArray(value.Item)) throw new AwsError("ValidationException", `DynamoDB JSON lines must contain an Item object (${file}:${index + 1})`); imported.push(value.Item); } }
    const createInput = { ...clone(creation), BillingMode: creation.BillingMode ?? "PAY_PER_REQUEST" }; await this.CreateTable(createInput); const table = this.tables[creation.TableName]; const items: Record<string, Item> = {};
    try { for (const item of imported) { validateItem(table, item); validateIndexAttributes(table, item); items[stableItemKey(table, item)] = clone(item); } } catch (error) { delete this.tables[table.name]; await this.store.save(); throw error; }
    table.items = items; table.status = "CREATING"; for (const index of table.globalSecondaryIndexes ?? []) { index.indexStatus = "CREATING"; index.backfilling = true; } const now = this.clock.now(); const importId = `${String(now).padStart(13, "0")}-${id(8)}`; const importArn = `${table.arn}/import/${importId}`; const state: DynamoImportState = { importArn, importStatus: "IN_PROGRESS", tableArn: table.arn, tableId: table.id, clientToken, requestHash, s3BucketSource: clone(source), inputFormat: "DYNAMODB_JSON", inputCompressionType: compression, tableCreationParameters: clone(createInput), startTime: now, processedSizeBytes, processedItemCount: imported.length, importedItemCount: Object.keys(items).length, errorCount: 0 };
    this.imports[importArn] = state; await this.store.save(); this.scheduleTransition(() => { const job = this.imports[importArn]; if (!job) return; job.importStatus = "COMPLETED"; job.endTime = this.clock.now(); table.status = "ACTIVE"; for (const index of table.globalSecondaryIndexes ?? []) { index.indexStatus = "ACTIVE"; index.backfilling = false; } }); return { ImportTableDescription: this.importDescription(state) };
  }

  async DescribeImport(input: any): Promise<any> { return { ImportTableDescription: this.importDescription(this.requireImport(input.ImportArn)) }; }

  async ListImports(input: any): Promise<any> {
    if (input.PageSize !== undefined && (!Number.isInteger(input.PageSize) || input.PageSize < 1 || input.PageSize > 25)) throw new AwsError("ValidationException", "PageSize must be between 1 and 25"); let offset = 0;
    if (input.NextToken !== undefined) { try { const token = this.partiqlTokens.decode<{ offset: number; tableArn: string | null }>("DynamoDB.ListImports", String(input.NextToken)); if (!Number.isInteger(token.offset) || token.offset < 0 || token.tableArn !== (input.TableArn ?? null)) throw new Error(); offset = token.offset; } catch { throw new AwsError("ValidationException", "Invalid NextToken"); } }
    const cutoff = this.clock.now() - 90 * 24 * 60 * 60 * 1000; const values = Object.values(this.imports).filter(job => job.startTime >= cutoff && (!input.TableArn || job.tableArn === input.TableArn)).sort((left, right) => right.importArn.localeCompare(left.importArn)); const limit = input.PageSize ?? 25; const page = values.slice(offset, offset + limit); return { ImportSummaryList: page.map(job => ({ ImportArn: job.importArn, ImportStatus: job.importStatus, TableArn: job.tableArn, S3BucketSource: clone(job.s3BucketSource), InputFormat: job.inputFormat, StartTime: job.startTime / 1000, ...(job.endTime !== undefined ? { EndTime: job.endTime / 1000 } : {}) })), ...(offset + page.length < values.length ? { NextToken: this.partiqlTokens.encode("DynamoDB.ListImports", { offset: offset + page.length, tableArn: input.TableArn ?? null }) } : {}) };
  }

  private contributorTarget(input: any): { table: TableState; index?: DynamoIndexState; key: string } {
    const table = requireTableControl(this.store, this.region, input.TableName); if (table.status !== "ACTIVE") throw new AwsError("ResourceNotFoundException", "The table is not active");
    if (input.IndexName === undefined) return { table, key: CONTRIBUTOR_TABLE_KEY };
    const name = String(input.IndexName ?? ""); const index = table.globalSecondaryIndexes?.find(candidate => candidate.indexName === name); if (!index || (index.indexStatus ?? "ACTIVE") !== "ACTIVE") throw new AwsError("ResourceNotFoundException", `Requested resource not found: Index: ${name} not found`); return { table, index, key: name };
  }

  private contributorState(table: TableState, key: string): DynamoContributorInsightsState {
    return table.contributorInsights[key] ?? { status: "DISABLED", mode: "ACCESSED_AND_THROTTLED_KEYS", lastUpdatedAt: table.createdAt, ruleCreatedAt: table.createdAt };
  }

  private contributorRules(table: TableState, index: DynamoIndexState | undefined, insight: DynamoContributorInsightsState): string[] {
    if (insight.status === "DISABLED" || insight.status === "DISABLING") return [];
    const resource = index ? `${table.name}-${index.indexName}` : table.name; const suffix = Math.floor(insight.ruleCreatedAt / 1000); const sorted = Boolean((index?.keySchema ?? table.keySchema).some(key => key.KeyType === "RANGE")); const types = insight.mode === "ACCESSED_AND_THROTTLED_KEYS" ? ["PKC", ...(sorted ? ["SKC"] : []), "PKT", ...(sorted ? ["SKT"] : [])] : ["PKT", ...(sorted ? ["SKT"] : [])]; return types.map(type => `DynamoDBContributorInsights-${type}-${resource}-${suffix}`);
  }

  private contributorDescription(table: TableState, index: DynamoIndexState | undefined, key: string): any {
    const insight = this.contributorState(table, key); return { TableName: table.name, ...(index ? { IndexName: index.indexName } : {}), ContributorInsightsStatus: insight.status, ContributorInsightsMode: insight.mode, ContributorInsightsRuleList: this.contributorRules(table, index, insight), LastUpdateDateTime: insight.lastUpdatedAt / 1000 };
  }

  async DescribeContributorInsights(input: any): Promise<any> { const { table, index, key } = this.contributorTarget(input); return this.contributorDescription(table, index, key); }

  async UpdateContributorInsights(input: any): Promise<any> {
    const action = String(input.ContributorInsightsAction ?? ""); if (!new Set(["ENABLE", "DISABLE"]).has(action)) throw new AwsError("ValidationException", "ContributorInsightsAction must be ENABLE or DISABLE"); const { table, index, key } = this.contributorTarget(input); const previous = this.contributorState(table, key); const mode = (input.ContributorInsightsMode ?? previous.mode) as DynamoContributorInsightsMode; if (!new Set<DynamoContributorInsightsMode>(["ACCESSED_AND_THROTTLED_KEYS", "THROTTLED_KEYS"]).has(mode)) throw new AwsError("ValidationException", "ContributorInsightsMode must be ACCESSED_AND_THROTTLED_KEYS or THROTTLED_KEYS");
    const now = this.clock.now(); const insight: DynamoContributorInsightsState = { status: action === "ENABLE" ? "ENABLING" : "DISABLING", mode, lastUpdatedAt: now, ruleCreatedAt: previous.status === "DISABLED" && action === "ENABLE" ? now : previous.ruleCreatedAt }; table.contributorInsights[key] = insight; await this.store.save(); this.scheduleTransition(() => { const current = table.contributorInsights[key]; if (!current) return; current.status = action === "ENABLE" ? "ENABLED" : "DISABLED"; current.lastUpdatedAt = this.clock.now(); }); return { TableName: table.name, ...(index ? { IndexName: index.indexName } : {}), ContributorInsightsStatus: insight.status, ContributorInsightsMode: insight.mode };
  }

  async ListContributorInsights(input: any): Promise<any> {
    if (input.MaxResults !== undefined && (!Number.isInteger(input.MaxResults) || input.MaxResults < 1 || input.MaxResults > 100)) throw new AwsError("ValidationException", "MaxResults must be between 1 and 100"); const selected = input.TableName === undefined ? undefined : requireTableControl(this.store, this.region, input.TableName); const tableName = selected?.name ?? null; let offset = 0;
    if (input.NextToken !== undefined) { try { const token = this.partiqlTokens.decode<{ offset: number; tableName: string | null }>("DynamoDB.ListContributorInsights", String(input.NextToken)); if (!Number.isInteger(token.offset) || token.offset < 0 || token.tableName !== tableName) throw new Error(); offset = token.offset; } catch { throw new AwsError("ValidationException", "Invalid NextToken"); } }
    const tables = selected ? [selected] : Object.values(this.tables); const values = tables.flatMap(table => [{ table, index: undefined, key: CONTRIBUTOR_TABLE_KEY }, ...(table.globalSecondaryIndexes ?? []).map(index => ({ table, index, key: index.indexName }))]).sort((left, right) => left.table.name.localeCompare(right.table.name) || (left.index?.indexName ?? "").localeCompare(right.index?.indexName ?? "")); const limit = input.MaxResults ?? 100; const page = values.slice(offset, offset + limit); const ContributorInsightsSummaries = page.map(({ table, index, key }) => { const insight = this.contributorState(table, key); return { TableName: table.name, ...(index ? { IndexName: index.indexName } : {}), ContributorInsightsStatus: insight.status, ContributorInsightsMode: insight.mode }; }); return { ContributorInsightsSummaries, ...(offset + page.length < values.length ? { NextToken: this.partiqlTokens.encode("DynamoDB.ListContributorInsights", { offset: offset + page.length, tableName }) } : {}) };
  }

  private kinesisTable(value: unknown): TableState { const table = requireTableControl(this.store, this.region, value); if (table.status !== "ACTIVE") throw new AwsError("ResourceNotFoundException", "The table is not active"); return table; }

  private kinesisStreamArn(value: unknown): string {
    const arn = String(value ?? ""); const match = arn.match(/^arn:(?:aws|aws-us-gov|aws-cn):kinesis:([^:]+):(\d{12}):stream\/[A-Za-z0-9_.-]{1,128}$/); if (!match || arn.length > 1024) throw new AwsError("ValidationException", "StreamArn must be a valid Kinesis data stream ARN"); if (match[1] !== this.region || match[2] !== this.store.accountId) throw new AwsError("ValidationException", "The Kinesis data stream must be in the same account and Region as the DynamoDB table"); return arn;
  }

  private kinesisPrecision(configuration: unknown, fallback: "MILLISECOND" | "MICROSECOND" = "MILLISECOND"): "MILLISECOND" | "MICROSECOND" {
    if (configuration === undefined) return fallback; if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) throw new AwsError("ValidationException", "Kinesis streaming configuration must be an object"); const value = (configuration as any).ApproximateCreationDateTimePrecision ?? fallback; if (!new Set(["MILLISECOND", "MICROSECOND"]).has(value)) throw new AwsError("ValidationException", "ApproximateCreationDateTimePrecision must be MILLISECOND or MICROSECOND"); return value;
  }

  private kinesisDestinationDescription(status: string): string {
    if (status === "ACTIVE") return "Configuration stored locally. Kinesis Data Streams is not implemented, so records are not delivered."; if (status === "DISABLED") return "Streaming destination configuration is disabled; no records are delivered."; return `Local configuration transition is ${status.toLowerCase()}; Kinesis record delivery is dependency-blocked.`;
  }

  private kinesisMutationResponse(table: TableState, destination: TableState["kinesisStreamingDestinations"][string], configurationName: "EnableKinesisStreamingConfiguration" | "UpdateKinesisStreamingConfiguration" = "EnableKinesisStreamingConfiguration"): any { return { TableName: table.name, StreamArn: destination.streamArn, DestinationStatus: destination.status, [configurationName]: { ApproximateCreationDateTimePrecision: destination.precision } }; }

  async DescribeKinesisStreamingDestination(input: any): Promise<any> {
    const table = requireTableControl(this.store, this.region, input.TableName); return { TableName: table.name, KinesisDataStreamDestinations: Object.values(table.kinesisStreamingDestinations).sort((left, right) => left.streamArn.localeCompare(right.streamArn)).map(destination => ({ StreamArn: destination.streamArn, DestinationStatus: destination.status, DestinationStatusDescription: destination.statusDescription ?? this.kinesisDestinationDescription(destination.status), ApproximateCreationDateTimePrecision: destination.precision })) };
  }

  async EnableKinesisStreamingDestination(input: any): Promise<any> {
    const table = this.kinesisTable(input.TableName); const streamArn = this.kinesisStreamArn(input.StreamArn); const current = Object.values(table.kinesisStreamingDestinations).find(destination => destination.status !== "DISABLED"); if (current) throw new AwsError("ResourceInUseException", "The table already has a Kinesis streaming destination or a destination update is in progress"); const precision = this.kinesisPrecision(input.EnableKinesisStreamingConfiguration); const now = this.clock.now(); const destination = { streamArn, status: "ENABLING" as const, precision, lastUpdatedAt: now, statusDescription: this.kinesisDestinationDescription("ENABLING") }; table.kinesisStreamingDestinations = { [streamArn]: destination }; await this.store.save(); this.scheduleTransition(() => { const current = table.kinesisStreamingDestinations[streamArn]; if (current) { current.status = "ACTIVE"; current.lastUpdatedAt = this.clock.now(); current.statusDescription = this.kinesisDestinationDescription("ACTIVE"); } }); return this.kinesisMutationResponse(table, destination);
  }

  async DisableKinesisStreamingDestination(input: any): Promise<any> {
    const table = this.kinesisTable(input.TableName); const streamArn = this.kinesisStreamArn(input.StreamArn); const destination = table.kinesisStreamingDestinations[streamArn]; if (!destination) throw new AwsError("ResourceNotFoundException", "The specified Kinesis streaming destination was not found"); if (destination.status !== "ACTIVE") throw new AwsError("ResourceInUseException", "The Kinesis streaming destination is not active"); destination.status = "DISABLING"; destination.lastUpdatedAt = this.clock.now(); destination.statusDescription = this.kinesisDestinationDescription("DISABLING"); await this.store.save(); this.scheduleTransition(() => { const current = table.kinesisStreamingDestinations[streamArn]; if (current) { current.status = "DISABLED"; current.lastUpdatedAt = this.clock.now(); current.statusDescription = this.kinesisDestinationDescription("DISABLED"); } }); return this.kinesisMutationResponse(table, destination);
  }

  async UpdateKinesisStreamingDestination(input: any): Promise<any> {
    const table = this.kinesisTable(input.TableName); const streamArn = this.kinesisStreamArn(input.StreamArn); const destination = table.kinesisStreamingDestinations[streamArn]; if (!destination) throw new AwsError("ResourceNotFoundException", "The specified Kinesis streaming destination was not found"); if (destination.status !== "ACTIVE") throw new AwsError("ResourceInUseException", "The Kinesis streaming destination is not active"); destination.precision = this.kinesisPrecision(input.UpdateKinesisStreamingConfiguration, destination.precision); destination.status = "UPDATING"; destination.lastUpdatedAt = this.clock.now(); destination.statusDescription = this.kinesisDestinationDescription("UPDATING"); await this.store.save(); this.scheduleTransition(() => { const current = table.kinesisStreamingDestinations[streamArn]; if (current) { current.status = "ACTIVE"; current.lastUpdatedAt = this.clock.now(); current.statusDescription = this.kinesisDestinationDescription("ACTIVE"); } }); return this.kinesisMutationResponse(table, destination, "UpdateKinesisStreamingConfiguration");
  }

  private contributorMetricKey(item: Item, schema: TableState["keySchema"]): string | undefined {
    const key = Object.fromEntries(schema.map(entry => [entry.AttributeName, item[entry.AttributeName]]).filter((entry): entry is [string, Item[string]] => entry[1] !== undefined)); if (Object.keys(key).length !== schema.length) return undefined; const value = canonicalJson(key); return value.length <= 900 ? value : `sha256:${createHash("sha256").update(value).digest("hex")}`;
  }

  private async publishContributorMetrics(table: TableState, items: Item[], metricName: "AccessFrequency" | "ThrottleFrequency", indexName?: string, throttled = false, includeWriteIndexes = false): Promise<void> {
    if (!this.telemetry || !items.length) return; const targets: Array<{ index?: DynamoIndexState; insight: DynamoContributorInsightsState }> = [];
    const add = (index?: DynamoIndexState) => { const insight = table.contributorInsights[index?.indexName ?? CONTRIBUTOR_TABLE_KEY]; if (insight?.status === "ENABLED" && (throttled || insight.mode === "ACCESSED_AND_THROTTLED_KEYS")) targets.push({ index, insight }); };
    if (indexName) add(table.globalSecondaryIndexes?.find(index => index.indexName === indexName)); else { add(); if (includeWriteIndexes) for (const index of table.globalSecondaryIndexes ?? []) add(index); }
    const at = this.clock.now(); await Promise.all(targets.flatMap(({ index }) => items.flatMap(item => { const key = this.contributorMetricKey(item, index?.keySchema ?? table.keySchema); if (!key) return []; return [this.telemetry!.publish({ namespace: CONTRIBUTOR_METRIC_NAMESPACE, metricName, dimensions: { TableName: table.name, ...(index ? { GlobalSecondaryIndexName: index.indexName } : {}), ContributorKey: key }, value: 1, unit: "Count", timestamp: at }).catch(() => undefined)]; })));
  }

  private restoreCreateInput(source: TableState, input: any): any {
    const billingMode = input.BillingModeOverride ?? source.billingMode; if (!["PROVISIONED", "PAY_PER_REQUEST"].includes(billingMode)) throw new AwsError("ValidationException", "Invalid BillingModeOverride");
    const indexInput = (index: DynamoIndexState) => ({ IndexName: index.indexName, KeySchema: clone(index.keySchema), Projection: clone(index.projection), ...(billingMode === "PROVISIONED" && index.provisionedThroughput ? { ProvisionedThroughput: { ReadCapacityUnits: index.provisionedThroughput.ReadCapacityUnits, WriteCapacityUnits: index.provisionedThroughput.WriteCapacityUnits } } : {}), ...(billingMode === "PAY_PER_REQUEST" && index.onDemandThroughput && Object.keys(index.onDemandThroughput).length ? { OnDemandThroughput: clone(index.onDemandThroughput) } : {}), ...(index.warmThroughput ? { WarmThroughput: { ReadUnitsPerSecond: index.warmThroughput.ReadUnitsPerSecond, WriteUnitsPerSecond: index.warmThroughput.WriteUnitsPerSecond } } : {}) });
    const globals = input.GlobalSecondaryIndexOverride ?? (source.globalSecondaryIndexes ?? []).map(indexInput); const locals = input.LocalSecondaryIndexOverride ?? (source.localSecondaryIndexes ?? []).map(indexInput); const existingGlobals = new Set((source.globalSecondaryIndexes ?? []).map(index => index.indexName)); const existingLocals = new Set((source.localSecondaryIndexes ?? []).map(index => index.indexName));
    if (!Array.isArray(globals) || globals.some((index: any) => !existingGlobals.has(index?.IndexName)) || !Array.isArray(locals) || locals.some((index: any) => !existingLocals.has(index?.IndexName))) throw new AwsError("ValidationException", "Secondary index overrides must reference indexes from the source table");
    const provisioned = input.ProvisionedThroughputOverride ?? source.provisionedThroughput; const onDemand = input.OnDemandThroughputOverride ?? source.onDemandThroughput; const sse = input.SSESpecificationOverride ?? (source.sse.sseType === "KMS" ? { Enabled: true, SSEType: "KMS", ...(source.sse.kmsMasterKeyId ? { KMSMasterKeyId: source.sse.kmsMasterKeyId } : {}) } : { Enabled: false });
    const usedAttributes = new Set([...source.keySchema, ...globals.flatMap((index: any) => index.KeySchema ?? []), ...locals.flatMap((index: any) => index.KeySchema ?? [])].map((key: any) => key.AttributeName));
    return { TableName: input.TargetTableName, AttributeDefinitions: clone(source.attributeDefinitions.filter(definition => usedAttributes.has(definition.AttributeName))), KeySchema: clone(source.keySchema), BillingMode: billingMode, ...(billingMode === "PROVISIONED" && provisioned ? { ProvisionedThroughput: { ReadCapacityUnits: provisioned.ReadCapacityUnits, WriteCapacityUnits: provisioned.WriteCapacityUnits } } : {}), ...(billingMode === "PAY_PER_REQUEST" && onDemand && Object.keys(onDemand).length ? { OnDemandThroughput: clone(onDemand) } : {}), ...(source.warmThroughput ? { WarmThroughput: { ReadUnitsPerSecond: source.warmThroughput.ReadUnitsPerSecond, WriteUnitsPerSecond: source.warmThroughput.WriteUnitsPerSecond } } : {}), ...(globals.length ? { GlobalSecondaryIndexes: clone(globals) } : {}), ...(locals.length ? { LocalSecondaryIndexes: clone(locals) } : {}), TableClass: source.tableClass, DeletionProtectionEnabled: false, SSESpecification: sse };
  }

  private async restoreTable(source: TableState, items: Record<string, Item>, input: any, summary: { sourceBackupArn?: string; sourceTableArn?: string; restoreDateTime: number }): Promise<any> {
    if (this.tables[input.TargetTableName]) throw new AwsError("TableAlreadyExistsException", "A target table with the specified name already exists");
    await this.CreateTable(this.restoreCreateInput(source, input)); const target = requireTable(this.store, this.region, input.TargetTableName); target.items = clone(items); target.tags = {}; target.timeToLive = { status: "DISABLED" }; target.autoScaling = undefined; target.pointInTimeRecovery = { status: "DISABLED", recoveryPeriodInDays: 35, sequence: 0 }; target.status = "CREATING"; for (const index of target.globalSecondaryIndexes ?? []) { index.indexStatus = "CREATING"; index.backfilling = true; } target.restoreSummary = { ...summary, restoreInProgress: true }; await this.store.save();
    this.transition(target, () => { if (target.restoreSummary) target.restoreSummary.restoreInProgress = false; for (const index of target.globalSecondaryIndexes ?? []) { index.indexStatus = "ACTIVE"; index.backfilling = false; } }); return { TableDescription: tableDescription(target, this.store) };
  }

  async RestoreTableFromBackup(input: any): Promise<any> {
    const backup = this.requireBackup(input.BackupArn); if (backup.backupStatus !== "AVAILABLE") throw new AwsError("BackupInUseException", "The backup is not available for restore"); const source = (await this.backupPersistence.readSnapshot(backup.snapshotHash)).table; return this.restoreTable(source, source.items, input, { sourceBackupArn: backup.backupArn, restoreDateTime: backup.createdAt });
  }

  async RestoreTableToPointInTime(input: any): Promise<any> {
    if (Boolean(input.SourceTableName) === Boolean(input.SourceTableArn)) throw new AwsError("ValidationException", "Specify exactly one of SourceTableName or SourceTableArn"); if (Boolean(input.UseLatestRestorableTime) === (input.RestoreDateTime !== undefined)) throw new AwsError("ValidationException", "Specify exactly one of UseLatestRestorableTime or RestoreDateTime");
    const source = this.requireBackupTable(input.SourceTableArn ?? input.SourceTableName); const pitr = source.pointInTimeRecovery; if (pitr.status !== "ENABLED" || pitr.enabledAt === undefined) throw new AwsError("PointInTimeRecoveryUnavailableException", "Point-in-time recovery is not enabled for the source table"); await this.backupPersistence.prunePitr(source, this.pitrTime());
    const earliest = pitr.earliestRestorableAt ?? pitr.enabledAt; const latest = this.pitrTime(); const requested = input.UseLatestRestorableTime ? latest : Math.floor(Number(input.RestoreDateTime) * 1000 / 1000) * 1000; if (!Number.isFinite(requested) || requested < earliest || requested > latest) throw new AwsError("InvalidRestoreTimeException", "RestoreDateTime must be between EarliestRestorableDateTime and LatestRestorableDateTime"); const items = await this.backupPersistence.itemsAt(source, requested); await this.store.save(); return this.restoreTable(source, items, input, { sourceTableArn: source.arn, restoreDateTime: requested });
  }

  private tableAutoScalingDescription(table: TableState): any {
    const auto = table.autoScaling ?? {}; const regions = new Set(Object.keys(auto.replicas ?? {})); if ((auto.provisionedWrite || Object.keys(auto.globalSecondaryIndexes ?? {}).length) && !regions.size) regions.add(this.region);
    const Replicas = [...regions].sort().map(RegionName => {
      const replica = auto.replicas?.[RegionName] ?? {}; const indexNames = new Set([...Object.keys(auto.globalSecondaryIndexes ?? {}), ...Object.keys(replica.globalSecondaryIndexes ?? {})]);
      return { RegionName, ReplicaStatus: "ACTIVE", ...(replica.provisionedRead ? { ReplicaProvisionedReadCapacityAutoScalingSettings: autoScalingDescription(replica.provisionedRead) } : {}), ...(auto.provisionedWrite ? { ReplicaProvisionedWriteCapacityAutoScalingSettings: autoScalingDescription(auto.provisionedWrite) } : {}), ...(indexNames.size ? { GlobalSecondaryIndexes: [...indexNames].sort().map(IndexName => ({ IndexName, IndexStatus: table.globalSecondaryIndexes?.find(index => index.indexName === IndexName)?.indexStatus ?? "ACTIVE", ...(replica.globalSecondaryIndexes?.[IndexName]?.provisionedRead ? { ProvisionedReadCapacityAutoScalingSettings: autoScalingDescription(replica.globalSecondaryIndexes[IndexName].provisionedRead) } : {}), ...(auto.globalSecondaryIndexes?.[IndexName]?.provisionedWrite ? { ProvisionedWriteCapacityAutoScalingSettings: autoScalingDescription(auto.globalSecondaryIndexes[IndexName].provisionedWrite) } : {}) })) } : {}) };
    });
    return { TableName: table.name, TableStatus: table.status, Replicas };
  }

  async DescribeTableReplicaAutoScaling(input: any): Promise<any> {
    const table = requireTableControl(this.store, this.region, input.TableName); return { TableAutoScalingDescription: this.tableAutoScalingDescription(table) };
  }

  async UpdateTableReplicaAutoScaling(input: any): Promise<any> {
    const table = requireTableControl(this.store, this.region, input.TableName); if (table.billingMode !== "PROVISIONED") throw new AwsError("ValidationException", "Auto scaling settings require PROVISIONED capacity mode");
    const hasUpdate = input.ProvisionedWriteCapacityAutoScalingUpdate !== undefined || input.GlobalSecondaryIndexUpdates !== undefined || input.ReplicaUpdates !== undefined; if (!hasUpdate) throw new AwsError("ValidationException", "No auto scaling updates were specified");
    const auto = clone(table.autoScaling ?? {}); auto.globalSecondaryIndexes ??= {}; auto.replicas ??= {};
    if (input.ProvisionedWriteCapacityAutoScalingUpdate !== undefined) auto.provisionedWrite = validateAutoScalingSetting(input.ProvisionedWriteCapacityAutoScalingUpdate);
    if (input.GlobalSecondaryIndexUpdates !== undefined) {
      if (!Array.isArray(input.GlobalSecondaryIndexUpdates) || !input.GlobalSecondaryIndexUpdates.length || new Set(input.GlobalSecondaryIndexUpdates.map((update: any) => update?.IndexName)).size !== input.GlobalSecondaryIndexUpdates.length) throw new AwsError("ValidationException", "GlobalSecondaryIndexUpdates must contain unique index updates");
      for (const update of input.GlobalSecondaryIndexUpdates) { if (!table.globalSecondaryIndexes?.some(index => index.indexName === update.IndexName) || !update.ProvisionedWriteCapacityAutoScalingUpdate) throw new AwsError("ValidationException", "A write auto scaling update for an existing global secondary index is required"); (auto.globalSecondaryIndexes[update.IndexName] ??= {}).provisionedWrite = validateAutoScalingSetting(update.ProvisionedWriteCapacityAutoScalingUpdate); }
    }
    if (input.ReplicaUpdates !== undefined) {
      if (!Array.isArray(input.ReplicaUpdates) || !input.ReplicaUpdates.length || new Set(input.ReplicaUpdates.map((update: any) => update?.RegionName)).size !== input.ReplicaUpdates.length) throw new AwsError("ValidationException", "ReplicaUpdates must contain unique region updates");
      for (const update of input.ReplicaUpdates) {
        if (typeof update.RegionName !== "string" || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(update.RegionName)) throw new AwsError("ValidationException", "Invalid replica RegionName"); const replica = auto.replicas[update.RegionName] ??= {};
        if (update.ReplicaProvisionedReadCapacityAutoScalingUpdate !== undefined) replica.provisionedRead = validateAutoScalingSetting(update.ReplicaProvisionedReadCapacityAutoScalingUpdate);
        if (update.ReplicaGlobalSecondaryIndexUpdates !== undefined) { if (!Array.isArray(update.ReplicaGlobalSecondaryIndexUpdates) || !update.ReplicaGlobalSecondaryIndexUpdates.length) throw new AwsError("ValidationException", "ReplicaGlobalSecondaryIndexUpdates must not be empty"); replica.globalSecondaryIndexes ??= {}; for (const indexUpdate of update.ReplicaGlobalSecondaryIndexUpdates) { if (!table.globalSecondaryIndexes?.some(index => index.indexName === indexUpdate.IndexName) || !indexUpdate.ProvisionedReadCapacityAutoScalingUpdate) throw new AwsError("ValidationException", "A read auto scaling update for an existing global secondary index is required"); (replica.globalSecondaryIndexes[indexUpdate.IndexName] ??= {}).provisionedRead = validateAutoScalingSetting(indexUpdate.ProvisionedReadCapacityAutoScalingUpdate); } }
        if (update.ReplicaProvisionedReadCapacityAutoScalingUpdate === undefined && update.ReplicaGlobalSecondaryIndexUpdates === undefined) throw new AwsError("ValidationException", "Replica update has no settings");
      }
    }
    auto.lastUpdatedAt = this.clock.now(); table.autoScaling = auto; await this.store.save(); return { TableAutoScalingDescription: this.tableAutoScalingDescription(table) };
  }

  async UpdateTable(input: any): Promise<any> {
    const table = requireTableControl(this.store, this.region, input.TableName);
    if (table.status !== "ACTIVE") throw new AwsError("ResourceInUseException", "Table is being updated");
    const updates = input.GlobalSecondaryIndexUpdates ?? [];
    if (!Array.isArray(updates) || updates.length > 1) throw new AwsError("ValidationException", "Only one global secondary index may be created, updated, or deleted per UpdateTable call");
    const fields = ["BillingMode", "ProvisionedThroughput", "OnDemandThroughput", "WarmThroughput", "TableClass", "DeletionProtectionEnabled", "SSESpecification", "StreamSpecification", "ReplicaUpdates"];
    if (!updates.length && !fields.some(field => input[field] !== undefined)) throw new AwsError("ValidationException", "No updates were specified");
    if (input.StreamSpecification !== undefined) this.validateStreamSpecification(input.StreamSpecification);
    if (input.ReplicaUpdates !== undefined) {
      if (updates.length || fields.filter(field => field !== "ReplicaUpdates").some(field => input[field] !== undefined)) throw new AwsError("ValidationException", "ReplicaUpdates cannot be combined with another table update");
      return this.updateCurrentGlobalReplicas(table, input);
    }
    if (input.GlobalTableWitnessUpdates !== undefined || input.MultiRegionConsistency !== undefined || input.GlobalTableSettingsReplicationMode !== undefined) throw new AwsError("ValidationException", "MRSC witnesses and multi-account settings replication require a ReplicaUpdates create and remain dependency-blocked locally");
    const now = this.clock.now(); const next = clone(table); next.status = "UPDATING"; const finishes: Array<() => void> = [];
    if (input.BillingMode !== undefined) {
      if (!["PROVISIONED", "PAY_PER_REQUEST"].includes(input.BillingMode)) throw new AwsError("ValidationException", "Invalid BillingMode");
      if (input.BillingMode === "PROVISIONED") { if (input.OnDemandThroughput !== undefined) throw new AwsError("ValidationException", "OnDemandThroughput is only valid in PAY_PER_REQUEST capacity mode"); next.provisionedThroughput = updateThroughput(next.provisionedThroughput, input.ProvisionedThroughput, now); delete next.onDemandThroughput; }
      else { if (input.ProvisionedThroughput !== undefined) throw new AwsError("ValidationException", "ProvisionedThroughput is not valid in PAY_PER_REQUEST capacity mode"); next.billingModeLastUpdatedAt = now; }
      next.billingMode = input.BillingMode;
    } else if (input.ProvisionedThroughput !== undefined) {
      if (next.billingMode !== "PROVISIONED") throw new AwsError("ValidationException", "ProvisionedThroughput is only valid in PROVISIONED capacity mode"); next.provisionedThroughput = updateThroughput(next.provisionedThroughput, input.ProvisionedThroughput, now);
    }
    if (input.OnDemandThroughput !== undefined) {
      if (next.billingMode !== "PAY_PER_REQUEST") throw new AwsError("ValidationException", "OnDemandThroughput is only valid in PAY_PER_REQUEST capacity mode"); const changed = validateOnDemandThroughput(input.OnDemandThroughput, true)!; const merged = { ...(next.onDemandThroughput ?? {}), ...changed }; for (const field of ["MaxReadRequestUnits", "MaxWriteRequestUnits"] as const) if (input.OnDemandThroughput[field] === -1) delete merged[field]; next.onDemandThroughput = merged;
    }
    if (input.WarmThroughput !== undefined) { next.warmThroughput = validateWarmThroughput(input.WarmThroughput, now, "UPDATING"); finishes.push(() => { if (next.warmThroughput) next.warmThroughput.status = "ACTIVE"; }); }
    if (input.TableClass !== undefined) { if (!["STANDARD", "STANDARD_INFREQUENT_ACCESS"].includes(input.TableClass)) throw new AwsError("ValidationException", "Invalid TableClass"); if (next.tableClass !== input.TableClass) next.tableClassLastUpdatedAt = now; next.tableClass = input.TableClass; }
    if (input.DeletionProtectionEnabled !== undefined) { if (typeof input.DeletionProtectionEnabled !== "boolean") throw new AwsError("ValidationException", "DeletionProtectionEnabled must be a boolean"); next.deletionProtectionEnabled = input.DeletionProtectionEnabled; }
    if (input.SSESpecification !== undefined) next.sse = validateSse(input.SSESpecification, now);
    if (updates.length) {
      const update = updates[0]; const kinds = ["Create", "Update", "Delete"].filter(kind => update[kind]);
      if (kinds.length !== 1) throw new AwsError("ValidationException", "Each index update must contain exactly one action");
      if (update.Create) {
        const existingGlobal = (next.globalSecondaryIndexes ?? []).map(index => ({ IndexName: index.indexName, KeySchema: index.keySchema, Projection: index.projection, ...(index.provisionedThroughput ? { ProvisionedThroughput: index.provisionedThroughput } : {}), ...(index.onDemandThroughput ? { OnDemandThroughput: index.onDemandThroughput } : {}), ...(index.warmThroughput ? { WarmThroughput: index.warmThroughput } : {}) }));
        const definitionInput = { ...input, BillingMode: next.billingMode, KeySchema: next.keySchema, AttributeDefinitions: [...next.attributeDefinitions, ...(input.AttributeDefinitions ?? [])].filter((value, index, array) => array.findIndex(item => item.AttributeName === value.AttributeName) === index), GlobalSecondaryIndexes: [...existingGlobal, update.Create], LocalSecondaryIndexes: next.localSecondaryIndexes?.map(index => ({ IndexName: index.indexName, KeySchema: index.keySchema, Projection: index.projection })) ?? [] };
        const created = validateIndexDefinitions(definitionInput, now).global.find(index => index.indexName === update.Create.IndexName)!;
        if ([...(next.localSecondaryIndexes ?? []), ...(next.globalSecondaryIndexes ?? [])].some(index => index.indexName === created.indexName)) throw new AwsError("ValidationException", "Index already exists");
        created.backfilling = true; next.globalSecondaryIndexes ??= []; next.globalSecondaryIndexes.push(created); next.attributeDefinitions = definitionInput.AttributeDefinitions;
        finishes.push(() => { created.indexStatus = "ACTIVE"; created.backfilling = false; if (created.warmThroughput) created.warmThroughput.status = "ACTIVE"; });
      } else {
        const request = update.Update ?? update.Delete; const index = next.globalSecondaryIndexes?.find(candidate => candidate.indexName === request.IndexName);
        if (!index) throw new AwsError("ValidationException", "The table does not have the specified index");
        if (update.Update) {
          if (request.ProvisionedThroughput === undefined && request.OnDemandThroughput === undefined && request.WarmThroughput === undefined) throw new AwsError("ValidationException", "An index capacity update is required");
          if (request.ProvisionedThroughput !== undefined) { if (next.billingMode !== "PROVISIONED") throw new AwsError("ValidationException", "ProvisionedThroughput is only valid in PROVISIONED capacity mode"); index.provisionedThroughput = updateThroughput(index.provisionedThroughput, request.ProvisionedThroughput, now); }
          if (request.OnDemandThroughput !== undefined) { if (next.billingMode !== "PAY_PER_REQUEST") throw new AwsError("ValidationException", "OnDemandThroughput is only valid in PAY_PER_REQUEST capacity mode"); const changed = validateOnDemandThroughput(request.OnDemandThroughput, true)!; const merged = { ...(index.onDemandThroughput ?? {}), ...changed }; for (const field of ["MaxReadRequestUnits", "MaxWriteRequestUnits"] as const) if (request.OnDemandThroughput[field] === -1) delete merged[field]; index.onDemandThroughput = merged; }
          if (request.WarmThroughput !== undefined) index.warmThroughput = validateWarmThroughput(request.WarmThroughput, now, "UPDATING");
          index.indexStatus = "UPDATING"; finishes.push(() => { index.indexStatus = "ACTIVE"; if (index.warmThroughput) index.warmThroughput.status = "ACTIVE"; });
        } else { index.indexStatus = "DELETING"; finishes.push(() => { next.globalSecondaryIndexes = next.globalSecondaryIndexes?.filter(candidate => candidate !== index); delete next.contributorInsights[index.indexName]; }); }
      }
    }
    if (input.StreamSpecification !== undefined) { const configured = this.configureStream(next, input.StreamSpecification); if (configured.retired) finishes.push(() => { configured.retired!.streamStatus = "DISABLED"; }); if (configured.enabled) finishes.push(() => { configured.enabled!.streamStatus = "ENABLED"; }); }
    this.tables[next.name] = next; await this.store.save(); this.transition(next, () => finishes.forEach(finish => finish())); return { TableDescription: tableDescription(next, this.store) };
  }

  async DescribeTable(input: any): Promise<any> { return { Table: tableDescription(requireTableControl(this.store, this.region, input.TableName), this.store) }; }

  async ListTables(input: any): Promise<any> {
    let names = Object.keys(this.tables).sort();
    if (input.ExclusiveStartTableName) names = names.slice(names.indexOf(input.ExclusiveStartTableName) + 1);
    const limit = input.Limit ?? names.length;
    return { TableNames: names.slice(0, limit), ...(names.length > limit ? { LastEvaluatedTableName: names[limit - 1] } : {}) };
  }

  async DeleteTable(input: any): Promise<any> {
    const table = requireTableControl(this.store, this.region, input.TableName); if (table.deletionProtectionEnabled) throw new AwsError("ValidationException", "Resource cannot be deleted because deletion protection is enabled. Disable deletion protection first.");
    if (table.globalTable) { const remaining = table.globalTable.replicaRegions.filter(region => region !== this.region); for (const region of remaining) { const replica = this.store.regionState(region).tables[table.name]; if (!replica?.globalTable) continue; if (remaining.length === 1) delete replica.globalTable; else replica.globalTable.replicaRegions = [...remaining]; } }
    this.retireStream(table, "DISABLED");
    delete this.resourcePolicies[table.arn]; delete this.resourcePolicyMutationTimes[table.arn];
    delete this.tables[table.name];
    await this.store.save();
    return { TableDescription: { ...tableDescription(table, this.store), TableStatus: "DELETING" } };
  }

  async PutItem(input: any, attempt?: ServiceIntegrationAttempt): Promise<any> {
    if (!attempt?.attemptId) attempt = undefined;
    const prior = attempt ? this.reconcileIntegrationAttempt(attempt) : undefined; if (prior) return structuredClone(prior.output);
    validateExpressionRequest(input);
    validateReturnItemCollectionMetrics(input.ReturnItemCollectionMetrics);
    const table = requireTable(this.store, this.region, input.TableName); assertDataPlaneAvailable(table);
    validateItem(table, input.Item);
    validateIndexAttributes(table, input.Item);
    const key = stableItemKey(table, input.Item);
    const previous = table.items[key];
    const condition = parseConditionExpression(input.ConditionExpression, expressionContext(input));
    if (!evaluateCondition(condition, previous ?? {}, expressionContext(input))) throw new AwsError("ConditionalCheckFailedException", "The conditional request failed");
    const writeUnits = this.itemWriteUnits(input.Item); const charge = emptyCapacity(table.name); addCapacityUnits(charge, "table", 0, writeUnits); writeIndexCapacity(charge, table, previous, input.Item, item => this.itemWriteUnits(item)); this.takeCapacityCharge(table, "write", charge, [input.Item]); table.items[key] = clone(input.Item); await this.journalChanges(table, [{ key, item: input.Item }]); await this.emitStreamRecord(table, { oldImage: previous, newImage: input.Item }); await this.replicateGlobalChanges(table, [{ key, item: input.Item }]); await this.publishContributorMetrics(table, [input.Item], "AccessFrequency", undefined, false, true);
    const output = { ...(input.ReturnValues === "ALL_OLD" && previous ? { Attributes: clone(previous) } : {}), ...(formatConsumedCapacity(input.ReturnConsumedCapacity, charge) ? { ConsumedCapacity: formatConsumedCapacity(input.ReturnConsumedCapacity, charge) } : {}), ...itemCollectionMetricsResponse(input.ReturnItemCollectionMetrics, [{ table, items: [input.Item] }], "single") }; if (attempt) this.acceptIntegrationAttempt(attempt, output); await this.store.save(); return output;
  }

  async GetItem(input: any, attempt?: ServiceIntegrationAttempt): Promise<any> {
    if (!attempt?.attemptId) attempt = undefined;
    const prior = attempt ? this.reconcileIntegrationAttempt(attempt) : undefined; if (prior) return structuredClone(prior.output);
    validateExpressionRequest(input);
    const table = requireTable(this.store, this.region, input.TableName); assertDataPlaneAvailable(table);
    validateKey(table, input.Key);
    const item = table.items[stableItemKey(table, input.Key)]; const readUnits = this.itemReadUnits(item, input.ConsistentRead === true); this.takeCapacity(table, "read", readUnits, "table", [input.Key]); await this.publishContributorMetrics(table, [item ?? input.Key], "AccessFrequency");
    const output = { ...(item ? { Item: projectItem(item, input.ProjectionExpression, expressionContext(input)) } : {}), ...capacity(input, table.name, readUnits, 0) }; if (attempt) { this.acceptIntegrationAttempt(attempt, output); await this.store.save(); } return output;
  }

  async DeleteItem(input: any, attempt?: ServiceIntegrationAttempt): Promise<any> {
    if (!attempt?.attemptId) attempt = undefined;
    const prior = attempt ? this.reconcileIntegrationAttempt(attempt) : undefined; if (prior) return structuredClone(prior.output);
    validateExpressionRequest(input);
    validateReturnItemCollectionMetrics(input.ReturnItemCollectionMetrics);
    const table = requireTable(this.store, this.region, input.TableName); assertDataPlaneAvailable(table);
    validateKey(table, input.Key);
    const key = stableItemKey(table, input.Key);
    const previous = table.items[key];
    const condition = parseConditionExpression(input.ConditionExpression, expressionContext(input));
    if (!evaluateCondition(condition, previous ?? {}, expressionContext(input))) throw new AwsError("ConditionalCheckFailedException", "The conditional request failed");
    const writeUnits = this.itemWriteUnits(previous ?? input.Key); const charge = emptyCapacity(table.name); addCapacityUnits(charge, "table", 0, writeUnits); writeIndexCapacity(charge, table, previous, undefined, item => this.itemWriteUnits(item)); this.takeCapacityCharge(table, "write", charge, [previous ?? input.Key]); delete table.items[key]; await this.journalChanges(table, [{ key }]); if (previous) await this.emitStreamRecord(table, { oldImage: previous }); await this.replicateGlobalChanges(table, [{ key }]); await this.publishContributorMetrics(table, [previous ?? input.Key], "AccessFrequency", undefined, false, true);
    const output = { ...(input.ReturnValues === "ALL_OLD" && previous ? { Attributes: clone(previous) } : {}), ...(formatConsumedCapacity(input.ReturnConsumedCapacity, charge) ? { ConsumedCapacity: formatConsumedCapacity(input.ReturnConsumedCapacity, charge) } : {}), ...itemCollectionMetricsResponse(input.ReturnItemCollectionMetrics, [{ table, items: [previous ?? input.Key] }], "single") }; if (attempt) this.acceptIntegrationAttempt(attempt, output); await this.store.save(); return output;
  }

  async UpdateItem(input: any, attempt?: ServiceIntegrationAttempt): Promise<any> {
    if (!attempt?.attemptId) attempt = undefined;
    const prior = attempt ? this.reconcileIntegrationAttempt(attempt) : undefined; if (prior) return structuredClone(prior.output);
    validateExpressionRequest(input);
    validateReturnItemCollectionMetrics(input.ReturnItemCollectionMetrics);
    const table = requireTable(this.store, this.region, input.TableName); assertDataPlaneAvailable(table);
    validateKey(table, input.Key);
    const key = stableItemKey(table, input.Key);
    const existing = table.items[key]; const previous = clone(existing ?? input.Key);
    const condition = parseConditionExpression(input.ConditionExpression, expressionContext(input));
    if (!evaluateCondition(condition, previous, expressionContext(input))) throw new AwsError("ConditionalCheckFailedException", "The conditional request failed");
    if (!input.UpdateExpression) throw new AwsError("ValidationException", "UpdateExpression is required");
    const update = applyUpdateExpression(previous, String(input.UpdateExpression), expressionContext(input));
    validateItem(table, update.item);
    validateIndexAttributes(table, update.item);
    if (stableItemKey(table, update.item) !== key) throw new AwsError("ValidationException", "One or more parameter values were invalid: Cannot update attribute that is part of the key");
    const writeUnits = this.itemWriteUnits(update.item); const charge = emptyCapacity(table.name); addCapacityUnits(charge, "table", 0, writeUnits); writeIndexCapacity(charge, table, existing, update.item, item => this.itemWriteUnits(item)); this.takeCapacityCharge(table, "write", charge, [update.item]); table.items[key] = update.item; await this.journalChanges(table, [{ key, item: update.item }]); await this.emitStreamRecord(table, { oldImage: existing, newImage: update.item }); await this.replicateGlobalChanges(table, [{ key, item: update.item }]); await this.publishContributorMetrics(table, [update.item], "AccessFrequency", undefined, false, true);
    const attributes = input.ReturnValues === "ALL_OLD" ? previous : input.ReturnValues === "ALL_NEW" ? update.item : input.ReturnValues === "UPDATED_OLD" ? update.oldValues : input.ReturnValues === "UPDATED_NEW" ? update.newValues : undefined;
    const output = { ...(attributes && Object.keys(attributes).length ? { Attributes: clone(attributes) } : {}), ...(formatConsumedCapacity(input.ReturnConsumedCapacity, charge) ? { ConsumedCapacity: formatConsumedCapacity(input.ReturnConsumedCapacity, charge) } : {}), ...itemCollectionMetricsResponse(input.ReturnItemCollectionMetrics, [{ table, items: [update.item] }], "single") }; if (attempt) this.acceptIntegrationAttempt(attempt, output); await this.store.save(); return output;
  }

  private async readMany(input: any, query: boolean, internal?: { partiqlOrder?: Array<{ path: Array<string | number>; descending: boolean }>; partiqlPartitions?: { name: string; values: any[] } }): Promise<any> {
    validateExpressionRequest(input);
    const table = requireTable(this.store, this.region, input.TableName); assertDataPlaneAvailable(table);
    const index = input.IndexName ? [...(table.localSecondaryIndexes ?? []), ...(table.globalSecondaryIndexes ?? [])].find(candidate => candidate.indexName === input.IndexName) : undefined;
    if (input.IndexName && !index) throw new AwsError("ValidationException", "The table does not have the specified index");
    const isGlobal = Boolean(index && table.globalSecondaryIndexes?.includes(index));
    const isLocal = Boolean(index && table.localSecondaryIndexes?.includes(index));
    if (isGlobal) assertGsiQueryable(index!);
    if (isGlobal && input.ConsistentRead === true) throw new AwsError("ValidationException", "Consistent reads are not supported on global secondary indexes");
    const segmented = input.Segment !== undefined || input.TotalSegments !== undefined;
    if (query && segmented) throw new AwsError("ValidationException", "Segment and TotalSegments are supported only for Scan");
    if (!query && segmented) {
      if (input.Segment === undefined || input.TotalSegments === undefined) throw new AwsError("ValidationException", "Segment and TotalSegments must be specified together");
      if (!Number.isInteger(input.TotalSegments) || input.TotalSegments < 1 || input.TotalSegments > 1_000_000) throw new AwsError("ValidationException", "TotalSegments must be an integer between 1 and 1000000");
      if (!Number.isInteger(input.Segment) || input.Segment < 0 || input.Segment >= input.TotalSegments) throw new AwsError("ValidationException", "Segment must be an integer between 0 and TotalSegments minus 1");
    }
    const schemaTable = index ? { ...table, keySchema: index.keySchema } : table;
    if (input.Select === "SPECIFIC_ATTRIBUTES" && !input.ProjectionExpression) throw new AwsError("ValidationException", "Select type SPECIFIC_ATTRIBUTES requires ProjectionExpression");
    if (input.Select && input.Select !== "SPECIFIC_ATTRIBUTES" && input.ProjectionExpression) throw new AwsError("ValidationException", "Select and ProjectionExpression can only be used together when Select is SPECIFIC_ATTRIBUTES");
    const context = expressionContext(input);
    const keyCondition = query ? parseConditionExpression(input.KeyConditionExpression, context) : undefined;
    if (query) validateKeyCondition(keyCondition!, schemaTable);
    const filter = parseConditionExpression(input.FilterExpression, context);
    const projectionPaths = parseProjectionExpression(input.ProjectionExpression, context);
    const projectedNames = index ? new Set([...table.keySchema, ...index.keySchema].map(key => key.AttributeName)) : undefined; for (const name of index?.projection.NonKeyAttributes ?? []) projectedNames!.add(name);
    const filterNames = new Set(conditionPaths(filter).map(path => path[0]).filter((name): name is string => typeof name === "string")); const filterNeedsBase = Boolean(index && index.projection.ProjectionType !== "ALL" && [...filterNames].some(name => !projectedNames!.has(name)));
    const projectionNeedsBase = Boolean(index && index.projection.ProjectionType !== "ALL" && projectionPaths.some(path => typeof path[0] === "string" && !projectedNames!.has(path[0])));
    if (isGlobal && filterNeedsBase) throw new AwsError("ValidationException", "One or more parameter values were invalid: FilterExpression contains an attribute that is not projected into the index");
    const compareKeys = (left: Item, right: Item): number => {
      for (const schema of (index?.keySchema ?? table.keySchema)) { const result = compareAttributeValues(left[schema.AttributeName], right[schema.AttributeName]); if (result) return result; }
      for (const schema of table.keySchema) { const result = compareAttributeValues(left[schema.AttributeName], right[schema.AttributeName]); if (result) return result; }
      return 0;
    };
    let items = index ? indexItems(table, index) : Object.values(table.items);
    if (internal?.partiqlPartitions) items = items.filter(item => internal.partiqlPartitions!.values.some(value => equalAttributeValues(item[internal.partiqlPartitions!.name], value)));
    if (!query && segmented && input.TotalSegments > 1) { const hashName = schemaTable.keySchema.find(key => key.KeyType === "HASH")!.AttributeName; items = items.filter(item => createHash("sha256").update(JSON.stringify(item[hashName])).digest().readUInt32BE(0) % input.TotalSegments === input.Segment); }
    if (query) items = items.filter(item => evaluateCondition(keyCondition, item, context));
    const partiqlOrder = internal?.partiqlOrder;
    const compareReadOrder = partiqlOrder?.length ? (left: Item, right: Item) => {
      for (const order of partiqlOrder) { const name = order.path[0]; const result = typeof name === "string" ? compareAttributeValues(left[name], right[name]) : undefined; if (result) return order.descending ? -result : result; }
      return compareKeys(left, right);
    } : (left: Item, right: Item) => { const result = compareKeys(left, right); return input.ScanIndexForward === false ? -result : result; };
    items.sort(compareReadOrder);
    if (input.ExclusiveStartKey) {
      if (index) {
        const required = new Set([...table.keySchema, ...index.keySchema].map(key => key.AttributeName));
        if (Object.keys(input.ExclusiveStartKey).length !== required.size || [...required].some(name => !input.ExclusiveStartKey[name])) throw new AwsError("ValidationException", "The provided starting key is invalid");
      } else validateKey(table, input.ExclusiveStartKey);
      const keyNames = [...new Set([...(index?.keySchema ?? []), ...table.keySchema].map(key => key.AttributeName))];
      const start = items.findIndex(item => keyNames.every(name => equalAttributeValues(item[name], input.ExclusiveStartKey[name])));
      if (start >= 0) items = items.slice(start + 1);
      else { const after = items.findIndex(item => compareReadOrder(item, input.ExclusiveStartKey) > 0); items = after >= 0 ? items.slice(after) : []; }
    }
    if (input.Limit !== undefined && (!Number.isInteger(input.Limit) || input.Limit <= 0)) {
      throw new AwsError("ValidationException", "Limit must be greater than or equal to 1");
    }
    const limit = input.Limit ?? Number.POSITIVE_INFINITY;
    const returnsBaseAttributes = Boolean(isLocal && (projectionNeedsBase || (input.Select === "ALL_ATTRIBUTES" && index!.projection.ProjectionType !== "ALL")));
    const readsBaseTable = Boolean(filterNeedsBase || returnsBaseAttributes);
    const processedItem = (item: Item): Item => index && !readsBaseTable ? projectedIndexItem(table, index, item) : item;
    const outputItem = (item: Item): Item => index && !returnsBaseAttributes ? projectedIndexItem(table, index, item) : item;
    const evaluated: Item[] = []; let processedBytes = 0;
    for (const item of items) {
      if (evaluated.length >= limit) break;
      const size = Buffer.byteLength(JSON.stringify(processedItem(item)));
      if (processedBytes + size > DYNAMODB_READ_PAGE_BYTES) break;
      evaluated.push(item); processedBytes += size;
    }
    const matched = evaluated.filter(item => evaluateCondition(filter, processedItem(item), context));
    if (isGlobal && input.Select === "ALL_ATTRIBUTES" && index!.projection.ProjectionType !== "ALL") throw new AwsError("ValidationException", "ALL_ATTRIBUTES is not supported for this index projection");
    if (isGlobal && projectionNeedsBase) { const unavailable = projectionPaths.find(path => typeof path[0] === "string" && !projectedNames!.has(path[0]))![0]; throw new AwsError("ValidationException", `Attribute ${unavailable} is not projected into the index`); }
    const projected = input.Select === "COUNT" ? undefined : matched.map(item => projectItem(outputItem(item), input.ProjectionExpression, context));
    const charge = emptyCapacity(table.name); const consistent = input.ConsistentRead === true;
    if (index) {
      const indexReadUnits = evaluated.reduce((sum, item) => sum + this.itemReadUnits(projectedIndexItem(table, index, item), consistent), 0) || this.itemReadUnits(undefined, consistent);
      addCapacityUnits(charge, isLocal ? { local: index.indexName } : { global: index.indexName }, indexReadUnits, 0);
      if (readsBaseTable && evaluated.length) addCapacityUnits(charge, "table", evaluated.reduce((sum, item) => sum + this.itemReadUnits(item, consistent), 0), 0);
    } else addCapacityUnits(charge, "table", evaluated.reduce((sum, item) => sum + this.itemReadUnits(item, consistent), 0) || this.itemReadUnits(undefined, consistent), 0);
    this.takeCapacityCharge(table, "read", charge, evaluated); await this.publishContributorMetrics(table, evaluated, "AccessFrequency", index?.indexName);
    const consumedCapacity = formatConsumedCapacity(input.ReturnConsumedCapacity, charge);
    return { ...(projected ? { Items: projected } : {}), Count: matched.length, ScannedCount: evaluated.length, ...(items.length > evaluated.length && evaluated.length ? { LastEvaluatedKey: index ? indexKey(table, index, evaluated.at(-1)!) : keyFromItem(table, evaluated.at(-1)!) } : {}), ...(consumedCapacity ? { ConsumedCapacity: consumedCapacity } : {}) };
  }

  async Scan(input: any): Promise<any> { return this.readMany(input, false); }
  async Query(input: any): Promise<any> {
    if (!input.KeyConditionExpression) throw new AwsError("ValidationException", "KeyConditionExpression is required");
    return this.readMany(input, true);
  }

  private validatePartiqlOptions(input: any, plan?: PartiqlPlan): void {
    if (input.ReturnConsumedCapacity !== undefined && !["INDEXES", "TOTAL", "NONE"].includes(input.ReturnConsumedCapacity)) throw new AwsError("ValidationException", "ReturnConsumedCapacity must be INDEXES, TOTAL, or NONE");
    if (input.ReturnValuesOnConditionCheckFailure !== undefined && !["ALL_OLD", "NONE"].includes(input.ReturnValuesOnConditionCheckFailure)) throw new AwsError("ValidationException", "ReturnValuesOnConditionCheckFailure must be ALL_OLD or NONE");
    if (input.Limit !== undefined && (!Number.isInteger(input.Limit) || input.Limit < 1)) throw new AwsError("ValidationException", "Limit must be greater than or equal to 1");
    if (input.ConsistentRead !== undefined && typeof input.ConsistentRead !== "boolean") throw new AwsError("ValidationException", "ConsistentRead must be a boolean");
    if (input.NextToken !== undefined && (typeof input.NextToken !== "string" || input.NextToken.length < 1 || input.NextToken.length > 32768)) throw new AwsError("ValidationException", "NextToken must contain between 1 and 32768 characters");
    if (plan && plan.kind !== "select" && (input.ConsistentRead !== undefined || input.Limit !== undefined || input.NextToken !== undefined)) throw new AwsError("ValidationException", "ConsistentRead, Limit, and NextToken are supported only for SELECT statements");
    if (plan?.kind === "select" && input.ReturnValuesOnConditionCheckFailure !== undefined) throw new AwsError("ValidationException", "ReturnValuesOnConditionCheckFailure is supported only for write statements");
  }

  private partiqlKey(plan: PartiqlPlan, table = requireTable(this.store, this.region, plan.tableName)): Item {
    const key: Item = {}; for (const schema of table.keySchema) { const value = plan.keyEqualities[schema.AttributeName]; if (!value) throw new AwsError("ValidationException", "The WHERE clause must contain equality conditions for every primary key attribute"); key[schema.AttributeName] = clone(value); }
    validateKey(table, key); return key;
  }

  private partiqlKeyOnly(plan: PartiqlPlan, table: TableState): boolean { return plan.conditionIsEqualityOnly && Object.keys(plan.keyEqualities).length === table.keySchema.length && table.keySchema.every(schema => plan.keyEqualities[schema.AttributeName]); }

  private conditionWithExistence(plan: PartiqlPlan, table: TableState): { ConditionExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues?: Record<string, any> } {
    const names = clone(plan.expressionAttributeNames ?? {}); let placeholder = "#partiql_exists"; while (names[placeholder]) placeholder += "_"; names[placeholder] = table.keySchema.find(key => key.KeyType === "HASH")!.AttributeName;
    return { ConditionExpression: `attribute_exists(${placeholder})${plan.conditionExpression ? ` AND (${plan.conditionExpression})` : ""}`, ExpressionAttributeNames: names, ...(plan.expressionAttributeValues ? { ExpressionAttributeValues: clone(plan.expressionAttributeValues) } : {}) };
  }

  private async executePartiqlPlan(plan: PartiqlPlan, input: any): Promise<any> {
    const table = requireTable(this.store, this.region, plan.tableName); assertDataPlaneAvailable(table); this.validatePartiqlOptions(input, plan);
    if (plan.kind === "select") {
      const index = plan.indexName ? [...(table.localSecondaryIndexes ?? []), ...(table.globalSecondaryIndexes ?? [])].find(candidate => candidate.indexName === plan.indexName) : undefined;
      if (plan.indexName && !index) throw new AwsError("ResourceNotFoundException", `Requested resource not found: Index: ${plan.indexName} not found`);
      const schema = index?.keySchema ?? table.keySchema; const partition = schema.find(key => key.KeyType === "HASH")!.AttributeName;
      const computedProjection = Boolean(plan.projection && !plan.projectionExpression); const globalIndex = Boolean(index && table.globalSecondaryIndexes?.includes(index)); const localIndex = Boolean(index && table.localSecondaryIndexes?.includes(index));
      if (globalIndex) assertGsiQueryable(index!);
      if (globalIndex && computedProjection && index!.projection.ProjectionType !== "ALL") { const allowed = new Set([...table.keySchema, ...index!.keySchema].map(key => key.AttributeName)); for (const name of index!.projection.NonKeyAttributes ?? []) allowed.add(name); const unavailable = plan.topLevelAttributes.find(name => !allowed.has(name)); if (unavailable) throw new AwsError("ValidationException", `Attribute ${unavailable} is not projected into the index`); }
      for (const predicate of plan.inPredicates) if (predicate.path.length === 1 && predicate.path[0] === partition && predicate.optionCount > 50) throw new AwsError("ValidationException", "IN on a partition key supports at most 50 values");
      for (const order of plan.order ?? []) if (order.path.length !== 1 || !schema.some(key => key.AttributeName === order.path[0])) throw new AwsError("ValidationException", "ORDER BY must reference table or index key attributes");
      const access = classifyPartiqlAccess(plan, schema, table.keySchema);
      const signature = createHash("sha256").update(canonicalJson({ region: this.region, tableArn: table.arn, tableCreatedAt: table.createdAt, Statement: input.Statement, Parameters: input.Parameters, ConsistentRead: input.ConsistentRead, Limit: input.Limit })).digest("hex");
      let cursor: { signature: string; key: Item; expiresAt: number } | undefined;
      if (input.NextToken) try { const decoded = this.partiqlTokens.decode<{ signature: string; key: Item; expiresAt: number }>("ExecuteStatement", input.NextToken); if (decoded.signature !== signature || !Number.isFinite(decoded.expiresAt) || decoded.expiresAt <= this.clock.now()) throw new Error(); cursor = decoded; } catch { throw new AwsError("ValidationException", "NextToken is invalid or does not match this statement"); }
      const partitionIn = access === "partition-in"; const limits = [input.Limit, partitionIn ? 10 : undefined].filter((value): value is number => value !== undefined); const pageLimit = limits.length ? Math.min(...limits) : undefined;
      if (access === "exact-get") {
        const result = await this.GetItem({ TableName: table.name, Key: this.partiqlKey(plan, table), ConsistentRead: input.ConsistentRead, ReturnConsumedCapacity: input.ReturnConsumedCapacity });
        const context = { names: plan.expressionAttributeNames, values: plan.expressionAttributeValues }; const condition = parseConditionExpression(plan.conditionExpression, context);
        const items = result.Item && evaluateCondition(condition, result.Item, context) ? [projectPartiqlItem(result.Item, plan)] : [];
        return { Items: items, ...(result.ConsumedCapacity ? { ConsumedCapacity: result.ConsumedCapacity } : {}) };
      }
      const common = { TableName: table.name, ...(plan.indexName ? { IndexName: plan.indexName } : {}), ...(plan.conditionExpression ? { FilterExpression: plan.conditionExpression } : {}), ...(plan.projectionExpression ? { ProjectionExpression: plan.projectionExpression } : {}), ...(localIndex && computedProjection ? { Select: "ALL_ATTRIBUTES" } : {}), ...(pageLimit ? { Limit: pageLimit } : {}), ...(cursor?.key ? { ExclusiveStartKey: cursor.key } : {}), ...(input.ConsistentRead !== undefined ? { ConsistentRead: input.ConsistentRead } : {}), ReturnConsumedCapacity: input.ReturnConsumedCapacity };
      const partitionValues = plan.keyAlternatives[partition] ?? []; const partitionValue = partitionValues.length === 1 ? partitionValues[0] : undefined; let result: any;
      if (partitionValue) {
        const names = clone(plan.expressionAttributeNames ?? {}); const values = clone(plan.expressionAttributeValues ?? {}); let name = "#partiql_hash"; while (names[name]) name += "_"; let value = ":partiql_hash"; while (values[value]) value += "_"; names[name] = partition; values[value] = clone(partitionValue);
        let KeyConditionExpression = `${name} = ${value}`; const sort = schema.find(key => key.KeyType === "RANGE")?.AttributeName; const sortPredicate = sort ? plan.keyPredicates.find(predicate => predicate.path.length === 1 && predicate.path[0] === sort) : undefined;
        if (sort && sortPredicate) {
          let sortName = "#partiql_range"; while (names[sortName]) sortName += "_"; names[sortName] = sort;
          const addValue = (attribute: any, suffix = "") => { let placeholder = `:partiql_range${suffix}`; while (values[placeholder]) placeholder += "_"; values[placeholder] = clone(attribute); return placeholder; };
          if (sortPredicate.kind === "compare") KeyConditionExpression += ` AND ${sortName} ${sortPredicate.operator} ${addValue(sortPredicate.value)}`;
          else if (sortPredicate.kind === "between") KeyConditionExpression += ` AND ${sortName} BETWEEN ${addValue(sortPredicate.lower, "_lower")} AND ${addValue(sortPredicate.upper, "_upper")}`;
          else KeyConditionExpression += ` AND begins_with(${sortName}, ${addValue(sortPredicate.value)})`;
        }
        result = await this.readMany({ ...common, KeyConditionExpression, ExpressionAttributeNames: names, ExpressionAttributeValues: values }, true, { partiqlOrder: plan.order });
      } else result = await this.readMany({ ...common, ...(plan.expressionAttributeNames ? { ExpressionAttributeNames: plan.expressionAttributeNames } : {}), ...(plan.expressionAttributeValues ? { ExpressionAttributeValues: plan.expressionAttributeValues } : {}) }, false, { partiqlOrder: plan.order, ...(partitionValues.length > 1 ? { partiqlPartitions: { name: partition, values: partitionValues } } : {}) });
      const items = (result.Items ?? []).map((item: Item) => projectPartiqlItem(item, plan)); const hasNext = Boolean(result.LastEvaluatedKey);
      return { Items: items, ...(result.LastEvaluatedKey ? { LastEvaluatedKey: result.LastEvaluatedKey } : {}), ...(hasNext ? { NextToken: this.partiqlTokens.encode("ExecuteStatement", { signature, key: result.LastEvaluatedKey, expiresAt: this.clock.now() + PARTIQL_TOKEN_TTL_MS }) } : {}), ...(result.ConsumedCapacity ? { ConsumedCapacity: result.ConsumedCapacity } : {}) };
    }
    if (plan.kind === "insert") {
      validateItem(table, plan.item); const key = stableItemKey(table, plan.item!); if (table.items[key]) throw new AwsError("DuplicateItemException", "Duplicate primary key exists in table");
      const result = await this.PutItem({ TableName: table.name, Item: plan.item, ReturnConsumedCapacity: input.ReturnConsumedCapacity }); return { Items: [], ...(result.ConsumedCapacity ? { ConsumedCapacity: result.ConsumedCapacity } : {}) };
    }
    if (plan.kind === "exists") throw new AwsError("ValidationException", "EXISTS can only be used in ExecuteTransaction");
    const key = this.partiqlKey(plan, table); const current = table.items[stableItemKey(table, key)];
    if (plan.kind === "update" && !current) throw new AwsError("ConditionalCheckFailedException", "The conditional request failed", 400, input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" ? { Item: undefined } : undefined);
    if (plan.kind === "delete" && !current) return { Items: [], ...capacity(input, table.name) };
    try {
      const common = { TableName: table.name, Key: key, ...(plan.conditionExpression ? { ConditionExpression: plan.conditionExpression } : {}), ...(plan.expressionAttributeNames ? { ExpressionAttributeNames: plan.expressionAttributeNames } : {}), ...(plan.expressionAttributeValues ? { ExpressionAttributeValues: plan.expressionAttributeValues } : {}), ReturnConsumedCapacity: input.ReturnConsumedCapacity };
      const result = plan.kind === "update" ? await this.UpdateItem({ ...common, UpdateExpression: plan.updateExpression, ReturnValues: plan.returnValues ?? "NONE" }) : await this.DeleteItem({ ...common, ReturnValues: plan.returnValues ?? "NONE" });
      return { Items: result.Attributes ? [result.Attributes] : [], ...(result.ConsumedCapacity ? { ConsumedCapacity: result.ConsumedCapacity } : {}) };
    } catch (error) {
      if (error instanceof AwsError && error.code === "ConditionalCheckFailedException" && input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" && current) throw new AwsError(error.code, error.message, error.status, { Item: clone(current) });
      throw error;
    }
  }

  async ExecuteStatement(input: any): Promise<any> { const plan = parsePartiql(input.Statement, input.Parameters); return this.executePartiqlPlan(plan, input); }

  async BatchExecuteStatement(input: any): Promise<any> {
    if (!Array.isArray(input.Statements) || input.Statements.length < 1 || input.Statements.length > 25) throw new AwsError("ValidationException", "Statements must contain between 1 and 25 entries"); this.validatePartiqlOptions(input);
    const parsed: Array<{ plan?: PartiqlPlan; error?: unknown }> = input.Statements.map((entry: any) => { try { return { plan: parsePartiql(entry?.Statement, entry?.Parameters) }; } catch (error) { return { error }; } });
    const modes = new Set(parsed.flatMap(entry => entry.plan ? [entry.plan.kind === "select" ? "read" : "write"] : [])); if (modes.size > 1) throw new AwsError("ValidationException", "BatchExecuteStatement cannot mix read and write statements");
    if (modes.has("write")) {
      const targets = new Set<string>();
      for (const entry of parsed) {
        const plan = entry.plan; if (!plan || plan.kind === "select" || plan.kind === "exists") continue;
        try { const table = requireTable(this.store, this.region, plan.tableName); const item = plan.kind === "insert" ? plan.item! : this.partiqlKey(plan, table); const target = `${table.name}\0${stableItemKey(table, item)}`; if (targets.has(target)) throw new AwsError("ValidationException", "BatchExecuteStatement cannot include multiple operations on one item"); targets.add(target); }
        catch (error) { if (error instanceof AwsError && error.message === "BatchExecuteStatement cannot include multiple operations on one item") throw error; }
      }
    }
    const Responses: any[] = []; const ConsumedCapacity: any[] = [];
    for (let index = 0; index < parsed.length; index++) {
      const entry = input.Statements[index]; const parsedEntry = parsed[index];
      try {
        if (parsedEntry.error) throw parsedEntry.error; const plan = parsedEntry.plan!; const table = requireTable(this.store, this.region, plan.tableName); let output: any; this.validatePartiqlOptions(entry, plan);
        if (plan.kind === "select") { if (!this.partiqlKeyOnly(plan, table)) throw new AwsError("ValidationException", "Batch SELECT statements must specify equality conditions on every key attribute"); const read = await this.GetItem({ TableName: table.name, Key: this.partiqlKey(plan, table), ConsistentRead: entry.ConsistentRead, ReturnConsumedCapacity: input.ReturnConsumedCapacity }); output = { ...(read.Item ? { Item: projectPartiqlItem(read.Item, plan) } : {}), ...(read.ConsumedCapacity ? { ConsumedCapacity: read.ConsumedCapacity } : {}) }; }
        else output = await this.executePartiqlPlan(plan, { ...entry, ReturnConsumedCapacity: input.ReturnConsumedCapacity });
        Responses.push({ TableName: plan.tableName, ...(output.Item ? { Item: output.Item } : output.Items?.[0] ? { Item: output.Items[0] } : {}) }); if (output.ConsumedCapacity) ConsumedCapacity.push(output.ConsumedCapacity);
      } catch (error) { const aws = error instanceof AwsError ? error : new AwsError("InternalServerError", error instanceof Error ? error.message : String(error), 500); Responses.push({ Error: { Code: aws.code, Message: aws.message, ...(aws.details?.Item ? { Item: aws.details.Item } : {}) } }); }
    }
    return { Responses, ...(input.ReturnConsumedCapacity && input.ReturnConsumedCapacity !== "NONE" ? { ConsumedCapacity } : {}) };
  }

  async ExecuteTransaction(input: any): Promise<any> {
    if (!Array.isArray(input.TransactStatements) || input.TransactStatements.length < 1 || input.TransactStatements.length > 100) throw new AwsError("ValidationException", "TransactStatements must contain between 1 and 100 entries"); this.validatePartiqlOptions(input);
    if (Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024) throw new AwsError("ValidationException", "Transaction request exceeds the maximum allowed size");
    const plans: PartiqlPlan[] = input.TransactStatements.map((entry: any) => parsePartiql(entry?.Statement, entry?.Parameters)); const modes = new Set(plans.map((plan: PartiqlPlan) => plan.kind === "select" ? "read" : "write")); if (modes.size !== 1) throw new AwsError("ValidationException", "ExecuteTransaction cannot mix read and write statements");
    for (let index = 0; index < plans.length; index++) { const entry = input.TransactStatements[index]; if (entry?.ConsistentRead !== undefined || entry?.Limit !== undefined || entry?.NextToken !== undefined) throw new AwsError("ValidationException", "Transactional statements do not support ConsistentRead, Limit, or NextToken"); this.validatePartiqlOptions(entry, plans[index]); }
    if (modes.has("read")) {
      const TransactItems = plans.map((plan: PartiqlPlan) => { const table = requireTable(this.store, this.region, plan.tableName); if (plan.kind !== "select" || plan.indexName || !this.partiqlKeyOnly(plan, table)) throw new AwsError("ValidationException", "Transactional SELECT statements must specify equality conditions on every table key attribute"); return { Get: { TableName: table.name, Key: this.partiqlKey(plan, table) } }; });
      const result = await this.TransactGetItems({ TransactItems, ReturnConsumedCapacity: input.ReturnConsumedCapacity }); return { Responses: (result.Responses ?? []).map((response: any, index: number) => response.Item ? { Item: projectPartiqlItem(response.Item, plans[index]) } : {}), ...(result.ConsumedCapacity ? { ConsumedCapacity: result.ConsumedCapacity } : {}) };
    }
    const TransactItems = plans.map((plan: PartiqlPlan, index: number) => {
      const table = requireTable(this.store, this.region, plan.tableName); const failure = input.TransactStatements[index].ReturnValuesOnConditionCheckFailure; if (plan.returnValues) throw new AwsError("ValidationException", "RETURNING is not supported for transactional write statements");
      if (plan.kind === "insert") { validateItem(table, plan.item); const name = "#partiql_pk"; return { Put: { TableName: table.name, Item: plan.item, ConditionExpression: `attribute_not_exists(${name})`, ExpressionAttributeNames: { [name]: table.keySchema.find(key => key.KeyType === "HASH")!.AttributeName }, ...(failure ? { ReturnValuesOnConditionCheckFailure: failure } : {}) } }; }
      const Key = this.partiqlKey(plan, table); const common = { TableName: table.name, Key, ...(plan.expressionAttributeNames ? { ExpressionAttributeNames: clone(plan.expressionAttributeNames) } : {}), ...(plan.expressionAttributeValues ? { ExpressionAttributeValues: clone(plan.expressionAttributeValues) } : {}), ...(failure ? { ReturnValuesOnConditionCheckFailure: failure } : {}) };
      if (plan.kind === "exists") return { ConditionCheck: { ...common, ConditionExpression: plan.conditionExpression } };
      if (plan.kind === "update") return { Update: { ...common, ...this.conditionWithExistence(plan, table), UpdateExpression: plan.updateExpression } };
      return { Delete: { ...common, ...(!this.partiqlKeyOnly(plan, table) && plan.conditionExpression ? { ConditionExpression: plan.conditionExpression } : {}) } };
    });
    const result = await this.TransactWriteItems({ TransactItems, ClientRequestToken: input.ClientRequestToken, ReturnConsumedCapacity: input.ReturnConsumedCapacity }); return { Responses: plans.map(() => ({})), ...(result.ConsumedCapacity ? { ConsumedCapacity: result.ConsumedCapacity } : {}) };
  }

  async BatchGetItem(input: any): Promise<any> {
    const Responses: Record<string, Item[]> = {}; const charges = new Map<string, CapacityCharge>(); const contributors = new Map<string, Item[]>();
    const total = Object.values<any>(input.RequestItems ?? {}).reduce((sum, request) => sum + (request.Keys?.length ?? 0), 0);
    if (total > 100) throw new AwsError("ValidationException", "Too many items requested for the BatchGetItem call");
    for (const [name, request] of Object.entries<any>(input.RequestItems ?? {})) {
      validateExpressionRequest(request);
      const table = requireTable(this.store, this.region, name); assertDataPlaneAvailable(table);
      const keys = request.Keys ?? []; const encoded = keys.map((key: Item) => { validateKey(table, key); return stableItemKey(table, key); });
      if (new Set(encoded).size !== encoded.length) throw new AwsError("ValidationException", "Provided list of item keys contains duplicates");
      const found = encoded.map((key: string) => table.items[key]); contributors.set(name, keys.map((key: Item, index: number) => found[index] ?? key)); const charge = emptyCapacity(name); addCapacityUnits(charge, "table", found.reduce((sum: number, item: Item | undefined) => sum + this.itemReadUnits(item, request.ConsistentRead === true), 0), 0); charges.set(name, charge); Responses[name] = found.filter(Boolean).map((item: Item) => projectItem(item, request.ProjectionExpression, { names: request.ExpressionAttributeNames }));
    }
    for (const [name, charge] of charges) this.takeCapacityCharge(requireTable(this.store, this.region, name), "read", charge, contributors.get(name)); for (const [name, items] of contributors) await this.publishContributorMetrics(requireTable(this.store, this.region, name), items, "AccessFrequency"); return { Responses, UnprocessedKeys: {}, ...(input.ReturnConsumedCapacity && input.ReturnConsumedCapacity !== "NONE" ? { ConsumedCapacity: [...charges.values()].map(charge => formatConsumedCapacity(input.ReturnConsumedCapacity, charge)) } : {}) };
  }

  async BatchWriteItem(input: any): Promise<any> {
    validateReturnItemCollectionMetrics(input.ReturnItemCollectionMetrics);
    const count = Object.values<any[]>(input.RequestItems ?? {}).reduce((sum, requests) => sum + requests.length, 0);
    if (count > 25) throw new AwsError("ValidationException", "Too many items requested for the BatchWriteItem call");
    const pending = new Map<string, Record<string, Item>>(); const charges = new Map<string, CapacityCharge>(); const journal = new Map<string, DynamoPitrChange[]>(); const streamChanges = new Map<string, DynamoStreamChange[]>(); const contributors = new Map<string, Item[]>(); const metricItems = new Map<string, Item[]>();
    for (const [name, requests] of Object.entries<any[]>(input.RequestItems ?? {})) {
      const table = requireTable(this.store, this.region, name); assertDataPlaneAvailable(table);
      const items = structuredClone(table.items);
      const seen = new Set<string>();
      const charge = emptyCapacity(name);
      for (const request of requests) {
        if (Boolean(request.PutRequest) === Boolean(request.DeleteRequest)) throw new AwsError("ValidationException", "Each write request must contain exactly one PutRequest or DeleteRequest");
        const item = request.PutRequest?.Item; const key = request.DeleteRequest?.Key;
        if (item) { validateItem(table, item); validateIndexAttributes(table, item); } else validateKey(table, key);
        const encoded = stableItemKey(table, item ?? key); if (seen.has(encoded)) throw new AwsError("ValidationException", "Provided list of item keys contains duplicates"); seen.add(encoded);
        const previous = items[encoded]; (contributors.get(name) ?? (contributors.set(name, []), contributors.get(name)!)).push(item ?? previous ?? key); const writeUnits = this.itemWriteUnits(item ?? previous ?? key); addCapacityUnits(charge, "table", 0, writeUnits); writeIndexCapacity(charge, table, previous, item, candidate => this.itemWriteUnits(candidate)); (journal.get(name) ?? (journal.set(name, []), journal.get(name)!)).push(item ? { key: encoded, item } : { key: encoded }); if (item) { (streamChanges.get(name) ?? (streamChanges.set(name, []), streamChanges.get(name)!)).push({ oldImage: previous, newImage: item }); items[encoded] = clone(item); (metricItems.get(name) ?? (metricItems.set(name, []), metricItems.get(name)!)).push(item); } else { if (previous) (streamChanges.get(name) ?? (streamChanges.set(name, []), streamChanges.get(name)!)).push({ oldImage: previous }); delete items[encoded]; (metricItems.get(name) ?? (metricItems.set(name, []), metricItems.get(name)!)).push(previous ?? key); }
      }
      charges.set(name, charge); pending.set(name, items);
    }
    for (const [name, charge] of charges) this.takeCapacityCharge(requireTable(this.store, this.region, name), "write", charge, contributors.get(name)); for (const [name, changes] of journal) await this.journalChanges(requireTable(this.store, this.region, name), changes); for (const [name, items] of pending) { const table = requireTable(this.store, this.region, name); table.items = items; for (const change of streamChanges.get(name) ?? []) await this.emitStreamRecord(table, change); await this.replicateGlobalChanges(table, journal.get(name) ?? []); await this.publishContributorMetrics(table, contributors.get(name) ?? [], "AccessFrequency", undefined, false, true); }
    await this.store.save();
    const metrics = itemCollectionMetricsResponse(input.ReturnItemCollectionMetrics, [...metricItems.entries()].map(([name, items]) => ({ table: requireTable(this.store, this.region, name), items })));
    return { UnprocessedItems: {}, ...(input.ReturnConsumedCapacity && input.ReturnConsumedCapacity !== "NONE" ? { ConsumedCapacity: [...charges.values()].map(charge => formatConsumedCapacity(input.ReturnConsumedCapacity, charge)) } : {}), ...metrics };
  }

  async TransactGetItems(input: any): Promise<any> {
    const actions = input.TransactItems;
    this.validateTransactionEnvelope(input, actions, "get");
    const targets = new Set<string>();
    const responses: any[] = [];
    const tableNames: string[] = []; const charges = new Map<string, CapacityCharge>(); const contributors = new Map<string, Item[]>();
    for (const action of actions) {
      if (!action?.Get || Object.keys(action).length !== 1) throw new AwsError("ValidationException", "Each TransactGetItem must contain exactly one Get action");
      const get = action.Get; validateExpressionRequest(get); const table = requireTable(this.store, this.region, get.TableName); assertDataPlaneAvailable(table); validateKey(table, get.Key);
      const target = `${table.name}\0${stableItemKey(table, get.Key)}`; if (targets.has(target)) throw new AwsError("ValidationException", "Transaction request cannot include multiple operations on one item"); targets.add(target); tableNames.push(table.name);
      const item = table.items[stableItemKey(table, get.Key)]; (contributors.get(table.name) ?? (contributors.set(table.name, []), contributors.get(table.name)!)).push(item ?? get.Key); const charge = charges.get(table.name) ?? emptyCapacity(table.name); addCapacityUnits(charge, "table", this.itemReadUnits(item, true, true), 0); charges.set(table.name, charge); responses.push(item ? { Item: projectItem(item, get.ProjectionExpression, { names: get.ExpressionAttributeNames }) } : {});
    }
    if (Buffer.byteLength(JSON.stringify(responses)) > 4 * 1024 * 1024) throw new AwsError("ValidationException", "Transaction response exceeds the maximum allowed size");
    for (const [name, charge] of charges) this.takeCapacityCharge(requireTable(this.store, this.region, name), "read", charge, contributors.get(name)); for (const [name, items] of contributors) await this.publishContributorMetrics(requireTable(this.store, this.region, name), items, "AccessFrequency"); return { Responses: responses, ...(input.ReturnConsumedCapacity && input.ReturnConsumedCapacity !== "NONE" ? { ConsumedCapacity: [...charges.values()].map(charge => formatConsumedCapacity(input.ReturnConsumedCapacity, charge)) } : {}) };
  }

  async TransactWriteItems(input: any): Promise<any> {
    const actions = input.TransactItems;
    this.validateTransactionEnvelope(input, actions, "write");
    const token = input.ClientRequestToken;
    if (token !== undefined && (typeof token !== "string" || token.length < 1 || token.length > 36)) throw new AwsError("ValidationException", "ClientRequestToken must contain between 1 and 36 characters");
    const hash = createHash("sha256").update(canonicalJson({ ...input, ClientRequestToken: undefined })).digest("hex");
    const regionState = this.store.regionState(this.region); const now = this.clock.now(); const tokens = regionState.dynamodbTransactionTokens ??= {};
    for (const [key, entry] of Object.entries(tokens)) if (entry.expiresAt <= now) delete tokens[key];
    if (token && tokens[token]) {
      if (tokens[token].hash !== hash) throw new AwsError("IdempotentParameterMismatchException", "A request with the same client token but different parameters was received");
      return clone(tokens[token].response as any);
    }
    const targets = new Set<string>(); const tableNames: string[] = []; const normalized: Array<{ kind: string; request: any; table: TableState; key: string }> = [];
    for (const action of actions) {
      const entries = ["ConditionCheck", "Put", "Update", "Delete"].filter(kind => action?.[kind]);
      if (entries.length !== 1 || Object.keys(action).length !== 1) throw new AwsError("ValidationException", "Each transaction item must contain exactly one ConditionCheck, Put, Update, or Delete action");
      const kind = entries[0]; const request = action[kind]; validateExpressionRequest(request); const table = requireTable(this.store, this.region, request.TableName); assertDataPlaneAvailable(table);
      if (request.ReturnValuesOnConditionCheckFailure !== undefined && !["NONE", "ALL_OLD"].includes(request.ReturnValuesOnConditionCheckFailure)) throw new AwsError("ValidationException", "ReturnValuesOnConditionCheckFailure must be NONE or ALL_OLD");
      const itemOrKey = kind === "Put" ? request.Item : request.Key; if (kind === "Put") { validateItem(table, itemOrKey); validateIndexAttributes(table, itemOrKey); } else validateKey(table, itemOrKey);
      const key = stableItemKey(table, itemOrKey); const target = `${table.name}\0${key}`; if (targets.has(target)) throw new AwsError("ValidationException", "Transaction request cannot include multiple operations on one item"); targets.add(target); tableNames.push(table.name); normalized.push({ kind, request, table, key });
      if (kind === "ConditionCheck" && !request.ConditionExpression) throw new AwsError("ValidationException", "ConditionExpression is required for ConditionCheck");
      if (kind === "Update" && !request.UpdateExpression) throw new AwsError("ValidationException", "UpdateExpression is required for Update");
    }
    const lockKeys = [...targets, ...(token ? [`\0client-request-token\0${token}`] : [])].sort();
    return this.withTransactionLocks(lockKeys, async () => {
      if (token && tokens[token]) {
        if (tokens[token].hash !== hash) throw new AwsError("IdempotentParameterMismatchException", "A request with the same client token but different parameters was received");
        return clone(tokens[token].response as any);
      }
      const working = new Map<string, Record<string, Item>>(); for (const name of new Set(tableNames)) working.set(name, clone(this.tables[name].items));
      const reasons = normalized.map(() => ({ Code: "None", Message: "None" })); const streamChanges: Array<DynamoStreamChange | undefined> = normalized.map(() => undefined); let failed = -1;
      for (let index = 0; index < normalized.length; index++) {
        const { kind, request, table, key } = normalized[index]; const items = working.get(table.name)!; const current = items[key];
        const condition = parseConditionExpression(request.ConditionExpression, expressionContext(request));
        if (!evaluateCondition(condition, current ?? {}, expressionContext(request))) { failed = index; reasons[index] = { Code: "ConditionalCheckFailed", Message: "The conditional request failed", ...(request.ReturnValuesOnConditionCheckFailure === "ALL_OLD" && current ? { Item: clone(current) } : {}) }; break; }
        if (kind === "Put") { streamChanges[index] = { oldImage: current, newImage: request.Item }; items[key] = clone(request.Item); }
        else if (kind === "Delete") { if (current) streamChanges[index] = { oldImage: current }; delete items[key]; }
        else if (kind === "Update") { const updated = applyUpdateExpression(clone(current ?? request.Key), request.UpdateExpression, expressionContext(request)).item; validateItem(table, updated); validateIndexAttributes(table, updated); if (stableItemKey(table, updated) !== key) throw new AwsError("ValidationException", "Cannot update attribute that is part of the key"); streamChanges[index] = { oldImage: current, newImage: updated }; items[key] = updated; }
      }
      if (failed >= 0) throw new AwsError("TransactionCanceledException", "Transaction cancelled, please refer cancellation reasons for specific reasons", 400, { CancellationReasons: reasons });
      if (process.env.STACKSIM_DDB_FAIL_TRANSACTION_AFTER_EVALUATION === "true") throw new AwsError("InternalServerError", "Injected transaction failure after evaluation", 500);
      const charges = new Map<string, CapacityCharge>(); const contributors = new Map<string, Item[]>(); const metricItems = new Map<string, Item[]>();
      for (const { kind, request, table, key } of normalized) if (kind !== "ConditionCheck") {
        const previous = this.tables[table.name].items[key]; const item = kind === "Put" ? request.Item : working.get(table.name)![key] ?? request.Key;
        const charge = charges.get(table.name) ?? emptyCapacity(table.name); addCapacityUnits(charge, "table", 0, this.itemWriteUnits(item, true)); writeIndexCapacity(charge, table, previous, kind === "Delete" ? undefined : item, candidate => this.itemWriteUnits(candidate, true)); charges.set(table.name, charge);
        (contributors.get(table.name) ?? (contributors.set(table.name, []), contributors.get(table.name)!)).push(item);
        (metricItems.get(table.name) ?? (metricItems.set(table.name, []), metricItems.get(table.name)!)).push(kind === "Delete" ? previous ?? request.Key : item);
      }
      for (const [name, charge] of charges) this.takeCapacityCharge(requireTable(this.store, this.region, name), "write", charge, contributors.get(name));
      const journal = new Map<string, DynamoPitrChange[]>(); for (const { kind, table, key } of normalized) if (kind !== "ConditionCheck") { const item = working.get(table.name)![key]; (journal.get(table.name) ?? (journal.set(table.name, []), journal.get(table.name)!)).push(item ? { key, item } : { key }); }
      for (const [name, changes] of journal) await this.journalChanges(this.tables[name], changes); for (const { table, key } of normalized) { const item = working.get(table.name)![key]; if (item) this.tables[table.name].items[key] = item; else delete this.tables[table.name].items[key]; } for (let index = 0; index < normalized.length; index++) if (streamChanges[index]) await this.emitStreamRecord(this.tables[normalized[index].table.name], streamChanges[index]!); for (const [name, changes] of journal) await this.replicateGlobalChanges(this.tables[name], changes); for (const [name, items] of contributors) await this.publishContributorMetrics(this.tables[name], items, "AccessFrequency", undefined, false, true);
      const response: any = {
        ...(input.ReturnConsumedCapacity && input.ReturnConsumedCapacity !== "NONE" ? { ConsumedCapacity: [...new Set(tableNames)].map(name => formatConsumedCapacity(input.ReturnConsumedCapacity, charges.get(name) ?? emptyCapacity(name))) } : {}),
        ...itemCollectionMetricsResponse(input.ReturnItemCollectionMetrics, [...metricItems.entries()].map(([name, items]) => ({ table: this.tables[name], items }))),
      };
      if (token) tokens[token] = { hash, expiresAt: this.clock.now() + 10 * 60_000, response: clone(response) };
      await this.store.save(); return response;
    });
  }

  private validateTransactionEnvelope(input: any, actions: any, operation: "get" | "write"): asserts actions is any[] {
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 100) throw new AwsError("ValidationException", "TransactItems must contain between 1 and 100 actions");
    if (Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024) throw new AwsError("ValidationException", "Transaction request exceeds the maximum allowed size");
    const capacityValues = ["NONE", "TOTAL", "INDEXES"];
    if (input.ReturnConsumedCapacity && !capacityValues.includes(input.ReturnConsumedCapacity)) throw new AwsError("ValidationException", "Invalid ReturnConsumedCapacity value");
    if (operation === "write" && input.ReturnItemCollectionMetrics && !["NONE", "SIZE"].includes(input.ReturnItemCollectionMetrics)) throw new AwsError("ValidationException", "Invalid ReturnItemCollectionMetrics value");
  }

  private async withTransactionLocks<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];
    try {
      for (const key of keys) {
        const previous = this.transactionLocks.get(key) ?? Promise.resolve(); let release!: () => void; const current = new Promise<void>(resolve => { release = resolve; }); const tail = previous.then(() => current); this.transactionLocks.set(key, tail); await previous; releases.push(() => { release(); if (this.transactionLocks.get(key) === tail) this.transactionLocks.delete(key); });
      }
      return await operation();
    } finally { for (const release of releases.reverse()) release(); }
  }
}
