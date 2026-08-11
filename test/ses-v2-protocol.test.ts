import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  SESv2Client,
  SendEmailCommand,
} from "@aws-sdk/client-sesv2";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

interface InboxSummary {
  messageId: string;
  operation: string;
}

interface InboxDetail {
  messageId: string;
  apiFamily: string;
  operation: string;
  subject?: string;
  textBody?: string;
  headers: Array<{ name: string; value: string }>;
  recipients: Array<{ address: string; isEnvelope: boolean; origin: string }>;
  attachments: Array<{
    attachmentId: string;
    filename?: string;
    contentType: string;
    byteLength: number;
  }>;
  hasOriginalRaw: boolean;
}

async function jsonResponse<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (response.status !== 200) assert.fail(`GET ${url} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function consumeVerification(endpoint: string, identity: string): Promise<void> {
  const inbox = await jsonResponse<{ messages: InboxSummary[] }>(
    `${endpoint}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(identity)}`,
  );
  const summary = inbox.messages.find(message => message.operation === "VerifyEmailIdentity");
  assert(summary);
  const detail = await jsonResponse<{ message: InboxDetail }>(
    `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(summary.messageId)}`,
  );
  const link = detail.message.textBody?.match(/https?:\/\/[^\s<]+/)?.[0];
  assert(link);
  const callback = await fetch(link, { redirect: "manual" });
  assert.equal(callback.status, 303);
  const location = callback.headers.get("location");
  assert(location);
  const result = await fetch(new URL(location, endpoint));
  assert.equal(result.status, 200);
}

test("SES v2 official client verifies an identity and sends simple attachments and raw MIME", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ses-v2-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
  });
  let client: SESv2Client | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    client = new SESv2Client({ endpoint, region, credentials });
    const identity = "v2-sender@example.com";

    await assert.rejects(
      client.send(new SendEmailCommand({
        FromEmailAddress: identity,
        Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
        Content: {
          Simple: {
            Subject: { Data: "must be rejected" },
            Body: { Text: { Data: "unverified source" } },
          },
        },
      })),
      (error: unknown) => {
        assert.equal((error as { name?: string }).name, "MessageRejected");
        return true;
      },
    );

    const created = await client.send(new CreateEmailIdentityCommand({
      EmailIdentity: identity,
      Tags: [{ Key: "suite", Value: "v2" }],
    }));
    assert.equal(created.IdentityType, "EMAIL_ADDRESS");
    assert.equal(created.VerifiedForSendingStatus, false);
    await consumeVerification(endpoint, identity);
    const verified = await client.send(new GetEmailIdentityCommand({ EmailIdentity: identity }));
    assert.equal(verified.VerifiedForSendingStatus, true);

    const attachment = Buffer.from("v2 attachment body", "utf8");
    const simple = await client.send(new SendEmailCommand({
      FromEmailAddress: `V2 Sender <${identity}>`,
      Destination: {
        ToAddresses: ["Success <success@simulator.amazonses.com>"],
        BccAddresses: ["bounce@simulator.amazonses.com"],
      },
      ReplyToAddresses: ["reply@example.com"],
      Content: {
        Simple: {
          Subject: { Data: "SES v2 simple \u2713", Charset: "UTF-8" },
          Body: {
            Text: { Data: "plain v2 body", Charset: "UTF-8" },
            Html: { Data: "<p>html v2 body</p>", Charset: "UTF-8" },
          },
          Headers: [{ Name: "X-Suite", Value: "ses-v2" }],
          Attachments: [{
            RawContent: attachment,
            FileName: "notes.txt",
            ContentType: "text/plain",
            ContentDisposition: "ATTACHMENT",
          }],
        },
      },
      EmailTags: [{ Name: "kind", Value: "simple" }],
    }));
    assert.match(simple.MessageId ?? "", /^[0-9a-f-]{36}$/i);

    const rawBytes = Buffer.from([
      `From: Raw V2 <${identity}>`,
      "To: header-v2@example.com",
      "Subject: SES v2 raw",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "raw v2 body",
    ].join("\r\n"), "utf8");
    const raw = await client.send(new SendEmailCommand({
      FromEmailAddress: identity,
      Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
      Content: { Raw: { Data: rawBytes } },
    }));
    assert.match(raw.MessageId ?? "", /^[0-9a-f-]{36}$/i);

    const detail = await jsonResponse<{ message: InboxDetail }>(
      `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(simple.MessageId!)}`,
    );
    assert.equal(detail.message.apiFamily, "ses-v2");
    assert.equal(detail.message.operation, "SendEmail");
    assert.equal(detail.message.subject, "SES v2 simple \u2713");
    assert.equal(detail.message.textBody, "plain v2 body");
    assert.deepEqual(
      detail.message.headers.find(header => header.name.toLowerCase() === "x-suite"),
      { name: "X-Suite", value: "ses-v2" },
    );
    assert.equal(detail.message.attachments.length, 1);
    assert.equal(detail.message.attachments[0].filename, "notes.txt");
    assert.equal(detail.message.attachments[0].byteLength, attachment.byteLength);
    const downloaded = await fetch(
      `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(simple.MessageId!)}`
      + `/attachments/${encodeURIComponent(detail.message.attachments[0].attachmentId)}`,
    );
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), attachment);

    const rawDetail = await jsonResponse<{ message: InboxDetail }>(
      `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(raw.MessageId!)}`,
    );
    assert.equal(rawDetail.message.hasOriginalRaw, true);
    assert.equal(rawDetail.message.subject, "SES v2 raw");
    const explicit = await jsonResponse<{ messages: InboxSummary[] }>(
      `${endpoint}/_stacksim/api/ses/inbox?recipient=success%40simulator.amazonses.com`,
    );
    assert(explicit.messages.some(message => message.messageId === raw.MessageId));
    const headerOnly = await jsonResponse<{ messages: InboxSummary[] }>(
      `${endpoint}/_stacksim/api/ses/inbox?recipient=header-v2%40example.com`,
    );
    assert.equal(headerOnly.messages.some(message => message.messageId === raw.MessageId), false);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SES v2 REST-JSON routing returns request IDs and modeled malformed-body errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ses-v2-wire-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
  });
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    const account = await fetch(`${endpoint}/v2/email/account`);
    assert.equal(account.status, 200);
    assert.match(account.headers.get("x-amzn-requestid") ?? "", /^[0-9a-f]{32}$/i);
    assert.match(account.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal((await account.json() as { SendingEnabled?: boolean }).SendingEnabled, true);

    const malformed = await fetch(`${endpoint}/v2/email/outbound-emails`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.get("x-amzn-errortype"), "InvalidRequestContentException");
    assert.match(malformed.headers.get("x-amzn-requestid") ?? "", /^[0-9a-f]{32}$/i);
    const body = await malformed.json() as { __type?: string; message?: string };
    assert.equal(body.__type, "InvalidRequestContentException");
    assert.match(body.message ?? "", /parse request body/i);
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
