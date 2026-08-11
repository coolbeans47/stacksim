import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { APIGatewayClient, CreateDeploymentCommand, CreateResourceCommand, CreateRestApiCommand, DeleteDeploymentCommand, DeleteMethodCommand, DeleteRestApiCommand, GetDeploymentCommand, GetIntegrationCommand, GetResourcesCommand, GetRestApisCommand, PutIntegrationCommand, PutMethodCommand, UpdateDeploymentCommand, UpdateStageCommand } from "@aws-sdk/client-api-gateway";
import { BatchGetItemCommand, BatchWriteItemCommand, CreateTableCommand, DeleteItemCommand, DeleteTableCommand, DescribeTableCommand, DynamoDBClient, GetItemCommand, ListTablesCommand, PutItemCommand, QueryCommand, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { CreateFunctionCommand, DeleteFunctionCommand, GetFunctionCommand, InvokeCommand, LambdaClient, ListFunctionsCommand, UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

let simulator: StackSim;
let dataDir: string;
let dynamodb: DynamoDBClient;
let lambda: LambdaClient;
let apigateway: APIGatewayClient;
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "stacksim-test-"));
  simulator = new StackSim({ port: 0, invokePort: 0, dataDir, region: "eu-west-1", authMode: "off"});
  await simulator.start();
  const common = { endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials };
  dynamodb = new DynamoDBClient(common); lambda = new LambdaClient(common); apigateway = new APIGatewayClient(common);
});

after(async () => { dynamodb.destroy(); lambda.destroy(); apigateway.destroy(); await simulator.stop(); await rm(dataDir, { recursive: true, force: true }); });

test("DynamoDB core table and item APIs work through AWS SDK v3", async () => {
  const created = await dynamodb.send(new CreateTableCommand({ TableName: "Notes", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "N" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }] }));
  assert.equal(created.TableDescription?.TableStatus, "CREATING");
  await waitForTableActive(dynamodb, "Notes");
  assert.deepEqual((await dynamodb.send(new ListTablesCommand({}))).TableNames, ["Notes"]);
  assert.equal((await dynamodb.send(new DescribeTableCommand({ TableName: "Notes" }))).Table?.KeySchema?.length, 2);
  const emptyScan = await dynamodb.send(new ScanCommand({ TableName: "Notes" }));
  assert.equal(emptyScan.Count, 0);
  assert.equal(emptyScan.ScannedCount, 0);
  assert.deepEqual(emptyScan.Items, []);
  await assert.rejects(
    dynamodb.send(new ScanCommand({ TableName: "Notes", Limit: 0 })),
    (error: any) => error.name === "ValidationException",
  );

  await dynamodb.send(new PutItemCommand({ TableName: "Notes", Item: { pk: { S: "course" }, sk: { N: "1" }, title: { S: "First" }, views: { N: "1" } }, ConditionExpression: "attribute_not_exists(pk)" }));
  const got = await dynamodb.send(new GetItemCommand({ TableName: "Notes", Key: { pk: { S: "course" }, sk: { N: "1" } }, ProjectionExpression: "title, views" }));
  assert.deepEqual(got.Item, { title: { S: "First" }, views: { N: "1" } });
  const updated = await dynamodb.send(new UpdateItemCommand({ TableName: "Notes", Key: { pk: { S: "course" }, sk: { N: "1" } }, UpdateExpression: "SET #title = :title ADD views :one", ExpressionAttributeNames: { "#title": "title" }, ExpressionAttributeValues: { ":title": { S: "Updated" }, ":one": { N: "1" } }, ReturnValues: "ALL_NEW" }));
  assert.equal(updated.Attributes?.views?.N, "2");
  assert.equal(updated.Attributes?.title?.S, "Updated");

  await dynamodb.send(new BatchWriteItemCommand({ RequestItems: { Notes: [{ PutRequest: { Item: { pk: { S: "course" }, sk: { N: "2" }, title: { S: "Second" } } } }, { PutRequest: { Item: { pk: { S: "other" }, sk: { N: "1" }, title: { S: "Other" } } } }] } }));
  await assert.rejects(dynamodb.send(new BatchWriteItemCommand({ RequestItems: { Notes: [
    { PutRequest: { Item: { pk: { S: "partial" }, sk: { N: "1" } } } },
    { PutRequest: { Item: { pk: { S: "invalid-without-range-key" } } } },
  ] } })), (error: any) => error.name === "ValidationException");
  assert.equal((await dynamodb.send(new GetItemCommand({ TableName: "Notes", Key: { pk: { S: "partial" }, sk: { N: "1" } } }))).Item, undefined, "a rejected batch must not leave partial in-memory writes");
  const queried = await dynamodb.send(new QueryCommand({ TableName: "Notes", KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": { S: "course" } } }));
  assert.equal(queried.Count, 2);
  const scanned = await dynamodb.send(new ScanCommand({ TableName: "Notes", FilterExpression: "title = :title", ExpressionAttributeValues: { ":title": { S: "Other" } } }));
  assert.equal(scanned.Count, 1);
  const batch = await dynamodb.send(new BatchGetItemCommand({ RequestItems: { Notes: { Keys: [{ pk: { S: "course" }, sk: { N: "1" } }, { pk: { S: "course" }, sk: { N: "2" } }] } } }));
  assert.equal(batch.Responses?.Notes.length, 2);
  const deleted = await dynamodb.send(new DeleteItemCommand({ TableName: "Notes", Key: { pk: { S: "other" }, sk: { N: "1" } }, ReturnValues: "ALL_OLD" }));
  assert.equal(deleted.Attributes?.title?.S, "Other");
});

test("Lambda deployment and invocation work through AWS SDK v3", async () => {
  await dynamodb.send(new CreateTableCommand({ TableName: "LearningNotes", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
  await waitForTableActive(dynamodb, "LearningNotes");
  await dynamodb.send(new PutItemCommand({ TableName: "LearningNotes", Item: { id: { S: "welcome" }, title: { S: "Welcome" }, body: { S: "Seeded" } } }));
  const zip = await readFile(join(process.cwd(), "examples/lambda/function.zip"));
  const created = await lambda.send(new CreateFunctionCommand({ FunctionName: "notes-handler", Runtime: "nodejs22.x", Role: "arn:aws:iam::000000000000:role/test", Handler: "handler.handler", Timeout: 10, Code: { ZipFile: zip }, Environment: { Variables: { TABLE_NAME: "LearningNotes", STACKSIM_ENDPOINT: `http://127.0.0.1:${simulator.port}` } } }));
  assert.match(created.FunctionArn!, /notes-handler$/);
  assert.equal((await lambda.send(new ListFunctionsCommand({}))).Functions?.length, 1);
  assert.equal((await lambda.send(new GetFunctionCommand({ FunctionName: "notes-handler" }))).Configuration?.State, "Active");
  await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: "notes-handler", Description: "integration test" }));
  assert.equal((await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: "notes-handler", ZipFile: zip }))).FunctionName, "notes-handler");
  const invocation = await lambda.send(new InvokeCommand({ FunctionName: "notes-handler", Payload: Buffer.from(JSON.stringify({ httpMethod: "GET", pathParameters: { id: "welcome" } })) }));
  assert.equal(invocation.FunctionError, undefined, Buffer.from(invocation.Payload ?? []).toString("utf8"));
  const response = JSON.parse(Buffer.from(invocation.Payload!).toString("utf8"));
  assert.equal(response.statusCode, 200);
});

