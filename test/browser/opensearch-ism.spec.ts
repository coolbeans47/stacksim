import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { StackSim } from "../../src/server.js";
import { TestClock } from "../../src/core/clock.js";

for (const width of [1440, 390]) test(`ISM policy editor, scheduler, failures and removal at ${width}px`, async ({ page }) => {
  test.setTimeout(60000); const root = await mkdtemp(join(tmpdir(), "stacksim-ism-ui-")), region = "eu-west-1", clock = new TestClock(Date.now()), sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false, clock }); let client: Client | undefined;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "browser-ism" }, region); for (let i = 0; i < 200 && sim.opensearch.domain(region, "browser-ism").state !== "active"; i++) await delay(10);
    client = new Client({ node: `https://127.0.0.1:${sim.opensearch.domain(region, "browser-ism").gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: "admin", secretAccessKey: "password" }) }) });
    await client.index({ index: "events-000001", id: "one", body: { title: "Saved event" } });
    await page.setViewportSize({ width, height: 900 }); await page.goto(`http://127.0.0.1:${sim.port}/_stacksim/console#/opensearch/domains/browser-ism`); await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" }); await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await page.getByRole("link", { name: "Index state management", exact: true }).click(); await expect(page.getByText("No ISM policies.", { exact: true })).toBeVisible();
    const definition = page.getByLabel("Policy definition (JSON)", { exact: true }); await page.getByLabel("Policy ID", { exact: true }).fill("freeze");
    await definition.fill(JSON.stringify({ description: "Bad policy", default_state: "hot", states: [{ name: "hot", actions: [{ force_merge: {} }], transitions: [] }] })); await page.getByRole("button", { name: "Save policy", exact: true }).click(); await expect(page.locator('#os-ism-policy [role="alert"]')).toContainText("not supported");
    const policy = { description: "Freeze then reopen", default_state: "cold", states: [{ name: "cold", actions: [{ read_only: {} }], transitions: [] }, { name: "writable", actions: [{ read_write: {} }], transitions: [] }, { name: "broken-rollover", actions: [{ rollover: {} }], transitions: [] }] };
    await definition.fill(JSON.stringify(policy)); await page.getByRole("button", { name: "Save policy", exact: true }).click(); await expect(page.getByRole("button", { name: "Edit freeze", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Attach policy", exact: true }).click(); await expect(page.locator("#os-ism-status")).toHaveText("1 indexes updated"); clock.advance(5000);
    await expect(client.index({ index: "events-000001", id: "blocked", body: {} })).rejects.toMatchObject({ statusCode: 403 }); await page.getByRole("button", { name: "Explain indexes", exact: true }).click(); await expect(page.locator("#os-ism-states")).toContainText("read_only completed");
    await page.getByLabel("Starting state (optional)", { exact: true }).fill("writable"); await page.getByRole("button", { name: "Change policy", exact: true }).click(); await expect(page.locator("#os-ism-status")).toHaveText("1 indexes updated"); clock.advance(5000); await client.index({ index: "events-000001", id: "allowed", body: {} });
    await page.getByLabel("Starting state (optional)", { exact: true }).fill("broken-rollover"); await page.getByRole("button", { name: "Change policy", exact: true }).click(); await expect.poll(async () => (await client!.ism.explainPolicy({ index: "events-000001" })).body["events-000001"].change_policy?.state).toBe("broken-rollover"); clock.advance(5000); await page.getByRole("button", { name: "Explain indexes", exact: true }).click(); await expect(page.locator("#os-ism-states")).toContainText("(failed)");
    await page.getByLabel("Starting state (optional)", { exact: true }).fill("writable"); await page.getByRole("button", { name: "Retry failed indexes", exact: true }).click(); await expect(page.locator("#os-ism-status")).toHaveText("1 indexes updated"); clock.advance(5000); await page.getByRole("button", { name: "Explain indexes", exact: true }).click(); await expect(page.locator("#os-ism-states")).toContainText("read_write completed");
    await expect(page.locator("#toast-region")).toBeEmpty(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`ism-states-${width}.png`) });
    await page.getByRole("button", { name: "Remove policy", exact: true }).click(); await expect(page.locator("#os-ism-states")).toContainText("Unmanaged");
    await page.getByRole("button", { name: "Edit freeze", exact: true }).click(); await definition.fill(JSON.stringify({ ...policy, description: "Updated retention policy" })); await page.getByRole("button", { name: "Save policy", exact: true }).click(); await expect(page.getByText("Updated retention policy · Version 2", { exact: true })).toBeVisible();
    await page.getByRole("heading", { name: "Index state management", exact: true }).scrollIntoViewIfNeeded(); await expect(page.locator("#toast-region")).toBeEmpty(); await page.screenshot({ path: test.info().outputPath(`ism-${width}.png`) });
    await page.getByRole("button", { name: "Delete freeze", exact: true }).click(); await page.getByRole("dialog").getByRole("textbox").fill("freeze"); await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(); await expect(page.getByText("No ISM policies.", { exact: true })).toBeVisible(); expect(errors).toEqual([]);
  } finally { await page.context().close(); await test.step("Close OpenSearch SDK", async () => { await client?.close(); }); await test.step("Stop StackSim", () => sim.stop()); await rm(root, { recursive: true, force: true }); }
});
