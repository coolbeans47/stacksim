import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateAppSyncVtl, validateAppSyncVtl } from "../src/appsync/vtl.js";

const evidence = join(process.cwd(), "test", "fixtures", "amplify-gen2-data", "evidence");

test("AMX-05C freezes and parses the exact generated VTL function/pipeline surface", async () => {
  const todo = JSON.parse(await readFile(join(evidence, "templates", "todo.json"), "utf8"));
  const data = JSON.parse(await readFile(join(evidence, "templates", "data.json"), "utf8"));
  const functions = Object.values(todo.Resources).filter((value: any) => value.Type === "AWS::AppSync::FunctionConfiguration") as any[];
  const resolvers = Object.values(todo.Resources).filter((value: any) => value.Type === "AWS::AppSync::Resolver") as any[];
  assert.equal(functions.length, 26); assert.equal(resolvers.length, 8);
  assert.ok(functions.every(value => value.Properties.FunctionVersion === "2018-05-29"));
  assert.ok(functions.every(value => value.Properties.Runtime === undefined && value.Properties.Code === undefined));
  assert.ok(resolvers.every(value => value.Properties.Kind === "PIPELINE" && Array.isArray(value.Properties.PipelineConfig?.Functions)));
  assert.ok(resolvers.every(value => value.Properties.DataSourceName === undefined && value.Properties.Runtime === undefined && value.Properties.Code === undefined));
  const api = Object.values(data.Resources).find((value: any) => value.Type === "AWS::AppSync::GraphQLApi") as any;
  assert.equal(api.Properties.LogConfig, undefined);

  const files = (await readdir(join(evidence, "assets"))).filter(name => name.endsWith(".vtl")).sort();
  assert.equal(files.length, 18);
  for (const file of files) validateAppSyncVtl(await readFile(join(evidence, "assets", file), "utf8"));
  const filter = { title: { eq: "exact" } };
  const subscription = evaluateAppSyncVtl(
    await readFile(join(evidence, "assets", "e0cff47fb007f0bbf2a4e43ca256d6aa7ec109821769fd79fa7c5e83f0e7f9fc.vtl"), "utf8"),
    { arguments: { filter }, source: null, result: null, error: null, identity: null, stash: {}, prev: { result: null } },
  );
  assert.deepEqual(subscription.subscriptionFilter, filter);
});
