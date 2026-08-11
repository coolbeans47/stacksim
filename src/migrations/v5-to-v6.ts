import type { SimState } from "../types.js";

export function migrateV5ToV6(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) for (const table of Object.values(region.tables ?? {})) table.timeToLive ??= { status: "DISABLED" };
  state.schemaVersion = 6;
  return state;
}
