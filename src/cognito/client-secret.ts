import { createHmac, timingSafeEqual } from "node:crypto";

function decodeSecretHash(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    decoded.fill(0);
    return undefined;
  }
  return decoded;
}

export function clientSecretHash(
  secret: Uint8Array,
  username: string,
  clientId: string,
): string {
  return createHmac("sha256", secret).update(username, "utf8").update(clientId, "utf8").digest("base64");
}

export function verifyClientSecretHash(
  secret: Uint8Array,
  username: string,
  clientId: string,
  supplied: unknown,
): boolean {
  const actual = decodeSecretHash(supplied);
  if (!actual) return false;
  const expected = createHmac("sha256", secret).update(username, "utf8").update(clientId, "utf8").digest();
  try {
    return timingSafeEqual(expected, actual);
  } finally {
    expected.fill(0);
    actual.fill(0);
  }
}
