import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OpenSearchServerlessClient, CreateCollectionCommand } from "@aws-sdk/client-opensearchserverless";
import { OSISClient, CreatePipelineCommand } from "@aws-sdk/client-osis";
import { ElasticsearchServiceClient, CreateElasticsearchDomainCommand } from "@aws-sdk/client-elasticsearch-service";
import { OpenSearchClient, StartMigrationCommand, GetMigrationCommand, ListMigrationsCommand } from "@aws-sdk/client-opensearch";
import { StackSim } from "../src/server.js";
import { resolveOperation, validateInput } from "../src/opensearch/protocol.js";
import { emptyState, CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { migrateState } from "../src/migrations/index.js";

test("OpenSearch migration preserves existing regional state and is idempotent", () => {
  const state = emptyState("000000000000", "eu-west-1") as any; state.schemaVersion = 89; delete state.accounts["000000000000"].regions["eu-west-1"].opensearch;
  const migrated = migrateState(state, "000000000000", "eu-west-1").state;
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(migrated.accounts["000000000000"].regions["eu-west-1"].opensearch, { domains: {}, retiredPorts: [] });
  assert.deepEqual(migrateState(migrated, "000000000000", "eu-west-1").state, migrated);
});

test("modeled routes reject unknown members, duplicate query parameters and invalid query values", () => {
  const req = (method: string) => ({ method, headers: {} }) as any;
  for (const path of ["/2021-01-01/tags?arn=test", "/2021-01-01/tags/?arn=test"]) assert.equal(resolveOperation(req("GET"), new URL(path, "http://localhost"))?.operation, "ListTags");
  assert.throws(() => resolveOperation(req("GET"), new URL("http://localhost/2021-01-01/opensearch/versions?maxResults=1&maxResults=2")), /Repeated/);
  assert.throws(() => resolveOperation(req("GET"), new URL("http://localhost/2021-01-01/opensearch/versions?ignored=true")), /Unknown/);
  const route = resolveOperation(req("POST"), new URL("http://localhost/2021-01-01/opensearch/domain"), { DomainName: "valid-domain", imaginary: true })!;
  assert.throws(() => validateInput(route), /unknown member/);
});

test("unsupported configurations across service families return official-client errors and leave no success-shaped resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-family-"));
  const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "enforce", cdkBootstrap: false });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await sim.start(); const config = { endpoint: `http://127.0.0.1:${sim.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    const aoss = new OpenSearchServerlessClient(config), osis = new OSISClient(config), legacy = new ElasticsearchServiceClient(config), managed = new OpenSearchClient(config); clients.push(aoss, osis, legacy, managed);
    // Saved-object migration is deliberately outside the developer simulator scope.
    for (const command of [new StartMigrationCommand({ applicationId: 'a'.repeat(24), migrationOptions: { source: { datasourceArn: 'arn:aws:es:eu-west-1:000000000000:domain/source' }, workspace: { createWorkspace: true, name: 'Unsupported', type: 'SEARCH' } } }), new GetMigrationCommand({ migrationId: '00000000-0000-4000-8000-000000000000' }), new ListMigrationsCommand({ applicationId: 'a'.repeat(24) })]) {
      await assert.rejects(managed.send(command as StartMigrationCommand), (error: any) => error.name === 'ValidationException' && error.$metadata.httpStatusCode === 400 && /not implemented|not supported/i.test(error.message));
    }
    await assert.rejects(aoss.send(new CreateCollectionCommand({ name: "unsupported-collection", type: "SEARCH" })), (error: any) => error.name === "ValidationException" && error.$metadata.httpStatusCode === 400 && Boolean(error.$metadata.requestId));
    await assert.rejects(osis.send(new CreatePipelineCommand({ PipelineName: "unsupported-pipeline", MinUnits: 1, MaxUnits: 1, PipelineConfigurationBody: 'version: "2"' })), { name: "ValidationException" });
    await assert.rejects(legacy.send(new CreateElasticsearchDomainCommand({ DomainName: "unsupported-domain" })), { name: "ValidationException" });
    const oversized = await fetch(`${config.endpoint}/2021-01-01/opensearch/domain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ DomainName: "oversized-domain", AccessPolicies: "x".repeat(10 * 1024 * 1024) }) });
    assert.equal(oversized.status, 413); assert.match(await oversized.text(), /10 MiB/);
    assert.equal(sim.opensearch.domains("eu-west-1").length, 0);
  } finally { clients.forEach(client => client.destroy()); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
