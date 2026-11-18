import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EmbeddedSearchEngine } from "../src/opensearch/engine.js";

test("vector search executes exact distances, filters and top-k and persists mappings and vectors", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-vector-"));
  let engine = new EmbeddedSearchEngine(join(root, "search.sqlite"));
  const call = async (method: string, path: string, body?: any) => (await engine.request(method, path, Buffer.from(JSON.stringify(body ?? {})), "alice")).body;
  try {
    for (const space of ["l2", "l1", "linf", "cosinesimil", "innerproduct"]) {
      await call("PUT", `/vectors-${space}`, { settings: { index: { knn: true } }, mappings: { properties: { vector: { type: "knn_vector", dimension: 2, space_type: space }, group: { type: "keyword" } } } });
      for (const [id, vector, group] of [["a", [1, 0], "public"], ["b", [2, 1], "private"], ["c", [0, 1], "public"]]) await call("PUT", `/vectors-${space}/_doc/${id}?refresh=true`, { vector, group });
      const result = await call("POST", `/vectors-${space}/_search`, { size: 10, query: { knn: { vector: { vector: [1, 0], k: 1, filter: { term: { group: "public" } } } } } });
      assert.equal(result.hits.total.value, 1); assert.equal(result.hits.hits[0]._id, "a");
      assert.equal(result.hits.hits[0]._score, space === "innerproduct" ? 2 : 1);
    }
    const scores = (await call("POST", "/vectors-l2/_search", { query: { knn: { vector: { vector: [1, 0], k: 3 } } } })).hits.hits.map((hit: any) => hit._score);
    assert.deepEqual(scores, [1, 1 / 3, 1 / 3]);
    await assert.rejects(call("PUT", "/vectors-l2/_doc/bad", { vector: [1] }), /requires 2/);
    await assert.rejects(call("POST", "/vectors-l2/_search", { query: { knn: { vector: { vector: [1], k: 1 } } } }), /dimension/);
    await assert.rejects(call("PUT", "/vectors-cosinesimil/_doc/zero", { vector: [0, 0] }), /zero magnitude/);
    await assert.rejects(call("PUT", "/vectors-l2/_mapping", { properties: { vector: { type: "knn_vector", dimension: 3 } } }), /Cannot change vector dimension/);
    await assert.rejects(call("POST", "/vectors-l2/_search", { query: { knn: { vector: { vector: [1, 0], k: 1, method_parameters: { ef_search: 10 } } } } }), /not supported/);
    engine.close(); engine = new EmbeddedSearchEngine(join(root, "search.sqlite"));
    assert.equal((await call("POST", "/vectors-l2/_search", { query: { knn: { vector: { vector: [1, 0], k: 1 } } } })).hits.hits[0]._id, "a");
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});
