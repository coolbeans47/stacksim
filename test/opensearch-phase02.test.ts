import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EmbeddedSearchEngine } from "../src/opensearch/engine.js";

async function fixture(work: (engine: EmbeddedSearchEngine, call: (method: string, path: string, body?: any, principal?: string) => Promise<any>, advance: (ms: number) => void) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-corpus-")); let now = 0;
  const engine = new EmbeddedSearchEngine(join(root, "search.sqlite"), () => now);
  const call = async (method: string, path: string, body?: any, principal = "alice") => (await engine.request(method, path, Buffer.from(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)), principal)).body;
  try { await work(engine, call, ms => { now += ms; }); } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
}
async function seed(call: (method: string, path: string, body?: any) => Promise<any>) {
  await call("PUT", "/products", { mappings: { properties: { title: { type: "text" }, category: { type: "keyword" }, price: { type: "double" }, available: { type: "boolean" }, date: { type: "date" }, variants: { type: "nested", properties: { colour: { type: "keyword" }, size: { type: "keyword" } } } } } });
  const docs = [
    { title: "Red leather shoes", category: "shoes", price: 10, available: true, date: "2026-01-01T00:00:00Z", variants: [{ colour: "red", size: "S" }, { colour: "blue", size: "L" }] },
    { title: "Blue running shoes", category: "shoes", price: 20, available: false, date: "2026-01-03T00:00:00Z", variants: [{ colour: "red", size: "M" }] },
    { title: "Red winter coat", category: "coats", price: 30, available: true, date: "2026-01-03T00:00:00Z", variants: [] },
  ];
  for (let i = 0; i < docs.length; i++) await call("PUT", `/products/_doc/${i + 1}?refresh=true`, docs[i]);
}

test("OS-02 frozen embedded query, analyzer, source, sorting and explanation corpus", async () => fixture(async (_engine, call) => {
  await seed(call);
  const cases: Array<[any, string[]]> = [
    [{ match_all: {} }, ["1", "2", "3"]], [{ match_none: {} }, []],
    [{ match: { title: "RED" } }, ["1", "3"]], [{ multi_match: { query: "shoes", fields: ["title", "category"] } }, ["1", "2"]],
    [{ match_phrase: { title: "leather shoes" } }, ["1"]], [{ term: { category: "shoes" } }, ["1", "2"]],
    [{ terms: { category: ["coats", "missing"] } }, ["3"]], [{ range: { price: { gt: 10, lte: 30 } } }, ["2", "3"]],
    [{ exists: { field: "variants.colour" } }, ["1", "2"]], [{ ids: { values: ["3"] } }, ["3"]],
    [{ bool: { filter: { term: { available: true } }, must: { match: { title: "red" } }, must_not: { term: { category: "coats" } } } }, ["1"]],
    [{ constant_score: { filter: { term: { category: "coats" } }, boost: 3 } }, ["3"]],
    [{ prefix: { category: "sho" } }, ["1", "2"]], [{ wildcard: { title: "r*d" } }, ["1", "3"]],
    [{ nested: { path: "variants", query: { bool: { filter: [{ term: { "variants.colour": "red" } }, { term: { "variants.size": "L" } }] } } } }, []],
  ];
  for (const [query, expected] of cases) {
    const result = await call("POST", "/products/_search", { query, sort: ["_id"] });
    assert.deepEqual(result.hits.hits.map((hit: any) => hit._id), expected, JSON.stringify(query));
    assert.equal((await call("POST", "/products/_count", { query })).count, expected.length);
    assert.equal((await call("POST", "/products/_validate/query", { query })).valid, true);
  }
  const analyzed = { standard: ["the", "red", "12", "shoes"], simple: ["the", "red", "shoes"], whitespace: ["The", "RED", "12", "shoes!"], keyword: ["The RED 12 shoes!"], stop: ["red", "shoes"] };
  for (const [analyzer, tokens] of Object.entries(analyzed)) assert.deepEqual((await call("POST", "/products/_analyze", { analyzer, text: "The RED 12 shoes!" })).tokens.map((token: any) => token.token), tokens);
  const found = await call("POST", "/products/_search", { query: { match: { title: "red" } }, sort: [{ price: "desc" }], size: 1, _source: ["title"], fields: ["price"], highlight: { fields: { title: {} } } });
  assert.equal(found.hits.hits[0]._id, "3"); assert.deepEqual(found.hits.hits[0].sort, [30]); assert.deepEqual(found.hits.hits[0].fields, { price: [30] });
  assert.deepEqual(found.hits.hits[0]._source, { title: "Red winter coat" }); assert.deepEqual(found.hits.hits[0].highlight.title, ["<em>Red</em> winter coat"]);
  assert.equal((await call("POST", "/products/_explain/1", { query: { match: { title: "red leather" } } })).explanation.value, 2);
  const partial = await call("POST", "/products/_msearch", '{}\n{"query":{"term":{"category":"coats"}}}\n{}\n{"query":{"script":{}}}\n');
  assert.equal(partial.responses[0].hits.total.value, 1); assert.equal(partial.responses[1].status, 400);
}));

