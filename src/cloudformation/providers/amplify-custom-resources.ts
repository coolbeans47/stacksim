import type { LambdaService } from "../../lambda.js";
import type { StateStore } from "../../state.js";
import type { CustomResourceCallbackBroker } from "../custom-resource-callbacks.js";
import type { ProductionResourceProvider, ProviderSchema, ProviderValidationIssue } from "./contract.js";
import { createLambdaCustomResourceProvider, type LambdaCustomResourceModel } from "./custom-resource.js";

export const AMPLIFY_DYNAMODB_TABLE_TYPE = "Custom::AmplifyDynamoDBTable";
export const S3_AUTO_DELETE_OBJECTS_TYPE = "Custom::S3AutoDeleteObjects";

const retention = Object.freeze({ deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), snapshotSupported: false });
const tags = Object.freeze({ behavior: "NONE" as const, propagatesCloudFormationTags: false });
const replacement = Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" as const });

export const S3_AUTO_DELETE_OBJECTS_SCHEMA: ProviderSchema = Object.freeze({
  typeName: S3_AUTO_DELETE_OBJECTS_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ServiceToken: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    BucketName: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Generated helper physical resource ID" }),
  attributes: Object.freeze({}), replacement, retention, tags,
});

export const AMPLIFY_DYNAMODB_TABLE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: AMPLIFY_DYNAMODB_TABLE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ServiceToken: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    tableName: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    attributeDefinitions: Object.freeze({ valueType: "array", required: true, updateBehavior: "MUTABLE" }),
    keySchema: Object.freeze({ valueType: "array", required: true, updateBehavior: "MUTABLE" }),
    provisionedThroughput: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    sseSpecification: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    streamSpecification: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    deletionProtectionEnabled: Object.freeze({ valueType: "boolean", required: true, updateBehavior: "MUTABLE" }),
    allowDestructiveGraphqlSchemaUpdates: Object.freeze({ valueType: "boolean", required: true, updateBehavior: "MUTABLE" }),
    replaceTableUponGsiUpdate: Object.freeze({ valueType: "boolean", required: true, updateBehavior: "MUTABLE" }),
    pointInTimeRecoverySpecification: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    billingMode: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Generated DynamoDB table physical ID" }),
  attributes: Object.freeze({
    TableArn: Object.freeze({ valueType: "string" }),
    TableStreamArn: Object.freeze({ valueType: "string" }),
    TableName: Object.freeze({ valueType: "string" }),
  }),
  replacement, retention, tags,
});

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exact(value: unknown, fields: readonly string[], path: string, issues: ProviderValidationIssue[]): value is Record<string, unknown> {
  if (!record(value)) return false;
  for (const key of Object.keys(value)) if (!fields.includes(key)) issues.push({ code: "UnsupportedProperty", path: `${path}.${key}`, message: `${key} is not part of the frozen AMX-04 helper protocol` });
  return true;
}
function validateAutoDelete(properties: Record<string, unknown>): readonly ProviderValidationIssue[] {
  const issues: ProviderValidationIssue[] = [];
  if (typeof properties.BucketName !== "string" || !properties.BucketName) issues.push({ code: "InvalidProperty", path: "Properties.BucketName", message: "BucketName must be a nonempty resolved bucket name" });
  return issues;
}
function validateAmplifyTable(properties: Record<string, unknown>): readonly ProviderValidationIssue[] {
  const issues: ProviderValidationIssue[] = [];
  const definitions = properties.attributeDefinitions;
  if (!Array.isArray(definitions) || definitions.length !== 1 || !exact(definitions[0], ["attributeName", "attributeType"], "Properties.attributeDefinitions.0", issues) || definitions[0].attributeName !== "id" || definitions[0].attributeType !== "S") issues.push({ code: "InvalidProperty", path: "Properties.attributeDefinitions", message: "The frozen helper requires exactly the id/String attribute definition" });
  const keys = properties.keySchema;
  if (!Array.isArray(keys) || keys.length !== 1 || !exact(keys[0], ["attributeName", "keyType"], "Properties.keySchema.0", issues) || keys[0].attributeName !== "id" || keys[0].keyType !== "HASH") issues.push({ code: "InvalidProperty", path: "Properties.keySchema", message: "The frozen helper requires exactly the id/HASH key schema" });
  if (exact(properties.sseSpecification, ["sseEnabled"], "Properties.sseSpecification", issues) && properties.sseSpecification.sseEnabled !== false) issues.push({ code: "InvalidProperty", path: "Properties.sseSpecification.sseEnabled", message: "The frozen helper emits sseEnabled false" });
  if (exact(properties.streamSpecification, ["streamViewType"], "Properties.streamSpecification", issues) && properties.streamSpecification.streamViewType !== "NEW_AND_OLD_IMAGES") issues.push({ code: "InvalidProperty", path: "Properties.streamSpecification.streamViewType", message: "The frozen helper emits NEW_AND_OLD_IMAGES" });
  if (properties.provisionedThroughput !== undefined && exact(properties.provisionedThroughput, ["ReadCapacityUnits", "WriteCapacityUnits"], "Properties.provisionedThroughput", issues)) for (const key of ["ReadCapacityUnits", "WriteCapacityUnits"]) if (!Number.isSafeInteger(properties.provisionedThroughput[key]) || Number(properties.provisionedThroughput[key]) < 1) issues.push({ code: "InvalidProperty", path: `Properties.provisionedThroughput.${key}`, message: `${key} must be a positive integer` });
  if (properties.pointInTimeRecoverySpecification !== undefined && exact(properties.pointInTimeRecoverySpecification, ["PointInTimeRecoveryEnabled"], "Properties.pointInTimeRecoverySpecification", issues) && typeof properties.pointInTimeRecoverySpecification.PointInTimeRecoveryEnabled !== "boolean") issues.push({ code: "InvalidProperty", path: "Properties.pointInTimeRecoverySpecification.PointInTimeRecoveryEnabled", message: "PointInTimeRecoveryEnabled must be boolean" });
  if (properties.billingMode !== undefined && properties.billingMode !== "PAY_PER_REQUEST" && properties.billingMode !== "PROVISIONED") issues.push({ code: "InvalidProperty", path: "Properties.billingMode", message: "billingMode must be PAY_PER_REQUEST or PROVISIONED" });
  if (typeof properties.tableName !== "string" || !properties.tableName) issues.push({ code: "InvalidProperty", path: "Properties.tableName", message: "tableName must be nonempty" });
  return issues;
}

export function createAmplifyCustomResourceProviders(store: StateStore, lambda: LambdaService, callbacks: CustomResourceCallbackBroker): readonly ProductionResourceProvider<LambdaCustomResourceModel>[] {
  return [
    createLambdaCustomResourceProvider(S3_AUTO_DELETE_OBJECTS_TYPE, store, lambda, callbacks, { schema: S3_AUTO_DELETE_OBJECTS_SCHEMA, validate: validateAutoDelete }),
    createLambdaCustomResourceProvider(AMPLIFY_DYNAMODB_TABLE_TYPE, store, lambda, callbacks, { schema: AMPLIFY_DYNAMODB_TABLE_SCHEMA, validate: validateAmplifyTable }),
  ];
}
