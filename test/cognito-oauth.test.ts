import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APIGatewayClient,
  CreateAuthorizerCommand,
  CreateDeploymentCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  GetResourcesCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
} from "@aws-sdk/client-api-gateway";
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  CreateManagedLoginBrandingCommand,
  CreateResourceServerCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  CreateUserPoolDomainCommand,
  DescribeManagedLoginBrandingByClientCommand,
  DescribeResourceServerCommand,
  DescribeUserPoolDomainCommand,
  GetUICustomizationCommand,
  InitiateAuthCommand,
  ListResourceServersCommand,
  SetUserMFAPreferenceCommand,
  SetUserPoolMfaConfigCommand,
  SetUICustomizationCommand,
  UpdateManagedLoginBrandingCommand,
  UpdateResourceServerCommand,
  UpdateUserPoolCommand,
  UpdateUserPoolDomainCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CreateEmailIdentityCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function parseJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

function csrf(html: string): string {
  const result = html.match(/name="csrf" value="([^"]+)"/);
  assert(result, "managed-login page must contain a CSRF value");
  return result[1];
}

function localFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(5_000) });
}

async function latestCognitoEmailCode(origin: string, recipient: string): Promise<string> {
  const listing = await localFetch(`${origin}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(recipient)}&status=all&pageSize=100`);
  const messages = (await listing.json() as { messages: Array<{ messageId: string }> }).messages;
  const detail = await localFetch(`${origin}/_stacksim/api/ses/inbox/${encodeURIComponent(messages[0].messageId)}`);
  const text = (await detail.json() as { message: { textBody: string } }).message.textBody;
  const match = /\b(\d{6})\b/.exec(text);
  assert(match, "Cognito email must contain a six-digit code");
  return match[1];
}

async function verifySesIdentity(
  origin: string,
  identity: string,
): Promise<void> {
  const ses = new SESv2Client({ endpoint: origin, region: "eu-west-1", credentials });
  try {
    await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: identity }));
    const listing = await localFetch(`${origin}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(identity)}&status=all&pageSize=100`);
    const message = (await listing.json() as { messages: Array<{ messageId: string }> }).messages[0];
    const detail = await localFetch(`${origin}/_stacksim/api/ses/inbox/${encodeURIComponent(message.messageId)}`);
    const text = (await detail.json() as { message: { textBody: string } }).message.textBody;
    const link = text.match(/https?:\/\/[^\s<]+/)?.[0];
    assert(link);
    const callback = await localFetch(link, { redirect: "manual" });
    assert.equal(callback.status, 303);
    await localFetch(new URL(callback.headers.get("location")!, origin));
  } finally {
    ses.destroy();
  }
}

