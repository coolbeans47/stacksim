import type { SimState } from "../types.js";

export function migrateV22ToV23(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) region.lambdaDurableExecutions ??= {};
  state.schemaVersion = 23;
  return state;
}
