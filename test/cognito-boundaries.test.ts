import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  GetTokensFromRefreshTokenCommand,
  InitiateAuthCommand,
  ListUserPoolsCommand,
  ResendConfirmationCodeCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const password = "Valid-password-1!";

function endpoint(simulator: StackSim): string {
  return `http://127.0.0.1:${simulator.port}`;
}

function sdk(simulator: StackSim, selectedRegion = region): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({
    endpoint: selectedRegion === region
      ? endpoint(simulator)
      : `${endpoint(simulator)}/_stacksim/cognito-idp/${encodeURIComponent(selectedRegion)}/sdk`,
    region: selectedRegion,
    credentials,
    maxAttempts: 1,
  });
}

async function createClient(
  client: CognitoIdentityProviderClient,
  poolId: string,
  name: string,
  flows: Array<"ALLOW_USER_PASSWORD_AUTH" | "ALLOW_REFRESH_TOKEN_AUTH"> = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ],
  refreshSeconds = 3_600,
): Promise<string> {
  return (await client.send(new CreateUserPoolClientCommand({
    UserPoolId: poolId,
    ClientName: name,
    ExplicitAuthFlows: flows,
    PreventUserExistenceErrors: "ENABLED",
    RefreshTokenValidity: refreshSeconds,
    AccessTokenValidity: 300,
    IdTokenValidity: 300,
    TokenValidityUnits: {
      RefreshToken: "seconds",
      AccessToken: "seconds",
      IdToken: "seconds",
    },
  }))).UserPoolClient!.ClientId!;
}

async function messages(
  simulator: StackSim,
  recipient: string,
): Promise<Array<{ messageId: string; text: string }>> {
  const response = await fetch(
    `${endpoint(simulator)}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(recipient)}&status=all&pageSize=100`,
  );
  assert.equal(response.status, 200);
  const listed = (await response.json() as { messages: Array<{ messageId: string }> }).messages;
  return Promise.all(listed.map(async message => {
    const detail = await fetch(
      `${endpoint(simulator)}/_stacksim/api/ses/inbox/${encodeURIComponent(message.messageId)}`,
    );
    assert.equal(detail.status, 200);
    return {
      messageId: message.messageId,
      text: (await detail.json() as { message: { textBody: string } }).message.textBody,
    };
  }));
}

function code(text: string): string {
  const match = /\b(\d{6})\b/.exec(text);
  assert(match);
  return match[1];
}

async function codeFor(
  simulator: StackSim,
  recipient: string,
  username?: string,
): Promise<string> {
  const matching = (await messages(simulator, recipient))
    .find(message => username === undefined || message.text.includes(username));
  assert(matching);
  return code(matching.text);
}

