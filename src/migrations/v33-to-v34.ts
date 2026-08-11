import type { SimState } from "../types.js";

export function migrateV33ToV34(state: SimState): SimState {
  for (const account of Object.values(state.accounts ?? {})) account.cloudwatchDashboards ??= {};
  state.schemaVersion = 34;
  return state;
}
