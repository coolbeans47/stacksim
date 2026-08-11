import type {
  CognitoAppClientState,
  CognitoUserPoolConfigurationState,
  CognitoUserState,
  SimState,
} from "../types.js";

function normalizeConfiguration(configuration: CognitoUserPoolConfigurationState): void {
  configuration.policies.passwordPolicy.passwordHistorySize ??= 0;
  configuration.schemaAttributes = (configuration.schemaAttributes ?? []).map(attribute => ({
    name: attribute.name,
    attributeDataType: attribute.attributeDataType ?? "String",
    developerOnlyAttribute: attribute.developerOnlyAttribute ?? false,
    mutable: attribute.mutable,
    required: attribute.required,
    ...(attribute.stringAttributeConstraints
      ? { stringAttributeConstraints: attribute.stringAttributeConstraints }
      : {}),
    ...(attribute.numberAttributeConstraints
      ? { numberAttributeConstraints: attribute.numberAttributeConstraints }
      : {}),
  }));
  configuration.adminCreateUserConfig = {
    allowAdminCreateUserOnly: configuration.adminCreateUserConfig?.allowAdminCreateUserOnly ?? false,
    inviteMessageTemplate: configuration.adminCreateUserConfig?.inviteMessageTemplate ?? {
      emailSubject: "Your temporary password",
      emailMessage: "Your username is {username} and temporary password is {####}.",
    },
    ...(configuration.adminCreateUserConfig?.unusedAccountValidityDays === undefined
      ? {}
      : { unusedAccountValidityDays: configuration.adminCreateUserConfig.unusedAccountValidityDays }),
  };
  configuration.mfaConfiguration ??= "OFF";
  configuration.enabledMfas ??= [];
  configuration.lambdaConfig ??= {};
}

function normalizeClient(client: CognitoAppClientState): void {
  client.refreshTokenRotation ??= { feature: "DISABLED", retryGracePeriodSeconds: 0 };
}

function normalizeUser(user: CognitoUserState): void {
  user.passwordHistory ??= [];
  user.passwordChangedAt ??= user.createdAt;
  user.activeAttributeVerificationIntentIds ??= {};
  user.groupNames ??= [];
  user.mfa ??= {};
  user.userMfaSettingList ??= [];
  user.devices ??= {};
}

/**
 * COG-03 opens durable ordinary user lifecycle state. Existing COG-01 users,
 * clients, and pools retain their behavior and receive only inert defaults.
 */
export function migrateV53ToV54(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      for (const pool of Object.values(region.cognito.pools ?? {})) {
        normalizeConfiguration(pool.configuration);
        for (const client of Object.values(pool.clients ?? {})) normalizeClient(client);
        for (const user of Object.values(pool.usersBySub ?? {})) normalizeUser(user);
        pool.groups ??= {};
        pool.challenges ??= {};
        pool.authEvents ??= [];
        pool.tags ??= {};
      }
    }
  }
  state.schemaVersion = 54;
  return state;
}
