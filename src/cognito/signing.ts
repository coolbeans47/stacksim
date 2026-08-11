import {
  createHash,
  createPrivateKey,
  generateKeyPair,
  randomBytes,
  sign,
  type JsonWebKey,
} from "node:crypto";
import type {
  CognitoRecoverableSecretState,
  CognitoSigningKeyRingState,
  CognitoSigningKeyState,
  CognitoSigningKeysState,
} from "../types.js";
import { CognitoSecurityError, CognitoSecrets } from "./secrets.js";

const RSA_BITS = 2_048;

function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

function generateRsaKeyPair(): Promise<{
  publicKey: Parameters<Parameters<typeof generateKeyPair>[2]>[1];
  privateKey: Parameters<Parameters<typeof generateKeyPair>[2]>[2];
}> {
  return new Promise((resolve, reject) => {
    generateKeyPair("rsa", { modulusLength: RSA_BITS }, (error, publicKey, privateKey) => {
      if (error) reject(error);
      else resolve({ publicKey, privateKey });
    });
  });
}

function privateBinding(
  accountId: string,
  region: string,
  poolId: string,
  tokenUse: "id" | "access",
  kid: string,
  secret: Pick<CognitoRecoverableSecretState, "id" | "version">,
) {
  return {
    purpose: "SIGNING_PRIVATE_KEY" as const,
    accountId,
    region,
    poolId,
    ownerId: kid,
    secretId: secret.id,
    secretVersion: secret.version,
    field: `${tokenUse}-token-signing-private-key`,
  };
}

async function generateSigningKey(
  secrets: CognitoSecrets,
  accountId: string,
  region: string,
  poolId: string,
  tokenUse: "id" | "access",
  now: number,
): Promise<CognitoSigningKeyState> {
  const { publicKey, privateKey } = await generateRsaKeyPair();
  const kid = randomId();
  const secret = { id: randomId(), version: 1 as const };
  const exported = privateKey.export({ format: "der", type: "pkcs8" });
  const privateDer = Buffer.isBuffer(exported) ? exported : Buffer.from(exported);
  try {
    const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
    if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
      throw new CognitoSecurityError("Cognito RSA key generation returned an invalid public key.");
    }
    return {
      kid,
      tokenUse,
      createdAt: now,
      publicJwk: {
        kty: "RSA",
        alg: "RS256",
        use: "sig",
        kid,
        n: jwk.n,
        e: jwk.e,
      },
      privateKey: {
        ...secret,
        envelope: secrets.encrypt(
          privateDer,
          privateBinding(accountId, region, poolId, tokenUse, kid, secret),
        ),
      },
    };
  } finally {
    privateDer.fill(0);
  }
}

export async function generatePoolSigningKeys(
  secrets: CognitoSecrets,
  accountId: string,
  region: string,
  poolId: string,
  now: number,
): Promise<CognitoSigningKeysState> {
  const [idKey, accessKey] = await Promise.all([
    generateSigningKey(secrets, accountId, region, poolId, "id", now),
    generateSigningKey(secrets, accountId, region, poolId, "access", now),
  ]);
  if (idKey.kid === accessKey.kid) throw new CognitoSecurityError("Cognito signing key identifiers collided.");
  return {
    id: { activeKid: idKey.kid, keys: { [idKey.kid]: idKey } },
    access: { activeKid: accessKey.kid, keys: { [accessKey.kid]: accessKey } },
  };
}

function activeKey(
  signingKeys: CognitoSigningKeysState,
  tokenUse: "id" | "access",
): CognitoSigningKeyState {
  const ring: CognitoSigningKeyRingState = signingKeys[tokenUse];
  const key = ring.keys[ring.activeKid];
  if (
    !key
    || key.kid !== ring.activeKid
    || key.tokenUse !== tokenUse
    || key.publicJwk.kid !== key.kid
    || key.publicJwk.kty !== "RSA"
    || key.publicJwk.alg !== "RS256"
    || key.publicJwk.use !== "sig"
  ) {
    throw new CognitoSecurityError("Cognito signing key state is invalid.");
  }
  return key;
}

function encodeJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function signCognitoJwt(
  secrets: CognitoSecrets,
  accountId: string,
  region: string,
  poolId: string,
  signingKeys: CognitoSigningKeysState,
  tokenUse: "id" | "access",
  claims: Record<string, unknown>,
): string {
  const key = activeKey(signingKeys, tokenUse);
  const privateDer = secrets.decrypt(
    key.privateKey.envelope,
    privateBinding(accountId, region, poolId, tokenUse, key.kid, key.privateKey),
  );
  try {
    const header = encodeJson({ alg: "RS256", kid: key.kid, typ: "JWT" });
    const payload = encodeJson(claims);
    const signingInput = `${header}.${payload}`;
    const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
    const signature = sign("RSA-SHA256", Buffer.from(signingInput, "ascii"), privateKey);
    try {
      return `${signingInput}.${signature.toString("base64url")}`;
    } finally {
      signature.fill(0);
    }
  } catch (error) {
    if (error instanceof CognitoSecurityError) throw error;
    throw new CognitoSecurityError("Cognito signing private key could not be loaded.");
  } finally {
    privateDer.fill(0);
  }
}

export function signingPublicKeys(signingKeys: CognitoSigningKeysState): Array<Record<string, string>> {
  const keys = [
    ...Object.values(signingKeys.id.keys),
    ...Object.values(signingKeys.access.keys),
  ].sort((left, right) => left.kid.localeCompare(right.kid));
  const seen = new Set<string>();
  return keys.map(key => {
    if (seen.has(key.kid)) throw new CognitoSecurityError("Cognito signing key identifiers are not unique.");
    seen.add(key.kid);
    if (
      key.publicJwk.kty !== "RSA"
      || key.publicJwk.alg !== "RS256"
      || key.publicJwk.use !== "sig"
      || key.publicJwk.kid !== key.kid
      || typeof key.publicJwk.n !== "string"
      || typeof key.publicJwk.e !== "string"
    ) {
      throw new CognitoSecurityError("Cognito public signing key state is invalid.");
    }
    return { ...key.publicJwk };
  });
}

export function signingKeysEtag(signingKeys: CognitoSigningKeysState): string {
  return `"${createHash("sha256").update(JSON.stringify(signingPublicKeys(signingKeys))).digest("base64url")}"`;
}
