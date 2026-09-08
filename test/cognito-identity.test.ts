import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CreateRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
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
        "access-control-request-headers": "content-type,x-amz-target",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:3000");

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

test("CID-01 public Identity actions ignore caller IAM and unknown Identity targets never enter User Pools", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-identity-iam-"));
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "enforce" });
  const iam = iamClient(simulator);
  try {
    await simulator.start();
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
    const unknown = await identityJson(simulator, "NotAUserPoolsAction", {});
    assert.equal(unknown.payload.__type, "UnknownOperationException");
    const userPoolsTarget = await fetch(endpoint(simulator), {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityService.ListIdentityPools",
      },
      body: JSON.stringify({ MaxResults: 1 }),
    });
    const listed = await userPoolsTarget.json() as { __type?: string; IdentityPools?: unknown[] };
    assert.notEqual(listed.__type, "UnrecognizedClientException");
    assert.ok(listed.IdentityPools || listed.__type === "MissingAuthenticationTokenException" || listed.__type === "AccessDeniedException" || listed.__type === "InvalidClientTokenId");
    adminIdentity.destroy();
  } finally {
    iam.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
