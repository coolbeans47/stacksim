import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { AssociateDatasetKmsKeyCommand, CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-cw08d-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
const credentials = { accessKeyId: "admin", secretAccessKey: "password" }; let browser; let cloudwatch;

try {
  await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; cloudwatch = new CloudWatchClient({ endpoint, region: "eu-west-1", credentials }); const now = Math.floor(Date.now() / 60_000) * 60_000; const dimensions = (service, host) => [{ Name: "Service", Value: service }, { Name: "Host", Value: host }];
  await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/Orders", MetricData: [
    { MetricName: "Requests", Dimensions: dimensions("checkout", "orders-api-a"), Timestamp: new Date(now - 15 * 60_000 + 5_000), Value: 18 }, { MetricName: "Requests", Dimensions: dimensions("checkout", "orders-api-a"), Timestamp: new Date(now - 10 * 60_000 + 5_000), Value: 24 }, { MetricName: "Requests", Dimensions: dimensions("checkout", "orders-api-a"), Timestamp: new Date(now - 5 * 60_000 + 5_000), Value: 31 },
    { MetricName: "Requests", Dimensions: dimensions("checkout", "orders-api-b"), Timestamp: new Date(now - 15 * 60_000 + 5_000), Value: 12 }, { MetricName: "Requests", Dimensions: dimensions("checkout", "orders-api-b"), Timestamp: new Date(now - 10 * 60_000 + 5_000), Value: 20 }, { MetricName: "Requests", Dimensions: dimensions("checkout", "orders-api-b"), Timestamp: new Date(now - 5 * 60_000 + 5_000), Value: 28 },
    { MetricName: "Requests", Dimensions: dimensions("payments", "orders-api-c"), Timestamp: new Date(now - 15 * 60_000 + 5_000), Value: 9 }, { MetricName: "Requests", Dimensions: dimensions("payments", "orders-api-c"), Timestamp: new Date(now - 10 * 60_000 + 5_000), Value: 16 }, { MetricName: "Requests", Dimensions: dimensions("payments", "orders-api-c"), Timestamp: new Date(now - 5 * 60_000 + 5_000), Value: 19 },
  ] }));
  await cloudwatch.send(new AssociateDatasetKmsKeyCommand({ DatasetIdentifier: "default", KmsKeyArn: "arn:aws:kms:eu-west-1:000000000000:key/12345678-abcd-1234-abcd-1234567890ab" }));
  const prepare = async page => { await page.getByLabel("Namespace").fill("Learning/Orders"); await page.getByLabel("Metric name").fill("Requests"); await page.getByLabel("Aggregate").selectOption("SUM"); await page.getByLabel("Group by").fill("Host"); await page.getByLabel("Limit").fill("3"); await page.getByRole("button", { name: "Update SQL" }).click(); };
  const run = async page => { await prepare(page); await page.getByRole("button", { name: "Run query" }).click(); await page.locator("#mi-status").filter({ hasText: "Complete · 3 series" }).waitFor(); };
  const pages = [
    { output: "query-editor", wait: async page => { await page.getByRole("heading", { name: "Query editor" }).waitFor(); await prepare(page); } },
    { output: "query-chart", wait: async page => { await run(page); await page.getByRole("heading", { name: "Query results" }).scrollIntoViewIfNeeded(); } },
    { output: "query-table", wait: async page => { await run(page); await page.getByRole("button", { name: "Table" }).click(); await page.getByRole("cell", { name: "Metrics Insights (Host=orders-api-a)" }).waitFor(); } },
    { output: "query-source", wait: async page => { await run(page); await page.getByRole("button", { name: "Source" }).click(); await page.locator("#mi-source").waitFor(); } },
    { output: "dataset-settings", wait: async page => { await page.getByRole("button", { name: "Dataset settings" }).click(); await page.getByRole("dialog").getByText("KMS dependency unavailable", { exact: true }).waitFor(); } },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-17/cloudwatch/cw08d", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const page = await browser.newPage({ viewport: { width, height } }); const diagnostics = [];
      page.on("console", message => { if (["warning", "error"].includes(message.type())) diagnostics.push(`console ${message.type()}: ${message.text()}`); }); page.on("pageerror", error => diagnostics.push(`page error: ${error.message}`)); page.on("requestfailed", request => diagnostics.push(`request failed: ${request.method()} ${request.url()}`)); page.on("response", response => { if (response.status() >= 400) diagnostics.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`); });
      await page.goto(`${endpoint}/_stacksim/console#/cloudwatch/metrics-insights`); await pageSpec.wait(page); await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || [...document.querySelectorAll("main")].some(element => element.scrollWidth > element.clientWidth)); if (overflow) throw new Error(`${pageSpec.output} overflows at ${width}x${height}`); if (diagnostics.length) throw new Error(`${pageSpec.output} diagnostics: ${diagnostics.join("; ")}`);
      await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close();
    }
  }
} finally { cloudwatch?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
