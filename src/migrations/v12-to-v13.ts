import type { SimState } from "../types.js";

export function migrateV12ToV13(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) for (const table of Object.values(region.tables ?? {})) table.contributorInsights ??= {};
  state.schemaVersion = 13;
  return state;
}
