import type { SimState } from "../types.js";

export function migrateV9ToV10(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.dynamodbResourcePolicies ??= {};
    region.dynamodbResourcePolicyMutationTimes ??= {};
  }
  state.schemaVersion = 10;
  return state;
}
