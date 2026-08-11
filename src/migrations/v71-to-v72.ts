import type { SimState } from "../types.js";

/** AMX-10 adds authoritative completed-generation ownership and intentional hotswap drift. */
export function migrateV71ToV72(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      region.cloudformation.deploymentGeneration ??= 0;
      region.cloudformation.resourceOwnership ??= {};
      region.cloudformation.hotswapDrift ??= {};
      region.cloudformation.hotswapOperations ??= [];
    }
  }
  state.schemaVersion = 72;
  return state;
}
