import { PutEventsCommand, EventBridgeClient } from "@aws-sdk/client-eventbridge";
import {
  APPLICATION_TABLE,
  db,
  GetCommand,
  log,
  nowIso,
  nowSeconds,
  UpdateCommand,
  WS_PK,
} from "../shared/runtime.js";

const events = new EventBridgeClient({});
const busName = process.env.EVENT_BUS_NAME!;

function keys(record: any): { PK: string; SK: string } | undefined {
  const image = record?.dynamodb?.Keys;
  if (image?.PK?.S && image?.SK?.S) return { PK: image.PK.S, SK: image.SK.S };
  return undefined;
}

async function publish(key: { PK: string; SK: string }) {
  const item = (await db.send(new GetCommand({
    TableName: APPLICATION_TABLE,
    Key: key,
    ConsistentRead: true,
  }))).Item;
  if (!item || item.entityType !== "OUTBOX" || item.deliveryState === "PUBLISHED") return;
  await db.send(new UpdateCommand({
    TableName: APPLICATION_TABLE,
    Key: key,
    UpdateExpression: "SET attemptCount = if_not_exists(attemptCount, :zero) + :one, lastAttemptAt = :at",
    ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":at": nowIso() },
  }));
  const result = await events.send(new PutEventsCommand({
    Entries: [{
      EventBusName: busName,
      Source: "sprint.planner",
      DetailType: "Sprint Planner Domain Event",
      Detail: JSON.stringify(item.envelope),
      Time: new Date(item.envelope.occurredAt),
    }],
  }));
  if (result.FailedEntryCount || result.Entries?.[0]?.ErrorCode) {
    throw new Error(result.Entries?.[0]?.ErrorCode ?? "PutEventsFailed");
  }
  const publishedAt = nowIso();
  await db.send(new UpdateCommand({
    TableName: APPLICATION_TABLE,
    Key: key,
    UpdateExpression: "SET deliveryState = :published, publishedAt = :at, expiresAt = :expires",
    ConditionExpression: "deliveryState = :pending",
    ExpressionAttributeValues: {
      ":published": "PUBLISHED",
      ":pending": "PENDING",
      ":at": publishedAt,
      ":expires": nowSeconds() + 604_800,
    },
  }));
  log("info", {
    eventId: item.eventId,
    result: "published",
    publicationLatencyMs: Date.parse(publishedAt) - Date.parse(item.occurredAt),
  });
}

export async function handler(event: any) {
  const failures: Array<{ itemIdentifier: string }> = [];
  const records = event?.Records ?? [];
  if (event?.operatorReplay?.eventId) {
    await publish({ PK: WS_PK, SK: `OUTBOX#${event.operatorReplay.eventId}` });
    return { replayed: event.operatorReplay.eventId };
  }
  for (const record of records) {
    const key = keys(record);
    if (!key) continue;
    try { await publish(key); }
    catch (error: any) {
      failures.push({ itemIdentifier: record.eventID ?? key.SK });
      log("error", { eventId: key.SK.slice("OUTBOX#".length), code: error?.name ?? "PUBLISH_FAILED", result: "error" });
    }
  }
  return { batchItemFailures: failures };
}
