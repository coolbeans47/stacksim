import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AppSyncClient, CreateApiKeyCommand, CreateDataSourceCommand, CreateFunctionCommand,
  CreateGraphqlApiCommand, CreateResolverCommand, DeleteFunctionCommand, GetFunctionCommand,
  GetSchemaCreationStatusCommand, ListFunctionsCommand, ListResolversByFunctionCommand,
  StartSchemaCreationCommand, UpdateFunctionCommand,
} from "@aws-sdk/client-appsync";
import { StackSim } from "../src/server.js";
import { migrateState } from "../src/migrations/index.js";
import { CURRENT_SCHEMA_VERSION, emptyState } from "../src/migrations/v1-to-v2.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const noneResponse = "$util.toJson($ctx.result)";

test("schema v70 migrates existing AppSync APIs to empty durable function catalogs", () => {
  const state = emptyState(); state.schemaVersion = 70;
  (state.accounts["000000000000"].regions[region].appsync.graphqlApis as any).api = { apiKeys: {}, dataSources: {}, resolvers: {} };
  const migrated = migrateState(state, "000000000000", region);
  assert.equal(migrated.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual((migrated.state.accounts["000000000000"].regions[region].appsync.graphqlApis as any).api.functions, {});
});

async function start(root: string): Promise<{ simulator: StackSim; client: AppSyncClient; endpoint: string }> {
  const simulator = new StackSim({ port: 0, invokePort: 0, dataDir: root, region, authMode: "off", cdkBootstrap: false });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  return { simulator, endpoint, client: new AppSyncClient({ endpoint, region, credentials, maxAttempts: 1 }) };
}

test("AMX-05 VTL functions and pipeline resolvers preserve ordered stash, prev, early return, revisions, and restart state", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-amx05-pipeline-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    running = await start(root);
    const api = (await running.client.send(new CreateGraphqlApiCommand({ name: "pipeline", authenticationType: "API_KEY" }))).graphqlApi!;
    await running.client.send(new StartSchemaCreationCommand({ apiId: api.apiId, definition: Buffer.from("type Query { pipeline(value: String!): String! }") }));
    assert.equal((await running.client.send(new GetSchemaCreationStatusCommand({ apiId: api.apiId }))).status, "SUCCESS");
    await running.client.send(new CreateDataSourceCommand({ apiId: api.apiId, name: "None", type: "NONE" }));
    const first = (await running.client.send(new CreateFunctionCommand({
      apiId: api.apiId, name: "First", dataSourceName: "None", functionVersion: "2018-05-29",
      requestMappingTemplate: '#set($ctx.stash.first = true)\n{"version":"2018-05-29","payload":"$ctx.prev.result.value-a"}',
      responseMappingTemplate: '$util.qr($util.appendError("warning", "PipelineWarning"))\n$util.toJson($ctx.result)',
    }))).functionConfiguration!;
    const early = (await running.client.send(new CreateFunctionCommand({
      apiId: api.apiId, name: "Early", dataSourceName: "None", functionVersion: "2018-05-29",
      requestMappingTemplate: '#return($util.toJson("$ctx.stash.first-early"))',
      responseMappingTemplate: '$util.toJson("wrong-response-template-result")',
    }))).functionConfiguration!;
    const last = (await running.client.send(new CreateFunctionCommand({
      apiId: api.apiId, name: "Last", dataSourceName: "None", functionVersion: "2018-05-29",
      requestMappingTemplate: '{"version":"2018-05-29","payload":"$ctx.prev.result-b"}', responseMappingTemplate: noneResponse,
    }))).functionConfiguration!;
    await running.client.send(new CreateResolverCommand({
      apiId: api.apiId, typeName: "Query", fieldName: "pipeline", kind: "PIPELINE",
      pipelineConfig: { functions: [first.functionId!, early.functionId!, last.functionId!] },
      requestMappingTemplate: '{"value":"$ctx.arguments.value"}', responseMappingTemplate: "$util.toJson($ctx.prev.result)",
    }));
    const key = (await running.client.send(new CreateApiKeyCommand({ apiId: api.apiId }))).apiKey!;
    const graph = await fetch(api.uris!.GRAPHQL!, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": key.id! },
      body: JSON.stringify({ query: "query($value:String!){ pipeline(value:$value) }", variables: { value: "seed" } }),
    });
    const graphBody = await graph.json() as any;
    assert.deepEqual(graphBody.data, { pipeline: "true-early-b" });
    assert.equal(graphBody.errors?.[0]?.extensions?.errorType, "PipelineWarning");

    assert.equal((await running.client.send(new GetFunctionCommand({ apiId: api.apiId, functionId: first.functionId }))).functionConfiguration?.functionId, first.functionId);
    assert.equal((await running.client.send(new ListFunctionsCommand({ apiId: api.apiId, maxResults: 2 }))).functions?.length, 2);
    assert.equal((await running.client.send(new ListResolversByFunctionCommand({ apiId: api.apiId, functionId: first.functionId }))).resolvers?.[0]?.fieldName, "pipeline");
    const internal = (running.simulator.store.regionState(region).appsync.graphqlApis[api.apiId!].functions as any)[first.functionId!];
    const oldDigest = internal.requestMappingTemplateDigest;
    const oldGeneration = internal.generation;
    await running.client.send(new UpdateFunctionCommand({
      apiId: api.apiId, functionId: first.functionId, name: "First", dataSourceName: "None", functionVersion: "2018-05-29",
      requestMappingTemplate: '{"version":"2018-05-29","payload":"changed"}', responseMappingTemplate: noneResponse,
    }));
    assert.equal(internal.revision, 2); assert.equal(internal.generation, oldGeneration); assert.notEqual(internal.requestMappingTemplateDigest, oldDigest);
    await assert.rejects(running.client.send(new DeleteFunctionCommand({ apiId: api.apiId, functionId: first.functionId })), /referenced/i);

    running.client.destroy(); await running.simulator.stop(); running = await start(root);
    assert.equal((await running.client.send(new GetFunctionCommand({ apiId: api.apiId, functionId: first.functionId }))).functionConfiguration?.requestMappingTemplate, '{"version":"2018-05-29","payload":"changed"}');
  } finally {
    running?.client.destroy(); await running?.simulator.stop().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});
