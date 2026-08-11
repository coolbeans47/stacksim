import type { SimState } from "../types.js";

/** CWLI P0 persists query lifecycle and result state for the seven-day availability window. */
export function migrateV69ToV70(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) region.logQueryJobs ??= {};
  state.schemaVersion = 70;
  return state;
}
