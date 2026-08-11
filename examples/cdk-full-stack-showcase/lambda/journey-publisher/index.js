const {
  EventBridgeClient,
  PutEventsCommand,
} = require("@aws-sdk/client-eventbridge");

const eventbridge = new EventBridgeClient({});
const eventBusName = process.env.EVENT_BUS_NAME;
const epoch = "1970-01-01T00:00:00.000Z";

function decodeAttribute(value) {
  if (!value || typeof value !== "object") return undefined;
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return Boolean(value.BOOL);
  if (value.NULL) return null;
  if (value.B !== undefined) return value.B;
  if (Array.isArray(value.SS)) return [...value.SS];
  if (Array.isArray(value.NS)) return value.NS.map(Number);
  if (Array.isArray(value.BS)) return [...value.BS];
  if (Array.isArray(value.L)) return value.L.map(decodeAttribute);
  if (value.M && typeof value.M === "object") return decodeImage(value.M);
  return undefined;
}

function decodeImage(image) {
  if (!image || typeof image !== "object") return {};
  return Object.fromEntries(
    Object.entries(image).map(([key, value]) => [key, decodeAttribute(value)]),
  );
}

function validIso(value) {
  const milliseconds = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function occurredAt(record, signal) {
  const approximateSeconds = Number(record?.dynamodb?.ApproximateCreationDateTime);
  return (Number.isFinite(approximateSeconds) ? validIso(approximateSeconds * 1000) : undefined)
    ?? validIso(signal.observedAt)
    ?? epoch;
}

function actionFor(record, current, previous) {
  if (record.eventName === "INSERT") return "created";
  if (record.eventName === "REMOVE") return "archived";
  const intensityIncreased = Number(current.intensity ?? 0) > Number(previous.intensity ?? 0);
  const contributorsIncreased = Number(current.contributors ?? 0) > Number(previous.contributors ?? 0);
  return intensityIncreased || contributorsIncreased ? "boosted" : "updated";
}

function normalize(record) {
  const sequenceNumber = String(record?.dynamodb?.SequenceNumber ?? "");
  const eventId = String(record?.eventID ?? "");
  if (!sequenceNumber || !eventId) throw new Error("DynamoDB stream record is missing its stable identity");
  if (!["INSERT", "MODIFY", "REMOVE"].includes(record.eventName)) {
    throw new Error(`Unsupported DynamoDB stream event ${String(record.eventName)}`);
  }

  const current = decodeImage(record.dynamodb?.NewImage);
  const previous = decodeImage(record.dynamodb?.OldImage);
  const signal = record.eventName === "REMOVE" ? previous : current;
  const keys = decodeImage(record.dynamodb?.Keys);
  const signalId = String(signal.id ?? keys.id ?? "");
  if (!signalId) throw new Error("DynamoDB stream record does not identify a signal");

  const journeyId = `journey-${eventId}`;
  const simulateJourneyFailure = record.eventName !== "REMOVE" && signal.simulateJourneyFailure === true;
  const action = simulateJourneyFailure ? "fault-injected" : actionFor(record, current, previous);
  const envelope = {
    schemaVersion: "1.0",
    eventId,
    journeyId,
    correlationId: String(signal.journeyCorrelationId ?? signal.correlationId ?? journeyId),
    signalId,
    action,
    occurredAt: occurredAt(record, signal),
    simulateJourneyFailure,
    signal,
    sourceRecord: {
      eventName: record.eventName,
      sequenceNumber,
      streamArn: String(record.eventSourceARN ?? ""),
    },
  };
  return { record, sequenceNumber, envelope };
}

function entryFor(envelope) {
  return {
    EventBusName: eventBusName,
    Source: "aurora.atlas",
    DetailType: "Signal Journey",
    Detail: JSON.stringify(envelope),
    Resources: envelope.sourceRecord.streamArn ? [envelope.sourceRecord.streamArn] : [],
    Time: new Date(envelope.occurredAt),
  };
}

exports.handler = async function handler(event) {
  if (!eventBusName) throw new Error("EVENT_BUS_NAME is required");
  const records = Array.isArray(event?.Records) ? event.Records : [];
  const failures = new Set();
  const normalized = [];

  for (const record of records) {
    try {
      normalized.push(normalize(record));
    } catch (error) {
      const sequenceNumber = String(record?.dynamodb?.SequenceNumber ?? "");
      if (sequenceNumber) failures.add(sequenceNumber);
      console.error(JSON.stringify({
        level: "error",
        event: "journey_normalization_failed",
        sequenceNumber,
        message: error.message,
      }));
    }
  }

  for (let offset = 0; offset < normalized.length; offset += 10) {
    const batch = normalized.slice(offset, offset + 10);
    try {
      const result = await eventbridge.send(new PutEventsCommand({
        Entries: batch.map(item => entryFor(item.envelope)),
      }));
      batch.forEach((item, index) => {
        const accepted = result.Entries?.[index];
        if (!accepted?.EventId || accepted.ErrorCode) {
          failures.add(item.sequenceNumber);
          console.error(JSON.stringify({
            level: "error",
            event: "journey_publish_rejected",
            journeyId: item.envelope.journeyId,
            code: accepted?.ErrorCode ?? "MissingEventId",
            message: accepted?.ErrorMessage ?? "EventBridge did not return an event ID",
          }));
        }
      });
    } catch (error) {
      batch.forEach(item => failures.add(item.sequenceNumber));
      console.error(JSON.stringify({
        level: "error",
        event: "journey_publish_failed",
        sequenceNumbers: batch.map(item => item.sequenceNumber),
        message: error.message,
      }));
    }
  }

  console.log(JSON.stringify({
    level: "info",
    event: "journey_publish_batch",
    received: records.length,
    published: normalized.filter(item => !failures.has(item.sequenceNumber)).length,
    failed: failures.size,
  }));
  return {
    batchItemFailures: [...failures].map(itemIdentifier => ({ itemIdentifier })),
  };
};