test("OS-02 numeric, bucket, nested, filtered and composite aggregation corpus", async () => fixture(async (_engine, call) => {
  await seed(call);
  const result = (await call("POST", "/products/_search", { size: 0, aggs: {
    min: { min: { field: "price" } }, max: { max: { field: "price" } }, sum: { sum: { field: "price" } }, avg: { avg: { field: "price" } }, stats: { stats: { field: "price" } },
    count: { value_count: { field: "price" } }, distinct: { cardinality: { field: "category" } },
    categories: { terms: { field: "category" }, aggs: { total: { sum: { field: "price" } } } },
    prices: { range: { field: "price", keyed: true, ranges: [{ key: "low", to: 20 }, { key: "high", from: 20 }] } },
    available: { filter: { term: { available: true } }, aggs: { total: { sum: { field: "price" } } } },
    variants: { nested: { path: "variants" }, aggs: { colours: { terms: { field: "variants.colour" } } } },
    days: { date_histogram: { field: "date", calendar_interval: "day" } },
    histogram: { histogram: { field: "price", interval: 10, min_doc_count: 0 } },
    page: { composite: { sources: [{ category: { terms: { field: "category" } } }], size: 1 } },
  } })).aggregations;
  for (const [name, value] of Object.entries({ min: 10, max: 30, sum: 60, avg: 20, count: 3, distinct: 2 })) assert.equal(result[name].value, value, name);
  assert.deepEqual(result.stats, { count: 3, min: 10, max: 30, sum: 60, avg: 20 });
  assert.deepEqual(result.categories.buckets.map((b: any) => [b.key, b.doc_count, b.total.value]), [["shoes", 2, 30], ["coats", 1, 30]]);
  assert.equal(result.prices.buckets.low.doc_count, 1); assert.equal(result.prices.buckets.high.doc_count, 2);
  assert.equal(result.available.doc_count, 2); assert.equal(result.available.total.value, 40);
  assert.equal(result.variants.doc_count, 3); assert.equal(result.variants.colours.buckets[0].doc_count, 2);
  assert.deepEqual(result.days.buckets.map((b: any) => b.doc_count), [1, 0, 2]);
  assert.deepEqual(result.histogram.buckets.map((b: any) => [b.key, b.doc_count]), [[10, 1], [20, 1], [30, 1]]);
  const second = (await call("POST", "/products/_search", { size: 0, aggs: { page: { composite: { sources: [{ category: { terms: { field: "category" } } }], size: 1, after: result.page.after_key } } } })).aggregations.page;
  assert.deepEqual(second.buckets.map((b: any) => b.key), [{ category: "shoes" }]);
}));

test("OS-02 scroll preserves projection and hit metadata, snapshots results, expires and rejects another caller", async () => fixture(async (_engine, call, advance) => {
  await seed(call);
  const first = await call("POST", "/products/_search?scroll=1s", { size: 1, sort: [{ price: "asc" }], _source: false, fields: ["title"], track_total_hits: false });
  await call("PUT", "/products/_doc/2?refresh=true", { title: "changed after snapshot" });
  await assert.rejects(call("POST", "/_search/scroll", { scroll_id: first._scroll_id }, "bob"), { status: 404 });
  advance(900);
  const second = await call("POST", "/_search/scroll", { scroll_id: first._scroll_id });
  assert.equal(second.hits.total, undefined); assert.equal(second.hits.hits[0]._source, undefined); assert.equal(second.hits.hits[0]._seq_no, undefined);
  assert.deepEqual(second.hits.hits[0].sort, [20]); assert.deepEqual(second.hits.hits[0].fields, { title: ["Blue running shoes"] });
  advance(101);
  await assert.rejects(call("POST", "/_search/scroll", { scroll_id: first._scroll_id }), { status: 404 });
  await assert.rejects(call("POST", "/products/_search?scroll=1s", { size: 0 }), /size > 0/);
  const next = await call("POST", "/products/_search?scroll=1s", { size: 2 });
  assert.equal((await call("DELETE", "/_search/scroll", { scroll_id: [next._scroll_id] })).num_freed, 1);
  await assert.rejects(call("POST", "/_search/scroll", { scroll_id: next._scroll_id }), { status: 404 });
}));

test("OS-02 PIT quotas, expiry, explicit cleanup and resource identity", async () => fixture(async (_engine, call, advance) => {
  await seed(call); const ids: string[] = [];
  for (let i = 0; i < 20; i++) ids.push((await call("POST", "/products/_search/point_in_time?keep_alive=1s")).pit_id);
  await assert.rejects(call("POST", "/products/_search/point_in_time?keep_alive=1s"), { status: 429 });
  await assert.rejects(call("DELETE", "/_search/point_in_time", { pit_id: ids, ignored: true }), /not supported/);
  await call("DELETE", "/_search/point_in_time", { pit_id: [ids[0]] });
  const replacement = await call("POST", "/products/_search/point_in_time?keep_alive=1s");
  assert.notEqual(replacement.pit_id, ids[0]);
  await fixture(async (_other, other) => { await assert.rejects(other("POST", "/_search", { pit: { id: replacement.pit_id } }), { status: 404 }); });
  advance(1001);
  await assert.rejects(call("POST", "/_search", { pit: { id: ids[1] } }), { status: 404 });
  assert.ok((await call("POST", "/products/_search/point_in_time?keep_alive=1s")).pit_id);
}));

