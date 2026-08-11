import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { StackSim } from "../src/server.js";
import { MailboxError } from "../src/ses/mailbox-store.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test("verification capture recovers once after a crash-shaped post-state storage failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ses-recovery-"));
  const port = await unusedPort();
  const identity = "recovery@example.com";
  let simulator: StackSim | undefined;
  let client: SESv2Client | undefined;
  try {
    simulator = new StackSim({
      port,
      invokePort: 0,
      dataDir: root,
      region,
      authMode: "off",
      cloudFormationCustomResourceCallbackPort: 0,
      sesPublicUrl: `http://127.0.0.1:${port}`,
    });
    await simulator.start();
    client = new SESv2Client({ endpoint: `http://127.0.0.1:${port}`, region, credentials, maxAttempts: 1 });

    const mailbox = (simulator.ses as any).mailbox;
    const capture = mailbox.capture.bind(mailbox);
    let injected = false;
    mailbox.capture = (...args: any[]) => {
      if (!injected) {
        injected = true;
        throw new MailboxError("StorageFailure", "injected post-state verification capture failure");
      }
      return capture(...args);
    };
    await assert.rejects(
      client.send(new CreateEmailIdentityCommand({ EmailIdentity: identity })),
      (error: any) => error.name === "ServiceUnavailableException",
    );
    assert.equal(simulator.store.regionState(region).ses.identities[identity]?.verificationStatus, "PENDING");
    assert.equal(
      Object.values(simulator.store.regionState(region).ses.verificationIntents).filter(intent => intent.status === "PENDING_CAPTURE").length,
      1,
    );

    client.destroy();
    client = undefined;
    await simulator.stop();
    simulator = undefined;

    simulator = new StackSim({
      port,
      invokePort: 0,
      dataDir: root,
      region,
      authMode: "off",
      cloudFormationCustomResourceCallbackPort: 0,
      sesPublicUrl: `http://127.0.0.1:${port}`,
    });
    await simulator.start();
    client = new SESv2Client({ endpoint: `http://127.0.0.1:${port}`, region, credentials, maxAttempts: 1 });
    assert.equal((await client.send(new GetEmailIdentityCommand({ EmailIdentity: identity }))).VerifiedForSendingStatus, false);

    const inboxResponse = await fetch(
      `http://127.0.0.1:${port}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(identity)}`,
    );
    assert.equal(inboxResponse.status, 200);
    const inbox = await inboxResponse.json() as { messages: Array<{ messageId: string; operation: string }> };
    const verificationMessages = inbox.messages.filter(message => message.operation === "VerifyEmailIdentity");
    assert.equal(verificationMessages.length, 1);
    assert.equal(
      Object.values(simulator.store.regionState(region).ses.verificationIntents).filter(intent => intent.status === "CAPTURED").length,
      1,
    );
    const detailResponse = await fetch(
      `http://127.0.0.1:${port}/_stacksim/api/ses/inbox/${encodeURIComponent(verificationMessages[0].messageId)}`,
    );
    const detail = await detailResponse.json() as { message: { textBody?: string } };
    const verificationUrl = detail.message.textBody?.match(/https?:\/\/[^\s<]+/)?.[0];
    assert.ok(verificationUrl);
    assert.ok(verificationUrl.startsWith(`http://127.0.0.1:${port}/_stacksim/ses/verify-email/`));
    assert.equal((await fetch(verificationUrl, { redirect: "manual" })).status, 303);
  } finally {
    client?.destroy();
    await simulator?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("verification capacity preflight leaves no dangling identity or intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ses-preflight-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    sesMaximumMailboxMessages: 1,
  });
  let client: SESv2Client | undefined;
  try {
    await simulator.start();
    client = new SESv2Client({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials,
      maxAttempts: 1,
    });
    await client.send(new CreateEmailIdentityCommand({ EmailIdentity: "first@example.com" }));
    await assert.rejects(
      client.send(new CreateEmailIdentityCommand({ EmailIdentity: "no-capacity@example.com" })),
      (error: any) => error.name === "ServiceUnavailableException",
    );
    assert.equal(simulator.store.regionState(region).ses.identities["no-capacity@example.com"], undefined);
    assert.equal(
      Object.values(simulator.store.regionState(region).ses.verificationIntents)
        .some(intent => intent.identity === "no-capacity@example.com"),
      false,
    );
    assert.equal(simulator.ses.summary().messageCount, 1);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
