import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { canonicalTextSha256 } from "./support/frozen-text.js";

const evidence = resolve("test/fixtures/amplify-gen2-data/evidence");

async function digest(name: string): Promise<string> {
  return canonicalTextSha256(await readFile(resolve(evidence, name)));
}

test("AMX-07 freezes the exact generated Todo data corpus without changing AMX-01 or AMX-04 through AMX-06", async () => {
  assert.deepEqual(await Promise.all([
    digest("graph-manifest.json"), digest("amx04-helper-manifest.json"),
    digest("amx05-appsync-manifest.json"), digest("amx06-authorization-manifest.json"),
  ]), [
    "4b796f05936b1943ab1f22f57395219d1b840573d959fdd0669818cb1b1f7868",
    "16200269bb57a1e015770e3e0c318bb813305d6ecb0d667350506ea29c55aaf2",
    "273fe7171f89b09084334ca3836cc0ab1ea71333fa98bb2bd5018f06551e1e31",
    "2e2e8fb4937b16ca262a5b6f31a9b015896b75e36a1ea01a629c05d74a81349d",
  ]);
  const manifest = JSON.parse(await readFile(resolve(evidence, "amx07-data-manifest.json"), "utf8"));
  assert.equal(manifest.milestone, "AMX-07 frozen generated one-model Amplify Data semantics");
  assert.deepEqual(manifest.schema.rootFields.Query.map((field: any) => field.name), ["getTodo", "listTodos"]);
  assert.deepEqual(manifest.schema.rootFields.Mutation.map((field: any) => field.name), ["createTodo", "updateTodo", "deleteTodo"]);
  assert.deepEqual(manifest.pipelines.map((pipeline: any) => `${pipeline.typeName}.${pipeline.fieldName}`), [
    "Mutation.createTodo", "Mutation.deleteTodo", "Mutation.updateTodo", "Query.getTodo", "Query.listTodos",
  ]);
  assert.deepEqual(manifest.dynamodbDocuments.map((document: any) => [document.rootField, document.operation]), [
    ["createTodo", "PutItem"], ["deleteTodo", "GetItem"], ["deleteTodo", "DeleteItem"],
    ["getTodo", "Query"], ["listTodos", "Scan"], ["updateTodo", "GetItem"], ["updateTodo", "UpdateItem"],
  ]);
  assert.deepEqual(manifest.authorization.executionRoleActions, [
    "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan",
  ]);
  assert.ok(manifest.utilities.includes("transform.toDynamoDBConditionExpression"));
  assert.ok(manifest.utilities.includes("transform.toDynamoDBFilterExpression"));
  assert.ok(manifest.pagination.scopes.includes("authorization identity digest"));
  assert.match(manifest.failureContract.dug08, /UNIT resolver path remains open/);
  assert.ok(manifest.negativeSurface.some((value: string) => value.includes("AMX-09")));
});
