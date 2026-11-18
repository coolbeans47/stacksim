import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as Logs from "@aws-sdk/client-cloudwatch-logs";
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { StackSim } from "../../src/server.js";

for (const width of [1440, 390]) test(`Ingestion blueprint, validation, delivery and lifecycle at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "stacksim-osis-browser-")), region = "eu-west-1", sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: "enforce", cdkBootstrap: false });
  let iam: IAMClient | undefined; const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); iam = new IAMClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
    await sim.opensearch.execute("CreateDomain", { DomainName: "browser-ingestion-sink" }, region);
    for (let i = 0; i < 200 && sim.opensearch.domain(region, "browser-ingestion-sink").state !== "active"; i++) await delay(10);
    const domain = sim.opensearch.domain(region, "browser-ingestion-sink"), role = (await iam.send(new CreateRoleCommand({ RoleName: "BrowserPipeline", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "osis-pipelines.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }))).Role!;
    await iam.send(new PutRolePolicyCommand({ RoleName: "BrowserPipeline", PolicyName: "sink", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "es:DescribeDomain", Resource: domain.arn }, { Effect: "Allow", Action: "es:ESHttpPut", Resource: `${domain.arn}/logs/*` }] }) }));
    const group = "/aws/vendedlogs/OpenSearchIngestion/browser", logs = new Logs.CloudWatchLogsClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
    try { await logs.send(new Logs.CreateLogGroupCommand({ logGroupName: group })); await logs.send(new Logs.PutResourcePolicyCommand({ policyName: "browser-pipeline", policyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "delivery.logs.amazonaws.com" }, Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: `arn:aws:logs:${region}:${sim.store.accountId}:log-group:${group}:*` }] }) })); } finally { logs.destroy(); }
    await page.setViewportSize({ width, height: 900 }); const base = `http://127.0.0.1:${sim.port}/_stacksim/console`;
    await page.goto(`${base}#/opensearch/ingestion/pipelines`); await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" }); await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await page.goto(`${base}#/opensearch/ingestion/pipelines/create`);
    await page.getByRole("button", { name: "Use HTTP blueprint", exact: true }).click(); await expect(page.getByLabel("Pipeline YAML or JSON", { exact: true })).toHaveValue(/sts_role_arn/);
    await page.getByLabel("Pipeline name", { exact: true }).fill("browser-pipeline");
    await page.getByLabel("Pipeline YAML or JSON", { exact: true }).fill('version: "3"'); await page.getByRole("button", { name: "Validate configuration", exact: true }).click(); await expect(page.locator("#osis-validation")).toContainText('version: "2"');
    const configuration = JSON.stringify({ version: "2", logs: { source: { http: { path: "/logs/ingest" } }, processor: [{ add_entries: { entries: [{ key: "origin", value: "browser" }] } }], sink: [{ opensearch: { hosts: [`https://127.0.0.1:${domain.gatewayPort}`], aws: { region, sts_role_arn: role.Arn }, index: "logs", document_id: "${/id}" } }] } });
    await page.getByLabel("Pipeline YAML or JSON", { exact: true }).fill(configuration); await page.getByRole("button", { name: "Validate configuration", exact: true }).click(); await expect(page.locator("#osis-validation")).toContainText("Configuration is valid");
    await page.getByLabel("Publish pipeline logs", { exact: true }).check(); await page.getByLabel("Pipeline log group", { exact: true }).fill(group);
    await page.getByRole("button", { name: "Create pipeline", exact: true }).click(); await expect(page.getByRole("heading", { name: "browser-pipeline", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Send events", exact: true })).toBeEnabled();
    await expect(page.getByRole("link", { name: "View pipeline logs", exact: true })).toHaveAttribute("href", `#/cloudwatch/log-groups/${encodeURIComponent(group)}`);
    await page.getByLabel("Events (JSON array)", { exact: true }).fill('[{"id":"one","message":"Browser ingestion event"}]'); await page.getByRole("button", { name: "Send events", exact: true }).click(); await expect(page.locator("#osis-send-result")).toContainText("1 events accepted");
    await expect.poll(() => (sim.opensearch.ingestion as any).buffers.get(sim.opensearch.ingestion.pipeline(region, "browser-pipeline").generation).stats().delivered).toBe(1);
    await page.getByRole("button", { name: "Refresh", exact: true }).click(); await expect(page.getByText(/1 accepted · 1 delivered/)).toBeVisible();
    await page.getByLabel("Publish pipeline logs", { exact: true }).uncheck();
    await page.getByLabel("Maximum capacity", { exact: true }).fill("3"); await page.getByLabel("Tags (JSON object)", { exact: true }).fill('{"owner":"browser"}'); await page.getByRole("button", { name: "Save pipeline", exact: true }).click(); await expect(page.getByRole("button", { name: "Send events", exact: true })).toBeEnabled(); await expect(page.getByLabel("Maximum capacity", { exact: true })).toHaveValue("3");
    await expect.poll(() => sim.opensearch.ingestion.pipeline(region, "browser-pipeline").logPublishingOptions?.IsLoggingEnabled).toBe(false);
    await expect(page.getByRole("button", { name: "Save pipeline", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Stop pipeline", exact: true }).click(); await expect(page.getByRole("button", { name: "Start pipeline", exact: true })).toBeEnabled(); await expect(page.getByRole("button", { name: "Send events", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Start pipeline", exact: true }).click(); await expect(page.getByRole("button", { name: "Send events", exact: true })).toBeEnabled();
    await expect(page.locator("#toast-region")).toBeEmpty(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`ingestion-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Delete pipeline", exact: true }).click(); await page.getByRole("dialog").getByRole("textbox").fill("browser-pipeline"); await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Refresh", exact: true }).click(); await expect(page.getByRole("heading", { name: "No ingestion pipelines", exact: true })).toBeVisible(); expect(errors).toEqual([]);
  } finally { await page.context().close(); iam?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
