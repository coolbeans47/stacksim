import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  CreateDocumentationPartCommand,
  CreateDocumentationVersionCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  CreateStageCommand,
  CreateVpcLinkCommand,
  DeleteClientCertificateCommand,
  DeleteDocumentationPartCommand,
  DeleteDocumentationVersionCommand,
  DeleteVpcLinkCommand,
  GenerateClientCertificateCommand,
  GetClientCertificateCommand,
  GetClientCertificatesCommand,
  GetDocumentationPartCommand,
  GetDocumentationPartsCommand,
  GetDocumentationVersionCommand,
  GetDocumentationVersionsCommand,
  GetExportCommand,
  GetIntegrationCommand,
  GetResourcesCommand,
  GetSdkCommand,
  GetSdkTypeCommand,
  GetSdkTypesCommand,
  GetStageCommand,
  GetTagsCommand,
  GetVpcLinkCommand,
  GetVpcLinksCommand,
  ImportRestApiCommand,
  ImportDocumentationPartsCommand,
  PutIntegrationCommand,
  PutMethodCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateClientCertificateCommand,
  UpdateDocumentationPartCommand,
  UpdateDocumentationVersionCommand,
  UpdateResourceCommand,
  UpdateStageCommand,
  UpdateVpcLinkCommand,
} from "@aws-sdk/client-api-gateway";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const region = "eu-west-1";
const targetArn = "arn:aws:elasticloadbalancing:eu-west-1:000000000000:loadbalancer/net/private-orders/0123456789abcdef";
let root: string;
let simulator: StackSim;
let client: APIGatewayClient;
let backend: Server;
let backendOrigin: string;
let previousOutbound: string | undefined;
let previousPrivate: string | undefined;
let persistedVpcLinkId: string;
let persistedDocumentationApiId: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "stacksim-apig13-"));
  backend = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ method: req.method, path: req.url, host: req.headers.host })); });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  backendOrigin = `http://127.0.0.1:${(backend.address() as any).port}/private-prefix`;
  previousOutbound = process.env.STACKSIM_ALLOW_OUTBOUND_HTTP; previousPrivate = process.env.STACKSIM_ALLOW_PRIVATE_HTTP;
  process.env.STACKSIM_ALLOW_OUTBOUND_HTTP = "true"; process.env.STACKSIM_ALLOW_PRIVATE_HTTP = "true";
  simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, apiGatewayVpcLinkOrigins: { [targetArn]: backendOrigin }, apiGatewayAllowClientCertificates: true, authMode: "off"});
  await simulator.start();
  client = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
});

after(async () => {
  client?.destroy(); await simulator?.stop(); await new Promise<void>(resolve => backend?.close(() => resolve())); await rm(root, { recursive: true, force: true });
  if (previousOutbound === undefined) delete process.env.STACKSIM_ALLOW_OUTBOUND_HTTP; else process.env.STACKSIM_ALLOW_OUTBOUND_HTTP = previousOutbound;
  if (previousPrivate === undefined) delete process.env.STACKSIM_ALLOW_PRIVATE_HTTP; else process.env.STACKSIM_ALLOW_PRIVATE_HTTP = previousPrivate;
});

