/**
 * Protocol-independent message representation handed to the durable SES
 * mailbox. Protocol adapters prepare this value but never persist it directly.
 */
export type SesApiFamily = "ses-v1" | "ses-v2" | "internal";
export type SesHeaderKind = "TO" | "CC" | "BCC";
export type SesRecipientOrigin =
  | "API_DESTINATION"
  | "RAW_HEADER"
  | "RAW_EXPLICIT_ENVELOPE"
  | "RAW_DERIVED_ENVELOPE";
export type SesRenderStatus = "RENDERED" | "FAILED";
export type SesLocalDisposition = "CAPTURED" | "SUPPRESSED" | "NOT_ATTEMPTED";

export interface PreparedHeader {
  name: string;
  value: string;
}

export interface PreparedRecipient {
  ordinal: number;
  address: string;
  headerKind?: SesHeaderKind;
  isEnvelope: boolean;
  origin: SesRecipientOrigin;
}

export interface PreparedAttachment {
  /** Opaque local identifier. Never derive a host path from the filename. */
  attachmentId: string;
  ordinal: number;
  filename?: string;
  contentType: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
  content: Uint8Array;
}

export interface PreparedSesMessage {
  messageId: string;
  acceptedAt: number;
  accountId: string;
  region: string;
  apiFamily: SesApiFamily;
  operation: string;
  originService?: string;
  source: string;
  returnPath?: string;
  replyTo: string[];
  recipients: PreparedRecipient[];
  renderStatus: SesRenderStatus;
  localDisposition: SesLocalDisposition;
  outcomeCode?: string;
  outcomeDetail?: Record<string, string>;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  /** Exact bytes supplied by a caller to a raw-send operation. */
  originalRaw?: Uint8Array;
  /** Final message bytes after SES-owned Date/Message-ID normalization. */
  normalizedRaw?: Uint8Array;
  headers: PreparedHeader[];
  attachments: PreparedAttachment[];
  configurationSetName?: string;
  messageTags: Record<string, string>;
  templateName?: string;
  tenantName?: string;
  verificationIntentId?: string;
}

export interface PreparedOutboxRecord {
  outboxId: string;
  requestId: string;
  destinationId: string;
  eventOrdinal: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: number;
  nextAttemptAt?: number;
}
