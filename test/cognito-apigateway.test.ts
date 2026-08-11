import assert from "node:assert/strict";
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
  DeleteAuthorizerCommand,
  FlushStageAuthorizersCacheCommand,
  GetAuthorizerCommand,
  GetAuthorizersCommand,
  GetExportCommand,
  GetMethodCommand,
  GetResourcesCommand,
  ImportRestApiCommand,
  PutGatewayResponseCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
  PutRestApiCommand,
  TestInvokeAuthorizerCommand,
  UpdateAccountCommand,
  UpdateAuthorizerCommand,
  UpdateMethodCommand,
  UpdateStageCommand,
} from "@aws-sdk/client-api-gateway";
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateAuthorizerCommand as CreateHttpAuthorizerCommand,
  CreateDeploymentCommand as CreateHttpDeploymentCommand,
  CreateIntegrationCommand as CreateHttpIntegrationCommand,
  CreateRouteCommand as CreateHttpRouteCommand,
  CreateStageCommand as CreateHttpStageCommand,
  UpdateAuthorizerCommand as UpdateHttpAuthorizerCommand,
  UpdateStageCommand as UpdateHttpStageCommand,
} from "@aws-sdk/client-apigatewayv2";
import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DeleteUserPoolCommand,
  InitiateAuthCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  CreateRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  AddPermissionCommand,
  CreateFunctionCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { CognitoSecrets } from "../src/cognito/secrets.js";
import {
  generatePoolSigningKeys,
  signCognitoJwt,
  signingPublicKeys,
} from "../src/cognito/signing.js";
import { cognitoIssuer } from "../src/cognito/tokens.js";
import { TestClock } from "../src/core/clock.js";
import { createZip } from "../src/core/zip-create.js";
import { StackSim } from "../src/server.js";
import { signedFetch } from "./helpers/signed-fetch.js";

const region = "eu-west-1";
const account = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const password = "Valid-password-1!";
const lambdaRole = `arn:aws:iam::${account}:role/cog02-lambda`;
const builtinScope = "aws.cognito.signin.user.admin";

interface PoolFixture {
  poolId: string;
  poolArn: string;
  clientId: string;
  idToken: string;
  accessToken: string;
  email: string;
}

function endpoint(simulator: StackSim): string {
  return `http://127.0.0.1:${simulator.port}`;
}

function clientOptions(simulator: StackSim, selectedRegion = region) {
  return {
    endpoint: endpoint(simulator),
    region: selectedRegion,
    credentials,
    maxAttempts: 1,
  };
}

function decodeJwt(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

function tamper(token: string): string {
  const parts = token.split(".");
  parts[2] = `${parts[2].slice(0, -1)}${parts[2].endsWith("A") ? "B" : "A"}`;
  return parts.join(".");
}

function replaceHeader(token: string, header: Record<string, unknown>): string {
  const [, body, signature] = token.split(".");
  return `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${body}.${signature}`;
}

async function inboxCode(simulator: StackSim, email: string, selectedRegion = region): Promise<string> {
  const response = await signedFetch(
    `${endpoint(simulator)}/_stacksim/api/ses/inbox?recipient=${encodeURIComponent(email)}&status=all&pageSize=100`,
    { service: "ses", region: selectedRegion, credentials, headers: { "x-stacksim-region": selectedRegion } },
  );
  assert.equal(response.status, 200);
  const messages = (await response.json() as { messages: Array<{ messageId: string }> }).messages;
  const detail = await signedFetch(
    `${endpoint(simulator)}/_stacksim/api/ses/inbox/${encodeURIComponent(messages.at(-1)!.messageId)}`,
    { service: "ses", region: selectedRegion, credentials, headers: { "x-stacksim-region": selectedRegion } },
  );
  const text = (await detail.json() as { message: { textBody: string } }).message.textBody;
  const match = /\b(\d{6})\b/.exec(text);
  assert(match);
  return match[1];
}

async function authenticate(
  client: CognitoIdentityProviderClient,
  clientId: string,
  email: string,
): Promise<{ idToken: string; accessToken: string }> {
  const result = (await client.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }))).AuthenticationResult!;
  return { idToken: result.IdToken!, accessToken: result.AccessToken! };
}

async function createPoolFixture(
  simulator: StackSim,
  name: string,
  email: string,
  selectedRegion = region,
): Promise<PoolFixture> {
  const client = new CognitoIdentityProviderClient(clientOptions(simulator, selectedRegion));
  try {
    const created = await client.send(new CreateUserPoolCommand({
      PoolName: name,
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: [{ Name: "email", Required: true, Mutable: true }],
    }));
    const poolId = created.UserPool!.Id!;
    const app = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: `${name}-client`,
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
    const clientId = app.UserPoolClient!.ClientId!;
    await client.send(new SignUpCommand({
      ClientId: clientId,
      Username: email,
      Password: password,
    }));
    await client.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: email,
      ConfirmationCode: await inboxCode(simulator, email, selectedRegion),
    }));
    const tokens = await authenticate(client, clientId, email);
    return {
      poolId,
      poolArn: created.UserPool!.Arn!,
      clientId,
      ...tokens,
      email,
    };
  } finally {
    client.destroy();
  }
}

async function addClient(
  simulator: StackSim,
  fixture: PoolFixture,
  name: string,
): Promise<{ clientId: string; idToken: string; accessToken: string }> {
  const client = new CognitoIdentityProviderClient(clientOptions(simulator));
  try {
    const created = await client.send(new CreateUserPoolClientCommand({
      UserPoolId: fixture.poolId,
      ClientName: name,
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
    const clientId = created.UserPoolClient!.ClientId!;
    return { clientId, ...await authenticate(client, clientId, fixture.email) };
  } finally {
    client.destroy();
  }
}

async function addPoolUser(
  simulator: StackSim,
  clientId: string,
  email: string,
): Promise<{ idToken: string; accessToken: string }> {
  const client = new CognitoIdentityProviderClient(clientOptions(simulator));
  try {
    await client.send(new SignUpCommand({
      ClientId: clientId,
      Username: email,
      Password: password,
    }));
    await client.send(new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: email,
      ConfirmationCode: await inboxCode(simulator, email),
    }));
    return authenticate(client, clientId, email);
  } finally {
    client.destroy();
  }
}

async function signedFixtureToken(
  root: string,
  simulator: StackSim,
  poolId: string,
  use: "id" | "access",
  claims: Record<string, unknown>,
): Promise<string> {
  const secrets = new CognitoSecrets(root);
  await secrets.start(true);
  const pool = simulator.store.regionState(region).cognito.pools[poolId];
  assert(pool?.signingKeys);
  return signCognitoJwt(
    secrets,
    account,
    region,
    poolId,
    pool.signingKeys,
    use,
    claims,
  );
}

async function createEchoFunction(
  simulator: StackSim,
  name: string,
): Promise<{ lambda: LambdaClient; arn: string }> {
  const iam = new IAMClient(clientOptions(simulator));
  try {
    await iam.send(new CreateRoleCommand({
      RoleName: "cog02-lambda",
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: "sts:AssumeRole",
        }],
      }),
    }));
  } catch (error: any) {
    if (error?.name !== "EntityAlreadyExistsException") throw error;
  } finally {
    iam.destroy();
  }
  const lambda = new LambdaClient(clientOptions(simulator));
  const source = `
let calls = 0;
export async function handler(event) {
  calls += 1;
  const authorizer = event.requestContext?.authorizer;
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      calls,
      authorizer,
      hasPrincipalId: Object.prototype.hasOwnProperty.call(authorizer || {}, "principalId")
    })
  };
}
`;
  const created = await lambda.send(new CreateFunctionCommand({
    FunctionName: name,
    Runtime: "nodejs22.x",
    Role: lambdaRole,
    Handler: "index.handler",
    Code: { ZipFile: createZip([{ name: "index.mjs", content: source }]) },
  }));
  return { lambda, arn: created.FunctionArn! };
}

