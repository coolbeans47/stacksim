import { AwsError } from "../errors.js";

export type CognitoCog07BoundaryCategory =
  | "webauthn"
  | "user-import"
  | "managed-login-terms"
  | "user-pool-replica"
  | "threat-protection"
  | "log-delivery"
  | "provisioned-limit"
  | "saml-signing-certificate";

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
};

export function cog07BoundaryCategory(operation: string): CognitoCog07BoundaryCategory | undefined {
  return OPERATION_BOUNDARIES[operation];
}

export function throwCog07Boundary(category: CognitoCog07BoundaryCategory): never {
  throw new AwsError("InvalidParameterException", MESSAGES[category]);
}

export function throwCog07BoundaryForOperation(operation: string): never {
  const category = cog07BoundaryCategory(operation);
  if (!category) {
    throw new AwsError("UnknownOperationException", "Unknown operation.");
  }
  throwCog07Boundary(category);
}

export const COG07_BOUNDARY_OPERATIONS = Object.freeze(Object.keys(OPERATION_BOUNDARIES));
