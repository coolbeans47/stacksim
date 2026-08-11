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
  CreateRouteCommand,
  CreateStageCommand,
} from "@aws-sdk/client-apigatewayv2";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-apig11-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let gateway; let gatewayV2;

try {
  await simulator.start();
  const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } };
  gateway = new APIGatewayClient(options);
  gatewayV2 = new ApiGatewayV2Client(options);
  await gateway.send(new CreateRestApiCommand({ name: "orders-rest-api", description: "REST API retained for legacy clients" }));

  const api = await gatewayV2.send(new CreateApiCommand({
    Name: "orders-http-api",
    ProtocolType: "HTTP",
    Description: "Low-latency order service with JWT authorization",
    CorsConfiguration: { AllowOrigins: ["https://app.orders.test"], AllowHeaders: ["authorization", "content-type"], AllowMethods: ["GET", "POST", "OPTIONS"], ExposeHeaders: ["x-request-id"], MaxAge: 3600, AllowCredentials: true },
    Tags: { environment: "production", owner: "platform" },
  }));
  const ordersIntegration = await gatewayV2.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "AWS_PROXY", IntegrationUri: "arn:aws:lambda:eu-west-1:000000000000:function:orders-http-handler", IntegrationMethod: "POST", PayloadFormatVersion: "2.0", TimeoutInMillis: 12000, Description: "Orders Lambda v2", RequestParameters: { "append:header.x-service": "'orders'" } }));
  const statusIntegration = await gatewayV2.send(new CreateIntegrationCommand({ ApiId: api.ApiId, IntegrationType: "HTTP_PROXY", IntegrationUri: "https://status.orders.test/health", IntegrationMethod: "GET", PayloadFormatVersion: "1.0", TimeoutInMillis: 5000, Description: "Public status endpoint" }));
  const jwt = await gatewayV2.send(new CreateAuthorizerCommand({ ApiId: api.ApiId, Name: "orders-jwt", AuthorizerType: "JWT", IdentitySource: ["$request.header.Authorization"], JwtConfiguration: { Issuer: "https://identity.orders.test", Audience: ["orders-web", "orders-mobile"] } }));
  await gatewayV2.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "GET /orders/{orderId}", Target: `integrations/${ordersIntegration.IntegrationId}`, AuthorizationType: "JWT", AuthorizerId: jwt.AuthorizerId, AuthorizationScopes: ["orders:read"] }));
  await gatewayV2.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "POST /orders", Target: `integrations/${ordersIntegration.IntegrationId}`, AuthorizationType: "JWT", AuthorizerId: jwt.AuthorizerId, AuthorizationScopes: ["orders:write"] }));
  await gatewayV2.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "GET /health", Target: `integrations/${statusIntegration.IntegrationId}`, AuthorizationType: "NONE" }));
  await gatewayV2.send(new CreateRouteCommand({ ApiId: api.ApiId, RouteKey: "$default", Target: `integrations/${ordersIntegration.IntegrationId}`, AuthorizationType: "NONE" }));
  await gatewayV2.send(new CreateStageCommand({ ApiId: api.ApiId, StageName: "$default", AutoDeploy: true, Description: "Production default stage", StageVariables: { release: "stable", tenant: "orders" }, DefaultRouteSettings: { DetailedMetricsEnabled: true, ThrottlingRateLimit: 100, ThrottlingBurstLimit: 50 }, Tags: { environment: "production" } }));
  await gatewayV2.send(new CreateStageCommand({ ApiId: api.ApiId, StageName: "preview", AutoDeploy: true, Description: "Preview stage", StageVariables: { release: "preview" }, DefaultRouteSettings: { DetailedMetricsEnabled: true, ThrottlingRateLimit: 20, ThrottlingBurstLimit: 10 } }));

  const pages = [
    { output: "api-list", hash: "#/apigateway/apis", heading: "APIs" },
    { output: "routes", hash: `#/apigateway/http-apis/${api.ApiId}/routes`, heading: /Routes/ },
    { output: "authorization", hash: `#/apigateway/http-apis/${api.ApiId}/authorization`, heading: /Authorization/ },
    { output: "stages", hash: `#/apigateway/http-apis/${api.ApiId}/stages`, heading: /Stages/ },
    { output: "monitor", hash: `#/apigateway/http-apis/${api.ApiId}/monitor`, heading: "HTTP API metrics" },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-16/apigateway/apig11", pageSpec.output, "final");
    await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console${pageSpec.hash}`);
      await page.getByRole("heading", { name: pageSpec.heading }).first().waitFor();
      await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true });
      await page.close();
    }
  }
} finally {
  gateway?.destroy();
  gatewayV2?.destroy();
  await browser?.close();
  await simulator.stop().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
