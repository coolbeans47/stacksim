import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APIGatewayClient,
  CreateBasePathMappingCommand,
  CreateDeploymentCommand,
  CreateDomainNameAccessAssociationCommand,
  CreateDomainNameCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  DeleteBasePathMappingCommand,
  DeleteDomainNameAccessAssociationCommand,
  DeleteDomainNameCommand,
  GetBasePathMappingsCommand,
  GetDomainNameAccessAssociationsCommand,
  GetDomainNameCommand,
  GetDomainNamesCommand,
  GetResourcesCommand,
  GetTagsCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
  TagResourceCommand,
  UpdateBasePathMappingCommand,
  UpdateDomainNameCommand,
} from "@aws-sdk/client-api-gateway";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const clientFor = (simulator: StackSim) => new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });

function opensslExecutable(): string {
  const candidates = process.platform === "win32"
    ? ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe"]
    : ["openssl"];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error("The API Gateway TLS test requires an OpenSSL executable");
}

async function mockApi(client: APIGatewayClient, name: string): Promise<string> {
  const api = await client.send(new CreateRestApiCommand({ name })); const root = (await client.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!; const who = await client.send(new CreateResourceCommand({ restApiId: api.id!, parentId: root.id!, pathPart: "who" }));
  await client.send(new PutMethodCommand({ restApiId: api.id!, resourceId: who.id!, httpMethod: "GET", authorizationType: "NONE" })); await client.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: who.id!, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } })); await client.send(new PutMethodResponseCommand({ restApiId: api.id!, resourceId: who.id!, httpMethod: "GET", statusCode: "200" })); await client.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: who.id!, httpMethod: "GET", statusCode: "200", responseTemplates: { "application/json": JSON.stringify({ api: name }) } })); await client.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "prod" })); return api.id!;
}

async function invoke(simulator: StackSim, host: string, path: string): Promise<{ status: number; json(): Promise<any> }> { return new Promise((resolve, reject) => { const request = httpRequest({ hostname: "127.0.0.1", port: simulator.invokePort, path, headers: { host } }, response => { const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("end", () => { const body = Buffer.concat(chunks).toString("utf8"); resolve({ status: response.statusCode ?? 0, async json() { return JSON.parse(body); } }); }); }); request.on("error", reject); request.end(); }); }

