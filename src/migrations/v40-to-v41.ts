import type { SimState } from "../types.js";

export function migrateV40ToV41(state: SimState): SimState {
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.cloudwatch.insightRules ??= {};
  }
  state.schemaVersion = 41;
  return state;
}
