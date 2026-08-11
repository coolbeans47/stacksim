import { expect, test, type Page } from "@playwright/test";
import { AttachRolePolicyCommand, CreatePolicyCommand, CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";
import { fillArnCombobox } from "./arn-combobox.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;

test.use({ trace: "off", video: "off", screenshot: "off" });

async function signIn(page: Page, accessKeyId = "admin", secretAccessKey = "password", sessionToken = "") {
  const form = page.locator("#console-sign-in");
  await form.getByLabel("Access key ID").fill(accessKeyId);
  await form.getByLabel("Secret access key").fill(secretAccessKey);
  if (sessionToken) await form.getByLabel(/Session token/).fill(sessionToken);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  const onboarding = page.getByRole("heading", { name: "Secure the default IAM access key" });
  const offered = accessKeyId === "admin" && await onboarding.waitFor({ state: "visible", timeout: 2_000 }).then(() => true, () => false);
  if (offered) {
    await page.locator('input[name="choice"][value="keep"]').check();
    await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
  }
}

test.describe("authenticated console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-console-auth-browser-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", cdkBootstrap: true });
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
  });

  test.afterEach(async () => {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("validates sign-in, restores a tab session on reload, and signs representative protocols", async ({ page }) => {
    const signed: string[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("request", request => {
      const authorization = request.headers().authorization;
      if (authorization) signed.push(authorization);
    });
    await page.goto(`${consoleUrl}#/home`);
    await expect(page.getByRole("heading", { name: "Sign in to StackSim" })).toBeVisible();
    const brandBanner = page.locator(".sign-in-brand-banner");
    await expect(brandBanner).toBeVisible();
    await expect(brandBanner.locator("img")).toHaveAttribute("src", "/_stacksim/console/assets/stacksim-logo.png");
    expect(await page.evaluate(() => {
      const banner = document.querySelector(".sign-in-brand-banner")?.getBoundingClientRect();
      const form = document.querySelector("#console-sign-in")?.getBoundingClientRect();
      return banner && form ? Math.abs(banner.width - form.width) : Number.POSITIVE_INFINITY;
    })).toBeLessThan(1);
    await signIn(page);
    await expect(page.getByRole("button", { name: /admin · 000000000000/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Console home" })).toBeVisible();

    const result = await page.evaluate(async () => {
      const api = await (0, eval)('import("/_stacksim/console/api-client.js")');
      await api.dynamo("CreateTable", {
        TableName: "ConsoleAuthTable",
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
      });
      await api.s3Request("/console-auth-bucket", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: '<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>eu-west-1</LocationConstraint></CreateBucketConfiguration>',
      });
      await api.s3Request("/console-auth-bucket/binary.bin", { method: "PUT", body: new Uint8Array([0, 255, 1]) });
      const [dynamo, rds, s3, lambda, appsync] = await Promise.all([
        api.dynamo("ListTables"),
        api.rds("DescribeDBInstances"),
        api.s3Request("/console-auth-bucket/binary.bin"),
        api.rest("/2015-03-31/functions"),
        api.appsync("/v1/apis", { query: { apiType: "GRAPHQL", owner: "CURRENT_ACCOUNT" } }),
      ]);
      return {
        tables: dynamo.TableNames,
        rdsStatus: rds.response.status,
        s3Status: s3.response.status,
        s3Body: [...s3.body],
        functions: lambda.Functions,
        graphqlApis: appsync.graphqlApis,
      };
    });
    expect(result).toEqual({ tables: ["ConsoleAuthTable"], rdsStatus: 200, s3Status: 200, s3Body: [0, 255, 1], functions: [], graphqlApis: [] });
    expect(signed.some(value => value.includes("/dynamodb/aws4_request"))).toBeTruthy();
    expect(signed.some(value => value.includes("/rds/aws4_request"))).toBeTruthy();
    expect(signed.some(value => value.includes("/s3/aws4_request"))).toBeTruthy();
    expect(signed.some(value => value.includes("/lambda/aws4_request"))).toBeTruthy();
    expect(signed.some(value => value.includes("/appsync/aws4_request"))).toBeTruthy();

    await page.goto(`${consoleUrl}#/appsync/apis`);
    await expect(page.getByRole("heading", { name: "No GraphQL APIs" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "No GraphQL APIs" })).toBeVisible();
    expect(await page.evaluate(() => Boolean(sessionStorage.getItem("stacksim-console-credentials")))).toBeTruthy();

    await page.getByRole("button", { name: /admin · 000000000000/ }).click();
    const signOut = page.getByRole("button", { name: "Sign out" });
    await expect(signOut).toHaveAttribute("data-console-sign-out", "");
    await signOut.click();
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate(() => sessionStorage.getItem("stacksim-console-credentials"))).toBeNull();
    await expect(page.getByRole("heading", { name: "Sign in to StackSim" })).toBeVisible();
  });

  test("rejects unknown keys and incorrect secrets without reflecting credential material", async ({ page }) => {
    await page.goto(consoleUrl);
    await signIn(page, "UNKNOWN-CONSOLE-KEY", "not-the-secret");
    await expect(page.getByRole("alert")).toContainText("unknown, invalid, or expired");
    await expect(page.locator("body")).not.toContainText("not-the-secret");

    await page.getByLabel("Access key ID").fill("admin");
    await page.getByLabel("Secret access key").fill("definitely-wrong-secret");
    await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("unknown, invalid, or expired");
    await expect(page.locator("body")).not.toContainText("definitely-wrong-secret");
  });

  test("rotates the default key once, switches the tab atomically, and leaves no secret-bearing artifacts", async ({ page }) => {
    let createKeyCacheControl = "";
    page.on("response", response => {
      if (response.request().postData()?.includes("Action=CreateAccessKey")) createKeyCacheControl = response.headers()["cache-control"] ?? "";
    });
    await page.goto(consoleUrl);
    const form = page.locator("#console-sign-in");
    await form.getByLabel("Access key ID").fill("admin");
    await form.getByLabel("Secret access key").fill("password");
    await form.getByRole("button", { name: "Sign in", exact: true }).click();
    const offer = page.getByRole("dialog");
    await expect(offer.getByRole("heading", { name: "Secure the default IAM access key" })).toBeVisible();
    await expect(offer.getByRole("group", { name: "Choose how to secure this access key" })).toBeVisible();
    const optionRects = await offer.locator(".onboarding-choice").evaluateAll(options => options.map(option => {
      const { x, y, width, height } = option.getBoundingClientRect();
      return { x, y, width, height };
    }));
    expect(optionRects).toHaveLength(2);
    expect(Math.abs(optionRects[0].x - optionRects[1].x)).toBeLessThan(1);
    expect(Math.abs(optionRects[0].width - optionRects[1].width)).toBeLessThan(1);
    expect(optionRects[1].y).toBeGreaterThan(optionRects[0].y + optionRects[0].height);
    await offer.locator('input[name="choice"][value="generate"]').check();
    await offer.getByRole("button", { name: "Continue" }).click();

    const save = page.getByRole("dialog");
    await expect(save.getByRole("heading", { name: "Save the replacement access key" })).toBeVisible();
    const values = await save.locator("dd").allTextContents();
    const replacementAccessKeyId = values[0];
    const replacementSecret = values[1];
    expect(replacementAccessKeyId).toMatch(/^AKIA[A-Z0-9]{16}$/);
    expect(replacementSecret).toHaveLength(40);
    await save.getByLabel("I saved the replacement pair.").check();
    await save.getByRole("button", { name: "Validate and switch" }).click();
    await expect(page.getByRole("button", { name: /admin.*000000000000/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("stacksim-console-credentials")!).active.accessKeyId)).toBe(replacementAccessKeyId);

    const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem("stacksim-console-credentials")!));
    expect(stored.source.accessKeyId).toBe(replacementAccessKeyId);
    expect(stored.active.accessKeyId).toBe(replacementAccessKeyId);
    expect(stored.source.secretAccessKey).toBe(replacementSecret);
    expect(JSON.stringify(stored)).not.toContain("password");
    expect(createKeyCacheControl).toContain("no-store");

    const keyState = await page.evaluate(async () => {
      const api = await (0, eval)('import("/_stacksim/console/api-client.js")');
      return api.rest("/_stacksim/api/iam/users/admin");
    });
    expect(keyState.accessKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ accessKeyId: "admin", status: "Inactive" }),
      expect.objectContaining({ accessKeyId: replacementAccessKeyId, status: "Active" }),
    ]));

    await page.reload();
    await expect(page.getByRole("heading", { name: "Console home" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Secure the default IAM access key" })).toHaveCount(0);
  });

  test("assumes a real role and includes its STS session token", async ({ page }) => {
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const iam = new IAMClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
    try {
      const role = await iam.send(new CreateRoleCommand({
        RoleName: "console-reader",
        AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:user/admin" }, Action: "sts:AssumeRole" }] }),
      }));
      const policy = await iam.send(new CreatePolicyCommand({
        PolicyName: "ConsoleReader",
        PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["dynamodb:ListTables"], Resource: "*" }] }),
      }));
      await iam.send(new AttachRolePolicyCommand({ RoleName: "console-reader", PolicyArn: policy.Policy!.Arn! }));
      expect(role.Role?.Arn).toBe("arn:aws:iam::000000000000:role/console-reader");
    } finally {
      iam.destroy();
    }

    let tokenHeader = "";
    page.on("request", request => {
      if (request.headers()["x-amz-target"] === "DynamoDB_20120810.ListTables") tokenHeader = request.headers()["x-amz-security-token"] ?? "";
    });
    await page.goto(consoleUrl);
    await signIn(page);
    await page.getByRole("button", { name: /admin · 000000000000/ }).click();
    await fillArnCombobox(page.getByLabel("Console identity"), "arn:aws:iam::000000000000:role/console-reader");
    await page.getByRole("button", { name: "Switch identity" }).click();
    await expect(page.getByRole("button", { name: /console-reader · 000000000000/ })).toBeVisible();
    expect(await page.evaluate(async () => (await (0, eval)('import("/_stacksim/console/api-client.js")')).dynamo("ListTables"))).toEqual({ TableNames: [] });
    expect(await page.evaluate(async () => {
      try {
        await (await (0, eval)('import("/_stacksim/console/api-client.js")')).rest("/2015-03-31/functions");
        return "allowed";
      } catch (error: any) {
        return error.code;
      }
    })).toBe("AccessDeniedException");
    expect(tokenHeader).not.toBe("");
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("stacksim-console-credentials")!).active.sessionToken.length)).toBeGreaterThan(20);
  });
});
