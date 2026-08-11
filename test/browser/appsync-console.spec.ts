import { expect, test, type Page } from "@playwright/test";
import {
  AppSyncClient,
  GetGraphqlApiCommand,
  ListApiKeysCommand,
  ListDataSourcesCommand,
  ListGraphqlApisCommand,
  ListResolversCommand,
} from "@aws-sdk/client-appsync";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { AttachRolePolicyCommand, CreatePolicyCommand, CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function sdkOptions() {
  return { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
}

function browserErrors(page: Page, expected: Array<{ status: number; url: RegExp }> = []) {
  const errors: string[] = [];
  page.on("console", message => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const location = message.location().url;
    if (expected.some(item => item.url.test(location)) && /Failed to load resource/.test(message.text())) return;
    errors.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  page.on("response", response => {
    if (response.status() < 400) return;
    if (!expected.some(item => item.status === response.status() && item.url.test(response.url()))) {
      errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
    }
  });
  return errors;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => document.documentElement.clientWidth));
}

async function expectPanelHelp(page: Page, title: string, text: string) {
  const button = page.getByRole("button", { name: `About ${title}` }).first();
  await expect(button).toBeVisible();
  await button.hover();
  const tooltip = button.locator("..").getByRole("tooltip");
  await expect(tooltip).toContainText(text);
  await expect(tooltip).toContainText("StackSim support");
}

async function createDynamoResources() {
  const dynamodb = new DynamoDBClient(sdkOptions());
  const iam = new IAMClient(sdkOptions());
  const tableName = "AppSyncConsoleItems";
  const roleName = "appsync-console-data";
  try {
    await dynamodb.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    }));
    const role = await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "appsync.amazonaws.com" }, Action: "sts:AssumeRole" }],
      }),
    }));
    const policy = await iam.send(new CreatePolicyCommand({
      PolicyName: "AppSyncConsoleTableAccess",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "dynamodb:*", Resource: [`arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`, `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}/index/*`] }],
      }),
    }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policy.Policy!.Arn! }));
    return { tableName, roleName, roleArn: role.Role!.Arn! };
  } finally {
    dynamodb.destroy();
    iam.destroy();
  }
}

