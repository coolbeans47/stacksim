import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { StateStore } from "../state.js";
import type { ServiceIntegrationAttemptState, SnsMessageAttributeState } from "../types.js";

export interface SnsStoredMessage {
  messageId: string;
  topicArn: string;
  topicGeneration: string;
  timestamp: number;
  message: string;
  protocolMessages?: Record<string, string>;
  subject?: string;
  messageAttributes: Record<string, SnsMessageAttributeState>;
  messageGroupId?: string;
  sizeBytes: number;
  lineage: string[];
  retainUntil: number;
}

export type SnsDeliveryStatus =
  | "QUEUED"
  | "LEASED"
  | "DELIVERED"
  | "FAILED"
  | "FILTERED"
  | "REDRIVE_QUEUED"
  | "REDRIVE_LEASED"
  | "REDRIVEN"
  | "REDRIVE_FAILED";

export interface SnsDeliveryIntent {
  deliveryId: string;
  messageId: string;
  subscriptionArn: string;
  subscriptionGeneration: string;
  protocol: "sqs" | "lambda";
  endpoint: string;
  topicName: string;
  signatureVersion: "1" | "2";
  rawMessageDelivery: boolean;
  filterRevision: number;
  deliveryRevision: number;
  deadLetterTargetArn?: string;
  successFeedbackRoleArn?: string;
  successFeedbackSampleRate: number;
  failureFeedbackRoleArn?: string;
  status: SnsDeliveryStatus;
  attempts: number;
  redriveAttempts: number;
  nextAttemptAt: number;
  leaseId?: string;
  leaseUntil?: number;
  completedAt?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface SnsDeliveryData {
  schemaVersion: 3;
  generation: number;
  messages: Record<string, SnsStoredMessage>;
  deliveries: Record<string, SnsDeliveryIntent>;
  integrationAttempts: Record<string, ServiceIntegrationAttemptState>;
}

interface EncryptedEnvelope {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

function missing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

/**
 * One encrypted, atomically replaced regional SNS delivery snapshot. Control
 * descriptors remain in state.json; message content and attempts never do.
 */
export class SnsDeliveryStorage {
  readonly root: string;
  readonly file: string;
  private data?: SnsDeliveryData;
  private serial = Promise.resolve();

  constructor(private readonly store: StateStore, private readonly region: string) {
    this.root = resolve(store.root, "data", "sns", store.accountId, region);
    this.file = resolve(this.root, "deliveries.enc");
  }

  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.lock(async () => {
      if (this.data) return;
      try {
        const envelope = JSON.parse(await readFile(this.file, "utf8")) as EncryptedEnvelope;
        const loaded = this.decrypt(envelope);
        const migrated = this.migrate(loaded as any);
        this.data = migrated;
        if ((loaded as any).schemaVersion !== 3) await this.save();
      } catch (error) {
        if (!missing(error)) throw error;
        this.data = { schemaVersion: 3, generation: 0, messages: {}, deliveries: {}, integrationAttempts: {} };
        await this.save();
      }
    });
  }

  async stop(): Promise<void> {
    await this.serial.catch(() => undefined);
  }

  async snapshot(): Promise<SnsDeliveryData> {
    return this.lock(async () => structuredClone(this.requireData()));
  }

  async mutate<T>(work: (data: SnsDeliveryData) => T | Promise<T>): Promise<T> {
    return this.lock(async () => {
      const previous = this.requireData();
      const next = structuredClone(previous);
      const result = await work(next);
      next.generation++;
      this.data = next;
      try { await this.save(); }
      catch (error) { this.data = previous; throw error; }
      return result;
    });
  }

  private requireData(): SnsDeliveryData {
    if (!this.data) throw new Error("SNS delivery storage is not started");
    return this.data;
  }

  private async lock<T>(work: () => Promise<T>): Promise<T> {
    const running = this.serial.catch(() => undefined).then(work);
    this.serial = running.then(() => undefined, () => undefined);
    return running;
  }

  private key(): Buffer {
    const value = Buffer.from(this.store.state.installation.snsEncryptionKey, "base64");
    if (value.length !== 32) throw new Error("SNS encryption key must contain 32 bytes");
    return value;
  }

  private aad(): Buffer {
    // Persisted envelope domain. Keep the legacy value so pre-rename deliveries remain decryptable.
    return Buffer.from(`stacksim:sns:deliveries:${this.store.accountId}:${this.region}:v1`);
  }

  private encrypt(value: SnsDeliveryData): EncryptedEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(this.aad());
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  private decrypt(envelope: EncryptedEnvelope): SnsDeliveryData {
    if (envelope.v !== 1) throw new Error("Unsupported SNS encrypted delivery envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(this.aad());
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
  }

  private migrate(value: any): SnsDeliveryData {
    if (value?.schemaVersion === 3) return value as SnsDeliveryData;
    if (![1, 2].includes(value?.schemaVersion) || !value.messages || !value.deliveries) {
      throw new Error(`Unsupported SNS delivery schema ${String(value?.schemaVersion)}`);
    }
    const deliveries: Record<string, SnsDeliveryIntent> = {};
    for (const [id, delivery] of Object.entries(value.deliveries as Record<string, any>)) {
      deliveries[id] = {
        ...delivery,
        topicName: String(value.messages[delivery.messageId]?.topicArn ?? "").slice(String(value.messages[delivery.messageId]?.topicArn ?? "").lastIndexOf(":") + 1),
        signatureVersion: "1",
        rawMessageDelivery: false,
        filterRevision: 1,
        deliveryRevision: 1,
        redriveAttempts: 0,
        successFeedbackSampleRate: 0,
      };
    }
    return {
      schemaVersion: 3,
      generation: Number(value.generation ?? 0) + 1,
      messages: value.messages,
      deliveries,
      integrationAttempts: value.integrationAttempts ?? {},
    };
  }

  private async save(): Promise<void> {
    const temporary = `${this.file}.${process.pid}.${createHash("sha256").update(String(this.requireData().generation)).digest("hex").slice(0, 12)}.tmp`;
    await writeFile(temporary, JSON.stringify(this.encrypt(this.requireData())), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.file);
  }
}
