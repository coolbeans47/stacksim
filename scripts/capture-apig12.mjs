import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { APIGatewayClient, CreateRestApiCommand } from "@aws-sdk/client-api-gateway";
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateAuthorizerCommand,
  CreateIntegrationCommand,
  CreateModelCommand,
  CreateRouteCommand,
  CreateRouteResponseCommand,
  CreateStageCommand,
} from "@aws-sdk/client-apigatewayv2";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-apig12-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let gateway; let gatewayV2;

try {
  await simulator.start();
  const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } };
  gateway = new APIGatewayClient(options); gatewayV2 = new ApiGatewayV2Client(options);
  await gateway.send(new CreateRestApiCommand({ name: "orders-rest-api", description: "REST API retained for request-response clients" }));
  const api = await gatewayV2.send(new CreateApiCommand({ Name: "realtime-orders", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action", Description: "Persistent order status and collaboration channel", Tags: { environment: "production", owner: "realtime-platform" } }));
  const lambda = await gatewayV2.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "AWS_PROXY", IntegrationMethod: "POST", IntegrationUri: "arn:aws:lambda:eu-west-1:000000000000:function:realtime-orders-handler", TimeoutInMillis: 12000, Description: "Realtime orders Lambda" }));
  const mock = await gatewayV2.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "MOCK", Description: "Connection acknowledgement", RequestTemplates: { "$default": '{"statusCode":200}' } }));
  const authorizer = await gatewayV2.send(new CreateAuthorizerCommand({ ApiId: api.ApiId, Name: "connection-token", AuthorizerType: "REQUEST", AuthorizerUri: "arn:aws:lambda:eu-west-1:000000000000:function:realtime-connect-authorizer", IdentitySource: ["route.request.header.Authorization"], AuthorizerResultTtlInSeconds: 300 }));
  await gatewayV2.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "$connect", Target: `integrations/${mock.IntegrationId}`, AuthorizationType: "CUSTOM", AuthorizerId: authorizer.AuthorizerId }));
  await gatewayV2.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "$disconnect", Target: `integrations/${lambda.IntegrationId}` }));
  const send = await gatewayV2.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "sendMessage", Target: `integrations/${lambda.IntegrationId}` }));
  await gatewayV2.send(new CreateRouteResponseCommand({ ApiId: api.ApiId, RouteId: send.RouteId, RouteResponseKey: "$default" }));
  await gatewayV2.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "subscribeOrder", Target: `integrations/${lambda.IntegrationId}` }));
  await gatewayV2.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "$default", Target: `integrations/${lambda.IntegrationId}` }));
  await gatewayV2.send(new CreateModelCommand({ ApiId: api.ApiId, Name: "ChatMessage", ContentType: "application/json", Description: "Client message envelope", Schema: JSON.stringify({ type: "object", required: ["action"], properties: { action: { type: "string" }, message: { type: "string" }, orderId: { type: "string" } } }) }));
  await gatewayV2.send(new CreateModelCommand({ ApiId: api.ApiId, Name: "OrderSubscription", ContentType: "application/json", Description: "Order status subscription", Schema: JSON.stringify({ type: "object", required: ["action", "orderId"], properties: { action: { const: "subscribeOrder" }, orderId: { type: "string" } } }) }));
  await gatewayV2.send(new CreateStageCommand({ ApiId: api.ApiId, StageName: "production", AutoDeploy: true, Description: "Production realtime stage", StageVariables: { release: "stable", audience: "customers" }, DefaultRouteSettings: { DetailedMetricsEnabled: true, ThrottlingRateLimit: 100, ThrottlingBurstLimit: 50 }, Tags: { environment: "production" } }));
  await gatewayV2.send(new CreateStageCommand({ ApiId: api.ApiId, StageName: "preview", AutoDeploy: true, Description: "Preview realtime stage", StageVariables: { release: "preview" }, DefaultRouteSettings: { DetailedMetricsEnabled: true, ThrottlingRateLimit: 20, ThrottlingBurstLimit: 10 } }));

  const pages = [
    { output: "api-list", hash: "#/apigateway/apis", heading: "APIs" },
    { output: "routes", hash: `#/apigateway/websocket-apis/${api.ApiId}/routes`, heading: /Routes/ },
    { output: "integrations", hash: `#/apigateway/websocket-apis/${api.ApiId}/integrations`, heading: /Integrations/ },
    { output: "authorization", hash: `#/apigateway/websocket-apis/${api.ApiId}/authorization`, heading: /authorizers/ },
    { output: "models", hash: `#/apigateway/websocket-apis/${api.ApiId}/models`, heading: /Models/ },
    { output: "stages", hash: `#/apigateway/websocket-apis/${api.ApiId}/stages`, heading: /Stages/ },
    { output: "monitor", hash: `#/apigateway/websocket-apis/${api.ApiId}/monitor`, heading: "Connect a test client" },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-16/apigateway/apig12", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) { const page = await browser.newPage({ viewport: { width, height } }); await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console${pageSpec.hash}`); await page.getByRole("heading", { name: pageSpec.heading }).first().waitFor(); await page.evaluate(async () => { const content = document.querySelector("main"); if (content) { content.scrollTop = content.scrollHeight; await new Promise(resolvePaint => requestAnimationFrame(resolvePaint)); content.scrollTop = 0; } await new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))); }); await page.waitForTimeout(100); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close(); }
  }
} finally {
  gateway?.destroy(); gatewayV2?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
}
