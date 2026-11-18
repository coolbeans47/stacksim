import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { StackSim } from "../../src/server.js";

for (const width of [1440, 390]) test(`SQL/PPL editor, errors, plans and pagination at ${width}px`, async ({ page }) => {
  test.setTimeout(60000); const root = await mkdtemp(join(tmpdir(), "stacksim-ql-ui-")), region = "eu-west-1", sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false }); let client: Client | undefined;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "browser-sql" }, region);
    for (let i = 0; i < 200 && sim.opensearch.domain(region, "browser-sql").state !== "active"; i++) await delay(10);
    client = new Client({ node: `https://127.0.0.1:${sim.opensearch.domain(region, "browser-sql").gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: "admin", secretAccessKey: "password" }) }) });
    for (const [i, body] of [{ title: "Red shoes", price: 20 }, { title: "Hat", price: 10 }, { title: "Blue shoes", price: 40 }].entries()) await client.index({ index: "products", id: String(i), body, refresh: true });
    await page.setViewportSize({ width, height: 900 }); const base = `http://127.0.0.1:${sim.port}/_stacksim/console`;
    await page.goto(`${base}#/opensearch/domains/browser-sql`); await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" }); await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await page.getByRole("link", { name: "SQL and PPL", exact: true }).click(); await expect(page.getByRole("heading", { name: "SQL and PPL", exact: true })).toBeVisible();
    const editor = page.getByLabel("Query", { exact: true }), run = page.getByRole("button", { name: "Run query", exact: true });
    await editor.fill("DELETE FROM products"); await run.click(); await expect(page.locator('#os-language-form [role="alert"]')).toContainText("Expected SELECT");
    await editor.fill("SELECT title,price FROM products ORDER BY price"); await page.getByLabel("SQL page size", { exact: true }).fill("1"); await run.click(); await expect(page.getByRole("table", { name: "Query results" })).toContainText("Hat"); await expect(page.locator("#os-language-status")).toContainText("3 matched · Page 1");
    await page.getByRole("button", { name: "Next page", exact: true }).click(); await expect(page.getByRole("table", { name: "Query results" })).toContainText("Red shoes");
    await page.getByRole("button", { name: "Close results", exact: true }).click(); await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Explain query", exact: true }).click(); await expect(page.getByLabel("Query plan", { exact: true })).toContainText("StackSimIndexScan");
    await page.getByLabel("Language", { exact: true }).selectOption("ppl"); await expect(page.getByLabel("SQL page size", { exact: true })).toBeDisabled(); await editor.fill("source=products | where price >= 20 | stats count() AS count,sum(price) AS total"); await run.click(); await expect(page.getByRole("table", { name: "Query results" })).toContainText("60");
    await page.getByRole("heading", { name: "SQL and PPL", exact: true }).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`query-languages-${width}.png`), fullPage: true });
    await page.getByRole("table", { name: "Query results" }).scrollIntoViewIfNeeded(); await page.screenshot({ path: test.info().outputPath(`query-languages-results-${width}.png`) });
    await editor.fill("source=products | where price < 0 | fields title"); await run.click(); await expect(page.getByText("No rows match this query.", { exact: true })).toBeVisible();
    expect((await client.count({ index: "products" })).body.count).toBe(3); expect(errors).toEqual([]);
  } finally { await client?.close(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
