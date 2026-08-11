import type { SimState } from "../types.js";

/** PSS-05 adds Advanced parameter policies and a value-free EventBridge outbox. */
export function migrateV82ToV83(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.parameterStore.eventOutbox ??= [];
    region.parameterStore.completedPolicyOccurrences ??= {};
    for (const parameter of Object.values(region.parameterStore.parameters ?? {})) (parameter as any).policies ??= [];
  }
  state.schemaVersion = 83;
  return state;
}
