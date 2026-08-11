import type { SimState } from "../types.js";

/** DUG-06 adds the durable Lambda action outbox used by CloudWatch alarms. */
export function migrateV74ToV75(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts)) for (const region of Object.values(account.regions)) {
    region.cloudwatch.lambdaActionOutbox ??= [];
  }
  state.schemaVersion = 75;
  return state;
}
