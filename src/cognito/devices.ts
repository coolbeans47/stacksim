import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AwsError } from "../errors.js";
import type {
  CognitoAppClientState,
  CognitoPendingDeviceState,
  CognitoUserPoolConfigurationState,
  CognitoUserState,
} from "../types.js";

export const MAX_DEVICES_PER_USER = 50;
export const DEVICE_KEY_PATTERN = /^[\w-]+_[0-9a-f-]+$/;

export function parseDeviceConfiguration(
  value: unknown,
): CognitoUserPoolConfigurationState["deviceConfiguration"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AwsError("InvalidParameterException", "DeviceConfiguration is invalid.");
  }
  const input = value as Record<string, unknown>;
  const unsupported = Object.keys(input).filter(key =>
    !["ChallengeRequiredOnNewDevice", "DeviceOnlyRememberedOnUserPrompt"].includes(key)
  );
  if (unsupported.length) {
    throw new AwsError(
      "InvalidParameterException",
      `DeviceConfiguration.${unsupported[0]} is invalid.`,
    );
  }
  const challengeRequiredOnNewDevice = input.ChallengeRequiredOnNewDevice === undefined
    ? false
    : (() => {
        if (typeof input.ChallengeRequiredOnNewDevice !== "boolean") {
          throw new AwsError("InvalidParameterException", "ChallengeRequiredOnNewDevice must be a boolean.");
        }
        return input.ChallengeRequiredOnNewDevice;
      })();
  const deviceOnlyRememberedOnUserPrompt = input.DeviceOnlyRememberedOnUserPrompt === undefined
    ? false
    : (() => {
        if (typeof input.DeviceOnlyRememberedOnUserPrompt !== "boolean") {
          throw new AwsError(
            "InvalidParameterException",
            "DeviceOnlyRememberedOnUserPrompt must be a boolean.",
          );
        }
        return input.DeviceOnlyRememberedOnUserPrompt;
      })();
  return { challengeRequiredOnNewDevice, deviceOnlyRememberedOnUserPrompt };
}

export function deviceConfigurationView(
  configuration: CognitoUserPoolConfigurationState["deviceConfiguration"],
): Record<string, boolean> | undefined {
  if (!configuration) return undefined;
  return {
    ChallengeRequiredOnNewDevice: configuration.challengeRequiredOnNewDevice,
    DeviceOnlyRememberedOnUserPrompt: configuration.deviceOnlyRememberedOnUserPrompt,
  };
}

export function deviceTrackingEnabled(
  configuration: CognitoUserPoolConfigurationState,
): boolean {
  return configuration.deviceConfiguration !== undefined;
}

export function issuePendingDeviceKey(region: string): string {
  return `${region}_${randomUUID()}`;
}

export function issueDeviceGroupKey(): string {
  return `-${randomBytes(4).toString("hex")}`;
}

export function createPendingDevice(input: {
  region: string;
  client: CognitoAppClientState;
  eventId: string;
  now: number;
}): CognitoPendingDeviceState {
  const createdAt = input.now;
  return {
    key: issuePendingDeviceKey(input.region),
    groupKey: issueDeviceGroupKey(),
    clientId: input.client.id,
    eventId: input.eventId,
    createdAt,
    expiresAt: createdAt + Math.max(1, input.client.authSessionValidity) * 60_000,
  };
}

export function ensurePendingDevices(user: CognitoUserState): Record<string, CognitoPendingDeviceState> {
  user.pendingDevices ??= {};
  return user.pendingDevices;
}

export function purgeExpiredPendingDevices(user: CognitoUserState, now: number): boolean {
  const pending = user.pendingDevices;
  if (!pending) return false;
  let changed = false;
  for (const [key, device] of Object.entries(pending)) {
    if (now >= device.expiresAt) {
      delete pending[key];
      changed = true;
    }
  }
  return changed;
}

export function assertDeviceKey(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 55
    || !DEVICE_KEY_PATTERN.test(value)
  ) {
    throw new AwsError("InvalidParameterException", "DeviceKey is invalid.");
  }
  return value;
}

export function decodeDeviceVerifierMaterial(passwordVerifier: string, salt: string): {
  verifierHex: string;
  saltHex: string;
} {
  let verifierBytes: Buffer;
  let saltBytes: Buffer;
  try {
    verifierBytes = Buffer.from(passwordVerifier, "base64");
    saltBytes = Buffer.from(salt, "base64");
  } catch {
    throw new AwsError("InvalidParameterException", "DeviceSecretVerifierConfig is invalid.");
  }
  if (
    verifierBytes.length < 1
    || verifierBytes.length > 384
    || saltBytes.length < 1
    || saltBytes.length > 128
    || passwordVerifier !== verifierBytes.toString("base64")
    || salt !== saltBytes.toString("base64")
  ) {
    verifierBytes.fill(0);
    saltBytes.fill(0);
    throw new AwsError("InvalidParameterException", "DeviceSecretVerifierConfig is invalid.");
  }
  try {
    return {
      verifierHex: verifierBytes.toString("hex"),
      saltHex: saltBytes.toString("hex"),
    };
  } finally {
    verifierBytes.fill(0);
    saltBytes.fill(0);
  }
}

export function deviceIdentityHash(deviceGroupKey: string, deviceKey: string, deviceSecret: string): Buffer {
  return createHash("sha256")
    .update(`${deviceGroupKey}${deviceKey}:${deviceSecret}`, "utf8")
    .digest();
}
