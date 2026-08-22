import type { DynamoDbService } from "../../dynamodb.js";
import { AwsError } from "../../errors.js";
import {
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
import {
  CFN10_NO_TAGS, CFN10_RETENTION, cfn10ExactKeys, cfn10Failure, cfn10GeneratedName,
  cfn10GetAtt, cfn10Issue, cfn10Missing, cfn10Owned, cfn10Record, cfn10Same,
  cfn10ServiceTags, cfn10Tags, cfn10UserTags,
} from "./cfn10-common.js";

export const DYNAMODB_GLOBAL_TABLE_TYPE = "AWS::DynamoDB::GlobalTable";
const STREAM_VIEWS = new Set(["KEYS_ONLY", "NEW_IMAGE", "OLD_IMAGE", "NEW_AND_OLD_IMAGES"]);
const PROJECTIONS = new Set(["KEYS_ONLY", "ALL", "INCLUDE"]);

export interface DynamoDbGlobalAttributeDefinitionModel { readonly AttributeName: string; readonly AttributeType: "S" | "N" | "B"; }
export interface DynamoDbGlobalKeySchemaModel { readonly AttributeName: string; readonly KeyType: "HASH" | "RANGE"; }
export interface DynamoDbGlobalIndexModel {
  readonly IndexName: string;
  readonly KeySchema: readonly DynamoDbGlobalKeySchemaModel[];
  readonly Projection: { readonly ProjectionType: "KEYS_ONLY" | "ALL" | "INCLUDE"; readonly NonKeyAttributes?: readonly string[] };
}
export interface DynamoDbGlobalReplicaModel {
  readonly Region: string;
  readonly DeletionProtectionEnabled?: boolean;
  readonly GlobalSecondaryIndexes?: readonly { readonly IndexName: string }[];
  readonly PointInTimeRecoverySpecification?: { readonly PointInTimeRecoveryEnabled: boolean; readonly RecoveryPeriodInDays?: number };
  readonly TableClass?: "STANDARD" | "STANDARD_INFREQUENT_ACCESS";
  readonly Tags?: readonly { readonly Key: string; readonly Value: string }[];
}
export interface DynamoDbGlobalTableModel {
  readonly TableName: string;
  readonly AttributeDefinitions: readonly DynamoDbGlobalAttributeDefinitionModel[];
  readonly BillingMode: "PAY_PER_REQUEST";
  readonly GlobalSecondaryIndexes?: readonly DynamoDbGlobalIndexModel[];
  readonly KeySchema: readonly DynamoDbGlobalKeySchemaModel[];
  readonly Replicas: readonly DynamoDbGlobalReplicaModel[];
  readonly SSESpecification?: { readonly SSEEnabled: false };
  readonly StreamSpecification?: { readonly StreamViewType: "KEYS_ONLY" | "NEW_IMAGE" | "OLD_IMAGE" | "NEW_AND_OLD_IMAGES" };
}

export const DYNAMODB_GLOBAL_TABLE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: DYNAMODB_GLOBAL_TABLE_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    AttributeDefinitions: Object.freeze({ valueType: "array", required: true, updateBehavior: "CONDITIONAL_REPLACEMENT" }),
    BillingMode: Object.freeze({ valueType: "string", required: true, updateBehavior: "NOT_SUPPORTED" }),
    GlobalSecondaryIndexes: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    KeySchema: Object.freeze({ valueType: "array", required: true, updateBehavior: "REPLACEMENT" }),
    Replicas: Object.freeze({ valueType: "array", required: true, updateBehavior: "MUTABLE" }),
    SSESpecification: Object.freeze({ valueType: "object", updateBehavior: "NOT_SUPPORTED" }),
    StreamSpecification: Object.freeze({ valueType: "object", updateBehavior: "REPLACEMENT" }),
    TableName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Table name" }),
  attributes: Object.freeze({ Arn: Object.freeze({ valueType: "string" }), StreamArn: Object.freeze({ valueType: "string" }), TableId: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention: CFN10_RETENTION, tags: CFN10_NO_TAGS,
});

type Profile = "SINGLE_REGION_TABLE_V2" | "MULTI_REGION_BARE";
const profile = (value: Pick<DynamoDbGlobalTableModel, "Replicas">): Profile => value.Replicas.length === 1 ? "SINGLE_REGION_TABLE_V2" : "MULTI_REGION_BARE";

function stable<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stable) as T;
  if (cfn10Record(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) as T;
  return value;
}

function validateKeySchema(value: unknown, path: string, issues: ProviderValidationIssue[]): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) { cfn10Issue(issues, path, `${path} must contain one HASH key and at most one RANGE key`); return names; }
  let hashes = 0; let ranges = 0;
  for (const [position, key] of value.entries()) {
    const itemPath = `${path}.${position}`;
    if (!cfn10Record(key)) { cfn10Issue(issues, itemPath, "Key schema entries must be objects"); continue; }
    cfn10ExactKeys(key, ["AttributeName", "KeyType"], itemPath, issues);
    if (typeof key.AttributeName !== "string" || key.AttributeName.length < 1 || key.AttributeName.length > 255) cfn10Issue(issues, `${itemPath}.AttributeName`, "AttributeName must contain 1-255 characters");
    else if (names.has(key.AttributeName)) cfn10Issue(issues, `${itemPath}.AttributeName`, "Key attributes must be unique"); else names.add(key.AttributeName);
    if (key.KeyType === "HASH") hashes++; else if (key.KeyType === "RANGE") ranges++; else cfn10Issue(issues, `${itemPath}.KeyType`, "KeyType must be HASH or RANGE");
  }
  if (hashes !== 1 || ranges > 1) cfn10Issue(issues, path, `${path} must contain exactly one HASH key and at most one RANGE key`);
  return names;
}

