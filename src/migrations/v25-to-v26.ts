import type { SimState } from "../types.js";

export function migrateV25ToV26(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.apiGatewayAccount ??= {};
    for (const api of Object.values(region.apis ?? {})) for (const stage of Object.values(api.stages ?? {})) {
      stage.variables ??= {};
      stage.methodSettings ??= {};
      stage.tags ??= {};
      stage.tracingEnabled ??= false;
      stage.cacheClusterEnabled ??= false;
    }
  }
  state.schemaVersion = 26;
  return state;
}
