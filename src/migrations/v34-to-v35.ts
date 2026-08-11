import type { SimState } from "../types.js";

export function migrateV34ToV35(state: SimState): SimState {
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.logDestinations ??= {};
    region.logResourcePolicies ??= {};
    region.logExportTasks ??= {};
    for (const group of Object.values(region.logs ?? {})) {
      group.metricFilters ??= {};
      group.subscriptionFilters ??= {};
    }
  }
  state.schemaVersion = 35;
  return state;
}
