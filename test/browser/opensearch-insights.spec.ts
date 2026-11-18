import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StackSim } from "../../src/server.js";

for (const width of [1440, 390]) test(`Observed domain capacity insights, feedback and recovery at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "stacksim-insight-ui-")), region = "eu-west-1", sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false }), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "browser-insights" }, region); for (let i = 0; i < 200 && sim.opensearch.domain(region, "browser-insights").state !== "active"; i++) await delay(10);
    const domain = sim.opensearch.domain(region, "browser-insights"), engine = (sim.opensearch as any).engine(domain);
    await page.setViewportSize({ width, height: 900 }); await page.goto(`http://127.0.0.1:${sim.port}/_stacksim/console#/opensearch/domains/browser-insights`); await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click(); const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" }); await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await page.getByRole("link", { name: "View insights", exact: true }).click(); await expect(page.getByText("No retained insights in this time range.", { exact: true })).toBeVisible();
    for (let i = 0; i < 80; i++) await engine.request("PUT", `/records-${i}`, Buffer.from("{}"), "seed"); await page.getByRole("button", { name: "Refresh insights", exact: true }).click(); await expect(page.getByRole("cell", { name: "ACTIVE", exact: true })).toBeVisible(); await expect(page.getByRole("cell", { name: "Embedded index capacity is nearly full", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "View insight", exact: true }).click(); await expect(page.locator("#insight-fields")).toContainText('"value":80'); await page.getByLabel("Was this insight useful?", { exact: true }).selectOption("Up"); await page.getByLabel("Feedback", { exact: true }).fill("I will remove unused indexes."); await page.getByRole("button", { name: "Save feedback", exact: true }).click(); await expect(page.locator("#insight-feedback-status")).toHaveText("Feedback saved."); expect(domain.insights![0].feedback!.text).toBe("I will remove unused indexes."); expect(domain.insights![0].state).toBe("ACTIVE");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.getByRole("heading", { name: "Insight details", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: test.info().outputPath(`insight-details-${width}.png`) });
    await engine.request("DELETE", "/records-0", Buffer.alloc(0), "seed"); await page.getByRole("button", { name: "Refresh insights", exact: true }).click(); await expect(page.getByRole("cell", { name: "RESOLVED", exact: true })).toBeVisible(); await page.getByLabel("Sort", { exact: true }).selectOption("ASC"); await page.getByLabel("Time range", { exact: true }).selectOption("86400000"); await expect(page.getByRole("cell", { name: "RESOLVED", exact: true })).toBeVisible(); await page.getByRole("button", { name: "View insight", exact: true }).click(); await expect(page.getByLabel("Feedback", { exact: true })).toHaveValue("I will remove unused indexes.");
    await page.getByRole("heading", { name: "Domain insights", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: test.info().outputPath(`insights-${width}.png`) }); expect(errors).toEqual([]);
  } finally { await page.context().close(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
