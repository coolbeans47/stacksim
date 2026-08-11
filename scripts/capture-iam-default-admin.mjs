import { chromium } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../dist/src/server.js";
import { cdkBootstrapNames } from "../dist/src/cloudformation/bootstrap.js";

const artifactRoot = join(process.cwd(), "docs/ui-reference/iam-default-admin");
const viewports = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "390x844", width: 390, height: 844 },
];
const region = "eu-west-1";
let browser;

async function capture(page, folder, state, locator) {
  const target = join(artifactRoot, folder);
  await mkdir(target, { recursive: true });
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(50);
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    if (dimensions.document > dimensions.viewport) throw new Error(`${folder}/${state} overflows at ${viewport.name}: ${JSON.stringify(dimensions)}`);
    const path = join(target, `${state}-${viewport.name}.png`);
    if (locator) await locator.screenshot({ path });
    else await page.screenshot({ path });
  }
}

async function signIn(page, baseUrl, accessKeyId = "admin", secretAccessKey = "password") {
  await page.goto(`${baseUrl}#/home`);
  const form = page.locator("#console-sign-in");
  await form.getByLabel("Access key ID").fill(accessKeyId);
  await form.getByLabel("Secret access key").fill(secretAccessKey);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function withSimulator(options, task, existingDataDir) {
  const dataDir = existingDataDir ?? await mkdtemp(join(tmpdir(), "stacksim-daa-capture-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region, ...options });
  try {
    await simulator.start();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      await task({ simulator, page, baseUrl: `http://127.0.0.1:${simulator.port}/_stacksim/console`, dataDir });
    } finally {
      await context.close();
    }
  } finally {
    await simulator.stop().catch(() => undefined);
    if (!existingDataDir) await rm(dataDir, { recursive: true, force: true });
  }
}

try {
  browser = await chromium.launch({ channel: "chrome", headless: true });

  await withSimulator({}, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}#/home`);
    await capture(page, "iam", "sign-in");
    await signIn(page, baseUrl);
    const offer = page.getByRole("dialog");
    await offer.getByRole("heading", { name: "Secure the default IAM access key" }).waitFor();
    await capture(page, "iam", "first-login-offer", offer);
    await offer.locator('input[name="choice"][value="keep"]').check();
    await offer.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Console Home" }).waitFor();

    await page.evaluate(async () => {
      const api = await import("/_stacksim/console/api-client.js");
      await api.rest("/_stacksim/api/iam/groups", "POST", { GroupName: "developers" });
      await api.rest("/_stacksim/api/iam/groups/developers/members/admin", "PUT");
    });
    await page.goto(`${baseUrl}#/iam/users`);
    await page.getByRole("heading", { name: "Users" }).waitFor();
    await capture(page, "iam", "users");
    await page.goto(`${baseUrl}#/iam/users/admin`);
    await page.getByRole("heading", { name: "Security credentials" }).waitFor();
    await capture(page, "iam", "security-credentials");
    await page.goto(`${baseUrl}#/iam/groups/developers`);
    await page.getByRole("heading", { name: "Members" }).waitFor();
    await capture(page, "iam", "groups");
    await page.goto(`${baseUrl}#/cloudformation/setup`);
    await page.getByRole("heading", { name: "Local CDK setup" }).waitFor();
    await capture(page, "cloudformation", "setup");
    await capture(page, "cloudformation", "setup-code", page.locator(".cloudformation-setup-code").first());
  });

  await withSimulator({}, async ({ page, baseUrl }) => {
    await signIn(page, baseUrl);
    const offer = page.getByRole("dialog");
    await offer.locator('input[name="choice"][value="generate"]').check();
    await offer.getByRole("button", { name: "Continue" }).click();
    const save = page.getByRole("dialog");
    await save.getByRole("heading", { name: "Save the replacement access key" }).waitFor();
    const replacementKeyId = await save.locator("dd").nth(0).textContent();
    await save.locator("dd").nth(0).evaluate(element => { element.textContent = "AKIA-REDACTED-DISPOSABLE"; });
    await save.locator("dd").nth(1).evaluate(element => { element.textContent = "SECRET-REDACTED-NOT-A-CREDENTIAL"; });
    await capture(page, "iam", "rotation-incomplete-redacted", save);
    await save.getByLabel("I saved the replacement pair.").check();
    await save.getByRole("button", { name: "Validate and switch" }).click();
    await page.waitForFunction(expected => JSON.parse(sessionStorage.getItem("stacksim-console-credentials")).active.accessKeyId === expected, replacementKeyId);
    await page.goto(`${baseUrl}#/iam/users/admin`);
    await page.getByRole("heading", { name: "Security credentials" }).waitFor();
    await capture(page, "iam", "generated-identity-inactive-configured-key");
  });

  await withSimulator({ cdkBootstrap: false }, async ({ page, baseUrl }) => {
    await signIn(page, baseUrl);
    const offer = page.getByRole("dialog");
    await offer.locator('input[name="choice"][value="keep"]').check();
    await offer.getByRole("button", { name: "Continue" }).click();
    await page.goto(`${baseUrl}#/cloudformation/setup`);
    await page.getByText("Automatic bootstrap is disabled").waitFor();
    await capture(page, "cloudformation", "bootstrap-disabled");
  });

  const blockedDataDir = await mkdtemp(join(tmpdir(), "stacksim-daa-blocked-capture-"));
  const preparation = new StackSim({ port: 0, invokePort: 0, dataDir: blockedDataDir, region, authMode: "off", cdkBootstrap: false });
  try {
    await preparation.start();
    const names = cdkBootstrapNames("000000000000", region);
    await preparation.iam.CreateRole({
      RoleName: names.roleNames.deploy,
      AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::000000000000:root" }, Action: "sts:AssumeRole" }] },
    });
  } finally {
    await preparation.stop().catch(() => undefined);
  }
  try {
    await withSimulator({}, async ({ page, baseUrl }) => {
      await signIn(page, baseUrl);
      const offer = page.getByRole("dialog");
      await offer.locator('input[name="choice"][value="keep"]').check();
      await offer.getByRole("button", { name: "Continue" }).click();
      await page.goto(`${baseUrl}#/cloudformation/setup`);
      await page.getByText("Automatic bootstrap is blocked").waitFor();
      await capture(page, "cloudformation", "bootstrap-blocked");
    }, blockedDataDir);
  } finally {
    await rm(blockedDataDir, { recursive: true, force: true });
  }

  await withSimulator({ rootRecovery: true }, async ({ page, baseUrl }) => {
    await signIn(page, baseUrl);
    await page.getByText("Recovery root is enabled").waitFor();
    await capture(page, "iam", "recovery-root-warning");
  });

  await withSimulator({}, async ({ simulator, page, baseUrl }) => {
    const user = "denied-developer";
    await simulator.iam.CreateUser({ UserName: user });
    await simulator.iam.AttachUserPolicy({ UserName: user, PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess" });
    await simulator.iam.PutUserPolicy({
      UserName: user,
      PolicyName: "DenyDynamoDB",
      PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "dynamodb:ListTables", Resource: "*" }] },
    });
    const created = await simulator.iam.CreateAccessKey({ UserName: user });
    await signIn(page, baseUrl, created.AccessKey.AccessKeyId, created.AccessKey.SecretAccessKey);
    await page.goto(`${baseUrl}#/dynamodb/tables`);
    await page.getByRole("alert").waitFor();
    await capture(page, "iam", "explicit-deny");
  });

  console.log(`Captured default IAM administrator states under ${artifactRoot}`);
} finally {
  await browser?.close();
}
