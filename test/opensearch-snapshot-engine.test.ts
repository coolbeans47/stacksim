import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EmbeddedSearchEngine } from "../src/opensearch/engine.js";
import { SearchAccess } from "../src/opensearch/security.js";

test("portable snapshot captures committed unrefreshed data, excludes private state and restores atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-snapshot-engine-")), engine = new EmbeddedSearchEngine(join(root, "search.sqlite"));
  const request = (method: string, path: string, body?: any) => engine.request(method, path, Buffer.from(body === undefined ? "" : JSON.stringify(body)), "test");
  try {
    await request("PUT", "/_index_template/logs", { index_patterns: ["logs-*"], template: { mappings: { properties: { status: { type: "integer" } } } } });
    await request("PUT", "/logs-one", { settings: { refresh_interval: "-1" }, aliases: { logs: { is_write_index: true } } });
    await request("PUT", "/logs-one/_doc/one?routing=tenant", { status: 200, secret: "portable-data" });
    await request("PUT", "/logs-one/_doc/one?routing=tenant", { status: 201, secret: "portable-data" });
    await request("PUT", "/logs-two", {});
    const data = engine.exportSnapshot({ indices: ["logs-*", "-logs-two"] });
    assert.equal(data.indexes.length, 1); assert.equal(data.indexes[0].documents[0].version, 2); assert.equal(data.indexes[0].documents[0].routing, "tenant");
    assert.deepEqual(Object.keys(data).sort(), ["format", "indexes", "templates"]);
    const options = { rename_pattern: "logs-(.+)", rename_replacement: "restored-$1", include_aliases: false, include_global_state: true, index_settings: { refresh_interval: "1s" } };
    assert.deepEqual(engine.validateSnapshotRestore(data, options), ["restored-one"]); assert.ok(!engine.indexes().some(index => index.name === "restored-one"));
    engine.restoreSnapshot(data, options);
    const got = await request("GET", "/restored-one/_doc/one?routing=tenant"); assert.equal(got.body._version, 2); assert.equal(got.body._source.status, 201);
    assert.equal((await request("POST", "/restored-one/_search", { query: { match_all: {} } })).body.hits.total.value, 1);
    assert.throws(() => engine.restoreSnapshot(data, options), /existing index/);
    const invalid = structuredClone(data); invalid.indexes.push({ ...structuredClone(data.indexes[0]), name: "logs-invalid" }); invalid.indexes[1].documents[0].source.status = "not a number";
    assert.throws(() => engine.restoreSnapshot(invalid, { ...options, rename_replacement: "bad-$1" }), /parse/);
    assert.ok(!engine.indexes().some(index => index.name.startsWith("bad-")));
    for (const key of ["seq", "version"]) {
      const corrupt = structuredClone(data); delete (corrupt.indexes[0].documents[0] as any)[key];
      assert.throws(() => engine.validateSnapshotRestore(corrupt, { ...options, rename_replacement: "bad-$1" }), /metadata is required/);
      assert.ok(!engine.indexes().some(index => index.name.startsWith("bad-")));
    }
    const missingSequence = structuredClone(data); delete (missingSequence.indexes[0] as any).seq;
    assert.throws(() => engine.validateSnapshotRestore(missingSequence, { ...options, rename_replacement: "bad-$1" }), /metadata is required/);
    const collision = { ...options, rename_pattern: ".+", rename_replacement: "same" };
    assert.throws(() => engine.restoreSnapshot(invalid, collision), /duplicate/);
    assert.throws(() => engine.restoreSnapshot(data, { rename_pattern: "(a)\\1", rename_replacement: "$1" }), /RE2/);
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("snapshot export and restore enforce FGAC without filtering private documents into backups", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-snapshot-fgac-")), engine = new EmbeddedSearchEngine(join(root, "search.sqlite"));
  try {
    engine.createIndex("records", {});
    const identity = { name: "restricted", backendRoles: [] }, restricted = new SearchAccess(identity, false, [{ cluster_permissions: ["*"], index_permissions: [{ index_patterns: ["*"], allowed_actions: ["*"], dls: JSON.stringify({ term: { tenant: "a" } }), fls: ["visible"] }] }], "1");
    assert.throws(() => engine.exportSnapshot({}, restricted), /Restricted|unrestricted/);
    const data = engine.exportSnapshot({ include_global_state: false });
    assert.throws(() => engine.validateSnapshotRestore(data, { rename_pattern: ".+", rename_replacement: "restored" }, restricted), /Restricted|unrestricted/);
    const empty = new SearchAccess(identity, false, [], "2"); assert.throws(() => engine.exportSnapshot({}, empty), /No permissions/);
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("encrypted snapshot intent survives reopening and restore completion is committed with restored documents", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-snapshot-durable-")), file = join(root, "search.enc"), keyFile = join(root, "search.key");
  let engine = new EmbeddedSearchEngine(file, Date.now, { keyFile });
  try {
    await engine.request("PUT", "/records/_doc/id", Buffer.from(JSON.stringify({ value: "snapshot-secret-574be8" })), "test");
    const data = engine.exportSnapshot({}), job = { id: "job", state: "IN_PROGRESS" };
    engine.stageSnapshot(job, data); engine.close();
    for (const path of [file, ...(await readdir(`${file}.journal`)).map(name => join(`${file}.journal`, name))]) assert.equal((await readFile(path)).includes(Buffer.from("snapshot-secret-574be8")), false);
    engine = new EmbeddedSearchEngine(file, Date.now, { keyFile }); assert.equal(engine.snapshotRecord("job", "job")?.state, "IN_PROGRESS");
    engine.restoreSnapshot(engine.stagedSnapshot("job"), { rename_pattern: ".+", rename_replacement: "recovered" }, job); engine.close();
    engine = new EmbeddedSearchEngine(file, Date.now, { keyFile }); assert.equal(engine.snapshotRecord("job", "job")?.state, "SUCCESS"); assert.throws(() => engine.stagedSnapshot("job"), /missing/);
    assert.equal((await engine.request("GET", "/recovered/_doc/id", Buffer.alloc(0), "test")).body._source.value, "snapshot-secret-574be8");
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});
