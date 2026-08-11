export type CognitoAuthorizationClass =
  | "IAM"
  | "PUBLIC_APP_CLIENT"
  | "ACCESS_TOKEN"
  | "REFRESH_TOKEN"
  | "PUBLIC_OR_REFRESH"
  | "CHALLENGE"
  | "CHALLENGE_OR_ACCESS";

export interface CognitoActionInventoryEntry {
  operation: string;
  target: string;
  authorization: CognitoAuthorizationClass;
}

const PREFIX = "AWSCognitoIdentityProviderService.";

const entries: Array<[string, CognitoAuthorizationClass]> = [
  ["CreateUserPool", "IAM"],
  ["DescribeUserPool", "IAM"],
  ["ListUserPools", "IAM"],
  ["UpdateUserPool", "IAM"],
  ["DeleteUserPool", "IAM"],
  ["CreateUserPoolClient", "IAM"],
  ["DescribeUserPoolClient", "IAM"],
  ["ListUserPoolClients", "IAM"],
  ["UpdateUserPoolClient", "IAM"],
  ["DeleteUserPoolClient", "IAM"],
  ["SignUp", "PUBLIC_APP_CLIENT"],
  ["ConfirmSignUp", "PUBLIC_APP_CLIENT"],
  ["ResendConfirmationCode", "PUBLIC_APP_CLIENT"],
  ["InitiateAuth", "PUBLIC_OR_REFRESH"],
  ["GetTokensFromRefreshToken", "REFRESH_TOKEN"],
  ["RevokeToken", "REFRESH_TOKEN"],
  ["GlobalSignOut", "ACCESS_TOKEN"],
  ["GetUser", "ACCESS_TOKEN"],
  ["AddCustomAttributes", "IAM"],
  ["AdminAddUserToGroup", "IAM"],
  ["AdminConfirmSignUp", "IAM"],
  ["AdminCreateUser", "IAM"],
  ["AdminDeleteUser", "IAM"],
  ["AdminDeleteUserAttributes", "IAM"],
  ["AdminDisableUser", "IAM"],
  ["AdminEnableUser", "IAM"],
  ["AdminForgetDevice", "IAM"],
  ["AdminGetDevice", "IAM"],
  ["AdminGetUser", "IAM"],
  ["AdminInitiateAuth", "IAM"],
  ["AdminListDevices", "IAM"],
  ["AdminListGroupsForUser", "IAM"],
  ["AdminListUserAuthEvents", "IAM"],
  ["AdminRemoveUserFromGroup", "IAM"],
  ["AdminResetUserPassword", "IAM"],
  ["AdminRespondToAuthChallenge", "IAM"],
  ["AdminSetUserMFAPreference", "IAM"],
  ["AdminSetUserPassword", "IAM"],
  ["AdminSetUserSettings", "IAM"],
  ["AdminUpdateAuthEventFeedback", "IAM"],
  ["AdminUpdateDeviceStatus", "IAM"],
  ["AdminUpdateUserAttributes", "IAM"],
  ["AdminUserGlobalSignOut", "IAM"],
  ["AssociateSoftwareToken", "CHALLENGE_OR_ACCESS"],
  ["ChangePassword", "ACCESS_TOKEN"],
  ["ConfirmDevice", "ACCESS_TOKEN"],
  ["ConfirmForgotPassword", "PUBLIC_APP_CLIENT"],
  ["CreateGroup", "IAM"],
  ["DeleteGroup", "IAM"],
  ["DeleteUser", "ACCESS_TOKEN"],
  ["DeleteUserAttributes", "ACCESS_TOKEN"],
  ["DeleteUserPoolReplica", "IAM"],
  ["ForgetDevice", "ACCESS_TOKEN"],
  ["ForgotPassword", "PUBLIC_APP_CLIENT"],
  ["GetDevice", "ACCESS_TOKEN"],
  ["GetGroup", "IAM"],
  ["GetUserAttributeVerificationCode", "ACCESS_TOKEN"],
  ["GetUserAuthFactors", "ACCESS_TOKEN"],
  ["GetUserPoolMfaConfig", "IAM"],
  ["ListDevices", "ACCESS_TOKEN"],
  ["ListGroups", "IAM"],
  ["ListTagsForResource", "IAM"],
  ["ListUsers", "IAM"],
  ["ListUsersInGroup", "IAM"],
  ["RespondToAuthChallenge", "CHALLENGE"],
  ["SetUserMFAPreference", "ACCESS_TOKEN"],
  ["SetUserPoolMfaConfig", "IAM"],
  ["SetUserSettings", "ACCESS_TOKEN"],
  ["TagResource", "IAM"],
  ["UntagResource", "IAM"],
  ["UpdateAuthEventFeedback", "ACCESS_TOKEN"],
  ["UpdateDeviceStatus", "ACCESS_TOKEN"],
  ["UpdateGroup", "IAM"],
  ["UpdateUserAttributes", "ACCESS_TOKEN"],
  ["VerifySoftwareToken", "CHALLENGE_OR_ACCESS"],
  ["VerifyUserAttribute", "ACCESS_TOKEN"],
  ["CreateManagedLoginBranding", "IAM"],
  ["CreateResourceServer", "IAM"],
  ["CreateUserPoolDomain", "IAM"],
  ["DeleteManagedLoginBranding", "IAM"],
  ["DeleteResourceServer", "IAM"],
  ["DeleteUserPoolDomain", "IAM"],
  ["DescribeManagedLoginBranding", "IAM"],
  ["DescribeManagedLoginBrandingByClient", "IAM"],
  ["DescribeResourceServer", "IAM"],
  ["DescribeUserPoolDomain", "IAM"],
  ["GetUICustomization", "IAM"],
  ["ListResourceServers", "IAM"],
  ["SetUICustomization", "IAM"],
  ["UpdateManagedLoginBranding", "IAM"],
  ["UpdateResourceServer", "IAM"],
  ["UpdateUserPoolDomain", "IAM"],
  ["CreateIdentityProvider", "IAM"],
  ["DescribeIdentityProvider", "IAM"],
  ["GetIdentityProviderByIdentifier", "IAM"],
  ["ListIdentityProviders", "IAM"],
  ["UpdateIdentityProvider", "IAM"],
  ["DeleteIdentityProvider", "IAM"],
  ["AdminLinkProviderForUser", "IAM"],
  ["AdminDisableProviderForUser", "IAM"],
  ["AddUserPoolClientSecret", "IAM"],
  ["DeleteUserPoolClientSecret", "IAM"],
  ["ListUserPoolClientSecrets", "IAM"],
  ["CompleteWebAuthnRegistration", "ACCESS_TOKEN"],
  ["DeleteWebAuthnCredential", "ACCESS_TOKEN"],
  ["ListWebAuthnCredentials", "ACCESS_TOKEN"],
  ["StartWebAuthnRegistration", "ACCESS_TOKEN"],
  ["CreateTerms", "IAM"],
  ["DeleteTerms", "IAM"],
  ["DescribeTerms", "IAM"],
  ["ListTerms", "IAM"],
  ["UpdateTerms", "IAM"],
  ["CreateUserImportJob", "IAM"],
  ["DescribeUserImportJob", "IAM"],
  ["GetCSVHeader", "IAM"],
  ["ListUserImportJobs", "IAM"],
  ["StartUserImportJob", "IAM"],
  ["StopUserImportJob", "IAM"],
  ["CreateUserPoolReplica", "IAM"],
  ["ListUserPoolReplicas", "IAM"],
  ["UpdateUserPoolReplica", "IAM"],
  ["DescribeRiskConfiguration", "IAM"],
  ["SetRiskConfiguration", "IAM"],
  ["GetLogDeliveryConfiguration", "IAM"],
  ["SetLogDeliveryConfiguration", "IAM"],
  ["GetProvisionedLimit", "IAM"],
  ["UpdateProvisionedLimit", "IAM"],
  ["GetSigningCertificate", "IAM"],
];

export const COGNITO_ACTION_INVENTORY = new Map<string, CognitoActionInventoryEntry>(
  entries.map(([operation, authorization]) => [
    operation,
    { operation, authorization, target: `${PREFIX}${operation}` },
  ]),
);

export function cognitoTargetOperation(target: unknown): string | undefined {
  if (typeof target !== "string" || !target.startsWith(PREFIX)) return undefined;
  const operation = target.slice(PREFIX.length);
  return COGNITO_ACTION_INVENTORY.has(operation) ? operation : undefined;
}

export function cognitoAuthorizationClass(target: unknown): CognitoAuthorizationClass | undefined {
  const operation = cognitoTargetOperation(target);
  return operation === undefined ? undefined : COGNITO_ACTION_INVENTORY.get(operation)?.authorization;
}

export function isCognitoNonIamTarget(target: unknown): boolean {
  const authorization = cognitoAuthorizationClass(target);
  return authorization !== undefined && authorization !== "IAM";
}
