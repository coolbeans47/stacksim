import assert from "node:assert/strict";
import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
} from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  GetTokensFromRefreshTokenCommand,
  GetUserCommand,
  GlobalSignOutCommand,
  InitiateAuthCommand,
  RevokeTokenCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import { clientSecretHash } from "../src/cognito/client-secret.js";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const password = "Valid-password-1!";

function endpoint(simulator: StackSim): string {
  return `http://127.0.0.1:${simulator.port}`;
}

function sdk(simulator: StackSim): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({
    endpoint: endpoint(simulator),
    region,
    credentials,
    maxAttempts: 1,
  });
}

async function start(root: string, clock: TestClock): Promise<{
  simulator: StackSim;
  client: CognitoIdentityProviderClient;
}> {
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    clock,
  });
  await simulator.start();
  return { simulator, client: sdk(simulator) };
}

async function inboxCode(simulator: StackSim, email: string): Promise<string> {
  const list = await fetch(
    `${endpoint(simulator)}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(email)}&status=all&pageSize=100`,
  );
  assert.equal(list.status, 200);
  const messages = (await list.json() as { messages: Array<{ messageId: string }> }).messages;
  assert.equal(messages.length, 1);
  const detail = await fetch(
    `${endpoint(simulator)}/_stacksim/api/ses/inbox/${encodeURIComponent(messages[0].messageId)}`,
  );
  assert.equal(detail.status, 200);
  const text = (await detail.json() as { message: { textBody: string } }).message.textBody;
  const match = /\b(\d{6})\b/.exec(text);
  assert(match);
  return match[1];
}

async function poolAndPublicClient(
  client: CognitoIdentityProviderClient,
  name: string,
): Promise<{ poolId: string; clientId: string }> {
  const pool = await client.send(new CreateUserPoolCommand({
    PoolName: name,
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
    AccessTokenValidity: 300,
    IdTokenValidity: 600,
    RefreshTokenValidity: 3600,
    TokenValidityUnits: {
      AccessToken: "seconds",
      IdToken: "seconds",
      RefreshToken: "seconds",
    },
  }));
  return { poolId, clientId: app.UserPoolClient!.ClientId! };
}

function decodeJwt(token: string): {
  header: Record<string, any>;
  payload: Record<string, any>;
} {
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  return {
    header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
  };
}

async function jwks(simulator: StackSim, poolId: string): Promise<Array<Record<string, string>>> {
  const response = await fetch(
    `${endpoint(simulator)}/_stacksim/cognito-idp/${region}/${poolId}/.well-known/jwks.json`,
  );
  assert.equal(response.status, 200);
  return (await response.json() as { keys: Array<Record<string, string>> }).keys;
}

function verifyJwt(token: string, keys: Array<Record<string, string>>): Record<string, any> {
  const parts = token.split(".");
  const decoded = decodeJwt(token);
  const jwk = keys.find(candidate => candidate.kid === decoded.header.kid);
  assert(jwk);
  assert.equal(decoded.header.alg, "RS256");
  assert.equal(
    verifySignature(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
      createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }),
      Buffer.from(parts[2], "base64url"),
    ),
    true,
  );
  return decoded.payload;
}

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

