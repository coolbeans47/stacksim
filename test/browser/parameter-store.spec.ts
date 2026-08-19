import { expect, test, type Page } from "@playwright/test";
import { DescribeParametersCommand, GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";

const region = "eu-west-1";
let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;
let ssm: SSMClient;

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()}`));
  return errors;
}

test.describe("PSS-01 Parameter Store console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-pss01-console-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, authMode: "off", cdkBootstrap: true });
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    ssm = new SSMClient({ endpoint, region, credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
    consoleUrl = `${endpoint}/_stacksim/console`;
  });

  test.afterEach(async () => {
    ssm.destroy();
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  for (const viewport of [
    { label: "desktop", width: 1440, height: 900 },
    { label: "narrow", width: 390, height: 844 },
  ]) test(`creates, reveals, updates, tags, and deletes a parameter at ${viewport.label} width`, async ({ page }) => {
    const errors = browserErrors(page);
    const marker = `browser-secret-${viewport.label}`;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${consoleUrl}#/systems-manager/parameter-store`);
    await expect(page.getByRole("heading", { name: "Parameter Store", exact: true })).toBeVisible();
    await expect(page.getByText("Simulator managed")).toBeVisible();
    await expect(page.getByRole("cell", { name: "23", exact: true })).toHaveCount(0);

    await page.getByRole("link", { name: "Create parameter" }).first().click();
    await page.getByLabel("Name").fill(`/browser/${viewport.label}/token`);
    await page.getByLabel("Type", { exact: true }).selectOption("SecureString");
    await page.getByLabel("Value").fill(marker);
    await page.getByLabel("Description").fill("Browser protected value");
    await page.getByLabel("Tags (JSON object)").fill('{"environment":"browser"}');
    await page.getByRole("button", { name: "Create parameter" }).click();
    await expect(page.getByRole("heading", { name: `/browser/${viewport.label}/token` })).toBeVisible();
    await expect(page.locator("#parameter-value")).toHaveText("••••••••");
    await expect(page.locator("main")).not.toContainText(marker);

    await page.getByRole("button", { name: "Decrypt and reveal" }).click();
    await expect(page.locator("#parameter-value")).toHaveText(marker);
    await page.getByRole("link", { name: "Back" }).click();
    await expect(page.locator("main")).not.toContainText(marker);

    const name = `/browser/${viewport.label}/token`;
    await page.getByRole("link", { name }).click();
    await page.getByRole("button", { name: "Edit tags" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Tags (JSON object)").fill('{"environment":"browser","owner":"platform"}');
    await dialog.getByRole("button", { name: "Save tags" }).click();
    await expect(page.locator("main")).toContainText("owner");

    await page.getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("dialog");
    await confirm.getByRole("textbox").fill(name);
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("heading", { name: "Parameter Store", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name })).toHaveCount(0);
    await expect(ssm.send(new GetParameterCommand({ Name: name }))).rejects.toMatchObject({ name: "ParameterNotFound" });
    expect(errors).toEqual([]);
  });

  test("marks the bootstrap parameter protected and disables mutation controls", async ({ page }) => {
    await page.goto(`${consoleUrl}#/systems-manager/parameter-store`);
    await page.getByRole("link", { name: "/cdk-bootstrap/hnb659fds/version" }).click();
    await expect(page.getByText("Protected resource")).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit value" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit tags" })).toHaveCount(0);
  });

  test("labels a retained version, reads it by label, and inspects masked history", async ({ page }) => {
    const name = "/browser/history/config";
    const marker = `history-${crypto.randomUUID()}`;
    await ssm.send(new PutParameterCommand({ Name: name, Type: "SecureString", Value: marker }));
    await ssm.send(new PutParameterCommand({ Name: name, Type: "SecureString", Value: "new-value", Overwrite: true }));
    await page.goto(`${consoleUrl}#/systems-manager/parameter-store/parameter/${encodeURIComponent(name)}`);
    await page.getByRole("button", { name: "Inspect history" }).click();
    const oldVersion = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "1", exact: true }) });
    await oldVersion.getByRole("button", { name: "Manage labels" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Labels (comma separated)").fill("stable");
    await dialog.getByRole("button", { name: "Save labels" }).click();
    expect((await ssm.send(new GetParameterCommand({ Name: `${name}:stable`, WithDecryption: true }))).Parameter?.Value).toBe(marker);
    await page.getByRole("button", { name: "Inspect history" }).click();
    await expect(page.getByText("stable", { exact: true })).toBeVisible();
    await page.getByRole("row").filter({ has: page.getByRole("cell", { name: "1", exact: true }) }).getByRole("button", { name: "Reveal" }).click();
    await expect(page.locator("#parameter-history-value")).toHaveText(marker);
    await page.getByRole("link", { name: "Back" }).click();
    await expect(page.locator("main")).not.toContainText(marker);
  });

  test("creates and edits an Advanced parameter policy with visible status and due time", async ({ page }) => {
    const name = "/browser/advanced/policy";
    const expiration = new Date(Date.now() + 3_600_000).toISOString();
    const policies = JSON.stringify([{ Type: "Expiration", Version: "1.0", Attributes: { Timestamp: expiration } }], null, 2);
    await page.goto(`${consoleUrl}#/systems-manager/parameter-store/create`);
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Tier").selectOption("Advanced");
    await page.getByLabel("Value").fill("advanced-value");
    await page.getByLabel("Policies (JSON array)").fill(policies);
    await page.getByRole("button", { name: "Create parameter" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
    const policiesHeading = page.getByRole("heading", { name: "Policies", exact: true });
    const policiesCard = page.locator(".card").filter({ has: policiesHeading });
    await expect(policiesCard).toContainText("Expiration");
    await expect(policiesCard).toContainText("PENDING");
    await expect(policiesCard).not.toContainText("No parameter policies");

    await page.getByRole("button", { name: "Edit value" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Tier")).toHaveValue("Advanced");
    await dialog.getByLabel("New value").fill("advanced-updated");
    await dialog.getByRole("button", { name: "Save new version" }).click();
    const described = await ssm.send(new DescribeParametersCommand({ ParameterFilters: [{ Key: "Name", Values: [name] }] }));
    expect(described.Parameters?.[0]?.Tier).toBe("Advanced");
    expect(described.Parameters?.[0]?.Policies?.[0]?.PolicyType).toBe("Expiration");
  });

  test("explains Parameter Store input panels and their StackSim support", async ({ page }) => {
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

    await page.goto(`${consoleUrl}#/systems-manager/parameter-store`);
    const parametersTooltip = await expectHelp("Parameters", "parameter history and labels");
    await page.getByRole("button", { name: "About Parameters" }).hover();
    const tooltipBox = await parametersTooltip.boundingBox();
    expect(tooltipBox).not.toBeNull();
    expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
    expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(390);
    await page.mouse.move(385, 839);

    await page.getByRole("link", { name: "Create parameter" }).first().click();
    await expectHelp("Parameter configuration", "installation-local AES-256-GCM protection");
    await expectHelp("Parameter configuration", "Advanced policies");

    const name = "/browser/tooltip/token";
    await ssm.send(new PutParameterCommand({ Name: name, Type: "SecureString", Value: "tooltip-secret", Tags: [{ Key: "environment", Value: "browser" }] }));
    await page.goto(`${consoleUrl}#/systems-manager/parameter-store/parameter/${encodeURIComponent(name)}`);
    await expectHelp("Value", "history browsing, and version labels");
    await expectHelp("Tags", "resource-tag authorization conditions");
  });
});
