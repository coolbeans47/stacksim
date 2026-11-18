import type { SimState } from "../types.js";

export function migrateV89ToV90(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      region.opensearch ??= { domains: {}, retiredPorts: [] };
    }
  }
  state.schemaVersion = 90;
  return state;
}
