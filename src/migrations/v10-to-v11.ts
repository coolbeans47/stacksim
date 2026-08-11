import type { SimState } from "../types.js";

export function migrateV10ToV11(input: SimState): SimState {
  const state = structuredClone(input);
  state.schemaVersion = 11;
  return state;
}
