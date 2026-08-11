import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CreateBackupCommand, CreateTableCommand, DynamoDBClient, PutItemCommand, UpdateContinuousBackupsCommand } from "@aws-sdk/client-dynamodb";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-ddb07-capture-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" }); const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]]; let browser; let dynamodb;
try {
  await simulator.start(); dynamodb = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  await dynamodb.send(new CreateTableCommand({ TableName: "LearningLedger", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "entryId", AttributeType: "S" }], KeySchema: [{ AttributeName: "entryId", KeyType: "HASH" }], TableClass: "STANDARD_INFREQUENT_ACCESS", Tags: [{ Key: "environment", Value: "learning" }, { Key: "owner", Value: "finance-lab" }] }));
  for (let index = 1; index <= 6; index += 1) await dynamodb.send(new PutItemCommand({ TableName: "LearningLedger", Item: { entryId: { S: `entry-${index}` }, description: { S: `Learning ledger entry ${index}` }, amount: { N: String(index * 125) } } }));
  await dynamodb.send(new UpdateContinuousBackupsCommand({ TableName: "LearningLedger", PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 14 } })); await dynamodb.send(new CreateBackupCommand({ TableName: "LearningLedger", BackupName: "learning-ledger-before-reconciliation" })); await new Promise(resolve => setTimeout(resolve, 100));
  await dynamodb.send(new PutItemCommand({ TableName: "LearningLedger", Item: { entryId: { S: "entry-7" }, description: { S: "Post-backup reconciliation" }, amount: { N: "975" } } }));
  const pages = [{ route: "#/dynamodb/backups", output: "inventory", heading: "Backups" }, { route: "#/dynamodb/tables/LearningLedger/backups", output: "table", heading: "LearningLedger" }, { route: "#/dynamodb/tables/LearningLedger/backups", output: "restore", heading: "LearningLedger", modal: true }]; browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-15/dynamodb/backups", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const context = await browser.newContext({ viewport: { width, height } }); const page = await context.newPage(); await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console${pageSpec.route}`); await page.locator("main").waitFor(); await page.getByRole("heading", { name: pageSpec.heading, exact: true }).waitFor();
      if (pageSpec.modal) { await page.locator(".pitr-card").getByRole("button", { name: "Restore", exact: true }).click(); await page.getByRole("dialog").getByRole("heading", { name: "Restore table to a point in time" }).waitFor(); }
      await page.waitForTimeout(200); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await context.close();
    }
  }
} finally { dynamodb?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
