import { expect, test, type Page } from "@playwright/test";
import {
  CreateQueueCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { CreateTopicCommand, ListTopicsCommand, SNSClient } from "@aws-sdk/client-sns";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;
let sqs: SQSClient;
let sns: SNSClient;
let queueUrl: string;

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
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

test.describe("SNS-02/SNS-03 console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-sns-console-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "off" });
    await simulator.start();
    const options = {
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials: { accessKeyId: "admin", secretAccessKey: "password" },
    };
    sqs = new SQSClient(options);
    sns = new SNSClient(options);
    queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "browser-sns-orders" }))).QueueUrl!;
    consoleUrl = `${options.endpoint}/_stacksim/console`;
  });

  test.afterEach(async () => {
    sqs.destroy();
    sns.destroy();
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("explains SNS input panels and support boundaries", async ({ page }) => {
    const errors = browserErrors(page);
    await sns.send(new CreateTopicCommand({
      Name: "tooltip-topic",
      Tags: [{ Key: "environment", Value: "browser" }],
    }));
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto(`${consoleUrl}#/sns/topics`);
    const topicsTooltip = await expectPanelHelp(page, "Topics", "fans it out to every matching subscription");
    await expect(topicsTooltip).toContainText("FIFO topics");
    const bounds = await topicsTooltip.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);

    await page.goto(`${consoleUrl}#/sns/topics/tooltip-topic`);
    await expectPanelHelp(page, "Topic details", "Acceptance means SNS stored the message");
    await expectPanelHelp(page, "Tags", "key-value labels");
    await expectPanelHelp(page, "Subscriptions", "raw SQS delivery");

    await page.goto(`${consoleUrl}#/sns/subscriptions`);
    await expectPanelHelp(page, "Subscriptions", "open the linked topic");
    expect(errors).toEqual([]);
  });

  for (const viewport of [
    { label: "desktop", width: 1440, height: 900 },
    { label: "narrow", width: 390, height: 844 },
  ]) test(`creates, subscribes, publishes, monitors, and deletes a Standard topic at ${viewport.label} width`, async ({ page }) => {
    const errors = browserErrors(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${consoleUrl}#/sns/topics`);
    await expect(page.getByRole("heading", { name: "Topics", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No topics" })).toBeVisible();

    await page.getByRole("button", { name: "Create topic" }).first().click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Topic name").fill("browser-orders");
    await dialog.getByLabel("Signature version").selectOption("2");
    await dialog.getByLabel("Tags (JSON object)").fill('{"environment":"browser"}');
    await dialog.getByRole("button", { name: "Create topic" }).click();
    await expect(page).toHaveURL(/#\/sns\/topics\/browser-orders$/);
    await expect(page.getByText("environment", { exact: true })).toBeVisible();

    const TopicArn = (await sns.send(new ListTopicsCommand({}))).Topics?.[0].TopicArn!;
    const QueueArn = `arn:aws:sqs:${region}:${accountId}:browser-sns-orders`;
    await sqs.send(new SetQueueAttributesCommand({
      QueueUrl: queueUrl,
      Attributes: {
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Principal: { Service: "sns.amazonaws.com" },
            Action: "sqs:SendMessage",
            Resource: QueueArn,
            Condition: {
              ArnEquals: { "aws:SourceArn": TopicArn },
              StringEquals: { "aws:SourceAccount": accountId },
            },
          }],
        }),
      },
    }));

    await page.getByRole("button", { name: "Create subscription" }).first().click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Protocol").selectOption("sqs");
    await dialog.getByLabel("Endpoint ARN").fill(QueueArn);
    await dialog.getByLabel("Filter policy (JSON, optional)").fill('{"kind":["created"]}');
    await dialog.getByLabel("Filter scope").selectOption("MessageAttributes");
    await dialog.getByLabel("Raw SQS delivery").check();
    await dialog.getByRole("button", { name: "Create subscription" }).click();
    await expect(page.getByRole("link", { name: QueueArn })).toHaveAttribute("href", "#/sqs/queues/browser-sns-orders/details");
    await expect(page.locator(".sns-resource-table")).toContainText("MessageAttributes");
    await expect(page.locator(".sns-resource-table")).toContainText("true");

    await page.getByRole("button", { name: "Configure", exact: true }).first().click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Signature version")).toHaveValue("2");
    await expect(dialog.getByLabel("Topic policy")).toContainText("SNS:Publish");
    await expect(dialog.getByLabel("SQS success feedback role ARN")).toBeVisible();
    await dialog.getByRole("button", { name: "Save" }).click();

    await page.getByRole("button", { name: "Configure", exact: true }).last().click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Filter policy (JSON, empty removes)")).toHaveValue('{"kind":["created"]}');
    await expect(dialog.getByLabel("Raw SQS delivery")).toBeChecked();
    await expect(dialog.getByLabel("Dead-letter queue ARN (empty removes)")).toBeVisible();
    await dialog.getByRole("button", { name: "Save" }).click();

    await page.getByRole("button", { name: "Publish message" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Message", { exact: true }).fill("browser-payload");
    await dialog.getByLabel("Subject (optional)").fill("Browser message");
    await dialog.getByLabel("Message group ID (optional)").fill("tenant-a");
    await dialog.getByLabel("Message attributes (JSON object)").fill('{"kind":{"DataType":"String","StringValue":"created"}}');
    await dialog.getByRole("button", { name: "Publish" }).click();
    await expect(page.locator("#toast-region")).toContainText("Message accepted");

    let received;
    for (let attempt = 0; attempt < 30 && !received; attempt++) {
      received = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1 }))).Messages?.[0];
      if (!received) await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(received).toBeTruthy();
    expect(received!.Body).toBe("browser-payload");

    await page.getByRole("tab", { name: "Monitoring" }).click();
    await expect(page.getByRole("heading", { name: "Monitoring" })).toBeVisible();
    await expect(page.getByRole("img", { name: "SNS activity for browser-orders" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Retained delivery diagnostics" })).toBeVisible();
    await expect(page.locator(".sns-health-table")).not.toContainText("browser-payload");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);

    await page.getByRole("tab", { name: "Details" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm deletion, enter browser-orders/).fill("browser-orders");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/#\/sns\/topics$/);
    await expect(page.getByRole("heading", { name: "No topics" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
