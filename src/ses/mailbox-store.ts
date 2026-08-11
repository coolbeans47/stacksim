import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  PreparedAttachment,
  PreparedHeader,
  PreparedOutboxRecord,
  PreparedRecipient,
  PreparedSesMessage,
  SesApiFamily,
  SesLocalDisposition,
  SesRenderStatus,
} from "./model.js";
import {
  SES_MAX_MAILBOX_ADDRESS_BYTES,
  normalizeMailboxKey,
  parseMailboxAddress,
  validatePositiveSafeInteger,
  validatePreparedMessage,
} from "./validation.js";

export const DEFAULT_MAXIMUM_MAILBOX_MESSAGES = 10_000;
export const DEFAULT_MAXIMUM_MAILBOX_BYTES = 1024 * 1024 * 1024;
const MAILBOX_SCHEMA_VERSION = 2;

export type MailboxStatus = "all" | "unread" | "trash";

export interface MailboxStoreOptions {
  root: string;
  accountId: string;
  region: string;
  maximumMessages?: number;
  maximumBytes?: number;
}

export interface MailboxQuotaWindow {
  windowMs: number;
  maximumRecipients: number;
}

export interface MailboxCaptureOptions {
  /** Defaults to the count of authoritative envelope-recipient occurrences. */
  recipientOccurrences?: number;
  quotaWindows?: MailboxQuotaWindow[];
  auditEventType?: string;
  /** Must be body-free and redacted by the caller. */
  auditDetail?: Record<string, unknown>;
  outbox?: PreparedOutboxRecord[];
  producer?: {
    originService: string;
    deliveryKey: string;
    contentMac: Uint8Array;
  };
}

export interface MailboxCaptureResult {
  captureId: string;
  messageId: string;
  inserted: boolean;
  logicalBytes: number;
}

export interface MailboxBatchCaptureItem {
  message: PreparedSesMessage;
  options?: MailboxCaptureOptions;
}

export interface MailboxOutboxItem extends PreparedOutboxRecord {
  captureId: string;
  attempts: number;
}

export interface MailboxUsage {
  messageCount: number;
  logicalBytes: number;
  purgeGeneration: number;
}

export interface MailboxKey {
  acceptedAt: number;
  captureId: string;
}

export interface MailboxListOptions {
  recipient?: string;
  originService?: string;
  status?: MailboxStatus;
  pageSize?: number;
  /** Fixed by the first page and carried by the caller's signed token. */
  highWater?: MailboxKey;
  /** Last returned key from the preceding page. */
  after?: MailboxKey;
}

export interface MailboxMessageSummary {
  captureId: string;
  messageId: string;
  acceptedAt: number;
  apiFamily: SesApiFamily;
  operation: string;
  source: string;
  subject?: string;
  preview: string;
  envelopeRecipients: string[];
  attachmentCount: number;
  unread: boolean;
  deleted: boolean;
  renderStatus: SesRenderStatus;
  localDisposition: SesLocalDisposition;
  configurationSetName?: string;
  templateName?: string;
}

export interface MailboxListPage {
  messages: MailboxMessageSummary[];
  highWater?: MailboxKey;
  next?: MailboxKey;
  purgeGeneration: number;
}

export interface MailboxAttachmentMetadata {
  attachmentId: string;
  ordinal: number;
  filename?: string;
  contentType: string;
  disposition?: string;
  contentId?: string;
  byteLength: number;
}

export interface MailboxMessageDetail {
  captureId: string;
  messageId: string;
  verificationIntentId?: string;
  acceptedAt: number;
  apiFamily: SesApiFamily;
  operation: string;
  originService?: string;
  source: string;
  returnPath?: string;
  replyTo: string[];
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  headers: PreparedHeader[];
  configurationSetName?: string;
  messageTags: Record<string, string>;
  templateName?: string;
  tenantName?: string;
  renderStatus: SesRenderStatus;
  localDisposition: SesLocalDisposition;
  outcomeCode?: string;
  outcomeDetail: Record<string, string>;
  logicalBytes: number;
  readAt?: number;
  deletedAt?: number;
  recipients: PreparedRecipient[];
  attachments: MailboxAttachmentMetadata[];
  hasOriginalRaw: boolean;
  hasNormalizedRaw: boolean;
  /** True when a display body was bounded; raw downloads retain exact bytes. */
  truncated?: boolean;
}

export interface MailboxRecipientSuggestion {
  address: string;
  messageCount: number;
}

export type MailboxPurgeRequest =
  | { messageIds: string[]; allTrash?: never }
  | { allTrash: true; messageIds?: never };

export interface MailboxPurgeResult {
  purged: number;
  releasedLogicalBytes: number;
  purgeGeneration: number;
}

export class MailboxError extends Error {
  constructor(
    public readonly code: "Closed" | "CapacityExceeded" | "QuotaExceeded" | "Conflict" | "Duplicate" | "IdempotencyMismatch" | "StorageFailure" | "InvalidInput",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MailboxError";
  }
}

function integer(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  return Number(value ?? 0);
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

const MAX_DISPLAY_PART_BYTES = 2 * 1024 * 1024;

function boundedDisplayPart(value: string | undefined): { value?: string; truncated: boolean } {
  if (value === undefined) return { truncated: false };
  if (Buffer.byteLength(value, "utf8") <= MAX_DISPLAY_PART_BYTES) return { value, truncated: false };
  const output: string[] = [];
  let bytes = 0;
  for (const scalar of value) {
    const scalarBytes = Buffer.byteLength(scalar, "utf8");
    if (bytes + scalarBytes > MAX_DISPLAY_PART_BYTES) break;
    output.push(scalar);
    bytes += scalarBytes;
  }
  return { value: output.join(""), truncated: true };
}

function jsonObject<T extends object>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : fallback;
  } catch { return fallback; }
}

function jsonArray<T>(value: unknown): T[] {
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed as T[] : []; }
  catch { return []; }
}

function captureIdFor(message: PreparedSesMessage): string {
  return createHash("sha256")
    .update(`${message.accountId}\0${message.region}\0${message.messageId}`)
    .digest("base64url")
    .slice(0, 32);
}

