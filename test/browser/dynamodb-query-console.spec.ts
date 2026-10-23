import { expect, test, type Page } from "@playwright/test";
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

  test("explores items with AWS-style filters, projections, multi-select actions, and item editor pages", async ({ page }) => {
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
        notes: { S: `unprojected-${index}` }, title: { S: index % 2 === 0 ? `Guide ${index}` : `Reference ${index}` }, featured: { BOOL: index % 3 === 0 },
        tenant: { S: "tenant-a" }, sk: { N: String(index) }, category: { S: "guides" }, rank: { N: String(index) },
      } }))));

      const errors = browserErrors(page); const operations: string[] = []; const requests: { target: string; body: any }[] = [];
      page.on("request", request => { const target = request.headers()["x-amz-target"]; if (!target) return; operations.push(target); if (request.postData()) requests.push({ target, body: JSON.parse(request.postData()!) }); });
      const lastRequest = (operation: string) => requests.filter(entry => entry.target.endsWith(`.${operation}`)).at(-1)?.body;
      const filterRow = (index: number) => page.locator("[data-filter-row]").nth(index);
      const count = page.locator("#items-returned-count");

      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserQueryExplorer/items`);
      await expect(page.getByRole("heading", { name: "Scan or query items" })).toBeVisible();
      await expect.poll(() => operations.some(target => target.endsWith(".Scan"))).toBe(true);
      await expect(count).toHaveText("(18)");
      await expect(page.locator("#item-result-summary")).toHaveText(/^Completed\. Read capacity units consumed: [\d.]+$/);
      await expect(page.locator("#item-filters")).toHaveAttribute("open", "");
      const headers = await page.locator(".items-data-table thead th").allInnerTexts();
      expect(headers.slice(0, 3)).toEqual(["", "tenant", "sk"]);
      expect(headers.slice(3).sort()).toEqual(["category", "featured", "notes", "rank", "title"]);
      await expect(page.locator(".items-data-table .type-tag")).toHaveCount(0);
      const scanWarningInsets = await page.getByText("Scan reads every evaluated item", { exact: true }).locator("..").evaluate(element => {
        const panel = element.getBoundingClientRect(); const card = element.closest(".card")!.getBoundingClientRect();
        return { left: panel.left - card.left, right: card.right - panel.right };
      });
      expect(scanWarningInsets.left).toBeGreaterThanOrEqual(20);
      expect(scanWarningInsets.right).toBeGreaterThanOrEqual(20);

      await page.getByText("Additional settings (local)", { exact: true }).click();
      await page.getByLabel("Run a scan when this page opens").uncheck();
      operations.length = 0;
      await page.reload();
      await expect(page.getByText("No request has run", { exact: true })).toBeVisible();
      expect(operations.some(target => target.endsWith(".Scan"))).toBe(false);
      await page.getByText("Additional settings (local)", { exact: true }).click();
      await expect(page.getByLabel("Run a scan when this page opens")).not.toBeChecked();
      await page.getByLabel("Run a scan when this page opens").check();
      await expect(count).toHaveText("(18)");

      await page.locator('input[name="item-operation"][value="query"]').check();
      await page.getByLabel("Partition key", { exact: true }).fill("tenant-a");
      await page.getByLabel("Sort key condition").selectOption("BETWEEN");
      await page.getByLabel("Sort key", { exact: true }).fill("0");
      await page.getByLabel("Second sort key value").fill("17");
      await filterRow(0).getByLabel("Attribute name").fill("title");
      await filterRow(0).getByLabel("Condition").selectOption("contains");
      await filterRow(0).locator("[data-filter-value]").fill("Guide");
      await page.getByLabel("Page size (Limit)").selectOption("10");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(count).toHaveText("(5)");
      await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
      await expect(page.getByRole("cell", { name: "Guide 0" })).toBeVisible();
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.locator("#items-page-label")).toHaveText("Page 2");
      await filterRow(0).locator("[data-filter-value]").fill("Reference");
      await expect(page.locator("#items-page-label")).toHaveText("Request settings changed. Run again before paging.");
      await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();

      await page.getByRole("button", { name: "Reset" }).click();
      await page.locator('input[name="item-operation"][value="query"]').check();
      await page.getByLabel("Partition key", { exact: true }).fill("tenant-a");
      await filterRow(0).getByLabel("Attribute name").fill("title");
      await filterRow(0).getByLabel("Condition").selectOption("contains");
      await filterRow(0).locator("[data-filter-value]").fill("Guide");
      await page.getByRole("button", { name: "Add filter" }).click();
      await filterRow(1).getByLabel("Attribute name").fill("title");
      await filterRow(1).getByLabel("Condition").selectOption("not_contains");
      await filterRow(1).locator("[data-filter-value]").fill("1");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(count).toHaveText("(5)");
      expect(lastRequest("Query").FilterExpression).toMatch(/^contains\(#f0, :f0\) AND NOT contains\(#f0, :f1\)$/);
      await filterRow(1).getByRole("button", { name: "Remove" }).click();
      await filterRow(0).getByLabel("Attribute name").fill("featured");
      await filterRow(0).getByLabel("Type").selectOption("BOOL");
      expect(await filterRow(0).getByLabel("Condition").locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(["=", "<>", "exists", "not_exists"]);
      await expect(filterRow(0).locator("[data-filter-value]")).toBeHidden();
      await filterRow(0).locator("[data-filter-bool]").selectOption("true");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(count).toHaveText("(6)");
      expect(lastRequest("Query").ExpressionAttributeValues[":f0"]).toEqual({ BOOL: true });
      await filterRow(0).getByLabel("Type").selectOption("NULL");
      await expect(filterRow(0).getByText("No value needed")).toBeVisible();
      await filterRow(0).getByLabel("Condition").selectOption("<>");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(count).toHaveText("(18)");
      expect(lastRequest("Query").ExpressionAttributeValues[":f0"]).toEqual({ NULL: true });
      await filterRow(0).getByRole("button", { name: "Remove" }).click();

      await page.getByLabel("Select attribute projection").selectOption("specific");
      await page.getByLabel("Attribute names", { exact: true }).fill("title");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.locator(".items-data-table thead th")).toHaveText(["", "title"]);
      expect(lastRequest("Query").ProjectionExpression).toBe("#p0");
      await page.getByLabel("Select item 1", { exact: true }).check();
      await page.locator("#item-actions summary").click();
      await expect(page.getByRole("menuitem", { name: "Edit item" })).toBeDisabled();
      await expect(page.getByRole("menuitem", { name: "Delete items" })).toBeEnabled();
      await page.locator("#item-actions summary").click();

      await page.getByRole("button", { name: "Reset" }).click();
      await page.getByLabel("Select a table or index").selectOption("ByCategory");
      await page.getByLabel("Select attribute projection").selectOption("projected");
      await page.locator('input[name="item-operation"][value="query"]').check();
      await page.getByLabel("Partition key", { exact: true }).fill("guides");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.locator("#items-table tbody tr")).toHaveCount(18);
      expect(lastRequest("Query").Select).toBe("ALL_PROJECTED_ATTRIBUTES");
      await expect(page.locator(".items-data-table thead th")).toHaveText(["", "tenant", "sk", "category", "rank"]);

      await page.getByLabel("Select item 1", { exact: true }).check();
      await page.locator("#item-actions summary").click();
      await page.getByRole("menuitem", { name: "Edit item" }).click();
      await expect(page.getByRole("heading", { name: "Edit item" })).toBeVisible();
      const node = (name: string) => page.locator("#attribute-rows > .attr-node").filter({ has: page.locator(`[data-attribute-name][value="${name}"]`) });
      await expect(node("notes").locator("[data-attribute-value]")).toHaveValue(/unprojected-/);
      await expect(page.getByLabel("tenant value")).toHaveAttribute("readonly", "");
      await expect(node("featured").locator("select[data-attribute-value]")).toHaveValue(/true|false/);
      await node("title").locator("[data-attribute-value]").fill("Draft synchronized edit");
      await page.getByRole("button", { name: "JSON view", exact: true }).click();
      await expect(page.getByLabel("View DynamoDB JSON")).toBeChecked();
      const dynamodbEditor = page.getByRole("textbox", { name: "DynamoDB JSON", exact: true }); const typed = JSON.parse(await dynamodbEditor.inputValue()); expect(typed.title.S).toBe("Draft synchronized edit"); typed.title.S = "Typed JSON edit"; await dynamodbEditor.fill(JSON.stringify(typed, null, 2));
      await page.getByLabel("View DynamoDB JSON").uncheck();
      const plainEditor = page.getByLabel("Plain JSON"); const plain = JSON.parse(await plainEditor.inputValue()); expect(plain.title).toBe("Typed JSON edit"); plain.title = "Safely edited"; await plainEditor.fill(JSON.stringify(plain, null, 2));
      await page.getByLabel("View DynamoDB JSON").check();
      await expect(page.getByRole("textbox", { name: "DynamoDB JSON", exact: true })).toHaveValue(/"Safely edited"/);
      await page.getByRole("button", { name: "Form", exact: true }).click();
      await expect(node("title").locator("[data-attribute-value]")).toHaveValue("Safely edited");
      await page.getByRole("button", { name: "Save and close" }).click();
      await expect(page).toHaveURL(/#\/dynamodb\/tables\/BrowserQueryExplorer\/items$/);
      await expect(page.getByLabel("Select a table or index")).toHaveValue("ByCategory");
      await expect(page.locator("#items-table tbody tr")).toHaveCount(18);
      const first = await client.send(new GetItemCommand({ TableName: "BrowserQueryExplorer", Key: { tenant: { S: "tenant-a" }, sk: { N: "0" } }, ConsistentRead: true }));
      expect(first.Item?.title?.S).toBe("Safely edited");
      expect(first.Item?.notes?.S).toBe("unprojected-0");

      await page.getByRole("link", { name: "Create item" }).click();
      await expect(page.getByRole("heading", { name: "Create item" })).toBeVisible();
      await expect(page.getByLabel("tenant value")).not.toHaveAttribute("readonly", "");
      await page.getByLabel("tenant value").fill("tenant-created"); await page.getByLabel("sk value").fill("100");
      const addTopLevel = async (type: string) => { await page.locator(".item-editor-add summary").click(); await page.locator(".item-editor-add").getByRole("menuitem", { name: type, exact: true }).click(); return page.locator("#attribute-rows > .attr-node").last(); };
      let added = await addTopLevel("String"); await added.getByLabel("Attribute name").fill("title"); await added.getByLabel("Attribute value").fill("Created in form mode");
      added = await addTopLevel("Boolean"); await added.getByLabel("Attribute name").fill("active"); await added.getByLabel("Attribute value").selectOption("true");
      added = await addTopLevel("Null"); await added.getByLabel("Attribute name").fill("archivedAt"); await expect(added.locator("[data-attribute-value]")).toHaveCount(0);
      added = await addTopLevel("String set"); await added.getByLabel("Attribute name").fill("labels"); await added.getByLabel("Set value", { exact: true }).fill("x, y"); await added.getByRole("button", { name: "Add value" }).click(); await added.getByLabel("Set value", { exact: true }).nth(1).fill("z");
      const map = await addTopLevel("Map"); await map.getByLabel("Attribute name").first().fill("meta");
      await map.locator(".attr-add-child").last().locator("summary").click(); await map.locator(".attr-add-child").last().getByRole("menuitem", { name: "List", exact: true }).click();
      const list = map.locator(".attr-children .attr-node").first(); await list.getByLabel("Attribute name").fill("tags");
      await list.locator(".attr-add-child").last().locator("summary").click(); await list.locator(".attr-add-child").last().getByRole("menuitem", { name: "Number", exact: true }).click();
      await list.getByLabel("Element 0 value").fill("7");
      await page.getByRole("button", { name: "Collapse meta" }).click();
      await expect(list).toBeHidden();
      await page.getByRole("button", { name: "Expand meta" }).click();
      await page.getByRole("button", { name: "Create item", exact: true }).click();
      await expect(page).toHaveURL(/#\/dynamodb\/tables\/BrowserQueryExplorer\/items$/);
      const created = await client.send(new GetItemCommand({ TableName: "BrowserQueryExplorer", Key: { tenant: { S: "tenant-created" }, sk: { N: "100" } }, ConsistentRead: true }));
      expect(created.Item).toMatchObject({ title: { S: "Created in form mode" }, active: { BOOL: true }, archivedAt: { NULL: true }, meta: { M: { tags: { L: [{ N: "7" }] } } } });
      expect([...(created.Item?.labels?.SS ?? [])].sort()).toEqual(["x, y", "z"]);

      await page.getByLabel("Select item 1", { exact: true }).check();
      await page.locator("#item-actions summary").click();
      await page.getByRole("menuitem", { name: "Duplicate item" }).click();
      await expect(page.getByRole("heading", { name: "Duplicate item" })).toBeVisible();
      await expect(page.getByLabel("tenant value")).toHaveValue("tenant-a");
      await expect(page.getByLabel("sk value")).toHaveValue("0");
      await page.getByLabel("sk value").fill("101");
      await page.getByRole("button", { name: "Create item", exact: true }).click();
      await expect(page).toHaveURL(/#\/dynamodb\/tables\/BrowserQueryExplorer\/items$/);
      const duplicated = await client.send(new GetItemCommand({ TableName: "BrowserQueryExplorer", Key: { tenant: { S: "tenant-a" }, sk: { N: "101" } }, ConsistentRead: true }));
      expect(duplicated.Item?.notes?.S).toBe("unprojected-0");

      await page.getByRole("button", { name: "Reset" }).click();
      await page.locator('input[name="item-operation"][value="query"]').check();
      await page.getByLabel("Partition key", { exact: true }).fill("tenant-a");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(count).toHaveText("(19)");
      await page.getByRole("button", { name: "Edit title of item 1", exact: true }).click();
      const inlineDialog = page.getByRole("dialog");
      await expect(inlineDialog.getByRole("heading", { name: "Edit String" })).toBeVisible();
      await inlineDialog.getByLabel("title").fill("Inline edit");
      await inlineDialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("cell", { name: "Inline edit" })).toBeVisible();
      expect(lastRequest("UpdateItem")).toMatchObject({ UpdateExpression: "SET #attribute = :value", ExpressionAttributeValues: { ":value": { S: "Inline edit" } } });

      await page.getByLabel("Select all items").check();
      await page.locator("#item-actions summary").click();
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Export to CSV" }).click()]);
      expect(download.suggestedFilename()).toBe("BrowserQueryExplorer-items.csv");
      const csv = await readFile(await download.path(), "utf8");
      expect(csv.split("\r\n")[0]).toMatch(/^tenant,sk,/);
      expect(csv).toContain("Inline edit");
      await page.getByLabel("Select all items").uncheck();

      await page.getByLabel("Select item 2", { exact: true }).check(); await page.getByLabel("Select item 3", { exact: true }).check();
      await page.locator("#item-actions summary").click();
      await page.getByRole("menuitem", { name: "Delete items" }).click();
      const deleteDialog = page.getByRole("dialog");
      await expect(deleteDialog.getByRole("heading", { name: "Delete items" })).toBeVisible();
      await expect(deleteDialog.locator('input[name="confirmation"]')).toHaveCount(0);
      await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(count).toHaveText("(17)");
      await expect(page.locator('input[name="item-operation"][value="query"]')).toBeChecked();
      await expect(page.getByLabel("Partition key", { exact: true })).toHaveValue("tenant-a");
      expect(requests.filter(entry => entry.target.endsWith(".DeleteItem"))).toHaveLength(2);

      const itemWrites = requests.filter(entry => entry.target.endsWith(".PutItem")).map(entry => entry.body);
      expect(itemWrites).toHaveLength(3);
      expect(itemWrites[0].ConditionExpression).toBeUndefined();
      expect(itemWrites.slice(1).every(write => write.ConditionExpression === "attribute_not_exists(#primaryKey)" && write.ExpressionAttributeNames?.["#primaryKey"] === "tenant")).toBe(true);

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Add filter" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByLabel("Select item 1", { exact: true }).check();
      await page.locator("#item-actions summary").click();
      await page.getByRole("menuitem", { name: "Edit item" }).click();
      await expect(page.getByRole("heading", { name: "Edit item" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
      const tableMenu = page.locator('.partiql-table-menu summary[aria-label="Actions for BrowserPartiqlSearch"]');
      await tableMenu.click(); await page.getByRole("menuitem", { name: "Scan table" }).click();
      await expect(page.getByLabel("PartiQL statement")).toHaveValue('SELECT * FROM "BrowserPartiqlSearch"');
      await tableMenu.click(); await page.getByRole("menuitem", { name: "Query table" }).click();
      await expect(page.getByLabel("PartiQL statement")).toHaveValue(`SELECT * FROM "BrowserPartiqlSearch" WHERE "id" = 'partitionKeyValue'`);
      await tableMenu.click(); await page.getByRole("menuitem", { name: "Delete item" }).click();
      await expect(page.getByLabel("PartiQL statement")).toHaveValue(`DELETE FROM "BrowserPartiqlSearch" WHERE "id" = 'partitionKeyValue'`);
      await page.getByText("Key query builder (local)", { exact: true }).click();
      await page.locator("#partiql-builder-pk").fill("one");
      await page.getByRole("button", { name: "Build efficient query" }).click();
      await expect(page.getByLabel("PartiQL statement")).toHaveValue(/WHERE "id"=\?/);
      await expect(page.getByLabel(/Parameters \(DynamoDB JSON\)/)).toHaveValue('[{"S":"one"}]');
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.locator("#partiql-result")).toContainText("Access path (local estimate): GetItem");
      await expect(page.getByRole("cell", { name: "PartiQL guide" })).toBeVisible();
      const [partiqlDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download results to CSV" }).click()]);
      expect(partiqlDownload.suggestedFilename()).toBe("partiql-results.csv"); expect(await readFile(await partiqlDownload.path(), "utf8")).toContain("PartiQL guide");

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
      await form.getByRole("radio", { name: /Customize settings/ }).check();
      await form.getByRole("button", { name: "Create global index" }).click(); let rows = form.locator(".secondary-index-row"); let row = rows.nth(0);
      await row.getByLabel("Index name").fill("ByStatus"); await row.getByLabel("Partition key", { exact: true }).fill("status"); await row.getByLabel(/Sort key/).fill("createdAt"); await row.getByLabel("Data type").nth(1).selectOption("N"); await row.getByLabel("Attribute projections").selectOption("INCLUDE"); await row.getByLabel("Non-key attributes").fill("title, owner");
      await form.getByRole("button", { name: "Create local index" }).click(); rows = form.locator(".secondary-index-row"); row = rows.nth(1);
      await row.getByLabel("Index name").fill("ByUpdated"); await expect(row.getByLabel("Index type")).toHaveValue("LSI"); await row.getByLabel(/Sort key/).fill("updatedAt"); await row.getByLabel("Data type").nth(1).selectOption("N"); await row.getByLabel("Attribute projections").selectOption("KEYS_ONLY");
      await form.getByRole("button", { name: "Create table", exact: true }).click();
      await expect(page).toHaveURL(/#\/dynamodb\/tables\/BrowserAdminIndexes\/overview$/);
      let described = await client.send(new DescribeTableCommand({ TableName: "BrowserAdminIndexes" }));
      expect(described.Table?.GlobalSecondaryIndexes?.[0]).toMatchObject({ IndexName: "ByStatus", KeySchema: [{ AttributeName: "status", KeyType: "HASH" }, { AttributeName: "createdAt", KeyType: "RANGE" }], Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["title", "owner"] } });
      expect(described.Table?.LocalSecondaryIndexes?.[0]).toMatchObject({ IndexName: "ByUpdated", KeySchema: [{ AttributeName: "tenant", KeyType: "HASH" }, { AttributeName: "updatedAt", KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" } });

      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserAdminIndexes/indexes`);
      await expect(page.getByRole("columnheader", { name: "Attribute projections" }).first()).toBeVisible(); await expect(page.locator("#global-indexes-card").getByRole("cell", { name: "Include: title, owner" })).toBeVisible(); await expect(page.locator("#local-indexes-card").getByRole("cell", { name: "ByUpdated" })).toBeVisible();
      await page.getByRole("link", { name: "Create index" }).click(); await expect(page.getByRole("heading", { name: "Create global secondary index" })).toBeVisible();
      const indexForm = page.locator("#create-index-form"); await indexForm.getByLabel("Partition key", { exact: true }).fill("owner"); await indexForm.getByLabel(/^Sort key/).fill("score"); await expect(indexForm.getByLabel("Index name")).toHaveValue("owner-score-index"); await indexForm.getByLabel("Index name").fill("ByOwner"); await indexForm.getByLabel("Data type").nth(1).selectOption("N"); await indexForm.getByRole("radio", { name: /Include/ }).check(); await indexForm.getByLabel("Projected attributes").fill("title, status"); await indexForm.getByRole("button", { name: "Create index" }).click();
      await expect(page).toHaveURL(/#\/dynamodb\/tables\/BrowserAdminIndexes\/indexes$/);
      await expect.poll(async () => (await client.send(new DescribeTableCommand({ TableName: "BrowserAdminIndexes" }))).Table?.GlobalSecondaryIndexes?.some(index => index.IndexName === "ByOwner")).toBe(true);
      described = await client.send(new DescribeTableCommand({ TableName: "BrowserAdminIndexes" })); expect(described.Table?.GlobalSecondaryIndexes?.find(index => index.IndexName === "ByOwner")).toMatchObject({ KeySchema: [{ AttributeName: "owner", KeyType: "HASH" }, { AttributeName: "score", KeyType: "RANGE" }], Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["title", "status"] } });
      expect(errors).toEqual([]);
    } finally { client.destroy(); }
  });

  test("shows one Monitor graph per DynamoDB metric for table and GSI scopes", async ({ page }) => {
    const client = new DynamoDBClient(sdkOptions());
    try {
      await client.send(new CreateTableCommand({ TableName: "BrowserMonitor", BillingMode: "PROVISIONED", ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }, AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "category", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], GlobalSecondaryIndexes: [{ IndexName: "ByCategory", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" }, ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 } }] }));
      await waitForTableActive(client, "BrowserMonitor");
      const errors = browserErrors(page); const metricRequests: any[] = [];
      page.on("request", request => { if (request.headers()["x-amz-target"]?.endsWith(".GetMetricData")) metricRequests.push(request.postDataJSON()); });
      await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserMonitor/monitor`);
      await expect.poll(() => metricRequests.length).toBeGreaterThan(0);
      await expect(page.locator("[data-monitor-panel]")).toHaveCount(12);
      await expect(page.getByRole("heading", { name: "Read usage (average units/second)" })).toBeVisible(); await expect(page.getByRole("heading", { name: "Conditional check failed requests (count)" })).toBeVisible();
      const first = metricRequests[0].MetricDataQueries; expect(first[0].MetricStat.Metric).toMatchObject({ MetricName: "ConsumedReadCapacityUnits", Dimensions: [{ Name: "TableName", Value: "BrowserMonitor" }] }); expect(first[0].MetricStat.Period).toBe(60);
      expect(first.some((query: any) => query.MetricStat.Metric.MetricName === "SuccessfulRequestLatency" && query.MetricStat.Metric.Dimensions.some((dimension: any) => dimension.Name === "Operation" && dimension.Value === "Query"))).toBe(true);
      await expect(page.locator("#dynamodb-alarms")).toContainText("No alarms");
      await page.getByLabel("Table or index").selectOption("ByCategory");
      await expect.poll(() => metricRequests.at(-1)?.MetricDataQueries?.length).toBe(6);
      expect(metricRequests.at(-1).MetricDataQueries[0].MetricStat.Metric.Dimensions).toEqual([{ Name: "TableName", Value: "BrowserMonitor" }, { Name: "GlobalSecondaryIndexName", Value: "ByCategory" }]);
      await page.getByRole("button", { name: "1d", exact: true }).click();
      await expect.poll(() => metricRequests.at(-1)?.MetricDataQueries?.[0]?.MetricStat?.Period).toBe(300);
      await expect(page.getByRole("button", { name: "1d", exact: true })).toHaveAttribute("aria-pressed", "true");
      await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
      await expectHelp("/dynamodb/tables/create", ["Table details", "Table settings"]);
      // Reveal the Customize sections without dirtying the form so the next navigation is not blocked by the unsaved-changes guard.
      await page.evaluate(() => { (document.querySelector("#create-customize-sections") as HTMLElement).hidden = false; }); await expect(page.getByRole("button", { name: "About Secondary indexes", exact: true })).toBeVisible();
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
      await expectHelp(`/dynamodb/tables/${table}/indexes`, ["Global secondary indexes"]);
      await expectHelp(`/dynamodb/tables/${table}/monitor`, ["Table metrics"]);
      await expectHelp(`/dynamodb/tables/${table}/capacity`, ["Read/write capacity", "Auto scaling"]);
      await expectHelp(`/dynamodb/tables/${table}/settings`, ["Table class", "Deletion protection", "Encryption", "Time to Live (TTL)"]);
      await expectHelp(`/dynamodb/tables/${table}/tags`, ["Tags"]);
      await expectHelp(`/dynamodb/tables/${table}/backups`, ["Point-in-time recovery (PITR)", "Backups"]);
      await expectHelp(`/dynamodb/tables/${table}/streams`, ["DynamoDB stream details", "Amazon Kinesis data stream details", "Lambda triggers", "Exports to S3"]);
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
