import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AppSyncClient,
  CreateApiKeyCommand,
  CreateGraphqlApiCommand,
  DeleteApiKeyCommand,
  DeleteGraphqlApiCommand,
  GetGraphqlApiCommand,
  GetIntrospectionSchemaCommand,
  GetSchemaCreationStatusCommand,
  ListApiKeysCommand,
  ListGraphqlApisCommand,
  ListTagsForResourceCommand,
  StartSchemaCreationCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateApiKeyCommand,
  UpdateGraphqlApiCommand,
} from "@aws-sdk/client-appsync";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function graphql(endpoint: string, apiKey: string): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ query: "{ __typename }" }),
  });
}

test("APS-P0-002 through APS-P0-004 provide durable API, schema, tag, and key lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-lifecycle-"));
  const clock = new TestClock(Date.UTC(2026, 0, 1));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    clock,
    authMode: "off",
    cdkBootstrap: false,
  });
  let client: AppSyncClient | undefined;
  let otherRegion: AppSyncClient | undefined;
  try {
    await simulator.start();
    const endpoint = `http://127.0.0.1:${simulator.port}`;
    client = new AppSyncClient({ endpoint, region, credentials, maxAttempts: 1 });
    otherRegion = new AppSyncClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });

    const first = (await client.send(new CreateGraphqlApiCommand({
      name: "same-label",
      authenticationType: "API_KEY",
      additionalAuthenticationProviders: [{ authenticationType: "AWS_IAM" }],
      tags: { owner: "platform" },
    }))).graphqlApi!;
    const second = (await client.send(new CreateGraphqlApiCommand({
      name: "same-label",
      authenticationType: "API_KEY",
    }))).graphqlApi!;
    assert.notEqual(first.apiId, second.apiId);
    assert.deepEqual((await otherRegion.send(new ListGraphqlApisCommand({}))).graphqlApis, []);
    await assert.rejects(
      client.send(new CreateGraphqlApiCommand({ name: "unsupported-default", authenticationType: "AWS_IAM" })),
      (error: any) => error.name === "BadRequestException",
    );
    for (const authenticationType of ["AMAZON_COGNITO_USER_POOLS", "AWS_LAMBDA", "OPENID_CONNECT"] as const) {
      await assert.rejects(
        client.send(new CreateGraphqlApiCommand({
          name: `unsupported-${authenticationType}`,
          authenticationType: "API_KEY",
          additionalAuthenticationProviders: [{ authenticationType }],
        })),
        (error: any) => error.name === "BadRequestException",
      );
    }

    const updated = (await client.send(new UpdateGraphqlApiCommand({
      apiId: first.apiId,
      name: "renamed-api",
      authenticationType: "API_KEY",
      additionalAuthenticationProviders: [{ authenticationType: "AWS_IAM" }],
      introspectionConfig: "ENABLED",
    }))).graphqlApi!;
    assert.equal(updated.apiId, first.apiId);
    assert.equal(updated.arn, first.arn);
    assert.equal(updated.uris?.GRAPHQL, first.uris?.GRAPHQL);
    assert.equal(updated.name, "renamed-api");
    assert.deepEqual(updated.additionalAuthenticationProviders?.map(provider => provider.authenticationType), ["AWS_IAM"]);

    await client.send(new TagResourceCommand({
      resourceArn: first.arn,
      tags: { environment: "test" },
    }));
    assert.deepEqual((await client.send(new ListTagsForResourceCommand({
      resourceArn: first.arn,
    }))).tags, { environment: "test", owner: "platform" });
    await client.send(new UntagResourceCommand({
      resourceArn: first.arn,
      tagKeys: ["owner"],
    }));
    assert.deepEqual((await client.send(new ListTagsForResourceCommand({
      resourceArn: first.arn,
    }))).tags, { environment: "test" });

    const initialSchema = "type Query { initial: String }";
    assert.equal((await client.send(new StartSchemaCreationCommand({
      apiId: first.apiId,
      definition: Buffer.from(initialSchema),
    }))).status, "PROCESSING");
    assert.equal((await client.send(new GetSchemaCreationStatusCommand({ apiId: first.apiId }))).status, "SUCCESS");

    assert.equal((await client.send(new StartSchemaCreationCommand({
      apiId: first.apiId,
      definition: Buffer.from("type Query {"),
    }))).status, "PROCESSING");
    const failed = await client.send(new GetSchemaCreationStatusCommand({ apiId: first.apiId }));
    assert.equal(failed.status, "FAILED");
    assert.ok(failed.details);
    const preserved = Buffer.from((await client.send(new GetIntrospectionSchemaCommand({
      apiId: first.apiId,
      format: "SDL",
    }))).schema ?? []).toString("utf8");
    assert.match(preserved, /initial/);

    assert.equal((await client.send(new StartSchemaCreationCommand({
      apiId: first.apiId,
      definition: Buffer.from("type Query { current: String }"),
    }))).status, "PROCESSING");
    await assert.rejects(
      client.send(new StartSchemaCreationCommand({
        apiId: first.apiId,
        definition: Buffer.from("type Query { racing: String }"),
      })),
      (error: any) => error.name === "ConcurrentModificationException",
    );
    assert.equal((await client.send(new GetSchemaCreationStatusCommand({ apiId: first.apiId }))).status, "SUCCESS");

    const initialExpiry = Math.floor(clock.now() / 1000) + 2 * 3600;
    const createdKey = (await client.send(new CreateApiKeyCommand({
      apiId: first.apiId,
      description: "initial",
      expires: initialExpiry,
    }))).apiKey!;
    assert.equal((await graphql(first.uris!.GRAPHQL!, createdKey.id!)).status, 200);

    const extendedExpiry = Math.floor(clock.now() / 1000) + 4 * 3600;
    const updatedKey = (await client.send(new UpdateApiKeyCommand({
      apiId: first.apiId,
      id: createdKey.id,
      description: "extended",
      expires: extendedExpiry,
    }))).apiKey!;
    assert.equal(updatedKey.id, createdKey.id);
    assert.equal(updatedKey.description, "extended");
    clock.advance(3 * 3600 * 1000);
    assert.equal((await graphql(first.uris!.GRAPHQL!, createdKey.id!)).status, 200);
    clock.advance(2 * 3600 * 1000);
    assert.equal((await graphql(first.uris!.GRAPHQL!, createdKey.id!)).status, 401);

    const reinstated = (await client.send(new UpdateApiKeyCommand({
      apiId: first.apiId,
      id: createdKey.id,
      expires: Math.floor(clock.now() / 1000) + 2 * 3600,
    }))).apiKey!;
    assert.equal(reinstated.id, createdKey.id);
    assert.equal((await graphql(first.uris!.GRAPHQL!, createdKey.id!)).status, 200);

    const state = await readFile(join(root, "state.json"), "utf8");
    assert.doesNotMatch(state, new RegExp(createdKey.id!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await client.send(new DeleteApiKeyCommand({ apiId: first.apiId, id: createdKey.id }));
    assert.deepEqual((await client.send(new ListApiKeysCommand({ apiId: first.apiId }))).apiKeys, []);
    assert.equal((await graphql(first.uris!.GRAPHQL!, createdKey.id!)).status, 401);

    const finalKey = (await client.send(new CreateApiKeyCommand({ apiId: first.apiId }))).apiKey!;
    await client.send(new DeleteGraphqlApiCommand({ apiId: first.apiId }));
    await assert.rejects(
      client.send(new GetGraphqlApiCommand({ apiId: first.apiId })),
      (error: any) => error.name === "NotFoundException",
    );
    assert.equal((await graphql(first.uris!.GRAPHQL!, finalKey.id!)).status, 404);
    assert.deepEqual((await client.send(new ListGraphqlApisCommand({}))).graphqlApis?.map(api => api.apiId), [second.apiId]);
    assert.deepEqual((await readdir(join(root, "secrets", "appsync-materials"))), []);
  } finally {
    client?.destroy();
    otherRegion?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("APS-P0-003 completes a persisted PROCESSING schema generation after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-schema-restart-"));
  let simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    cdkBootstrap: false,
  });
  let client: AppSyncClient | undefined;
  try {
    await simulator.start();
    client = new AppSyncClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials,
      maxAttempts: 1,
    });
    const api = (await client.send(new CreateGraphqlApiCommand({
      name: "schema-restart",
      authenticationType: "API_KEY",
      additionalAuthenticationProviders: [{ authenticationType: "AWS_IAM" }],
    }))).graphqlApi!;
    assert.equal((await client.send(new StartSchemaCreationCommand({
      apiId: api.apiId,
      definition: Buffer.from("type Query { recovered: String }"),
    }))).status, "PROCESSING");
    client.destroy();
    client = undefined;
    await simulator.stop();

    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      region,
      authMode: "off",
      cdkBootstrap: false,
    });
    await simulator.start();
    client = new AppSyncClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials,
      maxAttempts: 1,
    });
    assert.equal((await client.send(new GetSchemaCreationStatusCommand({ apiId: api.apiId }))).status, "SUCCESS");
    assert.deepEqual((await client.send(new GetGraphqlApiCommand({ apiId: api.apiId }))).graphqlApi
      ?.additionalAuthenticationProviders?.map(provider => provider.authenticationType), ["AWS_IAM"]);
    assert.match(Buffer.from((await client.send(new GetIntrospectionSchemaCommand({
      apiId: api.apiId,
      format: "SDL",
    }))).schema ?? []).toString("utf8"), /recovered/);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("APS-P0-002 never discovers an API through another configured account", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-account-isolation-"));
  let simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    accountId: "111111111111",
    region,
    authMode: "off",
    cdkBootstrap: false,
  });
  let client: AppSyncClient | undefined;
  try {
    await simulator.start();
    client = new AppSyncClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials,
      maxAttempts: 1,
    });
    const firstAccountApi = (await client.send(new CreateGraphqlApiCommand({
      name: "first-account",
      authenticationType: "API_KEY",
    }))).graphqlApi!;
    const firstAccountKey = (await client.send(new CreateApiKeyCommand({
      apiId: firstAccountApi.apiId,
    }))).apiKey!.id!;
    assert.match(firstAccountApi.arn!, /:111111111111:/);
    client.destroy();
    client = undefined;
    await simulator.stop();

    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      accountId: "222222222222",
      region,
      authMode: "off",
      cdkBootstrap: false,
      defaultAccessKeyId: "account2-admin",
      defaultSecretAccessKey: "account2-password",
    });
    await simulator.start();
    client = new AppSyncClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials: { accessKeyId: "account2-admin", secretAccessKey: "account2-password" },
      maxAttempts: 1,
    });
    assert.deepEqual((await client.send(new ListGraphqlApisCommand({}))).graphqlApis, []);
    await assert.rejects(
      client.send(new GetGraphqlApiCommand({ apiId: firstAccountApi.apiId })),
      (error: any) => error.name === "NotFoundException",
    );
    client.destroy();
    client = undefined;
    await simulator.stop();

    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      accountId: "111111111111",
      region,
      authMode: "off",
      cdkBootstrap: false,
    });
    await simulator.start();
    client = new AppSyncClient({
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials,
      maxAttempts: 1,
    });
    const restored = (await client.send(new GetGraphqlApiCommand({
      apiId: firstAccountApi.apiId,
    }))).graphqlApi!;
    assert.equal((await graphql(restored.uris!.GRAPHQL!, firstAccountKey)).status, 400);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
