import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as Logs from "@aws-sdk/client-cloudwatch-logs";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { StackSim } from "../../src/server.js";

for (const width of [1440, 390]) test(`Measured domain charts, log publishing and thresholds at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "stacksim-monitoring-ui-")), region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" }, sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false });
  let logs: Logs.CloudWatchLogsClient | undefined, search: Client | undefined; const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); logs = new Logs.CloudWatchLogsClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials });
    await sim.opensearch.execute("CreateDomain", { DomainName: "browser-monitoring", EncryptionAtRestOptions: { Enabled: true } }, region);
    for (let i = 0; i < 200 && sim.opensearch.domain(region, "browser-monitoring").state !== "active"; i++) await delay(10);
    const domain = sim.opensearch.domain(region, "browser-monitoring"), group = "/aws/opensearch/browser", groupArn = `arn:aws:logs:${region}:${sim.store.accountId}:log-group:${group}`;
    await logs.send(new Logs.CreateLogGroupCommand({ logGroupName: group })); await logs.send(new Logs.PutResourcePolicyCommand({ policyName: "search-browser", policyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "es.amazonaws.com" }, Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: `${groupArn}:*`, Condition: { ArnEquals: { "aws:SourceArn": domain.arn } } }] }) }));
    search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
    await search.index({ index: "products", id: "one", refresh: true, body: { title: "Measured browser search" } });
    await page.setViewportSize({ width, height: 900 }); await page.goto(`http://127.0.0.1:${sim.port}/_stacksim/console#/opensearch/domains/browser-monitoring`);
    await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" }); await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await page.getByRole("link", { name: "Monitoring and logs", exact: true }).click(); await expect(page.getByRole("img", { name: "Searchable documents", exact: true }).locator("svg")).toBeVisible();
    await page.getByLabel("Time range", { exact: true }).selectOption("10800000"); await page.getByLabel("Metric period", { exact: true }).selectOption("300"); await page.getByRole("button", { name: "Refresh metrics", exact: true }).click(); await expect(page.locator("#os-metric-error")).toBeHidden();
    await page.getByLabel("Search slow logs", { exact: true }).check(); await page.getByLabel("Search slow logs group ARN", { exact: true }).fill(groupArn + "-missing"); await page.getByRole("button", { name: "Save log publishing", exact: true }).click(); await expect(page.locator("#os-log-error")).toContainText("must exist");
    await page.getByLabel("Search slow logs group ARN", { exact: true }).fill(groupArn); await page.getByRole("button", { name: "Save log publishing", exact: true }).click(); await expect.poll(() => domain.config.LogPublishingOptions.SEARCH_SLOW_LOGS?.Enabled).toBe(true);
    await page.getByLabel("Index or pattern", { exact: true }).fill("products"); await page.getByLabel("Search warning threshold", { exact: true }).fill("0ms"); await page.getByRole("button", { name: "Save thresholds", exact: true }).click(); await expect.poll(() => (sim.opensearch as any).engine(domain).indexes()[0].settings["search.slowlog.threshold.query.warn"]).toBe("0ms");
    await search.search({ index: "products", body: { query: { match_all: {} } } }); await expect.poll(async () => (await logs!.send(new Logs.FilterLogEventsCommand({ logGroupName: group }))).events?.length).toBe(1);
    await expect(page.locator("#toast-region")).toBeEmpty(); await page.getByRole("heading", { name: "Domain metrics", exact: true }).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`monitoring-${width}.png`) });
    await page.getByRole("heading", { name: "Log publishing", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: test.info().outputPath(`log-publishing-${width}.png`) }); expect(errors).toEqual([]);
  } finally { await search?.close(); logs?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
