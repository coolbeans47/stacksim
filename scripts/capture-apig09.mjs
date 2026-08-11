import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  GetResourcesCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
  UpdateStageCommand,
} from "@aws-sdk/client-api-gateway";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-apig09-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let gateway;
try {
  await simulator.start(); const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } }; gateway = new APIGatewayClient(options);
  const api = await gateway.send(new CreateRestApiCommand({ name: "orders-response-cache", description: "Production cache with explicit variant keys" })); const rootResource = (await gateway.send(new GetResourcesCommand({ restApiId: api.id }))).items.find(resource => resource.path === "/"); const orders = await gateway.send(new CreateResourceCommand({ restApiId: api.id, parentId: rootResource.id, pathPart: "orders" }));
  await gateway.send(new PutMethodCommand({ restApiId: api.id, resourceId: orders.id, httpMethod: "GET", authorizationType: "NONE", requestParameters: { "method.request.querystring.variant": false } })); await gateway.send(new PutMethodResponseCommand({ restApiId: api.id, resourceId: orders.id, httpMethod: "GET", statusCode: "200" })); await gateway.send(new PutIntegrationCommand({ restApiId: api.id, resourceId: orders.id, httpMethod: "GET", type: "MOCK", cacheNamespace: "orders-shared", cacheKeyParameters: ["method.request.querystring.variant"], requestTemplates: { "application/json": "{\"statusCode\":200}" } })); await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id, resourceId: orders.id, httpMethod: "GET", statusCode: "200", responseTemplates: { "application/json": "{\"orders\":[],\"source\":\"response-cache\"}" } })); await gateway.send(new CreateDeploymentCommand({ restApiId: api.id, stageName: "prod", description: "Cached production deployment" }));
  await gateway.send(new UpdateStageCommand({ restApiId: api.id, stageName: "prod", patchOperations: [
    { op: "replace", path: "/cacheClusterEnabled", value: "true" }, { op: "replace", path: "/cacheClusterSize", value: "1.6" }, { op: "replace", path: "/*/*/caching/enabled", value: "true" }, { op: "replace", path: "/*/*/caching/ttlInSeconds", value: "90" }, { op: "replace", path: "/*/*/caching/dataEncrypted", value: "true" }, { op: "replace", path: "/*/*/caching/requireAuthorizationForCacheControl", value: "true" }, { op: "replace", path: "/*/*/caching/unauthorizedCacheControlHeaderStrategy", value: "FAIL_WITH_403" }, { op: "replace", path: "/~1orders/GET/caching/enabled", value: "true" }, { op: "replace", path: "/~1orders/GET/caching/ttlInSeconds", value: "45" }, { op: "replace", path: "/~1orders/GET/caching/dataEncrypted", value: "true" }, { op: "replace", path: "/~1orders/GET/caching/requireAuthorizationForCacheControl", value: "true" }, { op: "replace", path: "/~1orders/GET/caching/unauthorizedCacheControlHeaderStrategy", value: "SUCCEED_WITHOUT_RESPONSE_HEADER" },
  ] }));
  const pages = [
    { output: "cache-overview", hash: `#/apigateway/apis/${api.id}/stages`, prepare: async page => { await page.locator("#stage-cache").waitFor(); await page.locator("#stage-cache").scrollIntoViewIfNeeded(); } },
    { output: "cache-settings", hash: `#/apigateway/apis/${api.id}/stages`, prepare: async page => { await page.locator("#stage-cache").waitFor(); await page.locator("#stage-cache").getByRole("button", { name: "Edit cache settings" }).click(); await page.getByRole("dialog").waitFor(); } },
    { output: "method-override", hash: `#/apigateway/apis/${api.id}/stages`, prepare: async page => { await page.locator("#stage-cache").waitFor(); await page.locator("#stage-cache").getByRole("button", { name: "Edit override" }).click(); await page.getByRole("dialog").waitFor(); } },
    { output: "integration-cache-keys", hash: `#/apigateway/apis/${api.id}/resources`, prepare: async page => { await page.getByRole("option", { name: /\/orders/ }).click(); await page.getByRole("button", { name: "GET · MOCK" }).click(); await page.getByRole("dialog").waitFor(); await page.getByLabel("Cache namespace").scrollIntoViewIfNeeded(); } },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const pageSpec of pages) { const output = resolve("docs/ui-reference/2026-07-16/apigateway/apig09", pageSpec.output, "final"); await mkdir(output, { recursive: true }); for (const [name, width, height] of viewports) { const page = await browser.newPage({ viewport: { width, height } }); await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console${pageSpec.hash}`); await pageSpec.prepare(page); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close(); } }
} finally { gateway?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
