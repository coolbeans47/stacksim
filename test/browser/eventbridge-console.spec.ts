import { expect, test, type Page } from "@playwright/test";
import assert from "node:assert/strict";
import { DescribeRuleCommand, EventBridgeClient, ListRulesCommand, PutRuleCommand } from "@aws-sdk/client-eventbridge";
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

/** Default event bus tile › Actions › Send events: publishes a matching and a nonmatching event through the console modal. */
async function sendTwoEvents(page: Page, bus: string, matchingSource: string, nonmatchingSource: string) {
  await page.goto(`${consoleUrl}#/eventbridge/event-buses`);
  await page.locator(".eventbridge-bus-tile summary").click();
  await page.getByRole("menuitem", { name: "Send events" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add another event" }).click();
  const matching = dialog.locator("[data-event-entry]").nth(0); const nonmatching = dialog.locator("[data-event-entry]").nth(1);
  await matching.getByLabel("Event bus").selectOption(bus);
  await matching.getByLabel("Event source").fill(matchingSource);
  await matching.getByLabel("Detail type").fill("Order state");
  await matching.getByLabel("Event detail").fill('{"state":"created","secret":"not-shown-in-diagnostics"}');
  await nonmatching.getByLabel("Event bus").selectOption(bus);
  await nonmatching.getByLabel("Event source").fill(nonmatchingSource);
  await nonmatching.getByLabel("Detail type").fill("Inventory state");
  await nonmatching.getByLabel("Event detail").fill('{"state":"unchanged"}');
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("2 accepted · 0 failed");
  await expect(dialog.locator("tbody tr")).toHaveCount(2);
  await expect(dialog.locator("tbody td").nth(2)).not.toHaveText("–");
  await dialog.getByRole("button", { name: "Cancel" }).click();
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

  test("creates a bus and rule through the Advanced Builder, tests and sends an event, inspects diagnostics, then deletes exactly", async ({ page }) => {
    const errors = browserErrors(page); const main = page.locator("main");
    await createTargetFunction("browser-event-target", "arn:aws:events:eu-west-1:000000000000:rule/browser-events/browser-order-rule");

    await page.goto(`${consoleUrl}#/eventbridge/event-buses`);
    await expect(page.getByRole("heading", { name: "Event buses", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "default", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Default event bus" })).toBeVisible();
    await page.getByRole("button", { name: "Create event bus" }).first().click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill("browser-events");
    await dialog.getByLabel("Description – optional", { exact: true }).fill("Browser EVB-01 workflow");
    await expect(dialog.getByLabel("Use customer managed key")).toBeDisabled();
    await dialog.getByRole("button", { name: "Add new tag" }).click();
    await dialog.getByLabel("Key", { exact: true }).fill("environment");
    await dialog.getByLabel("Value – optional").fill("browser");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/#\/eventbridge\/event-buses\/browser-events\/details$/);
    await expect(page.getByRole("heading", { name: "browser-events", exact: true })).toBeVisible();
    await expect(page.getByText("Custom Event Bus - Classic", { exact: true })).toBeVisible();
    const permissionsCard = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Permissions" }) });
    await expect(permissionsCard).toBeVisible();
    await expect(permissionsCard.getByText("Unavailable", { exact: true })).toBeVisible();

    // Create rule › builder selection › Advanced Builder (five steps).
    await page.getByRole("button", { name: "Create rule" }).first().click();
    await expect(page).toHaveURL(/#\/eventbridge\/rules\/create$/);
    await expect(page.getByRole("button", { name: "Choose Enhanced Builder" })).toBeDisabled();
    await page.getByRole("link", { name: "Choose Advanced Builder" }).click();
    await expect(page.getByRole("heading", { name: "Step 1: Define rule detail" })).toBeVisible();
    await main.getByLabel("Name", { exact: true }).fill("browser-order-rule");
    await expect(main.getByLabel("Event bus", { exact: true })).toHaveValue("browser-events");
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("heading", { name: "Step 2: Build event pattern" })).toBeVisible();
    await main.getByRole("radio", { name: /^Other/ }).check();
    await main.getByLabel("Event pattern", { exact: true }).fill('{"source":["browser.orders"],"detail":{"state":["created"]}}');
    await main.getByLabel("Sample event type").selectOption("own");
    await main.getByLabel("Sample event", { exact: true }).fill('{"version":"0","id":"sample","detail-type":"Order state","source":"browser.orders","account":"000000000000","time":"2026-07-20T12:00:00Z","region":"eu-west-1","resources":[],"detail":{"state":"created"}}');
    await page.getByRole("button", { name: "Test pattern" }).click();
    await expect(main.locator("[data-pattern-test-result]")).toContainText("Pattern matches");
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("heading", { name: "Step 3: Select target(s)" })).toBeVisible();
    await expect(main.getByLabel("EventBridge event bus")).toBeDisabled();
    await fillArnCombobox(main.getByLabel("Lambda function", { exact: true }), "arn:aws:lambda:eu-west-1:000000000000:function:browser-event-target");
    await main.getByLabel("Maximum age of event (seconds)").fill("60");
    await main.getByLabel("Retry attempts").fill("2");
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("heading", { name: "Step 4: Configure tags" })).toBeVisible();
    await page.getByRole("button", { name: "Add new tag" }).click();
    await main.getByLabel("Key", { exact: true }).fill("workflow");
    await main.getByLabel("Value – optional").fill("browser");
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("heading", { name: "Step 5: Review and create" })).toBeVisible();
    await expect(page.locator("[data-review]")).toContainText("browser-order-rule");
    await expect(page.locator("[data-review]")).toContainText("browser-event-target");
    await page.getByRole("button", { name: "Create rule", exact: true }).click();
    await expect(page).toHaveURL(/#\/eventbridge\/rules\/browser-events\/browser-order-rule\/details$/);
    await expect(page.locator(".eventbridge-json-preview")).toContainText("browser.orders");
    await expect(page.getByText("Created by", { exact: true })).toBeVisible();

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
    await page.getByRole("tab", { name: "Tags" }).click();
    await expect(page.getByRole("cell", { name: "workflow", exact: true })).toBeVisible();

    // Sandbox: event-pattern tab uses the same builder; Send events lives on the event bus.
    await page.getByRole("navigation", { name: "EventBridge navigation" }).getByRole("link", { name: "Sandbox" }).click();
    await expect(page.getByRole("tab", { name: "Target input transformer" })).toBeVisible();
    await main.getByRole("radio", { name: /^Other/ }).check();
    await main.getByLabel("Event pattern", { exact: true }).fill('{"source":["browser.orders"]}');
    await main.getByLabel("Sample event type").selectOption("own");
    await main.getByLabel("Sample event", { exact: true }).fill('{"version":"0","id":"sandbox","detail-type":"Order state","source":"browser.orders","account":"000000000000","time":"2026-07-20T12:00:00Z","region":"eu-west-1","resources":[],"detail":{}}');
    await page.getByRole("button", { name: "Test pattern" }).click();
    await expect(main.locator("[data-pattern-test-result]")).toContainText("Pattern matches");
    await sendTwoEvents(page, "browser-events", "browser.orders", "browser.inventory");

    await expect.poll(async () => {
      const response = await page.request.get(`http://127.0.0.1:${simulator.port}/_stacksim/api/eventbridge/deliveries`, { headers: { "x-stacksim-region": "eu-west-1" } });
      const state = await response.json();
      return state.diagnostics?.some((item: { ruleName?: string; status?: string }) => item.ruleName === "browser-order-rule" && item.status === "SUCCEEDED") ?? false;
    }).toBe(true);
    await page.goto(`${consoleUrl}#/eventbridge/rules/browser-events/browser-order-rule/metrics`);
    await expect(page.getByRole("heading", { name: "Bounded local diagnostics" })).toBeVisible();
    await expect(page.locator(".eventbridge-diagnostic-table")).toContainText("browser-event-target");
    await expect(page.locator("main")).not.toContainText("not-shown-in-diagnostics");
    await expect(page.getByRole("link", { name: "Open metric explorer" })).toHaveAttribute("href", "#/cloudwatch/metrics");

    await page.getByRole("button", { name: "Disable" }).click();
    await expect(page.locator("main .status", { hasText: "Disabled" }).first()).toBeVisible();
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

  test("creates a legacy scheduled rule from the Scheduler section without an event pattern, then edits it", async ({ page }) => {
    const errors = browserErrors(page); const main = page.locator("main");
    const events = new EventBridgeClient(sdkOptions(simulator));
    try {
      await page.goto(`${consoleUrl}#/eventbridge/rules`);
      await expect(page.getByText("Event patterns and legacy schedules", { exact: true })).toBeVisible();
      await expect(page.locator("main .alert.info").filter({ hasText: "EventBridge Scheduler is recommended for new time-driven work" })).toBeVisible();
      await page.getByRole("navigation", { name: "EventBridge navigation" }).getByRole("link", { name: "Scheduled rule (legacy)" }).click();
      await expect(page.getByRole("heading", { name: "Scheduled rule (legacy)", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Create scheduled rule" }).click();
      await expect(page.getByRole("heading", { name: "Step 1: Define scheduled rule" })).toBeVisible();
      await main.getByLabel("Name", { exact: true }).fill("schedule-only-console");
      await expect(page.locator("[data-cron-dates] li")).toHaveCount(10);
      await main.getByLabel(/A schedule that runs at a regular rate/).check();
      await main.getByLabel("Value", { exact: true }).fill("5");
      await expect(page.locator("[data-rate-expression]")).toHaveText("rate(5 minutes)");
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByRole("button", { name: "Remove target 1" }).click();
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.locator("[data-review]")).toContainText("rate(5 minutes)");
      await page.getByRole("button", { name: "Create scheduled rule", exact: true }).click();
      await expect(page).toHaveURL(/#\/eventbridge\/rules\/default\/schedule-only-console\/details$/);
      await expect(page.getByText("Scheduled (legacy)", { exact: true })).toBeVisible();
      await expect(page.locator("main")).not.toContainText("Event pattern");

      let described = await events.send(new DescribeRuleCommand({ Name: "schedule-only-console" }));
      assert.equal(described.EventPattern, undefined);
      assert.equal(described.ScheduleExpression, "rate(5 minutes)");

      await page.getByRole("button", { name: "Edit" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("Event pattern (JSON)")).toHaveValue("");
      await expect(dialog.locator('[name="scheduleExpression"]')).toHaveValue("rate(5 minutes)");
      await dialog.getByRole("button", { name: "Save rule" }).click();
      await expect(dialog).toBeHidden();
      described = await events.send(new DescribeRuleCommand({ Name: "schedule-only-console" }));
      assert.equal(described.EventPattern, undefined);
      assert.equal(described.ScheduleExpression, "rate(5 minutes)");
      await page.goto(`${consoleUrl}#/eventbridge/scheduled-rules`);
      await expect(page.getByRole("link", { name: "schedule-only-console" })).toBeVisible();
      expect(errors).toEqual([]);
    } finally { events.destroy(); }
  });

  test("shows archive managed rules as managed and force deletes them from the bus-scoped Rules page", async ({ page }) => {
    const errors = browserErrors(page); const main = page.locator("main");
    const events = new EventBridgeClient(sdkOptions(simulator));
    try {
      await page.goto(`${consoleUrl}#/eventbridge/event-buses`);
      await page.getByRole("button", { name: "Create event bus" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name", { exact: true }).fill("managed-bus");
      await dialog.getByLabel("Enabled", { exact: true }).check();
      await dialog.getByLabel("Archive name").fill("managed-archive");
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page).toHaveURL(/#\/eventbridge\/event-buses\/managed-bus\/details$/);
      await expect(page.getByRole("link", { name: "Events-Archive-managed-archive" })).toBeVisible();
      await page.getByRole("tab", { name: "Archives" }).click();
      await expect(page.getByRole("link", { name: "managed-archive" })).toBeVisible();

      await page.goto(`${consoleUrl}#/eventbridge/rules`);
      await main.getByLabel("Event bus", { exact: true }).selectOption("managed-bus");
      const row = page.locator("tbody tr").filter({ hasText: "Events-Archive-managed-archive" });
      await expect(row).toContainText("prs.events.amazonaws.com");
      await row.getByRole("radio").check();
      await page.locator(".eventbridge-page summary").filter({ hasText: "Actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Disable" })).toBeDisabled();
      await page.getByRole("link", { name: "Events-Archive-managed-archive" }).click();
      await expect(page.getByText("Managed rule", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Edit" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Disable" })).toBeDisabled();
      await page.getByRole("button", { name: "Force delete" }).click();
      const confirm = page.getByRole("dialog");
      await confirm.getByLabel(/To confirm deletion, enter Events-Archive-managed-archive/).fill("Events-Archive-managed-archive");
      await confirm.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page).toHaveURL(/#\/eventbridge\/rules$/);
      assert.deepEqual((await events.send(new ListRulesCommand({ EventBusName: "managed-bus" }))).Rules, []);
      expect(errors).toEqual([]);
    } finally { events.destroy(); }
  });

  test("completes the bus, rule, pattern, send, metrics, and delete workflow at 390 pixels", async ({ page }) => {
    const errors = browserErrors(page); const main = page.locator("main");
    await page.setViewportSize({ width: 390, height: 844 });
    await createTargetFunction("mobile-event-target", "arn:aws:events:eu-west-1:000000000000:rule/mobile-events/mobile-rule");
    for (const [hash, heading] of [["#/eventbridge/event-buses", "Event buses"], ["#/eventbridge/rules", "Rules"], ["#/eventbridge/sandbox", "Sandbox"], ["#/eventbridge/rules/create", "Create rule"], ["#/eventbridge/scheduled-rules", "Scheduled rule (legacy)"]] as const) {
      await page.goto(`${consoleUrl}${hash}`);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    }
    await page.goto(`${consoleUrl}#/eventbridge/event-buses`);
    await page.getByRole("button", { name: "Create event bus" }).first().click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill("mobile-events");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("heading", { name: "mobile-events", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await page.getByRole("button", { name: "Create rule" }).first().click();
    await page.getByRole("link", { name: "Choose Advanced Builder" }).click();
    await main.getByLabel("Name", { exact: true }).fill("mobile-rule");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.getByRole("button", { name: "Next" }).click();
    await main.getByRole("radio", { name: /^Other/ }).check();
    await main.getByLabel("Event pattern", { exact: true }).fill('{"source":["mobile.app"]}');
    await main.getByLabel("Sample event type").selectOption("own");
    await main.getByLabel("Sample event", { exact: true }).fill('{"version":"0","id":"mobile","detail-type":"Mobile event","source":"mobile.app","account":"000000000000","time":"2026-07-20T12:00:00Z","region":"eu-west-1","resources":[],"detail":{}}');
    await page.getByRole("button", { name: "Test pattern" }).click();
    await expect(main.locator("[data-pattern-test-result]")).toContainText("Pattern matches");
    await page.getByRole("button", { name: "Next" }).click();
    await fillArnCombobox(main.getByLabel("Lambda function", { exact: true }), "arn:aws:lambda:eu-west-1:000000000000:function:mobile-event-target");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Create rule", exact: true }).click();
    await expect(page.getByRole("heading", { name: "mobile-rule", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await sendTwoEvents(page, "mobile-events", "mobile.app", "mobile.other");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await expect.poll(async () => {
      const response = await page.request.get(`http://127.0.0.1:${simulator.port}/_stacksim/api/eventbridge/deliveries`, { headers: { "x-stacksim-region": "eu-west-1" } });
      const state = await response.json();
      return state.diagnostics?.some((item: { ruleName?: string; status?: string }) => item.ruleName === "mobile-rule" && item.status === "SUCCEEDED") ?? false;
    }).toBe(true);
    await page.goto(`${consoleUrl}#/eventbridge/rules/mobile-events/mobile-rule/metrics`);
    await expect(page.getByRole("heading", { name: "Bounded local diagnostics" })).toBeVisible();
    await expect(page.locator(".eventbridge-diagnostic-table")).toContainText("mobile-event-target");
    await page.getByRole("link", { name: "Open metric explorer" }).click();
    await expect(page).toHaveURL(/#\/cloudwatch\/metrics$/);
    await expect(page.getByRole("heading", { name: "All metrics", exact: true })).toBeVisible();
    await main.getByLabel("Namespace").selectOption("AWS/Events");
    await expect(page.getByRole("row").filter({ hasText: "MatchedEvents" }).first()).toBeVisible();
    await page.goto(`${consoleUrl}#/eventbridge/rules/mobile-events/mobile-rule/metrics`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
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
    const errors = browserErrors(page); const main = page.locator("main");
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
      await expectHelp("Custom event buses", "cross-account routing");
      await expectHelp("Default event bus", "up to ten custom events");
      await page.goto(`${consoleUrl}#/eventbridge/event-buses/default/details`);
      await expectHelp("Bus details", "Event payloads are not retained");

      await page.goto(`${consoleUrl}#/eventbridge/rules`);
      await expectHelp("Rules", "default-bus legacy scheduled rules");
      await page.goto(`${consoleUrl}#/eventbridge/rules/default/browser-help-rule/details`);
      await expectHelp("Rule details", "Replacement-style edits");
      await expectHelp("Event pattern", "sample-event tester");
      await expectHelp("Targets", "Standard SQS DLQs");
      await page.getByRole("tab", { name: "Tags" }).click();
      await expectHelp("Tags", "Organizations tag policies");

      await page.goto(`${consoleUrl}#/eventbridge/sandbox`);
      const patternTooltip = await expectHelp("Creation method", "does not store the sample");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "About Creation method" }).hover();
      const tooltipBox = await patternTooltip.boundingBox();
      expect(tooltipBox).not.toBeNull();
      expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
      expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(390);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${consoleUrl}#/eventbridge/sandbox/input-transformer`);
      await expectHelp("Target input transformer", "nothing is published");
      await page.goto(`${consoleUrl}#/eventbridge/scheduled-rules`);
      await expectHelp("Scheduled rules", "one-minute precision");

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
