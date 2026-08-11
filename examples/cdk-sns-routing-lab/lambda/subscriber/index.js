const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");

const dynamodb = new DynamoDBClient({});
const tableName = process.env.DELIVERIES_TABLE;
const routeId = process.env.ROUTE_ID;
const routeName = process.env.ROUTE_NAME;

function text(value) {
  return { S: String(value) };
}

exports.handler = async function handler(event) {
  for (const record of event?.Records ?? []) {
    const notification = record.Sns ?? record.sns;
    if (!notification?.Message) throw new Error("Expected an SNS Lambda notification envelope");
    const message = JSON.parse(notification.Message);
    const attributes = notification.MessageAttributes ?? {};
    await dynamodb.send(new PutItemCommand({
      TableName: tableName,
      Item: {
        incidentId: text(message.incidentId),
        routeId: text(routeId),
        routeName: text(routeName),
        protocol: text("lambda"),
        envelope: text("Records[].Sns"),
        snsMessageId: text(notification.MessageId),
        deliveredAt: text(new Date().toISOString()),
        detail: text(JSON.stringify({
          subject: notification.Subject,
          severity: attributes.severity?.Value,
          service: attributes.service?.Value,
          environment: attributes.environment?.Value,
        })),
      },
    }));
  }
  return { received: event?.Records?.length ?? 0, routeId };
};
