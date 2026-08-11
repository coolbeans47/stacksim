import { randomBytes } from "node:crypto";
import type { SimState } from "../types.js";

export function migrateV43ToV44(state: SimState): SimState {
  (state.installation as any).sqsEncryptionKey ??= randomBytes(32).toString("base64");
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      (region as any).sqsQueues ??= {};
      (region as any).sqsQueueDeletionTimes ??= {};
    }
  }
  state.schemaVersion = 44;
  return state;
}
