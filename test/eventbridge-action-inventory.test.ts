import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENTBRIDGE_ACTION_INVENTORY, EVENTBRIDGE_ACTION_INVENTORY_SOURCE, EVENTBRIDGE_EVB01_ACTIONS, EVENTBRIDGE_EVB04_ACTIONS } from "../src/eventbridge/action-inventory.js";
import { EventBridgeService } from "../src/eventbridge.js";

test("EventBridge action inventory preserves all 57 current core actions and routes EVB-01/EVB-04", () => {
  assert.equal(EVENTBRIDGE_ACTION_INVENTORY_SOURCE.url, "https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_Operations.html");
  assert.equal(EVENTBRIDGE_ACTION_INVENTORY_SOURCE.protocol, "AWS JSON 1.1");
  assert.equal(EVENTBRIDGE_ACTION_INVENTORY_SOURCE.targetPrefix, "AWSEvents.");
  assert.equal(EVENTBRIDGE_ACTION_INVENTORY.length, 57);
  assert.equal(new Set(EVENTBRIDGE_ACTION_INVENTORY.map(entry => entry.action)).size, 57);
  assert.equal(EVENTBRIDGE_ACTION_INVENTORY.some(entry => String(entry.phase) === "EVB-10"), false, "the eight-phase roadmap closes core actions in EVB-08");
  assert.deepEqual(EVENTBRIDGE_ACTION_INVENTORY.filter(entry => entry.phase === "EVB-01").map(entry => entry.action), [...EVENTBRIDGE_EVB01_ACTIONS]);
  for (const action of EVENTBRIDGE_EVB01_ACTIONS) assert.equal(typeof (EventBridgeService.prototype as any)[action], "function", `${action} needs an EVB-01 route`);
  assert.deepEqual(EVENTBRIDGE_ACTION_INVENTORY.filter(entry => entry.phase === "EVB-04").map(entry => entry.action), [...EVENTBRIDGE_EVB04_ACTIONS].sort());
  for (const action of EVENTBRIDGE_EVB04_ACTIONS) assert.equal(typeof (EventBridgeService.prototype as any)[action], "function", `${action} needs an EVB-04 route`);
});
