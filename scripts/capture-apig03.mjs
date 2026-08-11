import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  APIGatewayClient,
  CreateResourceCommand,
  CreateRestApiCommand,
  GetResourcesCommand,
  PutGatewayResponseCommand,
  PutIntegrationCommand,
  PutMethodCommand,
} from "@aws-sdk/client-api-gateway";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-apig03-capture-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" }); const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]]; let browser; let gateway;
try {
  await simulator.start(); gateway = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } }); const api = await gateway.send(new CreateRestApiCommand({ name: "media-delivery-api", description: "CORS and binary delivery", binaryMediaTypes: ["application/octet-stream", "image/*"], minimumCompressionSize: 1024 })); const rootResource = (await gateway.send(new GetResourcesCommand({ restApiId: api.id }))).items.find(resource => resource.path === "/"); const media = await gateway.send(new CreateResourceCommand({ restApiId: api.id, parentId: rootResource.id, pathPart: "media" })); await gateway.send(new PutMethodCommand({ restApiId: api.id, resourceId: media.id, httpMethod: "POST", authorizationType: "NONE" })); await gateway.send(new PutIntegrationCommand({ restApiId: api.id, resourceId: media.id, httpMethod: "POST", type: "AWS_PROXY", integrationHttpMethod: "POST", uri: "arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-1:000000000000:function:media-delivery/invocations" })); await gateway.send(new PutGatewayResponseCommand({ restApiId: api.id, responseType: "MISSING_AUTHENTICATION_TOKEN", statusCode: "404", responseParameters: { "gatewayresponse.header.Access-Control-Allow-Origin": "'https://app.example'", "gatewayresponse.header.x-error-source": "'api-gateway'" }, responseTemplates: { "application/json": '{"type":"$context.error.responseType","message":$context.error.messageString}' } }));
  const pages = [
    { route: `/apigateway/apis/${api.id}/resources`, output: "cors", prepare: async page => { await page.getByRole("option", { name: /\/media/ }).click(); await page.getByRole("button", { name: "Enable CORS" }).click(); await page.getByRole("dialog").waitFor(); } },
    { route: `/apigateway/apis/${api.id}/settings`, output: "settings" },
    { route: `/apigateway/apis/${api.id}/gateway-responses`, output: "gateway-responses" },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const pageSpec of pages) { const output = resolve("docs/ui-reference/2026-07-15/apigateway/cors-binary-gateway-responses", pageSpec.output, "final"); await mkdir(output, { recursive: true }); for (const [name, width, height] of viewports) { const page = await browser.newPage({ viewport: { width, height } }); await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console#${pageSpec.route}`); await page.locator("main").waitFor(); await pageSpec.prepare?.(page); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close(); } }
} finally { gateway?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
