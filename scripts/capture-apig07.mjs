import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { APIGatewayClient, CreateDeploymentCommand, CreateRestApiCommand, TagResourceCommand, UpdateAccountCommand, UpdateStageCommand } from "@aws-sdk/client-api-gateway";
import { CloudWatchLogsClient, CreateLogGroupCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-apig07-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let gateway; let iam; let logs;
try {
  await simulator.start(); const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } }; gateway = new APIGatewayClient(options); iam = new IAMClient(options); logs = new CloudWatchLogsClient(options);
  const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "sts:AssumeRole" }] }); const role = await iam.send(new CreateRoleCommand({ RoleName: "tutorial-apigateway-logs", AssumeRolePolicyDocument: trust })); await iam.send(new PutRolePolicyCommand({ RoleName: "tutorial-apigateway-logs", PolicyName: "CloudWatchLogs", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }] }) })); await gateway.send(new UpdateAccountCommand({ patchOperations: [{ op: "replace", path: "/cloudwatchRoleArn", value: role.Role.Arn }] })); await logs.send(new CreateLogGroupCommand({ logGroupName: "/learning/orders-access" }));
  const api = await gateway.send(new CreateRestApiCommand({ name: "orders-stage-api", description: "Observable staged release tutorial" })); const stable = await gateway.send(new CreateDeploymentCommand({ restApiId: api.id, stageName: "prod", description: "Stable orders API" })); const canary = await gateway.send(new CreateDeploymentCommand({ restApiId: api.id, description: "Checkout preview" })); const accessFormat = '{"requestId":"$context.requestId","status":"$context.status","latency":"$context.integrationLatency","canary":"$context.isCanaryRequest"}';
  await gateway.send(new UpdateStageCommand({ restApiId: api.id, stageName: "prod", patchOperations: [
    { op: "add", path: "/description", value: "Production traffic with a reproducible preview lane" }, { op: "add", path: "/variables/release", value: "stable" }, { op: "add", path: "/*/*/metrics/enabled", value: "true" }, { op: "add", path: "/*/*/logging/loglevel", value: "INFO" }, { op: "add", path: "/*/*/logging/dataTrace", value: "false" }, { op: "add", path: "/*/*/throttling/rateLimit", value: "250" }, { op: "add", path: "/*/*/throttling/burstLimit", value: "100" }, { op: "add", path: "/*/*/caching/enabled", value: "true" }, { op: "add", path: "/*/*/caching/ttlInSeconds", value: "120" }, { op: "add", path: "/tracingEnabled", value: "true" }, { op: "add", path: "/cacheClusterEnabled", value: "true" }, { op: "add", path: "/cacheClusterSize", value: "0.5" }, { op: "add", path: "/accessLogSettings/destinationArn", value: "arn:aws:logs:eu-west-1:000000000000:log-group:/learning/orders-access" }, { op: "add", path: "/accessLogSettings/format", value: accessFormat }, { op: "add", path: "/canarySettings/deploymentId", value: canary.id }, { op: "add", path: "/canarySettings/percentTraffic", value: "15" }, { op: "add", path: "/canarySettings/stageVariableOverrides/release", value: "preview" }, { op: "add", path: "/canarySettings/useStageCache", value: "false" },
  ] })); const arn = `arn:aws:apigateway:eu-west-1::/restapis/${api.id}/stages/prod`; await gateway.send(new TagResourceCommand({ resourceArn: arn, tags: { environment: "production", owner: "checkout" } }));
  const pages = [
    { output: "stage-overview", prepare: async () => undefined },
    { output: "logs-tracing", prepare: async page => { await page.locator("#stage-logs").getByRole("button", { name: "Edit" }).click(); await page.getByRole("dialog").waitFor(); } },
    { output: "canary-release", prepare: async page => { await page.locator("#stage-canary").getByRole("button", { name: "Edit" }).click(); await page.getByRole("dialog").waitFor(); } },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const pageSpec of pages) { const output = resolve("docs/ui-reference/2026-07-16/apigateway/apig07", pageSpec.output, "final"); await mkdir(output, { recursive: true }); for (const [name, width, height] of viewports) { const page = await browser.newPage({ viewport: { width, height } }); await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console#/apigateway/apis/${api.id}/stages`); await page.locator("#stage-deployment").waitFor(); await pageSpec.prepare(page); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close(); } }
} finally { gateway?.destroy(); iam?.destroy(); logs?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
