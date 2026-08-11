import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface CredentialBinding {
  credentialId: string;
  type: "iam-user" | "sts-session";
  accountId: string;
  ownerId: string;
  accessKeyId: string;
}

export interface CredentialSecret {
  secretAccessKey: string;
  sessionToken?: string;
}

interface Envelope {
  version: 1;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export class IamCredentialStore {
  readonly keyFile: string;
  readonly recordsDirectory: string;
  private key?: Buffer;
  private readonly records = new Map<string, { binding: CredentialBinding; secret: CredentialSecret }>();

  constructor(dataRoot: string) {
    this.keyFile = resolve(dataRoot, "secrets", "iam.key");
    this.recordsDirectory = resolve(dataRoot, "data", "iam", "credentials");
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.keyFile), { recursive: true, mode: 0o700 });
    await mkdir(this.recordsDirectory, { recursive: true, mode: 0o700 });
    await chmod(dirname(this.keyFile), 0o700).catch(() => undefined);
    await chmod(this.recordsDirectory, 0o700).catch(() => undefined);
    try {
      const stat = await lstat(this.keyFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("IAM credential wrapping key is not a regular file");
      const existing = await readFile(this.keyFile);
      if (existing.length !== 32) throw new Error("IAM credential wrapping key is corrupt");
      this.key = Buffer.from(existing);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const generated = randomBytes(32);
      await writeFile(this.keyFile, generated, { flag: "wx", mode: 0o600 });
      this.key = Buffer.from(generated);
      generated.fill(0);
    }
    await chmod(this.keyFile, 0o600).catch(() => undefined);
    for (const name of await readdir(this.recordsDirectory)) {
      if (!name.endsWith(".json")) continue;
      const raw = JSON.parse(await readFile(resolve(this.recordsDirectory, name), "utf8"));
      const binding = raw.binding as CredentialBinding;
      const secret = this.decrypt(raw.envelope as Envelope, binding);
      if (`${binding.credentialId}.json` !== name || this.records.has(binding.credentialId)) throw new Error("IAM credential record index is corrupt");
      this.records.set(binding.credentialId, { binding, secret });
    }
  }

  private aad(binding: CredentialBinding): Buffer {
    return Buffer.from(JSON.stringify([1, binding.type, binding.accountId, binding.ownerId, binding.accessKeyId, binding.credentialId]));
  }

  private encrypt(secret: CredentialSecret, binding: CredentialBinding): Envelope {
    if (!this.key) throw new Error("IAM credential store has not started");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(this.aad(binding));
    const plaintext = Buffer.from(JSON.stringify(secret));
    try {
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { version: 1, nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
    } finally {
      plaintext.fill(0);
      nonce.fill(0);
    }
  }

  private decrypt(envelope: Envelope, binding: CredentialBinding): CredentialSecret {
    if (!this.key || envelope.version !== 1) throw new Error("IAM credential record is corrupt");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.nonce, "base64url"));
      decipher.setAAD(this.aad(binding));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
      try { return JSON.parse(plaintext.toString("utf8")); } finally { plaintext.fill(0); }
    } catch {
      throw new Error("IAM credential material could not be authenticated. Restore state.json, data/iam/credentials, and secrets/iam.key from the same stopped backup.");
    }
  }

  async put(binding: CredentialBinding, secret: CredentialSecret): Promise<void> {
    const target = resolve(this.recordsDirectory, `${binding.credentialId}.json`);
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const value = JSON.stringify({ binding, envelope: this.encrypt(secret, binding) });
    await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
    this.records.set(binding.credentialId, { binding: structuredClone(binding), secret: structuredClone(secret) });
  }

  get(credentialId: string, expected?: Partial<CredentialBinding>): CredentialSecret | undefined {
    const record = this.records.get(credentialId);
    if (!record) return undefined;
    if (expected && Object.entries(expected).some(([key, value]) => (record.binding as any)[key] !== value)) return undefined;
    return structuredClone(record.secret);
  }

  verify(credentialId: string, supplied: string): boolean {
    const expected = this.records.get(credentialId)?.secret.secretAccessKey;
    if (!expected) return false;
    const left = Buffer.from(expected); const right = Buffer.from(supplied);
    try { return left.length === right.length && timingSafeEqual(left, right); } finally { left.fill(0); right.fill(0); }
  }

  async delete(credentialId: string): Promise<void> {
    this.records.delete(credentialId);
    await unlink(resolve(this.recordsDirectory, `${credentialId}.json`)).catch((error: any) => { if (error?.code !== "ENOENT") throw error; });
  }

  async sweep(referencedCredentialIds: ReadonlySet<string>): Promise<void> {
    for (const credentialId of [...this.records.keys()]) {
      if (!referencedCredentialIds.has(credentialId)) await this.delete(credentialId);
    }
  }

  fingerprint(parts: readonly string[]): string {
    if (!this.key) throw new Error("IAM credential store has not started");
    return createHmac("sha256", this.key).update(JSON.stringify(parts)).digest("base64url");
  }

  ids(): string[] { return [...this.records.keys()]; }
}
