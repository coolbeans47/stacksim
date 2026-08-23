import type { CloudFrontAccountState, SimState } from "../types.js";

export function emptyCloudFrontAccountState(): CloudFrontAccountState {
  return {
    schemaVersion: 1,
    revision: 0,
    distributions: {},
    distributionCallerReferences: {},
    functions: {},
    originAccessControls: {},
    originAccessControlNames: {},
    responseHeadersPolicies: {},
    responseHeadersPolicyNames: {},
    invalidations: {},
    invalidationCallerReferences: {},
  };
}

/** CFR-01 adds authoritative account-global CloudFront control state. */
export function migrateV87ToV88(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) account.cloudfront ??= emptyCloudFrontAccountState();
  state.schemaVersion = 88;
  return state;
}
