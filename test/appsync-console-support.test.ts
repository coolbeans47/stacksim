import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AppSyncClient,
  CreateApiKeyCommand,
  CreateDataSourceCommand,
  CreateGraphqlApiCommand,
  CreateResolverCommand,
  GetSchemaCreationStatusCommand,
  StartSchemaCreationCommand,
} from "@aws-sdk/client-appsync";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  ListMetricsCommand,
} from "@aws-sdk/client-cloudwatch";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

test("APS-P0-013 and APS-P0-014 bound GraphQL diagnostics, redact secrets, and publish real AppSync metrics", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-console-support-"));
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    authMode: "off",
    cdkBootstrap: false,
  });
  let appsync: AppSyncClient | undefined;
  let cloudwatch: CloudWatchClient | undefined;
  try {
    await simulator.start();
    const options = {
      endpoint: `http://127.0.0.1:${simulator.port}`,
      region,
      credentials,
      maxAttempts: 1,
    };
    appsync = new AppSyncClient(options);
    cloudwatch = new CloudWatchClient(options);
    const caResponse = await fetch(`${options.endpoint}/_stacksim/appsync/ca.pem`);
    assert.equal(caResponse.status, 200);
    assert.equal(caResponse.headers.get("content-type"), "application/x-pem-file");
    assert.equal(caResponse.headers.get("content-disposition"), 'attachment; filename="stacksim-appsync-ca.pem"');
    assert.match(await caResponse.text(), /^-----BEGIN CERTIFICATE-----/);
    const api = (await appsync.send(new CreateGraphqlApiCommand({
      name: "console-support",
      authenticationType: "API_KEY",
    }))).graphqlApi!;
    await appsync.send(new StartSchemaCreationCommand({
      apiId: api.apiId,
      definition: Buffer.from("type Query { echo(value: String!): String! }"),
    }));
    assert.equal((await appsync.send(new GetSchemaCreationStatusCommand({
      apiId: api.apiId,
    }))).status, "SUCCESS");
    await appsync.send(new CreateDataSourceCommand({
      apiId: api.apiId,
      name: "Local",
      type: "NONE",
    }));
    await appsync.send(new CreateResolverCommand({
      apiId: api.apiId,
      typeName: "Query",
      fieldName: "echo",
      dataSourceName: "Local",
      kind: "UNIT",
      requestMappingTemplate: '{"version":"2018-05-29","payload":$util.toJson($ctx.arguments.value)}',
      responseMappingTemplate: "$util.toJson($ctx.result)",
    }));
    const key = (await appsync.send(new CreateApiKeyCommand({
      apiId: api.apiId,
    }))).apiKey!.id!;

    const secretValue = "sensitive-variable-value-must-not-persist";
    const success = await fetch(api.uris!.GRAPHQL!, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        query: "query Console($value: String!) { echo(value: $value) }",
        operationName: "Console",
        variables: { value: secretValue },
      }),
    });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { data: { echo: secretValue } });

    const queryMarker = "privateQueryMarker";
    const overDepth = `{ ${Array.from({ length: 76 }, () => `${queryMarker}: echo(value: "x") {`).join(" ")} __typename ${"}".repeat(76)} }`;
    const rejected = await fetch(api.uris!.GRAPHQL!, {
      method: "POST",
      headers: {
        authorization: "must-never-appear",
        "content-type": "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify({ query: overDepth, variables: { secretValue } }),
    });
    assert.equal(rejected.status, 400);
    const rejectedText = await rejected.text();
    assert.match(rejectedText, /QueryLimitExceeded/);
    assert.doesNotMatch(rejectedText, new RegExp(queryMarker));
    assert.doesNotMatch(rejectedText, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(rejectedText, /must-never-appear|sensitive-variable/);

    const tooManyFields = await fetch(api.uris!.GRAPHQL!, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        query: `{ ${Array.from({ length: 1001 }, (_, index) => `field${index}: echo(value: "x")`).join(" ")} }`,
      }),
    });
    assert.equal(tooManyFields.status, 400);
    assert.match(await tooManyFields.text(), /resolver-count limit of 1000/);

    const tooLargeQuery = await fetch(api.uris!.GRAPHQL!, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query: `{ echo(value: "x") }#${"q".repeat(256 * 1024)}` }),
    });
    assert.equal(tooLargeQuery.status, 413);
    assert.match(await tooLargeQuery.text(), /GraphQL query is too large/);

    const tooLargeVariables = await fetch(api.uris!.GRAPHQL!, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        query: "query Console($value: String!) { echo(value: $value) }",
        variables: { value: "v".repeat(256 * 1024) },
      }),
    });
    assert.equal(tooLargeVariables.status, 400);
    assert.match(await tooLargeVariables.text(), /bounded JSON object/);

    const largeResultValue = "r".repeat(250 * 1024);
    const tooLargeResult = await fetch(api.uris!.GRAPHQL!, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        query: "query Large($value: String!) { a: echo(value: $value) b: echo(value: $value) c: echo(value: $value) d: echo(value: $value) e: echo(value: $value) }",
        operationName: "Large",
        variables: { value: largeResultValue },
      }),
    });
    assert.equal(tooLargeResult.status, 413);
    const tooLargeResultText = await tooLargeResult.text();
    assert.match(tooLargeResultText, /ResponseTooLarge/);
    assert.doesNotMatch(tooLargeResultText, /rrrrrrrrrrrrrrrr/);

    const dimensions = [{ Name: "GraphQLAPIId", Value: api.apiId! }];
    const start = new Date(Date.now() - 60_000);
    const end = new Date(Date.now() + 60_000);
    const sum = async (metricName: string) =>
      (await cloudwatch!.send(new GetMetricStatisticsCommand({
        Namespace: "AWS/AppSync",
        MetricName: metricName,
        Dimensions: dimensions,
        StartTime: start,
        EndTime: end,
        Period: 60,
        Statistics: ["Sum"],
      }))).Datapoints?.[0].Sum;
    assert.equal(await sum("GraphQLRequestCount"), 6);
    assert.equal(await sum("4XXError"), 5);
    assert.equal(await sum("ResolverRequestCount"), 6);

    const listed = (await cloudwatch.send(new ListMetricsCommand({
      Namespace: "AWS/AppSync",
    }))).Metrics ?? [];
    assert.ok(listed.some(metric => metric.MetricName === "GraphQLRequestCount"));
    const metricMetadata = JSON.stringify(listed);
    const dimensionNames = new Set(listed.flatMap(metric =>
      (metric.Dimensions ?? []).map(dimension => dimension.Name)));
    assert.deepEqual(
      [...dimensionNames].sort(),
      ["AuthenticationType", "FieldName", "GraphQLAPIId", "TypeName"],
    );
    assert.doesNotMatch(metricMetadata, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(metricMetadata, /sensitive-variable|must-never-appear|privateQueryMarker/);

    const persisted = await readFile(join(root, "state.json"), "utf8");
    assert.doesNotMatch(persisted, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(persisted, /sensitive-variable|must-never-appear|privateQueryMarker/);
    for (const relative of await readdir(root, { recursive: true })) {
      let bytes: Buffer;
      try { bytes = await readFile(join(root, relative)); }
      catch { continue; }
      for (const marker of [key, secretValue, "must-never-appear", queryMarker]) {
        assert.equal(bytes.includes(Buffer.from(marker)), false, `${relative} retained ${marker}`);
      }
    }
  } finally {
    appsync?.destroy();
    cloudwatch?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