function validateDefinitions(properties: Record<string, unknown>, issues: ProviderValidationIssue[]): void {
  const used = validateKeySchema(properties.KeySchema, "Properties.KeySchema", issues);
  let projected = 0;
  if (properties.GlobalSecondaryIndexes !== undefined) {
    if (!Array.isArray(properties.GlobalSecondaryIndexes) || properties.GlobalSecondaryIndexes.length > 20) cfn10Issue(issues, "Properties.GlobalSecondaryIndexes", "GlobalSecondaryIndexes must contain at most 20 entries");
    else {
      const indexNames = new Set<string>();
      for (const [position, index] of properties.GlobalSecondaryIndexes.entries()) {
        const path = `Properties.GlobalSecondaryIndexes.${position}`;
        if (!cfn10Record(index)) { cfn10Issue(issues, path, "Global secondary indexes must be objects"); continue; }
        cfn10ExactKeys(index, ["IndexName", "KeySchema", "Projection"], path, issues);
        if (typeof index.IndexName !== "string" || !/^[A-Za-z0-9_.-]{3,255}$/.test(index.IndexName)) cfn10Issue(issues, `${path}.IndexName`, "IndexName must contain 3-255 letters, numbers, underscores, hyphens, or periods");
        else if (indexNames.has(index.IndexName)) cfn10Issue(issues, `${path}.IndexName`, "Index names must be unique"); else indexNames.add(index.IndexName);
        for (const name of validateKeySchema(index.KeySchema, `${path}.KeySchema`, issues)) used.add(name);
        if (!cfn10Record(index.Projection)) cfn10Issue(issues, `${path}.Projection`, "Projection must be an object");
        else {
          cfn10ExactKeys(index.Projection, ["ProjectionType", "NonKeyAttributes"], `${path}.Projection`, issues);
          if (!PROJECTIONS.has(String(index.Projection.ProjectionType))) cfn10Issue(issues, `${path}.Projection.ProjectionType`, "ProjectionType must be KEYS_ONLY, ALL, or INCLUDE");
          const nonKeys = index.Projection.NonKeyAttributes;
          if (nonKeys !== undefined && (!Array.isArray(nonKeys) || nonKeys.some(item => typeof item !== "string") || new Set(nonKeys).size !== nonKeys.length)) cfn10Issue(issues, `${path}.Projection.NonKeyAttributes`, "NonKeyAttributes must be unique strings");
          const length = Array.isArray(nonKeys) ? nonKeys.length : 0; projected += length;
          if (index.Projection.ProjectionType === "INCLUDE" && (length < 1 || length > 20)) cfn10Issue(issues, `${path}.Projection.NonKeyAttributes`, "INCLUDE requires 1-20 NonKeyAttributes");
          if (index.Projection.ProjectionType !== "INCLUDE" && length) cfn10Issue(issues, `${path}.Projection.NonKeyAttributes`, "NonKeyAttributes are valid only for INCLUDE");
        }
      }
    }
  }
  if (projected > 100) cfn10Issue(issues, "Properties.GlobalSecondaryIndexes", "At most 100 projected non-key attributes are supported across all indexes");
  if (Array.isArray(properties.AttributeDefinitions)) {
    const definitions = new Set<string>();
    for (const [position, definition] of properties.AttributeDefinitions.entries()) {
      const path = `Properties.AttributeDefinitions.${position}`;
      if (!cfn10Record(definition)) { cfn10Issue(issues, path, "Attribute definitions must be objects"); continue; }
      cfn10ExactKeys(definition, ["AttributeName", "AttributeType"], path, issues);
      if (typeof definition.AttributeName !== "string" || definition.AttributeName.length < 1 || definition.AttributeName.length > 255) cfn10Issue(issues, `${path}.AttributeName`, "AttributeName must contain 1-255 characters");
      else if (definitions.has(definition.AttributeName)) cfn10Issue(issues, `${path}.AttributeName`, "Attribute names must be unique"); else definitions.add(definition.AttributeName);
      if (!["S", "N", "B"].includes(String(definition.AttributeType))) cfn10Issue(issues, `${path}.AttributeType`, "AttributeType must be S, N, or B");
    }
    if (definitions.size !== used.size || [...used].some(name => !definitions.has(name))) cfn10Issue(issues, "Properties.AttributeDefinitions", "AttributeDefinitions must exactly match attributes used by the table and global secondary index key schemas");
  }
}

