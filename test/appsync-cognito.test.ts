import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppSyncClient, CreateApiKeyCommand, CreateDataSourceCommand, CreateGraphqlApiCommand, CreateResolverCommand, GetSchemaCreationStatusCommand, StartSchemaCreationCommand, UpdateGraphqlApiCommand } from "@aws-sdk/client-appsync";
import { AdminConfirmSignUpCommand, AdminDisableUserCommand, AdminEnableUserCommand, AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient, CreateUserPoolClientCommand, CreateUserPoolCommand, DeleteUserPoolCommand, InitiateAuthCommand, RevokeTokenCommand, SignUpCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { IAMClient } from "@aws-sdk/client-iam";
import WebSocket from "ws";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";
import { CognitoSecrets } from "../src/cognito/secrets.js";
import { signCognitoJwt } from "../src/cognito/signing.js";
import { deployGeneratedAuthData } from "./support/amplify-auth-data.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const password = "Private-example-123!";

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-cognito-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce", cdkBootstrap: false });
  await simulator.start();
  const options = { endpoint: `http://127.0.0.1:${simulator.port}`, region, credentials, maxAttempts: 1 };
  const appsync = new AppSyncClient(options);
  const cognito = new CognitoIdentityProviderClient(options);
  const dynamodb = new DynamoDBClient(options);
  const iam = new IAMClient(options);
  const pool = (await cognito.send(new CreateUserPoolCommand({ PoolName: "appsync-auth", UsernameAttributes: ["email"], AutoVerifiedAttributes: ["email"] }))).UserPool!;
  const client = (await cognito.send(new CreateUserPoolClientCommand({ UserPoolId: pool.Id, ClientName: "appsync", ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"], AccessTokenValidity: 5, IdTokenValidity: 5, TokenValidityUnits: { AccessToken: "minutes", IdToken: "minutes" } }))).UserPoolClient!;
  const signIn = async (username: string, clientId = client.ClientId!) => (await cognito.send(new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: clientId, AuthParameters: { USERNAME: username, PASSWORD: password } }))).AuthenticationResult!;
  const user = async (username: string) => {
    await cognito.send(new SignUpCommand({ ClientId: client.ClientId, Username: username, Password: password, UserAttributes: [{ Name: "email", Value: username }] }));
    // Official admin confirmation is explicit for this token/owner runtime fixture.
    await cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: pool.Id, Username: username }));
    return signIn(username);
  };
  const stop = async () => { appsync.destroy(); cognito.destroy(); dynamodb.destroy(); iam.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true }); };
  return { root, clock, simulator, appsync, cognito, dynamodb, iam, pool, client, signIn, user, stop };
}

async function graphql(endpoint: string, token: string, query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: token }, body: JSON.stringify({ query, variables }) });
  return { status: response.status, value: await response.json() as any };
}
const claims = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

