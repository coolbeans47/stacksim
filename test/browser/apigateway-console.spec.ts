import { expect, test, type Page } from "@playwright/test";
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  GetAuthorizersCommand,
  GetIntegrationCommand,
  GetMethodCommand,
  GetResourcesCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
} from "@aws-sdk/client-api-gateway";
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateStageCommand,
  GetApisCommand,
  GetIntegrationsCommand,
  GetRoutesCommand,
  GetStagesCommand,
} from "@aws-sdk/client-apigatewayv2";
import { CreateFunctionCommand, GetPolicyCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillArnCombobox } from "./arn-combobox.js";
import { StackSim } from "../../src/server.js";

let simulator: StackSim;
let dataDir: string;
let consoleUrl: string;
const account = "000000000000";

function sdkOptions(target: StackSim) {
  return { endpoint: `http://127.0.0.1:${target.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } };
}

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  const expectedMissingPolicy = (url: string) => /\/2015-03-31\/functions\/[^/]+\/policy$/.test(url);
  page.on("console", message => { if ((message.type() === "error" || message.type() === "warning") && !(expectedMissingPolicy(message.location().url) && /404/.test(message.text()))) errors.push(`${message.type()}: ${message.text()}`); });
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("response", response => { if (response.status() >= 400 && !(response.status() === 404 && response.request().method() === "GET" && expectedMissingPolicy(response.url()))) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`); });
  return errors;
}

async function createRole(target: StackSim, roleName: string, service: string) {
  const response = await fetch(`http://127.0.0.1:${target.port}/_stacksim/api/iam/roles`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ RoleName: roleName, AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }] } }) });
  if (!response.ok) throw new Error(`Unable to create ${roleName} (${response.status})`);
}

async function createFunction(target: StackSim, name: string, handler: string) {
  const lambda = new LambdaClient(sdkOptions(target));
  try { return await lambda.send(new CreateFunctionCommand({ FunctionName: name, Runtime: "nodejs22.x", Role: `arn:aws:iam::${account}:role/apigw-browser-lambda-role`, Handler: handler, Code: { ZipFile: await readFile(join(process.cwd(), "examples/lambda/function.zip")) } })); }
  finally { lambda.destroy(); }
}

async function policyStatements(target: StackSim, name: string): Promise<any[]> {
  const lambda = new LambdaClient(sdkOptions(target));
  try { return JSON.parse((await lambda.send(new GetPolicyCommand({ FunctionName: name }))).Policy ?? "{}").Statement ?? []; }
  catch { return []; }
  finally { lambda.destroy(); }
}

const sourceArns = (statements: any[]) => statements.map(statement => statement.Condition?.ArnLike?.["AWS:SourceArn"]);

