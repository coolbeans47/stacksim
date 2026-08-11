import type { SimState } from "../types.js";

export function migrateV20ToV21(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      for (const fn of Object.values(region.functions ?? {})) {
        fn.packageType ??= "Zip";
        for (const version of Object.values(fn.versions ?? {})) version.packageType ??= "Zip";
      }
    }
  }
  state.schemaVersion = 21;
  return state;
}
