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

const definition = (normalization = "min_max", combination = "arithmetic_mean", weights = [0.4, 0.6]) => ({ version: 1, phase_results_processors: [{ "normalization-processor": { normalization: { technique: normalization }, combination: { technique: combination, parameters: { weights } } } }] });
const mapping = { properties: { title: { type: "text" }, vector: { type: "knn_vector", dimension: 2 }, tenant: { type: "keyword" }, price: { type: "integer" } } };
const hybrid = { hybrid: { queries: [{ term: { tenant: "a" } }, { knn: { vector: { vector: [1, 0], k: 3 } } }] } };
const closeTo = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("hybrid search combines lexical/vector scores, bounded candidates, defaults, snapshots and encrypted restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-hybrid-")), file = join(root, "search.enc"), keyFile = join(root, "key"); let engine = new EmbeddedSearchEngine(file, Date.now, { keyFile });
  const call = async (method: string, path: string, body: any = {}) => (await engine.request(method, path, Buffer.from(JSON.stringify(body)), "admin")).body;
  try {
    await call("PUT", "/_search/pipeline/blend", definition());
    await call("PUT", "/products", { mappings: mapping, settings: { knn: true, "search.default_pipeline": "blend" } });
    for (const [id, vector, tenant, price] of [["a", [1, 0], "a", 10], ["b", [0, 1], "a", 20], ["c", [0, 0], "b", 30]]) await call("PUT", `/products/_doc/${id}?refresh=true`, { vector, tenant, price, title: id });
    const result = await call("POST", "/products/_search", { query: hybrid, size: 3, aggs: { cost: { sum: { field: "price" } } } });
    assert.deepEqual(result.hits.hits.map((hit: any) => hit._id), ["a", "b", "c"]); closeTo(result.hits.hits[0]._score, 1); closeTo(result.hits.hits[1]._score, 0.4006); closeTo(result.hits.hits[2]._score, 0.15); assert.equal(result.aggregations.cost.value, 60);
    const pagedQuery = { hybrid: { ...hybrid.hybrid, pagination_depth: 3 } };
    assert.equal((await call("POST", "/products/_search", { query: pagedQuery, from: 1, size: 1 })).hits.hits[0]._id, "b");
    const shallow = await call("POST", "/products/_search", { query: hybrid, size: 1, aggs: { cost: { sum: { field: "price" } } } }); assert.equal(shallow.hits.hits.length, 1); assert.equal(shallow.hits.total.value, 3); assert.equal(shallow.aggregations.cost.value, 60);
    const filtered = await call("POST", "/products/_search", { query: hybrid, post_filter: { term: { tenant: "b" } }, size: 3 }); assert.equal(filtered.hits.hits[0]._id, "c"); closeTo(filtered.hits.hits[0]._score, 0.15);
    const inline = await call("POST", "/products/_search", { query: hybrid, search_pipeline: definition("l2"), size: 3 });
    closeTo(inline.hits.hits.find((hit: any) => hit._id === "a")._score, 0.4 / Math.sqrt(2) + 0.6 / Math.sqrt(1 + 1 / 9 + 1 / 4));
    for (const technique of ["geometric_mean", "harmonic_mean"]) { const found = await call("POST", "/products/_search", { query: hybrid, search_pipeline: definition("min_max", technique), size: 3 }); closeTo(found.hits.hits.find((hit: any) => hit._id === "c")._score, 0.25); }
    assert.equal((await call("POST", "/products/_search?search_pipeline=_none", { query: { match_all: {} } })).hits.total.value, 3);
    await assert.rejects(call("POST", "/products/_search?search_pipeline=_none", { query: hybrid }), /require a normalization/);
    const snapshot = engine.exportSnapshot({}); assert.equal(snapshot.searchPipelines![0].name, "blend");
    await call("DELETE", "/_search/pipeline/blend"); await assert.rejects(call("POST", "/products/_search", { query: hybrid }), { status: 404 });
    engine.restoreSnapshot(snapshot, { rename_pattern: "products", rename_replacement: "restored", include_global_state: true });
    engine.close(); engine = new EmbeddedSearchEngine(file, Date.now, { keyFile });
    assert.equal((await call("POST", "/restored/_search", { query: hybrid, size: 3 })).hits.hits[0]._id, "a");
    await call("PUT", "/restored/_settings", { "index.search.default_pipeline": null }); await assert.rejects(call("POST", "/restored/_search", { query: hybrid }), /normalization/);
    await assert.rejects(call("POST", "/products,restored/_search", { query: { match_all: {} } }), /different default/);
    assert.equal((await call("POST", "/products,restored/_search?search_pipeline=blend", { query: hybrid, size: 10 })).hits.total.value, 6);
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("hybrid search validates on empty indexes and enforces DLS/FLS before candidate selection and normalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-hybrid-security-")), engine = new EmbeddedSearchEngine(join(root, "search.db"));
  const call = async (method: string, path: string, body: any = {}, access?: SearchAccess) => (await engine.request(method, path, Buffer.from(JSON.stringify(body)), "reader", true, access)).body;
  const reader = (fls = ["~price"]) => new SearchAccess({ name: "reader", backendRoles: [] }, false, [{ cluster_permissions: [], index_permissions: [{ index_patterns: ["products"], allowed_actions: ["read"], dls: JSON.stringify({ term: { tenant: "a" } }), fls }] }], "1");
  try {
    await call("PUT", "/_search/pipeline/blend", definition()); await call("PUT", "/products", { settings: { knn: true }, mappings: mapping });
    for (const query of [{ hybrid: { queries: [] } }, { hybrid: { queries: Array.from({ length: 6 }, () => ({ match_all: {} })) } }, { hybrid: { queries: [{ unsupported: {} }] } }, { hybrid: { queries: [{ knn: { vector: { vector: [1], k: 1 } } }] } }, { bool: { must: hybrid } }]) await assert.rejects(call("POST", "/products/_search?search_pipeline=blend", { query }));
    for (const pipeline of [definition("bogus"), definition("min_max", "bogus"), definition("min_max", "arithmetic_mean", [1, 1]), { request_processors: [{ script: { source: "code" } }] }]) await assert.rejects(call("PUT", "/_search/pipeline/bad", pipeline));
    for (const extra of [{ from: 1 }, { search_after: [1] }, { sort: [{ price: "asc" }] }, { search_pipeline: "blend" }]) await assert.rejects(call("POST", "/products/_search?search_pipeline=blend", { query: hybrid, ...extra }));
    await assert.rejects(call("POST", "/products/_search", { query: hybrid, search_pipeline: null }), /must be an object/);
    await assert.rejects(call("PUT", "/_search/pipeline/no", definition(), reader()), { status: 403 });
    await assert.rejects(call("GET", "/_search/pipeline", {}, reader()), { status: 403 });
    const admin = new SearchAccess({ name: "pipeline-admin", backendRoles: [] }, false, [{ cluster_permissions: ["cluster_manage_pipelines"], index_permissions: [] }], "1");
    assert.ok((await call("GET", "/_search/pipeline", {}, admin)).blend);
    for (const [id, vector, tenant] of [["visible", [0, 0], "a"], ["hidden", [1, 0], "b"]]) await call("PUT", `/products/_doc/${id}?refresh=true`, { vector, tenant, price: 100 });
    const found = await call("POST", "/products/_search?search_pipeline=blend", { query: hybrid }, reader()); assert.equal(found.hits.total.value, 1); assert.equal(found.hits.hits[0]._id, "visible"); closeTo(found.hits.hits[0]._score, 1); assert.equal(found.hits.hits[0]._source.price, undefined);
    await assert.rejects(call("POST", "/products/_search?search_pipeline=blend", { query: hybrid }, reader(["~vector"])), /not a knn_vector/);
    const noWeights = await call("POST", "/products/_search", { query: { hybrid: { queries: [{ match_all: { boost: 0 } }] } }, search_pipeline: { phase_results_processors: [{ "normalization-processor": { normalization: { technique: "l2" } } }] } }); closeTo(noWeights.hits.hits[0]._score, 0.001);
    const collection = new EmbeddedSearchEngine(join(root, "collection.db"), Date.now, undefined, { refreshIntervalMs: 1000 });
    try { await assert.rejects(collection.request("PUT", "/_search/pipeline/blend", Buffer.from(JSON.stringify(definition())), "admin"), /only on managed/); } finally { collection.close(); }
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("official search pipeline client CRUD executes hybrid domain searches", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-hybrid-client-")), region = "eu-west-1", sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", cdkBootstrap: false }); let client: Client | undefined;
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "hybrid-client" }, region); for (let i = 0; i < 200 && sim.opensearch.domain(region, "hybrid-client").state !== "active"; i++) await delay(10);
    client = new Client({ node: `https://127.0.0.1:${sim.opensearch.domain(region, "hybrid-client").gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, ...AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: "admin", secretAccessKey: "password" }) }) });
    await client.searchPipeline.put({ id: "blend", body: definition() as any }); assert.ok((await client.searchPipeline.get({ id: "blend" })).body.blend);
    await client.indices.create({ index: "products", body: { settings: { knn: true }, mappings: mapping as any } }); await client.index({ index: "products", id: "one", body: { title: "One", tenant: "a", vector: [1, 0] }, refresh: true });
    assert.equal((await client.search({ index: "products", search_pipeline: "blend", body: { query: hybrid } as any })).body.hits.hits[0]._id, "one");
    // The pinned client omits body-level search_pipeline from msearch item types.
    const multi = await client.msearch({ body: [{ index: "products" }, { query: hybrid, search_pipeline: "blend" }, { index: "products" }, { query: hybrid, search_pipeline: "missing" }] as any }); assert.equal((multi.body.responses[0] as any).hits.hits[0]._id, "one"); assert.equal((multi.body.responses[1] as any).status, 404);
    await client.searchPipeline.delete({ id: "blend" }); await assert.rejects(client.search({ index: "products", search_pipeline: "blend", body: { query: hybrid } as any }), (error: any) => error.statusCode === 404);
  } finally { await client?.close(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
