import type { SimState } from "../types.js";

/**
 * EVB-02 adds target-family and delivery-specific descriptors plus the
 * CloudWatch-to-EventBridge publisher outbox. Existing EventBridge targets from
 * v48 are EVB-01 Lambda targets, so their family can be normalized without
 * inspecting or rewriting the external delivery journal.
 */
export function migrateV48ToV49(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    for (const targets of Object.values(region.eventTargets ?? {})) for (const target of Object.values(targets) as any[]) target.targetType ??= "lambda";
    region.cloudwatch.eventBridgeOutbox ??= [];
  }
  state.schemaVersion = 49;
  return state;
}
