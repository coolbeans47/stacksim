const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");

const dynamodb = new DynamoDBClient({});
const tableName = process.env.DELIVERIES_TABLE;
const routeId = process.env.ROUTE_ID;
const routeName = process.env.ROUTE_NAME;

function text(value) {
  return { S: String(value) };
}

exports.handler = async function handler(event) {
  const failures = [];
  for (const record of event?.Records ?? []) {
    try {
      const message = JSON.parse(record.body);
      await dynamodb.send(new PutItemCommand({
        TableName: tableName,
        Item: {
          incidentId: text(message.incidentId),
          routeId: text(routeId),
          routeName: text(routeName),
          protocol: text("sqs"),
          envelope: text("raw SNS message"),
          snsMessageId: text(record.messageId),
          deliveredAt: text(new Date().toISOString()),
          detail: text(JSON.stringify({
            queueMessageId: record.messageId,
            rawBody: true,
            attributes: Object.keys(record.messageAttributes ?? {}).sort(),
          })),
        },
      }));
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "audit_delivery_failed", messageId: record.messageId, message: error.message }));
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};
