import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_VERSION = 1;

export interface MaterialBinding {
  service: "ssm" | "secretsmanager" | "appsync";
  accountId: string;
  region: string;
  resourceArn: string;
  generationId: string;
  valueKind: "SecureString" | "SecretString" | "SecretBinary" | "ApiKey";
  version: number | string;
}

interface Envelope {
  version: 1;
  keyVersion: 1;
  materialId: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

function associatedData(binding: MaterialBinding, materialId: string): Buffer {
  const fields = [
    // Persisted envelope domain.
    "stacksim-configuration-secret",
    String(ENVELOPE_VERSION),
    "1",
    binding.service,
    binding.accountId,
    binding.region,
    binding.resourceArn,
    binding.generationId,
    binding.valueKind,
    String(binding.version),
    materialId,
  ];
  const chunks = fields.map(value => {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  });
  return Buffer.concat(chunks);
}

/**
 * Immutable authenticated material storage shared only at the file-mechanics
 * layer. Control state retains opaque material IDs, never envelopes or keys.
 */
export class EncryptedMaterialStore {
  readonly keyPath: string;
  readonly materialRoot: string;
  readonly intentRoot: string;
  private rootKey?: Buffer;
  private started?: Promise<void>;
  private readonly readPins = new Map<string, number>();
  private readonly pendingRemovals = new Set<string>();

  constructor(private readonly dataRoot: string, private readonly service: "ssm" | "secretsmanager" | "appsync") {
    const secretsRoot = resolve(dataRoot, "secrets");
    this.keyPath = resolve(secretsRoot, `${service}.key`);
    this.materialRoot = resolve(secretsRoot, `${service}-materials`);
    this.intentRoot = resolve(secretsRoot, `${service}-intents`);
    if (!this.keyPath.startsWith(`${secretsRoot}${sep}`) && this.keyPath !== secretsRoot) throw new Error("Invalid protected key path");
  }

  start(referencedMaterialIds: ReadonlySet<string>): Promise<void> {
    return this.started ??= this.initialize(referencedMaterialIds);
  }

  private async initialize(referencedMaterialIds: ReadonlySet<string>): Promise<void> {
    await mkdir(dirname(this.keyPath), { recursive: true, mode: 0o700 });
    await this.rejectUnsafePath(dirname(this.keyPath));
    await mkdir(this.materialRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.intentRoot, { recursive: true, mode: 0o700 });
    await this.rejectUnsafePath(this.materialRoot);
    await this.rejectUnsafePath(this.intentRoot);
    const evidence = (await readdir(this.materialRoot)).length > 0 || (await readdir(this.intentRoot)).length > 0;
    try {
      const keyFile = await lstat(this.keyPath);
      if (!keyFile.isFile() || keyFile.isSymbolicLink()) throw new Error(`${this.label} encryption key is not a regular file`);
      const key = await readFile(this.keyPath);
      if (key.length !== KEY_BYTES) throw new Error(`${this.label} encryption key is corrupt; restore the matching stopped backup`);
      this.rootKey = key;
      await chmod(this.keyPath, 0o600).catch(() => undefined);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      if (evidence) throw new Error(`${this.label} encryption key is missing while protected material exists; restore state.json, secrets/${this.service}.key, and secrets/${this.service}-materials from the same stopped backup`);
      const key = randomBytes(KEY_BYTES);
      try {
        const file = await open(this.keyPath, "wx", 0o600);
        try { await file.writeFile(key); await file.sync(); } finally { await file.close(); }
        this.rootKey = key;
      } catch (createError: any) {
        if (createError.code !== "EEXIST") throw createError;
        const existing = await readFile(this.keyPath);
        if (existing.length !== KEY_BYTES) throw new Error(`${this.label} encryption key is corrupt; restore the matching stopped backup`);
        this.rootKey = existing;
      }
    }
    for (const materialId of referencedMaterialIds) await this.validateMaterialId(materialId);
    await this.recoverOrphans(referencedMaterialIds);
  }

  private async rejectUnsafePath(path: string): Promise<void> {
    const value = await lstat(path);
    if (!value.isDirectory() || value.isSymbolicLink()) throw new Error(`Protected ${this.label} path is unsafe: ${path}`);
  }

  private get label(): string {
    return this.service === "ssm" ? "SSM" : this.service === "secretsmanager" ? "Secrets Manager" : "AppSync";
  }

  private derivedKey(binding: MaterialBinding): Buffer {
    if (!this.rootKey) throw new Error(`${this.label} encrypted material store is not started`);
    // Persisted HKDF context.
    return Buffer.from(hkdfSync("sha256", this.rootKey, Buffer.from(`${binding.accountId}:${binding.region}`), Buffer.from(`stacksim:${this.service}:encryption:v1`), KEY_BYTES));
  }

