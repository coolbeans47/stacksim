import { createHash, type JsonWebKey } from "node:crypto";
import type { CognitoUserPoolState } from "../types.js";
import {
  JwtValidationError,
  parseJwt,
  verifyParsedJwt,
} from "../core/jwt.js";
import { cognitoIssuer } from "./tokens.js";
import { signingKeysEtag } from "./signing.js";

const COGNITO_ALGORITHMS = new Set(["RS256"]);
const MAX_CLAIMS = 128;
const MAX_CLAIM_NAME_BYTES = 256;
const MAX_CLAIM_VALUE_BYTES = 8_192;
const MAX_CLAIM_TOTAL_BYTES = 24_576;
const MAX_ARRAY_VALUES = 100;

export type CognitoIssuerResolution =
  | { kind: "UNOWNED" }
  | {
      kind: "AVAILABLE";
      accountId: string;
      region: string;
      userPoolId: string;
      keys: JsonWebKey[];
    }
  | {
      kind: "CLAIMED_UNAVAILABLE";
      accountId: string;
      region: string;
      userPoolId: string;
      reason: "DELETED" | "CLOSED" | "KEYS_UNAVAILABLE";
    };

export interface CognitoIssuerKeySource {
  resolveIssuer(issuer: string): Promise<CognitoIssuerResolution>;
}

export type CognitoRestClaim = string | number | boolean | string[];

export interface CognitoRestAuthorizerVerification {
  claims: Record<string, CognitoRestClaim>;
  scopes: string[];
  expiresAt: number;
  cacheVersion: string;
  userPoolArn?: string;
}

export interface CognitoRestAuthorizerVerifier {
  verify(input: {
    token: string;
    allowedUserPoolArns: string[];
    expectedUse: "id" | "access";
    audienceExpression?: string;
    requiredScopes?: string[];
  }): Promise<CognitoRestAuthorizerVerification>;
  cacheVersion(allowedUserPoolArns: string[]): Promise<string>;
}

export class CognitoRestTokenError extends Error {
  constructor() {
    super("The Cognito token is invalid");
    this.name = "CognitoRestTokenError";
  }
}

export class CognitoRestConfigurationError extends Error {
  constructor(message = "The Cognito authorizer configuration is unavailable") {
    super(message);
    this.name = "CognitoRestConfigurationError";
  }
}

export interface CognitoUserPoolArn {
  partition: "aws" | "aws-cn" | "aws-us-gov";
  region: string;
  accountId: string;
  userPoolId: string;
}

export function parseCognitoUserPoolArn(value: unknown): CognitoUserPoolArn | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^arn:(aws|aws-cn|aws-us-gov):cognito-idp:([a-z]{2}(?:-gov)?-[a-z0-9-]+-\d):(\d{12}):userpool\/([a-z]{2}(?:-gov)?-[a-z0-9-]+-\d_[A-Za-z0-9]{9})$/.exec(value);
  if (!match) return undefined;
  const expectedPartition = match[2].startsWith("cn-")
    ? "aws-cn"
    : match[2].startsWith("us-gov-")
      ? "aws-us-gov"
      : "aws";
  if (match[1] !== expectedPartition || !match[4].startsWith(`${match[2]}_`)) return undefined;
  return {
    partition: match[1] as CognitoUserPoolArn["partition"],
    region: match[2],
    accountId: match[3],
    userPoolId: match[4],
  };
}

function requiredString(
  claims: Record<string, unknown>,
  name: string,
  maximum = MAX_CLAIM_VALUE_BYTES,
): string {
  const value = claims[name];
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > maximum
  ) {
    throw new CognitoRestTokenError();
  }
  return value;
}

function requiredTime(claims: Record<string, unknown>, name: string): number {
  const value = claims[name];
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new CognitoRestTokenError();
  return Number(value);
}

function boundedClaims(claims: Record<string, unknown>): Record<string, CognitoRestClaim> {
  const entries = Object.entries(claims);
  if (entries.length > MAX_CLAIMS) throw new CognitoRestTokenError();
  let total = 0;
  const result: Record<string, CognitoRestClaim> = {};
  for (const [name, value] of entries) {
    const nameBytes = Buffer.byteLength(name, "utf8");
    if (!name || nameBytes > MAX_CLAIM_NAME_BYTES) throw new CognitoRestTokenError();
    total += nameBytes;
    if (typeof value === "string") {
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes > MAX_CLAIM_VALUE_BYTES) throw new CognitoRestTokenError();
      total += bytes;
      result[name] = value;
    } else if (typeof value === "boolean") {
      total += value ? 4 : 5;
      result[name] = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw new CognitoRestTokenError();
      total += String(value).length;
      result[name] = value;
    } else if (Array.isArray(value)) {
      if (
        value.length > MAX_ARRAY_VALUES
        || value.some(item => typeof item !== "string" || Buffer.byteLength(item, "utf8") > MAX_CLAIM_VALUE_BYTES)
      ) {
        throw new CognitoRestTokenError();
      }
      total += value.reduce((sum, item) => sum + Buffer.byteLength(item, "utf8"), 0);
      result[name] = [...value];
    } else {
      throw new CognitoRestTokenError();
    }
    if (total > MAX_CLAIM_TOTAL_BYTES) throw new CognitoRestTokenError();
  }
  return result;
}