function validateRichReplica(replica: Record<string, unknown>, properties: Record<string, unknown>, context: ProviderContext, issues: ProviderValidationIssue[]): void {
  const path = "Properties.Replicas.0";
  cfn10ExactKeys(replica, ["DeletionProtectionEnabled", "GlobalSecondaryIndexes", "PointInTimeRecoverySpecification", "Region", "TableClass", "Tags"], path, issues);
  if (replica.Region !== context.region) cfn10Issue(issues, `${path}.Region`, "The rich single-Region replica must equal the stack Region");
  if (replica.DeletionProtectionEnabled !== undefined && typeof replica.DeletionProtectionEnabled !== "boolean") cfn10Issue(issues, `${path}.DeletionProtectionEnabled`, "DeletionProtectionEnabled must be a boolean");
  if (replica.TableClass !== undefined && !["STANDARD", "STANDARD_INFREQUENT_ACCESS"].includes(String(replica.TableClass))) cfn10Issue(issues, `${path}.TableClass`, "TableClass must be STANDARD or STANDARD_INFREQUENT_ACCESS");
  if (replica.PointInTimeRecoverySpecification !== undefined) {
    const pitr = replica.PointInTimeRecoverySpecification;
    if (!cfn10Record(pitr)) cfn10Issue(issues, `${path}.PointInTimeRecoverySpecification`, "PointInTimeRecoverySpecification must be an object");
    else {
      cfn10ExactKeys(pitr, ["PointInTimeRecoveryEnabled", "RecoveryPeriodInDays"], `${path}.PointInTimeRecoverySpecification`, issues);
      if (typeof pitr.PointInTimeRecoveryEnabled !== "boolean") cfn10Issue(issues, `${path}.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled`, "PointInTimeRecoveryEnabled must be a boolean");
      if (pitr.RecoveryPeriodInDays !== undefined && (!Number.isInteger(pitr.RecoveryPeriodInDays) || Number(pitr.RecoveryPeriodInDays) < 1 || Number(pitr.RecoveryPeriodInDays) > 35)) cfn10Issue(issues, `${path}.PointInTimeRecoverySpecification.RecoveryPeriodInDays`, "RecoveryPeriodInDays must be between 1 and 35");
      if (pitr.PointInTimeRecoveryEnabled === false && pitr.RecoveryPeriodInDays !== undefined) cfn10Issue(issues, `${path}.PointInTimeRecoverySpecification.RecoveryPeriodInDays`, "RecoveryPeriodInDays cannot be set while PITR is disabled");
    }
  }
  try { cfn10Tags(replica.Tags, 49); } catch (error) { cfn10Issue(issues, `${path}.Tags`, error instanceof Error ? error.message : String(error)); }
  if (replica.GlobalSecondaryIndexes !== undefined) {
    if (!Array.isArray(replica.GlobalSecondaryIndexes)) cfn10Issue(issues, `${path}.GlobalSecondaryIndexes`, "GlobalSecondaryIndexes must be an array");
    else {
      const names: string[] = [];
      for (const [position, item] of replica.GlobalSecondaryIndexes.entries()) {
        const itemPath = `${path}.GlobalSecondaryIndexes.${position}`;
        if (!cfn10Record(item)) { cfn10Issue(issues, itemPath, "Replica index entries must be objects"); continue; }
        cfn10ExactKeys(item, ["IndexName"], itemPath, issues); if (typeof item.IndexName === "string") names.push(item.IndexName); else cfn10Issue(issues, `${itemPath}.IndexName`, "IndexName must be a string");
      }
      const top = Array.isArray(properties.GlobalSecondaryIndexes) ? properties.GlobalSecondaryIndexes.filter(cfn10Record).map(item => String(item.IndexName)).sort() : [];
      if (new Set(names).size !== names.length || !cfn10Same([...names].sort(), top)) cfn10Issue(issues, `${path}.GlobalSecondaryIndexes`, "Replica GlobalSecondaryIndexes must exactly name every top-level global secondary index");
    }
  }
}

function validation(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, DYNAMODB_GLOBAL_TABLE_SCHEMA);
  if (!cfn10Record(properties)) return issues;
  if (properties.TableName !== undefined && (typeof properties.TableName !== "string" || !/^[A-Za-z0-9_.-]{3,255}$/.test(properties.TableName))) cfn10Issue(issues, "Properties.TableName", "TableName must contain 3-255 letters, numbers, underscores, hyphens, or periods");
  if (properties.BillingMode !== undefined && properties.BillingMode !== "PAY_PER_REQUEST") cfn10Issue(issues, "Properties.BillingMode", "BillingMode must be PAY_PER_REQUEST");
  validateDefinitions(properties, issues);
  if (!Array.isArray(properties.Replicas) || properties.Replicas.length < 1 || properties.Replicas.length > 10) return issues;
  const regions = new Set<string>();
  for (const [position, replica] of properties.Replicas.entries()) {
    const path = `Properties.Replicas.${position}`;
    if (!cfn10Record(replica)) { cfn10Issue(issues, path, "Replica entries must be objects"); continue; }
    if (typeof replica.Region !== "string" || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(replica.Region)) cfn10Issue(issues, `${path}.Region`, "Region must be a valid AWS Region identifier");
    else if (regions.has(replica.Region)) cfn10Issue(issues, `${path}.Region`, "Replica Regions must be unique"); else regions.add(replica.Region);
  }
  if (!regions.has(context.region)) cfn10Issue(issues, "Properties.Replicas", "Replicas must include the stack Region");
  if (properties.Replicas.length === 1 && cfn10Record(properties.Replicas[0])) {
    validateRichReplica(properties.Replicas[0], properties, context, issues);
    if (properties.SSESpecification !== undefined) {
      if (!cfn10Record(properties.SSESpecification)) cfn10Issue(issues, "Properties.SSESpecification", "SSESpecification must be an object");
      else { cfn10ExactKeys(properties.SSESpecification, ["SSEEnabled"], "Properties.SSESpecification", issues); if (properties.SSESpecification.SSEEnabled !== false) cfn10Issue(issues, "Properties.SSESpecification.SSEEnabled", "Only the AWS-owned encryption descriptor SSEEnabled false is supported"); }
    }
  } else {
    for (const [position, replica] of properties.Replicas.entries()) if (cfn10Record(replica)) cfn10ExactKeys(replica, ["Region"], `Properties.Replicas.${position}`, issues);
    if (properties.GlobalSecondaryIndexes !== undefined) cfn10Issue(issues, "Properties.GlobalSecondaryIndexes", "GlobalSecondaryIndexes require the single-Region TableV2 profile");
    if (properties.SSESpecification !== undefined) cfn10Issue(issues, "Properties.SSESpecification", "SSESpecification requires the single-Region TableV2 profile");
    if (properties.StreamSpecification === undefined) cfn10Issue(issues, "Properties.StreamSpecification", "StreamSpecification is required for a multi-Region EVENTUAL global table");
  }
  if (properties.StreamSpecification !== undefined && cfn10Record(properties.StreamSpecification)) {
    cfn10ExactKeys(properties.StreamSpecification, ["StreamViewType"], "Properties.StreamSpecification", issues);
    if (!STREAM_VIEWS.has(String(properties.StreamSpecification.StreamViewType))) cfn10Issue(issues, "Properties.StreamSpecification.StreamViewType", "StreamViewType must be KEYS_ONLY, NEW_IMAGE, OLD_IMAGE, or NEW_AND_OLD_IMAGES");
  }
  return issues;
}

