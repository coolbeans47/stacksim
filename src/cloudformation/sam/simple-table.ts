import { cfnResource, isObject, primaryAttributes, resourceError, tagList, type JsonObject } from "./common.js";

const ATTRIBUTE_TYPES: Readonly<Record<string, string>> = { String: "S", Number: "N", Binary: "B" };

/** AWS::Serverless::SimpleTable → a single-key DynamoDB table. */
export function translateSimpleTable(logicalId: string, resource: JsonObject): Record<string, JsonObject> {
  const properties = isObject(resource.Properties) ? resource.Properties : {};
  let primaryKey = { AttributeName: "id" as unknown, AttributeType: "S" };
  if (properties.PrimaryKey) {
    if (!isObject(properties.PrimaryKey)) throw resourceError(logicalId, "Property 'PrimaryKey' should be a map.");
    const { Name: name, Type: type } = properties.PrimaryKey;
    if (name === undefined || name === null) throw resourceError(logicalId, "Property 'PrimaryKey.Name' is required.");
    if (type === undefined || type === null) throw resourceError(logicalId, "Property 'PrimaryKey.Type' is required.");
    if (typeof type !== "string" || !Object.hasOwn(ATTRIBUTE_TYPES, type)) throw resourceError(logicalId, `Invalid 'Type' "${String(type)}".`);
    primaryKey = { AttributeName: name, AttributeType: ATTRIBUTE_TYPES[type] };
  }
  const sse = properties.SSESpecification;
  if (isObject(sse) && (sse.KMSMasterKeyId !== undefined || (sse.SSEType !== undefined && sse.SSEType !== "AES256"))) {
    throw resourceError(logicalId, "Property 'SSESpecification' with a KMS key is not supported by StackSim; only SSE with the DynamoDB-owned key is available.");
  }
  return {
    [logicalId]: cfnResource("AWS::DynamoDB::Table", {
      AttributeDefinitions: [primaryKey],
      KeySchema: [{ AttributeName: primaryKey.AttributeName, KeyType: "HASH" }],
      PointInTimeRecoverySpecification: properties.PointInTimeRecoverySpecification || undefined,
      ProvisionedThroughput: properties.ProvisionedThroughput || undefined,
      BillingMode: properties.ProvisionedThroughput ? undefined : "PAY_PER_REQUEST",
      SSESpecification: sse || undefined,
      TableName: properties.TableName || undefined,
      Tags: isObject(properties.Tags) && Object.keys(properties.Tags).length ? tagList(properties.Tags) : undefined,
    }, primaryAttributes(resource)),
  };
}
