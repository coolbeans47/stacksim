import type { SimState } from "../types.js";

/** SFN-03 adds the regional Activity catalog; task tokens remain in the private execution store. */
export function migrateV76ToV77(input: SimState): SimState {
  const state = structuredClone(input) as SimState;
  for (const account of Object.values(state.accounts)) for (const region of Object.values(account.regions)) {
    (region.stepFunctions as any).activities ??= {};
    (region.stepFunctions as any).activityNames ??= {};
  }
  state.schemaVersion = 77;
  return state;
}
