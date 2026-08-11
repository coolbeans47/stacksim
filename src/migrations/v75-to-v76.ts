import type { SimState } from "../types.js";

/** COG-07 normalizes legacy single app-client secrets and prepares device verifier storage. */
export function migrateV75ToV76(input: SimState): SimState {
  const state = structuredClone(input) as SimState;
  for (const account of Object.values(state.accounts)) {
    for (const region of Object.values(account.regions)) {
      for (const pool of Object.values(region.cognito.pools)) {
        for (const client of Object.values(pool.clients)) {
          if (!client.clientSecrets?.length && client.secret) {
            client.clientSecrets = [{
              id: client.secret.id,
              createdAt: client.createdAt,
              envelope: client.secret,
            }];
          }
        }
      }
    }
  }
  state.schemaVersion = 76;
  return state;
}
