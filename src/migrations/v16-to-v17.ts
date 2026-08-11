import type { SimState } from "../types.js";

export function migrateV16ToV17(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      for (const fn of Object.values(region.functions ?? {})) fn.provisionedConcurrencyConfigs ??= {};
    }
  }
  state.schemaVersion = 17;
  return state;
}
