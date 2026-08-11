import assert from "node:assert/strict";
import dns from "node:dns";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import tls from "node:tls";
import {
  AttachRolePolicyCommand,
  CreatePolicyCommand,
  CreateRoleCommand,
  IAMClient,
} from "@aws-sdk/client-iam";
import {
  SESClient,
  SendEmailCommand as SendEmailV1Command,
  SendRawEmailCommand,
  SendTemplatedEmailCommand,
} from "@aws-sdk/client-ses";
import {
  CreateEmailIdentityCommand,
  CreateEmailTemplateCommand,
  GetEmailIdentityCommand,
  SESv2Client,
  SendEmailCommand as SendEmailV2Command,
  TagResourceCommand,
} from "@aws-sdk/client-sesv2";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { StackSim } from "../src/server.js";
import { signedFetch } from "./helpers/signed-fetch.js";

const accountId = "000000000000";
const region = "eu-west-1";
const adminCredentials = { accessKeyId: "admin", secretAccessKey: "password" };

interface InboxSummary {
  messageId: string;
  operation: string;
}

interface InboxDetail {
  textBody?: string;
}

function endpointFor(simulator: StackSim): string {
  return `http://127.0.0.1:${simulator.port}`;
}

function policyDocument(Statement: unknown[]): string {
  return JSON.stringify({ Version: "2012-10-17", Statement });
}

