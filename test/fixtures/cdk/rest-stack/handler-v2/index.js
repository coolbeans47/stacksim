const { DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");

const dynamodb = new DynamoDBClient({});
const release = "v2";

exports.handler = async function handler(event) {
  const request = event.body ? JSON.parse(event.body) : {};
  const id = request.id || String(event.path || "").split("/").filter(Boolean).at(-1);
  let item;
  if (event.httpMethod === "POST") {
    item = { id, value: request.value };
    await dynamodb.send(new PutItemCommand({
      TableName: process.env.TABLE_NAME,
      Item: { id: { S: id }, value: { S: String(request.value ?? "") } },
    }));
  } else if (event.httpMethod === "PUT" && id) {
    const updated = await dynamodb.send(new UpdateItemCommand({
      TableName: process.env.TABLE_NAME,
      Key: { id: { S: id } },
      UpdateExpression: "SET #value = :value",
      ExpressionAttributeNames: { "#value": "value" },
      ExpressionAttributeValues: { ":value": { S: String(request.value ?? "") } },
      ReturnValues: "ALL_NEW",
    }));
    item = { id: updated.Attributes.id.S, value: updated.Attributes.value.S };
  } else if (event.httpMethod === "DELETE" && id) {
    const deleted = await dynamodb.send(new DeleteItemCommand({ TableName: process.env.TABLE_NAME, Key: { id: { S: id } }, ReturnValues: "ALL_OLD" }));
    if (deleted.Attributes) item = { id: deleted.Attributes.id.S, value: deleted.Attributes.value.S };
  } else if (event.httpMethod === "GET" && id) {
    const found = await dynamodb.send(new GetItemCommand({ TableName: process.env.TABLE_NAME, Key: { id: { S: id } } }));
    if (found.Item) item = { id: found.Item.id.S, value: found.Item.value.S };
  }
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, tableName: process.env.TABLE_NAME, release, path: event.path, item }),
  };
};
