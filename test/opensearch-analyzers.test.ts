import assert from "node:assert/strict";
import { test } from "node:test";
import { compileAnalysis, customTokens } from "../src/opensearch/analyzers.js";
import { compileQuery, type Candidate } from "../src/opensearch/query.js";
import { EmbeddedSearchEngine } from "../src/opensearch/engine.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("custom dictionary analysis preserves offsets, position gaps, ordering and synonym alternatives", () => {
  const dictionary = (id: string) => id === "F123" ? { version: "1", text: "# fruit\r\napple, fruit\npear => fruit\n__proto__, safe\n" } : undefined;
  const analysis = compileAnalysis({ analyzer: { custom: { type: "custom", tokenizer: "standard", filter: ["lowercase", "stopper", "synonyms"] } }, filter: { stopper: { type: "stop", stopwords: ["a", "the"] }, synonyms: { type: "synonym", synonyms_path: "analyzers/F123", updateable: true } } }, dictionary);
  const tokens = customTokens("The APPLE and pear", analysis.custom);
  assert.deepEqual(tokens.map(token => [token.token, token.position, token.start_offset, token.end_offset]), [["apple", 1, 4, 9], ["fruit", 1, 4, 9], ["and", 2, 10, 13], ["fruit", 3, 14, 18]]);
  const canonical = compileAnalysis({ analyzer: { canonical: { type: "custom", tokenizer: "whitespace", filter: ["synonyms"] } }, filter: { synonyms: { type: "synonym", synonyms: ["alpha, beta", "__proto__, safe"], expand: false } } }, dictionary);
  assert.deepEqual(customTokens("beta safe", canonical.canonical).map(token => token.token), ["alpha", "__proto__"]);
  assert.equal(({} as any).safe, undefined);
  const doc: Candidate = { _index: "fruit", _id: "one", _source: { title: "fruit and pear" }, _score: 0, _seq_no: 0, _primary_term: 1, _version: 1, mappings: { properties: { title: { type: "text", analyzer: "standard", search_analyzer: "custom" } } }, analysis };
  assert.equal(compileQuery({ match: { title: { query: "apple pear", operator: "and" } } })(doc), 2);
  assert.equal(compileQuery({ match_phrase: { title: "apple and pear" } })(doc), null);
  assert.equal(compileQuery({ match_phrase: { title: "apple and fruit" } })(doc), null);
  doc._source.title = "fruit and fruit"; assert.equal(compileQuery({ match_phrase: { title: "apple and pear" } })(doc), 3);
});

test("custom analysis rejects missing packages, executable/native filters and unbounded expansion", () => {
  const base = { analyzer: { custom: { type: "custom", tokenizer: "standard", filter: ["words"] } }, filter: { words: { type: "stop", stopwords_path: "analyzers/F999" } } };
  assert.throws(() => compileAnalysis(base, () => undefined), /not associated/);
  for (const path of ["/etc/passwd", "analyzers/../../secret", "https://remote/file"]) assert.throws(() => compileAnalysis({ ...base, filter: { words: { type: "stop", stopwords_path: path } } }, () => undefined), /Dictionary paths/);
  for (const filter of [{ type: "script" }, { type: "synonym", synonyms: ["ice cream, gelato"] }, { type: "synonym", synonyms: ["a => b => c"] }, { type: "synonym", synonyms: [Array.from({ length: 33 }, (_, i) => `s${i}`).join(",")] }, { type: "stop", stopwords: ["a"], stopwords_path: "analyzers/F999" }]) assert.throws(() => compileAnalysis({ ...base, filter: { words: filter } }, () => undefined));
  assert.throws(() => compileAnalysis(base, () => ({ version: "1", text: "x".repeat(65537) })), /64 KiB/);
  const analysis = compileAnalysis({ analyzer: { custom: { type: "custom", tokenizer: "whitespace", filter: [] } } }, () => undefined);
  assert.throws(() => customTokens("x ".repeat(65537), analysis.custom), /65536/);
});

