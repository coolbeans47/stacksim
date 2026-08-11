import type { SesRegionState, SimState } from "../types.js";

export function emptySes04State(): Pick<SesRegionState,
  "customVerificationTemplates" | "contactLists" | "suppressedDestinations" | "localCallbacks"> {
  return {
    customVerificationTemplates: {},
    contactLists: {},
    suppressedDestinations: {},
    localCallbacks: {},
  };
}

/** SES-04 opens the regional identity-depth, contact and suppression catalogs. */
export function migrateV67ToV68(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      const ses = region.ses as SesRegionState;
      Object.assign(ses, emptySes04State(), {
        customVerificationTemplates: ses.customVerificationTemplates ?? {},
        contactLists: ses.contactLists ?? {},
        suppressedDestinations: ses.suppressedDestinations ?? {},
        localCallbacks: ses.localCallbacks ?? {},
      });
      ses.account.suppressionReasons ??= ["BOUNCE", "COMPLAINT"];
      for (const identity of Object.values(ses.identities)) {
        identity.feedbackForwardingStatus ??= true;
        identity.headersInNotificationsEnabled ??= false;
        identity.notificationTopics ??= {};
        identity.mailFromAttributes ??= {
          behaviorOnMxFailure: "USE_DEFAULT_VALUE",
          mailFromDomainStatus: "PENDING",
        };
        identity.dkimSigningAttributesOrigin ??= "AWS_SES";
        identity.dkimCurrentSigningKeyLength ??= "RSA_2048_BIT";
      }
      for (const configuration of Object.values(ses.configurationSets)) {
        configuration.eventDestinations ??= {};
        configuration.reputationOptions ??= { reputationMetricsEnabled: false };
        configuration.suppressionOptions ??= { suppressedReasons: [] };
      }
    }
  }
  state.schemaVersion = 68;
  return state;
}
