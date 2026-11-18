import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as AppSync from "@aws-sdk/client-appsync";
import * as Iam from "@aws-sdk/client-iam";
import { StackSim } from "../../src/server.js";

for (const width of [1440, 390]) test(`AppSync binds, edits and removes an OpenSearch data source at ${width}px`, async ({ page }) => {
  test.setTimeout(60000); const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-search-ui-")), region = "eu-west-1", sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false });
  let appsync: AppSync.AppSyncClient | undefined, iam: Iam.IAMClient | undefined; const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 }; appsync = new AppSync.AppSyncClient(sdk); iam = new Iam.IAMClient(sdk);
    await sim.opensearch.execute("CreateDomain", { DomainName: "browser-graphql" }, region); for (let i = 0; i < 200 && sim.opensearch.domain(region, "browser-graphql").state !== "active"; i++) await delay(10);
    const endpoint = `https://127.0.0.1:${sim.opensearch.domain(region, "browser-graphql").gatewayPort}`;
    const api = (await appsync.send(new AppSync.CreateGraphqlApiCommand({ name: "Search browser", authenticationType: "API_KEY" }))).graphqlApi!;
    const role = (await iam.send(new Iam.CreateRoleCommand({ RoleName: "BrowserSearch", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Principal: { Service: "appsync.amazonaws.com" } }] }) }))).Role!;
    await page.setViewportSize({ width, height: 900 }); const base = `http://127.0.0.1:${sim.port}/_stacksim/console`;
    await page.goto(`${base}#/appsync/apis/${api.apiId}/data-sources`); await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" }); await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await page.getByRole("button", { name: "Create data source", exact: true }).first().click(); let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill("Search"); await dialog.getByLabel("Type", { exact: true }).selectOption("AMAZON_OPENSEARCH_SERVICE");
    await dialog.getByLabel("OpenSearch endpoint", { exact: true }).fill("https://example.com"); await dialog.getByLabel("Service role", { exact: true }).fill(role.Arn!);
    await dialog.getByRole("button", { name: "Create data source", exact: true }).click(); await expect(page.locator("#toast-region")).toContainText("current same-account");
    await dialog.getByLabel("OpenSearch endpoint", { exact: true }).fill(endpoint); await dialog.getByRole("button", { name: "Create data source", exact: true }).click(); await expect(dialog).not.toBeVisible();
    await page.getByRole("link", { name: "Search", exact: true }).click(); await expect(page.getByRole("heading", { name: "Search", exact: true }).first()).toBeVisible(); await expect(page.getByText(endpoint, { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click(); dialog = page.getByRole("dialog"); await expect(dialog.getByLabel("OpenSearch endpoint", { exact: true })).toHaveValue(endpoint); await dialog.getByLabel("Description", { exact: true }).fill("Search products in the embedded domain"); await dialog.getByRole("button", { name: "Save data source", exact: true }).click(); await expect(dialog).not.toBeVisible();
    await expect(page.getByText("Search products in the embedded domain", { exact: true })).toBeVisible(); expect((await appsync.send(new AppSync.GetDataSourceCommand({ apiId: api.apiId!, name: "Search" }))).dataSource!.openSearchServiceConfig?.endpoint).toBe(endpoint);
    await expect(page.locator("#toast-region")).toBeEmpty(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`appsync-search-${width}.png`) });
    await page.getByRole("button", { name: "Delete", exact: true }).click(); await page.getByRole("dialog").getByRole("textbox").fill("Search"); await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(); await expect(page.getByRole("heading", { name: "No data sources", exact: true })).toBeVisible(); expect(errors).toEqual([]);
  } finally { appsync?.destroy(); iam?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
