import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
} from "node:crypto";

export const MAX_JWT_BYTES = 32_768;

export class JwtValidationError extends Error {
  constructor() {
    super("The JWT is invalid");
    this.name = "JwtValidationError";
  }
}

export interface ParsedJwt {
  token: string;
  encodedHeader: string;
  encodedClaims: string;
  encodedSignature: string;
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodeSegment(value: string, maximumBytes: number): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new JwtValidationError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length > maximumBytes || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw new JwtValidationError();
  }
  return decoded;
}

function assertJsonHasUniqueObjectKeys(source: string): void {
  let offset = 0;
  const fail = (): never => { throw new JwtValidationError(); };
  const whitespace = (): void => {
    while (offset < source.length && /[\t\n\r ]/.test(source[offset])) offset += 1;
  };
  const string = (): string => {
    if (source[offset] !== "\"") fail();
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      const character = source[offset];
      if (character === "\"") {
        offset += 1;
        try {
          return JSON.parse(source.slice(start, offset));
        } catch {
          return fail();
        }
      }
      if (character === "\\") {
        offset += 1;
        if (offset >= source.length) fail();
        if (source[offset] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(offset + 1, offset + 5))) fail();
          offset += 5;
          continue;
        }
        if (!/[\"\\/bfnrt]/.test(source[offset])) fail();
        offset += 1;
        continue;
      }
      if (character < " " || character === "\u007f") fail();
      offset += 1;
    }
    return fail();
  };
  const value = (): void => {
    whitespace();
    if (source[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        const key = string();
        if (keys.has(key)) fail();
        keys.add(key);
        whitespace();
        if (source[offset] !== ":") fail();
        offset += 1;
        value();
        whitespace();
        if (source[offset] === "}") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") fail();
        offset += 1;
        whitespace();
      }
      fail();
    }
    if (source[offset] === "[") {
      offset += 1;
      whitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        value();
        whitespace();
        if (source[offset] === "]") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") fail();
        offset += 1;
      }
      fail();
    }
    if (source[offset] === "\"") {
      string();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(offset)) ?? fail();
    offset += number[0].length;
  };
  value();
  whitespace();
  if (offset !== source.length) fail();
}

function jsonSegment(value: string): Record<string, unknown> {
  const decoded = decodeSegment(value, MAX_JWT_BYTES);
  try {
    const source = decoded.toString("utf8");
    assertJsonHasUniqueObjectKeys(source);
    const parsed = JSON.parse(source);
    if (!plainObject(parsed)) throw new JwtValidationError();
    return parsed;
  } catch (error) {
    if (error instanceof JwtValidationError) throw error;
    throw new JwtValidationError();
  } finally {
    decoded.fill(0);
  }
}

export function parseJwt(token: unknown): ParsedJwt {
  if (
    typeof token !== "string"
    || Buffer.byteLength(token, "ascii") > MAX_JWT_BYTES
  ) {
    throw new JwtValidationError();
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtValidationError();
  return {
    token,
    encodedHeader: parts[0],
    encodedClaims: parts[1],
    encodedSignature: parts[2],
    header: jsonSegment(parts[0]),
    claims: jsonSegment(parts[1]),
  };
}

const VERIFY_ALGORITHMS: Record<string, {
  algorithm: string;
  kty: string;
  dsaEncoding?: "ieee-p1363";
}> = {
  RS256: { algorithm: "RSA-SHA256", kty: "RSA" },
  RS384: { algorithm: "RSA-SHA384", kty: "RSA" },
  RS512: { algorithm: "RSA-SHA512", kty: "RSA" },
  ES256: { algorithm: "SHA256", kty: "EC", dsaEncoding: "ieee-p1363" },
  ES384: { algorithm: "SHA384", kty: "EC", dsaEncoding: "ieee-p1363" },
  ES512: { algorithm: "SHA512", kty: "EC", dsaEncoding: "ieee-p1363" },
};

export function verifyParsedJwt(
  parsed: ParsedJwt,
  keys: readonly JsonWebKey[],
  allowedAlgorithms: ReadonlySet<string>,
): JsonWebKey {
  const algorithmName = parsed.header.alg;
  const kid = parsed.header.kid;
  if (
    typeof algorithmName !== "string"
    || !allowedAlgorithms.has(algorithmName)
    || typeof kid !== "string"
    || kid.length < 1
    || kid.length > 256
  ) {
    throw new JwtValidationError();
  }
  const algorithm = VERIFY_ALGORITHMS[algorithmName];
  if (!algorithm) throw new JwtValidationError();
  const key = keys.find(candidate => candidate.kid === kid);
  if (
    !key
    || key.kty !== algorithm.kty
    || key.alg !== undefined && key.alg !== algorithmName
    || key.use !== undefined && key.use !== "sig"
  ) {
    throw new JwtValidationError();
  }
  const signature = decodeSegment(parsed.encodedSignature, 512);
  try {
    const publicKey = createPublicKey({ key, format: "jwk" });
    const valid = verifySignature(
      algorithm.algorithm,
      Buffer.from(`${parsed.encodedHeader}.${parsed.encodedClaims}`, "ascii"),
      {
        key: publicKey,
        ...(algorithm.dsaEncoding ? { dsaEncoding: algorithm.dsaEncoding } : {}),
      },
      signature,
    );
    if (!valid) throw new JwtValidationError();
    return key;
  } catch (error) {
    if (error instanceof JwtValidationError) throw error;
    throw new JwtValidationError();
  } finally {
    signature.fill(0);
  }
}
