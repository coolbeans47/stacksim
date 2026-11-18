import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StackSim } from "../src/server.js";
import { createOpenSearchServerlessIndexProviders } from "../src/cloudformation/providers/opensearchserverless-index.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";

test("Serverless index providers enforce ownership across external deletion/recreation and reject unknown endpoints", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-aoss-index-owner-")), region = "eu-west-1";
  const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false });
  try {
    await sim.start(); const service = sim.opensearch.serverless, account = sim.store.accountId, user = sim.store.ensureAccount().iam.users.admin;
    const context: ProviderContext = { accountId: account, region, partition: "aws", stackId: `arn:aws:cloudformation:${region}:${account}:stack/index-owner/test`, logicalId: "Index", operationId: "create", resourceOperationId: "create-index", idempotencyKey: "owned-index", deadlineAt: Date.now() + 30000, principal: { identity: { accountId: account, principalArn: user.arn, principalId: user.userId, userId: user.userId, userName: "admin", accessKeyId: "admin", principalType: "user" } } };
    await service.execute("CreateSecurityPolicy", { name: "enc", type: "encryption", policy: JSON.stringify({ Rules: [{ ResourceType: "collection", Resource: ["collection/owned-index"] }], AWSOwnedKey: true }) }, region);
    await service.execute("CreateSecurityPolicy", { name: "net", type: "network", policy: JSON.stringify([{ Rules: [{ ResourceType: "collection", Resource: ["collection/owned-index"] }], AllowFromPublic: true }]) }, region);
    const created = await service.execute("CreateCollection", { name: "owned-index", type: "SEARCH" }, region), id = created.createCollectionDetail.id;
    for (let i = 0; i < 100 && service.collection(region, id).status !== "ACTIVE"; i++) await delay(10);
    const target = service.collection(region, id), endpoint = `https://127.0.0.1:${target.gatewayPort}`;
    const [provider, management] = createOpenSearchServerlessIndexProviders(service, region);
    const model = provider.canonicalize({ CollectionEndpoint: endpoint, IndexName: "owned", Mappings: { Properties: { title: { Type: "text" } } } }, context);
    assert.equal((await provider.create(model, context)).status, "FAILED", "IAM administration cannot bypass missing data access");
    await service.execute("CreateAccessPolicy", { name: "data", type: "data", policy: JSON.stringify([{ Principal: [user.arn], Rules: [{ ResourceType: "index", Resource: ["index/owned-index/*"], Permission: ["aoss:*"] }] }]) }, region);
    const result = await provider.create(model, context); assert.equal(result.status, "SUCCESS"); if (result.status !== "SUCCESS") throw new Error("Index did not create");
    const uuid = result.model.attributes.Uuid;
    assert.equal((await provider.create(model, context)).status, "SUCCESS", "owned retry is idempotent");
    assert.equal((await provider.delete(result.physicalId, model, { ...context, stackId: "another-stack" })).status, "FAILED");
    const invalidEndpoint = { ...model, CollectionEndpoint: "https://127.0.0.1:65001" };
    assert.equal((await provider.create(invalidEndpoint, context)).status, "FAILED");
    await service.execute("DeleteIndex", { id, indexName: "owned" }, region, account, context.principal.identity);
    assert.equal((await provider.read(result.physicalId, context)).status, "NOT_FOUND");
    await service.execute("CreateIndex", { id, indexName: "owned", indexSchema: {} }, region, account, context.principal.identity);
    assert.equal((await provider.delete(result.physicalId, model, context)).status, "FAILED", "a recreated index cannot be deleted through stale ownership");
    assert.equal((await provider.read(result.physicalId, context)).status, "FAILED");
    assert.ok(uuid);
    await assert.rejects(service.execute("CreateIndex", { id, indexName: "unsupported-logs", indexSchema: { settings: { "index.search.slowlog.threshold.query.warn": "0ms" } } }, region, account, context.principal.identity), /[Ss]low log|settings/);
    assert.ok(provider.validate({ CollectionEndpoint: endpoint, IndexName: "invalid", Settings: { Index: { RefreshInterval: "1s" } } }, context).length);
    assert.ok(provider.validate({ CollectionEndpoint: endpoint, IndexName: "invalid", Mappings: { Properties: { data: { Type: "keyword", InventedFlag: true } } } }, context).length);
    assert.ok(management.validate({ Id: id, IndexName: "invalid", IndexSchema: "{" }, context).length);
    const managed = management.canonicalize({ Id: id, IndexName: "retained" }, context), retained = await management.create(managed, context);
    assert.equal(retained.status, "SUCCESS"); if (retained.status !== "SUCCESS") throw new Error("Managed index did not create");
    await management.retain!(retained.physicalId, managed, context);
    assert.equal((await management.delete(retained.physicalId, managed, context)).status, "FAILED");
    assert.ok((await service.execute("GetIndex", { id, indexName: "retained" }, region, account, context.principal.identity)).indexSchema);
  } finally { await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
