import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, GetQueryResultsCommand, PutLogEventsCommand, PutQueryDefinitionCommand, StartQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-cw03-capture-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" }); const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]]; let browser; let logs;
try {
  await simulator.start(); logs = new CloudWatchLogsClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } }); const now = Date.now();
  for (const group of ["/learning/checkout", "/learning/billing"]) { await logs.send(new CreateLogGroupCommand({ logGroupName: group })); await logs.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: "application" })); }
  await logs.send(new PutLogEventsCommand({ logGroupName: "/learning/checkout", logStreamName: "application", logEvents: [
    { timestamp: now - 4000, message: "status=ok duration=84 service=checkout" }, { timestamp: now - 3000, message: "status=error duration=240 service=checkout" }, { timestamp: now - 2000, message: "status=ok duration=112 service=checkout" },
  ] })); await logs.send(new PutLogEventsCommand({ logGroupName: "/learning/billing", logStreamName: "application", logEvents: [
    { timestamp: now - 3500, message: "status=ok duration=68 service=billing" }, { timestamp: now - 1500, message: "status=error duration=196 service=billing" },
  ] }));
  await logs.send(new PutQueryDefinitionCommand({ name: "Learning/Latency by service", queryString: "parse @message 'status=* duration=* service=*' as status, duration, service | stats count(*) as requests, avg(duration) as average, max(duration) as maximum by service | sort requests desc", logGroupNames: ["/learning/checkout", "/learning/billing"] }));
  const prior = await logs.send(new StartQueryCommand({ logGroupNames: ["/learning/checkout", "/learning/billing"], startTime: Math.floor((now - 3600000) / 1000), endTime: Math.floor(now / 1000), queryString: "fields @timestamp, @message | filter @message like /error/ | sort @timestamp desc" })); for (let attempt = 0; attempt < 20; attempt++) { if ((await logs.send(new GetQueryResultsCommand({ queryId: prior.queryId }))).status === "Complete") break; await new Promise(resolve => setTimeout(resolve, 20)); }
  const pages = [
    { output: "aggregate-results", prepare: async page => { await page.getByLabel("Log groups").selectOption(["/learning/checkout", "/learning/billing"]); await page.getByLabel("Sample query").selectOption("aggregate"); await page.getByRole("button", { name: "Run query" }).click(); await page.locator("#insights-status").getByText("Complete", { exact: true }).waitFor(); await page.locator("#insights-results-card").scrollIntoViewIfNeeded(); } },
    { output: "record-detail", prepare: async page => { await page.getByLabel("Sample query").selectOption("recent"); await page.getByRole("button", { name: "Run query" }).click(); await page.locator("#insights-status").getByText("Complete", { exact: true }).waitFor(); await page.getByRole("button", { name: "View record" }).first().click(); await page.getByRole("dialog").getByRole("heading", { name: "Log record" }).waitFor(); } },
    { output: "saved-history", prepare: async page => { await page.locator("#insights-saved").scrollIntoViewIfNeeded(); } },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
  for (const pageSpec of pages) { const output = resolve("docs/ui-reference/2026-07-16/cloudwatch/cw03", pageSpec.output, "final"); await mkdir(output, { recursive: true }); for (const [name, width, height] of viewports) { const page = await browser.newPage({ viewport: { width, height } }); await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console#/cloudwatch/logs-insights`); await page.getByRole("heading", { name: "Logs Insights", exact: true }).waitFor(); await pageSpec.prepare(page); await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)))); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close(); } }
} finally { logs?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
