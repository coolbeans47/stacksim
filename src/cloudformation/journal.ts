import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const JOURNAL_VERSION = 1 as const;
const DEFAULT_ACCOUNT_ID = "000000000000";
const DEFAULT_REGION = "eu-west-1";

export interface CloudFormationJournalEntry<T = unknown> {
  readonly version: typeof JOURNAL_VERSION;
  readonly sequence: number;
  readonly operationId: string;
  readonly terminal: boolean;
  readonly recordedAt: string;
  readonly payload: T;
}

export interface CloudFormationJournalAppend<T> {
  readonly operationId: string;
  readonly payload: T;
  readonly terminal?: boolean;
  readonly recordedAt?: string;
}

export interface CloudFormationJournalCompactionOptions {
  /**
   * Number of tail records retained for an operation whose latest record is
   * terminal. At least one record is always retained so terminal status and
   * the journal sequence high-water mark remain durable.
   */
  readonly retainTerminalRecordsPerOperation?: number;
  /**
   * Maximum number of completed operations retained in the journal. Active
   * operations are never counted against or removed by this bound. Omit to
   * retain one compacted tail for every completed operation.
   */
  readonly retainTerminalOperations?: number;
  /** Completed operations that are still rollback/recovery roots. */
  readonly preserveOperationIds?: readonly string[];
}

export interface CloudFormationJournalCompactionResult {
  readonly recordsBefore: number;
  readonly recordsAfter: number;
  readonly recordsRemoved: number;
  readonly activeOperations: number;
  readonly terminalOperations: number;
}

export type CloudFormationTemplateForm = "original" | "processed" | "previous";

export class CloudFormationJournalCorruptionError extends Error {
  constructor(
    readonly journalPath: string,
    readonly line: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`CloudFormation journal ${journalPath} is corrupt at line ${line}: ${message}`, options);
    this.name = "CloudFormationJournalCorruptionError";
  }
}

/**
 * Durable, regional CloudFormation storage.
 *
 * The operation journal is append-only between compactions. All public I/O is
 * serialized through one queue, which gives callers a stable append/read order
 * even when they submit operations concurrently. Artifact replacement uses a
 * same-directory temporary file followed by rename, so readers observe either
 * the old bytes or the complete new bytes.
 */
export class CloudFormationJournal<T = unknown> {
  readonly root: string;
  readonly accountId: string;
  readonly region: string;
  readonly directory: string;
  readonly journalPath: string;
  readonly artifactsDirectory: string;

  private queue: Promise<void> = Promise.resolve();
  private initialized = false;
  private nextSequence = 1;

  constructor(
    root = process.env.STACKSIM_DATA_DIR ?? resolve(".stacksim"),
    accountId = process.env.STACKSIM_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID,
    region = process.env.AWS_REGION ?? DEFAULT_REGION,
  ) {
    validateAccountId(accountId);
    validateRegion(region);
    this.root = resolve(root);
    this.accountId = accountId;
    this.region = region;
    this.directory = resolve(this.root, "data", "cloudformation", accountId, region);
    this.journalPath = resolve(this.directory, "operations.jsonl");
    this.artifactsDirectory = resolve(this.directory, "artifacts");
  }

  /** Ensure the directory exists and repair a torn, non-newline-terminated tail. */
  async start(): Promise<void> {
    await this.enqueue(async () => this.initializeLocked());
  }

  /** Wait for every operation submitted before this call to become durable. */
  async flush(): Promise<void> {
    await this.enqueue(async () => undefined);
  }

  async append(input: CloudFormationJournalAppend<T>): Promise<CloudFormationJournalEntry<T>>;
  async append(
    operationId: string,
    payload: T,
    options?: { readonly terminal?: boolean; readonly recordedAt?: string },
  ): Promise<CloudFormationJournalEntry<T>>;
  async append(
    inputOrOperationId: CloudFormationJournalAppend<T> | string,
    payload?: T,
    options: { readonly terminal?: boolean; readonly recordedAt?: string } = {},
  ): Promise<CloudFormationJournalEntry<T>> {
    const input: CloudFormationJournalAppend<T> = typeof inputOrOperationId === "string"
      ? { operationId: inputOrOperationId, payload: payload as T, ...options }
      : inputOrOperationId;
    validateOperationId(input.operationId);
    if (input.recordedAt !== undefined) validateTimestamp(input.recordedAt);
    if (input.terminal !== undefined && typeof input.terminal !== "boolean") {
      throw new TypeError("terminal must be a boolean when supplied");
    }
    const payloadSnapshot = snapshotJson(input.payload);
    const recordedAt = input.recordedAt ?? new Date().toISOString();

    return this.enqueue(async () => {
      await this.initializeLocked();
      const entry: CloudFormationJournalEntry<T> = {
        version: JOURNAL_VERSION,
        sequence: this.nextSequence,
        operationId: input.operationId,
        terminal: input.terminal ?? false,
        recordedAt,
        payload: payloadSnapshot,
      };
      const encoded = encodeEntry(entry);
      try {
        await durableAppend(this.journalPath, encoded);
      } catch (error) {
        // A write or directory fsync error can have an uncertain outcome. Read
        // the durable tail before allowing another append so a retry can never
        // reuse a sequence that did reach disk.
        const durableEntries = await recoverJournalFile<T>(this.journalPath);
        this.nextSequence = (durableEntries.at(-1)?.sequence ?? 0) + 1;
        throw error;
      }
      this.nextSequence += 1;
      return entry;
    });
  }

