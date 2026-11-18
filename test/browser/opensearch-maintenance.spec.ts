import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StackSim } from "../../src/server.js";

for (const width of [1440, 390]) test(`Embedded search restart and node maintenance at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "stacksim-maintenance-ui-")), region = "eu-west-1", sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "browser-maintenance", EncryptionAtRestOptions: { Enabled: true } }, region);
    for (let i = 0; i < 200 && sim.opensearch.domain(region, "browser-maintenance").state !== "active"; i++) await delay(10);
    const domain = sim.opensearch.domain(region, "browser-maintenance"); await (sim.opensearch as any).engine(domain).request("PUT", "/records/_doc/one", Buffer.from('{"value":"preserved"}'), "seed");
    await page.setViewportSize({ width, height: 900 }); await page.goto(`http://127.0.0.1:${sim.port}/_stacksim/console#/opensearch/domains/browser-maintenance`);
    await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" }); await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await page.getByRole("link", { name: "Maintain domain", exact: true }).click(); await expect(page.getByRole("heading", { name: "Domain maintenance", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Restart search", exact: true }).click(); await expect(page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Search restart", exact: true }) })).toContainText("COMPLETED");
    await page.getByRole("button", { name: "Reboot embedded node", exact: true }).click(); await expect(page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Node reboot", exact: true }) })).toContainText("COMPLETED");
    expect((await (sim.opensearch as any).engine(domain).request("GET", "/records/_doc/one", Buffer.alloc(0), "verify")).body._source.value).toBe("preserved");
    await expect(page.locator("#toast-region")).toBeEmpty(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`maintenance-${width}.png`) });
    await page.getByRole("heading", { name: "Maintenance history", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: test.info().outputPath(`maintenance-history-${width}.png`) }); expect(errors).toEqual([]);
  } finally { await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
