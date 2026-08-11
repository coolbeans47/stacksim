import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { MailboxError, MailboxStore, calculateLogicalBytes } from "../src/ses/mailbox-store.js";
import { buildSimpleMime, type BuildSimpleMessageInput } from "../src/ses/mime.js";

const roots: string[] = [];
const stores: MailboxStore[] = [];
const acceptedAt = Date.UTC(2026, 6, 23, 12, 0, 0);

async function store(options: { maximumMessages?: number; maximumBytes?: number } = {}): Promise<{ root: string; mailbox: MailboxStore }> {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ses-mailbox-"));
  roots.push(root);
  const mailbox = new MailboxStore({
    root,
    accountId: "000000000000",
    region: "eu-west-1",
    ...options,
  });
  await mailbox.start();
  stores.push(mailbox);
  return { root, mailbox };
}

function message(id: string, overrides: Partial<BuildSimpleMessageInput> = {}) {
  return buildSimpleMime({
    messageId: id,
    acceptedAt,
    accountId: "000000000000",
    region: "eu-west-1",
    apiFamily: "ses-v2",
    operation: "SendEmail",
    source: "Sender <sender@example.com>",
    destination: { to: ["Alice <Alice@Example.com>", "alice@example.com"], cc: ["cc@example.com"] },
    subject: `Subject ${id}`,
    textBody: `Body ${id}`,
    attachments: [{ filename: `${id}.txt`, contentType: "text/plain", content: Buffer.from(`attachment ${id}`) }],
    ...overrides,
  });
}

