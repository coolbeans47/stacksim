import type { PreparedHeader, PreparedRecipient, PreparedSesMessage, SesHeaderKind } from "./model.js";

export const SES_MAX_RECIPIENTS = 50;
export const SES_MAX_MIME_PARTS = 500;
export const SES_MAX_MIME_DEPTH = 30;
export const SES_MAX_LINE_BYTES = 1_000;
export const SES_V1_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
export const SES_V2_MAX_MESSAGE_BYTES = 40 * 1024 * 1024;
export const SES_MAX_MAILBOX_ADDRESS_BYTES = 320;

export class SesContentError extends Error {
  constructor(
    public readonly code:
      | "InvalidAddress"
      | "InvalidHeader"
      | "InvalidMime"
      | "MessageTooLarge"
      | "TooManyRecipients"
      | "MissingRecipient"
      | "InvalidConfiguration",
    message: string,
  ) {
    super(message);
    this.name = "SesContentError";
  }
}

export interface ParsedMailboxAddress {
  original: string;
  address: string;
  normalized: string;
  localPart: string;
  domain: string;
  displayName?: string;
}

const ADDRESS_ATOM = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const HEADER_NAME = /^[\x21-\x39\x3b-\x7e]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const RESERVED_SIMPLE_HEADERS = new Set([
  "bcc", "cc", "content-transfer-encoding", "content-type", "date", "from",
  "message-id", "mime-version", "reply-to", "return-path", "sender", "subject", "to",
]);

function failAddress(message: string): never {
  throw new SesContentError("InvalidAddress", message);
}

function unquoteDisplayName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith('"')) return trimmed;
  if (!trimmed.endsWith('"') || trimmed.length < 2) failAddress("The display name has an unterminated quoted string.");
  let output = "";
  let escaped = false;
  for (const character of trimmed.slice(1, -1)) {
    if (escaped) { output += character; escaped = false; }
    else if (character === "\\") escaped = true;
    else if (character === '"') failAddress("The display name contains an unescaped quote.");
    else output += character;
  }
  if (escaped) failAddress("The display name has an unterminated escape.");
  return output;
}

/**
 * Parse the deliberately bounded mailbox syntax supported by SES. SMTPUTF8 is
 * not accepted: Unicode display names are allowed, while the addr-spec must be
 * ASCII (Unicode domains must already be Punycode).
 */
export function parseMailboxAddress(value: string): ParsedMailboxAddress {
  if (typeof value !== "string") return failAddress("An email address must be a string.");
  const original = value.trim();
  if (!original || Buffer.byteLength(original, "utf8") > SES_MAX_MAILBOX_ADDRESS_BYTES) {
    return failAddress("The email address is empty or exceeds 320 UTF-8 bytes.");
  }
  if (CONTROL.test(original)) return failAddress("The email address contains a control character.");

  let displayName: string | undefined;
  let address = original;
  const opening = original.lastIndexOf("<");
  if (opening >= 0) {
    if (!original.endsWith(">") || original.indexOf(">", opening) !== original.length - 1) {
      return failAddress("The email address has an invalid angle-address.");
    }
    displayName = unquoteDisplayName(original.slice(0, opening));
    address = original.slice(opening + 1, -1).trim();
  } else if (original.includes(">")) {
    return failAddress("The email address has an invalid angle-address.");
  }

  if (!/^[\x21-\x7e]+$/.test(address)) {
    return failAddress("SES does not support SMTPUTF8 addr-spec values; use an ASCII local part and Punycode domain.");
  }
  const at = address.lastIndexOf("@");
  if (at <= 0 || at !== address.indexOf("@") || at === address.length - 1) {
    return failAddress("The email address must contain one local part and domain.");
  }
  const localPart = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (Buffer.byteLength(localPart, "ascii") > 64 || !ADDRESS_ATOM.test(localPart)) {
    return failAddress("The email address local part is not a supported dot-atom.");
  }
  if (domain.length > 255 || domain.endsWith(".") || domain.split(".").some(label => !DOMAIN_LABEL.test(label))) {
    return failAddress("The email address domain is invalid.");
  }
  const normalized = `${localPart.toLowerCase()}@${domain.toLowerCase()}`;
  return { original, address, normalized, localPart, domain, ...(displayName ? { displayName } : {}) };
}

/** Split a comma-separated RFC 5322 address list without splitting quotes. */
export function splitAddressList(value: string): string[] {
  if (CONTROL.test(value.replace(/\t/g, ""))) failAddress("The address list contains a control character.");
  const values: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angleDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === "\\") { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && character === "<") angleDepth += 1;
    else if (!quoted && character === ">") angleDepth -= 1;
    else if (!quoted && angleDepth === 0 && character === ",") {
      const item = value.slice(start, index).trim();
      if (!item) failAddress("The address list contains an empty member.");
      values.push(item);
      start = index + 1;
    }
    if (angleDepth < 0 || angleDepth > 1) failAddress("The address list has invalid angle-address nesting.");
  }
  if (quoted || escaped || angleDepth !== 0) failAddress("The address list is not terminated.");
  const final = value.slice(start).trim();
  if (!final && values.length) failAddress("The address list contains an empty member.");
  if (final) values.push(final);
  return values;
}

export function parseAddressList(value: string): ParsedMailboxAddress[] {
  return splitAddressList(value).map(parseMailboxAddress);
}

export function normalizeMailboxKey(value: string): string {
  return parseMailboxAddress(value).normalized;
}

