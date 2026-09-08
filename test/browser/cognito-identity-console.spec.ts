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

  test("covers empty and populated identity-pool views without merging into User Pools", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/cognito-identity/identity-pools`);
    await expect(page.getByRole("heading", { name: "Identity pools", exact: true })).toBeVisible();
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
      await page.goto(`${consoleUrl}#/cognito-identity/identity-pools`);
      await expect(page.getByRole("link", { name: "browser-identities" })).toBeVisible();
      await page.getByRole("link", { name: "browser-identities" }).click();
      await expect(page.getByRole("heading", { name: "browser-identities", exact: true })).toBeVisible();
      await expect(page.locator("main")).toContainText(created.IdentityPoolId!);
      await expect(page.locator("main")).toContainText("Disabled");
      await expect(page.locator("main")).not.toContainText("SecretKey");
      await expect(page.locator("main")).not.toContainText("SessionToken");
    } finally {
      client.destroy();
    }
    expect(errors.filter(error => !error.includes("favicon"))).toEqual([]);
  });
});
