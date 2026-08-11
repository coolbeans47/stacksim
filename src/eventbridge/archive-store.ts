import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export type ArchiveRuntimeState = "ENABLED" | "DISABLED" | "CREATE_FAILED" | "UPDATE_FAILED";
export type ReplayRuntimeState = "STARTING" | "RUNNING" | "CANCELLING" | "COMPLETED" | "CANCELLED" | "FAILED";

export interface EventBridgeArchiveMetadata {
  name: string;
  arn: string;
  eventSourceArn: string;
  eventBusName: string;
  description?: string;
  eventPattern?: string;
  retentionDays: number;
  state: ArchiveRuntimeState;
  stateReason?: string;
  createdAt: number;
  lastModified: number;
  records: EventBridgeArchiveRecord[];
}

export interface EventBridgeArchiveRecord {
  id: string;
  eventId: string;
  eventTime: number;
  acceptedAt: number;
  sizeBytes: number;
  segment: string;
}

export interface EventBridgeReplayMetadata {
  name: string;
  arn: string;
  description?: string;
  archiveName: string;
  eventSourceArn: string;
  destinationArn: string;
  filterArns?: string[];
  eventStartTime: number;
  eventEndTime: number;
  state: ReplayRuntimeState;
  stateReason?: string;
  replayStartTime: number;
  replayEndTime?: number;
  eventLastReplayedTime?: number;
  recordIds: string[];
  cursor: number;
  cancelRequested: boolean;
  leaseId?: string;
  leaseUntil?: number;
}

interface ArchiveControl {
  version: 1;
  archives: Record<string, EventBridgeArchiveMetadata>;
  replays: Record<string, EventBridgeReplayMetadata>;
}

interface SegmentPlaintext {
  version: 1;
  archiveName: string;
  record: EventBridgeArchiveRecord;
  envelope: string;
}

interface EncryptedEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  tag: string;
  ciphertext: string;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const REPLAY_HISTORY_MS = 90 * DAY_MS;

function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function clone<T>(value: T): T { return structuredClone(value); }
function emptyControl(): ArchiveControl { return { version: 1, archives: Object.create(null), replays: Object.create(null) }; }

/**
 * EVB-04 durable data plane. Event payloads, archive indexes, replay leases and
 * checkpoints deliberately live outside state.json. Segment publication is
 * write-new, fsync and rename; recovery indexes committed orphan segments and
 * removes incomplete temporary files.
 */
export class EventBridgeArchiveStore {
  readonly directory: string;
  readonly segmentsDirectory: string;
  readonly controlFile: string;
  private control = emptyControl();
  private serial = Promise.resolve();
  private started = false;

  constructor(root: string, accountId: string, region: string, private readonly encryptionKeySource: Buffer | (() => Buffer)) {
    this.directory = resolve(root, "data", "eventbridge", accountId, region, "archives");
    this.segmentsDirectory = resolve(this.directory, "segments");
    this.controlFile = resolve(this.directory, "control.json");
  }

  private get encryptionKey(): Buffer { const key = typeof this.encryptionKeySource === "function" ? this.encryptionKeySource() : this.encryptionKeySource; if (key.length !== 32) throw new Error("EventBridge archive encryption key must contain 32 bytes."); return key; }

  async start(now: number): Promise<void> {
    if (this.started) return;
    await mkdir(this.segmentsDirectory, { recursive: true, mode: 0o700 });
    try {
      const encrypted = JSON.parse(await readFile(this.controlFile, "utf8")) as EncryptedEnvelope;
      const parsed = JSON.parse(this.decrypt(encrypted, basename(this.controlFile))) as ArchiveControl;
      if (parsed.version !== 1 || !parsed.archives || !parsed.replays) throw new Error("unsupported archive control format");
      this.control = parsed;
    } catch (error) {
      if (!missing(error)) throw new Error(`EventBridge archive control is corrupt: ${error instanceof Error ? error.message : String(error)}`);
      await this.persist(this.control);
    }
    await this.recoverSegments();
    await this.reconcile(now);
    this.started = true;
  }