test("COG-04 resource servers, managed login, OAuth grants, OIDC tooling, SSO, and logout", async t => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-oauth-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region: "eu-west-1",
    authMode: "off",
    cloudFormationCustomResourceCallbackPort: 0,
  });
  let client: CognitoIdentityProviderClient | undefined;
  try {
    await simulator.start();
    const origin = `http://127.0.0.1:${simulator.port}`;
    const publicOrigin = `http://localhost:${simulator.port}`;
    client = new CognitoIdentityProviderClient({
      endpoint: origin,
      region: "eu-west-1",
      credentials,
    });
    const pool = await client.send(new CreateUserPoolCommand({
      PoolName: "oauth-users",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", AttributeDataType: "String", Required: true, Mutable: true }],
    }));
    const poolId = pool.UserPool!.Id!;
    const poolArn = pool.UserPool!.Arn!;

    const resource = await client.send(new CreateResourceServerCommand({
      UserPoolId: poolId,
      Identifier: "https://orders.example.test",
      Name: "Orders API",
      Scopes: [
        { ScopeName: "read", ScopeDescription: "Read orders" },
        { ScopeName: "write", ScopeDescription: "Write orders" },
      ],
    }));
    assert.equal(resource.ResourceServer?.Scopes?.[0].ScopeName, "read");
    assert.equal((await client.send(new DescribeResourceServerCommand({
      UserPoolId: poolId,
      Identifier: "https://orders.example.test",
    }))).ResourceServer?.Name, "Orders API");
    assert.equal((await client.send(new ListResourceServersCommand({
      UserPoolId: poolId,
      MaxResults: 1,
    }))).ResourceServers?.length, 1);
    assert.equal((await client.send(new UpdateResourceServerCommand({
      UserPoolId: poolId,
      Identifier: "https://orders.example.test",
      Name: "Orders",
      Scopes: [
        { ScopeName: "read", ScopeDescription: "Read orders safely" },
        { ScopeName: "write", ScopeDescription: "Write orders" },
      ],
    }))).ResourceServer?.Name, "Orders");

    const callback = "http://127.0.0.1:39123/callback";
    const logout = "http://127.0.0.1:39123/signed-out";
    const mobileCallback = "stacksim-demo://oauth/callback";
    const mobileLogout = "stacksim-demo://oauth/signed-out";
    const browserClient = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "browser",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      CallbackURLs: [callback, mobileCallback],
      LogoutURLs: [logout, mobileLogout],
      DefaultRedirectURI: callback,
      SupportedIdentityProviders: ["COGNITO"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ["code", "implicit"],
      AllowedOAuthScopes: ["openid", "email", "profile", "https://orders.example.test/read"],
      ReadAttributes: ["email"],
      WriteAttributes: ["email"],
    }));
    const browserClientId = browserClient.UserPoolClient!.ClientId!;
    const machineClient = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "machine",
      GenerateSecret: true,
      ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ["client_credentials"],
      AllowedOAuthScopes: ["https://orders.example.test/read"],
    }));
    const machineClientId = machineClient.UserPoolClient!.ClientId!;
    const machineSecret = machineClient.UserPoolClient!.ClientSecret!;

    await client.send(new CreateUserPoolDomainCommand({
      UserPoolId: poolId,
      Domain: "oauth-users-local",
      ManagedLoginVersion: 2,
    }));
    assert.equal((await client.send(new DescribeUserPoolDomainCommand({
      Domain: "oauth-users-local",
    }))).DomainDescription?.UserPoolId, poolId);
    assert.equal((await client.send(new UpdateUserPoolDomainCommand({
      UserPoolId: poolId,
      Domain: "oauth-users-local",
      ManagedLoginVersion: 2,
    }))).ManagedLoginVersion, 2);

    const branding = await client.send(new CreateManagedLoginBrandingCommand({
      UserPoolId: poolId,
      ClientId: browserClientId,
      Settings: { pageTitle: "Orders sign in", primaryColor: "#123456" },
    }));
    const brandingId = branding.ManagedLoginBranding?.ManagedLoginBrandingId!;
    assert.equal(((await client.send(new DescribeManagedLoginBrandingByClientCommand({
      UserPoolId: poolId,
      ClientId: browserClientId,
    }))).ManagedLoginBranding?.Settings as any).pageTitle, "Orders sign in");
    assert.equal(((await client.send(new UpdateManagedLoginBrandingCommand({
      UserPoolId: poolId,
      ManagedLoginBrandingId: brandingId,
      Settings: { pageTitle: "Orders account", primaryColor: "#234567" },
    }))).ManagedLoginBranding?.Settings as any).pageTitle, "Orders account");
    await client.send(new SetUICustomizationCommand({
      UserPoolId: poolId,
      ClientId: browserClientId,
      CSS: "main{max-width:30rem}",
    }));
    assert.equal((await client.send(new GetUICustomizationCommand({
      UserPoolId: poolId,
      ClientId: browserClientId,
    }))).UICustomization?.CSS, "main{max-width:30rem}");

    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: "learner@example.test",
      UserAttributes: [
        { Name: "email", Value: "learner@example.test" },
        { Name: "email_verified", Value: "true" },
      ],
      MessageAction: "SUPPRESS",
    }));
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: "learner@example.test",
      Password: "Correct-Horse-7!",
      Permanent: true,
    }));

    const discoveryUrl = `${origin}/_stacksim/cognito-idp/eu-west-1/${poolId}/.well-known/openid-configuration`;
    const discoveryResponse = await localFetch(discoveryUrl);
    assert.equal(discoveryResponse.status, 200);
    const discovery = await discoveryResponse.json() as Record<string, any>;
    assert.equal(discovery.issuer, `https://cognito-idp.eu-west-1.amazonaws.com/${poolId}`);
    assert.equal(discovery.authorization_endpoint, `${publicOrigin}/_stacksim/cognito-domain/oauth-users-local/oauth2/authorize`);
    assert.match(discovery.jwks_uri, /\/\.well-known\/jwks\.json$/);

    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const authorize = new URL(discovery.authorization_endpoint);
    authorize.searchParams.set("client_id", browserClientId);
    authorize.searchParams.set("redirect_uri", callback);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "openid email https://orders.example.test/read https://orders.example.test/write");
    authorize.searchParams.set("state", "exact-state");
    authorize.searchParams.set("nonce", "exact-nonce");
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");

    const wrongRedirect = new URL(authorize);
    wrongRedirect.searchParams.set("redirect_uri", "http://127.0.0.1:39123/not-configured");
    const wrongRedirectResponse = await localFetch(wrongRedirect, { redirect: "manual" });
    assert.equal(wrongRedirectResponse.status, 400);
    assert.equal((await wrongRedirectResponse.json() as any).error, "invalid_request");
    const missingPkce = new URL(authorize);
    missingPkce.searchParams.delete("code_challenge");
    missingPkce.searchParams.delete("code_challenge_method");
    const assertTrustedAuthorizeError = async (request: URL, expectedError: string, expectedState: string) => {
      const response = await localFetch(request, { redirect: "manual" });
      assert.equal(response.status, 302);
      const location = new URL(response.headers.get("location")!);
      assert.equal(`${location.origin}${location.pathname}`, callback);
      assert.equal(location.searchParams.get("error"), expectedError);
      assert.equal(location.searchParams.get("state"), expectedState);
      assert(location.searchParams.get("error_description"));
    };
    await assertTrustedAuthorizeError(missingPkce, "invalid_request", "exact-state");
    const unknownScope = new URL(authorize);
    unknownScope.searchParams.set("scope", "openid https://orders.example.test/unknown");
    await assertTrustedAuthorizeError(unknownScope, "invalid_scope", "exact-state");
    const invalidPrompt = new URL(authorize);
    invalidPrompt.searchParams.set("prompt", "none");
    await assertTrustedAuthorizeError(invalidPrompt, "invalid_request", "exact-state");
    const invalidState = new URL(authorize);
    invalidState.searchParams.set("state", "");
    await assertTrustedAuthorizeError(invalidState, "invalid_request", "");

    const login = await localFetch(authorize, { redirect: "manual" });
    t.diagnostic("authorization page loaded");
    assert.equal(login.status, 200);
    assert.match(login.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const anonymousCookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const loginHtml = await login.text();
    assert.match(loginHtml, /Orders account/);
    assert.match(loginHtml, /Create account/);
    const selfServiceEmail = "selfservice@example.test";
    const accountForm = (operation: string) => {
      const values = new URLSearchParams(authorize.searchParams);
      values.set("csrf", csrf(loginHtml));
      values.set("account_operation", operation);
      values.set("account_username", selfServiceEmail);
      return values;
    };
    const signUpForm = accountForm("signup");
    signUpForm.set("account_password", "Self-Service-Password-7!");
    const signedUp = await localFetch(authorize.origin + authorize.pathname, {
      method: "POST",
      body: signUpForm,
      headers: { cookie: anonymousCookie, "content-type": "application/x-www-form-urlencoded" },
    });
    assert.match(await signedUp.text(), /Account created/);
    const confirmationForm = accountForm("confirm");
    confirmationForm.set("account_code", await latestCognitoEmailCode(origin, selfServiceEmail));
    const confirmed = await localFetch(authorize.origin + authorize.pathname, {
      method: "POST",
      body: confirmationForm,
      headers: { cookie: anonymousCookie, "content-type": "application/x-www-form-urlencoded" },
    });
    assert.match(await confirmed.text(), /Account confirmed/);
    const forgot = await localFetch(authorize.origin + authorize.pathname, {
      method: "POST",
      body: accountForm("forgot"),
      headers: { cookie: anonymousCookie, "content-type": "application/x-www-form-urlencoded" },
    });
    assert.match(await forgot.text(), /recovery code/);
    const recoveryForm = accountForm("confirm_forgot");
    recoveryForm.set("account_code", await latestCognitoEmailCode(origin, selfServiceEmail));
    recoveryForm.set("account_password", "Recovered-Password-8!");
    const recovered = await localFetch(authorize.origin + authorize.pathname, {
      method: "POST",
      body: recoveryForm,
      headers: { cookie: anonymousCookie, "content-type": "application/x-www-form-urlencoded" },
    });
    assert.match(await recovered.text(), /Password changed/);
    const selfServiceAuth = await client.send(new InitiateAuthCommand({
      ClientId: browserClientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: {
        USERNAME: selfServiceEmail,
        PASSWORD: "Recovered-Password-8!",
      },
    }));
    const mfaSender = "managed-login-mfa@example.test";
    await verifySesIdentity(origin, mfaSender);
    await client.send(new UpdateUserPoolCommand({
      UserPoolId: poolId,
      EmailConfiguration: {
        EmailSendingAccount: "DEVELOPER",
        SourceArn: `arn:aws:ses:eu-west-1:000000000000:identity/${mfaSender}`,
      },
    }));
    await client.send(new SetUserPoolMfaConfigCommand({
      UserPoolId: poolId,
      MfaConfiguration: "OPTIONAL",
      EmailMfaConfiguration: {
        Subject: "Managed-login code",
        Message: "Your managed-login code is {####}.",
      },
    }));
    await client.send(new SetUserMFAPreferenceCommand({
      AccessToken: selfServiceAuth.AuthenticationResult!.AccessToken!,
      EmailMfaSettings: { Enabled: true, PreferredMfa: true },
    }));
    const form = new URLSearchParams(authorize.searchParams);
    form.set("csrf", csrf(loginHtml));
    form.set("username", "learner@example.test");
    form.set("password", "Correct-Horse-7!");
    const signedIn = await localFetch(authorize.origin + authorize.pathname, {
      method: "POST",
      body: form,
      redirect: "manual",
      headers: { cookie: anonymousCookie, "content-type": "application/x-www-form-urlencoded" },
    });
    t.diagnostic("managed-login credentials submitted");
    assert.equal(signedIn.status, 302);
    const authenticatedCookie = signedIn.headers.get("set-cookie")!.split(";", 1)[0];
    assert.notEqual(authenticatedCookie, anonymousCookie);
    const callbackResult = new URL(signedIn.headers.get("location")!);
    assert.equal(callbackResult.searchParams.get("state"), "exact-state");
    const code = callbackResult.searchParams.get("code")!;

    const tokenResponse = await localFetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: browserClientId,
        redirect_uri: callback,
        code,
        code_verifier: verifier,
      }),
    });
    t.diagnostic("authorization code exchanged");
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json() as Record<string, any>;
    assert(tokens.access_token && tokens.id_token && tokens.refresh_token);
    assert.equal(parseJwt(tokens.id_token).nonce, "exact-nonce");
    assert.equal(parseJwt(tokens.access_token).scope, "openid email https://orders.example.test/read");

    const replay = await localFetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: browserClientId,
        redirect_uri: callback,
        code,
        code_verifier: verifier,
      }),
    });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json() as any).error, "invalid_grant");
    const duplicateForm = await localFetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&client_id=${browserClientId}&client_id=${browserClientId}&refresh_token=x`,
    });
    assert.equal(duplicateForm.status, 400);
    assert.equal((await duplicateForm.json() as any).error, "invalid_request");

    const userInfo = await localFetch(discovery.userinfo_endpoint, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    t.diagnostic("userInfo called");
    assert.deepEqual(await userInfo.json(), {
      sub: parseJwt(tokens.access_token).sub,
      username: parseJwt(tokens.access_token).username,
      email: "learner@example.test",
      email_verified: true,
    });

    const gateway = new APIGatewayClient({
      endpoint: origin,
      region: "eu-west-1",
      credentials,
    });
    try {
      const api = await gateway.send(new CreateRestApiCommand({ name: "oauth-scopes" }));
      const rootResource = (await gateway.send(new GetResourcesCommand({ restApiId: api.id! })))
        .items!.find(value => value.path === "/")!;
      const orders = await gateway.send(new CreateResourceCommand({
        restApiId: api.id!,
        parentId: rootResource.id!,
        pathPart: "orders",
      }));
      const authorizer = await gateway.send(new CreateAuthorizerCommand({
        restApiId: api.id!,
        name: "oauth-pool",
        type: "COGNITO_USER_POOLS",
        providerARNs: [poolArn],
        identitySource: "method.request.header.Authorization",
      }));
      await gateway.send(new PutMethodCommand({
        restApiId: api.id!,
        resourceId: orders.id!,
        httpMethod: "GET",
        authorizationType: "COGNITO_USER_POOLS",
        authorizerId: authorizer.id!,
        authorizationScopes: ["https://orders.example.test/read"],
      }));
      await gateway.send(new PutMethodResponseCommand({
        restApiId: api.id!,
        resourceId: orders.id!,
        httpMethod: "GET",
        statusCode: "200",
      }));
      await gateway.send(new PutIntegrationCommand({
        restApiId: api.id!,
        resourceId: orders.id!,
        httpMethod: "GET",
        type: "MOCK",
        requestTemplates: { "application/json": "{\"statusCode\":200}" },
      }));
      await gateway.send(new PutIntegrationResponseCommand({
        restApiId: api.id!,
        resourceId: orders.id!,
        httpMethod: "GET",
        statusCode: "200",
        responseTemplates: { "application/json": "{\"authorized\":true}" },
      }));
      await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
      const invocation = `http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/orders`;
      assert.equal((await localFetch(invocation, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })).status, 200);
      const direct = await client.send(new InitiateAuthCommand({
        ClientId: browserClientId,
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: {
          USERNAME: "learner@example.test",
          PASSWORD: "Correct-Horse-7!",
        },
      }));
      assert.equal(parseJwt(direct.AuthenticationResult!.AccessToken!).scope, "aws.cognito.signin.user.admin");
      assert.equal((await localFetch(invocation, {
        headers: { authorization: `Bearer ${direct.AuthenticationResult!.AccessToken!}` },
      })).status, 401);
    } finally {
      gateway.destroy();
    }
    const refreshed = await localFetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: browserClientId,
        refresh_token: tokens.refresh_token,
      }),
    });
    t.diagnostic("refresh grant called");
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json() as any).scope, "openid email https://orders.example.test/read");

    const narrowed = await localFetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: browserClientId,
        refresh_token: tokens.refresh_token,
        scope: "openid",
      }),
    });
    assert.equal(narrowed.status, 200);
    const narrowedTokens = await narrowed.json() as Record<string, any>;
    assert.equal(narrowedTokens.scope, "openid");
    const openidOnlyUserInfo = await localFetch(discovery.userinfo_endpoint, {
      headers: { authorization: `Bearer ${narrowedTokens.access_token}` },
    });
    assert.deepEqual(await openidOnlyUserInfo.json(), {
      sub: parseJwt(narrowedTokens.access_token).sub,
      username: parseJwt(narrowedTokens.access_token).username,
      email: "learner@example.test",
      email_verified: true,
    });
    const widened = await localFetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: browserClientId,
        refresh_token: tokens.refresh_token,
        scope: "openid profile",
      }),
    });
    assert.equal(widened.status, 400);
    assert.equal((await widened.json() as any).error, "invalid_scope");

    const sso = await localFetch(authorize, {
      redirect: "manual",
      headers: { cookie: authenticatedCookie },
    });
    assert.equal(sso.status, 302);
    assert.equal(new URL(sso.headers.get("location")!).searchParams.get("state"), "exact-state");

    const mobileAuthorize = new URL(authorize);
    mobileAuthorize.searchParams.set("redirect_uri", mobileCallback);
    mobileAuthorize.searchParams.set("state", "mobile-state");
    const mobileAuthorization = await localFetch(mobileAuthorize, {
      redirect: "manual",
      headers: { cookie: authenticatedCookie },
    });
    assert.equal(mobileAuthorization.status, 302);
    const mobileResult = new URL(mobileAuthorization.headers.get("location")!);
    assert.equal(`${mobileResult.protocol}//${mobileResult.host}${mobileResult.pathname}`, mobileCallback);
    assert.equal(mobileResult.searchParams.get("state"), "mobile-state");
    const mobileExchange = await localFetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: browserClientId,
        redirect_uri: mobileCallback,
        code: mobileResult.searchParams.get("code")!,
        code_verifier: verifier,
      }),
    });
    assert.equal(mobileExchange.status, 200);

    const machine = await localFetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${machineClientId}:${machineSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "https://orders.example.test/read",
      }),
    });
    assert.equal(machine.status, 200);
    const machineToken = await machine.json() as Record<string, any>;
    assert(machineToken.access_token);
    assert.equal(machineToken.id_token, undefined);
    assert.equal(machineToken.refresh_token, undefined);
    const badBasic = await localFetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        authorization: "Basic not-base64!",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    assert.equal(badBasic.status, 401);
    assert.equal((await badBasic.json() as any).error, "invalid_client");

    const loggedOut = await localFetch(`${discovery.end_session_endpoint}?client_id=${encodeURIComponent(browserClientId)}&logout_uri=${encodeURIComponent(mobileLogout)}`, {
      redirect: "manual",
      headers: { cookie: authenticatedCookie },
    });
    assert.equal(loggedOut.status, 302);
    assert.equal(loggedOut.headers.get("location"), mobileLogout);
    assert.match(loggedOut.headers.get("set-cookie") ?? "", /Max-Age=0/);
    const afterLogout = await localFetch(authorize, {
      redirect: "manual",
      headers: { cookie: authenticatedCookie },
    });
    assert.equal(afterLogout.status, 200);
    const mfaAnonymousCookie = afterLogout.headers.get("set-cookie")!.split(";", 1)[0];
    const mfaLoginForm = new URLSearchParams(authorize.searchParams);
    mfaLoginForm.set("csrf", csrf(await afterLogout.text()));
    mfaLoginForm.set("username", selfServiceEmail);
    mfaLoginForm.set("password", "Recovered-Password-8!");
    const challenged = await localFetch(authorize.origin + authorize.pathname, {
      method: "POST",
      body: mfaLoginForm,
      headers: { cookie: mfaAnonymousCookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    assert.equal(challenged.status, 200);
    const mfaHtml = await challenged.text();
    assert.match(mfaHtml, /Verify your sign-in/);
    const hidden = (name: string): string => {
      const match = mfaHtml.match(new RegExp(`name="${name}" value="([^"]+)"`));
      assert(match, `MFA page must contain ${name}`);
      return match[1];
    };
    const mfaResponse = new URLSearchParams(authorize.searchParams);
    mfaResponse.set("csrf", hidden("csrf"));
    mfaResponse.set("challenge_name", hidden("challenge_name"));
    mfaResponse.set("challenge_session", hidden("challenge_session"));
    mfaResponse.set("mfa_code", await latestCognitoEmailCode(origin, selfServiceEmail));
    const mfaCompleted = await localFetch(authorize.origin + authorize.pathname, {
      method: "POST",
      body: mfaResponse,
      headers: { cookie: mfaAnonymousCookie, "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    assert.equal(mfaCompleted.status, 302);
    assert.equal(new URL(mfaCompleted.headers.get("location")!).searchParams.get("state"), "exact-state");
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COG-04 authorization codes survive restart, work at 299 seconds, expire at 300, and persist only digests", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cognito-code-expiry-"));
  const clock = new TestClock(Date.parse("2026-07-26T12:00:00Z"));
  let simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region: "eu-west-1",
    authMode: "off",
    clock,
    cloudFormationCustomResourceCallbackPort: 0,
  });
  let client: CognitoIdentityProviderClient | undefined;
  try {
    await simulator.start();
    let origin = `http://127.0.0.1:${simulator.port}`;
    client = new CognitoIdentityProviderClient({ endpoint: origin, region: "eu-west-1", credentials });
    const poolId = (await client.send(new CreateUserPoolCommand({
      PoolName: "code-expiry",
      UsernameAttributes: ["email"],
      Schema: [{ Name: "email", AttributeDataType: "String", Required: true, Mutable: true }],
    }))).UserPool!.Id!;
    const callback = "http://127.0.0.1:39124/callback";
    const app = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: "pkce-client",
      ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      CallbackURLs: [callback],
      SupportedIdentityProviders: ["COGNITO"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid"],
    }));
    const clientId = app.UserPoolClient!.ClientId!;
    await client.send(new CreateUserPoolDomainCommand({
      UserPoolId: poolId,
      Domain: "code-expiry-local",
    }));
    await client.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: "expiry@example.test",
      UserAttributes: [
        { Name: "email", Value: "expiry@example.test" },
        { Name: "email_verified", Value: "true" },
      ],
      MessageAction: "SUPPRESS",
    }));
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: "expiry@example.test",
      Password: "Expiry-Password-7!",
      Permanent: true,
    }));
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const authorize = new URL(`http://localhost:${simulator.port}/_stacksim/cognito-domain/code-expiry-local/oauth2/authorize`);
    authorize.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callback,
      response_type: "code",
      scope: "openid",
      state: "restart-state",
      nonce: "restart-nonce",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const login = await localFetch(authorize, { redirect: "manual" });
    const anonymousCookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const form = new URLSearchParams(authorize.searchParams);
    form.set("csrf", csrf(await login.text()));
    form.set("username", "expiry@example.test");
    form.set("password", "Expiry-Password-7!");
    const signedIn = await localFetch(authorize.origin + authorize.pathname, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: anonymousCookie, "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const authenticatedCookie = signedIn.headers.get("set-cookie")!.split(";", 1)[0];
    const code = new URL(signedIn.headers.get("location")!).searchParams.get("code")!;
    const serialized = JSON.stringify(simulator.store.regionState("eu-west-1").cognito);
    assert(!serialized.includes(code));
    assert(!serialized.includes(anonymousCookie.split("=")[1]));
    assert(!serialized.includes(authenticatedCookie.split("=")[1]));

    const fixedPort = simulator.port;
    client.destroy();
    client = undefined;
    await simulator.stop();
    simulator = new StackSim({
      port: fixedPort,
      invokePort: 0,
      dataDir: root,
      region: "eu-west-1",
      authMode: "off",
      clock,
      cognitoPublicUrl: `http://localhost:${fixedPort}`,
      cloudFormationCustomResourceCallbackPort: 0,
    });
    await simulator.start();
    origin = `http://127.0.0.1:${simulator.port}`;
    clock.advance(299_000);
    const tokenEndpoint = `${origin}/_stacksim/cognito-domain/code-expiry-local/oauth2/token`;
    const at299 = await localFetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: callback,
        code,
        code_verifier: verifier,
      }),
    });
    assert.equal(at299.status, 200);

    const second = await localFetch(authorize, {
      redirect: "manual",
      headers: { cookie: authenticatedCookie },
    });
    assert.equal(second.status, 302);
    const expiringCode = new URL(second.headers.get("location")!).searchParams.get("code")!;
    clock.advance(300_000);
    const at300 = await localFetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: callback,
        code: expiringCode,
        code_verifier: verifier,
      }),
    });
    assert.equal(at300.status, 400);
    assert.equal((await at300.json() as any).error, "invalid_grant");
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("COG-04 rejects non-loopback or non-origin public URLs at construction", () => {
  for (const value of [
    "https://example.com",
    "http://localhost:4566/path",
    "http://user:password@localhost:4566",
    "http://localhost:4566?query=1",
  ]) {
    assert.throws(
      () => new StackSim({ cognitoPublicUrl: value }),
      /Cognito public URL/,
    );
  }
});
