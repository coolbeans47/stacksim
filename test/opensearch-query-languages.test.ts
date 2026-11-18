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

const schema = { properties: { title: { type: "text", fields: { keyword: { type: "keyword" } } }, category: { type: "keyword" }, price: { type: "double" }, tenant: { type: "keyword" }, enabled: { type: "boolean" }, optional: { type: "integer" } } };
const corpus = [
  { title: "Red shoes", category: "shoe", price: 20, tenant: "a", enabled: true, optional: 4 },
  { title: "Blue shoes", category: "shoe", price: 40, tenant: "b", enabled: false },
  { title: "Red hat", category: "hat", price: 10, tenant: "a", enabled: true, optional: null },
  { title: "Coat", category: "coat", price: 90, tenant: "a", enabled: false, optional: 2 },
];

test("SQL/PPL query the authoritative refresh view with filters, projections, groups and cursor snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ql-")); let now = 1700000000000;
  const engine = new EmbeddedSearchEngine(join(root, "search.db"), () => now);
  const call = async (path: string, body: any, principal = "reader") => (await engine.request("POST", path, Buffer.from(JSON.stringify(body)), principal)).body;
  const sql = (query: string, input = {}) => call("/_plugins/_sql", { query, ...input });
  const ppl = (query: string) => call("/_plugins/_ppl", { query });
  try {
    await engine.request("PUT", "/products", Buffer.from(JSON.stringify({ mappings: schema, settings: { refresh_interval: "-1" }, aliases: { catalog: {} } })), "admin");
    for (const [i, doc] of corpus.entries()) await engine.request("PUT", `/products/_doc/${i}`, Buffer.from(JSON.stringify(doc)), "admin");
    assert.deepEqual((await sql("SELECT COUNT(*) AS n FROM products")).datarows, [[0]]);
    await engine.request("POST", "/products/_refresh", Buffer.alloc(0), "admin");
    const selected = await sql("SELECT title AS name, price FROM catalog WHERE enabled = true AND (price >= 10 OR optional IS NOT NULL) ORDER BY price DESC LIMIT 1");
    assert.deepEqual(selected.schema, [{ name: "name", type: "text" }, { name: "price", type: "double" }]); assert.deepEqual(selected.datarows, [["Red shoes", 20]]); assert.equal(selected.total, 2); assert.equal(selected.size, 1);
    assert.deepEqual((await sql("SELECT category AS kind, COUNT(*) AS n, SUM(price) AS cost, AVG(price) AS average, MIN(price) AS minimum, MAX(price) AS maximum FROM products GROUP BY category ORDER BY kind")).datarows, [["coat", 1, 90, 90, 90, 90], ["hat", 1, 10, 10, 10, 10], ["shoe", 2, 60, 30, 20, 40]]);
    assert.deepEqual((await ppl("source=products | where price BETWEEN 10 AND 40 | stats count() AS n, avg(price) AS mean by category | sort -n | fields category,n,mean | head 2")).datarows, [["shoe", 2, 30], ["hat", 1, 10]]);
    assert.deepEqual((await sql("SELECT title FROM products WHERE title LIKE 'Red %' ORDER BY price")).datarows, [["Red hat"], ["Red shoes"]]);
    assert.deepEqual((await sql("SELECT title FROM products WHERE NOT (optional = 4) ORDER BY price")).datarows, [["Coat"]]);
    assert.deepEqual((await sql("SELECT title FROM products WHERE optional NOT IN (4,NULL)")).datarows, []);
    assert.deepEqual((await sql("SELECT COUNT(optional) AS n, SUM(optional) AS s FROM products WHERE tenant != 'b'")).datarows, [[2, 6]]);
    assert.deepEqual((await sql("SELECT COUNT(*) AS n,SUM(price) AS s FROM products WHERE price < 0")).datarows, [[0, null]]);
    assert.deepEqual((await sql("SELECT title.keyword FROM products WHERE price >= 20", { filter: { term: { tenant: "a" } } })).datarows, [["Red shoes"], ["Coat"]]);
    const page = await sql("SELECT title FROM products ORDER BY price", { fetch_size: 1 }); assert.deepEqual(page.datarows, [["Red hat"]]); assert.ok(page.cursor);
    await engine.request("DELETE", "/products/_doc/0?refresh=true", Buffer.alloc(0), "admin");
    await assert.rejects(call("/_plugins/_sql", { cursor: page.cursor }, "different"), { status: 404 });
    assert.deepEqual((await call("/_plugins/_sql", { cursor: page.cursor })).datarows, [["Red shoes"]]);
    assert.deepEqual((await call("/_plugins/_sql", { cursor: page.cursor })).datarows, [["Blue shoes"]]);
    const final = await call("/_plugins/_sql", { cursor: page.cursor }); assert.deepEqual(final.datarows, [["Coat"]]); assert.equal(final.cursor, undefined);
    await assert.rejects(call("/_plugins/_sql", { cursor: page.cursor }), { status: 404 });
    const closing = await sql("SELECT title FROM products", { fetch_size: 1 }); assert.deepEqual(await call("/_plugins/_sql/close", { cursor: closing.cursor }), { succeeded: true });
    const expiring = await sql("SELECT title FROM products", { fetch_size: 1 }); now += 300001; await assert.rejects(call("/_plugins/_sql", { cursor: expiring.cursor }), { status: 404 });
    assert.equal((await call("/_plugins/_ppl/_explain", { query: "source=products | stats count() AS n" })).root.name, "StackSimQueryPlan");
    for (let i = 0; i < 20; i++) await sql("SELECT title FROM products", { fetch_size: 1 });
    await assert.rejects(sql("SELECT title FROM products", { fetch_size: 1 }), { status: 429 });
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("SQL/PPL enforce DLS/FLS before grouping and reject unsupported, ambiguous and excessive work", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ql-security-")), engine = new EmbeddedSearchEngine(join(root, "search.db"));
  const access = (revision: string, patterns = ["products"]) => new SearchAccess({ name: "reader", backendRoles: [] }, false, [{ cluster_permissions: [], index_permissions: [{ index_patterns: patterns, allowed_actions: ["read"], dls: JSON.stringify({ term: { tenant: "a" } }), fls: ["~tenant", "~optional"] }] }], revision);
  const call = async (query: string, extra = {}, permissions?: SearchAccess, path = "/_plugins/_sql") => (await engine.request("POST", path, Buffer.from(JSON.stringify({ query, ...extra })), "reader", true, permissions)).body;
  try {
    await engine.request("PUT", "/products", Buffer.from(JSON.stringify({ mappings: schema })), "admin");
    for (const [i, doc] of corpus.entries()) await engine.request("PUT", `/products/_doc/${i}?refresh=true`, Buffer.from(JSON.stringify(doc)), "admin");
    const grouped = await call("SELECT category,COUNT(*) AS n,SUM(price) AS cost FROM products GROUP BY category ORDER BY category", {}, access("1")); assert.deepEqual(grouped.datarows, [["coat", 1, 90], ["hat", 1, 10], ["shoe", 1, 20]]);
    assert.equal((await call("SELECT * FROM products", {}, access("1"))).schema.some((item: any) => item.name === "tenant"), false);
    for (const text of ["SELECT tenant FROM products", "SELECT title FROM products WHERE optional IS NULL", "SELECT COUNT(*) AS n FROM products GROUP BY tenant"]) await assert.rejects(call(text, {}, access("1")), /inaccessible/);
    await assert.rejects(call("SELECT COUNT(*) AS n FROM products", {}, access("1", ["other"])), { status: 403 });
    const first = await call("SELECT title FROM products", { fetch_size: 1 }, access("1"));
    await assert.rejects(engine.request("POST", "/_plugins/_sql", Buffer.from(JSON.stringify({ cursor: first.cursor })), "reader", true, access("2")), { status: 404 });
    await assert.rejects(engine.request("POST", "/_plugins/_sql", Buffer.from('{"query":"SELECT * FROM products"}'), "reader", false), /explicit index/);
    for (const query of ["DELETE FROM products", "SELECT * FROM products; DELETE FROM products", "SELECT * FROM products JOIN other ON products.id = other.id", "SELECT sleep(1) FROM products", "SELECT DISTINCT title FROM products", "SELECT price + 1 FROM products", "SELECT * FROM products LIMIT 10001", "SELECT * FROM products WHERE price = '20'", "SELECT * FROM products WHERE title = 'unterminated", "SELECT category, SUM(price) FROM products", "SELECT title,title FROM products", "SELECT * FROM products WHERE enabled LIKE '%'", `SELECT * FROM products WHERE ${"(".repeat(34)}price=20${")".repeat(34)}`]) await assert.rejects(call(query));
    for (const extra of [{ fetch_size: -1 }, { parameters: [] }, { cursor: "fake" }]) await assert.rejects(call("SELECT * FROM products", extra));
    await assert.rejects(call("SELECT * FROM products", {}, undefined, "/_plugins/_sql?format=csv"), /JDBC/);
    await assert.rejects(call("source=products | eval cost=price*2", {}, undefined, "/_plugins/_ppl"), /Unsupported/);
    await assert.rejects(call("source=products", { fetch_size: 1 }, undefined, "/_plugins/_ppl"), /only for SQL/);
    await engine.request("PUT", "/products/_doc/array?refresh=true", Buffer.from(JSON.stringify({ title: ["a", "b"] })), "admin");
    await assert.rejects(call("SELECT title FROM products"), /Multivalued/);
    assert.equal((await call("SELECT COUNT(*) AS n FROM products")).datarows[0][0], 5);
    assert.equal((await engine.request("GET", "/products/_doc/0", Buffer.alloc(0), "admin")).body._version, 1);
    await engine.request("PUT", "/large/_doc/one?refresh=true", Buffer.from(JSON.stringify({ text: "a".repeat(32768) })), "admin");
    await assert.rejects(call(`SELECT text FROM large WHERE text LIKE '${"_".repeat(1024)}'`), { status: 429 });
    const serverless = new EmbeddedSearchEngine(join(root, "collection.db"), Date.now, undefined, { refreshIntervalMs: 1000 });
    try { await assert.rejects(serverless.request("POST", "/_plugins/_sql", Buffer.from('{"query":"SELECT * FROM products"}'), "reader"), /only on managed/); } finally { serverless.close(); }
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("official SQL and PPL clients query encrypted domains across restart", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ql-client-")), region = "eu-west-1", options = { port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce" as const, cdkBootstrap: false }; let sim = new StackSim(options), client: Client | undefined;
  try {
    await sim.start(); await sim.opensearch.execute("CreateDomain", { DomainName: "query-languages", EncryptionAtRestOptions: { Enabled: true } }, region);
    for (let i = 0; i < 200 && sim.opensearch.domain(region, "query-languages").state !== "active"; i++) await delay(10);
    const node = `https://127.0.0.1:${sim.opensearch.domain(region, "query-languages").gatewayPort}`, ssl = { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, signer = AwsSigv4Signer({ region, service: "es", getCredentials: async () => ({ accessKeyId: "admin", secretAccessKey: "password" }) });
    client = new Client({ node, ssl, ...signer }); await client.indices.create({ index: "products", body: { mappings: schema as any } });
    for (const [i, body] of corpus.entries()) await client.index({ index: "products", id: String(i), body, refresh: true });
    const first = (await client.sql.query({ body: { query: "SELECT title FROM products ORDER BY price", fetch_size: 1 } })).body as any; assert.deepEqual(first.datarows, [["Red hat"]]);
    // The pinned client's Query type omits the documented cursor-only body.
    assert.deepEqual(((await client.sql.query({ body: { cursor: first.cursor } as any })).body as any).datarows, [["Red shoes"]]); assert.equal(((await client.sql.close({ body: { cursor: first.cursor } })).body as any).succeeded, true);
    assert.deepEqual(((await client.ppl.query({ body: { query: "source=products | stats count() AS n,sum(price) AS cost" } })).body as any).datarows, [[4, 160]]);
    assert.ok((await client.sql.explain({ body: { query: "SELECT title FROM products WHERE price > 10" } })).body);
    await client.close(); await sim.stop(); sim = new StackSim(options); await sim.start(); client = new Client({ node, ssl, ...signer });
    assert.deepEqual(((await client.sql.query({ body: { query: "SELECT COUNT(*) AS n FROM products" } })).body as any).datarows, [[4]]);
    await assert.rejects(client.sql.query({ body: { query: "SELECT * FROM products", fetch_size: 10001 } }), (error: any) => error.statusCode === 400);
    const domain = sim.opensearch.domain(region, "query-languages");
    await sim.opensearch.execute("UpdateDomainConfig", { DomainName: domain.name, AccessPolicies: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: "*", Action: "es:ESHttpPost", Resource: `${domain.arn}/_plugins/_sql` }] }) }, region);
    for (let i = 0; i < 200 && !sim.opensearch.domain(region, "query-languages").config.AccessPolicies.includes('"Deny"'); i++) await delay(10);
    await assert.rejects(client.sql.query({ body: { query: "SELECT COUNT(*) AS n FROM products" } }), (error: any) => error.statusCode === 403);
    assert.deepEqual(((await client.ppl.query({ body: { query: "source=products | stats count() AS n" } })).body as any).datarows, [[4]]);
  } finally { await client?.close(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
