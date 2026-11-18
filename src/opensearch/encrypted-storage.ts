import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const MAGIC = Buffer.from("STACKSIM-SEARCH-AES256GCM-1\n");
const MAX_BYTES = 512 * 1024 * 1024;
const TABLES = {
  metadata: ["kind", "name", "value"],
  documents: ["index_name", "id", "source", "visible", "seq", "version", "visible_seq", "visible_version", "routing"],
} as const;

/** SQLite runs entirely in memory. Only authenticated ciphertext reaches disk.
 * Each transaction has one durable encrypted changeset; checkpoints compact the
 * journal into an encrypted snapshot. Neither SQLite's WAL nor temp store uses
 * a filesystem. Keys are installation-local secrets, not an AWS KMS substitute.
 */
export class EncryptedSearchStorage {
  private readonly key: Buffer;
  private sequence = 0;
  private checkpointSequence = 0;
  private readonly journal: string;
  private readonly head: string;
  private readonly binding: string;
  constructor(readonly file: string, keyFile: string, private readonly db: DatabaseSync, private readonly tables: Readonly<Record<string, readonly string[]>> = TABLES) {
    // Callers supply fixed application schemas, never request-selected SQL.
    for (const [table, columns] of Object.entries(tables)) if (![table, ...columns].every(name => /^[a-z][a-z0-9_]*$/.test(name))) throw new Error("Invalid encrypted storage schema");
    this.journal = `${file}.journal`;
    this.head = `${file}.head`;
    // Generation is part of every authenticated envelope. Copying a data file
    // into a different resource must not grant access or silently fork its data.
    this.binding = dirname(file).split(/[\\/]/).at(-1)!;
    mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
    mkdirSync(this.journal, { recursive: true, mode: 0o700 });
    const existing = existsSync(file);
    if (!existsSync(keyFile)) {
      if (existing || existsSync(this.head) || readdirSync(this.journal).some(name => name.endsWith(".txn"))) throw new Error("OpenSearch encryption key is unavailable; restore the matching key and data backup");
      const generated = randomBytes(32);
      try { this.writeExclusive(keyFile, generated); this.syncDirectory(dirname(keyFile)); }
      finally { generated.fill(0); }
    }
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32) { this.key.fill(0); throw new Error("OpenSearch encryption key is invalid"); }
    try {
      if (existing) this.restore();
      else {
        if (readdirSync(this.journal).some(name => name.endsWith(".txn")) || existsSync(this.head) && this.readHead() !== 0) throw new Error("OpenSearch encrypted snapshot is missing");
        this.writeHead(0);
        this.checkpoint();
      }
    } catch (error) { this.key.fill(0); throw error; }
  }
  private syncDirectory(directory: string): void {
    // Windows does not support opening/fsyncing directories through Node fs.
    // File data is still flushed before the atomic rename on every platform.
    if (process.platform === "win32") return;
    const fd = openSync(directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  private writeExclusive(file: string, data: Buffer): void {
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  }
  private encrypt(data: Uint8Array, label: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`${this.binding}:${label}`));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
  }
  private decrypt(data: Buffer, label: string): Buffer {
    try {
      if (!data.subarray(0, MAGIC.length).equals(MAGIC) || data.length < MAGIC.length + 28) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(MAGIC.length, MAGIC.length + 12));
      decipher.setAAD(Buffer.from(`${this.binding}:${label}`));
      decipher.setAuthTag(data.subarray(MAGIC.length + 12, MAGIC.length + 28));
      return Buffer.concat([decipher.update(data.subarray(MAGIC.length + 28)), decipher.final()]);
    } catch { throw new Error("OpenSearch encrypted storage could not be authenticated; restore data and its matching key"); }
  }
  private atomicWrite(target: string, data: Buffer): void {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      this.writeExclusive(temporary, data);
      renameSync(temporary, target);
      this.syncDirectory(dirname(target));
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private readHead(): number {
    if (!existsSync(this.head)) throw new Error("OpenSearch encrypted commit record is missing");
    const plaintext = this.decrypt(readFileSync(this.head), "head");
    try { const value = JSON.parse(plaintext.toString("utf8")); if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new Error("Invalid encrypted commit record"); return value.sequence; }
    finally { plaintext.fill(0); }
  }
  private writeHead(sequence: number): void { this.atomicWrite(this.head, this.encrypt(Buffer.from(JSON.stringify({ sequence })), "head")); }
  private restore(): void {
    const head = this.readHead();
    const plaintext = this.decrypt(readFileSync(this.file), "snapshot");
    try {
      const snapshot = JSON.parse(plaintext.toString("utf8"));
      if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) throw new Error("Invalid encrypted search snapshot");
      this.db.exec("BEGIN");
      try {
        for (const [table, columns] of Object.entries(this.tables)) {
          const insert = this.db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
          if (!Array.isArray(snapshot[table])) throw new Error("Invalid encrypted search snapshot");
          for (const row of snapshot[table]) insert.run(...columns.map(column => row[column]));
        }
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      this.sequence = this.checkpointSequence = snapshot.sequence;
      if (this.sequence > head) throw new Error("OpenSearch encrypted commit record precedes its checkpoint");
    } finally { plaintext.fill(0); }
    const files = readdirSync(this.journal).filter(name => /^\d{16}\.txn$/.test(name)).sort();
    for (const name of files) {
      const sequence = Number(name.slice(0, 16));
      if (sequence <= this.checkpointSequence) continue;
      if (sequence > head) { unlinkSync(join(this.journal, name)); continue; }
      if (sequence !== this.sequence + 1) throw new Error("OpenSearch encrypted journal has a missing transaction");
      const changeset = this.decrypt(readFileSync(join(this.journal, name)), `transaction:${sequence}`);
      try { if (!this.db.applyChangeset(changeset)) throw new Error("OpenSearch encrypted journal conflicts with its snapshot"); }
      finally { changeset.fill(0); }
      this.sequence = sequence;
    }
    if (this.sequence !== head) throw new Error("OpenSearch encrypted journal has a missing transaction");
    this.cleanup();
  }
  private cleanup(): void {
    for (const name of readdirSync(this.journal)) {
      if (name.endsWith(".tmp") || /^\d{16}\.txn$/.test(name) && Number(name.slice(0, 16)) <= this.checkpointSequence) unlinkSync(join(this.journal, name));
    }
    for (const name of readdirSync(dirname(this.file))) if (name.startsWith(`${this.file.split(/[\\/]/).at(-1)}.`) && name.endsWith(".tmp")) unlinkSync(join(dirname(this.file), name));
  }
  checkpoint(): void {
    const snapshot: Record<string, unknown> = { version: 1, sequence: this.sequence };
    for (const table of Object.keys(this.tables)) snapshot[table] = this.db.prepare(`SELECT * FROM ${table}`).all();
    const plaintext = Buffer.from(JSON.stringify(snapshot));
    try {
      if (plaintext.length > MAX_BYTES / 2) throw new Error("OpenSearch encrypted snapshot exceeds the local 256 MiB limit");
      this.atomicWrite(this.file, this.encrypt(plaintext, "snapshot"));
      this.checkpointSequence = this.sequence;
    } finally { plaintext.fill(0); }
    this.cleanup();
  }
  /** Persist before committing the memory-only SQLite transaction. A crash after
   * the durable rename may replay an unacknowledged write, never lose an ack. */
  commit(changeset: Uint8Array): void {
    if (!changeset.length) return;
    const sequence = this.sequence + 1;
    const files = readdirSync(this.journal);
    const used = statSync(this.file).size + files.reduce((sum, name) => sum + statSync(join(this.journal, name)).size, 0);
    const encrypted = this.encrypt(changeset, `transaction:${sequence}`);
    if (used + encrypted.length > MAX_BYTES) throw new Error("OpenSearch encrypted storage exceeds the local 512 MiB limit");
    this.atomicWrite(join(this.journal, `${String(sequence).padStart(16, "0")}.txn`), encrypted);
    this.writeHead(sequence);
    this.sequence = sequence;
  }
  compactIfNeeded(): void {
    if (this.sequence - this.checkpointSequence >= 128) {
      // The transaction is already durable. A failed optional checkpoint cannot
      // turn an acknowledged write into an error or remove the recovery journal.
      try { this.checkpoint(); } catch { /* Retry after the next commit/restart. */ }
    }
  }
  close(): void { this.key.fill(0); }
}
