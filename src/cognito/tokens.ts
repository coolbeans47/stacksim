import type {
  CognitoSigningKeyState,
  CognitoUserPoolState,
} from "../types.js";
import {
  JwtValidationError,
  parseJwt,
  verifyParsedJwt,
} from "../core/jwt.js";

const USER_ADMIN_SCOPE = "aws.cognito.signin.user.admin";
const COGNITO_ALGORITHMS = new Set(["RS256"]);

export class CognitoTokenError extends Error {
  constructor() {
    super("Access Token has been revoked");
    this.name = "CognitoTokenError";
  }
}

export interface VerifiedCognitoAccessClaims {
  sub: string;
  clientId: string;
  issuer: string;
  username: string;
  eventId: string;
  authTime: number;
  issuedAt: number;
  expiresAt: number;
  jti?: string;
  originJti?: string;
}

export function cognitoIssuer(region: string, poolId: string): string {
  const ordinary = /^(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z0-9-]+-\d+$/.test(region);
  if (!ordinary && !/^cn-[a-z0-9-]+-\d+$/.test(region) && !/^us-gov-[a-z0-9-]+-\d+$/.test(region)) {
    throw new CognitoTokenError();
  }
  const suffix = region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  return `https://cognito-idp.${region}.${suffix}/${poolId}`;
}

function accessKey(pool: CognitoUserPoolState, kid: unknown): CognitoSigningKeyState {
  if (typeof kid !== "string" || kid.length < 1 || kid.length > 256 || !pool.signingKeys) {
    throw new CognitoTokenError();
  }
  const key = pool.signingKeys.access.keys[kid];
  if (
    !key
    || key.tokenUse !== "access"
    || key.kid !== kid
    || key.publicJwk.kid !== kid
    || key.publicJwk.kty !== "RSA"
    || key.publicJwk.alg !== "RS256"
    || key.publicJwk.use !== "sig"
  ) {
    throw new CognitoTokenError();
  }
  return key;
}

function requiredString(claims: Record<string, unknown>, name: string, maximum = 4_096): string {
  const value = claims[name];
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum) {
    throw new CognitoTokenError();
  }
  return value;
}

function requiredTime(claims: Record<string, unknown>, name: string): number {
  const value = claims[name];
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new CognitoTokenError();
  return Number(value);
}

export function verifyCognitoAccessToken(
  token: unknown,
  pools: Record<string, CognitoUserPoolState>,
  region: string,
  nowMs: number,
  options: { requiredScope?: string | false } = {},
): { pool: CognitoUserPoolState; claims: VerifiedCognitoAccessClaims } {
  let parsed;
  try {
    parsed = parseJwt(token);
  } catch {
    throw new CognitoTokenError();
  }
  const { header, claims } = parsed;
  if (header.alg !== "RS256" || header.typ !== "JWT") throw new CognitoTokenError();
  const issuer = requiredString(claims, "iss");
  const pool = Object.values(pools).find(candidate => {
    try {
      return cognitoIssuer(region, candidate.id) === issuer;
    } catch {
      return false;
    }
  });
  if (!pool) throw new CognitoTokenError();
  const key = accessKey(pool, header.kid);
  try {
    verifyParsedJwt(parsed, [key.publicJwk as unknown as import("node:crypto").JsonWebKey], COGNITO_ALGORITHMS);
  } catch (error) {
    if (error instanceof JwtValidationError) throw new CognitoTokenError();
    throw new CognitoTokenError();
  }
  if (claims.token_use !== "access") throw new CognitoTokenError();
  const sub = requiredString(claims, "sub", 256);
  const clientId = requiredString(claims, "client_id", 256);
  const username = requiredString(claims, "username", 256);
  const eventId = requiredString(claims, "event_id", 256);
  const scope = requiredString(claims, "scope", 8_192);
  const requiredScope = options.requiredScope === undefined ? USER_ADMIN_SCOPE : options.requiredScope;
  if (requiredScope && !scope.split(/\s+/).includes(requiredScope)) throw new CognitoTokenError();
  const authTime = requiredTime(claims, "auth_time");
  const issuedAt = requiredTime(claims, "iat");
  const expiresAt = requiredTime(claims, "exp");
  const now = Math.floor(nowMs / 1_000);
  if (expiresAt <= now || issuedAt > now + 300 || authTime > issuedAt || expiresAt <= issuedAt) {
    throw new CognitoTokenError();
  }
  const jti = claims.jti === undefined ? undefined : requiredString(claims, "jti", 256);
  const originJti = claims.origin_jti === undefined ? undefined : requiredString(claims, "origin_jti", 256);
  return {
    pool,
    claims: {
      sub,
      clientId,
      issuer,
      username,
      eventId,
      authTime,
      issuedAt,
      expiresAt,
      ...(jti ? { jti } : {}),
      ...(originJti ? { originJti } : {}),
    },
  };
}

export const COGNITO_USER_ADMIN_SCOPE = USER_ADMIN_SCOPE;
