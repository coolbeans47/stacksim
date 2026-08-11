import { createHash } from "node:crypto";
import type {
  PreparedAttachment,
  PreparedHeader,
  PreparedRecipient,
  PreparedSesMessage,
  SesApiFamily,
  SesHeaderKind,
  SesLocalDisposition,
} from "./model.js";
import {
  SES_MAX_MIME_DEPTH,
  SES_MAX_MIME_PARTS,
  SesContentError,
  parseAddressList,
  parseMailboxAddress,
  validateCustomHeaders,
  validateMessageSize,
  validateMimeLineLengths,
  validatePreparedMessage,
  validateRecipientAddresses,
} from "./validation.js";

export interface SimpleDestination {
  to?: string[];
  cc?: string[];
  bcc?: string[];
}

export interface SimpleAttachmentInput {
  content: Uint8Array;
  filename?: string;
  contentType?: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
}

interface MessageMetadataInput {
  messageId: string;
  acceptedAt: number;
  accountId: string;
  region: string;
  apiFamily: SesApiFamily;
  operation: string;
  originService?: string;
  returnPath?: string;
  configurationSetName?: string;
  messageTags?: Record<string, string>;
  templateName?: string;
  tenantName?: string;
  verificationIntentId?: string;
  localDisposition?: Exclude<SesLocalDisposition, "NOT_ATTEMPTED">;
}

export interface BuildSimpleMessageInput extends MessageMetadataInput {
  source: string;
  replyTo?: string[];
  destination: SimpleDestination;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  charset?: string;
  headers?: PreparedHeader[];
  attachments?: SimpleAttachmentInput[];
}

export interface ParseRawMessageInput extends MessageMetadataInput {
  raw: Uint8Array;
  /**
   * When present, this collection is the authoritative envelope. When absent,
   * To/Cc/Bcc raw headers are copied into separate derived-envelope rows.
   */
  destinations?: string[];
  /** Optional API Source/From override used for the envelope sender check. */
  source?: string;
  returnPath?: string;
}

interface ParsedHeader extends PreparedHeader {
  lowerName: string;
  rawLines: string[];
}

interface ParsedEntity {
  headers: ParsedHeader[];
  body: Buffer;
}

interface MimeExtraction {
  textBody?: string;
  htmlBody?: string;
  attachments: PreparedAttachment[];
  partCount: number;
}

const HEADER_NAME = /^[\x21-\x39\x3b-\x7e]+$/;
const MIME_HEADER_LIMIT = 256 * 1024;

function contentError(message: string): never {
  throw new SesContentError("InvalidMime", message);
}

function stableToken(messageId: string, purpose: string, length = 32): string {
  return createHash("sha256").update(`${messageId}\0${purpose}`).digest("hex").slice(0, length);
}

function normalizeCharset(value: string | undefined): string {
  const charset = (value ?? "UTF-8").trim().toLowerCase().replace(/^"|"$/g, "");
  if (charset === "utf8") return "utf-8";
  if (charset === "ascii") return "us-ascii";
  if (charset === "latin1" || charset === "iso8859-1") return "iso-8859-1";
  if (new Set(["utf-8", "us-ascii", "iso-8859-1", "windows-1252"]).has(charset)) return charset;
  throw new SesContentError("InvalidMime", `Unsupported MIME charset ${value}.`);
}

const WINDOWS_1252_ENCODE = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

function encodeCharset(value: string, charsetValue?: string): Buffer {
  const charset = normalizeCharset(charsetValue);
  if (charset === "utf-8") return Buffer.from(value, "utf8");
  const bytes: number[] = [];
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (charset === "us-ascii") {
      if (point > 0x7f) contentError("A US-ASCII MIME value contains a non-ASCII character.");
      bytes.push(point);
    } else if (charset === "iso-8859-1") {
      if (point > 0xff) contentError("An ISO-8859-1 MIME value contains an unsupported character.");
      bytes.push(point);
    } else {
      const encoded = point <= 0x7f || point >= 0xa0 && point <= 0xff ? point : WINDOWS_1252_ENCODE.get(point);
      if (encoded === undefined) contentError("A Windows-1252 MIME value contains an unsupported character.");
      bytes.push(encoded);
    }
  }
  return Buffer.from(bytes);
}

