import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  GetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, projectRoot } from "./config.mjs";
import { expectedSeedCounts, WORKSPACE_ID } from "../seed/demo-data.mjs";

const config = await loadConfig();
const deployment = JSON.parse(await readFile(join(projectRoot, ".runtime", "deployment.json"), "utf8"));
const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID || "admin", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "password" };
const ddb = new DynamoDBClient({ region: config.region, endpoint: config.controlPlaneEndpoint, credentials });
const sqs = new SQSClient({ region: config.region, endpoint: config.controlPlaneEndpoint, credentials });
const website = await fetch(deployment.websiteUrl);
if (!website.ok || !(await website.text()).includes("Sprint Planner")) throw new Error("Website HTML is unavailable");
for (const asset of ["assets/app.js", "assets/app.css", "runtime-config.json"]) {
  const result = await fetch(new URL(asset, deployment.websiteUrl));
  if (!result.ok) throw new Error(`${asset} returned HTTP ${result.status}`);
}
const runtime = await (await fetch(new URL("runtime-config.json", deployment.websiteUrl))).json();
if (Object.keys(runtime).some(key => /secret|password|token|credential/i.test(key))) throw new Error("Runtime config contains a secret-like field");
const protectedCall = await fetch(`${deployment.apiBaseUrl}/session`);
if (protectedCall.status !== 401) throw new Error(`Protected call returned ${protectedCall.status}, expected 401`);
const cors = await fetch(`${deployment.apiBaseUrl}/invitations/inspect`, {
  method: "OPTIONS",
  headers: {
    origin: new URL(deployment.websiteUrl).origin,
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  },
});
if (!cors.ok || cors.headers.get("access-control-allow-origin") !== new URL(deployment.websiteUrl).origin) throw new Error("HTTP CORS preflight failed");
const marker = await ddb.send(new GetItemCommand({
  TableName: deployment.applicationTableName,
  Key: marshall({ PK: "SEED#sprint-planner", SK: "VERSION#1" }),
  ConsistentRead: true,
}));
if (!marker.Item) throw new Error("Seed marker is missing");

const eventId = randomUUID();
const occurredAt = new Date().toISOString();
await ddb.send(new PutItemCommand({
  TableName: deployment.applicationTableName,
  Item: marshall({
    PK: `WS#${WORKSPACE_ID}`,
    SK: `OUTBOX#${eventId}`,
    entityType: "OUTBOX",
    schemaVersion: 1,
    eventId,
    deliveryState: "PENDING",
    attemptCount: 0,
    occurredAt,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    envelope: {
      schemaVersion: 1, eventId, eventType: "SmokeProbe", workspaceId: WORKSPACE_ID,
      entityId: eventId, entityVersion: 1, actorMemberId: "smoke", clientMutationId: eventId, occurredAt, detail: {},
    },
  }),
  ConditionExpression: "attribute_not_exists(PK)",
}));
const deadline = Date.now() + 30_000;
let complete = false;
while (Date.now() < deadline) {
  const [outbox, probe] = await Promise.all([
    ddb.send(new GetItemCommand({ TableName: deployment.applicationTableName, Key: marshall({ PK: `WS#${WORKSPACE_ID}`, SK: `OUTBOX#${eventId}` }), ConsistentRead: true })),
    ddb.send(new GetItemCommand({ TableName: deployment.applicationTableName, Key: marshall({ PK: `WS#${WORKSPACE_ID}`, SK: `PROBE#${eventId}` }), ConsistentRead: true })),
  ]);
  if (outbox.Item && probe.Item && unmarshall(outbox.Item).deliveryState === "PUBLISHED") { complete = true; break; }
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (!complete) throw new Error("SmokeProbe did not traverse the asynchronous pipeline");
for (const key of [
  { PK: `WS#${WORKSPACE_ID}`, SK: `OUTBOX#${eventId}` },
  { PK: `WS#${WORKSPACE_ID}`, SK: `PROBE#${eventId}` },
]) await ddb.send(new DeleteItemCommand({ TableName: deployment.applicationTableName, Key: marshall(key) }));
for (const queueUrl of [deployment.notificationDeadLetterQueueUrl, deployment.streamFailureQueueUrl, deployment.eventConsumerFailureQueueUrl]) {
  const attributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["ApproximateNumberOfMessages"] }));
  if (attributes.Attributes?.ApproximateNumberOfMessages !== "0") throw new Error(`Failure queue is not empty: ${queueUrl}`);
}
ddb.destroy(); sqs.destroy();
console.log(`Smoke passed: ${expectedSeedCounts.tickets} deterministic tickets and the full asynchronous pipeline are ready.`);
