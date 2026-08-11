import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { APIGatewayClient, CreateDeploymentCommand, ImportRestApiCommand } from "@aws-sdk/client-api-gateway";
import { StackSim } from "../dist/src/server.js";

const root = await mkdtemp(join(tmpdir(), "stacksim-apig06-capture-"));
const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1" });
const viewports = [["desktop-1440x900.jpg", 1440, 900], ["desktop-1280x800.jpg", 1280, 800], ["mobile-390x844.jpg", 390, 844]];
const definition = { swagger: "2.0", info: { title: "pet-store-import", description: "OpenAPI import and export workflow", version: "1.0" }, produces: ["application/json"], paths: { "/pets": { get: { operationId: "listPets", responses: { "200": { description: "Pet list", schema: { type: "array", items: { $ref: "#/definitions/Pet" } } } }, "x-amazon-apigateway-integration": { type: "mock", requestTemplates: { "application/json": "{\"statusCode\":200}" }, responses: { default: { statusCode: "200", responseTemplates: { "application/json": "{\"pets\":[]}" } } } } } } }, definitions: { Pet: { type: "object", required: ["id", "name"], properties: { id: { type: "integer" }, name: { type: "string" } } } } };
const warningDefinition = { openapi: "3.0.1", info: { title: "Compatibility review", version: "2.0" }, paths: { "/preview": { get: { responses: { "200": { description: "Preview" } }, "x-amazon-apigateway-integration": { type: "unsupported-private-extension" } } } } };
let browser; let gateway;
try {
  await simulator.start();
  gateway = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  const api = await gateway.send(new ImportRestApiCommand({ body: Buffer.from(JSON.stringify(definition)), parameters: { endpointConfigurationTypes: "REGIONAL" } }));
  await gateway.send(new CreateDeploymentCommand({ restApiId: api.id, stageName: "dev", description: "OpenAPI 1.0 snapshot" }));
  const pages = [
    { route: "/apigateway/apis", output: "create-import", prepare: async page => { await page.getByRole("button", { name: "Create API" }).first().click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("Creation method").selectOption("import"); await dialog.getByLabel("Definition file").setInputFiles({ name: "pet-store.yaml", mimeType: "application/yaml", buffer: Buffer.from("openapi: 3.0.1\ninfo:\n  title: pet-store\n  version: '1.0'\npaths: {}\n") }); await dialog.getByLabel("Endpoint type").selectOption("REGIONAL"); } },
    { route: `/apigateway/apis/${api.id}/resources`, output: "warnings-review", prepare: async page => { await page.getByRole("button", { name: "Import API" }).click(); const dialog = page.getByRole("dialog"); await dialog.getByLabel("OpenAPI definition").fill(JSON.stringify(warningDefinition, null, 2)); await dialog.getByRole("button", { name: "Import API" }).click(); await page.getByRole("alert").filter({ hasText: "Import completed with warnings" }).waitFor(); } },
    { route: `/apigateway/apis/${api.id}/stages`, output: "export-dialog", prepare: async page => { await page.getByRole("button", { name: "Export API" }).click(); await page.getByRole("dialog").waitFor(); await page.getByRole("dialog").getByLabel("Postman extensions").check(); } },
  ];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const pageSpec of pages) {
    const output = resolve("docs/ui-reference/2026-07-16/apigateway/apig06", pageSpec.output, "final"); await mkdir(output, { recursive: true });
    for (const [name, width, height] of viewports) { const page = await browser.newPage({ viewport: { width, height } }); await page.goto(`http://127.0.0.1:${simulator.port}/_stacksim/console#${pageSpec.route}`); await page.locator("main").waitFor(); await pageSpec.prepare(page); await page.screenshot({ path: join(output, name), type: "jpeg", quality: 88, fullPage: true }); await page.close(); }
  }
} finally { gateway?.destroy(); await browser?.close(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
