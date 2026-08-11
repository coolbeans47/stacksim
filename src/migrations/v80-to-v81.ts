import type { SimState } from "../types.js";

/** PSS-03 adds authoritative parameter label maps and secret policy lineage. */
export function migrateV80ToV81(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      for (const parameter of Object.values(region.parameterStore?.parameters ?? {})) {
        parameter.labels ??= {};
      }
      for (const secret of Object.values(region.secretsManager?.secrets ?? {})) {
        secret.policyRevision ??= secret.resourcePolicy?.revision ?? 0;
      }
    }
  }
  state.schemaVersion = 81;
  return state;
}
