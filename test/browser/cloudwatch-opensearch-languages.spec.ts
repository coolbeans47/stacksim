import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Logs from "@aws-sdk/client-cloudwatch-logs";
import { StackSim } from "../../src/server.js";

for (const width of [1440, 390]) test(`CloudWatch SQL/PPL queries, saved definitions and history at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "stacksim-logs-languages-ui-")), region = "eu-west-1", sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false });
  let client: Logs.CloudWatchLogsClient | undefined; const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); client = new Logs.CloudWatchLogsClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
    const group = "/browser/Orders";
    await client.send(new Logs.CreateLogGroupCommand({ logGroupName: group })); await client.send(new Logs.CreateLogStreamCommand({ logGroupName: group, logStreamName: "events" }));
    await client.send(new Logs.PutLogEventsCommand({ logGroupName: group, logStreamName: "events", logEvents: [{ timestamp: Date.now(), message: '{"level":"error","duration":8}' }, { timestamp: Date.now(), message: '{"level":"info","duration":3}' }] }));
    await page.setViewportSize({ width, height: 900 }); await page.goto(`http://127.0.0.1:${sim.port}/_stacksim/console#/cloudwatch/logs-insights`);
    await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" }); await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click(); await expect(onboarding).not.toBeVisible();
    const language = page.getByLabel("Query language", { exact: true }), editor = page.locator("#insights-editor"), run = page.getByRole("button", { name: "Run query", exact: true });
    await language.selectOption("SQL"); await expect(run).toBeEnabled(); await editor.fill(`SELECT level, duration FROM \`${group}\` ORDER BY duration DESC`); await run.click();
    await expect(page.locator("#insights-status")).toContainText("Complete"); await expect(page.locator(".insights-results-table")).toContainText("error");
    await page.getByRole("button", { name: "Save query", exact: true }).click(); let dialog = page.getByRole("dialog"); await dialog.locator('[name="name"]').fill("Orders SQL"); await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect(dialog).not.toBeVisible();
    const saved = page.locator(".insights-saved-table tr", { hasText: "Orders SQL" }); await saved.getByRole("button", { name: "Load", exact: true }).click(); await expect(language).toHaveValue("SQL"); await run.click(); await expect(page.locator("#insights-status")).toContainText("Complete");
    await editor.fill(`SELECT COUNT(*) AS events FROM \`${group}\``); await page.getByRole("button", { name: "Update saved query", exact: true }).click(); dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "Update", exact: true }).click(); await expect(dialog).not.toBeVisible();
    const definitions = (await client.send(new Logs.DescribeQueryDefinitionsCommand({}))).queryDefinitions!; expect(definitions).toHaveLength(1); expect(definitions[0].queryLanguage).toBe("SQL"); expect(definitions[0].queryString).toContain("COUNT(*)");
    await language.selectOption("PPL"); await page.getByLabel("Log groups", { exact: true }).selectOption(group); await editor.fill("where duration >= 3 | stats sum(duration) as total"); await run.click(); await expect(page.locator("#insights-status")).toContainText("Complete"); await expect(page.locator(".insights-results-table")).toContainText("11");
    await editor.fill(`source = \`${group}\` | unsupported-command`); await run.click(); await expect(page.locator("#insights-status")).toContainText("Unsupported PPL command");
    await page.getByLabel("Sample query", { exact: true }).selectOption("aggregate"); await run.click(); await expect(page.locator("#insights-status")).toContainText("Complete"); await expect(page.locator(".insights-results-table")).toContainText("events");
    await page.getByRole("heading", { name: "Logs Insights", exact: true }).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`logs-languages-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  } finally { client?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