function decodeCharset(value: Buffer, charsetValue?: string): string {
  const charset = normalizeCharset(charsetValue);
  try { return new TextDecoder(charset, { fatal: true }).decode(value); }
  catch { return contentError(`MIME content is not valid ${charset}.`); }
}

function wrapBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function encodedWord(value: string, charset = "UTF-8"): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const normalized = normalizeCharset(charset);
  const label = normalized.toUpperCase();
  const output: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const encoded = encodeCharset(character, normalized);
    if (chunk && bytes + encoded.length > 30) {
      output.push(`=?${label}?B?${encodeCharset(chunk, normalized).toString("base64")}?=`);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += encoded.length;
  }
  if (chunk) output.push(`=?${label}?B?${encodeCharset(chunk, normalized).toString("base64")}?=`);
  return output.join(" ");
}

function quoteDisplay(value: string, charset: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) return encodedWord(value, charset);
  if (/^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~.]+$/.test(value) && !value.includes(",")) return value;
  return `"${value.replace(/([\\"])/g, "\\$1")}"`;
}

function formatMailbox(value: string, charset = "UTF-8"): string {
  const parsed = parseMailboxAddress(value);
  return parsed.displayName ? `${quoteDisplay(parsed.displayName, charset)} <${parsed.address}>` : parsed.address;
}

function foldHeader(name: string, values: string[]): string {
  let output = `${name}:`;
  let lineLength = Buffer.byteLength(output, "utf8");
  values.forEach((value, index) => {
    const fragment = `${index ? "," : ""} ${value}`;
    const length = Buffer.byteLength(fragment, "utf8");
    if (lineLength + length > 78 && lineLength > name.length + 1) {
      output += `\r\n ${value}`;
      lineLength = 1 + Buffer.byteLength(value, "utf8");
    } else {
      output += fragment;
      lineLength += length;
    }
  });
  return output;
}

function foldUnstructuredHeader(name: string, value: string): string {
  const words = value.split(/\s+/);
  if (words.some(word => Buffer.byteLength(word, "utf8") > 995)) contentError(`The ${name} header cannot be folded within the SMTP line limit.`);
  let output = `${name}:`;
  let lineLength = Buffer.byteLength(output, "utf8");
  for (const word of words) {
    const length = Buffer.byteLength(word, "utf8") + 1;
    if (lineLength + length > 78 && lineLength > name.length + 1) {
      output += `\r\n ${word}`;
      lineLength = length;
    } else {
      output += ` ${word}`;
      lineLength += length;
    }
  }
  return output;
}

function singleHeader(name: string, value: string): string {
  const prefix = `${name}: `;
  if (Buffer.byteLength(prefix + value, "utf8") <= 998) return prefix + value;
  return foldUnstructuredHeader(name, value);
}

function messageIdHeader(messageId: string, region: string): string {
  const safe = messageId.replace(/[^A-Za-z0-9._-]/g, "");
  if (!safe) contentError("The SES message ID cannot form a Message-ID header.");
  return `<${safe}@${region}.amazonses.com>`;
}

function attachmentId(messageId: string, ordinal: number, content: Uint8Array): string {
  return createHash("sha256")
    .update(`${messageId}\0attachment\0${ordinal}\0`)
    .update(content)
    .digest("base64url")
    .slice(0, 32);
}

