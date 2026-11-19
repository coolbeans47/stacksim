import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { StackSim } from "../../src/server.js";

for (const width of [1440, 390]) test(`Hybrid search pipeline editor, defaults, queries and deletion at ${width}px`, async ({ page }) => {
  test.setTimeout(60000); const root = await mkdtemp(join(tmpdir(), "stacksim-hybrid-ui-")), region = "eu-west-1", sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false }); let client: Client | undefined;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "browser-hybrid" }, region); for (let i = 0; i < 200 && sim.opensearch.domain(region, "browser-hybrid").state !== "active"; i++) await delay(10);
    client = new Client({ node: `https://127.0.0.1:${sim.opensearch.domain(region, "browser-hybrid").gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: "admin", secretAccessKey: "password" }) }) });
    await client.index({ index: "products", id: "shoes", body: { title: "Red shoes" }, refresh: true }); await client.index({ index: "products", id: "hat", body: { title: "Hat" }, refresh: true });
    await page.setViewportSize({ width, height: 900 }); const base = `http://127.0.0.1:${sim.port}/_stacksim/console`;
    await page.goto(`${base}#/opensearch/domains/browser-hybrid`); await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" }); await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await page.getByRole("link", { name: "Search pipelines", exact: true }).click(); await expect(page.getByText("No saved search pipelines.", { exact: true })).toBeVisible();
    const definition = page.getByLabel("Search pipeline definition (JSON)", { exact: true }), original = await definition.inputValue();
    await page.getByLabel("Pipeline ID", { exact: true }).fill("blend"); await definition.fill('{"request_processors":[{"script":{"source":"code"}}]}'); await page.getByRole("button", { name: "Save search pipeline", exact: true }).click(); await expect(page.locator('#os-search-pipeline-editor [role="alert"]')).toContainText("not supported");
    await definition.fill(original); await page.getByRole("button", { name: "Test hybrid query", exact: true }).click(); await expect(page.getByLabel("Hybrid search result", { exact: true })).toContainText('"_id": "shoes"'); expect((await client.searchPipeline.get({})).body).toEqual({});
    await page.getByRole("button", { name: "Save search pipeline", exact: true }).click(); await expect(page.getByRole("button", { name: "Edit blend", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit blend", exact: true }).click(); await definition.fill(JSON.stringify({ ...JSON.parse(original), description: "Blend product signals" })); await page.getByRole("button", { name: "Save search pipeline", exact: true }).click(); await expect(page.getByText("Blend product signals", { exact: true })).toBeVisible();
    await page.getByLabel("Default search pipeline", { exact: true }).fill("blend"); await page.getByRole("button", { name: "Apply default pipeline", exact: true }).click(); await expect(page.locator("#os-search-pipeline-status")).toHaveText("Default search pipeline applied");
    const body = { query: { hybrid: { queries: [{ match: { title: "shoes" } }, { match_all: {} }] } } }; const found = (await client.search({ index: "products", body: body as any })).body; expect(found.hits.hits.map(hit => hit._id)).toEqual(["shoes", "hat"]); expect(found.hits.hits.map(hit => hit._score)).toEqual([1, 0.5]);
    await page.getByRole("heading", { name: "Search pipelines", exact: true }).scrollIntoViewIfNeeded(); await expect(page.locator("#toast-region")).toBeEmpty(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`hybrid-${width}.png`) });
    await page.getByRole("button", { name: "Delete blend", exact: true }).click(); await page.getByRole("dialog").getByRole("textbox").fill("blend"); await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(); await expect(page.getByText("No saved search pipelines.", { exact: true })).toBeVisible();
    await expect(client.search({ index: "products", body: body as any })).rejects.toMatchObject({ statusCode: 404 }); await page.getByRole("button", { name: "Apply default pipeline", exact: true }).click(); await expect(page.locator("#os-search-pipeline-status")).toHaveText("Default search pipeline applied");
    expect((await client.search({ index: "products", body: { query: { match_all: {} } } })).body.hits.hits.length).toBe(2); expect(errors).toEqual([]);
  } finally {
    await page.context().close();
    await client?.close();
    await sim.stop();
    await rm(root, { recursive: true, force: true });
  }
});
