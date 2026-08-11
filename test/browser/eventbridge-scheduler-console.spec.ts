import { expect, test, type Page } from "@playwright/test";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;

function options() {
  return { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } };
}

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  page.on("response", response => { if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`); });
  return errors;
}

async function createLambdaTarget(name: string): Promise<string> {
  const iam = new IAMClient(options()); const lambda = new LambdaClient(options());
  try {
    const role = await iam.send(new CreateRoleCommand({
      RoleName: `${name}-role`,
      AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }),
    }));
    const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    const created = await lambda.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Role: role.Role!.Arn!, Handler: "handler.echoHandler", Code: { ZipFile: zip } }));
    return created.FunctionArn!;
  } finally { iam.destroy(); lambda.destroy(); }
}

test.describe("EVB-03 Scheduler console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-scheduler-console-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off" });
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
    const iam = new IAMClient(options()); const sqs = new SQSClient(options());
    try {
      await sqs.send(new CreateQueueCommand({ QueueName: "browser-scheduler-target" }));
      await iam.send(new CreateRoleCommand({
        RoleName: "browser-scheduler-role",
        AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "scheduler.amazonaws.com" }, Action: "sts:AssumeRole" }] }),
      }));
      await iam.send(new PutRolePolicyCommand({ RoleName: "browser-scheduler-role", PolicyName: "send", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: "*" }] }) }));
    } finally { iam.destroy(); sqs.destroy(); }
  });

  test.afterEach(async () => {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("uses the shared action-button size and typography for links and native buttons", async ({ page }) => {
    await page.goto(`${consoleUrl}#/eventbridge`);
    const headerActions = page.locator("#main .eventbridge-page > .page-header .actions .button");
    await expect(headerActions).toHaveCount(2);
    const presentations = await headerActions.evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, display: style.display, decoration: style.textDecorationLine, transform: style.textTransform };
    }));
    expect(presentations).toEqual([
      { height: 34, display: "flex", decoration: "none", transform: "capitalize" },
      { height: 34, display: "flex", decoration: "none", transform: "capitalize" },
    ]);

    await page.goto(`${consoleUrl}#/eventbridge/schedules`);
    const createSchedule = page.getByRole("button", { name: "Create schedule" }).first();
    await expect(createSchedule).toHaveCSS("height", "34px");
    await expect(createSchedule).toHaveCSS("text-decoration-line", "none");
    await expect(createSchedule).toHaveCSS("text-transform", "capitalize");
  });

  test("opens schedule creation from the EventBridge overview and returns to the schedules list", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/eventbridge`);
    await page.getByRole("button", { name: "Create schedule" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/#\/eventbridge$/);
    await dialog.getByLabel("Name").fill("overview-rate");
    await dialog.getByLabel("Target ARN").fill("arn:aws:sqs:eu-west-1:000000000000:browser-scheduler-target");
    await dialog.getByLabel("Scheduler execution role ARN").fill("arn:aws:iam::000000000000:role/browser-scheduler-role");
    await dialog.getByRole("button", { name: "Create schedule" }).click();

    await expect(page).toHaveURL(/#\/eventbridge\/schedules$/);
    await expect(page.getByRole("heading", { name: "Schedules", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "overview-rate", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("links a Lambda target ARN to the target function", async ({ page }) => {
    const errors = browserErrors(page);
    const functionArn = await createLambdaTarget("browser-scheduler-function");
    await page.goto(`${consoleUrl}#/eventbridge/schedules`);
    await page.getByRole("button", { name: "Create schedule" }).first().click();

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("browser-lambda-schedule");
    await dialog.getByLabel("State").selectOption("DISABLED");
    await dialog.getByLabel("Target ARN").fill(functionArn);
    await dialog.getByLabel("Scheduler execution role ARN").fill("arn:aws:iam::000000000000:role/browser-scheduler-role");
    await dialog.getByRole("button", { name: "Create schedule" }).click();

    const targetLink = page.getByRole("link", { name: functionArn, exact: true });
    await expect(targetLink).toHaveAttribute("href", "#/lambda/functions/browser-scheduler-function");
    await targetLink.click();
    await expect(page).toHaveURL(/#\/lambda\/functions\/browser-scheduler-function$/);
    await expect(page.getByRole("heading", { name: "browser-scheduler-function", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("creates a tagged group and a disabled rate schedule, then edits its complete configuration", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/eventbridge/schedule-groups`);
    await expect(page.getByRole("heading", { name: "Schedule groups", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "About Schedule groups" })).toBeVisible();
    await page.getByRole("button", { name: "Create schedule group" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("browser-group");
    await dialog.getByLabel("Tags (JSON object)").fill('{"workflow":"browser"}');
    await dialog.getByRole("button", { name: "Create group" }).click();
    await expect(page).toHaveURL(/#\/eventbridge\/schedule-groups\/browser-group$/);
    await expect(page.getByText('{"workflow":"browser"}')).toBeVisible();
    await expect(page.getByRole("button", { name: "About Group details" })).toBeVisible();
    await expect(page.getByRole("button", { name: "About Schedules" })).toBeVisible();

    await page.getByRole("navigation", { name: "EventBridge navigation" }).getByRole("link", { name: "Schedules", exact: true }).click();
    await expect(page.getByRole("button", { name: "Refresh schedules" })).toHaveText("↻");
    await expect(page.getByRole("button", { name: "About Schedules" })).toBeVisible();
    await page.getByRole("button", { name: "Create schedule" }).first().click();
    dialog = page.getByRole("dialog");
    expect((await dialog.boundingBox())?.width).toBe(775);
    await dialog.getByLabel("Schedule group").selectOption("browser-group");
    await dialog.getByLabel("Name").fill("browser-rate");
    const scheduleExpression = dialog.getByLabel("Schedule expression");
    const expressionOptions = dialog.getByRole("listbox", { name: "Schedule rate examples" });
    const expressionToggle = dialog.getByRole("button", { name: "Choose a common rate" });
    await expect(scheduleExpression).toHaveValue("rate(5 minutes)");
    await expect(expressionOptions).toBeHidden();
    await scheduleExpression.click();
    await expect(expressionOptions).toBeHidden();
    await scheduleExpression.fill("rate(7 minutes)");
    await expect(scheduleExpression).toHaveValue("rate(7 minutes)");
    await expect(expressionOptions).toBeHidden();
    await expressionToggle.click();
    await expect(expressionOptions).toBeVisible();
    await expect(expressionOptions.getByRole("option")).toHaveCount(8);
    await expressionOptions.locator('[data-expression-value="rate(5 minutes)"]').click();
    await expect(scheduleExpression).toHaveValue("rate(5 minutes)");
    await expect(expressionOptions).toBeHidden();
    await dialog.getByLabel("Time zone").selectOption("Europe/London");
    await dialog.getByLabel("State").selectOption("DISABLED");
    const controlHeights = await dialog.locator('[name="group"], [name="name"], [name="timezone"], [name="state"], [name="windowMode"], [name="windowMinutes"]').evaluateAll(controls => controls.map(control => control.getBoundingClientRect().height));
    expect(new Set(controlHeights)).toEqual(new Set([36]));
    const dateRowBounds = await dialog.locator(".eventbridge-schedule-date-range").boundingBox();
    const startDateBounds = await dialog.getByRole("textbox", { name: "Start date (optional)" }).boundingBox();
    const endDateBounds = await dialog.getByRole("textbox", { name: "End date (optional)" }).boundingBox();
    expect(startDateBounds?.width).toBeLessThan((dateRowBounds?.width ?? 0) * 0.55);
    expect(endDateBounds?.width).toBeLessThan((dateRowBounds?.width ?? 0) * 0.55);
    expect(Math.abs((startDateBounds?.width ?? 0) - (endDateBounds?.width ?? 0))).toBeLessThan(2);
    await dialog.getByRole("button", { name: "Open start date (optional) calendar" }).click();
    const datePicker = dialog.getByRole("group", { name: "Choose start date (optional) and time" });
    await expect(datePicker).toBeVisible();
    const datePickerBounds = await datePicker.boundingBox();
    expect(datePickerBounds?.width).toBeGreaterThanOrEqual(330);
    expect(datePickerBounds?.width).toBeLessThanOrEqual(344);
    expect(datePickerBounds?.height).toBeLessThan(350);
    expect(datePickerBounds?.y).toBeGreaterThanOrEqual(0);
    expect((datePickerBounds?.y ?? 0) + (datePickerBounds?.height ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);
    expect(await datePicker.locator("[data-date-day]").count()).toBeGreaterThanOrEqual(28);
    const dayBounds = await datePicker.locator("[data-date-day]").first().boundingBox();
    expect(dayBounds?.height).toBe(32);
    for (const direction of ["Previous", "Next"]) {
      const button = datePicker.getByRole("button", { name: `${direction} month` });
      const icon = button.locator(".eventbridge-month-arrow");
      const [buttonBounds, iconBounds] = await Promise.all([button.boundingBox(), icon.boundingBox()]);
      expect(buttonBounds?.width).toBe(buttonBounds?.height);
      await expect(icon).toHaveCSS("background-color", "rgb(38, 54, 76)");
      expect(Math.abs((buttonBounds?.x ?? 0) + (buttonBounds?.width ?? 0) / 2 - ((iconBounds?.x ?? 0) + (iconBounds?.width ?? 0) / 2))).toBeLessThan(1);
      expect(Math.abs((buttonBounds?.y ?? 0) + (buttonBounds?.height ?? 0) / 2 - ((iconBounds?.y ?? 0) + (iconBounds?.height ?? 0) / 2))).toBeLessThan(1);
    }
    await datePicker.locator("[data-date-day]").nth(10).click();
    await datePicker.getByLabel("Time").fill("12:30");
    await datePicker.getByRole("button", { name: "Apply" }).click();
    await expect(dialog.locator('input[name="startDate"]')).not.toHaveValue("");
    const selectedStartDate = await dialog.locator('input[name="startDate"]').inputValue();
    await dialog.getByLabel("Target ARN").fill("arn:aws:sqs:eu-west-1:000000000000:browser-scheduler-target");
    await dialog.getByLabel("Scheduler execution role ARN").fill("arn:aws:iam::000000000000:role/browser-scheduler-role");
    await dialog.getByLabel("Target input (JSON or text, optional)").fill('{"source":"browser"}');
    await dialog.getByRole("button", { name: "Create schedule" }).click();
    await expect(page).toHaveURL(/#\/eventbridge\/schedules\/browser-group\/browser-rate$/);
    await expect(page.locator("#main").getByText("rate(5 minutes)", { exact: true })).toBeVisible();
    await expect(page.locator("#main").getByText("Europe/London", { exact: true })).toBeVisible();
    await expect(page.locator("#main").getByText("Disabled", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "About Schedule details" })).toBeVisible();

    await page.getByRole("button", { name: "Edit" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.locator('input[name="startDate"]')).toHaveValue(selectedStartDate);
    await dialog.getByLabel("Schedule expression").fill("rate(10 minutes)");
    await dialog.getByLabel("Maximum retry attempts").fill("3");
    await dialog.getByRole("button", { name: "Save schedule" }).click();
    await expect(page.getByText("rate(10 minutes)", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
