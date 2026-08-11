import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminForgetDeviceCommand,
  AdminInitiateAuthCommand,
  AdminListDevicesCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateDeviceStatusCommand,
  AssociateSoftwareTokenCommand,
  CognitoIdentityProviderClient,
  ConfirmDeviceCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DescribeUserPoolCommand,
  ForgetDeviceCommand,
  GetDeviceCommand,
  GetTokensFromRefreshTokenCommand,
  InitiateAuthCommand,
  ListDevicesCommand,
  RespondToAuthChallengeCommand,
  SetUserPoolMfaConfigCommand,
  UpdateDeviceStatusCommand,
  UpdateUserPoolCommand,
  VerifySoftwareTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const N = BigInt(`0x${[
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1",
  "29024E088A67CC74020BBEA63B139B22514A08798E3404D",
  "DEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C",
  "245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F40",
  "6B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651EC",
  "E45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8F",
  "D24CF5F83655D23DCA3AD961C62F356208552BB9ED52907",
  "7096966D670C354E4ABC9804F1746C08CA18217C32905E4",
  "62E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55D",
  "F06F4C52C9DE2BCBF6955817183995497CEA956AE515D226",
  "1898FA051015728E5A8AAAC42DAD33170D04507A33A85521",
  "ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F",
  "85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3",
  "D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F",
  "2B18177B200CBBE117577A615D6C770988C0BAD946E208E24",
  "FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFF",
  "FFFFFFFFFFFF",
].join("")}`);
const G = 2n;
const BYTES = 384;
const MAX_DEVICES = 50;

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

function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let value = base % N;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = result * value % N;
    value = value * value % N;
    power >>= 1n;
  }
  return result;
}

function pad(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(BYTES * 2, "0"), "hex");
}

function hash(...values: Array<string | Buffer>): Buffer {
  const digest = createHash("sha256");
  for (const value of values) digest.update(value);
  return digest.digest();
}