function canonicalKeys(value: unknown): readonly DynamoDbGlobalKeySchemaModel[] { return (value as Record<string, unknown>[]).map(key => ({ AttributeName: String(key.AttributeName), KeyType: String(key.KeyType) as DynamoDbGlobalKeySchemaModel["KeyType"] })).sort((a, b) => a.KeyType === b.KeyType ? a.AttributeName.localeCompare(b.AttributeName) : a.KeyType === "HASH" ? -1 : 1); }
function canonicalDefinitions(value: unknown): readonly DynamoDbGlobalAttributeDefinitionModel[] { return (value as Record<string, unknown>[]).map(item => ({ AttributeName: String(item.AttributeName), AttributeType: String(item.AttributeType) as DynamoDbGlobalAttributeDefinitionModel["AttributeType"] })).sort((a, b) => a.AttributeName.localeCompare(b.AttributeName)); }
function canonicalIndexes(value: unknown): readonly DynamoDbGlobalIndexModel[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => item as Record<string, unknown>).map(index => ({ IndexName: String(index.IndexName), KeySchema: canonicalKeys(index.KeySchema), Projection: stable({ ProjectionType: String((index.Projection as any).ProjectionType) as DynamoDbGlobalIndexModel["Projection"]["ProjectionType"], ...(Array.isArray((index.Projection as any).NonKeyAttributes) ? { NonKeyAttributes: [...(index.Projection as any).NonKeyAttributes].map(String).sort() } : {}) }) })).sort((a, b) => a.IndexName.localeCompare(b.IndexName));
}
function richReplica(region: string, source: Record<string, unknown>, indexes: readonly DynamoDbGlobalIndexModel[]): DynamoDbGlobalReplicaModel {
  const requestedPitr = cfn10Record(source.PointInTimeRecoverySpecification) ? source.PointInTimeRecoverySpecification : undefined; const enabled = requestedPitr?.PointInTimeRecoveryEnabled === true;
  return stable({ Region: region, DeletionProtectionEnabled: Boolean(source.DeletionProtectionEnabled ?? false), GlobalSecondaryIndexes: indexes.map(index => ({ IndexName: index.IndexName })), PointInTimeRecoverySpecification: enabled ? { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: Number(requestedPitr?.RecoveryPeriodInDays ?? 35) } : { PointInTimeRecoveryEnabled: false }, TableClass: String(source.TableClass ?? "STANDARD") as DynamoDbGlobalReplicaModel["TableClass"], Tags: cfn10Tags(source.Tags, 49) });
}
function model(properties: Record<string, unknown>, context: ProviderContext): DynamoDbGlobalTableModel {
  const indexes = canonicalIndexes(properties.GlobalSecondaryIndexes); const replicaInput = properties.Replicas as Record<string, unknown>[]; const replicas = replicaInput.map(replica => ({ Region: String(replica.Region) })).sort((a, b) => a.Region.localeCompare(b.Region)); const singleton = replicas.length === 1;
  return stable({ TableName: String(properties.TableName ?? cfn10GeneratedName(context, "", 255)), AttributeDefinitions: canonicalDefinitions(properties.AttributeDefinitions), BillingMode: "PAY_PER_REQUEST", KeySchema: canonicalKeys(properties.KeySchema), ...(singleton && indexes.length ? { GlobalSecondaryIndexes: indexes } : {}), Replicas: singleton ? [richReplica(context.region, replicaInput[0], indexes)] : replicas, ...(singleton ? { SSESpecification: { SSEEnabled: false as const } } : {}), ...(cfn10Record(properties.StreamSpecification) ? { StreamSpecification: { StreamViewType: String(properties.StreamSpecification.StreamViewType) as NonNullable<DynamoDbGlobalTableModel["StreamSpecification"]>["StreamViewType"] } } : {}) });
}
function normalizedPersisted(value: DynamoDbGlobalTableModel): DynamoDbGlobalTableModel {
  if (value.Replicas.length !== 1) return value; const indexes = value.GlobalSecondaryIndexes ?? []; const replica = value.Replicas[0] as DynamoDbGlobalReplicaModel;
  return stable({ ...value, ...(indexes.length ? { GlobalSecondaryIndexes: indexes } : {}), Replicas: [richReplica(replica.Region, replica as unknown as Record<string, unknown>, indexes)], SSESpecification: { SSEEnabled: false as const } });
}

