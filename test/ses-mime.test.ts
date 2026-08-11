import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSimpleMime,
  parseRawMime,
  parseRawMessage,
  type BuildSimpleMessageInput,
} from "../src/ses/mime.js";
import { SesContentError } from "../src/ses/validation.js";

const metadata = {
  messageId: "01020191d5e70000-01234567-89ab-cdef-0123-456789abcdef-000000",
  acceptedAt: Date.UTC(2026, 6, 23, 12, 34, 56),
  accountId: "000000000000",
  region: "eu-west-1",
  apiFamily: "ses-v2" as const,
  operation: "SendEmail",
};

function simple(overrides: Partial<BuildSimpleMessageInput> = {}) {
  return buildSimpleMime({
    ...metadata,
    source: "Málaga Sender <sender@example.com>",
    replyTo: ["Replies <reply@example.com>"],
    destination: {
      to: ["Alice <Alice@Example.com>", "duplicate@example.com"],
      cc: ["duplicate@example.com"],
      bcc: ["Hidden <hidden@example.com>"],
    },
    subject: "Résumé received ✓",
    textBody: "Hello café\nhttp://localhost:3000/confirm?token=a%2Fb#ready",
    htmlBody: "<p>Hello café</p><a href=\"http://localhost:3000/confirm?token=a%2Fb#ready\">Confirm</a>",
    headers: [{ name: "X-Application-ID", value: "order-123" }],
    attachments: [{
      filename: "résumé.txt",
      contentType: "text/plain",
      content: Buffer.from("attachment café", "utf8"),
    }, {
      filename: "pixel.png",
      contentType: "image/png",
      disposition: "inline",
      contentId: "logo",
      content: Buffer.from([0, 1, 2, 3, 254, 255]),
    }],
    ...overrides,
  });
}

test("deterministic simple MIME preserves Unicode, alternatives, envelope Bcc, and attachments", () => {
  const first = simple();
  const second = simple();
  assert.deepEqual(first.normalizedRaw, second.normalizedRaw);
  assert.equal(first.renderStatus, "RENDERED");
  assert.equal(first.localDisposition, "CAPTURED");
  assert.equal(first.recipients.filter(recipient => recipient.isEnvelope).length, 4);
  assert.equal(first.recipients.find(recipient => recipient.headerKind === "BCC")?.address, "Hidden <hidden@example.com>");
  const raw = Buffer.from(first.normalizedRaw!).toString("utf8");
  assert.match(raw, /^Date: Thu, 23 Jul 2026 12:34:56 GMT\r\nMessage-ID: <01020191d5e70000-01234567-89ab-cdef-0123-456789abcdef-000000@eu-west-1\.amazonses\.com>/);
  assert.match(raw, /Content-Type: multipart\/mixed; boundary="=_stacksim_mixed_[a-f0-9]{32}"/);
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="=_stacksim_alt_[a-f0-9]{32}"/);
  assert.doesNotMatch(raw, /^Bcc:/mi, "simple Bcc is authoritative envelope metadata, not a delivered header");
  assert.doesNotMatch(raw, /Résumé received ✓/, "Unicode subject is RFC 2047 encoded");

  const reparsed = parseRawMime(first.normalizedRaw!, {
    ...metadata,
    messageId: `${metadata.messageId}-parsed`,
    destinations: first.recipients.filter(recipient => recipient.isEnvelope).map(recipient => recipient.address),
  });
  assert.equal(reparsed.subject, "Résumé received ✓");
  assert.equal(reparsed.textBody, first.textBody);
  assert.equal(reparsed.htmlBody, first.htmlBody);
  assert.equal(reparsed.attachments.length, 2);
  assert.equal(reparsed.attachments[0].filename, "résumé.txt");
  assert.deepEqual(Buffer.from(reparsed.attachments[0].content), Buffer.from("attachment café", "utf8"));
  assert.equal(reparsed.attachments[1].contentId, "logo");
  assert.deepEqual(Buffer.from(reparsed.attachments[1].content), Buffer.from([0, 1, 2, 3, 254, 255]));
});

