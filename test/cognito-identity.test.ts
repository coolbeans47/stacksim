import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CognitoIdentityClient,
  CreateIdentityPoolCommand,
  DeleteIdentityPoolCommand,
  DescribeIdentityPoolCommand,
  GetCredentialsForIdentityCommand,
  GetIdCommand,
  GetIdentityPoolRolesCommand,
  GetOpenIdTokenCommand,
  ListIdentityPoolsCommand,
  ListTagsForResourceCommand,
  SetIdentityPoolRolesCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateIdentityPoolCommand,
} from "@aws-sdk/client-cognito-identity";
import {
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminDisableUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  CreateGroupCommand,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CreateRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { TestClock } from "../src/core/clock.js";
import { evaluateAuthorization } from "../src/iam/evaluator.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const accountId = "000000000000";
const admin = { accessKeyId: "admin", secretAccessKey: "password" };
const password = "Valid-password-1!";
const targetPrefix = "AWSCognitoIdentityService.";

function endpoint(simulator: StackSim): string {
  return `http://127.0.0.1:${simulator.port}`;
}

function identityClient(simulator: StackSim, credentials = admin): CognitoIdentityClient {
  return new CognitoIdentityClient({ endpoint: endpoint(simulator), region, credentials });
}

function idpClient(simulator: StackSim): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({ endpoint: endpoint(simulator), region, credentials: admin });
}

function iamClient(simulator: StackSim): IAMClient {
  return new IAMClient({ endpoint: endpoint(simulator), region, credentials: admin });
}

function providerName(poolId: string): string {
  return `cognito-idp.${region}.amazonaws.com/${poolId}`;
}

function trustDocument(poolId: string, amr: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Federated: "cognito-identity.amazonaws.com" },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: { "cognito-identity.amazonaws.com:aud": poolId },
        "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": amr },
      },
    }],
  });
}

async function identityJson(
  simulator: StackSim,
  operation: string,
  body: Record<string, unknown>,
  options: {
    credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    path?: string;
    origin?: string;
  } = {},
): Promise<{ status: number; headers: Headers; payload: any }> {
  const path = options.path ?? "/";
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    "x-amz-target": `${targetPrefix}${operation}`,
  };
  if (options.origin) headers.origin = options.origin;
  const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body) };
  const url = `${endpoint(simulator)}${path}`;
  const response = options.credentials
    ? await (await import("./helpers/signed-fetch.js")).signedFetch(url, {
      ...init,
      service: "cognito-identity",
      region,
      credentials: options.credentials,
    })
    : await fetch(url, init);
  return { status: response.status, headers: response.headers, payload: await response.json() };
}

async function userPoolLogin(simulator: StackSim): Promise<{ userPoolId: string; clientId: string; idToken: string; accessToken: string }> {
  const idp = idpClient(simulator);
  try {
    const pool = await idp.send(new CreateUserPoolCommand({
      PoolName: "cid01-users",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    }));
    const userPoolId = pool.UserPool!.Id!;
    const client = await idp.send(new CreateUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientName: "cid01-web",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }));
    const clientId = client.UserPoolClient!.ClientId!;
    const email = "user@example.test";
    await idp.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
    }));
    await idp.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }));
    const auth = await idp.send(new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }));
    assert.ok(auth.AuthenticationResult?.IdToken);
    assert.equal((auth.AuthenticationResult as any).SecretKey, undefined);
    assert.equal((auth.AuthenticationResult as any).AccessKeyId, undefined);
    return {
      userPoolId,
      clientId,
      idToken: auth.AuthenticationResult!.IdToken!,
      accessToken: auth.AuthenticationResult!.AccessToken!,
    };
  } finally {
    idp.destroy();
  }
}

