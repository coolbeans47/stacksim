import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const evidence = resolve("test/fixtures/amplify-gen2-data/evidence");

test("AMX-06 freezes the exact generated AppSync IAM configuration and authorization corpus without changing the AMX-01 graph", async () => {
  const manifest = JSON.parse(await readFile(resolve(evidence, "amx06-authorization-manifest.json"), "utf8"));
  const graph = JSON.parse(await readFile(resolve(evidence, "graph-manifest.json"), "utf8"));
  const api = graph.resources.find((resource: any) => resource.type === "AWS::AppSync::GraphQLApi");
  assert.deepEqual(manifest.graphqlApi, {
    logicalId: api.logicalId,
    authenticationType: "API_KEY",
    additionalAuthenticationProviders: [{ AuthenticationType: "AWS_IAM" }],
    rejectedAdditionalModes: ["AMAZON_COGNITO_USER_POOLS", "AWS_LAMBDA", "OPENID_CONNECT"],
  });
  assert.deepEqual(manifest.schema.rootFields, {
    Query: ["getTodo", "listTodos"],
    Mutation: ["createTodo", "updateTodo", "deleteTodo"],
    Subscription: ["onCreateTodo", "onUpdateTodo", "onDeleteTodo"],
  });
  assert.deepEqual(manifest.schema.directives, { awsApiKey: 10, awsIam: 10 });
  assert.equal(manifest.iam.action, "appsync:GraphQL");
  assert.equal(manifest.iam.evaluator, "shared IAM identity/session-policy/permissions-boundary evaluator");
  assert.equal(manifest.requestCorpus.length, 6);
  assert.equal(manifest.signals.authenticationDimension, "AuthenticationType");
  assert.equal(manifest.signals.cloudWatchFieldLogs, "absent because the frozen GraphQLApi has no LogConfig");
});