export function calculateLogicalBytes(message: PreparedSesMessage): number {
  const byteLength = (value: string | undefined): number => value === undefined ? 0 : Buffer.byteLength(value, "utf8");
  return (message.originalRaw?.byteLength ?? 0)
    + (message.normalizedRaw?.byteLength ?? 0)
    + byteLength(message.textBody)
    + byteLength(message.htmlBody)
    + Buffer.byteLength(JSON.stringify(message.headers), "utf8")
    + Buffer.byteLength(JSON.stringify(message.outcomeDetail ?? {}), "utf8")
    + message.attachments.reduce((total, attachment) => total + attachment.content.byteLength, 0);
}

function validateStoreIdentity(accountId: string, region: string): void {
  if (!/^\d{12}$/.test(accountId)) throw new MailboxError("InvalidInput", "The SES mailbox account ID must contain 12 digits.");
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region)) throw new MailboxError("InvalidInput", "The SES mailbox Region is invalid.");
}

/**
 * Private per-account/per-Region SQLite mailbox. All mutations are synchronous
 * inside one BEGIN IMMEDIATE transaction, which keeps the caller from returning
 * a MessageId before its message, quota event, usage and outbox are committed.
 */
export class MailboxStore {
  private transactionDepth = 0;
  readonly file: string;
  readonly maximumMessages: number;
  readonly maximumBytes: number;
  private database?: DatabaseSync;

  constructor(readonly options: MailboxStoreOptions) {
    validateStoreIdentity(options.accountId, options.region);
    this.maximumMessages = validatePositiveSafeInteger(options.maximumMessages ?? DEFAULT_MAXIMUM_MAILBOX_MESSAGES, "maximumMessages");
    this.maximumBytes = validatePositiveSafeInteger(options.maximumBytes ?? DEFAULT_MAXIMUM_MAILBOX_BYTES, "maximumBytes");
    this.file = resolve(options.root, "data", "ses", options.accountId, options.region, "mailbox.sqlite");
  }

