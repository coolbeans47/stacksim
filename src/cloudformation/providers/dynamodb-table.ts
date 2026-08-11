import { createHash } from "node:crypto";
import { DYNAMODB_DEFAULT_WARM_THROUGHPUT, type DynamoDbService } from "../../dynamodb.js";
import { AwsError } from "../../errors.js";
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

export const DYNAMODB_TABLE_TYPE = "AWS::DynamoDB::Table";

const STREAM_VIEWS = new Set(["KEYS_ONLY", "NEW_IMAGE", "OLD_IMAGE", "NEW_AND_OLD_IMAGES"]);
const CONTRIBUTOR_MODES = new Set(["ACCESSED_AND_THROTTLED_KEYS", "THROTTLED_KEYS"]);
const OWNER_TAG = "stacksim:cloudformation:owner";
const OWNER_TAG_PREFIX = "stacksim:cloudformation:";

export interface DynamoDbAttributeDefinitionModel {
  readonly AttributeName: string;
  readonly AttributeType: "S" | "N" | "B";
}

export interface DynamoDbKeySchemaModel {
  readonly AttributeName: string;
  readonly KeyType: "HASH" | "RANGE";
}

export interface DynamoDbThroughputModel {
  readonly ReadCapacityUnits: number;
  readonly WriteCapacityUnits: number;
}

export interface DynamoDbOnDemandThroughputModel {
  readonly MaxReadRequestUnits?: number;
  readonly MaxWriteRequestUnits?: number;
}

export interface DynamoDbWarmThroughputModel {
  readonly ReadUnitsPerSecond: number;
  readonly WriteUnitsPerSecond: number;
}

export interface DynamoDbContributorInsightsModel {
  readonly Enabled: true;
  readonly Mode: "ACCESSED_AND_THROTTLED_KEYS" | "THROTTLED_KEYS";
}

export interface DynamoDbProjectionModel {
  readonly ProjectionType: "ALL" | "KEYS_ONLY" | "INCLUDE";
  readonly NonKeyAttributes?: readonly string[];
}

export interface DynamoDbLocalSecondaryIndexModel {
  readonly IndexName: string;
  readonly KeySchema: readonly DynamoDbKeySchemaModel[];
  readonly Projection: DynamoDbProjectionModel;
}

export interface DynamoDbGlobalSecondaryIndexModel extends DynamoDbLocalSecondaryIndexModel {
  readonly ProvisionedThroughput?: DynamoDbThroughputModel;
  readonly OnDemandThroughput?: DynamoDbOnDemandThroughputModel;
  readonly WarmThroughput?: DynamoDbWarmThroughputModel;
  readonly ContributorInsightsSpecification?: DynamoDbContributorInsightsModel;
}

export interface DynamoDbTableModel {
  readonly TableName: string;
  readonly AttributeDefinitions: readonly DynamoDbAttributeDefinitionModel[];
  readonly KeySchema: readonly DynamoDbKeySchemaModel[];
  readonly BillingMode: "PROVISIONED" | "PAY_PER_REQUEST";
  readonly ProvisionedThroughput?: DynamoDbThroughputModel;
  readonly OnDemandThroughput?: DynamoDbOnDemandThroughputModel;
  readonly WarmThroughput?: DynamoDbWarmThroughputModel;
  readonly LocalSecondaryIndexes?: readonly DynamoDbLocalSecondaryIndexModel[];
  readonly GlobalSecondaryIndexes?: readonly DynamoDbGlobalSecondaryIndexModel[];
  readonly StreamSpecification?: {
    readonly StreamViewType: "KEYS_ONLY" | "NEW_IMAGE" | "OLD_IMAGE" | "NEW_AND_OLD_IMAGES";
    readonly ResourcePolicy?: Readonly<Record<string, unknown>>;
  };
  readonly TimeToLiveSpecification?: { readonly AttributeName: string; readonly Enabled: true };
  readonly PointInTimeRecoverySpecification?: { readonly PointInTimeRecoveryEnabled: true; readonly RecoveryPeriodInDays: number };
  readonly SSESpecification: { readonly SSEEnabled: false };
  readonly TableClass: "STANDARD" | "STANDARD_INFREQUENT_ACCESS";
  readonly DeletionProtectionEnabled: boolean;
  readonly ContributorInsightsSpecification?: DynamoDbContributorInsightsModel;
  readonly Tags: readonly { readonly Key: string; readonly Value: string }[];
  readonly ResourcePolicy?: Readonly<Record<string, unknown>>;
}

type DynamoDbStreamViewType = NonNullable<DynamoDbTableModel["StreamSpecification"]>["StreamViewType"];

export const DYNAMODB_TABLE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: DYNAMODB_TABLE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    AttributeDefinitions: Object.freeze({ valueType: "array", required: true, updateBehavior: "CONDITIONAL_REPLACEMENT" }),
    BillingMode: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    ContributorInsightsSpecification: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    DeletionProtectionEnabled: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
    GlobalSecondaryIndexes: Object.freeze({ valueType: "array", updateBehavior: "CONDITIONAL_REPLACEMENT" }),
    KeySchema: Object.freeze({ valueType: "array", required: true, updateBehavior: "REPLACEMENT" }),
    LocalSecondaryIndexes: Object.freeze({ valueType: "array", updateBehavior: "REPLACEMENT" }),
    OnDemandThroughput: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    PointInTimeRecoverySpecification: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    ProvisionedThroughput: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    ResourcePolicy: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    SSESpecification: Object.freeze({ valueType: "object", updateBehavior: "NOT_SUPPORTED" }),
    StreamSpecification: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    TableClass: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    TableName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    TimeToLiveSpecification: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    WarmThroughput: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Table name" }),
  attributes: Object.freeze({
    Arn: Object.freeze({ valueType: "string", description: "Table ARN" }),
    StreamArn: Object.freeze({ valueType: "string", description: "Latest stream ARN when streams are enabled" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: Object.freeze({
    deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    snapshotSupported: false,
  }),
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

interface PolicyState {
  readonly document: Readonly<Record<string, unknown>>;
  readonly revisionId: string;
}

interface DynamoDbTableSnapshot {
  readonly model: DynamoDbTableModel;
  readonly tableStatus: string;
  readonly globalIndexStatuses: readonly string[];
  readonly streamStatus?: string;
  readonly ttlStatus: string;
  readonly pitrStatus: string;
  readonly contributorStatus: string;
  readonly indexContributorStatuses: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly tablePolicy?: PolicyState;
  readonly streamPolicy?: PolicyState;
  readonly arn: string;
  readonly streamArn?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stable<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stable) as T;
  if (record(value)) return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)])) as T;
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function stackName(context: ProviderContext): string {
  return context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack";
}

function generatedName(context: ProviderContext): string {
  const suffix = createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex").slice(0, 12);
  const prefix = `${stackName(context)}-${context.logicalId}`.replace(/[^A-Za-z0-9_.-]/g, "-");
  return `${prefix.slice(0, Math.max(3, 255 - suffix.length - 1))}-${suffix}`;
}

function ownerValue(context: ProviderContext): string {
  return createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex");
}

function issue(issues: ProviderValidationIssue[], path: string, message: string, code: ProviderValidationIssue["code"] = "InvalidProperty"): void {
  issues.push({ code, path, message });
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: ProviderValidationIssue[]): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value).sort()) if (!set.has(key)) issue(issues, `${path}.${key}`, `${key} is not supported in ${path}`);
}

function validateThroughput(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!record(value)) return issue(issues, path, `${path} must be an object`);
  exactKeys(value, ["ReadCapacityUnits", "WriteCapacityUnits"], path, issues);
  for (const field of ["ReadCapacityUnits", "WriteCapacityUnits"] as const) if (!Number.isInteger(value[field]) || Number(value[field]) < 1) issue(issues, `${path}.${field}`, `${field} must be a positive integer`);
}

function validateOnDemand(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!record(value)) return issue(issues, path, `${path} must be an object`);
  exactKeys(value, ["MaxReadRequestUnits", "MaxWriteRequestUnits"], path, issues);
  if (value.MaxReadRequestUnits === undefined && value.MaxWriteRequestUnits === undefined) issue(issues, path, `${path} must specify at least one maximum`);
  for (const field of ["MaxReadRequestUnits", "MaxWriteRequestUnits"] as const) if (value[field] !== undefined && (!Number.isInteger(value[field]) || Number(value[field]) < 1)) issue(issues, `${path}.${field}`, `${field} must be a positive integer`);
}

