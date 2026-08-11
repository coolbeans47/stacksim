import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { SignatureV4 } from "@smithy/signature-v4";
import {
  AppSyncClient, CreateApiKeyCommand, CreateDataSourceCommand, CreateFunctionCommand,
  CreateGraphqlApiCommand, CreateResolverCommand, DeleteApiKeyCommand, DeleteGraphqlApiCommand, GetSchemaCreationStatusCommand, StartSchemaCreationCommand,
  UpdateFunctionCommand,
} from "@aws-sdk/client-appsync";
import { CreateTableCommand, DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { CreateAccessKeyCommand, CreateRoleCommand, CreateUserCommand, IAMClient, PutRolePolicyCommand, PutUserPolicyCommand } from "@aws-sdk/client-iam";
import WebSocket from "ws";
import { APPSYNC_REALTIME_LIMITS } from "../src/appsync.js";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const fixture = resolve("test/fixtures/amplify-gen2-data");
const evidence = join(fixture, "evidence");
const assets = join(evidence, "assets");
const generatedFields = new Set(["getTodo", "listTodos", "createTodo", "updateTodo", "deleteTodo", "onCreateTodo", "onUpdateTodo", "onDeleteTodo"]);

class Sha256 {
  private value: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  constructor(private readonly secret?: string | Buffer) { this.value = secret ? createHmac("sha256", secret) : createHash("sha256"); }
  update(data: string | Uint8Array): void { this.value.update(data); }
  async digest(): Promise<Uint8Array> { return this.value.digest(); }
  reset(): void { this.value = this.secret ? createHmac("sha256", this.secret) : createHash("sha256"); }
}

function policy(actions: string[], resources: string | string[]): string {
  return JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: actions, Resource: resources }] });
}

function s3Asset(value: unknown): string | undefined {
  if (typeof value === "string") return value.match(/\/([0-9a-f]{64}\.vtl)$/)?.[1];
  if (value && typeof value === "object" && "Fn::Sub" in value) return s3Asset((value as any)["Fn::Sub"]);
  return undefined;
}

function resolveIntrinsic(value: any, refs: Record<string, string>, getAtt: Record<string, Record<string, string>>): any {
  if (Array.isArray(value)) return value.map(item => resolveIntrinsic(item, refs, getAtt));
  if (!value || typeof value !== "object") return value;
  if (value.Ref) return refs[value.Ref];
  if (value["Fn::GetAtt"]) { const [logicalId, attribute] = value["Fn::GetAtt"]; return getAtt[logicalId]?.[attribute]; }
  if (value["Fn::Join"]) { const [separator, values] = value["Fn::Join"]; return values.map((item: any) => resolveIntrinsic(item, refs, getAtt)).join(separator); }
  if (value["Fn::Split"]) { const [separator, source] = value["Fn::Split"]; return String(resolveIntrinsic(source, refs, getAtt)).split(separator); }
  if (value["Fn::Select"]) { const [index, values] = value["Fn::Select"]; return resolveIntrinsic(values, refs, getAtt)[Number(index)]; }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveIntrinsic(item, refs, getAtt)]));
}

interface Harness {
  root: string;
  clock: TestClock;
  simulator: StackSim;
  appsync: AppSyncClient;
  dynamodb: DynamoDBClient;
  iam: IAMClient;
  apiId: string;
  graphqlEndpoint: string;
  realtimeEndpoint: string;
  apiKey: string;
  tableName: string;
  modelIntrospection: any;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx08-"));
  const clock = new TestClock(Date.now());
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce", cdkBootstrap: false });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const appsync = new AppSyncClient({ endpoint, region, credentials, maxAttempts: 1 });
  const dynamodb = new DynamoDBClient({ endpoint, region, credentials, maxAttempts: 1 });
  const iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
  const todo = JSON.parse(await readFile(join(evidence, "templates/todo.json"), "utf8"));
  const schema = await readFile(join(assets, "941821462168d0c1c15b579e764e675a5ed57595aa8875d0c10071b408b77513.graphql"));
  const api = (await appsync.send(new CreateGraphqlApiCommand({
    name: "amx08-generated-todo", authenticationType: "API_KEY",
    additionalAuthenticationProviders: [{ authenticationType: "AWS_IAM" }],
  }))).graphqlApi!;
  await appsync.send(new StartSchemaCreationCommand({ apiId: api.apiId, definition: schema }));
  assert.equal((await appsync.send(new GetSchemaCreationStatusCommand({ apiId: api.apiId }))).status, "SUCCESS");
  const tableName = `Todo-${api.apiId}-NONE`;
  const tableArn = `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`;
  await dynamodb.send(new CreateTableCommand({
    TableName: tableName, BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
  }));
  await waitForTableActive(dynamodb, tableName, clock);
  const roleName = "amx08-todo-data";
  const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
  await iam.send(new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "appsync.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  await iam.send(new PutRolePolicyCommand({ RoleName: roleName, PolicyName: "DynamoDBAccess", PolicyDocument: policy([
    "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:GetItem",
    "dynamodb:Scan", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem", "dynamodb:DescribeTable",
  ], [tableArn, `${tableArn}/*`]) }));
  await appsync.send(new CreateDataSourceCommand({ apiId: api.apiId, name: "NONE_DS", type: "NONE" }));
  await appsync.send(new CreateDataSourceCommand({ apiId: api.apiId, name: "TodoTable", type: "AMAZON_DYNAMODB", serviceRoleArn: roleArn, dynamodbConfig: { tableName, awsRegion: region, useCallerCredentials: false, versioned: false } }));
  const externalApiRef = Object.keys(todo.Parameters).find((name: string) => name.endsWith("GraphQLAPI21884E71ApiId"))!;
  const externalNoneRef = Object.keys(todo.Parameters).find((name: string) => name.endsWith("GraphQLAPINONEDSEC2D1B67Name"))!;
  const refs: Record<string, string> = { [externalApiRef]: api.apiId!, [externalNoneRef]: "NONE_DS", "AWS::Region": region };
  const getAtt: Record<string, Record<string, string>> = { TodoTable: { TableArn: tableArn }, TodoDataSource: { Name: "TodoTable" } };
  for (const [logicalId, resource] of Object.entries<any>(todo.Resources)) {
    if (resource.Type !== "AWS::AppSync::FunctionConfiguration") continue;
    const name = String(resource.Properties.Name);
    if (![...generatedFields].some(field => name.toLowerCase().includes(field.toLowerCase()))) continue;
    const requestAsset = s3Asset(resource.Properties.RequestMappingTemplateS3Location);
    const responseAsset = s3Asset(resource.Properties.ResponseMappingTemplateS3Location);
    const created = (await appsync.send(new CreateFunctionCommand({
      apiId: api.apiId, name, dataSourceName: resolveIntrinsic(resource.Properties.DataSourceName, refs, getAtt), functionVersion: "2018-05-29",
      requestMappingTemplate: requestAsset ? await readFile(join(assets, requestAsset), "utf8") : resource.Properties.RequestMappingTemplate,
      responseMappingTemplate: responseAsset ? await readFile(join(assets, responseAsset), "utf8") : resource.Properties.ResponseMappingTemplate,
    }))).functionConfiguration!;
    getAtt[logicalId] = { FunctionId: created.functionId! };
  }
  for (const resource of Object.values<any>(todo.Resources)) {
    if (resource.Type !== "AWS::AppSync::Resolver" || !generatedFields.has(resource.Properties.FieldName)) continue;
    await appsync.send(new CreateResolverCommand({
      apiId: api.apiId, typeName: resource.Properties.TypeName, fieldName: resource.Properties.FieldName, kind: "PIPELINE",
      pipelineConfig: { functions: resolveIntrinsic(resource.Properties.PipelineConfig.Functions, refs, getAtt) },
      requestMappingTemplate: resolveIntrinsic(resource.Properties.RequestMappingTemplate, refs, getAtt), responseMappingTemplate: resource.Properties.ResponseMappingTemplate,
    }));
  }
  const apiKey = (await appsync.send(new CreateApiKeyCommand({ apiId: api.apiId }))).apiKey!.id!;
  const modelIntrospection = JSON.parse(await readFile(join(assets, "5c0312441b16a7cf32bb8e3252a08bd1889a860bba81f5fa32c1053ec5371509-modelIntrospectionSchema.json"), "utf8"));
  return { root, clock, simulator, appsync, dynamodb, iam, apiId: api.apiId!, graphqlEndpoint: api.uris!.GRAPHQL!, realtimeEndpoint: api.uris!.REALTIME!, apiKey, tableName, modelIntrospection };
}

