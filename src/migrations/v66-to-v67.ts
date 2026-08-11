import { randomUUID } from "node:crypto";
import type { SimState } from "../types.js";

/** Adds immutable child identities for scoped AppSync DynamoDB tokens. */
export function migrateV66ToV67(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      for (const api of Object.values(region.appsync?.graphqlApis ?? {})) {
        for (const dataSource of Object.values(api.dataSources ?? {})) {
          dataSource.generation ??= randomUUID();
        }
        for (const resolver of Object.values(api.resolvers ?? {})) {
          resolver.generation ??= randomUUID();
        }
      }
    }
  }
  state.schemaVersion = 67;
  return state;
}