function validateWarm(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!record(value)) return issue(issues, path, `${path} must be an object`);
  exactKeys(value, ["ReadUnitsPerSecond", "WriteUnitsPerSecond"], path, issues);
  for (const field of ["ReadUnitsPerSecond", "WriteUnitsPerSecond"] as const) if (!Number.isInteger(value[field]) || Number(value[field]) < 1) issue(issues, `${path}.${field}`, `${field} must be a positive integer in the local DynamoDB profile`);
}

function validateContributor(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!record(value)) return issue(issues, path, `${path} must be an object`);
  exactKeys(value, ["Enabled", "Mode"], path, issues);
  if (typeof value.Enabled !== "boolean") issue(issues, `${path}.Enabled`, "Enabled must be a boolean");
  if (value.Mode !== undefined && !CONTRIBUTOR_MODES.has(String(value.Mode))) issue(issues, `${path}.Mode`, "Mode must be ACCESSED_AND_THROTTLED_KEYS or THROTTLED_KEYS");
}

function validateProjection(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (!record(value)) return issue(issues, path, `${path} must be an object`);
  exactKeys(value, ["ProjectionType", "NonKeyAttributes"], path, issues);
  if (!new Set(["ALL", "KEYS_ONLY", "INCLUDE"]).has(String(value.ProjectionType))) issue(issues, `${path}.ProjectionType`, "ProjectionType must be ALL, KEYS_ONLY, or INCLUDE");
  if (value.NonKeyAttributes !== undefined && (!Array.isArray(value.NonKeyAttributes) || value.NonKeyAttributes.some(item => typeof item !== "string") || new Set(value.NonKeyAttributes).size !== value.NonKeyAttributes.length)) issue(issues, `${path}.NonKeyAttributes`, "NonKeyAttributes must be an array of unique strings");
  const values = Array.isArray(value.NonKeyAttributes) ? value.NonKeyAttributes : [];
  if (value.ProjectionType === "INCLUDE" && (values.length < 1 || values.length > 20)) issue(issues, `${path}.NonKeyAttributes`, "INCLUDE projections require between 1 and 20 NonKeyAttributes");
  if (value.ProjectionType !== "INCLUDE" && values.length) issue(issues, `${path}.NonKeyAttributes`, "NonKeyAttributes are valid only for INCLUDE projections");
}

function validateKeySchema(value: unknown, path: string, issues: ProviderValidationIssue[], local = false): void {
  if (!Array.isArray(value) || value.length < (local ? 2 : 1) || value.length > 2) return issue(issues, path, `${path} must contain ${local ? "HASH and RANGE" : "one HASH and at most one RANGE"} key`);
  for (const [index, key] of value.entries()) {
    const keyPath = `${path}.${index}`;
    if (!record(key)) { issue(issues, keyPath, "Key schema entries must be objects"); continue; }
    exactKeys(key, ["AttributeName", "KeyType"], keyPath, issues);
    if (typeof key.AttributeName !== "string" || !key.AttributeName.length || key.AttributeName.length > 255) issue(issues, `${keyPath}.AttributeName`, "AttributeName must contain between 1 and 255 characters");
    if (!new Set(["HASH", "RANGE"]).has(String(key.KeyType))) issue(issues, `${keyPath}.KeyType`, "KeyType must be HASH or RANGE");
  }
  const hashes = value.filter(item => record(item) && item.KeyType === "HASH");
  const ranges = value.filter(item => record(item) && item.KeyType === "RANGE");
  if (hashes.length !== 1 || ranges.length > 1 || (local && ranges.length !== 1)) issue(issues, path, `Invalid key schema for ${local ? "a local secondary index" : "the table or global secondary index"}`);
  const names = value.filter(record).map(item => item.AttributeName);
  if (new Set(names).size !== names.length) issue(issues, path, "Key schema attributes must be unique");
}

function validateIndexes(properties: Record<string, unknown>, issues: ProviderValidationIssue[]): void {
  const billing = String(properties.BillingMode ?? "PROVISIONED");
  const tableKeys = Array.isArray(properties.KeySchema) ? properties.KeySchema : [];
  const tableHash = tableKeys.find(item => record(item) && item.KeyType === "HASH") as Record<string, unknown> | undefined;
  const tableRange = tableKeys.find(item => record(item) && item.KeyType === "RANGE") as Record<string, unknown> | undefined;
  let projected = 0;
  const allIndexNames = new Set<string>();
  for (const [property, local, maximum] of [["LocalSecondaryIndexes", true, 5], ["GlobalSecondaryIndexes", false, 20]] as const) {
    const indexes = properties[property];
    if (indexes === undefined) continue;
    if (!Array.isArray(indexes) || indexes.length > maximum) { issue(issues, `Properties.${property}`, `${property} must contain at most ${maximum} entries`); continue; }
    const names = new Set<string>();
    for (const [position, item] of indexes.entries()) {
      const path = `Properties.${property}.${position}`;
      if (!record(item)) { issue(issues, path, "Index entries must be objects"); continue; }
      exactKeys(item, local ? ["IndexName", "KeySchema", "Projection"] : ["ContributorInsightsSpecification", "IndexName", "KeySchema", "OnDemandThroughput", "Projection", "ProvisionedThroughput", "WarmThroughput"], path, issues);
      if (typeof item.IndexName !== "string" || !/^[A-Za-z0-9_.-]{3,255}$/.test(item.IndexName)) issue(issues, `${path}.IndexName`, "IndexName must match [A-Za-z0-9_.-] and contain between 3 and 255 characters");
      else if (names.has(item.IndexName) || allIndexNames.has(item.IndexName)) issue(issues, `${path}.IndexName`, "Index names must be unique across local and global secondary indexes");
      else { names.add(item.IndexName); allIndexNames.add(item.IndexName); }
      validateKeySchema(item.KeySchema, `${path}.KeySchema`, issues, local);
      if (local && Array.isArray(item.KeySchema) && record(item.KeySchema[0]) && item.KeySchema.find(entry => record(entry) && entry.KeyType === "HASH")?.AttributeName !== tableHash?.AttributeName) issue(issues, `${path}.KeySchema`, "A local secondary index must use the table HASH key");
      if (local && Array.isArray(item.KeySchema) && item.KeySchema.find(entry => record(entry) && entry.KeyType === "RANGE")?.AttributeName === tableRange?.AttributeName) issue(issues, `${path}.KeySchema`, "A local secondary index must use an alternate RANGE key");
      validateProjection(item.Projection, `${path}.Projection`, issues);
      if (record(item.Projection) && Array.isArray(item.Projection.NonKeyAttributes)) projected += item.Projection.NonKeyAttributes.length;
      if (!local) {
        if (billing === "PROVISIONED") {
          if (item.ProvisionedThroughput === undefined) issue(issues, `${path}.ProvisionedThroughput`, "ProvisionedThroughput is required for a PROVISIONED global secondary index");
          else validateThroughput(item.ProvisionedThroughput, `${path}.ProvisionedThroughput`, issues);
          if (item.OnDemandThroughput !== undefined) issue(issues, `${path}.OnDemandThroughput`, "OnDemandThroughput is valid only in PAY_PER_REQUEST mode");
        } else {
          if (item.ProvisionedThroughput !== undefined) issue(issues, `${path}.ProvisionedThroughput`, "ProvisionedThroughput is not valid in PAY_PER_REQUEST mode");
          if (item.OnDemandThroughput !== undefined) validateOnDemand(item.OnDemandThroughput, `${path}.OnDemandThroughput`, issues);
        }
        if (item.WarmThroughput !== undefined) validateWarm(item.WarmThroughput, `${path}.WarmThroughput`, issues);
        if (item.ContributorInsightsSpecification !== undefined) validateContributor(item.ContributorInsightsSpecification, `${path}.ContributorInsightsSpecification`, issues);
      }
    }
  }
  if (projected > 100) issue(issues, "Properties.GlobalSecondaryIndexes", "At most 100 projected non-key attributes are supported across all indexes");
}

