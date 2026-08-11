import type { SimState } from "../types.js";

export function migrateV21ToV22(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      region.lambdaCapacityProviders ??= {};
      for (const fn of Object.values(region.functions ?? {})) fn.functionScalingConfigs ??= {};
    }
  }
  state.schemaVersion = 22;
  return state;
}
