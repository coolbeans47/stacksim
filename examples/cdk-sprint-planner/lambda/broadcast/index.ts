import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import {
  APPLICATION_TABLE,
  CONNECTION_TABLE,
  db,
  DeleteCommand,
  GetCommand,
  log,
  nowSeconds,
  QueryCommand,
  WS_PK,
} from "../shared/runtime.js";

const management = new ApiGatewayManagementApiClient({ endpoint: process.env.WEBSOCKET_MANAGEMENT_ENDPOINT });

export async function handler(event: any) {
  const envelope = typeof event?.detail === "string" ? JSON.parse(event.detail) : event?.detail ?? event;
  if (!envelope?.workspaceId || envelope.eventType === "SmokeProbe") return { ignored: true };
  const connections = (await db.send(new QueryCommand({
    TableName: CONNECTION_TABLE,
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk",
    ExpressionAttributeValues: { ":pk": `WS#${envelope.workspaceId}` },
  }))).Items ?? [];
  let delivered = 0;
  for (const connection of connections) {
    const member = (await db.send(new GetCommand({
      TableName: APPLICATION_TABLE,
      Key: { PK: WS_PK, SK: `MEMBER#${connection.memberId}` },
      ConsistentRead: true,
    }))).Item;
    if (connection.expiresAt <= nowSeconds() || member?.status !== "ACTIVE" || member.cognitoSub !== connection.subject) {
      await db.send(new DeleteCommand({ TableName: CONNECTION_TABLE, Key: { PK: connection.PK } }));
      try { await management.send(new DeleteConnectionCommand({ ConnectionId: connection.connectionId })); } catch {}
      continue;
    }
    try {
      await management.send(new PostToConnectionCommand({
        ConnectionId: connection.connectionId,
        Data: Buffer.from(JSON.stringify(envelope)),
      }));
      delivered += 1;
    } catch (error) {
      if (error instanceof GoneException || (error as any)?.$metadata?.httpStatusCode === 410) {
        await db.send(new DeleteCommand({ TableName: CONNECTION_TABLE, Key: { PK: connection.PK } }));
      } else throw error;
    }
  }
  log("info", { eventId: envelope.eventId, result: "broadcast", connections: delivered });
  return { delivered };
}
