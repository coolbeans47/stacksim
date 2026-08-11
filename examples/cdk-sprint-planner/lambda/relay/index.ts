import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  APPLICATION_TABLE,
  db,
  GetCommand,
  nowSeconds,
  WORKSPACE_ID,
  WS_PK,
} from "../shared/runtime.js";

const sqs = new SQSClient({});
const queueUrl = process.env.NOTIFICATION_QUEUE_URL!;
const eligible = new Set(["TicketAssigned", "SprintStarted", "SprintCompleted"]);

export async function handler(event: any) {
  const envelope = typeof event?.detail === "string" ? JSON.parse(event.detail) : event?.detail ?? event;
  if (envelope?.eventType === "SmokeProbe") {
    const message = { kind: "SMOKE_PROBE", schemaVersion: 1, eventId: envelope.eventId, workspaceId: WORKSPACE_ID, expiresAt: nowSeconds() + 300 };
    const result = await sqs.send(new SendMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: [{ Id: "probe", MessageBody: JSON.stringify(message) }],
    }));
    if (result.Failed?.length) throw new Error(result.Failed[0].Code ?? "SendMessageBatchFailed");
    return { relayed: 1 };
  }
  if (!eligible.has(envelope?.eventType)) return { ignored: true };
  let recipients: string[] = [];
  if (envelope.eventType === "TicketAssigned" && envelope.detail?.recipientMemberId) {
    recipients = [envelope.detail.recipientMemberId];
  } else {
    const roster = await db.send(new GetCommand({
      TableName: APPLICATION_TABLE,
      Key: { PK: WS_PK, SK: "SINGLETON#ACTIVE_MEMBERS" },
      ConsistentRead: true,
    }));
    recipients = roster.Item?.memberIds ?? [];
  }
  const messages = recipients.slice(0, 25).map(recipientMemberId => ({
    kind: "NOTIFICATION",
    schemaVersion: 1,
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    workspaceId: envelope.workspaceId,
    entityId: envelope.entityId,
    entityVersion: envelope.entityVersion,
    recipientMemberId,
    occurredAt: envelope.occurredAt,
  }));
  for (let index = 0; index < messages.length; index += 10) {
    const page = messages.slice(index, index + 10);
    const result = await sqs.send(new SendMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: page.map((message, offset) => ({ Id: `${index + offset}`, MessageBody: JSON.stringify(message) })),
    }));
    if (result.Failed?.length) throw new Error(result.Failed.map(value => value.Code).join(","));
  }
  return { relayed: messages.length };
}
