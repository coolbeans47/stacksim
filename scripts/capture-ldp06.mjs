// LDP-06 console captures: function list filters, create form with Advanced settings, Code tab editor for a
// CLI-created package, Add trigger (S3), Test tab with a template, Monitor graphs. Run after `npm run build`:
//   node scripts/capture-ldp06.mjs [output-root]
// Output defaults to ../stacksim-designs/ui-reference/2026-10-22/lambda/ldp06/<state>/final/<viewport>.jpg.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateTopicCommand, SNSClient } from "@aws-sdk/client-sns";
import { createZip } from "../dist/src/core/zip-create.js";
import { StackSim } from "../dist/src/server.js";

const outputRoot = resolve(process.argv[2] ?? "../stacksim-designs/ui-reference/2026-10-22/lambda/ldp06");
const root = await mkdtemp(join(tmpdir(), "stacksim-ldp06-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
const region = "eu-west-1"; const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
let browser; let lambda; let s3; let sns;

try {
  await simulator.start(); const endpoint = `http://127.0.0.1:${simulator.port}`; const options = { endpoint, region, credentials };
  lambda = new LambdaClient(options); s3 = new S3Client({ ...options, forcePathStyle: true }); sns = new SNSClient(options);
  const iam = new IAMClient(options); await iam.send(new CreateRoleCommand({ RoleName: "capture-role", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) })); iam.destroy();
  const role = "arn:aws:iam::000000000000:role/capture-role";
  const code = (source, helper) => createZip([{ name: "index.js", content: source }, ...(helper ? [{ name: "lib/util.js", content: helper }] : [])]);
  await lambda.send(new CreateFunctionCommand({ FunctionName: "orders-api", Runtime: "nodejs22.x", Role: role, Handler: "index.handler", Description: "Created from the AWS CLI", Code: { ZipFile: code('const util = require("./lib/util.js");\nexports.handler = async event => {\n  console.log("Order event", JSON.stringify(event));\n  return { statusCode: 200, body: JSON.stringify({ ok: true, helper: util.name }) };\n};\n', 'exports.name = "pricing";\n') } }));
  await lambda.send(new CreateFunctionCommand({ FunctionName: "image-resizer", Runtime: "nodejs24.x", Role: role, Handler: "index.handler", Architectures: ["arm64"], Description: "arm64 thumbnail generator", Code: { ZipFile: code('exports.handler = async event => ({ resized: event.Records?.length ?? 0 });\n') } }));
  await lambda.send(new CreateFunctionCommand({ FunctionName: "nightly-report", Runtime: "nodejs20.x", Role: role, Handler: "index.handler", Description: "Scheduled summary", Code: { ZipFile: code('exports.handler = async () => ({ report: "ok" });\n') } }));
  await s3.send(new CreateBucketCommand({ Bucket: "order-uploads" })); await sns.send(new CreateTopicCommand({ Name: "order-events" }));
  await new Promise(resolveWait => setTimeout(resolveWait, 50));
  for (let index = 0; index < 4; index++) await lambda.send(new InvokeCommand({ FunctionName: "orders-api", Payload: Buffer.from(JSON.stringify({ orderId: index })) }));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const capture = async (state, hash, ready, prepare) => {
    const output = join(outputRoot, state, "final"); await mkdir(output, { recursive: true });
    for (const [filename, width, height] of viewports) { const context = await browser.newContext({ viewport: { width, height } }); const page = await context.newPage(); await page.goto(`${endpoint}/_stacksim/console${hash}`); await page.locator(ready).waitFor(); if (prepare) await prepare(page); await page.waitForTimeout(250); await page.screenshot({ path: join(output, filename), type: "jpeg", quality: 88, fullPage: true }); await context.close(); }
  };

  await capture("list-filters", "#/lambda/functions", ".functions-list-card", async page => { await page.getByLabel("Runtime filter").selectOption("nodejs22.x"); });
  await capture("create-advanced", "#/lambda/functions", ".functions-list-card", async page => { await page.getByRole("button", { name: "Create function" }).first().click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Function name").fill("checkout-handler"); await dialog.getByLabel("Runtime").selectOption("nodejs24.x"); await dialog.getByLabel("Architecture").selectOption("arm64"); await dialog.getByText("Advanced settings").click(); await dialog.getByLabel("Enable function URL").check(); await dialog.getByLabel("Tags (JSON object)").fill('{"team":"checkout"}'); });
  await capture("code-editor", "#/lambda/functions/orders-api", "#lambda-source-code", async page => { const editor = page.locator("#lambda-source-code"); await editor.fill((await editor.inputValue()).replace("ok: true", "ok: true, version: 2")); });
  await capture("add-trigger-s3", "#/lambda/functions/orders-api", ".trigger-card", async page => { await page.getByRole("button", { name: "Add trigger" }).first().click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Trigger type").selectOption("s3"); await dialog.getByLabel("Prefix (optional)").fill("incoming/"); });
  await capture("add-trigger-eventbridge", "#/lambda/functions/nightly-report", ".trigger-card", async page => { await page.getByRole("button", { name: "Add trigger" }).first().click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Trigger type").selectOption("eventbridge"); await dialog.getByLabel("Rule type").selectOption("schedule"); await dialog.getByLabel("Schedule expression").fill("cron(0 6 * * ? *)"); });
  await capture("test-template", "#/lambda/functions/orders-api/test", ".lambda-test-event-card", async page => { await page.getByLabel("Event template").selectOption("s3Put"); await page.getByLabel("Event name").fill("s3-put"); await page.locator("#save-test").click(); await page.locator("#run-test").click(); await page.locator("#lambda-result").getByText("Succeeded", { exact: true }).waitFor(); });
  await capture("monitor-graphs", "#/lambda/functions/orders-api/monitor", ".lambda-metrics-card");
  await capture("permissions", "#/lambda/functions/orders-api/configuration", ".permissions-card", async page => { await page.locator(".permissions-card").getByRole("button", { name: "Add permission" }).click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Principal", { exact: true }).fill("s3.amazonaws.com"); await dialog.getByLabel("Source ARN").fill("arn:aws:s3:::order-uploads"); await dialog.getByLabel("Source account").fill("000000000000"); });
  console.log(`captures written under ${outputRoot}`);
} finally {
  lambda?.destroy(); s3?.destroy(); sns?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
