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
  GetSchemaCreationStatusCommand,
  StartSchemaCreationCommand,
  UpdateResolverCommand,
} from "@aws-sdk/client-appsync";
import {
  CreateTableCommand,
  DeleteResourcePolicyCommand,
  DeleteTableCommand,
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
import { TestClock } from "../src/core/clock.js";
import { StackSim } from "../src/server.js";
import { waitForTableActive } from "./support/dynamodb.js";

const region = "eu-west-1";
const accountId = "000000000000";
const credentials = { accessKeyId: "admin", secretAccessKey: "password" };

function policy(actions: string[], resources: string | string[]): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: actions, Resource: resources }],
  });
}

const defaultErrorResponse = `#if( $ctx.error )
  $util.error($ctx.error.message, $ctx.error.type)
#end
$util.toJson($ctx.result)`;

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

interface Harness {
  root: string;
  clock: TestClock;
  simulator: StackSim;
  appsync: AppSyncClient;
  dynamodb: DynamoDBClient;
  iam: IAMClient;
  endpoint: string;
  apiId: string;
  apiKey: string;
  tableName: string;
  tableArn: string;
  dataRoleName: string;
  dataRoleArn: string;
  appsyncTrust: string;
}

async function createHarness(root: string, clock: TestClock): Promise<Harness> {
  const simulator = new StackSim({
    port: 0,
    invokePort: 0,
    dataDir: root,
    region,
    clock,
    authMode: "enforce",
    cdkBootstrap: false,
  });
  await simulator.start();
  const endpoint = `http://127.0.0.1:${simulator.port}`;
  const appsync = new AppSyncClient({ endpoint, region, credentials, maxAttempts: 1 });
  const dynamodb = new DynamoDBClient({ endpoint, region, credentials, maxAttempts: 1 });
  const iam = new IAMClient({ endpoint, region, credentials, maxAttempts: 1 });

  const tableName = "Dug08Items";
  const tableArn = `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`;
  await dynamodb.send(new CreateTableCommand({
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
  }));
  await waitForTableActive(dynamodb, tableName, clock);

  const dataRoleName = "dug08-data";
  const dataRoleArn = `arn:aws:iam::${accountId}:role/${dataRoleName}`;
  const appsyncTrust = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Service: "appsync.amazonaws.com" },
      Action: "sts:AssumeRole",
    }],
  });
  await iam.send(new CreateRoleCommand({ RoleName: dataRoleName, AssumeRolePolicyDocument: appsyncTrust }));
  await iam.send(new PutRolePolicyCommand({
    RoleName: dataRoleName,
    PolicyName: "table-access",
    PolicyDocument: policy([
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
      "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan",
    ], tableArn),
  }));

  const api = (await appsync.send(new CreateGraphqlApiCommand({
    name: "dug08-error-response",
    authenticationType: "API_KEY",
  }))).graphqlApi!;
  const schema = `
    type Item { id: ID!, value: String! }
    type PartialItem { id: ID, value: String, handled: Boolean! }
    type Query {
      get(id: ID!): Item
      getPartial(id: ID!): PartialItem
      getMissing(id: ID!): Item
    }
    type Mutation {
      put(id: ID!, value: String!): Item!
      putPartial(id: ID!, value: String!): PartialItem
      putCommitted(id: ID!, value: String!): Item!
    }
  `;
  await appsync.send(new StartSchemaCreationCommand({
    apiId: api.apiId,
    definition: Buffer.from(schema),
  }));
  assert.equal((await appsync.send(new GetSchemaCreationStatusCommand({ apiId: api.apiId }))).status, "SUCCESS");
  await appsync.send(new CreateDataSourceCommand({
    apiId: api.apiId,
    name: "Items",
    type: "AMAZON_DYNAMODB",
    serviceRoleArn: dataRoleArn,
    dynamodbConfig: { tableName, awsRegion: region, useCallerCredentials: false, versioned: false },
  }));

  const apiKey = (await appsync.send(new CreateApiKeyCommand({ apiId: api.apiId }))).apiKey!.id!;
  return {
    root, clock, simulator, appsync, dynamodb, iam, endpoint,
    apiId: api.apiId!, apiKey, tableName, tableArn, dataRoleName, dataRoleArn, appsyncTrust,
  };
}

async function stopHarness(harness: Harness): Promise<void> {
  harness.appsync.destroy();
  harness.dynamodb.destroy();
  harness.iam.destroy();
  await harness.simulator.stop();
}

