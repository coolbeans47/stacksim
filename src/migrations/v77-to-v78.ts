import { randomBytes } from "node:crypto";
import type { SimState } from "../types.js";

/** EVB-04 gives archive segments their own installation-local encryption key. */
export function migrateV77ToV78(input: SimState): SimState {
  const state = structuredClone(input);
  (state.installation as any).eventBridgeArchiveEncryptionKey ??= randomBytes(32).toString("base64");
  state.schemaVersion = 78;
  return state;
}