test("self-sign-up validation, aliases, code limits, expiry, and resend limits are atomic and modeled", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-boundaries-"));
  const clock = new TestClock(Date.parse("2026-07-24T15:00:00Z"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    clock,
  });
  let client = sdk(simulator);
  try {
    await simulator.start();
    client.destroy();
    client = sdk(simulator);

    const disabledPool = await client.send(new CreateUserPoolCommand({
      PoolName: "disabled-signup",
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    }));
    const disabledClient = await createClient(client, disabledPool.UserPool!.Id!, "disabled-client");
    await assert.rejects(
      client.send(new SignUpCommand({
        ClientId: disabledClient,
        Username: "disabled-user",
        Password: password,
        UserAttributes: [{ Name: "email", Value: "disabled@example.com" }],
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    assert.equal(
      Object.keys(simulator.store.regionState(region).cognito.pools[disabledPool.UserPool!.Id!].usersBySub).length,
      0,
    );

    const pool = await client.send(new CreateUserPoolCommand({
      PoolName: "signup-boundaries",
      AliasAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
      VerificationMessageTemplate: {
        DefaultEmailOption: "CONFIRM_WITH_CODE",
        EmailSubject: "Verification code",
        EmailMessage: "Verification code {####} for {username}.",
      },
    }));
    const poolId = pool.UserPool!.Id!;
    const clientId = await createClient(client, poolId, "signup-client");

    await assert.rejects(
      client.send(new SignUpCommand({
        ClientId: clientId,
        Username: "missing-email",
        Password: password,
      })),
      (error: any) => error?.name === "InvalidParameterException",
    );
    await assert.rejects(
      client.send(new SignUpCommand({
        ClientId: clientId,
        Username: "weak-password",
        Password: "weak",
        UserAttributes: [{ Name: "email", Value: "weak@example.com" }],
      })),
      (error: any) => error?.name === "InvalidPasswordException",
    );
    assert.equal(Object.keys(simulator.store.regionState(region).cognito.pools[poolId].usersBySub).length, 0);

    const sharedEmail = "shared@example.com";
    await client.send(new SignUpCommand({
      ClientId: clientId,
      Username: "alice",
      Password: password,
      UserAttributes: [{ Name: "email", Value: sharedEmail }],
    }));
    await assert.rejects(
      client.send(new SignUpCommand({
        ClientId: clientId,
        Username: "alice",
        Password: password,
        UserAttributes: [{ Name: "email", Value: "other@example.com" }],
      })),
      (error: any) => error?.name === "UsernameExistsException",
    );
    await client.send(new SignUpCommand({
      ClientId: clientId,
      Username: "bob",
      Password: password,
      UserAttributes: [{ Name: "email", Value: sharedEmail }],
    }));
    const aliceCode = await codeFor(simulator, sharedEmail, "alice");
    const bobCode = await codeFor(simulator, sharedEmail, "bob");
    await client.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: "alice",
      ConfirmationCode: aliceCode,
    }));
    await assert.rejects(
      client.send(new ConfirmSignUpCommand({
        ClientId: clientId,
        Username: "bob",
        ConfirmationCode: bobCode,
      })),
      (error: any) => error?.name === "AliasExistsException",
    );
    await client.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: "bob",
      ConfirmationCode: bobCode,
      ForceAliasCreation: true,
    }));
    const state = simulator.store.regionState(region).cognito;
    const alice = state.pools[poolId].usersBySub[state.pools[poolId].usernameIndex.alice];
    const bob = state.pools[poolId].usersBySub[state.pools[poolId].usernameIndex.bob];
    assert.equal(state.pools[poolId].aliasIndex[sharedEmail], bob.sub);
    assert.equal(alice.attributes.email.verified, false);
    assert.equal(bob.attributes.email.verified, true);

    const attemptsEmail = "attempts@example.com";
    await client.send(new SignUpCommand({
      ClientId: clientId,
      Username: "attempt-user",
      Password: password,
      UserAttributes: [{ Name: "email", Value: attemptsEmail }],
    }));
    const attemptsCode = await codeFor(simulator, attemptsEmail);
    const wrongCode = attemptsCode === "000000" ? "000001" : "000000";
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await assert.rejects(
        client.send(new ConfirmSignUpCommand({
          ClientId: clientId,
          Username: "attempt-user",
          ConfirmationCode: wrongCode,
        })),
        (error: any) => error?.name === "CodeMismatchException",
      );
    }
    await assert.rejects(
      client.send(new ConfirmSignUpCommand({
        ClientId: clientId,
        Username: "attempt-user",
        ConfirmationCode: wrongCode,
      })),
      (error: any) => error?.name === "LimitExceededException",
    );
    await assert.rejects(
      client.send(new ConfirmSignUpCommand({
        ClientId: clientId,
        Username: "attempt-user",
        ConfirmationCode: attemptsCode,
      })),
      (error: any) => error?.name === "LimitExceededException",
      "the correct code cannot bypass an exhausted attempt budget",
    );
    await client.send(new ResendConfirmationCodeCommand({
      ClientId: clientId,
      Username: "attempt-user",
    }));
    const attemptMessages = await messages(simulator, attemptsEmail);
    const replacementCode = attemptMessages.map(message => code(message.text))
      .find(candidate => candidate !== attemptsCode);
    assert(replacementCode);
    await client.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: "attempt-user",
      ConfirmationCode: replacementCode,
    }));

    const resendEmail = "resend-limit@example.com";
    await client.send(new SignUpCommand({
      ClientId: clientId,
      Username: "resend-user",
      Password: password,
      UserAttributes: [{ Name: "email", Value: resendEmail }],
    }));
    for (let resend = 0; resend < 3; resend += 1) {
      await client.send(new ResendConfirmationCodeCommand({
        ClientId: clientId,
        Username: "resend-user",
      }));
    }
    await assert.rejects(
      client.send(new ResendConfirmationCodeCommand({
        ClientId: clientId,
        Username: "resend-user",
      })),
      (error: any) => error?.name === "LimitExceededException",
    );
    assert.equal((await messages(simulator, resendEmail)).length, 4);

    const expiringEmail = "expired-code@example.com";
    await client.send(new SignUpCommand({
      ClientId: clientId,
      Username: "expired-user",
      Password: password,
      UserAttributes: [{ Name: "email", Value: expiringEmail }],
    }));
    const expiringCode = await codeFor(simulator, expiringEmail);
    clock.advance(24 * 60 * 60 * 1_000);
    await assert.rejects(
      client.send(new ConfirmSignUpCommand({
        ClientId: clientId,
        Username: "expired-user",
        ConfirmationCode: expiringCode,
      })),
      (error: any) => error?.name === "ExpiredCodeException",
    );
  } finally {
    client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("authentication rejects disabled, wrong-client, wrong-Region, and expired refresh paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-auth-boundaries-"));
  const clock = new TestClock(Date.parse("2026-07-24T16:00:00Z"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    clock,
  });
  let client = sdk(simulator);
  let wrongRegion = sdk(simulator, "us-east-1");
  try {
    await simulator.start();
    client.destroy();
    wrongRegion.destroy();
    client = sdk(simulator);
    wrongRegion = sdk(simulator, "us-east-1");
    assert.deepEqual(
      (await wrongRegion.send(new ListUserPoolsCommand({ MaxResults: 60 }))).UserPools,
      [],
      "the regional endpoint alias carries Region for signed and unsigned official-client actions",
    );

    const pool = await client.send(new CreateUserPoolCommand({
      PoolName: "auth-boundaries",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
    }));
    const poolId = pool.UserPool!.Id!;
    const clientId = await createClient(client, poolId, "short-refresh");
    const email = "auth-boundaries@example.com";
    await client.send(new SignUpCommand({ ClientId: clientId, Username: email, Password: password }));
    await client.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: email,
      ConfirmationCode: await codeFor(simulator, email),
    }));

    const refreshOnly = await createClient(
      client,
      poolId,
      "refresh-only",
      ["ALLOW_REFRESH_TOKEN_AUTH"],
    );
    await assert.rejects(
      client.send(new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: refreshOnly,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      })),
      (error: any) => error?.name === "InvalidParameterException",
    );
    await assert.rejects(
      client.send(new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: "a".repeat(26),
        AuthParameters: { USERNAME: email, PASSWORD: password },
      })),
      (error: any) => error?.name === "ResourceNotFoundException",
    );
    await assert.rejects(
      wrongRegion.send(new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      })),
      (error: any) => error?.name === "ResourceNotFoundException",
    );

    const authenticated = (await client.send(new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }))).AuthenticationResult!;
    const passwordOnly = await createClient(
      client,
      poolId,
      "password-only",
      ["ALLOW_USER_PASSWORD_AUTH"],
    );
    const passwordOnlySession = (await client.send(new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: passwordOnly,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }))).AuthenticationResult!;
    await assert.rejects(
      client.send(new GetTokensFromRefreshTokenCommand({
        ClientId: passwordOnly,
        RefreshToken: passwordOnlySession.RefreshToken!,
      })),
      (error: any) => error?.name === "InvalidParameterException",
    );
    const otherClient = await createClient(client, poolId, "other-client");
    await assert.rejects(
      client.send(new GetTokensFromRefreshTokenCommand({
        ClientId: otherClient,
        RefreshToken: authenticated.RefreshToken!,
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    clock.advance(3_600_001);
    await assert.rejects(
      client.send(new GetTokensFromRefreshTokenCommand({
        ClientId: clientId,
        RefreshToken: authenticated.RefreshToken!,
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
  } finally {
    client.destroy();
    wrongRegion.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Cognito catalogs are isolated by account as well as Region", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-account-isolation-"));
  const firstAccount = "111122223333";
  const secondAccount = "444455556666";
  let simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    accountId: firstAccount,
    authMode: "off",
  });
  let client = sdk(simulator);
  try {
    await simulator.start();
    client.destroy();
    client = sdk(simulator);
    const firstPool = await client.send(new CreateUserPoolCommand({ PoolName: "same-name" }));
    const firstPoolId = firstPool.UserPool!.Id!;
    const firstClientId = await createClient(client, firstPoolId, "first-account-client");
    client.destroy();
    await simulator.stop();

    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      region,
      accountId: secondAccount,
      authMode: "off",
      defaultAccessKeyId: "admin-second-account",
      defaultSecretAccessKey: "password-second-account",
    });
    await simulator.start();
    client = sdk(simulator);
    assert.deepEqual((await client.send(new ListUserPoolsCommand({ MaxResults: 60 }))).UserPools, []);
    await assert.rejects(
      client.send(new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: firstClientId,
        AuthParameters: { USERNAME: "user", PASSWORD: password },
      })),
      (error: any) => error?.name === "ResourceNotFoundException",
    );
    const secondPool = await client.send(new CreateUserPoolCommand({ PoolName: "same-name" }));
    assert.equal(secondPool.UserPool?.Arn?.includes(`:${secondAccount}:`), true);
    client.destroy();
    await simulator.stop();

    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      region,
      accountId: firstAccount,
      authMode: "off",
    });
    await simulator.start();
    client = sdk(simulator);
    const listed = await client.send(new ListUserPoolsCommand({ MaxResults: 60 }));
    assert.deepEqual(listed.UserPools?.map(pool => pool.Id), [firstPoolId]);
    assert.equal(simulator.store.regionState(region).cognito.pools[firstPoolId].arn.includes(`:${firstAccount}:`), true);
  } finally {
    client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
