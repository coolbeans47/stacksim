import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "unknown error";
    errors.push(`requestfailed: ${request.method()} ${request.url()} (${failure})`);
  });
  page.on("response", response => {
    if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
  });
  return errors;
}

async function expectNarrowContainment(page: Page): Promise<void> {
  expect(await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }))).toEqual({ viewport: 390, document: 390 });
}

test.describe("SES console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-ses-console-"));
    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir,
      region: "eu-west-1",
      authMode: "off",
    });
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
  });

  test.afterEach(async ({ page }) => {
    await page.context().close();
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("verifies a sender, sends a stored template, manages Inbox state, and fits narrow routes", async ({ page }) => {
    test.setTimeout(90_000);
    const errors = browserErrors(page);
    const identity = "browser-sender@example.test";
    const recipient = "browser-recipient@example.test";
    const template = "BrowserWelcome";
    const configurationSet = "browser_config";

    await page.goto(`${consoleUrl}#/ses`);
    await expect(page.locator("main h1")).toHaveText("SES");
    await expect(page.getByText("Local capture only", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Account status" })).toBeVisible();

    await page.goto(`${consoleUrl}#/ses/identities`);
    await expect(page.locator("main h1")).toHaveText("Verified identities");
    await page.getByRole("button", { name: "Create identity" }).first().click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Email address or domain").fill(identity);
    await dialog.getByLabel("Tags (JSON object)").fill('{"suite":"browser"}');
    await dialog.getByRole("button", { name: "Create identity" }).click();
    await expect(page).toHaveURL(new RegExp(`#\\/ses\\/identities\\/${encodeURIComponent(identity)}$`));
    await expect(page.locator("main h1")).toHaveText(identity);
    await expect(page.getByText("Check the local Inbox", { exact: true })).toBeVisible();
    await expect(page.locator("main")).toContainText("PENDING");

    await page.goto(`${consoleUrl}#/ses/inbox`);
    const verificationSubject = page.getByRole("link", { name: "SES email address verification request" });
    await expect(verificationSubject).toBeVisible();
    await verificationSubject.click();
    await expect(page.locator("main h1")).toHaveText("SES email address verification request");
    const verificationLink = page.locator('.ses-text-body a[href*="/_stacksim/ses/verify-email/"]');
    await expect(verificationLink).toBeVisible();
    const verificationPagePromise = page.waitForEvent("popup");
    await verificationLink.click();
    const verificationPage = await verificationPagePromise;
    await expect(verificationPage.getByRole("heading", { name: "Email verification" })).toBeVisible();
    await expect(verificationPage.getByText("The email identity is verified for local use.")).toBeVisible();
    await verificationPage.close();

    await page.goto(`${consoleUrl}#/ses/identities/${encodeURIComponent(identity)}`);
    await expect(page.locator("main")).toContainText("SUCCESS");
    await expect(page.getByText("Yes", { exact: true })).toBeVisible();

    await page.goto(`${consoleUrl}#/ses/configuration-sets`);
    await expect(page.locator("main h1")).toHaveText("Configuration sets");
    await page.getByRole("button", { name: "Create configuration set" }).first().click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Configuration set name").fill(configurationSet);
    await dialog.getByLabel("Tags (JSON object)").fill('{"suite":"browser"}');
    await dialog.getByRole("button", { name: "Create configuration set" }).click();
    await expect(page).toHaveURL(new RegExp(`#\\/ses\\/configuration-sets\\/${configurationSet}$`));
    await expect(page.locator("main h1")).toHaveText(configurationSet);
    await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pause sending" }).click();
    await expect(page.getByRole("button", { name: "Enable sending" })).toBeVisible();
    await page.getByRole("button", { name: "Enable sending" }).click();
    await expect(page.getByRole("button", { name: "Pause sending" })).toBeVisible();

    await page.goto(`${consoleUrl}#/ses/templates`);
    await expect(page.locator("main h1")).toHaveText("Email templates");
    await page.getByRole("button", { name: "Create template" }).first().click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Template name").fill(template);
    await dialog.getByLabel("Subject").fill("Welcome {{name}}");
    await dialog.getByLabel("Text body").fill("Hello {{name}} from the browser test");
    await dialog.getByLabel("HTML body").fill("<p>Hello <strong>{{name}}</strong> from the browser test</p>");
    await dialog.getByLabel("Tags (JSON object)").fill('{"suite":"browser"}');
    await dialog.getByRole("button", { name: "Create template" }).click();
    await expect(page).toHaveURL(new RegExp(`#\\/ses\\/templates\\/${template}$`));
    await expect(page.locator("main h1")).toHaveText(template);
    await page.locator("#ses-test-render").getByLabel("Template data (JSON object)").fill('{"name":"Ada"}');
    await page.getByRole("button", { name: "Render template" }).click();
    await expect(page.locator(".ses-render-output")).toContainText("Welcome Ada");
    await expect(page.locator(".ses-render-output")).toContainText("Hello Ada from the browser test");

    await page.locator("main").getByRole("link", { name: "Send test email" }).click();
    const sendForm = page.locator("#ses-send-test");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(sendForm).toBeVisible();
    await expect(sendForm.getByLabel("From email address")).toHaveValue(identity);
    await sendForm.getByLabel("To", { exact: true }).fill(recipient);
    await sendForm.getByLabel("Configuration set", { exact: true }).selectOption(configurationSet);
    await sendForm.getByLabel("Template data (JSON object)", { exact: true }).fill('{"name":"Ada"}');
    await sendForm.getByRole("button", { name: "Send test email" }).click();
    await expect(page.locator("main h1")).toHaveText("Welcome Ada");
    await expect(page.locator(".ses-text-body")).toContainText("Hello Ada from the browser test");
    await expect(page.getByRole("link", { name: template, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: configurationSet, exact: true })).toBeVisible();

    await page.goto(`${consoleUrl}#/ses/inbox`);
    const filter = page.locator("#ses-inbox-filter");
    await filter.getByLabel("Exact envelope recipient").fill(recipient);
    await filter.getByRole("button", { name: "Apply filter" }).click();
    await expect(page).toHaveURL(new RegExp(`#\\/ses\\/inbox\\?recipient=${encodeURIComponent(recipient)}$`));
    const messageRow = page.locator(".ses-inbox-table tbody tr");
    await expect(messageRow).toHaveCount(1);
    await expect(messageRow).toContainText("Welcome Ada");
    await messageRow.getByRole("button", { name: "Mark unread" }).click();
    await expect(messageRow).toContainText("Unread");
    await messageRow.getByRole("button", { name: "Mark read" }).click();
    await expect(messageRow).toContainText("Read");
    await messageRow.getByRole("button", { name: "Trash" }).click();
    await expect(page.getByRole("heading", { name: "No mail for this recipient" })).toBeVisible();
    await filter.getByLabel("Mailbox view").selectOption("trash");
    await filter.getByRole("button", { name: "Apply filter" }).click();
    await expect(page.locator("main h1")).toHaveText("Trash");
    await expect(page.locator(".ses-inbox-table tbody tr")).toContainText("Welcome Ada");

    await page.setViewportSize({ width: 390, height: 844 });
    const narrowRoutes = [
      { hash: "#/ses", heading: "SES" },
      { hash: "#/ses/identities", heading: "Verified identities" },
      { hash: `#/ses/identities/${encodeURIComponent(identity)}`, heading: identity },
      { hash: "#/ses/inbox?status=trash", heading: "Trash" },
      { hash: "#/ses/templates", heading: "Email templates" },
      { hash: `#/ses/templates/${template}`, heading: template },
      { hash: "#/ses/configuration-sets", heading: "Configuration sets" },
      { hash: `#/ses/configuration-sets/${configurationSet}`, heading: configurationSet },
    ];
    for (const route of narrowRoutes) {
      await page.goto(`${consoleUrl}${route.hash}`);
      await expect(page.locator("main h1")).toHaveText(route.heading);
      await expectNarrowContainment(page);
    }

    expect(errors).toEqual([]);
  });

  test("SES-04 suppression, contacts, and statistics routes are functional", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/ses/suppression`);
    await expect(page.locator("main h1")).toHaveText("Suppression list");
    await page.getByRole("button", { name: "Add email address" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Email address").fill("blocked@example.test");
    await dialog.getByLabel("Reason").selectOption("BOUNCE");
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText("blocked@example.test", { exact: true })).toBeVisible();

    await page.goto(`${consoleUrl}#/ses/contact-lists`);
    await page.getByRole("button", { name: "Create contact list" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("customers");
    await page.getByRole("dialog").getByLabel("Topics (JSON array)").fill('[{"TopicName":"news","DisplayName":"News","DefaultSubscriptionStatus":"OPT_IN"}]');
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    await expect(page.locator("main h1")).toHaveText("customers");
    await page.getByRole("button", { name: "Add contact" }).click();
    await page.getByRole("dialog").getByLabel("Email address").fill("reader@example.test");
    await page.getByRole("dialog").getByLabel("Topic preferences (JSON array)").fill('[{"TopicName":"news","SubscriptionStatus":"OPT_OUT"}]');
    await page.getByRole("dialog").getByRole("button", { name: "Add" }).click();
    await expect(page.getByText("reader@example.test", { exact: true })).toBeVisible();

    await page.goto(`${consoleUrl}#/ses/statistics`);
    await expect(page.locator("main h1")).toHaveText("Sending statistics");
    await expect(page.getByText("Local measurement boundary", { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    for (const hash of ["#/ses/suppression", "#/ses/contact-lists", "#/ses/statistics"]) {
      await page.goto(`${consoleUrl}${hash}`);
      await expectNarrowContainment(page);
    }
    expect(errors).toEqual([]);
  });

  test("explains SES input panels and their StackSim support", async ({ page }) => {
    test.setTimeout(90_000);
    const errors = browserErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const expectHelp = async (title: string, supportText: string) => {
      const button = page.getByRole("button", { name: `About ${title}`, exact: true }).first();
      await expect(button).toBeVisible();
      await button.hover();
      const tooltip = button.locator("..").getByRole("tooltip");
      await expect(tooltip).toContainText(supportText);
      await expect(tooltip).toContainText("StackSim support");
      await page.mouse.move(385, 839);
      return tooltip;
    };

    await page.goto(`${consoleUrl}#/ses`);
    await expectHelp("Account status", "never sends to external SMTP servers");

    await page.goto(`${consoleUrl}#/ses/identities`);
    await expectHelp("Identities", "signed verification messages");
    await page.getByRole("button", { name: "Create identity" }).first().click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Email address or domain").fill("tooltip@example.test");
    await dialog.getByRole("button", { name: "Create identity" }).click();
    await expectHelp("Default configuration set", "inheritance during supported sends");
    await expectHelp("MAIL FROM and feedback", "does not publish or query DNS");
    await expectHelp("Sending authorization policies", "explicit-deny evaluation");

    await page.goto(`${consoleUrl}#/ses/send-test`);
    await expectHelp("Message addresses", "Verified sender enforcement");
    await expectHelp("Content", "Simple and stored-template sends");

    await page.goto(`${consoleUrl}#/ses/inbox`);
    await expectHelp("Mailbox messages", "Durable regional capture");

    await page.goto(`${consoleUrl}#/ses/templates`);
    await expectHelp("Templates", "shared Classic and v2 template catalog");
    await page.getByRole("button", { name: "Create template" }).first().click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Template name").fill("TooltipTemplate");
    await dialog.getByLabel("Subject").fill("Hello {{name}}");
    await dialog.getByLabel("Text body").fill("Hello {{name}}");
    await dialog.getByRole("button", { name: "Create template" }).click();
    await expectHelp("Template content", "does not rewrite historical mail");
    await expectHelp("Test render", "does not consume sending quota");

    await page.goto(`${consoleUrl}#/ses/configuration-sets`);
    await expectHelp("Configuration sets", "CloudWatch and EventBridge destinations");
    await page.getByRole("button", { name: "Create configuration set" }).first().click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Configuration set name").fill("tooltip_config");
    await dialog.getByRole("button", { name: "Create configuration set" }).click();
    await expectHelp("Configuration", "suppression options");
    await expectHelp("Event destinations", "default EventBridge bus");

    await page.goto(`${consoleUrl}#/ses/suppression`);
    await expectHelp("Suppressed destinations", "does not fabricate a remote bounce or complaint");

    await page.goto(`${consoleUrl}#/ses/contact-lists`);
    await expectHelp("Contact lists", "topic definitions and validation");
    await page.getByRole("button", { name: "Create contact list" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("tooltip_contacts");
    await dialog.getByLabel("Topics (JSON array)").fill('[{"TopicName":"news","DisplayName":"News","DefaultSubscriptionStatus":"OPT_IN"}]');
    await dialog.getByRole("button", { name: "Create" }).click();
    await expectHelp("Contacts", "unsubscribe-all state");

    await page.goto(`${consoleUrl}#/ses/custom-verification-templates`);
    const verificationTooltip = await expectHelp("Verification templates", "signed local verification links");
    await page.getByRole("button", { name: "About Verification templates" }).hover();
    const tooltipBox = await verificationTooltip.boundingBox();
    expect(tooltipBox).not.toBeNull();
    expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
    expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  });
});