export function validateRecipientAddresses(recipients: readonly PreparedRecipient[]): void {
  const ordinals = new Set<number>();
  let envelopeCount = 0;
  for (const recipient of recipients) {
    if (!Number.isInteger(recipient.ordinal) || recipient.ordinal < 0 || ordinals.has(recipient.ordinal)) {
      throw new SesContentError("InvalidAddress", "Recipient ordinals must be unique non-negative integers.");
    }
    ordinals.add(recipient.ordinal);
    parseMailboxAddress(recipient.address);
    if (recipient.headerKind !== undefined && !new Set<SesHeaderKind>(["TO", "CC", "BCC"]).has(recipient.headerKind)) {
      throw new SesContentError("InvalidAddress", "A recipient has an invalid header role.");
    }
    if (recipient.isEnvelope) envelopeCount += 1;
    if (!recipient.isEnvelope && !recipient.headerKind) {
      throw new SesContentError("InvalidAddress", "A non-envelope recipient must identify its header role.");
    }
  }
  if (!envelopeCount) throw new SesContentError("MissingRecipient", "At least one envelope recipient is required.");
  if (envelopeCount > SES_MAX_RECIPIENTS) {
    throw new SesContentError("TooManyRecipients", `A message can have at most ${SES_MAX_RECIPIENTS} envelope-recipient occurrences.`);
  }
}

export function validateCustomHeaders(headers: readonly PreparedHeader[], maximum = 15): void {
  if (headers.length > maximum) throw new SesContentError("InvalidHeader", `A message can have at most ${maximum} custom headers.`);
  for (const header of headers) {
    const name = String(header.name ?? "");
    const value = String(header.value ?? "");
    if (!name || name.length > 126 || !HEADER_NAME.test(name) || name.includes(":")) {
      throw new SesContentError("InvalidHeader", "A custom header name is invalid.");
    }
    const normalized = name.toLowerCase();
    if (RESERVED_SIMPLE_HEADERS.has(normalized) || normalized.startsWith("x-ses-")) {
      throw new SesContentError("InvalidHeader", `The ${name} header is owned by SES or the MIME assembler.`);
    }
    if (Buffer.byteLength(value, "utf8") > 870 || /[\r\n\u0000]/.test(value)) {
      throw new SesContentError("InvalidHeader", `The ${name} header value is invalid or too long.`);
    }
  }
}

export function validateMessageSize(bytes: Uint8Array, apiFamily: PreparedSesMessage["apiFamily"]): void {
  const limit = apiFamily === "ses-v1" ? SES_V1_MAX_MESSAGE_BYTES : SES_V2_MAX_MESSAGE_BYTES;
  if (bytes.byteLength > limit) {
    throw new SesContentError("MessageTooLarge", `The encoded message exceeds the ${limit / (1024 * 1024)} MB ${apiFamily} limit.`);
  }
}

export function validateMimeLineLengths(bytes: Uint8Array): void {
  const value = Buffer.from(bytes);
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index !== value.length && value[index] !== 0x0a) continue;
    const length = index - start + (index < value.length ? 1 : 0);
    if (length > SES_MAX_LINE_BYTES) {
      throw new SesContentError("InvalidMime", `A MIME line exceeds ${SES_MAX_LINE_BYTES} bytes including its line ending.`);
    }
    start = index + 1;
  }
}

export function validatePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SesContentError("InvalidConfiguration", `${name} must be a positive safe integer.`);
  }
  return value;
}

export function validatePreparedMessage(message: PreparedSesMessage): void {
  if (!message.messageId || !Number.isSafeInteger(message.acceptedAt) || message.acceptedAt < 0) {
    throw new SesContentError("InvalidMime", "The prepared message has invalid acceptance metadata.");
  }
  if (!/^\d{12}$/.test(message.accountId) || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(message.region)) {
    throw new SesContentError("InvalidMime", "The prepared message has an invalid account or Region.");
  }
  parseMailboxAddress(message.source);
  if (message.returnPath) parseMailboxAddress(message.returnPath);
  message.replyTo.forEach(parseMailboxAddress);
  validateRecipientAddresses(message.recipients);
  if (message.attachments.length > SES_MAX_MIME_PARTS) {
    throw new SesContentError("InvalidMime", `A message can contain at most ${SES_MAX_MIME_PARTS} MIME parts.`);
  }
  const attachmentIds = new Set<string>();
  for (const attachment of message.attachments) {
    if (!attachment.attachmentId || attachmentIds.has(attachment.attachmentId) || !Number.isInteger(attachment.ordinal) || attachment.ordinal < 0) {
      throw new SesContentError("InvalidMime", "Attachment identifiers and ordinals must be valid.");
    }
    attachmentIds.add(attachment.attachmentId);
    if (!attachment.contentType || /[\r\n\u0000]/.test(attachment.contentType) || attachment.filename && /[\r\n\u0000]/.test(attachment.filename)) {
      throw new SesContentError("InvalidMime", "Attachment metadata is invalid.");
    }
  }
  if (message.renderStatus === "RENDERED") {
    if (!message.normalizedRaw || message.localDisposition === "NOT_ATTEMPTED") {
      throw new SesContentError("InvalidMime", "A rendered message requires normalized bytes and a captured or suppressed disposition.");
    }
    validateMessageSize(message.normalizedRaw, message.apiFamily);
    validateMimeLineLengths(message.normalizedRaw);
  } else if (message.normalizedRaw || message.localDisposition !== "NOT_ATTEMPTED") {
    throw new SesContentError("InvalidMime", "A rendering failure cannot contain fabricated normalized bytes.");
  }
}
