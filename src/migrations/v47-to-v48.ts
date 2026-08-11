import type { SimState } from "../types.js";

/** Existing private local ciphertext predates truthful public SSE-SQS descriptors. */
export function migrateV47ToV48(state: SimState): SimState {
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      for (const queue of Object.values(region.sqsQueues ?? {})) {
        (queue.attributes as any).SqsManagedSseEnabled ??= "false";
      }
    }
  }
  state.schemaVersion = 48;
  return state;
}