async function attachRoles(simulator: StackSim, poolId: string, options: { guests?: boolean } = {}): Promise<{ authenticated: string; unauthenticated?: string }> {
  const iam = iamClient(simulator);
  try {
    const authenticatedName = `cid-auth-${poolId.replace(/[^a-zA-Z0-9+=,.@_-]/g, "").slice(-20)}`;
    await iam.send(new CreateRoleCommand({
      RoleName: authenticatedName,
      AssumeRolePolicyDocument: trustDocument(poolId, "authenticated"),
    }));
    const authenticated = `arn:aws:iam::${accountId}:role/${authenticatedName}`;
    await iam.send(new PutRolePolicyCommand({
      RoleName: authenticatedName,
      PolicyName: "execute-api",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "execute-api:*", Resource: "*" }],
      }),
    }));
    const identity = identityClient(simulator);
    const roles: { authenticated: string; unauthenticated?: string } = { authenticated };
    if (options.guests) {
      const unauthenticatedName = `cid-guest-${authenticatedName.slice(-12)}`;
      await iam.send(new CreateRoleCommand({
        RoleName: unauthenticatedName,
        AssumeRolePolicyDocument: trustDocument(poolId, "unauthenticated"),
      }));
      roles.unauthenticated = `arn:aws:iam::${accountId}:role/${unauthenticatedName}`;
      await iam.send(new PutRolePolicyCommand({
        RoleName: unauthenticatedName,
        PolicyName: "execute-api",
        PolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Action: "execute-api:*", Resource: "*" }],
        }),
      }));
    }
    try {
      await identity.send(new SetIdentityPoolRolesCommand({ IdentityPoolId: poolId, Roles: roles }));
    } finally {
      identity.destroy();
    }
    return roles;
  } finally {
    iam.destroy();
  }
}