test("APIG-13 VPC links drive explicit safe local private integrations and resource updates", async () => {
  const link = await client.send(new CreateVpcLinkCommand({ name: "orders-private", description: "Explicit local NLB mapping", targetArns: [targetArn], tags: { environment: "test" } }));
  persistedVpcLinkId = link.id!;
  assert.equal(link.status, "AVAILABLE"); assert.equal((await client.send(new GetVpcLinkCommand({ vpcLinkId: link.id! }))).targetArns?.[0], targetArn);
  assert.equal((await client.send(new GetVpcLinksCommand({ limit: 1 }))).items?.[0].id, link.id);
  const updated = await client.send(new UpdateVpcLinkCommand({ vpcLinkId: link.id!, patchOperations: [{ op: "replace", path: "/description", value: "Updated mapping" }] })); assert.equal(updated.description, "Updated mapping");
  const linkArn = `arn:aws:apigateway:${region}::/vpclinks/${link.id}`; await client.send(new TagResourceCommand({ resourceArn: linkArn, tags: { owner: "platform" } })); assert.equal((await client.send(new GetTagsCommand({ resourceArn: linkArn }))).tags?.owner, "platform"); await client.send(new UntagResourceCommand({ resourceArn: linkArn, tagKeys: ["owner"] }));

  const api = await client.send(new CreateRestApiCommand({ name: "private-orders" })); const rootResource = (await client.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(value => value.path === "/")!;
  const orders = await client.send(new CreateResourceCommand({ restApiId: api.id!, parentId: rootResource.id!, pathPart: "orders" })); const renamed = await client.send(new UpdateResourceCommand({ restApiId: api.id!, resourceId: orders.id!, patchOperations: [{ op: "replace", path: "/pathPart", value: "private-orders" }] })); assert.equal(renamed.path, "/private-orders");
  await client.send(new PutMethodCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET", authorizationType: "NONE" }));
  await client.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET", type: "HTTP_PROXY", integrationHttpMethod: "GET", uri: "http://private-orders.example/items", connectionType: "VPC_LINK", connectionId: link.id }));
  const integration = await client.send(new GetIntegrationCommand({ restApiId: api.id!, resourceId: orders.id!, httpMethod: "GET" })); assert.equal(integration.connectionType, "VPC_LINK"); assert.equal(integration.connectionId, link.id);
  const deployment = await client.send(new CreateDeploymentCommand({ restApiId: api.id! })); await client.send(new CreateStageCommand({ restApiId: api.id!, stageName: "dev", deploymentId: deployment.id! }));
  const response = await fetch(`http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/private-orders`); assert.equal(response.status, 200); assert.equal((await response.json()).path, "/private-prefix/items");
  const exported = await client.send(new GetExportCommand({ restApiId: api.id!, stageName: "dev", exportType: "oas30", accepts: "application/json", parameters: { extensions: "integrations" } })); const document = JSON.parse(Buffer.from(exported.body!).toString("utf8")); const extension = document.paths["/private-orders"].get["x-amazon-apigateway-integration"]; assert.equal(extension.connectionType, "VPC_LINK"); assert.equal(extension.connectionId, link.id);
  const roundTripped = await client.send(new ImportRestApiCommand({ body: Buffer.from(JSON.stringify(document)) })); const roundTrippedResource = (await client.send(new GetResourcesCommand({ restApiId: roundTripped.id! }))).items!.find(value => value.path === "/private-orders")!; const roundTrippedIntegration = await client.send(new GetIntegrationCommand({ restApiId: roundTripped.id!, resourceId: roundTrippedResource.id!, httpMethod: "GET" })); assert.equal(roundTrippedIntegration.connectionType, "VPC_LINK"); assert.equal(roundTrippedIntegration.connectionId, link.id);
  await assert.rejects(client.send(new DeleteVpcLinkCommand({ vpcLinkId: link.id! })), (error: any) => error.name === "ConflictException");
});

test("APIG-13 documentation CRUD, snapshots, imports, and stage export preserve documentation", async () => {
  const api = (await client.send(new CreateRestApiCommand({ name: "documented-api" }))); const rootResource = (await client.send(new GetResourcesCommand({ restApiId: api.id! }))).items![0];
  persistedDocumentationApiId = api.id!;
  await client.send(new PutMethodCommand({ restApiId: api.id!, resourceId: rootResource.id!, httpMethod: "GET", authorizationType: "NONE" })); await client.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: rootResource.id!, httpMethod: "GET", type: "MOCK", integrationHttpMethod: "POST" }));
  const apiPart = await client.send(new CreateDocumentationPartCommand({ restApiId: api.id!, location: { type: "API" }, properties: JSON.stringify({ description: "Published API documentation" }) }));
  const methodPart = await client.send(new CreateDocumentationPartCommand({ restApiId: api.id!, location: { type: "METHOD", path: "/", method: "GET" }, properties: JSON.stringify({ description: "Returns the root document" }) }));
  assert.equal((await client.send(new GetDocumentationPartCommand({ restApiId: api.id!, documentationPartId: apiPart.id! }))).location?.type, "API");
  assert.equal((await client.send(new GetDocumentationPartsCommand({ restApiId: api.id!, type: "METHOD", limit: 1 }))).items?.[0].id, methodPart.id);
  assert.match((await client.send(new UpdateDocumentationPartCommand({ restApiId: api.id!, documentationPartId: methodPart.id!, patchOperations: [{ op: "replace", path: "/properties", value: JSON.stringify({ description: "Updated root documentation" }) }] }))).properties!, /Updated/);
  const imported = await client.send(new ImportDocumentationPartsCommand({ restApiId: api.id!, mode: "merge", body: Buffer.from(JSON.stringify({ documentationParts: [{ location: { type: "RESOURCE", path: "/" }, properties: { description: "Root resource" } }] })) })); assert.equal(imported.ids?.length, 1);
  const deployment = await client.send(new CreateDeploymentCommand({ restApiId: api.id! })); await client.send(new CreateStageCommand({ restApiId: api.id!, stageName: "prod", deploymentId: deployment.id! }));
  const version = await client.send(new CreateDocumentationVersionCommand({ restApiId: api.id!, documentationVersion: "2026-07", description: "First publication", stageName: "prod" })); assert.equal(version.version, "2026-07");
  assert.equal((await client.send(new GetDocumentationVersionCommand({ restApiId: api.id!, documentationVersion: "2026-07" }))).description, "First publication"); assert.equal((await client.send(new GetDocumentationVersionsCommand({ restApiId: api.id! }))).items?.[0].version, "2026-07");
  assert.equal((await client.send(new UpdateDocumentationVersionCommand({ restApiId: api.id!, documentationVersion: "2026-07", patchOperations: [{ op: "replace", path: "/description", value: "Published" }] }))).description, "Published");
  const exported = await client.send(new GetExportCommand({ restApiId: api.id!, stageName: "prod", exportType: "oas30", accepts: "application/json" })); const document = JSON.parse(Buffer.from(exported.body!).toString("utf8")); assert.equal(document.info.description, "Published API documentation"); assert.equal(document.paths["/"].get.description, "Updated root documentation"); assert.equal(document["x-amazon-apigateway-documentation"].documentationParts.length, 3);
  const roundTripped = await client.send(new ImportRestApiCommand({ body: Buffer.from(JSON.stringify(document)) })); assert.equal((await client.send(new GetDocumentationPartsCommand({ restApiId: roundTripped.id! }))).items?.length, 3);
  await assert.rejects(client.send(new DeleteDocumentationVersionCommand({ restApiId: api.id!, documentationVersion: "2026-07" })), (error: any) => error.name === "ConflictException");
  await client.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "prod", patchOperations: [{ op: "remove", path: "/documentationVersion" }] })); await client.send(new DeleteDocumentationVersionCommand({ restApiId: api.id!, documentationVersion: "2026-07" })); await client.send(new DeleteDocumentationPartCommand({ restApiId: api.id!, documentationPartId: apiPart.id! }));
});