test("AMX-13B local verified access tokens, native directives, identity, signing generations and offline revocation semantics", async () => {
  const h = await harness();
  try {
    const alice = await h.user("alice@example.test");
    const config = { userPoolId: h.pool.Id!, awsRegion: region, defaultAction: "ALLOW" as const, appIdClientRegex: `^${h.client.ClientId}$` };
    const api = (await h.appsync.send(new CreateGraphqlApiCommand({ name: "native-cognito", authenticationType: "AMAZON_COGNITO_USER_POOLS", userPoolConfig: config, additionalAuthenticationProviders: [{ authenticationType: "API_KEY" }, { authenticationType: "AWS_IAM" }] }))).graphqlApi!;
    const endpoint = api.uris!.GRAPHQL!;
    await h.appsync.send(new StartSchemaCreationCommand({ apiId: api.apiId, definition: Buffer.from("type Query { identity: AWSJSON onlyCognito: String @aws_cognito_user_pools public: String @aws_api_key mixed: String @aws_api_key @aws_cognito_user_pools }") }));
    assert.equal((await h.appsync.send(new GetSchemaCreationStatusCommand({ apiId: api.apiId }))).status, "SUCCESS");
    await h.appsync.send(new CreateDataSourceCommand({ apiId: api.apiId, name: "NONE", type: "NONE" }));
    for (const fieldName of ["identity", "onlyCognito", "public", "mixed"]) await h.appsync.send(new CreateResolverCommand({ apiId: api.apiId, typeName: "Query", fieldName, dataSourceName: "NONE", requestMappingTemplate: `{"version":"2018-05-29","payload":${fieldName === "identity" ? "$util.toJson($ctx.identity)" : '"ok"'}}`, responseMappingTemplate: "$util.toJson($ctx.result)" }));
    const valid = await graphql(endpoint, alice.AccessToken!, "{ identity onlyCognito public mixed }");
    assert.equal(valid.status, 200);
    assert.equal(valid.value.data.onlyCognito, "ok");
    assert.equal(valid.value.data.mixed, "ok");
    assert.equal(valid.value.data.public, null);
    assert.equal(valid.value.errors.length, 1);
    const identity = valid.value.data.identity;
    assert.deepEqual(Object.keys(identity).sort(), ["claims", "defaultAuthStrategy", "issuer", "sourceIp", "sub", "username"]);
    assert.equal(identity.sub, claims(alice.AccessToken!).sub);
    assert.equal(identity.username, claims(alice.AccessToken!).username);
    assert.equal(identity.claims.token_use, "access");
    assert.equal(identity.defaultAuthStrategy, "ALLOW");
    assert(!JSON.stringify(identity).includes(alice.AccessToken!));
    const key = (await h.appsync.send(new CreateApiKeyCommand({ apiId: api.apiId }))).apiKey!.id!;
    const keyResult = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify({ query: "{ onlyCognito public mixed }" }) });
    const keyJson = await keyResult.json() as any;
    assert.equal(keyJson.data.onlyCognito, null); assert.equal(keyJson.data.public, "ok"); assert.equal(keyJson.data.mixed, "ok");
    assert.equal((await graphql(endpoint, alice.IdToken!, "{ identity }")).status, 401);
    const parts = alice.AccessToken!.split("."); parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    assert.equal((await graphql(endpoint, parts.join("."), "{ identity }")).status, 401);
    const otherClient = (await h.cognito.send(new CreateUserPoolClientCommand({ UserPoolId: h.pool.Id, ClientName: "wrong-client", ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"] }))).UserPoolClient!;
    const wrongClient = await h.signIn("alice@example.test", otherClient.ClientId);
    assert.equal((await graphql(endpoint, wrongClient.AccessToken!, "{ identity }")).status, 401);
    const poolState = h.simulator.store.regionState(region).cognito.pools[h.pool.Id!];
    const otherPool = (await h.cognito.send(new CreateUserPoolCommand({ PoolName: "other-pool" }))).UserPool!;
    const otherPoolState = h.simulator.store.regionState(region).cognito.pools[otherPool.Id!];
    const secrets = new CognitoSecrets(h.root); await secrets.start(true);
    {
      const wrongPool = signCognitoJwt(secrets, "000000000000", region, otherPool.Id!, otherPoolState.signingKeys!, "access", { ...claims(alice.AccessToken!), iss: `https://cognito-idp.${region}.amazonaws.com/${otherPool.Id}` });
      assert.equal((await graphql(endpoint, wrongPool, "{ identity }")).status, 401);
      for (const change of [{ nbf: Math.floor(h.clock.now() / 1000) + 60 }, { iss: `https://cognito-idp.us-east-1.amazonaws.com/${h.pool.Id}` }, { exp: Math.floor(h.clock.now() / 1000) - 1 }, { token_use: "id" }]) {
        const token = signCognitoJwt(secrets, "000000000000", region, poolState.id, poolState.signingKeys!, "access", { ...claims(alice.AccessToken!), ...change });
        assert.equal((await graphql(endpoint, token, "{ identity }")).status, 401);
      }
    }
    // Refresh-token revocation does not revoke already issued offline JWTs.
    await h.cognito.send(new RevokeTokenCommand({ ClientId: h.client.ClientId, Token: alice.RefreshToken! }));
    assert.equal((await graphql(endpoint, alice.AccessToken!, "{ onlyCognito }")).value.data.onlyCognito, "ok");
    await assert.rejects(h.cognito.send(new InitiateAuthCommand({ ClientId: h.client.ClientId, AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: alice.RefreshToken! } })), { name: "NotAuthorizedException" });
    // Global sign-out and disabled users have the same offline JWT boundary.
    await h.cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: h.pool.Id, Username: "alice@example.test" }));
    await h.cognito.send(new AdminDisableUserCommand({ UserPoolId: h.pool.Id, Username: "alice@example.test" }));
    assert.equal((await graphql(endpoint, alice.AccessToken!, "{ onlyCognito }")).value.data.onlyCognito, "ok");
    await assert.rejects(h.cognito.send(new InitiateAuthCommand({ ClientId: h.client.ClientId, AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: alice.RefreshToken! } })), { name: "NotAuthorizedException" });
    const kid = JSON.parse(Buffer.from(alice.AccessToken!.split(".")[0], "base64url").toString()).kid;
    const signingKey = poolState.signingKeys!.access.keys[kid];
    signingKey.retireAfter = h.clock.now();
    assert.equal((await graphql(endpoint, alice.AccessToken!, "{ identity }")).status, 401);
    delete signingKey.retireAfter;
    delete poolState.signingKeys!.access.keys[kid];
    assert.equal((await graphql(endpoint, alice.AccessToken!, "{ identity }")).status, 401);
    poolState.signingKeys!.access.keys[kid] = signingKey;
    const verify = h.simulator.cognito.verify.bind(h.simulator.cognito);
    h.simulator.cognito.verify = async input => {
      const proof = await verify(input);
      delete poolState.signingKeys!.access.keys[kid];
      return proof;
    };
    try { assert.equal((await graphql(endpoint, alice.AccessToken!, "{ identity }")).status, 401); }
    finally { h.simulator.cognito.verify = verify; poolState.signingKeys!.access.keys[kid] = signingKey; }
    await h.appsync.send(new UpdateGraphqlApiCommand({ apiId: api.apiId, name: api.name, authenticationType: "AMAZON_COGNITO_USER_POOLS", userPoolConfig: { ...config, defaultAction: "DENY" } }));
    const denyDefault = await graphql(endpoint, alice.AccessToken!, "{ identity onlyCognito }");
    assert.equal(denyDefault.value.data.identity, null);
    assert.equal(denyDefault.value.data.onlyCognito, "ok");
    await h.appsync.send(new UpdateGraphqlApiCommand({ apiId: api.apiId, name: api.name, authenticationType: "API_KEY", additionalAuthenticationProviders: [{ authenticationType: "AMAZON_COGNITO_USER_POOLS", userPoolConfig: { userPoolId: h.pool.Id, awsRegion: region, appIdClientRegex: `^${h.client.ClientId}$` } }] }));
    assert.equal((await graphql(endpoint, alice.AccessToken!, "{ identity onlyCognito }")).value.data.onlyCognito, "ok");
    assert.equal((await graphql(endpoint, alice.AccessToken!, "{ identity }")).value.data.identity, null);
    await assert.rejects(h.appsync.send(new CreateGraphqlApiCommand({ name: "wrong-region", authenticationType: "AMAZON_COGNITO_USER_POOLS", userPoolConfig: { ...config, awsRegion: "us-east-1" } })), { name: "BadRequestException" });
    await assert.rejects(h.appsync.send(new CreateGraphqlApiCommand({ name: "missing-pool", authenticationType: "AMAZON_COGNITO_USER_POOLS", userPoolConfig: { ...config, userPoolId: `${region}_ZZZZZZZZZ` } })), { name: "BadRequestException" });
    await assert.rejects(h.appsync.send(new CreateGraphqlApiCommand({ name: "wrong-account", authenticationType: "AMAZON_COGNITO_USER_POOLS", userPoolConfig: { ...config, userPoolId: `arn:aws:cognito-idp:${region}:111111111111:userpool/${h.pool.Id}` } })), { name: "BadRequestException" });
    h.clock.advance(5 * 60_000);
    h.cognito.config.systemClockOffset = h.clock.now() - Date.now();
    assert.equal((await graphql(endpoint, alice.AccessToken!, "{ onlyCognito }")).status, 401);
    await h.cognito.send(new AdminEnableUserCommand({ UserPoolId: h.pool.Id, Username: "alice@example.test" }));
    const beforeDeletion = await h.signIn("alice@example.test");
    assert.equal((await graphql(endpoint, beforeDeletion.AccessToken!, "{ onlyCognito }")).status, 200);
    await h.cognito.send(new DeleteUserPoolCommand({ UserPoolId: h.pool.Id }));
    assert.equal((await graphql(endpoint, beforeDeletion.AccessToken!, "{ onlyCognito }")).status, 401);
    const persisted = await readFile(join(h.root, "state.json"), "utf8");
    assert(!persisted.includes(alice.AccessToken!)); assert(!persisted.includes(password));
    assert(!JSON.stringify(h.simulator.appsync.realtimeDiagnostics()).includes(alice.AccessToken!));
  } finally { await h.stop(); }
});

