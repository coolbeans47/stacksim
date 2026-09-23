import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppSyncClient, CreateDataSourceCommand, CreateFunctionCommand, CreateGraphqlApiCommand, CreateResolverCommand, GetSchemaCreationStatusCommand, StartSchemaCreationCommand } from "@aws-sdk/client-appsync";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import type { TestClock } from "../../src/core/clock.js";
import { waitForTableActive } from "./dynamodb.js";

function intrinsic(value: any, refs: Record<string, string>, attributes: Record<string, Record<string, string>>): any {
  if (Array.isArray(value)) return value.map(item => intrinsic(item, refs, attributes));
  if (!value || typeof value !== "object") return value;
  if (value.Ref) return refs[value.Ref];
  if (value["Fn::GetAtt"]) { const [id, attribute] = value["Fn::GetAtt"]; return attributes[id]?.[attribute]; }
  if (value["Fn::Join"]) { const [separator, values] = value["Fn::Join"]; return values.map((item: any) => intrinsic(item, refs, attributes)).join(separator); }
  if (value["Fn::Split"]) { const [separator, source] = value["Fn::Split"]; return String(intrinsic(source, refs, attributes)).split(separator); }
  if (value["Fn::Select"]) { const [index, values] = value["Fn::Select"]; return intrinsic(values, refs, attributes)[Number(index)]; }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, intrinsic(item, refs, attributes)]));
}

/** Direct resources, unchanged generated templates. This is deliberately not an ampx deployment claim. */
export async function deployGeneratedAuthData(options: {
  fixture?: string; appsync: AppSyncClient; dynamodb: DynamoDBClient; iam: IAMClient;
  clock: TestClock; region: string; userPoolId: string; accountId?: string;
}) {
  const { appsync, dynamodb, iam, clock, region, userPoolId } = options;
  const accountId = options.accountId ?? "000000000000";
  const evidence = resolve("test/fixtures", options.fixture ?? "amplify-gen2-auth-data-owner", "evidence");
  const assets = join(evidence, "assets");
  const todo = JSON.parse(await readFile(join(evidence, "templates/todo.json"), "utf8"));
  const data = JSON.parse(await readFile(join(evidence, "templates/data.json"), "utf8"));
  const schemaResource = Object.values<any>(data.Resources).find(resource => resource.Type === "AWS::AppSync::GraphQLSchema")!;
  const schemaPath = JSON.stringify(schemaResource.Properties.DefinitionS3Location).match(/([0-9a-f]{64}\.graphql)/)![1];
  const api = (await appsync.send(new CreateGraphqlApiCommand({ name: "generated-owner", authenticationType: "AMAZON_COGNITO_USER_POOLS", userPoolConfig: { userPoolId, awsRegion: region, defaultAction: "ALLOW" }, additionalAuthenticationProviders: [{ authenticationType: "AWS_IAM" }] }))).graphqlApi!;
  await appsync.send(new StartSchemaCreationCommand({ apiId: api.apiId, definition: await readFile(join(assets, schemaPath)) }));
  const status = await appsync.send(new GetSchemaCreationStatusCommand({ apiId: api.apiId }));
  assert.equal(status.status, "SUCCESS", status.details);
  const tableName = `Todo-${api.apiId}-NONE`;
  const tableArn = `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`;
  await dynamodb.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }] }));
  await waitForTableActive(dynamodb, tableName, clock);
  const roleName = `owner-data-${api.apiId}`;
  const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
  await iam.send(new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "appsync.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }));
  await iam.send(new PutRolePolicyCommand({ RoleName: roleName, PolicyName: "Data", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:Query"], Resource: tableArn }] }) }));
  await appsync.send(new CreateDataSourceCommand({ apiId: api.apiId, name: "NONE_DS", type: "NONE" }));
  await appsync.send(new CreateDataSourceCommand({ apiId: api.apiId, name: "TodoTable", type: "AMAZON_DYNAMODB", serviceRoleArn: roleArn, dynamodbConfig: { tableName, awsRegion: region } }));
  const refs: Record<string, string> = { "AWS::Region": region };
  for (const name of Object.keys(todo.Parameters)) {
    if (name.endsWith("ApiId")) refs[name] = api.apiId!;
    else if (name.endsWith("Name")) refs[name] = "NONE_DS";
  }
  const attributes: Record<string, Record<string, string>> = { TodoTable: { TableArn: tableArn }, TodoDataSource: { Name: "TodoTable" } };
  const template = async (properties: any, phase: "Request" | "Response") => {
    const location = properties[`${phase}MappingTemplateS3Location`];
    if (!location) return intrinsic(properties[`${phase}MappingTemplate`], refs, attributes);
    const file = JSON.stringify(location).match(/([0-9a-f]{64}\.vtl)/)![1];
    return readFile(join(assets, file), "utf8");
  };
  for (const [logicalId, resource] of Object.entries<any>(todo.Resources)) {
    if (resource.Type !== "AWS::AppSync::FunctionConfiguration") continue;
    const properties = resource.Properties;
    const created = (await appsync.send(new CreateFunctionCommand({ apiId: api.apiId, name: properties.Name, dataSourceName: intrinsic(properties.DataSourceName, refs, attributes), functionVersion: properties.FunctionVersion, requestMappingTemplate: await template(properties, "Request"), responseMappingTemplate: await template(properties, "Response") }))).functionConfiguration!;
    attributes[logicalId] = { FunctionId: created.functionId! };
  }
  for (const resource of Object.values<any>(todo.Resources)) {
    if (resource.Type !== "AWS::AppSync::Resolver") continue;
    const properties = resource.Properties;
    await appsync.send(new CreateResolverCommand({ apiId: api.apiId, typeName: properties.TypeName, fieldName: properties.FieldName, kind: properties.Kind ?? "UNIT", ...(properties.DataSourceName ? { dataSourceName: intrinsic(properties.DataSourceName, refs, attributes) } : {}), ...(properties.PipelineConfig ? { pipelineConfig: { functions: intrinsic(properties.PipelineConfig.Functions, refs, attributes) } } : {}), requestMappingTemplate: await template(properties, "Request"), responseMappingTemplate: await template(properties, "Response") }));
  }
  const introspection = (await readdir(assets)).find(name => name.endsWith("-modelIntrospectionSchema.json"))!;
  return { api, tableName, modelIntrospection: JSON.parse(await readFile(join(assets, introspection), "utf8")) };
}
