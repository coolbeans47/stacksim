import { createHash } from "node:crypto";
import type { AppSyncService } from "../../appsync.js";
import { AwsError } from "../../errors.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";
import {
  CFN10_NO_TAGS,
  CFN10_RETENTION,
  CFN10_STACK_TAGS,
  cfn10GetAtt,
  cfn10Issue,
  cfn10Plan,
  cfn10Record,
  cfn10Same,
  cfn10Stable,
  cfn10Tags,
  cfn10TagMap,
} from "./cfn10-common.js";

export const APPSYNC_GRAPHQL_API_TYPE = "AWS::AppSync::GraphQLApi";
export const APPSYNC_GRAPHQL_SCHEMA_TYPE = "AWS::AppSync::GraphQLSchema";
export const APPSYNC_API_KEY_TYPE = "AWS::AppSync::ApiKey";
export const APPSYNC_DATA_SOURCE_TYPE = "AWS::AppSync::DataSource";
export const APPSYNC_FUNCTION_CONFIGURATION_TYPE = "AWS::AppSync::FunctionConfiguration";
export const APPSYNC_RESOLVER_TYPE = "AWS::AppSync::Resolver";

type Model = Record<string, any>;
type ReadAsset = (location: string) => Promise<Buffer>;

const apiSchema: ProviderSchema = Object.freeze({
  typeName: APPSYNC_GRAPHQL_API_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Name: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    AuthenticationType: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    AdditionalAuthenticationProviders: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    XrayEnabled: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
    Visibility: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    ApiType: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    IntrospectionConfig: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    QueryDepthLimit: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    ResolverCountLimit: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    OwnerContact: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "GraphQL API ID" }),
  attributes: Object.freeze({
    ApiId: Object.freeze({ valueType: "string" }),
    Arn: Object.freeze({ valueType: "string" }),
    GraphQLUrl: Object.freeze({ valueType: "string" }),
    RealtimeUrl: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: CFN10_RETENTION,
  tags: CFN10_STACK_TAGS,
});

const schemaSchema: ProviderSchema = Object.freeze({
  typeName: APPSYNC_GRAPHQL_SCHEMA_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ApiId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Definition: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    DefinitionS3Location: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "GraphQL API ID" }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "DELETE_BEFORE_CREATE", deleteBeforeCreateReason: "A GraphQL API has one active schema" }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

