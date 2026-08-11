import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { CreateEventSourceMappingCommand, CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-lam05-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let lambda; let dynamodb;
try {
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const options = { endpoint, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } };
  lambda = new LambdaClient(options); dynamodb = new DynamoDBClient(options);
  const table = await dynamodb.send(new CreateTableCommand({
    TableName: "TriggerOrders",
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "orderId", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }],
    StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
  }));
  const zip = await readFile(resolve("examples/lambda/function.zip"));
  const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "stream-order-processor", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: "handler.dynamoStreamHandler", Timeout: 5, Description: "Processes filtered DynamoDB stream batches", Code: { ZipFile: zip }, Environment: { Variables: { TABLE_NAME: "TriggerOrders", STACKSIM_ENDPOINT: endpoint } } }));
  await new Promise(resolveWait => setTimeout(resolveWait, 20));
  await lambda.send(new CreateEventSourceMappingCommand({
    FunctionName: fn.FunctionArn,
    EventSourceArn: table.TableDescription.LatestStreamArn,
    StartingPosition: "TRIM_HORIZON",
    BatchSize: 25,
    MaximumBatchingWindowInSeconds: 2,
    ParallelizationFactor: 2,
    MaximumRecordAgeInSeconds: 3600,
    MaximumRetryAttempts: 2,
    BisectBatchOnFunctionError: true,
    FunctionResponseTypes: ["ReportBatchItemFailures"],
    FilterCriteria: { Filters: [{ Pattern: '{"dynamodb":{"NewImage":{"status":{"S":["READY"]}}}}' }] },
  }));
  await new Promise(resolveWait => setTimeout(resolveWait, 20));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const capture = async (state, route, prepare) => {
    const output = resolve("docs/ui-reference/2026-07-15/lambda/event-source-mappings", state, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const context = await browser.newContext({ viewport: { width, height } }); const page = await context.newPage();
      await page.goto(`${endpoint}/_stacksim/console#${route}`); await page.locator("main").waitFor();
      if (prepare) await prepare(page); await page.waitForTimeout(200);
      await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await context.close();
    }
  };
  await capture("lambda-overview", "/lambda/functions/stream-order-processor", async page => { await page.locator(".trigger-card").scrollIntoViewIfNeeded(); });
  await capture("add-trigger", "/lambda/functions/stream-order-processor", async page => { await page.locator('[data-action="add-trigger"]').click(); await page.getByRole("dialog").waitFor(); });
  await capture("dynamodb-stream", "/dynamodb/tables/TriggerOrders/streams", async page => { await page.locator(".trigger-card").scrollIntoViewIfNeeded(); });
} finally {
  lambda?.destroy(); dynamodb?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
