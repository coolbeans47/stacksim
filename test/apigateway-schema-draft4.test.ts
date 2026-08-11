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
  GetResourcesCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
  TestInvokeMethodCommand,
  UpdateModelCommand,
} from "@aws-sdk/client-api-gateway";
import {
  DRAFT4_PROFILE_VERSION,
  draft4CompatibilityProfile,
  validateJsonModel,
  validateModelCatalog,
} from "../src/apigateway-schema.js";
import type { ApiModelState } from "../src/types.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function model(name: string, schema: unknown): ApiModelState {
  return { id: name, name, contentType: "application/json", schema: JSON.stringify(schema) };
}

test("DUG-09 publishes a frozen Draft 4 compatibility profile", () => {
  const profile = draft4CompatibilityProfile();
  assert.equal(profile.version, DRAFT4_PROFILE_VERSION);
  assert.equal(profile.draft, "http://json-schema.org/draft-04/schema#");
  assert.ok(profile.keywords.includes("allOf"));
  assert.ok(profile.keywords.includes("patternProperties"));
  assert.ok(profile.formats.includes("uuid"));
});

test("DUG-09 rejects unsupported Draft 4 keywords at mutation time", () => {
  const reject = (schema: unknown, pattern: RegExp) => {
    assert.throws(() => validateModelCatalog({ Sample: model("Sample", schema) }), pattern);
  };
  reject({ type: "object", const: "fixed" }, /Unsupported Draft 4 keyword const/);
  reject({ type: "string", if: { type: "string" } }, /Unsupported Draft 4 keyword if/);
  reject({ type: "string", format: "date" }, /format at \$ must be one of/);
});

test("DUG-09 executes the frozen Draft 4 keyword subset during validation", () => {
  const catalog: Record<string, ApiModelState> = {
    Combinators: model("Combinators", {
      oneOf: [{ type: "string", minLength: 2 }, { type: "integer", minimum: 10 }],
    }),
    Negation: model("Negation", { not: { type: "string" } }),
    Multiple: model("Multiple", { type: "integer", multipleOf: 3 }),
    Unique: model("Unique", { type: "array", uniqueItems: true, items: { type: "integer" } }),
    PropertyCount: model("PropertyCount", { type: "object", minProperties: 2, maxProperties: 3, properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } } }),
    PatternProps: model("PatternProps", { type: "object", patternProperties: { "^x-": { type: "integer" } }, additionalProperties: false }),
    Dependencies: model("Dependencies", { type: "object", properties: { card: { type: "string" }, cvv: { type: "string" } }, dependencies: { card: ["cvv"] } }),
    Tuple: model("Tuple", { type: "array", items: [{ type: "string" }, { type: "integer" }], additionalItems: false }),
    Formats: model("Formats", { type: "string", format: "uuid" }),
    RefTarget: model("RefTarget", { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 3 } } }),
  };
  const apiId = "abc123";
  const ref = `https://apigateway.amazonaws.com/restapis/${apiId}/models/RefTarget`;
  catalog.RefConsumer = model("RefConsumer", { $ref: ref });

  validateModelCatalog(catalog);

  assert.deepEqual(validateJsonModel("hello", "Combinators", catalog), []);
  assert.ok(validateJsonModel(9, "Combinators", catalog).some(message => /oneOf/.test(message)));
  assert.deepEqual(validateJsonModel(42, "Combinators", catalog), []);
  assert.deepEqual(validateJsonModel(7, "Negation", catalog), []);
  assert.ok(validateJsonModel("blocked", "Negation", catalog).some(message => /must not satisfy/.test(message)));
  assert.deepEqual(validateJsonModel(6, "Multiple", catalog), []);
  assert.ok(validateJsonModel(7, "Multiple", catalog).some(message => /multiple of 3/.test(message)));
  assert.deepEqual(validateJsonModel([1, 2, 3], "Unique", catalog), []);
  assert.ok(validateJsonModel([1, 1], "Unique", catalog).some(message => /unique/.test(message)));
  assert.deepEqual(validateJsonModel({ a: "1", b: "2" }, "PropertyCount", catalog), []);
  assert.ok(validateJsonModel({ a: "1" }, "PropertyCount", catalog).some(message => /at least 2 properties/.test(message)));
  assert.deepEqual(validateJsonModel({ "x-code": 1 }, "PatternProps", catalog), []);
  assert.ok(validateJsonModel({ other: 1 }, "PatternProps", catalog).some(message => /additional property/.test(message)));
  assert.deepEqual(validateJsonModel({ card: "4111", cvv: "123" }, "Dependencies", catalog), []);
  assert.ok(validateJsonModel({ card: "4111" }, "Dependencies", catalog).some(message => /cvv.*required when card/.test(message)));
  assert.deepEqual(validateJsonModel(["alpha", 2], "Tuple", catalog), []);
  assert.ok(validateJsonModel(["alpha", 2, "extra"], "Tuple", catalog).some(message => /additional item/.test(message)));
  assert.deepEqual(validateJsonModel("00000000-0000-4000-8000-000000000000", "Formats", catalog), []);
  assert.ok(validateJsonModel("not-a-uuid", "Formats", catalog).some(message => /format uuid/.test(message)));
  assert.deepEqual(validateJsonModel({ id: "abc" }, "RefConsumer", catalog), []);
  assert.ok(validateJsonModel({ id: "x" }, "RefConsumer", catalog).some(message => /\.id/.test(message)));

  const first = validateJsonModel({ id: "abc" }, "RefConsumer", catalog);
  const second = validateJsonModel({ id: "abc" }, "RefConsumer", catalog);
  assert.deepEqual(first, second, "deterministic recompilation must return the same failures");
});

