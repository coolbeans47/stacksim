import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  AddPermissionCommand,
  CreateAliasCommand,
  CreateFunctionCommand,
  CreateFunctionUrlConfigCommand,
  LambdaClient,
  PublishVersionCommand,
} from "@aws-sdk/client-lambda";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-lam08-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let lambda;
try {
  await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; lambda = new LambdaClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } }); const zip = await readFile(resolve("examples/lambda/function.zip"));
  await lambda.send(new CreateFunctionCommand({ FunctionName: "checkout-stream", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: "handler.echoHandler", Description: "Browser-facing checkout function with streaming and signed endpoints", Code: { ZipFile: zip } })); await new Promise(resolveWait => setTimeout(resolveWait, 20));
  const version = await lambda.send(new PublishVersionCommand({ FunctionName: "checkout-stream", Description: "Production URL target" })); await lambda.send(new CreateAliasCommand({ FunctionName: "checkout-stream", Name: "live", FunctionVersion: version.Version }));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const capture = async (state, prepare) => {
    const output = resolve("docs/ui-reference/2026-07-16/lambda/function-urls", state, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) { const context = await browser.newContext({ viewport: { width, height } }); const page = await context.newPage(); await page.goto(`${endpoint}/_stacksim/console#/lambda/functions/checkout-stream/configuration`); await page.locator(".function-url-card").waitFor(); await page.locator(".function-url-card").scrollIntoViewIfNeeded(); if (prepare) await prepare(page); await page.waitForTimeout(200); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await context.close(); }
  };

  await capture("create", async page => { await page.locator(".function-url-card").getByRole("button", { name: "Create function URL" }).first().click(); await page.getByRole("dialog").waitFor(); });
  await lambda.send(new CreateFunctionUrlConfigCommand({ FunctionName: "checkout-stream", AuthType: "NONE", InvokeMode: "RESPONSE_STREAM", Cors: { AllowOrigins: ["https://checkout.example"], AllowMethods: ["GET", "POST"], AllowHeaders: ["content-type", "x-checkout-token"], ExposeHeaders: ["x-stream-id"], MaxAge: 300 } }));
  await lambda.send(new AddPermissionCommand({ FunctionName: "checkout-stream", StatementId: "public-url", Action: "lambda:InvokeFunctionUrl", Principal: "*", FunctionUrlAuthType: "NONE" })); await lambda.send(new AddPermissionCommand({ FunctionName: "checkout-stream", StatementId: "public-invoke", Action: "lambda:InvokeFunction", Principal: "*", InvokedViaFunctionUrl: true }));
  await lambda.send(new CreateFunctionUrlConfigCommand({ FunctionName: "checkout-stream", Qualifier: "live", AuthType: "AWS_IAM", InvokeMode: "BUFFERED" }));
  await capture("configuration");
  await capture("edit", async page => { await page.locator(".function-url-card tbody tr").filter({ hasText: "$LATEST" }).getByRole("button", { name: "Edit" }).click(); await page.getByRole("dialog").waitFor(); });
} finally {
  lambda?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
