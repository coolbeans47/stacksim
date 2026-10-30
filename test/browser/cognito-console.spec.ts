import { expect, test, type Page } from "@playwright/test";
import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  InitiateAuthCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  APIGatewayClient,
  CreateRestApiCommand,
  GetAuthorizersCommand,
  GetMethodCommand,
  GetResourcesCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
} from "@aws-sdk/client-api-gateway";
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  GetAuthorizersCommand as GetHttpAuthorizersCommand,
} from "@aws-sdk/client-apigatewayv2";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";
import { addArnComboboxValue } from "./arn-combobox.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;

function sdk() {
  return new CognitoIdentityProviderClient({
    endpoint: `http://127.0.0.1:${simulator.port}`,
    region: "eu-west-1",
    credentials: { accessKeyId: "admin", secretAccessKey: "password" },
  });
}

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => errors.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  page.on("response", response => {
    if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
  });
  return errors;
}

async function populatedPool() {
  const client = sdk();
  try {
    const pool = await client.send(new CreateUserPoolCommand({
      PoolName: "responsive-users",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
    }));
    const poolId = pool.UserPool!.Id!;
    const appClient = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "responsive-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      PreventUserExistenceErrors: "ENABLED",
    }));
    await client.send(new SignUpCommand({
      ClientId: appClient.UserPoolClient!.ClientId!,
      Username: "responsive@example.test",
      Password: "ResponsivePassword1!",
      UserAttributes: [{ Name: "email", Value: "responsive@example.test" }],
    }));
    return { poolId, clientId: appClient.UserPoolClient!.ClientId! };
  } finally {
    client.destroy();
  }
}

async function confirmationCode(email: string): Promise<string> {
  const response = await fetch(
    `http://127.0.0.1:${simulator.port}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(email)}&status=all&pageSize=100`,
  );
  const messages = (await response.json() as { messages: Array<{ messageId: string }> }).messages;
  const detail = await fetch(
    `http://127.0.0.1:${simulator.port}/_stacksim/api/ses/inbox/${encodeURIComponent(messages.at(-1)!.messageId)}`,
  );
  const text = (await detail.json() as { message: { textBody: string } }).message.textBody;
  const match = /\b(\d{6})\b/.exec(text);
  expect(match).toBeTruthy();
  return match![1];
}