test("DUG-09 deployment snapshots persist schema profile version and frozen models", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-draft4-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "off" });
  let client: APIGatewayClient | undefined;
  try {
    await simulator.start();
    client = new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials });
    const api = await client.send(new CreateRestApiCommand({ name: "draft4-api" }));
    const apiId = api.id!;
    const uniqueSchema = JSON.stringify({ type: "array", uniqueItems: true, items: { type: "string" } });
    await client.send(new CreateModelCommand({ restApiId: apiId, name: "UniqueTags", contentType: "application/json", schema: uniqueSchema }));
    const validator = await client.send(new CreateRequestValidatorCommand({ restApiId: apiId, name: "body", validateRequestBody: true }));
    const rootResource = (await client.send(new GetResourcesCommand({ restApiId: apiId }))).items!.find(resource => resource.path === "/")!;
    const resource = await client.send(new CreateResourceCommand({ restApiId: apiId, parentId: rootResource.id!, pathPart: "tags" }));
    await client.send(new PutMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", authorizationType: "NONE", requestModels: { "application/json": "UniqueTags" }, requestValidatorId: validator.id }));
    await client.send(new PutMethodResponseCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", statusCode: "200" }));
    await client.send(new PutIntegrationCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } }));
    await client.send(new PutIntegrationResponseCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", statusCode: "200", responseTemplates: { "application/json": "{\"ok\":true}" } }));

    await client.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev" }));
    const stored = simulator.store.regionState("eu-west-1").apis[apiId];
    const deployment = Object.values(stored.deployments).sort((a, b) => b.createdDate - a.createdDate)[0];
    assert.equal(deployment.snapshot?.schemaProfileVersion, DRAFT4_PROFILE_VERSION);
    assert.equal(deployment.snapshot?.models?.UniqueTags?.schema, uniqueSchema);

    const invokeUrl = `http://127.0.0.1:${simulator.invokePort}/${apiId}/dev/tags`;
    assert.equal((await fetch(invokeUrl, { method: "POST", headers: { "content-type": "application/json" }, body: '["a","b"]' })).status, 200);
    assert.equal((await fetch(invokeUrl, { method: "POST", headers: { "content-type": "application/json" }, body: '["a","a"]' })).status, 400);

    await assert.rejects(
      client.send(new TestInvokeMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", headers: { "content-type": "application/json" }, body: '["a","a"]' })),
      (error: any) => error.name === "BadRequestException" && /Invalid request body/.test(error.message),
    );

    const relaxed = JSON.stringify({ type: "array", uniqueItems: false, items: { type: "string" } });
    await client.send(new UpdateModelCommand({ restApiId: apiId, modelName: "UniqueTags", patchOperations: [{ op: "replace", path: "/schema", value: relaxed }] }));
    assert.equal((await fetch(invokeUrl, { method: "POST", headers: { "content-type": "application/json" }, body: '["a","a"]' })).status, 400, "existing deployment keeps the frozen uniqueItems schema");
    assert.equal((await client.send(new TestInvokeMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", headers: { "content-type": "application/json" }, body: '["a","a"]' }))).status, 200, "test invoke validates against live models after mutation");

    await client.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: "dev" }));
    assert.equal((await fetch(invokeUrl, { method: "POST", headers: { "content-type": "application/json" }, body: '["a","a"]' })).status, 200, "redeployment activates the relaxed schema");
    assert.equal((await client.send(new TestInvokeMethodCommand({ restApiId: apiId, resourceId: resource.id!, httpMethod: "POST", headers: { "content-type": "application/json" }, body: '["a","a"]' }))).status, 200, "test invoke follows live models after redeployment");
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
