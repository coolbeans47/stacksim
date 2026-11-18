import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { StateStore } from "../src/state.js";
import { TestClock } from "../src/core/clock.js";
import { AutomaticSearchBackups, AUTOMATIC_INTERVAL, AUTOMATIC_RETENTION } from "../src/opensearch/automatic-backups.js";
import { EmbeddedSearchEngine } from "../src/opensearch/engine.js";
import type { DomainRecord } from "../src/opensearch/model.js";
import { StackSim } from "../src/server.js";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";

test("automatic backups capture committed data, encrypt copies, roll back failed publication and expire while a domain is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-auto-backup-")), store = new StateStore(root), clock = new TestClock(0), engine = new EmbeddedSearchEngine(join(root, "search.db"), () => clock.now());
  const domain: DomainRecord = { name: "automatic", arn: "arn:aws:es:eu-west-1:000000000000:domain/automatic", accountId: "000000000000", region: "eu-west-1", generation: "generation", config: { EncryptionAtRestOptions: { Enabled: false } }, createdAt: 0, updatedAt: 0, state: "active", tags: {}, revision: 1, gatewayPort: 0 };
  let admitted = 0, available = true; const backups = new AutomaticSearchBackups(store, clock, { all: () => [domain], engine: () => engine, admit: () => { admitted++; return () => { admitted--; }; }, available: () => available });
  try {
    await store.load(); store.regionState(domain.region).opensearch.domains[domain.name] = domain; await backups.start();
    await engine.request("PUT", "/products/_doc/one", Buffer.from('{"title":"private-automatic-source"}'), "admin");
    clock.advance(AUTOMATIC_INTERVAL); await backups.drain(); assert.equal(domain.automaticBackups!.items.length, 1); assert.equal(admitted, 0);
    const repository = backups.repositories(domain)[0], objects = backups.objects(domain, repository), key = (await objects.list("stacksim-snapshots-v1/"))[0], snapshot = JSON.parse(gunzipSync(await objects.read(key)).toString()); assert.equal(snapshot.data.indexes[0].documents[0].source.title, "private-automatic-source"); assert.equal(snapshot.snapshot.state, "SUCCESS");
    assert.equal(JSON.stringify(domain.automaticBackups).includes("private-automatic-source"), false); for (const file of await readdir(join(root, "secrets", "opensearch-backups-materials"))) assert.equal((await readFile(join(root, "secrets", "opensearch-backups-materials", file))).includes(Buffer.from("private-automatic-source")), false);
    const save = store.save.bind(store); let failed = false; store.save = async () => { if (!failed && domain.automaticBackups!.items.length === 2) { failed = true; throw new Error("Injected automatic publication failure"); } await save(); };
    clock.advance(AUTOMATIC_INTERVAL); await backups.drain(); assert.equal(domain.automaticBackups!.items.length, 1); assert.match(domain.automaticBackups!.failure!.message, /storage operation failed/); assert.equal((await readdir(join(root, "secrets", "opensearch-backups-materials"))).length, 1);
    clock.advance(60000); await backups.drain(); assert.equal(domain.automaticBackups!.items.length, 2); assert.equal(domain.automaticBackups!.failure, undefined);
    available = false; clock.advance(AUTOMATIC_RETENTION + AUTOMATIC_INTERVAL); await backups.drain(); assert.equal(domain.automaticBackups!.items.length, 0); assert.match(domain.automaticBackups!.failure!.message, /unavailable/); assert.equal((await readdir(join(root, "secrets", "opensearch-backups-materials"))).length, 0);
    available = true; clock.advance(60000); await backups.drain(); assert.equal(domain.automaticBackups!.items.length, 1); assert.equal(domain.automaticBackups!.failure, undefined); await backups.removeDomain(domain); assert.equal((await readdir(join(root, "secrets", "opensearch-backups-materials"))).length, 0);
  } finally { await backups.stop(); engine.close(); await store.flush(); await rm(root, { recursive: true, force: true }); }
});

