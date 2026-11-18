import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as Logs from "@aws-sdk/client-cloudwatch-logs";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { StackSim } from "../../src/server.js";

for (const width of [1440, 390]) test(`Audit publishing, configuration, validation and real events at ${width}px`, async ({ page }) => {
  test.setTimeout(60000); const root = await mkdtemp(join(tmpdir(), "stacksim-audit-ui-")), region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" }, sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false }); let client: Client | undefined, logs: Logs.CloudWatchLogsClient | undefined;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); logs = new Logs.CloudWatchLogsClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials });
    await sim.opensearch.execute("CreateDomain", { DomainName: "browser-audit", EncryptionAtRestOptions: { Enabled: true }, NodeToNodeEncryptionOptions: { Enabled: true }, AdvancedSecurityOptions: { Enabled: true, MasterUserOptions: { MasterUserARN: `arn:aws:iam::${sim.store.accountId}:user/admin` } } }, region);
    for (let i = 0; i < 200 && sim.opensearch.domain(region, "browser-audit").state !== "active"; i++) await delay(10);
    const domain = sim.opensearch.domain(region, "browser-audit"), group = "/aws/opensearch/browser-audit", groupArn = `arn:aws:logs:${region}:${sim.store.accountId}:log-group:${group}`;
    await logs.send(new Logs.CreateLogGroupCommand({ logGroupName: group })); await logs.send(new Logs.PutResourcePolicyCommand({ policyName: "audit-browser", policyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "es.amazonaws.com" }, Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: `${groupArn}:*`, Condition: { ArnEquals: { "aws:SourceArn": domain.arn } } }] }) }));
    client = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) }); await client.index({ index: "products", id: "one", body: { title: "Private audit source" }, refresh: true });
    await page.setViewportSize({ width, height: 900 }); await page.goto(`http://127.0.0.1:${sim.port}/_stacksim/console#/opensearch/domains/browser-audit/monitoring`); await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" }); await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await page.getByLabel("Audit logs", { exact: true }).check(); await page.getByLabel("Audit logs group ARN", { exact: true }).fill(groupArn); await page.getByRole("button", { name: "Save log publishing", exact: true }).click(); await expect.poll(() => domain.config.LogPublishingOptions.AUDIT_LOGS?.Enabled).toBe(true);
    const editor = page.getByLabel("Audit event configuration (JSON)", { exact: true }), config = JSON.parse(await editor.inputValue()); config.enabled = true; config.audit.enable_transport = true;
    await editor.fill(JSON.stringify(config, null, 2)); await page.getByRole("button", { name: "Save audit capture", exact: true }).click(); await expect(page.locator("#os-log-error")).toContainText("enable_transport=true is not implemented");
    config.audit.enable_transport = false; config.audit.disabled_rest_categories = []; await editor.fill(JSON.stringify(config, null, 2)); await page.getByRole("button", { name: "Save audit capture", exact: true }).click(); await expect.poll(() => (sim.opensearch as any).engine(domain).security.auditConfig().enabled).toBe(true);
    await client.search({ index: "products", body: { query: { match_all: {} } } });
    await expect.poll(async () => (await logs!.send(new Logs.FilterLogEventsCommand({ logGroupName: group }))).events?.some(event => { const value = JSON.parse(event.message!); return value.audit_category === "GRANTED_PRIVILEGES" && value.audit_rest_request_path === "/products/_search"; })).toBe(true);
    const events = (await logs.send(new Logs.FilterLogEventsCommand({ logGroupName: group }))).events!; expect(JSON.stringify(events)).not.toContain("Private audit source");
    await page.getByRole("heading", { name: "Audit event capture", exact: true }).scrollIntoViewIfNeeded(); await expect(page.locator("#toast-region")).toBeEmpty(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`audit-${width}.png`) });
    config.enabled = false; await editor.fill(JSON.stringify(config)); await page.getByRole("button", { name: "Save audit capture", exact: true }).click(); await expect.poll(() => (sim.opensearch as any).engine(domain).security.auditConfig().enabled).toBe(false); const count = (await logs.send(new Logs.FilterLogEventsCommand({ logGroupName: group }))).events!.length; await client.search({ index: "products" }); expect((await logs.send(new Logs.FilterLogEventsCommand({ logGroupName: group }))).events!.length).toBe(count); expect(errors).toEqual([]);
  } finally { await client?.close(); logs?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
