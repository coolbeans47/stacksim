import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  CreateModelCommand,
  CreateRequestValidatorCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  DeleteModelCommand,
  DeleteRequestValidatorCommand,
  GetMethodCommand,
  GetModelCommand,
  GetModelsCommand,
  GetModelTemplateCommand,
  GetRequestValidatorCommand,
  GetRequestValidatorsCommand,
  GetResourcesCommand,
  PutGatewayResponseCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
  TestInvokeMethodCommand,
  UpdateMethodCommand,
  UpdateModelCommand,
  UpdateRequestValidatorCommand,
} from "@aws-sdk/client-api-gateway";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("API Gateway models and request validators provide Draft 4 validation and immutable deployment snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-models-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off"});
  let client: APIGatewayClient | undefined;
  try {
    await simulator.start();
    client = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
    const api = await client.send(new CreateRestApiCommand({ name: "validated-api" })); const apiId = api.id!;
    const defaults = await client.send(new GetModelsCommand({ restApiId: apiId }));
    assert.deepEqual(defaults.items?.map(model => model.name), ["Empty", "Error"]);
    assert.equal((await client.send(new GetModelCommand({ restApiId: apiId, modelName: "Error" }))).contentType, "application/json");
    await assert.rejects(client.send(new DeleteModelCommand({ restApiId: apiId, modelName: "Empty" })), (error: any) => error.name === "BadRequestException");

    const addressSchema = JSON.stringify({ type: "object", required: ["street", "zip"], additionalProperties: false, properties: { street: { type: "string", minLength: 3, maxLength: 40 }, zip: { type: "string", pattern: "^[A-Z]{2}[0-9]{2}$" } } });
    const address = await client.send(new CreateModelCommand({ restApiId: apiId, name: "Address", contentType: "application/json", description: "Postal address", schema: addressSchema }));
    assert.ok(address.id);
    const addressRef = `https://apigateway.amazonaws.com/restapis/${apiId}/models/Address`;
    const orderSchema = JSON.stringify({ type: "object", required: ["address", "lines", "total"], additionalProperties: false, properties: { address: { $ref: addressRef }, lines: { type: "array", minItems: 1, items: { type: "object", required: ["sku", "kind"], properties: { sku: { type: "string", minLength: 2 }, kind: { type: "string", enum: ["book", "game"] } } } }, total: { type: "number", minimum: 1, maximum: 1000 } } });
    await client.send(new CreateModelCommand({ restApiId: apiId, name: "Order", contentType: "application/json", schema: orderSchema }));
    await client.send(new CreateModelCommand({ restApiId: apiId, name: "Plain", contentType: "text/plain", schema: JSON.stringify({ type: "string", minLength: 2, maxLength: 10 }) }));
    const template = JSON.parse((await client.send(new GetModelTemplateCommand({ restApiId: apiId, modelName: "Order" }))).value!);
    assert.deepEqual(template.address, { street: "string", zip: "string" }); assert.equal(template.lines[0].kind, "book");

    await client.send(new CreateModelCommand({ restApiId: apiId, name: "CycleA", contentType: "application/json", schema: "{}" }));
    await client.send(new CreateModelCommand({ restApiId: apiId, name: "CycleB", contentType: "application/json", schema: JSON.stringify({ $ref: `https://apigateway.amazonaws.com/restapis/${apiId}/models/CycleA` }) }));
    await assert.rejects(client.send(new UpdateModelCommand({ restApiId: apiId, modelName: "CycleA", patchOperations: [{ op: "replace", path: "/schema", value: JSON.stringify({ $ref: `https://apigateway.amazonaws.com/restapis/${apiId}/models/CycleB` }) }] })), (error: any) => error.name === "BadRequestException" && /cyclic/i.test(error.message));

    const bodyOnly = await client.send(new CreateRequestValidatorCommand({ restApiId: apiId, name: "body only", validateRequestBody: true, validateRequestParameters: false }));
    const parametersOnly = await client.send(new CreateRequestValidatorCommand({ restApiId: apiId, name: "parameters only", validateRequestBody: false, validateRequestParameters: true }));
    const both = await client.send(new CreateRequestValidatorCommand({ restApiId: apiId, name: "all", validateRequestBody: true, validateRequestParameters: true }));
    const spare = await client.send(new CreateRequestValidatorCommand({ restApiId: apiId, name: "spare" }));
    await client.send(new UpdateRequestValidatorCommand({ restApiId: apiId, requestValidatorId: spare.id!, patchOperations: [{ op: "replace", path: "/name", value: "renamed" }, { op: "replace", path: "/validateRequestBody", value: "true" }] }));
    assert.equal((await client.send(new GetRequestValidatorCommand({ restApiId: apiId, requestValidatorId: spare.id! }))).validateRequestBody, true);
    const validatorPage = await client.send(new GetRequestValidatorsCommand({ restApiId: apiId, limit: 2 })); assert.equal(validatorPage.items?.length, 2); assert.ok(validatorPage.position);
    await client.send(new DeleteRequestValidatorCommand({ restApiId: apiId, requestValidatorId: spare.id! }));

    const rootResource = (await client.send(new GetResourcesCommand({ restApiId: apiId }))).items!.find(resource => resource.path === "/")!;
    const resource = await client.send(new CreateResourceCommand({ restApiId: apiId, parentId: rootResource.id!, pathPart: "orders" }));
    await client.send(new PutMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", authorizationType: "NONE", requestParameters: { "method.request.querystring.tenant": true }, requestModels: { "application/json": "Order", "text/plain": "Plain" }, requestValidatorId: bodyOnly.id }));
    await client.send(new PutMethodResponseCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", statusCode: "200", responseModels: { "application/json": "Error" } }));
    await client.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } }));
    await client.send(new PutIntegrationResponseCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", statusCode: "200", responseTemplates: { "application/json": "{\"accepted\":true}" } }));
    const validOrder = JSON.stringify({ address: { street: "Main Street", zip: "AB12" }, lines: [{ sku: "B1", kind: "book" }], total: 12 });
    const bodyOnlyResult = await client.send(new TestInvokeMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", headers: { "content-type": "application/json" }, body: validOrder })); assert.equal(bodyOnlyResult.status, 200, "body-only validation must not require parameters");
    await assert.rejects(client.send(new TestInvokeMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: { street: "x", zip: "bad", extra: true }, lines: [], total: 0 }) })), (error: any) => error.name === "BadRequestException" && /Invalid request body/.test(error.message));
    assert.equal((await client.send(new TestInvokeMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", headers: { "content-type": "text/plain; charset=utf-8" }, body: '"hello"' }))).status, 200, "content type must select its own model");
    assert.equal((await client.send(new TestInvokeMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", headers: { "content-type": "application/xml" }, body: "not-json" }))).status, 200, "an unmatched content type must not use another model");

    await client.send(new UpdateMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", patchOperations: [{ op: "replace", path: "/requestValidatorId", value: parametersOnly.id! }] }));
    await assert.rejects(client.send(new TestInvokeMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", headers: { "content-type": "application/json" }, body: "not-json" })), (error: any) => error.name === "BadRequestException" && /tenant/.test(error.message));
    assert.equal((await client.send(new TestInvokeMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", pathWithQueryString: "/orders?tenant=acme", headers: { "content-type": "application/json" }, body: "not-json" }))).status, 200, "parameter-only validation must not validate the body");
    await client.send(new UpdateMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", patchOperations: [{ op: "replace", path: "/requestValidatorId", value: both.id! }] }));
    assert.equal((await client.send(new GetMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST" }))).requestValidatorId, both.id);
    await assert.rejects(client.send(new DeleteRequestValidatorCommand({ restApiId: apiId, requestValidatorId: both.id! })), (error: any) => error.name === "ConflictException");
    await assert.rejects(client.send(new DeleteModelCommand({ restApiId: apiId, modelName: "Order" })), (error: any) => error.name === "ConflictException");

    await client.send(new PutGatewayResponseCommand({ restApiId: apiId, responseType: "BAD_REQUEST_BODY", statusCode: "422", responseTemplates: { "application/json": "{\"kind\":\"body\",\"detail\":$context.error.messageString}" } }));
    await client.send(new PutGatewayResponseCommand({ restApiId: apiId, responseType: "BAD_REQUEST_PARAMETERS", statusCode: "409", responseTemplates: { "application/json": "{\"kind\":\"parameters\"}" } }));
    await client.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev" }));
    const invokeUrl = `http://127.0.0.1:${simulator.invokePort}/${apiId}/dev/orders`;
    const missing = await fetch(invokeUrl, { method: "POST", headers: { "content-type": "application/json" }, body: validOrder }); assert.equal(missing.status, 409); assert.deepEqual(await missing.json(), { kind: "parameters" });
    const invalid = await fetch(`${invokeUrl}?tenant=acme`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); assert.equal(invalid.status, 422); assert.equal((await invalid.json()).kind, "body");
    assert.equal((await fetch(`${invokeUrl}?tenant=acme`, { method: "POST", headers: { "content-type": "application/json" }, body: validOrder })).status, 200);

    const stricter = JSON.stringify({ ...JSON.parse(orderSchema), required: ["address", "lines", "total", "version"], properties: { ...JSON.parse(orderSchema).properties, version: { type: "integer", minimum: 1 } } });
    await client.send(new UpdateModelCommand({ restApiId: apiId, modelName: "Order", patchOperations: [{ op: "replace", path: "/schema", value: stricter }] }));
    await assert.rejects(client.send(new TestInvokeMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", pathWithQueryString: "/orders?tenant=acme", headers: { "content-type": "application/json" }, body: validOrder })), (error: any) => error.name === "BadRequestException" && /version/.test(error.message));
    assert.equal((await fetch(`${invokeUrl}?tenant=acme`, { method: "POST", headers: { "content-type": "application/json" }, body: validOrder })).status, 200, "the existing deployment must retain its model snapshot");
    await client.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev" }));
    assert.equal((await fetch(`${invokeUrl}?tenant=acme`, { method: "POST", headers: { "content-type": "application/json" }, body: validOrder })).status, 422, "redeployment must activate the stricter model");
  } finally {
    client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});
