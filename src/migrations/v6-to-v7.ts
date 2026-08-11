import type { SimState } from "../types.js";

export function migrateV6ToV7(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) for (const region of Object.values(account.regions ?? {})) for (const table of Object.values(region.tables ?? {})) {
    table.tags ??= {};
    table.tableClass ??= "STANDARD";
    table.deletionProtectionEnabled ??= false;
    table.sse ??= { sseType: "AES256", status: "ENABLED" };
  }
  state.schemaVersion = 7;
  return state;
}
