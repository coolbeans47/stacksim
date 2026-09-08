import { expect, test, type Page } from "@playwright/test";
import {
  CognitoIdentityClient,
  CreateIdentityPoolCommand,
} from "@aws-sdk/client-cognito-identity";
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
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  page.on("response", response => {
    if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
  });
  return errors;
}

async function signIn(page: Page, accessKeyId = "admin", secretAccessKey = "password") {
  const form = page.locator("#console-sign-in");
  await form.getByLabel("Access key ID").fill(accessKeyId);
  await form.getByLabel("Secret access key").fill(secretAccessKey);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  const onboarding = page.getByRole("heading", { name: "Secure the default IAM access key" });
  const offered = await onboarding.waitFor({ state: "visible", timeout: 2_000 }).then(() => true, () => false);
  if (offered) {
    await page.locator('input[name="choice"][value="keep"]').check();
    await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
  }
}

test.describe("Cognito Identity Pools console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-cognito-identity-browser-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off" });
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
  });

  test.afterEach(async () => {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("opens identity pools from Cognito instead of a home tile", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/home`);
    await expect(page.locator('[data-service-key="cognito"]')).toBeVisible();
    await expect(page.locator('[data-service-key="cognito-identity"]')).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Cognito Identity Pools" })).toHaveCount(0);

    await page.getByRole("button", { name: /Services/ }).click();
    await expect(page.getByRole("dialog").locator('[data-service-key="cognito"]')).toBeVisible();
    await expect(page.getByRole("dialog").locator('[data-service-key="cognito-identity"]')).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.locator('[data-service-key="cognito"]').getByRole("link", { name: "View user pools" }).click();
    const navigation = page.getByRole("navigation", { name: "Cognito navigation" });
    await expect(navigation.getByRole("link", { name: "Identity pools" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "User pools" })).toBeVisible();

    await page.goto(`${consoleUrl}#/cognito`);
    await expect(page.getByRole("heading", { name: "Identity pools", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "View identity pools" }).click();
    await expect(page).toHaveURL(/#\/cognito-identity\/identity-pools$/);
    await expect(page.getByRole("heading", { name: "Identity pools", exact: true })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Identity pools" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Sign in to StackSim" })).toHaveCount(0);
    expect(errors.filter(error => !error.includes("favicon"))).toEqual([]);
  });

  test("covers empty and populated identity-pool views without merging into User Pools", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/cognito-identity/identity-pools`);
    await expect(page.getByRole("heading", { name: "Identity pools", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Cognito navigation" })).toBeVisible();
    await expect(page.getByText("No identity pools", { exact: true })).toBeVisible();
    await expect(page.getByText("This console is read-only in CID-01.")).toBeVisible();
    await expect(page.locator("main")).not.toContainText("Create identity pool");

    const client = new CognitoIdentityClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region: "eu-west-1",
      credentials: { accessKeyId: "admin", secretAccessKey: "password" },
    });
    try {
      const created = await client.send(new CreateIdentityPoolCommand({
        IdentityPoolName: "browser-identities",
        AllowUnauthenticatedIdentities: false,
      }));
      await page.reload();
      await expect(page.getByRole("link", { name: "browser-identities" })).toBeVisible();
      await page.getByRole("link", { name: "browser-identities" }).click();
      await expect(page.getByRole("heading", { name: "browser-identities", exact: true })).toBeVisible();
      await expect(page.locator("main")).toContainText(created.IdentityPoolId!);
      await expect(page.locator("main")).toContainText("Disabled");
      await expect(page.locator("main")).not.toContainText("SecretKey");
      await expect(page.locator("main")).not.toContainText("SessionToken");
      await expect(page.getByRole("navigation", { name: "Cognito navigation" }).getByRole("link", { name: "Identity pools" })).toBeVisible();
    } finally {
      client.destroy();
    }
    expect(errors.filter(error => !error.includes("favicon"))).toEqual([]);
  });
});

test.describe("authenticated Cognito Identity navigation", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-cognito-identity-auth-browser-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "enforce", cdkBootstrap: true });
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
  });

  test.afterEach(async () => {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("signed console session opens Identity pools from Cognito without bouncing to login", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/home`);
    await expect(page.getByRole("heading", { name: "Sign in to StackSim" })).toBeVisible();
    await signIn(page);
    await expect(page.getByRole("heading", { name: "Console home" })).toBeVisible();
    await expect(page.locator('[data-service-key="cognito-identity"]')).toHaveCount(0);

    await page.locator('[data-service-key="cognito"]').getByRole("link", { name: "View user pools" }).click();
    await expect(page.getByRole("heading", { name: "User pools", exact: true })).toBeVisible();
    await page.getByRole("navigation", { name: "Cognito navigation" }).getByRole("link", { name: "Identity pools" }).click();
    await expect(page).toHaveURL(/#\/cognito-identity\/identity-pools$/);
    await expect(page.getByRole("heading", { name: "Identity pools", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to StackSim" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /admin · 000000000000/ })).toBeVisible();
    expect(errors.filter(error => !error.includes("favicon"))).toEqual([]);
  });
});
