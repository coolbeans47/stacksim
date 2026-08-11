import type { SimState } from "../types.js";

/** SFN P0 adds the regional Standard Workflow catalog and durable checkpoints. */
export function migrateV68ToV69(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      region.stepFunctions ??= {
        revision: 0,
        stateMachines: {},
        stateMachineNames: {},
        executions: {},
        executionNames: {},
        activities: {},
        activityNames: {},
      };
    }
  }
  state.schemaVersion = 69;
  return state;
}