function validateNested(properties: Record<string, unknown>, context: ProviderContext): ProviderValidationIssue[] {
  const issues: ProviderValidationIssue[] = [];
  if (properties.TableName !== undefined && (typeof properties.TableName !== "string" || !/^[A-Za-z0-9_.-]{3,255}$/.test(properties.TableName))) issue(issues, "Properties.TableName", "TableName must match [A-Za-z0-9_.-] and contain between 3 and 255 characters");
  if (!properties.TableName && !/^[A-Za-z0-9_.-]{3,255}$/.test(generatedName(context))) issue(issues, "Properties.TableName", "The generated table name is invalid");

  if (Array.isArray(properties.AttributeDefinitions)) {
    const names = new Set<string>();
    for (const [index, item] of properties.AttributeDefinitions.entries()) {
      const path = `Properties.AttributeDefinitions.${index}`;
      if (!record(item)) { issue(issues, path, "Attribute definitions must be objects"); continue; }
      exactKeys(item, ["AttributeName", "AttributeType"], path, issues);
      if (typeof item.AttributeName !== "string" || !item.AttributeName.length || item.AttributeName.length > 255) issue(issues, `${path}.AttributeName`, "AttributeName must contain between 1 and 255 characters");
      else if (names.has(item.AttributeName)) issue(issues, `${path}.AttributeName`, "Attribute definitions must be unique"); else names.add(item.AttributeName);
      if (!new Set(["S", "N", "B"]).has(String(item.AttributeType))) issue(issues, `${path}.AttributeType`, "AttributeType must be S, N, or B");
    }
  }
  validateKeySchema(properties.KeySchema, "Properties.KeySchema", issues);
  const billing = String(properties.BillingMode ?? "PROVISIONED");
  if (!new Set(["PROVISIONED", "PAY_PER_REQUEST"]).has(billing)) issue(issues, "Properties.BillingMode", "BillingMode must be PROVISIONED or PAY_PER_REQUEST");
  if (billing === "PROVISIONED") {
    if (properties.ProvisionedThroughput === undefined) issue(issues, "Properties.ProvisionedThroughput", "ProvisionedThroughput is required in PROVISIONED mode");
    else validateThroughput(properties.ProvisionedThroughput, "Properties.ProvisionedThroughput", issues);
    if (properties.OnDemandThroughput !== undefined) issue(issues, "Properties.OnDemandThroughput", "OnDemandThroughput is valid only in PAY_PER_REQUEST mode");
  } else {
    if (properties.ProvisionedThroughput !== undefined) issue(issues, "Properties.ProvisionedThroughput", "ProvisionedThroughput is not valid in PAY_PER_REQUEST mode");
    if (properties.OnDemandThroughput !== undefined) validateOnDemand(properties.OnDemandThroughput, "Properties.OnDemandThroughput", issues);
  }
  if (properties.WarmThroughput !== undefined) validateWarm(properties.WarmThroughput, "Properties.WarmThroughput", issues);
  validateIndexes(properties, issues);

  const used = new Set<string>();
  for (const key of [properties.KeySchema, ...(Array.isArray(properties.LocalSecondaryIndexes) ? properties.LocalSecondaryIndexes.map(item => record(item) ? item.KeySchema : []) : []), ...(Array.isArray(properties.GlobalSecondaryIndexes) ? properties.GlobalSecondaryIndexes.map(item => record(item) ? item.KeySchema : []) : [])]) if (Array.isArray(key)) for (const entry of key) if (record(entry) && typeof entry.AttributeName === "string") used.add(entry.AttributeName);
  const definitions = Array.isArray(properties.AttributeDefinitions) ? properties.AttributeDefinitions.filter(record).map(item => String(item.AttributeName)) : [];
  if (definitions.some(name => !used.has(name)) || [...used].some(name => !definitions.includes(name))) issue(issues, "Properties.AttributeDefinitions", "AttributeDefinitions must exactly match attributes used by the table and index key schemas");

  if (properties.StreamSpecification !== undefined) {
    if (!record(properties.StreamSpecification)) issue(issues, "Properties.StreamSpecification", "StreamSpecification must be an object");
    else {
      exactKeys(properties.StreamSpecification, ["ResourcePolicy", "StreamViewType"], "Properties.StreamSpecification", issues);
      if (!STREAM_VIEWS.has(String(properties.StreamSpecification.StreamViewType))) issue(issues, "Properties.StreamSpecification.StreamViewType", "StreamViewType must be KEYS_ONLY, NEW_IMAGE, OLD_IMAGE, or NEW_AND_OLD_IMAGES");
      if (properties.StreamSpecification.ResourcePolicy !== undefined && !record(properties.StreamSpecification.ResourcePolicy)) issue(issues, "Properties.StreamSpecification.ResourcePolicy", "Stream resource policy must be a JSON object");
      else if (record(properties.StreamSpecification.ResourcePolicy) && Buffer.byteLength(JSON.stringify(properties.StreamSpecification.ResourcePolicy)) > 20 * 1024) issue(issues, "Properties.StreamSpecification.ResourcePolicy", "Stream resource policy must not exceed 20 KiB");
    }
  }
  if (properties.TimeToLiveSpecification !== undefined) {
    if (!record(properties.TimeToLiveSpecification)) issue(issues, "Properties.TimeToLiveSpecification", "TimeToLiveSpecification must be an object");
    else {
      exactKeys(properties.TimeToLiveSpecification, ["AttributeName", "Enabled"], "Properties.TimeToLiveSpecification", issues);
      if (typeof properties.TimeToLiveSpecification.Enabled !== "boolean") issue(issues, "Properties.TimeToLiveSpecification.Enabled", "Enabled must be a boolean");
      if (typeof properties.TimeToLiveSpecification.AttributeName !== "string" || !properties.TimeToLiveSpecification.AttributeName.length || properties.TimeToLiveSpecification.AttributeName.length > 255) issue(issues, "Properties.TimeToLiveSpecification.AttributeName", "AttributeName is required and must contain between 1 and 255 characters");
    }
  }
  if (properties.PointInTimeRecoverySpecification !== undefined) {
    if (!record(properties.PointInTimeRecoverySpecification)) issue(issues, "Properties.PointInTimeRecoverySpecification", "PointInTimeRecoverySpecification must be an object");
    else {
      exactKeys(properties.PointInTimeRecoverySpecification, ["PointInTimeRecoveryEnabled", "RecoveryPeriodInDays"], "Properties.PointInTimeRecoverySpecification", issues);
      if (typeof properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled !== "boolean") issue(issues, "Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled", "PointInTimeRecoveryEnabled must be a boolean in the local profile");
      if (properties.PointInTimeRecoverySpecification.RecoveryPeriodInDays !== undefined && (!Number.isInteger(properties.PointInTimeRecoverySpecification.RecoveryPeriodInDays) || Number(properties.PointInTimeRecoverySpecification.RecoveryPeriodInDays) < 1 || Number(properties.PointInTimeRecoverySpecification.RecoveryPeriodInDays) > 35)) issue(issues, "Properties.PointInTimeRecoverySpecification.RecoveryPeriodInDays", "RecoveryPeriodInDays must be between 1 and 35");
      if (properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled === false && properties.PointInTimeRecoverySpecification.RecoveryPeriodInDays !== undefined) issue(issues, "Properties.PointInTimeRecoverySpecification.RecoveryPeriodInDays", "RecoveryPeriodInDays cannot be set while PITR is disabled");
    }
  }
  if (properties.ContributorInsightsSpecification !== undefined) validateContributor(properties.ContributorInsightsSpecification, "Properties.ContributorInsightsSpecification", issues);
  if (properties.SSESpecification !== undefined) {
    if (!record(properties.SSESpecification)) issue(issues, "Properties.SSESpecification", "SSESpecification must be an object");
    else {
      exactKeys(properties.SSESpecification, ["KMSMasterKeyId", "SSEEnabled", "SSEType"], "Properties.SSESpecification", issues);
      if (properties.SSESpecification.SSEEnabled !== false) issue(issues, "Properties.SSESpecification.SSEEnabled", "CFN-08 supports only the default AWS-owned encryption descriptor (SSEEnabled false); AWS managed/customer KMS encryption is unavailable");
      if (properties.SSESpecification.SSEType !== undefined || properties.SSESpecification.KMSMasterKeyId !== undefined) issue(issues, "Properties.SSESpecification", "SSEType and KMSMasterKeyId require unavailable KMS semantics");
    }
  }
  if (properties.TableClass !== undefined && !new Set(["STANDARD", "STANDARD_INFREQUENT_ACCESS"]).has(String(properties.TableClass))) issue(issues, "Properties.TableClass", "TableClass must be STANDARD or STANDARD_INFREQUENT_ACCESS");
  if (properties.ResourcePolicy !== undefined) {
    if (!record(properties.ResourcePolicy)) issue(issues, "Properties.ResourcePolicy", "ResourcePolicy must be a JSON object");
    else if (Buffer.byteLength(JSON.stringify(properties.ResourcePolicy)) > 20 * 1024) issue(issues, "Properties.ResourcePolicy", "ResourcePolicy must not exceed 20 KiB");
  }
  if (properties.Tags !== undefined) {
    if (!Array.isArray(properties.Tags)) issue(issues, "Properties.Tags", "Tags must be an array");
    else {
      const keys = new Set<string>();
      if (properties.Tags.length > 49) issue(issues, "Properties.Tags", "At most 49 user tags are supported because one private ownership tag is required for retry safety");
      for (const [index, item] of properties.Tags.entries()) {
        const path = `Properties.Tags.${index}`;
        if (!record(item) || typeof item.Key !== "string" || typeof item.Value !== "string") { issue(issues, path, "Each tag requires string Key and Value"); continue; }
        exactKeys(item, ["Key", "Value"], path, issues);
        if (!item.Key.length || item.Key.length > 128 || item.Value.length > 256 || item.Key.toLowerCase().startsWith("aws:") || item.Key.toLowerCase().startsWith(OWNER_TAG_PREFIX) || keys.has(item.Key)) issue(issues, path, "Tags require unique valid non-reserved keys and values");
        keys.add(item.Key);
      }
    }
  }
  return issues;
}

