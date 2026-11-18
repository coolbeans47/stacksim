import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIngestionConfig, renderIngestionFormat, transformIngestionEvent } from "../src/opensearch/ingestion/config.js";
import { IngestionBuffer } from "../src/opensearch/ingestion/buffer.js";

const template = (extra = "") => `version: "2"
logs:
  source:
    http:
      path: /\${pipelineName}/ingest
  processor:
    - parse_json:
        source: message
        destination: parsed
    - convert_type:
        key: parsed/status
        type: integer
    - rename_keys:
        entries:
          - from_key: parsed/user
            to_key: customer
    - add_entries:
        entries:
          - key: deployment
            value: local
    - delete_entries:
        with_keys: [message, secret]
  sink:
    - opensearch:
        hosts: ["https://127.0.0.1:48000"]
        aws:
          region: eu-west-1
          sts_role_arn: arn:aws:iam::000000000000:role/Pipeline
        index: events
        document_id: "\${/customer}"
${extra}`;

test("ingestion YAML compiles executable transformations and rejects unsupported options before delivery", () => {
  const config = parseIngestionConfig(template()); assert.equal(config.path, "/logs/ingest");
  const source = { message: '{"status":"200","user":"alice"}', secret: "redact" };
  const result = transformIngestionEvent(config, source);
  assert.deepEqual(result, { parsed: { status: 200 }, customer: "alice", deployment: "local" }); assert.ok(source.secret);
  assert.equal(renderIngestionFormat(config.sink.documentId!, result), "alice");
  assert.throws(() => renderIngestionFormat("${/missing}", result), /missing or not scalar/);
  assert.throws(() => transformIngestionEvent(config, { message: "invalid json" }), /invalid JSON/);
  assert.throws(() => transformIngestionEvent(config, { message: '{"status":"2147483648"}' }), /outside the supported range/);
  for (const text of [template().replace('version: "2"', 'version: "3"'), template().replace("parse_json:", "script:"), template().replace("key: deployment", "key: __proto__/polluted"), template().replace("index: events", "index: events-%{yyyy.MM.dd}"), template().replace("path: /${pipelineName}/ingest", "path: 3"), template().replace('hosts: ["https://127.0.0.1:48000"]', 'hosts: ["http://remote.example.com"]'), template().replace("source: message", "source: message\n        unknown: yes"), template().replace("path: /${pipelineName}/ingest", "path: /../escape"), template().replace("logs:", "logs: &alias"), template("other: {}")]) assert.throws(() => parseIngestionConfig(text), { code: "ValidationException" });
  assert.throws(() => parseIngestionConfig(template(), "arn:aws:iam::000000000000:role/Different"), /must match/);
  const overwritten = structuredClone(config); overwritten.processors = [{ kind: "add_entries", config: { entries: [{ key: "x", value: 2 }] } }, { kind: "rename_keys", config: { entries: [{ from_key: "x", to_key: "y" }] } }];
  assert.deepEqual(transformIngestionEvent(overwritten, { x: 1, y: 3 }), { x: 1, y: 3 });
});

test("ingestion buffer encrypts acknowledged batches, persists partial delivery and backpressure, and fails closed without its key", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-osis-buffer-")), file = join(root, "generation", "buffer.enc"), key = join(root, "secret", "key");
  let buffer = new IngestionBuffer(file, key, 3, 100000);
  const config = parseIngestionConfig(template()), secret = "durable-encrypted-ingestion-7dd00";
  const files = async (directory: string): Promise<string[]> => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
  try {
    const ids = buffer.accept([{ message: secret }, { message: "second" }, { message: "third" }], config, 100);
    await assert.rejects(async () => buffer.accept([{ message: "overflow" }], config, 100), { status: 429 }); assert.equal(buffer.stats().accepted, 3);
    const pending = buffer.due(100, 10); buffer.delivered(ids[0]); const second = pending.find(event => event.id === ids[1])!, third = pending.find(event => event.id === ids[2])!;
    buffer.retry(second, 100, "temporarily unavailable"); buffer.retry(third, 100, "mapping rejected", true);
    assert.equal(buffer.due(100, 10).length, 0); assert.equal(buffer.stats().delivered, 1); assert.equal(buffer.stats().failed, 1);
    buffer.close(); buffer = new IngestionBuffer(file, key, 3, 100000);
    assert.equal(buffer.due(1099, 10).length, 0); assert.deepEqual(buffer.due(1100, 10).map(event => event.id), [ids[1]]);
    assert.equal(buffer.failures()[0].id, ids[2]); assert.equal(buffer.stats().deliveryFailures, 2);
    assert.deepEqual(buffer.due(1100, 10)[0].config, config);
    buffer.delivered(ids[1]); buffer.delivered(ids[1]); buffer.delivered(ids[2], true); assert.equal(buffer.stats().buffered, 0); assert.equal(buffer.stats().delivered, 2); assert.equal(buffer.stats().deadLettered, 1);
    for (const path of await files(root)) assert.equal((await readFile(path)).includes(Buffer.from(secret)), false, path);
    buffer.close(); await rm(key); assert.throws(() => new IngestionBuffer(file, key), /key is unavailable/);
  } finally { buffer.close(); await rm(root, { recursive: true, force: true }); }
});
