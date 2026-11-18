import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EmbeddedSearchEngine } from "../src/opensearch/engine.js";
import { SearchAccess } from "../src/opensearch/security.js";
import { StackSim } from "../src/server.js";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";

const transformations = { version: 1, processors: [
  { json: { field: "message", target_field: "parsed" } },
  { convert: { field: "parsed.status", type: "integer" } },
  { rename: { field: "parsed.customer", target_field: "customer" } },
  { trim: { field: "customer" } }, { lowercase: { field: "customer" } },
  { set: { field: "summary", value: "{{customer}}/{{parsed.status}}" } },
  { append: { field: "tags", value: ["processed", "processed"], allow_duplicates: false } },
  { remove: { field: ["message", "secret"], ignore_missing: true } },
] };
test("ingest pipelines persist, simulate and transform index/bulk/default/final writes atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ingest-pipeline-")), file = join(root, "engine.enc"), keyFile = join(root, "key");
  let engine = new EmbeddedSearchEngine(file, () => 1700000000000, { keyFile });
  const call = async (method: string, path: string, input?: any) => (await engine.request(method, path, Buffer.from(input === undefined ? "" : typeof input === "string" ? input : JSON.stringify(input)), "test")).body;
  try {
    await call("PUT", "/_ingest/pipeline/process", transformations);
    const original = { message: '{"status":"201","customer":" ALICE "}', secret: "private" };
    const simulation = await call("POST", "/_ingest/pipeline/process/_simulate", { docs: [{ _source: original }] });
    assert.deepEqual(simulation.docs[0].doc._source, { parsed: { status: 201 }, customer: "alice", summary: "alice/201", tags: ["processed"] }); assert.equal(engine.indexes().length, 0); assert.equal(original.secret, "private");
    const verbose = await call("POST", "/_ingest/pipeline/process/_simulate?verbose=true", { docs: [{ _source: original }, { _source: { message: "bad JSON" } }] });
    assert.equal(verbose.docs[0].processor_results.length, 8); assert.equal(verbose.docs[1].processor_results[0].status, "error");
    await call("PUT", "/_ingest/pipeline/final", { processors: [{ set: { field: "ingested_at", value: "{{_ingest.timestamp}}" } }] });
    await call("PUT", "/records", { settings: { default_pipeline: "process", final_pipeline: "final" }, mappings: { properties: { customer: { type: "keyword" } } } });
    await call("PUT", "/records/_doc/one?refresh=true", original);
    const found = await call("GET", "/records/_doc/one"); assert.equal(found._source.customer, "alice"); assert.equal(found._source.ingested_at, "2023-11-14T22:13:20.000Z");
    await call("PUT", "/records/_doc/bypass?pipeline=_none", { raw: true }); assert.equal((await call("GET", "/records/_doc/bypass"))._source.ingested_at, found._source.ingested_at);
    const bulk = await call("POST", "/records/_bulk?refresh=true", JSON.stringify({ index: { _id: "two" } }) + "\n" + JSON.stringify(original) + '\n{"index":{"_id":"bad"}}\n{"message":"bad JSON"}\n{"index":{"_id":"three","pipeline":"_none"}}\n{"raw":true}\n');
    assert.deepEqual(bulk.items.map((item: any) => item.index.status), [201, 400, 201]); assert.equal((await call("GET", "/records/_doc/bad")).found, false);
    const before = await call("GET", "/records/_mapping");
    await assert.rejects(call("PUT", "/records/_doc/one", { message: "bad" }), /JSON/); assert.deepEqual(await call("GET", "/records/_mapping"), before); assert.equal((await call("GET", "/records/_doc/one"))._version, 1);
    await assert.rejects(call("PUT", "/new-index/_doc/one?pipeline=missing", {}), /does not exist/); assert.ok(!engine.indexes().some(index => index.name === "new-index"));
    await assert.rejects(call("POST", "/records/_update/one", { doc: { raw: true } }), /Updates on indexes/);
    await call("PUT", "/_ingest/pipeline/drop", { processors: [{ drop: {} }] }); assert.equal((await call("PUT", "/records/_doc/dropped?pipeline=drop", original)).result, "noop"); assert.equal((await call("GET", "/records/_doc/dropped")).found, false);
    await assert.rejects(call("PUT", "/_ingest/pipeline/process?if_version=0", transformations), { status: 409 });
    await call("PUT", "/_ingest/pipeline/process?if_version=1", transformations); assert.equal((await call("GET", "/_ingest/pipeline/process")).process.version, 2);
    engine.close(); engine = new EmbeddedSearchEngine(file, () => 1700000000000, { keyFile });
    await call("PUT", "/records/_doc/restarted", original); assert.equal((await call("GET", "/records/_doc/restarted"))._source.customer, "alice");
    const snapshot = engine.exportSnapshot({}); assert.equal(snapshot.pipelines?.length, 3);
    const restored = new EmbeddedSearchEngine(join(root, "restored.sqlite"));
    try { restored.restoreSnapshot(snapshot, { include_global_state: true }); await restored.request("PUT", "/records/_doc/restored", Buffer.from(JSON.stringify(original)), "test"); assert.equal((await restored.request("GET", "/records/_doc/restored", Buffer.alloc(0), "test")).body._source.customer, "alice"); } finally { restored.close(); }
    await call("DELETE", "/_ingest/pipeline/process"); await assert.rejects(call("PUT", "/records/_doc/missing", original), /does not exist/);
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("ingest validation, failure handlers, nesting, RE2 and FGAC stay bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ingest-safe-")), engine = new EmbeddedSearchEngine(join(root, "engine.sqlite"));
  const call = async (method: string, path: string, body: any = {}, access?: SearchAccess) => (await engine.request(method, path, Buffer.from(JSON.stringify(body)), "test", true, access)).body;
  try {
    for (const processor of [{ script: { source: "return true" } }, { set: { field: "__proto__.polluted", value: 1 } }, { set: { field: "_index", value: "private" } }, { set: { field: "x", value: "{{#if}}bad{{/if}}" } }, { set: { field: "x", value: 1, if: "true" } }, { gsub: { field: "x", pattern: "(x)\\1", replacement: "x" } }]) await assert.rejects(call("PUT", "/_ingest/pipeline/unsafe", { processors: [processor] }));
    assert.deepEqual(await call("GET", "/_ingest/pipeline"), {});
    const sample = { processors: [{ uppercase: { field: "x" } }, { gsub: { field: "x", pattern: "[A-Z]+", replacement: "word" } }, { split: { field: "x", separator: "," } }, { join: { field: "x", separator: "/" } }, { convert: { field: "number", type: "long" } }, { convert: { field: "flag", type: "boolean" } }] };
    const simulated = await call("POST", "/_ingest/pipeline/_simulate", { pipeline: sample, docs: [{ _source: { x: "a,b", number: "12", flag: "true" } }] }); assert.deepEqual(simulated.docs[0].doc._source, { x: "word/word", number: 12, flag: true });
    const recovery = { processors: [{ fail: { message: "expected failure", tag: "stop", on_failure: [{ set: { field: "error", value: "{{_ingest.on_failure_message}}" } }] } }, { set: { field: "continued", value: true } }] };
    assert.equal((await call("POST", "/_ingest/pipeline/_simulate", { pipeline: recovery, docs: [{ _source: {} }] })).docs[0].doc._source.error, "expected failure");
    await call("PUT", "/_ingest/pipeline/cycle", { processors: [{ pipeline: { name: "cycle" } }] });
    assert.match((await call("POST", "/_ingest/pipeline/cycle/_simulate", { docs: [{ _source: {} }] })).docs[0].error.reason, /depth/);
    await assert.rejects(call("PUT", "/_ingest/pipeline/too-many", { processors: Array.from({ length: 65 }, () => ({ drop: {} })) }), /64/);
    const reader = new SearchAccess({ name: "reader", backendRoles: [] }, false, [{ cluster_permissions: [], index_permissions: [{ index_patterns: ["*"], allowed_actions: ["read"] }] }], "1");
    await assert.rejects(call("GET", "/_ingest/pipeline", {}, reader), { status: 403 });
    const manager = new SearchAccess({ name: "manager", backendRoles: [] }, false, [{ cluster_permissions: ["cluster_manage_pipelines"], index_permissions: [] }], "1");
    await call("PUT", "/_ingest/pipeline/managed", { processors: [] }, manager); assert.ok((await call("GET", "/_ingest/pipeline", {}, manager)).managed);
    await assert.rejects(call("PUT", "/denied/_doc/one?pipeline=managed", {}, manager), { status: 403 });
    const writer = new SearchAccess({ name: "writer", backendRoles: [] }, false, [{ cluster_permissions: [], index_permissions: [{ index_patterns: ["allowed"], allowed_actions: ["write", "create_index"] }] }], "1");
    await call("PUT", "/allowed/_doc/one?pipeline=managed", {}, writer);
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("official OpenSearch ingest client CRUD and simulation transform real domain writes", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ingest-client-")), region = "eu-west-1", sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false }); let client: Client | undefined;
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "ingest-client" }, region);
    for (let i = 0; i < 200 && sim.opensearch.domain(region, "ingest-client").state !== "active"; i++) await delay(10);
    const domain = sim.opensearch.domain(region, "ingest-client"); client = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: "admin", secretAccessKey: "password" }) }) });
    await client.ingest.putPipeline({ id: "normalize", body: { processors: [{ lowercase: { field: "name" } }] } });
    assert.ok((await client.ingest.getPipeline({ id: "normalize" })).body.normalize);
    const simulated = await client.ingest.simulate({ id: "normalize", body: { docs: [{ _index: "records", _id: "one", _source: { name: "ALICE" } }] } }); assert.equal((simulated.body.docs![0] as any).doc._source.name, "alice");
    await client.index({ index: "records", id: "one", pipeline: "normalize", body: { name: "ALICE" }, refresh: true }); assert.equal((await client.get({ index: "records", id: "one" })).body._source.name, "alice");
    await client.ingest.deletePipeline({ id: "normalize" }); await assert.rejects(client.ingest.getPipeline({ id: "normalize" }), (error: any) => error.statusCode === 404);
  } finally { await client?.close(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
