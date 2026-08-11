import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  APIGatewayClient,
  CreateBasePathMappingCommand,
  CreateDeploymentCommand,
  CreateDomainNameCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  GetResourcesCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
} from "@aws-sdk/client-api-gateway";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-apig10-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let gateway;

async function mockApi(name, description) {
  const api = await gateway.send(new CreateRestApiCommand({ name, description }));
  const rootResource = (await gateway.send(new GetResourcesCommand({ restApiId: api.id }))).items.find(resource => resource.path === "/");
  const status = await gateway.send(new CreateResourceCommand({ restApiId: api.id, parentId: rootResource.id, pathPart: "status" }));
  await gateway.send(new PutMethodCommand({ restApiId: api.id, resourceId: status.id, httpMethod: "GET", authorizationType: "NONE" }));
  await gateway.send(new PutMethodResponseCommand({ restApiId: api.id, resourceId: status.id, httpMethod: "GET", statusCode: "200" }));
  await gateway.send(new PutIntegrationCommand({ restApiId: api.id, resourceId: status.id, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } }));
  await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id, resourceId: status.id, httpMethod: "GET", statusCode: "200", responseTemplates: { "application/json": JSON.stringify({ service: name, status: "ok" }) } }));
  await gateway.send(new CreateDeploymentCommand({ restApiId: api.id, stageName: "prod", description: "Production custom-domain deployment" }));
  return api;
}

try {
  await simulator.start();
  gateway = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  const orders = await mockApi("orders-api", "Customer-facing order status API");
  const admin = await mockApi("orders-admin-api", "Administrative order operations");
  const certificate = "arn:aws:acm:eu-west-1:000000000000:certificate/11111111-1111-1111-1111-111111111111";
  const ownership = "arn:aws:acm:eu-west-1:000000000000:certificate/22222222-2222-2222-2222-222222222222";
  await gateway.send(new CreateDomainNameCommand({ domainName: "api.orders.test", endpointConfiguration: { types: ["REGIONAL"], ipAddressType: "dualstack" }, regionalCertificateArn: certificate, securityPolicy: "TLS_1_2", routingMode: "ROUTING_RULE_THEN_BASE_PATH_MAPPING", mutualTlsAuthentication: { truststoreUri: "s3://orders-trust/clients.pem", truststoreVersion: "v4" }, ownershipVerificationCertificateArn: ownership, tags: { environment: "production", owner: "platform" } }));
  await gateway.send(new CreateBasePathMappingCommand({ domainName: "api.orders.test", basePath: "(none)", restApiId: orders.id, stage: "prod" }));
  await gateway.send(new CreateBasePathMappingCommand({ domainName: "api.orders.test", basePath: "v1", restApiId: orders.id, stage: "prod" }));
  await gateway.send(new CreateBasePathMappingCommand({ domainName: "api.orders.test", basePath: "v1/admin", restApiId: admin.id, stage: "prod" }));
  await gateway.send(new CreateDomainNameCommand({ domainName: "internal.orders.test", endpointConfiguration: { types: ["PRIVATE"], ipAddressType: "dualstack", vpcEndpointIds: ["vpce-abc123"] }, certificateArn: certificate, securityPolicy: "TLS_1_2", policy: JSON.stringify({ Version: "2012-10-17", Statement: [] }), tags: { environment: "production", scope: "private" } }));

  const pages = [
    { output: "domain-list", hash: "#/apigateway/domains", prepare: page => page.getByRole("heading", { name: "Custom domain names", exact: true }).first().waitFor() },
    { output: "domain-detail", hash: "#/apigateway/domains/api.orders.test", prepare: page => page.getByRole("heading", { name: "api.orders.test", exact: true }).waitFor() },
    { output: "create-domain", hash: "#/apigateway/domains", prepare: async page => { await page.getByRole("heading", { name: "Custom domain names", exact: true }).first().waitFor(); await page.getByRole("button", { name: "Create domain name" }).first().click(); await page.getByRole("dialog").waitFor(); } },
    { output: "api-mapping", hash: "#/apigateway/domains/api.orders.test", prepare: async page => { await page.getByRole("heading", { name: "api.orders.test", exact: true }).waitFor(); await page.locator("tbody tr").filter({ hasText: "v1/admin" }).getByRole("button", { name: "Edit" }).click(); await page.getByRole("dialog").waitFor(); } },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-16/apigateway/apig10", pageSpec.output, "final");
    await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console${pageSpec.hash}`);
      await pageSpec.prepare(page);
      await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true });
      await page.close();
    }
  }
} finally {
  gateway?.destroy();
  await browser?.close();
  await simulator.stop().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
