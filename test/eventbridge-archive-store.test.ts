import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventBridgeArchiveStore } from "../src/eventbridge/archive-store.js";

const account = "000000000000"; const region = "eu-west-1"; const now = Date.parse("2026-08-08T12:00:00Z");
function metadata(name: string) { return { name, arn: `arn:aws:events:${region}:${account}:archive/${name}`, eventSourceArn: `arn:aws:events:${region}:${account}:event-bus/default`, eventBusName: "default", retentionDays: 0, state: "ENABLED" as const, createdAt: now, lastModified: now }; }
function event(id: string, time = now) { return JSON.stringify({ version: "0", id, "detail-type": "Recovery", source: "store.test", account, time: new Date(time).toISOString(), region, resources: [], detail: { id } }); }

test("archive store recovers renamed orphan segments, removes torn temporaries, diagnoses corruption, and cleans exact ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-archive-store-")); const key = Buffer.alloc(32, 7);
  try {
    let store = new EventBridgeArchiveStore(root, account, region, key); await store.start(now); await store.createArchive(metadata("first")); await store.createArchive(metadata("second"));
    const originalPersist = (store as any).persist.bind(store); let failControl = true; (store as any).persist = async (value: unknown) => { if (failControl) { failControl = false; throw new Error("injected control publication fault"); } return originalPersist(value); };
    await assert.rejects(store.publish(["first"], event("orphan"), now), /injected control publication fault/); await store.stop();
    const temporary = join(store.segmentsDirectory, "incomplete.seg.tmp-injected"); await writeFile(temporary, "partial");

    store = new EventBridgeArchiveStore(root, account, region, key); await store.start(now); assert.equal(store.archive("first")?.records.length, 1, "committed segment is re-indexed after interrupted control publication"); await assert.rejects(access(temporary));
    await store.publish(["second"], event("kept"), now); const secondSegment = store.archive("second")!.records[0].segment; await store.deleteArchive("first"); assert.equal((await readdir(store.segmentsDirectory)).includes(secondSegment), true, "deleting one archive preserves another archive's segment");

    await store.createArchive({ ...metadata("retention"), retentionDays: 1 }); await store.publish(["retention"], event("expired", now - 2 * 24 * 60 * 60 * 1_000), now); const expiredSegment = store.archive("retention")!.records[0].segment;
    const committedMutate = (store as any).mutate.bind(store); let failSweep = true; (store as any).mutate = async (work: unknown) => { const result = await committedMutate(work); if (failSweep) { failSweep = false; throw new Error("injected retention cleanup fault"); } return result; };
    await assert.rejects(store.reconcile(now), /retention cleanup fault/); await access(join(store.segmentsDirectory, expiredSegment)); await store.stop();
    store = new EventBridgeArchiveStore(root, account, region, key); await store.start(now); assert.equal((await readdir(store.segmentsDirectory)).includes(expiredSegment), false, "restart reclaims an unreferenced segment after an interrupted retention sweep");

    await writeFile(join(store.segmentsDirectory, secondSegment), "corrupt"); await store.stop(); store = new EventBridgeArchiveStore(root, account, region, key); await store.start(now); const diagnosed = store.archive("second")!; assert.equal(diagnosed.state, "DISABLED"); assert.match(diagnosed.stateReason ?? "", /corrupt or incomplete/); assert.equal(diagnosed.records.length, 0); assert.doesNotMatch(await readFile(store.controlFile, "utf8"), /store\.test|\"kept\"/, "control/index never contains event payloads"); await store.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("archive store persists cancellation across restart and releases only future replay work", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-replay-cancel-store-")); const key = Buffer.alloc(32, 8);
  try {
    let store = new EventBridgeArchiveStore(root, account, region, key); await store.start(now); await store.createArchive(metadata("cancel"));
    await store.createReplay({ name: "cancelled-after-restart", arn: `arn:aws:events:${region}:${account}:replay/cancelled-after-restart`, archiveName: "cancel", eventSourceArn: metadata("cancel").eventSourceArn, destinationArn: metadata("cancel").eventSourceArn, eventStartTime: now - 1_000, eventEndTime: now + 1_000, state: "STARTING", replayStartTime: now });
    const leased = await store.leaseReplay("cancelled-after-restart", now, 30_000); assert(leased?.leaseId); await store.requestCancel("cancelled-after-restart"); await store.stop();
    store = new EventBridgeArchiveStore(root, account, region, key); await store.start(now); const resumed = await store.leaseReplay("cancelled-after-restart", now, 30_000); assert(resumed?.leaseId); assert.equal(resumed.cancelRequested, true);
    await store.finishEmptyReplay(resumed.name, resumed.leaseId, now); assert.equal(store.replay(resumed.name)?.state, "CANCELLED"); await store.reconcile(now + 91 * 24 * 60 * 60 * 1_000); assert.equal(store.replay(resumed.name), undefined, "terminal replay history expires after 90 days"); await store.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});
