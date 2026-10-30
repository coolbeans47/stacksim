import { AwsError } from "../errors.js";

export type CognitoCog07BoundaryCategory =
  | "webauthn"
  | "user-import"
  | "managed-login-terms"
  | "user-pool-replica"
  | "threat-protection"
  | "log-delivery"
  | "provisioned-limit"
  | "saml-signing-certificate"
  | "advanced-token-customization"
  | "sms-delivery"
  | "custom-auth-challenge"
  | "user-migration"
  | "custom-sender"
  | "inbound-federation-trigger"
  | "issuer-key-configuration"
  | "step-up-authentication"
  | "pinpoint-analytics"
  | "email-link-verification"
  | "client-token-auth"
  | "admin-auth-factors";

const MESSAGES: Record<CognitoCog07BoundaryCategory, string> = {
  webauthn:
    "WebAuthn and passkey operations require a local browser ceremony that is not implemented in this simulator.",
  "user-import":
    "User import jobs require durable bulk-import processing that is not implemented in this simulator.",
  "managed-login-terms":
    "Managed-login terms require hosted terms-of-use content that is not implemented in this simulator.",
  "user-pool-replica":
    "User pool replicas and multi-Region issuer behavior are not implemented in this simulator.",
  "threat-protection":
    "Threat protection and risk configuration require production adaptive-security telemetry that is not implemented in this simulator.",
  "log-delivery":
    "Cognito log delivery requires a supported CloudWatch Logs destination contract that is not implemented in this simulator.",
  "provisioned-limit":
    "Provisioned user-pool limits are a billing-tier control that is not implemented in this simulator.",
  "saml-signing-certificate":
    "SAML signing-certificate export requires a SAML identity provider with exportable metadata that is not implemented in this simulator.",
  "advanced-token-customization":
    "Advanced token customization for V2_0/V3_0 access tokens and M2M aws_client_metadata is not implemented in this simulator.",
  "sms-delivery":
    "SMS messages, SMS MFA, and SMS one-time passwords require Amazon SNS delivery that is not implemented in this simulator.",
  "custom-auth-challenge":
    "Custom authentication challenges (CUSTOM_AUTH with the define, create, and verify auth challenge triggers) are not implemented in this simulator.",
  "user-migration":
    "The migrate user Lambda trigger is not implemented in this simulator.",
  "custom-sender":
    "Custom email and SMS sender triggers and their KMS key are not implemented in this simulator.",
  "inbound-federation-trigger":
    "The inbound federation Lambda trigger is not implemented in this simulator.",
  "issuer-key-configuration":
    "IssuerConfiguration and KeyConfiguration (the updated issuer and customer-managed signing keys) are not implemented in this simulator.",
  "step-up-authentication":
    "Step-up authentication (AcrConfiguration, TARGET_ACR_VALUES, and MAX_AGE) is not implemented in this simulator.",
  "pinpoint-analytics":
    "App-client analytics through Amazon Pinpoint are not implemented in this simulator.",
  "email-link-verification":
    "Link-based email confirmation (CONFIRM_WITH_LINK) is not implemented in this simulator; use CONFIRM_WITH_CODE.",
  "client-token-auth":
    "GetClientToken and ALLOW_CLIENT_TOKEN_AUTH machine-to-machine tokens without a domain are not implemented in this simulator; use the client_credentials grant on the user pool domain.",
  "admin-auth-factors":
    "AdminGetUserAuthFactors and AdminDeleteSoftwareToken are not implemented in this simulator; use AdminGetUser and AdminSetUserMFAPreference.",
};

const OPERATION_BOUNDARIES: Record<string, CognitoCog07BoundaryCategory> = {
  StartWebAuthnRegistration: "webauthn",
  CompleteWebAuthnRegistration: "webauthn",
  ListWebAuthnCredentials: "webauthn",
  DeleteWebAuthnCredential: "webauthn",
  CreateUserImportJob: "user-import",
  DescribeUserImportJob: "user-import",
  GetCSVHeader: "user-import",
  ListUserImportJobs: "user-import",
  StartUserImportJob: "user-import",
  StopUserImportJob: "user-import",
  CreateTerms: "managed-login-terms",
  DeleteTerms: "managed-login-terms",
  DescribeTerms: "managed-login-terms",
  ListTerms: "managed-login-terms",
  UpdateTerms: "managed-login-terms",
  CreateUserPoolReplica: "user-pool-replica",
  ListUserPoolReplicas: "user-pool-replica",
  UpdateUserPoolReplica: "user-pool-replica",
  DescribeRiskConfiguration: "threat-protection",
  SetRiskConfiguration: "threat-protection",
  GetLogDeliveryConfiguration: "log-delivery",
  SetLogDeliveryConfiguration: "log-delivery",
  GetProvisionedLimit: "provisioned-limit",
  UpdateProvisionedLimit: "provisioned-limit",
  GetSigningCertificate: "saml-signing-certificate",
  DescribeTermsByClient: "managed-login-terms",
  GetClientToken: "client-token-auth",
  AdminGetUserAuthFactors: "admin-auth-factors",
  AdminDeleteSoftwareToken: "admin-auth-factors",
};

export function cog07BoundaryCategory(operation: string): CognitoCog07BoundaryCategory | undefined {
  return OPERATION_BOUNDARIES[operation];
}

export function throwCog07Boundary(category: CognitoCog07BoundaryCategory): never {
  throw new AwsError("InvalidParameterException", MESSAGES[category]);
}

export function cog07BoundaryMessage(category: CognitoCog07BoundaryCategory): string {
  return MESSAGES[category];
}

export function throwCog07BoundaryForOperation(operation: string): never {
  const category = cog07BoundaryCategory(operation);
  if (!category) {
    throw new AwsError("UnknownOperationException", "Unknown operation.");
  }
  throwCog07Boundary(category);
}

export const COG07_BOUNDARY_OPERATIONS = Object.freeze(Object.keys(OPERATION_BOUNDARIES));
