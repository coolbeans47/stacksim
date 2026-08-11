import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface VerificationTokenPayload {
  v: 1;
  accountId: string;
  region: string;
  identity: string;
  identityGeneration: string;
  intentId: string;
  messageId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

function key(secret: string, purpose: string): Buffer {
  // Signed-link domain. Keep the legacy value so links issued before the rename remain valid.
  return createHmac("sha256", Buffer.from(secret, "base64")).update(`stacksim:ses:${purpose}:v1`).digest();
}

export function deriveVerificationNonce(secret: string, value: Omit<VerificationTokenPayload, "v" | "nonce">): string {
  return createHmac("sha256", key(secret, "verification-nonce"))
    .update(JSON.stringify([value.accountId, value.region, value.identity, value.identityGeneration, value.intentId, value.messageId, value.issuedAt, value.expiresAt]))
    .digest("base64url");
}

export function verificationNonceDigest(nonce: string): string {
  return createHash("sha256").update(nonce).digest("base64url");
}

export function signVerificationToken(secret: string, payload: VerificationTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", key(secret, "verification-token")).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyVerificationToken(secret: string, token: string): VerificationTokenPayload | undefined {
  if (typeof token !== "string" || token.length > 8_192) return undefined;
  const [body, supplied, extra] = token.split(".");
  if (!body || !supplied || extra !== undefined) return undefined;
  let suppliedBytes: Buffer;
  let expectedBytes: Buffer;
  try {
    suppliedBytes = Buffer.from(supplied, "base64url");
    expectedBytes = createHmac("sha256", key(secret, "verification-token")).update(body).digest();
  } catch {
    return undefined;
  }
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as VerificationTokenPayload;
    if (
      parsed?.v !== 1
      || typeof parsed.accountId !== "string"
      || typeof parsed.region !== "string"
      || typeof parsed.identity !== "string"
      || typeof parsed.identityGeneration !== "string"
      || typeof parsed.intentId !== "string"
      || typeof parsed.messageId !== "string"
      || !Number.isSafeInteger(parsed.issuedAt)
      || !Number.isSafeInteger(parsed.expiresAt)
      || typeof parsed.nonce !== "string"
    ) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function validateSesPublicUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("SES public URL must be a valid HTTP(S) loopback origin");
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === "localhost"
    || hostname === "::1"
    || hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname) && hostname.split(".").slice(1).every(part => Number(part) >= 0 && Number(part) <= 255);
  if (!["http:", "https:"].includes(parsed.protocol) || !loopback || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("SES public URL must be an HTTP(S) loopback origin with no credentials, path, query, or fragment");
  }
  return parsed.origin;
}

export function verificationCallbackUrl(baseUrl: string, region: string, token: string): string {
  return `${baseUrl}/_stacksim/ses/verify-email/${encodeURIComponent(region)}?token=${encodeURIComponent(token)}`;
}
