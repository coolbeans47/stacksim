import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EmbeddedSearchEngine } from "../src/opensearch/engine.js";

const request = async (engine: EmbeddedSearchEngine, method: string, path: string, body?: unknown) => (await engine.request(method, path, Buffer.from(body === undefined ? "" : JSON.stringify(body)), "test")).body;
async function scan(directory: string, forbidden: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path, forbidden);
    else {
      const bytes = await readFile(path);
      for (const text of forbidden) assert.equal(bytes.includes(Buffer.from(text)), false, `${entry.name} exposes ${text}`);
      assert.equal(bytes.includes(Buffer.from("SQLite format 3")), false);
      assert.equal(/sqlite|wal|shm$/.test(entry.name), false);
    }
  }
}

test("encrypted search persists metadata, source and refresh visibility without plaintext files, then compacts and reopens", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-encryption-"));
  const file = join(root, "generation", "search.enc"), keyFile = join(root, "secrets", "key");
  let engine = new EmbeddedSearchEngine(file, () => 0, { keyFile });
  try {
    await request(engine, "PUT", "/private-index", { settings: { refresh_interval: "-1" }, mappings: { properties: { secret_field: { type: "keyword" } } }, aliases: { "private-alias": {} } });
    await request(engine, "PUT", "/private-alias/_doc/secret-id", { secret_field: "CONFIDENTIAL_PAYLOAD" });
    assert.equal((await request(engine, "POST", "/private-index/_count")).count, 0);
    for (let n = 0; n < 130; n++) await request(engine, "PUT", `/private-index/_doc/${n}`, { secret_field: "CONFIDENTIAL_PAYLOAD" });
    assert.ok((await readdir(`${file}.journal`)).length < 128);
    await scan(join(root, "generation"), ["private-index", "private-alias", "secret-id", "secret_field", "CONFIDENTIAL_PAYLOAD"]);
    engine.close(); engine = new EmbeddedSearchEngine(file, () => 0, { keyFile });
    assert.equal((await request(engine, "POST", "/private-index/_count")).count, 0);
    assert.equal((await request(engine, "GET", "/private-alias/_doc/secret-id"))._source.secret_field, "CONFIDENTIAL_PAYLOAD");
    await request(engine, "POST", "/private-index/_refresh");
    engine.close(); engine = new EmbeddedSearchEngine(file, () => 0, { keyFile });
    assert.equal((await request(engine, "POST", "/private-index/_count")).count, 131);
    await request(engine, "DELETE", "/private-index/_doc/secret-id");
    engine.close(); engine = new EmbeddedSearchEngine(file, () => 0, { keyFile });
    assert.equal((await request(engine, "GET", "/private-index/_doc/secret-id")).found, false);
    assert.equal((await request(engine, "POST", "/private-index/_count")).count, 131);
    await scan(join(root, "generation"), ["CONFIDENTIAL_PAYLOAD", "secret_field"]);
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("encrypted storage fails closed for missing keys, tampering, missing journal records and cross-resource copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-encryption-deny-"));
  const file = join(root, "generation", "search.enc"), keyFile = join(root, "secrets", "key");
  const engine = new EmbeddedSearchEngine(file, () => 0, { keyFile });
  try {
    await request(engine, "PUT", "/private", {});
    await request(engine, "PUT", "/private/_doc/1", { message: "secret" });
    engine.close();
    await rename(keyFile, `${keyFile}.backup`);
    assert.throws(() => new EmbeddedSearchEngine(file, () => 0, { keyFile }), /key is unavailable/);
    await rename(`${keyFile}.backup`, keyFile);
    const records = (await readdir(`${file}.journal`)).sort();
    const record = join(`${file}.journal`, records[0]);
    const saved = await readFile(record);
    const corrupt = Buffer.from(saved); corrupt[corrupt.length - 1] ^= 1;
    await writeFile(record, corrupt);
    assert.throws(() => new EmbeddedSearchEngine(file, () => 0, { keyFile }), /could not be authenticated/);
    await writeFile(record, saved);
    await rename(record, `${record}.saved`);
    assert.throws(() => new EmbeddedSearchEngine(file, () => 0, { keyFile }), /missing transaction/);
    await rename(`${record}.saved`, record);
    const last = join(`${file}.journal`, records.at(-1)!);
    await rename(last, `${last}.saved`);
    assert.throws(() => new EmbeddedSearchEngine(file, () => 0, { keyFile }), /missing transaction/);
    await rename(`${last}.saved`, last);
    await rename(join(root, "generation"), join(root, "other-generation"));
    assert.throws(() => new EmbeddedSearchEngine(join(root, "other-generation", "search.enc"), () => 0, { keyFile }), /could not be authenticated/);
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});

test("encrypted acknowledged writes survive forced process termination without plaintext recovery files", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-os-encrypted-crash-"));
  const file = join(root, "generation", "search.enc"), keyFile = join(root, "secrets", "key");
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const child = fork(new URL(`./fixtures/opensearch-crash-writer.${extension}`, import.meta.url), [file, keyFile], { execArgv: extension === "ts" ? ["--import", "tsx"] : [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = "", engine: EmbeddedSearchEngine | undefined;
  child.stderr?.on("data", chunk => errors += chunk);
  const exit = once(child, "exit");
  try {
    const message = await Promise.race([once(child, "message"), exit.then(() => { throw new Error(errors); })]);
    assert.equal(message[0], "acknowledged"); child.kill("SIGKILL"); await exit;
    await scan(join(root, "generation"), ["Acknowledged before a forced process exit", "surviving", "durable"]);
    engine = new EmbeddedSearchEngine(file, Date.now, { keyFile });
    assert.equal((await request(engine, "GET", "/surviving/_doc/acknowledged"))._version, 1);
    await request(engine, "POST", "/durable/_refresh");
    assert.equal((await request(engine, "POST", "/surviving/_count")).count, 1);
  } finally { child.kill(); await exit; engine?.close(); await rm(root, { recursive: true, force: true }); }
});
