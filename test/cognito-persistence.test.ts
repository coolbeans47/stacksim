import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StackSim } from "../src/server.js";
import { StateStore } from "../src/state.js";

test("schema v52 migrates idempotently to an empty Cognito namespace without changing unrelated state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-migration-"));
  try {
    const initial = new StateStore(root, "111122223333", "eu-west-1").state;
    initial.schemaVersion = 52;
    const region = initial.accounts["111122223333"].regions["eu-west-1"] as any;
    delete region.cognito;
    region.ses.account.sendingEnabled = false;
    region.ses.templates.Existing = {
      name: "Existing",
      arn: "arn:aws:ses:eu-west-1:111122223333:template/Existing",
      subjectPart: "kept",
      tags: {},
      createdAt: 1,
      updatedAt: 1,
    };
    await writeFile(join(root, "state.json"), JSON.stringify(initial));

    const first = new StateStore(root, "111122223333", "eu-west-1");
    await first.load();
    assert.equal(first.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(first.regionState().cognito, {
      revision: 0,
      pools: {},
      poolNameIndex: {},
      issuerTombstones: {},
      deliveryIntents: {},
      admissions: {},
      audit: [],
      domainIndex: {},
    });
    assert.equal(first.regionState().ses.account.sendingEnabled, false);
    assert.equal(first.regionState().ses.templates.Existing.subjectPart, "kept");

    const once = await readFile(join(root, "state.json"), "utf8");
    const second = new StateStore(root, "111122223333", "eu-west-1");
    await second.load();
    assert.equal(await readFile(join(root, "state.json"), "utf8"), once);
    assert.deepEqual(second.regionState().cognito, first.regionState().cognito);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema v53 upgrades existing Cognito pools, clients, and users with inert COG-03 defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-v54-migration-"));
  let simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region: "eu-west-1",
    authMode: "off",
  });
  let client: CognitoIdentityProviderClient | undefined;
  try {
    await simulator.start();
    client = new CognitoIdentityProviderClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region: "eu-west-1",
      credentials: { accessKeyId: "admin", secretAccessKey: "password" },
      maxAttempts: 1,
    });
    const created = await client.send(new CreateUserPoolCommand({
      PoolName: "pre-cog03",
      UsernameAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
    }));
    const poolId = created.UserPool!.Id!;
    await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "legacy-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }));
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: "legacy@example.test",
      TemporaryPassword: "Temporary-password-1!",
      MessageAction: "SUPPRESS",
      UserAttributes: [{ Name: "email", Value: "legacy@example.test" }],
    }));
    client.destroy();
    client = undefined;
    await simulator.stop();

    const path = join(root, "state.json");
    const legacy = JSON.parse(await readFile(path, "utf8"));
    legacy.schemaVersion = 53;
    const region = legacy.accounts["000000000000"].regions["eu-west-1"];
    const pool = region.cognito.pools[poolId];
    delete pool.groups;
    delete pool.challenges;
    delete pool.authEvents;
    delete pool.tags;
    delete pool.configuration.mfaConfiguration;
    delete pool.configuration.enabledMfas;
    delete pool.configuration.lambdaConfig;
    delete pool.configuration.adminCreateUserConfig.inviteMessageTemplate;
    delete pool.configuration.policies.passwordPolicy.passwordHistorySize;
    const app = Object.values(pool.clients)[0] as any;
    delete app.refreshTokenRotation;
    const user = Object.values(pool.usersBySub)[0] as any;
    delete user.passwordHistory;
    delete user.passwordChangedAt;
    delete user.activeAttributeVerificationIntentIds;
    delete user.groupNames;
    delete user.mfa;
    delete user.userMfaSettingList;
    delete user.devices;
    region.ses.account.sendingEnabled = false;
    await writeFile(path, JSON.stringify(legacy));

    const upgraded = new StateStore(root, "000000000000", "eu-west-1");
    await upgraded.load();
    const migrated = upgraded.regionState().cognito.pools[poolId];
    const migratedClient = Object.values(migrated.clients)[0];
    const migratedUser = Object.values(migrated.usersBySub)[0];
    assert.equal(upgraded.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(migrated.groups, {});
    assert.deepEqual(migrated.challenges, {});
    assert.deepEqual(migrated.authEvents, []);
    assert.deepEqual(migrated.tags, {});
    assert.equal(migrated.configuration.policies.passwordPolicy.passwordHistorySize, 0);
    assert.equal(migrated.configuration.mfaConfiguration, "OFF");
    assert.deepEqual(migrated.configuration.enabledMfas, []);
    assert.deepEqual(migrated.configuration.lambdaConfig, {});
    assert.equal(
      migrated.configuration.adminCreateUserConfig.inviteMessageTemplate.emailMessage,
      "Your username is {username} and temporary password is {####}.",
    );
    assert.deepEqual(migratedClient.refreshTokenRotation, {
      feature: "DISABLED",
      retryGracePeriodSeconds: 0,
    });
    assert.deepEqual(migratedClient.supportedIdentityProviders, ["COGNITO"]);
    assert.deepEqual(migratedClient.callbackUrls, []);
    assert.deepEqual(migratedClient.logoutUrls, []);
    assert.deepEqual(migratedClient.allowedOAuthFlows, []);
    assert.deepEqual(migratedClient.allowedOAuthScopes, []);
    assert.equal(migratedClient.allowedOAuthFlowsUserPoolClient, false);
    assert.deepEqual(migrated.resourceServers, {});
    assert.deepEqual(migrated.managedLoginBranding, {});
    assert.deepEqual(migrated.uiCustomizations, {});
    assert.deepEqual(migrated.authorizationCodes, {});
    assert.deepEqual(migrated.browserSessions, {});
    assert.deepEqual(migrated.identityProviders, {});
    assert.deepEqual(migrated.identityProviderIdentifierIndex, {});
    assert.deepEqual(migrated.federatedIdentityIndex, {});
    assert.deepEqual(migrated.federationTransactions, {});
    assert.deepEqual(migrated.federationReplayIds, {});
    assert.deepEqual(upgraded.regionState().cognito.domainIndex, {});
    assert.deepEqual(migratedUser.passwordHistory, []);
    assert.deepEqual(migratedUser.activeAttributeVerificationIntentIds, {});
    assert.deepEqual(migratedUser.groupNames, []);
    assert.deepEqual(migratedUser.mfa, {});
    assert.deepEqual(migratedUser.userMfaSettingList, []);
    assert.deepEqual(migratedUser.devices, {});
    assert.deepEqual(migratedUser.externalIdentities, []);
    assert.equal(migratedUser.status, "FORCE_CHANGE_PASSWORD");
    assert.equal(upgraded.regionState().ses.account.sendingEnabled, false);

    const once = await readFile(path, "utf8");
    const again = new StateStore(root, "000000000000", "eu-west-1");
    await again.load();
    assert.equal(await readFile(path, "utf8"), once);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