test("API Gateway invokes Lambda and Lambda writes DynamoDB", async () => {
  const api = await apigateway.send(new CreateRestApiCommand({ name: "test-api" }));
  const resources = await apigateway.send(new GetResourcesCommand({ restApiId: api.id! }));
  const root = resources.items!.find(item => item.path === "/")!;
  const notes = await apigateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: root.id!, pathPart: "notes" }));
  const note = await apigateway.send(new CreateResourceCommand({ restApiId: api.id!, parentId: notes.id!, pathPart: "{id}" }));
  const uri = `arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-1:000000000000:function:notes-handler/invocations`;
  for (const httpMethod of ["GET", "POST"]) {
    await apigateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: notes.id!, httpMethod, authorizationType: "NONE" }));
    await apigateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: notes.id!, httpMethod, type: "AWS_PROXY", integrationHttpMethod: "POST", uri }));
  }
  for (const httpMethod of ["GET", "PUT"]) {
    await apigateway.send(new PutMethodCommand({ restApiId: api.id!, resourceId: note.id!, httpMethod, authorizationType: "NONE" }));
    await apigateway.send(new PutIntegrationCommand({ restApiId: api.id!, resourceId: note.id!, httpMethod, type: "AWS_PROXY", integrationHttpMethod: "POST", uri }));
  }
  assert.equal((await apigateway.send(new GetIntegrationCommand({ restApiId: api.id!, resourceId: notes.id!, httpMethod: "POST" }))).type, "AWS_PROXY");
  const firstDeployment = await apigateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev", description: "v1" }));
  const base = `http://127.0.0.1:${simulator.invokePort}/${api.id}/dev/notes`;
  const post = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "from-api", title: "Postman path", body: "It works" }) });
  assert.equal(post.status, 201);
  assert.equal((await post.json() as any).id.S, "from-api");
  const stored = await dynamodb.send(new GetItemCommand({ TableName: "LearningNotes", Key: { id: { S: "from-api" } } }));
  assert.equal(stored.Item?.title?.S, "Postman path");
  const update = await fetch(`${base}/from-api`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Updated through API", completed: true, priority: 9 }) });
  assert.equal(update.status, 200);
  const updated = await update.json() as any;
  assert.equal(updated.title.S, "Updated through API");
  assert.equal(updated.completed.BOOL, true);
  assert.equal(updated.priority.N, "9");
  const list = await fetch(base);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(await list.json()));

  await apigateway.send(new DeleteMethodCommand({ restApiId: api.id!, resourceId: notes.id!, httpMethod: "GET" }));
  assert.equal((await fetch(base)).status, 200, "editing live resources must not change the deployed stage");
  const secondDeployment = await apigateway.send(new CreateDeploymentCommand({ restApiId: api.id!, stageName: "dev", description: "v2 without GET" }));
  assert.equal((await fetch(base)).status, 403, "a new deployment must switch the stage to its immutable snapshot");
  await apigateway.send(new UpdateStageCommand({ restApiId: api.id!, stageName: "dev", patchOperations: [{ op: "replace", path: "/deploymentId", value: firstDeployment.id! }, { op: "add", path: "/variables/release", value: "v1" }] }));
  assert.equal((await fetch(base)).status, 200, "stage rollback must restore the first snapshot");
  assert.equal((await apigateway.send(new GetDeploymentCommand({ restApiId: api.id!, deploymentId: firstDeployment.id! }))).description, "v1");
  assert.equal((await apigateway.send(new UpdateDeploymentCommand({ restApiId: api.id!, deploymentId: firstDeployment.id!, patchOperations: [{ op: "replace", path: "/description", value: "stable v1" }] }))).description, "stable v1");
  await apigateway.send(new DeleteDeploymentCommand({ restApiId: api.id!, deploymentId: secondDeployment.id! }));
  await assert.rejects(apigateway.send(new DeleteDeploymentCommand({ restApiId: api.id!, deploymentId: firstDeployment.id! })), (error: any) => error.name === "ConflictException");
});

