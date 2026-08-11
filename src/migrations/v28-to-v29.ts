import type { SimState } from "../types.js";

export function migrateV28ToV29(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.apiGatewayDomainNames ??= {};
    region.apiGatewayDomainNameAccessAssociations ??= {};
  }
  state.schemaVersion = 29;
  return state;
}
