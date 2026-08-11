import {
  APPLICATION_TABLE,
  CONNECTION_TABLE,
  db,
  DeleteCommand,
  GetCommand,
  nowSeconds,
  PutCommand,
  UpdateCommand,
  WS_PK,
} from "../shared/runtime.js";

export async function handler(event: any) {
  const route = event?.requestContext?.routeKey;
  const connectionId = event?.requestContext?.connectionId;
  if (!connectionId) return { statusCode: 400, body: "Missing connection" };
  if (route === "$disconnect") {
    await db.send(new DeleteCommand({ TableName: CONNECTION_TABLE, Key: { PK: `CONNECTION#${connectionId}` } }));
    return { statusCode: 200, body: "Disconnected" };
  }
  if (route === "$connect") {
    const context = event?.requestContext?.authorizer ?? {};
    const member = context.memberId ? (await db.send(new GetCommand({
      TableName: APPLICATION_TABLE,
      Key: { PK: WS_PK, SK: `MEMBER#${context.memberId}` },
      ConsistentRead: true,
    }))).Item : undefined;
    if (!member || member.status !== "ACTIVE" || member.cognitoSub !== context.subject) return { statusCode: 403, body: "Forbidden" };
    await db.send(new PutCommand({
      TableName: CONNECTION_TABLE,
      Item: {
        PK: `CONNECTION#${connectionId}`,
        entityType: "CONNECTION",
        connectionId,
        subject: context.subject,
        memberId: context.memberId,
        workspaceId: context.workspaceId,
        GSI1PK: `WS#${context.workspaceId}`,
        GSI1SK: `CONNECTION#${connectionId}`,
        connectedAt: nowSeconds(),
        expiresAt: nowSeconds() + 7200,
      },
    }));
    return { statusCode: 200, body: "Connected" };
  }
  let body: any = {};
  try { body = JSON.parse(event.body ?? "{}"); } catch {}
  if (body.action !== "ping") return { statusCode: 400, body: "Only ping is supported" };
  await db.send(new UpdateCommand({
    TableName: CONNECTION_TABLE,
    Key: { PK: `CONNECTION#${connectionId}` },
    UpdateExpression: "SET expiresAt = :expires",
    ConditionExpression: "expiresAt > :now",
    ExpressionAttributeValues: { ":expires": nowSeconds() + 7200, ":now": nowSeconds() },
  }));
  return { statusCode: 200, body: "pong" };
}
