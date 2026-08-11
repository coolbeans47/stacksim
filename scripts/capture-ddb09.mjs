import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CreateTableCommand, DynamoDBClient, PutResourcePolicyCommand } from "@aws-sdk/client-dynamodb";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-ddb09-capture-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", dynamoPolicyUpdateCooldownMs: 50 }); const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]]; let browser; let dynamodb;
try {
  await simulator.start(); dynamodb = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } }); const tableArn = "arn:aws:dynamodb:eu-west-1:000000000000:table/LearningPermissions";
  await dynamodb.send(new CreateTableCommand({ TableName: "LearningPermissions", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "recordId", AttributeType: "S" }, { AttributeName: "category", AttributeType: "S" }], KeySchema: [{ AttributeName: "recordId", KeyType: "HASH" }], GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }] }));
  const document = JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "AllowLearningRoleRead", Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:role/learning-reader" }, Action: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan"], Resource: [tableArn, `${tableArn}/index/*`], Condition: { StringEquals: { "aws:RequestedRegion": "eu-west-1" } } }] });
  browser = await chromium.launch({ channel: "chrome", headless: true }); const route = `http://127.0.0.1:${simulator.port}/_stacksim/console#/dynamodb/tables/LearningPermissions/permissions`;
  for (const pageSpec of [{ output: "starter" }, { output: "attached", attach: true }, { output: "delete", modal: true }]) {
    if (pageSpec.attach) { await dynamodb.send(new PutResourcePolicyCommand({ ResourceArn: tableArn, Policy: document, ExpectedRevisionId: "NO_POLICY" })); await new Promise(resolve => setTimeout(resolve, 75)); }
    const output = resolve("docs/ui-reference/2026-07-15/dynamodb/permissions", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const context = await browser.newContext({ viewport: { width, height } }); const page = await context.newPage(); await page.goto(route); await page.locator("main").waitFor(); await page.getByRole("heading", { name: "LearningPermissions", exact: true }).waitFor();
      if (pageSpec.modal) { await page.locator(".policy-editor-card").getByRole("button", { name: "Delete policy" }).click(); await page.getByRole("dialog").getByRole("heading", { name: "Confirm deletion" }).waitFor(); }
      await page.waitForTimeout(200); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await context.close();
    }
  }
} finally { dynamodb?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
