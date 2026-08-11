import { randomBytes } from "node:crypto";
import type { SesAccountState, SesRegionState, SimState } from "../types.js";

export type SesPhase01RegionState = Omit<SesRegionState,
  "templates" | "configurationSets" | "customVerificationTemplates" | "contactLists" | "suppressedDestinations" | "localCallbacks">;

export function emptySesAccountState(): SesAccountState {
  return {
    accessProfile: "PRODUCTION",
    productionAccessEnabled: true,
    sendingEnabled: true,
    max24HourSend: 50_000,
    maxSendRate: 14,
  };
}

export function emptySesPhase01RegionState(): SesPhase01RegionState {
  return {
    controlRevision: 0,
    account: emptySesAccountState(),
    identities: {},
    verificationIntents: {},
    callbackResults: {},
  };
}

/**
 * SES-01 adds the installation callback-signing secret and bounded regional
 * account, identity, verification-intent, and callback-result control state.
 * Mailbox messages remain outside state.json in the regional SQLite store.
 */
export function migrateV50ToV51(input: SimState): SimState {
  const state = structuredClone(input);
  state.installation.sesSigningSecret ??= randomBytes(32).toString("base64");
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      const legacy = region as unknown as { ses?: SesPhase01RegionState };
      legacy.ses ??= emptySesPhase01RegionState();
    }
  }
  state.schemaVersion = 51;
  return state;
}