  async start(): Promise<void> {
    if (this.database) return;
    const directory = resolve(this.options.root, "data", "ses", this.options.accountId, this.options.region);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { chmodSync(directory, 0o700); } catch { /* Best effort on platforms without POSIX permissions. */ }
    const created = !existsSync(this.file);
    const database = new DatabaseSync(this.file);
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA busy_timeout = 5000");
      if (created) database.exec("PRAGMA auto_vacuum = INCREMENTAL");
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = FULL");
      database.exec("PRAGMA wal_autocheckpoint = 1000");
      this.database = database;
      this.migrate();
      this.rebuildUsage();
      try { chmodSync(this.file, 0o600); } catch { /* Best effort on Windows. */ }
    } catch (error) {
      this.database = undefined;
      try { database.close(); } catch {}
      throw new MailboxError("StorageFailure", "The SES mailbox could not be opened.", { cause: error });
    }
  }

  private db(): DatabaseSync {
    if (!this.database) throw new MailboxError("Closed", "The SES mailbox is not open.");
    return this.database;
  }

  private migrate(): void {
    const database = this.db();
    const version = integer((database.prepare("PRAGMA user_version").get() as any)?.user_version);
    if (version > MAILBOX_SCHEMA_VERSION) throw new Error(`SES mailbox schema ${version} is newer than supported schema ${MAILBOX_SCHEMA_VERSION}.`);
    if (version === 0) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(`
          CREATE TABLE IF NOT EXISTS messages (
            capture_id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL UNIQUE,
            verification_intent_id TEXT UNIQUE,
            accepted_at INTEGER NOT NULL,
            api_family TEXT NOT NULL,
            operation TEXT NOT NULL,
            origin_service TEXT,
            source_address TEXT NOT NULL,
            return_path TEXT,
            reply_to_json TEXT NOT NULL,
            subject TEXT,
            text_body TEXT,
            html_body TEXT,
            headers_json TEXT NOT NULL,
            configuration_set_name TEXT,
            message_tags_json TEXT NOT NULL,
            template_name TEXT,
            tenant_name TEXT,
            original_raw BLOB,
            normalized_raw BLOB,
            render_status TEXT NOT NULL CHECK (render_status IN ('RENDERED', 'FAILED')),
            local_disposition TEXT NOT NULL CHECK (local_disposition IN ('CAPTURED', 'SUPPRESSED', 'NOT_ATTEMPTED')),
            outcome_code TEXT,
            outcome_detail_json TEXT NOT NULL,
            logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0),
            read_at INTEGER,
            deleted_at INTEGER,
            CHECK (
              (render_status = 'RENDERED' AND local_disposition IN ('CAPTURED', 'SUPPRESSED') AND normalized_raw IS NOT NULL)
              OR
              (render_status = 'FAILED' AND local_disposition = 'NOT_ATTEMPTED' AND normalized_raw IS NULL)
            )
          );

          CREATE TABLE IF NOT EXISTS recipients (
            capture_id TEXT NOT NULL REFERENCES messages(capture_id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            header_kind TEXT CHECK (header_kind IN ('TO', 'CC', 'BCC')),
            is_envelope INTEGER NOT NULL CHECK (is_envelope IN (0, 1)),
            origin TEXT NOT NULL CHECK (origin IN ('API_DESTINATION', 'RAW_HEADER', 'RAW_EXPLICIT_ENVELOPE', 'RAW_DERIVED_ENVELOPE')),
            address_original TEXT NOT NULL,
            address_normalized TEXT NOT NULL,
            accepted_at INTEGER NOT NULL,
            CHECK (header_kind IS NOT NULL OR is_envelope = 1),
            PRIMARY KEY (capture_id, ordinal)
          );

          CREATE TABLE IF NOT EXISTS attachments (
            attachment_id TEXT PRIMARY KEY,
            capture_id TEXT NOT NULL REFERENCES messages(capture_id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            filename TEXT,
            content_type TEXT NOT NULL,
            disposition TEXT,
            content_id TEXT,
            byte_length INTEGER NOT NULL,
            content BLOB NOT NULL,
            UNIQUE (capture_id, ordinal)
          );

          CREATE TABLE IF NOT EXISTS capture_audit (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            capture_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            event_at INTEGER NOT NULL,
            detail_json TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS quota_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            capture_id TEXT NOT NULL UNIQUE,
            accepted_at INTEGER NOT NULL,
            recipient_occurrences INTEGER NOT NULL CHECK (recipient_occurrences >= 0)
          );

          CREATE TABLE IF NOT EXISTS mailbox_usage (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            message_count INTEGER NOT NULL CHECK (message_count >= 0),
            logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0),
            purge_generation INTEGER NOT NULL CHECK (purge_generation >= 0)
          );

          CREATE TABLE IF NOT EXISTS event_outbox (
            outbox_id TEXT PRIMARY KEY,
            capture_id TEXT,
            request_id TEXT NOT NULL,
            destination_id TEXT NOT NULL,
            event_ordinal INTEGER NOT NULL CHECK (event_ordinal >= 0),
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('PENDING', 'PUBLISHED', 'DEAD')),
            attempts INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            next_attempt_at INTEGER,
            last_error_code TEXT
          );

          CREATE INDEX IF NOT EXISTS recipients_by_address_time
            ON recipients(address_normalized, accepted_at DESC, capture_id)
            WHERE is_envelope = 1;
          CREATE INDEX IF NOT EXISTS messages_by_time
            ON messages(accepted_at DESC, capture_id DESC);
          CREATE INDEX IF NOT EXISTS messages_by_unread_time
            ON messages(read_at, accepted_at DESC);
          CREATE INDEX IF NOT EXISTS messages_by_deleted_time
            ON messages(deleted_at, accepted_at DESC);
          CREATE INDEX IF NOT EXISTS quota_events_by_time
            ON quota_events(accepted_at, sequence);
          CREATE INDEX IF NOT EXISTS event_outbox_by_status_time
            ON event_outbox(status, next_attempt_at, created_at);
          CREATE INDEX IF NOT EXISTS messages_by_message_id
            ON messages(message_id);

          INSERT OR IGNORE INTO mailbox_usage(singleton, message_count, logical_bytes, purge_generation)
            VALUES (1, 0, 0, 0);
          CREATE TABLE IF NOT EXISTS producer_deliveries (
            origin_service TEXT NOT NULL,
            delivery_key TEXT NOT NULL,
            content_mac BLOB NOT NULL,
            message_id TEXT NOT NULL,
            capture_id TEXT NOT NULL,
            logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0),
            accepted_at INTEGER NOT NULL,
            PRIMARY KEY (origin_service, delivery_key)
          );

          PRAGMA user_version = 2;
        `);
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
      }
    }
    if (version === 1) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(`
          CREATE TABLE IF NOT EXISTS producer_deliveries (
            origin_service TEXT NOT NULL,
            delivery_key TEXT NOT NULL,
            content_mac BLOB NOT NULL,
            message_id TEXT NOT NULL,
            capture_id TEXT NOT NULL,
            logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0),
            accepted_at INTEGER NOT NULL,
            PRIMARY KEY (origin_service, delivery_key)
          );
          PRAGMA user_version = 2;
        `);
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
      }
    }
  }

  private transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    const database = this.db();
    database.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private rebuildUsage(): void {
    const database = this.db();
    const actual = database.prepare("SELECT COUNT(*) AS message_count, COALESCE(SUM(logical_bytes), 0) AS logical_bytes FROM messages").get() as any;
    const stored = database.prepare("SELECT message_count, logical_bytes FROM mailbox_usage WHERE singleton = 1").get() as any;
    if (!stored || integer(stored.message_count) !== integer(actual.message_count) || integer(stored.logical_bytes) !== integer(actual.logical_bytes)) {
      database.prepare(`
        INSERT INTO mailbox_usage(singleton, message_count, logical_bytes, purge_generation)
        VALUES (1, ?, ?, COALESCE((SELECT purge_generation FROM mailbox_usage WHERE singleton = 1), 0))
        ON CONFLICT(singleton) DO UPDATE SET message_count = excluded.message_count, logical_bytes = excluded.logical_bytes
      `).run(integer(actual.message_count), integer(actual.logical_bytes));
    }
  }

  usage(): MailboxUsage {
    const row = this.db().prepare("SELECT message_count, logical_bytes, purge_generation FROM mailbox_usage WHERE singleton = 1").get() as any;
    return {
      messageCount: integer(row?.message_count),
      logicalBytes: integer(row?.logical_bytes),
      purgeGeneration: integer(row?.purge_generation),
    };
  }

  recipientCountSince(since: number): number {
    if (!Number.isSafeInteger(since) || since < 0) throw new MailboxError("InvalidInput", "The quota lower bound is invalid.");
    const row = this.db().prepare("SELECT COALESCE(SUM(recipient_occurrences), 0) AS count FROM quota_events WHERE accepted_at >= ?").get(since) as any;
    return integer(row?.count);
  }

  metricCounts(start: number, end: number): { sends: number; rendered: number; renderingFailures: number; captured: number; suppressed: number; suppressedBounces: number; recipients: number; clicks: number } {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new MailboxError("InvalidInput", "The metric time range is invalid.");
    const row = this.db().prepare(`
      SELECT
        COUNT(*) AS sends,
        COALESCE(SUM(CASE WHEN render_status = 'RENDERED' THEN 1 ELSE 0 END), 0) AS rendered,
        COALESCE(SUM(CASE WHEN render_status = 'FAILED' THEN 1 ELSE 0 END), 0) AS rendering_failures,
        COALESCE(SUM(CASE WHEN local_disposition = 'CAPTURED' THEN 1 ELSE 0 END), 0) AS captured,
        COALESCE(SUM(CASE WHEN local_disposition = 'SUPPRESSED' THEN 1 ELSE 0 END), 0) AS suppressed,
        COALESCE(SUM(CASE WHEN outcome_code = 'SUPPRESSED_BOUNCE' THEN 1 ELSE 0 END), 0) AS suppressed_bounces,
        COALESCE((SELECT SUM(recipient_occurrences) FROM quota_events WHERE accepted_at BETWEEN ? AND ?), 0) AS recipients
      FROM messages WHERE accepted_at BETWEEN ? AND ?
    `).get(start, end, start, end) as any;
    const clicks = this.db().prepare("SELECT COUNT(*) AS count FROM capture_audit WHERE event_type = 'LOCAL_CLICK_CALLBACK' AND event_at BETWEEN ? AND ?").get(start, end) as any;
    return { sends: integer(row.sends), rendered: integer(row.rendered), renderingFailures: integer(row.rendering_failures), captured: integer(row.captured), suppressed: integer(row.suppressed), suppressedBounces: integer(row.suppressed_bounces), recipients: integer(row.recipients), clicks: integer(clicks?.count) };
  }

  localCallbackEvents(messageId: string): Array<{ eventType: string; eventAt: number }> {
    return (this.db().prepare(`
      SELECT event_type, event_at
      FROM capture_audit
      WHERE event_type IN ('LOCAL_CLICK_CALLBACK', 'LOCAL_UNSUBSCRIBE_CALLBACK')
        AND json_extract(detail_json, '$.messageId') = ?
      ORDER BY event_at, sequence
    `).all(messageId) as any[]).map(row => ({ eventType: String(row.event_type), eventAt: integer(row.event_at) }));
  }

  enqueueOutbox(records: readonly PreparedOutboxRecord[]): void {
    if (!records.length) return;
    this.transaction(() => {
      const statement = this.db().prepare(`
        INSERT OR IGNORE INTO event_outbox(
          outbox_id, capture_id, request_id, destination_id, event_ordinal, event_type,
          payload_json, status, attempts, created_at, next_attempt_at, last_error_code
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, NULL)
      `);
      for (const record of records) statement.run(
        record.outboxId, record.requestId, record.destinationId, record.eventOrdinal,
        record.eventType, JSON.stringify(record.payload), record.createdAt,
        record.nextAttemptAt ?? record.createdAt,
      );
    });
  }

  pendingOutbox(now: number, maximum = 100): MailboxOutboxItem[] {
    return (this.db().prepare(`
      SELECT outbox_id, capture_id, request_id, destination_id, event_ordinal,
             event_type, payload_json, attempts, created_at, next_attempt_at
      FROM event_outbox
      WHERE status = 'PENDING' AND next_attempt_at <= ?
      ORDER BY created_at, event_ordinal, outbox_id
      LIMIT ?
    `).all(now, maximum) as any[]).map(row => ({
      outboxId: String(row.outbox_id),
      captureId: String(row.capture_id),
      requestId: String(row.request_id),
      destinationId: String(row.destination_id),
      eventOrdinal: integer(row.event_ordinal),
      eventType: String(row.event_type),
      payload: jsonObject<Record<string, unknown>>(row.payload_json, {}),
      attempts: integer(row.attempts),
      createdAt: integer(row.created_at),
      nextAttemptAt: integer(row.next_attempt_at),
    }));
  }

  completeOutbox(outboxId: string): void {
    this.db().prepare("UPDATE event_outbox SET status = 'DELIVERED', last_error_code = NULL WHERE outbox_id = ?").run(outboxId);
  }

  retryOutbox(outboxId: string, attempts: number, nextAttemptAt: number, errorCode: string): void {
    this.db().prepare(`
      UPDATE event_outbox
      SET attempts = ?, next_attempt_at = ?, last_error_code = ?
      WHERE outbox_id = ? AND status = 'PENDING'
    `).run(attempts, nextAttemptAt, errorCode.slice(0, 128), outboxId);
  }

  /**
   * Record a bounded, body-free audit event for local SES administration.
   * These events intentionally share the durable mailbox audit journal without
   * pretending that the local-only action captured an email.
   */
  recordControlAudit(eventId: string, eventType: string, eventAt: number, detail: Record<string, unknown>): void {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(eventId)) throw new MailboxError("InvalidInput", "The SES control audit ID is invalid.");
    if (!/^LOCAL_[A-Z0-9_]{1,96}$/.test(eventType)) throw new MailboxError("InvalidInput", "The SES control audit event type is invalid.");
    if (!Number.isSafeInteger(eventAt) || eventAt < 0) throw new MailboxError("InvalidInput", "The SES control audit time is invalid.");
    const serialized = JSON.stringify(detail);
    if (Buffer.byteLength(serialized, "utf8") > 4_096) throw new MailboxError("InvalidInput", "The SES control audit detail is too large.");
    try {
      this.transaction(() => {
        const database = this.db();
        database.prepare(`
          INSERT INTO capture_audit(capture_id, event_type, event_at, detail_json)
          VALUES (?, ?, ?, ?)
        `).run(`control:${eventId}`, eventType, eventAt, serialized);
        database.prepare(`
          DELETE FROM capture_audit
          WHERE sequence IN (
            SELECT sequence FROM capture_audit
            WHERE event_type LIKE 'LOCAL_%'
            ORDER BY sequence DESC
            LIMIT -1 OFFSET 256
          )
        `).run();
      });
    } catch (error) {
      if (error instanceof MailboxError) throw error;
      throw new MailboxError("StorageFailure", "The SES control audit could not be recorded.", { cause: error });
    }
  }

  /**
   * Reserve no state, but take the same immediate SQLite lock and apply the
   * same validation/capacity/quota checks as capture. The SES verification
   * state machine uses this before persisting PENDING_CAPTURE so a request
   * that is already known to be too large never creates a control record.
   */
  preflightCapture(message: PreparedSesMessage, options: MailboxCaptureOptions = {}): MailboxCaptureResult {
    validatePreparedMessage(message);
    if (message.accountId !== this.options.accountId || message.region !== this.options.region) {
      throw new MailboxError("InvalidInput", "The prepared message belongs to a different account or Region.");
    }
    const recipientOccurrences = options.recipientOccurrences
      ?? message.recipients.filter(recipient => recipient.isEnvelope).length;
    if (!Number.isSafeInteger(recipientOccurrences) || recipientOccurrences < 0) {
      throw new MailboxError("InvalidInput", "The quota recipient occurrence count is invalid.");
    }
    for (const window of options.quotaWindows ?? []) {
      validatePositiveSafeInteger(window.windowMs, "quota windowMs");
      validatePositiveSafeInteger(window.maximumRecipients, "quota maximumRecipients");
    }
    const captureId = captureIdFor(message);
    const logicalBytes = calculateLogicalBytes(message);
    this.validateProducer(options.producer);
    try {
      return this.transaction(() => {
        const database = this.db();
        const producerReplay = this.producerReplay(database, options.producer);
        if (producerReplay) return producerReplay;
        if (message.verificationIntentId) {
          const existing = database.prepare(`
            SELECT capture_id, message_id, logical_bytes
            FROM messages WHERE verification_intent_id = ?
          `).get(message.verificationIntentId) as any;
          if (existing) {
            if (String(existing.message_id) !== message.messageId) {
              throw new MailboxError("Duplicate", "The verification intent is already bound to another SES message.");
            }
            return {
              captureId: String(existing.capture_id),
              messageId: String(existing.message_id),
              inserted: false,
              logicalBytes: integer(existing.logical_bytes),
            };
          }
        }
        if (database.prepare("SELECT capture_id FROM messages WHERE message_id = ?").get(message.messageId)) {
          throw new MailboxError("Duplicate", "The SES message ID already exists in this mailbox.");
        }
        const usage = this.usage();
        if (usage.messageCount + 1 > this.maximumMessages || usage.logicalBytes + logicalBytes > this.maximumBytes) {
          throw new MailboxError("CapacityExceeded", "The SES mailbox has reached its configured logical capacity.");
        }
        for (const window of options.quotaWindows ?? []) {
          const used = this.recipientCountSince(Math.max(0, message.acceptedAt - window.windowMs));
          if (used + recipientOccurrences > window.maximumRecipients) {
            throw new MailboxError("QuotaExceeded", "The SES recipient quota would be exceeded.");
          }
        }
        return { captureId, messageId: message.messageId, inserted: true, logicalBytes };
      });
    } catch (error) {
      if (error instanceof MailboxError) throw error;
      throw new MailboxError("StorageFailure", "The SES mailbox preflight transaction failed.", { cause: error });
    }
  }

  capture(message: PreparedSesMessage, options: MailboxCaptureOptions = {}): MailboxCaptureResult {
    validatePreparedMessage(message);
    if (message.accountId !== this.options.accountId || message.region !== this.options.region) {
      throw new MailboxError("InvalidInput", "The prepared message belongs to a different account or Region.");
    }
    const recipientOccurrences = options.recipientOccurrences
      ?? message.recipients.filter(recipient => recipient.isEnvelope).length;
    if (!Number.isSafeInteger(recipientOccurrences) || recipientOccurrences < 0) {
      throw new MailboxError("InvalidInput", "The quota recipient occurrence count is invalid.");
    }
    for (const window of options.quotaWindows ?? []) {
      validatePositiveSafeInteger(window.windowMs, "quota windowMs");
      validatePositiveSafeInteger(window.maximumRecipients, "quota maximumRecipients");
    }
    const captureId = captureIdFor(message);
    const logicalBytes = calculateLogicalBytes(message);
    this.validateProducer(options.producer);

    try {
      return this.transaction(() => {
        const database = this.db();
        const producerReplay = this.producerReplay(database, options.producer);
        if (producerReplay) return producerReplay;
        if (message.verificationIntentId) {
          const existing = database.prepare(`
            SELECT capture_id, message_id, logical_bytes
            FROM messages WHERE verification_intent_id = ?
          `).get(message.verificationIntentId) as any;
          if (existing) {
            if (String(existing.message_id) !== message.messageId) {
              throw new MailboxError("Duplicate", "The verification intent is already bound to another SES message.");
            }
            return {
              captureId: String(existing.capture_id),
              messageId: String(existing.message_id),
              inserted: false,
              logicalBytes: integer(existing.logical_bytes),
            };
          }
        }
        const duplicate = database.prepare("SELECT capture_id FROM messages WHERE message_id = ?").get(message.messageId);
        if (duplicate) throw new MailboxError("Duplicate", "The SES message ID already exists in this mailbox.");

        const usage = this.usage();
        if (usage.messageCount + 1 > this.maximumMessages || usage.logicalBytes + logicalBytes > this.maximumBytes) {
          throw new MailboxError("CapacityExceeded", "The SES mailbox has reached its configured logical capacity.");
        }
        for (const window of options.quotaWindows ?? []) {
          const since = Math.max(0, message.acceptedAt - window.windowMs);
          const used = this.recipientCountSince(since);
          if (used + recipientOccurrences > window.maximumRecipients) {
            throw new MailboxError("QuotaExceeded", "The SES recipient quota would be exceeded.");
          }
        }

        database.prepare(`
          INSERT INTO messages(
            capture_id, message_id, verification_intent_id, accepted_at, api_family, operation,
            origin_service, source_address, return_path, reply_to_json, subject, text_body, html_body,
            headers_json, configuration_set_name, message_tags_json, template_name, tenant_name,
            original_raw, normalized_raw, render_status, local_disposition, outcome_code,
            outcome_detail_json, logical_bytes, read_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `).run(
          captureId, message.messageId, message.verificationIntentId ?? null, message.acceptedAt,
          message.apiFamily, message.operation, message.originService ?? null, message.source,
          message.returnPath ?? null, JSON.stringify(message.replyTo), message.subject ?? null,
          message.textBody ?? null, message.htmlBody ?? null, JSON.stringify(message.headers),
          message.configurationSetName ?? null, JSON.stringify(message.messageTags), message.templateName ?? null,
          message.tenantName ?? null, message.originalRaw ? Buffer.from(message.originalRaw) : null,
          message.normalizedRaw ? Buffer.from(message.normalizedRaw) : null, message.renderStatus,
          message.localDisposition, message.outcomeCode ?? null, JSON.stringify(message.outcomeDetail ?? {}),
          logicalBytes,
        );
        const insertRecipient = database.prepare(`
          INSERT INTO recipients(
            capture_id, ordinal, header_kind, is_envelope, origin,
            address_original, address_normalized, accepted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const recipient of message.recipients) {
          insertRecipient.run(
            captureId, recipient.ordinal, recipient.headerKind ?? null, recipient.isEnvelope ? 1 : 0,
            recipient.origin, recipient.address, parseMailboxAddress(recipient.address).normalized, message.acceptedAt,
          );
        }
        const insertAttachment = database.prepare(`
          INSERT INTO attachments(
            attachment_id, capture_id, ordinal, filename, content_type, disposition,
            content_id, byte_length, content
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const attachment of message.attachments) {
          insertAttachment.run(
            attachment.attachmentId, captureId, attachment.ordinal, attachment.filename ?? null,
            attachment.contentType, attachment.disposition ?? null, attachment.contentId ?? null,
            attachment.content.byteLength, Buffer.from(attachment.content),
          );
        }
        database.prepare(`
          INSERT INTO quota_events(capture_id, accepted_at, recipient_occurrences)
          VALUES (?, ?, ?)
        `).run(captureId, message.acceptedAt, recipientOccurrences);
        database.prepare(`
          INSERT INTO capture_audit(capture_id, event_type, event_at, detail_json)
          VALUES (?, ?, ?, ?)
        `).run(captureId, options.auditEventType ?? "CAPTURED", message.acceptedAt, JSON.stringify(options.auditDetail ?? {
          apiFamily: message.apiFamily,
          operation: message.operation,
          renderStatus: message.renderStatus,
          localDisposition: message.localDisposition,
        }));
        const insertOutbox = database.prepare(`
          INSERT INTO event_outbox(
            outbox_id, capture_id, request_id, destination_id, event_ordinal, event_type,
            payload_json, status, attempts, created_at, next_attempt_at, last_error_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, NULL)
        `);
        for (const outbox of options.outbox ?? []) {
          insertOutbox.run(
            outbox.outboxId, captureId, outbox.requestId, outbox.destinationId, outbox.eventOrdinal,
            outbox.eventType, JSON.stringify(outbox.payload), outbox.createdAt, outbox.nextAttemptAt ?? outbox.createdAt,
          );
        }
        if (options.producer) {
          database.prepare(`
            INSERT INTO producer_deliveries(
              origin_service, delivery_key, content_mac, message_id, capture_id,
              logical_bytes, accepted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            options.producer.originService,
            options.producer.deliveryKey,
            Buffer.from(options.producer.contentMac),
            message.messageId,
            captureId,
            logicalBytes,
            message.acceptedAt,
          );
        }
        database.prepare(`
          UPDATE mailbox_usage
          SET message_count = message_count + 1, logical_bytes = logical_bytes + ?
          WHERE singleton = 1
        `).run(logicalBytes);
        return { captureId, messageId: message.messageId, inserted: true, logicalBytes };
      });
    } catch (error) {
      if (error instanceof MailboxError) throw error;
      throw new MailboxError("StorageFailure", "The SES mailbox capture transaction failed.", { cause: error });
    }
  }

  /** Commit every accepted bulk entry and its quota/audit/outbox rows atomically. */
  captureBatch(items: readonly MailboxBatchCaptureItem[]): MailboxCaptureResult[] {
    if (!items.length) return [];
    if (items.length > 50) throw new MailboxError("InvalidInput", "An SES bulk request can contain at most 50 entries.");
    try {
      return this.transaction(() => items.map(item => this.capture(item.message, item.options)));
    } catch (error) {
      if (error instanceof MailboxError) throw error;
      throw new MailboxError("StorageFailure", "The SES bulk mailbox transaction failed.", { cause: error });
    }
  }

  private validateProducer(producer: MailboxCaptureOptions["producer"]): void {
    if (!producer) return;
    if (
      typeof producer.originService !== "string"
      || !/^[a-z0-9-]{1,64}$/.test(producer.originService)
      || typeof producer.deliveryKey !== "string"
      || !/^[A-Za-z0-9_-]{32,128}$/.test(producer.deliveryKey)
      || !(producer.contentMac instanceof Uint8Array)
      || producer.contentMac.byteLength !== 32
    ) {
      throw new MailboxError("InvalidInput", "The SES producer delivery proof is invalid.");
    }
  }

  private producerReplay(
    database: DatabaseSync,
    producer: MailboxCaptureOptions["producer"],
  ): MailboxCaptureResult | undefined {
    if (!producer) return undefined;
    const existing = database.prepare(`
      SELECT content_mac, message_id, capture_id, logical_bytes
      FROM producer_deliveries
      WHERE origin_service = ? AND delivery_key = ?
    `).get(producer.originService, producer.deliveryKey) as any;
    if (!existing) return undefined;
    const expected = Buffer.from(existing.content_mac);
    const actual = Buffer.from(producer.contentMac);
    try {
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new MailboxError("IdempotencyMismatch", "The SES producer delivery key is already bound to different content.");
      }
    } finally {
      expected.fill(0);
      actual.fill(0);
    }
    return {
      captureId: String(existing.capture_id),
      messageId: String(existing.message_id),
      inserted: false,
      logicalBytes: integer(existing.logical_bytes),
    };
  }

  private listConditions(options: MailboxListOptions, normalizedRecipient?: string): { clauses: string[]; values: Array<string | number> } {
    const status = options.status ?? "all";
    if (!new Set<MailboxStatus>(["all", "unread", "trash"]).has(status)) {
      throw new MailboxError("InvalidInput", "The mailbox status filter is invalid.");
    }
    const clauses = [status === "trash" ? "m.deleted_at IS NOT NULL" : "m.deleted_at IS NULL"];
    const values: Array<string | number> = [];
    if (status === "unread") clauses.push("m.read_at IS NULL");
    if (normalizedRecipient) {
      clauses.push("EXISTS (SELECT 1 FROM recipients rf WHERE rf.capture_id = m.capture_id AND rf.is_envelope = 1 AND rf.address_normalized = ?)");
      values.push(normalizedRecipient);
    }
    if (options.originService) {
      if (!/^[a-z0-9-]{1,64}$/.test(options.originService)) {
        throw new MailboxError("InvalidInput", "The mailbox origin-service filter is invalid.");
      }
      clauses.push("m.origin_service = ?");
      values.push(options.originService);
    }
    if (options.highWater) {
      clauses.push("(m.accepted_at < ? OR (m.accepted_at = ? AND m.capture_id <= ?))");
      values.push(options.highWater.acceptedAt, options.highWater.acceptedAt, options.highWater.captureId);
    }
    if (options.after) {
      clauses.push("(m.accepted_at < ? OR (m.accepted_at = ? AND m.capture_id < ?))");
      values.push(options.after.acceptedAt, options.after.acceptedAt, options.after.captureId);
    }
    return { clauses, values };
  }

  list(options: MailboxListOptions = {}): MailboxListPage {
    const pageSize = options.pageSize ?? 50;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new MailboxError("InvalidInput", "Mailbox pageSize must be an integer from 1 through 100.");
    }
    const normalizedRecipient = options.recipient === undefined ? undefined : normalizeMailboxKey(options.recipient);
    const withoutBounds = this.listConditions({ ...options, highWater: undefined, after: undefined }, normalizedRecipient);
    let highWater = options.highWater;
    if (!highWater) {
      const row = this.db().prepare(`
        SELECT m.accepted_at, m.capture_id
        FROM messages m
        WHERE ${withoutBounds.clauses.join(" AND ")}
        ORDER BY m.accepted_at DESC, m.capture_id DESC
        LIMIT 1
      `).get(...withoutBounds.values) as any;
      if (row) highWater = { acceptedAt: integer(row.accepted_at), captureId: String(row.capture_id) };
    }
    const boundedOptions = { ...options, ...(highWater ? { highWater } : {}) };
    const filters = this.listConditions(boundedOptions, normalizedRecipient);
    const rows = this.db().prepare(`
      SELECT
        m.capture_id, m.message_id, m.verification_intent_id, m.accepted_at, m.api_family, m.operation,
        m.origin_service,
        m.source_address, m.subject, m.text_body, m.render_status, m.local_disposition,
        m.configuration_set_name, m.template_name, m.read_at, m.deleted_at,
        (SELECT COUNT(*) FROM attachments a WHERE a.capture_id = m.capture_id) AS attachment_count
      FROM messages m
      WHERE ${filters.clauses.join(" AND ")}
      ORDER BY m.accepted_at DESC, m.capture_id DESC
      LIMIT ?
    `).all(...filters.values, pageSize + 1) as any[];
    const hasNext = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);
    const messages = pageRows.map(row => this.summaryFromRow(row));
    const last = pageRows.at(-1);
    return {
      messages,
      ...(highWater ? { highWater } : {}),
      ...(hasNext && last ? { next: { acceptedAt: integer(last.accepted_at), captureId: String(last.capture_id) } } : {}),
      purgeGeneration: this.usage().purgeGeneration,
    };
  }

  private summaryFromRow(row: any): MailboxMessageSummary {
    const systemVerification = optionalString(row.verification_intent_id) !== undefined
      || optionalString(row.origin_service) === "ses" && String(row.operation) === "VerifyEmailIdentity";
    const previewSource = systemVerification
      ? optionalString(row.subject) ?? "SES verification message"
      : optionalString(row.text_body) ?? optionalString(row.subject) ?? "";
    return {
      captureId: String(row.capture_id),
      messageId: String(row.message_id),
      acceptedAt: integer(row.accepted_at),
      apiFamily: String(row.api_family) as SesApiFamily,
      operation: String(row.operation),
      source: String(row.source_address),
      ...(optionalString(row.subject) ? { subject: String(row.subject) } : {}),
      preview: [...previewSource].slice(0, 200).join(""),
      envelopeRecipients: this.envelopeRecipients(String(row.capture_id)),
      attachmentCount: integer(row.attachment_count),
      unread: row.read_at === null,
      deleted: row.deleted_at !== null,
      renderStatus: String(row.render_status) as SesRenderStatus,
      localDisposition: String(row.local_disposition) as SesLocalDisposition,
      ...(optionalString(row.configuration_set_name) ? { configurationSetName: String(row.configuration_set_name) } : {}),
      ...(optionalString(row.template_name) ? { templateName: String(row.template_name) } : {}),
    };
  }

  private envelopeRecipients(captureId: string): string[] {
    return (this.db().prepare(`
      SELECT address_original FROM recipients
      WHERE capture_id = ? AND is_envelope = 1
      ORDER BY ordinal
    `).all(captureId) as any[]).map(row => String(row.address_original));
  }

  detail(messageId: string): MailboxMessageDetail | undefined {
    const row = this.db().prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId) as any;
    if (!row) return undefined;
    const captureId = String(row.capture_id);
    const textBody = boundedDisplayPart(optionalString(row.text_body));
    const htmlBody = boundedDisplayPart(optionalString(row.html_body));
    const recipients = (this.db().prepare(`
      SELECT ordinal, address_original, header_kind, is_envelope, origin
      FROM recipients WHERE capture_id = ? ORDER BY ordinal
    `).all(captureId) as any[]).map(rowValue => ({
      ordinal: integer(rowValue.ordinal),
      address: String(rowValue.address_original),
      ...(optionalString(rowValue.header_kind) ? { headerKind: String(rowValue.header_kind) as PreparedRecipient["headerKind"] } : {}),
      isEnvelope: Boolean(integer(rowValue.is_envelope)),
      origin: String(rowValue.origin) as PreparedRecipient["origin"],
    }));
    const attachments = (this.db().prepare(`
      SELECT attachment_id, ordinal, filename, content_type, disposition, content_id, byte_length
      FROM attachments WHERE capture_id = ? ORDER BY ordinal
    `).all(captureId) as any[]).map(rowValue => this.attachmentMetadata(rowValue));
    return {
      captureId,
      messageId: String(row.message_id),
      ...(optionalString(row.verification_intent_id) ? { verificationIntentId: String(row.verification_intent_id) } : {}),
      acceptedAt: integer(row.accepted_at),
      apiFamily: String(row.api_family) as SesApiFamily,
      operation: String(row.operation),
      ...(optionalString(row.origin_service) ? { originService: String(row.origin_service) } : {}),
      source: String(row.source_address),
      ...(optionalString(row.return_path) ? { returnPath: String(row.return_path) } : {}),
      replyTo: jsonArray<string>(row.reply_to_json),
      ...(optionalString(row.subject) ? { subject: String(row.subject) } : {}),
      ...(textBody.value === undefined ? {} : { textBody: textBody.value }),
      ...(htmlBody.value === undefined ? {} : { htmlBody: htmlBody.value }),
      headers: jsonArray<PreparedHeader>(row.headers_json),
      ...(optionalString(row.configuration_set_name) ? { configurationSetName: String(row.configuration_set_name) } : {}),
      messageTags: jsonObject<Record<string, string>>(row.message_tags_json, {}),
      ...(optionalString(row.template_name) ? { templateName: String(row.template_name) } : {}),
      ...(optionalString(row.tenant_name) ? { tenantName: String(row.tenant_name) } : {}),
      renderStatus: String(row.render_status) as SesRenderStatus,
      localDisposition: String(row.local_disposition) as SesLocalDisposition,
      ...(optionalString(row.outcome_code) ? { outcomeCode: String(row.outcome_code) } : {}),
      outcomeDetail: jsonObject<Record<string, string>>(row.outcome_detail_json, {}),
      logicalBytes: integer(row.logical_bytes),
      ...(row.read_at === null ? {} : { readAt: integer(row.read_at) }),
      ...(row.deleted_at === null ? {} : { deletedAt: integer(row.deleted_at) }),
      recipients,
      attachments,
      hasOriginalRaw: row.original_raw !== null,
      hasNormalizedRaw: row.normalized_raw !== null,
      ...(textBody.truncated || htmlBody.truncated ? { truncated: true } : {}),
    };
  }

  private attachmentMetadata(row: any): MailboxAttachmentMetadata {
    return {
      attachmentId: String(row.attachment_id),
      ordinal: integer(row.ordinal),
      ...(optionalString(row.filename) ? { filename: String(row.filename) } : {}),
      contentType: String(row.content_type),
      ...(optionalString(row.disposition) ? { disposition: String(row.disposition) } : {}),
      ...(optionalString(row.content_id) ? { contentId: String(row.content_id) } : {}),
      byteLength: integer(row.byte_length),
    };
  }

  getRaw(messageId: string, variant: "original" | "normalized" = "normalized"): Uint8Array | undefined {
    const column = variant === "original" ? "original_raw" : "normalized_raw";
    const row = this.db().prepare(`SELECT ${column} AS content FROM messages WHERE message_id = ?`).get(messageId) as any;
    return row?.content === null || row?.content === undefined ? undefined : Uint8Array.from(row.content as Uint8Array);
  }

  getAttachment(messageId: string, attachmentId: string): (MailboxAttachmentMetadata & { content: Uint8Array }) | undefined {
    const row = this.db().prepare(`
      SELECT a.attachment_id, a.ordinal, a.filename, a.content_type, a.disposition,
             a.content_id, a.byte_length, a.content
      FROM attachments a
      JOIN messages m ON m.capture_id = a.capture_id
      WHERE m.message_id = ? AND a.attachment_id = ?
    `).get(messageId, attachmentId) as any;
    return row ? { ...this.attachmentMetadata(row), content: Uint8Array.from(row.content as Uint8Array) } : undefined;
  }

  update(messageId: string, state: { read?: boolean; deleted?: boolean }, at = Date.now()): MailboxMessageDetail | undefined {
    if (state.read === undefined && state.deleted === undefined) {
      throw new MailboxError("InvalidInput", "A mailbox update must set read or deleted.");
    }
    if (!Number.isSafeInteger(at) || at < 0) throw new MailboxError("InvalidInput", "The mailbox update time is invalid.");
    this.transaction(() => {
      const row = this.db().prepare("SELECT read_at, deleted_at FROM messages WHERE message_id = ?").get(messageId) as any;
      if (!row) return;
      const readAt = state.read === undefined ? row.read_at : state.read ? at : null;
      const deletedAt = state.deleted === undefined ? row.deleted_at : state.deleted ? at : null;
      this.db().prepare("UPDATE messages SET read_at = ?, deleted_at = ? WHERE message_id = ?").run(readAt, deletedAt, messageId);
    });
    return this.detail(messageId);
  }

  softDelete(messageId: string, at = Date.now()): MailboxMessageDetail | undefined {
    return this.update(messageId, { deleted: true }, at);
  }

  recipientSuggestions(prefix = "", limit = 20): MailboxRecipientSuggestion[] {
    if (typeof prefix !== "string" || Buffer.byteLength(prefix, "utf8") > SES_MAX_MAILBOX_ADDRESS_BYTES || /[\u0000-\u001f\u007f]/.test(prefix)) {
      throw new MailboxError("InvalidInput", "The recipient suggestion prefix is invalid.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new MailboxError("InvalidInput", "The recipient suggestion limit must be from 1 through 50.");
    }
    const normalized = prefix.trim().toLowerCase();
    const escaped = normalized.replace(/[\\%_]/g, value => `\\${value}`);
    return (this.db().prepare(`
      SELECT r.address_normalized, COUNT(DISTINCT r.capture_id) AS message_count
      FROM recipients r
      JOIN messages m ON m.capture_id = r.capture_id
      WHERE r.is_envelope = 1 AND m.deleted_at IS NULL
        AND r.address_normalized LIKE ? ESCAPE '\\'
      GROUP BY r.address_normalized
      ORDER BY r.address_normalized
      LIMIT ?
    `).all(`${escaped}%`, limit) as any[]).map(row => ({
      address: String(row.address_normalized),
      messageCount: integer(row.message_count),
    }));
  }

  purge(request: MailboxPurgeRequest): MailboxPurgeResult {
    const hasIds = Array.isArray((request as { messageIds?: unknown }).messageIds);
    const allTrash = (request as { allTrash?: unknown }).allTrash === true;
    if (hasIds === allTrash) throw new MailboxError("InvalidInput", "Purge requires exactly one of messageIds or allTrash.");
    const ids = hasIds ? (request as { messageIds: string[] }).messageIds : undefined;
    if (ids) {
      if (ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id)) {
        throw new MailboxError("InvalidInput", "Purge messageIds must contain 1 through 100 unique non-empty IDs.");
      }
    }

    const result = this.transaction(() => {
      const database = this.db();
      let rows: any[];
      if (ids) {
        const placeholders = ids.map(() => "?").join(",");
        rows = database.prepare(`
          SELECT message_id, capture_id, logical_bytes, deleted_at
          FROM messages WHERE message_id IN (${placeholders})
        `).all(...ids) as any[];
        if (rows.some(row => row.deleted_at === null)) {
          throw new MailboxError("Conflict", "Every existing message selected for purge must already be in Trash.");
        }
        rows = rows.filter(row => row.deleted_at !== null);
      } else {
        rows = database.prepare(`
          SELECT message_id, capture_id, logical_bytes, deleted_at
          FROM messages WHERE deleted_at IS NOT NULL
        `).all() as any[];
      }
      const released = rows.reduce((total, row) => total + integer(row.logical_bytes), 0);
      if (rows.length) {
        const placeholders = rows.map(() => "?").join(",");
        database.prepare(`DELETE FROM messages WHERE capture_id IN (${placeholders})`).run(...rows.map(row => String(row.capture_id)));
        database.prepare(`
          UPDATE mailbox_usage
          SET message_count = message_count - ?,
              logical_bytes = logical_bytes - ?,
              purge_generation = purge_generation + 1
          WHERE singleton = 1
        `).run(rows.length, released);
      }
      return { purged: rows.length, releasedLogicalBytes: released, purgeGeneration: this.usage().purgeGeneration };
    });
    if (result.purged) {
      try {
        this.db().exec("PRAGMA wal_checkpoint(PASSIVE)");
        this.db().exec("PRAGMA incremental_vacuum(64)");
      } catch { /* Logical purge already committed; maintenance is best effort. */ }
    }
    return result;
  }

  async stop(): Promise<void> {
    this.close();
  }

  close(): void {
    const database = this.database;
    if (!database) return;
    this.database = undefined;
    try { database.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
    finally { database.close(); }
  }
}
