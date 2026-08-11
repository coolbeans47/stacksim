import type { SimState } from "../types.js";

export function migrateV24ToV25(input: SimState): SimState {
  const state = structuredClone(input);
  state.schemaVersion = 25;
  return state;
}
