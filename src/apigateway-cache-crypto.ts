import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ApiGatewayCachedResponseState, ApiGatewayResponseCacheEnvelopeState } from "./types.js";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KEY_COUNT = 64;

interface KeyringFile {
  version: 1;
  currentKeyId: string;
  keys: Record<string, string>;
}

export interface ApiGatewayCacheBinding {
  accountId: string;
  region: string;
  apiId: string;
  stageName: string;
  cacheKey: string;
  deploymentId: string;
  method: string;
  namespace: string;
}

export class ApiGatewayCacheSecurityError extends Error {
  constructor(message = "API Gateway encrypted cache material could not be authenticated.") {
    super(message);
    this.name = "ApiGatewayCacheSecurityError";
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function canonicalFields(fields: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    if (typeof field !== "string" || Buffer.byteLength(field, "utf8") > 4_096) throw new ApiGatewayCacheSecurityError();
    const value = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    chunks.push(length, value);
  }
  return Buffer.concat(chunks);
}

function associatedData(binding: ApiGatewayCacheBinding): Buffer {
  return canonicalFields([
    "stacksim-apigateway-response-cache",
    "1",
    binding.accountId,
    binding.region,
    binding.apiId,
    binding.stageName,
    binding.cacheKey,
    binding.deploymentId,
    binding.method,
    binding.namespace,
  ]);
}

function decode(value: unknown, expectedLength?: number, allowEmpty = false): Buffer {
  if (typeof value !== "string" || value.length > 4_000_000 || (!allowEmpty && value.length === 0) || value.length > 0 && !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApiGatewayCacheSecurityError();
  }
  const result = Buffer.from(value, "base64url");
  if (result.toString("base64url") !== value || expectedLength !== undefined && result.length !== expectedLength) {
    result.fill(0);
    throw new ApiGatewayCacheSecurityError();
  }
  return result;
}

function validateResponse(value: unknown): ApiGatewayCachedResponseState {
  const response = value as ApiGatewayCachedResponseState;
  if (!response || typeof response !== "object" || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 || typeof response.body !== "string" || response.body.length > 1_500_000 || !response.headers || typeof response.headers !== "object" || Array.isArray(response.headers) || Object.entries(response.headers).some(([name, header]) => !name || typeof header !== "string")) {
    throw new ApiGatewayCacheSecurityError("API Gateway encrypted cache response is invalid.");
  }
  return response;
}

/** Installation-private keyring. It is deliberately not exposed as an API Gateway action. */
export class ApiGatewayCacheCrypto {
  readonly keyringFile: string;
  private keyring?: { currentKeyId: string; keys: Map<string, Buffer> };
  private unavailable?: string;
  private starting?: Promise<void>;

  constructor(dataRoot: string) {
    this.keyringFile = resolve(dataRoot, "secrets", "apigateway-cache.keys.json");
  }

  start(hasEncryptedEntries: boolean): Promise<void> {
    return this.starting ??= this.initialize(hasEncryptedEntries);
  }

  private async initialize(hasEncryptedEntries: boolean): Promise<void> {
    try {
      await mkdir(dirname(this.keyringFile), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.keyringFile), 0o700).catch(() => undefined);
      const existing = await this.readExisting();
      if (existing) {
        this.keyring = existing;
        return;
      }
      if (hasEncryptedEntries) {
        this.unavailable = "API Gateway cache keyring is missing. Restore secrets/apigateway-cache.keys.json from the matching stopped backup; affected entries will be evicted without use.";
        return;
      }
      const keyId = randomBytes(16).toString("hex");
      const key = randomBytes(KEY_BYTES);
      await this.writeKeyring({ currentKeyId: keyId, keys: new Map([[keyId, key]]) }, true);
      this.keyring ??= { currentKeyId: keyId, keys: new Map([[keyId, Buffer.from(key)]]) };
      key.fill(0);
    } catch {
      this.unavailable = "API Gateway cache keyring is unavailable or corrupt. Restore secrets/apigateway-cache.keys.json from the matching stopped backup; affected entries will be evicted without use.";
    }
  }

