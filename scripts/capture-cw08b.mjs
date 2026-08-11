import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CloudWatchClient, PutAnomalyDetectorCommand, PutMetricAlarmCommand, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-cw08b-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
const credentials = { accessKeyId: "admin", secretAccessKey: "password" }; let browser; let cloudwatch;

try {
  await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; cloudwatch = new CloudWatchClient({ endpoint, region: "eu-west-1", credentials }); const now = Math.floor(Date.now() / 60_000) * 60_000; const dimensions = [{ Name: "Route", Value: "/checkout" }];
  await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/Checkout", MetricData: Array.from({ length: 20 }, (_, index) => ({ MetricName: "CheckoutLatency", Dimensions: dimensions, Timestamp: new Date(now - (20 - index) * 60_000 + 5_000), Value: index === 19 ? 84 : 12 + (index % 3) })) }));
  const created = await cloudwatch.send(new PutAnomalyDetectorCommand({ SingleMetricAnomalyDetector: { Namespace: "Learning/Checkout", MetricName: "CheckoutLatency", Dimensions: dimensions, Stat: "Average" }, Configuration: { MetricTimezone: "Europe/London", ExcludedTimeRanges: [{ StartTime: new Date(now - 18 * 60_000), EndTime: new Date(now - 17 * 60_000) }] }, MetricCharacteristics: { PeriodicSpikes: false } }));
  const detector = simulator.store.regionState("eu-west-1").cloudwatch.anomalyDetectors; detector[Object.keys(detector)[0]].stateValue = "TRAINED"; await simulator.store.save();
  await cloudwatch.send(new PutMetricAlarmCommand({ AlarmName: "unexpected-checkout-latency", AlarmDescription: "Detect checkout latency outside the deterministic local expected-value band.", EvaluationPeriods: 1, DatapointsToAlarm: 1, ThresholdMetricId: "expected", ComparisonOperator: "GreaterThanUpperThreshold", TreatMissingData: "missing", Metrics: [{ Id: "m1", Label: "Checkout latency", ReturnData: true, MetricStat: { Metric: { Namespace: "Learning/Checkout", MetricName: "CheckoutLatency", Dimensions: dimensions }, Period: 60, Stat: "Average" } }, { Id: "expected", Expression: "ANOMALY_DETECTION_BAND(m1, 2)" }], Tags: [{ Key: "team", Value: "payments" }, { Key: "environment", Value: "learning" }] })); await simulator.metrics.evaluateAlarmsNow(now);

  const pages = [
    { output: "catalog", route: "/cloudwatch/anomaly-detection", wait: page => page.getByRole("link", { name: /Learning\/Checkout · CheckoutLatency/ }).waitFor() },
    { output: "create-detector", route: "/cloudwatch/anomaly-detection", wait: async page => { await page.getByRole("button", { name: "Create detector" }).first().click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Existing metric").selectOption({ label: "Learning/Checkout · CheckoutLatency · Route=/checkout" }); await dialog.getByLabel("Metric time zone").fill("Europe/London"); await dialog.getByLabel("Excluded time ranges (JSON)").fill('[{"StartTime":"2026-12-24T00:00:00Z","EndTime":"2026-12-26T00:00:00Z"}]'); await dialog.getByRole("heading", { name: "Create anomaly detector" }).waitFor(); await dialog.locator(".modal-body").evaluate(element => { element.scrollTop = 0; }); } },
    { output: "detector-detail", route: `/cloudwatch/anomaly-detection/${created.AnomalyDetectorId}`, wait: page => page.getByRole("heading", { name: "Expected-value preview" }).waitFor() },
    { output: "create-alarm", route: "/cloudwatch/alarms", wait: async page => { await page.getByRole("button", { name: "Create anomaly alarm" }).click(); const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "Next" }).click(); await dialog.getByLabel("Band width").fill("2.5"); await dialog.getByLabel("Alarm when value is").selectOption("GreaterThanUpperThreshold"); await dialog.getByRole("button", { name: "Next" }).click(); await dialog.getByLabel("Alarm name").fill("checkout-customer-impact"); await dialog.getByRole("heading", { name: "Metric and expected band" }).waitFor(); await dialog.locator(".modal-body").evaluate(element => { element.scrollTop = 0; }); } },
    { output: "alarm-detail", route: "/cloudwatch/alarms/unexpected-checkout-latency", wait: page => page.getByText("Expected band", { exact: true }).waitFor() },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-17/cloudwatch/cw08b", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const page = await browser.newPage({ viewport: { width, height } }); const diagnostics = [];
      page.on("console", message => { if (["warning", "error"].includes(message.type())) diagnostics.push(`console ${message.type()}: ${message.text()}`); }); page.on("pageerror", error => diagnostics.push(`page error: ${error.message}`));
      await page.goto(`${endpoint}/_stacksim/console#${pageSpec.route}`); await pageSpec.wait(page); await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || [...document.querySelectorAll("main")].some(element => element.scrollWidth > element.clientWidth)); if (overflow) throw new Error(`${pageSpec.output} overflows at ${width}x${height}`); if (diagnostics.length) throw new Error(`${pageSpec.output} diagnostics: ${diagnostics.join("; ")}`);
      await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close();
    }
  }
} finally { cloudwatch?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