  async stop(): Promise<void> { await this.serial.catch(() => undefined); }
  archives(): EventBridgeArchiveMetadata[] { return Object.values(this.control.archives).map(clone); }
  replays(): EventBridgeReplayMetadata[] { return Object.values(this.control.replays).map(clone); }
  archive(name: string): EventBridgeArchiveMetadata | undefined { const value = this.control.archives[name]; return value ? clone(value) : undefined; }
  replay(name: string): EventBridgeReplayMetadata | undefined { const value = this.control.replays[name]; return value ? clone(value) : undefined; }

  async createArchive(value: Omit<EventBridgeArchiveMetadata, "records">): Promise<EventBridgeArchiveMetadata> {
    return this.mutate(control => {
      if (control.archives[value.name]) throw new Error("ArchiveAlreadyExists");
      control.archives[value.name] = { ...clone(value), records: [] };
      return clone(control.archives[value.name]);
    });
  }

  async updateArchive(name: string, update: Pick<EventBridgeArchiveMetadata, "description" | "eventPattern" | "retentionDays" | "lastModified">): Promise<EventBridgeArchiveMetadata> {
    return this.mutate(control => {
      const archive = control.archives[name]; if (!archive) throw new Error("ArchiveNotFound");
      archive.description = update.description; archive.eventPattern = update.eventPattern; archive.retentionDays = update.retentionDays; archive.lastModified = update.lastModified; archive.state = "ENABLED"; delete archive.stateReason;
      return clone(archive);
    });
  }

  async deleteArchive(name: string): Promise<boolean> {
    const archive = this.control.archives[name]; if (!archive) return false;
    if (Object.values(this.control.replays).some(replay => replay.archiveName === name && ["STARTING", "RUNNING", "CANCELLING"].includes(replay.state))) throw new Error("ArchiveReplayConflict");
    const segments = archive.records.map(record => record.segment);
    await this.mutate(control => { delete control.archives[name]; return undefined; });
    for (const segment of segments) await unlink(resolve(this.segmentsDirectory, segment)).catch(error => { if (!missing(error)) throw error; });
    await this.syncDirectory(this.segmentsDirectory);
    return true;
  }

  async publish(archiveNames: string[], envelope: string, acceptedAt: number): Promise<void> {
    if (!archiveNames.length) return;
    await this.enqueue(async () => {
      const next = clone(this.control);
      try {
        for (const archiveName of archiveNames) {
          const archive = next.archives[archiveName];
          if (!archive || archive.state !== "ENABLED") continue;
          const metadata = JSON.parse(envelope) as Record<string, unknown>; const eventId = String(metadata.id); if (archive.records.some(record => record.eventId === eventId)) continue; const bytes = Buffer.from(envelope); const eventTime = Date.parse(String(metadata.time)); const id = randomUUID();
          const segment = `${archiveName}--${String(Math.floor(eventTime / 60_000)).padStart(13, "0")}--${id}.seg`;
          const record: EventBridgeArchiveRecord = { id, eventId, eventTime, acceptedAt, sizeBytes: bytes.length, segment };
          const plaintext: SegmentPlaintext = { version: 1, archiveName, record, envelope };
          await this.publishSegment(segment, plaintext); archive.records.push(record);
        }
        await this.persist(next); this.control = next;
      } catch (error) {
        // Published segments are intentionally left for restart reconciliation.
        // An unacknowledged PutEvents retry can therefore be at-least-once.
        throw error;
      }
    });
  }

  async readEvent(archiveName: string, recordId: string): Promise<string | undefined> {
    const record = this.control.archives[archiveName]?.records.find(candidate => candidate.id === recordId);
    if (!record) return undefined;
    const decoded = await this.readSegment(resolve(this.segmentsDirectory, record.segment));
    return decoded.envelope;
  }

  async createReplay(value: Omit<EventBridgeReplayMetadata, "recordIds" | "cursor" | "cancelRequested">): Promise<EventBridgeReplayMetadata> {
    return this.mutate(control => {
      if (control.replays[value.name]) throw new Error("ReplayAlreadyExists");
      if (Object.values(control.replays).filter(replay => ["STARTING", "RUNNING", "CANCELLING"].includes(replay.state)).length >= 10) throw new Error("ReplayLimitExceeded");
      if (Object.values(control.replays).some(replay => replay.archiveName === value.archiveName && ["STARTING", "RUNNING", "CANCELLING"].includes(replay.state))) throw new Error("ArchiveReplayConflict");
      const archive = control.archives[value.archiveName]; if (!archive) throw new Error("ArchiveNotFound");
      const recordIds = archive.records.filter(record => record.eventTime >= value.eventStartTime && record.eventTime <= value.eventEndTime).sort((left, right) => Math.floor(left.eventTime / 60_000) - Math.floor(right.eventTime / 60_000) || left.eventTime - right.eventTime || left.id.localeCompare(right.id)).map(record => record.id);
      control.replays[value.name] = { ...clone(value), recordIds, cursor: 0, cancelRequested: false };
      return clone(control.replays[value.name]);
    });
  }