export function verifyCognitoRestToken(
  pool: CognitoUserPoolState,
  region: string,
  nowMs: number,
  input: {
    token: string;
    expectedUse: "id" | "access";
    audienceExpression?: string;
    requiredScopes?: string[];
  },
): CognitoRestAuthorizerVerification {
  if (!pool.signingKeys) throw new CognitoRestConfigurationError("The Cognito user pool signing keys are unavailable");
  let parsed;
  try {
    parsed = parseJwt(input.token);
  } catch {
    throw new CognitoRestTokenError();
  }
  if (parsed.header.alg !== "RS256" || parsed.header.typ !== "JWT") throw new CognitoRestTokenError();
  const issuer = requiredString(parsed.claims, "iss");
  if (issuer !== cognitoIssuer(region, pool.id)) throw new CognitoRestTokenError();
  const ring = pool.signingKeys[input.expectedUse];
  const kid = parsed.header.kid;
  if (typeof kid !== "string" || !ring.keys[kid] || ring.keys[kid].tokenUse !== input.expectedUse) {
    throw new CognitoRestTokenError();
  }
  try {
    verifyParsedJwt(parsed, [ring.keys[kid].publicJwk as unknown as JsonWebKey], COGNITO_ALGORITHMS);
  } catch (error) {
    if (error instanceof JwtValidationError) throw new CognitoRestTokenError();
    throw error;
  }
  if (parsed.claims.token_use !== input.expectedUse) throw new CognitoRestTokenError();
  requiredString(parsed.claims, "sub", 256);
  const issuedAt = requiredTime(parsed.claims, "iat");
  const expiresAt = requiredTime(parsed.claims, "exp");
  const now = Math.floor(nowMs / 1_000);
  const notBefore = parsed.claims.nbf === undefined ? undefined : requiredTime(parsed.claims, "nbf");
  if (
    expiresAt <= now
    || expiresAt <= issuedAt
    || issuedAt > now + 300
    || notBefore !== undefined && notBefore > now
  ) {
    throw new CognitoRestTokenError();
  }
  if (parsed.claims.auth_time !== undefined) {
    const authTime = requiredTime(parsed.claims, "auth_time");
    if (authTime > issuedAt) throw new CognitoRestTokenError();
  }
  let scopes: string[] = [];
  if (input.expectedUse === "id") {
    const audience = requiredString(parsed.claims, "aud", 256);
    if (input.audienceExpression) {
      let expression: RegExp;
      try {
        expression = new RegExp(input.audienceExpression);
      } catch {
        throw new CognitoRestConfigurationError("The Cognito audience validation expression is invalid");
      }
      if (!expression.test(audience)) throw new CognitoRestTokenError();
    }
  } else {
    requiredString(parsed.claims, "client_id", 256);
    const scope = requiredString(parsed.claims, "scope");
    scopes = [...new Set(scope.split(/\s+/).filter(Boolean))];
    if (
      input.requiredScopes?.length
      && !input.requiredScopes.some(required => scopes.includes(required))
    ) {
      throw new CognitoRestTokenError();
    }
  }
  return {
    claims: boundedClaims(parsed.claims),
    scopes,
    expiresAt: expiresAt * 1_000,
    cacheVersion: signingKeysEtag(pool.signingKeys),
  };
}

export function cognitoPoolCacheVersion(pool: CognitoUserPoolState): string {
  if (!pool.signingKeys) throw new CognitoRestConfigurationError("The Cognito user pool signing keys are unavailable");
  return createHash("sha256")
    .update(pool.arn)
    .update("\0")
    .update(signingKeysEtag(pool.signingKeys))
    .digest("hex");
}

export function restClaimsAsStrings(
  claims: Record<string, CognitoRestClaim>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(claims).map(([name, value]) => [
    name,
    Array.isArray(value) ? JSON.stringify(value) : String(value),
  ]));
}
