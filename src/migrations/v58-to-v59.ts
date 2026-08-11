import { randomBytes } from "node:crypto";
import type { SimState } from "../types.js";

/** Adds the SNS regional control catalog and installation-local content key. */
export function migrateV58ToV59(input: SimState): SimState {
  const state = structuredClone(input);
  (state.installation as any).snsEncryptionKey ??= randomBytes(32).toString("base64");
  for (const account of Object.values(state.accounts)) {
    for (const region of Object.values(account.regions)) {
      (region as any).sns ??= { revision: 0, topics: {}, subscriptions: {} };
    }
  }
  state.schemaVersion = 59;
  return state;
}