  async leaseReplay(name: string, now: number, leaseMs: number): Promise<EventBridgeReplayMetadata | undefined> {
    return this.mutate(control => {
      const replay = control.replays[name];
      if (!replay || !["STARTING", "RUNNING", "CANCELLING"].includes(replay.state) || replay.leaseUntil && replay.leaseUntil > now) return undefined;
      replay.state = replay.cancelRequested ? "CANCELLING" : "RUNNING"; replay.leaseId = randomUUID(); replay.leaseUntil = now + leaseMs;
      return clone(replay);
    });
  }

  async checkpointReplay(name: string, leaseId: string, eventTime: number, now: number): Promise<EventBridgeReplayMetadata> {
    return this.mutate(control => {
      const replay = control.replays[name]; if (!replay || replay.leaseId !== leaseId) throw new Error("ReplayLeaseLost");
      replay.cursor++; replay.eventLastReplayedTime = eventTime; delete replay.leaseId; delete replay.leaseUntil;
      if (replay.cancelRequested) { replay.state = "CANCELLED"; replay.replayEndTime = now; replay.stateReason = "Replay cancelled; future events were not submitted."; }
      else if (replay.cursor >= replay.recordIds.length) { replay.state = "COMPLETED"; replay.replayEndTime = now; replay.stateReason = "Replay completed."; }
      return clone(replay);
    });
  }

  async finishEmptyReplay(name: string, leaseId: string, now: number): Promise<EventBridgeReplayMetadata> {
    return this.mutate(control => {
      const replay = control.replays[name]; if (!replay || replay.leaseId !== leaseId) throw new Error("ReplayLeaseLost");
      replay.state = replay.cancelRequested ? "CANCELLED" : "COMPLETED"; replay.replayEndTime = now; replay.stateReason = replay.cancelRequested ? "Replay cancelled; future events were not submitted." : "Replay completed."; delete replay.leaseId; delete replay.leaseUntil;
      return clone(replay);
    });
  }

  async requestCancel(name: string): Promise<EventBridgeReplayMetadata> {
    return this.mutate(control => {
      const replay = control.replays[name]; if (!replay) throw new Error("ReplayNotFound");
      if (!["STARTING", "RUNNING"].includes(replay.state)) throw new Error("ReplayNotCancellable");
      replay.cancelRequested = true; replay.state = "CANCELLING"; replay.stateReason = "Cancellation requested; already-submitted events may still be delivered."; replay.leaseUntil = 0;
      return clone(replay);
    });
  }

  async failReplay(name: string, reason: string, now: number): Promise<void> {
    await this.mutate(control => { const replay = control.replays[name]; if (replay) { replay.state = "FAILED"; replay.stateReason = reason.slice(0, 512); replay.replayEndTime = now; delete replay.leaseId; delete replay.leaseUntil; } return undefined; });
  }

  async reconcile(now: number): Promise<void> {
    const deletions: EventBridgeArchiveRecord[] = [];
    await this.mutate(control => {
      const referenced = new Map<string, Set<string>>();
      for (const replay of Object.values(control.replays)) if (["STARTING", "RUNNING", "CANCELLING"].includes(replay.state)) referenced.set(replay.archiveName, new Set([...(referenced.get(replay.archiveName) ?? []), ...replay.recordIds.slice(replay.cursor)]));
      for (const archive of Object.values(control.archives)) {
        if (!archive.retentionDays) continue;
        const retained: EventBridgeArchiveRecord[] = [];
        for (const record of archive.records) (record.eventTime < now - archive.retentionDays * DAY_MS && !referenced.get(archive.name)?.has(record.id) ? deletions : retained).push(record);
        archive.records = retained;
      }
      for (const [name, replay] of Object.entries(control.replays)) if (replay.replayEndTime !== undefined && replay.replayEndTime < now - REPLAY_HISTORY_MS) delete control.replays[name];
      return undefined;
    });
    for (const item of deletions) await unlink(resolve(this.segmentsDirectory, item.segment)).catch(error => { if (!missing(error)) throw error; });
    if (deletions.length) await this.syncDirectory(this.segmentsDirectory);
  }

