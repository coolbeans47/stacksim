import type { SecretsManagerRegionState } from "../types.js";

export function emptySecretsManagerRegionState(): SecretsManagerRegionState {
  return { revision: 0, secrets: {}, retiredSuffixes: {} };
}
