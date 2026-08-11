import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CreateTableCommand, DynamoDBClient, PutItemCommand, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-ddb08-capture-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" }); const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]]; let browser; let dynamodb;
try {
  await simulator.start(); dynamodb = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  await dynamodb.send(new CreateTableCommand({ TableName: "LearningEvents", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "eventId", AttributeType: "S" }], KeySchema: [{ AttributeName: "eventId", KeyType: "HASH" }], StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" } }));
  await dynamodb.send(new PutItemCommand({ TableName: "LearningEvents", Item: { eventId: { S: "event-001" }, status: { S: "received" }, source: { S: "learning-lab" } } }));
  browser = await chromium.launch({ channel: "chrome", headless: true }); const route = `http://127.0.0.1:${simulator.port}/_stacksim/console#/dynamodb/tables/LearningEvents/streams`;
  for (const pageSpec of [{ output: "details" }, { output: "configuration", modal: true }, { output: "disabled", disabled: true }]) {
    if (pageSpec.disabled) { await dynamodb.send(new UpdateTableCommand({ TableName: "LearningEvents", StreamSpecification: { StreamEnabled: false } })); await new Promise(resolve => setTimeout(resolve, 100)); }
    const output = resolve("docs/ui-reference/2026-07-15/dynamodb/streams", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const context = await browser.newContext({ viewport: { width, height } }); const page = await context.newPage(); await page.goto(route); await page.locator("main").waitFor(); await page.getByRole("heading", { name: "LearningEvents", exact: true }).waitFor();
      if (pageSpec.modal) { await page.locator(".stream-card").getByRole("button", { name: "Manage stream" }).click(); await page.getByRole("dialog").getByRole("heading", { name: "Manage DynamoDB stream" }).waitFor(); }
      await page.waitForTimeout(200); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await context.close();
    }
  }
} finally { dynamodb?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
