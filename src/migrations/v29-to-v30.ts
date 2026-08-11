import type { SimState } from "../types.js";

export function migrateV29ToV30(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.httpApis ??= {};
    region.apiGatewayV2DomainNames ??= {};
  }
  state.schemaVersion = 30;
  return state;
}
