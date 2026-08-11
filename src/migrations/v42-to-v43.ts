import type { SimState } from "../types.js";

export function migrateV42ToV43(state: SimState): SimState {
  (state.installation as any).rds ??= {};
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) (region as any).rdsDbInstances ??= {};
  }
  state.schemaVersion = 43;
  return state;
}
