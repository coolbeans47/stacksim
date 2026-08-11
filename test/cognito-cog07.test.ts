import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AddUserPoolClientSecretCommand,
  AdminCreateUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  ConfirmDeviceCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DeleteUserPoolClientSecretCommand,
  InitiateAuthCommand,
  ListUserPoolClientSecretsCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { COG07_BOUNDARY_OPERATIONS } from "../src/cognito/cog07-boundaries.js";
import { clientSecretHash } from "../src/cognito/client-secret.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

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

async function createPool(client: CognitoIdentityProviderClient): Promise<string> {
  const created = await client.send(new CreateUserPoolCommand({
    PoolName: "cog07-pool",
    UsernameAttributes: ["email"],
    AutoVerifiedAttributes: ["email"],
    Schema: [{ Name: "email", Required: true, Mutable: true }],
  }));
  return created.UserPool!.Id!;
}

async function createSecretClient(
  client: CognitoIdentityProviderClient,
  poolId: string,
  name: string,
  secret?: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const created = await client.send(new CreateUserPoolClientCommand({
    UserPoolId: poolId,
    ClientName: name,
    ...(secret === undefined ? { GenerateSecret: true } : { ClientSecret: secret }),
    ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
  }));
  return {
    clientId: created.UserPoolClient!.ClientId!,
    clientSecret: created.UserPoolClient!.ClientSecret!,
  };
}

