const {
  SendMessageCommand,
  SQSClient,
} = require("@aws-sdk/client-sqs");

const sqs = new SQSClient({});
const queueUrl = process.env.JOURNEY_QUEUE_URL;

exports.handler = async function handler(event) {
  if (!queueUrl) throw new Error("JOURNEY_QUEUE_URL is required");
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("Signal Journey relay requires an EventBridge event object");
  }

  const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
  const journeyId = String(detail.journeyId ?? detail.eventId ?? event.id ?? "unknown");
  const result = await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(event),
    MessageAttributes: {
      journeyId: { DataType: "String", StringValue: journeyId },
      action: { DataType: "String", StringValue: String(detail.action ?? "unknown") },
    },
  }));

  console.log(JSON.stringify({
    level: "info",
    event: "journey_relayed",
    journeyId,
    messageId: result.MessageId,
  }));
  return {
    accepted: true,
    journeyId,
    messageId: result.MessageId,
  };
};