function canonicalKeySchema(value: unknown): readonly DynamoDbKeySchemaModel[] {
  return (value as Array<Record<string, unknown>>).map(item => ({ AttributeName: String(item.AttributeName), KeyType: String(item.KeyType) as "HASH" | "RANGE" })).sort((left, right) => left.KeyType === right.KeyType ? left.AttributeName.localeCompare(right.AttributeName) : left.KeyType === "HASH" ? -1 : 1);
}

function canonicalProjection(value: unknown): DynamoDbProjectionModel {
  const projection = value as Record<string, unknown>;
  return { ProjectionType: String(projection.ProjectionType) as DynamoDbProjectionModel["ProjectionType"], ...(Array.isArray(projection.NonKeyAttributes) ? { NonKeyAttributes: [...projection.NonKeyAttributes].map(String).sort() } : {}) };
}

function canonicalThroughput(value: unknown): DynamoDbThroughputModel | undefined {
  if (value === undefined) return undefined;
  const throughput = value as Record<string, unknown>;
  return { ReadCapacityUnits: Number(throughput.ReadCapacityUnits), WriteCapacityUnits: Number(throughput.WriteCapacityUnits) };
}

function canonicalOnDemand(value: unknown): DynamoDbOnDemandThroughputModel | undefined {
  if (value === undefined) return undefined;
  const throughput = value as Record<string, unknown>;
  return { ...(throughput.MaxReadRequestUnits !== undefined ? { MaxReadRequestUnits: Number(throughput.MaxReadRequestUnits) } : {}), ...(throughput.MaxWriteRequestUnits !== undefined ? { MaxWriteRequestUnits: Number(throughput.MaxWriteRequestUnits) } : {}) };
}

function canonicalWarm(value: unknown): DynamoDbWarmThroughputModel | undefined {
  if (value === undefined) return undefined;
  const throughput = value as Record<string, unknown>;
  return { ReadUnitsPerSecond: Number(throughput.ReadUnitsPerSecond), WriteUnitsPerSecond: Number(throughput.WriteUnitsPerSecond) };
}

function canonicalContributor(value: unknown): DynamoDbContributorInsightsModel | undefined {
  if (!record(value) || value.Enabled !== true) return undefined;
  return { Enabled: true, Mode: String(value.Mode ?? "ACCESSED_AND_THROTTLED_KEYS") as DynamoDbContributorInsightsModel["Mode"] };
}

function canonicalLocalIndex(value: Record<string, unknown>): DynamoDbLocalSecondaryIndexModel {
  return { IndexName: String(value.IndexName), KeySchema: canonicalKeySchema(value.KeySchema), Projection: canonicalProjection(value.Projection) };
}

function canonicalGlobalIndex(value: Record<string, unknown>): DynamoDbGlobalSecondaryIndexModel {
  return stable({
    ...canonicalLocalIndex(value),
    ...(value.ProvisionedThroughput !== undefined ? { ProvisionedThroughput: canonicalThroughput(value.ProvisionedThroughput)! } : {}),
    ...(value.OnDemandThroughput !== undefined ? { OnDemandThroughput: canonicalOnDemand(value.OnDemandThroughput)! } : {}),
    ...(value.WarmThroughput !== undefined ? { WarmThroughput: canonicalWarm(value.WarmThroughput)! } : {}),
    ...(canonicalContributor(value.ContributorInsightsSpecification) ? { ContributorInsightsSpecification: canonicalContributor(value.ContributorInsightsSpecification)! } : {}),
  });
}

function canonicalizeModel(properties: Record<string, unknown>, context: ProviderContext): DynamoDbTableModel {
  const billing = String(properties.BillingMode ?? "PROVISIONED") as DynamoDbTableModel["BillingMode"];
  const ttl = record(properties.TimeToLiveSpecification) && properties.TimeToLiveSpecification.Enabled === true
    ? { AttributeName: String(properties.TimeToLiveSpecification.AttributeName), Enabled: true as const }
    : undefined;
  const pitr = record(properties.PointInTimeRecoverySpecification) && properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled === true
    ? { PointInTimeRecoveryEnabled: true as const, RecoveryPeriodInDays: Number(properties.PointInTimeRecoverySpecification.RecoveryPeriodInDays ?? 35) }
    : undefined;
  const stream = record(properties.StreamSpecification)
    ? { StreamViewType: String(properties.StreamSpecification.StreamViewType) as DynamoDbStreamViewType, ...(record(properties.StreamSpecification.ResourcePolicy) ? { ResourcePolicy: stable(structuredClone(properties.StreamSpecification.ResourcePolicy)) } : {}) }
    : undefined;
  return stable({
    TableName: String(properties.TableName ?? generatedName(context)),
    AttributeDefinitions: (properties.AttributeDefinitions as Array<Record<string, unknown>>).map(item => ({ AttributeName: String(item.AttributeName), AttributeType: String(item.AttributeType) as DynamoDbAttributeDefinitionModel["AttributeType"] })).sort((left, right) => left.AttributeName.localeCompare(right.AttributeName)),
    KeySchema: canonicalKeySchema(properties.KeySchema),
    BillingMode: billing,
    ...(billing === "PROVISIONED" ? { ProvisionedThroughput: canonicalThroughput(properties.ProvisionedThroughput)! } : {}),
    ...(billing === "PAY_PER_REQUEST" && properties.OnDemandThroughput !== undefined ? { OnDemandThroughput: canonicalOnDemand(properties.OnDemandThroughput)! } : {}),
    ...(properties.WarmThroughput !== undefined ? { WarmThroughput: canonicalWarm(properties.WarmThroughput)! } : {}),
    ...(Array.isArray(properties.LocalSecondaryIndexes) && properties.LocalSecondaryIndexes.length ? { LocalSecondaryIndexes: properties.LocalSecondaryIndexes.map(item => canonicalLocalIndex(item as Record<string, unknown>)).sort((left, right) => left.IndexName.localeCompare(right.IndexName)) } : {}),
    ...(Array.isArray(properties.GlobalSecondaryIndexes) && properties.GlobalSecondaryIndexes.length ? { GlobalSecondaryIndexes: properties.GlobalSecondaryIndexes.map(item => canonicalGlobalIndex(item as Record<string, unknown>)).sort((left, right) => left.IndexName.localeCompare(right.IndexName)) } : {}),
    ...(stream ? { StreamSpecification: stream } : {}),
    ...(ttl ? { TimeToLiveSpecification: ttl } : {}),
    ...(pitr ? { PointInTimeRecoverySpecification: pitr } : {}),
    SSESpecification: { SSEEnabled: false as const },
    TableClass: String(properties.TableClass ?? "STANDARD") as DynamoDbTableModel["TableClass"],
    DeletionProtectionEnabled: Boolean(properties.DeletionProtectionEnabled ?? false),
    ...(canonicalContributor(properties.ContributorInsightsSpecification) ? { ContributorInsightsSpecification: canonicalContributor(properties.ContributorInsightsSpecification)! } : {}),
    Tags: (Array.isArray(properties.Tags) ? properties.Tags : []).map(item => ({ Key: String((item as any).Key), Value: String((item as any).Value) })).sort((left, right) => left.Key.localeCompare(right.Key)),
    ...(record(properties.ResourcePolicy) ? { ResourcePolicy: stable(structuredClone(properties.ResourcePolicy)) } : {}),
  });
}

function inProgress(physicalId: string, phase = "reconcile", callbackAfterMs = 50): ProviderInProgress {
  return { status: "IN_PROGRESS", callbackAfterMs, checkpoint: { schemaVersion: 1, callbackContext: { phase }, physicalId } };
}

function failed(error: unknown): ProviderUpdateResult<DynamoDbTableModel> {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}

function notFound(error: unknown): boolean {
  return error instanceof AwsError && (error.code === "ResourceNotFoundException" || error.code === "TableNotFoundException");
}

function parsePolicy(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try { const parsed = JSON.parse(value); return record(parsed) ? stable(parsed) : undefined; } catch { return undefined; }
}

