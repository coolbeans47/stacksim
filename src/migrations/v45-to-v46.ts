import type { SimState } from "../types.js";

export function migrateV45ToV46(state: SimState): SimState {
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      (region as any).eventBuses ??= {};
      (region as any).eventRules ??= {};
      (region as any).eventTargets ??= {};
    }
  }
  state.schemaVersion = 46;
  return state;
}