test("OS-02 malformed queries reject on empty indexes; failed mutations leave mappings and aliases intact", async () => fixture(async (engine, call) => {
  await call("PUT", "/empty", { mappings: { properties: { title: { type: "text" } } } });
  const malformed = [
    { constant_score: {} }, { nested: { path: "missing" } }, { term: { title: { value: {} } } },
    { match: { title: { query: "x", zero_terms_query: "ignored" } } }, { match: { title: { query: [] } } },
    { prefix: { title: { value: "x", case_insensitive: "false" } } }, { range: { title: { gt: {} } } },
    { bool: { minimum_should_match: false } }, { ids: { values: [{}] } },
    { bool: { should: Array.from({ length: 1025 }, () => ({ match_all: {} })) } },
  ];
  for (const query of malformed) await assert.rejects(call("POST", "/empty/_search", { query }), { status: 400 }, JSON.stringify(query).slice(0, 200));
  for (const size of [null, true, [], ""]) await assert.rejects(call("POST", "/empty/_search", { size }), { status: 400 });
  const before = engine.indexes();
  await assert.rejects(call("PUT", "/empty/_mapping", { properties: { title: { type: "integer" } } }), /Cannot change/);
  await assert.rejects(call("POST", "/_aliases", { actions: [{ add: { index: "empty", alias: "good" } }, { add: { index: "missing", alias: "bad" } }] }), { status: 404 });
  await assert.rejects(call("PUT", "/_index_template/bad", { index_patterns: ["bad-*"], template: "ignored" }), /must be an object/);
  assert.deepEqual(engine.indexes(), before);
  assert.deepEqual((await call("GET", "/_index_template")).index_templates, []);
}));

test("OS-02 actual SQLite SQLITE_FULL rolls back document, sequence and dynamic mapping, then accepts retry", async () => fixture(async (engine, call) => {
  await call("PUT", "/durable/_doc/one?refresh=true", { title: "acknowledged" });
  // Restrict SQLite allocation on this connection: a portable real SQLITE_FULL
  // fault, without filling or changing the developer's host filesystem.
  const db = (engine as unknown as { db: DatabaseSync }).db;
  const pages = Number(db.prepare("PRAGMA page_count").get()!.page_count);
  db.exec(`PRAGMA max_page_count=${pages}`);
  const before = engine.indexes();
  await assert.rejects(call("PUT", "/durable/_doc/two", { title: "rejected", new_field: "x".repeat(200000) }), /database or disk is full/);
  assert.deepEqual(engine.indexes(), before);
  assert.equal((await call("GET", "/durable/_doc/two")).found, false);
  assert.equal((await call("GET", "/durable/_doc/one"))._source.title, "acknowledged");
  db.exec("PRAGMA max_page_count=10000");
  assert.equal((await call("PUT", "/durable/_doc/two?refresh=true", { title: "retry" }))._seq_no, 1);
  assert.equal((await call("POST", "/durable/_count", {})).count, 2);
}));

test("OS-02 aggregation shape/type checks apply to empty indexes and bound intermediate buckets", async () => fixture(async (_engine, call) => {
  await call("PUT", "/empty", { mappings: { properties: { text: { type: "text" }, price: { type: "double" }, date: { type: "date" } } } });
  const invalid = [
    { terms: { field: "text" } }, { composite: { sources: [{ a: { terms: { field: "text" } } }] } },
    { nested: { path: "missing" } }, { min: { field: "price", precision_threshold: 10 } },
    { sum: { field: "price" }, aggs: { child: { sum: { field: "price" } } } },
    { histogram: { field: "price", interval: 1, calendar_interval: "day" } },
    { date_histogram: { field: "date", calendar_interval: "day", fixed_interval: "1d" } },
    { date_histogram: { field: "date" } }, { range: { field: "price", ranges: [{ from: "ignored" }] } },
    { composite: { sources: [{ a: { terms: { field: "price", order: "ignored" } } }] } },
    { composite: { sources: [{ a: { terms: { field: "price" } } }], after: { missing: 1 } } },
  ];
  for (const agg of invalid) await assert.rejects(call("POST", "/empty/_search", { aggs: { bad: agg } }), { status: 400 }, JSON.stringify(agg));
  await assert.rejects(call("POST", "/empty/_search", { aggs: { too_many: { histogram: { field: "price", interval: 1, extended_bounds: { min: 0, max: 10001 } } } } }), /bucket/);
}));