function timestamp(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${date.getUTCDate()} `
    + `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:`
    + `${String(date.getUTCSeconds()).padStart(2, "0")} UTC ${date.getUTCFullYear()}`;
}

function deviceVerifierConfig(deviceGroupKey: string, deviceKey: string, deviceSecret: string): {
  PasswordVerifier: string;
  Salt: string;
} {
  const identity = hash(`${deviceGroupKey}${deviceKey}:${deviceSecret}`);
  const salt = randomBytes(16);
  const x = BigInt(`0x${hash(salt, identity).toString("hex")}`);
  identity.fill(0);
  const verifier = pad(pow(G, x));
  try {
    return {
      PasswordVerifier: verifier.toString("base64"),
      Salt: salt.toString("base64"),
    };
  } finally {
    salt.fill(0);
    verifier.fill(0);
  }
}

async function createTrackedPool(
  client: CognitoIdentityProviderClient,
  deviceConfiguration: {
    ChallengeRequiredOnNewDevice?: boolean;
    DeviceOnlyRememberedOnUserPrompt?: boolean;
  },
  mfa = false,
): Promise<string> {
  const created = await client.send(new CreateUserPoolCommand({
    PoolName: "dug11-pool",
    UsernameAttributes: ["email"],
    AutoVerifiedAttributes: ["email"],
    Schema: [{ Name: "email", Required: true, Mutable: true }],
    DeviceConfiguration: deviceConfiguration,
    ...(mfa
      ? {
          MfaConfiguration: "OPTIONAL",
          EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
        }
      : {}),
  }));
  return created.UserPool!.Id!;
}

async function createPasswordClient(
  client: CognitoIdentityProviderClient,
  poolId: string,
  clientName = "dug11-client",
): Promise<string> {
  const created = await client.send(new CreateUserPoolClientCommand({
    UserPoolId: poolId,
    ClientName: clientName,
    ExplicitAuthFlows: [
      "ALLOW_USER_PASSWORD_AUTH",
      "ALLOW_ADMIN_USER_PASSWORD_AUTH",
      "ALLOW_USER_SRP_AUTH",
      "ALLOW_REFRESH_TOKEN_AUTH",
    ],
  }));
  return created.UserPoolClient!.ClientId!;
}

async function createConfirmedUser(
  client: CognitoIdentityProviderClient,
  poolId: string,
  email: string,
  password: string,
): Promise<void> {
  await client.send(new AdminCreateUserCommand({
    UserPoolId: poolId,
    Username: email,
    MessageAction: "SUPPRESS",
    UserAttributes: [
      { Name: "email", Value: email },
      { Name: "email_verified", Value: "true" },
    ],
  }));
  await client.send(new AdminSetUserPasswordCommand({
    UserPoolId: poolId,
    Username: email,
    Password: password,
    Permanent: true,
  }));
}

async function passwordAuth(
  client: CognitoIdentityProviderClient,
  clientId: string,
  email: string,
  password: string,
  deviceKey?: string,
) {
  return client.send(new InitiateAuthCommand({
    ClientId: clientId,
    AuthFlow: "USER_PASSWORD_AUTH",
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password,
      ...(deviceKey ? { DEVICE_KEY: deviceKey } : {}),
    },
  }));
}

function totp(secretBase32: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secretBase32.replace(/=+$/g, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    assert.ok(value >= 0);
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map(chunk => Number.parseInt(chunk, 2)));
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(now / 30_000), 4);
  const digest = createHmac("sha1", bytes).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  const code = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

async function setupSoftwareMfa(
  client: CognitoIdentityProviderClient,
  poolId: string,
  accessToken: string,
  email: string,
): Promise<string> {
  await client.send(new SetUserPoolMfaConfigCommand({
    UserPoolId: poolId,
    MfaConfiguration: "OPTIONAL",
    SoftwareTokenMfaConfiguration: { Enabled: true },
  }));
  const associated = await client.send(new AssociateSoftwareTokenCommand({ AccessToken: accessToken }));
  const secret = associated.SecretCode!;
  await client.send(new VerifySoftwareTokenCommand({
    AccessToken: accessToken,
    UserCode: totp(secret),
    FriendlyDeviceName: "dug11",
  }));
  await client.send(new AdminSetUserMFAPreferenceCommand({
    UserPoolId: poolId,
    Username: email,
    SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
  }));
  return secret;
}

async function completeDeviceSrp(
  client: CognitoIdentityProviderClient,
  clientId: string,
  email: string,
  deviceKey: string,
  deviceGroupKey: string,
  deviceSecret: string,
  session: string,
) {
  const a = BigInt(`0x${randomBytes(128).toString("hex")}`);
  const A = pow(G, a);
  const srpChallenge = await client.send(new RespondToAuthChallengeCommand({
    ClientId: clientId,
    ChallengeName: "DEVICE_SRP_AUTH",
    Session: session,
    ChallengeResponses: {
      USERNAME: email,
      DEVICE_KEY: deviceKey,
      SRP_A: A.toString(16),
    },
  }));
  assert.equal(srpChallenge.ChallengeName, "DEVICE_PASSWORD_VERIFIER");
  const parameters = srpChallenge.ChallengeParameters!;
  const B = BigInt(`0x${parameters.SRP_B}`);
  const salt = Buffer.from(parameters.SALT!, "hex");
  const k = BigInt(`0x${hash(pad(N), pad(G)).toString("hex")}`);
  const u = BigInt(`0x${hash(pad(A), pad(B)).toString("hex")}`);
  const identity = hash(`${deviceGroupKey}${deviceKey}:${deviceSecret}`);
  const x = BigInt(`0x${hash(salt, identity).toString("hex")}`);
  identity.fill(0);
  const base = (B - k * pow(G, x)) % N;
  const shared = pow((base + N) % N, a + u * x);
  const prk = createHmac("sha256", pad(u)).update(pad(shared)).digest();
  const key = createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from("Caldera Derived Key"), Buffer.from([1])]))
    .digest()
    .subarray(0, 16);
  const claimTimestamp = timestamp(new Date());
  const signature = createHmac("sha256", key)
    .update(deviceGroupKey)
    .update(deviceKey)
    .update(Buffer.from(parameters.SECRET_BLOCK!, "base64"))
    .update(claimTimestamp)
    .digest("base64");
  key.fill(0);
  prk.fill(0);
  return client.send(new RespondToAuthChallengeCommand({
    ClientId: clientId,
    ChallengeName: "DEVICE_PASSWORD_VERIFIER",
    Session: srpChallenge.Session!,
    ChallengeResponses: {
      USERNAME: email,
      DEVICE_KEY: deviceKey,
      PASSWORD_CLAIM_SECRET_BLOCK: parameters.SECRET_BLOCK!,
      PASSWORD_CLAIM_SIGNATURE: signature,
      TIMESTAMP: claimTimestamp,
    },
  }));
}

test("DUG-11 first login issues pending NewDeviceMetadata and confirms protected verifier", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug11-confirm-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  try {
    await simulator.start();
    const client = sdk(simulator);
    const poolId = await createTrackedPool(client, {
      ChallengeRequiredOnNewDevice: true,
      DeviceOnlyRememberedOnUserPrompt: true,
    });
    const described = await client.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
    assert.deepEqual(described.UserPool?.DeviceConfiguration, {
      ChallengeRequiredOnNewDevice: true,
      DeviceOnlyRememberedOnUserPrompt: true,
    });
    const clientId = await createPasswordClient(client, poolId);
    const email = "confirm@example.test";
    const password = "Valid-password-1!";
    await createConfirmedUser(client, poolId, email, password);

    const first = await passwordAuth(client, clientId, email, password);
    const metadata = first.AuthenticationResult?.NewDeviceMetadata;
    assert.ok(metadata?.DeviceKey);
    assert.ok(metadata?.DeviceGroupKey);
    assert.match(metadata!.DeviceKey!, new RegExp(`^${region}_[0-9a-f-]+$`));

    await assert.rejects(
      client.send(new ConfirmDeviceCommand({
        AccessToken: first.AuthenticationResult!.AccessToken!,
        DeviceKey: `${region}_${cryptoRandomUuid()}`,
        DeviceSecretVerifierConfig: deviceVerifierConfig("x", "y", "z"),
      })),
      (error: any) => error?.name === "ResourceNotFoundException",
    );

    const deviceSecret = randomBytes(16).toString("base64url");
    const verifier = deviceVerifierConfig(metadata!.DeviceGroupKey!, metadata!.DeviceKey!, deviceSecret);
    const confirmed = await client.send(new ConfirmDeviceCommand({
      AccessToken: first.AuthenticationResult!.AccessToken!,
      DeviceKey: metadata!.DeviceKey!,
      DeviceName: "Laptop",
      DeviceSecretVerifierConfig: verifier,
    }));
    assert.equal(confirmed.UserConfirmationNecessary, true);

    await assert.rejects(
      client.send(new ConfirmDeviceCommand({
        AccessToken: first.AuthenticationResult!.AccessToken!,
        DeviceKey: metadata!.DeviceKey!,
        DeviceSecretVerifierConfig: verifier,
      })),
      (error: any) => error?.name === "ResourceNotFoundException" || error?.name === "DeviceKeyExistsException",
    );

    const listed = await client.send(new ListDevicesCommand({
      AccessToken: first.AuthenticationResult!.AccessToken!,
    }));
    assert.equal(listed.Devices?.length, 1);
    assert.equal(listed.Devices?.[0]?.DeviceKey, metadata!.DeviceKey);

    const persisted = await readFile(join(root, "state.json"), "utf8");
    assert.equal(persisted.includes(verifier.PasswordVerifier), false);
    assert.equal(persisted.includes(verifier.Salt), false);
    assert.equal(persisted.includes(deviceSecret), false);

    const user = Object.values(simulator.store.regionState(region).cognito.pools[poolId].usersBySub)
      .find(entry => entry.attributes.email?.value === email);
    const device = user?.devices[metadata!.DeviceKey!];
    assert.ok(device);
    assert.equal(device.rememberedStatus, "not_remembered");
    assert.equal(device.secretVerifier, undefined);
    assert.ok(device.passwordVerifier?.envelope);
    assert.ok(device.salt?.envelope);
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COGGAP-27 refresh paths validate devices and issue restart-durable replacement metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug11-refresh-"));
  let simulator: StackSim | undefined;
  let client: CognitoIdentityProviderClient | undefined;
  try {
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
    await simulator.start();
    client = sdk(simulator);
    const poolId = await createTrackedPool(client, {
      ChallengeRequiredOnNewDevice: true,
      DeviceOnlyRememberedOnUserPrompt: false,
    });
    const clientId = await createPasswordClient(client, poolId, "refresh-device-client");
    const email = "refresh-device@example.test";
    const password = "Valid-password-1!";
    await createConfirmedUser(client, poolId, email, password);
    const first = await passwordAuth(client, clientId, email, password);
    const refreshToken = first.AuthenticationResult!.RefreshToken!;
    const original = first.AuthenticationResult!.NewDeviceMetadata!;
    const originalSecret = randomBytes(16).toString("base64url");
    await client.send(new ConfirmDeviceCommand({
      AccessToken: first.AuthenticationResult!.AccessToken!,
      DeviceKey: original.DeviceKey!,
      DeviceSecretVerifierConfig: deviceVerifierConfig(
        original.DeviceGroupKey!,
        original.DeviceKey!,
        originalSecret,
      ),
    }));

    const direct = await client.send(new GetTokensFromRefreshTokenCommand({
      ClientId: clientId,
      RefreshToken: refreshToken,
      DeviceKey: original.DeviceKey!,
    }));
    assert(direct.AuthenticationResult?.AccessToken);
    assert.equal(direct.AuthenticationResult?.NewDeviceMetadata, undefined);
    const flow = await client.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "REFRESH_TOKEN_AUTH",
      AuthParameters: { REFRESH_TOKEN: refreshToken, DEVICE_KEY: original.DeviceKey! },
    }));
    assert(flow.AuthenticationResult?.AccessToken);
    assert.equal(flow.AuthenticationResult?.NewDeviceMetadata, undefined);

    const replacement = await client.send(new GetTokensFromRefreshTokenCommand({
      ClientId: clientId,
      RefreshToken: refreshToken,
    }));
    assert(replacement.AuthenticationResult?.NewDeviceMetadata?.DeviceKey);
    assert.notEqual(replacement.AuthenticationResult!.NewDeviceMetadata!.DeviceKey, original.DeviceKey);
    const replacementMetadata = replacement.AuthenticationResult!.NewDeviceMetadata!;
    const replacementAccess = replacement.AuthenticationResult!.AccessToken!;

    client.destroy();
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
    await simulator.start();
    client = sdk(simulator);
    const replacementSecret = randomBytes(16).toString("base64url");
    await client.send(new ConfirmDeviceCommand({
      AccessToken: replacementAccess,
      DeviceKey: replacementMetadata.DeviceKey!,
      DeviceSecretVerifierConfig: deviceVerifierConfig(
        replacementMetadata.DeviceGroupKey!,
        replacementMetadata.DeviceKey!,
        replacementSecret,
      ),
    }));

    const wrong = await client.send(new GetTokensFromRefreshTokenCommand({
      ClientId: clientId,
      RefreshToken: refreshToken,
      DeviceKey: `${region}_00000000-0000-4000-8000-000000000000`,
    }));
    assert(wrong.AuthenticationResult?.NewDeviceMetadata?.DeviceKey);
  } finally {
    client?.destroy();
    await simulator?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function cryptoRandomUuid(): string {
  return randomBytes(16).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

test("DUG-11 remembered device replaces MFA with DEVICE_SRP_AUTH and DEVICE_PASSWORD_VERIFIER", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug11-device-srp-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  try {
    await simulator.start();
    let client = sdk(simulator);
    const poolId = await createTrackedPool(client, {
      ChallengeRequiredOnNewDevice: true,
      DeviceOnlyRememberedOnUserPrompt: false,
    }, true);
    const clientId = await createPasswordClient(client, poolId);
    const email = "device-srp@example.test";
    const password = "Valid-password-1!";
    await createConfirmedUser(client, poolId, email, password);

    const bootstrap = await passwordAuth(client, clientId, email, password);
    assert.ok(bootstrap.AuthenticationResult?.AccessToken);
    const totpSecret = await setupSoftwareMfa(
      client,
      poolId,
      bootstrap.AuthenticationResult!.AccessToken!,
      email,
    );

    const challenged = await passwordAuth(client, clientId, email, password);
    assert.equal(challenged.ChallengeName, "SOFTWARE_TOKEN_MFA");
    const mfaCompleted = await client.send(new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      Session: challenged.Session!,
      ChallengeResponses: {
        USERNAME: email,
        SOFTWARE_TOKEN_MFA_CODE: totp(totpSecret),
      },
    }));
    const metadata = mfaCompleted.AuthenticationResult?.NewDeviceMetadata;
    assert.ok(metadata?.DeviceKey);
    assert.ok(metadata?.DeviceGroupKey);
    const deviceSecret = randomBytes(16).toString("base64url");
    const confirmed = await client.send(new ConfirmDeviceCommand({
      AccessToken: mfaCompleted.AuthenticationResult!.AccessToken!,
      DeviceKey: metadata!.DeviceKey!,
      DeviceName: "Phone",
      DeviceSecretVerifierConfig: deviceVerifierConfig(
        metadata!.DeviceGroupKey!,
        metadata!.DeviceKey!,
        deviceSecret,
      ),
    }));
    assert.equal(confirmed.UserConfirmationNecessary, false);

    const tokenSources: string[] = [];
    const service = simulator.cognito as any;
    const originalInvokeTrigger = service.invokeTrigger.bind(service);
    service.invokeTrigger = async (...args: any[]) => {
      if (args[3] === "preTokenGeneration") tokenSources.push(args[4]);
      return originalInvokeTrigger(...args);
    };

    const rememberedLogin = await passwordAuth(
      client,
      clientId,
      email,
      password,
      metadata!.DeviceKey!,
    );
    assert.equal(rememberedLogin.ChallengeName, "DEVICE_SRP_AUTH");
    assert.equal(rememberedLogin.ChallengeParameters?.DEVICE_KEY, metadata!.DeviceKey);

    const completed = await completeDeviceSrp(
      client,
      clientId,
      email,
      metadata!.DeviceKey!,
      metadata!.DeviceGroupKey!,
      deviceSecret,
      rememberedLogin.Session!,
    );
    assert.ok(completed.AuthenticationResult?.AccessToken);
    assert.ok(completed.AuthenticationResult?.RefreshToken);
    assert(tokenSources.includes("TokenGeneration_AuthenticateDevice"));

    await assert.rejects(
      completeDeviceSrp(
        client,
        clientId,
        email,
        metadata!.DeviceKey!,
        metadata!.DeviceGroupKey!,
        "wrong-device-secret",
        (await passwordAuth(client, clientId, email, password, metadata!.DeviceKey!)).Session!,
      ),
      (error: any) => error?.name === "NotAuthorizedException",
    );

    client.destroy();
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
    await simulator.start();
    client = sdk(simulator);
    const afterRestart = await passwordAuth(client, clientId, email, password, metadata!.DeviceKey!);
    assert.equal(afterRestart.ChallengeName, "DEVICE_SRP_AUTH");
    const restarted = await completeDeviceSrp(
      client,
      clientId,
      email,
      metadata!.DeviceKey!,
      metadata!.DeviceGroupKey!,
      deviceSecret,
      afterRestart.Session!,
    );
    assert.ok(restarted.AuthenticationResult?.AccessToken);

    await client.send(new UpdateDeviceStatusCommand({
      AccessToken: restarted.AuthenticationResult!.AccessToken!,
      DeviceKey: metadata!.DeviceKey!,
      DeviceRememberedStatus: "not_remembered",
    }));
    const notRemembered = await passwordAuth(client, clientId, email, password, metadata!.DeviceKey!);
    assert.equal(notRemembered.ChallengeName, "SOFTWARE_TOKEN_MFA");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("DUG-11 rejects disabled tracking, mismatches, forget without token revoke, quota, and pagination", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug11-lifecycle-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  try {
    await simulator.start();
    const client = sdk(simulator);

    const plainPool = await client.send(new CreateUserPoolCommand({
      PoolName: "no-devices",
      UsernameAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
    }));
    assert.equal(plainPool.UserPool?.DeviceConfiguration, undefined);
    const plainClientId = await createPasswordClient(client, plainPool.UserPool!.Id!);
    const plainEmail = "plain@example.test";
    const password = "Valid-password-1!";
    await createConfirmedUser(client, plainPool.UserPool!.Id!, plainEmail, password);
    const plainAuth = await passwordAuth(client, plainClientId, plainEmail, password);
    assert.equal(plainAuth.AuthenticationResult?.NewDeviceMetadata, undefined);

    const poolId = await createTrackedPool(client, {
      ChallengeRequiredOnNewDevice: true,
      DeviceOnlyRememberedOnUserPrompt: false,
    });
    const clientId = await createPasswordClient(client, poolId, "dug11-client-a");
    const otherClientId = await createPasswordClient(client, poolId, "dug11-client-b");
    const email = "lifecycle@example.test";
    await createConfirmedUser(client, poolId, email, password);
    const first = await passwordAuth(client, clientId, email, password);
    const metadata = first.AuthenticationResult!.NewDeviceMetadata!;
    const deviceSecret = randomBytes(16).toString("base64url");
    const otherAuth = await passwordAuth(client, otherClientId, email, password);
    await assert.rejects(
      client.send(new ConfirmDeviceCommand({
        AccessToken: otherAuth.AuthenticationResult!.AccessToken!,
        DeviceKey: metadata.DeviceKey!,
        DeviceSecretVerifierConfig: deviceVerifierConfig(
          metadata.DeviceGroupKey!,
          metadata.DeviceKey!,
          deviceSecret,
        ),
      })),
      (error: any) => error?.name === "ResourceNotFoundException" || error?.name === "NotAuthorizedException",
    );
    await client.send(new ConfirmDeviceCommand({
      AccessToken: first.AuthenticationResult!.AccessToken!,
      DeviceKey: metadata.DeviceKey!,
      DeviceSecretVerifierConfig: deviceVerifierConfig(
        metadata.DeviceGroupKey!,
        metadata.DeviceKey!,
        deviceSecret,
      ),
    }));

    const userState = Object.values(simulator.store.regionState(region).cognito.pools[poolId].usersBySub)
      .find(entry => entry.attributes.email?.value === email)!;
    assert.equal(userState.devices[metadata.DeviceKey!]?.key, metadata.DeviceKey);
    const now = Date.now();
    let seedIndex = 0;
    while (Object.keys(userState.devices).length < MAX_DEVICES) {
      seedIndex += 1;
      const key = `${region}_${cryptoRandomUuid()}`;
      const verifier = deviceVerifierConfig(`-seed${seedIndex}`, key, `secret-${seedIndex}`);
      userState.devices[key] = {
        key,
        groupKey: `-seed${seedIndex}`,
        name: `device-${seedIndex}`,
        rememberedStatus: "remembered",
        createdAt: now + seedIndex,
        lastModifiedAt: now + seedIndex,
        passwordVerifier: {
          id: `seed-verifier-${seedIndex}`,
          version: 1,
          envelope: {
            version: 1,
            keyVersion: 1,
            purpose: "DEVICE_PASSWORD_VERIFIER",
            nonce: Buffer.alloc(12, seedIndex % 256).toString("base64url"),
            ciphertext: Buffer.from(verifier.PasswordVerifier).toString("base64url"),
            authTag: Buffer.alloc(16, seedIndex % 256).toString("base64url"),
          },
        },
        salt: {
          id: `seed-salt-${seedIndex}`,
          version: 1,
          envelope: {
            version: 1,
            keyVersion: 1,
            purpose: "DEVICE_SALT",
            nonce: Buffer.alloc(12, (seedIndex + 1) % 256).toString("base64url"),
            ciphertext: Buffer.from(verifier.Salt).toString("base64url"),
            authTag: Buffer.alloc(16, (seedIndex + 1) % 256).toString("base64url"),
          },
        },
      };
    }
    const keys = Object.keys(userState.devices).sort();
    assert.equal(keys.length, MAX_DEVICES);
    await simulator.store.save();

    const over = await passwordAuth(client, clientId, email, password);
    await assert.rejects(
      client.send(new ConfirmDeviceCommand({
        AccessToken: over.AuthenticationResult!.AccessToken!,
        DeviceKey: over.AuthenticationResult!.NewDeviceMetadata!.DeviceKey!,
        DeviceSecretVerifierConfig: deviceVerifierConfig(
          over.AuthenticationResult!.NewDeviceMetadata!.DeviceGroupKey!,
          over.AuthenticationResult!.NewDeviceMetadata!.DeviceKey!,
          "overflow",
        ),
      })),
      (error: any) => error?.name === "LimitExceededException",
    );

    const page1 = await client.send(new ListDevicesCommand({
      AccessToken: over.AuthenticationResult!.AccessToken!,
      Limit: 10,
    }));
    assert.equal(page1.Devices?.length, 10);
    assert.ok(page1.PaginationToken);
    const page2 = await client.send(new ListDevicesCommand({
      AccessToken: over.AuthenticationResult!.AccessToken!,
      Limit: 10,
      PaginationToken: page1.PaginationToken,
    }));
    assert.equal(page2.Devices?.length, 10);
    assert.notEqual(page2.Devices?.[0]?.DeviceKey, page1.Devices?.[0]?.DeviceKey);

    const adminPage = await client.send(new AdminListDevicesCommand({
      UserPoolId: poolId,
      Username: email,
      Limit: 5,
    }));
    assert.equal(adminPage.Devices?.length, 5);
    assert.ok(adminPage.PaginationToken);

    await client.send(new AdminUpdateDeviceStatusCommand({
      UserPoolId: poolId,
      Username: email,
      DeviceKey: keys[1]!,
      DeviceRememberedStatus: "not_remembered",
    }));
    await client.send(new AdminForgetDeviceCommand({
      UserPoolId: poolId,
      Username: email,
      DeviceKey: keys[0]!,
    }));

    const forgetKey = keys.find(key => key !== keys[0] && key !== keys[1])!;
    const beforeForgetAccess = over.AuthenticationResult!.AccessToken!;
    await client.send(new ForgetDeviceCommand({
      AccessToken: beforeForgetAccess,
      DeviceKey: forgetKey,
    }));
    assert.ok((await client.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "REFRESH_TOKEN_AUTH",
      AuthParameters: { REFRESH_TOKEN: first.AuthenticationResult!.RefreshToken! },
    }))).AuthenticationResult?.AccessToken);
    await assert.rejects(
      client.send(new GetDeviceCommand({
        AccessToken: beforeForgetAccess,
        DeviceKey: forgetKey,
      })),
      (error: any) => error?.name === "ResourceNotFoundException",
    );

    await client.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: email }));
    assert.equal(
      Object.values(simulator.store.regionState(region).cognito.pools[poolId].usersBySub)
        .some(entry => entry.attributes.email?.value === email),
      false,
    );

    const disableResponse = await fetch(endpoint(simulator), {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.UpdateUserPool",
      },
      body: JSON.stringify({
        UserPoolId: poolId,
        DeviceConfiguration: null,
        AutoVerifiedAttributes: ["email"],
        MfaConfiguration: "OFF",
        Policies: {
          PasswordPolicy: {
            MinimumLength: 8,
            RequireUppercase: true,
            RequireLowercase: true,
            RequireNumbers: true,
            RequireSymbols: true,
            TemporaryPasswordValidityDays: 7,
          },
        },
      }),
    });
    assert.equal(disableResponse.status, 200);
    const disabled = await client.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
    assert.equal(disabled.UserPool?.DeviceConfiguration ?? undefined, undefined);
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("DUG-11 ChallengeRequiredOnNewDevice false keeps MFA despite remembered device", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug11-no-challenge-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  try {
    await simulator.start();
    const client = sdk(simulator);
    const poolId = await createTrackedPool(client, {
      ChallengeRequiredOnNewDevice: false,
      DeviceOnlyRememberedOnUserPrompt: false,
    }, true);
    const clientId = await createPasswordClient(client, poolId);
    const email = "no-device-mfa@example.test";
    const password = "Valid-password-1!";
    await createConfirmedUser(client, poolId, email, password);
    const bootstrap = await passwordAuth(client, clientId, email, password);
    const totpSecret = await setupSoftwareMfa(
      client,
      poolId,
      bootstrap.AuthenticationResult!.AccessToken!,
      email,
    );
    const mfa = await passwordAuth(client, clientId, email, password);
    const completed = await client.send(new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      Session: mfa.Session!,
      ChallengeResponses: {
        USERNAME: email,
        SOFTWARE_TOKEN_MFA_CODE: totp(totpSecret),
      },
    }));
    const metadata = completed.AuthenticationResult!.NewDeviceMetadata!;
    await client.send(new ConfirmDeviceCommand({
      AccessToken: completed.AuthenticationResult!.AccessToken!,
      DeviceKey: metadata.DeviceKey!,
      DeviceSecretVerifierConfig: deviceVerifierConfig(
        metadata.DeviceGroupKey!,
        metadata.DeviceKey!,
        randomBytes(8).toString("hex"),
      ),
    }));
    const again = await passwordAuth(client, clientId, email, password, metadata.DeviceKey!);
    assert.equal(again.ChallengeName, "SOFTWARE_TOKEN_MFA");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
