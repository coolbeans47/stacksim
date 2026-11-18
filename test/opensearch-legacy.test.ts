import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { ElasticsearchServiceClient, CreateElasticsearchDomainCommand, DescribeElasticsearchDomainCommand, DescribeElasticsearchDomainConfigCommand, UpdateElasticsearchDomainConfigCommand, DeleteElasticsearchDomainCommand, ListElasticsearchVersionsCommand, AddTagsCommand, ListTagsCommand, CancelDomainConfigChangeCommand } from "@aws-sdk/client-elasticsearch-service";
import { OpenSearchClient, DescribeDomainCommand } from "@aws-sdk/client-opensearch";
import { StackSim } from "../src/server.js";

test("legacy and modern SDKs share domains, configuration, tags and deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-legacy-"));
  const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, authMode: "enforce", cdkBootstrap: false });
  let legacy: ElasticsearchServiceClient | undefined, modern: OpenSearchClient | undefined;
  try {
    await sim.start();
    const config = { endpoint: `http://127.0.0.1:${sim.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" }, maxAttempts: 1 };
    legacy = new ElasticsearchServiceClient(config); modern = new OpenSearchClient(config);
    assert.deepEqual((await legacy.send(new ListElasticsearchVersionsCommand({}))).ElasticsearchVersions, ["OpenSearch_2.19"]);
    await assert.rejects(legacy.send(new CreateElasticsearchDomainCommand({ DomainName: "old-engine", ElasticsearchVersion: "7.10" })), { name: "ValidationException" });
    const created = await legacy.send(new CreateElasticsearchDomainCommand({ DomainName: "legacy-search", ElasticsearchVersion: "OpenSearch_2.19", ElasticsearchClusterConfig: { InstanceCount: 1 } }));
    assert.equal(created.DomainStatus!.ElasticsearchVersion, "OpenSearch_2.19");
    let ready;
    for (let attempt = 0; attempt < 50; attempt++) { ready = (await modern.send(new DescribeDomainCommand({ DomainName: "legacy-search" }))).DomainStatus!; if (ready.Created) break; await delay(20); }
    assert.equal(ready!.Created, true);
    const described = (await legacy.send(new DescribeElasticsearchDomainCommand({ DomainName: "legacy-search" }))).DomainStatus!;
    assert.equal(described.ARN, ready!.ARN); assert.equal(described.Endpoint, ready!.Endpoint);
    await legacy.send(new UpdateElasticsearchDomainConfigCommand({ DomainName: "legacy-search", AdvancedOptions: { "rest.action.multi.allow_explicit_index": "false" } }));
    assert.equal((await modern.send(new DescribeDomainCommand({ DomainName: "legacy-search" }))).DomainStatus!.AdvancedOptions!["rest.action.multi.allow_explicit_index"], "false");
    const configRead = await legacy.send(new DescribeElasticsearchDomainConfigCommand({ DomainName: "legacy-search" }));
    assert.equal(configRead.DomainConfig!.ElasticsearchVersion!.Options, "OpenSearch_2.19");
    await legacy.send(new AddTagsCommand({ ARN: ready!.ARN, TagList: [{ Key: "owner", Value: "legacy" }] }));
    assert.deepEqual((await legacy.send(new ListTagsCommand({ ARN: ready!.ARN }))).TagList, [{ Key: "owner", Value: "legacy" }]);
    await legacy.send(new DeleteElasticsearchDomainCommand({ DomainName: "legacy-search" }));
    for (let attempt = 0; attempt < 50 && sim.opensearch.domains("eu-west-1").length; attempt++) await delay(20);
    await assert.rejects(modern.send(new DescribeDomainCommand({ DomainName: "legacy-search" })), { name: "ResourceNotFoundException" });
  } finally { legacy?.destroy(); modern?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test('legacy cancellation previews and cancels the shared asynchronous managed configuration change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-os-legacy-cancel-')), region = 'eu-west-1', sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: 'enforce', cdkBootstrap: false }); let legacy: ElasticsearchServiceClient | undefined;
  try {
    await sim.start(); legacy = new ElasticsearchServiceClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: 'admin', secretAccessKey: 'password' }, maxAttempts: 1 });
    await legacy.send(new CreateElasticsearchDomainCommand({ DomainName: 'legacy-cancel', ElasticsearchVersion: 'OpenSearch_2.19' })); for (let i = 0; i < 100 && sim.opensearch.domain(region, 'legacy-cancel').state !== 'active'; i++) await delay(10);
    const service = sim.opensearch as any, schedule = service.scheduleChange.bind(service); let resume = () => {}; service.scheduleChange = (domain: any, change: any) => { resume = () => schedule(domain, change); };
    try {
      await legacy.send(new UpdateElasticsearchDomainConfigCommand({ DomainName: 'legacy-cancel', EncryptionAtRestOptions: { Enabled: true } })); const domain = sim.opensearch.domain(region, 'legacy-cancel'), id = domain.changes!.at(-1)!.id;
      const preview = await legacy.send(new CancelDomainConfigChangeCommand({ DomainName: domain.name, DryRun: true })); assert.deepEqual(preview.CancelledChangeIds, [id]); assert.equal(preview.DryRun, true); assert.equal(domain.changes!.at(-1)!.state, 'PENDING');
      const cancelled = await legacy.send(new CancelDomainConfigChangeCommand({ DomainName: domain.name })); assert.deepEqual(cancelled.CancelledChangeIds, [id]); assert.equal(cancelled.CancelledChangeProperties![0].PropertyName, 'EncryptionAtRestOptions'); assert.equal(cancelled.DryRun, false); assert.equal(domain.changes!.at(-1)!.state, 'CANCELLED');
      await assert.rejects(legacy.send(new CancelDomainConfigChangeCommand({ DomainName: domain.name })), /No cancellable/); resume(); await delay(150); assert.equal(sim.opensearch.domain(region, domain.name).config.EncryptionAtRestOptions.Enabled, false);
    } finally { service.scheduleChange = schedule; resume(); }
  } finally { legacy?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
