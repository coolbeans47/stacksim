import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { StateStore } from "../state.js";
import type { ServiceIntegrationAttemptState } from "../types.js";
import type { SqsMessageAttributeValue } from "./md5.js";

export interface SqsStoredMessagePayload {
  body: string;
  messageAttributes: Record<string, SqsMessageAttributeValue>;
  messageSystemAttributes: Record<string, SqsMessageAttributeValue>;
}

export interface SqsStoredMessage {
  messageId: string;
  blobId: string;
  md5OfBody: string;
  md5OfMessageAttributes?: string;
  md5OfMessageSystemAttributes?: string;
  sentAt: number;
  availableAt: number;
  retentionUntil: number;
  receiveCount: number;
  receiptVersion: number;
  firstReceivedAt?: number;
  currentReceiptHandle?: string;
  invisibleUntil?: number;
  deadLetteredAt?: number;
  transferId?: string;
  messageGroupId?: string;
  messageDeduplicationId?: string;
  sequenceNumber?: string;
  leaseMutationVersion?: number;
  /** Truthful public SSE-SQS state when this message was accepted; local AEAD remains private and always on. */
  sqsManagedSse?: boolean;
  /** Internal recursive-delivery lineage; never materialized as a public SQS attribute. */
  deliveryLineage?: string[];
}

export interface SqsDeduplicationRecord {
  expiresAt: number;
  messageId: string;
  sequenceNumber: string;
}

export interface SqsReceiveAttemptRecord {
  expiresAt: number;
  messages: Array<{ messageId: string; receiptHandle: string; leaseMutationVersion: number }>;
}

export interface SqsQueueData {
  schemaVersion: 1;
  queueArn: string;
  generation: number;
  messages: Record<string, SqsStoredMessage>;
  deduplication?: Record<string, SqsDeduplicationRecord>;
  receiveAttempts?: Record<string, SqsReceiveAttemptRecord>;
  nextSequenceNumber?: string;
  fairGroupCursor?: string;
  integrationAttempts?: Record<string, ServiceIntegrationAttemptState>;
}

interface EncryptedEnvelope {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

interface MoveRecord {
  id: string;
  stage: "prepared" | "committed";
  sourceArn: string;
  destinationArn: string;
  message?: SqsStoredMessage;
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Durable SQS message storage. Queue snapshots and payloads are AES-256-GCM
 * encrypted, journals tolerate a truncated final record, and all queue
 * mutations share one promise lock so receipt leases cannot race.
 */
export class SqsStorage {
  readonly root: string;
  private readonly blobsRoot: string;
  private readonly cache = new Map<string, SqsQueueData>();
  private serial = Promise.resolve();
  private started = false;

  constructor(private readonly store: StateStore) {
    this.root = resolve(store.root, "data", "sqs", "queues");
    this.blobsRoot = resolve(this.root, "blobs");
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.encryptionKey();
    await mkdir(this.blobsRoot, { recursive: true, mode: 0o700 });
    await this.lock(async () => { await this.recoverMoves(); await this.sweepOrphanPayloads(); });
    this.started = true;
  }

  async stop(): Promise<void> {
    await this.serial.catch(() => undefined);
  }

  async createQueue(queueArn: string, reset = false): Promise<void> {
    await this.lock(async () => {
      const current = await this.loadQueue(queueArn);
      if (!reset && current.generation > 0) return;
      await this.saveQueue({ schemaVersion: 1, queueArn, generation: current.generation, messages: {}, ...(current.integrationAttempts && Object.keys(current.integrationAttempts).length ? { integrationAttempts: current.integrationAttempts } : {}) });
    });
  }

  async deleteQueue(queueArn: string): Promise<void> {
    await this.lock(async () => {
      const queue = structuredClone(await this.loadQueue(queueArn));
      const payloads = Object.values(queue.messages).map(message => message.blobId);
      queue.messages = {};
      await this.saveQueue(queue);
      await this.deletePayloads(payloads);
    });
  }

  async purgeQueue(queueArn: string): Promise<void> {
    await this.deleteQueue(queueArn);
  }

  async readQueue(queueArn: string): Promise<SqsQueueData> {
    return this.lock(async () => structuredClone(await this.loadQueue(queueArn)));
  }

