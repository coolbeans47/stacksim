import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EmbeddedSearchEngine } from "../src/opensearch/engine.js";
import { passwordVerifier, type SearchIdentity } from "../src/opensearch/security.js";

test("FGAC enforces resolved indexes, document and field access before queries, aggregation, GET and contexts", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-fgac-"));
  const engine = new EmbeddedSearchEngine(join(root, "generation", "search.enc"), Date.now, { keyFile: join(root, "key") });
  const admin: SearchIdentity = { name: "admin", backendRoles: [], internal: true };
  const reader: SearchIdentity = { name: "reader", backendRoles: ["sales"], internal: true };
  engine.setSecurityMaster({ username: "admin", verifier: passwordVerifier("Master-password1!") });
  const call = async (identity: SearchIdentity, method: string, path: string, body?: unknown) => (await engine.request(method, path, Buffer.from(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)), identity.name, true, engine.security.access(identity))).body;
  try {
    await call(admin, "PUT", "/orders", { mappings: { properties: { tenant: { type: "keyword" }, title: { type: "text" }, price: { type: "integer" }, secret: { type: "keyword" }, details: { properties: { public: { type: "keyword" }, hidden: { type: "keyword" } } } } }, aliases: { shop: {} } });
    await call(admin, "PUT", "/hidden", { aliases: { "public-looking-alias": {} } });
    await call(admin, "PUT", "/orders/_doc/1?refresh=true", { tenant: "a", title: "Red shoes", price: 10, secret: "classified", details: { public: "yes", hidden: "hidden-value" } });
    await call(admin, "PUT", "/orders/_doc/2?refresh=true", { tenant: "b", title: "Red hat", price: 100, secret: "classified" });
    await call(admin, "PUT", "/_plugins/_security/api/roles/sales", { cluster_permissions: ["cluster_monitor"], index_permissions: [{ index_patterns: ["orders"], allowed_actions: ["read"], dls: JSON.stringify({ term: { tenant: "a" } }), fls: ["tenant", "title", "price", "details.public"] }] });
    await call(admin, "PUT", "/_plugins/_security/api/rolesmapping/sales", { backend_roles: ["sales"] });
    const search = await call(reader, "POST", "/shop/_search", { aggs: { total: { sum: { field: "price" } } }, fields: ["secret", "details.hidden"], highlight: { fields: { secret: {} } } });
    assert.equal(search.hits.total.value, 1); assert.equal(search.aggregations.total.value, 10);
    assert.deepEqual(search.hits.hits[0]._source, { tenant: "a", title: "Red shoes", price: 10, details: { public: "yes" } });
    assert.deepEqual(search.hits.hits[0].fields, { secret: [], "details.hidden": [] });
    assert.deepEqual(search.hits.hits[0].highlight, {});
    assert.equal((await call(reader, "POST", "/shop/_count", { query: { term: { secret: "classified" } } })).count, 0);
    assert.equal((await call(reader, "GET", "/orders/_doc/2")).found, false);
    assert.equal((await call(reader, "GET", "/orders/_doc/1"))._source.secret, undefined);
    assert.equal((await call(reader, "GET", "/orders/_mapping")).orders.mappings.properties.secret, undefined);
    assert.equal((await call(reader, "POST", "/orders/_field_caps", { fields: ["*"] })).fields.secret, undefined);
    assert.equal((await call(reader, "POST", "/orders/_search", { aggs: { hidden: { terms: { field: "secret" } } } })).aggregations.hidden.buckets.length, 0);
    await assert.rejects(call(reader, "GET", "/public-looking-alias"), { status: 403 });
    await assert.rejects(call(reader, "POST", "/_search"), { status: 403 });
    await assert.rejects(call(reader, "PUT", "/orders/_doc/3", { tenant: "a" }), { status: 403 });
    await assert.rejects(call(reader, "POST", "/orders/_update/1", { doc: { price: 999 }, _source: true }), { status: 403 });
    await assert.rejects(call(reader, "PUT", "/_plugins/_security/api/roles/escape", { index_permissions: [{ index_patterns: ["*"], allowed_actions: ["*"] }] }), { status: 403 });
    const multi = await call(reader, "POST", "/_msearch", '{"index":"orders"}\n{}\n{"index":"hidden"}\n{}\n');
    assert.equal(multi.responses[0].hits.total.value, 1); assert.equal(multi.responses[1].status, 403);
    await call(admin, "PUT", "/orders/_doc/deleted?refresh=true", { tenant: "b", title: "secret" });
    await call(admin, "DELETE", "/orders/_doc/deleted?refresh=true");
    const metadata = await call(reader, "GET", "/_cat/indices/orders?format=json");
    assert.equal(metadata[0]["docs.count"], "1"); assert.equal(metadata[0]["docs.deleted"], undefined);
    assert.equal((await call(admin, "GET", "/_cat/indices/orders?format=json"))[0]["docs.deleted"], "1");
    const scroll = await call(reader, "POST", "/orders/_search?scroll=1m", { size: 1 });
    const pit = await call(reader, "POST", "/orders/_search/point_in_time?keep_alive=1m");
    await call(admin, "DELETE", "/_plugins/_security/api/rolesmapping/sales");
    await assert.rejects(call(reader, "POST", "/_search/scroll", { scroll_id: scroll._scroll_id }), { status: 404 });
    await assert.rejects(call(reader, "POST", "/_search", { pit: { id: pit.pit_id } }), { status: 404 });
    await assert.rejects(call(reader, "GET", "/orders/_doc/1"), { status: 403 });
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("internal users persist hashed credentials, exact operation grants protect bulk targets, and updates revoke sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-users-"));
  const file = join(root, "generation", "search.enc"), keyFile = join(root, "key");
  let engine = new EmbeddedSearchEngine(file, Date.now, { keyFile });
  const admin: SearchIdentity = { name: "arn:aws:iam::000000000000:role/SearchAdmin", backendRoles: [] };
  const call = async (identity: SearchIdentity, method: string, path: string, body?: unknown) => (await engine.request(method, path, Buffer.from(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)), identity.name, true, engine.security.access(identity))).body;
  const basic = (password: string) => `Basic ${Buffer.from(`writer:${password}`).toString("base64")}`;
  try {
    engine.setSecurityMaster({ arn: admin.name });
    await call(admin, "PUT", "/allowed", {}); await call(admin, "PUT", "/blocked", {});
    await call(admin, "PUT", "/_plugins/_security/api/roles/writer", { index_permissions: [{ index_patterns: ["allowed"], allowed_actions: ["indices:data/write/index"] }] });
    await call(admin, "PUT", "/_plugins/_security/api/internalusers/writer", { password: "Writer-password1!", opendistro_security_roles: ["writer"] });
    const writer = engine.security.authenticate(basic("Writer-password1!"));
    const bulk = await call(writer, "POST", "/_bulk?refresh=true", '{"index":{"_index":"allowed","_id":"1"}}\n{"title":"accepted"}\n{"index":{"_index":"blocked","_id":"2"}}\n{"secret":"denied"}\n{"delete":{"_index":"allowed","_id":"1"}}\n');
    assert.deepEqual(bulk.items.map((item: any) => Object.values<any>(item)[0].status), [201, 403, 403]);
    assert.equal((await call(admin, "GET", "/blocked/_doc/2")).found, false);
    assert.equal((await call(admin, "GET", "/allowed/_doc/1")).found, true);
    const users = await call(admin, "GET", "/_plugins/_security/api/internalusers");
    assert.equal(users.writer.verifier, undefined); assert.equal(users.writer.password, undefined);
    await assert.rejects(call(admin, "PUT", "/_plugins/_security/api/roles/bad", { index_permissions: [{ index_patterns: ["*"], allowed_actions: ["read"], dls: '{"script":{}}' }] }), /not implemented/);
    engine.close(); engine = new EmbeddedSearchEngine(file, Date.now, { keyFile });
    assert.equal(engine.security.authenticate(basic("Writer-password1!")).name, "writer");
    await call(admin, "PUT", "/_plugins/_security/api/internalusers/writer", { password: "Replaced-password2!", opendistro_security_roles: [] });
    assert.throws(() => engine.security.authenticate(basic("Writer-password1!")), { status: 401 });
    await assert.rejects(call(engine.security.authenticate(basic("Replaced-password2!")), "PUT", "/allowed/_doc/3", {}), { status: 403 });
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});
