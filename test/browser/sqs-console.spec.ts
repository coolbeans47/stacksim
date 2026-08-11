import { expect, test, type Page } from "@playwright/test";
import { AttachRolePolicyCommand, CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";
import { addArnComboboxValue } from "./arn-combobox.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;

function sdkOptions(target: StackSim) {
  return {
    endpoint: `http://127.0.0.1:${target.port}`,
    region: "eu-west-1",
    credentials: { accessKeyId: "admin", secretAccessKey: "password" },
  };
}

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "unknown error";
    const expectedStoppedPoll = failure === "net::ERR_ABORTED"
      && request.method() === "POST"
      && new URL(request.url()).pathname === "/";
    if (!expectedStoppedPoll) errors.push(`requestfailed: ${request.method()} ${request.url()} (${failure})`);
  });
  page.on("response", response => {
    if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
  });
  return errors;
}

async function expectPanelHelp(page: Page, name: string, copy: string) {
  const button = page.getByRole("button", { name: `About ${name}` });
  await expect(button).toBeVisible();
  await button.hover();
  const tooltipId = await button.getAttribute("aria-describedby");
  const tooltip = page.locator(`#${tooltipId}`);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(copy);
  await expect(tooltip).toContainText("StackSim support");
  return tooltip;
}

async function selectArnSuggestion(page: Page, label: string, name: string) {
  const input = page.getByRole("dialog").getByRole("combobox", { name: label });
  await input.fill(name);
  const option = page.getByRole("dialog").getByRole("option").filter({ hasText: name });
  await expect(option).toBeVisible();
  await option.click();
}

async function createQueue(page: Page, name: string, tags = "{}", fifo = false) {
  await page.goto(`${consoleUrl}#/sqs/queues`);
  await page.getByRole("button", { name: "Create queue" }).first().click();
  const dialog = page.getByRole("dialog");
  if (fifo) { await dialog.getByLabel("Queue type").selectOption("fifo"); await dialog.getByLabel("Content-based deduplication (FIFO)").check(); }
  await dialog.getByLabel("Queue name").fill(name);
  await dialog.getByLabel("Tags (JSON object)").fill(tags);
  await dialog.getByRole("button", { name: "Create queue" }).click();
  await expect(page).toHaveURL(new RegExp(`#\\/sqs\\/queues\\/${name}\\/details$`));
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

async function createLambdaWorker(name: string) {
  const iam = new IAMClient(sdkOptions(simulator));
  const lambda = new LambdaClient(sdkOptions(simulator));
  try {
    const roleName = `${name}-role`;
    const trust = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
    });
    const role = await iam.send(new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: trust }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole" }));
    const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
    await lambda.send(new CreateFunctionCommand({
      FunctionName: name,
      Runtime: "nodejs22.x",
      Role: role.Role!.Arn!,
      Handler: "handler.echoHandler",
      Code: { ZipFile: zip },
      Timeout: 3,
    }));
  } finally {
    iam.destroy();
    lambda.destroy();
  }
}

