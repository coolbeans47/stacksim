import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { EventBridgeDeliveryStore, type EventBridgeDelivery } from "../src/eventbridge/delivery-store.js";
import type { ServiceIntegrationAttemptState } from "../src/types.js";

function delivery(id: string): EventBridgeDelivery {
  return { id, eventId: `event-${id}`, eventBusName: "default", eventSourceName: "test", ruleName: "rule", ruleArn: "arn:aws:events:eu-west-1:000000000000:rule/rule", targetId: "target", targetArn: "arn:aws:lambda:eu-west-1:000000000000:function:target", payload: JSON.stringify({ id }), enqueuedAt: 1, nextAttemptAt: 1, attempts: 0, maximumEventAgeSeconds: 86_400, maximumRetryAttempts: 185, status: "QUEUED" };
}

test("EventBridge delivery journal repairs a torn tail before accepting later durable appends", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-eventbridge-journal-"));
  const journal = join(root, "data", "eventbridge", "000000000000", "eu-west-1", "deliveries.jsonl");
  try {
    await mkdir(dirname(journal), { recursive: true });
    await writeFile(journal, `${JSON.stringify({ op: "put", delivery: delivery("first") })}\n{"op":"put"`, "utf8");
    const recovered = new EventBridgeDeliveryStore(root, "000000000000", "eu-west-1"); await recovered.start();
    assert.deepEqual(recovered.list().map(item => item.id), ["first"]);
    await recovered.put(delivery("second")); await recovered.stop();
    assert.match(await readFile(journal, "utf8"), /"id":"second"/);

    const restarted = new EventBridgeDeliveryStore(root, "000000000000", "eu-west-1"); await restarted.start();
    assert.deepEqual(restarted.list().map(item => item.id).sort(), ["first", "second"]); await restarted.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("EventBridge integration entry acceptance is one torn-tail-safe journal transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-eventbridge-integration-transaction-")); const journal = join(root, "data", "eventbridge", "000000000000", "eu-west-1", "deliveries.jsonl"); const attempt: ServiceIntegrationAttemptState = { attemptId: "attempt:entry:0", inputDigest: "input", operation: "putEvents:entry:0", targetArn: "arn:aws:events:eu-west-1:000000000000:event-bus/default", executionArn: "arn:aws:states:eu-west-1:000000000000:execution:parent:run", stateMachineArn: "arn:aws:states:eu-west-1:000000000000:stateMachine:parent", roleArn: "arn:aws:iam::000000000000:role/workflow", sourceArn: "arn:aws:states:eu-west-1:000000000000:stateMachine:parent", lineage: [], status: "ACCEPTED", acceptedAt: 1, output: { EventId: "event-entry" } };
  try {
    await mkdir(dirname(journal), { recursive: true }); const transaction = JSON.stringify({ op: "accept-integration-entry", deliveries: [delivery("entry")], diagnostics: [], attempt }); await writeFile(journal, transaction.slice(0, -20), "utf8"); const recovered = new EventBridgeDeliveryStore(root, "000000000000", "eu-west-1"); await recovered.start(); assert.deepEqual(recovered.list(), []); assert.equal(recovered.integrationAttempt(attempt.attemptId), undefined, "a torn transaction retains neither delivery nor receipt"); await recovered.putMany([delivery("entry")], [], attempt); await recovered.stop(); const lines = (await readFile(journal, "utf8")).trim().split(/\r?\n/); assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0]).op, "accept-integration-entry"); const restarted = new EventBridgeDeliveryStore(root, "000000000000", "eu-west-1"); await restarted.start(); assert.deepEqual(restarted.list().map(item => item.id), ["entry"]); assert.deepEqual(restarted.integrationAttempt(attempt.attemptId)?.output, { EventId: "event-entry" }); await restarted.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});