test("password auth issues verifiable tokens; refresh, restart, revoke, and global sign-out share one family state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-auth-"));
  const clock = new TestClock(Date.parse("2026-07-24T12:00:00Z"));
  const email = "login@example.com";
  let active: Awaited<ReturnType<typeof start>> | undefined;
  try {
    active = await start(root, clock);
    const { poolId, clientId } = await poolAndPublicClient(active.client, "auth-pool");
    const signup = await active.client.send(new SignUpCommand({
      ClientId: clientId,
      Username: email,
      Password: password,
    }));
    await assert.rejects(
      active.client.send(new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      })),
      (error: any) => error?.name === "UserNotConfirmedException",
    );
    await active.client.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: email,
      ConfirmationCode: await inboxCode(active.simulator, email),
    }));
    await assert.rejects(
      active.client.send(new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: email, PASSWORD: "Wrong-password-1!" },
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    await assert.rejects(
      active.client.send(new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: "missing@example.com", PASSWORD: password },
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );

    const authenticated = (await active.client.send(new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }))).AuthenticationResult!;
    assert.equal(authenticated.TokenType, "Bearer");
    assert.equal(authenticated.ExpiresIn, 300);
    assert.match(authenticated.RefreshToken ?? "", /^[A-Za-z0-9_-]{43}$/);
    const keys = await jwks(active.simulator, poolId);
    const id = verifyJwt(authenticated.IdToken!, keys);
    const access = verifyJwt(authenticated.AccessToken!, keys);
    assert.notEqual(decodeJwt(authenticated.IdToken!).header.kid, decodeJwt(authenticated.AccessToken!).header.kid);
    assert.equal(id.sub, signup.UserSub);
    assert.equal(id.aud, clientId);
    assert.equal(id.token_use, "id");
    assert.equal(id.email, email);
    assert.equal(id.email_verified, true);
    assert.equal(access.sub, signup.UserSub);
    assert.equal(access.client_id, clientId);
    assert.equal(access.token_use, "access");
    assert.equal(access.scope, "aws.cognito.signin.user.admin");
    assert.equal(id.auth_time, access.auth_time);
    assert.equal(id.origin_jti, access.origin_jti);
    assert.notEqual(id.jti, access.jti);

    const user = await active.client.send(new GetUserCommand({ AccessToken: authenticated.AccessToken! }));
    assert.equal(user.Username, signup.UserSub);
    assert.deepEqual(user.UserAttributes, [
      { Name: "sub", Value: signup.UserSub },
      { Name: "email", Value: email },
      { Name: "email_verified", Value: "true" },
    ]);
    await assert.rejects(
      active.client.send(new GetUserCommand({ AccessToken: authenticated.IdToken! })),
      (error: any) => error?.name === "NotAuthorizedException",
      "an ID token cannot be substituted for an access token",
    );
    const tamperedAccess = authenticated.AccessToken!.split(".");
    tamperedAccess[2] = `${tamperedAccess[2].slice(0, -1)}${tamperedAccess[2].endsWith("A") ? "B" : "A"}`;
    await assert.rejects(
      active.client.send(new GetUserCommand({ AccessToken: tamperedAccess.join(".") })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    const persistedStrings = allStrings(JSON.parse(await readFile(join(root, "state.json"), "utf8")));
    for (const secret of [
      authenticated.IdToken!,
      authenticated.AccessToken!,
      authenticated.RefreshToken!,
      password,
    ]) {
      assert.equal(persistedStrings.includes(secret), false);
    }

    active.client.destroy();
    await active.simulator.stop();
    active = await start(root, clock);
    assert.equal(
      (await active.client.send(new GetUserCommand({ AccessToken: authenticated.AccessToken! }))).Username,
      signup.UserSub,
    );
    const refreshed = (await active.client.send(new InitiateAuthCommand({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: clientId,
      AuthParameters: { REFRESH_TOKEN: authenticated.RefreshToken! },
    }))).AuthenticationResult!;
    assert.equal(refreshed.RefreshToken, undefined);
    assert.equal(decodeJwt(refreshed.IdToken!).payload.auth_time, id.auth_time);
    assert.equal(verifyJwt(refreshed.AccessToken!, await jwks(active.simulator, poolId)).sub, signup.UserSub);
    const currentUser = active.simulator.store.regionState(region).cognito.pools[poolId].usersBySub[signup.UserSub!];
    currentUser.attributes.email.value = "current-attribute@example.com";
    await active.simulator.store.save();
    const directRefresh = (await active.client.send(new GetTokensFromRefreshTokenCommand({
      ClientId: clientId,
      RefreshToken: authenticated.RefreshToken!,
    }))).AuthenticationResult!;
    assert.equal(directRefresh.RefreshToken, undefined);
    assert.equal(
      verifyJwt(directRefresh.IdToken!, await jwks(active.simulator, poolId)).email,
      "current-attribute@example.com",
      "refresh reads the current safe user attributes instead of copying old token claims",
    );

    await active.client.send(new RevokeTokenCommand({
      ClientId: clientId,
      Token: authenticated.RefreshToken!,
    }));
    await assert.rejects(
      active.client.send(new GetUserCommand({ AccessToken: authenticated.AccessToken! })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    await assert.rejects(
      active.client.send(new GetTokensFromRefreshTokenCommand({
        ClientId: clientId,
        RefreshToken: authenticated.RefreshToken!,
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    assert.equal(
      verifyJwt(authenticated.AccessToken!, await jwks(active.simulator, poolId)).sub,
      signup.UserSub,
      "revocation is enforced by Cognito self-service while offline JWT verification lasts until exp",
    );

    const second = (await active.client.send(new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }))).AuthenticationResult!;
    await active.client.send(new GlobalSignOutCommand({ AccessToken: second.AccessToken! }));
    await assert.rejects(
      active.client.send(new GetUserCommand({ AccessToken: second.AccessToken! })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    await assert.rejects(
      active.client.send(new InitiateAuthCommand({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: second.RefreshToken! },
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );

    const expiring = (await active.client.send(new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }))).AuthenticationResult!;
    clock.advance(300_000);
    await assert.rejects(
      active.client.send(new GetUserCommand({ AccessToken: expiring.AccessToken! })),
      (error: any) => error?.name === "NotAuthorizedException",
      "access-token expiry is evaluated against the injected clock",
    );
  } finally {
    active?.client.destroy();
    await active?.simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("confidential auth uses SECRET_HASH for password/refresh and the direct secret for refresh-token APIs", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-confidential-auth-"));
  const clock = new TestClock(Date.parse("2026-07-24T13:00:00Z"));
  const email = "confidential@example.com";
  let active: Awaited<ReturnType<typeof start>> | undefined;
  try {
    active = await start(root, clock);
    const { poolId, clientId: publicClientId } = await poolAndPublicClient(active.client, "confidential-pool");
    const signup = await active.client.send(new SignUpCommand({
      ClientId: publicClientId,
      Username: email,
      Password: password,
    }));
    await active.client.send(new ConfirmSignUpCommand({
      ClientId: publicClientId,
      Username: email,
      ConfirmationCode: await inboxCode(active.simulator, email),
    }));
    const confidential = await active.client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "confidential-client",
      GenerateSecret: true,
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }));
    const clientId = confidential.UserPoolClient!.ClientId!;
    const secret = confidential.UserPoolClient!.ClientSecret!;
    await assert.rejects(
      active.client.send(new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    const authenticated = (await active.client.send(new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
        SECRET_HASH: clientSecretHash(Buffer.from(secret), email, clientId),
      },
    }))).AuthenticationResult!;

    await assert.rejects(
      active.client.send(new InitiateAuthCommand({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: authenticated.RefreshToken! },
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    const refreshed = await active.client.send(new InitiateAuthCommand({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: clientId,
      AuthParameters: {
        REFRESH_TOKEN: authenticated.RefreshToken!,
        SECRET_HASH: clientSecretHash(Buffer.from(secret), signup.UserSub!, clientId),
      },
    }));
    assert(refreshed.AuthenticationResult?.AccessToken);

    await assert.rejects(
      active.client.send(new GetTokensFromRefreshTokenCommand({
        ClientId: clientId,
        RefreshToken: authenticated.RefreshToken!,
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    assert((await active.client.send(new GetTokensFromRefreshTokenCommand({
      ClientId: clientId,
      ClientSecret: secret,
      RefreshToken: authenticated.RefreshToken!,
    }))).AuthenticationResult?.IdToken);
    await active.client.send(new RevokeTokenCommand({
      ClientId: clientId,
      ClientSecret: secret,
      Token: authenticated.RefreshToken!,
    }));
  } finally {
    active?.client.destroy();
    await active?.simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("frozen sign-up, password, and refresh admission limits persist only keyed identities and emit throttle metrics", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-admissions-"));
  const startedAt = Date.parse("2026-07-24T14:00:00Z");
  const clock = new TestClock(startedAt);
  const mainEmail = "rate-main@example.com";
  const signupEmail = "rate-signup@example.com";
  let active: Awaited<ReturnType<typeof start>> | undefined;
  let cloudwatch: CloudWatchClient | undefined;
  try {
    active = await start(root, clock);
    cloudwatch = new CloudWatchClient({ endpoint: endpoint(active.simulator), region, credentials });
    const { poolId, clientId } = await poolAndPublicClient(active.client, "admission-pool");
    await active.client.send(new SignUpCommand({
      ClientId: clientId,
      Username: mainEmail,
      Password: password,
    }));
    await active.client.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: mainEmail,
      ConfirmationCode: await inboxCode(active.simulator, mainEmail),
    }));

    await active.client.send(new SignUpCommand({
      ClientId: clientId,
      Username: signupEmail,
      Password: password,
    }));
    for (let attempt = 1; attempt < 10; attempt += 1) {
      await assert.rejects(
        active.client.send(new SignUpCommand({
          ClientId: clientId,
          Username: signupEmail,
          Password: password,
        })),
        (error: any) => error?.name === "UsernameExistsException",
      );
    }
    await assert.rejects(
      active.client.send(new SignUpCommand({
        ClientId: clientId,
        Username: signupEmail,
        Password: password,
      })),
      (error: any) => error?.name === "TooManyRequestsException",
    );

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await assert.rejects(
        active.client.send(new InitiateAuthCommand({
          AuthFlow: "USER_PASSWORD_AUTH",
          ClientId: clientId,
          AuthParameters: { USERNAME: mainEmail, PASSWORD: "Wrong-password-1!" },
        })),
        (error: any) => error?.name === "NotAuthorizedException",
      );
    }
    await assert.rejects(
      active.client.send(new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: mainEmail, PASSWORD: password },
      })),
      (error: any) => error?.name === "TooManyRequestsException",
    );

    const admissions = active.simulator.store.regionState(region).cognito.admissions;
    assert.equal(JSON.stringify(admissions).includes(mainEmail), false);
    assert.equal(JSON.stringify(admissions).includes(signupEmail), false);
    assert(Object.values(admissions).some(bucket => bucket.kind === "SIGN_UP" && bucket.timestamps.length === 10));
    assert(Object.values(admissions).some(bucket => bucket.kind === "PASSWORD" && bucket.timestamps.length === 10));

    clock.advance(5 * 60 * 1_000 + 1);
    const authenticated = (await active.client.send(new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: mainEmail, PASSWORD: password },
    }))).AuthenticationResult!;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      assert((await active.client.send(new GetTokensFromRefreshTokenCommand({
        ClientId: clientId,
        RefreshToken: authenticated.RefreshToken!,
      }))).AuthenticationResult?.AccessToken);
    }
    await assert.rejects(
      active.client.send(new GetTokensFromRefreshTokenCommand({
        ClientId: clientId,
        RefreshToken: authenticated.RefreshToken!,
      })),
      (error: any) => error?.name === "TooManyRequestsException",
    );
    assert.equal(JSON.stringify(admissions).includes(authenticated.RefreshToken!), false);
    assert(Object.values(admissions).some(bucket => bucket.kind === "REFRESH" && bucket.timestamps.length === 30));

    const throttleCount = async (operation: string): Promise<number> => {
      const result = await cloudwatch!.send(new GetMetricStatisticsCommand({
        Namespace: "AWS/Cognito",
        MetricName: "ThrottleCount",
        Dimensions: [
          { Name: "Operation", Value: operation },
          { Name: "Account", Value: "000000000000" },
          { Name: "Region", Value: region },
          { Name: "UserPool", Value: poolId },
        ],
        StartTime: new Date(startedAt - 60_000),
        EndTime: new Date(clock.now() + 60_000),
        Period: 60,
        Statistics: ["Sum"],
      }));
      return result.Datapoints?.reduce((sum, datapoint) => sum + (datapoint.Sum ?? 0), 0) ?? 0;
    };
    assert.equal(await throttleCount("SignUp"), 1);
    assert.equal(await throttleCount("InitiateAuth"), 1);
    assert.equal(await throttleCount("GetTokensFromRefreshToken"), 1);
  } finally {
    cloudwatch?.destroy();
    active?.client.destroy();
    await active?.simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh-token rotation enforces grace, detects replay, and revokes the token family", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-rotation-"));
  const clock = new TestClock(Date.parse("2026-07-24T15:00:00Z"));
  let active: Awaited<ReturnType<typeof start>> | undefined;
  try {
    active = await start(root, clock);
    const pool = await active.client.send(new CreateUserPoolCommand({
      PoolName: "rotation-pool",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
    }));
    const poolId = pool.UserPool!.Id!;
    const app = await active.client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "rotation-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
      RefreshTokenRotation: { Feature: "ENABLED", RetryGracePeriodSeconds: 5 },
      RefreshTokenValidity: 1,
      TokenValidityUnits: { RefreshToken: "days" },
    }));
    const clientId = app.UserPoolClient!.ClientId!;
    const email = "rotation@example.test";
    await active.client.send(new SignUpCommand({ ClientId: clientId, Username: email, Password: password }));
    await active.client.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: email,
      ConfirmationCode: await inboxCode(active.simulator, email),
    }));
    const original = (await active.client.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }))).AuthenticationResult!.RefreshToken!;
    await assert.rejects(
      active.client.send(new InitiateAuthCommand({
        ClientId: clientId,
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: { REFRESH_TOKEN: original },
      })),
      (error: any) => error?.name === "InvalidParameterException",
    );
    const [firstResult, retryResult] = await Promise.all([
      active.client.send(new GetTokensFromRefreshTokenCommand({
        ClientId: clientId,
        RefreshToken: original,
      })),
      active.client.send(new GetTokensFromRefreshTokenCommand({
        ClientId: clientId,
        RefreshToken: original,
      })),
    ]);
    const first = firstResult.AuthenticationResult!.RefreshToken!;
    const retry = retryResult.AuthenticationResult!.RefreshToken!;
    assert.notEqual(first, original);
    assert.notEqual(retry, original);
    assert.notEqual(first, retry);
    const sessionsBeforeRestart = Object.values(
      active.simulator.store.regionState(region).cognito.pools[poolId].refreshSessions,
    );
    assert.equal(new Set(sessionsBeforeRestart.map(session => session.expiresAt)).size, 1);
    assert.equal(new Set(sessionsBeforeRestart.map(session => session.authTime)).size, 1);
    const serialized = JSON.stringify(active.simulator.store.regionState(region).cognito);
    assert.equal(serialized.includes(original), false);
    assert.equal(serialized.includes(first), false);
    assert.equal(serialized.includes(retry), false);

    active.client.destroy();
    await active.simulator.stop();
    active = await start(root, clock);
    clock.advance(5_001);
    await assert.rejects(
      active.client.send(new GetTokensFromRefreshTokenCommand({
        ClientId: clientId,
        RefreshToken: original,
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    await assert.rejects(
      active.client.send(new GetTokensFromRefreshTokenCommand({
        ClientId: clientId,
        RefreshToken: first,
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
    await assert.rejects(
      active.client.send(new GetTokensFromRefreshTokenCommand({
        ClientId: clientId,
        RefreshToken: retry,
      })),
      (error: any) => error?.name === "NotAuthorizedException",
    );
  } finally {
    active?.client.destroy();
    await active?.simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
