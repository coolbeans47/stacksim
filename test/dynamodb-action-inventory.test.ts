import assert from "node:assert/strict";
import { test } from "node:test";
import { DYNAMODB_ACTION_INVENTORY, DYNAMODB_ACTION_INVENTORY_SOURCE, DYNAMODB_STREAMS_ACTION_INVENTORY } from "../src/dynamodb/action-inventory.js";
import { DynamoDbService } from "../src/dynamodb.js";

const officialDynamoDbActions = [
  "BatchExecuteStatement", "BatchGetItem", "BatchWriteItem", "CreateBackup", "CreateGlobalTable", "CreateTable", "DeleteBackup", "DeleteItem", "DeleteResourcePolicy", "DeleteTable", "DescribeBackup", "DescribeContinuousBackups", "DescribeContributorInsights", "DescribeEndpoints", "DescribeExport", "DescribeGlobalTable", "DescribeGlobalTableSettings", "DescribeImport", "DescribeKinesisStreamingDestination", "DescribeLimits", "DescribeTable", "DescribeTableReplicaAutoScaling", "DescribeTimeToLive", "DisableKinesisStreamingDestination", "EnableKinesisStreamingDestination", "ExecuteStatement", "ExecuteTransaction", "ExportTableToPointInTime", "GetItem", "GetResourcePolicy", "ImportTable", "ListBackups", "ListContributorInsights", "ListExports", "ListGlobalTables", "ListImports", "ListTables", "ListTagsOfResource", "PutItem", "PutResourcePolicy", "Query", "RestoreTableFromBackup", "RestoreTableToPointInTime", "Scan", "TagResource", "TransactGetItems", "TransactWriteItems", "UntagResource", "UpdateContinuousBackups", "UpdateContributorInsights", "UpdateGlobalTable", "UpdateGlobalTableSettings", "UpdateItem", "UpdateKinesisStreamingDestination", "UpdateTable", "UpdateTableReplicaAutoScaling", "UpdateTimeToLive",
];

test("DynamoDB action inventory matches the current official action index and every action is routed", () => {
  assert.equal(DYNAMODB_ACTION_INVENTORY_SOURCE.url, "https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Operations.html");
  assert.deepEqual(DYNAMODB_ACTION_INVENTORY.map(entry => entry.action), officialDynamoDbActions);
  assert.equal(new Set(DYNAMODB_ACTION_INVENTORY.map(entry => entry.action)).size, officialDynamoDbActions.length);
  assert.equal(DYNAMODB_ACTION_INVENTORY.every(entry => entry.status === "implemented"), true);
  for (const entry of DYNAMODB_ACTION_INVENTORY) assert.equal(typeof (DynamoDbService.prototype as any)[entry.action], "function", `${entry.action} needs a modeled route`);
  for (const action of DYNAMODB_STREAMS_ACTION_INVENTORY) assert.equal(typeof (DynamoDbService.prototype as any)[action], "function", `${action} needs a modeled route`);
});
