import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import * as OpenSearch from "@aws-sdk/client-opensearch";
import * as Iam from "@aws-sdk/client-iam";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { StackSim } from "../src/server.js";

const region = "eu-west-1", credentials = { accessKeyId: "admin", secretAccessKey: "password" };
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> { for (let i = 0; i < 200; i++) { const value = await read(); if (check(value)) return value; await delay(10); } throw new Error("Maintenance timed out"); }

test("official maintenance operations reopen storage and endpoint, preserve data, drain admission and persist bounded history", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-maintenance-")); let sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, cdkBootstrap: false, authMode: "enforce" });
  let control: OpenSearch.OpenSearchClient | undefined, search: Client | undefined;
  try {
    await sim.start(); const sdk = () => ({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }); control = new OpenSearch.OpenSearchClient(sdk());
    await control.send(new OpenSearch.CreateDomainCommand({ DomainName: "maintenance-domain", EncryptionAtRestOptions: { Enabled: true } }));
    const domain = await until(async () => sim.opensearch.domain(region, "maintenance-domain"), domain => domain.state === "active"), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
    search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => credentials }) });
    await search.index({ index: "records", id: "one", refresh: true, body: { value: "preserved" } });
    const pit = (await search.transport.request({ method: "POST", path: "/records/_search/point_in_time?keep_alive=5m" })).body.pit_id;
    const nodes = await control.send(new OpenSearch.DescribeDomainNodesCommand({ DomainName: domain.name })); assert.equal(nodes.DomainNodesStatusList![0].NodeId, domain.generation); assert.equal(nodes.DomainNodesStatusList![0].NodeStatus, "Active");
    const release = (sim.opensearch as any).admitRequest(domain), engineBefore = (sim.opensearch as any).engine(domain);
    let id: string;
    try {
      id = (await control.send(new OpenSearch.StartDomainMaintenanceCommand({ DomainName: domain.name, Action: "RESTART_SEARCH_PROCESS", NodeId: domain.generation }))).MaintenanceId!;
      await until(async () => control!.send(new OpenSearch.GetDomainMaintenanceStatusCommand({ DomainName: domain.name, MaintenanceId: id })), result => result.Status === "IN_PROGRESS");
      assert.equal((await control.send(new OpenSearch.DescribeDomainCommand({ DomainName: domain.name }))).DomainStatus!.Processing, true);
      assert.equal((await control.send(new OpenSearch.DescribeDomainNodesCommand({ DomainName: domain.name }))).DomainNodesStatusList![0].NodeStatus, "NotAvailable");
      assert.equal((await control.send(new OpenSearch.DescribeDomainHealthCommand({ DomainName: domain.name }))).ClusterHealth, "NotAvailable");
      await assert.rejects(search.get({ index: "records", id: "one" }), (error: any) => error.statusCode === 503);
      await assert.rejects(control.send(new OpenSearch.StartDomainMaintenanceCommand({ DomainName: domain.name, Action: "REBOOT_NODE" })), { name: "ValidationException" });
      await assert.rejects(control.send(new OpenSearch.UpdateDomainConfigCommand({ DomainName: domain.name, AdvancedOptions: { "rest.action.multi.allow_explicit_index": "false" } })), { name: "ValidationException" });
      await assert.rejects(control.send(new OpenSearch.DeleteDomainCommand({ DomainName: domain.name })), { name: "ValidationException" });
    } finally { release(); }
    const completed = await until(async () => control!.send(new OpenSearch.GetDomainMaintenanceStatusCommand({ DomainName: domain.name, MaintenanceId: id! })), result => result.Status === "COMPLETED");
    assert.ok(completed.CreatedAt instanceof Date); assert.ok(completed.UpdatedAt instanceof Date); assert.notEqual((sim.opensearch as any).engine(domain), engineBefore);
    assert.equal((await search.get({ index: "records", id: "one" })).body._source.value, "preserved");
    await assert.rejects(search.search({ body: { pit: { id: pit } } }), (error: any) => error.statusCode === 404);
    const second = (await control.send(new OpenSearch.StartDomainMaintenanceCommand({ DomainName: domain.name, Action: "REBOOT_NODE" }))).MaintenanceId!;
    await until(async () => control!.send(new OpenSearch.GetDomainMaintenanceStatusCommand({ DomainName: domain.name, MaintenanceId: second })), value => value.Status === "COMPLETED");
    assert.equal((await search.get({ index: "records", id: "one" })).body._source.value, "preserved");
    assert.equal((await control.send(new OpenSearch.DescribeDomainCommand({ DomainName: domain.name }))).DomainStatus!.Endpoint, `127.0.0.1:${domain.gatewayPort}`);
    await assert.rejects(control.send(new OpenSearch.StartDomainMaintenanceCommand({ DomainName: domain.name, Action: "RESTART_DASHBOARD" })), { name: "DisabledOperationException" });
    await assert.rejects(control.send(new OpenSearch.StartDomainMaintenanceCommand({ DomainName: domain.name, Action: "REBOOT_NODE", NodeId: "different-node-id" })), { name: "ResourceNotFoundException" });
    const page = await control.send(new OpenSearch.ListDomainMaintenancesCommand({ DomainName: domain.name, MaxResults: 1 })); assert.equal(page.DomainMaintenances!.length, 1); assert.ok(page.NextToken);
    assert.equal((await control.send(new OpenSearch.ListDomainMaintenancesCommand({ DomainName: domain.name, MaxResults: 1, NextToken: page.NextToken }))).DomainMaintenances![0].MaintenanceId, id!);
    await assert.rejects(control.send(new OpenSearch.ListDomainMaintenancesCommand({ DomainName: domain.name, MaxResults: 1, NextToken: page.NextToken! + "x" })), { name: "ValidationException" });
    assert.equal((await control.send(new OpenSearch.ListDomainMaintenancesCommand({ DomainName: domain.name, Action: "REBOOT_NODE", Status: "COMPLETED" }))).DomainMaintenances!.length, 1);
    await search.close(); search = undefined; control.destroy(); await sim.stop();
    sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, cdkBootstrap: false, authMode: "enforce" }); await sim.start(); control = new OpenSearch.OpenSearchClient(sdk());
    assert.equal((await control.send(new OpenSearch.ListDomainMaintenancesCommand({ DomainName: domain.name }))).DomainMaintenances!.length, 2);
  } finally { await search?.close(); control?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("maintenance IAM denial and failed intent publication leave no queued job", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-maintenance-deny-")), sim = new StackSim({ dataDir: root, port: 0, invokePort: 0, cdkBootstrap: false, authMode: "enforce" });
  let iam: Iam.IAMClient | undefined, denied: OpenSearch.OpenSearchClient | undefined;
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; iam = new Iam.IAMClient(sdk);
    await sim.opensearch.execute("CreateDomain", { DomainName: "maintenance-denied" }, region); const domain = await until(async () => sim.opensearch.domain(region, "maintenance-denied"), value => value.state === "active");
    await iam.send(new Iam.CreateUserCommand({ UserName: "reader" })); const key = (await iam.send(new Iam.CreateAccessKeyCommand({ UserName: "reader" }))).AccessKey!;
    denied = new OpenSearch.OpenSearchClient({ ...sdk, credentials: { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! } });
    await assert.rejects(denied.send(new OpenSearch.StartDomainMaintenanceCommand({ DomainName: domain.name, Action: "REBOOT_NODE" })), { name: "AccessDeniedException" });
    assert.equal(domain.maintenances, undefined);
    const save = sim.store.save.bind(sim.store); sim.store.save = async () => { if (domain.maintenances?.length) throw new Error("Injected intent write failure"); await save(); };
    await assert.rejects(sim.opensearch.execute("StartDomainMaintenance", { DomainName: domain.name, Action: "REBOOT_NODE" }, region), /Injected/); sim.store.save = save;
    assert.equal(domain.maintenances, undefined); assert.equal(domain.state, "active");
  } finally { iam?.destroy(); denied?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
