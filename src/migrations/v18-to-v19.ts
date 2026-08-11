import type { SimState } from "../types.js";

export function migrateV18ToV19(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      for (const fn of Object.values(region.functions ?? {})) fn.functionUrlConfigs ??= {};
    }
  }
  state.schemaVersion = 19;
  return state;
}
