import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CreateTableCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-ddb02-capture-"));
const output = resolve("docs/ui-reference/2026-07-15/dynamodb/indexes/final");
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
let browser; let client;
try {
  await mkdir(output, { recursive: true }); await simulator.start();
  client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  await client.send(new CreateTableCommand({ TableName: "ProductCatalog", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "productId", AttributeType: "S" }, { AttributeName: "category", AttributeType: "S" }], KeySchema: [{ AttributeName: "productId", KeyType: "HASH" }], GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }] }));
  await client.send(new PutItemCommand({ TableName: "ProductCatalog", Item: { productId: { S: "book-001" }, category: { S: "Books" }, title: { S: "Distributed Systems" } } }));
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const [name, width, height] of [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console#/dynamodb/tables/ProductCatalog/indexes`); await page.locator("main").waitFor();
    await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close();
  }
} finally { client?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
