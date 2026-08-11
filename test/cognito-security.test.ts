import assert from "node:assert/strict";
import {
  createPublicKey,
  generateKeyPairSync,
  sign as signSignature,
  verify as verifySignature,
  type JsonWebKey,
} from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DescribeUserPoolClientCommand,
  InvalidParameterException,
  NotAuthorizedException,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { clientSecretHash } from "../src/cognito/client-secret.js";
import {
  COGNITO_PASSWORD_KDF,
  CognitoPasswordHasher,
  validatePasswordPolicy,
} from "../src/cognito/passwords.js";
import {
  CognitoSecrets,
  CognitoSecurityError,
  type CognitoSecretBinding,
} from "../src/cognito/secrets.js";
import { signCognitoJwt } from "../src/cognito/signing.js";
import {
  cognitoIssuer,
  verifyCognitoAccessToken,
} from "../src/cognito/tokens.js";
import { AwsError } from "../src/errors.js";
import { StackSim } from "../src/server.js";
import type { CognitoPasswordHashState, CognitoSecretEnvelope } from "../src/types.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function endpoint(simulator: StackSim): string {
  return `http://127.0.0.1:${simulator.port}`;
}

function sdk(simulator: StackSim): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({ endpoint: endpoint(simulator), region, credentials });
}

function changeBase64Url(value: string): string {
  const final = value.at(-1)!;
  return `${value.slice(0, -1)}${final === "A" ? "B" : "A"}`;
}