function policyJson(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(stable(value));
}

function capacityFromDescription(value: any): DynamoDbThroughputModel | undefined {
  if (!value || Number(value.ReadCapacityUnits) < 1 || Number(value.WriteCapacityUnits) < 1) return undefined;
  return { ReadCapacityUnits: Number(value.ReadCapacityUnits), WriteCapacityUnits: Number(value.WriteCapacityUnits) };
}

function onDemandFromDescription(value: any): DynamoDbOnDemandThroughputModel | undefined {
  if (!value || (value.MaxReadRequestUnits === undefined && value.MaxWriteRequestUnits === undefined)) return undefined;
  return { ...(value.MaxReadRequestUnits !== undefined ? { MaxReadRequestUnits: Number(value.MaxReadRequestUnits) } : {}), ...(value.MaxWriteRequestUnits !== undefined ? { MaxWriteRequestUnits: Number(value.MaxWriteRequestUnits) } : {}) };
}

function warmFromDescription(value: any): DynamoDbWarmThroughputModel | undefined {
  if (!value || value.ReadUnitsPerSecond === undefined || value.WriteUnitsPerSecond === undefined) return undefined;
  return { ReadUnitsPerSecond: Number(value.ReadUnitsPerSecond), WriteUnitsPerSecond: Number(value.WriteUnitsPerSecond) };
}

function attributesUsed(table: any): Set<string> {
  return new Set([...(table.KeySchema ?? []), ...(table.LocalSecondaryIndexes ?? []).flatMap((index: any) => index.KeySchema ?? []), ...(table.GlobalSecondaryIndexes ?? []).flatMap((index: any) => index.KeySchema ?? [])].map((entry: any) => String(entry.AttributeName)));
}

function tagInput(model: DynamoDbTableModel, context: ProviderContext): Array<{ Key: string; Value: string }> {
  return [...model.Tags.map(tag => ({ ...tag })), { Key: OWNER_TAG, Value: ownerValue(context) }];
}

function createTableInput(model: DynamoDbTableModel, context: ProviderContext): Record<string, unknown> {
  return {
    TableName: model.TableName,
    AttributeDefinitions: structuredClone(model.AttributeDefinitions),
    KeySchema: structuredClone(model.KeySchema),
    BillingMode: model.BillingMode,
    ...(model.ProvisionedThroughput ? { ProvisionedThroughput: structuredClone(model.ProvisionedThroughput) } : {}),
    ...(model.OnDemandThroughput ? { OnDemandThroughput: structuredClone(model.OnDemandThroughput) } : {}),
    ...(model.WarmThroughput ? { WarmThroughput: structuredClone(model.WarmThroughput) } : {}),
    ...(model.LocalSecondaryIndexes ? { LocalSecondaryIndexes: structuredClone(model.LocalSecondaryIndexes) } : {}),
    ...(model.GlobalSecondaryIndexes ? { GlobalSecondaryIndexes: model.GlobalSecondaryIndexes.map(({ ContributorInsightsSpecification: _ignored, ...index }) => structuredClone(index)) } : {}),
    ...(model.StreamSpecification ? { StreamSpecification: { StreamEnabled: true, StreamViewType: model.StreamSpecification.StreamViewType } } : {}),
    SSESpecification: { Enabled: false },
    TableClass: model.TableClass,
    DeletionProtectionEnabled: model.DeletionProtectionEnabled,
    Tags: tagInput(model, context),
  };
}

function success(model: DynamoDbTableModel, snapshot: Pick<DynamoDbTableSnapshot, "arn" | "streamArn">): ProviderSuccess<DynamoDbTableModel> {
  const attributes: Record<string, unknown> = { Arn: snapshot.arn };
  if (snapshot.streamArn) attributes.StreamArn = snapshot.streamArn;
  return { status: "SUCCESS", physicalId: model.TableName, model: { physicalId: model.TableName, properties: model, attributes } };
}

function structuralIndex(index: DynamoDbGlobalSecondaryIndexModel | DynamoDbLocalSecondaryIndexModel): unknown {
  return { IndexName: index.IndexName, KeySchema: index.KeySchema, Projection: index.Projection };
}

function replacementChanges(previous: DynamoDbTableModel, desired: DynamoDbTableModel): string[] {
  const replacements: string[] = [];
  if (previous.TableName !== desired.TableName) replacements.push("TableName");
  if (!same(previous.KeySchema, desired.KeySchema)) replacements.push("KeySchema");
  if (!same(previous.LocalSecondaryIndexes ?? [], desired.LocalSecondaryIndexes ?? [])) replacements.push("LocalSecondaryIndexes");
  const previousDefinitions = new Map(previous.AttributeDefinitions.map(item => [item.AttributeName, item.AttributeType]));
  const desiredDefinitions = new Map(desired.AttributeDefinitions.map(item => [item.AttributeName, item.AttributeType]));
  // The direct service can append definitions for a newly-created GSI, but it
  // cannot remove or change definitions already stored on a table.
  if ([...previousDefinitions].some(([name, type]) => desiredDefinitions.get(name) !== type)) replacements.push("AttributeDefinitions");
  const previousIndexes = new Map((previous.GlobalSecondaryIndexes ?? []).map(index => [index.IndexName, index]));
  const desiredIndexes = new Map((desired.GlobalSecondaryIndexes ?? []).map(index => [index.IndexName, index]));
  const removed = [...previousIndexes.keys()].filter(name => !desiredIndexes.has(name));
  const added = [...desiredIndexes.keys()].filter(name => !previousIndexes.has(name));
  const modified = [...previousIndexes].filter(([name, index]) => desiredIndexes.has(name) && !same(structuralIndex(index), structuralIndex(desiredIndexes.get(name)!)));
  if (modified.length || (removed.length && added.length)) replacements.push("GlobalSecondaryIndexes");
  return [...new Set(replacements)].sort();
}

function transitioning(snapshot: DynamoDbTableSnapshot): boolean {
  return snapshot.tableStatus !== "ACTIVE"
    || snapshot.globalIndexStatuses.some(status => status !== "ACTIVE")
    || [snapshot.streamStatus, snapshot.ttlStatus, snapshot.contributorStatus, ...Object.values(snapshot.indexContributorStatuses)].some(status => status === "ENABLING" || status === "DISABLING" || status === "UPDATING");
}

async function policy(service: DynamoDbService, resourceArn: string): Promise<PolicyState | undefined> {
  try {
    const response = await service.GetResourcePolicy({ ResourceArn: resourceArn });
    const document = parsePolicy(response.Policy);
    return document ? { document, revisionId: String(response.RevisionId) } : undefined;
  } catch (error) { if (error instanceof AwsError && error.code === "PolicyNotFoundException") return undefined; throw error; }
}

/**
 * Factory for later CFN-08 registry wiring. It intentionally accepts the real
 * DynamoDbService instance and never owns a parallel table inventory.
 */
