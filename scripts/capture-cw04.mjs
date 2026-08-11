import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { CreateTableCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-cw04-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
const pages = [
  { route: "/cloudwatch/metrics", output: "cloudwatch/metrics", prepare: async page => { await page.getByLabel("Namespace").selectOption("Learning/App"); await page.getByLabel("Graph Requests Route=/notes").check(); await page.locator("#metric-graph svg").waitFor(); } },
  { route: "/lambda/functions/metric-capture-function/monitor", output: "lambda/monitor-metrics" },
  { route: "/dynamodb/tables/MetricCaptureTable/monitor", output: "dynamodb/monitor" },
];
let browser;
const clients = [];
try {
  await simulator.start();
  const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } };
  const cloudwatch = new CloudWatchClient(options); const dynamodb = new DynamoDBClient(options); const iam = new IAMClient(options); const lambda = new LambdaClient(options); clients.push(cloudwatch, dynamodb, iam, lambda);
  const now = Date.now();
  await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Learning/App", MetricData: Array.from({ length: 8 }, (_, index) => ({ MetricName: "Requests", Dimensions: [{ Name: "Route", Value: "/notes" }], Unit: "Count", Timestamp: new Date(now - (7 - index) * 60_000), Value: 4 + index * 2 })) }));
  await dynamodb.send(new CreateTableCommand({ TableName: "MetricCaptureTable", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
  await dynamodb.send(new PutItemCommand({ TableName: "MetricCaptureTable", Item: { id: { S: "capture" }, title: { S: "Automatic metric" } } }));
  await iam.send(new CreateRoleCommand({ RoleName: "metric-capture-role", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  await lambda.send(new CreateFunctionCommand({ FunctionName: "metric-capture-function", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/metric-capture-role", Handler: "handler.echoHandler", Code: { ZipFile: await readFile(resolve("examples/lambda/function.zip")) } }));
  await lambda.send(new InvokeCommand({ FunctionName: "metric-capture-function", Payload: Buffer.from("{}") }));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-15", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console#${pageSpec.route}`); await page.locator("main").waitFor();
      await pageSpec.prepare?.(page);
      await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close();
    }
  }
} finally {
  for (const client of clients) client.destroy();
  await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
}
