import type { SimState } from "../types.js";

export function migrateV38ToV39(state: SimState): SimState {
  state.schemaVersion = 39;
  return state;
}
