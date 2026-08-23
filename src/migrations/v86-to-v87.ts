import type { SimState } from "../types.js";

/** XRY-01 adds only the regional control-plane marker; trace documents remain outside state.json. */
export function migrateV86ToV87(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) region.xray ??= { revision: 1 };
  state.schemaVersion = 87;
  return state;
}
