/**
 * Frozen from `@aws-sdk/client-cognito-identity@3.1094.0`.
 *
 * Live unmodified-client `X-Amz-Target` capture on implementation day:
 * `AWSCognitoIdentityService.GetId` and `AWSCognitoIdentityService.ListIdentityPools`.
 * Smithy `serviceTarget` is `AWSCognitoIdentityService`. Do not invent a second success alias.
 */
export const COGNITO_IDENTITY_TARGET_PREFIX = "AWSCognitoIdentityService.";
export const COGNITO_IDENTITY_API_VERSION = "2014-06-30";
export const COGNITO_IDENTITY_SIGNING_NAME = "cognito-identity";
export const COGNITO_IDENTITY_ENDPOINT_ENV = "AWS_ENDPOINT_URL_COGNITO_IDENTITY";

export type CognitoIdentityAuthorizationClass = "IAM" | "PUBLIC_UNSIGNED" | "PUBLIC_IDENTITY";
export type CognitoIdentityActionPhase = "implemented-in-P0" | "later" | "explicit-reject";

export interface CognitoIdentityActionInventoryEntry {
  operation: string;
  target: string;
  authorization: CognitoIdentityAuthorizationClass;
  phase: CognitoIdentityActionPhase;
}

const implementedIam = [
  "CreateIdentityPool",
  "DescribeIdentityPool",
  "ListIdentityPools",
  "UpdateIdentityPool",
  "DeleteIdentityPool",
  "GetIdentityPoolRoles",
  "SetIdentityPoolRoles",
  "TagResource",
  "UntagResource",
  "ListTagsForResource",
] as const;

const laterIam = ["ListIdentities", "DescribeIdentity", "DeleteIdentities"] as const;
const rejectIam = [
  "GetOpenIdTokenForDeveloperIdentity",
  "LookupDeveloperIdentity",
  "MergeDeveloperIdentities",
  "UnlinkDeveloperIdentity",
  "GetPrincipalTagAttributeMap",
  "SetPrincipalTagAttributeMap",
] as const;

const entries: CognitoIdentityActionInventoryEntry[] = [
  ...implementedIam.map(operation => ({
    operation,
    target: `${COGNITO_IDENTITY_TARGET_PREFIX}${operation}`,
    authorization: "IAM" as const,
    phase: "implemented-in-P0" as const,
  })),
  {
    operation: "GetId",
    target: `${COGNITO_IDENTITY_TARGET_PREFIX}GetId`,
    authorization: "PUBLIC_UNSIGNED",
    phase: "implemented-in-P0",
  },
  {
    operation: "GetCredentialsForIdentity",
    target: `${COGNITO_IDENTITY_TARGET_PREFIX}GetCredentialsForIdentity`,
    authorization: "PUBLIC_IDENTITY",
    phase: "implemented-in-P0",
  },
  ...laterIam.map(operation => ({
    operation,
    target: `${COGNITO_IDENTITY_TARGET_PREFIX}${operation}`,
    authorization: "IAM" as const,
    phase: "later" as const,
  })),
  {
    operation: "GetOpenIdToken",
    target: `${COGNITO_IDENTITY_TARGET_PREFIX}GetOpenIdToken`,
    authorization: "PUBLIC_UNSIGNED",
    phase: "explicit-reject",
  },
  {
    operation: "UnlinkIdentity",
    target: `${COGNITO_IDENTITY_TARGET_PREFIX}UnlinkIdentity`,
    authorization: "PUBLIC_UNSIGNED",
    phase: "explicit-reject",
  },
  ...rejectIam.map(operation => ({
    operation,
    target: `${COGNITO_IDENTITY_TARGET_PREFIX}${operation}`,
    authorization: "IAM" as const,
    phase: "explicit-reject" as const,
  })),
];

export const COGNITO_IDENTITY_ACTION_INVENTORY = new Map<string, CognitoIdentityActionInventoryEntry>(
  entries.map(entry => [entry.operation, entry]),
);

export function isCognitoIdentityTarget(target: unknown): boolean {
  return typeof target === "string" && target.startsWith(COGNITO_IDENTITY_TARGET_PREFIX);
}

export function cognitoIdentityTargetOperation(target: unknown): string | undefined {
  if (!isCognitoIdentityTarget(target)) return undefined;
  const operation = String(target).slice(COGNITO_IDENTITY_TARGET_PREFIX.length);
  return COGNITO_IDENTITY_ACTION_INVENTORY.has(operation) ? operation : undefined;
}

export function cognitoIdentityAuthorizationClass(
  target: unknown,
): CognitoIdentityAuthorizationClass | undefined {
  const operation = cognitoIdentityTargetOperation(target);
  return operation === undefined ? undefined : COGNITO_IDENTITY_ACTION_INVENTORY.get(operation)?.authorization;
}

export function isCognitoIdentityNonIamTarget(target: unknown): boolean {
  const authorization = cognitoIdentityAuthorizationClass(target);
  return authorization === "PUBLIC_UNSIGNED" || authorization === "PUBLIC_IDENTITY";
}
