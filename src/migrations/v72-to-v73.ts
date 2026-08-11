import type { SimState } from "../types.js";

/** DUG-02 removes false encrypted-cache claims and adopts explicit response envelopes. */
export function migrateV72ToV73(input: SimState): SimState {
  const state = structuredClone(input) as any;
  for (const account of Object.values<any>(state.accounts ?? {})) {
    for (const region of Object.values<any>(account.regions ?? {})) {
      for (const cache of Object.values<any>(region.apiGatewayResponseCaches ?? {})) {
        for (const [cacheKey, entry] of Object.entries<any>(cache.entries ?? {})) {
          if (entry?.encrypted === true) {
            // These entries only carried a descriptive flag; retaining them would
            // continue the false at-rest encryption claim. A cache miss is safe.
            delete cache.entries[cacheKey];
            continue;
          }
          if (entry?.encrypted === false) {
            cache.entries[cacheKey] = {
              expiresAt: entry.expiresAt,
              deploymentId: entry.deploymentId,
              method: entry.method,
              namespace: entry.namespace,
              encrypted: false,
              response: { status: entry.status, body: entry.body, headers: entry.headers },
            };
          } else delete cache.entries[cacheKey];
        }
      }
    }
  }
  state.schemaVersion = 73;
  return state as SimState;
}
