import type { SimState } from "../types.js";

/** AMX-05 adds durable AppSync function catalogs to every GraphQL API. */
export function migrateV70ToV71(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      for (const api of Object.values(region.appsync?.graphqlApis ?? {})) api.functions ??= {};
    }
  }
  state.schemaVersion = 71;
  return state;
}
