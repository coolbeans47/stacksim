import { randomBytes } from "node:crypto";

export const IDENTITY_ID_PATTERN = /^[\w-]+:[0-9a-f-]+$/;
export const MAX_IDENTITY_ID_LENGTH = 55;
export const MAX_IDENTITY_POOLS = 1000;
export const MAX_PROVIDERS_PER_POOL = 50;
export const MAX_IDENTITIES_PER_POOL = 10_000;
export const MAX_LOGINS = 10;
export const MAX_LIST_RESULTS = 60;
export const IDENTITY_POOL_NAME_MAX_BYTES = 128;
export const CREDENTIAL_LIFETIME_SECONDS = 3600;
export const GET_ID_RATE = 25;
export const GET_CREDENTIALS_RATE = 200;
export const TAG_RATE = 5;
export const LIST_TAGS_RATE = 10;
export const SOCIAL_LOGIN_KEYS = Object.freeze([
  "graph.facebook.com",
  "accounts.google.com",
  "www.amazon.com",
  "api.twitter.com",
  "appleid.apple.com",
]);

export type RandomBytes = (size: number) => Buffer;

export function partitionForRegion(region: string): "aws" | "aws-cn" | "aws-us-gov" {
  if (region.startsWith("cn-")) return "aws-cn";
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  return "aws";
}

export function dnsSuffixForRegion(region: string): "amazonaws.com" | "amazonaws.com.cn" {
  return region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
}

export function identityPoolArn(partition: string, region: string, accountId: string, poolId: string): string {
  return `arn:${partition}:cognito-identity:${region}:${accountId}:identitypool/${poolId}`;
}

export function userPoolProviderName(region: string, userPoolId: string): string {
  return `cognito-idp.${region}.${dnsSuffixForRegion(region)}/${userPoolId}`;
}

export function loginIndexKey(providerName: string, subject: string): string {
  return `${providerName}\0${subject}`;
}

export function uuidFromBytes(bytes: Buffer): string {
  const copy = Buffer.from(bytes.subarray(0, 16));
  copy[6] = (copy[6] & 0x0f) | 0x40;
  copy[8] = (copy[8] & 0x3f) | 0x80;
  const hex = copy.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function allocateIdentityId(region: string, random: RandomBytes = randomBytes): string {
  const id = `${region}:${uuidFromBytes(random(16))}`;
  if (id.length > MAX_IDENTITY_ID_LENGTH || !IDENTITY_ID_PATTERN.test(id)) {
    throw new Error("Allocated Cognito Identity ID is outside the frozen grammar.");
  }
  return id;
}

export function parseUserPoolProviderName(
  value: string,
  region: string,
): { userPoolId: string } | undefined {
  const suffix = dnsSuffixForRegion(region);
  const prefix = `cognito-idp.${region}.${suffix}/`;
  if (!value.startsWith(prefix)) return undefined;
  const userPoolId = value.slice(prefix.length);
  if (!userPoolId || userPoolId.includes("/")) return undefined;
  return { userPoolId };
}
