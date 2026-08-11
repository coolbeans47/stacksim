import type { SimState } from "../types.js";

/** SFN-03 reconciliation adds owning-DynamoDB integration acceptance receipts. */
export function migrateV84ToV85(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) region.dynamodbIntegrationAttempts ??= {};
  state.schemaVersion = 85;
  return state;
}