test("COG-07 multi-secret lifecycle supports rotation and dual-secret authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cog07-secrets-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  try {
    await simulator.start();
    const client = sdk(simulator);
    const poolId = await createPool(client);
    const primarySecret = "PrimarySecretValue1234567890AB";
    const { clientId, clientSecret } = await createSecretClient(client, poolId, "rotation-client", primarySecret);
    assert.equal(clientSecret, primarySecret);

    const added = await client.send(new AddUserPoolClientSecretCommand({
      UserPoolId: poolId,
      ClientId: clientId,
    }));
    const secondarySecret = added.ClientSecretDescriptor!.ClientSecretValue!;
    assert.match(secondarySecret, /^[A-Za-z0-9]{64}$/);

    const listed = await client.send(new ListUserPoolClientSecretsCommand({
      UserPoolId: poolId,
      ClientId: clientId,
    }));
    assert.equal(listed.ClientSecrets!.length, 2);
    assert.equal(listed.ClientSecrets!.some(entry => entry.ClientSecretId === added.ClientSecretDescriptor!.ClientSecretId), true);
    assert.equal(listed.ClientSecrets!.some(entry => "ClientSecretValue" in (entry as object)), false);

    await assert.rejects(
      client.send(new AddUserPoolClientSecretCommand({ UserPoolId: poolId, ClientId: clientId })),
      (error: any) => error.name === "LimitExceededException",
    );

    const email = "rotation-user@example.test";
    const password = "RotationPassword1!";
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: email,
      MessageAction: "SUPPRESS",
      UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
    }));
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: email,
      Password: password,
      Permanent: true,
    }));

    for (const secret of [primarySecret, secondarySecret]) {
      const auth = await client.send(new InitiateAuthCommand({
        ClientId: clientId,
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
          SECRET_HASH: clientSecretHash(Buffer.from(secret, "utf8"), email, clientId),
        },
      }));
      assert.equal(auth.AuthenticationResult?.AccessToken?.length! > 0, true);
    }

    const secretId = listed.ClientSecrets!.find(entry => entry.ClientSecretId !== added.ClientSecretDescriptor!.ClientSecretId)!.ClientSecretId!;
    await client.send(new DeleteUserPoolClientSecretCommand({
      UserPoolId: poolId,
      ClientId: clientId,
      ClientSecretId: secretId,
    }));

    await assert.rejects(
      client.send(new InitiateAuthCommand({
        ClientId: clientId,
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
          SECRET_HASH: clientSecretHash(Buffer.from(primarySecret, "utf8"), email, clientId),
        },
      })),
      (error: any) => error.name === "NotAuthorizedException",
    );

    const authWithSecondary = await client.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
        SECRET_HASH: clientSecretHash(Buffer.from(secondarySecret, "utf8"), email, clientId),
      },
    }));
    assert.equal(authWithSecondary.AuthenticationResult?.AccessToken?.length! > 0, true);

    await assert.rejects(
      client.send(new DeleteUserPoolClientSecretCommand({
        UserPoolId: poolId,
        ClientId: clientId,
        ClientSecretId: added.ClientSecretDescriptor!.ClientSecretId!,
      })),
      (error: any) => error.name === "InvalidParameterException",
    );
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COG-07 dependency boundaries return modeled errors instead of unknown operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cog07-boundaries-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  try {
    await simulator.start();
    for (const operation of COG07_BOUNDARY_OPERATIONS) {
      const response = await fetch(endpoint(simulator), {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": `AWSCognitoIdentityProviderService.${operation}`,
        },
        body: "{}",
      });
      assert.equal(response.status, 400, operation);
      const body = await response.json() as { __type?: string; message?: string };
      assert.match(body.__type ?? "", /InvalidParameterException/, operation);
      assert.match(body.message ?? "", /not implemented in this simulator/i, operation);
    }
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COG-07 ConfirmDevice persists device secret verifier material under the protected-value contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cog07-device-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  try {
    await simulator.start();
    const client = sdk(simulator);
    const createdPool = await client.send(new CreateUserPoolCommand({
      PoolName: "cog07-device-pool",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
      DeviceConfiguration: {
        ChallengeRequiredOnNewDevice: true,
        DeviceOnlyRememberedOnUserPrompt: false,
      },
    }));
    const poolId = createdPool.UserPool!.Id!;
    const createdClient = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "device-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_ADMIN_USER_PASSWORD_AUTH"],
    }));
    const clientId = createdClient.UserPoolClient!.ClientId!;
    const email = "device-user@example.test";
    const password = "DevicePassword1!";
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: email,
      MessageAction: "SUPPRESS",
      UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
    }));
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: email,
      Password: password,
      Permanent: true,
    }));
    const auth = await client.send(new AdminInitiateAuthCommand({
      UserPoolId: poolId,
      ClientId: clientId,
      AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }));
    const metadata = auth.AuthenticationResult!.NewDeviceMetadata!;
    assert.ok(metadata.DeviceKey);
    const passwordVerifier = Buffer.alloc(32, 7).toString("base64");
    const salt = Buffer.alloc(16, 9).toString("base64");
    await client.send(new ConfirmDeviceCommand({
      AccessToken: auth.AuthenticationResult!.AccessToken!,
      DeviceKey: metadata.DeviceKey!,
      DeviceName: "Browser",
      DeviceSecretVerifierConfig: {
        PasswordVerifier: passwordVerifier,
        Salt: salt,
      },
    }));
    const user = Object.values(simulator.store.regionState(region).cognito.pools[poolId].usersBySub)
      .find(entry => entry.attributes.email?.value === email);
    const device = user?.devices[metadata.DeviceKey!];
    assert.equal(device?.secretVerifier, undefined);
    assert.equal(device?.passwordVerifier?.envelope.purpose, "DEVICE_PASSWORD_VERIFIER");
    assert.equal(device?.salt?.envelope.purpose, "DEVICE_SALT");
    assert.equal(JSON.stringify(device).includes(passwordVerifier), false);
    assert.equal(JSON.stringify(device).includes(salt), false);
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COG-07 schema v75 migrates legacy single app-client secrets into clientSecrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cog07-migration-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  let poolId = "";
  let clientId = "";
  try {
    await simulator.start();
    const client = sdk(simulator);
    poolId = await createPool(client);
    ({ clientId } = await createSecretClient(client, poolId, "legacy-client"));
    client.destroy();
    await simulator.stop();

    const statePath = join(root, "state.json");
    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(statePath, "utf8"));
    raw.schemaVersion = 75;
    const pool = raw.accounts["000000000000"].regions[region].cognito.pools[poolId];
    const appClient = pool.clients[clientId];
    appClient.secret = appClient.clientSecrets[0].envelope;
    delete appClient.clientSecrets;
    await (await import("node:fs/promises")).writeFile(statePath, JSON.stringify(raw));

    const restarted = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
    await restarted.start();
    const listed = await sdk(restarted).send(new ListUserPoolClientSecretsCommand({
      UserPoolId: poolId,
      ClientId: clientId,
    }));
    assert.equal(listed.ClientSecrets!.length, 1);
    await restarted.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