interface Snapshot { readonly model: DynamoDbGlobalTableModel; readonly arn: string; readonly tableId: string; readonly streamArn?: string; readonly tags: readonly { Key: string; Value: string }[]; readonly active: boolean; }
function success(snapshot: Snapshot): ProviderSuccess<DynamoDbGlobalTableModel> { return { status: "SUCCESS", physicalId: snapshot.model.TableName, model: { physicalId: snapshot.model.TableName, properties: snapshot.model, attributes: { Arn: snapshot.arn, ...(snapshot.streamArn ? { StreamArn: snapshot.streamArn } : {}), TableId: snapshot.tableId } } }; }
function inProgress(physicalId: string, phase: string, callbackContext: Record<string, unknown> = { phase }): ProviderInProgress { return { status: "IN_PROGRESS", callbackAfterMs: 25, checkpoint: { schemaVersion: 1, callbackContext: stable({ phase, ...callbackContext }), physicalId }, message: phase }; }
function indexStructure(index: DynamoDbGlobalIndexModel): unknown { return { IndexName: index.IndexName, KeySchema: index.KeySchema, Projection: index.Projection }; }
function intersection(value: DynamoDbGlobalTableModel): boolean {
  const current = normalizedPersisted(value); const tableKeys = new Set(current.KeySchema.map(key => key.AttributeName));
  if ((current.GlobalSecondaryIndexes?.length ?? 0) !== 0 || !current.AttributeDefinitions.every(def => tableKeys.has(def.AttributeName))) return false;
  if (profile(current) === "MULTI_REGION_BARE") return current.SSESpecification === undefined && current.Replicas.every(replica => Object.keys(replica).length === 1);
  const replica = current.Replicas[0];
  return cfn10Same(current.SSESpecification, { SSEEnabled: false }) && replica.DeletionProtectionEnabled === false && replica.TableClass === "STANDARD" && replica.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled === false && (replica.Tags?.length ?? 0) === 0;
}
function structuralAdmission(previous: DynamoDbGlobalTableModel, desired: DynamoDbGlobalTableModel): string | undefined {
  const before = normalizedPersisted(previous); const after = normalizedPersisted(desired);
  if (profile(before) !== profile(after)) return intersection(before) && intersection(after) ? undefined : "Profile transitions require a separate deployment through the bare single-Region intersection";
  if (profile(after) !== "SINGLE_REGION_TABLE_V2") return undefined;
  const oldIndexes = new Map((before.GlobalSecondaryIndexes ?? []).map(index => [index.IndexName, index])); const newIndexes = new Map((after.GlobalSecondaryIndexes ?? []).map(index => [index.IndexName, index]));
  const removed = [...oldIndexes].filter(([name]) => !newIndexes.has(name)); const added = [...newIndexes].filter(([name]) => !oldIndexes.has(name)); const modified = [...oldIndexes].filter(([name, index]) => newIndexes.has(name) && !cfn10Same(indexStructure(index), indexStructure(newIndexes.get(name)!)));
  if (modified.length) return `Global secondary index ${modified[0][0]} cannot change key schema or projection in place; delete it in one deployment and add it in a later deployment`;
  if (removed.length + added.length > 1) return "A GlobalTable update may add or delete only one global secondary index";
  if (removed.length || added.length) {
    const allowed = new Set(["AttributeDefinitions", "GlobalSecondaryIndexes", "Replicas"]); const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !cfn10Same((before as any)[key], (after as any)[key]));
    if (changed.some(key => !allowed.has(key))) return "A global secondary index add/delete cannot be combined with another rich setting change";
    const withoutIndexes = (replica: DynamoDbGlobalReplicaModel) => ({ ...replica, GlobalSecondaryIndexes: [] }); if (!cfn10Same(withoutIndexes(before.Replicas[0]), withoutIndexes(after.Replicas[0]))) return "A global secondary index add/delete cannot be combined with another replica setting change";
  }
  return undefined;
}

