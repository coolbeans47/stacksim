import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EmbeddedSearchEngine } from "../src/opensearch/engine.js";

test("workspace objects persist privately, reject cross-identity IDs, and validate queries before saving", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-workspace-"));
  const file = join(root, "generation", "search.enc"), keyFile = join(root, "key");
  let engine = new EmbeddedSearchEngine(file, Date.now, { keyFile });
  const call = async (principal: string, method: string, body?: unknown) => (await engine.request(method, "/_stacksim/workspace", Buffer.from(body === undefined ? "" : JSON.stringify(body)), principal)).body;
  try {
    engine.createIndex("products", {});
    const view = (await call("alice", "PUT", { type: "data-view", title: "Products", pattern: "products*" })).object;
    const search = (await call("alice", "PUT", { type: "saved-search", title: "Red shoes", pattern: "products*", query: { match: { title: "red" } }, fields: ["title"], sort: [{ price: "asc" }] })).object;
    assert.equal((await call("alice", "GET")).objects.length, 2);
    assert.deepEqual((await call("bob", "GET")).objects, []);
    await assert.rejects(call("bob", "DELETE", { id: view.id }), { status: 404 });
    await assert.rejects(call("bob", "PUT", { ...view, updatedAt: undefined, title: "stolen" }), { status: 404 });
    await assert.rejects(call("*", "GET"), { status: 401 });
    await assert.rejects(call("alice", "PUT", { type: "saved-search", title: "invalid", pattern: "products", query: { script: {} } }), /not implemented/);
    engine.close(); engine = new EmbeddedSearchEngine(file, Date.now, { keyFile });
    assert.equal((await call("alice", "GET")).objects.find((object: any) => object.id === search.id).query.match.title, "red");
    await call("alice", "DELETE", { id: view.id });
    assert.deepEqual((await call("alice", "GET")).objects.map((object: any) => object.id), [search.id]);
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});
