import {
  CONNECTION_TABLE,
  db,
  GetCommand,
  nowSeconds,
  sha256,
  UpdateCommand,
  APPLICATION_TABLE,
  WS_PK,
} from "../shared/runtime.js";

const deny = (event: any) => ({
  principalId: "anonymous",
  policyDocument: {
    Version: "2012-10-17",
    Statement: [{ Action: "execute-api:Invoke", Effect: "Deny", Resource: event.methodArn ?? "*" }],
  },
});

export async function handler(event: any) {
  const token = event?.queryStringParameters?.ticket;
  if (typeof token !== "string" || token.length < 40) return deny(event);
  const key = { PK: `TICKET#${sha256(token)}` };
  const ticket = (await db.send(new GetCommand({ TableName: CONNECTION_TABLE, Key: key, ConsistentRead: true }))).Item;
  if (!ticket || ticket.consumed || ticket.expiresAt <= nowSeconds()) return deny(event);
  const binding = (await db.send(new GetCommand({
    TableName: APPLICATION_TABLE,
    Key: { PK: WS_PK, SK: `IDENTITY#SUB#${ticket.subject}` },
    ConsistentRead: true,
  }))).Item;
  const member = binding ? (await db.send(new GetCommand({
    TableName: APPLICATION_TABLE,
    Key: { PK: WS_PK, SK: `MEMBER#${binding.memberId}` },
    ConsistentRead: true,
  }))).Item : undefined;
  if (binding?.status !== "ACTIVE" || member?.status !== "ACTIVE" || member.memberId !== ticket.memberId) return deny(event);
  try {
    await db.send(new UpdateCommand({
      TableName: CONNECTION_TABLE,
      Key: key,
      UpdateExpression: "SET consumed = :true, consumedAt = :at",
      ConditionExpression: "consumed = :false AND expiresAt > :now",
      ExpressionAttributeValues: { ":true": true, ":false": false, ":at": nowSeconds(), ":now": nowSeconds() },
    }));
  } catch { return deny(event); }
  return {
    principalId: ticket.subject,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: event.methodArn }],
    },
    context: {
      subject: ticket.subject,
      memberId: ticket.memberId,
      workspaceId: ticket.workspaceId,
    },
  };
}
