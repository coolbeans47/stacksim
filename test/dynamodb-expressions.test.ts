import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CreateTableCommand, DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand as DocumentQueryCommand, ScanCommand as DocumentScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { StackSim } from "../src/server.js";

let root: string;
let simulator: StackSim;
let client: DynamoDBClient;
let documentClient: DynamoDBDocumentClient;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "stacksim-ddb-expressions-"));
  simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region: "eu-west-1", authMode: "off"});
  await simulator.start();
  client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${simulator.port}`, region: "eu-west-1", credentials: { accessKeyId: "admin", secretAccessKey: "password" } });
  documentClient = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  await client.send(new CreateTableCommand({ TableName: "ExpressionTable", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "N" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }] }));
  await new Promise(resolve => setTimeout(resolve, 75));
});

after(async () => { documentClient.destroy(); client.destroy(); await simulator.stop(); await rm(root, { recursive: true, force: true }); });

test("condition grammar supports precedence, parentheses, IN and document functions", async () => {
  const item = { pk: { S: "grammar" }, sk: { N: "1" }, profile: { M: { fullName: { S: "Ada Lovelace" }, tags: { L: [{ S: "math" }, { S: "code" }] } } }, state: { S: "ready" }, score: { N: "900719925474099312345678901234567890" } } as const;
  await client.send(new PutItemCommand({ TableName: "ExpressionTable", Item: item as any }));
  const cases = [
    ["attribute_exists(profile.fullName) AND begins_with(profile.fullName, :prefix)", { ":prefix": { S: "Ada" } }, true],
    ["contains(profile.tags, :tag) AND attribute_type(score, :number)", { ":tag": { S: "code" }, ":number": { S: "N" } }, true],
    ["size(profile.tags) = :two AND state IN (:ready, :done)", { ":two": { N: "2" }, ":ready": { S: "ready" }, ":done": { S: "done" } }, true],
    ["NOT (state = :done OR attribute_not_exists(profile))", { ":done": { S: "done" } }, true],
    ["state = :done OR state = :ready AND attribute_exists(profile)", { ":done": { S: "done" }, ":ready": { S: "ready" } }, true],
  ] as const;
  for (const [expression, values, expected] of cases) {
    const result = await client.send(new ScanCommand({ TableName: "ExpressionTable", FilterExpression: expression, ExpressionAttributeValues: values as any }));
    assert.equal(result.Count, expected ? 1 : 0, expression);
  }
  const projection = await client.send(new GetItemCommand({ TableName: "ExpressionTable", Key: { pk: { S: "grammar" }, sk: { N: "1" } }, ProjectionExpression: "profile.#name, profile.tags[1]", ExpressionAttributeNames: { "#name": "fullName" } }));
  assert.deepEqual(projection.Item, { profile: { M: { fullName: { S: "Ada Lovelace" }, tags: { L: [{ S: "code" }] } } } });
});

test("update grammar supports nested SET, arithmetic, functions, REMOVE, ADD and DELETE", async () => {
  await client.send(new PutItemCommand({ TableName: "ExpressionTable", Item: { pk: { S: "updates" }, sk: { N: "1" }, profile: { M: { visits: { N: "9007199254740993" }, tags: { L: [{ S: "a" }] }, obsolete: { BOOL: true } } }, labels: { SS: ["one", "two"] } } }));
  const first = await client.send(new UpdateItemCommand({
    TableName: "ExpressionTable", Key: { pk: { S: "updates" }, sk: { N: "1" } },
    UpdateExpression: "SET profile.visits = profile.visits + :one, profile.tags = list_append(profile.tags, :more), profile.created = if_not_exists(profile.created, :created) REMOVE profile.obsolete",
    ExpressionAttributeValues: { ":one": { N: "1" }, ":more": { L: [{ S: "b" }] }, ":created": { S: "now" } }, ReturnValues: "UPDATED_NEW",
  }));
  assert.equal((first.Attributes?.profile as any).M.visits.N, "9007199254740994");
  assert.deepEqual((first.Attributes?.profile as any).M.tags.L, [{ S: "a" }, { S: "b" }]);
  const second = await client.send(new UpdateItemCommand({ TableName: "ExpressionTable", Key: { pk: { S: "updates" }, sk: { N: "1" } }, UpdateExpression: "ADD counter :five DELETE labels :remove", ExpressionAttributeValues: { ":five": { N: "5" }, ":remove": { SS: ["one"] } }, ReturnValues: "ALL_NEW" }));
  assert.equal(second.Attributes?.counter?.N, "5");
  assert.deepEqual(second.Attributes?.labels?.SS, ["two"]);
  assert.equal((second.Attributes?.profile as any).M.obsolete, undefined);
});

test("failed condition and invalid overlapping update remain atomic", async () => {
  await client.send(new PutItemCommand({ TableName: "ExpressionTable", Item: { pk: { S: "atomic" }, sk: { N: "1" }, value: { S: "before" }, nested: { M: { child: { S: "original" } } } } }));
  await assert.rejects(client.send(new UpdateItemCommand({ TableName: "ExpressionTable", Key: { pk: { S: "atomic" }, sk: { N: "1" } }, UpdateExpression: "SET #value = :after", ConditionExpression: "#value = :wrong", ExpressionAttributeNames: { "#value": "value" }, ExpressionAttributeValues: { ":after": { S: "after" }, ":wrong": { S: "no" } } })), (error: any) => error.name === "ConditionalCheckFailedException");
  await assert.rejects(client.send(new UpdateItemCommand({ TableName: "ExpressionTable", Key: { pk: { S: "atomic" }, sk: { N: "1" } }, UpdateExpression: "SET nested = :map, nested.child = :child", ExpressionAttributeValues: { ":map": { M: {} }, ":child": { S: "changed" } } })), (error: any) => error.name === "ValidationException");
  const item = (await client.send(new GetItemCommand({ TableName: "ExpressionTable", Key: { pk: { S: "atomic" }, sk: { N: "1" } } }))).Item;
  assert.equal(item?.value?.S, "before");
  assert.equal((item?.nested as any).M.child.S, "original");
});

test("query Limit counts evaluated items before filters and pagination round trips", async () => {
  for (let sk = 1; sk <= 5; sk++) await client.send(new PutItemCommand({ TableName: "ExpressionTable", Item: { pk: { S: "pages" }, sk: { N: String(sk) }, visible: { BOOL: sk % 2 === 0 } } }));
  const first = await client.send(new QueryCommand({ TableName: "ExpressionTable", KeyConditionExpression: "pk = :pk", FilterExpression: "visible = :yes", ExpressionAttributeValues: { ":pk": { S: "pages" }, ":yes": { BOOL: true } }, Limit: 2 }));
  assert.equal(first.ScannedCount, 2); assert.equal(first.Count, 1); assert.equal(first.Items?.[0].sk.N, "2"); assert.ok(first.LastEvaluatedKey);
  const second = await client.send(new QueryCommand({ TableName: "ExpressionTable", KeyConditionExpression: "pk = :pk", FilterExpression: "visible = :yes", ExpressionAttributeValues: { ":pk": { S: "pages" }, ":yes": { BOOL: true } }, Limit: 2, ExclusiveStartKey: first.LastEvaluatedKey }));
  assert.equal(second.ScannedCount, 2); assert.equal(second.Count, 1); assert.equal(second.Items?.[0].sk.N, "4");
});

test("DynamoDBDocumentClient works without simulator-specific marshalling", async () => {
  await documentClient.send(new PutCommand({ TableName: "ExpressionTable", Item: { pk: "document", sk: 1, title: "Document client", count: 1, tags: ["a"] } }));
  await documentClient.send(new UpdateCommand({ TableName: "ExpressionTable", Key: { pk: "document", sk: 1 }, UpdateExpression: "SET #count = #count + :one", ExpressionAttributeNames: { "#count": "count" }, ExpressionAttributeValues: { ":one": 1 } }));
  const got = await documentClient.send(new GetCommand({ TableName: "ExpressionTable", Key: { pk: "document", sk: 1 } }));
  assert.equal(got.Item?.count, 2);
  assert.equal((await client.send(new QueryCommand({ TableName: "ExpressionTable", KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": { S: "document" } } }))).Count, 1);
  assert.equal((await documentClient.send(new DocumentQueryCommand({ TableName: "ExpressionTable", KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "document" } }))).Count, 1);
  assert.ok((await documentClient.send(new DocumentScanCommand({ TableName: "ExpressionTable", FilterExpression: "contains(title, :part)", ExpressionAttributeValues: { ":part": "Document" } }))).Items?.length);
});
