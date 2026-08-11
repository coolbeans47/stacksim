import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  GetExportCommand,
  GetModelsCommand,
  GetRequestValidatorsCommand,
  GetResourcesCommand,
  GetRestApisCommand,
  ImportRestApiCommand,
  PutRestApiCommand,
} from "@aws-sdk/client-api-gateway";
import { parseOpenApiDocument } from "../src/apigateway-openapi.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const bytes = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));

function tutorialSwagger(title = "Pet tutorial"): Record<string, any> {
  return {
    swagger: "2.0",
    info: { title, description: "Official tutorial-shaped mock API", version: "1.0" },
    consumes: ["application/json"],
    produces: ["application/json"],
    securityDefinitions: { api_key: { type: "apiKey", name: "X-API-Key", in: "header" } },
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          parameters: [{ name: "type", in: "query", required: true, type: "string" }],
          "x-amazon-apigateway-request-validator": "all",
          responses: { "200": { description: "Pet list", schema: { type: "array", items: { $ref: "#/definitions/Pet" } } } },
          "x-amazon-apigateway-integration": { type: "mock", httpMethod: "POST", requestTemplates: { "application/json": "{\"statusCode\":200}" }, responses: { default: { statusCode: "200", responseTemplates: { "application/json": "{\"pets\":[]}" } } } },
        },
      },
      "/secured": {
        get: {
          security: [{ api_key: [] }],
          responses: { "200": { description: "secured" } },
          "x-amazon-apigateway-integration": { type: "mock", requestTemplates: { "application/json": "{\"statusCode\":200}" }, responses: { default: { statusCode: "200" } } },
        },
      },
    },
    definitions: { Pet: { type: "object", required: ["id", "name"], properties: { id: { type: "integer", minimum: 1 }, name: { type: "string", minLength: 1 } } } },
    "x-amazon-apigateway-request-validators": { all: { validateRequestBody: true, validateRequestParameters: true } },
    "x-amazon-apigateway-gateway-responses": { BAD_REQUEST_PARAMETERS: { statusCode: "422", responseTemplates: { "application/json": "{\"kind\":\"parameters\"}" } } },
    "x-amazon-apigateway-binary-media-types": ["application/octet-stream"],
    "x-amazon-apigateway-minimum-compression-size": 256,
    "x-amazon-apigateway-policy": { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "execute-api:Invoke", Resource: "execute-api:/*" }] },
    "x-amazon-apigateway-api-key-source": "AUTHORIZER",
  };
}

