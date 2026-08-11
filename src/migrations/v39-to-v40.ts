import type { SimState } from "../types.js";

export function migrateV39ToV40(state: SimState): SimState {
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.cloudwatch.metricStreams ??= {};
  }
  state.schemaVersion = 40;
  return state;
}
