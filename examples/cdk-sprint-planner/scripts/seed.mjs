import {
  DeleteItemCommand,
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  ListTagsOfResourceCommand,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, projectRoot } from "./config.mjs";
import {
  createSeedItems,
  DEMO_SPRINT_IDS,
  DEMO_TICKET_KEYS,
  expectedSeedCounts,
  WORKSPACE_ID,
} from "../seed/demo-data.mjs";

const reset = process.argv.includes("--reset-demo");
const config = await loadConfig();
const deploymentPath = join(projectRoot, ".runtime", "deployment.json");
let deployment;
try { deployment = JSON.parse(await readFile(deploymentPath, "utf8")); }
catch { throw new Error(`Run npm run deploy first; ${deploymentPath} is unavailable`); }
if (deployment.accountId !== config.accountId || deployment.region !== config.region) {
  throw new Error("Deployment manifest account/Region does not match local configuration");
}
const tableName = deployment.applicationTableName;
if (typeof tableName !== "string" || !tableName) throw new Error("Deployment manifest has no application table");

const client = new DynamoDBClient({
  region: config.region,
  endpoint: config.controlPlaneEndpoint,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "admin",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "password",
  },
});
const table = (await client.send(new DescribeTableCommand({ TableName: tableName }))).Table;
if (!table?.TableArn || table.KeySchema?.length !== 2) throw new Error("Resolved application table does not match the Sprint Planner shape");
const tags = (await client.send(new ListTagsOfResourceCommand({ ResourceArn: table.TableArn }))).Tags ?? [];
if (!tags.some(tag => tag.Key === "application" && tag.Value === "sprint-planner")) {
  throw new Error("Refusing to seed a table not tagged as Sprint Planner");
}

const wsPk = `WS#${WORKSPACE_ID}`;
if (reset) {
  const page = await client.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: marshall({ ":pk": wsPk }),
    ConsistentRead: true,
  }));
  const current = (page.Items ?? []).map(item => unmarshall(item));
  const nonSeedTicket = current.find(item =>
    item.entityType === "TICKET"
    && item.seedOwner !== "sprint-planner"
    && DEMO_SPRINT_IDS.includes(item.sprintId));
  if (nonSeedTicket) throw new Error(`Reset is unsafe: ${nonSeedTicket.ticketKey} refers to a demo sprint`);
  const protectedTypes = new Set(["WORKSPACE", "ACTIVE_MEMBER_ROSTER", "BOOTSTRAP", "MEMBER", "EMAIL_BINDING", "SUBJECT_BINDING"]);
  const owned = current.filter(item => item.seedOwner === "sprint-planner" && !protectedTypes.has(item.entityType));
  for (const item of owned) {
    await client.send(new DeleteItemCommand({ TableName: tableName, Key: marshall({ PK: item.PK, SK: item.SK }) }));
  }
  for (const ticketKey of DEMO_TICKET_KEYS) {
    const comments = await client.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: marshall({ ":pk": `${wsPk}#TICKET#${ticketKey}` }),
      ConsistentRead: true,
    }));
    for (const raw of comments.Items ?? []) {
      const item = unmarshall(raw);
      if (item.seedOwner === "sprint-planner") {
        await client.send(new DeleteItemCommand({ TableName: tableName, Key: marshall({ PK: item.PK, SK: item.SK }) }));
      }
    }
  }
}

let created = 0;
let existing = 0;
for (const item of createSeedItems(config)) {
  try {
    await client.send(new PutItemCommand({
      TableName: tableName,
      Item: marshall(item, { removeUndefinedValues: true }),
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    }));
    created += 1;
  } catch (error) {
    if (error.name !== "ConditionalCheckFailedException") throw error;
    existing += 1;
  }
}
const marker = await client.send(new GetItemCommand({
  TableName: tableName,
  Key: marshall({ PK: "SEED#sprint-planner", SK: "VERSION#1" }),
  ConsistentRead: true,
}));
if (!marker.Item) throw new Error("Seed marker was not created");
console.log(JSON.stringify({
  workspaceId: WORKSPACE_ID,
  created,
  existing,
  reset,
  expected: expectedSeedCounts,
}, null, 2));
client.destroy();
