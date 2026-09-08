import type { CognitoIdentityRegionState, SimState } from "../types.js";

export function emptyCognitoIdentityRegionState(): CognitoIdentityRegionState {
  return {
    revision: 0,
    pools: {},
    rateBuckets: {},
  };
}

/** CID-01 opens the regional Cognito Identity Pools namespace. */
export function migrateV88ToV89(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      (region as typeof region & { cognitoIdentity?: CognitoIdentityRegionState }).cognitoIdentity
        ??= emptyCognitoIdentityRegionState();
    }
  }
  state.schemaVersion = 89;
  return state;
}
