import type { SesRegionState, SimState } from "../types.js";
import { emptySesPhase01RegionState, type SesPhase01RegionState } from "./v50-to-v51.js";
import { emptySes04State } from "./v67-to-v68.js";

export function emptySesRegionState(): SesRegionState {
  return {
    ...emptySesPhase01RegionState(),
    templates: {},
    configurationSets: {},
    ...emptySes04State(),
  };
}

/**
 * SES-02 adds the shared classic/v2 template catalog and basic configuration
 * sets. Existing SES-01 state is retained byte-for-byte apart from the two new
 * empty catalogs.
 */
export function migrateV51ToV52(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      const legacy = region as unknown as {
        ses?: SesPhase01RegionState & Partial<Pick<SesRegionState, "templates" | "configurationSets">>;
      };
      legacy.ses ??= emptySesPhase01RegionState();
      legacy.ses.templates ??= {};
      legacy.ses.configurationSets ??= {};
      region.ses = legacy.ses as SesRegionState;
    }
  }
  state.schemaVersion = 52;
  return state;
}
