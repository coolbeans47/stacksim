import type { SimState } from "../types.js";

/** Introduces the authoritative regional Parameter Store control catalog. */
export function migrateV62ToV63(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts)) for (const region of Object.values(account.regions)) {
    region.parameterStore ??= { revision: 0, parameters: {}, tombstones: {} };
  }
  state.schemaVersion = 63;
  return state;
}
