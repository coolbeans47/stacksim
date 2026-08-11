import type { SimState } from "../types.js";

/**
 * PSS-04 adds optional, private CloudFormation ownership metadata. Existing
 * application resources deliberately remain unowned; rewriting them would
 * amount to adoption and would violate the provider collision contract.
 */
export function migrateV81ToV82(input: SimState): SimState {
  const state = structuredClone(input);
  state.schemaVersion = 82;
  return state;
}