function safeParameter(value: string): string {
  return value.replace(/[\r\n\u0000]/g, "").replace(/([\\"])/g, "\\$1");
}

function attachmentHeaders(input: SimpleAttachmentInput, charset: string): string[] {
  const contentType = input.contentType?.trim() || "application/octet-stream";
  if (/[\r\n\u0000]/.test(contentType)) contentError("An attachment content type is invalid.");
  const disposition = input.disposition ?? "attachment";
  const headers = [`Content-Type: ${contentType}`];
  if (input.filename) {
    const fallback = input.filename.replace(/[^\x20-\x7e]/g, "_");
    const extended = /^[\x20-\x7e]+$/.test(input.filename)
      ? ""
      : `; filename*=${normalizeCharset(charset)}''${encodeURIComponent(input.filename)}`;
    headers.push(`Content-Disposition: ${disposition}; filename="${safeParameter(fallback)}"${extended}`);
  } else headers.push(`Content-Disposition: ${disposition}`);
  if (input.contentId) headers.push(`Content-ID: <${safeParameter(input.contentId.replace(/^<|>$/g, ""))}>`);
  headers.push("Content-Transfer-Encoding: base64");
  return headers;
}

function bodyPart(contentType: "text/plain" | "text/html", value: string, charset: string): string {
  return [
    `Content-Type: ${contentType}; charset=${normalizeCharset(charset)}`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(encodeCharset(value, charset)),
  ].join("\r\n");
}

function preparedRecipients(destination: SimpleDestination): PreparedRecipient[] {
  const output: PreparedRecipient[] = [];
  const groups: Array<[SesHeaderKind, string[] | undefined]> = [
    ["TO", destination.to], ["CC", destination.cc], ["BCC", destination.bcc],
  ];
  for (const [headerKind, values] of groups) for (const address of values ?? []) {
    parseMailboxAddress(address);
    output.push({ ordinal: output.length, address, headerKind, isEnvelope: true, origin: "API_DESTINATION" });
  }
  validateRecipientAddresses(output);
  return output;
}

/**
 * Build deterministic RFC 5322/MIME bytes for v1/v2 simple and rendered-template
 * sends. Bcc remains authoritative envelope metadata and is not injected into
 * the normalized message headers.
 */
export function buildSimpleMessage(input: BuildSimpleMessageInput): PreparedSesMessage {
  const charset = normalizeCharset(input.charset);
  const source = parseMailboxAddress(input.source);
  const replyTo = (input.replyTo ?? []).map(value => parseMailboxAddress(value).original);
  const recipients = preparedRecipients(input.destination);
  const customHeaders = input.headers ?? [];
  validateCustomHeaders(customHeaders);
  if (input.textBody === undefined && input.htmlBody === undefined) contentError("A simple message requires a text or HTML body.");
  const attachments = input.attachments ?? [];
  if (input.apiFamily === "ses-v1" && attachments.length) contentError("Classic SES SendEmail does not accept attachment inputs.");
  const bodyParts = input.textBody !== undefined && input.htmlBody !== undefined ? 2 : 1;
  const containerParts = attachments.length ? 1 : 0;
  const alternativeContainer = input.textBody !== undefined && input.htmlBody !== undefined ? 1 : 0;
  if (attachments.length + bodyParts + containerParts + alternativeContainer > SES_MAX_MIME_PARTS) {
    contentError(`A message can contain at most ${SES_MAX_MIME_PARTS} MIME parts.`);
  }

  const to = recipients.filter(value => value.headerKind === "TO").map(value => formatMailbox(value.address, charset));
  const cc = recipients.filter(value => value.headerKind === "CC").map(value => formatMailbox(value.address, charset));
  const topHeaders: string[] = [
    `Date: ${new Date(input.acceptedAt).toUTCString()}`,
    `Message-ID: ${messageIdHeader(input.messageId, input.region)}`,
    `From: ${formatMailbox(source.original, charset)}`,
  ];
  if (to.length) topHeaders.push(foldHeader("To", to));
  if (cc.length) topHeaders.push(foldHeader("Cc", cc));
  if (replyTo.length) topHeaders.push(foldHeader("Reply-To", replyTo.map(value => formatMailbox(value, charset))));
  topHeaders.push(singleHeader("Subject", encodedWord(input.subject, charset)), "MIME-Version: 1.0");
  for (const header of customHeaders) topHeaders.push(singleHeader(header.name, header.value));

  const alternativeBoundary = `=_stacksim_alt_${stableToken(input.messageId, "alternative")}`;
  let mainBody: string;
  if (input.textBody !== undefined && input.htmlBody !== undefined) {
    mainBody = [
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      "",
      `--${alternativeBoundary}`,
      bodyPart("text/plain", input.textBody, charset),
      `--${alternativeBoundary}`,
      bodyPart("text/html", input.htmlBody, charset),
      `--${alternativeBoundary}--`,
      "",
    ].join("\r\n");
  } else {
    mainBody = bodyPart(input.textBody !== undefined ? "text/plain" : "text/html", input.textBody ?? input.htmlBody!, charset);
  }

  const preparedAttachments: PreparedAttachment[] = attachments.map((attachment, ordinal) => ({
    attachmentId: attachmentId(input.messageId, ordinal, attachment.content),
    ordinal,
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    contentType: attachment.contentType?.trim() || "application/octet-stream",
    disposition: attachment.disposition ?? "attachment",
    ...(attachment.contentId ? { contentId: attachment.contentId.replace(/^<|>$/g, "") } : {}),
    content: Uint8Array.from(attachment.content),
  }));

  let normalized: string;
  if (attachments.length) {
    const mixedBoundary = `=_stacksim_mixed_${stableToken(input.messageId, "mixed")}`;
    topHeaders.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
    const parts = [`--${mixedBoundary}`, mainBody];
    attachments.forEach(attachment => {
      parts.push(`--${mixedBoundary}`, ...attachmentHeaders(attachment, charset), "", wrapBase64(attachment.content));
    });
    parts.push(`--${mixedBoundary}--`, "");
    normalized = `${topHeaders.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
  } else if (input.textBody !== undefined && input.htmlBody !== undefined) {
    const [contentType, ...body] = mainBody.split("\r\n");
    topHeaders.push(contentType);
    normalized = `${topHeaders.join("\r\n")}\r\n\r\n${body.join("\r\n")}`;
  } else {
    const [contentType, transferEncoding, , ...body] = mainBody.split("\r\n");
    topHeaders.push(contentType, transferEncoding);
    normalized = `${topHeaders.join("\r\n")}\r\n\r\n${body.join("\r\n")}`;
  }

  const normalizedRaw = Buffer.from(normalized, "utf8");
  validateMessageSize(normalizedRaw, input.apiFamily);
  validateMimeLineLengths(normalizedRaw);
  const headers: PreparedHeader[] = [
    { name: "Date", value: new Date(input.acceptedAt).toUTCString() },
    { name: "Message-ID", value: messageIdHeader(input.messageId, input.region) },
    { name: "From", value: source.original },
    ...(to.length ? [{ name: "To", value: to.join(", ") }] : []),
    ...(cc.length ? [{ name: "Cc", value: cc.join(", ") }] : []),
    ...(replyTo.length ? [{ name: "Reply-To", value: replyTo.join(", ") }] : []),
    { name: "Subject", value: input.subject },
    ...customHeaders.map(header => ({ ...header })),
  ];
  const message: PreparedSesMessage = {
    messageId: input.messageId,
    acceptedAt: input.acceptedAt,
    accountId: input.accountId,
    region: input.region,
    apiFamily: input.apiFamily,
    operation: input.operation,
    ...(input.originService ? { originService: input.originService } : {}),
    source: source.address,
    ...(input.returnPath ? { returnPath: parseMailboxAddress(input.returnPath).address } : {}),
    replyTo,
    recipients,
    renderStatus: "RENDERED",
    localDisposition: input.localDisposition ?? "CAPTURED",
    subject: input.subject,
    ...(input.textBody !== undefined ? { textBody: input.textBody } : {}),
    ...(input.htmlBody !== undefined ? { htmlBody: input.htmlBody } : {}),
    normalizedRaw,
    headers,
    attachments: preparedAttachments,
    ...(input.configurationSetName ? { configurationSetName: input.configurationSetName } : {}),
    messageTags: { ...(input.messageTags ?? {}) },
    ...(input.templateName ? { templateName: input.templateName } : {}),
    ...(input.tenantName ? { tenantName: input.tenantName } : {}),
    ...(input.verificationIntentId ? { verificationIntentId: input.verificationIntentId } : {}),
  };
  validatePreparedMessage(message);
  return message;
}

function headerSeparator(value: Buffer): { index: number; length: number } {
  const crlf = value.indexOf("\r\n\r\n");
  const lf = value.indexOf("\n\n");
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, length: 4 };
  if (lf >= 0) return { index: lf, length: 2 };
  return contentError("Raw content must contain a header/body separator.");
}

function parseEntity(value: Buffer, requireBodySeparator = true): ParsedEntity {
  const separator = headerSeparator(value);
  if (separator.index > MIME_HEADER_LIMIT) contentError("The MIME header block exceeds the bounded parser limit.");
  const rawHeader = value.subarray(0, separator.index).toString("latin1");
  if (!rawHeader || /[^\x00-\xff]/.test(rawHeader)) contentError("The MIME header block is invalid.");
  const physical = rawHeader.split(/\r?\n/);
  const headers: ParsedHeader[] = [];
  for (const line of physical) {
    if (/^[ \t]/.test(line)) {
      const previous = headers.at(-1);
      if (!previous) contentError("A MIME header continuation has no preceding header.");
      previous.value += ` ${line.trim()}`;
      previous.rawLines.push(line);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) contentError("A MIME header line is malformed.");
    const name = line.slice(0, colon);
    if (!HEADER_NAME.test(name)) contentError("A MIME header name is invalid.");
    headers.push({ name, lowerName: name.toLowerCase(), value: line.slice(colon + 1).trim(), rawLines: [line] });
  }
  if (requireBodySeparator && !headers.length) contentError("Raw content must contain at least one header.");
  return { headers, body: value.subarray(separator.index + separator.length) };
}

function firstHeader(headers: ParsedHeader[], name: string): ParsedHeader | undefined {
  return headers.find(header => header.lowerName === name.toLowerCase());
}

function allHeaders(headers: ParsedHeader[], name: string): ParsedHeader[] {
  return headers.filter(header => header.lowerName === name.toLowerCase());
}

export interface RawSesAuthorizationHeaders {
  sourceArn?: string;
  fromArn?: string;
  returnPathArn?: string;
}

/**
 * Read authorization-only X-SES fields before normalized MIME strips them.
 * Duplicate fields are rejected instead of creating ambiguous authorization.
 */
export function rawSesAuthorizationHeaders(raw: Uint8Array): RawSesAuthorizationHeaders {
  const entity = parseEntity(Buffer.from(raw));
  const value = (name: string): string | undefined => {
    const matches = allHeaders(entity.headers, name);
    if (matches.length > 1) contentError(`Raw content contains more than one ${name} header.`);
    return matches[0]?.value.trim() || undefined;
  };
  const sourceArn = value("x-ses-source-arn");
  const fromArn = value("x-ses-from-arn");
  const returnPathArn = value("x-ses-return-path-arn");
  return {
    ...(sourceArn ? { sourceArn } : {}),
    ...(fromArn ? { fromArn } : {}),
    ...(returnPathArn ? { returnPathArn } : {}),
  };
}

function splitParameters(value: string): string[] {
  const output: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === "\\") { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === ";") { output.push(value.slice(start, index).trim()); start = index + 1; }
  }
  if (quoted || escaped) contentError("A MIME parameter has an unterminated quoted string.");
  output.push(value.slice(start).trim());
  return output;
}

function unquoteParameter(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  if (!trimmed.endsWith('"')) contentError("A MIME parameter has an unterminated quoted string.");
  return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
}

function parseParameterized(value: string | undefined, fallback: string): { value: string; parameters: Record<string, string> } {
  const parts = splitParameters(value ?? fallback);
  const parameters: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const equals = part.indexOf("=");
    if (equals <= 0) contentError("A MIME parameter is malformed.");
    parameters[part.slice(0, equals).trim().toLowerCase()] = unquoteParameter(part.slice(equals + 1));
  }
  return { value: (parts[0] || fallback).toLowerCase(), parameters };
}

function decodeQuotedPrintable(value: Buffer): Buffer {
  const source = value.toString("latin1");
  const bytes: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "=") { bytes.push(source.charCodeAt(index)); continue; }
    if (source[index + 1] === "\r" && source[index + 2] === "\n") { index += 2; continue; }
    if (source[index + 1] === "\n") { index += 1; continue; }
    const hex = source.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) contentError("Quoted-printable MIME content contains an invalid escape.");
    bytes.push(Number.parseInt(hex, 16));
    index += 2;
  }
  return Buffer.from(bytes);
}

function decodeTransfer(value: Buffer, encodingValue: string | undefined): Buffer {
  const encoding = (encodingValue ?? "7bit").trim().toLowerCase();
  if (encoding === "base64") {
    const compact = value.toString("ascii").replace(/\s/g, "");
    if (compact.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
      return contentError("Base64 MIME content is invalid.");
    }
    return Buffer.from(compact, "base64");
  }
  if (encoding === "quoted-printable") return decodeQuotedPrintable(value);
  if (new Set(["7bit", "8bit", "binary", ""]).has(encoding)) return Buffer.from(value);
  return contentError(`Unsupported Content-Transfer-Encoding ${encoding}.`);
}

function decodeHeaderWords(value: string): string {
  const pattern = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  let matched = false;
  const decoded = value.replace(pattern, (_full, charset: string, mode: string, payload: string) => {
    matched = true;
    let bytes: Buffer;
    if (mode.toLowerCase() === "b") {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) contentError("An RFC 2047 encoded word contains invalid base64.");
      bytes = Buffer.from(payload, "base64");
    } else {
      bytes = decodeQuotedPrintable(Buffer.from(payload.replace(/_/g, " "), "latin1"));
    }
    return decodeCharset(bytes, charset);
  });
  return matched ? decoded.replace(/\?=\s+=\?/g, "?==?") : value;
}

function decodeExtendedParameter(value: string): string {
  const match = value.match(/^([^']*)'[^']*'(.*)$/);
  if (!match) return decodeURIComponent(value);
  const bytes: number[] = [];
  for (let index = 0; index < match[2].length; index += 1) {
    if (match[2][index] === "%") {
      const hex = match[2].slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) contentError("An RFC 2231 parameter contains invalid percent encoding.");
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else bytes.push(match[2].charCodeAt(index));
  }
  return decodeCharset(Buffer.from(bytes), match[1] || "utf-8");
}

function filenameFrom(contentType: ReturnType<typeof parseParameterized>, disposition: ReturnType<typeof parseParameterized>): string | undefined {
  const extended = disposition.parameters["filename*"] ?? contentType.parameters["name*"];
  if (extended !== undefined) return decodeExtendedParameter(extended);
  const ordinary = disposition.parameters.filename ?? contentType.parameters.name;
  return ordinary === undefined ? undefined : decodeHeaderWords(ordinary);
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  if (!boundary || boundary.length > 200 || /[\r\n\u0000]/.test(boundary)) contentError("A multipart MIME boundary is invalid.");
  const marker = `--${boundary}`;
  const lines = body.toString("latin1").split(/\r?\n/);
  const output: Buffer[] = [];
  let current: string[] | undefined;
  let closed = false;
  for (const line of lines) {
    if (line === marker || line === `${marker}--`) {
      if (current) output.push(Buffer.from(current.join("\r\n"), "latin1"));
      current = line.endsWith("--") ? undefined : [];
      if (line.endsWith("--")) { closed = true; break; }
    } else if (current) current.push(line);
  }
  if (!closed || !output.length) contentError("A multipart MIME body has a missing or empty closing boundary.");
  return output;
}

function extractMime(
  entity: ParsedEntity,
  messageId: string,
  state: MimeExtraction,
  depth: number,
): void {
  if (depth > SES_MAX_MIME_DEPTH) contentError(`MIME nesting exceeds ${SES_MAX_MIME_DEPTH} levels.`);
  state.partCount += 1;
  if (state.partCount > SES_MAX_MIME_PARTS) contentError(`A message can contain at most ${SES_MAX_MIME_PARTS} MIME parts.`);

  const contentType = parseParameterized(firstHeader(entity.headers, "content-type")?.value, "text/plain; charset=us-ascii");
  const disposition = parseParameterized(firstHeader(entity.headers, "content-disposition")?.value, "");
  const transferEncoding = firstHeader(entity.headers, "content-transfer-encoding")?.value;
  if (contentType.value.startsWith("multipart/")) {
    const boundary = contentType.parameters.boundary;
    if (!boundary) contentError("A multipart MIME entity is missing its boundary parameter.");
    for (const part of splitMultipart(entity.body, boundary)) extractMime(parseEntity(part), messageId, state, depth + 1);
    return;
  }

  const decoded = decodeTransfer(entity.body, transferEncoding);
  const filename = filenameFrom(contentType, disposition);
  const isBody = !filename && disposition.value !== "attachment" && (contentType.value === "text/plain" || contentType.value === "text/html");
  if (isBody) {
    const text = decodeCharset(decoded, contentType.parameters.charset ?? "us-ascii");
    if (contentType.value === "text/plain" && state.textBody === undefined) state.textBody = text;
    if (contentType.value === "text/html" && state.htmlBody === undefined) state.htmlBody = text;
    return;
  }

  const ordinal = state.attachments.length;
  const contentId = firstHeader(entity.headers, "content-id")?.value.replace(/^<|>$/g, "");
  state.attachments.push({
    attachmentId: attachmentId(messageId, ordinal, decoded),
    ordinal,
    ...(filename ? { filename } : {}),
    contentType: contentType.value || "application/octet-stream",
    disposition: disposition.value === "inline" ? "inline" : "attachment",
    ...(contentId ? { contentId } : {}),
    content: Uint8Array.from(decoded),
  });
}

function normalizedRawBytes(entity: ParsedEntity, body: Buffer, input: ParseRawMessageInput): Buffer {
  const owned = [
    `Date: ${new Date(input.acceptedAt).toUTCString()}`,
    `Message-ID: ${messageIdHeader(input.messageId, input.region)}`,
  ];
  const retained = entity.headers
    .filter(header => header.lowerName !== "date" && header.lowerName !== "message-id" && !header.lowerName.startsWith("x-ses-"))
    .flatMap(header => header.rawLines);
  return Buffer.concat([
    Buffer.from([...owned, ...retained].join("\r\n") + "\r\n\r\n", "latin1"),
    body,
  ]);
}

function rawRecipients(headers: ParsedHeader[], destinations: string[] | undefined): PreparedRecipient[] {
  const output: PreparedRecipient[] = [];
  const groups: Array<[SesHeaderKind, string]> = [["TO", "to"], ["CC", "cc"], ["BCC", "bcc"]];
  const headerAddresses: Array<{ kind: SesHeaderKind; address: string }> = [];
  for (const [kind, name] of groups) for (const header of allHeaders(headers, name)) {
    for (const address of parseAddressList(decodeHeaderWords(header.value))) headerAddresses.push({ kind, address: address.original });
  }
  for (const value of headerAddresses) {
    output.push({ ordinal: output.length, address: value.address, headerKind: value.kind, isEnvelope: false, origin: "RAW_HEADER" });
  }
  if (destinations !== undefined) {
    for (const destination of destinations) {
      const address = parseMailboxAddress(destination);
      output.push({ ordinal: output.length, address: address.original, isEnvelope: true, origin: "RAW_EXPLICIT_ENVELOPE" });
    }
  } else {
    for (const value of headerAddresses) {
      output.push({ ordinal: output.length, address: value.address, headerKind: value.kind, isEnvelope: true, origin: "RAW_DERIVED_ENVELOPE" });
    }
  }
  validateRecipientAddresses(output);
  return output;
}

/**
 * Parse and normalize a bounded caller-supplied raw message while preserving its
 * exact original bytes. This parser performs no I/O and never resolves content.
 */
export function parseRawMessage(input: ParseRawMessageInput): PreparedSesMessage {
  const originalRaw = Buffer.from(input.raw);
  validateMessageSize(originalRaw, input.apiFamily);
  validateMimeLineLengths(originalRaw);
  const entity = parseEntity(originalRaw);
  const fromHeaders = allHeaders(entity.headers, "from");
  if (fromHeaders.length !== 1) contentError("Raw content must contain exactly one From header.");
  const from = parseAddressList(decodeHeaderWords(fromHeaders[0].value));
  if (from.length !== 1) contentError("The raw From header must contain exactly one mailbox.");
  const source = input.source ? parseMailboxAddress(input.source) : from[0];
  const replyTo = allHeaders(entity.headers, "reply-to").flatMap(header => parseAddressList(decodeHeaderWords(header.value)).map(value => value.original));
  const recipients = rawRecipients(entity.headers, input.destinations);
  const extraction: MimeExtraction = { attachments: [], partCount: 0 };
  extractMime(entity, input.messageId, extraction, 0);
  const normalizedRaw = normalizedRawBytes(entity, entity.body, input);
  validateMessageSize(normalizedRaw, input.apiFamily);
  validateMimeLineLengths(normalizedRaw);
  const subject = firstHeader(entity.headers, "subject");
  const normalizedHeaders: PreparedHeader[] = [
    { name: "Date", value: new Date(input.acceptedAt).toUTCString() },
    { name: "Message-ID", value: messageIdHeader(input.messageId, input.region) },
    ...entity.headers
      .filter(header => header.lowerName !== "date" && header.lowerName !== "message-id" && !header.lowerName.startsWith("x-ses-"))
      .map(header => ({ name: header.name, value: decodeHeaderWords(header.value) })),
  ];
  const message: PreparedSesMessage = {
    messageId: input.messageId,
    acceptedAt: input.acceptedAt,
    accountId: input.accountId,
    region: input.region,
    apiFamily: input.apiFamily,
    operation: input.operation,
    ...(input.originService ? { originService: input.originService } : {}),
    source: source.address,
    ...(input.returnPath ? { returnPath: parseMailboxAddress(input.returnPath).address } : {}),
    replyTo,
    recipients,
    renderStatus: "RENDERED",
    localDisposition: input.localDisposition ?? "CAPTURED",
    ...(subject ? { subject: decodeHeaderWords(subject.value) } : {}),
    ...(extraction.textBody !== undefined ? { textBody: extraction.textBody } : {}),
    ...(extraction.htmlBody !== undefined ? { htmlBody: extraction.htmlBody } : {}),
    originalRaw,
    normalizedRaw,
    headers: normalizedHeaders,
    attachments: extraction.attachments,
    ...(input.configurationSetName ? { configurationSetName: input.configurationSetName } : {}),
    messageTags: { ...(input.messageTags ?? {}) },
    ...(input.templateName ? { templateName: input.templateName } : {}),
    ...(input.tenantName ? { tenantName: input.tenantName } : {}),
    ...(input.verificationIntentId ? { verificationIntentId: input.verificationIntentId } : {}),
  };
  validatePreparedMessage(message);
  return message;
}

/** Compatibility entry point for callers that name the assembler by artifact. */
export const buildSimpleMime = buildSimpleMessage;

/** Byte-first convenience entry point for raw protocol adapters. */
export function parseRawMime(
  bytes: Uint8Array,
  options: Omit<ParseRawMessageInput, "raw">,
): PreparedSesMessage {
  return parseRawMessage({ ...options, raw: bytes });
}

export { decodeHeaderWords as decodeMimeHeaderWords };
