import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { PrincipalContext } from "../src/auth/sigv4.js";
import { AppSyncService } from "../src/appsync.js";
import {
  APPSYNC_CLOUDFORMATION_RESOURCE_TYPES,
  createAppSyncCloudFormationProviders,
} from "../src/cloudformation/providers/appsync.js";
import type { ProviderContext } from "../src/cloudformation/providers/contract.js";
import { SystemClock } from "../src/core/clock.js";
import { StateStore } from "../src/state.js";

const accountId = "000000000000";
const region = "eu-west-1";
const identity: PrincipalContext = {
  accessKeyId: "admin",
  principalArn: `arn:aws:iam::${accountId}:root`,
  principalId: accountId,
  accountId,
};

function context(logicalId: string): ProviderContext {
  return {
    accountId,
    region,
    partition: "aws",
    stackId: `arn:aws:cloudformation:${region}:${accountId}:stack/appsync-provider-test/stack-id`,
    logicalId,
    operationId: `operation-${logicalId}`,
    resourceOperationId: `resource-${logicalId}`,
    idempotencyKey: `idempotency-${logicalId}`,
    deadlineAt: Date.now() + 60_000,
    principal: { identity },
  };
}

test("APS-03 and AMX-05 providers use the authoritative AppSync service for unit and VTL pipeline lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "stacksim-cfn-appsync-"));
  const store = new StateStore(root, accountId, region);
  await store.load();
  const appsync = new AppSyncService(store, region, new SystemClock(), () => "http://127.0.0.1:4566");
  await appsync.start();
  try {
    const providers = createAppSyncCloudFormationProviders(appsync, async location => {
      if (location === "s3://assets/function-request.vtl") return Buffer.from('{"version":"2018-05-29","payload":"pipeline"}');
      throw new Error(`Unexpected S3 asset ${location}`);
    });
    assert.deepEqual(providers.map(provider => provider.typeName).sort(), APPSYNC_CLOUDFORMATION_RESOURCE_TYPES);
    const byType = new Map(providers.map(provider => [provider.typeName, provider]));

    const api = byType.get("AWS::AppSync::GraphQLApi")!;
    assert.ok(api.validate({ Name: "provider-test", AuthenticationType: "AWS_IAM" }, context("Api")).length);
    assert.ok(api.validate({ Name: "provider-test", AuthenticationType: "API_KEY", AdditionalAuthenticationProviders: [{ AuthenticationType: "AMAZON_COGNITO_USER_POOLS" }] }, context("Api")).length);
    const apiModel = api.canonicalize({
      Name: "provider-test",
      AuthenticationType: "API_KEY",
      AdditionalAuthenticationProviders: [{ AuthenticationType: "AWS_IAM" }],
      XrayEnabled: false,
    }, context("Api"));
    const createdApi = await api.create(apiModel, context("Api"));
    assert.equal(createdApi.status, "SUCCESS");
    if (createdApi.status !== "SUCCESS") return;
    const apiId = String(api.ref(createdApi.model));
    assert.equal(api.getAtt(createdApi.model, "ApiId"), apiId);
    const readApi = await api.read(apiId, context("Api"));
    assert.equal(readApi.status, "SUCCESS");
    if (readApi.status === "SUCCESS") assert.deepEqual(
      readApi.model.properties.AdditionalAuthenticationProviders,
      [{ AuthenticationType: "AWS_IAM" }],
    );
    const withoutIam = api.canonicalize({ Name: "provider-test", AuthenticationType: "API_KEY", XrayEnabled: false }, context("Api"));
    assert.equal((await api.update(apiId, apiModel, withoutIam, context("Api"))).status, "SUCCESS");
    const readWithoutIam = await api.read(apiId, context("Api"));
    assert.equal(readWithoutIam.status, "SUCCESS");
    if (readWithoutIam.status === "SUCCESS") assert.equal(readWithoutIam.model.properties.AdditionalAuthenticationProviders, undefined);
    assert.equal((await api.update(apiId, withoutIam, apiModel, context("Api"))).status, "SUCCESS");

    const schema = byType.get("AWS::AppSync::GraphQLSchema")!;
    const generatedSchemaModel = schema.canonicalize({
      ApiId: apiId,
      Definition: await readFile(resolve("test/fixtures/amplify-gen2-data/evidence/assets/941821462168d0c1c15b579e764e675a5ed57595aa8875d0c10071b408b77513.graphql"), "utf8"),
    }, context("Schema"));
    const createdSchema = await schema.create(generatedSchemaModel, context("Schema"));
    assert.equal(createdSchema.status, "SUCCESS");
    const schemaModel = schema.canonicalize({ ApiId: apiId, Definition: "type Query { hello: String! }" }, context("Schema"));
    assert.equal((await schema.update(createdSchema.status === "SUCCESS" ? createdSchema.physicalId : "", generatedSchemaModel, schemaModel, context("Schema"))).status, "SUCCESS");

    const key = byType.get("AWS::AppSync::ApiKey")!;
    const keyModel = key.canonicalize({ ApiId: apiId, Description: "provider key" }, context("Key"));
    const createdKey = await key.create(keyModel, context("Key"));
    assert.equal(createdKey.status, "SUCCESS");
    if (createdKey.status !== "SUCCESS") return;
    assert.match(String(key.ref(createdKey.model)), /^da2-/);

    const dataSource = byType.get("AWS::AppSync::DataSource")!;
    const sourceModel = dataSource.canonicalize({ ApiId: apiId, Name: "Payload", Type: "NONE" }, context("DataSource"));
    const createdSource = await dataSource.create(sourceModel, context("DataSource"));
    assert.equal(createdSource.status, "SUCCESS");

    const resolver = byType.get("AWS::AppSync::Resolver")!;
    const resolverModel = resolver.canonicalize({
      ApiId: apiId,
      TypeName: "Query",
      FieldName: "hello",
      DataSourceName: "Payload",
      Kind: "UNIT",
      RequestMappingTemplate: '{"version":"2018-05-29","payload":"hello"}',
      ResponseMappingTemplate: "$util.toJson($ctx.result)",
    }, context("Resolver"));
    const createdResolver = await resolver.create(resolverModel, context("Resolver"));
    assert.equal(createdResolver.status, "SUCCESS");
    if (createdResolver.status !== "SUCCESS") return;
    assert.match(String(resolver.getAtt(createdResolver.model, "ResolverArn")), /resolvers\/hello$/);

    assert.equal((await resolver.read(createdResolver.physicalId, context("Resolver"))).status, "SUCCESS");
    assert.equal((await dataSource.read(createdSource.status === "SUCCESS" ? createdSource.physicalId : "", context("DataSource"))).status, "SUCCESS");
    assert.equal((await key.read(createdKey.physicalId, context("Key"))).status, "SUCCESS");
    assert.equal((await schema.read(createdSchema.status === "SUCCESS" ? createdSchema.physicalId : "", context("Schema"))).status, "SUCCESS");
    assert.equal((await api.read(apiId, context("Api"))).status, "SUCCESS");

    assert.equal((await resolver.delete(createdResolver.physicalId, resolverModel, context("Resolver"))).status, "SUCCESS");
    const functionProvider = byType.get("AWS::AppSync::FunctionConfiguration")!;
    assert.ok(functionProvider.validate({ ApiId: apiId, Name: "Bad", DataSourceName: "Payload", FunctionVersion: "1", Runtime: { Name: "APPSYNC_JS" } }, context("BadFunction")).length);
    const functionModel = functionProvider.canonicalize({
      ApiId: apiId, Name: "PipelineFunction", DataSourceName: "Payload", FunctionVersion: "2018-05-29",
      RequestMappingTemplateS3Location: "s3://assets/function-request.vtl", ResponseMappingTemplate: "$util.toJson($ctx.result)",
    }, context("Function"));
    const createdFunction = await functionProvider.create(functionModel, context("Function"));
    assert.equal(createdFunction.status, "SUCCESS"); if (createdFunction.status !== "SUCCESS") return;
    const functionId = String(functionProvider.getAtt(createdFunction.model, "FunctionId"));
    assert.match(String(functionProvider.ref(createdFunction.model)), /\/functions\//);
    assert.equal(functionProvider.getAtt(createdFunction.model, "FunctionId"), functionId);
    const pipelineModel = resolver.canonicalize({
      ApiId: apiId, TypeName: "Query", FieldName: "hello", Kind: "PIPELINE",
      PipelineConfig: { Functions: [functionId] }, RequestMappingTemplate: "{}", ResponseMappingTemplate: "$util.toJson($ctx.prev.result)",
    }, context("PipelineResolver"));
    const createdPipeline = await resolver.create(pipelineModel, context("PipelineResolver"));
    assert.equal(createdPipeline.status, "SUCCESS"); if (createdPipeline.status !== "SUCCESS") return;
    assert.equal((await resolver.read(createdPipeline.physicalId, context("PipelineResolver"))).status, "SUCCESS");
    assert.equal((await resolver.delete(createdPipeline.physicalId, pipelineModel, context("PipelineResolver"))).status, "SUCCESS");
    assert.equal((await functionProvider.delete(createdFunction.physicalId, functionModel, context("Function"))).status, "SUCCESS");
    assert.equal((await dataSource.delete(createdSource.status === "SUCCESS" ? createdSource.physicalId : "", sourceModel, context("DataSource"))).status, "SUCCESS");
    assert.equal((await key.delete(createdKey.physicalId, keyModel, context("Key"))).status, "SUCCESS");
    assert.equal((await api.delete(apiId, apiModel, context("Api"))).status, "SUCCESS");
    assert.equal((await api.read(apiId, context("Api"))).status, "NOT_FOUND");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
