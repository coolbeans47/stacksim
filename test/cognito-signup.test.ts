import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  ResendConfirmationCodeCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { TestClock } from "../src/core/clock.js";
import { StackSim, type SimulatorOptions } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const password = "Valid-password-1!";

function endpoint(simulator: StackSim): string {
  return `http://127.0.0.1:${simulator.port}`;
}

function cognito(simulator: StackSim): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({ endpoint: endpoint(simulator), region, credentials });
}

async function start(
  root: string,
  clock: TestClock,
  overrides: Partial<SimulatorOptions> = {},
): Promise<{ simulator: StackSim; client: CognitoIdentityProviderClient }> {
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    clock,
    ...overrides,
  });
  await simulator.start();
  return { simulator, client: cognito(simulator) };
}

async function inbox(simulator: StackSim, recipient: string): Promise<Array<{ messageId: string }>> {
  const response = await fetch(
    `${endpoint(simulator)}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(recipient)}&status=all&pageSize=100`,
  );
  assert.equal(response.status, 200);
  return (await response.json() as { messages: Array<{ messageId: string }> }).messages;
}

async function messageText(simulator: StackSim, messageId: string): Promise<string> {
  const response = await fetch(
    `${endpoint(simulator)}/_stacksim/api/ses/inbox/${encodeURIComponent(messageId)}`,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { message: { textBody?: string } };
  assert.equal(typeof body.message.textBody, "string");
  return body.message.textBody!;
}

function confirmationCode(text: string): string {
  const match = /\b(\d{6})\b/.exec(text);
  assert(match, "the captured email contains a six-digit confirmation code");
  return match[1];
}

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

async function createEmailPool(
  client: CognitoIdentityProviderClient,
): Promise<{ poolId: string; clientId: string }> {
  const pool = await client.send(new CreateUserPoolCommand({
    PoolName: "signup-pool",
    UsernameAttributes: ["email"],
    AutoVerifiedAttributes: ["email"],
    Schema: [{ Name: "email", Required: true, Mutable: true }],
  }));
  const poolId = pool.UserPool!.Id!;
  const app = await client.send(new CreateUserPoolClientCommand({
    UserPoolId: poolId,
    ClientName: "public-client",
    ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    PreventUserExistenceErrors: "ENABLED",
  }));
  return { poolId, clientId: app.UserPoolClient!.ClientId! };
}

test("Cognito sign-up, resend, confirmation, and secrecy survive restart through the SES Inbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-signup-"));
  const clock = new TestClock(Date.parse("2026-07-24T10:00:00Z"));
  const email = "person@example.com";
  let active: Awaited<ReturnType<typeof start>> | undefined;
  try {
    active = await start(root, clock);
    const { poolId, clientId } = await createEmailPool(active.client);
    const signedUp = await active.client.send(new SignUpCommand({
      ClientId: clientId,
      Username: email,
      Password: password,
    }));
    assert.equal(signedUp.UserConfirmed, false);
    assert.match(signedUp.UserSub ?? "", /^[0-9a-f-]{36}$/);
    assert.deepEqual(signedUp.CodeDeliveryDetails, {
      AttributeName: "email",
      DeliveryMedium: "EMAIL",
      Destination: "p***@e***.com",
    });

    const firstMessages = await inbox(active.simulator, email);
    assert.equal(firstMessages.length, 1);
    const firstCode = confirmationCode(await messageText(active.simulator, firstMessages[0].messageId));
    const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    const persistedStrings = allStrings(persisted);
    assert.equal(persistedStrings.includes(password), false, "the plaintext password is never persisted");
    assert.equal(persistedStrings.includes(firstCode), false, "the plaintext confirmation code is never persisted");
    const firstIntent = Object.values(active.simulator.store.regionState(region).cognito.deliveryIntents)[0];
    assert.deepEqual(Object.keys(firstIntent.credential).sort(), ["codeDigest", "derivationVersion", "kind"]);
    assert.equal(firstIntent.status, "DELIVERED");

    await assert.rejects(
      active.client.send(new ConfirmSignUpCommand({
        ClientId: clientId,
        Username: email,
        ConfirmationCode: firstCode === "000000" ? "000001" : "000000",
      })),
      (error: any) => error?.name === "CodeMismatchException",
    );
    active.client.destroy();
    await active.simulator.stop();

    active = await start(root, clock);
    const resent = await active.client.send(new ResendConfirmationCodeCommand({
      ClientId: clientId,
      Username: email,
    }));
    assert.equal(resent.CodeDeliveryDetails?.DeliveryMedium, "EMAIL");
    const messages = await inbox(active.simulator, email);
    assert.equal(messages.length, 2);
    const secondMessage = messages.find(message => message.messageId !== firstMessages[0].messageId)!;
    const secondCode = confirmationCode(await messageText(active.simulator, secondMessage.messageId));
    assert.notEqual(secondCode, firstCode);

    await assert.rejects(
      active.client.send(new ConfirmSignUpCommand({
        ClientId: clientId,
        Username: email,
        ConfirmationCode: firstCode,
      })),
      (error: any) => error?.name === "CodeMismatchException",
      "the previous code is superseded only after SES accepts the replacement delivery",
    );
    await active.client.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: email,
      ConfirmationCode: secondCode,
    }));
    await assert.rejects(
      active.client.send(new ConfirmSignUpCommand({
        ClientId: clientId,
        Username: email,
        ConfirmationCode: secondCode,
      })),
      (error: any) => error?.name === "NotAuthorizedException",
      "a consumed code cannot confirm the user again",
    );

    const state = active.simulator.store.regionState(region).cognito;
    const user = state.pools[poolId].usersBySub[signedUp.UserSub!];
    assert.equal(user.status, "CONFIRMED");
    assert.equal(user.attributes.email.verified, true);
    assert.equal(user.activeConfirmationIntentId, undefined);
    assert.deepEqual(
      Object.values(state.deliveryIntents).map(intent => intent.status).sort(),
      ["CONSUMED", "SUPERSEDED"],
    );

    active.client.destroy();
    await active.simulator.stop();
    active = await start(root, clock);
    const restarted = active.simulator.store.regionState(region).cognito.pools[poolId].usersBySub[signedUp.UserSub!];
    assert.equal(restarted.status, "CONFIRMED");
    assert.equal(restarted.attributes.email.verified, true);
  } finally {
    active?.client.destroy();
    await active?.simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed resend keeps the delivered code active and confirmation cancels pending recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-resend-failure-"));
  const clock = new TestClock(Date.parse("2026-07-24T11:00:00Z"));
  const email = "fallback@example.com";
  let active: Awaited<ReturnType<typeof start>> | undefined;
  try {
    active = await start(root, clock, { sesMaximumMailboxMessages: 1 });
    const { poolId, clientId } = await createEmailPool(active.client);
    const signedUp = await active.client.send(new SignUpCommand({
      ClientId: clientId,
      Username: email,
      Password: password,
    }));
    const messages = await inbox(active.simulator, email);
    const code = confirmationCode(await messageText(active.simulator, messages[0].messageId));
    const user = active.simulator.store.regionState(region).cognito.pools[poolId].usersBySub[signedUp.UserSub!];
    const originalIntentId = user.activeConfirmationIntentId!;

    await assert.rejects(
      active.client.send(new ResendConfirmationCodeCommand({
        ClientId: clientId,
        Username: email,
      })),
      (error: any) => error?.name === "CodeDeliveryFailureException",
    );
    assert.equal(user.activeConfirmationIntentId, originalIntentId);
    assert.equal(active.simulator.store.regionState(region).cognito.deliveryIntents[originalIntentId].status, "DELIVERED");

    await active.client.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: email,
      ConfirmationCode: code,
    }));
    assert.deepEqual(
      Object.values(active.simulator.store.regionState(region).cognito.deliveryIntents)
        .map(intent => intent.status)
        .sort(),
      ["CANCELLED", "CONSUMED"],
    );

    active.client.destroy();
    await active.simulator.stop();
    active = await start(root, clock, { sesMaximumMailboxMessages: 2 });
    assert.equal((await inbox(active.simulator, email)).length, 1, "restart recovery ignores the cancelled resend");
  } finally {
    active?.client.destroy();
    await active?.simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("post-SES crash recovery replays one delivery and terminal intents expire after seven days", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-post-ses-recovery-"));
  const clock = new TestClock(Date.parse("2026-07-24T12:00:00Z"));
  const email = "post-ses-crash@example.com";
  let active: Awaited<ReturnType<typeof start>> | undefined;
  try {
    active = await start(root, clock);
    const { poolId, clientId } = await createEmailPool(active.client);
    const signedUp = await active.client.send(new SignUpCommand({
      ClientId: clientId,
      Username: email,
      Password: password,
    }));
    const firstMessages = await inbox(active.simulator, email);
    assert.equal(firstMessages.length, 1);
    const state = active.simulator.store.regionState(region).cognito;
    const user = state.pools[poolId].usersBySub[signedUp.UserSub!];
    const intentId = user.activeConfirmationIntentId!;
    const intent = state.deliveryIntents[intentId];
    assert.equal(intent.status, "DELIVERED");

    intent.status = "PENDING_DELIVERY";
    intent.statusUpdatedAt = clock.now();
    user.activeConfirmationIntentId = undefined;
    await active.simulator.store.save();
    active.client.destroy();
    await active.simulator.stop();

    active = await start(root, clock);
    assert.equal(
      (await inbox(active.simulator, email)).length,
      1,
      "SES returns the original message for the persisted producer delivery key",
    );
    const recovered = active.simulator.store.regionState(region).cognito;
    assert.equal(recovered.deliveryIntents[intentId].status, "DELIVERED");
    assert.equal(
      recovered.pools[poolId].usersBySub[signedUp.UserSub!].activeConfirmationIntentId,
      intentId,
    );
    await active.client.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: email,
      ConfirmationCode: confirmationCode(await messageText(active.simulator, firstMessages[0].messageId)),
    }));
    assert.equal(recovered.deliveryIntents[intentId].status, "CONSUMED");

    clock.advance(7 * 24 * 60 * 60 * 1_000);
    active.client.destroy();
    await active.simulator.stop();
    active = await start(root, clock);
    const pruned = active.simulator.store.regionState(region).cognito;
    assert.equal(pruned.deliveryIntents[intentId], undefined);
    assert.deepEqual(pruned.admissions, {}, "expired admission identities are pruned with bounded startup work");
    assert.equal(pruned.pools[poolId].usersBySub[signedUp.UserSub!].status, "CONFIRMED");
  } finally {
    active?.client.destroy();
    await active?.simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
