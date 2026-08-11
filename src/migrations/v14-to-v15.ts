import type { SimState } from "../types.js";

export function migrateV14ToV15(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) {
    region.lambdaAsyncInvocations ??= {};
    for (const fn of Object.values(region.functions ?? {})) fn.eventInvokeConfigs ??= {};
  }
  state.schemaVersion = 15;
  return state;
}
