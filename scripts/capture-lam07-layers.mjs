import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { AddLayerVersionPermissionCommand, CreateFunctionCommand, LambdaClient, PublishLayerVersionCommand } from "@aws-sdk/client-lambda";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-lam07-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let lambda;
try {
  await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; lambda = new LambdaClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } }); const zip = await readFile(resolve("examples/lambda/function.zip"));
  const utilities1 = await lambda.send(new PublishLayerVersionCommand({ LayerName: "checkout-utilities", Description: "Shared checkout validation and formatting", LicenseInfo: "MIT", Content: { ZipFile: zip }, CompatibleRuntimes: ["nodejs22.x", "nodejs20.x"], CompatibleArchitectures: ["x86_64"] }));
  const utilities2 = await lambda.send(new PublishLayerVersionCommand({ LayerName: "checkout-utilities", Description: "Adds currency normalization and structured errors", LicenseInfo: "MIT", Content: { ZipFile: zip }, CompatibleRuntimes: ["nodejs22.x"], CompatibleArchitectures: ["x86_64"] }));
  const observability = await lambda.send(new PublishLayerVersionCommand({ LayerName: "observability-tools", Description: "Structured logging helpers for Node.js services", LicenseInfo: "Apache-2.0", Content: { ZipFile: zip }, CompatibleRuntimes: ["nodejs22.x"], CompatibleArchitectures: ["x86_64"] }));
  await lambda.send(new AddLayerVersionPermissionCommand({ LayerName: "checkout-utilities", VersionNumber: utilities2.Version, StatementId: "platform-account", Action: "lambda:GetLayerVersion", Principal: "111122223333" }));
  await lambda.send(new AddLayerVersionPermissionCommand({ LayerName: "checkout-utilities", VersionNumber: utilities2.Version, StatementId: "engineering-org", Action: "lambda:GetLayerVersion", Principal: "*", OrganizationId: "o-abc123def456" }));
  await lambda.send(new CreateFunctionCommand({ FunctionName: "checkout-api", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: "handler.echoHandler", Description: "Checkout API with shared utilities and observability", Code: { ZipFile: zip }, Layers: [observability.LayerVersionArn, utilities2.LayerVersionArn] })); await new Promise(resolveWait => setTimeout(resolveWait, 20));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const capture = async (state, route, prepare) => {
    const output = resolve("docs/ui-reference/2026-07-16/lambda/layers", state, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) { const context = await browser.newContext({ viewport: { width, height } }); const page = await context.newPage(); await page.goto(`${endpoint}/_stacksim/console#${route}`); await page.locator("main").waitFor(); if (prepare) await prepare(page); await page.waitForTimeout(200); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await context.close(); }
  };
  await capture("list", "/lambda/layers", async page => { await page.locator(".layers-list-card").scrollIntoViewIfNeeded(); });
  await capture("version", `/lambda/layers/checkout-utilities/versions/${utilities2.Version}`, async page => { await page.locator(".layer-permissions-card").scrollIntoViewIfNeeded(); });
  await capture("configuration", "/lambda/functions/checkout-api/configuration", async page => { await page.locator(".layers-card").scrollIntoViewIfNeeded(); });
  void utilities1;
} finally {
  lambda?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
