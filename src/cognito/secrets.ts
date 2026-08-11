import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  CognitoRecoverableSecretState,
  CognitoSecretEnvelope,
  CognitoSecretPurpose,
} from "../types.js";

const ROOT_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ENVELOPE_VERSION = 1;
const KEY_VERSION = 1;
// Persisted cryptographic domain.
const HKDF_SALT = Buffer.from("stacksim:cognito:hkdf:v1", "utf8");

export interface CognitoSecretBinding {
  purpose: CognitoSecretPurpose;
  accountId: string;
  region: string;
  poolId: string;
  ownerId: string;
  secretId: string;
  secretVersion: number;
  field: string;
}

export interface CognitoConfirmationCodeBinding {
  accountId: string;
  region: string;
  poolId: string;
  clientId: string;
  userSub: string;
  userGenerationId: string;
  intentId: string;
  purpose:
    | "SIGN_UP"
    | "RESEND_SIGN_UP"
    | "PASSWORD_RESET"
    | "ATTRIBUTE_VERIFICATION"
    | "ADMIN_INVITATION"
    | "EMAIL_MFA";
  issuedAt: number;
  expiresAt: number;
}

export interface CognitoRefreshTokenBinding {
  accountId: string;
  region: string;
  poolId: string;
  clientId: string;
}

export class CognitoSecurityError extends Error {
  constructor(message = "Cognito encrypted material could not be authenticated. Restore the matching secrets/cognito.key file and state backup.") {
    super(message);
    this.name = "CognitoSecurityError";
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
    const value = Buffer.from(field, "utf8");
    if (value.length > 0xffff_ffff) throw new CognitoSecurityError();
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    chunks.push(length, value);
  }
  return Buffer.concat(chunks);
}

function associatedData(binding: CognitoSecretBinding): Buffer {
  if (
    !Number.isSafeInteger(binding.secretVersion)
    || binding.secretVersion < 1
    || [binding.accountId, binding.region, binding.poolId, binding.ownerId, binding.secretId, binding.field]
      .some(value => typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > 4_096)
  ) {
    throw new CognitoSecurityError();
  }
  return canonicalFields([
    String(ENVELOPE_VERSION),
    String(KEY_VERSION),
    binding.purpose,
    binding.accountId,
    binding.region,
    binding.poolId,
    binding.ownerId,
    binding.secretId,
    String(binding.secretVersion),
    binding.field,
  ]);
}

function decodeBase64Url(value: unknown, expectedBytes?: number, allowEmpty = false): Buffer {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.length > 1_000_000
    || value.length > 0 && !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new CognitoSecurityError();
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || expectedBytes !== undefined && decoded.length !== expectedBytes) {
    decoded.fill(0);
    throw new CognitoSecurityError();
  }
  return decoded;
}

function assertEnvelope(envelope: CognitoSecretEnvelope, purpose: CognitoSecretPurpose): void {
  if (
    !envelope
    || typeof envelope !== "object"
    || envelope.version !== ENVELOPE_VERSION
    || envelope.keyVersion !== KEY_VERSION
    || envelope.purpose !== purpose
  ) {
    throw new CognitoSecurityError();
  }
}

export class CognitoSecrets {
  readonly keyFile: string;
  private rootKey?: Buffer;
  private unavailable?: string;
  private starting?: Promise<void>;

  constructor(dataRoot: string) {
    this.keyFile = resolve(dataRoot, "secrets", "cognito.key");
  }

  start(hasEncryptedMaterial: boolean): Promise<void> {
    return this.starting ??= this.initialize(hasEncryptedMaterial);
  }