  private async readExisting(): Promise<{ currentKeyId: string; keys: Map<string, Buffer> } | undefined> {
    let info;
    try {
      info = await lstat(this.keyringFile);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new ApiGatewayCacheSecurityError();
    const parsed = JSON.parse(await readFile(this.keyringFile, "utf8")) as KeyringFile;
    if (parsed?.version !== 1 || !/^[a-f0-9]{32}$/.test(parsed.currentKeyId) || !parsed.keys || typeof parsed.keys !== "object" || Array.isArray(parsed.keys)) throw new ApiGatewayCacheSecurityError();
    const entries = Object.entries(parsed.keys);
    if (entries.length < 1 || entries.length > MAX_KEY_COUNT || !Object.hasOwn(parsed.keys, parsed.currentKeyId)) throw new ApiGatewayCacheSecurityError();
    const keys = new Map<string, Buffer>();
    try {
      for (const [keyId, encoded] of entries) {
        if (!/^[a-f0-9]{32}$/.test(keyId)) throw new ApiGatewayCacheSecurityError();
        keys.set(keyId, decode(encoded, KEY_BYTES));
      }
      await chmod(this.keyringFile, 0o600).catch(() => undefined);
      return { currentKeyId: parsed.currentKeyId, keys };
    } catch (error) {
      for (const key of keys.values()) key.fill(0);
      throw error;
    }
  }

  private async writeKeyring(keyring: { currentKeyId: string; keys: Map<string, Buffer> }, create: boolean): Promise<void> {
    const value: KeyringFile = { version: 1, currentKeyId: keyring.currentKeyId, keys: Object.fromEntries([...keyring.keys].map(([id, key]) => [id, key.toString("base64url")])) };
    const temporary = `${this.keyringFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      await chmod(temporary, 0o600).catch(() => undefined);
      if (create) {
        try {
          await link(temporary, this.keyringFile);
          return;
        } catch (error) {
          if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(errorCode(error) ?? "")) {
            try {
              const handle = await open(this.keyringFile, "wx", 0o600);
              try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
              return;
            } catch (fallbackError) {
              if (errorCode(fallbackError) !== "EEXIST") throw fallbackError;
            }
          } else if (errorCode(error) !== "EEXIST") throw error;
          const existing = await this.readExisting();
          if (!existing) throw new ApiGatewayCacheSecurityError();
          this.keyring = existing;
          return;
        }
      }
      await rename(temporary, this.keyringFile);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private available(): { currentKeyId: string; keys: Map<string, Buffer> } {
    if (!this.keyring) throw new ApiGatewayCacheSecurityError(this.unavailable ?? "API Gateway cache keyring has not been initialized.");
    return this.keyring;
  }

  encrypt(response: ApiGatewayCachedResponseState, binding: ApiGatewayCacheBinding): ApiGatewayResponseCacheEnvelopeState {
    const keyring = this.available();
    const key = keyring.keys.get(keyring.currentKeyId);
    if (!key) throw new ApiGatewayCacheSecurityError();
    const plaintext = Buffer.from(JSON.stringify(validateResponse(response)), "utf8");
    const nonce = randomBytes(NONCE_BYTES);
    const aad = associatedData(binding);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      try {
        return { version: 1, algorithm: "AES-256-GCM", keyId: keyring.currentKeyId, nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), authTag: authTag.toString("base64url") };
      } finally {
        ciphertext.fill(0);
        authTag.fill(0);
      }
    } finally {
      plaintext.fill(0);
      nonce.fill(0);
      aad.fill(0);
    }
  }

  decrypt(envelope: ApiGatewayResponseCacheEnvelopeState, binding: ApiGatewayCacheBinding): { response: ApiGatewayCachedResponseState; needsRotation: boolean } {
    const keyring = this.available();
    if (!envelope || envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM" || !/^[a-f0-9]{32}$/.test(envelope.keyId)) throw new ApiGatewayCacheSecurityError();
    const key = keyring.keys.get(envelope.keyId);
    if (!key) throw new ApiGatewayCacheSecurityError(`API Gateway cache envelope references unavailable key ${envelope.keyId}.`);
    const nonce = decode(envelope.nonce, NONCE_BYTES);
    const ciphertext = decode(envelope.ciphertext, undefined, true);
    const authTag = decode(envelope.authTag, TAG_BYTES);
    const aad = associatedData(binding);
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return { response: validateResponse(JSON.parse(plaintext.toString("utf8"))), needsRotation: envelope.keyId !== keyring.currentKeyId };
    } catch {
      throw new ApiGatewayCacheSecurityError();
    } finally {
      nonce.fill(0);
      ciphertext.fill(0);
      authTag.fill(0);
      aad.fill(0);
      plaintext?.fill(0);
    }
  }

  async rotate(): Promise<string> {
    const current = this.available();
    if (current.keys.size >= MAX_KEY_COUNT) throw new ApiGatewayCacheSecurityError("API Gateway cache keyring must be compacted before another rotation.");
    const keyId = randomBytes(16).toString("hex");
    const key = randomBytes(KEY_BYTES);
    const next = { currentKeyId: keyId, keys: new Map(current.keys).set(keyId, key) };
    try {
      await this.writeKeyring(next, false);
      const replacement = { currentKeyId: keyId, keys: new Map([...next.keys].map(([id, value]) => [id, Buffer.from(value)])) };
      const previous = this.keyring;
      this.keyring = replacement;
      for (const value of previous?.keys.values() ?? []) value.fill(0);
      return keyId;
    } finally {
      key.fill(0);
    }
  }
}
