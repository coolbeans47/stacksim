import { defaultApiModels } from "../apigateway-schema.js";
import type { SimState } from "../types.js";

export function migrateV23ToV24(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) for (const api of Object.values(region.apis ?? {})) {
    api.models ??= defaultApiModels();
    api.requestValidators ??= {};
    for (const deployment of Object.values(api.deployments ?? {})) if (deployment.snapshot) {
      deployment.snapshot.models ??= structuredClone(api.models);
      deployment.snapshot.requestValidators ??= structuredClone(api.requestValidators);
    }
  }
  state.schemaVersion = 24;
  return state;
}
