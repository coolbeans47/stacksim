import type { SimState } from "../types.js";

export function migrateV26ToV27(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.apiGatewayApiKeys ??= {};
    region.apiGatewayUsagePlans ??= {};
    for (const api of Object.values(region.apis ?? {})) {
      api.apiKeySource ??= "HEADER";
      for (const deployment of Object.values(api.deployments ?? {})) if (deployment.snapshot) deployment.snapshot.apiKeySource ??= "HEADER";
    }
  }
  state.schemaVersion = 27;
  return state;
}