test("embedded indexes execute custom analyzers, refresh updateable search dictionaries and retain pinned index versions across restart and snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-analysis-")), file = join(root, "search.enc"), keyFile = join(root, "key"); let engine = new EmbeddedSearchEngine(file, Date.now, { keyFile });
  const call = async (method: string, path: string, body: any = {}) => (await engine.request(method, path, Buffer.from(JSON.stringify(body)), "admin")).body;
  const settings = (updateable: boolean) => ({ analysis: { analyzer: { words: { type: "custom", tokenizer: "standard", filter: ["lowercase", "dictionary"] } }, filter: { dictionary: { type: "synonym", synonyms_path: "analyzers/F123", updateable } } } });
  const count = async (index: string, word: string) => (await call("POST", `/${index}/_search`, { query: { match: { title: word } } })).hits.total.value;
  try {
    await assert.rejects(call("PUT", "/missing", { settings: settings(true) }), /not associated/);
    engine.installDictionary("F123", "1", "apple, fruit\n");
    await call("PUT", "/default-analysis", { settings: { analysis: { analyzer: { default: { type: "custom", tokenizer: "whitespace", filter: [] }, default_search: { type: "custom", tokenizer: "whitespace", filter: ["lowercase"] } } } } });
    await call("PUT", "/default-analysis/_doc/one?refresh=true", { title: "two-words", category: "Fruit" });
    assert.equal(await count("default-analysis", "TWO-WORDS"), 1); assert.equal((await call("POST", "/default-analysis/_search", { query: { term: { title: "two-words" } } })).hits.total.value, 1);
    assert.deepEqual((await call("POST", "/default-analysis/_analyze", { text: "TWO-WORDS" })).tokens.map((token: any) => token.token), ["TWO-WORDS"]);
    assert.deepEqual((await call("POST", "/default-analysis/_analyze", { text: "TWO-WORDS", field: "title" })).tokens.map((token: any) => token.token), ["TWO-WORDS"]);
    await assert.rejects(call("POST", "/default-analysis/_analyze", { text: ["x ".repeat(32768), "x ".repeat(32769)] }), /65536/);
    await assert.rejects(call("PUT", "/bad-default-analyzer", { settings: { analysis: { analyzer: { default: { type: "custom", tokenizer: "standard", filter: ["dictionary"] } }, filter: settings(true).analysis.filter } } }), /only in search analyzers/);
    await call("PUT", "/live", { settings: settings(true), mappings: { properties: { title: { type: "text", analyzer: "standard", search_analyzer: "words" } } } });
    await assert.rejects(call("PUT", "/bad-index-analyzer", { settings: settings(true), mappings: { properties: { title: { type: "text", analyzer: "words" } } } }), /only in search analyzers/);
    await call("PUT", "/pinned", { settings: settings(false), mappings: { properties: { title: { type: "text", analyzer: "words" } } } });
    for (const index of ["live", "pinned"]) await call("PUT", `/${index}/_doc/one?refresh=true`, { title: "APPLE" });
    assert.equal(await count("live", "fruit"), 1); assert.equal(await count("pinned", "fruit"), 1);
    const analyzed = await call("POST", "/live/_analyze", { text: "APPLE", analyzer: "words" }); assert.deepEqual(analyzed.tokens.map((token: any) => token.token), ["apple", "fruit"]);
    engine.installDictionary("F123", "2", "apple, pear\n"); assert.equal(await count("live", "fruit"), 0); assert.equal(await count("live", "pear"), 1); assert.equal(await count("pinned", "fruit"), 1);
    assert.throws(() => engine.installDictionary("F123", "3", "ice cream, gelato\n"), /single terms/); assert.equal(await count("live", "pear"), 1);
    assert.throws(() => engine.removeDictionary("F123"), /still reference/);
    await call("PUT", "/new-index", { settings: settings(false), mappings: { properties: { title: { type: "text", analyzer: "words" } } } }); await call("PUT", "/new-index/_doc/one?refresh=true", { title: "apple" }); assert.equal(await count("new-index", "fruit"), 0);
    await assert.rejects(call("PUT", "/pinned/_settings", settings(true)), /immutable/);
    await assert.rejects(call("POST", "/live/_search", { query: { match: { title: { query: "apple", analyzer: "unknown" } } } }), /not implemented/);
    assert.equal((await call("POST", "/live/_count", { query: { match: { title: { query: "pear", analyzer: "words" } } } })).count, 1);
    const snapshot = engine.exportSnapshot({ indices: "pinned" }); assert.equal(snapshot.indexes[0].packageVersions?.F123, "1");
    engine.close(); engine = new EmbeddedSearchEngine(file, Date.now, { keyFile }); engine.installDictionary("F123", "1", "apple, fruit\n", false); engine.installDictionary("F123", "2", "apple, pear\n", false); engine.validateAnalysis();
    assert.equal(await count("pinned", "fruit"), 1); assert.equal(await count("live", "pear"), 1);
    engine.restoreSnapshot(snapshot, { rename_pattern: "pinned", rename_replacement: "restored" }); assert.equal(await count("restored", "fruit"), 1);
    const target = new EmbeddedSearchEngine(join(root, "target.db")); try { assert.throws(() => target.restoreSnapshot(snapshot, {}), /not associated/); } finally { target.close(); }
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});
