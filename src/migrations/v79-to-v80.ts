import type { SimState } from "../types.js";

/** RDS-03 adds the regional manual DB snapshot control catalog. */
export function migrateV79ToV80(input: SimState): SimState {
  const state = structuredClone(input) as SimState;
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) region.rdsDbSnapshots ??= {};
  }
  state.schemaVersion = 80;
  return state;
}
