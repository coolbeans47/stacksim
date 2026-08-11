import { DescribeTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { TestClock } from "../../src/core/clock.js";
import { waitUntil } from "./polling.js";

/** Advance deterministic lifecycle timers, then wait for the table's data plane to become available. */
export async function waitForTableActive(client: DynamoDBClient, tableName: string, clock?: TestClock): Promise<void> {
  if (clock) {
    clock.advance(50);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  await waitUntil(
    async () => (await client.send(new DescribeTableCommand({ TableName: tableName }))).Table?.TableStatus,
    status => status === "ACTIVE",
    { timeoutMs: 5_000, intervalMs: 10, timeoutMessage: `Timed out waiting for DynamoDB table ${tableName} to become ACTIVE` },
  );
}