test("raw MIME keeps original truth, strips authorization headers only from normalized bytes, and separates header/envelope recipients", () => {
  const encodedSubject = Buffer.from("Invoice café", "utf8").toString("base64");
  const html = Buffer.from("<p>Rendered café</p>", "utf8").toString("base64");
  const raw = Buffer.from([
    "From: Example Sender <sender@example.com>",
    "To: Header Only <header@example.com>",
    "Cc: duplicate@example.com, duplicate@example.com",
    `Subject: =?UTF-8?B?${encodedSubject}?=`,
    "Date: Tue, 01 Jan 2000 00:00:00 GMT",
    "Message-ID: <caller@example.test>",
    "X-SES-SOURCE-ARN: arn:aws:ses:eu-west-1:000000000000:identity/example.com",
    "X-Customer-Trace: preserved",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "--outer",
    'Content-Type: multipart/alternative; boundary="inner"',
    "",
    "--inner",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Plain=20caf=C3=A9",
    "--inner",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    html,
    "--inner--",
    "--outer",
    "Content-Type: application/octet-stream; name*=utf-8''r%C3%A9sum%C3%A9.txt",
    "Content-Disposition: attachment; filename*=utf-8''r%C3%A9sum%C3%A9.txt",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from([0, 1, 2, 253, 254, 255]).toString("base64"),
    "--outer--",
    "",
  ].join("\r\n"), "utf8");

  const message = parseRawMessage({
    ...metadata,
    raw,
    destinations: ["Actual <Actual@Example.com>", "actual@example.com"],
  });
  assert.deepEqual(message.originalRaw, raw);
  assert.equal(message.subject, "Invoice café");
  assert.equal(message.textBody, "Plain café");
  assert.equal(message.htmlBody, "<p>Rendered café</p>");
  assert.equal(message.attachments[0].filename, "résumé.txt");
  assert.deepEqual(Buffer.from(message.attachments[0].content), Buffer.from([0, 1, 2, 253, 254, 255]));

  const headerRows = message.recipients.filter(recipient => recipient.origin === "RAW_HEADER");
  const envelopeRows = message.recipients.filter(recipient => recipient.isEnvelope);
  assert.equal(headerRows.length, 3);
  assert.equal(envelopeRows.length, 2);
  assert.deepEqual(envelopeRows.map(recipient => recipient.address), ["Actual <Actual@Example.com>", "actual@example.com"]);
  const normalized = Buffer.from(message.normalizedRaw!).toString("utf8");
  assert.doesNotMatch(normalized, /X-SES-SOURCE-ARN/i);
  assert.match(normalized, /X-Customer-Trace: preserved/);
  assert.doesNotMatch(normalized, /caller@example\.test/);
  assert.match(normalized, new RegExp(metadata.messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("raw MIME derives ordered repeated envelope occurrences only when explicit destinations are absent", () => {
  const raw = Buffer.from([
    "From: sender@example.com",
    "To: One <same@example.com>, same@example.com",
    "Bcc: hidden@example.com",
    "Subject: recipients",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "body",
  ].join("\r\n"));
  const message = parseRawMessage({ ...metadata, raw });
  const header = message.recipients.filter(recipient => !recipient.isEnvelope);
  const envelope = message.recipients.filter(recipient => recipient.isEnvelope);
  assert.equal(header.length, 3);
  assert.deepEqual(envelope.map(recipient => recipient.address), [
    "One <same@example.com>", "same@example.com", "hidden@example.com",
  ]);
  assert(envelope.every(recipient => recipient.origin === "RAW_DERIVED_ENVELOPE"));
});

test("MIME validation rejects injection, unsupported v1 attachments, recipient overflow, malformed structure, and long lines", () => {
  assert.throws(
    () => simple({ headers: [{ name: "X-Test", value: "ok\r\nBcc: victim@example.com" }] }),
    (error: unknown) => error instanceof SesContentError && error.code === "InvalidHeader",
  );
  assert.throws(
    () => simple({ apiFamily: "ses-v1" }),
    (error: unknown) => error instanceof SesContentError && error.code === "InvalidMime",
  );
  assert.throws(
    () => simple({ attachments: [], destination: { to: Array.from({ length: 51 }, (_, index) => `person${index}@example.com`) } }),
    (error: unknown) => error instanceof SesContentError && error.code === "TooManyRecipients",
  );
  assert.throws(
    () => parseRawMessage({ ...metadata, raw: Buffer.from("From: sender@example.com\r\nno separator") }),
    (error: unknown) => error instanceof SesContentError && error.code === "InvalidMime",
  );
  assert.throws(
    () => parseRawMessage({ ...metadata, raw: Buffer.from([
      "From: sender@example.com",
      "To: recipient@example.com",
      "Content-Transfer-Encoding: base64",
      "",
      "not*base64",
    ].join("\r\n")) }),
    (error: unknown) => error instanceof SesContentError && error.code === "InvalidMime",
  );
  assert.throws(
    () => parseRawMessage({ ...metadata, raw: Buffer.from(`From: sender@example.com\r\nTo: recipient@example.com\r\nX-Long: ${"a".repeat(1_000)}\r\n\r\nbody`) }),
    (error: unknown) => error instanceof SesContentError && error.code === "InvalidMime",
  );
});
