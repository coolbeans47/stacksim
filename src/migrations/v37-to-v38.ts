import type { SimState } from "../types.js";

export function migrateV37ToV38(state: SimState): SimState {
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.cloudwatch.logAlarms ??= {};
    region.cloudwatch.alarmMuteRules ??= {};
  }
  state.schemaVersion = 38;
  return state;
}