const keySchema: ProviderSchema = Object.freeze({
  typeName: APPSYNC_API_KEY_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ApiId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Expires: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "API key value" }),
  attributes: Object.freeze({ ApiKey: Object.freeze({ valueType: "string", sensitive: true }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

const dataSourceSchema: ProviderSchema = Object.freeze({
  typeName: APPSYNC_DATA_SOURCE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ApiId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Name: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Type: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    ServiceRoleArn: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    DynamoDBConfig: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Data source name" }),
  attributes: Object.freeze({
    DataSourceArn: Object.freeze({ valueType: "string" }),
    Name: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "DELETE_BEFORE_CREATE", deleteBeforeCreateReason: "Data-source names are unique within an API" }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

const resolverSchema: ProviderSchema = Object.freeze({
  typeName: APPSYNC_RESOLVER_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ApiId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    TypeName: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    FieldName: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    DataSourceName: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Kind: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    PipelineConfig: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    RequestMappingTemplate: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    RequestMappingTemplateS3Location: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    ResponseMappingTemplate: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    ResponseMappingTemplateS3Location: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Resolver ARN" }),
  attributes: Object.freeze({
    ResolverArn: Object.freeze({ valueType: "string" }),
    TypeName: Object.freeze({ valueType: "string" }),
    FieldName: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "DELETE_BEFORE_CREATE", deleteBeforeCreateReason: "A schema field has one resolver" }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

const functionSchema: ProviderSchema = Object.freeze({
  typeName: APPSYNC_FUNCTION_CONFIGURATION_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ApiId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Name: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    DataSourceName: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    FunctionVersion: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    RequestMappingTemplate: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    RequestMappingTemplateS3Location: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    ResponseMappingTemplate: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    ResponseMappingTemplateS3Location: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "AppSync function ARN" }),
  attributes: Object.freeze({
    FunctionId: Object.freeze({ valueType: "string" }), FunctionArn: Object.freeze({ valueType: "string" }),
    Name: Object.freeze({ valueType: "string" }), DataSourceName: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: CFN10_RETENTION,
  tags: CFN10_NO_TAGS,
});

function physical(kind: string, parts: readonly string[]): string {
  return `${kind}:${Buffer.from(JSON.stringify(parts)).toString("base64url")}`;
}

function parsePhysical(id: string, kind: string, count: number): string[] {
  try {
    if (!id.startsWith(`${kind}:`)) throw new Error();
    const result = JSON.parse(Buffer.from(id.slice(kind.length + 1), "base64url").toString("utf8"));
    if (!Array.isArray(result) || result.length !== count || result.some(item => typeof item !== "string" || !item)) throw new Error();
    return result;
  } catch {
    throw new AwsError("InvalidPhysicalResourceId", `Physical ID does not identify an AppSync ${kind}`, 400);
  }
}

function missing(error: unknown): boolean {
  return error instanceof AwsError && error.code === "NotFoundException";
}

function failed(error: unknown): ProviderUpdateResult<Model> {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}

function deleted(error: unknown, id: string): ProviderDeleteResult {
  return missing(error) ? { status: "NOT_FOUND", physicalId: id } : failed(error) as ProviderDeleteResult;
}

function success(id: string, properties: Model, attributes: Record<string, unknown> = {}) {
  return { status: "SUCCESS" as const, physicalId: id, model: { physicalId: id, properties, attributes } };
}

function validateTop(properties: unknown, schema: ProviderSchema): ProviderValidationIssue[] {
  return validateDeclaredProperties(properties ?? {}, schema);
}

function canonical(properties: unknown, schema: ProviderSchema): Model {
  if (!cfn10Record(properties)) throw new TypeError(`${schema.typeName} Properties must be an object`);
  const issues = validateTop(properties, schema);
  if (issues.length) throw new TypeError(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
  return cfn10Stable(structuredClone(properties));
}

function exactObject(
  value: unknown,
  path: string,
  fields: readonly string[],
  issues: ProviderValidationIssue[],
): value is Record<string, unknown> {
  if (!cfn10Record(value)) {
    cfn10Issue(issues, path, `${path} must be an object`);
    return false;
  }
  for (const field of Object.keys(value)) if (!fields.includes(field)) cfn10Issue(issues, `${path}.${field}`, `${field} is not supported`);
  return true;
}

function validateApi(properties: unknown): ProviderValidationIssue[] {
  const issues = validateTop(properties, apiSchema);
  if (!cfn10Record(properties)) return issues;
  if (properties.AuthenticationType !== "API_KEY") cfn10Issue(issues, "Properties.AuthenticationType", "Only API_KEY authorization is supported");
  if (properties.AdditionalAuthenticationProviders !== undefined) {
    if (!Array.isArray(properties.AdditionalAuthenticationProviders)
      || properties.AdditionalAuthenticationProviders.length > 1
      || (properties.AdditionalAuthenticationProviders.length === 1
        && (!exactObject(
          properties.AdditionalAuthenticationProviders[0],
          "Properties.AdditionalAuthenticationProviders[0]",
          ["AuthenticationType"],
          issues,
        )
        || properties.AdditionalAuthenticationProviders[0].AuthenticationType !== "AWS_IAM"))) {
      cfn10Issue(
        issues,
        "Properties.AdditionalAuthenticationProviders",
        "AMX-06 supports an empty list or exactly [{ AuthenticationType: AWS_IAM }]",
      );
    }
  }
  if (properties.XrayEnabled !== undefined && properties.XrayEnabled !== false) cfn10Issue(issues, "Properties.XrayEnabled", "X-Ray is not supported");
  if (properties.Visibility !== undefined && properties.Visibility !== "GLOBAL") cfn10Issue(issues, "Properties.Visibility", "Private APIs are not supported");
  if (properties.ApiType !== undefined && properties.ApiType !== "GRAPHQL") cfn10Issue(issues, "Properties.ApiType", "Only GRAPHQL APIs are supported");
  if (properties.IntrospectionConfig !== undefined && !["ENABLED", "DISABLED"].includes(String(properties.IntrospectionConfig))) cfn10Issue(issues, "Properties.IntrospectionConfig", "IntrospectionConfig must be ENABLED or DISABLED");
  if (properties.QueryDepthLimit !== undefined && properties.QueryDepthLimit !== 0) cfn10Issue(issues, "Properties.QueryDepthLimit", "Nonzero query depth limits are not supported");
  if (properties.ResolverCountLimit !== undefined && properties.ResolverCountLimit !== 0) cfn10Issue(issues, "Properties.ResolverCountLimit", "Nonzero resolver count limits are not supported");
  try { cfn10Tags(properties.Tags); } catch (error) { cfn10Issue(issues, "Properties.Tags", error instanceof Error ? error.message : String(error)); }
  return issues;
}

function validateSchemaResource(properties: unknown): ProviderValidationIssue[] {
  const issues = validateTop(properties, schemaSchema);
  if (!cfn10Record(properties)) return issues;
  if ((properties.Definition === undefined) === (properties.DefinitionS3Location === undefined)) cfn10Issue(issues, "Properties", "Specify exactly one of Definition or DefinitionS3Location");
  return issues;
}

function validateDataSource(properties: unknown): ProviderValidationIssue[] {
  const issues = validateTop(properties, dataSourceSchema);
  if (!cfn10Record(properties)) return issues;
  if (!["NONE", "AMAZON_DYNAMODB"].includes(String(properties.Type))) cfn10Issue(issues, "Properties.Type", "Only NONE and AMAZON_DYNAMODB data sources are supported");
  if (properties.Type === "NONE" && (properties.ServiceRoleArn !== undefined || properties.DynamoDBConfig !== undefined)) cfn10Issue(issues, "Properties", "NONE data sources do not accept ServiceRoleArn or DynamoDBConfig");
  if (properties.Type === "AMAZON_DYNAMODB") {
    if (typeof properties.ServiceRoleArn !== "string") cfn10Issue(issues, "Properties.ServiceRoleArn", "ServiceRoleArn is required for DynamoDB");
    if (exactObject(properties.DynamoDBConfig, "Properties.DynamoDBConfig", ["TableName", "AwsRegion", "UseCallerCredentials", "Versioned"], issues)) {
      if (typeof properties.DynamoDBConfig.TableName !== "string") cfn10Issue(issues, "Properties.DynamoDBConfig.TableName", "TableName is required");
      if (typeof properties.DynamoDBConfig.AwsRegion !== "string") cfn10Issue(issues, "Properties.DynamoDBConfig.AwsRegion", "AwsRegion is required");
      if (properties.DynamoDBConfig.UseCallerCredentials !== undefined && properties.DynamoDBConfig.UseCallerCredentials !== false) cfn10Issue(issues, "Properties.DynamoDBConfig.UseCallerCredentials", "Caller credentials are not supported");
      if (properties.DynamoDBConfig.Versioned !== undefined && properties.DynamoDBConfig.Versioned !== false) cfn10Issue(issues, "Properties.DynamoDBConfig.Versioned", "Versioned data sources are not supported");
    }
  }
  return issues;
}

function validateResolver(properties: unknown): ProviderValidationIssue[] {
  const issues = validateTop(properties, resolverSchema);
  if (!cfn10Record(properties)) return issues;
  const kind = properties.Kind ?? "UNIT";
  if (!["UNIT", "PIPELINE"].includes(String(kind))) cfn10Issue(issues, "Properties.Kind", "Kind must be UNIT or PIPELINE");
  if (kind === "UNIT" && typeof properties.DataSourceName !== "string") cfn10Issue(issues, "Properties.DataSourceName", "DataSourceName is required for UNIT resolvers");
  if (kind === "UNIT" && properties.PipelineConfig !== undefined) cfn10Issue(issues, "Properties.PipelineConfig", "PipelineConfig is not valid for UNIT resolvers");
  if (kind === "PIPELINE" && properties.DataSourceName !== undefined) cfn10Issue(issues, "Properties.DataSourceName", "DataSourceName is not valid for PIPELINE resolvers");
  if (kind === "PIPELINE" && exactObject(properties.PipelineConfig, "Properties.PipelineConfig", ["Functions"], issues)) {
    const functions = properties.PipelineConfig.Functions;
    if (!Array.isArray(functions) || functions.length < 1 || functions.length > 10 || functions.some(value => typeof value !== "string" || !value)) {
      cfn10Issue(issues, "Properties.PipelineConfig.Functions", "Functions must contain from 1 through 10 function IDs");
    }
  }
  for (const prefix of ["Request", "Response"]) {
    const inline = properties[`${prefix}MappingTemplate`];
    const s3 = properties[`${prefix}MappingTemplateS3Location`];
    if ((inline === undefined) === (s3 === undefined)) cfn10Issue(issues, "Properties", `Specify exactly one ${prefix} mapping template source`);
  }
  return issues;
}

function validateFunction(properties: unknown): ProviderValidationIssue[] {
  const issues = validateTop(properties, functionSchema);
  if (!cfn10Record(properties)) return issues;
  if (properties.FunctionVersion !== "2018-05-29") cfn10Issue(issues, "Properties.FunctionVersion", "Only VTL function version 2018-05-29 is supported");
  for (const prefix of ["Request", "Response"]) {
    const inline = properties[`${prefix}MappingTemplate`];
    const s3 = properties[`${prefix}MappingTemplateS3Location`];
    if ((inline === undefined) === (s3 === undefined)) cfn10Issue(issues, "Properties", `Specify exactly one ${prefix} mapping template source`);
  }
  return issues;
}

function issueCanonical(properties: unknown, schema: ProviderSchema, validate: (value: unknown) => ProviderValidationIssue[]): Model {
  if (!cfn10Record(properties)) throw new TypeError(`${schema.typeName} Properties must be an object`);
  const issues = validate(properties);
  if (issues.length) throw new TypeError(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
  return cfn10Stable(structuredClone(properties));
}

async function assetText(inline: unknown, location: unknown, readAsset: ReadAsset, label: string): Promise<string> {
  if (typeof inline === "string") return inline;
  if (typeof location !== "string") throw new AwsError("InvalidProperty", `${label} requires inline text or an S3 location`, 400);
  const bytes = await readAsset(location);
  if (!bytes.length || bytes.length > 1024 * 1024) throw new AwsError("InvalidProperty", `${label} S3 object is empty or too large`, 400);
  return bytes.toString("utf8");
}

function apiInput(model: Model, context: ProviderContext): Model {
  return {
    name: model.Name,
    authenticationType: model.AuthenticationType,
    additionalAuthenticationProviders: (model.AdditionalAuthenticationProviders ?? []).map((provider: Model) => ({
      authenticationType: provider.AuthenticationType,
    })),
    tags: cfn10TagMap(cfn10Tags(model.Tags), context),
    xrayEnabled: model.XrayEnabled ?? false,
    visibility: model.Visibility ?? "GLOBAL",
    apiType: model.ApiType ?? "GRAPHQL",
    introspectionConfig: model.IntrospectionConfig ?? "ENABLED",
    queryDepthLimit: model.QueryDepthLimit ?? 0,
    resolverCountLimit: model.ResolverCountLimit ?? 0,
    ...(model.OwnerContact === undefined ? {} : { ownerContact: model.OwnerContact }),
  };
}

function apiModel(value: Model): Model {
  return cfn10Stable({
    Name: value.name,
    AuthenticationType: value.authenticationType,
    ...((value.additionalAuthenticationProviders ?? []).length ? {
      AdditionalAuthenticationProviders: value.additionalAuthenticationProviders.map((provider: Model) => ({
        AuthenticationType: provider.authenticationType,
      })),
    } : {}),
    XrayEnabled: Boolean(value.xrayEnabled),
    Visibility: value.visibility,
    ApiType: value.apiType,
    IntrospectionConfig: value.introspectionConfig,
    QueryDepthLimit: value.queryDepthLimit,
    ResolverCountLimit: value.resolverCountLimit,
    ...(value.ownerContact === undefined ? {} : { OwnerContact: value.ownerContact }),
    Tags: Object.entries(value.tags ?? {}).filter(([key]) => key !== "stacksim:cloudformation:owner").map(([Key, Value]) => ({ Key, Value })).sort((a, b) => a.Key.localeCompare(b.Key)),
  });
}

function dataSourceInput(model: Model): Model {
  return {
    name: model.Name,
    type: model.Type,
    ...(model.Description === undefined ? {} : { description: model.Description }),
    ...(model.ServiceRoleArn === undefined ? {} : { serviceRoleArn: model.ServiceRoleArn }),
    ...(model.DynamoDBConfig === undefined ? {} : {
      dynamodbConfig: {
        tableName: model.DynamoDBConfig.TableName,
        awsRegion: model.DynamoDBConfig.AwsRegion,
        useCallerCredentials: model.DynamoDBConfig.UseCallerCredentials ?? false,
        versioned: model.DynamoDBConfig.Versioned ?? false,
      },
    }),
  };
}

function dataSourceModel(apiId: string, value: Model): Model {
  return cfn10Stable({
    ApiId: apiId,
    Name: value.name,
    Type: value.type,
    ...(value.description === undefined ? {} : { Description: value.description }),
    ...(value.serviceRoleArn === undefined ? {} : { ServiceRoleArn: value.serviceRoleArn }),
    ...(value.dynamodbConfig === undefined ? {} : {
      DynamoDBConfig: {
        TableName: value.dynamodbConfig.tableName,
        AwsRegion: value.dynamodbConfig.awsRegion,
        UseCallerCredentials: false,
        Versioned: false,
      },
    }),
  });
}

function resolverInput(model: Model, request: string, response: string, create: boolean): Model {
  return {
    ...(create ? { fieldName: model.FieldName } : {}),
    ...(model.DataSourceName === undefined ? {} : { dataSourceName: model.DataSourceName }),
    ...(model.PipelineConfig === undefined ? {} : { pipelineConfig: { functions: model.PipelineConfig.Functions } }),
    kind: model.Kind ?? "UNIT",
    requestMappingTemplate: request,
    responseMappingTemplate: response,
  };
}

function functionInput(model: Model, request: string, response: string): Model {
  return {
    name: model.Name, dataSourceName: model.DataSourceName, functionVersion: model.FunctionVersion,
    requestMappingTemplate: request, responseMappingTemplate: response,
  };
}

function functionModel(apiId: string, value: Model): Model {
  return cfn10Stable({
    ApiId: apiId, Name: value.name, DataSourceName: value.dataSourceName,
    FunctionVersion: value.functionVersion, RequestMappingTemplate: value.requestMappingTemplate,
    ResponseMappingTemplate: value.responseMappingTemplate,
  });
}

export function createAppSyncCloudFormationProviders(
  appsync: AppSyncService,
  readAsset: ReadAsset,
): readonly ProductionResourceProvider<Model>[] {
  const apiProvider: ProductionResourceProvider<Model> = {
    typeName: APPSYNC_GRAPHQL_API_TYPE, providerVersion: 1, visibility: "production", schema: apiSchema,
    validate: validateApi,
    canonicalize(properties) { return issueCanonical(properties, apiSchema, validateApi); },
    plan(previous, desired) { return cfn10Plan(previous, desired, apiSchema); },
    async create(desired, context) {
      try {
        const response = await appsync.executeCloudFormationControl("CreateGraphqlApi", apiInput(desired, context));
        const value = response.graphqlApi as Model;
        return success(String(value.apiId), desired, { ApiId: value.apiId, Arn: value.arn, GraphQLUrl: value.uris.GRAPHQL, RealtimeUrl: value.uris.REALTIME });
      } catch (error) { return failed(error); }
    },
    async read(id): Promise<ProviderReadResult<Model>> {
      try {
        const value = (await appsync.executeCloudFormationControl("GetGraphqlApi", { apiId: id })).graphqlApi as Model;
        return success(id, apiModel(value), { ApiId: value.apiId, Arn: value.arn, GraphQLUrl: value.uris.GRAPHQL, RealtimeUrl: value.uris.REALTIME });
      } catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId: id } : failed(error) as ProviderReadResult<Model>; }
    },
    async update(id, _previous, desired, context) {
      try {
        const input = apiInput(desired, context); delete input.tags; delete input.visibility; delete input.apiType;
        const value = (await appsync.executeCloudFormationControl("UpdateGraphqlApi", { apiId: id, ...input })).graphqlApi as Model;
        const existing = value.tags ?? {};
        const wanted = cfn10TagMap(cfn10Tags(desired.Tags), context);
        const remove = Object.keys(existing).filter(key => !Object.hasOwn(wanted, key));
        if (remove.length) await appsync.executeCloudFormationControl("UntagResource", { resourceArn: value.arn, tagKeys: remove });
        await appsync.executeCloudFormationControl("TagResource", { resourceArn: value.arn, tags: wanted });
        return success(id, desired, { ApiId: value.apiId, Arn: value.arn, GraphQLUrl: value.uris.GRAPHQL, RealtimeUrl: value.uris.REALTIME });
      } catch (error) { return failed(error); }
    },
    async delete(id) {
      try { await appsync.executeCloudFormationControl("DeleteGraphqlApi", { apiId: id }); return { status: "SUCCESS", physicalId: id }; }
      catch (error) { return deleted(error, id); }
    },
    ref(model) { return model.physicalId; },
    getAtt(model, attribute) { return cfn10GetAtt(APPSYNC_GRAPHQL_API_TYPE, apiSchema, model, attribute); },
  };

  const schemaProvider: ProductionResourceProvider<Model> = {
    typeName: APPSYNC_GRAPHQL_SCHEMA_TYPE, providerVersion: 1, visibility: "production", schema: schemaSchema,
    validate: validateSchemaResource,
    canonicalize(properties) { return issueCanonical(properties, schemaSchema, validateSchemaResource); },
    plan(previous, desired) { return cfn10Plan(previous, desired, schemaSchema); },
    async create(desired) {
      const id = physical("schema", [desired.ApiId]);
      try {
        const definition = await assetText(desired.Definition, desired.DefinitionS3Location, readAsset, "GraphQL schema");
        await appsync.executeCloudFormationControl("StartSchemaCreation", { apiId: desired.ApiId, definition: Buffer.from(definition).toString("base64") });
        const status = await appsync.executeCloudFormationControl("GetSchemaCreationStatus", { apiId: desired.ApiId });
        if (status.status !== "SUCCESS") return { status: "FAILED", errorCode: "SchemaCreationFailed", message: String(status.details ?? "The GraphQL schema was rejected.") };
        return success(id, desired);
      } catch (error) { return failed(error); }
    },
    async read(id) {
      try {
        const [apiId] = parsePhysical(id, "schema", 1);
        const value = await appsync.executeCloudFormationControl("GetSchemaDefinition", { apiId });
        return success(id, { ApiId: apiId, Definition: value.definition });
      } catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId: id } : failed(error) as ProviderReadResult<Model>; }
    },
    async update(id, _previous, desired) {
      const created = await this.create(desired, {} as ProviderContext);
      return created.status === "SUCCESS" ? success(id, desired) : created;
    },
    async delete(id) {
      try { parsePhysical(id, "schema", 1); return { status: "SUCCESS", physicalId: id }; }
      catch (error) { return deleted(error, id); }
    },
    ref(model) { return parsePhysical(model.physicalId, "schema", 1)[0]; },
    getAtt(_model, attribute) { throw new ProviderReferenceError(APPSYNC_GRAPHQL_SCHEMA_TYPE, `Fn::GetAtt ${attribute}`); },
  };

  const keyProvider: ProductionResourceProvider<Model> = {
    typeName: APPSYNC_API_KEY_TYPE, providerVersion: 1, visibility: "production", schema: keySchema,
    validate(properties) { return validateTop(properties, keySchema); },
    canonicalize(properties) { return canonical(properties, keySchema); },
    plan(previous, desired) { return cfn10Plan(previous, desired, keySchema); },
    async create(desired) {
      try {
        const response = await appsync.executeCloudFormationControl("CreateApiKey", {
          apiId: desired.ApiId,
          ...(desired.Description === undefined ? {} : { description: desired.Description }),
          ...(desired.Expires === undefined ? {} : { expires: desired.Expires }),
        });
        const value = response.apiKey as Model;
        return success(physical("key", [desired.ApiId, value.id]), desired, { ApiKey: value.id });
      } catch (error) { return failed(error); }
    },
    async read(id) {
      try {
        const [apiId, key] = parsePhysical(id, "key", 2);
        const response = await appsync.executeCloudFormationControl("ListApiKeys", { apiId, maxResults: 25 });
        const value = (response.apiKeys as Model[]).find(item => item.id === key);
        if (!value) return { status: "NOT_FOUND", physicalId: id };
        return success(id, { ApiId: apiId, ...(value.description === undefined ? {} : { Description: value.description }), Expires: value.expires }, { ApiKey: key });
      } catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId: id } : failed(error) as ProviderReadResult<Model>; }
    },
    async update(id, _previous, desired) {
      try {
        const [apiId, key] = parsePhysical(id, "key", 2);
        const response = await appsync.executeCloudFormationControl("UpdateApiKey", { apiId, id: key, ...(desired.Description === undefined ? {} : { description: desired.Description }), ...(desired.Expires === undefined ? {} : { expires: desired.Expires }) });
        return success(id, desired, { ApiKey: (response.apiKey as Model).id });
      } catch (error) { return failed(error); }
    },
    async delete(id) {
      try { const [apiId, key] = parsePhysical(id, "key", 2); await appsync.executeCloudFormationControl("DeleteApiKey", { apiId, id: key }); return { status: "SUCCESS", physicalId: id }; }
      catch (error) { return deleted(error, id); }
    },
    ref(model) { return parsePhysical(model.physicalId, "key", 2)[1]; },
    getAtt(model, attribute) { return cfn10GetAtt(APPSYNC_API_KEY_TYPE, keySchema, model, attribute); },
  };

  const dataSourceProvider: ProductionResourceProvider<Model> = {
    typeName: APPSYNC_DATA_SOURCE_TYPE, providerVersion: 1, visibility: "production", schema: dataSourceSchema,
    validate: validateDataSource,
    canonicalize(properties) { return issueCanonical(properties, dataSourceSchema, validateDataSource); },
    plan(previous, desired) { return cfn10Plan(previous, desired, dataSourceSchema); },
    async create(desired) {
      const id = physical("datasource", [desired.ApiId, desired.Name]);
      try {
        try {
          const existing = (await appsync.executeCloudFormationControl("GetDataSource", { apiId: desired.ApiId, name: desired.Name })).dataSource as Model;
          if (!cfn10Same(dataSourceModel(desired.ApiId, existing), desired)) return { status: "FAILED", errorCode: "AlreadyExists", message: `AppSync data source ${desired.Name} already exists` };
          return success(id, desired, { DataSourceArn: existing.dataSourceArn, Name: desired.Name });
        } catch (error) { if (!missing(error)) throw error; }
        const value = (await appsync.executeCloudFormationControl("CreateDataSource", { apiId: desired.ApiId, ...dataSourceInput(desired) })).dataSource as Model;
        return success(id, desired, { DataSourceArn: value.dataSourceArn, Name: value.name });
      } catch (error) { return failed(error); }
    },
    async read(id) {
      try {
        const [apiId, name] = parsePhysical(id, "datasource", 2);
        const value = (await appsync.executeCloudFormationControl("GetDataSource", { apiId, name })).dataSource as Model;
        return success(id, dataSourceModel(apiId, value), { DataSourceArn: value.dataSourceArn, Name: value.name });
      } catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId: id } : failed(error) as ProviderReadResult<Model>; }
    },
    async update(id, _previous, desired) {
      try {
        const [apiId, name] = parsePhysical(id, "datasource", 2);
        const input = dataSourceInput(desired); delete input.name;
        const value = (await appsync.executeCloudFormationControl("UpdateDataSource", { apiId, name, ...input })).dataSource as Model;
        return success(id, desired, { DataSourceArn: value.dataSourceArn, Name: value.name });
      } catch (error) { return failed(error); }
    },
    async delete(id) {
      try { const [apiId, name] = parsePhysical(id, "datasource", 2); await appsync.executeCloudFormationControl("DeleteDataSource", { apiId, name }); return { status: "SUCCESS", physicalId: id }; }
      catch (error) { return deleted(error, id); }
    },
    ref(model) { return parsePhysical(model.physicalId, "datasource", 2)[1]; },
    getAtt(model, attribute) { return cfn10GetAtt(APPSYNC_DATA_SOURCE_TYPE, dataSourceSchema, model, attribute); },
  };

  const functionProvider: ProductionResourceProvider<Model> = {
    typeName: APPSYNC_FUNCTION_CONFIGURATION_TYPE, providerVersion: 1, visibility: "production", schema: functionSchema,
    validate: validateFunction,
    canonicalize(properties) { return issueCanonical(properties, functionSchema, validateFunction); },
    plan(previous, desired) { return cfn10Plan(previous, desired, functionSchema); },
    async create(desired) {
      try {
        const request = await assetText(desired.RequestMappingTemplate, desired.RequestMappingTemplateS3Location, readAsset, "function request mapping template");
        const response = await assetText(desired.ResponseMappingTemplate, desired.ResponseMappingTemplateS3Location, readAsset, "function response mapping template");
        const expected: Model = cfn10Stable({ ...desired, RequestMappingTemplate: request, ResponseMappingTemplate: response });
        delete expected.RequestMappingTemplateS3Location; delete expected.ResponseMappingTemplateS3Location;
        let nextToken: string | undefined;
        do {
          const listed = await appsync.executeCloudFormationControl("ListFunctions", { apiId: desired.ApiId, maxResults: 25, ...(nextToken ? { nextToken } : {}) });
          const matches = (listed.functions as Model[]).filter(value => value.name === desired.Name);
          for (const existing of matches) {
            if (!cfn10Same(functionModel(desired.ApiId, existing), expected)) return { status: "FAILED", errorCode: "AlreadyExists", message: `AppSync function ${desired.Name} already exists with different properties` };
            const id = physical("function", [desired.ApiId, existing.functionId]);
            return success(id, desired, { FunctionId: existing.functionId, FunctionArn: existing.functionArn, Name: existing.name, DataSourceName: existing.dataSourceName });
          }
          nextToken = typeof listed.nextToken === "string" ? listed.nextToken : undefined;
        } while (nextToken);
        const value = (await appsync.executeCloudFormationControl("CreateFunction", { apiId: desired.ApiId, ...functionInput(desired, request, response) })).functionConfiguration as Model;
        return success(physical("function", [desired.ApiId, value.functionId]), desired, { FunctionId: value.functionId, FunctionArn: value.functionArn, Name: value.name, DataSourceName: value.dataSourceName });
      } catch (error) { return failed(error); }
    },
    async read(id) {
      try {
        const [apiId, functionId] = parsePhysical(id, "function", 2);
        const value = (await appsync.executeCloudFormationControl("GetFunction", { apiId, functionId })).functionConfiguration as Model;
        return success(id, functionModel(apiId, value), { FunctionId: functionId, FunctionArn: value.functionArn, Name: value.name, DataSourceName: value.dataSourceName });
      } catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId: id } : failed(error) as ProviderReadResult<Model>; }
    },
    async update(id, _previous, desired) {
      try {
        const [apiId, functionId] = parsePhysical(id, "function", 2);
        const request = await assetText(desired.RequestMappingTemplate, desired.RequestMappingTemplateS3Location, readAsset, "function request mapping template");
        const response = await assetText(desired.ResponseMappingTemplate, desired.ResponseMappingTemplateS3Location, readAsset, "function response mapping template");
        const value = (await appsync.executeCloudFormationControl("UpdateFunction", { apiId, functionId, ...functionInput(desired, request, response) })).functionConfiguration as Model;
        return success(id, desired, { FunctionId: functionId, FunctionArn: value.functionArn, Name: value.name, DataSourceName: value.dataSourceName });
      } catch (error) { return failed(error); }
    },
    async delete(id) {
      try { const [apiId, functionId] = parsePhysical(id, "function", 2); await appsync.executeCloudFormationControl("DeleteFunction", { apiId, functionId }); return { status: "SUCCESS", physicalId: id }; }
      catch (error) { return deleted(error, id); }
    },
    ref(model) { return model.attributes.FunctionArn; },
    getAtt(model, attribute) { return cfn10GetAtt(APPSYNC_FUNCTION_CONFIGURATION_TYPE, functionSchema, model, attribute); },
  };

  const resolverProvider: ProductionResourceProvider<Model> = {
    typeName: APPSYNC_RESOLVER_TYPE, providerVersion: 1, visibility: "production", schema: resolverSchema,
    validate: validateResolver,
    canonicalize(properties) { return issueCanonical(properties, resolverSchema, validateResolver); },
    plan(previous, desired) { return cfn10Plan(previous, desired, resolverSchema); },
    async create(desired) {
      const id = physical("resolver", [desired.ApiId, desired.TypeName, desired.FieldName]);
      try {
        const request = await assetText(desired.RequestMappingTemplate, desired.RequestMappingTemplateS3Location, readAsset, "request mapping template");
        const response = await assetText(desired.ResponseMappingTemplate, desired.ResponseMappingTemplateS3Location, readAsset, "response mapping template");
        try {
          const existing = (await appsync.executeCloudFormationControl("GetResolver", { apiId: desired.ApiId, typeName: desired.TypeName, fieldName: desired.FieldName })).resolver as Model;
          const pipelineFunctions = existing.pipelineConfig?.functions;
          if (existing.dataSourceName !== desired.DataSourceName || existing.kind !== (desired.Kind ?? "UNIT")
            || JSON.stringify(pipelineFunctions) !== JSON.stringify(desired.PipelineConfig?.Functions)
            || existing.requestMappingTemplate !== request || existing.responseMappingTemplate !== response) return { status: "FAILED", errorCode: "AlreadyExists", message: `Resolver ${desired.TypeName}.${desired.FieldName} already exists` };
          return success(id, desired, { ResolverArn: existing.resolverArn, TypeName: desired.TypeName, FieldName: desired.FieldName });
        } catch (error) { if (!missing(error)) throw error; }
        const value = (await appsync.executeCloudFormationControl("CreateResolver", { apiId: desired.ApiId, typeName: desired.TypeName, ...resolverInput(desired, request, response, true) })).resolver as Model;
        return success(id, desired, { ResolverArn: value.resolverArn, TypeName: value.typeName, FieldName: value.fieldName });
      } catch (error) { return failed(error); }
    },
    async read(id) {
      try {
        const [apiId, typeName, fieldName] = parsePhysical(id, "resolver", 3);
        const value = (await appsync.executeCloudFormationControl("GetResolver", { apiId, typeName, fieldName })).resolver as Model;
        return success(id, {
          ApiId: apiId, TypeName: typeName, FieldName: fieldName, ...(value.dataSourceName === undefined ? {} : { DataSourceName: value.dataSourceName }),
          ...(value.pipelineConfig === undefined ? {} : { PipelineConfig: { Functions: value.pipelineConfig.functions } }),
          Kind: value.kind, RequestMappingTemplate: value.requestMappingTemplate, ResponseMappingTemplate: value.responseMappingTemplate,
        }, { ResolverArn: value.resolverArn, TypeName: typeName, FieldName: fieldName });
      } catch (error) { return missing(error) ? { status: "NOT_FOUND", physicalId: id } : failed(error) as ProviderReadResult<Model>; }
    },
    async update(id, _previous, desired) {
      try {
        const [apiId, typeName, fieldName] = parsePhysical(id, "resolver", 3);
        const request = await assetText(desired.RequestMappingTemplate, desired.RequestMappingTemplateS3Location, readAsset, "request mapping template");
        const response = await assetText(desired.ResponseMappingTemplate, desired.ResponseMappingTemplateS3Location, readAsset, "response mapping template");
        const value = (await appsync.executeCloudFormationControl("UpdateResolver", { apiId, typeName, fieldName, ...resolverInput(desired, request, response, false) })).resolver as Model;
        return success(id, desired, { ResolverArn: value.resolverArn, TypeName: typeName, FieldName: fieldName });
      } catch (error) { return failed(error); }
    },
    async delete(id) {
      try { const [apiId, typeName, fieldName] = parsePhysical(id, "resolver", 3); await appsync.executeCloudFormationControl("DeleteResolver", { apiId, typeName, fieldName }); return { status: "SUCCESS", physicalId: id }; }
      catch (error) { return deleted(error, id); }
    },
    ref(model) { return model.attributes.ResolverArn; },
    getAtt(model, attribute) { return cfn10GetAtt(APPSYNC_RESOLVER_TYPE, resolverSchema, model, attribute); },
  };

  return [apiProvider, schemaProvider, keyProvider, dataSourceProvider, functionProvider, resolverProvider];
}

export const APPSYNC_CLOUDFORMATION_RESOURCE_TYPES = Object.freeze([
  APPSYNC_API_KEY_TYPE,
  APPSYNC_DATA_SOURCE_TYPE,
  APPSYNC_FUNCTION_CONFIGURATION_TYPE,
  APPSYNC_GRAPHQL_API_TYPE,
  APPSYNC_GRAPHQL_SCHEMA_TYPE,
  APPSYNC_RESOLVER_TYPE,
].sort());

export const APPSYNC_PROVIDER_MANIFEST_SHA256 = createHash("sha256")
  .update(JSON.stringify(APPSYNC_CLOUDFORMATION_RESOURCE_TYPES))
  .digest("hex");
