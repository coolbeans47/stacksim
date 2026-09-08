import { AwsError } from "../errors.js";
import {
  IDENTITY_POOL_NAME_MAX_BYTES,
  MAX_LOGINS,
  MAX_PROVIDERS_PER_POOL,
  SOCIAL_LOGIN_KEYS,
  parseUserPoolProviderName,
} from "./model.js";

const REJECTED_POOL_FIELDS = [
  "DeveloperProviderName",
  "SupportedLoginProviders",
  "SamlProviderARNs",
  "OpenIdConnectProviderARNs",
  "CognitoEvents",
  "CognitoStreams",
  "PushSync",
] as const;

export function rejectUnsupportedPoolFields(input: Record<string, unknown>): void {
  for (const field of REJECTED_POOL_FIELDS) {
    if (input[field] !== undefined) {
      throw new AwsError("InvalidParameterException", `${field} is not supported.`);
    }
  }
  if (input.AllowClassicFlow === true) {
    throw new AwsError("InvalidParameterException", "AllowClassicFlow is not supported.");
  }
  if (input.AllowClassicFlow !== undefined && input.AllowClassicFlow !== false) {
    throw new AwsError("InvalidParameterException", "AllowClassicFlow must be false when present.");
  }
}

export function requiredString(value: unknown, field: string, min = 1, max = 128): string {
  if (typeof value !== "string" || value.length < min || Buffer.byteLength(value, "utf8") > max) {
    throw new AwsError("InvalidParameterException", `${field} is invalid.`);
  }
  return value;
}

export function identityPoolName(value: unknown, field = "IdentityPoolName"): string {
  const name = requiredString(value, field, 1, IDENTITY_POOL_NAME_MAX_BYTES);
  if (!/^[\w\s+=,.@-]+$/.test(name)) {
    throw new AwsError("InvalidParameterException", `${field} is invalid.`);
  }
  return name;
}

export function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new AwsError("InvalidParameterException", `${field} must be a boolean.`);
  }
  return value;
}

export function tagMap(value: unknown, field = "Tags"): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AwsError("InvalidParameterException", `${field} must be an object.`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 50) {
    throw new AwsError("InvalidParameterException", `${field} contains too many entries.`);
  }
  const tags: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (
      !key
      || key.length > 128
      || Buffer.byteLength(key, "utf8") > 128
      || typeof item !== "string"
      || item.length > 256
      || Buffer.byteLength(item, "utf8") > 256
      || key.toLowerCase().startsWith("aws:")
    ) {
      throw new AwsError("InvalidParameterException", `${field} contains an invalid key or value.`);
    }
    tags[key] = item;
  }
  return tags;
}

export function cognitoIdentityProviders(
  value: unknown,
  region: string,
): Array<{ providerName: string; clientId: string; serverSideTokenCheck: boolean }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AwsError("InvalidParameterException", "CognitoIdentityProviders must be a list.");
  }
  if (value.length > MAX_PROVIDERS_PER_POOL) {
    throw new AwsError("InvalidParameterException", "CognitoIdentityProviders exceeds the local provider limit.");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AwsError("InvalidParameterException", `CognitoIdentityProviders[${index}] is invalid.`);
    }
    const record = entry as Record<string, unknown>;
    const providerName = requiredString(record.ProviderName, `CognitoIdentityProviders[${index}].ProviderName`, 1, 2048);
    if (!parseUserPoolProviderName(providerName, region)) {
      throw new AwsError(
        "InvalidParameterException",
        `CognitoIdentityProviders[${index}].ProviderName must be a same-Region Cognito User Pool provider.`,
      );
    }
    const clientId = requiredString(record.ClientId, `CognitoIdentityProviders[${index}].ClientId`, 1, 128);
    if (record.ServerSideTokenCheck !== undefined && typeof record.ServerSideTokenCheck !== "boolean") {
      throw new AwsError("InvalidParameterException", `CognitoIdentityProviders[${index}].ServerSideTokenCheck must be a boolean.`);
    }
    const key = `${providerName}\0${clientId}`;
    if (seen.has(key)) {
      throw new AwsError("InvalidParameterException", "CognitoIdentityProviders contains a duplicate provider.");
    }
    seen.add(key);
    return {
      providerName,
      clientId,
      serverSideTokenCheck: record.ServerSideTokenCheck === true,
    };
  });
}

export function loginsMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AwsError("InvalidParameterException", "Logins must be an object.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_LOGINS) {
    throw new AwsError("InvalidParameterException", "Logins contains too many entries.");
  }
  const logins: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (
      typeof key !== "string"
      || key.length < 1
      || key.length > 128
      || typeof item !== "string"
      || item.length < 1
      || item.length > 50_000
    ) {
      throw new AwsError("InvalidParameterException", "Logins contains an invalid entry.");
    }
    if (SOCIAL_LOGIN_KEYS.includes(key) || /facebook|google|amazon|twitter|appleid/i.test(key) && !key.startsWith("cognito-idp.")) {
      throw new AwsError("InvalidParameterException", `Login provider ${key} is not supported.`);
    }
    logins[key] = item;
  }
  return logins;
}

export function identityPoolRoles(value: unknown): { authenticated?: string; unauthenticated?: string } {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AwsError("InvalidParameterException", "Roles must be an object.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "authenticated" && key !== "unauthenticated") {
      throw new AwsError("InvalidParameterException", `Roles.${key} is not supported.`);
    }
  }
  const authenticated = record.authenticated === undefined ? undefined : requiredString(record.authenticated, "Roles.authenticated", 20, 2048);
  const unauthenticated = record.unauthenticated === undefined ? undefined : requiredString(record.unauthenticated, "Roles.unauthenticated", 20, 2048);
  return { ...(authenticated ? { authenticated } : {}), ...(unauthenticated ? { unauthenticated } : {}) };
}