  private async initialize(hasEncryptedMaterial: boolean): Promise<void> {
    try {
      await mkdir(dirname(this.keyFile), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.keyFile), 0o700).catch(() => undefined);
      const existing = await this.readExisting();
      if (existing) {
        this.rootKey = existing;
        return;
      }
      if (hasEncryptedMaterial) {
        this.unavailable = "Cognito wrapping key is missing. Restore secrets/cognito.key from the matching data backup; encrypted Cognito state was not modified.";
        return;
      }
      this.rootKey = await this.createRoot();
    } catch {
      this.unavailable = "Cognito wrapping key is unavailable or corrupt. Restore secrets/cognito.key from the matching data backup; encrypted Cognito state was not modified.";
    }
  }

  private async readExisting(): Promise<Buffer | undefined> {
    let stat;
    try {
      stat = await lstat(this.keyFile);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CognitoSecurityError();
    const value = await readFile(this.keyFile);
    if (value.length !== ROOT_BYTES) {
      value.fill(0);
      throw new CognitoSecurityError();
    }
    await chmod(this.keyFile, 0o600).catch(() => undefined);
    return Buffer.from(value);
  }

  private async createRoot(): Promise<Buffer> {
    const generated = randomBytes(ROOT_BYTES);
    const temporary = `${this.keyFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let created = false;
    try {
      await writeFile(temporary, generated, { flag: "wx", mode: 0o600 });
      await chmod(temporary, 0o600).catch(() => undefined);
      try {
        await link(temporary, this.keyFile);
        created = true;
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          // Another simulator process won the atomic installation-key claim.
        } else if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(errorCode(error) ?? "")) {
          try {
            const handle = await open(this.keyFile, "wx", 0o600);
            try {
              await handle.writeFile(generated);
              await handle.sync();
              created = true;
            } finally {
              await handle.close();
            }
          } catch (fallbackError) {
            if (errorCode(fallbackError) !== "EEXIST") throw fallbackError;
          }
        } else {
          throw error;
        }
      }
      if (created) {
        await chmod(this.keyFile, 0o600).catch(() => undefined);
        return Buffer.from(generated);
      }
      const existing = await this.readExisting();
      if (!existing) throw new CognitoSecurityError();
      return existing;
    } finally {
      generated.fill(0);
      await unlink(temporary).catch(() => undefined);
    }
  }

  assertAvailable(): void {
    if (!this.rootKey) {
      throw new CognitoSecurityError(
        this.unavailable
        ?? "Cognito wrapping key has not been initialized. Start the simulator before using Cognito.",
      );
    }
  }

  private derivedKey(purpose: CognitoSecretPurpose): Buffer {
    this.assertAvailable();
    return Buffer.from(hkdfSync(
      "sha256",
      this.rootKey!,
      HKDF_SALT,
      Buffer.from(`stacksim:cognito:encryption:v1:${purpose}`, "utf8"),
      KEY_BYTES,
    ));
  }

  private purposeKey(
    label:
      | "delivery-code"
      | "verification-digest"
      | "refresh-digest"
      | "rendered-content-mac"
      | "rate-limit-key"
      | "oauth-code-digest"
      | "oauth-session-digest"
      | "oauth-csrf-digest"
      | "federation-state-digest"
      | "federation-nonce-digest"
      | "federation-replay-digest",
  ): Buffer {
    this.assertAvailable();
    return Buffer.from(hkdfSync(
      "sha256",
      this.rootKey!,
      HKDF_SALT,
      Buffer.from(`stacksim:cognito:${label}:v1`, "utf8"),
      KEY_BYTES,
    ));
  }

  private confirmationData(binding: CognitoConfirmationCodeBinding): Buffer {
    if (
      !Number.isSafeInteger(binding.issuedAt)
      || !Number.isSafeInteger(binding.expiresAt)
      || binding.issuedAt < 0
      || binding.expiresAt <= binding.issuedAt
    ) {
      throw new CognitoSecurityError();
    }
    return canonicalFields([
      "1",
      binding.accountId,
      binding.region,
      binding.poolId,
      binding.clientId,
      binding.userSub,
      binding.userGenerationId,
      binding.intentId,
      binding.purpose,
      String(binding.issuedAt),
      String(binding.expiresAt),
    ]);
  }

  confirmationCode(binding: CognitoConfirmationCodeBinding): string {
    const key = this.purposeKey("delivery-code");
    const data = this.confirmationData(binding);
    const unbiasedLimit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
    try {
      for (let counter = 0; counter < 1_024; counter += 1) {
        const counterBytes = Buffer.allocUnsafe(4);
        counterBytes.writeUInt32BE(counter);
        const digest = createHmac("sha256", key).update(data).update(counterBytes).digest();
        counterBytes.fill(0);
        try {
          for (let offset = 0; offset <= digest.length - 4; offset += 4) {
            const candidate = digest.readUInt32BE(offset);
            if (candidate < unbiasedLimit) return String(candidate % 1_000_000).padStart(6, "0");
          }
        } finally {
          digest.fill(0);
        }
      }
      throw new CognitoSecurityError("Cognito confirmation code derivation failed.");
    } finally {
      key.fill(0);
      data.fill(0);
    }
  }

  confirmationCodeDigest(code: string, binding: CognitoConfirmationCodeBinding): string {
    if (!/^\d{6}$/.test(code)) throw new CognitoSecurityError();
    const key = this.purposeKey("verification-digest");
    const data = this.confirmationData(binding);
    try {
      return createHmac("sha256", key).update(data).update(code, "ascii").digest("base64url");
    } finally {
      key.fill(0);
      data.fill(0);
    }
  }

  verifyConfirmationCode(
    supplied: unknown,
    expectedDigest: string,
    binding: CognitoConfirmationCodeBinding,
  ): boolean {
    if (typeof supplied !== "string" || !/^\d{6}$/.test(supplied)) return false;
    const actual = Buffer.from(this.confirmationCodeDigest(supplied, binding), "base64url");
    const expected = decodeBase64Url(expectedDigest, 32);
    try {
      return timingSafeEqual(actual, expected);
    } finally {
      actual.fill(0);
      expected.fill(0);
    }
  }

  renderedContentMac(content: Uint8Array, binding: CognitoConfirmationCodeBinding): string {
    const key = this.purposeKey("rendered-content-mac");
    const data = this.confirmationData(binding);
    try {
      return createHmac("sha256", key).update(data).update(content).digest("base64url");
    } finally {
      key.fill(0);
      data.fill(0);
    }
  }

  verifyRenderedContentMac(
    content: Uint8Array,
    expectedMac: string,
    binding: CognitoConfirmationCodeBinding,
  ): boolean {
    const actual = Buffer.from(this.renderedContentMac(content, binding), "base64url");
    const expected = decodeBase64Url(expectedMac, 32);
    try {
      return timingSafeEqual(actual, expected);
    } finally {
      actual.fill(0);
      expected.fill(0);
    }
  }

  refreshTokenDigest(token: unknown, binding: CognitoRefreshTokenBinding): string {
    if (
      typeof token !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(token)
      || [binding.accountId, binding.region, binding.poolId, binding.clientId]
        .some(value => typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > 4_096)
    ) {
      throw new CognitoSecurityError("Cognito refresh-token proof is invalid.");
    }
    const tokenBytes = decodeBase64Url(token, 32);
    const key = this.purposeKey("refresh-digest");
    const data = canonicalFields([
      "1",
      binding.accountId,
      binding.region,
      binding.poolId,
      binding.clientId,
    ]);
    try {
      return createHmac("sha256", key).update(data).update(tokenBytes).digest("base64url");
    } finally {
      tokenBytes.fill(0);
      key.fill(0);
      data.fill(0);
    }
  }

  verifyRefreshToken(
    token: unknown,
    expectedDigest: string,
    binding: CognitoRefreshTokenBinding,
  ): boolean {
    let actual: Buffer | undefined;
    let expected: Buffer | undefined;
    try {
      actual = Buffer.from(this.refreshTokenDigest(token, binding), "base64url");
      expected = decodeBase64Url(expectedDigest, 32);
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    } finally {
      actual?.fill(0);
      expected?.fill(0);
    }
  }

  admissionKey(
    kind: "SIGN_UP" | "PASSWORD" | "REFRESH",
    binding: CognitoRefreshTokenBinding,
    value: string,
  ): string {
    if (
      typeof value !== "string"
      || value.length < 1
      || Buffer.byteLength(value, "utf8") > 4_096
      || [binding.accountId, binding.region, binding.poolId, binding.clientId]
        .some(field => typeof field !== "string" || field.length < 1 || Buffer.byteLength(field, "utf8") > 4_096)
    ) {
      throw new CognitoSecurityError("Cognito admission key input is invalid.");
    }
    const key = this.purposeKey("rate-limit-key");
    const data = canonicalFields([
      "1",
      kind,
      binding.accountId,
      binding.region,
      binding.poolId,
      binding.clientId,
      value,
    ]);
    try {
      return createHmac("sha256", key).update(data).digest("base64url");
    } finally {
      key.fill(0);
      data.fill(0);
    }
  }

  oauthDigest(
    kind: "code" | "session" | "csrf",
    value: unknown,
    binding: {
      accountId: string;
      region: string;
      poolId: string;
    },
  ): string {
    if (
      typeof value !== "string"
      || value.length < 20
      || Buffer.byteLength(value, "utf8") > 4_096
      || [binding.accountId, binding.region, binding.poolId]
        .some(field => typeof field !== "string" || field.length < 1 || Buffer.byteLength(field, "utf8") > 4_096)
    ) {
      throw new CognitoSecurityError("Cognito OAuth proof is invalid.");
    }
    const key = this.purposeKey(
      kind === "code"
        ? "oauth-code-digest"
        : kind === "session"
          ? "oauth-session-digest"
          : "oauth-csrf-digest",
    );
    const data = canonicalFields([
      "1",
      kind,
      binding.accountId,
      binding.region,
      binding.poolId,
    ]);
    try {
      return createHmac("sha256", key).update(data).update(value, "utf8").digest("base64url");
    } finally {
      key.fill(0);
      data.fill(0);
    }
  }

  federationDigest(
    kind: "state" | "nonce" | "replay",
    value: unknown,
    binding: { accountId: string; region: string; poolId: string; providerName: string },
  ): string {
    if (
      typeof value !== "string"
      || value.length < 1
      || Buffer.byteLength(value, "utf8") > 4_096
      || [binding.accountId, binding.region, binding.poolId, binding.providerName]
        .some(field => typeof field !== "string" || field.length < 1 || Buffer.byteLength(field, "utf8") > 256)
    ) {
      throw new CognitoSecurityError("Cognito federation proof is invalid.");
    }
    const key = this.purposeKey(
      kind === "state"
        ? "federation-state-digest"
        : kind === "nonce"
          ? "federation-nonce-digest"
          : "federation-replay-digest",
    );
    const data = canonicalFields([
      "1",
      kind,
      binding.accountId,
      binding.region,
      binding.poolId,
      binding.providerName,
    ]);
    try {
      return createHmac("sha256", key).update(data).update(value, "utf8").digest("base64url");
    } finally {
      key.fill(0);
      data.fill(0);
    }
  }

  encrypt(plaintext: Uint8Array, binding: CognitoSecretBinding): CognitoSecretEnvelope {
    this.assertAvailable();
    if (binding.purpose.length === 0 || plaintext.byteLength < 1 || plaintext.byteLength > 1_000_000) {
      throw new CognitoSecurityError();
    }
    const nonce = randomBytes(NONCE_BYTES);
    const key = this.derivedKey(binding.purpose);
    const aad = associatedData(binding);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      try {
        return {
          version: ENVELOPE_VERSION,
          keyVersion: KEY_VERSION,
          purpose: binding.purpose,
          nonce: nonce.toString("base64url"),
          ciphertext: ciphertext.toString("base64url"),
          authTag: authTag.toString("base64url"),
        };
      } finally {
        ciphertext.fill(0);
        authTag.fill(0);
      }
    } finally {
      nonce.fill(0);
      key.fill(0);
      aad.fill(0);
    }
  }

  decrypt(envelope: CognitoSecretEnvelope, binding: CognitoSecretBinding): Buffer {
    this.assertAvailable();
    assertEnvelope(envelope, binding.purpose);
    const nonce = decodeBase64Url(envelope.nonce, NONCE_BYTES);
    const ciphertext = decodeBase64Url(envelope.ciphertext, undefined, true);
    const authTag = decodeBase64Url(envelope.authTag, TAG_BYTES);
    const key = this.derivedKey(binding.purpose);
    const aad = associatedData(binding);
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext;
    } catch {
      plaintext?.fill(0);
      throw new CognitoSecurityError();
    } finally {
      nonce.fill(0);
      ciphertext.fill(0);
      authTag.fill(0);
      key.fill(0);
      aad.fill(0);
    }
  }

  decryptAppClientSecret(
    accountId: string,
    region: string,
    poolId: string,
    clientId: string,
    secret: CognitoRecoverableSecretState,
  ): Buffer {
    return this.decrypt(secret.envelope, {
      purpose: "APP_CLIENT_SECRET",
      accountId,
      region,
      poolId,
      ownerId: clientId,
      secretId: secret.id,
      secretVersion: secret.version,
      field: "client-secret",
    });
  }

  verifyAppClientSecret(
    accountId: string,
    region: string,
    poolId: string,
    clientId: string,
    secret: CognitoRecoverableSecretState,
    supplied: unknown,
  ): boolean {
    if (typeof supplied !== "string" || Buffer.byteLength(supplied, "utf8") > 256) return false;
    const expected = this.decryptAppClientSecret(accountId, region, poolId, clientId, secret);
    const actual = Buffer.from(supplied, "utf8");
    try {
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } finally {
      expected.fill(0);
      actual.fill(0);
    }
  }
}
