import type { SimState } from "../types.js";

/** PSS-06 adds safe rotation/attachment descriptors and bounded RDS saga state. */
export function migrateV83ToV84(input: SimState): SimState {
  const state = structuredClone(input);
  state.schemaVersion = 84;
  return state;
}
