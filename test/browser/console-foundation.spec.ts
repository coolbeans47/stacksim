import { expect, test, type Page } from "@playwright/test";
import { CreateApiKeyCommand, CreateRestApiCommand, CreateUsagePlanCommand, GetResourcesCommand, PutMethodCommand, APIGatewayClient } from "@aws-sdk/client-api-gateway";
import { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateTableCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { CreatePolicyCommand, CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { AddPermissionCommand, CreateFunctionCommand, LambdaClient, UpdateFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";
import { waitForTableActive } from "../support/dynamodb.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;

type ExpectedBrowserResponse = {
  status: number;
  url: RegExp;
  consoleMessage?: RegExp;
};

function browserErrors(page: Page, expectedResponses: ExpectedBrowserResponse[] = []): string[] {
  const errors: string[] = [];
  page.on("console", message => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const location = message.location();
    const expected = expectedResponses.some(item => item.consoleMessage?.test(message.text()) && item.url.test(location.url));
    if (!expected) errors.push(`${message.type()}: ${message.text()}${location.url ? ` (${location.url}:${location.lineNumber ?? 0})` : ""}`);
  });
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "unknown error";
    if (failure !== "net::ERR_ABORTED") errors.push(`requestfailed: ${request.method()} ${request.url()} (${failure})`);
  });
  page.on("response", response => {
    const expected = expectedResponses.some(item => item.status === response.status() && item.url.test(response.url()));
    if (response.status() >= 400 && !expected) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
  });
  return errors;
}

function sdkOptions(target: StackSim) {
  return {
    endpoint: `http://127.0.0.1:${target.port}`,
    region: "eu-west-1",
    credentials: { accessKeyId: "admin", secretAccessKey: "password" },
  };
}

async function createTable(target: StackSim, tableName: string, withItem = false) {
  const dynamodb = new DynamoDBClient(sdkOptions(target));
  try {
    await dynamodb.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    }));
    await waitForTableActive(dynamodb, tableName);
    if (withItem) await dynamodb.send(new PutItemCommand({ TableName: tableName, Item: { id: { S: "fixture" }, value: { S: "browser route audit" } } }));
  } finally {
    dynamodb.destroy();
  }
}

async function createBrowserRole(target: StackSim, roleName = "browser-role") {
  const role = await fetch(`http://127.0.0.1:${target.port}/_stacksim/api/iam/roles`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      RoleName: roleName, Description: "Console browser fixture",
      AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] },
    }),
  });
  if (!role.ok) throw new Error(`Unable to create IAM browser fixture (${role.status})`);
}

async function seedRouteAudit(target: StackSim) {
  const options = sdkOptions(target);
  const iam = new IAMClient(options);
  const lambda = new LambdaClient(options);
  const apigateway = new APIGatewayClient(options);
  const logs = new CloudWatchLogsClient(options);
  try {
    await createTable(target, "RouteAuditTable", true);
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
    await iam.send(new CreateRoleCommand({ RoleName: "route-audit-role", Description: "Route audit execution role", AssumeRolePolicyDocument: trust }));
    const policy = await iam.send(new CreatePolicyCommand({
      PolicyName: "RouteAuditPolicy",
      Description: "Route audit policy fixture",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "dynamodb:GetItem", Resource: "*" }] }),
    }));
    const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    await lambda.send(new CreateFunctionCommand({
      FunctionName: "route-audit-function", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/route-audit-role",
      Handler: "handler.echoHandler", Code: { ZipFile: zip }, Description: "Browser route audit fixture",
    }));
    await lambda.send(new AddPermissionCommand({ FunctionName: "route-audit-function", StatementId: "route-audit", Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com" }));
    const api = await apigateway.send(new CreateRestApiCommand({ name: "route-audit-api", description: "Browser route audit fixture" }));
    const apiKey = await apigateway.send(new CreateApiKeyCommand({ name: "route-audit-key", description: "Browser route audit fixture", enabled: true }));
    const usagePlan = await apigateway.send(new CreateUsagePlanCommand({ name: "route-audit-plan", description: "Browser route audit fixture", throttle: { rateLimit: 10, burstLimit: 5 }, quota: { limit: 100, period: "DAY" } }));
    for (const group of ["/stacksim/route-audit", "/aws/lambda/route-audit-function"]) {
      await logs.send(new CreateLogGroupCommand({ logGroupName: group }));
      await logs.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: "seed" }));
      await logs.send(new PutLogEventsCommand({ logGroupName: group, logStreamName: "seed", logEvents: [{ timestamp: Date.now(), message: "route audit fixture" }] }));
    }
    return { apiId: api.id!, apiKeyId: apiKey.id!, usagePlanId: usagePlan.id!, policyArn: policy.Policy!.Arn! };
  } finally {
    iam.destroy();
    lambda.destroy();
    apigateway.destroy();
    logs.destroy();
  }
}

