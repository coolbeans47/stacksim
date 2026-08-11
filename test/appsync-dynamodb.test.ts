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
  DeleteResolverCommand,
  EvaluateMappingTemplateCommand,
  GetSchemaCreationStatusCommand,
  StartSchemaCreationCommand,
  UpdateDataSourceCommand,
} from "@aws-sdk/client-appsync";
import {
  CreateTableCommand,
  DeleteResourcePolicyCommand,
  DynamoDBClient,
  GetItemCommand,
  PutResourcePolicyCommand,
} from "@aws-sdk/client-dynamodb";
import {
  CreateRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

async function graphql(
  endpoint: string,
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<any> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function policy(actions: string[], resources: string | string[]): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: actions, Resource: resources }],
  });
}

test("APS-P0-007 through APS-P0-010 execute DynamoDB CRUD, query, scan, IAM, and scoped pagination", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-appsync-dynamodb-"));
  const clock = new TestClock(Date.now());
  let simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    clock,
    authMode: "enforce",
    cdkBootstrap: false,
  });
  const clients: Array<{ destroy(): void }> = [];
  try {
    await simulator.start();
    let endpoint = `http://127.0.0.1:${simulator.port}`;
    let appsync = new AppSyncClient({ endpoint, region, credentials, maxAttempts: 1 });
    let dynamodb = new DynamoDBClient({ endpoint, region, credentials, maxAttempts: 1 });
    const iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });
    const sts = new STSClient({ endpoint, region, credentials, maxAttempts: 1 });
    clients.push(appsync, dynamodb, iam, sts);

    const tableName = "AppSyncItems";
    const tableArn = `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`;
    await dynamodb.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "id", AttributeType: "S" },
        { AttributeName: "category", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [{
        IndexName: "by-category",
        KeySchema: [{ AttributeName: "category", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      }],
    }));
    await waitForTableActive(dynamodb, tableName, clock);

    const dataRoleName = "appsync-data";
    const dataRoleArn = `arn:aws:iam::${accountId}:role/${dataRoleName}`;
    const appsyncTrust = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: "appsync.amazonaws.com" },
        Action: "sts:AssumeRole",
      }],
    });
    await iam.send(new CreateRoleCommand({
      RoleName: dataRoleName,
      AssumeRolePolicyDocument: appsyncTrust,
    }));
    const dataActions = [
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
      "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan",
    ];
    await iam.send(new PutRolePolicyCommand({
      RoleName: dataRoleName,
      PolicyName: "table-access",
      PolicyDocument: policy(dataActions, [tableArn, `${tableArn}/index/by-category`]),
    }));

    const api = (await appsync.send(new CreateGraphqlApiCommand({
      name: "dynamodb-p0",
      authenticationType: "API_KEY",
    }))).graphqlApi!;
    const schema = `
      input ItemInput { id: ID!, category: String!, value: String!, count: Int! }
      type Item { id: ID!, category: String!, value: String!, count: Int! }
      type ItemConnection { items: [Item!]!, nextToken: String, scannedCount: Int! }
      type Query {
        get(id: ID!): Item
        projected(id: ID!): Item
        scan(limit: Int, nextToken: String): ItemConnection!
        filtered(category: String!, limit: Int): ItemConnection!
        byCategory(category: String!, limit: Int, nextToken: String): ItemConnection!
      }
      type Mutation {
        put(input: ItemInput!): Item!
        update(id: ID!, value: String!): Item!
        delete(id: ID!): Item
      }
    `;
    await appsync.send(new StartSchemaCreationCommand({
      apiId: api.apiId,
      definition: Buffer.from(schema),
    }));
    assert.equal((await appsync.send(new GetSchemaCreationStatusCommand({ apiId: api.apiId }))).status, "SUCCESS");

    const developerRoleName = "appsync-developer";
    const developerRoleArn = `arn:aws:iam::${accountId}:role/${developerRoleName}`;
    await iam.send(new CreateRoleCommand({
      RoleName: developerRoleName,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { AWS: `arn:aws:iam::${accountId}:root` },
          Action: "sts:AssumeRole",
        }],
      }),
    }));
    await iam.send(new PutRolePolicyCommand({
      RoleName: developerRoleName,
      PolicyName: "configure-appsync",
      PolicyDocument: policy(["appsync:CreateDataSource"], "*"),
    }));
    const session = await sts.send(new AssumeRoleCommand({
      RoleArn: developerRoleArn,
      RoleSessionName: "configure-appsync",
    }));
    const developer = new AppSyncClient({
      endpoint,
      region,
      maxAttempts: 1,
      credentials: {
        accessKeyId: session.Credentials!.AccessKeyId!,
        secretAccessKey: session.Credentials!.SecretAccessKey!,
        sessionToken: session.Credentials!.SessionToken!,
      },
    });
    clients.push(developer);
    const dataSourceInput = {
      apiId: api.apiId,
      name: "Items",
      type: "AMAZON_DYNAMODB" as const,
      serviceRoleArn: dataRoleArn,
      dynamodbConfig: { tableName, awsRegion: region, useCallerCredentials: false, versioned: false },
    };
    await assert.rejects(
      developer.send(new CreateDataSourceCommand(dataSourceInput)),
      (error: any) => error.name === "AccessDeniedException",
    );
    await iam.send(new PutRolePolicyCommand({
      RoleName: developerRoleName,
      PolicyName: "configure-appsync",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["appsync:CreateDataSource", "appsync:UpdateDataSource"],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: "iam:PassRole",
            Resource: dataRoleArn,
            Condition: { StringEquals: { "iam:PassedToService": "appsync.amazonaws.com" } },
          },
        ],
      }),
    }));
    const dataSource = (await developer.send(new CreateDataSourceCommand(dataSourceInput))).dataSource!;
    assert.equal(dataSource.type, "AMAZON_DYNAMODB");
    assert.equal(dataSource.serviceRoleArn, dataRoleArn);
    assert.deepEqual(dataSource.dynamodbConfig, {
      tableName,
      awsRegion: region,
    });
    assert.equal((await developer.send(new UpdateDataSourceCommand({
      ...dataSourceInput,
      description: "updated through the passed role",
    }))).dataSource?.description, "updated through the passed role");

    const evaluated = await appsync.send(new EvaluateMappingTemplateCommand({
      template: '#set($copy = {})$util.qr($copy.put("id", $ctx.args.id))$util.toJson($copy)',
      context: JSON.stringify({ arguments: { id: "evaluated" }, stash: {} }),
    }));
    assert.equal(evaluated.evaluationResult, '{"id":"evaluated"}');
    assert.equal(evaluated.stash, "{}");

    const response = `#if( $ctx.error )
  $util.error($ctx.error.message, $ctx.error.type)
#end
$util.toJson($ctx.result)`;
    const createResolver = (typeName: "Query" | "Mutation", fieldName: string, requestMappingTemplate: string) =>
      appsync.send(new CreateResolverCommand({
        apiId: api.apiId,
        typeName,
        fieldName,
        dataSourceName: "Items",
        kind: "UNIT",
        requestMappingTemplate,
        responseMappingTemplate: response,
      }));
    await createResolver("Mutation", "put", `{
      "version":"2018-05-29",
      "operation":"PutItem",
      "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.input.id)},
      "attributeValues":$util.dynamodb.toMapValuesJson($ctx.args.input)
    }`);
    await createResolver("Query", "get", `{
      "version":"2018-05-29",
      "operation":"GetItem",
      "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.id)},
      "consistentRead":true
    }`);
    await createResolver("Query", "projected", `{
      "version":"2017-02-28",
      "operation":"GetItem",
      "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.id)},
      "projection":{
        "expression":"#id, #value",
        "expressionNames":{"#id":"id","#value":"value"}
      }
    }`);
    await createResolver("Mutation", "update", `{
      "version":"2018-05-29",
      "operation":"UpdateItem",
      "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.id)},
      "update":{
        "expression":"SET #value = :value",
        "expressionNames":{"#value":"value"},
        "expressionValues":{":value":$util.dynamodb.toDynamoDBJson($ctx.args.value)}
      },
      "condition":{"expression":"attribute_exists(category)"}
    }`);
    await createResolver("Mutation", "delete", `{
      "version":"2018-05-29",
      "operation":"DeleteItem",
      "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.id)}
    }`);
    await createResolver("Query", "scan", `{
      "version":"2018-05-29",
      "operation":"Scan",
      "limit":$util.defaultIfNull($ctx.args.limit, 2),
      "nextToken":$util.toJson($ctx.args.nextToken)
    }`);
    await createResolver("Query", "filtered", `{
      "version":"2018-05-29",
      "operation":"Scan",
      "filter":{
        "expression":"#category = :category",
        "expressionNames":{"#category":"category"},
        "expressionValues":{":category":$util.dynamodb.toDynamoDBJson($ctx.args.category)}
      },
      "limit":$util.defaultIfNull($ctx.args.limit, 10)
    }`);
    await createResolver("Query", "byCategory", `{
      "version":"2018-05-29",
      "operation":"Query",
      "index":"by-category",
      "query":{
        "expression":"#category = :category",
        "expressionNames":{"#category":"category"},
        "expressionValues":{":category":$util.dynamodb.toDynamoDBJson($ctx.args.category)}
      },
      "scanIndexForward":false,
      "limit":$util.defaultIfNull($ctx.args.limit, 2),
      "nextToken":$util.toJson($ctx.args.nextToken)
    }`);

    const apiKey = (await appsync.send(new CreateApiKeyCommand({ apiId: api.apiId }))).apiKey!.id!;
    const put = async (id: string, category: string, value: string, count: number) =>
      graphql(api.uris!.GRAPHQL!, apiKey, `
        mutation Put($input: ItemInput!) {
          put(input: $input) { id category value count }
        }
      `, { input: { id, category, value, count } });
    assert.deepEqual(await put("a", "one", "first", 1), {
      data: { put: { id: "a", category: "one", value: "first", count: 1 } },
    });
    await put("b", "one", "second", 2);
    await put("c", "two", "third", 3);
    assert.deepEqual(await graphql(api.uris!.GRAPHQL!, apiKey, "{ get(id:\"a\") { id value count } }"), {
      data: { get: { id: "a", value: "first", count: 1 } },
    });
    assert.deepEqual(await graphql(api.uris!.GRAPHQL!, apiKey, "{ projected(id:\"a\") { id value } }"), {
      data: { projected: { id: "a", value: "first" } },
    });
    assert.deepEqual((await dynamodb.send(new GetItemCommand({
      TableName: tableName,
      Key: { id: { S: "a" } },
    }))).Item, {
      id: { S: "a" },
      category: { S: "one" },
      value: { S: "first" },
      count: { N: "1" },
    });

    const firstPage = await graphql(api.uris!.GRAPHQL!, apiKey, `
      query { scan(limit:1) { items { id } nextToken scannedCount } }
    `);
    assert.equal(firstPage.data.scan.items.length, 1);
    assert.ok(firstPage.data.scan.nextToken);
    assert.doesNotMatch(firstPage.data.scan.nextToken, /"id"|"S"/);
    const secondPage = await graphql(api.uris!.GRAPHQL!, apiKey, `
      query Page($token:String) { scan(limit:1,nextToken:$token) { items { id } nextToken } }
    `, { token: firstPage.data.scan.nextToken });
    assert.equal(secondPage.data.scan.items.length, 1);
    const tampered = await graphql(api.uris!.GRAPHQL!, apiKey, `
      query Page($token:String) { scan(limit:1,nextToken:$token) { items { id } } }
    `, { token: `${firstPage.data.scan.nextToken}x` });
    assert.equal(tampered.data, null);
    assert.equal(tampered.errors[0].extensions.errorType, "BadRequestException");
    const wrongResolver = await graphql(api.uris!.GRAPHQL!, apiKey, `
      query Page($token:String) {
        byCategory(category:"one",limit:1,nextToken:$token) { items { id } }
      }
    `, { token: firstPage.data.scan.nextToken });
    assert.equal(wrongResolver.data, null);
    assert.equal(wrongResolver.errors[0].extensions.errorType, "BadRequestException");

    const category = await graphql(api.uris!.GRAPHQL!, apiKey, `
      { byCategory(category:"one") { items { id category } nextToken } }
    `);
    assert.deepEqual(category.data.byCategory.items.map((item: any) => item.id), ["b", "a"]);
    const filtered = await graphql(api.uris!.GRAPHQL!, apiKey, `
      { filtered(category:"two") { items { id category } scannedCount } }
    `);
    assert.deepEqual(filtered.data.filtered.items, [{ id: "c", category: "two" }]);
    assert.equal(filtered.data.filtered.scannedCount, 3);
    const empty = await graphql(api.uris!.GRAPHQL!, apiKey, `
      { filtered(category:"missing") { items { id } nextToken scannedCount } }
    `);
    assert.deepEqual(empty.data.filtered, { items: [], nextToken: null, scannedCount: 3 });

    await iam.send(new PutRolePolicyCommand({
      RoleName: dataRoleName,
      PolicyName: "table-access",
      PolicyDocument: policy(
        dataActions.filter(action => action !== "dynamodb:UpdateItem"),
        [tableArn, `${tableArn}/index/by-category`],
      ),
    }));
    const denied = await graphql(api.uris!.GRAPHQL!, apiKey, `
      mutation { update(id:"a",value:"denied") { id value } }
    `);
    assert.equal(denied.data, null);
    assert.equal(denied.errors[0].extensions.errorType, "Unauthorized");
    await iam.send(new PutRolePolicyCommand({
      RoleName: dataRoleName,
      PolicyName: "table-access",
      PolicyDocument: policy(dataActions, [tableArn, `${tableArn}/index/by-category`]),
    }));
    assert.deepEqual(await graphql(api.uris!.GRAPHQL!, apiKey, `
      mutation { update(id:"a",value:"updated") { id value } }
    `), { data: { update: { id: "a", value: "updated" } } });
    const conditional = await graphql(api.uris!.GRAPHQL!, apiKey, `
      mutation { update(id:"missing",value:"never") { id value } }
    `);
    assert.equal(conditional.data, null);
    assert.equal(conditional.errors[0].extensions.errorType, "DynamoDB:ConditionalCheckFailedException");

    const resourceDeny = await dynamodb.send(new PutResourcePolicyCommand({
      ResourceArn: tableArn,
      ExpectedRevisionId: "NO_POLICY",
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Deny",
          Principal: { AWS: dataRoleArn },
          Action: "dynamodb:GetItem",
          Resource: tableArn,
        }],
      }),
    }));
    const resourceDenied = await graphql(api.uris!.GRAPHQL!, apiKey, "{ get(id:\"a\") { id } }");
    assert.equal(resourceDenied.data.get, null);
    assert.equal(resourceDenied.errors[0].extensions.errorType, "Unauthorized");
    clock.advance(15_000);
    await dynamodb.send(new DeleteResourcePolicyCommand({
      ResourceArn: tableArn,
      ExpectedRevisionId: resourceDeny.RevisionId,
    }));

    await iam.send(new UpdateAssumeRolePolicyCommand({
      RoleName: dataRoleName,
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: "sts:AssumeRole",
        }],
      }),
    }));
    const untrusted = await graphql(api.uris!.GRAPHQL!, apiKey, "{ get(id:\"a\") { id } }");
    assert.equal(untrusted.data.get, null);
    assert.equal(untrusted.errors[0].extensions.errorType, "Unauthorized");
    await iam.send(new UpdateAssumeRolePolicyCommand({
      RoleName: dataRoleName,
      PolicyDocument: appsyncTrust,
    }));

    const restartToken = secondPage.data.scan.nextToken;
    appsync.destroy();
    dynamodb.destroy();
    await simulator.stop();
    simulator = new StackSim({
      port: 0,
      invokePort: 0,
      dataDir: root,
      region,
      clock,
      authMode: "enforce",
      cdkBootstrap: false,
    });
    await simulator.start();
    endpoint = `http://127.0.0.1:${simulator.port}`;
    appsync = new AppSyncClient({ endpoint, region, credentials, maxAttempts: 1 });
    dynamodb = new DynamoDBClient({ endpoint, region, credentials, maxAttempts: 1 });
    clients.push(appsync, dynamodb);
    const afterRestart = await graphql(
      `${endpoint}/graphql/${region}/${api.apiId}`,
      apiKey,
      "query Page($token:String) { scan(limit:1,nextToken:$token) { items { id } } }",
      { token: restartToken },
    );
    assert.equal(afterRestart.data.scan.items.length, 1);
    await appsync.send(new DeleteResolverCommand({
      apiId: api.apiId,
      typeName: "Query",
      fieldName: "scan",
    }));
    await createResolver("Query", "scan", `{
      "version":"2018-05-29",
      "operation":"Scan",
      "limit":$util.defaultIfNull($ctx.args.limit, 2),
      "nextToken":$util.toJson($ctx.args.nextToken)
    }`);
    const staleGeneration = await graphql(
      `${endpoint}/graphql/${region}/${api.apiId}`,
      apiKey,
      "query Page($token:String) { scan(limit:1,nextToken:$token) { items { id } } }",
      { token: restartToken },
    );
    assert.equal(staleGeneration.data, null);
    assert.equal(staleGeneration.errors[0].extensions.errorType, "BadRequestException");

    const expiringPage = await graphql(
      `${endpoint}/graphql/${region}/${api.apiId}`,
      apiKey,
      "{ scan(limit:1) { items { id } nextToken } }",
    );
    assert.ok(expiringPage.data.scan.nextToken);
    clock.advance(60 * 60 * 1000 + 1);
    const expired = await graphql(
      `${endpoint}/graphql/${region}/${api.apiId}`,
      apiKey,
      "query Page($token:String) { scan(limit:1,nextToken:$token) { items { id } } }",
      { token: expiringPage.data.scan.nextToken },
    );
    assert.equal(expired.data, null);
    assert.equal(expired.errors[0].extensions.errorType, "BadRequestException");

    assert.deepEqual(await graphql(
      `${endpoint}/graphql/${region}/${api.apiId}`,
      apiKey,
      'mutation { delete(id:"a") { id value } }',
    ), { data: { delete: { id: "a", value: "updated" } } });
  } finally {
    for (const client of clients) client.destroy();
    await simulator.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