test("management console assets and environment summary are served", async () => {
  const base = `http://127.0.0.1:${simulator.port}`;
  const page = await fetch(`${base}/_stacksim/console`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type")!, /text\/html/);
  assert.match(await page.text(), /StackSim local console/);
  const script = await fetch(`${base}/_stacksim/console/app.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /routeLambda/);
  const highlightingModule = await fetch(`${base}/_stacksim/console/vendor/highlightjs/es/core.min.js`);
  assert.equal(highlightingModule.status, 200, "console module dependencies must be served on every platform");
  assert.match(highlightingModule.headers.get("content-type")!, /text\/javascript/);
  const serviceIcon = await fetch(`${base}/_stacksim/console/assets/aws-icons/lambda.svg`);
  assert.equal(serviceIcon.status, 200);
  assert.match(serviceIcon.headers.get("content-type")!, /image\/svg\+xml/);
  assert.match(await serviceIcon.text(), /AWS-Lambda_Icon/);
  const modules = await Promise.all(["home", "lambda", "dynamodb", "s3", "sqs", "apigateway", "cloudwatch", "iam", "rds", "cognito", "sns", "parameter-store", "step-functions"].map(async service => {
    const response = await fetch(`${base}/_stacksim/console/services/${service}.js`);
    assert.equal(response.status, 200);
    return response.text();
  }));
  assert.match(modules[1], /Create function/);
  assert.match(modules[3], /General purpose buckets/);
  assert.match(modules[2], /Create table/);
  assert.match(modules[4], /Create queue/);
  assert.match(modules[5], /Create REST API/);
  assert.match(modules[8], /Create database/);
  assert.match(modules[9], /Create user pool/);
  assert.match(modules[10], /Create topic/);
  assert.match(modules[11], /Create parameter/);
  assert.match(modules[0], /Step Functions/);
  assert.match(modules[12], /State machines/);
  const summary = await (await fetch(`${base}/_stacksim/api/summary`)).json() as any;
  assert.deepEqual(summary.counts, { stacks: 0, stateMachines: 0, parameters: 1, secrets: 0, functions: 1, capacityProviders: 0, durableExecutions: 0, tables: 2, rdsInstances: 0, buckets: 1, queues: 0, topics: 0, subscriptions: 0, eventBuses: 1, eventRules: 0, apis: 1, httpApis: 0, webSocketApis: 0, customDomains: 0, logGroups: 1, users: 1, groups: 0, roles: 6, policies: 8, sesIdentities: 0, sesTemplates: 0, sesConfigurationSets: 0, sesMessages: 0, cognitoUserPools: 0, cognitoAppClients: 0 });
  assert.equal(summary.invokeEndpoint, `http://127.0.0.1:${simulator.invokePort}`);
});

test("service lifecycle delete APIs work through AWS SDK v3", async () => {
  const apis = await apigateway.send(new GetRestApisCommand({}));
  assert.equal(apis.items?.length, 1);
  await apigateway.send(new DeleteRestApiCommand({ restApiId: apis.items![0].id! }));
  await lambda.send(new DeleteFunctionCommand({ FunctionName: "notes-handler" }));
  await dynamodb.send(new DeleteTableCommand({ TableName: "LearningNotes" }));
  await dynamodb.send(new DeleteTableCommand({ TableName: "Notes" }));
  assert.equal((await lambda.send(new ListFunctionsCommand({}))).Functions?.length, 0);
  assert.equal((await dynamodb.send(new ListTablesCommand({}))).TableNames?.length, 0);
});
