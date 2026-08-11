const {
  DynamoDBClient,
  PutItemCommand,
} = require("@aws-sdk/client-dynamodb");

const dynamodb = new DynamoDBClient({});
const activityTable = process.env.ACTIVITY_TABLE;
const maxReceiveCount = Math.max(1, Number(process.env.MAX_RECEIVE_COUNT ?? 3));
const activityLifetimeSeconds = 30 * 24 * 60 * 60;

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseDelivery(record) {
  const event = object(JSON.parse(String(record.body ?? "")));
  const detail = object(event.detail);
  return {
    event,
    detail: Object.keys(detail).length ? detail : event,
  };
}

function string(value, fallback) {
  const candidate = String(value ?? "").trim();
  return candidate || fallback;
}

function activityFor(record, delivery, receiveCount) {
  const detail = delivery.detail;
  const signal = object(detail.signal);
  const eventId = string(detail.eventId, string(delivery.event.id, record.messageId));
  const journeyId = string(detail.journeyId, `journey-${eventId}`);
  const simulateFailure = String(detail.action ?? "") === "fault-injected" && (
    detail.simulateJourneyFailure === true
    || delivery.event.simulateJourneyFailure === true
    || signal.simulateJourneyFailure === true
  );
  const status = simulateFailure
    ? receiveCount >= maxReceiveCount ? "quarantined" : "retrying"
    : "processed";
  const stage = status === "processed"
    ? "worker"
    : status === "quarantined" ? "dead-letter-queue" : "queue-retry";
  const processedAt = new Date().toISOString();
  return {
    journeyId,
    activityId: status === "processed"
      ? "processed"
      : `${status}#${String(receiveCount).padStart(3, "0")}`,
    eventId,
    correlationId: string(detail.correlationId, journeyId),
    signalId: string(detail.signalId, "relay-fault"),
    action: string(detail.action, simulateFailure ? "fault-injected" : "processed"),
    title: string(signal.title, string(detail.signalId, "Untitled signal")),
    category: string(signal.category, "Unknown"),
    intensity: Number(signal.intensity ?? 0),
    stage,
    status,
    occurredAt: string(detail.occurredAt, string(delivery.event.time, processedAt)),
    processedAt,
    receiveCount,
    queueMessageId: string(record.messageId, eventId),
    simulateJourneyFailure: simulateFailure,
    error: simulateFailure
      ? status === "quarantined"
        ? `Simulated worker failure exhausted ${maxReceiveCount} delivery attempts`
        : `Simulated worker failure on delivery attempt ${receiveCount}`
      : undefined,
    payload: JSON.stringify(detail),
    expiresAt: Math.floor(Date.now() / 1000) + activityLifetimeSeconds,
  };
}

function encode(activity) {
  return {
    journeyId: { S: activity.journeyId },
    activityId: { S: activity.activityId },
    eventId: { S: activity.eventId },
    correlationId: { S: activity.correlationId },
    signalId: { S: activity.signalId },
    action: { S: activity.action },
    title: { S: activity.title },
    category: { S: activity.category },
    intensity: { N: String(activity.intensity) },
    stage: { S: activity.stage },
    status: { S: activity.status },
    occurredAt: { S: activity.occurredAt },
    processedAt: { S: activity.processedAt },
    receiveCount: { N: String(activity.receiveCount) },
    queueMessageId: { S: activity.queueMessageId },
    simulateJourneyFailure: { BOOL: activity.simulateJourneyFailure },
    payload: { S: activity.payload },
    expiresAt: { N: String(activity.expiresAt) },
    ...(activity.error ? { error: { S: activity.error } } : {}),
  };
}

async function recordActivity(activity) {
  await dynamodb.send(new PutItemCommand({
    TableName: activityTable,
    Item: encode(activity),
  }));
}

exports.handler = async function handler(event) {
  if (!activityTable) throw new Error("ACTIVITY_TABLE is required");
  const records = Array.isArray(event?.Records) ? event.Records : [];
  const batchItemFailures = [];

  for (const record of records) {
    const messageId = string(record?.messageId, "");
    try {
      const delivery = parseDelivery(record);
      const receiveCount = Math.max(
        1,
        Number(record?.attributes?.ApproximateReceiveCount ?? 1),
      );
      const activity = activityFor(record, delivery, receiveCount);
      await recordActivity(activity);
      console.log(JSON.stringify({
        level: "info",
        event: "journey_activity_recorded",
        journeyId: activity.journeyId,
        status: activity.status,
        receiveCount,
        messageId,
      }));
      if (activity.simulateJourneyFailure) {
        batchItemFailures.push({ itemIdentifier: messageId });
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "journey_worker_failed",
        messageId,
        message: error.message,
      }));
      if (messageId) batchItemFailures.push({ itemIdentifier: messageId });
    }
  }

  return { batchItemFailures };
};
