import { expect, test, type Page } from "@playwright/test";
import { CreateSecretCommand, GetResourcePolicyCommand, GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";

const region = "eu-west-1";
let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;
let secrets: SecretsManagerClient;
let iam: IAMClient;

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()}`));
  return errors;
}
test.describe("PSS-02 Secrets Manager console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-pss02-console-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "off", cdkBootstrap: false });
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    secrets = new SecretsManagerClient({ endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
    iam = new IAMClient({ endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
    consoleUrl = `${endpoint}/_stacksim/console`;
  });

  test.afterEach(async () => {
    secrets.destroy();
    iam.destroy();
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  for (const viewport of [
    { label: "desktop", width: 1440, height: 900 },
    { label: "narrow", width: 390, height: 844 },
  ]) test(`stores, retrieves, clears, edits, and tags a secret at ${viewport.label} width`, async ({ page }) => {
    const errors = browserErrors(page);
    const name = `browser/${viewport.label}/credentials`;
    const marker = `browser-secret-${viewport.label}-${crypto.randomUUID()}`;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${consoleUrl}#/secrets-manager/secrets`);
    await expect(page.getByRole("heading", { name: "Secrets", exact: true })).toBeVisible();
    await expect(page.locator("main")).not.toContainText(marker);

    await page.getByRole("link", { name: "Store a new secret" }).first().click();
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Secret value").fill(marker);
    await page.getByLabel("Description").fill("Browser secret");
    await page.getByLabel("Tags (JSON object)").fill('{"environment":"browser"}');
    await page.getByRole("button", { name: "Store secret" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(page.locator("#secret-value")).toHaveText("••••••••");
    await expect(page.locator("main")).not.toContainText(marker);

    await page.getByRole("button", { name: "Retrieve secret value" }).click();
    await expect(page.locator("#secret-value")).toHaveText(marker);
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.locator("#secret-value")).toHaveText("••••••••");
    await expect(page.locator("main")).not.toContainText(marker);

    await page.getByRole("button", { name: "Edit secret" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Description").fill("Updated browser secret");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("main")).toContainText("Updated browser secret");

    await page.getByRole("button", { name: "Edit tags" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Tags (JSON object)").fill('{"environment":"browser","owner":"platform"}');
    await dialog.getByRole("button", { name: "Save tags" }).click();
    await expect(page.locator("main")).toContainText("owner");
    assertNoHorizontalOverflow(await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })));
    assertNoHorizontalOverflow(await page.locator("main").evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth })));
    assertNoSecretInUrls(page, marker);
    expect((await secrets.send(new GetSecretValueCommand({ SecretId: name }))).SecretString).toBe(marker);
    expect(errors).toEqual([]);
  });

  test("schedules, restores, and permanently deletes a secret", async ({ page }) => {
    const name = "browser/deletion";
    await page.goto(`${consoleUrl}#/secrets-manager/secrets/create`);
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Secret value").fill("deletion-value");
    await page.getByRole("button", { name: "Store secret" }).click();

    await page.getByRole("button", { name: "Schedule deletion" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Recovery window (days)").fill("7");
    await dialog.getByRole("button", { name: "Schedule deletion" }).click();
    await expect(page.getByText("Pending deletion", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Restore secret" }).click();
    await expect(page.getByRole("button", { name: "Retrieve secret value" })).toBeVisible();

    await page.getByRole("button", { name: "Schedule deletion" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Schedule deletion" }).click();
    await page.getByRole("button", { name: "Delete immediately" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill(`permanently delete ${name}`);
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("heading", { name: "Secrets", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name })).toHaveCount(0);
  });

  test("moves custom stages and edits configured-account resource permissions without revealing values", async ({ page }) => {
    const name = "browser/pss03/stages";
    const marker = `browser-pss03-${crypto.randomUUID()}`;
    const created = await secrets.send(new CreateSecretCommand({ Name: name, SecretString: marker, ClientRequestToken: "1".repeat(32) }));
    await secrets.send(new PutSecretValueCommand({ SecretId: created.ARN, SecretString: "new-value", ClientRequestToken: "2".repeat(32) }));
    const role = await iam.send(new CreateRoleCommand({ RoleName: "browser-pss03-reader", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "sts:AssumeRole" }] }) }));
    await page.goto(`${consoleUrl}#/secrets-manager/secrets/secret/${encodeURIComponent(name)}`);
    await expect(page.locator("main")).not.toContainText(marker);
    const oldVersion = page.getByRole("row").filter({ hasText: "1".repeat(32) });
    await oldVersion.getByRole("button", { name: "Manage stages" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Stages (comma separated)").fill("AWSPREVIOUS, ROLLBACK");
    await dialog.getByRole("button", { name: "Save stages" }).click();
    expect((await secrets.send(new GetSecretValueCommand({ SecretId: created.ARN, VersionStage: "ROLLBACK" }))).SecretString).toBe(marker);

    const policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: role.Role!.Arn }, Action: "secretsmanager:GetSecretValue", Resource: created.ARN }] }, null, 2);
    await page.getByRole("button", { name: "Edit policy" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Resource policy JSON").fill(policy);
    await dialog.getByRole("button", { name: "Validate and save" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator("main")).toContainText(role.Role!.Arn!);
    expect(JSON.parse((await secrets.send(new GetResourcePolicyCommand({ SecretId: created.ARN }))).ResourcePolicy!)).toEqual(JSON.parse(policy));
    await expect(page.locator("main")).not.toContainText(marker);
  });

  test("explains Secrets Manager input panels and their StackSim support", async ({ page }) => {
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

    await page.goto(`${consoleUrl}#/secrets-manager/secrets`);
    const secretsTooltip = await expectHelp("Secret catalog", "custom staging labels");
    await page.getByRole("button", { name: "About Secret catalog" }).hover();
    const tooltipBox = await secretsTooltip.boundingBox();
    expect(tooltipBox).not.toBeNull();
    expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
    expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(390);
    await page.mouse.move(385, 839);

    await page.getByRole("link", { name: "Store a new secret" }).first().click();
    await expectHelp("Secret configuration", "SecretBinary and GetRandomPassword");

    const name = "browser/tooltip/credentials";
    await secrets.send(new CreateSecretCommand({ Name: name, SecretString: "tooltip-secret", Tags: [{ Key: "environment", Value: "browser" }] }));
    await page.goto(`${consoleUrl}#/secrets-manager/secrets/secret/${encodeURIComponent(name)}`);
    await expectHelp("Overview", "7–30 day recovery window");
    await expectHelp("Secret value", "Installation-local AES-256-GCM protection");
    await expectHelp("Versions", "AWSCURRENT and AWSPREVIOUS");
    await expectHelp("Tags", "resource-tag authorization conditions");
  });
});

function assertNoHorizontalOverflow(dimensions: { scroll: number; client: number }): void {
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
}

function assertNoSecretInUrls(page: Page, marker: string): void {
  expect(page.url()).not.toContain(marker);
}
