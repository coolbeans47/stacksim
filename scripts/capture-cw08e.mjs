import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { CloudWatchClient, PutMetricDataCommand, PutMetricStreamCommand, StopMetricStreamsCommand } from "@aws-sdk/client-cloudwatch";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-cw08e-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", allowLocalFiles: true });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
const credentials = { accessKeyId: "admin", secretAccessKey: "password" }; let browser; let cloudwatch;

try {
  await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; cloudwatch = new CloudWatchClient({ endpoint, region: "eu-west-1", credentials }); const localDirectory = join(root, "stream-output");
  await cloudwatch.send(new PutMetricStreamCommand({ Name: "orders-live-json", FirehoseArn: pathToFileURL(localDirectory).href, RoleArn: "arn:aws:iam::000000000000:role/metric-stream-delivery", OutputFormat: "json", IncludeFilters: [{ Namespace: "Learning/Orders", MetricNames: ["Latency", "Requests"] }], StatisticsConfigurations: [{ IncludeMetrics: [{ Namespace: "Learning/Orders", MetricName: "Latency" }], AdditionalStatistics: ["p90", "p99"] }], Tags: [{ Key: "environment", Value: "local" }, { Key: "owner", Value: "observability" }] }));
  await cloudwatch.send(new PutMetricStreamCommand({ Name: "platform-otel-archive", FirehoseArn: "arn:aws:firehose:eu-west-1:000000000000:deliverystream/platform-metrics", RoleArn: "arn:aws:iam::000000000000:role/platform-metric-stream", OutputFormat: "opentelemetry1.0", ExcludeFilters: [{ Namespace: "AWS/Usage" }], Tags: [{ Key: "environment", Value: "staging" }, { Key: "dependency", Value: "firehose" }] }));
  await cloudwatch.send(new StopMetricStreamsCommand({ Names: ["platform-otel-archive"] }));
  await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/Orders", MetricData: [{ MetricName: "Requests", Dimensions: [{ Name: "Service", Value: "checkout" }], Value: 42 }, { MetricName: "Latency", Dimensions: [{ Name: "Service", Value: "checkout" }], Values: [82, 109, 140], Counts: [4, 2, 1] }] }));
  const pages = [
    { output: "catalog", route: "#/cloudwatch/metric-streams", wait: async page => { await page.getByRole("link", { name: "orders-live-json" }).waitFor(); await page.getByRole("link", { name: "platform-otel-archive" }).waitFor(); } },
    { output: "create", route: "#/cloudwatch/metric-streams", wait: async page => { await page.getByRole("button", { name: "Create metric stream" }).first().click(); await page.getByRole("dialog").getByRole("heading", { name: "Create metric stream" }).waitFor(); } },
    { output: "detail-local-running", route: "#/cloudwatch/metric-streams/orders-live-json", wait: async page => { await page.getByText("Opted-in local JSON delivery", { exact: true }).waitFor(); await page.getByText("running", { exact: true }).waitFor(); } },
    { output: "detail-external-stopped", route: "#/cloudwatch/metric-streams/platform-otel-archive", wait: async page => { await page.getByText("Delivery dependency unavailable", { exact: true }).waitFor(); await page.getByText("stopped", { exact: true }).waitFor(); } },
    { output: "edit", route: "#/cloudwatch/metric-streams/orders-live-json", wait: async page => { await page.getByRole("button", { name: "Edit", exact: true }).click(); await page.getByRole("dialog").getByRole("heading", { name: "Edit metric stream orders-live-json" }).waitFor(); } },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-17/cloudwatch/cw08e", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const page = await browser.newPage({ viewport: { width, height } }); const diagnostics = [];
      page.on("console", message => { if (["warning", "error"].includes(message.type())) diagnostics.push(`console ${message.type()}: ${message.text()}`); }); page.on("pageerror", error => diagnostics.push(`page error: ${error.message}`)); page.on("requestfailed", request => diagnostics.push(`request failed: ${request.method()} ${request.url()}`)); page.on("response", response => { if (response.status() >= 400) diagnostics.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`); });
      await page.goto(`${endpoint}/_stacksim/console${pageSpec.route}`); await pageSpec.wait(page); await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || [...document.querySelectorAll("main")].some(element => element.scrollWidth > element.clientWidth)); if (overflow) throw new Error(`${pageSpec.output} overflows at ${width}x${height}`); if (diagnostics.length) throw new Error(`${pageSpec.output} diagnostics: ${diagnostics.join("; ")}`);
      await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close();
    }
  }
} finally { cloudwatch?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