  /** Return entries in their durable sequence order. */
  async readAll(): Promise<Array<CloudFormationJournalEntry<T>>> {
    return this.enqueue(async () => {
      await this.initializeLocked();
      return readJournalFile<T>(this.journalPath);
    });
  }

  /**
   * Collapse completed operations to their latest tail record(s), while
   * preserving every record belonging to an operation that is still active.
   */
  async compactTerminalOperations(
    options: CloudFormationJournalCompactionOptions = {},
  ): Promise<CloudFormationJournalCompactionResult> {
    const retainCount = options.retainTerminalRecordsPerOperation ?? 1;
    if (!Number.isSafeInteger(retainCount) || retainCount < 1) {
      throw new RangeError("retainTerminalRecordsPerOperation must be a positive safe integer");
    }
    const retainOperations = options.retainTerminalOperations;
    if (retainOperations !== undefined && (!Number.isSafeInteger(retainOperations) || retainOperations < 1)) {
      throw new RangeError("retainTerminalOperations must be a positive safe integer when supplied");
    }
    const preservedOperationIds = new Set(options.preserveOperationIds ?? []);
    for (const operationId of preservedOperationIds) validateOperationId(operationId);

    return this.enqueue(async () => {
      await this.initializeLocked();
      const entries = await readJournalFile<T>(this.journalPath);
      const byOperation = new Map<string, Array<CloudFormationJournalEntry<T>>>();
      for (const entry of entries) {
        const records = byOperation.get(entry.operationId) ?? [];
        records.push(entry);
        byOperation.set(entry.operationId, records);
      }

      let activeOperations = 0;
      let terminalOperations = 0;
      const retained: Array<CloudFormationJournalEntry<T>> = [];
      const terminalGroups: Array<Array<CloudFormationJournalEntry<T>>> = [];
      for (const records of byOperation.values()) {
        if (records.at(-1)?.terminal) {
          terminalOperations += 1;
          terminalGroups.push(records);
        } else {
          activeOperations += 1;
          retained.push(...records);
        }
      }
      terminalGroups.sort((left, right) => right.at(-1)!.sequence - left.at(-1)!.sequence);
      const selectedTerminalOperations = new Set<string>();
      if (retainOperations === undefined) {
        for (const records of terminalGroups) selectedTerminalOperations.add(records[0].operationId);
      } else {
        // Always keep the newest terminal tail: it carries the sequence high
        // water mark needed to continue monotonically after restart.
        if (terminalGroups[0]) selectedTerminalOperations.add(terminalGroups[0][0].operationId);
        for (const records of terminalGroups) {
          if (preservedOperationIds.has(records[0].operationId)) selectedTerminalOperations.add(records[0].operationId);
        }
        for (const records of terminalGroups) {
          if (selectedTerminalOperations.size >= retainOperations) break;
          selectedTerminalOperations.add(records[0].operationId);
        }
      }
      for (const records of terminalGroups) {
        if (selectedTerminalOperations.has(records[0].operationId)) retained.push(...records.slice(-retainCount));
      }
      retained.sort((left, right) => left.sequence - right.sequence);

      const encoded = retained.length === 0
        ? Buffer.alloc(0)
        : Buffer.from(`${retained.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      await atomicReplace(this.journalPath, encoded);

      return {
        recordsBefore: entries.length,
        recordsAfter: retained.length,
        recordsRemoved: entries.length - retained.length,
        activeOperations,
        terminalOperations,
      };
    });
  }

  /** Resolve a validated artifact address without permitting nested paths. */
  artifactPath(collection: string, artifactId: string): string {
    validatePathIdentifier("artifact collection", collection);
    validatePathIdentifier("artifact id", artifactId);
    const collectionDirectory = resolve(this.artifactsDirectory, collection);
    const target = resolve(collectionDirectory, artifactId);
    assertContained(this.artifactsDirectory, target);
    return target;
  }

  /** Atomically and durably replace an artifact's complete byte content. */
  async replaceArtifact(
    collection: string,
    artifactId: string,
    contents: string | Uint8Array,
  ): Promise<void> {
    const target = this.artifactPath(collection, artifactId);
    const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
    await this.enqueue(async () => {
      await this.initializeLocked();
      await atomicReplace(target, bytes);
    });
  }

  async replaceJsonArtifact(collection: string, artifactId: string, value: unknown): Promise<void> {
    let json: string | undefined;
    try {
      json = JSON.stringify(value, null, 2);
    } catch (error) {
      throw new TypeError("CloudFormation artifact must be JSON serializable", { cause: error });
    }
    if (json === undefined) throw new TypeError("CloudFormation artifact must be JSON serializable and not undefined");
    const encoded = `${json}\n`;
    await this.replaceArtifact(collection, artifactId, encoded);
  }

  async readArtifact(collection: string, artifactId: string): Promise<Buffer | undefined> {
    const target = this.artifactPath(collection, artifactId);
    return this.enqueue(async () => {
      await this.initializeLocked();
      try {
        return await readFile(target);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      }
    });
  }

  /** Durably remove one artifact. Missing artifacts are an idempotent no-op. */
  async deleteArtifact(collection: string, artifactId: string): Promise<boolean> {
    return (await this.deleteArtifacts(collection, [artifactId])) === 1;
  }

  /** Durably remove a validated batch with one directory fsync. */
  async deleteArtifacts(collection: string, artifactIds: readonly string[]): Promise<number> {
    validatePathIdentifier("artifact collection", collection);
    const uniqueIds = [...new Set(artifactIds)];
    for (const artifactId of uniqueIds) validatePathIdentifier("artifact id", artifactId);
    const collectionDirectory = resolve(this.artifactsDirectory, collection);
    assertContained(this.artifactsDirectory, collectionDirectory);
    return this.enqueue(async () => {
      await this.initializeLocked();
      let removed = 0;
      for (const artifactId of uniqueIds) {
        const target = resolve(collectionDirectory, artifactId);
        assertContained(this.artifactsDirectory, target);
        try {
          await rm(target);
          removed += 1;
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
        }
      }
      if (removed > 0) await syncDirectory(collectionDirectory);
      return removed;
    });
  }

  async readJsonArtifact<U = unknown>(collection: string, artifactId: string): Promise<U | undefined> {
    const bytes = await this.readArtifact(collection, artifactId);
    return bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8")) as U;
  }

  /** List artifact IDs in bytewise-stable order. */
  async listArtifacts(collection: string): Promise<string[]> {
    validatePathIdentifier("artifact collection", collection);
    const collectionDirectory = resolve(this.artifactsDirectory, collection);
    assertContained(this.artifactsDirectory, collectionDirectory);
    return this.enqueue(async () => {
      await this.initializeLocked();
      try {
        return (await readdir(collectionDirectory, { withFileTypes: true }))
          .filter(entry => entry.isFile() && isPathIdentifier(entry.name))
          .map(entry => entry.name)
          .sort(compareBytes);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return [];
        throw error;
      }
    });
  }

  /** Convenience wrapper for original, processed, and prior template bodies. */
  async replaceTemplate(
    templateId: string,
    contents: string | Uint8Array,
    form: CloudFormationTemplateForm = "original",
  ): Promise<void> {
    validatePathIdentifier("template id", templateId);
    validateTemplateForm(form);
    await this.replaceArtifact("templates", `${templateId}.${form}.template`, contents);
  }

  async readTemplate(
    templateId: string,
    form: CloudFormationTemplateForm = "original",
  ): Promise<string | undefined> {
    validatePathIdentifier("template id", templateId);
    validateTemplateForm(form);
    const bytes = await this.readArtifact("templates", `${templateId}.${form}.template`);
    return bytes?.toString("utf8");
  }

  private async initializeLocked(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.artifactsDirectory, { recursive: true });
    await syncDirectory(this.directory);
    const entries = await recoverJournalFile<T>(this.journalPath);
    this.nextSequence = (entries.at(-1)?.sequence ?? 0) + 1;
    this.initialized = true;
  }

  private enqueue<U>(operation: () => Promise<U>): Promise<U> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function encodeEntry<T>(entry: CloudFormationJournalEntry<T>): Buffer {
  let json: string | undefined;
  try {
    json = JSON.stringify(entry);
  } catch (error) {
    throw new TypeError("CloudFormation journal payload must be JSON serializable", { cause: error });
  }
  if (json === undefined || !("payload" in JSON.parse(json))) {
    throw new TypeError("CloudFormation journal payload must be JSON serializable and not undefined");
  }
  return Buffer.from(`${json}\n`, "utf8");
}

function snapshotJson<T>(value: T): T {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new TypeError("CloudFormation journal payload must be JSON serializable", { cause: error });
  }
  if (json === undefined) {
    throw new TypeError("CloudFormation journal payload must be JSON serializable and not undefined");
  }
  return JSON.parse(json) as T;
}

async function durableAppend(path: string, contents: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "a", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await syncDirectory(dirname(path));
}

async function atomicReplace(path: string, contents: Uint8Array): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, `.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function recoverJournalFile<T>(path: string): Promise<Array<CloudFormationJournalEntry<T>>> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }

  const finalNewline = bytes.lastIndexOf(0x0a);
  const completeLength = finalNewline + 1;
  if (completeLength !== bytes.length) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "r+");
      await handle.truncate(completeLength);
      await handle.sync();
    } finally {
      await handle?.close();
    }
    await syncDirectory(dirname(path));
    bytes = bytes.subarray(0, completeLength);
  }
  return parseJournal<T>(path, bytes);
}

