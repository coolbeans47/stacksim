import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AppSyncClient,
  CreateApiKeyCommand,
  CreateDataSourceCommand,
  CreateGraphqlApiCommand,
  CreateResolverCommand,
  GetGraphqlApiCommand,
  GetIntrospectionSchemaCommand,
  GetSchemaCreationStatusCommand,
  ListApiKeysCommand,
  ListGraphqlApisCommand,
  StartSchemaCreationCommand,
} from "@aws-sdk/client-appsync";
import { StackSim } from "../src/server.js";
import { signedFetch } from "./helpers/signed-fetch.js";
import { emptyState, CURRENT_SCHEMA_VERSION } from "../src/migrations/v1-to-v2.js";
import { StateStore } from "../src/state.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function client(endpoint: string): AppSyncClient {
  return new AppSyncClient({ endpoint, region, credentials });
}

async function graphqlRequest(
  endpoint: string,
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
  });
}

test("APS-P0-001 uses the unmodified AppSync client, raw SigV4 REST, and the returned GraphQL URI", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-compat-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "enforce",
  });
  let appsync: AppSyncClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    appsync = client(endpoint);

    const created = await appsync.send(new CreateGraphqlApiCommand({
      name: "compatibility-api",
      authenticationType: "API_KEY",
      tags: { requirement: "APS-P0-001" },
    }));
    const api = created.graphqlApi!;
    assert.match(api.apiId ?? "", /^[a-f0-9]{26}$/);
    assert.equal(api.arn, `arn:aws:appsync:${region}:000000000000:apis/${api.apiId}`);
    assert.equal(api.authenticationType, "API_KEY");
    assert.equal(api.uris?.GRAPHQL, `${endpoint}/graphql/${region}/${api.apiId}`);

    const raw = await signedFetch(`${endpoint}/v1/apis`, {
      service: "appsync",
      region,
      credentials,
      method: "GET",
    });
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get("x-amzn-requestid") ?? "", /^[a-f0-9]{32}$/);
    const rawBody = await raw.json() as { graphqlApis: Array<{ apiId: string }> };
    assert.deepEqual(rawBody.graphqlApis.map(item => item.apiId), [api.apiId]);

    const schema = "type Query { hello: String }";
    const creation = await appsync.send(new StartSchemaCreationCommand({
      apiId: api.apiId,
      definition: Buffer.from(schema, "utf8"),
    }));
    assert.equal(creation.status, "PROCESSING");
    assert.equal((await appsync.send(new GetSchemaCreationStatusCommand({ apiId: api.apiId }))).status, "SUCCESS");

    await appsync.send(new CreateDataSourceCommand({
      apiId: api.apiId,
      name: "Local",
      type: "NONE",
    }));
    await appsync.send(new CreateResolverCommand({
      apiId: api.apiId,
      typeName: "Query",
      fieldName: "hello",
      dataSourceName: "Local",
      kind: "UNIT",
      requestMappingTemplate: '{"version":"2018-05-29","payload":"hello-local"}',
      responseMappingTemplate: "$util.toJson($ctx.result)",
    }));

    const introspection = await appsync.send(new GetIntrospectionSchemaCommand({
      apiId: api.apiId,
      format: "SDL",
    }));
    assert.match(Buffer.from(introspection.schema ?? []).toString("utf8"), /type Query/);

    const createdKey = await appsync.send(new CreateApiKeyCommand({
      apiId: api.apiId,
      description: "compatibility test",
    }));
    const apiKey = createdKey.apiKey?.id;
    assert.match(apiKey ?? "", /^da2-[A-Za-z0-9_-]+$/);

    const query = await graphqlRequest(api.uris!.GRAPHQL!, apiKey!, "{ hello __typename }");
    assert.equal(query.status, 200);
    assert.deepEqual(await query.json(), { data: { hello: "hello-local", __typename: "Query" } });

    const standardValidation = await graphqlRequest(api.uris!.GRAPHQL!, apiKey!, "{ missing }");
    assert.equal(standardValidation.status, 200);
    const validationBody = await standardValidation.json() as { errors: Array<{ message: string; locations: unknown[] }> };
    assert.match(validationBody.errors[0].message, /Cannot query field "missing"/);
    assert.ok(validationBody.errors[0].locations.length > 0);

    const unauthorized = await graphqlRequest(api.uris!.GRAPHQL!, "wrong-key", "not even graphql");
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), {
      errors: [{
        errorType: "UnauthorizedException",
        message: "You are not authorized to make this call.",
      }],
    });

    const listed = await appsync.send(new ListGraphqlApisCommand({}));
    assert.deepEqual(listed.graphqlApis?.map(item => item.apiId), [api.apiId]);

    const stateText = await readFile(join(root, "state.json"), "utf8");
    assert.doesNotMatch(stateText, new RegExp(apiKey!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(stateText, /not even graphql|missing\s*\}/);

    appsync.destroy();
    appsync = undefined;
    await simulator.stop();

    const restarted = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      region,
      authMode: "enforce",
    });
    try {
      await restarted.start();
      const restartedEndpoint = `http://127.0.0.1:${restarted.port}`;
      appsync = client(restartedEndpoint);
      const discovered = await appsync.send(new GetGraphqlApiCommand({ apiId: api.apiId }));
      assert.equal(discovered.graphqlApi?.uris?.GRAPHQL, `${restartedEndpoint}/graphql/${region}/${api.apiId}`);
      const keys = await appsync.send(new ListApiKeysCommand({ apiId: api.apiId }));
      assert.equal(keys.apiKeys?.[0].id, apiKey);
      const afterRestart = await graphqlRequest(discovered.graphqlApi!.uris!.GRAPHQL!, apiKey!, "{ __typename }");
      assert.equal(afterRestart.status, 200);
      assert.deepEqual(await afterRestart.json(), { data: { __typename: "Query" } });
    } finally {
      appsync?.destroy();
      appsync = undefined;
      await restarted.stop().catch(() => undefined);
    }
  } finally {
    appsync?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("APS-P0-001 scopes API keys to the GraphQL API before parsing the request", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-isolation-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
  });
  let appsync: AppSyncClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    appsync = client(endpoint);
    const first = (await appsync.send(new CreateGraphqlApiCommand({
      name: "first",
      authenticationType: "API_KEY",
    }))).graphqlApi!;
    const second = (await appsync.send(new CreateGraphqlApiCommand({
      name: "second",
      authenticationType: "API_KEY",
    }))).graphqlApi!;
    const firstKey = (await appsync.send(new CreateApiKeyCommand({ apiId: first.apiId }))).apiKey!.id!;
    const secondKeyForFirstApi = (await appsync.send(new CreateApiKeyCommand({ apiId: first.apiId }))).apiKey!.id!;

    const firstApiPage = await appsync.send(new ListGraphqlApisCommand({ maxResults: 1 }));
    assert.equal(firstApiPage.graphqlApis?.length, 1);
    assert.ok(firstApiPage.nextToken);
    const secondApiPage = await appsync.send(new ListGraphqlApisCommand({
      maxResults: 1,
      nextToken: firstApiPage.nextToken,
    }));
    assert.deepEqual(
      new Set([...firstApiPage.graphqlApis!, ...secondApiPage.graphqlApis!].map(api => api.apiId)),
      new Set([first.apiId, second.apiId]),
    );
    await assert.rejects(
      appsync.send(new ListGraphqlApisCommand({ nextToken: `${firstApiPage.nextToken}x` })),
      (error: any) => error.name === "BadRequestException",
    );

    const firstKeyPage = await appsync.send(new ListApiKeysCommand({ apiId: first.apiId, maxResults: 1 }));
    assert.equal(firstKeyPage.apiKeys?.length, 1);
    assert.ok(firstKeyPage.nextToken);
    const secondKeyPage = await appsync.send(new ListApiKeysCommand({
      apiId: first.apiId,
      maxResults: 1,
      nextToken: firstKeyPage.nextToken,
    }));
    assert.deepEqual(
      new Set([...firstKeyPage.apiKeys!, ...secondKeyPage.apiKeys!].map(key => key.id)),
      new Set([firstKey, secondKeyForFirstApi]),
    );

    const wrongApi = await graphqlRequest(second.uris!.GRAPHQL!, firstKey, "malformed");
    assert.equal(wrongApi.status, 401);
    assert.equal((await wrongApi.json() as any).errors[0].errorType, "UnauthorizedException");
  } finally {
    appsync?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("schema v64 migrates to the empty regional AppSync catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-migration-"));
  try {
    const legacy = emptyState();
    legacy.schemaVersion = 64;
    for (const account of Object.values(legacy.accounts)) {
      for (const regional of Object.values(account.regions)) delete (regional as any).appsync;
    }
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(store.regionState(region).appsync, { revision: 0, graphqlApis: {} });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema v65 adds generation-bound schema and NONE child catalogs", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-migration-v65-"));
  try {
    const legacy = emptyState();
    legacy.schemaVersion = 65;
    const apiId = "a".repeat(26);
    (legacy.accounts["000000000000"].regions[region].appsync.graphqlApis as any)[apiId] = {
      apiId,
      arn: `arn:aws:appsync:${region}:000000000000:apis/${apiId}`,
      name: "legacy",
      authenticationType: "API_KEY",
      uris: { GRAPHQL: "http://old/graphql", REALTIME: "ws://old/graphql/realtime" },
      tags: {},
      xrayEnabled: false,
      visibility: "GLOBAL",
      apiType: "GRAPHQL",
      owner: "000000000000",
      introspectionConfig: "ENABLED",
      queryDepthLimit: 0,
      resolverCountLimit: 0,
      createdAt: 100,
      revision: 1,
      schema: {
        definition: "type Query { hello: String }",
        status: "SUCCESS",
        activatedAt: 101,
      },
      schemaStatus: "SUCCESS",
      apiKeys: {},
    };
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    const migrated = store.regionState(region).appsync.graphqlApis[apiId];
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.match(migrated.generation, /^[a-f0-9-]{36}$/);
    assert.match(migrated.schema!.generation, /^[a-f0-9-]{36}$/);
    assert.match(migrated.schema!.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(migrated.dataSources, {});
    assert.deepEqual(migrated.resolvers, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema v66 adds AppSync child generations for scoped DynamoDB tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-migration-v66-"));
  try {
    const legacy = emptyState();
    legacy.schemaVersion = 66;
    const apiId = "b".repeat(26);
    (legacy.accounts["000000000000"].regions[region].appsync.graphqlApis as any)[apiId] = {
      apiId,
      generation: "api-generation",
      arn: `arn:aws:appsync:${region}:000000000000:apis/${apiId}`,
      name: "legacy-data-source",
      authenticationType: "API_KEY",
      uris: { GRAPHQL: "http://old/graphql", REALTIME: "ws://old/graphql/realtime" },
      tags: {},
      xrayEnabled: false,
      visibility: "GLOBAL",
      apiType: "GRAPHQL",
      owner: "000000000000",
      introspectionConfig: "ENABLED",
      queryDepthLimit: 0,
      resolverCountLimit: 0,
      createdAt: 100,
      updatedAt: 100,
      revision: 1,
      schemaStatus: "NOT_APPLICABLE",
      apiKeys: {},
      dataSources: {
        Local: {
          name: "Local",
          arn: `arn:aws:appsync:${region}:000000000000:apis/${apiId}/datasources/Local`,
          type: "NONE",
          createdAt: 100,
          updatedAt: 100,
          revision: 1,
        },
      },
      resolvers: {
        "Query.hello": {
          typeName: "Query",
          fieldName: "hello",
          arn: `arn:aws:appsync:${region}:000000000000:apis/${apiId}/types/Query/resolvers/hello`,
          dataSourceName: "Local",
          requestMappingTemplate: '{"version":"2018-05-29","payload":null}',
          responseMappingTemplate: "$util.toJson($ctx.result)",
          kind: "UNIT",
          runtime: "VTL",
          createdAt: 100,
          updatedAt: 100,
          revision: 1,
        },
      },
    };
    await writeFile(join(root, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(root);
    await store.load();
    const migrated = store.regionState(region).appsync.graphqlApis[apiId];
    assert.equal(store.state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.match(migrated.dataSources.Local.generation, /^[a-f0-9-]{36}$/);
    assert.match(migrated.resolvers["Query.hello"].generation, /^[a-f0-9-]{36}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