async function createUnitResolver(
  harness: Harness,
  typeName: "Query" | "Mutation",
  fieldName: string,
  requestMappingTemplate: string,
  responseMappingTemplate: string,
): Promise<void> {
  await harness.appsync.send(new CreateResolverCommand({
    apiId: harness.apiId,
    typeName,
    fieldName,
    dataSourceName: "Items",
    kind: "UNIT",
    requestMappingTemplate,
    responseMappingTemplate,
  }));
}

async function updateUnitResolver(
  harness: Harness,
  typeName: "Query" | "Mutation",
  fieldName: string,
  requestMappingTemplate: string,
  responseMappingTemplate: string,
): Promise<void> {
  await harness.appsync.send(new UpdateResolverCommand({
    apiId: harness.apiId,
    typeName,
    fieldName,
    dataSourceName: "Items",
    kind: "UNIT",
    requestMappingTemplate,
    responseMappingTemplate,
  }));
}

test("DUG-08 unit DynamoDB resolvers run response mappings for modeled failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-dug08-error-response-"));
  const clock = new TestClock(Date.now());
  let harness: Harness | undefined;
  try {
    harness = await createHarness(root, clock);
    const gql = (query: string, variables?: Record<string, unknown>) =>
      graphql(`${harness!.endpoint}/graphql/${region}/${harness!.apiId}`, harness!.apiKey, query, variables);

    const putRequest = `{
      "version":"2018-05-29",
      "operation":"PutItem",
      "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.id)},
      "attributeValues":{"value":$util.dynamodb.toDynamoDBJson($ctx.args.value)}
    }`;
    const getRequest = `{
      "version":"2018-05-29",
      "operation":"GetItem",
      "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.id)},
      "consistentRead":true
    }`;
    const conditionalPutRequest = `{
      "version":"2018-05-29",
      "operation":"PutItem",
      "key":{"id":$util.dynamodb.toDynamoDBJson($ctx.args.id)},
      "attributeValues":{"value":$util.dynamodb.toDynamoDBJson($ctx.args.value)},
      "condition":{"expression":"attribute_not_exists(id)"}
    }`;

    const transformResponse = `#if( $ctx.error )
  #if( $ctx.error.type == "DynamoDB:ConditionalCheckFailedException" )
    $util.toJson({"id": $ctx.args.id, "value": "handled", "handled": true})
  #else
    $util.error($ctx.error.message, $ctx.error.type)
  #end
#else
  $util.toJson({"id": $ctx.result.id, "value": $ctx.result.value, "handled": false})
#end`;

    await createUnitResolver(harness, "Mutation", "putPartial", conditionalPutRequest, transformResponse);
    await createUnitResolver(harness, "Mutation", "put", putRequest, defaultErrorResponse);
    await createUnitResolver(harness, "Mutation", "putCommitted", putRequest, defaultErrorResponse);
    await createUnitResolver(harness, "Query", "getPartial", getRequest, transformResponse);
    await createUnitResolver(harness, "Query", "getMissing", getRequest, defaultErrorResponse);

    const dynamodbService = harness.simulator.dynamodb as any;
    const originalPut = dynamodbService.PutItem.bind(dynamodbService);
    let putCalls = 0;
    dynamodbService.PutItem = async (input: any) => { putCalls++; return originalPut(input); };

    const malformedRequest = `#if($ctx.args.id == "bad-op")
$util.toJson({"version":"2018-05-29","operation":"UnsupportedOp"})
#else
${getRequest}
#end`;
    await createUnitResolver(harness, "Query", "get", malformedRequest, `#if($ctx.error)$util.toJson({"handled":true,"type":$ctx.error.type})#else$util.toJson({"handled":false})#end`);

    const malformed = await gql("{ get(id:\"bad-op\") { id value } }");
    assert.equal(malformed.data.get, null);
    assert.equal(malformed.errors[0].extensions.errorType, "MappingTemplate");
    assert.equal(putCalls, 0);

    const requestAppendResponse = `#if( $ctx.error )
  $util.toJson({"id": null, "value": "response-handled", "handled": true})
#else
  $util.toJson({"id": $ctx.result.id, "value": $ctx.result.value, "handled": false})
#end`;
    await updateUnitResolver(harness, "Query", "getPartial", `#if($ctx.args.id == "append-request")$util.appendError("request appended", "RequestAppended", null, {})#end
${getRequest}`, requestAppendResponse);
    await harness.iam.send(new PutRolePolicyCommand({
      RoleName: harness.dataRoleName,
      PolicyName: "table-access",
      PolicyDocument: policy(["dynamodb:PutItem"], harness.tableArn),
    }));
    const appendedRequest = await gql("{ getPartial(id:\"append-request\") { id value handled } }");
    assert.deepEqual(appendedRequest.data.getPartial, { id: null, value: "response-handled", handled: true });
    assert.equal(appendedRequest.errors.length, 1);
    assert.equal(appendedRequest.errors[0].extensions.errorType, "RequestAppended");
    await harness.iam.send(new PutRolePolicyCommand({
      RoleName: harness.dataRoleName,
      PolicyName: "table-access",
      PolicyDocument: policy([
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
        "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan",
      ], harness.tableArn),
    }));

    const swallowResponse = `#if( $ctx.error )
  $util.toJson({"id": null, "value": "swallowed", "handled": true})
#else
  $util.toJson({"id": $ctx.result.id, "value": $ctx.result.value, "handled": false})
#end`;
    await updateUnitResolver(harness, "Query", "getPartial", getRequest, swallowResponse);
    await harness.iam.send(new PutRolePolicyCommand({
      RoleName: harness.dataRoleName,
      PolicyName: "table-access",
      PolicyDocument: policy(["dynamodb:PutItem"], harness.tableArn),
    }));
    const swallowed = await gql("{ getPartial(id:\"missing\") { id value handled } }");
    assert.deepEqual(swallowed.data.getPartial, { id: null, value: "swallowed", handled: true });
    assert.equal(swallowed.errors, undefined);
    await harness.iam.send(new PutRolePolicyCommand({
      RoleName: harness.dataRoleName,
      PolicyName: "table-access",
      PolicyDocument: policy([
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
        "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan",
      ], harness.tableArn),
    }));

    await updateUnitResolver(harness, "Query", "getPartial", getRequest, transformResponse);
    const conditionalHandled = await gql(`mutation { putPartial(id:"dup", value:"first") { id value handled } }`);
    assert.deepEqual(conditionalHandled.data.putPartial, { id: "dup", value: "first", handled: false });
    const conditionalTransform = await gql(`mutation { putPartial(id:"dup", value:"second") { id value handled } }`);
    assert.deepEqual(conditionalTransform.data.putPartial, { id: "dup", value: "handled", handled: true });
    assert.equal(conditionalTransform.errors, undefined);

    const raiseResponse = `#if( $ctx.error )
  $util.error("raised: ${'$'}ctx.error.type", "RaisedError")
#end
$util.toJson($ctx.result)`;
    await updateUnitResolver(harness, "Query", "getPartial", getRequest, raiseResponse);
    await harness.iam.send(new PutRolePolicyCommand({
      RoleName: harness.dataRoleName,
      PolicyName: "table-access",
      PolicyDocument: policy(["dynamodb:PutItem"], harness.tableArn),
    }));
    const identityDenied = await gql("{ getPartial(id:\"a\") { id value handled } }");
    assert.equal(identityDenied.data.getPartial, null);
    assert.equal(identityDenied.errors[0].extensions.errorType, "RaisedError");
    assert.match(identityDenied.errors[0].message, /raised: Unauthorized/);
    assert.doesNotMatch(identityDenied.errors[0].message, /AccessDeniedException|arn:aws:/);
    await harness.iam.send(new PutRolePolicyCommand({
      RoleName: harness.dataRoleName,
      PolicyName: "table-access",
      PolicyDocument: policy([
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
        "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan",
      ], harness.tableArn),
    }));

    const appendResponse = `#if( $ctx.error )
  $util.appendError("appended: ${'$'}ctx.error.type", "AppendedError", null, {})
  $util.toJson({"id": null, "value": "partial", "handled": true})
#else
  $util.toJson({"id": $ctx.result.id, "value": $ctx.result.value, "handled": false})
#end`;
    await updateUnitResolver(harness, "Query", "getPartial", getRequest, appendResponse);
    await harness.iam.send(new PutRolePolicyCommand({
      RoleName: harness.dataRoleName,
      PolicyName: "table-access",
      PolicyDocument: policy(["dynamodb:PutItem"], harness.tableArn),
    }));
    const appendedFailure = await gql("{ getPartial(id:\"a\") { id value handled } }");
    assert.deepEqual(appendedFailure.data.getPartial, { id: null, value: "partial", handled: true });
    assert.equal(appendedFailure.errors[0].extensions.errorType, "AppendedError");
    await harness.iam.send(new PutRolePolicyCommand({
      RoleName: harness.dataRoleName,
      PolicyName: "table-access",
      PolicyDocument: policy([
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
        "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan",
      ], harness.tableArn),
    }));

    const missingItem = await gql("{ getMissing(id:\"absent\") { id value } }");
    assert.equal(missingItem.data.getMissing, null);
    assert.equal(missingItem.errors, undefined);

    const resourceDeny = await harness.dynamodb.send(new PutResourcePolicyCommand({
      ResourceArn: harness.tableArn,
      ExpectedRevisionId: "NO_POLICY",
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Deny",
          Principal: { AWS: harness.dataRoleArn },
          Action: "dynamodb:GetItem",
          Resource: harness.tableArn,
        }],
      }),
    }));
    harness.clock.advance(15_000);
    await updateUnitResolver(harness, "Query", "getPartial", getRequest, defaultErrorResponse);
    const resourceDenied = await gql("{ getPartial(id:\"a\") { id value handled } }");
    assert.equal(resourceDenied.data.getPartial, null);
    assert.equal(resourceDenied.errors[0].extensions.errorType, "Unauthorized");
    assert.doesNotMatch(resourceDenied.errors[0].message, /Policy|arn:aws:/);
    await harness.dynamodb.send(new DeleteResourcePolicyCommand({
      ResourceArn: harness.tableArn,
      ExpectedRevisionId: resourceDeny.RevisionId,
    }));

    await harness.iam.send(new UpdateAssumeRolePolicyCommand({
      RoleName: harness.dataRoleName,
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: "sts:AssumeRole",
        }],
      }),
    }));
    const roleAssumptionFailure = await gql("{ getPartial(id:\"a\") { id value handled } }");
    assert.equal(roleAssumptionFailure.data.getPartial, null);
    assert.equal(roleAssumptionFailure.errors[0].extensions.errorType, "Unauthorized");
    assert.match(roleAssumptionFailure.errors[0].message, /cannot assume/i);
    await harness.iam.send(new UpdateAssumeRolePolicyCommand({
      RoleName: harness.dataRoleName,
      PolicyDocument: harness.appsyncTrust,
    }));

    await harness.dynamodb.send(new DeleteTableCommand({ TableName: harness.tableName }));
    const missingTable = await gql("{ getPartial(id:\"a\") { id value handled } }");
    assert.equal(missingTable.data.getPartial, null);
    assert.equal(missingTable.errors[0].extensions.errorType, "DynamoDB:ResourceNotFoundException");
    assert.doesNotMatch(missingTable.errors[0].message, /DescribeTable|stack/i);

    await harness.dynamodb.send(new CreateTableCommand({
      TableName: harness.tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    }));
    await waitForTableActive(harness.dynamodb, harness.tableName, clock);

    const requestFailureTemplate = `#if($ctx.args.id == "request-failure")$util.error("request rejected", "InjectedRequest")#end
${putRequest}`;
    await updateUnitResolver(harness, "Mutation", "putCommitted", requestFailureTemplate, defaultErrorResponse);
    const putCallsBeforeCommitted = putCalls;
    const requestFailure = await gql(`mutation { putCommitted(id:"request-failure", value:"never") { id value } }`);
    assert.equal(requestFailure.data, null);
    assert.equal(requestFailure.errors[0].extensions.errorType, "InjectedRequest");
    assert.equal(putCalls, putCallsBeforeCommitted);

    const responseFailureTemplate = `#if($ctx.result.id == "committed-response")$util.error("after commit", "InjectedResponse")#end
$util.toJson($ctx.result)`;
    await updateUnitResolver(harness, "Mutation", "putCommitted", putRequest, responseFailureTemplate);
    const responseFailure = await gql(`mutation { putCommitted(id:"committed-response", value:"stored") { id value } }`);
    assert.equal(responseFailure.data, null);
    assert.equal(responseFailure.errors[0].extensions.errorType, "InjectedResponse");
    assert.equal(putCalls, putCallsBeforeCommitted + 1);
    assert.equal((await harness.dynamodb.send(new GetItemCommand({
      TableName: harness.tableName,
      Key: { id: { S: "committed-response" } },
    }))).Item?.value.S, "stored");

    const completionFailureTemplate = "$util.toJson({})";
    await updateUnitResolver(harness, "Mutation", "putCommitted", putRequest, completionFailureTemplate);
    const completionFailure = await gql(`mutation { putCommitted(id:"committed-completion", value:"stored-too") { id value } }`);
    assert.equal(completionFailure.data, null);
    assert.match(completionFailure.errors[0].message, /non-nullable field Item.id/);
    assert.equal(putCalls, putCallsBeforeCommitted + 2);
    assert.equal((await harness.dynamodb.send(new GetItemCommand({
      TableName: harness.tableName,
      Key: { id: { S: "committed-completion" } },
    }))).Item?.value.S, "stored-too");
  } finally {
    if (harness) await stopHarness(harness).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