async function permitGateway(
  lambda: LambdaClient,
  functionName: string,
  apiId: string,
  statementId: string,
): Promise<void> {
  await lambda.send(new AddPermissionCommand({
    FunctionName: functionName,
    StatementId: statementId,
    Action: "lambda:InvokeFunction",
    Principal: "apigateway.amazonaws.com",
    SourceArn: `arn:aws:execute-api:${region}:${account}:${apiId}/*/*/*`,
    SourceAccount: account,
  }));
}

async function invokeRest(
  simulator: StackSim,
  apiId: string,
  path: string,
  token?: string,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${simulator.invokePort}/${apiId}/dev${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function responseJson(response: Response): Promise<any> {
  return JSON.parse(await response.text());
}

test("REST Cognito authorizers cover control validation, token semantics, claims, caches, snapshots, gateway responses, keys, and deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cog02-rest-"));
  const clock = new TestClock(Date.parse("2026-07-24T12:00:00Z"));
  let simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    clock,
  });
  const clients: Array<{ destroy(): void }> = [];
  const originalFetch = globalThis.fetch;
  let cognitoNetworkCalls = 0;
  try {
    await simulator.start();
    const pool = await createPoolFixture(simulator, "cog02-rest", "rest@example.com");
    const otherClient = await addClient(simulator, pool, "other-client");
    const otherUser = await addPoolUser(simulator, pool.clientId, "rest-other@example.com");
    const wrongPool = await createPoolFixture(simulator, "cog02-wrong", "wrong@example.com");
    const gateway = new APIGatewayClient(clientOptions(simulator));
    const logs = new CloudWatchLogsClient(clientOptions(simulator));
    const iam = new IAMClient(clientOptions(simulator));
    clients.push(gateway, logs, iam);
    const fn = await createEchoFunction(simulator, "cog02-rest-echo");
    clients.push(fn.lambda);
    const api = await gateway.send(new CreateRestApiCommand({ name: "cog02-rest" }));
    await permitGateway(fn.lambda, "cog02-rest-echo", api.id!, "cog02-rest");
    const rootResource = (await gateway.send(new GetResourcesCommand({ restApiId: api.id! })))
      .items!.find(candidate => candidate.path === "/")!;

    const invalidInputs: Array<any> = [
      {},
      { providerARNs: [] },
      { providerARNs: ["not-an-arn"] },
      { providerARNs: [`arn:aws:cognito-idp:${region}:111111111111:userpool/${pool.poolId}`] },
      { providerARNs: [`arn:aws:cognito-idp:us-east-1:${account}:userpool/${pool.poolId}`] },
      { providerARNs: [`arn:aws-cn:cognito-idp:${region}:${account}:userpool/${pool.poolId}`] },
      { providerARNs: [pool.poolArn], authorizerUri: "arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-1:000000000000:function:x/invocations" },
      { providerARNs: [pool.poolArn], authorizerCredentials: `arn:aws:iam::${account}:role/x` },
      { providerARNs: [pool.poolArn], identitySource: "method.request.querystring.token" },
    ];
    for (const [index, invalid] of invalidInputs.entries()) {
      await assert.rejects(
        gateway.send(new CreateAuthorizerCommand({
          restApiId: api.id!,
          name: `invalid-${index}`,
          type: "COGNITO_USER_POOLS",
          ...invalid,
        })),
        (error: any) => error.name === "BadRequestException",
      );
    }

    const temporary = await gateway.send(new CreateAuthorizerCommand({
      restApiId: api.id!,
      name: "temporary",
      type: "COGNITO_USER_POOLS",
      providerARNs: [pool.poolArn],
      identitySource: "method.request.header.Authorization",
    }));
    assert.equal((await gateway.send(new GetAuthorizerCommand({
      restApiId: api.id!,
      authorizerId: temporary.id!,
    }))).type, "COGNITO_USER_POOLS");
    assert((await gateway.send(new GetAuthorizersCommand({ restApiId: api.id! })))
      .items?.some(candidate => candidate.id === temporary.id));
    await gateway.send(new UpdateAuthorizerCommand({
      restApiId: api.id!,
      authorizerId: temporary.id!,
      patchOperations: [
        { op: "replace", path: "/name", value: "temporary-updated" },
        { op: "replace", path: "/authorizerResultTtlInSeconds", value: "0" },
        { op: "add", path: "/providerARNs", value: wrongPool.poolArn },
      ],
    }));
    assert.deepEqual((await gateway.send(new GetAuthorizerCommand({
      restApiId: api.id!,
      authorizerId: temporary.id!,
    }))).providerARNs, [pool.poolArn, wrongPool.poolArn]);
    assert.equal((await gateway.send(new TestInvokeAuthorizerCommand({
      restApiId: api.id!,
      authorizerId: temporary.id!,
      headers: { Authorization: wrongPool.idToken },
    }))).clientStatus, 0, "each configured provider pool is eligible at runtime");
    await gateway.send(new UpdateAuthorizerCommand({
      restApiId: api.id!,
      authorizerId: temporary.id!,
      patchOperations: [{ op: "remove", path: "/providerARNs", value: wrongPool.poolArn }],
    }));
    await gateway.send(new DeleteAuthorizerCommand({
      restApiId: api.id!,
      authorizerId: temporary.id!,
    }));

    const authorizer = await gateway.send(new CreateAuthorizerCommand({
      restApiId: api.id!,
      name: "pool-authorizer",
      type: "COGNITO_USER_POOLS",
      providerARNs: [pool.poolArn],
      identitySource: "method.request.header.Authorization",
      authorizerResultTtlInSeconds: 60,
    }));
    assert.deepEqual(authorizer.providerARNs, [pool.poolArn]);
    assert.equal(authorizer.authorizerResultTtlInSeconds, 60);
    assert.equal(authorizer.authorizerUri, undefined);

    const proxy = await gateway.send(new CreateResourceCommand({
      restApiId: api.id!,
      parentId: rootResource.id!,
      pathPart: "proxy",
    }));
    const scoped = await gateway.send(new CreateResourceCommand({
      restApiId: api.id!,
      parentId: rootResource.id!,
      pathPart: "scoped",
    }));
    const mapped = await gateway.send(new CreateResourceCommand({
      restApiId: api.id!,
      parentId: rootResource.id!,
      pathPart: "mapped",
    }));
    for (const resource of [proxy, mapped]) {
      await gateway.send(new PutMethodCommand({
        restApiId: api.id!,
        resourceId: resource.id!,
        httpMethod: "GET",
        authorizationType: "COGNITO_USER_POOLS",
        authorizerId: authorizer.id,
      }));
    }
    await gateway.send(new PutMethodCommand({
      restApiId: api.id!,
      resourceId: scoped.id!,
      httpMethod: "GET",
      authorizationType: "COGNITO_USER_POOLS",
      authorizerId: authorizer.id,
      authorizationScopes: [builtinScope],
    }));
    await assert.rejects(
      gateway.send(new PutMethodCommand({
        restApiId: api.id!,
        resourceId: rootResource.id!,
        httpMethod: "POST",
        authorizationType: "NONE",
        authorizationScopes: [builtinScope],
      })),
      (error: any) => error.name === "BadRequestException",
    );
    assert.deepEqual((await gateway.send(new GetMethodCommand({
      restApiId: api.id!,
      resourceId: scoped.id!,
      httpMethod: "GET",
    }))).authorizationScopes, [builtinScope]);
    await gateway.send(new UpdateMethodCommand({
      restApiId: api.id!,
      resourceId: scoped.id!,
      httpMethod: "GET",
      patchOperations: [{ op: "remove", path: "/authorizationScopes", value: builtinScope }],
    }));
    assert.deepEqual((await gateway.send(new GetMethodCommand({
      restApiId: api.id!,
      resourceId: scoped.id!,
      httpMethod: "GET",
    }))).authorizationScopes, []);
    await gateway.send(new UpdateMethodCommand({
      restApiId: api.id!,
      resourceId: scoped.id!,
      httpMethod: "GET",
      patchOperations: [{
        op: "add",
        path: "/authorizationScopes",
        value: builtinScope,
      }],
    }));

    for (const resource of [proxy, scoped]) {
      await gateway.send(new PutIntegrationCommand({
        restApiId: api.id!,
        resourceId: resource.id!,
        httpMethod: "GET",
        type: "AWS_PROXY",
        integrationHttpMethod: "POST",
        uri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${fn.arn}/invocations`,
      }));
    }
    await gateway.send(new PutMethodResponseCommand({
      restApiId: api.id!,
      resourceId: mapped.id!,
      httpMethod: "GET",
      statusCode: "200",
    }));
    await gateway.send(new PutIntegrationCommand({
      restApiId: api.id!,
      resourceId: mapped.id!,
      httpMethod: "GET",
      type: "MOCK",
      requestTemplates: { "application/json": "{\"statusCode\":200}" },
    }));
    await gateway.send(new PutIntegrationResponseCommand({
      restApiId: api.id!,
      resourceId: mapped.id!,
      httpMethod: "GET",
      statusCode: "200",
      responseTemplates: {
        "application/json": "{\"role\":\"$context.authorizer.claims['custom:role']\",\"verified\":\"$context.authorizer.claims.email_verified\",\"groups\":$context.authorizer.claims['cognito:groups']}",
      },
    }));
    await gateway.send(new PutGatewayResponseCommand({
      restApiId: api.id!,
      responseType: "UNAUTHORIZED",
      statusCode: "498",
      responseParameters: { "gatewayresponse.header.x-cog02-error": "'caller-token'" },
      responseTemplates: {
        "application/json": "{\"type\":\"$context.error.responseType\",\"message\":$context.error.messageString}",
      },
    }));
    await gateway.send(new PutGatewayResponseCommand({
      restApiId: api.id!,
      responseType: "AUTHORIZER_CONFIGURATION_ERROR",
      statusCode: "597",
      responseParameters: { "gatewayresponse.header.x-cog02-error": "'configuration'" },
      responseTemplates: {
        "application/json": "{\"type\":\"$context.error.responseType\",\"message\":$context.error.messageString}",
      },
    }));
    await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
    const persistedGatewayState = JSON.stringify(
      simulator.store.regionState(region).apis[api.id!],
    );
    assert(!persistedGatewayState.includes(pool.idToken));
    assert(!persistedGatewayState.includes(pool.accessToken));
    assert(!/"(?:signingKeys|privateJwk|password|refreshToken)"/.test(persistedGatewayState),
      "API Gateway snapshots store configuration, not Cognito identity or signing-secret state");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (/^https:\/\/cognito-idp\./.test(target)) cognitoNetworkCalls += 1;
      return originalFetch(input, init);
    };

    let response = await invokeRest(simulator, api.id!, "/proxy", pool.idToken);
    assert.equal(response.status, 200);
    let body = await responseJson(response);
    assert.equal(body.authorizer.claims.sub, decodeJwt(pool.idToken).sub);
    assert.equal(body.authorizer.claims.email_verified, "true");
    assert.equal(body.authorizer.claims.exp, String(decodeJwt(pool.idToken).exp));
    assert.equal(body.hasPrincipalId, false, "Cognito must not fabricate Lambda-authorizer policy context");
    response = await fetch(`http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/proxy`, {
      headers: { authorization: pool.idToken },
    });
    assert.equal(response.status, 200, "the optional Bearer scheme is normalized without requiring it");
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", otherClient.idToken)).status, 200,
      "without an audience expression any client in the configured pool is eligible");

    const callerFailures = [
      undefined,
      pool.accessToken,
      wrongPool.idToken,
      tamper(pool.idToken),
      replaceHeader(pool.idToken, { alg: "RS256", kid: "unknown", typ: "JWT" }),
    ];
    for (const token of callerFailures) {
      response = await invokeRest(simulator, api.id!, "/proxy", token);
      assert.equal(response.status, 498);
      assert.equal(response.headers.get("x-cog02-error"), "caller-token");
      assert.equal((await responseJson(response)).type, "UNAUTHORIZED");
    }
    assert.equal((await invokeRest(simulator, api.id!, "/scoped", pool.accessToken)).status, 200);
    assert.equal((await invokeRest(simulator, api.id!, "/scoped", pool.idToken)).status, 498);
    await gateway.send(new UpdateMethodCommand({
      restApiId: api.id!,
      resourceId: scoped.id!,
      httpMethod: "GET",
      patchOperations: [{ op: "remove", path: "/authorizationScopes", value: builtinScope }],
    }));
    assert.equal((await invokeRest(simulator, api.id!, "/scoped", pool.accessToken)).status, 200,
      "the old deployment retains the scoped access-token method");
    assert.equal((await invokeRest(simulator, api.id!, "/scoped", pool.idToken)).status, 498);
    await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
    assert.equal((await invokeRest(simulator, api.id!, "/scoped", pool.idToken)).status, 200,
      "a new deployment receives the unscoped ID-token method");
    assert.equal((await invokeRest(simulator, api.id!, "/scoped", pool.accessToken)).status, 498);
    await gateway.send(new UpdateMethodCommand({
      restApiId: api.id!,
      resourceId: scoped.id!,
      httpMethod: "GET",
      patchOperations: [{ op: "add", path: "/authorizationScopes", value: builtinScope }],
    }));
    assert.equal((await invokeRest(simulator, api.id!, "/scoped", pool.idToken)).status, 200,
      "another mutable method change still waits for deployment");
    await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
    assert.equal((await invokeRest(simulator, api.id!, "/scoped", pool.accessToken)).status, 200);
    assert.equal((await invokeRest(simulator, api.id!, "/scoped", pool.idToken)).status, 498);

    const now = Math.floor(clock.now() / 1_000);
    const commonClaims = {
      sub: decodeJwt(pool.idToken).sub,
      iss: cognitoIssuer(region, pool.poolId),
      aud: pool.clientId,
      token_use: "id",
      auth_time: now,
      iat: now,
      exp: now + 300,
      email: pool.email,
      email_verified: true,
      "custom:role": "operator",
      "cognito:groups": ["admins", "operators"],
    };
    const richToken = await signedFixtureToken(root, simulator, pool.poolId, "id", {
      ...commonClaims,
      jti: "rich-token-1",
    });
    const secondRichToken = await signedFixtureToken(root, simulator, pool.poolId, "id", {
      ...commonClaims,
      jti: "rich-token-2",
    });
    const scopeMiss = await signedFixtureToken(root, simulator, pool.poolId, "access", {
      sub: commonClaims.sub,
      iss: commonClaims.iss,
      client_id: pool.clientId,
      token_use: "access",
      auth_time: now,
      iat: now,
      exp: now + 300,
      scope: "openid",
      jti: "scope-miss",
    });
    assert.equal((await invokeRest(simulator, api.id!, "/scoped", scopeMiss)).status, 498);
    const unsupportedClaim = await signedFixtureToken(root, simulator, pool.poolId, "id", {
      ...commonClaims,
      nested: { tier: 2 },
      jti: "unsupported-rest-claim",
    });
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", unsupportedClaim)).status, 498,
      "unsupported REST claim shapes are rejected before they reach an integration");
    response = await invokeRest(simulator, api.id!, "/proxy", richToken);
    body = await responseJson(response);
    const restAwsGoldenFixture = {
      email_verified: "true",
      exp: String(now + 300),
      iat: String(now),
      "cognito:groups": "[\"admins\",\"operators\"]",
      "custom:role": "operator",
    };
    assert.deepEqual({
      email_verified: body.authorizer.claims.email_verified,
      exp: body.authorizer.claims.exp,
      iat: body.authorizer.claims.iat,
      "cognito:groups": body.authorizer.claims["cognito:groups"],
      "custom:role": body.authorizer.claims["custom:role"],
    }, restAwsGoldenFixture);
    response = await invokeRest(simulator, api.id!, "/mapped", richToken);
    assert.equal(response.status, 200);
    assert.deepEqual(await responseJson(response), {
      role: "operator",
      verified: "true",
      groups: ["admins", "operators"],
    });
    const tested = await gateway.send(new TestInvokeAuthorizerCommand({
      restApiId: api.id!,
      authorizerId: authorizer.id!,
      headers: { Authorization: richToken },
    }));
    assert.equal(tested.clientStatus, 0);
    assert.equal(tested.claims?.["custom:role"], "operator");
    assert.equal(tested.claims?.["cognito:groups"], "[\"admins\",\"operators\"]");
    await assert.rejects(
      gateway.send(new TestInvokeAuthorizerCommand({
        restApiId: api.id!,
        authorizerId: authorizer.id!,
        headers: { Authorization: pool.accessToken },
      })),
      (error: any) => error.name === "UnauthorizedException",
    );

    const gatewayTrust = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: "apigateway.amazonaws.com" },
        Action: "sts:AssumeRole",
      }],
    });
    const logRole = await iam.send(new CreateRoleCommand({
      RoleName: "cog02-gateway-logs",
      AssumeRolePolicyDocument: gatewayTrust,
    }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: "cog02-gateway-logs",
      PolicyName: "logs",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
          Resource: "*",
        }],
      }),
    }));
    await gateway.send(new UpdateAccountCommand({
      patchOperations: [{
        op: "replace",
        path: "/cloudwatchRoleArn",
        value: logRole.Role!.Arn!,
      }],
    }));
    await logs.send(new CreateLogGroupCommand({ logGroupName: "/cog02/rest-access" }));
    await gateway.send(new UpdateStageCommand({
      restApiId: api.id!,
      stageName: "dev",
      patchOperations: [
        {
          op: "replace",
          path: "/accessLogSettings/destinationArn",
          value: `arn:aws:logs:${region}:${account}:log-group:/cog02/rest-access`,
        },
        {
          op: "replace",
          path: "/accessLogSettings/format",
          value: "request=$context.requestId;role=$context.authorizer.claims['custom:role'];groups=$context.authorizer.claims['cognito:groups'];verified=$context.authorizer.claims.email_verified",
        },
      ],
    }));
    assert.equal((await invokeRest(simulator, api.id!, "/mapped", richToken)).status, 200);
    const access = await logs.send(new FilterLogEventsCommand({
      logGroupName: "/cog02/rest-access",
      filterPattern: "role=operator",
    }));
    assert.match(
      access.events?.at(-1)?.message ?? "",
      /^request=[A-Za-z0-9]+;role=operator;groups=\["admins","operators"\];verified=true$/,
    );

    await gateway.send(new UpdateStageCommand({
      restApiId: api.id!,
      stageName: "dev",
      patchOperations: [
        { op: "replace", path: "/cacheClusterEnabled", value: "true" },
        { op: "replace", path: "/*/*/caching/enabled", value: "true" },
        { op: "replace", path: "/*/*/caching/ttlInSeconds", value: "300" },
      ],
    }));
    const firstCached = await responseJson(await invokeRest(simulator, api.id!, "/proxy", richToken));
    const cacheEntryCount = () => Object.values(
      simulator.store.regionState(region).apiGatewayResponseCaches,
    ).reduce((total, cache) => total + Object.keys(cache.entries).length, 0);
    assert.equal(cacheEntryCount(), 1);
    const sameCached = await responseJson(await invokeRest(simulator, api.id!, "/proxy", richToken));
    assert.equal(sameCached.calls, firstCached.calls);
    assert.equal(cacheEntryCount(), 1);
    const isolated = await responseJson(await invokeRest(simulator, api.id!, "/proxy", otherUser.idToken));
    assert.notEqual(isolated.authorizer.claims.sub, firstCached.authorizer.claims.sub);
    assert.equal(cacheEntryCount(), 2,
      "the complete bearer digest prevents two users from sharing protected response-cache entries");
    response = await invokeRest(simulator, api.id!, "/proxy", tamper(richToken));
    assert.equal(response.status, 498, "authorization runs before a protected response-cache lookup");

    const originalVerify = simulator.cognito.verify.bind(simulator.cognito);
    let verifyCalls = 0;
    (simulator.cognito as any).verify = async (...args: Parameters<typeof originalVerify>) => {
      verifyCalls += 1;
      return originalVerify(...args);
    };
    await gateway.send(new FlushStageAuthorizersCacheCommand({
      restApiId: api.id!,
      stageName: "dev",
    }));
    verifyCalls = 0;
    await invokeRest(simulator, api.id!, "/proxy", secondRichToken);
    await invokeRest(simulator, api.id!, "/proxy", secondRichToken);
    assert.equal(verifyCalls, 1, "a live unchanged key version permits an authorizer cache hit");
    await gateway.send(new FlushStageAuthorizersCacheCommand({
      restApiId: api.id!,
      stageName: "dev",
    }));
    await invokeRest(simulator, api.id!, "/proxy", secondRichToken);
    assert.equal(verifyCalls, 2, "explicit flush invalidates Cognito authorizer results");

    await gateway.send(new UpdateAuthorizerCommand({
      restApiId: api.id!,
      authorizerId: authorizer.id!,
      patchOperations: [{
        op: "replace",
        path: "/identityValidationExpression",
        value: `^${pool.clientId}$`,
      }],
    }));
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", otherClient.idToken)).status, 200,
      "the old deployment keeps the prior authorizer snapshot");
    await assert.rejects(
      gateway.send(new TestInvokeAuthorizerCommand({
        restApiId: api.id!,
        authorizerId: authorizer.id!,
        headers: { Authorization: otherClient.idToken },
      })),
      (error: any) => error.name === "UnauthorizedException",
      "test-invoke uses the current mutable authorizer",
    );
    await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", otherClient.idToken)).status, 498);
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", pool.idToken)).status, 200);

    await gateway.send(new UpdateAuthorizerCommand({
      restApiId: api.id!,
      authorizerId: authorizer.id!,
      patchOperations: [{
        op: "replace",
        path: "/authorizerResultTtlInSeconds",
        value: "0",
      }],
    }));
    await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
    verifyCalls = 0;
    await invokeRest(simulator, api.id!, "/proxy", richToken);
    await invokeRest(simulator, api.id!, "/proxy", richToken);
    assert.equal(verifyCalls, 2, "TTL zero disables authorizer result caching");
    await gateway.send(new UpdateAuthorizerCommand({
      restApiId: api.id!,
      authorizerId: authorizer.id!,
      patchOperations: [{
        op: "replace",
        path: "/authorizerResultTtlInSeconds",
        value: "1",
      }],
    }));
    await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));
    await gateway.send(new FlushStageAuthorizersCacheCommand({
      restApiId: api.id!,
      stageName: "dev",
    }));
    verifyCalls = 0;
    await invokeRest(simulator, api.id!, "/proxy", richToken);
    await invokeRest(simulator, api.id!, "/proxy", richToken);
    assert.equal(verifyCalls, 1);
    clock.advance(1_001);
    await invokeRest(simulator, api.id!, "/proxy", richToken);
    assert.equal(verifyCalls, 2, "authorizer TTL expiry forces live re-verification");
    await gateway.send(new UpdateAuthorizerCommand({
      restApiId: api.id!,
      authorizerId: authorizer.id!,
      patchOperations: [{
        op: "replace",
        path: "/authorizerResultTtlInSeconds",
        value: "60",
      }],
    }));
    await gateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev" }));

    const shortToken = await signedFixtureToken(root, simulator, pool.poolId, "id", {
      ...commonClaims,
      exp: now + 2,
      jti: "short",
    });
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", shortToken)).status, 200);
    clock.advance(3_000);
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", shortToken)).status, 498,
      "token expiry is earlier than the authorizer TTL");
    const expired = await signedFixtureToken(root, simulator, pool.poolId, "id", {
      ...commonClaims,
      iat: now - 20,
      exp: now - 1,
      jti: "expired",
    });
    const future = await signedFixtureToken(root, simulator, pool.poolId, "id", {
      ...commonClaims,
      iat: now + 601,
      exp: now + 901,
      auth_time: now + 601,
      jti: "future",
    });
    const wrongUse = await signedFixtureToken(root, simulator, pool.poolId, "id", {
      ...commonClaims,
      token_use: "access",
      jti: "wrong-use",
    });
    for (const token of [expired, future, wrongUse]) {
      assert.equal((await invokeRest(simulator, api.id!, "/proxy", token)).status, 498);
    }

    const secrets = new CognitoSecrets(root);
    await secrets.start(true);
    const poolState = simulator.store.regionState(region).cognito.pools[pool.poolId];
    const oldKeys = structuredClone(poolState.signingKeys!);
    const nextKeys = await generatePoolSigningKeys(
      secrets,
      account,
      region,
      pool.poolId,
      clock.now(),
    );
    poolState.signingKeys = {
      id: {
        activeKid: nextKeys.id.activeKid,
        keys: { ...oldKeys.id.keys, ...nextKeys.id.keys },
      },
      access: {
        activeKid: nextKeys.access.activeKid,
        keys: { ...oldKeys.access.keys, ...nextKeys.access.keys },
      },
    };
    await simulator.store.save();
    const cognito = new CognitoIdentityProviderClient(clientOptions(simulator));
    clients.push(cognito);
    const rotated = await authenticate(cognito, pool.clientId, pool.email);
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", pool.idToken)).status, 200,
      "rotation overlap keeps an unexpired old token valid after live cache invalidation");
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", rotated.idToken)).status, 200);
    poolState.signingKeys = nextKeys;
    await simulator.store.save();
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", pool.idToken)).status, 498,
      "removing the old public key invalidates an otherwise cached token");
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", rotated.idToken)).status, 200);

    delete simulator.store.regionState(region).cognito.pools[pool.poolId];
    await simulator.store.save();
    response = await invokeRest(simulator, api.id!, "/proxy", rotated.idToken);
    assert.equal(response.status, 597, "a missing configured pool is a configuration failure");
    simulator.store.regionState(region).cognito.pools[pool.poolId] = poolState;
    await simulator.store.save();
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", rotated.idToken)).status, 200);

    const healthyKeys = poolState.signingKeys;
    poolState.signingKeys = undefined;
    await simulator.store.save();
    response = await invokeRest(simulator, api.id!, "/proxy", rotated.idToken);
    assert.equal(response.status, 597);
    assert.equal(response.headers.get("x-cog02-error"), "configuration");
    assert.equal((await responseJson(response)).type, "AUTHORIZER_CONFIGURATION_ERROR");
    poolState.signingKeys = healthyKeys;
    await simulator.store.save();
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", rotated.idToken)).status, 200);
    const secretStore = (simulator.cognito as any).secrets;
    const healthyRootKey = secretStore.rootKey;
    secretStore.rootKey = undefined;
    response = await invokeRest(simulator, api.id!, "/proxy", rotated.idToken);
    assert.equal(response.status, 597, "a closed authoritative resolver is a configuration failure");
    secretStore.rootKey = healthyRootKey;
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", rotated.idToken)).status, 200);

    for (const client of clients) client.destroy();
    clients.length = 0;
    await simulator.stop();
    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      region,
      authMode: "off",
      clock,
    });
    await simulator.start();
    const restartedGateway = new APIGatewayClient(clientOptions(simulator));
    const restartedCognito = new CognitoIdentityProviderClient(clientOptions(simulator));
    clients.push(restartedGateway, restartedCognito);
    assert.equal((await invokeRest(simulator, api.id!, "/proxy", rotated.idToken)).status, 200,
      "REST authorizer, method, deployment, and authoritative key state survive restart");
    assert.deepEqual((await restartedGateway.send(new GetAuthorizerCommand({
      restApiId: api.id!,
      authorizerId: authorizer.id!,
    }))).providerARNs, [pool.poolArn]);

    await assert.rejects(
      restartedGateway.send(new DeleteAuthorizerCommand({
        restApiId: api.id!,
        authorizerId: authorizer.id!,
      })),
      (error: any) => error.name === "ConflictException",
    );
    await restartedCognito.send(new DeleteUserPoolCommand({ UserPoolId: pool.poolId }));
    response = await invokeRest(simulator, api.id!, "/proxy", rotated.idToken);
    assert.equal(response.status, 597);
    assert.equal((await responseJson(response)).type, "AUTHORIZER_CONFIGURATION_ERROR");
    assert.equal(cognitoNetworkCalls, 0, "REST Cognito verification never performs issuer discovery or JWKS fetch");
  } finally {
    globalThis.fetch = originalFetch;
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("REST Cognito authorizer OpenAPI is atomic and IAM retains exact API Gateway method/path boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cog02-openapi-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "enforce",
    cdkBootstrap: true,
  });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    const pool = await createPoolFixture(simulator, "cog02-openapi", "openapi@example.com");
    const rootGateway = new APIGatewayClient(clientOptions(simulator));
    const iam = new IAMClient(clientOptions(simulator));
    const sts = new STSClient(clientOptions(simulator));
    clients.push(rootGateway, iam, sts);
    const document = {
      openapi: "3.0.1",
      info: { title: "COG-02 OpenAPI", version: "1" },
      components: {
        securitySchemes: {
          poolAuth: {
            type: "apiKey",
            name: "Authorization",
            in: "header",
            "x-amazon-apigateway-authtype": "cognito_user_pools",
            "x-amazon-apigateway-authorizer": {
              type: "cognito_user_pools",
              providerARNs: [pool.poolArn],
              identitySource: "method.request.header.Authorization",
              identityValidationExpression: `^${pool.clientId}$`,
              authorizerResultTtlInSeconds: 42,
            },
          },
        },
      },
      paths: {
        "/unscoped": {
          get: {
            security: [{ poolAuth: [] }],
            responses: { "200": { description: "ok" } },
            "x-amazon-apigateway-integration": {
              type: "mock",
              requestTemplates: { "application/json": "{\"statusCode\":200}" },
              responses: { default: { statusCode: "200" } },
            },
          },
        },
        "/scoped": {
          get: {
            security: [{ poolAuth: [builtinScope] }],
            responses: { "200": { description: "ok" } },
            "x-amazon-apigateway-integration": {
              type: "mock",
              requestTemplates: { "application/json": "{\"statusCode\":200}" },
              responses: { default: { statusCode: "200" } },
            },
          },
        },
      },
    };
    const imported = await rootGateway.send(new ImportRestApiCommand({
      body: Buffer.from(JSON.stringify(document)),
    }));
    const authorizer = (await rootGateway.send(new GetAuthorizersCommand({
      restApiId: imported.id!,
    }))).items![0];
    assert.equal(authorizer.type, "COGNITO_USER_POOLS");
    assert.deepEqual(authorizer.providerARNs, [pool.poolArn]);
    assert.equal(authorizer.identityValidationExpression, `^${pool.clientId}$`);
    assert.equal(authorizer.authorizerResultTtlInSeconds, 42);
    const resources = (await rootGateway.send(new GetResourcesCommand({
      restApiId: imported.id!,
    }))).items!;
    const unscoped = resources.find(candidate => candidate.path === "/unscoped")!;
    const scoped = resources.find(candidate => candidate.path === "/scoped")!;
    assert.equal((await rootGateway.send(new GetMethodCommand({
      restApiId: imported.id!,
      resourceId: unscoped.id!,
      httpMethod: "GET",
    }))).authorizationType, "COGNITO_USER_POOLS");
    assert.deepEqual((await rootGateway.send(new GetMethodCommand({
      restApiId: imported.id!,
      resourceId: scoped.id!,
      httpMethod: "GET",
    }))).authorizationScopes, [builtinScope]);
    await rootGateway.send(new CreateDeploymentCommand({
      restApiId: imported.id!,
      stageName: "dev",
    }));
    const exported = await rootGateway.send(new GetExportCommand({
      restApiId: imported.id!,
      stageName: "dev",
      exportType: "oas30",
      parameters: { extensions: "apigateway" },
      accepts: "application/json",
    }));
    const roundTrip = JSON.parse(Buffer.from(exported.body!).toString("utf8"));
    const exportedAuth = roundTrip.components.securitySchemes.poolAuth;
    assert.equal(exportedAuth["x-amazon-apigateway-authorizer"].type, "cognito_user_pools");
    assert.deepEqual(exportedAuth["x-amazon-apigateway-authorizer"].providerARNs, [pool.poolArn]);
    assert.equal(
      exportedAuth["x-amazon-apigateway-authorizer"].identityValidationExpression,
      `^${pool.clientId}$`,
    );
    assert.deepEqual(roundTrip.paths["/scoped"].get.security, [{ poolAuth: [builtinScope] }]);
    const reimported = await rootGateway.send(new ImportRestApiCommand({ body: exported.body! }));
    assert.equal((await rootGateway.send(new GetAuthorizersCommand({
      restApiId: reimported.id!,
    }))).items?.[0].type, "COGNITO_USER_POOLS");

    const before = await rootGateway.send(new GetAuthorizerCommand({
      restApiId: imported.id!,
      authorizerId: authorizer.id!,
    }));
    const invalid = structuredClone(document);
    invalid.components.securitySchemes.poolAuth["x-amazon-apigateway-authorizer"].providerARNs = [
      `arn:aws:cognito-idp:us-east-1:${account}:userpool/${pool.poolId}`,
    ];
    await assert.rejects(
      rootGateway.send(new PutRestApiCommand({
        restApiId: imported.id!,
        mode: "overwrite",
        body: Buffer.from(JSON.stringify(invalid)),
      })),
      (error: any) => error.name === "BadRequestException",
    );
    assert.deepEqual((await rootGateway.send(new GetAuthorizerCommand({
      restApiId: imported.id!,
      authorizerId: authorizer.id!,
    }))).providerARNs, before.providerARNs, "an invalid OpenAPI replacement is atomic");
    assert.equal((await rootGateway.send(new GetMethodCommand({
      restApiId: imported.id!,
      resourceId: unscoped.id!,
      httpMethod: "GET",
    }))).authorizationType, "COGNITO_USER_POOLS",
    "an unsupported replacement cannot downgrade a protected method to NONE");

    const roleName = "cog02-apigateway-control";
    const roleArn = `arn:aws:iam::${account}:role/${roleName}`;
    await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { AWS: `arn:aws:iam::${account}:root` },
          Action: "sts:AssumeRole",
        }],
      }),
    }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "authorizer-only",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: "apigateway:POST",
          Resource: `arn:aws:apigateway:${region}::/restapis/${imported.id}/authorizers`,
        }],
      }),
    }));
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "authorizer-only",
    }));
    const scopedGateway = new APIGatewayClient({
      endpoint: endpoint(simulator),
      region,
      credentials: {
        accessKeyId: assumed.Credentials!.AccessKeyId!,
        secretAccessKey: assumed.Credentials!.SecretAccessKey!,
        sessionToken: assumed.Credentials!.SessionToken!,
      },
      maxAttempts: 1,
    });
    clients.push(scopedGateway);
    const created = await scopedGateway.send(new CreateAuthorizerCommand({
      restApiId: imported.id!,
      name: "iam-authorizer",
      type: "COGNITO_USER_POOLS",
      providerARNs: [pool.poolArn],
      identitySource: "method.request.header.Authorization",
    }));
    assert(created.id);
    await assert.rejects(
      scopedGateway.send(new PutMethodCommand({
        restApiId: imported.id!,
        resourceId: unscoped.id!,
        httpMethod: "POST",
        authorizationType: "COGNITO_USER_POOLS",
        authorizerId: created.id,
      })),
      (error: any) => error.name === "AccessDeniedException",
    );
    const decisions = simulator.store.ensureAccount().iam.authorizationDecisions
      .filter(decision => decision.principalArn.includes("assumed-role/cog02-apigateway-control"));
    assert(decisions.some(decision =>
      decision.action === "apigateway:POST"
      && decision.resource.endsWith(`/restapis/${imported.id}/authorizers`)
      && decision.decision === "allowed"));
    assert(decisions.some(decision =>
      decision.action === "apigateway:PUT"
      && decision.resource.includes(`/restapis/${imported.id}/resources/${unscoped.id}/methods/POST`)
      && decision.decision !== "allowed"));
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP JWT authorizers resolve live Cognito keys in process, preserve generic semantics and string fixtures, snapshot config, restart, and fail closed on tombstones", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cog02-http-"));
  const clock = new TestClock(Date.parse("2026-07-24T12:00:00Z"));
  let simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    clock,
    apiGatewayAllowRemoteJwtJwks: true,
  });
  let clients: Array<{ destroy(): void }> = [];
  const originalFetch = globalThis.fetch;
  let cognitoNetworkCalls = 0;
  try {
    await simulator.start();
    const pool = await createPoolFixture(simulator, "cog02-http", "http@example.com");
    const issuer = cognitoIssuer(region, pool.poolId);
    const gateway = new ApiGatewayV2Client(clientOptions(simulator));
    clients.push(gateway);
    const fn = await createEchoFunction(simulator, "cog02-http-echo");
    clients.push(fn.lambda);
    const api = await gateway.send(new CreateApiCommand({
      Name: "cog02-http",
      ProtocolType: "HTTP",
    }));
    await permitGateway(fn.lambda, "cog02-http-echo", api.ApiId!, "cog02-http");
    const integration = await gateway.send(new CreateHttpIntegrationCommand({
      ApiId: api.ApiId!,
      IntegrationType: "AWS_PROXY",
      IntegrationUri: fn.arn,
      PayloadFormatVersion: "2.0",
    }));
    const authorizer = await gateway.send(new CreateHttpAuthorizerCommand({
      ApiId: api.ApiId!,
      Name: "pool-jwt",
      AuthorizerType: "JWT",
      IdentitySource: ["$request.header.Authorization"],
      JwtConfiguration: { Issuer: issuer, Audience: [pool.clientId] },
    }));
    await gateway.send(new CreateHttpRouteCommand({
      ApiId: api.ApiId!,
      RouteKey: "GET /open",
      Target: `integrations/${integration.IntegrationId}`,
      AuthorizationType: "JWT",
      AuthorizerId: authorizer.AuthorizerId,
    }));
    await gateway.send(new CreateHttpRouteCommand({
      ApiId: api.ApiId!,
      RouteKey: "GET /scoped",
      Target: `integrations/${integration.IntegrationId}`,
      AuthorizationType: "JWT",
      AuthorizerId: authorizer.AuthorizerId,
      AuthorizationScopes: [builtinScope],
    }));
    const deployment = await gateway.send(new CreateHttpDeploymentCommand({ ApiId: api.ApiId! }));
    await gateway.send(new CreateHttpStageCommand({
      ApiId: api.ApiId!,
      StageName: "dev",
      DeploymentId: deployment.DeploymentId,
    }));
    const invoke = (path: string, token?: string) =>
      fetch(`http://127.0.0.1:${simulator.invokePort}/${api.ApiId}/dev${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (/^https:\/\/cognito-idp\./.test(target)) cognitoNetworkCalls += 1;
      return originalFetch(input, init);
    };

    let response = await invoke("/open", pool.idToken);
    assert.equal(response.status, 200);
    let event = (await responseJson(response)).authorizer.jwt;
    const idPayload = decodeJwt(pool.idToken);
    assert.equal(event.claims.sub, idPayload.sub);
    assert.equal(event.claims.email_verified, "true");
    assert.equal(event.claims.exp, String(idPayload.exp));
    assert.equal(event.claims.iat, String(idPayload.iat));
    assert.deepEqual(event.scopes, []);
    response = await invoke("/open", pool.accessToken);
    assert.equal(response.status, 200, "client_id is used when aud is absent");
    event = (await responseJson(response)).authorizer.jwt;
    assert.equal(event.claims.token_use, "access");
    assert.deepEqual(event.scopes, [builtinScope]);
    assert.equal((await invoke("/scoped", pool.accessToken)).status, 200);
    assert.equal((await invoke("/scoped", pool.idToken)).status, 403);

    const now = Math.floor(clock.now() / 1_000);
    const arbitraryUse = await signedFixtureToken(root, simulator, pool.poolId, "id", {
      sub: "generic-subject",
      iss: issuer,
      aud: pool.clientId,
      token_use: "arbitrary",
      iat: now,
      exp: now + 300,
      email_verified: true,
      "custom:role": "reader",
      "cognito:groups": ["alpha", "beta"],
      nested: { tier: 2 },
    });
    response = await invoke("/open", arbitraryUse);
    assert.equal(response.status, 200, "generic HTTP JWT authorization does not impose token_use");
    event = (await responseJson(response)).authorizer.jwt;
    const httpV2AwsGoldenFixture = {
      sub: "generic-subject",
      iss: issuer,
      aud: pool.clientId,
      token_use: "arbitrary",
      iat: String(now),
      exp: String(now + 300),
      email_verified: "true",
      "custom:role": "reader",
      "cognito:groups": "[\"alpha\",\"beta\"]",
      nested: "{\"tier\":2}",
    };
    assert.deepEqual(event.claims, httpV2AwsGoldenFixture);
    assert.deepEqual(event.scopes, []);

    const noTokenUseAccess = await signedFixtureToken(root, simulator, pool.poolId, "access", {
      sub: "access-subject",
      iss: issuer,
      client_id: pool.clientId,
      iat: now,
      exp: now + 300,
      scope: builtinScope,
    });
    assert.equal((await invoke("/scoped", noTokenUseAccess)).status, 200);
    const resourceAudience = await signedFixtureToken(root, simulator, pool.poolId, "access", {
      sub: "resource-bound",
      iss: issuer,
      aud: "https://api.example/resource",
      client_id: pool.clientId,
      iat: now,
      exp: now + 300,
      scope: builtinScope,
    });
    assert.equal((await invoke("/open", resourceAudience)).status, 401,
      "an aud claim takes precedence and cannot fall back to matching client_id");
    assert.equal((await invoke("/open", tamper(pool.idToken))).status, 401);
    assert.equal((await invoke("/open")).status, 401);
    assert.equal(cognitoNetworkCalls, 0);

    await gateway.send(new UpdateHttpAuthorizerCommand({
      ApiId: api.ApiId!,
      AuthorizerId: authorizer.AuthorizerId!,
      JwtConfiguration: { Issuer: issuer, Audience: ["replacement-client"] },
    }));
    assert.equal((await invoke("/open", pool.idToken)).status, 200,
      "the old HTTP deployment keeps its authorizer configuration");
    const nextDeployment = await gateway.send(new CreateHttpDeploymentCommand({ ApiId: api.ApiId! }));
    await gateway.send(new UpdateHttpStageCommand({
      ApiId: api.ApiId!,
      StageName: "dev",
      DeploymentId: nextDeployment.DeploymentId,
    }));
    assert.equal((await invoke("/open", pool.idToken)).status, 401);
    await gateway.send(new UpdateHttpAuthorizerCommand({
      ApiId: api.ApiId!,
      AuthorizerId: authorizer.AuthorizerId!,
      JwtConfiguration: { Issuer: issuer, Audience: [pool.clientId] },
    }));
    const restoredDeployment = await gateway.send(new CreateHttpDeploymentCommand({ ApiId: api.ApiId! }));
    await gateway.send(new UpdateHttpStageCommand({
      ApiId: api.ApiId!,
      StageName: "dev",
      DeploymentId: restoredDeployment.DeploymentId,
    }));
    assert.equal((await invoke("/open", pool.idToken)).status, 200);

    const secrets = new CognitoSecrets(root);
    await secrets.start(true);
    const poolState = simulator.store.regionState(region).cognito.pools[pool.poolId];
    const priorKeys = structuredClone(poolState.signingKeys!);
    const rotatedKeys = await generatePoolSigningKeys(
      secrets,
      account,
      region,
      pool.poolId,
      clock.now(),
    );
    poolState.signingKeys = {
      id: {
        activeKid: rotatedKeys.id.activeKid,
        keys: { ...priorKeys.id.keys, ...rotatedKeys.id.keys },
      },
      access: {
        activeKid: rotatedKeys.access.activeKid,
        keys: { ...priorKeys.access.keys, ...rotatedKeys.access.keys },
      },
    };
    await simulator.store.save();
    const cognitoBeforeRestart = new CognitoIdentityProviderClient(clientOptions(simulator));
    clients.push(cognitoBeforeRestart);
    const rotated = await authenticate(cognitoBeforeRestart, pool.clientId, pool.email);
    assert.equal((await invoke("/open", pool.idToken)).status, 200,
      "HTTP JWT resolution reads the live overlapping key ring");
    assert.equal((await invoke("/open", rotated.idToken)).status, 200);
    poolState.signingKeys = rotatedKeys;
    await simulator.store.save();
    assert.equal((await invoke("/open", pool.idToken)).status, 401,
      "HTTP JWT resolution observes live old-key removal without redeployment");
    assert.equal((await invoke("/open", rotated.idToken)).status, 200);

    const oldPublicKeys = signingPublicKeys(
      simulator.store.regionState(region).cognito.pools[pool.poolId].signingKeys!,
    );
    for (const client of clients) client.destroy();
    clients = [];
    await simulator.stop();
    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      region,
      authMode: "off",
      clock,
      apiGatewayAllowRemoteJwtJwks: true,
      apiGatewayJwtJwks: { [issuer]: { keys: oldPublicKeys } },
    });
    await simulator.start();
    const restartedGateway = new ApiGatewayV2Client(clientOptions(simulator));
    const cognito = new CognitoIdentityProviderClient(clientOptions(simulator));
    clients.push(restartedGateway, cognito);
    const restartedInvoke = (token: string) =>
      fetch(`http://127.0.0.1:${simulator.invokePort}/${api.ApiId}/dev/open`, {
        headers: { authorization: `Bearer ${token}` },
      });
    assert.equal((await restartedInvoke(rotated.idToken)).status, 200,
      "authorizer config and authoritative signing material survive restart");
    await cognito.send(new DeleteUserPoolCommand({ UserPoolId: pool.poolId }));
    assert.equal((await restartedInvoke(rotated.idToken)).status, 401,
      "a locally claimed tombstone fails closed instead of using static fallback keys");
    assert.equal(cognitoNetworkCalls, 0,
      "available and tombstoned local Cognito issuers never invoke discovery, DNS, or HTTP");
  } finally {
    globalThis.fetch = originalFetch;
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