test("API Gateway custom domains support fields, tags, mappings, longest-path routing, associations, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-domain-")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); let client: APIGatewayClient | undefined;
  try {
    await simulator.start(); client = clientFor(simulator); const primary = await mockApi(client, "primary"); const versioned = await mockApi(client, "versioned");
    const certificate = "arn:aws:acm:eu-west-1:000000000000:certificate/11111111-1111-1111-1111-111111111111"; const ownership = "arn:aws:acm:eu-west-1:000000000000:certificate/22222222-2222-2222-2222-222222222222";
    const created = await client.send(new CreateDomainNameCommand({ domainName: "API.Example.test", endpointConfiguration: { types: ["REGIONAL"], ipAddressType: "dualstack" }, regionalCertificateArn: certificate, securityPolicy: "TLS_1_2", routingMode: "BASE_PATH_MAPPING_ONLY", mutualTlsAuthentication: { truststoreUri: "s3://trust-bucket/clients.pem", truststoreVersion: "v1" }, ownershipVerificationCertificateArn: ownership, tags: { owner: "platform" } })); assert.equal(created.domainName, "api.example.test"); assert.equal(created.domainNameStatus, "AVAILABLE"); assert.equal(created.endpointConfiguration?.ipAddressType, "dualstack"); assert.equal(created.mutualTlsAuthentication?.truststoreVersion, "v1"); assert.match(created.regionalDomainName!, /\.execute-api\.eu-west-1\.local$/);
    await assert.rejects(client.send(new CreateDomainNameCommand({ domainName: "api.example.test", endpointConfiguration: { types: ["REGIONAL"] }, regionalCertificateArn: certificate })), (error: any) => error.name === "ConflictException");
    await client.send(new TagResourceCommand({ resourceArn: created.domainNameArn!, tags: { environment: "test" } })); assert.deepEqual((await client.send(new GetTagsCommand({ resourceArn: created.domainNameArn! }))).tags, { owner: "platform", environment: "test" });
    await client.send(new CreateBasePathMappingCommand({ domainName: created.domainName!, basePath: "(none)", restApiId: primary, stage: "prod" })); await client.send(new CreateBasePathMappingCommand({ domainName: created.domainName!, basePath: "v1", restApiId: versioned, stage: "prod" })); await client.send(new CreateBasePathMappingCommand({ domainName: created.domainName!, basePath: "v1/admin", restApiId: primary, stage: "prod" }));
    await assert.rejects(client.send(new CreateBasePathMappingCommand({ domainName: created.domainName!, basePath: "v1", restApiId: primary, stage: "prod" })), (error: any) => error.name === "ConflictException"); assert.deepEqual(await (await invoke(simulator, "api.example.test", "/who")).json(), { api: "primary" }); assert.deepEqual(await (await invoke(simulator, "api.example.test", "/v1/who")).json(), { api: "versioned" }); assert.deepEqual(await (await invoke(simulator, "api.example.test", "/v1/admin/who")).json(), { api: "primary" });
    await client.send(new UpdateBasePathMappingCommand({ domainName: created.domainName!, basePath: "v1", patchOperations: [{ op: "replace", path: "/basePath", value: "v2" }, { op: "replace", path: "/restApiId", value: primary }] })); assert.equal((await invoke(simulator, "api.example.test", "/v1/who")).status, 403, "the root mapping preserves the unmatched v1 resource path after a longer mapping is renamed"); assert.deepEqual(await (await invoke(simulator, "api.example.test", "/v2/who")).json(), { api: "primary" }); assert.equal((await client.send(new GetBasePathMappingsCommand({ domainName: created.domainName! }))).items?.length, 3);
    await client.send(new UpdateDomainNameCommand({ domainName: created.domainName!, patchOperations: [{ op: "replace", path: "/routingMode", value: "ROUTING_RULE_ONLY" }] })); assert.equal((await invoke(simulator, "api.example.test", "/who")).status, 403); await client.send(new UpdateDomainNameCommand({ domainName: created.domainName!, patchOperations: [{ op: "replace", path: "/routingMode", value: "ROUTING_RULE_THEN_BASE_PATH_MAPPING" }] }));
    const privateDomain = await client.send(new CreateDomainNameCommand({ domainName: "private.example.test", endpointConfiguration: { types: ["PRIVATE"], vpcEndpointIds: ["vpce-abc123"] }, certificateArn: certificate, policy: JSON.stringify({ Version: "2012-10-17", Statement: [] }), routingMode: "BASE_PATH_MAPPING_ONLY", tags: { scope: "private" } })); assert.ok(privateDomain.domainNameId); assert.match(privateDomain.domainNameArn!, /private\.example\.test\+/); const association = await client.send(new CreateDomainNameAccessAssociationCommand({ domainNameArn: privateDomain.domainNameArn!, accessAssociationSourceType: "VPCE", accessAssociationSource: "vpce-abc123", tags: { team: "network" } })); assert.match(association.domainNameAccessAssociationArn!, /\/vpcesource\/vpce-abc123$/); assert.equal((await client.send(new GetDomainNameAccessAssociationsCommand({ resourceOwner: "SELF" }))).items?.length, 1); await assert.rejects(client.send(new CreateDomainNameAccessAssociationCommand({ domainNameArn: privateDomain.domainNameArn!, accessAssociationSourceType: "VPCE", accessAssociationSource: "vpce-abc123" })), (error: any) => error.name === "ConflictException"); await client.send(new DeleteDomainNameAccessAssociationCommand({ domainNameAccessAssociationArn: association.domainNameAccessAssociationArn! })); assert.equal((await client.send(new GetDomainNameAccessAssociationsCommand({}))).items?.length ?? 0, 0);
    assert.equal((await client.send(new GetDomainNamesCommand({ limit: 1 }))).items?.length, 1); assert.equal((await client.send(new GetDomainNameCommand({ domainName: privateDomain.domainName!, domainNameId: privateDomain.domainNameId }))).policy, JSON.stringify({ Version: "2012-10-17", Statement: [] }));
    client.destroy(); client = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); await simulator.start(); client = clientFor(simulator); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.deepEqual(await (await invoke(simulator, "api.example.test", "/v1/admin/who")).json(), { api: "primary" });
    await client.send(new DeleteBasePathMappingCommand({ domainName: created.domainName!, basePath: "v1/admin" })); assert.equal((await invoke(simulator, "api.example.test", "/v1/admin/who")).status, 403, "the root mapping preserves the unmatched path after delete"); await client.send(new DeleteDomainNameCommand({ domainName: privateDomain.domainName!, domainNameId: privateDomain.domainNameId })); await assert.rejects(client.send(new GetDomainNameCommand({ domainName: privateDomain.domainName!, domainNameId: privateDomain.domainNameId })), (error: any) => error.name === "NotFoundException");
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("API Gateway invocation TLS is enabled only with explicit local certificate and key paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-domain-tls-")); const certificatePath = join(root, "certificate.pem"); const privateKeyPath = join(root, "private-key.pem"); execFileSync(opensslExecutable(), ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", privateKeyPath, "-out", certificatePath, "-subj", "/CN=api.tls.test", "-days", "1"], { stdio: "ignore" }); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, apiGatewayTlsCertificatePath: certificatePath, apiGatewayTlsPrivateKeyPath: privateKeyPath, authMode: "off"}); let client: APIGatewayClient | undefined;
  try {
    await simulator.start(); assert.equal(simulator.invokeProtocol, "https"); client = clientFor(simulator); const api = await mockApi(client, "tls"); const certificate = "arn:aws:acm:eu-west-1:000000000000:certificate/33333333-3333-3333-3333-333333333333"; await client.send(new CreateDomainNameCommand({ domainName: "api.tls.test", endpointConfiguration: { types: ["REGIONAL"] }, regionalCertificateArn: certificate })); await client.send(new CreateBasePathMappingCommand({ domainName: "api.tls.test", basePath: "(none)", restApiId: api, stage: "prod" }));
    const response = await new Promise<{ status?: number; body: string }>((resolve, reject) => { const request = httpsRequest({ hostname: "127.0.0.1", port: simulator.invokePort, path: "/who", method: "GET", servername: "api.tls.test", rejectUnauthorized: false, headers: { host: "api.tls.test" } }, res => { const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk))); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") })); }); request.on("error", reject); request.end(); }); assert.equal(response.status, 200); assert.deepEqual(JSON.parse(response.body), { api: "tls" });
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
