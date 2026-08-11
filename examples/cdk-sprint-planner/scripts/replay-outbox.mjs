import { GetItemCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, projectRoot } from "./config.mjs";

const index = process.argv.indexOf("--event-id");
const eventId = index >= 0 ? process.argv[index + 1] : undefined;
if (!eventId || !/^[0-9a-f-]{16,64}$/i.test(eventId)) throw new Error("Usage: npm run replay:outbox -- --event-id <id>");
const config = await loadConfig();
const deployment = JSON.parse(await readFile(join(projectRoot, ".runtime", "deployment.json"), "utf8"));
if (deployment.accountId !== config.accountId || deployment.region !== config.region) throw new Error("Deployment does not match local configuration");
const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID || "admin", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "password" };
const common = { region: config.region, endpoint: config.controlPlaneEndpoint, credentials };
const ddb = new DynamoDBClient(common);
const lambda = new LambdaClient(common);
const sqs = new SQSClient(common);
const key = { PK: { S: "WS#northstar-product" }, SK: { S: `OUTBOX#${eventId}` } };
let outbox = await ddb.send(new GetItemCommand({ TableName: deployment.applicationTableName, Key: key, ConsistentRead: true }));
if (!outbox.Item || unmarshall(outbox.Item).deliveryState !== "PENDING") throw new Error("The exact outbox item is absent or is not pending");
const invoked = await lambda.send(new InvokeCommand({
  FunctionName: deployment.publisherFunctionName,
  Payload: Buffer.from(JSON.stringify({ operatorReplay: { eventId } })),
}));
if (invoked.FunctionError) throw new Error(`Publisher replay failed: ${Buffer.from(invoked.Payload ?? []).toString("utf8")}`);
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  outbox = await ddb.send(new GetItemCommand({ TableName: deployment.applicationTableName, Key: key, ConsistentRead: true }));
  if (outbox.Item && unmarshall(outbox.Item).deliveryState === "PUBLISHED") break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
if (!outbox.Item || unmarshall(outbox.Item).deliveryState !== "PUBLISHED") throw new Error("Outbox did not become PUBLISHED");
const failed = await sqs.send(new ReceiveMessageCommand({ QueueUrl: deployment.streamFailureQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }));
const matching = failed.Messages?.find(message => message.Body?.includes(eventId));
if (matching?.ReceiptHandle) await sqs.send(new DeleteMessageCommand({ QueueUrl: deployment.streamFailureQueueUrl, ReceiptHandle: matching.ReceiptHandle }));
ddb.destroy(); lambda.destroy(); sqs.destroy();
console.log(`Replayed ${eventId} with its original envelope${matching ? " and removed its failure receipt" : ""}.`);
