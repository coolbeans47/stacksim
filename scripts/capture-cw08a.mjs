import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CloudWatchClient, PutCompositeAlarmCommand, PutMetricAlarmCommand, SetAlarmStateCommand } from "@aws-sdk/client-cloudwatch";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-cw08a-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
const credentials = { accessKeyId: "admin", secretAccessKey: "password" }; let browser; let cloudwatch;

async function metricAlarm(AlarmName, MetricName) {
  await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName, AlarmDescription: `${AlarmName} learning fixture`, Namespace: "Learning/Checkout", MetricName, Period: 60, Statistic: "Sum", EvaluationPeriods: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "missing" }));
}

try {
  await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; cloudwatch = new CloudWatchClient({ endpoint, region: "eu-west-1", credentials });
  await metricAlarm("checkout-api-unhealthy", "ApiFailures"); await metricAlarm("checkout-database-unhealthy", "DatabaseFailures"); await metricAlarm("checkout-maintenance", "MaintenanceWindow");
  await cloudwatch.send(new SetAlarmStateCommand({ AlarmName: "checkout-api-unhealthy", StateValue: "ALARM", StateReason: "Checkout API error rate is above the learning threshold" })); await cloudwatch.send(new SetAlarmStateCommand({ AlarmName: "checkout-database-unhealthy", StateValue: "OK", StateReason: "Database health checks are passing" })); await cloudwatch.send(new SetAlarmStateCommand({ AlarmName: "checkout-maintenance", StateValue: "OK", StateReason: "No maintenance window is active" }));
  await cloudwatch.send(new PutCompositeAlarmCommand({ AlarmName: "checkout-service-unhealthy", AlarmDescription: "Page when either checkout dependency is unhealthy outside maintenance.", AlarmRule: 'ALARM("checkout-api-unhealthy") OR ALARM("checkout-database-unhealthy")', AlarmActions: ["arn:aws:sns:eu-west-1:000000000000:checkout-operations"], ActionsSuppressor: "checkout-maintenance", ActionsSuppressorWaitPeriod: 3600, ActionsSuppressorExtensionPeriod: 60, Tags: [{ Key: "team", Value: "payments" }, { Key: "environment", Value: "learning" }] }));
  await cloudwatch.send(new PutCompositeAlarmCommand({ AlarmName: "page-checkout-operations", AlarmDescription: "Top-level checkout page signal.", AlarmRule: 'ALARM("checkout-service-unhealthy")' }));

  const pages = [
    { output: "catalog", route: "/cloudwatch/alarms", wait: page => page.getByRole("link", { name: "checkout-service-unhealthy" }).waitFor() },
    { output: "create", route: "/cloudwatch/alarms", wait: async page => { await page.getByRole("button", { name: "Create composite alarm" }).first().click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Alarm rule").fill('ALARM("checkout-api-unhealthy") AND NOT ALARM("checkout-maintenance")'); await dialog.getByLabel("Suppressor alarm (optional)").selectOption("checkout-maintenance"); await dialog.getByLabel("Action ARN (optional)").fill("arn:aws:sns:eu-west-1:000000000000:checkout-operations"); await dialog.getByLabel("Alarm name").fill("checkout-customer-impact"); await dialog.getByRole("heading", { name: "Combine alarm states" }).waitFor(); await dialog.locator(".modal-body").evaluate(element => { element.scrollTop = 0; }); } },
    { output: "detail", route: "/cloudwatch/alarms/checkout-service-unhealthy", wait: page => page.getByRole("heading", { name: "Child alarms (2)" }).waitFor() },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-17/cloudwatch/cw08a", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const page = await browser.newPage({ viewport: { width, height } }); const diagnostics = [];
      page.on("console", message => { if (["warning", "error"].includes(message.type())) diagnostics.push(`console ${message.type()}: ${message.text()}`); }); page.on("pageerror", error => diagnostics.push(`page error: ${error.message}`));
      await page.goto(`${endpoint}/_stacksim/console#${pageSpec.route}`); await pageSpec.wait(page); await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || [...document.querySelectorAll("main")].some(element => element.scrollWidth > element.clientWidth)); if (overflow) throw new Error(`${pageSpec.output} overflows at ${width}x${height}`); if (diagnostics.length) throw new Error(`${pageSpec.output} diagnostics: ${diagnostics.join("; ")}`);
      await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close();
    }
  }
} finally { cloudwatch?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
