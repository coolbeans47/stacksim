import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APIGatewayClient,
  CreateApiKeyCommand,
  CreateAuthorizerCommand,
  CreateDeploymentCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  CreateStageCommand,
  CreateUsagePlanCommand,
  CreateUsagePlanKeyCommand,
  DeleteApiKeyCommand,
  DeleteUsagePlanCommand,
  DeleteUsagePlanKeyCommand,
  GetApiKeyCommand,
  GetApiKeysCommand,
  GetResourcesCommand,
  GetTagsCommand,
  GetUsageCommand,
  GetUsagePlanCommand,
  GetUsagePlanKeyCommand,
  GetUsagePlanKeysCommand,
  GetUsagePlansCommand,
  ImportApiKeysCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
  TagResourceCommand,
  UpdateApiKeyCommand,
  UpdateRestApiCommand,
  UpdateUsageCommand,
  UpdateUsagePlanCommand,
} from "@aws-sdk/client-api-gateway";
import { CreateFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { TestClock } from "../src/core/clock.js";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("API Gateway API keys and usage plans support SDK CRUD, import, quotas, throttles, aggregation, rotation, and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-keys-")); const clock = new TestClock(Date.parse("2026-07-16T23:59:59.000Z")); let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); let client: APIGatewayClient | undefined;
  try {
    await simulator.start(); const connect = () => new APIGatewayClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }); client = connect();
    const api = await client.send(new CreateRestApiCommand({ name: "keyed-api" })); const rootResource = (await client.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!; const resource = await client.send(new CreateResourceCommand({ restApiId: api.id!, parentId: rootResource.id!, pathPart: "orders" }));
    await client.send(new PutMethodCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", authorizationType: "NONE", apiKeyRequired: true })); await client.send(new PutMethodResponseCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", statusCode: "200" })); await client.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } })); await client.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", statusCode: "200", responseTemplates: { "application/json": "{\"ok\":true}" } })); const deployment = await client.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" })); await client.send(new CreateStageCommand({ restApiId: api.id!, stageName: "beta", deploymentId: deployment.id! }));

    const generated = await client.send(new CreateApiKeyCommand({ name: "tutorial-client", description: "Generated key", enabled: true, tags: { team: "learning" } })); assert.match(generated.value ?? "", /^[A-Za-z0-9]{40}$/); assert.equal((await client.send(new GetApiKeyCommand({ apiKey: generated.id! }))).value, undefined); assert.equal((await client.send(new GetApiKeyCommand({ apiKey: generated.id!, includeValue: true }))).value, generated.value); assert.equal((await client.send(new GetApiKeysCommand({ includeValues: false, nameQuery: "tutorial" }))).items?.[0].value, undefined); assert.equal((await client.send(new GetApiKeysCommand({ includeValues: true, nameQuery: "tutorial" }))).items?.[0].value, generated.value);
    const keyArn = `arn:aws:apigateway:eu-west-1::/apikeys/${generated.id}`; await client.send(new TagResourceCommand({ resourceArn: keyArn, tags: { environment: "dev" } })); assert.deepEqual((await client.send(new GetTagsCommand({ resourceArn: keyArn }))).tags, { team: "learning", environment: "dev" });
    const disabled = await client.send(new CreateApiKeyCommand({ name: "disabled-client", value: "DISABLEDCLIENTKEY00001", enabled: false }));

    const invalidCsv = Buffer.from("name,key,description,enabled\nvalid,VALIDIMPORTKEY0000001,valid,true\nbad,short,bad,true\n"); const beforeImport = (await client.send(new GetApiKeysCommand({ limit: 500 }))).items?.length; await assert.rejects(client.send(new ImportApiKeysCommand({ body: invalidCsv, format: "csv", failOnWarnings: true })), (error: any) => error.name === "BadRequestException"); assert.equal((await client.send(new GetApiKeysCommand({ limit: 500 }))).items?.length, beforeImport, "failOnWarnings imports must roll back atomically");
    const imported = await client.send(new ImportApiKeysCommand({ body: Buffer.from("name,key,description,enabled\nimported-a,IMPORTEDCLIENTKEY0001,First,true\nimported-b,IMPORTEDCLIENTKEY0002,Second,false\n"), format: "csv" })); assert.equal(imported.ids?.length, 2); const importedPage = await client.send(new GetApiKeysCommand({ nameQuery: "imported", includeValues: true, limit: 1 })); assert.equal(importedPage.items?.length, 1); assert.ok(importedPage.position); assert.equal((await client.send(new GetApiKeysCommand({ nameQuery: "imported", includeValues: true, limit: 1, position: importedPage.position }))).items?.length, 1);

    const plan = await client.send(new CreateUsagePlanCommand({ name: "Developer plan", description: "Daily tutorial allowance", apiStages: [{ apiId: api.id!, stage: "dev" }], throttle: { burstLimit: 10, rateLimit: 10 }, quota: { limit: 2, period: "DAY" }, tags: { owner: "platform" } })); await client.send(new CreateUsagePlanKeyCommand({ usagePlanId: plan.id!, keyId: generated.id!, keyType: "API_KEY" })); await client.send(new CreateUsagePlanKeyCommand({ usagePlanId: plan.id!, keyId: disabled.id!, keyType: "API_KEY" })); assert.equal((await client.send(new GetUsagePlanKeyCommand({ usagePlanId: plan.id!, keyId: generated.id! }))).value, generated.value); assert.deepEqual((await client.send(new GetUsagePlanKeysCommand({ usagePlanId: plan.id!, nameQuery: "tutorial" }))).items?.map(key => key.id), [generated.id]); assert.deepEqual((await client.send(new GetUsagePlansCommand({ keyId: generated.id! }))).items?.map(value => value.id), [plan.id]); const planArn = `arn:aws:apigateway:eu-west-1::/usageplans/${plan.id}`; await client.send(new TagResourceCommand({ resourceArn: planArn, tags: { environment: "local" } })); assert.deepEqual((await client.send(new GetTagsCommand({ resourceArn: planArn }))).tags, { owner: "platform", environment: "local" });

    const invoke = `http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/orders`; assert.equal((await fetch(invoke)).status, 403); assert.equal((await fetch(invoke, { headers: { "x-api-key": "NOTAREALAPIKEYVALUE000" } })).status, 403); assert.equal((await fetch(invoke, { headers: { "x-api-key": disabled.value! } })).status, 403); assert.equal((await fetch(invoke, { headers: { "x-api-key": generated.value! } })).status, 200); assert.equal((await fetch(invoke, { headers: { "X-API-Key": generated.value! } })).status, 200); assert.equal((await fetch(invoke, { headers: { "x-api-key": generated.value! } })).status, 429);
    let usage = await client.send(new GetUsageCommand({ usagePlanId: plan.id!, keyId: generated.id!, startDate: "2026-07-16", endDate: "2026-07-16" })); assert.deepEqual(usage.items?.[generated.id!], [[2, 0]]); const extended = await client.send(new UpdateUsageCommand({ usagePlanId: plan.id!, keyId: generated.id!, patchOperations: [{ op: "replace", path: "/remaining", value: "1" }] })); assert.deepEqual(extended.items?.[generated.id!], [[2, 1]]); assert.equal((await fetch(invoke, { headers: { "x-api-key": generated.value! } })).status, 200); assert.equal((await fetch(invoke, { headers: { "x-api-key": generated.value! } })).status, 429);

    clock.advance(1_000); await client.send(new UpdateUsagePlanCommand({ usagePlanId: plan.id!, patchOperations: [{ op: "replace", path: "/throttle/burstLimit", value: "1" }, { op: "replace", path: "/throttle/rateLimit", value: "1" }] })); assert.equal((await fetch(invoke, { headers: { "x-api-key": generated.value! } })).status, 200); assert.equal((await fetch(invoke, { headers: { "x-api-key": generated.value! } })).status, 429); clock.advance(1_000); assert.equal((await fetch(invoke, { headers: { "x-api-key": generated.value! } })).status, 200); usage = await client.send(new GetUsageCommand({ usagePlanId: plan.id!, keyId: generated.id!, startDate: "2026-07-16", endDate: "2026-07-17" })); assert.deepEqual(usage.items?.[generated.id!], [[3, 0], [2, 0]], "daily quotas reset and usage remains grouped by key ID");

    const secondPlan = await client.send(new CreateUsagePlanCommand({ name: "Beta plan", apiStages: [{ apiId: api.id!, stage: "beta", throttle: { "/orders/GET": { burstLimit: 2, rateLimit: 2 } } }] })); await client.send(new CreateUsagePlanKeyCommand({ usagePlanId: secondPlan.id!, keyId: generated.id!, keyType: "API_KEY" })); const conflictingPlan = await client.send(new CreateUsagePlanCommand({ name: "Conflicting dev plan", apiStages: [{ apiId: api.id!, stage: "dev" }] })); await assert.rejects(client.send(new CreateUsagePlanKeyCommand({ usagePlanId: conflictingPlan.id!, keyId: generated.id!, keyType: "API_KEY" })), (error: any) => error.name === "ConflictException"); await client.send(new DeleteUsagePlanCommand({ usagePlanId: conflictingPlan.id! }));
    const importedKeyId = imported.ids![0]; await client.send(new CreateUsagePlanKeyCommand({ usagePlanId: secondPlan.id!, keyId: importedKeyId, keyType: "API_KEY" })); assert.equal((await client.send(new GetUsagePlanKeyCommand({ usagePlanId: secondPlan.id!, keyId: importedKeyId }))).id, importedKeyId); await client.send(new DeleteUsagePlanKeyCommand({ usagePlanId: secondPlan.id!, keyId: importedKeyId })); await assert.rejects(client.send(new GetUsagePlanKeyCommand({ usagePlanId: secondPlan.id!, keyId: importedKeyId })), (error: any) => error.name === "NotFoundException");

    const oldValue = generated.value!; const rotated = await client.send(new UpdateApiKeyCommand({ apiKey: generated.id!, patchOperations: [{ op: "replace", path: "/value", value: "ROTATEDCLIENTKEY000001" }, { op: "replace", path: "/description", value: "Rotated without rewriting usage" }] })); assert.equal(rotated.value, "ROTATEDCLIENTKEY000001"); const betaInvoke = `http://127.0.0.1:${simulator.invokePort}/${api.id}/beta/orders`; assert.equal((await fetch(betaInvoke, { headers: { "x-api-key": oldValue } })).status, 403); assert.equal((await fetch(betaInvoke, { headers: { "x-api-key": rotated.value! } })).status, 200); usage = await client.send(new GetUsageCommand({ usagePlanId: plan.id!, keyId: generated.id!, startDate: "2026-07-16", endDate: "2026-07-17" })); assert.deepEqual(usage.items?.[generated.id!], [[3, 0], [2, 0]]);

    client.destroy(); client = undefined; await simulator.stop(); simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", clock, authMode: "off"}); await simulator.start(); client = connect(); assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION); assert.equal((await client.send(new GetApiKeyCommand({ apiKey: generated.id!, includeValue: true }))).value, rotated.value); assert.equal((await client.send(new GetUsagePlanCommand({ usagePlanId: secondPlan.id! }))).apiStages?.[0].stage, "beta"); assert.equal((await fetch(`http://127.0.0.1:${simulator.invokePort}/${api.id}/beta/orders`, { headers: { "x-api-key": rotated.value! } })).status, 200);
    await client.send(new DeleteApiKeyCommand({ apiKey: imported.ids![1] })); await assert.rejects(client.send(new GetApiKeyCommand({ apiKey: imported.ids![1] })), (error: any) => error.name === "NotFoundException");
  } finally { client?.destroy(); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("API Gateway accepts authorizer-sourced usage identifiers from deployed API settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-apig-authorizer-key-")); const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off"}); const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start(); const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials }; const apigateway = new APIGatewayClient(options); const lambda = new LambdaClient(options); clients.push(apigateway, lambda); const key = await apigateway.send(new CreateApiKeyCommand({ name: "authorizer-client", value: "AUTHORIZERCLIENTKEY001", enabled: true })); const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip")); await lambda.send(new CreateFunctionCommand({ FunctionName: "usage-authorizer", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: "handler.authorizerHandler", Code: { ZipFile: zip }, Environment: { Variables: { USAGE_IDENTIFIER_KEY: key.value! } } }));
    const api = await apigateway.send(new CreateRestApiCommand({ name: "authorizer-key-source" })); await apigateway.send(new UpdateRestApiCommand({ restApiId: api.id!, patchOperations: [{ op: "replace", path: "/apiKeySource", value: "AUTHORIZER" }] })); const rootResource = (await apigateway.send(new GetResourcesCommand({ restApiId: api.id! }))).items!.find(resource => resource.path === "/")!; const resource = await apigateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: rootResource.id!, pathPart: "secured" })); const authorizer = await apigateway.send(new CreateAuthorizerCommand({ restApiId: api.id!, name: "usage", type: "TOKEN", authorizerUri: "arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-1:000000000000:function:usage-authorizer/invocations", identitySource: "method.request.header.Authorization", authorizerResultTtlInSeconds: 60 })); await apigateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", authorizationType: "CUSTOM", authorizerId: authorizer.id, apiKeyRequired: true })); await apigateway.send(new PutMethodResponseCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", statusCode: "200" })); await apigateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", type: "MOCK", requestTemplates: { "application/json": "{\"statusCode\":200}" } })); await apigateway.send(new PutIntegrationResponseCommand({ restApiId: api.id!, resourceId: resource.id!, httpMethod: "GET", statusCode: "200", responseTemplates: { "application/json": "{\"ok\":true}" } })); await apigateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" })); const plan = await apigateway.send(new CreateUsagePlanCommand({ name: "Authorizer plan", apiStages: [{ apiId: api.id!, stage: "dev" }] })); await apigateway.send(new CreateUsagePlanKeyCommand({ usagePlanId: plan.id!, keyId: key.id!, keyType: "API_KEY" })); const invoke = `http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/secured`; assert.equal((await fetch(invoke, { headers: { authorization: "allow" } })).status, 200); assert.equal((await fetch(invoke, { headers: { authorization: "allow", "x-api-key": "ignored-header-value" } })).status, 200); assert.equal((await fetch(invoke, { headers: { authorization: "deny" } })).status, 403); const usage = await apigateway.send(new GetUsageCommand({ usagePlanId: plan.id!, keyId: key.id!, startDate: new Date().toISOString().slice(0, 10), endDate: new Date().toISOString().slice(0, 10) })); assert.equal(usage.items?.[key.id!]?.[0][0], 2);
  } finally { clients.forEach(client => client.destroy()); await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