test("API Gateway imports, updates, exports, and reimports OpenAPI through official SDK commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-openapi-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); let client: APIGatewayClient | undefined;
  try {
    await simulator.start(); client = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
    const imported = await client.send(new ImportRestApiCommand({ body: bytes(tutorialSwagger()), parameters: { endpointConfigurationTypes: "REGIONAL" } })); assert.equal(imported.name, "Pet tutorial"); assert.equal(imported.version, "1.0"); assert.equal(imported.rootResourceId?.length, 10); assert.deepEqual(imported.binaryMediaTypes, ["application/octet-stream"]); assert.equal(imported.minimumCompressionSize, 256); assert.equal(imported.warnings, undefined);
    const resources = await client.send(new GetResourcesCommand({ restApiId: imported.id!, embed: ["methods.methodIntegration"] })); const pets = resources.items!.find(resource => resource.path === "/pets")!; const secured = resources.items!.find(resource => resource.path === "/secured")!; assert.equal(pets.resourceMethods?.GET.authorizationType, "NONE"); assert.equal(pets.resourceMethods?.GET.methodIntegration?.type, "MOCK"); assert.equal(secured.resourceMethods?.GET.apiKeyRequired, true); assert.equal(imported.apiKeySource, "AUTHORIZER"); assert.equal(Object.keys(pets.resourceMethods?.GET.requestParameters ?? {})[0], "method.request.querystring.type"); assert.deepEqual((await client.send(new GetModelsCommand({ restApiId: imported.id! }))).items?.map(model => model.name), ["Empty", "Error", "listPets200Response", "Pet"]); assert.equal((await client.send(new GetRequestValidatorsCommand({ restApiId: imported.id! }))).items?.[0].name, "all");
    await client.send(new CreateDeploymentCommand({ restApiId: imported.id!, stageName: "dev" })); const invoke = `http://127.0.0.1:${simulator.invokePort}/${imported.id}/dev/pets`; const invalid = await fetch(invoke); assert.equal(invalid.status, 422); assert.deepEqual(await invalid.json(), { kind: "parameters" }); const valid = await fetch(`${invoke}?type=dog`); assert.equal(valid.status, 200); assert.deepEqual(await valid.json(), { pets: [] });

    const exported = await client.send(new GetExportCommand({ restApiId: imported.id!, stageName: "dev", exportType: "oas30", parameters: { extensions: "apigateway", postman: "true" }, accepts: "application/json" })); assert.equal(exported.contentType, "application/json"); assert.match(exported.contentDisposition ?? "", /\.json/); const exportedDocument = JSON.parse(Buffer.from(exported.body!).toString("utf8")); assert.equal(exportedDocument.openapi, "3.0.1"); assert.equal(exportedDocument.paths["/pets"].get["x-amazon-apigateway-integration"].type, "mock"); assert.deepEqual(exportedDocument.paths["/secured"].get.security, [{ api_key: [] }]); assert.equal(exportedDocument.components.securitySchemes.api_key.type, "apiKey"); assert.equal(exportedDocument["x-amazon-apigateway-api-key-source"], "AUTHORIZER"); assert.equal(exportedDocument["x-postman-name"], "Pet tutorial"); assert.equal(exportedDocument.components.schemas.Pet.type, "object");
    const reimported = await client.send(new ImportRestApiCommand({ body: exported.body! })); const reimportedResources = await client.send(new GetResourcesCommand({ restApiId: reimported.id!, embed: ["methods.methodIntegration"] })); const reimportedPets = reimportedResources.items!.find(resource => resource.path === "/pets")!; const reimportedSecured = reimportedResources.items!.find(resource => resource.path === "/secured")!; assert.equal(reimportedPets.resourceMethods?.GET.methodIntegration?.type, "MOCK"); assert.equal(reimportedSecured.resourceMethods?.GET.apiKeyRequired, true); assert.equal(reimported.apiKeySource, "AUTHORIZER"); assert.deepEqual(reimportedPets.resourceMethods?.GET.requestParameters, pets.resourceMethods?.GET.requestParameters); assert.deepEqual((await client.send(new GetModelsCommand({ restApiId: reimported.id! }))).items?.map(model => model.name), ["Empty", "Error", "listPets200Response", "Pet"]);

    const yamlExport = await client.send(new GetExportCommand({ restApiId: imported.id!, stageName: "dev", exportType: "swagger", parameters: { extensions: "integrations" }, accepts: "application/yaml" })); assert.equal(yamlExport.contentType, "application/yaml"); const parsedYamlExport = parseOpenApiDocument(Buffer.from(yamlExport.body!)); assert.equal(parsedYamlExport.swagger, "2.0"); assert.equal(parsedYamlExport.paths["/pets"].get["x-amazon-apigateway-integration"].type, "mock");

    const mergeDocument = {
      openapi: "3.0.1",
      info: { title: "Ignored update title", version: "2.0" },
      paths: { "/orders/{id}": { get: {
        operationId: "getOrder",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Order", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } } },
        "x-amazon-apigateway-integration": { type: "mock", responses: { default: { statusCode: "200" } }, requestTemplates: { "application/json": "{\"statusCode\":200}" } },
      } } },
      components: { schemas: { Order: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } },
    };
    await client.send(new PutRestApiCommand({ restApiId: imported.id!, mode: "merge", body: bytes(mergeDocument) })); let afterUpdate = await client.send(new GetResourcesCommand({ restApiId: imported.id! })); assert.ok(afterUpdate.items?.some(resource => resource.path === "/pets")); assert.ok(afterUpdate.items?.some(resource => resource.path === "/orders/{id}"));
    const deployedStillOld = await client.send(new GetExportCommand({ restApiId: imported.id!, stageName: "dev", exportType: "oas30", accepts: "application/json" })); assert.equal(JSON.parse(Buffer.from(deployedStillOld.body!).toString()).paths["/orders/{id}"], undefined, "exports must use the stage deployment snapshot");

    const beforeWarning = JSON.stringify((await client.send(new GetResourcesCommand({ restApiId: imported.id! }))).items?.map(resource => resource.path).sort()); const warningDocument = { openapi: "3.0.1", info: { title: "Warning", version: "1" }, paths: { "/warning": { get: { responses: { "200": { description: "ok" } }, "x-amazon-apigateway-integration": { type: "unsupported" } } } } };
    await assert.rejects(client.send(new PutRestApiCommand({ restApiId: imported.id!, mode: "merge", failOnWarnings: true, body: bytes(warningDocument) })), (error: any) => error.name === "BadRequestException" && /unsupported/i.test(error.message)); assert.equal(JSON.stringify((await client.send(new GetResourcesCommand({ restApiId: imported.id! }))).items?.map(resource => resource.path).sort()), beforeWarning, "warning rollback must be atomic");
    const warned = await client.send(new PutRestApiCommand({ restApiId: imported.id!, mode: "merge", body: bytes(warningDocument) })); assert.match(warned.warnings?.[0] ?? "", /unsupported/i); assert.ok((await client.send(new GetResourcesCommand({ restApiId: imported.id! }))).items?.some(resource => resource.path === "/warning"));
    await client.send(new PutRestApiCommand({ restApiId: imported.id!, mode: "overwrite", body: bytes(mergeDocument) })); afterUpdate = await client.send(new GetResourcesCommand({ restApiId: imported.id! })); assert.equal(afterUpdate.items?.some(resource => resource.path === "/pets"), false); assert.ok(afterUpdate.items?.some(resource => resource.path === "/orders/{id}"));
    await assert.rejects(client.send(new PutRestApiCommand({ restApiId: imported.id!, body: bytes({ openapi: "3.0.1", info: { title: "bad" }, paths: {} }) })), (error: any) => error.name === "BadRequestException"); assert.ok((await client.send(new GetResourcesCommand({ restApiId: imported.id! }))).items?.some(resource => resource.path === "/orders/{id}"), "invalid definitions must not mutate the API");
    const count = (await client.send(new GetRestApisCommand({}))).items?.length; await assert.rejects(client.send(new ImportRestApiCommand({ body: bytes(warningDocument), failOnWarnings: true })), (error: any) => error.name === "BadRequestException"); assert.equal((await client.send(new GetRestApisCommand({}))).items?.length, count, "failed imports must not create an API");
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("API Gateway imports the bounded OpenAPI YAML subset and rejects unsupported YAML", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-yaml-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"}); let client: APIGatewayClient | undefined;
  try {
    await simulator.start(); client = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
    const yaml = `swagger: "2.0"\ninfo:\n  title: YAML tutorial\n  version: "1.0"\nproduces:\n  - application/json\npaths:\n  /hello:\n    get:\n      responses:\n        "200":\n          description: greeting\n      x-amazon-apigateway-integration:\n        type: mock\n        requestTemplates:\n          application/json: '{"statusCode":200}'\n        responses:\n          default:\n            statusCode: "200"\ndefinitions:\n  Greeting:\n    type: object\n    properties:\n      message:\n        type: string\n`;
    const api = await client.send(new ImportRestApiCommand({ body: bytes(yaml), parameters: { basepath: "ignore" } })); assert.equal(api.name, "YAML tutorial"); const hello = (await client.send(new GetResourcesCommand({ restApiId: api.id!, embed: ["methods.methodIntegration"] }))).items!.find(resource => resource.path === "/hello")!; assert.equal(hello.resourceMethods?.GET.methodIntegration?.type, "MOCK"); assert.ok((await client.send(new GetModelsCommand({ restApiId: api.id! }))).items?.some(model => model.name === "Greeting"));
    await assert.rejects(client.send(new ImportRestApiCommand({ body: bytes("openapi: 3.0.1\ninfo: &shared\n  title: bad\n  version: '1'\npaths: {}\n") })), (error: any) => error.name === "BadRequestException" && /anchors/i.test(error.message));
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