async function stopHarness(harness: Harness): Promise<void> {
  harness.appsync.destroy(); harness.dynamodb.destroy(); harness.iam.destroy();
  await harness.simulator.stop();
  await rm(harness.root, { recursive: true, force: true });
}

async function waitForRealtimeDisconnect(harness: Harness, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (harness.simulator.appsync.realtimeDiagnostics().connections > 0 && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

function amzDate(time: number): string { return new Date(time).toISOString().replace(/[:-]|\.\d{3}/g, ""); }
function apiKeyHeaders(harness: Harness, apiKey = harness.apiKey): Record<string, string> {
  return { host: new URL(harness.graphqlEndpoint).host, "x-amz-date": amzDate(harness.clock.now()), "x-api-key": apiKey };
}

class RealtimeClient {
  readonly socket: WebSocket;
  private readonly messages: any[] = [];
  private readonly waiters: Array<() => void> = [];
  constructor(endpoint: string, headers: Record<string, string>, encoding: "subprotocol" | "query" = "subprotocol") {
    const encoded = Buffer.from(JSON.stringify(headers), "utf8").toString("base64url");
    const target = new URL(endpoint);
    if (encoding === "query") {
      target.searchParams.set("header", encoded);
      target.searchParams.set("payload", Buffer.from("{}", "utf8").toString("base64url"));
    }
    this.socket = new WebSocket(target, encoding === "query" ? ["graphql-ws"] : ["graphql-ws", `header-${encoded}`]);
    this.socket.on("message", data => { this.messages.push(JSON.parse(data.toString())); this.waiters.splice(0).forEach(resolve => resolve()); });
  }
  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => { this.socket.once("open", resolve); this.socket.once("error", reject); });
  }
  send(value: unknown): void { this.socket.send(JSON.stringify(value)); }
  async next(type: string, id?: string, timeoutMs = 10000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const index = this.messages.findIndex(message => message.type === type && (id === undefined || message.id === id));
      if (index >= 0) return this.messages.splice(index, 1)[0];
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${type}${id ? `:${id}` : ""}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), remaining);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }
  close(): void { this.socket.close(); }
  closed(): Promise<{ code: number; reason: string }> {
    return new Promise(resolve => this.socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  }
}

async function graphql(harness: Harness, query: string, variables?: Record<string, unknown>): Promise<any> {
  const response = await fetch(harness.graphqlEndpoint, { method: "POST", headers: { "content-type": "application/json", "x-api-key": harness.apiKey }, body: JSON.stringify({ query, ...(variables ? { variables } : {}) }) });
  assert.equal(response.status, 200);
  return response.json();
}

async function register(client: RealtimeClient, harness: Harness, id: string, query: string, variables: Record<string, unknown> = {}, operationName?: string): Promise<void> {
  const data = JSON.stringify({ query, variables, ...(operationName ? { operationName } : {}) });
  client.send({ id, type: "start", payload: { data, extensions: { authorization: apiKeyHeaders(harness) } } });
  await client.next("start_ack", id);
}

