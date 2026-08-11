import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "@aws-sdk/client-sns";
import { SNS_ACTION_INVENTORY, SNS_ACTION_INVENTORY_SOURCE, SNS_01_IMPLEMENTED_ACTIONS, SNS_02_IMPLEMENTED_ACTIONS } from "../src/sns/action-inventory.js";
import { SNS_02_ACTIONS, SnsService } from "../src/sns.js";

test("SNS action inventory matches the pinned SDK and routes exactly SNS-02", () => {
  const sdkActions = Object.keys(sdk)
    .filter(name => name.endsWith("Command") && name !== "$Command")
    .map(name => name.slice(0, -"Command".length))
    .sort();
  const inventoryActions = SNS_ACTION_INVENTORY.map(entry => entry.action);
  assert.equal(SNS_ACTION_INVENTORY_SOURCE.sdkVersion, "3.1095.0");
  assert.equal(SNS_ACTION_INVENTORY_SOURCE.url, "https://docs.aws.amazon.com/sns/latest/api/API_Operations.html");
  assert.equal(inventoryActions.length, 42);
  assert.equal(new Set(inventoryActions).size, 42);
  assert.deepEqual([...inventoryActions].sort(), sdkActions);
  assert.equal(SNS_01_IMPLEMENTED_ACTIONS.length, 14);
  assert.equal(SNS_02_IMPLEMENTED_ACTIONS.length, 18);
  assert.deepEqual([...SNS_02_ACTIONS].sort(), [...SNS_02_IMPLEMENTED_ACTIONS].sort());
  for (const action of SNS_02_IMPLEMENTED_ACTIONS) {
    assert.equal(typeof (SnsService.prototype as any)[action], "function", `${action} needs a modeled route`);
  }
});
