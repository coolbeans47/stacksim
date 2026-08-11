import type { CognitoUserPoolState, SimState } from "../types.js";

function normalizePool(pool: CognitoUserPoolState): void {
  pool.identityProviders ??= {};
  pool.identityProviderIdentifierIndex ??= {};
  pool.federatedIdentityIndex ??= {};
  pool.federationTransactions ??= {};
  pool.federationReplayIds ??= {};
  for (const user of Object.values(pool.usersBySub ?? {})) user.externalIdentities ??= [];
}

/** COG-05 adds inert provider, linked-identity, correlation, and replay state. */
export function migrateV56ToV57(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      for (const pool of Object.values(region.cognito.pools ?? {})) normalizePool(pool);
    }
  }
  state.schemaVersion = 57;
  return state;
}
