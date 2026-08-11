import { expect, test, type Page } from "@playwright/test";
import { EventBridgeClient, PutRuleCommand } from "@aws-sdk/client-eventbridge";
import { AttachRolePolicyCommand, CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { AddPermissionCommand, CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";
import { fillArnCombobox } from "./arn-combobox.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;

function sdkOptions(target: StackSim) {
  return { endpoint: `http://127.0.0.1:${target.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } };
}

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  page.on("response", response => { if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`); });
  return errors;
}

async function createTargetFunction(name: string, sourceArn?: string) {
  const iam = new IAMClient(sdkOptions(simulator)); const lambda = new LambdaClient(sdkOptions(simulator));
  try {
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
    const role = await iam.send(new CreateRoleCommand({ RoleName: `${name}-role`, AssumeRolePolicyDocument: trust }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: `${name}-role`, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" }));
    const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    await lambda.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Role: role.Role!.Arn!, Handler: "handler.echoHandler", Code: { ZipFile: zip } }));
    await lambda.send(new AddPermissionCommand({ FunctionName: name, StatementId: "eventbridge-console", Action: "lambda:InvokeFunction", Principal: "events.amazonaws.com", ...(sourceArn ? { SourceArn: sourceArn } : {}) }));
  } finally { iam.destroy(); lambda.destroy(); }
}

