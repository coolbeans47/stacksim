import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  APIGatewayClient,
  CreateModelCommand,
  CreateRequestValidatorCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  GetResourcesCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
} from "@aws-sdk/client-api-gateway";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-apig05-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let gateway;
try {
  await simulator.start();
  gateway = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  const api = await gateway.send(new CreateRestApiCommand({ name: "orders-validation-api", description: "Draft 4 request validation" }));
  await gateway.send(new CreateModelCommand({ restApiId: api.id, name: "Address", contentType: "application/json", description: "Delivery address", schema: JSON.stringify({ type: "object", required: ["street", "postalCode"], additionalProperties: false, properties: { street: { type: "string", minLength: 3 }, postalCode: { type: "string", pattern: "^[A-Z]{2}[0-9]{2}$" } } }) }));
  await gateway.send(new CreateModelCommand({ restApiId: api.id, name: "Order", contentType: "application/json", description: "Validated order request", schema: JSON.stringify({ type: "object", required: ["customer", "address", "items"], additionalProperties: false, properties: { customer: { type: "string", minLength: 3 }, address: { $ref: `https://apigateway.amazonaws.com/restapis/${api.id}/models/Address` }, items: { type: "array", minItems: 1, items: { type: "object", required: ["sku", "quantity"], properties: { sku: { type: "string" }, quantity: { type: "integer", minimum: 1, maximum: 20 } } } } } }) }));
  const validator = await gateway.send(new CreateRequestValidatorCommand({ restApiId: api.id, name: "Validate body and parameters", validateRequestBody: true, validateRequestParameters: true }));
  await gateway.send(new CreateRequestValidatorCommand({ restApiId: api.id, name: "Body only", validateRequestBody: true, validateRequestParameters: false }));
  const rootResource = (await gateway.send(new GetResourcesCommand({ restApiId: api.id }))).items.find(resource => resource.path === "/"); const orders = await gateway.send(new CreateResourceCommand({ restApiId: api.id, parentId: rootResource.id, pathPart: "orders" }));
  await gateway.send(new PutMethodCommand({ restApiId: api.id, resourceId: orders.id, httpMethod: "POST", authorizationType: "NONE", requestValidatorId: validator.id, requestParameters: { "method.request.querystring.tenant": true }, requestModels: { "application/json": "Order" } }));
  await gateway.send(new PutMethodResponseCommand({ restApiId: api.id, resourceId: orders.id, httpMethod: "POST", statusCode: "200", responseModels: { "application/json": "Empty" } }));
  await gateway.send(new PutIntegrationCommand({ restApiId: api.id, resourceId: orders.id, httpMethod: "POST", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } }));
  await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id, resourceId: orders.id, httpMethod: "POST", statusCode: "200", responseTemplates: { "application/json": "{\"accepted\":true}" } }));

  const pages = [
    { route: `/apigateway/apis/${api.id}/models`, output: "models" },
    { route: `/apigateway/apis/${api.id}/models`, output: "model-editor", prepare: async page => { await page.getByRole("button", { name: "Order" }).click(); await page.getByRole("dialog").waitFor(); } },
    { route: `/apigateway/apis/${api.id}/request-validators`, output: "request-validators" },
    { route: `/apigateway/apis/${api.id}/resources`, output: "method-validation", prepare: async page => { await page.getByRole("option", { name: /\/orders/ }).click(); await page.getByRole("button", { name: "POST · MOCK" }).click(); await page.getByRole("dialog").waitFor(); } },
    { route: `/apigateway/apis/${api.id}/resources`, output: "test-validation-error", prepare: async page => { await page.getByRole("option", { name: /\/orders/ }).click(); await page.getByRole("button", { name: "POST · MOCK" }).click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Path with query string").fill("/orders?tenant=learning"); await dialog.getByLabel("Request body").fill('{"customer":"x","items":[]}'); await dialog.locator("#run-method-test").click(); await dialog.locator("#method-test-result").filter({ hasText: "Validation failed" }).waitFor(); await dialog.locator("#method-test-result").scrollIntoViewIfNeeded(); } },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-16/apigateway/apig05", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) { const page = await browser.newPage({ viewport: { width, height } }); await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console#${pageSpec.route}`); await page.locator("main").waitFor(); await pageSpec.prepare?.(page); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close(); }
  }
} finally { gateway?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