  async mutateQueue<T>(queueArn: string, mutate: (queue: SqsQueueData) => T | Promise<T>): Promise<T> {
    return this.lock(async () => {
      const previous = await this.loadQueue(queueArn);
      const queue = structuredClone(previous);
      const result = await mutate(queue);
      await this.saveQueue(queue);
      const retained = new Set(Object.values(queue.messages).map(message => message.blobId));
      await this.deletePayloads(Object.values(previous.messages).map(message => message.blobId).filter(blobId => !retained.has(blobId)));
      return result;
    });
  }

  async putPayload(messageId: string, payload: SqsStoredMessagePayload): Promise<string> {
    const blobId = `${messageId}-${randomUUID()}`;
    const path = this.blobPath(blobId);
    await mkdir(resolve(this.blobsRoot, blobId.slice(0, 2)), { recursive: true, mode: 0o700 });
    await this.atomicWrite(path, JSON.stringify(this.encrypt(payload, `sqs:blob:${blobId}`)));
    return blobId;
  }

  async discardPayload(blobId: string): Promise<void> {
    await this.deletePayloads([blobId]);
  }

  async readPayload(blobId: string): Promise<SqsStoredMessagePayload> {
    const encoded = JSON.parse(await readFile(this.blobPath(blobId), "utf8")) as EncryptedEnvelope;
    return this.decrypt<SqsStoredMessagePayload>(encoded, `sqs:blob:${blobId}`);
  }

  /**
   * Moves one message with a durable intent. Recovery idempotently completes a
   * prepared move before the service begins accepting requests.
   */
  async moveMessage(
    sourceArn: string,
    destinationArn: string,
    messageId: string,
    transform: (message: SqsStoredMessage, transferId: string, destination: SqsQueueData) => SqsStoredMessage,
  ): Promise<boolean> {
    return this.lock(async () => {
      const source = structuredClone(await this.loadQueue(sourceArn));
      const current = source.messages[messageId];
      if (!current) return false;
      const transferId = randomUUID();
      const destination = structuredClone(await this.loadQueue(destinationArn));
      const moved = transform(structuredClone(current), transferId, destination);
      const prepared: MoveRecord = { id: transferId, stage: "prepared", sourceArn, destinationArn, message: moved };
      await this.appendMove(prepared);

      const alreadyMoved = Object.values(destination.messages).some(message => message.transferId === transferId);
      if (!alreadyMoved) destination.messages[moved.messageId] = moved;
      await this.saveQueue(destination);

      delete source.messages[messageId];
      await this.saveQueue(source);
      await this.appendMove({ id: transferId, stage: "committed", sourceArn, destinationArn });
      return true;
    });
  }

  private async lock<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.serial.catch(() => undefined).then(operation);
    this.serial = running.then(() => undefined, () => undefined);
    return running;
  }

  private emptyQueue(queueArn: string): SqsQueueData {
    return { schemaVersion: 1, queueArn, generation: 0, messages: {}, deduplication: {}, receiveAttempts: {}, nextSequenceNumber: "1" };
  }

  private queueStem(queueArn: string): string {
    return createHash("sha256").update(queueArn).digest("hex");
  }

  private queueJournal(queueArn: string): string {
    return resolve(this.root, `${this.queueStem(queueArn)}.journal`);
  }

  private queueIndex(queueArn: string): string {
    return resolve(this.root, `${this.queueStem(queueArn)}.index`);
  }

  private blobPath(blobId: string): string {
    return resolve(this.blobsRoot, blobId.slice(0, 2), blobId.slice(2));
  }

