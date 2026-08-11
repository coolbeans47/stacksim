import type { SimState } from "../types.js";

/** Adds the durable SNS action outbox used by CloudWatch alarms. */
export function migrateV61ToV62(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts)) for (const region of Object.values(account.regions)) {
    region.cloudwatch.snsActionOutbox ??= [];
    region.cloudformation.notificationOutbox ??= [];
  }
  state.schemaVersion = 62;
  return state;
}
