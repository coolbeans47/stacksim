import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EmbeddedSearchEngine } from "../src/opensearch/engine.js";

test("embedded search preserves real-time/refresh visibility, mappings, conflicts and acknowledged writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-opensearch-engine-")); let now = 0;
  let engine = new EmbeddedSearchEngine(join(root, "search.sqlite"), () => now);
  const call = async (method: string, path: string, body?: any) => (await engine.request(method, path, Buffer.from(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)), "alice")).body;
  try {
    await call("PUT", "/products", { mappings: { dynamic: "strict", properties: { title: { type: "text" }, category: { type: "keyword" }, price: { type: "double" }, tags: { type: "nested", properties: { name: { type: "keyword" }, value: { type: "keyword" } } } } } });
    const write = await call("PUT", "/products/_doc/1", { title: "Red leather shoes", category: "shoes", price: 45, tags: [{ name: "size", value: "small" }, { name: "colour", value: "red" }] });
    assert.equal(write._version, 1); assert.equal(write._seq_no, 0);
    assert.equal((await call("GET", "/products/_doc/1")).found, true);
    assert.equal((await call("POST", "/products/_search", {})).hits.total.value, 0);
    await assert.rejects(call("PUT", "/products/_create/1", { title: "duplicate" }), { type: "version_conflict_engine_exception", status: 409 });
    await assert.rejects(call("PUT", "/products/_doc/2", { unknown: true }), { type: "strict_dynamic_mapping_exception" });
    await call("POST", "/products/_refresh");
    assert.equal((await call("POST", "/products/_search", { query: { match: { title: "LEATHER" } } })).hits.total.value, 1);
    assert.equal((await call("POST", "/products/_search", { query: { nested: { path: "tags", query: { bool: { must: [{ term: { "tags.name": "size" } }, { term: { "tags.value": "red" } }] } } } } })).hits.total.value, 0);
    await assert.rejects(call("PUT", "/products/_doc/1?if_seq_no=9&if_primary_term=1", { title: "wrong" }), { type: "version_conflict_engine_exception" });
    await call("POST", "/products/_update/1?if_seq_no=0&if_primary_term=1", { doc: { price: 50 } });
    engine.close(); engine = new EmbeddedSearchEngine(join(root, "search.sqlite"), () => now);
    assert.equal((await call("GET", "/products/_doc/1"))._source.price, 50);
    now = 1100;
    const search = await call("POST", "/products/_search", { query: { range: { price: { gte: 50 } } }, aggs: { categories: { terms: { field: "category" } }, price: { stats: { field: "price" } } } });
    assert.equal(search.hits.total.value, 1); assert.equal(search.aggregations.price.sum, 50); assert.equal(search.aggregations.categories.buckets[0].key, "shoes");
    await call("DELETE", "/products/_doc/1?refresh=true"); assert.equal((await call("POST", "/products/_count", {})).count, 0);
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("bulk keeps successful items, validates framing before mutations, aliases are atomic and templates apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-opensearch-bulk-")); const engine = new EmbeddedSearchEngine(join(root, "search.sqlite"));
  const call = async (method: string, path: string, body?: any, explicit = true) => (await engine.request(method, path, Buffer.from(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)), "alice", explicit)).body;
  try {
    await call("PUT", "/_index_template/products", { index_patterns: ["product-*"], template: { mappings: { dynamic: "strict", properties: { category: { type: "keyword" }, price: { type: "double" } } } } });
    await call("PUT", "/product-a", { aliases: { products: { is_write_index: true } } });
    const bulk = await call("POST", "/products/_bulk?refresh=true", '{"index":{"_id":"1"}}\n{"category":"a","price":2}\n{"index":{"_id":"2"}}\n{"invalid":true}\n{"create":{"_id":"3"}}\n{"category":"b","price":3}\n');
    assert.equal(bulk.errors, true); assert.deepEqual(bulk.items.map((item: any) => Object.values<any>(item)[0].status), [201, 400, 201]);
    await assert.rejects(call("POST", "/products/_bulk", '{"delete":{"_id":"1"}}\n{"index":{}}\n'), /source line/);
    assert.equal((await call("GET", "/products/_doc/1")).found, true);
    await assert.rejects(call("POST", "/products/_bulk", '{"delete":{"_index":"product-a","_id":"1"}}\n', false), /Explicit index/);
    await call("PUT", "/product-b", {});
    await assert.rejects(call("POST", "/_aliases", { actions: [{ add: { index: "product-b", alias: "products", is_write_index: true } }] }), /multiple write/);
    assert.deepEqual((await call("GET", "/product-b"))["product-b"].aliases, {});
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("search pagination contexts are identity scoped and unsupported queries fail even with no documents", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-opensearch-pages-")); const engine = new EmbeddedSearchEngine(join(root, "search.sqlite"));
  const call = async (method: string, path: string, body?: any, principal = "alice") => (await engine.request(method, path, Buffer.from(body === undefined ? "" : JSON.stringify(body)), principal)).body;
  try {
    await call("PUT", "/test", {});
    await assert.rejects(call("PUT", "/test/_doc/escape/extra", { secret: true }), /Unsupported request path/);
    assert.equal((await call("GET", "/test/_doc/escape")).found, false);
    await assert.rejects(call("POST", "/test/_mget", { docs: [{}] }), /string IDs/);
    assert.deepEqual((await call("POST", "/_analyze", { text: "A  RED shoe!", analyzer: "standard" })).tokens.map((token: any) => [token.token, token.start_offset, token.end_offset]), [["a", 0, 1], ["red", 3, 6], ["shoe", 7, 11]]);
    await assert.rejects(call("POST", "/test/_search", { query: { script: { script: "true" } } }), /not implemented/);
    for (let i = 0; i < 4; i++) await call("PUT", `/test/_doc/${i}?refresh=true`, { n: i, group: i % 2 ? "odd" : "even" });
    const first = await call("POST", "/test/_search", { sort: [{ n: "asc" }], size: 2 });
    assert.equal((await call("POST", "/test/_search?_source=false", {})).hits.hits[0]._source, undefined);
    assert.deepEqual((await call("POST", "/test/_search?_source_includes=n", {})).hits.hits[0]._source, { n: 0 });
    await assert.rejects(call("POST", "/test/_search", { aggs: { invalid: { terms: { field: "group" } } } }), /text field/);
    const second = await call("POST", "/test/_search", { sort: [{ n: "asc" }], size: 2, search_after: first.hits.hits.at(-1).sort });
    assert.deepEqual(second.hits.hits.map((hit: any) => hit._id), ["2", "3"]);
    const pit = await call("POST", "/test/_search/point_in_time?keep_alive=1m");
    await call("PUT", "/test/_doc/4?refresh=true", { n: 4 });
    assert.equal((await call("POST", "/_search", { pit: { id: pit.pit_id } })).hits.total.value, 4);
    await assert.rejects(call("POST", "/_search", { pit: { id: pit.pit_id } }, "bob"), { status: 404 });
    const composite = await call("POST", "/test/_search", { size: 0, aggs: { pages: { composite: { size: 1, sources: [{ group: { terms: { field: "group.keyword" } } }] } } } });
    assert.equal(composite.aggregations.pages.buckets.length, 1);
    assert.equal(composite.aggregations.pages.buckets[0].doc_count, 2);
    await assert.rejects(call("POST", "/missing/_update/1", { doc_as_upsert: true }), /requires a document/);
    assert.equal(engine.indexes().some(index => index.name === "missing"), false);
    await call("PUT", "/test/_doc/prototype?refresh=true", JSON.parse('{"constructor":{"polluted":true},"__proto__":{"polluted":true}}'));
    assert.equal(({} as any).polluted, undefined);
    const caps = await call("POST", "/test/_field_caps", { fields: ["*"] });
    assert.ok(caps.fields["constructor.polluted"]);
    assert.equal(({} as any).polluted, undefined);
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});