  private async loadQueue(queueArn: string): Promise<SqsQueueData> {
    const cached = this.cache.get(queueArn);
    if (cached) return cached;
    const aad = `sqs:queue:${queueArn}`;
    let loaded: SqsQueueData | undefined;
    try {
      const journal = await readFile(this.queueJournal(queueArn), "utf8");
      for (const line of journal.split("\n")) {
        if (!line.trim()) continue;
        try {
          const candidate = this.decrypt<SqsQueueData>(JSON.parse(line), aad);
          if (candidate.schemaVersion === 1 && candidate.queueArn === queueArn && candidate.generation >= (loaded?.generation ?? -1)) loaded = candidate;
        } catch {
          // A crash can truncate the final append; the preceding valid record wins.
        }
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (!loaded) {
      try {
        const encoded = JSON.parse(await readFile(this.queueIndex(queueArn), "utf8"));
        const candidate = this.decrypt<SqsQueueData>(encoded, aad);
        if (candidate.schemaVersion === 1 && candidate.queueArn === queueArn) loaded = candidate;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    loaded ??= this.emptyQueue(queueArn);
    loaded.deduplication ??= {};
    loaded.receiveAttempts ??= {};
    loaded.nextSequenceNumber ??= "1";
    loaded.integrationAttempts ??= {};
    for (const message of Object.values(loaded.messages)) {
      if (!message.sequenceNumber) continue;
      try {
        const following = BigInt(message.sequenceNumber) + 1n;
        if (following > BigInt(loaded.nextSequenceNumber)) loaded.nextSequenceNumber = following.toString();
      } catch { /* Ignore legacy/corrupt optional sequence metadata here. */ }
    }
    this.cache.set(queueArn, loaded);
    return loaded;
  }

  private async saveQueue(queue: SqsQueueData): Promise<void> {
    queue.generation += 1;
    const encoded = JSON.stringify(this.encrypt(queue, `sqs:queue:${queue.queueArn}`));
    await this.appendDurable(this.queueJournal(queue.queueArn), `${encoded}\n`);
    await this.atomicWrite(this.queueIndex(queue.queueArn), encoded);
    if (queue.generation % 64 === 0) await this.atomicWrite(this.queueJournal(queue.queueArn), `${encoded}\n`);
    this.cache.set(queue.queueArn, queue);
  }

  private async deletePayloads(blobIds: string[]): Promise<void> {
    await Promise.all([...new Set(blobIds)].map(async blobId => {
      try { await unlink(this.blobPath(blobId)); }
      catch (error) { if (!isMissing(error)) throw error; }
    }));
  }

  private async recoverMoves(): Promise<void> {
    const records = await this.readMoves();
    const pending = new Map<string, MoveRecord>();
    for (const record of records) {
      if (record.stage === "prepared") pending.set(record.id, record);
      else pending.delete(record.id);
    }
    for (const record of pending.values()) {
      if (!record.message) continue;
      const source = structuredClone(await this.loadQueue(record.sourceArn));
      const destination = structuredClone(await this.loadQueue(record.destinationArn));
      const exists = Object.values(destination.messages).some(message => message.transferId === record.id);
      if (!exists) {
        destination.messages[record.message.messageId] = record.message;
        await this.saveQueue(destination);
      }
      if (source.messages[record.message.messageId]) {
        delete source.messages[record.message.messageId];
        await this.saveQueue(source);
      }
      await this.appendMove({ id: record.id, stage: "committed", sourceArn: record.sourceArn, destinationArn: record.destinationArn });
    }
  }

  private async sweepOrphanPayloads(): Promise<void> {
    const reachable = new Set<string>();
    for (const account of Object.values(this.store.state.accounts)) for (const region of Object.values(account.regions)) {
      for (const queue of Object.values(region.sqsQueues ?? {})) {
        const data = await this.loadQueue(queue.queueArn);
        for (const message of Object.values(data.messages)) reachable.add(message.blobId);
      }
    }
    let shards;
    try { shards = await readdir(this.blobsRoot, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return; throw error; }
    for (const shard of shards) {
      if (!shard.isDirectory()) continue;
      const directory = resolve(this.blobsRoot, shard.name);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const blobId = `${shard.name}${entry.name}`;
        if (!reachable.has(blobId)) await unlink(resolve(directory, entry.name)).catch(error => { if (!isMissing(error)) throw error; });
      }
    }
  }

  private async readMoves(): Promise<MoveRecord[]> {
    try {
      const text = await readFile(resolve(this.root, "moves.journal"), "utf8");
      const records: MoveRecord[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try { records.push(this.decrypt<MoveRecord>(JSON.parse(line), "sqs:moves")); } catch { /* tolerate a torn tail */ }
      }
      return records;
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async appendMove(record: MoveRecord): Promise<void> {
    await this.appendDurable(resolve(this.root, "moves.journal"), `${JSON.stringify(this.encrypt(record, "sqs:moves"))}\n`);
  }

  private async appendDurable(path: string, value: string): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async atomicWrite(path: string, value: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  }

  private encrypt(value: unknown, aad: string): EncryptedEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  private decrypt<T>(envelope: EncryptedEnvelope, aad: string): T {
    if (envelope?.v !== 1) throw new Error("Unsupported SQS storage record");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey(), Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const value = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
    return JSON.parse(value) as T;
  }

  private encryptionKey(): Buffer {
    const key = Buffer.from(this.store.state.installation.sqsEncryptionKey ?? "", "base64");
    if (key.length !== 32) throw new Error("The SQS encryption key must contain exactly 32 bytes");
    return key;
  }
}
