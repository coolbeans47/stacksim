import { expect, test, type Page } from "@playwright/test";
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";
import { waitForTableActive } from "../support/dynamodb.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;

const sdkOptions = () => ({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });

function browserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  page.on("response", response => { if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`); });
  return errors;
}

test.describe("DynamoDB query and search console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-ddb-query-browser-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off"});
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
  });

  test.afterEach(async () => {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("explores bounded pages with key and contains filters and safely edits projected index rows", async ({ page }) => {
    const client = new DynamoDBClient(sdkOptions());
    try {
      await client.send(new CreateTableCommand({
        TableName: "BrowserQueryExplorer", BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "tenant", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "N" }, { AttributeName: "category", AttributeType: "S" }, { AttributeName: "rank", AttributeType: "N" }],
        KeySchema: [{ AttributeName: "tenant", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
        GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }, { AttributeName: "rank", KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" } }],
      }));
      await waitForTableActive(client, "BrowserQueryExplorer");
      await Promise.all(Array.from({ length: 18 }, (_, index) => client.send(new PutItemCommand({ TableName: "BrowserQueryExplorer", Item: {
        tenant: { S: "tenant-a" }, sk: { N: String(index) }, category: { S: "guides" }, rank: { N: String(index) }, title: { S: index % 2 === 0 ? `Guide ${index}` : `Reference ${index}` }, notes: { S: `unprojected-${index}` },
      } }))));

      const errors = browserErrors(page); const operations: string[] = []; const itemWrites: any[] = [];
      page.on("request", request => { const target = request.headers()["x-amz-target"]; if (target) operations.push(target); if (target?.endsWith(".PutItem") && request.postData()) itemWrites.push(JSON.parse(request.postData()!)); });
      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserQueryExplorer/items`);
      await expect(page.getByLabel("Autopreview")).toBeChecked();
      await expect.poll(() => operations.some(target => target.endsWith(".Scan"))).toBe(true);
      await expect(page.locator("#item-result-summary")).toContainText("18 matched");
      const scanWarningInsets = await page.getByText("Scan reads every evaluated item", { exact: true }).locator("..").evaluate(element => {
        const panel = element.getBoundingClientRect(); const card = element.closest(".card")!.getBoundingClientRect();
        return { left: panel.left - card.left, right: card.right - panel.right };
      });
      expect(scanWarningInsets.left).toBeGreaterThanOrEqual(20);
      expect(scanWarningInsets.right).toBeGreaterThanOrEqual(20);

      const firstValueLink = page.locator("#items-table tbody tr").first().locator("td").nth(1).getByRole("link");
      await expect(firstValueLink).toBeVisible();
      await firstValueLink.click();
      const viewDialog = page.getByRole("dialog");
      await expect(viewDialog).toContainText("View item");
      await expect(viewDialog).toContainText("unprojected-");
      const plainTab = viewDialog.getByRole("tab", { name: "Plain JSON" });
      const dynamodbTab = viewDialog.getByRole("tab", { name: "DynamoDB JSON" });
      await expect(plainTab).toHaveAttribute("aria-selected", "true");
      await expect(viewDialog.getByRole("tabpanel", { name: "Plain JSON" })).toBeVisible();
      await expect(viewDialog.locator("#item-view-dynamodb")).toBeHidden();
      await dynamodbTab.click();
      await expect(dynamodbTab).toHaveAttribute("aria-selected", "true");
      await expect(plainTab).toHaveAttribute("aria-selected", "false");
      await expect(viewDialog.getByRole("tabpanel", { name: "DynamoDB JSON" })).toBeVisible();
      await expect(viewDialog.locator("#item-view-plain")).toBeHidden();
      await expect.poll(() => operations.some(target => target.endsWith(".GetItem"))).toBe(true);
      await viewDialog.getByRole("button", { name: "Close", exact: true }).first().click();
      await expect(viewDialog).not.toBeVisible();

      await page.getByLabel("Autopreview").uncheck();
      operations.length = 0;
      await page.reload();
      await expect(page.getByText("Ready to explore", { exact: true })).toBeVisible();
      expect(operations.some(target => target.endsWith(".Scan"))).toBe(false);
      await expect(page.getByLabel("Autopreview")).not.toBeChecked();
      await page.getByLabel("Autopreview").check();
      await expect.poll(() => operations.some(target => target.endsWith(".Scan"))).toBe(true);
      await expect(page.locator("#item-result-summary")).toContainText("18 matched");

      await page.getByLabel("Operation").selectOption("query");
      await page.getByLabel(/Partition key value/).fill("tenant-a");
      await page.getByLabel(/Sort key condition/).selectOption("BETWEEN");
      await page.getByLabel(/Sort key value/).fill("0");
      await page.getByLabel("Second sort key value").fill("17");
      await page.getByText("Filters and additional settings", { exact: true }).click();
      await page.locator("#item-filter-name").fill("title");
      await page.locator("#item-filter-operator").selectOption("contains");
      await page.locator("#item-filter-value").fill("Guide");
      await page.getByLabel("Page size").selectOption("10");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.locator("#item-result-summary")).toContainText("5 matched");
      await expect(page.locator("#item-result-summary")).toContainText("10 evaluated");
      await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
      await expect(page.getByRole("cell", { name: "Guide 0" })).toBeVisible();
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.locator("#item-result-summary")).toContainText("Page 2");
      await page.locator("#item-filter-value").fill("Reference");
      await expect(page.locator("#item-result-summary")).toContainText("Run again before paging");
      await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();

      await page.getByRole("button", { name: "Reset" }).click();
      await page.getByLabel("Table or index").selectOption("ByCategory");
      await page.getByLabel("Operation").selectOption("query");
      await page.getByLabel(/Partition key value/).fill("guides");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.locator("#items-table tbody tr")).toHaveCount(18);
      await page.locator('[data-item-action="edit"]').first().click();
      const dialog = page.getByRole("dialog");
      const notesRow = dialog.locator('[data-attribute-name][value="notes"]').locator('xpath=ancestor::*[contains(@class,"attribute-row")]');
      await expect(notesRow.locator("[data-attribute-value]")).toHaveValue(/unprojected-/);
      const titleRow = dialog.locator('[data-attribute-name][value="title"]').locator('xpath=ancestor::*[contains(@class,"attribute-row")]');
      await titleRow.locator("[data-attribute-value]").fill("Draft synchronized edit");
      await dialog.getByRole("button", { name: "JSON view", exact: true }).click();
      await expect(dialog.getByLabel("View DynamoDB JSON")).toBeChecked();
      const dynamodbEditor = dialog.getByRole("textbox", { name: "DynamoDB JSON", exact: true }); const typed = JSON.parse(await dynamodbEditor.inputValue()); expect(typed.title.S).toBe("Draft synchronized edit"); typed.title.S = "Typed JSON edit"; await dynamodbEditor.fill(JSON.stringify(typed, null, 2));
      await dialog.getByLabel("View DynamoDB JSON").uncheck();
      const plainEditor = dialog.getByLabel("Plain JSON"); const plain = JSON.parse(await plainEditor.inputValue()); expect(plain.title).toBe("Typed JSON edit"); plain.title = "Safely edited"; await plainEditor.fill(JSON.stringify(plain, null, 2));
      await dialog.getByLabel("View DynamoDB JSON").check();
      await expect(dialog.getByRole("textbox", { name: "DynamoDB JSON", exact: true })).toHaveValue(/"Safely edited"/);
      await dialog.getByRole("button", { name: "Form", exact: true }).click();
      await expect(dialog.locator('[data-attribute-name][value="title"]').locator('xpath=ancestor::*[contains(@class,"attribute-row")]').locator("[data-attribute-value]")).toHaveValue("Safely edited");
      await dialog.getByRole("button", { name: "Save changes" }).click();
      const first = await client.send(new GetItemCommand({ TableName: "BrowserQueryExplorer", Key: { tenant: { S: "tenant-a" }, sk: { N: "0" } }, ConsistentRead: true }));
      expect(first.Item?.title?.S).toBe("Safely edited");
      expect(first.Item?.notes?.S).toBe("unprojected-0");

      await page.locator('[data-action="create-item"]').first().click();
      const createDialog = page.getByRole("dialog");
      const createTenant = createDialog.locator('[data-attribute-name][value="tenant"]').locator('xpath=ancestor::*[contains(@class,"attribute-row")]').locator("[data-attribute-value]");
      const createSort = createDialog.locator('[data-attribute-name][value="sk"]').locator('xpath=ancestor::*[contains(@class,"attribute-row")]').locator("[data-attribute-value]");
      await expect(createTenant).not.toHaveAttribute("readonly", "");
      await expect(createSort).not.toHaveAttribute("readonly", "");
      await createTenant.fill("tenant-created"); await createSort.fill("100");
      const newAttribute = createDialog.locator('[data-attribute-name][value=""]').locator('xpath=ancestor::*[contains(@class,"attribute-row")]');
      await newAttribute.locator("[data-attribute-name]").fill("title"); await newAttribute.locator("[data-attribute-value]").fill("Created in form mode");
      await createDialog.getByRole("button", { name: "Create item", exact: true }).click();
      await expect(createDialog).not.toBeVisible();
      const created = await client.send(new GetItemCommand({ TableName: "BrowserQueryExplorer", Key: { tenant: { S: "tenant-created" }, sk: { N: "100" } }, ConsistentRead: true }));
      expect(created.Item?.title?.S).toBe("Created in form mode");

      await page.locator('[data-item-action="duplicate"]').first().click();
      const duplicateDialog = page.getByRole("dialog");
      const duplicateTenant = duplicateDialog.locator('[data-attribute-name][value="tenant"]').locator('xpath=ancestor::*[contains(@class,"attribute-row")]').locator("[data-attribute-value]");
      const duplicateSort = duplicateDialog.locator('[data-attribute-name][value="sk"]').locator('xpath=ancestor::*[contains(@class,"attribute-row")]').locator("[data-attribute-value]");
      await expect(duplicateTenant).not.toHaveAttribute("readonly", "");
      await duplicateTenant.fill("tenant-duplicate"); await duplicateSort.fill("101");
      await duplicateDialog.getByRole("button", { name: "Create item", exact: true }).click();
      await expect(duplicateDialog).not.toBeVisible();
      const duplicated = await client.send(new GetItemCommand({ TableName: "BrowserQueryExplorer", Key: { tenant: { S: "tenant-duplicate" }, sk: { N: "101" } }, ConsistentRead: true }));
      expect(duplicated.Item?.notes?.S).toMatch(/^unprojected-/);
      expect(itemWrites).toHaveLength(3);
      expect(itemWrites[0].ConditionExpression).toBeUndefined();
      expect(itemWrites.slice(1).every(write => write.ConditionExpression === "attribute_not_exists(#primaryKey)" && write.ExpressionAttributeNames?.["#primaryKey"] === "tenant")).toBe(true);
      expect(errors).toEqual([]);
    } finally { client.destroy(); }
  });

  test("builds efficient PartiQL, runs contains and batch requests, saves operations, and finds resources globally", async ({ page }) => {
    const client = new DynamoDBClient(sdkOptions());
    try {
      await client.send(new CreateTableCommand({ TableName: "BrowserPartiqlSearch", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
      await waitForTableActive(client, "BrowserPartiqlSearch");
      await client.send(new PutItemCommand({ TableName: "BrowserPartiqlSearch", Item: { id: { S: "one" }, title: { S: "PartiQL guide" } } }));
      await client.send(new PutItemCommand({ TableName: "BrowserPartiqlSearch", Item: { id: { S: "two" }, title: { S: "Reference" } } }));
      await Promise.all(Array.from({ length: 11 }, (_, index) => client.send(new PutItemCommand({ TableName: "BrowserPartiqlSearch", Item: { id: { S: `guide-${index}` }, title: { S: `PartiQL guide ${index}` }, exactNumber: { N: index === 0 ? "12345678901234567890123456789012345678" : String(index) } } }))));
      const errors = browserErrors(page);

      await page.goto(`${consoleUrl}#/dynamodb/partiql`);
      await page.getByText("Query table", { exact: true }).click();
      await page.locator("#partiql-builder-pk").fill("one");
      await page.getByRole("button", { name: "Build efficient query" }).click();
      await expect(page.getByLabel("PartiQL statement")).toHaveValue(/WHERE "id"=\?/);
      await expect(page.getByLabel(/Parameters \(DynamoDB JSON\)/)).toHaveValue('[{"S":"one"}]');
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.locator("#partiql-result")).toContainText("Access path: GetItem");
      await expect(page.getByRole("cell", { name: "PartiQL guide" })).toBeVisible();

      await page.getByLabel("PartiQL statement").fill('SELECT * FROM "BrowserPartiqlSearch" WHERE contains("title", ?)');
      await page.getByLabel(/Parameters \(DynamoDB JSON\)/).fill('[{"S":"guide"}]');
      await page.getByLabel("Page size").selectOption("10");
      await expect(page.locator("#partiql-scan-warning")).toBeVisible();
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.locator("#partiql-result")).toContainText("PartiQL guide 0");
      await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
      await page.getByLabel("Results view").selectOption("plain");
      await expect(page.locator("#partiql-result")).toContainText("12345678901234567890123456789012345678");
      await page.getByLabel("Page size").selectOption("25");
      await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
      await expect(page.locator("#partiql-result")).toContainText("Request settings changed. Run again before paging.");

      await page.getByRole("button", { name: "Save operation" }).click();
      const dialog = page.getByRole("dialog"); await dialog.getByLabel("Operation name").fill("Find guides with contains"); await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByLabel("Search history and saved operations").fill("contains");
      await expect(page.locator("#partiql-history-list")).toContainText("Find guides with contains");

      await page.getByLabel("Execution mode").selectOption("batch");
      await expect(page.locator("[data-partiql-card]")).toHaveCount(1);
      await page.getByRole("button", { name: "Add statement" }).click(); await expect(page.locator("[data-partiql-card]")).toHaveCount(2);
      await page.locator("[data-partiql-card]").nth(1).getByRole("button", { name: "Remove" }).click(); await expect(page.locator("[data-partiql-card]")).toHaveCount(1);
      await page.getByLabel(/Statements request \(JSON\)/).fill(JSON.stringify([
        { Statement: 'SELECT * FROM "BrowserPartiqlSearch" WHERE id=?', Parameters: [{ S: "one" }] },
        { Statement: 'SELECT * FROM "BrowserPartiqlSearch" WHERE id=?', Parameters: [{ S: "two" }] },
      ]));
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.locator("#partiql-result")).toContainText('"one"');
      await expect(page.locator("#partiql-result")).toContainText('"two"');

      const transactionRequests: any[] = [];
      page.on("request", request => { if (request.headers()["x-amz-target"]?.endsWith(".ExecuteTransaction")) transactionRequests.push(request.postDataJSON()); });
      await page.getByLabel("Execution mode").selectOption("transaction");
      await page.getByLabel("Return consumed capacity").selectOption("INDEXES");
      await page.getByLabel("Client request token").fill("browser-partiql-transaction");
      await page.getByLabel(/Statements request \(JSON\)/).fill(JSON.stringify([
        { Statement: 'SELECT * FROM "BrowserPartiqlSearch" WHERE id=?', Parameters: [{ S: "one" }] },
        { Statement: 'SELECT * FROM "BrowserPartiqlSearch" WHERE id=?', Parameters: [{ S: "two" }] },
      ]));
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect.poll(() => transactionRequests.length).toBe(1);
      expect(transactionRequests[0].TransactStatements).toHaveLength(2); expect(transactionRequests[0].ReturnConsumedCapacity).toBe("INDEXES"); expect(transactionRequests[0].ClientRequestToken).toBe("browser-partiql-transaction");
      const storedHistory = await page.evaluate(() => localStorage.getItem("stacksim:dynamodb:partiql-history"));
      expect(storedHistory).not.toContain('"guide"'); expect(storedHistory).toContain("ParameterCount");
      await page.getByRole("button", { name: /Generate.*code/ }).click();
      await expect(page.getByRole("dialog")).toContainText("ExecuteTransactionCommand"); await expect(page.getByRole("dialog")).toContainText('region: "eu-west-1"'); await page.getByRole("dialog").locator("#modal-submit").click();

      const search = page.getByLabel("Search services and resources");
      await search.fill("BrowserPartiqlSearch");
      const resource = page.locator('#global-search-results a[href="#/dynamodb/tables/BrowserPartiqlSearch/overview"]');
      await expect(resource).toBeVisible(); await expect(resource).toContainText("Resource");
      await resource.click();
      await expect(page).toHaveURL(/#\/dynamodb\/tables\/BrowserPartiqlSearch\/overview$/);
      await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${consoleUrl}#/dynamodb/partiql`); await page.getByLabel("Execution mode").selectOption("transaction");
      await expect(page.getByRole("button", { name: "Add statement" })).toBeVisible(); await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally { client.destroy(); }
  });

  test("collects every ListTables page for table inventory and global resource search", async ({ page }) => {
    const client = new DynamoDBClient(sdkOptions());
    try {
      for (const TableName of ["PagedTableOne", "PagedTableTwo"]) {
        await client.send(new CreateTableCommand({ TableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
        await waitForTableActive(client, TableName);
      }
      const errors = browserErrors(page); const listRequests: any[] = [];
      await page.route("**/*", async route => {
        const request = route.request();
        if (!request.headers()["x-amz-target"]?.endsWith(".ListTables")) { await route.continue(); return; }
        const input = request.postDataJSON() ?? {}; listRequests.push(input);
        const output = input.ExclusiveStartTableName ? { TableNames: ["PagedTableTwo"] } : { TableNames: ["PagedTableOne"], LastEvaluatedTableName: "PagedTableOne" };
        await route.fulfill({ status: 200, contentType: "application/x-amz-json-1.0", body: JSON.stringify(output) });
      });
      await page.goto(`${consoleUrl}#/dynamodb/tables`);
      await expect(page.getByRole("link", { name: "PagedTableOne" })).toBeVisible();
      await expect(page.getByRole("link", { name: "PagedTableTwo" })).toBeVisible();
      const search = page.getByLabel("Search services and resources"); await search.fill("PagedTableTwo");
      await expect(page.locator('#global-search-results a[href="#/dynamodb/tables/PagedTableTwo/overview"]')).toBeVisible();
      expect(listRequests.some(input => input.ExclusiveStartTableName === "PagedTableOne")).toBe(true);
      expect(errors).toEqual([]);
    } finally { client.destroy(); }
  });

  test("creates multiple projected indexes and adds a composite GSI from the console", async ({ page }) => {
    const client = new DynamoDBClient(sdkOptions());
    try {
      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/dynamodb/tables`);
      await page.getByRole("link", { name: "Create table" }).first().click();
      const form = page.locator("#create-table-form");
      await form.getByLabel("Table name").fill("BrowserAdminIndexes"); await form.getByLabel("Partition key", { exact: true }).fill("tenant"); await form.getByLabel("Sort key", { exact: true }).fill("itemId");
      await form.getByRole("button", { name: "Add index" }).click(); let rows = form.locator(".secondary-index-row"); let row = rows.nth(0);
      await row.getByLabel("Index name").fill("ByStatus"); await row.getByLabel("Partition key name").fill("status"); await row.getByLabel(/Sort key name/).fill("createdAt"); await row.getByLabel("Sort key type").selectOption("N"); await row.getByLabel("Projection").selectOption("INCLUDE"); await row.getByLabel("Non-key attributes").fill("title, owner");
      await form.getByRole("button", { name: "Add index" }).click(); rows = form.locator(".secondary-index-row"); row = rows.nth(1);
      await row.getByLabel("Index name").fill("ByUpdated"); await row.getByLabel("Index type").selectOption("LSI"); await row.getByLabel(/Sort key name/).fill("updatedAt"); await row.getByLabel("Sort key type").selectOption("N"); await row.getByLabel("Projection").selectOption("KEYS_ONLY");
      await form.getByRole("button", { name: "Create table", exact: true }).click();
      await expect(page).toHaveURL(/#\/dynamodb\/tables\/BrowserAdminIndexes\/overview$/);
      let described = await client.send(new DescribeTableCommand({ TableName: "BrowserAdminIndexes" }));
      expect(described.Table?.GlobalSecondaryIndexes?.[0]).toMatchObject({ IndexName: "ByStatus", KeySchema: [{ AttributeName: "status", KeyType: "HASH" }, { AttributeName: "createdAt", KeyType: "RANGE" }], Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["title", "owner"] } });
      expect(described.Table?.LocalSecondaryIndexes?.[0]).toMatchObject({ IndexName: "ByUpdated", KeySchema: [{ AttributeName: "tenant", KeyType: "HASH" }, { AttributeName: "updatedAt", KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" } });

      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserAdminIndexes/indexes`); await page.getByRole("button", { name: "Create index" }).click();
      const addDialog = page.getByRole("dialog"); await addDialog.getByLabel("Index name").fill("ByOwner"); await addDialog.getByLabel("Partition key name").fill("owner"); await addDialog.getByLabel("Sort key name").fill("score"); await addDialog.getByLabel("Sort key type").selectOption("N"); await addDialog.getByLabel("Projection").selectOption("INCLUDE"); await addDialog.getByLabel("Non-key attributes").fill("title, status"); await addDialog.getByRole("button", { name: "Create index" }).click();
      await expect.poll(async () => (await client.send(new DescribeTableCommand({ TableName: "BrowserAdminIndexes" }))).Table?.GlobalSecondaryIndexes?.some(index => index.IndexName === "ByOwner")).toBe(true);
      described = await client.send(new DescribeTableCommand({ TableName: "BrowserAdminIndexes" })); expect(described.Table?.GlobalSecondaryIndexes?.find(index => index.IndexName === "ByOwner")).toMatchObject({ KeySchema: [{ AttributeName: "owner", KeyType: "HASH" }, { AttributeName: "score", KeyType: "RANGE" }], Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["title", "status"] } });
      expect(errors).toEqual([]);
    } finally { client.destroy(); }
  });

  test("refetches selectable DynamoDB monitor metrics for table and GSI scopes", async ({ page }) => {
    const client = new DynamoDBClient(sdkOptions());
    try {
      await client.send(new CreateTableCommand({ TableName: "BrowserMonitor", BillingMode: "PROVISIONED", ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }, AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "category", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" }, ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 } }] }));
      await waitForTableActive(client, "BrowserMonitor");
      const errors = browserErrors(page); const metricRequests: any[] = [];
      page.on("request", request => { if (request.headers()["x-amz-target"]?.endsWith(".GetMetricData")) metricRequests.push(request.postDataJSON()); });
      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserMonitor/monitor`);
      await expect.poll(() => metricRequests.length).toBeGreaterThan(0);
      expect(metricRequests[0].MetricDataQueries).toHaveLength(2); expect(metricRequests[0].MetricDataQueries[0].MetricStat.Metric.Dimensions).toEqual([{ Name: "TableName", Value: "BrowserMonitor" }]);
      await page.getByLabel("Resource scope").selectOption("ByCategory"); await page.getByLabel("Time range").selectOption("24"); await page.getByLabel("Period").selectOption("300"); await page.getByLabel("Statistic").selectOption("Average"); await page.getByLabel("Provisioned read capacity").check();
      await expect.poll(() => metricRequests.at(-1)?.MetricDataQueries?.length).toBe(3);
      const latest = metricRequests.at(-1); expect(latest.MetricDataQueries.every((query: any) => query.MetricStat.Period === 300 && query.MetricStat.Stat === "Average")).toBe(true); expect(latest.MetricDataQueries[0].MetricStat.Metric.Dimensions).toEqual([{ Name: "TableName", Value: "BrowserMonitor" }, { Name: "GlobalSecondaryIndexName", Value: "ByCategory" }]);
      while (await page.locator("[data-dynamodb-monitor-metric]:checked").count()) await page.locator("[data-dynamodb-monitor-metric]:checked").first().uncheck();
      await expect(page.getByText("Choose at least one metric")).toBeVisible();
      expect(errors).toEqual([]);
    } finally { client.destroy(); }
  });

  test("explains DynamoDB input panels and their StackSim support", async ({ page }) => {
    const client = new DynamoDBClient(sdkOptions());
    const errors = browserErrors(page);
    const table = "BrowserPanelHelp";
    const expectHelp = async (route: string, labels: string[]) => {
      await page.goto(`${consoleUrl}#${route}`);
      for (const label of labels) await expect(page.getByRole("button", { name: `About ${label}`, exact: true })).toBeVisible();
    };
    try {
      await expectHelp("/dynamodb/tables", ["Tables"]);
      await expectHelp("/dynamodb/tables/create", ["Table details", "Table settings", "Secondary indexes"]);
      await expectHelp("/dynamodb/transactions", ["Ordered actions"]);
      await expectHelp("/dynamodb/partiql", ["Operation", "Operations"]);
      await expectHelp("/dynamodb/exports", ["Exports"]);
      await expectHelp("/dynamodb/imports", ["Imports"]);
      await expectHelp("/dynamodb/backups", ["On-demand backups"]);

      await client.send(new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      }));
      await waitForTableActive(client, table);

      await expectHelp("/dynamodb/contributor-insights", ["Contributor insights resources"]);
      await expectHelp(`/dynamodb/tables/${table}/items`, ["Scan or query items"]);
      await expectHelp(`/dynamodb/tables/${table}/indexes`, ["Secondary indexes"]);
      await expectHelp(`/dynamodb/tables/${table}/monitor`, ["Table metrics"]);
      await expectHelp(`/dynamodb/tables/${table}/capacity`, ["Read/write capacity", "Auto scaling"]);
      await expectHelp(`/dynamodb/tables/${table}/settings`, ["Table class", "Deletion protection", "Encryption at rest", "Time to Live (TTL)"]);
      await expectHelp(`/dynamodb/tables/${table}/tags`, ["Tags"]);
      await expectHelp(`/dynamodb/tables/${table}/backups`, ["Point-in-time recovery (PITR)", "On-demand backups"]);
      await expectHelp(`/dynamodb/tables/${table}/streams`, ["DynamoDB stream details", "Kinesis data stream destination", "Lambda triggers", "Point-in-time exports"]);
      await expectHelp(`/dynamodb/tables/${table}/global`, ["Global table replicas"]);
      await expectHelp(`/dynamodb/tables/${table}/contributors`, ["Contributor insights"]);
      await expectHelp(`/dynamodb/tables/${table}/permissions`, ["Resource-based policy"]);

      const policyHelpButton = page.getByRole("button", { name: "About Resource-based policy", exact: true });
      await policyHelpButton.focus();
      const policyHelp = policyHelpButton.locator("..").getByRole("tooltip");
      await expect(policyHelp).toContainText("A resource-based policy is a JSON document");
      await expect(policyHelp).toContainText("StackSim support · Supported locally");
    } finally { client.destroy(); }
    expect(errors).toEqual([]);
  });
});
