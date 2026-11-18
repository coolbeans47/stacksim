import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackSim } from "../../src/server.js";

for (const width of [1440, 390]) test(`Serverless policies, collection and signed query at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "stacksim-aoss-browser-"));
  const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "enforce", cdkBootstrap: false });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); await page.setViewportSize({ width, height: 900 });
    const base = `http://127.0.0.1:${sim.port}/_stacksim/console`;
    await page.goto(`${base}#/opensearch/serverless/collections`);
    await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No collections", exact: true })).toBeVisible();
    const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" });
    await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click();
    for (const [type, policy] of [
      ["encryption", { Rules: [{ ResourceType: "collection", Resource: ["collection/browser-aoss"] }], AWSOwnedKey: true }],
      ["network", [{ Rules: [{ ResourceType: "collection", Resource: ["collection/browser-aoss"] }], AllowFromPublic: true }]],
      ["data", [{ Rules: [{ ResourceType: "index", Resource: ["index/browser-aoss/*"], Permission: ["aoss:*"] }], Principal: ["arn:aws:iam::000000000000:user/admin"] }]],
    ] as const) {
      await page.goto(`${base}#/opensearch/serverless/policies/${type}/create`);
      await page.getByLabel("Policy name", { exact: true }).fill(`browser-${type}`); await page.getByLabel("Policy JSON", { exact: true }).fill(JSON.stringify(policy));
      await page.getByRole("button", { name: "Create policy", exact: true }).click(); await expect(page.getByRole("link", { name: `browser-${type}`, exact: true })).toBeVisible();
    }
    await page.goto(`${base}#/opensearch/serverless/groups/create`);
    await expect(page.getByLabel('Standby replicas', { exact: true })).toHaveCount(0);
    await page.getByLabel('Group name', { exact: true }).fill('browser-classic'); await page.getByLabel('Generation', { exact: true }).selectOption('CLASSIC');
    await expect(page.getByLabel('Minimum search OCUs', { exact: true })).toHaveValue('1');
    await page.getByRole('button', { name: 'Create collection group', exact: true }).click(); await expect(page.getByRole('heading', { name: 'browser-classic', exact: true })).toBeVisible();
    expect(Object.values(sim.opensearch.serverless.state('eu-west-1').groups!)[0].standbyReplicas).toBe('DISABLED');
    await page.goto(`${base}#/opensearch/serverless/collections/create`);
    await expect(page.getByLabel('Creation method', { exact: true }).locator('option')).toHaveText(['Express Create']);
    await expect(page.getByLabel('Collection group', { exact: true }).locator('option')).toHaveText(['Create group automatically']);
    await page.getByLabel("Serverless generation", { exact: true }).selectOption("CLASSIC"); await page.getByLabel("Creation method", { exact: true }).selectOption("standard"); await page.getByLabel("Collection type", { exact: true }).selectOption("SEARCH");
    await expect(page.getByLabel('Creation method', { exact: true }).locator('option')).toHaveText(['Standard Create']);
    await expect(page.getByLabel('Collection group', { exact: true }).locator('option')).toHaveText(['Ungrouped', 'browser-classic']);
    await expect(page.getByLabel('Data access principal ARN', { exact: true })).not.toBeVisible();
    await page.getByLabel('Collection group', { exact: true }).selectOption('browser-classic');
    await page.getByLabel("Collection name", { exact: true }).fill("browser-aoss"); await page.getByRole("button", { name: "Create collection", exact: true }).click();
    await expect(page.getByRole("heading", { name: "browser-aoss", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Collection query tool", exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ingestion jobs', exact: true })).toHaveCount(0); await expect(page.getByRole('link', { name: 'Ingestion streams', exact: true })).toHaveCount(0);
    const collectionUrl = page.url();
    for (const suffix of ['/ingestion/create', '/streams/create']) { await page.goto(collectionUrl + suffix); await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible(); }
    await page.goto(collectionUrl);
    await page.getByLabel("Method", { exact: true }).selectOption("PUT"); await page.getByLabel("Request path", { exact: true }).fill("/products/_doc/one"); await page.getByLabel("Request body (JSON or NDJSON)", { exact: true }).fill('{"title":"Serverless product"}');
    await page.getByRole("button", { name: "Run request", exact: true }).click(); await expect(page.locator("#aoss-response")).toContainText('"result": "created"');
    await page.getByLabel("Method", { exact: true }).selectOption("GET"); await page.getByLabel("Request body (JSON or NDJSON)", { exact: true }).fill("");
    await page.getByRole("button", { name: "Run request", exact: true }).click(); await expect(page.locator("#aoss-response")).toContainText("Serverless product");
    await page.getByLabel("Description", { exact: true }).fill("Updated browser collection"); await page.getByLabel("Tags (JSON object)", { exact: true }).fill('{"owner":"browser"}');
    await page.getByRole("button", { name: "Save collection", exact: true }).click(); await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Updated browser collection");
    await expect(page.locator("#toast-region")).toBeEmpty();
    await page.screenshot({ path: test.info().outputPath(`serverless-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Delete collection", exact: true }).click(); await page.getByRole("dialog").getByRole("textbox").fill("browser-aoss"); await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No collections", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [1440, 390]) test(`Serverless Express Create, groups and retention at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "stacksim-aoss-express-browser-")), sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "enforce", cdkBootstrap: false });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await sim.start(); await page.setViewportSize({ width, height: 900 }); const base = `http://127.0.0.1:${sim.port}/_stacksim/console`;
    await page.goto(`${base}#/opensearch/serverless/collections/create`);
    await page.locator('[name="accessKeyId"]').fill("admin"); await page.locator('[name="secretAccessKey"]').fill("password"); await page.locator("#console-sign-in").getByRole("button", { name: "Sign in", exact: true }).click();
    const onboarding = page.getByRole("dialog", { name: "Secure the default IAM access key" }); await onboarding.getByRole("radio", { name: /Keep default credentials/ }).check(); await onboarding.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(onboarding).not.toBeVisible(); await page.goto(`${base}#/opensearch/serverless/collections/create`);
    await expect(page.getByLabel("Serverless generation", { exact: true })).toHaveValue("NEXTGEN"); await expect(page.getByLabel("Creation method", { exact: true })).toHaveValue("express");
    await page.getByLabel("Collection name", { exact: true }).fill("browser-logs");
    let interrupted = false;
    await page.route("**/*", async route => { const body = route.request().postData(); if (!interrupted && route.request().headers()["x-amz-target"] === "OpenSearchServerless.CreateAccessPolicy" && body?.includes("browser-logs")) { interrupted = true; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ __type: "InternalServerException", message: "Injected interrupted setup" }) }); } else await route.continue(); });
    await page.getByRole("button", { name: "Create collection", exact: true }).click(); await expect(page.locator("#aoss-create [role=alert]")).toContainText("Injected interrupted setup");
    expect(Object.keys(sim.opensearch.serverless.state("eu-west-1").groups ?? {})).toHaveLength(1); expect(Object.keys(sim.opensearch.serverless.state("eu-west-1").collections)).toHaveLength(0);
    await page.reload(); await expect(page.getByLabel("Collection name", { exact: true })).toHaveValue("browser-logs");
    await page.getByRole("button", { name: "Create collection", exact: true }).click(); await expect(page.getByRole("heading", { name: "Collection query tool", exact: true })).toBeVisible();
    expect(Object.keys(sim.opensearch.serverless.state("eu-west-1").groups ?? {})).toHaveLength(1); expect(Object.keys(sim.opensearch.serverless.state("eu-west-1").policies)).toHaveLength(3);
    expect(Object.values(sim.opensearch.serverless.state('eu-west-1').groups!)[0].standbyReplicas).toBe('DISABLED');
    await expect(page.getByRole('link', { name: 'Ingestion jobs', exact: true })).toHaveCount(0); await expect(page.getByRole('link', { name: 'Ingestion streams', exact: true })).toHaveCount(0);
    await page.getByLabel("Method", { exact: true }).selectOption("POST"); await page.getByLabel("Request path", { exact: true }).fill("/events/_doc"); await page.getByLabel("Request body (JSON or NDJSON)", { exact: true }).fill('{"message":"Express event"}'); await page.getByRole("button", { name: "Run request", exact: true }).click(); await expect(page.locator("#aoss-response")).toContainText('"result": "created"');
    await page.goto(`${base}#/opensearch/serverless/groups`); await page.getByRole("link", { name: "nextgen-browser-logs", exact: true }).click();
    await expect(page.getByLabel('Standby replicas', { exact: true })).toHaveCount(0);
    await page.getByLabel("Minimum search OCUs", { exact: true }).fill("2"); await page.getByRole("button", { name: "Save collection group", exact: true }).click(); await expect(page.getByText(/Allocated search: 2 OCUs/)).toBeVisible();
    await page.goto(`${base}#/opensearch/serverless/policies/retention/create`); await page.getByLabel("Policy name", { exact: true }).fill("browser-retention"); await page.getByLabel("Policy JSON", { exact: true }).fill(JSON.stringify({ Rules: [{ ResourceType: "index", Resource: ["index/browser-logs/*"], MinIndexRetention: "1d" }] })); await page.getByRole("button", { name: "Create policy", exact: true }).click(); await page.getByRole("link", { name: "browser-retention", exact: true }).click();
    await expect(page.getByLabel("Policy JSON", { exact: true })).toContainText("1d"); await expect(page.locator("#toast-region")).toBeEmpty();
    await page.screenshot({ path: test.info().outputPath(`serverless-express-${width}.png`), fullPage: true }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
  } finally { await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
