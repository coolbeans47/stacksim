import type { SimState } from "../types.js";

export function migrateV27ToV28(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) region.apiGatewayResponseCaches ??= {};
  state.schemaVersion = 28;
  return state;
}
