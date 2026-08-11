import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CreateAliasCommand, CreateFunctionCommand, InvokeCommand, LambdaClient, PublishVersionCommand, PutFunctionConcurrencyCommand, PutProvisionedConcurrencyConfigCommand } from "@aws-sdk/client-lambda";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-lam06-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let lambda;
try {
  await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; lambda = new LambdaClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } }); const zip = await readFile(resolve("examples/lambda/function.zip"));
  await lambda.send(new CreateFunctionCommand({ FunctionName: "checkout-concurrency", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: "handler.concurrencyHandler", Timeout: 3, Description: "Reserved and provisioned checkout capacity", Code: { ZipFile: zip } })); await new Promise(resolveWait => setTimeout(resolveWait, 20));
  const version = await lambda.send(new PublishVersionCommand({ FunctionName: "checkout-concurrency", Description: "Stable checkout runtime" })); await lambda.send(new CreateAliasCommand({ FunctionName: "checkout-concurrency", Name: "live", FunctionVersion: version.Version, Description: "Production checkout traffic" })); await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: "checkout-concurrency", ReservedConcurrentExecutions: 2 }));
  await lambda.send(new PutProvisionedConcurrencyConfigCommand({ FunctionName: "checkout-concurrency", Qualifier: version.Version, ProvisionedConcurrentExecutions: 1 })); await lambda.send(new PutProvisionedConcurrencyConfigCommand({ FunctionName: "checkout-concurrency", Qualifier: "live", ProvisionedConcurrentExecutions: 1 })); await new Promise(resolveWait => setTimeout(resolveWait, 100));
  const first = lambda.send(new InvokeCommand({ FunctionName: "checkout-concurrency", Qualifier: "live", Payload: Buffer.from('{"waitMs":180}') })); const second = lambda.send(new InvokeCommand({ FunctionName: "checkout-concurrency", Qualifier: "live", Payload: Buffer.from('{"waitMs":180}') })); await new Promise(resolveWait => setTimeout(resolveWait, 40)); try { await lambda.send(new InvokeCommand({ FunctionName: "checkout-concurrency", Qualifier: "live", Payload: Buffer.from("{}") })); } catch {} await Promise.all([first, second]);

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const capture = async (state, route, prepare) => {
    const output = resolve("docs/ui-reference/2026-07-16/lambda/concurrency", state, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) { const context = await browser.newContext({ viewport: { width, height } }); const page = await context.newPage(); await page.goto(`${endpoint}/_stacksim/console#${route}`); await page.locator("main").waitFor(); if (prepare) await prepare(page); await page.waitForTimeout(200); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await context.close(); }
  };
  await capture("configuration", "/lambda/functions/checkout-concurrency/configuration", async page => { await page.locator(".concurrency-card").scrollIntoViewIfNeeded(); });
  await capture("aliases", "/lambda/functions/checkout-concurrency/aliases", async page => { await page.locator(".provisioned-aliases-card").scrollIntoViewIfNeeded(); });
  await capture("monitor", "/lambda/functions/checkout-concurrency/monitor", async page => { await page.getByRole("heading", { name: "Function metrics" }).scrollIntoViewIfNeeded(); });
} finally {
  lambda?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
