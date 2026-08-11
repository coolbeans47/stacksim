import type { SimState } from "../types.js";

/** Adds the immutable queue-type marker to pre-FIFO SQS descriptors. */
export function migrateV46ToV47(state: SimState): SimState {
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      for (const queue of Object.values(region.sqsQueues ?? {})) {
        (queue.attributes as any).FifoQueue ??= "false";
      }
    }
  }
  state.schemaVersion = 47;
  return state;
}
