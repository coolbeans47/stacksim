import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function localJson(endpoint: string, path: string): Promise<any> {
  const response = await fetch(`${endpoint}${path}`, { headers: { "x-stacksim-region": region } });
  if (response.status !== 200) assert.fail(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

test("private Cognito console serializers expose opening views without credentials or session material", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-console-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
  });
  let cognito: CognitoIdentityProviderClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    cognito = new CognitoIdentityProviderClient({ endpoint, region, credentials });
    const createdPool = await cognito.send(new CreateUserPoolCommand({
      PoolName: "console-pool",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
    }));
    const poolId = createdPool.UserPool!.Id!;
    const createdClient = await cognito.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "console-client",
      GenerateSecret: true,
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      PreventUserExistenceErrors: "ENABLED",
    }));
    const clientId = createdClient.UserPoolClient!.ClientId!;
    const clientSecret = createdClient.UserPoolClient!.ClientSecret!;
    const password = "ConsolePassword1!";
    const email = "console-user@example.test";
    const secretHash = await import("../src/cognito/client-secret.js").then(module =>
      module.clientSecretHash(Buffer.from(clientSecret, "utf8"), email, clientId));
    const signedUp = await cognito.send(new SignUpCommand({
      ClientId: clientId,
      SecretHash: secretHash,
      Username: email,
      Password: password,
      UserAttributes: [{ Name: "email", Value: email }],
    }));

    const routes = [
      "/_stacksim/api/cognito/user-pools",
      `/_stacksim/api/cognito/user-pools/${encodeURIComponent(poolId)}`,
      `/_stacksim/api/cognito/user-pools/${encodeURIComponent(poolId)}/users`,
      `/_stacksim/api/cognito/user-pools/${encodeURIComponent(poolId)}/users/${encodeURIComponent(signedUp.UserSub!)}`,
      `/_stacksim/api/cognito/user-pools/${encodeURIComponent(poolId)}/app-clients`,
      `/_stacksim/api/cognito/user-pools/${encodeURIComponent(poolId)}/app-clients/${encodeURIComponent(clientId)}`,
    ];
    const views = await Promise.all(routes.map(path => localJson(endpoint, path)));
    const serialized = JSON.stringify(views);
    assert.doesNotMatch(serialized, new RegExp(clientSecret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(serialized, new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(serialized, /"password"|"digest"|"tokenDigest"|"refreshSessions"|"privateKey"|"envelope"|"activeConfirmationIntentId"/);
    assert.equal(views[1].userPool.issuer, `https://cognito-idp.${region}.amazonaws.com/${poolId}`);
    assert.equal(views[1].userPool.inboxPath, "#/ses/inbox?originService=cognito-idp");
    assert.equal(views[3].user.status, "UNCONFIRMED");
    assert.deepEqual(views[3].user.attributes, [{ name: "email", value: email, verified: false }]);
    assert.equal(views[5].appClient.hasSecret, true);
    assert.equal(views[5].appClient.oauthAvailable, false);

    const filteredInbox = await localJson(endpoint, "/_stacksim/api/ses/inbox?originService=cognito-idp");
    assert.equal(filteredInbox.messages.length, 1);
    assert.equal(filteredInbox.messages[0].operation, "SendEmail");
  } finally {
    cognito?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Cognito console mutations require same-origin intent and return redacted app-client results", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-console-mutation-"));
  let simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
  });
  try {
    await simulator.start();
    let endpoint = `http://127.0.0.1:${simulator.port}`;
    const createPoolBody = {
      PoolName: "console-created",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
    };
    const denied = await fetch(`${endpoint}/_stacksim/api/cognito/user-pools`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-stacksim-region": region },
      body: JSON.stringify(createPoolBody),
    });
    assert.equal(denied.status, 403);

    const mutationHeaders = {
      "content-type": "application/json",
      "x-stacksim-region": region,
      "x-stacksim-console-request": "1",
      origin: endpoint,
    };
    const createdPoolResponse = await fetch(`${endpoint}/_stacksim/api/cognito/user-pools`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify(createPoolBody),
    });
    if (createdPoolResponse.status !== 201) {
      assert.fail(`pool mutation: ${createdPoolResponse.status} ${await createdPoolResponse.text()}`);
    }
    const createdPool = await createdPoolResponse.json() as any;
    const poolId = createdPool.userPool.id;
    const customSchemaResponse = await fetch(`${endpoint}/_stacksim/api/cognito/user-pools/${encodeURIComponent(poolId)}/custom-attributes`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        CustomAttributes: [
          {
            Name: "department",
            AttributeDataType: "String",
            Mutable: true,
            StringAttributeConstraints: { MinLength: "2", MaxLength: "20" },
          },
          { Name: "employeeCode", AttributeDataType: "String", Mutable: false },
        ],
      }),
    });
    if (customSchemaResponse.status !== 201) {
      assert.fail(`custom schema mutation: ${customSchemaResponse.status} ${await customSchemaResponse.text()}`);
    }
    const customSchemaPool = await customSchemaResponse.json() as any;
    assert.deepEqual(customSchemaPool.userPool.configuration.attributeSchema.map((attribute: any) => ({
      name: attribute.name,
      mutable: attribute.mutable,
      required: attribute.required,
    })), [
      { name: "email", mutable: true, required: true },
      { name: "custom:department", mutable: true, required: false },
      { name: "custom:employeeCode", mutable: false, required: false },
    ]);

    const duplicateSchemaResponse = await fetch(`${endpoint}/_stacksim/api/cognito/user-pools/${encodeURIComponent(poolId)}/custom-attributes`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        CustomAttributes: [{ Name: "department", AttributeDataType: "String", Mutable: true }],
      }),
    });
    assert.equal(duplicateSchemaResponse.status, 400);

    const reservedSchemaResponse = await fetch(`${endpoint}/_stacksim/api/cognito/user-pools/${encodeURIComponent(poolId)}/custom-attributes`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        CustomAttributes: [{ Name: "phone_number", AttributeDataType: "String", Mutable: true }],
      }),
    });
    assert.equal(reservedSchemaResponse.status, 400);
    const poolAfterDuplicate = await localJson(endpoint, `/_stacksim/api/cognito/user-pools/${encodeURIComponent(poolId)}`);
    assert.equal(poolAfterDuplicate.userPool.configuration.attributeSchema.length, 3);

    const createdUserResponse = await fetch(`${endpoint}/_stacksim/api/cognito/user-pools/${encodeURIComponent(poolId)}/users`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        Username: "attribute-user@example.test",
        UserAttributes: [
          { Name: "email", Value: "attribute-user@example.test" },
          { Name: "email_verified", Value: "true" },
          { Name: "custom:department", Value: "support" },
          { Name: "custom:employeeCode", Value: "E-001" },
        ],
        TemporaryPassword: "AttributePassword1!",
        MessageAction: "SUPPRESS",
      }),
    });
    if (createdUserResponse.status !== 201) {
      assert.fail(`user mutation: ${createdUserResponse.status} ${await createdUserResponse.text()}`);
    }
    const createdUser = await createdUserResponse.json() as any;
    const userSub = createdUser.user.sub;
    assert.equal(
      createdUser.user.attributes.find((attribute: any) => attribute.name === "custom:employeeCode")?.value,
      "E-001",
    );
    const userPath = `${endpoint}/_stacksim/api/cognito/user-pools/${encodeURIComponent(poolId)}/users/${encodeURIComponent(userSub)}`;

    const addAttributeResponse = await fetch(userPath, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({
        action: "attributes",
        attributes: [{ Name: "custom:department", Value: "engineering" }],
      }),
    });
    if (addAttributeResponse.status !== 200) {
      assert.fail(`add attribute mutation: ${addAttributeResponse.status} ${await addAttributeResponse.text()}`);
    }
    const addedUser = await addAttributeResponse.json() as any;
    assert.deepEqual(
      addedUser.user.attributes.find((attribute: any) => attribute.name === "custom:department"),
      { name: "custom:department", value: "engineering", verified: false },
    );

    const immutableAttributeResponse = await fetch(userPath, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({
        action: "attributes",
        attributes: [{ Name: "custom:employeeCode", Value: "A-123" }],
      }),
    });
    assert.equal(immutableAttributeResponse.status, 400);

    const removeAttributeResponse = await fetch(userPath, {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({ action: "delete-attributes", attributeNames: ["custom:department"] }),
    });
    if (removeAttributeResponse.status !== 200) {
      assert.fail(`remove attribute mutation: ${removeAttributeResponse.status} ${await removeAttributeResponse.text()}`);
    }
    const removedUser = await removeAttributeResponse.json() as any;
    assert.equal(removedUser.user.attributes.some((attribute: any) => attribute.name === "custom:department"), false);

    const createdClientResponse = await fetch(`${endpoint}/_stacksim/api/cognito/user-pools/${encodeURIComponent(poolId)}/app-clients`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        ClientName: "browser-client",
        GenerateSecret: true,
        ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      }),
    });
    if (createdClientResponse.status !== 201) {
      assert.fail(`client mutation: ${createdClientResponse.status} ${await createdClientResponse.text()}`);
    }
    const createdClientText = await createdClientResponse.text();
    const createdClient = JSON.parse(createdClientText);
    assert.equal(createdClient.appClient.hasSecret, true);
    assert.doesNotMatch(createdClientText, /ClientSecret|ciphertext|authTag|nonce|envelope/);

    await simulator.stop();
    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      region,
      authMode: "off",
    });
    await simulator.start();
    endpoint = `http://127.0.0.1:${simulator.port}`;
    const restartedPool = await localJson(endpoint, `/_stacksim/api/cognito/user-pools/${encodeURIComponent(poolId)}`);
    assert.deepEqual(
      restartedPool.userPool.configuration.attributeSchema.map((attribute: any) => attribute.name),
      ["email", "custom:department", "custom:employeeCode"],
    );
    const restartedUser = await localJson(endpoint, `/_stacksim/api/cognito/user-pools/${encodeURIComponent(poolId)}/users/${encodeURIComponent(userSub)}`);
    assert.equal(
      restartedUser.user.attributes.find((attribute: any) => attribute.name === "custom:employeeCode")?.value,
      "E-001",
    );
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
