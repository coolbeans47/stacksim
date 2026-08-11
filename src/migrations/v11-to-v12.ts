import type { SimState } from "../types.js";

export function migrateV11ToV12(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.dynamodbExports ??= {};
    region.dynamodbImports ??= {};
  }
  state.schemaVersion = 12;
  return state;
}
