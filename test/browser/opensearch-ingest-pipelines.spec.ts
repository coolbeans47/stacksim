import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { StackSim } from "../../src/server.js";

for (const width of [1440, 390]) test(`Ingest pipeline editor, simulation, index settings and deletion at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "stacksim-ingest-ui-")), region = "eu-west-1", sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false }); let search: Client | undefined;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "browser-ingest" }, region);
    for (let i = 0; i < 200 && sim.opensearch.domain(region, "browser-ingest").state !== "active"; i++) await delay(10);
    const domain = sim.opensearch.domain(region, "browser-ingest"); search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: "admin", secretAccessKey: "password" }) }) }); await search.indices.create({ index: "products" });
    await page.setViewportSize({ width, height: 900 }); const base = `http://127.0.0.1:${sim.port}/_stacksim/console`;
    await page.goto(`${base}#/opensearch/domains/browser-ingest/ingest-pipelines`); await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" }); await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await expect(page.getByText("No saved ingest pipelines.", { exact: true })).toBeVisible();
    await page.getByLabel("Pipeline ID", { exact: true }).fill("normalize");
    await page.getByLabel("Pipeline definition (JSON)", { exact: true }).fill('{"processors":[{"script":{"source":"return true"}}]}');
    await page.getByRole("button", { name: "Save ingest pipeline", exact: true }).click(); await expect(page.locator('#os-ingest-editor [role="alert"]')).toContainText("not implemented");
    const definition = { processors: [{ lowercase: { field: "category" } }, { set: { field: "processed", value: true } }] };
    await page.getByLabel("Pipeline definition (JSON)", { exact: true }).fill(JSON.stringify(definition)); await page.getByRole("button", { name: "Simulate processors", exact: true }).click(); await expect(page.getByLabel("Simulation result", { exact: true })).toContainText('"category": "shoes"');
    expect((await search.ingest.getPipeline({})).body).toEqual({});
    await page.getByRole("button", { name: "Save ingest pipeline", exact: true }).click(); await expect(page.getByRole("button", { name: "Edit normalize", exact: true })).toBeVisible();
    await page.getByLabel("Index or pattern", { exact: true }).fill("products"); await page.getByLabel("Default pipeline", { exact: true }).fill("normalize"); await page.getByRole("button", { name: "Apply ingest settings", exact: true }).click(); await expect(page.locator("#os-ingest-applied")).toHaveText("Ingest settings applied.");
    await search.index({ index: "products", id: "one", body: { category: "SHOES" } }); expect((await search.get({ index: "products", id: "one" })).body._source).toEqual({ category: "shoes", processed: true });
    await page.getByRole("button", { name: "Edit normalize", exact: true }).click(); await page.getByLabel("Pipeline definition (JSON)", { exact: true }).fill(JSON.stringify({ ...definition, description: "Normalize categories" })); await page.getByRole("button", { name: "Save ingest pipeline", exact: true }).click(); await expect(page.getByText("Normalize categories · Version 2", { exact: true })).toBeVisible();
    expect((await search.ingest.getPipeline({ id: "normalize" })).body.normalize.version).toBe(2);
    await page.getByRole("heading", { name: "Ingest pipelines", exact: true }).scrollIntoViewIfNeeded(); await expect(page.locator("#toast-region")).toBeEmpty(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`ingest-pipelines-${width}.png`) });
    await page.getByRole("button", { name: "Delete normalize", exact: true }).click(); await page.getByRole("dialog").getByRole("textbox").fill("normalize"); await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(); await expect(page.getByText("No saved ingest pipelines.", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
    await search?.close();
    await sim.stop();
    await rm(root, { recursive: true, force: true });
  }
});