test("CID-01 identity pools implement official-client control, public GetId/GetCredentials, and wire captures", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-identity-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const identity = identityClient(simulator);
    clients.push(identity);
    const login = await userPoolLogin(simulator);

    const created = await identity.send(new CreateIdentityPoolCommand({
      IdentityPoolName: "cid01-pool",
      AllowUnauthenticatedIdentities: true,
      CognitoIdentityProviders: [{
        ProviderName: providerName(login.userPoolId),
        ClientId: login.clientId,
        ServerSideTokenCheck: false,
      }],
      IdentityPoolTags: { env: "local" },
    }));
    const poolId = created.IdentityPoolId!;
    assert.match(poolId, /^eu-west-1:[0-9a-f-]+$/);
    assert.ok(poolId.length <= 55);
    assert.equal(created.AllowClassicFlow, false);
    await attachRoles(simulator, poolId, { guests: true });

    const described = await identity.send(new DescribeIdentityPoolCommand({ IdentityPoolId: poolId }));
    assert.equal(described.IdentityPoolName, "cid01-pool");
    assert.equal(described.AllowUnauthenticatedIdentities, true);

    const listed = await identity.send(new ListIdentityPoolsCommand({ MaxResults: 1 }));
    assert.equal(listed.IdentityPools?.[0]?.IdentityPoolId, poolId);

    await identity.send(new TagResourceCommand({
      ResourceArn: `arn:aws:cognito-identity:${region}:${accountId}:identitypool/${poolId}`,
      Tags: { owner: "stacksim" },
    }));
    const tags = await identity.send(new ListTagsForResourceCommand({
      ResourceArn: `arn:aws:cognito-identity:${region}:${accountId}:identitypool/${poolId}`,
    }));
    assert.equal(tags.Tags?.env, "local");
    assert.equal(tags.Tags?.owner, "stacksim");
    await identity.send(new UntagResourceCommand({
      ResourceArn: `arn:aws:cognito-identity:${region}:${accountId}:identitypool/${poolId}`,
      TagKeys: ["owner"],
    }));

    const guestGetId = await identityJson(simulator, "GetId", { IdentityPoolId: poolId });
    assert.equal(guestGetId.status, 200);
    assert.equal(guestGetId.headers.get("content-type"), "application/x-amz-json-1.1");
    assert.match(guestGetId.payload.IdentityId, /^eu-west-1:[0-9a-f-]+$/);
    assert.equal(Object.keys(guestGetId.payload).join(","), "IdentityId");

    const guestCredentials = await identityJson(simulator, "GetCredentialsForIdentity", {
      IdentityId: guestGetId.payload.IdentityId,
    });
    assert.equal(guestCredentials.status, 200);
    const credentials = guestCredentials.payload.Credentials;
    assert.ok(credentials.AccessKeyId);
    assert.ok(credentials.SecretKey);
    assert.equal(credentials.SecretAccessKey, undefined);
    assert.ok(credentials.SessionToken);
    assert.equal(typeof credentials.Expiration, "number");
    assert.ok(Number.isInteger(credentials.Expiration));

    const guestSession = simulator.store.ensureAccount().iam.sessions[credentials.AccessKeyId];
    assert.equal(guestSession.cognitoIdentity?.authClass, "unauthenticated");
    assert.equal(guestSession.cognitoIdentity?.identityId, guestGetId.payload.IdentityId);
    const guestPrincipal = {
      principalType: "roleSession" as const,
      accessKeyId: credentials.AccessKeyId,
      principalArn: guestSession.principalArn,
      principalId: guestSession.principalId,
      accountId,
      roleArn: guestSession.roleArn,
    };
    const guestExecute = evaluateAuthorization(
      simulator.store.ensureAccount().iam,
      guestPrincipal,
      "execute-api:Invoke",
      `arn:aws:execute-api:${region}:${accountId}:abc/prod/GET/`,
      {},
    );
    assert.equal(guestExecute.decision, "implicitDeny");

    const linked = await identity.send(new GetCredentialsForIdentityCommand({
      IdentityId: guestGetId.payload.IdentityId,
      Logins: { [providerName(login.userPoolId)]: login.idToken },
    }));
    assert.equal(linked.IdentityId, guestGetId.payload.IdentityId);
    const authenticatedGetId = await identity.send(new GetIdCommand({
      IdentityPoolId: poolId,
      AccountId: accountId,
      Logins: { [providerName(login.userPoolId)]: login.idToken },
    }));
    assert.equal(authenticatedGetId.IdentityId, guestGetId.payload.IdentityId);
    const authSession = simulator.store.ensureAccount().iam.sessions[linked.Credentials!.AccessKeyId!];
    assert.equal(authSession.cognitoIdentity?.authClass, "authenticated");
    assert.equal(authSession.cognitoIdentity?.provider, providerName(login.userPoolId));
    const sts = new STSClient({
      endpoint: endpoint(simulator),
      region,
      credentials: {
        accessKeyId: linked.Credentials!.AccessKeyId!,
        secretAccessKey: linked.Credentials!.SecretKey!,
        sessionToken: linked.Credentials!.SessionToken,
      },
    });
    clients.push(sts);
    const caller = await sts.send(new GetCallerIdentityCommand({}));
    assert.match(caller.Arn ?? "", /assumed-role/);
    const authPrincipal = {
      principalType: "roleSession" as const,
      accessKeyId: linked.Credentials!.AccessKeyId!,
      principalArn: authSession.principalArn,
      principalId: authSession.principalId,
      accountId,
      roleArn: authSession.roleArn,
    };
    const authExecute = evaluateAuthorization(
      simulator.store.ensureAccount().iam,
      authPrincipal,
      "execute-api:Invoke",
      `arn:aws:execute-api:${region}:${accountId}:abc/prod/GET/`,
      {},
    );
    assert.equal(authExecute.decision, "allowed");

    const accessToken = await identityJson(simulator, "GetId", {
      IdentityPoolId: poolId,
      Logins: { [providerName(login.userPoolId)]: login.accessToken },
    });
    assert.equal(accessToken.status, 400);
    assert.equal(accessToken.payload.__type, "NotAuthorizedException");

    const wrongAccount = await identityJson(simulator, "GetId", { IdentityPoolId: poolId, AccountId: "111111111111" });
    assert.equal(wrongAccount.status, 400);
    assert.equal(wrongAccount.payload.__type, "NotAuthorizedException");

    await assert.rejects(
      identity.send(new CreateIdentityPoolCommand({
        IdentityPoolName: "social",
        AllowUnauthenticatedIdentities: false,
        SupportedLoginProviders: { "accounts.google.com": "client" },
      } as any)),
      (error: any) => error.name === "InvalidParameterException",
    );
    await assert.rejects(
      identity.send(new GetCredentialsForIdentityCommand({
        IdentityId: guestGetId.payload.IdentityId,
        CustomRoleArn: `arn:aws:iam::${accountId}:role/other`,
      } as any)),
      (error: any) => error.name === "InvalidParameterException",
    );
    const openId = await identityJson(simulator, "GetOpenIdToken", { IdentityId: guestGetId.payload.IdentityId });
    assert.equal(openId.payload.__type, "InvalidParameterException");

    const alias = await identityJson(simulator, "GetId", { IdentityPoolId: poolId }, {
      path: `/_stacksim/cognito-identity/${region}/sdk`,
      origin: "http://127.0.0.1:4173",
    });
    assert.equal(alias.status, 200);
    assert.equal(alias.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");
    const preflight = await fetch(`${endpoint(simulator)}/_stacksim/cognito-identity/${region}/sdk`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
        "access-control-request-headers": "cache-control,content-type,x-amz-target",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.ok(preflight.headers.get("access-control-allow-headers")?.split(/,\s*/).includes("cache-control"));

    await identity.send(new UpdateIdentityPoolCommand({
      IdentityPoolId: poolId,
      IdentityPoolName: "cid01-renamed",
      AllowUnauthenticatedIdentities: true,
      CognitoIdentityProviders: [{
        ProviderName: providerName(login.userPoolId),
        ClientId: login.clientId,
      }],
    }));
    const roles = await identity.send(new GetIdentityPoolRolesCommand({ IdentityPoolId: poolId }));
    assert.ok(roles.Roles?.authenticated);
    await identity.send(new DeleteIdentityPoolCommand({ IdentityPoolId: poolId }));
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("CID-01 identity pools persist across restart and never mint credentials from User Pools", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-identity-persist-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  try {
    await simulator.start();
    const identity = identityClient(simulator);
    const created = await identity.send(new CreateIdentityPoolCommand({
      IdentityPoolName: "persist-pool",
      AllowUnauthenticatedIdentities: false,
    }));
    const poolId = created.IdentityPoolId!;
    identity.destroy();
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
    await simulator.start();
    assert.equal(simulator.store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    const restored = identityClient(simulator);
    const described = await restored.send(new DescribeIdentityPoolCommand({ IdentityPoolId: poolId }));
    assert.equal(described.IdentityPoolName, "persist-pool");
    restored.destroy();
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("AUD-CID-01 failed guest promotion leaves identity, index, session and vault unchanged", async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-identity-atomic-"));
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
  try {
    await simulator.start();
    const login = await userPoolLogin(simulator);
    const logins = { [providerName(login.userPoolId)]: login.idToken };
    const created = await simulator.cognitoIdentity.CreateIdentityPool({
      IdentityPoolName: "atomic-link",
      AllowUnauthenticatedIdentities: true,
      CognitoIdentityProviders: [{ ProviderName: providerName(login.userPoolId), ClientId: login.clientId }],
    });
    const poolId = String(created.IdentityPoolId);
    const roles = await attachRoles(simulator, poolId, { guests: true });
    const guestIds: string[] = [];
    for (const failure of ["missing-role", "denied-trust", "vault-write", "state-save"] as const) {
      await t.test(failure, async () => {
        const pool = simulator.store.regionState(region).cognitoIdentity.pools[poolId];
        const guest = await simulator.cognitoIdentity.GetId({ IdentityPoolId: poolId });
        const guestId = String(guest.IdentityId);
        guestIds.push(guestId);
        const guestCredentials = await simulator.cognitoIdentity.GetCredentialsForIdentity({ IdentityId: guestId });
        const guestAccessKey = (guestCredentials.Credentials as { AccessKeyId: string }).AccessKeyId;
        const identityBefore = structuredClone(pool.identities[guestId]);
        const indexBefore = structuredClone(pool.loginIndex);
        const revisionBefore = simulator.store.regionState(region).cognitoIdentity.revision;
        const sessionsBefore = Object.keys(simulator.store.ensureAccount().iam.sessions).sort();
        const vault = simulator.store.credentialStore!;
        const vaultBefore = vault.ids().sort();
        const filesBefore = (await readdir(vault.recordsDirectory)).sort();
        const role = Object.values(simulator.store.ensureAccount().iam.roles).find(candidate => candidate.arn === roles.authenticated)!;
        const trustBefore = role.assumeRolePolicyDocument;
        const save = simulator.store.save;
        const put = vault.put;
        if (failure === "missing-role") delete pool.roles!.authenticated;
        if (failure === "denied-trust") role.assumeRolePolicyDocument = JSON.parse(trustDocument(poolId, "unauthenticated"));
        if (failure === "vault-write") vault.put = async (binding, secret) => {
          await put.call(vault, binding, secret);
          throw new Error("Injected vault write failure");
        };
        if (failure === "state-save") simulator.store.save = async () => { throw new Error("Injected state save failure"); };
        try {
          await assert.rejects(
            simulator.cognitoIdentity.GetCredentialsForIdentity({ IdentityId: guestId, Logins: logins }),
            (error: any) => failure === "missing-role" || failure === "denied-trust"
              ? error.code === "InvalidIdentityPoolConfigurationException"
              : /^Injected /.test(error.message),
          );
          assert.deepEqual(pool.identities[guestId], identityBefore);
          assert.deepEqual(pool.loginIndex, indexBefore);
          assert.equal(simulator.store.regionState(region).cognitoIdentity.revision, revisionBefore);
          assert.deepEqual(Object.keys(simulator.store.ensureAccount().iam.sessions).sort(), sessionsBefore);
          assert.deepEqual(vault.ids().sort(), vaultBefore);
          assert.deepEqual((await readdir(vault.recordsDirectory)).sort(), filesBefore);
          assert.equal(simulator.store.ensureAccount().iam.sessions[guestAccessKey].cognitoIdentity?.authClass, "unauthenticated");
        } finally {
          simulator.store.save = save;
          vault.put = put;
          pool.roles!.authenticated = roles.authenticated;
          role.assumeRolePolicyDocument = trustBefore;
        }
        // A later successful mutation must not make a rejected transition durable.
        await simulator.cognitoIdentity.TagResource({ ResourceArn: simulator.cognitoIdentity.resourceArn(poolId), Tags: { lastFailure: failure } });
        const persisted = JSON.parse(await readFile(simulator.store.file, "utf8"));
        const storedPool = persisted.accounts[accountId].regions[region].cognitoIdentity.pools[poolId];
        assert.deepEqual(storedPool.identities[guestId], identityBefore);
        assert.deepEqual(storedPool.loginIndex, indexBefore);
        assert.deepEqual(Object.keys(persisted.accounts[accountId].iam.sessions).sort(), sessionsBefore);
        assert.ok(await simulator.cognitoIdentity.GetCredentialsForIdentity({ IdentityId: guestId }));
      });
    }
    const sessionsBeforeRestart = Object.keys(simulator.store.ensureAccount().iam.sessions).sort();
    const vaultBeforeRestart = simulator.store.credentialStore!.ids().sort();
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off" });
    await simulator.start();
    const restored = simulator.store.regionState(region).cognitoIdentity.pools[poolId];
    assert.deepEqual(restored.loginIndex, {});
    for (const guestId of guestIds) {
      assert.equal(restored.identities[guestId].authClass, "unauthenticated");
      assert.deepEqual(restored.identities[guestId].logins, {});
    }
    assert.deepEqual(Object.keys(simulator.store.ensureAccount().iam.sessions).sort(), sessionsBeforeRestart);
    assert.deepEqual(simulator.store.credentialStore!.ids().sort(), vaultBeforeRestart);

    // Retrying a failed link keeps its ID; a later unlinked guest resolves to
    // that canonical authenticated identity without stealing the login.
    const linked = await simulator.cognitoIdentity.GetCredentialsForIdentity({ IdentityId: guestIds[0], Logins: logins });
    assert.equal(linked.IdentityId, guestIds[0]);
    assert.equal((await simulator.cognitoIdentity.GetId({ IdentityPoolId: poolId, Logins: logins })).IdentityId, guestIds[0]);
    const canonicalBefore = structuredClone(restored.identities[guestIds[0]]);
    const merged = await simulator.cognitoIdentity.GetCredentialsForIdentity({ IdentityId: guestIds[1], Logins: logins });
    assert.equal(merged.IdentityId, guestIds[0]);
    assert.equal(restored.identities[guestIds[1]], undefined);
    assert.deepEqual(restored.identities[guestIds[0]], canonicalBefore);
    const persisted = JSON.parse(await readFile(simulator.store.file, "utf8"));
    assert.equal(persisted.accounts[accountId].regions[region].cognitoIdentity.pools[poolId].identities[guestIds[0]].authClass, "authenticated");
    const linkedAccessKey = (linked.Credentials as { AccessKeyId: string }).AccessKeyId;
    assert.equal(persisted.accounts[accountId].iam.sessions[linkedAccessKey].cognitoIdentity.authClass, "authenticated");
  } finally {
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("enhanced repeat login merges only an unlinked guest, atomically, and retains issued guest credentials", async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-identity-merge-"));
  const clock = new TestClock(Date.now());
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", clock });
  try {
    await simulator.start();
    const login = await userPoolLogin(simulator);
    const provider = providerName(login.userPoolId);
    const logins = { [provider]: login.idToken };
    const poolId = String((await simulator.cognitoIdentity.CreateIdentityPool({
      IdentityPoolName: "repeat-login", AllowUnauthenticatedIdentities: true,
      CognitoIdentityProviders: [{ ProviderName: provider, ClientId: login.clientId }],
    })).IdentityPoolId);
    const roles = await attachRoles(simulator, poolId, { guests: true });
    const canonicalId = String((await simulator.cognitoIdentity.GetId({ IdentityPoolId: poolId, Logins: logins })).IdentityId);
    const guestId = String((await simulator.cognitoIdentity.GetId({ IdentityPoolId: poolId })).IdentityId);
    const guestCredential = (await simulator.cognitoIdentity.GetCredentialsForIdentity({ IdentityId: guestId })).Credentials as any;
    for (const failure of ["denied-trust", "vault-write", "state-save"] as const) {
      await t.test(failure, async () => {
        const pool = simulator.store.regionState(region).cognitoIdentity.pools[poolId];
        const before = structuredClone(pool);
        const sessionsBefore = structuredClone(simulator.store.ensureAccount().iam.sessions);
        const vault = simulator.store.credentialStore!;
        const vaultBefore = vault.ids().sort();
        const filesBefore = (await readdir(vault.recordsDirectory)).sort();
        const role = Object.values(simulator.store.ensureAccount().iam.roles).find(item => item.arn === roles.authenticated)!;
        const trust = role.assumeRolePolicyDocument;
        const put = vault.put;
        const save = simulator.store.save;
        if (failure === "denied-trust") role.assumeRolePolicyDocument = JSON.parse(trustDocument(poolId, "unauthenticated"));
        if (failure === "vault-write") vault.put = async (binding, secret) => { await put.call(vault, binding, secret); throw new Error("Injected vault failure"); };
        if (failure === "state-save") simulator.store.save = async () => { throw new Error("Injected save failure"); };
        try {
          await assert.rejects(simulator.cognitoIdentity.GetCredentialsForIdentity({ IdentityId: guestId, Logins: logins }),
            (error: any) => failure === "denied-trust" ? error.code === "InvalidIdentityPoolConfigurationException" : /^Injected /.test(error.message));
          assert.deepEqual(pool, before, "source guest and canonical login remain unchanged");
          assert.deepEqual(simulator.store.ensureAccount().iam.sessions, sessionsBefore);
          assert.deepEqual(vault.ids().sort(), vaultBefore);
          assert.deepEqual((await readdir(vault.recordsDirectory)).sort(), filesBefore);
        } finally { role.assumeRolePolicyDocument = trust; vault.put = put; simulator.store.save = save; }
        await simulator.cognitoIdentity.TagResource({ ResourceArn: simulator.cognitoIdentity.resourceArn(poolId), Tags: { after: failure } });
        await simulator.stop();
        simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", clock });
        await simulator.start();
        const restored = simulator.store.regionState(region).cognitoIdentity.pools[poolId];
        assert.deepEqual(restored.identities, before.identities);
        assert.deepEqual(restored.loginIndex, before.loginIndex);
        assert.deepEqual(simulator.store.ensureAccount().iam.sessions, JSON.parse(JSON.stringify(sessionsBefore)));
        assert.deepEqual(simulator.store.credentialStore!.ids().sort(), vaultBefore);
        clock.advance(1000);
      });
    }
    const canonical = structuredClone(simulator.store.regionState(region).cognitoIdentity.pools[poolId].identities[canonicalId]);
    const merged = await simulator.cognitoIdentity.GetCredentialsForIdentity({ IdentityId: guestId, Logins: logins });
    assert.equal(merged.IdentityId, canonicalId);
    const pool = simulator.store.regionState(region).cognitoIdentity.pools[poolId];
    assert.equal(pool.identities[guestId], undefined);
    assert.deepEqual(pool.identities[canonicalId], canonical);
    const session = simulator.store.ensureAccount().iam.sessions[(merged.Credentials as any).AccessKeyId];
    assert.equal(session.cognitoIdentity?.identityId, canonicalId);
    await assert.rejects(simulator.cognitoIdentity.GetCredentialsForIdentity({ IdentityId: guestId }), (error: any) => error.code === "ResourceNotFoundException");
    const retainedGuest = new STSClient({ endpoint: endpoint(simulator), region, credentials: {
      accessKeyId: guestCredential.AccessKeyId, secretAccessKey: guestCredential.SecretKey, sessionToken: guestCredential.SessionToken,
    } });
    try { assert.ok((await retainedGuest.send(new GetCallerIdentityCommand({}))).Arn); } finally { retainedGuest.destroy(); }
    const idp = idpClient(simulator);
    let otherToken: string;
    try {
      await idp.send(new AdminCreateUserCommand({ UserPoolId: login.userPoolId, Username: "other@example.test", MessageAction: "SUPPRESS", UserAttributes: [{ Name: "email", Value: "other@example.test" }] }));
      await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: login.userPoolId, Username: "other@example.test", Password: password, Permanent: true }));
      otherToken = (await idp.send(new InitiateAuthCommand({ ClientId: login.clientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: "other@example.test", PASSWORD: password } }))).AuthenticationResult!.IdToken!;
    } finally { idp.destroy(); }
    const otherId = String((await simulator.cognitoIdentity.GetId({ IdentityPoolId: poolId, Logins: { [provider]: otherToken } })).IdentityId);
    await assert.rejects(simulator.cognitoIdentity.GetCredentialsForIdentity({ IdentityId: otherId, Logins: logins }), (error: any) => error.code === "ResourceConflictException");
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce", clock });
    await simulator.start();
    const repeatGuest = String((await simulator.cognitoIdentity.GetId({ IdentityPoolId: poolId })).IdentityId);
    assert.equal((await simulator.cognitoIdentity.GetCredentialsForIdentity({ IdentityId: repeatGuest, Logins: logins })).IdentityId, canonicalId);
    assert.equal((await simulator.cognitoIdentity.GetId({ IdentityPoolId: poolId, Logins: logins })).IdentityId, canonicalId);
  } finally { await simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test("AMX-14 generated Token fallback mapping persists and preserves offline ID-token semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-identity-mapping-"));
  const clock = new TestClock(Date.now());
  let simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", clock });
  let identity: CognitoIdentityClient | undefined;
  let idp: CognitoIdentityProviderClient | undefined;
  try {
    await simulator.start();
    const login = await userPoolLogin(simulator);
    identity = identityClient(simulator);
    idp = idpClient(simulator);
    const provider = providerName(login.userPoolId);
    const binding = { ProviderName: provider, ClientId: login.clientId };
    const logins = { [provider]: login.idToken };
    const created = await identity.send(new CreateIdentityPoolCommand({
      IdentityPoolName: "generated-mapping",
      AllowUnauthenticatedIdentities: true,
      CognitoIdentityProviders: [binding],
      SupportedLoginProviders: {},
    }));
    const poolId = created.IdentityPoolId!;
    const roles = await attachRoles(simulator, poolId, { guests: true });
    const mappings = { [`${provider}:${login.clientId}`]: { Type: "Token" as const, AmbiguousRoleResolution: "AuthenticatedRole" as const } };
    await identity.send(new SetIdentityPoolRolesCommand({ IdentityPoolId: poolId, Roles: roles, RoleMappings: mappings }));
    assert.deepEqual((await identity.send(new GetIdentityPoolRolesCommand({ IdentityPoolId: poolId }))).RoleMappings, mappings);

    const guest = await identity.send(new GetIdCommand({ IdentityPoolId: poolId }));
    const linked = await identity.send(new GetCredentialsForIdentityCommand({ IdentityId: guest.IdentityId, Logins: logins }));
    const session = simulator.store.ensureAccount().iam.sessions[linked.Credentials!.AccessKeyId!];
    assert.equal(session.roleArn, roles.authenticated);
    assert.equal(session.cognitoIdentity?.identityId, guest.IdentityId);
    assert.equal(session.cognitoIdentity?.authClass, "authenticated");
    const poolBefore = structuredClone(simulator.store.regionState(region).cognitoIdentity.pools[poolId]);
    for (const invalidMappings of [
      { [`${provider}:wrong-client`]: { Type: "Token", AmbiguousRoleResolution: "AuthenticatedRole" } },
      { [`${provider}:${login.clientId}`]: { Type: "Rules", AmbiguousRoleResolution: "AuthenticatedRole" } },
      { [`${provider}:${login.clientId}`]: { Type: "Token", AmbiguousRoleResolution: "Deny" } },
    ]) {
      await assert.rejects(identity.send(new SetIdentityPoolRolesCommand({ IdentityPoolId: poolId, Roles: roles, RoleMappings: invalidMappings as any })),
        (error: any) => error.name === "InvalidParameterException");
      assert.deepEqual(simulator.store.regionState(region).cognitoIdentity.pools[poolId], poolBefore);
    }
    // A real signed token carrying group role claims must not silently select
    // the fallback role; that selection remains outside this frozen fixture.
    await idp.send(new CreateGroupCommand({ UserPoolId: login.userPoolId, GroupName: "role-selection", RoleArn: roles.authenticated }));
    await idp.send(new AdminAddUserToGroupCommand({ UserPoolId: login.userPoolId, Username: "user@example.test", GroupName: "role-selection" }));
    const groupLogin = await idp.send(new InitiateAuthCommand({ ClientId: login.clientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: "user@example.test", PASSWORD: password } }));
    const sessionsBeforeDeniedToken = Object.keys(simulator.store.ensureAccount().iam.sessions);
    await assert.rejects(identity.send(new GetCredentialsForIdentityCommand({ IdentityId: guest.IdentityId, Logins: { [provider]: groupLogin.AuthenticationResult!.IdToken! } })),
      (error: any) => error.name === "NotAuthorizedException");
    assert.deepEqual(Object.keys(simulator.store.ensureAccount().iam.sessions), sessionsBeforeDeniedToken);

    await idp.send(new AdminDisableUserCommand({ UserPoolId: login.userPoolId, Username: "user@example.test" }));
    // Disabling a user does not revoke an already issued offline JWT.
    assert.ok((await identity.send(new GetCredentialsForIdentityCommand({ IdentityId: guest.IdentityId, Logins: logins }))).Credentials);
    identity.destroy();
    idp.destroy();
    await simulator.stop();
    simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", clock });
    await simulator.start();
    identity = identityClient(simulator);
    assert.deepEqual((await identity.send(new GetIdentityPoolRolesCommand({ IdentityPoolId: poolId }))).RoleMappings, mappings);
    assert.ok((await identity.send(new GetCredentialsForIdentityCommand({ IdentityId: guest.IdentityId, Logins: logins }))).Credentials);
    await identity.send(new UpdateIdentityPoolCommand({
      IdentityPoolId: poolId, IdentityPoolName: "generated-mapping", AllowUnauthenticatedIdentities: true,
      CognitoIdentityProviders: [{ ...binding, ServerSideTokenCheck: true }],
    }));
    await assert.rejects(identity.send(new GetCredentialsForIdentityCommand({ IdentityId: guest.IdentityId, Logins: logins })),
      (error: any) => error.name === "NotAuthorizedException");
    await identity.send(new UpdateIdentityPoolCommand({
      IdentityPoolId: poolId, IdentityPoolName: "generated-mapping", AllowUnauthenticatedIdentities: true,
      CognitoIdentityProviders: [binding],
    }));
    clock.advance(3_600_001);
    await assert.rejects(identity.send(new GetCredentialsForIdentityCommand({ IdentityId: guest.IdentityId, Logins: logins })),
      (error: any) => error.name === "NotAuthorizedException");
  } finally {
    identity?.destroy();
    idp?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("CID-01 public Identity actions ignore caller IAM and unknown Identity targets never enter User Pools", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-identity-iam-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce" });
  let iam: IAMClient | undefined;
  try {
    await simulator.start();
    iam = iamClient(simulator);
    const adminIdentity = identityClient(simulator);
    const pool = await adminIdentity.send(new CreateIdentityPoolCommand({
      IdentityPoolName: "iam-pool",
      AllowUnauthenticatedIdentities: true,
    }));
    await attachRoles(simulator, pool.IdentityPoolId!, { guests: true });
    await iam.send(new CreateRoleCommand({
      RoleName: "identity-reader",
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sts:AssumeRole" }],
      }),
    }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: "identity-reader",
      PolicyName: "deny-create",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: "cognito-identity:ListIdentityPools", Resource: "*" },
          { Effect: "Deny", Action: "cognito-identity:CreateIdentityPool", Resource: "*" },
        ],
      }),
    }));
    const sts = new STSClient({ endpoint: endpoint(simulator), region, credentials: admin });
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${accountId}:role/identity-reader`,
      RoleSessionName: "identity-reader",
    }));
    sts.destroy();
    const restricted = {
      accessKeyId: assumed.Credentials!.AccessKeyId!,
      secretAccessKey: assumed.Credentials!.SecretAccessKey!,
      sessionToken: assumed.Credentials!.SessionToken!,
    };
    const denied = await identityJson(simulator, "CreateIdentityPool", {
      IdentityPoolName: "blocked",
      AllowUnauthenticatedIdentities: false,
    }, { credentials: restricted });
    assert.equal(denied.status, 403);
    assert.equal(denied.payload.__type, "AccessDeniedException");
    const allowed = await identityJson(simulator, "ListIdentityPools", { MaxResults: 1 }, { credentials: restricted });
    assert.equal(allowed.status, 200);
    const unsigned = await identityJson(simulator, "GetId", { IdentityPoolId: pool.IdentityPoolId });
    assert.equal(unsigned.status, 200);
    const unsignedControl = await identityJson(simulator, "ListIdentityPools", { MaxResults: 1 });
    assert.equal(unsignedControl.status, 403);
    assert.equal(unsignedControl.payload.__type, "MissingAuthenticationToken");
    const unknown = await identityJson(simulator, "NotAUserPoolsAction", {}, { credentials: admin });
    assert.equal(unknown.payload.__type, "UnknownOperationException");
    adminIdentity.destroy();
  } finally {
    iam?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