async function createApiFromConsole(page: Page, name: string) {
  await page.goto(`${consoleUrl}#/appsync/apis/create`);
  await page.getByLabel("API name").fill(name);
  await page.getByLabel("Introspection").selectOption("ENABLED");
  await page.getByLabel("Owner contact (optional)").fill("local@example.test");
  await page.getByLabel("Tags (JSON object)").fill('{"environment":"browser"}');
  await page.getByRole("button", { name: "Create API" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return new URL(page.url()).hash.split("/")[3];
}

async function activateSchema(page: Page) {
  const schema = `type Query {
  hello: String
  getItem(id: ID!): Item
}

type Item {
  id: ID!
  value: String
}`;
  await page.getByRole("tab", { name: "Schema" }).click();
  await page.getByLabel("GraphQL schema").fill(schema);
  await page.getByRole("button", { name: "Validate locally" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Local check passed" })).toBeVisible();
  await page.getByRole("button", { name: "Save schema" }).click();
  await expect(page.getByText("SUCCESS", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View introspection" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Introspection output")).toHaveValue(/type Query/);
  await dialog.getByRole("tab", { name: "JSON" }).click();
  await expect(dialog.getByLabel("Introspection output")).toHaveValue(/__schema/);
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
}

test.use({ screenshot: "off", trace: "off", video: "off" });

test.describe("APS-P0-015 AppSync console", () => {
  test.setTimeout(90_000);

  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-appsync-console-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "off" });
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
  });

  test.afterEach(async () => {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("explains AppSync input panels and their StackSim support", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/appsync/apis`);
    await expectPanelHelp(page, "APIs", "one typed endpoint");

    await page.goto(`${consoleUrl}#/appsync/apis/create`);
    await expectPanelHelp(page, "API configuration", "custom domains, merged APIs");
    const apiId = await createApiFromConsole(page, "panel-help-appsync-api");

    await expectPanelHelp(page, "API details", "Cognito user pools");
    await page.goto(`${consoleUrl}${apiHrefForTest(apiId, "schema")}`);
    await expectPanelHelp(page, "Schema definition", "last valid schema");
    await page.goto(`${consoleUrl}${apiHrefForTest(apiId, "data-sources")}`);
    await expectPanelHelp(page, "Data sources", "Lambda, HTTP, OpenSearch");
    await page.goto(`${consoleUrl}${apiHrefForTest(apiId, "resolvers")}`);
    await expectPanelHelp(page, "Resolvers", "APPSYNC_JS");
    await page.goto(`${consoleUrl}${apiHrefForTest(apiId, "api-keys")}`);
    await expectPanelHelp(page, "API keys", "Plaintext remains only in page memory");
    await page.goto(`${consoleUrl}${apiHrefForTest(apiId, "queries")}`);
    await expectPanelHelp(page, "Operation", "no replay or durable outbox");
    await page.goto(`${consoleUrl}${apiHrefForTest(apiId, "tags")}`);
    await expectPanelHelp(page, "Tags", "organization tag policies");

    await page.setViewportSize({ width: 390, height: 844 });
    const tagsHelp = page.getByRole("button", { name: "About Tags" });
    await tagsHelp.hover();
    const box = await tagsHelp.locator("..").getByRole("tooltip").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  });

  test("covers real API, schema, NONE/DynamoDB source, resolver, key, query, monitoring, tags, and deletion workflows", async ({ page }) => {
    const errors = browserErrors(page);
    const requests: Array<{ method: string; url: string; body: string; headers: Record<string, string> }> = [];
    page.on("request", request => requests.push({
      method: request.method(),
      url: request.url(),
      body: request.postData() ?? "",
      headers: request.headers(),
    }));
    const appSync = new AppSyncClient(sdkOptions());
    const related = await createDynamoResources();
    try {
      await page.goto(`${consoleUrl}#/appsync/apis`);
      await expect(page.getByRole("heading", { name: "No GraphQL APIs" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "AppSync navigation" })).toBeVisible();
      await expect(page.getByRole("link", { name: "AppSync", exact: true })).toBeVisible();

      const apiId = await createApiFromConsole(page, "browser-appsync-api");
      const api = (await appSync.send(new GetGraphqlApiCommand({ apiId }))).graphqlApi!;
      expect(api.authenticationType).toBe("API_KEY");
      expect(api.tags).toEqual({ environment: "browser" });
      await page.goto(`${consoleUrl}#/appsync/apis`);
      await expect(page.getByRole("link", { name: "browser-appsync-api", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "browser-appsync-api", exact: true }).click();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      let dialog = page.getByRole("dialog");
      await dialog.getByLabel("Owner contact (optional)").fill("updated@example.test");
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("updated@example.test", { exact: true })).toBeVisible();
      await activateSchema(page);

      await page.getByRole("tab", { name: "Data sources" }).click();
      await page.getByRole("button", { name: "Create data source" }).first().click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill("Local");
      await dialog.getByLabel("Type").selectOption("NONE");
      await dialog.getByRole("button", { name: "Create data source" }).click();
      await expect(page.getByRole("link", { name: "Local", exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Create data source" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill("Items");
      await dialog.getByLabel("Type").selectOption("AMAZON_DYNAMODB");
      await dialog.getByLabel("DynamoDB table").selectOption(related.tableName);
      await dialog.getByLabel("Service role").fill(related.roleArn);
      await dialog.getByLabel("Service role").press("Escape");
      await expect(dialog.getByText("iam:PassRole", { exact: false })).toBeVisible();
      await dialog.getByRole("button", { name: "Create data source" }).click();
      await page.getByRole("link", { name: "Items", exact: true }).click();
      await expectPanelHelp(page, "Configuration", "assumed per invocation");
      await expect(page.getByRole("link", { name: new RegExp(`Open DynamoDB table.*${related.tableName}`) })).toHaveAttribute("href", new RegExp(`/dynamodb/tables/${related.tableName}/overview`));
      await expect(page.getByRole("link", { name: new RegExp(`Open IAM role.*${related.roleName}`) })).toHaveAttribute("href", new RegExp(`/iam/roles/${related.roleName}/trust`));
      await expect(page.locator("main")).not.toContainText("SecretAccessKey");
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Description").fill("Updated DynamoDB binding");
      await dialog.getByRole("button", { name: "Save data source" }).click();
      await expect(page.getByText("Updated DynamoDB binding", { exact: true })).toBeVisible();

      await page.getByRole("tab", { name: "Resolvers" }).click();
      await page.getByRole("button", { name: "Create resolver" }).first().click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Schema field").selectOption("Query.hello");
      await dialog.getByLabel("Data source").selectOption("Local");
      await dialog.getByLabel("Request mapping template").fill('{"version":"2018-05-29","payload":"hello from the console"}');
      await dialog.getByLabel("Response mapping template").fill("$util.toJson($ctx.result)");
      await dialog.getByRole("button", { name: "Create resolver" }).click();
      await page.getByRole("link", { name: "Query.hello" }).click();
      await expectPanelHelp(page, "Execution", "VTL UNIT execution");
      await expect(page.getByText("VTL", { exact: true })).toBeVisible();
      await expect(page.getByText("Local payload", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Local", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Request mapping template").fill('{"version":"2018-05-29","payload":"hello after resolver edit"}');
      await dialog.getByRole("button", { name: "Save resolver" }).click();
      await expect(page.getByText("hello after resolver edit", { exact: false })).toBeVisible();

      await page.getByRole("tab", { name: "API keys" }).click();
      await page.getByRole("button", { name: "Create API key" }).first().click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Description").fill("Browser editor key");
      await dialog.getByRole("button", { name: "Create key" }).click();
      dialog = page.getByRole("dialog");
      const createdInput = dialog.getByLabel("API key");
      await expect(createdInput).toHaveAttribute("type", "password");
      const apiKey = await createdInput.inputValue();
      expect(apiKey).toMatch(/^da2-/);
      expect(page.url()).not.toContain(apiKey);
      await dialog.getByRole("button", { name: "Reveal", exact: true }).click();
      await expect(createdInput).toHaveAttribute("type", "text");
      await dialog.getByRole("button", { name: "Mask", exact: true }).click();
      await expect(createdInput).toHaveAttribute("type", "password");
      await dialog.getByRole("button", { name: "I saved it" }).click();
      await expect(page.getByText("Browser editor key", { exact: true })).toBeVisible();
      await expect(page.locator("main")).not.toContainText(apiKey);
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Description").fill("Updated browser editor key");
      await dialog.getByRole("button", { name: "Save key" }).click();
      await expect(page.getByText("Updated browser editor key", { exact: true })).toBeVisible();

      await page.getByRole("tab", { name: "Queries" }).click();
      await expect(page.getByRole("button", { name: "Run" })).toBeDisabled();
      await expect(page.locator("[data-key-selection] option").nth(1)).toContainText("Updated browser editor key");
      await page.locator("[data-key-selection]").selectOption("0");
      await page.getByLabel("GraphQL query").fill("query Hello { hello }");
      await page.getByLabel("Operation name (optional)").fill("Hello");
      await page.getByLabel("Variables (JSON object)").fill("{}");
      await page.getByRole("button", { name: "Run" }).click();
      await expect(page.getByLabel("Response").or(page.locator("[data-query-result]"))).toContainText("hello after resolver edit");
      await expect(page.locator("main")).not.toContainText(apiKey);
      expect(await page.evaluate(key => ({
        local: Object.values(localStorage).includes(key),
        session: Object.values(sessionStorage).includes(key),
        history: location.href.includes(key),
      }), apiKey)).toEqual({ local: false, session: false, history: false });

      await page.getByRole("tab", { name: "Monitoring" }).click();
      await expect(page.getByRole("heading", { name: "GraphQLRequestCount" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Bounded local diagnostics" })).toBeVisible();
      await expect(page.locator(".appsync-diagnostic-table")).toContainText("SUCCEEDED");
      await expect(page.locator("main")).not.toContainText(apiKey);
      await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();

      await page.getByRole("tab", { name: "Tags" }).click();
      await page.getByRole("button", { name: "Manage tags" }).first().click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Tags (JSON object)").fill('{"environment":"browser","team":"graphql"}');
      await dialog.getByRole("button", { name: "Save tags" }).click();
      await expect(page.getByRole("cell", { name: "team", exact: true })).toBeVisible();

      expect((await appSync.send(new ListDataSourcesCommand({ apiId }))).dataSources?.map(item => item.name).sort()).toEqual(["Items", "Local"]);
      expect((await appSync.send(new ListResolversCommand({ apiId, typeName: "Query" }))).resolvers?.map(item => item.fieldName)).toEqual(["hello"]);
      expect((await appSync.send(new ListApiKeysCommand({ apiId }))).apiKeys).toHaveLength(1);

      await page.getByRole("tab", { name: "Resolvers" }).click();
      await page.getByRole("link", { name: "Query.hello" }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel(/To confirm deletion, enter Query\.hello/).fill("Query.hello");
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByRole("heading", { name: "No resolvers" })).toBeVisible();

      await page.getByRole("tab", { name: "Data sources" }).click();
      for (const sourceName of ["Items", "Local"]) {
        await page.getByRole("link", { name: sourceName, exact: true }).click();
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        dialog = page.getByRole("dialog");
        await dialog.getByLabel(new RegExp(`To confirm deletion, enter ${sourceName}`)).fill(sourceName);
        await dialog.getByRole("button", { name: "Delete", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Data sources", exact: true }).first()).toBeVisible();
      }
      await expect(page.getByRole("heading", { name: "No data sources" })).toBeVisible();

      await page.getByRole("tab", { name: "API keys" }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel(/To confirm deletion, enter Updated browser editor key/).fill("Updated browser editor key");
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByRole("heading", { name: "No API keys" })).toBeVisible();

      await page.getByRole("tab", { name: "Overview" }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      dialog = page.getByRole("dialog");
      const confirmation = dialog.getByLabel(/To confirm deletion, enter browser-appsync-api/);
      await confirmation.fill("wrong");
      expect(await confirmation.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
      await confirmation.fill("browser-appsync-api");
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByRole("heading", { name: "No GraphQL APIs" })).toBeVisible();
      expect((await appSync.send(new ListGraphqlApisCommand({}))).graphqlApis).toHaveLength(0);
      for (const request of requests) {
        const requiredLifecyclePath = new URL(request.url).pathname
          === `/v1/apis/${apiId}/apikeys/${encodeURIComponent(apiKey)}`
          && ["POST", "DELETE"].includes(request.method);
        if (!requiredLifecyclePath) expect(request.url).not.toContain(apiKey);
        expect(request.body).not.toContain(apiKey);
        const headerLeaks = Object.entries(request.headers).filter(([name, value]) =>
          value.includes(apiKey) && !(name === "x-api-key" && request.url === api.uris!.GRAPHQL));
        expect(headerLeaks, `credential leaked into request metadata for ${request.url}`).toEqual([]);
      }
      expect(errors).toEqual([]);
    } finally {
      appSync.destroy();
    }
  });

  test("shows loading, real error, keyboard focus, and a 390-pixel populated layout without overflow", async ({ page }) => {
    const errors = browserErrors(page, [{ status: 404, url: /\/v1\/apis\/missing-api$/ }]);
    let delayed = false;
    await page.route("**/v1/apis?**", async route => {
      if (!delayed) {
        delayed = true;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      await route.continue();
    });
    await page.goto(`${consoleUrl}#/appsync/apis`);
    await expect(page.getByRole("status", { name: "" }).filter({ hasText: "Loading" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No GraphQL APIs" })).toBeVisible();

    await page.goto(`${consoleUrl}#/appsync/apis/missing-api/overview`);
    await expect(page.getByRole("heading", { name: "Unable to load this page" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("GraphQL API was not found");

    const apiId = await createApiFromConsole(page, "mobile-appsync-api");
    await page.getByRole("tab", { name: "Schema" }).click();
    const apiBreadcrumb = page.getByRole("navigation", { name: "Breadcrumbs" })
      .getByRole("link", { name: "mobile-appsync-api", exact: true });
    await expect(apiBreadcrumb).toHaveAttribute("href", apiHrefForTest(apiId, "overview"));
    await apiBreadcrumb.click();
    await expect(page).toHaveURL(new RegExp(`/overview$`));
    await expect(page.getByRole("heading", { name: "mobile-appsync-api", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    for (const section of ["overview", "schema", "queries", "data-sources", "resolvers", "api-keys", "monitoring", "tags"]) {
      await page.goto(`${consoleUrl}${apiHrefForTest(apiId, section)}`);
      await expect(page.locator(".appsync-detail")).toBeVisible();
      await noOverflow(page);
    }
    await page.goto(`${consoleUrl}${apiHrefForTest(apiId, "overview")}`);
    await expect(page.getByRole("heading", { name: "mobile-appsync-api", exact: true })).toBeVisible();
    const navigationButton = page.locator("#navigation-button");
    await navigationButton.focus();
    await navigationButton.press("Enter");
    await expect(navigationButton).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("navigation", { name: "AppSync navigation" })).toBeVisible();
    await navigationButton.press("Escape");
    await expect(navigationButton).toBeFocused();
    await page.getByRole("tab", { name: "Overview" }).focus();
    await page.getByRole("tab", { name: "Overview" }).press("ArrowRight");
    await expect(page).toHaveURL(new RegExp(`/schema$`));
    await expect(page.locator("main")).toBeFocused();
    await noOverflow(page);
    expect(errors).toEqual([]);
  });
});

function apiHrefForTest(apiId: string, section: string) {
  return `#/appsync/apis/${encodeURIComponent(apiId)}/${section}`;
}
