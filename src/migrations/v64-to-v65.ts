import type { SimState } from "../types.js";

/** Introduces the authoritative regional AppSync control catalog. */
export function migrateV64ToV65(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      region.appsync ??= { revision: 0, graphqlApis: {} };
    }
  }
  state.schemaVersion = 65;
  return state;
}
