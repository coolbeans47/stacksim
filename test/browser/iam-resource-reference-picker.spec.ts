import { expect, test, type Page } from "@playwright/test";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import { mkdtemp, rm } from "node:fs/promises";
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

test.describe("IAM guided roles and ARN references", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-iam-reference-picker-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off" });
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
    const sqs = new SQSClient(options());
    try {
      await sqs.send(new CreateQueueCommand({ QueueName: "guided-orders" }));
      await sqs.send(new CreateQueueCommand({ QueueName: "guided-replay" }));
    }
    finally { sqs.destroy(); }
  });

  test.afterEach(async () => {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("shows a complete policy ARN suggestion in the add-permissions dialog", async ({ page }) => {
    const iam = new IAMClient(options());
    try {
      await iam.send(new CreateRoleCommand({
        RoleName: "permission-picker-role",
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
        }),
      }));
    }
    finally { iam.destroy(); }

    await page.setViewportSize({ width: 900, height: 650 });
    await page.goto(`${consoleUrl}#/iam/roles/permission-picker-role`);
    await page.getByRole("button", { name: "Add permissions" }).click();

    const dialog = page.getByRole("dialog");
    const body = dialog.locator(".modal-body");
    const option = dialog.getByRole("option").first();
    await expect(option).toBeVisible();
    const [bodyBox, optionBox] = await Promise.all([body.boundingBox(), option.boundingBox()]);
    expect(bodyBox).not.toBeNull();
    expect(optionBox).not.toBeNull();
    expect(optionBox!.y + optionBox!.height).toBeLessThanOrEqual(bodyBox!.y + bodyBox!.height);
  });

  test("keeps direct creation and creates a Scheduler role from a selected local queue", async ({ page }) => {
    const errors = browserErrors(page);
    await page.setViewportSize({ width: 900, height: 650 });
    await page.goto(`${consoleUrl}#/iam/roles`);

    await page.getByRole("button", { name: "Create role", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Create role", exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Trusted entity type")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    const guided = page.getByRole("button", { name: "Create service role" });
    await expect(guided).toHaveAttribute("title", "Create service role");
    await guided.click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Create service role" })).toBeVisible();
    const next = dialog.getByRole("button", { name: "Next" });
    await expect(next).toBeVisible();
    await expect(next.locator("xpath=..")).toHaveClass(/modal-footer/);
    await expect(dialog.locator(".wizard-actions")).toHaveCount(0);
    await expect.poll(() => dialog.locator(".modal-body").evaluate(body => body.scrollHeight > body.clientHeight)).toBe(true);
    await dialog.getByLabel("EventBridge Scheduler execution role").check();
    await dialog.getByRole("button", { name: "Next" }).click();
    await dialog.getByLabel("Target kind").selectOption("sqs");

    const target = dialog.getByRole("combobox", { name: "Target resource ARN" });
    await target.focus();
    const queueOption = dialog.getByRole("option", { name: /guided-orders/ });
    await expect(queueOption).toBeVisible();
    await queueOption.click();
    await expect(target).toHaveValue("arn:aws:sqs:eu-west-1:000000000000:guided-orders");
    await target.press("End");
    await target.type(" ");
    await target.press("Backspace");

    await dialog.getByRole("button", { name: "Next" }).click();
    await expect(dialog.getByLabel("Role name")).toHaveValue("guided-orders-schedule-role");
    await dialog.getByRole("button", { name: "Review role" }).click();
    await expect(dialog.getByText("EventBridge Scheduler can assume this role.")).toBeVisible();
    await expect(dialog.getByText("Send messages to guided-orders.")).toBeVisible();
    await dialog.getByText("Generated permission-policy JSON").click();
    await expect(dialog.getByText(/sqs:SendMessage/)).toBeVisible();
    await dialog.getByRole("button", { name: "Create role", exact: true }).click();

    await expect(page).toHaveURL(/#\/iam\/roles\/guided-orders-schedule-role$/);
    await expect(page.getByText("guided-orders-schedule-role-guided-policy", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("shows one set of wizard actions and creates a Lambda execution role without optional resources", async ({ page }) => {
    const errors = browserErrors(page);
    await page.setViewportSize({ width: 900, height: 650 });
    await page.goto(`${consoleUrl}#/iam/roles`);
    await page.getByRole("button", { name: "Create service role" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Next" })).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "Back" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Create role", exact: true })).toHaveCount(0);

    await dialog.getByRole("button", { name: "Next" }).click();
    await expect(dialog.getByText("Basic CloudWatch Logs included")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Back" })).toHaveCount(1);
    await dialog.getByRole("button", { name: "Next" }).click();
    await dialog.getByLabel("Role name").fill("guided-lambda-execution-role");
    await dialog.getByRole("button", { name: "Review role" }).click();

    const create = dialog.getByRole("button", { name: "Create role", exact: true });
    await expect(create).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "Next" })).toHaveCount(0);
    await create.click();

    await expect(page).toHaveURL(/#\/iam\/roles\/guided-lambda-execution-role$/);
    await expect(page.getByText("AWSLambdaBasicExecutionRole", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("selects compatible target, role, and Standard DLQ suggestions without changing the Scheduler flow", async ({ page }) => {
    const errors = browserErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${consoleUrl}#/iam/roles`);
    await page.getByRole("button", { name: "Create service role" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("EventBridge Scheduler execution role").check();
    await dialog.getByRole("button", { name: "Next" }).click();
    await dialog.getByLabel("Target kind").selectOption("sqs");
    await dialog.getByRole("combobox", { name: "Target resource ARN" }).fill("arn:aws:sqs:eu-west-1:000000000000:guided-orders");
    await dialog.getByRole("combobox", { name: "Target resource ARN" }).press("Escape");
    await dialog.getByRole("button", { name: "Next" }).click();
    await dialog.getByRole("button", { name: "Review role" }).click();
    await dialog.getByRole("button", { name: "Create role", exact: true }).click();
    await expect(page).toHaveURL(/guided-orders-schedule-role$/);

    await page.goto(`${consoleUrl}#/eventbridge/schedules`);
    await page.getByRole("button", { name: "Create schedule" }).first().click();
    dialog = page.getByRole("dialog");
    await expect(dialog.locator("[data-guided-step]")).toHaveCount(0);
    await expect(dialog.getByLabel("Schedule expression")).toBeVisible();

    const target = dialog.getByRole("combobox", { name: "Target ARN" });
    await target.focus();
    await dialog.getByRole("option", { name: /guided-orders/ }).click();
    const role = dialog.getByRole("combobox", { name: "Scheduler execution role ARN" });
    await role.focus();
    await dialog.getByRole("option", { name: /guided-orders-schedule-role/ }).click();
    const dlq = dialog.getByRole("combobox", { name: "Standard SQS DLQ ARN \(optional\)" });
    await dlq.focus();
    await dialog.getByRole("option", { name: /guided-orders/ }).click();

    await dialog.getByLabel("Name").fill("guided-schedule");
    await dialog.getByRole("button", { name: "Create schedule" }).click();
    await expect(page).toHaveURL(/#\/eventbridge\/schedules\/default\/guided-schedule$/);
    expect(errors).toEqual([]);
  });

  test("opens resource suggestions above a field near the bottom of a scrolled dialog", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 650 });
    await page.goto(`${consoleUrl}#/eventbridge/schedules`);
    await page.getByRole("button", { name: "Create schedule" }).first().click();

    const dialog = page.getByRole("dialog");
    const body = dialog.locator(".modal-body");
    const target = dialog.getByRole("combobox", { name: "Target ARN" });
    await target.evaluate(input => {
      const element = input.closest(".modal-body");
      if (!element) throw new Error("Target ARN is not inside the modal body");
      const bodyBounds = element.getBoundingClientRect();
      const inputBounds = input.getBoundingClientRect();
      element.scrollTop += inputBounds.bottom - bodyBounds.bottom + 8;
    });
    await target.focus();

    const picker = target.locator("xpath=../..");
    const listbox = picker.getByRole("listbox");
    await expect(picker).toHaveAttribute("data-placement", "above");
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole("option", { name: /guided-orders/ }).first()).toBeVisible();
    const [bodyBounds, inputBounds, listBounds] = await Promise.all([body.boundingBox(), target.boundingBox(), listbox.boundingBox()]);
    expect(bodyBounds).not.toBeNull();
    expect(inputBounds).not.toBeNull();
    expect(listBounds).not.toBeNull();
    expect(listBounds!.y + listBounds!.height).toBeLessThanOrEqual(inputBounds!.y);
    expect(listBounds!.y).toBeGreaterThanOrEqual(bodyBounds!.y);
    await target.blur();
    await expect(picker.locator("[data-arn-error]")).toBeHidden();
    await expect(dialog.getByText("Enter an ARN.", { exact: true })).toHaveCount(0);
  });

  test("migrates newline ARN fields to duplicate-safe multi-entry tokens", async ({ page }) => {
    await page.goto(`${consoleUrl}#/sqs/queues/guided-orders/dead-letter`);
    const card = page.locator(".card").filter({ has: page.getByRole("heading", { name: /Redrive allow policy/ }) });
    await card.getByRole("button", { name: "Configure" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Redrive permission").selectOption("byQueue");
    const input = dialog.getByRole("combobox", { name: "Allowed source queue ARNs" });
    await input.fill("arn:aws:sqs:eu-west-1:000000000000:guided-orders");
    await input.press("Escape");
    await input.press("Enter");
    await input.fill("arn:aws:sqs:eu-west-1:000000000000:guided-replay");
    await input.press("Enter");
    await expect(dialog.locator(".arn-token")).toHaveCount(2);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("arn:aws:sqs:eu-west-1:000000000000:guided-replay", { exact: true })).toBeVisible();
  });

  test("explains IAM editors and their StackSim support", async ({ page }) => {
    const errors = browserErrors(page);
    const expectHelp = async (title: string, supportText: string) => {
      const button = page.getByRole("button", { name: `About ${title}` }).first();
      await expect(button).toBeVisible();
      await button.hover();
      const tooltip = button.locator("..").getByRole("tooltip");
      await expect(tooltip).toContainText(supportText);
      await expect(tooltip).toContainText("StackSim support");
      await page.mouse.move(0, 0);
      return tooltip;
    };

    await page.goto(`${consoleUrl}#/iam/users`);
    await expectHelp("Users", "Console passwords");
    await page.getByRole("link", { name: "admin", exact: true }).click();
    await expectHelp("Permissions", "explicit Deny");
    const credentialsTooltip = await expectHelp("Security credentials", "one-time secret display");

    await page.goto(`${consoleUrl}#/iam/groups`);
    await expectHelp("User groups", "compatible IAM API");
    await page.getByRole("button", { name: "Create group" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Group name").fill("browser-tooltip-group");
    await dialog.getByRole("button", { name: "Create group" }).click();
    await expectHelp("Members", "cannot contain other groups");

    await page.goto(`${consoleUrl}#/iam/roles`);
    await expectHelp("Roles", "STS AssumeRole sessions");
    await page.goto(`${consoleUrl}#/iam/roles/test/permissions`);
    await expectHelp("Permissions policies", "session-policy intersection");
    await page.getByRole("link", { name: "Trust relationships" }).click();
    await expectHelp("Trust policy", "read-only after creation");

    await page.goto(`${consoleUrl}#/iam/policies`);
    await expectHelp("Policies", "visual and JSON creation");
    const administratorArn = encodeURIComponent("arn:aws:iam::aws:policy/AdministratorAccess");
    await page.goto(`${consoleUrl}#/iam/policies/${administratorArn}/permissions`);
    await expectHelp("Permission policy", "explicit-deny precedence");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${consoleUrl}#/iam/users/admin`);
    await page.getByRole("button", { name: "About Security credentials" }).hover();
    const tooltipBox = await credentialsTooltip.boundingBox();
    expect(tooltipBox).not.toBeNull();
    expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
    expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  });
});