test.describe("API Gateway developer console workflows", () => {
  test.beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "stacksim-apigw-browser-"));
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off" });
    await simulator.start();
    consoleUrl = `http://127.0.0.1:${simulator.port}/_stacksim/console`;
    await createRole(simulator, "apigw-browser-lambda-role", "lambda.amazonaws.com");
  });

  test.afterEach(async () => {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("DPG-14 and DPG-15 create Lambda, Mock, HTTP, and AWS service methods and add the Lambda permission", async ({ page }) => {
    await createFunction(simulator, "apigw-orders", "handler.proxyEchoHandler");
    const gateway = new APIGatewayClient(sdkOptions(simulator));
    try {
      const api = await gateway.send(new CreateRestApiCommand({ name: "dpg-14-api" }));
      const root = (await gateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!;
      const orders = await gateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: root.id!, pathPart: "orders" }));
      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/resources`);
      await page.getByRole("treeitem", { name: "/orders, resource" }).click();

      await page.getByRole("button", { name: "Create method" }).click();
      let dialog = page.getByRole("dialog");
      await dialog.getByLabel("Method type").selectOption("POST");
      await expect(dialog.getByRole("radio", { name: /^Lambda function/ })).toBeChecked();
      await fillArnCombobox(dialog.getByLabel("Lambda function", { exact: true }), `arn:aws:lambda:eu-west-1:${account}:function:apigw-orders`);
      await expect(dialog.locator("[data-permission-preview]")).toContainText(`${api.id}/*/POST/orders`);
      await dialog.getByRole("button", { name: "Create method" }).click();
      await expect(page.getByRole("button", { name: "POST · AWS_PROXY" })).toBeVisible();
      const lambdaIntegration = await gateway.send(new GetIntegrationCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "POST" }));
      expect(lambdaIntegration).toEqual(expect.objectContaining({ type: "AWS_PROXY", httpMethod: "POST", uri: `arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-1:${account}:function:apigw-orders/invocations` }));
      await expect.poll(async () => sourceArns(await policyStatements(simulator, "apigw-orders"))).toContain(`arn:aws:execute-api:eu-west-1:${account}:${api.id}/*/POST/orders`);

      await page.getByRole("button", { name: "Create method" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Method type").selectOption("GET");
      await dialog.getByRole("radio", { name: /^Mock/ }).check();
      await expect(dialog.getByLabel("Lambda function", { exact: true })).toBeHidden();
      await dialog.getByRole("button", { name: "Create method" }).click();
      await expect(page.getByRole("button", { name: "GET · MOCK" })).toBeVisible();
      const mock = await gateway.send(new GetMethodCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET" }));
      expect(mock.methodIntegration?.integrationResponses?.["200"]).toBeTruthy();
      expect(mock.methodResponses?.["200"]?.responseModels).toEqual({ "application/json": "Empty" });

      await page.getByRole("button", { name: "Create method" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Method type").selectOption("PUT");
      await dialog.getByRole("radio", { name: /^HTTP/ }).check();
      await expect(dialog.getByText("STACKSIM_ALLOW_OUTBOUND_HTTP=true", { exact: false })).toBeVisible();
      await dialog.getByLabel("HTTP method", { exact: true }).filter({ visible: true }).selectOption("PUT");
      await dialog.getByLabel("Endpoint URL").fill("https://backend.example/orders");
      await dialog.getByLabel("Default timeout").uncheck();
      await dialog.getByLabel("Integration timeout (ms)").fill("5000");
      await dialog.getByRole("button", { name: "Create method" }).click();
      await expect(page.getByRole("button", { name: "PUT · HTTP" })).toBeVisible();
      expect(await gateway.send(new GetIntegrationCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "PUT" }))).toEqual(expect.objectContaining({ type: "HTTP", httpMethod: "PUT", uri: "https://backend.example/orders", timeoutInMillis: 5000 }));

      await page.getByRole("button", { name: "Create method" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Method type").selectOption("PATCH");
      await dialog.getByRole("radio", { name: /^AWS service/ }).check();
      await dialog.getByLabel("AWS service", { exact: true }).selectOption("sns");
      await expect(dialog.getByLabel("Action name", { exact: true })).toHaveValue("Publish");
      await dialog.getByRole("button", { name: "Create method" }).click();
      await expect(page.getByRole("button", { name: "PATCH · AWS" })).toBeVisible();
      expect(await gateway.send(new GetIntegrationCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "PATCH" }))).toEqual(expect.objectContaining({ type: "AWS", httpMethod: "POST", uri: "arn:aws:apigateway:eu-west-1:sns:action/Publish" }));

      await page.getByRole("button", { name: "PUT · HTTP" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByRole("tab", { name: "Integration request" }).click();
      await expect(dialog.getByLabel("Integration type")).toHaveValue("HTTP");
      await expect(dialog.getByLabel("Integration timeout (ms)")).toHaveValue("5000");
      await expect(dialog.getByText("STACKSIM_ALLOW_OUTBOUND_HTTP=true", { exact: false })).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });

  test("DPG-16 saving a method keeps every method and integration response with header mappings", async ({ page }) => {
    const gateway = new APIGatewayClient(sdkOptions(simulator));
    try {
      const api = await gateway.send(new CreateRestApiCommand({ name: "dpg-16-api" }));
      const root = (await gateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!;
      const items = await gateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: root.id!, pathPart: "items" }));
      const base = { restApiId: api.id!, resourceId: items.id!, httpMethod: "GET" };
      await gateway.send(new PutMethodCommand({ ...base, authorizationType: "NONE" }));
      await gateway.send(new PutMethodResponseCommand({ ...base, statusCode: "200", responseParameters: { "method.response.header.X-Trace": false, "method.response.header.Access-Control-Allow-Origin": true }, responseModels: { "application/json": "Empty" } }));
      await gateway.send(new PutMethodResponseCommand({ ...base, statusCode: "404", responseModels: { "application/json": "Error" } }));
      await gateway.send(new PutIntegrationCommand({ ...base, type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } }));
      await gateway.send(new PutIntegrationResponseCommand({ ...base, statusCode: "200", responseParameters: { "method.response.header.X-Trace": "'trace-1'", "method.response.header.Access-Control-Allow-Origin": "'*'" }, responseTemplates: { "application/json": "{\"ok\":true}" } }));
      await gateway.send(new PutIntegrationResponseCommand({ ...base, statusCode: "404", selectionPattern: "missing", responseTemplates: { "application/json": "{\"message\":\"missing\"}" } }));
      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/resources`);
      await page.getByRole("treeitem", { name: "/items, resource" }).click();
      await page.getByRole("button", { name: "GET · MOCK" }).click();
      let dialog = page.getByRole("dialog");
      await dialog.getByRole("tab", { name: "Method response" }).click();
      await expect(dialog.locator("[data-method-response-block]")).toHaveCount(2);
      await dialog.getByRole("button", { name: "Save method" }).click();
      await expect(dialog).not.toBeVisible();
      let method = await gateway.send(new GetMethodCommand(base));
      expect(method.methodResponses?.["200"]?.responseParameters).toEqual({ "method.response.header.X-Trace": false, "method.response.header.Access-Control-Allow-Origin": true });
      expect(method.methodResponses?.["404"]?.responseModels).toEqual({ "application/json": "Error" });
      expect(method.methodIntegration?.integrationResponses?.["200"]?.responseParameters).toEqual({ "method.response.header.X-Trace": "'trace-1'", "method.response.header.Access-Control-Allow-Origin": "'*'" });
      expect(method.methodIntegration?.integrationResponses?.["404"]?.selectionPattern).toBe("missing");

      await page.getByRole("button", { name: "GET · MOCK" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByRole("tab", { name: "Method response" }).click();
      await dialog.getByRole("button", { name: "Add method response" }).click();
      const added = dialog.locator("[data-method-response-block]").last();
      await added.getByLabel("HTTP status code").fill("500");
      await added.getByLabel("Response header declarations (JSON)").fill('{"method.response.header.X-Error":true}');
      await dialog.getByRole("tab", { name: "Integration response" }).click();
      const notFound = dialog.locator("[data-integration-response-block]").filter({ has: page.locator('input[value="404"]') });
      await notFound.getByLabel("Header mappings (JSON)").fill('{"method.response.header.X-Trace":"\'missing\'"}');
      await dialog.getByRole("button", { name: "Save method" }).click();
      await expect(dialog).not.toBeVisible();
      method = await gateway.send(new GetMethodCommand(base));
      expect(Object.keys(method.methodResponses ?? {}).sort()).toEqual(["200", "404", "500"]);
      expect(method.methodResponses?.["500"]?.responseParameters).toEqual({ "method.response.header.X-Error": true });
      expect(method.methodIntegration?.integrationResponses?.["404"]?.responseParameters).toEqual({ "method.response.header.X-Trace": "'missing'" });
      expect(method.methodIntegration?.integrationResponses?.["200"]?.responseTemplates).toEqual({ "application/json": "{\"ok\":true}" });
      expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });

  test("creates proxy and CORS resources, shows copyable invoke URLs, and adds authorizer permissions", async ({ page }) => {
    await createFunction(simulator, "apigw-authorizer", "handler.authorizerHandler");
    const gateway = new APIGatewayClient(sdkOptions(simulator));
    try {
      const api = await gateway.send(new CreateRestApiCommand({ name: "dpg-resource-api" }));
      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/resources`);
      await page.getByRole("button", { name: "Create resource" }).click();
      let dialog = page.getByRole("dialog");
      await dialog.getByLabel("Proxy resource").check();
      await expect(dialog.getByLabel("Resource path")).toHaveValue("{proxy+}");
      await dialog.getByLabel("CORS (Cross Origin Resource Sharing)").check();
      await dialog.getByRole("button", { name: "Create resource" }).click();
      await expect(page.getByRole("button", { name: "ANY · No integration" })).toBeVisible();
      await expect(page.getByRole("button", { name: "OPTIONS · MOCK" })).toBeVisible();
      const proxy = (await gateway.send(new GetResourcesCommand({ restApiId: api.id!, embed: ["methods"] }))).items!.find(resource => resource.path === "/{proxy+}")!;
      expect(Object.keys(proxy.resourceMethods ?? {}).sort()).toEqual(["ANY", "OPTIONS"]);
      const options = await gateway.send(new GetIntegrationCommand({ restApiId: api.id!, resourceId: proxy.id!, httpMethod: "OPTIONS" }));
      expect(options.integrationResponses?.["200"]?.responseParameters?.["method.response.header.Access-Control-Allow-Origin"]).toBe("'*'");

      await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
      await page.reload();
      await page.getByRole("treeitem", { name: "/{proxy+}, resource" }).click();
      await expect(page.getByRole("button", { name: "Copy ANY invoke URL" })).toBeVisible();
      await expect(page.locator(".method-invoke-url").first()).toContainText(`/${api.id}/dev/{proxy+}`);
      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/stages`);
      await expect(page.getByRole("button", { name: "Copy invoke URL" })).toBeVisible();
      await expect(page.locator("#stage-deployment")).toContainText(`${api.id}.execute-api.localhost`);

      await page.goto(`${consoleUrl}#/apigateway/apis/${api.id}/authorizers`);
      await page.getByRole("button", { name: "Create authorizer" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name", { exact: true }).fill("dpg-token");
      await fillArnCombobox(dialog.getByLabel("Lambda function", { exact: true }), `arn:aws:lambda:eu-west-1:${account}:function:apigw-authorizer`);
      await dialog.getByLabel("Cache TTL (seconds)").fill("0");
      await dialog.getByRole("button", { name: "Create authorizer" }).click();
      await expect(page.getByRole("button", { name: "View and test" })).toBeVisible();
      const authorizer = (await gateway.send(new GetAuthorizersCommand({ restApiId: api.id! }))).items!.find(item => item.name === "dpg-token")!;
      await expect.poll(async () => sourceArns(await policyStatements(simulator, "apigw-authorizer"))).toContain(`arn:aws:execute-api:eu-west-1:${account}:${api.id}/authorizers/${authorizer.id}`);
      await page.getByRole("button", { name: "View and test" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Headers (JSON)").fill('{"Authorization":"allow"}');
      await dialog.locator("#run-authorizer-test").click();
      await expect(dialog.locator("#authorizer-test-result")).toContainText("Principal ID");
      await expect(dialog.locator("#authorizer-test-result")).toContainText("allowed-user");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });

  test("HTTP API integrations use a Lambda picker or AWS service subtypes and stages show invoke URLs", async ({ page }) => {
    await createFunction(simulator, "apigw-http-target", "handler.echoHandler");
    await createRole(simulator, "apigw-browser-service-role", "apigateway.amazonaws.com");
    const gateway = new ApiGatewayV2Client(sdkOptions(simulator));
    try {
      const api = await gateway.send(new CreateApiCommand({ Name: "dpg-http-api", ProtocolType: "HTTP" }));
      await gateway.send(new CreateStageCommand({ ApiId: api.ApiId!, StageName: "$default", AutoDeploy: true }));
      await gateway.send(new CreateStageCommand({ ApiId: api.ApiId!, StageName: "dev", AutoDeploy: true }));
      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/apigateway/http-apis/${api.ApiId}/integrations`);
      await page.getByRole("button", { name: "Create integration" }).click();
      let dialog = page.getByRole("dialog");
      await fillArnCombobox(dialog.getByLabel("Lambda function", { exact: true }), `arn:aws:lambda:eu-west-1:${account}:function:apigw-http-target`);
      await dialog.getByLabel("Description").fill("Lambda target");
      await dialog.getByRole("button", { name: "Create" }).click();
      await expect(page.getByText("Lambda target", { exact: true })).toBeVisible();
      await expect.poll(async () => sourceArns(await policyStatements(simulator, "apigw-http-target"))).toContain(`arn:aws:execute-api:eu-west-1:${account}:${api.ApiId}/*/*`);

      await page.getByRole("button", { name: "Create", exact: true }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Integration type").selectOption("sqs");
      await expect(dialog.getByLabel("Integration action").filter({ visible: true })).toHaveValue("SQS-SendMessage");
      await dialog.getByLabel("QueueUrl", { exact: true }).filter({ visible: true }).fill(`http://sqs.eu-west-1.localhost/${account}/orders`);
      await dialog.getByLabel("MessageBody", { exact: true }).filter({ visible: true }).fill("$request.body");
      await fillArnCombobox(dialog.getByLabel("Invocation role"), `arn:aws:iam::${account}:role/apigw-browser-service-role`);
      await dialog.getByLabel("Description").fill("Queue target");
      await dialog.getByRole("button", { name: "Create" }).click();
      await expect(page.getByText("Queue target", { exact: true })).toBeVisible();
      const integrations = (await gateway.send(new GetIntegrationsCommand({ ApiId: api.ApiId! }))).Items ?? [];
      expect(integrations.find(item => item.Description === "Queue target")).toEqual(expect.objectContaining({ IntegrationType: "AWS_PROXY", IntegrationSubtype: "SQS-SendMessage", RequestParameters: { QueueUrl: `http://sqs.eu-west-1.localhost/${account}/orders`, MessageBody: "$request.body" } }));

      await page.getByRole("link", { name: "Stages", exact: true }).click();
      const defaultRow = page.locator("tbody tr").filter({ hasText: "$default" });
      await expect(defaultRow.locator("code")).toHaveText(`${api.ApiEndpoint}`);
      await expect(page.getByRole("button", { name: "Copy dev invoke URL" })).toBeVisible();
      await expect(page.locator("tbody tr").filter({ hasText: "dev" }).locator("code")).toHaveText(`${api.ApiEndpoint}/dev`);
      await expect(page.getByRole("button", { name: "Reimport" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Export" })).toBeVisible();
      expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });

  test("HTTP API imports, reimports, and exports OpenAPI 3 definitions", async ({ page }) => {
    const definition = { openapi: "3.0.1", info: { title: "dpg-imported-http", version: "1.0" }, paths: { "/ping": { get: { responses: { default: { description: "ok" } }, "x-amazon-apigateway-integration": { type: "http_proxy", httpMethod: "GET", uri: "https://backend.example/ping", payloadFormatVersion: "1.0" } } } } };
    const gateway = new ApiGatewayV2Client(sdkOptions(simulator));
    try {
      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/apigateway/apis`);
      await page.getByRole("button", { name: "Create HTTP API" }).first().click();
      let dialog = page.getByRole("dialog");
      await dialog.getByLabel("Creation method").selectOption("import");
      await dialog.getByLabel("OpenAPI definition").fill(JSON.stringify(definition, null, 2));
      await dialog.getByRole("button", { name: "Create HTTP API" }).click();
      await expect(page.getByRole("heading", { name: "dpg-imported-http" })).toBeVisible();
      const imported = ((await gateway.send(new GetApisCommand({}))).Items ?? []).find(item => item.Name === "dpg-imported-http")!;
      expect(((await gateway.send(new GetRoutesCommand({ ApiId: imported.ApiId! }))).Items ?? []).map(item => item.RouteKey)).toEqual(["GET /ping"]);

      await page.getByRole("button", { name: "Reimport" }).click();
      dialog = page.getByRole("dialog");
      const updated = { ...definition, paths: { ...definition.paths, "/health": definition.paths["/ping"] } };
      await dialog.getByLabel("OpenAPI definition").fill(JSON.stringify(updated, null, 2));
      await dialog.getByRole("button", { name: "Reimport" }).click();
      await expect(dialog).not.toBeVisible();
      expect(((await gateway.send(new GetRoutesCommand({ ApiId: imported.ApiId! }))).Items ?? []).map(item => item.RouteKey).sort()).toEqual(["GET /health", "GET /ping"]);

      await page.getByRole("button", { name: "Export" }).click();
      dialog = page.getByRole("dialog");
      const downloadStarted = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "Export", exact: true }).click();
      const download = await downloadStarted;
      expect(download.suggestedFilename()).toBe("dpg-imported-http.json");
      const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
      expect(Object.keys(exported.paths).sort()).toEqual(["/health", "/ping"]);
      expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });

  test("WebSocket stages list connection URLs and the post-to-connection command works with AWS CLI v2", async ({ page }) => {
    const gateway = new ApiGatewayV2Client(sdkOptions(simulator));
    try {
      const api = await gateway.send(new CreateApiCommand({ Name: "dpg-ws-api", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action" }));
      await gateway.send(new CreateStageCommand({ ApiId: api.ApiId!, StageName: "prod", AutoDeploy: true }));
      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/apigateway/websocket-apis/${api.ApiId}/stages`);
      const row = page.locator("tbody tr").filter({ hasText: "prod" });
      await expect(row).toContainText(`${api.ApiEndpoint}/prod`);
      await expect(row).toContainText(`/${api.ApiId}/prod/@connections`);
      await expect(page.getByRole("button", { name: "Copy prod @connections URL" })).toBeVisible();
      await page.getByRole("link", { name: "Monitor and test", exact: true }).click();
      await expect(page.getByText("--cli-binary-format raw-in-base64-out", { exact: false }).first()).toBeVisible();
      await expect(page.locator("pre").filter({ hasText: "post-to-connection" })).toContainText(`/${api.ApiId}/prod`);
      expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });

  test("Lambda Add trigger creates an HTTP API trigger and lists API Gateway permissions", async ({ page }) => {
    await createFunction(simulator, "apigw-trigger-fn", "handler.echoHandler");
    const gateway = new ApiGatewayV2Client(sdkOptions(simulator));
    try {
      const errors = browserErrors(page);
      await page.goto(`${consoleUrl}#/lambda/functions/apigw-trigger-fn`);
      await page.getByRole("button", { name: "Add trigger" }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("Trigger type")).toHaveValue("apigateway");
      await expect(dialog.getByLabel("API", { exact: true })).toHaveValue("new");
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.locator(".trigger-card").getByRole("link", { name: "apigw-trigger-fn-API" })).toBeVisible();
      await expect(page.locator(".trigger-card")).toContainText("API Gateway · HTTP API");
      const created = ((await gateway.send(new GetApisCommand({}))).Items ?? []).find(item => item.Name === "apigw-trigger-fn-API")!;
      expect(((await gateway.send(new GetRoutesCommand({ ApiId: created.ApiId! }))).Items ?? []).map(item => item.RouteKey)).toEqual(["ANY /apigw-trigger-fn"]);
      expect(((await gateway.send(new GetStagesCommand({ ApiId: created.ApiId! }))).Items ?? []).map(item => item.StageName)).toEqual(["default"]);
      expect(sourceArns(await policyStatements(simulator, "apigw-trigger-fn"))).toContain(`arn:aws:execute-api:eu-west-1:${account}:${created.ApiId}/*/*/apigw-trigger-fn`);
      expect(errors).toEqual([]);
    } finally { gateway.destroy(); }
  });
});