async function readJournalFile<T>(path: string): Promise<Array<CloudFormationJournalEntry<T>>> {
  try {
    return parseJournal<T>(path, await readFile(path));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

function parseJournal<T>(path: string, bytes: Uint8Array): Array<CloudFormationJournalEntry<T>> {
  if (bytes.byteLength === 0) return [];
  const text = Buffer.from(bytes).toString("utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const entries: Array<CloudFormationJournalEntry<T>> = [];
  let previousSequence = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    if (line.length === 0) {
      throw new CloudFormationJournalCorruptionError(path, lineNumber, "blank records are not valid JSONL entries");
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch (error) {
      throw new CloudFormationJournalCorruptionError(path, lineNumber, "invalid JSON", { cause: error });
    }
    if (!isJournalEntry(candidate)) {
      throw new CloudFormationJournalCorruptionError(path, lineNumber, "record does not match journal schema v1");
    }
    if (candidate.sequence <= previousSequence) {
      throw new CloudFormationJournalCorruptionError(path, lineNumber, "sequence numbers must be strictly increasing");
    }
    previousSequence = candidate.sequence;
    entries.push(candidate as CloudFormationJournalEntry<T>);
  }
  return entries;
}

function isJournalEntry(value: unknown): value is CloudFormationJournalEntry<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return entry.version === JOURNAL_VERSION
    && Number.isSafeInteger(entry.sequence)
    && (entry.sequence as number) > 0
    && typeof entry.operationId === "string"
    && entry.operationId.length > 0
    && typeof entry.terminal === "boolean"
    && typeof entry.recordedAt === "string"
    && entry.recordedAt.length > 0
    && Object.prototype.hasOwnProperty.call(entry, "payload");
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    // Windows and some network/file-system drivers cannot open or fsync a
    // directory. File fsync still applies; ignore only known unsupported cases.
    if (!hasAnyCode(error, ["EACCES", "EBADF", "EISDIR", "EINVAL", "ENOSYS", "ENOTSUP", "EPERM"])) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateAccountId(accountId: string): void {
  if (!/^\d{12}$/.test(accountId)) throw new TypeError("accountId must be a 12-digit AWS account identifier");
}

function validateRegion(region: string): void {
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region)) throw new TypeError("region must be a valid AWS Region identifier");
}

function validatePathIdentifier(label: string, value: string): void {
  if (!isPathIdentifier(value)) {
    throw new TypeError(`${label} must be a single safe path identifier`);
  }
}

function isPathIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value) && value !== "." && value !== "..";
}

function validateOperationId(operationId: string): void {
  if (operationId.length === 0 || operationId.length > 1_024 || /[\u0000-\u001f\u007f]/.test(operationId)) {
    throw new TypeError("operationId must be a non-empty identifier without control characters");
  }
}

function validateTimestamp(timestamp: string): void {
  if (timestamp.length === 0 || !Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError("recordedAt must be a valid timestamp");
  }
}

function validateTemplateForm(form: string): asserts form is CloudFormationTemplateForm {
  if (form !== "original" && form !== "processed" && form !== "previous") {
    throw new TypeError("template form must be original, processed, or previous");
  }
}

function assertContained(parent: string, candidate: string): void {
  const child = relative(parent, candidate);
  if (child === "" || child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(child)) {
    throw new TypeError("artifact path escapes the CloudFormation storage directory");
  }
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function hasAnyCode(error: unknown, codes: readonly string[]): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && codes.includes(String((error as { code?: unknown }).code));
}
