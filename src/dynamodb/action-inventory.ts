export type DynamoActionStatus = "implemented" | "dependency-blocked";

export interface DynamoActionInventoryEntry {
  action: string;
  phase: string;
  status: DynamoActionStatus;
}

export const DYNAMODB_ACTION_INVENTORY_SOURCE = {
  checked: "2026-07-15",
  url: "https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Operations.html",
} as const;

export const DYNAMODB_ACTION_INVENTORY: readonly DynamoActionInventoryEntry[] = [
  { action: "BatchExecuteStatement", phase: "DDB-05/DDB-11", status: "implemented" },
  { action: "BatchGetItem", phase: "DDB-01", status: "implemented" },
  { action: "BatchWriteItem", phase: "DDB-01", status: "implemented" },
  { action: "CreateBackup", phase: "DDB-07", status: "implemented" },
  { action: "CreateGlobalTable", phase: "DDB-10", status: "implemented" },
  { action: "CreateTable", phase: "DDB-01/DDB-02/DDB-06/DDB-09", status: "implemented" },
  { action: "DeleteBackup", phase: "DDB-07", status: "implemented" },
  { action: "DeleteItem", phase: "DDB-01", status: "implemented" },
  { action: "DeleteResourcePolicy", phase: "DDB-09", status: "implemented" },
  { action: "DeleteTable", phase: "DDB-01/DDB-06", status: "implemented" },
  { action: "DescribeBackup", phase: "DDB-07", status: "implemented" },
  { action: "DescribeContinuousBackups", phase: "DDB-07", status: "implemented" },
  { action: "DescribeContributorInsights", phase: "DDB-10", status: "implemented" },
  { action: "DescribeEndpoints", phase: "DDB-01", status: "implemented" },
  { action: "DescribeExport", phase: "DDB-10/DUG-12", status: "implemented" },
  { action: "DescribeGlobalTable", phase: "DDB-10", status: "implemented" },
  { action: "DescribeGlobalTableSettings", phase: "DDB-10", status: "implemented" },
  { action: "DescribeImport", phase: "DDB-10/DUG-12", status: "implemented" },
  { action: "DescribeKinesisStreamingDestination", phase: "DDB-10", status: "implemented" },
  { action: "DescribeLimits", phase: "DDB-06", status: "implemented" },
  { action: "DescribeTable", phase: "DDB-01/DDB-02/DDB-06/DDB-08", status: "implemented" },
  { action: "DescribeTableReplicaAutoScaling", phase: "DDB-06", status: "implemented" },
  { action: "DescribeTimeToLive", phase: "DDB-04", status: "implemented" },
  { action: "DisableKinesisStreamingDestination", phase: "DDB-10", status: "implemented" },
  { action: "EnableKinesisStreamingDestination", phase: "DDB-10", status: "implemented" },
  { action: "ExecuteStatement", phase: "DDB-05/DDB-11", status: "implemented" },
  { action: "ExecuteTransaction", phase: "DDB-05/DDB-11", status: "implemented" },
  { action: "ExportTableToPointInTime", phase: "DDB-10/DUG-12/DDB-INT-001", status: "implemented" },
  { action: "GetItem", phase: "DDB-01", status: "implemented" },
  { action: "GetResourcePolicy", phase: "DDB-09", status: "implemented" },
  { action: "ImportTable", phase: "DDB-10/DUG-12/DDB-INT-002", status: "implemented" },
  { action: "ListBackups", phase: "DDB-07", status: "implemented" },
  { action: "ListContributorInsights", phase: "DDB-10", status: "implemented" },
  { action: "ListExports", phase: "DDB-10/DUG-12", status: "implemented" },
  { action: "ListGlobalTables", phase: "DDB-10", status: "implemented" },
  { action: "ListImports", phase: "DDB-10/DUG-12", status: "implemented" },
  { action: "ListTables", phase: "DDB-01", status: "implemented" },
  { action: "ListTagsOfResource", phase: "DDB-06", status: "implemented" },
  { action: "PutItem", phase: "DDB-01", status: "implemented" },
  { action: "PutResourcePolicy", phase: "DDB-09", status: "implemented" },
  { action: "Query", phase: "DDB-01/DDB-02", status: "implemented" },
  { action: "RestoreTableFromBackup", phase: "DDB-07", status: "implemented" },
  { action: "RestoreTableToPointInTime", phase: "DDB-07", status: "implemented" },
  { action: "Scan", phase: "DDB-01/DDB-02", status: "implemented" },
  { action: "TagResource", phase: "DDB-06", status: "implemented" },
  { action: "TransactGetItems", phase: "DDB-03", status: "implemented" },
  { action: "TransactWriteItems", phase: "DDB-03", status: "implemented" },
  { action: "UntagResource", phase: "DDB-06", status: "implemented" },
  { action: "UpdateContinuousBackups", phase: "DDB-07", status: "implemented" },
  { action: "UpdateContributorInsights", phase: "DDB-10", status: "implemented" },
  { action: "UpdateGlobalTable", phase: "DDB-10", status: "implemented" },
  { action: "UpdateGlobalTableSettings", phase: "DDB-10", status: "implemented" },
  { action: "UpdateItem", phase: "DDB-01", status: "implemented" },
  { action: "UpdateKinesisStreamingDestination", phase: "DDB-10", status: "implemented" },
  { action: "UpdateTable", phase: "DDB-02/DDB-06/DDB-08/DDB-10", status: "implemented" },
  { action: "UpdateTableReplicaAutoScaling", phase: "DDB-06", status: "implemented" },
  { action: "UpdateTimeToLive", phase: "DDB-04", status: "implemented" },
] as const;

export const DYNAMODB_STREAMS_ACTION_INVENTORY = ["DescribeStream", "GetRecords", "GetShardIterator", "ListStreams"] as const;
