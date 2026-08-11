import { SESClient, SendTemplatedEmailCommand } from "@aws-sdk/client-ses";
import {
  APPLICATION_TABLE,
  db,
  GetCommand,
  nowIso,
  nowSeconds,
  PutCommand,
  UpdateCommand,
  WS_PK,
} from "../shared/runtime.js";

const ses = new SESClient({});
const fromAddress = process.env.FROM_ADDRESS!;
const template = process.env.NOTIFICATION_TEMPLATE!;

async function processMessage(message: any) {
  if (message.kind === "SMOKE_PROBE") {
    await db.send(new PutCommand({
      TableName: APPLICATION_TABLE,
      Item: {
        PK: WS_PK,
        SK: `PROBE#${message.eventId}`,
        entityType: "PROBE",
        eventId: message.eventId,
        state: "COMPLETED",
        completedAt: nowIso(),
        expiresAt: nowSeconds() + 300,
      },
    }));
    return;
  }
  const member = (await db.send(new GetCommand({
    TableName: APPLICATION_TABLE,
    Key: { PK: WS_PK, SK: `MEMBER#${message.recipientMemberId}` },
    ConsistentRead: true,
  }))).Item;
  const deliveryKey = { PK: WS_PK, SK: `DELIVERY#${message.eventId}#${message.recipientMemberId}` };
  if (!member || member.status !== "ACTIVE") {
    await db.send(new PutCommand({
      TableName: APPLICATION_TABLE,
      Item: { ...deliveryKey, entityType: "DELIVERY", state: "SUPPRESSED", reason: "INACTIVE_MEMBER", expiresAt: nowSeconds() + 604_800 },
    }));
    return;
  }
  const cursorKey = { PK: WS_PK, SK: `NOTIFY#${member.memberId}#${message.eventType}#${message.entityId}` };
  const cursor = (await db.send(new GetCommand({ TableName: APPLICATION_TABLE, Key: cursorKey, ConsistentRead: true }))).Item;
  if ((cursor?.entityVersion ?? 0) >= message.entityVersion) return;
  const existing = (await db.send(new GetCommand({ TableName: APPLICATION_TABLE, Key: deliveryKey, ConsistentRead: true }))).Item;
  if (existing?.state === "DELIVERED") return;
  if (existing?.state === "PENDING" && existing.leaseExpiresAt > nowSeconds()) throw new Error("Delivery lease is active");
  await db.send(new PutCommand({
    TableName: APPLICATION_TABLE,
    Item: {
      ...deliveryKey,
      entityType: "DELIVERY",
      eventId: message.eventId,
      memberId: member.memberId,
      entityVersion: message.entityVersion,
      state: "PENDING",
      leaseExpiresAt: nowSeconds() + 45,
      createdAt: existing?.createdAt ?? nowIso(),
    },
  }));
  const subject = message.eventType === "TicketAssigned"
    ? `${message.entityId} was assigned to you`
    : message.eventType === "SprintStarted" ? "A sprint has started" : "A sprint was completed";
  const result = await ses.send(new SendTemplatedEmailCommand({
    Source: fromAddress,
    Destination: { ToAddresses: [member.email] },
    Template: template,
    TemplateData: JSON.stringify({
      subject,
      message: `Open Northstar Product to see the latest ${message.eventType.replace(/([A-Z])/g, " $1").toLowerCase()}.`,
    }),
  }));
  await db.send(new UpdateCommand({
    TableName: APPLICATION_TABLE,
    Key: deliveryKey,
    UpdateExpression: "SET #state = :delivered, sesMessageId = :messageId, deliveredAt = :at, expiresAt = :expires REMOVE leaseExpiresAt",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: {
      ":delivered": "DELIVERED",
      ":messageId": result.MessageId,
      ":at": nowIso(),
      ":expires": nowSeconds() + 604_800,
    },
  }));
  await db.send(new PutCommand({
    TableName: APPLICATION_TABLE,
    Item: { ...cursorKey, entityType: "NOTIFICATION_CURSOR", entityVersion: message.entityVersion, updatedAt: nowIso() },
  }));
}

export async function handler(event: any) {
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event?.Records ?? []) {
    try { await processMessage(JSON.parse(record.body)); }
    catch { failures.push({ itemIdentifier: record.messageId }); }
  }
  return { batchItemFailures: failures };
}
