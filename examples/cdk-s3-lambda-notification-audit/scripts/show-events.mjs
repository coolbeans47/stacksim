import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { clientOptions, deployedOutputs } from "./runtime.mjs";

const outputs = await deployedOutputs();
const dynamodb = new DynamoDBClient(clientOptions());

try {
  const result = await dynamodb.send(new ScanCommand({ TableName: outputs.AuditTableName }));
  const rows = (result.Items ?? []).map(item => ({
    time: item.eventTime?.S,
    event: item.eventName?.S,
    object: item.objectKey?.S ?? "–",
    version: item.objectVersionId?.S ?? "–",
    configuration: item.configurationId?.S ?? "–",
    deleteMarker: item.deleteMarker?.BOOL ?? false,
  })).sort((left, right) => String(left.time).localeCompare(String(right.time)));

  console.log(`Audit table: ${outputs.AuditTableName}`);
  console.table(rows);
  console.log(`${rows.length} event record${rows.length === 1 ? "" : "s"}`);
} finally {
  dynamodb.destroy();
}
