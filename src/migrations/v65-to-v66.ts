import { createHash, randomUUID } from "node:crypto";
import type { SimState } from "../types.js";

/** Adds generation-bound schemas plus the APS-01 NONE data-source/resolver catalogs. */
export function migrateV65ToV66(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      region.appsync ??= { revision: 0, graphqlApis: {} };
      for (const api of Object.values(region.appsync.graphqlApis)) {
        api.generation ??= randomUUID();
        api.updatedAt ??= api.createdAt;
        api.dataSources ??= {};
        api.resolvers ??= {};
        if (api.schema) {
          api.schema.generation ??= randomUUID();
          api.schema.digest ??= createHash("sha256").update(api.schema.definition, "utf8").digest("hex");
        }
        for (const key of Object.values(api.apiKeys)) key.updatedAt ??= key.createdAt;
      }
    }
  }
  state.schemaVersion = 66;
  return state;
}