async function jsonResponse<T>(url: string): Promise<T> {
  const response = await signedFetch(url, { service: "ses", region, credentials: adminCredentials, headers: { "x-stacksim-region": region } });
  if (response.status !== 200) assert.fail(`GET ${url} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function consumeVerification(endpoint: string, identity: string): Promise<void> {
  const inbox = await jsonResponse<{ messages: InboxSummary[] }>(
    `${endpoint}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(identity)}`,
  );
  const verification = inbox.messages.find(message => message.operation === "VerifyEmailIdentity");
  assert(verification, `verification message for ${identity} was not captured`);
  const detail = await jsonResponse<{ message: InboxDetail }>(
    `${endpoint}/_stacksim/api/ses/inbox/${encodeURIComponent(verification.messageId)}`,
  );
  const link = detail.message.textBody?.match(/https?:\/\/[^\s<]+/)?.[0];
  assert(link, `verification message for ${identity} did not contain a callback URL`);
  const callback = await fetch(link, { redirect: "manual" });
  assert.equal(callback.status, 303);
  const location = callback.headers.get("location");
  assert(location);
  const result = await fetch(new URL(location, endpoint));
  assert.equal(result.status, 200);
}

async function rejectionName(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { name?: string }).name;
  }
}

test("SES IAM enforcement honors identity ARNs, request tags, and persisted resource tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ses-iam-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "enforce",
    cdkBootstrap: true,
    sesMaxSendRate: 100,
  });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const endpoint = endpointFor(simulator);
    const rootSes = new SESv2Client({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    const iam = new IAMClient({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    const sts = new STSClient({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    clients.push(rootSes, iam, sts);

    const sender = "iam-sender@example.com";
    const senderArn = `arn:aws:ses:${region}:${accountId}:identity/${sender}`;
    const roleCreated = "role-created@example.com";
    const roleCreatedArn = `arn:aws:ses:${region}:${accountId}:identity/${roleCreated}`;
    await rootSes.send(new CreateEmailIdentityCommand({
      EmailIdentity: sender,
      Tags: [{ Key: "environment", Value: "dev" }],
    }));
    await consumeVerification(endpoint, sender);

    const roleName = "ses-scoped-sender";
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: policyDocument([{
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${accountId}:root` },
        Action: "sts:AssumeRole",
      }]),
    }));
    const policy = await iam.send(new CreatePolicyCommand({
      PolicyName: "ScopedSesIdentityAccess",
      PolicyDocument: policyDocument([
        {
          Effect: "Allow",
          Action: ["ses:GetEmailIdentity", "ses:SendEmail"],
          Resource: senderArn,
          Condition: { StringEquals: { "aws:ResourceTag/environment": "dev" } },
        },
        {
          Effect: "Allow",
          Action: ["ses:CreateEmailIdentity", "ses:TagResource"],
          Resource: roleCreatedArn,
          Condition: { StringEquals: { "aws:RequestTag/environment": "dev" } },
        },
        {
          Effect: "Allow",
          Action: "ses:GetEmailIdentity",
          Resource: roleCreatedArn,
          Condition: { StringEquals: { "aws:ResourceTag/environment": "dev" } },
        },
      ]),
    }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policy.Policy!.Arn! }));
    const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: "ses-security" }));
    const roleSes = new SESv2Client({
      endpoint,
      region,
      credentials: {
        accessKeyId: assumed.Credentials!.AccessKeyId!,
        secretAccessKey: assumed.Credentials!.SecretAccessKey!,
        sessionToken: assumed.Credentials!.SessionToken!,
      },
      maxAttempts: 1,
    });
    clients.push(roleSes);

    assert.equal((await roleSes.send(new GetEmailIdentityCommand({ EmailIdentity: sender }))).VerifiedForSendingStatus, true);
    const allowed = await roleSes.send(new SendEmailV2Command({
      FromEmailAddress: sender,
      Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
      Content: {
        Simple: {
          Subject: { Data: "authorized" },
          Body: { Text: { Data: "resource-tag scoped send" } },
        },
      },
    }));
    assert(allowed.MessageId);

    await assert.rejects(
      roleSes.send(new CreateEmailIdentityCommand({
        EmailIdentity: roleCreated,
        Tags: [{ Key: "environment", Value: "prod" }],
      })),
      (error: any) => error.name === "AccessDeniedException",
    );
    await assert.rejects(
      rootSes.send(new GetEmailIdentityCommand({ EmailIdentity: roleCreated })),
      (error: any) => error.name === "NotFoundException",
      "a request-tag authorization failure must happen before identity and verification-mail mutation",
    );

    await roleSes.send(new CreateEmailIdentityCommand({
      EmailIdentity: roleCreated,
      Tags: [{ Key: "environment", Value: "dev" }],
    }));
    assert.equal((await roleSes.send(new GetEmailIdentityCommand({ EmailIdentity: roleCreated }))).VerifiedForSendingStatus, false);

    await rootSes.send(new TagResourceCommand({
      ResourceArn: roleCreatedArn,
      Tags: [{ Key: "environment", Value: "prod" }],
    }));
    await assert.rejects(
      roleSes.send(new GetEmailIdentityCommand({ EmailIdentity: roleCreated })),
      (error: any) => error.name === "AccessDeniedException",
      "authorization must use current persisted resource tags",
    );
    await assert.rejects(
      roleSes.send(new SendEmailV2Command({
        FromEmailAddress: roleCreated,
        Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
        Content: {
          Simple: {
            Subject: { Data: "denied" },
            Body: { Text: { Data: "must not reach source validation or capture" } },
          },
        },
      })),
      (error: any) => error.name === "AccessDeniedException",
    );

    const decisions = simulator.store.ensureAccount().iam.authorizationDecisions;
    assert(decisions.some(decision => decision.action === "ses:SendEmail" && decision.resource === senderArn && decision.decision === "allowed"));
    assert(decisions.some(decision => decision.action === "ses:CreateEmailIdentity" && decision.resource === roleCreatedArn && decision.decision !== "allowed"));
    assert(decisions.some(decision => decision.action === "ses:GetEmailIdentity" && decision.resource === roleCreatedArn && decision.decision !== "allowed"));
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SES v1, v2, and raw X-SES headers reject delegated identity ARNs that do not match the From identity before capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ses-delegated-arn-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    sesMaxSendRate: 100,
  });
  let v1: SESClient | undefined;
  let v2: SESv2Client | undefined;
  try {
    await simulator.start();
    const endpoint = endpointFor(simulator);
    v1 = new SESClient({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    v2 = new SESv2Client({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    const sender = "delegated-sender@example.com";
    await v2.send(new CreateEmailIdentityCommand({ EmailIdentity: sender }));
    await consumeVerification(endpoint, sender);
    const mismatchedArn = `arn:aws:ses:${region}:${accountId}:identity/different@example.com`;
    const before = simulator.ses.summary().messageCount;

    const v2Error = await rejectionName(v2.send(new SendEmailV2Command({
      FromEmailAddress: sender,
      FromEmailAddressIdentityArn: mismatchedArn,
      Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
      Content: {
        Simple: {
          Subject: { Data: "mismatched delegated identity" },
          Body: { Text: { Data: "must not be captured" } },
        },
      },
    })));
    const v1Error = await rejectionName(v1.send(new SendEmailV1Command({
      Source: sender,
      SourceArn: mismatchedArn,
      Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
      Message: {
        Subject: { Data: "mismatched delegated identity" },
        Body: { Text: { Data: "must not be captured" } },
      },
    })));
    const rawHeaderError = await rejectionName(v1.send(new SendRawEmailCommand({
      Destinations: ["success@simulator.amazonses.com"],
      RawMessage: {
        Data: Buffer.from([
          `From: ${sender}`,
          "To: success@simulator.amazonses.com",
          `X-SES-SOURCE-ARN: ${mismatchedArn}`,
          "Subject: mismatched raw delegated identity",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "must not be captured",
        ].join("\r\n")),
      },
    })));

    const after = simulator.ses.summary().messageCount;
    const failures = [
      ...(
        v2Error === "BadRequestException" || v2Error === "MessageRejected"
          ? []
          : [`v2 accepted the mismatch or returned ${String(v2Error)}`]
      ),
      ...(
        v1Error === "InvalidParameterValue" || v1Error === "MessageRejected"
          ? []
          : [`v1 accepted the mismatch or returned ${String(v1Error)}`]
      ),
      ...(
        rawHeaderError === "InvalidParameterValue" || rawHeaderError === "MessageRejected"
          ? []
          : [`v1 raw X-SES-SOURCE-ARN mismatch was accepted or returned ${String(rawHeaderError)}`]
      ),
      ...(after === before ? [] : [`Inbox grew from ${before} to ${after}`]),
    ];
    assert.deepEqual(failures, [], failures.join("; "));
  } finally {
    v1?.destroy();
    v2?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("signature-invalid SES verification callbacks do not create regional state or a mailbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ses-invalid-callback-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
  });
  try {
    await simulator.start();
    const routedRegion = "ap-south-1";
    const regionalStateBefore = JSON.stringify(simulator.store.state.accounts[accountId].regions);
    const mailbox = join(root, "data", "ses", accountId, routedRegion, "mailbox.sqlite");
    assert.equal(existsSync(mailbox), false);

    const invalidToken = "attacker-controlled-invalid-token";
    const response = await fetch(
      `${endpointFor(simulator)}/_stacksim/ses/verify-email/${routedRegion}?token=${invalidToken}`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const body = await response.text();
    assert.match(body, /verification link is invalid/i);
    assert.doesNotMatch(body, new RegExp(invalidToken));

    assert.equal(
      JSON.stringify(simulator.store.state.accounts[accountId].regions),
      regionalStateBefore,
      "an untrusted token must be rejected before selecting or creating regional state",
    );
    assert.equal(existsSync(mailbox), false, "an untrusted token must not open a mailbox in its route Region");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

interface NetworkTripwire {
  blocked: string[];
  restore(): void;
}

function installNetworkTripwire(): NetworkTripwire {
  const blocked: string[] = [];
  const original = {
    dnsLookup: dns.lookup,
    dnsPromisesLookup: dns.promises.lookup,
    fetch: globalThis.fetch,
    httpGet: http.get,
    httpRequest: http.request,
    httpsGet: https.get,
    httpsRequest: https.request,
    netConnect: net.connect,
    socketConnect: net.Socket.prototype.connect,
    tlsConnect: tls.connect,
  };

  const normalizedHost = (value: unknown): string => String(value ?? "localhost")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:/, "");
  const isLoopback = (value: unknown): boolean => {
    const host = normalizedHost(value);
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  };
  const reject = (kind: string, host: unknown): never => {
    const description = `${kind}:${normalizedHost(host)}`;
    blocked.push(description);
    const error = new Error(`SES_NETWORK_TRIPWIRE blocked ${description}`);
    (error as NodeJS.ErrnoException).code = "SES_NETWORK_TRIPWIRE";
    throw error;
  };
  const assertLoopback = (kind: string, host: unknown): void => {
    if (!isLoopback(host)) reject(kind, host);
  };
  const requestHost = (args: any[]): unknown => {
    const first = args[0];
    if (first instanceof URL) return first.hostname;
    if (typeof first === "string") {
      try { return new URL(first).hostname; } catch { return args[1]?.hostname ?? args[1]?.host; }
    }
    return first?.hostname ?? first?.host;
  };
  const socketDestination = (args: any[]): { host?: unknown; path?: unknown } => {
    const first = args[0];
    if (first && typeof first === "object") return { host: first.host ?? first.hostname, path: first.path };
    if (typeof first === "string" && !/^\d+$/.test(first)) return { path: first };
    return { host: typeof args[1] === "string" ? args[1] : undefined };
  };

  (dns as any).lookup = function sesDnsLookup(hostname: unknown, ...args: any[]) {
    assertLoopback("dns.lookup", hostname);
    return (original.dnsLookup as any).call(this, hostname, ...args);
  };
  (dns.promises as any).lookup = async function sesDnsPromisesLookup(hostname: unknown, ...args: any[]) {
    assertLoopback("dns.promises.lookup", hostname);
    return (original.dnsPromisesLookup as any).call(this, hostname, ...args);
  };
  (http as any).request = function sesHttpRequest(...args: any[]) {
    assertLoopback("http.request", requestHost(args));
    return (original.httpRequest as any).apply(this, args);
  };
  (http as any).get = function sesHttpGet(...args: any[]) {
    assertLoopback("http.get", requestHost(args));
    return (original.httpGet as any).apply(this, args);
  };
  (https as any).request = function sesHttpsRequest(...args: any[]) {
    assertLoopback("https.request", requestHost(args));
    return (original.httpsRequest as any).apply(this, args);
  };
  (https as any).get = function sesHttpsGet(...args: any[]) {
    assertLoopback("https.get", requestHost(args));
    return (original.httpsGet as any).apply(this, args);
  };
  (net as any).connect = function sesNetConnect(...args: any[]) {
    const destination = socketDestination(args);
    if (destination.path === undefined) assertLoopback("net.connect", destination.host);
    return (original.netConnect as any).apply(this, args);
  };
  (net.Socket.prototype as any).connect = function sesSocketConnect(...args: any[]) {
    const destination = socketDestination(args);
    if (destination.path === undefined) assertLoopback("Socket.connect", destination.host);
    return (original.socketConnect as any).apply(this, args);
  };
  (tls as any).connect = function sesTlsConnect(...args: any[]) {
    const destination = socketDestination(args);
    if (destination.path === undefined) assertLoopback("tls.connect", destination.host);
    return (original.tlsConnect as any).apply(this, args);
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input);
    assertLoopback("fetch", url.hostname);
    return original.fetch(input, init);
  }) as typeof fetch;

  return {
    blocked,
    restore() {
      (dns as any).lookup = original.dnsLookup;
      (dns.promises as any).lookup = original.dnsPromisesLookup;
      globalThis.fetch = original.fetch;
      (http as any).get = original.httpGet;
      (http as any).request = original.httpRequest;
      (https as any).get = original.httpsGet;
      (https as any).request = original.httpsRequest;
      (net as any).connect = original.netConnect;
      (net.Socket.prototype as any).connect = original.socketConnect;
      (tls as any).connect = original.tlsConnect;
    },
  };
}

test("verification, simple, raw, and stored-template sends make no non-loopback network request", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-ses-no-egress-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    sesMaxSendRate: 100,
  });
  let v1: SESClient | undefined;
  let v2: SESv2Client | undefined;
  let tripwire: NetworkTripwire | undefined;
  try {
    await simulator.start();
    const endpoint = endpointFor(simulator);
    v1 = new SESClient({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    v2 = new SESv2Client({ endpoint, region, credentials: adminCredentials, maxAttempts: 1 });
    tripwire = installNetworkTripwire();

    const sender = "no-egress@example.com";
    await v2.send(new CreateEmailIdentityCommand({ EmailIdentity: sender }));
    await consumeVerification(endpoint, sender);

    const simple = await v2.send(new SendEmailV2Command({
      FromEmailAddress: sender,
      Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
      Content: {
        Simple: {
          Subject: { Data: "no egress simple" },
          Body: { Text: { Data: "captured locally" } },
        },
      },
    }));
    assert(simple.MessageId);

    const raw = await v1.send(new SendRawEmailCommand({
      Source: sender,
      Destinations: ["success@simulator.amazonses.com"],
      RawMessage: {
        Data: Buffer.from([
          `From: ${sender}`,
          "To: success@simulator.amazonses.com",
          "Subject: no egress raw",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "captured locally",
        ].join("\r\n")),
      },
    }));
    assert(raw.MessageId);

    const templateName = "NoEgressStoredTemplate";
    await v2.send(new CreateEmailTemplateCommand({
      TemplateName: templateName,
      TemplateContent: {
        Subject: "no egress template {{name}}",
        Text: "captured locally for {{name}}",
      },
    }));
    const templated = await v1.send(new SendTemplatedEmailCommand({
      Source: sender,
      Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
      Template: templateName,
      TemplateData: JSON.stringify({ name: "Ada" }),
    }));
    assert(templated.MessageId);

    assert.deepEqual(tripwire.blocked, []);
    assert.equal(simulator.ses.summary().messageCount, 4, "verification plus three representative sends should be captured locally");
  } finally {
    tripwire?.restore();
    v1?.destroy();
    v2?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
