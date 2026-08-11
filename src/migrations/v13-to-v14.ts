import type { SimState } from "../types.js";

export function migrateV13ToV14(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) for (const table of Object.values(region.tables ?? {})) table.kinesisStreamingDestinations ??= {};
  state.schemaVersion = 14;
  return state;
}