test.describe("SQS-01 through SQS-04 console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-sqs-console-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off"});
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
  });

  test.afterEach(async () => {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("explains SQS input panels and support boundaries", async ({ page }) => {
    const errors = browserErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto(`${consoleUrl}#/sqs/queues`);
    const queuesTooltip = await expectPanelHelp(page, "Queues", "holds messages until a consumer receives and deletes them");
    await expect(queuesTooltip).toContainText("customer KMS keys");
    const bounds = await queuesTooltip.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);

    await createQueue(page, "tooltip-queue");
    await expectPanelHelp(page, "Configuration", "visibility timeout longer than normal processing time");
    await expectPanelHelp(page, "Fair queue behavior", "optional message group ID");
    await expectPanelHelp(page, "Tags", "key-value labels");

    await page.goto(`${consoleUrl}#/sqs/queues/tooltip-queue/messages`);
    await expectPanelHelp(page, "Receive messages", "Polling receives up to the selected maximum");
    await page.goto(`${consoleUrl}#/sqs/queues/tooltip-queue/dead-letter`);
    await expectPanelHelp(page, "Redrive policy", "poison messages");
    await expectPanelHelp(page, "Redrive allow policy", "which source queues may target it");
    await page.goto(`${consoleUrl}#/sqs/queues/tooltip-queue/access-policy`);
    await expectPanelHelp(page, "Resource-based queue policy", "explicit Deny overrides an Allow");
    await page.goto(`${consoleUrl}#/sqs/queues/tooltip-queue/encryption`);
    await expectPanelHelp(page, "SQS-managed SSE", "never claims that an AWS KMS key encrypted local data");
    await page.goto(`${consoleUrl}#/sqs/queues/tooltip-queue/tags`);
    await expectPanelHelp(page, "Tags", "IAM resource-tag conditions");
    await page.goto(`${consoleUrl}#/sqs/queues/tooltip-queue/lambda-triggers`);
    await expectPanelHelp(page, "Event source mappings", "partial batch responses");

    await createQueue(page, "tooltip-queue.fifo", "{}", true);
    await expectPanelHelp(page, "FIFO configuration", "five-minute deduplication");
    expect(errors).toEqual([]);
  });

  test("creates, configures, inspects, purges, monitors, and deletes a Standard queue", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/sqs/queues`);
    await expect(page.getByRole("heading", { name: "Queues", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No queues" })).toBeVisible();

    await createQueue(page, "browser-jobs", '{"environment":"browser"}');
    await expect(page.getByText("environment", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Tags" }).click();
    await page.getByRole("button", { name: "Manage tags" }).click();
    const tagDialog = page.getByRole("dialog");
    await tagDialog.getByLabel("Tags (JSON object)").fill('{"environment":"browser","team":"workers"}');
    await tagDialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("workers", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Send and receive messages" }).click();
    await page.getByRole("button", { name: "Send message" }).click();
    const sendDialog = page.getByRole("dialog");
    await sendDialog.getByLabel("Message body").fill('{"job":"resize","source":"browser"}');
    await sendDialog.getByLabel("Message attributes (JSON object)").fill('{"priority":{"DataType":"Number","StringValue":"10"}}');
    await sendDialog.getByRole("button", { name: "Send message" }).click();
    await expect(sendDialog).toBeHidden();
    await page.getByLabel("Wait time (seconds)").fill("0");
    await page.getByLabel("Visibility timeout (seconds)").fill("30");
    await page.getByRole("button", { name: "Poll for messages" }).click();
    await expect(page.getByRole("heading", { name: "Message 1" })).toBeVisible();
    await expect(page.locator(".sqs-message-body")).toContainText('"job":"resize"');
    await expect(page.locator("#sqs-receive-results")).toContainText("priority");
    await expect(page.getByText("Receive count", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Change visibility" }).click();
    const visibilityDialog = page.getByRole("dialog");
    await visibilityDialog.getByLabel("Visibility timeout (seconds)").fill("0");
    await visibilityDialog.getByRole("button", { name: "Change visibility" }).click();
    await expect(visibilityDialog).toBeHidden();
    await expect(page.locator("#toast-region")).toContainText("Message visibility changed");
    await page.getByRole("button", { name: "Poll for messages" }).click();
    await expect(page.locator('[data-received-message="0"] .key-value dd').first()).toHaveText("2");
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No inspected messages" })).toBeVisible();

    await page.getByLabel("Wait time (seconds)").fill("20");
    await page.getByRole("button", { name: "Poll for messages" }).click();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.locator("#sqs-poll-status")).toHaveText("Polling stopped");

    for (const body of ["purge-one", "purge-two"]) {
      await page.getByRole("button", { name: "Send message" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Message body").fill(body);
      await dialog.getByRole("button", { name: "Send message" }).click();
      await expect(dialog).toBeHidden();
    }
    await page.getByRole("tab", { name: "Details" }).click();
    await expect(page.getByText("2", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Purge" }).click();
    const purgeDialog = page.getByRole("dialog");
    await purgeDialog.getByLabel(/To confirm deletion, enter browser-jobs/).fill("browser-jobs");
    await purgeDialog.getByRole("button", { name: "Purge" }).click();
    await expect(page.locator("#toast-region")).toContainText("Queue purged");

    await page.getByRole("tab", { name: "Monitoring" }).click();
    await expect(page.getByRole("heading", { name: "Monitoring" })).toBeVisible();
    await expect(page.getByRole("img", { name: "SQS activity for browser-jobs" })).toBeVisible();
    await page.getByRole("tab", { name: "Access policy" }).click();
    await expect(page.getByRole("heading", { name: "Effective-access diagnostics" })).toBeVisible();
    await expect(page.locator(".eventbridge-queue-policy")).toContainText("events.amazonaws.com");
    await page.getByRole("tab", { name: "Encryption" }).click();
    await expect(page.getByRole("heading", { name: "SQS-managed SSE" })).toBeVisible();
    await expect(page.locator(".sqs-encryption")).toContainText("Enabled");
    await page.getByRole("tab", { name: "Details" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const deleteDialog = page.getByRole("dialog");
    await deleteDialog.getByLabel(/To confirm deletion, enter browser-jobs/).fill("browser-jobs");
    await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/#\/sqs\/queues$/);
    await expect(page.getByRole("heading", { name: "No queues" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("configures a DLQ and adds a Lambda SQS event source mapping", async ({ page }) => {
    const errors = browserErrors(page);
    await createLambdaWorker("browser-sqs-worker");
    await createQueue(page, "browser-dlq");
    await createQueue(page, "browser-source");

    await page.getByRole("tab", { name: "Dead-letter queue" }).click();
    const redriveCard = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Redrive policy" }) });
    await redriveCard.getByRole("button", { name: "Configure" }).click();
    const redriveDialog = page.getByRole("dialog");
    await selectArnSuggestion(page, "Dead-letter queue", "browser-dlq");
    await redriveDialog.getByLabel("Maximum receives").fill("3");
    await redriveDialog.getByRole("button", { name: "Save" }).click();
    await expect(redriveCard.getByText("browser-dlq", { exact: true })).toBeVisible();
    await expect(redriveCard.getByText("3", { exact: true })).toBeVisible();

    await page.goto(`${consoleUrl}#/sqs/queues/browser-dlq/dead-letter`);
    await expect(page.getByRole("heading", { name: "Source queues" })).toBeVisible();
    await expect(page.getByRole("link", { name: "browser-source", exact: true })).toBeVisible();
    const allowCard = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Redrive allow policy" }) });
    await allowCard.getByRole("button", { name: "Configure" }).click();
    const allowDialog = page.getByRole("dialog");
    await allowDialog.getByLabel("Redrive permission").selectOption("byQueue");
    await addArnComboboxValue(allowDialog.getByLabel("Allowed source queue ARNs"), "arn:aws:sqs:eu-west-1:000000000000:browser-source");
    await allowDialog.getByRole("button", { name: "Save" }).click();
    await expect(allowCard).toContainText("byQueue");
    await expect(allowCard).toContainText("browser-source");

    await page.goto(`${consoleUrl}#/sqs/queues/browser-source/lambda-triggers`);
    await expect(page.getByRole("heading", { name: "Lambda triggers", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add trigger" }).first().click();
    const triggerDialog = page.getByRole("dialog");
    await expect(triggerDialog).toContainText("sqs:ReceiveMessage");
    await triggerDialog.getByLabel("Batch size").fill("11");
    await triggerDialog.getByLabel("Batching window (seconds)").fill("1");
    await triggerDialog.getByLabel("Maximum concurrency (optional)").fill("2");
    await triggerDialog.getByLabel("Report partial batch item failures").check();
    await triggerDialog.getByLabel("Filter pattern (optional JSON)").fill('{"body":{"job":["ready"]}}');
    await triggerDialog.getByRole("button", { name: "Add trigger" }).click();
    await expect(page.getByRole("link", { name: "browser-sqs-worker" })).toHaveAttribute("href", "#/lambda/functions/browser-sqs-worker");
    await expect(page.locator(".sqs-lambda-triggers")).toContainText("11 · 1s");
    await expect(page.locator(".sqs-lambda-triggers")).toContainText("Enabled");
    await expect(page.locator(".sqs-lambda-triggers")).toContainText("2");
    expect(errors).toEqual([]);
  });

  test("creates and operates a FIFO queue with group-aware DLQ and Lambda guidance", async ({ page }) => {
    const errors = browserErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await createLambdaWorker("browser-fifo-worker");
    await createQueue(page, "browser-fifo-dlq.fifo", "{}", true);
    await createQueue(page, "browser-orders.fifo", "{}", true);
    await expect(page.getByText("FIFO", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Queue type and the .fifo suffix are immutable.")).toBeVisible();

    await page.getByRole("tab", { name: "Send and receive messages" }).click();
    await page.getByRole("button", { name: "Send message" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Message body").fill('{"order":"fifo-browser"}');
    await dialog.getByLabel("Message group ID").fill("tenant-a");
    await dialog.getByRole("button", { name: "Send message" }).click();
    await expect(dialog).toBeHidden();
    await page.getByLabel("Wait time (seconds)").fill("0");
    await page.getByRole("button", { name: "Poll for messages" }).click();
    const message = page.locator('[data-received-message="0"]');
    await expect(message).toContainText("tenant-a");
    await expect(message).toContainText("Sequence number");

    await page.getByRole("tab", { name: "Dead-letter queue" }).click();
    await page.getByRole("button", { name: "Configure" }).first().click();
    dialog = page.getByRole("dialog");
    await selectArnSuggestion(page, "Dead-letter queue", "browser-fifo-dlq.fifo");
    await dialog.getByRole("button", { name: "Save" }).click();

    await page.getByRole("tab", { name: "Lambda triggers" }).click();
    await expect(page.getByText("FIFO group ordering", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add trigger" }).first().click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Batch size")).toHaveAttribute("max", "10");
    await expect(dialog.getByLabel("Batching window (seconds)")).toHaveAttribute("readonly", "");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(errors).toEqual([]);
  });

  test("keeps queue workflows usable at a narrow viewport", async ({ page }) => {
    const errors = browserErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await createQueue(page, "narrow-browser-queue");
    await expect(page.getByRole("tab", { name: "Send and receive messages" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await page.getByRole("tab", { name: "Send and receive messages" }).click();
    await page.getByRole("button", { name: "Send message" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Message body").fill('{"job":"narrow-workflow"}');
    await dialog.getByRole("button", { name: "Send message" }).click();
    await expect(dialog).toBeHidden();

    const receiveForm = page.locator("#sqs-receive-form");
    await receiveForm.getByLabel("Wait time (seconds)").fill("0");
    await receiveForm.getByLabel("Visibility timeout (seconds)").fill("30");
    await receiveForm.getByRole("button", { name: "Poll for messages" }).click();
    const message = page.locator('[data-received-message="0"]');
    await expect(message).toContainText("narrow-workflow");

    await message.getByRole("button", { name: "Change visibility" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Visibility timeout (seconds)").fill("45");
    await dialog.getByRole("button", { name: "Change visibility" }).click();
    await expect(page.locator("#toast-region")).toContainText("Message visibility changed");
    await message.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No inspected messages" })).toBeVisible();

    await page.getByRole("button", { name: "Send message" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Message body").fill("purge-from-narrow-workflow");
    await dialog.getByRole("button", { name: "Send message" }).click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await page.getByRole("tab", { name: "Details" }).click();
    await page.getByRole("button", { name: "Purge" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm deletion, enter narrow-browser-queue/).fill("narrow-browser-queue");
    await dialog.getByRole("button", { name: "Purge" }).click();
    await expect(page.locator("#toast-region")).toContainText("Queue purged");

    await page.getByRole("tab", { name: "Access policy" }).click();
    await expect(page.getByRole("heading", { name: "Resource-based queue policy" })).toBeVisible();
    await expect(page.locator(".sqs-access-policy")).toContainText("IAM and resource-policy authorization are active");
    await expect(page.locator(".eventbridge-queue-policy")).toContainText("events.amazonaws.com");
    await page.getByRole("button", { name: "Add statement" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Source ARN condition (optional)").fill("arn:aws:events:eu-west-1:000000000000:rule/orders");
    await dialog.getByRole("button", { name: "Add statement" }).click();
    await expect(page.locator(".sqs-access-policy")).toContainText("AllowEventBridgeRule");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await page.getByRole("tab", { name: "Encryption" }).click();
    await expect(page.getByRole("heading", { name: "SQS-managed SSE" })).toBeVisible();
    await expect(page.locator(".sqs-encryption")).toContainText("SSE-KMS is an explicit dependency");
    await page.getByRole("button", { name: "Edit encryption" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("SQS-managed server-side encryption").selectOption("false");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".sqs-encryption")).toContainText("SqsManagedSseEnabled");
    await expect(page.locator(".sqs-encryption")).toContainText("false");

    await page.getByRole("tab", { name: "Details" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm deletion, enter narrow-browser-queue/).fill("narrow-browser-queue");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/#\/sqs\/queues$/);
    expect(errors).toEqual([]);
  });
});
