import { randomBytes } from "node:crypto";
import { AwsError } from "../errors.js";
import type { CognitoAppClientState, CognitoClientSecretEntryState, CognitoRecoverableSecretState } from "../types.js";

export const MAX_ACTIVE_CLIENT_SECRETS = 2;

function randomAlphaNumeric(length: number, alphabet: string): string {
  const bytes = randomBytes(length);
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += alphabet[bytes[index]! % alphabet.length];
  }
  return value;
}

export function normalizedClientSecrets(client: CognitoAppClientState): CognitoClientSecretEntryState[] {
  if (client.clientSecrets?.length) return client.clientSecrets;
  if (!client.secret) return [];
  return [{
    id: client.secret.id,
    createdAt: client.createdAt,
    envelope: client.secret,
  }];
}

export function clientHasSecret(client: CognitoAppClientState): boolean {
  return normalizedClientSecrets(client).length > 0;
}

export function clientSecretEntries(
  client: CognitoAppClientState,
): Array<{ entry: CognitoClientSecretEntryState; envelope: CognitoRecoverableSecretState }> {
  return normalizedClientSecrets(client).map(entry => ({
    entry,
    envelope: entry.envelope,
  }));
}

export function validateSuppliedClientSecret(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 24
    || value.length > 64
    || !/^[A-Za-z0-9_+]+$/.test(value)
  ) {
    throw new AwsError(
      "InvalidParameterException",
      "ClientSecret must be 24-64 characters containing only letters, numbers, underscore, or plus.",
    );
  }
  return value;
}

export function parseAddUserPoolClientSecretInput(input: Record<string, unknown>): {
  userPoolId: string;
  clientId: string;
  generate: boolean;
  supplied?: string;
} {
  if (
    Object.keys(input).some(key => !["UserPoolId", "ClientId", "ClientSecret"].includes(key))
    || typeof input.UserPoolId !== "string"
    || typeof input.ClientId !== "string"
  ) {
    throw new AwsError("InvalidParameterException", "AddUserPoolClientSecret parameters are invalid.");
  }
  if (input.ClientSecret === undefined) {
    return { userPoolId: input.UserPoolId, clientId: input.ClientId, generate: true };
  }
  return {
    userPoolId: input.UserPoolId,
    clientId: input.ClientId,
    generate: false,
    supplied: validateSuppliedClientSecret(input.ClientSecret),
  };
}

export function parseListUserPoolClientSecretsInput(input: Record<string, unknown>): {
  userPoolId: string;
  clientId: string;
} {
  if (
    Object.keys(input).some(key => !["UserPoolId", "ClientId"].includes(key))
    || typeof input.UserPoolId !== "string"
    || typeof input.ClientId !== "string"
  ) {
    throw new AwsError("InvalidParameterException", "ListUserPoolClientSecrets parameters are invalid.");
  }
  return { userPoolId: input.UserPoolId, clientId: input.ClientId };
}

export function parseDeleteUserPoolClientSecretInput(input: Record<string, unknown>): {
  userPoolId: string;
  clientId: string;
  clientSecretId: string;
} {
  if (
    Object.keys(input).some(key => !["UserPoolId", "ClientId", "ClientSecretId"].includes(key))
    || typeof input.UserPoolId !== "string"
    || typeof input.ClientId !== "string"
    || typeof input.ClientSecretId !== "string"
    || input.ClientSecretId.length < 1
    || input.ClientSecretId.length > 128
  ) {
    throw new AwsError("InvalidParameterException", "DeleteUserPoolClientSecret parameters are invalid.");
  }
  return {
    userPoolId: input.UserPoolId,
    clientId: input.ClientId,
    clientSecretId: input.ClientSecretId,
  };
}

export function createClientSecretEntry(
  poolId: string,
  clientId: string,
  createdAt: number,
  secretState: (poolIdValue: string, clientIdValue: string, value: string) => CognitoRecoverableSecretState,
  value: string,
): CognitoClientSecretEntryState {
  const envelope = secretState(poolId, clientId, value);
  return { id: envelope.id, createdAt, envelope };
}

export function generatedClientSecretValue(): string {
  return randomAlphaNumeric(64, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
}

export function clientSecretDescriptor(
  entry: CognitoClientSecretEntryState,
  includeValue?: string,
): Record<string, unknown> {
  return {
    ClientSecretId: entry.id,
    ClientSecretCreateDate: entry.createdAt / 1_000,
    ...(includeValue === undefined ? {} : { ClientSecretValue: includeValue }),
  };
}

export function assignClientSecrets(
  client: CognitoAppClientState,
  secrets: CognitoClientSecretEntryState[],
): void {
  client.clientSecrets = secrets;
  client.secret = secrets[0]?.envelope;
}

export function ensureConfidentialClient(client: CognitoAppClientState): CognitoClientSecretEntryState[] {
  const secrets = normalizedClientSecrets(client);
  if (!secrets.length) {
    throw new AwsError(
      "InvalidParameterException",
      "AddUserPoolClientSecret is supported only for confidential app clients.",
    );
  }
  return secrets;
}