export function createDynamoDbTableProvider(dynamodb: DynamoDbService): ProductionResourceProvider<DynamoDbTableModel> {
  const describe = async (tableName: string): Promise<DynamoDbTableSnapshot> => {
    const table = (await dynamodb.DescribeTable({ TableName: tableName })).Table;
    if ((table.SSEDescription?.SSEType ?? "AES256") !== "AES256" || table.SSEDescription?.KMSMasterKeyArn) {
      throw new AwsError("KmsDependency", `Table ${tableName} uses KMS encryption, which CFN-08 does not support`);
    }
    if (table.GlobalTableVersion || (table.Replicas ?? []).length) {
      throw new AwsError("ReplicaDependency", `Table ${tableName} participates in an unsupported global-table replica configuration`);
    }
    const arn = String(table.TableArn);
    const tagsResponse = await dynamodb.ListTagsOfResource({ ResourceArn: arn });
    const tags = Object.fromEntries((tagsResponse.Tags ?? []).map((tag: any) => [String(tag.Key), String(tag.Value)]));
    const ttl = (await dynamodb.DescribeTimeToLive({ TableName: tableName })).TimeToLiveDescription;
    const backups = (await dynamodb.DescribeContinuousBackups({ TableName: tableName })).ContinuousBackupsDescription;
    const controlPlaneActive = table.TableStatus === "ACTIVE" && (table.GlobalSecondaryIndexes ?? []).every((index: any) => (index.IndexStatus ?? "ACTIVE") === "ACTIVE");
    const contributor = controlPlaneActive
      ? await dynamodb.DescribeContributorInsights({ TableName: tableName })
      : { ContributorInsightsStatus: "UPDATING", ContributorInsightsMode: "ACCESSED_AND_THROTTLED_KEYS" };
    const indexContributors: Record<string, any> = {};
    for (const index of table.GlobalSecondaryIndexes ?? []) indexContributors[index.IndexName] = controlPlaneActive
      ? await dynamodb.DescribeContributorInsights({ TableName: tableName, IndexName: index.IndexName })
      : { ContributorInsightsStatus: "UPDATING", ContributorInsightsMode: "ACCESSED_AND_THROTTLED_KEYS" };
    let streamStatus: string | undefined;
    if (table.LatestStreamArn) streamStatus = (await dynamodb.DescribeStream({ StreamArn: table.LatestStreamArn })).StreamDescription.StreamStatus;
    const tablePolicy = await policy(dynamodb, arn);
    const streamPolicy = table.LatestStreamArn ? await policy(dynamodb, String(table.LatestStreamArn)) : undefined;
    const used = attributesUsed(table);
    const billing = String(table.BillingModeSummary?.BillingMode ?? "PROVISIONED") as DynamoDbTableModel["BillingMode"];
    const local = (table.LocalSecondaryIndexes ?? []).map((index: any) => canonicalLocalIndex(index)).sort((left: DynamoDbLocalSecondaryIndexModel, right: DynamoDbLocalSecondaryIndexModel) => left.IndexName.localeCompare(right.IndexName));
    const global = (table.GlobalSecondaryIndexes ?? []).map((index: any) => {
      const state = indexContributors[index.IndexName];
      return stable({
        ...canonicalLocalIndex(index),
        ...(billing === "PROVISIONED" && capacityFromDescription(index.ProvisionedThroughput) ? { ProvisionedThroughput: capacityFromDescription(index.ProvisionedThroughput)! } : {}),
        ...(billing === "PAY_PER_REQUEST" && onDemandFromDescription(index.OnDemandThroughput) ? { OnDemandThroughput: onDemandFromDescription(index.OnDemandThroughput)! } : {}),
        ...(warmFromDescription(index.WarmThroughput) ? { WarmThroughput: warmFromDescription(index.WarmThroughput)! } : {}),
        ...(state?.ContributorInsightsStatus === "ENABLED" || state?.ContributorInsightsStatus === "ENABLING" ? { ContributorInsightsSpecification: { Enabled: true as const, Mode: String(state.ContributorInsightsMode) as DynamoDbContributorInsightsModel["Mode"] } } : {}),
      });
    }).sort((left: DynamoDbGlobalSecondaryIndexModel, right: DynamoDbGlobalSecondaryIndexModel) => left.IndexName.localeCompare(right.IndexName));
    const model: DynamoDbTableModel = stable({
      TableName: tableName,
      AttributeDefinitions: (table.AttributeDefinitions ?? []).filter((definition: any) => used.has(String(definition.AttributeName))).map((definition: any) => ({ AttributeName: String(definition.AttributeName), AttributeType: String(definition.AttributeType) as DynamoDbAttributeDefinitionModel["AttributeType"] })).sort((left: DynamoDbAttributeDefinitionModel, right: DynamoDbAttributeDefinitionModel) => left.AttributeName.localeCompare(right.AttributeName)),
      KeySchema: canonicalKeySchema(table.KeySchema),
      BillingMode: billing,
      ...(billing === "PROVISIONED" && capacityFromDescription(table.ProvisionedThroughput) ? { ProvisionedThroughput: capacityFromDescription(table.ProvisionedThroughput)! } : {}),
      ...(billing === "PAY_PER_REQUEST" && onDemandFromDescription(table.OnDemandThroughput) ? { OnDemandThroughput: onDemandFromDescription(table.OnDemandThroughput)! } : {}),
      ...(warmFromDescription(table.WarmThroughput) ? { WarmThroughput: warmFromDescription(table.WarmThroughput)! } : {}),
      ...(local.length ? { LocalSecondaryIndexes: local } : {}),
      ...(global.length ? { GlobalSecondaryIndexes: global } : {}),
      ...(table.StreamSpecification?.StreamEnabled ? { StreamSpecification: { StreamViewType: String(table.StreamSpecification.StreamViewType) as NonNullable<DynamoDbTableModel["StreamSpecification"]>["StreamViewType"], ...(streamPolicy ? { ResourcePolicy: streamPolicy.document } : {}) } } : {}),
      ...(["ENABLED", "ENABLING"].includes(String(ttl.TimeToLiveStatus)) && ttl.AttributeName ? { TimeToLiveSpecification: { AttributeName: String(ttl.AttributeName), Enabled: true as const } } : {}),
      ...(backups.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus === "ENABLED" ? { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true as const, RecoveryPeriodInDays: Number(backups.PointInTimeRecoveryDescription.RecoveryPeriodInDays ?? 35) } } : {}),
      SSESpecification: { SSEEnabled: false as const },
      TableClass: String(table.TableClassSummary?.TableClass ?? "STANDARD") as DynamoDbTableModel["TableClass"],
      DeletionProtectionEnabled: Boolean(table.DeletionProtectionEnabled),
      ...(contributor.ContributorInsightsStatus === "ENABLED" || contributor.ContributorInsightsStatus === "ENABLING" ? { ContributorInsightsSpecification: { Enabled: true as const, Mode: String(contributor.ContributorInsightsMode) as DynamoDbContributorInsightsModel["Mode"] } } : {}),
      Tags: Object.entries(tags).filter(([key]) => key !== OWNER_TAG).map(([Key, Value]) => ({ Key, Value })).sort((left, right) => left.Key.localeCompare(right.Key)),
      ...(tablePolicy ? { ResourcePolicy: tablePolicy.document } : {}),
    });
    return {
      model,
      tableStatus: String(table.TableStatus),
      globalIndexStatuses: (table.GlobalSecondaryIndexes ?? []).map((index: any) => String(index.IndexStatus)),
      streamStatus,
      ttlStatus: String(ttl.TimeToLiveStatus),
      pitrStatus: String(backups.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus ?? "DISABLED"),
      contributorStatus: String(contributor.ContributorInsightsStatus),
      indexContributorStatuses: Object.fromEntries(Object.entries(indexContributors).map(([name, value]) => [name, String((value as any).ContributorInsightsStatus)])),
      tags,
      tablePolicy,
      streamPolicy,
      arn,
      ...(table.LatestStreamArn ? { streamArn: String(table.LatestStreamArn) } : {}),
    };
  };

  const ownership = (snapshot: DynamoDbTableSnapshot, context: ProviderContext): boolean => snapshot.tags[OWNER_TAG] === ownerValue(context);

  const mutate = async (physicalId: string, operation: () => Promise<unknown>): Promise<ProviderInProgress | ProviderUpdateResult<DynamoDbTableModel>> => {
    try { await operation(); return inProgress(physicalId); }
    catch (error) {
      if (error instanceof AwsError && error.code === "ResourceInUseException") return inProgress(physicalId, "wait-for-service-cooldown", 250);
      return failed(error);
    }
  };

  const reconcile = async (desired: DynamoDbTableModel, context: ProviderContext, previous?: DynamoDbTableModel): Promise<ProviderUpdateResult<DynamoDbTableModel>> => {
    let current: DynamoDbTableSnapshot;
    try { current = await describe(desired.TableName); } catch (error) { return failed(error); }
    if (!ownership(current, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Table ${desired.TableName} is not owned by this stack resource` };
    if (transitioning(current)) return inProgress(desired.TableName);
    const replacement = replacementChanges(current.model, desired);
    if (replacement.length) return { status: "FAILED", errorCode: "RequiresReplacement", message: `Table ${desired.TableName} has replacement-class differences in ${replacement.join(", ")}` };
    if (!same(current.model.KeySchema, desired.KeySchema) || !same(current.model.LocalSecondaryIndexes ?? [], desired.LocalSecondaryIndexes ?? [])) return { status: "FAILED", errorCode: "RequiresReplacement", message: `Table ${desired.TableName} has replacement-class key or local-index differences` };

    const currentGlobal = new Map((current.model.GlobalSecondaryIndexes ?? []).map(index => [index.IndexName, index]));
    const desiredGlobal = new Map((desired.GlobalSecondaryIndexes ?? []).map(index => [index.IndexName, index]));
    const add = [...desiredGlobal.keys()].filter(name => !currentGlobal.has(name)).sort()[0];

    // The backing service validates every existing GSI against the capacity
    // mode used by a create-index request. When a template changes both mode
    // and indexes, create each new index in the old mode first, then switch the
    // table and converge its final capacity in later callbacks.
    if (add && current.model.BillingMode !== desired.BillingMode) {
      const index = desiredGlobal.get(add)!;
      const known = new Set(current.model.AttributeDefinitions.map(item => item.AttributeName));
      const indexAttributes = new Set(index.KeySchema.map(item => item.AttributeName));
      const additions = desired.AttributeDefinitions.filter(item => indexAttributes.has(item.AttributeName) && !known.has(item.AttributeName));
      const definition = {
        ...structuralIndex(index) as Record<string, unknown>,
        ...(index.WarmThroughput ? { WarmThroughput: structuredClone(index.WarmThroughput) } : {}),
        ...(current.model.BillingMode === "PROVISIONED"
          ? { ProvisionedThroughput: structuredClone(index.ProvisionedThroughput ?? { ReadCapacityUnits: 1, WriteCapacityUnits: 1 }) }
          : index.OnDemandThroughput ? { OnDemandThroughput: structuredClone(index.OnDemandThroughput) } : {}),
      };
      return mutate(desired.TableName, () => dynamodb.UpdateTable({ TableName: desired.TableName, ...(additions.length ? { AttributeDefinitions: structuredClone(additions) } : {}), GlobalSecondaryIndexUpdates: [{ Create: definition }] }));
    }

    if (current.model.BillingMode !== desired.BillingMode) return mutate(desired.TableName, () => dynamodb.UpdateTable({ TableName: desired.TableName, BillingMode: desired.BillingMode, ...(desired.ProvisionedThroughput ? { ProvisionedThroughput: structuredClone(desired.ProvisionedThroughput) } : {}), ...(desired.OnDemandThroughput ? { OnDemandThroughput: structuredClone(desired.OnDemandThroughput) } : {}) }));

    const remove = [...currentGlobal.keys()].filter(name => !desiredGlobal.has(name)).sort()[0];
    if (remove) return mutate(desired.TableName, () => dynamodb.UpdateTable({ TableName: desired.TableName, GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: remove } }] }));
    if (add) {
      const index = desiredGlobal.get(add)!; const { ContributorInsightsSpecification: _ignored, ...definition } = index;
      const known = new Set(current.model.AttributeDefinitions.map(item => item.AttributeName));
      const indexAttributes = new Set(index.KeySchema.map(item => item.AttributeName));
      const additions = desired.AttributeDefinitions.filter(item => indexAttributes.has(item.AttributeName) && !known.has(item.AttributeName));
      return mutate(desired.TableName, () => dynamodb.UpdateTable({ TableName: desired.TableName, ...(additions.length ? { AttributeDefinitions: structuredClone(additions) } : {}), GlobalSecondaryIndexUpdates: [{ Create: structuredClone(definition) }] }));
    }
    for (const [name, wanted] of desiredGlobal) {
      const actual = currentGlobal.get(name)!;
      if (!same(structuralIndex(actual), structuralIndex(wanted))) return { status: "FAILED", errorCode: "RequiresReplacement", message: `Global secondary index ${name} has replacement-class key or projection differences` };
      if (!same(actual.ProvisionedThroughput, wanted.ProvisionedThroughput) || !same(actual.OnDemandThroughput, wanted.OnDemandThroughput) || !same(actual.WarmThroughput, wanted.WarmThroughput)) {
        if (actual.WarmThroughput && !wanted.WarmThroughput) return { status: "FAILED", errorCode: "UnsupportedUpdate", message: `Removing WarmThroughput from global secondary index ${name} is not supported by the backing service` };
        const actualOnDemand = actual.OnDemandThroughput ?? {};
        const wantedOnDemand = wanted.OnDemandThroughput ?? {};
        const onDemandUpdate = !same(actual.OnDemandThroughput, wanted.OnDemandThroughput) ? {
          ...(actualOnDemand.MaxReadRequestUnits !== wantedOnDemand.MaxReadRequestUnits ? { MaxReadRequestUnits: wantedOnDemand.MaxReadRequestUnits ?? -1 } : {}),
          ...(actualOnDemand.MaxWriteRequestUnits !== wantedOnDemand.MaxWriteRequestUnits ? { MaxWriteRequestUnits: wantedOnDemand.MaxWriteRequestUnits ?? -1 } : {}),
        } : undefined;
        const update = {
          IndexName: name,
          ...(wanted.ProvisionedThroughput ? { ProvisionedThroughput: structuredClone(wanted.ProvisionedThroughput) } : {}),
          ...(onDemandUpdate ? { OnDemandThroughput: onDemandUpdate } : {}),
          ...(wanted.WarmThroughput ? { WarmThroughput: structuredClone(wanted.WarmThroughput) } : {}),
        };
        return mutate(desired.TableName, () => dynamodb.UpdateTable({ TableName: desired.TableName, GlobalSecondaryIndexUpdates: [{ Update: update }] }));
      }
    }

    if (desired.BillingMode === "PROVISIONED" && !same(current.model.ProvisionedThroughput, desired.ProvisionedThroughput)) return mutate(desired.TableName, () => dynamodb.UpdateTable({ TableName: desired.TableName, ProvisionedThroughput: structuredClone(desired.ProvisionedThroughput) }));
    if (desired.BillingMode === "PAY_PER_REQUEST" && !same(current.model.OnDemandThroughput, desired.OnDemandThroughput)) {
      const next = desired.OnDemandThroughput ?? {};
      const actual = current.model.OnDemandThroughput ?? {};
      const update = {
        ...(next.MaxReadRequestUnits !== actual.MaxReadRequestUnits ? { MaxReadRequestUnits: next.MaxReadRequestUnits ?? -1 } : {}),
        ...(next.MaxWriteRequestUnits !== actual.MaxWriteRequestUnits ? { MaxWriteRequestUnits: next.MaxWriteRequestUnits ?? -1 } : {}),
      };
      return mutate(desired.TableName, () => dynamodb.UpdateTable({ TableName: desired.TableName, OnDemandThroughput: update }));
    }
    // DescribeTable reports AWS's computed warm-throughput default even when
    // WarmThroughput was omitted. Treat that value as absent only when the
    // CloudFormation model also omitted it; an explicitly managed value must
    // still retain the backing service's no-removal behavior.
    const currentWarmThroughput = previous?.WarmThroughput === undefined
      && desired.WarmThroughput === undefined
      && same(current.model.WarmThroughput, DYNAMODB_DEFAULT_WARM_THROUGHPUT)
      ? undefined
      : current.model.WarmThroughput;
    if (!same(currentWarmThroughput, desired.WarmThroughput)) {
      if (!desired.WarmThroughput) return { status: "FAILED", errorCode: "UnsupportedUpdate", message: "Removing WarmThroughput is not supported by the backing service" };
      return mutate(desired.TableName, () => dynamodb.UpdateTable({ TableName: desired.TableName, WarmThroughput: structuredClone(desired.WarmThroughput) }));
    }
    if (current.model.TableClass !== desired.TableClass) return mutate(desired.TableName, () => dynamodb.UpdateTable({ TableName: desired.TableName, TableClass: desired.TableClass }));
    if (current.model.DeletionProtectionEnabled !== desired.DeletionProtectionEnabled) return mutate(desired.TableName, () => dynamodb.UpdateTable({ TableName: desired.TableName, DeletionProtectionEnabled: desired.DeletionProtectionEnabled }));
    if (!same(current.model.SSESpecification, desired.SSESpecification)) return { status: "FAILED", errorCode: "KmsDependency", message: "The existing table uses KMS encryption, which CFN-08 does not support" };
    const streamConfigurationChanged = !same(current.model.StreamSpecification ? { StreamViewType: current.model.StreamSpecification.StreamViewType } : undefined, desired.StreamSpecification ? { StreamViewType: desired.StreamSpecification.StreamViewType } : undefined);
    if (streamConfigurationChanged && current.streamPolicy && current.streamArn) {
      const { revisionId } = current.streamPolicy;
      return mutate(desired.TableName, () => dynamodb.DeleteResourcePolicy({ ResourceArn: current.streamArn!, ExpectedRevisionId: revisionId }));
    }
    if (streamConfigurationChanged) {
      return mutate(desired.TableName, () => dynamodb.UpdateTable({ TableName: desired.TableName, StreamSpecification: desired.StreamSpecification ? { StreamEnabled: true, StreamViewType: desired.StreamSpecification.StreamViewType } : { StreamEnabled: false } }));
    }

    const wantedTags = Object.fromEntries(tagInput(desired, context).map(tag => [tag.Key, tag.Value]));
    const removals = Object.keys(current.tags).filter(key => key !== OWNER_TAG && !Object.hasOwn(wantedTags, key));
    if (removals.length) return mutate(desired.TableName, () => dynamodb.UntagResource({ ResourceArn: current.arn, TagKeys: removals }));
    const changes = Object.entries(wantedTags).filter(([key, value]) => current.tags[key] !== value).map(([Key, Value]) => ({ Key, Value }));
    if (changes.length) return mutate(desired.TableName, () => dynamodb.TagResource({ ResourceArn: current.arn, Tags: changes }));

    if (!same(current.tablePolicy?.document, desired.ResourcePolicy)) {
      const desiredTablePolicy = desired.ResourcePolicy;
      if (desiredTablePolicy) return mutate(desired.TableName, () => dynamodb.PutResourcePolicy({ ResourceArn: current.arn, Policy: policyJson(desiredTablePolicy), ...(current.tablePolicy ? { ExpectedRevisionId: current.tablePolicy.revisionId } : {}) }, context.principal.identity));
      const tablePolicy = current.tablePolicy;
      if (tablePolicy) return mutate(desired.TableName, () => dynamodb.DeleteResourcePolicy({ ResourceArn: current.arn, ExpectedRevisionId: tablePolicy.revisionId }));
    }
    if (!same(current.streamPolicy?.document, desired.StreamSpecification?.ResourcePolicy)) {
      if (!current.streamArn) return { status: "FAILED", errorCode: "StreamNotEnabled", message: "A stream resource policy requires an active DynamoDB stream" };
      const desiredStreamPolicy = desired.StreamSpecification?.ResourcePolicy;
      if (desiredStreamPolicy) return mutate(desired.TableName, () => dynamodb.PutResourcePolicy({ ResourceArn: current.streamArn, Policy: policyJson(desiredStreamPolicy), ...(current.streamPolicy ? { ExpectedRevisionId: current.streamPolicy.revisionId } : {}) }, context.principal.identity));
      const streamPolicy = current.streamPolicy;
      if (streamPolicy) return mutate(desired.TableName, () => dynamodb.DeleteResourcePolicy({ ResourceArn: current.streamArn!, ExpectedRevisionId: streamPolicy.revisionId }));
    }

    if (!same(current.model.TimeToLiveSpecification, desired.TimeToLiveSpecification)) {
      const wanted = desired.TimeToLiveSpecification;
      const active = current.model.TimeToLiveSpecification;
      // DynamoDB requires disabling the old TTL attribute before enabling a new one.
      const specification = active && wanted && active.AttributeName !== wanted.AttributeName
        ? { Enabled: false, AttributeName: active.AttributeName }
        : wanted
          ? { Enabled: true, AttributeName: wanted.AttributeName }
          : { Enabled: false, AttributeName: active?.AttributeName };
      return mutate(desired.TableName, () => dynamodb.UpdateTimeToLive({ TableName: desired.TableName, TimeToLiveSpecification: specification }));
    }
    if (!same(current.model.PointInTimeRecoverySpecification, desired.PointInTimeRecoverySpecification)) return mutate(desired.TableName, () => dynamodb.UpdateContinuousBackups({ TableName: desired.TableName, PointInTimeRecoverySpecification: desired.PointInTimeRecoverySpecification ? { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: desired.PointInTimeRecoverySpecification.RecoveryPeriodInDays } : { PointInTimeRecoveryEnabled: false } }));
    if (!same(current.model.ContributorInsightsSpecification, desired.ContributorInsightsSpecification)) return mutate(desired.TableName, () => dynamodb.UpdateContributorInsights({ TableName: desired.TableName, ContributorInsightsAction: desired.ContributorInsightsSpecification ? "ENABLE" : "DISABLE", ...(desired.ContributorInsightsSpecification ? { ContributorInsightsMode: desired.ContributorInsightsSpecification.Mode } : {}) }));
    for (const [name, wanted] of desiredGlobal) {
      const actual = currentGlobal.get(name)!;
      if (!same(actual.ContributorInsightsSpecification, wanted.ContributorInsightsSpecification)) return mutate(desired.TableName, () => dynamodb.UpdateContributorInsights({ TableName: desired.TableName, IndexName: name, ContributorInsightsAction: wanted.ContributorInsightsSpecification ? "ENABLE" : "DISABLE", ...(wanted.ContributorInsightsSpecification ? { ContributorInsightsMode: wanted.ContributorInsightsSpecification.Mode } : {}) }));
    }
    return success(desired, current);
  };

  return {
    typeName: DYNAMODB_TABLE_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: DYNAMODB_TABLE_SCHEMA,

    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] {
      const shallow = validateDeclaredProperties(properties ?? {}, DYNAMODB_TABLE_SCHEMA);
      return !record(properties) ? shallow : [...shallow, ...validateNested(properties, context)];
    },

    canonicalize(properties: unknown, context: ProviderContext): DynamoDbTableModel {
      if (!record(properties)) throw new TypeError(`${DYNAMODB_TABLE_TYPE} Properties must be an object`);
      const issues = [...validateDeclaredProperties(properties, DYNAMODB_TABLE_SCHEMA), ...validateNested(properties, context)];
      if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return canonicalizeModel(properties, context);
    },

    plan(previous: DynamoDbTableModel | undefined, desired: DynamoDbTableModel): ProviderPlan<DynamoDbTableModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const changed = [...new Set([...Object.keys(previous), ...Object.keys(desired)])].filter(key => !same((previous as any)[key], (desired as any)[key])).sort();
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      const replacements = replacementChanges(previous, desired);
      if (!replacements.length) return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
      const fixedNameConflict = previous.TableName === desired.TableName;
      return { action: "REPLACE", desired, changedProperties: changed, replacementProperties: replacements, replacementOrder: fixedNameConflict ? "DELETE_BEFORE_CREATE" : "CREATE_BEFORE_DELETE", ...(fixedNameConflict ? { reason: "A replacement-class DynamoDB schema change keeps the same physical table name" } : {}) };
    },

    async create(desired: DynamoDbTableModel, context: ProviderContext) {
      try {
        try {
          const existing = await describe(desired.TableName);
          if (!ownership(existing, context)) return { status: "FAILED", errorCode: "AlreadyExists", message: `Table ${desired.TableName} already exists and is not owned by this stack resource` };
          return await reconcile(desired, context);
        } catch (error) { if (!notFound(error)) throw error; }
        await dynamodb.CreateTable(createTableInput(desired, context));
        return inProgress(desired.TableName);
      } catch (error) {
        if (error instanceof AwsError && error.code === "ResourceInUseException") return inProgress(desired.TableName, "create-race", 50);
        return failed(error);
      }
    },

    async read(physicalId: string): Promise<ProviderReadResult<DynamoDbTableModel>> {
      try {
        const snapshot = await describe(physicalId);
        if (transitioning(snapshot)) return inProgress(physicalId, "read-stabilize");
        return success(snapshot.model, snapshot);
      } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderReadResult<DynamoDbTableModel>; }
    },

    async update(physicalId: string, previous: DynamoDbTableModel, desired: DynamoDbTableModel, context: ProviderContext): Promise<ProviderUpdateResult<DynamoDbTableModel>> {
      if (physicalId !== desired.TableName) return { status: "FAILED", errorCode: "RequiresReplacement", message: "TableName changes require replacement" };
      return reconcile(desired, context, previous);
    },

    async delete(physicalId: string, _previous: DynamoDbTableModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const snapshot = await describe(physicalId);
        if (!ownership(snapshot, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Table ${physicalId} is not owned by this stack resource` };
        if (transitioning(snapshot)) return inProgress(physicalId, "delete-stabilize");
        // Preserve DynamoDB's deletion-protection failure before making any
        // cleanup mutation. Once deletion is allowed, remove the active stream
        // policy because the retired stream itself outlives the table.
        if (snapshot.model.DeletionProtectionEnabled) {
          await dynamodb.DeleteTable({ TableName: physicalId });
          return { status: "SUCCESS", physicalId };
        }
        if (snapshot.streamPolicy && snapshot.streamArn) {
          try {
            await dynamodb.DeleteResourcePolicy({ ResourceArn: snapshot.streamArn, ExpectedRevisionId: snapshot.streamPolicy.revisionId });
            return inProgress(physicalId, "delete-stream-policy");
          } catch (error) {
            if (error instanceof AwsError && error.code === "ResourceInUseException") return inProgress(physicalId, "delete-stream-policy-cooldown", 250);
            throw error;
          }
        }
        await dynamodb.DeleteTable({ TableName: physicalId });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult; }
    },

    ref(model: ProviderReadModel<DynamoDbTableModel>): unknown { return model.physicalId; },
    getAtt(model: ProviderReadModel<DynamoDbTableModel>, attribute: string): unknown {
      if (attribute === "Arn") return model.attributes.Arn;
      if (attribute === "StreamArn" && model.attributes.StreamArn) return model.attributes.StreamArn;
      throw new ProviderReferenceError(DYNAMODB_TABLE_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}
