import type { SimState } from "../types.js";

export function migrateV30ToV31(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.webSocketApis ??= {};
  }
  state.schemaVersion = 31;
  return state;
}
