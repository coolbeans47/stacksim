import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CreateTableCommand, DynamoDBClient, PutItemCommand, UpdateTimeToLiveCommand } from "@aws-sdk/client-dynamodb";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-ddb04-capture-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", dynamoTtlSchedule: { sweepEveryMs: 20, transitionMs: 10, updateCooldownMs: 20 } }); const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]]; let browser; let dynamodb;
try {
  await simulator.start(); dynamodb = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  const definition = TableName => ({ TableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "orderId", AttributeType: "S" }], KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }] });
  await dynamodb.send(new CreateTableCommand(definition("LearningOrders"))); await dynamodb.send(new CreateTableCommand(definition("ArchivedOrders")));
  await dynamodb.send(new UpdateTimeToLiveCommand({ TableName: "LearningOrders", TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" } })); await new Promise(resolveDelay => setTimeout(resolveDelay, 35)); await simulator.dynamodb.sweepTtlNow();
  const now = Math.floor(Date.now() / 1000); await dynamodb.send(new PutItemCommand({ TableName: "LearningOrders", Item: { orderId: { S: "order-1042" }, expiresAt: { N: String(now + 86_400) }, status: { S: "OPEN" } } })); await dynamodb.send(new PutItemCommand({ TableName: "LearningOrders", Item: { orderId: { S: "order-1043" }, status: { S: "PERMANENT" } } }));
  const pages = [
    { route: "/dynamodb/tables/LearningOrders/settings", output: "settings" },
    { route: "/dynamodb/tables/ArchivedOrders/settings", output: "enable", prepare: async page => { await page.getByRole("button", { name: "Turn on" }).click(); await page.getByLabel("TTL attribute name").fill("archiveAfter"); } },
    { route: "/dynamodb/tables/LearningOrders/settings", output: "disable", prepare: async page => { await page.getByRole("button", { name: "Turn off" }).click(); await page.getByRole("checkbox").check(); } },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const pageSpec of pages) { const output = resolve("docs/ui-reference/2026-07-15/dynamodb/time-to-live", pageSpec.output, "final"); await mkdir(output, { recursive: true }); for (const [name, width, height] of viewports) { const page = await browser.newPage({ viewport: { width, height } }); await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console#${pageSpec.route}`); await page.locator("main").waitFor(); await pageSpec.prepare?.(page); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close(); } }
} finally { dynamodb?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
