import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { TestClock } from "../src/core/clock.js";
import { XRayDefaultSampler } from "../src/xray/sampling.js";
import { validateSegmentDocument } from "../src/xray/segment-document.js";
import { XRayTraceStore } from "../src/xray/trace-store.js";
import { formatTraceHeader, generateSegmentId, generateTraceId, parseTraceHeader } from "../src/xray/trace-header.js";

const account = "000000000000";
const region = "eu-west-1";
const traceId = "1-66aa0000-000000000000000000000001";

function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: "orders", trace_id: traceId, id: "0000000000000001", start_time: 2_000, end_time: 2_001, annotations: { release: "one" }, http: { response: { status: 200 } }, ...overrides });
}

test("XRY-01 trace headers validate canonical IDs, preserve bounded extras, and generate deterministic IDs", () => {
  const parsed = parseTraceHeader(`Root=${traceId};Parent=0000000000000002;Sampled=1;Vendor=value`);
  assert.deepEqual(parsed, { root: traceId, parent: "0000000000000002", decision: "sampled", extras: [{ key: "Vendor", value: "value" }], valid: true });
  assert.equal(formatTraceHeader(parsed), `Root=${traceId};Parent=0000000000000002;Sampled=1;Vendor=value`);
  assert.equal(parseTraceHeader(`Root=${traceId};Root=${traceId};Sampled=1`).valid, false);
  assert.equal(parseTraceHeader(`Root=${traceId};Sampled=2`).valid, false);
  assert.equal(parseTraceHeader("x".repeat(257)).valid, false);
  const bytes = (size: number) => Buffer.alloc(size, 0xab);
  assert.equal(generateTraceId(0x66aa0000 * 1_000, bytes), "1-66aa0000-abababababababababababab");
  assert.equal(generateSegmentId(bytes), "abababababababab");
});

test("XRY-01 default sampler honors parents and deterministically applies one-per-second plus five percent", () => {
  const clock = new TestClock(10_000); const values = [0.049, 0.05, 0.0]; const sampler = new XRayDefaultSampler(clock, () => values.shift() ?? 1);
  assert.deepEqual(sampler.decide(account, region, true, "sampled"), { sampled: true, source: "upstream" });
  assert.deepEqual(sampler.decide(account, region, true, "not-sampled"), { sampled: false, source: "upstream" });
  assert.deepEqual(sampler.decide(account, region, false, "undecided"), { sampled: false, source: "passive" });
  assert.equal(sampler.decide(account, region, true, "undecided").sampled, true, "first undecided request consumes the reservoir");
  assert.equal(sampler.decide(account, region, true, "undecided").sampled, true, "random below five percent is sampled");
  assert.equal(sampler.decide(account, region, true, "undecided").sampled, false, "five percent is an exclusive boundary");
  assert.equal(sampler.decide(account, "us-east-1", true, "undecided").sampled, true, "reservoirs are regional");
  assert.equal(sampler.decide("111111111111", region, true, "undecided").sampled, true, "reservoirs are account isolated");
  clock.advance(1_000);
  assert.equal(sampler.decide(account, region, true, "undecided").sampled, true, "the reservoir resets in the next second");
});

test("XRY-01 segment validation covers completion, independent subsegments, bounds, idempotency, and finality", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-xray-core-")); const clock = new TestClock(2_000_000); let store = new XRayTraceStore(root, account, region, () => clock.now(), { maximumTraces: 2, maximumSegments: 3, maximumDocumentBytes: 200_000, retentionMs: 1_000 });
  try {
    await store.start();
    assert.equal(store.ingest(validateSegmentDocument(document())).duplicate, false);
    assert.equal(store.ingest(validateSegmentDocument(document())).duplicate, true);
    assert.throws(() => store.ingest(validateSegmentDocument(document({ end_time: 2_002 }))), (error: any) => error.code === "ConflictException");
    const inProgress = document({ id: "0000000000000002", end_time: undefined, in_progress: true });
    store.ingest(validateSegmentDocument(inProgress));
    store.ingest(validateSegmentDocument(document({ id: "0000000000000002", end_time: 2_003, in_progress: false })));
    assert.equal(store.health().segmentCount, 2);
    const child = document({ id: "0000000000000003", type: "subsegment", parent_id: "0000000000000001", name: "worker" });
    store.ingest(validateSegmentDocument(child));
    assert.deepEqual(store.edges([traceId]), [{ traceId, sourceId: "0000000000000001", destinationId: "0000000000000003" }]);
    assert.throws(() => store.ingest(validateSegmentDocument(document({ trace_id: "1-66aa0000-000000000000000000000099", id: "0000000000000099" }))), (error: any) => error.code === "ThrottledException");
    assert.equal(store.health().status, "capacity-limited");
    assert.throws(() => validateSegmentDocument(JSON.stringify({ ...JSON.parse(document()), id: "bad" })), (error: any) => error.code === "InvalidRequestException");
    assert.throws(() => validateSegmentDocument(document({ end_time: 1_999 })), (error: any) => error.code === "InvalidRequestException");
    assert.throws(() => validateSegmentDocument("x".repeat(65_537)), (error: any) => error.code === "InvalidRequestException");
    await store.stop();
    store = new XRayTraceStore(root, account, region, () => clock.now(), { retentionMs: 1_000 }); await store.start();
    assert.equal(store.getTrace(traceId)?.segments.length, 3, "encrypted trace data survives a restart");
    const otherAccount = new XRayTraceStore(root, "111111111111", region, () => clock.now()); await otherAccount.start(); assert.equal(otherAccount.getTrace(traceId), undefined, "trace repositories are account isolated"); await otherAccount.stop();
    clock.advance(2_000_000); assert.equal(store.cleanup(), 1); assert.equal(store.getTrace(traceId), undefined, "expired traces are removed in bounded cleanup");
    await store.stop();
    await unlink(join(root, "secrets", "xray.key"));
    await assert.rejects(new XRayTraceStore(root, account, region, () => clock.now()).start(), /key is missing/i, "a repository is never silently opened without its matching key");
  } finally { await store.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("XRY-01 authenticated trace corruption is contained and reported without exposing documents", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-xray-corrupt-"));
  let store = new XRayTraceStore(root, account, region, () => 2_000_000);
  try {
    await store.start();
    store.ingest(validateSegmentDocument(document()));
    await store.stop();
    const database = new DatabaseSync(join(root, "data", "xray", account, region, "traces.sqlite3"));
    database.exec("UPDATE segments SET tag=zeroblob(length(tag))");
    database.close();
    store = new XRayTraceStore(root, account, region, () => 2_000_000);
    await store.start();
    assert.equal(store.getTrace(traceId), undefined);
    const health = store.health();
    assert.equal(health.status, "degraded");
    assert.ok(health.errors.length > 0);
    assert.ok(health.errors.every(message => !message.includes('"release":"one"')));
  } finally { await store.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
