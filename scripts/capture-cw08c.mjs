import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CloudWatchClient, PutAlarmMuteRuleCommand, PutLogAlarmCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { TestClock } from "../dist/src/core/clock.js";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-cw08c-capture-"));
const clock = new TestClock(Date.parse("2026-07-17T12:01:00Z"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
const credentials = { accessKeyId: "admin", secretAccessKey: "password" }; let browser; let cloudwatch; let logsClient;

try {
  await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; cloudwatch = new CloudWatchClient({ endpoint, region: "eu-west-1", credentials }); logsClient = new CloudWatchLogsClient({ endpoint, region: "eu-west-1", credentials }); const group = "/learning/orders";
  await logsClient.send(new CreateLogGroupCommand({ logGroupName: group })); await logsClient.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: "application" })); await logsClient.send(new PutLogEventsCommand({ logGroupName: group, logStreamName: "application", logEvents: [
    { timestamp: Date.parse("2026-07-17T12:00:10Z"), message: '{"level":"ERROR","host":"orders-api-a","requestId":"req-101","route":"/checkout"}' },
    { timestamp: Date.parse("2026-07-17T12:00:20Z"), message: '{"level":"ERROR","host":"orders-api-a","requestId":"req-102","route":"/checkout"}' },
    { timestamp: Date.parse("2026-07-17T12:00:30Z"), message: '{"level":"ERROR","host":"orders-api-b","requestId":"req-103","route":"/payments"}' },
    { timestamp: Date.parse("2026-07-17T12:00:40Z"), message: '{"level":"INFO","host":"orders-api-c","requestId":"req-104","route":"/health"}' },
  ] }));
  await cloudwatch.send(new PutLogAlarmCommand({ AlarmName: "orders-errors-by-host", AlarmDescription: "Detect error-producing order-service hosts from a scheduled Logs Insights query.", ScheduledQueryConfiguration: { QueryString: "filter level = 'ERROR' | fields @timestamp, @message, host, route", LogGroupIdentifiers: [group], ScheduledQueryRoleARN: "arn:aws:iam::000000000000:role/cloudwatch-log-query", ScheduleConfiguration: { ScheduleExpression: "rate(1 minute)", StartTimeOffset: 60, EndTimeOffset: 0 }, AggregationExpression: "count(*) as errors by host | sort errors desc", Tags: [{ Key: "query", Value: "orders-errors" }] }, QueryResultsToEvaluate: 1, QueryResultsToAlarm: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "missing", AlarmActions: ["arn:aws:sns:eu-west-1:000000000000:orders-alerts"], ActionLogLineCount: 2, ActionLogLineRoleArn: "arn:aws:iam::000000000000:role/cloudwatch-log-lines", Tags: [{ Key: "team", Value: "orders" }, { Key: "environment", Value: "learning" }] }));
  await cloudwatch.send(new PutAlarmMuteRuleCommand({ Name: "checkout-maintenance", Description: "Mute order-service alarm actions during the checkout rollout.", Rule: { Schedule: { Expression: "at(2026-07-17T12:01)", Duration: "PT2H", Timezone: "UTC" } }, MuteTargets: { AlarmNames: ["orders-errors-by-host"] }, Tags: [{ Key: "change", Value: "CHG-8042" }, { Key: "owner", Value: "platform" }] }));
  await cloudwatch.send(new PutAlarmMuteRuleCommand({ Name: "nightly-database-window", Description: "Recurring database maintenance window.", Rule: { Schedule: { Expression: "cron(0 2 * * *)", Duration: "PT30M", Timezone: "Europe/London" } }, MuteTargets: { AlarmNames: ["orders-errors-by-host"] } })); await simulator.metrics.evaluateAlarmsNow(clock.now());

  const pages = [
    { output: "alarm-catalog", route: "/cloudwatch/alarms", wait: page => page.getByRole("link", { name: "orders-errors-by-host" }).waitFor() },
    { output: "create-log-alarm", route: "/cloudwatch/alarms", wait: async page => { await page.getByRole("button", { name: "Create log alarm" }).first().click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Log groups").selectOption(group); await dialog.getByLabel("Logs Insights QL").fill("filter level = 'ERROR' | fields @timestamp, @message, host"); await dialog.getByRole("button", { name: "Next" }).click(); await dialog.getByLabel("Aggregation expression").fill("count(*) as errors by host | sort errors desc"); await dialog.getByRole("heading", { name: "Aggregate and evaluate contributors" }).waitFor(); await dialog.locator(".modal-body").evaluate(element => { element.scrollTop = 0; }); } },
    { output: "log-alarm-detail", route: "/cloudwatch/alarms/orders-errors-by-host", wait: page => page.getByRole("heading", { name: /Contributors in ALARM \(2\)/ }).waitFor() },
    { output: "mute-rule-catalog", route: "/cloudwatch/alarm-mute-rules", wait: page => page.getByRole("link", { name: "checkout-maintenance" }).waitFor() },
    { output: "create-mute-rule", route: "/cloudwatch/alarm-mute-rules", wait: async page => { await page.getByRole("button", { name: "Create mute rule" }).first().click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Rule name").fill("release-window"); await dialog.getByLabel("Schedule expression").fill("at(2026-07-17T16:00)"); await dialog.getByLabel("Target alarm names (one per line)").fill("orders-errors-by-host"); await dialog.getByRole("heading", { name: "Create alarm mute rule" }).waitFor(); await dialog.locator(".modal-body").evaluate(element => { element.scrollTop = 0; }); } },
    { output: "mute-rule-detail", route: "/cloudwatch/alarm-mute-rules/checkout-maintenance", wait: page => page.getByText("Targeted alarm actions are currently muted.", { exact: true }).waitFor() },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-17/cloudwatch/cw08c", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const page = await browser.newPage({ viewport: { width, height } }); const diagnostics = [];
      page.on("console", message => { if (["warning", "error"].includes(message.type())) diagnostics.push(`console ${message.type()}: ${message.text()}`); }); page.on("pageerror", error => diagnostics.push(`page error: ${error.message}`));
      await page.goto(`${endpoint}/_stacksim/console#${pageSpec.route}`); await pageSpec.wait(page); await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || [...document.querySelectorAll("main")].some(element => element.scrollWidth > element.clientWidth)); if (overflow) throw new Error(`${pageSpec.output} overflows at ${width}x${height}`); if (diagnostics.length) throw new Error(`${pageSpec.output} diagnostics: ${diagnostics.join("; ")}`);
      await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close();
    }
  }
} finally { cloudwatch?.destroy(); logsClient?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
