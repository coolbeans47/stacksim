import { providerValidationPathSegments } from "./contract.js";
import { createHash } from "node:crypto";
import type { ApiGatewayService } from "../../apigateway.js";
import { parseOpenApiDocument } from "../../apigateway-openapi.js";
import { AwsError } from "../../errors.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderFailed,
  type ProviderInProgress,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderSuccess,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";
import { invokeJsonService } from "./service-invoker.js";
import { createApiGatewayRestCommonCloudFormationProviders } from "./apigateway-rest-common.js";

export * from "./apigateway-rest-common.js";

export const API_GATEWAY_REST_API_TYPE = "AWS::ApiGateway::RestApi";
export const API_GATEWAY_RESOURCE_TYPE = "AWS::ApiGateway::Resource";
export const API_GATEWAY_METHOD_TYPE = "AWS::ApiGateway::Method";
export const API_GATEWAY_DEPLOYMENT_TYPE = "AWS::ApiGateway::Deployment";
export const API_GATEWAY_STAGE_TYPE = "AWS::ApiGateway::Stage";
export const API_GATEWAY_ACCOUNT_TYPE = "AWS::ApiGateway::Account";

type JsonObject = Record<string, any>;

export interface ApiGatewayBodyS3Location {
  readonly Bucket: string;
  readonly Key: string;
  readonly Version?: string;
}

export interface ApiGatewayRestApiModel {
  readonly Name: string;
  readonly Description: string;
  readonly ApiKeySourceType: "HEADER" | "AUTHORIZER";
  readonly BinaryMediaTypes: readonly string[];
  readonly MinimumCompressionSize?: number;
  readonly Policy?: unknown;
  readonly Body?: JsonObject;
  readonly BodyS3Location?: ApiGatewayBodyS3Location;
  readonly Mode: "merge" | "overwrite";
  readonly Parameters: Readonly<Record<string, string>>;
  readonly FailOnWarnings: boolean;
  readonly EndpointConfiguration: { readonly Types: readonly ["REGIONAL"] };
  readonly Tags: readonly { readonly Key: string; readonly Value: string }[];
}

export interface ApiGatewayResourceModel {
  readonly RestApiId: string;
  readonly ParentId: string;
  readonly PathPart: string;
}

export interface ApiGatewayIntegrationResponseModel {
  readonly StatusCode: string;
  readonly SelectionPattern?: string;
  readonly ResponseParameters: Readonly<Record<string, string>>;
  readonly ResponseTemplates: Readonly<Record<string, string>>;
  readonly ContentHandling?: "CONVERT_TO_BINARY" | "CONVERT_TO_TEXT";
}

export interface ApiGatewayIntegrationModel {
  readonly Type: "AWS" | "AWS_PROXY" | "HTTP" | "HTTP_PROXY" | "MOCK";
  readonly IntegrationHttpMethod: string;
  readonly Uri?: string;
  readonly ConnectionType: "INTERNET";
  readonly Credentials?: string;
  readonly RequestParameters: Readonly<Record<string, string>>;
  readonly RequestTemplates: Readonly<Record<string, string>>;
  readonly PassthroughBehavior: "WHEN_NO_MATCH" | "WHEN_NO_TEMPLATES" | "NEVER";
  readonly ContentHandling?: "CONVERT_TO_BINARY" | "CONVERT_TO_TEXT";
  readonly TimeoutInMillis: number;
  readonly CacheNamespace?: string;
  readonly CacheKeyParameters: readonly string[];
  readonly TlsConfig?: { readonly InsecureSkipVerification: boolean };
  readonly IntegrationResponses: readonly ApiGatewayIntegrationResponseModel[];
}

export interface ApiGatewayMethodResponseModel {
  readonly StatusCode: string;
  readonly ResponseModels: Readonly<Record<string, string>>;
  readonly ResponseParameters: Readonly<Record<string, boolean>>;
}

export interface ApiGatewayMethodModel {
  readonly RestApiId: string;
  readonly ResourceId: string;
  readonly HttpMethod: string;
  readonly AuthorizationType: "NONE" | "AWS_IAM" | "CUSTOM" | "COGNITO_USER_POOLS";
  readonly AuthorizerId?: string;
  readonly AuthorizationScopes: readonly string[];
  readonly ApiKeyRequired: boolean;
  readonly OperationName?: string;
  readonly RequestModels: Readonly<Record<string, string>>;
  readonly RequestParameters: Readonly<Record<string, boolean>>;
  readonly RequestValidatorId?: string;
  readonly Integration?: ApiGatewayIntegrationModel;
  readonly MethodResponses: readonly ApiGatewayMethodResponseModel[];
}

export interface ApiGatewayDeploymentModel {
  readonly RestApiId: string;
  readonly Description: string;
}

export interface ApiGatewayMethodSettingModel {
  readonly ResourcePath: string;
  readonly HttpMethod: string;
  readonly MetricsEnabled?: boolean;
  readonly LoggingLevel?: "OFF" | "ERROR" | "INFO";
  readonly DataTraceEnabled?: boolean;
  readonly ThrottlingBurstLimit?: number;
  readonly ThrottlingRateLimit?: number;
  readonly CachingEnabled?: boolean;
  readonly CacheTtlInSeconds?: number;
  readonly CacheDataEncrypted?: boolean;
  readonly RequireAuthorizationForCacheControl?: boolean;
  readonly UnauthorizedCacheControlHeaderStrategy?: "FAIL_WITH_403" | "SUCCEED_WITH_RESPONSE_HEADER" | "SUCCEED_WITHOUT_RESPONSE_HEADER";
}

export interface ApiGatewayStageModel {
  readonly RestApiId: string;
  readonly DeploymentId: string;
  readonly StageName: string;
  readonly Description: string;
  readonly Variables: Readonly<Record<string, string>>;
  readonly MethodSettings: readonly ApiGatewayMethodSettingModel[];
  readonly AccessLogSetting?: { readonly DestinationArn?: string; readonly Format?: string };
  readonly CacheClusterEnabled: boolean;
  readonly CacheClusterSize?: string;
  readonly CanarySetting?: {
    readonly DeploymentId?: string;
    readonly PercentTraffic: number;
    readonly StageVariableOverrides: Readonly<Record<string, string>>;
    readonly UseStageCache: boolean;
  };
  readonly ClientCertificateId?: string;
  readonly DocumentationVersion?: string;
  readonly TracingEnabled: boolean;
  readonly Tags: readonly { readonly Key: string; readonly Value: string }[];
}

export interface ApiGatewayAccountModel {
  readonly CloudWatchRoleArn: string;
}

export interface ApiGatewayRestProviderOptions {
  /** Resolve an S3-backed OpenAPI document without introducing a second source of resource state. */
  readonly resolveBodyS3Location?: (
    location: ApiGatewayBodyS3Location,
    context: ProviderContext,
  ) => Promise<unknown | Buffer | string>;
}

const RETENTION = Object.freeze({
  deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  snapshotSupported: false,
});
const NO_TAGS = Object.freeze({ behavior: "NONE" as const, propagatesCloudFormationTags: false });

export const API_GATEWAY_REST_API_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_REST_API_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Name: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    ApiKeySourceType: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    BinaryMediaTypes: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    MinimumCompressionSize: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    Policy: Object.freeze({ valueType: "any", updateBehavior: "MUTABLE" }),
    Body: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    BodyS3Location: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE", description: "Requires a resolver supplied to the provider factory." }),
    Mode: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Parameters: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    FailOnWarnings: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
    EndpointConfiguration: Object.freeze({ valueType: "object", updateBehavior: "NOT_SUPPORTED", description: "Only the simulator's REGIONAL endpoint is accepted." }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "REST API identifier." }),
  attributes: Object.freeze({
    RestApiId: Object.freeze({ valueType: "string" }),
    RootResourceId: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

export const API_GATEWAY_RESOURCE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_RESOURCE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    RestApiId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    ParentId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    PathPart: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "API Gateway resource identifier." }),
  attributes: Object.freeze({ ResourceId: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: NO_TAGS,
});

export const API_GATEWAY_METHOD_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_METHOD_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    RestApiId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    ResourceId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    HttpMethod: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    AuthorizationType: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    AuthorizerId: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    AuthorizationScopes: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    ApiKeyRequired: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
    OperationName: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    RequestModels: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    RequestParameters: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    RequestValidatorId: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Integration: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    MethodResponses: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Opaque deterministic CloudFormation method resource identifier." }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: NO_TAGS,
});

export const API_GATEWAY_DEPLOYMENT_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_DEPLOYMENT_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    RestApiId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Deployment identifier." }),
  attributes: Object.freeze({ DeploymentId: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: NO_TAGS,
});

export const API_GATEWAY_STAGE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_STAGE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    RestApiId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    DeploymentId: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    StageName: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Variables: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    MethodSettings: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    AccessLogSetting: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    CacheClusterEnabled: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
    CacheClusterSize: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    CanarySetting: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    ClientCertificateId: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    DocumentationVersion: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    TracingEnabled: Object.freeze({ valueType: "boolean", updateBehavior: "NOT_SUPPORTED", description: "X-Ray is not available; false is accepted for CDK compatibility." }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Stage name." }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

export const API_GATEWAY_ACCOUNT_SCHEMA: ProviderSchema = Object.freeze({
  typeName: API_GATEWAY_ACCOUNT_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({ CloudWatchRoleArn: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }) }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Opaque deterministic CloudFormation Account resource identifier." }),
  attributes: Object.freeze({ Id: Object.freeze({ valueType: "string", description: "The same opaque resource identifier returned by Ref." }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: NO_TAGS,
});

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalValue(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
}

function withoutUndefined(value: any): any {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, withoutUndefined(item)]));
}

function stringMap(value: unknown): Readonly<Record<string, string>> {
  if (!isObject(value)) return Object.freeze({});
  return Object.freeze(Object.fromEntries(Object.keys(value).sort().map(key => [key, String(value[key])] )));
}

function booleanMap(value: unknown): Readonly<Record<string, boolean>> {
  if (!isObject(value)) return Object.freeze({});
  return Object.freeze(Object.fromEntries(Object.keys(value).sort().map(key => [key, Boolean(value[key])] )));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function issue(path: string, message: string, code: ProviderValidationIssue["code"] = "InvalidProperty"): ProviderValidationIssue {
  return { code, path, pathSegments: providerValidationPathSegments(path), message };
}

function throwIssues(issues: readonly ProviderValidationIssue[]): void {
  if (issues.length) throw new TypeError(issues.map(value => `${value.path}: ${value.message}`).join("; "));
}

function generatedName(context: ProviderContext): string {
  const base = context.logicalId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 96) || "RestApi";
  const suffix = createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex").slice(0, 12);
  return `${base}-${suffix}`;
}

function opaqueCloudFormationId(kind: string, context: ProviderContext): string {
  return createHash("sha256").update(`${kind}\0${context.stackId}\0${context.logicalId}`).digest("hex").slice(0, 16);
}

function providerFailure(error: unknown): ProviderFailed {
  if (error instanceof AwsError) return { status: "FAILED", errorCode: error.code, message: error.message, ...(error.status >= 500 ? { retryable: true } : {}) };
  return { status: "FAILED", errorCode: "InternalFailure", message: error instanceof Error ? error.message : String(error), retryable: true };
}

function isMissing(error: unknown): boolean {
  return error instanceof AwsError && ["NotFoundException", "ResourceNotFoundException"].includes(error.code);
}

async function call<T>(service: ApiGatewayService, method: string, path: string, input?: unknown): Promise<T> {
  return (await invokeJsonService<T>({ method, path, input, handle: service.handle.bind(service) })).body;
}

function segment(value: string): string { return encodeURIComponent(value); }

function physical(kind: string, values: readonly string[]): string {
  return `stacksim:apigateway:${kind}:${Buffer.from(JSON.stringify(values)).toString("base64url")}`;
}

function parsePhysical(value: string, kind: string, length: number): string[] {
  const prefix = `stacksim:apigateway:${kind}:`;
  try {
    const decoded = JSON.parse(Buffer.from(value.startsWith(prefix) ? value.slice(prefix.length) : "", "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== length || decoded.some(part => typeof part !== "string" || !part)) throw new Error();
    return decoded;
  } catch {
    throw new AwsError("InvalidPhysicalResourceId", `Invalid ${kind} physical resource identifier`, 400);
  }
}

function plan<Model>(previous: Model | undefined, desired: Model, names: readonly string[], replacements: readonly string[]): ProviderPlan<Model> {
  if (!previous) return { action: "CREATE", desired, changedProperties: names.filter(name => !same((desired as any)[name], undefined)), replacementProperties: [] };
  const changed = names.filter(name => !same((previous as any)[name], (desired as any)[name]));
  if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
  const replacementProperties = changed.filter(name => replacements.includes(name));
  return replacementProperties.length
    ? { action: "REPLACE", desired, changedProperties: changed, replacementProperties, replacementOrder: "CREATE_BEFORE_DELETE" }
    : { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
}

function unsupportedGetAtt(typeName: string, schema: ProviderSchema, model: ProviderReadModel<any>, attribute: string): unknown {
  if (!Object.hasOwn(schema.attributes, attribute)) throw new ProviderReferenceError(typeName, `Fn::GetAtt ${attribute}`);
  return model.attributes[attribute];
}

function validateStringMap(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (value === undefined) return;
  if (!isObject(value)) {
    issues.push(issue(path, `${path} must be an object whose values are strings`, "InvalidType"));
    return;
  }
  for (const [key, item] of Object.entries(value)) if (typeof item !== "string") issues.push(issue(`${path}.${key}`, `${path}.${key} must be a string`, "InvalidType"));
}

function validateBooleanMap(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (value === undefined) return;
  if (!isObject(value)) {
    issues.push(issue(path, `${path} must be an object whose values are booleans`, "InvalidType"));
    return;
  }
  for (const [key, item] of Object.entries(value)) if (typeof item !== "boolean") issues.push(issue(`${path}.${key}`, `${path}.${key} must be a boolean`, "InvalidType"));
}

function validateTagProperty(value: unknown, path: string, resourceName: string, issues: ProviderValidationIssue[]): void {
  if (!Array.isArray(value)) return;
  if (value.length > 50) issues.push(issue(path, `${resourceName} can have at most 50 tags`));
  const keys = new Set<string>();
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isObject(item)) { issues.push(issue(itemPath, `${itemPath} must be an object`, "InvalidType")); return; }
    for (const key of Object.keys(item)) if (!["Key", "Value"].includes(key)) issues.push(issue(`${itemPath}.${key}`, `Tag does not support ${key}`, "UnsupportedProperty"));
    if (typeof item.Key !== "string" || !item.Key) issues.push(issue(`${itemPath}.Key`, "Tag Key is required"));
    else if (keys.has(item.Key)) issues.push(issue(`${itemPath}.Key`, `Duplicate tag key ${item.Key}`));
    else keys.add(item.Key);
    if (typeof item.Value !== "string") issues.push(issue(`${itemPath}.Value`, "Tag Value must be a string", "InvalidType"));
    if (typeof item.Key === "string" && (item.Key.length > 128 || item.Key.toLowerCase().startsWith("aws:") || !/^[A-Za-z0-9 +\-=._:/@]*$/.test(item.Key))) issues.push(issue(`${itemPath}.Key`, "Tag Key is invalid"));
    if (typeof item.Value === "string" && (item.Value.length > 256 || !/^[A-Za-z0-9 +\-=._:/@]*$/.test(item.Value))) issues.push(issue(`${itemPath}.Value`, "Tag Value is invalid"));
  });
}

function restApiIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_REST_API_SCHEMA);
  if (!isObject(properties)) return issues;
  if (typeof properties.Name === "string" && (!properties.Name.trim() || properties.Name.length > 128)) issues.push(issue("Properties.Name", "Name must contain 1 to 128 characters"));
  if (properties.ApiKeySourceType !== undefined && !["HEADER", "AUTHORIZER"].includes(properties.ApiKeySourceType)) issues.push(issue("Properties.ApiKeySourceType", "ApiKeySourceType must be HEADER or AUTHORIZER"));
  if (Array.isArray(properties.BinaryMediaTypes)) {
    const values = properties.BinaryMediaTypes;
    values.forEach((value, index) => { if (typeof value !== "string") issues.push(issue(`Properties.BinaryMediaTypes[${index}]`, "Binary media types must be strings", "InvalidType")); else if (!/^(?:\*|[A-Za-z0-9!#$&^_.+-]+)\/(?:\*|[A-Za-z0-9!#$&^_.+-]+)$/.test(value)) issues.push(issue(`Properties.BinaryMediaTypes[${index}]`, "Binary media type is invalid")); });
    if (new Set(values).size !== values.length) issues.push(issue("Properties.BinaryMediaTypes", "BinaryMediaTypes must not contain duplicates"));
  }
  if (typeof properties.MinimumCompressionSize === "number" && (!Number.isInteger(properties.MinimumCompressionSize) || properties.MinimumCompressionSize < 0 || properties.MinimumCompressionSize > 10_485_760)) issues.push(issue("Properties.MinimumCompressionSize", "MinimumCompressionSize must be an integer from 0 through 10485760"));
  if (properties.Body !== undefined && properties.BodyS3Location !== undefined) issues.push(issue("Properties.BodyS3Location", "Body and BodyS3Location are mutually exclusive"));
  if (isObject(properties.BodyS3Location)) {
    const allowed = new Set(["Bucket", "Key", "Version"]);
    for (const key of Object.keys(properties.BodyS3Location)) if (!allowed.has(key)) issues.push(issue(`Properties.BodyS3Location.${key}`, `BodyS3Location does not support ${key}`, "UnsupportedProperty"));
    for (const key of ["Bucket", "Key"]) if (typeof properties.BodyS3Location[key] !== "string" || !properties.BodyS3Location[key]) issues.push(issue(`Properties.BodyS3Location.${key}`, `BodyS3Location.${key} is required and must be a string`));
    if (properties.BodyS3Location.Version !== undefined && typeof properties.BodyS3Location.Version !== "string") issues.push(issue("Properties.BodyS3Location.Version", "BodyS3Location.Version must be a string", "InvalidType"));
  }
  if (properties.Mode !== undefined && !["merge", "overwrite"].includes(properties.Mode)) issues.push(issue("Properties.Mode", "Mode must be merge or overwrite"));
  validateStringMap(properties.Parameters, "Properties.Parameters", issues);
  if (properties.Policy !== undefined) {
    try {
      const value = typeof properties.Policy === "string" ? JSON.parse(properties.Policy) : properties.Policy;
      if (!isObject(value)) throw new Error();
      if (!Object.hasOwn(value, "Statement")) issues.push(issue("Properties.Policy.Statement", "A REST API resource policy requires Statement"));
    } catch { issues.push(issue("Properties.Policy", "Policy must be an object or a JSON object string")); }
  }
  if (isObject(properties.EndpointConfiguration)) {
    const keys = Object.keys(properties.EndpointConfiguration);
    if (keys.some(key => key !== "Types")) for (const key of keys.filter(key => key !== "Types")) issues.push(issue(`Properties.EndpointConfiguration.${key}`, `EndpointConfiguration does not support ${key}`, "UnsupportedProperty"));
    const types = properties.EndpointConfiguration.Types;
    if (!Array.isArray(types) || types.length !== 1 || types[0] !== "REGIONAL") issues.push(issue("Properties.EndpointConfiguration.Types", "Only a single REGIONAL endpoint type is available locally"));
  }
  validateTagProperty(properties.Tags, "Properties.Tags", "A REST API", issues);
  return issues;
}

function canonicalRestApi(properties: unknown, context: ProviderContext): ApiGatewayRestApiModel {
  const issues = restApiIssues(properties); throwIssues(issues);
  const input = properties as JsonObject;
  let policy: unknown = input.Policy;
  if (typeof policy === "string") policy = JSON.parse(policy);
  const bodyLocation = input.BodyS3Location as JsonObject | undefined;
  return Object.freeze({
    Name: String(input.Name ?? generatedName(context)),
    Description: String(input.Description ?? ""),
    ApiKeySourceType: (input.ApiKeySourceType ?? "HEADER") as "HEADER" | "AUTHORIZER",
    BinaryMediaTypes: Object.freeze([...(input.BinaryMediaTypes ?? [])].map(String).sort()),
    ...(input.MinimumCompressionSize === undefined ? {} : { MinimumCompressionSize: Number(input.MinimumCompressionSize) }),
    ...(policy === undefined ? {} : { Policy: canonicalValue(policy) }),
    ...(input.Body === undefined ? {} : { Body: canonicalValue(input.Body) }),
    ...(bodyLocation === undefined ? {} : { BodyS3Location: Object.freeze({ Bucket: String(bodyLocation.Bucket), Key: String(bodyLocation.Key), ...(bodyLocation.Version === undefined ? {} : { Version: String(bodyLocation.Version) }) }) }),
    Mode: (input.Mode ?? "merge") as "merge" | "overwrite",
    Parameters: stringMap(input.Parameters),
    FailOnWarnings: Boolean(input.FailOnWarnings ?? false),
    EndpointConfiguration: Object.freeze({ Types: Object.freeze(["REGIONAL"] as const) }),
    Tags: canonicalTags(input.Tags),
  });
}

function importPath(base: string, desired: ApiGatewayRestApiModel, create: boolean): string {
  const query = new URLSearchParams(); query.set("mode", create ? "import" : desired.Mode);
  if (desired.FailOnWarnings) query.set("failonwarnings", "true");
  for (const [key, value] of Object.entries(desired.Parameters)) query.set(`parameters[${key}]`, value);
  return `${base}?${query.toString()}`;
}

async function resolvedBody(desired: ApiGatewayRestApiModel, context: ProviderContext, options: ApiGatewayRestProviderOptions): Promise<JsonObject | undefined> {
  if (desired.Body) return desired.Body;
  if (!desired.BodyS3Location) return undefined;
  if (!options.resolveBodyS3Location) throw new AwsError("DependencyUnavailable", "BodyS3Location requires resolveBodyS3Location in createApiGatewayRestCloudFormationProviders", 400);
  const value = await options.resolveBodyS3Location(desired.BodyS3Location, context);
  if (Buffer.isBuffer(value) || typeof value === "string") {
    try { return canonicalValue(parseOpenApiDocument(Buffer.isBuffer(value) ? value : Buffer.from(value))); }
    catch (error) { throw new AwsError("BadRequestException", `Unable to parse BodyS3Location document: ${error instanceof Error ? error.message : String(error)}`, 400); }
  }
  if (isObject(value)) return canonicalValue(value);
  throw new AwsError("BadRequestException", "BodyS3Location resolver must return an OpenAPI object, string, or Buffer", 400);
}

function restApiPatch(desired: ApiGatewayRestApiModel): JsonObject[] {
  return [
    { op: "replace", path: "/name", value: desired.Name },
    { op: "replace", path: "/description", value: desired.Description },
    { op: "replace", path: "/apiKeySource", value: desired.ApiKeySourceType },
    { op: "replace", path: "/binaryMediaTypes", value: [...desired.BinaryMediaTypes] },
    desired.MinimumCompressionSize === undefined ? { op: "remove", path: "/minimumCompressionSize" } : { op: "replace", path: "/minimumCompressionSize", value: desired.MinimumCompressionSize },
    desired.Policy === undefined ? { op: "remove", path: "/policy" } : { op: "replace", path: "/policy", value: JSON.stringify(desired.Policy) },
  ];
}

function restApiModel(raw: JsonObject): ApiGatewayRestApiModel {
  let policy: unknown = raw.policy;
  if (typeof policy === "string") try { policy = JSON.parse(policy); } catch {}
  return {
    Name: String(raw.name), Description: String(raw.description ?? ""), ApiKeySourceType: (raw.apiKeySource ?? "HEADER") as any,
    BinaryMediaTypes: Object.freeze([...(raw.binaryMediaTypes ?? [])].map(String).sort()),
    ...(raw.minimumCompressionSize === undefined ? {} : { MinimumCompressionSize: Number(raw.minimumCompressionSize) }),
    ...(policy === undefined ? {} : { Policy: canonicalValue(policy) }),
    Mode: "merge", Parameters: Object.freeze({}), FailOnWarnings: false,
    EndpointConfiguration: Object.freeze({ Types: Object.freeze(["REGIONAL"] as const) }),
    Tags: canonicalTags(Object.entries(raw.tags ?? {}).map(([Key, Value]) => ({ Key, Value: String(Value) }))),
  };
}

function restApiTagMap(tags: readonly { readonly Key: string; readonly Value: string }[]): Record<string, string> {
  return Object.fromEntries(tags.map(tag => [tag.Key, tag.Value]));
}

function restApiSuccessFromRaw(apiId: string, desired: ApiGatewayRestApiModel, raw: JsonObject): ProviderSuccess<ApiGatewayRestApiModel> {
  return { status: "SUCCESS", physicalId: apiId, model: { physicalId: apiId, properties: desired, attributes: { RestApiId: apiId, RootResourceId: String(raw.rootResourceId) } } };
}

type RestApiLifecycleOperation = "CREATE" | "UPDATE" | "DELETE";
type RestApiLifecyclePhase = "body" | "settings" | "tags" | "cleanup-delete" | "cleanup-verify" | "delete" | "verify-delete";

interface RestApiLifecycleFailure {
  readonly [key: string]: string;
  readonly errorCode: string;
  readonly message: string;
}

interface RestApiLifecycleCheckpoint {
  readonly operation: RestApiLifecycleOperation;
  readonly phase: RestApiLifecyclePhase;
  readonly apiId: string;
  readonly marker?: string;
  readonly failure?: RestApiLifecycleFailure;
}

const REST_API_LIFECYCLE_STATE_MACHINE = "apigateway-rest-api-v1";

function restApiInProgress(apiId: string, operation: RestApiLifecycleOperation, phase: RestApiLifecyclePhase, marker?: string, failure?: RestApiLifecycleFailure): ProviderInProgress {
  return {
    status: "IN_PROGRESS",
    callbackAfterMs: 25,
    checkpoint: {
      schemaVersion: 1,
      physicalId: apiId,
      callbackContext: { stateMachine: REST_API_LIFECYCLE_STATE_MACHINE, operation, phase, apiId, ...(marker === undefined ? {} : { marker }), ...(failure === undefined ? {} : { failure }) },
    },
  };
}

function restApiLifecycleCheckpoint(context: ProviderContext, operation: RestApiLifecycleOperation): RestApiLifecycleCheckpoint | undefined {
  const value = context.callbackContext;
  if (value === undefined || Object.keys(value).length === 0) return undefined;
  const phases: Readonly<Record<RestApiLifecycleOperation, ReadonlySet<RestApiLifecyclePhase>>> = {
    CREATE: new Set(["settings", "tags", "cleanup-delete", "cleanup-verify"]),
    UPDATE: new Set(["body", "settings", "tags"]),
    DELETE: new Set(["delete", "verify-delete"]),
  };
  const cleanup = value.phase === "cleanup-delete" || value.phase === "cleanup-verify";
  const rawFailure = isObject(value.failure) ? value.failure as JsonObject : undefined;
  const validFailure = rawFailure !== undefined && typeof rawFailure.errorCode === "string" && Boolean(rawFailure.errorCode) && typeof rawFailure.message === "string";
  if (value.stateMachine !== REST_API_LIFECYCLE_STATE_MACHINE || value.operation !== operation || typeof value.phase !== "string" || !phases[operation].has(value.phase as RestApiLifecyclePhase) || typeof value.apiId !== "string" || !value.apiId || value.marker !== undefined && (typeof value.marker !== "string" || !value.marker.startsWith("stacksim-cfn:")) || operation === "CREATE" && typeof value.marker !== "string" || cleanup !== validFailure || !cleanup && value.failure !== undefined) {
    throw new AwsError("InvalidCallbackContext", `Invalid ${API_GATEWAY_REST_API_TYPE} ${operation} callback context`, 400);
  }
  return {
    operation,
    phase: value.phase as RestApiLifecyclePhase,
    apiId: value.apiId,
    ...(typeof value.marker === "string" ? { marker: value.marker } : {}),
    ...(validFailure ? { failure: { errorCode: rawFailure!.errorCode, message: rawFailure!.message } } : {}),
  };
}

function restApiOperationMarkerPrefix(context: ProviderContext): string {
  const digest = createHash("sha256")
    .update(`${API_GATEWAY_REST_API_TYPE}\0${context.stackId}\0${context.logicalId}\0${context.idempotencyKey}`)
    .digest("hex")
    .slice(0, 24);
  return `stacksim-cfn:${digest}:`;
}

interface RestApiSourceSnapshot {
  readonly body?: JsonObject;
  readonly prefix: string;
  readonly marker: string;
}

async function restApiSourceSnapshot(desired: ApiGatewayRestApiModel, context: ProviderContext, options: ApiGatewayRestProviderOptions): Promise<RestApiSourceSnapshot> {
  const body = await resolvedBody(desired, context, options);
  const digest = createHash("sha256").update(JSON.stringify(canonicalValue({
    Body: body ?? null,
    BodyS3Location: desired.BodyS3Location ?? null,
    Mode: desired.Mode,
    Parameters: desired.Parameters,
    FailOnWarnings: desired.FailOnWarnings,
    Settings: restApiSettings(desired),
    Tags: desired.Tags,
  }))).digest("hex").slice(0, 32);
  const prefix = restApiOperationMarkerPrefix(context);
  return { ...(body === undefined ? {} : { body }), prefix, marker: `${prefix}${digest}` };
}

function bodyWithRestApiMarker(body: JsonObject, marker: string): JsonObject {
  const document = structuredClone(body);
  document.info = { ...(isObject(document.info) ? document.info : {}), description: marker };
  return document;
}

function restApiSettings(model: ApiGatewayRestApiModel): JsonObject {
  return withoutUndefined({
    Name: model.Name,
    Description: model.Description,
    ApiKeySourceType: model.ApiKeySourceType,
    BinaryMediaTypes: [...model.BinaryMediaTypes],
    MinimumCompressionSize: model.MinimumCompressionSize,
    Policy: model.Policy,
  });
}

function restApiSettingsMatch(raw: JsonObject, desired: ApiGatewayRestApiModel): boolean {
  return same(restApiSettings(restApiModel(raw)), restApiSettings(desired));
}

function restApiBodyChanged(previous: ApiGatewayRestApiModel, desired: ApiGatewayRestApiModel): boolean {
  return !same(previous.Body, desired.Body)
    || !same(previous.BodyS3Location, desired.BodyS3Location)
    || previous.Mode !== desired.Mode
    || !same(previous.Parameters, desired.Parameters)
    || previous.FailOnWarnings !== desired.FailOnWarnings;
}

async function findRestApiByOperationMarker(service: ApiGatewayService, snapshot: RestApiSourceSnapshot): Promise<JsonObject | undefined> {
  const listed = await call<JsonObject>(service, "GET", "/restapis");
  const matches = (listed.item ?? []).filter((candidate: JsonObject) => typeof candidate.description === "string" && candidate.description.startsWith(snapshot.prefix));
  if (matches.length > 1) throw new AwsError("ConflictException", "Multiple REST APIs carry this CloudFormation operation fingerprint", 409);
  if (matches.length === 1 && matches[0].description !== snapshot.marker) throw new AwsError("SourceChanged", "The REST API definition or properties changed after the create mutation was accepted", 409);
  return matches[0];
}

async function createRestApiMutation(service: ApiGatewayService, desired: ApiGatewayRestApiModel, snapshot: RestApiSourceSnapshot): Promise<string> {
  const raw = snapshot.body
    ? await call<JsonObject>(service, "POST", importPath("/restapis", desired, true), bodyWithRestApiMarker(snapshot.body, snapshot.marker))
    : await call<JsonObject>(service, "POST", "/restapis", {
        name: desired.Name,
        description: snapshot.marker,
        apiKeySource: desired.ApiKeySourceType,
        binaryMediaTypes: desired.BinaryMediaTypes,
        minimumCompressionSize: desired.MinimumCompressionSize,
        policy: desired.Policy,
        tags: restApiTagMap(desired.Tags),
      });
  return String(raw.id);
}

async function observeRestApi(service: ApiGatewayService, apiId: string): Promise<JsonObject | undefined> {
  try { return await call<JsonObject>(service, "GET", `/restapis/${segment(apiId)}`); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

async function mutateOneRestApiTagDelta(service: ApiGatewayService, apiId: string, current: readonly { readonly Key: string; readonly Value: string }[], desired: readonly { readonly Key: string; readonly Value: string }[], context: ProviderContext): Promise<boolean> {
  const currentMap = restApiTagMap(current);
  const desiredMap = restApiTagMap(desired);
  const removed = Object.keys(currentMap).filter(key => !Object.hasOwn(desiredMap, key)).sort();
  const arn = `arn:${context.partition}:apigateway:${context.region}::/restapis/${apiId}`;
  if (removed.length) {
    const query = new URLSearchParams();
    for (const key of removed) query.append("tagKeys", key);
    await call(service, "DELETE", `/tags/${segment(arn)}?${query.toString()}`);
    return true;
  }
  const additions = Object.fromEntries(Object.entries(desiredMap).filter(([key, value]) => currentMap[key] !== value).sort(([left], [right]) => left.localeCompare(right)));
  if (Object.keys(additions).length) {
    await call(service, "PUT", `/tags/${segment(arn)}`, { tags: additions });
    return true;
  }
  return false;
}

async function reconcileRestApiCreate(service: ApiGatewayService, apiId: string, desired: ApiGatewayRestApiModel, context: ProviderContext, options: ApiGatewayRestProviderOptions, phase: "settings" | "tags", marker: string): Promise<ProviderSuccess<ApiGatewayRestApiModel> | ProviderInProgress> {
  const current = await observeRestApi(service, apiId);
  if (!current) throw new AwsError("NotFoundException", `REST API ${apiId} was deleted while its create operation was in progress`, 404);
  if (phase === "settings") {
    const snapshot = await restApiSourceSnapshot(desired, context, options);
    if (snapshot.marker !== marker) throw new AwsError("SourceChanged", "The REST API definition or properties changed after the create mutation was accepted", 409);
    if (typeof current.description === "string" && current.description.startsWith(snapshot.prefix) && current.description !== marker) throw new AwsError("SourceChanged", "The REST API carries a different definition fingerprint for this create operation", 409);
    if (!restApiSettingsMatch(current, desired)) {
      await call(service, "PATCH", `/restapis/${segment(apiId)}`, { patchOperations: restApiPatch(desired) });
    }
    return restApiInProgress(apiId, "CREATE", "tags", marker);
  }
  if (await mutateOneRestApiTagDelta(service, apiId, restApiModel(current).Tags, desired.Tags, context)) return restApiInProgress(apiId, "CREATE", "tags", marker);
  if (!restApiSettingsMatch(current, desired)) return restApiInProgress(apiId, "CREATE", "settings", marker);
  return restApiSuccessFromRaw(apiId, desired, current);
}

async function reconcileRestApiUpdate(service: ApiGatewayService, apiId: string, desired: ApiGatewayRestApiModel, context: ProviderContext, options: ApiGatewayRestProviderOptions, phase: "body" | "settings" | "tags", marker?: string): Promise<ProviderUpdateResult<ApiGatewayRestApiModel>> {
  const current = await observeRestApi(service, apiId);
  if (!current) throw new AwsError("NotFoundException", `REST API ${apiId} was not found`, 404);
  if (phase === "body") {
    const snapshot = await restApiSourceSnapshot(desired, context, options);
    if (!snapshot.body) throw new AwsError("InvalidCallbackContext", "The callback requested a REST API body mutation but the desired resource has no Body or BodyS3Location", 400);
    if (marker !== undefined && marker !== snapshot.marker || typeof current.description === "string" && current.description.startsWith(snapshot.prefix) && current.description !== snapshot.marker) throw new AwsError("SourceChanged", "The REST API definition or properties changed after the body mutation was accepted", 409);
    if (current.description !== snapshot.marker) {
      await call(service, "PUT", importPath(`/restapis/${segment(apiId)}`, desired, false), bodyWithRestApiMarker(snapshot.body, snapshot.marker));
    }
    return restApiInProgress(apiId, "UPDATE", "settings", snapshot.marker);
  }
  if (phase === "settings") {
    if (marker !== undefined) {
      const snapshot = await restApiSourceSnapshot(desired, context, options);
      if (snapshot.marker !== marker) throw new AwsError("SourceChanged", "The REST API definition or properties changed after the body mutation was accepted", 409);
    }
    if (!restApiSettingsMatch(current, desired)) {
      await call(service, "PATCH", `/restapis/${segment(apiId)}`, { patchOperations: restApiPatch(desired) });
    }
    return restApiInProgress(apiId, "UPDATE", "tags", marker);
  }
  if (await mutateOneRestApiTagDelta(service, apiId, restApiModel(current).Tags, desired.Tags, context)) return restApiInProgress(apiId, "UPDATE", "tags", marker);
  if (!restApiSettingsMatch(current, desired)) return restApiInProgress(apiId, "UPDATE", "settings", marker);
  return restApiSuccessFromRaw(apiId, desired, current);
}

async function cleanupFailedRestApiCreate(service: ApiGatewayService, checkpoint: RestApiLifecycleCheckpoint): Promise<ProviderInProgress | ProviderFailed> {
  const failure = checkpoint.failure;
  if (!failure) throw new AwsError("InvalidCallbackContext", "REST API create cleanup requires the original provider failure", 400);
  const current = await observeRestApi(service, checkpoint.apiId);
  if (!current) return { status: "FAILED", ...failure };
  if (checkpoint.phase === "cleanup-verify") return restApiInProgress(checkpoint.apiId, "CREATE", "cleanup-delete", checkpoint.marker, failure);
  await call(service, "DELETE", `/restapis/${segment(checkpoint.apiId)}`);
  return restApiInProgress(checkpoint.apiId, "CREATE", "cleanup-verify", checkpoint.marker, failure);
}

export function createApiGatewayRestApiProvider(service: ApiGatewayService, options: ApiGatewayRestProviderOptions = {}): ProductionResourceProvider<ApiGatewayRestApiModel> {
  const names = Object.keys(API_GATEWAY_REST_API_SCHEMA.properties).sort();
  return {
    typeName: API_GATEWAY_REST_API_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_REST_API_SCHEMA,
    validate(properties) { return restApiIssues(properties); },
    canonicalize(properties, context) { return canonicalRestApi(properties, context); },
    plan(previous, desired) { return plan(previous, desired, names, []); },
    async create(desired, context) {
      let checkpoint: RestApiLifecycleCheckpoint | undefined;
      try {
        checkpoint = restApiLifecycleCheckpoint(context, "CREATE");
        if (checkpoint?.phase === "cleanup-delete" || checkpoint?.phase === "cleanup-verify") return await cleanupFailedRestApiCreate(service, checkpoint);
        if (checkpoint) return await reconcileRestApiCreate(service, checkpoint.apiId, desired, context, options, checkpoint.phase as "settings" | "tags", checkpoint.marker!);
        const snapshot = await restApiSourceSnapshot(desired, context, options);
        const owned = await findRestApiByOperationMarker(service, snapshot);
        if (owned) return restApiInProgress(String(owned.id), "CREATE", "settings", snapshot.marker);
        const apiId = await createRestApiMutation(service, desired, snapshot);
        return restApiInProgress(apiId, "CREATE", "settings", snapshot.marker);
      } catch (error) {
        const failed = providerFailure(error);
        if (checkpoint && !failed.retryable && checkpoint.phase !== "cleanup-delete" && checkpoint.phase !== "cleanup-verify") {
          return restApiInProgress(checkpoint.apiId, "CREATE", "cleanup-delete", checkpoint.marker, { errorCode: failed.errorCode, message: failed.message });
        }
        return failed;
      }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayRestApiModel>> {
      try {
        const raw = await call<JsonObject>(service, "GET", `/restapis/${segment(physicalId)}`);
        return { status: "SUCCESS", physicalId, model: { physicalId, properties: restApiModel(raw), attributes: { RestApiId: physicalId, RootResourceId: String(raw.rootResourceId) } } };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayRestApiModel>> {
      try {
        const checkpoint = restApiLifecycleCheckpoint(context, "UPDATE");
        if (checkpoint && checkpoint.apiId !== physicalId) throw new AwsError("InvalidCallbackContext", `REST API callback physical ID ${checkpoint.apiId} does not match ${physicalId}`, 400);
        const bodyChanged = restApiBodyChanged(previous, desired) && (desired.Body !== undefined || desired.BodyS3Location !== undefined);
        const phase = checkpoint?.phase as "body" | "settings" | "tags" | undefined;
        if (phase === "body" && !bodyChanged) return restApiInProgress(physicalId, "UPDATE", "settings");
        return await reconcileRestApiUpdate(service, physicalId, desired, context, options, phase ?? (bodyChanged ? "body" : "settings"), checkpoint?.marker);
      } catch (error) { return providerFailure(error); }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        const checkpoint = restApiLifecycleCheckpoint(context, "DELETE");
        if (checkpoint && checkpoint.apiId !== physicalId) throw new AwsError("InvalidCallbackContext", `REST API callback physical ID ${checkpoint.apiId} does not match ${physicalId}`, 400);
        const current = await observeRestApi(service, physicalId);
        if (!current) return checkpoint ? { status: "SUCCESS", physicalId } : { status: "NOT_FOUND", physicalId };
        if (checkpoint?.phase === "verify-delete") return restApiInProgress(physicalId, "DELETE", "delete");
        await call(service, "DELETE", `/restapis/${segment(physicalId)}`);
        return restApiInProgress(physicalId, "DELETE", "verify-delete");
      } catch (error) { return providerFailure(error); }
    },
    ref(model) { return model.physicalId; },
    getAtt(model, attribute) { return unsupportedGetAtt(API_GATEWAY_REST_API_TYPE, API_GATEWAY_REST_API_SCHEMA, model, attribute); },
  };
}

function resourceIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_RESOURCE_SCHEMA);
  if (!isObject(properties)) return issues;
  for (const key of ["RestApiId", "ParentId"]) if (typeof properties[key] === "string" && !properties[key]) issues.push(issue(`Properties.${key}`, `${key} must not be empty`));
  if (typeof properties.PathPart === "string" && (!properties.PathPart || properties.PathPart.includes("/") || properties.PathPart.length > 160)) issues.push(issue("Properties.PathPart", "PathPart must be a non-empty path segment of at most 160 characters and cannot contain /"));
  return issues;
}

function canonicalResource(properties: unknown): ApiGatewayResourceModel {
  const issues = resourceIssues(properties); throwIssues(issues); const input = properties as JsonObject;
  return Object.freeze({ RestApiId: String(input.RestApiId), ParentId: String(input.ParentId), PathPart: String(input.PathPart) });
}

async function resourceReadModel(service: ApiGatewayService, apiId: string, resourceId: string): Promise<ProviderReadModel<ApiGatewayResourceModel>> {
  const raw = await call<JsonObject>(service, "GET", `/restapis/${segment(apiId)}/resources/${segment(resourceId)}`);
  return { physicalId: physical("resource", [apiId, resourceId]), properties: { RestApiId: apiId, ParentId: String(raw.parentId), PathPart: String(raw.pathPart) }, attributes: { ResourceId: resourceId } };
}

export function createApiGatewayResourceProvider(service: ApiGatewayService): ProductionResourceProvider<ApiGatewayResourceModel> {
  const names = Object.keys(API_GATEWAY_RESOURCE_SCHEMA.properties).sort();
  return {
    typeName: API_GATEWAY_RESOURCE_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_RESOURCE_SCHEMA,
    validate(properties) { return resourceIssues(properties); }, canonicalize(properties) { return canonicalResource(properties); },
    plan(previous, desired) { return plan(previous, desired, names, names); },
    async create(desired) {
      try {
        const raw = await call<JsonObject>(service, "POST", `/restapis/${segment(desired.RestApiId)}/resources/${segment(desired.ParentId)}`, { pathPart: desired.PathPart });
        const model = await resourceReadModel(service, desired.RestApiId, String(raw.id));
        return { status: "SUCCESS", physicalId: model.physicalId, model };
      } catch (error) { return providerFailure(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayResourceModel>> {
      try { const [apiId, resourceId] = parsePhysical(physicalId, "resource", 2); return { status: "SUCCESS", physicalId, model: await resourceReadModel(service, apiId, resourceId) }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayResourceModel>> {
      if (!same(previous, desired)) return { status: "FAILED", errorCode: "RequiresReplacement", message: "RestApiId, ParentId, and PathPart changes require replacement" };
      try { const [apiId, resourceId] = parsePhysical(physicalId, "resource", 2); const model = await resourceReadModel(service, apiId, resourceId); return { status: "SUCCESS", physicalId, model }; }
      catch (error) { return isMissing(error) ? { status: "FAILED", errorCode: "NotFoundException", message: `API Gateway resource ${physicalId} was not found` } : providerFailure(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try {
        const [apiId, resourceId] = parsePhysical(physicalId, "resource", 2);
        const resources = await call<JsonObject>(service, "GET", `/restapis/${segment(apiId)}/resources`);
        const child = (resources.item ?? []).find((value: JsonObject) => value.parentId === resourceId);
        if (child) throw new AwsError("ResourceConflict", `API Gateway resource ${resourceId} still has child ${String(child.id)}`, 409);
        await call(service, "DELETE", `/restapis/${segment(apiId)}/resources/${segment(resourceId)}`);
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    ref(model) { return String(model.attributes.ResourceId); },
    getAtt(model, attribute) { return unsupportedGetAtt(API_GATEWAY_RESOURCE_TYPE, API_GATEWAY_RESOURCE_SCHEMA, model, attribute); },
  };
}

function methodIssues(properties: unknown, service?: ApiGatewayService): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_METHOD_SCHEMA);
  if (!isObject(properties)) return issues;
  if (typeof properties.HttpMethod === "string" && !/^(?:ANY|[A-Za-z]+)$/.test(properties.HttpMethod)) issues.push(issue("Properties.HttpMethod", "HttpMethod must be an alphabetic method name or ANY"));
  if (properties.AuthorizationType !== undefined && !["NONE", "AWS_IAM", "CUSTOM", "COGNITO_USER_POOLS"].includes(properties.AuthorizationType)) issues.push(issue("Properties.AuthorizationType", "AuthorizationType must be NONE, AWS_IAM, CUSTOM, or COGNITO_USER_POOLS"));
  if ((properties.AuthorizationType === "CUSTOM" || properties.AuthorizationType === "COGNITO_USER_POOLS") && (typeof properties.AuthorizerId !== "string" || !properties.AuthorizerId)) issues.push(issue("Properties.AuthorizerId", `${properties.AuthorizationType} authorization requires AuthorizerId`));
  if (properties.AuthorizationType !== "COGNITO_USER_POOLS" && Array.isArray(properties.AuthorizationScopes) && properties.AuthorizationScopes.length) issues.push(issue("Properties.AuthorizationScopes", "AuthorizationScopes are valid only for COGNITO_USER_POOLS methods"));
  if (Array.isArray(properties.AuthorizationScopes)) properties.AuthorizationScopes.forEach((value, index) => { if (typeof value !== "string") issues.push(issue(`Properties.AuthorizationScopes[${index}]`, "AuthorizationScopes values must be strings", "InvalidType")); });
  validateStringMap(properties.RequestModels, "Properties.RequestModels", issues);
  validateBooleanMap(properties.RequestParameters, "Properties.RequestParameters", issues);
  if (Array.isArray(properties.MethodResponses)) {
    const statuses = new Set<string>();
    properties.MethodResponses.forEach((value, index) => {
      const path = `Properties.MethodResponses[${index}]`;
      if (!isObject(value)) { issues.push(issue(path, `${path} must be an object`, "InvalidType")); return; }
      for (const key of Object.keys(value)) if (!["StatusCode", "ResponseModels", "ResponseParameters"].includes(key)) issues.push(issue(`${path}.${key}`, `MethodResponse does not support ${key}`, "UnsupportedProperty"));
      if (typeof value.StatusCode !== "string" || !/^\d{3}$/.test(value.StatusCode)) issues.push(issue(`${path}.StatusCode`, "StatusCode must contain three digits"));
      else if (statuses.has(value.StatusCode)) issues.push(issue(`${path}.StatusCode`, `Duplicate status code ${value.StatusCode}`)); else statuses.add(value.StatusCode);
      validateStringMap(value.ResponseModels, `${path}.ResponseModels`, issues); validateBooleanMap(value.ResponseParameters, `${path}.ResponseParameters`, issues);
    });
  }
  if (isObject(properties.Integration)) {
    const integration = properties.Integration; const path = "Properties.Integration";
    const allowed = new Set(["Type", "IntegrationHttpMethod", "Uri", "ConnectionType", "Credentials", "RequestParameters", "RequestTemplates", "PassthroughBehavior", "ContentHandling", "TimeoutInMillis", "CacheNamespace", "CacheKeyParameters", "TlsConfig", "IntegrationResponses"]);
    for (const key of Object.keys(integration)) if (!allowed.has(key)) issues.push(issue(`${path}.${key}`, `Integration does not support ${key}`, "UnsupportedProperty"));
    if (!["AWS", "AWS_PROXY", "HTTP", "HTTP_PROXY", "MOCK"].includes(integration.Type)) issues.push(issue(`${path}.Type`, "Integration Type must be AWS, AWS_PROXY, HTTP, HTTP_PROXY, or MOCK"));
    if (integration.ConnectionType !== undefined && integration.ConnectionType !== "INTERNET") issues.push(issue(`${path}.ConnectionType`, "Only INTERNET connections are available through this provider"));
    if (integration.Type !== "MOCK" && (typeof integration.Uri !== "string" || !integration.Uri)) issues.push(issue(`${path}.Uri`, `${integration.Type} integrations require Uri`));
    const uri = typeof integration.Uri === "string" ? integration.Uri : "";
    const lambdaUri = /^arn:aws:apigateway:([a-z0-9-]+):lambda:path\/2015-03-31\/functions\/(arn:aws:lambda:([a-z0-9-]+):(\d{12}):function:[A-Za-z0-9-_]+(?::[A-Za-z0-9-_]+)?)\/invocations$/.exec(uri);
    if (integration.Type === "AWS_PROXY" && !lambdaUri) issues.push(issue(`${path}.Uri`, "AWS_PROXY integrations must use a Lambda invocation URI"));
    if (integration.Type === "AWS" && uri && !lambdaUri) {
      const target = /^arn:aws:apigateway:([a-z0-9-]+):(dynamodb|sqs):(action|path)\/?(.+)$/.exec(uri);
      const dynamoActions = new Set(["PutItem", "GetItem", "UpdateItem", "DeleteItem", "Query", "Scan", "BatchGetItem", "BatchWriteItem", "TransactGetItems", "TransactWriteItems"]);
      if (!target) issues.push(issue(`${path}.Uri`, "AWS integrations support only local Lambda, DynamoDB, and SQS targets"));
      else if (target[2] === "dynamodb" && (target[3] !== "action" || !dynamoActions.has(target[4]))) issues.push(issue(`${path}.Uri`, `DynamoDB integration action ${target[4]} is not supported`));
      else if (target[2] === "sqs" && target[3] === "action" && !/^(?:SendMessage|SendMessageBatch)(?:&.*)?$/.test(target[4])) issues.push(issue(`${path}.Uri`, `SQS integration action ${target[4]} is not supported`));
      else if (target[2] === "sqs" && target[3] === "path" && !/^\d{12}\/[^/]+$/.test(target[4])) issues.push(issue(`${path}.Uri`, "SQS path integrations require account-id/queue-name"));
      if (!integration.Credentials) issues.push(issue(`${path}.Credentials`, "DynamoDB and SQS integrations require an API Gateway execution role"));
    }
    if (["HTTP", "HTTP_PROXY"].includes(integration.Type) && uri) {
      try { const target = new URL(uri); if (!new Set(["http:", "https:"]).has(target.protocol) || target.username || target.password || target.hash) throw new Error(); }
      catch { issues.push(issue(`${path}.Uri`, `${integration.Type} integrations require a credential-free HTTP or HTTPS URL`)); }
    }
    if (integration.Credentials !== undefined && (typeof integration.Credentials !== "string" || !/^arn:aws:iam::\d{12}:role\/[\w+=,.@\/-]+$/.test(integration.Credentials))) issues.push(issue(`${path}.Credentials`, "Credentials must be an IAM role ARN"));
    if (integration.IntegrationHttpMethod !== undefined && typeof integration.IntegrationHttpMethod !== "string") issues.push(issue(`${path}.IntegrationHttpMethod`, "IntegrationHttpMethod must be a string", "InvalidType"));
    if (integration.PassthroughBehavior !== undefined && !["WHEN_NO_MATCH", "WHEN_NO_TEMPLATES", "NEVER"].includes(integration.PassthroughBehavior)) issues.push(issue(`${path}.PassthroughBehavior`, "Invalid PassthroughBehavior"));
    if (integration.ContentHandling !== undefined && !["CONVERT_TO_BINARY", "CONVERT_TO_TEXT"].includes(integration.ContentHandling)) issues.push(issue(`${path}.ContentHandling`, "Invalid ContentHandling"));
    if (typeof integration.TimeoutInMillis === "number" && (!Number.isInteger(integration.TimeoutInMillis) || integration.TimeoutInMillis < 50 || integration.TimeoutInMillis > 29_000)) issues.push(issue(`${path}.TimeoutInMillis`, "TimeoutInMillis must be an integer from 50 through 29000"));
    validateStringMap(integration.RequestParameters, `${path}.RequestParameters`, issues); validateStringMap(integration.RequestTemplates, `${path}.RequestTemplates`, issues);
    if (Array.isArray(integration.CacheKeyParameters)) integration.CacheKeyParameters.forEach((value, index) => { if (typeof value !== "string") issues.push(issue(`${path}.CacheKeyParameters[${index}]`, "CacheKeyParameters values must be strings", "InvalidType")); });
    else if (integration.CacheKeyParameters !== undefined) issues.push(issue(`${path}.CacheKeyParameters`, "CacheKeyParameters must be an array", "InvalidType"));
    if (isObject(integration.TlsConfig)) {
      for (const key of Object.keys(integration.TlsConfig)) if (key !== "InsecureSkipVerification") issues.push(issue(`${path}.TlsConfig.${key}`, `TlsConfig does not support ${key}`, "UnsupportedProperty"));
      if (integration.TlsConfig.InsecureSkipVerification !== undefined && typeof integration.TlsConfig.InsecureSkipVerification !== "boolean") issues.push(issue(`${path}.TlsConfig.InsecureSkipVerification`, "InsecureSkipVerification must be boolean", "InvalidType"));
    } else if (integration.TlsConfig !== undefined) issues.push(issue(`${path}.TlsConfig`, "TlsConfig must be an object", "InvalidType"));
    if (Array.isArray(integration.IntegrationResponses)) {
      const statuses = new Set<string>();
      integration.IntegrationResponses.forEach((value, index) => {
        const responsePath = `${path}.IntegrationResponses[${index}]`;
        if (!isObject(value)) { issues.push(issue(responsePath, `${responsePath} must be an object`, "InvalidType")); return; }
        for (const key of Object.keys(value)) if (!["StatusCode", "SelectionPattern", "ResponseParameters", "ResponseTemplates", "ContentHandling"].includes(key)) issues.push(issue(`${responsePath}.${key}`, `IntegrationResponse does not support ${key}`, "UnsupportedProperty"));
        if (typeof value.StatusCode !== "string" || !/^\d{3}$/.test(value.StatusCode)) issues.push(issue(`${responsePath}.StatusCode`, "StatusCode must contain three digits"));
        else if (statuses.has(value.StatusCode)) issues.push(issue(`${responsePath}.StatusCode`, `Duplicate status code ${value.StatusCode}`)); else statuses.add(value.StatusCode);
        validateStringMap(value.ResponseParameters, `${responsePath}.ResponseParameters`, issues); validateStringMap(value.ResponseTemplates, `${responsePath}.ResponseTemplates`, issues);
        if (value.ContentHandling !== undefined && !["CONVERT_TO_BINARY", "CONVERT_TO_TEXT"].includes(value.ContentHandling)) issues.push(issue(`${responsePath}.ContentHandling`, "Invalid ContentHandling"));
      });
    } else if (integration.IntegrationResponses !== undefined) issues.push(issue(`${path}.IntegrationResponses`, "IntegrationResponses must be an array", "InvalidType"));
  }
  const methodStatuses = new Set((Array.isArray(properties.MethodResponses) ? properties.MethodResponses : []).filter(isObject).map(value => value.StatusCode));
  for (const [index, value] of (Array.isArray(properties.Integration?.IntegrationResponses) ? properties.Integration.IntegrationResponses : []).entries()) if (isObject(value) && typeof value.StatusCode === "string" && !methodStatuses.has(value.StatusCode)) issues.push(issue(`Properties.Integration.IntegrationResponses[${index}].StatusCode`, `Integration response ${value.StatusCode} requires a matching MethodResponse`));
  if (!issues.length && service && isObject(properties.Integration)) {
    try { service.validateCloudFormationIntegration(String(properties.RestApiId), String(properties.ResourceId), String(properties.HttpMethod), properties.Integration); }
    catch (error) { issues.push(issue("Properties.Integration", error instanceof Error ? error.message : String(error))); }
  }
  return issues;
}

function canonicalMethodResponse(value: JsonObject): ApiGatewayMethodResponseModel {
  return Object.freeze({ StatusCode: String(value.StatusCode), ResponseModels: stringMap(value.ResponseModels), ResponseParameters: booleanMap(value.ResponseParameters) });
}

function canonicalIntegrationResponse(value: JsonObject): ApiGatewayIntegrationResponseModel {
  return Object.freeze({ StatusCode: String(value.StatusCode), ...(value.SelectionPattern === undefined ? {} : { SelectionPattern: String(value.SelectionPattern) }), ResponseParameters: stringMap(value.ResponseParameters), ResponseTemplates: stringMap(value.ResponseTemplates), ...(value.ContentHandling === undefined ? {} : { ContentHandling: value.ContentHandling }) });
}

function canonicalIntegration(value: JsonObject, defaultCacheNamespace?: string): ApiGatewayIntegrationModel {
  const type = value.Type as ApiGatewayIntegrationModel["Type"];
  const tls = value.TlsConfig as JsonObject | undefined;
  return Object.freeze({
    Type: type, IntegrationHttpMethod: String(value.IntegrationHttpMethod ?? "POST").toUpperCase(),
    ...(value.Uri === undefined ? {} : { Uri: String(value.Uri) }), ConnectionType: "INTERNET" as const,
    ...(value.Credentials === undefined ? {} : { Credentials: String(value.Credentials) }),
    RequestParameters: stringMap(value.RequestParameters), RequestTemplates: stringMap(value.RequestTemplates),
    PassthroughBehavior: (value.PassthroughBehavior ?? "WHEN_NO_MATCH") as ApiGatewayIntegrationModel["PassthroughBehavior"],
    ...(value.ContentHandling === undefined ? {} : { ContentHandling: value.ContentHandling }), TimeoutInMillis: Number(value.TimeoutInMillis ?? 29_000),
    ...(value.CacheNamespace === undefined && defaultCacheNamespace === undefined ? {} : { CacheNamespace: String(value.CacheNamespace ?? defaultCacheNamespace) }),
    CacheKeyParameters: Object.freeze([...(value.CacheKeyParameters ?? [])].map(String).sort()),
    ...(tls === undefined ? {} : { TlsConfig: Object.freeze({ InsecureSkipVerification: Boolean(tls.InsecureSkipVerification ?? false) }) }),
    IntegrationResponses: Object.freeze([...(value.IntegrationResponses ?? [])].map(canonicalIntegrationResponse).sort((a, b) => a.StatusCode.localeCompare(b.StatusCode))),
  });
}

function canonicalMethod(properties: unknown): ApiGatewayMethodModel {
  const issues = methodIssues(properties); throwIssues(issues); const input = properties as JsonObject;
  return Object.freeze({
    RestApiId: String(input.RestApiId), ResourceId: String(input.ResourceId), HttpMethod: String(input.HttpMethod).toUpperCase(),
    AuthorizationType: input.AuthorizationType as ApiGatewayMethodModel["AuthorizationType"],
    ...(input.AuthorizerId === undefined ? {} : { AuthorizerId: String(input.AuthorizerId) }),
    AuthorizationScopes: Object.freeze([...(input.AuthorizationScopes ?? [])].map(String).sort()), ApiKeyRequired: Boolean(input.ApiKeyRequired ?? false),
    ...(input.OperationName === undefined ? {} : { OperationName: String(input.OperationName) }), RequestModels: stringMap(input.RequestModels), RequestParameters: booleanMap(input.RequestParameters),
    ...(input.RequestValidatorId === undefined ? {} : { RequestValidatorId: String(input.RequestValidatorId) }),
    ...(input.Integration === undefined ? {} : { Integration: canonicalIntegration(input.Integration, String(input.ResourceId)) }),
    MethodResponses: Object.freeze([...(input.MethodResponses ?? [])].map(canonicalMethodResponse).sort((a, b) => a.StatusCode.localeCompare(b.StatusCode))),
  });
}

function integrationFromRaw(value: JsonObject): ApiGatewayIntegrationModel {
  return canonicalIntegration({
    Type: value.type, IntegrationHttpMethod: value.httpMethod, Uri: value.uri, ConnectionType: value.connectionType, Credentials: value.credentials,
    RequestParameters: value.requestParameters, RequestTemplates: value.requestTemplates, PassthroughBehavior: value.passthroughBehavior,
    ContentHandling: value.contentHandling, TimeoutInMillis: value.timeoutInMillis, CacheNamespace: value.cacheNamespace,
    CacheKeyParameters: value.cacheKeyParameters, TlsConfig: value.tlsConfig ? { InsecureSkipVerification: value.tlsConfig.insecureSkipVerification } : undefined,
    IntegrationResponses: Object.values(value.integrationResponses ?? {}).map((response: any) => ({ StatusCode: response.statusCode, SelectionPattern: response.selectionPattern, ResponseParameters: response.responseParameters, ResponseTemplates: response.responseTemplates, ContentHandling: response.contentHandling })),
  });
}

function methodFromRaw(apiId: string, resourceId: string, raw: JsonObject): ApiGatewayMethodModel {
  return canonicalMethod(withoutUndefined({
    RestApiId: apiId, ResourceId: resourceId, HttpMethod: raw.httpMethod, AuthorizationType: raw.authorizationType,
    AuthorizerId: raw.authorizerId, AuthorizationScopes: raw.authorizationScopes, ApiKeyRequired: raw.apiKeyRequired, OperationName: raw.operationName,
    RequestModels: raw.requestModels, RequestParameters: raw.requestParameters, RequestValidatorId: raw.requestValidatorId,
    Integration: raw.methodIntegration ? integrationFromRaw(raw.methodIntegration) : undefined,
    MethodResponses: Object.values(raw.methodResponses ?? {}).map((response: any) => ({ StatusCode: response.statusCode, ResponseModels: response.responseModels, ResponseParameters: response.responseParameters })),
  }));
}

function methodPath(model: Pick<ApiGatewayMethodModel, "RestApiId" | "ResourceId" | "HttpMethod">): string {
  return `/restapis/${segment(model.RestApiId)}/resources/${segment(model.ResourceId)}/methods/${segment(model.HttpMethod)}`;
}

async function readMethodModel(service: ApiGatewayService, apiId: string, resourceId: string, httpMethod: string, context: ProviderContext): Promise<ProviderReadModel<ApiGatewayMethodModel>> {
  const raw = await call<JsonObject>(service, "GET", methodPath({ RestApiId: apiId, ResourceId: resourceId, HttpMethod: httpMethod }));
  const physicalId = physical("method", [apiId, resourceId, httpMethod]);
  return { physicalId, properties: methodFromRaw(apiId, resourceId, raw), attributes: { Ref: opaqueCloudFormationId("method", context) } };
}

type MethodLifecycleOperation = "CREATE" | "UPDATE" | "DELETE";
type MethodLifecyclePhase = "delete-method" | "put-method" | "put-integration" | "put-method-response" | "put-integration-response" | "verify";

interface MethodLifecycleCheckpoint {
  readonly operation: MethodLifecycleOperation;
  readonly phase: MethodLifecyclePhase;
  readonly index: number;
}

const METHOD_LIFECYCLE_STATE_MACHINE = "apigateway-method-v1";

function methodBase(model: ApiGatewayMethodModel): Omit<ApiGatewayMethodModel, "Integration" | "MethodResponses"> {
  const { Integration: _integration, MethodResponses: _responses, ...base } = model;
  return base;
}

function integrationBase(model: ApiGatewayIntegrationModel): Omit<ApiGatewayIntegrationModel, "IntegrationResponses"> {
  const { IntegrationResponses: _responses, ...base } = model;
  return base;
}

function prefixLength<T>(current: readonly T[], desired: readonly T[]): number | undefined {
  if (current.length > desired.length) return undefined;
  for (let index = 0; index < current.length; index++) if (!same(current[index], desired[index])) return undefined;
  return current.length;
}

function afterMethodPhase(desired: ApiGatewayMethodModel): MethodLifecycleCheckpoint {
  if (desired.Integration) return { operation: "CREATE", phase: "put-integration", index: 0 };
  if (desired.MethodResponses.length) return { operation: "CREATE", phase: "put-method-response", index: 0 };
  return { operation: "CREATE", phase: "verify", index: 0 };
}

function afterIntegrationPhase(desired: ApiGatewayMethodModel): MethodLifecycleCheckpoint {
  if (desired.MethodResponses.length) return { operation: "CREATE", phase: "put-method-response", index: 0 };
  if (desired.Integration?.IntegrationResponses.length) return { operation: "CREATE", phase: "put-integration-response", index: 0 };
  return { operation: "CREATE", phase: "verify", index: 0 };
}

function afterMethodResponsePhase(desired: ApiGatewayMethodModel, index: number): MethodLifecycleCheckpoint {
  if (index + 1 < desired.MethodResponses.length) return { operation: "CREATE", phase: "put-method-response", index: index + 1 };
  if (desired.Integration?.IntegrationResponses.length) return { operation: "CREATE", phase: "put-integration-response", index: 0 };
  return { operation: "CREATE", phase: "verify", index: 0 };
}

function afterIntegrationResponsePhase(desired: ApiGatewayMethodModel, index: number): MethodLifecycleCheckpoint {
  if (index + 1 < (desired.Integration?.IntegrationResponses.length ?? 0)) return { operation: "CREATE", phase: "put-integration-response", index: index + 1 };
  return { operation: "CREATE", phase: "verify", index: 0 };
}

function withOperation(checkpoint: MethodLifecycleCheckpoint, operation: MethodLifecycleOperation): MethodLifecycleCheckpoint {
  return { ...checkpoint, operation };
}

function methodInProgress(physicalId: string, checkpoint: MethodLifecycleCheckpoint): ProviderInProgress {
  return {
    status: "IN_PROGRESS",
    callbackAfterMs: 25,
    checkpoint: {
      schemaVersion: 1,
      physicalId,
      callbackContext: {
        stateMachine: METHOD_LIFECYCLE_STATE_MACHINE,
        operation: checkpoint.operation,
        phase: checkpoint.phase,
        index: checkpoint.index,
      },
    },
  };
}

function lifecycleCheckpoint(context: ProviderContext, operation: MethodLifecycleOperation): MethodLifecycleCheckpoint | undefined {
  const value = context.callbackContext;
  if (value === undefined || Object.keys(value).length === 0) return undefined;
  const phases = new Set<MethodLifecyclePhase>(["delete-method", "put-method", "put-integration", "put-method-response", "put-integration-response", "verify"]);
  if (value.stateMachine !== METHOD_LIFECYCLE_STATE_MACHINE || value.operation !== operation || typeof value.phase !== "string" || !phases.has(value.phase as MethodLifecyclePhase) || !Number.isSafeInteger(value.index) || Number(value.index) < 0) {
    throw new AwsError("InvalidCallbackContext", `Invalid ${API_GATEWAY_METHOD_TYPE} ${operation} callback context`, 400);
  }
  return { operation, phase: value.phase as MethodLifecyclePhase, index: Number(value.index) };
}

function compatibleCreateResume(current: ApiGatewayMethodModel, desired: ApiGatewayMethodModel): MethodLifecycleCheckpoint | undefined {
  if (!same(methodBase(current), methodBase(desired))) return undefined;
  const methodResponsePrefix = prefixLength(current.MethodResponses, desired.MethodResponses);
  if (methodResponsePrefix === undefined) return undefined;
  if (!desired.Integration) {
    if (current.Integration) return undefined;
    return methodResponsePrefix < desired.MethodResponses.length
      ? { operation: "CREATE", phase: "put-method-response", index: methodResponsePrefix }
      : { operation: "CREATE", phase: "verify", index: 0 };
  }
  if (!current.Integration) {
    if (current.MethodResponses.length) return undefined;
    return { operation: "CREATE", phase: "put-integration", index: 0 };
  }
  if (!same(integrationBase(current.Integration), integrationBase(desired.Integration))) return undefined;
  if (methodResponsePrefix < desired.MethodResponses.length) {
    if (current.Integration.IntegrationResponses.length) return undefined;
    return { operation: "CREATE", phase: "put-method-response", index: methodResponsePrefix };
  }
  const integrationResponsePrefix = prefixLength(current.Integration.IntegrationResponses, desired.Integration.IntegrationResponses);
  if (integrationResponsePrefix === undefined) return undefined;
  return integrationResponsePrefix < desired.Integration.IntegrationResponses.length
    ? { operation: "CREATE", phase: "put-integration-response", index: integrationResponsePrefix }
    : { operation: "CREATE", phase: "verify", index: 0 };
}

async function putMethodMutation(service: ApiGatewayService, desired: ApiGatewayMethodModel): Promise<void> {
  await call(service, "PUT", methodPath(desired), {
    authorizationType: desired.AuthorizationType, authorizerId: desired.AuthorizerId, authorizationScopes: desired.AuthorizationScopes,
    apiKeyRequired: desired.ApiKeyRequired, operationName: desired.OperationName, requestModels: desired.RequestModels,
    requestParameters: desired.RequestParameters, requestValidatorId: desired.RequestValidatorId,
  });
}

async function putIntegrationMutation(service: ApiGatewayService, desired: ApiGatewayMethodModel): Promise<void> {
  const integration = desired.Integration;
  if (!integration) throw new AwsError("InvalidCallbackContext", "The callback requested an integration mutation but the desired Method has no Integration", 400);
  await call(service, "PUT", `${methodPath(desired)}/integration`, {
    type: integration.Type, integrationHttpMethod: integration.IntegrationHttpMethod, uri: integration.Uri, connectionType: integration.ConnectionType,
    credentials: integration.Credentials, requestParameters: integration.RequestParameters, requestTemplates: integration.RequestTemplates,
    passthroughBehavior: integration.PassthroughBehavior, contentHandling: integration.ContentHandling, timeoutInMillis: integration.TimeoutInMillis,
    cacheNamespace: integration.CacheNamespace, cacheKeyParameters: integration.CacheKeyParameters,
    tlsConfig: integration.TlsConfig ? { insecureSkipVerification: integration.TlsConfig.InsecureSkipVerification } : undefined,
  });
}

function nextMethodCheckpoint(desired: ApiGatewayMethodModel, checkpoint: MethodLifecycleCheckpoint): MethodLifecycleCheckpoint {
  switch (checkpoint.phase) {
    case "delete-method": return checkpoint.operation === "DELETE" ? { operation: "DELETE", phase: "verify", index: 0 } : { operation: checkpoint.operation, phase: "put-method", index: 0 };
    case "put-method": return withOperation(afterMethodPhase(desired), checkpoint.operation);
    case "put-integration": return withOperation(afterIntegrationPhase(desired), checkpoint.operation);
    case "put-method-response": return withOperation(afterMethodResponsePhase(desired, checkpoint.index), checkpoint.operation);
    case "put-integration-response": return withOperation(afterIntegrationResponsePhase(desired, checkpoint.index), checkpoint.operation);
    case "verify": return checkpoint;
  }
}

type MethodPhaseObservation =
  | { readonly state: "APPLIED" }
  | { readonly state: "PENDING" }
  | { readonly state: "REWIND"; readonly checkpoint: MethodLifecycleCheckpoint };

async function observeMethodPhase(service: ApiGatewayService, desired: ApiGatewayMethodModel, checkpoint: MethodLifecycleCheckpoint, context: ProviderContext): Promise<MethodPhaseObservation> {
  let current: ApiGatewayMethodModel | undefined;
  try { current = (await readMethodModel(service, desired.RestApiId, desired.ResourceId, desired.HttpMethod, context)).properties; }
  catch (error) { if (!isMissing(error)) throw error; }
  if (checkpoint.phase === "delete-method") return current ? { state: "PENDING" } : { state: "APPLIED" };
  if (!current) return checkpoint.phase === "put-method" ? { state: "PENDING" } : { state: "REWIND", checkpoint: { operation: checkpoint.operation, phase: "put-method", index: 0 } };
  if (!same(methodBase(current), methodBase(desired))) return { state: "REWIND", checkpoint: { operation: checkpoint.operation, phase: "delete-method", index: 0 } };
  if (checkpoint.phase === "put-method") return { state: "APPLIED" };
  if (checkpoint.phase === "put-integration") {
    if (!desired.Integration) throw new AwsError("InvalidCallbackContext", "The callback requested an integration mutation but the desired Method has no Integration", 400);
    return current.Integration && same(integrationBase(current.Integration), integrationBase(desired.Integration)) ? { state: "APPLIED" } : { state: "PENDING" };
  }
  if (checkpoint.phase === "put-method-response") {
    if (desired.Integration && (!current.Integration || !same(integrationBase(current.Integration), integrationBase(desired.Integration)))) return { state: "REWIND", checkpoint: { operation: checkpoint.operation, phase: "put-integration", index: 0 } };
    const desiredResponse = desired.MethodResponses[checkpoint.index];
    if (!desiredResponse) throw new AwsError("InvalidCallbackContext", `Method response callback index ${checkpoint.index} is out of range`, 400);
    const actual = current.MethodResponses.find(response => response.StatusCode === desiredResponse.StatusCode);
    return actual && same(actual, desiredResponse) ? { state: "APPLIED" } : { state: "PENDING" };
  }
  if (checkpoint.phase === "put-integration-response") {
    if (!desired.Integration) throw new AwsError("InvalidCallbackContext", "The callback requested an integration response mutation but the desired Method has no Integration", 400);
    if (!current.Integration || !same(integrationBase(current.Integration), integrationBase(desired.Integration))) return { state: "REWIND", checkpoint: { operation: checkpoint.operation, phase: "put-integration", index: 0 } };
    const missingMethodResponse = desired.MethodResponses.findIndex(response => !same(current!.MethodResponses.find(actual => actual.StatusCode === response.StatusCode), response));
    if (missingMethodResponse >= 0) return { state: "REWIND", checkpoint: { operation: checkpoint.operation, phase: "put-method-response", index: missingMethodResponse } };
    const desiredResponse = desired.Integration.IntegrationResponses[checkpoint.index];
    if (!desiredResponse) throw new AwsError("InvalidCallbackContext", `Integration response callback index ${checkpoint.index} is out of range`, 400);
    const actual = current.Integration.IntegrationResponses.find(response => response.StatusCode === desiredResponse.StatusCode);
    return actual && same(actual, desiredResponse) ? { state: "APPLIED" } : { state: "PENDING" };
  }
  throw new AwsError("InvalidCallbackContext", "Verification does not perform a mutation", 400);
}

async function mutateMethodLifecycle(service: ApiGatewayService, desired: ApiGatewayMethodModel, physicalId: string, checkpoint: MethodLifecycleCheckpoint, context: ProviderContext): Promise<ProviderInProgress> {
  const observation = await observeMethodPhase(service, desired, checkpoint, context);
  if (observation.state === "APPLIED") return methodInProgress(physicalId, nextMethodCheckpoint(desired, checkpoint));
  if (observation.state === "REWIND") return methodInProgress(physicalId, observation.checkpoint);
  const base = methodPath(desired);
  switch (checkpoint.phase) {
    case "delete-method":
      await call(service, "DELETE", base);
      return methodInProgress(physicalId, nextMethodCheckpoint(desired, checkpoint));
    case "put-method":
      await putMethodMutation(service, desired);
      return methodInProgress(physicalId, nextMethodCheckpoint(desired, checkpoint));
    case "put-integration":
      await putIntegrationMutation(service, desired);
      return methodInProgress(physicalId, nextMethodCheckpoint(desired, checkpoint));
    case "put-method-response": {
      const response = desired.MethodResponses[checkpoint.index];
      if (!response) throw new AwsError("InvalidCallbackContext", `Method response callback index ${checkpoint.index} is out of range`, 400);
      await call(service, "PUT", `${base}/responses/${segment(response.StatusCode)}`, { statusCode: response.StatusCode, responseModels: response.ResponseModels, responseParameters: response.ResponseParameters });
      return methodInProgress(physicalId, nextMethodCheckpoint(desired, checkpoint));
    }
    case "put-integration-response": {
      const response = desired.Integration?.IntegrationResponses[checkpoint.index];
      if (!response) throw new AwsError("InvalidCallbackContext", `Integration response callback index ${checkpoint.index} is out of range`, 400);
      await call(service, "PUT", `${base}/integration/responses/${segment(response.StatusCode)}`, { statusCode: response.StatusCode, selectionPattern: response.SelectionPattern, responseParameters: response.ResponseParameters, responseTemplates: response.ResponseTemplates, contentHandling: response.ContentHandling });
      return methodInProgress(physicalId, nextMethodCheckpoint(desired, checkpoint));
    }
    case "verify": throw new AwsError("InvalidCallbackContext", "Verification does not perform a mutation", 400);
  }
}

export function createApiGatewayMethodProvider(service: ApiGatewayService): ProductionResourceProvider<ApiGatewayMethodModel> {
  const names = Object.keys(API_GATEWAY_METHOD_SCHEMA.properties).sort();
  return {
    typeName: API_GATEWAY_METHOD_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_METHOD_SCHEMA,
    validate(properties) { return methodIssues(properties, service); }, canonicalize(properties) { return canonicalMethod(properties); },
    plan(previous, desired) { return plan(previous, desired, names, ["RestApiId", "ResourceId", "HttpMethod"]); },
    async create(desired, context) {
      try {
        const physicalId = physical("method", [desired.RestApiId, desired.ResourceId, desired.HttpMethod]);
        const checkpoint = lifecycleCheckpoint(context, "CREATE");
        if (checkpoint) {
          if (checkpoint.phase !== "verify") return await mutateMethodLifecycle(service, desired, physicalId, checkpoint, context);
          try {
            const model = await readMethodModel(service, desired.RestApiId, desired.ResourceId, desired.HttpMethod, context);
            if (same(model.properties, desired)) return { status: "SUCCESS", physicalId, model };
            return await mutateMethodLifecycle(service, desired, physicalId, { operation: "CREATE", phase: "delete-method", index: 0 }, context);
          } catch (error) {
            if (!isMissing(error)) throw error;
            return await mutateMethodLifecycle(service, desired, physicalId, { operation: "CREATE", phase: "put-method", index: 0 }, context);
          }
        }
        try {
          const existing = await readMethodModel(service, desired.RestApiId, desired.ResourceId, desired.HttpMethod, context);
          if (same(existing.properties, desired)) return { status: "SUCCESS", physicalId: existing.physicalId, model: existing };
          const resume = compatibleCreateResume(existing.properties, desired);
          if (resume && resume.phase !== "verify") return await mutateMethodLifecycle(service, desired, physicalId, resume, context);
          return { status: "FAILED", errorCode: "ConflictException", message: `Method ${desired.HttpMethod} already exists on resource ${desired.ResourceId}` };
        } catch (error) { if (!isMissing(error)) throw error; }
        return await mutateMethodLifecycle(service, desired, physicalId, { operation: "CREATE", phase: "put-method", index: 0 }, context);
      } catch (error) { return providerFailure(error); }
    },
    async read(physicalId, context): Promise<ProviderReadResult<ApiGatewayMethodModel>> {
      try { const [apiId, resourceId, httpMethod] = parsePhysical(physicalId, "method", 3); return { status: "SUCCESS", physicalId, model: await readMethodModel(service, apiId, resourceId, httpMethod, context) }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayMethodModel>> {
      try {
        const [apiId, resourceId, httpMethod] = parsePhysical(physicalId, "method", 3);
        if (apiId !== desired.RestApiId || resourceId !== desired.ResourceId || httpMethod !== desired.HttpMethod || previous.RestApiId !== desired.RestApiId || previous.ResourceId !== desired.ResourceId || previous.HttpMethod !== desired.HttpMethod) throw new AwsError("RequiresReplacement", "RestApiId, ResourceId, and HttpMethod changes require replacement", 409);
        const checkpoint = lifecycleCheckpoint(context, "UPDATE");
        if (checkpoint) {
          if (checkpoint.phase !== "verify") return await mutateMethodLifecycle(service, desired, physicalId, checkpoint, context);
          try {
            const model = await readMethodModel(service, apiId, resourceId, httpMethod, context);
            if (same(model.properties, desired)) return { status: "SUCCESS", physicalId, model };
            return await mutateMethodLifecycle(service, desired, physicalId, { operation: "UPDATE", phase: "delete-method", index: 0 }, context);
          } catch (error) {
            if (!isMissing(error)) throw error;
            return await mutateMethodLifecycle(service, desired, physicalId, { operation: "UPDATE", phase: "put-method", index: 0 }, context);
          }
        }
        try {
          const current = await readMethodModel(service, apiId, resourceId, httpMethod, context);
          if (same(current.properties, desired)) return { status: "SUCCESS", physicalId, model: current };
          return await mutateMethodLifecycle(service, desired, physicalId, { operation: "UPDATE", phase: "delete-method", index: 0 }, context);
        } catch (error) {
          if (!isMissing(error)) throw error;
          return await mutateMethodLifecycle(service, desired, physicalId, { operation: "UPDATE", phase: "put-method", index: 0 }, context);
        }
      } catch (error) { return providerFailure(error); }
    },
    async delete(physicalId, previous, context): Promise<ProviderDeleteResult> {
      try {
        const [apiId, resourceId, httpMethod] = parsePhysical(physicalId, "method", 3);
        const desired = { ...previous, RestApiId: apiId, ResourceId: resourceId, HttpMethod: httpMethod };
        const checkpoint = lifecycleCheckpoint(context, "DELETE");
        if (checkpoint && checkpoint.phase !== "verify") return await mutateMethodLifecycle(service, desired, physicalId, checkpoint, context);
        try {
          await readMethodModel(service, apiId, resourceId, httpMethod, context);
          return await mutateMethodLifecycle(service, desired, physicalId, { operation: "DELETE", phase: "delete-method", index: 0 }, context);
        } catch (error) {
          if (!isMissing(error)) throw error;
          return checkpoint ? { status: "SUCCESS", physicalId } : { status: "NOT_FOUND", physicalId };
        }
      } catch (error) { return providerFailure(error); }
    },
    ref(model) { return String(model.attributes.Ref); },
    getAtt(model, attribute) { return unsupportedGetAtt(API_GATEWAY_METHOD_TYPE, API_GATEWAY_METHOD_SCHEMA, model, attribute); },
  };
}

function deploymentIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_DEPLOYMENT_SCHEMA);
  if (isObject(properties) && typeof properties.RestApiId === "string" && !properties.RestApiId) issues.push(issue("Properties.RestApiId", "RestApiId must not be empty"));
  return issues;
}

function canonicalDeployment(properties: unknown): ApiGatewayDeploymentModel {
  const issues = deploymentIssues(properties); throwIssues(issues); const input = properties as JsonObject;
  return Object.freeze({ RestApiId: String(input.RestApiId), Description: String(input.Description ?? "") });
}

async function deploymentReadModel(service: ApiGatewayService, apiId: string, deploymentId: string): Promise<ProviderReadModel<ApiGatewayDeploymentModel>> {
  const raw = await call<JsonObject>(service, "GET", `/restapis/${segment(apiId)}/deployments/${segment(deploymentId)}`);
  return { physicalId: physical("deployment", [apiId, deploymentId]), properties: { RestApiId: apiId, Description: String(raw.description ?? "") }, attributes: { DeploymentId: deploymentId } };
}

function deploymentOperationToken(context: ProviderContext): string {
  return createHash("sha256").update(`${API_GATEWAY_DEPLOYMENT_TYPE}\0${context.stackId}\0${context.logicalId}\0${context.idempotencyKey}`).digest("hex");
}

function deploymentInProgress(apiId: string, deploymentId: string, token: string): ProviderInProgress {
  const physicalId = physical("deployment", [apiId, deploymentId]);
  return { status: "IN_PROGRESS", callbackAfterMs: 25, checkpoint: { schemaVersion: 1, physicalId, callbackContext: { stateMachine: "apigateway-deployment-v1", apiId, deploymentId, token } } };
}

async function operationDeployment(service: ApiGatewayService, desired: ApiGatewayDeploymentModel, token: string): Promise<JsonObject | undefined> {
  const query = new URLSearchParams({ "stacksim-cloudformation-operation-token": token });
  const raw = await call<JsonObject>(service, "GET", `/restapis/${segment(desired.RestApiId)}/deployments?${query.toString()}`);
  const candidates = raw.item ?? [];
  if (candidates.length > 1) throw new AwsError("ConflictException", `Multiple deployments carry CloudFormation operation token ${token}`, 409);
  const candidate = candidates[0];
  if (candidate && String(candidate.description ?? "") !== desired.Description) throw new AwsError("ConflictException", `CloudFormation operation token ${token} belongs to a different deployment`, 409);
  return candidate;
}

export function createApiGatewayDeploymentProvider(service: ApiGatewayService): ProductionResourceProvider<ApiGatewayDeploymentModel> {
  const names = Object.keys(API_GATEWAY_DEPLOYMENT_SCHEMA.properties).sort();
  return {
    typeName: API_GATEWAY_DEPLOYMENT_TYPE, providerVersion: 2, visibility: "production", schema: API_GATEWAY_DEPLOYMENT_SCHEMA,
    validate(properties) { return deploymentIssues(properties); }, canonicalize(properties) { return canonicalDeployment(properties); },
    plan(previous, desired) { return plan(previous, desired, names, ["Description", "RestApiId"]); },
    async create(desired, context) {
      try {
        const token = deploymentOperationToken(context); const rawCallback = context.callbackContext;
        if (rawCallback !== undefined && !isObject(rawCallback)) throw new AwsError("InvalidCallbackContext", "Invalid AWS::ApiGateway::Deployment create callback context", 400);
        const callback = rawCallback && Object.keys(rawCallback).length ? rawCallback : undefined;
        if (callback !== undefined && (callback.stateMachine !== "apigateway-deployment-v1" || callback.apiId !== desired.RestApiId || callback.token !== token || typeof callback.deploymentId !== "string" || !callback.deploymentId)) throw new AwsError("InvalidCallbackContext", "Invalid AWS::ApiGateway::Deployment create callback context", 400);
        const owned = await operationDeployment(service, desired, token);
        if (owned) {
          const deploymentId = String(owned.id);
          if (callback && callback.deploymentId !== deploymentId) throw new AwsError("OwnershipConflict", `Deployment callback ${String(callback.deploymentId)} does not match operation-owned deployment ${deploymentId}`, 409);
          if (!callback) return deploymentInProgress(desired.RestApiId, deploymentId, token);
          const model = await deploymentReadModel(service, desired.RestApiId, deploymentId);
          if (!same(model.properties, desired)) throw new AwsError("OwnershipConflict", `Operation-owned deployment ${deploymentId} no longer matches the desired resource`, 409);
          return { status: "SUCCESS", physicalId: model.physicalId, model };
        }
        if (callback) throw new AwsError("NotFoundException", `Operation-owned deployment ${String(callback.deploymentId)} was not found`, 404);
        const raw = await call<JsonObject>(service, "POST", `/restapis/${segment(desired.RestApiId)}/deployments`, { description: desired.Description, stackSimCloudFormationOperationToken: token });
        return deploymentInProgress(desired.RestApiId, String(raw.id), token);
      }
      catch (error) { return providerFailure(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayDeploymentModel>> {
      try { const [apiId, deploymentId] = parsePhysical(physicalId, "deployment", 2); return { status: "SUCCESS", physicalId, model: await deploymentReadModel(service, apiId, deploymentId) }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    async update(physicalId, previous, desired): Promise<ProviderUpdateResult<ApiGatewayDeploymentModel>> {
      try {
        const [apiId, deploymentId] = parsePhysical(physicalId, "deployment", 2);
        if (apiId !== desired.RestApiId || previous.RestApiId !== desired.RestApiId || previous.Description !== desired.Description) throw new AwsError("RequiresReplacement", "RestApiId and Description changes require replacement", 409);
        const model = await deploymentReadModel(service, apiId, deploymentId); return { status: "SUCCESS", physicalId, model };
      } catch (error) { return providerFailure(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try { const [apiId, deploymentId] = parsePhysical(physicalId, "deployment", 2); await call(service, "DELETE", `/restapis/${segment(apiId)}/deployments/${segment(deploymentId)}`); return { status: "SUCCESS", physicalId }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    ref(model) { return String(model.attributes.DeploymentId); },
    getAtt(model, attribute) { return unsupportedGetAtt(API_GATEWAY_DEPLOYMENT_TYPE, API_GATEWAY_DEPLOYMENT_SCHEMA, model, attribute); },
  };
}

const METHOD_SETTING_KEYS = Object.freeze({
  MetricsEnabled: "metrics/enabled", LoggingLevel: "logging/loglevel", DataTraceEnabled: "logging/dataTrace",
  ThrottlingBurstLimit: "throttling/burstLimit", ThrottlingRateLimit: "throttling/rateLimit",
  CachingEnabled: "caching/enabled", CacheTtlInSeconds: "caching/ttlInSeconds", CacheDataEncrypted: "caching/dataEncrypted",
  RequireAuthorizationForCacheControl: "caching/requireAuthorizationForCacheControl",
  UnauthorizedCacheControlHeaderStrategy: "caching/unauthorizedCacheControlHeaderStrategy",
} as const);

const METHOD_SETTING_RAW = Object.freeze({
  MetricsEnabled: "metricsEnabled", LoggingLevel: "loggingLevel", DataTraceEnabled: "dataTraceEnabled",
  ThrottlingBurstLimit: "throttlingBurstLimit", ThrottlingRateLimit: "throttlingRateLimit",
  CachingEnabled: "cachingEnabled", CacheTtlInSeconds: "cacheTtlInSeconds", CacheDataEncrypted: "cacheDataEncrypted",
  RequireAuthorizationForCacheControl: "requireAuthorizationForCacheControl",
  UnauthorizedCacheControlHeaderStrategy: "unauthorizedCacheControlHeaderStrategy",
} as const);

function stageIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_STAGE_SCHEMA);
  if (!isObject(properties)) return issues;
  if (typeof properties.StageName === "string" && !/^[A-Za-z0-9_-]{1,128}$/.test(properties.StageName)) issues.push(issue("Properties.StageName", "StageName must contain 1 to 128 letters, digits, underscores, or hyphens"));
  validateStringMap(properties.Variables, "Properties.Variables", issues);
  if (isObject(properties.Variables)) for (const [key, value] of Object.entries(properties.Variables)) if (!/^[A-Za-z0-9_]+$/.test(key) || typeof value === "string" && !/^[A-Za-z0-9\-._~:/?#&=,]+$/.test(value)) issues.push(issue(`Properties.Variables.${key}`, "Stage variable name or value is invalid"));
  if (properties.TracingEnabled === true) issues.push(issue("Properties.TracingEnabled", "TracingEnabled true requires X-Ray, which is not available in this simulator", "UnsupportedProperty"));
  if (properties.CacheClusterSize !== undefined && !["0.5", "1.6", "6.1", "13.5", "28.4", "58.2", "118", "237"].includes(properties.CacheClusterSize)) issues.push(issue("Properties.CacheClusterSize", "CacheClusterSize is invalid"));
  if (isObject(properties.AccessLogSetting)) {
    for (const key of Object.keys(properties.AccessLogSetting)) if (!["DestinationArn", "Format"].includes(key)) issues.push(issue(`Properties.AccessLogSetting.${key}`, `AccessLogSetting does not support ${key}`, "UnsupportedProperty"));
    for (const key of ["DestinationArn", "Format"]) if (properties.AccessLogSetting[key] !== undefined && typeof properties.AccessLogSetting[key] !== "string") issues.push(issue(`Properties.AccessLogSetting.${key}`, `${key} must be a string`, "InvalidType"));
  }
  if (isObject(properties.CanarySetting)) {
    const allowed = new Set(["DeploymentId", "PercentTraffic", "StageVariableOverrides", "UseStageCache"]);
    for (const key of Object.keys(properties.CanarySetting)) if (!allowed.has(key)) issues.push(issue(`Properties.CanarySetting.${key}`, `CanarySetting does not support ${key}`, "UnsupportedProperty"));
    const percent = properties.CanarySetting.PercentTraffic;
    if (percent !== undefined && (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100)) issues.push(issue("Properties.CanarySetting.PercentTraffic", "PercentTraffic must be a number from 0 through 100"));
    validateStringMap(properties.CanarySetting.StageVariableOverrides, "Properties.CanarySetting.StageVariableOverrides", issues);
    if (isObject(properties.CanarySetting.StageVariableOverrides)) for (const [key, value] of Object.entries(properties.CanarySetting.StageVariableOverrides)) if (!/^[A-Za-z0-9_]+$/.test(key) || typeof value === "string" && !/^[A-Za-z0-9\-._~:/?#&=,]+$/.test(value)) issues.push(issue(`Properties.CanarySetting.StageVariableOverrides.${key}`, "Canary stage variable name or value is invalid"));
    if (properties.CanarySetting.UseStageCache !== undefined && typeof properties.CanarySetting.UseStageCache !== "boolean") issues.push(issue("Properties.CanarySetting.UseStageCache", "UseStageCache must be boolean", "InvalidType"));
    if (typeof percent === "number" && percent > 0 && !properties.CanarySetting.DeploymentId) issues.push(issue("Properties.CanarySetting.DeploymentId", "A canary DeploymentId is required when PercentTraffic is greater than zero"));
  }
  if (Array.isArray(properties.MethodSettings)) {
    const identities = new Set<string>();
    properties.MethodSettings.forEach((value, index) => {
      const path = `Properties.MethodSettings[${index}]`;
      if (!isObject(value)) { issues.push(issue(path, `${path} must be an object`, "InvalidType")); return; }
      const allowed = new Set(["ResourcePath", "HttpMethod", ...Object.keys(METHOD_SETTING_KEYS)]);
      for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(issue(`${path}.${key}`, `MethodSetting does not support ${key}`, "UnsupportedProperty"));
      if (typeof value.ResourcePath !== "string" || (!value.ResourcePath.startsWith("/") && value.ResourcePath !== "*")) issues.push(issue(`${path}.ResourcePath`, "ResourcePath must start with /"));
      if (typeof value.HttpMethod !== "string" || !value.HttpMethod) issues.push(issue(`${path}.HttpMethod`, "HttpMethod is required"));
      const identity = `${value.ResourcePath}\0${String(value.HttpMethod).toUpperCase()}`; if (identities.has(identity)) issues.push(issue(path, "Duplicate ResourcePath and HttpMethod method setting")); else identities.add(identity);
      for (const key of ["MetricsEnabled", "DataTraceEnabled", "CachingEnabled", "CacheDataEncrypted", "RequireAuthorizationForCacheControl"]) if (value[key] !== undefined && typeof value[key] !== "boolean") issues.push(issue(`${path}.${key}`, `${key} must be boolean`, "InvalidType"));
      if (value.ThrottlingBurstLimit !== undefined && (typeof value.ThrottlingBurstLimit !== "number" || !Number.isInteger(value.ThrottlingBurstLimit) || value.ThrottlingBurstLimit < 0)) issues.push(issue(`${path}.ThrottlingBurstLimit`, "ThrottlingBurstLimit must be a non-negative integer"));
      if (value.ThrottlingRateLimit !== undefined && (typeof value.ThrottlingRateLimit !== "number" || !Number.isFinite(value.ThrottlingRateLimit) || value.ThrottlingRateLimit < 0)) issues.push(issue(`${path}.ThrottlingRateLimit`, "ThrottlingRateLimit must be non-negative"));
      if (value.CacheTtlInSeconds !== undefined && (typeof value.CacheTtlInSeconds !== "number" || !Number.isInteger(value.CacheTtlInSeconds) || value.CacheTtlInSeconds < 0 || value.CacheTtlInSeconds > 3600)) issues.push(issue(`${path}.CacheTtlInSeconds`, "CacheTtlInSeconds must be an integer from 0 through 3600"));
      if (value.LoggingLevel !== undefined && !["OFF", "ERROR", "INFO"].includes(value.LoggingLevel)) issues.push(issue(`${path}.LoggingLevel`, "LoggingLevel must be OFF, ERROR, or INFO"));
      if (value.UnauthorizedCacheControlHeaderStrategy !== undefined && !["FAIL_WITH_403", "SUCCEED_WITH_RESPONSE_HEADER", "SUCCEED_WITHOUT_RESPONSE_HEADER"].includes(value.UnauthorizedCacheControlHeaderStrategy)) issues.push(issue(`${path}.UnauthorizedCacheControlHeaderStrategy`, "Invalid cache-control strategy"));
    });
  }
  validateTagProperty(properties.Tags, "Properties.Tags", "A stage", issues);
  return issues;
}

function canonicalMethodSetting(value: JsonObject): ApiGatewayMethodSettingModel {
  const output: JsonObject = { ResourcePath: value.ResourcePath === "*" ? "/*" : String(value.ResourcePath), HttpMethod: String(value.HttpMethod).toUpperCase() };
  for (const key of Object.keys(METHOD_SETTING_KEYS)) if (value[key] !== undefined) output[key] = value[key];
  return Object.freeze(output) as ApiGatewayMethodSettingModel;
}

function canonicalTags(value: unknown): readonly { readonly Key: string; readonly Value: string }[] {
  return Object.freeze((Array.isArray(value) ? value : []).map(item => ({ Key: String(item.Key), Value: String(item.Value) })).sort((a, b) => a.Key.localeCompare(b.Key)));
}

function canonicalStage(properties: unknown): ApiGatewayStageModel {
  const issues = stageIssues(properties); throwIssues(issues); const input = properties as JsonObject; const access = input.AccessLogSetting as JsonObject | undefined; const canary = input.CanarySetting as JsonObject | undefined;
  return Object.freeze({
    RestApiId: String(input.RestApiId), DeploymentId: String(input.DeploymentId), StageName: String(input.StageName), Description: String(input.Description ?? ""), Variables: stringMap(input.Variables),
    MethodSettings: Object.freeze([...(input.MethodSettings ?? [])].map(canonicalMethodSetting).sort((a, b) => `${a.ResourcePath}\0${a.HttpMethod}`.localeCompare(`${b.ResourcePath}\0${b.HttpMethod}`))),
    ...(access === undefined ? {} : { AccessLogSetting: Object.freeze({ ...(access.DestinationArn === undefined ? {} : { DestinationArn: String(access.DestinationArn) }), ...(access.Format === undefined ? {} : { Format: String(access.Format) }) }) }),
    CacheClusterEnabled: Boolean(input.CacheClusterEnabled ?? false), ...(input.CacheClusterSize === undefined ? {} : { CacheClusterSize: String(input.CacheClusterSize) }),
    ...(canary === undefined ? {} : { CanarySetting: Object.freeze({ ...(canary.DeploymentId === undefined ? {} : { DeploymentId: String(canary.DeploymentId) }), PercentTraffic: Number(canary.PercentTraffic ?? 0), StageVariableOverrides: stringMap(canary.StageVariableOverrides), UseStageCache: Boolean(canary.UseStageCache ?? false) }) }),
    ...(input.ClientCertificateId === undefined ? {} : { ClientCertificateId: String(input.ClientCertificateId) }), ...(input.DocumentationVersion === undefined ? {} : { DocumentationVersion: String(input.DocumentationVersion) }),
    TracingEnabled: Boolean(input.TracingEnabled ?? false), Tags: canonicalTags(input.Tags),
  });
}

function methodSettingKey(value: ApiGatewayMethodSettingModel): string {
  const resource = value.ResourcePath === "/*" || value.ResourcePath === "*" ? "*" : value.ResourcePath;
  return resource === "/" ? `/${value.HttpMethod}` : `${resource}/${value.HttpMethod}`;
}

function methodSettingPatchPath(key: string, suffix: string): string {
  const separator = key.lastIndexOf("/"); const resource = key.slice(0, separator); const method = key.slice(separator + 1);
  const normalized = resource || "/"; const encoded = normalized.replace(/~/g, "~0").replace(/\//g, "~1");
  return `/${encoded}/${method}/${suffix}`;
}

function methodSettingOperations(current: readonly ApiGatewayMethodSettingModel[], desired: readonly ApiGatewayMethodSettingModel[]): JsonObject[] {
  const operations: JsonObject[] = [];
  for (const setting of current) for (const [name, suffix] of Object.entries(METHOD_SETTING_KEYS)) if ((setting as any)[name] !== undefined) operations.push({ op: "remove", path: methodSettingPatchPath(methodSettingKey(setting), suffix) });
  for (const setting of desired) for (const [name, suffix] of Object.entries(METHOD_SETTING_KEYS)) if ((setting as any)[name] !== undefined) operations.push({ op: "add", path: methodSettingPatchPath(methodSettingKey(setting), suffix), value: (setting as any)[name] });
  return operations;
}

function stageFromRaw(apiId: string, raw: JsonObject): ApiGatewayStageModel {
  const methodSettings: JsonObject[] = [];
  for (const [key, value] of Object.entries(raw.methodSettings ?? {}) as [string, JsonObject][]) {
    const slash = key.lastIndexOf("/"); const resource = key.slice(0, slash); const method = key.slice(slash + 1); const setting: JsonObject = { ResourcePath: resource === "*" ? "/*" : resource || "/", HttpMethod: method };
    for (const [cfn, service] of Object.entries(METHOD_SETTING_RAW)) if (value[service] !== undefined) setting[cfn] = value[service];
    methodSettings.push(setting);
  }
  const tags = Object.entries(raw.tags ?? {}).map(([Key, Value]) => ({ Key, Value: String(Value) }));
  const access = raw.accessLogSettings; const canary = raw.canarySettings;
  return canonicalStage(withoutUndefined({
    RestApiId: apiId, DeploymentId: raw.deploymentId, StageName: raw.stageName, Description: raw.description, Variables: raw.variables, MethodSettings: methodSettings,
    AccessLogSetting: access ? { DestinationArn: access.destinationArn, Format: access.format } : undefined,
    CacheClusterEnabled: raw.cacheClusterEnabled, CacheClusterSize: raw.cacheClusterSize,
    CanarySetting: canary ? { DeploymentId: canary.deploymentId, PercentTraffic: canary.percentTraffic, StageVariableOverrides: canary.stageVariableOverrides, UseStageCache: canary.useStageCache } : undefined,
    ClientCertificateId: raw.clientCertificateId, DocumentationVersion: raw.documentationVersion, TracingEnabled: raw.tracingEnabled, Tags: tags,
  }));
}

async function stageReadModel(service: ApiGatewayService, apiId: string, stageName: string): Promise<ProviderReadModel<ApiGatewayStageModel>> {
  const raw = await call<JsonObject>(service, "GET", `/restapis/${segment(apiId)}/stages/${segment(stageName)}`);
  return { physicalId: physical("stage", [apiId, stageName]), properties: stageFromRaw(apiId, raw), attributes: {} };
}

function stageTopLevelOperations(desired: ApiGatewayStageModel): JsonObject[] {
  const access = desired.AccessLogSetting ? { destinationArn: desired.AccessLogSetting.DestinationArn, format: desired.AccessLogSetting.Format } : undefined;
  const canary = desired.CanarySetting ? { deploymentId: desired.CanarySetting.DeploymentId, percentTraffic: desired.CanarySetting.PercentTraffic, stageVariableOverrides: desired.CanarySetting.StageVariableOverrides, useStageCache: desired.CanarySetting.UseStageCache } : undefined;
  const values: [string, unknown][] = [["deploymentId", desired.DeploymentId], ["description", desired.Description], ["variables", desired.Variables], ["tracingEnabled", desired.TracingEnabled], ["accessLogSettings", access], ["cacheClusterEnabled", desired.CacheClusterEnabled], ["cacheClusterSize", desired.CacheClusterSize], ["canarySettings", canary], ["documentationVersion", desired.DocumentationVersion], ["clientCertificateId", desired.ClientCertificateId]];
  return values.map(([name, value]) => value === undefined ? { op: "remove", path: `/${name}` } : { op: "replace", path: `/${name}`, value });
}

async function updateStageState(service: ApiGatewayService, current: ApiGatewayStageModel, desired: ApiGatewayStageModel, context: ProviderContext): Promise<void> {
  const path = `/restapis/${segment(desired.RestApiId)}/stages/${segment(desired.StageName)}`;
  const operations = [...stageTopLevelOperations(desired), ...methodSettingOperations(current.MethodSettings, desired.MethodSettings)];
  if (operations.length) await call(service, "PATCH", path, { patchOperations: operations });
  const oldTags = new Set(current.Tags.map(tag => tag.Key)); const desiredMap = Object.fromEntries(desired.Tags.map(tag => [tag.Key, tag.Value]));
  const removed = [...oldTags].filter(key => !Object.hasOwn(desiredMap, key));
  const arn = `arn:${context.partition}:apigateway:${context.region}::/restapis/${desired.RestApiId}/stages/${desired.StageName}`;
  if (removed.length) { const query = new URLSearchParams(); for (const key of removed) query.append("tagKeys", key); await call(service, "DELETE", `/tags/${segment(arn)}?${query.toString()}`); }
  if (Object.keys(desiredMap).length) await call(service, "PUT", `/tags/${segment(arn)}`, { tags: desiredMap });
}

export function createApiGatewayStageProvider(service: ApiGatewayService): ProductionResourceProvider<ApiGatewayStageModel> {
  const names = Object.keys(API_GATEWAY_STAGE_SCHEMA.properties).sort();
  return {
    typeName: API_GATEWAY_STAGE_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_STAGE_SCHEMA,
    validate(properties) { return stageIssues(properties); }, canonicalize(properties) { return canonicalStage(properties); },
    plan(previous, desired) { return plan(previous, desired, names, ["RestApiId", "StageName"]); },
    async create(desired, context) {
      let created = false;
      try {
        try {
          const existing = await stageReadModel(service, desired.RestApiId, desired.StageName);
          if (same(existing.properties, desired)) return { status: "SUCCESS", physicalId: existing.physicalId, model: existing };
          return { status: "FAILED", errorCode: "ConflictException", message: `Stage ${desired.StageName} already exists on REST API ${desired.RestApiId}` };
        } catch (error) { if (!isMissing(error)) throw error; }
        const access = desired.AccessLogSetting ? { destinationArn: desired.AccessLogSetting.DestinationArn, format: desired.AccessLogSetting.Format } : undefined;
        const canary = desired.CanarySetting ? { deploymentId: desired.CanarySetting.DeploymentId, percentTraffic: desired.CanarySetting.PercentTraffic, stageVariableOverrides: desired.CanarySetting.StageVariableOverrides, useStageCache: desired.CanarySetting.UseStageCache } : undefined;
        await call(service, "POST", `/restapis/${segment(desired.RestApiId)}/stages`, {
          stageName: desired.StageName, deploymentId: desired.DeploymentId, description: desired.Description, variables: desired.Variables,
          tracingEnabled: desired.TracingEnabled, accessLogSettings: access, cacheClusterEnabled: desired.CacheClusterEnabled, cacheClusterSize: desired.CacheClusterSize,
          canarySettings: canary, documentationVersion: desired.DocumentationVersion, clientCertificateId: desired.ClientCertificateId,
          tags: Object.fromEntries(desired.Tags.map(tag => [tag.Key, tag.Value])),
        });
        created = true;
        if (desired.MethodSettings.length) await call(service, "PATCH", `/restapis/${segment(desired.RestApiId)}/stages/${segment(desired.StageName)}`, { patchOperations: methodSettingOperations([], desired.MethodSettings) });
        const model = await stageReadModel(service, desired.RestApiId, desired.StageName); return { status: "SUCCESS", physicalId: model.physicalId, model };
      } catch (error) {
        if (created) try { await call(service, "DELETE", `/restapis/${segment(desired.RestApiId)}/stages/${segment(desired.StageName)}`); } catch {}
        return providerFailure(error);
      }
    },
    async read(physicalId): Promise<ProviderReadResult<ApiGatewayStageModel>> {
      try { const [apiId, stageName] = parsePhysical(physicalId, "stage", 2); return { status: "SUCCESS", physicalId, model: await stageReadModel(service, apiId, stageName) }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayStageModel>> {
      try {
        const [apiId, stageName] = parsePhysical(physicalId, "stage", 2);
        if (apiId !== desired.RestApiId || stageName !== desired.StageName || previous.RestApiId !== desired.RestApiId || previous.StageName !== desired.StageName) throw new AwsError("RequiresReplacement", "RestApiId and StageName changes require replacement", 409);
        const current = (await stageReadModel(service, apiId, stageName)).properties;
        try { await updateStageState(service, current, desired, context); }
        catch (error) { try { const partial = (await stageReadModel(service, apiId, stageName)).properties; await updateStageState(service, partial, current, context); } catch {} throw error; }
        const model = await stageReadModel(service, apiId, stageName); return { status: "SUCCESS", physicalId, model };
      } catch (error) { return providerFailure(error); }
    },
    async delete(physicalId): Promise<ProviderDeleteResult> {
      try { const [apiId, stageName] = parsePhysical(physicalId, "stage", 2); await call(service, "DELETE", `/restapis/${segment(apiId)}/stages/${segment(stageName)}`); return { status: "SUCCESS", physicalId }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    ref(model) { return model.properties.StageName; },
    getAtt(model, attribute) { return unsupportedGetAtt(API_GATEWAY_STAGE_TYPE, API_GATEWAY_STAGE_SCHEMA, model, attribute); },
  };
}

function accountIssues(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, API_GATEWAY_ACCOUNT_SCHEMA);
  if (isObject(properties) && typeof properties.CloudWatchRoleArn === "string" && properties.CloudWatchRoleArn && !/^arn:[a-z0-9-]+:iam::\d{12}:role\/.+$/i.test(properties.CloudWatchRoleArn)) issues.push(issue("Properties.CloudWatchRoleArn", "CloudWatchRoleArn must be an IAM role ARN"));
  return issues;
}

function canonicalAccount(properties: unknown): ApiGatewayAccountModel {
  const issues = accountIssues(properties); throwIssues(issues); return Object.freeze({ CloudWatchRoleArn: String((properties as JsonObject).CloudWatchRoleArn ?? "") });
}

async function accountReadModel(service: ApiGatewayService, context: ProviderContext): Promise<ProviderReadModel<ApiGatewayAccountModel>> {
  const raw = await call<JsonObject>(service, "GET", "/account"); const physicalId = `${context.accountId}:${context.region}`;
  return { physicalId, properties: { CloudWatchRoleArn: String(raw.cloudwatchRoleArn ?? "") }, attributes: { Id: opaqueCloudFormationId("account", context) } };
}

async function patchAccount(service: ApiGatewayService, desired: ApiGatewayAccountModel): Promise<void> {
  await call(service, "PATCH", "/account", { patchOperations: [desired.CloudWatchRoleArn ? { op: "replace", path: "/cloudwatchRoleArn", value: desired.CloudWatchRoleArn } : { op: "remove", path: "/cloudwatchRoleArn" }] });
}

export function createApiGatewayAccountProvider(service: ApiGatewayService): ProductionResourceProvider<ApiGatewayAccountModel> {
  const names = Object.keys(API_GATEWAY_ACCOUNT_SCHEMA.properties).sort();
  return {
    typeName: API_GATEWAY_ACCOUNT_TYPE, providerVersion: 1, visibility: "production", schema: API_GATEWAY_ACCOUNT_SCHEMA,
    validate(properties) { return accountIssues(properties); }, canonicalize(properties) { return canonicalAccount(properties); },
    plan(previous, desired) { return plan(previous, desired, names, []); },
    async create(desired, context) { try { const current = await accountReadModel(service, context); if (current.properties.CloudWatchRoleArn && current.properties.CloudWatchRoleArn !== desired.CloudWatchRoleArn) return { status: "FAILED", errorCode: "ResourceConflict", message: "This region already has a different API Gateway CloudWatch role; AWS::ApiGateway::Account is a singleton" }; if (!current.properties.CloudWatchRoleArn && desired.CloudWatchRoleArn) await patchAccount(service, desired); const model = await accountReadModel(service, context); return { status: "SUCCESS", physicalId: model.physicalId, model }; } catch (error) { return providerFailure(error); } },
    async read(physicalId, context): Promise<ProviderReadResult<ApiGatewayAccountModel>> { try { const model = await accountReadModel(service, context); if (physicalId !== model.physicalId) return { status: "NOT_FOUND", physicalId }; return { status: "SUCCESS", physicalId, model }; } catch (error) { return providerFailure(error); } },
    async update(physicalId, _previous, desired, context): Promise<ProviderUpdateResult<ApiGatewayAccountModel>> { try { const expected = `${context.accountId}:${context.region}`; if (physicalId !== expected) throw new AwsError("InvalidPhysicalResourceId", "API Gateway Account physical identifier does not match this region", 400); await patchAccount(service, desired); const model = await accountReadModel(service, context); return { status: "SUCCESS", physicalId, model }; } catch (error) { return providerFailure(error); } },
    async delete(physicalId) { return { status: "SUCCESS", physicalId }; },
    ref(model) { return model.attributes.Id; }, getAtt(model, attribute) { return unsupportedGetAtt(API_GATEWAY_ACCOUNT_TYPE, API_GATEWAY_ACCOUNT_SCHEMA, model, attribute); },
  };
}

/** Build the direct-service-backed CFN-07 REST API provider set. */
export function createApiGatewayRestCloudFormationProviders(service: ApiGatewayService, options: ApiGatewayRestProviderOptions = {}): readonly ProductionResourceProvider<any>[] {
  return Object.freeze([
    createApiGatewayRestApiProvider(service, options),
    createApiGatewayResourceProvider(service),
    createApiGatewayMethodProvider(service),
    createApiGatewayDeploymentProvider(service),
    createApiGatewayStageProvider(service),
    createApiGatewayAccountProvider(service),
    ...createApiGatewayRestCommonCloudFormationProviders(service),
  ]);
}
