import type { SimState } from "../types.js";

/** DUG-11 adds pending-device slots and preserves legacy device verifier plaintext for start-time wrapping. */
export function migrateV78ToV79(input: SimState): SimState {
  const state = structuredClone(input) as SimState;
  for (const account of Object.values(state.accounts ?? {})) {
    for (const regionState of Object.values(account.regions ?? {})) {
      const cognito = (regionState as { cognito?: { pools?: Record<string, any> } }).cognito;
      if (!cognito?.pools) continue;
      for (const pool of Object.values(cognito.pools)) {
        for (const user of Object.values(pool.usersBySub ?? {})) {
          const current = user as {
            pendingDevices?: Record<string, unknown>;
            devices?: Record<string, { groupKey?: string; key?: string }>;
          };
          current.pendingDevices ??= {};
          for (const device of Object.values(current.devices ?? {})) {
            if (!device.groupKey && typeof device.key === "string") {
              device.groupKey = `-${device.key.replace(/[^a-zA-Z0-9]/g, "").slice(-6) || "device"}`;
            }
          }
        }
      }
    }
  }
  state.schemaVersion = 79;
  return state;
}