test.describe("EVB-01 console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-eventbridge-console-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off"});
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
  });

  test.afterEach(async () => {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("creates a bus and rule, tests and sends an event, inspects diagnostics, then deletes exactly", async ({ page }) => {
    const errors = browserErrors(page);
    await createTargetFunction("browser-event-target", "arn:aws:events:eu-west-1:000000000000:rule/browser-events/browser-order-rule");

    await page.goto(`${consoleUrl}#/eventbridge/event-buses`);
    await expect(page.getByRole("heading", { name: "Event buses", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "default", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create event bus" }).first().click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("browser-events");
    await dialog.getByLabel("Description").fill("Browser EVB-01 workflow");
    await dialog.getByLabel("Tags (JSON object)").fill('{"environment":"browser"}');
    await dialog.getByRole("button", { name: "Create event bus" }).click();
    await expect(page).toHaveURL(/#\/eventbridge\/event-buses\/browser-events\/details$/);
    await expect(page.getByRole("heading", { name: "browser-events", exact: true })).toBeVisible();
    const permissionsCard = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Permissions" }) });
    await expect(permissionsCard).toBeVisible();
    await expect(permissionsCard.getByText("Unavailable", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Create rule" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Rule name").fill("browser-order-rule");
    await dialog.getByLabel("Event pattern (JSON)").fill('{"source":["browser.orders"],"detail":{"state":["created"]}}');
    await dialog.getByLabel("Sample event (JSON)").fill('{"version":"0","id":"sample","detail-type":"Order state","source":"browser.orders","account":"000000000000","time":"2026-07-20T12:00:00Z","region":"eu-west-1","resources":[],"detail":{"state":"created"}}');
    await dialog.getByRole("button", { name: "Test pattern" }).click();
    await expect(dialog.getByRole("status")).toContainText("Pattern matches");
    await fillArnCombobox(dialog.getByLabel("Lambda function (optional)"), "arn:aws:lambda:eu-west-1:000000000000:function:browser-event-target");
    await dialog.getByLabel("Maximum event age (seconds)").fill("60");
    await dialog.getByLabel("Maximum retry attempts").fill("2");
    await dialog.getByLabel("Tags (JSON object)").fill('{"workflow":"browser"}');
    await dialog.getByRole("button", { name: "Create rule" }).click();
    await expect(page).toHaveURL(/#\/eventbridge\/rules\/browser-events\/browser-order-rule\/details$/);
    await expect(page.locator(".eventbridge-json-preview")).toContainText("browser.orders");

    const patternCard = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Event pattern" }) });
    await patternCard.getByRole("button", { name: "Test pattern" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Sample event (JSON)").fill('{"version":"0","id":"rule-test","detail-type":"Order state","source":"browser.orders","account":"000000000000","time":"2026-07-20T12:00:00Z","region":"eu-west-1","resources":[],"detail":{"state":"created"}}');
    await dialog.getByRole("button", { name: "Test pattern" }).click();
    await expect(dialog.getByRole("status")).toContainText("Pattern matches");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Sample event (JSON)").fill('{"version":"0","id":"rule-test","detail-type":"Order state","source":"browser.inventory","account":"000000000000","time":"2026-07-20T12:00:00Z","region":"eu-west-1","resources":[],"detail":{"state":"created"}}');
    await dialog.getByRole("button", { name: "Test pattern" }).click();
    await expect(dialog.getByRole("status")).toContainText("Pattern does not match");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("tab", { name: "Targets" }).click();
    await expect(page.getByRole("link", { name: "browser-event-target" })).toBeVisible();
    await expect(page.getByText("60 sec", { exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "2", exact: true })).toBeVisible();

    await page.getByRole("navigation", { name: "EventBridge navigation" }).getByRole("link", { name: "Sandbox" }).click();
    const testCard = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Test event pattern" }) });
    await testCard.getByLabel("Event pattern (JSON)").fill('{"source":["browser.orders"]}');
    await testCard.getByLabel("Sample event (JSON)").fill('{"version":"0","id":"sandbox","detail-type":"Order state","source":"browser.orders","account":"000000000000","time":"2026-07-20T12:00:00Z","region":"eu-west-1","resources":[],"detail":{}}');
    await testCard.getByRole("button", { name: "Test pattern" }).click();
    await expect(testCard.getByRole("status")).toContainText("Pattern matches");
    const sendCard = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Send events" }) });
    await sendCard.getByRole("button", { name: "Add entry" }).click();
    const matchingEntry = sendCard.locator("[data-event-entry]").nth(0); const nonmatchingEntry = sendCard.locator("[data-event-entry]").nth(1);
    await matchingEntry.getByLabel("Event bus").selectOption("browser-events");
    await matchingEntry.getByLabel("Source", { exact: true }).fill("browser.orders");
    await matchingEntry.getByLabel("Detail type").fill("Order state");
    await matchingEntry.getByLabel("Detail (JSON object)").fill('{"state":"created","secret":"not-shown-in-diagnostics"}');
    await nonmatchingEntry.getByLabel("Event bus").selectOption("browser-events");
    await nonmatchingEntry.getByLabel("Source", { exact: true }).fill("browser.inventory");
    await nonmatchingEntry.getByLabel("Detail type").fill("Inventory state");
    await nonmatchingEntry.getByLabel("Detail (JSON object)").fill('{"state":"unchanged"}');
    await sendCard.getByRole("button", { name: "Send events", exact: true }).click();
    await expect(sendCard.getByRole("status")).toContainText("2 accepted · 0 failed");
    await expect(sendCard.locator("tbody tr")).toHaveCount(2);
    await expect(sendCard.locator("tbody td").nth(2)).not.toHaveText("–");

    await expect.poll(async () => {
      const response = await page.request.get(`http://127.0.0.1:${simulator.port}/_stacksim/api/eventbridge/deliveries`, { headers: { "x-stacksim-region": "eu-west-1" } });
      const state = await response.json();
      return state.diagnostics?.some((item: { ruleName?: string; status?: string }) => item.ruleName === "browser-order-rule" && item.status === "SUCCEEDED") ?? false;
    }).toBe(true);
    await page.goto(`${consoleUrl}#/eventbridge/rules/browser-events/browser-order-rule/monitoring`);
    await expect(page.getByRole("heading", { name: "Bounded local diagnostics" })).toBeVisible();
    await expect(page.locator(".eventbridge-diagnostic-table")).toContainText("browser-event-target");
    await expect(page.locator("main")).not.toContainText("not-shown-in-diagnostics");
    await expect(page.getByRole("link", { name: "Open metric explorer" })).toHaveAttribute("href", "#/cloudwatch/metrics");

    await page.getByRole("tab", { name: "Details" }).click();
    await page.getByRole("button", { name: "Disable" }).click();
    await expect(page.locator("main .status", { hasText: "Disabled" })).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    dialog = page.getByRole("dialog");
    const ruleConfirmation = dialog.getByLabel(/To confirm deletion, enter browser-order-rule/);
    await ruleConfirmation.fill("wrong-name");
    expect(await ruleConfirmation.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
    await ruleConfirmation.fill("browser-order-rule");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/#\/eventbridge\/rules$/);

    await page.goto(`${consoleUrl}#/eventbridge/event-buses/browser-events/details`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm deletion, enter browser-events/).fill("browser-events");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/#\/eventbridge\/event-buses$/);
    await expect(page.getByRole("link", { name: "default", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("completes the bus, rule, pattern, send, monitoring, and delete workflow at 390 pixels", async ({ page }) => {
    const errors = browserErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await createTargetFunction("mobile-event-target", "arn:aws:events:eu-west-1:000000000000:rule/mobile-events/mobile-rule");
    for (const [hash, heading] of [["#/eventbridge/event-buses", "Event buses"], ["#/eventbridge/rules", "Rules"], ["#/eventbridge/sandbox", "Sandbox"]] as const) {
      await page.goto(`${consoleUrl}${hash}`);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    }
    await page.goto(`${consoleUrl}#/eventbridge/event-buses`);
    await page.getByRole("button", { name: "Create event bus" }).first().click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("mobile-events");
    await dialog.getByLabel("Tags (JSON object)").fill('{"viewport":"narrow"}');
    await dialog.getByRole("button", { name: "Create event bus" }).click();
    await expect(page.getByRole("heading", { name: "mobile-events", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await page.getByRole("button", { name: "Create rule" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Rule name").fill("mobile-rule");
    await dialog.getByLabel("Event pattern (JSON)").fill('{"source":["mobile.app"]}');
    await dialog.getByLabel("Sample event (JSON)").fill('{"version":"0","id":"mobile","detail-type":"Mobile event","source":"mobile.app","account":"000000000000","time":"2026-07-20T12:00:00Z","region":"eu-west-1","resources":[],"detail":{}}');
    await dialog.getByRole("button", { name: "Test pattern" }).click();
    await expect(dialog.getByRole("status")).toContainText("Pattern matches");
    await fillArnCombobox(dialog.getByLabel("Lambda function (optional)"), "arn:aws:lambda:eu-west-1:000000000000:function:mobile-event-target");
    await dialog.getByRole("button", { name: "Create rule" }).click();
    await expect(page.getByRole("heading", { name: "mobile-rule", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await page.goto(`${consoleUrl}#/eventbridge/sandbox`);
    const sendCard = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Send events" }) });
    await sendCard.getByRole("button", { name: "Add entry" }).click();
    const matchingEntry = sendCard.locator("[data-event-entry]").nth(0); const nonmatchingEntry = sendCard.locator("[data-event-entry]").nth(1);
    await matchingEntry.getByLabel("Event bus").selectOption("mobile-events");
    await matchingEntry.getByLabel("Source", { exact: true }).fill("mobile.app");
    await matchingEntry.getByLabel("Detail (JSON object)").fill('{"viewport":390}');
    await nonmatchingEntry.getByLabel("Event bus").selectOption("mobile-events");
    await nonmatchingEntry.getByLabel("Source", { exact: true }).fill("mobile.other");
    await nonmatchingEntry.getByLabel("Detail type").fill("Nonmatching mobile event");
    await nonmatchingEntry.getByLabel("Detail (JSON object)").fill('{"viewport":390,"matched":false}');
    await sendCard.getByRole("button", { name: "Send events", exact: true }).click();
    await expect(sendCard.getByRole("status")).toContainText("2 accepted · 0 failed");
    await expect(sendCard.locator("tbody tr")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await expect.poll(async () => {
      const response = await page.request.get(`http://127.0.0.1:${simulator.port}/_stacksim/api/eventbridge/deliveries`, { headers: { "x-stacksim-region": "eu-west-1" } });
      const state = await response.json();
      return state.diagnostics?.some((item: { ruleName?: string; status?: string }) => item.ruleName === "mobile-rule" && item.status === "SUCCEEDED") ?? false;
    }).toBe(true);
    await page.goto(`${consoleUrl}#/eventbridge/rules/mobile-events/mobile-rule/monitoring`);
    await expect(page.getByRole("heading", { name: "Bounded local diagnostics" })).toBeVisible();
    await expect(page.locator(".eventbridge-diagnostic-table")).toContainText("mobile-event-target");
    await page.getByRole("link", { name: "Open metric explorer" }).click();
    await expect(page).toHaveURL(/#\/cloudwatch\/metrics$/);
    await expect(page.getByRole("heading", { name: "All metrics", exact: true })).toBeVisible();
    await page.getByLabel("Namespace").selectOption("AWS/Events");
    await expect(page.getByRole("row").filter({ hasText: "MatchedEvents" }).first()).toBeVisible();
    await page.goto(`${consoleUrl}#/eventbridge/rules/mobile-events/mobile-rule/monitoring`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.getByRole("tab", { name: "Details" }).click();
    await page.getByRole("button", { name: "Disable" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm deletion, enter mobile-rule/).fill("mobile-rule");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/#\/eventbridge\/rules$/);
    await page.goto(`${consoleUrl}#/eventbridge/event-buses/mobile-events/details`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm deletion, enter mobile-events/).fill("mobile-events");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("link", { name: "default", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(errors).toEqual([]);
  });

  test("explains EventBridge editors and their StackSim support", async ({ page }) => {
    const events = new EventBridgeClient(sdkOptions(simulator));
    const errors = browserErrors(page);
    const expectHelp = async (title: string, supportText: string) => {
      const button = page.getByRole("button", { name: `About ${title}` }).first();
      await expect(button).toBeVisible();
      await button.hover();
      const tooltip = button.locator("..").getByRole("tooltip");
      await expect(tooltip).toContainText(supportText);
      await expect(tooltip).toContainText("StackSim support");
      return tooltip;
    };

    try {
      await events.send(new PutRuleCommand({ Name: "browser-help-rule", EventBusName: "default", EventPattern: JSON.stringify({ source: ["browser.help"] }), Description: "Tooltip fixture" }));

      await page.goto(`${consoleUrl}#/eventbridge/event-buses`);
      await expectHelp("Event buses", "cross-account routing");
      await page.goto(`${consoleUrl}#/eventbridge/event-buses/default/details`);
      await expectHelp("Bus details", "Event payloads are not retained");
      await expectHelp("Related rules", "up to five independent targets");

      await page.goto(`${consoleUrl}#/eventbridge/rules`);
      await expectHelp("Rules", "Scheduler surface");
      await page.goto(`${consoleUrl}#/eventbridge/rules/default/browser-help-rule/details`);
      await expectHelp("Rule details", "Replacement-style edits");
      await expectHelp("Targets", "CloudWatch Logs");
      await expectHelp("Event pattern", "sample-event tester");
      await page.getByRole("tab", { name: "Targets" }).click();
      await expectHelp("Targets", "Standard SQS DLQs");
      await page.getByRole("tab", { name: "Tags" }).click();
      await expectHelp("Tags", "Organizations tag policies");

      await page.goto(`${consoleUrl}#/eventbridge/sandbox`);
      await expectHelp("Test event pattern", "does not store the sample");
      const sendTooltip = await expectHelp("Send events", "up to ten custom entries");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "About Send events" }).hover();
      const tooltipBox = await sendTooltip.boundingBox();
      expect(tooltipBox).not.toBeNull();
      expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
      expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(390);

      await page.goto(`${consoleUrl}#/eventbridge/schedules`);
      await expectHelp("Schedules", "six-field cron expressions");
      await page.goto(`${consoleUrl}#/eventbridge/schedule-groups`);
      await expectHelp("Schedule groups", "not inherited by schedules");
      expect(errors).toEqual([]);
    } finally {
      events.destroy();
    }
  });
});
