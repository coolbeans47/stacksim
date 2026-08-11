import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  APIGatewayClient,
  CreateApiKeyCommand,
  CreateDeploymentCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  CreateUsagePlanCommand,
  CreateUsagePlanKeyCommand,
  GetResourcesCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
} from "@aws-sdk/client-api-gateway";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-apig08-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let gateway;
try {
  await simulator.start(); const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } }; gateway = new APIGatewayClient(options);
  const api = await gateway.send(new CreateRestApiCommand({ name: "orders-api", description: "Production order lookup API" })); const rootResource = (await gateway.send(new GetResourcesCommand({ restApiId: api.id }))).items.find(resource => resource.path === "/"); const orders = await gateway.send(new CreateResourceCommand({ restApiId: api.id, parentId: rootResource.id, pathPart: "orders" })); await gateway.send(new PutMethodCommand({ restApiId: api.id, resourceId: orders.id, httpMethod: "GET", authorizationType: "NONE", apiKeyRequired: true })); await gateway.send(new PutMethodResponseCommand({ restApiId: api.id, resourceId: orders.id, httpMethod: "GET", statusCode: "200" })); await gateway.send(new PutIntegrationCommand({ restApiId: api.id, resourceId: orders.id, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } })); await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id, resourceId: orders.id, httpMethod: "GET", statusCode: "200", responseTemplates: { "application/json": "{\"orders\":[]}" } })); await gateway.send(new CreateDeploymentCommand({ restApiId: api.id, stageName: "prod" }));
  const key = await gateway.send(new CreateApiKeyCommand({ name: "checkout-web", description: "Production checkout client", enabled: true, tags: { environment: "production", owner: "checkout" } })); const partner = await gateway.send(new CreateApiKeyCommand({ name: "partner-mobile", description: "Partner mobile application", enabled: true, tags: { environment: "production" } })); const plan = await gateway.send(new CreateUsagePlanCommand({ name: "Production clients", description: "Standard production limits for checkout consumers", apiStages: [{ apiId: api.id, stage: "prod", throttle: { "/orders/GET": { rateLimit: 40, burstLimit: 20 } } }], throttle: { rateLimit: 100, burstLimit: 50 }, quota: { limit: 10000, period: "MONTH", offset: 0 }, tags: { tier: "standard", owner: "platform" } })); await gateway.send(new CreateUsagePlanKeyCommand({ usagePlanId: plan.id, keyId: key.id, keyType: "API_KEY" })); await gateway.send(new CreateUsagePlanKeyCommand({ usagePlanId: plan.id, keyId: partner.id, keyType: "API_KEY" })); for (let index = 0; index < 3; index++) await fetch(`http://127.0.0.1:${simulator.invokePort}/${api.id}/prod/orders`, { headers: { "x-api-key": key.value } });
  const pages = [
    { output: "api-key-detail", hash: `#/apigateway/api-keys/${key.id}`, ready: page => page.getByRole("heading", { name: "checkout-web" }).waitFor() },
    { output: "usage-plan-overview", hash: `#/apigateway/usage-plans/${plan.id}/overview`, ready: page => page.getByRole("heading", { name: "Associated API stages" }).waitFor() },
    { output: "usage-plan-keys", hash: `#/apigateway/usage-plans/${plan.id}/keys`, ready: page => page.getByRole("heading", { name: /Associated API keys/ }).waitFor() },
    { output: "usage-plan-usage", hash: `#/apigateway/usage-plans/${plan.id}/usage`, ready: page => page.getByRole("heading", { name: "Daily usage" }).waitFor() },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const pageSpec of pages) { const output = resolve("docs/ui-reference/2026-07-16/apigateway/apig08", pageSpec.output, "final"); await mkdir(output, { recursive: true }); for (const [name, width, height] of viewports) { const page = await browser.newPage({ viewport: { width, height } }); await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console${pageSpec.hash}`); await pageSpec.ready(page); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close(); } }
} finally { gateway?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