export function createDynamoDbGlobalTableProvider(dynamodb: DynamoDbService): ProductionResourceProvider<DynamoDbGlobalTableModel> {
  const describeBase = async (name: string, context: ProviderContext): Promise<{ table: any; tags: Array<{ Key: string; Value: string }>; regions: string[] }> => {
    const table = (await dynamodb.DescribeTable({ TableName: name })).Table; const tags = ((await dynamodb.ListTagsOfResource({ ResourceArn: table.TableArn })).Tags ?? []) as Array<{ Key: string; Value: string }>;
    const regions = Array.isArray(table.Replicas) && table.Replicas.length ? table.Replicas.map((replica: any) => String(replica.RegionName)).sort() : [context.region]; return { table, tags, regions };
  };
  const describe = async (name: string, context: ProviderContext, expected?: Profile): Promise<Snapshot> => {
    const { table, tags, regions } = await describeBase(name, context); const observed: Profile = regions.length === 1 ? "SINGLE_REGION_TABLE_V2" : "MULTI_REGION_BARE"; const selected = expected ?? observed;
    if ((table.SSEDescription?.SSEType ?? "AES256") !== "AES256" || table.SSEDescription?.KMSMasterKeyArn) throw new AwsError("KmsDependency", `Global table ${name} uses unsupported KMS encryption`);
    if ((table.BillingModeSummary?.BillingMode ?? "PROVISIONED") !== "PAY_PER_REQUEST") throw new AwsError("ConfigurationConflict", `Global table ${name} is not PAY_PER_REQUEST`);
    const indexes = canonicalIndexes(table.GlobalSecondaryIndexes); const userTags = cfn10UserTags(tags);
    if (selected === "MULTI_REGION_BARE" && (indexes.length || table.DeletionProtectionEnabled || (table.TableClassSummary?.TableClass ?? "STANDARD") !== "STANDARD" || userTags.length)) throw new AwsError("ConfigurationConflict", `Global table ${name} has rich settings that cannot be projected by MULTI_REGION_BARE`);
    if (selected === "SINGLE_REGION_TABLE_V2" && regions.length !== 1 && context.callbackContext?.transition !== true) throw new AwsError("ConfigurationConflict", `Global table ${name} has remote membership and cannot be projected by SINGLE_REGION_TABLE_V2`);
    let replicas: readonly DynamoDbGlobalReplicaModel[] = regions.map(Region => ({ Region })); let sse: DynamoDbGlobalTableModel["SSESpecification"];
    if (selected === "SINGLE_REGION_TABLE_V2") {
      const backup = (await dynamodb.DescribeContinuousBackups({ TableName: name })).ContinuousBackupsDescription?.PointInTimeRecoveryDescription ?? {}; const enabled = backup.PointInTimeRecoveryStatus === "ENABLED";
      replicas = [stable({ Region: context.region, DeletionProtectionEnabled: Boolean(table.DeletionProtectionEnabled), GlobalSecondaryIndexes: indexes.map(index => ({ IndexName: index.IndexName })), PointInTimeRecoverySpecification: enabled ? { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: Number(backup.RecoveryPeriodInDays ?? 35) } : { PointInTimeRecoveryEnabled: false }, TableClass: String(table.TableClassSummary?.TableClass ?? "STANDARD"), Tags: userTags }) as DynamoDbGlobalReplicaModel]; sse = { SSEEnabled: false };
    }
    const current = stable({ TableName: String(table.TableName), AttributeDefinitions: canonicalDefinitions(table.AttributeDefinitions), BillingMode: "PAY_PER_REQUEST", ...(indexes.length ? { GlobalSecondaryIndexes: indexes } : {}), KeySchema: canonicalKeys(table.KeySchema), Replicas: replicas, ...(sse ? { SSESpecification: sse } : {}), ...(table.StreamSpecification?.StreamEnabled ? { StreamSpecification: { StreamViewType: String(table.StreamSpecification.StreamViewType) } } : {}) }) as DynamoDbGlobalTableModel;
    return { model: current, arn: String(table.TableArn), tableId: String(table.TableId), ...(table.LatestStreamArn ? { streamArn: String(table.LatestStreamArn) } : {}), tags, active: table.TableStatus === "ACTIVE" && (table.GlobalSecondaryIndexes ?? []).every((index: any) => (index.IndexStatus ?? "ACTIVE") === "ACTIVE") && (table.Replicas ?? []).every((replica: any) => replica.ReplicaStatus === "ACTIVE") };
  };
  const ownershipFailure = (snapshot: Snapshot, context: ProviderContext): ProviderUpdateResult<DynamoDbGlobalTableModel> | undefined => cfn10Owned(snapshot.tags, context) ? undefined : { status: "FAILED", errorCode: "OwnershipConflict", message: `Global table ${snapshot.model.TableName} is not owned by this stack resource` };
  const reconcileMembership = async (physicalId: string, desired: DynamoDbGlobalTableModel, context: ProviderContext, transition = false): Promise<ProviderUpdateResult<DynamoDbGlobalTableModel>> => {
    const base = await describeBase(physicalId, context); if (!cfn10Owned(base.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Global table ${physicalId} is not owned by this stack resource` };
    if (base.table.TableStatus !== "ACTIVE" || (base.table.Replicas ?? []).some((replica: any) => replica.ReplicaStatus !== "ACTIVE")) return inProgress(physicalId, "Waiting for the global table to become ACTIVE", transition ? { transition: true } : undefined);
    const existing = new Set(base.regions); const wanted = new Set(desired.Replicas.map(replica => replica.Region)); const removal = [...existing].filter(region => region !== context.region && !wanted.has(region)).sort()[0];
    if (removal) { await dynamodb.UpdateTable({ TableName: physicalId, MultiRegionConsistency: "EVENTUAL", ReplicaUpdates: [{ Delete: { RegionName: removal } }] }); return inProgress(physicalId, `Removing replica ${removal}`, transition ? { transition: true } : undefined); }
    const addition = [...wanted].filter(region => region !== context.region && !existing.has(region)).sort()[0]; if (addition) { await dynamodb.UpdateTable({ TableName: physicalId, MultiRegionConsistency: "EVENTUAL", ReplicaUpdates: [{ Create: { RegionName: addition } }] }); return inProgress(physicalId, `Creating replica ${addition}`, transition ? { transition: true } : undefined); }
    return success(await describe(physicalId, context, profile(desired)));
  };
  const reconcileRich = async (physicalId: string, desired: DynamoDbGlobalTableModel, context: ProviderContext, previous?: DynamoDbGlobalTableModel): Promise<ProviderUpdateResult<DynamoDbGlobalTableModel>> => {
    const current = await describe(physicalId, context, "SINGLE_REGION_TABLE_V2"); const conflict = ownershipFailure(current, context); if (conflict) return conflict;
    if (!current.active) return inProgress(physicalId, "Waiting for the table and indexes to become ACTIVE");
    if (physicalId !== desired.TableName || !cfn10Same(current.model.KeySchema, desired.KeySchema) || !cfn10Same(current.model.StreamSpecification, desired.StreamSpecification)) return { status: "FAILED", errorCode: "RequiresReplacement", message: "TableName, KeySchema, and StreamSpecification changes require replacement" };
    if (previous) { const admission = structuralAdmission(previous, desired); if (admission) return { status: "FAILED", errorCode: "UnsupportedUpdate", message: admission }; }
    const wantedReplica = desired.Replicas[0]; const actualReplica = current.model.Replicas[0];
    if (actualReplica.DeletionProtectionEnabled && !wantedReplica.DeletionProtectionEnabled) { await dynamodb.UpdateTable({ TableName: physicalId, DeletionProtectionEnabled: false }); return inProgress(physicalId, "Disabling deletion protection"); }
    const actualIndexes = new Map((current.model.GlobalSecondaryIndexes ?? []).map(index => [index.IndexName, index])); const wantedIndexes = new Map((desired.GlobalSecondaryIndexes ?? []).map(index => [index.IndexName, index]));
    for (const [name, index] of actualIndexes) if (wantedIndexes.has(name) && !cfn10Same(indexStructure(index), indexStructure(wantedIndexes.get(name)!))) return { status: "FAILED", errorCode: "UnsupportedUpdate", message: `Global secondary index ${name} cannot change key schema or projection in place` };
    const remove = [...actualIndexes.keys()].filter(name => !wantedIndexes.has(name)).sort()[0]; if (remove) { await dynamodb.UpdateTable({ TableName: physicalId, GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: remove } }] }); return inProgress(physicalId, `Deleting global secondary index ${remove}`); }
    const add = [...wantedIndexes.keys()].filter(name => !actualIndexes.has(name)).sort()[0]; if (add) { const index = wantedIndexes.get(add)!; const known = new Set(current.model.AttributeDefinitions.map(definition => definition.AttributeName)); const keys = new Set(index.KeySchema.map(key => key.AttributeName)); const additions = desired.AttributeDefinitions.filter(definition => keys.has(definition.AttributeName) && !known.has(definition.AttributeName)); await dynamodb.UpdateTable({ TableName: physicalId, ...(additions.length ? { AttributeDefinitions: additions } : {}), GlobalSecondaryIndexUpdates: [{ Create: index }] }); return inProgress(physicalId, `Creating global secondary index ${add}`); }
    if (actualReplica.TableClass !== wantedReplica.TableClass) { await dynamodb.UpdateTable({ TableName: physicalId, TableClass: wantedReplica.TableClass }); return inProgress(physicalId, "Updating table class"); }
    const actualTags = Object.fromEntries((actualReplica.Tags ?? []).map(tag => [tag.Key, tag.Value])); const wantedTags = Object.fromEntries((wantedReplica.Tags ?? []).map(tag => [tag.Key, tag.Value])); const removals = Object.keys(actualTags).filter(key => !Object.hasOwn(wantedTags, key)).sort();
    if (removals.length) { await dynamodb.UntagResource({ ResourceArn: current.arn, TagKeys: removals }); return inProgress(physicalId, "Removing replica tags"); }
    const changes = Object.entries(wantedTags).filter(([key, value]) => actualTags[key] !== value).map(([Key, Value]) => ({ Key, Value })); if (changes.length) { await dynamodb.TagResource({ ResourceArn: current.arn, Tags: changes }); return inProgress(physicalId, "Updating replica tags"); }
    if (!cfn10Same(actualReplica.PointInTimeRecoverySpecification, wantedReplica.PointInTimeRecoverySpecification)) { const wanted = wantedReplica.PointInTimeRecoverySpecification!; await dynamodb.UpdateContinuousBackups({ TableName: physicalId, PointInTimeRecoverySpecification: wanted.PointInTimeRecoveryEnabled ? { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: wanted.RecoveryPeriodInDays } : { PointInTimeRecoveryEnabled: false } }); return inProgress(physicalId, "Updating point-in-time recovery"); }
    if (!actualReplica.DeletionProtectionEnabled && wantedReplica.DeletionProtectionEnabled) { await dynamodb.UpdateTable({ TableName: physicalId, DeletionProtectionEnabled: true }); return inProgress(physicalId, "Enabling deletion protection"); }
    return success(await describe(physicalId, context, "SINGLE_REGION_TABLE_V2"));
  };

  return {
    typeName: DYNAMODB_GLOBAL_TABLE_TYPE, providerVersion: 1, visibility: "production", schema: DYNAMODB_GLOBAL_TABLE_SCHEMA,
    validate(properties, context) { return validation(properties, context); },
    canonicalize(properties, context) { if (!cfn10Record(properties)) throw new TypeError(`${DYNAMODB_GLOBAL_TABLE_TYPE} Properties must be an object`); const issues = validation(properties, context); if (issues.length) throw new TypeError(issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")); return model(properties, context); },
    plan(previous, desired): ProviderPlan<DynamoDbGlobalTableModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const before = normalizedPersisted(previous); const changed = [...new Set([...Object.keys(before), ...Object.keys(desired)])].filter(key => !cfn10Same((before as any)[key], (desired as any)[key])).sort(); if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      const replacements = ["TableName", "KeySchema", "StreamSpecification"].filter(key => !cfn10Same((before as any)[key], (desired as any)[key])); if (!replacements.length) { const reason = structuralAdmission(before, desired); return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [], ...(reason ? { reason } : {}) }; }
      return { action: "REPLACE", desired, changedProperties: changed, replacementProperties: replacements, replacementOrder: before.TableName === desired.TableName ? "DELETE_BEFORE_CREATE" : "CREATE_BEFORE_DELETE", ...(before.TableName === desired.TableName ? { reason: "DynamoDB table names are unique within an account and Region" } : {}) };
    },
    async create(desired, context) {
      try {
        try { const existing = await describe(desired.TableName, context, profile(desired)); if (!cfn10Owned(existing.tags, context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Table ${desired.TableName} already exists and is not owned by this stack resource` }; return profile(desired) === "SINGLE_REGION_TABLE_V2" ? reconcileRich(desired.TableName, desired, context) : reconcileMembership(desired.TableName, desired, context); } catch (error) { if (!cfn10Missing(error)) throw error; }
        const singleton = profile(desired) === "SINGLE_REGION_TABLE_V2"; const replica = desired.Replicas[0]; await dynamodb.CreateTable({ TableName: desired.TableName, AttributeDefinitions: desired.AttributeDefinitions, KeySchema: desired.KeySchema, BillingMode: "PAY_PER_REQUEST", ...(desired.GlobalSecondaryIndexes?.length ? { GlobalSecondaryIndexes: desired.GlobalSecondaryIndexes } : {}), ...(desired.StreamSpecification ? { StreamSpecification: { StreamEnabled: true, StreamViewType: desired.StreamSpecification.StreamViewType } } : {}), SSESpecification: { Enabled: false }, ...(singleton ? { TableClass: replica.TableClass, DeletionProtectionEnabled: false } : {}), Tags: cfn10ServiceTags(singleton ? replica.Tags ?? [] : [], context) }); return inProgress(desired.TableName, singleton ? "Creating single-Region TableV2" : "Creating global-table replicas");
      } catch (error) { return cfn10Failure(error); }
    },
    async read(physicalId, context): Promise<ProviderReadResult<DynamoDbGlobalTableModel>> { try { const current = await describe(physicalId, context); const conflict = ownershipFailure(current, context); return conflict ?? success(current); } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error); } },
    async update(physicalId, previous, desired, context) {
      try {
        const before = normalizedPersisted(previous); const admission = structuralAdmission(before, desired); if (admission) return { status: "FAILED", errorCode: "UnsupportedUpdate", message: admission };
        if (profile(before) !== profile(desired)) { if (context.callbackContext?.transition !== true) return inProgress(physicalId, "Preparing GlobalTable profile transition", { transition: true, sourceProfile: profile(before), destinationProfile: profile(desired), previousReplicas: before.Replicas.map(item => item.Region), desiredReplicas: desired.Replicas.map(item => item.Region), nextMembershipMutation: "AUTHORITATIVE_READ" }); return reconcileMembership(physicalId, desired, context, true); }
        return profile(desired) === "SINGLE_REGION_TABLE_V2" ? reconcileRich(physicalId, desired, context, before) : reconcileMembership(physicalId, desired, context);
      } catch (error) { return cfn10Failure(error); }
    },
    async delete(physicalId, previous, context): Promise<ProviderDeleteResult> {
      try { const current = await describe(physicalId, context, profile(normalizedPersisted(previous))); if (!cfn10Owned(current.tags, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Global table ${physicalId} is not owned by this stack resource` }; if (!current.active) return inProgress(physicalId, "Waiting for the global table to become ACTIVE"); const remote = current.model.Replicas.map(item => item.Region).filter(region => region !== context.region).sort()[0]; if (remote) { await dynamodb.UpdateTable({ TableName: physicalId, MultiRegionConsistency: "EVENTUAL", ReplicaUpdates: [{ Delete: { RegionName: remote } }] }); return inProgress(physicalId, `Removing replica ${remote}`); } await dynamodb.DeleteTable({ TableName: physicalId }); return { status: "SUCCESS", physicalId }; } catch (error) { return cfn10Missing(error) ? { status: "NOT_FOUND", physicalId } : cfn10Failure(error) as ProviderDeleteResult; }
    },
    ref(current: ProviderReadModel<DynamoDbGlobalTableModel>): unknown { return current.physicalId; },
    getAtt(current, attribute): unknown { return cfn10GetAtt(DYNAMODB_GLOBAL_TABLE_TYPE, DYNAMODB_GLOBAL_TABLE_SCHEMA, current, attribute); },
  };
}