class RealtimeClient {
  readonly socket: WebSocket;
  readonly messages: any[] = [];
  private readonly waiters: Array<() => void> = [];
  constructor(endpoint: string, readonly headers: Record<string, string>) {
    const encoded = Buffer.from(JSON.stringify(headers)).toString("base64url");
    this.socket = new WebSocket(endpoint, ["graphql-ws", `header-${encoded}`]);
    this.socket.on("message", data => { this.messages.push(JSON.parse(data.toString())); this.waiters.splice(0).forEach(resolve => resolve()); });
  }
  async open() {
    await new Promise<void>((resolve, reject) => { this.socket.once("open", resolve); this.socket.once("error", reject); });
    this.socket.send(JSON.stringify({ type: "connection_init" })); await this.next("connection_ack");
  }
  start(id: string, query: string, variables: Record<string, unknown> = {}, headers = this.headers) {
    this.socket.send(JSON.stringify({ id, type: "start", payload: { data: JSON.stringify({ query, variables }), extensions: { authorization: headers } } }));
  }
  async next(type: string, id?: string, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const index = this.messages.findIndex(message => message.type === type && (id === undefined || message.id === id));
      if (index >= 0) return this.messages.splice(index, 1)[0];
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${type}:${id ?? ""}; messages=${JSON.stringify(this.messages)}`);
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}:${id ?? ""}; messages=${JSON.stringify(this.messages)}`)), remaining); this.waiters.push(() => { clearTimeout(timer); resolve(); }); });
    }
  }
  close() { this.socket.close(); }
}

