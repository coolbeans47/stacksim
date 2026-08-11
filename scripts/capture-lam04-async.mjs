import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CreateFunctionCommand, InvokeCommand, LambdaClient, PutFunctionEventInvokeConfigCommand } from "@aws-sdk/client-lambda";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-lam04-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let lambda;
try {
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  lambda = new LambdaClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  const zip = await readFile(resolve("examples/lambda/function.zip")); const role = "arn:aws:iam::000000000000:role/test";
  const source = await lambda.send(new CreateFunctionCommand({ FunctionName: "async-order-processor", Runtime: "nodejs22.x", Role: role, Handler: "handler.throwingHandler", Timeout: 5, Description: "Demonstrates durable asynchronous retries", Code: { ZipFile: zip } }));
  const destination = await lambda.send(new CreateFunctionCommand({ FunctionName: "async-delivery-audit", Runtime: "nodejs22.x", Role: role, Handler: "handler.echoHandler", Timeout: 5, Description: "Receives success and failure destination envelopes", Code: { ZipFile: zip } }));
  await new Promise(resolveWait => setTimeout(resolveWait, 20));
  await lambda.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: source.FunctionName, MaximumEventAgeInSeconds: 600, MaximumRetryAttempts: 1, DestinationConfig: { OnSuccess: { Destination: destination.FunctionArn }, OnFailure: { Destination: destination.FunctionArn } } }));
  await lambda.send(new InvokeCommand({ FunctionName: source.FunctionName, InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ orderId: "order-1042", action: "capture" })) }));
  const deadline = Date.now() + 5_000; while (true) { const summary = await (await fetch(`${endpoint}/_stacksim/api/lambda/async?functionName=${source.FunctionName}`)).json(); if (summary.retrying === 1) break; if (Date.now() >= deadline) throw new Error("Async invocation did not enter retry wait"); await new Promise(resolveWait => setTimeout(resolveWait, 20)); }

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const capture = async (state, route, prepare) => {
    const output = resolve("docs/ui-reference/2026-07-15/lambda/async-invocation", state, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) { const context = await browser.newContext({ viewport: { width, height } }); const page = await context.newPage(); await page.goto(`${endpoint}/_stacksim/console#/lambda/functions/async-order-processor/${route}`); await page.locator("main").waitFor(); if (prepare) await prepare(page); await page.waitForTimeout(200); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await context.close(); }
  };
  await capture("configuration", "configuration", async page => { if (page.viewportSize().width <= 390) await page.locator(".async-invocation-card").scrollIntoViewIfNeeded(); });
  await capture("configuration-modal", "configuration", async page => { await page.locator(".async-invocation-card").getByRole("button", { name: "Edit" }).click(); await page.getByRole("dialog").waitFor(); });
  await capture("monitor", "monitor");
} finally {
  lambda?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
