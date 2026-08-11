import type { CognitoAppClientState, CognitoUserPoolState, SimState } from "../types.js";

function normalizeClient(client: CognitoAppClientState): void {
  client.supportedIdentityProviders ??= ["COGNITO"];
  client.callbackUrls ??= [];
  client.logoutUrls ??= [];
  client.allowedOAuthFlows ??= [];
  client.allowedOAuthScopes ??= [];
  client.allowedOAuthFlowsUserPoolClient ??= false;
}

function normalizePool(pool: CognitoUserPoolState): void {
  pool.resourceServers ??= {};
  pool.managedLoginBranding ??= {};
  pool.uiCustomizations ??= {};
  pool.authorizationCodes ??= {};
  pool.browserSessions ??= {};
  for (const client of Object.values(pool.clients ?? {})) normalizeClient(client);
}

/** COG-04 adds inert OAuth, managed-login, resource-server, and replay state. */
export function migrateV55ToV56(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      region.cognito.domainIndex ??= {};
      for (const pool of Object.values(region.cognito.pools ?? {})) {
        normalizePool(pool);
        if (pool.domain) region.cognito.domainIndex[pool.domain.domain] = pool.id;
      }
    }
  }
  state.schemaVersion = 56;
  return state;
}
