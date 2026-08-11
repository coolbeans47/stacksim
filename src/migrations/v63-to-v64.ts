import type { SimState } from "../types.js";
import { emptySecretsManagerRegionState } from "../secrets-manager/model.js";

export function migrateV63ToV64(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      region.secretsManager = emptySecretsManagerRegionState();
    }
  }
  state.schemaVersion = 64;
  return state;
}
