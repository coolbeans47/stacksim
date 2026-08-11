import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AppSyncClient,
  CreateApiKeyCommand,
  CreateDataSourceCommand,
  CreateGraphqlApiCommand,
  CreateResolverCommand,
  DeleteDataSourceCommand,
  DeleteResolverCommand,
  GetDataSourceCommand,
  GetResolverCommand,
  GetSchemaCreationStatusCommand,
  ListDataSourcesCommand,
  ListResolversCommand,
  StartSchemaCreationCommand,
  UpdateDataSourceCommand,
  UpdateGraphqlApiCommand,
  UpdateResolverCommand,
} from "@aws-sdk/client-appsync";
import { StackSim } from "../src/server.js";

const region = "eu-west-1";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };
const requestArguments = '{"version":"2018-05-29","payload":$util.toJson($ctx.arguments)}';
const responseResult = "$util.toJson($ctx.result)";

async function request(
  endpoint: string,
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
  operationName?: string,
): Promise<any> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ query, ...(variables ? { variables } : {}), ...(operationName ? { operationName } : {}) }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("APS-P0-005 and APS-P0-006 execute standard GraphQL through NONE unit resolvers", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-graphql-"));
  const simulator = new StackSim({
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
    const controlEndpoint = `http://127.0.0.1:${simulator.port}`;
    client = new AppSyncClient({ endpoint: controlEndpoint, region, credentials, maxAttempts: 1 });
    const api = (await client.send(new CreateGraphqlApiCommand({
      name: "graphql-none",
      authenticationType: "API_KEY",
    }))).graphqlApi!;
    const schema = `
      scalar Custom
      enum Tone { LOUD QUIET }
      input NestedInput { value: String! }
      interface Named { name: String! }
      type Nested { value: String! }
      type Person implements Named { name: String! }
      union Search = Person
      type Echo {
        message: String!
        count: Int!
        nested: Nested!
        optional: String
        tone: Tone!
      }
      type Scalars { id: ID!, float: Float!, flag: Boolean! }
      type AwsValues {
        date: AWSDate!
        time: AWSTime!
        dateTime: AWSDateTime!
        timestamp: AWSTimestamp!
        email: AWSEmail!
        json: AWSJSON!
        url: AWSURL!
        phone: AWSPhone!
        ip: AWSIPAddress!
      }
      type Query {
        echo(message: String!, count: Int = 1, nested: NestedInput!, optional: String, tone: Tone = LOUD): Echo!
        numbers(values: [Int!]!): [Int!]!
        custom(value: Custom!): Custom!
        scalars(id: ID!, float: Float!, flag: Boolean!): Scalars!
        aws(
          date: AWSDate!, time: AWSTime!, dateTime: AWSDateTime!,
          timestamp: AWSTimestamp!, email: AWSEmail!, json: AWSJSON!,
          url: AWSURL!, phone: AWSPhone!, ip: AWSIPAddress!
        ): AwsValues!
        named: Named!
        search: Search!
        nullableFailure: String
        requiredFailure: String!
        missingResolver: String
      }
      type Mutation {
        first(message: String!, count: Int = 1, nested: NestedInput!, tone: Tone = LOUD): Echo!
        second(message: String!, count: Int = 1, nested: NestedInput!, tone: Tone = LOUD): Echo!
      }
    `;
    assert.equal((await client.send(new StartSchemaCreationCommand({
      apiId: api.apiId,
      definition: Buffer.from(schema),
    }))).status, "PROCESSING");
    assert.equal((await client.send(new GetSchemaCreationStatusCommand({ apiId: api.apiId }))).status, "SUCCESS");

    const dataSource = (await client.send(new CreateDataSourceCommand({
      apiId: api.apiId,
      name: "Local",
      description: "NONE payload handoff",
      type: "NONE",
    }))).dataSource!;
    assert.equal(dataSource.type, "NONE");
    assert.equal((await client.send(new GetDataSourceCommand({
      apiId: api.apiId,
      name: "Local",
    }))).dataSource?.dataSourceArn, dataSource.dataSourceArn);
    assert.deepEqual((await client.send(new ListDataSourcesCommand({
      apiId: api.apiId,
    }))).dataSources?.map(item => item.name), ["Local"]);
    assert.equal((await client.send(new UpdateDataSourceCommand({
      apiId: api.apiId,
      name: "Local",
      type: "NONE",
      description: "updated",
    }))).dataSource?.description, "updated");
    await client.send(new CreateDataSourceCommand({
      apiId: api.apiId,
      name: "Spare",
      type: "NONE",
    }));
    const firstDataSourcePage = await client.send(new ListDataSourcesCommand({
      apiId: api.apiId,
      maxResults: 1,
    }));
    assert.equal(firstDataSourcePage.dataSources?.length, 1);
    assert.ok(firstDataSourcePage.nextToken);
    const secondDataSourcePage = await client.send(new ListDataSourcesCommand({
      apiId: api.apiId,
      maxResults: 1,
      nextToken: firstDataSourcePage.nextToken,
    }));
    assert.deepEqual(
      new Set([...firstDataSourcePage.dataSources!, ...secondDataSourcePage.dataSources!].map(item => item.name)),
      new Set(["Local", "Spare"]),
    );

    const createResolver = (typeName: "Query" | "Mutation", fieldName: string, requestMappingTemplate = requestArguments) =>
      client!.send(new CreateResolverCommand({
        apiId: api.apiId,
        typeName,
        fieldName,
        dataSourceName: "Local",
        kind: "UNIT",
        requestMappingTemplate,
        responseMappingTemplate: responseResult,
      }));
    await createResolver("Query", "echo");
    await createResolver("Query", "numbers", '{"version":"2018-05-29","payload":$util.toJson($ctx.arguments.values)}');
    await createResolver("Query", "custom", '{"version":"2018-05-29","payload":$util.toJson($ctx.arguments.value)}');
    await createResolver("Query", "scalars");
    await createResolver("Query", "aws");
    await createResolver("Query", "named", '{"version":"2018-05-29","payload":{"__typename":"Person","name":"named"}}');
    await createResolver("Query", "search", '{"version":"2018-05-29","payload":{"__typename":"Person","name":"found"}}');
    await createResolver("Query", "nullableFailure", '{"version":"2018-05-29","payload":null}');
    await createResolver("Query", "requiredFailure", '{"version":"2018-05-29","payload":null}');
    await createResolver("Mutation", "first");
    await createResolver("Mutation", "second");

    assert.equal((await client.send(new GetResolverCommand({
      apiId: api.apiId,
      typeName: "Query",
      fieldName: "echo",
    }))).resolver?.kind, "UNIT");
    assert.deepEqual(
      new Set((await client.send(new ListResolversCommand({
        apiId: api.apiId,
        typeName: "Query",
      }))).resolvers?.map(resolver => resolver.fieldName)),
      new Set(["echo", "numbers", "custom", "scalars", "aws", "named", "search", "nullableFailure", "requiredFailure"]),
    );
    const firstResolverPage = await client.send(new ListResolversCommand({
      apiId: api.apiId,
      typeName: "Query",
      maxResults: 1,
    }));
    assert.equal(firstResolverPage.resolvers?.length, 1);
    assert.ok(firstResolverPage.nextToken);
    assert.equal((await client.send(new ListResolversCommand({
      apiId: api.apiId,
      typeName: "Query",
      maxResults: 1,
      nextToken: firstResolverPage.nextToken,
    }))).resolvers?.length, 1);

    const key = (await client.send(new CreateApiKeyCommand({ apiId: api.apiId }))).apiKey!.id!;
    const echo = await request(
      api.uris!.GRAPHQL!,
      key,
      `query Echo($message: String!, $show: Boolean!, $nested: NestedInput!) {
        alias: echo(message: $message, nested: $nested) {
          ...EchoFields
          optional @include(if: $show)
        }
      }
      fragment EchoFields on Echo { message count tone nested { value } }`,
      { message: "hello", show: false, nested: { value: "child" } },
      "Echo",
    );
    assert.deepEqual(echo, {
      data: {
        alias: {
          message: "hello",
          count: 1,
          tone: "LOUD",
          nested: { value: "child" },
        },
      },
    });

    assert.deepEqual(await request(api.uris!.GRAPHQL!, key, "{ numbers(values: [1, 2, 3]) }"), {
      data: { numbers: [1, 2, 3] },
    });
    assert.deepEqual(await request(
      api.uris!.GRAPHQL!,
      key,
      "query Custom($value: Custom!) { custom(value: $value) }",
      { value: "custom-value" },
    ), { data: { custom: "custom-value" } });
    assert.deepEqual(await request(
      api.uris!.GRAPHQL!,
      key,
      "query Scalars($id: ID!, $float: Float!, $flag: Boolean!) { scalars(id: $id, float: $float, flag: $flag) { id float flag } }",
      { id: 42, float: 1.5, flag: true },
    ), { data: { scalars: { id: "42", float: 1.5, flag: true } } });
    const awsVariables = {
      date: "2026-07-29",
      time: "12:34:56Z",
      dateTime: "2026-07-29T12:34:56Z",
      timestamp: 1785328496,
      email: "developer@example.com",
      json: JSON.stringify({ nested: true }),
      url: "https://example.com/path",
      phone: "+44 20 7946 0958",
      ip: "192.0.2.1/24",
    };
    assert.deepEqual(await request(
      api.uris!.GRAPHQL!,
      key,
      `query Aws(
        $date: AWSDate!, $time: AWSTime!, $dateTime: AWSDateTime!,
        $timestamp: AWSTimestamp!, $email: AWSEmail!, $json: AWSJSON!,
        $url: AWSURL!, $phone: AWSPhone!, $ip: AWSIPAddress!
      ) {
        aws(
          date: $date, time: $time, dateTime: $dateTime,
          timestamp: $timestamp, email: $email, json: $json,
          url: $url, phone: $phone, ip: $ip
        ) { date time dateTime timestamp email json url phone ip }
      }`,
      awsVariables,
      "Aws",
    ), {
      data: {
        aws: {
          ...awsVariables,
          json: { nested: true },
        },
      },
    });
    const invalidAwsDate = await request(
      api.uris!.GRAPHQL!,
      key,
      "query Invalid($date: AWSDate!) { aws(date:$date,time:\"12:34:56Z\",dateTime:\"2026-07-29T12:34:56Z\",timestamp:1,email:\"a@example.com\",json:\"{}\",url:\"https://example.com\",phone:\"+441234567890\",ip:\"192.0.2.1\") { date } }",
      { date: "2026-02-30" },
      "Invalid",
    );
    assert.match(invalidAwsDate.errors[0].message, /AWSDate/);
    assert.deepEqual(await request(api.uris!.GRAPHQL!, key, `
      {
        named { __typename name ... on Person { name } }
        search { __typename ... on Person { name } }
      }
    `), {
      data: {
        named: { __typename: "Person", name: "named" },
        search: { __typename: "Person", name: "found" },
      },
    });

    const selected = await request(
      api.uris!.GRAPHQL!,
      key,
      "query One { numbers(values:[1]) } query Two { numbers(values:[2]) }",
      undefined,
      "Two",
    );
    assert.deepEqual(selected, { data: { numbers: [2] } });
    const missingOperationName = await request(
      api.uris!.GRAPHQL!,
      key,
      "query One { numbers(values:[1]) } query Two { numbers(values:[2]) }",
    );
    assert.match(missingOperationName.errors[0].message, /operation name/i);

    const mutation = await request(api.uris!.GRAPHQL!, key, `
      mutation {
        first(message: "one", nested: { value: "a" }) { message nested { value } }
        second(message: "two", nested: { value: "b" }) { message nested { value } }
      }
    `);
    assert.deepEqual(mutation, {
      data: {
        first: { message: "one", nested: { value: "a" } },
        second: { message: "two", nested: { value: "b" } },
      },
    });

    const missing = await request(api.uris!.GRAPHQL!, key, "{ missingResolver }");
    assert.equal(missing.data.missingResolver, null);
    assert.equal(missing.errors[0].extensions.errorType, "ResolverNotFound");
    const nonNull = await request(api.uris!.GRAPHQL!, key, "{ nullableFailure requiredFailure }");
    assert.equal(nonNull.data, null);
    assert.deepEqual(nonNull.errors[0].path, ["requiredFailure"]);
    const validation = await request(api.uris!.GRAPHQL!, key, "{ echo(message: 4, nested: { value: \"x\" }) { message } }");
    assert.match(validation.errors[0].message, /String/);
    const malformed = await request(api.uris!.GRAPHQL!, key, "query {");
    assert.ok(malformed.errors[0].locations);
    const introspection = await request(api.uris!.GRAPHQL!, key, "{ __schema { queryType { name } } }");
    assert.equal(introspection.data.__schema.queryType.name, "Query");
    await client.send(new UpdateGraphqlApiCommand({
      apiId: api.apiId,
      name: "graphql-none",
      authenticationType: "API_KEY",
      introspectionConfig: "DISABLED",
    }));
    const disabledIntrospection = await request(api.uris!.GRAPHQL!, key, "{ __schema { queryType { name } } }");
    assert.match(disabledIntrospection.errors[0].message, /introspection/i);
    assert.deepEqual(await request(api.uris!.GRAPHQL!, key, "{ numbers(values: [4]) }"), {
      data: { numbers: [4] },
    });

    const updatedResolver = await client.send(new UpdateResolverCommand({
      apiId: api.apiId,
      typeName: "Query",
      fieldName: "nullableFailure",
      dataSourceName: "Local",
      kind: "UNIT",
      requestMappingTemplate: '{"version":"2018-05-29","payload":"updated"}',
      responseMappingTemplate: responseResult,
    }));
    assert.equal(updatedResolver.resolver?.fieldName, "nullableFailure");
    assert.deepEqual(await request(api.uris!.GRAPHQL!, key, "{ nullableFailure }"), {
      data: { nullableFailure: "updated" },
    });

    await assert.rejects(
      client.send(new CreateDataSourceCommand({ apiId: api.apiId, name: "Wrong", type: "AWS_LAMBDA" })),
      (error: any) => error.name === "BadRequestException",
    );
    await assert.rejects(
      client.send(new CreateResolverCommand({
        apiId: api.apiId,
        typeName: "Query",
        fieldName: "missing",
        dataSourceName: "Local",
        requestMappingTemplate: requestArguments,
        responseMappingTemplate: responseResult,
      })),
      (error: any) => error.name === "BadRequestException",
    );
    await assert.rejects(
      client.send(new CreateResolverCommand({
        apiId: api.apiId,
        typeName: "Query",
        fieldName: "missingResolver",
        dataSourceName: "Local",
        kind: "PIPELINE",
        requestMappingTemplate: requestArguments,
        responseMappingTemplate: responseResult,
      })),
      (error: any) => error.name === "BadRequestException",
    );
    await assert.rejects(
      client.send(new DeleteDataSourceCommand({ apiId: api.apiId, name: "Local" })),
      (error: any) => error.name === "BadRequestException",
    );
    for (const resolver of (await client.send(new ListResolversCommand({
      apiId: api.apiId,
      typeName: "Query",
    }))).resolvers ?? []) {
      await client.send(new DeleteResolverCommand({
        apiId: api.apiId,
        typeName: "Query",
        fieldName: resolver.fieldName,
      }));
    }
    for (const resolver of (await client.send(new ListResolversCommand({
      apiId: api.apiId,
      typeName: "Mutation",
    }))).resolvers ?? []) {
      await client.send(new DeleteResolverCommand({
        apiId: api.apiId,
        typeName: "Mutation",
        fieldName: resolver.fieldName,
      }));
    }
    await client.send(new DeleteDataSourceCommand({ apiId: api.apiId, name: "Local" }));
    await client.send(new DeleteDataSourceCommand({ apiId: api.apiId, name: "Spare" }));
    assert.deepEqual((await client.send(new ListDataSourcesCommand({ apiId: api.apiId }))).dataSources, []);
  } finally {
    client?.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
