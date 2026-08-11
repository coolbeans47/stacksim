import type { SimState } from "../types.js";

export function migrateV17ToV18(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      region.lambdaLayers ??= {};
      for (const fn of Object.values(region.functions ?? {})) {
        fn.layers ??= [];
        for (const version of Object.values(fn.versions ?? {})) version.layers ??= [];
      }
    }
  }
  state.schemaVersion = 18;
  return state;
}
