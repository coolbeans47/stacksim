import type { SimState } from "../types.js";

export function migrateV7ToV8(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.dynamodbBackups ??= {};
    for (const table of Object.values(region.tables ?? {})) table.pointInTimeRecovery ??= { status: "DISABLED", recoveryPeriodInDays: 35, sequence: 0 };
  }
  state.schemaVersion = 8;
  return state;
}