async function updateGeneratedFunction(harness: Harness, name: string, changes: { requestMappingTemplate?: string; responseMappingTemplate?: string }): Promise<void> {
  const api = harness.simulator.store.regionState(region).appsync.graphqlApis[harness.apiId];
  const fn = Object.values(api.functions).find(candidate => candidate.name === name)!;
  await harness.appsync.send(new UpdateFunctionCommand({
    apiId: harness.apiId,
    functionId: fn.functionId,
    name: fn.name,
    dataSourceName: fn.dataSourceName,
    functionVersion: "2018-05-29",
    requestMappingTemplate: changes.requestMappingTemplate ?? fn.requestMappingTemplate,
    responseMappingTemplate: changes.responseMappingTemplate ?? fn.responseMappingTemplate,
  }));
}

async function iamHeaders(harness: Harness, signedCredentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }, canonicalSuffix: string, body: string): Promise<Record<string, string>> {
  const url = new URL(`${harness.graphqlEndpoint}${canonicalSuffix}`);
  const signer = new SignatureV4({ credentials: signedCredentials, region, service: "appsync", sha256: Sha256 as any, applyChecksum: true });
  const signed = await signer.sign({
    method: "POST", protocol: url.protocol, hostname: url.hostname, port: Number(url.port), path: url.pathname,
    headers: { host: url.host, accept: "application/json, text/javascript", "content-encoding": "amz-1.0", "content-type": "application/json; charset=UTF-8" }, body,
  }, { signingDate: new Date(harness.clock.now()) });
  return Object.fromEntries(Object.entries(signed.headers).map(([name, value]) => [name, String(value)]));
}

test("AMX-08 raw AppSync realtime protocol delivers selected generated events and isolates stop, filters, and direct DynamoDB writes", async () => {
  const harness = await createHarness();
  const client = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
  let queryEncoded: RealtimeClient | undefined;
  try {
    assert.equal(harness.realtimeEndpoint, harness.graphqlEndpoint.replace(/^http:/, "ws:") + "/realtime");
    const headerOnly = `header-${Buffer.from(JSON.stringify(apiKeyHeaders(harness)), "utf8").toString("base64url")}`;
    const unsupportedProtocol = new WebSocket(harness.realtimeEndpoint, [headerOnly]);
    await assert.rejects(new Promise<void>((resolve, reject) => {
      unsupportedProtocol.once("open", resolve);
      unsupportedProtocol.once("error", reject);
    }));
    queryEncoded = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness), "query");
    await queryEncoded.open();
    assert.equal(queryEncoded.socket.protocol, "graphql-ws");
    queryEncoded.send({ type: "connection_init" });
    await queryEncoded.next("connection_ack");
    queryEncoded.close();
    await client.open();
    assert.equal(client.socket.protocol, "graphql-ws");
    client.send({ type: "connection_init" });
    assert.deepEqual(await client.next("connection_ack"), { type: "connection_ack", payload: { connectionTimeoutMs: 300000 } });
    assert.deepEqual(await client.next("ka"), { type: "ka" });
    const subscription = `subscription Wanted($filter: ModelSubscriptionTodoFilterInput) {
      event: onCreateTodo(filter: $filter) { ...TodoFields }
    }
    fragment TodoFields on Todo { aliasId: id title priority dueAt }`;
    await register(client, harness, "wanted", subscription, { filter: { and: [{ title: { beginsWith: "wanted" } }, { priority: { ge: 2 } }] } });
    await register(client, harness, "filtered", `subscription { onCreateTodo(filter: { title: { eq: "never" } }) { id title } }`);
    const duplicateData = JSON.stringify({ query: subscription, variables: { filter: { title: { beginsWith: "wanted" } } } });
    client.send({ id: "wanted", type: "start", payload: { data: duplicateData, extensions: { authorization: apiKeyHeaders(harness) } } });
    assert.equal((await client.next("error", "wanted")).payload.errors[0].errorType, "ConflictException");
    const created = await graphql(harness, `mutation { createTodo(input: { title: "wanted-one", priority: 3 }) { id title priority dueAt createdAt updatedAt } }`);
    assert.equal(created.errors, undefined);
    const event = await client.next("data", "wanted");
    assert.deepEqual(event.payload.data.event, { aliasId: created.data.createTodo.id, title: "wanted-one", priority: 3, dueAt: null });
    await assert.rejects(client.next("data", "filtered", 150));
    await harness.dynamodb.send(new PutItemCommand({ TableName: harness.tableName, Item: { id: { S: "direct" }, title: { S: "wanted-direct" } } }));
    await assert.rejects(client.next("data", "wanted", 150));
    client.send({ id: "wanted", type: "stop" });
    assert.deepEqual(await client.next("complete", "wanted"), { id: "wanted", type: "complete" });
    await graphql(harness, `mutation { createTodo(input: { title: "wanted-two", priority: 4 }) { id title priority dueAt createdAt updatedAt } }`);
    await assert.rejects(client.next("data", "wanted", 150));
    await register(client, harness, "completion", `subscription { onCreateTodo { id title dueAt } }`);
    await graphql(harness, `mutation { createTodo(input: { title: "selection-source" }) { id createdAt updatedAt } }`);
    const completion = await client.next("data", "completion");
    assert.equal(completion.payload.data.onCreateTodo, null);
    assert.deepEqual(completion.payload.errors[0].path, ["onCreateTodo", "title"]);
    await register(client, harness, "selected-operation", `
      subscription CreateOperation { onCreateTodo { id title } }
      subscription UpdateOperation { updateAlias: onUpdateTodo { id title } }
    `, {}, "UpdateOperation");
    await graphql(harness, `mutation { createTodo(input: { title: "operation-selection" }) { id title createdAt updatedAt } }`);
    await assert.rejects(client.next("data", "selected-operation", 150));
    assert.equal(harness.simulator.appsync.realtimeDiagnostics().registrations, 3);
  } finally { queryEncoded?.close(); client.close(); await stopHarness(harness); }
});

