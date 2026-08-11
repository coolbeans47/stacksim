import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CreateTableCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-ddb05-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let dynamodb;

async function run(page, statement, parameters = []) {
  await page.getByLabel("PartiQL statement").fill(statement);
  await page.getByLabel("Parameters (DynamoDB JSON)").fill(JSON.stringify(parameters, null, 2));
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.locator("#partiql-result .loading").waitFor({ state: "detached" });
}

try {
  await simulator.start();
  dynamodb = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  await dynamodb.send(new CreateTableCommand({ TableName: "LearningCatalog", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
  await Promise.all(Array.from({ length: 13 }, (_, index) => dynamodb.send(new PutItemCommand({ TableName: "LearningCatalog", Item: {
    id: { S: `catalog-${String(index + 1).padStart(2, "0")}` },
    title: { S: ["Practical DynamoDB", "Serverless Patterns", "Cloud Design Notes"][index % 3] },
    status: { S: index % 3 === 0 ? "DRAFT" : "PUBLISHED" },
  } }))));
  const pages = [
    {
      output: "editor",
      prepare: async page => {
        await run(page, 'SELECT id, title, status FROM "LearningCatalog"');
        await run(page, 'SELECT id, title, status FROM "LearningCatalog" WHERE id=?', [{ S: "catalog-07" }]);
        await page.locator("#partiql-result").getByRole("cell", { name: "catalog-07" }).waitFor();
      },
    },
    {
      output: "pagination",
      prepare: async page => {
        await page.getByLabel("Page size").selectOption("10");
        await run(page, 'SELECT id, title, status FROM "LearningCatalog"');
        await page.getByLabel("Results view").selectOption("plain");
        await page.locator("#partiql-result").getByRole("button", { name: "Next" }).click();
        await page.locator("#partiql-result").getByText("Page 2").waitFor();
      },
    },
    {
      output: "error",
      prepare: async page => {
        await page.getByLabel("PartiQL statement").fill('SELECT * FROM "LearningCatalog" WHERE id=?');
        await page.getByLabel("Parameters (DynamoDB JSON)").fill("{");
        await page.getByRole("button", { name: "Run", exact: true }).click();
        await page.locator("#partiql-result").getByRole("heading", { name: "Error details" }).waitFor();
        await page.locator("#partiql-result").scrollIntoViewIfNeeded();
      },
    },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-15/dynamodb/partiql", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const context = await browser.newContext({ viewport: { width, height } }); const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console#/dynamodb/partiql`); await page.locator("main").waitFor();
      await page.evaluate(() => localStorage.removeItem("stacksim:dynamodb:partiql-history")); await page.reload(); await page.locator("main").waitFor();
      await pageSpec.prepare(page); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await context.close();
    }
  }
} finally {
  dynamodb?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
