const {
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} = require("@aws-sdk/client-dynamodb");

const dynamodb = new DynamoDBClient({});

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function noteFromItem(item) {
  return {
    id: item.id.S,
    title: item.title.S,
  };
}

exports.handler = async function handler(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod;
  const tableName = process.env.TABLE_NAME;

  if (method === "GET") {
    const result = await dynamodb.send(new ScanCommand({ TableName: tableName }));
    return response(200, {
      items: (result.Items ?? []).map(noteFromItem),
    });
  }

  if (method === "POST") {
    let input;
    try {
      input = JSON.parse(event.body ?? "{}");
    } catch {
      return response(400, { message: "Request body must be valid JSON." });
    }

    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) return response(400, { message: "title is required." });

    const note = {
      id: typeof input.id === "string" && input.id ? input.id : crypto.randomUUID(),
      title,
    };

    await dynamodb.send(new PutItemCommand({
      TableName: tableName,
      Item: {
        id: { S: note.id },
        title: { S: note.title },
      },
      ConditionExpression: "attribute_not_exists(id)",
    }));

    return response(201, note);
  }

  return response(405, { message: "Method not allowed." });
};