test("APIG-13 client certificates and minimal JavaScript SDK generation are explicit and SDK-compatible", async () => {
  const generated = await client.send(new GenerateClientCertificateCommand({ description: "Private backend certificate", tags: { owner: "platform" } })); const x509 = new X509Certificate(generated.pemEncodedCertificate!); assert.match(x509.subject, /stacksim-apigateway/); assert.ok(generated.expirationDate!.getTime() > generated.createdDate!.getTime());
  assert.equal((await client.send(new GetClientCertificateCommand({ clientCertificateId: generated.clientCertificateId! }))).description, "Private backend certificate"); assert.equal((await client.send(new GetClientCertificatesCommand({ limit: 1 }))).items?.[0].clientCertificateId, generated.clientCertificateId);
  assert.equal((await client.send(new UpdateClientCertificateCommand({ clientCertificateId: generated.clientCertificateId!, patchOperations: [{ op: "replace", path: "/description", value: "Rotated local certificate" }] }))).description, "Rotated local certificate");
  const certificateArn = `arn:aws:apigateway:${region}::/clientcertificates/${generated.clientCertificateId}`; assert.equal((await client.send(new GetTagsCommand({ resourceArn: certificateArn }))).tags?.owner, "platform");
  const api = await client.send(new CreateRestApiCommand({ name: "generated-client-api" })); const deployment = await client.send(new CreateDeploymentCommand({ restApiId: api.id! })); await client.send(new CreateStageCommand({ restApiId: api.id!, stageName: "dev", deploymentId: deployment.id! })); await client.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [{ op: "replace", path: "/clientCertificateId", value: generated.clientCertificateId }] }));
  await assert.rejects(client.send(new DeleteClientCertificateCommand({ clientCertificateId: generated.clientCertificateId! })), (error: any) => error.name === "ConflictException");
  assert.equal((await client.send(new GetSdkTypeCommand({ id: "javascript" }))).friendlyName, "JavaScript"); assert.ok((await client.send(new GetSdkTypesCommand({ limit: 2 }))).items?.some(value => value.id === "javascript"));
  const sdk = await client.send(new GetSdkCommand({ restApiId: api.id!, stageName: "dev", sdkType: "javascript" })); assert.equal(Buffer.from(sdk.body!).subarray(0, 2).toString("ascii"), "PK"); assert.equal(sdk.contentType, "application/zip");
  await assert.rejects(client.send(new GetSdkCommand({ restApiId: api.id!, stageName: "dev", sdkType: "java", parameters: { serviceName: "Local", javaPackageName: "local.client" } })), (error: any) => error.name === "BadRequestException" && /dependency-blocked/.test(error.message));
  await client.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [{ op: "remove", path: "/clientCertificateId" }] })); await client.send(new DeleteClientCertificateCommand({ clientCertificateId: generated.clientCertificateId! }));
  assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.equal((await client.send(new GetStageCommand({ restApiId: api.id!, stageName: "dev" }))).clientCertificateId, undefined);
});

test("APIG-13 administration catalogs and documentation survive a simulator restart", async () => {
  client.destroy(); await simulator.stop();
  simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, apiGatewayVpcLinkOrigins: { [targetArn]: backendOrigin }, apiGatewayAllowClientCertificates: true, authMode: "off"});
  await simulator.start();
  client = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials });
  assert.equal((await client.send(new GetVpcLinkCommand({ vpcLinkId: persistedVpcLinkId }))).name, "orders-private");
  const parts = await client.send(new GetDocumentationPartsCommand({ restApiId: persistedDocumentationApiId })); assert.equal(parts.items?.length, 2); assert.ok(parts.items?.some(part => part.location?.type === "METHOD"));
  assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
});
