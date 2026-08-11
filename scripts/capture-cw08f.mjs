import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CloudWatchClient, DescribeInsightRulesCommand, DisableInsightRulesCommand, PutInsightRuleCommand, PutManagedInsightRulesCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateTableCommand, DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-cw08f-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
const credentials = { accessKeyId: "admin", secretAccessKey: "password" }; let browser; let cloudwatch; let logs; let dynamodb;

try {
  await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region: "eu-west-1", credentials }; cloudwatch = new CloudWatchClient(options); logs = new CloudWatchLogsClient(options); dynamodb = new DynamoDBClient(options); const group = "/learning/orders/application"; const now = Date.now();
  await logs.send(new CreateLogGroupCommand({ logGroupName: group })); await logs.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: "orders-api" }));
  const sumDefinition = JSON.stringify({ Schema: { Name: "CloudWatchLogRule", Version: 1 }, LogGroupNames: ["/learning/orders/*"], LogFormat: "JSON", Contribution: { Keys: ["$.service"], ValueOf: "$.duration", Filters: [{ Match: "$.status", GreaterThan: 399 }] }, AggregateOn: "Sum" }, null, 2);
  const countDefinition = JSON.stringify({ Schema: { Name: "CloudWatchLogRule", Version: 1 }, LogGroupNames: [group], LogFormat: "JSON", Contribution: { Keys: ["$.route"] }, AggregateOn: "Count" }, null, 2);
  await cloudwatch.send(new PutInsightRuleCommand({ RuleName: "order-errors-by-service", RuleDefinition: sumDefinition, RuleState: "ENABLED", ApplyOnTransformedLogs: true, Tags: [{ Key: "environment", Value: "local" }, { Key: "owner", Value: "observability" }] })); await cloudwatch.send(new PutInsightRuleCommand({ RuleName: "requests-by-route", RuleDefinition: countDefinition, RuleState: "ENABLED", Tags: [{ Key: "team", Value: "orders" }] })); await cloudwatch.send(new DisableInsightRulesCommand({ RuleNames: ["requests-by-route"] }));
  await logs.send(new PutLogEventsCommand({ logGroupName: group, logStreamName: "orders-api", logEvents: [{ timestamp: now - 240_000, message: '{"service":"checkout","route":"/orders","status":500,"duration":280}' }, { timestamp: now - 180_000, message: '{"service":"checkout","route":"/orders","status":502,"duration":190}' }, { timestamp: now - 120_000, message: '{"service":"inventory","route":"/stock","status":503,"duration":340}' }, { timestamp: now - 60_000, message: '{"service":"checkout","route":"/orders","status":504,"duration":410}' }, { timestamp: now - 30_000, message: '{"service":"healthy","route":"/health","status":200,"duration":12}' }] }));
  const tableName = "LearningManagedOrders"; const resourceArn = `arn:aws:dynamodb:eu-west-1:000000000000:table/${tableName}`; await dynamodb.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "tenant", AttributeType: "S" }, { AttributeName: "orderId", AttributeType: "S" }], KeySchema: [{ AttributeName: "tenant", KeyType: "HASH" }, { AttributeName: "orderId", KeyType: "RANGE" }] })); await cloudwatch.send(new PutManagedInsightRulesCommand({ ManagedRules: [{ TemplateName: "DynamoDBContributorInsights-PKC", ResourceARN: resourceArn, Tags: [{ Key: "environment", Value: "local" }, { Key: "source", Value: "dynamodb" }] }] })); const hot = { tenant: { S: "tenant-blue" }, orderId: { S: "order-1001" } }; const warm = { tenant: { S: "tenant-green" }, orderId: { S: "order-1002" } }; await dynamodb.send(new PutItemCommand({ TableName: tableName, Item: hot })); await dynamodb.send(new GetItemCommand({ TableName: tableName, Key: hot })); await dynamodb.send(new GetItemCommand({ TableName: tableName, Key: hot })); await dynamodb.send(new PutItemCommand({ TableName: tableName, Item: warm }));
  const managedName = (await cloudwatch.send(new DescribeInsightRulesCommand({}))).InsightRules.find(rule => rule.ManagedRule).Name;
  const pages = [
    { output: "catalog", route: "#/cloudwatch/contributor-insights", wait: async page => { await page.getByRole("link", { name: "order-errors-by-service" }).waitFor(); await page.getByRole("link", { name: managedName }).waitFor(); } },
    { output: "create", route: "#/cloudwatch/contributor-insights", wait: async page => { await page.getByRole("button", { name: "Create rule" }).first().click(); await page.getByRole("dialog").getByRole("heading", { name: "Create Contributor Insights rule" }).waitFor(); } },
    { output: "detail-custom-report", route: "#/cloudwatch/contributor-insights/order-errors-by-service", wait: async page => { await page.getByText("Log transformation boundary", { exact: true }).waitFor(); await page.locator("#insight-contributors").getByText("$.service: checkout", { exact: true }).waitFor(); } },
    { output: "edit-custom", route: "#/cloudwatch/contributor-insights/order-errors-by-service", wait: async page => { await page.getByRole("button", { name: "Edit", exact: true }).click(); await page.getByRole("dialog").getByRole("heading", { name: "Edit rule order-errors-by-service" }).waitFor(); } },
    { output: "managed-discovery", route: "#/cloudwatch/contributor-insights", wait: async page => { await page.getByRole("button", { name: "Manage built-in rules" }).click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Resource ARN").fill(resourceArn); await dialog.getByRole("button", { name: "Discover templates" }).click(); await dialog.getByText("4 templates available", { exact: true }).waitFor(); } },
    { output: "detail-managed-report", route: `#/cloudwatch/contributor-insights/${encodeURIComponent(managedName)}`, wait: async page => { await page.getByText("Managed DynamoDB rule", { exact: true }).waitFor(); await page.locator("#insight-contributors").getByText("tenant: tenant-blue", { exact: true }).waitFor(); } },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-17/cloudwatch/cw08f", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const page = await browser.newPage({ viewport: { width, height } }); const diagnostics = [];
      page.on("console", message => { if (["warning", "error"].includes(message.type())) diagnostics.push(`console ${message.type()}: ${message.text()}`); }); page.on("pageerror", error => diagnostics.push(`page error: ${error.message}`)); page.on("requestfailed", request => diagnostics.push(`request failed: ${request.method()} ${request.url()}`)); page.on("response", response => { if (response.status() >= 400) diagnostics.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`); });
      await page.goto(`${endpoint}/_stacksim/console${pageSpec.route}`); await pageSpec.wait(page); await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || [...document.querySelectorAll("main")].some(element => element.scrollWidth > element.clientWidth)); if (overflow) throw new Error(`${pageSpec.output} overflows at ${width}x${height}`); if (diagnostics.length) throw new Error(`${pageSpec.output} diagnostics: ${diagnostics.join("; ")}`);
      await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close();
    }
  }
} finally { cloudwatch?.destroy(); logs?.destroy(); dynamodb?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
