import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  CreateDocumentationPartCommand,
  CreateDocumentationVersionCommand,
  CreateRestApiCommand,
  CreateVpcLinkCommand,
  GenerateClientCertificateCommand,
  GetResourcesCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
} from "@aws-sdk/client-api-gateway";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-apig13-capture-"));
const targetArn = "arn:aws:elasticloadbalancing:eu-west-1:000000000000:loadbalancer/net/orders-private/0123456789abcdef";
const missingTargetArn = "arn:aws:elasticloadbalancing:eu-west-1:000000000000:loadbalancer/net/unmapped-private/fedcba9876543210";
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", apiGatewayVpcLinkOrigins: { [targetArn]: "http://127.0.0.1:8080/private-orders" }, apiGatewayAllowClientCertificates: true });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
let browser; let gateway;

try {
  await simulator.start();
  gateway = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  const link = await gateway.send(new CreateVpcLinkCommand({ name: "orders-private", description: "Explicit local mapping for the orders Network Load Balancer", targetArns: [targetArn], tags: { environment: "production", owner: "platform" } }));
  await gateway.send(new CreateVpcLinkCommand({ name: "payments-unmapped", description: "Dependency notice example", targetArns: [missingTargetArn], tags: { environment: "preview" } }));
  const certificate = await gateway.send(new GenerateClientCertificateCommand({ description: "Orders backend client certificate", tags: { environment: "production", owner: "platform" } }));
  const api = await gateway.send(new CreateRestApiCommand({ name: "documented-orders-api", description: "REST API with published consumer documentation", version: "2026-07" }));
  const rootResource = (await gateway.send(new GetResourcesCommand({ restApiId: api.id }))).items.find(resource => resource.path === "/");
  await gateway.send(new PutMethodCommand({ restApiId: api.id, resourceId: rootResource.id, httpMethod: "GET", authorizationType: "NONE" }));
  await gateway.send(new PutMethodResponseCommand({ restApiId: api.id, resourceId: rootResource.id, httpMethod: "GET", statusCode: "200" }));
  await gateway.send(new PutIntegrationCommand({ restApiId: api.id, resourceId: rootResource.id, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": '{"statusCode":200}' } }));
  await gateway.send(new PutIntegrationResponseCommand({ restApiId: api.id, resourceId: rootResource.id, httpMethod: "GET", statusCode: "200", responseTemplates: { "application/json": '{"service":"orders","status":"available"}' } }));
  await gateway.send(new CreateDocumentationPartCommand({ restApiId: api.id, location: { type: "API" }, properties: JSON.stringify({ description: "Order lookup and fulfilment API for trusted clients", contact: { name: "Orders platform" } }) }));
  await gateway.send(new CreateDocumentationPartCommand({ restApiId: api.id, location: { type: "RESOURCE", path: "/" }, properties: JSON.stringify({ description: "Orders service root resource" }) }));
  await gateway.send(new CreateDocumentationPartCommand({ restApiId: api.id, location: { type: "METHOD", path: "/", method: "GET" }, properties: JSON.stringify({ description: "Returns service metadata and availability" }) }));
  await gateway.send(new CreateDeploymentCommand({ restApiId: api.id, stageName: "production", description: "Published documentation deployment" }));
  await gateway.send(new CreateDocumentationVersionCommand({ restApiId: api.id, documentationVersion: "2026-07", description: "Production consumer reference", stageName: "production" }));

  const pages = [
    { output: "vpc-links", hash: "#/apigateway/vpc-links", heading: "VPC links" },
    { output: "vpc-link-detail", hash: `#/apigateway/vpc-links/${link.id}`, heading: "orders-private" },
    { output: "client-certificate", hash: `#/apigateway/client-certificates/${certificate.clientCertificateId}`, heading: "PEM-encoded public certificate" },
    { output: "documentation", hash: `#/apigateway/apis/${api.id}/documentation`, heading: "Documentation parts (3)" },
    { output: "account-settings", hash: "#/apigateway/account-settings", heading: "Account settings" },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-16/apigateway/apig13", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console${pageSpec.hash}`);
      await page.getByRole("heading", { name: pageSpec.heading, exact: true }).first().waitFor();
      await page.evaluate(async () => { const content = document.querySelector("main"); if (content) { content.scrollTop = content.scrollHeight; await new Promise(resolvePaint => requestAnimationFrame(resolvePaint)); content.scrollTop = 0; } await new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))); });
      await page.waitForTimeout(100);
      await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true });
      await page.close();
    }
  }
} finally {
  gateway?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
}
