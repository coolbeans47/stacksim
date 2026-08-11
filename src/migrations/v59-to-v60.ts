import type { SimState } from "../types.js";

/** Adds EventBridge legacy schedule checkpoints and the Scheduler regional catalogs. */
export function migrateV59ToV60(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts)) {
    for (const region of Object.values(account.regions)) {
      (region as any).eventScheduleGroups ??= {};
      (region as any).eventSchedules ??= {};
    }
  }
  state.schemaVersion = 60;
  return state;
}
