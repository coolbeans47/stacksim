import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  CreateRestApiCommand,
  GetResourcesCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
  UpdateAccountCommand,
  UpdateStageCommand,
} from "@aws-sdk/client-api-gateway";
import { AddPermissionCommand, CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateLogGroupCommand, CloudWatchLogsClient, DescribeLogStreamsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { StackSim } from "../dist/src/server.js";
import { createZip } from "../dist/src/core/zip-create.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-cw02-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
const region = "eu-west-1"; const account = "000000000000"; const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
let browser; const clients = [];

try {
  await simulator.start(); const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials }; const iam = new IAMClient(options); const lambda = new LambdaClient(options); const gateway = new APIGatewayClient(options); const logs = new CloudWatchLogsClient(options); clients.push(iam, lambda, gateway, logs);
  const lambdaRole = await iam.send(new CreateRoleCommand({ RoleName: "cw02-capture-lambda", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) })); await iam.send(new PutRolePolicyCommand({ RoleName: "cw02-capture-lambda", PolicyName: "logs", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }] }) }));
  const gatewayRole = await iam.send(new CreateRoleCommand({ RoleName: "cw02-capture-gateway", AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "sts:AssumeRole" }] }) })); await iam.send(new PutRolePolicyCommand({ RoleName: "cw02-capture-gateway", PolicyName: "logs", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }] }) })); await gateway.send(new UpdateAccountCommand({ patchOperations: [{ op: "replace", path: "/cloudwatchRoleArn", value: gatewayRole.Role.Arn }] }));
  const zip = createZip([{ name: "index.mjs", content: 'export async function handler(event, context) { console.log(JSON.stringify({ message: "Correlated orders request", apiRequestId: event.requestContext.requestId, lambdaRequestId: context.awsRequestId })); return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "orders", correlated: true }) }; }' }]); const fn = await lambda.send(new CreateFunctionCommand({ FunctionName: "correlated-orders", Runtime: "nodejs22.x", Role: lambdaRole.Role.Arn, Handler: "index.handler", Code: { ZipFile: zip }, Description: "CW-02 correlated API request fixture" }));
  const api = await gateway.send(new CreateRestApiCommand({ name: "correlated-orders-api", description: "API Gateway to Lambda service-log correlation" })); await lambda.send(new AddPermissionCommand({ FunctionName: "correlated-orders", StatementId: "gateway", Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com", SourceArn: `arn:aws:execute-api:${region}:${account}:${api.id}/*/*/*`, SourceAccount: account })); const resource = (await gateway.send(new GetResourcesCommand({ restApiId: api.id }))).items.find(item => item.path === "/"); await gateway.send(new PutMethodCommand({ restApiId: api.id, resourceId: resource.id, httpMethod: "GET", authorizationType: "NONE" })); await gateway.send(new PutMethodResponseCommand({ restApiId: api.id, resourceId: resource.id, httpMethod: "GET", statusCode: "200" })); await gateway.send(new PutIntegrationCommand({ restApiId: api.id, resourceId: resource.id, httpMethod: "GET", type: "AWS_PROXY", integrationHttpMethod: "POST", uri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${fn.FunctionArn}/invocations` })); await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id, resourceId: resource.id, httpMethod: "GET", statusCode: "200" })); await gateway.send(new CreateDeploymentCommand({ restApiId: api.id, stageName: "dev", description: "CW-02 correlated logging stage" })); await logs.send(new CreateLogGroupCommand({ logGroupName: "/learning/cw02-access" })); await gateway.send(new UpdateStageCommand({ restApiId: api.id, stageName: "dev", patchOperations: [{ op: "replace", path: "/*/*/logging/loglevel", value: "INFO" }, { op: "replace", path: "/accessLogSettings/destinationArn", value: `arn:aws:logs:${region}:${account}:log-group:/learning/cw02-access` }, { op: "replace", path: "/accessLogSettings/format", value: '{"requestId":"$context.requestId","extendedRequestId":"$context.extendedRequestId","apiId":"$context.apiId","stage":"$context.stage","lambdaRequestId":"$context.integration.requestId","time":"$context.requestTimeEpoch"}' }] }));
  await fetch(`http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/`); const functionGroup = "/aws/lambda/correlated-orders"; const functionStream = (await logs.send(new DescribeLogStreamsCommand({ logGroupName: functionGroup, orderBy: "LastEventTime", descending: true }))).logStreams[0].logStreamName; const executionGroup = `API-Gateway-Execution-Logs_${api.id}/dev`;
  const pages = [
    { output: "lambda-monitor", hash: "#/lambda/functions/correlated-orders/monitor", heading: "Function metrics" },
    { output: "lambda-stream", hash: `#/cloudwatch/log-groups/${encodeURIComponent(functionGroup)}/streams/${encodeURIComponent(functionStream)}`, heading: "Log events" },
    { output: "lambda-related", hash: `#/cloudwatch/log-groups/${encodeURIComponent(functionGroup)}`, heading: "Related resources (1)" },
    { output: "api-stage-logs", hash: `#/apigateway/apis/${api.id}/stages`, heading: "Logs and tracing" },
    { output: "api-related", hash: `#/cloudwatch/log-groups/${encodeURIComponent(executionGroup)}`, heading: "Related resources (1)" },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-16/cloudwatch/cw02", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const page = await browser.newPage({ viewport: { width, height } }); await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console${pageSpec.hash}`); await page.getByRole("heading", { name: pageSpec.heading, exact: true }).first().waitFor(); await page.evaluate(async () => { const content = document.querySelector("main"); if (content) { content.scrollTop = content.scrollHeight; await new Promise(resolvePaint => requestAnimationFrame(resolvePaint)); content.scrollTop = 0; } await new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))); }); await page.waitForTimeout(100); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close();
    }
  }
} finally {
  clients.forEach(client => client.destroy()); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
}
