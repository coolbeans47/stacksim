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
  CreateGraphqlApiCommand, CreateResolverCommand, GetSchemaCreationStatusCommand,
  StartSchemaCreationCommand, UpdateFunctionCommand,
} from "@aws-sdk/client-appsync";
import {
  CreateTableCommand, DeleteTableCommand, DynamoDBClient, GetItemCommand, ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const fixture = resolve("test/fixtures/amplify-gen2-data");
const evidence = join(fixture, "evidence");
const assets = join(evidence, "assets");
const generatedFields = new Set(["getTodo", "listTodos", "createTodo", "updateTodo", "deleteTodo"]);
let diagnosticRunning: Awaited<ReturnType<typeof startHarness>> | undefined;

class Sha256 {
  private value: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  constructor(private readonly secret?: string | Buffer) { this.value = secret ? createHmac("sha256", secret) : createHash("sha256"); }
  update(data: string | Uint8Array): void { this.value.update(data); }
  async digest(): Promise<Uint8Array> { return this.value.digest(); }
  reset(): void { this.value = this.secret ? createHmac("sha256", this.secret) : createHash("sha256"); }
}

interface Harness {
  root: string;
  clock: TestClock;
  simulator: StackSim;
  appsync: AppSyncClient;
  dynamodb: DynamoDBClient;
  iam: IAMClient;
  sts: STSClient;
  apiId: string;
  apiArn: string;
  graphqlEndpoint: string;
  apiKey: string;
  tableName: string;
  tableArn: string;
  dataRoleName: string;
  modelIntrospection: any;
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
  if (value["Fn::GetAtt"]) {
    const [logicalId, attribute] = value["Fn::GetAtt"];
    return getAtt[logicalId]?.[attribute];
  }
  if (value["Fn::Join"]) {
    const [separator, values] = value["Fn::Join"];
    return values.map((item: any) => resolveIntrinsic(item, refs, getAtt)).join(separator);
  }
  if (value["Fn::Split"]) {
    const [separator, source] = value["Fn::Split"];
    return String(resolveIntrinsic(source, refs, getAtt)).split(separator);
  }
  if (value["Fn::Select"]) {
    const [index, values] = value["Fn::Select"];
    return resolveIntrinsic(values, refs, getAtt)[Number(index)];
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveIntrinsic(item, refs, getAtt)]));
}

async function startHarness(root: string, clock: TestClock): Promise<Omit<Harness, "apiId" | "apiArn" | "graphqlEndpoint" | "apiKey" | "tableName" | "tableArn" | "dataRoleName" | "modelIntrospection">> {
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, clock, authMode: "enforce", cdkBootstrap: false });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  return {
    root, clock, simulator,
    appsync: new AppSyncClient({ endpoint, region, credentials, maxAttempts: 1 }),
    dynamodb: new DynamoDBClient({ endpoint, region, credentials, maxAttempts: 1 }),
    iam: new IAMClient({ endpoint, region, credentials, maxAttempts: 1 }),
    sts: new STSClient({ endpoint, region, credentials, maxAttempts: 1 }),
  };
}