test("Cognito envelopes bind every scope field, reject tampering, and require the original installation key", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-envelope-"));
  const binding: CognitoSecretBinding = {
    purpose: "APP_CLIENT_SECRET",
    accountId: "111122223333",
    region,
    poolId: "eu-west-1_AbCdEf123",
    ownerId: "abcdefghijklmnopqrstuvwx12",
    secretId: "secret-version-id",
    secretVersion: 1,
    field: "client-secret",
  };
  const value = Buffer.from("CallerSuppliedSecret_12345", "utf8");
  try {
    const firstStore = new CognitoSecrets(root);
    await firstStore.start(false);
    firstStore.assertAvailable();
    const key = await readFile(firstStore.keyFile);
    assert.equal(key.length, 32);
    if (process.platform !== "win32") {
      assert.equal((await stat(firstStore.keyFile)).mode & 0o077, 0);
    }

    const first = firstStore.encrypt(value, binding);
    const second = firstStore.encrypt(value, binding);
    assert.notEqual(first.nonce, second.nonce);
    assert.notEqual(first.ciphertext, second.ciphertext);
    assert.equal(first.version, 1);
    assert.equal(first.keyVersion, 1);
    assert.equal(first.purpose, "APP_CLIENT_SECRET");
    const plaintext = firstStore.decrypt(first, binding);
    try {
      assert.equal(plaintext.toString("utf8"), value.toString("utf8"));
    } finally {
      plaintext.fill(0);
    }

    const tampered: CognitoSecretEnvelope[] = [
      { ...first, nonce: changeBase64Url(first.nonce) },
      { ...first, ciphertext: changeBase64Url(first.ciphertext) },
      { ...first, authTag: changeBase64Url(first.authTag) },
      { ...first, version: 2 as 1 },
      { ...first, keyVersion: 2 as 1 },
      { ...first, purpose: "SIGNING_PRIVATE_KEY" },
    ];
    for (const envelope of tampered) {
      assert.throws(() => firstStore.decrypt(envelope, binding), CognitoSecurityError);
    }

    for (const changed of [
      { accountId: "999900001111" },
      { region: "us-east-1" },
      { poolId: "eu-west-1_OtherPool" },
      { ownerId: "another-client" },
      { secretId: "another-secret" },
      { secretVersion: 2 },
      { field: "another-field" },
    ]) {
      assert.throws(
        () => firstStore.decrypt(first, { ...binding, ...changed }),
        CognitoSecurityError,
      );
    }

    const restarted = new CognitoSecrets(root);
    await restarted.start(true);
    const afterRestart = restarted.decrypt(first, binding);
    try {
      assert.equal(afterRestart.toString("utf8"), value.toString("utf8"));
    } finally {
      afterRestart.fill(0);
    }

    const backup = `${restarted.keyFile}.backup`;
    await rename(restarted.keyFile, backup);
    const missing = new CognitoSecrets(root);
    await missing.start(true);
    assert.throws(() => missing.assertAvailable(), /Restore secrets\/cognito\.key/);
    await assert.rejects(readFile(missing.keyFile), (error: any) => error?.code === "ENOENT");
  } finally {
    value.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("Cognito password records use the frozen asynchronous scrypt profile and constant-size verification", async () => {
  const hasher = new CognitoPasswordHasher();
  const password = "Correct-Horse-1!";
  const first = await hasher.hash(password);
  const second = await hasher.hash(password);

  assert.deepEqual(
    {
      version: first.version,
      algorithm: first.algorithm,
      N: first.N,
      r: first.r,
      p: first.p,
      maxmem: first.maxmem,
    },
    {
      version: 1,
      algorithm: "scrypt",
      N: 32_768,
      r: 8,
      p: 1,
      maxmem: 67_108_864,
    },
  );
  assert.equal(Buffer.from(first.salt, "base64url").length, COGNITO_PASSWORD_KDF.saltBytes);
  assert.equal(Buffer.from(first.digest, "base64url").length, COGNITO_PASSWORD_KDF.outputBytes);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.digest, second.digest);
  assert(!JSON.stringify(first).includes(password));
  assert.equal(await hasher.verify(password, first), true);
  assert.equal(await hasher.verify("Wrong-Horse-1!", first), false);
  assert.equal(await hasher.dummy("Missing-User-1!"), false);

  const policy = {
    minimumLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumbers: true,
    requireSymbols: true,
    temporaryPasswordValidityDays: 7,
  };
  validatePasswordPolicy(password, policy);
  assert.throws(
    () => validatePasswordPolicy("short", policy),
    (error: unknown) => error instanceof AwsError && error.code === "InvalidPasswordException",
  );
  await assert.rejects(
    hasher.hash("x".repeat(COGNITO_PASSWORD_KDF.maximumInputBytes + 1)),
    (error: unknown) => error instanceof AwsError && error.code === "InvalidPasswordException",
  );
  await assert.rejects(
    hasher.verify(password, { ...first, N: 16_384 } as unknown as CognitoPasswordHashState),
    CognitoSecurityError,
  );
});

test("Cognito pools persist separate RSA signing keys and expose public-only loopback JWKS", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-signing-"));
  const options = { port: 0, invokePort: 0, dataDir: root, region, authMode: "off" as const };
  let simulator = new StackSim(options);
  let cognito = sdk(simulator);
  try {
    await simulator.start();
    cognito.destroy();
    cognito = sdk(simulator);
    const created = await cognito.send(new CreateUserPoolCommand({ PoolName: "signing-pool" }));
    const poolId = created.UserPool!.Id!;
    const pool = simulator.store.regionState(region).cognito.pools[poolId];
    assert(pool.signingKeys);
    assert.notEqual(pool.signingKeys.id.activeKid, pool.signingKeys.access.activeKid);

    const jwksUrl = `${endpoint(simulator)}/_stacksim/cognito-idp/${region}/${poolId}/.well-known/jwks.json`;
    const response = await fetch(jwksUrl);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=300");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const etag = response.headers.get("etag");
    assert(etag);
    const body = await response.json() as { keys: JsonWebKey[] };
    assert.equal(body.keys.length, 2);
    assert.deepEqual(new Set(body.keys.map(key => key.kid)), new Set([
      pool.signingKeys.id.activeKid,
      pool.signingKeys.access.activeKid,
    ]));
    for (const key of body.keys) {
      assert.equal(key.kty, "RSA");
      assert.equal(key.alg, "RS256");
      assert.equal(key.use, "sig");
      assert.equal(typeof key.n, "string");
      assert.equal(typeof key.e, "string");
      assert(!("d" in key));
      assert(!("p" in key));
      assert(!("q" in key));
      createPublicKey({ key, format: "jwk" });
    }
    const notModified = await fetch(jwksUrl, { headers: { "if-none-match": etag! } });
    assert.equal(notModified.status, 304);
    assert.equal(await notModified.text(), "");
    const wrongRegion = await fetch(
      `${endpoint(simulator)}/_stacksim/cognito-idp/us-east-1/${poolId}/.well-known/jwks.json`,
    );
    assert.equal(wrongRegion.status, 404);
    assert.equal(wrongRegion.headers.get("cache-control"), "no-store");

    const secretStore = new CognitoSecrets(root);
    await secretStore.start(true);
    const claims = {
      iss: `https://cognito-idp.${region}.amazonaws.com/${poolId}`,
      sub: "subject",
      iat: 1,
      exp: 2,
    };
    const idToken = signCognitoJwt(
      secretStore,
      simulator.store.accountId,
      region,
      poolId,
      pool.signingKeys,
      "id",
      { ...claims, token_use: "id" },
    );
    const accessToken = signCognitoJwt(
      secretStore,
      simulator.store.accountId,
      region,
      poolId,
      pool.signingKeys,
      "access",
      { ...claims, token_use: "access" },
    );
    for (const [token, expectedKid] of [
      [idToken, pool.signingKeys.id.activeKid],
      [accessToken, pool.signingKeys.access.activeKid],
    ] as const) {
      const parts = token.split(".");
      assert.equal(parts.length, 3);
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      assert.deepEqual(header, { alg: "RS256", kid: expectedKid, typ: "JWT" });
      const jwk = body.keys.find(key => key.kid === expectedKid)!;
      assert.equal(
        verifySignature(
          "RSA-SHA256",
          Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
          createPublicKey({ key: jwk, format: "jwk" }),
          Buffer.from(parts[2], "base64url"),
        ),
        true,
      );
    }

    const privateId = pool.signingKeys.id.keys[pool.signingKeys.id.activeKid].privateKey;
    const stateText = await readFile(join(root, "state.json"), "utf8");
    assert(!stateText.includes(idToken));
    assert(!stateText.includes(accessToken));
    assert(!stateText.includes("BEGIN PRIVATE KEY"));
    assert(stateText.includes(privateId.envelope.ciphertext));

    cognito.destroy();
    await simulator.stop();
    simulator = new StackSim(options);
    await simulator.start();
    cognito = sdk(simulator);
    const restartedPool = simulator.store.regionState(region).cognito.pools[poolId];
    assert.equal(restartedPool.signingKeys?.id.activeKid, pool.signingKeys.id.activeKid);
    assert.equal(restartedPool.signingKeys?.access.activeKid, pool.signingKeys.access.activeKid);
    const restartedJwks = await fetch(
      `${endpoint(simulator)}/_stacksim/cognito-idp/${region}/${poolId}/.well-known/jwks.json`,
    );
    assert.equal(restartedJwks.headers.get("etag"), etag);
  } finally {
    cognito.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("official Cognito client persists encrypted generated and caller-supplied app-client secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-client-secret-"));
  const options = { port: 0, invokePort: 0, dataDir: root, region, authMode: "off" as const };
  let simulator = new StackSim(options);
  let cognito = sdk(simulator);
  const callerSecret = "CallerSuppliedSecret_12345";
  try {
    await simulator.start();
    cognito.destroy();
    cognito = sdk(simulator);
    const pool = await cognito.send(new CreateUserPoolCommand({ PoolName: "secret-pool" }));
    const poolId = pool.UserPool!.Id!;
    const generated = await cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "generated-secret",
      GenerateSecret: true,
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }));
    const generatedId = generated.UserPoolClient!.ClientId!;
    const generatedSecret = generated.UserPoolClient!.ClientSecret!;
    assert.match(generatedSecret, /^[A-Za-z0-9]{64}$/);

    const supplied = await cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "supplied-secret",
      ClientSecret: callerSecret,
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }));
    const suppliedId = supplied.UserPoolClient!.ClientId!;
    assert.equal(supplied.UserPoolClient?.ClientSecret, callerSecret);
    assert.equal(
      (await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: poolId, ClientId: generatedId })))
        .UserPoolClient?.ClientSecret,
      generatedSecret,
    );
    assert.equal(
      (await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: poolId, ClientId: suppliedId })))
        .UserPoolClient?.ClientSecret,
      callerSecret,
    );

    const generatedState = simulator.store.regionState(region).cognito.pools[poolId].clients[generatedId];
    const suppliedState = simulator.store.regionState(region).cognito.pools[poolId].clients[suppliedId];
    assert(generatedState.secret);
    assert(suppliedState.secret);
    assert.notEqual(generatedState.secret.envelope.nonce, suppliedState.secret.envelope.nonce);
    const serialized = await readFile(join(root, "state.json"), "utf8");
    assert(!serialized.includes(generatedSecret));
    assert(!serialized.includes(callerSecret));
    assert(!serialized.includes("cognito.key"));
    assert.equal((await readFile(join(root, "secrets", "cognito.key"))).length, 32);

    await assert.rejects(
      cognito.send(new CreateUserPoolClientCommand({
        UserPoolId: poolId,
        ClientName: "mutually-exclusive",
        GenerateSecret: true,
        ClientSecret: callerSecret,
        ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
      })),
      (error: unknown) => error instanceof InvalidParameterException && /mutually exclusive/.test(error.message),
    );
    await assert.rejects(
      cognito.send(new CreateUserPoolClientCommand({
        UserPoolId: poolId,
        ClientName: "short-secret",
        ClientSecret: "too-short",
        ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
      })),
      (error: unknown) => error instanceof InvalidParameterException && /24-64/.test(error.message),
    );
    const invalidUpdate = await fetch(endpoint(simulator), {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.UpdateUserPoolClient",
      },
      body: JSON.stringify({
        UserPoolId: poolId,
        ClientId: generatedId,
        ClientName: "no-rotation-here",
        GenerateSecret: true,
        ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
      }),
    });
    assert.equal(invalidUpdate.status, 400);
    assert.equal((await invalidUpdate.json() as any).__type, "InvalidParameterException");

    const username = "person@example.com";
    await assert.rejects(
      cognito.send(new SignUpCommand({
        ClientId: generatedId,
        Username: username,
        Password: "Valid-password-1!",
        UserAttributes: [{ Name: "email", Value: username }],
      })),
      (error: unknown) => error instanceof NotAuthorizedException && /secret proof/.test(error.message),
    );
    await assert.rejects(
      cognito.send(new SignUpCommand({
        ClientId: generatedId,
        Username: username,
        Password: "Valid-password-1!",
        UserAttributes: [{ Name: "email", Value: username }],
        SecretHash: clientSecretHash(Buffer.from("wrong-secret"), username, generatedId),
      })),
      (error: unknown) => error instanceof NotAuthorizedException && /secret proof/.test(error.message),
    );
    const signUp = await cognito.send(new SignUpCommand({
      ClientId: generatedId,
      Username: username,
      Password: "Valid-password-1!",
      UserAttributes: [{ Name: "email", Value: username }],
      SecretHash: clientSecretHash(Buffer.from(generatedSecret), username, generatedId),
    }));
    assert.equal(signUp.UserConfirmed, false);
    assert.match(signUp.UserSub ?? "", /^[0-9a-f-]{36}$/);

    cognito.destroy();
    await simulator.stop();
    simulator = new StackSim(options);
    await simulator.start();
    cognito = sdk(simulator);
    assert.equal(
      (await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: poolId, ClientId: generatedId })))
        .UserPoolClient?.ClientSecret,
      generatedSecret,
    );
    assert.equal(
      (await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: poolId, ClientId: suppliedId })))
        .UserPoolClient?.ClientSecret,
      callerSecret,
    );

    cognito.destroy();
    await simulator.stop();
    await rename(join(root, "secrets", "cognito.key"), join(root, "secrets", "cognito.key.backup"));
    simulator = new StackSim(options);
    await simulator.start();
    cognito = sdk(simulator);
    await assert.rejects(
      cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: poolId, ClientId: generatedId })),
      (error: unknown) => error instanceof Error
        && error.name === "InternalErrorException"
        && /Restore secrets\/cognito\.key/.test(error.message),
    );
    await assert.rejects(readFile(join(root, "secrets", "cognito.key")), (error: any) => error?.code === "ENOENT");
  } finally {
    cognito.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Cognito access-token verification rejects malformed algorithms, keys, claims, signatures, and time", () => {
  const nowMs = Date.parse("2026-07-24T17:00:00Z");
  const now = Math.floor(nowMs / 1_000);
  const poolId = "eu-west-1_AbCdEf123";
  const kid = "access-key";
  const primary = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = primary.publicKey.export({ format: "jwk" }) as JsonWebKey & {
    kid: string;
    alg: string;
    use: string;
  };
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const pool = {
    id: poolId,
    signingKeys: {
      access: {
        activeKid: kid,
        keys: {
          [kid]: {
            kid,
            tokenUse: "access",
            publicJwk,
          },
        },
      },
    },
  } as any;
  const claims = {
    iss: cognitoIssuer(region, poolId),
    sub: "subject",
    client_id: "a".repeat(26),
    token_use: "access",
    scope: "aws.cognito.signin.user.admin",
    auth_time: now - 10,
    iat: now - 10,
    exp: now + 300,
    username: "person",
    event_id: "event-id",
  };
  const encoded = (source: string): string => Buffer.from(source, "utf8").toString("base64url");
  const token = (
    header: Record<string, unknown>,
    payload: Record<string, unknown> | string,
    privateKey = primary.privateKey,
  ): string => {
    const first = encoded(JSON.stringify(header));
    const second = encoded(typeof payload === "string" ? payload : JSON.stringify(payload));
    const signature = signSignature("RSA-SHA256", Buffer.from(`${first}.${second}`, "ascii"), privateKey);
    return `${first}.${second}.${signature.toString("base64url")}`;
  };
  const valid = token({ alg: "RS256", kid, typ: "JWT" }, claims);
  assert.equal(
    verifyCognitoAccessToken(valid, { [poolId]: pool }, region, nowMs).claims.sub,
    "subject",
  );

  const invalid = [
    token({ alg: "HS256", kid, typ: "JWT" }, claims),
    token({ alg: "RS256", kid: "unknown", typ: "JWT" }, claims),
    token({ alg: "RS256", kid, typ: "JWT" }, { ...claims, iss: `${claims.iss}-other` }),
    token({ alg: "RS256", kid, typ: "JWT" }, { ...claims, token_use: "id" }),
    token({ alg: "RS256", kid, typ: "JWT" }, { ...claims, scope: "openid" }),
    token({ alg: "RS256", kid, typ: "JWT" }, { ...claims, exp: now }),
    token({ alg: "RS256", kid, typ: "JWT" }, { ...claims, iat: now + 301, exp: now + 600 }),
    token({ alg: "RS256", kid, typ: "JWT" }, claims, other.privateKey),
    token(
      { alg: "RS256", kid, typ: "JWT" },
      `${JSON.stringify(claims).slice(0, -1)},"\\u0073ub":"duplicate"}`,
    ),
  ];
  const tampered = valid.split(".");
  tampered[1] = changeBase64Url(tampered[1]);
  invalid.push(tampered.join("."));
  for (const candidate of invalid) {
    assert.throws(
      () => verifyCognitoAccessToken(candidate, { [poolId]: pool }, region, nowMs),
      /Access Token has been revoked/,
    );
  }
});
