import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";

let sim: StackSim;
let root: string;
test.beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "stacksim-os-ui-")); sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off", cdkBootstrap: false }); await sim.start(); });
test.afterEach(async () => { await sim.stop(); await rm(root, { recursive: true, force: true }); });

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`managed domain create, query, edit, tags and deletion at ${viewport.width}px`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize(viewport);
    await page.goto(`http://127.0.0.1:${sim.port}/_stacksim/console#/opensearch/domains`);
    await expect(page.getByRole("heading", { name: "No domains", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Create domain", exact: true }).first().click();
    await page.getByLabel("Domain name", { exact: true }).fill("browser-search");
    await page.getByRole("button", { name: "Create domain", exact: true }).click();
    await expect(page.getByRole("heading", { name: "browser-search", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open local query tool" })).toBeVisible();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy endpoint", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    await page.getByRole("link", { name: "Open local query tool" }).click();
    await page.getByLabel("HTTP method").selectOption("PUT");
    await page.getByLabel("Request path").fill("/products/_doc/1?refresh=true");
    await page.getByLabel("Request body (JSON or NDJSON)").fill('{"title":"Browser product","price":12}');
    await page.getByRole("button", { name: "Run request", exact: true }).click();
    await expect(page.locator("#os-query-response")).toContainText('"result": "created"');
    await page.getByLabel("HTTP method").selectOption("POST");
    await page.getByLabel("Request path").fill("/products/_search");
    await page.getByLabel("Request body (JSON or NDJSON)").fill('{"query":{"match":{"title":"browser"}}}');
    await page.getByRole("button", { name: "Run request", exact: true }).click();
    await expect(page.locator("#os-query-response")).toContainText("Browser product");
    // Use the existing dirty-form navigation guard.
    await page.getByRole("link", { name: "Back to domain" }).click();
    if (await page.getByRole("dialog").isVisible()) await page.getByRole("button", { name: /discard|leave/i }).click();
    await page.getByRole("link", { name: "Edit configuration" }).click();
    await page.getByLabel("Explicit index names in multi-document requests").selectOption("false");
    await page.getByRole("button", { name: "Run dry run" }).click();
    await expect(page.locator("#os-dry-run-result")).toContainText("no configuration was changed");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("button", { name: "Edit tags" }).click();
    await page.getByRole("dialog").getByLabel("Tags (JSON object)").fill('{"owner":"browser"}');
    await page.getByRole("button", { name: "Save tags" }).click();
    await expect(page.getByRole("cell", { name: "browser", exact: true })).toBeVisible();
    if (viewport.width > 600) {
      await page.getByRole("combobox", { name: "Search services and resources" }).fill("browser-search");
      await expect(page.locator("#global-search-results")).toContainText("OpenSearch domain");
      await page.getByRole("combobox", { name: "Search services and resources" }).press("Escape");
    }
    await expect(page.locator("#toast-region")).toBeEmpty();
    await page.screenshot({ path: test.info().outputPath(`domain-${viewport.width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Delete domain", exact: true }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("browser-search");
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Domains", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No domains", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}


test("domain rejection preserves the form; failed query and denied list show errors without empty success", async ({ page }) => {
  await sim.opensearch.execute("CreateDomain", { DomainName: "existing-domain" }, "eu-west-1");
  await expect.poll(() => sim.opensearch.domain("eu-west-1", "existing-domain").state).toBe("active");
  for (const path of ['vpc-endpoints', 'domains/existing-domain/upgrade', 'applications/removed-app/migrations', 'ingestion/endpoints', 'serverless/vpc-endpoints', 'serverless/policies/saml/create']) {
    await page.goto(`http://127.0.0.1:${sim.port}/_stacksim/console#/opensearch/${path}`);
    await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible();
    await expect(page.getByText('Feature availability', { exact: true })).toHaveCount(0);
  }
  await page.goto(`http://127.0.0.1:${sim.port}/_stacksim/console#/opensearch/domains/create`);
  await page.getByLabel("Domain name", { exact: true }).fill("existing-domain");
  await page.getByRole("button", { name: "Create domain", exact: true }).click();
  await expect(page.locator("#os-domain-form [role=alert]")).toContainText("already exists");
  await expect(page.getByLabel("Domain name", { exact: true })).toHaveValue("existing-domain");
  expect(sim.opensearch.domains("eu-west-1")).toHaveLength(1);
  await page.goto(`http://127.0.0.1:${sim.port}/_stacksim/console#/opensearch/domains/existing-domain/local-query`);
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await page.getByLabel("HTTP method").selectOption("POST");
  await page.getByLabel("Request body (JSON or NDJSON)").fill('{"query":{"script":{}}}');
  await page.getByRole("button", { name: "Run request", exact: true }).click();
  await expect(page.locator("#os-query-status")).toHaveText("Request failed");
  await expect(page.locator("#os-query-response")).toContainText("not implemented");
  await page.getByRole("button", { name: "List indexes", exact: true }).click();
  await expect(page.locator("#os-query-response")).toHaveText("[]");
  await page.getByLabel("HTTP method").selectOption("DELETE");
  await page.getByRole("button", { name: "Run request", exact: true }).click();
  await expect(page.locator("#os-query-form [role=alert]")).toContainText("Confirm the destructive operation");
  await page.route("**/2021-01-01/domain", route => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "List denied for this principal" }) }));
  await page.goto(`http://127.0.0.1:${sim.port}/_stacksim/console#/opensearch/domains`);
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByText("List denied for this principal", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No domains", exact: true })).toHaveCount(0);
});


test("failed domain cleanup remains visible and can be retried from the console", async ({ page }) => {
  await sim.opensearch.execute("CreateDomain", { DomainName: "retry-delete" }, "eu-west-1");
  await expect.poll(() => sim.opensearch.domain("eu-west-1", "retry-delete").state).toBe("active");
  const save = sim.store.save.bind(sim.store); let fail = true;
  sim.store.save = async () => { if (fail && !sim.opensearch.domains("eu-west-1").length) { fail = false; throw new Error("Injected deletion commit failure"); } await save(); };
  await sim.opensearch.execute("DeleteDomain", { DomainName: "retry-delete" }, "eu-west-1");
  await expect.poll(() => Boolean(sim.opensearch.domains("eu-west-1")[0]?.failure)).toBe(true);
  sim.store.save = save;
  await page.goto(`http://127.0.0.1:${sim.port}/_stacksim/console#/opensearch/domains/retry-delete`);
  await expect(page.getByRole("button", { name: "Retry deletion", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Retry deletion", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("retry-delete");
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No domains", exact: true })).toBeVisible();
});
