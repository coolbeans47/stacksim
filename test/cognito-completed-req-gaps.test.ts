import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListUserAuthEventsCommand,
  AdminResetUserPasswordCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  CreateUserPoolDomainCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  ConfirmForgotPasswordCommand,
  DescribeUserPoolCommand,
  ForgotPasswordCommand,
  GetTokensFromRefreshTokenCommand,
  GetUserCommand,
  GetUserAttributeVerificationCodeCommand,
  InitiateAuthCommand,
  RevokeTokenCommand,
  ResendConfirmationCodeCommand,
  RespondToAuthChallengeCommand,
  SignUpCommand,
  UpdateUserPoolClientCommand,
  UpdateUserAttributesCommand,
  UpdateUserPoolCommand,
  VerifyUserAttributeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CognitoPasswordHasher } from "../src/cognito/passwords.js";
import { CognitoSecrets } from "../src/cognito/secrets.js";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const oldPassword = "Valid-old-password-1!";
const newPassword = "Valid-new-password-2!";

function sdk(simulator: StackSim): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({
    endpoint: `http://127.0.0.1:${simulator.port}`,
    region,
    credentials,
    maxAttempts: 1,
  });
}

async function latestCode(simulator: StackSim, recipient: string): Promise<string> {
  const origin = `http://127.0.0.1:${simulator.port}`;
  const listing = await fetch(
    `${origin}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(recipient)}&status=all&pageSize=100`,
  );
  const messages = (await listing.json() as { messages: Array<{ messageId: string }> }).messages;
  assert(messages.length > 0);
  const detail = await fetch(
    `${origin}/_stacksim/api/ses/inbox/${encodeURIComponent(messages.at(-1)!.messageId)}`,
  );
  const text = (await detail.json() as { message: { textBody: string } }).message.textBody;
  const match = /\b(\d{6})\b/.exec(text);
  assert(match);
  return match[1];
}

async function createConfirmedUser(
  client: CognitoIdentityProviderClient,
  suffix: string,
): Promise<{ poolId: string; clientId: string; username: string }> {
  const pool = await client.send(new CreateUserPoolCommand({
    PoolName: `gap-${suffix}`,
  }));
  const poolId = pool.UserPool!.Id!;
  const app = await client.send(new CreateUserPoolClientCommand({
    UserPoolId: poolId,
    ClientName: "public-client",
    ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    PreventUserExistenceErrors: "ENABLED",
  }));
  const username = `user-${suffix}`;
  await client.send(new AdminCreateUserCommand({
    UserPoolId: poolId,
    Username: username,
    TemporaryPassword: "Valid-temporary-1!",
    MessageAction: "SUPPRESS",
  }));
  await client.send(new AdminSetUserPasswordCommand({
    UserPoolId: poolId,
    Username: username,
    Password: oldPassword,
    Permanent: true,
  }));
  return { poolId, clientId: app.UserPoolClient!.ClientId!, username };
}