test("AMX-08 initialization, keepalive, idle, message, and registration limits fail at their frozen boundaries", async () => {
  const harness = await createHarness();
  let uninitialized: RealtimeClient | undefined;
  let idle: RealtimeClient | undefined;
  let bounded: RealtimeClient | undefined;
  try {
    uninitialized = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
    await uninitialized.open();
    const initClosed = uninitialized.closed();
    harness.clock.advance(APPSYNC_REALTIME_LIMITS.initializationMs - 1);
    assert.equal(harness.simulator.appsync.realtimeDiagnostics().connections, 1);
    harness.clock.advance(1);
    assert.deepEqual(await initClosed, { code: 4408, reason: "Connection initialisation timeout" });

    idle = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
    await idle.open(); idle.send({ type: "connection_init" }); await idle.next("connection_ack"); await idle.next("ka");
    harness.clock.advance(APPSYNC_REALTIME_LIMITS.keepAliveMs);
    await idle.next("ka");
    const idleClosed = idle.closed();
    harness.clock.advance(APPSYNC_REALTIME_LIMITS.idleMs - APPSYNC_REALTIME_LIMITS.keepAliveMs - 1);
    assert.equal(harness.simulator.appsync.realtimeDiagnostics().connections, 1);
    harness.clock.advance(1);
    assert.deepEqual(await idleClosed, { code: 1001, reason: "Connection idle timeout" });

    bounded = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
    await bounded.open(); bounded.send({ type: "connection_init" }); await bounded.next("connection_ack");
    const prefix = '{"type":"stop","id":"';
    const suffix = '"}';
    const exact = prefix + "x".repeat(APPSYNC_REALTIME_LIMITS.incomingMessageBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
    assert.equal(Buffer.byteLength(exact), APPSYNC_REALTIME_LIMITS.incomingMessageBytes);
    bounded.socket.send(exact);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.simulator.appsync.realtimeDiagnostics().connections, 1);
    const messageClosed = bounded.closed();
    bounded.socket.send(prefix + "x".repeat(APPSYNC_REALTIME_LIMITS.incomingMessageBytes + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix);
    assert.deepEqual(await messageClosed, { code: 4400, reason: "Invalid realtime message" });

    bounded = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
    await bounded.open(); bounded.send({ type: "connection_init" }); await bounded.next("connection_ack");
    const query = `subscription { onCreateTodo { id title } }`;
    for (let index = 0; index < APPSYNC_REALTIME_LIMITS.registrationsPerConnection; index++) {
      await register(bounded, harness, `registration-${index}`, query);
    }
    const data = JSON.stringify({ query, variables: {} });
    bounded.send({ id: "one-too-many", type: "start", payload: { data, extensions: { authorization: apiKeyHeaders(harness) } } });
    assert.equal((await bounded.next("error", "one-too-many")).payload.errors[0].errorType, "LimitExceededException");
    bounded.send({ id: "registration-0", type: "stop" });
    await bounded.next("complete", "registration-0");
    await register(bounded, harness, "replacement-at-boundary", query);
  } finally { uninitialized?.close(); idle?.close(); bounded?.close(); await stopHarness(harness); }
});

test("AMX-08 unmodified Amplify 6.20 generated client receives Todo create, update, and delete subscriptions", async () => {
  const harness = await createHarness();
  const subscriptions: Array<{ unsubscribe(): void }> = [];
  const originalSetTimeout = globalThis.setTimeout;
  try {
    // Amplify 6.20 leaves its 15-second connection-init watchdog referenced after receiving the ACK.
    // Keep the watchdog behavior, but do not let that dependency-owned timer hold the Node test worker open.
    globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      const handle = originalSetTimeout(callback, delay, ...args);
      if (delay === 15_000 && typeof handle === "object" && "unref" in handle) handle.unref();
      return handle;
    }) as typeof globalThis.setTimeout;
    const requireFromFixture = createRequire(join(fixture, "package.json"));
    const { Amplify } = requireFromFixture("aws-amplify") as any;
    const { generateClient } = requireFromFixture("aws-amplify/data") as any;
    Amplify.configure({ API: { GraphQL: {
      endpoint: harness.graphqlEndpoint.replace(/^http:/, "ws:"), region, defaultAuthMode: "apiKey",
      apiKey: harness.apiKey, modelIntrospection: harness.modelIntrospection,
    } } });
    const client = generateClient();
    const received: Record<string, any[]> = { create: [], update: [], delete: [] };
    const subscriptionErrors: unknown[] = [];
    const done: Record<string, Array<() => void>> = { create: [], update: [], delete: [] };
    for (const [name, method] of [["create", "onCreate"], ["update", "onUpdate"], ["delete", "onDelete"]] as const) {
      subscriptions.push(client.models.Todo[method]().subscribe({
        next(value: any) { received[name].push(value); done[name].splice(0).forEach(resolve => resolve()); },
        error(error: unknown) { subscriptionErrors.push(error); },
      }));
    }
    const deadline = Date.now() + 5000;
    while (harness.simulator.appsync.realtimeDiagnostics().registrations !== 3) {
      if (Date.now() > deadline) throw new Error(`Amplify subscriptions did not register: ${JSON.stringify({ subscriptionErrors, diagnostics: harness.simulator.appsync.realtimeDiagnostics() })}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    globalThis.setTimeout = originalSetTimeout;
    const wait = (name: string) => received[name].length ? Promise.resolve() : new Promise<void>(resolve => done[name].push(resolve));
    const created = (await graphql(harness, `mutation { createTodo(input: { title: "client-live" }) { id title description priority completed dueAt createdAt updatedAt __typename } }`)).data.createTodo;
    await wait("create");
    await graphql(harness, `mutation { updateTodo(input: { id: "${created.id}", title: "client-live-updated" }) { id title description priority completed dueAt createdAt updatedAt __typename } }`);
    await wait("update");
    await graphql(harness, `mutation { deleteTodo(input: { id: "${created.id}" }) { id title description priority completed dueAt createdAt updatedAt __typename } }`);
    await wait("delete");
    assert.equal(received.create[0].title, "client-live");
    assert.equal(received.update[0].title, "client-live-updated");
    assert.equal(received.delete[0].id, created.id);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    subscriptions.forEach(subscription => subscription.unsubscribe());
    await waitForRealtimeDisconnect(harness);
    await stopHarness(harness);
  }
});

test("AMX-08 signed IAM registration and delivery reauthorization obey field policies without affecting API-key subscribers", async () => {
  const harness = await createHarness();
  let iamClient: RealtimeClient | undefined;
  let apiClient: RealtimeClient | undefined;
  let implicitClient: RealtimeClient | undefined;
  try {
    await harness.iam.send(new CreateUserCommand({ UserName: "realtime-user" }));
    const access = (await harness.iam.send(new CreateAccessKeyCommand({ UserName: "realtime-user" }))).AccessKey!;
    const signedCredentials = { accessKeyId: access.AccessKeyId!, secretAccessKey: access.SecretAccessKey! };
    const fieldArn = `arn:aws:appsync:${region}:${accountId}:apis/${harness.apiId}/types/Subscription/fields/onCreateTodo`;
    await harness.iam.send(new PutUserPolicyCommand({ UserName: "realtime-user", PolicyName: "Realtime", PolicyDocument: policy(["appsync:GraphQL"], fieldArn) }));
    iamClient = new RealtimeClient(harness.realtimeEndpoint, await iamHeaders(harness, signedCredentials, "/connect", "{}"));
    apiClient = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
    await Promise.all([iamClient.open(), apiClient.open()]);
    iamClient.send({ type: "connection_init" }); apiClient.send({ type: "connection_init" });
    await Promise.all([iamClient.next("connection_ack"), apiClient.next("connection_ack")]);
    const query = `subscription { onCreateTodo { id title } }`;
    const data = JSON.stringify({ query, variables: {} });
    iamClient.send({ id: "iam", type: "start", payload: { data, extensions: { authorization: await iamHeaders(harness, signedCredentials, "", data) } } });
    await iamClient.next("start_ack", "iam");
    await register(apiClient, harness, "key", query);
    apiClient.send({ id: "cross-mode", type: "start", payload: { data, extensions: { authorization: await iamHeaders(harness, signedCredentials, "", data) } } });
    assert.equal((await apiClient.next("error", "cross-mode")).payload.errors[0].errorType, "UnauthorizedException");
    await graphql(harness, `mutation { createTodo(input: { title: "both" }) { id title createdAt updatedAt } }`);
    assert.equal((await iamClient.next("data", "iam")).payload.data.onCreateTodo.title, "both");
    assert.equal((await apiClient.next("data", "key")).payload.data.onCreateTodo.title, "both");
    await harness.iam.send(new PutUserPolicyCommand({ UserName: "realtime-user", PolicyName: "Realtime", PolicyDocument: JSON.stringify({
      Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "appsync:GraphQL", Resource: fieldArn }],
    }) }));
    await graphql(harness, `mutation { createTodo(input: { title: "key-only" }) { id title createdAt updatedAt } }`);
    assert.equal((await apiClient.next("data", "key")).payload.data.onCreateTodo.title, "key-only");
    assert.equal((await iamClient.next("error", "iam")).payload.errors[0].errorType, "UnauthorizedException");
    assert.deepEqual(await iamClient.next("complete", "iam"), { id: "iam", type: "complete" });

    await harness.iam.send(new CreateUserCommand({ UserName: "implicit-realtime-user" }));
    const implicitAccess = (await harness.iam.send(new CreateAccessKeyCommand({ UserName: "implicit-realtime-user" }))).AccessKey!;
    const implicitCredentials = { accessKeyId: implicitAccess.AccessKeyId!, secretAccessKey: implicitAccess.SecretAccessKey! };
    implicitClient = new RealtimeClient(harness.realtimeEndpoint, await iamHeaders(harness, implicitCredentials, "/connect", "{}"));
    await implicitClient.open(); implicitClient.send({ type: "connection_init" }); await implicitClient.next("connection_ack");
    implicitClient.send({ id: "implicit-deny", type: "start", payload: { data, extensions: { authorization: await iamHeaders(harness, implicitCredentials, "", data) } } });
    assert.equal((await implicitClient.next("error", "implicit-deny")).payload.errors[0].errorType, "AccessDeniedException");
    iamClient.send({ id: "cross-principal", type: "start", payload: { data, extensions: { authorization: await iamHeaders(harness, implicitCredentials, "", data) } } });
    assert.equal((await iamClient.next("error", "cross-principal")).payload.errors[0].errorType, "UnauthorizedException");
  } finally { iamClient?.close(); apiClient?.close(); implicitClient?.close(); await stopHarness(harness); }
});

test("AMX-08 injected registration, queue, socket, and mutation-completion boundaries preserve a healthy connection", async () => {
  const harness = await createHarness();
  const slow = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
  let healthy: RealtimeClient | undefined;
  try {
    await slow.open(); slow.send({ type: "connection_init" }); await slow.next("connection_ack");
    const slowConnectionId = harness.simulator.appsync.realtimeDiagnostics().signals.filter(signal => signal.signal === "connection-admit").at(-1)!.connectionId;
    healthy = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
    await healthy.open(); healthy.send({ type: "connection_init" }); await healthy.next("connection_ack");
    const query = `subscription { onCreateTodo { id title } }`;
    harness.simulator.appsync.setRealtimeFaultInjector(stage => stage === "registration-admission");
    const rejectedData = JSON.stringify({ query, variables: {} });
    slow.send({ id: "rejected", type: "start", payload: { data: rejectedData, extensions: { authorization: apiKeyHeaders(harness) } } });
    assert.equal((await slow.next("error", "rejected")).payload.errors[0].errorType, "InternalFailure");
    harness.simulator.appsync.setRealtimeFaultInjector(undefined);
    await register(slow, harness, "queue-fault", query);
    await register(healthy, harness, "healthy", query);

    let queueFault = true;
    harness.simulator.appsync.setRealtimeFaultInjector((stage, context) => {
      if (stage === "queueing" && context.connectionId === slowConnectionId && queueFault) { queueFault = false; return true; }
      return false;
    });
    const queueFailureMutation = await graphql(harness, `mutation { createTodo(input: { title: "queue-boundary-failure" }) { id title createdAt updatedAt } }`);
    assert.equal(queueFailureMutation.errors, undefined);
    assert.equal((await slow.next("error", "queue-fault")).payload.errors[0].errorType, "InternalFailure");
    assert.deepEqual(await slow.next("complete", "queue-fault"), { id: "queue-fault", type: "complete" });
    assert.equal((await healthy.next("data", "healthy")).payload.data.onCreateTodo.title, "queue-boundary-failure");

    await register(slow, harness, "send-fault", query);
    let sendFault = true;
    harness.simulator.appsync.setRealtimeFaultInjector((stage, context) => {
      if (stage === "socket-send" && context.connectionId === slowConnectionId && sendFault) { sendFault = false; return true; }
      return false;
    });
    const sendFailureMutation = await graphql(harness, `mutation { createTodo(input: { title: "socket-boundary-failure" }) { id title createdAt updatedAt } }`);
    assert.equal(sendFailureMutation.errors, undefined);
    assert.equal((await healthy.next("data", "healthy")).payload.data.onCreateTodo.title, "socket-boundary-failure");
    await assert.rejects(slow.next("data", "send-fault", 150));
    assert.ok(harness.simulator.appsync.realtimeDiagnostics().signals.some(signal => signal.signal === "socket-delivery-failure"));

    harness.simulator.appsync.setRealtimeFaultInjector(stage => stage === "mutation-completion");
    const committed = await graphql(harness, `mutation { createTodo(input: { title: "lost-after-commit" }) { id title createdAt updatedAt } }`);
    assert.equal(committed.errors, undefined);
    await assert.rejects(healthy.next("data", "healthy", 150));
    harness.simulator.appsync.setRealtimeFaultInjector(undefined);
    await graphql(harness, `mutation { createTodo(input: { title: "still-healthy" }) { id title createdAt updatedAt } }`);
    assert.equal((await healthy.next("data", "healthy")).payload.data.onCreateTodo.title, "still-healthy");
  } finally { harness.simulator.appsync.setRealtimeFaultInjector(undefined); slow.close(); healthy?.close(); await stopHarness(harness); }
});

test("AMX-08 per-registration queue overflow drops only that slow registration at the exact message boundary", async () => {
  const harness = await createHarness();
  const slow = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
  let healthy: RealtimeClient | undefined;
  try {
    await slow.open(); slow.send({ type: "connection_init" }); await slow.next("connection_ack");
    const slowConnectionId = harness.simulator.appsync.realtimeDiagnostics().signals.filter(signal => signal.signal === "connection-admit").at(-1)!.connectionId;
    healthy = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
    await healthy.open(); healthy.send({ type: "connection_init" }); await healthy.next("connection_ack");
    const query = `subscription { onCreateTodo { id title } }`;
    await register(slow, harness, "slow", query);
    await register(healthy, harness, "healthy", query);
    let stalled = false;
    harness.simulator.appsync.setRealtimeFaultInjector((stage, context) => {
      if (stage === "socket-send" && context.connectionId === slowConnectionId && !stalled) { stalled = true; return "stall"; }
      return false;
    });
    for (let index = 0; index < APPSYNC_REALTIME_LIMITS.registrationQueueMessages + 2; index++) {
      const result = await graphql(harness, `mutation { createTodo(input: { title: "queued-${index}" }) { id title createdAt updatedAt } }`);
      assert.equal(result.errors, undefined);
      assert.equal((await healthy.next("data", "healthy")).payload.data.onCreateTodo.title, `queued-${index}`);
    }
    assert.equal((await slow.next("error", "slow")).payload.errors[0].errorType, "LimitExceededException");
    assert.deepEqual(await slow.next("complete", "slow"), { id: "slow", type: "complete" });
    harness.simulator.appsync.setRealtimeFaultInjector(undefined);
    await graphql(harness, `mutation { createTodo(input: { title: "still-healthy-after-registration-overflow" }) { id title createdAt updatedAt } }`);
    assert.equal((await healthy.next("data", "healthy")).payload.data.onCreateTodo.title, "still-healthy-after-registration-overflow");
  } finally { harness.simulator.appsync.setRealtimeFaultInjector(undefined); slow.close(); healthy?.close(); await stopHarness(harness); }
});

test("AMX-08 per-connection queue overflow closes only that slow connection at the exact message boundary", async () => {
  const harness = await createHarness();
  const overloaded = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
  let healthy: RealtimeClient | undefined;
  try {
    await overloaded.open(); overloaded.send({ type: "connection_init" }); await overloaded.next("connection_ack");
    const overloadedConnectionId = harness.simulator.appsync.realtimeDiagnostics().signals.filter(signal => signal.signal === "connection-admit").at(-1)!.connectionId;
    healthy = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
    await healthy.open(); healthy.send({ type: "connection_init" }); await healthy.next("connection_ack");
    const query = `subscription { onCreateTodo { id title } }`;
    for (let index = 0; index < 5; index++) await register(overloaded, harness, `slow-${index}`, query);
    await register(healthy, harness, "healthy", query);
    let stalled = false;
    harness.simulator.appsync.setRealtimeFaultInjector((stage, context) => {
      if (stage === "socket-send" && context.connectionId === overloadedConnectionId && !stalled) { stalled = true; return "stall"; }
      return false;
    });
    for (let index = 0; index < 13; index++) {
      const result = await graphql(harness, `mutation { createTodo(input: { title: "connection-queued-${index}" }) { id title createdAt updatedAt } }`);
      assert.equal(result.errors, undefined);
      assert.equal((await healthy.next("data", "healthy")).payload.data.onCreateTodo.title, `connection-queued-${index}`);
    }
    assert.equal(harness.simulator.appsync.realtimeDiagnostics().connections, 2);
    const closed = overloaded.closed();
    const overflow = await graphql(harness, `mutation { createTodo(input: { title: "connection-overflow" }) { id title createdAt updatedAt } }`);
    assert.equal(overflow.errors, undefined);
    assert.deepEqual(await closed, { code: 1013, reason: "Realtime connection queue limit exceeded" });
    assert.equal((await healthy.next("data", "healthy")).payload.data.onCreateTodo.title, "connection-overflow");
    assert.equal(harness.simulator.appsync.realtimeDiagnostics().connections, 1);
  } finally { harness.simulator.appsync.setRealtimeFaultInjector(undefined); overloaded.close(); healthy?.close(); await stopHarness(harness); }
});

test("AMX-08 response, GraphQL completion, request, and DynamoDB failures emit no model event", async () => {
  const harness = await createHarness();
  let client: RealtimeClient | undefined;
  try {
    const generatedResources = JSON.parse(await readFile(join(evidence, "templates/todo.json"), "utf8")).Resources;
    const generatedFunction = Object.values<any>(generatedResources).find(candidate => candidate.Type === "AWS::AppSync::FunctionConfiguration" && candidate.Properties.Name === "MutationCreateTodoDataResolverFn")!;
    const originalRequest = await readFile(join(assets, s3Asset(generatedFunction.Properties.RequestMappingTemplateS3Location)!), "utf8");
    const originalResponse = await readFile(join(assets, s3Asset(generatedFunction.Properties.ResponseMappingTemplateS3Location)!), "utf8");
    const connect = async (id: string): Promise<RealtimeClient> => {
      const next = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
      await next.open(); next.send({ type: "connection_init" }); await next.next("connection_ack");
      await register(next, harness, id, `subscription { onCreateTodo { id title } }`);
      return next;
    };

    await updateGeneratedFunction(harness, "MutationCreateTodoDataResolverFn", {
      responseMappingTemplate: '#if($ctx.result.id == "response-failure")$util.error("response failed", "ResponseFailure")#end\n$util.toJson($ctx.result)',
    });
    client = await connect("response-failure");
    const responseFailure = await graphql(harness, `mutation { createTodo(input: { id: "response-failure", title: "committed" }) { id title } }`);
    assert.ok(responseFailure.errors?.length);
    assert.equal((await harness.dynamodb.send(new GetItemCommand({ TableName: harness.tableName, Key: { id: { S: "response-failure" } } }))).Item?.title?.S, "committed");
    await assert.rejects(client.next("data", "response-failure", 150));

    const responseClosed = client.closed();
    await updateGeneratedFunction(harness, "MutationCreateTodoDataResolverFn", {
      responseMappingTemplate: "$util.toJson({})",
    });
    assert.deepEqual(await responseClosed, { code: 1012, reason: "AppSync configuration changed" });
    client = await connect("completion-failure");
    const completionFailure = await graphql(harness, `mutation { createTodo(input: { id: "completion-failure", title: "must-null" }) { id title } }`);
    assert.ok(completionFailure.errors?.some((error: any) => error.path?.includes("id") || /non-nullable field Todo\.id/.test(error.message)));
    assert.equal((await harness.dynamodb.send(new GetItemCommand({ TableName: harness.tableName, Key: { id: { S: "completion-failure" } } }))).Item?.title?.S, "must-null");
    await assert.rejects(client.next("data", "completion-failure", 150));

    const completionClosed = client.closed();
    await updateGeneratedFunction(harness, "MutationCreateTodoDataResolverFn", {
      requestMappingTemplate: '#if($ctx.args.input.id == "request-failure")$util.error("request failed", "RequestFailure")#end\n' + originalRequest,
      responseMappingTemplate: originalResponse,
    });
    assert.deepEqual(await completionClosed, { code: 1012, reason: "AppSync configuration changed" });
    client = await connect("request-failure");
    const requestFailure = await graphql(harness, `mutation { createTodo(input: { id: "request-failure", title: "never-written" }) { id title } }`);
    assert.ok(requestFailure.errors?.length);
    assert.equal((await harness.dynamodb.send(new GetItemCommand({ TableName: harness.tableName, Key: { id: { S: "request-failure" } } }))).Item, undefined);
    await assert.rejects(client.next("data", "request-failure", 150));

    const requestClosed = client.closed();
    await updateGeneratedFunction(harness, "MutationCreateTodoDataResolverFn", {
      requestMappingTemplate: originalRequest,
      responseMappingTemplate: originalResponse,
    });
    assert.deepEqual(await requestClosed, { code: 1012, reason: "AppSync configuration changed" });
    client = await connect("dynamodb-failure");
    await graphql(harness, `mutation { createTodo(input: { id: "duplicate", title: "first" }) { id title } }`);
    await client.next("data", "dynamodb-failure");
    const duplicate = await graphql(harness, `mutation { createTodo(input: { id: "duplicate", title: "second" }) { id title } }`);
    assert.ok(duplicate.errors?.length);
    await assert.rejects(client.next("data", "dynamodb-failure", 150));
  } finally { client?.close(); await stopHarness(harness); }
});

test("AMX-08 schema generations close sockets, reconnect without replay, and API deletion closes the replacement", async () => {
  const harness = await createHarness();
  let first = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
  let replacement: RealtimeClient | undefined;
  try {
    await first.open(); first.send({ type: "connection_init" }); await first.next("connection_ack");
    await register(first, harness, "first", `subscription { onCreateTodo { id title } }`);
    await graphql(harness, `mutation { createTodo(input: { title: "before-generation" }) { id title createdAt updatedAt } }`);
    await first.next("data", "first");
    const firstClosed = first.closed();
    const schema = await readFile(join(assets, "941821462168d0c1c15b579e764e675a5ed57595aa8875d0c10071b408b77513.graphql"));
    await harness.appsync.send(new StartSchemaCreationCommand({ apiId: harness.apiId, definition: schema }));
    assert.equal((await harness.appsync.send(new GetSchemaCreationStatusCommand({ apiId: harness.apiId }))).status, "SUCCESS");
    assert.deepEqual(await firstClosed, { code: 1012, reason: "AppSync schema changed" });
    await graphql(harness, `mutation { createTodo(input: { title: "missed" }) { id title createdAt updatedAt } }`);

    replacement = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
    await replacement.open(); replacement.send({ type: "connection_init" }); await replacement.next("connection_ack");
    await register(replacement, harness, "replacement", `subscription { onCreateTodo { id title } }`);
    await assert.rejects(replacement.next("data", "replacement", 150));
    await graphql(harness, `mutation { createTodo(input: { title: "after-generation" }) { id title createdAt updatedAt } }`);
    assert.equal((await replacement.next("data", "replacement")).payload.data.onCreateTodo.title, "after-generation");
    const replacementClosed = replacement.closed();
    await harness.appsync.send(new DeleteGraphqlApiCommand({ apiId: harness.apiId }));
    assert.deepEqual(await replacementClosed, { code: 1012, reason: "AppSync API deleted" });
  } finally { first.close(); replacement?.close(); await stopHarness(harness); }
});

test("AMX-08 wrong, expired, and deleted API keys fail closed while another key remains isolated", async () => {
  const harness = await createHarness();
  const healthy = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
  let deleted: RealtimeClient | undefined;
  try {
    await assert.rejects(new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness, "da2-wrong")).open());

    const expiring = (await harness.appsync.send(new CreateApiKeyCommand({
      apiId: harness.apiId,
      expires: Math.floor(harness.clock.now() / 1000) + 3700,
    }))).apiKey!.id!;
    const removable = (await harness.appsync.send(new CreateApiKeyCommand({ apiId: harness.apiId }))).apiKey!.id!;
    deleted = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness, removable));
    await deleted.open(); deleted.send({ type: "connection_init" }); await deleted.next("connection_ack");
    await healthy.open(); healthy.send({ type: "connection_init" }); await healthy.next("connection_ack");
    await register(healthy, harness, "healthy-key", `subscription { onCreateTodo { id title } }`);
    const deletedClosed = deleted.closed();
    await harness.appsync.send(new DeleteApiKeyCommand({ apiId: harness.apiId, id: removable }));
    assert.deepEqual(await deletedClosed, { code: 1012, reason: "AppSync API key deleted" });
    await assert.rejects(new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness, removable)).open());
    const result = await graphql(harness, `mutation { createTodo(input: { title: "other-key-healthy" }) { id title createdAt updatedAt } }`);
    assert.equal(result.errors, undefined);
    assert.equal((await healthy.next("data", "healthy-key")).payload.data.onCreateTodo.title, "other-key-healthy");

    harness.clock.advance(2 * 60 * 60 * 1000);
    await assert.rejects(new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness, expiring)).open());
  } finally { healthy.close(); deleted?.close(); await stopHarness(harness); }
});

test("AMX-08 shutdown closes sockets and restart reconnects without replay", async () => {
  const harness = await createHarness();
  let first = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
  let replacement: RealtimeClient | undefined;
  try {
    await first.open(); first.send({ type: "connection_init" }); await first.next("connection_ack");
    await register(first, harness, "before-restart", `subscription { onCreateTodo { id title } }`);
    const closed = first.closed();
    const port = harness.simulator.port;
    await harness.simulator.stop();
    assert.deepEqual(await closed, { code: 1012, reason: "Service restart" });

    harness.simulator = new StackSim({ port, invokePort: 0, dataDir: harness.root, region, clock: harness.clock, authMode: "enforce", cdkBootstrap: false });
    await harness.simulator.start();
    await graphql(harness, `mutation { createTodo(input: { title: "missed-during-restart" }) { id title createdAt updatedAt } }`);
    replacement = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
    await replacement.open(); replacement.send({ type: "connection_init" }); await replacement.next("connection_ack");
    await register(replacement, harness, "after-restart", `subscription { onCreateTodo { id title } }`);
    await assert.rejects(replacement.next("data", "after-restart", 150));
    await graphql(harness, `mutation { createTodo(input: { title: "live-after-restart" }) { id title createdAt updatedAt } }`);
    assert.equal((await replacement.next("data", "after-restart")).payload.data.onCreateTodo.title, "live-after-restart");
  } finally { first.close(); replacement?.close(); await stopHarness(harness); }
});

test("AMX-08 realtime diagnostics and durable AppSync state redact documents, variables, payloads, and credentials", async () => {
  const harness = await createHarness();
  const client = new RealtimeClient(harness.realtimeEndpoint, apiKeyHeaders(harness));
  try {
    await client.open(); client.send({ type: "connection_init" }); await client.next("connection_ack");
    const documentSentinel = "SensitiveRealtimeDocumentSentinel";
    const variableSentinel = "SensitiveRealtimeVariableSentinel";
    await register(client, harness, "SensitiveClientRegistrationSentinel", `subscription ${documentSentinel}($filter: ModelSubscriptionTodoFilterInput) { onCreateTodo(filter: $filter) { id title } }`, {
      filter: { title: { eq: variableSentinel } },
    }, documentSentinel);
    const diagnostics = JSON.stringify(harness.simulator.appsync.realtimeDiagnostics());
    const durable = await readFile(join(harness.root, "state.json"), "utf8");
    for (const forbidden of [documentSentinel, variableSentinel, "SensitiveClientRegistrationSentinel", harness.apiKey, "x-api-key", "AWS4-HMAC-SHA256", "Credential=", "Signature="]) {
      assert.equal(diagnostics.includes(forbidden), false, `diagnostics leaked ${forbidden}`);
      assert.equal(durable.includes(forbidden), false, `durable AppSync state leaked ${forbidden}`);
    }
    assert.match(diagnostics, /process-local-no-replay/);
    assert.equal(JSON.parse(durable).accounts[accountId].regions[region].appsync.graphqlApis[harness.apiId].subscriptions, undefined);
  } finally { client.close(); await stopHarness(harness); }
});
