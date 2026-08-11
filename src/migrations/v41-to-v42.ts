import { randomBytes } from "node:crypto";
import type { SimState } from "../types.js";

export function migrateV41ToV42(state: SimState): SimState {
  (state.installation as any).s3EncryptionKey ??= randomBytes(32).toString("base64");
  (state.installation as any).s3BucketNames ??= {};
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) (region as any).s3Buckets ??= {};
  }
  state.schemaVersion = 42;
  return state;
}