test("COGGAP-01 rejects an old-password comparison that outlives a password change", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-coggap-01-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    clock: new TestClock(Date.UTC(2026, 7, 11, 12)),
  });
  const originalVerify = CognitoPasswordHasher.prototype.verify;
  let release!: () => void;
  let comparisonStarted!: () => void;
  const comparisonGate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { comparisonStarted = resolve; });
  let blockNextComparison = false;
  CognitoPasswordHasher.prototype.verify = async function (...args) {
    const result = await originalVerify.apply(this, args);
    if (blockNextComparison) {
      blockNextComparison = false;
      comparisonStarted();
      await comparisonGate;
    }
    return result;
  };
  try {
    await simulator.start();
    const client = sdk(simulator);
    const user = await createConfirmedUser(client, "password-race");
    blockNextComparison = true;
    const authentication = client.send(new InitiateAuthCommand({
      ClientId: user.clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: user.username, PASSWORD: oldPassword },
    }));
    await started;
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: user.poolId,
      Username: user.username,
      Password: newPassword,
      Permanent: true,
    }));
    release();
    await assert.rejects(authentication, (error: any) => error?.name === "NotAuthorizedException");

    const current = await client.send(new InitiateAuthCommand({
      ClientId: user.clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: user.username, PASSWORD: newPassword },
    }));
    assert(current.AuthenticationResult?.AccessToken);
  } finally {
    release?.();
    CognitoPasswordHasher.prototype.verify = originalVerify;
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-02 gates revocation without invalidating historical JWT claim profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-coggap-02-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    clock: new TestClock(Date.UTC(2026, 7, 11, 13)),
  });
  try {
    await simulator.start();
    const client = sdk(simulator);
    const user = await createConfirmedUser(client, "revocation-flag");
    await client.send(new UpdateUserPoolClientCommand({
      UserPoolId: user.poolId,
      ClientId: user.clientId,
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      EnableTokenRevocation: false,
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid"],
      CallbackURLs: ["http://127.0.0.1:39123/callback"],
    }));
    await client.send(new CreateUserPoolDomainCommand({
      UserPoolId: user.poolId,
      Domain: "coggap-02-local",
    }));
    const withoutClaims = (await client.send(new InitiateAuthCommand({
      ClientId: user.clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: user.username, PASSWORD: oldPassword },
    }))).AuthenticationResult!;
    const firstAccessClaims = JSON.parse(Buffer.from(
      withoutClaims.AccessToken!.split(".")[1],
      "base64url",
    ).toString("utf8"));
    assert.equal(firstAccessClaims.jti, undefined);
    assert.equal(firstAccessClaims.origin_jti, undefined);

    await assert.rejects(
      client.send(new RevokeTokenCommand({
        ClientId: user.clientId,
        Token: withoutClaims.RefreshToken!,
      })),
      (error: any) => error?.name === "UnsupportedOperationException",
    );
    const disabledOAuth = await fetch(
      `http://127.0.0.1:${simulator.port}/_stacksim/cognito-domain/coggap-02-local/oauth2/revoke`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: user.clientId, token: withoutClaims.RefreshToken! }),
      },
    );
    assert.equal(disabledOAuth.status, 400);
    assert.equal((await disabledOAuth.json() as any).error, "invalid_request");
    assert((await client.send(new GetTokensFromRefreshTokenCommand({
      ClientId: user.clientId,
      RefreshToken: withoutClaims.RefreshToken!,
    }))).AuthenticationResult?.AccessToken);

    await client.send(new UpdateUserPoolClientCommand({
      UserPoolId: user.poolId,
      ClientId: user.clientId,
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      EnableTokenRevocation: true,
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid"],
      CallbackURLs: ["http://127.0.0.1:39123/callback"],
    }));
    assert.equal((await client.send(new GetUserCommand({
      AccessToken: withoutClaims.AccessToken!,
    }))).Username, user.username);
    const withClaims = (await client.send(new InitiateAuthCommand({
      ClientId: user.clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: user.username, PASSWORD: oldPassword },
    }))).AuthenticationResult!;
    const secondAccessClaims = JSON.parse(Buffer.from(
      withClaims.AccessToken!.split(".")[1],
      "base64url",
    ).toString("utf8"));
    assert.equal(typeof secondAccessClaims.jti, "string");
    assert.equal(typeof secondAccessClaims.origin_jti, "string");

    await client.send(new UpdateUserPoolClientCommand({
      UserPoolId: user.poolId,
      ClientId: user.clientId,
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      EnableTokenRevocation: false,
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid"],
      CallbackURLs: ["http://127.0.0.1:39123/callback"],
    }));
    assert.equal((await client.send(new GetUserCommand({
      AccessToken: withClaims.AccessToken!,
    }))).Username, user.username);
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-04 JSON and OAuth revocation expose their distinct corrected error matrices", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-coggap-04-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    clock: new TestClock(Date.UTC(2026, 7, 11, 20)),
  });
  let client: CognitoIdentityProviderClient | undefined;
  try {
    await simulator.start();
    client = sdk(simulator);
    const user = await createConfirmedUser(client, "revoke-matrix");
    await client.send(new UpdateUserPoolClientCommand({
      UserPoolId: user.poolId,
      ClientId: user.clientId,
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      EnableTokenRevocation: true,
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid"],
      CallbackURLs: ["http://127.0.0.1:39123/callback"],
    }));
    const confidential = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: user.poolId,
      ClientName: "confidential-revoke-client",
      GenerateSecret: true,
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      EnableTokenRevocation: true,
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid"],
      CallbackURLs: ["http://127.0.0.1:39123/callback"],
    }));
    await client.send(new CreateUserPoolDomainCommand({
      UserPoolId: user.poolId,
      Domain: "coggap-04-local",
    }));
    const authenticated = (await client.send(new InitiateAuthCommand({
      ClientId: user.clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: user.username, PASSWORD: oldPassword },
    }))).AuthenticationResult!;
    const unknownRefresh = Buffer.alloc(32, 0x5a).toString("base64url");
    await assert.rejects(
      client.send(new RevokeTokenCommand({
        ClientId: confidential.UserPoolClient!.ClientId!,
        ClientSecret: "definitely-not-the-client-secret",
        Token: unknownRefresh,
      })),
      (error: any) => error?.name === "UnauthorizedException",
    );
    for (const token of [authenticated.AccessToken!, authenticated.IdToken!]) {
      await assert.rejects(
        client.send(new RevokeTokenCommand({ ClientId: user.clientId, Token: token })),
        (error: any) => error?.name === "UnsupportedTokenTypeException",
      );
    }
    await assert.rejects(
      client.send(new RevokeTokenCommand({ ClientId: user.clientId, Token: unknownRefresh })),
      (error: any) => error?.name === "UnauthorizedException",
    );
    await client.send(new RevokeTokenCommand({
      ClientId: user.clientId,
      Token: authenticated.RefreshToken!,
    }));
    await client.send(new RevokeTokenCommand({
      ClientId: user.clientId,
      Token: authenticated.RefreshToken!,
    }));

    const endpoint = `http://127.0.0.1:${simulator.port}/_stacksim/cognito-domain/coggap-04-local/oauth2/revoke`;
    const revoke = (body: URLSearchParams) => fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const missing = await revoke(new URLSearchParams({ client_id: user.clientId }));
    assert.equal(missing.status, 400);
    assert.equal((await missing.json() as any).error, "invalid_request");
    const invalidClient = await revoke(new URLSearchParams({
      client_id: confidential.UserPoolClient!.ClientId!,
      client_secret: "wrong-secret",
      token: unknownRefresh,
    }));
    assert.equal(invalidClient.status, 401);
    assert.equal((await invalidClient.json() as any).error, "invalid_client");
    const unsupported = await revoke(new URLSearchParams({
      client_id: user.clientId,
      token: authenticated.AccessToken!,
    }));
    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json() as any).error, "unsupported_token_type");
    for (const token of [unknownRefresh, authenticated.RefreshToken!]) {
      const response = await revoke(new URLSearchParams({ client_id: user.clientId, token }));
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "");
    }
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-10 NEW_PASSWORD_REQUIRED collects missing writable required attributes atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-coggap-10-"));
  const clock = new TestClock(Date.UTC(2026, 7, 11, 14));
  let simulator: StackSim | undefined;
  let client: CognitoIdentityProviderClient | undefined;
  try {
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", clock });
    await simulator.start();
    client = sdk(simulator);
    const pool = await client.send(new CreateUserPoolCommand({
      PoolName: "gap-new-password-attributes",
      Schema: [{ Name: "email", Required: true, Mutable: true }],
    }));
    const poolId = pool.UserPool!.Id!;
    const app = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "public-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
      WriteAttributes: ["email"],
      ReadAttributes: ["email"],
    }));
    const clientId = app.UserPoolClient!.ClientId!;
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: "missing-required-email",
      TemporaryPassword: "Valid-temporary-1!",
      MessageAction: "SUPPRESS",
    }));
    const challenge = await client.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: "missing-required-email", PASSWORD: "Valid-temporary-1!" },
    }));
    assert.equal(challenge.ChallengeName, "NEW_PASSWORD_REQUIRED");
    assert.deepEqual(JSON.parse(challenge.ChallengeParameters!.requiredAttributes!), ["userAttributes.email"]);
    await assert.rejects(
      client.send(new RespondToAuthChallengeCommand({
        ClientId: clientId,
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        Session: challenge.Session,
        ChallengeResponses: {
          USERNAME: "missing-required-email",
          NEW_PASSWORD: "Valid-permanent-2!",
        },
      })),
      (error: any) => error?.name === "InvalidParameterException",
    );
    const completed = await client.send(new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: challenge.Session,
      ChallengeResponses: {
        USERNAME: "missing-required-email",
        NEW_PASSWORD: "Valid-permanent-2!",
        "userAttributes.email": "required@example.test",
      },
    }));
    assert(completed.AuthenticationResult?.AccessToken);

    client.destroy();
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", clock });
    await simulator.start();
    client = sdk(simulator);
    const persisted = await client.send(new AdminGetUserCommand({
      UserPoolId: poolId,
      Username: "missing-required-email",
    }));
    assert(persisted.UserAttributes?.some(attribute =>
      attribute.Name === "email" && attribute.Value === "required@example.test"
    ));
  } finally {
    client?.destroy();
    await simulator?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-11 selects among multiple enabled MFA factors before issuing a factor challenge", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-coggap-11-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    clock: new TestClock(Date.UTC(2026, 7, 11, 15)),
  });
  try {
    await simulator.start();
    const client = sdk(simulator);
    const fixture = await createConfirmedUser(client, "mfa-selection");
    const pool = simulator.store.regionState(region).cognito.pools[fixture.poolId];
    const user = Object.values(pool.usersBySub).find(candidate => candidate.username === fixture.username)!;
    pool.configuration.enabledMfas = ["SOFTWARE_TOKEN_MFA", "EMAIL_OTP"];
    pool.configuration.mfaConfiguration = "OPTIONAL";
    user.userMfaSettingList = ["SOFTWARE_TOKEN_MFA", "EMAIL_OTP"];
    user.preferredMfaSetting = undefined;
    await simulator.store.save();

    const selection = await client.send(new InitiateAuthCommand({
      ClientId: fixture.clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: fixture.username, PASSWORD: oldPassword },
    }));
    assert.equal(selection.ChallengeName, "SELECT_MFA_TYPE");
    assert.deepEqual(
      JSON.parse(selection.ChallengeParameters!.MFAS_CAN_CHOOSE!),
      ["SOFTWARE_TOKEN_MFA", "EMAIL_OTP"],
    );
    const selected = await client.send(new RespondToAuthChallengeCommand({
      ClientId: fixture.clientId,
      ChallengeName: "SELECT_MFA_TYPE",
      Session: selection.Session,
      ChallengeResponses: { USERNAME: fixture.username, ANSWER: "SOFTWARE_TOKEN_MFA" },
    }));
    assert.equal(selected.ChallengeName, "SOFTWARE_TOKEN_MFA");
    await assert.rejects(
      client.send(new RespondToAuthChallengeCommand({
        ClientId: fixture.clientId,
        ChallengeName: "SOFTWARE_TOKEN_MFA",
        Session: selection.Session,
        ChallengeResponses: {
          USERNAME: fixture.username,
          SOFTWARE_TOKEN_MFA_CODE: "000000",
        },
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );

    user.preferredMfaSetting = "SOFTWARE_TOKEN_MFA";
    await simulator.store.save();
    const preferred = await client.send(new InitiateAuthCommand({
      ClientId: fixture.clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: fixture.username, PASSWORD: oldPassword },
    }));
    assert.equal(preferred.ChallengeName, "SOFTWARE_TOKEN_MFA");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-12 binds an attribute verification code to the exact target email", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-coggap-12-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    clock: new TestClock(Date.UTC(2026, 7, 11, 16)),
  });
  try {
    await simulator.start();
    const client = sdk(simulator);
    const poolResult = await client.send(new CreateUserPoolCommand({
      PoolName: "gap-attribute-target",
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", Required: false, Mutable: true }],
    }));
    const poolId = poolResult.UserPool!.Id!;
    const app = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "public-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
      ReadAttributes: ["email"],
      WriteAttributes: ["email"],
    }));
    const clientId = app.UserPoolClient!.ClientId!;
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: "attribute-user",
      UserAttributes: [
        { Name: "email", Value: "address-a@example.test" },
        { Name: "email_verified", Value: "true" },
      ],
      TemporaryPassword: "Valid-temporary-1!",
      MessageAction: "SUPPRESS",
    }));
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: "attribute-user",
      Password: oldPassword,
      Permanent: true,
    }));
    const authenticated = (await client.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: "attribute-user", PASSWORD: oldPassword },
    }))).AuthenticationResult!;
    await client.send(new GetUserAttributeVerificationCodeCommand({
      AccessToken: authenticated.AccessToken!,
      AttributeName: "email",
    }));
    const codeForA = await latestCode(simulator, "address-a@example.test");

    const pool = simulator.store.regionState(region).cognito.pools[poolId];
    pool.configuration.emailConfiguration = {
      emailSendingAccount: "DEVELOPER",
      sourceArn: `arn:aws:ses:${region}:000000000000:identity/unverified.example.test`,
      from: "no-reply@unverified.example.test",
    };
    await simulator.store.save();
    await assert.rejects(client.send(new UpdateUserAttributesCommand({
      AccessToken: authenticated.AccessToken!,
      UserAttributes: [{ Name: "email", Value: "address-b@example.test" }],
    })));
    await assert.rejects(
      client.send(new VerifyUserAttributeCommand({
        AccessToken: authenticated.AccessToken!,
        AttributeName: "email",
        Code: codeForA,
      })),
      (error: any) => ["CodeMismatchException", "ExpiredCodeException"].includes(error?.name),
    );
    const current = await client.send(new GetUserCommand({ AccessToken: authenticated.AccessToken! }));
    assert.equal(current.UserAttributes?.find(attribute => attribute.Name === "email")?.Value, "address-b@example.test");
    assert.equal(current.UserAttributes?.find(attribute => attribute.Name === "email_verified")?.Value, "false");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-03 refresh proof uses an index and startup prunes historical sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-coggap-03-"));
  const clock = new TestClock(Date.UTC(2026, 7, 11, 17));
  let simulator: StackSim | undefined;
  let client: CognitoIdentityProviderClient | undefined;
  const originalVerify = CognitoSecrets.prototype.verifyRefreshToken;
  let proofComparisons = 0;
  try {
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", clock });
    await simulator.start();
    client = sdk(simulator);
    const fixture = await createConfirmedUser(client, "refresh-index");
    const authenticated = (await client.send(new InitiateAuthCommand({
      ClientId: fixture.clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: fixture.username, PASSWORD: oldPassword },
    }))).AuthenticationResult!;
    const pool = simulator.store.regionState(region).cognito.pools[fixture.poolId];
    const active = Object.values(pool.refreshSessions)[0]!;
    const historical = Object.fromEntries(Array.from({ length: 200 }, (_, index) => {
      const id = `historical-${String(index).padStart(3, "0")}`;
      return [id, {
        ...structuredClone(active),
        id,
        tokenDigest: Buffer.alloc(32, (index % 254) + 1).toString("base64url"),
        eventId: `historical-event-${index}`,
        status: "REVOKED" as const,
        revokedAt: clock.now() - 10_000,
        expiresAt: clock.now() - 1,
      }];
    }));
    pool.refreshSessions = { ...historical, [active.id]: active };
    await simulator.store.save();
    CognitoSecrets.prototype.verifyRefreshToken = function (...args) {
      proofComparisons += 1;
      return originalVerify.apply(this, args);
    };
    assert((await client.send(new GetTokensFromRefreshTokenCommand({
      ClientId: fixture.clientId,
      RefreshToken: authenticated.RefreshToken!,
    }))).AuthenticationResult?.AccessToken);
    assert(proofComparisons <= 1, `refresh proof performed ${proofComparisons} digest comparisons`);

    client.destroy();
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", clock });
    await simulator.start();
    client = sdk(simulator);
    const restartedPool = simulator.store.regionState(region).cognito.pools[fixture.poolId];
    assert.equal(Object.values(restartedPool.refreshSessions).some(session => session.expiresAt <= clock.now()), false);
    proofComparisons = 0;
    assert((await client.send(new GetTokensFromRefreshTokenCommand({
      ClientId: fixture.clientId,
      RefreshToken: authenticated.RefreshToken!,
    }))).AuthenticationResult?.AccessToken);
    assert(proofComparisons <= 1);
  } finally {
    CognitoSecrets.prototype.verifyRefreshToken = originalVerify;
    client?.destroy();
    await simulator?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-07 delivery-claiming sign-up and resend require a DELIVERED outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-coggap-07-"));
  const clock = new TestClock(Date.UTC(2026, 7, 11, 18));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", clock });
  let client: CognitoIdentityProviderClient | undefined;
  try {
    await simulator.start();
    client = sdk(simulator);
    const pool = await client.send(new CreateUserPoolCommand({
      PoolName: "gap-delivery-outcome",
      AutoVerifiedAttributes: ["email"],
    }));
    const app = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: pool.UserPool!.Id!,
      ClientName: "public-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }));
    const username = "delivery-outcome-user";
    const email = "delivery-outcome@example.test";
    (simulator.cognito as any).performDelivery = async (intentId: string) => {
      const intents = simulator.store.regionState(region).cognito.deliveryIntents;
      const intent = intents[intentId];
      if (intent?.purpose === "SIGN_UP") {
        delete intents[intentId];
        await simulator.store.save();
        return "MISSING";
      }
      if (intent) {
        intent.status = "CANCELLED";
        intent.statusUpdatedAt = clock.now();
        await simulator.store.save();
      }
      return "CANCELLED";
    };
    await assert.rejects(
      client.send(new SignUpCommand({
        ClientId: app.UserPoolClient!.ClientId!,
        Username: username,
        Password: oldPassword,
        UserAttributes: [{ Name: "email", Value: email }],
      })),
      (error: any) => error?.name === "CodeDeliveryFailureException",
    );
    await assert.rejects(
      client.send(new ResendConfirmationCodeCommand({
        ClientId: app.UserPoolClient!.ClientId!,
        Username: username,
      })),
      (error: any) => error?.name === "CodeDeliveryFailureException",
    );
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-08 restart recovery drains beyond 100 intents without a bad pool starving another", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-coggap-08-"));
  const clock = new TestClock(Date.UTC(2026, 7, 11, 19));
  let simulator: StackSim | undefined;
  let client: CognitoIdentityProviderClient | undefined;
  try {
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", clock });
    await simulator.start();
    client = sdk(simulator);
    const seedPool = async (name: string, email: string) => {
      const pool = await client!.send(new CreateUserPoolCommand({
        PoolName: name,
        AutoVerifiedAttributes: ["email"],
      }));
      const app = await client!.send(new CreateUserPoolClientCommand({
        UserPoolId: pool.UserPool!.Id!,
        ClientName: "public-client",
        ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      }));
      await client!.send(new SignUpCommand({
        ClientId: app.UserPoolClient!.ClientId!,
        Username: `${name}-user`,
        Password: oldPassword,
        UserAttributes: [{ Name: "email", Value: email }],
      }));
      return pool.UserPool!.Id!;
    };
    const badPoolId = await seedPool("delivery-bad-pool", "bad-pool@example.test");
    const goodPoolId = await seedPool("delivery-good-pool", "good-pool@example.test");
    const state = simulator.store.regionState(region).cognito;
    const badSeed = Object.values(state.deliveryIntents).find(intent => intent.poolId === badPoolId)!;
    const goodSeed = Object.values(state.deliveryIntents).find(intent => intent.poolId === goodPoolId)!;
    for (let index = 0; index < 20; index += 1) {
      const id = `bad-${String(index).padStart(3, "0")}`;
      state.deliveryIntents[id] = {
        ...structuredClone(badSeed),
        id,
        status: "PENDING_DELIVERY",
        statusUpdatedAt: undefined,
        issuedAt: clock.now() - 2_000,
        deliveryKey: `bad-key-${index}`,
        sesMessageId: `bad-message-${index}`,
      };
    }
    for (let index = 0; index < 105; index += 1) {
      const id = `good-${String(index).padStart(3, "0")}`;
      state.deliveryIntents[id] = {
        ...structuredClone(goodSeed),
        id,
        status: "PENDING_DELIVERY",
        statusUpdatedAt: undefined,
        issuedAt: clock.now() - 1_000,
        deliveryKey: `good-key-${index}`,
        sesMessageId: `good-message-${index}`,
      };
    }
    await simulator.store.save();
    client.destroy();
    client = undefined;
    await simulator.stop();

    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", clock });
    (simulator.cognito as any).performDelivery = async (intentId: string) => {
      const intent = simulator!.store.regionState(region).cognito.deliveryIntents[intentId];
      if (!intent) return "MISSING";
      if (intent.poolId === badPoolId) return "FAILED";
      intent.status = "DELIVERED";
      intent.statusUpdatedAt = clock.now();
      return "DELIVERED";
    };
    await simulator.start();
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const remainingGood = Object.values(simulator.store.regionState(region).cognito.deliveryIntents)
        .filter(intent => intent.poolId === goodPoolId && intent.status === "PENDING_DELIVERY");
      if (remainingGood.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const recovered = Object.values(simulator.store.regionState(region).cognito.deliveryIntents);
    assert.equal(recovered.filter(intent => intent.poolId === goodPoolId && intent.status === "PENDING_DELIVERY").length, 0);
    assert.equal(recovered.filter(intent => intent.poolId === badPoolId && intent.status === "PENDING_DELIVERY").length, 20);
  } finally {
    client?.destroy();
    await simulator?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-13 recovery suppression and disabled-user transitions match Cognito", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-coggap-13-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    clock: new TestClock(Date.UTC(2026, 7, 11, 12)),
  });
  try {
    await simulator.start();
    const client = sdk(simulator);
    const pool = await client.send(new CreateUserPoolCommand({ PoolName: "gap-recovery-semantics" }));
    const poolId = pool.UserPool!.Id!;
    const suppressed = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "suppressed",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
      PreventUserExistenceErrors: "ENABLED",
    }));
    const unsuppressed = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "unsuppressed",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
      PreventUserExistenceErrors: "LEGACY",
    }));
    const simulated = await client.send(new ForgotPasswordCommand({
      ClientId: suppressed.UserPoolClient!.ClientId!,
      Username: "missing@example.test",
    }));
    assert.deepEqual(simulated.CodeDeliveryDetails, {
      AttributeName: "email",
      DeliveryMedium: "EMAIL",
      Destination: "m***@e***.test",
    });
    await assert.rejects(
      client.send(new ForgotPasswordCommand({
        ClientId: unsuppressed.UserPoolClient!.ClientId!,
        Username: "missing@example.test",
      })),
      (error: any) => error?.name === "UserNotFoundException",
    );

    const username = "disabled-recovery@example.test";
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: username,
      TemporaryPassword: "Valid-temporary-1!",
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: username },
        { Name: "email_verified", Value: "true" },
      ],
    }));
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: username,
      Password: oldPassword,
      Permanent: true,
    }));
    await client.send(new ForgotPasswordCommand({
      ClientId: suppressed.UserPoolClient!.ClientId!,
      Username: username,
    }));
    const code = await latestCode(simulator, username);
    await client.send(new AdminDisableUserCommand({ UserPoolId: poolId, Username: username }));
    await assert.rejects(
      client.send(new ConfirmForgotPasswordCommand({
        ClientId: suppressed.UserPoolClient!.ClientId!,
        Username: username,
        ConfirmationCode: code,
        Password: newPassword,
      })),
      (error: any) => error?.name === "CodeMismatchException",
    );
    await assert.rejects(
      client.send(new AdminResetUserPasswordCommand({ UserPoolId: poolId, Username: username })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    await client.send(new AdminEnableUserCommand({ UserPoolId: poolId, Username: username }));
    await client.send(new AdminResetUserPasswordCommand({ UserPoolId: poolId, Username: username }));
    assert.equal(
      (await client.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: username }))).UserStatus,
      "RESET_REQUIRED",
    );
    client.destroy();
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-14 normalizes zero temporary-password validity to seven days", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-coggap-14-"));
  const clock = new TestClock(Date.UTC(2026, 7, 11, 12));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", clock });
  try {
    await simulator.start();
    const client = sdk(simulator);
    const pool = await client.send(new CreateUserPoolCommand({
      PoolName: "gap-temporary-validity",
      Policies: { PasswordPolicy: { TemporaryPasswordValidityDays: 0 } },
    }));
    const poolId = pool.UserPool!.Id!;
    assert.equal(
      (await client.send(new DescribeUserPoolCommand({ UserPoolId: poolId })))
        .UserPool?.Policies?.PasswordPolicy?.TemporaryPasswordValidityDays,
      7,
    );
    await client.send(new UpdateUserPoolCommand({
      UserPoolId: poolId,
      Policies: { PasswordPolicy: { TemporaryPasswordValidityDays: 2 } },
    }));
    await client.send(new UpdateUserPoolCommand({
      UserPoolId: poolId,
      Policies: { PasswordPolicy: { TemporaryPasswordValidityDays: 0 } },
    }));
    assert.equal(
      (await client.send(new DescribeUserPoolCommand({ UserPoolId: poolId })))
        .UserPool?.Policies?.PasswordPolicy?.TemporaryPasswordValidityDays,
      7,
    );
    const app = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "temporary-password-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
    }));
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: "temporary-user",
      TemporaryPassword: "Valid-temporary-1!",
      MessageAction: "SUPPRESS",
    }));
    clock.advance(6 * 86_400_000);
    const auth = await client.send(new InitiateAuthCommand({
      ClientId: app.UserPoolClient!.ClientId!,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: "temporary-user", PASSWORD: "Valid-temporary-1!" },
    }));
    assert.equal(auth.ChallengeName, "NEW_PASSWORD_REQUIRED");
    client.destroy();
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-15 invitation resend preserves bounded password history", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-coggap-15-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  try {
    await simulator.start();
    const client = sdk(simulator);
    const pool = await client.send(new CreateUserPoolCommand({
      PoolName: "gap-resend-history",
      Policies: { PasswordPolicy: { PasswordHistorySize: 3 } },
    }));
    const poolId = pool.UserPool!.Id!;
    const app = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "resend-history-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
    }));
    const username = "resend-history@example.test";
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: username,
      TemporaryPassword: "First-temporary-1!",
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: username },
        { Name: "email_verified", Value: "true" },
      ],
    }));
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: username,
      Password: oldPassword,
      Permanent: true,
    }));
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: username,
      Password: "Second-temporary-2!",
      Permanent: false,
    }));
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: username,
      TemporaryPassword: "Resent-temporary-3!",
      MessageAction: "RESEND",
    }));
    const challenge = await client.send(new InitiateAuthCommand({
      ClientId: app.UserPoolClient!.ClientId!,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: username, PASSWORD: "Resent-temporary-3!" },
    }));
    assert.equal(challenge.ChallengeName, "NEW_PASSWORD_REQUIRED");
    await assert.rejects(
      client.send(new RespondToAuthChallengeCommand({
        ClientId: app.UserPoolClient!.ClientId!,
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        Session: challenge.Session,
        ChallengeResponses: { USERNAME: username, NEW_PASSWORD: oldPassword },
      })),
      (error: any) => error?.name === "PasswordHistoryPolicyViolationException",
    );
    const invitationInbox = await fetch(
      `http://127.0.0.1:${simulator.port}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(username)}&status=all&pageSize=100`,
    ).then(response => response.json()) as { messages: unknown[] };
    assert.equal(invitationInbox.messages.length, 1);
    client.destroy();
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-17 refresh metadata and issuance causes reach pre-token generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-coggap-17-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  const observed: Array<{ source: string; clientMetadata: Record<string, string> }> = [];
  try {
    await simulator.start();
    const service = simulator.cognito as any;
    const originalInvokeTrigger = service.invokeTrigger.bind(service);
    service.invokeTrigger = async (...args: any[]) => {
      if (args[3] === "preTokenGeneration") {
        observed.push({ source: args[4], clientMetadata: { ...(args[5]?.clientMetadata ?? {}) } });
      }
      return originalInvokeTrigger(...args);
    };
    const client = sdk(simulator);
    const pool = await client.send(new CreateUserPoolCommand({ PoolName: "gap-token-causes" }));
    const poolId = pool.UserPool!.Id!;
    const app = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "token-cause-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
    }));
    const clientId = app.UserPoolClient!.ClientId!;
    const username = "new-password-cause";
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: username,
      TemporaryPassword: "Valid-temporary-1!",
      MessageAction: "SUPPRESS",
    }));
    const challenge = await client.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: username, PASSWORD: "Valid-temporary-1!" },
    }));
    const completed = await client.send(new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: challenge.Session,
      ChallengeResponses: { USERNAME: username, NEW_PASSWORD: oldPassword },
      ClientMetadata: { completion: "new-password" },
    }));
    const refreshToken = completed.AuthenticationResult!.RefreshToken!;
    const sessionsBeforeInvalid = Object.keys(
      simulator.store.regionState(region).cognito.pools[poolId].refreshSessions,
    ).length;
    await assert.rejects(
      client.send(new GetTokensFromRefreshTokenCommand({
        ClientId: clientId,
        RefreshToken: refreshToken,
        ClientMetadata: { invalid: 1 } as any,
      })),
      (error: any) => error?.name === "InvalidParameterException",
    );
    assert.equal(
      Object.keys(simulator.store.regionState(region).cognito.pools[poolId].refreshSessions).length,
      sessionsBeforeInvalid,
    );
    await client.send(new GetTokensFromRefreshTokenCommand({
      ClientId: clientId,
      RefreshToken: refreshToken,
      DeviceKey: `${region}_00000000-0000-4000-8000-000000000017`,
      ClientMetadata: { refreshTrace: "seventeen" },
    }));
    assert(observed.some(item => item.source === "TokenGeneration_NewPasswordChallenge"));
    assert(observed.some(item =>
      item.source === "TokenGeneration_RefreshTokens"
      && item.clientMetadata.refreshTrace === "seventeen"
    ));
    client.destroy();
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-20 auth-event pages remain signed and stable across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-coggap-20-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  let client: CognitoIdentityProviderClient | undefined;
  try {
    await simulator.start();
    client = sdk(simulator);
    const user = await createConfirmedUser(client, "auth-event-pages");
    for (let index = 0; index < 3; index += 1) {
      await client.send(new InitiateAuthCommand({
        ClientId: user.clientId,
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: user.username, PASSWORD: oldPassword },
      }));
    }
    const first = await client.send(new AdminListUserAuthEventsCommand({
      UserPoolId: user.poolId,
      Username: user.username,
      MaxResults: 1,
    }));
    assert.equal(first.AuthEvents?.length, 1);
    assert(first.NextToken);
    await assert.rejects(
      client.send(new AdminListUserAuthEventsCommand({
        UserPoolId: user.poolId,
        Username: user.username,
        MaxResults: 1,
        NextToken: `${first.NextToken}tampered`,
      })),
      (error: any) => error?.name === "InvalidParameterException",
    );
    client.destroy();
    client = undefined;
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
    await simulator.start();
    client = sdk(simulator);
    const second = await client.send(new AdminListUserAuthEventsCommand({
      UserPoolId: user.poolId,
      Username: user.username,
      MaxResults: 1,
      NextToken: first.NextToken,
    }));
    assert.equal(second.AuthEvents?.length, 1);
    assert.notEqual(second.AuthEvents?.[0].EventId, first.AuthEvents?.[0].EventId);
    assert(second.NextToken);
    assert.equal(JSON.stringify(second).includes(oldPassword), false);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
