import { expect, test, type Locator, type Page } from "@playwright/test";
import { SQSClient, CreateQueueCommand, SendMessageCommand, GetQueueAttributesCommand, GetQueueUrlCommand, ListMessageMoveTasksCommand, ListQueueTagsCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { CreateTopicCommand, PublishCommand, SNSClient } from "@aws-sdk/client-sns";
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
  const button = page.getByRole("button", { name: `About ${name}`, exact: true });
  await expect(button).toBeVisible();
  await button.hover();
  const tooltipId = await button.getAttribute("aria-describedby");
  const tooltip = page.locator(`#${tooltipId}`);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(copy);
  await expect(tooltip).toContainText("StackSim support");
  return tooltip;
}

/** Type into a resource picker and choose the suggestion with that name. */
async function selectArnSuggestion(root: Page | Locator, label: string, name: string) {
  const input = root.getByRole("combobox", { name: label });
  await input.fill(name);
  const option = root.getByRole("option").filter({ hasText: name });
  await expect(option).toBeVisible();
  await option.click();
}

function card(page: Page, heading: string | RegExp) {
  return page.locator("section.card").filter({ has: page.getByRole("heading", { name: heading, exact: typeof heading === "string" }) });
}

async function scrollWidth(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth);
}

interface CreateOptions {
  fifo?: boolean;
  tags?: Record<string, string>;
  /** Extra steps on the create page before it is submitted. */
  configure?: () => Promise<void>;
}

async function addTagRow(root: Page | Locator, key: string, value: string) {
  await root.getByRole("button", { name: "Add new tag" }).click();
  const row = root.locator("[data-tag-row]").last();
  await row.getByLabel("Key").fill(key);
  await row.getByLabel("Value").fill(value);
}

