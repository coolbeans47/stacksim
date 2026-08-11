import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  CloudWatchLogsClient,
  CreateExportTaskCommand,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  DescribeExportTasksCommand,
  PutLogEventsCommand,
  PutMetricFilterCommand,
  PutSubscriptionFilterCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { AddPermissionCommand, CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { StackSim } from "../dist/src/server.js";
import { createZip } from "../dist/src/core/zip-create.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-cw07-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", allowLocalFiles: true });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
const region = "eu-west-1"; const account = "000000000000"; const group = "/learning/checkout-delivery"; const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
let browser; const clients = [];

try {
  await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region, credentials }; const logs = new CloudWatchLogsClient(options); const lambda = new LambdaClient(options); clients.push(logs, lambda); const now = Date.now();
  await logs.send(new CreateLogGroupCommand({ logGroupName: group, tags: { Environment: "learning", Service: "checkout" } })); await logs.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: "application" }));
  await logs.send(new PutMetricFilterCommand({ logGroupName: group, filterName: "checkout-errors", filterPattern: '{ $.level = "error" }', metricTransformations: [{ metricNamespace: "Learning/Checkout", metricName: "ErrorValue", metricValue: "$.value", dimensions: { Route: "$.route" }, unit: "Count" }] }));
  await logs.send(new PutMetricFilterCommand({ logGroupName: group, filterName: "slow-requests", filterPattern: '[level, route, latency > 200]', metricTransformations: [{ metricNamespace: "Learning/Checkout", metricName: "SlowRequests", metricValue: "1", unit: "Count" }] }));
  const zip = createZip([{ name: "index.mjs", content: "export async function handler(event) { return { accepted: true, eventType: event.awslogs ? 'awslogs' : 'unknown' }; }" }]); const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "checkout-log-subscriber", Runtime: "nodejs22.x", Role: `arn:aws:iam::${account}:role/test`, Handler: "index.handler", Description: "Receives filtered checkout log batches", Code: { ZipFile: zip } })); await new Promise(resolveWait => setTimeout(resolveWait, 30));
  const sourceArn = `arn:aws:logs:${region}:${account}:log-group:${group}:*`; await lambda.send(new AddPermissionCommand({ FunctionName: fn.FunctionName, StatementId: "cloudwatch-logs", Action: "lambda:InvokeFunction", Principal: `logs.${region}.amazonaws.com`, SourceArn: sourceArn, SourceAccount: account })); await logs.send(new PutSubscriptionFilterCommand({ logGroupName: group, filterName: "checkout-error-stream", filterPattern: '{ $.level = "error" }', destinationArn: fn.FunctionArn }));
  await logs.send(new PutLogEventsCommand({ logGroupName: group, logStreamName: "application", logEvents: [
    { timestamp: now - 3_000, message: '{"level":"info","route":"/checkout","value":1,"latency":148}' },
    { timestamp: now - 2_000, message: '{"level":"error","route":"/checkout","value":4,"latency":263}' },
    { timestamp: now - 1_000, message: '{"level":"error","route":"/payment","value":2,"latency":231}' },
  ] }));
  await logs.send(new CreateExportTaskCommand({ taskName: "checkout-errors-archive", logGroupName: group, from: now - 60_000, to: now + 60_000, destination: new URL("cw07-export", `file://${root}/`).href, destinationPrefix: "checkout/2026-07-17" }));
  const deadline = Date.now() + 5_000; while (true) { const tasks = (await logs.send(new DescribeExportTasksCommand({}))).exportTasks ?? []; if (tasks.some(task => task.taskName === "checkout-errors-archive" && task.status?.code === "COMPLETED")) break; if (Date.now() >= deadline) throw new Error("CW-07 capture export did not complete"); await new Promise(resolveWait => setTimeout(resolveWait, 20)); }

  const pages = [
    { output: "metric-filters", section: "metric-filters", wait: page => page.getByRole("heading", { name: /Metric filters \(2\/100\)/ }).waitFor() },
    { output: "metric-filter-form", section: "metric-filters", wait: async page => { await page.getByRole("button", { name: "Create metric filter" }).first().click(); await page.getByRole("dialog").getByRole("heading", { name: "Create metric filter" }).waitFor(); } },
    { output: "metric-filter-test", section: "metric-filters", wait: async page => { await page.getByRole("button", { name: "Test pattern" }).click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Filter pattern").fill('{ $.level = "error" }'); await dialog.getByLabel("Sample log events").fill('{"level":"error","route":"/checkout"}\n{"level":"info","route":"/ready"}'); } },
    { output: "subscription-filters", section: "subscription-filters", wait: page => page.getByRole("heading", { name: /Subscription filters \(1\/2\)/ }).waitFor() },
    { output: "subscription-form", section: "subscription-filters", wait: async page => { await page.getByRole("button", { name: "Create subscription filter" }).first().click(); await page.getByRole("dialog").getByRole("heading", { name: "Create subscription filter" }).waitFor(); } },
    { output: "data-protection-placeholder", section: "data-protection", wait: page => page.getByRole("heading", { name: "No data protection policy" }).waitFor() },
    { output: "transform-placeholder", section: "transformers", wait: page => page.getByRole("heading", { name: "No transformer" }).waitFor() },
    { output: "export-data", section: "exports", wait: page => page.getByRole("heading", { name: /Export tasks \(1\)/ }).waitFor() },
    { output: "export-form", section: "exports", wait: async page => { await page.getByRole("button", { name: "Export data" }).first().click(); await page.getByRole("dialog").getByRole("heading", { name: "Export log data" }).waitFor(); } },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
  for (const pageSpec of pages) { const output = resolve("docs/ui-reference/2026-07-17/cloudwatch/cw07", pageSpec.output, "final"); await mkdir(output, { recursive: true }); for (const [name, width, height] of viewports) { const page = await browser.newPage({ viewport: { width, height } }); const diagnostics = []; page.on("console", message => { if (["warning", "error"].includes(message.type())) diagnostics.push(`console ${message.type()}: ${message.text()}`); }); page.on("pageerror", error => diagnostics.push(`page error: ${error.message}`)); await page.goto(`${endpoint}/_stacksim/console#/cloudwatch/log-groups/${encodeURIComponent(group)}/${pageSpec.section}`); await pageSpec.wait(page); await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)))); const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth); if (overflow) throw new Error(`${pageSpec.output} overflows at ${width}x${height}`); if (diagnostics.length) throw new Error(`${pageSpec.output} diagnostics: ${diagnostics.join("; ")}`); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close(); } }
} finally {
  clients.forEach(client => client.destroy()); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