test.describe("FND-02 console foundation", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-console-browser-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off"});
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
    await createBrowserRole(simulator);
  });

  test.afterEach(async () => {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("empty state and narrow global controls are reachable", async ({ page }) => {
    const errors = browserErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${consoleUrl}#/dynamodb/tables`);
    await expect(page.getByRole("heading", { name: "Tables", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No tables" })).toBeVisible();
    const globalTools = page.getByRole("button", { name: "Open global tools" });
    await expect(globalTools).toBeVisible();
    await globalTools.focus();
    await globalTools.press("Enter");
    await expect(page.getByLabel("Search services and resources")).toBeFocused();
    await expect(page.getByRole("button", { name: "Local terminal" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Notifications" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Help" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: "eu-west-1 · Europe (Ireland)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "authentication off" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.keyboard.press("Escape");
    await expect(globalTools).toBeFocused();
    await expect(globalTools).toHaveAttribute("aria-expanded", "false");
    const navigationTrigger = page.locator("#navigation-button");
    await navigationTrigger.focus();
    await navigationTrigger.press("Enter");
    await expect(navigationTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("navigation", { name: "DynamoDB navigation" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(navigationTrigger).toBeFocused();
    await expect(navigationTrigger).toHaveAttribute("aria-expanded", "false");
    expect(errors).toEqual([]);
  });

  test("home services are alphabetical and pinned services stay first after reload", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/home`);
    const serviceNames = page.locator("[data-service-dashboard] > .service-card h2");
    const alphabetical = [
      "API Gateway", "AppSync", "CloudFormation", "CloudFront", "CloudWatch", "Cognito", "DynamoDB", "EventBridge", "IAM", "Lambda",
      "Parameter Store", "RDS", "S3", "Secrets Manager", "SES", "SNS", "SQS", "Step Functions", "X-Ray",
    ];
    await expect(serviceNames).toHaveText(alphabetical);

    const tileKeys = await page.locator("[data-service-dashboard] > [data-service-key]").evaluateAll(cards => cards.map(card => card.getAttribute("data-service-key")).sort());
    await page.getByRole("button", { name: /Services/ }).click();
    const menuKeys = await page.getByRole("dialog").locator(".service-menu [data-service-key]").evaluateAll(links => links.map(link => link.getAttribute("data-service-key")).sort());
    expect(tileKeys).toEqual(menuKeys);
    await page.keyboard.press("Escape");

    const pinRds = page.getByRole("button", { name: "Pin RDS" });
    await pinRds.focus();
    await pinRds.press("Enter");
    await expect(page.getByRole("button", { name: "Unpin RDS" })).toBeFocused();
    await expect(serviceNames).toHaveText(["RDS", ...alphabetical.filter(name => name !== "RDS")]);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("stacksim-home-pinned-services") ?? "[]"))).toEqual(["rds"]);
    const pinnedNavigation = page.locator(".pinned-service-list");
    await expect(pinnedNavigation.locator(".pinned-service-button > span:last-child")).toHaveText(["RDS"]);
    await expect(pinnedNavigation.locator('[data-pinned-service-key="rds"]')).toHaveAttribute("href", "#/rds/databases");
    await expect(pinnedNavigation.locator(".service-icon")).toHaveCount(1);

    await page.getByRole("button", { name: "Pin Parameter Store" }).click();
    await expect(pinnedNavigation.locator(".pinned-service-button > span:last-child")).toHaveText(["Parameter Store", "RDS"]);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("stacksim-home-pinned-services") ?? "[]"))).toEqual(["rds", "systems-manager"]);
    await page.getByRole("link", { name: "Local environment" }).click();
    await expect(pinnedNavigation.locator(".pinned-service-button > span:last-child")).toHaveText(["Parameter Store", "RDS"]);
    await page.getByRole("link", { name: "Local console", exact: true }).click();
    await expect(pinnedNavigation.locator(".pinned-service-button > span:last-child")).toHaveText(["Parameter Store", "RDS"]);
    await pinnedNavigation.locator('[data-pinned-service-key="rds"]').click();
    await expect(page.getByRole("navigation", { name: "RDS navigation" }).getByText("Pinned services", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "RDS navigation" }).getByText("Related services", { exact: true })).toHaveCount(0);
    await expect(pinnedNavigation).toHaveClass(/separated/);
    await expect(pinnedNavigation.locator(".pinned-service-button > span:last-child")).toHaveText(["Parameter Store", "RDS"]);
    await page.reload({ waitUntil: "networkidle" });
    await expect(pinnedNavigation.locator(".pinned-service-button > span:last-child")).toHaveText(["Parameter Store", "RDS"]);
    await page.getByRole("link", { name: "Local console", exact: true }).click();

    await page.reload({ waitUntil: "networkidle" });
    await expect(serviceNames).toHaveText(["Parameter Store", "RDS", ...alphabetical.filter(name => name !== "Parameter Store" && name !== "RDS")]);
    await expect(pinnedNavigation.locator(".pinned-service-button > span:last-child")).toHaveText(["Parameter Store", "RDS"]);
    await page.getByRole("button", { name: "Unpin Parameter Store" }).click();
    await page.getByRole("button", { name: "Unpin RDS" }).click();
    await expect(serviceNames).toHaveText(alphabetical);
    await expect(pinnedNavigation).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pin RDS" })).toHaveAttribute("aria-pressed", "false");
    expect(errors).toEqual([]);
  });

  test("dark theme keeps the glass depth and near-black charcoal canvas", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/home`);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
      localStorage.setItem("stacksim-theme", "dark");
    });
    const appearance = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const card = getComputedStyle(document.querySelector(".service-card")!);
      const button = getComputedStyle(document.querySelector(".service-card footer a")!);
      const header = getComputedStyle(document.querySelector(".global-header")!);
      return {
        canvas: body.backgroundColor,
        cardRadius: card.borderRadius,
        cardShadow: card.boxShadow,
        cardBackground: card.backgroundImage,
        buttonRadius: button.borderRadius,
        buttonShadow: button.boxShadow,
        buttonBackground: button.backgroundImage,
        headerHeight: header.height,
      };
    });
    expect(appearance.canvas).toBe("rgb(15, 17, 21)");
    expect(appearance.cardRadius).toBe("16px");
    expect(appearance.cardShadow).not.toBe("none");
    expect(appearance.cardBackground).toContain("gradient");
    expect(appearance.buttonRadius).toBe("999px");
    expect(appearance.buttonShadow).not.toBe("none");
    expect(appearance.buttonBackground).toContain("gradient");
    expect(appearance.headerHeight).toBe("52px");
    expect(errors).toEqual([]);
  });

  test("happy path creates a table from the dedicated create page", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/dynamodb/tables`);
    await page.getByRole("link", { name: "Create table" }).first().click();
    await expect(page).toHaveURL(/#\/dynamodb\/tables\/create$/);
    const form = page.locator("#create-table-form");
    const tableName = form.getByLabel("Table name");
    await tableName.fill("create");
    await form.getByLabel("Partition key", { exact: true }).fill("id");
    await form.getByRole("button", { name: "Create table" }).click();
    await expect(page).toHaveURL(/#\/dynamodb\/tables\/create\/overview$/);
    await expect(page.getByRole("heading", { name: "create", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("keyboard-only operation covers global header, side navigation, tables, tabs, and forms", async ({ page }) => {
    await createTable(simulator, "KeyboardNotes", true);
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/dynamodb/tables`);
    const main = page.locator("main");
    await expect(main).toBeFocused();

    const services = page.getByRole("button", { name: /Services/ });
    const servicesChevron = services.locator("svg.services-chevron");
    await expect(servicesChevron).toBeVisible();
    await expect(servicesChevron).toHaveAttribute("aria-hidden", "true");
    await expect(services).not.toContainText("⌄");
    await services.focus();
    await services.press("Enter");
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Services" })).toBeVisible();
    const serviceNames = await dialog.locator(".service-menu strong").allTextContents();
    expect(serviceNames.length).toBeGreaterThan(0);
    expect(serviceNames).toEqual([...serviceNames].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" })));
    const modalElement = page.locator("#modal");
    await modalElement.evaluate(element => element.addEventListener("close", () => { element.dataset.closeObserved = "true"; }, { once: true }));
    await page.keyboard.press("Escape");
    await expect(modalElement).toHaveAttribute("data-close-observed", "true");
    await expect(dialog).not.toBeVisible();
    await expect(services).toBeFocused();

    await page.keyboard.press("Tab");
    const globalSearch = page.getByLabel("Search services and resources");
    await expect(globalSearch).toBeFocused();
    await page.keyboard.press("Escape");
    await page.locator("main").focus();
    await page.keyboard.press("Alt+s");
    await expect(globalSearch).toBeFocused();
    await globalSearch.fill("lambda");
    await globalSearch.press("ArrowDown");
    await expect(globalSearch).toHaveAttribute("aria-activedescendant", /global-search-option-0/);
    await globalSearch.press("Escape");

    const help = page.getByRole("button", { name: "Help", exact: true });
    await help.focus();
    await help.press("Enter");
    const helpPanel = page.getByRole("complementary", { name: "Help and tools" });
    await expect(helpPanel).toBeVisible();
    await expect(help).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(helpPanel).not.toBeVisible();
    await expect(help).toBeFocused();

    const dynamoNavigation = page.getByRole("navigation", { name: "DynamoDB navigation" });
    const overview = dynamoNavigation.getByRole("link", { name: "Overview", exact: true });
    await overview.focus();
    await overview.press("Enter");
    await expect(page).toHaveURL(/#\/dynamodb$/);
    await expect(main.locator("h1")).toHaveText("DynamoDB");
    await expect(main).toBeFocused();
    const tables = dynamoNavigation.getByRole("link", { name: "Tables", exact: true });
    await tables.focus();
    await tables.press("Enter");
    await expect(page).toHaveURL(/#\/dynamodb\/tables$/);
    await expect(main.locator("h1")).toHaveText("Tables");
    await expect(main).toBeFocused();

    const tableFilter = page.getByLabel("Find tables");
    await tableFilter.focus();
    const filterFocus = await tableFilter.evaluate(input => {
      const filter = input.closest(".filter");
      const style = filter ? getComputedStyle(filter) : undefined;
      return { outlineStyle: style?.outlineStyle, outlineWidth: style?.outlineWidth };
    });
    expect(filterFocus.outlineStyle).not.toBe("none");
    expect(Number.parseFloat(filterFocus.outlineWidth ?? "0")).toBeGreaterThan(0);

    const tableLink = page.getByRole("link", { name: "KeyboardNotes", exact: true });
    await tableLink.focus();
    await tableLink.press("Enter");
    await expect(page).toHaveURL(/#\/dynamodb\/tables\/KeyboardNotes\/overview$/);
    await expect(main.locator("h1")).toHaveText("KeyboardNotes");
    await expect(main).toBeFocused();
    const itemsTab = page.getByRole("link", { name: "Explore table items", exact: true });
    await itemsTab.focus();
    await itemsTab.press("Enter");
    await expect(page).toHaveURL(/#\/dynamodb\/tables\/KeyboardNotes\/items$/);
    await expect(page.getByRole("heading", { name: "Scan or query items" })).toBeVisible();
    await expect(main).toBeFocused();

    const operation = page.getByLabel("Operation");
    const partitionKey = page.getByLabel("Partition key value");
    await operation.focus();
    await operation.press("KeyQ");
    await expect(operation).toHaveValue("query");
    await page.keyboard.press("Tab");
    await expect(partitionKey).toBeFocused();
    await page.keyboard.type("fixture");
    await expect(partitionKey).toHaveValue("fixture");

    await tables.focus();
    await tables.press("Enter");
    await expect(page).toHaveURL(/#\/dynamodb\/tables$/);
    await expect(page.locator("main h1")).toHaveText("Tables");
    const create = page.getByRole("link", { name: "Create table" }).first();
    await create.focus();
    await create.press("Enter");
    await expect(page).toHaveURL(/#\/dynamodb\/tables\/create$/);
    await expect(main.locator("h1")).toHaveText("Create table");
    await expect(main).toBeFocused();
    const createTableName = page.locator("#create-table-form").getByLabel("Table name");
    for (let index = 0; index < 4 && !(await createTableName.evaluate(element => element === document.activeElement)); index++) {
      await page.keyboard.press("Tab");
    }
    await expect(createTableName).toBeFocused();
    await page.keyboard.type("KeyboardCreated");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Partition key", { exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/#\/dynamodb\/tables\/create$/);
    await expect(page.locator("#create-table-form")).toBeVisible();
    const cancelCreate = page.getByRole("link", { name: "Cancel", exact: true });
    await cancelCreate.focus();
    await cancelCreate.press("Enter");
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).press("Enter");
    await expect(page).toHaveURL(/#\/dynamodb\/tables\/create$/);
    await expect(cancelCreate).toBeFocused();
    expect(errors).toEqual([]);
  });

  test("validation failure stays in context and exposes an alert", async ({ page }) => {
    await createTable(simulator, "BrowserNotes");
    const errors = browserErrors(page, [{
      status: 400,
      url: /^http:\/\/127\.0\.0\.1:\d+\/$/,
      consoleMessage: /Failed to load resource:.*400/,
    }]);
    await page.goto(`${consoleUrl}#/dynamodb/tables`);
    await page.getByRole("link", { name: "Create table" }).click();
    const form = page.locator("#create-table-form");
    await form.getByLabel("Table name").fill("BrowserNotes");
    await form.getByLabel("Partition key", { exact: true }).fill("id");
    await form.getByRole("button", { name: "Create table" }).click();
    await expect(page).toHaveURL(/#\/dynamodb\/tables\/create$/);
    await expect(page.locator("#create-table-error")).toContainText(/exist|resource/i);
    await expect(form.getByRole("button", { name: "Create table" })).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test("Lambda overview stays available when an S3 notification inventory request is denied", async ({ page }) => {
    const lambda = new LambdaClient(sdkOptions(simulator)); const s3 = new S3Client(sdkOptions(simulator)); const functionName = "browser-partial-s3-inventory"; const deniedBucket = "browser-denied-notification-inventory";
    try {
      const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
      await lambda.send(new CreateFunctionCommand({ FunctionName: functionName, Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/browser-role", Handler: "handler.echoHandler", Code: { ZipFile: zip } }));
      await s3.send(new CreateBucketCommand({ Bucket: deniedBucket }));
      const deniedUrl = new RegExp(`/${deniedBucket}\\?notification$`);
      const errors = browserErrors(page, [{ status: 403, url: deniedUrl, consoleMessage: /Failed to load resource:.*403/ }]);
      await page.route(deniedUrl, route => route.fulfill({ status: 403, contentType: "application/xml", body: "<Error><Code>AccessDenied</Code><Message>A resource policy explicitly denies the action</Message></Error>" }));

      await page.goto(`${consoleUrl}#/lambda/functions/${functionName}`);

      await expect(page.getByRole("heading", { name: functionName })).toBeVisible();
      await expect(page.locator(".lambda-source-editor-card")).toHaveCount(0);
      const inventory = page.locator(".s3-trigger-inventory");
      const warning = inventory.locator(".alert.warning");
      await expect(warning.getByText("Partial S3 trigger inventory", { exact: true })).toBeVisible();
      await expect(warning).toContainText("1 bucket could not be inspected with the current permissions or no longer exists.");
      await expect(page.getByRole("heading", { name: "Unable to load this page" })).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally { lambda.destroy(); s3.destroy(); }
  });

  test("dirty-page navigation is guarded across links and global search", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/dynamodb/transactions`);
    const request = page.getByLabel("Transaction request (DynamoDB JSON)");
    await request.fill(`${await request.inputValue()}\n`);
    await page.getByRole("link", { name: "Tables", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/#\/dynamodb\/transactions$/);

    const search = page.getByLabel("Search services and resources");
    await search.fill("lambda");
    await search.press("ArrowDown");
    await search.press("Enter");
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
    await dialog.getByRole("button", { name: "Discard changes" }).click();
    await expect(page).toHaveURL(/#\/lambda$/);
    expect(errors).toEqual([]);
  });

  test("IAM detail and policy-editor tabs are functional and keyboard reachable", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/iam/roles/browser-role`);
    const trustTab = page.getByRole("link", { name: "Trust relationships" });
    await trustTab.focus();
    await trustTab.press("Enter");
    await expect(page).toHaveURL(/#\/iam\/roles\/browser-role\/trust$/);
    await expect(page.getByRole("heading", { name: "Trust policy" })).toBeVisible();
    const tagsTab = page.getByRole("link", { name: "Tags", exact: true });
    await tagsTab.focus();
    await tagsTab.press("Enter");
    await expect(page.getByRole("region", { name: "Tags" })).toBeVisible();

    await page.goto(`${consoleUrl}#/iam/policies`);
    await page.getByRole("button", { name: "Create policy" }).click();
    const dialog = page.getByRole("dialog");
    const visualTab = dialog.getByRole("tab", { name: "Visual" });
    await visualTab.focus();
    await visualTab.press("Enter");
    await dialog.getByLabel("Actions").fill("dynamodb:GetItem");
    await dialog.getByRole("button", { name: "Validate" }).click();
    await expect(dialog.getByRole("status")).toHaveText("Valid policy");
    await expect(dialog.getByRole("region", { name: "Permission summary" })).toContainText("dynamodb:GetItem");
    await dialog.getByLabel("Actions").fill("dynamodb:GetItem\ndynamodb:Query");
    await expect(dialog.getByRole("status")).toHaveText("Not validated");
    const jsonTab = dialog.getByRole("tab", { name: "JSON" });
    await visualTab.focus();
    await visualTab.press("ArrowRight");
    await expect(jsonTab).toBeFocused();
    await jsonTab.press("Enter");
    await expect(dialog.getByLabel("Policy document")).toHaveValue(/dynamodb:GetItem/);
    await dialog.getByLabel("Policy document").fill(JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "dynamodb:GetItem", Resource: "*", Condition: { MadeUpOperator: { key: "value" } } }] }, null, 2));
    await dialog.getByRole("button", { name: "Validate" }).click();
    await expect(dialog.getByRole("status")).toHaveText("Validation failed");
    await expect(dialog.getByRole("alert")).toContainText("Unsupported condition operator MadeUpOperator");
    await dialog.getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Enter");
    expect(errors).toEqual([]);
  });

  test("IAM security credentials show an explicit never-used state", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/iam/users/admin`);
    await expect(page.getByRole("columnheader", { name: "Last used" })).toBeVisible();
    await page.getByRole("button", { name: "Create access key" }).click();
    const dialog = page.getByRole("dialog"); await expect(dialog.getByText("Secret shown once", { exact: true })).toBeVisible(); await dialog.getByRole("button", { name: "I saved it" }).click();
    await page.reload();
    await expect(page.getByRole("cell", { name: "Never", exact: true }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Lambda inline editor creates an invokable function and saves a test event", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/lambda/functions`);
    const create = page.getByRole("button", { name: "Create function" }).first();
    await create.focus();
    await create.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Write code")).toBeChecked();
    await expect(dialog.getByLabel("JavaScript code")).toHaveValue(/Hello from Lambda!/);
    await dialog.getByLabel("Function name").fill("browser-echo");
    await dialog.getByLabel("JavaScript code").fill('export const handler = async event => ({ echoed: event, source: "inline" });');
    await dialog.getByLabel("Upload .zip").check();
    await expect(dialog.getByLabel("Deployment package")).toBeVisible();
    await dialog.getByLabel("Write code").check();
    await expect(dialog.getByLabel("JavaScript code")).toHaveValue(/source: "inline"/);
    await dialog.getByLabel("Execution role choice").selectOption("existing");
    await dialog.getByRole("combobox", { name: "Existing role" }).fill("arn:aws:iam::000000000000:role/browser-role");
    const submit = dialog.getByRole("button", { name: "Create function", exact: true });
    await submit.focus();
    await submit.press("Enter");
    await expect(page).toHaveURL(/#\/lambda\/functions\/browser-echo$/);
    await expect(page.locator("main h1")).toHaveText("browser-echo");
    const codeProperties = page.locator(".code-properties-card");
    await expect(codeProperties.getByText("Code source", { exact: true })).toBeVisible();
    await expect(codeProperties.getByText("Inline code", { exact: true })).toBeVisible();
    await expect(codeProperties.getByText("Source file", { exact: true })).toBeVisible();
    await expect(codeProperties.getByText("index.mjs", { exact: true })).toBeVisible();
    await expect(codeProperties.getByText("Package type", { exact: true })).toHaveCount(0);
    const sourceEditor = page.locator(".lambda-source-editor-card").getByLabel("JavaScript code");
    await expect(page.getByText("Changes apply to $LATEST immediately", { exact: true })).toBeVisible();
    await expect(page.getByText(/without a version or alias use saved changes immediately/)).toBeVisible();
    await expect(sourceEditor).toHaveValue(/source: "inline"/);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await sourceEditor.fill('export const handler = async event => ({ echoed: event, source: "edited-inline" });');
    await expect(page.getByRole("button", { name: "Discard changes" })).toBeEnabled();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#toast-region").getByRole("status").filter({ hasText: "Function code saved" })).toBeVisible();
    await expect(page.locator(".lambda-source-editor-card").getByLabel("JavaScript code")).toHaveValue(/source: "edited-inline"/);
    const lambda = new LambdaClient(sdkOptions(simulator));
    try { await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: "browser-echo", Timeout: 10 })); }
    finally { lambda.destroy(); }

    const testTab = page.getByRole("link", { name: "Test", exact: true });
    await testTab.focus();
    await testTab.press("Enter");
    await page.getByLabel("Event JSON").fill('{"hello":"world"}');
    const saveEvent = page.locator("#save-test");
    await saveEvent.focus();
    await saveEvent.press("Enter");
    await expect(page.locator("#toast-region").getByRole("status").filter({ hasText: "Test event saved locally" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No recent invocation" })).toBeVisible();
    await page.locator("#run-test").click();
    await expect(page.locator("#lambda-result").getByText("Succeeded", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#lambda-result")).toContainText('"source": "edited-inline"');
    await expect(page.locator("#lambda-result")).toContainText('"hello": "world"');
    expect(errors).toEqual([]);
  });

  test("API Gateway resource tree renders nested resources and methods in both themes", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/apigateway/apis`);
    const createApi = page.getByRole("button", { name: "Create API" }).first();
    await createApi.focus();
    await createApi.press("Enter");
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("API name").fill("browser-api");
    await dialog.getByLabel(/Description/).fill("Browser API workflow fixture");
    const submitApi = dialog.getByRole("button", { name: "Create API" });
    await submitApi.focus();
    await submitApi.press("Enter");
    await expect(page.locator("main h1")).toHaveText("browser-api");
    await expect(page).toHaveURL(/#\/apigateway\/apis\/[a-z0-9]+$/);

    const createResource = page.getByRole("button", { name: "Create resource" });
    await createResource.focus();
    await createResource.press("Enter");
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Resource path").fill("items");
    const submitResource = dialog.getByRole("button", { name: "Create resource" });
    await submitResource.focus();
    await submitResource.press("Enter");
    await expect(page.locator(".tree-pane")).toContainText("/items");

    const resourceTree = page.getByRole("tree", { name: "API resources" });
    const rootResource = resourceTree.getByRole("treeitem", { name: "/, resource", exact: true });
    const itemsResource = resourceTree.getByRole("treeitem", { name: "/items, resource", exact: true });
    await expect(rootResource).toHaveAttribute("aria-level", "1");
    await expect(itemsResource).toHaveAttribute("aria-level", "2");
    await itemsResource.click();
    await page.getByRole("button", { name: "Create resource" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Parent resource")).toHaveValue(await itemsResource.getAttribute("data-resource-id") ?? "");
    await dialog.getByLabel("Resource path").fill("{id}");
    await dialog.getByRole("button", { name: "Create resource" }).click();

    const itemResource = resourceTree.getByRole("treeitem", { name: "/items/{id}, resource", exact: true });
    await expect(itemResource).toBeVisible();
    await expect(itemResource).toHaveAttribute("aria-level", "3");
    await expect(itemResource.locator(".api-resource-segment")).toHaveText("/{id}");
    await resourceTree.getByRole("button", { name: "Collapse /items", exact: true }).click();
    await expect(itemResource).toBeHidden();
    await rootResource.click();
    await expect(itemResource).toBeHidden();
    await resourceTree.getByRole("button", { name: "Expand /items", exact: true }).click();
    await expect(itemResource).toBeVisible();

    const apiId = page.url().match(/#\/apigateway\/apis\/([^/]+)/)?.[1];
    expect(apiId).toBeTruthy();
    const gateway = new APIGatewayClient(sdkOptions(simulator));
    try {
      const resources = (await gateway.send(new GetResourcesCommand({ restApiId: apiId! }))).items ?? [];
      const root = resources.find(resource => resource.path === "/")!;
      const items = resources.find(resource => resource.path === "/items")!;
      const item = resources.find(resource => resource.path === "/items/{id}")!;
      await gateway.send(new PutMethodCommand({ restApiId: apiId!, resourceId: root.id!, httpMethod: "GET", authorizationType: "NONE" }));
      await gateway.send(new PutMethodCommand({ restApiId: apiId!, resourceId: items.id!, httpMethod: "POST", authorizationType: "NONE" }));
      for (const method of ["ANY", "DELETE", "HEAD", "OPTIONS", "PATCH", "PUT"]) await gateway.send(new PutMethodCommand({ restApiId: apiId!, resourceId: item.id!, httpMethod: method, authorizationType: "NONE" }));
    } finally {
      gateway.destroy();
    }
    await page.reload();
    const getMethod = resourceTree.getByRole("treeitem", { name: "GET /", exact: true });
    const postMethod = resourceTree.getByRole("treeitem", { name: "POST /items", exact: true });
    await expect(getMethod).toBeVisible();
    await expect(postMethod).toBeVisible();
    const methodAction = page.getByRole("button", { name: "GET · No integration", exact: true });
    const monitorAction = page.getByRole("link", { name: "Monitor GET /", exact: true });
    await expect(methodAction.locator("..")).toHaveClass(/method-split-button/);
    await expect(methodAction.locator("..").getByRole("link", { name: "Monitor GET /", exact: true })).toBeVisible();
    await expect(monitorAction).toBeVisible();
    const methodsHelp = page.getByRole("button", { name: "About Methods", exact: true });
    await methodsHelp.hover();
    await expect(methodsHelp.locator("..").getByRole("tooltip")).toContainText("white method half");
    await expect(methodsHelp.locator("..").getByRole("tooltip")).toContainText("blue Monitor half");
    const resourceSummaryX = await page.locator(".tree-details > .card-header.embedded h2").evaluate(element => element.getBoundingClientRect().x);
    const methodsHeadingX = await page.locator(".tree-details > .panel-title-row h3").evaluate(element => element.getBoundingClientRect().x);
    expect(Math.abs(resourceSummaryX - methodsHeadingX)).toBeLessThan(1);
    await rootResource.focus();
    await rootResource.press("ArrowDown");
    await expect(getMethod).toBeFocused();
    await getMethod.press("ArrowDown");
    await expect(itemsResource).toBeFocused();
    await itemsResource.press("ArrowRight");
    await expect(postMethod).toBeFocused();

    const methodContrast = async (selector: string, theme: "light" | "dark") => page.evaluate(({ selector, theme }) => {
      document.documentElement.dataset.theme = theme;
      const element = document.querySelector(selector)!;
      const foreground = getComputedStyle(element).color.match(/\d+(?:\.\d+)?/g)!.slice(0, 3).map(Number);
      const background = getComputedStyle(element.closest(".api-resource-tree")!).backgroundColor.match(/\d+(?:\.\d+)?/g)!.slice(0, 3).map(Number);
      const luminance = (rgb: number[]) => rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return { ratio: (values[0] + .05) / (values[1] + .05), foreground, background };
    }, { selector, theme });
    const methodPaths = { GET: "/", POST: "/items", ANY: "/items/{id}", DELETE: "/items/{id}", HEAD: "/items/{id}", OPTIONS: "/items/{id}", PATCH: "/items/{id}", PUT: "/items/{id}" };
    for (const theme of ["light", "dark"] as const) {
      for (const [method, path] of Object.entries(methodPaths)) {
        const contrast = await methodContrast(`.api-resource-method[aria-label="${method} ${path}"]`, theme);
        expect(contrast.ratio, `${theme} ${method} contrast: ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(errors).toEqual([]);
  });

  test("destructive flow requires the exact resource name", async ({ page }) => {
    await createTable(simulator, "BrowserNotes");
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/dynamodb/tables/BrowserNotes`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const confirmation = dialog.locator('input[name="confirmation"]');
    await confirmation.fill("wrong-name");
    expect(await confirmation.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
    await confirmation.fill("BrowserNotes");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/#\/dynamodb\/tables$/);
    await expect(page.getByRole("heading", { name: "No tables" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("FND-02 concrete route audit", () => {
  let routeSimulator: StackSim;
  let routeDataDir: string;
  let routeConsoleUrl: string;
  let apiId: string;
  let apiKeyId: string;
  let usagePlanId: string;
  let policyArn: string;

  test.beforeAll(async () => {
    routeDataDir = await mkdtemp(join(tmpdir(), "stacksim-console-route-audit-"));
    routeSimulator = new StackSim({ port: 0, invokePort: 0, dataDir: routeDataDir, region: "eu-west-1", authMode: "off"});
    await routeSimulator.start();
    routeConsoleUrl = `http://127.0.0.1:${routeSimulator.port}/_stacksim/console`;
    ({ apiId, apiKeyId, usagePlanId, policyArn } = await seedRouteAudit(routeSimulator));
  });

  test.afterAll(async () => {
    await routeSimulator.stop();
    await rm(routeDataDir, { recursive: true, force: true });
  });

  test("all 35 concrete routes focus main, fit 1280px, and emit no diagnostics", async ({ page }) => {
    test.setTimeout(90_000);
    const errors = browserErrors(page);
    const routes = [
      { name: "console home", hash: "#/home", heading: "Console Home" },
      { name: "local environment", hash: "#/environment", heading: "Local environment" },
      { name: "Lambda overview", hash: "#/lambda", heading: "Lambda" },
      { name: "Lambda functions", hash: "#/lambda/functions", heading: "Functions" },
      { name: "Lambda function overview", hash: "#/lambda/functions/route-audit-function", heading: "route-audit-function" },
      { name: "Lambda function test", hash: "#/lambda/functions/route-audit-function/test", heading: "route-audit-function" },
      { name: "Lambda function monitor", hash: "#/lambda/functions/route-audit-function/monitor", heading: "route-audit-function" },
      { name: "Lambda function configuration", hash: "#/lambda/functions/route-audit-function/configuration", heading: "route-audit-function" },
      { name: "Lambda function aliases", hash: "#/lambda/functions/route-audit-function/aliases", heading: "route-audit-function" },
      { name: "Lambda function versions", hash: "#/lambda/functions/route-audit-function/versions", heading: "route-audit-function" },
      { name: "DynamoDB overview", hash: "#/dynamodb", heading: "DynamoDB" },
      { name: "DynamoDB tables", hash: "#/dynamodb/tables", heading: "Tables" },
      { name: "DynamoDB create table", hash: "#/dynamodb/tables/create", heading: "Create table" },
      { name: "DynamoDB table overview", hash: "#/dynamodb/tables/RouteAuditTable/overview", heading: "RouteAuditTable" },
      { name: "DynamoDB table items", hash: "#/dynamodb/tables/RouteAuditTable/items", heading: "RouteAuditTable" },
      { name: "DynamoDB transactions", hash: "#/dynamodb/transactions", heading: "Transaction builder" },
      { name: "API Gateway APIs", hash: "#/apigateway/apis", heading: "APIs" },
      { name: "API Gateway API keys", hash: "#/apigateway/api-keys", heading: "API keys" },
      { name: "API Gateway API key detail", hash: `#/apigateway/api-keys/${apiKeyId}`, heading: "route-audit-key" },
      { name: "API Gateway usage plans", hash: "#/apigateway/usage-plans", heading: "Usage plans" },
      { name: "API Gateway usage plan detail", hash: `#/apigateway/usage-plans/${usagePlanId}`, heading: "route-audit-plan" },
      { name: "API Gateway resources", hash: `#/apigateway/apis/${apiId}/resources`, heading: "route-audit-api" },
      { name: "API Gateway authorizers", hash: `#/apigateway/apis/${apiId}/authorizers`, heading: "route-audit-api" },
      { name: "API Gateway resource policy", hash: `#/apigateway/apis/${apiId}/policy`, heading: "route-audit-api" },
      { name: "API Gateway stages", hash: `#/apigateway/apis/${apiId}/stages`, heading: "route-audit-api" },
      { name: "CloudWatch log groups", hash: "#/cloudwatch/log-groups", heading: "Log groups" },
      { name: "CloudWatch log group", hash: `#/cloudwatch/log-groups/${encodeURIComponent("/stacksim/route-audit")}`, heading: "/stacksim/route-audit" },
      { name: "CloudWatch log stream", hash: `#/cloudwatch/log-groups/${encodeURIComponent("/stacksim/route-audit")}/streams/seed`, heading: "seed" },
      { name: "IAM dashboard", hash: "#/iam", heading: "Identity and Access Management (IAM)" },
      { name: "IAM roles", hash: "#/iam/roles", heading: "Roles" },
      { name: "IAM role detail", hash: "#/iam/roles/route-audit-role", heading: "route-audit-role" },
      { name: "IAM policies", hash: "#/iam/policies", heading: "Policies" },
      { name: "IAM policy detail", hash: `#/iam/policies/${encodeURIComponent(policyArn)}`, heading: "RouteAuditPolicy" },
      { name: "IAM decisions", hash: "#/iam/decisions", heading: "Authorization decisions" },
      { name: "route not found", hash: "#/not-found", heading: "Page not found" },
    ];
    expect(routes).toHaveLength(35);
    await page.setViewportSize({ width: 1280, height: 800 });

    for (const route of routes) {
      const diagnosticStart = errors.length;
      await page.goto(`${routeConsoleUrl}${route.hash}`);
      const main = page.locator("main");
      await expect(main.locator("h1"), `${route.name} heading`).toHaveText(route.heading);
      await expect(main, `${route.name} focus`).toBeFocused();
      const containment = await page.evaluate(() => {
        const main = document.querySelector("main")!;
        const rect = main.getBoundingClientRect();
        return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth, mainLeft: rect.left, mainRight: rect.right };
      });
      expect(containment, `${route.name} containment`).toEqual({ viewportWidth: 1280, documentWidth: 1280, mainLeft: 240, mainRight: 1280 });
      await page.waitForTimeout(20);
      expect(errors.slice(diagnosticStart), `${route.name} diagnostics`).toEqual([]);
    }

    const diagnosticStart = errors.length;
    await page.goto(`${routeConsoleUrl}#/dynamodb/tables/RouteAuditTable/not-a-section`);
    await expect(page.locator("main h1"), "nested unknown route heading").toHaveText("Page not found");
    await expect(page.locator("main"), "nested unknown route focus").toBeFocused();
    expect(errors.slice(diagnosticStart), "nested unknown route diagnostics").toEqual([]);
  });
});