async function createQueue(page: Page, name: string, options: CreateOptions = {}) {
  await page.goto(`${consoleUrl}#/sqs/queues/create`);
  await expect(page.getByRole("heading", { name: "Create queue", exact: true })).toBeVisible();
  if (options.fifo) {
    await page.getByRole("radio", { name: /^FIFO/ }).check();
    await page.getByLabel("Content-based deduplication").check();
  }
  await page.getByLabel("Name", { exact: true }).fill(name);
  for (const [key, value] of Object.entries(options.tags ?? {})) await addTagRow(page, key, value);
  await options.configure?.();
  await page.getByRole("button", { name: "Create queue" }).click();
  await expect(page).toHaveURL(new RegExp(`#\\/sqs\\/queues\\/${name}\\/details$`));
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

/** One immediate receive call per poll, so a poll ends as soon as the queue has answered. */
async function useSingleShortPoll(page: Page) {
  await page.getByRole("button", { name: "Edit poll settings" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Edit poll settings" })).toBeVisible();
  await dialog.getByLabel("Polling duration").fill("5");
  await dialog.getByLabel("Wait time (seconds)").fill("0");
  await dialog.getByLabel("Poll attempts").fill("1");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}

async function sendMessage(page: Page, body: string) {
  await page.getByLabel("Message body").fill(body);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator("[data-send-result]")).toContainText("Your message has been sent and is ready to be received.");
}

async function pollForMessages(page: Page) {
  await page.getByRole("button", { name: "Poll for messages" }).click();
  await expect(page.getByRole("button", { name: "Poll for messages" })).toBeEnabled();
}

async function confirmWith(page: Page, title: string, word: string, button: string) {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await dialog.getByLabel(new RegExp(`enter ${word}$`)).fill(word);
  await dialog.getByRole("button", { name: button, exact: true }).click();
  await expect(dialog).toBeHidden();
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

async function queueAttributes(client: SQSClient, name: string) {
  const url = (await client.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
  return { url, attributes: (await client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["All"] }))).Attributes ?? {} };
}

test.describe("SQS console and DLQ recovery", () => {
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

  test("starts, lists and cancels redrive from the redrive tasks tab on a narrow screen", async ({ page }) => {
    const errors = browserErrors(page); const client = new SQSClient(sdkOptions(simulator));
    try {
      const dlq = (await client.send(new CreateQueueCommand({ QueueName: "redrive-dead" }))).QueueUrl!;
      const arn = (await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
      await client.send(new CreateQueueCommand({ QueueName: "redrive-source", Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 1 }) } }));
      await client.send(new CreateQueueCommand({ QueueName: "redrive-custom" }));
      for (let i = 0; i < 10; i++) await client.send(new SendMessageCommand({ QueueUrl: dlq, MessageBody: `private-work-${i}` }));
      await page.setViewportSize({ width: 390, height: 844 });

      // Redrive is offered only on a queue that another queue uses as its dead-letter queue.
      await page.goto(`${consoleUrl}#/sqs/queues/redrive-custom/redrive-tasks`);
      await expect(page.getByRole("button", { name: "Start DLQ redrive", exact: true }).first()).toBeDisabled();
      await expect(page.getByText("No redrive tasks yet.")).toBeVisible();

      await page.goto(`${consoleUrl}#/sqs/queues/redrive-dead/redrive-tasks`);
      await expect(page.getByRole("tab", { name: "Dead-letter queue redrive tasks" })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByText("No redrive tasks yet.")).toBeVisible();
      const panel = page.locator("[data-move-panel]");
      await panel.getByRole("button", { name: "Start DLQ redrive", exact: true }).click();
      let dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Redrive configuration" })).toBeVisible();
      const destination = dialog.getByRole("group", { name: "Message destination" });
      await expect(destination.getByRole("radio", { name: /^Redrive to source queue\(s\)/ })).toBeChecked();
      await destination.getByRole("radio", { name: /^Redrive to custom destination/ }).check();
      await selectArnSuggestion(dialog, "Destination queue ARN", "redrive-custom");
      const velocity = dialog.getByRole("group", { name: "Velocity control settings" });
      await expect(velocity.getByRole("radio", { name: /^System optimized/ })).toBeChecked();
      await velocity.getByRole("radio", { name: /^Custom max velocity/ }).check();
      await dialog.getByLabel("Maximum messages per second").fill("501");
      await dialog.getByRole("button", { name: "Redrive messages", exact: true }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Maximum messages per second").fill("1");
      await dialog.getByRole("button", { name: "Redrive messages", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      const history = page.locator("[data-move-history]");
      await expect(history).toContainText("RUNNING");
      await expect(history).toContainText("redrive-custom");
      await expect(page.getByText("Completion means messages reached their destination queue.", { exact: false })).toBeVisible();
      await page.getByRole("button", { name: "Cancel DLQ redrive", exact: true }).click();
      await expect(history).toContainText("CANCELLED");
      const tasks = (await client.send(new ListMessageMoveTasksCommand({ SourceArn: arn, MaxResults: 10 }))).Results!;
      expect(tasks[0].Status).toBe("CANCELLED"); expect(tasks[0].ApproximateNumberOfMessagesMoved).toBeLessThan(10);
      await expect(history).not.toContainText("private-work");
      expect(await scrollWidth(page)).toBe(390);

      // The Dead-letter queue tab keeps a summary of the latest task and offers the same action.
      await page.getByRole("tab", { name: "Dead-letter queue", exact: true }).click();
      const summary = card(page, "DLQ redrive");
      await expect(summary).toContainText("CANCELLED");
      await expect(summary.getByRole("link", { name: "View redrive tasks" })).toHaveAttribute("href", "#/sqs/queues/redrive-dead/redrive-tasks");
      await summary.getByRole("button", { name: "Start DLQ redrive", exact: true }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByRole("radio", { name: /^Redrive to custom destination/ }).check();
      await selectArnSuggestion(dialog, "Destination queue ARN", "redrive-custom");
      await dialog.getByRole("button", { name: "Redrive messages", exact: true }).click();
      await expect(page).toHaveURL(/#\/sqs\/queues\/redrive-dead\/redrive-tasks$/);
      await expect(page.locator("[data-move-history]")).toContainText("COMPLETED");
      await expect(page.locator("[data-move-history]")).toContainText("System optimized");
      expect(errors).toEqual([]);
    } finally { client.destroy(); }
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

    await page.goto(`${consoleUrl}#/sqs/queues/create`);
    await expectPanelHelp(page, "Configuration", "visibility timeout longer than normal processing time");
    await expectPanelHelp(page, "Access policy", "explicit Deny overrides an Allow");
    await expectPanelHelp(page, "Dead-letter queue", "poison messages");
    await expectPanelHelp(page, "Tags", "key-value labels");
    expect(await scrollWidth(page)).toBe(390);

    await createQueue(page, "tooltip-queue");
    await expectPanelHelp(page, "Configuration", "visibility timeout longer than normal processing time");
    await expectPanelHelp(page, "Fair queue behavior", "optional message group ID");
    await expectPanelHelp(page, "Tags", "key-value labels");

    await page.goto(`${consoleUrl}#/sqs/queues/tooltip-queue/messages`);
    await expectPanelHelp(page, "Send message", "Message attributes carry typed metadata");
    await expectPanelHelp(page, "Receive messages", "keeps receiving for the polling duration");
    await page.goto(`${consoleUrl}#/sqs/queues/tooltip-queue/sns-subscriptions`);
    await expectPanelHelp(page, "SNS subscriptions", "fan out to several queues");
    await page.goto(`${consoleUrl}#/sqs/queues/tooltip-queue/dead-letter`);
    await expectPanelHelp(page, "Dead-letter queue", "poison messages");
    await expectPanelHelp(page, "Redrive allow policy", "which source queues may target it");
    await page.goto(`${consoleUrl}#/sqs/queues/tooltip-queue/redrive-tasks`);
    await expectPanelHelp(page, "Dead-letter queue redrive tasks", "one task runs at a time");
    // The earlier addresses of the policy and tag tabs still open them.
    await page.goto(`${consoleUrl}#/sqs/queues/tooltip-queue/access-policy`);
    await expect(page.getByRole("tab", { name: "Queue policies" })).toHaveAttribute("aria-selected", "true");
    await expectPanelHelp(page, "Access policy", "explicit Deny overrides an Allow");
    await expectPanelHelp(page, "Redrive allow policy", "which source queues may target it");
    await page.goto(`${consoleUrl}#/sqs/queues/tooltip-queue/encryption`);
    await expectPanelHelp(page, "Encryption", "never claims that an AWS KMS key encrypted local data");
    await page.goto(`${consoleUrl}#/sqs/queues/tooltip-queue/tags`);
    await expect(page.getByRole("tab", { name: "Tagging" })).toHaveAttribute("aria-selected", "true");
    await expectPanelHelp(page, "Tags", "IAM resource-tag conditions");
    await page.goto(`${consoleUrl}#/sqs/queues/tooltip-queue/lambda-triggers`);
    await expectPanelHelp(page, "Lambda triggers", "partial batch responses");

    await createQueue(page, "tooltip-queue.fifo", { fifo: true });
    await expectPanelHelp(page, "FIFO configuration", "five-minute deduplication");
    expect(errors).toEqual([]);
  });

  test("creates, configures, inspects, purges, monitors, and deletes a Standard queue", async ({ page }) => {
    const errors = browserErrors(page); const client = new SQSClient(sdkOptions(simulator));
    try {
      await page.goto(`${consoleUrl}#/sqs/queues`);
      await expect(page.getByRole("heading", { name: "Queues", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "No queues" })).toBeVisible();
      await page.getByRole("link", { name: "Create queue" }).first().click();
      await expect(page).toHaveURL(/#\/sqs\/queues\/create$/);

      // The create page takes durations with units, a size in KiB and tags as key and value rows.
      await createQueue(page, "browser-jobs", {
        tags: { environment: "browser" },
        configure: async () => {
          await expect(page.getByLabel("Visibility timeout", { exact: true })).toHaveValue("30");
          await expect(page.getByLabel("Visibility timeout units")).toHaveValue("Seconds");
          await expect(page.getByLabel("Message retention period", { exact: true })).toHaveValue("4");
          await expect(page.getByLabel("Message retention period units")).toHaveValue("Days");
          await expect(page.getByLabel("Maximum message size", { exact: true })).toHaveValue("1024");
          await page.getByLabel("Visibility timeout", { exact: true }).fill("2");
          await page.getByLabel("Visibility timeout units").selectOption("Minutes");
          await page.getByLabel("Message retention period", { exact: true }).fill("1");
          await page.getByLabel("Maximum message size", { exact: true }).fill("256");
          await expect(page.getByRole("radio", { name: /^Basic/ })).toBeChecked();
          await expect(page.locator("[data-policy-preview]")).toContainText("arn:aws:sqs:eu-west-1:000000000000:browser-jobs");
          await expect(page.getByRole("radio", { name: /SSE-KMS/ })).toBeDisabled();
          await expect(page.getByRole("radio", { name: /^Amazon SQS key \(SSE-SQS\)/ })).toBeChecked();
        },
      });
      const created = await queueAttributes(client, "browser-jobs");
      expect(created.attributes.VisibilityTimeout).toBe("120");
      expect(created.attributes.MessageRetentionPeriod).toBe("86400");
      expect(created.attributes.MaximumMessageSize).toBe("262144");
      expect(created.attributes.SqsManagedSseEnabled).toBe("true");
      expect(JSON.parse(created.attributes.Policy!).Statement[0].Sid).toBe("__owner_statement");
      expect((await client.send(new ListQueueTagsCommand({ QueueUrl: created.url }))).Tags).toEqual({ environment: "browser" });

      // Durations and sizes are shown in words, with the exact value beside them.
      const configuration = card(page, "Configuration");
      await expect(configuration).toContainText("2 Minutes");
      await expect(configuration).toContainText("120 seconds");
      await expect(configuration).toContainText("1 Day");
      await expect(configuration).toContainText("256 KiB");
      const details = card(page, "Details");
      await expect(details).toContainText("Amazon SQS key (SSE-SQS)");
      await expect(details).toContainText("Dead-letter queue");
      await details.getByText("More", { exact: true }).click();
      await expect(details.getByText("Messages in flight (not available to other consumers)")).toBeVisible();
      await expect(page.getByText("environment", { exact: true })).toBeVisible();

      await page.getByRole("tab", { name: "Tagging" }).click();
      await page.getByRole("button", { name: "Manage tags" }).click();
      const tagDialog = page.getByRole("dialog");
      await expect(tagDialog.locator("[data-tag-row]")).toHaveCount(1);
      await addTagRow(tagDialog, "team", "workers");
      await tagDialog.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("workers", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Manage tags" }).click();
      await tagDialog.locator("[data-tag-row]").first().getByRole("button", { name: "Remove" }).click();
      await tagDialog.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("environment", { exact: true })).toHaveCount(0);
      expect((await client.send(new ListQueueTagsCommand({ QueueUrl: created.url }))).Tags).toEqual({ team: "workers" });

      // Send a message with an attribute row and read the sent-message details.
      await page.getByRole("link", { name: "Send and receive messages" }).click();
      await expect(page.getByRole("heading", { name: "Send and receive messages", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Add new attribute" }).click();
      const attributeRow = page.locator("[data-attribute-row]").first();
      await attributeRow.getByLabel("Name").fill("priority");
      await attributeRow.getByLabel("Type", { exact: true }).selectOption("Number");
      await attributeRow.getByLabel("Value").fill("10");
      await sendMessage(page, '{"job":"resize","source":"browser"}');
      await page.locator("[data-send-result]").getByRole("button", { name: "View details" }).click();
      const sentDialog = page.getByRole("dialog");
      await expect(sentDialog.getByRole("heading", { name: "Message details" })).toBeVisible();
      await expect(sentDialog).toContainText("MD5 of message body");
      await expect(sentDialog).toContainText("MD5 of message attributes");
      await sentDialog.getByRole("button", { name: "Done" }).click();
      await expect(sentDialog).toBeHidden();
      await expect(page.locator("[data-messages-available]")).toHaveText("1");

      // Received messages are listed in a table; a message opens in a dialog with three tabs.
      await useSingleShortPoll(page);
      await pollForMessages(page);
      const row = page.locator("[data-received-message]");
      await expect(row).toHaveCount(1);
      await expect(page.locator("[data-message-count]")).toHaveText("(1)");
      await expect(row.locator("[data-receive-count]")).toHaveText("1");
      await expect(page.locator("#sqs-poll-status")).toHaveText("1 message received");
      await row.locator("[data-view-message]").click();
      const messageDialog = page.getByRole("dialog");
      await expect(messageDialog.getByRole("heading", { name: /^Message: / })).toBeVisible();
      await expect(messageDialog.locator(".sqs-message-body")).toContainText('"job":"resize"');
      await messageDialog.getByRole("tab", { name: "Attributes" }).click();
      await expect(messageDialog.locator('[data-message-panel="attributes"]')).toContainText("priority");
      await expect(messageDialog.locator('[data-message-panel="attributes"]')).toContainText("Number");
      await messageDialog.getByRole("tab", { name: "Details" }).click();
      const detailsPanel = messageDialog.locator('[data-message-panel="details"]');
      await expect(detailsPanel).toContainText("Receive count");
      await expect(detailsPanel).toContainText("System attributes");
      await expect(detailsPanel).toContainText("ApproximateFirstReceiveTimestamp");
      await detailsPanel.getByLabel("Visibility timeout (seconds)").fill("0");
      await detailsPanel.getByRole("button", { name: "Change visibility" }).click();
      await expect(page.locator("#toast-region")).toContainText("Message visibility changed");
      await messageDialog.getByRole("button", { name: "Done" }).click();
      await expect(messageDialog).toBeHidden();
      await pollForMessages(page);
      await expect(row.locator("[data-receive-count]")).toHaveText("2");

      await expect(page.locator(".sqs-messages-card").getByRole("button", { name: "Delete" })).toBeDisabled();
      await row.getByRole("checkbox").check();
      await page.locator(".sqs-messages-card").getByRole("button", { name: "Delete" }).click();
      const deleteMessages = page.getByRole("dialog");
      await expect(deleteMessages.getByRole("heading", { name: "Delete Messages", exact: true })).toBeVisible();
      await deleteMessages.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByRole("heading", { name: "No messages" })).toBeVisible();
      await expect(page.locator("[data-messages-available]")).toHaveText("0");

      // A long poll shows its progress and can be stopped.
      await page.getByRole("button", { name: "Edit poll settings" }).click();
      const pollDialog = page.getByRole("dialog");
      await pollDialog.getByLabel("Polling duration").fill("30");
      await pollDialog.getByLabel("Wait time (seconds)").fill("20");
      await pollDialog.getByLabel("Poll attempts").fill("");
      await pollDialog.getByRole("button", { name: "Save" }).click();
      await expect(page.locator("[data-poll-duration]")).toHaveText("30 seconds");
      await page.getByRole("button", { name: "Poll for messages" }).click();
      await expect(page.getByRole("button", { name: "Stop polling" })).toBeEnabled();
      await expect(page.getByRole("progressbar", { name: "Polling progress" })).toBeVisible();
      await page.getByRole("button", { name: "Stop polling" }).click();
      await expect(page.locator("#sqs-poll-status")).toHaveText("Polling stopped");

      await page.getByRole("button", { name: "Clear content" }).click();
      await expect(page.getByLabel("Message body")).toHaveValue("");
      await expect(page.locator("[data-attribute-row]")).toHaveCount(0);
      for (const body of ["purge-one", "purge-two"]) await sendMessage(page, body);
      await page.getByRole("tab", { name: "Details" }).click();
      await expect(card(page, "Message state").locator(".metric")).toHaveText("2");
      await page.getByRole("button", { name: "Purge", exact: true }).click();
      await confirmWith(page, "Purge queue", "purge", "Purge");
      await expect(page.locator("#toast-region")).toContainText("Queue browser-jobs purged");
      await expect(card(page, "Message state").locator(".metric")).toHaveText("0");

      // One graph per metric, with the CloudWatch names.
      await page.getByRole("tab", { name: "Monitoring" }).click();
      await expect(page.getByRole("heading", { name: "SQS metrics" })).toBeVisible();
      await expect(page.getByRole("img", { name: "Number Of Messages Sent for browser-jobs" })).toBeVisible();
      await expect(page.getByRole("img", { name: "Approximate Age Of Oldest Message for browser-jobs" })).toBeVisible();
      await expect(page.locator(".sqs-metric-graph")).toHaveCount(11);
      await page.getByLabel("Time Range").selectOption({ label: "Last 3 Hours" });
      await expect(page.getByRole("img", { name: "Sent Message Size for browser-jobs" })).toBeVisible();
      await expect(page.getByRole("link", { name: "View all CloudWatch metrics" })).toHaveAttribute("href", "#/cloudwatch/metrics");
      await expect(page.locator(".sqs-metric-summary")).toContainText("Available");

      // The Basic method of the access policy keeps the owner statement and adds the named senders.
      await page.getByRole("tab", { name: "Queue policies" }).click();
      await expect(page.getByRole("heading", { name: "Effective-access diagnostics" })).toBeVisible();
      await expect(page.locator(".eventbridge-queue-policy")).toContainText("events.amazonaws.com");
      const policyCard = card(page, "Access policy");
      await expect(policyCard).toContainText("__owner_statement");
      await policyCard.getByRole("button", { name: "Edit", exact: true }).click();
      const policyDialog = page.getByRole("dialog");
      await expect(policyDialog.getByRole("radio", { name: /^Basic/ })).toBeChecked();
      const senders = policyDialog.getByRole("group", { name: "Define who can send messages to the queue" });
      await expect(senders.getByRole("radio", { name: /^Only the queue owner/ })).toBeChecked();
      await senders.getByRole("radio", { name: /^Only the specified AWS accounts, IAM users and roles/ }).check();
      await policyDialog.getByLabel("Accounts, users and roles that can send").fill("111122223333");
      await expect(policyDialog.locator("[data-policy-preview]")).toContainText("__sender_statement");
      await policyDialog.getByRole("radio", { name: /^Advanced/ }).check();
      await expect(policyDialog.getByLabel("Policy JSON")).toHaveValue(/__sender_statement/);
      await policyDialog.getByRole("radio", { name: /^Basic/ }).check();
      await policyDialog.getByRole("button", { name: "Save" }).click();
      await expect(policyDialog).toBeHidden();
      await expect(policyCard).toContainText("__sender_statement");
      await expect(page.getByText("Cross-account trust detected")).toBeVisible();
      await expect(card(page, "Redrive allow policy")).toContainText("Allow all");

      await page.getByRole("tab", { name: "Encryption" }).click();
      await expect(card(page, "Encryption")).toContainText("Amazon SQS key (SSE-SQS)");
      await expect(page.locator(".sqs-encryption")).toContainText("Enabled");
      await expect(page.locator(".sqs-encryption")).toContainText("neither an Amazon SQS key nor a customer managed KMS key");
      await page.getByRole("tab", { name: "EventBridge Pipes" }).click();
      await expect(page.getByRole("button", { name: "Connect Amazon SQS queue to pipe" })).toBeDisabled();
      await expect(page.getByRole("heading", { name: "EventBridge Pipes are not available in StackSim" })).toBeVisible();

      // The queue list selects a queue and acts on it from its toolbar.
      await page.goto(`${consoleUrl}#/sqs/queues`);
      const listCard = page.locator(".sqs-queues-page section.card");
      await expect(listCard.locator("thead th")).toHaveText(["Select", "Name", "Type", "Created", "Messages available", "Messages in flight", "Encryption", "Content-based deduplication", "Queue URL"]);
      await expect(listCard.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
      await expect(listCard.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
      await page.getByLabel("Select browser-jobs").check();
      await expect(listCard.getByRole("button", { name: "Edit", exact: true })).toBeEnabled();
      await expect(listCard.getByRole("button", { name: "Send and receive messages", exact: true })).toBeEnabled();
      await listCard.getByText("Actions ▾").click();
      await expect(listCard.getByRole("menuitem", { name: "Send and receive messages" })).toBeEnabled();
      await expect(listCard.getByRole("menuitem", { name: "Subscribe to Amazon SNS topic" })).toBeEnabled();
      await expect(listCard.getByRole("menuitem", { name: "Configure Lambda function trigger" })).toBeEnabled();
      await expect(listCard.getByRole("menuitem", { name: "Start DLQ redrive" })).toBeDisabled();
      await listCard.getByRole("menuitem", { name: "Purge" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
      await listCard.getByRole("button", { name: "Delete", exact: true }).click();
      const deleteDialog = page.getByRole("dialog");
      await deleteDialog.getByLabel(/enter delete$/).fill("browser-jobs");
      await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(deleteDialog).toBeVisible();
      await confirmWith(page, "Delete queue", "delete", "Delete");
      await expect(page).toHaveURL(/#\/sqs\/queues$/);
      await expect(page.getByRole("heading", { name: "No queues" })).toBeVisible();
      expect(errors).toEqual([]);
    } finally { client.destroy(); }
  });

  test("creates a queue with a dead-letter queue and configures a Lambda function trigger", async ({ page }) => {
    const errors = browserErrors(page); const client = new SQSClient(sdkOptions(simulator));
    try {
      await createLambdaWorker("browser-sqs-worker");
      await createQueue(page, "browser-dlq");
      await expect(page.getByRole("button", { name: "Start DLQ redrive", exact: true })).toBeDisabled();

      // The dead-letter queue and its maximum receives are set while the queue is created.
      await createQueue(page, "browser-source", {
        configure: async () => {
          const deadLetter = page.getByRole("group", { name: "Set this queue to receive undeliverable messages" });
          await expect(deadLetter.getByLabel("Disabled")).toBeChecked();
          await deadLetter.getByLabel("Enabled").check();
          await expect(page.getByRole("heading", { name: "Dead-letter queue settings" })).toBeVisible();
          await selectArnSuggestion(page, "Choose queue", "browser-dlq");
          await expect(page.getByLabel("Maximum receives")).toHaveValue("10");
          await page.getByLabel("Maximum receives").fill("3");
        },
      });
      const source = await queueAttributes(client, "browser-source");
      expect(JSON.parse(source.attributes.RedrivePolicy!)).toMatchObject({ deadLetterTargetArn: "arn:aws:sqs:eu-west-1:000000000000:browser-dlq" });
      expect(Number(JSON.parse(source.attributes.RedrivePolicy!).maxReceiveCount)).toBe(3);
      await expect(card(page, "Details")).toContainText("Enabled · browser-dlq");

      await page.getByRole("tab", { name: "Dead-letter queue", exact: true }).click();
      const redriveCard = card(page, "Dead-letter queue");
      await expect(redriveCard.getByText("browser-dlq", { exact: true })).toBeVisible();
      await expect(redriveCard.getByText("3", { exact: true })).toBeVisible();
      await redriveCard.getByRole("button", { name: "Configure" }).click();
      const redriveDialog = page.getByRole("dialog");
      await expect(redriveDialog.getByRole("heading", { name: "Dead-letter queue settings" })).toBeVisible();
      await expect(redriveDialog.getByLabel("Enabled")).toBeChecked();
      await expect(redriveDialog.getByRole("combobox", { name: "Choose queue" })).toHaveValue("arn:aws:sqs:eu-west-1:000000000000:browser-dlq");
      await redriveDialog.getByLabel("Maximum receives").fill("5");
      await redriveDialog.getByRole("button", { name: "Save" }).click();
      await expect(redriveCard.getByText("5", { exact: true })).toBeVisible();

      await page.goto(`${consoleUrl}#/sqs/queues/browser-dlq/dead-letter`);
      await expect(page.getByRole("heading", { name: "Source queues" })).toBeVisible();
      await expect(page.getByRole("link", { name: "browser-source", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Start DLQ redrive", exact: true }).first()).toBeEnabled();
      const allowCard = card(page, "Redrive allow policy");
      await expect(allowCard).toContainText("Disabled");
      await allowCard.getByRole("button", { name: "Configure" }).click();
      const allowDialog = page.getByRole("dialog");
      await expect(allowDialog.getByLabel("Redrive permission").locator("option")).toHaveText(["Allow all", "By queue", "Deny all"]);
      await allowDialog.getByLabel("Redrive permission").selectOption("byQueue");
      await expect(allowDialog.getByLabel("Enabled")).toBeChecked();
      await addArnComboboxValue(allowDialog.getByLabel("Allowed source queue ARNs"), "arn:aws:sqs:eu-west-1:000000000000:browser-source");
      await allowDialog.getByRole("button", { name: "Save" }).click();
      await expect(allowCard).toContainText("By queue");
      await expect(allowCard).toContainText("browser-source");
      await expect(allowCard).not.toContainText("byQueue");

      await page.goto(`${consoleUrl}#/sqs/queues/browser-source/lambda-triggers`);
      await expect(page.getByRole("heading", { name: /^Lambda triggers/ })).toBeVisible();
      await page.getByRole("button", { name: "Configure Lambda function trigger" }).first().click();
      const triggerDialog = page.getByRole("dialog");
      await expect(triggerDialog.getByRole("heading", { name: "Configure Lambda function trigger" })).toBeVisible();
      await expect(triggerDialog).toContainText("sqs:ReceiveMessage");
      await expect(triggerDialog).toContainText("sqs:GetQueueAttributes");
      await expect(triggerDialog).not.toContainText("sqs:ChangeMessageVisibility");
      await triggerDialog.getByLabel("Batch size").fill("11");
      await triggerDialog.getByLabel("Batching window (seconds)").fill("1");
      await triggerDialog.getByLabel("Maximum concurrency (optional)").fill("2");
      await triggerDialog.getByLabel("Report partial batch item failures").check();
      await triggerDialog.getByLabel("Filter pattern (optional JSON)").fill('{"body":{"job":["ready"]}}');
      await triggerDialog.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("link", { name: "browser-sqs-worker" })).toHaveAttribute("href", "#/lambda/functions/browser-sqs-worker");
      await expect(page.locator(".sqs-lambda-triggers")).toContainText("11 · 1s");
      await expect(page.locator(".sqs-lambda-triggers")).toContainText("Enabled");
      await expect(page.locator(".sqs-lambda-triggers")).toContainText("2");

      await page.goto(`${consoleUrl}#/lambda/functions/browser-sqs-worker`);
      const sourceRow = page.locator(".trigger-card tbody tr").filter({ has: page.getByRole("link", { name: "browser-source", exact: true }) });
      await expect(sourceRow).toContainText("SQS queue");
      await expect(sourceRow).toContainText("Maximum concurrency: 2");
      await sourceRow.getByRole("button", { name: "Edit" }).click();
      let functionDialog = page.getByRole("dialog");
      await expect(functionDialog).not.toContainText("sqs:ChangeMessageVisibility");
      await expect(functionDialog.getByLabel("Maximum concurrency (optional)")).toHaveValue("2");
      await expect(functionDialog.getByLabel("Starting position")).toHaveCount(0);
      await expect(functionDialog.getByLabel("Parallelization factor")).toHaveCount(0);
      await functionDialog.getByLabel("Maximum concurrency (optional)").fill("");
      await functionDialog.getByLabel("Report partial batch item failures").uncheck();
      await functionDialog.getByRole("button", { name: "Save" }).click();
      await expect(sourceRow).toContainText("Maximum concurrency: Unbounded");
      await expect(sourceRow).toContainText("Partial failures: Full batch");

      await createQueue(page, "browser-secondary");
      await page.goto(`${consoleUrl}#/lambda/functions/browser-sqs-worker`);
      await page.getByRole("button", { name: "Add trigger" }).first().click();
      functionDialog = page.getByRole("dialog");
      await expect(functionDialog.getByLabel("Trigger type")).toHaveValue("sqs");
      await selectArnSuggestion(functionDialog, "SQS queue", "browser-secondary");
      await functionDialog.getByRole("button", { name: "Add" }).click();
      await expect(page.locator(".trigger-card").getByRole("link", { name: "browser-secondary", exact: true })).toBeVisible();

      // A queue that is in use as a dead-letter queue can be deleted; the trigger of a deleted queue stays.
      await page.goto(`${consoleUrl}#/sqs/queues/browser-secondary/details`);
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await confirmWith(page, "Delete queue", "delete", "Delete");
      await expect(page).toHaveURL(/#\/sqs\/queues$/);
      await expect(page.getByRole("link", { name: "browser-secondary", exact: true })).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally { client.destroy(); }
  });

  test("subscribes a queue to SNS topics and lists the subscriptions", async ({ page }) => {
    const errors = browserErrors(page); const client = new SQSClient(sdkOptions(simulator)); const topics = new SNSClient(sdkOptions(simulator));
    try {
      const orders = (await topics.send(new CreateTopicCommand({ Name: "browser-orders" }))).TopicArn!;
      const audit = (await topics.send(new CreateTopicCommand({ Name: "browser-audit" }))).TopicArn!;
      await createQueue(page, "browser-fanout");

      await page.getByRole("tab", { name: "SNS subscriptions" }).click();
      await expect(page.getByRole("heading", { name: "No SNS subscriptions" })).toBeVisible();
      await page.getByRole("button", { name: "Subscribe to Amazon SNS topic" }).first().click();
      let dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Subscribe to Amazon SNS topic" })).toBeVisible();
      await dialog.getByLabel("Specify an Amazon SNS topic available for this queue").selectOption(orders);
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toBeHidden();
      const subscriptions = card(page, /^SNS subscriptions/);
      await expect(subscriptions.locator("tbody tr")).toHaveCount(1);
      await expect(subscriptions).toContainText(orders);
      await expect(subscriptions).toContainText("Allows this topic");
      await expect(subscriptions.getByRole("link", { name: orders })).toHaveAttribute("href", "#/sns/topics/browser-orders");

      // The second subscription starts from the queue list and takes a typed topic ARN.
      await page.goto(`${consoleUrl}#/sqs/queues`);
      await page.getByLabel("Select browser-fanout").check();
      await page.getByText("Actions ▾").click();
      await page.getByRole("menuitem", { name: "Subscribe to Amazon SNS topic" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Specify an Amazon SNS topic available for this queue").selectOption({ label: "Enter Amazon SNS topic ARN" });
      const topicArn = dialog.getByRole("combobox", { name: "Amazon SNS topic ARN" });
      await topicArn.fill(audit);
      await topicArn.press("Escape");
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(page).toHaveURL(/#\/sqs\/queues\/browser-fanout\/sns-subscriptions$/);
      await expect(card(page, /^SNS subscriptions/).locator("tbody tr")).toHaveCount(2);

      // Both statements were merged into the policy the queue was created with.
      const { url, attributes } = await queueAttributes(client, "browser-fanout");
      const sids = JSON.parse(attributes.Policy!).Statement.map((statement: { Sid: string }) => statement.Sid);
      expect(sids).toEqual(["__owner_statement", `topic-subscription-${orders}`, `topic-subscription-${audit}`]);
      await page.getByRole("tab", { name: "Queue policies" }).click();
      await expect(card(page, "Access policy")).toContainText("sns.amazonaws.com");

      await topics.send(new PublishCommand({ TopicArn: orders, Message: "fan-out works" }));
      const received = await client.send(new ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 5 }));
      expect(received.Messages?.[0]?.Body).toContain("fan-out works");
      expect(errors).toEqual([]);
    } finally { client.destroy(); topics.destroy(); }
  });

  test("creates, edits and operates a FIFO queue with group-aware DLQ and Lambda guidance", async ({ page }) => {
    const errors = browserErrors(page); const client = new SQSClient(sdkOptions(simulator));
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await createLambdaWorker("browser-fifo-worker");
      await createQueue(page, "browser-fifo-dlq.fifo", { fifo: true });
      await createQueue(page, "browser-orders.fifo", {
        fifo: true,
        configure: async () => {
          await expect(page.getByLabel("Deduplication scope")).toHaveValue("queue");
          await page.getByLabel("Enable high throughput FIFO").check();
          await expect(page.getByLabel("Deduplication scope")).toHaveValue("messageGroup");
          await expect(page.getByLabel("FIFO throughput limit")).toHaveValue("perMessageGroupId");
        },
      });
      const created = await queueAttributes(client, "browser-orders.fifo");
      expect(created.attributes.FifoQueue).toBe("true");
      expect(created.attributes.DeduplicationScope).toBe("messageGroup");
      expect(created.attributes.FifoThroughputLimit).toBe("perMessageGroupId");
      await expect(page.getByText("FIFO", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("Queue type and the .fifo suffix are immutable.")).toBeVisible();
      await expect(card(page, "FIFO configuration")).toContainText("Per message group ID");

      // The edit page has the sections of the create page; the type and name are fixed.
      await page.getByRole("link", { name: "Edit", exact: true }).click();
      await expect(page).toHaveURL(/#\/sqs\/queues\/browser-orders\.fifo\/edit$/);
      await expect(page.getByRole("heading", { name: "Edit browser-orders.fifo" })).toBeVisible();
      await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Enable high throughput FIFO")).toBeChecked();
      await page.getByLabel("Visibility timeout", { exact: true }).fill("1");
      await page.getByLabel("Visibility timeout units").selectOption("Minutes");
      const deadLetter = page.getByRole("group", { name: "Set this queue to receive undeliverable messages" });
      await deadLetter.getByLabel("Enabled").check();
      await selectArnSuggestion(page, "Choose queue", "browser-fifo-dlq.fifo");
      await addTagRow(page, "stage", "edit");
      expect(await scrollWidth(page)).toBe(390);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page).toHaveURL(/#\/sqs\/queues\/browser-orders\.fifo\/details$/);
      await expect(card(page, "Configuration")).toContainText("1 Minute");
      await expect(card(page, "Details")).toContainText("Enabled · browser-fifo-dlq.fifo");
      const edited = await queueAttributes(client, "browser-orders.fifo");
      expect(edited.attributes.VisibilityTimeout).toBe("60");
      expect(JSON.parse(edited.attributes.RedrivePolicy!).deadLetterTargetArn).toBe("arn:aws:sqs:eu-west-1:000000000000:browser-fifo-dlq.fifo");
      expect(JSON.parse(edited.attributes.Policy!).Statement).toHaveLength(1);
      expect((await client.send(new ListQueueTagsCommand({ QueueUrl: edited.url }))).Tags).toEqual({ stage: "edit" });

      await page.getByRole("tab", { name: "Send and receive messages" }).click();
      await expect(page.getByLabel("Delivery delay", { exact: true })).toHaveCount(0);
      await page.getByLabel("Message group ID").fill("tenant-a");
      await sendMessage(page, '{"order":"fifo-browser"}');
      await useSingleShortPoll(page);
      await pollForMessages(page);
      await page.locator("[data-received-message]").locator("[data-view-message]").click();
      let dialog = page.getByRole("dialog");
      await dialog.getByRole("tab", { name: "Details" }).click();
      await expect(dialog.locator('[data-message-panel="details"]')).toContainText("tenant-a");
      await expect(dialog.locator('[data-message-panel="details"]')).toContainText("Sequence number");
      await dialog.getByRole("button", { name: "Done" }).click();

      await page.getByRole("tab", { name: "Lambda triggers" }).click();
      await expect(page.getByText("FIFO group ordering", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Configure Lambda function trigger" }).first().click();
      dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("Batch size")).toHaveAttribute("max", "10");
      await expect(dialog.getByLabel("Batching window (seconds)")).toHaveAttribute("readonly", "");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      expect(await scrollWidth(page)).toBe(390);
      expect(errors).toEqual([]);
    } finally { client.destroy(); }
  });

  test("keeps queue workflows usable at a narrow viewport", async ({ page }) => {
    const errors = browserErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${consoleUrl}#/sqs/queues/create`);
    expect(await scrollWidth(page)).toBe(390);
    await createQueue(page, "narrow-browser-queue");
    await expect(page.getByRole("tab", { name: "Send and receive messages" })).toBeVisible();
    expect(await scrollWidth(page)).toBe(390);

    await page.getByRole("tab", { name: "Send and receive messages" }).click();
    await sendMessage(page, '{"job":"narrow-workflow"}');
    await useSingleShortPoll(page);
    await pollForMessages(page);
    const message = page.locator("[data-received-message]");
    await expect(message).toHaveCount(1);
    await expect(message.locator("[data-receive-count]")).toHaveText("1");
    expect(await scrollWidth(page)).toBe(390);

    // Polling again retrieves the same message: the console does not keep it hidden.
    await pollForMessages(page);
    await expect(message.locator("[data-receive-count]")).toHaveText("2");

    await message.locator("[data-view-message]").click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.locator(".sqs-message-body")).toContainText("narrow-workflow");
    await dialog.getByRole("tab", { name: "Details" }).click();
    await dialog.getByLabel("Visibility timeout (seconds)").fill("45");
    await dialog.getByRole("button", { name: "Change visibility" }).click();
    await expect(page.locator("#toast-region")).toContainText("Message visibility changed");
    await dialog.getByRole("button", { name: "Done" }).click();
    await page.getByLabel("Select all messages").check();
    await page.locator(".sqs-messages-card").getByRole("button", { name: "Delete" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Delete Messages", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No messages" })).toBeVisible();

    await sendMessage(page, "purge-from-narrow-workflow");
    expect(await scrollWidth(page)).toBe(390);

    await page.getByRole("tab", { name: "Details" }).click();
    await page.getByRole("button", { name: "Purge", exact: true }).click();
    await confirmWith(page, "Purge queue", "purge", "Purge");
    await expect(page.locator("#toast-region")).toContainText("Queue narrow-browser-queue purged");

    await page.getByRole("tab", { name: "Queue policies" }).click();
    await expect(page.getByRole("heading", { name: "Access policy", exact: true })).toBeVisible();
    await expect(page.locator(".sqs-access-policy")).toContainText("IAM and resource-policy authorization are active");
    await expect(page.locator(".eventbridge-queue-policy")).toContainText("events.amazonaws.com");
    await page.getByRole("button", { name: "Add statement" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Source ARN condition (optional)").fill("arn:aws:events:eu-west-1:000000000000:rule/orders");
    await dialog.getByRole("button", { name: "Add statement" }).click();
    await expect(page.locator(".sqs-access-policy")).toContainText("AllowEventBridgeRule");
    await expect(card(page, "Access policy")).toContainText("__owner_statement");
    expect(await scrollWidth(page)).toBe(390);

    await page.getByRole("tab", { name: "Encryption" }).click();
    await expect(page.locator(".sqs-encryption")).toContainText("SSE-KMS is an explicit dependency");
    await card(page, "Encryption").getByRole("button", { name: "Edit", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("radio", { name: /SSE-KMS/ })).toBeDisabled();
    await dialog.getByRole("group", { name: "Server-side encryption" }).getByLabel("Disabled").check();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".sqs-encryption")).toContainText("SqsManagedSseEnabled");
    await expect(page.locator(".sqs-encryption")).toContainText("false");
    await expect(card(page, "Encryption")).toContainText("Disabled");

    for (const section of ["sns-subscriptions", "eventbridge-pipes", "dead-letter", "monitoring", "tagging", "lambda-triggers", "redrive-tasks"]) {
      await page.goto(`${consoleUrl}#/sqs/queues/narrow-browser-queue/${section}`);
      await expect(page.getByRole("heading", { name: "narrow-browser-queue", exact: true })).toBeVisible();
      expect(await scrollWidth(page), section).toBe(390);
    }
    await page.goto(`${consoleUrl}#/sqs/queues`);
    await page.getByLabel("Select narrow-browser-queue").check();
    await page.getByText("Actions ▾").click();
    await expect(page.getByRole("menuitem", { name: "Purge" })).toBeVisible();
    expect(await scrollWidth(page)).toBe(390);
    await page.getByText("Actions ▾").click();

    await page.goto(`${consoleUrl}#/sqs/queues/narrow-browser-queue/details`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await confirmWith(page, "Delete queue", "delete", "Delete");
    await expect(page).toHaveURL(/#\/sqs\/queues$/);
    expect(errors).toEqual([]);
  });
});