test.describe("Cognito console", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-cognito-browser-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off"});
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
  });

  test.afterEach(async () => {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("covers the pool list, application wizard, grouped pool menu, editors, users, groups, and Inbox views", async ({ page }) => {
    const errors = browserErrors(page);
    await page.goto(`${consoleUrl}#/cognito`);
    await expect(page.getByRole("heading", { name: "User pools", exact: true })).toBeVisible();
    const navigation = page.getByRole("navigation", { name: "Cognito navigation" });
    await expect(navigation.getByRole("link", { name: "Identity pools" })).toBeVisible();
    await expect(page.getByText("No user pools", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Create user pool" }).first().click();
    await expect(page.getByRole("heading", { name: "Set up resources for your application" })).toBeVisible();
    await page.getByLabel("Single-page application (SPA)", { exact: false }).check();
    await page.getByLabel("Name your application").fill("browser-spa");
    await page.getByLabel("Return URL").fill("http://localhost:5173/callback");
    await page.getByRole("button", { name: "Create user pool" }).click();
    await expect(page.getByRole("heading", { name: "Set up your application" }).first()).toBeVisible();
    const poolId = Object.keys(simulator.store.regionState("eu-west-1").cognito.pools)[0];
    const created = simulator.store.regionState("eu-west-1").cognito.pools[poolId];
    expect(created.configuration.usernameAttributes).toEqual(["email"]);
    expect(created.configuration.deletionProtection).toBe("ACTIVE");
    const wizardClient = Object.values(created.clients)[0];
    expect(wizardClient.explicitAuthFlows).toContain("ALLOW_USER_AUTH");
    expect(wizardClient.callbackUrls).toEqual(["http://localhost:5173/callback"]);
    await page.getByRole("link", { name: "Go to overview" }).click();

    await expect(page.getByRole("heading", { name: created.name, exact: true })).toBeVisible();
    for (const label of ["Overview", "App clients", "Users", "Groups", "Authentication methods", "Sign-in", "Sign-up", "Social and external providers", "Message templates", "Threat protection", "Domain", "Managed login", "Lambda triggers", "Settings"]) {
      await expect(navigation.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByText("Feature plan", { exact: true })).toBeVisible();
    await expect(page.getByText("Essentials", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open filtered SES Inbox" })).toBeVisible();
    await page.getByRole("button", { name: "Manage tags" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Tags (one key=value per line)").fill("environment=browser");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("row").filter({ hasText: "environment" })).toContainText("browser");
    await expect(page.locator("main")).not.toContainText("[object Object]");

    await navigation.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "User pool security" }).click();
    await expect(page.getByRole("button", { name: "Delete user pool" })).toBeDisabled();
    await page.getByRole("button", { name: "Deactivate" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("button", { name: "Activate", exact: true })).toBeVisible();
    expect(simulator.store.regionState("eu-west-1").cognito.pools[poolId].configuration.deletionProtection).toBe("INACTIVE");

    await navigation.getByRole("link", { name: "Sign-in", exact: true }).click();
    await page.getByRole("button", { name: "Edit" }).nth(1).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Optional MFA").check();
    await dialog.getByLabel("Authenticator apps").check();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("main").getByText("Optional MFA", { exact: true }).first()).toBeVisible();
    expect(simulator.store.regionState("eu-west-1").cognito.pools[poolId].configuration.enabledMfas).toContain("SOFTWARE_TOKEN_MFA");

    await navigation.getByRole("link", { name: "Authentication methods" }).click();
    await page.getByRole("button", { name: "Edit" }).nth(1).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Password minimum length").fill("10");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("10 characters", { exact: true })).toBeVisible();
    expect(simulator.store.regionState("eu-west-1").cognito.pools[poolId].configuration.deletionProtection).toBe("INACTIVE");

    await navigation.getByRole("link", { name: "App clients" }).click();
    await page.getByRole("button", { name: "Create app client" }).first().click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Traditional web application").check();
    await dialog.getByLabel("App client name").fill("browser-secret-client");
    await dialog.getByRole("button", { name: "Create app client" }).click();
    await expect(page).toHaveURL(/\/app-clients\/[a-z0-9]{26}$/);
    await expect(page.getByRole("heading", { name: "App client information" })).toBeVisible();
    await expect(page.getByText(/StackSim never displays client secrets in the console/)).toBeVisible();
    await expect(page.locator("main")).not.toContainText("ClientSecret");
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("App client name").fill("browser-secret-renamed");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: "App client: browser-secret-renamed" })).toBeVisible();
    await page.getByRole("tab", { name: "Attribute permissions" }).click();
    await expect(page.getByText(/uses the default permissions/)).toBeVisible();

    const client = sdk();
    try {
      const publicClient = await client.send(new CreateUserPoolClientCommand({
        UserPoolId: poolId,
        ClientName: "browser-public-client",
        ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      }));
      await client.send(new SignUpCommand({
        ClientId: publicClient.UserPoolClient!.ClientId!,
        Username: "browser-user@example.test",
        Password: "BrowserPassword1!",
        UserAttributes: [{ Name: "email", Value: "browser-user@example.test" }],
      }));
    } finally {
      client.destroy();
    }

    await navigation.getByRole("link", { name: "Sign-up", exact: true }).click();
    await page.getByRole("button", { name: "Add custom attributes" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("department");
    await dialog.getByLabel("Minimum length").fill("2");
    await dialog.getByLabel("Maximum length").fill("20");
    await dialog.getByRole("button", { name: "Add custom attribute" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("row").filter({ hasText: "custom:department" })).toContainText("Mutable");
    await page.getByRole("button", { name: "Add custom attributes" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("employeeCode");
    await dialog.getByLabel("Mutable", { exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Add custom attribute" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("row").filter({ hasText: "custom:employeeCode" })).toContainText("Immutable");

    await navigation.getByRole("link", { name: "Users", exact: true }).click();
    await expect(page.getByRole("link", { name: "browser-user@example.test" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "browser-user@example.test" })).toContainText("Unconfirmed");
    await page.getByRole("button", { name: "Create user" }).first().click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Email address", { exact: true }).fill("invited-browser@example.test");
    await dialog.getByLabel("Set a password").check();
    await dialog.getByLabel("Password", { exact: true }).fill("BrowserInvitation1!");
    await dialog.getByLabel("custom:department (optional)").fill("support");
    await dialog.getByLabel("custom:employeeCode (optional)").fill("E-002");
    await dialog.getByRole("button", { name: "Create user" }).click();
    await expect(page.getByRole("link", { name: "invited-browser@example.test" })).toBeVisible();
    const invited = Object.values(simulator.store.regionState("eu-west-1").cognito.pools[poolId].usersBySub)
      .find(user => user.attributes.email?.value === "invited-browser@example.test");
    expect(invited?.status).toBe("FORCE_CHANGE_PASSWORD");
    expect(invited?.attributes["custom:department"]?.value).toBe("support");
    expect(JSON.stringify(simulator.store.regionState("eu-west-1").cognito)).not.toContain("BrowserInvitation1!");

    await page.getByLabel("Search attribute").selectOption("email");
    await page.getByPlaceholder("Search users by attribute (starts with)").fill("invited");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("link", { name: "invited-browser@example.test" })).toBeVisible();
    await expect(page.getByRole("link", { name: "browser-user@example.test" })).toHaveCount(0);
    await page.getByPlaceholder("Search users by attribute (starts with)").fill("");
    await page.getByRole("button", { name: "Search" }).click();

    await page.getByRole("link", { name: "browser-user@example.test" }).click();
    await expect(page.getByRole("heading", { name: "User information" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "User attributes" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "User event history" })).toBeVisible();
    await expect(page.locator("main")).not.toContainText("BrowserPassword1!");
    await page.getByText("Actions ▾").click();
    await page.getByRole("menuitem", { name: "Confirm account" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible();

    await navigation.getByRole("link", { name: "Groups", exact: true }).click();
    await expect(page.getByText("No groups", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create group" }).first().click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Group name").fill("browser-admins");
    await dialog.getByLabel("Description (optional)").fill("Browser administrators");
    await dialog.getByRole("button", { name: "Create group" }).click();
    await page.getByRole("link", { name: "browser-admins" }).click();
    await expect(page.getByRole("heading", { name: "Group information" })).toBeVisible();
    await page.getByRole("button", { name: "Add user to group" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("User").selectOption({ label: "invited-browser@example.test" });
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(page.getByRole("row").filter({ hasText: invited!.username })).toBeVisible();
    expect(invited?.groupNames).toContain("browser-admins");

    await page.goto(`${consoleUrl}#/cognito/user-pools/${poolId}/users/${invited!.sub}`);
    await expect(page.locator("main").getByRole("link", { name: "browser-admins" })).toBeVisible();
    await page.getByText("Actions ▾").click();
    await page.getByRole("menuitem", { name: "Set password", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("New password").fill("BrowserPermanent2!");
    await dialog.getByRole("button", { name: "Set password" }).click();
    await expect(dialog).toBeHidden();
    expect(invited?.status).toBe("CONFIRMED");

    const emailRow = page.getByRole("row").filter({ has: page.getByText("email", { exact: true }) });
    await emailRow.getByRole("button", { name: "Edit" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Value").fill("invited-updated@example.test");
    await dialog.getByRole("button", { name: "Save attribute" }).click();
    await expect(dialog).toBeHidden();
    expect(invited?.attributes.email?.value).toBe("invited-updated@example.test");

    let departmentRow = page.getByRole("row").filter({ has: page.getByText("custom:department", { exact: true }) });
    await expect(departmentRow.getByText("support", { exact: true })).toBeVisible();
    await departmentRow.getByRole("button", { name: "Remove" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/To confirm deletion/).fill("custom:department");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(departmentRow).toHaveCount(0);
    const immutableRow = page.getByRole("row").filter({ has: page.getByText("custom:employeeCode", { exact: true }) });
    await expect(immutableRow).toContainText("Immutable");
    await expect(immutableRow.getByRole("button")).toHaveCount(0);
    await page.getByRole("button", { name: "Add attribute" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Attribute", { exact: true }).selectOption("custom:department");
    await dialog.getByLabel("Value").fill("engineering");
    await dialog.getByRole("button", { name: "Add attribute" }).click();
    await expect(dialog).toBeHidden();
    departmentRow = page.getByRole("row").filter({ has: page.getByText("custom:department", { exact: true }) });
    await expect(departmentRow.getByText("engineering", { exact: true })).toBeVisible();

    await page.getByText("Actions ▾").click();
    await expect(page.getByRole("menuitem", { name: "Delete user" })).toBeDisabled();
    await page.getByRole("menuitem", { name: "Disable user access" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Disable" }).click();
    await expect.poll(() => invited?.enabled).toBe(false);
    await page.getByText("Actions ▾").click();
    await page.getByRole("menuitem", { name: "Enable user access" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Enable" }).click();
    await expect.poll(() => invited?.enabled).toBe(true);
    await page.getByText("Actions ▾").click();
    await page.getByRole("menuitem", { name: "Reset password", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Reset password" }).click();
    await expect(page.locator("#toast-region")).toContainText("Password reset code sent");
    await expect.poll(() => invited?.status).toBe("RESET_REQUIRED");
    await expect(page.locator("main")).toContainText("Reset required");

    await navigation.getByRole("link", { name: "Sign-up", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Attribute verification and user account confirmation" })).toBeVisible();
    await page.getByRole("link", { name: "Filtered SES Inbox" }).click();
    await expect(page).toHaveURL(/#\/ses\/inbox\?originService=cognito-idp$/);
    await expect(page.getByText("This view is filtered to Cognito confirmation messages.", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "Your verification code" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("explains Cognito input panels and their StackSim support", async ({ page }) => {
    const errors = browserErrors(page);
    const { poolId, clientId } = await populatedPool();
    const expectHelp = async (route: string, labels: string[]) => {
      await page.goto(`${consoleUrl}#${route}`);
      for (const label of labels) await expect(page.getByRole("button", { name: `About ${label}`, exact: true })).toBeVisible();
    };

    await expectHelp("/cognito/user-pools", ["User pools"]);
    await expectHelp(`/cognito/user-pools/${poolId}/overview`, ["User pool information"]);
    await expectHelp(`/cognito/user-pools/${poolId}/users`, ["Users"]);
    await page.getByRole("link", { name: "responsive@example.test" }).click();
    for (const label of ["User information", "User attributes", "Group memberships"]) {
      await expect(page.getByRole("button", { name: `About ${label}`, exact: true })).toBeVisible();
    }
    await expectHelp(`/cognito/user-pools/${poolId}/groups`, ["Groups"]);
    await expectHelp(`/cognito/user-pools/${poolId}/app-clients`, ["App clients"]);
    await expectHelp(`/cognito/user-pools/${poolId}/app-clients/${clientId}`, ["App client information"]);
    await expectHelp(`/cognito/user-pools/${poolId}/domain`, ["Domain", "Resource servers"]);
    await expectHelp(`/cognito/user-pools/${poolId}/identity-providers`, ["Social and external providers"]);
    await expectHelp(`/cognito/user-pools/${poolId}/managed-login`, ["Styles"]);
    await expectHelp(`/cognito/user-pools/${poolId}/sign-up`, ["Custom attributes"]);

    const providerHelpButton = page.getByRole("button", { name: "About Custom attributes", exact: true });
    await providerHelpButton.focus();
    const providerHelp = providerHelpButton.locator("..").getByRole("tooltip");
    await expect(providerHelp).toContainText("extend the user schema");
    await expect(providerHelp).toContainText("StackSim support · Supported locally");
    expect(errors).toEqual([]);
  });

  test("keeps all pool views responsive and renders a recoverable route error", async ({ page }) => {
    const errors = browserErrors(page);
    const { poolId, clientId } = await populatedPool();
    await page.setViewportSize({ width: 390, height: 844 });
    const routes = [
      "#/cognito",
      "#/cognito/user-pools",
      "#/cognito/user-pools/create",
      ...["overview", "users", "groups", "app-clients", `app-clients/${clientId}`, "authentication-methods", "sign-in", "sign-up", "identity-providers", "message-templates", "threat-protection", "domain", "managed-login", "lambda-triggers", "settings"]
        .map(path => `#/cognito/user-pools/${poolId}/${path}`),
    ];
    for (const route of routes) {
      await page.goto(`${consoleUrl}${route}`);
      await expect(page.locator("main h1")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), route).toBe(390);
    }

    await page.goto(`${consoleUrl}#/cognito/user-pools/${poolId}/users`);
    const poolBreadcrumb = page.getByRole("navigation", { name: "Breadcrumbs" })
      .getByRole("link", { name: "responsive-users" });
    await expect(poolBreadcrumb).toHaveAttribute("href", `#/cognito/user-pools/${poolId}/overview`);
    await poolBreadcrumb.click();
    await expect(page).toHaveURL(`${consoleUrl}#/cognito/user-pools/${poolId}/overview`);
    await expect(page.getByRole("heading", { name: "User pool information" })).toBeVisible();

    await page.goto(`${consoleUrl}#/cognito/user-pools/eu-west-1_AAAAAAAAA/overview`);
    await expect(page.getByRole("heading", { name: "Unable to load this page" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(errors.filter(error => !/^http 404: GET .*\/_stacksim\/api\/cognito\/user-pools\/eu-west-1_AAAAAAAAA$/.test(error))).toEqual([]);
  });

  test("manages the Cognito domain, resource scopes, typed providers, and sanitized styles", async ({ page }) => {
    const errors = browserErrors(page);
    const { poolId, clientId } = await populatedPool();
    await page.goto(`${consoleUrl}#/cognito/user-pools/${poolId}/identity-providers`);
    await expect(page.getByRole("heading", { name: /Social and external providers/ }).last()).toBeVisible();
    await expect(page.getByText("No external providers", { exact: true })).toBeVisible();
    await expect(page.locator(".alert.info").filter({ hasText: "Loopback providers work by default" })).toBeVisible();
    await page.getByRole("button", { name: "Add identity provider" }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Issuer URL")).toBeVisible();
    await dialog.getByLabel("SAML").check();
    await expect(dialog.getByLabel("Metadata document endpoint URL")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    const discard = page.getByRole("button", { name: "Discard changes" });
    await page.waitForTimeout(200);
    if (await discard.isVisible()) await discard.click();
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.goto(`${consoleUrl}#/cognito/user-pools/${poolId}/domain`);
    await page.waitForTimeout(200);
    if (await discard.isVisible()) await discard.click();
    await expect(page.getByText("Canonical issuer", { exact: true })).toBeVisible();
    await page.getByText("Actions ▾").click();
    await expect(page.getByRole("menuitem", { name: "Create custom domain" })).toBeDisabled();
    await page.getByRole("menuitem", { name: "Create Cognito domain" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Domain prefix").fill("browser-managed-login");
    await dialog.getByRole("button", { name: "Create Cognito domain" }).click();
    await expect(page.getByText("browser-managed-login", { exact: true })).toBeVisible();
    await expect(page.locator("main").getByText("Managed login", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Create resource server" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Resource server name").fill("Browser API");
    await dialog.getByLabel("Resource server identifier").fill("https://browser-api.example.test");
    await dialog.getByLabel("Scope name").first().fill("read");
    await dialog.getByLabel("Description").first().fill("Read browser records");
    await dialog.getByRole("button", { name: "Create resource server" }).click();
    await expect(page.getByText("https://browser-api.example.test/read", { exact: true })).toBeVisible();

    await page.goto(`${consoleUrl}#/cognito/user-pools/${poolId}/app-clients/${clientId}/login-pages`);
    await page.getByRole("button", { name: "Edit", exact: true }).nth(1).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Allowed callback URLs").fill("http://localhost:3000/callback");
    await dialog.getByLabel("Authorization code grant").check();
    await dialog.getByLabel("openid", { exact: true }).check();
    await dialog.getByLabel("https://browser-api.example.test/read").check();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("https://browser-api.example.test/read", { exact: true })).toBeVisible();

    await page.goto(`${consoleUrl}#/cognito/user-pools/${poolId}/managed-login`);
    await expect(page.getByRole("link", { name: "Open managed login" })).toBeVisible();
    await page.getByRole("button", { name: "Create a style" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Page title").fill("Browser account");
    await dialog.getByLabel("Primary color").fill("#334455");
    await dialog.getByRole("button", { name: "Save style" }).click();
    await expect(page.getByText(/Browser account/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("configures REST Cognito and HTTP JWT authorizers, method scopes, and in-memory ID-token testing", async ({ page }) => {
    const errors = browserErrors(page);
    const cognito = sdk();
    const gateway = new APIGatewayClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region: "eu-west-1",
      credentials: { accessKeyId: "admin", secretAccessKey: "password" },
    });
    const httpGateway = new ApiGatewayV2Client({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region: "eu-west-1",
      credentials: { accessKeyId: "admin", secretAccessKey: "password" },
    });
    try {
      const email = "cog02-browser@example.test";
      const createdPool = await cognito.send(new CreateUserPoolCommand({
        PoolName: "cog02-browser-pool",
        UsernameAttributes: ["email"],
        AutoVerifiedAttributes: ["email"],
        Schema: [{ Name: "email", Required: true, Mutable: true }],
      }));
      const poolId = createdPool.UserPool!.Id!;
      const poolArn = createdPool.UserPool!.Arn!;
      const app = await cognito.send(new CreateUserPoolClientCommand({
        UserPoolId: poolId,
        ClientName: "cog02-browser-client",
        ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      }));
      const clientId = app.UserPoolClient!.ClientId!;
      await cognito.send(new SignUpCommand({
        ClientId: clientId,
        Username: email,
        Password: "BrowserPassword1!",
      }));
      await cognito.send(new ConfirmSignUpCommand({
        ClientId: clientId,
        Username: email,
        ConfirmationCode: await confirmationCode(email),
      }));
      const idToken = (await cognito.send(new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: email, PASSWORD: "BrowserPassword1!" },
      }))).AuthenticationResult!.IdToken!;

      const api = await gateway.send(new CreateRestApiCommand({ name: "cog02-browser-rest" }));
      const root = (await gateway.send(new GetResourcesCommand({ restApiId: api.id! })))
        .items!.find(resource => resource.path === "/")!;
      await gateway.send(new PutMethodCommand({
        restApiId: api.id!,
        resourceId: root.id!,
        httpMethod: "GET",
        authorizationType: "NONE",
      }));
      await gateway.send(new PutMethodResponseCommand({
        restApiId: api.id!,
        resourceId: root.id!,
        httpMethod: "GET",
        statusCode: "200",
      }));
      await gateway.send(new PutIntegrationCommand({
        restApiId: api.id!,
        resourceId: root.id!,
        httpMethod: "GET",
        type: "MOCK",
        requestTemplates: { "application/json": "{\"statusCode\":200}" },
      }));
      await gateway.send(new PutIntegrationResponseCommand({
        restApiId: api.id!,
        resourceId: root.id!,
        httpMethod: "GET",
        statusCode: "200",
      }));

      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/authorizers`);
      await expect(page.getByText("No authorizers.")).toBeVisible();
      await page.getByRole("button", { name: "Create authorizer" }).click();
      let dialog = page.getByRole("dialog");
      await dialog.getByLabel("Type").selectOption("COGNITO_USER_POOLS");
      await expect(dialog.getByLabel("Lambda function")).toBeHidden();
      await expect(dialog.getByText("Authoritative Cognito pools")).toBeVisible();
      await dialog.getByLabel("Name").fill("browser-cognito");
      await addArnComboboxValue(dialog.getByLabel("Cognito user pools"), poolArn);
      await dialog.getByLabel("Token validation expression (optional ID-token audience regex)").fill(`^${clientId}$`);
      await dialog.getByLabel("Cache TTL (seconds)").fill("45");
      await dialog.getByRole("button", { name: "Create authorizer" }).click();
      const row = page.locator("tbody tr").filter({ hasText: "browser-cognito" });
      await expect(row).toContainText("COGNITO_USER_POOLS");
      await expect(row).toContainText(poolArn);
      const typeGeometry = await row.locator(".authorizer-type-cell").evaluate(cell => ({
        clientWidth: cell.clientWidth,
        scrollWidth: cell.scrollWidth,
      }));
      expect(typeGeometry.scrollWidth).toBeLessThanOrEqual(typeGeometry.clientWidth);
      await expect(row.locator(".authorizer-provider-cell a")).toHaveCount(0);
      const authorizer = (await gateway.send(new GetAuthorizersCommand({
        restApiId: api.id!,
      }))).items!.find(value => value.name === "browser-cognito")!;
      expect(authorizer.providerARNs).toEqual([poolArn]);

      await row.getByRole("button", { name: "View and test" }).click();
      dialog = page.getByRole("dialog");
      await expect(dialog.getByText("ID token only", { exact: true })).toBeVisible();
      await expect(dialog.getByText(poolArn, { exact: true })).toBeVisible();
      await dialog.getByLabel("Headers (JSON)").fill(JSON.stringify({ Authorization: idToken }, null, 2));
      await dialog.getByRole("button", { name: "Test", exact: true }).click();
      await expect(dialog.locator("#authorizer-test-result")).toContainText(email);
      const stored = await page.evaluate(() => JSON.stringify({
        local: Object.fromEntries(Object.entries(localStorage)),
        session: Object.fromEntries(Object.entries(sessionStorage)),
        href: location.href,
      }));
      expect(stored).not.toContain(idToken);
      await dialog.getByLabel("Cache TTL (seconds)").fill("0");
      await dialog.getByRole("button", { name: "Save changes" }).click();

      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/resources`);
      await page.getByRole("button", { name: /GET .* MOCK/ }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Authorization", { exact: true }).selectOption("COGNITO_USER_POOLS");
      await dialog.getByLabel("Authorizer", { exact: true }).selectOption(authorizer.id!);
      await dialog.getByLabel("Authorization scopes").fill("aws.cognito.signin.user.admin");
      await dialog.getByRole("button", { name: "Save method" }).click();
      const method = await gateway.send(new GetMethodCommand({
        restApiId: api.id!,
        resourceId: root.id!,
        httpMethod: "GET",
      }));
      expect(method.authorizationType).toBe("COGNITO_USER_POOLS");
      expect(method.authorizerId).toBe(authorizer.id);
      expect(method.authorizationScopes).toEqual(["aws.cognito.signin.user.admin"]);

      const httpApi = await httpGateway.send(new CreateApiCommand({
        Name: "cog02-browser-http",
        ProtocolType: "HTTP",
      }));
      await page.goto(`${consoleUrl}#/apigateway/http-apis/${httpApi.ApiId}/authorization`);
      await expect(page.getByText("Cognito JWT integration", { exact: true })).toBeVisible();
      await expect(page.getByText("Resolution is in process", { exact: false })).toBeVisible();
      await page.getByRole("button", { name: "Create authorizer" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill("browser-http-jwt");
      await dialog.getByLabel("Authorizer type").selectOption("JWT");
      await dialog.getByLabel("Issuer URL").fill(`https://cognito-idp.eu-west-1.amazonaws.com/${poolId}`);
      await dialog.getByLabel("Audience").fill(clientId);
      await dialog.getByRole("button", { name: "Create" }).click();
      await expect(page.getByText("browser-http-jwt", { exact: true })).toBeVisible();
      expect((await httpGateway.send(new GetHttpAuthorizersCommand({
        ApiId: httpApi.ApiId!,
      }))).Items).toEqual([
        expect.objectContaining({
          Name: "browser-http-jwt",
          AuthorizerType: "JWT",
          JwtConfiguration: {
            Issuer: `https://cognito-idp.eu-west-1.amazonaws.com/${poolId}`,
            Audience: [clientId],
          },
        }),
      ]);
      expect(errors).toEqual([]);
    } finally {
      cognito.destroy();
      gateway.destroy();
      httpGateway.destroy();
    }
  });
});