  private materialPath(materialId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(materialId)) throw new Error("Invalid protected material identifier");
    return join(this.materialRoot, `${materialId}.json`);
  }

  async publish(binding: MaterialBinding, plaintext: Buffer): Promise<{ materialId: string; opaqueValue: string }> {
    if (!this.rootKey) throw new Error(`${this.label} encrypted material store is not started`);
    const materialId = randomUUID();
    const intent = join(this.intentRoot, `${materialId}.json`);
    await writeFile(intent, JSON.stringify({ version: 1, materialId, createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.derivedKey(binding), nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(associatedData(binding, materialId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: Envelope = {
      version: 1,
      keyVersion: 1,
      materialId,
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64"),
    };
    const temporary = `${this.materialPath(materialId)}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(envelope), { flag: "wx", mode: 0o600 });
    await rename(temporary, this.materialPath(materialId));
    return { materialId, opaqueValue: this.opaque(envelope) };
  }

  async read(binding: MaterialBinding, materialId: string): Promise<Buffer> {
    this.readPins.set(materialId, (this.readPins.get(materialId) ?? 0) + 1);
    try {
      const envelope = await this.envelope(materialId);
      try {
        const decipher = createDecipheriv("aes-256-gcm", this.derivedKey(binding), Buffer.from(envelope.nonce, "base64url"), { authTagLength: TAG_BYTES });
        decipher.setAAD(associatedData(binding, materialId));
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
      } catch {
        throw new Error(`${this.label} protected material ${materialId} failed authentication; restore the matching stopped backup`);
      }
    } finally {
      const remaining = (this.readPins.get(materialId) ?? 1) - 1;
      if (remaining > 0) {
        this.readPins.set(materialId, remaining);
      } else {
        this.readPins.delete(materialId);
        if (this.pendingRemovals.delete(materialId)) await this.unlinkMaterial(materialId);
      }
    }
  }

  async opaqueValue(binding: MaterialBinding, materialId: string): Promise<string> {
    const envelope = await this.envelope(materialId);
    const authenticated = await this.read(binding, materialId);
    authenticated.fill(0);
    return this.opaque(envelope);
  }

  async commit(materialId: string): Promise<void> {
    await unlink(join(this.intentRoot, `${materialId}.json`)).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async abort(materialId: string): Promise<void> {
    await this.commit(materialId);
    await unlink(this.materialPath(materialId)).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async remove(materialId: string): Promise<void> {
    await this.commit(materialId);
    if ((this.readPins.get(materialId) ?? 0) > 0) {
      this.pendingRemovals.add(materialId);
      return;
    }
    await this.unlinkMaterial(materialId);
  }

  private async unlinkMaterial(materialId: string): Promise<void> {
    await unlink(this.materialPath(materialId)).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private opaque(envelope: Envelope): string {
    return `AQICAH${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")}`;
  }

  private async envelope(materialId: string): Promise<Envelope> {
    await this.validateMaterialId(materialId);
    let parsed: any;
    try { parsed = JSON.parse(await readFile(this.materialPath(materialId), "utf8")); }
    catch (error: any) {
      if (error.code === "ENOENT") throw new Error(`${this.label} protected material ${materialId} is missing; restore the matching stopped backup`);
      throw new Error(`${this.label} protected material ${materialId} is corrupt; restore the matching stopped backup`);
    }
    if (parsed?.version !== 1 || parsed?.keyVersion !== 1 || parsed?.materialId !== materialId
      || typeof parsed.nonce !== "string" || typeof parsed.tag !== "string" || typeof parsed.ciphertext !== "string") {
      throw new Error(`${this.label} protected material ${materialId} has an unsupported or corrupt envelope`);
    }
    return parsed as Envelope;
  }

  private async validateMaterialId(materialId: string): Promise<void> {
    const path = this.materialPath(materialId);
    let info;
    try { info = await lstat(path); }
    catch (error: any) {
      if (error.code === "ENOENT") throw new Error(`${this.label} protected material ${materialId} is missing; restore the matching stopped backup`);
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${this.label} protected material ${materialId} is unsafe`);
    await stat(path);
  }

  private async recoverOrphans(references: ReadonlySet<string>): Promise<void> {
    for (const name of await readdir(this.intentRoot)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const materialId = name.slice(0, -5);
      if (references.has(materialId)) {
        await unlink(join(this.intentRoot, name)).catch(() => undefined);
      } else {
        await unlink(join(this.intentRoot, name)).catch(() => undefined);
        await unlink(this.materialPath(materialId)).catch(() => undefined);
      }
    }
    // Published material without a current control reference is retained as a
    // recoverable orphan. This keeps older stopped control snapshots usable
    // with their original immutable material set. A bounded, grace-period
    // compactor can reclaim these after snapshot/reference accounting.
  }
}
