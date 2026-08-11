import type { SimState } from "../types.js";

/** Adds durable IAM users, groups, access-key metadata, and installation initialization state. */
export function migrateV57ToV58(input: SimState): SimState {
  const state = structuredClone(input);
  (state.installation as any).defaultAdministrators ??= {};
  for (const account of Object.values(state.accounts)) {
    (account.iam as any).users ??= {};
    (account.iam as any).groups ??= {};
    (account.iam as any).accessKeys ??= {};
  }
  state.schemaVersion = 58;
  return state;
}