test("official snapshot client lists, verifies and restores hourly backups through restart with read-only and FGAC gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-auto-sdk-")), region = "eu-west-1", clock = new TestClock(Date.now()), options = { dataDir: root, region, port: 0, invokePort: 0, clock, cdkBootstrap: false, authMode: "enforce" as const };
  let sim = new StackSim(options), client: Client | undefined;
  const open = async () => new Client({ node: `https://127.0.0.1:${sim.opensearch.domain(region, "automatic-sdk").gatewayPort}`, headers: { "x-amz-date": new Date(clock.now()).toISOString().replace(/[:-]|\.\d{3}/g, "") }, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, maxRetries: 0, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: "admin", secretAccessKey: "password" }) }) });
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "automatic-sdk", EncryptionAtRestOptions: { Enabled: true }, NodeToNodeEncryptionOptions: { Enabled: true }, AdvancedSecurityOptions: { Enabled: true, MasterUserOptions: { MasterUserARN: "arn:aws:iam::000000000000:user/admin" } } }, region);
    for (let i = 0; i < 200 && sim.opensearch.domain(region, "automatic-sdk").state !== "active"; i++) await delay(10); client = await open();
    assert.deepEqual((await client.snapshot.getRepository({})).body["cs-automated-enc"], { type: "stacksim-automatic", settings: { readonly: true } });
    await client.index({ index: "records", id: "one", body: { title: "hourly backup" } }); await client.close(); client = undefined;
    clock.advance(AUTOMATIC_INTERVAL); await (sim.opensearch as any).automaticBackups.drain(); client = await open();
    const list = (await client.snapshot.get({ repository: "cs-automated-enc", snapshot: "_all" })).body.snapshots; assert.equal(list.length, 1); assert.equal(list[0].state, "SUCCESS"); const name = list[0].snapshot!;
    assert.equal((await client.snapshot.status({ repository: "cs-automated-enc", snapshot: name })).body.snapshots[0].state, "SUCCESS"); assert.ok((await client.snapshot.verifyRepository({ repository: "cs-automated-enc" })).body.nodes);
    for (const work of [() => client!.snapshot.delete({ repository: "cs-automated-enc", snapshot: name }), () => client!.snapshot.deleteRepository({ repository: "cs-automated-enc" }), () => client!.snapshot.create({ repository: "cs-automated-enc", snapshot: "manual" })]) await assert.rejects(work(), (error: any) => error.statusCode === 403);
    await client.snapshot.restore({ repository: "cs-automated-enc", snapshot: name, wait_for_completion: true, body: { rename_pattern: "(.+)", rename_replacement: "restored-$1", include_aliases: false } }); assert.equal((await client.get({ index: "restored-records", id: "one" })).body._source.title, "hourly backup");
    const domain = sim.opensearch.domain(region, "automatic-sdk"), engine = (sim.opensearch as any).engine(domain) as EmbeddedSearchEngine;
    const denied = engine.security.access({ name: "no-backup-grant", backendRoles: [] }); await assert.rejects((sim.opensearch as any).snapshots.request(domain, {}, "GET", "/_snapshot/cs-automated-enc/_all", Buffer.alloc(0), denied), (error: any) => error.status === 403);
    await client.close(); client = undefined; await sim.stop(); sim = new StackSim(options); await sim.start(); client = await open(); assert.equal((await client.snapshot.get({ repository: "cs-automated-enc", snapshot: name })).body.snapshots[0].snapshot, name);
    await client.snapshot.restore({ repository: "cs-automated-enc", snapshot: name, wait_for_completion: true, body: { rename_pattern: "(.+)", rename_replacement: "again-$1" } }); assert.equal((await client.get({ index: "again-records", id: "one" })).body._source.title, "hourly backup");
    await client.close(); client = undefined; await sim.opensearch.execute("DeleteDomain", { DomainName: "automatic-sdk" }, region); for (let i = 0; i < 200 && sim.opensearch.domains(region).length; i++) await delay(10); assert.equal(sim.opensearch.domains(region).length, 0); assert.equal((await readdir(join(root, "secrets", "opensearch-backups-materials"))).length, 0);
  } finally { await client?.close(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test("missing automatic backup keys leave live search available and prevent restoration from unverified material", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-auto-key-loss-")), region = "eu-west-1", clock = new TestClock(Date.now() - AUTOMATIC_INTERVAL), options = { dataDir: root, region, port: 0, invokePort: 0, clock, cdkBootstrap: false, authMode: "enforce" as const };
  let sim = new StackSim(options), client: Client | undefined;
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "backup-key-loss", EncryptionAtRestOptions: { Enabled: true } }, region); for (let i = 0; i < 200 && sim.opensearch.domain(region, "backup-key-loss").state !== "active"; i++) await delay(10);
    await (sim.opensearch as any).engine(sim.opensearch.domain(region, "backup-key-loss")).request("PUT", "/records/_doc/one", Buffer.from('{"title":"live-search-survives"}'), "seed"); clock.advance(AUTOMATIC_INTERVAL); await (sim.opensearch as any).automaticBackups.drain(); assert.equal(sim.opensearch.domain(region, "backup-key-loss").automaticBackups!.items.length, 1); await sim.stop();
    await rm(join(root, "secrets", "opensearch-backups.key")); sim = new StackSim(options); await sim.start(); const domain = sim.opensearch.domain(region, "backup-key-loss"); assert.equal(domain.state, "active"); assert.match(domain.automaticBackups!.failure!.message, /backup storage is unavailable/);
    client = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, maxRetries: 0, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: "admin", secretAccessKey: "password" }) }) }); assert.equal((await client.get({ index: "records", id: "one" })).body._source.title, "live-search-survives");
    await assert.rejects(client.snapshot.restore({ repository: "cs-automated-enc", snapshot: domain.automaticBackups!.items[0].name, wait_for_completion: true, body: { rename_pattern: "(.+)", rename_replacement: "restored-$1" } }), (error: any) => error.statusCode === 503); assert.equal((await client.indices.exists({ index: "restored-records" })).body, false);
  } finally { await client?.close(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
