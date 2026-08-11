import type { SimState } from "../types.js";

export function migrateV49ToV50(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      region.cloudformation = {
        stacks: {},
        stackNames: {},
        changeSets: {},
        changeSetNames: {},
        exports: {},
        clientTokens: {},
      };
    }
  }
  state.schemaVersion = 50;
  return state;
}
