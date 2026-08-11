import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "@aws-sdk/client-appsync";
import {
  APPSYNC_ACTION_INVENTORY,
  APPSYNC_ACTION_INVENTORY_SOURCE,
  APPSYNC_APS_P0_001_ACTIONS,
  APPSYNC_APS_P0_002_ACTIONS,
  APPSYNC_APS_P0_004_ACTIONS,
  APPSYNC_APS_P0_006_ACTIONS,
  APPSYNC_APS_P0_007_ACTIONS,
  APPSYNC_AMX_05_ACTIONS,
  APPSYNC_AMX_06_PERMISSION_ACTION,
  APPSYNC_AMX_08_REALTIME_SURFACE,
} from "../src/appsync/action-inventory.js";

test("AppSync inventory matches the pinned 74-command SDK, 32 control actions, and AMX-06 GraphQL permission action", () => {
  const sdkActions = Object.keys(sdk)
    .filter(name => name.endsWith("Command") && name !== "$Command")
    .map(name => name.slice(0, -"Command".length))
    .sort();
  const inventoryActions = APPSYNC_ACTION_INVENTORY.map(entry => entry.action);
  assert.equal(APPSYNC_ACTION_INVENTORY_SOURCE.sdkVersion, "3.1097.0");
  assert.equal(APPSYNC_ACTION_INVENTORY_SOURCE.protocol, "REST-JSON");
  assert.equal(APPSYNC_ACTION_INVENTORY_SOURCE.signingName, "appsync");
  assert.equal(inventoryActions.length, 74);
  assert.equal(new Set(inventoryActions).size, 74);
  assert.deepEqual(inventoryActions, sdkActions);
  assert.deepEqual(
    APPSYNC_ACTION_INVENTORY.filter(entry => entry.implemented).map(entry => entry.action).sort(),
    [
      ...APPSYNC_APS_P0_001_ACTIONS,
      ...APPSYNC_APS_P0_002_ACTIONS,
      ...APPSYNC_APS_P0_004_ACTIONS,
      ...APPSYNC_APS_P0_006_ACTIONS,
      ...APPSYNC_APS_P0_007_ACTIONS,
      ...APPSYNC_AMX_05_ACTIONS,
    ].sort(),
  );
  assert.equal(APPSYNC_ACTION_INVENTORY.filter(entry => entry.implemented).length, 32);
  assert.deepEqual(APPSYNC_AMX_06_PERMISSION_ACTION, {
    action: "GraphQL",
    iamAction: "appsync:GraphQL",
    phase: "APS-06",
    implemented: true,
    resource: "arn:aws:appsync:${Region}:${Account}:apis/${GraphQLAPIId}/types/${TypeName}/fields/${FieldName}",
  });
  assert.equal(APPSYNC_AMX_08_REALTIME_SURFACE.addsSdkAction, false);
  assert.deepEqual(APPSYNC_AMX_08_REALTIME_SURFACE.authorizationModes, ["API_KEY", "AWS_IAM"]);
  assert.deepEqual(APPSYNC_AMX_08_REALTIME_SURFACE.subscriptionFields, ["onCreateTodo", "onUpdateTodo", "onDeleteTodo"]);
  assert.equal(APPSYNC_AMX_08_REALTIME_SURFACE.persistence, "process-local-no-replay");
});
