import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TestClock } from "../../src/core/clock.js";
import { StackSim } from "../../src/server.js";

for (const width of [1440, 390]) test(`Automatic encrypted snapshot status and restore at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "stacksim-auto-ui-")), region = "eu-west-1", clock = new TestClock(Date.now() - 3600000), sim = new StackSim({ dataDir: root, region, clock, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "browser-automatic", EncryptionAtRestOptions: { Enabled: true } }, region);
    for (let i = 0; i < 200 && sim.opensearch.domain(region, "browser-automatic").state !== "active"; i++) await delay(10);
    const domain = sim.opensearch.domain(region, "browser-automatic"), engine = (sim.opensearch as any).engine(domain); await engine.request("PUT", "/products/_doc/one", Buffer.from('{"title":"automatic-browser-document"}'), "seed");
    clock.advance(3600000); await (sim.opensearch as any).automaticBackups.drain(); expect(domain.automaticBackups!.items.length).toBe(1);
    await page.setViewportSize({ width, height: 900 }); await page.goto(`http://127.0.0.1:${sim.port}/_stacksim/console#/opensearch/domains/browser-automatic/snapshots`);
    await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click(); const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" }); await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await page.getByRole("link", { name: "cs-automated-enc", exact: true }).click(); await expect(page.getByRole("heading", { name: "Restore snapshot", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Delete snapshot", exact: true })).toBeDisabled(); await expect(page.getByRole("button", { name: "Unregister repository", exact: true })).toHaveCount(0); await expect(page.getByRole("heading", { name: "Create snapshot", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Verify repository", exact: true }).click(); await expect(page.locator("#toast-region")).toContainText("Repository verification succeeded"); await page.getByRole("button", { name: "Restore snapshot", exact: true }).click(); await expect(page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Restore", exact: true }) })).toContainText("SUCCESS"); expect((await engine.request("GET", "/restored-products/_doc/one", Buffer.alloc(0), "verify")).body._source.title).toBe("automatic-browser-document");
    await page.getByRole("heading", { name: "Automatic backup status", exact: true }).scrollIntoViewIfNeeded(); await expect(page.getByText(/1 retained snapshots/)).toBeVisible(); await expect(page.locator("#toast-region")).toBeEmpty(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`automatic-status-${width}.png`) });
    await page.getByRole("heading", { name: "cs-automated-enc", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: test.info().outputPath(`automatic-repository-${width}.png`) }); expect(errors).toEqual([]);
  } finally { await page.context().close(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
