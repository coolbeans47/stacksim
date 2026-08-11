import type { SimState } from "../types.js";

export function migrateV36ToV37(state: SimState): SimState {
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.cloudwatch.anomalyDetectors ??= {};
  }
  state.schemaVersion = 37;
  return state;
}
