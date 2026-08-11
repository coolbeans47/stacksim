import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GetIdentityVerificationAttributesCommand,
  SESClient,
  SendEmailCommand,
  SendRawEmailCommand,
  VerifyEmailIdentityCommand,
} from "@aws-sdk/client-ses";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

interface InboxSummary {
  messageId: string;
  operation: string;
  apiFamily: string;
  subject?: string;
}

interface InboxDetail {
  messageId: string;
  operation: string;
  apiFamily: string;
  source: string;
  subject?: string;
  textBody?: string;
  recipients: Array<{ address: string; isEnvelope: boolean; origin: string }>;
  hasOriginalRaw: boolean;
}

async function jsonResponse<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (response.status !== 200) assert.fail(`GET ${url} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function consumeVerification(endpoint: string, identity: string): Promise<string> {
  const inbox = await jsonResponse<{ messages: InboxSummary[] }>(
    `${endpoint}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(identity)}`,
  );
  const summary = inbox.messages.find(message => message.operation === "VerifyEmailIdentity");
  assert(summary, "creating an email identity should atomically capture its verification email");
  const detail = await jsonResponse<{ message: InboxDetail }>(
    `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(summary.messageId)}`,
  );
  const link = detail.message.textBody?.match(/https?:\/\/[^\s<]+/)?.[0];
  assert(link, "verification email should contain the local callback URL");
  const callback = await fetch(link, { redirect: "manual" });
  assert.equal(callback.status, 303);
  const location = callback.headers.get("location");
  assert(location);
  const result = await fetch(new URL(location, endpoint));
  assert.equal(result.status, 200);
  assert.match(await result.text(), /verified/i);
  return summary.messageId;
}

test("SES v1 official client verifies an identity and sends simple and raw messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ses-v1-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
  });
  let client: SESClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    client = new SESClient({ endpoint, region, credentials });
    const identity = "v1-sender@example.com";

    await assert.rejects(
      client.send(new SendEmailCommand({
        Source: identity,
        Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
        Message: {
          Subject: { Data: "must be rejected" },
          Body: { Text: { Data: "unverified source" } },
        },
      })),
      (error: unknown) => {
        assert.equal((error as { name?: string }).name, "MessageRejected");
        return true;
      },
    );

    await client.send(new VerifyEmailIdentityCommand({ EmailAddress: identity }));
    await consumeVerification(endpoint, identity);
    const verification = await client.send(new GetIdentityVerificationAttributesCommand({
      Identities: [identity],
    }));
    const verificationStatus = verification.VerificationAttributes?.[identity]?.VerificationStatus;

    const simple = await client.send(new SendEmailCommand({
      Source: `V1 Sender <${identity}>`,
      Destination: {
        ToAddresses: ["Success <success@simulator.amazonses.com>"],
        CcAddresses: ["complaint@simulator.amazonses.com"],
        BccAddresses: ["bounce@simulator.amazonses.com"],
      },
      ReplyToAddresses: ["reply@example.com"],
      Message: {
        Subject: { Data: "SES v1 simple \u2713", Charset: "UTF-8" },
        Body: {
          Text: { Data: "plain v1 body", Charset: "UTF-8" },
          Html: { Data: "<p>html v1 body</p>", Charset: "UTF-8" },
        },
      },
      Tags: [{ Name: "suite", Value: "v1" }],
    }));
    assert.match(simple.MessageId ?? "", /^[0-9a-f-]{36}$/i);

    const rawBytes = Buffer.from([
      `From: Raw Sender <${identity}>`,
      "To: Header Only <header-only@example.com>",
      "Subject: SES v1 raw",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "raw v1 body",
    ].join("\r\n"), "utf8");
    const raw = await client.send(new SendRawEmailCommand({
      Source: identity,
      Destinations: ["success@simulator.amazonses.com"],
      RawMessage: { Data: rawBytes },
    }));
    assert.match(raw.MessageId ?? "", /^[0-9a-f-]{36}$/i);

    const filtered = await jsonResponse<{ messages: InboxSummary[] }>(
      `${endpoint}/_stacksim/api/ses/inbox?recipient=SUCCESS%40SIMULATOR.AMAZONSES.COM`,
    );
    assert.deepEqual(
      new Set(filtered.messages.map(message => message.messageId)),
      new Set([simple.MessageId!, raw.MessageId!]),
      "recipient filtering is case-insensitive and returns one row per logical message",
    );
    const headerOnly = await jsonResponse<{ messages: InboxSummary[] }>(
      `${endpoint}/_stacksim/api/ses/inbox?recipient=header-only%40example.com`,
    );
    assert.equal(headerOnly.messages.some(message => message.messageId === raw.MessageId), false,
      "explicit raw destinations are authoritative for Inbox recipient filtering");

    const simpleDetail = await jsonResponse<{ message: InboxDetail }>(
      `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(simple.MessageId!)}`,
    );
    assert.equal(simpleDetail.message.apiFamily, "ses-v1");
    assert.equal(simpleDetail.message.subject, "SES v1 simple \u2713");
    assert.equal(simpleDetail.message.textBody, "plain v1 body");
    assert.equal(simpleDetail.message.recipients.filter(recipient => recipient.isEnvelope).length, 3);

    const rawDetail = await jsonResponse<{ message: InboxDetail }>(
      `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(raw.MessageId!)}`,
    );
    assert.equal(rawDetail.message.hasOriginalRaw, true);
    assert.equal(rawDetail.message.subject, "SES v1 raw");
    const original = await fetch(
      `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(raw.MessageId!)}/raw?variant=original`,
    );
    assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), rawBytes);
    assert.equal(verificationStatus, "Success",
      "SES v1 uses the modeled PascalCase VerificationStatus wire values");
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SES v1 Query responses use the 2010-12-01 XML namespace and modeled errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ses-v1-wire-"));
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
    const success = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        Action: "GetAccountSendingEnabled",
        Version: "2010-12-01",
      }),
    });
    const successBody = await success.text();
    assert.equal(success.status, 200);
    assert.match(success.headers.get("x-amzn-requestid") ?? "", /^[0-9a-f]{32}$/i);
    assert.match(successBody, /xmlns="http:\/\/ses\.amazonaws\.com\/doc\/2010-12-01\/"/);
    assert.match(successBody, /<Enabled>true<\/Enabled>/);

    const failure = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        Action: "SendEmail",
        Version: "2010-12-01",
        Source: "unverified@example.com",
        "Destination.ToAddresses.member.1": "success@simulator.amazonses.com",
        "Message.Subject.Data": "rejected",
        "Message.Body.Text.Data": "body",
      }),
    });
    const failureBody = await failure.text();
    assert.equal(failure.status, 400);
    assert.match(failure.headers.get("x-amzn-requestid") ?? "", /^[0-9a-f]{32}$/i);
    assert.match(failureBody, /<Code>MessageRejected<\/Code>/);
    assert.match(failureBody, /xmlns="http:\/\/ses\.amazonaws\.com\/doc\/2010-12-01\/"/);
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
