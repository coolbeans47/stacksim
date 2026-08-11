import type { CognitoRegionState, SimState } from "../types.js";

export function emptyCognitoRegionState(): CognitoRegionState {
  return {
    revision: 0,
    pools: {},
    poolNameIndex: {},
    issuerTombstones: {},
    deliveryIntents: {},
    admissions: {},
    audit: [],
    domainIndex: {},
  };
}

/**
 * COG-01 opens the bounded regional Cognito control namespace. No credentials,
 * users, delivery material, or keys are synthesized while upgrading existing
 * installations.
 */
export function migrateV52ToV53(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      (region as typeof region & { cognito?: CognitoRegionState }).cognito ??= emptyCognitoRegionState();
    }
  }
  state.schemaVersion = 53;
  return state;
}