test("AMX-13C unchanged generated owner pipelines stamp immutable ownership and isolate CRUD, pagination and subscriptions", async () => {
  const h = await harness();
  const sockets: RealtimeClient[] = [];
  try {
    const alice = await h.user("alice@example.test");
    const bob = await h.user("bob@example.test");
    const { api, tableName } = await deployGeneratedAuthData({ ...h, region, userPoolId: h.pool.Id! });
    const endpoint = api.uris!.GRAPHQL!;
    const run = async (token: string, query: string, variables?: Record<string, unknown>) => {
      const result = await graphql(endpoint, token, query, variables); assert.equal(result.status, 200); return result.value;
    };
    const create = (token: string, input: any) => run(token, "mutation Create($input: CreateTodoInput!) { createTodo(input:$input) { id title owner createdAt updatedAt } }", { input });
    const denied = (value: any, field: string) => { assert.equal(value.data?.[field], null, JSON.stringify(value)); assert(value.errors?.length, JSON.stringify(value)); };
    denied(await create(bob.AccessToken!, { title: "spoof", owner: claims(alice.AccessToken!).username }), "createTodo");
    const first = await create(alice.AccessToken!, { title: "Alice private 1" });
    assert.equal(first.errors, undefined, JSON.stringify(first));
    const aliceId = first.data.createTodo.id;
    assert.equal(first.data.createTodo.owner, claims(alice.AccessToken!).username);
    const stored = await h.dynamodb.send(new GetItemCommand({ TableName: tableName, Key: { id: { S: aliceId } } }));
    assert.equal(stored.Item?.owner.S, `${claims(alice.AccessToken!).sub}::${claims(alice.AccessToken!).username}`);
    const bobCreated = await create(bob.AccessToken!, { title: "Bob private" });
    assert.equal(bobCreated.errors, undefined, JSON.stringify(bobCreated));
    const second = await create(alice.AccessToken!, { title: "Alice private 2" });
    assert.equal(second.errors, undefined, JSON.stringify(second));
    const get = "query Get($id: ID!) { getTodo(id:$id) { id title owner } }";
    denied(await run(bob.AccessToken!, get, { id: aliceId }), "getTodo");
    assert.equal((await run(alice.AccessToken!, get, { id: aliceId })).data.getTodo.id, aliceId);
    const update = "mutation Update($input: UpdateTodoInput!) { updateTodo(input:$input) { id title owner } }";
    denied(await run(bob.AccessToken!, update, { input: { id: aliceId, title: "intrusion" } }), "updateTodo");
    denied(await run(alice.AccessToken!, update, { input: { id: aliceId, owner: claims(bob.AccessToken!).username } }), "updateTodo");
    assert.equal((await run(alice.AccessToken!, update, { input: { id: aliceId, title: "Alice revised" } })).data.updateTodo.title, "Alice revised");
    const remove = "mutation Delete($input: DeleteTodoInput!) { deleteTodo(input:$input) { id title owner } }";
    denied(await run(bob.AccessToken!, remove, { input: { id: aliceId } }), "deleteTodo");
    const list = "query List($nextToken: String, $filter: ModelTodoFilterInput) { listTodos(limit:1,nextToken:$nextToken,filter:$filter) { items { id title owner } nextToken } }";
    const seen: string[] = [];
    let nextToken: string | null = null;
    let aliceToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await run(alice.AccessToken!, list, { nextToken });
      assert.equal(result.errors, undefined, JSON.stringify(result));
      for (const item of result.data.listTodos.items) { assert.equal(item.owner, claims(alice.AccessToken!).username); seen.push(item.id); }
      nextToken = result.data.listTodos.nextToken;
      if (nextToken) aliceToken = nextToken;
      else break;
    }
    assert.deepEqual(seen.sort(), [aliceId, second.data.createTodo.id].sort());
    assert(aliceToken);
    const reused = await run(bob.AccessToken!, list, { nextToken: aliceToken });
    assert(reused.errors?.length, JSON.stringify(reused));
    const filtered = await run(bob.AccessToken!, "{ listTodos(filter: {title: {beginsWith: \"Alice\"}}) { items { id title owner } } }");
    assert.deepEqual(filtered.data.listTodos.items, []);
    const headers = (token: string) => ({ host: new URL(endpoint).host, authorization: token });
    const aliceSocket = new RealtimeClient(api.uris!.REALTIME!, headers(alice.AccessToken!)); sockets.push(aliceSocket);
    const bobSocket = new RealtimeClient(api.uris!.REALTIME!, headers(bob.AccessToken!)); sockets.push(bobSocket);
    await Promise.all([aliceSocket.open(), bobSocket.open()]);
    const subscription = "subscription { onCreateTodo { id title owner } }";
    aliceSocket.start("alice", subscription); bobSocket.start("bob", subscription);
    await Promise.all([aliceSocket.next("start_ack", "alice"), bobSocket.next("start_ack", "bob")]);
    bobSocket.start("explicit", "subscription($owner: String) { onCreateTodo(owner:$owner) { id title owner } }", { owner: claims(bob.AccessToken!).username });
    await bobSocket.next("start_ack", "explicit");
    bobSocket.start("spoof", "subscription($owner: String) { onCreateTodo(owner:$owner) { id title owner } }", { owner: claims(alice.AccessToken!).username });
    assert.equal((await bobSocket.next("error", "spoof")).payload.errors[0].errorType, "Unauthorized");
    bobSocket.start("switch", subscription, {}, headers(alice.AccessToken!));
    assert.equal((await bobSocket.next("error", "switch")).payload.errors[0].errorType, "UnauthorizedException");
    const aliceEvent = await create(alice.AccessToken!, { title: "Alice event" });
    assert.equal(aliceEvent.errors, undefined, JSON.stringify(aliceEvent));
    const bobEvent = await create(bob.AccessToken!, { title: "Bob event" });
    assert.equal(bobEvent.errors, undefined, JSON.stringify(bobEvent));
    assert.equal((await aliceSocket.next("data", "alice")).payload.data.onCreateTodo.id, aliceEvent.data.createTodo.id);
    assert.equal((await bobSocket.next("data", "bob")).payload.data.onCreateTodo.id, bobEvent.data.createTodo.id);
    assert.equal((await bobSocket.next("data", "explicit")).payload.data.onCreateTodo.id, bobEvent.data.createTodo.id);
    assert.equal(aliceSocket.messages.filter(message => message.type === "data").length, 0);
    assert.equal(bobSocket.messages.filter(message => message.type === "data").length, 0);
    const reconnect = new RealtimeClient(api.uris!.REALTIME!, headers(bob.AccessToken!)); sockets.push(reconnect); await reconnect.open();
    reconnect.start("bob-reconnected", subscription); await reconnect.next("start_ack", "bob-reconnected");
    const deleted = await run(alice.AccessToken!, remove, { input: { id: aliceId } });
    assert.equal(deleted.errors, undefined, JSON.stringify(deleted));
    assert.equal(deleted.data.deleteTodo.id, aliceId);
    const expiring = aliceSocket.next("error", "alice");
    h.clock.advance(5 * 60_000);
    h.cognito.config.systemClockOffset = h.clock.now() - Date.now();
    assert.equal((await expiring).payload.errors[0].errorType, "UnauthorizedException");
    assert.equal((await graphql(endpoint, alice.AccessToken!, "{ listTodos { items { id } } }")).status, 401);
    const freshBob = await h.signIn("bob@example.test");
    const freshSocket = new RealtimeClient(api.uris!.REALTIME!, headers(freshBob.AccessToken!)); sockets.push(freshSocket); await freshSocket.open();
    freshSocket.start("fresh", subscription); await freshSocket.next("start_ack", "fresh");
    const freshEvent = await create(freshBob.AccessToken!, { title: "New Bob session" });
    assert.equal((await freshSocket.next("data", "fresh")).payload.data.onCreateTodo.id, freshEvent.data.createTodo.id);
    const persisted = await readFile(join(h.root, "state.json"), "utf8");
    for (const token of [alice.AccessToken!, bob.AccessToken!, freshBob.AccessToken!]) assert(!persisted.includes(token));
  } finally { for (const socket of sockets) socket.close(); await h.stop(); }
});