afterEach(async () => {
  while (stores.length) stores.pop()!.close();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

test("atomic capture stores one logical message, authoritative recipient occurrences, content, quota, and usage", async () => {
  const { mailbox } = await store();
  const prepared = message("message-1");
  const captured = mailbox.capture(prepared);
  assert.equal(captured.inserted, true);
  assert.equal(captured.logicalBytes, calculateLogicalBytes(prepared));
  assert.deepEqual(mailbox.usage(), {
    messageCount: 1,
    logicalBytes: captured.logicalBytes,
    purgeGeneration: 0,
  });
  assert.equal(mailbox.recipientCountSince(acceptedAt - 1), 3, "repeated envelope occurrences count independently");

  const page = mailbox.list({ recipient: "ALICE@example.COM" });
  assert.equal(page.messages.length, 1, "recipient filtering returns one logical message despite repeated occurrences");
  assert.equal(page.messages[0].attachmentCount, 1);
  assert.deepEqual(page.messages[0].envelopeRecipients, [
    "Alice <Alice@Example.com>", "alice@example.com", "cc@example.com",
  ]);
  const detail = mailbox.detail("message-1")!;
  assert.equal(detail.textBody, "Body message-1");
  assert.equal(detail.recipients.filter(recipient => recipient.isEnvelope).length, 3);
  assert.equal(detail.attachments[0].filename, "message-1.txt");
  assert.deepEqual(Buffer.from(mailbox.getRaw("message-1")!), Buffer.from(prepared.normalizedRaw!));
  assert.deepEqual(Buffer.from(mailbox.getAttachment("message-1", detail.attachments[0].attachmentId)!.content), Buffer.from("attachment message-1"));
  assert.throws(() => mailbox.capture(prepared), (error: unknown) => error instanceof MailboxError && error.code === "Duplicate");
  assert.equal(mailbox.usage().messageCount, 1);
});

test("verification capture is idempotent and a failed outbox insert rolls the whole transaction back", async () => {
  const { mailbox } = await store();
  const verification = message("verification-message", {
    verificationIntentId: "verification-intent-1",
    originService: "ses-verification",
  });
  const first = mailbox.capture(verification, { recipientOccurrences: 0 });
  const replay = mailbox.capture(verification, { recipientOccurrences: 0 });
  assert.equal(first.inserted, true);
  assert.equal(replay.inserted, false);
  assert.equal(first.captureId, replay.captureId);
  assert.equal(mailbox.recipientCountSince(0), 0);

  const failed = message("must-rollback");
  assert.throws(() => mailbox.capture(failed, {
    outbox: [{
      outboxId: "same-outbox",
      requestId: "request",
      destinationId: "destination",
      eventOrdinal: 0,
      eventType: "SEND",
      payload: {},
      createdAt: acceptedAt,
    }, {
      outboxId: "same-outbox",
      requestId: "request",
      destinationId: "destination",
      eventOrdinal: 1,
      eventType: "SEND",
      payload: {},
      createdAt: acceptedAt,
    }],
  }), (error: unknown) => error instanceof MailboxError && error.code === "StorageFailure");
  assert.equal(mailbox.detail("must-rollback"), undefined);
  assert.equal(mailbox.usage().messageCount, 1);
  assert.equal(mailbox.recipientCountSince(0), 0, "rolled-back capture leaves no quota event");
});

test("producer delivery keys replay exactly and reject a different authenticated content binding", async () => {
  const { mailbox } = await store();
  const prepared = message("producer-message", { originService: "cognito-idp" });
  const proof = {
    originService: "cognito-idp",
    deliveryKey: "producer_delivery_key_12345678901234567890",
    contentMac: Buffer.alloc(32, 0x11),
  };
  const first = mailbox.capture(prepared, { recipientOccurrences: 0, producer: proof });
  const replay = mailbox.capture(prepared, { recipientOccurrences: 0, producer: proof });
  assert.equal(first.inserted, true);
  assert.deepEqual(replay, { ...first, inserted: false });
  assert.equal(mailbox.usage().messageCount, 1);
  assert.throws(
    () => mailbox.capture(prepared, {
      recipientOccurrences: 0,
      producer: { ...proof, contentMac: Buffer.alloc(32, 0x22) },
    }),
    (error: unknown) => error instanceof MailboxError && error.code === "IdempotencyMismatch",
  );

  mailbox.softDelete(prepared.messageId, acceptedAt + 1);
  mailbox.purge({ messageIds: [prepared.messageId] });
  assert.equal(mailbox.detail(prepared.messageId), undefined);
  assert.deepEqual(
    mailbox.capture(prepared, { recipientOccurrences: 0, producer: proof }),
    { ...first, inserted: false },
    "purging captured content cannot turn an accepted producer delivery into a duplicate send",
  );
  assert.equal(mailbox.usage().messageCount, 0);
});

test("newest-first keyset traversal has a stable high-water mark and exact unread/trash state", async () => {
  const { mailbox } = await store();
  mailbox.capture(message("older", { acceptedAt: acceptedAt - 1 }));
  mailbox.capture(message("same-a"));
  mailbox.capture(message("same-z"));

  const first = mailbox.list({ pageSize: 1 });
  assert.equal(first.messages.length, 1);
  assert(first.highWater);
  assert(first.next);
  mailbox.capture(message("later", { acceptedAt: acceptedAt + 1_000 }));
  const second = mailbox.list({ pageSize: 10, highWater: first.highWater, after: first.next });
  assert.equal(second.messages.some(item => item.messageId === "later"), false, "later captures do not enter an existing traversal");
  assert.equal(new Set([...first.messages, ...second.messages].map(item => item.messageId)).size, 3);

  const updated = mailbox.update("older", { read: true, deleted: true }, acceptedAt + 2_000)!;
  assert.equal(updated.readAt, acceptedAt + 2_000);
  assert.equal(updated.deletedAt, acceptedAt + 2_000);
  assert.equal(mailbox.list({ status: "unread" }).messages.some(item => item.messageId === "older"), false);
  assert.deepEqual(mailbox.list({ status: "trash" }).messages.map(item => item.messageId), ["older"]);
  mailbox.update("older", { read: false, deleted: false }, acceptedAt + 3_000);
  assert.equal(mailbox.list({ status: "unread" }).messages.some(item => item.messageId === "older"), true);
});

test("soft delete retains capacity, purge is atomic and irreversible, and mailbox state survives restart", async () => {
  const { root, mailbox } = await store();
  const first = mailbox.capture(message("restart-1"));
  mailbox.capture(message("restart-2"));
  mailbox.update("restart-1", { read: true, deleted: true }, acceptedAt + 10);
  assert.equal(mailbox.usage().logicalBytes >= first.logicalBytes, true, "Trash still consumes logical capacity");
  assert.throws(
    () => mailbox.purge({ messageIds: ["restart-1", "restart-2"] }),
    (error: unknown) => error instanceof MailboxError && error.code === "Conflict",
  );
  assert(mailbox.detail("restart-1"));
  assert(mailbox.detail("restart-2"));

  const generation = mailbox.usage().purgeGeneration;
  const purged = mailbox.purge({ messageIds: ["restart-1", "already-absent"] });
  assert.equal(purged.purged, 1);
  assert.equal(purged.purgeGeneration, generation + 1);
  assert.equal(mailbox.detail("restart-1"), undefined);
  assert.equal(mailbox.recipientCountSince(0), 6, "purge retains historical quota events");
  const noOp = mailbox.purge({ messageIds: ["restart-1"] });
  assert.equal(noOp.purged, 0);
  assert.equal(noOp.purgeGeneration, purged.purgeGeneration);

  mailbox.update("restart-2", { read: true }, acceptedAt + 20);
  mailbox.close();
  const restarted = new MailboxStore({ root, accountId: "000000000000", region: "eu-west-1" });
  await restarted.start();
  stores.push(restarted);
  assert.equal(restarted.detail("restart-2")?.readAt, acceptedAt + 20);
  assert.equal(restarted.usage().messageCount, 1);
  assert.equal(restarted.usage().purgeGeneration, purged.purgeGeneration);
});

test("capacity and rolling quota failures commit no partial message, usage, or quota mutation", async () => {
  const capacityHarness = await store({ maximumMessages: 1 });
  capacityHarness.mailbox.capture(message("capacity-1"));
  assert.throws(
    () => capacityHarness.mailbox.capture(message("capacity-2")),
    (error: unknown) => error instanceof MailboxError && error.code === "CapacityExceeded",
  );
  assert.equal(capacityHarness.mailbox.usage().messageCount, 1);
  assert.equal(capacityHarness.mailbox.detail("capacity-2"), undefined);

  const quotaHarness = await store();
  quotaHarness.mailbox.capture(message("quota-1"), {
    quotaWindows: [{ windowMs: 24 * 60 * 60 * 1_000, maximumRecipients: 3 }],
  });
  assert.throws(
    () => quotaHarness.mailbox.capture(message("quota-2", { acceptedAt: acceptedAt + 1 }), {
      quotaWindows: [{ windowMs: 24 * 60 * 60 * 1_000, maximumRecipients: 3 }],
    }),
    (error: unknown) => error instanceof MailboxError && error.code === "QuotaExceeded",
  );
  assert.equal(quotaHarness.mailbox.usage().messageCount, 1);
  assert.equal(quotaHarness.mailbox.recipientCountSince(0), 3);
  assert.equal(quotaHarness.mailbox.detail("quota-2"), undefined);
});

test("recipient suggestions escape SQL patterns and count distinct non-Trash messages", async () => {
  const { mailbox } = await store();
  mailbox.capture(message("suggestion-1", { destination: { to: ["literal%_user@example.com", "literal%_user@example.com"] } }));
  mailbox.capture(message("suggestion-2", { destination: { to: ["literal-other@example.com"] } }));
  assert.deepEqual(mailbox.recipientSuggestions("literal%_"), [{ address: "literal%_user@example.com", messageCount: 1 }]);
  mailbox.softDelete("suggestion-1", acceptedAt + 1);
  assert.deepEqual(mailbox.recipientSuggestions("literal%_"), []);
});