  private async recoverSegments(): Promise<void> {
    const known = new Set(Object.values(this.control.archives).flatMap(archive => archive.records.map(record => record.segment)));
    let dirty = false;
    for (const archive of Object.values(this.control.archives)) {
      const retained: EventBridgeArchiveRecord[] = [];
      for (const record of archive.records) {
        try { const decoded = await this.readSegment(resolve(this.segmentsDirectory, record.segment)); if (decoded.archiveName !== archive.name || decoded.record.id !== record.id) throw new Error("segment identity mismatch"); retained.push(record); }
        catch (error) { archive.state = "DISABLED"; archive.stateReason = `A committed local archive segment is corrupt or incomplete (${record.segment}).`; await unlink(resolve(this.segmentsDirectory, record.segment)).catch(() => undefined); dirty = true; }
      }
      archive.records = retained;
    }
    for (const name of await readdir(this.segmentsDirectory)) {
      if (name.includes(".tmp-")) { await unlink(resolve(this.segmentsDirectory, name)).catch(() => undefined); continue; }
      if (!name.endsWith(".seg") || known.has(name)) continue;
      try {
        const decoded = await this.readSegment(resolve(this.segmentsDirectory, name)); const archive = this.control.archives[decoded.archiveName];
        if (archive && !archive.records.some(record => record.id === decoded.record.id)) { archive.records.push(decoded.record); dirty = true; }
        else if (!archive) await unlink(resolve(this.segmentsDirectory, name));
      } catch { await unlink(resolve(this.segmentsDirectory, name)).catch(() => undefined); }
    }
    if (dirty) await this.persist(this.control);
  }

  private async publishSegment(name: string, value: SegmentPlaintext): Promise<void> {
    const envelope = this.encrypt(JSON.stringify(value), name);
    const finalPath = resolve(this.segmentsDirectory, name); const temporary = `${finalPath}.tmp-${randomUUID()}`; const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(envelope)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, finalPath); await this.syncDirectory(this.segmentsDirectory);
  }

  private async readSegment(path: string): Promise<SegmentPlaintext> {
    const envelope = JSON.parse(await readFile(path, "utf8")) as EncryptedEnvelope;
    const decoded = JSON.parse(this.decrypt(envelope, basename(path))) as SegmentPlaintext;
    if (decoded.version !== 1 || !decoded.archiveName || !decoded.record || !decoded.envelope) throw new Error("malformed segment");
    return decoded;
  }

  private async mutate<T>(work: (control: ArchiveControl) => T): Promise<T> {
    return this.enqueue(async () => { const next = clone(this.control); const result = work(next); await this.persist(next); this.control = next; return result; });
  }

  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.serial.catch(() => undefined).then(work); this.serial = operation.then(() => undefined, () => undefined); return operation;
  }

  private async persist(value: ArchiveControl): Promise<void> {
    await mkdir(dirname(this.controlFile), { recursive: true, mode: 0o700 }); const temporary = `${this.controlFile}.tmp-${randomUUID()}`; const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(this.encrypt(JSON.stringify(value), basename(this.controlFile)))); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.controlFile); await this.syncDirectory(dirname(this.controlFile));
  }

  private encrypt(plaintext: string, aad: string): EncryptedEnvelope {
    const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce); cipher.setAAD(Buffer.from(aad)); const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { version: 1, algorithm: "aes-256-gcm", nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64") };
  }

  private decrypt(envelope: EncryptedEnvelope, aad: string): string {
    if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("unsupported encrypted data format"); const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(envelope.nonce, "base64url")); decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(envelope.tag, "base64url")); return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }

  private async syncDirectory(path: string): Promise<void> {
    try {
      const handle = await open(path, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      // Windows and some file-system drivers cannot open or fsync directories.
      // The individual archive files are still fsynced before they are renamed.
      const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
      if (!new Set(["EACCES", "EBADF", "EISDIR", "EINVAL", "ENOSYS", "ENOTSUP", "EPERM"]).has(code ?? "")) throw error;
    }
  }
}