async function createHarness(root: string, clock: TestClock): Promise<Harness> {
  const running = await startHarness(root, clock);
  diagnosticRunning = running;
  const todo = JSON.parse(await readFile(join(evidence, "templates/todo.json"), "utf8"));
  const schemaAsset = "941821462168d0c1c15b579e764e675a5ed57595aa8875d0c10071b408b77513.graphql";
  const schema = await readFile(join(assets, schemaAsset));
  const api = (await running.appsync.send(new CreateGraphqlApiCommand({
    name: "amx07-generated-todo", authenticationType: "API_KEY",
    additionalAuthenticationProviders: [{ authenticationType: "AWS_IAM" }],
  }))).graphqlApi!;
  await running.appsync.send(new StartSchemaCreationCommand({ apiId: api.apiId, definition: schema }));
  assert.equal((await running.appsync.send(new GetSchemaCreationStatusCommand({ apiId: api.apiId }))).status, "SUCCESS");

  const tableName = `Todo-${api.apiId}-NONE`;
  const tableArn = `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`;
  await running.dynamodb.send(new CreateTableCommand({
    TableName: tableName, BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
  }));
  await waitForTableActive(running.dynamodb, tableName, clock);
  const dataRoleName = "amx07-todo-data";
  const dataRoleArn = `arn:aws:iam::${accountId}:role/${dataRoleName}`;
  await running.iam.send(new CreateRoleCommand({
    RoleName: dataRoleName,
    AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "appsync.amazonaws.com" }, Action: "sts:AssumeRole" }] }),
  }));
  await running.iam.send(new PutRolePolicyCommand({
    RoleName: dataRoleName, PolicyName: "DynamoDBAccess",
    PolicyDocument: policy([
      "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:PutItem", "dynamodb:DeleteItem",
      "dynamodb:GetItem", "dynamodb:Scan", "dynamodb:Query", "dynamodb:UpdateItem",
      "dynamodb:ConditionCheckItem", "dynamodb:DescribeTable", "dynamodb:GetRecords", "dynamodb:GetShardIterator",
    ], [tableArn, `${tableArn}/*`]),
  }));
  await running.appsync.send(new CreateDataSourceCommand({ apiId: api.apiId, name: "NONE_DS", type: "NONE" }));
  await running.appsync.send(new CreateDataSourceCommand({
    apiId: api.apiId, name: "TodoTable", type: "AMAZON_DYNAMODB", serviceRoleArn: dataRoleArn,
    dynamodbConfig: { tableName, awsRegion: region, useCallerCredentials: false, versioned: false },
  }));

  const externalApiRef = Object.keys(todo.Parameters).find((name: string) => name.endsWith("GraphQLAPI21884E71ApiId"))!;
  const externalNoneRef = Object.keys(todo.Parameters).find((name: string) => name.endsWith("GraphQLAPINONEDSEC2D1B67Name"))!;
  const refs: Record<string, string> = { [externalApiRef]: api.apiId!, [externalNoneRef]: "NONE_DS", "AWS::Region": region };
  const getAtt: Record<string, Record<string, string>> = {
    TodoTable: { TableArn: tableArn }, TodoDataSource: { Name: "TodoTable" },
  };
  for (const [logicalId, resource] of Object.entries<any>(todo.Resources)) {
    if (resource.Type !== "AWS::AppSync::FunctionConfiguration") continue;
    const name = resource.Properties.Name as string;
    if (!["QuerygetTodo", "QuerylistTodos", "MutationcreateTodo", "MutationupdateTodo", "MutationdeleteTodo"]
      .some(prefix => name.toLowerCase().startsWith(prefix.toLowerCase()))) continue;
    const requestAsset = s3Asset(resource.Properties.RequestMappingTemplateS3Location);
    const responseAsset = s3Asset(resource.Properties.ResponseMappingTemplateS3Location);
    let created;
    try {
      created = (await running.appsync.send(new CreateFunctionCommand({
        apiId: api.apiId, name,
        dataSourceName: resolveIntrinsic(resource.Properties.DataSourceName, refs, getAtt),
        functionVersion: "2018-05-29",
        requestMappingTemplate: requestAsset ? await readFile(join(assets, requestAsset), "utf8") : resource.Properties.RequestMappingTemplate,
        responseMappingTemplate: responseAsset ? await readFile(join(assets, responseAsset), "utf8") : resource.Properties.ResponseMappingTemplate,
      }))).functionConfiguration!;
    } catch (error) {
      throw new Error(`Failed to admit generated function ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    getAtt[logicalId] = { FunctionId: created.functionId! };
  }
  for (const resource of Object.values<any>(todo.Resources)) {
    if (resource.Type !== "AWS::AppSync::Resolver" || !generatedFields.has(resource.Properties.FieldName)) continue;
    await running.appsync.send(new CreateResolverCommand({
      apiId: api.apiId, typeName: resource.Properties.TypeName, fieldName: resource.Properties.FieldName,
      kind: "PIPELINE",
      pipelineConfig: { functions: resolveIntrinsic(resource.Properties.PipelineConfig.Functions, refs, getAtt) },
      requestMappingTemplate: resolveIntrinsic(resource.Properties.RequestMappingTemplate, refs, getAtt),
      responseMappingTemplate: resource.Properties.ResponseMappingTemplate,
    }));
  }
  const configuredApi = running.simulator.store.regionState(region).appsync.graphqlApis[api.apiId!];
  const createPipeline = configuredApi.resolvers["Mutation.createTodo"].pipelineConfig!.functions
    .map(functionId => configuredApi.functions[functionId]);
  assert.deepEqual(createPipeline.map(fn => [fn.name, fn.dataSourceName]), [
    ["MutationcreateTodoinit0Function", "NONE_DS"],
    ["MutationcreateTodoauth0Function", "NONE_DS"],
    ["MutationcreateTodopostAuth0Function", "NONE_DS"],
    ["MutationCreateTodoDataResolverFn", "TodoTable"],
  ]);
  const apiKey = (await running.appsync.send(new CreateApiKeyCommand({ apiId: api.apiId }))).apiKey!.id!;
  const modelIntrospection = JSON.parse(await readFile(join(assets, "5c0312441b16a7cf32bb8e3252a08bd1889a860bba81f5fa32c1053ec5371509-modelIntrospectionSchema.json"), "utf8"));
  return { ...running, apiId: api.apiId!, apiArn: api.arn!, graphqlEndpoint: api.uris!.GRAPHQL!, apiKey, tableName, tableArn, dataRoleName, modelIntrospection };
}

async function stopHarness(harness: Pick<Harness, "simulator" | "appsync" | "dynamodb" | "iam" | "sts">): Promise<void> {
  harness.appsync.destroy(); harness.dynamodb.destroy(); harness.iam.destroy(); harness.sts.destroy();
  await harness.simulator.stop();
  if (diagnosticRunning?.simulator === harness.simulator) diagnosticRunning = undefined;
}

async function apiKeyGraphql(harness: Harness, query: string, variables?: Record<string, unknown>, operationName?: string): Promise<any> {
  const response = await fetch(harness.graphqlEndpoint, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": harness.apiKey },
    body: JSON.stringify({ query, ...(variables ? { variables } : {}), ...(operationName ? { operationName } : {}) }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  return response.json();
}

async function signedGraphql(harness: Harness, signedCredentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }, query: string): Promise<any> {
  const url = new URL(harness.graphqlEndpoint);
  const body = JSON.stringify({ query });
  const signer = new SignatureV4({ credentials: signedCredentials, region, service: "appsync", sha256: Sha256 as any, applyChecksum: true });
  const signed = await signer.sign({ method: "POST", protocol: url.protocol, hostname: url.hostname, port: Number(url.port), path: url.pathname, headers: { host: url.host, "content-type": "application/json" }, body }, { signingDate: new Date(harness.clock.now()) });
  const response = await fetch(harness.graphqlEndpoint, { method: "POST", headers: signed.headers, body });
  assert.equal(response.status, 200);
  return response.json();
}

async function updateGeneratedFunction(harness: Harness, name: string, changes: { requestMappingTemplate?: string; responseMappingTemplate?: string }): Promise<void> {
  const api = harness.simulator.store.regionState(region).appsync.graphqlApis[harness.apiId];
  const fn = Object.values(api.functions).find(candidate => candidate.name === name)!;
  await harness.appsync.send(new UpdateFunctionCommand({
    apiId: harness.apiId, functionId: fn.functionId, name: fn.name, dataSourceName: fn.dataSourceName,
    functionVersion: "2018-05-29",
    requestMappingTemplate: changes.requestMappingTemplate ?? fn.requestMappingTemplate,
    responseMappingTemplate: changes.responseMappingTemplate ?? fn.responseMappingTemplate,
  }));
}

test("AMX-07 runs the unmodified Amplify 6.20 client through exact generated Todo CRUD and authoritative DynamoDB", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx07-client-"));
  const clock = new TestClock(Date.now());
  let harness: Harness | undefined;
  try {
    harness = await createHarness(root, clock);
    const createdAt = new Date(clock.now()).toISOString();
    const preflight = await fetch(harness.graphqlEndpoint, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-amz-user-agent,x-api-key",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.equal(preflight.headers.get("access-control-allow-methods"), "POST,OPTIONS");
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /x-amz-user-agent/);
    assert.equal(preflight.headers.get("access-control-max-age"), "600");
    const requireFromFixture = createRequire(join(fixture, "package.json"));
    const { Amplify } = requireFromFixture("aws-amplify") as any;
    const { generateClient } = requireFromFixture("aws-amplify/data") as any;
    Amplify.configure({
      API: { GraphQL: {
        endpoint: harness.graphqlEndpoint, region, defaultAuthMode: "apiKey",
        apiKey: harness.apiKey, modelIntrospection: harness.modelIntrospection,
      } },
    });
    const client = generateClient();
    const createdResult = await client.models.Todo.create({ title: "client-created", description: "remove me", priority: 3, completed: false });
    assert.deepEqual(createdResult.errors, undefined);
    const created = createdResult.data;
    assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(created.createdAt, createdAt);
    assert.equal(created.updatedAt, created.createdAt);
    assert.equal(created.dueAt, null);
    assert.deepEqual((await harness.dynamodb.send(new GetItemCommand({ TableName: harness.tableName, Key: { id: { S: created.id } } }))).Item, {
      id: { S: created.id }, title: { S: "client-created" }, description: { S: "remove me" },
      priority: { N: "3" }, completed: { BOOL: false }, __typename: { S: "Todo" },
      createdAt: { S: created.createdAt }, updatedAt: { S: created.updatedAt },
    });
    assert.equal((await client.models.Todo.get({ id: created.id })).data.title, "client-created");

    clock.advance(1_000);
    const updated = (await client.models.Todo.update({ id: created.id, title: "client-updated", description: null })).data;
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.updatedAt, new Date(clock.now()).toISOString());
    assert.equal(updated.description, null);
    assert.equal(updated.priority, 3);
    const direct = (await harness.dynamodb.send(new GetItemCommand({ TableName: harness.tableName, Key: { id: { S: created.id } } }))).Item!;
    assert.equal(direct.description, undefined);
    assert.equal(direct.priority.N, "3");

    const listed = await client.models.Todo.list({ filter: { title: { beginsWith: "client-" } }, limit: 1 });
    assert.deepEqual(listed.errors, undefined);
    assert.deepEqual(listed.data.map((item: any) => item.id), [created.id]);
    assert.equal(listed.nextToken, null);
    assert.equal((await harness.dynamodb.send(new ScanCommand({ TableName: harness.tableName }))).Items?.length, 1);

    assert.equal((await client.models.Todo.delete({ id: created.id })).data.id, created.id);
    assert.equal((await client.models.Todo.get({ id: created.id })).data, null);
    assert.deepEqual((await client.models.Todo.list()).data, []);
  } finally {
    if (harness) await stopHarness(harness).catch(() => undefined); else if (diagnosticRunning) await stopHarness(diagnosticRunning).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("AMX-07 generated Todo GraphQL supports scoped pagination, filters, conditions, completion, and IAM", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx07-graphql-"));
  const clock = new TestClock(Date.now());
  let harness: Harness | undefined;
  try {
    harness = await createHarness(root, clock);
    const create = `mutation Create($input: CreateTodoInput!, $condition: ModelTodoConditionInput) { createTodo(input:$input, condition:$condition) { id title description priority completed createdAt updatedAt } }`;
    const ids: string[] = [];
    for (const [title, priority] of [["alpha", 1], ["beta", 2], ["alphabet", 3]] as const) {
      const result = await apiKeyGraphql(harness, create, { input: { title, priority, completed: false } });
      const stored: any = await harness.dynamodb.send(new ScanCommand({ TableName: harness.tableName }));
      assert.equal(result.errors, undefined, JSON.stringify({ result, stored: stored.Items })); ids.push(result.data.createTodo.id);
      clock.advance(1_000);
    }
    const duplicate = await apiKeyGraphql(harness, create, { input: { id: ids[0], title: "duplicate" } });
    assert.equal(duplicate.data.createTodo, null);
    assert.equal(duplicate.errors[0].extensions.errorType, "MappingTemplate");
    assert.match(duplicate.errors[0].message, /put requires a map/);

    const pageOne = await apiKeyGraphql(harness, `query Page($filter:ModelTodoFilterInput,$limit:Int,$nextToken:String){ alias:listTodos(filter:$filter,limit:$limit,nextToken:$nextToken){ items { ...Fields } nextToken } } fragment Fields on Todo { id title priority }`, { filter: { title: { beginsWith: "alpha" } }, limit: 1 });
    assert.ok(pageOne.data.alias.items.length <= 1); assert.ok(pageOne.data.alias.nextToken);
    const token = pageOne.data.alias.nextToken;
    assert.equal(token.split(".").length, 4);
    assert.doesNotMatch(token, /alpha|client-created|x-api-key|AWS4-HMAC|secretAccessKey|sessionToken/i);
    assert.doesNotMatch(token, new RegExp(harness.apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const collected = [...pageOne.data.alias.items];
    let traversalToken: string | null = token;
    while (traversalToken) {
      const page = await apiKeyGraphql(harness, `query($filter:ModelTodoFilterInput,$limit:Int,$nextToken:String){listTodos(filter:$filter,limit:$limit,nextToken:$nextToken){items{id title}nextToken}}`, { filter: { title: { beginsWith: "alpha" } }, limit: 1, nextToken: traversalToken });
      collected.push(...page.data.listTodos.items); traversalToken = page.data.listTodos.nextToken;
    }
    assert.deepEqual(collected.map((item: any) => item.title).sort(), ["alpha", "alphabet"]);
    for (const variables of [
      { filter: { title: { beginsWith: "beta" } }, limit: 1, nextToken: token },
      { filter: { title: { beginsWith: "alpha" } }, limit: 2, nextToken: token },
    ]) {
      const rejected = await apiKeyGraphql(harness, `query($filter:ModelTodoFilterInput,$limit:Int,$nextToken:String){listTodos(filter:$filter,limit:$limit,nextToken:$nextToken){items{id}}}`, variables);
      assert.equal(rejected.data.listTodos, null); assert.equal(rejected.errors[0].extensions.errorType, "BadRequestException");
    }
    const malformed = await apiKeyGraphql(harness, `query($token:String){listTodos(limit:1,nextToken:$token){items{id}}}`, { token: "not-a-token" });
    assert.equal(malformed.data.listTodos, null); assert.equal(malformed.errors[0].extensions.errorType, "BadRequestException");

    const filters = await apiKeyGraphql(harness, `{ listTodos(filter:{and:[{title:{size:{ge:4}}},{priority:{between:[1,2]}},{completed:{attributeType:bool}}]}) { items { title } } }`);
    assert.deepEqual(filters.data.listTodos.items.map((item: any) => item.title).sort(), ["alpha", "beta"]);
    const filteredTitles = async (filter: Record<string, unknown>): Promise<string[]> => {
      const result = await apiKeyGraphql(harness!, `query($filter:ModelTodoFilterInput){listTodos(filter:$filter){items{title}}}`, { filter });
      assert.equal(result.errors, undefined, JSON.stringify(result));
      return result.data.listTodos.items.map((item: any) => item.title).sort();
    };
    for (const [filter, expected] of [
      [{ title: { eq: "alpha" } }, ["alpha"]], [{ title: { ne: "alpha" } }, ["alphabet", "beta"]],
      [{ title: { le: "alpha" } }, ["alpha"]], [{ title: { lt: "beta" } }, ["alpha", "alphabet"]],
      [{ title: { ge: "beta" } }, ["beta"]], [{ title: { gt: "alpha" } }, ["alphabet", "beta"]],
      [{ title: { contains: "pha" } }, ["alpha", "alphabet"]], [{ title: { notContains: "pha" } }, ["beta"]],
      [{ title: { between: ["alpha", "alphabet"] } }, ["alpha", "alphabet"]],
      [{ title: { attributeExists: true, attributeType: "string" } }, ["alpha", "alphabet", "beta"]],
      [{ title: { size: { eq: 4 } } }, ["beta"]], [{ title: { size: { between: [4, 5] } } }, ["alpha", "beta"]],
      [{ priority: { eq: 2 } }, ["beta"]], [{ priority: { ne: 2 } }, ["alpha", "alphabet"]],
      [{ priority: { le: 2 } }, ["alpha", "beta"]], [{ priority: { lt: 2 } }, ["alpha"]],
      [{ priority: { ge: 2 } }, ["alphabet", "beta"]], [{ priority: { gt: 2 } }, ["alphabet"]],
      [{ priority: { between: [1, 2], attributeType: "number" } }, ["alpha", "beta"]],
      [{ completed: { eq: false, attributeExists: true, attributeType: "bool" } }, ["alpha", "alphabet", "beta"]],
      [{ completed: { ne: false } }, []], [{ dueAt: { attributeExists: false } }, ["alpha", "alphabet", "beta"]],
      [{ or: [{ title: { eq: "alpha" } }, { not: { priority: { le: 2 } } }] }, ["alpha", "alphabet"]],
    ] as Array<[Record<string, unknown>, string[]]>) assert.deepEqual(await filteredTitles(filter), expected);
    const empty = await apiKeyGraphql(harness, `{ listTodos(filter:{title:{eq:"missing"}}) { items { id } nextToken } getTodo(id:"missing") { id } }`);
    assert.deepEqual(empty.data, { listTodos: { items: [], nextToken: null }, getTodo: null });

    clock.advance(1_000);
    const conditionRejected = await apiKeyGraphql(harness, `mutation($input:UpdateTodoInput!,$condition:ModelTodoConditionInput){updateTodo(input:$input,condition:$condition){id title}}`, { input: { id: ids[0], title: "never" }, condition: { priority: { eq: 99 } } });
    assert.equal(conditionRejected.data.updateTodo, null); assert.equal(conditionRejected.errors[0].extensions.errorType, "MappingTemplate");
    assert.match(conditionRejected.errors[0].message, /put requires a map/);
    assert.equal((await apiKeyGraphql(harness, `{ getTodo(id:"${ids[0]}"){title} }`)).data.getTodo.title, "alpha");

    const deleteCreated = await apiKeyGraphql(harness, create, { input: { id: "delete-target", title: "gamma", priority: 4 } });
    assert.equal(deleteCreated.errors, undefined);
    const deleteRejected = await apiKeyGraphql(harness, `mutation{deleteTodo(input:{id:"delete-target"},condition:{priority:{eq:99}}){id}}`);
    assert.equal(deleteRejected.data.deleteTodo, null); assert.equal(deleteRejected.errors[0].extensions.errorType, "MappingTemplate");
    assert.equal((await apiKeyGraphql(harness, `{getTodo(id:"delete-target"){title}}`)).data.getTodo.title, "gamma");
    const deleteAccepted = await apiKeyGraphql(harness, `mutation{deleteTodo(input:{id:"delete-target"},condition:{priority:{eq:4}}){id title}}`);
    assert.deepEqual(deleteAccepted.data.deleteTodo, { id: "delete-target", title: "gamma" });
    const deleteMissing = await apiKeyGraphql(harness, `mutation{deleteTodo(input:{id:"delete-target"}){id}}`);
    assert.equal(deleteMissing.data.deleteTodo, null); assert.equal(deleteMissing.errors[0].extensions.errorType, "MappingTemplate");

    const callerRoleName = "amx07-caller";
    const callerRoleArn = `arn:aws:iam::${accountId}:role/${callerRoleName}`;
    await harness.iam.send(new CreateRoleCommand({ RoleName: callerRoleName, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sts:AssumeRole" }] }) }));
    await harness.iam.send(new PutRolePolicyCommand({ RoleName: callerRoleName, PolicyName: "graphql", PolicyDocument: policy(["appsync:GraphQL"], `${harness.apiArn}/types/*`) }));
    const session = (await harness.sts.send(new AssumeRoleCommand({ RoleArn: callerRoleArn, RoleSessionName: "amx07" }))).Credentials!;
    const iamResult = await signedGraphql(harness, { accessKeyId: session.AccessKeyId!, secretAccessKey: session.SecretAccessKey!, sessionToken: session.SessionToken! }, `{ listTodos(limit:1){items{id title} nextToken} }`);
    assert.equal(iamResult.errors, undefined); assert.equal(iamResult.data.listTodos.items.length, 1);
    const crossMode = await apiKeyGraphql(harness, `query($token:String){listTodos(limit:1,nextToken:$token){items{id}}}`, { token: iamResult.data.listTodos.nextToken });
    assert.equal(crossMode.data.listTodos, null); assert.equal(crossMode.errors[0].extensions.errorType, "BadRequestException");

    const selected = await apiKeyGraphql(harness, `query One { getTodo(id:"${ids[0]}"){...Fields} } query Two { getTodo(id:"${ids[1]}"){...Fields} } fragment Fields on Todo { alias:title }`, undefined, "Two");
    assert.deepEqual(selected.data, { getTodo: { alias: "beta" } });

    await updateGeneratedFunction(harness, "QueryListTodosDataResolverFn", {});
    const staleFunction = await apiKeyGraphql(harness, `query($filter:ModelTodoFilterInput,$limit:Int,$token:String){listTodos(filter:$filter,limit:$limit,nextToken:$token){items{id}}}`, { filter: { title: { beginsWith: "alpha" } }, limit: 1, token });
    assert.equal(staleFunction.data.listTodos, null); assert.equal(staleFunction.errors[0].extensions.errorType, "BadRequestException");
    const fresh = await apiKeyGraphql(harness, `{listTodos(limit:1){items{id}nextToken}}`);
    assert.ok(fresh.data.listTodos.nextToken);
    const schema = await readFile(join(assets, "941821462168d0c1c15b579e764e675a5ed57595aa8875d0c10071b408b77513.graphql"));
    await harness.appsync.send(new StartSchemaCreationCommand({ apiId: harness.apiId, definition: schema }));
    assert.equal((await harness.appsync.send(new GetSchemaCreationStatusCommand({ apiId: harness.apiId }))).status, "SUCCESS");
    const staleSchema = await apiKeyGraphql(harness, `query($token:String){listTodos(limit:1,nextToken:$token){items{id}}}`, { token: fresh.data.listTodos.nextToken });
    assert.equal(staleSchema.data.listTodos, null); assert.equal(staleSchema.errors[0].extensions.errorType, "BadRequestException");

    const beforeRestart = await apiKeyGraphql(harness, `{getTodo(id:"${ids[0]}"){id title}}`);
    await stopHarness(harness);
    const restarted = await startHarness(root, clock);
    harness = { ...harness, ...restarted, graphqlEndpoint: `http://127.0.0.1:${restarted.simulator.port}/graphql/${region}/${harness.apiId}` };
    diagnosticRunning = restarted;
    assert.deepEqual(await apiKeyGraphql(harness, `{getTodo(id:"${ids[0]}"){id title}}`), beforeRestart);

    const replacementToken = (await apiKeyGraphql(harness, `{listTodos(limit:1){items{id}nextToken}}`)).data.listTodos.nextToken;
    await harness.dynamodb.send(new DeleteTableCommand({ TableName: harness.tableName }));
    const missingTable = await apiKeyGraphql(harness, `{getTodo(id:"${ids[0]}"){id}}`);
    assert.equal(missingTable.data.getTodo, null); assert.equal(missingTable.errors[0].extensions.errorType, "DynamoDB:ResourceNotFoundException");
    await harness.dynamodb.send(new CreateTableCommand({ TableName: harness.tableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
    await waitForTableActive(harness.dynamodb, harness.tableName, clock);
    const replacementRejected = await apiKeyGraphql(harness, `query($token:String){listTodos(limit:1,nextToken:$token){items{id}}}`, { token: replacementToken });
    assert.equal(replacementRejected.data.listTodos, null); assert.equal(replacementRejected.errors[0].extensions.errorType, "BadRequestException");
    assert.deepEqual((await apiKeyGraphql(harness, `{listTodos{items{id}nextToken}}`)).data.listTodos, { items: [], nextToken: null });
  } finally {
    if (harness) await stopHarness(harness).catch(() => undefined); else if (diagnosticRunning) await stopHarness(diagnosticRunning).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("AMX-07 generated pipeline fails before mutation and never rolls back or repeats a committed write", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx07-failures-"));
  const clock = new TestClock(Date.now());
  let harness: Harness | undefined;
  try {
    harness = await createHarness(root, clock);
    const dynamodbService = harness.simulator.dynamodb as any;
    const originalPut = dynamodbService.PutItem.bind(dynamodbService);
    const originalScan = dynamodbService.Scan.bind(dynamodbService);
    const originalDescribe = dynamodbService.DescribeTable.bind(dynamodbService);
    const originalGetResourcePolicy = dynamodbService.GetResourcePolicy.bind(dynamodbService);
    let putCalls = 0; let scanCalls = 0; let describeCalls = 0; let resourcePolicyCalls = 0;
    dynamodbService.PutItem = async (input: any) => { putCalls++; return originalPut(input); };
    dynamodbService.Scan = async (input: any) => { scanCalls++; return originalScan(input); };
    dynamodbService.DescribeTable = async (input: any) => { describeCalls++; return originalDescribe(input); };
    dynamodbService.GetResourcePolicy = async (input: any) => { resourcePolicyCalls++; return originalGetResourcePolicy(input); };

    const invalidInput = await apiKeyGraphql(harness, `mutation { createTodo(input:{priority:1}) { id } }`);
    assert.equal(invalidInput.data, undefined); assert.ok(invalidInput.errors.length); assert.equal(putCalls, 0);

    const createName = "MutationCreateTodoDataResolverFn";
    const api = harness.simulator.store.regionState(region).appsync.graphqlApis[harness.apiId];
    const original = Object.values(api.functions).find(candidate => candidate.name === createName)!;
    const generatedRequest = original.requestMappingTemplate;
    const generatedResponse = original.responseMappingTemplate;
    await updateGeneratedFunction(harness, createName, { requestMappingTemplate: '#if($ctx.args.input.id == "request-failure")$util.error("request rejected", "InjectedRequest")#end\n' + generatedRequest });
    const requestFailure = await apiKeyGraphql(harness, `mutation { createTodo(input:{id:"request-failure",title:"never"}) { id } }`);
    assert.equal(requestFailure.data.createTodo, null); assert.equal(requestFailure.errors[0].extensions.errorType, "InjectedRequest"); assert.equal(putCalls, 0);
    assert.equal((await harness.dynamodb.send(new GetItemCommand({ TableName: harness.tableName, Key: { id: { S: "request-failure" } } }))).Item, undefined);

    await updateGeneratedFunction(harness, createName, { requestMappingTemplate: generatedRequest, responseMappingTemplate: '#if($ctx.result.id == "committed-response")$util.error("after commit", "InjectedResponse")#end\n$util.toJson($ctx.result)' });
    const responseFailure = await apiKeyGraphql(harness, `mutation { createTodo(input:{id:"committed-response",title:"stored"}) { id } }`);
    assert.equal(responseFailure.data.createTodo, null); assert.equal(responseFailure.errors[0].extensions.errorType, "InjectedResponse");
    assert.equal(putCalls, 1);
    assert.equal((await harness.dynamodb.send(new GetItemCommand({ TableName: harness.tableName, Key: { id: { S: "committed-response" } } }))).Item?.title.S, "stored");

    await updateGeneratedFunction(harness, createName, { responseMappingTemplate: "$util.toJson({})" });
    const completionFailure = await apiKeyGraphql(harness, `mutation { createTodo(input:{id:"committed-completion",title:"stored too"}) { id title } }`);
    assert.equal(completionFailure.data.createTodo, null); assert.match(completionFailure.errors[0].message, /non-nullable field Todo.id/);
    assert.equal(putCalls, 2);
    assert.equal((await harness.dynamodb.send(new GetItemCommand({ TableName: harness.tableName, Key: { id: { S: "committed-completion" } } }))).Item?.title.S, "stored too");
    await updateGeneratedFunction(harness, createName, { responseMappingTemplate: generatedResponse });
    assert.equal((await apiKeyGraphql(harness, `{getTodo(id:"committed-response"){id title}}`)).data.getTodo.title, "stored");

    await harness.iam.send(new PutRolePolicyCommand({
      RoleName: harness.dataRoleName, PolicyName: "DynamoDBAccess",
      PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], Resource: [harness.tableArn, `${harness.tableArn}/*`] },
        { Effect: "Deny", Action: "dynamodb:PutItem", Resource: harness.tableArn },
      ] }),
    }));
    const beforeDeniedDescribe = describeCalls;
    const beforeDeniedResourcePolicy = resourcePolicyCalls;
    const roleDenied = await apiKeyGraphql(harness, `mutation { createTodo(input:{id:"role-denied",title:"never"}) { id } }`);
    assert.equal(roleDenied.data.createTodo, null); assert.equal(roleDenied.errors[0].extensions.errorType, "MappingTemplate");
    assert.equal(putCalls, 2);
    assert.equal(describeCalls, beforeDeniedDescribe);
    assert.equal(resourcePolicyCalls, beforeDeniedResourcePolicy);
    assert.equal((await harness.dynamodb.send(new GetItemCommand({ TableName: harness.tableName, Key: { id: { S: "role-denied" } } }))).Item, undefined);

    const deniedRoleName = "amx07-denied-caller";
    const deniedRoleArn = `arn:aws:iam::${accountId}:role/${deniedRoleName}`;
    await harness.iam.send(new CreateRoleCommand({ RoleName: deniedRoleName, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${accountId}:root` }, Action: "sts:AssumeRole" }] }) }));
    const deniedSession = (await harness.sts.send(new AssumeRoleCommand({ RoleArn: deniedRoleArn, RoleSessionName: "denied" }))).Credentials!;
    const deniedField = await signedGraphql(harness, { accessKeyId: deniedSession.AccessKeyId!, secretAccessKey: deniedSession.SecretAccessKey!, sessionToken: deniedSession.SessionToken! }, `{listTodos{items{id}}}`);
    assert.equal(deniedField.data.listTodos, null); assert.equal(deniedField.errors[0].extensions.errorType, "Unauthorized"); assert.equal(scanCalls, 0);
  } finally {
    if (harness) await stopHarness(harness).catch(() => undefined); else if (diagnosticRunning) await stopHarness(diagnosticRunning).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
