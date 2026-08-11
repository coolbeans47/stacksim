import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DeleteUserPoolClientCommand,
  DeleteUserPoolCommand,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
  InvalidParameterException,
  ListUserPoolClientsCommand,
  ListUserPoolsCommand,
  SignUpCommand,
  UpdateUserPoolClientCommand,
  UpdateUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function endpoint(simulator: StackSim): string {
  return `http://127.0.0.1:${simulator.port}`;
}

function client(simulator: StackSim): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({ endpoint: endpoint(simulator), region, credentials });
}

test("official Cognito client uses AWS JSON 1.1 for opening pool and app-client control", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-protocol-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  let cognito = client(simulator);
  try {
    await simulator.start();
    cognito.destroy();
    cognito = client(simulator);

    const created = await cognito.send(new CreateUserPoolCommand({
      PoolName: "protocol-pool",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
      Policies: {
        PasswordPolicy: {
          MinimumLength: 12,
          RequireUppercase: true,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: false,
        },
      },
    }));
    const poolId = created.UserPool?.Id;
    assert.match(poolId ?? "", /^eu-west-1_[A-Za-z0-9]{9}$/);
    assert.equal(created.UserPool?.Arn, `arn:aws:cognito-idp:${region}:000000000000:userpool/${poolId}`);
    assert.equal(created.UserPool?.Policies?.PasswordPolicy?.MinimumLength, 12);
    assert(created.UserPool?.CreationDate instanceof Date);
    assert(created.$metadata.requestId);

    const described = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
    assert.equal(described.UserPool?.Name, "protocol-pool");
    assert.deepEqual(described.UserPool?.UsernameAttributes, ["email"]);
    assert.deepEqual(described.UserPool?.AutoVerifiedAttributes, ["email"]);
    assert.equal(described.UserPool?.UserPoolTier, "ESSENTIALS");

    const listed = await cognito.send(new ListUserPoolsCommand({ MaxResults: 1 }));
    assert.equal(listed.UserPools?.[0]?.Id, poolId);

    await cognito.send(new UpdateUserPoolCommand({
      UserPoolId: poolId,
      PoolName: "renamed-protocol-pool",
      DeletionProtection: "ACTIVE",
    }));
    const updated = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
    assert.equal(updated.UserPool?.Name, "renamed-protocol-pool");
    assert.equal(updated.UserPool?.DeletionProtection, "ACTIVE");
    assert.equal(updated.UserPool?.Policies?.PasswordPolicy?.MinimumLength, 8, "omitted update settings reset to AWS defaults");
    assert.deepEqual(updated.UserPool?.UsernameAttributes, ["email"], "immutable identity settings survive update");

    const app = await cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "web-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      PreventUserExistenceErrors: "ENABLED",
    }));
    const clientId = app.UserPoolClient?.ClientId;
    assert.match(clientId ?? "", /^[a-z0-9]{26}$/);
    assert.equal(app.UserPoolClient?.EnableTokenRevocation, true);
    assert.deepEqual(app.UserPoolClient?.TokenValidityUnits, {
      AccessToken: "hours",
      IdToken: "hours",
      RefreshToken: "days",
    });

    const describedClient = await cognito.send(new DescribeUserPoolClientCommand({
      UserPoolId: poolId,
      ClientId: clientId,
    }));
    assert.equal(describedClient.UserPoolClient?.ClientName, "web-client");
    const listedClients = await cognito.send(new ListUserPoolClientsCommand({ UserPoolId: poolId, MaxResults: 1 }));
    assert.equal(listedClients.UserPoolClients?.[0]?.ClientId, clientId);

    const changedClient = await cognito.send(new UpdateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientId: clientId,
      ClientName: "renamed-web-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      AccessTokenValidity: 30,
      IdTokenValidity: 30,
      TokenValidityUnits: { AccessToken: "minutes", IdToken: "minutes", RefreshToken: "days" },
    }));
    assert.equal(changedClient.UserPoolClient?.ClientName, "renamed-web-client");
    assert.equal(changedClient.UserPoolClient?.AccessTokenValidity, 30);

    const signUp = await cognito.send(new SignUpCommand({
      ClientId: clientId!,
      Username: "person@example.com",
      Password: "Valid-password-1!",
    }));
    assert.equal(signUp.UserConfirmed, false);
    assert.match(signUp.UserSub ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(signUp.CodeDeliveryDetails, undefined);

    await cognito.send(new DeleteUserPoolClientCommand({ UserPoolId: poolId, ClientId: clientId }));
    await assert.rejects(
      cognito.send(new DeleteUserPoolCommand({ UserPoolId: poolId })),
      (error: unknown) => error instanceof InvalidParameterException && /deletion protection/i.test(error.message),
    );
    await cognito.send(new UpdateUserPoolCommand({ UserPoolId: poolId, DeletionProtection: "INACTIVE" }));
    await cognito.send(new DeleteUserPoolCommand({ UserPoolId: poolId }));
  } finally {
    cognito.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("raw Cognito protocol returns bounded AWS JSON 1.1 errors and request IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-raw-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  try {
    await simulator.start();
    const url = endpoint(simulator);
    const malformed = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.CreateUserPool",
      },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers.get("content-type") ?? "", /^application\/x-amz-json-1\.1/);
    assert(malformed.headers.get("x-amzn-requestid"));
    assert.deepEqual(await malformed.json(), {
      __type: "SerializationException",
      message: "Could not parse request body into JSON.",
    });

    const wrongContentType = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amz-target": "AWSCognitoIdentityProviderService.CreateUserPool",
      },
      body: JSON.stringify({ PoolName: "wrong-content-type" }),
    });
    assert.equal(wrongContentType.status, 400);
    assert.equal((await wrongContentType.json() as any).__type, "SerializationException");

    const unknown = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-stacksim-service": "cognito-idp",
        "x-amz-target": "AWSCognitoIdentityProviderService.NotARealAction",
      },
      body: "{}",
    });
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), {
      __type: "UnknownOperationException",
      message: "Unknown operation.",
    });
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Cognito target classification requires SigV4 only for IAM-class operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-auth-class-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "validate" });
  let signed = client(simulator);
  let publicClient = new CognitoIdentityProviderClient({ endpoint: endpoint(simulator), region });
  try {
    await simulator.start();
    signed.destroy();
    publicClient.destroy();
    signed = client(simulator);
    publicClient = new CognitoIdentityProviderClient({ endpoint: endpoint(simulator), region });

    const unsignedControl = await fetch(endpoint(simulator), {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.CreateUserPool",
      },
      body: JSON.stringify({ PoolName: "unsigned-control" }),
    });
    assert.equal(unsignedControl.status, 403);
    assert.equal((await unsignedControl.json() as any).__type, "MissingAuthenticationToken");

    const pool = await signed.send(new CreateUserPoolCommand({ PoolName: "signed-control" }));
    const app = await signed.send(new CreateUserPoolClientCommand({
      UserPoolId: pool.UserPool!.Id!,
      ClientName: "public-proof-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }));
    const signUp = await publicClient.send(new SignUpCommand({
      ClientId: app.UserPoolClient!.ClientId!,
      Username: "unsigned@example.com",
      Password: "Valid-password-1!",
      UserAttributes: [{ Name: "email", Value: "unsigned@example.com" }],
    }));
    assert.equal(signUp.UserConfirmed, false);
    assert.match(signUp.UserSub ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(signUp.CodeDeliveryDetails, undefined);
  } finally {
    signed.destroy();
    publicClient.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
