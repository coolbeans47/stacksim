import { randomUUID } from "node:crypto";
import { DynamoDBClient, PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";

// The AWS SDK for JavaScript v3 is part of the Node.js Lambda runtime, so the
// function has no dependencies to install. StackSim points it at its own endpoint.
const client = new DynamoDBClient({});
const table = process.env.TABLE_NAME;

const json = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function createNote(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
  let input;
  try { input = JSON.parse(raw || "{}"); } catch { return json(400, { message: "The request body must be JSON" }); }
  if (typeof input.text !== "string" || !input.text.trim()) return json(400, { message: "Provide a non-empty \"text\" field" });
  const note = { id: randomUUID(), text: input.text.trim(), createdAt: new Date().toISOString() };
  await client.send(new PutItemCommand({ TableName: table, Item: { id: { S: note.id }, text: { S: note.text }, createdAt: { S: note.createdAt } } }));
  return json(201, note);
}

async function listNotes() {
  const { Items = [] } = await client.send(new ScanCommand({ TableName: table }));
  const notes = Items.map(item => ({ id: item.id.S, text: item.text.S, createdAt: item.createdAt.S }));
  return json(200, notes.sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
}

/** HTTP API (payload format 2.0) handler for GET /notes and POST /notes. */
export const handler = async (event) => event.requestContext.http.method === "POST" ? createNote(event) : listNotes();
