import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { StackSim } from "../src/server.js";
import { TestClock } from "../src/core/clock.js";
import { RecoveryLab } from "../examples/sqs-recovery-lab/lab.js";

test("Scenario H deploys, retries, diagnoses, fixes, redrives, verifies application processing, cancels and resets using SDKs", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-recovery-lab-")); const clock = new TestClock(Date.now());
  const sim = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "enforce", cdkBootstrap: true, clock });
  let lab: RecoveryLab | undefined;
  // Only scheduler time is advanced; setImmediate yields to filesystem, sockets and Lambda workers.
  async function until(predicate: () => Promise<boolean>) {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (await predicate()) return; clock.advance(250); await setImmediate(); }
    throw new Error(`Learning checkpoint timed out: ${JSON.stringify(await lab?.status())}; ${JSON.stringify(await lab?.logEvents().catch(e => e.message))}`);
  }
  try {
    await sim.start(); lab = new RecoveryLab({ endpoint: `http://127.0.0.1:${sim.port}`, prefix: "lesson" });
    await lab.deploy(); await lab.send();
    const apiResult = await lab.sendApi(); assert.equal(apiResult.status, 200);
    await until(async () => (await lab!.status()).dlq?.ApproximateNumberOfMessages === "1");
    await lab.verify("normal-1"); await lab.verify("delayed-1"); await lab.verify("api-1");
    await assert.rejects(lab.verify(), /not been successfully processed/);
    const inspected = await lab.inspect(); const failedMessage = inspected.Messages![0]; assert.equal(JSON.parse(failedMessage.Body!).jobId, "poison-1"); assert.equal(failedMessage.Attributes?.DeadLetterQueueSourceArn, (await lab.queues()).sourceArn);
    const logs = await lab.logEvents(); assert.ok(logs.some(e => e.message?.includes("Consumer v1 rejects"))); assert.ok(logs.some(e => e.message?.includes('"attempt":"2"')));
    await lab.fix(); await lab.redrive();
    await until(async () => (await lab!.tasks()).Results?.[0].Status === "COMPLETED");
    await until(async () => { try { await lab!.verify(); return true; } catch { return false; } });
    const processed = await lab.verify(); assert.notEqual(processed!.transportId.S, failedMessage.MessageId);
    // Replay a stable application key through ordinary SDK sends: the conditional ledger prevents a second effect.
    await lab.send(); await until(async () => (await lab!.logEvents()).some(e => e.message?.includes("ALREADY_PROCESSED")));
    await lab.fix(false); await lab.send(6);
    await until(async () => Number((await lab!.status()).dlq?.ApproximateNumberOfMessages) === 6);
    await lab.fix(); await lab.redrive(1); await sim.sqs.runMessageMoveTasks();
    await lab.cancel(); await sim.sqs.runMessageMoveTasks();
    const cancelled = (await lab.tasks()).Results![0]; assert.equal(cancelled.Status, "CANCELLED"); assert.ok(cancelled.ApproximateNumberOfMessagesMoved! < 6); assert.ok(cancelled.ApproximateNumberOfMessagesMoved! >= 1);
    await lab.redrive(10); await until(async () => (await lab!.tasks()).Results?.[0].Status === "COMPLETED");
    await until(async () => { try { await lab!.verify("bulk-5"); return true; } catch { return false; } });
    await lab.reset(); await assert.rejects(lab.verify(), /not been successfully processed/); assert.equal((await lab.status()).dlq?.ApproximateNumberOfMessages, "0");
    await lab.cleanup(); await assert.rejects(lab.queues());
  } finally { lab?.close(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
